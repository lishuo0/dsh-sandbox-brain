/**
 * Service-to-service authentication: several appId/appKey pairs, checked against
 * headers on every request.
 *
 * Two properties matter and both are cheap to get right:
 * - comparison is constant-time over digests, so a wrong key cannot be recovered
 *   byte by byte from response timing;
 * - an unknown appId and a wrong key produce the SAME failure, so the caller
 *   cannot enumerate valid appIds.
 *
 * @module @brain/dsh-platform-api/auth
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

/** One registered caller. */
export interface AppCredential {
  readonly appId: string
  readonly appKey: string
  /** Human label for logs; never sent to a caller. */
  readonly name?: string
}

/** On-disk credential file. */
export interface AppCredentialFile {
  readonly apps: readonly AppCredential[]
}

/** Resolved caller identity after a successful check. */
export interface AuthenticatedCaller {
  readonly appId: string
  /** Per-request correlation id, generated when the caller supplies none. */
  readonly requestId: string
  /** The user this request acts for, from the user header. */
  readonly userId?: string
}

/** Authentication failure. Carries no detail: callers must not learn why. */
export class AuthError extends Error {
  constructor(message = 'unauthorized') {
    super(message)
    this.name = 'AuthError'
  }
}

/** Header names. Configurable, because the platform may already use its own. */
export interface AuthHeaders {
  readonly appId: string
  readonly appKey: string
  readonly userId: string
  readonly requestId: string
}

/** Default header names. */
export const DEFAULT_HEADERS: AuthHeaders = {
  appId: 'x-app-id',
  appKey: 'x-app-key',
  userId: 'x-dsh-user-id',
  requestId: 'x-request-id',
}

/**
 * Load credentials from a JSON file.
 *
 * The file is read once at plugin load. Reloading on change would need a watcher
 * and a rotation story; until then, rotating a key means restarting the profile,
 * which the deployment already does for upgrades.
 *
 * @param path - absolute path to the credential file.
 * @returns the parsed credentials.
 * @throws when the file is missing, unreadable, or malformed.
 */
export function loadCredentials(path: string): AppCredential[] {
  const stats = statSync(path)
  if (!stats.isFile()) throw new Error(`platform-api: credentials path is not a file: ${path}`)
  const raw = readFileSync(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`platform-api: credentials file is not valid JSON: ${path}`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('platform-api: credentials file must contain an object')
  }
  const apps = (parsed as Partial<AppCredentialFile>).apps
  if (!Array.isArray(apps) || apps.length === 0) {
    throw new Error('platform-api: credentials file needs a non-empty "apps" array')
  }
  const seen = new Set<string>()
  return apps.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`platform-api: apps[${index}] is not an object`)
    }
    const { appId, appKey, name } = entry as Partial<AppCredential>
    if (typeof appId !== 'string' || appId === '') {
      throw new Error(`platform-api: apps[${index}].appId must be a non-empty string`)
    }
    if (typeof appKey !== 'string' || appKey.length < 16) {
      throw new Error(`platform-api: apps[${index}].appKey must be at least 16 characters`)
    }
    if (seen.has(appId)) throw new Error(`platform-api: duplicate appId "${appId}"`)
    seen.add(appId)
    return name === undefined ? { appId, appKey } : { appId, appKey, name }
  })
}

/**
 * Verify the caller headers.
 *
 * @param headers - lowercased header lookup.
 * @param credentials - every accepted appId/appKey pair.
 * @param names - configured header names, lowercased.
 * @returns the caller identity.
 * @throws {AuthError} for a missing, unknown, or mismatched credential.
 */
export function authenticate(
  headers: (name: string) => string | undefined,
  credentials: readonly AppCredential[],
  names: AuthHeaders,
): AuthenticatedCaller {
  const appId = headers(names.appId)
  const appKey = headers(names.appKey)
  if (appId === undefined || appKey === undefined) throw new AuthError()

  // Compare digests so the comparison length never depends on the stored key,
  // and walk every entry so a match's position does not affect timing.
  const presented = digest(appKey)
  let matched: AppCredential | undefined
  for (const candidate of credentials) {
    const expected = digest(candidate.appKey)
    const equal = timingSafeEqual(presented, expected)
    if (equal && candidate.appId === appId) matched = candidate
  }
  if (matched === undefined) throw new AuthError()

  const requestId = headers(names.requestId) ?? randomUUID()
  const userId = headers(names.userId)
  return {
    appId: matched.appId,
    requestId,
    ...(userId === undefined || userId === '' ? {} : { userId }),
  }
}

/** SHA-256 digest as bytes, so both sides of the comparison have equal length. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}
