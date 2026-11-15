/**
 * Hard tool-call cancellation.
 *
 * `@deepseek-ai/dsh-tool-call-timeout-policy` is cooperative: it arms a
 * deadline on `exec.signal` and then still awaits the tool, relying on the tool
 * to honour the signal. A tool that ignores it keeps the step — and the whole
 * turn — open forever, which is how one `bash` call can leave a session
 * "running" after the process itself is gone.
 *
 * This wrapper settles the dispatch instead. Whatever `next()` eventually does,
 * a cancelled or expired call returns a structured failure the agent loop can
 * write as `tool/result`, so `step/end` and `turn/end` can follow.
 *
 * @module @brain/dsh-tool-abort-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Plugin name used by loader diagnostics. */
export const name = 'tool-abort-policy'

/** The tool registry this plugin wraps (`tools/execute`). */
export const inject = ['tools']

/** Code carried by the structured failure when the caller cancelled. */
export const TOOL_ABORTED = 'TOOL_ABORTED'

/** Code carried by the structured failure when the deadline expired. */
export const TOOL_TIMEOUT = 'TOOL_TIMEOUT'

/** Configuration. */
export interface Config {
  /**
   * How long a cancelled tool may still finish on its own before the wrapper
   * settles the call anyway.
   *
   * Zero settles immediately, which is what makes the wrapper useful: waiting
   * is exactly what a tool that ignores its signal does not stop doing.
   */
  readonly abortGraceMs?: number
}

/** Build the structured failure the agent loop records as a tool result. */
function failure(code: string, message: string): ToolExecutionResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: {
      message,
      info: {
        name: code === TOOL_TIMEOUT ? 'ToolTimeoutError' : 'ToolAbortError',
        code,
      },
    },
  }
}

/** Abort reason carried by a timeout when one is present. */
function timeoutOf(reason: unknown): { code?: unknown; timeoutMs?: unknown } | undefined {
  return typeof reason === 'object' && reason !== null
    ? (reason as { code?: unknown; timeoutMs?: unknown })
    : undefined
}

/**
 * Register the hard-abort wrapper.
 *
 * The race is between three outcomes: the real dispatch, the caller's abort,
 * and this wrapper's own deadline. A dispatch that loses the race keeps running
 * but its rejection is absorbed, so abandoning it never surfaces as an
 * unhandled rejection.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const abortGraceMs = config.abortGraceMs ?? 0
  const tools = (ctx as unknown as {
    tools?: { get(name: string, agent?: unknown): { timeoutMs?: number } | undefined }
  }).tools

  ctx.on('tools/execute', async (
    exec: ToolDispatchExecution,
    next: () => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> => {
    const signal = exec.signal
    if (signal === undefined) return await next()

    const declared = tools?.get(exec.name, exec.agent)?.timeoutMs
    const deadlineMs = typeof declared === 'number' && declared > 0 ? declared : undefined

    // The dispatch is always observed, so a late rejection is never unhandled.
    const dispatched = next().then(
      value => ({ kind: 'result' as const, value }),
      error => ({ kind: 'error' as const, error }),
    )
    let settleAbort!: (result: ToolExecutionResult) => void
    const aborted = new Promise<{ kind: 'abort'; result: ToolExecutionResult }>(resolve => {
      settleAbort = result => resolve({ kind: 'abort', result })
    })

    let armed = false
    let graceTimer: NodeJS.Timeout | undefined
    let deadlineTimer: NodeJS.Timeout | undefined
    const arm = (): void => {
      if (armed) return
      armed = true
      const reason = timeoutOf(signal.reason)
      const timedOut = reason?.code === TOOL_TIMEOUT
      ;(ctx as unknown as { logger?: { warn?(message: string): void } }).logger?.warn?.(
        timedOut
          ? `tool-abort-policy: tool "${exec.name}" timed out; settling the call`
          : `tool-abort-policy: tool "${exec.name}" aborted; settling the call`,
      )
      const result = timedOut
        ? failure(TOOL_TIMEOUT, `tool call timed out${deadlineMs === undefined ? '' : ` after ${deadlineMs}ms`}`)
        : failure(TOOL_ABORTED, 'tool call aborted')
      if (abortGraceMs <= 0) {
        settleAbort(result)
        return
      }
      graceTimer = setTimeout(() => settleAbort(result), abortGraceMs)
      graceTimer.unref?.()
    }

    if (signal.aborted) arm()
    else signal.addEventListener('abort', arm, { once: true })

    // The cooperative timeout policy may already have replaced `exec.signal`;
    // arming this timer keeps the bound working regardless of wrapper order.
    if (deadlineMs !== undefined && !signal.aborted) {
      deadlineTimer = setTimeout(
        () => settleAbort(failure(TOOL_TIMEOUT, `tool call timed out after ${deadlineMs}ms`)),
        deadlineMs,
      )
      deadlineTimer.unref?.()
    }

    try {
      const winner = await Promise.race([dispatched, aborted])
      if (winner.kind === 'result') return winner.value
      if (winner.kind === 'error') throw winner.error
      return winner.result
    } finally {
      signal.removeEventListener('abort', arm)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    }
  })
}
