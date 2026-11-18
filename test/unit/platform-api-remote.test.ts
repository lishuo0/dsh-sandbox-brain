import { describe, expect, it } from 'vitest'
import { createGateway } from '../../packages/dsh-platform-api/src/gateway.ts'
import { testContext } from '../helpers/brain.ts'

/**
 * `gateway.remote`：把平台转发来的 Typert Remote 调用交给脑内的
 * `typertGateway`。定时任务是唯一的这种命名空间，平台补好成员范围后
 * 只走 `/brain/v1/schedule/*`，脑不会对网络开放 `/api/*`。
 */

interface Invocation {
  namespace: string
  method: string
  args: Record<string, unknown>
  principal: unknown
  interactions: unknown
  abortedAtCall: boolean
}

function fakeGateway(result: unknown, invocations: Invocation[]) {
  return {
    async invoke(request: {
      namespace: string
      method: string
      args: Record<string, unknown>
      peer: { principal: unknown; interactions: unknown; signal: AbortSignal }
    }) {
      invocations.push({
        namespace: request.namespace,
        method: request.method,
        args: request.args,
        principal: request.peer.principal,
        interactions: request.peer.interactions,
        abortedAtCall: request.peer.signal.aborted,
      })
      return result
    },
  }
}

describe('gateway.remote', () => {
  it('以 owner Peer 调用 typertGateway，参数原样传下去', async () => {
    const invocations: Invocation[] = []
    const gateway = createGateway(testContext({ typertGateway: fakeGateway([{ id: 'sch_1' }], invocations) }))
    const value = await gateway.remote?.('schedule', 'catalog', { sessionIds: ['s1'] })

    expect(value).toEqual([{ id: 'sch_1' }])
    expect(invocations).toEqual([{
      namespace: 'schedule',
      method: 'catalog',
      args: { sessionIds: ['s1'] },
      principal: { kind: 'owner' },
      interactions: 'answer',
      abortedAtCall: false,
    }])
  })

  it('每次调用用一个短命 Peer，调用结束就销毁', async () => {
    const peers: Array<{ signal: AbortSignal }> = []
    const gateway = createGateway(testContext({
      typertGateway: {
        async invoke(request: { peer: { signal: AbortSignal } }) {
          peers.push(request.peer)
          return {}
        },
      },
    }))
    await gateway.remote?.('schedule', 'deliveryLimits', {})
    expect(peers).toHaveLength(1)
    expect(peers[0]!.signal.aborted).toBe(true)
  })

  it('没有 typertGateway 时按 501 拒绝', async () => {
    const gateway = createGateway(testContext({}))
    await expect(gateway.remote?.('schedule', 'catalog', {})).rejects.toMatchObject({
      status: 501,
      code: 'not-supported',
    })
  })

  it('业务错误原样抛回，不吞成网关错误', async () => {
    const failure = Object.assign(new Error('bad rule'), { code: 'invalid_rule' })
    const gateway = createGateway(testContext({
      typertGateway: {
        async invoke() {
          throw failure
        },
      },
    }))
    await expect(gateway.remote?.('schedule', 'create', {})).rejects.toBe(failure)
  })
})
