import { describe, expect, it } from 'vitest'
import { chooseServers, filterSelected, type McpRow } from '../../packages/dsh-user-mcp/src/index.ts'

function row(partial: Partial<McpRow> & Pick<McpRow, 'server_name'>): McpRow {
  return {
    user_id: 'alice',
    transport: 'streamable-http',
    target: 'https://mcp.example.com/x',
    config: {},
    scope: 'private',
    ...partial,
  }
}

describe('用户 MCP 选择', () => {
  it('私有和公开同名时私有覆盖公开', () => {
    const publicRow = row({ server_name: 'search', scope: 'public', user_id: 'admin', target: 'https://public' })
    const privateRow = row({ server_name: 'search', scope: 'private', user_id: 'alice', target: 'https://private' })
    expect(chooseServers([publicRow, privateRow])).toEqual([privateRow])
    // 顺序反过来也一样。
    expect(chooseServers([privateRow, publicRow])).toEqual([privateRow])
  })

  it('只有公开时用公开行，并保留 owner', () => {
    const publicRow = row({ server_name: 'search', scope: 'public', user_id: 'admin' })
    expect(chooseServers([publicRow])).toEqual([publicRow])
  })

  it('过滤非 streamable-http 的传输，避免在脑宿主起进程', () => {
    const stdio = row({ server_name: 'local', transport: 'stdio' })
    const http = row({ server_name: 'remote' })
    expect(chooseServers([stdio, http])).toEqual([http])
  })

  it('按名字排序输出', () => {
    const rows = [row({ server_name: 'zeta' }), row({ server_name: 'alpha' }), row({ server_name: 'mike' })]
    expect(chooseServers(rows).map((item) => item.server_name)).toEqual(['alpha', 'mike', 'zeta'])
  })
})

describe('工作区选择过滤', () => {
  const rows = [
    row({ server_name: 'search', scope: 'private' }),
    row({ server_name: 'search', scope: 'public', user_id: 'admin' }),
    row({ server_name: 'docs', scope: 'public', user_id: 'admin' }),
  ]

  it('没配置过时原样保留，沿用全部启用', () => {
    expect(filterSelected(rows, undefined)).toEqual(rows)
  })

  it('明确一个都不选时全部过滤掉', () => {
    expect(filterSelected(rows, [])).toEqual([])
  })

  it('按名字 + 作用域精确匹配，同名不同作用域不串', () => {
    expect(filterSelected(rows, [{ name: 'search', scope: 'public' }])).toEqual([rows[1]])
    expect(filterSelected(rows, [{ name: 'search', scope: 'private' }])).toEqual([rows[0]])
  })
})
