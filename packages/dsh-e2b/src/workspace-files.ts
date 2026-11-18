/**
 * 浏览器直连的工作区文件接口：把请求里的会话身份钉进沙箱作用域。
 *
 * `workspaceFiles/*` 由页面直接调用，没有发起 Agent，E2B 的 `ctx.fs` 因此拿不到
 * 会话、绑定不了沙箱。这里按每个请求自带的 `workspaceFileScope.sessionId` 包一层
 * 异步作用域，注册表就能路由到该会话所属工作区的沙箱。目录树与文件预览都走它。
 *
 * @module @brain/dsh-e2b/workspace-files
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files'
import { runWithSandboxSession } from './session-scope.ts'

/** 请求里的会话身份；与 `workspaceFileScopeId` 解析后的对象同形。 */
interface FileScope {
  readonly sessionId: string
}

const METHODS = ['read', 'readBytes', 'stat', 'list', 'search', 'changes'] as const

type RemoteMethod = (this: unknown, scope: FileScope, ...rest: readonly never[]) => unknown

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

/** 观察者（changes）的迭代在调用返回之后才推进，每次推进都要重新进入作用域。 */
function wrapIterable<T>(sessionId: string, source: AsyncIterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const inner = source[Symbol.asyncIterator]()
      const next = inner.next.bind(inner)
      const finish = inner.return?.bind(inner)
      const fail = inner.throw?.bind(inner)
      return {
        next: (...args: [] | [unknown]) => runWithSandboxSession(sessionId, () => next(...args)),
        return: finish === undefined
          ? undefined
          : (value?: unknown) => runWithSandboxSession(sessionId, () => finish(value)),
        throw: fail === undefined
          ? undefined
          : (error?: unknown) => runWithSandboxSession(sessionId, () => fail(error)),
      }
    },
  }
}

function scoped<T>(sessionId: string, run: () => T): T {
  const value = runWithSandboxSession(sessionId, run)
  return (isAsyncIterable(value) ? wrapIterable(sessionId, value) : value) as T
}

/** 服务实例自己，绕过 Cordis 的调用视图。 */
function originalOf(value: object): object {
  const original: unknown = Reflect.get(value, Symbol.for('cordis.original'))
  return typeof original === 'object' && original !== null ? original : value
}

/**
 * @param ctx - 宿主上下文；`workspaceFiles` 必须已由工作区文件插件提供。
 * @returns 插件的 Fiber（等它完成再发调用）。
 */
export function apply(ctx: Context) {
  return ctx.inject(['workspaceFiles'], (scope) => {
    scope.effect(() => {
      const service = scope.get('workspaceFiles') as WorkspaceFiles | undefined
      if (service === undefined) return () => undefined
      const target = originalOf(service) as Record<string, unknown>
      const restores: Array<() => void> = []
      for (const name of METHODS) {
        const original = target[name]
        if (typeof original !== 'function') continue
        const method = original as RemoteMethod
        target[name] = function (this: unknown, fileScope: FileScope, ...rest: never[]): unknown {
          return scoped(fileScope.sessionId, () => method.apply(this, [fileScope, ...rest]))
        }
        restores.push(() => { target[name] = method })
      }
      return () => {
        for (const restore of restores) restore()
      }
    })
  })
}
