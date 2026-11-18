import { describe, expect, it } from 'vitest'
import {
  afterDelay,
  assertCron,
  canonicalizeZone,
  MIN_EVERY_INTERVAL_SECONDS,
  latestClock,
  latestCron,
  latestEvery,
  nextClock,
  nextCron,
  nextEvery,
  parseAt,
  parseClock,
  ScheduleInputError,
  zonedTime,
} from '../../packages/dsh-schedule-tasks/src/time.ts'

const now = new Date('2026-01-01T00:00:00.000Z')
const iso = (date: Date) => date.toISOString()

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ScheduleInputError)
    expect((error as ScheduleInputError).code).toBe(code)
    return
  }
  throw new Error(`期望抛出 ${code}`)
}

describe('schedule time', () => {
  it('时钟解析与归一化', () => {
    expect(parseClock('09:30:00')).toMatchObject({ hour: 9, minute: 30, second: 0, millisecond: 0 })
    expect(parseClock('09:30:00.5').normalized).toBe('09:30:00.500')
    expect(parseClock('09:30:00.05').normalized).toBe('09:30:00.050')
    expect(parseClock('23:59:59.999').normalized).toBe('23:59:59.999')
    expectCode(() => parseClock('24:00:00'), 'invalid_rule')
    expectCode(() => parseClock('9:30'), 'invalid_rule')
    expectCode(() => parseClock('09:60:00'), 'invalid_rule')
  })

  it('时区只接受 UTC 或 IANA', () => {
    expect(canonicalizeZone('UTC')).toBe('UTC')
    expect(canonicalizeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expectCode(() => canonicalizeZone(''), 'invalid_time_zone')
    expectCode(() => canonicalizeZone('Mars/Olympus'), 'invalid_time_zone')
    expectCode(() => canonicalizeZone(' UTC'), 'invalid_time_zone')
    expectCode(() => canonicalizeZone('Shanghai'), 'invalid_time_zone')
  })

  it('at 支持带偏移的绝对时刻', () => {
    expect(iso(parseAt('2026-06-01T08:00:00Z', now))).toBe('2026-06-01T08:00:00.000Z')
    expect(iso(parseAt('2026-06-01T08:00:00+08:00', now))).toBe('2026-06-01T00:00:00.000Z')
    expect(iso(parseAt('2026-06-01T08:00:00.5Z', now))).toBe('2026-06-01T08:00:00.500Z')
    expectCode(() => parseAt('2026-06-01T08:00:00', now), 'invalid_rule')
    expectCode(() => parseAt('2026-02-30T08:00:00Z', now), 'invalid_rule')
    expectCode(() => parseAt('2026-06-01T08:00:00-00:00', now), 'invalid_rule')
    expectCode(() => parseAt('2026-06-01T08:00:00+24:00', now), 'invalid_rule')
  })

  it('at 必须是严格未来', () => {
    expectCode(() => parseAt('2026-01-01T00:00:00Z', now), 'not_future')
    expectCode(() => parseAt('2025-12-31T23:59:59Z', now), 'not_future')
  })

  it('本地 at 按给定时区换算', () => {
    expect(
      iso(parseAt({ date: '2026-06-01', time: '09:30:00', time_zone: 'Asia/Shanghai' }, now)),
    ).toBe('2026-06-01T01:30:00.000Z')
    expectCode(
      () => parseAt({ date: '2026-06-01', time: '09:30:00', time_zone: 'Bad/Zone' }, now),
      'invalid_time_zone',
    )
    expectCode(() => parseAt({ date: '2026-13-01', time: '09:30:00', time_zone: 'UTC' }, now), 'invalid_rule')
  })

  it('本地 at 拒绝夏令时跳过的时刻', () => {
    // 纽约 2026-03-08 02:30 不存在
    expectCode(
      () => parseAt({ date: '2026-03-08', time: '02:30:00', time_zone: 'America/New_York' }, now),
      'invalid_rule',
    )
  })

  it('一次性延迟只需正的安全整数；周期任务间隔至少 60 秒', () => {
    expect(MIN_EVERY_INTERVAL_SECONDS).toBe(60)
    expect(iso(afterDelay(60, now))).toBe('2026-01-01T00:01:00.000Z')
    // after 是“多久之后跑一次”，不受最小间隔限制。
    expect(iso(afterDelay(59, now))).toBe('2026-01-01T00:00:59.000Z')
    expectCode(() => afterDelay(0, now), 'invalid_rule')
    expectCode(() => afterDelay(1.5, now), 'invalid_rule')
    // every 是周期任务：低于 60 秒直接拒绝。
    const anchor = new Date('2026-01-01T00:00:00.000Z')
    expectCode(() => nextEvery(anchor, 59, now), 'frequency_too_high')
    expectCode(() => nextEvery(anchor, 60.5, now), 'invalid_rule')
  })

  it('nextEvery 按锚点推进', () => {
    const anchor = new Date('2026-01-01T00:00:00.000Z')
    expect(iso(nextEvery(anchor, 300, new Date('2026-01-01T00:00:00.000Z')))).toBe('2026-01-01T00:05:00.000Z')
    expect(iso(nextEvery(anchor, 300, new Date('2026-01-01T00:05:00.000Z')))).toBe('2026-01-01T00:10:00.000Z')
    expect(iso(nextEvery(anchor, 300, new Date('2025-12-31T23:00:00.000Z')))).toBe('2026-01-01T00:05:00.000Z')
  })

  it('latestEvery 不晚于现在，但至少一个间隔', () => {
    const anchor = new Date('2026-01-01T00:00:00.000Z')
    expect(iso(latestEvery(anchor, 300, new Date('2026-01-01T00:00:00.000Z')))).toBe('2026-01-01T00:05:00.000Z')
    expect(iso(latestEvery(anchor, 300, new Date('2026-01-01T00:12:00.000Z')))).toBe('2026-01-01T00:10:00.000Z')
  })

  it('nextClock 找下一个钟点', () => {
    const parts = parseClock('09:30:00')
    expect(iso(nextClock('UTC', parts, null, new Date('2026-01-01T00:00:00Z')))).toBe('2026-01-01T09:30:00.000Z')
    expect(iso(nextClock('UTC', parts, null, new Date('2026-01-01T09:30:00Z')))).toBe('2026-01-02T09:30:00.000Z')
  })

  it('nextClock 尊重 ISO 星期', () => {
    const parts = parseClock('10:00:00')
    // 2026-01-01 是周四（4），只要周一（1）
    expect(iso(nextClock('UTC', parts, [1], new Date('2026-01-01T00:00:00Z')))).toBe('2026-01-05T10:00:00.000Z')
  })

  it('latestClock 不晚于给定时刻', () => {
    const parts = parseClock('09:30:00')
    expect(iso(latestClock('UTC', parts, null, new Date('2026-01-01T12:00:00Z')))).toBe('2026-01-01T09:30:00.000Z')
    expect(iso(latestClock('UTC', parts, null, new Date('2026-01-01T05:00:00Z')))).toBe('2025-12-31T09:30:00.000Z')
  })

  it('夏令时切换时按墙上时间推进', () => {
    const parts = parseClock('09:00:00')
    // 纽约 2026-03-08 是切换日；3/7 09:00 EST = 14:00Z，3/8 09:00 EDT = 13:00Z
    const next = nextClock('America/New_York', parts, null, new Date('2026-03-07T15:00:00Z'))
    expect(iso(next)).toBe('2026-03-08T13:00:00.000Z')
  })

  it('cron 支持基础表达式', () => {
    expect(iso(nextCron('*/15 * * * *', 'UTC', new Date('2026-01-01T00:00:00Z')))).toBe('2026-01-01T00:15:00.000Z')
    expect(iso(nextCron('30 9 * * *', 'UTC', new Date('2026-01-01T00:00:00Z')))).toBe('2026-01-01T09:30:00.000Z')
    expect(iso(nextCron('0 9 * * 1', 'UTC', new Date('2026-01-01T00:00:00Z')))).toBe('2026-01-05T09:00:00.000Z')
  })

  it('cron 支持月份与星期名称、7 当周日', () => {
    expect(iso(nextCron('0 8 * JAN MON', 'UTC', new Date('2026-01-01T00:00:00Z')))).toBe('2026-01-05T08:00:00.000Z')
    expect(iso(nextCron('0 8 * * 7', 'UTC', new Date('2026-01-01T00:00:00Z')))).toBe('2026-01-04T08:00:00.000Z')
    expect(iso(nextCron('0 8 * * sun', 'UTC', new Date('2026-01-01T00:00:00Z')))).toBe('2026-01-04T08:00:00.000Z')
  })

  it('cron 的 day-of-month 与 day-of-week 是或关系', () => {
    // 每月 1 号或每周一
    expect(iso(nextCron('0 8 1 * 1', 'UTC', new Date('2026-01-02T00:00:00Z')))).toBe('2026-01-05T08:00:00.000Z')
    expect(iso(nextCron('0 8 1 * 1', 'UTC', new Date('2026-01-31T00:00:00Z')))).toBe('2026-02-01T08:00:00.000Z')
  })

  it('cron 非法表达式报 invalid_rule', () => {
    for (const bad of ['* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '1-0 * * * *']) {
      expectCode(() => nextCron(bad, 'UTC', new Date('2026-01-01T00:00:00Z')), 'invalid_rule')
    }
  })

  it('assertCron 归一化空白', () => {
    expect(assertCron('  0   9 * * * ', 'UTC', new Date('2026-01-01T00:00:00Z'))).toBe('0 9 * * *')
  })

  it('latestCron 取不晚于现在的最近一次', () => {
    expect(iso(latestCron('0 * * * *', 'UTC', new Date('2026-01-01T09:30:00Z')))).toBe('2026-01-01T09:00:00.000Z')
  })

  it('zonedTime 能还原一个合法本地时刻', () => {
    const date = zonedTime(2026, 6, 1, 9, 30, 0, 0, 'Asia/Shanghai')
    expect(date?.toISOString()).toBe('2026-06-01T01:30:00.000Z')
    expect(zonedTime(2026, 2, 30, 0, 0, 0, 0, 'UTC')).toBeUndefined()
  })
})
