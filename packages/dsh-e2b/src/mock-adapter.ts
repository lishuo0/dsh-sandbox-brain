/**
 * Mock platform: runs "sandboxes" as plain directories and child processes on the
 * local machine.
 *
 * It exists so the whole stack — routing, binding store, providers, API — can be
 * exercised on a laptop with no E2B account and no VM. What it does NOT give:
 *
 *   isolation   processes run as your OS user; the path jail is a policy check in
 *               trusted code, not a kernel boundary
 *   pty         no pseudo-terminal; interactive tools are unavailable
 *   pause       no suspend/resume
 *
 * So: use it for wiring and behaviour, never for security testing.
 *
 * @module @brain/dsh-e2b/mock-adapter
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  DirEntry,
  FileStat,
  SandboxMount,
  ProcessHandlers,
  ProcessInfo,
  ProcessSpec,
  SandboxClient,
  SandboxHandle,
  SandboxInfo,
  SandboxPlatform,
  SandboxSpec,
} from './contract.ts'
import { SandboxPlatformError } from './contract.ts'

/** Configuration for the mock adapter. */
export interface MockConfig {
  /** Directory holding every mock sandbox. Defaults to `~/.dsh/sandboxes`. */
  readonly rootDir?: string
  /**
   * Shared object directory. When set, guest mounts are directories inside it,
   * using the same keys the platform writes. No cloud account is required.
   */
  readonly objectDir?: string
  /** Milliseconds of output kept per process for re-attachment. */
  readonly outputBufferBytes?: number
}

interface Layout {
  readonly objectDir?: string
  readonly mounts: readonly SandboxMount[]
  readonly guestRoot: string
}

/** One running process and its retained output. */
interface MockProcess {
  readonly pid: number
  readonly argv: readonly string[]
  child: ChildProcess
  chunks: Buffer[]
  buffered: number
  exitCode?: number
  exited: boolean
}

/** Platform backed by local directories and child processes. */
export class MockPlatform implements SandboxPlatform {
  readonly capabilities = { pause: false, snapshot: false }

  private readonly rootDir: string
  private readonly objectDir?: string
  private readonly bufferLimit: number
  private readonly sandboxes = new Map<string, SandboxHandle>()
  private readonly layouts = new Map<string, Layout>()
  private readonly processes = new Map<string, Map<number, MockProcess>>()

  constructor(config: MockConfig = {}) {
    this.rootDir = resolve(config.rootDir ?? join(homedir(), '.dsh', 'sandboxes'))
    const objectDir = config.objectDir?.trim()
    this.objectDir = objectDir ? resolve(objectDir) : undefined
    this.bufferLimit = config.outputBufferBytes ?? 1_048_576
  }

  async create(spec: SandboxSpec, signal?: AbortSignal): Promise<SandboxHandle> {
    signal?.throwIfAborted()
    const externalId = `mock-${randomUUID()}`
    const shared = this.objectDir !== undefined && (spec.mounts?.length ?? 0) > 0 && spec.workspaceRoot !== undefined
    const workspaceRoot = shared ? spec.workspaceRoot! : join(this.rootDir, externalId, 'workspace')
    if (shared) {
      for (const mount of spec.mounts ?? []) {
        await mkdir(resolve(this.objectDir!, mount.bucketPath), { recursive: true })
      }
    } else {
      await mkdir(workspaceRoot, { recursive: true })
    }
    const handle: SandboxHandle = { externalId, endpoint: shared ? this.objectDir! : workspaceRoot, workspaceRoot }
    this.sandboxes.set(externalId, handle)
    this.layouts.set(externalId, { objectDir: shared ? this.objectDir : undefined, mounts: spec.mounts ?? [], guestRoot: workspaceRoot })
    this.processes.set(externalId, new Map())
    return handle
  }

  async get(externalId: string): Promise<SandboxInfo | undefined> {
    const handle = this.sandboxes.get(externalId)
    if (handle === undefined) return undefined
    return { externalId, endpoint: handle.endpoint, state: 'running', createdAt: Date.now() }
  }

  async list(): Promise<SandboxInfo[]> {
    return [...this.sandboxes.keys()].map(externalId => ({
      externalId,
      endpoint: this.sandboxes.get(externalId)?.endpoint ?? '',
      state: 'running' as const,
      createdAt: Date.now(),
    }))
  }

  async destroy(externalId: string): Promise<void> {
    for (const process of this.processes.get(externalId)?.values() ?? []) {
      process.child.kill('SIGKILL')
    }
    this.processes.delete(externalId)
    this.sandboxes.delete(externalId)
    const layout = this.layouts.get(externalId)
    this.layouts.delete(externalId)
    if (layout?.objectDir === undefined) {
      await rm(join(this.rootDir, externalId), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * Open the sandbox-level client.
   * @param externalId - sandbox to attach to.
   * @returns the client.
   */
  async client(externalId: string): Promise<SandboxClient> {
    const handle = this.sandboxes.get(externalId)
    if (handle === undefined) throw new SandboxPlatformError({ kind: 'not-found' }, externalId)
    const layout = this.layouts.get(externalId)
    if (layout === undefined) throw new SandboxPlatformError({ kind: 'not-found' }, externalId)
    return new MockClient(handle, layout, this.processes.get(externalId) as Map<number, MockProcess>, this.bufferLimit)
  }
}

/** Sandbox-level client over the local machine, jailed to one directory. */
class MockClient implements SandboxClient {
  readonly capabilities = { pty: false, reattach: true, signal: false, fileVersion: false }

  constructor(
    private readonly handle: SandboxHandle,
    private readonly layout: Layout,
    private readonly processes: Map<number, MockProcess>,
    private readonly bufferLimit: number,
  ) {}

  /**
   * Resolve a path inside the sandbox.
   *
   * Escapes are refused rather than clamped: a caller that tries to leave the
   * sandbox has a bug, and silently rewriting the path would hide it.
   */
  private jail(path: string): string {
    if (this.layout.objectDir !== undefined) return this.shared(path)
    const absolute = resolve(this.handle.workspaceRoot, path)
    const rel = relative(this.handle.workspaceRoot, absolute)
    if (rel.startsWith('..') || (rel !== '' && resolve(absolute) !== absolute)) {
      throw new SandboxPlatformError({ kind: 'unauthorized' }, `path escapes sandbox: ${path}`)
    }
    return absolute
  }

  /** Map a guest path onto the shared object directory. One mount never sees another. */
  private shared(path: string): string {
    const guest = path.startsWith('/') ? posix.normalize(path) : posix.normalize(posix.join(this.layout.guestRoot, path))
    const mounts = [...this.layout.mounts].sort((left, right) => right.mountDir.length - left.mountDir.length)
    for (const mount of mounts) {
      const dir = mount.mountDir.replace(/\/+$/, '')
      if (guest !== dir && !guest.startsWith(`${dir}/`)) continue
      const base = resolve(this.layout.objectDir!, mount.bucketPath)
      const rest = guest.slice(dir.length).replace(/^\//, '')
      const host = resolve(base, rest)
      const rel = relative(base, host)
      if (rel.startsWith('..')) {
        throw new SandboxPlatformError({ kind: 'unauthorized' }, `path escapes sandbox: ${path}`)
      }
      return host
    }
    throw new SandboxPlatformError({ kind: 'unauthorized' }, `path is not mounted: ${path}`)
  }

  readonly process = {
    start: async (spec: ProcessSpec, handlers?: ProcessHandlers): Promise<{ pid: number }> => {
      spec.signal?.throwIfAborted()
      const cwd = this.jail(spec.cwd)
      const child = spawn(spec.argv[0] as string, spec.argv.slice(1), {
        cwd,
        env: { ...process.env, ...spec.env },
        stdio: [spec.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
      const entry: MockProcess = {
        pid: child.pid ?? -1,
        argv: spec.argv,
        child,
        chunks: [],
        buffered: 0,
        exited: false,
      }
      const keep = (chunk: Buffer, channel: 'stdout' | 'stderr'): void => {
        entry.chunks.push(chunk)
        entry.buffered += chunk.byteLength
        // Bound retained output; drop the oldest chunks first.
        while (entry.buffered > this.bufferLimit && entry.chunks.length > 1) {
          const dropped = entry.chunks.shift()
          entry.buffered -= dropped?.byteLength ?? 0
        }
        handlers?.[channel]?.(chunk)
      }
      child.stdout?.on('data', (chunk: Buffer) => keep(chunk, 'stdout'))
      child.stderr?.on('data', (chunk: Buffer) => keep(chunk, 'stderr'))
      child.on('exit', code => {
        entry.exited = true
        entry.exitCode = code ?? undefined
      })
      if (entry.pid > 0) this.processes.set(entry.pid, entry)
      // The real platform cancels the start handshake; the local child has
      // already started, so the abort terminates it instead.
      spec.signal?.addEventListener('abort', () => {
        if (!entry.exited) entry.child.kill('SIGKILL')
      }, { once: true })
      return { pid: entry.pid }
    },

    connect: (pid: number, from = 0): AsyncIterable<Uint8Array> =>
      this.stream(pid, from),

    status: async (pid: number): Promise<ProcessInfo | undefined> => {
      const entry = this.processes.get(pid)
      if (entry === undefined) return undefined
      return !entry.exited
        ? { pid, argv: entry.argv, state: 'running' }
        : { pid, argv: entry.argv, state: 'exited', exitCode: entry.exitCode }
    },

    kill: async (pid: number, signal?: string): Promise<void> => {
      const entry = this.processes.get(pid)
      if (entry === undefined) return
      entry.child.kill((signal as NodeJS.Signals | undefined) ?? 'SIGTERM')
    },

    list: async (): Promise<ProcessInfo[]> =>
      [...this.processes.values()].map(entry =>
        !entry.exited
          ? { pid: entry.pid, argv: entry.argv, state: 'running' as const }
          : { pid: entry.pid, argv: entry.argv, state: 'exited' as const, exitCode: entry.exitCode }),

    wait: async (pid: number, signal?: AbortSignal): Promise<ProcessInfo | undefined> => {
      const entry = this.processes.get(pid)
      if (entry === undefined) return undefined
      if (!entry.exited) {
        await new Promise<void>(resolve => {
          const finish = (): void => {
            entry.child.off('exit', finish)
            signal?.removeEventListener('abort', finish)
            resolve()
          }
          entry.child.on('exit', finish)
          signal?.addEventListener('abort', finish, { once: true })
        })
      }
      return await this.process.status(pid)
    },

    write: async (pid: number, data: Uint8Array): Promise<void> => {
      this.processes.get(pid)?.child.stdin?.write(data)
    },

    closeStdin: async (pid: number): Promise<void> => {
      this.processes.get(pid)?.child.stdin?.end()
    },
  }

  /**
   * Replay retained output from a byte offset, then follow live output.
   *
   * This is what makes `reattach: true` honest: a reconnecting reader gets
   * everything it missed plus what happens next.
   */
  private async *stream(pid: number, from: number): AsyncIterable<Uint8Array> {
    const entry = this.processes.get(pid)
    if (entry === undefined) throw new SandboxPlatformError({ kind: 'not-found' }, `pid ${pid}`)

    const replay = Buffer.concat(entry.chunks)
    if (replay.byteLength > from) yield replay.subarray(from)

    if (entry.exited) {
      entry.child.removeAllListeners('exit')
      return
    }
    const queue: Buffer[] = []
    let wake: (() => void) | undefined
    const push = (chunk: Buffer): void => {
      queue.push(chunk)
      wake?.()
      wake = undefined
    }
    entry.child.stdout?.on('data', push)
    entry.child.stderr?.on('data', push)
    const done = new Promise<void>(resolveDone => {
      entry.child.once('exit', () => resolveDone())
    })
    try {
      for (;;) {
        if (queue.length > 0) {
          yield Buffer.concat(queue.splice(0))
          continue
        }
        const finished = await Promise.race([done.then(() => true as const), new Promise<false>(r => { wake = () => r(false) })])
        if (finished && queue.length === 0) return
      }
    } finally {
      entry.child.stdout?.off('data', push)
      entry.child.stderr?.off('data', push)
    }
  }

  readonly files = {
    read: async (path: string): Promise<Uint8Array> => {
      try {
        return await readFile(this.jail(path))
      } catch (error) {
        throw mapFsError(error)
      }
    },

    write: async (path: string, data: Uint8Array): Promise<void> => {
      try {
        await mkdir(dirname(this.jail(path)), { recursive: true })
        await writeFile(this.jail(path), data)
      } catch (error) {
        throw mapFsError(error)
      }
    },

    list: async (path: string): Promise<DirEntry[]> => {
      try {
        const entries = await readdir(this.jail(path), { withFileTypes: true })
        return entries.map(entry => ({
          name: entry.name,
          path: join(path, entry.name),
          type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'other',
        }))
      } catch (error) {
        throw mapFsError(error)
      }
    },

    stat: async (path: string): Promise<FileStat | undefined> => {
      try {
        const info = await stat(this.jail(path))
        return {
          path,
          type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
          size: info.size,
          mtimeMs: info.mtimeMs,
        }
      } catch (error) {
        if (isMissing(error)) return undefined
        throw mapFsError(error)
      }
    },

    remove: async (path: string): Promise<void> => {
      await rm(this.jail(path), { recursive: true, force: true })
    },

    rename: async (from: string, to: string): Promise<void> => {
      await mkdir(dirname(this.jail(to)), { recursive: true })
      await rename(this.jail(from), this.jail(to))
    },

    makeDir: async (path: string): Promise<void> => {
      await mkdir(this.jail(path), { recursive: true })
    },
  }
}

/** Map an fs error onto the platform kinds. */
function mapFsError(error: unknown): SandboxPlatformError {
  // The jail already reported a structured failure; re-mapping would turn a
  // deliberate `unauthorized` into a generic `unavailable`.
  if (error instanceof SandboxPlatformError) return error
  if (isMissing(error)) return new SandboxPlatformError({ kind: 'not-found' })
  const message = error instanceof Error ? error.message : String(error)
  if (/EACCES|EPERM/.test(message)) return new SandboxPlatformError({ kind: 'unauthorized' }, message)
  return new SandboxPlatformError({ kind: 'unavailable', retryable: false, detail: message }, message)
}

/** Whether the error is a missing path. */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/** Separator re-export so the jail check reads the same on every platform. */
export const SEP = sep
