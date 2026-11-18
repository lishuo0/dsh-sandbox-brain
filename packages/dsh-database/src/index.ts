/**
 * One database handle for the whole process.
 *
 * Local runs default to a single SQLite file; deployments use PostgreSQL. Three
 * consumers share the handle — the session backend, the sandbox binding store
 * and the session-directory lookup — so the connection is configured once.
 *
 * @module @brain/dsh-database
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import pg from 'pg'
import { SqliteDatabase } from './sqlite.js'

/** Which SQL dialect the handle speaks. */
export type Dialect = 'postgres' | 'sqlite'

/** Configuration. */
export interface Config {
  /** `postgres://user:pass@host:port/db?sslmode=require` */
  readonly url?: string
  /** 本地 SQLite 文件；填这个就走 SQLite，忽略 url。 */
  readonly file?: string
  /** Pool size. Total connections ≈ replicas × this, plus the platform's own pool. */
  readonly maxConnections?: number
  /** Statement timeout in milliseconds; 0 disables. */
  readonly statementTimeoutMs?: number
  /** How long to wait for a free connection before failing. */
  readonly acquireTimeoutMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The shared handle. Every persistence consumer injects it. */
    db: Database
  }
}

/** A row returned by a query. */
export type Row = Record<string, unknown>

/**
 * Shared database handle (SQLite file locally, PostgreSQL pool in deployments).
 *
 * Queries never take a connection explicitly: `query` and `transaction` own
 * their checkout so a caller cannot leak one. Code that needs a session-scoped
 * sequence (an advisory lock, for instance) uses `transaction`.
 */
export default class Database extends Service {
  readonly dialect: Dialect
  private readonly pool?: pg.Pool
  private readonly sqlite?: SqliteDatabase
  private closed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'db')
    const file = typeof config.file === 'string' ? config.file.trim() : ''
    if (file !== '') {
      this.sqlite = SqliteDatabase.open(file)
      this.dialect = 'sqlite'
    } else {
      if (typeof config.url !== 'string' || config.url === '') {
        throw new Error('database: url or file is required')
      }
      this.dialect = 'postgres'
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
    }

    ctx.effect(() => () => this.close(), 'database: pool')
  }

  /**
   * Run one statement.
   * @param text - SQL with `$1`, `$2`, … placeholders.
   * @param params - positional parameters.
   * @returns the result rows.
   * @throws when the handle is closed or the statement fails.
   */
  async query<T = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.assertOpen()
    if (this.sqlite !== undefined) return this.sqlite.query<T>(text, params)
    const result = await this.pool!.query(text, [...params])
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
    if (this.sqlite !== undefined) return this.sqlite.transaction(body)
    const client = await this.pool!.connect()
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
    this.assertOpen()
    if (this.sqlite !== undefined) return this.sqlite.ping()
    const started = Date.now()
    await this.query('SELECT 1')
    return Date.now() - started
  }

  /** Close the handle; in-flight queries are allowed to finish. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.sqlite !== undefined) {
      await this.sqlite.close()
      return
    }
    await this.pool?.end().catch(() => undefined)
  }

  /** Guard every entry point so a disposed plugin cannot keep querying. */
  private assertOpen(): void {
    if (this.closed) throw new Error('database: pool is closed')
  }
}
