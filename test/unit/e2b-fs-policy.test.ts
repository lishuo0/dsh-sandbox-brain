import { describe, expect, it } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import E2bFileSystem from '../../packages/dsh-e2b/src/fs.js'
import { testContext } from '../helpers/brain.js'

/**
 * 沙箱文件提供者的写策略围栏。
 *
 * 内核边界之外还有一层「本次调用允不允许写」：`read-only` 全部拒绝，
 * `workspace-write` 只放行工作区根（和显式追加的根），`danger-full-access`
 * 放行。内部调用（上传、预览、导出）不带策略，仍受 VM 隔离约束，直接放行。
 */

interface Entry {
  type: 'file' | 'directory'
  size: number
  mtimeMs: number
  data: Uint8Array
}

function fakeWorld(seed: Record<string, string> = {}): {
  ctx: ReturnType<typeof testContext>
  files: Map<string, Entry>
} {
  const files = new Map<string, Entry>()
  for (const [path, text] of Object.entries(seed)) {
    const data = new TextEncoder().encode(text)
    files.set(path, { type: 'file', size: data.length, mtimeMs: 1, data })
  }
  const client = {
    files: {
      async read(path: string) {
        const entry = files.get(path)
        if (entry === undefined) throw new Error(`ENOENT ${path}`)
        return entry.data
      },
      async write(path: string, data: Uint8Array) {
        files.set(path, { type: 'file', size: data.length, mtimeMs: 2, data: new Uint8Array(data) })
      },
      async list() { return [] },
      async stat(path: string) {
        const entry = files.get(path)
        return entry === undefined ? undefined : { type: entry.type, size: entry.size, mtimeMs: entry.mtimeMs }
      },
      async remove(path: string) { files.delete(path) },
      async rename(from: string, to: string) {
        const entry = files.get(from)
        if (entry === undefined) throw new Error(`ENOENT ${from}`)
        files.delete(from)
        files.set(to, entry)
      },
      async makeDir(path: string) { files.set(path, { type: 'directory', size: 0, mtimeMs: 1, data: new Uint8Array() }) },
    },
  }
  const ctx = testContext({
    sandboxPolicy: { defaultMode: 'workspace-write' },
    sandboxes: {
      async ensureCurrent() { return { key: 'ws-1', workspaceRoot: '/desk' } },
      async client() { return client },
    },
  })
  return { ctx: ctx as ReturnType<typeof testContext>, files }
}

const readOnly = { mode: 'read-only' as const, workspaceRoot: '/desk' }
const workspaceWrite = { mode: 'workspace-write' as const, workspaceRoot: '/desk' }
const full = { mode: 'danger-full-access' as const, workspaceRoot: '/desk' }

async function denial(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    return error instanceof FsError ? error.code : `unexpected: ${String(error)}`
  }
}

describe('沙箱文件写策略', () => {
  it('sandboxMode 报出部署默认模式', () => {
    const { ctx } = fakeWorld()
    expect(new E2bFileSystem(ctx).sandboxMode).toBe('workspace-write')
  })

  it('read-only 拒绝写、改、删、移动', async () => {
    const { ctx, files } = fakeWorld({ '/desk/a.txt': 'old' })
    const fs = new E2bFileSystem(ctx)
    const inside = await fs.resolve('/desk/a.txt')
    const alsoInside = await fs.resolve('/desk/b.txt')

    expect(await denial(() => fs.writeText(inside, 'new', undefined, undefined, readOnly))).toBe('FS_SANDBOX_DENIED')
    expect(await denial(() => fs.editText(inside, { oldString: 'old', newString: 'new', replaceAll: false }, undefined, undefined, readOnly))).toBe('FS_SANDBOX_DENIED')
    expect(await denial(() => fs.deleteFile(inside, undefined, undefined, readOnly))).toBe('FS_SANDBOX_DENIED')
    expect(await denial(() => fs.moveFile(inside, alsoInside, {}, undefined, readOnly))).toBe('FS_SANDBOX_DENIED')
    expect(files.get('/desk/a.txt')?.data).toEqual(new TextEncoder().encode('old'))
  })

  it('workspace-write 只放行工作区根下的路径', async () => {
    const { ctx, files } = fakeWorld()
    const fs = new E2bFileSystem(ctx)
    const inside = await fs.resolve('/desk/notes/todo.md')
    await fs.writeText(inside, '# 今天', undefined, undefined, workspaceWrite)
    expect(new TextDecoder().decode(files.get('/desk/notes/todo.md')?.data)).toBe('# 今天')

    const outside = await fs.resolve('/etc/passwd')
    expect(await denial(() => fs.writeText(outside, 'pwned', undefined, undefined, workspaceWrite))).toBe('FS_SANDBOX_DENIED')
    // 前缀相同的兄弟目录不算工作区。
    const sibling = await fs.resolve('/desktop/x')
    expect(await denial(() => fs.writeText(sibling, 'x', undefined, undefined, workspaceWrite))).toBe('FS_SANDBOX_DENIED')
    expect(files.has('/etc/passwd')).toBe(false)
  })

  it('移动时源和目标任一越界都拒绝', async () => {
    const { ctx, files } = fakeWorld({ '/desk/a.txt': 'x' })
    const fs = new E2bFileSystem(ctx)
    const inside = await fs.resolve('/desk/a.txt')
    const outside = await fs.resolve('/etc/a.txt')
    expect(await denial(() => fs.moveFile(inside, outside, {}, undefined, workspaceWrite))).toBe('FS_SANDBOX_DENIED')
    expect(files.has('/desk/a.txt')).toBe(true)

    const outsideSource = await fs.resolve('/etc/b.txt')
    const insideTarget = await fs.resolve('/desk/b.txt')
    expect(await denial(() => fs.moveFile(outsideSource, insideTarget, {}, undefined, workspaceWrite))).toBe('FS_SANDBOX_DENIED')
  })

  it('additionalWritableRoots 里的目录按配置放行', async () => {
    const { ctx } = fakeWorld()
    const fs = new E2bFileSystem(ctx)
    const shared = await fs.resolve('/shared/report.md')
    await fs.writeText(shared, 'ok', undefined, undefined, { ...workspaceWrite, additionalWritableRoots: ['/shared'] })
  })

  it('danger-full-access 和内部调用（无策略）都能写', async () => {
    const { ctx, files } = fakeWorld()
    const fs = new E2bFileSystem(ctx)
    const outside = await fs.resolve('/tmp/x.txt')
    await fs.writeText(outside, 'a', undefined, undefined, full)
    await fs.writeText(outside, 'b', undefined, undefined, undefined)
    expect(new TextDecoder().decode(files.get('/tmp/x.txt')?.data)).toBe('b')
  })
})
