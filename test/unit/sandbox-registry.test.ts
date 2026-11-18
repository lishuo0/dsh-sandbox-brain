import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MockPlatform } from '../../packages/dsh-e2b/src/mock-adapter.ts'
import SandboxRegistry, {
  MemoryBindingStore,
  type Config,
  type SessionDirectory,
  type SessionOwner,
} from '../../packages/dsh-e2b/src/registry.ts'
import { runWithSandboxSession } from '../../packages/dsh-e2b/src/session-scope.ts'
import { testContext } from '../helpers/brain.ts'
import { FakeDockerCli } from '../helpers/fake-docker.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts'
import { dbOf } from '../helpers/skills.ts'

/**
 * 沙箱注册表：隔离单位、复用、销毁与跨副本绑定。
 *
 * 这里用 mock 适配器（本地目录），因为要验的是注册表的键和状态机，不是 E2B
 * 本身。手脑分离的底线是「每个工作区一块卷、一台沙箱」，所以 workspace 级
 * 复用同一个 externalId，session 级才按会话分开。
 */

const dirs: string[] = []
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface Setup {
  ctx: Context
  registry: SandboxRegistry
  platform: MockPlatform
  owners: Map<string, SessionOwner>
  agents: Map<string, string>
}

async function setup(
  options: Partial<Config> & { children?: Record<string, string>; initiator?: () => string | undefined } = {},
): Promise<Setup> {
  const objectDir = await temp('dsh-reg-objects-')
  const rootDir = await temp('dsh-reg-root-')
  const platform = new MockPlatform({ objectDir, rootDir })
  const owners = new Map<string, SessionOwner>()
  const directory: SessionDirectory = { owner: async (id) => owners.get(id) }
  const { children = {}, initiator, ...config } = options
  const agents = new Map(Object.entries(children))
  const ctx = testContext({
    agents: {
      get: (id: string) =>
        agents.has(id) ? { session: { header: { parentSession: agents.get(id) } } } : undefined,
      currentInitiator: () => {
        const id = initiator?.()
        return id === undefined ? undefined : { session: { id } }
      },
    },
  })
  const registry = new SandboxRegistry(ctx, {
    adapter: 'mock',
    scope: 'workspace',
    platform,
    directory,
    mock: { objectDir, rootDir },
    ...config,
  })
  return { ctx, registry, platform, owners, agents }
}

const owner = (workspaceId: string, userId = 'u1'): SessionOwner => ({ userId, workspaceId })

describe('sandbox-registry：配置校验', () => {
  it('scope "user" 没有工作区，直接拒绝', async () => {
    await expect(setup({ scope: 'user' })).rejects.toThrow(/scope "user" has no workspace/)
  })

  it('卷名模板必须含 {workspaceId}', async () => {
    await expect(setup({ volumeNameTemplate: 'desk-shared' })).rejects.toThrow(/\{workspaceId\}/)
  })

  it('挂载路径必须是绝对路径且不能是根', async () => {
    await expect(setup({ volumeMountPath: 'desk' })).rejects.toThrow(/absolute path/)
    await expect(setup({ volumeMountPath: '/' })).rejects.toThrow(/absolute path/)
  })

  it('OSS 挂载必须带 bucketPath，且工作区那条要插值 {workspaceId}', async () => {
    await expect(
      setup({ ossMounts: [{ bucketName: 'b', endpoint: 'e', bucketPath: '  ', mountDir: '/desk' }] }),
    ).rejects.toThrow(/bucketPath/)
    await expect(
      setup({ ossMounts: [{ bucketName: 'b', endpoint: 'e', bucketPath: 'desks/fixed', mountDir: '/desk' }] }),
    ).rejects.toThrow(/must interpolate \{workspaceId\}/)
    await expect(
      setup({ ossMounts: [{ bucketName: 'b', endpoint: 'e', bucketPath: 'desks/{workspaceId}', mountDir: 'desk' }] }),
    ).rejects.toThrow(/mountDir must be absolute/)
  })
})

describe('sandbox-registry：键与复用', () => {
  it('workspace 级：同一工作区的两个会话共用一台沙箱', async () => {
    const { registry, owners, platform } = await setup()
    owners.set('s1', owner('w1'))
    owners.set('s2', owner('w1'))

    const a = await registry.ensure('s1')
    const b = await registry.ensure('s2')

    expect(a.externalId).toBe(b.externalId)
    expect(a.workspaceRoot).toBe(b.workspaceRoot)
    expect(await platform.list()).toHaveLength(1)
  })

  it('工作区自己的卷名优先于全局兜底 volumeName', async () => {
    const { registry, owners, platform } = await setup({ volumeName: 'legacy-shared' })
    const volumes: unknown[] = []
    const create = platform.create.bind(platform)
    platform.create = async (spec, signal) => {
      volumes.push(spec.volumes)
      return await create(spec, signal)
    }
    owners.set('s1', { ...owner('w1'), volumeName: 'desk-w1' })
    await registry.ensure('s1')
    expect(volumes[0]).toEqual({ '/desk': 'desk-w1' })
  })

  it('不同工作区拿到不同沙箱', async () => {
    const { registry, owners } = await setup()
    owners.set('s1', owner('w1'))
    owners.set('s2', owner('w2'))

    const a = await registry.ensure('s1')
    const b = await registry.ensure('s2')
    expect(a.externalId).not.toBe(b.externalId)
  })

  it('session 级：同一工作区的不同会话各自一台', async () => {
    const { registry, owners } = await setup({ scope: 'session' })
    owners.set('s1', owner('w1'))
    owners.set('s2', owner('w1'))

    const a = await registry.ensure('s1')
    const b = await registry.ensure('s2')
    expect(a.externalId).not.toBe(b.externalId)
    expect(a.key.sessionId).toBe('s1')
    expect(b.key.sessionId).toBe('s2')
  })

  it('未知会话抛 unauthorized；子代理沿 parentSession 复用祖先沙箱', async () => {
    const { registry, owners } = await setup({ children: { child: 'parent' } })
    owners.set('parent', owner('w1'))

    await expect(registry.ensure('nobody')).rejects.toMatchObject({ failure: { kind: 'unauthorized' } })

    const parentSandbox = await registry.ensure('parent')
    const childSandbox = await registry.ensure('child')
    expect(childSandbox.externalId).toBe(parentSandbox.externalId)
  })

  it('父链成环时作为未知会话处理，不会死循环', async () => {
    const { registry } = await setup({ children: { a: 'b', b: 'a' } })
    await expect(registry.ensure('a')).rejects.toMatchObject({ failure: { kind: 'unauthorized' } })
  })

  it('沙箱在平台上消失后，下一次 ensure 重建并抬高 generation', async () => {
    const { registry, owners, platform } = await setup()
    owners.set('s1', owner('w1'))

    const first = await registry.ensure('s1')
    await platform.destroy(first.externalId)

    const second = await registry.ensure('s1')
    expect(second.externalId).not.toBe(first.externalId)
    expect(second.generation).toBe(first.generation + 1)
  })
})

describe('sandbox-registry：销毁与清理', () => {
  it('destroy 拆掉平台沙箱并清掉绑定；之后再 ensure 会重建', async () => {
    const { registry, owners, platform } = await setup()
    owners.set('s1', owner('w1'))

    const first = await registry.ensure('s1')
    await registry.destroy('s1')
    expect(await platform.get(first.externalId)).toBeUndefined()
    expect(await registry.list()).toHaveLength(0)

    const again = await registry.ensure('s1')
    expect(again.externalId).not.toBe(first.externalId)
  })

  it('destroy 未知会话是 no-op', async () => {
    const { registry } = await setup()
    await expect(registry.destroy('nobody')).resolves.toBeUndefined()
  })

  it('ensureCurrent 在没有当前会话时返回 undefined', async () => {
    const { registry } = await setup()
    await expect(registry.ensureCurrent()).resolves.toBeUndefined()
  })

  it('回合外的调用按异步作用域里的会话绑定沙箱', async () => {
    const { registry, owners } = await setup()
    owners.set('s1', owner('w1'))

    // 浏览器直连的请求没有发起 Agent，只能靠请求作用域里的会话。
    expect(await registry.ensureCurrent()).toBeUndefined()
    const binding = await runWithSandboxSession('s1', () => registry.ensureCurrent())
    expect(binding?.key.workspaceId).toBe('w1')
    // 作用域退出后不留默认会话。
    expect(await registry.ensureCurrent()).toBeUndefined()
  })

  it('发起 Agent 优先于异步作用域', async () => {
    const { registry, owners } = await setup({ initiator: () => 's1' })
    owners.set('s1', owner('w1'))
    owners.set('s2', owner('w2'))

    const binding = await runWithSandboxSession('s2', () => registry.ensureCurrent())
    expect(binding?.key.workspaceId).toBe('w1')
  })
})

describe('sandbox-registry：跨副本共享绑定（store-pg）', () => {
  let database: TestDatabase

  beforeEach(async () => {
    database = await createTestDatabase(['brain'])
  })

  afterEach(async () => {
    await database.drop()
  })

  it('第二个副本读到 ready 绑定就复用，不再创建新沙箱', async () => {
    const objectDir = await temp('dsh-reg-objects-')
    const rootDir = await temp('dsh-reg-root-')
    const platform = new MockPlatform({ objectDir, rootDir })
    const directory: SessionDirectory = { owner: async () => owner('w1') }

    const makeRegistry = () => {
      const ctx = testContext({ db: dbOf(database.pool), agents: { get: () => undefined } })
      return new SandboxRegistry(ctx, {
        adapter: 'mock',
        scope: 'workspace',
        storeKind: 'postgres',
        platform,
        directory,
        mock: { objectDir, rootDir },
      })
    }
    const first = makeRegistry()
    const second = makeRegistry()

    const a = await first.ensure('s1')
    const b = await second.ensure('s2')

    expect(b.externalId).toBe(a.externalId)
    // 两个副本看到同一行绑定。
    const rows = await database.pool.query<{ external_id: string; state: string }>(
      'SELECT external_id, state FROM dsh_sandboxes',
    )
    expect(rows).toEqual([{ external_id: a.externalId, state: 'ready' }])
  })

  it('MemoryBindingStore 的 claim 按 key 递增 generation', async () => {
    const store = new MemoryBindingStore()
    const key = { userId: 'u1', workspaceId: 'w1', sessionId: '' }
    expect(await store.claim(key, 'c1', 1_000)).toEqual({ status: 'claimed', generation: 1 })
    await store.put({
      key,
      scope: 'workspace',
      sandboxId: 'x',
      externalId: 'x',
      endpoint: 'local',
      workspaceRoot: '/desk',
      generation: 1,
      state: 'ready',
      expiresAt: 0,
      lastUsedAt: 0,
    })
    // 单进程内 claim 永不争用，按已有 generation 继续递增。
    expect(await store.claim(key, 'c2', 1_000)).toEqual({ status: 'claimed', generation: 2 })
  })
})

describe('sandbox-registry：docker 适配器', () => {
  it('空 OSS bucket/endpoint 回退到本地前缀，挂载落到 objectDir', async () => {
    const objectDir = await temp('dsh-reg-objects-')
    const rootDir = await temp('dsh-reg-root-')
    const cli = new FakeDockerCli()
    cli.images.add('node:22-bookworm-slim')
    const owners = new Map<string, SessionOwner>()
    const ctx = testContext({})
    const registry = new SandboxRegistry(ctx, {
      adapter: 'docker',
      scope: 'workspace',
      directory: { owner: async (id) => owners.get(id) },
      docker: { objectDir, rootDir, cli },
      ossMounts: [
        { bucketName: '', endpoint: '', bucketPath: 'desks/{workspaceId}', mountDir: '/desk' },
        { bucketName: '', endpoint: '', bucketPath: 'common/skills', mountDir: '/skillbox/common', readOnly: true },
      ],
    })
    owners.set('s1', owner('w1'))
    const handle = await registry.ensure('s1')
    expect(cli.mountSource(handle.externalId, '/desk')).toBe(join(objectDir, 'desks', 'w1'))
    expect(cli.mountSource(handle.externalId, '/skillbox/common')).toBe(join(objectDir, 'common/skills'))
  })
})
