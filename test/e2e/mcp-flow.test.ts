import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionDirectoryService from '../../packages/dsh-session-directory/src/index.ts'
import UserMcpPlugin from '../../packages/dsh-user-mcp/src/index.ts'
import { testContext } from '../helpers/brain.ts'
import { sealCredential, startMockMcp, type MockMcpServer } from '../helpers/mcp.ts'
import { createTestDatabase, type TestDatabase, type TestPool } from '../helpers/pg.ts'
import { dbOf } from '../helpers/skills.ts'

/**
 * 脑侧 MCP 全流程：真实 SessionDirectory + 真实 UserMcpPlugin
 * → 真实 Streamable HTTP MCP 客户端 → 测试里的 MCP server。
 *
 * 覆盖：
 *
 * - 关联：工作区选择（未配置=全部启用 / 选中几个 / 空数组=一个都不接）
 * - 挂载：`agent/pre-step` 时按名字同步工具；同名私有覆盖公开；stdio 行被过滤
 * - 执行：模型面工具定义真的发起 `tools/call`
 * - 密钥：`cred:mcp/<server>/<header>` 引用按平台写入的 AES-GCM 密文解开
 * - 停用：平台只改库，下一 pre-step 摘掉工具；重新启用再挂回
 *
 * 沙箱约束：MCP 是外部 HTTP 服务，不在脑宿主起进程；stdio 行在这里必须被
 * 过滤掉，避免脑去 spawn。
 */

interface ToolDefinitionLike {
  name: string
  execute(args: unknown, execution: unknown): Promise<unknown>
}

interface FakeTools {
  readonly defs: Map<string, ToolDefinitionLike>
  register(definition: ToolDefinitionLike): () => void
}

function createTools(): FakeTools {
  const defs = new Map<string, ToolDefinitionLike>()
  return {
    defs,
    register(definition) {
      defs.set(definition.name, definition)
      return () => {
        defs.delete(definition.name)
      }
    },
  }
}

interface TestAgent {
  session: { id: string }
  ctx: Context
}

function agentFor(ctx: Context, sessionId: string): { agent: TestAgent; dispose(): Promise<void> } {
  const scope = createScope(ctx, { sessionId })
  return {
    agent: { session: { id: sessionId }, ctx: scope.ctx },
    dispose: scope.dispose,
  }
}

/** 手动触发一次 agent/pre-step 瀑布；真实内核由 agent-loop 派发同一个事件。 */
async function preStep(ctx: Context, agent: TestAgent): Promise<void> {
  const waterfall = ctx as unknown as {
    waterfall(event: string, payload: unknown, next: () => unknown): Promise<unknown>
  }
  await waterfall.waterfall('agent/pre-step', { agent }, () => undefined)
}

function toolNames(tools: FakeTools): string[] {
  return [...tools.defs.keys()].sort()
}

const CREDENTIALS_KEY = randomBytes(32)
const APP_KEY = CREDENTIALS_KEY.toString('base64')

let database: TestDatabase
let pool: TestPool
let ctx: Context
let tools: FakeTools
let primary: MockMcpServer
let publicDocs: MockMcpServer
let shadowPrivate: MockMcpServer
let shadowPublic: MockMcpServer
const agents: Array<{ agent: TestAgent; dispose(): Promise<void> }> = []

beforeAll(async () => {
  process.env.DSH_CREDENTIALS_KEY = APP_KEY
  database = await createTestDatabase(['platform', 'brain'])
  pool = database.pool

  ;[primary, publicDocs, shadowPrivate, shadowPublic] = await Promise.all([
    startMockMcp(),
    startMockMcp(),
    startMockMcp({ tools: [{ name: 'which', call: () => 'private' }] }),
    startMockMcp({ tools: [{ name: 'which', call: () => 'public' }] }),
  ])

  await pool.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', '成员', 'x'), ('u2', '管理员', 'x')`)
  // w1 没配置过选择；w2 只选了公开 docs；w3 明确一个都不接。
  await pool.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, volume_name)
     VALUES ('w1', 'u1', '默认', '/var/agent-desk/u1/w1', '/desk', 'desk-w1')`,
  )
  await pool.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, volume_name, selection_configured)
     VALUES ('w2', 'u1', '选过的', '/var/agent-desk/u1/w2', '/desk', 'desk-w2', true),
            ('w3', 'u1', '空选择', '/var/agent-desk/u1/w3', '/desk', 'desk-w3', true)`,
  )
  await pool.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id)
     VALUES ('s1', 'u1', 'w1', '全部启用', 'platform'),
            ('s2', 'u1', 'w2', '选过的', 'platform'),
            ('s3', 'u1', 'w3', '空选择', 'platform')`,
  )
  await pool.query(
    `INSERT INTO dsh_workspace_mcp_servers (workspace_id, server_name, server_scope)
     VALUES ('w2', 'docs', 'public')`,
  )

  const config = (headers: Record<string, string>) => JSON.stringify({ headers })
  await pool.query(
    `INSERT INTO dsh_mcp_servers (user_id, server_name, transport, target, config, scope, enabled)
     VALUES ('u1', 'search', 'streamable-http', $1, $2, 'private', true),
            ('u2', 'docs', 'streamable-http', $3, '{}', 'public', true),
            ('u1', 'shadow', 'streamable-http', $4, '{}', 'private', true),
            ('u2', 'shadow', 'streamable-http', $5, '{}', 'public', true),
            ('u1', 'local-tool', 'stdio', '/bin/false', '{}', 'private', true),
            ('u1', 'broken', 'streamable-http', 'http://127.0.0.1:1/mcp', $6, 'private', true)`,
    [
      primary.url,
      config({ 'x-api-key': 'cred:mcp/search/x-api-key', 'x-team': 'blue' }),
      publicDocs.url,
      shadowPrivate.url,
      shadowPublic.url,
      config({ 'x-key': 'cred:mcp/search/missing' }),
    ],
  )
  await pool.query(
    `INSERT INTO dsh_user_credentials (user_id, kind, name, ciphertext)
     VALUES ('u1', 'mcp-header', 'search/x-api-key', $1)`,
    [sealCredential(CREDENTIALS_KEY, 's3cret')],
  )

  ctx = testContext({ db: dbOf(pool), agents: { get: () => undefined } })
  new SessionDirectoryService(ctx, { cacheTtlMs: 0 })
  tools = createTools()
  ctx.provide('tools', tools)
  new UserMcpPlugin(ctx, { mountTimeoutMs: 5_000 })
})

afterEach(async () => {
  for (const handle of agents.splice(0)) await handle.dispose()
})

afterAll(async () => {
  delete process.env.DSH_CREDENTIALS_KEY
  await Promise.all([primary.close(), publicDocs.close(), shadowPrivate.close(), shadowPublic.close()])
  await database.drop()
})

function track(sessionId: string): TestAgent {
  const handle = agentFor(ctx, sessionId)
  agents.push(handle)
  return handle.agent
}

describe('脑侧 MCP 全流程', () => {
  it('1. 未配置选择时挂载全部启用：私有 + 公开 + 同名私有覆盖，stdio 被过滤', async () => {
    const agent = track('s1')
    await preStep(ctx, agent)

    expect(toolNames(tools)).toEqual(['mcp__docs__echo', 'mcp__search__echo', 'mcp__shadow__which'])
    // 每个挂上的服务器都被同步过一次工具列表。
    expect(primary.listCalls.length).toBe(1)
    expect(publicDocs.listCalls.length).toBe(1)
    expect(shadowPrivate.listCalls.length).toBe(1)
    // 同名公开行没有挂载；stdio 行也不会在脑宿主起进程。
    expect(shadowPublic.listCalls.length).toBe(0)
  })

  it('2. 调用工具：密钥引用解密后随请求头送到 MCP server', async () => {
    const agent = track('s1')
    await preStep(ctx, agent)

    const definition = tools.defs.get('mcp__search__echo')
    expect(definition).toBeDefined()
    const result = (await definition!.execute({ text: '你好' }, { signal: new AbortController().signal })) as {
      content: Array<{ type: string; text: string }>
    }
    expect(result.content).toEqual([{ type: 'text', text: 'echo: 你好' }])

    expect(primary.calls).toHaveLength(1)
    expect(primary.calls[0]).toMatchObject({ name: 'echo', args: { text: '你好' } })
    // `cred:mcp/search/x-api-key` 已按平台写入的布局解开。
    expect(primary.calls[0]?.headers['x-api-key']).toBe('s3cret')
    expect(primary.calls[0]?.headers['x-team']).toBe('blue')
  })

  it('3. 同名时只把请求送到私有服务器', async () => {
    const agent = track('s1')
    await preStep(ctx, agent)

    const definition = tools.defs.get('mcp__shadow__which')
    const result = (await definition!.execute({}, { signal: new AbortController().signal })) as {
      content: Array<{ type: string; text: string }>
    }
    expect(result.content).toEqual([{ type: 'text', text: 'private' }])
    expect(shadowPrivate.calls).toHaveLength(1)
    expect(shadowPublic.calls).toHaveLength(0)
  })

  it('4. 工作区选择：只挂选中的；明确空选择时一个都不挂', async () => {
    const selected = track('s2')
    await preStep(ctx, selected)
    expect(toolNames(tools)).toEqual(['mcp__docs__echo'])

    const none = track('s3')
    await preStep(ctx, none)
    expect(toolNames(tools)).toEqual(['mcp__docs__echo'])
  })

  it('5. 平台停用后下一 pre-step 摘掉工具，重新启用再挂回', async () => {
    const agent = track('s1')
    await preStep(ctx, agent)
    expect(toolNames(tools)).toContain('mcp__docs__echo')

    await pool.query(`UPDATE dsh_mcp_servers SET enabled = false WHERE server_name = 'docs'`)
    await preStep(ctx, agent)
    expect(toolNames(tools)).toEqual(['mcp__search__echo', 'mcp__shadow__which'])

    await pool.query(`UPDATE dsh_mcp_servers SET enabled = true WHERE server_name = 'docs'`)
    await preStep(ctx, agent)
    expect(toolNames(tools)).toEqual(['mcp__docs__echo', 'mcp__search__echo', 'mcp__shadow__which'])
  })

  it('6. 重复 pre-step 不会重复挂载', async () => {
    const agent = track('s1')
    await preStep(ctx, agent)
    const listed = primary.listCalls.length
    await preStep(ctx, agent)
    expect(primary.listCalls.length).toBe(listed)
    expect(toolNames(tools)).toEqual(['mcp__docs__echo', 'mcp__search__echo', 'mcp__shadow__which'])
  })
})

// 凭证封印帮助函数留在本文件，避免测试依赖平台源码目录。
// sealCredential 在 helpers/mcp.ts 里实现，布局与平台 kernel/seal.ts 一致。
