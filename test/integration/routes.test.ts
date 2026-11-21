import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_HEADERS } from '../../packages/dsh-platform-api/src/auth.ts'
import { HttpError } from '../../packages/dsh-platform-api/src/http.ts'
import { PREFIX, registerRoutes } from '../../packages/dsh-platform-api/src/routes.ts'
import {
  call,
  FakeWebServer,
  MemoryGateway,
  readSse,
  startBrainServer,
  testContext,
  type BrainServer,
} from '../helpers/brain.ts'

const appKey = 'k'.repeat(24)
const auth = { 'x-app-id': 'platform', 'x-app-key': appKey, 'x-dsh-user-id': 'u1' }

let brain: BrainServer
let gateway: MemoryGateway
let createdSession = ''

beforeAll(async () => {
  gateway = new MemoryGateway()
  const owned = new Set<string>()
  const ctx = testContext({ webServer: new FakeWebServer() })
  registerRoutes(ctx, {
    gateway,
    credentials: [{ appId: 'platform', appKey }],
    headers: DEFAULT_HEADERS,
    requireUser: true,
    ownership: {
      async assert(sessionId, userId) {
        if (userId !== 'u1' || !owned.has(sessionId)) {
          throw new HttpError(404, 'session-not-found', `session "${sessionId}" is not available to this caller`)
        }
      },
    },
  })
  // 让 ownership 知道我们创建的会话；用 gateway.create 的钩子补齐。
  const originalCreate = gateway.create.bind(gateway)
  gateway.create = async (input) => {
    const created = await originalCreate(input)
    owned.add(created.sessionId)
    return created
  }
  brain = await startBrainServer(ctx)
  const response = await call(brain.baseUrl, PREFIX, {
    method: 'POST',
    headers: auth,
    body: { cwd: '/desk' },
  })
  createdSession = (response.json() as { sessionId: string }).sessionId
})

afterAll(async () => {
  await brain.close()
})

describe('brain REST 路由', () => {
  it('健康检查式的未认证请求被拒', async () => {
    const response = await call(brain.baseUrl, PREFIX, { method: 'POST', body: { cwd: '/desk' } })
    expect(response.status).toBe(401)
    expect((response.json() as { error: { code: string } }).error.code).toBe('unauthorized')
  })

  it('缺少用户头同样被拒', async () => {
    const response = await call(brain.baseUrl, PREFIX, {
      method: 'POST',
      headers: { 'x-app-id': 'platform', 'x-app-key': appKey },
      body: { cwd: '/desk' },
    })
    expect(response.status).toBe(401)
    expect((response.json() as { error: { code: string } }).error.code).toBe('user-required')
  })

  it('创建会话返回 201 与 requestId', async () => {
    expect(createdSession).toMatch(/^sess-/)
    const response = await call(brain.baseUrl, PREFIX, {
      method: 'POST',
      headers: { ...auth, 'x-request-id': 'req-9' },
      body: { cwd: '/desk', preset: 'platform' },
    })
    expect(response.status).toBe(201)
    expect(response.json()).toEqual({ sessionId: expect.any(String), requestId: 'req-9' })
    expect(gateway.sessions.get((response.json() as { sessionId: string }).sessionId)).toMatchObject({
      cwd: '/desk',
      preset: 'platform',
    })
  })

  it('创建时登记成员配置的全部模型', async () => {
    const response = await call(brain.baseUrl, PREFIX, {
      method: 'POST',
      headers: { ...auth, 'x-dsh-model-ids': ' deepseek-chat , deepseek-reasoner ' },
      body: { cwd: '/desk' },
    })
    expect(response.status).toBe(201)
    expect(gateway.registeredModels.at(-1)).toEqual({
      provider: 'user',
      models: ['deepseek-chat', 'deepseek-reasoner'],
    })
  })

  it('x-dsh-model-api 决定登记目录和选中模型用哪条协议路由', async () => {
    const response = await call(brain.baseUrl, PREFIX, {
      method: 'POST',
      headers: {
        ...auth,
        'x-dsh-model-api': 'google-generative-ai',
        'x-dsh-model-ids': 'gemini-2.5-pro',
        'x-dsh-model-id': 'gemini-2.5-pro',
      },
      body: { cwd: '/desk' },
    })
    expect(response.status).toBe(201)
    expect(gateway.registeredModels.at(-1)).toEqual({
      provider: 'user-google-generative-ai',
      models: ['gemini-2.5-pro'],
    })
    expect(gateway.modelSelections.at(-1)).toMatchObject({
      provider: 'user-google-generative-ai',
      model: 'gemini-2.5-pro',
    })
  })

  it('不认识的协议回 400 model-protocol-invalid，且不建会话', async () => {
    const before = gateway.sessions.size
    const response = await call(brain.baseUrl, PREFIX, {
      method: 'POST',
      headers: { ...auth, 'x-dsh-model-api': 'openai', 'x-dsh-model-ids': 'gpt-4o' },
      body: { cwd: '/desk' },
    })
    expect(response.status).toBe(400)
    expect((response.json() as { error: { code: string } }).error.code).toBe('model-protocol-invalid')
    // 协议校验发生在建会话和登记之前：不留半配置会话，也不按 user 静默登记。
    expect(gateway.sessions.size).toBe(before)
    expect(gateway.registeredModels.every(entry => !entry.models.includes('gpt-4o'))).toBe(true)
  })

  it('带 x-dsh-model-id 认领会话时选中平台指定的模型', async () => {
    const response = await call(brain.baseUrl, PREFIX, {
      method: 'POST',
      headers: {
        ...auth,
        'x-dsh-model-key': 'sk-platform-test',
        'x-dsh-model-base-url': 'https://api.example.com/v1',
        'x-dsh-model-id': 'deepseek-chat',
      },
      body: { cwd: '/desk', sessionId: 'sess-adopt' },
    })
    expect(response.status).toBe(201)
    expect((response.json() as { sessionId: string }).sessionId).toBe('sess-adopt')
    expect(gateway.modelSelections.at(-1)).toMatchObject({
      sessionId: 'sess-adopt',
      provider: 'user',
      model: 'deepseek-chat',
    })
  })

  it('创建时 cwd 必须是绝对路径', async () => {
    const response = await call(brain.baseUrl, PREFIX, { method: 'POST', headers: auth, body: { cwd: 'relative' } })
    expect(response.status).toBe(400)
    expect((response.json() as { error: { code: string } }).error.code).toBe('invalid-cwd')
  })

  it('创建时请求体必须是 JSON 对象', async () => {
    const response = await call(brain.baseUrl, PREFIX, { method: 'POST', headers: auth, body: [1, 2] })
    expect(response.status).toBe(400)
    expect((response.json() as { error: { code: string } }).error.code).toBe('invalid-body')
  })

  it('错误方法返回 405', async () => {
    const response = await call(brain.baseUrl, PREFIX, { headers: auth })
    expect(response.status).toBe(405)
  })

  it('提交消息返回 202，并把文本交给网关', async () => {
    const response = await call(brain.baseUrl, `${PREFIX}/${createdSession}/messages`, {
      method: 'POST',
      headers: auth,
      body: { text: '你好' },
    })
    expect(response.status).toBe(202)
    expect(gateway.prompts.at(-1)).toMatchObject({ sessionId: createdSession, text: '你好' })
  })

  it('空消息被拒', async () => {
    const response = await call(brain.baseUrl, `${PREFIX}/${createdSession}/messages`, {
      method: 'POST',
      headers: auth,
      body: { text: '   ' },
    })
    expect(response.status).toBe(400)
    expect((response.json() as { error: { code: string } }).error.code).toBe('invalid-text')
  })

  it('会话不属于请求者时统一 404', async () => {
    const response = await call(brain.baseUrl, `${PREFIX}/${createdSession}/messages`, {
      method: 'POST',
      headers: { ...auth, 'x-dsh-user-id': 'u2' },
      body: { text: '偷看' },
    })
    expect(response.status).toBe(404)
  })

  it('未知动作返回 404', async () => {
    const response = await call(brain.baseUrl, `${PREFIX}/${createdSession}/unknown`, { headers: auth })
    expect(response.status).toBe(404)
  })

  it('取消返回 202', async () => {
    const response = await call(brain.baseUrl, `${PREFIX}/${createdSession}/cancel`, { method: 'POST', headers: auth })
    expect(response.status).toBe(202)
    expect(gateway.cancellations).toContain(createdSession)
  })

  it('事件流先给快照，再回放，然后追新事件', async () => {
    gateway.append(createdSession, 'note', { hello: 'replay' })
    const pending = readSse(brain.baseUrl, `${PREFIX}/${createdSession}/events?after=-1`, {
      headers: auth,
      until: (events) => events.some((event) => event.event === 'ready'),
    })
    const { events } = await pending
    expect(events[0]).toMatchObject({ event: 'snapshot', data: { cursor: expect.any(Number) } })
    expect(events.some((event) => event.event === 'ready')).toBe(true)
    // event 帧的 data 是提交后的信封 {seq, type, data}。
    const replayed = events
      .filter((event) => event.event === 'event')
      .map((event) => event.data as { type: string; data: unknown })
    expect(replayed).toContainEqual(expect.objectContaining({ type: 'note', data: { hello: 'replay' } }))
  })

  it('事件流打开后能收到实时事件', async () => {
    const { events } = await readSse(brain.baseUrl, `${PREFIX}/${createdSession}/events?after=999`, {
      headers: auth,
      onReady: () => {
        gateway.append(createdSession, 'note', { hello: 'live' })
      },
      until: (received) =>
        received.some(
          (event) =>
            event.event === 'event' &&
            (event.data as { type?: string; data?: { hello?: string } }).data?.hello === 'live',
        ),
    })
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining(['snapshot', 'ready', 'event']))
  })

  it('事件流的回放与实时帧都保留 surfaceOp 等表面元数据', async () => {
    // 浏览器按这些字段重建有序表面；漏掉它们，上游 session store 会把整段
    // 历史判成 `requires a surfaceOp marker`。
    const surfaceOp = { op: 'replace', startSeq: 3, endSeq: 3 }
    const surface = { surfaceOp, sourceEventSeqs: [3], ignorable: true }
    gateway.append(createdSession, 'system/message', { text: '回放摘要' }, surface)
    const replayedStream = await readSse(brain.baseUrl, `${PREFIX}/${createdSession}/events?after=-1`, {
      headers: auth,
      until: (received) => received.some((event) => event.event === 'ready'),
    })
    try {
      const replayed = replayedStream.events.find(
        (event) => event.event === 'event' && (event.data as { data?: { text?: string } }).data?.text === '回放摘要',
      )
      expect(replayed?.data).toMatchObject({ type: 'system/message', surfaceOp, sourceEventSeqs: [3], ignorable: true })
    } finally {
      replayedStream.close()
    }

    const live = await readSse(brain.baseUrl, `${PREFIX}/${createdSession}/events?after=999`, {
      headers: auth,
      onReady: () => {
        gateway.append(createdSession, 'system/message', { text: '实时摘要' }, surface)
      },
      until: (received) =>
        received.some(
          (event) =>
            event.event === 'event' &&
            (event.data as { data?: { text?: string } }).data?.text === '实时摘要',
        ),
    })
    try {
      const frame = live.events.find(
        (event) => event.event === 'event' && (event.data as { data?: { text?: string } }).data?.text === '实时摘要',
      )
      expect(frame?.data).toMatchObject({ type: 'system/message', surfaceOp, sourceEventSeqs: [3], ignorable: true })
    } finally {
      live.close()
    }
  })

  it('非法 after 被拒', async () => {
    const response = await call(brain.baseUrl, `${PREFIX}/${createdSession}/events?after=abc`, { headers: auth })
    expect(response.status).toBe(400)
  })

  it('未知会话的事件流是 404 而不是空 200', async () => {
    const response = await call(brain.baseUrl, `${PREFIX}/missing-session/events`, { headers: auth })
    expect(response.status).toBe(404)
  })

  it('未挂载可选端点时返回 404 或 501', async () => {
    const models = await call(brain.baseUrl, '/brain/v1/models', { headers: auth })
    expect(models.status).toBe(404)
    // 只摘掉 projections，其余能力照常装配：缺能力的副本应回 501 而不是空 200。
    const partial = new Proxy(gateway, {
      get: (target, prop, receiver) => (prop === 'projections' ? undefined : Reflect.get(target, prop, receiver)),
    })
    const ctx = testContext({ webServer: new FakeWebServer() })
    registerRoutes(ctx, {
      gateway: partial,
      credentials: [{ appId: 'platform', appKey }],
      headers: DEFAULT_HEADERS,
      requireUser: true,
      ownership: { assert: async () => undefined },
    })
    const bare = await startBrainServer(ctx)
    try {
      const projections = await call(bare.baseUrl, `${PREFIX}/${createdSession}/projections`, { headers: auth })
      expect(projections.status).toBe(501)
    } finally {
      await bare.close()
    }
  })
})
