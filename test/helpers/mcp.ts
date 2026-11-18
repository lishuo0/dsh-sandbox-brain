/**
 * 最小可用的 Streamable HTTP MCP server。
 *
 * 真实链路里 MCP 客户端（`@deepseek-ai/dsh-mcp-client`）会先用
 * `server/discover` 探测协议代际，失败/不识别时回落到 2025 的 `initialize`
 * 握手，然后 `tools/list` + `tools/call`。这里按这个顺序实现：
 *
 * - POST JSON-RPC；`server/discover` 回空 result（客户端判为 legacy）；
 * - `initialize` 原样回带客户端给的协议版本；
 * - `notifications/initialized` 回 202（客户端随后会 GET 开 SSE，回 405 即可）；
 * - `tools/list` / `tools/call` 走测试给的工具表，并记录调用与请求头。
 *
 * 不依赖 `@modelcontextprotocol/server`：仓库里没有那个包，手写这几条消息
 * 足够验证「挂载 → 列工具 → 调用工具」的完整链路。
 */
import { createCipheriv, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'

/**
 * 按平台 `kernel/seal.ts` 的布局封印一个 MCP 请求头密钥：
 * `nonce(12) || 密文 || tag(16)`，AES-256-GCM。
 *
 * 这里单独实现而不是从平台仓库 import，保持脑测试不依赖平台源码。
 */
export function sealCredential(key: Buffer, plaintext: string): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

export interface MockMcpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  /** 生成 `tools/call` 的文本结果。 */
  call?: (args: Record<string, unknown>, headers: IncomingHttpHeaders) => string
}

export interface MockMcpCall {
  name: string
  args: Record<string, unknown>
  headers: IncomingHttpHeaders
}

export interface MockMcpServer {
  url: string
  tools: readonly MockMcpTool[]
  calls: MockMcpCall[]
  /** 每个工具列表请求，用来验证客户端确实在挂载时同步过工具。 */
  listCalls: IncomingHttpHeaders[]
  close(): Promise<void>
}

type IncomingHttpHeaders = Record<string, string | string[] | undefined>

interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

const DEFAULT_TOOLS: readonly MockMcpTool[] = [
  {
    name: 'echo',
    description: '把参数里的 text 原样返回',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    call: (args) => `echo: ${String(args.text ?? '')}`,
  },
]

export interface MockMcpOptions {
  tools?: readonly MockMcpTool[]
  /**
   * 平台只接受 `https://` 的 MCP 地址，联合用例要经平台 API 落库就得让 mock
   * 也讲 TLS。传入自签证书即可；调用方负责让客户端信任它。
   */
  tls?: { key: Buffer; cert: Buffer }
}

export async function startMockMcp(options: MockMcpOptions = {}): Promise<MockMcpServer> {
  const tools = options.tools ?? DEFAULT_TOOLS
  const calls: MockMcpCall[] = []
  const listCalls: IncomingHttpHeaders[] = []
  const handler = (req: IncomingMessage, res: ServerResponse): void => void dispatch(req, res)
  const server: HttpServer = options.tls === undefined
    ? createServer(handler)
    : createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const scheme = options.tls === undefined ? 'http' : 'https'

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 客户端在 initialized 之后会开 GET SSE 订阅；按规范回 405 表示不支持。
    if (req.method === 'GET' || req.method === 'DELETE') {
      res.writeHead(405)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    const body = await readBody(req)
    let parsed: JsonRpcMessage | JsonRpcMessage[]
    try {
      parsed = JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[]
    } catch {
      res.writeHead(400)
      res.end('invalid json')
      return
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    const replies: Array<Record<string, unknown>> = []
    for (const message of messages) {
      const reply = handle(message, req.headers)
      if (reply !== undefined) replies.push(reply)
    }
    if (replies.length === 0) {
      res.writeHead(202)
      res.end()
      return
    }
    const payload = Array.isArray(parsed) ? replies : replies[0]
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  function handle(message: JsonRpcMessage, headers: IncomingHttpHeaders): Record<string, unknown> | undefined {
    const id = message.id
    const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, result })
    const error = (code: number, text: string): Record<string, unknown> => ({
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code, message: text },
    })
    switch (message.method) {
      case 'server/discover':
        // 空 result 不满足现代（2026-07-28）发现结果，客户端回落 legacy 握手。
        return reply({})
      case 'initialize': {
        const requested = typeof message.params?.protocolVersion === 'string'
          ? message.params.protocolVersion
          : '2025-06-18'
        return reply({
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp', version: '1.0.0' },
        })
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined
      case 'ping':
        return reply({})
      case 'tools/list':
        listCalls.push(headers)
        return reply({
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
          })),
        })
      case 'tools/call': {
        const name = String(message.params?.name ?? '')
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>
        calls.push({ name, args, headers })
        const tool = tools.find((item) => item.name === name)
        if (tool === undefined) return error(-32602, `unknown tool "${name}"`)
        const text = tool.call?.(args, headers) ?? `ok: ${name}`
        return reply({ content: [{ type: 'text', text }], isError: false })
      }
      default:
        if (id === undefined || id === null) return undefined
        return error(-32601, `method not found: ${String(message.method)}`)
    }
  }

  return {
    url: `${scheme}://127.0.0.1:${port}/mcp`,
    tools,
    calls,
    listCalls,
    async close() {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
