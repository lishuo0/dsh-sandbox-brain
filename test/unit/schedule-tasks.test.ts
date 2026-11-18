import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTask, deleteTask, listTasks, updateTask } from '../../packages/dsh-schedule-tasks/src/tasks.ts'
import { ScheduleInputError } from '../../packages/dsh-schedule-tasks/src/time.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts'

const NOW = new Date('2026-01-01T00:00:00.000Z')
const SESSION = 'session-schedule-test'
const OTHER = 'session-schedule-other'

let database: TestDatabase

type View = Record<string, unknown>

async function row(id: string): Promise<Record<string, unknown>> {
  const rows = await database.pool.query(`SELECT * FROM dsh_schedule_tasks WHERE id = $1`, [id])
  const found = rows[0]
  if (found === undefined) throw new Error(`任务不存在: ${id}`)
  return found
}

function ruleOf(stored: unknown): Record<string, unknown> {
  return typeof stored === 'string' ? (JSON.parse(stored) as Record<string, unknown>) : (stored as Record<string, unknown>)
}

function codeOf(error: unknown): string | undefined {
  return error instanceof ScheduleInputError ? error.code : undefined
}

beforeAll(async () => {
  // 定时表不在共享 schema 里，由 tasks.ts 首次使用时建。
  database = await createTestDatabase([])
})

afterAll(async () => {
  await database.drop()
})

describe('定时任务定义', () => {
  it('after 写入一次性任务', async () => {
    const view = (await createTask(database.pool, SESSION, { title: ' 喝水 ', prompt: ' 去喝水 ', after_seconds: 90 }, NOW)) as View
    expect(view['kind']).toBe('after')
    expect(view['afterSeconds']).toBe(90)
    expect(view['title']).toBe('喝水')
    expect(view['prompt']).toBe('去喝水')
    expect(view['scheduledAt']).toBe('2026-01-01T00:01:30.000Z')
    expect(view['state']).toBe('scheduled')
    expect(view['deliveryMode']).toBe('host')
    expect(String(view['id'])).toMatch(/^sch_[0-9a-f]{16}$/)

    const stored = await row(String(view['id']))
    expect(stored['kind']).toBe('after')
    expect(stored['status']).toBe('active')
    expect(Number(stored['generation'])).toBe(1)
    expect(ruleOf(stored['rule'])).toEqual({ afterSeconds: 90 })
  })

  it('after_seconds 必须为正', async () => {
    expect(codeOf(await capture(() => createTask(database.pool, SESSION, { title: 'x', prompt: 'y', after_seconds: 0 }, NOW))))
      .toBe('invalid_rule')
  })

  it('every 记录锚点并至少隔 60 秒', async () => {
    const view = (await createTask(database.pool, SESSION, { title: '间隔', prompt: '间隔提醒', every_seconds: 300 }, NOW)) as View
    expect(view['kind']).toBe('every')
    expect(view['everySeconds']).toBe(300)
    expect(view['scheduledAt']).toBe('2026-01-01T00:05:00.000Z')
    expect(ruleOf((await row(String(view['id'])))['rule'])).toEqual({ everySeconds: 300, anchor: NOW.toISOString() })

    expect(codeOf(await capture(() => createTask(database.pool, SESSION, { title: 'x', prompt: 'y', every_seconds: 30 }, NOW))))
      .toBe('frequency_too_high')
  })

  it('daily 归一钟点与时区', async () => {
    const view = (await createTask(database.pool, SESSION, {
      title: '早会', prompt: '开会', daily: { time: '09:30:00', time_zone: 'Asia/Shanghai' },
    }, NOW)) as View
    expect(view['kind']).toBe('daily')
    expect(view['time']).toBe('09:30:00.000')
    expect(view['timeZone']).toBe('Asia/Shanghai')
    // 上海 09:30 = UTC 01:30
    expect(view['scheduledAt']).toBe('2026-01-01T01:30:00.000Z')
    expect(ruleOf((await row(String(view['id'])))['rule'])).toEqual({ time: '09:30:00.000', timeZone: 'Asia/Shanghai' })
  })

  it('weekly 只接受 1-7 且不重复', async () => {
    const ok = (await createTask(database.pool, SESSION, {
      title: '周报', prompt: '写周报', weekly: { time: '10:00:00', time_zone: 'UTC', weekdays: [5, 1] },
    }, NOW)) as View
    expect(ok['kind']).toBe('weekly')
    expect(ok['weekdays']).toEqual([1, 5])
    // 2026-01-01 周四，最近的是周五 01-02
    expect(ok['scheduledAt']).toBe('2026-01-02T10:00:00.000Z')

    expect(codeOf(await capture(() => createTask(database.pool, SESSION, {
      title: '周报', prompt: '写周报', weekly: { time: '10:00:00', time_zone: 'UTC', weekdays: [5, 1, 5] },
    }, NOW)))).toBe('invalid_rule')
    for (const bad of [[0], [8], []]) {
      expect(codeOf(await capture(() => createTask(database.pool, SESSION, {
        title: '周报', prompt: '写周报', weekly: { time: '10:00:00', time_zone: 'UTC', weekdays: bad as number[] },
      }, NOW)))).toBe('invalid_rule')
    }
  })

  it('cron 归一空格并校验表达式', async () => {
    const view = (await createTask(database.pool, SESSION, {
      title: '轮询', prompt: '看看', cron: { expression: '  */15   *  * * * ', time_zone: 'UTC' },
    }, NOW)) as View
    expect(view['kind']).toBe('cron')
    expect(view['expression']).toBe('*/15 * * * *')
    expect(view['scheduledAt']).toBe('2026-01-01T00:15:00.000Z')

    expect(codeOf(await capture(() => createTask(database.pool, SESSION, {
      title: 'x', prompt: 'y', cron: { expression: '* * *', time_zone: 'UTC' },
    }, NOW)))).toBe('invalid_rule')
    expect(codeOf(await capture(() => createTask(database.pool, SESSION, {
      title: 'x', prompt: 'y', cron: { expression: '0 0 * * *', time_zone: 'Mars/Olympus' },
    }, NOW)))).toBe('invalid_time_zone')
  })

  it('at 必须是未来时刻', async () => {
    const view = (await createTask(database.pool, SESSION, { title: '定点', prompt: '到点', at: '2026-01-01T08:00:00Z' }, NOW)) as View
    expect(view['kind']).toBe('at')
    expect(view['scheduledAt']).toBe('2026-01-01T08:00:00.000Z')
    expect(ruleOf((await row(String(view['id'])))['rule'])).toEqual({})
    expect(codeOf(await capture(() => createTask(database.pool, SESSION, {
      title: '定点', prompt: '到点', at: '2025-12-31T00:00:00Z',
    }, NOW)))).toBe('not_future')
  })

  it('必须给一个时间方式', async () => {
    expect(codeOf(await capture(() => createTask(database.pool, SESSION, { title: 'x', prompt: 'y' }, NOW))))
      .toBe('invalid_selector')
  })

  it('列表只列本会话的启用任务，按时刻排序', async () => {
    const later = (await createTask(database.pool, OTHER, { title: '晚', prompt: '晚点', after_seconds: 600 }, NOW)) as View
    const sooner = (await createTask(database.pool, OTHER, { title: '早', prompt: '早点', after_seconds: 60 }, NOW)) as View
    const gone = (await createTask(database.pool, OTHER, { title: '删', prompt: '删掉', after_seconds: 120 }, NOW)) as View
    await deleteTask(database.pool, OTHER, String(gone['id']))

    const list = (await listTasks(database.pool, OTHER, NOW)) as View[]
    expect(list.map((item) => item['id'])).toEqual([sooner['id'], later['id']])
  })

  it('删除不存在的任务返回 schedule_not_found，重复删除也一样', async () => {
    const view = (await createTask(database.pool, OTHER, { title: '删', prompt: '删掉', after_seconds: 60 }, NOW)) as View
    expect(await deleteTask(database.pool, OTHER, 'sch_missing')).toEqual({ id: 'sch_missing', deleted: false, code: 'schedule_not_found' })
    expect(await deleteTask(database.pool, OTHER, String(view['id']))).toEqual({ id: view['id'], deleted: true })
    // 按工具语义，已停用的任务也可以再删一次。
    expect(await deleteTask(database.pool, OTHER, String(view['id']))).toEqual({ id: view['id'], deleted: true })
  })

  it('改标题和内容不动时刻，但代际加一', async () => {
    const view = (await createTask(database.pool, OTHER, { title: '旧', prompt: '旧内容', after_seconds: 120 }, NOW)) as View
    const updated = (await updateTask(database.pool, OTHER, { id: String(view['id']), title: '新', prompt: '新内容' }, NOW)) as View
    expect(updated['title']).toBe('新')
    expect(updated['prompt']).toBe('新内容')
    expect(updated['kind']).toBe('after')
    expect(updated['scheduledAt']).toBe(view['scheduledAt'])
    const stored = await row(String(view['id']))
    expect(Number(stored['generation'])).toBe(2)
    expect(stored['lease_owner']).toBeNull()
  })

  it('改时间会重置失败计数并清掉进行中的占位', async () => {
    const view = (await createTask(database.pool, OTHER, { title: '改', prompt: '内容', after_seconds: 60 }, NOW)) as View
    const id = String(view['id'])
    await database.pool.query(
      `UPDATE dsh_schedule_tasks SET attempt_count = 3, lease_owner = 'x', lease_until = $2, pending_occurrence = $3 WHERE id = $1`,
      [id, NOW.toISOString(), NOW.toISOString()],
    )
    const updated = (await updateTask(database.pool, OTHER, {
      id, daily: { time: '23:00:00', time_zone: 'UTC' },
    }, NOW)) as View
    expect(updated['kind']).toBe('daily')
    expect(updated['scheduledAt']).toBe('2026-01-01T23:00:00.000Z')
    const stored = await row(id)
    expect(Number(stored['attempt_count'])).toBe(0)
    expect(stored['lease_owner']).toBeNull()
    expect(stored['lease_until']).toBeNull()
    expect(stored['pending_occurrence']).toBeNull()
    expect(Number(stored['generation'])).toBe(2)
    expect(formatAt(stored['next_run_at'])).toBe('2026-01-01T23:00:00.000Z')
  })

  it('改不存在或已结束的任务给出对应错误', async () => {
    expect(await updateTask(database.pool, OTHER, { id: 'sch_missing', title: 'x' }, NOW))
      .toEqual({ id: 'sch_missing', updated: false, code: 'schedule_not_found' })

    const view = (await createTask(database.pool, OTHER, { title: '结束', prompt: '内容', after_seconds: 60 }, NOW)) as View
    await deleteTask(database.pool, OTHER, String(view['id']))
    expect(await updateTask(database.pool, OTHER, { id: String(view['id']), title: 'x' }, NOW))
      .toEqual({ id: view['id'], updated: false, code: 'schedule_ended' })
  })
})

async function capture(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  return undefined
}

function formatAt(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()
}
