import { describe, expect, it } from 'vitest'
import { createGateway } from '../../packages/dsh-platform-api/src/gateway.ts'
import { HttpError } from '../../packages/dsh-platform-api/src/http.ts'
import { testContext } from '../helpers/brain.ts'

/**
 * 网关的两条原子动作：
 * 1. `prompt` 的 `mode` 是两种不同的 Agent 操作，不是同一个字段的两种写法。
 * 2. `fork` 复制脑里的会话日志，委托给 sessionController，并把它的错误码
 *    翻译成脑对外文档里的 HTTP 错误码。
 */

interface FakeAgent {
  readonly session: { readonly id: string }
  readonly followups: unknown[]
  readonly steers: unknown[]
  followup(message: unknown): void
  steer(message: unknown): void
}

function fakeAgent(id: string): FakeAgent {
  return {
    session: { id },
    followups: [],
    steers: [],
    followup(message) {
      this.followups.push(message)
    },
    steer(message) {
      this.steers.push(message)
    },
  }
}

function fakeAgents(...list: FakeAgent[]) {
  const byId = new Map(list.map(agent => [agent.session.id, agent]))
  return { get: (id: string) => byId.get(id) }
}

function statusOf(run: () => Promise<unknown>): Promise<{ status: number; code: unknown }> {
  return run().then(
    () => {
      throw new Error('expected the call to throw')
    },
    (error: unknown) => {
      if (!(error instanceof HttpError)) throw error
      return { status: error.status, code: (error as unknown as { code: unknown }).code }
    },
  )
}

describe('gateway.prompt 的两种模式', () => {
  it('省略 mode 时排到下一回合（followup）', async () => {
    const agent = fakeAgent('prompt-default')
    const gateway = createGateway(testContext({ agents: fakeAgents(agent) }))
    await gateway.prompt('prompt-default', 'hello', 'r-default')
    expect(agent.followups).toHaveLength(1)
    expect(agent.steers).toHaveLength(0)
  })

  it("mode: 'queue' 也是 followup", async () => {
    const agent = fakeAgent('prompt-queue')
    const gateway = createGateway(testContext({ agents: fakeAgents(agent) }))
    await gateway.prompt('prompt-queue', 'hello', 'r-queue', 'queue')
    expect(agent.followups).toHaveLength(1)
  })

  it("mode: 'steer' 并入当前回合（steer），不是 followup", async () => {
    const agent = fakeAgent('prompt-steer')
    const gateway = createGateway(testContext({ agents: fakeAgents(agent) }))
    await gateway.prompt('prompt-steer', 'pivot', 'r-steer', 'steer')
    expect(agent.steers).toHaveLength(1)
    expect(agent.followups).toHaveLength(0)
  })

  it('同一个 requestId 只入队一次', async () => {
    const agent = fakeAgent('prompt-dup')
    const gateway = createGateway(testContext({ agents: fakeAgents(agent) }))
    await gateway.prompt('prompt-dup', 'hello', 'r-dup')
    await gateway.prompt('prompt-dup', 'hello again', 'r-dup')
    expect(agent.followups).toHaveLength(1)
  })

  it('会话不在本副本时 Prompt 404', async () => {
    const gateway = createGateway(testContext({ agents: fakeAgents() }))
    expect(await statusOf(() => gateway.prompt('ghost', 'hi', 'r1'))).toEqual({
      status: 404,
      code: 'session-not-found',
    })
  })
})

describe('gateway.fork', () => {
  it('委托 sessionController.fork 并回新会话 id', async () => {
    const calls: unknown[] = []
    const gateway = createGateway(testContext({
      sessionController: {
        async fork(request: unknown) {
          calls.push(request)
          return { sessionId: 'session-child' }
        },
      },
    }))
    expect(await gateway.fork?.('session-parent', { atSeq: 9 })).toEqual({ sessionId: 'session-child' })
    expect(calls).toEqual([{ sessionId: 'session-parent', atSeq: 9 }])
  })

  it('没有组合分叉能力时 501', async () => {
    const gateway = createGateway(testContext({}))
    expect(await statusOf(() => gateway.fork!('s1', {}))).toEqual({ status: 501, code: 'not-supported' })
  })

  it('源会话取不到日志时 404', async () => {
    const gateway = createGateway(testContext({
      sessionController: {
        async fork() {
          throw Object.assign(new Error('no log'), { code: 'session/not-found' })
        },
      },
    }))
    expect(await statusOf(() => gateway.fork!('s1', {}))).toEqual({ status: 404, code: 'session-not-found' })
  })

  it('不能分叉时 409 fork-unavailable', async () => {
    const gateway = createGateway(testContext({
      sessionController: {
        async fork() {
          throw Object.assign(new Error('nope'), { code: 'session/fork-unavailable' })
        },
      },
    }))
    expect(await statusOf(() => gateway.fork!('s1', {}))).toEqual({ status: 409, code: 'fork-unavailable' })
  })

  it('内部失败时 500 fork-failed', async () => {
    const gateway = createGateway(testContext({
      sessionController: {
        async fork() {
          throw new Error('boom')
        },
      },
    }))
    expect(await statusOf(() => gateway.fork!('s1', {}))).toEqual({ status: 500, code: 'fork-failed' })
  })
})
