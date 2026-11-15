/**
 * Always-on workspace rules for the OSS-backed sandbox.
 *
 * The workspace is a `fuse.ossfs2` mount: writes work, but chmod and symlink
 * do not. Git writes a config lock and chmods it, so a normal clone fails; npm
 * and venv create symlinks, so dependency installs fail too. The rule belongs
 * in the system prompt, not a lazy skill: the model must know before it runs
 * the first shell command.
 *
 * @module @brain/dsh-workspace-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'workspace-policy'

/** The prompt registry must exist before the section can be registered. */
export const inject = ['systemPrompt']

/** Prompt section name; unique across the deployment. */
export const SECTION_NAME = 'workspace.ossfs'

/** Newest instructions win only on conflicts; this sits before tool guidance. */
export const SECTION_ORDER = 950

/** Stable text injected into every session. */
export const WORKSPACE_INSTRUCTION = `## Workspace storage (ossfs2)
The workspace is an OSS FUSE mount. It supports read/write but NOT chmod or symlink: chmod fails with EPERM, symlink fails with ENOTSUP.
- Clone: git clone --separate-git-dir=/tmp/git/<name>.git <url> <workspace>/<name>
- Existing repo: mv .git /tmp/git/<name>.git; then write a .git file containing "gitdir: /tmp/git/<name>.git"
- Dependencies and builds: run in /tmp (or a POSIX volume), then copy source/artifacts back. Put tool caches in /tmp where supported (GOCACHE, CARGO_TARGET_DIR, npm_config_cache, PIP_CACHE_DIR).
- Read-only code: download an archive (codeload tar.gz / GitLab archive) instead of cloning.
- Credentials: /tmp or environment variables; chmod on the workspace has no effect.
- Persist git history: git bundle create <workspace>/<name>.bundle --all.`

/**
 * Register the workspace policy section.
 * @param ctx - plugin context with the prompt registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: WORKSPACE_INSTRUCTION,
    }),
    'workspace-policy: ossfs instructions',
  )
}
