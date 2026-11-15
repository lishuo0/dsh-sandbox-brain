/**
 * Session ownership check for the REST surface.
 *
 * DSH has no user concept: a session id is the whole identity it understands.
 * So the platform's API must answer "does this user own this session?" itself,
 * and it must answer with the same 404 whether the session is unknown or belongs
 * to someone else — otherwise a caller can enumerate other tenants' ids.
 *
 * @module @brain/dsh-platform-api/ownership
 */

import type { Context } from '@deepseek-ai/cordis'
import { HttpError } from './http.ts'

/** Answers ownership questions, with a short cache. */
export interface OwnershipGuard {
  /**
   * Assert that `userId` owns `sessionId`.
   * @param sessionId - the session named by the request.
   * @param userId - the caller's `x-dsh-user-id`.
   * @throws {HttpError} 404 when the session is unknown or not theirs.
   */
  assert(sessionId: string, userId: string): Promise<void>
}

/** Cache lifetime for a positive or negative answer. */
const TTL_MS = 15_000

/** Maximum cached sessions. */
const MAX_ENTRIES = 10_000

/**
 * Build the guard over the shared database.
 *
 * When no database is mounted the guard is a no-op with a warning: that is only
 * acceptable on a developer machine, where there is one user and no tenant
 * boundary to defend.
 * @param ctx - plugin context.
 * @returns the guard.
 */
export function createOwnershipGuard(ctx: Context): OwnershipGuard {
  const db = ctx.get('db') as
    | { query<T>(text: string, params?: readonly unknown[]): Promise<T[]> }
    | undefined

  if (db === undefined) {
    ctx.logger?.warn?.('platform-api: no database mounted; session ownership is NOT enforced')
    return { assert: async () => undefined }
  }

  const cache = new Map<string, { userId: string | undefined; expiresAt: number }>()

  return {
    async assert(sessionId, userId) {
      const key = `${sessionId}\u0000${userId}`
      const hit = cache.get(key)
      let owner: string | undefined
      if (hit !== undefined && hit.expiresAt > Date.now()) {
        owner = hit.userId
      } else {
        const rows = await db.query<{ user_id: string }>(
          'SELECT user_id FROM dsh_sessions WHERE id = $1',
          [sessionId],
        )
        owner = rows[0]?.user_id
        if (cache.size >= MAX_ENTRIES) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
        cache.set(key, { userId: owner, expiresAt: Date.now() + TTL_MS })
      }
      if (owner === undefined || owner !== userId) {
        // Same answer for "unknown" and "not yours".
        throw new HttpError(404, 'session-not-found', `session "${sessionId}" is not available to this caller`)
      }
    },
  }
}
