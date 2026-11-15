/**
 * Concurrency limit for `web_fetch` tool calls.
 *
 * `web_fetch` runs on the brain and shares its memory, CPU, and egress. Without
 * a limit, one tenant can occupy all of them. This plugin wraps the
 * `tools/execute` waterfall: a call waits for a slot, and a call that cannot
 * get one within `queueMs` returns a structured `WEB_FETCH_BUSY` result
 * instead of reaching the network.
 *
 * Limits are per user when the session directory is mounted (session id
 * otherwise), plus a deployment-wide cap.
 *
 * @module @brain/dsh-web-limiter
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-limiter'

/** The tool registry whose `tools/execute` waterfall this plugin wraps. */
export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /** Maximum concurrent calls across the deployment. */
  readonly maxGlobal?: number
  /** Maximum concurrent calls for one user (or one session without a directory). */
  readonly maxPerUser?: number
  /** Maximum waiting calls before new calls fail fast. */
  readonly maxQueue?: number
  /** How long a call may wait for a slot before failing. */
  readonly queueMs?: number
  /** Tool names to limit. Defaults to `web_fetch`. */
  readonly tools?: readonly string[]
}

/** Fully resolved configuration. */
export interface LimiterConfig {
  readonly maxGlobal: number
  readonly maxPerUser: number
  readonly maxQueue: number
  readonly queueMs: number
}

/** One call waiting for a slot. */
interface Waiter {
  readonly user: string
  readonly signal: AbortSignal
  readonly grant: () => void
  readonly deny: () => void
  readonly onAbort: () => void
  timer?: ReturnType<typeof setTimeout>
}

/**
 * A FIFO semaphore with a global cap and a per-user cap.
 *
 * A waiter whose user is at its cap is skipped so other users can proceed; the
 * skipped waiter stays queued until its user frees a slot or its deadline
 * passes.
 */
export class WebFetchLimiter {
  private global = 0
  private readonly perUser = new Map<string, number>()
  private readonly queue: Waiter[] = []

  constructor(private readonly config: LimiterConfig) {}

  /**
   * Try to take one slot.
   * @param user - limit key (user id, or session id without a directory).
   * @param signal - caller cancellation; an aborted wait denies immediately.
   * @returns true when a slot was granted and the caller must {@link release}.
   */
  async acquire(user: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false
    const active = this.perUser.get(user) ?? 0
    if (this.global < this.config.maxGlobal && active < this.config.maxPerUser) {
      this.take(user)
      return true
    }
    if (this.queue.length >= this.config.maxQueue) return false
    return await new Promise<boolean>(resolve => {
      let waiter!: Waiter
      waiter = {
        user,
        signal,
        grant: () => resolve(true),
        deny: () => resolve(false),
        onAbort: () => this.settle(waiter, false),
      }
      waiter.timer = setTimeout(() => this.settle(waiter, false), this.config.queueMs)
      waiter.timer.unref?.()
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.queue.push(waiter)
      this.drain()
    })
  }

  /**
   * Release one slot previously granted to `user`.
   * @param user - the same key passed to {@link acquire}.
   */
  release(user: string): void {
    const active = this.perUser.get(user) ?? 0
    if (active <= 1) this.perUser.delete(user)
    else this.perUser.set(user, active - 1)
    if (this.global > 0) this.global -= 1
    this.drain()
  }

  /** Deny every waiter and stop accepting new work. */
  close(): void {
    for (const waiter of [...this.queue]) this.settle(waiter, false)
  }

  /** The number of calls currently holding a slot. */
  get active(): number {
    return this.global
  }

  /** The number of calls waiting for a slot. */
  get waiting(): number {
    return this.queue.length
  }

  private take(user: string): void {
    this.global += 1
    this.perUser.set(user, (this.perUser.get(user) ?? 0) + 1)
  }

  private settle(waiter: Waiter, granted: boolean): void {
    const index = this.queue.indexOf(waiter)
    if (index === -1) return
    this.queue.splice(index, 1)
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    waiter.signal.removeEventListener('abort', waiter.onAbort)
    if (!granted) {
      waiter.deny()
      return
    }
    this.take(waiter.user)
    waiter.grant()
  }

  private drain(): void {
    while (this.global < this.config.maxGlobal) {
      const index = this.queue.findIndex(waiter => (this.perUser.get(waiter.user) ?? 0) < this.config.maxPerUser)
      if (index === -1) return
      this.settle(this.queue[index] as Waiter, true)
    }
  }
}

/**
 * Register the limiter.
 * @param ctx - plugin context; the listener is effect-scoped.
 * @param config - caps and the tool names to limit.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const limiter = new WebFetchLimiter(resolved)

  ctx.on('tools/execute', async (exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
    if (!resolved.tools.includes(exec.name)) return next()
    const user = await userKey(ctx, exec)
    const granted = await limiter.acquire(user, exec.signal)
    if (!granted) return busyResult(exec.name)
    try {
      return await next()
    } finally {
      limiter.release(user)
    }
  })

  ctx.effect(() => () => limiter.close(), 'web-limiter: waiters')
}

/** Validate and default the configuration. */
function resolveConfig(config: Config): LimiterConfig & { readonly tools: readonly string[] } {
  const positive = (value: number | undefined, fallback: number, name: string): number => {
    const resolved = value ?? fallback
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
      throw new Error(`web-limiter: ${name} must be a positive safe integer`)
    }
    return resolved
  }
  const tools = config.tools ?? ['web_fetch']
  if (!Array.isArray(tools) || tools.length === 0 || tools.some(tool => typeof tool !== 'string' || tool === '')) {
    throw new Error('web-limiter: tools must be a non-empty array of tool names')
  }
  return {
    maxGlobal: positive(config.maxGlobal, 4, 'maxGlobal'),
    maxPerUser: positive(config.maxPerUser, 2, 'maxPerUser'),
    maxQueue: positive(config.maxQueue, 32, 'maxQueue'),
    queueMs: positive(config.queueMs, 10_000, 'queueMs'),
    tools,
  }
}

/** How many parent links one lookup follows before giving up. */
const MAX_LINEAGE_DEPTH = 16

/**
 * Resolve the limit key: the user when the directory is mounted, else the
 * session.
 *
 * A subagent has no platform session row, so the directory cannot answer for
 * it. Walking `header.parentSession` finds the nearest ancestor the platform
 * owns; without that, every child would get its own per-user budget and could
 * bypass the cap by spawning subagents.
 */
async function userKey(ctx: Context, exec: ToolDispatchExecution): Promise<string> {
  const sessionId = exec.agent === undefined ? 'anonymous' : String(exec.agent.session.id)
  const directory = ctx.get('sessionDirectory') as
    | { owner(id: string): Promise<{ userId: string } | undefined> }
    | undefined
  if (directory === undefined) return sessionId

  const agents = ctx.get('agents') as
    | { get(id: string): { session?: { header?: { parentSession?: unknown } } } | undefined }
    | undefined
  const seen = new Set<string>()
  let id = sessionId
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
    if (seen.has(id)) break
    seen.add(id)
    try {
      const owner = await directory.owner(id)
      if (owner !== undefined) return owner.userId
    } catch {
      return sessionId
    }
    let parent: unknown
    try {
      parent = agents?.get(id)?.session?.header?.parentSession
    } catch {
      break
    }
    if (parent === undefined || parent === null || String(parent) === '') break
    id = String(parent)
  }
  return sessionId
}

/** The structured result returned when no slot is available. */
function busyResult(tool: string): ToolExecutionResult {
  const message = `${tool} is busy: too many concurrent requests; retry shortly`
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: { message, info: { name: 'WebFetchBusyError', code: 'WEB_FETCH_BUSY' } },
  }
}
