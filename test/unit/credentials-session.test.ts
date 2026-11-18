import { describe, expect, it } from 'vitest'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import SessionCredentialProvider from '../../packages/dsh-credentials-session/src/index.ts'
import type { SessionModelKeys } from '../../packages/dsh-credentials-session/src/index.ts'
import { testContext } from '../helpers/brain.ts'

/**
 * 会话级模型密钥：平台按会话发钥匙，子代理沿 parentSession 继承。
 *
 * 重点是「错就炸」而不是「悄悄没配」：没有平台注入的 sessionModelKeys、
 * 或者整条祖先链都没有钥匙，都必须抛错，避免借到别的租户的 key。
 */

interface FakeAgents {
  currentInitiator?: () => { session?: { id?: unknown } } | undefined
  get(id: string): { session?: { header?: { parentSession?: unknown } } } | undefined
}

/** 可变的 agents + sessionModelKeys，便于逐例换当前会话与父链。 */
function harness(options: {
  current?: string
  parents?: Record<string, string>
  keys?: Record<string, string>
  withKeysService?: boolean
  withAgents?: boolean
} = {}) {
  const keysService = new Map(Object.entries(options.keys ?? {}))
  const sessionModelKeys: SessionModelKeys = {
    get: (id) => keysService.get(id),
    set: (id, key) => void keysService.set(id, key),
    delete: (id) => void keysService.delete(id),
  }
  let currentId = options.current
  const agents: FakeAgents = {
    currentInitiator: () => (currentId === undefined ? undefined : { session: { id: currentId } }),
    get: (id) => {
      const parent = options.parents?.[id]
      return parent === undefined ? undefined : { session: { header: { parentSession: parent } } }
    },
  }

  const services: Record<string, unknown> = {}
  if (options.withKeysService !== false) services.sessionModelKeys = sessionModelKeys
  if (options.withAgents !== false) services.agents = agents
  const ctx = testContext(services)
  const provider = new SessionCredentialProvider(ctx)
  return {
    ctx,
    provider,
    keysService,
    setCurrent(id: string | undefined) {
      currentId = id
    },
  }
}

const KEY = credentialRef('DEEPSEEK_API_KEY')
const OTHER = credentialRef('OTHER_API_KEY')

describe('credentials-session：按会话解析模型密钥', () => {
  it('1. 当前会话有钥匙时直接返回，来源标记为 session', async () => {
    const { provider } = harness({ current: 's1', keys: { s1: 'sk-s1' } })
    await expect(provider.resolve(KEY)).resolves.toEqual({ value: 'sk-s1', source: 'session' })
  })

  it('2. 别的引用不归它管，返回 undefined', async () => {
    const { provider } = harness({ current: 's1', keys: { s1: 'sk-s1' } })
    await expect(provider.resolve(OTHER)).resolves.toBeUndefined()
  })

  it('3. 不在 Agent turn 内（没有当前会话）时按未配置处理', async () => {
    const { provider } = harness({ keys: { s1: 'sk-s1' } })
    await expect(provider.resolve(KEY)).resolves.toBeUndefined()
  })

  it('4. 子代理会话没有自己的钥匙时，沿 parentSession 继承最近祖先的', async () => {
    const { provider } = harness({
      current: 'child',
      parents: { child: 'parent', parent: 'root' },
      keys: { root: 'sk-root' },
    })
    await expect(provider.resolve(KEY)).resolves.toEqual({ value: 'sk-root', source: 'session' })
  })

  it('5. 父链成环也不会死循环：环上无钥匙时返回 undefined，resolve 抛错', async () => {
    const { provider } = harness({
      current: 'a',
      parents: { a: 'b', b: 'a' },
    })
    // describe 只报告未配置，不抛。
    await expect(provider.describe(KEY)).resolves.toMatchObject({ configured: false, writable: false })
    // resolve 在没有钥匙时是硬失败，而不是借用别的租户。
    await expect(provider.resolve(KEY)).rejects.toThrow(/no model key for session "a"/)
  })

  it('6. 平台没有注入 sessionModelKeys 时抛错（部署缺陷不能静默）', async () => {
    const { provider } = harness({ current: 's1', withKeysService: false })
    await expect(provider.resolve(KEY)).rejects.toThrow(/did not provide sessionModelKeys/)
  })

  it('7. 会话存在但整条链都没有钥匙时抛错', async () => {
    const { provider } = harness({ current: 's1', parents: { s1: 's0' } })
    await expect(provider.resolve(KEY)).rejects.toThrow(/no model key for session "s1"/)
  })

  it('8. describe 反映当前是否有键，且永远不可写', async () => {
    const { provider, setCurrent } = harness({ current: 's1', keys: { s1: 'sk-s1' } })
    await expect(provider.describe(KEY)).resolves.toMatchObject({ configured: true, source: 'session', writable: false })
    setCurrent('s2')
    await expect(provider.describe(KEY)).resolves.toMatchObject({ configured: false, writable: false })
    await expect(provider.describe(OTHER)).resolves.toMatchObject({ configured: false, writable: false })
  })

  it('9. set / unset 一律拒绝：钥匙由平台按会话下发', async () => {
    const { provider } = harness({ current: 's1', keys: { s1: 'sk-s1' } })
    await expect(provider.set(KEY, 'x')).rejects.toThrow(/supplied by the platform per session/)
    await expect(provider.unset(KEY)).rejects.toThrow(/supplied by the platform per session/)
  })
})

describe('credentials-session：进程内记录（cookie 签名密钥等）', () => {
  it('10. modifyRecord 写入、readRecord 读回、listRecords 列地址', async () => {
    const { provider } = harness()
    const key = credentialKey('dsh-client', 'cookie')
    const record = { kind: 'grant' as const, payload: { secret: 'abc' } }

    await expect(
      provider.modifyRecord(key, async (current) => {
        expect(current).toBeUndefined()
        return record
      }),
    ).resolves.toEqual(record)

    await expect(provider.readRecord(key)).resolves.toEqual(record)
    await expect(provider.describeRecord(key)).resolves.toMatchObject({ configured: true, kind: 'grant', writable: true })
    await expect(provider.listRecords()).resolves.toEqual([{ key, kind: 'grant' }])
  })

  it('11. modifyRecord 返回 undefined 表示放弃写，保留当前值', async () => {
    const { provider } = harness()
    const key = credentialKey('dsh-client', 'cookie')
    const first = { kind: 'grant' as const, payload: 1 }
    await provider.modifyRecord(key, async () => first)

    await expect(provider.modifyRecord(key, async (current) => {
      expect(current).toEqual(first)
      return undefined
    })).resolves.toEqual(first)
    await expect(provider.readRecord(key)).resolves.toEqual(first)
  })

  it('12. deleteRecord 移除记录并广播一次记录更新事件', async () => {
    const { ctx, provider } = harness()
    const key = credentialKey('dsh-client', 'cookie')
    const events: string[] = []
    ctx.on('credentials/record-updated', (updated) => void events.push(String(updated)))

    await provider.modifyRecord(key, async () => ({ kind: 'grant', payload: 1 }))
    await provider.deleteRecord(key)

    expect(events).toEqual([String(key), String(key)])
    await expect(provider.readRecord(key)).resolves.toBeUndefined()
    await expect(provider.describeRecord(key)).resolves.toMatchObject({ configured: false, writable: true })
    // 再删一次是 no-op，不再广播。
    await provider.deleteRecord(key)
    expect(events).toHaveLength(2)
  })
})
