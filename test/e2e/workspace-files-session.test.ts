import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import WorkspaceFiles, { type Config as WorkspaceFilesConfig } from '@deepseek-ai/dsh-api-workspace-files'
import E2bFileSystem from '../../packages/dsh-e2b/src/fs.ts'
import { MockPlatform } from '../../packages/dsh-e2b/src/mock-adapter.ts'
import SandboxRegistry, { type SessionOwner } from '../../packages/dsh-e2b/src/registry.ts'
import { apply } from '../../packages/dsh-e2b/src/workspace-files.ts'
import { call, FakeWebServer, startBrainServer, testContext, type BrainServer } from '../helpers/brain.ts'

/**
 * 浏览器直连的工作区文件：真实 HTTP → workspaceFiles → ctx.fs → E2B 注册表（mock
 * 适配器落本地目录）。请求本身没有发起 Agent，会话身份只能来自请求作用域；
 * 这条用例盯住「文件树按会话路由到自己的工作区沙箱」以及不经该作用域就失败。
 */

const ROOT = '/desk'

const owners = new Map<string, SessionOwner>([
  ['s1', { userId: 'u1', workspaceId: 'w1' }],
  ['s2', { userId: 'u1', workspaceId: 'w2' }],
])

const FILE_CONFIG: WorkspaceFilesConfig = {
  maxBytes: 2 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  maxLines: 5000,
  maxEntries: 2000,
  search: { maxResults: 512, maxEntries: 100000, graceMs: 3000, timeoutMs: 30000, stderrMaxBytes: 65536 },
}

let objectDir = ''
let rootDir = ''
let brain: BrainServer
let ctx: Context
let files: WorkspaceFiles

function route(web: FakeWebServer, path: string, handler: (sessionId: string, path: string) => Promise<unknown>): void {
  web.register({
    kind: 'exact',
    path,
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const target = url.searchParams.get('path') ?? ROOT
      void handler(sessionId, target).then(
        (value) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(value))
        },
        (error: unknown) => {
          const shaped = error as { code?: string; message?: string }
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ code: shaped.code, message: shaped.message ?? String(error) }))
        },
      )
    },
  })
}

beforeAll(async () => {
  objectDir = await mkdtemp(join(tmpdir(), 'dsh-wf-objects-'))
  rootDir = await mkdtemp(join(tmpdir(), 'dsh-wf-root-'))
  await mkdir(join(objectDir, 'desks', 'w1'), { recursive: true })
  await mkdir(join(objectDir, 'desks', 'w2'), { recursive: true })
  await writeFile(join(objectDir, 'desks', 'w1', 'alpha.txt'), 'one\n')
  await writeFile(join(objectDir, 'desks', 'w2', 'beta.txt'), 'two\n')

  const web = new FakeWebServer()
  ctx = testContext({
    webServer: web,
    sessionDirectory: { owner: async (id: string) => owners.get(id) },
    sessions: { get: () => undefined },
    sandboxPolicy: { workspaceRoot: ROOT },
    typert: { lookups: { register: () => () => undefined } },
  })
  new SandboxRegistry(ctx, {
    adapter: 'mock',
    scope: 'workspace',
    platform: new MockPlatform({ objectDir, rootDir }),
    directory: ctx.get('sessionDirectory'),
    mock: { objectDir, rootDir },
    ossMounts: [
      { bucketName: 'test', endpoint: 'test', bucketPath: 'desks/{workspaceId}', mountDir: ROOT, readOnly: false },
    ],
  })
  new E2bFileSystem(ctx)
  files = new WorkspaceFiles(ctx, FILE_CONFIG)
  await apply(ctx)

  route(web, '/test/workspace-files/list', async (sessionId, path) => {
    return await files.list({ sessionId, workspaceRoot: ROOT }, path, new AbortController().signal)
  })
  // 对照组：不经过请求作用域，直接问文件系统要沙箱。
  route(web, '/test/no-session/list', async (_sessionId, path) => {
    return await ctx.fs.resolve(path)
  })

  brain = await startBrainServer(ctx)
})

afterAll(async () => {
  await brain.close()
  await rm(objectDir, { recursive: true, force: true })
  await rm(rootDir, { recursive: true, force: true })
})

interface Listing {
  path: string
  entries: Array<{ name: string; type: string }>
}

describe('workspaceFiles：浏览器请求的会话沙箱作用域', () => {
  it('按请求里的会话列出该工作区的目录', async () => {
    const response = await call(brain.baseUrl, '/test/workspace-files/list?sessionId=s1&path=%2Fdesk')
    expect(response.status).toBe(200)
    const listing = response.json() as Listing
    expect(listing.path).toBe('')
    expect(listing.entries.map((entry) => entry.name)).toContain('alpha.txt')
  })

  it('不同工作区的会话看到自己的文件', async () => {
    const response = await call(brain.baseUrl, '/test/workspace-files/list?sessionId=s2&path=%2Fdesk')
    expect(response.status).toBe(200)
    const names = (response.json() as Listing).entries.map((entry) => entry.name)
    expect(names).toContain('beta.txt')
    expect(names).not.toContain('alpha.txt')
  })

  it('没有会话作用域时注册表仍然拒绝绑定沙箱', async () => {
    const response = await call(brain.baseUrl, '/test/no-session/list?path=%2Fdesk')
    expect(response.status).toBe(500)
    expect(response.json()).toMatchObject({ code: 'FS_IO_ERROR', message: 'no sandbox for this session' })
  })
})
