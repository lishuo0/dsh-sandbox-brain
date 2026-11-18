/**
 * Database-backed implementation of the binding store (PostgreSQL or SQLite).
 *
 * The in-memory store is correct but single-process: two replicas would each
 * create their own sandbox for the same session. This one keeps the binding in
 * the shared database so any replica can pick up where another left off.
 *
 * @module @brain/dsh-e2b/store-pg
 */

import type Database from '@brain/dsh-database'
import type { Context } from '@deepseek-ai/cordis'
import type { BindingStore, ClaimResult, SandboxBinding, SandboxKey, SandboxScope } from './registry.ts'

/** One row as the database stores it. */
interface BindingRow {
  user_id: string
  workspace_id: string
  session_id: string
  scope: SandboxScope
  sandbox_id: string
  external_id: string
  endpoint: string
  workspace_root: string
  generation: string | number
  state: SandboxBinding['state']
  expires_at: Date | string
  last_used_at: Date | string
}

/** Durable bindings in the shared database. */
export class PgBindingStore implements BindingStore {
  constructor(
    private readonly ctx: Context,
    private readonly scope: SandboxScope,
  ) {}

  /** Resolve the shared pool on use, not at construction. */
  private get db(): Database {
    const db = this.ctx.get('db')
    if (db === undefined) {
      throw new Error('dsh_sandboxes: storeKind "postgres" requires the database plugin (ctx.db)')
    }
    return db
  }

  async get(key: SandboxKey): Promise<SandboxBinding | undefined> {
    const rows = await this.db.query<BindingRow>(
      `SELECT * FROM dsh_sandboxes
        WHERE user_id = $1 AND workspace_id = $2 AND session_id = $3`,
      [key.userId, key.workspaceId, key.sessionId],
    )
    const row = rows[0]
    return row === undefined ? undefined : toBinding(row)
  }

  async put(binding: SandboxBinding): Promise<void> {
    await this.db.query(
      `INSERT INTO dsh_sandboxes (
         user_id, workspace_id, session_id, scope, sandbox_id, external_id,
         endpoint, workspace_root, generation, state, expires_at, last_used_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (user_id, workspace_id, session_id) DO UPDATE SET
         scope = EXCLUDED.scope,
         sandbox_id = EXCLUDED.sandbox_id,
         external_id = EXCLUDED.external_id,
         endpoint = EXCLUDED.endpoint,
         workspace_root = EXCLUDED.workspace_root,
         generation = EXCLUDED.generation,
         state = EXCLUDED.state,
         expires_at = EXCLUDED.expires_at,
         last_used_at = EXCLUDED.last_used_at`,
      [
        binding.key.userId,
        binding.key.workspaceId,
        binding.key.sessionId,
        binding.scope,
        binding.sandboxId,
        binding.externalId,
        binding.endpoint,
        binding.workspaceRoot,
        binding.generation,
        binding.state,
        new Date(binding.expiresAt),
        new Date(binding.lastUsedAt),
      ],
    )
  }

  async delete(key: SandboxKey): Promise<void> {
    await this.db.query(
      'DELETE FROM dsh_sandboxes WHERE user_id = $1 AND workspace_id = $2 AND session_id = $3',
      [key.userId, key.workspaceId, key.sessionId],
    )
  }

  async list(): Promise<SandboxBinding[]> {
    const rows = await this.db.query<BindingRow>('SELECT * FROM dsh_sandboxes')
    return rows.map(toBinding)
  }

  /**
   * Bindings created under a granularity we no longer use.
   *
   * They can never be hit again by key, so they are reclaimed on the next sweep.
   * Without the `scope` column there would be no way to tell them apart from a
   * live binding of the current granularity.
   */
  /**
   * Claim creation for one key under a row lock.
   *
   * A ready row wins immediately. A live `creating` row belongs to another
   * replica, so the caller waits. An expired claim (the creator died mid-flight)
   * is taken over with a higher generation.
   */
  async claim(key: SandboxKey, claimId: string, leaseMs: number): Promise<ClaimResult> {
    const expiresAt = new Date(Date.now() + leaseMs).toISOString()
    return await this.db.transaction(async run => {
      const rows = await run<BindingRow>(
        `SELECT * FROM dsh_sandboxes
          WHERE user_id = $1 AND workspace_id = $2 AND session_id = $3
          FOR UPDATE`,
        [key.userId, key.workspaceId, key.sessionId],
      )
      const row = rows[0]
      if (row === undefined) {
        await run(
          `INSERT INTO dsh_sandboxes (
             user_id, workspace_id, session_id, scope, sandbox_id, external_id,
             endpoint, workspace_root, generation, state, expires_at, last_used_at
           ) VALUES ($1, $2, $3, $4, $5, '', '', '', 1, 'creating', $6, now())`,
          [key.userId, key.workspaceId, key.sessionId, this.scope, claimId, expiresAt],
        )
        return { status: 'claimed', generation: 1 }
      }
      if (row.state === 'ready') return { status: 'ready', binding: toBinding(row) }
      if (row.state === 'creating' && toMillis(row.expires_at) > Date.now()) return { status: 'busy' }

      const generation = Number(row.generation) + 1
      await run(
        `UPDATE dsh_sandboxes
            SET state = 'creating', sandbox_id = $4, external_id = '', endpoint = '',
                workspace_root = '', generation = $5,
                expires_at = $6,
                last_used_at = now()
          WHERE user_id = $1 AND workspace_id = $2 AND session_id = $3`,
        [key.userId, key.workspaceId, key.sessionId, claimId, generation, expiresAt],
      )
      return { status: 'claimed', generation }
    })
  }

  /** Delete a failed claim without touching a binding another replica owns. */
  async release(key: SandboxKey, claimId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM dsh_sandboxes
        WHERE user_id = $1 AND workspace_id = $2 AND session_id = $3
          AND state = 'creating' AND sandbox_id = $4`,
      [key.userId, key.workspaceId, key.sessionId, claimId],
    )
  }

  async stale(scope: SandboxScope): Promise<SandboxBinding[]> {
    const rows = await this.db.query<BindingRow>(
      'SELECT * FROM dsh_sandboxes WHERE scope <> $1',
      [scope],
    )
    return rows.map(toBinding)
  }
}

/** Convert one row into the shape the registry uses. */
function toBinding(row: BindingRow): SandboxBinding {
  return {
    key: {
      userId: row.user_id,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
    },
    scope: row.scope,
    sandboxId: row.sandbox_id,
    externalId: row.external_id,
    endpoint: row.endpoint,
    workspaceRoot: row.workspace_root,
    generation: Number(row.generation),
    state: row.state,
    expiresAt: toMillis(row.expires_at),
    lastUsedAt: toMillis(row.last_used_at),
  }
}

/** Accept both `Date` (pg default) and ISO text. */
function toMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}
