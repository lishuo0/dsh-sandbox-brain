import { describe, expect, it } from 'vitest'
import { createOwnershipGuard } from '../../packages/dsh-platform-api/src/ownership.ts'
import { testContext } from '../helpers/brain.ts'

function fakeDb(rows: Record<string, string>): { query: <T>(sql: string, params?: readonly unknown[]) => Promise<T[]> } {
  return {
    async query<T>(_sql: string, params?: readonly unknown[]): Promise<T[]> {
      const id = String(params?.[0] ?? '')
      const owner = rows[id]
      return (owner === undefined ? [] : [{ user_id: owner }]) as T[]
    },
  }
}

describe('ownership guard', () => {
  it('合法属主通过', async () => {
    const ctx = testContext({ db: fakeDb({ s1: 'u1' }) })
    await expect(createOwnershipGuard(ctx).assert('s1', 'u1')).resolves.toBeUndefined()
  })

  it('未知会话与他人的会话都是同一个 404', async () => {
    const ctx = testContext({ db: fakeDb({ s1: 'u1' }) })
    const guard = createOwnershipGuard(ctx)
    const unknown = await guard.assert('nope', 'u1').catch((error: unknown) => error)
    const foreign = await guard.assert('s1', 'u2').catch((error: unknown) => error)
    expect(unknown).toMatchObject({ status: 404, code: 'session-not-found' })
    expect(foreign).toMatchObject({ status: 404, code: 'session-not-found' })
    // 文案只回显调用方自己给的 id，除此之外完全相同——无法据此判断会话是否存在。
    const shape = (error: Error) => error.message.replace(/"[^"]+"/, '"<id>"')
    expect(shape(unknown as Error)).toBe(shape(foreign as Error))
    expect(shape(unknown as Error)).toBe('session "<id>" is not available to this caller')
  })

  it('查询结果被缓存', async () => {
    let calls = 0
    const db = {
      async query<T>(): Promise<T[]> {
        calls += 1
        return [{ user_id: 'u1' }] as T[]
      },
    }
    const guard = createOwnershipGuard(testContext({ db }))
    await guard.assert('s1', 'u1')
    await guard.assert('s1', 'u1')
    expect(calls).toBe(1)
  })

  it('没有数据库时放行（开发机形态）', async () => {
    const ctx = testContext()
    const guard = createOwnershipGuard(ctx)
    await expect(guard.assert('anything', 'anyone')).resolves.toBeUndefined()
  })
})
