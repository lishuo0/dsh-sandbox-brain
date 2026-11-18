import { describe, expect, it } from 'vitest'
import { apiEventOf } from '../../packages/dsh-platform-api/src/gateway.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * 表面元数据是持久日志的一部分：上游 session store 在浏览器侧校验
 * `surfaceOp`，缺了就把整段历史判为 `requires a surfaceOp marker`。
 * `apiEventOf` 是 gateway 往流帧里塞事件的唯一出口，必须原样带出。
 */

function event(shape: Record<string, unknown>): SessionEvent {
  return shape as unknown as SessionEvent
}

describe('API 事件形状', () => {
  it('保留 replace 操作的 surfaceOp 与 sourceEventSeqs', () => {
    const surfaceOp = { op: 'replace', startSeq: 9, endSeq: 9 }
    const api = apiEventOf(event({
      seq: 24,
      type: 'system/message',
      time: 1,
      data: { text: '压缩后的摘要' },
      surfaceOp,
      sourceEventSeqs: [9],
    }))
    expect(api).toEqual({
      seq: 24,
      type: 'system/message',
      data: { text: '压缩后的摘要' },
      surfaceOp,
      sourceEventSeqs: [9],
    })
  })

  it('append 操作同样保留', () => {
    const api = apiEventOf(event({ seq: 3, type: 'user/message', data: { text: 'hi' }, surfaceOp: 'append' }))
    expect(api.surfaceOp).toBe('append')
    expect(api.sourceEventSeqs).toBeUndefined()
  })

  it('log-only 事件不凭空多出 surfaceOp', () => {
    const api = apiEventOf(event({ seq: 5, type: 'turn/start', data: { requestId: 'r1' } }))
    expect(api).toEqual({ seq: 5, type: 'turn/start', data: { requestId: 'r1' } })
  })

  it('ignorable 只按 true 下发', () => {
    expect(apiEventOf(event({ seq: 7, type: 'plugin:x', data: null, ignorable: true })).ignorable).toBe(true)
    expect(apiEventOf(event({ seq: 8, type: 'plugin:x', data: null, ignorable: false })).ignorable).toBeUndefined()
  })
})
