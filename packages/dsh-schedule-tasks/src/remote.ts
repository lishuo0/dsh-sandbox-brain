/**
 * 官方客户端定时任务页（@deepseek-ai/dsh-client-ui-schedule）的 Remote 面。
 *
 * 页面读的是任务目录 / 列表 / 详情，写的是暂停、恢复、改时间、删除。
 * 平台代理在每次调用里补一个 `sessionIds` 参数，只放行当前成员名下的会话；
 * 脑本身仍不认租户。投递继续由平台认领 dsh_schedule_tasks 完成，这里不计时、
 * 不唤醒会话、也不回拨平台。
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-schedule'
import type { ScheduleInputErrorCode } from '@deepseek-ai/dsh-schedule'
import {
  buildRule, createTask, ensureScheduleTable,
  type RuleArgs, type ScheduleDB,
} from './tasks.ts'
import {
  MAX_TITLE_LENGTH, ScheduleInputError, canonicalizeZone, formatInstant, nextClock, nextCron, nextEvery, parseClock, zonedTime,
} from './time.ts'

/** 页面看到的任务条目：官方 ScheduleCatalogEntry 的形状，字段随 kind 变化。 */
type Entry = Record<string, unknown>

/** dsh_schedule_tasks 的一行。 */
interface Row {
  id: string
  session_id: string
  title: string
  prompt: string
  kind: string
  rule: unknown
  generation: string | number
  status: string
  next_run_at: Date | string
  created_at: Date | string
  updated_at: Date | string
}

/** 远程调用看到的计时规则，字段名与官方 create/edit 参数一致。 */
export interface RemoteTiming {
  kind: 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron' | 'rrule'
  after_seconds?: number
  at?: string | { date: string; time: string; time_zone: string }
  every_seconds?: number
  daily?: { time: string; time_zone: string }
  weekly?: { time: string; time_zone: string; weekdays: number[] }
  cron?: { expression: string; time_zone: string }
  rrule?: string
}

export interface RemoteTarget {
  kind: 'session' | 'new_once' | 'new'
  sessionId?: string
  create?: { cwd?: string; agentPreset?: string }
}

export interface RemoteCreateRequest {
  title?: string
  prompt?: string
  timing?: RemoteTiming
  target?: RemoteTarget
}

export interface RemoteEditUpdate {
  id?: string
  action: 'update'
  patch?: {
    title?: string
    prompt?: string
    timing?: RemoteTiming
    target?: RemoteTarget
    active?: boolean
  }
  expectedUpdatedAt?: string | null
}

export interface RemoteEditDelete {
  id?: string
  action: 'delete'
  expectedUpdatedAt?: string | null
}

export type RemoteEditRequest = RemoteEditUpdate | RemoteEditDelete

export interface RemoteListRequest {
  active?: boolean
  limit?: number
  offset?: number
}

export interface RemoteHistoryRequest {
  id?: string
  limit?: number
  before?: string
}

export interface RemoteRunRequest {
  id?: string
}

export interface RemoteViewRequest {
  id?: string
}

const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500
const MAX_HISTORY_LIMIT = 100
/** 与官方 Host 一致：新建会话的最短投递间隔。平台没有这个限制，页面只展示。 */
const NEW_SESSION_INTERVAL_SECONDS = 60
const HISTORY_RETENTION = { days: 30, records: 200 }

const ROW_COLUMNS = `id, session_id, title, prompt, kind, rule, generation, status,
                     next_run_at, created_at, updated_at`

function marks(params: unknown[], values: readonly unknown[]): string {
  return values.map((value) => {
    params.push(value)
    return `$${params.length}`
  }).join(', ')
}

/** 带上当前成员的会话范围；没给范围（工具/测试直接调用）就不过滤。 */
function scopeClause(sessionIds: readonly string[] | undefined, params: unknown[]): string | undefined {
  if (sessionIds === undefined) return ''
  if (sessionIds.length === 0) return undefined
  return `session_id IN (${marks(params, sessionIds)})`
}

async function queryRows(
  db: ScheduleDB,
  sessionIds: readonly string[] | undefined,
  status: 'active' | 'inactive' | undefined,
): Promise<Row[]> {
  await ensureScheduleTable(db)
  const params: unknown[] = []
  const where: string[] = []
  if (status !== undefined) {
    params.push(status)
    where.push(`status = $${params.length}`)
  }
  const scope = scopeClause(sessionIds, params)
  if (scope === undefined) return []
  if (scope !== '') where.push(scope)
  const sql = `SELECT ${ROW_COLUMNS} FROM dsh_schedule_tasks
               ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}`
  return db.query<Row>(sql, params)
}

async function queryRow(db: ScheduleDB, id: string, sessionIds: readonly string[] | undefined): Promise<Row | undefined> {
  if (sessionIds !== undefined && sessionIds.length === 0) return undefined
  await ensureScheduleTable(db)
  const params: unknown[] = [id]
  const scope = scopeClause(sessionIds, params)
  if (scope === undefined) return undefined
  const rows = await db.query<Row>(
    `SELECT ${ROW_COLUMNS} FROM dsh_schedule_tasks WHERE id = $1${scope === '' ? '' : ` AND ${scope}`}`,
    params,
  )
  return rows[0]
}

function asRule(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>
  if (value !== null && typeof value === 'object') return value as Record<string, unknown>
  return {}
}

function unpaused(rule: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...rule }
  delete copy['paused']
  return copy
}

function instant(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('schedule: bad timestamp')
  return date
}

function numberField(rule: Record<string, unknown>, key: string): number {
  const value = rule[key]
  return typeof value === 'number' ? value : Number(value)
}

/** 页面条目的 `updatedAt`；`expectedUpdatedAt` 也用它比较。 */
function updatedAtOf(row: Row): string {
  return formatInstant(instant(row.updated_at))
}

/** 行状态：active / paused（暂停标记）/ ended（一次性到期或被删除）。 */
function statusOf(row: Row): 'active' | 'paused' | 'ended' {
  if (row.status === 'active') return 'active'
  return asRule(row.rule)['paused'] === true ? 'paused' : 'ended'
}

/** 一行 → 页面条目。暂停记在规则 JSON 的 `paused` 上，表结构不动。 */
export function entryOf(row: Row): Entry {
  const rule = asRule(row.rule)
  const base: Entry = {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    scheduledAt: formatInstant(instant(row.next_run_at)),
    target: { kind: 'session', sessionId: row.session_id },
    involvedSessionIds: [row.session_id],
    status: statusOf(row),
    createdAt: formatInstant(instant(row.created_at)),
    updatedAt: updatedAtOf(row),
  }
  switch (row.kind) {
    case 'after':
      return { ...base, kind: 'after', afterSeconds: numberField(rule, 'afterSeconds') }
    case 'at':
      return { ...base, kind: 'at' }
    case 'every':
      return { ...base, kind: 'every', everySeconds: numberField(rule, 'everySeconds') }
    case 'daily':
      return { ...base, kind: 'daily', time: String(rule['time'] ?? ''), timeZone: String(rule['timeZone'] ?? '') }
    case 'weekly':
      return {
        ...base,
        kind: 'weekly',
        time: String(rule['time'] ?? ''),
        timeZone: String(rule['timeZone'] ?? ''),
        weekdays: Array.isArray(rule['weekdays']) ? rule['weekdays'] : [],
      }
    case 'cron':
      return { ...base, kind: 'cron', expression: String(rule['expression'] ?? ''), timeZone: String(rule['timeZone'] ?? '') }
    default:
      throw new Error(`schedule: unknown kind ${row.kind}`)
  }
}

/** 可执行的排前面；同刻度按更新时间和 id 稳定排序。 */
function sorted(rows: Row[]): Row[] {
  const time = (row: Row): string => row.status === 'active'
    ? formatInstant(instant(row.next_run_at))
    : updatedAtOf(row)
  return [...rows].sort((left, right) => {
    const leftActive = left.status === 'active'
    const rightActive = right.status === 'active'
    if (leftActive !== rightActive) return leftActive ? -1 : 1
    const byTime = leftActive
      ? time(left).localeCompare(time(right))
      : time(right).localeCompare(time(left))
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id)
  })
}

/** 远程计时参数 → 我们建规则用的参数。 */
function timingArgs(timing: RemoteTiming): RuleArgs {
  switch (timing.kind) {
    case 'after':
      return { after_seconds: timing.after_seconds }
    case 'at':
      return { at: timing.at }
    case 'every':
      return { every_seconds: timing.every_seconds }
    case 'daily':
      return { daily: timing.daily }
    case 'weekly':
      return { weekly: timing.weekly }
    case 'cron':
      return { cron: timing.cron }
    case 'rrule':
      return rruleArgs(timing.rrule ?? '')
  }
}

const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const

/**
 * 页面上的「一次 / 每分钟 / 每小时 / 每天 / 每周」都发 RFC 5545 文本，
 * 这里只翻译这几类受支持的写法，超出范围的（每月、复杂自定义）按输入错误退回。
 */
function rruleArgs(text: string): RuleArgs {
  const start = /^DTSTART(?:;TZID=([^:\r\n]+))?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)\s*$/m.exec(text)
  const line = /^RRULE:(.+?)\s*$/m.exec(text)
  if (start === null || line === null) {
    throw new ScheduleInputError('invalid_rule', 'Custom recurrence must contain one DTSTART line and one RRULE line.')
  }
  const zone = start[1] ?? (start[8] === 'Z' ? 'UTC' : undefined)
  if (zone === undefined) {
    throw new ScheduleInputError('invalid_rule', 'DTSTART must name a time zone or end in Z.')
  }
  const timeZone = canonicalizeZone(zone)
  const local = zonedTime(
    Number(start[2]), Number(start[3]), Number(start[4]),
    Number(start[5]), Number(start[6]), Number(start[7]), 0, timeZone,
  )
  if (local === undefined) {
    throw new ScheduleInputError('invalid_rule', 'DTSTART is not a valid local time in its time zone.')
  }
  const fields = new Map<string, string>()
  for (const part of line[1]!.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    fields.set(part.slice(0, eq).trim().toUpperCase(), part.slice(eq + 1).trim().toUpperCase())
  }
  const freq = fields.get('FREQ')
  const interval = positiveInteger(fields.get('INTERVAL') ?? '1')
  // 秒级精度：页面从不发非零 BYSECOND；出现就说明这条规则超出本部署的模型。
  const second = fields.get('BYSECOND')
  if (second !== undefined && second !== '0') {
    throw new ScheduleInputError('invalid_rule', 'Schedules on this deployment run at minute precision.')
  }
  if (freq === 'DAILY' && fields.get('COUNT') === '1') {
    allow(fields, ['FREQ', 'COUNT', 'INTERVAL', 'BYSECOND'])
    if (interval !== 1) throw unsupported()
    return { at: formatInstant(local) }
  }
  if (freq === 'MINUTELY' || freq === 'HOURLY') {
    allow(fields, ['FREQ', 'INTERVAL', 'BYSECOND'])
    return { every_seconds: interval * (freq === 'HOURLY' ? 3_600 : 60) }
  }
  if (freq === 'DAILY') {
    allow(fields, ['FREQ', 'INTERVAL', 'BYHOUR', 'BYMINUTE', 'BYSECOND'])
    if (interval !== 1) throw unsupported()
    return { daily: { time: `${clock(fields, start)}:00`, time_zone: timeZone } }
  }
  if (freq === 'WEEKLY') {
    allow(fields, ['FREQ', 'INTERVAL', 'BYDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND'])
    if (interval !== 1) throw unsupported()
    const weekdays = (fields.get('BYDAY') ?? '').split(',').filter(Boolean)
      .map((day) => {
        const index = WEEKDAY_CODES.indexOf(day as typeof WEEKDAY_CODES[number])
        if (index < 0) throw unsupported()
        return index + 1
      })
    if (weekdays.length === 0) {
      throw new ScheduleInputError('invalid_rule', 'A weekly recurrence must name at least one weekday.')
    }
    return { weekly: { time: `${clock(fields, start)}:00`, time_zone: timeZone, weekdays } }
  }
  throw unsupported()
}

function unsupported(): ScheduleInputError {
  return new ScheduleInputError(
    'invalid_rule',
    'This recurrence is not supported by this deployment. Use a one-time, interval, daily, weekly, or cron schedule.',
  )
}

function allow(fields: Map<string, string>, keys: readonly string[]): void {
  for (const key of fields.keys()) if (!keys.includes(key)) throw unsupported()
}

function positiveInteger(value: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw unsupported()
  return number
}

/** BYHOUR/BYMINUTE 成对出现；都没有就用 DTSTART 的时钟。 */
function clock(fields: Map<string, string>, start: RegExpExecArray): string {
  const hour = fields.get('BYHOUR')
  const minute = fields.get('BYMINUTE')
  if (hour === undefined && minute === undefined) return `${start[5]}:${start[6]}`
  if (hour === undefined || minute === undefined) {
    throw new ScheduleInputError('invalid_rule', 'BYHOUR and BYMINUTE must appear together.')
  }
  const h = Number(hour)
  const m = Number(minute)
  if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(m) || m < 0 || m > 59) {
    throw new ScheduleInputError('invalid_rule', 'BYHOUR/BYMINUTE are not a valid clock time.')
  }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 恢复周期任务：按原规则算下一次；一次性任务没有可恢复的未来时刻。 */
function resumeNext(kind: string, rule: Record<string, unknown>, now: Date): Date {
  switch (kind) {
    case 'every': {
      const anchor = typeof rule['anchor'] === 'string' ? instant(rule['anchor']) : now
      return nextEvery(anchor, numberField(rule, 'everySeconds'), now)
    }
    case 'daily': {
      const zone = canonicalizeZone(String(rule['timeZone'] ?? 'UTC'))
      return nextClock(zone, parseClock(String(rule['time'] ?? '00:00:00')), null, now)
    }
    case 'weekly': {
      const zone = canonicalizeZone(String(rule['timeZone'] ?? 'UTC'))
      const weekdays = Array.isArray(rule['weekdays']) ? rule['weekdays'] as number[] : []
      return nextClock(zone, parseClock(String(rule['time'] ?? '00:00:00')), weekdays, now)
    }
    case 'cron': {
      const zone = canonicalizeZone(String(rule['timeZone'] ?? 'UTC'))
      return nextCron(String(rule['expression'] ?? ''), zone, now)
    }
    default:
      throw new ScheduleInputError(
        'not_future',
        'This task has no future occurrence. Set a future schedule before resuming it.',
      )
  }
}

function checkedTitle(title: unknown): string {
  const value = title === undefined ? '' : String(title).trim()
  if (value === '') throw new ScheduleInputError('invalid_prompt', 'title is required and must be non-empty after trimming.')
  if (value.length > MAX_TITLE_LENGTH) {
    throw new ScheduleInputError('invalid_prompt', `title must be at most ${MAX_TITLE_LENGTH} characters.`)
  }
  return value
}

function checkedPrompt(prompt: unknown): string {
  if (prompt === undefined) throw new ScheduleInputError('invalid_prompt', 'prompt is required and must be non-empty after trimming.')
  const value = String(prompt).trim()
  if (value === '') throw new ScheduleInputError('invalid_prompt', 'prompt is required and must be non-empty after trimming.')
  return value
}

function targetSessionId(target: RemoteTarget | undefined): string {
  if (target === undefined) {
    throw new ScheduleInputError('invalid_rule', 'A Session target is required.')
  }
  if (target.kind !== 'session' || target.sessionId === undefined || target.sessionId === '') {
    throw new ScheduleInputError(
      'invalid_rule',
      'This deployment delivers reminders into an existing Session; choose a Session target.',
    )
  }
  return target.sessionId
}

function assertOwned(sessionId: string, sessionIds: readonly string[] | undefined): void {
  if (sessionIds !== undefined && !sessionIds.includes(sessionId)) {
    throw new ScheduleInputError('invalid_rule', `Session "${sessionId}" was not found.`)
  }
}

/**
 * 更新一行时把 `updated_at` 推到严格晚于上次的刻度，`expectedUpdatedAt`
 * 才能识别同一毫秒内的第二次修改。
 */
async function updateRow(db: ScheduleDB, row: Row, fields: Record<string, unknown>): Promise<Row | undefined> {
  await ensureScheduleTable(db)
  const revised = new Date(Math.max(Date.now(), instant(row.updated_at).getTime() + 1))
  const next: Record<string, unknown> = { ...fields, updated_at: revised.toISOString() }
  const params: unknown[] = [row.id]
  const sets = Object.keys(next).map((name) => {
    params.push(next[name])
    return `${name} = $${params.length}${name === 'rule' ? '::jsonb' : ''}`
  })
  const rows = await db.query<Row>(
    `UPDATE dsh_schedule_tasks
        SET ${sets.join(', ')}, generation = generation + 1,
            lease_owner = NULL, lease_until = NULL, pending_occurrence = NULL
      WHERE id = $1
      RETURNING ${ROW_COLUMNS}`,
    params,
  )
  return rows[0]
}

/** 官方客户端页面用的 Remote 服务；平台代理补 `sessionIds` 限定成员范围。 */
export class ScheduleRemoteService extends TypertRemoteService {
  constructor(ctx: Context, private readonly db: ScheduleDB) {
    super(ctx, 'schedule')
  }

  @Remote('catalog')
  async remoteCatalog(sessionIds?: string[]): Promise<Entry[]> {
    return sorted(await queryRows(this.db, sessionIds, undefined)).map(entryOf)
  }

  @Remote('list')
  async remoteList(request: RemoteListRequest | undefined, sessionIds?: string[]): Promise<{
    items: Entry[]; shown: number; total: number; limit: number; offset: number
  }> {
    const asked = request ?? {}
    const limit = asked.limit ?? DEFAULT_LIST_LIMIT
    const offset = asked.offset ?? 0
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw inputFailure(new ScheduleInputError('invalid_rule', `limit must be a safe integer from 1 through ${MAX_LIST_LIMIT}.`))
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw inputFailure(new ScheduleInputError('invalid_rule', 'offset must be a non-negative safe integer.'))
    }
    const status = asked.active === true ? 'active' : asked.active === false ? 'inactive' : undefined
    const items = sorted(await queryRows(this.db, sessionIds, status)).map(entryOf)
    const page = items.slice(offset, offset + limit)
    return { items: page, shown: page.length, total: items.length, limit, offset }
  }

  @Remote('view')
  async remoteView(request: RemoteViewRequest | undefined, sessionIds?: string[]): Promise<Entry | { id: string; code: 'schedule_not_found' }> {
    const id = String(request?.id ?? '')
    const row = await queryRow(this.db, id, sessionIds)
    return row === undefined ? { id, code: 'schedule_not_found' } : entryOf(row)
  }

  @Remote('history')
  async remoteHistory(request: RemoteHistoryRequest | undefined, sessionIds?: string[]): Promise<Entry> {
    const id = String(request?.id ?? '')
    const limit = request?.limit
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_HISTORY_LIMIT) {
      throw inputFailure(new ScheduleInputError('invalid_rule', `Delivery history limit must be a safe integer from 1 through ${MAX_HISTORY_LIMIT}.`))
    }
    const row = await queryRow(this.db, id, sessionIds)
    if (row === undefined) return { id, code: 'schedule_not_found' }
    // 平台认领投递，但脑不保存投递回执；页面按空历史展示。
    if (request?.before !== undefined) return { id, code: 'delivery_cursor_not_found' }
    return {
      id,
      records: [],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
      retention: HISTORY_RETENTION,
    }
  }

  @Remote('deliveryLimits')
  async remoteDeliveryLimits(): Promise<{ newSessionIntervalSeconds: number }> {
    return { newSessionIntervalSeconds: NEW_SESSION_INTERVAL_SECONDS }
  }

  @Remote('run')
  async remoteRun(request: RemoteRunRequest | undefined, sessionIds?: string[]): Promise<Entry | { id: string; code: 'schedule_not_found' }> {
    const id = String(request?.id ?? '')
    const row = await queryRow(this.db, id, sessionIds)
    if (row === undefined) return { id, code: 'schedule_not_found' }
    const now = new Date()
    const updated = await updateRow(this.db, row, {
      status: 'active',
      rule: JSON.stringify(unpaused(asRule(row.rule))),
      next_run_at: now.toISOString(),
      attempt_count: 0,
    })
    this.emitChanged()
    return entryOf(updated ?? row)
  }

  @Remote('edit')
  async remoteEdit(request: RemoteEditRequest | undefined, sessionIds?: string[]): Promise<Entry | { id: string; code: string }> {
    try {
      const body = request ?? { action: 'update' as const, id: '' }
      const id = String(body.id ?? '')
      const row = await queryRow(this.db, id, sessionIds)
      if (row === undefined) return { id, code: 'schedule_not_found' }
      if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== updatedAtOf(row)) {
        return { id, code: 'schedule_conflict' }
      }
      if (body.action === 'delete') {
        await ensureScheduleTable(this.db)
        await this.db.query(`DELETE FROM dsh_schedule_tasks WHERE id = $1`, [id])
        this.emitChanged()
        return { id, deleted: true }
      }
      return await this.applyUpdate(row, body, sessionIds)
    } catch (error) {
      throw inputFailure(error)
    }
  }

  @Remote('deleteInactive')
  async remoteDeleteInactive(sessionIds?: string[]): Promise<{ deleted: number }> {
    const ended = (await queryRows(this.db, sessionIds, 'inactive'))
      .filter((row) => asRule(row.rule)['paused'] !== true)
      .map((row) => row.id)
    if (ended.length === 0) return { deleted: 0 }
    const params: unknown[] = []
    const list = marks(params, ended)
    await this.db.query(`DELETE FROM dsh_schedule_tasks WHERE id IN (${list})`, params)
    this.emitChanged()
    return { deleted: ended.length }
  }

  @Remote('create')
  async remoteCreate(request: RemoteCreateRequest | undefined, sessionIds?: string[]): Promise<Entry> {
    try {
      const sessionId = targetSessionId(request?.target)
      assertOwned(sessionId, sessionIds)
      const timing = request?.timing
      if (timing === undefined) throw new ScheduleInputError('invalid_selector', 'A timing rule is required.')
      const created = await createTask(this.db, sessionId, {
        title: checkedTitle(request?.title),
        prompt: checkedPrompt(request?.prompt),
        ...timingArgs(timing),
      })
      const id = String((created as { id?: unknown }).id ?? '')
      const row = await queryRow(this.db, id, sessionIds)
      if (row === undefined) throw new Error('schedule: created task disappeared')
      this.emitChanged()
      return entryOf(row)
    } catch (error) {
      throw inputFailure(error)
    }
  }

  private async applyUpdate(row: Row, request: RemoteEditUpdate, sessionIds?: string[]): Promise<Entry | { id: string; code: string }> {
    const patch = request.patch ?? {}
    if (Object.keys(patch).length === 0) {
      throw new ScheduleInputError('invalid_rule', 'An update patch requires at least one field.')
    }
    const now = new Date()
    const fields: Record<string, unknown> = {}
    const rule = asRule(row.rule)
    let kind = row.kind
    let effectiveRule: Record<string, unknown> | undefined
    let nextRun: Date | undefined
    let timingChanged = false

    if (patch.target !== undefined) {
      const target = targetSessionId(patch.target)
      assertOwned(target, sessionIds)
      fields['session_id'] = target
    }
    if (patch.title !== undefined) fields['title'] = checkedTitle(patch.title)
    if (patch.prompt !== undefined) fields['prompt'] = checkedPrompt(patch.prompt)

    if (patch.timing !== undefined) {
      const built = buildRule(timingArgs(patch.timing), now)
      // `after` 每次都按现在重新计时；同值不动的周期规则保留原锚点。
      const changedTiming = patch.timing.kind === 'after'
        || built.kind !== row.kind
        || JSON.stringify(built.rule) !== JSON.stringify(unpaused(rule))
      if (changedTiming) {
        kind = built.kind
        nextRun = built.at
        effectiveRule = built.rule
        timingChanged = true
        fields['kind'] = built.kind
        fields['desired_at'] = built.at.toISOString()
      }
    }

    const current = statusOf(row)
    let paused = current === 'paused'
    let armed = current === 'active' || (timingChanged && current === 'ended')
    if (patch.active === false) {
      paused = true
      armed = false
    } else if (patch.active === true) {
      paused = false
      armed = true
      fields['attempt_count'] = 0
      if (nextRun === undefined && !timingChanged) nextRun = resumeNext(kind, unpaused(rule), now)
      effectiveRule = effectiveRule ?? unpaused(rule)
    }
    if (paused) {
      effectiveRule = { ...(effectiveRule ?? unpaused(rule)), paused: true }
    } else if (effectiveRule !== undefined) {
      effectiveRule = unpaused(effectiveRule)
    }
    if (effectiveRule !== undefined) fields['rule'] = JSON.stringify(effectiveRule)
    fields['status'] = armed ? 'active' : 'inactive'
    if (nextRun !== undefined) fields['next_run_at'] = nextRun.toISOString()

    const updated = await updateRow(this.db, row, fields)
    this.emitChanged()
    if (updated === undefined) return { id: row.id, code: 'schedule_not_found' }
    return entryOf(updated)
  }

  private emitChanged(): void {
    this.ctx.emit('schedule/changed')
  }
}

/** 输入错误转成客户端认得的 `schedule/input-invalid`。 */
function inputFailure(error: unknown): never {
  if (error instanceof ScheduleInputError) {
    throw new RemoteError('schedule/input-invalid', error.message, { code: error.code as ScheduleInputErrorCode })
  }
  throw error
}
