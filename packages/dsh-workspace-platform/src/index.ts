/**
 * `ctx.workspaceRegistry` as a projection of the platform's workspaces.
 *
 * The platform database is the single authority for workspace identity,
 * ownership, ordering and lifecycle. The brain knows no tenants and never
 * touches the host filesystem, so this service replaces the upstream
 * `@deepseek-ai/dsh-workspace` registry with a read projection:
 *
 * - `dsh_workspaces` supplies id and title; the sandbox path is the fixed
 *   mount point `/desk` because every workspace owns its own sandbox. Archived
 *   workspaces are not listed.
 * - `dsh_sessions.workspace_id` supplies membership; `sort_order` supplies the
 *   member's manual order and `pinned_at` the pin order, so no display state
 *   lives in the brain process where every tenant would share it.
 * - `status()` is always `'ok'`: directories live inside the sandbox, never
 *   on the brain host.
 *
 * Mutations that survive in the platform database (rename, archive, ordering,
 * pinning) are written through `ctx.db`. Workspace creation is refused: only
 * the platform decides when a workspace exists.
 *
 * @module @brain/dsh-workspace-platform
 */

import type {} from '@brain/dsh-database'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  WorkspaceActiveSessionError,
  WorkspaceArchivedSessionPinError,
  WorkspaceId,
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
  WorkspaceUnknownSessionError,
  type ArchiveSessionOptions,
  type SessionActivity,
  type Workspace,
} from '@deepseek-ai/dsh-workspace'

interface WorkspaceRow {
  readonly id: string
  readonly name: string
  readonly created_at: unknown
  readonly last_active_at: unknown
}

/** Every sandbox mounts its one workspace volume here; platform and brain agree. */
const WORKSPACE_PATH = '/desk'

/** Display order the platform persists; `sort_order` 0 means "never dragged". */
const WORKSPACE_ORDER = 'sort_order ASC, is_default DESC, last_active_at DESC, created_at DESC, id'
const SESSION_ORDER = 'sort_order ASC, created_at DESC, id'

interface SessionRow {
  readonly id: string
  readonly workspace_id: string
  readonly created_at: unknown
}

/** One workspace record as this projection holds it. */
interface Record {
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly SessionId[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** Timestamp → ISO string; SQLite hands text, Postgres hands Date. */
function iso(value: unknown, fallback: string): string {
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

function nowIso(): string {
  return new Date().toISOString()
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** Move `id` before `beforeId`; no anchor moves it to the end. */
function movedBefore(ids: readonly string[], id: string, beforeId?: string): string[] {
  if (!ids.includes(id)) return [...ids]
  if (beforeId !== undefined && (!ids.includes(beforeId) || beforeId === id)) return [...ids]
  const without = ids.filter((candidate) => candidate !== id)
  const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
  return [...without.slice(0, at), id, ...without.slice(at)]
}

/** One projected workspace. */
class ProjectedWorkspace implements Workspace {
  constructor(
    private readonly host: WorkspaceRegistryProjection,
    readonly id: WorkspaceId,
    private record: Record,
  ) {}

  get path(): string {
    return this.record.path
  }

  get title(): string {
    return this.record.title
  }

  get createdAt(): string {
    return this.record.createdAt
  }

  get updatedAt(): string {
    return this.record.updatedAt
  }

  get sessionIds(): readonly SessionId[] {
    return this.record.sessionIds
  }

  async setTitle(title: string): Promise<void> {
    this.record = await this.host.setTitle(this.id, this.record, title)
  }

  async attachSession(sessionId: SessionId): Promise<void> {
    this.record = await this.host.attachSession(this.id, this.record, sessionId)
  }

  async insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void> {
    this.record = await this.host.insertSessionBefore(this.id, this.record, sessionId, beforeSessionId)
  }

  async detachSession(sessionId: SessionId): Promise<void> {
    this.record = await this.host.detachSession(this.id, this.record, sessionId)
  }

  async status(): Promise<'ok' | 'missing-dir'> {
    // The directory lives inside the workspace volume; the brain host has no
    // filesystem to check, and a false "missing" would hide a live workspace.
    return 'ok'
  }
}

/**
 * The projected registry.
 *
 * `list()` and `get()` are synchronous exactly like the upstream registry the
 * workspace controller expects; `refresh()` re-reads the platform tables and
 * is called by the platform after it mutates a workspace.
 */
export default class WorkspaceRegistryProjection extends Service {
  static readonly inject = ['db']

  private entities = new Map<string, ProjectedWorkspace>()
  private order: WorkspaceId[] = []
  private archived = new Set<string>()
  private pinned: string[] = []
  /** Sessions attached before the platform persisted their `dsh_sessions` row. */
  private readonly attached = new Map<string, Set<string>>()
  private refreshTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  protected async [Service.init](): Promise<void> {
    await this.refresh()
  }

  /** Re-read every workspace and its session membership from the platform. */
  refresh(): Promise<void> {
    const run = this.refreshTail.then(() => this.hydrate())
    this.refreshTail = run.then(() => undefined, () => undefined)
    return run
  }

  get(id: WorkspaceId | string): Workspace | undefined {
    return this.entities.get(String(id))
  }

  list(): Workspace[] {
    const workspaces: Workspace[] = []
    for (const id of this.order) {
      const workspace = this.entities.get(String(id))
      if (workspace !== undefined) workspaces.push(workspace)
    }
    return workspaces
  }

  /**
   * Creation belongs to the platform: it alone decides identity, ownership,
   * sandbox layout and the workspace volume. A request that reaches here lost
   * its platform interception and must fail loudly instead of inventing a row.
   */
  create(): Promise<Workspace> {
    return Promise.reject(new Error('workspace creation is owned by the platform'))
  }

  /** First-use default creation is the platform's job (`ensureDefaultWorkspace`). */
  initializeDefault(): Promise<undefined> {
    return Promise.resolve(undefined)
  }

  /** The platform deletes workspace rows; this registry only projects them. */
  delete(): Promise<boolean> {
    return Promise.resolve(false)
  }

  async insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]> {
    if (!this.order.includes(id)) throw new WorkspaceOrderInvalidError(id)
    if (beforeId !== undefined && !this.order.includes(beforeId)) {
      throw new WorkspaceOrderInvalidError(beforeId)
    }
    if (beforeId === id) return this.order
    // 只重排这块工作区所属成员自己的行；别的成员的行一个都不动。
    const owner = await this.ctx.db.query<{ user_id: string }>(
      `SELECT user_id FROM dsh_workspaces WHERE id = $1`,
      [String(id)],
    )
    const userId = owner[0]?.user_id
    if (userId === undefined) throw new WorkspaceOrderInvalidError(id)
    const rows = await this.ctx.db.query<{ id: string }>(
      `SELECT id FROM dsh_workspaces
        WHERE user_id = $1 AND state <> 'archived'
        ORDER BY ${WORKSPACE_ORDER}`,
      [userId],
    )
    const next = movedBefore(rows.map((row) => row.id), String(id), beforeId === undefined ? undefined : String(beforeId))
    await this.saveWorkspaceOrder(userId, next)
    await this.refresh()
    return this.order
  }

  get archivedSessionIds(): readonly SessionId[] {
    return [...this.archived] as SessionId[]
  }

  async archiveSession(sessionId: SessionId, options: ArchiveSessionOptions = {}): Promise<void> {
    if (this.archived.has(sessionId)) return
    if (!(await this.sessionKnown(sessionId))) throw new WorkspaceUnknownSessionError(sessionId, 'archive')
    if (options.stopActivity !== true) {
      const activity: readonly SessionActivity[] = await this.ctx.waterfall(
        'workspace/session-activity',
        { sessionId },
        () => Promise.resolve([]),
      )
      if (activity.length > 0) throw new WorkspaceActiveSessionError(sessionId, activity)
    }
    this.archived.add(sessionId)
    this.pinned = this.pinned.filter((id) => id !== sessionId)
    await this.ctx.db.query(
      `UPDATE dsh_sessions SET status = 'archived', pinned_at = NULL WHERE id = $1`,
      [sessionId],
    )
    if (options.stopActivity === true) await this.stopSessionActivity(sessionId)
    try {
      await this.ctx.parallel('workspace/session-archived', { sessionId })
    } catch (error) {
      this.ctx.logger?.warn?.(`workspace: archive follow-up for '${sessionId}' failed: ${String(error)}`)
    }
  }

  async unarchiveSession(sessionId: SessionId): Promise<void> {
    if (!this.archived.has(sessionId)) return
    await this.ctx.parallel('workspace/session-unarchiving', { sessionId })
    this.archived.delete(sessionId)
    await this.ctx.db.query(`UPDATE dsh_sessions SET status = 'active' WHERE id = $1`, [sessionId])
  }

  get pinnedSessionIds(): readonly SessionId[] {
    return this.pinned as SessionId[]
  }

  async pinSession(sessionId: SessionId): Promise<void> {
    if (this.pinned.includes(sessionId)) return
    if (this.archived.has(sessionId)) throw new WorkspaceArchivedSessionPinError(sessionId)
    if (!(await this.sessionKnown(sessionId))) throw new WorkspaceUnknownSessionError(sessionId, 'pin')
    await this.ctx.db.query(`UPDATE dsh_sessions SET pinned_at = $2 WHERE id = $1`, [sessionId, nowIso()])
    this.pinned = [sessionId, ...this.pinned]
  }

  async unpinSession(sessionId: SessionId): Promise<void> {
    this.pinned = this.pinned.filter((id) => id !== sessionId)
    await this.ctx.db.query(`UPDATE dsh_sessions SET pinned_at = NULL WHERE id = $1`, [sessionId])
  }

  async resolveByPath(path: string): Promise<Workspace | undefined> {
    const canonical = path.replace(/\/+$/, '') || '/'
    for (const workspace of this.entities.values()) {
      if (workspace.path === canonical) return workspace
    }
    return undefined
  }

  // ── Entity write paths ────────────────────────────────────────────────────

  async setTitle(id: WorkspaceId, record: Record, title: string): Promise<Record> {
    await this.ctx.db.query(`UPDATE dsh_workspaces SET name = $2 WHERE id = $1`, [id, title])
    return { ...record, title, updatedAt: nowIso() }
  }

  async attachSession(id: WorkspaceId, record: Record, sessionId: SessionId): Promise<Record> {
    if (!record.sessionIds.includes(sessionId)) {
      // The platform inserts `dsh_sessions` after the create response; the
      // update may legitimately touch no row. Membership is kept here until
      // the row appears.
      await this.ctx.db.query(
        `UPDATE dsh_sessions SET workspace_id = $2 WHERE id = $1 AND workspace_id IS NULL`,
        [sessionId, String(id)],
      )
      this.rememberAttached(String(id), sessionId)
    }
    const sessionIds = record.sessionIds.includes(sessionId)
      ? record.sessionIds
      : [sessionId, ...record.sessionIds]
    return { ...record, sessionIds, updatedAt: nowIso() }
  }

  async detachSession(id: WorkspaceId, record: Record, sessionId: SessionId): Promise<Record> {
    this.attached.get(String(id))?.delete(sessionId)
    await this.ctx.db.query(
      `UPDATE dsh_sessions SET workspace_id = NULL WHERE id = $1 AND workspace_id = $2`,
      [sessionId, String(id)],
    )
    return {
      ...record,
      sessionIds: record.sessionIds.filter((id) => id !== sessionId),
      updatedAt: nowIso(),
    }
  }

  async insertSessionBefore(
    workspaceId: WorkspaceId,
    record: Record,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<Record> {
    if (!record.sessionIds.includes(sessionId)) {
      throw new WorkspaceMoveInvalidError(`cannot move session '${sessionId}' in workspace '${record.path}': the session is not accounted`)
    }
    if (beforeSessionId !== undefined && !record.sessionIds.includes(beforeSessionId)) {
      throw new WorkspaceMoveInvalidError(`cannot move session '${sessionId}' before '${beforeSessionId}' in workspace '${record.path}': the anchor session is not accounted`)
    }
    if (beforeSessionId === sessionId) return record
    const sessionIds = movedBefore(
      record.sessionIds,
      String(sessionId),
      beforeSessionId === undefined ? undefined : String(beforeSessionId),
    ) as SessionId[]
    if (sameIds(sessionIds, record.sessionIds)) return record
    // 顺序落在会话行上，只写这块工作区里的会话；pending（平台还没落库）的
    // 会话没有行可写，下一次 refresh 会按数据库里的顺序重新对齐。
    await this.ctx.db.transaction(async (run) => {
      for (const [index, id] of sessionIds.entries()) {
        await run(
          `UPDATE dsh_sessions SET sort_order = $2 WHERE id = $1 AND workspace_id = $3`,
          [String(id), index + 1, String(workspaceId)],
        )
      }
    })
    return { ...record, sessionIds, updatedAt: nowIso() }
  }

  // ── Hydration ─────────────────────────────────────────────────────────────

  private async hydrate(): Promise<void> {
    const [workspaces, sessions, archived, pinned] = await Promise.all([
      this.ctx.db.query<WorkspaceRow>(
        `SELECT id, name, created_at, last_active_at
           FROM dsh_workspaces
          WHERE state <> 'archived'
          ORDER BY ${WORKSPACE_ORDER}`,
      ),
      this.ctx.db.query<SessionRow>(
        `SELECT id, workspace_id, created_at
           FROM dsh_sessions
          WHERE workspace_id IS NOT NULL AND status = 'active'
          ORDER BY ${SESSION_ORDER}`,
      ),
      this.ctx.db.query<{ id: string }>(`SELECT id FROM dsh_sessions WHERE status <> 'active'`),
      this.ctx.db.query<{ id: string }>(
        `SELECT id FROM dsh_sessions WHERE pinned_at IS NOT NULL ORDER BY pinned_at DESC, id DESC`,
      ),
    ])
    this.archived = new Set(archived.map((row) => row.id))
    this.pinned = pinned.map((row) => row.id)

    const members = new Map<string, SessionId[]>()
    for (const row of sessions) {
      const list = members.get(row.workspace_id) ?? []
      list.push(row.id as SessionId)
      members.set(row.workspace_id, list)
    }

    const entities = new Map<string, ProjectedWorkspace>()
    const order: WorkspaceId[] = []
    for (const row of workspaces) {
      const persisted = members.get(row.id) ?? []
      const pending = this.attached.get(row.id)
      const sessionIds = pending === undefined
        ? persisted
        : [...persisted, ...[...pending].filter((id) => !persisted.includes(id as SessionId)) as SessionId[]]
      const record: Record = {
        path: WORKSPACE_PATH,
        title: row.name,
        sessionIds,
        createdAt: iso(row.created_at, nowIso()),
        updatedAt: iso(row.last_active_at, nowIso()),
      }
      const id = WorkspaceId(row.id)
      entities.set(row.id, new ProjectedWorkspace(this, id, record))
      order.push(id)
    }

    this.entities = entities
    this.order = order
  }

  private async saveWorkspaceOrder(userId: string, ids: readonly string[]): Promise<void> {
    await this.ctx.db.transaction(async (run) => {
      for (const [index, id] of ids.entries()) {
        await run(
          `UPDATE dsh_workspaces SET sort_order = $2 WHERE id = $1 AND user_id = $3`,
          [id, index + 1, userId],
        )
      }
    })
  }

  private rememberAttached(workspaceId: string, sessionId: string): void {
    const set = this.attached.get(workspaceId) ?? new Set<string>()
    set.add(sessionId)
    this.attached.set(workspaceId, set)
  }

  private async sessionKnown(sessionId: string): Promise<boolean> {
    const sessions = this.ctx.get('sessions') as { get(id: string): unknown } | undefined
    if (sessions?.get(sessionId) !== undefined) return true
    const rows = await this.ctx.db.query<{ id: string }>(
      `SELECT id FROM dsh_sessions WHERE id = $1`,
      [sessionId],
    )
    return rows.length > 0
  }

  private async stopSessionActivity(sessionId: SessionId): Promise<void> {
    try {
      await this.ctx.parallel('workspace/session-stop', { sessionId })
    } catch (error) {
      const failures = error instanceof AggregateError ? error.errors : [error]
      for (const failure of failures) {
        this.ctx.logger?.warn?.(`workspace: stopping session '${sessionId}' for archive failed: ${String(failure)}`)
      }
    }
  }
}

export { ProjectedWorkspace }
