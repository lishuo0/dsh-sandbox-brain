/**
 * REST surface for the agent platform.
 *
 * A function plugin, not a service: it contributes routes and owns nothing else.
 * Loaded as `@brain/dsh-platform-api` in a profile row.
 *
 * Contract:
 *   POST /brain/v1/sessions                   { cwd, preset?, sessionId? } → { sessionId }
 *   POST /brain/v1/sessions/{id}/messages     { text }                     → 202
 *   POST /brain/v1/sessions/{id}/cancel                                    → 202
 *   GET  /brain/v1/sessions/{id}/events?after=N                            → SSE
 *
 * Auth:
 *   x-app-id / x-app-key      required, checked against every configured pair
 *   x-dsh-user-id             the user this request acts for
 *   x-request-id              optional; generated when absent, echoed back
 *
 * @module @brain/dsh-platform-api
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@brain/dsh-session-pg'
import type { SessionModelKeys } from '@brain/dsh-credentials-session'
import { DEFAULT_HEADERS, loadCredentials, type AppCredential, type AuthHeaders } from './auth.ts'
import { createGateway } from './gateway.ts'
import { createOwnershipGuard } from './ownership.ts'
import {
  registerRoutes,
  type ImageConfigStore,
  type SandboxConfigStore,
  type SessionModelBaseUrls,
} from './routes.ts'

/** Plugin name for loader diagnostics. */
export const name = 'platform-api'

/** Required services. */
export const inject = ['webServer', 'agents']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-session model endpoints supplied by the platform. */
    sessionModelBaseUrls?: SessionModelBaseUrls
  }
}

/** Hostname profile providers use to mean "the platform-supplied endpoint". */
const MODEL_ENDPOINT_SENTINEL = 'dsh-model.invalid'

/** Configuration. */
export interface Config {
  /**
   * Absolute path to the credential file.
   *
   *   { "apps": [ { "appId": "platform", "appKey": "…", "name": "Agent 平台" } ] }
   *
   * When omitted, `DSH_PLATFORM_APPS` is read instead. The plugin refuses to
   * load without credentials: an unauthenticated public surface is worse than a
   * failed start.
   */
  credentialsFile?: string
  /**
   * Inline credentials. Takes precedence over `credentialsFile`, so a single
   * deployment config file can carry everything.
   */
  apps?: readonly { appId: string; appKey: string; name?: string }[]
  /** Header names, if the platform already uses its own. */
  headers?: Partial<AuthHeaders>
  /** Reject requests that name no user. Default true. */
  requireUser?: boolean
  /** Page size for the events replay. Default 200. */
  pageSize?: number
  /** SSE heartbeat in milliseconds. Default 15000. */
  heartbeatMs?: number
  /** Header carrying the platform-supplied model key. Defaults to `x-dsh-model-key`. */
  modelKeyHeader?: string
  /** Header carrying the platform-supplied model endpoint. Defaults to `x-dsh-model-base-url`. */
  modelBaseUrlHeader?: string
}

/**
 * Load the plugin.
 * @param ctx - plugin context; every registration is effect-scoped.
 * @param config - credentials, headers, and streaming knobs.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const credentials = config.apps === undefined
    ? loadCredentials(requireCredentialsPath(config.credentialsFile))
    : validateInline(config.apps)
  const headers: AuthHeaders = {
    appId: (config.headers?.appId ?? DEFAULT_HEADERS.appId).toLowerCase(),
    appKey: (config.headers?.appKey ?? DEFAULT_HEADERS.appKey).toLowerCase(),
    userId: (config.headers?.userId ?? DEFAULT_HEADERS.userId).toLowerCase(),
    requestId: (config.headers?.requestId ?? DEFAULT_HEADERS.requestId).toLowerCase(),
  }

  // Model keys live only in this process and only while the session is active.
  const modelKeys = new Map<string, string>()
  const store: SessionModelKeys = {
    get: sessionId => modelKeys.get(sessionId),
    set: (sessionId, key) => {
      if (!modelKeys.has(sessionId) && modelKeys.size >= 10_000) {
        const oldest = modelKeys.keys().next().value
        if (oldest !== undefined) modelKeys.delete(oldest)
      }
      modelKeys.set(sessionId, key)
    },
    delete: sessionId => void modelKeys.delete(sessionId),
  }
  ctx.provide('sessionModelKeys', store)

  // Model endpoints are supplied by the platform with each create/resume.
  // Profile routes use the sentinel host; the request-time rewrite below picks
  // the endpoint registered for the session currently running.
  const modelBaseUrlsById = new Map<string, string>()
  let latestModelBaseUrl: string | undefined
  const modelBaseUrls: SessionModelBaseUrls = {
    get: sessionId => modelBaseUrlsById.get(sessionId),
    set: (sessionId, baseUrl) => {
      if (!modelBaseUrlsById.has(sessionId) && modelBaseUrlsById.size >= 10_000) {
        const oldest = modelBaseUrlsById.keys().next().value
        if (oldest !== undefined) modelBaseUrlsById.delete(oldest)
      }
      modelBaseUrlsById.set(sessionId, baseUrl)
      latestModelBaseUrl = baseUrl
    },
    delete: sessionId => {
      modelBaseUrlsById.delete(sessionId)
      latestModelBaseUrl = [...modelBaseUrlsById.values()].at(-1)
    },
    latest: () => latestModelBaseUrl,
  }
  ctx.provide('sessionModelBaseUrls', modelBaseUrls)

  // E2B runtime configuration is deployment-global and owned by the platform.
  let sandboxConfig: Parameters<SandboxConfigStore['set']>[0] | undefined
  const sandboxStore: SandboxConfigStore = {
    get: () => sandboxConfig,
    set: config => {
      sandboxConfig = config
    },
  }
  ctx.provide('sandboxConfig', sandboxStore)

  let imageConfig: Parameters<ImageConfigStore['set']>[0] | undefined
  const imageStore: ImageConfigStore = {
    get: () => imageConfig,
    set: config => {
      imageConfig = config
    },
  }
  ctx.provide('imageConfig', imageStore)
  installModelEndpointRewrite(ctx, modelBaseUrls)
  ctx.on('session/disposed', session => {
    store.delete(String(session.id))
    modelBaseUrls.delete(String(session.id))
  })

  // Another replica took the write lease. Stop the live turn here instead of
  // letting tools keep producing side effects this process cannot persist.
  ctx.on('session/lease-lost', sessionId => {
    const agents = ctx.get('agents') as { get(id: string): Agent | undefined } | undefined
    agents?.get(sessionId)?.cancel(
      { kind: 'hook', reason: 'session lease moved to another replica' },
      { keepInbox: true },
    )
  })

  installJobObservability(ctx)

  registerRoutes(ctx, {
    gateway: createGateway(ctx),
    ownership: createOwnershipGuard(ctx),
    credentials,
    headers,
    requireUser: config.requireUser ?? true,
    modelKeys: store,
    modelBaseUrls,
    sandboxConfig: sandboxStore,
    imageConfig: imageStore,
    ...(config.modelKeyHeader === undefined ? {} : { modelKeyHeader: config.modelKeyHeader }),
    ...(config.modelBaseUrlHeader === undefined ? {} : { modelBaseUrlHeader: config.modelBaseUrlHeader }),
    ...(config.pageSize === undefined ? {} : { pageSize: config.pageSize }),
    ...(config.heartbeatMs === undefined ? {} : { heartbeatMs: config.heartbeatMs }),
  })

  ctx.logger?.info?.(
    `platform-api ready: ${credentials.length} app credential(s), routes under /brain/v1/sessions`,
  )
}

/** The subset of one job projection this module logs. */
interface JobLogView {
  readonly id: string
  readonly kind: string
  readonly status: string
}

/**
 * Log background-job lifecycle and which jobs die with this process.
 *
 * The job registry is process memory. A restart drops every record while the
 * sandbox process may still be running, so the loss has to be visible in the
 * brain log rather than silently making the Dashboard panel go empty.
 * @param ctx - plugin context that may carry a job registry.
 */
function installJobObservability(ctx: Context): void {
  const jobs = ctx.get('jobs') as {
    events?: {
      subscribe(filter: { owners: 'all' }, listener: (event: {
        type: 'registered' | 'progress' | 'stopping' | 'removed' | 'settled'
        job: JobLogView
        cause?: string
      }) => void): () => void
    }
  } | undefined
  if (jobs?.events === undefined) return

  const live = new Map<string, string>()
  ctx.effect(() => {
    const unsubscribe = jobs.events?.subscribe({ owners: 'all' }, event => {
      switch (event.type) {
        case 'registered':
          live.set(event.job.id, event.job.kind)
          ctx.logger?.info?.(`platform-api: job.registered ${event.job.id} (${event.job.kind})`)
          return
        case 'settled':
          live.delete(event.job.id)
          ctx.logger?.info?.(
            `platform-api: job.settle ${event.job.id} ${event.job.status} cause=${event.cause ?? 'unknown'}`,
          )
          return
        case 'removed':
          live.delete(event.job.id)
          return
        default:
          return
      }
    })
    return () => {
      unsubscribe?.()
      if (live.size > 0) {
        ctx.logger?.warn?.(
          `platform-api: ${live.size} background job(s) are lost with this process: ${[...live.keys()].join(', ')}`,
        )
      }
      live.clear()
    }
  }, 'platform-api: job observability')
}

/**
 * Rewrite model-provider requests from the sentinel host to the endpoint the
 * platform registered for the running session.
 *
 * The LLM adapters capture one static provider endpoint, while the platform
 * owns it per session. The rewrite is scoped to the sentinel hostname, so every
 * other fetch in the process is untouched.
 * @param ctx - plugin context carrying the Agent registry.
 * @param store - per-session endpoint registry.
 */
function installModelEndpointRewrite(ctx: Context, store: SessionModelBaseUrls): void {
  ctx.effect(() => {
    const original = globalThis.fetch
    const wrapped: typeof fetch = async (input, init) => {
      const requestUrl = input instanceof Request ? new URL(input.url) : new URL(String(input))
      if (requestUrl.hostname !== MODEL_ENDPOINT_SENTINEL) return original(input, init)

      const sessionId = currentSessionId(ctx)
      const baseUrl = (sessionId === undefined ? undefined : store.get(sessionId)) ?? store.latest()
      if (baseUrl === undefined) {
        throw new Error('platform-api: no platform model endpoint registered for this session')
      }
      const target = new URL(baseUrl)
      const basePath = target.pathname.replace(/\/+$/u, '')
      if (basePath !== '' && requestUrl.pathname !== basePath && !requestUrl.pathname.startsWith(`${basePath}/`)) {
        target.pathname = `${basePath}${requestUrl.pathname}`
      } else {
        target.pathname = requestUrl.pathname
      }
      target.search = requestUrl.search
      const rewritten = target.toString()
      return original(
        input instanceof Request ? new Request(rewritten, input) : rewritten,
        input instanceof Request ? undefined : init,
      )
    }
    globalThis.fetch = wrapped
    return () => {
      if (globalThis.fetch === wrapped) globalThis.fetch = original
    }
  }, 'platform-api: model endpoint rewrite')
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

/**
 * Resolve the credential file path, falling back to the environment.
 * @param configured - the config value, when present.
 * @returns the absolute path.
 * @throws when neither the config nor `DSH_PLATFORM_APPS` names a file.
 */
function requireCredentialsPath(configured: string | undefined): string {
  const path = configured ?? process.env.DSH_PLATFORM_APPS
  if (path === undefined || path === '') {
    throw new Error('platform-api: credentialsFile is required (or set DSH_PLATFORM_APPS)')
  }
  return path
}

/**
 * Validate inline credentials with the same rules as the credential file.
 * @param apps - inline app credentials.
 * @returns the validated credentials.
 * @throws when an entry is malformed or an appId repeats.
 */
function validateInline(apps: readonly { appId: string; appKey: string; name?: string }[]): AppCredential[] {
  if (apps.length === 0) throw new Error('platform-api: apps must not be empty')
  const seen = new Set<string>()
  return apps.map((app, index) => {
    if (typeof app.appId !== 'string' || app.appId === '') {
      throw new Error(`platform-api: apps[${index}].appId must be a non-empty string`)
    }
    if (typeof app.appKey !== 'string' || app.appKey.length < 16) {
      throw new Error(`platform-api: apps[${index}].appKey must be at least 16 characters`)
    }
    if (seen.has(app.appId)) throw new Error(`platform-api: duplicate appId "${app.appId}"`)
    seen.add(app.appId)
    return app.name === undefined
      ? { appId: app.appId, appKey: app.appKey }
      : { appId: app.appId, appKey: app.appKey, name: app.name }
  })
}
