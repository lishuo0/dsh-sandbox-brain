/**
 * `ctx.fileUploads` for a platform-owned upload path.
 *
 * Upstream uploads arrive over the DSH Host face (`connection` + the
 * `file-upload` plugin), which this deployment removes: the platform accepts
 * browser uploads at `P/upload`, stores them, and sends the brain plain text.
 * No upload receipt ever crosses this process boundary.
 *
 * `@deepseek-ai/dsh-api-session-controller` still requires the service, though,
 * and stays inert (no `projections`, no `fork`) while it is missing. This
 * placeholder satisfies the composition without opening any host HTTP route:
 * the resolver registration is kept for the controller's disposer contract,
 * and every receipt lookup resolves to "unknown", which is the truth here.
 *
 * @module @brain/dsh-file-uploads-stub
 */

import { Service, type Context } from '@deepseek-ai/cordis'

type AgentResolver = (sessionId: string) => Promise<unknown>

interface PromptBinding {
  commit(): void
}

export default class FileUploadsStub extends Service {
  static readonly inject: readonly string[] = []

  private resolver: { current: AgentResolver | undefined } = { current: undefined }

  constructor(ctx: Context) {
    super(ctx, 'fileUploads')
  }

  /** Accepted so the session controller's effect can register and dispose it. */
  registerAgentResolver(resolve: AgentResolver): () => void {
    if (this.resolver.current !== undefined) {
      throw new Error('file-upload: Agent resolver is already registered')
    }
    this.resolver.current = resolve
    return () => {
      if (this.resolver.current === resolve) this.resolver.current = undefined
    }
  }

  /** No receipt was staged here; the platform owns every uploaded file. */
  resolve(_agent: unknown, _receiptId: string): undefined {
    return undefined
  }

  /** Nothing to keep or roll back because no receipt was staged. */
  bindPrompt(_agent: unknown, _receiptIds: readonly string[], _requestId: string): PromptBinding {
    const dispose = Reflect.get(Symbol, 'dispose') as symbol | undefined
    const binding: Record<symbol, unknown> = {}
    if (dispose !== undefined) binding[dispose] = () => {}
    return Object.assign({ commit(): void {} }, binding)
  }

  retirePrompt(_agent: unknown, _requestId: string): void {}
}
