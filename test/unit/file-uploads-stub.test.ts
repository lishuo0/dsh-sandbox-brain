import { describe, expect, it } from 'vitest'
import FileUploadsStub from '../../packages/dsh-file-uploads-stub/src/index.ts'
import { testContext } from '../helpers/brain.ts'

/**
 * 平台收口上传面时，脑侧的 `fileUploads` 只能是惰性占位：
 * session-controller 的装配依赖必须被满足，但不能因此凭空出现「未知回执」的成功解。
 */

describe('fileUploads 占位服务', () => {
  it('以 fileUploads 名字注册，满足 session-controller 的 inject', () => {
    const ctx = testContext()
    new FileUploadsStub(ctx)
    const service = ctx.get('fileUploads') as { resolve(agent: unknown, receiptId: string): unknown }
    expect(service).toBeDefined()
    expect(service.resolve({}, 'r')).toBeUndefined()
    expect(FileUploadsStub.inject).toEqual([])
  })

  it('任何回执都解析为 unknown，不伪造上传成功', () => {
    const stub = new FileUploadsStub(testContext())
    expect(stub.resolve({}, 'receipt-1')).toBeUndefined()
  })

  it('resolver 注册可撤销，重复注册报错', () => {
    const stub = new FileUploadsStub(testContext())
    const dispose = stub.registerAgentResolver(async () => undefined)
    expect(typeof dispose).toBe('function')
    expect(() => stub.registerAgentResolver(async () => undefined)).toThrow(/already registered/)
    dispose()
    // 撤销后可以重新注册（Cordis 的 effect 重载会走这条路径）。
    const again = stub.registerAgentResolver(async () => undefined)
    expect(typeof again).toBe('function')
  })

  it('bindPrompt 返回可 commit / 可 dispose 的绑定，retirePrompt 无副作用', () => {
    const stub = new FileUploadsStub(testContext())
    const binding = stub.bindPrompt({}, ['r1'], 'req-1')
    expect(() => binding.commit()).not.toThrow()
    const dispose = Reflect.get(Symbol, 'dispose') as symbol | undefined
    if (dispose !== undefined) {
      expect(() => (binding as unknown as Record<symbol, () => void>)[dispose]?.()).not.toThrow()
    }
    expect(() => stub.retirePrompt({}, 'req-1')).not.toThrow()
  })
})
