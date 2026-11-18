/**
 * 把定时任务写进共用表 dsh_schedule_tasks。
 * 脑只写定义；租约和到期推进由平台写。这里不调用平台。
 */

import { randomBytes } from 'node:crypto'
import {
  ScheduleInputError, afterDelay, assertCron, canonicalizeZone, formatInstant, nextClock, nextCron,
  nextEvery, parseAt, parseClock, type LocalAtInput,
} from './time.ts'

export interface ScheduleDB {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>
  /** 本地 SQLite 与部署 PostgreSQL 的 DDL 类型不同；缺省按 PostgreSQL。 */
  readonly dialect?: string
}

const CREATE_TABLE_PG = `
CREATE TABLE IF NOT EXISTS dsh_schedule_tasks (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  title text NOT NULL,
  prompt text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('after', 'at', 'every', 'daily', 'weekly', 'cron')),
  rule jsonb NOT NULL,
  generation bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'inactive')),
  desired_at timestamptz NOT NULL,
  next_run_at timestamptz NOT NULL,
  lease_owner text,
  lease_until timestamptz,
  last_request_id text,
  last_delivery text CHECK (last_delivery IS NULL OR last_delivery IN ('accepted', 'unknown', 'rejected')),
  attempt_count integer NOT NULL DEFAULT 0,
  pending_occurrence timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)`

const CREATE_INDEX = `
CREATE INDEX IF NOT EXISTS dsh_schedule_tasks_due_idx
  ON dsh_schedule_tasks (next_run_at)
  WHERE status = 'active'`

const CREATE_TABLE_SQLITE = `
CREATE TABLE IF NOT EXISTS dsh_schedule_tasks (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  title text NOT NULL,
  prompt text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('after', 'at', 'every', 'daily', 'weekly', 'cron')),
  rule text NOT NULL,
  generation integer NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'inactive')),
  desired_at text NOT NULL,
  next_run_at text NOT NULL,
  lease_owner text,
  lease_until text,
  last_request_id text,
  last_delivery text CHECK (last_delivery IS NULL OR last_delivery IN ('accepted', 'unknown', 'rejected')),
  attempt_count integer NOT NULL DEFAULT 0,
  pending_occurrence text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)`

export interface CreateArgs {
  prompt: string
  title: string
  after_seconds?: number
  at?: string | LocalAtInput
  every_seconds?: number
  daily?: { time: string; time_zone: string }
  weekly?: { time: string; time_zone: string; weekdays: number[] }
  cron?: { expression: string; time_zone: string }
}

export interface UpdateArgs {
  id: string
  title?: string
  prompt?: string
  at?: string | LocalAtInput
  every_seconds?: number
  daily?: { time: string; time_zone: string }
  weekly?: { time: string; time_zone: string; weekdays: number[] }
  cron?: { expression: string; time_zone: string }
}

/** 计时部分；Remote 层不带 title/prompt，也要能复用同一套规则构建。 */
export type RuleArgs = Omit<CreateArgs, 'title' | 'prompt'>

interface TaskRow {
  id: string
  title: string
  prompt: string
  kind: string
  rule: unknown
  generation: string | number
  status: string
  next_run_at: Date | string
}

let ready: Promise<void> | undefined

export function ensureScheduleTable(db: ScheduleDB): Promise<void> {
  if (ready !== undefined) return ready
  ready = (async () => {
    try {
      await db.query(db.dialect === 'sqlite' ? CREATE_TABLE_SQLITE : CREATE_TABLE_PG)
      await db.query(CREATE_INDEX)
    } catch (error) {
      ready = undefined
      throw error
    }
  })()
  return ready
}

export async function createTask(db: ScheduleDB, sessionId: string, args: CreateArgs, now = new Date()): Promise<unknown> {
  await ensureScheduleTable(db)
  const title = args.title.trim()
  const prompt = args.prompt.trim()
  const built = buildRule(args, now)
  const id = `sch_${randomBytes(8).toString('hex')}`
  const rows = await db.query<TaskRow>(`
    INSERT INTO dsh_schedule_tasks (
      id, session_id, title, prompt, kind, rule, generation, status, desired_at, next_run_at
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, 'active', $7, $8)
    RETURNING id, title, prompt, kind, rule, generation, status, next_run_at
  `, [id, sessionId, title, prompt, built.kind, JSON.stringify(built.rule), built.at.toISOString(), built.at.toISOString()])
  const row = rows[0]
  if (row === undefined) throw new Error('schedule: insert returned no row')
  return viewOf(row, now)
}

export async function listTasks(db: ScheduleDB, sessionId: string, now = new Date()): Promise<unknown> {
  await ensureScheduleTable(db)
  const rows = await db.query<TaskRow>(`
    SELECT id, title, prompt, kind, rule, generation, status, next_run_at
    FROM dsh_schedule_tasks
    WHERE session_id = $1 AND status = 'active'
    ORDER BY next_run_at
  `, [sessionId])
  return rows.map(row => viewOf(row, now))
}

export async function deleteTask(db: ScheduleDB, sessionId: string, id: string): Promise<unknown> {
  await ensureScheduleTable(db)
  const rows = await db.query<{ id: string }>(`
    UPDATE dsh_schedule_tasks
    SET status = 'inactive', generation = generation + 1,
        lease_owner = NULL, lease_until = NULL, pending_occurrence = NULL, updated_at = now()
    WHERE id = $1 AND session_id = $2
    RETURNING id
  `, [id, sessionId])
  if (rows.length === 0) return { id, deleted: false, code: 'schedule_not_found' }
  return { id, deleted: true }
}

export async function updateTask(db: ScheduleDB, sessionId: string, args: UpdateArgs, now = new Date()): Promise<unknown> {
  await ensureScheduleTable(db)
  const current = await db.query<TaskRow>(`
    SELECT id, title, prompt, kind, rule, generation, status, next_run_at
    FROM dsh_schedule_tasks
    WHERE id = $1 AND session_id = $2
  `, [args.id, sessionId])
  const row = current[0]
  if (row === undefined) return { id: args.id, updated: false, code: 'schedule_not_found' }
  if (row.status !== 'active') return { id: args.id, updated: false, code: 'schedule_ended' }
  const title = args.title === undefined ? row.title : args.title.trim()
  const prompt = args.prompt === undefined ? row.prompt : args.prompt.trim()
  const generation = Number(row.generation)
  const timing = hasTiming(args) ? buildRule(args, now) : undefined
  const rows = timing === undefined
    ? await db.query<TaskRow>(`
        UPDATE dsh_schedule_tasks
        SET title = $1, prompt = $2, generation = generation + 1,
            lease_owner = NULL, lease_until = NULL, pending_occurrence = NULL, updated_at = now()
        WHERE id = $3 AND session_id = $4 AND status = 'active' AND generation = $5
        RETURNING id, title, prompt, kind, rule, generation, status, next_run_at
      `, [title, prompt, args.id, sessionId, generation])
    : await db.query<TaskRow>(`
        UPDATE dsh_schedule_tasks
        SET title = $1, prompt = $2, kind = $3, rule = $4::jsonb,
            desired_at = $5, next_run_at = $5, generation = generation + 1,
            lease_owner = NULL, lease_until = NULL, attempt_count = 0,
            pending_occurrence = NULL, updated_at = now()
        WHERE id = $6 AND session_id = $7 AND status = 'active' AND generation = $8
        RETURNING id, title, prompt, kind, rule, generation, status, next_run_at
      `, [title, prompt, timing.kind, JSON.stringify(timing.rule), timing.at.toISOString(), args.id, sessionId, generation])
  const saved = rows[0]
  if (saved !== undefined) return viewOf(saved, now)
  const again = await db.query<{ status: string }>(`
    SELECT status FROM dsh_schedule_tasks WHERE id = $1 AND session_id = $2
  `, [args.id, sessionId])
  const status = again[0]?.status
  if (status === undefined) return { id: args.id, updated: false, code: 'schedule_not_found' }
  if (status !== 'active') return { id: args.id, updated: false, code: 'schedule_ended' }
  return { id: args.id, updated: false, code: 'schedule_conflict' }
}

function hasTiming(args: UpdateArgs): boolean {
  return args.at !== undefined || args.every_seconds !== undefined || args.daily !== undefined || args.weekly !== undefined || args.cron !== undefined
}

export function buildRule(args: CreateArgs | UpdateArgs | RuleArgs, now: Date): { kind: string; rule: Record<string, unknown>; at: Date } {
  if ('after_seconds' in args && args.after_seconds !== undefined) {
    return { kind: 'after', rule: { afterSeconds: args.after_seconds }, at: afterDelay(args.after_seconds, now) }
  }
  if (args.at !== undefined) {
    return { kind: 'at', rule: {}, at: parseAt(args.at, now) }
  }
  if (args.every_seconds !== undefined) {
    const at = nextEvery(now, args.every_seconds, now)
    return { kind: 'every', rule: { everySeconds: args.every_seconds, anchor: formatInstant(now) }, at }
  }
  if (args.daily !== undefined) {
    const clock = parseClock(args.daily.time)
    const zone = canonicalizeZone(args.daily.time_zone)
    return { kind: 'daily', rule: { time: clock.normalized, timeZone: zone }, at: nextClock(zone, clock, null, now) }
  }
  if (args.weekly !== undefined) {
    const clock = parseClock(args.weekly.time)
    const zone = canonicalizeZone(args.weekly.time_zone)
    const weekdays = normalizeWeekdays(args.weekly.weekdays)
    return { kind: 'weekly', rule: { time: clock.normalized, timeZone: zone, weekdays }, at: nextClock(zone, clock, weekdays, now) }
  }
  if (args.cron !== undefined) {
    const zone = canonicalizeZone(args.cron.time_zone)
    const expression = assertCron(args.cron.expression, zone, now)
    return { kind: 'cron', rule: { expression, timeZone: zone }, at: nextCron(expression, zone, now) }
  }
  throw new ScheduleInputError('invalid_selector', 'A timing rule is required.')
}

function normalizeWeekdays(weekdays: unknown): number[] {
  if (!Array.isArray(weekdays) || weekdays.length === 0) {
    throw new ScheduleInputError('invalid_rule', 'weekly.weekdays must be a non-empty array of ISO weekday numbers.')
  }
  const seen = new Set<number>()
  for (const weekday of weekdays) {
    if (!Number.isSafeInteger(weekday) || weekday < 1 || weekday > 7) {
      throw new ScheduleInputError('invalid_rule', 'Each weekly.weekdays entry must be an integer from 1 (Monday) through 7 (Sunday).')
    }
    if (seen.has(weekday)) {
      throw new ScheduleInputError('invalid_rule', `weekly.weekdays must not repeat weekday ${weekday}.`)
    }
    seen.add(weekday)
  }
  return [...seen].sort((a, b) => a - b)
}

function viewOf(row: TaskRow, now: Date): Record<string, unknown> {
  const at = asDate(row.next_run_at)
  const rule = asRule(row.rule)
  const base = {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    scheduledAt: formatInstant(at),
    state: at.getTime() <= now.getTime() ? 'overdue' : 'scheduled',
    deliveryMode: 'host',
  }
  switch (row.kind) {
    case 'after':
      return { ...base, kind: 'after', afterSeconds: numberField(rule, 'afterSeconds') }
    case 'at':
      return { ...base, kind: 'at' }
    case 'every':
      return { ...base, kind: 'every', everySeconds: numberField(rule, 'everySeconds') }
    case 'daily':
      return { ...base, kind: 'daily', time: stringField(rule, 'time'), timeZone: stringField(rule, 'timeZone') }
    case 'weekly':
      return {
        ...base,
        kind: 'weekly',
        time: stringField(rule, 'time'),
        timeZone: stringField(rule, 'timeZone'),
        weekdays: arrayField(rule, 'weekdays'),
      }
    case 'cron':
      return { ...base, kind: 'cron', expression: stringField(rule, 'expression'), timeZone: stringField(rule, 'timeZone') }
    default:
      throw new Error('schedule: unknown kind')
  }
}

function asDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('schedule: bad timestamp')
  return date
}

function asRule(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>
  if (value !== null && typeof value === 'object') return value as Record<string, unknown>
  return {}
}

function numberField(rule: Record<string, unknown>, key: string): number {
  const value = rule[key]
  return typeof value === 'number' ? value : Number(value)
}

function stringField(rule: Record<string, unknown>, key: string): string {
  const value = rule[key]
  return typeof value === 'string' ? value : ''
}

function arrayField(rule: Record<string, unknown>, key: string): number[] {
  const value = rule[key]
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : []
}

export function toolError(error: unknown): { code: string; message: string } {
  if (error instanceof ScheduleInputError) return { code: error.code, message: error.message }
  return { code: 'internal_error', message: 'The schedule operation failed.' }
}
