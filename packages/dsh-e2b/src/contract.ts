/**
 * Platform contract: the only surface the rest of this package depends on.
 *
 * E2B is one implementation. A cloud-vendor team shipping their own API only
 * has to implement these two interfaces; nothing above them imports a platform SDK.
 *
 * @module @brain/dsh-e2b/contract
 */

/** What a platform can and cannot do. Callers degrade explicitly on false. */
export interface PlatformCapabilities {
  /** Sandboxes can be paused and resumed with their processes intact. */
  pause: boolean
  /** A sandbox can be snapshotted and cloned. */
  snapshot: boolean
}

/** What one sandbox can do. Drives which tools stay enabled. */
export interface SandboxCapabilities {
  /** A pseudo-terminal can be allocated. */
  pty: boolean
  /** Output of an already-running process can be re-attached after a reconnect. */
  reattach: boolean
  /** An arbitrary signal can be delivered to a process. */
  signal: boolean
  /** File operations report a version token usable by the editor. */
  fileVersion: boolean
}

/** One OSS prefix mounted directly into the sandbox. */
export interface SandboxMount {
  /** OSS bucket that already exists; no volume is provisioned. */
  readonly bucketName: string
  /** Prefix inside the bucket, unique per owner (for example `desks/<id>`). */
  readonly bucketPath: string
  /** Internal OSS endpoint, e.g. `https://oss-cn-beijing-internal.aliyuncs.com`. */
  readonly endpoint: string
  /** Absolute mount path inside the sandbox. */
  readonly mountDir: string
  /** Mount read-only. Defaults to false. */
  readonly readOnly?: boolean
}

/** Coordinates for creating one sandbox. */
export interface SandboxSpec {
  /** Stable key used by the deployment to correlate a sandbox with its owner. */
  readonly key: string
  /** Template or image name. */
  readonly template: string
  /** Milliseconds after which the platform reclaims an idle sandbox. */
  readonly timeoutMs: number
  /** Environment variables passed at creation. Never carry long-lived secrets. */
  readonly env?: Readonly<Record<string, string>>
  /** Free-form labels for platform-side reporting and orphan reconciliation. */
  readonly labels?: Readonly<Record<string, string>>
  /**
   * Volumes to mount, `{ mountPath: volumeName }`.
   *
   * Resolved by the caller per sandbox, so one workspace never sees another
   * workspace's files even when both volumes live in the same account.
   */
  readonly volumes?: Readonly<Record<string, string>>
  /**
   * OSS prefixes mounted directly into the sandbox.
   *
   * When set, the adapter sends these as Aliyun's `fc.sandbox.storage.oss`
   * metadata and does not use pre-created volumes. The caller resolves each
   * prefix per sandbox, so one workspace never sees another workspace's files.
   */
  readonly mounts?: readonly SandboxMount[]
  /** Workspace root inside the sandbox; defaults to the adapter's own value. */
  readonly workspaceRoot?: string
}

/** A created sandbox. */
export interface SandboxHandle {
  /** Platform-side identifier; never used as our primary key. */
  readonly externalId: string
  /** Where the sandbox client connects. */
  readonly endpoint: string
  /** Absolute workspace root inside the sandbox. */
  readonly workspaceRoot: string
}

/** Snapshot of a sandbox as the platform sees it. */
export interface SandboxInfo {
  readonly externalId: string
  readonly endpoint: string
  readonly state: 'running' | 'paused' | 'stopped'
  readonly createdAt: number
}

/** Filter for listing. */
export interface SandboxFilter {
  readonly labels?: Readonly<Record<string, string>>
}

/** One process the sandbox knows about. */
export interface ProcessInfo {
  readonly pid: number
  readonly argv: readonly string[]
  readonly state: 'running' | 'exited'
  readonly exitCode?: number
}

/** Per-stream callbacks delivered while a process runs. */
export interface ProcessHandlers {
  /** stdout bytes, in delivery order. */
  readonly stdout?: (chunk: Uint8Array) => void
  /** stderr bytes, in delivery order. */
  readonly stderr?: (chunk: Uint8Array) => void
}

/** Request to start a process. */
export interface ProcessSpec {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: 'pipe' | 'ignore'
  /** Allocate a pseudo-terminal instead of pipes. */
  readonly pty?: boolean
  readonly cols?: number
  readonly rows?: number
  /**
   * Cancels the start handshake and, once running, requests termination.
   *
   * Aborting must never leave the caller waiting: the provider settles the
   * start call (or reports the abort) and kills a process whose pid arrives
   * after the abort.
   */
  readonly signal?: AbortSignal
}

/** One directory entry. */
export interface DirEntry {
  readonly name: string
  readonly path: string
  readonly type: 'file' | 'directory' | 'symlink' | 'other'
  readonly size?: number
}

/** File metadata. */
export interface FileStat {
  readonly path: string
  readonly type: 'file' | 'directory' | 'symlink' | 'other'
  readonly size: number
  readonly mtimeMs: number
  /** Platform-provided version token when the platform has one. */
  readonly version?: string
}

/**
 * The four failures every adapter must map into.
 *
 * Callers branch on these kinds only, so a new platform never changes the error
 * handling above it. `not-found` and `unauthorized` must stay indistinguishable
 * to the caller when they concern another tenant's resource.
 */
export type SandboxError =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unavailable'; readonly retryable: boolean; readonly detail?: string }
  | { readonly kind: 'expired'; readonly detail?: string }
  | { readonly kind: 'unauthorized' }

/** Structured failure carrying the platform-independent kind. */
export class SandboxPlatformError extends Error {
  readonly failure: SandboxError

  constructor(failure: SandboxError, message?: string) {
    super(message ?? failure.kind)
    this.name = 'SandboxPlatformError'
    this.failure = failure
  }
}

/** Machine lifecycle for one tenant. */
export interface SandboxPlatform {
  readonly capabilities: PlatformCapabilities

  /**
   * Create a sandbox.
   * @param spec - creation coordinates.
   * @param signal - cancels creation; a cancelled creation leaves nothing behind.
   * @returns the created sandbox.
   */
  create(spec: SandboxSpec, signal?: AbortSignal): Promise<SandboxHandle>

  /**
   * Describe one sandbox.
   * @param externalId - platform-side identifier.
   * @returns the snapshot, or undefined when it no longer exists.
   */
  get(externalId: string): Promise<SandboxInfo | undefined>

  /**
   * List sandboxes this account owns.
   * @param filter - optional label filter.
   * @returns every matching sandbox.
   */
  list(filter?: SandboxFilter): Promise<SandboxInfo[]>

  /**
   * Destroy a sandbox and everything running inside it.
   * @param externalId - platform-side identifier. Absent sandboxes are not an error.
   */
  destroy(externalId: string): Promise<void>

  /** Pause; absent when {@link capabilities}.pause is false. */
  pause?(externalId: string): Promise<void>

  /** Resume; absent when {@link capabilities}.pause is false. */
  resume?(externalId: string): Promise<void>
}

/** Capabilities of one live sandbox session. */
export interface SandboxClient {
  readonly capabilities: SandboxCapabilities

  readonly process: {
    /**
     * Start one process. Handlers receive stdout and stderr separately while
     * the process runs; {@link connect} remains the merged re-attachment path.
     */
    start(spec: ProcessSpec, handlers?: ProcessHandlers): Promise<{ pid: number }>
    /** Re-attach to a running process's output, optionally from a byte offset. */
    connect(pid: number, from?: number): AsyncIterable<Uint8Array>
    status(pid: number): Promise<ProcessInfo | undefined>
    kill(pid: number, signal?: string): Promise<void>
    list(): Promise<ProcessInfo[]>
    /** Wait until the process exits and report its final state. */
    wait?(pid: number, signal?: AbortSignal): Promise<ProcessInfo | undefined>
    /** Write bytes to the process's stdin, when it was started with `stdin: 'pipe'`. */
    write?(pid: number, data: Uint8Array): Promise<void>
    /** Close stdin, signaling EOF. */
    closeStdin?(pid: number): Promise<void>
  }

  readonly files: {
    read(path: string): Promise<Uint8Array>
    write(path: string, data: Uint8Array): Promise<void>
    list(path: string): Promise<DirEntry[]>
    stat(path: string): Promise<FileStat | undefined>
    remove(path: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    makeDir(path: string): Promise<void>
  }
}
