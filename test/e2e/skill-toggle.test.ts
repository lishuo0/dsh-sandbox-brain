import { afterAll, describe, expect, it, beforeAll } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SessionDirectoryService from '../../packages/dsh-session-directory/src/index.ts'
import UserSkillsPlugin from '../../packages/dsh-user-skills/src/index.ts'
import { testContext } from '../helpers/brain.ts'
import { createTestDatabase, type TestDatabase, type TestPool } from '../helpers/pg.ts'
import { dbOf } from '../helpers/skills.ts'

/**
 * 平台只改 `dsh_skills.enabled`，不通知脑。真实脑里技能目录由
 * `@deepseek-ai/dsh-skill` 的 Registry 按 revision 缓存，因此「停用是否对
 * 已存在会话生效」取决于脑在 `agent/pre-step` 是否作废缓存。
 *
 * 这里用真实的 SkillRegistry + SessionDirectory + UserSkillsPlugin，走
 * 沙箱文件接口读 SKILL.md，验证：
 *
 * 1. 初始只列出启用的技能；
 * 2. 平台停用后，未反作废前仍读到缓存；
 * 3. 触发 pre-step 后目录失效，停用立即生效；
 * 4. 重新启用后下一个 pre-step 又出现；
 * 5. 新会话直接按库里的现状起步。
 */

const ALPHA_MD = '# alpha\n\n第一版。\n'
const BETA_MD = '# beta\n\n被停用后重新启用的技能。\n'
const GAMMA_MD = '# gamma\n\n一直启用。\n'

let database: TestDatabase
let pool: TestPool
let ctx: Context
let registry: SkillRegistry

interface TestAgent {
  session: { id: string }
  ctx: {
    inject(names: string[], callback: (scope: { skills: unknown }) => void): void
    get(name: string): unknown
  }
}

const files = new Map<string, string>([
  ['/skillbox/own/alpha/SKILL.md', ALPHA_MD],
  ['/skillbox/own/beta/SKILL.md', BETA_MD],
  ['/skillbox/own/gamma/SKILL.md', GAMMA_MD],
])

const fsApi = {
  async resolve(path: string): Promise<string> {
    if (!files.has(path)) throw new Error(`ENOENT ${path}`)
    return path
  },
  async readText(path: string): Promise<string> {
    const content = files.get(path)
    if (content === undefined) throw new Error(`ENOENT ${path}`)
    return content
  },
}

function agentFor(sessionId: string): { agent: TestAgent; key: object; dispose(): Promise<void> } {
  // `createScope` 的 key 是作用域的同一性标记；读写必须用同一个对象。
  const key = { sessionId }
  const scope = createScope(ctx, key)
  const agent: TestAgent = {
    session: { id: sessionId },
    ctx: {
      // 真实 Agent 的 ctx 是 scoped context；服务从这里取出来才落在该 Agent 的层。
      inject: (_names, callback) => callback({ skills: scope.ctx.skills }),
      get: (name) => (name === 'fs' ? fsApi : undefined),
    },
  }
  return { agent, key, dispose: scope.dispose }
}

async function preStep(agent: TestAgent): Promise<void> {
  const waterfall = ctx as unknown as {
    waterfall(event: string, payload: unknown, next: () => unknown): Promise<unknown>
  }
  await waterfall.waterfall('agent/pre-step', { agent }, () => undefined)
}

function created(agent: TestAgent): void {
  ;(ctx as unknown as { emit(event: string, payload: unknown): void }).emit('agent/created', { agent })
}

/** 等 Provider 注册完成（agent/created 的处理器是异步的）。 */
async function waitRegistered(key: object): Promise<void> {
  const deadline = Date.now() + 3_000
  while ((await list(key)).length === 0) {
    if (Date.now() > deadline) throw new Error('技能 Provider 未注册')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function list(key: object): Promise<string[]> {
  return (await registry.list({ scope: key as never })).map((skill) => skill.name)
}

beforeAll(async () => {
  database = await createTestDatabase(['platform', 'brain'])
  pool = database.pool
  await pool.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', 'u1', 'x')`)
  await pool.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, volume_name)
     VALUES ('w1', 'u1', '默认', '/var/agent-desk/u1/w1', '/desk', 'desk-w1')`,
  )
  await pool.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id)
     VALUES ('s1', 'u1', 'w1', '已有会话', 'platform'), ('s4', 'u1', 'w1', '新会话', 'platform')`,
  )
  await pool.query(
    `INSERT INTO dsh_skills (user_id, name, description, scope, enabled)
     VALUES ('u1', 'alpha', '第一版', 'private', true),
            ('u1', 'beta', '已停用', 'private', false),
            ('u1', 'gamma', '一直启用', 'private', true)`,
  )

  ctx = testContext({ db: dbOf(pool), agents: { get: () => undefined } })
  registry = new SkillRegistry(ctx)
  new SessionDirectoryService(ctx, { cacheTtlMs: 0 })
  new UserSkillsPlugin(ctx, {})
})

afterAll(async () => {
  await database.drop()
})

describe('技能停用对已存在会话的生效时机', () => {
  it('1. 初始只列出启用的技能，并能读出 SKILL.md', async () => {
    const { agent, key, dispose } = agentFor('s1')
    created(agent)
    await waitRegistered(key)

    expect(await list(key)).toEqual(['alpha', 'gamma'])
    const alpha = await registry.get('alpha', { scope: key as never })
    expect(alpha).toMatchObject({ name: 'alpha', path: '/skillbox/own/alpha/SKILL.md', content: ALPHA_MD })
    await dispose()
  })

  it('2. 平台停用后：目录仍被缓存，pre-step 触发失效后立即生效', async () => {
    const { agent, key, dispose } = agentFor('s1')
    created(agent)
    await waitRegistered(key)

    await pool.query(`UPDATE dsh_skills SET enabled = false WHERE name = 'alpha'`)
    // 没有 pre-step 时读到的是 Registry 缓存，这一步用来证明缓存存在，
    // 也证明后面的变化确实来自 pre-step 的 invalidation。
    expect(await list(key)).toEqual(['alpha', 'gamma'])

    await preStep(agent)
    expect(await list(key)).toEqual(['gamma'])
    await expect(registry.get('alpha', { scope: key as never })).resolves.toBeUndefined()

    // 重新启用后，下一个 pre-step 又出现。
    await pool.query(`UPDATE dsh_skills SET enabled = true WHERE name = 'alpha'`)
    await preStep(agent)
    expect(await list(key)).toEqual(['alpha', 'gamma'])

    await dispose()
  })

  it('3. 新会话按库里现状起步：新启用的能用，停用的看不到', async () => {
    await pool.query(`UPDATE dsh_skills SET enabled = false WHERE name = 'alpha'`)
    await pool.query(`UPDATE dsh_skills SET enabled = true WHERE name = 'beta'`)

    const { agent, key, dispose } = agentFor('s4')
    created(agent)
    await waitRegistered(key)

    expect(await list(key)).toEqual(['beta', 'gamma'])
    const beta = await registry.get('beta', { scope: key as never })
    expect(beta).toMatchObject({ content: BETA_MD })
    await dispose()
  })
})
