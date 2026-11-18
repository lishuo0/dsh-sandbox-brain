import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DockerPlatform } from '../../packages/dsh-e2b/src/docker-adapter.ts'
import type { SandboxClient, SandboxHandle } from '../../packages/dsh-e2b/src/contract.ts'

/**
 * 真实容器下的隔离验证：两个工作区沙箱互不可见，工具进程也读不到宿主。
 *
 * 与 docker-sandbox.test.ts 共用同一套适配器，但这里只关心边界：
 * 挂载集合、命名空间、capability、网络、符号链接与路径逃逸。
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

interface RunResult {
  readonly code: number | undefined
  readonly out: string
}

async function run(client: SandboxClient, argv: readonly string[], cwd = '/desk'): Promise<RunResult> {
  const { pid } = await client.process.start({ argv: [...argv], cwd })
  const status = await client.process.wait(pid)
  return { code: status?.exitCode, out: await collect(client, pid) }
}

function mountTable(mountinfo: string): Array<{ destination: string; root: string; source: string }> {
  return mountinfo
    .split('\n')
    .filter(line => line.includes(' - '))
    .map(line => {
      const [left = '', right = ''] = line.split(' - ')
      const fields = left.split(' ')
      return {
        destination: fields[4] ?? '',
        root: fields[3] ?? '',
        source: right.split(' ')[1] ?? '',
      }
    })
}

suite('docker 沙箱隔离（真实容器）', () => {
  let objectDir = ''
  let hostHome = ''
  let hostSecret = ''
  const secret = 'HOST-ONLY-SECRET'
  let platform: DockerPlatform
  let handleA: SandboxHandle
  let handleB: SandboxHandle
  let a: SandboxClient
  let b: SandboxClient

  async function createClient(workspace: string): Promise<{ handle: SandboxHandle; client: SandboxClient }> {
    const handle = await platform.create({
      key: `e2e:workspace:${workspace}`,
      template: 'docker',
      timeoutMs: 120_000,
      workspaceRoot: '/desk',
      labels: { 'dsh.e2e': 'docker-isolation', 'dsh.workspace': workspace },
      mounts: [
        { bucketName: 'local', bucketPath: `desks/${workspace}`, endpoint: 'local', mountDir: '/desk' },
        { bucketName: 'local', bucketPath: 'members/u1/skills', endpoint: 'local', mountDir: '/skillbox/own', readOnly: true },
        { bucketName: 'local', bucketPath: 'common/skills', endpoint: 'local', mountDir: '/skillbox/common', readOnly: true },
      ],
    })
    return { handle, client: await platform.client(handle.externalId) }
  }

  beforeAll(async () => {
    hostHome = homedir()
    // colima 默认共享 $HOME；对象根放在宿主 home 下，才可能被误挂进容器。
    objectDir = await mkdtemp(join(hostHome, '.dsh-docker-iso-'))
    hostSecret = join(objectDir, 'host-secret.txt')
    await writeFile(hostSecret, secret)
    await mkdir(join(objectDir, 'common/skills'), { recursive: true })
    await writeFile(join(objectDir, 'common/skills/note.md'), 'common')

    platform = new DockerPlatform({
      image,
      objectDir,
      rootDir: join(objectDir, 'sandboxes'),
      pull: 'missing',
      startTimeoutMs: 15_000,
    })
    const first = await createClient('iso-a')
    handleA = first.handle
    a = first.client
    const second = await createClient('iso-b')
    handleB = second.handle
    b = second.client
  }, 300_000)

  afterAll(async () => {
    if (platform !== undefined) {
      for (const handle of [handleA, handleB]) {
        if (handle !== undefined) await platform.destroy(handle.externalId).catch(() => undefined)
      }
    }
    if (objectDir !== '') await rm(objectDir, { recursive: true, force: true })
  }, 120_000)

  it('两个工作区互相看不到对方的文件', async () => {
    await a.files.write('/desk/from-a.txt', Buffer.from('a-only'))
    expect(await b.files.stat('/desk/from-a.txt')).toBeUndefined()
    await expect(b.files.read('/desk/from-a.txt')).rejects.toMatchObject({ failure: { kind: 'not-found' } })

    const listed = await run(b, ['ls', '/desk'])
    expect(listed.code).toBe(0)
    expect(listed.out).not.toContain('from-a.txt')

    const cat = await run(b, ['cat', '/desk/from-a.txt'])
    expect(cat.code).not.toBe(0)
  })

  it('工具进程读不到宿主目录与宿主文件', async () => {
    const secretRead = await run(a, ['cat', hostSecret])
    expect(secretRead.code).not.toBe(0)
    expect(secretRead.out).not.toContain(secret)

    const users = await run(a, ['ls', '/Users'])
    expect(users.code).not.toBe(0)

    const root = await run(a, ['ls', '/'])
    expect(root.code).toBe(0)
    expect(root.out.split('\n')).not.toContain('Users')
    expect(root.out.split('\n')).not.toContain('Applications')

    const guestName = await run(a, ['cat', '/etc/hostname'])
    expect(guestName.out.trim()).not.toBe(hostname())
  })

  it('文件 API 只允许访问挂载点，拒绝宿主绝对路径', async () => {
    await expect(a.files.read(hostSecret)).rejects.toMatchObject({ failure: { kind: 'unauthorized' } })
    await expect(a.files.read('/Users')).rejects.toMatchObject({ failure: { kind: 'unauthorized' } })
    await expect(a.files.read('/etc/passwd')).rejects.toMatchObject({ failure: { kind: 'unauthorized' } })
    expect(await a.files.stat('/Users')).toBeUndefined()
  })

  it('容器内只挂载本工作区与两块只读技能前缀', async () => {
    const { out } = await run(a, ['cat', '/proc/self/mountinfo'])
    const mounts = mountTable(out)
    const destinations = mounts.map(mount => mount.destination)

    expect(destinations).toContain('/desk')
    expect(destinations).toContain('/skillbox/own')
    expect(destinations).toContain('/skillbox/common')
    expect(destinations).not.toContain(objectDir)
    expect(destinations).not.toContain(hostHome)
    expect(destinations).not.toContain('/Users')

    // virtiofs 把宿主 home 挂在 VM 里，bind mount 的 root 是相对 home 的子路径。
    // 只允许对象根下的三个前缀；整棵 home 或对象根本身都不能出现。
    const relativeObjectDir = join('/', relative(hostHome, objectDir))
    const allowed = new Set([
      `${relativeObjectDir}/desks/iso-a`,
      `${relativeObjectDir}/members/u1/skills`,
      `${relativeObjectDir}/common/skills`,
    ])
    const underObject = mounts.filter(
      mount => mount.root === relativeObjectDir || mount.root.startsWith(`${relativeObjectDir}/`),
    )
    expect(new Set(underObject.map(mount => mount.root))).toEqual(allowed)
    expect(mounts.filter(mount => mount.source.startsWith('lima-') && mount.root === '/')).toEqual([])
  })

  it('capability 清零、no_new_privs、seccomp 生效', async () => {
    const { out } = await run(a, ['cat', '/proc/self/status'])
    const field = (name: string): string =>
      out.split('\n').find(line => line.startsWith(`${name}:`))?.split(/\s+/u)[1] ?? ''
    expect(field('CapEff')).toBe('0000000000000000')
    expect(field('CapPrm')).toBe('0000000000000000')
    expect(field('NoNewPrivs')).toBe('1')
    expect(field('Seccomp')).toBe('2')
  })

  it('网络关闭，容器内访问不到外网', async () => {
    const script = [
      "const socket = require('net').connect(80, '1.1.1.1')",
      "socket.on('connect', () => { console.log('online'); process.exit(1) })",
      "socket.on('error', () => { console.log('offline'); process.exit(0) })",
      "setTimeout(() => { console.log('offline'); process.exit(0) }, 2000)",
    ].join(';')
    const result = await run(a, ['node', '-e', script])
    expect(result.code).toBe(0)
    expect(result.out).toContain('offline')
  })

  it('宿主 docker socket 不在容器内', async () => {
    const result = await run(a, [
      'sh', '-c',
      'for path in /var/run/docker.sock /run/docker.sock /var/run/docker; do [ -e "$path" ] && exit 0; done; exit 1',
    ])
    expect(result.code).not.toBe(0)
  })

  it('进程命名空间隔离：看不到另一个沙箱的进程', async () => {
    const started = await a.process.start({ argv: ['sh', '-c', 'exec sleep 30'], cwd: '/desk' })
    try {
      const cmdline = await run(b, ['cat', `/proc/${started.pid}/cmdline`])
      expect(cmdline.out).not.toContain('sleep')
      const probe = await run(b, ['sh', '-c', 'kill -0 "$1" 2>/dev/null; echo $?', 'sh', String(started.pid)])
      expect(probe.out.trim()).not.toBe('0')
    } finally {
      await a.process.kill(started.pid, 'SIGKILL').catch(() => undefined)
      await a.process.wait(started.pid)
    }
  })

  it('符号链接与相对路径逃不出工作区', async () => {
    const link = await run(a, ['ln', '-s', hostHome, '/desk/escape'])
    expect(link.code).toBe(0)
    const hostRead = await run(a, ['cat', '/desk/escape/host-secret.txt'])
    expect(hostRead.code).not.toBe(0)
    const resolved = await run(a, ['stat', '-L', '/desk/escape'])
    expect(resolved.code).not.toBe(0)

    await expect(a.files.read('/desk/../members/u1/skills/x'))
      .rejects.toMatchObject({ failure: { kind: 'unauthorized' } })
    await expect(a.files.read('/desk/../../desks/iso-b/x'))
      .rejects.toMatchObject({ failure: { kind: 'unauthorized' } })
    await expect(a.files.write('/desk/../../etc/hosts', Buffer.from('x')))
      .rejects.toMatchObject({ failure: { kind: 'unauthorized' } })
  })

  it('只读 rootfs 与只读技能前缀由内核对子进程兜底', async () => {
    expect((await run(a, ['touch', '/etc/evil'])).code).not.toBe(0)
    expect((await run(a, ['touch', '/root/evil'])).code).not.toBe(0)
    expect((await run(a, ['touch', '/tmp/ok'])).code).toBe(0)
    expect((await run(a, ['touch', '/skillbox/own/evil'])).code).not.toBe(0)
    expect((await run(a, ['touch', '/skillbox/common/evil'])).code).not.toBe(0)
    await expect(a.files.write('/skillbox/own/x', Buffer.from('x')))
      .rejects.toMatchObject({ failure: { kind: 'unauthorized' } })
  })

  it('文件只落在自己的工作区目录，host-secret 不在其中', async () => {
    expect(await readFile(join(objectDir, 'desks/iso-a/from-a.txt'), 'utf8')).toBe('a-only')
    await expect(readFile(join(objectDir, 'desks/iso-b/from-a.txt'), 'utf8')).rejects.toThrow()
    expect(await readFile(hostSecret, 'utf8')).toBe(secret)
  })
})
