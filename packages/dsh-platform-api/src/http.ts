/**
 * Minimal HTTP helpers over the raw node request/response pair the webserver
 * hands to a route.
 *
 * Deliberately dependency-free: no framework, no body parser, no router library.
 * The surface is four endpoints, so the helpers are the whole of it.
 *
 * @module @brain/dsh-platform-api/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Largest request body accepted, in bytes. */
export const MAX_BODY_BYTES = 1_048_576

/** Structured failure with an HTTP status and a stable error code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/**
 * Read and parse a JSON body.
 * @param req - the incoming request.
 * @returns the parsed value.
 * @throws {HttpError} 413 when too large, 400 when malformed.
 */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, 'body-too-large', `request body exceeds ${MAX_BODY_BYTES} bytes`)
    }
    chunks.push(buffer)
  }
  if (total === 0) throw new HttpError(400, 'body-required', 'request body is required')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid-json', 'request body is not valid JSON')
  }
}

/**
 * Send a JSON response.
 * @param res - the response to own.
 * @param status - HTTP status.
 * @param body - JSON-serializable payload.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Send a structured error.
 * @param res - the response to own.
 * @param status - HTTP status.
 * @param code - stable machine-readable code.
 * @param message - human-readable detail.
 */
export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } })
}

/**
 * Handle one request, mapping thrown errors onto responses.
 * @param req - incoming request.
 * @param res - response owned until the handler settles.
 * @param run - request body; throwing maps onto the error response.
 * @param diagnose - receives unexpected errors for server-side logging. The
 *   client only ever sees a fixed `internal` message, because raw errors can
 *   carry SQL, paths, or upstream details.
 */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  run: () => Promise<void>,
  diagnose?: (error: unknown) => void,
): Promise<void> {
  try {
    await run()
  } catch (error) {
    if (res.headersSent) {
      // The response is already streaming; the only honest move is to end it.
      res.end()
      return
    }
    if (error instanceof HttpError) {
      sendError(res, error.status, error.code, error.message)
      return
    }
    try {
      diagnose?.(error)
    } catch { /* diagnostics must not replace the response */ }
    sendError(res, 500, 'internal', 'internal error')
  }
}

/** A server-sent-events writer with framing and liveness handled. */
export class SseWriter {
  private closed = false

  constructor(private readonly res: ServerResponse) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Disable proxy buffering: without this an ingress may hold every frame
      // until the response ends, which defeats the point of streaming.
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
  }

  /**
   * Write one event.
   * @param event - event name.
   * @param data - JSON-serializable payload.
   */
  send(event: string, data: unknown): void {
    if (this.closed) return
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  /** Write a comment line; proxies treat it as traffic without dispatching an event. */
  comment(text: string): void {
    if (this.closed) return
    this.res.write(`: ${text}\n\n`)
  }

  /** Finish the stream. Safe to call twice. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.res.end()
  }

  get isClosed(): boolean {
    return this.closed
  }
}

/**
 * Split a path prefix registration into its trailing segments.
 * @param rawUrl - the request URL.
 * @param prefix - the registered prefix, e.g. `/brain/v1/sessions`.
 * @returns the decoded segments after the prefix.
 */
export function segmentsAfter(rawUrl: string, prefix: string): string[] {
  const pathname = new URL(rawUrl, 'http://localhost').pathname
  const rest = pathname.slice(prefix.length).replace(/^\/+|\/+$/g, '')
  return rest === '' ? [] : rest.split('/').map(decodeURIComponent)
}

/**
 * Read one query parameter.
 * @param rawUrl - the request URL.
 * @param name - parameter name.
 * @returns the value, or undefined.
 */
export function query(rawUrl: string, name: string): string | undefined {
  const value = new URL(rawUrl, 'http://localhost').searchParams.get(name)
  return value ?? undefined
}
