import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createGateway, jobError } from '../../packages/dsh-platform-api/src/gateway.ts'
import { testContext } from '../helpers/brain.ts'

/**
 * 取消收敛与卡死看门狗。
 *
 * 两条契约：
 * 1. `cancel` 不要求活 Agent——副本重启后残留的 open turn 也要能被修掉。
 * 2. 没有任何一方取消时，一个长期没有进度的回合由看门狗强制收尾。
 */

interface FakeAgent {
  readonly session: { readonly id: string }
  cancels: Array<{ reason: unknown; options: unknown }>
  cancel(reason: unknown, options?: unknown): void
}

function fakeAgent(id: string): FakeAgent {
  return {
    session: { id },
    cancels: [],
    cancel(reason, options) {
      this.cancels.push({ reason, options })
    },
  }
}

function fakePersistence() {
  const closes: string[] = []
  return {
    closes,
    async flush() {},
    async forceCloseTurn(id: string) {
      closes.push(id)
      return { closed: true, events: 2 }
    },
  }
}

function fakeAgents(...list: FakeAgent[]) {
  const byId = new Map(list.map((agent) => [agent.session.id, agent]))
  return {
    byId,
    get: (id: string) => byId.get(id),
  }
}

function emit(ctx: Context, name: string, ...args: unknown[]): void {
  (ctx as unknown as { emit(event: string, ...rest: unknown[]): void }).emit(name, ...args)
}

function fakeJobs() {
  let listener: ((event: unknown) => void) | undefined
  return {
    events: {
      subscribe(_filter: unknown, next: (event: unknown) => void) {
        listener = next
        return () => {
          listener = undefined
        }
      },
    },
    push(event: unknown) {
      listener?.(event)
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('gateway.cancel', () => {
  it('没有活 Agent 时不回 404，直接对持久日志做强制收尾', async () => {
    const persistence = fakePersistence()
    const gateway = createGateway(testContext({ agents: fakeAgents(), sessionPersistence: persistence }))

    await gateway.cancel('session-ghost')

    expect(persistence.closes).toEqual(['session-ghost'])
  })

  it('有活 Agent 时取消回合、停会话活动、并保留收件箱', async () => {
    const agent = fakeAgent('session-live')
    const persistence = fakePersistence()
    const stopped: string[] = []
    const ctx = testContext({ agents: fakeAgents(agent), sessionPersistence: persistence })
    ctx.on('workspace/session-stop', (payload: { sessionId: string }) => {
      stopped.push(payload.sessionId)
    })
    const gateway = createGateway(ctx)

    await gateway.cancel('session-live')
    await vi.waitFor(() => expect(stopped).toEqual(['session-live']))

    expect(agent.cancels).toEqual([{ reason: { kind: 'user' }, options: { keepInbox: true } }])
    expect(persistence.closes).toEqual([])
  })
})

describe('回合看门狗', () => {
  it('running 且无进度超过预算后强制收尾', async () => {
    vi.useFakeTimers()
    const agent = fakeAgent('session-stall')
    const persistence = fakePersistence()
    const ctx = testContext({ agents: fakeAgents(agent), sessionPersistence: persistence })
    createGateway(ctx, { turnStallMs: 1_000 })

    emit(ctx, 'agent/status', { agent, status: 'running' })
    await vi.advanceTimersByTimeAsync(999)
    expect(persistence.closes).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(persistence.closes).toEqual(['session-stall'])
  })

  it('持久事件、模型流和该会话的后台任务输出都会重置预算', async () => {
    vi.useFakeTimers()
    const agent = fakeAgent('session-active')
    const persistence = fakePersistence()
    const jobs = fakeJobs()
    const ctx = testContext({ agents: fakeAgents(agent), sessionPersistence: persistence, jobs })
    createGateway(ctx, { turnStallMs: 1_000 })

    emit(ctx, 'agent/status', { agent, status: 'running' })

    await vi.advanceTimersByTimeAsync(700)
    emit(ctx, 'session/event', { id: 'session-active' }, { type: 'turn/start' })
    await vi.advanceTimersByTimeAsync(700)
    emit(ctx, 'agent/assistant-stream', { agent, frame: {} })
    await vi.advanceTimersByTimeAsync(700)
    jobs.push({ type: 'output', id: 'job-1', owner: 'session-active', total: 1 })

    // 三次进度各重置了一次，所以此刻仍不该收尾。
    expect(persistence.closes).toEqual([])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(persistence.closes).toEqual(['session-active'])
  })

  it('别家会话的任务输出不会重置这条回合的预算', async () => {
    vi.useFakeTimers()
    const agent = fakeAgent('session-a')
    const persistence = fakePersistence()
    const jobs = fakeJobs()
    const ctx = testContext({ agents: fakeAgents(agent), sessionPersistence: persistence, jobs })
    createGateway(ctx, { turnStallMs: 1_000 })

    emit(ctx, 'agent/status', { agent, status: 'running' })
    await vi.advanceTimersByTimeAsync(700)
    jobs.push({ type: 'output', id: 'job-x', owner: 'session-b', total: 1 })
    await vi.advanceTimersByTimeAsync(300)

    expect(persistence.closes).toEqual(['session-a'])
  })

  it('回合回到 idle 后清掉计时，不再收尾', async () => {
    vi.useFakeTimers()
    const agent = fakeAgent('session-idle')
    const persistence = fakePersistence()
    const ctx = testContext({ agents: fakeAgents(agent), sessionPersistence: persistence })
    createGateway(ctx, { turnStallMs: 1_000 })

    emit(ctx, 'agent/status', { agent, status: 'running' })
    await vi.advanceTimersByTimeAsync(500)
    emit(ctx, 'agent/status', { agent, status: 'idle' })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(persistence.closes).toEqual([])
  })

  it('turnStallMs: 0 时不装看门狗', async () => {
    vi.useFakeTimers()
    const agent = fakeAgent('session-off')
    const persistence = fakePersistence()
    const ctx = testContext({ agents: fakeAgents(agent), sessionPersistence: persistence })
    createGateway(ctx, { turnStallMs: 0 })

    emit(ctx, 'agent/status', { agent, status: 'running' })
    await vi.advanceTimersByTimeAsync(60_000)

    expect(persistence.closes).toEqual([])
  })
})

describe('jobError 映射', () => {
  it('按 JobError.code 判断可见性，而不是猜错误文本', () => {
    const missing = Object.assign(new Error('gone'), { code: 'JOB_NOT_FOUND' })
    const foreign = Object.assign(new Error('gone'), { code: 'JOB_FOREIGN_SESSION' })
    expect(jobError(missing, 's1', 'job-1')).toMatchObject({ status: 404, code: 'job-not-found' })
    expect(jobError(foreign, 's1', 'job-1')).toMatchObject({ status: 404, code: 'job-not-found' })
  })

  it('活着的 owner 丢失按 409，不误判成 not-found', () => {
    const dead = Object.assign(new Error('owner left'), { code: 'JOB_OWNER_NOT_LIVE' })
    expect(jobError(dead, 's1', 'job-1')).toMatchObject({ status: 409, code: 'job-owner-not-live' })
  })

  it('没有稳定错误码的旧注册表仍按文本兜底', () => {
    expect(jobError(new Error('job is not visible to this session'), 's1', 'job-1')).toMatchObject({ status: 404 })
  })
})
