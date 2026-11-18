import { posix } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_HEADERS } from '../../packages/dsh-platform-api/src/auth.ts'
import { PREFIX, registerRoutes } from '../../packages/dsh-platform-api/src/routes.ts'
import {
  call,
  FakeWebServer,
  MemoryGateway,
  startBrainServer,
  testContext,
  type BrainServer,
} from '../helpers/brain.ts'

/**
 * 工作区文件接缝：真实 HTTP → routes → workspace-files，落点是内存沙箱。
 *
 * 验的是「路径永远留在本会话沙箱里」：别名 `/workspace-<id>`、相对路径、
 * 真实绝对路径都映射到同一个 workspaceRoot；`..` 与符号链接一律 403；
 * 大文件按预览上限拒绝而不是截断。文件读写走 sandbox files 服务，测试用
 * 内存实现，不碰脑宿主文件系统。
 */

const appKey = 'w'.repeat(24)
const auth = { 'x-app-id': 'platform', 'x-app-key': appKey }
const ROOT = '/desk'
const MTIME = 1_700_000_000_000

interface MemFile {
  data: Uint8Array
  mtimeMs: number
}

interface MemFiles {
  read(path: string): Promise<Uint8Array>
  write(path: string, data: Uint8Array): Promise<void>
  list(path: string): Promise<Array<{ name: string; type: 'file' | 'directory' | 'symlink' | 'other'; size?: number }>>
  stat(path: string): Promise<{ path: string; type: 'file' | 'directory' | 'symlink' | 'other'; size: number; mtimeMs: number } | undefined>
}

function memoryFiles() {
  const files = new Map<string, MemFile>()
  const dirs = new Set<string>([ROOT])
  const links = new Set<string>()

  const addParents = (path: string): void => {
    let parent = posix.dirname(path)
    while (parent.startsWith(`${ROOT}/`) || parent === ROOT) {
      dirs.add(parent)
      if (parent === ROOT) break
      parent = posix.dirname(parent)
    }
  }

  const put = (path: string, text: string): void => {
    addParents(path)
    files.set(path, { data: Buffer.from(text), mtimeMs: MTIME })
  }

  put(`${ROOT}/notes.txt`, 'one\ntwo\nthree\n')
  put(`${ROOT}/sub/inner.txt`, 'inner')
  files.set(`${ROOT}/blob.bin`, { data: Buffer.from([0, 1, 2, 3, 4]), mtimeMs: MTIME })
  links.add(`${ROOT}/link`)

  const stat = async (path: string) => {
    if (links.has(path)) return { path, type: 'symlink' as const, size: 0, mtimeMs: MTIME }
    const file = files.get(path)
    if (file !== undefined) {
      return { path, type: 'file' as const, size: file.data.byteLength, mtimeMs: file.mtimeMs }
    }
    if (dirs.has(path)) return { path, type: 'directory' as const, size: 0, mtimeMs: MTIME }
    return undefined
  }

  const files$: MemFiles = {
    async read(path) {
      const file = files.get(path)
      if (file === undefined) throw new Error(`ENOENT: ${path}`)
      return file.data
    },
    async write(path, data) {
      addParents(path)
      files.set(path, { data: Uint8Array.from(data), mtimeMs: MTIME })
    },
    async list(path) {
      const prefix = path === ROOT ? `${ROOT}/` : `${path}/`
      const names = new Set<string>()
      for (const key of [...files.keys(), ...dirs, ...links]) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest === '' || rest.includes('/')) continue
        names.add(rest)
      }
      return [...names].sort().map(name => {
        const full = `${path === ROOT ? ROOT : path}/${name}`
        if (links.has(full)) return { name, type: 'symlink' as const }
        const file = files.get(full)
        if (file !== undefined) return { name, type: 'file' as const, size: file.data.byteLength }
        return { name, type: 'directory' as const }
      })
    },
    stat,
  }
  return files$
}

function sandboxServices(files: MemFiles) {
  return {
    async ensure() {
      return { workspaceRoot: ROOT }
    },
    async client() {
      return { files }
    },
  }
}

let brain: BrainServer
let files: MemFiles

function filesUrl(sessionId: string, ...segments: string[]): string {
  return [PREFIX, sessionId, 'workspace-files', ...segments].join('/')
}

function q(params: Record<string, string | number>): string {
  return new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString()
}

beforeAll(async () => {
  files = memoryFiles()
  const ctx = testContext({
    webServer: new FakeWebServer(),
    sandboxes: sandboxServices(files),
    sessionDirectory: {
      async owner(id: string) {
        return id === 'sess-dir' ? { userId: 'u1', workspaceId: 'w2' } : undefined
      },
    },
  })
  registerRoutes(ctx, {
    gateway: new MemoryGateway(),
    credentials: [{ appId: 'platform', appKey }],
    headers: DEFAULT_HEADERS,
  })
  brain = await startBrainServer(ctx)
})

afterAll(async () => {
  await brain.close()
})

describe('workspace-files：列出与路径约束', () => {
  it('用 /workspace-<id> 别名列出工作区根目录', async () => {
    const response = await call(brain.baseUrl, `${filesUrl('s1')}?${q({ path: '/workspace-w1' })}`, {
      headers: { ...auth, 'x-dsh-workspace-id': 'w1' },
    })
    expect(response.status).toBe(200)
    expect(response.json()).toEqual({
      path: '',
      truncated: false,
      entries: [
        { name: 'blob.bin', type: 'file', size: 5 },
        { name: 'link', type: 'other' },
        { name: 'notes.txt', type: 'file', size: 14 },
        { name: 'sub', type: 'directory' },
      ],
    })
  })

  it('相对路径从工作区根解析', async () => {
    const response = await call(brain.baseUrl, `${filesUrl('s1')}?${q({ path: 'sub' })}`, {
      headers: { ...auth, 'x-dsh-workspace-id': 'w1' },
    })
    expect(response.status).toBe(200)
    expect(response.json()).toEqual({
      path: 'sub',
      truncated: false,
      entries: [{ name: 'inner.txt', type: 'file', size: 5 }],
    })
  })

  it('没有请求头时用 sessionDirectory 的工作区归属', async () => {
    const response = await call(brain.baseUrl, `${filesUrl('sess-dir')}?${q({ path: '/workspace-w2' })}`, {
      headers: auth,
    })
    expect(response.status).toBe(200)
    expect((response.json() as { entries: unknown[] }).entries).toHaveLength(4)
  })

  it('.. 逃逸出工作区被拒绝', async () => {
    const response = await call(brain.baseUrl, `${filesUrl('s1')}?${q({ path: '../outside' })}`, {
      headers: { ...auth, 'x-dsh-workspace-id': 'w1' },
    })
    expect(response.status).toBe(403)
    expect((response.json() as { error: { code: string } }).error.code).toBe('workspace-file/outside-workspace')
  })

  it('指向工作区外的符号链接被拒绝', async () => {
    const response = await call(brain.baseUrl, `${filesUrl('s1', 'stat')}?${q({ path: '/workspace-w1/link' })}`, {
      headers: { ...auth, 'x-dsh-workspace-id': 'w1' },
    })
    expect(response.status).toBe(403)
    expect((response.json() as { error: { message: string } }).error.message).toMatch(/symlink/)

    // 整个目录列出时链接只作为 other 出现，不跟随。
    const list = await call(brain.baseUrl, `${filesUrl('s1')}?${q({ path: '/workspace-w1' })}`, {
      headers: { ...auth, 'x-dsh-workspace-id': 'w1' },
    })
    expect((list.json() as { entries: Array<{ name: string; type: string }> }).entries).toContainEqual({
      name: 'link',
      type: 'other',
    })
  })

  it('未知子动作 404', async () => {
    const response = await call(brain.baseUrl, filesUrl('s1', 'delete'), {
      headers: { ...auth, 'x-dsh-workspace-id': 'w1' },
    })
    expect(response.status).toBe(404)
  })
})

describe('workspace-files：读取', () => {
  it('stat 返回客户端别名、版本与字节数', async () => {
    const response = await call(brain.baseUrl, `${filesUrl('s1', 'stat')}?${q({ path: '/workspace-w1/notes.txt' })}`, {
      headers: { ...auth, 'x-dsh-workspace-id': 'w1' },
    })
    expect(response.status).toBe(200)
    expect(response.json()).toEqual({
      absolutePath: '/workspace-w1/notes.txt',
      version: `${MTIME}:14`,
      bytes: 14,
    })
  })

  it('文本按行分页', async () => {
    const response = await call(
      brain.baseUrl,
      `${filesUrl('s1', 'content')}?${q({ path: '/workspace-w1/notes.txt', offset: 2, limit: 1 })}`,
      { headers: { ...auth, 'x-dsh-workspace-id': 'w1' } },
    )
    expect(response.status).toBe(200)
    expect(response.json()).toMatchObject({
      absolutePath: '/workspace-w1/notes.txt',
      offset: 2,
      text: 'two',
      lines: 1,
      eof: false,
    })
  })

  it('相对文件名按 baseFile 的目录拼接', async () => {
    const response = await call(
      brain.baseUrl,
      `${filesUrl('s1', 'content')}?${q({ path: 'inner.txt', baseFile: '/workspace-w1/sub/existing.txt' })}`,
      { headers: { ...auth, 'x-dsh-workspace-id': 'w1' } },
    )
    expect(response.status).toBe(200)
    expect(response.json()).toMatchObject({ text: 'inner', eof: true })
  })

  it('二进制按 offset/length 切片并 base64 返回', async () => {
    const response = await call(
      brain.baseUrl,
      `${filesUrl('s1', 'content')}?${q({ path: '/workspace-w1/blob.bin', bytes: 1, offset: 1, length: 2 })}`,
      { headers: { ...auth, 'x-dsh-workspace-id': 'w1' } },
    )
    expect(response.status).toBe(200)
    expect(response.json()).toEqual({
      absolutePath: '/workspace-w1/blob.bin',
      version: `${MTIME}:5`,
      bytes: 5,
      offset: 1,
      data: Buffer.from([1, 2]).toString('base64'),
      eof: false,
    })
  })

  it('文本模式读二进制内容返回 415', async () => {
    const response = await call(
      brain.baseUrl,
      `${filesUrl('s1', 'content')}?${q({ path: '/workspace-w1/blob.bin' })}`,
      { headers: { ...auth, 'x-dsh-workspace-id': 'w1' } },
    )
    expect(response.status).toBe(415)
    expect((response.json() as { error: { code: string } }).error.code).toBe('workspace-file/not-text')
  })

  it('文件不存在时 404', async () => {
    const response = await call(brain.baseUrl, `${filesUrl('s1', 'stat')}?${q({ path: '/workspace-w1/missing' })}`, {
      headers: { ...auth, 'x-dsh-workspace-id': 'w1' },
    })
    expect(response.status).toBe(404)
    expect((response.json() as { error: { code: string } }).error.code).toBe('workspace-file/not-found')
  })
})

describe('workspace-files：上传', () => {
  async function upload(query: string, body: string): Promise<{ status: number; json: unknown }> {
    const response = await fetch(`${brain.baseUrl}${filesUrl('s1', 'upload')}?${query}`, {
      method: 'POST',
      headers: { ...auth, 'x-dsh-workspace-id': 'w1', 'content-type': 'application/octet-stream' },
      body,
    })
    return { status: response.status, json: await response.json() }
  }

  it('写入指定目录并返回客户端路径', async () => {
    const created = await upload(q({ path: '/workspace-w1/sub', name: 'uploaded.txt' }), 'uploaded body')
    expect(created.status).toBe(200)
    expect(created.json).toEqual({
      name: 'uploaded.txt',
      path: '/workspace-w1/sub/uploaded.txt',
      bytes: 13,
    })

    const read = await call(
      brain.baseUrl,
      `${filesUrl('s1', 'content')}?${q({ path: '/workspace-w1/sub/uploaded.txt' })}`,
      { headers: { ...auth, 'x-dsh-workspace-id': 'w1' } },
    )
    expect(read.json()).toMatchObject({ text: 'uploaded body', eof: true })
  })

  it('文件名必须是单段，越界立即拒绝', async () => {
    const escaped = await upload(q({ path: '/workspace-w1/sub', name: '../evil.txt' }), 'x')
    expect(escaped.status).toBe(400)
    expect((escaped.json as { error: { code: string } }).error.code).toBe('invalid-name')
  })

  it('上传目标是文件时 400', async () => {
    const response = await upload(q({ path: '/workspace-w1/notes.txt', name: 'x.txt' }), 'x')
    expect(response.status).toBe(400)
    expect((response.json as { error: { code: string } }).error.code).toBe('workspace-file/not-directory')
  })
})

describe('workspace-files：未装配沙箱', () => {
  it('没有 sandboxes 服务时 501，而不是假装空目录', async () => {
    const ctx = testContext({ webServer: new FakeWebServer() })
    registerRoutes(ctx, {
      gateway: new MemoryGateway(),
      credentials: [{ appId: 'platform', appKey }],
      headers: DEFAULT_HEADERS,
    })
    const bare = await startBrainServer(ctx)
    try {
      const response = await call(bare.baseUrl, `${filesUrl('s1')}?${q({ path: '/workspace-w1' })}`, {
        headers: { ...auth, 'x-dsh-workspace-id': 'w1' },
      })
      expect(response.status).toBe(501)
      expect((response.json() as { error: { code: string } }).error.code).toBe('not-supported')
    } finally {
      await bare.close()
    }
  })
})
