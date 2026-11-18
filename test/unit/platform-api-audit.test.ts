import { describe, expect, it } from 'vitest'
import { apply } from '../../packages/dsh-platform-api/src/index.ts'
import { auditUpgradeRoutes } from '../../packages/dsh-platform-api/src/session-stream.ts'
import { FakeWebServer, testContext } from '../helpers/brain.ts'

/**
 * “未文档化接口不许存在”的机器闸门：脑不注册任何 Upgrade 路由。
 * 启动时审计一次，`apply()` 在违反时必须直接抛错，而不是留下一个全局 WSS。
 */

describe('Upgrade 路由审计', () => {
  it('没有任何 Upgrade 注册时通过并返回空数组', () => {
    expect(auditUpgradeRoutes(new FakeWebServer())).toEqual([])
  })

  it('一旦注册了 Upgrade 路由就抛错，并指出路径', () => {
    const web = new FakeWebServer()
    web.registerUpgrade({ path: '/api/remote.mux', handler: () => undefined })
    expect(() => auditUpgradeRoutes(web)).toThrow(/no Upgrade routes/)
    expect(() => auditUpgradeRoutes(web)).toThrow(/\/api\/remote\.mux/)
  })

  it('apply() 启动时就在已存在的 Upgrade 路由上失败', () => {
    const web = new FakeWebServer()
    web.registerUpgrade({ path: '/api/remote.mux', handler: () => undefined })
    expect(() => apply(testContext({ webServer: web }), {
      apps: [{ appId: 'platform', appKey: 'p'.repeat(24) }],
    })).toThrow(/no Upgrade routes/)
  })
})
