import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../../packages/dsh-platform-api/src/index.ts'
import { PREFIX } from '../../packages/dsh-platform-api/src/routes.ts'
import {
  call,
  FakeWebServer,
  readSse,
  startBrainServer,
  testContext,
  type BrainServer,
} from '../helpers/brain.ts'

/**
 * 平台 API 的装配层：真实 `apply()` + 真实 HTTP。
 *
 * 集成测试（test/integration/routes.test.ts）用内存网关验证路由契约；这里
 * 验的是**装配**：`apply()` 提供了哪些服务、创建请求带来的沙箱/OSS/图片配置
 * 落在哪里、每会话模型 key/endpoint 如何登记、哨兵域名如何改写到平台端点、
 * 租约丢失时如何停掉本副本的 Agent。
 *
 * 沙箱约束：这一层只做 HTTP ⇄ 进程内服务编排，不碰文件系统也不起子进程；
 * 假 Agent 只记录调用，验证的是编排顺序而不是推理本身。
 */

interface FakeSession {
  id: string
  readonly seq: number
  events: Array<{ seq: number; type: string; data: unknown }>
  eventAt(seq: number): unknown
}

interface FakeAgent {
  session: FakeSession
  model: { selections: unknown[]; select(selection: unknown): void }
  followups: unknown[]
  cancels: Array<{ reason: unknown; options: unknown }>
  followup(message: unknown): void
  cancel(reason: unknown, options?: unknown): void
}

function makeAgent(id: string): FakeAgent {
  const events: Array<{ seq: number; type: string; data: unknown }> = []
  const agent: FakeAgent = {
    session: {
      id,
      events,
      get seq() {
        return events.length
      },
      eventAt: (seq: number) => events[seq],
    },
    model: { selections: [], select(selection) { this.selections.push(selection) } },
    followups: [],
    cancels: [],
    followup(message) {
      this.followups.push(message)
    },
    cancel(reason, options) {
      this.cancels.push({ reason, options })
    },
  }
  return agent
}

interface FakeAgents {
  readonly byId: Map<string, FakeAgent>
  get(id: string): FakeAgent | undefined
  currentInitiator(): { session: { id: string } } | undefined
  withInitiator<T>(agent: FakeAgent, run: () => Promise<T>): Promise<T>
  setCurrent(id: string | undefined): void
  create(input: { sessionId: string }): Promise<{ agent: FakeAgent; dispose(): Promise<void> }>
  resume(input: { resumeSessionId: string }): Promise<{ agent: FakeAgent; dispose(): Promise<void> }>
}

function fakeAgents(): FakeAgents {
  const byId = new Map<string, FakeAgent>()
  let current: string | undefined
  const handle = (sessionId: string) => {
    const agent = makeAgent(sessionId)
    byId.set(sessionId, agent)
    return { agent, dispose: async () => byId.delete(sessionId) }
  }
  return {
    byId,
    get: id => byId.get(id),
    currentInitiator: () => (current === undefined ? undefined : { session: { id: current } }),
    withInitiator: async (agent, run) => {
      const previous = current
      current = agent.session.id
      try {
        return await run()
      } finally {
        current = previous
      }
    },
    setCurrent: id => {
      current = id
    },
    create: async ({ sessionId }) => handle(sessionId),
    resume: async ({ resumeSessionId }) => handle(resumeSessionId),
  }
}

interface FakeKeyStore {
  get(sessionId: string): string | undefined
  set(sessionId: string, value: string): void
  delete(sessionId: string): void
}

interface FakeBaseUrlStore extends FakeKeyStore {
  latest(): string | undefined
}

/** 触发 Cordis 事件；事件名跨越多个包，测试里用字符串直发避免类型耦合。 */
function emit(ctx: Context, name: string, ...payload: unknown[]): void {
  ;(ctx as unknown as { emit(event: string, ...value: unknown[]): void }).emit(name, ...payload)
}

const appKey = 'p'.repeat(24)
const auth = { 'x-app-id': 'platform', 'x-app-key': appKey, 'x-dsh-user-id': 'u1' }
const modelHeaders = {
  'x-dsh-model-key': 'sk-session-key',
  'x-dsh-model-base-url': 'https://api.example.com/v1/',
}

const E2B_HEADERS = {
  'x-dsh-e2b-api-key': 'e2b-key',
  'x-dsh-e2b-api-url': 'https://e2b.internal',
  'x-dsh-e2b-domain': 'e2b.internal',
  'x-dsh-e2b-template': 'dsh-desk',
  'x-dsh-e2b-role-arn': 'arn:aws:iam::1:role/e2b',
}

const OSS_HEADERS = {
  'x-dsh-oss-bucket': 'attachments',
  'x-dsh-oss-endpoint': 'https://oss.internal',
  'x-dsh-oss-region': 'cn-hangzhou',
  'x-dsh-oss-access-key-id': 'oss-id',
  'x-dsh-oss-access-key-secret': 'oss-secret',
}

let brain: BrainServer
let ctx: Context
let agents: FakeAgents
let connection: { browserAuth: { launchToken?: string } }
let refreshes: number
let forceClosed: string[]
let stoppedSessions: string[]
/** 假注册表收到的终止请求；断言路由把会话与任务一起交给它。 */
let killedJobs: Array<{ id: string; sessionId: string; reason: string }>
/** 让假注册表按稳定的 `JobError.code` 失败，验证路由层映射。 */
let jobFailure: { code: string; message: string } | undefined
/** 定时任务转发：假 `typertGateway` 收到的 Remote 调用。 */
let remoteCalls: Array<{ namespace: string; method: string; args: Record<string, unknown>; principal: unknown }>
/** 让假 `typertGateway` 抛业务错误，验证 `result.ok:false` 回包。 */
let remoteFailure: { code: string; message: string } | undefined
const originalFetch = globalThis.fetch

/** 假注册表的失败注入：抛一个带 `code` 的错误，模拟 `dsh-jobs` 的 JobError。 */
function failJobIfConfigured(): void {
  if (jobFailure === undefined) return
  throw Object.assign(new Error(jobFailure.message), { code: jobFailure.code })
}

beforeAll(async () => {
  connection = { browserAuth: {} }
  refreshes = 0
  forceClosed = []
  stoppedSessions = []
  killedJobs = []
  jobFailure = undefined
  remoteCalls = []
  remoteFailure = undefined
  agents = fakeAgents()
  ctx = testContext({
    webServer: new FakeWebServer(),
    agents,
    connection,
    workspaceRegistry: {
      async refresh() {
        refreshes += 1
      },
    },
    llm: {
      async listModels() {
        return [{ id: 'deepseek-chat' }]
      },
      async resolveCallConfig(config: { provider: string; model: string; reasoningEffort?: string }) {
        return config
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'user', model: 'deepseek-chat' }),
    },
    commands: {
      list: (agent: FakeAgent) => [{ line: '/help', description: `commands for ${agent.session.id}` }],
      execute: async (agent: FakeAgent, line: string) => ({ sessionId: agent.session.id, line }),
    },
    goals: {
      get: (agent: FakeAgent) => ({ id: `goal-${agent.session.id}`, revision: 1, objective: 'ship it' }),
      edit: (_agent: FakeAgent, ref: unknown, request: unknown) => ({ ...(ref as object), ...(request as object) }),
      pause: (_agent: FakeAgent, ref: unknown) => ({ ...(ref as object), state: 'paused' }),
      resume: (_agent: FakeAgent, ref: unknown) => ({ ...(ref as object), state: 'active' }),
      complete: (_agent: FakeAgent, ref: unknown) => ({ ...(ref as object), state: 'complete' }),
      clear: (_agent: FakeAgent, ref: unknown) => ({ ...(ref as object), state: 'cleared' }),
    },
    agentPresets: {
      list: () => [{ id: 'platform', name: '平台' }],
      read: (id: string) => ({ id }),
      select: (_agent: FakeAgent, id: string) => id,
    },
    permissionPresets: { catalog: () => ({ items: ['default'] }) },
    messageFeedback: {
      list: ({ sessionId }: { sessionId: string }) => [{ sessionId, messageId: 'm1', rating: 'up' }],
      put: (request: Record<string, unknown>) => ({ ...request }),
      delete: (request: Record<string, unknown>) => ({ deleted: true, ...request }),
    },
    sessionFeedback: {
      record: (request: Record<string, unknown>) => ({ recorded: true, ...request }),
    },
    sessionController: {
      projections: async ({ sessionId }: { sessionId: string }) => ({ sessionId, baseline: 1 }),
      fork: async ({ sessionId, atSeq }: { sessionId: string; atSeq?: number }) => ({
        sessionId: `session-fork-${sessionId}-${atSeq ?? 'tail'}`,
      }),
    },
    sessionPersistence: {
      async stat() {
        return undefined
      },
      async flush() {},
      async forceCloseTurn(id: string) {
        forceClosed.push(id)
        return { closed: true, events: 2 }
      },
    },
    // 后台任务注册表（`dsh-jobs-local` 在真实部署里的位置）。路由和看门狗
    // 都通过 `ctx.get('jobs')` 读它；这里只记录调用并回稳定的失败码。
    // 定时任务只有 Typert Remote 形态；平台经 `/brain/v1/schedule/*` 转发到这里。
    typertGateway: {
      async invoke(request: {
        namespace: string
        method: string
        args: Record<string, unknown>
        peer: { principal: unknown }
      }) {
        remoteCalls.push({
          namespace: request.namespace,
          method: request.method,
          args: request.args,
          principal: request.peer.principal,
        })
        if (remoteFailure !== undefined) {
          throw Object.assign(new Error(remoteFailure.message), { code: remoteFailure.code })
        }
        return [{ id: 'sch_1' }]
      },
    },
    jobs: {
      events: { subscribe: () => () => {} },
      list: (sessionId: string) => [{
        id: 'bash-1',
        kind: 'bash',
        label: 'sleep 600',
        owner: sessionId,
        status: 'running',
        startedAt: 1,
        output: { total: 0, earliest: 0 },
      }],
      get: (id: string, sessionId: string) => {
        failJobIfConfigured()
        return { id, kind: 'bash', label: 'sleep 600', owner: sessionId, status: 'completed', startedAt: 1, output: { total: 0, earliest: 0 } }
      },
      kill: (id: string, sessionId: string, reason: string) => {
        failJobIfConfigured()
        killedJobs.push({ id, sessionId, reason })
        return 'requested'
      },
    },
  })
  apply(ctx, { apps: [{ appId: 'platform', appKey, name: 'Agent 平台' }] })
  // 取消会并行发出 `workspace/session-stop`；真实部署里由 jobs 的归档准入负责
  // 杀掉会话的后台任务，这里只验证取消确实发出了这一路。
  ctx.on('workspace/session-stop', (payload: { sessionId: string }) => {
    stoppedSessions.push(payload.sessionId)
  })
  brain = await startBrainServer(ctx)
})

afterAll(async () => {
  globalThis.fetch = originalFetch
  await brain.close()
})

afterEach(() => {
  jobFailure = undefined
})

async function createSession(
  headers: Record<string, string> = { ...auth, ...modelHeaders },
  body: Record<string, unknown> = { cwd: '/desk' },
): Promise<string> {
  const response = await call(brain.baseUrl, PREFIX, { method: 'POST', headers, body })
  expect(response.status).toBe(201)
  return (response.json() as { sessionId: string }).sessionId
}

describe('platform-api 装配：提供的服务', () => {
  it('apply() 挂上每会话模型 key / endpoint、沙箱与图片配置四个存储', () => {
    expect(ctx.get('sessionModelKeys')).toBeDefined()
    const baseUrls = ctx.get('sessionModelBaseUrls') as FakeBaseUrlStore
    expect(typeof baseUrls.latest).toBe('function')
    expect(ctx.get('sandboxConfig')).toBeDefined()
    expect(ctx.get('imageConfig')).toBeDefined()
  })

  it('内联应用凭据不合法时装配直接失败', () => {
    expect(() => apply(testContext({ webServer: new FakeWebServer() }), {
      apps: [{ appId: 'platform', appKey: 'short' }],
    })).toThrow(/appKey/)
    expect(() => apply(testContext({ webServer: new FakeWebServer() }), {
      apps: [{ appId: 'a', appKey: appKey }, { appId: 'a', appKey: appKey }],
    })).toThrow(/duplicate appId/)
  })
})

describe('platform-api 装配：平台下发的运行时配置', () => {
  it('创建会话缺模型 key / endpoint 时 400', async () => {
    const noKey = await call(brain.baseUrl, PREFIX, { method: 'POST', headers: auth, body: { cwd: '/desk' } })
    expect(noKey.status).toBe(400)
    expect((noKey.json() as { error: { code: string } }).error.code).toBe('model-key-required')

    const noUrl = await call(brain.baseUrl, PREFIX, {
      method: 'POST',
      headers: { ...auth, 'x-dsh-model-key': 'sk-only' },
      body: { cwd: '/desk' },
    })
    expect(noUrl.status).toBe(400)
    expect((noUrl.json() as { error: { code: string } }).error.code).toBe('model-base-url-required')
  })

  it('创建请求把模型 key / endpoint 按会话登记', async () => {
    const sessionId = await createSession()
    expect((ctx.get('sessionModelKeys') as FakeKeyStore).get(sessionId)).toBe('sk-session-key')
    // 尾部斜杠被归一化掉。
    const baseUrls = ctx.get('sessionModelBaseUrls') as FakeBaseUrlStore
    expect(baseUrls.get(sessionId)).toBe('https://api.example.com/v1')
    expect(baseUrls.latest()).toBe('https://api.example.com/v1')
  })

  it('E2B / OSS 请求头落到沙箱配置存储', async () => {
    await createSession({ ...auth, ...modelHeaders, ...E2B_HEADERS, ...OSS_HEADERS })
    expect((ctx.get('sandboxConfig') as { get(): unknown }).get()).toEqual({
      apiKey: 'e2b-key',
      apiUrl: 'https://e2b.internal',
      domain: 'e2b.internal',
      template: 'dsh-desk',
      roleArn: 'arn:aws:iam::1:role/e2b',
      ossBucket: 'attachments',
      ossEndpoint: 'https://oss.internal',
      ossRegion: 'cn-hangzhou',
      ossAccessKeyId: 'oss-id',
      ossAccessKeySecret: 'oss-secret',
    })
  })

  it('只有 OSS、没有 E2B 时也写沙箱配置（docker/mock 部署的附件也走 OSS）', async () => {
    await createSession({ ...auth, ...modelHeaders, ...OSS_HEADERS })
    expect((ctx.get('sandboxConfig') as { get(): unknown }).get()).toEqual({
      ossBucket: 'attachments',
      ossEndpoint: 'https://oss.internal',
      ossRegion: 'cn-hangzhou',
      ossAccessKeyId: 'oss-id',
      ossAccessKeySecret: 'oss-secret',
    })
  })

  it('OSS 四元组不全时不写沙箱配置', async () => {
    const before = (ctx.get('sandboxConfig') as { get(): unknown }).get()
    await createSession({
      ...auth,
      ...modelHeaders,
      ...OSS_HEADERS,
      'x-dsh-oss-access-key-secret': '',
    })
    expect((ctx.get('sandboxConfig') as { get(): unknown }).get()).toBe(before)
  })

  it('E2B 三元组不全时不写沙箱配置', async () => {
    const before = (ctx.get('sandboxConfig') as { get(): unknown }).get()
    await createSession({ ...auth, ...modelHeaders, 'x-dsh-e2b-api-key': 'only-key' })
    expect((ctx.get('sandboxConfig') as { get(): unknown }).get()).toBe(before)
  })

  it('图片生成请求头落到图片配置存储', async () => {
    await createSession({
      ...auth,
      ...modelHeaders,
      'x-dsh-image-base-url': 'https://img.example.com/v1/',
      'x-dsh-image-models': 'flux, sdxl ,',
      'x-dsh-image-default-model': 'flux',
      'x-dsh-image-output-dir': '/desk/images',
    })
    expect((ctx.get('imageConfig') as { get(): unknown }).get()).toEqual({
      baseUrl: 'https://img.example.com/v1',
      models: ['flux', 'sdxl'],
      defaultModel: 'flux',
      outputDir: '/desk/images',
    })
  })
})

describe('platform-api 装配：会话动作', () => {
  it('消息落到真实网关的 followup，并按 request id 去重', async () => {
    const sessionId = await createSession()
    const headers = { ...auth, 'x-request-id': 'req-dup' }
    const first = await call(brain.baseUrl, `${PREFIX}/${sessionId}/messages`, {
      method: 'POST',
      headers,
      body: { text: '你好' },
    })
    expect(first.status).toBe(202)
    const second = await call(brain.baseUrl, `${PREFIX}/${sessionId}/messages`, {
      method: 'POST',
      headers,
      body: { text: '重复投递' },
    })
    expect(second.status).toBe(202)

    const agent = agents.byId.get(sessionId) as FakeAgent
    expect(agent.followups).toHaveLength(1)
    expect(agent.followups[0]).toMatchObject({
      role: 'user',
      source: { kind: 'user', rpcId: 'req-dup' },
    })
  })

  it('创建时带 x-dsh-model-id 会通过真实网关选中模型', async () => {
    const sessionId = await createSession({
      ...auth,
      ...modelHeaders,
      'x-dsh-model-id': 'deepseek-reasoner',
    })
    const agent = agents.byId.get(sessionId) as FakeAgent
    expect(agent.model.selections.at(-1)).toEqual({ provider: 'user', model: 'deepseek-reasoner' })
  })

  it('未活动会话的动作统一 404，避免跨租户唤醒', async () => {
    const response = await call(brain.baseUrl, `${PREFIX}/not-live/messages`, {
      method: 'POST',
      headers: auth,
      body: { text: 'hi' },
    })
    expect(response.status).toBe(404)
    expect((response.json() as { error: { code: string } }).error.code).toBe('session-not-found')
  })

  it('取消转成 Agent.cancel，并保留收件箱；同时停掉会话的后台活动', async () => {
    const sessionId = await createSession()
    const response = await call(brain.baseUrl, `${PREFIX}/${sessionId}/cancel`, { method: 'POST', headers: auth })
    expect(response.status).toBe(202)
    const agent = agents.byId.get(sessionId) as FakeAgent
    expect(agent.cancels).toContainEqual({ reason: { kind: 'user' }, options: { keepInbox: true } })
    await vi.waitFor(() => expect(stoppedSessions).toContain(sessionId))
  })

  it('没有活 Agent 的会话取消也收敛：走强制收尾而不是 404', async () => {
    const response = await call(brain.baseUrl, `${PREFIX}/session-lost-on-restart/cancel`, {
      method: 'POST',
      headers: auth,
    })
    expect(response.status).toBe(202)
    expect(forceClosed).toContain('session-lost-on-restart')
  })

  it('force-cancel 走 session-pg 的强制收尾并回报写入事件数', async () => {
    const sessionId = await createSession()
    const response = await call(brain.baseUrl, `${PREFIX}/${sessionId}/force-cancel`, {
      method: 'POST',
      headers: auth,
    })
    expect(response.status).toBe(202)
    expect(response.json()).toMatchObject({ forceClosed: true, events: 2 })
    expect(forceClosed).toContain(sessionId)
  })
})

describe('platform-api 装配：高级会话动作', () => {
  it('模型 / 预设 / 权限目录从装配的服务读出', async () => {
    const models = await call(brain.baseUrl, '/brain/v1/models', { headers: auth })
    expect(models.status).toBe(200)
    expect(models.json()).toMatchObject({ default: { provider: 'user', model: 'deepseek-chat' } })

    const presets = await call(brain.baseUrl, '/brain/v1/presets', { headers: auth })
    expect(presets.json()).toEqual([{ id: 'platform', name: '平台' }])

    const permissions = await call(brain.baseUrl, '/brain/v1/permission-presets', { headers: auth })
    expect(permissions.json()).toEqual({ items: ['default'] })
  })

  it('Session 预设切换', async () => {
    const sessionId = await createSession()
    const response = await call(brain.baseUrl, `${PREFIX}/${sessionId}/preset`, {
      method: 'POST',
      headers: auth,
      body: { agentPreset: 'platform' },
    })
    expect(response.status).toBe(200)
    expect(response.json()).toEqual({ agentPreset: 'platform' })

    const missing = await call(brain.baseUrl, `${PREFIX}/${sessionId}/preset`, {
      method: 'POST',
      headers: auth,
      body: {},
    })
    expect(missing.status).toBe(400)
    expect((missing.json() as { error: { code: string } }).error.code).toBe('invalid-preset')
  })

  it('goal 的读取、整体编辑与动作', async () => {
    const sessionId = await createSession()

    const read = await call(brain.baseUrl, `${PREFIX}/${sessionId}/goal`, { headers: auth })
    expect(read.json()).toEqual({ goal: { id: `goal-${sessionId}`, revision: 1, objective: 'ship it' } })

    const edit = await call(brain.baseUrl, `${PREFIX}/${sessionId}/goal`, {
      method: 'PUT',
      headers: auth,
      body: { objective: 'ship faster' },
    })
    expect(edit.json()).toMatchObject({ id: `goal-${sessionId}`, objective: 'ship faster' })

    const paused = await call(brain.baseUrl, `${PREFIX}/${sessionId}/goal/pause`, {
      method: 'POST',
      headers: auth,
      body: {},
    })
    expect(paused.json()).toMatchObject({ state: 'paused' })

    const unknown = await call(brain.baseUrl, `${PREFIX}/${sessionId}/goal/explode`, {
      method: 'POST',
      headers: auth,
      body: {},
    })
    expect(unknown.status).toBe(404)
  })

  it('commands 列表与执行', async () => {
    const sessionId = await createSession()
    const list = await call(brain.baseUrl, `${PREFIX}/${sessionId}/commands`, { headers: auth })
    expect(list.json()).toEqual({ items: [{ line: '/help', description: `commands for ${sessionId}` }] })

    const executed = await call(brain.baseUrl, `${PREFIX}/${sessionId}/commands`, {
      method: 'POST',
      headers: auth,
      body: { line: '/help' },
    })
    expect(executed.json()).toEqual({ result: { sessionId, line: '/help' } })

    const empty = await call(brain.baseUrl, `${PREFIX}/${sessionId}/commands`, {
      method: 'POST',
      headers: auth,
      body: { line: '  ' },
    })
    expect(empty.status).toBe(400)
    expect((empty.json() as { error: { code: string } }).error.code).toBe('invalid-line')
  })

  it('消息反馈的增删查与会话级备注', async () => {
    const sessionId = await createSession()

    const listed = await call(brain.baseUrl, `${PREFIX}/${sessionId}/message-feedback`, { headers: auth })
    expect(listed.json()).toEqual([{ sessionId, messageId: 'm1', rating: 'up' }])

    const put = await call(brain.baseUrl, `${PREFIX}/${sessionId}/message-feedback`, {
      method: 'POST',
      headers: auth,
      body: { messageId: 'm2', rating: 'down' },
    })
    expect(put.json()).toEqual({ messageId: 'm2', rating: 'down', sessionId })

    const deleted = await call(brain.baseUrl, `${PREFIX}/${sessionId}/message-feedback`, {
      method: 'DELETE',
      headers: auth,
      body: { messageId: 'm2' },
    })
    expect(deleted.json()).toMatchObject({ deleted: true, messageId: 'm2' })

    const recorded = await call(brain.baseUrl, `${PREFIX}/${sessionId}/feedback`, {
      method: 'POST',
      headers: auth,
      body: { note: '慢' },
    })
    expect(recorded.json()).toMatchObject({ recorded: true, note: '慢', sessionId })
  })

  it('projections 返回基线', async () => {
    const sessionId = await createSession()
    const response = await call(brain.baseUrl, `${PREFIX}/${sessionId}/projections`, { headers: auth })
    expect(response.status).toBe(200)
    expect(response.json()).toEqual({ projections: { sessionId, baseline: 1 } })
  })

  it('未装配可选服务时对应端点 501，而不是假装成功', async () => {
    const savedFetch = globalThis.fetch
    const bareCtx = testContext({ webServer: new FakeWebServer(), agents: fakeAgents() })
    apply(bareCtx, { apps: [{ appId: 'platform', appKey }] })
    const bare = await startBrainServer(bareCtx)
    try {
      const models = await call(bare.baseUrl, '/brain/v1/models', { headers: auth })
      expect(models.status).toBe(501)
      const presets = await call(bare.baseUrl, '/brain/v1/presets', { headers: auth })
      expect(presets.status).toBe(501)
      const permissions = await call(bare.baseUrl, '/brain/v1/permission-presets', { headers: auth })
      expect(permissions.status).toBe(501)
      const projections = await call(bare.baseUrl, `${PREFIX}/whatever/projections`, { headers: auth })
      expect(projections.status).toBe(501)
    } finally {
      await bare.close()
      globalThis.fetch = savedFetch
    }
  })
})

describe('platform-api 装配：事件流', () => {
  it('历史事件从真实会话日志回放', async () => {
    const sessionId = await createSession()
    const agent = agents.byId.get(sessionId) as FakeAgent
    agent.session.events.push({ seq: 0, type: 'note', data: { hello: 'replay' } })

    const { events } = await readSse(brain.baseUrl, `${PREFIX}/${sessionId}/events?after=-1`, {
      headers: auth,
      until: received => received.some(event => event.event === 'ready'),
    })
    expect(events[0]).toMatchObject({ event: 'snapshot', data: { cursor: 0 } })
    const replayed = events.filter(event => event.event === 'event').map(event => event.data)
    expect(replayed).toContainEqual({ seq: 0, type: 'note', data: { hello: 'replay' } })
  })

  it('Cordis 的 session/event 实时帧被转发给 SSE 客户端', async () => {
    const sessionId = await createSession()
    const { events } = await readSse(brain.baseUrl, `${PREFIX}/${sessionId}/events?after=-1`, {
      headers: auth,
      onReady: () => {
        emit(
          ctx,
          'session/event',
          { id: sessionId },
          { seq: 0, type: 'note', data: { hello: 'live' } },
        )
      },
      until: received =>
        received.some(
          event => event.event === 'event' && (event.data as { data?: { hello?: string } }).data?.hello === 'live',
        ),
    })
    expect(events.map(event => event.event)).toEqual(expect.arrayContaining(['snapshot', 'ready', 'event']))
  })
})

describe('platform-api 装配：平台端点改写', () => {
  it('哨兵域名的模型请求被改写到本会话登记的端点', async () => {
    const captured: Array<{ url: string; path: string }> = []
    const server: Server = createServer((req, res) => {
      captured.push({ url: req.url ?? '', path: new URL(req.url ?? '/', 'http://x').pathname })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    try {
      const sessionId = await createSession()
      const baseUrls = ctx.get('sessionModelBaseUrls') as FakeBaseUrlStore
      baseUrls.set(sessionId, `http://127.0.0.1:${port}/v1`)
      agents.setCurrent(sessionId)

      const response = await fetch('http://dsh-model.invalid/chat/completions?q=1')
      expect(response.status).toBe(200)
      expect(captured).toEqual([{ url: '/v1/chat/completions?q=1', path: '/v1/chat/completions' }])
    } finally {
      agents.setCurrent(undefined)
      server.closeAllConnections?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('没有当前会话时改写回退到最近一次登记的端点', async () => {
    const captured: string[] = []
    const server: Server = createServer((req, res) => {
      captured.push(req.url ?? '')
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    try {
      const baseUrls = ctx.get('sessionModelBaseUrls') as FakeBaseUrlStore
      baseUrls.set('fallback-session', `http://127.0.0.1:${port}/api`)
      agents.setCurrent(undefined)

      await fetch('http://dsh-model.invalid/v1/chat/completions')
      expect(captured).toEqual(['/api/v1/chat/completions'])
    } finally {
      server.closeAllConnections?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('platform-api 装配：连接与工作区同步', () => {
  it('浏览器令牌已摘除：/brain/v1/client-token 不再存在', async () => {
    const missing = await call(brain.baseUrl, '/brain/v1/client-token', { headers: auth })
    expect(missing.status).toBe(404)
  })

  it('workspaces/sync 让脑重新投影工作区', async () => {
    const before = refreshes
    const response = await call(brain.baseUrl, '/brain/v1/workspaces/sync', { method: 'POST', headers: auth })
    expect(response.status).toBe(200)
    expect(response.json()).toEqual({ ok: true })
    expect(refreshes).toBe(before + 1)
  })

  it('workspaces/sync 要求应用凭据', async () => {
    const response = await call(brain.baseUrl, '/brain/v1/workspaces/sync', { method: 'POST' })
    expect(response.status).toBe(401)
  })
})

describe('platform-api 装配：分叉与 steer', () => {
  it('fork 把日志分叉委托给 sessionController，回 201 与新会话 id', async () => {
    const sessionId = await createSession()
    const response = await call(brain.baseUrl, `${PREFIX}/${sessionId}/fork`, {
      method: 'POST',
      headers: auth,
      body: { atSeq: 7 },
    })
    expect(response.status).toBe(201)
    expect(response.json()).toMatchObject({ sessionId: `session-fork-${sessionId}-7` })
  })

  it('fork 的 atSeq 必须是非负整数', async () => {
    const sessionId = await createSession()
    const response = await call(brain.baseUrl, `${PREFIX}/${sessionId}/fork`, {
      method: 'POST',
      headers: auth,
      body: { atSeq: -1 },
    })
    expect(response.status).toBe(400)
    expect((response.json() as { error: { code: string } }).error.code).toBe('invalid-at-seq')
  })

  it('fork 源会话取不到日志时 404', async () => {
    const savedFork = (ctx.get('sessionController') as { fork: unknown }).fork
    ;(ctx.get('sessionController') as { fork: unknown }).fork = async () => {
      throw Object.assign(new Error('no log'), { code: 'session/not-found' })
    }
    try {
      const response = await call(brain.baseUrl, `${PREFIX}/session-ghost/fork`, {
        method: 'POST',
        headers: auth,
        body: {},
      })
      expect(response.status).toBe(404)
      expect((response.json() as { error: { code: string } }).error.code).toBe('session-not-found')
    } finally {
      ;(ctx.get('sessionController') as { fork: unknown }).fork = savedFork
    }
  })

  it('mode: steer 走 Agent.steer，而不是 followup', async () => {
    const sessionId = await createSession()
    type SteerableAgent = FakeAgent & { steers: unknown[]; steer(message: unknown): void }
    const agent = agents.byId.get(sessionId) as SteerableAgent
    agent.steers = []
    agent.steer = (message: unknown) => {
      agent.steers.push(message)
    }
    const response = await call(brain.baseUrl, `${PREFIX}/${sessionId}/messages`, {
      method: 'POST',
      headers: auth,
      body: { text: '换个方向', mode: 'steer' },
    })
    expect(response.status).toBe(202)
    expect(agent.steers).toHaveLength(1)
    expect(agent.followups).toHaveLength(0)
  })

  it('非法 mode 回 400 invalid-mode', async () => {
    const sessionId = await createSession()
    const response = await call(brain.baseUrl, `${PREFIX}/${sessionId}/messages`, {
      method: 'POST',
      headers: auth,
      body: { text: 'hi', mode: 'later' },
    })
    expect(response.status).toBe(400)
    expect((response.json() as { error: { code: string } }).error.code).toBe('invalid-mode')
  })
})

describe('platform-api 装配：租约与会话回收', () => {
  it('租约丢失时取消本副本的 Agent，保留收件箱', async () => {
    const sessionId = await createSession()
    emit(ctx, 'session/lease-lost', sessionId)
    const agent = agents.byId.get(sessionId) as FakeAgent
    expect(agent.cancels).toContainEqual({
      reason: { kind: 'hook', reason: 'session lease moved to another replica' },
      options: { keepInbox: true },
    })
  })

  it('会话销毁后清掉模型 key 与端点登记', async () => {
    const sessionId = await createSession()
    expect((ctx.get('sessionModelKeys') as FakeKeyStore).get(sessionId)).toBe('sk-session-key')

    emit(ctx, 'session/disposed', { id: sessionId })
    expect((ctx.get('sessionModelKeys') as FakeKeyStore).get(sessionId)).toBeUndefined()
    expect((ctx.get('sessionModelBaseUrls') as FakeBaseUrlStore).get(sessionId)).toBeUndefined()
  })
})

describe('platform-api 装配：后台任务读取与终止', () => {
  it('任务清单按会话读出注册表投影', async () => {
    const sessionId = await createSession()
    const roster = await readSse(brain.baseUrl, `${PREFIX}/${sessionId}/jobs`, {
      headers: auth,
      until: events => events.some(event => event.event === 'rows'),
    })
    try {
      const rows = roster.events.find(event => event.event === 'rows')
      expect(rows?.data).toMatchObject({
        jobs: [{ id: 'bash-1', owner: sessionId, status: 'running' }],
      })
    } finally {
      roster.close()
    }
  })

  it('终止任务把会话、任务和“用户取消”原因一起交给注册表', async () => {
    const sessionId = await createSession()
    killedJobs.length = 0
    const response = await call(brain.baseUrl, `${PREFIX}/${sessionId}/jobs/bash-1/kill`, {
      method: 'POST',
      headers: auth,
      body: {},
    })
    expect(response.status).toBe(200)
    expect(response.json()).toMatchObject({ outcome: 'requested' })
    expect(killedJobs).toEqual([
      { id: 'bash-1', sessionId, reason: 'cancelled by the user' },
    ])
  })

  it('看不到的任务一律 404，不暴露任务是否存在', async () => {
    const sessionId = await createSession()
    for (const code of ['JOB_NOT_FOUND', 'JOB_FOREIGN_SESSION']) {
      jobFailure = { code, message: 'job is not visible to this session' }
      const kill = await call(brain.baseUrl, `${PREFIX}/${sessionId}/jobs/bash-1/kill`, {
        method: 'POST',
        headers: auth,
        body: {},
      })
      expect(kill.status).toBe(404)
      expect(kill.json()).toMatchObject({ error: { code: 'job-not-found' } })
    }

    // 输出流也走同一套映射：打开时第一个帧就失败，响应仍是 404 而不是空的 200。
    jobFailure = { code: 'JOB_FOREIGN_SESSION', message: 'job is not visible to this session' }
    const output = await call(brain.baseUrl, `${PREFIX}/${sessionId}/jobs/bash-1/output`, {
      headers: auth,
    })
    expect(output.status).toBe(404)
    expect(output.json()).toMatchObject({ error: { code: 'job-not-found' } })
  })

  it('持有者已下线按 409，和“任务不存在”区分开', async () => {
    const sessionId = await createSession()
    jobFailure = { code: 'JOB_OWNER_NOT_LIVE', message: 'job lost its owning session' }
    const response = await call(brain.baseUrl, `${PREFIX}/${sessionId}/jobs/bash-1/kill`, {
      method: 'POST',
      headers: auth,
      body: {},
    })
    expect(response.status).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'job-owner-not-live' } })
  })

  it('输出流 from 必须是自然数', async () => {
    const sessionId = await createSession()
    const response = await call(brain.baseUrl, `${PREFIX}/${sessionId}/jobs/bash-1/output?from=-2`, {
      headers: auth,
    })
    expect(response.status).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid-from' } })
  })
})

describe('platform-api 装配：定时任务 Remote 转发', () => {
  const schedule = (action: string, body: unknown, headers: Record<string, string> = auth) =>
    call(brain.baseUrl, `/brain/v1/schedule/${action}`, {
      method: 'POST',
      headers,
      body,
    })

  it('POST /brain/v1/schedule/<action> 经 gateway.remote 调 schedule 命名空间', async () => {
    remoteCalls = []
    const response = await schedule('catalog', {
      type: 'client-request',
      rpcId: 'rpc-catalog',
      payload: { args: { sessionIds: ['s1', 's2'] } },
    })
    expect(response.status).toBe(200)
    expect(response.json()).toEqual({
      type: 'server-response',
      rpcId: 'rpc-catalog',
      result: { ok: true, value: [{ id: 'sch_1' }] },
    })
    expect(remoteCalls).toEqual([{
      namespace: 'schedule',
      method: 'catalog',
      args: { sessionIds: ['s1', 's2'] },
      principal: { kind: 'owner' },
    }])
  })

  it('业务错误按 result.ok:false 回包，保留脑的错误码', async () => {
    remoteFailure = { code: 'invalid_rule', message: 'cron expression is invalid' }
    const response = await schedule('create', {
      type: 'client-request',
      rpcId: 'rpc-create',
      payload: { args: { request: { title: 'x' } } },
    })
    expect(response.status).toBe(200)
    expect(response.json()).toMatchObject({
      type: 'server-response',
      rpcId: 'rpc-create',
      result: { ok: false, error: { code: 'invalid_rule', message: 'cron expression is invalid' } },
    })
  })

  it('没有动作段按 404，未知动作也不转发', async () => {
    remoteCalls = []
    const response = await schedule('', { type: 'client-request', rpcId: 'rpc-x', payload: { args: {} } })
    expect(response.status).toBe(404)
    expect(remoteCalls).toEqual([])
  })

  it('GET 与缺凭据都不进转发层', async () => {
    remoteCalls = []
    const wrongMethod = await call(brain.baseUrl, '/brain/v1/schedule/catalog', { headers: auth })
    expect(wrongMethod.status).toBe(405)
    const anonymous = await schedule('catalog', { type: 'client-request', rpcId: 'rpc-a', payload: { args: {} } }, {})
    expect(anonymous.status).toBe(401)
    expect(remoteCalls).toEqual([])
  })
})
