import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  apply,
  TOOL_ABORTED,
  TOOL_TIMEOUT,
} from '../../packages/dsh-tool-abort-policy/src/index.ts'
import { testContext } from '../helpers/brain.ts'

/**
 * 硬取消：无论工具是否理会 signal，派发都必须在取消/超时后落地。
 *
 * 这是「一个 bash 卡住导致整轮永不结束」的兜底：包装层和真实派发赛跑，
 * 输了也要返回结构化失败，让循环能写 tool/result、step/end、turn/end。
 */

interface Exec {
  name: string
  signal?: AbortSignal
  agent?: unknown
}

interface Result {
  isError?: boolean
  content: Array<{ type: string; text: string }>
  error?: { message: string; info: { name: string; code: string } }
}

function dispatch(ctx: Context, exec: Exec, next: () => Promise<Result>): Promise<Result> {
  const waterfall = ctx as unknown as {
    waterfall(event: string, payload: unknown, next: () => unknown): Promise<unknown>
  }
  return waterfall.waterfall('tools/execute', exec, next) as Promise<Result>
}

function context(tools?: { get(name: string, agent?: unknown): { timeoutMs?: number } | undefined }) {
  const ctx = testContext(tools === undefined ? {} : { tools })
  apply(ctx)
  return ctx
}

function never(): Promise<Result> {
  return new Promise<Result>(() => undefined)
}

describe('tool-abort-policy：透传', () => {
  it('没有 signal 时直接交给下一层', async () => {
    const ctx = context()
    const result = await dispatch(ctx, { name: 'read' }, async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    expect(result.content[0]?.text).toBe('ok')
  })

  it('工具正常返回时原样透传', async () => {
    const ctx = context()
    const result = await dispatch(
      ctx,
      { name: 'read', signal: new AbortController().signal },
      async () => ({ content: [{ type: 'text', text: 'data' }] }),
    )
    expect(result).toEqual({ content: [{ type: 'text', text: 'data' }] })
  })

  it('工具抛错时原样抛出', async () => {
    const ctx = context()
    await expect(
      dispatch(ctx, { name: 'read', signal: new AbortController().signal }, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })
})

describe('tool-abort-policy：取消', () => {
  it('工具无视 signal 时，取消立即落地为 TOOL_ABORTED', async () => {
    const ctx = context()
    const controller = new AbortController()
    const pending = dispatch(ctx, { name: 'bash', signal: controller.signal }, never)
    controller.abort()
    const result = await pending

    expect(result.isError).toBe(true)
    expect(result.error?.info).toEqual({ name: 'ToolAbortError', code: TOOL_ABORTED })
    expect(result.content).toEqual([{ type: 'text', text: 'Error: tool call aborted' }])
  })

  it('signal 进来前就已取消时同样立即落地', async () => {
    const ctx = context()
    const controller = new AbortController()
    controller.abort()
    const result = await dispatch(ctx, { name: 'bash', signal: controller.signal }, never)
    expect(result.error?.info.code).toBe(TOOL_ABORTED)
  })

  it('abortGraceMs 给工具留出收尾窗口后再落地', async () => {
    const controller = new AbortController()
    const ctx = testContext({})
    apply(ctx, { abortGraceMs: 30 })
    let settled = false
    const pending = dispatch(ctx, { name: 'bash', signal: controller.signal }, never).then((result) => {
      settled = true
      return result
    })
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    const result = await pending
    expect(settled).toBe(true)
    expect(result.error?.info.code).toBe(TOOL_ABORTED)
  })

  it('取消前已经完成的工具不被覆盖', async () => {
    const ctx = context()
    const controller = new AbortController()
    const result = await dispatch(
      ctx,
      { name: 'bash', signal: controller.signal },
      async () => ({ content: [{ type: 'text', text: 'finished first' }] }),
    )
    controller.abort()
    expect(result.content[0]?.text).toBe('finished first')
  })
})

describe('tool-abort-policy：超时', () => {
  it('按工具声明的 timeoutMs 自行计时，超时返回 TOOL_TIMEOUT', async () => {
    const ctx = context({ get: (name) => (name === 'slow' ? { timeoutMs: 20 } : undefined) })
    const result = await dispatch(ctx, { name: 'slow', signal: new AbortController().signal }, never)

    expect(result.isError).toBe(true)
    expect(result.error?.info).toEqual({ name: 'ToolTimeoutError', code: TOOL_TIMEOUT })
    expect(result.content[0]?.text).toBe('Error: tool call timed out after 20ms')
  })

  it('合作式超时策略先把 signal 以 TOOL_TIMEOUT 取消时，消息带声明的时限', async () => {
    const ctx = context({ get: () => ({ timeoutMs: 500 }) })
    const controller = new AbortController()
    const pending = dispatch(ctx, { name: 'slow', signal: controller.signal }, never)
    controller.abort({ code: TOOL_TIMEOUT, timeoutMs: 500 })
    const result = await pending

    expect(result.error?.info.code).toBe(TOOL_TIMEOUT)
    expect(result.content[0]?.text).toBe('Error: tool call timed out after 500ms')
  })

  it('没有声明时限时被普通取消仍按 TOOL_ABORTED 处理', async () => {
    const ctx = context({ get: () => undefined })
    const controller = new AbortController()
    const pending = dispatch(ctx, { name: 'slow', signal: controller.signal }, never)
    controller.abort()
    const result = await pending
    expect(result.error?.info.code).toBe(TOOL_ABORTED)
    expect(result.content[0]?.text).toBe('Error: tool call aborted')
  })
})
