import { describe, expect, it } from 'vitest'
import { PREFIX } from '../../packages/dsh-platform-api/src/routes.ts'
import {
  auditUpgradeRoutes,
  normalizeOutcome,
  SESSION_PREFIX,
  sessionAnswersPath,
  sessionStreamPath,
} from '../../packages/dsh-platform-api/src/session-stream.ts'
import { FakeWebServer } from '../helpers/brain.ts'

/** 实时面只剩 SSE：路径形状、上行答复校验、Upgrade 审计（必须为空）。 */

describe('会话流路径', () => {
  it('前缀与路由表一致', () => {
    expect(SESSION_PREFIX).toBe(PREFIX)
  })

  it('下行与上行路径都按会话 id 拼，并做百分号编码', () => {
    expect(sessionStreamPath('sess-a')).toBe('/brain/v1/sessions/sess-a/stream')
    expect(sessionAnswersPath('sess-a')).toBe('/brain/v1/sessions/sess-a/answers')
    expect(sessionStreamPath('a/b')).toBe('/brain/v1/sessions/a%2Fb/stream')
  })
})

describe('Upgrade 审计', () => {
  it('没有 Upgrade 路由时通过', () => {
    expect(auditUpgradeRoutes(new FakeWebServer())).toEqual([])
  })

  it('出现任何 Upgrade 路由都视为违规', () => {
    const web = new FakeWebServer()
    web.registerUpgrade({ path: '/brain/v1/sessions/stream', handler: () => undefined })
    expect(() => auditUpgradeRoutes(web)).toThrow(/no Upgrade routes are allowed/)
  })
})

describe('上行答复校验', () => {
  it('接受 result 与 rejected', () => {
    expect(normalizeOutcome({ kind: 'result', value: 'approved' })).toEqual({ kind: 'result', value: 'approved' })
    expect(normalizeOutcome({ kind: 'rejected', error: 'nope' })).toEqual({ kind: 'rejected', error: 'nope' })
    expect(normalizeOutcome({ kind: 'rejected' })).toEqual({ kind: 'rejected' })
  })

  it('拒绝其它形状', () => {
    expect(normalizeOutcome(undefined)).toBeUndefined()
    expect(normalizeOutcome(null)).toBeUndefined()
    expect(normalizeOutcome([])).toBeUndefined()
    expect(normalizeOutcome({ kind: 'approved' })).toBeUndefined()
    expect(normalizeOutcome('result')).toBeUndefined()
  })
})
