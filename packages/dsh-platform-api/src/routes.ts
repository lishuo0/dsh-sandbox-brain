/**
 * The four endpoints the platform needs.
 *
 *   POST /brain/v1/sessions                    create
 *   POST /brain/v1/sessions/{id}/messages      submit
 *   POST /brain/v1/sessions/{id}/cancel        interrupt
 *   GET  /brain/v1/sessions/{id}/events        subscribe (SSE)
 *
 * Everything else — listing, search, statistics — the platform reads straight
 * from its own database. Those queries are user-scoped, and DSH has no user
 * concept, so routing them through the brain would either leak other tenants'
 * sessions or cost a replica round-trip for data already in SQL.
 *
 * @module @brain/dsh-platform-api/routes
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { AuthError, authenticate, type AppCredential, type AuthHeaders, type AuthenticatedCaller } from './auth.ts'
import { HttpError, SseWriter, handle, query, readJson, segmentsAfter, sendError, sendJson } from './http.ts'
import { normalizeOutcome, type SessionStream } from './session-stream.ts'
import {
  parseBootstrap,
  parseSecret,
  runBootstrap,
  type SessionSecretStore,
} from './session-setup.ts'
import type { SessionModelKeys } from '@brain/dsh-credentials-session'
import { evaluate, parseEvaluate } from './evaluate.ts'
import { providerOfApi } from './model-protocol.ts'
import { handleWorkspaceFiles } from './workspace-files.ts'

/** Prefix every route lives under. */
export const PREFIX = '/brain/v1/sessions'

/** 定时任务的 Remote 转发入口。 */
const SCHEDULE_PREFIX = '/brain/v1/schedule'

/** 无会话的一次性评估入口。 */
const EVALUATE_PATH = '/brain/v1/superagent/evaluate'

/** One frame on the live stream. */
export type StreamFrame =
  /**
   * A committed event: durable, replayable, identical to what the log holds.
   *
   * `surfaceOp`/`sourceEventSeqs` ride along because the browser rebuilds its
   * ordered surface from these frames; dropping them makes upstream's session
   * store reject surface-eligible events ("requires a surfaceOp marker").
   */
  | {
      readonly kind: 'event'
      readonly seq: number
      readonly type: string
      readonly data: unknown
      readonly surfaceOp?: unknown
      readonly sourceEventSeqs?: unknown
      readonly ignorable?: boolean
    }
  /** An assistant streaming chunk: process-local, never stored, arrives during a step. */
  | { readonly kind: 'assistant'; readonly frame: unknown }
  /** Driver status for this session: running / idle / … */
  | { readonly kind: 'status'; readonly status: string }
  /** Inbox transition: queued, claimed into a turn, or discarded. */
  | { readonly kind: 'inbox'; readonly phase: 'inserted' | 'claimed' | 'discarded' }

/** One job roster frame: the complete visible set after a lifecycle change. */
export type JobRowsFrame = {
  readonly type: 'rows'
  readonly jobs: readonly unknown[]
}

/**
 * One job observation frame.
 *
 * Deliberately identical to `@deepseek-ai/dsh-api-job-controller`'s
 * `JobFollowFrame`: the Dashboard feeds these straight into the upstream job
 * controller, so inventing fields here would break the client.
 */
export type JobFollowFrame =
  | { readonly type: 'opened'; readonly job: unknown; readonly from: number }
  | { readonly type: 'output'; readonly chunks: readonly unknown[]; readonly next: number; readonly lossy?: true }
  | { readonly type: 'status'; readonly job: unknown }

/** What the routes need from the brain. */
export interface BrainGateway {
  /** Create or adopt a session and return its id. */
  create(input: { cwd: string; preset?: string; sessionId?: string }): Promise<{ sessionId: string }>
  /**
   * Submit one user message.
   *
   * `mode: 'queue'` (the default) starts or queues a turn; `mode: 'steer'`
   * folds the text into the turn that is currently running, at its next step
   * boundary. They are different operations, not two spellings of one.
   */
  prompt(sessionId: string, text: string, requestId: string, mode?: 'queue' | 'steer'): Promise<void>
  /** Fork one session's committed log into a new session; the log lives here. */
  fork?(sessionId: string, request: { atSeq?: number }): Promise<{ sessionId: string }>
  /** Interrupt the active turn. */
  cancel(sessionId: string): Promise<void>
  /**
   * Current durable offset and driver state for one session.
   *
   * `cursor` is the last committed seq (-1 when the log is empty); `running`
   * is the live Agent status, so a client that attaches learns the initial
   * state instead of waiting for the next transition.
   */
  head(sessionId: string): Promise<{ cursor: number; running: boolean }>
  /** Read committed events with `seq` greater than `after`. */
  events(sessionId: string, after: number, limit: number): Promise<Array<{ seq: number; type: string; data: unknown }>>
  /**
   * Subscribe to everything a renderer needs: committed events, live assistant
   * chunks, driver status and inbox transitions.
   */
  subscribe(sessionId: string, listener: (frame: StreamFrame) => void): () => void
  /** Provider-grouped catalog plus the deployment default model. */
  models?(): Promise<unknown>
  /** Make these model ids selectable on one provider (the platform names them per user). */
  registerModels?(provider: string, models: readonly string[]): Promise<void>
  /** Install one Session-local model selection and return the normalized value. */
  selectModel?(sessionId: string, selection: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<unknown>
  /** Effective slash-command descriptors for one live Session. */
  commands?(sessionId: string): Promise<unknown>
  /** Execute one slash-command line without sending it to the model. */
  executeCommand?(sessionId: string, line: string, attachments?: readonly unknown[]): Promise<unknown>
  /** Current goal for one live Session. */
  goal?(sessionId: string): Promise<unknown>
  /** Whole-value goal edit (objective and/or round cap). */
  editGoal?(sessionId: string, request: unknown): Promise<unknown>
  /** Pause, resume, complete, or clear one goal. */
  goalAction?(sessionId: string, action: 'pause' | 'resume' | 'complete' | 'clear', request: unknown): Promise<unknown>
  /** Agent preset roster. */
  presets?(): Promise<unknown>
  /** One agent preset document. */
  readPreset?(agentPreset: string): Promise<unknown>
  /** Select a preset for a Session. */
  selectPreset?(sessionId: string, agentPreset: string): Promise<unknown>
  /** Process permission-preset catalog. */
  permissionCatalog?(): Promise<unknown>
  /**
   * Invoke one Typert Remote namespace in-process.
   *
   * Only the `schedule` namespace travels this way: the platform scopes its
   * arguments to the member's Sessions, then forwards the call. The brain never
   * exposes `/api/*` to the network; this stays behind `/brain/v1`.
   */
  remote?(namespace: string, method: string, args: Record<string, unknown>): Promise<unknown>
  /** Current projection baseline (or cached hints) for one Session. */
  projections?(sessionId: string): Promise<unknown>
  /** Current per-message feedback items for one Session. */
  messageFeedbackList?(sessionId: string): Promise<unknown>
  /** Create or replace one message feedback item. */
  messageFeedbackPut?(sessionId: string, request: unknown): Promise<unknown>
  /** Delete one message feedback item. */
  messageFeedbackDelete?(sessionId: string, request: unknown): Promise<unknown>
  /** Record one Session-level remark. */
  sessionFeedbackRecord?(sessionId: string, request: unknown): Promise<unknown>
  /** Force-close a turn whose writer never reached quiescence. */
  forceCancel?(sessionId: string): Promise<{ closed: boolean; events: number }>
  /** Stream the jobs one session can see, replaced whole after each change. */
  listJobs?(sessionId: string, signal: AbortSignal): AsyncIterable<JobRowsFrame>
  /** Stream one job's retained output until it settles. */
  followJob?(sessionId: string, jobId: string, from: number | undefined, signal: AbortSignal): AsyncIterable<JobFollowFrame>
  /** Request cancellation of one background job. */
  killJob?(sessionId: string, jobId: string): Promise<{ outcome: 'requested' | 'already-finished' }>
}

/** Per-session model endpoint supplied by the platform. */
export interface SessionModelBaseUrls {
  get(sessionId: string): string | undefined
  set(sessionId: string, baseUrl: string): void
  delete(sessionId: string): void
  latest(): string | undefined
}

/** E2B / OSS runtime configuration supplied by the platform. Groups are independent. */
export interface SandboxConfig {
  readonly apiKey?: string
  readonly apiUrl?: string
  readonly domain?: string
  readonly template?: string
  readonly roleArn?: string
  readonly ossBucket?: string
  readonly ossEndpoint?: string
  readonly ossRegion?: string
  readonly ossAccessKeyId?: string
  readonly ossAccessKeySecret?: string
}

/** Platform-supplied image generation settings. */
export interface ImageRuntimeConfig {
  readonly baseUrl: string
  readonly models: readonly string[]
  readonly defaultModel: string
  readonly outputDir: string
}

/** Global image generation configuration store. */
export interface ImageConfigStore {
  get(): ImageRuntimeConfig | undefined
  set(config: ImageRuntimeConfig): void
}

/** Global sandbox runtime configuration store. */
export interface SandboxConfigStore {
  get(): SandboxConfig | undefined
  set(config: SandboxConfig): void
}

/** Validate one absolute HTTP(S) model endpoint. */
function modelBaseUrlOf(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === '') return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  return trimmed.replace(/\/+$/u, '')
}

/**
 * Read the platform-supplied runtime configuration from one create request.
 *
 * E2B and attachment OSS are independent: a Docker/mock deployment can use OSS
 * for attachments without supplying any E2B value. Fill only the groups whose
 * fields all arrived, so a partial group never shadows the brain's own config.
 */
export function sandboxConfigOf(
  headers: Record<string, string | string[] | undefined>,
): SandboxConfig | undefined {
  const value = (name: string): string => {
    const raw = headers[name]
    return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? ''
  }
  const config: SandboxConfig = {}
  const apiKey = value('x-dsh-e2b-api-key')
  const apiUrl = value('x-dsh-e2b-api-url')
  const template = value('x-dsh-e2b-template')
  if (apiKey !== '' && apiUrl !== '' && template !== '') {
    Object.assign(config, {
      apiKey,
      apiUrl,
      domain: value('x-dsh-e2b-domain'),
      template,
      roleArn: value('x-dsh-e2b-role-arn'),
    })
  }
  const ossBucket = value('x-dsh-oss-bucket')
  const ossEndpoint = value('x-dsh-oss-endpoint')
  const ossAccessKeyId = value('x-dsh-oss-access-key-id')
  const ossAccessKeySecret = value('x-dsh-oss-access-key-secret')
  if (ossBucket !== '' && ossEndpoint !== '' && ossAccessKeyId !== '' && ossAccessKeySecret !== '') {
    Object.assign(config, {
      ossBucket,
      ossEndpoint,
      ossRegion: value('x-dsh-oss-region'),
      ossAccessKeyId,
      ossAccessKeySecret,
    })
  }
  return Object.keys(config).length === 0 ? undefined : config
}

/** Read image generation settings from one create request. */
function imageConfigOf(
  headers: Record<string, string | string[] | undefined>,
): ImageRuntimeConfig | undefined {
  const value = (name: string): string => {
    const raw = headers[name]
    return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? ''
  }
  const baseUrl = value('x-dsh-image-base-url').replace(/\/+$/u, '')
  if (baseUrl === '') return undefined
  const models = value('x-dsh-image-models').split(',').map(model => model.trim()).filter(model => model !== '')
  return {
    baseUrl,
    models,
    defaultModel: value('x-dsh-image-default-model'),
    outputDir: value('x-dsh-image-output-dir'),
  }
}

/** Route configuration. */
export interface RouteConfig {
  readonly gateway: BrainGateway
  /** Ownership guard; omitted only where there is no tenant boundary (a dev box). */
  readonly ownership?: { assert(sessionId: string, userId: string): Promise<void> }
  readonly credentials: readonly AppCredential[]
  readonly headers: AuthHeaders
  /** Reject requests whose user header is absent. */
  readonly requireUser?: boolean
  /** Upper bound for one events page. */
  readonly pageSize?: number
  /** SSE heartbeat interval; keeps proxies and load balancers from idling out. */
  readonly heartbeatMs?: number
  /** Per-session model-key store; absent in tests that do not exercise model keys. */
  readonly modelKeys?: SessionModelKeys
  /** Header carrying the platform-supplied model key. Defaults to `x-dsh-model-key`. */
  readonly modelKeyHeader?: string
  /** Per-session model endpoint store; absent in tests that do not exercise endpoints. */
  readonly modelBaseUrls?: SessionModelBaseUrls
  /** Header carrying the platform-supplied model endpoint. Defaults to `x-dsh-model-base-url`. */
  readonly modelBaseUrlHeader?: string
  /** Header carrying every model the user has configured. Defaults to `x-dsh-model-ids`. */
  readonly modelIdsHeader?: string
  /** Header carrying the wire protocol the member configured. Defaults to `x-dsh-model-api`. */
  readonly modelApiHeader?: string
  /** Sandbox runtime configuration store; absent when the platform does not manage E2B. */
  readonly sandboxConfig?: SandboxConfigStore
  /** Image generation configuration store; absent when image generation is not enabled. */
  readonly imageConfig?: ImageConfigStore
  /** 会话实时面；未装配时 `stream` / `answers` 回 501。 */
  readonly sessionStream?: SessionStream
  /** 平台下发、只存在内存里的会话级子进程令牌；未装配时忽略 `secret`。 */
  readonly sessionSecrets?: SessionSecretStore
}

/**
 * Register every route on the webserver.
 * @param ctx - plugin context; registrations are effect-scoped.
 * @param config - routes and authentication.
 */
export function registerRoutes(ctx: Context, config: RouteConfig): void {
  const pageSize = config.pageSize ?? 200
  const heartbeatMs = config.heartbeatMs ?? 15_000
  const modelKeyHeader = (config.modelKeyHeader ?? 'x-dsh-model-key').toLowerCase()
  const modelBaseUrlHeader = (config.modelBaseUrlHeader ?? 'x-dsh-model-base-url').toLowerCase()
  const modelIdsHeader = (config.modelIdsHeader ?? 'x-dsh-model-ids').toLowerCase()
  const modelApiHeader = (config.modelApiHeader ?? 'x-dsh-model-api').toLowerCase()

  /** Authenticate one request, or answer 401 and return undefined. */
  const caller = (req: IncomingMessage, res: ServerResponse): AuthenticatedCaller | undefined => {
    try {
      const authenticated = authenticate(name => {
        const value = req.headers[name]
        return Array.isArray(value) ? value[0] : value
      }, config.credentials, config.headers)
      if (config.requireUser === true && authenticated.userId === undefined) {
        sendError(res, 401, 'user-required', `missing ${config.headers.userId} header`)
        return undefined
      }
      return authenticated
    } catch (error) {
      if (error instanceof AuthError) {
        sendError(res, 401, 'unauthorized', 'invalid credentials')
        return undefined
      }
      throw error
    }
  }

  const diagnose = (error: unknown): void => {
    ctx.logger?.warn?.(`platform-api: request failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  /**
   * Re-assert the member's model ids on the process-wide provider catalog.
   *
   * Registration lives in the provider's live config, not in the database, so
   * it disappears when the brain restarts. Every platform call is an
   * opportunity to restore it; the operation is idempotent.
   */
  /** 本次请求的协议路由；不认识就直接 400，别等副作用发生后再抛。 */
  const protocolOf = (headers: IncomingHttpHeaders): string =>
    providerOfApi(headerValue(headers[modelApiHeader]))

  const registerModelsFromHeaders = async (headers: IncomingHttpHeaders, provider: string): Promise<void> => {
    if (config.gateway.registerModels === undefined) return
    const raw = headers[modelIdsHeader]
    const value = Array.isArray(raw) ? raw[0] : raw
    const models = (value ?? '').split(',').map(id => id.trim()).filter(id => id !== '')
    if (models.length > 0) await config.gateway.registerModels(provider, models)
  }

  // 平台改了 `dsh_workspaces` 之后，让脑重新投影工作区。租户由平台判定，这里只认应用凭据。
  ctx.webServer.register({
    kind: 'exact',
    path: '/brain/v1/workspaces/sync',
    handler: (req, res) => void handle(req, res, async () => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'method-not-allowed', 'use POST')
        return
      }
      try {
        authenticate(name => {
          const value = req.headers[name]
          return Array.isArray(value) ? value[0] : value
        }, config.credentials, config.headers)
      } catch (error) {
        if (error instanceof AuthError) {
          sendError(res, 401, 'unauthorized', 'invalid credentials')
          return
        }
        throw error
      }
      const registry = ctx.get('workspaceRegistry') as unknown as { refresh?: () => Promise<void> } | undefined
      await registry?.refresh?.()
      sendJson(res, 200, { ok: true })
    }, diagnose),
  })

  /**
   * Stream an async iterable as SSE.
   *
   * A client disconnect aborts the iterable and releases the job subscriptions
   * behind it; the heartbeat keeps idle proxies from closing the connection.
   */
  const streamSse = async (
    req: IncomingMessage,
    res: ServerResponse,
    iterate: (signal: AbortSignal) => AsyncIterable<{ readonly type: string }>,
  ): Promise<void> => {
    const controller = new AbortController()
    // Resolve the first frame before writing headers. An unknown job throws
    // while opening its stream, and only an unopened response can still become
    // the documented 404 instead of an empty 200 that looks like a broken job.
    const closeInput = (): void => controller.abort()
    req.on('close', closeInput)
    const iterator = iterate(controller.signal)[Symbol.asyncIterator]()
    let first: IteratorResult<{ readonly type: string }>
    try {
      first = await iterator.next()
    } catch (error) {
      req.off('close', closeInput)
      throw error
    }

    const sse = new SseWriter(res)
    const heartbeat = setInterval(() => sse.comment('keepalive'), heartbeatMs)
    heartbeat.unref?.()
    const finish = (): void => {
      clearInterval(heartbeat)
      controller.abort()
      sse.close()
    }
    req.on('close', finish)
    res.on('close', finish)
    try {
      for (let next = first; next.done !== true; next = await iterator.next()) {
        if (controller.signal.aborted) break
        sse.send(next.value.type, next.value)
      }
    } finally {
      req.off('close', closeInput)
      finish()
    }
  }

  // POST /brain/v1/sessions
  ctx.webServer.register({
    kind: 'exact',
    path: PREFIX,
    handler: (req, res) => void handle(req, res, async () => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'method-not-allowed', 'use POST')
        return
      }
      const who = caller(req, res)
      if (who === undefined) return
      let modelKey: string | undefined
      if (config.modelKeys !== undefined) {
        const raw = req.headers[modelKeyHeader]
        const value = Array.isArray(raw) ? raw[0] : raw
        modelKey = value?.trim()
        if (modelKey === undefined || modelKey === '') {
          throw new HttpError(400, 'model-key-required', `missing ${modelKeyHeader} header`)
        }
      }
      const sandbox = sandboxConfigOf(req.headers)
      const image = imageConfigOf(req.headers)
      let modelBaseUrl: string | undefined
      if (config.modelBaseUrls !== undefined) {
        const raw = req.headers[modelBaseUrlHeader]
        const value = Array.isArray(raw) ? raw[0] : raw
        modelBaseUrl = modelBaseUrlOf(value)
        if (modelBaseUrl === undefined) {
          throw new HttpError(400, 'model-base-url-required', `missing or invalid ${modelBaseUrlHeader} header`)
        }
      }
      const body = await readJson(req)
      const input = asObject(body)
      const cwd = optionalString(input.cwd)
      if (cwd === undefined || !cwd.startsWith('/')) {
        throw new HttpError(400, 'invalid-cwd', 'cwd must be an absolute path')
      }
      // 校验放在建会话之前：参数错误不该留下一个半配置的会话。
      const secret = parseSecret(input.secret)
      const bootstrap = parseBootstrap(input.bootstrap)
      const provider = protocolOf(req.headers)
      const created = await config.gateway.create({
        cwd,
        ...(optionalString(input.preset) === undefined ? {} : { preset: optionalString(input.preset) as string }),
        ...(optionalString(input.sessionId) === undefined ? {} : { sessionId: optionalString(input.sessionId) as string }),
      })
      if (modelKey !== undefined) config.modelKeys?.set(created.sessionId, modelKey)
      if (modelBaseUrl !== undefined) config.modelBaseUrls?.set(created.sessionId, modelBaseUrl)
      if (sandbox !== undefined) config.sandboxConfig?.set(sandbox)
      if (image !== undefined) config.imageConfig?.set(image)
      // 省略即清除：会话不会继承上一次 create 留下的令牌。
      config.sessionSecrets?.set(created.sessionId, secret)
      await registerModelsFromHeaders(req.headers, provider)
      const modelId = headerValue(req.headers['x-dsh-model-id'])
      if (modelId !== undefined && config.gateway.selectModel !== undefined) {
        await config.gateway.selectModel(created.sessionId, { provider, model: modelId })
      }
      if (bootstrap !== undefined) {
        await runBootstrap(ctx, created.sessionId, bootstrap, cwd, secret)
      }
      sendJson(res, 201, { sessionId: created.sessionId, requestId: who.requestId })
    }, diagnose),
  })

  // POST /brain/v1/superagent/evaluate
  //
  // 无会话的一次性模型调用：平台已经判定线程归哪个工作区，这里只回答
  // 「要不要接活、范围是什么」。模型配置只认本次请求头，不回落到进程里
  // 最近注册的值，否则一个成员会用到另一个成员的端点。
  ctx.webServer.register({
    kind: 'exact',
    path: EVALUATE_PATH,
    handler: (req, res) => void handle(req, res, async () => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'method-not-allowed', 'use POST')
        return
      }
      const who = caller(req, res)
      if (who === undefined) return
      const modelKey = headerValue(req.headers[modelKeyHeader])?.trim()
      if (modelKey === undefined || modelKey === '') {
        throw new HttpError(400, 'model-key-required', `missing ${modelKeyHeader} header`)
      }
      const modelBaseUrl = modelBaseUrlOf(headerValue(req.headers[modelBaseUrlHeader]))
      if (modelBaseUrl === undefined) {
        throw new HttpError(400, 'model-base-url-required', `missing or invalid ${modelBaseUrlHeader} header`)
      }
      const input = parseEvaluate(await readJson(req))
      const provider = protocolOf(req.headers)
      await registerModelsFromHeaders(req.headers, provider)
      const modelId = headerValue(req.headers['x-dsh-model-id'])
      // 客户端走了就没人要这个结论了，别再为空请求付模型钱。
      const abort = new AbortController()
      const onClose = (): void => abort.abort()
      req.on('close', onClose)
      try {
        sendJson(res, 200, await evaluate(ctx, input, {
          modelKey,
          baseUrl: modelBaseUrl,
          api: headerValue(req.headers[modelApiHeader]),
          ...(modelId === undefined ? {} : { modelId }),
        }, abort.signal))
      } finally {
        req.off('close', onClose)
      }
    }, diagnose),
  })

  /** Register one read-only exact route backed by an optional gateway method. */
  const exact = (path: string, method: 'GET', read: () => Promise<unknown>): void => {
    ctx.webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => void handle(req, res, async () => {
        if (req.method !== method) {
          sendError(res, 405, 'method-not-allowed', `use ${method}`)
          return
        }
        const who = caller(req, res)
        if (who === undefined) return
        sendJson(res, 200, await read())
      }, diagnose),
    })
  }

  if (config.gateway.models !== undefined) {
    exact('/brain/v1/models', 'GET', async () => config.gateway.models?.())
  }
  if (config.gateway.presets !== undefined) {
    exact('/brain/v1/presets', 'GET', async () => config.gateway.presets?.())
  }
  if (config.gateway.permissionCatalog !== undefined) {
    exact('/brain/v1/permission-presets', 'GET', async () => config.gateway.permissionCatalog?.())
  }

  // POST /brain/v1/schedule/{action}
  //
  // 定时任务是唯一一个只有 Typert Remote 形态的命名空间（`@brain/dsh-schedule-tasks`）；
  // 平台补好成员会话范围后从这里转发。脑不暴露 `/api/*`，这是唯一入口，凭据与其它
  // `/brain/v1` 路由相同。回包保持 Remote 信封，平台按 `result.ok` 分流。
  ctx.webServer.register({
    kind: 'prefix',
    path: SCHEDULE_PREFIX,
    handler: (req, res) => void handle(req, res, async () => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'method-not-allowed', 'use POST')
        return
      }
      const who = caller(req, res)
      if (who === undefined) return
      const parts = segmentsAfter(req.url ?? '/', SCHEDULE_PREFIX)
      if (parts.length !== 1 || parts[0] === undefined || parts[0] === '') {
        sendError(res, 404, 'not-found', 'unknown schedule action')
        return
      }
      const body = asObject(await readJson(req))
      const payload = body?.payload !== undefined && typeof body.payload === 'object' && body.payload !== null
        ? body.payload as Record<string, unknown>
        : undefined
      const args = payload?.args !== undefined && typeof payload.args === 'object' && payload.args !== null
        ? payload.args as Record<string, unknown>
        : {}
      const rpcId = optionalString(body?.rpcId) ?? ''
      const invoke = config.gateway.remote
      if (invoke === undefined) {
        sendError(res, 501, 'not-supported', 'the remote gateway is not composed')
        return
      }
      try {
        const value = await invoke('schedule', parts[0], args)
        sendJson(res, 200, { type: 'server-response', rpcId, result: { ok: true, value } })
      } catch (error) {
        const code = (error as { code?: unknown }).code
        sendJson(res, 200, {
          type: 'server-response',
          rpcId,
          result: {
            ok: false,
            error: {
              code: typeof code === 'string' && code !== '' ? code : 'schedule/input-invalid',
              message: error instanceof Error ? error.message : String(error),
            },
          },
        })
      }
    }, diagnose),
  })

  // Everything under /brain/v1/sessions/{id}/…
  ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => void handle(req, res, async () => {
      const parts = segmentsAfter(req.url ?? '/', PREFIX)
      // parts: [sessionId, action], [sessionId, 'goal', action], or
      //        [sessionId, 'jobs', jobId, verb]
      if (parts.length !== 2 && parts.length !== 3 && parts.length !== 4) {
        sendError(res, 404, 'not-found', 'unknown route')
        return
      }
      const [sessionId, action, subaction, verb] = parts as [string, string, string | undefined, string | undefined]
      const who = caller(req, res)
      if (who === undefined) return
      // Model registration is process-wide and idempotent, so every platform
      // call may re-assert it. A command (compaction) or a model selection
      // resolves the model through the provider catalog without a platform
      // round-trip of its own, and the registration is lost on brain restart.
      const protocol = protocolOf(req.headers)
      await registerModelsFromHeaders(req.headers, protocol)
      // Ownership first: every action below touches someone's session.
      if (config.ownership !== undefined && who.userId !== undefined) {
        await config.ownership.assert(sessionId, who.userId)
      }

      switch (action) {
        case 'messages': {
          if (req.method !== 'POST') {
            sendError(res, 405, 'method-not-allowed', 'use POST')
            return
          }
          const body = asObject(await readJson(req))
          const text = optionalString(body.text)
          if (text === undefined || text.trim() === '') {
            throw new HttpError(400, 'invalid-text', 'text is required')
          }
          const mode = optionalString(body.mode)
          if (mode !== undefined && mode !== 'queue' && mode !== 'steer') {
            throw new HttpError(400, 'invalid-mode', "mode must be 'queue' or 'steer'")
          }
          await config.gateway.prompt(sessionId, text, who.requestId, mode as 'queue' | 'steer' | undefined)
          sendJson(res, 202, { accepted: true, requestId: who.requestId })
          return
        }

        case 'fork': {
          if (req.method !== 'POST') {
            sendError(res, 405, 'method-not-allowed', 'use POST')
            return
          }
          if (config.gateway.fork === undefined) {
            sendError(res, 501, 'not-supported', 'fork is not available on this deployment')
            return
          }
          const body = asObject(await readJson(req))
          const atSeq = body.atSeq
          if (atSeq !== undefined && (typeof atSeq !== 'number' || !Number.isSafeInteger(atSeq) || atSeq < 0)) {
            throw new HttpError(400, 'invalid-at-seq', 'atSeq must be a non-negative integer')
          }
          const forked = await config.gateway.fork(
            sessionId,
            atSeq === undefined ? {} : { atSeq: atSeq as number },
          )
          sendJson(res, 201, { sessionId: forked.sessionId, requestId: who.requestId })
          return
        }

        case 'model': {
          if (req.method !== 'POST') {
            sendError(res, 405, 'method-not-allowed', 'use POST')
            return
          }
          if (config.gateway.selectModel === undefined) {
            sendError(res, 501, 'not-supported', 'model selection is not available on this deployment')
            return
          }
          const body = asObject(await readJson(req))
          const model = optionalString(body.model) ?? optionalString(body.modelId)
          const provider = optionalString(body.provider) ??
            (model === undefined ? undefined : protocol)
          if (provider === undefined || model === undefined) {
            throw new HttpError(400, 'invalid-model', 'provider and model are required')
          }
          const effort = optionalString(body.reasoningEffort)
          const selected = await config.gateway.selectModel(sessionId, {
            provider,
            model,
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
          })
          sendJson(res, 200, selected)
          return
        }

        case 'message-feedback': {
          if (req.method === 'GET') {
            if (config.gateway.messageFeedbackList === undefined) {
              sendError(res, 501, 'not-supported', 'message feedback is not composed')
              return
            }
            sendJson(res, 200, await config.gateway.messageFeedbackList(sessionId))
            return
          }
          const body = asObject(await readJson(req))
          if (req.method === 'POST') {
            if (config.gateway.messageFeedbackPut === undefined) {
              sendError(res, 501, 'not-supported', 'message feedback is not composed')
              return
            }
            sendJson(res, 200, await config.gateway.messageFeedbackPut(sessionId, body))
            return
          }
          if (req.method === 'DELETE') {
            if (config.gateway.messageFeedbackDelete === undefined) {
              sendError(res, 501, 'not-supported', 'message feedback is not composed')
              return
            }
            sendJson(res, 200, await config.gateway.messageFeedbackDelete(sessionId, body))
            return
          }
          sendError(res, 405, 'method-not-allowed', 'use GET, POST or DELETE')
          return
        }

        case 'feedback': {
          if (req.method !== 'POST') {
            sendError(res, 405, 'method-not-allowed', 'use POST')
            return
          }
          if (config.gateway.sessionFeedbackRecord === undefined) {
            sendError(res, 501, 'not-supported', 'session feedback is not composed')
            return
          }
          sendJson(res, 200, await config.gateway.sessionFeedbackRecord(sessionId, asObject(await readJson(req))))
          return
        }

        case 'projections': {
          if (req.method !== 'GET') {
            sendError(res, 405, 'method-not-allowed', 'use GET')
            return
          }
          if (config.gateway.projections === undefined) {
            sendError(res, 501, 'not-supported', 'projections are not available on this deployment')
            return
          }
          sendJson(res, 200, { projections: await config.gateway.projections(sessionId) })
          return
        }

        case 'commands': {
          if (config.gateway.commands === undefined || config.gateway.executeCommand === undefined) {
            sendError(res, 501, 'not-supported', 'commands are not available on this deployment')
            return
          }
          if (req.method === 'GET') {
            sendJson(res, 200, { items: await config.gateway.commands(sessionId) })
            return
          }
          if (req.method !== 'POST') {
            sendError(res, 405, 'method-not-allowed', 'use GET or POST')
            return
          }
          const body = asObject(await readJson(req))
          const line = optionalString(body.line)
          if (line === undefined || line.trim() === '') {
            throw new HttpError(400, 'invalid-line', 'line is required')
          }
          const attachments = Array.isArray(body.attachments) ? body.attachments : undefined
          sendJson(res, 200, {
            result: await config.gateway.executeCommand(sessionId, line, attachments),
          })
          return
        }

        case 'goal': {
          if (subaction !== undefined) {
            if (req.method !== 'POST') {
              sendError(res, 405, 'method-not-allowed', 'use POST')
              return
            }
            if (config.gateway.goalAction === undefined) {
              sendError(res, 501, 'not-supported', 'goals are not available on this deployment')
              return
            }
            if (subaction !== 'pause' && subaction !== 'resume' && subaction !== 'complete' && subaction !== 'clear') {
              sendError(res, 404, 'not-found', 'unknown goal action')
              return
            }
            const body = asObject(await readJson(req))
            sendJson(res, 200, await config.gateway.goalAction(sessionId, subaction, body))
            return
          }
          if (config.gateway.goal === undefined || config.gateway.editGoal === undefined) {
            sendError(res, 501, 'not-supported', 'goals are not available on this deployment')
            return
          }
          if (req.method === 'GET') {
            sendJson(res, 200, { goal: await config.gateway.goal(sessionId) })
            return
          }
          if (req.method !== 'PUT') {
            sendError(res, 405, 'method-not-allowed', 'use GET or PUT')
            return
          }
          sendJson(res, 200, await config.gateway.editGoal(sessionId, asObject(await readJson(req))))
          return
        }

        case 'preset': {
          if (req.method !== 'POST') {
            sendError(res, 405, 'method-not-allowed', 'use POST')
            return
          }
          if (config.gateway.selectPreset === undefined) {
            sendError(res, 501, 'not-supported', 'agent presets are not available on this deployment')
            return
          }
          const body = asObject(await readJson(req))
          const agentPreset = optionalString(body.agentPreset)
          if (agentPreset === undefined) throw new HttpError(400, 'invalid-preset', 'agentPreset is required')
          sendJson(res, 200, { agentPreset: await config.gateway.selectPreset(sessionId, agentPreset) })
          return
        }

        case 'cancel': {
          if (req.method !== 'POST') {
            sendError(res, 405, 'method-not-allowed', 'use POST')
            return
          }
          ctx.logger?.info?.(`platform-api: cancel.requested for "${sessionId}"`)
          await config.gateway.cancel(sessionId)
          sendJson(res, 202, { cancelled: true, requestId: who.requestId })
          return
        }

        case 'force-cancel': {
          if (req.method !== 'POST') {
            sendError(res, 405, 'method-not-allowed', 'use POST')
            return
          }
          if (config.gateway.forceCancel === undefined) {
            sendError(res, 501, 'not-supported', 'force cancel is not composed')
            return
          }
          ctx.logger?.warn?.(`platform-api: cancel.force-close.begin for "${sessionId}"`)
          const closed = await config.gateway.forceCancel(sessionId)
          ctx.logger?.warn?.(
            `platform-api: cancel.force-close.end for "${sessionId}": ${closed.closed ? `${closed.events} event(s)` : 'nothing to close'}`,
          )
          sendJson(res, 202, { forceClosed: closed.closed, events: closed.events, requestId: who.requestId })
          return
        }

        case 'jobs': {
          // /sessions/{id}/jobs                     → roster stream
          // /sessions/{id}/jobs/{jobId}/output      → output stream
          // /sessions/{id}/jobs/{jobId}/kill        → kill
          if (subaction === undefined) {
            if (req.method !== 'GET') {
              sendError(res, 405, 'method-not-allowed', 'use GET')
              return
            }
            const listJobs = config.gateway.listJobs
            if (listJobs === undefined) {
              sendError(res, 501, 'not-supported', 'background jobs are not composed on this replica')
              return
            }
            await streamSse(req, res, signal => listJobs(sessionId, signal))
            return
          }
          if (verb === 'output') {
            if (req.method !== 'GET') {
              sendError(res, 405, 'method-not-allowed', 'use GET')
              return
            }
            const followJob = config.gateway.followJob
            if (followJob === undefined) {
              sendError(res, 501, 'not-supported', 'background jobs are not composed on this replica')
              return
            }
            const raw = query(req.url ?? '/', 'from')
            const from = raw === undefined ? undefined : Number(raw)
            if (from !== undefined && (!Number.isSafeInteger(from) || from < 0)) {
              throw new HttpError(400, 'invalid-from', 'from must be a non-negative integer byte offset')
            }
            await streamSse(req, res, signal => followJob(sessionId, subaction, from, signal))
            return
          }
          if (verb === 'kill') {
            if (req.method !== 'POST') {
              sendError(res, 405, 'method-not-allowed', 'use POST')
              return
            }
            if (config.gateway.killJob === undefined) {
              sendError(res, 501, 'not-supported', 'background jobs are not composed on this replica')
              return
            }
            sendJson(res, 200, await config.gateway.killJob(sessionId, subaction))
            return
          }
          sendError(res, 404, 'not-found', 'unknown job route')
          return
        }

        case 'events': {
          if (req.method !== 'GET') {
            sendError(res, 405, 'method-not-allowed', 'use GET')
            return
          }
          const after = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('after') ?? '-1')
          if (!Number.isSafeInteger(after) || after < -1) {
            throw new HttpError(400, 'invalid-after', 'after must be an integer sequence number or -1')
          }

          // Subscribe BEFORE replaying. Replay reads a snapshot; anything
          // committed during that read would otherwise fall between the two and
          // be lost. Buffering closes the gap without a second store read.
          //
          // The stream is not opened until `head` succeeds: writing the 200
          // headers first would turn an unknown session into an empty 200
          // instead of the documented 404.
          const buffered: StreamFrame[] = []
          let live = false
          let sse: SseWriter | undefined
          const unsubscribe = config.gateway.subscribe(sessionId, frame => {
            if (!live) {
              buffered.push(frame)
              return
            }
            dispatch(frame)
          })

          const dispatch = (frame: StreamFrame): void => {
            if (sse === undefined) return
            switch (frame.kind) {
              case 'event':
                sse.send('event', {
                  seq: frame.seq,
                  type: frame.type,
                  data: frame.data,
                  ...(frame.surfaceOp === undefined ? {} : { surfaceOp: frame.surfaceOp }),
                  ...(frame.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: frame.sourceEventSeqs }),
                  ...(frame.ignorable === true ? { ignorable: true } : {}),
                })
                return
              case 'assistant':
                sse.send('assistant', frame.frame)
                return
              case 'status':
                sse.send('status', { status: frame.status })
                return
              case 'inbox':
                sse.send('inbox', { phase: frame.phase })
                return
            }
          }

          // Resolve the live session before any response bytes are written.
          let head
          try {
            head = await config.gateway.head(sessionId)
          } catch (error) {
            unsubscribe()
            throw error
          }

          sse = new SseWriter(res)
          // Snapshot first: the client learns where history ends before frames
          // start arriving, exactly like the browser follower's opening frame.
          sse.send('snapshot', { cursor: head.cursor })

          let lastSent = after
          const backlog = await config.gateway.events(sessionId, after, pageSize)
          for (const event of backlog) {
            sse.send('event', event)
            lastSent = event.seq
          }
          sse.send('ready', { replayed: backlog.length, after: lastSent })

          live = true
          for (const frame of buffered) {
            // Committed events that the replay already covered must not repeat.
            if (frame.kind === 'event' && frame.seq <= lastSent) continue
            if (frame.kind === 'event') lastSent = frame.seq
            dispatch(frame)
          }
          buffered.length = 0

          const heartbeat = setInterval(() => sse?.comment('keepalive'), heartbeatMs)
          heartbeat.unref?.()

          const finish = (): void => {
            clearInterval(heartbeat)
            unsubscribe()
            sse?.close()
          }
          req.on('close', finish)
          res.on('close', finish)
          return
        }

        case 'stream': {
          if (req.method !== 'GET') {
            sendError(res, 405, 'method-not-allowed', 'use GET')
            return
          }
          if (config.sessionStream === undefined) {
            sendError(res, 501, 'not-supported', 'the session stream is not composed on this replica')
            return
          }
          // Resolve the durable offset before any response bytes exist: an
          // unknown session must stay the documented 404, not an empty 200.
          const head = await config.gateway.head(sessionId)
          config.sessionStream.attach(sessionId, req, res, head.cursor, head.running)
          return
        }

        case 'answers': {
          if (req.method !== 'POST') {
            sendError(res, 405, 'method-not-allowed', 'use POST')
            return
          }
          if (config.sessionStream === undefined) {
            sendError(res, 501, 'not-supported', 'the session stream is not composed on this replica')
            return
          }
          const body = asObject(await readJson(req))
          const requestId = optionalString(body.requestId)
          const outcome = normalizeOutcome(body.outcome)
          if (requestId === undefined) {
            throw new HttpError(400, 'invalid-answer', 'requestId is required')
          }
          if (outcome === undefined) {
            throw new HttpError(400, 'invalid-answer', 'outcome must be {"kind":"result"|"rejected"}')
          }
          if (!config.sessionStream.answer(sessionId, requestId, outcome)) {
            // 已答复、已撤销或不属于本会话：不暴露是哪种。
            throw new HttpError(409, 'session/mismatch', 'no pending request with this id on this session')
          }
          sendJson(res, 200, { accepted: true })
          return
        }

        case 'workspace-files':
          await handleWorkspaceFiles(ctx, req, res, sessionId, subaction, verb)
          return

        default:
          sendError(res, 404, 'not-found', 'unknown route')
      }
    }, diagnose),
  })
}

/** Narrow a parsed body to an object. */
function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'invalid-body', 'request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

/** Read an optional non-empty string field. */
function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  const trimmed = raw?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
