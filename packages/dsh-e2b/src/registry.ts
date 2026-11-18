/**
 * Sandbox registry: the one service that decides which microVM a call belongs to.
 *
 * It owns the binding table, creation, reuse, idle reclamation and orphan
 * reconciliation. Everything above it (the three providers) only asks for a
 * binding; nothing above it knows about users, projects or sessions.
 *
 * @module @brain/dsh-e2b/registry
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { dropEmpty, id, volumeNameFor, type SandboxKey } from './keys.ts'
import { E2bPlatform, type E2bConfig } from './e2b-adapter.ts'
import { PgBindingStore } from './store-pg.ts'
import { MockPlatform, type MockConfig } from './mock-adapter.ts'
import { DockerPlatform, type DockerConfig } from './docker-adapter.ts'
import { sandboxSessionId } from './session-scope.ts'
import {
  SandboxPlatformError,
  type SandboxClient,
  type SandboxError,
  type SandboxMount,
  type SandboxPlatform,
} from './contract.ts'

/** E2B runtime configuration supplied by the platform. */
export interface SandboxRuntimeConfig {
  readonly apiKey: string
  readonly apiUrl: string
  readonly domain: string
  readonly template: string
  readonly roleArn: string
  readonly ossBucket: string
  readonly ossEndpoint: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Sandbox routing and lifecycle. Registered by this package. */
    sandboxes: SandboxRegistry
    /** Platform-owned E2B credentials and template. */
    sandboxConfig?: { get(): SandboxRuntimeConfig | undefined }
  }
}

/** Which level owns one sandbox. Switchable by configuration. */
export type SandboxScope = 'user' | 'workspace' | 'session'

export type { SandboxKey } from './keys.ts'
export { id, volumeNameFor } from './keys.ts'

/** How far a subagent/fork lineage may be followed before giving up. */
const MAX_LINEAGE_DEPTH = 16

/** Who a session belongs to. */
export interface SessionOwner {
  readonly userId: string
  readonly workspaceId: string
  /**
   * Volume this workspace owns, when the platform records one.
   *
   * `workspaces.volume_name` in the platform schema. Omitted rows fall back to
   * {@link Config.volumeNameTemplate}.
   */
  readonly volumeName?: string
  /** Per-user skills volume, kept for older deployments. */
  readonly skillsVolume?: string
}

/**
 * One OSS prefix mounted directly into every sandbox.
 *
 * No E2B volume is created. `bucketPath` and `mountDir` support
 * `{workspaceId}`, `{userId}` and `{sessionId}`; the workspace mount must
 * interpolate `{workspaceId}` in `bucketPath` so two workspaces never share a
 * prefix.
 */
export interface OssMountConfig {
  /** Existing OSS bucket. */
  readonly bucketName: string
  /** Internal OSS endpoint. */
  readonly endpoint: string
  /** Prefix inside the bucket, rendered per sandbox. */
  readonly bucketPath: string
  /**
   * Absolute mount path inside the sandbox.
   *
   * Takes the same placeholders as `bucketPath`, so the workspace mount can be
   * namespaced per workspace (for example `/desk/{workspaceId}`).
   */
  readonly mountDir: string
  /** Mount read-only. Defaults to false. */
  readonly readOnly?: boolean
}

/** Extra volume mounted next to the workspace volume. */
export interface ExtraVolumeConfig {
  /** Guest mount path, e.g. `/skillbox/own`. */
  readonly mountPath: string
  /** Owner field that carries the volume name. */
  readonly volumeNameFromOwner: 'skillsVolume'
  /** Fallback template; currently unused because a missing owner value skips the mount. */
  readonly volumeNameTemplate?: string
}

/** Deployment-supplied lookup from a session to its user and project. */
export interface SessionDirectory {
  /**
   * Resolve one session's owner.
   * @param sessionId - the session.
   * @returns the owner, or undefined when the session is unknown.
   */
  owner(sessionId: string): Promise<SessionOwner | undefined>
}

/** OSS root shared by every public skill group. */

/** Verified per-sandbox cap (Aliyun `FunctionMountPointsLimit`). */
const MAX_OSS_MOUNTS = 5

/** One row of the binding table. */
export interface SandboxBinding {
  readonly key: SandboxKey
  /** Scope in force when this row was created; used for reconciliation. */
  readonly scope: SandboxScope
  /** Our identifier, stable across platforms. Safe to expose. */
  readonly sandboxId: string
  /** Platform-side identifier. Never exposed to a model. */
  readonly externalId: string
  readonly endpoint: string
  readonly workspaceRoot: string
  readonly generation: number
  readonly state: 'creating' | 'ready' | 'dead'
  readonly expiresAt: number
  readonly lastUsedAt: number
}

/** Durable storage for bindings. The shipped implementation is in-memory. */
export interface BindingStore {
  get(key: SandboxKey): Promise<SandboxBinding | undefined>
  put(binding: SandboxBinding): Promise<void>
  delete(key: SandboxKey): Promise<void>
  list(): Promise<SandboxBinding[]>
  /** Every binding created under a scope other than the one now configured. */
  stale(scope: SandboxScope): Promise<SandboxBinding[]>
  /**
   * Claim the right to create one missing sandbox. Shared stores implement this
   * so two replicas cannot create two microVMs for the same key.
   */
  claim?(key: SandboxKey, claimId: string, leaseMs: number): Promise<ClaimResult>
  /** Drop a claim this replica still owns after a failed creation. */
  release?(key: SandboxKey, claimId: string): Promise<void>
}

/** Outcome of one creation claim. */
export type ClaimResult =
  | { readonly status: 'claimed'; readonly generation: number }
  | { readonly status: 'busy' }
  | { readonly status: 'ready'; readonly binding: SandboxBinding }

/** How long a claim blocks other replicas while one creates the sandbox. */
const CLAIM_LEASE_MS = 120_000
/** How long an ensure waits for another replica's claim before failing. */
const CLAIM_WAIT_MS = 90_000

/** In-memory store. Replace with a database implementation for multi-replica deployments. */
export class MemoryBindingStore implements BindingStore {
  private readonly rows = new Map<string, SandboxBinding>()

  async get(key: SandboxKey): Promise<SandboxBinding | undefined> {
    return this.rows.get(id(key))
  }

  async put(binding: SandboxBinding): Promise<void> {
    this.rows.set(id(binding.key), binding)
  }

  async delete(key: SandboxKey): Promise<void> {
    this.rows.delete(id(key))
  }

  async list(): Promise<SandboxBinding[]> {
    return [...this.rows.values()]
  }

  async stale(scope: SandboxScope): Promise<SandboxBinding[]> {
    return [...this.rows.values()].filter(row => row.scope !== scope)
  }

  /** One process owns every key, so a claim never contends. */
  async claim(key: SandboxKey): Promise<ClaimResult> {
    const previous = this.rows.get(id(key))
    return { status: 'claimed', generation: (previous?.generation ?? 0) + 1 }
  }

  async release(): Promise<void> {
    // Nothing durable was written before creation.
  }
}

/** Registry configuration. */
export interface Config {
  /** Which level owns a sandbox. */
  readonly scope: SandboxScope
  /**
   * Platform adapter. `mock` runs sandboxes as local directories on the host;
   * `docker` runs one container per workspace for an isolated local test.
   */
  readonly adapter: 'e2b' | 'mock' | 'docker' | 'box'
  /** E2B credentials and template. Required when `adapter` is `e2b`. */
  readonly e2b?: E2bConfig
  /** Mock adapter settings, used when `adapter` is `mock`. */
  readonly mock?: MockConfig
  /** Docker adapter settings, used when `adapter` is `docker`. */
  readonly docker?: DockerConfig
  /**
   * Injected platform implementation.
   *
   * A separate adapter package (for example `@brain/dsh-box`) constructs this
   * registry with its own `SandboxPlatform` instead of changing the E2B code.
   * When present, `adapter` only labels the deployment.
   */
  readonly platform?: SandboxPlatform
  /**
   * Session to owner resolution.
   *
   * Omit to use the `sessionDirectory` service. Prefer omitting it: a config
   * value is captured when this row mounts, and the directory plugin may mount
   * later in the same patch.
   */
  readonly directory?: SessionDirectory
  /** Binding storage. Defaults to in-memory, which is single-process only. */
  readonly store?: BindingStore
  /**
   * Storage backend when `store` is omitted.
   *
   * `postgres` needs the `db` service; missing it fails the plugin load rather
   * than silently falling back to memory, because a silent fallback would give
   * every replica its own sandboxes.
   */
  readonly storeKind?: 'memory' | 'postgres'
  /** Sandboxes the platform reclaims after this long without a request. */
  readonly sandboxTimeoutMs?: number
  /** Our own idle threshold; usually shorter than the platform timeout. */
  readonly idleMs?: number
  /** Sweep interval for idle reclamation and orphan reconciliation. */
  readonly sweepIntervalMs?: number
  /** Whether to destroy sandboxes found on the platform but not in the store. */
  readonly reclaimOrphans?: boolean
  /**
   * Extra labels stamped on every sandbox and used to scope orphan listing.
   *
   * Set a deployment-unique value when several brains share one E2B account;
   * otherwise each replica's sweep could destroy the others' sandboxes.
   */
  readonly labels?: Readonly<Record<string, string>>
  /**
   * Mount path for the per-sandbox volume, and the workspace root reported to
   * tools. Defaults to `/desk`. Supports `{workspaceId}`, `{userId}` and
   * `{sessionId}`, rendered per sandbox; when `ossMounts` is set, the workspace
   * entry's `mountDir` must use the same template.
   *
   * A workspace owns its own sandbox and volume, so the mount point does not
   * need to be per-workspace: every sandbox can use the same path. The platform
   * passes this value as the session cwd.
   */
  readonly volumeMountPath?: string
  /**
   * Volume name template, rendered per sandbox.
   *
   * Must contain `{workspaceId}`; no other placeholders are substituted. When
   * sanitization or truncation would make two ids collapse to one name, a short
   * hash of the workspace id is appended so names stay unique.
   *
   * Omitted means `desk-{workspaceId}`. An empty value is rejected: every
   * sandbox must mount a workspace volume.
   */
  readonly volumeNameTemplate?: string
  /**
   * Legacy fallback volume name for sandboxes whose workspace row carries no
   * `workspaces.volume_name`.
   *
   * A workspace row's own volume always wins; this value only covers old
   * schemas that never recorded one. Prefer {@link volumeNameTemplate}, and do
   * not set it in a multi-tenant deployment: every sandbox without its own row
   * would mount the same volume.
   */
  readonly volumeName?: string
  /**
   * Additional volumes resolved from the session owner and mounted beside the
   * workspace volume. Volumes with no owner value are skipped.
   */
  readonly extraVolumes?: readonly ExtraVolumeConfig[]
  /**
   * Guest directory for this member's own skills.
   * Object prefix is `members/{userId}/skills`. Example: `/skillbox/own`.
   */
  readonly privateSkillDir?: string
  /**
   * Guest directory for skills shared by the whole deployment.
   * Object prefix is `common/skills`. Example: `/skillbox/common`.
   */
  readonly publicSkillDir?: string
  /**
   * OSS prefixes mounted directly with Aliyun's `fc.sandbox.storage.oss`
   * metadata. When set, no E2B volume is created or mounted.
   */
  readonly ossMounts?: readonly OssMountConfig[]
}

/**
 * The sandbox registry.
 *
 * Lifecycle contract:
 * - `ensure` is idempotent per key; concurrent callers share one creation.
 * - A binding is written only after the sandbox is initialized.
 * - The platform is the source of truth for liveness; a binding is a cache.
 */
export default class SandboxRegistry extends Service {
  static readonly inject = ['agents']

  private readonly platform: SandboxPlatform
  private readonly store: BindingStore
  private readonly inflight = new Map<string, Promise<SandboxBinding>>()
  private readonly config: Required<
    Omit<Config, 'store' | 'directory' | 'e2b' | 'mock' | 'docker' | 'storeKind' | 'platform'>
  > & {
    readonly directory?: SessionDirectory
    readonly store: BindingStore
    readonly e2b?: E2bConfig
    readonly mock?: MockConfig
    readonly docker?: DockerConfig
  }

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxes')
    const volumeNameTemplate = config.volumeNameTemplate ?? 'desk-{workspaceId}'
    const fixedVolumeName = config.volumeName?.trim() ?? ''
    if (config.volumeName !== undefined && fixedVolumeName === '') {
      throw new Error('sandboxes: volumeName must not be empty when set')
    }
    if (fixedVolumeName !== '') {
      ctx.logger?.warn?.(
        `sandboxes: fixed volume "${fixedVolumeName}" is shared by every workspace; per-workspace file isolation is disabled`,
      )
    }
    if (volumeNameTemplate === '') {
      throw new Error('sandboxes: volumeNameTemplate must not be empty; per-workspace volume isolation is mandatory')
    }
    if (!volumeNameTemplate.includes('{workspaceId}')) {
      throw new Error(
        `sandboxes: volumeNameTemplate must contain {workspaceId}; got "${volumeNameTemplate}"`,
      )
    }
    if (config.scope === 'user') {
      throw new Error(
        'sandboxes: scope "user" has no workspace and cannot mount per-workspace volumes; use "workspace" or "session"',
      )
    }
    const mountPath = config.volumeMountPath ?? '/desk'
    if (!mountPath.startsWith('/') || mountPath === '/') {
      throw new Error(`sandboxes: volumeMountPath must be an absolute path other than "/"; got "${mountPath}"`)
    }
    const ossMounts = config.ossMounts ?? []
    for (const mount of ossMounts) {
      if (mount.bucketPath.trim() === '') {
        throw new Error('sandboxes: each ossMounts entry needs a bucketPath')
      }
      if (!mount.mountDir.startsWith('/')) {
        throw new Error(`sandboxes: oss mountDir must be absolute; got "${mount.mountDir}"`)
      }
    }
    if (ossMounts.length > 0) {
      const workspaceMount = ossMounts.find(mount => mount.mountDir === mountPath)
      if (workspaceMount === undefined || !workspaceMount.bucketPath.includes('{workspaceId}')) {
        throw new Error(
          `sandboxes: the workspace oss mount (mountDir matching volumeMountPath "${mountPath}") must interpolate {workspaceId}; per-workspace isolation is mandatory`,
        )
      }
    }
    this.store = config.store ?? createStore(ctx, config.storeKind, config.scope)
    this.platform = config.platform ?? createPlatform(config, ctx)
    this.config = {
      scope: config.scope,
      adapter: config.adapter,
      ...(config.e2b === undefined ? {} : { e2b: config.e2b }),
      ...(config.mock === undefined ? {} : { mock: config.mock }),
      ...(config.docker === undefined ? {} : { docker: config.docker }),
      ...(config.directory === undefined ? {} : { directory: config.directory }),
      store: this.store,
      sandboxTimeoutMs: config.sandboxTimeoutMs ?? 900_000,
      idleMs: config.idleMs ?? 600_000,
      sweepIntervalMs: config.sweepIntervalMs ?? 60_000,
      reclaimOrphans: config.reclaimOrphans ?? false,
      labels: config.labels ?? {},
      volumeMountPath: mountPath,
      volumeNameTemplate,
      volumeName: fixedVolumeName,
      extraVolumes: config.extraVolumes ?? [],
      privateSkillDir: trimDir(config.privateSkillDir),
      publicSkillDir: trimDir(config.publicSkillDir),
      ossMounts,
    }

    // Automatic reclamation is disabled for now: idle, stale-scope and orphan
    // sweeping all run from this timer. Sandboxes then live until the platform
    // TTL expires. `sweep()` stays public for an operator-triggered pass.
    //
    // ctx.effect(() => {
    //   const timer = setInterval(() => {
    //     void this.sweep().catch(error => {
    //       ctx.logger?.warn?.(`sandboxes: sweep failed: ${describe(error)}`)
    //     })
    //   }, this.config.sweepIntervalMs)
    //   timer.unref?.()
    //   return () => clearInterval(timer)
    // }, 'sandboxes: sweeper')
  }

  /**
   * Resolve the sandbox key for a session under the configured scope.
   * @param sessionId - the session.
   * @returns the key, or undefined when the session has no owner.
   */
  async keyOf(sessionId: string | undefined): Promise<SandboxKey | undefined> {
    return (await this.resolve(sessionId))?.key
  }

  /**
   * Resolve the key together with the owner that carries its volume name.
   *
   * A subagent's session is born in the brain and has no platform row, so the
   * directory cannot answer for it. Follow `header.parentSession` to the
   * nearest ancestor the platform knows and use THAT ancestor's id for the
   * key: the child is treated as the same session and shares its sandbox,
   * under every scope.
   */
  private async resolve(
    sessionId: string | undefined,
  ): Promise<{ key: SandboxKey; owner: SessionOwner } | undefined> {
    if (sessionId === undefined || sessionId === '') return undefined
    const seen = new Set<string>()
    let id = sessionId
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
      if (seen.has(id)) return undefined
      seen.add(id)
      const owner = await this.directory().owner(id)
      if (owner !== undefined) return { key: this.keyFor(owner, id), owner }
      const parent = this.parentSessionOf(id)
      if (parent === undefined) return undefined
      id = parent
    }
    return undefined
  }

  /** The durable parent recorded on one live child session. */
  private parentSessionOf(sessionId: string): string | undefined {
    const agents = this.ctx.get('agents') as
      | { get(id: string): { session?: { header?: { parentSession?: unknown } } } | undefined }
      | undefined
    try {
      const parent = agents?.get(sessionId)?.session?.header?.parentSession
      return parent === undefined || parent === null || String(parent) === '' ? undefined : String(parent)
    } catch {
      return undefined
    }
  }

  /** Compose the composite key for one owner under the configured scope. */
  private keyFor(owner: SessionOwner, sessionId: string): SandboxKey {
    switch (this.config.scope) {
      case 'user':
        return { userId: owner.userId, workspaceId: '', sessionId: '' }
      case 'workspace':
        return { userId: owner.userId, workspaceId: owner.workspaceId, sessionId: '' }
      case 'session':
        return { userId: owner.userId, workspaceId: owner.workspaceId, sessionId }
    }
  }

  /**
   * Ensure the calling session has a usable sandbox.
   *
   * Reads the initiating Agent from DSH's asynchronous context, so callers never
   * pass an identity. Outside a turn (timers, background pumps) this returns
   * undefined and the caller must decide whether that is fatal.
   * @returns the binding, or undefined when there is no initiating session.
   */
  async ensureCurrent(): Promise<SandboxBinding | undefined> {
    const sessionId = this.currentSessionId()
    if (sessionId === undefined) return undefined
    return await this.ensure(sessionId)
  }

  /**
   * Ensure one session has a usable sandbox.
   * @param sessionId - the session.
   * @returns its binding.
   */
  async ensure(sessionId: string): Promise<SandboxBinding> {
    const resolved = await this.resolve(sessionId)
    if (resolved === undefined) {
      throw new SandboxPlatformError({ kind: 'unauthorized' }, `unknown session ${sessionId}`)
    }
    const { key, owner } = resolved
    const keyId = id(key)

    const pending = this.inflight.get(keyId)
    if (pending !== undefined) return await pending

    const opening = this.open(key, owner)
    this.inflight.set(keyId, opening)
    try {
      return await opening
    } finally {
      this.inflight.delete(keyId)
    }
  }

  /**
   * Find or create one binding, using the store's claim to serialize creation
   * across replicas. Without a claim every replica could create its own VM for
   * the same workspace, racing two writers onto one volume.
   */
  private async open(key: SandboxKey, owner: SessionOwner): Promise<SandboxBinding> {
    const deadline = Date.now() + CLAIM_WAIT_MS
    for (;;) {
      const cached = await this.store.get(key)
      if (cached !== undefined && cached.state === 'ready' && await this.alive(cached)) {
        const touched = { ...cached, lastUsedAt: Date.now() }
        await this.store.put(touched)
        return touched
      }

      if (this.store.claim === undefined) {
        return await this.create(key, owner, (cached?.generation ?? 0) + 1)
      }

      const claimId = `claim-${crypto.randomUUID()}`
      const claim = await this.store.claim(key, claimId, CLAIM_LEASE_MS)
      if (claim.status === 'ready') {
        if (await this.alive(claim.binding)) {
          const touched = { ...claim.binding, lastUsedAt: Date.now() }
          await this.store.put(touched)
          return touched
        }
        // Another replica published a binding whose sandbox is already gone.
        await this.store.put({ ...claim.binding, state: 'dead' })
        continue
      }
      if (claim.status === 'busy') {
        if (Date.now() >= deadline) {
          throw new SandboxPlatformError(
            { kind: 'unavailable', retryable: true },
            'another replica is still creating this sandbox; retry shortly',
          )
        }
        await new Promise(resolve => setTimeout(resolve, 500))
        continue
      }

      try {
        return await this.create(key, owner, claim.generation)
      } catch (error) {
        await this.store.release?.(key, claimId).catch(() => undefined)
        throw error
      }
    }
  }

  /**
   * Whether a stored binding still points at a usable sandbox.
   *
   * A paused sandbox is resumed when the adapter supports it; a stopped one is
   * stale. `getInfo` alone is not enough: Aliyun can leave a paused record in a
   * state that `connect` rejects, which used to surface as "Paused sandbox …
   * not found" mid-turn.
   */
  private async alive(binding: SandboxBinding): Promise<boolean> {
    const info = await this.platform.get(binding.externalId).catch(() => undefined)
    if (info === undefined) return false
    if (info.state === 'running') return true
    if (info.state === 'paused' && this.platform.resume !== undefined) {
      try {
        await this.platform.resume(binding.externalId)
        return true
      } catch {
        return false
      }
    }
    return false
  }

  /** Create (or recreate) one binding. */
  private async create(
    key: SandboxKey,
    owner: SessionOwner,
    generation: number,
  ): Promise<SandboxBinding> {
    const workspaceRoot = this.workspaceRootFor(key)
    const mounts = this.resolveOssMounts(key, owner, workspaceRoot)
    const volumes: Record<string, string> = {}
    if (mounts.length === 0) {
      volumes[workspaceRoot] = this.volumeName(key, owner)
      for (const extra of this.config.extraVolumes) {
        const ownerVolume = extra.volumeNameFromOwner === 'skillsVolume' ? owner.skillsVolume : undefined
        if (ownerVolume === undefined || ownerVolume.trim() === '') continue
        volumes[extra.mountPath] = ownerVolume
      }
    }
    const handle = await this.platform.create({
      key: id(key),
      template: this.config.e2b?.template ?? '',
      timeoutMs: this.config.sandboxTimeoutMs,
      // Non-DSH_* names: the shell tool rebuilds the DSH_* namespace and
      // discards inherited values, so credential helpers must not use it.
      env: dropEmpty({
        YACH_CLI_USER_ID: key.userId,
        YACH_CLI_WORKSPACE_ID: key.workspaceId,
        YACH_CLI_SESSION_ID: key.sessionId,
        YACH_CLI_WORKSPACE_ROOT: workspaceRoot,
      }),
      labels: dropEmpty({
        app: 'dsh',
        ...this.config.labels,
        user: key.userId,
        workspace: key.workspaceId,
        session: key.sessionId,
      }),
      // Direct OSS mounts replace volumes entirely. Without them, the
      // workspace volume is mandatory and owner-recorded extra volumes (skills)
      // are added beside it.
      ...(mounts.length > 0 ? { mounts } : { volumes }),
      workspaceRoot,
    })
    const binding: SandboxBinding = {
      key,
      scope: this.config.scope,
      sandboxId: `${handle.externalId}`,
      externalId: handle.externalId,
      endpoint: handle.endpoint,
      workspaceRoot: handle.workspaceRoot,
      generation,
      state: 'ready',
      expiresAt: Date.now() + this.config.sandboxTimeoutMs,
      lastUsedAt: Date.now(),
    }
    try {
      await this.store.put(binding)
    } catch (error) {
      // The sandbox exists but no durable binding points at it. Destroy it here
      // instead of leaving an orphan for a sweeper that may be disabled.
      await this.platform.destroy(handle.externalId).catch(() => undefined)
      throw error
    }
    return binding
  }

  /**
   * The volume this key mounts.
   *
   * An explicit `workspaces.volume_name` wins; otherwise the name is derived
   * from the workspace id. There is no fallback: a key without a workspace is
   * an error, because a sandbox that cannot be tied to exactly one workspace
   * would break file isolation.
   * @param key - the sandbox key.
   * @param owner - the session owner, which may carry an explicit volume.
   * @returns the volume name.
   */
  private volumeName(key: SandboxKey, owner: SessionOwner): string {
    if (key.workspaceId === '') {
      throw new Error(
        'sandboxes: sandbox key has no workspace id; per-workspace volume isolation requires scope "workspace" or "session"',
      )
    }
    // 平台记录的工作区卷优先：`volumeName` 是给还没有 volume_name 列的老部署的
    // 兼容兜底，一旦它压过逐工作区的名字，所有租户就会挂到同一块卷上。
    if (owner.volumeName !== undefined && owner.volumeName !== '') return owner.volumeName
    if (this.config.volumeName !== '') return this.config.volumeName
    return volumeNameFor(this.config.volumeNameTemplate, key.workspaceId)
  }

  /**
   * Substitute a key's ids into a path template.
   *
   * `{workspaceId}`, `{userId}` and `{sessionId}` are the only placeholders;
   * anything else is left untouched.
   * @param template - the configured path.
   * @param key - the sandbox key.
   * @returns the path for this sandbox.
   */
  private render(template: string, key: SandboxKey): string {
    return template
      .replaceAll('{workspaceId}', key.workspaceId)
      .replaceAll('{userId}', key.userId)
      .replaceAll('{sessionId}', key.sessionId)
  }

  /**
   * The workspace root this sandbox mounts and reports to tools.
   *
   * Each workspace owns its sandbox and volume, so the configured mount path is
   * rendered per sandbox and is also the cwd the platform hands the session.
   * @param key - the sandbox key.
   * @returns an absolute path inside the sandbox.
   */
  private workspaceRootFor(key: SandboxKey): string {
    return this.render(this.config.volumeMountPath, key).replace(/\/+$/u, '')
  }

  /**
   * Render the configured OSS prefixes for one sandbox.
   * @param key - the sandbox key.
   * @param owner - the session owner.
   * @param workspaceRoot - the rendered workspace root; the workspace entry mounts there.
   * @returns one direct mount per configured prefix; empty when OSS mounts are off.
   */
  private resolveOssMounts(key: SandboxKey, owner: SessionOwner, workspaceRoot: string): SandboxMount[] {
    if (this.config.ossMounts.length === 0) return []
    if (key.workspaceId === '') {
      throw new Error(
        'sandboxes: sandbox key has no workspace id; per-workspace OSS mount isolation requires a workspace',
      )
    }
    const runtime = this.ctx.get('sandboxConfig')?.get()
    const base: OssMountConfig[] = [...this.config.ossMounts]
    if (this.config.privateSkillDir !== '' && key.userId !== '') {
      base.push({
        bucketName: this.config.ossMounts[0]?.bucketName ?? '',
        endpoint: this.config.ossMounts[0]?.endpoint ?? '',
        bucketPath: `members/${key.userId}/skills`,
        mountDir: this.config.privateSkillDir,
        readOnly: true,
      })
    }
    if (this.config.publicSkillDir !== '') {
      base.push({
        bucketName: this.config.ossMounts[0]?.bucketName ?? '',
        endpoint: this.config.ossMounts[0]?.endpoint ?? '',
        bucketPath: 'common/skills',
        mountDir: this.config.publicSkillDir,
        readOnly: true,
      })
    }
    const rendered = base.map(mount => {
      const bucketName = mount.bucketName.trim() || runtime?.ossBucket?.trim() || ''
      const endpoint = mount.endpoint.trim() || runtime?.ossEndpoint?.trim() || ''
      // Local adapters map the same prefixes onto `storage.dir`; only a real
      // cloud platform needs bucket and endpoint here.
      const localAdapter = this.config.adapter === 'mock' || this.config.adapter === 'docker'
      if ((bucketName === '' || endpoint === '') && !localAdapter) {
        throw new Error(
          'sandboxes: OSS mount needs bucketName and endpoint; configure them in the platform sandbox config',
        )
      }
      return {
        bucketName: bucketName || 'local',
        bucketPath: this.render(mount.bucketPath, key),
        endpoint: endpoint || 'local',
        // The workspace entry mounts at the root the platform calls the cwd.
        mountDir: mount.mountDir === this.config.volumeMountPath
          ? workspaceRoot
          : this.render(mount.mountDir, key),
        ...(mount.readOnly === undefined ? {} : { readOnly: mount.readOnly }),
      }
    })
    if (rendered.length > MAX_OSS_MOUNTS) {
      // The platform rejects the create request with an opaque 400; fail here
      // with the count so a misconfigured workspace is obvious in the log.
      throw new SandboxPlatformError(
        { kind: 'unavailable', retryable: false, detail: `mount-limit: ${rendered.length}/${MAX_OSS_MOUNTS}` },
        `sandboxes: ${rendered.length} OSS mounts exceed the per-sandbox limit of ${MAX_OSS_MOUNTS}`,
      )
    }
    return rendered
  }

  /**
   * Open a client for a binding.
   * @param binding - the binding to connect to.
   * @returns the sandbox client.
   */
  async client(binding: SandboxBinding): Promise<SandboxClient> {
    const platform = this.platform as SandboxPlatform & {
      client?(externalId: string): Promise<SandboxClient>
    }
    if (typeof platform.client !== 'function') {
      throw new Error('sandboxes: adapter does not expose a sandbox client')
    }
    return await platform.client(binding.externalId)
  }

  /** Read one binding without creating anything. */
  async get(sessionId: string): Promise<SandboxBinding | undefined> {
    const key = await this.keyOf(sessionId)
    return key === undefined ? undefined : await this.store.get(key)
  }

  /** Every binding, for operators and reconciliation. */
  async list(): Promise<SandboxBinding[]> {
    return await this.store.list()
  }

  /**
   * Destroy the sandbox serving a session.
   * @param sessionId - the session whose sandbox should go away.
   */
  async destroy(sessionId: string): Promise<void> {
    const key = await this.keyOf(sessionId)
    if (key === undefined) return
    const binding = await this.store.get(key)
    if (binding === undefined) return
    await this.platform.destroy(binding.externalId).catch(() => undefined)
    await this.store.delete(key)
  }

  /**
   * Retire one live binding whose sandbox state is unknowable.
   *
   * Used when a command start timed out and the process list could not be
   * read: the command may still be running and cannot be identified, so the
   * only safe move is to destroy the whole sandbox and let the next tool call
   * rebuild it. Workspace files live on OSS, so this loses processes, not data.
   * @param binding - the binding whose sandbox must go away.
   */
  async retire(binding: SandboxBinding): Promise<void> {
    const detail = `retiring sandbox ${binding.externalId} for ${binding.key.workspaceId || binding.key.sessionId || binding.key.userId}`
    this.ctx.logger?.warn?.(`sandboxes: ${detail}`)
    await this.platform.destroy(binding.externalId).catch(error => {
      this.ctx.logger?.warn?.(`sandboxes: retire failed for ${binding.externalId}: ${describe(error)}`)
    })
    await this.store.put({ ...binding, state: 'dead' })
  }

  /**
   * Reclaim idle bindings and, optionally, sandboxes the store does not know.
   *
   * Idle reclamation never deletes a binding: it marks it dead so the next
   * `ensure` rebuilds with a higher generation.
   */
  async sweep(): Promise<void> {
    const now = Date.now()
    for (const row of await this.store.list()) {
      if (row.state !== 'ready') {
        if (now - row.lastUsedAt > this.config.idleMs) await this.store.delete(row.key)
        continue
      }
      if (now - row.lastUsedAt <= this.config.idleMs) continue
      await this.platform.destroy(row.externalId).catch(() => undefined)
      await this.store.put({ ...row, state: 'dead' })
    }

    // Bindings created under a scope we no longer use can never be hit again.
    for (const row of await this.store.stale(this.config.scope)) {
      await this.platform.destroy(row.externalId).catch(() => undefined)
      await this.store.delete(row.key)
    }

    if (!this.config.reclaimOrphans) return
    const known = new Set((await this.store.list()).map(row => row.externalId))
    const ours = { app: 'dsh', ...this.config.labels }
    for (const sandbox of await this.platform.list({ labels: ours }).catch(() => [])) {
      if (known.has(sandbox.externalId)) continue
      await this.platform.destroy(sandbox.externalId).catch(() => undefined)
    }
  }

  /**
   * The session directory, resolved on use rather than at construction.
   *
   * Row order inside one patch file is not a dependency graph, so binding the
   * service here would make correctness depend on where the line sits.
   */
  private directory(): SessionDirectory {
    if (this.config.directory !== undefined) return this.config.directory
    const service = this.ctx.get('sessionDirectory') as SessionDirectory | undefined
    if (service === undefined) {
      throw new Error('sandboxes: no session directory — mount @brain/dsh-session-directory or set config.directory')
    }
    return service
  }

  /**
   * The session this call belongs to: the initiating Agent during a turn, or
   * the session pinned by {@link runWithSandboxSession} for browser-originated
   * calls, which have no turn.
   */
  private currentSessionId(): string | undefined {
    const agents = this.ctx.get('agents') as
      | { currentInitiator?: () => { session?: { id?: string } } | undefined }
      | undefined
    try {
      const initiator = agents?.currentInitiator?.()?.session?.id
      if (initiator !== undefined) return initiator
    } catch {
      // A disposed agent registry throws; treat it as "not in a turn".
    }
    return sandboxSessionId()
  }
}

/**
 * Pick the binding store.
 * @param ctx - plugin context.
 * @param kind - configured backend.
 * @returns the store. The postgres store resolves `ctx.db` on first use, because
 * row order inside one patch is not a dependency graph; the database plugin may
 * still be mounting when this registry is constructed.
 */
function trimDir(value: string | undefined): string {
  return value?.trim().replace(/\/+$/u, '') ?? ''
}

function createStore(ctx: Context, kind: Config['storeKind'], scope: SandboxScope): BindingStore {
  if (kind !== 'postgres') return new MemoryBindingStore()
  return new PgBindingStore(ctx, scope)
}

/** Build the configured platform adapter. */
function createPlatform(config: Config, ctx: Context): SandboxPlatform {
  switch (config.adapter) {
    case 'mock':
      return new MockPlatform(config.mock)
    case 'docker':
      return new DockerPlatform(config.docker)
    case 'e2b': {
      if (config.e2b === undefined) throw new Error('sandboxes: adapter "e2b" requires the e2b config block')
      const base = config.e2b
      // The platform owns credentials, endpoint and template. Read them through
      // getters so a value arriving after plugin load is used by the next call.
      const runtime = (): SandboxRuntimeConfig | undefined => ctx.get('sandboxConfig')?.get()
      return new E2bPlatform({
        ...base,
        // Control-plane failures that cannot be retried must be visible in the
        // brain log; they are exactly what leaves a tool call hanging.
        ...(base.onLog === undefined
          ? { onLog: (message: string) => ctx.logger?.warn?.(message) }
          : {}),
        get apiKey() { return runtime()?.apiKey ?? base.apiKey },
        get apiUrl() { return runtime()?.apiUrl ?? base.apiUrl },
        get domain() { return runtime()?.domain ?? base.domain },
        get template() { return runtime()?.template ?? base.template },
        get roleArn() { return runtime()?.roleArn ?? base.roleArn },
      })
    }
    case 'box':
      throw new Error('sandboxes: adapter "box" requires an injected platform (load @brain/dsh-box)')
  }
}

/** Readable one-liner for logs. */
function describe(error: unknown): string {
  if (error instanceof SandboxPlatformError) {
    const failure: SandboxError = error.failure
    return `${failure.kind}${'detail' in failure && failure.detail ? `: ${failure.detail}` : ''}`
  }
  return error instanceof Error ? error.message : String(error)
}
