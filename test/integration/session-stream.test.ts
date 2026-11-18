import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_HEADERS } from '../../packages/dsh-platform-api/src/auth.ts'
import { HttpError } from '../../packages/dsh-platform-api/src/http.ts'
import { registerRoutes } from '../../packages/dsh-platform-api/src/routes.ts'
import {
  auditUpgradeRoutes,
  createSessionStream,
  type SessionStream,
} from '../../packages/dsh-platform-api/src/session-stream.ts'
import {
  FakeWebServer,
  MemoryGateway,
  openSessionStream,
  startBrainServer,
  testContext,
  type BrainServer,
  type StreamClient,
} from '../helpers/brain.ts'

/**
 * 会话级 SSE：真实 HTTP + 真实路由层。
 *
 * 覆盖：鉴权/归属先于任何响应字节、ready 首帧、事件/状态/流式帧、
 * 上行答复的 409、审批/提问 waterfall、答复回原 answerer、断线后重放待答
 * 请求、keepalive 注释、Upgrade 审计（必须为空）。
 */

const appKey = 'k'.repeat(24)
const auth = { 'x-app-id': 'platform', 'x-app-key': appKey, 'x-dsh-user-id': 'u1' }
const known = new Set(['sess-a', 'sess-b'])

let brain: BrainServer
let gateway: MemoryGateway
let stream: SessionStream
let ctx: ReturnType<typeof testContext>
const clients: StreamClient[] = []

beforeAll(async () => {
  gateway = new MemoryGateway()
  await gateway.create({ cwd: '/desk', sessionId: 'sess-a' })
  await gateway.create({ cwd: '/desk', sessionId: 'sess-b' })
  ctx = testContext({ webServer: new FakeWebServer() })
  stream = createSessionStream(ctx, { gateway })
  registerRoutes(ctx, {
    gateway,
    credentials: [{ appId: 'platform', appKey }],
    headers: DEFAULT_HEADERS,
    requireUser: true,
    sessionStream: stream,
    ownership: {
      async assert(sessionId, userId) {
        if (userId !== 'u1' || !known.has(sessionId)) {
          throw new HttpError(404, 'session-not-found', `session "${sessionId}" is not available to this caller`)
        }
      },
    },
  })
  brain = await startBrainServer(ctx)
})

afterAll(async () => {
  for (const client of clients) client.close()
  stream.close()
  await brain.close()
})

async function connect(sessionId = 'sess-a', headers: Record<string, string> = auth): Promise<StreamClient> {
  const client = await openSessionStream(brain.baseUrl, sessionId, { headers })
  clients.push(client)
  return client
}

describe('脑侧会话级 SSE', () => {
  it('没有任何 Upgrade 路由', () => {
    expect(auditUpgradeRoutes(brain.web)).toEqual([])
    expect(brain.web.upgrades.size).toBe(0)
  })

  it('缺应用凭据时 401', async () => {
    await expect(openSessionStream(brain.baseUrl, 'sess-a')).rejects.toThrow(/401/)
  })

  it('缺用户头时 401', async () => {
    await expect(
      openSessionStream(brain.baseUrl, 'sess-a', {
        headers: { 'x-app-id': 'platform', 'x-app-key': appKey },
      }),
    ).rejects.toThrow(/401/)
  })

  it('不属于当前用户的会话一律 404', async () => {
    await expect(openSessionStream(brain.baseUrl, 'sess-x', { headers: auth })).rejects.toThrow(/404/)
    // 别人的会话同样 404：不暴露存在性。
    await expect(
      openSessionStream(brain.baseUrl, 'sess-a', {
        headers: { ...auth, 'x-dsh-user-id': 'u2' },
      }),
    ).rejects.toThrow(/404/)
  })

  it('首帧是 ready，携带会话与当前日志偏移', async () => {
    const client = await connect()
    const ready = await client.waitFor(frame => frame.type === 'ready')
    expect(ready).toMatchObject({ type: 'ready', sessionId: 'sess-a', seq: -1 })
  })

  it('下发事件、状态与流式帧', async () => {
    const client = await connect()
    await client.waitFor(frame => frame.type === 'ready')
    await gateway.prompt('sess-a', '你好', 'req-1')
    const event = await client.waitFor(frame => frame.type === 'event' && (frame.event as { type: string }).type === 'user')
    expect(event).toMatchObject({ type: 'event', event: { type: 'user', data: { text: '你好' } } })

    // assistant 流式帧走 gateway.subscribe 的 assistant 分支。
    gateway.append('sess-a', 'assistant', { text: 'chunk' })
    const status = await client.waitFor(frame => frame.type === 'status')
    expect(typeof status.running).toBe('boolean')
  })

  it('事件帧原样带出 surfaceOp 与 sourceEventSeqs', async () => {
    // 浏览器按这两个字段重建有序表面；丢一个就把整段历史判成
    // `requires a surfaceOp marker`。这里钉住 session-stream 的 dispatch。
    const client = await connect()
    await client.waitFor(frame => frame.type === 'ready')
    const surfaceOp = { op: 'replace', startSeq: 9, endSeq: 9 }
    const seq = gateway.append('sess-a', 'system/message', { text: '摘要' }, { surfaceOp, sourceEventSeqs: [9] })
    const frame = await client.waitFor(entry => entry.type === 'event' && entry.seq === seq)
    expect(frame.event).toEqual({
      type: 'system/message',
      data: { text: '摘要' },
      surfaceOp,
      sourceEventSeqs: [9],
    })
  })

  it('未知 requestId 的答复回 409，流保持打开', async () => {
    const client = await connect()
    await client.waitFor(frame => frame.type === 'ready')
    const reply = await client.answer('missing', { kind: 'result', value: 'approved' })
    expect(reply.status).toBe(409)
    // 流没有被关闭：再发一次消息还能收到事件。
    await gateway.prompt('sess-a', '还在吗', 'req-2')
    await client.waitFor(frame => frame.type === 'event' && (frame.event as { type: string }).type === 'user')
  })

  it('别的会话的答复回 409，答不到别人的待答请求', async () => {
    const owner = await connect('sess-a')
    await owner.waitFor(frame => frame.type === 'ready')
    const answered = (ctx as unknown as {
      waterfall(name: string, request: unknown, fallback: () => Promise<string>): Promise<string>
    }).waterfall(
      'approval/request',
      { agent: { session: { id: 'sess-a' } }, toolName: 'bash' },
      async () => 'unavailable',
    )
    const waterfall = await owner.waitFor(frame => frame.type === 'waterfall')

    const intruder = await connect('sess-b')
    await intruder.waitFor(frame => frame.type === 'ready')
    const reply = await intruder.answer(waterfall.requestId, { kind: 'result', value: 'approved' })
    expect(reply.status).toBe(409)
    expect(stream.pendingCount('sess-a')).toBe(1)

    expect((await owner.answer(waterfall.requestId, { kind: 'result', value: 'approved' })).status).toBe(200)
    await expect(answered).resolves.toBe('allowed-once')
    // 后面“没有流”的用例要靠 sess-b 真的没有订阅者。
    intruder.close()
    await intruder.closed
  })

  it('审批 waterfall 下发，答复回到 Agent 的 answerer', async () => {
    const client = await connect()
    await client.waitFor(frame => frame.type === 'ready')
    const answered = (ctx as unknown as {
      waterfall(name: string, request: unknown, fallback: () => Promise<string>): Promise<string>
    }).waterfall(
      'approval/request',
      { agent: { session: { id: 'sess-a' } }, toolName: 'bash', reason: '需要写入' },
      async () => 'unavailable',
    )
    const waterfall = await client.waitFor(frame => frame.type === 'waterfall')
    expect(waterfall).toMatchObject({
      type: 'waterfall',
      kind: 'approval',
      request: { toolName: 'bash', reason: '需要写入' },
    })
    const reply = await client.answer(waterfall.requestId, { kind: 'result', value: 'allowed-once' })
    expect(reply.status).toBe(200)
    await expect(answered).resolves.toBe('allowed-once')
    const cancel = await client.waitFor(
      frame => frame.type === 'cancel' && frame.requestId === waterfall.requestId,
    )
    expect(cancel.type).toBe('cancel')
    // 重复答复同一个 requestId 一律 409。
    expect((await client.answer(waterfall.requestId, { kind: 'result', value: 'approved' })).status).toBe(409)
  })

  it('断线后重连先重放未答复的审批请求', async () => {
    const first = await connect()
    await first.waitFor(frame => frame.type === 'ready')
    const answered = (ctx as unknown as {
      waterfall(name: string, request: unknown, fallback: () => Promise<string>): Promise<string>
    }).waterfall(
      'approval/request',
      { agent: { session: { id: 'sess-a' } }, toolName: 'write' },
      async () => 'unavailable',
    )
    const original = await first.waitFor(frame => frame.type === 'waterfall')
    first.close()
    await first.closed

    const second = await connect()
    const ready = await second.waitFor(frame => frame.type === 'ready')
    expect(ready.type).toBe('ready')
    const replayed = await second.waitFor(frame => frame.type === 'waterfall')
    expect(replayed.requestId).toBe(original.requestId)
    await second.answer(replayed.requestId, { kind: 'result', value: 'approved' })
    await expect(answered).resolves.toBe('allowed-once')
  })

  it('计划评审按 plan 下发，答复原样回到提问者', async () => {
    const client = await connect()
    await client.waitFor(frame => frame.type === 'ready')
    const answered = (ctx as unknown as {
      waterfall(name: string, request: unknown, fallback: () => Promise<unknown>): Promise<unknown>
    }).waterfall(
      'user-questions/request',
      {
        agent: { session: { id: 'sess-a' } },
        questions: [{
          id: 'q1',
          question: '批准这个计划吗？',
          options: [{ label: 'Approve' }, { label: 'Decline' }],
          intent: { kind: 'plan-review', approve: 'Approve' },
        }],
      },
      async () => {
        throw new Error('no answerer')
      },
    )
    const waterfall = await client.waitFor(frame => frame.type === 'waterfall')
    expect(waterfall).toMatchObject({ kind: 'plan', request: { questions: [{ id: 'q1' }] } })
    const answer = { answers: [{ id: 'q1', selected: ['Approve'] }] }
    await client.answer(waterfall.requestId, { kind: 'result', value: answer })
    await expect(answered).resolves.toEqual(answer)
  })

  it('回合中止时向所有流广播 cancel', async () => {
    const client = await connect()
    await client.waitFor(frame => frame.type === 'ready')
    const controller = new AbortController()
    const answered = (ctx as unknown as {
      waterfall(name: string, request: unknown, fallback: () => Promise<string>): Promise<string>
    }).waterfall(
      'approval/request',
      { agent: { session: { id: 'sess-a' } }, toolName: 'bash', signal: controller.signal },
      async () => 'unavailable',
    )
    const waterfall = await client.waitFor(frame => frame.type === 'waterfall')
    controller.abort()
    await expect(answered).resolves.toBe('cancelled')
    const cancel = await client.waitFor(
      frame => frame.type === 'cancel' && frame.requestId === waterfall.requestId,
    )
    expect(cancel.type).toBe('cancel')
    expect(stream.pendingCount('sess-a')).toBe(0)
  })

  it('没有流时不认领 waterfall，交回原链（fail closed）', async () => {
    const deadline = Date.now() + 2_000
    while (stream.connectionCount('sess-b') !== 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(stream.connectionCount('sess-b')).toBe(0)
    const outcome = await (ctx as unknown as {
      waterfall(name: string, request: unknown, fallback: () => Promise<string>): Promise<string>
    }).waterfall(
      'approval/request',
      { agent: { session: { id: 'sess-b' } }, toolName: 'bash' },
      async () => 'unavailable',
    )
    expect(outcome).toBe('unavailable')
    expect(stream.pendingCount('sess-b')).toBe(0)
  })

  it('空闲时下发 keepalive 注释', async () => {
    const fastGateway = new MemoryGateway()
    await fastGateway.create({ cwd: '/desk', sessionId: 'sess-a' })
    const fastCtx = testContext({ webServer: new FakeWebServer() })
    const fastStream = createSessionStream(fastCtx, { gateway: fastGateway, heartbeatMs: 30 })
    registerRoutes(fastCtx, {
      gateway: fastGateway,
      credentials: [{ appId: 'platform', appKey }],
      headers: DEFAULT_HEADERS,
      requireUser: true,
      sessionStream: fastStream,
      ownership: { async assert() { /* dev box: no tenant boundary */ } },
    })
    const fastBrain = await startBrainServer(fastCtx)
    const controller = new AbortController()
    try {
      const response = await fetch(`${fastBrain.baseUrl}/brain/v1/sessions/sess-a/stream`, {
        headers: { accept: 'text/event-stream', ...auth },
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let seen = ''
      const deadline = Date.now() + 3_000
      while (!seen.includes(': keepalive') && Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        seen += decoder.decode(value, { stream: true })
      }
      expect(seen).toContain(': keepalive')
      await reader.cancel().catch(() => undefined)
    } finally {
      controller.abort()
      fastStream.close()
      await fastBrain.close()
    }
  })
})
