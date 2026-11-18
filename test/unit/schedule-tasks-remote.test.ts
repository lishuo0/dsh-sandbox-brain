import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ScheduleRemoteService } from '../../packages/dsh-schedule-tasks/src/remote.ts'
import { createTask } from '../../packages/dsh-schedule-tasks/src/tasks.ts'
import { testContext } from '../helpers/brain.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts'

const SESSION = 'session-remote-a'
const OTHER = 'session-remote-b'
const STRANGER = 'session-remote-stranger'

let database: TestDatabase
let service: ScheduleRemoteService

type Entry = Record<string, unknown>

async function row(id: string): Promise<Record<string, unknown>> {
  const rows = await database.pool.query(`SELECT * FROM dsh_schedule_tasks WHERE id = $1`, [id])
  const found = rows[0]
  if (found === undefined) throw new Error(`任务不存在: ${id}`)
  return found
}

function ruleOf(stored: unknown): Record<string, unknown> {
  return typeof stored === 'string' ? (JSON.parse(stored) as Record<string, unknown>) : (stored as Record<string, unknown>)
}

async function inputCode(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action()
  } catch (error) {
    if (error instanceof RemoteError) {
      expect(error.code).toBe('schedule/input-invalid')
      return (error.details as { code?: string } | undefined)?.code
    }
    throw error
  }
  return undefined
}

async function create(overrides: Record<string, unknown> = {}, sessionIds: string[] = [SESSION, OTHER]): Promise<Entry> {
  return await service.remoteCreate({
    title: '任务',
    prompt: '提醒内容',
    timing: { kind: 'every', every_seconds: 300 },
    target: { kind: 'session', sessionId: SESSION },
    ...overrides,
  } as never, sessionIds) as Entry
}

beforeAll(async () => {
  database = await createTestDatabase([])
  service = new ScheduleRemoteService(testContext(), database.pool)
})

afterAll(async () => {
  await database.drop()
})

describe('定时任务 Remote 面', () => {
  it('catalog 映射成页面条目', async () => {
    const created = await create({ title: ' 喝水 ', prompt: ' 去喝水 ' })
    expect(created['kind']).toBe('every')
    expect(created['title']).toBe('喝水')
    expect(created['prompt']).toBe('去喝水')
    expect(created['status']).toBe('active')
    expect(created['target']).toEqual({ kind: 'session', sessionId: SESSION })
    expect(created['involvedSessionIds']).toEqual([SESSION])
    expect(typeof created['scheduledAt']).toBe('string')
    expect(typeof created['updatedAt']).toBe('string')

    const catalog = await service.remoteCatalog([SESSION, OTHER])
    expect(catalog.map((entry) => entry['id'])).toContain(created['id'])
  })

  it('catalog 只列当前成员的会话', async () => {
    const created = await create()
    expect((await service.remoteCatalog([STRANGER])).map((entry) => entry['id'])).not.toContain(created['id'])
    expect(await service.remoteCatalog([])).toEqual([])
    expect((await service.remoteCatalog()).map((entry) => entry['id'])).toContain(created['id'])
  })

  it('list 分页并只收当前成员的 active 任务', async () => {
    await create({ timing: { kind: 'every', every_seconds: 600 } })
    const page = await service.remoteList({ active: true, limit: 1, offset: 0 }, [SESSION, OTHER])
    expect(page.items).toHaveLength(1)
    expect(page.shown).toBe(1)
    expect(page.limit).toBe(1)
    expect(page.offset).toBe(0)
    expect(page.total).toBeGreaterThanOrEqual(1)

    expect(await inputCode(() => service.remoteList({ limit: 0 }, [SESSION]))).toBe('invalid_rule')
    expect(await inputCode(() => service.remoteList({ limit: 501 }, [SESSION]))).toBe('invalid_rule')
  })

  it('别人的任务在 view / edit / run / history 上一律按找不到处理', async () => {
    const created = await create()
    const id = String(created['id'])
    const missing = { id, code: 'schedule_not_found' }
    expect(await service.remoteView({ id }, [STRANGER])).toEqual(missing)
    expect(await service.remoteEdit({ id, action: 'delete' }, [STRANGER])).toEqual(missing)
    expect(await service.remoteRun({ id }, [STRANGER])).toEqual(missing)
    expect(await service.remoteHistory({ id, limit: 20 }, [STRANGER])).toEqual(missing)
    // 任务仍在，且对所属会话可见。
    expect((await service.remoteView({ id }, [SESSION]))['id']).toBe(id)
  })

  it('view 找不到时返回非变更结果', async () => {
    expect(await service.remoteView({ id: 'sch_missing' }, [SESSION])).toEqual({ id: 'sch_missing', code: 'schedule_not_found' })
  })

  it('create 拒绝 new_once / new 目标的越权会话', async () => {
    expect(await inputCode(() => service.remoteCreate({
      title: '新建会话',
      prompt: '提醒',
      timing: { kind: 'after', after_seconds: 60 },
      target: { kind: 'new_once' },
    }, [SESSION]))).toBe('invalid_rule')

    expect(await inputCode(() => create({ target: { kind: 'session', sessionId: STRANGER } }))).toBe('invalid_rule')
  })

  it('create 拒绝 rrule 与空标题', async () => {
    expect(await inputCode(() => create({ timing: { kind: 'rrule', rrule: 'FREQ=DAILY' } }))).toBe('invalid_rule')
    expect(await inputCode(() => create({ title: '   ' }))).toBe('invalid_prompt')
  })

  it('暂停写 paused 标记，恢复重算下一次', async () => {
    const created = await create()
    const paused = await service.remoteEdit({
      id: String(created['id']),
      action: 'update',
      patch: { active: false },
    }, [SESSION, OTHER]) as Entry
    expect(paused['status']).toBe('paused')
    const stored = await row(String(created['id']))
    expect(stored['status']).toBe('inactive')
    expect(ruleOf(stored['rule'])['paused']).toBe(true)

    const resumed = await service.remoteEdit({
      id: String(created['id']),
      action: 'update',
      patch: { active: true },
    }, [SESSION, OTHER]) as Entry
    expect(resumed['status']).toBe('active')
    expect(ruleOf((await row(String(created['id'])))['rule'])['paused']).toBeUndefined()
    expect(new Date(String(resumed['scheduledAt'])).getTime()).toBeGreaterThan(Date.now())
  })

  it('恢复一次性过期任务报 not_future', async () => {
    const created = (await createTask(
      database.pool,
      SESSION,
      { title: '过去', prompt: '过期提醒', at: new Date(Date.now() + 60_000).toISOString() },
      new Date(),
    )) as Entry
    // 直接把到期时间改到过去，模拟已经到期的一次性任务。
    await database.pool.query(`UPDATE dsh_schedule_tasks SET next_run_at = $2, status = 'inactive' WHERE id = $1`, [
      created['id'],
      new Date(Date.now() - 60_000).toISOString(),
    ])
    expect(await inputCode(() => service.remoteEdit({
      id: String(created['id']),
      action: 'update',
      patch: { active: true },
    }, [SESSION]))).toBe('not_future')
  })

  it('编辑计时改 kind 并重算', async () => {
    const created = await create()
    const updated = await service.remoteEdit({
      id: String(created['id']),
      action: 'update',
      patch: { timing: { kind: 'daily', daily: { time: '09:30:00', time_zone: 'Asia/Shanghai' } } },
    }, [SESSION, OTHER]) as Entry
    expect(updated['kind']).toBe('daily')
    expect(updated['time']).toBe('09:30:00.000')
    expect(updated['timeZone']).toBe('Asia/Shanghai')
    expect((await row(String(created['id'])))['kind']).toBe('daily')
  })

  it('expectedUpdatedAt 不一致返回 schedule_conflict', async () => {
    const created = await create()
    const conflict = await service.remoteEdit({
      id: String(created['id']),
      action: 'update',
      patch: { title: '改名' },
      expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
    }, [SESSION, OTHER])
    expect(conflict).toEqual({ id: created['id'], code: 'schedule_conflict' })

    const ok = await service.remoteEdit({
      id: String(created['id']),
      action: 'update',
      patch: { title: '改名' },
      expectedUpdatedAt: created['updatedAt'],
    }, [SESSION, OTHER]) as Entry
    expect(ok['title']).toBe('改名')
  })

  it('delete 是硬删除', async () => {
    const created = await create()
    expect(await service.remoteEdit({ id: String(created['id']), action: 'delete' }, [SESSION, OTHER]))
      .toEqual({ id: created['id'], deleted: true })
    expect(await database.pool.query(`SELECT id FROM dsh_schedule_tasks WHERE id = $1`, [created['id']])).toEqual([])
  })

  it('deleteInactive 只删 ended，不删暂停', async () => {
    const paused = await create()
    await service.remoteEdit({ id: String(paused['id']), action: 'update', patch: { active: false } }, [SESSION, OTHER])
    const ended = (await createTask(database.pool, SESSION, {
      title: '已结束', prompt: '结束', after_seconds: 60,
    }, new Date())) as Entry
    await database.pool.query(`UPDATE dsh_schedule_tasks SET status = 'inactive' WHERE id = $1`, [ended['id']])

    const removed = await service.remoteDeleteInactive([SESSION, OTHER])
    expect(removed.deleted).toBeGreaterThanOrEqual(1)
    expect((await database.pool.query(`SELECT id FROM dsh_schedule_tasks WHERE id = $1`, [paused['id']])).length).toBe(1)
    expect(await database.pool.query(`SELECT id FROM dsh_schedule_tasks WHERE id = $1`, [ended['id']])).toEqual([])
  })

  it('run 把下次执行提前到现在并解除暂停', async () => {
    const created = await create({ timing: { kind: 'every', every_seconds: 3600 } })
    await service.remoteEdit({ id: String(created['id']), action: 'update', patch: { active: false } }, [SESSION, OTHER])
    const ran = await service.remoteRun({ id: String(created['id']) }, [SESSION, OTHER]) as Entry
    expect(ran['status']).toBe('active')
    expect(new Date(String(ran['scheduledAt'])).getTime()).toBeLessThanOrEqual(Date.now() + 1000)
    const stored = await row(String(created['id']))
    expect(stored['status']).toBe('active')
    expect(ruleOf(stored['rule'])['paused']).toBeUndefined()
  })

  it('history 返回空归档并要求合法 limit', async () => {
    const created = await create()
    const history = await service.remoteHistory({ id: String(created['id']), limit: 20 }, [SESSION])
    expect(history['id']).toBe(created['id'])
    expect(history['records']).toEqual([])
    expect(history['retention']).toEqual({ days: 30, records: 200 })
    expect(await inputCode(() => service.remoteHistory({ id: String(created['id']), limit: 0 }, [SESSION])))
      .toBe('invalid_rule')
    expect(await service.remoteHistory({ id: 'sch_missing', limit: 20 }, [SESSION]))
      .toEqual({ id: 'sch_missing', code: 'schedule_not_found' })
  })

  it('deliveryLimits 与官方 Host 同值', async () => {
    expect(await service.remoteDeliveryLimits()).toEqual({ newSessionIntervalSeconds: 60 })
  })

  it('页面的一次性 RRULE 落成 at', async () => {
    const created = await create({
      timing: { kind: 'rrule', rrule: 'DTSTART;TZID=Asia/Shanghai:20310101T090000\nRRULE:FREQ=DAILY;COUNT=1' },
    })
    expect(created['kind']).toBe('at')
    expect(created['scheduledAt']).toBe('2031-01-01T01:00:00.000Z')
  })

  it('页面的分钟 / 小时循环落成 every', async () => {
    const minutely = await create({
      timing: { kind: 'rrule', rrule: 'DTSTART;TZID=Asia/Shanghai:20310101T090000\nRRULE:FREQ=MINUTELY;INTERVAL=5' },
    })
    expect(minutely['kind']).toBe('every')
    expect(minutely['everySeconds']).toBe(300)
    const hourly = await create({
      timing: { kind: 'rrule', rrule: 'DTSTART;TZID=Asia/Shanghai:20310101T090000\nRRULE:FREQ=HOURLY;INTERVAL=2' },
    })
    expect(hourly['kind']).toBe('every')
    expect(hourly['everySeconds']).toBe(7200)
  })

  it('页面的每天 / 每周 RRULE 落成 daily / weekly', async () => {
    const daily = await create({
      timing: {
        kind: 'rrule',
        rrule: 'DTSTART;TZID=Asia/Shanghai:20310101T090500\nRRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=5',
      },
    })
    expect(daily['kind']).toBe('daily')
    expect(daily['time']).toBe('09:05:00.000')
    expect(daily['timeZone']).toBe('Asia/Shanghai')

    const weekly = await create({
      timing: {
        kind: 'rrule',
        rrule: 'DTSTART;TZID=Asia/Shanghai:20310101T090000\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE',
      },
    })
    expect(weekly['kind']).toBe('weekly')
    expect(weekly['time']).toBe('09:00:00.000')
    expect(weekly['weekdays']).toEqual([1, 3])
  })

  it('超出模型的 RRULE 按输入错误退回', async () => {
    const cases = [
      'DTSTART;TZID=Asia/Shanghai:20310101T090000\nRRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=9,-1;BYSETPOS=1',
      'DTSTART;TZID=Asia/Shanghai:20310101T090000\nRRULE:FREQ=DAILY;INTERVAL=2',
      'DTSTART;TZID=Asia/Shanghai:20310101T090000\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',
      'DTSTART;TZID=Asia/Shanghai:20310101T090000\nRRULE:FREQ=DAILY;BYHOUR=9',
      'DTSTART;TZID=Asia/Shanghai:20310101T090000\nRRULE:FREQ=MINUTELY;BYSECOND=30',
      'FREQ=DAILY;COUNT=1',
      'DTSTART:20310101T090000\nRRULE:FREQ=DAILY;COUNT=1',
    ]
    for (const rrule of cases) {
      expect(await inputCode(() => create({ timing: { kind: 'rrule', rrule } }))).toBe('invalid_rule')
    }
  })
})
