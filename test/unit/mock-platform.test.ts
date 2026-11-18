import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MockPlatform } from '../../packages/dsh-e2b/src/mock-adapter.ts'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function mounted() {
  const objectDir = await tempDir('dsh-objects-')
  const rootDir = await tempDir('dsh-sandboxes-')
  const platform = new MockPlatform({ objectDir, rootDir })
  const handle = await platform.create({
    key: 'k',
    template: 'mock',
    timeoutMs: 60_000,
    workspaceRoot: '/desk/w1',
    mounts: [
      { bucketName: 'b', bucketPath: 'desks/w1', endpoint: 'x', mountDir: '/desk/w1' },
      { bucketName: 'b', bucketPath: 'members/u1/skills', endpoint: 'x', mountDir: '/skillbox/own' },
      { bucketName: 'b', bucketPath: 'common/skills', endpoint: 'x', mountDir: '/skillbox/common', readOnly: true },
    ],
  })
  const client = await platform.client(handle.externalId)
  return { platform, handle, client, objectDir }
}

describe('MockPlatform', () => {
  it('共享模式下挂载点落在对象目录', async () => {
    const { client, objectDir } = await mounted()
    await client.files.write('/skillbox/own/report/SKILL.md', Buffer.from('# report'))
    expect((await readFile(join(objectDir, 'members/u1/skills/report/SKILL.md'))).toString()).toBe('# report')
    expect(Buffer.from(await client.files.read('/skillbox/own/report/SKILL.md')).toString()).toBe('# report')
  })

  it('一个挂载点看不到另一个挂载点的目录', async () => {
    const { client, objectDir } = await mounted()
    await client.files.write('/desk/w1/out.txt', Buffer.from('hi'))
    expect((await readFile(join(objectDir, 'desks/w1/out.txt'))).toString()).toBe('hi')
    const own = await client.files.list('/skillbox/own')
    expect(own).toEqual([])
  })

  it('越出挂载点或未挂载的路径被拒绝', async () => {
    const { client } = await mounted()
    await expect(client.files.read('/skillbox/own/../../desks/w1/out.txt')).rejects.toMatchObject({
      failure: { kind: 'unauthorized' },
    })
    await expect(client.files.read('/etc/passwd')).rejects.toMatchObject({ failure: { kind: 'unauthorized' } })
  })

  it('stat 对缺失路径返回 undefined', async () => {
    const { client } = await mounted()
    expect(await client.files.stat('/desk/w1/nope.txt')).toBeUndefined()
    expect(await client.files.stat('/desk/w1')).toMatchObject({ type: 'directory' })
  })

  it('stat 沿祖先探测未挂载目录返回 undefined，读操作仍然被拒', async () => {
    const { client } = await mounted()
    // 指令加载器会从 cwd 向上找 .git 之类的根标记；/desk 本身不是挂载点。
    expect(await client.files.stat('/desk/.git')).toBeUndefined()
    await expect(client.files.read('/desk/.git/HEAD')).rejects.toMatchObject({ failure: { kind: 'unauthorized' } })
  })

  it('目录列举与改名', async () => {
    const { client, objectDir } = await mounted()
    await client.files.write('/desk/w1/a.txt', Buffer.from('a'))
    await client.files.write('/desk/w1/sub/b.txt', Buffer.from('b'))
    const entries = await client.files.list('/desk/w1')
    expect(entries.map((entry) => entry.name).sort()).toEqual(['a.txt', 'sub'])
    await client.files.rename('/desk/w1/a.txt', '/desk/w1/renamed.txt')
    expect(await client.files.stat('/desk/w1/renamed.txt')).toMatchObject({ type: 'file', size: 1 })
    await client.files.remove('/desk/w1/sub')
    expect((await readdir(join(objectDir, 'desks/w1'))).sort()).toEqual(['renamed.txt'])
  })

  it('进程在挂载目录里执行并返回输出', async () => {
    const { client } = await mounted()
    await client.files.write('/desk/w1/input.txt', Buffer.from('skill-input'))
    const { pid } = await client.process.start({
      argv: ['sh', '-c', 'cat input.txt && echo && echo executed'],
      cwd: '/desk/w1',
    })
    const status = await client.process.wait(pid)
    expect(status).toMatchObject({ state: 'exited', exitCode: 0 })
    const chunks: Uint8Array[] = []
    for await (const chunk of client.process.connect(pid)) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString()).toBe('skill-input\nexecuted\n')
  })

  it('进程退出码与状态可查', async () => {
    const { client } = await mounted()
    const { pid } = await client.process.start({ argv: ['sh', '-c', 'exit 3'], cwd: '/desk/w1' })
    await client.process.wait(pid)
    expect(await client.process.status(pid)).toMatchObject({ state: 'exited', exitCode: 3 })
    expect(await client.process.status(999_999)).toBeUndefined()
  })

  it('进程能写入工作区，产物落回对象目录', async () => {
    const { client } = await mounted()
    const { pid } = await client.process.start({
      argv: ['sh', '-c', 'printf "done by skill" > result.txt'],
      cwd: '/desk/w1',
    })
    await client.process.wait(pid)
    expect(Buffer.from(await client.files.read('/desk/w1/result.txt')).toString()).toBe('done by skill')
  })

  it('平台列出与销毁沙箱', async () => {
    const { platform, handle } = await mounted()
    expect((await platform.list()).map((info) => info.externalId)).toContain(handle.externalId)
    expect(await platform.get(handle.externalId)).toMatchObject({ state: 'running' })
    await platform.destroy(handle.externalId)
    expect(await platform.get(handle.externalId)).toBeUndefined()
    await expect(platform.client(handle.externalId)).rejects.toMatchObject({ failure: { kind: 'not-found' } })
  })

  it('createdAt 稳定，多次查询一致', async () => {
    const { platform, handle } = await mounted()
    const first = await platform.get(handle.externalId)
    const second = await platform.get(handle.externalId)
    const listed = (await platform.list()).find((info) => info.externalId === handle.externalId)
    expect(first?.createdAt).toBe(second?.createdAt)
    expect(listed?.createdAt).toBe(first?.createdAt)
    expect(typeof first?.createdAt).toBe('number')
  })

  it('输出截断后 connect 从保留窗口起点回放，且重复调用稳定', async () => {
    const objectDir = await tempDir('dsh-objects-')
    const rootDir = await tempDir('dsh-sandboxes-')
    const platform = new MockPlatform({ objectDir, rootDir, outputBufferBytes: 5 })
    const handle = await platform.create({
      key: 'k',
      template: 'mock',
      timeoutMs: 60_000,
      workspaceRoot: '/desk/w1',
      mounts: [{ bucketName: 'b', bucketPath: 'desks/w1', endpoint: 'x', mountDir: '/desk/w1' }],
    })
    const client = await platform.client(handle.externalId)
    const { pid } = await client.process.start({
      argv: ['sh', '-c', 'for i in 1 2 3 4 5 6; do printf "0123456789"; sleep 0.05; done'],
      cwd: '/desk/w1',
    })
    await client.process.wait(pid)
    const readAll = async (): Promise<string> => {
      const chunks: Uint8Array[] = []
      for await (const chunk of client.process.connect(pid, 0)) chunks.push(chunk)
      return Buffer.concat(chunks).toString()
    }
    const full = '0123456789'.repeat(6)
    const first = await readAll()
    const second = await readAll()
    expect(first.length).toBeLessThan(full.length)
    expect(full.endsWith(first)).toBe(true)
    expect(second).toBe(first)
  })

  it('已退出进程 connect 不影响 status 与 wait', async () => {
    const { client } = await mounted()
    const { pid } = await client.process.start({ argv: ['sh', '-c', 'exit 3'], cwd: '/desk/w1' })
    await client.process.wait(pid)
    const chunks: Uint8Array[] = []
    for await (const chunk of client.process.connect(pid)) chunks.push(chunk)
    expect(await client.process.status(pid)).toMatchObject({ state: 'exited', exitCode: 3 })
    expect(await client.process.wait(pid)).toMatchObject({ state: 'exited', exitCode: 3 })
  })

  it('只读挂载可读，但写、建目录、删除、改名均被拒绝', async () => {
    const { client, objectDir } = await mounted()
    await writeFile(join(objectDir, 'common/skills/note.md'), 'read-only')
    expect(Buffer.from(await client.files.read('/skillbox/common/note.md')).toString()).toBe('read-only')
    const denied = { failure: { kind: 'unauthorized' } }
    await expect(client.files.write('/skillbox/common/new.md', Buffer.from('x'))).rejects.toMatchObject(denied)
    await expect(client.files.makeDir('/skillbox/common/dir')).rejects.toMatchObject(denied)
    await expect(client.files.remove('/skillbox/common/note.md')).rejects.toMatchObject(denied)
    await expect(client.files.rename('/skillbox/common/note.md', '/desk/w1/note.md')).rejects.toMatchObject(denied)
    await expect(client.files.rename('/desk/w1/note.md', '/skillbox/common/note.md')).rejects.toMatchObject(denied)
    // 读取与列举不受影响。
    await expect(client.files.list('/skillbox/common')).resolves.toHaveLength(1)
  })

  it('挂载尾斜杠与嵌套挂载按最长前缀匹配', async () => {
    const objectDir = await tempDir('dsh-objects-')
    const rootDir = await tempDir('dsh-sandboxes-')
    const platform = new MockPlatform({ objectDir, rootDir })
    const handle = await platform.create({
      key: 'k',
      template: 'mock',
      timeoutMs: 60_000,
      workspaceRoot: '/desk/w1',
      mounts: [
        { bucketName: 'b', bucketPath: 'desks/w1', endpoint: 'x', mountDir: '/desk/w1' },
        { bucketName: 'b', bucketPath: 'deep/w1', endpoint: 'x', mountDir: '/desk/w1/deep' },
        { bucketName: 'b', bucketPath: 'common/skills', endpoint: 'x', mountDir: '/skillbox/' },
      ],
    })
    const client = await platform.client(handle.externalId)
    await client.files.write('/desk/w1/deep/x.txt', Buffer.from('nested'))
    await client.files.write('/skillbox/own.txt', Buffer.from('trailing'))
    expect((await readFile(join(objectDir, 'deep/w1/x.txt'))).toString()).toBe('nested')
    expect((await readFile(join(objectDir, 'common/skills/own.txt'))).toString()).toBe('trailing')
  })

  it('非法挂载在创建时被拒绝', async () => {
    const objectDir = await tempDir('dsh-objects-')
    const rootDir = await tempDir('dsh-sandboxes-')
    const platform = new MockPlatform({ objectDir, rootDir })
    const spec = (mount: { mountDir: string; bucketPath: string }) => ({
      key: 'k',
      template: 'mock',
      timeoutMs: 60_000,
      workspaceRoot: '/desk/w1',
      mounts: [{ bucketName: 'b', endpoint: 'x', ...mount }],
    })
    const denied = { failure: { kind: 'unauthorized' } }
    await expect(platform.create(spec({ mountDir: '/', bucketPath: 'desks/w1' }))).rejects.toMatchObject(denied)
    await expect(platform.create(spec({ mountDir: 'desk/w1', bucketPath: 'desks/w1' }))).rejects.toMatchObject(denied)
    await expect(platform.create(spec({ mountDir: '/desk/w1', bucketPath: '/tmp/outside' }))).rejects.toMatchObject(denied)
    await expect(platform.create(spec({ mountDir: '/desk/w1', bucketPath: '../outside' }))).rejects.toMatchObject(denied)
  })
})
