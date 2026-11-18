/**
 * SQLite 版本的数据库适配（本地单机默认）。
 *
 * 与平台 `src/kernel/sqlite.ts` 是同一套翻译逻辑：SQL 仍按 PostgreSQL 的写法
 * 书写，进这里后换成 `?` 占位、`now()` 时间参数，去掉类型转换与行锁。
 * 改一边要同步另一边。
 *
 * @module @brain/dsh-database/sqlite
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

/** 一行查询结果。 */
export type SqliteRow = Record<string, unknown>

/** 事务里的执行器，与 PG 分支的回调形状一致（返回行数组）。 */
export type Runner = <R = SqliteRow>(text: string, params?: readonly unknown[]) => Promise<R[]>

/** 一条 SQLite 连接。 */
export class SqliteDatabase {
  readonly dialect = 'sqlite' as const
  /** 一条连接不能被并发读写，所有访问串行排队。 */
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false

  private constructor(private readonly db: DatabaseSync) {
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA synchronous = NORMAL')
  }

  /** 用 `process.getBuiltinModule` 同步取内置模块：插件构造器不能 await。 */
  static open(file: string): SqliteDatabase {
    mkdirSync(dirname(file), { recursive: true })
    const mod = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
    return new SqliteDatabase(new mod.DatabaseSync(file))
  }

  query<T = SqliteRow>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.exclusive(() => this.execute<T>(text, params).rows)
  }

  /** 执行多语句脚本（schema 用）；不走翻译。 */
  exec(sql: string): Promise<void> {
    return this.exclusive(() => {
      if (this.closed) throw new Error('database: pool is closed')
      this.db.exec(sql)
    })
  }

  transaction<T>(body: (run: Runner) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const run: Runner = <R = SqliteRow>(text: string, params: readonly unknown[] = []) =>
          Promise.resolve(this.execute<R>(text, params).rows)
        const value = await body(run)
        this.db.exec('COMMIT')
        return value
      } catch (error) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          /* 事务可能已经被 SQLite 回滚 */
        }
        throw error
      }
    })
  }

  async ping(): Promise<number> {
    const started = Date.now()
    await this.query('SELECT 1')
    return Date.now() - started
  }

  close(): Promise<void> {
    return this.exclusive(() => {
      if (this.closed) return
      this.closed = true
      this.db.close()
    })
  }

  execute<T>(text: string, params: readonly unknown[]): { rows: T[]; changes: number } {
    if (this.closed) throw new Error('database: pool is closed')
    const translated = translate(text, params)
    const values = translated.params as SQLInputValue[]
    const statement = this.db.prepare(translated.text)
    if (statement.columns().length > 0) {
      const rows = statement.all(...values) as T[]
      return { rows, changes: rows.length }
    }
    const info = statement.run(...values)
    return { rows: [], changes: Number(info.changes) }
  }

  private exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

export interface Translated {
  text: string
  params: unknown[]
}

const TOKEN =
  /('(?:[^']|'')*')|(\$(\d+))|\bnow\s*\(\s*\)|\btrue\b|\bfalse\b|::[A-Za-z_][A-Za-z0-9_]*(?:\[\])?|\bFOR\s+UPDATE(?:\s+SKIP\s+LOCKED)?\b/gi

/**
 * 把 PostgreSQL 风格的 SQL 翻成 SQLite：占位符换 `?`、`now()` 换时间参数、
 * 去掉类型转换和行锁、布尔字面量写成 1/0。引号里的内容整段跳过。
 */
export function translate(text: string, params: readonly unknown[] = []): Translated {
  const ordered: unknown[] = []
  const sql = text.replace(TOKEN, (match, quoted: string | undefined, _placeholder, index: string | undefined) => {
    if (quoted !== undefined) return quoted
    if (index !== undefined) {
      ordered.push(normalizeParam(params[Number(index) - 1]))
      return '?'
    }
    if (/^now/i.test(match)) {
      ordered.push(new Date().toISOString())
      return '?'
    }
    if (/^true$/i.test(match)) return '1'
    if (/^false$/i.test(match)) return '0'
    if (match.startsWith('::')) return ''
    return '' // FOR UPDATE [SKIP LOCKED]
  })
  return { text: sql, params: ordered }
}

/** SQLite 只接受 null / number / bigint / string / Uint8Array。 */
export function normalizeParam(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'bigint') return Number(value)
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value
  if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value)
  return value
}
