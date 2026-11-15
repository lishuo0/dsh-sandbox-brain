/**
 * 官方四个定时工具。输入输出对齐 DSH 的 schedule_create / list / update / delete。
 * 调用只改当前会话在共用表里的定义，不挂官方计时器，也不回拨平台。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createTask, deleteTask, listTasks, toolError, updateTask, type CreateArgs, type ScheduleDB, type UpdateArgs } from './tasks.ts'
import { MAX_TITLE_LENGTH, MIN_EVERY_INTERVAL_SECONDS } from './time.ts'

const MAX_PROMPT_LENGTH = 200_000

const SHARED = {
  id: { type: 'string', required: true },
  title: { type: 'string', required: true },
  prompt: { type: 'string', required: true },
  scheduledAt: { type: 'string', required: true },
  state: { type: 'string', required: true, enum: ['scheduled', 'overdue'] },
  deliveryMode: { type: 'string', required: true, const: 'host' },
} as const

function viewSchema(kind: string, extra: Record<string, unknown>) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...SHARED,
      kind: { type: 'string', required: true, const: kind },
      ...extra,
    },
  } as const
}

const VIEW_SCHEMA = {
  oneOf: [
    viewSchema('after', { afterSeconds: { type: 'integer', required: true } }),
    viewSchema('at', {}),
    viewSchema('every', { everySeconds: { type: 'integer', required: true } }),
    viewSchema('daily', { time: { type: 'string', required: true }, timeZone: { type: 'string', required: true } }),
    viewSchema('weekly', {
      time: { type: 'string', required: true },
      timeZone: { type: 'string', required: true },
      weekdays: { type: 'array', required: true, items: { type: 'integer' } },
    }),
    viewSchema('cron', { expression: { type: 'string', required: true }, timeZone: { type: 'string', required: true } }),
  ],
} as const

function errorSchema(code: string) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string', required: true, const: code },
      message: { type: 'string', required: true },
    },
  } as const
}

const ERROR_SCHEMAS = [
  errorSchema('invalid_prompt'),
  errorSchema('invalid_selector'),
  errorSchema('invalid_rule'),
  errorSchema('invalid_time_zone'),
  errorSchema('not_future'),
  errorSchema('time_out_of_range'),
  errorSchema('frequency_too_high'),
  errorSchema('subagent_session'),
  errorSchema('internal_error'),
] as const

const SELECTORS = {
  every_seconds: {
    type: 'number',
    description: `Fixed-rate interval in whole seconds, at least ${MIN_EVERY_INTERVAL_SECONDS}, aligned to the creation time; changing it with schedule_update re-aligns it to the save time.`,
  },
  daily: {
    type: 'object',
    additionalProperties: false,
    description: 'Every day at a local time.',
    properties: {
      time: { type: 'string', required: true, description: 'HH:mm:ss with optional 1-3 fractional digits, for example 23:00:00.' },
      time_zone: { type: 'string', required: true, description: 'UTC or IANA Area/Location, for example Asia/Shanghai.' },
    },
  },
  weekly: {
    type: 'object',
    additionalProperties: false,
    description: 'On the given weekdays at a local time.',
    properties: {
      time: { type: 'string', required: true, description: 'HH:mm:ss with optional 1-3 fractional digits, for example 09:00:00.' },
      time_zone: { type: 'string', required: true, description: 'UTC or IANA Area/Location, for example Asia/Shanghai.' },
      weekdays: { type: 'array', required: true, description: 'ISO weekdays, Monday 1 through Sunday 7, without repetitions.', items: { type: 'integer' } },
    },
  },
  cron: {
    type: 'object',
    additionalProperties: false,
    description: 'Five-field Vixie cron expression in a time zone. When both day fields are restricted, a date matches if either one matches.',
    properties: {
      expression: { type: 'string', required: true, description: 'minute hour day-of-month month day-of-week, for example "*/15 9-17 * * 1-5".' },
      time_zone: { type: 'string', required: true, description: 'UTC or IANA Area/Location, for example Asia/Shanghai.' },
    },
  },
  at: {
    description: 'Absolute target: an RFC 3339 date-time with offset, or a local date, time, and IANA time_zone.',
    oneOf: [
      { type: 'string' },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', required: true },
          time: { type: 'string', required: true },
          time_zone: { type: 'string', required: true },
        },
      },
    ],
  },
} as const

interface Caller {
  agent?: {
    session: { id: unknown; header?: { parentSession?: unknown; delegationDepth?: unknown } }
    options?: { subagentDepth?: unknown }
  }
  signal?: AbortSignal
}

function render(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

function internalError() {
  return { code: 'internal_error', message: 'The schedule operation failed.' }
}

function subagentRefusal(exec: Caller): { code: string; message: string } | undefined {
  const agent = exec.agent
  if (agent === undefined) return undefined
  const parent = agent.session.header?.parentSession
  const depth = agent.session.header?.delegationDepth
  const runtime = agent.options?.subagentDepth
  if ((typeof parent === 'string' && parent !== '') || (typeof depth === 'number' && depth > 0) || (typeof runtime === 'number' && runtime > 0)) {
    return { code: 'subagent_session', message: 'A delegated subagent cannot use reminders.' }
  }
  return undefined
}

function sessionID(exec: Caller): string | undefined {
  const id = exec.agent?.session.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function invalidPrompt(prompt: string | undefined, title: string | undefined, titleRequired: boolean): { code: string; message: string } | undefined {
  if (prompt !== undefined && prompt.trim().length === 0) {
    return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  }
  if (prompt !== undefined && prompt.trim().length > MAX_PROMPT_LENGTH) {
    return { code: 'invalid_prompt', message: `prompt must be at most ${MAX_PROMPT_LENGTH} characters.` }
  }
  if (titleRequired && (title === undefined || title.trim().length === 0)) {
    return { code: 'invalid_prompt', message: 'title is required and must be non-empty after trimming.' }
  }
  if (title !== undefined && title.trim().length === 0) {
    return { code: 'invalid_prompt', message: 'title is required and must be non-empty after trimming.' }
  }
  if (title !== undefined && title.trim().length > MAX_TITLE_LENGTH) {
    return { code: 'invalid_prompt', message: `title must be at most ${MAX_TITLE_LENGTH} characters.` }
  }
  return undefined
}

function invalidInterval(everySeconds: number | undefined): { code: string; message: string } | undefined {
  if (everySeconds === undefined) return undefined
  if (!Number.isSafeInteger(everySeconds)) return { code: 'invalid_rule', message: 'every_seconds must be a safe integer.' }
  if (everySeconds < MIN_EVERY_INTERVAL_SECONDS) {
    return { code: 'frequency_too_high', message: `every_seconds must be at least ${MIN_EVERY_INTERVAL_SECONDS}.` }
  }
  return undefined
}

const CREATE_KEYS = new Set(['prompt', 'title', 'after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'])
const UPDATE_KEYS = new Set(['id', 'title', 'prompt', 'at', 'every_seconds', 'daily', 'weekly', 'cron'])

export function registerTools(ctx: Context, db: ScheduleDB): void {
  ctx.tools.register(defineTool({
    name: 'schedule_create',
    description: 'Create a reminder in the current session that delivers prompt when it becomes due. '
      + 'Supply exactly one timing parameter: after_seconds, at, every_seconds, daily, weekly, or cron. '
      + 'Local times that do not exist in the zone are skipped; repeated local times fire once, at the earlier instant. '
      + 'After downtime, a recurring reminder delivers only its latest missed occurrence. Delivery can repeat after a crash.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Reminder content to present when the target becomes due.' },
      title: { type: 'string', required: true, description: `Task name of at most ${MAX_TITLE_LENGTH} characters, shown on the task card and in task lists.` },
      after_seconds: { type: 'number', description: 'Delay in whole seconds.' },
      ...SELECTORS,
    },
    output: { schema: { oneOf: [VIEW_SCHEMA, ...ERROR_SCHEMAS] }, render },
    async execute(args, exec) {
      const caller = exec as Caller
      if (caller.agent === undefined) return internalError()
      const refusal = subagentRefusal(caller)
      if (refusal !== undefined) return refusal
      const invalid = validateCreate(args)
      if (invalid !== undefined) return invalid
      if (caller.signal?.aborted) return internalError()
      const sessionId = sessionID(caller)
      if (sessionId === undefined) return internalError()
      try {
        return await createTask(db, sessionId, args as CreateArgs) as never
      } catch (error) {
        return toolError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'schedule_list',
    description: 'List the active reminders in the current session.',
    parameters: {},
    output: {
      schema: { oneOf: [{ type: 'array', items: VIEW_SCHEMA }, ...ERROR_SCHEMAS] },
      render,
    },
    async execute(_args, exec) {
      const caller = exec as Caller
      if (caller.agent === undefined) return internalError()
      const refusal = subagentRefusal(caller)
      if (refusal !== undefined) return refusal
      if (caller.signal?.aborted) return internalError()
      const sessionId = sessionID(caller)
      if (sessionId === undefined) return internalError()
      try {
        return await listTasks(db, sessionId) as never
      } catch (error) {
        return toolError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'schedule_delete',
    description: 'Delete a reminder in the current session, active or inactive. Deletion does not retract a reminder message that is already queued.',
    parameters: { id: { type: 'string', required: true, description: 'Exact schedule id.' } },
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, deleted: { type: 'boolean', required: true, const: true } } },
          { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, deleted: { type: 'boolean', required: true, const: false }, code: { type: 'string', required: true, const: 'schedule_not_found' } } },
          ...ERROR_SCHEMAS,
        ],
      },
      render,
    },
    async execute(args, exec) {
      if (args.id.length === 0 || args.id.trim() !== args.id) {
        return { code: 'invalid_rule', message: 'schedule_delete id must be non-empty without surrounding whitespace.' }
      }
      const caller = exec as Caller
      if (caller.agent === undefined) return internalError()
      const refusal = subagentRefusal(caller)
      if (refusal !== undefined) return refusal
      if (caller.signal?.aborted) return internalError()
      const sessionId = sessionID(caller)
      if (sessionId === undefined) return internalError()
      try {
        return await deleteTask(db, sessionId, args.id) as never
      } catch (error) {
        return toolError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'schedule_update',
    description: 'Change a reminder in place, keeping its id. Supply a new title, prompt, or at most one timing parameter; omitted fields keep their stored values. To change a relative delay, create a new reminder.',
    parameters: {
      id: { type: 'string', required: true, description: 'Schedule id returned by schedule_list.' },
      title: { type: 'string', description: `New task name of at most ${MAX_TITLE_LENGTH} characters.` },
      prompt: { type: 'string', description: 'New reminder content.' },
      ...SELECTORS,
    },
    output: {
      schema: {
        oneOf: [
          VIEW_SCHEMA,
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              updated: { type: 'boolean', required: true, const: false },
              code: { type: 'string', required: true, enum: ['schedule_not_found', 'schedule_ended', 'schedule_conflict'] },
            },
          },
          ...ERROR_SCHEMAS,
        ],
      },
      render,
    },
    async execute(args, exec) {
      const caller = exec as Caller
      if (caller.agent === undefined) return internalError()
      const refusal = subagentRefusal(caller)
      if (refusal !== undefined) return refusal
      const invalid = validateUpdate(args)
      if (invalid !== undefined) return invalid
      if (caller.signal?.aborted) return internalError()
      const sessionId = sessionID(caller)
      if (sessionId === undefined) return internalError()
      try {
        return await updateTask(db, sessionId, args as UpdateArgs) as never
      } catch (error) {
        return toolError(error)
      }
    },
  }))
}

function validateCreate(args: { prompt: string; title: string; after_seconds?: number; every_seconds?: number }): { code: string; message: string } | undefined {
  const keys = Object.keys(args)
  const selectors = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron']
    .filter(key => (args as Record<string, unknown>)[key] !== undefined).length
  if (keys.some(key => !CREATE_KEYS.has(key)) || selectors !== 1) {
    return { code: 'invalid_selector', message: 'schedule_create accepts exactly one of after_seconds, at, every_seconds, daily, weekly, or cron.' }
  }
  const prompt = invalidPrompt(args.prompt, args.title, true)
  if (prompt !== undefined) return prompt
  if (args.after_seconds !== undefined && (!Number.isSafeInteger(args.after_seconds) || args.after_seconds <= 0)) {
    return { code: 'invalid_rule', message: 'after_seconds must be a positive safe integer.' }
  }
  return invalidInterval(args.every_seconds)
}

function validateUpdate(args: { id: string; title?: string; prompt?: string; every_seconds?: number }): { code: string; message: string } | undefined {
  const selectors = ['at', 'every_seconds', 'daily', 'weekly', 'cron']
    .filter(key => (args as Record<string, unknown>)[key] !== undefined).length
  if (Object.keys(args).some(key => !UPDATE_KEYS.has(key)) || selectors > 1) {
    return { code: 'invalid_selector', message: 'schedule_update accepts at most one of at, every_seconds, daily, weekly, or cron.' }
  }
  if (args.id.length === 0 || args.id.trim() !== args.id) {
    return { code: 'invalid_rule', message: 'schedule_update id must be non-empty without surrounding whitespace.' }
  }
  if (selectors === 0 && args.title === undefined && args.prompt === undefined) {
    return { code: 'invalid_selector', message: 'schedule_update needs a new title, prompt, or one of at, every_seconds, daily, weekly, or cron.' }
  }
  const prompt = invalidPrompt(args.prompt, args.title, false)
  if (prompt !== undefined) return prompt
  return invalidInterval(args.every_seconds)
}
