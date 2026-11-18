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
 *   destroy     kills only the direct child processes, not their descendants
 *
 * Shared mode (an `objectDir` plus mounts) maps guest directories onto the same
 * local object keys the platform writes. `readOnly` mounts are enforced for
 * `files` mutations only — child processes run with plain OS permissions.
 *
 * Retained output is capped by `outputBufferBytes`; when the cap is exceeded the
 * oldest bytes are dropped, so a re-attach (`process.connect(pid, from)`) is
 * lossy and starts at the first byte still retained rather than at `from`.
 * `capabilities.signal` stays `false`: there is no signalling channel beyond
 * `process.kill`.
 *
 * So: use it for wiring and behaviour, never for security testing.
 *
 * @module @brain/dsh-e2b/mock-adapter
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
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

/**
 * A guest path outside every mount. In the VM that directory simply does not
 * exist, so `stat` answers "missing" while real I/O reports the policy failure.
 */
class NotMountedError extends SandboxPlatformError {
  constructor(path: string) {
    super({ kind: 'unauthorized' }, `path is not mounted: ${path}`)
  }
}

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
  readonly createdAt: number
}

/** One running process and its retained output. */
interface MockProcess {
  readonly pid: number
  readonly argv: readonly string[]
  child: ChildProcess
  chunks: Buffer[]
  /** Bytes currently retained in `chunks`. */
  buffered: number
  /** Absolute offset of the first retained byte; advances when chunks are dropped. */
  startOffset: number
  /** Absolute number of bytes ever seen; `startOffset + buffered` outside races. */
  total: number
  /** Readers to wake when output or exit arrives. */
  readonly readers: Set<() => void>
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
    const createdAt = Date.now()
    if (shared) {
      for (const mount of spec.mounts ?? []) {
        await mkdir(this.mountHost(mount), { recursive: true })
      }
    } else {
      await mkdir(workspaceRoot, { recursive: true })
    }
    const handle: SandboxHandle = { externalId, endpoint: shared ? this.objectDir! : workspaceRoot, workspaceRoot }
    this.sandboxes.set(externalId, handle)
    this.layouts.set(externalId, { objectDir: shared ? this.objectDir : undefined, mounts: spec.mounts ?? [], guestRoot: workspaceRoot, createdAt })
    this.processes.set(externalId, new Map())
    return handle
  }

  /**
   * Validate a mount and return the host directory behind it.
   *
   * A mount is a policy boundary: its guest directory must be absolute and
   * non-root, and its bucket path must stay inside the object directory. Bad
   * mounts are refused at create time so later path resolution can be simple.
   */
  private mountHost(mount: SandboxMount): string {
    const guest = posix.normalize(mount.mountDir)
    if (!mount.mountDir.startsWith('/') || guest === '/') {
      throw new SandboxPlatformError({ kind: 'unauthorized' }, `invalid mountDir: ${mount.mountDir}`)
    }
    const base = resolve(this.objectDir!, mount.bucketPath)
    const rel = relative(this.objectDir!, base)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new SandboxPlatformError({ kind: 'unauthorized' }, `bucketPath escapes object dir: ${mount.bucketPath}`)
    }
    return base
  }

  async get(externalId: string): Promise<SandboxInfo | undefined> {
    const handle = this.sandboxes.get(externalId)
    if (handle === undefined) return undefined
    const layout = this.layouts.get(externalId)
    return { externalId, endpoint: handle.endpoint, state: 'running', createdAt: layout?.createdAt ?? Date.now() }
  }

  async list(): Promise<SandboxInfo[]> {
    return [...this.sandboxes.keys()].map(externalId => ({
      externalId,
      endpoint: this.sandboxes.get(externalId)?.endpoint ?? '',
      state: 'running' as const,
      createdAt: this.layouts.get(externalId)?.createdAt ?? Date.now(),
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
  private resolvePath(path: string): { host: string; readOnly: boolean } {
    if (this.layout.objectDir !== undefined) return this.shared(path)
    const absolute = resolve(this.handle.workspaceRoot, path)
    const rel = relative(this.handle.workspaceRoot, absolute)
    if (rel.startsWith('..') || (rel !== '' && resolve(absolute) !== absolute)) {
      throw new SandboxPlatformError({ kind: 'unauthorized' }, `path escapes sandbox: ${path}`)
    }
    return { host: absolute, readOnly: false }
  }

  /** Map a guest path onto the shared object directory. One mount never sees another. */
  private shared(path: string): { host: string; readOnly: boolean } {
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
      return { host, readOnly: mount.readOnly === true }
    }
    throw new NotMountedError(path)
  }

  /** Refuse a mutation on a read-only mount. */
  private writable(target: { host: string; readOnly: boolean }, path: string): string {
    if (target.readOnly) throw new SandboxPlatformError({ kind: 'unauthorized' }, `path is read-only: ${path}`)
    return target.host
  }

  readonly process = {
    start: async (spec: ProcessSpec, handlers?: ProcessHandlers): Promise<{ pid: number }> => {
      spec.signal?.throwIfAborted()
      const cwd = this.resolvePath(spec.cwd).host
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
        startOffset: 0,
        total: 0,
        readers: new Set(),
        exited: false,
      }
      const notify = (): void => {
        for (const wake of entry.readers) wake()
      }
      const keep = (chunk: Buffer, channel: 'stdout' | 'stderr'): void => {
        entry.chunks.push(chunk)
        entry.buffered += chunk.byteLength
        entry.total += chunk.byteLength
        // Bound retained output; drop the oldest chunks first, advancing the
        // absolute offset so re-attach readers know where retained bytes begin.
        while (entry.buffered > this.bufferLimit && entry.chunks.length > 1) {
          const dropped = entry.chunks.shift()
          const size = dropped?.byteLength ?? 0
          entry.buffered -= size
          entry.startOffset += size
        }
        handlers?.[channel]?.(chunk)
        notify()
      }
      child.stdout?.on('data', (chunk: Buffer) => keep(chunk, 'stdout'))
      child.stderr?.on('data', (chunk: Buffer) => keep(chunk, 'stderr'))
      child.on('exit', code => {
        entry.exited = true
        entry.exitCode = code ?? undefined
        notify()
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

    // Absolute cursor into the byte stream. `from` below the retained window is
    // clamped forward: bytes already dropped cannot be replayed.
    let cursor = Math.max(from, entry.startOffset)
    /** Emit retained bytes at or after `cursor`; stable across truncation. */
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
      // Register the reader before re-checking so output appended between the
      // drain above and this await still wakes us (no lost-output window).
      let wake: (() => void) | undefined
      const notified = new Promise<void>(resolve => {
        wake = resolve
        entry.readers.add(resolve)
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
      try {
        return await readFile(this.resolvePath(path).host)
      } catch (error) {
        throw mapFsError(error)
      }
    },

    write: async (path: string, data: Uint8Array): Promise<void> => {
      try {
        const host = this.writable(this.resolvePath(path), path)
        await mkdir(dirname(host), { recursive: true })
        await writeFile(host, data)
      } catch (error) {
        throw mapFsError(error)
      }
    },

    list: async (path: string): Promise<DirEntry[]> => {
      try {
        const entries = await readdir(this.resolvePath(path).host, { withFileTypes: true })
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
        const info = await stat(this.resolvePath(path).host)
        return {
          path,
          type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
          size: info.size,
          mtimeMs: info.mtimeMs,
        }
      } catch (error) {
        // Probing an ancestor of the workspace (a project-root marker such as
        // `/desk/.git`) is a legitimate "does this exist" question. Those
        // directories are not mounted, so answer missing rather than failing
        // the whole turn with an authorization error.
        if (error instanceof NotMountedError || isMissing(error)) return undefined
        throw mapFsError(error)
      }
    },

    remove: async (path: string): Promise<void> => {
      await rm(this.writable(this.resolvePath(path), path), { recursive: true, force: true })
    },

    rename: async (from: string, to: string): Promise<void> => {
      const source = this.writable(this.resolvePath(from), from)
      const target = this.writable(this.resolvePath(to), to)
      await mkdir(dirname(target), { recursive: true })
      await rename(source, target)
    },

    makeDir: async (path: string): Promise<void> => {
      await mkdir(this.writable(this.resolvePath(path), path), { recursive: true })
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
