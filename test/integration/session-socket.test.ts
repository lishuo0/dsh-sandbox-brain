import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_HEADERS } from '../../packages/dsh-platform-api/src/auth.ts'
import { HttpError } from '../../packages/dsh-platform-api/src/http.ts'
import { registerRoutes } from '../../packages/dsh-platform-api/src/routes.ts'
import { createSessionStream, type SessionStream } from '../../packages/dsh-platform-api/src/session-stream.ts'
import { createSessionSocket } from '../../packages/dsh-platform-api/src/session-socket.ts'
import {
  FakeWebServer,
  MemoryGateway,
  openSessionSocket,
  startBrainServer,
  testContext,
  type BrainServer,
  type SessionSocketClient,
} from '../helpers/brain.ts'

/**
 * 会话级 WebSocket：真实 HTTP Upgrade + 真实路由层。
 *
 * 覆盖：与 SSE 相同的下行帧集、带内答复结算与 `ack`、未知请求的
 * `answer-error`、畸形答复、鉴权/归属在握手阶段生效、答复不会结算别人的
 * 待答请求。
 */

const appKey = 'k'.repeat(24)
const auth = { 'x-app-id': 'platform', 'x-app-key': appKey, 'x-dsh-user-id': 'u1' }
const known = new Set(['sess-a', 'sess-b'])

let brain: BrainServer
let gateway: MemoryGateway
let stream: SessionStream
let ctx: ReturnType<typeof testContext>
const clients: SessionSocketClient[] = []

beforeAll(async () => {
  gateway = new MemoryGateway()
  await gateway.create({ cwd: '/desk', sessionId: 'sess-a' })
  await gateway.create({ cwd: '/desk', sessionId: 'sess-b' })
  ctx = testContext({ webServer: new FakeWebServer() })
  stream = createSessionStream(ctx, { gateway })
  const ownership = {
    async assert(sessionId: string, userId: string) {
      if (userId !== 'u1' || !known.has(sessionId)) {
        throw new HttpError(404, 'session-not-found', `session "${sessionId}" is not available to this caller`)
      }
    },
  }
  registerRoutes(ctx, {
    gateway,
    credentials: [{ appId: 'platform', appKey }],
    headers: DEFAULT_HEADERS,
    requireUser: true,
    sessionStream: stream,
    ownership,
  })
  createSessionSocket(ctx, {
    gateway,
    sessionStream: stream,
    ownership,
    credentials: [{ appId: 'platform', appKey }],
    headers: DEFAULT_HEADERS,
    requireUser: true,
  })
  brain = await startBrainServer(ctx)
})

afterAll(async () => {
  for (const client of clients) client.close()
  stream.close()
  await brain.close()
})

async function connect(sessionId = 'sess-a', headers: Record<string, string> = auth): Promise<SessionSocketClient> {
  const client = await openSessionSocket(brain.baseUrl, sessionId, { headers })
  clients.push(client)
  return client
}

interface Waterfall {
  requestId: string
  [key: string]: unknown
}

function waterfall(
  name: string,
  request: unknown,
  fallback: () => Promise<unknown>,
): Promise<unknown> {
  return (ctx as unknown as {
    waterfall(name: string, request: unknown, fallback: () => Promise<unknown>): Promise<unknown>
  }).waterfall(name, request, fallback)
}

describe('脑侧会话 socket', () => {
  it('缺应用凭据时握手 401', async () => {
    await expect(openSessionSocket(brain.baseUrl, 'sess-a')).rejects.toThrow(/401/)
  })

  it('缺 sessionid 头时握手 400', async () => {
    await expect(openSessionSocket(brain.baseUrl, '', { headers: auth })).rejects.toThrow(/400/)
  })

  it('归属校验先于 socket：别人的会话 404', async () => {
    await expect(
      openSessionSocket(brain.baseUrl, 'sess-a', { headers: { ...auth, 'x-dsh-user-id': 'u2' } }),
    ).rejects.toThrow(/404/)
  })

  it('未知会话 404', async () => {
    await expect(openSessionSocket(brain.baseUrl, 'sess-zzz', { headers: auth })).rejects.toThrow(/404/)
  })

  it('下行帧与 SSE 一致：ready 之后是当前驱动状态', async () => {
    const client = await connect()
    const ready = await client.waitFor(frame => frame.type === 'ready')
    const status = await client.waitFor(frame => frame.type === 'status')
    expect(ready).toMatchObject({ type: 'ready', sessionId: 'sess-a' })
    expect(status).toMatchObject({ type: 'status', running: false })
    expect(client.frames.indexOf(ready)).toBeLessThan(client.frames.indexOf(status))
    client.close()
    await client.closed
  })

  it('事件按会话下发', async () => {
    const client = await connect()
    await client.waitFor(frame => frame.type === 'ready')
    gateway.append('sess-a', 'user', { text: '在吗' })
    const frame = await client.waitFor(frame => frame.type === 'event')
    expect(frame).toMatchObject({ type: 'event', event: { type: 'user', data: { text: '在吗' } } })
  })

  it('带内答复结算审批并回 ack', async () => {
    const client = await connect()
    await client.waitFor(frame => frame.type === 'ready')
    const answered = waterfall(
      'approval/request',
      { agent: { session: { id: 'sess-a' } }, toolName: 'bash' },
      async () => 'unavailable',
    )
    const pending = await client.waitFor(frame => frame.type === 'waterfall') as Waterfall
    const ack = await client.answer(pending.requestId, { kind: 'result', value: 'allowed-once' })
    expect(ack).toMatchObject({ type: 'ack', requestId: pending.requestId })
    await expect(answered).resolves.toBe('allowed-once')
    await client.waitFor(frame => frame.type === 'cancel' && frame.requestId === pending.requestId)
  })

  it('未知 requestId 回 answer-error，不结算任何待答请求', async () => {
    const client = await connect()
    await client.waitFor(frame => frame.type === 'ready')
    const error = await client.answer('missing-request', { kind: 'result', value: 'approved' })
    expect(error).toMatchObject({ type: 'answer-error', requestId: 'missing-request', code: 'session/mismatch' })
  })

  it('畸形答复形状回 invalid-answer', async () => {
    const client = await connect()
    await client.waitFor(frame => frame.type === 'ready')
    const error = await client.answer('whatever', { kind: 'approved' })
    expect(error).toMatchObject({ type: 'answer-error', requestId: 'whatever', code: 'invalid-answer' })
  })

  it('答不到别的会话的待答请求', async () => {
    const owner = await connect('sess-a')
    await owner.waitFor(frame => frame.type === 'ready')
    const answered = waterfall(
      'approval/request',
      { agent: { session: { id: 'sess-a' } }, toolName: 'write' },
      async () => 'unavailable',
    )
    const pending = await owner.waitFor(frame => frame.type === 'waterfall') as Waterfall

    const intruder = await connect('sess-b')
    await intruder.waitFor(frame => frame.type === 'ready')
    const error = await intruder.answer(pending.requestId, { kind: 'result', value: 'approved' })
    expect(error).toMatchObject({ type: 'answer-error', code: 'session/mismatch' })

    const ack = await owner.answer(pending.requestId, { kind: 'result', value: 'approved' })
    expect(ack).toMatchObject({ type: 'ack', requestId: pending.requestId })
    await expect(answered).resolves.toBe('allowed-once')
  })

  it('断线重连先重放未答复的审批请求', async () => {
    const first = await connect()
    await first.waitFor(frame => frame.type === 'ready')
    const answered = waterfall(
      'approval/request',
      { agent: { session: { id: 'sess-a' } }, toolName: 'bash' },
      async () => 'unavailable',
    )
    const original = await first.waitFor(frame => frame.type === 'waterfall') as Waterfall
    first.close()
    await first.closed

    const second = await connect()
    const ready = await second.waitFor(frame => frame.type === 'ready')
    expect(ready.type).toBe('ready')
    const replayed = await second.waitFor(frame => frame.type === 'waterfall') as Waterfall
    expect(replayed.requestId).toBe(original.requestId)
    const ack = await second.answer(replayed.requestId, { kind: 'result', value: 'approved' })
    expect(ack).toMatchObject({ type: 'ack', requestId: original.requestId })
    await expect(answered).resolves.toBe('allowed-once')
  })
})