import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_HEADERS } from '../../packages/dsh-platform-api/src/auth.ts'
import { createOwnershipGuard } from '../../packages/dsh-platform-api/src/ownership.ts'
import { registerRoutes } from '../../packages/dsh-platform-api/src/routes.ts'
import { MockPlatform } from '../../packages/dsh-e2b/src/mock-adapter.ts'
import {
  call,
  FakeWebServer,
  MemoryGateway,
  readSse,
  startBrainServer,
  testContext,
  type BrainServer,
} from '../helpers/brain.ts'
import { createTestDatabase, type TestDatabase, type TestPool } from '../helpers/pg.ts'
import { createSkillProvider, dbOf, mountSkillSandbox } from '../helpers/skills.ts'

/**
 * 脑侧完整链路（不启动 DSH 内核与 LLM）：
 *
 *   HTTP 建会话/发消息 → 真实归属校验读 PG
 *   → 真实 SessionDirectory + 技能 Provider 看到技能
 *   → MockPlatform 沙箱按 SKILL.md 执行命令、产出文件
 */

const SKILL_MD = '# 汇总器\n\n读取本周改动，写出 summary.md。\n'
const APP = { appId: 'platform', appKey: 'k'.repeat(24) }

let database: TestDatabase
let pool: TestPool
let brain: BrainServer
let gateway: MemoryGateway
let objectsDir: string
let sandboxRoot: string
let sandbox: MockPlatform
let sandboxId: string

const headers = { 'x-app-id': APP.appId, 'x-app-key': APP.appKey, 'x-dsh-user-id': 'u1' }

beforeAll(async () => {
  database = await createTestDatabase(['platform', 'brain'])
  pool = database.pool
  await pool.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', 'u1', 'x')`)
  await pool.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, volume_name)
     VALUES ('w1', 'u1', '默认', '/var/agent-desk/u1/w1', '/desk', 'desk-w1')`,
  )
  await pool.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id) VALUES ('s1', 'u1', 'w1', '会话', 'platform')`,
  )
  await pool.query(
    `INSERT INTO dsh_skills (user_id, name, description, scope, enabled)
     VALUES ('u1', 'summarizer', '汇总本周改动', 'private', true),
            ('u1', 'extra', '另一个技能', 'private', true)`,
  )
  // w2 只选了 summarizer；w3 明确一个都不接。
  await pool.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, volume_name, selection_configured)
     VALUES ('w2', 'u1', '选过的', '/var/agent-desk/u1/w2', '/desk', 'desk-w2', true),
            ('w3', 'u1', '空选择', '/var/agent-desk/u1/w3', '/desk', 'desk-w3', true)`,
  )
  await pool.query(
    `INSERT INTO dsh_workspace_skills (workspace_id, skill_name, skill_scope)
     VALUES ('w2', 'summarizer', 'private')`,
  )
  await pool.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id)
     VALUES ('s2', 'u1', 'w2', '选过的', 'platform'), ('s3', 'u1', 'w3', '空选择', 'platform')`,
  )

  const ctx = testContext({ webServer: new FakeWebServer() })
  ctx.provide('db', dbOf(pool))
  gateway = new MemoryGateway()
  registerRoutes(ctx, {
    gateway,
    ownership: createOwnershipGuard(ctx),
    credentials: [{ appId: APP.appId, appKey: APP.appKey }],
    headers: DEFAULT_HEADERS,
    requireUser: true,
  })
  brain = await startBrainServer(ctx)

  objectsDir = await mkdtemp(join(tmpdir(), 'dsh-brain-objects-'))
  sandboxRoot = await mkdtemp(join(tmpdir(), 'dsh-brain-sandboxes-'))
  sandbox = new MockPlatform({ objectDir: objectsDir, rootDir: sandboxRoot })
  const handle = await mountSkillSandbox(sandbox, { workspaceId: 'w1', userId: 'u1' })
  sandboxId = handle.externalId

  // 平台把 SKILL.md 同步到对象存储后，沙箱在 /skillbox/own 能看到。
  const client = await sandbox.client(sandboxId)
  await client.files.write('/skillbox/own/summarizer/SKILL.md', Buffer.from(SKILL_MD))
})

afterAll(async () => {
  await brain.close()
  await sandbox.destroy(sandboxId)
  await rm(objectsDir, { recursive: true, force: true })
  await rm(sandboxRoot, { recursive: true, force: true })
  await database.drop()
})

describe('脑侧技能全流程', () => {
  it('1. 建会话', async () => {
    const created = await call(brain.baseUrl, '/brain/v1/sessions', {
      method: 'POST',
      headers,
      body: { cwd: '/desk', sessionId: 's1' },
    })
    expect(created.status).toBe(201)
    expect(created.json()).toMatchObject({ sessionId: 's1' })
    expect(gateway.sessions.get('s1')).toMatchObject({ cwd: '/desk' })
  })

  it('2. 技能 Provider 列出并读出定义', async () => {
    const client = await sandbox.client(sandboxId)
    const provider = await createSkillProvider({ db: dbOf(pool), sessionId: 's1', files: client.files })

    const candidates = await provider.list({})
    expect(candidates.map((candidate) => candidate.name)).toEqual(['extra', 'summarizer'])
    const summarizer = candidates.find((candidate) => candidate.name === 'summarizer')
    expect(summarizer).toEqual(
      expect.objectContaining({
        name: 'summarizer',
        description: '汇总本周改动',
        rank: 300,
        locator: { name: 'summarizer', scope: 'private' },
      }),
    )
    await expect(provider.get(summarizer!, {})).resolves.toMatchObject({
      name: 'summarizer',
      path: '/skillbox/own/summarizer/SKILL.md',
      content: SKILL_MD,
    })
  })

  it('3. 投递消息并收到提交事件', async () => {
    const sent = await call(brain.baseUrl, '/brain/v1/sessions/s1/messages', {
      method: 'POST',
      // 请求号按契约走 x-request-id 头；请求体里的 requestId 只是回显字段。
      headers: { ...headers, 'x-request-id': 'req-1' },
      body: { text: '生成本周 summary', requestId: 'req-1' },
    })
    expect(sent.status).toBe(202)
    expect(gateway.prompts).toEqual([{ sessionId: 's1', text: '生成本周 summary', requestId: 'req-1' }])

    const stream = await readSse(brain.baseUrl, '/brain/v1/sessions/s1/events?after=-1', {
      headers,
      until: (events) => events.some((event) => event.event === 'ready'),
    })
    try {
      const committed = stream.events.filter((event) => event.event === 'event').map((event) => event.data as { type: string })
      expect(committed.map((event) => event.type)).toEqual(['user', 'assistant'])
      expect(stream.events[0]?.event).toBe('snapshot')
    } finally {
      stream.close()
    }
  })

  it('4. 沙箱里按技能执行并产出文件', async () => {
    const client = await sandbox.client(sandboxId)
    // Mock 适配器不虚拟化绝对路径：技能文件先落到 cwd，命令用相对路径读它。
    const skill = Buffer.from(await client.files.read('/skillbox/own/summarizer/SKILL.md'))
    await client.files.write('/desk/SKILL.md', skill)
    const { pid } = await client.process.start({
      argv: ['sh', '-c', 'cat SKILL.md > summary.md && printf "\\n--done--\\n" >> summary.md'],
      cwd: '/desk',
    })
    expect(await client.process.wait(pid)).toMatchObject({ state: 'exited', exitCode: 0 })

    const artifact = Buffer.from(await client.files.read('/desk/summary.md')).toString()
    expect(artifact).toContain('# 汇总器')
    expect(artifact.trimEnd()).toContain('--done--')
  })

  it('5. 取消是投递给网关的', async () => {
    const cancelled = await call(brain.baseUrl, '/brain/v1/sessions/s1/cancel', { method: 'POST', headers, body: {} })
    expect(cancelled.status).toBe(202)
    expect(gateway.cancellations).toContain('s1')
  })

  it('6. 工作区选了哪个技能就给哪个会话挂哪个', async () => {
    const client = await sandbox.client(sandboxId)
    const selected = await createSkillProvider({ db: dbOf(pool), sessionId: 's2', files: client.files })
    expect((await selected.list({})).map((candidate) => candidate.name)).toEqual(['summarizer'])

    // 同一用户、没配置过选择的会话仍是全部启用。
    const all = await createSkillProvider({ db: dbOf(pool), sessionId: 's1', files: client.files })
    expect((await all.list({})).map((candidate) => candidate.name).sort()).toEqual(['extra', 'summarizer'])
  })

  it('7. 工作区明确一个都不接时不挂任何技能', async () => {
    const client = await sandbox.client(sandboxId)
    const none = await createSkillProvider({ db: dbOf(pool), sessionId: 's3', files: client.files })
    await expect(none.list({})).resolves.toEqual([])
  })

  it('8. 别人的用户头拿不到会话', async () => {
    const foreign = await call(brain.baseUrl, '/brain/v1/sessions/s1/messages', {
      method: 'POST',
      headers: { ...headers, 'x-dsh-user-id': 'u2' },
      body: { text: '偷看', requestId: 'req-x' },
    })
    expect(foreign.status).toBe(404)
    expect(foreign.json()).toMatchObject({ error: { code: 'session-not-found' } })
  })
})
