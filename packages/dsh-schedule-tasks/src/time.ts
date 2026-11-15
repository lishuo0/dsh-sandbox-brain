/**
 * 定时任务的时刻计算。平台 service/schedule_time.go 用同一组用例对齐。
 * 不启动计时器，也不访问平台 HTTP。
 */

const MIN_EVERY_SECONDS = 60
const IANA_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/
const OFFSET_INSTANT = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,3}))?(?<zone>Z|(?<sign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/
const LOCAL_DATE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/
const LOCAL_TIME = /^(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,3}))?$/

const MONTH_NAMES: readonly (readonly [string, string])[] = [
  ['january', '1'], ['february', '2'], ['march', '3'], ['april', '4'],
  ['may', '5'], ['june', '6'], ['july', '7'], ['august', '8'],
  ['september', '9'], ['october', '10'], ['november', '11'], ['december', '12'],
  ['jan', '1'], ['feb', '2'], ['mar', '3'], ['apr', '4'],
  ['jun', '6'], ['jul', '7'], ['aug', '8'], ['sep', '9'], ['oct', '10'], ['nov', '11'], ['dec', '12'],
]
const DOW_NAMES: readonly (readonly [string, string])[] = [
  ['sunday', '0'], ['monday', '1'], ['tuesday', '2'], ['wednesday', '3'],
  ['thursday', '4'], ['friday', '5'], ['saturday', '6'],
  ['sun', '0'], ['mon', '1'], ['tue', '2'], ['wed', '3'], ['thu', '4'], ['fri', '5'], ['sat', '6'],
]
const ISO_WEEKDAY: Record<string, number> = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const CRON_WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export const MAX_TITLE_LENGTH = 120
export const MIN_EVERY_INTERVAL_SECONDS = MIN_EVERY_SECONDS

export class ScheduleInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ScheduleInputError'
  }
}

export interface ClockParts {
  hour: number
  minute: number
  second: number
  millisecond: number
  normalized: string
}

export interface LocalAtInput {
  date: string
  time: string
  time_zone: string
}

interface ZoneParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: string
}

interface CronSpec {
  minute: CronField
  hour: CronField
  dom: CronField
  month: CronField
  dow: CronField
}

interface CronField {
  min: number
  max: number
  bits: boolean[]
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>()

export function formatInstant(date: Date): string {
  return date.toISOString()
}

export function canonicalizeZone(value: string): string {
  if (value.length === 0 || value.trim() !== value || (value !== 'UTC' && !IANA_ZONE.test(value))) {
    throw new ScheduleInputError('invalid_time_zone', 'time_zone must be UTC or a valid IANA Area/Location name.')
  }
  let canonical: string
  try {
    canonical = formatter(value).resolvedOptions().timeZone
  } catch {
    throw new ScheduleInputError('invalid_time_zone', 'time_zone must be UTC or a valid IANA Area/Location name.')
  }
  if (canonical !== 'UTC' && !IANA_ZONE.test(canonical)) {
    throw new ScheduleInputError('invalid_time_zone', 'time_zone must resolve to UTC or an IANA Area/Location name.')
  }
  return canonical
}

export function parseClock(value: string): ClockParts {
  const match = LOCAL_TIME.exec(value)
  const groups = match?.groups
  if (groups === undefined) {
    throw new ScheduleInputError('invalid_rule', 'time must be HH:mm:ss with optional one-to-three digit milliseconds.')
  }
  const hour = Number(groups['hour'])
  const minute = Number(groups['minute'])
  const second = Number(groups['second'])
  if (hour > 23 || minute > 59 || second > 59) {
    throw new ScheduleInputError('invalid_rule', 'time must be a real clock time.')
  }
  const millisecond = groups['fraction'] === undefined ? 0 : Number(groups['fraction'].padEnd(3, '0'))
  return {
    hour, minute, second, millisecond,
    normalized: `${pad(hour)}:${pad(minute)}:${pad(second)}.${String(millisecond).padStart(3, '0')}`,
  }
}

export function parseAt(value: string | LocalAtInput, now: Date): Date {
  const instant = typeof value === 'string' ? parseOffsetInstant(value) : parseLocalAt(value)
  assertRange(instant, now)
  if (instant.getTime() <= now.getTime()) {
    throw new ScheduleInputError('not_future', 'The scheduled time must be strictly in the future.')
  }
  return instant
}

export function afterDelay(seconds: number, now: Date): Date {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new ScheduleInputError('invalid_rule', 'after_seconds must be a positive safe integer.')
  }
  const instant = new Date(now.getTime() + seconds * 1000)
  assertRange(instant, now)
  return instant
}

export function nextEvery(anchor: Date, everySeconds: number, after: Date): Date {
  assertInterval(everySeconds)
  const step = everySeconds * 1000
  const anchorMs = anchor.getTime()
  const afterMs = after.getTime()
  if (afterMs < anchorMs) return new Date(anchorMs + step)
  const n = Math.floor((afterMs - anchorMs) / step)
  return new Date(anchorMs + (n + 1) * step)
}

export function latestEvery(anchor: Date, everySeconds: number, now: Date): Date {
  assertInterval(everySeconds)
  const step = everySeconds * 1000
  const anchorMs = anchor.getTime()
  const nowMs = now.getTime()
  if (nowMs < anchorMs + step) return new Date(anchorMs + step)
  const n = Math.floor((nowMs - anchorMs) / step)
  return new Date(anchorMs + n * step)
}

export function nextClock(zone: string, parts: ClockParts, weekdays: readonly number[] | null, after: Date): Date {
  return walkClock(zone, parts, weekdays, after, 1)
}

export function latestClock(zone: string, parts: ClockParts, weekdays: readonly number[] | null, now: Date): Date {
  return walkClock(zone, parts, weekdays, now, -1)
}

export function nextCron(expression: string, zone: string, after: Date): Date {
  const found = walkCron(expression, zone, after, 1)
  if (found === undefined) throw new ScheduleInputError('time_out_of_range', 'The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.')
  return found
}

export function latestCron(expression: string, zone: string, now: Date): Date {
  const found = walkCron(expression, zone, now, -1)
  if (found === undefined) throw new ScheduleInputError('time_out_of_range', 'The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.')
  return found
}

export function assertCron(expression: string, zone: string, now: Date): string {
  canonicalizeZone(zone)
  nextCron(expression, zone, now)
  return expression.trim().replace(/\s+/g, ' ')
}

function walkClock(zone: string, parts: ClockParts, weekdays: readonly number[] | null, pivot: Date, direction: 1 | -1): Date {
  canonicalizeZone(zone)
  const local = zoneParts(pivot, zone)
  let cursor = { year: local.year, month: local.month, day: local.day }
  for (let i = 0; i < 370; i++) {
    const noon = zonedTime(cursor.year, cursor.month, cursor.day, 12, 0, 0, 0, zone)
    if (noon !== undefined && (weekdays === null || weekdays.includes(isoWeekday(noon, zone)))) {
      const candidate = zonedTime(cursor.year, cursor.month, cursor.day, parts.hour, parts.minute, parts.second, parts.millisecond, zone)
      if (candidate !== undefined && (direction > 0 ? candidate.getTime() > pivot.getTime() : candidate.getTime() <= pivot.getTime())) {
        return candidate
      }
    }
    const stepped = addLocalDays(cursor.year, cursor.month, cursor.day, direction, zone)
    cursor = stepped
  }
  throw new ScheduleInputError('time_out_of_range', 'The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.')
}

function walkCron(expression: string, zone: string, pivot: Date, direction: 1 | -1): Date | undefined {
  const spec = parseCron(expression)
  canonicalizeZone(zone)
  const local = zoneParts(pivot, zone)
  let cursor = { year: local.year, month: local.month, day: local.day }
  const hours = fieldValues(spec.hour)
  const minutes = fieldValues(spec.minute)
  for (let i = 0; i < 370; i++) {
    if (spec.month.bits[cursor.month]) {
      let best: Date | undefined
      for (const hour of hours) {
        for (const minute of minutes) {
          const candidate = zonedTime(cursor.year, cursor.month, cursor.day, hour, minute, 0, 0, zone)
          if (candidate === undefined) continue
          const inWindow = direction > 0 ? candidate.getTime() > pivot.getTime() : candidate.getTime() <= pivot.getTime()
          if (!inWindow) continue
          const parts = zoneParts(candidate, zone)
          if (!cronDayMatches(spec, parts.day, CRON_WEEKDAY[parts.weekday] ?? -1)) continue
          if (direction > 0) return candidate
          if (best === undefined || candidate.getTime() > best.getTime()) best = candidate
        }
      }
      if (best !== undefined) return best
    }
    cursor = addLocalDays(cursor.year, cursor.month, cursor.day, direction, zone)
  }
  return undefined
}

function parseOffsetInstant(value: string): Date {
  const match = OFFSET_INSTANT.exec(value)
  const groups = match?.groups
  if (groups === undefined) {
    throw new ScheduleInputError('invalid_rule', 'at must use YYYY-MM-DDTHH:mm:ss with optional 1-3 digit fractional seconds and an explicit Z or numeric offset.')
  }
  const year = Number(groups['year'])
  const month = Number(groups['month'])
  const day = Number(groups['day'])
  const hour = Number(groups['hour'])
  const minute = Number(groups['minute'])
  const second = Number(groups['second'])
  const millisecond = groups['fraction'] === undefined ? 0 : Number(groups['fraction'].padEnd(3, '0'))
  if (year < 1000 || hour > 23 || minute > 59 || second > 59 || !realDate(year, month, day)) {
    throw new ScheduleInputError('invalid_rule', 'The at value must be a real ISO calendar date and time.')
  }
  const local = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  if (groups['zone'] === 'Z') return new Date(local)
  const offsetHour = Number(groups['offsetHour'])
  const offsetMinute = Number(groups['offsetMinute'])
  if (offsetHour > 23 || offsetMinute > 59 || (groups['sign'] === '-' && offsetHour === 0 && offsetMinute === 0)) {
    throw new ScheduleInputError('invalid_rule', 'The at numeric offset is invalid.')
  }
  const direction = groups['sign'] === '+' ? 1 : -1
  return new Date(local - direction * (offsetHour * 60 + offsetMinute) * 60_000)
}

function parseLocalAt(value: LocalAtInput): Date {
  if (value === null || typeof value !== 'object' || typeof value.date !== 'string' || typeof value.time !== 'string' || typeof value.time_zone !== 'string') {
    throw new ScheduleInputError('invalid_rule', 'Local at requires date YYYY-MM-DD and time HH:mm:ss with optional one-to-three digit milliseconds.')
  }
  const date = LOCAL_DATE.exec(value.date)?.groups
  const clock = parseClock(value.time)
  if (date === undefined) {
    throw new ScheduleInputError('invalid_rule', 'Local at requires date YYYY-MM-DD and time HH:mm:ss with optional one-to-three digit milliseconds.')
  }
  const year = Number(date['year'])
  const month = Number(date['month'])
  const day = Number(date['day'])
  if (year < 1000 || !realDate(year, month, day)) {
    throw new ScheduleInputError('invalid_rule', 'The at value must be a real ISO calendar date and time.')
  }
  const zone = canonicalizeZone(value.time_zone)
  const instant = zonedTime(year, month, day, clock.hour, clock.minute, clock.second, clock.millisecond, zone)
  if (instant === undefined) {
    throw new ScheduleInputError('invalid_rule', 'The local at time does not exist in the selected time zone.')
  }
  return instant
}

function assertRange(instant: Date, now: Date): void {
  const year = instant.getUTCFullYear()
  if (!Number.isFinite(instant.getTime()) || !Number.isFinite(now.getTime()) || year < 1000 || year > 9999) {
    throw new ScheduleInputError('time_out_of_range', 'The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.')
  }
}

function assertInterval(everySeconds: number): void {
  if (!Number.isSafeInteger(everySeconds)) {
    throw new ScheduleInputError('invalid_rule', 'every_seconds must be a safe integer.')
  }
  if (everySeconds < MIN_EVERY_SECONDS) {
    throw new ScheduleInputError('frequency_too_high', `every_seconds must be at least ${MIN_EVERY_SECONDS}.`)
  }
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = zoneFormatters.get(timeZone)
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    zoneFormatters.set(timeZone, fmt)
  }
  return fmt
}

function zoneParts(date: Date, timeZone: string): ZoneParts {
  const bag: Record<string, string> = {}
  for (const part of formatter(timeZone).formatToParts(date)) bag[part.type] = part.value
  let hour = Number(bag['hour'])
  if (hour === 24) hour = 0
  return {
    year: Number(bag['year']),
    month: Number(bag['month']),
    day: Number(bag['day']),
    hour,
    minute: Number(bag['minute']),
    second: Number(bag['second']),
    weekday: bag['weekday'] ?? '',
  }
}

export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, second: number, millisecond: number, timeZone: string): Date | undefined {
  if (!realDate(year, month, day)) return undefined
  const want = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  let guess = want
  for (let i = 0; i < 4; i++) {
    const got = zoneParts(new Date(guess), timeZone)
    const asUTC = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second, millisecond)
    const delta = want - asUTC
    if (delta === 0) break
    guess += delta
  }
  const got = zoneParts(new Date(guess), timeZone)
  if (got.year !== year || got.month !== month || got.day !== day || got.hour !== hour || got.minute !== minute || got.second !== second) {
    return undefined
  }
  let best = guess
  for (const back of [3_600_000, 7_200_000]) {
    const candidate = guess - back
    const parts = zoneParts(new Date(candidate), timeZone)
    if (parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute && parts.second === second && candidate < best) {
      best = candidate
    }
  }
  return new Date(best)
}

function isoWeekday(date: Date, timeZone: string): number {
  return ISO_WEEKDAY[zoneParts(date, timeZone).weekday] ?? 0
}

function addLocalDays(year: number, month: number, day: number, delta: number, timeZone: string): { year: number; month: number; day: number } {
  const noon = zonedTime(year, month, day, 12, 0, 0, 0, timeZone)
  const base = noon !== undefined ? noon.getTime() : Date.UTC(year, month - 1, day, 12)
  const shifted = new Date(base + delta * 86_400_000)
  const parts = zoneParts(shifted, timeZone)
  return { year: parts.year, month: parts.month, day: parts.day }
}

function realDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new ScheduleInputError('invalid_rule', 'cron.expression must be a five-field Vixie expression: minute hour day-of-month month day-of-week.')
  return {
    minute: parseCronField(fields[0] ?? '', 0, 59, false),
    hour: parseCronField(fields[1] ?? '', 0, 23, false),
    dom: parseCronField(fields[2] ?? '', 1, 31, false),
    month: parseCronField(replaceNames(fields[3] ?? '', MONTH_NAMES), 1, 12, false),
    dow: parseCronField(replaceNames(fields[4] ?? '', DOW_NAMES), 0, 6, true),
  }
}

function parseCronField(raw: string, min: number, max: number, dow: boolean): CronField {
  const field: CronField = { min, max, bits: Array.from({ length: max + 1 }, () => false) }
  if (raw.trim() === '') throw cronError()
  for (const part of raw.split(',')) {
    const piece = part.trim()
    if (piece === '') throw cronError()
    let step = 1
    let body = piece
    const slash = piece.indexOf('/')
    if (slash >= 0) {
      body = piece.slice(0, slash)
      step = Number(piece.slice(slash + 1))
      if (!Number.isInteger(step) || step <= 0) throw cronError()
    }
    let start = min
    let end = max
    if (body === '*') {
      // full span
    } else if (body.includes('-')) {
      const [left, right] = body.split('-', 2)
      start = cronNumber(left ?? '', dow)
      end = cronNumber(right ?? '', dow)
      if (start > end) throw cronError()
    } else {
      const n = cronNumber(body, dow)
      if (step === 1) {
        addCronValue(field, n, dow)
        continue
      }
      start = n
      end = max
    }
    for (let value = start; value <= end; value += step) addCronValue(field, value, dow)
  }
  if (fieldValues(field).length === 0) throw cronError()
  return field
}

function cronNumber(raw: string, dow: boolean): number {
  if (!/^-?\d+$/.test(raw.trim())) throw cronError()
  const n = Number(raw)
  if (dow && (n < 0 || n > 7)) throw cronError()
  return n
}

function addCronValue(field: CronField, value: number, dow: boolean): void {
  const resolved = dow && value === 7 ? 0 : value
  if (resolved < field.min || resolved > field.max) throw cronError()
  field.bits[resolved] = true
}

function fieldValues(field: CronField): number[] {
  const out: number[] = []
  for (let value = field.min; value <= field.max; value++) if (field.bits[value]) out.push(value)
  return out
}

function coversAll(field: CronField): boolean {
  for (let value = field.min; value <= field.max; value++) if (!field.bits[value]) return false
  return true
}

function cronDayMatches(spec: CronSpec, dom: number, dow: number): boolean {
  const domOK = spec.dom.bits[dom] === true
  const dowOK = spec.dow.bits[dow] === true
  const domAny = coversAll(spec.dom)
  const dowAny = coversAll(spec.dow)
  if (domAny && dowAny) return true
  if (domAny) return dowOK
  if (dowAny) return domOK
  return domOK || dowOK
}

function replaceNames(raw: string, pairs: readonly (readonly [string, string])[]): string {
  const lower = raw.toLowerCase()
  let out = ''
  for (let i = 0; i < lower.length;) {
    let matched = false
    for (const [name, value] of pairs) {
      const next = i + name.length
      if (lower.startsWith(name, i) && (next === lower.length || !isNameChar(lower[next] ?? '')) && (i === 0 || !isNameChar(lower[i - 1] ?? ''))) {
        out += value
        i = next
        matched = true
        break
      }
    }
    if (!matched) {
      out += lower[i]
      i++
    }
  }
  return out
}

function isNameChar(ch: string): boolean {
  return /[a-z0-9]/i.test(ch)
}

function cronError(): ScheduleInputError {
  return new ScheduleInputError('invalid_rule', 'cron.expression must be a five-field Vixie expression: minute hour day-of-month month day-of-week.')
}
