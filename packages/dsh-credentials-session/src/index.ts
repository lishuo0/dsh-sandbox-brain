/**
 * Per-session model key provider.
 *
 * The platform obtains the user's model key and sends it on `POST /v1/sessions`
 * (create or resume). `platform-api` stores it in memory per session; this
 * provider resolves the current request's session through the Agent registry
 * and returns that session's key.
 *
 * A subagent runs under a child session id the platform has never seen, so a
 * session with no key of its own inherits the nearest ancestor's — the parent
 * chain is read from each live Agent's durable `parentSession` header, exactly
 * like the sandbox registry deciding which sandbox a delegation runs in.
 * There is still no *global* fallback: a chain with no key anywhere is an
 * error, so a misconfigured platform fails closed instead of borrowing another
 * tenant's key.
 *
 * This is the deployment's only `credentials` service. Besides model keys it
 * answers the record half from a process-local map: the DSH client connection
 * keeps its browser-cookie signing secret there, and nothing else is meant to
 * persist. Model keys themselves never enter that map.
 *
 * @module @brain/dsh-credentials-session
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { Context } from '@deepseek-ai/cordis'
import {
  CredentialProvider,
  credentialRef,
} from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'

/** In-memory per-session key store provided by `platform-api`. */
export interface SessionModelKeys {
  get(sessionId: string): string | undefined
  set(sessionId: string, key: string): void
  delete(sessionId: string): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Model keys supplied by the platform for active sessions. */
    sessionModelKeys?: SessionModelKeys
  }
}

/**
 * 请求作用域的模型密钥。
 *
 * 无会话的模型调用（接单评估）没有发起方 Agent，会话查找必然为空；调用方
 * 用 `withRequestModelKey` 把本次请求的密钥钉在异步作用域里。作用域结束即
 * 失效，不会变成全局回落。
 */
const requestKey = new AsyncLocalStorage<string>()

/**
 * 在请求作用域里固定本次调用的模型密钥。
 * @param key - 本次请求使用的密钥。
 * @param run - 在该作用域内执行的调用。
 * @returns 调用的返回值。
 */
export function withRequestModelKey<T>(key: string, run: () => T): T {
  return requestKey.run(key, run)
}

/** Plugin configuration. */
export interface Config {
  /** Credential reference this provider answers. Defaults to `DEEPSEEK_API_KEY`. */
  readonly ref?: string
}

/** Provider state after config defaulting. */
interface ResolvedConfig {
  readonly ref: CredentialRef
}

/**
 * Resolve the configured reference from the current session's key.
 *
 * A model request always runs inside an Agent turn, so a missing session key is
 * a hard failure. Calls outside a turn (model discovery at startup, settings
 * surfaces) report "unconfigured" instead of throwing.
 */
export default class SessionCredentialProvider extends CredentialProvider {
  private readonly config: ResolvedConfig
  /** Process-local records: browser-cookie signing secrets, never model keys. */
  private readonly records = new Map<CredentialKey, CredentialRecord>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.config = { ref: credentialRef(config.ref ?? 'DEEPSEEK_API_KEY') }
  }

  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (String(ref) !== String(this.config.ref)) return undefined
    const scoped = requestKey.getStore()
    if (scoped !== undefined) return { value: scoped, source: 'request' }
    const sessionId = currentSessionId(this.ctx)
    if (sessionId === undefined) return undefined
    const key = sessionKey(this.ctx, sessionId)
    if (key === undefined) {
      throw new Error(`credentials-session: no model key for session "${sessionId}"`)
    }
    return { value: key, source: 'session' }
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (String(ref) !== String(this.config.ref)) return { configured: false, writable: false } as CredentialInfo
    const sessionId = currentSessionId(this.ctx)
    const configured = sessionId !== undefined && sessionKey(this.ctx, sessionId) !== undefined
    return { configured, ...(configured ? { source: 'session' } : {}), writable: false } as CredentialInfo
  }

  override async set(): Promise<void> {
    throw new Error('credentials-session: model keys are supplied by the platform per session')
  }

  override async unset(): Promise<void> {
    throw new Error('credentials-session: model keys are supplied by the platform per session')
  }

  override async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return this.records.get(key)
  }

  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    return {
      configured: record !== undefined,
      ...(record === undefined ? {} : { kind: record.kind }),
      writable: true,
    } as CredentialRecordInfo
  }

  override async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return [...this.records].map(([key, record]) => ({ key, kind: record.kind }))
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(key))
    if (next !== undefined) {
      this.records.set(key, next)
      this.notifyRecordUpdated(key)
    }
    return this.records.get(key)
  }

  override async deleteRecord(key: CredentialKey): Promise<void> {
    if (this.records.delete(key)) this.notifyRecordUpdated(key)
  }
}

/** The session currently executing, when the call is inside an Agent turn. */
function currentSessionId(ctx: Context): string | undefined {
  const agents = ctx.get('agents') as
    | { currentInitiator?: () => { session?: { id?: unknown } } | undefined }
    | undefined
  try {
    const id = agents?.currentInitiator?.()?.session?.id
    return id === undefined || id === null || String(id) === '' ? undefined : String(id)
  } catch {
    return undefined
  }
}

/** Depth cap so a corrupted parent chain cannot be walked forever. */
const MAX_PARENT_DEPTH = 8

/**
 * One session's key, inherited from the nearest ancestor that has one.
 *
 * Fails loudly when the service is not mounted: without `platform-api` there is
 * no key source at all, and silently unconfigured would hide a deployment bug.
 */
function sessionKey(ctx: Context, sessionId: string): string | undefined {
  const keys = ctx.get('sessionModelKeys')
  if (keys === undefined) {
    throw new Error('credentials-session: platform-api did not provide sessionModelKeys')
  }
  const seen = new Set<string>()
  let id: string | undefined = sessionId
  for (let depth = 0; id !== undefined && depth < MAX_PARENT_DEPTH && !seen.has(id); depth += 1) {
    seen.add(id)
    const key = keys.get(id)
    if (key !== undefined) return key
    id = parentSessionOf(ctx, id)
  }
  return undefined
}

/**
 * The durable parent recorded on one live session.
 *
 * A subagent's session is born inside the brain and has no platform row, so
 * neither its key nor its id was ever seen by the platform. The parent header
 * is what lets it inherit both.
 */
function parentSessionOf(ctx: Context, sessionId: string): string | undefined {
  const agents = ctx.get('agents') as
    | { get(id: string): { session?: { header?: { parentSession?: unknown } } } | undefined }
    | undefined
  try {
    const parent = agents?.get(sessionId)?.session?.header?.parentSession
    return parent === undefined || parent === null || String(parent) === '' ? undefined : String(parent)
  } catch {
    return undefined
  }
}
