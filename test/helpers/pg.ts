import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SqliteDatabase } from '../../packages/dsh-database/src/sqlite.ts'
import type { Dialect } from '../../packages/dsh-database/src/index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** 本地测试集群：端口 55432，与平台测试共用同一份数据目录。 */
export const TEST_PG = {
  port: Number(process.env.TEST_PG_PORT ?? 55432),
  user: process.env.TEST_PG_USER ?? 'dsh',
  dataDir: process.env.TEST_PG_DATA ?? resolve(root, '..', '.test-pgdata'),
  get host(): string {
    return '127.0.0.1'
  },
}

const BIN_CANDIDATES = [
  resolve(root, '..', '.test-pg-bin', 'native', 'bin'),
  '/usr/local/opt/postgresql@16/bin',
  '/opt/homebrew/opt/postgresql@16/bin',
  '/usr/local/opt/postgresql/bin',
  '/opt/homebrew/opt/postgresql/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
]

function binaries(): { initdb: string; pgCtl: string } {
  const override = process.env.TEST_PG_BIN
  const dirs = override === undefined ? BIN_CANDIDATES : [override, ...BIN_CANDIDATES]
  for (const dir of dirs) {
    const initdb = join(dir, 'initdb')
    const pgCtl = join(dir, 'pg_ctl')
    if (existsSync(initdb) && existsSync(pgCtl)) return { initdb, pgCtl }
  }
  throw new Error(
    '找不到 PostgreSQL 二进制。请执行 brew install postgresql@16，或把预编译二进制放到 <workspace>/.test-pg-bin/native/bin，或设置 TEST_PG_BIN 指向 bin 目录。',
  )
}

export function adminUrl(): string {
  return `postgres://${TEST_PG.user}@${TEST_PG.host}:${TEST_PG.port}/postgres`
}

let clusterReady: Promise<void> | undefined

/** 幂等：初始化数据目录（如需）并启动本地集群。 */
export function ensureCluster(): Promise<void> {
  clusterReady ??= startCluster()
  return clusterReady
}

async function startCluster(): Promise<void> {
  if (!existsSync(join(TEST_PG.dataDir, 'PG_VERSION'))) {
    mkdirSync(dirname(TEST_PG.dataDir), { recursive: true })
    const { initdb } = binaries()
    const init = spawnSync(
      initdb,
      ['-D', TEST_PG.dataDir, '-U', TEST_PG.user, '--auth=trust', '-E', 'UTF8', '--locale=C'],
      { encoding: 'utf8' },
    )
    if (init.status !== 0) {
      throw new Error(`initdb 失败:\n${init.stdout}\n${init.stderr}`)
    }
  }
  if (await canConnect()) return
  const { pgCtl } = binaries()
  const started = spawnSync(
    pgCtl,
    [
      '-D', TEST_PG.dataDir,
      '-l', `${TEST_PG.dataDir}.log`,
      '-o', `-p ${TEST_PG.port} -k /tmp -c listen_addresses=${TEST_PG.host}`,
      '-w', 'start',
    ],
    { encoding: 'utf8' },
  )
  if (started.status !== 0 && !(await canConnect())) {
    throw new Error(`pg_ctl start 失败:\n${started.stdout}\n${started.stderr}`)
  }
}

async function canConnect(): Promise<boolean> {
  const client = new pg.Client({ connectionString: adminUrl(), connectionTimeoutMillis: 2_000 })
  try {
    await client.connect()
    await client.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => undefined)
  }
}

export type SchemaKind = 'platform' | 'brain'

/** 默认跑 SQLite；`TEST_DB=postgres` 时用本地临时 PostgreSQL 集群。 */
export const TEST_DIALECT: Dialect = process.env.TEST_DB === 'postgres' ? 'postgres' : 'sqlite'

export type Row = Record<string, unknown>

/** 测试用的数据库句柄，契约与脑的 `ctx.db` 一致：`query() → rows[]`。 */
export interface TestPool {
  readonly dialect: Dialect
  query<T = Row>(text: string, params?: readonly unknown[]): Promise<T[]>
  exec(sql: string): Promise<void>
  transaction<T>(body: (run: <R = Row>(text: string, params?: readonly unknown[]) => Promise<R[]>) => Promise<T>): Promise<T>
  end(): Promise<void>
}

export interface TestDatabase {
  config: { url?: string; file?: string }
  url: string
  pool: TestPool
  dialect: Dialect
  drop(): Promise<void>
}

const SCHEMA_PATHS: Record<SchemaKind, { postgres: string; sqlite: string }> = {
  brain: {
    postgres: resolve(root, 'src/schema.sql'),
    sqlite: resolve(root, 'src/schema.sqlite.sql'),
  },
  platform: {
    postgres: resolve(root, '..', 'dsh-sandbox-platform/src/schema.sql'),
    sqlite: resolve(root, '..', 'dsh-sandbox-platform/src/schema.sqlite.sql'),
  },
}

/** 创建一个独立测试库并应用 schema；每个测试文件用自己的库/文件，可以并行。 */
export async function createTestDatabase(schemas: SchemaKind[] = ['brain']): Promise<TestDatabase> {
  if (TEST_DIALECT === 'sqlite') return createSqliteDatabase(schemas)
  return createPostgresDatabase(schemas)
}

async function createSqliteDatabase(schemas: SchemaKind[]): Promise<TestDatabase> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-test-sqlite-'))
  const file = join(dir, 'test.sqlite')
  const db = SqliteDatabase.open(file)
  const pool: TestPool = {
    dialect: 'sqlite',
    query: (text, params = []) => db.query(text, params),
    exec: sql => db.exec(sql),
    transaction: body => db.transaction(body),
    end: () => db.close(),
  }
  try {
    for (const kind of schemas) await pool.exec(readFileSync(SCHEMA_PATHS[kind].sqlite, 'utf8'))
  } catch (error) {
    await pool.end().catch(() => undefined)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  return {
    config: { file },
    url: `file:${file}`,
    pool,
    dialect: 'sqlite',
    async drop() {
      await pool.end().catch(() => undefined)
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

async function createPostgresDatabase(schemas: SchemaKind[]): Promise<TestDatabase> {
  await ensureCluster()
  const name = `t_${process.pid}_${randomBytes(5).toString('hex')}`
  const admin = new pg.Client({ connectionString: adminUrl() })
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end()
  }
  const url = `postgres://${TEST_PG.user}@${TEST_PG.host}:${TEST_PG.port}/${name}`
  const pgPool = new pg.Pool({ connectionString: url })
  const pool: TestPool = {
    dialect: 'postgres',
    query: async (text, params = []) => (await pgPool.query(text, [...params])).rows,
    exec: async sql => {
      await pgPool.query(sql)
    },
    transaction: async body => {
      const client = await pgPool.connect()
      try {
        await client.query('BEGIN')
        const value = await body(async (text, params = []) => (await client.query(text, [...params])).rows)
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
    end: async () => {
      await pgPool.end()
    },
  }
  try {
    for (const kind of schemas) {
      await pool.exec(readFileSync(SCHEMA_PATHS[kind].postgres, 'utf8'))
    }
  } catch (error) {
    await pool.end().catch(() => undefined)
    await dropDatabase(name).catch(() => undefined)
    throw error
  }
  return {
    config: { url },
    url,
    pool,
    dialect: 'postgres',
    async drop() {
      await pool.end().catch(() => undefined)
      await dropDatabase(name)
    },
  }
}

async function dropDatabase(name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl() })
  await admin.connect()
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    )
    await admin.query(`DROP DATABASE IF EXISTS ${name}`)
  } finally {
    await admin.end()
  }
}

/** 随机生成一份可用的测试凭据。 */
export function testSecrets(): { appId: string; appKey: string } {
  return { appId: 'platform', appKey: randomBytes(24).toString('hex') }
}
