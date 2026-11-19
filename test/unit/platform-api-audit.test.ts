import { describe, expect, it } from 'vitest'
import { apply } from '../../packages/dsh-platform-api/src/index.ts'
import { auditUpgradeRoutes } from '../../packages/dsh-platform-api/src/session-stream.ts'
import { SESSION_SOCKET_PATH } from '../../packages/dsh-platform-api/src/session-socket.ts'
import { FakeWebServer, testContext } from '../helpers/brain.ts'

/**
 * “未文档化接口不许存在”的机器闸门：脑只允许一条 Upgrade 路由——会话 socket
 * （`/brain/v1/session/socket`）。任何别的 WSS 都是绕过文档的隐式接口，启动时
 * 审计一次，违反即启动失败。
 */

describe('Upgrade 路由审计', () => {
  it('没有 Upgrade 注册时通过并返回空数组', () => {
    expect(auditUpgradeRoutes(new FakeWebServer())).toEqual([])
  })

  it('只放行文档里那一条会话 socket', () => {
    const web = new FakeWebServer()
    web.registerUpgrade({ path: SESSION_SOCKET_PATH, handler: () => undefined })
    expect(auditUpgradeRoutes(web, [SESSION_SOCKET_PATH])).toEqual([SESSION_SOCKET_PATH])
  })

  it('注册了别的 Upgrade 路由就抛错，并指出路径', () => {
    const web = new FakeWebServer()
    web.registerUpgrade({ path: '/api/remote.mux', handler: () => undefined })
    expect(() => auditUpgradeRoutes(web, [SESSION_SOCKET_PATH])).toThrow(/undocumented Upgrade routes/)
    expect(() => auditUpgradeRoutes(web, [SESSION_SOCKET_PATH])).toThrow(/\/api\/remote\.mux/)
  })

  it('apply() 启动时就在已有的违规 Upgrade 路由上失败', () => {
    const web = new FakeWebServer()
    web.registerUpgrade({ path: '/api/remote.mux', handler: () => undefined })
    expect(() => apply(testContext({ webServer: web }), {
      apps: [{ appId: 'platform', appKey: 'p'.repeat(24) }],
    })).toThrow(/undocumented Upgrade routes/)
  })

  it('apply() 只注册会话 socket 这一条 Upgrade', () => {
    const web = new FakeWebServer()
    apply(testContext({ webServer: web }), {
      apps: [{ appId: 'platform', appKey: 'p'.repeat(24) }],
    })
    expect([...web.upgrades.keys()]).toEqual([SESSION_SOCKET_PATH])
  })
})