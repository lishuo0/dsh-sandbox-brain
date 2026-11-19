import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../../packages/dsh-platform-api/src/index.ts'
import { PREFIX } from '../../packages/dsh-platform-api/src/routes.ts'
import { auditUpgradeRoutes } from '../../packages/dsh-platform-api/src/session-stream.ts'
import { SESSION_SOCKET_PATH } from '../../packages/dsh-platform-api/src/session-socket.ts'
import {
  call,
  FakeWebServer,
  openSessionSocket,
  openSessionStream,
  startBrainServer,
  testContext,
  type BrainServer,
} from '../helpers/brain.ts'

/**
 * 会话流的装配层：真实 `apply()` + 真实 HTTP/Upgrade。
 *
 * 这里验的是插件接线，不重复集成测试里的协议细节：
 * apply() 之后没有任何 Upgrade 路由；创建出来的会话能建立 SSE 流；归属
 * 校验在建立流之前生效；进程内的 durable 事件、Agent 状态与流式帧按会话下发。
 */

const appKey = 'p'.repeat(24)
const auth = { 'x-app-id': 'platform', 'x-app-key': appKey, 'x-dsh-user-id': 'u1' }
const modelHeaders = {
  'x-dsh-model-key': 'sk-session-key',
  'x-dsh-model-base-url': 'https://api.example.com/v1',
}

interface FakeSession {
  id: string
  seq: number
  eventAt(seq: number): unknown
}

interface FakeAgent {
  session: FakeSession
  followup(message: unknown): void
  cancel(reason: unknown, options?: unknown): void
  model: { select(selection: unknown): void }
}

const agents = new Map<string, FakeAgent>()
const owners = new Map<string, string>()
let brain: BrainServer
let ctx: Context

/** 每个会话一个假 Agent；只记录调用，验证的是编排。 */
function makeAgent(id: string): FakeAgent {
  return {
    session: { id, seq: 0, eventAt: () => undefined },
    followup: () => undefined,
    cancel: () => undefined,
    model: { select: () => undefined },
  }
}

beforeAll(async () => {
  ctx = testContext({
    webServer: new FakeWebServer(),
    agents: {
      get: (id: string) => agents.get(id),
      create: async ({ sessionId }: { sessionId: string }) => {
        const agent = makeAgent(sessionId)
        agents.set(sessionId, agent)
        return { agent, dispose: async () => agents.delete(sessionId) }
      },
      resume: async ({ resumeSessionId }: { resumeSessionId: string }) => {
        const agent = makeAgent(resumeSessionId)
        agents.set(resumeSessionId, agent)
        return { agent, dispose: async () => agents.delete(resumeSessionId) }
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'user', model: 'deepseek-chat' }),
    },
    db: {
      async query(_text: string, params: readonly unknown[]) {
        const owner = owners.get(String(params[0]))
        return owner === undefined ? [] : [{ user_id: owner }]
      },
    },
  })
  apply(ctx, { apps: [{ appId: 'platform', appKey, name: 'Agent 平台' }] })
  brain = await startBrainServer(ctx)
})

afterAll(async () => {
  await brain.close()
})

async function createSession(): Promise<string> {
  const response = await call(brain.baseUrl, PREFIX, {
    method: 'POST',
    headers: { ...auth, ...modelHeaders },
    body: { cwd: '/desk' },
  })
  expect(response.status).toBe(201)
  const sessionId = (response.json() as { sessionId: string }).sessionId
  owners.set(sessionId, 'u1')
  return sessionId
}

describe('会话流的装配', () => {
  it('apply() 之后唯一一条 Upgrade 路由是会话 socket', () => {
    expect(auditUpgradeRoutes(brain.web, [SESSION_SOCKET_PATH])).toEqual([SESSION_SOCKET_PATH])
    expect([...brain.web.upgrades.keys()]).toEqual([SESSION_SOCKET_PATH])
  })

  it('创建会话后可以建立 SSE 流，并收到 ready 首帧', async () => {
    const sessionId = await createSession()
    const client = await openSessionStream(brain.baseUrl, sessionId, { headers: auth })
    const ready = await client.waitFor(frame => frame.type === 'ready')
    expect(ready).toMatchObject({ type: 'ready', sessionId, seq: -1 })
    client.close()
    await client.closed
  })

  it('ready 之后先下发一帧当前驱动状态', async () => {
    const sessionId = await createSession()
    const client = await openSessionStream(brain.baseUrl, sessionId, { headers: auth })
    const ready = await client.waitFor(frame => frame.type === 'ready')
    const status = await client.waitFor(frame => frame.type === 'status')
    expect(ready).toMatchObject({ type: 'ready', sessionId })
    expect(status).toMatchObject({ type: 'status', running: false })
    expect(client.frames.indexOf(ready)).toBeLessThan(client.frames.indexOf(status))
    client.close()
    await client.closed
  })

  it('建立流之前按平台用户校验归属，别人的会话 404', async () => {
    const sessionId = await createSession()
    await expect(
      openSessionStream(brain.baseUrl, sessionId, {
        headers: { ...auth, 'x-dsh-user-id': 'u2' },
      }),
    ).rejects.toThrow(/404/)
  })

  it('durable 事件、Agent 状态与流式帧按会话下发', async () => {
    const sessionId = await createSession()
    const client = await openSessionStream(brain.baseUrl, sessionId, { headers: auth })
    await client.waitFor(frame => frame.type === 'ready')
    const agent = agents.get(sessionId) as FakeAgent
    const emit = (ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit.bind(ctx)
    emit('agent/status', { agent, status: 'running' })
    emit('session/event', agent.session, { seq: 0, type: 'user', data: { text: '你好' } })
    emit('agent/assistant-stream', { agent, frame: { delta: '你' } })

    const status = await client.waitFor(frame => frame.type === 'status' && frame.running === true)
    expect(status).toMatchObject({ type: 'status', running: true })
    const event = await client.waitFor(frame => frame.type === 'event')
    expect(event).toMatchObject({ type: 'event', seq: 0, event: { type: 'user', data: { text: '你好' } } })
    const stream = await client.waitFor(frame => frame.type === 'stream')
    expect(stream).toMatchObject({ type: 'stream', frame: { delta: '你' } })
    client.close()
    await client.closed
  })

  it('创建会话后可以建立会话 socket，帧集与 SSE 相同', async () => {
    const sessionId = await createSession()
    const client = await openSessionSocket(brain.baseUrl, sessionId, { headers: auth })
    const ready = await client.waitFor(frame => frame.type === 'ready')
    const status = await client.waitFor(frame => frame.type === 'status')
    expect(ready).toMatchObject({ type: 'ready', sessionId })
    expect(status).toMatchObject({ type: 'status', running: false })
    client.close()
    await client.closed
  })

  it('socket 握手也按平台用户校验归属，别人的会话 404', async () => {
    const sessionId = await createSession()
    await expect(
      openSessionSocket(brain.baseUrl, sessionId, { headers: { ...auth, 'x-dsh-user-id': 'u2' } }),
    ).rejects.toThrow(/404/)
  })
})
