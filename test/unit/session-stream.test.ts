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
import { SESSION_SOCKET_PATH } from '../../packages/dsh-platform-api/src/session-socket.ts'

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

  it('只放行文档里那一条会话 socket，其它 Upgrade 一律违规', () => {
    const allowed = new FakeWebServer()
    allowed.registerUpgrade({ path: SESSION_SOCKET_PATH, handler: () => undefined })
    expect(auditUpgradeRoutes(allowed, [SESSION_SOCKET_PATH])).toEqual([SESSION_SOCKET_PATH])

    const other = new FakeWebServer()
    other.registerUpgrade({ path: '/brain/v1/sessions/stream', handler: () => undefined })
    expect(() => auditUpgradeRoutes(other, [SESSION_SOCKET_PATH])).toThrow(/undocumented Upgrade routes/)
    expect(() => auditUpgradeRoutes(other, [SESSION_SOCKET_PATH])).toThrow(/\/brain\/v1\/sessions\/stream/)
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
