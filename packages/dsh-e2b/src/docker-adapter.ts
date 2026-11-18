/**
 * Docker platform: one container per workspace on a local daemon.
 *
 * This is the laptop counterpart of the E2B adapter. It keeps the same
 * contract — routing, mounts and path rules are decided above — and swaps the
 * execution world from "host directories and host child processes" to a Linux
 * container:
 *
 *   isolation   a container namespace plus capabilities dropped, a read-only
 *               rootfs, and only the workspace prefix bind-mounted
 *   files       every operation runs inside the container through `docker exec`
 *   processes   every process runs inside the container; the local docker CLI
 *               is only the transport
 *   destroy     removing the container ends every process in it
 *
 * What it does NOT claim: the local object directory (`storage.dir`) is still a
 * shared host tree keyed by workspace prefix. Prefix isolation is a mount
 * decision, not a tenant boundary. Use OSS + E2B for anything multi-user.
 *
 * @module @brain/dsh-e2b/docker-adapter
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'
import type {
  DirEntry,
  FileStat,
  ProcessHandlers,
  ProcessInfo,
  ProcessSpec,
  SandboxClient,
  SandboxHandle,
  SandboxInfo,
  SandboxMount,
  SandboxPlatform,
  SandboxSpec,
} from './contract.ts'
import { SandboxPlatformError } from './contract.ts'

/** Result of one docker CLI invocation. */
export interface DockerCliResult {
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: string
}

/** Options for {@link DockerCli.run}. */
export interface DockerCliRunOptions {
  /** Bytes written to the command's stdin, then closed. */
  readonly input?: Uint8Array
  /** Upper bound on stdout bytes; exceeding it fails the call. */
  readonly maxStdoutBytes?: number
  /** Milliseconds before the CLI child is killed. */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** Options for {@link DockerCli.spawn}. */
export interface DockerCliSpawnOptions {
  readonly stdin: 'pipe' | 'ignore'
}

/**
 * The only OS-touching seam.
 *
 * Tests replace it with an in-memory implementation; production uses the
 * `docker` binary through `node:child_process` without a shell.
 */
export interface DockerCli {
  run(args: readonly string[], options?: DockerCliRunOptions): Promise<DockerCliResult>
  spawn(args: readonly string[], options: DockerCliSpawnOptions): ChildProcess
}

/** Configuration for the Docker adapter. */
export interface DockerConfig {
  /** Image used for every sandbox. Needs bash, coreutils and find. */
  readonly image?: string
  /** Local object root for mount sources; usually the platform `storage.dir`. */
  readonly objectDir?: string
  /** Root for volume-name mounts when no OSS mounts are configured. */
  readonly volumesDir?: string
  /** Root for per-sandbox workspaces when no mounts are configured. */
  readonly rootDir?: string
  /** Docker network mode. `none` keeps the container off every network. */
  readonly network?: string
  /** Container user, `uid:gid`. Defaults to the brain user on POSIX. */
  readonly user?: string
  readonly memory?: string
  readonly cpus?: string
  readonly pidsLimit?: number
  /** Mount the container root filesystem read-only (recommended). */
  readonly readOnlyRootfs?: boolean
  /** When to pull the image. */
  readonly pull?: 'missing' | 'always' | 'never'
  /** Bytes of process output retained for `connect`. */
  readonly outputBufferBytes?: number
  /** Exited processes kept for `status`/`connect` before pruning. */
  readonly maxProcesses?: number
  /** Upper bound for one `files.read` call. */
  readonly maxFileBytes?: number
  /** Milliseconds allowed for the pid-file handshake after `exec`. */
  readonly startTimeoutMs?: number
  /** Docker binary name or absolute path. */
  readonly bin?: string
  /** CLI seam, for tests. */
  readonly cli?: DockerCli
  readonly onLog?: (message: string) => void
}

interface Layout {
  readonly workspaceRoot: string
  readonly mounts: readonly Mount[]
}

interface Mount {
  /** Host directory behind the mount. */
  readonly source: string
  /** Absolute path inside the container. */
  readonly target: string
  readonly readOnly: boolean
}

interface ProcessEntry {
  pid: number
  readonly argv: readonly string[]
  readonly child: ChildProcess
  readonly chunks: Buffer[]
  buffered: number
  /** Absolute offset of the first retained byte. */
  startOffset: number
  total: number
  readonly readers: Set<() => void>
  exited: boolean
  exitCode?: number
}

interface InspectContainer {
  readonly State?: { readonly Status?: string }
  readonly Created?: string
  readonly Mounts?: readonly {
    readonly Type?: string
    readonly Source?: string
    readonly Destination?: string
    readonly RW?: boolean
  }[]
  readonly Config?: { readonly Labels?: Record<string, string> }
}

const DEFAULT_IMAGE = 'node:22-bookworm-slim'
const DEFAULT_START_TIMEOUT_MS = 5_000
const KEEPALIVE = 'mkdir -p "$HOME" "$npm_config_cache"; exec sleep infinity'

/** Platform backed by the local Docker daemon. */
export class DockerPlatform implements SandboxPlatform {
  readonly capabilities = { pause: true, snapshot: false }

  private readonly image: string
  private readonly objectDir?: string
  private readonly volumesDir: string
  private readonly rootDir: string
  private readonly network: string
  private readonly user: string
  private readonly memory: string
  private readonly cpus: string
  private readonly pidsLimit: number
  private readonly readOnlyRootfs: boolean
  private readonly pull: 'missing' | 'always' | 'never'
  private readonly bufferLimit: number
  private readonly maxProcesses: number
  private readonly maxFileBytes: number
  private readonly startTimeoutMs: number
  private readonly cli: DockerCli
  private readonly onLog?: (message: string) => void

  constructor(config: DockerConfig = {}) {
    this.image = config.image?.trim() || DEFAULT_IMAGE
    const objectDir = config.objectDir?.trim()
    this.objectDir = objectDir ? resolve(objectDir) : undefined
    this.rootDir = resolve(config.rootDir ?? join(homedir(), '.dsh', 'sandboxes'))
    this.volumesDir = resolve(config.volumesDir ?? (this.objectDir ? join(this.objectDir, 'volumes') : join(this.rootDir, 'volumes')))
    this.network = config.network?.trim() || 'none'
    this.user = config.user?.trim() || defaultUser()
    this.memory = config.memory?.trim() || '2g'
    this.cpus = config.cpus?.trim() || '2'
    this.pidsLimit = config.pidsLimit ?? 512
    this.readOnlyRootfs = config.readOnlyRootfs !== false
    this.pull = config.pull ?? 'missing'
    this.bufferLimit = config.outputBufferBytes ?? 1_048_576
    this.maxProcesses = config.maxProcesses ?? 256
    this.maxFileBytes = config.maxFileBytes ?? 64 * 1024 * 1024
    this.startTimeoutMs = config.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    this.cli = config.cli ?? createDockerCli(config.bin?.trim() || 'docker')
    this.onLog = config.onLog
  }

  async create(spec: SandboxSpec, signal?: AbortSignal): Promise<SandboxHandle> {
    signal?.throwIfAborted()
    const name = `dsh-${randomUUID()}`
    const workspaceRoot = normalizeDir(spec.workspaceRoot ?? '/desk')
    const mounts = await this.resolveMounts(spec, workspaceRoot, name)
    await this.ensureImage(signal)
    const args = this.runArgs(name, spec, workspaceRoot, mounts)
    const result = await this.cli.run(args, { timeoutMs: 120_000, signal }).catch(async error => {
      await this.remove(name).catch(() => undefined)
      throw asPlatformError(error)
    })
    if (result.code !== 0) {
      await this.remove(name)
      throw failure(result, 'docker run')
    }
    // `docker run -d` prints the id; the name is stable and human-readable.
    if (result.stdout.toString().trim() === '') {
      await this.remove(name)
      throw new SandboxPlatformError({ kind: 'unavailable', retryable: false, detail: 'docker run returned no container id' })
    }
    if (signal?.aborted) {
      await this.remove(name)
      signal.throwIfAborted()
    }
    return { externalId: name, endpoint: name, workspaceRoot }
  }

  async get(externalId: string): Promise<SandboxInfo | undefined> {
    const inspected = await this.inspect(externalId)
    if (inspected === undefined) return undefined
    return toInfo(externalId, inspected)
  }

  async list(filter?: { readonly labels?: Readonly<Record<string, string>> }): Promise<SandboxInfo[]> {
    const args = [
      'ps', '-a',
      '--filter', 'label=app=dsh',
      '--filter', 'label=dsh.adapter=docker',
      '--format', '{{.Names}}',
    ]
    for (const [key, value] of Object.entries(filter?.labels ?? {})) args.push('--filter', `label=${key}=${value}`)
    const result = await this.cli.run(args).catch(error => {
      throw asPlatformError(error)
    })
    if (result.code !== 0) throw failure(result, 'docker ps')
    const names = result.stdout.toString().split('\n').map(line => line.trim()).filter(Boolean)
    const infos: SandboxInfo[] = []
    for (const name of names) {
      const inspected = await this.inspect(name)
      if (inspected !== undefined) infos.push(toInfo(name, inspected))
    }
    return infos
  }

  async destroy(externalId: string): Promise<void> {
    await this.remove(externalId)
  }

  async pause(externalId: string): Promise<void> {
    const result = await this.cli.run(['pause', externalId]).catch(error => {
      throw asPlatformError(error)
    })
    if (result.code !== 0) throw failure(result, 'docker pause')
  }

  async resume(externalId: string): Promise<void> {
    const result = await this.cli.run(['unpause', externalId]).catch(error => {
      throw asPlatformError(error)
    })
    if (result.code !== 0) throw failure(result, 'docker unpause')
  }

  /** Open the client for one sandbox. */
  async client(externalId: string): Promise<SandboxClient> {
    const inspected = await this.inspect(externalId)
    if (inspected === undefined) throw new SandboxPlatformError({ kind: 'not-found' }, externalId)
    const workspaceRoot = normalizeDir(inspected.Config?.Labels?.['dsh.workspace-root'] ?? '/desk')
    const mounts: Mount[] = []
    for (const mount of inspected.Mounts ?? []) {
      if (mount.Type !== 'bind') continue
      if (mount.Source === undefined || mount.Destination === undefined) continue
      mounts.push({ source: mount.Source, target: normalizeDir(mount.Destination), readOnly: mount.RW === false })
    }
    return new DockerClient(
      this.cli,
      externalId,
      { workspaceRoot, mounts },
      {
        bufferLimit: this.bufferLimit,
        maxProcesses: this.maxProcesses,
        maxFileBytes: this.maxFileBytes,
        startTimeoutMs: this.startTimeoutMs,
      },
    )
  }

  /** Delete a container if it exists; a missing one is not an error. */
  private async remove(externalId: string): Promise<void> {
    const result = await this.cli.run(['rm', '-f', externalId]).catch(error => {
      throw asPlatformError(error)
    })
    if (result.code !== 0 && !/no such container|no such object/i.test(result.stderr)) {
      throw failure(result, 'docker rm')
    }
  }

  private async inspect(externalId: string): Promise<InspectContainer | undefined> {
    const result = await this.cli.run(['inspect', externalId]).catch(error => {
      throw asPlatformError(error)
    })
    if (result.code !== 0) {
      if (/no such container|no such object|not found/i.test(result.stderr)) return undefined
      throw failure(result, 'docker inspect')
    }
    const parsed: unknown = JSON.parse(result.stdout.toString())
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    if (typeof first !== 'object' || first === null) return undefined
    return first as InspectContainer
  }

  private async ensureImage(signal?: AbortSignal): Promise<void> {
    if (this.pull === 'always') {
      await this.pullImage(signal)
      return
    }
    const inspected = await this.cli.run(['image', 'inspect', this.image], { signal }).catch(error => {
      throw asPlatformError(error)
    })
    if (inspected.code === 0) return
    if (this.pull === 'never') {
      throw new SandboxPlatformError(
        { kind: 'unavailable', retryable: false, detail: `image ${this.image} is not present and pull is disabled` },
        `sandboxes: docker image ${this.image} is missing; pull it or set docker.pull`,
      )
    }
    await this.pullImage(signal)
  }

  private async pullImage(signal?: AbortSignal): Promise<void> {
    this.onLog?.(`docker: pulling image ${this.image}`)
    const pulled = await this.cli.run(['pull', this.image], { timeoutMs: 600_000, signal }).catch(error => {
      throw asPlatformError(error)
    })
    if (pulled.code !== 0) throw failure(pulled, `docker pull ${this.image}`)
  }

  /** Resolve mounts and create their host directories under the object root. */
  private async resolveMounts(spec: SandboxSpec, workspaceRoot: string, name: string): Promise<Mount[]> {
    const mounts: Mount[] = []
    if ((spec.mounts?.length ?? 0) > 0) {
      if (this.objectDir === undefined) {
        throw new SandboxPlatformError(
          { kind: 'unavailable', retryable: false, detail: 'docker.objectDir is required when mounts are configured' },
          'sandboxes: docker adapter needs objectDir to mount the local object store',
        )
      }
      for (const mount of spec.mounts ?? []) {
        const resolved = this.mountFromOss(mount)
        // Docker refuses a bind mount whose source is missing.
        await mkdir(resolved.source, { recursive: true })
        mounts.push(resolved)
      }
    } else if (Object.keys(spec.volumes ?? {}).length > 0) {
      for (const [mountPath, volumeName] of Object.entries(spec.volumes ?? {})) {
        const source = this.volumeSource(volumeName)
        await mkdir(source, { recursive: true })
        mounts.push({ source, target: normalizeDir(mountPath), readOnly: false })
      }
    }
    // Without any mount the sandbox still needs a writable working directory.
    if (mounts.length === 0) {
      const source = join(this.rootDir, name, 'workspace')
      await mkdir(source, { recursive: true })
      mounts.push({ source, target: workspaceRoot, readOnly: false })
    }
    return mounts
  }

  private mountFromOss(mount: SandboxMount): Mount {
    const objectDir = this.objectDir as string
    const source = resolve(objectDir, mount.bucketPath)
    const rel = relative(objectDir, source)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new SandboxPlatformError({ kind: 'unauthorized' }, `bucketPath escapes object dir: ${mount.bucketPath}`)
    }
    const target = normalizeDir(mount.mountDir)
    if (!target.startsWith('/') || target === '/') {
      throw new SandboxPlatformError({ kind: 'unauthorized' }, `invalid mountDir: ${mount.mountDir}`)
    }
    return { source, target, readOnly: mount.readOnly === true }
  }

  private volumeSource(volumeName: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(volumeName)) {
      throw new SandboxPlatformError({ kind: 'unauthorized' }, `invalid volume name: ${volumeName}`)
    }
    const source = resolve(this.volumesDir, volumeName)
    const rel = relative(this.volumesDir, source)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new SandboxPlatformError({ kind: 'unauthorized' }, `volume escapes volumes dir: ${volumeName}`)
    }
    return source
  }

  private runArgs(name: string, spec: SandboxSpec, workspaceRoot: string, mounts: readonly Mount[]): string[] {
    const labels: Record<string, string> = {
      ...(spec.labels ?? {}),
      // Reserved labels come last so `list()` filters cannot be overridden.
      app: 'dsh',
      'dsh.adapter': 'docker',
      'dsh.workspace-root': workspaceRoot,
      'dsh.key': dockerKeyLabel(spec.key),
    }
    const args = [
      'run', '-d',
      '--name', name,
      '--user', this.user,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--init',
      '--pids-limit', String(this.pidsLimit),
      '--memory', this.memory,
      '--cpus', this.cpus,
      '--network', this.network,
      '--workdir', workspaceRoot,
      '--env', 'HOME=/tmp/home',
      '--env', 'npm_config_cache=/tmp/.npm',
    ]
    for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`)
    if (this.readOnlyRootfs) args.push('--read-only')
    args.push('--tmpfs', '/tmp:rw,exec,size=256m,mode=1777', '--tmpfs', '/run:rw,size=16m,mode=1777')
    for (const [key, value] of Object.entries(spec.env ?? {})) args.push('--env', `${key}=${value}`)
    for (const mount of mounts) {
      args.push(
        '--mount',
        `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ',readonly' : ''}`,
      )
    }
    args.push('--entrypoint', '/bin/sh', this.image, '-c', KEEPALIVE)
    return args
  }
}

/** Sandbox-level client over one container. */
class DockerClient implements SandboxClient {
  readonly capabilities = { pty: false, reattach: true, signal: true, fileVersion: false }

  private readonly processes = new Map<number, ProcessEntry>()

  constructor(
    private readonly cli: DockerCli,
    private readonly name: string,
    private readonly layout: Layout,
    private readonly limits: {
      readonly bufferLimit: number
      readonly maxProcesses: number
      readonly maxFileBytes: number
      readonly startTimeoutMs: number
    },
  ) {}

  /**
   * Map a guest path onto the mount that owns it.
   *
   * Escapes and unmounted paths are refused the same way the mock adapter
   * refuses them; `stat` treats "not mounted" as "does not exist".
   */
  private resolveGuest(path: string): { guest: string; readOnly: boolean } {
    const guest = path.startsWith('/')
      ? posix.normalize(path)
      : posix.normalize(posix.join(this.layout.workspaceRoot, path))
    const mounts = [...this.layout.mounts].sort((left, right) => right.target.length - left.target.length)
    for (const mount of mounts) {
      if (guest === mount.target || guest.startsWith(`${mount.target}/`)) {
        return { guest, readOnly: mount.readOnly }
      }
    }
    throw new SandboxPlatformError({ kind: 'unauthorized' }, `path is not mounted: ${path}`)
  }

  private writable(path: string): string {
    const target = this.resolveGuest(path)
    if (target.readOnly) throw new SandboxPlatformError({ kind: 'unauthorized' }, `path is read-only: ${path}`)
    return target.guest
  }

  private async run(args: readonly string[], options?: DockerCliRunOptions): Promise<DockerCliResult> {
    return await this.cli.run(['exec', this.name, ...args], options)
  }

  private async runStdin(args: readonly string[], input: Uint8Array): Promise<DockerCliResult> {
    return await this.cli.run(['exec', '-i', this.name, ...args], { input })
  }

  readonly process = {
    start: async (spec: ProcessSpec, handlers?: ProcessHandlers): Promise<{ pid: number }> => {
      spec.signal?.throwIfAborted()
      if (spec.argv.length === 0) {
        throw new SandboxPlatformError({ kind: 'unavailable', retryable: false, detail: 'empty argv' })
      }
      if (this.liveCount() >= this.limits.maxProcesses) {
        throw new SandboxPlatformError({ kind: 'unavailable', retryable: false, detail: 'too many processes' })
      }
      const cwd = this.resolveGuest(spec.cwd).guest
      const token = randomUUID().replaceAll('-', '')
      const pidFile = `/run/dsh/${token}.pid`
      const wrapper = 'mkdir -p /run/dsh; echo $$ > "$1" || exit 90; shift; exec "$@"'
      const args = ['exec']
      if (spec.stdin === 'pipe') args.push('-i')
      args.push('--workdir', cwd)
      for (const [key, value] of Object.entries(spec.env ?? {})) args.push('--env', `${key}=${value}`)
      args.push(this.name, 'sh', '-c', wrapper, 'sh', pidFile, ...spec.argv)

      const child = this.cli.spawn(args, { stdin: spec.stdin === 'pipe' ? 'pipe' : 'ignore' })
      const entry: ProcessEntry = {
        pid: -1,
        argv: spec.argv,
        child,
        chunks: [],
        buffered: 0,
        startOffset: 0,
        total: 0,
        readers: new Set(),
        exited: false,
      }
      const notify = (): void => {
        for (const wake of entry.readers) wake()
      }
      const keep = (chunk: Buffer): void => {
        entry.chunks.push(chunk)
        entry.buffered += chunk.byteLength
        entry.total += chunk.byteLength
        while (entry.buffered > this.limits.bufferLimit && entry.chunks.length > 1) {
          const dropped = entry.chunks.shift()
          const size = dropped?.byteLength ?? 0
          entry.buffered -= size
          entry.startOffset += size
        }
        notify()
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        keep(chunk)
        handlers?.stdout?.(chunk)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        keep(chunk)
        handlers?.stderr?.(chunk)
      })
      child.on('close', code => {
        entry.exited = true
        entry.exitCode = code ?? undefined
        notify()
      })
      child.on('error', () => {
        entry.exited = true
        notify()
      })

      const pid = await this.readPidFile(pidFile, entry)
      if (pid === undefined) {
        child.kill('SIGKILL')
        throw new SandboxPlatformError(
          { kind: 'unavailable', retryable: false, detail: this.tail(entry) || 'process did not start' },
          'sandboxes: docker process did not report a pid',
        )
      }
      entry.pid = pid
      this.processes.set(pid, entry)
      spec.signal?.addEventListener('abort', () => {
        if (!entry.exited) {
          child.kill('SIGKILL')
          void this.process.kill(pid, 'SIGKILL').catch(() => undefined)
        }
      }, { once: true })
      this.prune()
      return { pid }
    },

    connect: (pid: number, from = 0): AsyncIterable<Uint8Array> => this.stream(pid, from),

    status: async (pid: number): Promise<ProcessInfo | undefined> => {
      const entry = this.processes.get(pid)
      if (entry === undefined) return undefined
      return infoOf(entry)
    },

    kill: async (pid: number, signal?: string): Promise<void> => {
      if (pid === 1) throw new SandboxPlatformError({ kind: 'unauthorized' }, 'refusing to kill pid 1')
      const entry = this.processes.get(pid)
      if (entry === undefined || entry.exited) return
      const name = (signal ?? 'SIGTERM').replace(/^SIG/u, '')
      // The image has no `kill` binary; the shell builtin is always available.
      const result = await this.cli.run(['exec', this.name, 'sh', '-c', 'kill -s "$1" "$2"', 'sh', name, String(pid)]).catch(error => {
        throw asPlatformError(error)
      })
      if (result.code !== 0 && !/no such process|not found/i.test(result.stderr)) {
        throw failure(result, 'docker kill')
      }
    },

    list: async (): Promise<ProcessInfo[]> => [...this.processes.values()].map(infoOf),

    wait: async (pid: number, signal?: AbortSignal): Promise<ProcessInfo | undefined> => {
      const entry = this.processes.get(pid)
      if (entry === undefined) return undefined
      if (!entry.exited) {
        await new Promise<void>(resolvePromise => {
          const finish = (): void => {
            entry.child.off('close', finish)
            signal?.removeEventListener('abort', finish)
            resolvePromise()
          }
          entry.child.on('close', finish)
          signal?.addEventListener('abort', finish, { once: true })
        })
      }
      return infoOf(entry)
    },

    write: async (pid: number, data: Uint8Array): Promise<void> => {
      this.processes.get(pid)?.child.stdin?.write(data)
    },

    closeStdin: async (pid: number): Promise<void> => {
      this.processes.get(pid)?.child.stdin?.end()
    },
  }

  /** Poll the wrapper's pid file until the container reports it. */
  private async readPidFile(pidFile: string, entry: ProcessEntry): Promise<number | undefined> {
    const deadline = Date.now() + this.limits.startTimeoutMs
    let tries = 0
    for (;;) {
      const result = await this.cli.run(['exec', this.name, 'cat', pidFile]).catch(() => undefined)
      if (result?.code === 0) {
        const text = result.stdout.toString().trim()
        if (/^\d+$/u.test(text)) return Number(text)
      }
      // A wrapper that failed (missing shell, read-only /run) never writes the
      // file; one extra try covers the echo landing just after the exit.
      if (entry.exited && tries >= 1) return undefined
      if (Date.now() >= deadline) return undefined
      tries += 1
      await sleep(50)
    }
  }

  /** Kill the docker CLI child once the process is gone; keeps memory bounded. */
  private prune(): void {
    const exited = [...this.processes.values()].filter(entry => entry.exited)
    for (const entry of exited) {
      if (this.processes.size <= this.limits.maxProcesses) return
      this.processes.delete(entry.pid)
    }
  }

  private liveCount(): number {
    let count = 0
    for (const entry of this.processes.values()) if (!entry.exited) count += 1
    return count
  }

  private tail(entry: ProcessEntry): string {
    return Buffer.concat(entry.chunks.slice(-4)).toString().trim().slice(-500)
  }

  /** Replay retained output from a byte offset, then follow live output. */
  private async *stream(pid: number, from: number): AsyncIterable<Uint8Array> {
    const entry = this.processes.get(pid)
    if (entry === undefined) throw new SandboxPlatformError({ kind: 'not-found' }, `pid ${pid}`)
    let cursor = Math.max(from, entry.startOffset)
    const drain = (): Buffer[] => {
      if (cursor < entry.startOffset) cursor = entry.startOffset
      const out: Buffer[] = []
      let pos = entry.startOffset
      for (const chunk of entry.chunks) {
        const end = pos + chunk.byteLength
        if (end > cursor) {
          out.push(chunk.subarray(Math.max(0, cursor - pos)))
          cursor = end
        }
        pos = end
      }
      return out
    }
    for (;;) {
      for (const chunk of drain()) yield chunk
      if (entry.exited && entry.total <= cursor) return
      let wake: (() => void) | undefined
      const notified = new Promise<void>(resolvePromise => {
        wake = resolvePromise
        entry.readers.add(resolvePromise)
      })
      try {
        const pending = drain()
        if (pending.length > 0) {
          for (const chunk of pending) yield chunk
          continue
        }
        await notified
      } finally {
        if (wake !== undefined) entry.readers.delete(wake)
      }
    }
  }

  readonly files = {
    read: async (path: string): Promise<Uint8Array> => {
      const target = this.resolveGuest(path).guest
      const result = await this.run(['cat', '--', target], { maxStdoutBytes: this.limits.maxFileBytes }).catch(error => {
        throw asPlatformError(error)
      })
      if (result.code !== 0) throw failure(result, `read ${path}`)
      return result.stdout
    },

    write: async (path: string, data: Uint8Array): Promise<void> => {
      const target = this.writable(path)
      const result = await this.runStdin(
        ['sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', target],
        data,
      ).catch(error => {
        throw asPlatformError(error)
      })
      if (result.code !== 0) throw failure(result, `write ${path}`)
    },

    list: async (path: string): Promise<DirEntry[]> => {
      const target = this.resolveGuest(path).guest
      const result = await this.run(['find', target, '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\\0%f\\0%s\\0']).catch(error => {
        throw asPlatformError(error)
      })
      if (result.code !== 0) throw failure(result, `list ${path}`)
      const fields = result.stdout.toString('utf8').split('\0')
      const entries: DirEntry[] = []
      for (let index = 0; index + 2 < fields.length; index += 3) {
        const kind = fields[index] ?? ''
        const name = fields[index + 1] ?? ''
        if (name === '') continue
        entries.push({
          name,
          path: posix.join(target, name),
          type: kind === 'f' ? 'file' : kind === 'd' ? 'directory' : kind === 'l' ? 'symlink' : 'other',
          size: Number(fields[index + 2] ?? 0),
        })
      }
      return entries
    },

    stat: async (path: string): Promise<FileStat | undefined> => {
      const guest = path.startsWith('/')
        ? posix.normalize(path)
        : posix.normalize(posix.join(this.layout.workspaceRoot, path))
      try {
        this.resolveGuest(path)
      } catch (error) {
        // Probe of an ancestor such as `/desk/.git` is a legitimate question.
        if (error instanceof SandboxPlatformError && error.failure.kind === 'unauthorized') return undefined
        throw error
      }
      // `stat -c` does not interpret `\0`; `--printf` does (and takes no trailing newline).
      // LC_ALL pins `%F` to the untranslated file-type names the mapping below expects.
      const result = await this.run(['env', 'LC_ALL=C', 'stat', '--printf', '%F\\n%s\\n%Y\\n', '--', guest]).catch(error => {
        throw asPlatformError(error)
      })
      if (result.code !== 0) {
        if (isMissing(result)) return undefined
        throw failure(result, `stat ${path}`)
      }
      const [kind = '', size = '0', mtime = '0'] = result.stdout.toString('utf8').split('\n')
      return {
        path,
        type: kind.startsWith('directory') ? 'directory' : kind.startsWith('symbolic link') ? 'symlink' : kind.startsWith('regular') ? 'file' : 'other',
        size: Number(size),
        mtimeMs: Number.parseFloat(mtime) * 1000,
      }
    },

    remove: async (path: string): Promise<void> => {
      const target = this.writable(path)
      const result = await this.run(['rm', '-rf', '--', target]).catch(error => {
        throw asPlatformError(error)
      })
      if (result.code !== 0) throw failure(result, `remove ${path}`)
    },

    rename: async (from: string, to: string): Promise<void> => {
      const source = this.writable(from)
      const target = this.writable(to)
      const result = await this.run(
        ['sh', '-c', 'mkdir -p -- "$(dirname -- "$2")" && mv -- "$1" "$2"', 'sh', source, target],
      ).catch(error => {
        throw asPlatformError(error)
      })
      if (result.code !== 0) throw failure(result, `rename ${from}`)
    },

    makeDir: async (path: string): Promise<void> => {
      const target = this.writable(path)
      const result = await this.run(['mkdir', '-p', '--', target]).catch(error => {
        throw asPlatformError(error)
      })
      if (result.code !== 0) throw failure(result, `mkdir ${path}`)
    },
  }
}

/** Docker CLI backed by the local binary, no shell in between. */
export function createDockerCli(bin: string): DockerCli {
  return {
    run: (args, options = {}) => runCli(bin, args, options),
    spawn: (args, options) => spawn(bin, [...args], { stdio: [options.stdin, 'pipe', 'pipe'] }),
  }
}

function runCli(bin: string, args: readonly string[], options: DockerCliRunOptions): Promise<DockerCliResult> {
  return new Promise<DockerCliResult>((resolvePromise, reject) => {
    const child = spawn(bin, [...args], {
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      signal: options.signal,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      action()
    }
    const fail = (error: Error): void => finish(() => reject(error))
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        fail(new SandboxPlatformError(
          { kind: 'unavailable', retryable: true, detail: `docker ${args[0] ?? ''} timed out` },
          `docker ${args[0] ?? ''} timed out after ${options.timeoutMs}ms`,
        ))
      }, options.timeoutMs)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > (options.maxStdoutBytes ?? 64 * 1024 * 1024)) {
        child.kill('SIGKILL')
        fail(new SandboxPlatformError(
          { kind: 'unavailable', retryable: false, detail: 'docker output exceeded the limit' },
          'sandboxes: docker output exceeded maxStdoutBytes',
        ))
        return
      }
      stdout.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        fail(new SandboxPlatformError(
          { kind: 'unavailable', retryable: false, detail: `docker CLI not found: ${bin}` },
          `sandboxes: docker CLI not found: ${bin}`,
        ))
        return
      }
      fail(error)
    })
    child.on('close', code => {
      finish(() => resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }))
    })
    if (options.input !== undefined) child.stdin?.end(Buffer.from(options.input))
  })
}

function defaultUser(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
  return `${uid}:${gid}`
}

function normalizeDir(path: string): string {
  const trimmed = path.trim().replace(/\/+$/u, '')
  return trimmed === '' ? '/' : trimmed
}

function toInfo(externalId: string, inspected: InspectContainer): SandboxInfo {
  const status = inspected.State?.Status ?? 'created'
  const state = status === 'running' ? 'running' : status === 'paused' ? 'paused' : 'stopped'
  const createdAt = inspected.Created === undefined ? Date.now() : Date.parse(inspected.Created)
  return { externalId, endpoint: externalId, state, createdAt: Number.isFinite(createdAt) ? createdAt : Date.now() }
}

function infoOf(entry: ProcessEntry): ProcessInfo {
  return entry.exited
    ? { pid: entry.pid, argv: entry.argv, state: 'exited', exitCode: entry.exitCode }
    : { pid: entry.pid, argv: entry.argv, state: 'running' }
}

function isMissing(result: DockerCliResult): boolean {
  return /no such file or directory|cannot stat|cannot access|not found/i.test(result.stderr)
}

/** Map a failed CLI call onto the four platform kinds. */
function failure(result: DockerCliResult, context: string): SandboxPlatformError {
  const stderr = result.stderr.trim()
  const detail = stderr === '' ? `${context} exited ${result.code}` : stderr
  if (/no such container|no such object/i.test(stderr)) return new SandboxPlatformError({ kind: 'not-found' }, detail)
  if (/no such file or directory|cannot stat|cannot access/i.test(stderr)) return new SandboxPlatformError({ kind: 'not-found' }, detail)
  if (/permission denied|read-only file system|operation not permitted|not permitted/i.test(stderr)) {
    return new SandboxPlatformError({ kind: 'unauthorized' }, detail)
  }
  if (/cannot connect to the docker daemon|docker daemon|connection refused|is the docker daemon running|context/i.test(stderr)) {
    return new SandboxPlatformError({ kind: 'unavailable', retryable: true, detail }, detail)
  }
  if (/is not running|container .* is not running/i.test(stderr)) {
    return new SandboxPlatformError({ kind: 'unavailable', retryable: true, detail }, detail)
  }
  return new SandboxPlatformError({ kind: 'unavailable', retryable: false, detail }, detail)
}

function asPlatformError(error: unknown): SandboxPlatformError {
  if (error instanceof SandboxPlatformError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new SandboxPlatformError({ kind: 'unavailable', retryable: true, detail: message }, message)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

/** Stable hash used for a label; keys themselves never go into labels. */
export function dockerKeyLabel(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}
