/**
 * Per-user HTTP MCP servers.
 *
 * Reads `dsh_mcp_servers` for the session owner plus rows shared as `public`
 * and reconciles one MCP client per enabled `streamable-http` server on the
 * Agent scope before every model step. When a member has a private server with
 * the same name as a public one, the private row wins. Changed/removed servers
 * are disposed, new ones are mounted, so changes take effect on the next turn
 * instead of only for newly created Agents. Secrets
 * referenced by `cred:mcp/<server>/<header>` are decrypted from
 * `dsh_user_credentials` with AES-256-GCM, under the owning user of the row.
 * stdio is intentionally unsupported: it would spawn processes on the brain
 * host.
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

export interface WorkspaceSelection {
  readonly name: string
  readonly scope: 'private' | 'public'
}

interface SessionOwnerLike {
  userId: string
  /** undefined = 工作区没配置过，沿用全部启用；空数组 = 明确不接入任何 MCP。 */
  mcpServers?: readonly WorkspaceSelection[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionDirectory?: {
      ownerOf(sessionId: string): Promise<SessionOwnerLike | undefined>
      userOf(sessionId: string): Promise<{ userId: string } | undefined>
    }
  }
}

const CRED_PREFIX = 'cred:mcp/'

export interface McpRow {
  user_id: string
  server_name: string
  transport: string
  target: string
  config: unknown
  scope: 'private' | 'public'
}

/** 工作区明确选择时只留下选中的 server；undefined 表示沿用全部。 */
export function filterSelected(
  rows: readonly McpRow[],
  selection: readonly WorkspaceSelection[] | undefined,
): McpRow[] {
  if (selection === undefined) return [...rows]
  const selected = new Set(selection.map((item) => `${item.scope}:${item.name}`))
  return rows.filter((row) => selected.has(`${row.scope}:${row.server_name}`))
}

/** 同名时私有覆盖公开；再过滤掉非 streamable-http 的行。 */
export function chooseServers(rows: readonly McpRow[]): McpRow[] {
  const chosen = new Map<string, McpRow>()
  for (const row of rows) {
    if (row.transport !== 'streamable-http') continue
    const current = chosen.get(row.server_name)
    if (current === undefined || (current.scope !== 'private' && row.scope === 'private')) {
      chosen.set(row.server_name, row)
    }
  }
  return [...chosen.values()].sort((left, right) => left.server_name.localeCompare(right.server_name))
}

interface McpConfig {
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
}

type AgentLike = { session: { id: string }; ctx: Context }

interface MountedServer {
  readonly hash: string
  /** Cordis 的组件卸载是异步的；停用/换配置要等卸载完，工具才不会残留到下一步。 */
  readonly dispose: () => Promise<void>
}

/** `ctx.plugin()` 返回的 Fiber 里卸载相关的字段（类型包没有导出 Fiber 的完整形状）。 */
interface LoadedFiber {
  dispose?: () => unknown
  /** 卸载收尾的 Promise；dispose() 本身先返回，效果清理挂在它后面。 */
  inertia?: Promise<unknown>
}

/** 等 Fiber 连效果清理一起卸载完，工具注册才会真正撤销。 */
async function disposeFiber(fiber: LoadedFiber | undefined): Promise<void> {
  if (fiber === undefined) return
  await Promise.resolve(fiber.dispose?.())
  for (let inertia = fiber.inertia; inertia !== undefined; inertia = fiber.inertia) await inertia
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
      | {
          ownerOf(sessionId: string): Promise<SessionOwnerLike | undefined>
          userOf(sessionId: string): Promise<{ userId: string } | undefined>
        }
      | undefined
    // ownerOf 带工作区选择；没有工作区（老会话）时退回 userOf，沿用全部启用。
    const owner = await directory?.ownerOf(agent.session.id)
    const user = owner ?? await directory?.userOf(agent.session.id)
    if (user === undefined) return
    const rows = await ctx.db.query<McpRow>(
      `SELECT user_id, server_name, transport, target, config, scope
         FROM dsh_mcp_servers
        WHERE enabled = true AND (user_id = $1 OR scope = 'public')
        ORDER BY server_name`,
      [user.userId],
    )
    const selection = 'mcpServers' in user ? (user.mcpServers as readonly WorkspaceSelection[] | undefined) : undefined
    const desired = new Map<string, { row: McpRow; hash: string }>()
    for (const row of chooseServers(filterSelected(rows, selection))) {
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
        current.delete(name)
        try {
          await mounted.dispose()
        } catch (error) {
          ctx.logger?.warn?.(`user-mcp: dispose ${name} failed: ${String(error)}`)
        }
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
    let fiber: LoadedFiber | undefined
    try {
      fiber = (agent.ctx as unknown as {
        plugin(plugin: unknown, config: unknown): LoadedFiber & PromiseLike<unknown>
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
        await disposeFiber(fiber).catch(() => undefined)
        return undefined
      }
    } catch (error) {
      ctx.logger?.warn?.(`user-mcp: mount ${row.server_name} failed: ${String(error)}`)
      await disposeFiber(fiber).catch(() => undefined)
      return undefined
    }
    return {
      hash,
      dispose: () => disposeFiber(fiber),
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
  return JSON.stringify({
    user_id: row.user_id,
    scope: row.scope,
    transport: row.transport,
    target: row.target,
    config: row.config,
  })
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
