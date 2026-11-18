import { describe, expect, it } from 'vitest'
import { apply } from '../../packages/dsh-e2b/src/workspace-files.ts'
import { sandboxSessionId } from '../../packages/dsh-e2b/src/session-scope.ts'
import { testContext } from '../helpers/brain.ts'

/**
 * 页面直连 `workspaceFiles/*`：每个请求自带会话身份（`workspaceFileScope`），
 * 但调用链上没有发起 Agent。包装层必须把该会话钉进异步作用域，沙箱注册表
 * 才能路由到会话所属工作区的沙箱；`changes` 的迭代在调用返回后才推进，
 * 每次推进也要重新进入作用域。
 */

interface Scope {
  readonly sessionId: string
}

function fakeService() {
  const seen: Array<string | undefined> = []
  return {
    seen,
    async list(_scope: Scope, _path: string, _signal?: AbortSignal) {
      seen.push(sandboxSessionId())
      return { entries: [] }
    },
    async stat() {
      seen.push(sandboxSessionId())
      return { kind: 'directory' }
    },
    async *changes(scope: Scope) {
      seen.push(sandboxSessionId())
      yield { kind: 'ready', path: scope.sessionId }
      seen.push(sandboxSessionId())
      yield { kind: 'observed', path: scope.sessionId }
    },
    /** 不在包装名单里，行为必须原样。 */
    async describe() {
      return sandboxSessionId()
    },
  }
}

function service() {
  const files = fakeService()
  const ctx = testContext({ workspaceFiles: files })
  return { ctx, files, ready: apply(ctx) }
}

describe('workspaceFiles 的会话沙箱作用域', () => {
  it('普通调用在请求会话的作用域里执行', async () => {
    const { files, ready } = service()
    await ready
    await files.list({ sessionId: 's1' }, '.')
    expect(files.seen).toEqual(['s1'])
    // 调用结束作用域即退出。
    expect(sandboxSessionId()).toBeUndefined()
  })

  it('包装后仍然按请求转发参数', async () => {
    const { files, ready } = service()
    await ready
    await files.list({ sessionId: 's2' }, '/desk/docs')
    await files.stat({ sessionId: 's2' }, '/desk/docs/a.md')
    expect(files.seen).toEqual(['s2', 's2'])
  })

  it('changes 的每次迭代都重新进入作用域', async () => {
    const { files, ready } = service()
    await ready
    const frames: unknown[] = []
    for await (const frame of files.changes({ sessionId: 's3' }, '/desk')) frames.push(frame)
    expect(frames).toEqual([
      { kind: 'ready', path: 's3' },
      { kind: 'observed', path: 's3' },
    ])
    expect(files.seen).toEqual(['s3', 's3'])
    expect(sandboxSessionId()).toBeUndefined()
  })

  it('未包装的方法不受影响', async () => {
    const { files, ready } = service()
    await ready
    await expect(files.describe()).resolves.toBeUndefined()
  })
})
