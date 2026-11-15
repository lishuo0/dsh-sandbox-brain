/**
 * E2B implementation of the platform contract.
 *
 * This is the ONLY module that knows E2B exists. Everything it returns is
 * expressed in `contract.ts` types, so replacing the platform means replacing
 * this file and nothing else.
 *
 * Aliyun Agent Sandbox speaks the E2B SDK protocol; pointing `apiUrl` and
 * `domain` at the regional endpoint is enough to use it. Aliyun-specific
 * creation options are passed through `metadata` and `volumeMounts`.
 *
 * @module @brain/dsh-e2b/e2b-adapter
 */

import { randomUUID } from 'node:crypto'
import {
  AuthenticationError,
  FileNotFoundError,
  InvalidArgumentError,
  NotFoundError,
  RateLimitError,
  Sandbox,
  SandboxNotFoundError,
  TemplateError,
  TimeoutError,
} from 'e2b'
import type {
  CommandHandle,
  EntryInfo,
  ProcessInfo as E2bProcessInfo,
  SandboxInfo as E2bSandboxInfo,
} from 'e2b'
import {
  SandboxPlatformError,
  type DirEntry,
  type FileStat,
  type ProcessHandlers,
  type ProcessInfo,
  type ProcessSpec,
  type SandboxClient,
  type SandboxFilter,
  type SandboxHandle,
  type SandboxInfo,
  type SandboxMount,
  type SandboxPlatform,
  type SandboxSpec,
} from './contract.ts'

/** Configuration for the E2B adapter. All values come from the deployment. */
export interface E2bConfig {
  /** API key for the control plane, or Aliyun Agent Sandbox. */
  readonly apiKey: string
  /** Control-plane base URL, e.g. `https://api.cn-beijing.sandbox.aliyuncs.com`. */
  readonly apiUrl?: string
  /** Domain suffix used to build sandbox hostnames, e.g. `cn-beijing.sandbox.aliyuncs.com`. */
  readonly domain?: string
  /** Template name or ID. */
  readonly template: string
  /**
   * Execution role assumed by the sandbox, sent as
   * `metadata["fc.sandbox.auth.role"]`. Required when a volume is mounted.
   */
  readonly roleArn?: string
  /** Extra metadata applied to every sandbox; merged before per-sandbox labels. */
  readonly metadata?: Readonly<Record<string, string>>
  /** Workspace root inside the sandbox when no per-sandbox volume is supplied. */
  readonly workspaceRoot?: string
  /** Extra environment variables for every sandbox. */
  readonly envs?: Readonly<Record<string, string>>
  /** Action when the platform TTL expires. Defaults to killing the sandbox. */
  readonly onTimeout?: 'pause' | 'kill'
  /**
   * Let the sandbox reach the public internet (egress).
   * `false` is the same as denying all outbound traffic.
   * @default true
   */
  readonly allowInternetAccess?: boolean
  /**
   * Let the public internet reach sandbox URLs without authentication.
   * The control plane still connects with its access token.
   * @default false
   */
  readonly allowPublicTraffic?: boolean
  /** Set false for deployments issuing keys without the `e2b_` prefix. */
  readonly validateApiKey?: boolean
  /**
   * Control-plane request timeout in milliseconds.
   *
   * Bounds every RPC that is not a command: sandbox create/get/list/kill and
   * the command start handshake. It is deliberately unrelated to
   * {@link commandTimeoutMs}, which bounds the *lifetime* of a command.
   */
  readonly requestTimeoutMs?: number
  /**
   * Timeout applied when connecting (and resuming) a sandbox, in milliseconds.
   * Connecting extends a running sandbox's TTL only when the new timeout is longer.
   */
  readonly connectTimeoutMs?: number
  /**
   * Execution budget for one command, in milliseconds.
   *
   * The SDK defaults to 60 s; background processes count against it, so the
   * deployment must raise it for long-running jobs.
   */
  readonly commandTimeoutMs?: number
  /** Diagnostic sink for control-plane failures that must not be swallowed. */
  readonly onLog?: (message: string) => void
}

/** Default envd port inside an E2B-compatible sandbox. */
const ENVD_PORT = 49983

/** Workspace root used by the template this package expects. */
const DEFAULT_WORKSPACE_ROOT = '/home/user'

/** Metadata key Aliyun reads to find the execution role. */
const ROLE_METADATA_KEY = 'fc.sandbox.auth.role'

/** Metadata key Aliyun reads to mount OSS prefixes directly. */
const OSS_MOUNT_METADATA_KEY = 'fc.sandbox.storage.oss'

/** Default connect timeout: 15 minutes, matching the default sandbox TTL. */
const DEFAULT_CONNECT_TIMEOUT_MS = 900_000

/** Default command budget: one hour. */
const DEFAULT_COMMAND_TIMEOUT_MS = 3_600_000

/**
 * Default start-handshake timeout.
 *
 * The command may keep running for {@link DEFAULT_COMMAND_TIMEOUT_MS}; this
 * only bounds how long the controller waits for a pid. Without it a stalled
 * control plane leaves a tool call — and the whole turn — open forever.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

/** Default per-RPC timeout for cheap control-plane calls (list/status/kill). */
const DEFAULT_CALL_TIMEOUT_MS = 10_000

/** Environment name carrying the per-command marker the fallback matches on. */
const CALL_MARKER_ENV = 'DSH_CALL_ID'

/** How often {@link E2bClient.watchExit} re-reads the process list. */
const WATCH_EXIT_POLL_MS = 2_000

/** Consecutive absences that mean the process really exited. */
const WATCH_EXIT_ABSENT_CONFIRMATIONS = 2

/** Consecutive list failures after which the outcome is unknown. */
const WATCH_EXIT_FAILURE_LIMIT = 3

/** Connection options shared by every control-plane call. */
interface ControlPlaneOptions {
  readonly apiKey: string
  readonly apiUrl?: string
  readonly domain?: string
  readonly validateApiKey?: boolean
  readonly requestTimeoutMs?: number
}

/** E2B adapter. */
export class E2bPlatform implements SandboxPlatform {
  readonly capabilities = { pause: true, snapshot: false }

  private readonly clients = new Map<string, Promise<E2bClient>>()

  constructor(private readonly config: E2bConfig) {}

  /**
   * Options shared by every control-plane call.
   *
   * `requestTimeoutMs` is deliberately excluded from creation: pushing a
   * template and mounting OSS legitimately outlives the start-handshake budget.
   */
  private options(options: { requestTimeoutMs?: boolean } = {}): ControlPlaneOptions {
    return {
      apiKey: this.config.apiKey,
      ...(this.config.apiUrl === undefined ? {} : { apiUrl: this.config.apiUrl }),
      ...(this.config.domain === undefined ? {} : { domain: this.config.domain }),
      ...(this.config.validateApiKey === undefined ? {} : { validateApiKey: this.config.validateApiKey }),
      ...(this.config.requestTimeoutMs === undefined || options.requestTimeoutMs === false
        ? {}
        : { requestTimeoutMs: this.config.requestTimeoutMs }),
    }
  }

  /** The workspace root this deployment exposes to DSH. */
  private get workspaceRoot(): string {
    return this.config.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT
  }

  /** Metadata sent at creation: deployment metadata, the role, mounts, then labels. */
  private metadata(
    labels: Readonly<Record<string, string>> | undefined,
    mounts: readonly SandboxMount[] | undefined,
  ): Record<string, string> {
    return {
      ...this.config.metadata,
      ...(this.config.roleArn === undefined ? {} : { [ROLE_METADATA_KEY]: this.config.roleArn }),
      ...(mounts === undefined || mounts.length === 0
        ? {}
        : { [OSS_MOUNT_METADATA_KEY]: JSON.stringify({ mountPoints: mounts.map(ossMount) }) }),
      ...labels,
    }
  }

  async create(spec: SandboxSpec, signal?: AbortSignal): Promise<SandboxHandle> {
    signal?.throwIfAborted()
    // Only the caller-resolved per-sandbox mounts are used. There is no
    // deployment-wide fallback: a shared volume would defeat isolation.
    const mounts = spec.mounts
    const volumes = spec.volumes
    try {
      const sandbox = await Sandbox.create(spec.template || this.config.template, {
        ...this.options({ requestTimeoutMs: false }),
        timeoutMs: spec.timeoutMs,
        lifecycle: { onTimeout: this.config.onTimeout ?? 'kill' },
        // Egress stays open. Public ingress stays closed; envd still
        // accepts the control-plane token.
        allowInternetAccess: this.config.allowInternetAccess ?? true,
        network: { allowPublicTraffic: this.config.allowPublicTraffic ?? false },
        metadata: this.metadata(spec.labels, mounts),
        envs: { ...this.config.envs, ...spec.env },
        // Direct OSS mounts and pre-created volumes are exclusive: both try to
        // own the workspace mount path.
        ...(mounts !== undefined && mounts.length > 0
          ? {}
          : volumes === undefined ? {} : { volumeMounts: { ...volumes } }),
        ...(signal === undefined ? {} : { signal }),
      })
      signal?.throwIfAborted()
      return {
        externalId: sandbox.sandboxId,
        endpoint: sandbox.getHost(ENVD_PORT),
        workspaceRoot: spec.workspaceRoot ?? this.workspaceRoot,
      }
    } catch (error) {
      throw mapError(error)
    }
  }

  async get(externalId: string): Promise<SandboxInfo | undefined> {
    try {
      const info = await Sandbox.getInfo(externalId, this.options())
      return toSandboxInfo(info)
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw mapError(error)
    }
  }

  async list(filter?: SandboxFilter): Promise<SandboxInfo[]> {
    try {
      const paginator = Sandbox.list({
        ...this.options(),
        ...(filter?.labels === undefined ? {} : { query: { metadata: { ...filter.labels } } }),
      })
      const found: SandboxInfo[] = []
      while (paginator.hasNext) {
        const page = await paginator.nextItems()
        for (const info of page) found.push(toSandboxInfo(info))
      }
      return found
    } catch (error) {
      throw mapError(error)
    }
  }

  async destroy(externalId: string): Promise<void> {
    this.clients.delete(externalId)
    try {
      // `false` means already gone; destroying an absent sandbox is success.
      await Sandbox.kill(externalId, this.options())
    } catch (error) {
      if (isNotFound(error)) return
      throw mapError(error)
    }
  }

  async pause(externalId: string): Promise<void> {
    try {
      await Sandbox.pause(externalId, this.options())
      this.clients.delete(externalId)
    } catch (error) {
      throw mapError(error)
    }
  }

  /** Resume by connecting: E2B resumes a paused sandbox on connect. */
  async resume(externalId: string): Promise<void> {
    try {
      await Sandbox.connect(externalId, this.connectOptions())
    } catch (error) {
      throw mapError(error)
    }
  }

  /** Options for connect, which may extend the sandbox TTL. */
  private connectOptions(): ControlPlaneOptions & { timeoutMs: number } {
    return {
      ...this.options(),
      timeoutMs: this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    }
  }

  /**
   * Open (and cache) the sandbox-level client for a running sandbox.
   *
   * Every file and process operation goes through this method, so caching the
   * connected sandbox keeps the provider from reconnecting per operation.
   * @param externalId - platform-side identifier.
   * @returns the client bound to that sandbox.
   */
  async client(externalId: string): Promise<SandboxClient> {
    let pending = this.clients.get(externalId)
    if (pending === undefined) {
      pending = this.connectClient(externalId)
      this.clients.set(externalId, pending)
    }
    return await pending
  }

  /** Connect once and wrap the sandbox. */
  private async connectClient(externalId: string): Promise<E2bClient> {
    try {
      const sandbox = await Sandbox.connect(externalId, this.connectOptions())
      return new E2bClient(sandbox, {
        commandTimeoutMs: this.config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        requestTimeoutMs: this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        callTimeoutMs: Math.min(
          this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
          DEFAULT_CALL_TIMEOUT_MS,
        ),
        onLog: this.config.onLog ?? (() => undefined),
      })
    } catch (error) {
      this.clients.delete(externalId)
      throw mapError(error)
    }
  }
}

/** Timeouts and diagnostics shared by every command RPC on one sandbox. */
interface ClientTimeouts {
  /** Lifetime budget of one command, not a request timeout. */
  readonly commandTimeoutMs: number
  /** Start-handshake budget; a command may outlive it. */
  readonly requestTimeoutMs: number
  /** Budget of one cheap control-plane RPC (list/status/kill). */
  readonly callTimeoutMs: number
  readonly onLog: (message: string) => void
}

/** Sandbox-level client over envd. */
class E2bClient implements SandboxClient {
  /** Persistent state for processes this client started, used for output and exit codes. */
  private readonly processes = new Map<number, ProcessStream>()

  /**
   * `pty` is false because this client does not expose the terminal API yet.
   * `signal` is false because the SDK only sends SIGKILL.
   */
  readonly capabilities = { pty: false, reattach: true, signal: false, fileVersion: false }

  constructor(
    private readonly sandbox: Sandbox,
    private readonly timeouts: ClientTimeouts,
  ) {}

  private log(message: string): void {
    this.timeouts.onLog(`e2b-adapter: ${message}`)
  }

  /**
   * Fallback completion detection for a lost command-exit event.
   *
   * Polls the process list until the pid is absent twice in a row. While the
   * pid is present the command is genuinely running, so there is no overall
   * cap — the command's own `timeoutMs` bounds it. Three consecutive list
   * failures mean the control plane cannot answer; the outcome is settled as
   * unknown rather than leaving the tool call open forever.
   */
  private async watchExit(
    pid: number,
    exitCode: number | undefined,
    stream: ProcessStream,
    settle: () => void,
  ): Promise<void> {
    let absent = 0
    let failures = 0
    for (;;) {
      await delay(WATCH_EXIT_POLL_MS).catch(() => undefined)
      if (stream.done) return
      let running: readonly { pid: number }[]
      try {
        running = await this.sandbox.commands.list({ requestTimeoutMs: this.timeouts.callTimeoutMs })
        failures = 0
      } catch (error) {
        failures += 1
        this.log(`watchExit list failed for pid ${pid} (${failures}/${WATCH_EXIT_FAILURE_LIMIT}): ${messageOf(error)}`)
        if (failures < WATCH_EXIT_FAILURE_LIMIT) continue
        this.log(`watchExit settled pid ${pid} as unknown after ${failures} list failures`)
        stream.settledUnknown = true
        this.settle(stream, settle)
        return
      }
      if (running.some(entry => entry.pid === pid)) {
        absent = 0
        continue
      }
      absent += 1
      if (absent < WATCH_EXIT_ABSENT_CONFIRMATIONS || stream.done) continue
      stream.exitCode = exitCode ?? 0
      this.settle(stream, settle)
      return
    }
  }

  /** Mark one process terminal once, release waiters, and fan out its output. */
  private settle(stream: ProcessStream, settle: () => void): void {
    if (stream.done) return
    stream.done = true
    settle()
    wake(stream)
  }

  /**
   * Best-effort cleanup for a start call that never returned a pid.
   *
   * Every command is launched with a per-call marker in its argv, so the
   * process list can still identify (and kill) a command whose start response
   * was lost. When even the list cannot be read the sandbox's state is
   * unknowable; the caller retires it (`unrecoverable-start`).
   */
  private async recoverStart(marker: string, cause: unknown): Promise<void> {
    let running: readonly E2bProcessInfo[]
    try {
      running = await this.sandbox.commands.list({ requestTimeoutMs: this.timeouts.callTimeoutMs })
    } catch (error) {
      this.log(`start recovery list failed after ${messageOf(cause)}: ${messageOf(error)}`)
      throw new SandboxPlatformError(
        { kind: 'unavailable', retryable: true, detail: `unrecoverable-start: ${messageOf(cause)}` },
        `unrecoverable-start: ${messageOf(cause)}`,
      )
    }
    const matches = running.filter(entry => `${entry.cmd} ${entry.args.join(' ')}`.includes(marker))
    for (const entry of matches) {
      await this.sandbox.commands.kill(entry.pid, { requestTimeoutMs: this.timeouts.callTimeoutMs })
        .then(() => this.log(`start recovery killed orphaned pid ${entry.pid}`))
        .catch((error: unknown) => this.log(`start recovery kill failed for pid ${entry.pid}: ${messageOf(error)}`))
    }
    if (matches.length === 0) this.log(`start recovery found no process for ${marker}`)
  }

  readonly process = {
    start: async (spec: ProcessSpec, handlers?: ProcessHandlers): Promise<{ pid: number }> => {
      spec.signal?.throwIfAborted()
      const marker = `dsh-call-${randomUUID()}`
      // The marker is part of the command line so the process list can find a
      // command whose start response never arrived.
      const command = `${CALL_MARKER_ENV}=${quote(marker)} ${spec.argv.map(quote).join(' ')}`
      // Created before the call so output callbacks always have a destination,
      // even if the first chunk arrives before `run` resolves.
      let settle!: () => void
      const settled = new Promise<void>(resolve => { settle = resolve })
      const stream: ProcessStream = {
        argv: [...spec.argv],
        chunks: [],
        waiters: new Set(),
        done: false,
        settled,
        ...(handlers === undefined ? {} : { handlers }),
      }
      const emit = (channel: 'stdout' | 'stderr', text: string): void => {
        const bytes = new TextEncoder().encode(text)
        if (bytes.byteLength === 0) return
        stream.chunks.push(bytes)
        stream.handlers?.[channel]?.(bytes)
        wake(stream)
      }
      try {
        const handle = await this.sandbox.commands.run(command, {
          background: true,
          cwd: spec.cwd,
          // Command lifetime. Never a request timeout.
          timeoutMs: this.timeouts.commandTimeoutMs,
          // Start handshake only; the command may outlive this budget.
          requestTimeoutMs: this.timeouts.requestTimeoutMs,
          ...(spec.signal === undefined ? {} : { signal: spec.signal }),
          ...(spec.env === undefined || Object.keys(spec.env).length === 0
            ? {}
            : { envs: { ...spec.env } }),
          ...(spec.stdin === 'pipe' ? { stdin: true } : {}),
          onStdout: (chunk: string) => emit('stdout', chunk),
          onStderr: (chunk: string) => emit('stderr', chunk),
        })
        stream.handle = handle
        this.processes.set(handle.pid, stream)
        void handle.wait().then(
          () => undefined,
          () => undefined,
        ).finally(() => {
          stream.exitCode = handle.exitCode ?? 1
          this.settle(stream, settle)
        })
        // The SDK normally settles `wait()` with the command's exit event.
        // Aliyun occasionally drops that terminal event after the process has
        // already exited; without this fallback a tool call waits forever.
        void this.watchExit(handle.pid, handle.exitCode, stream, settle)
        return { pid: handle.pid }
      } catch (error) {
        await this.recoverStart(marker, error)
        throw mapError(error)
      }
    },

    connect: (pid: number, from?: number): AsyncIterable<Uint8Array> =>
      connectFrom(this.sandbox, this.processes, pid, from),

    status: async (pid: number): Promise<ProcessInfo | undefined> => {
      const tracked = this.processes.get(pid)
      if (tracked !== undefined) {
        return tracked.done
          ? { pid, argv: tracked.argv, state: 'exited', exitCode: tracked.exitCode ?? 0 }
          : { pid, argv: tracked.argv, state: 'running' }
      }
      try {
        const running = await this.sandbox.commands.list({ requestTimeoutMs: this.timeouts.callTimeoutMs })
        const hit = running.find(entry => entry.pid === pid)
        return hit === undefined ? undefined : toProcessInfo(hit)
      } catch (error) {
        throw mapError(error)
      }
    },

    kill: async (pid: number, signal?: string): Promise<void> => {
      // The SDK sends SIGKILL; an arbitrary signal has no equivalent.
      void signal
      const tracked = this.processes.get(pid)
      try {
        await (tracked?.handle === undefined
          ? this.sandbox.commands.kill(pid, { requestTimeoutMs: this.timeouts.callTimeoutMs })
          : tracked.handle.kill())
      } catch (error) {
        // Never swallow a failed kill: it is the difference between a process
        // that stops and one that keeps running unattended.
        this.log(`kill failed for pid ${pid}: ${messageOf(error)}`)
        throw mapError(error)
      }
    },

    list: async (): Promise<ProcessInfo[]> => {
      try {
        const running = await this.sandbox.commands.list({ requestTimeoutMs: this.timeouts.callTimeoutMs })
        return running.map(toProcessInfo)
      } catch (error) {
        throw mapError(error)
      }
    },

    wait: async (pid: number, signal?: AbortSignal): Promise<ProcessInfo | undefined> => {
      const tracked = this.processes.get(pid)
      if (tracked !== undefined) {
        await raceAbort(tracked.settled, signal)
        return await this.process.status(pid)
      }
      // Started by another client or replica: poll until it leaves the running
      // set. The provider cannot report its exit code in that case.
      for (;;) {
        if (signal?.aborted === true) return undefined
        const info = await this.process.status(pid)
        // Re-read the signal: the abort may have landed while `status` ran.
        if (info === undefined || info.state === 'exited' || signal?.aborted) return info
        await delay(250, signal)
      }
    },

    write: async (pid: number, data: Uint8Array): Promise<void> => {
      try {
        // Large single writes (generated images, pasted payloads) outlive the
        // control-plane request timeout; send bounded chunks and give each one
        // a generous stdin timeout.
        const chunkBytes = 256 * 1024
        const requestTimeoutMs = Math.max(this.timeouts.requestTimeoutMs, 60_000)
        for (let offset = 0; offset < data.byteLength; offset += chunkBytes) {
          await this.sandbox.commands.sendStdin(
            pid,
            data.subarray(offset, offset + chunkBytes),
            { requestTimeoutMs },
          )
        }
      } catch (error) {
        throw mapError(error)
      }
    },

    closeStdin: async (pid: number): Promise<void> => {
      try {
        await this.sandbox.commands.closeStdin(pid)
      } catch (error) {
        throw mapError(error)
      }
    },
  }

  readonly files = {
    read: async (path: string): Promise<Uint8Array> => {
      try {
        return await this.sandbox.files.read(path, { format: 'bytes' })
      } catch (error) {
        throw mapError(error)
      }
    },

    write: async (path: string, data: Uint8Array): Promise<void> => {
      // Copy into a plain ArrayBuffer: the SDK's BlobPart type rejects views
      // backed by SharedArrayBuffer.
      const buffer = new ArrayBuffer(data.byteLength)
      new Uint8Array(buffer).set(data)
      try {
        await this.sandbox.files.write(path, buffer)
      } catch (error) {
        throw mapError(error)
      }
    },

    list: async (path: string): Promise<DirEntry[]> => {
      try {
        return (await this.sandbox.files.list(path)).map(toDirEntry)
      } catch (error) {
        throw mapError(error)
      }
    },

    stat: async (path: string): Promise<FileStat | undefined> => {
      try {
        return toFileStat(path, await this.sandbox.files.getInfo(path))
      } catch (error) {
        if (isNotFound(error)) return undefined
        throw mapError(error)
      }
    },

    remove: async (path: string): Promise<void> => {
      try {
        await this.sandbox.files.remove(path)
      } catch (error) {
        throw mapError(error)
      }
    },

    rename: async (from: string, to: string): Promise<void> => {
      try {
        await this.sandbox.files.rename(from, to)
      } catch (error) {
        throw mapError(error)
      }
    },

    makeDir: async (path: string): Promise<void> => {
      try {
        await this.sandbox.files.makeDir(path)
      } catch (error) {
        throw mapError(error)
      }
    },
  }

}

/** One started process and the output retained for re-attachment. */
interface ProcessStream {
  readonly argv: readonly string[]
  /** Merged stdout+stderr, retained for {@link SandboxClient.process.connect}. */
  readonly chunks: Uint8Array[]
  readonly waiters: Set<() => void>
  /** Resolves once the process has exited and `exitCode` is final. */
  readonly settled: Promise<void>
  readonly handlers?: ProcessHandlers
  done: boolean
  exitCode?: number
  handle?: CommandHandle
  /** The control plane could not confirm the exit; the outcome is unknown. */
  settledUnknown?: boolean
}

/** Wait for a promise, or return undefined when the signal aborts first. */
async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (signal === undefined) return await promise
  if (signal.aborted) return undefined
  let listener!: () => void
  const aborted = new Promise<undefined>(resolve => {
    listener = () => resolve(undefined)
    signal.addEventListener('abort', listener, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', listener)
  }
}

/** Sleep, waking early when the signal aborts. */
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/** Wake every reader waiting on this process's output. */
function wake(stream: ProcessStream): void {
  const waiters = [...stream.waiters]
  stream.waiters.clear()
  for (const resolve of waiters) resolve()
}

/**
 * Re-attach to a process, replaying retained output from `from` and following it
 * live until the process exits.
 * @param sandbox - the live sandbox.
 * @param processes - processes this client started, with their output.
 * @param pid - process to attach to.
 * @param from - byte offset to resume from.
 * @returns the byte stream.
 */
async function* connectFrom(
  sandbox: Sandbox,
  processes: Map<number, ProcessStream>,
  pid: number,
  from?: number,
): AsyncIterable<Uint8Array> {
  const tracked = processes.get(pid)
  if (tracked !== undefined) {
    yield* replayTracked(tracked, from ?? 0)
    return
  }
  yield* attachRemote(sandbox, pid, from ?? 0)
}

/** Replay a locally started process's retained output, then follow it. */
async function* replayTracked(stream: ProcessStream, from: number): AsyncIterable<Uint8Array> {
  let offset = 0
  let index = 0
  for (;;) {
    for (; index < stream.chunks.length; index += 1) {
      const chunk = stream.chunks[index] as Uint8Array
      const next = offset + chunk.byteLength
      if (next > from) yield offset >= from ? chunk : chunk.subarray(from - offset)
      offset = next
    }
    if (stream.done) return
    await new Promise<void>(resolve => stream.waiters.add(resolve))
  }
}

/** Attach to a process started by another client or replica. */
async function* attachRemote(sandbox: Sandbox, pid: number, from: number): AsyncIterable<Uint8Array> {
  const queue: Uint8Array[] = []
  let wakeReader: (() => void) | undefined
  let done = false
  let failure: unknown

  const notify = (): void => {
    const resolve = wakeReader
    wakeReader = undefined
    resolve?.()
  }

  let handle: CommandHandle
  try {
    handle = await sandbox.commands.connect(pid, {
      onStdout: (text: string) => {
        const bytes = new TextEncoder().encode(text)
        if (bytes.byteLength > 0) queue.push(bytes)
        notify()
      },
      onStderr: (text: string) => {
        const bytes = new TextEncoder().encode(text)
        if (bytes.byteLength > 0) queue.push(bytes)
        notify()
      },
    })
  } catch (error) {
    throw mapError(error)
  }

  void handle.wait().then(
    () => undefined,
    (error: unknown) => { failure = error },
  ).finally(() => {
    done = true
    notify()
  })

  let offset = 0
  for (;;) {
    while (queue.length > 0) {
      const chunk = queue.shift() as Uint8Array
      const next = offset + chunk.byteLength
      if (next > from) yield offset >= from ? chunk : chunk.subarray(from - offset)
      offset = next
    }
    if (done) {
      if (failure !== undefined) throw mapError(failure)
      return
    }
    await new Promise<void>(resolve => { wakeReader = resolve })
  }
}

/** Map one SDK sandbox record onto the contract. */
function toSandboxInfo(info: E2bSandboxInfo): SandboxInfo {
  return {
    externalId: info.sandboxId,
    // The contract treats `endpoint` as informational; the provider always
    // reconnects through the SDK.
    endpoint: info.sandboxDomain ?? '',
    state: info.state,
    createdAt: info.startedAt.getTime(),
  }
}

/** Map one SDK process record onto the contract. */
function toProcessInfo(info: E2bProcessInfo): ProcessInfo {
  return { pid: info.pid, argv: [info.cmd, ...info.args], state: 'running' }
}

/** Map one SDK directory entry onto the contract. */
function toDirEntry(entry: EntryInfo): DirEntry {
  return {
    name: entry.name,
    path: entry.path,
    type: kindOf(entry),
    size: entry.size,
  }
}

/** Map one SDK file record onto the contract. */
function toFileStat(path: string, entry: EntryInfo): FileStat {
  return {
    path,
    type: kindOf(entry),
    size: entry.size,
    mtimeMs: entry.modifiedTime?.getTime() ?? 0,
  }
}

/** Serialize one mount into Aliyun's `mountPoints` shape. */
function ossMount(mount: SandboxMount): Record<string, unknown> {
  return {
    bucketName: mount.bucketName,
    bucketPath: mount.bucketPath,
    endpoint: mount.endpoint,
    mountDir: mount.mountDir,
    readOnly: mount.readOnly ?? false,
  }
}

/** One entry kind, preferring symlink evidence over the coarse file/dir tag. */
function kindOf(entry: EntryInfo): DirEntry['type'] {
  if (entry.symlinkTarget !== undefined) return 'symlink'
  if (entry.type === 'dir') return 'directory'
  if (entry.type === 'file') return 'file'
  return 'other'
}

/** Whether the SDK reported a missing sandbox or path. */
function isNotFound(error: unknown): boolean {
  return error instanceof SandboxNotFoundError
    || error instanceof FileNotFoundError
    || error instanceof NotFoundError
}

/** Map an SDK failure onto the four platform-independent kinds. */
function mapError(error: unknown): SandboxPlatformError {
  if (error instanceof SandboxPlatformError) return error
  if (isNotFound(error)) {
    return new SandboxPlatformError({ kind: 'not-found' }, messageOf(error))
  }
  if (error instanceof AuthenticationError) {
    return new SandboxPlatformError({ kind: 'unauthorized' }, messageOf(error))
  }
  if (error instanceof RateLimitError || error instanceof TimeoutError) {
    return new SandboxPlatformError(
      { kind: 'unavailable', retryable: true, detail: messageOf(error) },
      messageOf(error),
    )
  }
  if (error instanceof InvalidArgumentError || error instanceof TemplateError) {
    return new SandboxPlatformError(
      { kind: 'unavailable', retryable: false, detail: messageOf(error) },
      messageOf(error),
    )
  }
  const message = messageOf(error)
  if (/not found|404|no such/i.test(message)) {
    return new SandboxPlatformError({ kind: 'not-found' }, message)
  }
  if (/unauthor|forbidden|401|403/i.test(message)) {
    return new SandboxPlatformError({ kind: 'unauthorized' }, message)
  }
  if (/expire|deadline/i.test(message)) {
    return new SandboxPlatformError({ kind: 'expired', detail: message }, message)
  }
  return new SandboxPlatformError({ kind: 'unavailable', retryable: true, detail: message }, message)
}

/** Readable message from any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Quote one argv element for the shell string the SDK call requires. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
