import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_HEADERS } from '../../packages/dsh-platform-api/src/auth.ts'
import { PREFIX, registerRoutes } from '../../packages/dsh-platform-api/src/routes.ts'
import {
  createSessionSecrets,
  parseBootstrap,
  parseSecret,
  runBootstrap,
} from '../../packages/dsh-platform-api/src/session-setup.ts'
import {
  call,
  FakeWebServer,
  MemoryGateway,
  startBrainServer,
  testContext,
  type BrainServer,
} from '../helpers/brain.ts'

const appKey = 'k'.repeat(24)
const auth = { 'x-app-id': 'platform', 'x-app-key': appKey, 'x-dsh-user-id': 'u1' }

interface Start {
  argv: readonly string[]
  cwd: string
  env?: Readonly<Record<string, string>>
  signal?: AbortSignal
}

/** 假的沙箱运行时：记录启动参数，按脚本设定收尾。 */
function fakeSandboxes(options: { readonly exitCode?: number; readonly hang?: boolean; readonly output?: string } = {}) {
  const starts: Start[] = []
  const killed: number[] = []
  const service = {
    async ensure() {
      return { workspaceRoot: '/desk', externalId: 'sbx-1' }
    },
    async client() {
      return {
        process: {
          async start(spec: Start, handlers?: { stdout?: (chunk: Uint8Array) => void }) {
            starts.push(spec)
            if (options.output !== undefined) handlers?.stdout?.(new TextEncoder().encode(options.output))
            return { pid: 42 }
          },
          async status() {
            return options.hang === true
              ? { pid: 42, argv: [], state: 'running' as const }
              : { pid: 42, argv: [], state: 'exited' as const, exitCode: options.exitCode ?? 0 }
          },
          async kill(pid: number) {
            killed.push(pid)
          },
        },
      }
    },
  }
  return { service, starts, killed }
}

describe('parseSecret', () => {
  it('省略时为 undefined', () => {
    expect(parseSecret(undefined)).toBeUndefined()
  })

  it('合法的 env/value 原样返回', () => {
    expect(parseSecret({ env: 'GH_TOKEN', value: 'ghs_x' })).toEqual({ env: 'GH_TOKEN', value: 'ghs_x' })
  })

  it('非法环境变量名被拒', () => {
    expect(() => parseSecret({ env: '1BAD', value: 'x' })).toThrowError(
      expect.objectContaining({ status: 400, code: 'invalid-secret-env' }),
    )
  })

  it('DSH_ 前缀被拒（shell 工具会重建这个命名空间）', () => {
    expect(() => parseSecret({ env: 'DSH_TOKEN', value: 'x' })).toThrowError(
      expect.objectContaining({ code: 'invalid-secret-env' }),
    )
  })

  it('空值和超长值被拒', () => {
    expect(() => parseSecret({ env: 'TOKEN', value: '   ' })).toThrowError(
      expect.objectContaining({ code: 'invalid-secret' }),
    )
    expect(() => parseSecret({ env: 'TOKEN', value: 'x'.repeat(8 * 1024 + 1) })).toThrowError(
      expect.objectContaining({ code: 'invalid-secret' }),
    )
  })

  it('非对象被拒', () => {
    expect(() => parseSecret('token')).toThrowError(expect.objectContaining({ code: 'invalid-secret' }))
  })
})

describe('parseBootstrap', () => {
  it('省略或空白时为 undefined', () => {
    expect(parseBootstrap(undefined)).toBeUndefined()
    expect(parseBootstrap('   \n')).toBeUndefined()
  })

  it('超长脚本被拒', () => {
    expect(() => parseBootstrap('x'.repeat(64 * 1024 + 1))).toThrowError(
      expect.objectContaining({ code: 'invalid-bootstrap' }),
    )
  })

  it('非字符串被拒', () => {
    expect(() => parseBootstrap(42)).toThrowError(expect.objectContaining({ code: 'invalid-bootstrap' }))
  })
})

describe('createSessionSecrets', () => {
  it('set 覆盖前值，undefined 清除', () => {
    const store = createSessionSecrets()
    store.set('s1', { env: 'A', value: '1' })
    store.set('s1', { env: 'B', value: '2' })
    expect(store.get('s1')).toEqual({ env: 'B', value: '2' })
    store.set('s1', undefined)
    expect(store.get('s1')).toBeUndefined()
  })
})

describe('runBootstrap', () => {
  it('以 bash -lc 在 cwd 执行，并带上本次 secret', async () => {
    const sandboxes = fakeSandboxes()
    const ctx = testContext({ sandboxes: sandboxes.service })
    await runBootstrap(ctx, 's1', 'git fetch --all --prune', '/desk', { env: 'GH_TOKEN', value: 'ghs_x' })
    expect(sandboxes.starts).toHaveLength(1)
    expect(sandboxes.starts[0]).toMatchObject({
      argv: ['bash', '-lc', 'git fetch --all --prune'],
      cwd: '/desk',
      env: { GH_TOKEN: 'ghs_x' },
    })
  })

  it('非零退出回 502 bootstrap-failed', async () => {
    const ctx = testContext({ sandboxes: fakeSandboxes({ exitCode: 2 }).service })
    await expect(runBootstrap(ctx, 's1', 'false', '/desk', undefined)).rejects.toMatchObject({
      status: 502,
      code: 'bootstrap-failed',
    })
  })

  it('超时回 502 并杀掉仍在跑的脚本', async () => {
    const sandboxes = fakeSandboxes({ hang: true })
    const ctx = testContext({ sandboxes: sandboxes.service })
    await expect(runBootstrap(ctx, 's1', 'sleep 999', '/desk', undefined, 20)).rejects.toMatchObject({
      status: 502,
      code: 'bootstrap-failed',
    })
    expect(sandboxes.killed).toEqual([42])
  })

  it('没有沙箱运行时时回 502，而不是假装成功', async () => {
    const ctx = testContext({})
    await expect(runBootstrap(ctx, 's1', 'true', '/desk', undefined)).rejects.toMatchObject({
      status: 502,
      code: 'bootstrap-failed',
    })
  })
})

describe('POST /brain/v1/sessions 的 secret 与 bootstrap', () => {
  let brain: BrainServer
  let gateway: MemoryGateway
  let secrets: ReturnType<typeof createSessionSecrets>
  let sandboxes: ReturnType<typeof fakeSandboxes>

  beforeAll(async () => {
    gateway = new MemoryGateway()
    secrets = createSessionSecrets()
    sandboxes = fakeSandboxes()
    const ctx = testContext({
      webServer: new FakeWebServer(),
      sandboxes: sandboxes.service,
      sessionSecrets: secrets,
    })
    registerRoutes(ctx, {
      gateway,
      credentials: [{ appId: 'platform', appKey }],
      headers: DEFAULT_HEADERS,
      requireUser: true,
      sessionSecrets: secrets,
    })
    brain = await startBrainServer(ctx)
  })

  afterAll(async () => {
    await brain.close()
  })

  it('secret 只写进内存表，不进会话记录', async () => {
    const response = await call(brain.baseUrl, PREFIX, {
      method: 'POST',
      headers: auth,
      body: { cwd: '/desk', secret: { env: 'GH_TOKEN', value: 'ghs_x' } },
    })
    expect(response.status).toBe(201)
    const sessionId = (response.json() as { sessionId: string }).sessionId
    expect(secrets.get(sessionId)).toEqual({ env: 'GH_TOKEN', value: 'ghs_x' })
    expect(JSON.stringify(gateway.sessions.get(sessionId))).not.toContain('ghs_x')
  })

  it('再次 create 且省略 secret 时清除前值（fail closed）', async () => {
    const first = await call(brain.baseUrl, PREFIX, {
      method: 'POST',
      headers: auth,
      body: { cwd: '/desk', secret: { env: 'GH_TOKEN', value: 'ghs_x' } },
    })
    const sessionId = (first.json() as { sessionId: string }).sessionId
    const again = await call(brain.baseUrl, PREFIX, {
      method: 'POST',
      headers: auth,
      body: { cwd: '/desk', sessionId },
    })
    expect(again.status).toBe(201)
    expect(secrets.get(sessionId)).toBeUndefined()
  })

  it('bootstrap 在响应前于会话沙箱执行', async () => {
    const response = await call(brain.baseUrl, PREFIX, {
      method: 'POST',
      headers: auth,
      body: {
        cwd: '/desk',
        secret: { env: 'GH_TOKEN', value: 'ghs_x' },
        bootstrap: 'git fetch --all --prune',
      },
    })
    expect(response.status).toBe(201)
    expect(sandboxes.starts.at(-1)).toMatchObject({
      argv: ['bash', '-lc', 'git fetch --all --prune'],
      env: { GH_TOKEN: 'ghs_x' },
    })
  })

  it('bootstrap 失败回 502，但会话已经建好', async () => {
    const failing = fakeSandboxes({ exitCode: 3 })
    const ctx = testContext({ webServer: new FakeWebServer(), sandboxes: failing.service })
    const ownGateway = new MemoryGateway()
    registerRoutes(ctx, { gateway: ownGateway, credentials: [{ appId: 'platform', appKey }], headers: DEFAULT_HEADERS })
    const own = await startBrainServer(ctx)
    try {
      const response = await call(own.baseUrl, PREFIX, {
        method: 'POST',
        headers: auth,
        body: { cwd: '/desk', sessionId: 'sess-retry', bootstrap: 'false' },
      })
      expect(response.status).toBe(502)
      expect((response.json() as { error: { code: string } }).error.code).toBe('bootstrap-failed')
      expect(ownGateway.sessions.has('sess-retry')).toBe(true)
    } finally {
      await own.close()
    }
  })

  it('参数不合法时不建会话', async () => {
    const before = gateway.sessions.size
    const badEnv = await call(brain.baseUrl, PREFIX, {
      method: 'POST',
      headers: auth,
      body: { cwd: '/desk', secret: { env: 'DSH_TOKEN', value: 'x' } },
    })
    expect(badEnv.status).toBe(400)
    expect((badEnv.json() as { error: { code: string } }).error.code).toBe('invalid-secret-env')
    const badScript = await call(brain.baseUrl, PREFIX, {
      method: 'POST',
      headers: auth,
      body: { cwd: '/desk', bootstrap: 12 },
    })
    expect(badScript.status).toBe(400)
    expect((badScript.json() as { error: { code: string } }).error.code).toBe('invalid-bootstrap')
    expect(gateway.sessions.size).toBe(before)
  })
})
