import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence'
import PgSessionPersistence, {
  leaseAllowsWrite,
  lostLeaseIds,
} from '../../packages/dsh-session-pg/src/index.ts'
import { testContext } from '../helpers/brain.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts'
import { dbOf } from '../helpers/skills.ts'

/**
 * 会话持久化的两条底线：单写者租约、追加日志连续。
 *
 * 这些用例直接打真实库（默认 SQLite），因为租约语义就写在 SQL 里：
 * `ON CONFLICT … WHERE expires_at < now()` 是过期后才可被抢的闸门，
 * `(session_id, seq)` 主键是第二个写者撞上就失败的护栏。
 */

const HEADER = { version: 4 as const, createdAt: 1_700_000_000_000, isSeeded: false }
const SID = 'sess-1'

function header(id = SID) {
  return { ...HEADER, id: SessionId(id) }
}

/** 一个信封合法、内容最小的非 surface 事件。 */
function event(seq: number, type: string, data: unknown): SessionEvent {
  return { type, seq: SessionSeq(seq), time: 1_000 + seq, data } as unknown as SessionEvent
}

function turnOpen(): SessionEvent[] {
  return [event(0, 'turn/start', { turn: 1 }), event(1, 'step/start', { turn: 1, step: 1 })]
}

let database: TestDatabase

beforeEach(async () => {
  database = await createTestDatabase(['brain'])
})

afterEach(async () => {
  await database.drop()
})

function make(options: { leaseMs?: number; heartbeatMs?: number; liveBatchMs?: number } = {}) {
  const ctx: Context = testContext({ db: dbOf(database.pool) })
  const persistence = new PgSessionPersistence(ctx, {
    leaseMs: options.leaseMs ?? 30_000,
    heartbeatMs: options.heartbeatMs ?? 10_000,
    liveBatchMs: options.liveBatchMs ?? 5,
  })
  return { ctx, persistence }
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('session-pg：纯函数租约判定', () => {
  it('lostLeaseIds 只返回没续上的 id', () => {
    expect(lostLeaseIds(['a', 'b', 'c'], new Set(['a', 'c']))).toEqual(['b'])
    expect(lostLeaseIds(['a'], new Set(['a']))).toEqual([])
    expect(lostLeaseIds([], new Set())).toEqual([])
  })

  it('leaseAllowsWrite 同时校验 owner 与 generation', () => {
    expect(leaseAllowsWrite({ owner: 'me', generation: '2' }, 'me', 2)).toBe(true)
    expect(leaseAllowsWrite({ owner: 'other', generation: '2' }, 'me', 2)).toBe(false)
    // owner 对但 generation 已经被 force close 顶掉。
    expect(leaseAllowsWrite({ owner: 'me', generation: '3' }, 'me', 2)).toBe(false)
    expect(leaseAllowsWrite(undefined, 'me', 2)).toBe(false)
  })
})

describe('session-pg：create / stat / list', () => {
  it('create 落 header 并占用写租约；stat 的 revision 带方言前缀', async () => {
    const { persistence } = make()
    const handle = await persistence.create(header())
    await handle.append(turnOpen())
    await handle.flush()

    const stat = await persistence.stat(SessionId(SID))
    expect(stat?.eventCount).toBe(2)
    expect(stat?.header.id).toBe(SID)
    expect(String(stat?.revision)).toBe(`${database.dialect}:${SID}:2`)

    const listed = await persistence.list()
    expect(listed.map((item) => item.header.id)).toEqual([SID])

    await handle.close()
  })

  it('同 id 重复 create 抛 SessionAlreadyExistsError', async () => {
    const { persistence } = make()
    const handle = await persistence.create(header())
    await expect(persistence.create(header())).rejects.toBeInstanceOf(SessionAlreadyExistsError)
    await handle.close()
  })

  it('open 不存在的会话抛 SessionPersistenceNotFoundError', async () => {
    const { persistence } = make()
    await expect(persistence.open(SessionId('missing'), 'read')).rejects.toBeInstanceOf(
      SessionPersistenceNotFoundError,
    )
  })
})

describe('session-pg：单写者租约', () => {
  it('read 打开可在别人持有写租约时进行；write 打开被拒', async () => {
    const { persistence } = make()
    const writer = await persistence.create(header())
    await writer.append(turnOpen())
    await writer.flush()

    const reader = await persistence.open(SessionId(SID), 'read')
    const { events } = await reader.read()
    expect(events.map((item) => item.type)).toEqual(['turn/start', 'step/start'])
    // 读句柄只读。
    await expect(reader.append([event(2, 'turn/end', { turn: 1, reason: { kind: 'done' } })])).rejects.toBeInstanceOf(
      SessionReadOnlyError,
    )

    await expect(persistence.open(SessionId(SID), 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)

    await reader.close()
    await writer.close()
  })

  it('租约过期后另一个实例可以接手，generation 递增', async () => {
    const first = make({ leaseMs: 60 })
    const owner = await first.persistence.create(header())
    await owner.append(turnOpen())
    await owner.flush()

    // 等过期；心跳间隔是 min(leaseMs/3, 1s) 兜底为 1s，这里不会提前续。
    await new Promise((resolve) => setTimeout(resolve, 120))

    const second = make()
    const taken = await second.persistence.open(SessionId(SID), 'write')
    await taken.append([event(2, 'step/end', { turn: 1, step: 1 })])
    await taken.flush()

    // 旧句柄仍以为游标是 2；写入会先过本地连续检查，然后被库里的栅栏拒绝。
    await expect(owner.append([event(2, 'turn/end', { turn: 1, reason: { kind: 'done' } })])).rejects.toBeInstanceOf(
      SessionAlreadyOwnedError,
    )

    await taken.close()
    await owner.close()
  })
})

describe('session-pg：追加日志连续 + 拦截第二个写者', () => {
  it('appendBatch 用错 generation 会被拒（不会写坏日志）', async () => {
    const { persistence } = make()
    const handle = await persistence.create(header())
    await handle.append(turnOpen())
    await handle.flush()

    await expect(
      persistence.appendBatch(SID, 2, [event(2, 'step/end', { turn: 1, step: 1 })], 999),
    ).rejects.toBeInstanceOf(SessionAlreadyOwnedError)

    // 日志仍是原来两条。
    expect((await persistence.stat(SessionId(SID)))?.eventCount).toBe(2)
    await handle.close()
  })

  it('关闭后的句柄再 append / flush 抛 SessionHandleClosedError', async () => {
    const { persistence } = make()
    const handle = await persistence.create(header())
    await handle.close()
    // 关闭后的写入在入队前同步拒绝。
    expect(() => handle.append(turnOpen())).toThrow(SessionHandleClosedError)
    expect(() => handle.flush()).toThrow(SessionHandleClosedError)
  })
})

describe('session-pg：forceCloseTurn 关闭卡住的回合', () => {
  it('合成 step/end + turn/end，并让旧的写句柄失去栅栏', async () => {
    const { persistence } = make()
    const stuck = await persistence.create(header())
    await stuck.append(turnOpen())
    await stuck.flush()

    const closed = await persistence.forceCloseTurn(SessionId(SID))
    expect(closed).toEqual({ closed: true, events: 2 })

    const reader = await persistence.open(SessionId(SID), 'read')
    const { events } = await reader.read()
    expect(events.map((item) => item.type)).toEqual(['turn/start', 'step/start', 'step/end', 'turn/end'])
    expect(events.at(-1)?.data).toMatchObject({ turn: 1, reason: { kind: 'interrupted' } })
    await reader.close()

    // 旧写入者仍以为游标是 2；写入被 force close 抬高的 generation 栅栏拒绝。
    await expect(stuck.append([event(2, 'turn/end', { turn: 1, reason: { kind: 'done' } })])).rejects.toBeInstanceOf(
      SessionAlreadyOwnedError,
    )
    await stuck.close()
  })

  it('幂等：回合已关闭时重复 force close 不动日志', async () => {
    const { persistence } = make()
    const handle = await persistence.create(header())
    await handle.append(turnOpen())
    await handle.flush()

    await persistence.forceCloseTurn(SessionId(SID))
    const before = (await persistence.stat(SessionId(SID)))?.eventCount
    await expect(persistence.forceCloseTurn(SessionId(SID))).resolves.toEqual({ closed: false, events: 0 })
    expect((await persistence.stat(SessionId(SID)))?.eventCount).toBe(before)
    await handle.close()
  })

  it('没有打开的回合时什么都不做', async () => {
    const { persistence } = make()
    const handle = await persistence.create(header())
    await expect(persistence.forceCloseTurn(SessionId(SID))).resolves.toEqual({ closed: false, events: 0 })
    await handle.close()
  })

  it('对不存在的会话不抛错', async () => {
    const { persistence } = make()
    await expect(persistence.forceCloseTurn(SessionId('missing'))).resolves.toEqual({ closed: false, events: 0 })
  })
})

describe('session-pg：live 写回与租约丢失', () => {
  it('session/event 缓冲后由 session/flush 落库', async () => {
    const { ctx, persistence } = make({ liveBatchMs: 5 })
    const handle = await persistence.create(header())

    for (const item of turnOpen()) {
      ctx.emit('session/event', { id: SID } as never, item)
    }
    // 事件先进入缓冲，flush 是持久化屏障。
    expect((await persistence.stat(SessionId(SID)))?.eventCount).toBe(0)
    await ctx.emit('session/flush', { id: SID } as never)
    expect((await persistence.stat(SessionId(SID)))?.eventCount).toBe(2)

    await handle.close()
  })

  it('租约行丢失后心跳发 session/lease-lost 并停止续约', async () => {
    const { ctx, persistence } = make({ leaseMs: 5_000, heartbeatMs: 20 })
    const handle = await persistence.create(header())

    const lost: string[] = []
    ctx.on('session/lease-lost', (id) => void lost.push(id))

    // 模拟另一个副本接管：租约行被删除/过期。
    await database.pool.query('DELETE FROM dsh_session_leases WHERE session_id = $1', [SID])
    await waitFor(() => lost.length > 0)

    expect(lost).toEqual([SID])
    // 丢失后句柄已从 live 路由移除，再发事件不会尝试写。
    expect(() => ctx.emit('session/event', { id: SID } as never, event(2, 'step/end', { turn: 1, step: 1 }))).not.toThrow()
    await handle.close()
  })
})
