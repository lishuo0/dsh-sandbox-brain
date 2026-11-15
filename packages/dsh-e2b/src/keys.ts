/**
 * Sandbox keys and per-workspace volume names.
 *
 * Kept free of Cordis and platform imports so the naming rules are directly
 * testable: isolation depends on them, and a silent collision would mount two
 * workspaces onto one volume.
 *
 * @module @brain/dsh-e2b/keys
 */

import { createHash } from 'node:crypto'

/** Composite key. Unused levels carry the empty string. */
export interface SandboxKey {
  readonly userId: string
  readonly workspaceId: string
  readonly sessionId: string
}

/** Stable string form of a composite key. */
export function id(key: SandboxKey): string {
  return `${key.userId}\u0000${key.workspaceId}\u0000${key.sessionId}`
}

/**
 * Render a per-workspace volume name.
 *
 * The workspace id is the only isolation anchor. When sanitization (case,
 * punctuation) or the 63-character limit would change the name, a digest of the
 * full id is appended so two workspaces can never collapse onto one volume.
 * @param template - must contain `{workspaceId}`.
 * @param workspaceId - the workspace's unique id.
 * @returns the volume name.
 * @throws when the template produces an empty name.
 */
export function volumeNameFor(template: string, workspaceId: string, userId = ''): string {
  const rendered = template.replaceAll('{workspaceId}', workspaceId).replaceAll('{userId}', userId)
  const cleaned = cleanVolumeName(rendered)
  if (cleaned === '') {
    throw new Error(
      `sandboxes: volume name template "${template}" produced an empty name for workspace "${workspaceId}"`,
    )
  }
  if (cleaned === rendered && cleaned.length <= 63) return cleaned
  const digest = createHash('sha256').update(workspaceId).digest('hex').slice(0, 8)
  return `${cleaned.slice(0, 54).replace(/-+$/g, '')}-${digest}`
}

/** Drop empty metadata values, which some platforms reject. */
export function dropEmpty(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).filter(([, value]) => value !== ''))
}

/** Lowercase a volume name and drop characters the platform does not accept. */
function cleanVolumeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}
