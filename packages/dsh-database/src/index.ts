/**
 * One PostgreSQL pool for the whole process.
 *
 * Three consumers share it — the session backend, the sandbox binding store and
 * the session-directory lookup. Configuring the same connection string three
 * times would mean three pools, three sets of timeouts and three places to fix.
 *
 * @module @brain/dsh-database
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import pg from 'pg'

/** Configuration. */
export interface Config {
  /** `postgres://user:pass@host:port/db?sslmode=require` */
  readonly url: string
  /** Pool size. Total connections ≈ replicas × this, plus the platform's own pool. */
  readonly maxConnections?: number
  /** Statement timeout in milliseconds; 0 disables. */
  readonly statementTimeoutMs?: number
  /** How long to wait for a free connection before failing. */
  readonly acquireTimeoutMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The shared pool. Every persistence consumer injects it. */
    db: Database
  }
}

/** A row returned by a query. */
export type Row = Record<string, unknown>

/**
 * Shared PostgreSQL pool.
 *
 * Queries never take a connection explicitly: `query` and `transaction` own
 * their checkout so a caller cannot leak one. Code that needs a session-scoped
 * sequence (an advisory lock, for instance) uses `transaction`.
 */
export default class Database extends Service {
  private readonly pool: pg.Pool
  private closed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'db')
    if (typeof config.url !== 'string' || config.url === '') {
      throw new Error('database: url is required')
    }
    this.pool = new pg.Pool({
      connectionString: config.url,
      max: config.maxConnections ?? 10,
      connectionTimeoutMillis: config.acquireTimeoutMs ?? 10_000,
      // An idle client that the server closed should be replaced quietly.
      idleTimeoutMillis: 30_000,
      ...(config.statementTimeoutMs === undefined || config.statementTimeoutMs === 0
        ? {}
        : { statement_timeout: config.statementTimeoutMs }),
    })
    this.pool.on('error', error => {
      // A pool-level error is a broken idle client; the pool discards it. Log it
      // and keep serving, otherwise one network blip would look like a crash.
      ctx.logger?.warn?.(`database: idle client error: ${error.message}`)
    })

    ctx.effect(() => () => this.close(), 'database: pool')
  }

  /**
   * Run one statement.
   * @param text - SQL with `$1`, `$2`, … placeholders.
   * @param params - positional parameters.
   * @returns the result rows.
   * @throws when the pool is closed or the statement fails.
   */
  async query<T = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.assertOpen()
    const result = await this.pool.query(text, [...params])
    return result.rows as T[]
  }

  /**
   * Run several statements on one connection, committing together.
   *
   * The callback receives a runner bound to the transaction; throwing rolls back.
   * @param body - work to perform inside the transaction.
   * @returns whatever the body returned.
   */
  async transaction<T>(body: (run: <R = Row>(text: string, params?: readonly unknown[]) => Promise<R[]>) => Promise<T>): Promise<T> {
    this.assertOpen()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const run = async <R = Row>(text: string, params: readonly unknown[] = []): Promise<R[]> => {
        const result = await client.query(text, [...params])
        return result.rows as R[]
      }
      const value = await body(run)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * Verify the database answers.
   * @returns round-trip milliseconds.
   */
  async ping(): Promise<number> {
    const started = Date.now()
    await this.query('SELECT 1')
    return Date.now() - started
  }

  /** Close the pool; in-flight queries are allowed to finish. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.pool.end().catch(() => undefined)
  }

  /** Guard every entry point so a disposed plugin cannot keep querying. */
  private assertOpen(): void {
    if (this.closed) throw new Error('database: pool is closed')
  }
}
