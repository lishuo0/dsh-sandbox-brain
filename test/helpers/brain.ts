import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { BrainGateway, StreamFrame } from '../../packages/dsh-platform-api/src/routes.ts'

/** 路由注册，形状与 @deepseek-ai/dsh-host-webserver 一致。 */
export interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** Upgrade 路由注册，形状与 @deepseek-ai/dsh-host-webserver 一致。 */
export interface WebUpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

/** 假的 webServer：只记录注册，由测试自己起真实 HTTP 去分发。 */
export class FakeWebServer {
  readonly exact = new Map<string, WebRoute>()
  readonly prefixes = new Map<string, WebRoute>()
  readonly upgrades = new Map<string, WebUpgradeRoute>()

  register(route: WebRoute): () => void {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    table.set(route.path, route)
    return () => table.delete(route.path)
  }

  registerUpgrade(route: WebUpgradeRoute): () => void {
    if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }

  /** exact 优先，然后最长前缀，和真实宿主一致。 */
  match(pathname: string): WebRoute | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best: WebRoute | undefined
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }
}

export interface BrainServer {
  baseUrl: string
  web: FakeWebServer
  ctx: Context
  server: Server
  close(): Promise<void>
}

/** 用真实 Cordis Context；服务值由调用方给。 */
export function testContext(services: Record<string, unknown> = {}): Context {
  const ctx = new Context()
  for (const [name, value] of Object.entries(services)) ctx.provide(name, value)
  return ctx
}

/**
 * 在给定 Context 上注册插件，并把 webServer 的注册铺成真实 HTTP。
 * @param port - 监听端口；联合测试先分配端口再启动平台，所以可以指定。
 */
export async function startBrainServer(ctx: Context, port = 0): Promise<BrainServer> {
  const web = ctx.get('webServer') as FakeWebServer | undefined
  if (web === undefined) throw new Error('context 缺少 webServer')
  const server = createServer((req, res) => void dispatch(web, req, res))
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = web.upgrades.get(pathname)
    if (route === undefined) {
      socket.destroy()
      return
    }
    void Promise.resolve(route.handler(req, socket, head)).catch(() => socket.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  const bound = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${bound}`,
    web,
    ctx,
    server,
    async close() {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

async function dispatch(web: FakeWebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  const route = web.match(pathname)
  if (route === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  try {
    await route.handler(req, res)
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500)
      res.end(String(error))
    } else {
      res.end()
    }
  }
}

export interface CallStarted {
  status: number
  headers: Headers
  text: string
  json: () => unknown
}

export interface CallOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

/** 发一次 brain HTTP 请求。 */
export async function call(baseUrl: string, path: string, options: CallOptions = {}): Promise<CallStarted> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  let body: string | undefined
  if (options.body !== undefined) {
    body = JSON.stringify(options.body)
    headers['content-type'] ??= 'application/json'
  }
  const response = await fetch(`${baseUrl}${path}`, { method: options.method ?? 'GET', headers, body })
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: () => JSON.parse(text) as unknown,
  }
}

/** 一个 SSE 事件（comment 行不记录）。 */
export interface SseEvent {
  event: string
  data: unknown
}

/**
 * 读 SSE，直到 `until` 返回 true 或超时。
 * 返回已收到的事件与关闭函数。
 */
export async function readSse(
  baseUrl: string,
  path: string,
  options: CallOptions & {
    until: (events: SseEvent[]) => boolean
    /** 收到 ready 帧后执行一次，用于在流保持打开时注入事件。 */
    onReady?: () => void | Promise<void>
    timeoutMs?: number
  },
): Promise<{ events: SseEvent[]; close(): void }> {
  const controller = new AbortController()
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    signal: controller.signal,
  })
  if (!response.ok || response.body === null) {
    const text = await response.text().catch(() => '')
    controller.abort()
    throw new Error(`SSE 打开失败: ${response.status} ${text}`)
  }
  const events: SseEvent[] = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)

  const parse = (chunk: string): void => {
    buffer += chunk
    for (;;) {
      const split = buffer.indexOf('\n\n')
      if (split === -1) return
      const block = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      let event = 'message'
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim()
        else if (line.startsWith('data: ')) data += line.slice(6)
      }
      if (data === '') continue
      try {
        events.push({ event, data: JSON.parse(data) })
      } catch {
        events.push({ event, data })
      }
    }
  }

  let readyFired = false
  try {
    while (!options.until(events)) {
      if (Date.now() > deadline) throw new Error(`SSE 等待超时，已收到 ${JSON.stringify(events)}`)
      const { value, done } = await reader.read()
      if (done) break
      parse(decoder.decode(value, { stream: true }))
      if (!readyFired && options.onReady !== undefined && events.some((event) => event.event === 'ready')) {
        readyFired = true
        await options.onReady()
      }
    }
  } finally {
    controller.abort()
    reader.cancel().catch(() => undefined)
  }
  return {
    events,
    close: () => controller.abort(),
  }
}

/** One server frame as the test client sees it. */
export interface StreamFrameMessage {
  readonly type: string
  readonly [key: string]: unknown
}

/** A session-stream client: SSE down, REST answers up. */
export interface StreamClient {
  readonly frames: StreamFrameMessage[]
  /** Resolve with the first frame (already received or newly arriving) that matches. */
  waitFor(predicate: (frame: StreamFrameMessage) => boolean, timeoutMs?: number): Promise<StreamFrameMessage>
  /** POST one answer and return the raw HTTP outcome. */
  answer(requestId: string, outcome: unknown): Promise<{ status: number; body: unknown }>
  /** Resolve when the server ends the stream. */
  readonly closed: Promise<void>
  close(): void
}

/**
 * Open a real session stream: one SSE GET with app credentials, then the
 * `frame` events. Mirrors what the platform's upstream client does.
 */
export async function openSessionStream(
  baseUrl: string,
  sessionId: string,
  options: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<StreamClient> {
  const url = new URL(`/brain/v1/sessions/${encodeURIComponent(sessionId)}/stream`, baseUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000)
  const response = await fetch(url, {
    headers: { accept: 'text/event-stream', ...(options.headers ?? {}) },
    signal: controller.signal,
  }).catch((error: unknown) => {
    clearTimeout(timer)
    throw error
  })
  clearTimeout(timer)
  if (!response.ok || response.body === null) {
    const text = await response.text().catch(() => '')
    controller.abort()
    throw new Error(`session stream rejected: ${response.status} ${text}`)
  }

  const frames: StreamFrameMessage[] = []
  const waiters = new Set<{
    predicate: (frame: StreamFrameMessage) => boolean
    resolve: (frame: StreamFrameMessage) => void
  }>()
  let resolveClosed: () => void = () => undefined
  const closed = new Promise<void>(done => { resolveClosed = done })

  const deliver = (frame: StreamFrameMessage): void => {
    frames.push(frame)
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(frame)) continue
      waiters.delete(waiter)
      waiter.resolve(frame)
    }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const split = buffer.indexOf('\n\n')
          if (split === -1) break
          const block = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          const lines = block.split('\n')
          if (lines.every(line => line === '' || line.startsWith(':'))) continue
          let event = 'message'
          let data = ''
          for (const line of lines) {
            if (line.startsWith('event: ')) event = line.slice(7).trim()
            else if (line.startsWith('data: ')) data += line.slice(6)
          }
          if (event !== 'frame' || data === '') continue
          deliver(JSON.parse(data) as StreamFrameMessage)
        }
      }
    } catch {
      /* aborted or transport failure: both mean the stream ended */
    } finally {
      for (const waiter of waiters) waiter.resolve({ type: 'closed' })
      waiters.clear()
      resolveClosed()
    }
  })()

  return {
    frames,
    waitFor(predicate, timeoutMs = 5_000) {
      const existing = frames.find(predicate)
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise<StreamFrameMessage>((done, fail) => {
        const waiter = { predicate, resolve: done }
        waiters.add(waiter)
        const failTimer = setTimeout(() => {
          waiters.delete(waiter)
          fail(new Error(`stream frame timed out; seen ${JSON.stringify(frames)}`))
        }, timeoutMs)
        failTimer.unref?.()
        const resolve0 = waiter.resolve
        waiter.resolve = frame => {
          clearTimeout(failTimer)
          resolve0(frame)
        }
      })
    },
    async answer(requestId, outcome) {
      const reply = await fetch(new URL(`/brain/v1/sessions/${encodeURIComponent(sessionId)}/answers`, baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        body: JSON.stringify({ requestId, outcome }),
      })
      const text = await reply.text()
      let body: unknown = text
      try {
        body = JSON.parse(text) as unknown
      } catch {
        /* keep the raw text */
      }
      return { status: reply.status, body }
    },
    closed,
    close() {
      controller.abort()
      reader.cancel().catch(() => undefined)
    },
  }
}

/** 最小可用的网关：内存事件日志 + 订阅分发，行为对齐 routes.ts 的契约。 */
export class MemoryGateway implements BrainGateway {
  readonly sessions = new Map<string, { cwd: string; preset?: string }>()
  readonly prompts: Array<{ sessionId: string; text: string; requestId: string }> = []
  readonly cancellations: string[] = []
  readonly modelSelections: Array<{ sessionId: string; provider: string; model: string; reasoningEffort?: string }> = []
  readonly registeredModels: Array<{ provider: string; models: readonly string[] }> = []
  private readonly logs = new Map<
    string,
    Array<{ seq: number; type: string; data: unknown; surfaceOp?: unknown; sourceEventSeqs?: unknown; ignorable?: boolean }>
  >()
  private readonly listeners = new Map<string, Set<(frame: StreamFrame) => void>>()
  nextId = 1

  async create(input: { cwd: string; preset?: string; sessionId?: string }): Promise<{ sessionId: string }> {
    const sessionId = input.sessionId ?? `sess-${this.nextId++}`
    this.sessions.set(sessionId, { cwd: input.cwd, ...(input.preset === undefined ? {} : { preset: input.preset }) })
    // 平台在发消息前会再 open 一次已有会话；保留它的事件日志。
    if (!this.logs.has(sessionId)) this.logs.set(sessionId, [])
    return { sessionId }
  }

  /**
   * 测试手动追加一条已提交事件，并推给在线订阅者。
   *
   * `surface` 是持久日志里的表面元数据；真实 gateway 会原样带出来，测试用
   * 同样的形状驱动流帧，才能钉住「增量不能丢 surfaceOp」这条契约。
   */
  append(
    sessionId: string,
    type: string,
    data: unknown,
    surface: { surfaceOp?: unknown; sourceEventSeqs?: unknown; ignorable?: boolean } = {},
  ): number {
    const log = this.logs.get(sessionId) ?? []
    this.logs.set(sessionId, log)
    const seq = log.length
    log.push({ seq, type, data, ...surface })
    for (const listener of this.listeners.get(sessionId) ?? []) {
      listener({ kind: 'event', seq, type, data, ...surface })
    }
    return seq
  }

  async prompt(sessionId: string, text: string, requestId: string): Promise<void> {
    if (!this.logs.has(sessionId)) throw new Error(`session-not-found: ${sessionId}`)
    this.prompts.push({ sessionId, text, requestId })
    for (const listener of this.listeners.get(sessionId) ?? []) listener({ kind: 'status', status: 'running' })
    this.append(sessionId, 'user', { text })
    this.append(sessionId, 'assistant', { text: `收到：${text}` })
    for (const listener of this.listeners.get(sessionId) ?? []) listener({ kind: 'status', status: 'idle' })
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancellations.push(sessionId)
  }

  /** 记录模型选择；路由用它的存在与否决定 501。 */
  async selectModel(
    sessionId: string,
    selection: { provider: string; model: string; reasoningEffort?: string },
  ): Promise<unknown> {
    this.modelSelections.push({ sessionId, ...selection })
    return selection
  }

  /** 记录平台登记的可选模型；脑据此把成员配置的 id 加到 provider 上。 */
  async registerModels(provider: string, models: readonly string[]): Promise<void> {
    this.registeredModels.push({ provider, models })
  }

  async head(sessionId: string): Promise<{ cursor: number; running: boolean }> {
    const log = this.logs.get(sessionId)
    if (log === undefined) throw new Error('session-not-found')
    return { cursor: log.length - 1, running: false }
  }

  async events(sessionId: string, after: number, limit: number) {
    const log = this.logs.get(sessionId) ?? []
    return log.filter((entry) => entry.seq > after).slice(0, limit)
  }

  subscribe(sessionId: string, listener: (frame: StreamFrame) => void): () => void {
    let set = this.listeners.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(sessionId, set)
    }
    set.add(listener)
    return () => set.delete(listener)
  }

  // ---- composer 能力面：只记录调用并回固定值，够平台侧契约测试断言 ----

  readonly composerCalls: Array<{ method: string; path: string; body: unknown }> = []
  readonly killedJobs: string[] = []

  async projections() {
    return [{ kind: 'baseline', tokens: 0 }]
  }

  async messageFeedbackList() {
    return { items: [{ messageId: 'm1', value: 'up' }] }
  }

  async messageFeedbackPut(_sessionId: string, request: unknown) {
    this.composerCalls.push({ method: 'POST', path: '/message-feedback', body: request })
    return { item: request }
  }

  async messageFeedbackDelete(_sessionId: string, request: unknown) {
    this.composerCalls.push({ method: 'DELETE', path: '/message-feedback', body: request })
    return { removed: true }
  }

  async sessionFeedbackRecord(_sessionId: string, request: unknown) {
    this.composerCalls.push({ method: 'POST', path: '/feedback', body: request })
    return { recorded: true }
  }

  async commands() {
    return [{ name: '/help', description: '帮助' }]
  }

  async executeCommand(_sessionId: string, line: string, attachments?: readonly unknown[]) {
    this.composerCalls.push({ method: 'POST', path: '/commands', body: line })
    return { line, attachments: attachments ?? [] }
  }

  async goal() {
    return { objective: '完成接口', rounds: 0 }
  }

  async editGoal(_sessionId: string, request: unknown) {
    this.composerCalls.push({ method: 'PUT', path: '/goal', body: request })
    return request
  }

  async goalAction(_sessionId: string, action: 'pause' | 'resume' | 'complete' | 'clear', request: unknown) {
    this.composerCalls.push({ method: 'POST', path: `/goal/${action}`, body: request })
    return { action }
  }

  async selectPreset(_sessionId: string, agentPreset: string) {
    this.composerCalls.push({ method: 'POST', path: '/preset', body: agentPreset })
    return agentPreset
  }

  async forceCancel() {
    return { closed: true, events: 1 }
  }

  async *listJobs(_sessionId: string, _signal: AbortSignal) {
    yield { type: 'rows' as const, jobs: [{ id: 'bash-1', status: 'running' }] }
  }

  async *followJob(_sessionId: string, jobId: string, from: number | undefined, _signal: AbortSignal) {
    yield { type: 'opened' as const, job: { id: jobId }, from: from ?? 0 }
    yield { type: 'output' as const, chunks: [{ text: 'first line\n' }], next: 11 }
  }

  async killJob(_sessionId: string, jobId: string) {
    this.killedJobs.push(jobId)
    return { outcome: 'requested' as const }
  }
}
