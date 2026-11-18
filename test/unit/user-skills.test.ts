import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SkillCandidate, SkillDefinition } from '@deepseek-ai/dsh-skill'
import UserSkillsPlugin from '../../packages/dsh-user-skills/src/index.ts'
import { testContext } from '../helpers/brain.ts'
import { createTestDatabase, type TestDatabase, type TestPool } from '../helpers/pg.ts'

let database: TestDatabase
let pool: TestPool
let storage: string

function dbOf(target: TestPool) {
  return {
    dialect: target.dialect,
    query: <T>(text: string, params?: readonly unknown[]): Promise<T[]> => target.query<T>(text, params),
    transaction: target.transaction,
  }
}

interface Provider {
  name: string
  list(options: { signal?: AbortSignal }): Promise<readonly SkillCandidate[]>
  get(candidate: SkillCandidate, options: { signal?: AbortSignal }): Promise<SkillDefinition | undefined>
}

interface FakeAgent {
  session: { id: string }
  ctx: {
    inject(names: string[], callback: (scope: { skills: { registerProvider(factory: (control: unknown) => Provider): void } }) => void): void
    get(name: string): unknown
  }
}

/** 真实插件 + 内存 fs：只关心 provider 契约。 */
function buildAgent(sessionId: string, files: Map<string, string>) {
  const providers: Provider[] = []
  const agent: FakeAgent = {
    session: { id: sessionId },
    ctx: {
      inject: (_names, callback) => {
        callback({
          skills: {
            registerProvider: (factory) => {
              providers.push(factory({ signal: new AbortController().signal }))
            },
          },
        })
      },
      get: (name) =>
        name === 'fs'
          ? {
              resolve: async (path: string) => {
                if (!files.has(path)) throw new Error(`ENOENT ${path}`)
                return path
              },
              readText: async (path: string) => files.get(String(path)) ?? '',
            }
          : undefined,
    },
  }
  return { agent, providers }
}

async function waitForProviders(providers: Provider[]): Promise<void> {
  const deadline = Date.now() + 5_000
  while (providers.length === 0) {
    if (Date.now() > deadline) throw new Error('provider 未注册')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeAll(async () => {
  database = await createTestDatabase(['platform', 'brain'])
  pool = database.pool
  storage = await mkdtemp(join(tmpdir(), 'dsh-skills-unit-'))
  await pool.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', 'u1', 'x'), ('u2', 'u2', 'x')`)
  await pool.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, volume_name)
     VALUES ('w1', 'u1', '默认', '/var/agent-desk/u1/w1', '/desk/w1', 'desk-w1')`,
  )
  await pool.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id)
     VALUES ('s1', 'u1', 'w1', '会话', 'platform')`,
  )
  await pool.query(
    `INSERT INTO dsh_skills (user_id, name, description, scope, enabled)
     VALUES
       ('u1', 'report', '私有报告', 'private', true),
       ('u2', 'report', '公共报告', 'public', true),
       ('u1', 'shared', '公共工具', 'public', true),
       ('u1', 'off', '已停用', 'private', false),
       ('u2', 'other', '别人的', 'private', true)`,
  )
})

afterAll(async () => {
  await database.drop()
  await rm(storage, { recursive: true, force: true })
})

/**
 * 插件先问 `ownerOf`（带工作区选择），再退回 `userOf`。
 *
 * s1 没有工作区选择 → 全部启用；s2 选了私有 report；s3 明确一个都不接；
 * s4 只选公开的 shared。
 */
const directory = {
  ownerOf: async (sessionId: string) => {
    switch (sessionId) {
      case 's1':
        return { userId: 'u1', workspaceId: 'w1' }
      case 's2':
        return { userId: 'u1', workspaceId: 'w1', skills: [{ name: 'report', scope: 'private' as const }] }
      case 's3':
        return { userId: 'u1', workspaceId: 'w1', skills: [] }
      case 's4':
        return { userId: 'u1', workspaceId: 'w1', skills: [{ name: 'shared', scope: 'public' as const }] }
      default:
        return undefined
    }
  },
  userOf: async (sessionId: string) => (sessionId === 's1' ? { userId: 'u1' } : undefined),
}

async function providerFor(sessionId: string, files: Map<string, string> = new Map()): Promise<Provider> {
  const ctx = testContext({ db: dbOf(pool), sessionDirectory: directory })
  new UserSkillsPlugin(ctx, {})
  const { agent, providers } = buildAgent(sessionId, files)
  ctx.emit('agent/created', { agent })
  await waitForProviders(providers)
  return providers[0] as Provider
}

describe('user skills provider', () => {
  it('列出启用的技能，私有覆盖同名公共', async () => {
    const provider = await providerFor('s1')
    const candidates = await provider.list({})
    const names = candidates.map((candidate) => candidate.name).sort()
    expect(names).toEqual(['report', 'shared'])
    const report = candidates.find((candidate) => candidate.name === 'report')
    expect(report).toMatchObject({ description: '私有报告', rank: 300, locator: { scope: 'private' } })
  })

  it('get 从私有目录读 SKILL.md', async () => {
    const files = new Map([['/skillbox/own/report/SKILL.md', '# 私有报告\n执行：echo hi']])
    const provider = await providerFor('s1', files)
    const [candidate] = await provider.list({})
    const definition = await provider.get(candidate as SkillCandidate, {})
    expect(definition).toMatchObject({
      name: 'report',
      provider: 'user-skills',
      source: 'custom',
      path: '/skillbox/own/report/SKILL.md',
      resourceBase: { kind: 'directory', path: '/skillbox/own/report' },
      content: '# 私有报告\n执行：echo hi',
      invocation: { modelInvocable: true, userInvocable: true },
    })
  })

  it('公共技能从 common 目录读取', async () => {
    const files = new Map([['/skillbox/common/shared/SKILL.md', '公共内容']])
    const provider = await providerFor('s1', files)
    const candidates = await provider.list({})
    const shared = candidates.find((candidate) => candidate.name === 'shared') as SkillCandidate
    await expect(provider.get(shared, {})).resolves.toMatchObject({ content: '公共内容' })
  })

  it('文件缺失时返回 undefined', async () => {
    const provider = await providerFor('s1')
    const candidates = await provider.list({})
    await expect(provider.get(candidates[0] as SkillCandidate, {})).resolves.toBeUndefined()
  })

  it('工作区选了哪几个就只列哪几个', async () => {
    const provider = await providerFor('s2')
    const candidates = await provider.list({})
    expect(candidates.map((candidate) => candidate.name)).toEqual(['report'])
    // 选的是私有 report，u2 的同名公共技能不能顶上来。
    expect(candidates[0]).toMatchObject({ locator: { scope: 'private' }, description: '私有报告' })
  })

  it('只选公开的 shared 时列表里也就只有它', async () => {
    const provider = await providerFor('s4')
    await expect(provider.list({})).resolves.toMatchObject([{ name: 'shared', locator: { scope: 'public' } }])
  })

  it('工作区明确一个都不选：空列表', async () => {
    const provider = await providerFor('s3')
    await expect(provider.list({})).resolves.toEqual([])
  })

  it('没有属主的会话不注册 provider', async () => {
    const ctx = testContext({ db: dbOf(pool), sessionDirectory: directory })
    new UserSkillsPlugin(ctx, {})
    const { agent, providers } = buildAgent('missing-session', new Map())
    ctx.emit('agent/created', { agent })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(providers).toHaveLength(0)
  })

  it('已中止的查询不会返回结果', async () => {
    const provider = await providerFor('s1')
    const controller = new AbortController()
    controller.abort()
    await expect(provider.list({ signal: controller.signal })).rejects.toThrow()
  })
})
