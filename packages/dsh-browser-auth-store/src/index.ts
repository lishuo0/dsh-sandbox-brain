/**
 * Holds the signing secret the DSH client connection uses for its browser cookie.
 *
 * The deployment does not use the on-disk credential file: model keys stay on
 * the session. This store only answers the one record connection writes at startup.
 *
 * @module @brain/dsh-browser-auth-store
 */

import { Context, Service } from '@deepseek-ai/cordis'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-auth-store'

/** Memory-backed `credentials` service. */
class BrowserAuthStore extends Service {
  private readonly records = new Map<string, unknown>()

  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  /** Read-modify-write one record. Returning undefined from `mutate` leaves it unchanged. */
  async modifyRecord(key: unknown, mutate: (current: unknown) => Promise<unknown>): Promise<unknown> {
    const id = typeof key === 'string' ? key : String(key)
    const next = await mutate(this.records.get(id))
    if (next !== undefined) this.records.set(id, next)
    return this.records.get(id)
  }
}

/** Provide the store under the service name connection injects. */
export function apply(ctx: Context): void {
  ctx.plugin(BrowserAuthStore)
}
