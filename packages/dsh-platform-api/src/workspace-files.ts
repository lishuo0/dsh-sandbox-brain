/**
 * Workspace files for the official sidebar.
 *
 * The dashboard's session cwd is the synthetic alias `/workspace-<id>`, not the
 * sandbox root. Listing, reading, and upload all accept that alias, a relative
 * path, or a real absolute path, and every one of them has to stay inside the
 * session sandbox.
 *
 * @module @brain/dsh-platform-api/workspace-files
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HttpError, query, sendJson } from './http.ts'

/** Whole-file cap for a text preview. Larger files are refused, not sliced. */
const MAX_TEXT_BYTES = 8 * 1024 * 1024
/** Whole-file cap for a binary preview (images, PDF). */
const MAX_BINARY_BYTES = 16 * 1024 * 1024
/** One upload. Matches the platform body limit. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024
/** Direct children returned from one directory. */
const MAX_ENTRIES = 1000
/** Lines on one text page when the caller does not ask. */
const DEFAULT_LINE_LIMIT = 400
/** Hard cap on one text page. */
const MAX_LINE_LIMIT = 2000

interface SandboxDirEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'symlink' | 'other'
  readonly size?: number
}

interface SandboxFileStat {
  readonly path: string
  readonly type: 'file' | 'directory' | 'symlink' | 'other'
  readonly size: number
  readonly mtimeMs: number
  readonly version?: string
}

interface SandboxFiles {
  read(path: string): Promise<Uint8Array>
  write(path: string, data: Uint8Array): Promise<void>
  list(path: string): Promise<SandboxDirEntry[]>
  stat(path: string): Promise<SandboxFileStat | undefined>
}

interface SandboxBinding {
  readonly workspaceRoot: string
}

interface Sandboxes {
  ensure(sessionId: string): Promise<SandboxBinding>
  client(binding: SandboxBinding): Promise<{ files: SandboxFiles }>
}

/**
 * Map a client path onto the sandbox workspace.
 *
 * `/workspace-<id>` and everything under it land on `root`. A relative path is
 * resolved from `root`. Anything that normalizes outside `root` is refused.
 *
 * @param root - absolute sandbox workspace root.
 * @param workspaceId - owner workspace, used only for the synthetic alias.
 * @param requested - path from the official sidebar.
 * @returns the absolute sandbox path.
 */
export function resolveWorkspaceFile(root: string, workspaceId: string, requested: string): string {
  const base = stripTrailingSlash(root)
  if (base === '' || !base.startsWith('/')) {
    throw new HttpError(500, 'internal', 'workspace root is not absolute')
  }
  const alias = workspaceId === '' ? '' : `/workspace-${workspaceId}`
  let raw = requested.trim()
  if (raw === '') raw = alias !== '' ? alias : base
  let absolute: string
  if (alias !== '' && (raw === alias || raw.startsWith(`${alias}/`))) {
    const rest = raw.slice(alias.length)
    absolute = posix.resolve(base, rest === '' ? '.' : rest.slice(1))
  } else if (raw.startsWith('/')) {
    absolute = posix.resolve(raw)
  } else {
    absolute = posix.resolve(base, raw)
  }
  if (absolute !== base && !absolute.startsWith(`${base}/`)) {
    throw new HttpError(403, 'workspace-file/outside-workspace', 'path escapes the workspace')
  }
  return absolute
}

/**
 * Refuse a path that reaches its target through a symlink.
 *
 * `resolveWorkspaceFile` only normalizes the text. A link inside the workspace
 * can still point at `/etc` or another workspace, and the sandbox follows it
 * on read. The preview never needs to follow links, so any symlink component
 * stops the request.
 *
 * @param root - absolute sandbox workspace root.
 * @param absolute - path already confined by {@link resolveWorkspaceFile}.
 * @param stat - sandbox stat. A symlink must come back as `type: 'symlink'`.
 */
export async function refuseWorkspaceSymlink(
  root: string,
  absolute: string,
  stat: (path: string) => Promise<{ type: string } | undefined>,
): Promise<void> {
  const base = stripTrailingSlash(root)
  if (absolute !== base && !absolute.startsWith(`${base}/`)) {
    throw new HttpError(403, 'workspace-file/outside-workspace', 'path escapes the workspace')
  }
  if (absolute === base) return
  const parts = absolute.slice(base.length + 1).split('/')
  let current = base
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') {
      throw new HttpError(403, 'workspace-file/outside-workspace', 'path escapes the workspace')
    }
    current = `${current}/${part}`
    const info = await stat(current)
    if (info === undefined) return
    if (info.type === 'symlink') {
      throw new HttpError(403, 'workspace-file/outside-workspace', 'symlink escapes the workspace')
    }
  }
}

/** Resolve a client path and refuse one that steps through a symlink. */
async function locateWorkspaceFile(
  files: SandboxFiles,
  root: string,
  workspaceId: string,
  requested: string,
): Promise<string> {
  const absolute = resolveWorkspaceFile(root, workspaceId, requested)
  await refuseWorkspaceSymlink(root, absolute, path => files.stat(path))
  return absolute
}

/**
 * Path the official client should keep using.
 *
 * An absolute request is returned normalized when it already uses the alias or
 * the sandbox root. A relative request is answered as the alias, so the file
 * tree's addresses stay stable.
 */
function clientPath(requested: string, workspaceId: string, root: string, absolute: string): string {
  const trimmed = requested.trim()
  if (trimmed.startsWith('/')) {
    const normalized = posix.normalize(trimmed)
    const alias = workspaceId === '' ? '' : `/workspace-${workspaceId}`
    if (alias !== '' && (normalized === alias || normalized.startsWith(`${alias}/`))) return normalized.endsWith('/') && normalized !== '/'
      ? normalized.slice(0, -1)
      : normalized
    if (normalized === absolute || normalized.startsWith(`${stripTrailingSlash(root)}/`)) return absolute
  }
  const base = stripTrailingSlash(root)
  const relative = absolute === base ? '' : absolute.slice(base.length + 1)
  if (workspaceId === '') return absolute
  const alias = `/workspace-${workspaceId}`
  return relative === '' ? alias : `${alias}/${relative}`
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

function versionOf(stat: SandboxFileStat): string {
  return stat.version ?? `${stat.mtimeMs}:${stat.size}`
}

function integerQuery(req: IncomingMessage, name: string): number | undefined {
  const raw = query(req.url ?? '/', name)
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new HttpError(400, 'invalid-path', `${name} must be a non-negative integer`)
  }
  return value
}

async function workspaceIdOf(ctx: Context, req: IncomingMessage, sessionId: string): Promise<string> {
  const header = req.headers['x-dsh-workspace-id']
  const fromHeader = Array.isArray(header) ? header[0] : header
  if (typeof fromHeader === 'string' && fromHeader.trim() !== '') return fromHeader.trim()
  const directory = ctx.get('sessionDirectory') as {
    owner?: (id: string) => Promise<{ workspaceId?: string } | undefined>
  } | undefined
  const owner = await directory?.owner?.(sessionId)
  return owner?.workspaceId?.trim() ?? ''
}

async function openFiles(ctx: Context, sessionId: string): Promise<{ root: string; files: SandboxFiles }> {
  const sandboxes = ctx.get('sandboxes') as Sandboxes | undefined
  if (sandboxes === undefined) {
    throw new HttpError(501, 'not-supported', 'workspace files are not available on this deployment')
  }
  let binding: SandboxBinding
  try {
    binding = await sandboxes.ensure(sessionId)
  } catch (error) {
    ctx.logger?.warn?.(`platform-api: workspace files unavailable for "${sessionId}": ${error instanceof Error ? error.message : String(error)}`)
    throw new HttpError(503, 'workspace-file/unavailable', 'workspace is not available')
  }
  const client = await sandboxes.client(binding)
  return { root: binding.workspaceRoot, files: client.files }
}

async function statFile(files: SandboxFiles, absolute: string): Promise<SandboxFileStat> {
  const stat = await files.stat(absolute)
  if (stat === undefined) {
    throw new HttpError(404, 'workspace-file/not-found', 'not found')
  }
  return stat
}

function entryType(type: SandboxDirEntry['type']): 'file' | 'directory' | 'other' {
  if (type === 'file' || type === 'directory') return type
  return 'other'
}

async function listDirectory(
  files: SandboxFiles,
  root: string,
  absolute: string,
): Promise<{ path: string; entries: Array<{ name: string; type: 'file' | 'directory' | 'other'; size?: number }>; truncated: boolean }> {
  const stat = await statFile(files, absolute)
  if (stat.type !== 'directory') {
    throw new HttpError(400, 'workspace-file/not-directory', 'not a directory')
  }
  const children = await files.list(absolute)
  const entries = children
    .filter(entry => entry.name !== '' && entry.name !== '.' && entry.name !== '..' && !entry.name.includes('/') && !entry.name.includes('\\'))
    .sort((a, b) => a.name.localeCompare(b.name))
  const truncated = entries.length > MAX_ENTRIES
  const page = truncated ? entries.slice(0, MAX_ENTRIES) : entries
  const base = stripTrailingSlash(root)
  const relative = absolute === base ? '' : absolute.slice(base.length + 1)
  return {
    path: relative,
    truncated,
    entries: page.map(entry => ({
      name: entry.name,
      type: entryType(entry.type),
      ...(entry.type === 'file' && entry.size !== undefined ? { size: entry.size } : {}),
    })),
  }
}

async function readBytes(files: SandboxFiles, absolute: string, cap: number): Promise<{ stat: SandboxFileStat; data: Uint8Array }> {
  const stat = await statFile(files, absolute)
  if (stat.type !== 'file') {
    throw new HttpError(400, 'workspace-file/not-regular-file', 'not a regular file')
  }
  if (stat.size > cap) {
    throw new HttpError(413, 'workspace-file/too-large', 'file exceeds the preview cap')
  }
  const data = await files.read(absolute)
  if (data.byteLength > cap) {
    throw new HttpError(413, 'workspace-file/too-large', 'file exceeds the preview cap')
  }
  return { stat, data }
}

function textPage(data: Uint8Array, offset: number, limit: number): { text: string; lines: number; eof: boolean } {
  if (data.includes(0)) {
    throw new HttpError(415, 'workspace-file/not-text', 'file is not text')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    throw new HttpError(415, 'workspace-file/not-text', 'file is not text')
  }
  const rows = text.split('\n')
  if (text.endsWith('\n')) rows.pop()
  const start = Math.max(0, offset - 1)
  const page = rows.slice(start, start + limit)
  return {
    text: page.join('\n'),
    lines: page.length,
    eof: start >= rows.length || start + page.length >= rows.length,
  }
}

function singleName(raw: string | undefined): string {
  const name = raw?.trim() ?? ''
  if (
    name === ''
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || name.includes('\0')
    || name.length > 255
  ) {
    throw new HttpError(400, 'invalid-name', 'file name must be a single path segment')
  }
  return name
}

async function readUpload(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.byteLength
    if (total > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, 'workspace-file/too-large', 'upload exceeds the size cap')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * Serve list, read, and upload under `/brain/v1/sessions/{id}/workspace-files`.
 * Ownership of the session has already been asserted by the route.
 */
export async function handleWorkspaceFiles(
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  subaction: string | undefined,
  extra: string | undefined,
): Promise<void> {
  if (extra !== undefined) {
    throw new HttpError(404, 'not-found', 'unknown route')
  }
  const workspaceId = await workspaceIdOf(ctx, req, sessionId)
  const { root, files } = await openFiles(ctx, sessionId)
  const requested = query(req.url ?? '/', 'path') ?? ''
  const locate = (path: string) => locateWorkspaceFile(files, root, workspaceId, path)

  if (subaction === undefined) {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'use GET')
    const absolute = await locate(requested)
    sendJson(res, 200, await listDirectory(files, root, absolute))
    return
  }

  if (subaction === 'content') {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'use GET')
    if (requested.trim() === '') throw new HttpError(400, 'invalid-path', 'path is required')
    const baseFile = query(req.url ?? '/', 'baseFile')
    const target = baseFile !== undefined && baseFile !== '' && !requested.startsWith('/')
      ? await locate(posix.join(posix.dirname(await locate(baseFile)), requested))
      : await locate(requested)
    const binary = query(req.url ?? '/', 'bytes') === '1'
    if (binary) {
      const offset = integerQuery(req, 'offset') ?? 0
      const length = integerQuery(req, 'length')
      const { stat, data } = await readBytes(files, target, MAX_BINARY_BYTES)
      const start = Math.min(offset, data.byteLength)
      const end = length === undefined ? data.byteLength : Math.min(data.byteLength, start + length)
      const slice = data.subarray(start, end)
      sendJson(res, 200, {
        absolutePath: clientPath(requested, workspaceId, root, target),
        version: versionOf(stat),
        bytes: stat.size,
        offset: start,
        data: Buffer.from(slice).toString('base64'),
        eof: end >= data.byteLength,
      })
      return
    }
    const offset = integerQuery(req, 'offset') ?? 1
    const limit = Math.min(integerQuery(req, 'limit') ?? DEFAULT_LINE_LIMIT, MAX_LINE_LIMIT)
    const { stat, data } = await readBytes(files, target, MAX_TEXT_BYTES)
    const page = textPage(data, offset === 0 ? 1 : offset, limit)
    sendJson(res, 200, {
      absolutePath: clientPath(requested, workspaceId, root, target),
      version: versionOf(stat),
      bytes: stat.size,
      offset: offset === 0 ? 1 : offset,
      ...page,
    })
    return
  }

  if (subaction === 'stat') {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'use GET')
    if (requested.trim() === '') throw new HttpError(400, 'invalid-path', 'path is required')
    const absolute = await locate(requested)
    const stat = await statFile(files, absolute)
    sendJson(res, 200, {
      absolutePath: clientPath(requested, workspaceId, root, absolute),
      version: versionOf(stat),
      ...(stat.type === 'file' ? { bytes: stat.size } : {}),
    })
    return
  }

  if (subaction === 'upload') {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'use POST')
    const name = singleName(query(req.url ?? '/', 'name'))
    const directory = await locate(requested)
    const dirStat = await statFile(files, directory)
    if (dirStat.type !== 'directory') {
      throw new HttpError(400, 'workspace-file/not-directory', 'upload target is not a directory')
    }
    const destination = await locate(posix.join(directory, name))
    const body = await readUpload(req)
    await files.write(destination, body)
    sendJson(res, 200, {
      name,
      path: clientPath(posix.join(requested, name), workspaceId, root, destination),
      bytes: body.byteLength,
    })
    return
  }

  throw new HttpError(404, 'not-found', 'unknown route')
}
