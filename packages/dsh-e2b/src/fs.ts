/**
 * `ctx.fs` over a sandbox.
 *
 * Every method is a thin translation onto `SandboxClient.files`. Identity comes
 * from the registry, never from the call signature — the seam's read methods
 * carry no session, so this provider must live where the initiating turn is
 * available.
 *
 * Paths are POSIX paths inside the VM. `targetKey` is that path, so later calls
 * never re-resolve it against the host.
 *
 * @module @brain/dsh-e2b/fs
 */

import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDeleteOutcome,
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsMoveOutcome,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { applyHunks, type PatchHunk } from '@deepseek-ai/dsh-fs-patch'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
// Side-effect type import: declaration-merges `ctx.sandboxPolicy`.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
/** Largest prior file content retained as a diff basis, in bytes. */
const MAX_DIFF_BASIS_BYTES = 1_048_576

/** The UTF-8 decoder used for text files; invalid sequences are an error. */
const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** File provider backed by a sandbox. */
export default class E2bFileSystem extends FileSystem {
  static readonly inject = ['sandboxes', 'sandboxPolicy']

  /**
   * The deployment default mode. The VM is the isolation boundary between
   * tenants, but a mode still decides whether the model's own file tools may
   * mutate at all (`read-only`) and where (`workspace-write`), so it must be
   * advertised here — `dsh-tool-fs` builds its escalation surface from this.
   */
  override get sandboxMode(): SandboxMode {
    return this.ctx.sandboxPolicy.defaultMode
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    opts?.signal?.throwIfAborted()
    const binding = await this.binding()
    const absolute = posix.resolve(opts?.cwd ?? binding.workspaceRoot, path)
    return { targetKey: FsTargetKey(absolute), displayPath: absolute }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === ''
      || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    signal?.throwIfAborted()
    const stat = await (await this.client()).files.stat(this.path(target))
    signal?.throwIfAborted()
    if (stat === undefined) return undefined
    return {
      version: versionOf(stat.size, stat.mtimeMs),
      type: stat.type === 'symlink' ? 'other' : stat.type,
      size: stat.size,
    }
  }

  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    signal?.throwIfAborted()
    const binding = await this.binding()
    const absolute = posix.resolve(opts?.cwd ?? binding.workspaceRoot, path)
    const stat = await (await this.client()).files.stat(absolute)
    signal?.throwIfAborted()
    if (stat === undefined) return undefined
    return {
      version: versionOf(stat.size, stat.mtimeMs),
      type: stat.type,
      size: stat.size,
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const data = await (await this.client()).files.read(this.path(target))
    signal?.throwIfAborted()
    return decodeText(data, target.displayPath)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    // The platform exposes whole-file reads only, so the first chunk is the
    // whole file. The seam's cap and streaming contract stay intact for callers.
    const text = await this.readText(target, signal)
    return (async function* () { yield text })()
  }

  override async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted()
    const client = await this.client()
    const path = this.path(target)
    // Check metadata first so an oversized file is never buffered whole.
    const info = await client.files.stat(path)
    if (info !== undefined && info.size > maxBytes) {
      throw new FsError(`file exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
    }
    const data = await client.files.read(path)
    signal?.throwIfAborted()
    if (data.byteLength > maxBytes) {
      throw new FsError(`file exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
    }
    return data
  }

  override async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(range.offset) || range.offset < 0) {
      throw new FsError(`byte offset must be a non-negative integer, got ${range.offset}`, 'FS_IO_ERROR')
    }
    if (!Number.isSafeInteger(range.length) || range.length < 0) {
      throw new FsError(`byte length must be a non-negative integer, got ${range.length}`, 'FS_IO_ERROR')
    }
    signal?.throwIfAborted()
    const data = await (await this.client()).files.read(this.path(target))
    signal?.throwIfAborted()
    return data.subarray(range.offset, range.offset + range.length)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    signal?.throwIfAborted()
    const entries = await (await this.client()).files.list(this.path(target))
    signal?.throwIfAborted()
    return entries.map(entry => ({
      name: entry.name,
      target: { targetKey: FsTargetKey(entry.path), displayPath: entry.path },
      type: entry.type === 'symlink' ? 'other' : entry.type,
      ...(entry.size === undefined ? {} : { size: entry.size }),
    }))
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    signal?.throwIfAborted()
    this.assertMutable(target, sandboxPolicy)
    const client = await this.client()
    const path = this.path(target)
    const existing = await client.files.stat(path)
    if (existing !== undefined && existing.type !== 'file') {
      throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined) {
        throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
      }
      if (versionOf(existing.size, existing.mtimeMs) !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    } else if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }

    const before = existing === undefined || existing.size > MAX_DIFF_BASIS_BYTES
      ? null
      : await readTextOrNull(client, path)
    await writeAtomic(client, path, content)
    signal?.throwIfAborted()
    const after = await client.files.stat(path)
    return {
      operation: existing === undefined ? 'create' : 'update',
      version: versionOf(after?.size ?? content.length, after?.mtimeMs ?? 0),
      before,
      after: normalizeLineEndings(content),
    }
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: unknown },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    signal?.throwIfAborted()
    this.assertMutable(target, sandboxPolicy)
    const client = await this.client()
    const path = this.path(target)
    const existing = await client.files.stat(path)
    if (existing === undefined) {
      throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    if (existing.type !== 'file') {
      throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    if (expected !== undefined && versionOf(existing.size, existing.mtimeMs) !== expected.version) {
      throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }

    const current = decodeText(await client.files.read(path), target.displayPath)
    const lineEnding = current.includes('\r\n') ? '\r\n' : '\n'
    const before = normalizeLineEndings(current)
    const after = applyEdit(before, edit, target.displayPath)
    await writeAtomic(client, path, lineEnding === '\r\n' ? after.replaceAll('\n', '\r\n') : after)
    signal?.throwIfAborted()
    const settled = await client.files.stat(path)
    return {
      version: versionOf(settled?.size ?? after.length, settled?.mtimeMs ?? 0),
      before,
      after,
    }
  }

  override async patchText(
    target: FsTarget,
    hunks: readonly PatchHunk[],
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    signal?.throwIfAborted()
    this.assertMutable(target, sandboxPolicy)
    const client = await this.client()
    const path = this.path(target)
    const existing = await requireFile(client, path, target.displayPath, expected)
    const current = decodeText(await client.files.read(path), target.displayPath)
    const lineEnding = current.includes('\r\n') ? '\r\n' : '\n'
    const before = normalizeLineEndings(current)
    const applied = applyHunks(before, hunks)
    if (!applied.ok) {
      throw new FsError(`cannot patch "${target.displayPath}": hunk did not match`, 'FS_PATCH_MISMATCH')
    }
    await writeAtomic(client, path, lineEnding === '\r\n' ? applied.after.replaceAll('\n', '\r\n') : applied.after)
    signal?.throwIfAborted()
    const settled = await client.files.stat(path)
    return {
      version: versionOf(settled?.size ?? applied.after.length, settled?.mtimeMs ?? 0),
      before,
      after: applied.after,
    }
  }

  override async deleteFile(
    target: FsTarget,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsDeleteOutcome> {
    signal?.throwIfAborted()
    this.assertMutable(target, sandboxPolicy)
    const client = await this.client()
    const path = this.path(target)
    const existing = await requireFile(client, path, target.displayPath, expected)
    const before = existing.size > MAX_DIFF_BASIS_BYTES ? null : await readTextOrNull(client, path)
    if (signal?.aborted) throw new FsError(`cannot delete "${target.displayPath}": aborted`, 'FS_ABORTED')
    await client.files.remove(path)
    return { before }
  }

  override async moveFile(
    source: FsTarget,
    destination: FsTarget,
    options: {
      hunks?: readonly PatchHunk[]
      expectedSource?: { version: FsVersion }
      expectedDestination?: FsWriteIntent
    },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsMoveOutcome> {
    if (String(source.targetKey) === String(destination.targetKey)) {
      throw new FsError(`cannot move "${source.displayPath}" to itself`, 'FS_SAME_TARGET')
    }
    signal?.throwIfAborted()
    this.assertMutable(source, sandboxPolicy)
    this.assertMutable(destination, sandboxPolicy)
    const client = await this.client()
    const sourcePath = this.path(source)
    await requireFile(client, sourcePath, source.displayPath, options.expectedSource)
    const current = decodeText(await client.files.read(sourcePath), source.displayPath)
    const before = normalizeLineEndings(current)
    const applied = options.hunks === undefined ? { ok: true as const, after: before } : applyHunks(before, options.hunks)
    if (!applied.ok) {
      throw new FsError(`cannot move "${source.displayPath}": hunk did not match`, 'FS_PATCH_MISMATCH')
    }
    const lineEnding = current.includes('\r\n') ? '\r\n' : '\n'
    const stored = lineEnding === '\r\n' ? applied.after.replaceAll('\n', '\r\n') : applied.after
    const destinationOutcome = await this.writeText(destination, stored, options.expectedDestination, signal)
    const sourceBefore = Buffer.byteLength(before, 'utf8') > MAX_DIFF_BASIS_BYTES ? null : before
    try {
      await client.files.remove(sourcePath)
    } catch (error) {
      if (!(error instanceof FsError)) {
        return {
          sourceBefore,
          destination: destinationOutcome,
          sourceDeleted: false,
          sourceFailure: {
            code: 'FS_IO_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
      return {
        sourceBefore,
        destination: destinationOutcome,
        sourceDeleted: false,
        sourceFailure: { code: error.code, message: error.message },
      }
    }
    return { sourceBefore, destination: destinationOutcome, sourceDeleted: true }
  }

  /**
   * Enforce the per-call file-effect policy for one mutation.
   *
   * `read-only` denies every mutation; `workspace-write` requires the VM path to
   * sit under a writable root; `danger-full-access` allows it. A missing policy
   * means an internal platform caller (upload, preview, export) rather than a
   * model tool — the VM boundary is still the tenant fence, so it passes.
   */
  private assertMutable(target: FsTarget, policy: SandboxExecutionPolicy | undefined): void {
    if (policy === undefined || policy.mode === 'danger-full-access') return
    if (policy.mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    const path = this.path(target)
    // These are VM paths. Upstream's `writableRoots` resolves them against the
    // harness host (realpath, /tmp and os.tmpdir grants), which is both blind to
    // the VM and would canonicalize a mock adapter's host-shaped root.
    const roots = [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? []), '/tmp'].map((root) => posix.resolve(root))
    for (const root of roots) {
      if (isUnder(path, root)) return
    }
    throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
  }

  /** The binding serving the initiating turn. */
  private async binding() {
    const binding = await this.ctx.sandboxes.ensureCurrent()
    if (binding === undefined) {
      throw new FsError('no sandbox for this session', 'FS_IO_ERROR')
    }
    return binding
  }

  /** The client for the initiating turn. */
  private async client() {
    return await this.ctx.sandboxes.client(await this.binding())
  }

  /** The VM-side path of a target. */
  private path(target: FsTarget): string {
    return String(target.targetKey)
  }
}

/** Require a regular file and an optional version guard. */
async function requireFile(
  client: { files: { stat(path: string): Promise<{ type: string; size: number; mtimeMs: number } | undefined> } },
  path: string,
  displayPath: string,
  expected?: { version: FsVersion },
): Promise<{ size: number; mtimeMs: number }> {
  const existing = await client.files.stat(path)
  if (existing === undefined) {
    throw new FsError(`cannot update "${displayPath}": file no longer exists`, 'FS_STALE_VERSION')
  }
  if (existing.type !== 'file') {
    throw new FsError(`cannot update "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  if (expected !== undefined && versionOf(existing.size, existing.mtimeMs) !== expected.version) {
    throw new FsError(`cannot update "${displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
  }
  return existing
}

/** Derive a version token from metadata. Platforms expose no content hash. */
function versionOf(size: number, mtimeMs: number): FsVersion {
  return FsVersion(`${size}:${Math.trunc(mtimeMs)}`)
}

/** Decode UTF-8 text, rejecting binary content. */
function decodeText(data: Uint8Array, displayPath: string): string {
  try {
    return UTF8.decode(data)
  } catch {
    throw new FsError(`"${displayPath}" is not UTF-8 text`, 'FS_NOT_TEXT')
  }
}

/** Read a file's text, or null when it is binary or unreadable. */
async function readTextOrNull(
  client: { files: { read(path: string): Promise<Uint8Array> } },
  path: string,
): Promise<string | null> {
  try {
    return normalizeLineEndings(UTF8.decode(await client.files.read(path)))
  } catch {
    return null
  }
}

/** Write atomically through a sibling temporary file. */
async function writeAtomic(
  client: {
    files: {
      write(path: string, data: Uint8Array): Promise<void>
      rename(from: string, to: string): Promise<void>
      remove(path: string): Promise<void>
    }
  },
  path: string,
  content: string,
): Promise<void> {
  const temporary = `${path}.dsh-tmp-${process.pid}-${Date.now()}`
  await client.files.write(temporary, new TextEncoder().encode(content))
  try {
    await client.files.rename(temporary, path)
  } catch (error) {
    await client.files.remove(temporary).catch(() => undefined)
    throw error
  }
}

/** LF-normalize storage text for the diff basis. */
function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

/** Whether a VM path sits at or under a writable root (both POSIX-spelled). */
function isUnder(path: string, root: string): boolean {
  const relative = posix.relative(root, path)
  return relative === '' || (!relative.startsWith('../') && relative !== '..' && !posix.isAbsolute(relative))
}

/** Apply one literal edit, enforcing uniqueness unless `replaceAll`. */
function applyEdit(text: string, edit: FsEditRequest, displayPath: string): string {
  if (edit.oldString === '') {
    throw new FsError(`cannot edit "${displayPath}": search text is empty`, 'FS_EDIT_NOT_FOUND')
  }
  const occurrences = countOccurrences(text, edit.oldString)
  if (occurrences === 0) {
    throw new FsError(`cannot edit "${displayPath}": search text not found`, 'FS_EDIT_NOT_FOUND')
  }
  if (!edit.replaceAll && occurrences > 1) {
    throw new FsError(`cannot edit "${displayPath}": search text is ambiguous (${occurrences} matches)`, 'FS_AMBIGUOUS_EDIT')
  }
  return edit.replaceAll
    ? text.split(edit.oldString).join(edit.newString)
    // A function replacement keeps `$&`-style patterns literal.
    : text.replace(edit.oldString, () => edit.newString)
}

/** Count non-overlapping occurrences without a regex. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}
