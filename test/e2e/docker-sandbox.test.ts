import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DockerPlatform } from '../../packages/dsh-e2b/src/docker-adapter.ts'
import type { SandboxClient, SandboxHandle } from '../../packages/dsh-e2b/src/contract.ts'

/**
 * 真实 Docker 容器的 e2e：验证内核边界真的生效。
 *
 * 没有可用 daemon 时整组跳过（单元测试用 FakeDockerCli 覆盖同样路径）。
 * 首次运行需要能拉取镜像；默认 `node:22-bookworm-slim`，可用
 * `DSH_DOCKER_IMAGE` 覆盖。
 */

function dockerAvailable(): boolean {
  try {
    return spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 5_000 }).status === 0
  } catch {
    return false
  }
}

const available = dockerAvailable()
const image = process.env.DSH_DOCKER_IMAGE?.trim() || 'node:22-bookworm-slim'
const suite = available ? describe : describe.skip

async function collect(client: SandboxClient, pid: number): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of client.process.connect(pid, 0)) chunks.push(chunk)
  return Buffer.concat(chunks).toString()
}

suite('docker 沙箱（真实容器）', () => {
  let objectDir = ''
  let platform: DockerPlatform
  let handle: SandboxHandle
  let client: SandboxClient

  beforeAll(async () => {
    // colima 默认共享 $HOME；用系统临时目录在 macOS 上可能没被挂进虚拟机。
    objectDir = await mkdtemp(join(homedir(), '.dsh-docker-e2e-'))
    platform = new DockerPlatform({
      image,
      objectDir,
      rootDir: join(objectDir, 'sandboxes'),
      pull: 'missing',
      startTimeoutMs: 15_000,
    })
    handle = await platform.create({
      key: 'e2e:workspace:w1',
      template: 'docker',
      timeoutMs: 120_000,
      workspaceRoot: '/desk/w1',
      labels: { 'dsh.e2e': 'docker' },
      mounts: [
        { bucketName: 'local', bucketPath: 'desks/w1', endpoint: 'local', mountDir: '/desk/w1' },
        { bucketName: 'local', bucketPath: 'members/u1/skills', endpoint: 'local', mountDir: '/skillbox/own' },
        { bucketName: 'local', bucketPath: 'common/skills', endpoint: 'local', mountDir: '/skillbox/common', readOnly: true },
      ],
    })
    client = await platform.client(handle.externalId)
    await mkdir(join(objectDir, 'common/skills'), { recursive: true })
    await writeFile(join(objectDir, 'common/skills/note.md'), 'read-only')
  }, 300_000)

  afterAll(async () => {
    if (platform !== undefined && handle !== undefined) {
      await platform.destroy(handle.externalId).catch(() => undefined)
    }
    if (objectDir !== '') await rm(objectDir, { recursive: true, force: true })
  }, 120_000)

  it('以非 root 身份运行，工作目录是工作区根', async () => {
    const { pid } = await client.process.start({ argv: ['sh', '-c', 'id -u; pwd'], cwd: '/desk/w1' })
    const status = await client.process.wait(pid)
    expect(status).toMatchObject({ state: 'exited', exitCode: 0 })
    const [uid, cwd] = (await collect(client, pid)).trim().split('\n')
    expect(uid).not.toBe('0')
    if (typeof process.getuid === 'function') expect(uid).toBe(String(process.getuid()))
    expect(cwd).toBe('/desk/w1')
  })

  it('文件在容器内落回挂载的宿主目录', async () => {
    const payload = Buffer.from([0, 1, 2, 0xfe, 0xff, 0x0a])
    await client.files.write('/desk/w1/blob.bin', payload)
    expect((await readFile(join(objectDir, 'desks/w1/blob.bin'))).equals(payload)).toBe(true)
    expect(Buffer.from(await client.files.read('/desk/w1/blob.bin')).equals(payload)).toBe(true)

    await client.files.makeDir('/desk/w1/dir')
    expect((await client.files.stat('/desk/w1/dir'))?.type).toBe('directory')
    await client.files.rename('/desk/w1/blob.bin', '/desk/w1/dir/moved.bin')
    expect((await client.files.list('/desk/w1/dir')).map(entry => entry.name)).toEqual(['moved.bin'])
    expect(await client.files.stat('/desk/w1/dir/moved.bin')).toMatchObject({ type: 'file', size: payload.byteLength })
    await client.files.remove('/desk/w1/dir')
    expect(await client.files.stat('/desk/w1/dir')).toBeUndefined()
  })

  it('自有技能目录可写，公共技能目录只读', async () => {
    await client.files.write('/skillbox/own/report/SKILL.md', Buffer.from('# report'))
    expect((await readFile(join(objectDir, 'members/u1/skills/report/SKILL.md'))).toString()).toBe('# report')

    expect(Buffer.from(await client.files.read('/skillbox/common/note.md')).toString()).toBe('read-only')
    await expect(client.files.write('/skillbox/common/new.md', Buffer.from('x')))
      .rejects.toMatchObject({ failure: { kind: 'unauthorized' } })

    const { pid } = await client.process.start({
      argv: ['sh', '-c', 'touch /skillbox/common/kernel.txt'],
      cwd: '/skillbox/common',
    })
    const status = await client.process.wait(pid)
    expect(status?.state).toBe('exited')
    expect(status?.exitCode).not.toBe(0)
  })

  it('进程输出、退出码与 stderr 分流', async () => {
    const stderr: string[] = []
    const { pid } = await client.process.start(
      { argv: ['sh', '-c', 'echo out; echo err >&2; exit 4'], cwd: '/desk/w1' },
      { stderr: chunk => stderr.push(Buffer.from(chunk).toString()) },
    )
    expect(await client.process.wait(pid)).toMatchObject({ state: 'exited', exitCode: 4 })
    const text = await collect(client, pid)
    expect(text).toContain('out')
    expect(text).toContain('err')
    expect(stderr.join('')).toContain('err')
  })

  it('进程超时/取消后可以被杀掉', async () => {
    const { pid } = await client.process.start({ argv: ['sh', '-c', 'sleep 60'], cwd: '/desk/w1' })
    await client.process.kill(pid, 'SIGKILL')
    expect(await client.process.wait(pid)).toMatchObject({ state: 'exited' })
  })

  it('pause/resume 改变容器状态', async () => {
    await platform.pause?.(handle.externalId)
    expect(await platform.get(handle.externalId)).toMatchObject({ state: 'paused' })
    await platform.resume?.(handle.externalId)
    expect(await platform.get(handle.externalId)).toMatchObject({ state: 'running' })
  })

  it('销毁后容器消失，重复销毁不报错', async () => {
    await platform.destroy(handle.externalId)
    expect(await platform.get(handle.externalId)).toBeUndefined()
    await expect(platform.destroy(handle.externalId)).resolves.toBeUndefined()
    await expect(platform.client(handle.externalId)).rejects.toMatchObject({ failure: { kind: 'not-found' } })
  })
})
