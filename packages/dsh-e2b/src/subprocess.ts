/**
 * `ctx.subprocess` over a sandbox.
 *
 * This is the highest-leverage provider in the package: bash, background jobs,
 * language services and the PTC runtime all reach the sandbox through it, so
 * none of them needs its own remote implementation.
 *
 * The seam is Node-shaped: `spawn` is synchronous and returns raw streams plus
 * offset-based collected readers, while the platform's start call is
 * asynchronous. The handle therefore publishes its streams immediately and
 * settles `done` once the remote process reports its outcome.
 *
 * @module @brain/dsh-e2b/subprocess
 */

import { PassThrough, Writable } from 'node:stream'
import { SubprocessExecutableNotFoundError, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessStdinMode,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { SandboxPlatformError, type ProcessInfo, type SandboxClient } from './contract.ts'
import type { SandboxBinding } from './registry.ts'
import { sandboxSessionId } from './session-scope.ts'

/** How often an untracked remote process is polled for exit. */
const POLL_MS = 250

/** How deep a session's secret inheritance is followed, matching credentials-session. */
const MAX_SECRET_DEPTH = 8

/**
 * Upper bound on how long a terminated process may take to settle `done`.
 *
 * A caller that cancelled must never wait on a kill that may never report back;
 * after this the handle settles as aborted regardless.
 */
const MAX_TERMINATE_GRACE_MS = 5_000

/** Outcome reported when a process was cancelled. */
function abortedOutcome(): SubprocessOutcome {
  return { exitCode: null, signal: 'SIGKILL' }
}

/** Preserve structured platform failures instead of rendering `[object Object]`. */
function normalizeProcessError(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === 'object' && error !== null) {
    const record = error as { message?: unknown; error?: unknown; code?: unknown; detail?: unknown }
    const message = typeof record.message === 'string'
      ? record.message
      : typeof record.detail === 'string'
        ? record.detail
        : JSON.stringify(error)
    const wrapped = new Error(String(record.code ?? 'sandbox process failed') + ': ' + message)
    wrapped.cause = error
    return wrapped
  }
  return new Error(String(error))
}

/** Process provider backed by a sandbox. */
export default class E2bSubprocess extends SubprocessRuntime {
  static readonly inject = ['sandboxes']

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    spec.signal?.throwIfAborted()
    const stdout = outputSink(spec.stdio.stdout, process.stdout)
    const stderr = outputSink(spec.stdio.stderr, process.stderr)
    const stdin = new StdinChannel(spec.stdio.stdin)

    let client: SandboxClient | undefined
    let pid: number | undefined
    let terminated = false
    let settled = false
    let graceTimer: NodeJS.Timeout | undefined
    let resolveDone!: (outcome: SubprocessOutcome) => void
    let rejectDone!: (error: unknown) => void
    const done = new Promise<SubprocessOutcome>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })

    /** Settle `done` exactly once with an outcome. */
    const settle = (outcome: SubprocessOutcome): void => {
      if (settled) return
      settled = true
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      resolveDone(outcome)
    }
    /** Settle `done` exactly once with a failure. */
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      rejectDone(error)
    }

    /** Kill the remote process; a failed kill is logged, never swallowed. */
    const kill = (target: number): void => {
      if (client === undefined) return
      void client.process.kill(target).catch(error => {
        this.ctx.logger?.warn?.(`e2b-subprocess: kill failed for pid ${target}: ${describe(error)}`)
      })
    }

    /**
     * Start terminating the process.
     *
     * A pid that has not arrived yet cannot be killed here; `start` kills it
     * when it does. Either way `done` settles within the grace period, so a
     * caller that cancelled never waits on a remote kill that may never report.
     */
    const terminate = (): void => {
      if (terminated) return
      terminated = true
      if (pid !== undefined) kill(pid)
      if (pid === undefined && client !== undefined && !settled) {
        // The start handshake is still in flight. It can take arbitrarily
        // long; do not make the caller wait for it.
        settle(abortedOutcome())
        return
      }
      if (settled || graceTimer !== undefined) return
      const graceMs = Math.min(spec.graceMs ?? MAX_TERMINATE_GRACE_MS, MAX_TERMINATE_GRACE_MS)
      graceTimer = setTimeout(() => settle(abortedOutcome()), graceMs)
      graceTimer.unref?.()
    }
    const onAbort = (): void => terminate()
    spec.signal?.addEventListener('abort', onAbort, { once: true })

    const start = async (): Promise<void> => {
      const binding = await this.requireBinding()
      client = await this.ctx.sandboxes.client(binding)
      if (terminated && !settled) {
        // Aborted before the start call was made: nothing was launched.
        settle(abortedOutcome())
        return
      }
      const env = this.spawnEnv(spec.env)
      let started: { pid: number }
      try {
        started = await client.process.start(
          {
            argv: spec.argv,
            cwd: spec.cwd,
            ...(env === undefined ? {} : { env }),
            stdin: spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe',
            ...(spec.signal === undefined ? {} : { signal: spec.signal }),
          },
          {
            stdout: chunk => stdout.write(chunk),
            stderr: chunk => stderr.write(chunk),
          },
        )
      } catch (error) {
        // A start that never returned a pid may still have launched something.
        // When even the process list could not be read, the sandbox's state is
        // unknowable and it must be rebuilt before the next tool call.
        if (isUnrecoverableStart(error)) await this.retire(binding)
        throw error
      }
      pid = started.pid
      stdin.attach(client, pid)
      if (terminated) {
        // The abort won the race: kill the pid that just arrived and settle.
        kill(pid)
        settle(abortedOutcome())
        return
      }
      const final = client.process.wait === undefined
        ? await pollExit(client, pid, spec.signal)
        : await client.process.wait(pid, spec.signal)
      settle({ exitCode: final?.exitCode ?? null, signal: null })
    }

    void start().catch(error => {
      // No pid will ever arrive: release any writer waiting on attachment.
      stdin.cancel()
      fail(normalizeProcessError(error))
    }).finally(() => {
      spec.signal?.removeEventListener('abort', onAbort)
      void stdin.close()
      stdout.end()
      stderr.end()
    })

    return {
      stdin: stdin.stream,
      stdout: stdout.pipe,
      stderr: stderr.pipe,
      control: undefined,
      collected: {
        ...(stdout.reader === undefined ? {} : { stdout: stdout.reader }),
        ...(stderr.reader === undefined ? {} : { stderr: stderr.reader }),
      },
      done,
      terminate,
      waitForExit: async (signal?: AbortSignal): Promise<boolean> => {
        if (signal?.aborted === true) return false
        const exited = done.then(() => true, () => true)
        if (signal === undefined) return await exited
        return await Promise.race([
          exited,
          new Promise<false>(resolve => signal.addEventListener('abort', () => resolve(false), { once: true })),
        ])
      },
    }
  }

  /**
   * Resolve an executable inside the sandbox rather than on the host.
   *
   * Absolute paths are checked with `stat`; bare names go through `command -v`
   * in the sandbox's own environment.
   */
  override async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted()
    const binding = await this.requireBinding()
    const client = await this.ctx.sandboxes.client(binding)

    if (command.includes('/')) {
      const info = await client.files.stat(command)
      if (info !== undefined && info.type === 'file') return command
      throw new SubprocessExecutableNotFoundError(`executable not found in sandbox: ${command}`)
    }

    const chunks: Uint8Array[] = []
    const started = await client.process.start(
      {
        argv: ['sh', '-c', 'command -v "$1"', 'sh', command],
        cwd: binding.workspaceRoot,
        ...(env === undefined ? {} : { env: { ...env } }),
        stdin: 'ignore',
      },
      { stdout: chunk => chunks.push(chunk) },
    )
    const final = client.process.wait === undefined
      ? await pollExit(client, started.pid, signal)
      : await client.process.wait(started.pid, signal)
    const found = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8').trim()
    if (found === '' || (final?.exitCode ?? 1) !== 0) {
      throw new SubprocessExecutableNotFoundError(`executable not found in sandbox: ${command}`)
    }
    return found
  }

  /** Shell facts for the sandbox image this package targets. */
  override async terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    signal?.throwIfAborted()
    return { platform: 'posix', defaultShell: '/bin/bash' }
  }

  /**
   * Terminal allocation is not implemented: the SDK exposes a separate PTY API
   * and the `terminal-*` tools stay out of the preset until it is wired.
   */
  override async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    throw new Error('E2B adapter: terminal support is not implemented')
  }

  /** The binding serving the initiating turn. */
  private async requireBinding() {
    const binding = await this.ctx.sandboxes.ensureCurrent()
    if (binding === undefined) {
      throw new Error('E2B adapter: process operations require an initiating session')
    }
    return binding
  }

  /**
   * The environment a child process starts with.
   *
   * The platform's per-session secret is merged last: a command must not be able
   * to shadow the token it was given, and a subagent session — born inside the
   * brain — inherits its parent's secret the same way it inherits the sandbox.
   * @param spec - the caller's environment, when it supplied one.
   * @returns the merged environment, or undefined when there is nothing to pass.
   */
  private spawnEnv(spec: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
    const base = spec === undefined ? {} : definedEnv(spec)
    const secret = this.sessionSecret()
    if (secret === undefined) return Object.keys(base).length === 0 ? undefined : base
    return { ...base, [secret.env]: secret.value }
  }

  /** The platform-supplied secret for the session this spawn belongs to. */
  private sessionSecret(): { env: string; value: string } | undefined {
    const store = this.ctx.get('sessionSecrets') as
      | { get(sessionId: string): { env: string; value: string } | undefined }
      | undefined
    if (store === undefined) return undefined
    const sessionId = this.currentSessionId()
    if (sessionId === undefined) return undefined
    const seen = new Set<string>()
    let id: string | undefined = sessionId
    for (let depth = 0; id !== undefined && depth < MAX_SECRET_DEPTH && !seen.has(id); depth += 1) {
      seen.add(id)
      const secret = store.get(id)
      if (secret !== undefined) return secret
      id = this.parentSessionOf(id)
    }
    return undefined
  }

  /** The session this call belongs to, with the same precedence as the registry. */
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

  /** The durable parent of one live child session. */
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

  /**
   * Ask the registry to rebuild a sandbox whose process state cannot be
   * determined. The next tool call creates a fresh one; workspace files are on
   * OSS, so only running processes are lost.
   * @param binding - binding whose sandbox must be replaced.
   */
  private async retire(binding: SandboxBinding): Promise<void> {
    const registry = this.ctx.sandboxes as {
      retire?(binding: SandboxBinding): Promise<void>
    }
    if (typeof registry.retire !== 'function') return
    await registry.retire(binding).catch(error => {
      this.ctx.logger?.warn?.(`e2b-subprocess: retire failed: ${describe(error)}`)
    })
  }
}

/** One output stream as the seam sees it. */
interface OutputSink {
  readonly pipe?: PassThrough
  readonly reader?: SubprocessOutputReader
  write(chunk: Uint8Array): void
  end(): void
}

/** Build the raw or collected destination for one output mode. */
function outputSink(mode: SubprocessOutputMode, inherit: NodeJS.WriteStream): OutputSink {
  if (mode === 'inherit') {
    return { write: chunk => { inherit.write(chunk) }, end: () => undefined }
  }
  if (mode === 'pipe') {
    const pipe = new PassThrough()
    return { pipe, write: chunk => { pipe.write(chunk) }, end: () => { pipe.end() } }
  }
  const collector = new OutputCollector(mode.maxBytes)
  return {
    reader: { readFrom: from => collector.readFrom(from) },
    write: chunk => collector.push(chunk),
    end: () => undefined,
  }
}

/**
 * Bounded in-memory tail for one collected stream.
 *
 * Spill files are not created: the seam allows omitting `spillPath`, and a
 * reader past the retained window reports `lossy` so the caller can truncate.
 */
class OutputCollector {
  private readonly chunks: Buffer[] = []
  private retained = 0
  private total = 0

  constructor(private readonly maxBytes: number) {}

  push(chunk: Uint8Array): void {
    let buffer = Buffer.from(chunk)
    this.total += buffer.byteLength
    if (buffer.byteLength > this.maxBytes) {
      buffer = buffer.subarray(buffer.byteLength - this.maxBytes)
      this.chunks.length = 0
      this.retained = 0
    }
    this.chunks.push(buffer)
    this.retained += buffer.byteLength
    while (this.retained > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()
      this.retained -= dropped?.byteLength ?? 0
    }
  }

  readFrom(fromByte: number): SubprocessOutputRead {
    const start = this.total - this.retained
    const text = Buffer.concat(this.chunks).toString('utf8')
    if (fromByte < start) return { text, nextOffset: this.total, lossy: true }
    if (fromByte >= this.total) return { text: '', nextOffset: this.total, lossy: false }
    const window = Buffer.concat(this.chunks)
    return {
      text: window.subarray(fromByte - start).toString('utf8'),
      nextOffset: this.total,
      lossy: false,
    }
  }
}

/**
 * stdin for one remote process.
 *
 * Writes are forwarded once the start call reports a pid, preserving order and
 * honoring the seam's three dispositions: ignored, a caller-owned pipe, or a
 * one-shot batch that closes after delivery.
 */
class StdinChannel {
  readonly stream: Writable | undefined
  private readonly ready: Promise<void>
  private markReady!: () => void
  private chain: Promise<void> = Promise.resolve()
  private client: SandboxClient | undefined
  private pid: number | undefined
  private closed = false

  constructor(mode: SubprocessStdinMode) {
    this.ready = new Promise<void>(resolve => { this.markReady = resolve })
    if (mode === 'ignore') {
      this.stream = undefined
      this.markReady()
      return
    }
    if (typeof mode === 'object') {
      // Batch disposition: deliver the bytes, then signal EOF.
      this.stream = undefined
      this.enqueue(new TextEncoder().encode(mode.data))
      void this.chain.then(() => this.finish())
      return
    }
    this.stream = new Writable({
      write: (chunk, _encoding, callback) => {
        this.enqueue(chunk instanceof Buffer ? chunk : Buffer.from(chunk as string))
        callback()
      },
      final: callback => {
        void this.close().finally(() => callback())
      },
    })
  }

  /** Bind the live process once its pid is known. */
  attach(client: SandboxClient, pid: number): void {
    this.client = client
    this.pid = pid
    this.markReady()
  }

  /** Release writers when the process never started. */
  cancel(): void {
    this.closed = true
    this.markReady()
  }

  /** Flush queued writes and close stdin once. */
  async close(): Promise<void> {
    await this.ready
    await this.chain.catch(() => undefined)
    await this.finish()
  }

  /** Close the remote stdin without touching the queue (used after a batch write). */
  private async finish(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.ready
    if (this.client !== undefined && this.pid !== undefined) {
      await this.client.process.closeStdin?.(this.pid).catch(() => undefined)
    }
  }

  private enqueue(data: Uint8Array): void {
    this.chain = this.chain.then(async () => {
      await this.ready
      if (this.client !== undefined && this.pid !== undefined) {
        await this.client.process.write?.(this.pid, data)
      }
    })
  }
}

/** Drop `undefined` environment tombstones before crossing the wire. */
function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const defined: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) defined[key] = value
  }
  return defined
}

/** Whether a start failure left a command that cannot be located or killed. */
function isUnrecoverableStart(error: unknown): boolean {
  return error instanceof SandboxPlatformError
    && 'detail' in error.failure
    && typeof error.failure.detail === 'string'
    && error.failure.detail.startsWith('unrecoverable-start')
}

/** Readable one-liner for logs. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Poll until the process leaves the running set. */
async function pollExit(
  client: SandboxClient,
  pid: number,
  signal?: AbortSignal,
): Promise<ProcessInfo | undefined> {
  for (;;) {
    if (signal?.aborted === true) return undefined
    const info = await client.process.status(pid)
    if (info === undefined || info.state === 'exited') return info
    await new Promise<void>(resolve => { setTimeout(resolve, POLL_MS) })
  }
}
