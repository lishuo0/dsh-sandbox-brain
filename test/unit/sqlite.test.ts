import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asJson, asNumber } from '../../packages/dsh-database/src/row.ts'
import { normalizeParam, SqliteDatabase, translate } from '../../packages/dsh-database/src/sqlite.ts'

describe('translate', () => {
  it('占位符换成 ? 并按出现顺序重排参数', () => {
    const out = translate('SELECT * FROM t WHERE a = $2 AND b = $1', ['first', 'second'])
    expect(out.text).toBe('SELECT * FROM t WHERE a = ? AND b = ?')
    expect(out.params).toEqual(['second', 'first'])
  })

  it('now()/布尔/类型转换/行锁都按 SQLite 处理', () => {
    const out = translate(
      'UPDATE t SET a = true, b = false, c = now(), d = $2::jsonb WHERE id = $1 FOR UPDATE',
      ['id-1', '{"x":1}'],
    )
    expect(out.text).toBe('UPDATE t SET a = 1, b = 0, c = ?, d = ? WHERE id = ? ')
    expect(Number.isNaN(Date.parse(String(out.params[0])))).toBe(false)
    expect(out.params.slice(1)).toEqual(['{"x":1}', 'id-1'])
  })

  it('引号里的内容不翻译', () => {
    const out = translate(`SELECT 'now() $1 ::jsonb true' AS x FROM t WHERE id = $1`, ['id-1'])
    expect(out.text).toBe(`SELECT 'now() $1 ::jsonb true' AS x FROM t WHERE id = ?`)
  })
})

describe('normalizeParam', () => {
  it('Date/boolean/Array 归一成可绑定的值', () => {
    const iso = new Date('2026-01-02T03:04:05.000Z')
    expect(normalizeParam(iso)).toBe(iso.toISOString())
    expect(normalizeParam(true)).toBe(1)
    expect(normalizeParam(false)).toBe(0)
    expect(normalizeParam({ headers: {} })).toBe('{"headers":{}}')
    expect(normalizeParam(undefined)).toBeNull()
  })
})

describe('行形状', () => {
  it('asJson 解析 SQLite 的 JSON 文本，也放过 PostgreSQL 的对象', () => {
    expect(asJson<{ type: string }>('{"type":"user"}')).toEqual({ type: 'user' })
    expect(asJson<{ type: string }>({ type: 'user' })).toEqual({ type: 'user' })
  })

  it('asNumber 处理 bigint、字符串数字与空值', () => {
    expect(asNumber(3)).toBe(3)
    expect(asNumber(3n)).toBe(3)
    expect(asNumber('3')).toBe(3)
    expect(asNumber(null)).toBe(0)
  })
})

describe('SqliteDatabase', () => {
  let dir: string
  let db: SqliteDatabase

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-brain-sqlite-test-'))
    db = SqliteDatabase.open(join(dir, 'test.sqlite'))
  })

  afterEach(async () => {
    await db.close().catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  })

  it('多语句 schema 与 upsert + RETURNING', async () => {
    await db.exec(`
      CREATE TABLE headers (session_id text PRIMARY KEY, header text NOT NULL, next_seq integer NOT NULL DEFAULT 0);
      CREATE TABLE events (session_id text NOT NULL, seq integer NOT NULL, event text NOT NULL, PRIMARY KEY (session_id, seq));
    `)
    await db.query(
      `INSERT INTO headers (session_id, header) VALUES ($1, $2::jsonb)
       ON CONFLICT (session_id) DO UPDATE SET header = EXCLUDED.header
       RETURNING session_id`,
      ['s1', JSON.stringify({ id: 's1' })],
    )
    await db.query(`INSERT INTO events (session_id, seq, event) VALUES ($1, $2, $3::jsonb)`, ['s1', 0, '{"type":"user"}'])
    const rows = await db.query<{ event: string }>(`SELECT event FROM events WHERE session_id = $1 ORDER BY seq`, ['s1'])
    expect(asJson(rows[0]!.event)).toEqual({ type: 'user' })
  })

  it('唯一冲突暴露 SQLite errcode', async () => {
    await db.exec(`CREATE TABLE t (id text PRIMARY KEY)`)
    await db.query(`INSERT INTO t (id) VALUES ($1)`, ['a'])
    const error = await db.query(`INSERT INTO t (id) VALUES ($1)`, ['a']).catch((value: unknown) => value)
    expect((error as { errcode?: number }).errcode).toBe(1555)
  })

  it('事务失败回滚', async () => {
    await db.exec(`CREATE TABLE t (id text PRIMARY KEY)`)
    await expect(
      db.transaction(async run => {
        await run(`INSERT INTO t (id) VALUES ($1)`, ['a'])
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await db.query(`SELECT id FROM t`)).toEqual([])
  })
})
