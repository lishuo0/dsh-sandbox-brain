import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import SessionDirectoryService from '../../packages/dsh-session-directory/src/index.ts'
import { testContext } from '../helpers/brain.ts'
import { createTestDatabase, type TestDatabase, type TestPool } from '../helpers/pg.ts'

let database: TestDatabase
let pool: TestPool
let storage: string

function dbOf(target: TestPool) {
  return {
    dialect: target.dialect,
    query: <T>(text: string, params?: readonly unknown[]): Promise<T[]> => target.query<T>(text, params),
    transaction: target.transaction,
  }
}

beforeAll(async () => {
  database = await createTestDatabase(['platform', 'brain'])
  pool = database.pool
  storage = await mkdtemp(join(tmpdir(), 'dsh-directory-'))
  await pool.query(
    `INSERT INTO dsh_users (id, display_name, password_hash, skills_volume)
     VALUES ('u1', 'u1', 'x', 'skills-u1')`,
  )
  await pool.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, volume_name)
     VALUES ('w1', 'u1', '默认', '/var/agent-desk/u1/w1', '/desk', 'desk-w1')`,
  )
  await pool.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id)
     VALUES ('s1', 'u1', 'w1', '会话', 'platform'), ('s2', 'u1', NULL, '无工作区', 'platform')`,
  )
  // 明确配置过选择的工作区：w2 选了条目，w3 明确一个都不接。
  await pool.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, volume_name, selection_configured)
     VALUES ('w2', 'u1', '选过的', '/var/agent-desk/u1/w2', '/desk', 'desk-w2', true),
            ('w3', 'u1', '空选择', '/var/agent-desk/u1/w3', '/desk', 'desk-w3', true)`,
  )
  await pool.query(
    `INSERT INTO dsh_workspace_skills (workspace_id, skill_name, skill_scope)
     VALUES ('w2', 'weekly', 'private'), ('w2', 'shared', 'public')`,
  )
  await pool.query(
    `INSERT INTO dsh_workspace_mcp_servers (workspace_id, server_name, server_scope)
     VALUES ('w2', 'search', 'public')`,
  )
  await pool.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id)
     VALUES ('s3', 'u1', 'w2', '选过的', 'platform'), ('s4', 'u1', 'w3', '空选择', 'platform')`,
  )
})

afterAll(async () => {
  await database.drop()
  await rm(storage, { recursive: true, force: true })
})

describe('session directory', () => {
  it('owner 返回会话属主与工作区', async () => {
    const ctx = testContext({ db: dbOf(pool), agents: { get: () => undefined } })
    const service = new SessionDirectoryService(ctx, { cacheTtlMs: 0 })
    await expect(service.owner('s1')).resolves.toMatchObject({
      userId: 'u1',
      workspaceId: 'w1',
      volumeName: 'desk-w1',
      skillsVolume: 'skills-u1',
    })
  })

  it('没配置过选择的工作区不带 skills / mcpServers，沿用全部启用', async () => {
    const ctx = testContext({ db: dbOf(pool), agents: { get: () => undefined } })
    const service = new SessionDirectoryService(ctx, { cacheTtlMs: 0 })
    const owner = await service.owner('s1')
    expect(owner).toBeDefined()
    expect('skills' in owner!).toBe(false)
    expect('mcpServers' in owner!).toBe(false)
  })

  it('配置过的工作区带回选中的 Skill / MCP', async () => {
    const ctx = testContext({ db: dbOf(pool), agents: { get: () => undefined } })
    const service = new SessionDirectoryService(ctx, { cacheTtlMs: 0 })
    await expect(service.owner('s3')).resolves.toMatchObject({
      userId: 'u1',
      workspaceId: 'w2',
      skills: [
        { name: 'shared', scope: 'public' },
        { name: 'weekly', scope: 'private' },
      ],
      mcpServers: [{ name: 'search', scope: 'public' }],
    })
  })

  it('配置过但一个都没选：空数组，不是 undefined', async () => {
    const ctx = testContext({ db: dbOf(pool), agents: { get: () => undefined } })
    const service = new SessionDirectoryService(ctx, { cacheTtlMs: 0 })
    await expect(service.owner('s4')).resolves.toMatchObject({ skills: [], mcpServers: [] })
  })

  it('没有工作区的会话不算 owner', async () => {
    const ctx = testContext({ db: dbOf(pool), agents: { get: () => undefined } })
    const service = new SessionDirectoryService(ctx, { cacheTtlMs: 0 })
    expect(await service.owner('s2')).toBeUndefined()
    expect(await service.owner('missing')).toBeUndefined()
    expect(await service.owner('')).toBeUndefined()
  })

  it('userOf 容忍没有工作区的会话', async () => {
    const ctx = testContext({ db: dbOf(pool), agents: { get: () => undefined } })
    const service = new SessionDirectoryService(ctx, { cacheTtlMs: 0 })
    await expect(service.userOf('s2')).resolves.toEqual({ userId: 'u1', skillsVolume: 'skills-u1' })
    expect(await service.userOf('missing')).toBeUndefined()
  })

  it('ownerOf 沿子会话找到平台属主', async () => {
    const agents = {
      get: (id: string) => (id === 'child' ? { session: { header: { parentSession: 's1' } } } : undefined),
    }
    const ctx = testContext({ db: dbOf(pool), agents })
    const service = new SessionDirectoryService(ctx, { cacheTtlMs: 0 })
    await expect(service.ownerOf('child')).resolves.toMatchObject({ userId: 'u1', workspaceId: 'w1' })
  })

  it('ownerOf 遇到环时停下', async () => {
    const agents = {
      get: (id: string) => (id === 'a' ? { session: { header: { parentSession: 'b' } } } : { session: { header: { parentSession: 'a' } } }),
    }
    const ctx = testContext({ db: dbOf(pool), agents })
    const service = new SessionDirectoryService(ctx, { cacheTtlMs: 0 })
    expect(await service.ownerOf('a')).toBeUndefined()
  })

  it('缓存命中时不再查库，forget 后重新查', async () => {
    let calls = 0
    const db = {
      query: async <T>(): Promise<T[]> => {
        calls += 1
        return [
          {
            user_id: 'u1',
            workspace_id: 'w1',
            volume_name: 'desk-w1',
            skills_volume: null,
          },
        ] as T[]
      },
    }
    const ctx = testContext({ db, agents: { get: () => undefined } })
    const service = new SessionDirectoryService(ctx, { cacheTtlMs: 60_000 })
    await service.owner('s1')
    await service.owner('s1')
    expect(calls).toBe(1)
    service.forget('s1')
    await service.owner('s1')
    expect(calls).toBe(2)
  })
})
