/** 浏览器直连的回合外调用没有发起 Agent，用异步作用域补上会话身份。 */
import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<string>()

/**
 * 在一个会话的沙箱作用域里执行调用。用于浏览器直接发起的文件/进程操作：
 * 这些请求没有回合上下文，`agents.currentInitiator()` 为空，注册表只能退回
 * 这里钉住的会话。
 * @param sessionId - 请求所属会话。
 * @param run - 在该会话作用域内执行的调用。
 * @returns 调用的返回值。
 */
export function runWithSandboxSession<T>(sessionId: string, run: () => T): T {
  return storage.run(sessionId, run)
}

/** @returns 当前异步作用域钉住的会话；回合外没有则为 undefined。 */
export function sandboxSessionId(): string | undefined {
  return storage.getStore()
}
