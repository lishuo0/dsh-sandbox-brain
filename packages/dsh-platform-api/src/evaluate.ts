/**
 * Stateless intake evaluation.
 *
 * One request = one model call. No session, no Agent loop, no tools, no
 * sandbox, no durable event: the platform has already decided which workspace
 * the thread belongs to, and the brain only answers "should this become a
 * ticket, and what is its scope".
 *
 * Ownership is *not* decided here. The caller must only send its own
 * workspace's rules, tickets and messages.
 *
 * @module @brain/dsh-platform-api/evaluate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { withRequestModelKey } from '@brain/dsh-credentials-session'
import { ensureProviderModel } from './gateway.ts'
import { HttpError } from './http.ts'
import { providerOfApi } from './model-protocol.ts'
import { withModelBaseUrl } from './request-context.ts'

/** Version stamped on every decision; bumping it makes prompt changes auditable. */
export const EVAL_PROMPT_VERSION = 'eval-3'

/** Default, and upper bound, for one evaluation. */
const DEFAULT_TIMEOUT_SECONDS = 120
const MAX_TIMEOUT_SECONDS = 600

/** Shape limits from the documented contract. */
const MAX_TRIGGERS = 20
const MAX_TRIGGER_BYTES = 16 * 1024
const MAX_RULES = 30

/** Fields the request body may carry. Anything else is a 400. */
const TOP_LEVEL_FIELDS = new Set([
  'evalId',
  'thread',
  'triggers',
  'strength',
  'policyVersion',
  'policy',
  'tickets',
])

/** One conversation event the platform wants judged. */
export interface EvaluateTrigger {
  readonly id: string
  readonly text: string
  readonly actor?: { readonly id: string; readonly name?: string }
  readonly at?: string
}

/** One policy rule; the instruction is natural language, not an expression. */
export interface EvaluateRule {
  readonly id: string
  readonly name?: string
  readonly enabled: boolean
  readonly instruction?: string
}

/** One open ticket in the same thread. */
export interface EvaluateTicket {
  readonly id: string
  readonly title?: string
  readonly stage?: string
}

/** A validated evaluation request. */
export interface EvaluateInput {
  readonly evalId?: string
  readonly thread: { readonly key: string; readonly kind: string }
  readonly triggers: readonly EvaluateTrigger[]
  readonly strength: 'explicit' | 'inferred'
  readonly policyVersion: number
  readonly policy: Record<string, unknown>
  readonly tickets: readonly EvaluateTicket[]
}

/** What the evaluator decided. */
export type EvaluateOutcome =
  | {
      readonly kind: 'accept'
      readonly title: string
      readonly scope: string
      readonly reason: string
      readonly intentEvidence: string
      readonly rules: readonly string[]
      readonly name?: string
      readonly acknowledgement?: string
    }
  | { readonly kind: 'ignore'; readonly reason: string; readonly reply?: string }
  | { readonly kind: 'stop'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: { readonly code: string; readonly message?: string } }

/** The documented response body. */
export interface EvaluateResult {
  readonly promptVersion: string
  readonly model: { readonly provider: string; readonly model: string }
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null
  readonly outcome: EvaluateOutcome
}

/** The model runtime surface evaluation needs. */
interface Llm {
  listModels(provider: string): Promise<readonly unknown[]>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * Validate one request body.
 *
 * Strict at the top level: the route must not become a general-purpose
 * inference proxy, so fields such as `prompt`, `tools` or `preset` are
 * rejected rather than ignored.
 * @param input - the parsed JSON body.
 * @returns the validated request.
 * @throws {HttpError} 400 `invalid-evaluate`.
 */
export function parseEvaluate(input: unknown): EvaluateInput {
  const record = object(input, 'body')
  for (const key of Object.keys(record)) {
    if (!TOP_LEVEL_FIELDS.has(key)) throw invalid(`unknown field "${key}"`)
  }

  const thread = object(record.thread, 'thread')
  const threadKey = nonEmpty(thread.key, 'thread.key')
  const threadKind = optionalString(thread.kind) ?? 'chat'

  const rawTriggers = array(record.triggers, 'triggers')
  if (rawTriggers.length === 0 || rawTriggers.length > MAX_TRIGGERS) {
    throw invalid(`triggers must carry 1 to ${MAX_TRIGGERS} events`)
  }
  const triggers = rawTriggers.map((raw, index) => {
    const item = object(raw, `triggers[${index}]`)
    const text = nonEmpty(item.text, `triggers[${index}].text`)
    if (Buffer.byteLength(text) > MAX_TRIGGER_BYTES) {
      throw invalid(`triggers[${index}].text exceeds ${MAX_TRIGGER_BYTES} bytes`)
    }
    const actor = item.actor === undefined ? undefined : (() => {
      const value = object(item.actor, `triggers[${index}].actor`)
      return { id: nonEmpty(value.id, `triggers[${index}].actor.id`), ...pick('name', value) }
    })()
    return {
      id: nonEmpty(item.id, `triggers[${index}].id`),
      text,
      ...(actor === undefined ? {} : { actor }),
      ...pick('at', item),
    }
  })

  const strength = record.strength
  if (strength !== 'explicit' && strength !== 'inferred') {
    throw invalid('strength must be "explicit" or "inferred"')
  }

  if (typeof record.policyVersion !== 'number' || !Number.isFinite(record.policyVersion)) {
    throw invalid('policyVersion must be a number')
  }

  const policy = object(record.policy, 'policy')
  if (policy.rules !== undefined) {
    const rules = array(policy.rules, 'policy.rules')
    if (rules.length > MAX_RULES) throw invalid(`policy.rules may carry at most ${MAX_RULES} entries`)
    for (const [index, raw] of rules.entries()) {
      const rule = object(raw, `policy.rules[${index}]`)
      nonEmpty(rule.id, `policy.rules[${index}].id`)
      if (typeof rule.enabled !== 'boolean') throw invalid(`policy.rules[${index}].enabled must be a boolean`)
    }
  }

  const tickets: EvaluateTicket[] = []
  if (record.tickets !== undefined) {
    for (const [index, raw] of array(record.tickets, 'tickets').entries()) {
      const ticket = object(raw, `tickets[${index}]`)
      tickets.push({
        id: nonEmpty(ticket.id, `tickets[${index}].id`),
        ...pick('title', ticket),
        ...pick('stage', ticket),
      })
    }
  }

  return {
    ...pick('evalId', record),
    thread: { key: threadKey, kind: threadKind },
    triggers,
    strength,
    policyVersion: record.policyVersion,
    policy,
    tickets,
  }
}

/**
 * Run one evaluation.
 *
 * Every failure of the model itself — timeout, transport error, unparsable or
 * malformed accept — degrades to `unavailable` with a `200`; only a malformed
 * *request* is the caller's 400.
 * @param ctx - plugin context carrying the model runtime.
 * @param input - the validated request.
 * @param modelConfig - the caller's own model configuration, from request headers.
 * @returns the decision and its accounting.
 */
export async function evaluate(
  ctx: Context,
  input: EvaluateInput,
  modelConfig: {
    readonly modelKey: string
    readonly baseUrl: string
    /** 成员选的上游线协议；决定用哪条 provider 路由。 */
    readonly api?: string
    readonly modelId?: string
  },
  signal?: AbortSignal,
): Promise<EvaluateResult> {
  const llm = ctx.get('llm') as Llm | undefined
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw new HttpError(501, 'not-supported', 'model runtime is not composed')
  }

  const provider = providerOfApi(modelConfig.api)
  const model = modelConfig.modelId ?? await firstModel(llm, provider)
  const result = (outcome: EvaluateOutcome, usage: EvaluateResult['usage'] = null): EvaluateResult => ({
    promptVersion: EVAL_PROMPT_VERSION,
    model: { provider, model },
    usage,
    outcome,
  })

  if (model === '') {
    return result(unavailable('model-not-configured', 'no model was selected for this request'))
  }
  await ensureProviderModel(ctx, provider, model)

  const timeoutSeconds = timeoutOf(input)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000)
  timer.unref?.()
  const forward = (): void => controller.abort()
  signal?.addEventListener('abort', forward, { once: true })

  let text = ''
  let usage: EvaluateResult['usage'] = null
  let failure: string | undefined

  try {
    await withRequestModelKey(modelConfig.modelKey, () =>
      withModelBaseUrl(modelConfig.baseUrl, async () => {
        for await (const chunk of llm.stream({
          provider,
          model,
          system: SYSTEM_PROMPT,
          // The model runtime reads blocks, not strings: adapters scan
          // `content` with array methods, so a bare string throws.
          messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt(input) }] }],
          signal: controller.signal,
        })) {
          if (chunk.type === 'text-delta') text += chunk.text
          if (chunk.type === 'usage') usage = usageOf(chunk.usage)
          if (chunk.type === 'finish' && isFailureFinish(chunk.reason)) {
            failure = String((chunk.reason as { kind?: unknown }).kind ?? 'error')
          }
        }
      }))
  } catch (error) {
    const code = controller.signal.aborted ? 'timeout' : 'model-error'
    ctx.logger?.warn?.(`platform-api: evaluate ${input.evalId ?? input.thread.key} failed: ${describe(error)}`)
    return result(unavailable(code, describe(error)), usage)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }

  if (failure !== undefined) return result(unavailable(failure, 'the model call did not finish'), usage)
  if (controller.signal.aborted) return result(unavailable('timeout', `evaluation exceeded ${timeoutSeconds}s`), usage)

  const parsed = parseModelOutput(text)
  if (parsed === undefined) return result(unavailable('invalid-output', 'the model did not return a JSON object'), usage)
  return result(normalizeOutcome(parsed, enabledRuleIds(input), input.strength), usage)
}

/** System prompt. Prompt text is brain-owned; callers cannot supply it. */
const SYSTEM_PROMPT = [
  'You are the intake evaluator of a software-automation service.',
  'You decide whether one batch of chat events should become a work ticket for the project bound to this conversation.',
  '',
  'Rules:',
  '- Strength "explicit" means someone clearly asked the agent for the work. Accept it directly: an explicit request does not need a policy rule.',
  '- Strength "inferred" means you must judge whether they meant it; be conservative, and accept only work covered by an enabled policy rule.',
  '- Rules are natural-language scope descriptions; judge meaning, not keywords.',
  '- Never accept work that an open ticket in this thread already covers.',
  '- If the messages are chatter, out of scope, or merely a question you should not act on, answer "ignore" and say why.',
  '- "reason" is an internal audit note. "reply" is what the bot actually sends back to the chat: short, natural, in the same language as the latest message, and never mentioning rules, policies, tickets or any internal reasoning.',
  '- When someone is talking to the bot directly, always give them a useful reply (greet back, answer briefly, or say what you can do) instead of leaving them without an answer.',
  '- Answer "stop" only when a human explicitly asks to stop or the thread is closed.',
  '- Answer with exactly one JSON object and nothing else. No prose, no code fences.',
  '',
  'Output shapes:',
  '{"kind":"accept","title":"...","scope":"...","reason":"...","intentEvidence":"...","rules":["<enabled rule id>"],"acknowledgement":"..."}',
  '{"kind":"ignore","reason":"...","reply":"..."}',
  '{"kind":"stop","reason":"..."}',
  'For accept, "rules" may list only enabled rule ids. An inferred accept must cite at least one; an explicit accept may leave it empty. "intentEvidence" must quote what made the intent clear.',
].join('\n')

/** Render the request as the model's user message. */
function userPrompt(input: EvaluateInput): string {
  const rules = Array.isArray(input.policy.rules) ? input.policy.rules : []
  return JSON.stringify({
    thread: input.thread,
    strength: input.strength,
    triggers: input.triggers,
    rules,
    actions: input.policy.actions ?? {},
    limits: input.policy.limits ?? {},
    openTickets: input.tickets,
  }, null, 2)
}

/** Read the model's JSON object out of its answer, tolerating code fences. */
function parseModelOutput(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** Enabled rule ids, the only ones an accept may cite. */
function enabledRuleIds(input: EvaluateInput): Set<string> {
  const rules = Array.isArray(input.policy.rules) ? input.policy.rules : []
  const ids = new Set<string>()
  for (const rule of rules) {
    const item = rule as { id?: unknown; enabled?: unknown }
    if (item.enabled === true && typeof item.id === 'string' && item.id !== '') ids.add(item.id)
  }
  return ids
}

/**
 * Enforce the accept contract.
 *
 * An explicit request is authorized by the person asking, so it needs no rule.
 * A proactive (inferred) accept must cite at least one enabled rule; any cited
 * id must be enabled even for an explicit accept, so the audit trail stays
 * truthful. A model that answers in the wrong shape is the model's problem,
 * not the caller's: everything unusable becomes `unavailable`, never a guessed
 * accept.
 */
function normalizeOutcome(
  value: Record<string, unknown>,
  enabled: ReadonlySet<string>,
  strength: 'explicit' | 'inferred',
): EvaluateOutcome {
  const kind = value.kind
  if (kind === 'ignore') {
    const reason = optionalString(value.reason)
    if (reason === undefined) return unavailable('invalid-output', 'ignore without a reason')
    return { kind, reason, ...pick('reply', value) }
  }
  if (kind === 'stop') {
    const reason = optionalString(value.reason)
    return reason === undefined ? unavailable('invalid-output', 'stop without a reason') : { kind, reason }
  }
  if (kind === 'unavailable') {
    const reason = typeof value.reason === 'object' && value.reason !== null
      ? value.reason as { code?: unknown; message?: unknown }
      : {}
    return unavailable(
      optionalString(reason.code) ?? 'model-declined',
      optionalString(reason.message),
    )
  }
  if (kind !== 'accept') return unavailable('invalid-output', 'unknown outcome kind')

  const title = optionalString(value.title)
  const scope = optionalString(value.scope)
  const reason = optionalString(value.reason)
  const intentEvidence = optionalString(value.intentEvidence)
  if (title === undefined || scope === undefined || reason === undefined || intentEvidence === undefined) {
    return unavailable('invalid-output', 'accept is missing title, scope, reason or intentEvidence')
  }
  if (value.rules !== undefined && !Array.isArray(value.rules)) {
    return unavailable('invalid-output', 'accept rules must be an array')
  }
  const rules: string[] = []
  for (const rule of (value.rules ?? []) as readonly unknown[]) {
    if (typeof rule !== 'string' || !enabled.has(rule)) {
      return unavailable('invalid-output', `accept cites "${String(rule)}", which is not an enabled rule`)
    }
    rules.push(rule)
  }
  // 主动接活必须落在一条启用的规则上；点名请求由人授权，不需要规则。
  if (strength === 'inferred' && rules.length === 0) {
    return unavailable('invalid-output', 'a proactive accept must cite an enabled rule')
  }
  return {
    kind: 'accept',
    title,
    scope,
    reason,
    intentEvidence,
    rules,
    ...pick('name', value),
    ...pick('acknowledgement', value),
  }
}

/** One unavailable outcome. */
function unavailable(code: string, message?: string): EvaluateOutcome {
  return { kind: 'unavailable', reason: { code, ...(message === undefined ? {} : { message }) } }
}

/** The timeout the policy allows, clamped to something a request can wait for. */
function timeoutOf(input: EvaluateInput): number {
  const evalConfig = input.policy.eval
  const seconds = typeof evalConfig === 'object' && evalConfig !== null
    ? (evalConfig as { timeoutSeconds?: unknown }).timeoutSeconds
    : undefined
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TIMEOUT_SECONDS
  return Math.min(seconds, MAX_TIMEOUT_SECONDS)
}

/** First model the caller's endpoint advertises, when the header omitted one. */
async function firstModel(llm: Llm, provider: string): Promise<string> {
  const models = await llm.listModels(provider).catch(() => [])
  for (const model of models) {
    const id = typeof model === 'string'
      ? model
      : typeof model === 'object' && model !== null
        ? (model as { id?: unknown }).id
        : undefined
    if (typeof id === 'string' && id !== '') return id
  }
  return ''
}

/** Token accounting as the documented response carries it. */
function usageOf(value: unknown): EvaluateResult['usage'] {
  if (typeof value !== 'object' || value === null) return null
  const usage = value as { inputTokens?: unknown; outputTokens?: unknown }
  if (typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') return null
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
}

/** Whether a finish reason means the call failed. */
function isFailureFinish(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false
  const kind = (reason as { kind?: unknown }).kind
  return kind === 'error' || kind === 'aborted'
}

/** Pick one optional string field. */
function pick<K extends string>(key: K, value: Record<string, unknown>): { [P in K]?: string } {
  const found = optionalString(value[key])
  return (found === undefined ? {} : { [key]: found }) as { [P in K]?: string }
}

/** Require a plain object. */
function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`${path} must be an object`)
  return value as Record<string, unknown>
}

/** Require an array. */
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw invalid(`${path} must be an array`)
  return value
}

/** Require a non-empty string. */
function nonEmpty(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${path} must be a non-empty string`)
  return value
}

/** Read an optional non-empty string. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** One 400 with the documented code. */
function invalid(message: string): HttpError {
  return new HttpError(400, 'invalid-evaluate', message)
}

/** Readable one-liner for logs. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
