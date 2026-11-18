import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, WebFetchLimiter, type LimiterConfig } from '../../packages/dsh-web-limiter/src/index.ts'
import { testContext } from '../helpers/brain.ts'

/**
 * web_fetch 并发闸门：全局 + 每用户上限，排队超时降级为 WEB_FETCH_BUSY。
 *
 * 限流是租户隔离的一部分：一个用户不能用 web_fetch 占满整个部署的出口，
 * 子代理也不能通过换会话 id 绕过每用户配额。
 */

interface Result {
  isError?: boolean
  content: Array<{ type: string; text: string }>
  error?: { info: { code: string } }
}

interface Exec {
  name: string
  signal: AbortSignal
  agent?: { session: { id: string } }
}

function limiter(overrides: Partial<LimiterConfig> = {}) {
  return new WebFetchLimiter({ maxGlobal: 4, maxPerUser: 2, maxQueue: 32, queueMs: 10_000, ...overrides })
}

const signal = () => new AbortController().signal

function dispatch(ctx: Context, exec: Exec, next: () => Promise<Result>): Promise<Result> {
  const waterfall = ctx as unknown as {
    waterfall(event: string, payload: unknown, next: () => unknown): Promise<unknown>
  }
  return waterfall.waterfall('tools/execute', exec, next) as Promise<Result>
}

function exec(name: string, sessionId: string, controller = new AbortController()): Exec {
  return { name, signal: controller.signal, agent: { session: { id: sessionId } } }
}

function gate() {
  let open!: () => void
  const promise = new Promise<Result>((resolve) => {
    open = () => resolve({ content: [{ type: 'text', text: 'done' }] })
  })
  return { promise, open }
}

const ok = (text: string): Result => ({ content: [{ type: 'text', text }] })

describe('WebFetchLimiter：直接语义', () => {
  it('空位内取到槽，release 归还', async () => {
    const l = limiter()
    expect(await l.acquire('u', signal())).toBe(true)
    expect(l.active).toBe(1)
    l.release('u')
    expect(l.active).toBe(0)
  })

  it('全局到顶后排队，释放一个槽就按 FIFO 放行', async () => {
    const l = limiter({ maxGlobal: 1, maxPerUser: 5 })
    expect(await l.acquire('u', signal())).toBe(true)
    const waiting = l.acquire('v', signal())
    expect(l.waiting).toBe(1)
    l.release('u')
    await expect(waiting).resolves.toBe(true)
    expect(l.active).toBe(1)
  })

  it('每用户到顶时跳过该用户，让其他用户可以继续', async () => {
    const l = limiter({ maxGlobal: 5, maxPerUser: 1 })
    expect(await l.acquire('u', signal())).toBe(true)
    const blocked = l.acquire('u', signal())
    expect(await l.acquire('v', signal())).toBe(true)
    expect(l.waiting).toBe(1)
    l.release('u')
    await expect(blocked).resolves.toBe(true)
  })

  it('队列满时新调用立即失败', async () => {
    const l = limiter({ maxGlobal: 1, maxPerUser: 1, maxQueue: 1 })
    expect(await l.acquire('u', signal())).toBe(true)
    const queued = l.acquire('v', signal())
    expect(await l.acquire('w', signal())).toBe(false)
    l.close()
    await expect(queued).resolves.toBe(false)
  })

  it('排队超时后拒绝', async () => {
    const l = limiter({ maxGlobal: 1, maxPerUser: 1, queueMs: 25 })
    expect(await l.acquire('u', signal())).toBe(true)
    const started = Date.now()
    expect(await l.acquire('v', signal())).toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  })

  it('等待中取消立即拒绝，并从队列移除', async () => {
    const l = limiter({ maxGlobal: 1, maxPerUser: 1 })
    expect(await l.acquire('u', signal())).toBe(true)
    const controller = new AbortController()
    const waiting = l.acquire('v', controller.signal)
    expect(l.waiting).toBe(1)
    controller.abort()
    await expect(waiting).resolves.toBe(false)
    expect(l.waiting).toBe(0)
  })

  it('close 拒绝所有等待者', async () => {
    const l = limiter({ maxGlobal: 1, maxPerUser: 1 })
    expect(await l.acquire('u', signal())).toBe(true)
    const waiting = l.acquire('v', signal())
    l.close()
    await expect(waiting).resolves.toBe(false)
  })
})

describe('web-limiter：tools/execute 包装', () => {
  it('配置非法时装配即失败', () => {
    expect(() => apply(testContext({}), { maxGlobal: 0 })).toThrow(/maxGlobal/)
    expect(() => apply(testContext({}), { tools: [] })).toThrow(/tools/)
  })

  it('不在名单里的工具完全绕过限流', async () => {
    const ctx = testContext({})
    apply(ctx, { maxGlobal: 1, maxPerUser: 1, queueMs: 20 })
    const held = gate()
    const first = dispatch(ctx, exec('web_fetch', 's1'), () => held.promise)
    // 全局已占满，但 bash 不在名单内。
    await expect(dispatch(ctx, exec('bash', 's2'), async () => ok('ran'))).resolves.toEqual(ok('ran'))
    held.open()
    await first
  })

  it('抢不到槽时返回 WEB_FETCH_BUSY 结构化失败，不触网', async () => {
    const ctx = testContext({})
    apply(ctx, { maxGlobal: 1, maxPerUser: 1, queueMs: 20 })
    const held = gate()
    const first = dispatch(ctx, exec('web_fetch', 's1'), () => held.promise)

    let reached = false
    const second = await dispatch(ctx, exec('web_fetch', 's2'), async () => {
      reached = true
      return ok('network')
    })

    expect(reached).toBe(false)
    expect(second.isError).toBe(true)
    expect(second.error?.info.code).toBe('WEB_FETCH_BUSY')

    held.open()
    await first
  })

  it('调用结束（含抛错）后归还槽，后续调用可继续', async () => {
    const ctx = testContext({})
    apply(ctx, { maxGlobal: 1, maxPerUser: 1, queueMs: 20 })

    await expect(
      dispatch(ctx, exec('web_fetch', 's1'), async () => {
        throw new Error('network down')
      }),
    ).rejects.toThrow('network down')

    // 槽已归还，下一次不应 BUSY。
    await expect(dispatch(ctx, exec('web_fetch', 's2'), async () => ok('again'))).resolves.toEqual(ok('again'))
  })

  it('每用户配额按 sessionDirectory 的 owner 计，子代理继承祖先用户', async () => {
    const owners = new Map([
      ['parent', { userId: 'u1' }],
      ['other', { userId: 'u2' }],
    ])
    const ctx = testContext({
      sessionDirectory: { owner: async (id: string) => owners.get(id) },
      agents: {
        get: (id: string) =>
          id === 'child' ? { session: { header: { parentSession: 'parent' } } } : undefined,
      },
    })
    apply(ctx, { maxGlobal: 4, maxPerUser: 1, queueMs: 20 })

    const held = gate()
    const first = dispatch(ctx, exec('web_fetch', 'parent'), () => held.promise)

    // 子代理也落在 u1 的配额里，必须被挡。
    const child = await dispatch(ctx, exec('web_fetch', 'child'), async () => ok('child'))
    expect(child.error?.info.code).toBe('WEB_FETCH_BUSY')

    // 别的用户不受影响。
    await expect(dispatch(ctx, exec('web_fetch', 'other'), async () => ok('other'))).resolves.toEqual(ok('other'))

    held.open()
    await first
  })

  it('没有 sessionDirectory 时按会话 id 计', async () => {
    const ctx = testContext({})
    apply(ctx, { maxGlobal: 1, maxPerUser: 1, queueMs: 20 })
    const held = gate()
    const first = dispatch(ctx, exec('web_fetch', 'sess-a'), () => held.promise)

    const second = await dispatch(ctx, exec('web_fetch', 'sess-b'), async () => ok('b'))
    expect(second.error?.info.code).toBe('WEB_FETCH_BUSY')

    held.open()
    await first
  })
})
