/**
 * Request-scoped model endpoint.
 *
 * Normal turns reach the model through a Session, so the sentinel-host rewrite
 * can read the endpoint registered for that session. Stateless model calls —
 * intake evaluation — have no session, and falling back to the most recently
 * registered endpoint would hand one tenant another tenant's upstream. The
 * caller therefore pins the endpoint for the duration of the call; the rewrite
 * prefers it over every session-scoped value.
 *
 * @module @brain/dsh-platform-api/request-context
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const requestBaseUrl = new AsyncLocalStorage<string>()

/**
 * Run one call against a specific model endpoint.
 * @param baseUrl - absolute http(s) endpoint from the caller's header.
 * @param run - the work that may issue model requests.
 * @returns the work's result.
 */
export function withModelBaseUrl<T>(baseUrl: string, run: () => T): T {
  return requestBaseUrl.run(baseUrl, run)
}

/**
 * The endpoint pinned for the current call, when one was pinned.
 * @returns the endpoint, or undefined outside a pinned call.
 */
export function requestModelBaseUrl(): string | undefined {
  return requestBaseUrl.getStore()
}
