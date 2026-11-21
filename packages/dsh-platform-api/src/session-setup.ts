/**
 * Session-scoped setup the platform sends with create/resume.
 *
 * Two things arrive here that belong to the session rather than to any tool:
 *
 * - `secret`: one short-lived environment variable (a GitHub token, typically)
 *   that every child process started inside the session's sandbox receives.
 *   It lives in this process only, is replaced on every create, and is cleared
 *   when the session goes away.
 * - `bootstrap`: a shell script run once in the sandbox before the first turn.
 *   It goes through the same process seam as tool commands; nothing about it is
 *   visible to the model, and a failure is reported to the platform instead of
 *   being turned into conversation.
 *
 * @module @brain/dsh-platform-api/session-setup
 */

import type { Context } from '@deepseek-ai/cordis'
import { HttpError } from './http.ts'

/** One environment variable injected into every child process of a session. */
export interface SessionSecret {
  readonly env: string
  readonly value: string
}

/** Per-session secret storage. */
export interface SessionSecretStore {
  get(sessionId: string): SessionSecret | undefined
  /** Replace the session's secret; `undefined` clears it. */
  set(sessionId: string, secret: SessionSecret | undefined): void
  delete(sessionId: string): void
}

/** Environment names the shell tool owns and rebuilds; a secret must not land there. */
const RESERVED_ENV_PREFIX = 'DSH_'

/** A legal POSIX environment name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Upper bound for one secret value. */
export const MAX_SECRET_BYTES = 8 * 1024

/** Upper bound for a bootstrap script. */
export const MAX_BOOTSTRAP_BYTES = 64 * 1024

/** How long one bootstrap script may run. */
export const BOOTSTRAP_TIMEOUT_MS = 300_000

/** How much bootstrap output is kept for the brain log. */
const BOOTSTRAP_TAIL_BYTES = 4 * 1024

/** How many live sessions may carry a secret before the oldest is evicted. */
const MAX_SESSIONS = 10_000

/**
 * Create the in-memory secret store.
 * @returns a store with the same eviction policy as the model-key store.
 */
export function createSessionSecrets(): SessionSecretStore {
  const rows = new Map<string, SessionSecret>()
  return {
    get: sessionId => rows.get(sessionId),
    set: (sessionId, secret) => {
      if (secret === undefined) {
        rows.delete(sessionId)
        return
      }
      if (!rows.has(sessionId) && rows.size >= MAX_SESSIONS) {
        const oldest = rows.keys().next().value
        if (oldest !== undefined) rows.delete(oldest)
      }
      rows.set(sessionId, secret)
    },
    delete: sessionId => void rows.delete(sessionId),
  }
}

/**
 * Validate the `secret` field of a create request.
 * @param input - the raw JSON value.
 * @returns the secret, or undefined when the field was omitted.
 * @throws {HttpError} 400 `invalid-secret-env` / `invalid-secret`.
 */
export function parseSecret(input: unknown): SessionSecret | undefined {
  if (input === undefined) return undefined
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HttpError(400, 'invalid-secret', 'secret must be an object with env and value')
  }
  const record = input as { env?: unknown; value?: unknown }
  if (typeof record.env !== 'string' || !ENV_NAME.test(record.env) || record.env.startsWith(RESERVED_ENV_PREFIX)) {
    throw new HttpError(
      400,
      'invalid-secret-env',
      `secret.env must match ${ENV_NAME.source} and must not start with ${RESERVED_ENV_PREFIX}`,
    )
  }
  if (typeof record.value !== 'string' || record.value.trim() === '' || Buffer.byteLength(record.value) > MAX_SECRET_BYTES) {
    throw new HttpError(400, 'invalid-secret', `secret.value must be a non-empty string of at most ${MAX_SECRET_BYTES} bytes`)
  }
  return { env: record.env, value: record.value }
}

/**
 * Validate the `bootstrap` field of a create request.
 * @param input - the raw JSON value.
 * @returns the script, or undefined when the field was omitted.
 * @throws {HttpError} 400 `invalid-bootstrap`.
 */
export function parseBootstrap(input: unknown): string | undefined {
  if (input === undefined) return undefined
  if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_BOOTSTRAP_BYTES) {
    throw new HttpError(400, 'invalid-bootstrap', `bootstrap must be a string of at most ${MAX_BOOTSTRAP_BYTES} bytes`)
  }
  if (input.trim() === '') return undefined
  return input
}

/** One remote process state, as bootstrap needs it. */
interface ProcessState {
  readonly state: 'running' | 'exited'
  readonly exitCode?: number
}

/** The process half of a sandbox client. */
interface SandboxClientLike {
  readonly process: {
    start(
      spec: {
        readonly argv: readonly string[]
        readonly cwd: string
        readonly env?: Readonly<Record<string, string>>
        readonly stdin?: 'pipe' | 'ignore'
        readonly signal?: AbortSignal
      },
      handlers?: {
        readonly stdout?: (chunk: Uint8Array) => void
        readonly stderr?: (chunk: Uint8Array) => void
      },
    ): Promise<{ readonly pid: number }>
    status(pid: number): Promise<ProcessState | undefined>
    wait?(pid: number, signal?: AbortSignal): Promise<ProcessState | undefined>
    kill?(pid: number, signal?: string): Promise<void>
  }
}

/** The sandbox registry surface bootstrap needs. */
interface Sandboxes {
  ensure(sessionId: string): Promise<{ readonly workspaceRoot: string; readonly externalId: string }>
  client(binding: { readonly workspaceRoot: string; readonly externalId: string }): Promise<SandboxClientLike>
}

/**
 * Run one bootstrap script inside a session's sandbox.
 *
 * Output is never returned to the caller: the last 4 KiB go to the brain log so
 * an operator can see why a script failed, and the platform only learns the exit
 * reason. The session survives a failure — retrying `create` re-runs the script.
 * @param ctx - plugin context carrying the sandbox registry.
 * @param sessionId - the created session.
 * @param script - the shell script.
 * @param cwd - the session's working directory.
 * @param secret - the token to put in the script's environment, when present.
 * @param timeoutMs - how long the script may run; defaults to {@link BOOTSTRAP_TIMEOUT_MS}.
 * @throws {HttpError} 502 `bootstrap-failed` on a non-zero exit, timeout or missing runtime.
 */
export async function runBootstrap(
  ctx: Context,
  sessionId: string,
  script: string,
  cwd: string,
  secret: SessionSecret | undefined,
  timeoutMs: number = BOOTSTRAP_TIMEOUT_MS,
): Promise<void> {
  const sandboxes = ctx.get('sandboxes') as Sandboxes | undefined
  if (sandboxes === undefined) {
    throw new HttpError(502, 'bootstrap-failed', 'sandbox runtime is not available')
  }

  let tail = ''
  const capture = (chunk: Uint8Array): void => {
    tail = tailBuffer(tail, chunk)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()

  let client: SandboxClientLike | undefined
  let pid: number | undefined

  try {
    const binding = await sandboxes.ensure(sessionId)
    client = await sandboxes.client(binding)
    const started = await client.process.start(
      {
        argv: ['bash', '-lc', script],
        cwd,
        env: secret === undefined ? {} : { [secret.env]: secret.value },
        stdin: 'ignore',
        signal: controller.signal,
      },
      { stdout: capture, stderr: capture },
    )
    pid = started.pid
    const final = client.process.wait === undefined
      ? await pollExit(client, started.pid, controller.signal)
      : await client.process.wait(started.pid, controller.signal)
    const code = final?.exitCode ?? null
    if (final === undefined) {
      throw new HttpError(502, 'bootstrap-failed', 'bootstrap timed out')
    }
    if (code !== 0) {
      throw new HttpError(502, 'bootstrap-failed', `bootstrap exited with ${code === null ? 'a signal' : `code ${code}`}`)
    }
  } catch (error) {
    ctx.logger?.warn?.(
      `platform-api: bootstrap failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}` +
        (tail === '' ? '' : `\n${tail}`),
    )
    if (error instanceof HttpError) throw error
    throw new HttpError(502, 'bootstrap-failed', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
    // A timed-out script is still running in the sandbox; it must not outlive
    // the request that started it.
    if (controller.signal.aborted && pid !== undefined) {
      await client?.process.kill?.(pid).catch(() => undefined)
    }
  }
}

/** Append bytes to a tail bounded to the last 4 KiB. */
function tailBuffer(tail: string, chunk: Uint8Array): string {
  const next = tail + Buffer.from(chunk).toString('utf8')
  if (Buffer.byteLength(next) <= BOOTSTRAP_TAIL_BYTES) return next
  const buffer = Buffer.from(next)
  // Cut on a byte boundary and drop any partial UTF-8 sequence it exposes.
  return buffer.subarray(buffer.byteLength - BOOTSTRAP_TAIL_BYTES).toString('utf8').replace(/^�+/u, '')
}

/** Poll until the process exits, for adapters without a wait call. */
async function pollExit(
  client: SandboxClientLike,
  pid: number,
  signal: AbortSignal,
): Promise<ProcessState | undefined> {
  for (;;) {
    if (signal.aborted) return undefined
    const info = await client.process.status(pid)
    if (info === undefined || info.state === 'exited') return info
    await new Promise<void>(resolve => { setTimeout(resolve, 250) })
  }
}
