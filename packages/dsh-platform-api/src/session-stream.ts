/**
 * 会话级实时面：一条下行 + 一个上行。
 *
 * 下行有两种等价载体，帧集完全相同：
 *
 * - `GET /brain/v1/sessions/{id}/stream`：SSE，保留为回退。
 * - `GET /brain/v1/session/socket`（Upgrade）：会话级 WebSocket，会话由
 *   `sessionid` 头指定。上行的答复直接走这条连接（`{type:'answer'}`），
 *   因此答复和下行落在同一个脑进程上，不需要跨副本路由。
 *
 * 上行 `POST /brain/v1/sessions/{id}/answers` 同样保留：没有 socket 的调用方
 * 仍可单独提交答复。三条路径共用同一个待答表，答复只结算一次。
 *
 * 每条 SSE 帧的事件名固定为 `frame`，`data` 就是帧 JSON；socket 每条消息就是
 * 一个帧 JSON，帧集与 `docs/脑接口边界改造.md` §3.2.1 一致。会话由路径或
 * `sessionid` 头指定，不做 query 复写。
 *
 * @module @brain/dsh-platform-api/session-stream
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import { SseWriter } from './http.ts'
import type { BrainGateway, StreamFrame } from './routes.ts'

/**
 * 会话路由的前缀。
 *
 * `routes.ts` 里有一份同样的字面量；这里不能反向导入（`routes` 会导入本模块
 * 的类型，值导入会形成循环），所以用测试断言两边一致。
 */
export const SESSION_PREFIX = '/brain/v1/sessions'

/** 下行 SSE 路径：`{prefix}/{id}/stream`。 */
export function sessionStreamPath(sessionId: string): string {
  return `${SESSION_PREFIX}/${encodeURIComponent(sessionId)}/stream`
}

/** 上行答复路径：`{prefix}/{id}/answers`。 */
export function sessionAnswersPath(sessionId: string): string {
  return `${SESSION_PREFIX}/${encodeURIComponent(sessionId)}/answers`
}

/** Which interactive request a waterfall frame carries. */
export type WaterfallKind = 'approval' | 'questions' | 'plan'

/** One downlink frame; the SSE `data` field is exactly this JSON. */
export type SessionDownFrame =
  /** First frame: the session and the current durable log offset. */
  | { readonly type: 'ready'; readonly sessionId: string; readonly seq: number }
  /**
   * One committed session-log event. `surfaceOp`/`sourceEventSeqs` are part of
   * the durable record and must survive the hop: the browser rejects a
   * surface-eligible event that arrives without them.
   */
  | {
      readonly type: 'event'
      readonly seq: number
      readonly event: {
        readonly type: string
        readonly data: unknown
        readonly surfaceOp?: unknown
        readonly sourceEventSeqs?: unknown
        readonly ignorable?: boolean
      }
    }
  /** Driver status for this session. */
  | { readonly type: 'status'; readonly running: boolean }
  /** One assistant streaming chunk. */
  | { readonly type: 'stream'; readonly frame: unknown }
  /** A pending interactive request that needs an answer. */
  | { readonly type: 'waterfall'; readonly requestId: string; readonly kind: WaterfallKind; readonly request: unknown }
  /** A pending request was settled or withdrawn; stop showing it. */
  | { readonly type: 'cancel'; readonly requestId: string }

/** One answer travelling up over REST. */
export type AnswerOutcome =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'rejected'; readonly error?: string }

/** Runtime knobs. */
export interface SessionStreamOptions {
  readonly gateway: BrainGateway
  /** SSE keepalive comment interval. Default 15000 ms. */
  readonly heartbeatMs?: number
}

/**
 * One live downlink pinned to one session.
 *
 * `send` writes one frame; `detach` releases the subscription and the carrier.
 * The SSE path and the WebSocket path only differ in the carrier, so the
 * buffering / replay / settle logic below is shared.
 */
interface Connection {
  readonly sessionId: string
  send(frame: SessionDownFrame): void
  detach(): void
}

/** A transport that carries session frames for one connection. */
export interface SocketSink {
  /** Write one frame to the client. */
  send(frame: SessionDownFrame): void
  /** Drop the connection; safe to call twice. */
  close(): void
}

/** One unanswered interactive request, kept in memory only. */
interface PendingRequest {
  readonly requestId: string
  readonly sessionId: string
  readonly kind: WaterfallKind
  readonly request: unknown
  readonly complete: (outcome: AnswerOutcome) => void
  readonly abort: () => void
  readonly signal: AbortSignal | undefined
  /** Detached once settled; the record must not settle twice. */
  settled: boolean
}

/** What the session stream exposes to the route table and to tests. */
export interface SessionStream {
  /**
   * Open the SSE response for one session.
   * @param sessionId - already authorized and ownership-checked by the caller.
   * @param req - the GET request; its close event ends the stream.
   * @param res - response owned until the client goes away.
   * @param cursor - durable log offset announced in the `ready` frame.
   * @param running - current driver state; announced as the first `status`.
   */
  attach(sessionId: string, req: IncomingMessage, res: ServerResponse, cursor: number, running?: boolean): void
  /**
   * Open one WebSocket downlink for a session.
   *
   * The socket is the same wire format as the SSE `data:` frames, one JSON
   * object per message. Answers travel back on the same socket (see
   * `session-socket.ts`), so the uplink cannot land on another replica.
   * @param sessionId - already authorized and ownership-checked by the caller.
   * @param sink - the socket carrier.
   * @param cursor - durable log offset announced in the `ready` frame.
   * @param running - current driver state; announced as the first `status`.
   * @returns the detach function; calling it releases the subscription.
   */
  attachSocket(sessionId: string, sink: SocketSink, cursor: number, running?: boolean): () => void
  /**
   * Settle one pending interactive request.
   * @returns false when the request is unknown (already answered, cancelled,
   *   or belonging to another session) — the route turns that into a 409.
   */
  answer(sessionId: string, requestId: string, outcome: AnswerOutcome): boolean
  /** Number of live streams, by session. */
  connectionCount(sessionId: string): number
  /** Number of unanswered interactive requests, by session. */
  pendingCount(sessionId: string): number
  /** Stop every live stream and drop every pending request. */
  close(): void
}

/**
 * Install the session stream on the plugin context.
 * @param ctx - plugin context carrying the event bus.
 * @param options - gateway and liveness knobs.
 * @returns the runtime the route table dispatches into.
 */
export function createSessionStream(ctx: Context, options: SessionStreamOptions): SessionStream {
  const heartbeatMs = options.heartbeatMs ?? 15_000
  const connections = new Map<string, Set<Connection>>()
  const pending = new Map<string, Map<string, PendingRequest>>()

  /** Send one frame to every live stream of a session. */
  const broadcast = (sessionId: string, frame: SessionDownFrame): void => {
    for (const connection of connections.get(sessionId) ?? []) connection.send(frame)
  }

  const addConnection = (connection: Connection): void => {
    let set = connections.get(connection.sessionId)
    if (set === undefined) {
      set = new Set()
      connections.set(connection.sessionId, set)
    }
    set.add(connection)
  }

  const removeConnection = (connection: Connection): void => {
    const set = connections.get(connection.sessionId)
    if (set === undefined) return
    set.delete(connection)
    if (set.size === 0) connections.delete(connection.sessionId)
  }

  const pendingFor = (sessionId: string): Map<string, PendingRequest> => {
    let table = pending.get(sessionId)
    if (table === undefined) {
      table = new Map()
      pending.set(sessionId, table)
    }
    return table
  }

  const forgetPending = (entry: PendingRequest): void => {
    const table = pending.get(entry.sessionId)
    table?.delete(entry.requestId)
    if (table?.size === 0) pending.delete(entry.sessionId)
    entry.signal?.removeEventListener('abort', entry.abort)
  }

  /**
   * Settle one request exactly once: drop it, tell every stream to hide it,
   * then hand the answer back to the Agent.
   */
  const settle = (entry: PendingRequest, outcome: AnswerOutcome): void => {
    if (entry.settled) return
    entry.settled = true
    forgetPending(entry)
    broadcast(entry.sessionId, { type: 'cancel', requestId: entry.requestId })
    entry.complete(outcome)
  }

  /** Register one interactive request; the caller has already seen a live stream. */
  const offer = (
    sessionId: string,
    kind: WaterfallKind,
    request: unknown,
    signal: AbortSignal | undefined,
    run: (outcome: AnswerOutcome) => void,
  ): void => {
    const requestId = randomUUID()
    const entry: PendingRequest = {
      requestId,
      sessionId,
      kind,
      request,
      signal,
      settled: false,
      complete: run,
      abort: () => settle(entry, { kind: 'result', value: 'cancelled' }),
    }
    pendingFor(sessionId).set(requestId, entry)
    if (signal !== undefined) {
      if (signal.aborted) {
        entry.abort()
        return
      }
      signal.addEventListener('abort', entry.abort, { once: true })
    }
    broadcast(sessionId, { type: 'waterfall', requestId, kind, request })
  }

  /** Normalize the wire's approval vocabulary onto the answerer's closed set. */
  const approvalOutcome = (outcome: AnswerOutcome): ApprovalOutcome => {
    if (outcome.kind === 'rejected') return 'rejected'
    const value = outcome.value
    if (value === 'approved') return 'allowed-once'
    if (value === 'denied') return 'rejected'
    if (value === 'allowed-once' || value === 'rejected' || value === 'cancelled') return value
    // An unknown value must not turn into a grant.
    return 'rejected'
  }

  // Interactive requests are waterfalls. This listener is prepended so the
  // session stream claims them before any legacy browser-mux forwarding; with
  // no live stream for the session it delegates (`next()`), which keeps the
  // fail-closed chain intact.
  ctx.effect(() => {
    const disposeApproval = ctx.on('approval/request', (request, next) => {
      const sessionId = sessionIdOf(request.agent)
      if (sessionId === undefined) return next()
      const targets = connections.get(sessionId)
      if (targets === undefined || targets.size === 0) return next()
      return new Promise<ApprovalOutcome>(resolve => {
        offer(sessionId, 'approval', projectApproval(request), request.signal, outcome => {
          resolve(approvalOutcome(outcome))
        })
      })
    }, { prepend: true })

    const disposeQuestions = ctx.on('user-questions/request', (request, next) => {
      const sessionId = sessionIdOf(request.agent)
      if (sessionId === undefined) return next()
      const targets = connections.get(sessionId)
      if (targets === undefined || targets.size === 0) return next()
      const kind: WaterfallKind = isPlanReview(request) ? 'plan' : 'questions'
      return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
        offer(sessionId, kind, projectQuestions(request), request.signal, outcome => {
          if (outcome.kind === 'result') {
            resolve(outcome.value as AskUserQuestionAnswer)
            return
          }
          reject(new Error(outcome.error ?? 'the client rejected the question'))
        })
      })
    }, { prepend: true })

    return () => {
      disposeApproval()
      disposeQuestions()
    }
  }, 'platform-api: session stream answerers')

  /** Map gateway frames onto the stream's frame set. */
  const dispatch = (connection: Connection, frame: StreamFrame): void => {
    switch (frame.kind) {
      case 'event':
        connection.send({
          type: 'event',
          seq: frame.seq,
          event: {
            type: frame.type,
            data: frame.data,
            ...(frame.surfaceOp === undefined ? {} : { surfaceOp: frame.surfaceOp }),
            ...(frame.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: frame.sourceEventSeqs }),
            ...(frame.ignorable === true ? { ignorable: true } : {}),
          },
        })
        return
      case 'assistant':
        connection.send({ type: 'stream', frame: frame.frame })
        return
      case 'status':
        connection.send({ type: 'status', running: frame.status === 'running' })
        return
      case 'inbox':
        // The platform is the only queuer; the brain inbox stays empty.
        return
    }
  }

  /**
   * Open one downlink over any carrier.
   *
   * Subscribe before announcing readiness; anything that lands in between is
   * buffered, not lost. Durable history is backfilled by the client from
   * `seq` over REST.
   */
  const openConnection = (
    sessionId: string,
    sink: SocketSink,
    cursor: number,
    running: boolean | undefined,
  ): Connection => {
    let finished = false
    let unsubscribe: () => void = () => undefined
    function finish(): void {
      if (finished) return
      finished = true
      unsubscribe()
      removeConnection(connection)
      sink.close()
    }
    const connection: Connection = { sessionId, send: sink.send, detach: finish }

    let live = false
    const buffered: StreamFrame[] = []
    unsubscribe = options.gateway.subscribe(sessionId, frame => {
      if (!live) {
        buffered.push(frame)
        return
      }
      dispatch(connection, frame)
    })
    addConnection(connection)

    connection.send({ type: 'ready', sessionId, seq: cursor })
    // Announce the initial driver state so a client (and the platform queue
    // pump) knows whether a turn is already live instead of waiting for the
    // next transition. `status` frames after this one only carry changes.
    if (running !== undefined) connection.send({ type: 'status', running })
    // Reconnect semantics: every unanswered interactive request is replayed
    // after `ready`. The Agent's answerer is still waiting, so a client that
    // missed the request must see it again.
    for (const entry of pending.get(sessionId)?.values() ?? []) {
      connection.send({
        type: 'waterfall',
        requestId: entry.requestId,
        kind: entry.kind,
        request: entry.request,
      })
    }
    live = true
    for (const frame of buffered) dispatch(connection, frame)
    buffered.length = 0
    return connection
  }

  /**
   * SSE downlink. Retained as the documented fallback: a deployment whose
   * ingress cannot carry Upgrade (or a platform build that has not switched to
   * the socket) still gets the exact same frame set here.
   */
  const attach = (sessionId: string, req: IncomingMessage, res: ServerResponse, cursor: number, running?: boolean): void => {
    const sse = new SseWriter(res)
    const connection = openConnection(
      sessionId,
      { send: frame => sse.send('frame', frame), close: () => sse.close() },
      cursor,
      running,
    )
    const heartbeat = setInterval(() => sse.comment('keepalive'), heartbeatMs)
    heartbeat.unref?.()
    const stop = (): void => {
      clearInterval(heartbeat)
      connection.detach()
    }
    req.on('close', stop)
    res.on('close', stop)
  }

  /** WebSocket downlink; the carrier owns ping/pong, this owns the subscription. */
  const attachSocket = (sessionId: string, sink: SocketSink, cursor: number, running?: boolean): (() => void) => {
    return openConnection(sessionId, sink, cursor, running).detach
  }

  const answer = (sessionId: string, requestId: string, outcome: AnswerOutcome): boolean => {
    const entry = pending.get(sessionId)?.get(requestId)
    if (entry === undefined) return false
    settle(entry, outcome)
    return true
  }

  return {
    attach,
    attachSocket,
    answer,
    connectionCount: sessionId => connections.get(sessionId)?.size ?? 0,
    pendingCount: sessionId => pending.get(sessionId)?.size ?? 0,
    close() {
      for (const set of connections.values()) {
        for (const connection of set) connection.detach()
      }
      connections.clear()
      pending.clear()
    },
  }
}

/**
 * Narrow an untrusted REST body onto an AnswerOutcome.
 * @param value - `outcome` field of the answer request.
 * @returns the normalized outcome, or undefined when the shape is wrong.
 */
export function normalizeOutcome(value: unknown): AnswerOutcome | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const outcome = value as { kind?: unknown; value?: unknown; error?: unknown }
  if (outcome.kind === 'result') return { kind: 'result', value: outcome.value }
  if (outcome.kind === 'rejected') {
    return { kind: 'rejected', ...(typeof outcome.error === 'string' ? { error: outcome.error } : {}) }
  }
  return undefined
}

/**
 * Assert the deployment exposes only the documented Upgrade routes.
 *
 * 实时面收敛为「会话级 SSE + 会话级 socket」之后，脑上只允许一条 WebSocket：
 * `session-socket.ts` 注册的会话 socket。其它任何 Upgrade 路由都是绕过文档的
 * 隐式接口，这条规则由启动/测试时的机器检查兜底。
 * @param webServer - the host webserver.
 * @param allowed - Upgrade paths this deployment documents.
 * @returns the registered Upgrade paths.
 * @throws when a path outside `allowed` is registered.
 */
export function auditUpgradeRoutes(webServer: unknown, allowed: readonly string[] = []): readonly string[] {
  const table = (webServer as { upgrades?: Map<string, { path?: string }> } | undefined)?.upgrades
  const paths = table === undefined ? [] : [...table.values()].map(route => route.path ?? '')
  const unexpected = paths.filter(path => !allowed.includes(path))
  if (unexpected.length > 0) {
    throw new Error(
      'platform-api: undocumented Upgrade routes are not allowed; found '
      + unexpected.map(path => `"${path}"`).join(', '),
    )
  }
  return paths
}

/** The session an Agent belongs to. */
function sessionIdOf(agent: { session?: { id?: unknown } } | undefined): string | undefined {
  const id = agent?.session?.id
  if (id === undefined || id === null) return undefined
  const text = String(id)
  return text === '' ? undefined : text
}

/** Approval payload without the Agent or the live signal. */
function projectApproval(request: ApprovalRequestEvent): unknown {
  return {
    toolName: request.toolName,
    ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(request.displayReason === undefined ? {} : { displayReason: request.displayReason }),
  }
}

/** Question payload without the Agent or the live signal. */
function projectQuestions(request: AskUserQuestionRequestEvent): unknown {
  return {
    questions: request.questions,
    ...(request.wait === undefined
      ? {}
      : { wait: { callId: String(request.wait.callId), ...(request.wait.timed === undefined ? {} : { timed: request.wait.timed }) } }),
  }
}

/** Plan review is a user-question with the plan-review intent. */
function isPlanReview(request: AskUserQuestionRequestEvent): boolean {
  return request.questions.some(question => question.intent?.kind === 'plan-review')
}
