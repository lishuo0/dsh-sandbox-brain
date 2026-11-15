/**
 * E2B sandbox runtime for DSH.
 *
 * Loads as four plugin rows: the registry plus three providers. The registry is
 * registered as `ctx.sandboxes`; the providers replace the `fs`, `subprocess`
 * and `sandbox` rows in a profile.
 *
 * @module @brain/dsh-e2b
 */

export { default as SandboxRegistry } from './registry.ts'
export type { Config, SandboxBinding, SandboxKey, SandboxScope, SessionDirectory, BindingStore } from './registry.ts'
export { MemoryBindingStore } from './registry.ts'
export { PgBindingStore } from './store-pg.ts'
export { default as E2bFileSystem } from './fs.ts'
export { default as E2bSubprocess } from './subprocess.ts'
export { default as E2bSandboxProvider } from './sandbox.ts'
export { E2bPlatform } from './e2b-adapter.ts'
export { MockPlatform } from './mock-adapter.ts'
export type { MockConfig } from './mock-adapter.ts'
export type { E2bConfig } from './e2b-adapter.ts'
export * from './contract.ts'
