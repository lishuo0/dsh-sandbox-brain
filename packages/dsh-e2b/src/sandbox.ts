/**
 * `ctx.sandbox` over a sandbox.
 *
 * Nothing is wrapped: the microVM is the boundary. The DSH file-effect policy
 * therefore adds no restriction here, and the only thing this provider must do
 * is declare that honestly in its result.
 *
 * @module @brain/dsh-e2b/sandbox
 */

import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** Pass-through provider: isolation comes from the VM, not from argv wrapping. */
export default class E2bSandboxProvider extends SandboxProvider {
  override async confine(argv: readonly string[], _policy: SandboxPolicy): Promise<ConfinedArgv> {
    // The VM is the boundary; no argv wrapping is added for any confined mode.
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}
