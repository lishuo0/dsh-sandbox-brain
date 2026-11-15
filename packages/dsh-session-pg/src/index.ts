/**
 * PostgreSQL session persistence.
 *
 * Implements the `SessionPersistence` seam so the loop, the API and the tools
 * need no changes: it replaces the shipped JSONL backend by row id.
 *
 * Two properties this backend must keep, in this order:
 *
 * 1. **One writer.** `create` and `open(…, 'write')` claim a row in
 *    `dsh_session_leases` whose expiry is renewed by a heartbeat. A crashed replica
 *    cannot release its own lease, so expiry is the only way back.
 * 2. **Append-only, contiguous.** `(session_id, seq)` is the primary key. A
 *    second writer fails on the constraint instead of corrupting the log.
 *
 * @module @brain/dsh-session-pg
 */

import { randomUUID } from 'node:crypto'
import type {} from '@brain/dsh-database'
import type { Context } from '@deepseek-ai/cordis'
import {
  SessionPersistence,
  SessionPersistenceRevision,
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  assertContiguous,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleReadResult,
  SessionHeader,
  SessionPersistenceSnapshot,
  SessionPersistenceCreateOptions,
  SessionPersistenceOpenOptions,
} from '@deepseek-ai/dsh-session-persistence'
import { SessionId, SessionLogOffset, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Session ids whose lease renewal did not come back.
 *
 * A missing row means the lease expired and another replica took it (or the
 * row was released). The live Agent must stop before it writes again.
 * @param attempted - ids this process tried to renew.
 * @param renewed - ids the UPDATE returned.
 * @returns attempted ids not in `renewed`.
 */
export function lostLeaseIds(attempted: readonly string[], renewed: ReadonlySet<string>): string[] {
  return attempted.filter(id => !renewed.has(id))
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The write lease moved to another replica; this process must stop the
     * live Agent so it cannot keep producing side effects it cannot persist.
     * @mode emit
     * @param sessionId - the session whose lease was lost.
     */
    'session/lease-lost'(sessionId: string): void
  }
}

/** Configuration. */
export interface Config {
  /** Lease lifetime. A crashed writer becomes reclaimable after this. */
  readonly leaseMs?: number
  /** Heartbeat period; defaults to a third of the lease. */
  readonly heartbeatMs?: number
  /** Batch window for live events, in milliseconds. */
  readonly liveBatchMs?: number
}

/** Where a stored record lives, used in refusal diagnostics. */
const LOCATION = { kind: 'postgres', path: 'dsh_session_events' } as const

/**
 * Whether an append may proceed under the lease this handle claimed.
 *
 * Both halves matter. Owner alone would still let a handle that lost a force
 * close keep writing because the row is still ours; generation alone would let
 * another replica's claim through if generations ever lined up.
 * @param held - the live lease row, if any.
 * @param instanceId - this process.
 * @param generation - the generation this handle claimed.
 * @returns true only when this exact handle still owns the log.
 */
export function leaseAllowsWrite(
  held: { readonly owner: string; readonly generation: string } | undefined,
  instanceId: string,
  generation: number,
): boolean {
  return held !== undefined && held.owner === instanceId && Number(held.generation) === generation
}

/** One open handle's mutable state. */
interface HandleState {
  cursor: number
  readonly inheritedEventCount: number
  /**
   * Lease generation this handle claimed.
   *
   * Writes are fenced by `owner + generation`, not owner alone: a force close
   * bumps the generation, so a stuck handle that later recovers cannot append
   * to a turn another writer already closed.
   */
  readonly generation: number
}

/**
 * PostgreSQL session store.
 *
 * Live events arrive through `session/event` and are written behind a short
 * batching window; `flush` is the durability barrier the loop waits on between
 * turns.
 */
export default class PgSessionPersistence extends SessionPersistence {
  static readonly inject = ['db']

  private readonly instanceId = randomUUID()
  private readonly handles = new Set<PgHandle>()
  private readonly writers = new Map<string, PgHandle>()
  private readonly leaseMs: number
  private readonly heartbeatMs: number
  readonly liveBatchMs: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.leaseMs = config.leaseMs ?? 30_000
    this.heartbeatMs = config.heartbeatMs ?? Math.max(1_000, Math.floor(this.leaseMs / 3))
    this.liveBatchMs = config.liveBatchMs ?? 200

    // Live write-behind: the loop emits this per committed event and never waits.
    ctx.on('session/event', (session, event) => {
      const writer = this.writers.get(String(session.id))
      if (writer === undefined) return
      writer.enqueueLive(event, error => {
        ctx.logger?.warn?.(`session-pg: background write for "${String(session.id)}" failed: ${describe(error)}`)
      })
    })
    // Flush is the durability barrier before the next turn claims input.
    ctx.on('session/flush', session => {
      const writer = this.writers.get(String(session.id))
      if (writer === undefined) return undefined
      return writer.drain()
    })
    ctx.on('session/disposed', session => {
      const writer = this.writers.get(String(session.id))
      if (writer === undefined) return
      void writer.close().catch(error => {
        ctx.logger?.warn?.(`session-pg: final drain for "${String(session.id)}" failed: ${describe(error)}`)
      })
    })

    ctx.effect(() => {
      const timer = setInterval(() => {
        void this.renewLeases().catch(error => {
          ctx.logger?.warn?.(`session-pg: lease renewal failed: ${describe(error)}`)
        })
      }, this.heartbeatMs)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'session-pg: lease heartbeat')

    ctx.effect(() => async () => {
      const errors: unknown[] = []
      for (const handle of [...this.handles]) {
        try {
          await handle.close()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'session-pg: dispose failed')
    }, 'session-pg: open handles')
  }

  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const snapshot = materializeCreateHeader(header)
    const id = String(snapshot.id)
    const inheritedEventCount = options?.inheritedEventCount ?? 0

    const generation = await this.ctx.db.transaction(async run => {
      const existing = await run<{ session_id: string }>(
        'SELECT session_id FROM dsh_session_headers WHERE session_id = $1',
        [id],
      )
      if (existing.length > 0) throw new SessionAlreadyExistsError(snapshot.id)
      await run(
        `INSERT INTO dsh_session_headers (session_id, header, inherited_count, next_seq, revision)
         VALUES ($1, $2::jsonb, $3, 0, 1)`,
        [id, JSON.stringify(snapshot), inheritedEventCount],
      )
      return await this.claimLease(run, id)
    })

    const handle = new PgHandle(this, snapshot.id, snapshot, 'write', {
      cursor: 0,
      inheritedEventCount,
      generation,
    })
    return this.adopt(handle)
  }

  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const key = String(id)
    const rows = await this.ctx.db.query<{ header: SessionHeader; inherited_count: string; next_seq: string }>(
      'SELECT header, inherited_count, next_seq FROM dsh_session_headers WHERE session_id = $1',
      [key],
    )
    const row = rows[0]
    if (row === undefined) throw new SessionPersistenceNotFoundError(id)
    const inheritedEventCount = Number(row.inherited_count)
    const cursor = Number(row.next_seq)

    if (access === 'read') {
      return this.adopt(new PgHandle(this, id, row.header, 'read', { cursor, inheritedEventCount, generation: 0 }))
    }

    const generation = await this.ctx.db.transaction(async run => {
      return await this.claimLease(run, key)
    }).catch(error => {
      if (error instanceof SessionAlreadyOwnedError) throw error
      throw error
    })

    return this.adopt(new PgHandle(this, id, row.header, 'write', { cursor, inheritedEventCount, generation }))
  }

  /**
   * Close an interrupted turn in the log even when its writer is stuck.
   *
   * The live Agent may be waiting on a tool that never returns; waiting for it
   * to reach quiescence is exactly what leaves a session "running" forever.
   * Instead this reads the log, synthesizes the missing `tool/result`,
   * `step/end` and `turn/end` events, and appends them under a *new* lease
   * generation. The old writer's next append then fails the fence, so recovery
   * cannot produce a second, conflicting turn end.
   * @param id - session whose open turn must be closed.
   * @returns whether anything was appended, and how many events it took.
   */
  async forceCloseTurn(id: SessionId): Promise<{ closed: boolean; events: number }> {
    const key = String(id)
    // A no-op force close (the idempotent retry) must not touch the lease:
    // stealing it would block the next resume until it expires.
    const initial = await this.forceCloseSnapshot(key, id)
    if (initial === undefined || initial.closers.length === 0) return { closed: false, events: 0 }

    // Steal the lease BEFORE re-reading the cursor. The stuck writer checks the
    // fence at the start of its transaction; once the generation moves, its
    // next append is refused. Keeping the stolen generation while another
    // writer's already-started transaction lands is handled below by retrying.
    let generation = await this.ctx.db.transaction(async run => {
      return await this.stealLease(run, key)
    })
    try {
      for (let attempt = 0; ; attempt += 1) {
        // Give an append that already passed the old fence time to commit.
        await settle()

        const snapshot = await this.forceCloseSnapshot(key, id)
        if (snapshot === undefined || snapshot.closers.length === 0) {
          return { closed: false, events: 0 }
        }

        const handle = this.adopt(new PgHandle(this, id, snapshot.header, 'write', {
          cursor: snapshot.cursor,
          inheritedEventCount: snapshot.inheritedEventCount,
          generation,
        }))
        this.ctx.logger?.warn?.(
          `session-pg: force-closing turn for "${key}" with ${snapshot.closers.length} event(s) (generation ${generation})`,
        )
        try {
          await handle.append(snapshot.closers)
          await handle.flush()
          return { closed: true, events: snapshot.closers.length }
        } catch (error) {
          if (!isLeaseConflict(error) || attempt >= FORCE_CLOSE_ATTEMPTS) throw error
          this.ctx.logger?.warn?.(
            `session-pg: force close for "${key}" lost a write race, retrying (${attempt + 1})`,
          )
          generation = await this.ctx.db.transaction(async run => {
            return await this.stealLease(run, key)
          })
        } finally {
          await handle.close().catch(() => undefined)
        }
      }
    } catch (error) {
      // Leave no orphan lease behind when the force close itself fails.
      await this.releaseLease(key, generation)
      throw error
    }
  }

  /** Read a session's tail and compute the events an interrupted turn needs. */
  private async forceCloseSnapshot(key: string, id: SessionId): Promise<{
    header: SessionHeader
    inheritedEventCount: number
    cursor: number
    closers: SessionEvent[]
  } | undefined> {
    const rows = await this.ctx.db.query<{
      header: SessionHeader
      inherited_count: string
      next_seq: string
    }>(
      'SELECT header, inherited_count, next_seq FROM dsh_session_headers WHERE session_id = $1',
      [key],
    )
    const row = rows[0]
    if (row === undefined) return undefined
    const cursor = Number(row.next_seq)
    const events = cursor === 0 ? [] : await this.readEvents(key, row.header, 0, cursor)
    return {
      header: row.header,
      inheritedEventCount: Number(row.inherited_count),
      cursor,
      closers: interruptedTurnClosers(events),
    }
  }

  async flush(): Promise<void> {
    const errors: unknown[] = []
    for (const writer of [...this.writers.values()]) {
      try {
        await writer.drain()
      } catch (error) {
        if (error instanceof SessionHandleClosedError) continue
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'session-pg: flush failed')
  }

  async stat(id: SessionId): Promise<SessionPersistenceSnapshot | undefined> {
    const rows = await this.ctx.db.query<{ header: SessionHeader; next_seq: string; revision: string }>(
      'SELECT header, next_seq, revision FROM dsh_session_headers WHERE session_id = $1',
      [String(id)],
    )
    const row = rows[0]
    if (row === undefined) return undefined
    return {
      header: row.header,
      revision: SessionPersistenceRevision(`postgres:${String(id)}:${row.revision}`),
      eventCount: Number(row.next_seq),
    }
  }

  async list(): Promise<readonly SessionPersistenceSnapshot[]> {
    const rows = await this.ctx.db.query<{ session_id: string; header: SessionHeader; next_seq: string; revision: string }>(
      'SELECT session_id, header, next_seq, revision FROM dsh_session_headers',
    )
    return rows.map(row => ({
      header: row.header,
      revision: SessionPersistenceRevision(`postgres:${row.session_id}:${row.revision}`),
      eventCount: Number(row.next_seq),
    }))
  }

  /** Register one open handle and, when writable, make it the live target. */
  adopt(handle: PgHandle): PgHandle {
    this.handles.add(handle)
    if (handle.access === 'write') this.writers.set(handle.id, handle)
    return handle
  }

  /** Drop one handle and its live routing. */
  release(handle: PgHandle): void {
    this.handles.delete(handle)
    if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id)
  }

  /**
   * Read a contiguous slice of one session's log.
   * @param id - session.
   * @param header - header used to validate stored events.
   * @param from - first seq to return.
   * @param count - maximum number of events.
   * @returns the validated events, in seq order.
   */
  async readEvents(id: string, header: SessionHeader, from: number, count: number): Promise<SessionEvent[]> {
    const rows = await this.ctx.db.query<{ event: SessionEvent }>(
      `SELECT event FROM dsh_session_events
        WHERE session_id = $1 AND seq >= $2
        ORDER BY seq
        LIMIT $3`,
      [id, from, count],
    )
    return validateStoredEvents(header, rows.map(row => row.event), LOCATION) as SessionEvent[]
  }

  /**
   * Append one already-materialized batch and advance the session's cursor.
   * @param id - session.
   * @param cursor - the seq the batch must start at.
   * @param batch - events to append.
   * @param generation - lease generation the writing handle claimed.
   */
  async appendBatch(
    id: string,
    cursor: number,
    batch: readonly SessionEvent[],
    generation: number,
  ): Promise<void> {
    if (batch.length === 0) return
    try {
      await this.ctx.db.transaction(async run => {
        const lease = await run<{ owner: string; generation: string }>(
          'SELECT owner, generation FROM dsh_session_leases WHERE session_id = $1 AND expires_at > now()',
          [id],
        )
        if (!leaseAllowsWrite(lease[0], this.instanceId, generation)) {
          // The lease moved on — expired and stolen, closed elsewhere, or force
          // closed with a newer generation. Stop writing rather than racing the
          // writer that now owns this log.
          throw new SessionAlreadyOwnedError(id as never)
        }
        for (const event of batch) {
          await run(
            'INSERT INTO dsh_session_events (session_id, seq, event) VALUES ($1, $2, $3::jsonb)',
            [id, event.seq, JSON.stringify(event)],
          )
        }
        await run(
          'UPDATE dsh_session_headers SET next_seq = $2, revision = revision + 1 WHERE session_id = $1',
          [id, cursor + batch.length],
        )
      })
    } catch (error) {
      // A duplicate (session_id, seq) means another writer got there first.
      if (isUniqueViolation(error)) throw new SessionAlreadyOwnedError(id as never)
      throw error
    }
  }

  /**
   * Release one session's lease. Missing rows are not an error.
   *
   * The generation is part of the key: an old handle closing after a force
   * close must not delete the lease the force-close writer (or a later resume)
   * owns.
   */
  async releaseLease(id: string, generation: number): Promise<void> {
    await this.ctx.db.query(
      'DELETE FROM dsh_session_leases WHERE session_id = $1 AND owner = $2 AND generation = $3',
      [id, this.instanceId, generation],
    ).catch(() => undefined)
  }

  /** Claim the write lease inside an existing transaction. */
  private async claimLease(
    run: <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: readonly unknown[]) => Promise<R[]>,
    id: string,
  ): Promise<number> {
    const claimed = await run<{ generation: string }>(
      `INSERT INTO dsh_session_leases (session_id, owner, generation, expires_at)
       VALUES ($1, $2, 1, now() + ($3 || ' milliseconds')::interval)
       ON CONFLICT (session_id) DO UPDATE
         SET owner = EXCLUDED.owner,
             generation = dsh_session_leases.generation + 1,
             expires_at = EXCLUDED.expires_at
       WHERE dsh_session_leases.expires_at < now()
       RETURNING generation`,
      [id, this.instanceId, String(this.leaseMs)],
    )
    if (claimed.length === 0) throw new SessionAlreadyOwnedError(id as never)
    return Number(claimed[0]?.generation ?? 1)
  }

  /**
   * Take the write lease away from its current holder, live or not.
   *
   * Only force close uses this. Because the generation increases, the previous
   * holder keeps a stale generation and every later append it attempts fails
   * the fence — which is the point: its turn was already closed for it.
   */
  private async stealLease(
    run: <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: readonly unknown[]) => Promise<R[]>,
    id: string,
  ): Promise<number> {
    const claimed = await run<{ generation: string }>(
      `INSERT INTO dsh_session_leases (session_id, owner, generation, expires_at)
       VALUES ($1, $2, 1, now() + ($3 || ' milliseconds')::interval)
       ON CONFLICT (session_id) DO UPDATE
         SET owner = EXCLUDED.owner,
             generation = dsh_session_leases.generation + 1,
             expires_at = EXCLUDED.expires_at
       RETURNING generation`,
      [id, this.instanceId, String(this.leaseMs)],
    )
    return Number(claimed[0]?.generation ?? 1)
  }

  /** Renew every lease this process holds. */
  private async renewLeases(): Promise<void> {
    const ids = [...this.writers.keys()]
    if (ids.length === 0) return
    const renewed = await this.ctx.db.query<{ session_id: string }>(
      `UPDATE dsh_session_leases
          SET expires_at = now() + ($3 || ' milliseconds')::interval
        WHERE session_id = ANY($1::text[]) AND owner = $2
        RETURNING session_id`,
      [ids, this.instanceId, String(this.leaseMs)],
    )
    const kept = new Set(renewed.map(row => row.session_id))
    for (const id of lostLeaseIds(ids, kept)) {
      const handle = this.writers.get(id)
      if (handle === undefined) continue
      // Stop renewing and writing before the listener is told: the turn is over
      // for this replica, and any further append would lose the fence anyway.
      this.writers.delete(id)
      this.ctx.emit('session/lease-lost', id)
      void handle.close().catch(error => {
        this.ctx.logger?.warn?.(`session-pg: close after lease loss "${id}" failed: ${describe(error)}`)
      })
    }
  }
}

/** One open channel onto a stored session. */
class PgHandle implements SessionHandle {
  private chain: Promise<unknown> = Promise.resolve()
  private buffered: SessionEvent[] = []
  private batchTimer: NodeJS.Timeout | undefined
  private closing: Promise<void> | undefined
  private drainPaused = false
  private draining: Promise<void> | undefined
  private observed: number

  constructor(
    private readonly backend: PgSessionPersistence,
    readonly id: SessionId,
    readonly header: SessionHeader,
    readonly access: SessionAccess,
    private readonly state: HandleState,
  ) {
    this.observed = state.cursor
  }

  get inheritedEventCount(): SessionLogOffset {
    return SessionLogOffset(stateOf(this).inheritedEventCount)
  }

  async read(offset = 0, length = Number.MAX_SAFE_INTEGER): Promise<SessionHandleReadResult> {
    this.assertOpen('read')
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError(`read offset must be a non-negative safe integer, got ${String(offset)}`)
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError(`read length must be a non-negative safe integer, got ${String(length)}`)
    }
    const events = await this.backend.readEvents(String(this.id), this.header, offset, length)
    if (events.length < this.observed - offset) {
      throw new Error(`session "${this.id}": stored log shrank below a previously observed prefix`)
    }
    this.observed = Math.max(this.observed, offset + events.length)
    return { eventState: 'shared-frozen', events } as SessionHandleReadResult
  }

  append(events: readonly SessionEvent[]): Promise<void> {
    this.assertOpen('append')
    const batch = materializeAppendBatch(events)
    return this.enqueue(async () => {
      await this.persist(batch)
    })
  }

  flush(): Promise<void> {
    this.assertOpen('flush')
    return this.enqueue(async () => {
      if (this.access !== 'write') throw new SessionReadOnlyError(this.id as never, 'flush')
      await this.drain()
    })
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      let failure: unknown
      for (;;) {
        try {
          await this.drain()
        } catch (error) {
          failure = error
          break
        }
        await this.chain
        if (this.buffered.length === 0) break
      }
      await this.chain
      if (this.access === 'write') await this.backend.releaseLease(String(this.id), stateOf(this).generation)
      this.backend.release(this)
      if (failure !== undefined) throw failure
    })()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  /** Buffer one live event and schedule a batch write. */
  enqueueLive(event: SessionEvent, reportFailure: (error: unknown) => void): void {
    this.buffered.push(structuredClone(event))
    if (this.batchTimer !== undefined || this.drainPaused) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined
      void this.drain().catch(reportFailure)
    }, this.backend.liveBatchMs)
    this.batchTimer.unref?.()
  }

  /** Write everything buffered so far. Shared by flush, close and the timer. */
  drain(): Promise<void> {
    return this.draining ??= this.drainBuffered().finally(() => {
      this.draining = undefined
    })
  }

  private async drainBuffered(): Promise<void> {
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer)
      this.batchTimer = undefined
    }
    this.drainPaused = false
    while (this.buffered.length > 0) {
      await this.enqueue(async () => {
        const batch = this.buffered.splice(0)
        try {
          await this.persist(materializeAppendBatch(batch))
        } catch (error) {
          // Keep the batch: ordering must survive a failed write.
          this.buffered = batch.concat(this.buffered)
          this.drainPaused = true
          throw error
        }
      })
    }
  }

  private async persist(batch: readonly SessionEvent[]): Promise<void> {
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id as never, 'append')
    if (batch.length === 0) return
    assertContiguous(this.id as never, batch, this.state.cursor)
    await this.backend.appendBatch(this.id, this.state.cursor, batch, this.state.generation)
    this.state.cursor += batch.length
    this.observed = this.state.cursor
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation)
    this.chain = next.catch(() => undefined)
    return next
  }

  private assertOpen(operation: string): void {
    if (this.closing !== undefined) throw new SessionHandleClosedError(this.id as never, operation)
  }
}

/** Read the handle's state without exposing it. */
function stateOf(handle: PgHandle): HandleState {
  return (handle as unknown as { state: HandleState }).state
}

/** PostgreSQL unique-violation code. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
}

/** Retries after a force close loses a write race with the fenced-out writer. */
const FORCE_CLOSE_ATTEMPTS = 2

/** How long a force close lets an in-flight append commit before it writes. */
const FORCE_CLOSE_SETTLE_MS = 150

/** Sleep for the settle window. */
function settle(): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, FORCE_CLOSE_SETTLE_MS) })
}

/** Whether a failed force-close append lost the same-log write race. */
function isLeaseConflict(error: unknown): boolean {
  return isUniqueViolation(error) || error instanceof SessionAlreadyOwnedError
}

/** Readable one-liner for logs. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
