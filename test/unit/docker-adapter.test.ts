import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DockerPlatform, createDockerCli } from '../../packages/dsh-e2b/src/docker-adapter.ts'
import type { SandboxClient } from '../../packages/dsh-e2b/src/contract.ts'
import { FakeDockerCli, parseRunArgs } from '../helpers/fake-docker.ts'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface MountedOptions {
  readonly bufferLimit?: number
  readonly maxProcesses?: number
}

async function mounted(options: MountedOptions = {}) {
  const objectDir = await tempDir('dsh-objects-')
  const rootDir = await tempDir('dsh-sandboxes-')
  const cli = new FakeDockerCli()
  const platform = new DockerPlatform({
    objectDir,
    rootDir,
    cli,
    pull: 'missing',
    ...(options.bufferLimit === undefined ? {} : { outputBufferBytes: options.bufferLimit }),
    ...(options.maxProcesses === undefined ? {} : { maxProcesses: options.maxProcesses }),
  })
  const handle = await platform.create({
    key: 'workspace:w1',
    template: 'docker',
    timeoutMs: 60_000,
    workspaceRoot: '/desk/w1',
    env: { DSH_TEST: 'yes' },
    labels: { 'dsh.workspace': 'w1', 'dsh.session': 's1' },
    mounts: [
      { bucketName: 'b', bucketPath: 'desks/w1', endpoint: 'x', mountDir: '/desk/w1' },
      { bucketName: 'b', bucketPath: 'members/u1/skills', endpoint: 'x', mountDir: '/skillbox/own' },
      { bucketName: 'b', bucketPath: 'common/skills', endpoint: 'x', mountDir: '/skillbox/common', readOnly: true },
    ],
  })
  const client = await platform.client(handle.externalId)
  return { platform, handle, client, objectDir, rootDir, cli }
}

function runArgs(cli: FakeDockerCli): string[] {
  const call = cli.calls.find(args => args[0] === 'run')
  if (call === undefined) throw new Error('docker run was never called')
  return call.slice(1)
}

async function collect(client: SandboxClient, pid: number): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of client.process.connect(pid, 0)) chunks.push(chunk)
  return Buffer.concat(chunks).toString()
}

describe('DockerPlatform', () => {
  it('创建一个非 root、收权、只读 rootfs 的容器并挂载工作区前缀', async () => {
    const { handle, objectDir, cli } = await mounted()
    const args = runArgs(cli)
    const parsed = parseRunArgs(args)
    expect(parsed.image).toBe('node:22-bookworm-slim')
    expect(parsed.flags.get('--user')).toMatch(/^\d+:\d+$/u)
    expect(parsed.flags.get('--cap-drop')).toBe('ALL')
    expect(parsed.flags.get('--security-opt')).toBe('no-new-privileges')
    expect(parsed.flags.get('--network')).toBe('none')
    expect(parsed.flags.get('--pids-limit')).toBe('512')
    expect(parsed.flags.get('--entrypoint')).toBe('/bin/sh')
    expect(args).toContain('--read-only')
    expect(args).toContain('--init')
    expect(args.filter(arg => arg === '--tmpfs')).toHaveLength(2)
    expect(parsed.flags.get('--workdir')).toBe('/desk/w1')

    const container = cli.containers.get(handle.externalId)
    expect(container?.labels).toMatchObject({
      app: 'dsh',
      'dsh.adapter': 'docker',
      'dsh.workspace-root': '/desk/w1',
      'dsh.workspace': 'w1',
      'dsh.session': 's1',
    })
    expect(container?.labels['dsh.key']).toMatch(/^[0-9a-f]{64}$/u)

    expect(cli.mountSource(handle.externalId, '/desk/w1')).toBe(join(objectDir, 'desks/w1'))
    expect(cli.mountSource(handle.externalId, '/skillbox/own')).toBe(join(objectDir, 'members/u1/skills'))
    expect(cli.mountSource(handle.externalId, '/skillbox/common')).toBe(join(objectDir, 'common/skills'))
    const ro = objectDir.length > 0
      ? args.find(arg => arg.includes('source=') && arg.includes('/common/skills'))
      : undefined
    expect(ro).toContain('readonly')
    const rw = args.find(arg => arg.includes('source=') && arg.includes('/desks/w1'))
    expect(rw).not.toContain('readonly')

    // Bind sources must exist before docker run sees them.
    expect((await stat(join(objectDir, 'desks/w1'))).isDirectory()).toBe(true)
    expect((await stat(join(objectDir, 'common/skills'))).isDirectory()).toBe(true)
    expect(cli.pulled).toBe(1)
  })

  it('镜像已存在时不重复拉取', async () => {
    const objectDir = await tempDir('dsh-objects-')
    const cli = new FakeDockerCli()
    cli.images.add('node:22-bookworm-slim')
    const platform = new DockerPlatform({ objectDir, rootDir: await tempDir('dsh-root-'), cli })
    await platform.create({ key: 'k', template: 'docker', timeoutMs: 1000, mounts: [
      { bucketName: 'b', bucketPath: 'desks/w1', endpoint: 'x', mountDir: '/desk/w1' },
    ] })
    expect(cli.pulled).toBe(0)
  })

  it('拉取失败映射为 unavailable', async () => {
    const objectDir = await tempDir('dsh-objects-')
    const cli = new FakeDockerCli()
    const platform = new DockerPlatform({ objectDir, rootDir: await tempDir('dsh-root-'), cli })
    cli.runError = new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')
    await expect(platform.create({
      key: 'k',
      template: 'docker',
      timeoutMs: 1000,
      mounts: [{ bucketName: 'b', bucketPath: 'desks/w1', endpoint: 'x', mountDir: '/desk/w1' }],
    })).rejects.toMatchObject({ failure: { kind: 'unavailable', retryable: true } })
  })

  it('已中止的创建不落地任何容器', async () => {
    const objectDir = await tempDir('dsh-objects-')
    const cli = new FakeDockerCli()
    const platform = new DockerPlatform({ objectDir, rootDir: await tempDir('dsh-root-'), cli })
    const controller = new AbortController()
    controller.abort()
    await expect(platform.create({ key: 'k', template: 'docker', timeoutMs: 1000 }, controller.signal)).rejects.toThrow()
    expect(cli.calls).toEqual([])
  })

  it('无 OSS 挂载时使用 volume 目录，且拒绝逃逸的卷名', async () => {
    const objectDir = await tempDir('dsh-objects-')
    const cli = new FakeDockerCli()
    cli.images.add('node:22-bookworm-slim')
    const platform = new DockerPlatform({ objectDir, rootDir: await tempDir('dsh-root-'), cli })
    const handle = await platform.create({
      key: 'k',
      template: 'docker',
      timeoutMs: 1000,
      workspaceRoot: '/desk',
      volumes: { '/desk': 'desk-w1' },
    })
    expect(cli.mountSource(handle.externalId, '/desk')).toBe(join(objectDir, 'volumes', 'desk-w1'))
    await expect(platform.create({
      key: 'k',
      template: 'docker',
      timeoutMs: 1000,
      volumes: { '/desk': '../escape' },
    })).rejects.toMatchObject({ failure: { kind: 'unauthorized' } })
  })

  it('既无挂载也无卷时给每个沙箱一个独立工作目录', async () => {
    const cli = new FakeDockerCli()
    cli.images.add('node:22-bookworm-slim')
    const platform = new DockerPlatform({ rootDir: await tempDir('dsh-root-'), cli })
    const handle = await platform.create({ key: 'k', template: 'docker', timeoutMs: 1000, workspaceRoot: '/desk' })
    const source = cli.mountSource(handle.externalId, '/desk')
    expect(source.endsWith(join(handle.externalId, 'workspace'))).toBe(true)
  })

  it('文件读写按挂载点落盘，二进制往返不损坏', async () => {
    const { client, objectDir } = await mounted()
    const payload = Buffer.from([0, 1, 2, 0xfe, 0xff, 0x0a])
    await client.files.write('/desk/w1/data/blob.bin', payload)
    expect((await readFile(join(objectDir, 'desks/w1/data/blob.bin'))).equals(payload)).toBe(true)
    expect(Buffer.from(await client.files.read('/desk/w1/data/blob.bin')).equals(payload)).toBe(true)
  })

  it('相对路径以工作区根为基准', async () => {
    const { client, objectDir } = await mounted()
    await client.files.write('relative.txt', Buffer.from('rel'))
    expect((await readFile(join(objectDir, 'desks/w1/relative.txt'))).toString()).toBe('rel')
    expect(Buffer.from(await client.files.read('relative.txt')).toString()).toBe('rel')
  })

  it('越出挂载点或未挂载的路径被拒绝且不调用 docker', async () => {
    const { client, cli } = await mounted()
    const before = cli.calls.length
    await expect(client.files.read('/skillbox/own/../../desks/w1/out.txt')).rejects.toMatchObject({
      failure: { kind: 'unauthorized' },
    })
    await expect(client.files.read('/etc/passwd')).rejects.toMatchObject({ failure: { kind: 'unauthorized' } })
    await expect(client.files.write('/tmp/x', Buffer.from('x'))).rejects.toMatchObject({ failure: { kind: 'unauthorized' } })
    expect(cli.calls.length).toBe(before)
  })

  it('只读挂载可读可列，写、建目录、删除、改名均被拒绝', async () => {
    const { client, objectDir } = await mounted()
    await mkdir(join(objectDir, 'common/skills'), { recursive: true })
    await writeFile(join(objectDir, 'common/skills/note.md'), 'read-only')
    expect(Buffer.from(await client.files.read('/skillbox/common/note.md')).toString()).toBe('read-only')
    await expect(client.files.list('/skillbox/common')).resolves.toHaveLength(1)
    const denied = { failure: { kind: 'unauthorized' } }
    await expect(client.files.write('/skillbox/common/new.md', Buffer.from('x'))).rejects.toMatchObject(denied)
    await expect(client.files.makeDir('/skillbox/common/dir')).rejects.toMatchObject(denied)
    await expect(client.files.remove('/skillbox/common/note.md')).rejects.toMatchObject(denied)
    await expect(client.files.rename('/skillbox/common/note.md', '/desk/w1/note.md')).rejects.toMatchObject(denied)
    await expect(client.files.rename('/desk/w1/note.md', '/skillbox/common/note.md')).rejects.toMatchObject(denied)
  })

  it('目录列举、stat、改名与删除', async () => {
    const { client, objectDir } = await mounted()
    await client.files.write('/desk/w1/a.txt', Buffer.from('a'))
    await client.files.write('/desk/w1/sub/b.txt', Buffer.from('bb'))
    const entries = await client.files.list('/desk/w1')
    expect(entries.map(entry => entry.name).sort()).toEqual(['a.txt', 'sub'])
    expect(entries.find(entry => entry.name === 'sub')).toMatchObject({ type: 'directory' })
    expect(await client.files.stat('/desk/w1/a.txt')).toMatchObject({ type: 'file', size: 1 })
    expect((await client.files.stat('/desk/w1/sub'))?.type).toBe('directory')
    await client.files.rename('/desk/w1/a.txt', '/desk/w1/renamed.txt')
    expect(await client.files.stat('/desk/w1/renamed.txt')).toMatchObject({ type: 'file', size: 1 })
    await client.files.remove('/desk/w1/sub')
    expect(await client.files.stat('/desk/w1/sub')).toBeUndefined()
    await client.files.makeDir('/desk/w1/empty')
    expect((await client.files.stat('/desk/w1/empty'))?.type).toBe('directory')
    expect(await readFile(join(objectDir, 'desks/w1/renamed.txt'), 'utf8')).toBe('a')
  })

  it('stat 对未挂载的祖先返回 undefined，读取仍然被拒', async () => {
    const { client } = await mounted()
    expect(await client.files.stat('/desk/.git')).toBeUndefined()
    await expect(client.files.read('/desk/.git/HEAD')).rejects.toMatchObject({ failure: { kind: 'unauthorized' } })
    expect(await client.files.stat('/desk/w1/missing')).toBeUndefined()
  })

  it('进程在挂载目录执行，输出、退出码与状态可查', async () => {
    const { client } = await mounted()
    await client.files.write('/desk/w1/input.txt', Buffer.from('skill-input'))
    const { pid } = await client.process.start({
      argv: ['sh', '-c', 'cat input.txt && echo && echo executed'],
      cwd: '/desk/w1',
    })
    expect(await client.process.wait(pid)).toMatchObject({ state: 'exited', exitCode: 0 })
    const chunks: Uint8Array[] = []
    for await (const chunk of client.process.connect(pid)) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString()).toBe('skill-input\nexecuted\n')
    expect(await client.process.status(pid)).toMatchObject({ state: 'exited', exitCode: 0 })

    const failed = await client.process.start({ argv: ['sh', '-c', 'exit 3'], cwd: '/desk/w1' })
    await client.process.wait(failed.pid)
    expect(await client.process.status(failed.pid)).toMatchObject({ state: 'exited', exitCode: 3 })
    expect(await client.process.status(999_999)).toBeUndefined()
    expect((await client.process.list()).map(info => info.pid).sort()).toEqual([failed.pid, pid].sort())
  })

  it('进程写到工作区，产物落回对象目录', async () => {
    const { client, objectDir } = await mounted()
    const { pid } = await client.process.start({
      argv: ['sh', '-c', 'printf "done by skill" > result.txt'],
      cwd: '/desk/w1',
    })
    await client.process.wait(pid)
    expect(await readFile(join(objectDir, 'desks/w1/result.txt'), 'utf8')).toBe('done by skill')
  })

  it('stdin 管道写入后关闭，输出可回放', async () => {
    const { client } = await mounted()
    const { pid } = await client.process.start({ argv: ['sh', '-c', 'cat'], cwd: '/desk/w1', stdin: 'pipe' })
    await client.process.write(pid, Buffer.from('hello '))
    await client.process.write(pid, Buffer.from('world'))
    await client.process.closeStdin(pid)
    expect(await client.process.wait(pid)).toMatchObject({ state: 'exited', exitCode: 0 })
    expect(await collect(client, pid)).toBe('hello world')
  })

  it('kill 结束运行中的进程', async () => {
    const { client } = await mounted()
    const { pid } = await client.process.start({ argv: ['sh', '-c', 'sleep 10'], cwd: '/desk/w1' })
    await client.process.kill(pid, 'SIGKILL')
    expect(await client.process.wait(pid)).toMatchObject({ state: 'exited' })
    await expect(client.process.kill(1)).rejects.toMatchObject({ failure: { kind: 'unauthorized' } })
  })

  it('超过进程上限时拒绝新进程', async () => {
    const { client } = await mounted({ maxProcesses: 1 })
    const first = await client.process.start({ argv: ['sh', '-c', 'cat'], cwd: '/desk/w1', stdin: 'pipe' })
    await expect(client.process.start({ argv: ['sh', '-c', 'true'], cwd: '/desk/w1' }))
      .rejects.toMatchObject({ failure: { kind: 'unavailable', retryable: false } })
    await client.process.kill(first.pid, 'SIGKILL')
    await client.process.wait(first.pid)
  })

  it('输出超限后 connect 从保留窗口回放且重复读取稳定', async () => {
    const { client } = await mounted({ bufferLimit: 5 })
    const { pid } = await client.process.start({
      argv: ['sh', '-c', 'for i in 1 2 3 4 5 6; do printf "0123456789"; sleep 0.01; done'],
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

  it('平台查询、暂停、恢复、销毁与幂等销毁', async () => {
    const { platform, handle } = await mounted()
    expect((await platform.list()).map(info => info.externalId)).toContain(handle.externalId)
    expect(await platform.get(handle.externalId)).toMatchObject({ state: 'running' })
    await platform.pause?.(handle.externalId)
    expect(await platform.get(handle.externalId)).toMatchObject({ state: 'paused' })
    await platform.resume?.(handle.externalId)
    expect(await platform.get(handle.externalId)).toMatchObject({ state: 'running' })
    await platform.destroy(handle.externalId)
    expect(await platform.get(handle.externalId)).toBeUndefined()
    await expect(platform.destroy(handle.externalId)).resolves.toBeUndefined()
    await expect(platform.client(handle.externalId)).rejects.toMatchObject({ failure: { kind: 'not-found' } })
  })

  it('容器缺失与文件缺失映射为 not-found，权限失败映射为 unauthorized', async () => {
    const { client, cli } = await mounted()
    await expect(client.files.read('/desk/w1/missing.txt')).rejects.toMatchObject({ failure: { kind: 'not-found' } })
    cli.execFailure = { code: 1, stderr: 'permission denied' }
    await expect(client.files.write('/desk/w1/x.txt', Buffer.from('x')))
      .rejects.toMatchObject({ failure: { kind: 'unauthorized' } })
  })

  it('daemon 不可用映射为可重试的 unavailable', async () => {
    const { platform, cli } = await mounted()
    cli.runFailure = { code: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' }
    await expect(platform.pause?.('x')).rejects.toMatchObject({ failure: { kind: 'unavailable', retryable: true } })
  })
})

describe('createDockerCli', () => {
  it('docker 二进制不存在时映射为 unavailable', async () => {
    const cli = createDockerCli('/nonexistent/docker-for-dsh-test')
    await expect(cli.run(['info'])).rejects.toMatchObject({ failure: { kind: 'unavailable', retryable: false } })
  })
})
