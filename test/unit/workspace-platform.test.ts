import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WorkspaceRegistryProjection from '../../packages/dsh-workspace-platform/src/index.ts'
import { testContext } from '../helpers/brain.ts'
import { createTestDatabase, type TestDatabase, type TestPool } from '../helpers/pg.ts'

let database: TestDatabase
let pool: TestPool

function dbOf(target: TestPool) {
  return {
    dialect: target.dialect,
    query: <T>(text: string, params?: readonly unknown[]): Promise<T[]> => target.query<T>(text, params),
    transaction: target.transaction,
  }
}

function service(): WorkspaceRegistryProjection {
  return new WorkspaceRegistryProjection(testContext({ db: dbOf(pool) }) as never)
}

beforeAll(async () => {
  database = await createTestDatabase(['platform', 'brain'])
  pool = database.pool
  await pool.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', 'u1', 'x')`)
  await pool.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, volume_name, is_default)
     VALUES ('w1', 'u1', '默认', '/var/agent-desk/u1/w1', '/desk', 'desk-w1', true),
            ('w2', 'u1', '归档块', '/var/agent-desk/u1/w2', '/desk', 'desk-w2', false)`,
  )
  await pool.query(`UPDATE dsh_workspaces SET state = 'archived' WHERE id = 'w2'`)
  await pool.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id, status, created_at)
     VALUES ('s1', 'u1', 'w1', '一', 'client', 'active', '2026-01-01T00:00:00Z'),
            ('s2', 'u1', 'w1', '二', 'client', 'archived', '2026-01-02T00:00:00Z'),
            ('s3', 'u1', NULL, '三', 'client', 'active', '2026-01-03T00:00:00Z')`,
  )
})

afterAll(async () => {
  await database.drop()
})

describe('workspace projection', () => {
  it('只列出平台里未归档的工作区，路径是沙箱挂载点', async () => {
    const registry = service()
    await registry.refresh()
    const list = registry.list()
    expect(list.map((workspace) => workspace.id)).toEqual(['w1'])
    expect(list[0]?.path).toBe('/desk')
    expect(list[0]?.title).toBe('默认')
    expect(list[0]?.sessionIds).toEqual(['s1'])
  })

  it('按平台工作区 id 解析（会话创建的路由依据）', async () => {
    const registry = service()
    await registry.refresh()
    expect(registry.get('w1')?.path).toBe('/desk')
    expect(registry.get('w2')).toBeUndefined()
  })

  it('归档集合来自会话状态位', async () => {
    const registry = service()
    await registry.refresh()
    expect(registry.archivedSessionIds).toEqual(['s2'])
  })

  it('attachSession 把会话挂到平台工作区并写回数据库', async () => {
    const registry = service()
    await registry.refresh()
    const workspace = registry.get('w1')!
    await (workspace as unknown as { attachSession(id: string): Promise<void> }).attachSession('s3')
    expect(workspace.sessionIds).toEqual(['s3', 's1'])
    const rows = await pool.query<{ workspace_id: string | null }>(
      `SELECT workspace_id FROM dsh_sessions WHERE id = 's3'`,
    )
    expect(rows[0]?.workspace_id).toBe('w1')
  })

  it('insertSessionBefore 只调整手动顺序，越界会话报 move-invalid', async () => {
    const registry = service()
    await registry.refresh()
    const workspace = registry.get('w1') as unknown as {
      insertSessionBefore(id: string, before?: string): Promise<void>
      sessionIds: string[]
    }
    await workspace.insertSessionBefore('s1', 's3')
    expect(workspace.sessionIds).toEqual(['s1', 's3'])
    await expect(workspace.insertSessionBefore('nope')).rejects.toMatchObject({ name: 'WorkspaceMoveInvalidError' })
  })

  it('创建由平台负责，脑侧直接拒绝', async () => {
    const registry = service()
    await registry.refresh()
    await expect(registry.create()).rejects.toThrow('owned by the platform')
    await expect(registry.initializeDefault()).resolves.toBeUndefined()
  })
})
