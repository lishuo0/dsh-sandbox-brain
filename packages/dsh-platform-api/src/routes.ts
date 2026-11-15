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

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { AuthError, authenticate, type AppCredential, type AuthHeaders, type AuthenticatedCaller } from './auth.ts'
import { HttpError, SseWriter, handle, query, readJson, segmentsAfter, sendError, sendJson } from './http.ts'
import type { SessionModelKeys } from '@brain/dsh-credentials-session'
import { handleWorkspaceFiles } from './workspace-files.ts'

/** Prefix every route lives under. */
export const PREFIX = '/brain/v1/sessions'

/** One frame on the live stream. */
export type StreamFrame =
  /** A committed event: durable, replayable, identical to what the log holds. */
  | { readonly kind: 'event'; readonly seq: number; readonly type: string; readonly data: unknown }
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
  /** Submit one user message. */
  prompt(sessionId: string, text: string, requestId: string): Promise<void>
  /** Interrupt the active turn. */
  cancel(sessionId: string): Promise<void>
  /** Last committed seq for one session; -1 when the log is empty. */
  head(sessionId: string): Promise<{ cursor: number }>
  /** Read committed events with `seq` greater than `after`. */
  events(sessionId: string, after: number, limit: number): Promise<Array<{ seq: number; type: string; data: unknown }>>
  /**
   * Subscribe to everything a renderer needs: committed events, live assistant
   * chunks, driver status and inbox transitions.
   */
  subscribe(sessionId: string, listener: (frame: StreamFrame) => void): () => void
  /** Provider-grouped catalog plus the deployment default model. */
  models?(): Promise<unknown>
  /** Install one Session-local model selection and return the normalized value. */
  selectModel?(sessionId: string, selection: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<unknown>
  /** Effective slash-command descriptors for one live Session. */
  commands?(sessionId: string): Promise<unknown>
  /** Execute one slash-command line without sending it to the model. */
  executeCommand?(sessionId: string, line: string): Promise<unknown>
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

/** E2B runtime configuration supplied by the platform. */
export interface SandboxConfig {
  readonly apiKey: string
  readonly apiUrl: string
  readonly domain: string
  readonly template: string
  readonly roleArn: string
  readonly ossBucket: string
  readonly ossEndpoint: string
  readonly ossRegion: string
  readonly ossAccessKeyId: string
  readonly ossAccessKeySecret: string
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

/** Read the complete E2B runtime configuration from one create request. */
function sandboxConfigOf(
  headers: Record<string, string | string[] | undefined>,
): SandboxConfig | undefined {
  const value = (name: string): string => {
    const raw = headers[name]
    return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? ''
  }
  const config = {
    apiKey: value('x-dsh-e2b-api-key'),
    apiUrl: value('x-dsh-e2b-api-url'),
    domain: value('x-dsh-e2b-domain'),
    template: value('x-dsh-e2b-template'),
    roleArn: value('x-dsh-e2b-role-arn'),
    ossBucket: value('x-dsh-oss-bucket'),
    ossEndpoint: value('x-dsh-oss-endpoint'),
    ossRegion: value('x-dsh-oss-region'),
    ossAccessKeyId: value('x-dsh-oss-access-key-id'),
    ossAccessKeySecret: value('x-dsh-oss-access-key-secret'),
  }
  return config.apiKey === '' || config.apiUrl === '' || config.template === ''
    ? undefined
    : config
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
  /** Sandbox runtime configuration store; absent when the platform does not manage E2B. */
  readonly sandboxConfig?: SandboxConfigStore
  /** Image generation configuration store; absent when image generation is not enabled. */
  readonly imageConfig?: ImageConfigStore
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

  // 平台在登录后把这个启动令牌交给浏览器，用来换客户端的会话 cookie。
  ctx.webServer.register({
    kind: 'exact',
    path: '/brain/v1/client-token',
    handler: (req, res) => void handle(req, res, async () => {
      if (req.method !== 'GET') {
        sendError(res, 405, 'method-not-allowed', 'use GET')
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
      let connection: { browserAuth?: { launchToken?: string } } | undefined
      try {
        connection = ctx.get('connection') as { browserAuth?: { launchToken?: string } } | undefined
      } catch {
        connection = undefined
      }
      const token = connection?.browserAuth?.launchToken
      if (!token) {
        sendError(res, 404, 'client-token-unavailable', 'connection is not mounted')
        return
      }
      sendJson(res, 200, { token })
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
      const created = await config.gateway.create({
        cwd,
        ...(optionalString(input.preset) === undefined ? {} : { preset: optionalString(input.preset) as string }),
        ...(optionalString(input.sessionId) === undefined ? {} : { sessionId: optionalString(input.sessionId) as string }),
      })
      if (modelKey !== undefined) config.modelKeys?.set(created.sessionId, modelKey)
      if (modelBaseUrl !== undefined) config.modelBaseUrls?.set(created.sessionId, modelBaseUrl)
      if (sandbox !== undefined) config.sandboxConfig?.set(sandbox)
      if (image !== undefined) config.imageConfig?.set(image)
      const modelId = headerValue(req.headers['x-dsh-model-id'])
      if (modelId !== undefined && config.gateway.selectModel !== undefined) {
        await config.gateway.selectModel(created.sessionId, { provider: 'user', model: modelId })
      }
      sendJson(res, 201, { sessionId: created.sessionId, requestId: who.requestId })
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
          await config.gateway.prompt(sessionId, text, who.requestId)
          sendJson(res, 202, { accepted: true, requestId: who.requestId })
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
          const provider = optionalString(body.provider) ?? (model === undefined ? undefined : 'user')
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
          sendJson(res, 200, { result: await config.gateway.executeCommand(sessionId, line) })
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
                sse.send('event', { seq: frame.seq, type: frame.type, data: frame.data })
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
