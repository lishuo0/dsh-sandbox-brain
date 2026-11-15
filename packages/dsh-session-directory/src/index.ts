/**
 * Session → owner lookup.
 *
 * Called from the sandbox registry on every tool call to decide which microVM a
 * request belongs to, so the answer is cached in-process. The cache is keyed by
 * session and evicted on TTL; a stale entry can only point at a sandbox the
 * caller already had access to, never at another tenant's.
 *
 * @module @brain/dsh-session-directory
 */

import type {} from '@brain/dsh-database'
import { Service, type Context } from '@deepseek-ai/cordis'

/** Who a session belongs to. */
export interface SessionOwner {
  readonly userId: string
  readonly workspaceId: string
  /** Volume this workspace owns, when the platform records one. */
  readonly volumeName?: string
  /**
   * Workspace root inside the sandbox, when the platform records one.
   *
   * `dsh_workspaces.guest_root`: the platform stores where this workspace's
   * volume is mounted, and passes the same path as the session cwd. The
   * registry mounts the workspace prefix there, so the two can never disagree.
   */
  readonly guestRoot?: string
  /** Per-user skills volume name, when the platform records one. */
  readonly skillsVolume?: string
}

/** User-level owner used by skills/MCP, which do not require a workspace. */
export interface SessionUser {
  readonly userId: string
  readonly skillsVolume?: string
}

/** Configuration. */
export interface Config {
  /** Cache lifetime in milliseconds; 0 disables caching. */
  readonly cacheTtlMs?: number
  /** Maximum cached sessions before the oldest entries are dropped. */
  readonly cacheMaxEntries?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Owner resolution for the sandbox registry. */
    sessionDirectory: SessionDirectoryService
  }
}

const MAX_LINEAGE_DEPTH = 16

/** One cached answer, including a negative result. */
interface CacheEntry {
  readonly owner: SessionOwner | undefined
  readonly expiresAt: number
}

/**
 * The directory.
 *
 * A miss, an unknown session and a deleted session are all `undefined`: callers
 * must not be able to tell "no such session" from "not yours".
 */
export default class SessionDirectoryService extends Service {
  static readonly inject = ['db', 'agents']

  private readonly cache = new Map<string, CacheEntry>()
  private readonly ttl: number
  private readonly maxEntries: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionDirectory')
    this.ttl = config.cacheTtlMs ?? 30_000
    this.maxEntries = config.cacheMaxEntries ?? 10_000
  }

  /**
   * Resolve one session's owner.
   * @param sessionId - the session.
   * @returns its owner, or undefined when the session is unknown.
   */
  async owner(sessionId: string): Promise<SessionOwner | undefined> {
    if (sessionId === '') return undefined
    if (this.ttl > 0) {
      const hit = this.cache.get(sessionId)
      if (hit !== undefined && hit.expiresAt > Date.now()) return hit.owner
    }

    const rows = await this.ctx.db.query<{
      user_id: string
      workspace_id: string | null
      volume_name: string | null
      guest_root: string | null
      skills_volume: string | null
    }>(
      `SELECT s.user_id, s.workspace_id, w.volume_name, w.guest_root, u.skills_volume
         FROM dsh_sessions s
         LEFT JOIN dsh_workspaces w ON w.id = s.workspace_id
         LEFT JOIN dsh_users u ON u.id = s.user_id
        WHERE s.id = $1`,
      [sessionId],
    )
    const row = rows[0]
    let owner: SessionOwner | undefined
    if (row !== undefined && row.workspace_id !== null) {
      owner = {
        userId: row.user_id,
        workspaceId: row.workspace_id,
        ...(row.volume_name === null ? {} : { volumeName: row.volume_name }),
        ...(row.guest_root === null || row.guest_root === undefined ? {} : { guestRoot: row.guest_root }),
        ...(row.skills_volume === null ? {} : { skillsVolume: row.skills_volume }),
      }
    }

    if (row !== undefined && row.workspace_id === null) {
      // The session exists but has no project yet: completing creation is the
      // platform's job, and until then it cannot be routed.
      this.ctx.logger?.warn?.(`session-directory: session "${sessionId}" has no workspace`)
    }

    if (this.ttl > 0) this.remember(sessionId, owner)
    return owner
  }

  /** Lineage-aware owner lookup for subagent sessions. */
  async ownerOf(sessionId: string): Promise<SessionOwner | undefined> {
    const seen = new Set<string>()
    let id = sessionId
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
      if (id === '') return undefined
      if (seen.has(id)) return undefined
      seen.add(id)
      const owner = await this.owner(id)
      if (owner !== undefined) return owner
      const parent = this.parentSessionOf(id)
      if (parent === undefined) return undefined
      id = parent
    }
    return undefined
  }

  /**
   * Resolve the platform-owned ancestor's user, tolerating a session with no
   * workspace. Skills and MCP are user-level and do not need workspace routing.
   */
  async userOf(sessionId: string): Promise<SessionUser | undefined> {
    const seen = new Set<string>()
    let id = sessionId
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
      if (id === '') return undefined
      if (seen.has(id)) return undefined
      seen.add(id)
      const rows = await this.ctx.db.query<{ user_id: string; skills_volume: string | null }>(
        `SELECT s.user_id, u.skills_volume
           FROM dsh_sessions s
           LEFT JOIN dsh_users u ON u.id = s.user_id
          WHERE s.id = $1`,
        [id],
      )
      const row = rows[0]
      if (row !== undefined) {
        return {
          userId: row.user_id,
          ...(row.skills_volume === null ? {} : { skillsVolume: row.skills_volume }),
        }
      }
      const parent = this.parentSessionOf(id)
      if (parent === undefined) return undefined
      id = parent
    }
    return undefined
  }

  /** The parent recorded on one live child session, when the agent exists. */
  private parentSessionOf(sessionId: string): string | undefined {
    const agents = this.ctx.get('agents') as
      | { get(id: string): { session?: { header?: { parentSession?: unknown } } } | undefined }
      | undefined
    try {
      const parent = agents?.get(sessionId)?.session?.header?.parentSession
      return parent === undefined || parent === null || String(parent) === ''
        ? undefined
        : String(parent)
    } catch {
      return undefined
    }
  }

  /**
   * Drop one cached answer, e.g. after the platform reassigns a session.
   * @param sessionId - the session to forget.
   */
  forget(sessionId: string): void {
    this.cache.delete(sessionId)
  }

  /** Drop everything. */
  clear(): void {
    this.cache.clear()
  }

  /** Store one answer, evicting the oldest entry past the cap. */
  private remember(sessionId: string, owner: SessionOwner | undefined): void {
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(sessionId, { owner, expiresAt: Date.now() + this.ttl })
  }
}
