/**
 * Per-user HTTP MCP servers.
 *
 * Reads `dsh_mcp_servers` for the session owner and reconciles one MCP client
 * per enabled `streamable-http` server on the Agent scope before every model
 * step. Changed/removed servers are disposed, new ones are mounted, so changes
 * take effect on the next turn instead of only for newly created Agents. Secrets
 * referenced by `cred:mcp/<server>/<header>` are decrypted from
 * `dsh_user_credentials` with AES-256-GCM. stdio is intentionally unsupported:
 * it would spawn processes on the brain host.
 *
 * @module @brain/dsh-user-mcp
 */

import { createDecipheriv } from 'node:crypto'
import type {} from '@brain/dsh-database'
import type {} from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

/** Plugin configuration. */
export interface Config {
  /** Environment variable carrying the base64 32-byte AES key. */
  readonly credentialsKeyEnv?: string
  /** Default per-tool-call timeout. */
  readonly defaultToolCallTimeoutMs?: number
  /** How long to wait for one MCP server to connect before giving up. */
  readonly mountTimeoutMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionDirectory?: {
      userOf(sessionId: string): Promise<{ userId: string } | undefined>
    }
  }
}

const CRED_PREFIX = 'cred:mcp/'

interface McpRow {
  user_id: string
  server_name: string
  transport: string
  target: string
  config: unknown
}

interface McpConfig {
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
}

type AgentLike = { session: { id: string }; ctx: Context }

interface MountedServer {
  readonly hash: string
  readonly dispose: () => void
}

export default class UserMcpPlugin {
  static readonly inject = ['db', 'sessionDirectory']

  private readonly keyEnv: string
  private readonly defaultTimeout: number
  private readonly mountTimeout: number
  private readonly mounted = new WeakMap<object, Map<string, MountedServer>>()
  private warnedNoKey = false

  constructor(ctx: Context, config: Config = {}) {
    this.keyEnv = config.credentialsKeyEnv ?? 'DSH_CREDENTIALS_KEY'
    this.defaultTimeout = config.defaultToolCallTimeoutMs ?? 60_000
    this.mountTimeout = config.mountTimeoutMs ?? 15_000
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      await this.reconcile(ctx, agent).catch((error) => {
        ctx.logger?.warn?.(`user-mcp: reconcile failed: ${String(error)}`)
      })
      return next()
    })
  }

  /** Bring the Agent's mounted MCP clients in line with the platform rows. */
  private async reconcile(ctx: Context, agent: AgentLike): Promise<void> {
    const directory = ctx.get('sessionDirectory') as
      | { userOf(sessionId: string): Promise<{ userId: string } | undefined> }
      | undefined
    const user = await directory?.userOf(agent.session.id)
    if (user === undefined) return
    const rows = await ctx.db.query<McpRow>(
      `SELECT user_id, server_name, transport, target, config
         FROM dsh_mcp_servers
        WHERE user_id = $1 AND enabled = true
        ORDER BY server_name`,
      [user.userId],
    )
    const desired = new Map<string, { row: McpRow; hash: string }>()
    for (const row of rows) {
      if (row.transport !== 'streamable-http') continue
      desired.set(row.server_name, { row, hash: configHash(row) })
    }
    let current = this.mounted.get(agent)
    if (current === undefined) {
      current = new Map()
      this.mounted.set(agent, current)
    }
    for (const [name, mounted] of [...current.entries()]) {
      const next = desired.get(name)
      if (next === undefined || next.hash !== mounted.hash) {
        mounted.dispose()
        current.delete(name)
      }
    }
    for (const [name, desiredServer] of desired) {
      if (current.has(name)) continue
      const mounted = await this.mountOne(ctx, agent, desiredServer.row, desiredServer.hash)
      if (mounted !== undefined) current.set(name, mounted)
    }
  }

  private async mountOne(
    ctx: Context,
    agent: AgentLike,
    row: McpRow,
    hash: string,
  ): Promise<MountedServer | undefined> {
    const config = parseConfig(row.config)
    let headers: Record<string, string>
    try {
      headers = await this.resolveHeaders(ctx, row.user_id, row.server_name, config.headers ?? {})
    } catch (error) {
      ctx.logger?.warn?.(`user-mcp: skip ${row.server_name}: ${String(error)}`)
      return undefined
    }
    const timeout = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), this.mountTimeout)
      timer.unref?.()
    })
    let fiber: { dispose?: () => unknown } | undefined
    try {
      fiber = (agent.ctx as unknown as {
        plugin(plugin: unknown, config: unknown): { dispose?: () => unknown } & PromiseLike<unknown>
      }).plugin(McpClient, {
        transport: 'streamable-http',
        serverName: row.server_name,
        url: row.target,
        headers,
        toolCallTimeoutMs: config.toolCallTimeoutMs ?? this.defaultTimeout,
        failOnStartupError: false,
      })
      const outcome = await Promise.race([Promise.resolve(fiber).then(() => 'mounted' as const), timeout])
      if (outcome === 'timeout') {
        ctx.logger?.warn?.(`user-mcp: ${row.server_name} did not connect within ${this.mountTimeout}ms`)
        fiber?.dispose?.()
        return undefined
      }
    } catch (error) {
      ctx.logger?.warn?.(`user-mcp: mount ${row.server_name} failed: ${String(error)}`)
      fiber?.dispose?.()
      return undefined
    }
    return {
      hash,
      dispose: () => {
        try {
          fiber?.dispose?.()
        } catch (error) {
          ctx.logger?.warn?.(`user-mcp: dispose ${row.server_name} failed: ${String(error)}`)
        }
      },
    }
  }

  private async resolveHeaders(
    ctx: Context,
    userId: string,
    serverName: string,
    source: Record<string, string>,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(source)) {
      if (!value.startsWith(CRED_PREFIX)) {
        out[name] = value
        continue
      }
      const key = loadCredentialsKey(process.env[this.keyEnv])
      if (key === undefined) {
        if (!this.warnedNoKey) {
          this.warnedNoKey = true
          ctx.logger?.warn?.(`user-mcp: ${this.keyEnv} is missing or invalid; secret headers are unavailable`)
        }
        throw new Error('credentials key is not configured')
      }
      const ref = value.slice(CRED_PREFIX.length)
      const rows = await ctx.db.query<{ ciphertext: Buffer; key_version: number }>(
        `SELECT ciphertext, key_version
           FROM dsh_user_credentials
          WHERE user_id = $1 AND kind = 'mcp-header' AND name = $2`,
        [userId, ref],
      )
      const sealed = rows[0]?.ciphertext
      if (sealed === undefined) throw new Error(`missing credential "${ref}" for ${serverName}`)
      out[name] = decrypt(key, Buffer.from(sealed))
    }
    return out
  }
}

function configHash(row: McpRow): string {
  return JSON.stringify({ user_id: row.user_id, transport: row.transport, target: row.target, config: row.config })
}

function parseConfig(value: unknown): McpConfig {
  if (value === null || value === undefined) return {}
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as McpConfig
    } catch {
      return {}
    }
  }
  return value as McpConfig
}

function loadCredentialsKey(raw: string | undefined): Buffer | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  try {
    const key = Buffer.from(raw, 'base64')
    return key.length === 32 ? key : undefined
  } catch {
    return undefined
  }
}

/** Decrypt `nonce(12) || ciphertext || tag(16)` produced by the platform. */
function decrypt(key: Buffer, sealed: Buffer): string {
  if (sealed.length < 12 + 16) throw new Error('credential ciphertext is too short')
  const nonce = sealed.subarray(0, 12)
  const tag = sealed.subarray(sealed.length - 16)
  const ciphertext = sealed.subarray(12, sealed.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
