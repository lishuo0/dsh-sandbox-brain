/**
 * 会话级 WebSocket：一条连接对一个会话，答复在带内上行。
 *
 * 路径固定为 `/brain/v1/session/socket`，会话由 `sessionid` 头指定——宿主
 * webserver 的 Upgrade 路由按**精确路径**匹配，不能把会话 id 放进路径。这条
 * 限制反而让路由层简单：同一工作区的 socket 和 REST 请求带同一组头，按
 * `x-dsh-workspace-id` 做的一致性哈希会把它们送到同一台脑。
 *
 * 线格式（每条消息一个 JSON）：
 *
 * - 下行与 SSE 的 `data:` 帧完全一致：`ready` / `event` / `status` / `stream` /
 *   `waterfall` / `cancel`。
 * - 上行：`{type:'answer', requestId, outcome}`；结算成功回 `{type:'ack',
 *   requestId}`，请求已撤销或不属于本会话回 `{type:'answer-error', requestId,
 *   code:'session/mismatch'}`。
 *
 * 这条连接是「答复一定到达同一条会话的脑进程」的保证：答复不走第二条请求，
 * 也就没有第二处路由判定。
 *
 * @module @brain/dsh-platform-api/session-socket
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { AuthError, authenticate, type AppCredential, type AuthHeaders } from './auth.ts'
import { normalizeOutcome, type SessionDownFrame, type SessionStream } from './session-stream.ts'
import type { BrainGateway } from './routes.ts'

/** The one Upgrade path the brain documents. */
export const SESSION_SOCKET_PATH = '/brain/v1/session/socket'

/** Header naming the session on an Upgrade request; the platform sets it on every call. */
export const SESSION_HEADER = 'sessionid'

/** Largest accepted uplink message. Answers are small JSON objects. */
const MAX_PAYLOAD = 256 * 1024

/** One frame the socket may receive; anything else is ignored. */
interface AnswerMessage {
  readonly type: 'answer'
  readonly requestId: string
  readonly outcome: unknown
}

/** Runtime inputs, shared with the route table. */
export interface SessionSocketOptions {
  readonly gateway: BrainGateway
  readonly sessionStream: SessionStream
  readonly ownership?: { assert(sessionId: string, userId: string): Promise<void> }
  readonly credentials: readonly AppCredential[]
  readonly headers: AuthHeaders
  readonly requireUser?: boolean
  /** Ping interval; the socket answers with a pong. Default 15000 ms. */
  readonly heartbeatMs?: number
}

/**
 * Register the session socket on the host webserver.
 *
 * @param ctx - plugin context; the registration is effect-scoped.
 * @param options - gateway, session stream, credentials and liveness.
 * @returns nothing; disposal happens with the plugin effect.
 */
export function createSessionSocket(ctx: Context, options: SessionSocketOptions): void {
  const heartbeatMs = options.heartbeatMs ?? 15_000
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD })
  const sockets = new Set<WebSocket>()

  const accept = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const caller = (() => {
      try {
        return authenticate(name => header(req, name), options.credentials, options.headers)
      } catch (error) {
        if (error instanceof AuthError) {
          reject(socket, 401, 'unauthorized')
          return undefined
        }
        throw error
      }
    })()
    if (caller === undefined) return
    if (options.requireUser === true && caller.userId === undefined) {
      reject(socket, 401, 'user-required')
      return
    }
    const sessionId = text(header(req, SESSION_HEADER))
    if (sessionId === undefined) {
      reject(socket, 400, 'session/id-invalid')
      return
    }
    // Ownership before the socket exists: an unknown session and another
    // member's session answer the same 404.
    if (options.ownership !== undefined && caller.userId !== undefined) {
      try {
        await options.ownership.assert(sessionId, caller.userId)
      } catch {
        reject(socket, 404, 'session-not-found')
        return
      }
    }
    let state: { cursor: number; running: boolean }
    try {
      state = await options.gateway.head(sessionId)
    } catch {
      reject(socket, 404, 'session-not-found')
      return
    }
    wss.handleUpgrade(req, socket, head, ws => onOpen(ws, sessionId, state.cursor, state.running))
  }

  const onOpen = (ws: WebSocket, sessionId: string, cursor: number, running: boolean): void => {
    sockets.add(ws)

    // Missed pongs mean the peer is gone even if the TCP connection looks
    // alive; terminate so the subscription is released.
    let alive = true
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate()
        return
      }
      alive = false
      try {
        ws.ping()
      } catch {
        /* closing */
      }
    }, heartbeatMs)
    heartbeat.unref?.()
    ws.on('pong', () => {
      alive = true
    })

    const detach = options.sessionStream.attachSocket(
      sessionId,
      {
        send: (frame: SessionDownFrame) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
        },
        close: () => {
          try {
            ws.close(1000)
          } catch {
            /* already closing */
          }
        },
      },
      cursor,
      running,
    )

    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      clearInterval(heartbeat)
      sockets.delete(ws)
      detach()
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      const message = parseAnswer(data)
      if (message === undefined) return
      const outcome = normalizeOutcome(message.outcome)
      if (outcome === undefined) {
        ws.send(JSON.stringify({ type: 'answer-error', requestId: message.requestId, code: 'invalid-answer' }))
        return
      }
      const settled = options.sessionStream.answer(sessionId, message.requestId, outcome)
      ws.send(JSON.stringify(settled
        ? { type: 'ack', requestId: message.requestId }
        : { type: 'answer-error', requestId: message.requestId, code: 'session/mismatch' }))
    })
    ws.on('close', finish)
    ws.on('error', finish)
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.registerUpgrade({
      path: SESSION_SOCKET_PATH,
      handler: (req, socket, head) => {
        void accept(req, socket, head).catch(() => {
          if (!socket.destroyed) socket.destroy()
        })
      },
    })
    return () => {
      dispose()
      for (const ws of sockets) ws.terminate()
      sockets.clear()
      wss.close()
    }
  }, 'platform-api: session socket')
}

/** Read one header; node lowercases names and may hand back an array. */
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** Narrow one uplink message onto an answer; other shapes are ignored. */
function parseAnswer(data: unknown): AnswerMessage | undefined {
  const text = typeof data === 'string'
    ? data
    : Buffer.isBuffer(data)
      ? data.toString('utf8')
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
        : undefined
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const message = parsed as { type?: unknown; requestId?: unknown; outcome?: unknown }
  if (message.type !== 'answer') return undefined
  if (typeof message.requestId !== 'string' || message.requestId === '') return undefined
  return { type: 'answer', requestId: message.requestId, outcome: message.outcome }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Answer an Upgrade request that must not become a socket. */
function reject(socket: Duplex, status: number, code: string): void {
  if (socket.destroyed) return
  const body = JSON.stringify({ error: { code, message: code } })
  socket.write(
    `HTTP/1.1 ${status} ${statusText(status)}\r\n`
    + 'content-type: application/json; charset=utf-8\r\n'
    + `content-length: ${Buffer.byteLength(body)}\r\n`
    + 'connection: close\r\n'
    + '\r\n'
    + body,
  )
  socket.destroy()
}

function statusText(status: number): string {
  if (status === 400) return 'Bad Request'
  if (status === 401) return 'Unauthorized'
  if (status === 404) return 'Not Found'
  return 'Error'
}