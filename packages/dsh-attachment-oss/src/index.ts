/**
 * OSS-backed DSH attachment store.
 *
 * The brain runs as several replicas. `attachment-local` keeps normalized
 * images below `DSH_HOME/attachments/v1`, which is replica-local: a session
 * resumed on another replica cannot resolve an image block written by the
 * previous one. This store keeps the same content-addressed attachment ids and
 * normalization rules, but publishes normalized images to the deployment's OSS
 * bucket. The platform reads the same objects for the browser preview.
 *
 * The storage credentials arrive from the platform on create/resume through
 * `x-dsh-oss-*`; the local backend remains as a read-only fallback for
 * attachments written before this plugin was introduced.
 *
 * @module @brain/dsh-attachment-oss
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  AttachmentError,
  type FileAttachmentRef,
  type ImageAttachmentRef,
  type ImageRequestTarget,
  type RequestImageAttachment,
  type SaveFileAttachment,
  type SaveFileStreamAttachment,
  type SaveImageAttachment,
  type StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import {
  LocalAttachmentStore,
  prepareImageFile,
  type Config as LocalConfig,
} from '@deepseek-ai/dsh-attachment-local'
import OSS from 'ali-oss'

/** Prefix shared with the platform attachment reader. */
export const OBJECT_PREFIX = 'attachments/v1/objects'

/** Prefix for verbatim (non-image) files. */
export const FILE_OBJECT_PREFIX = 'attachments/v1/file-objects'

/** OSS values supplied by the platform on create/resume. */
interface OssRuntimeConfig {
  readonly ossBucket?: string
  readonly ossEndpoint?: string
  readonly ossRegion?: string
  readonly ossAccessKeyId?: string
  readonly ossAccessKeySecret?: string
}

interface OssClientOptions {
  readonly bucket: string
  readonly endpoint: string
  readonly region?: string
  readonly accessKeyId: string
  readonly accessKeySecret: string
}

/** Normalize an OSS endpoint for ali-oss. */
function endpointOf(value: string): string {
  return value.trim().replace(/^https?:\/\//u, '').replace(/\/+$/u, '')
}

/** Extract the digest from a content-addressed image reference. */
function imageDigest(ref: ImageAttachmentRef): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(String(ref.attachmentId))
  if (match?.[1] === undefined) {
    throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  }
  return match[1]
}

/** Extract the digest from a content-addressed file reference. */
function fileDigest(ref: FileAttachmentRef): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(String(ref.attachmentId))
  if (match?.[1] === undefined || ref.name === '') {
    throw new AttachmentError('File attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  }
  return match[1]
}

/** Sanitize a display name into a safe object leaf. */
function fileName(value: string | undefined): string {
  const leaf = (value ?? 'file').replace(/\\/gu, '/').split('/').at(-1) ?? 'file'
  const clean = leaf.replace(/[\u0000-\u001f\u007f<>:"|?*]/gu, '_').trim().replace(/[. ]+$/u, '')
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean.slice(0, 255)
}

/** Digest one byte buffer. */
function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** OSS attachment store. */
export default class OssAttachmentStore extends LocalAttachmentStore {
  static override readonly Config = LocalAttachmentStore.Config

  private client: OSS | undefined
  private clientKey = ''

  constructor(ctx: Context, config: LocalConfig = {}) {
    super(ctx, {
      ...config,
      // `DSH_HOME` is still used for the derived request-image cache. It is a
      // cache, not the durable attachment store.
      dshHome: config.dshHome ?? '/data',
    })
  }

  /** OSS configuration from the platform header, or from this deployment's env. */
  private runtime(): OssRuntimeConfig | undefined {
    const supplied = (this.ctx.get('sandboxConfig') as
      | { get(): OssRuntimeConfig | undefined }
      | undefined)?.get()
    if (supplied !== undefined && (supplied.ossBucket?.trim() ?? '') !== '') return supplied
    const bucket = process.env.OSS_BUCKET?.trim() ?? ''
    const endpoint = process.env.OSS_ENDPOINT?.trim() ?? ''
    if (bucket === '' || endpoint === '') return supplied
    return {
      ossBucket: bucket,
      ossEndpoint: endpoint,
      ossRegion: process.env.OSS_REGION,
      ossAccessKeyId: process.env.OSS_ACCESS_KEY_ID,
      ossAccessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    }
  }

  /** Whether OSS is configured for this replica. */
  private configured(runtime = this.runtime()): boolean {
    return (
      (runtime?.ossBucket?.trim() ?? '') !== '' &&
      (runtime?.ossEndpoint?.trim() ?? '') !== '' &&
      (runtime?.ossAccessKeyId?.trim() ?? '') !== '' &&
      (runtime?.ossAccessKeySecret?.trim() ?? '') !== ''
    )
  }

  /** Resolve the platform-supplied OSS configuration on use. */
  private oss(): OSS {
    const runtime = this.runtime()
    const bucket = runtime?.ossBucket?.trim() ?? ''
    const rawEndpoint = runtime?.ossEndpoint?.trim() ?? ''
    const secure = rawEndpoint.startsWith('https://')
    const endpoint = endpointOf(rawEndpoint)
    const accessKeyId = runtime?.ossAccessKeyId?.trim() ?? ''
    const accessKeySecret = runtime?.ossAccessKeySecret?.trim() ?? ''
    if (!this.configured(runtime)) {
      throw new AttachmentError('OSS attachment storage is not configured.', 'ATTACHMENT_WRITE_FAILED')
    }
    const key = JSON.stringify([bucket, endpoint, runtime?.ossRegion ?? '', accessKeyId])
    if (this.client === undefined || this.clientKey !== key) {
      this.client = new OSS({
        bucket,
        endpoint,
        ...(runtime?.ossRegion === undefined || runtime.ossRegion.trim() === ''
          ? {}
          : { region: runtime.ossRegion.trim() }),
        accessKeyId,
        accessKeySecret,
        secure,
      })
      this.clientKey = key
    }
    return this.client
  }

  /** Put one immutable object. */
  private async put(key: string, data: Uint8Array, mediaType?: string): Promise<void> {
    try {
      await this.oss().put(key, Buffer.from(data), mediaType === undefined ? {} : { mime: mediaType })
    } catch (error) {
      throw new AttachmentError('Unable to write attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
    }
  }

  /** Get one immutable object. */
  private async get(key: string): Promise<Uint8Array> {
    try {
      const result = await this.oss().get(key)
      return new Uint8Array(result.content)
    } catch (error) {
      const status = (error as { status?: unknown }).status
      const code = (error as { code?: unknown }).code
      if (status === 404 || code === 'NoSuchKey' || code === 'NoSuchObject') {
        throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
      }
      throw new AttachmentError('Unable to read image attachment.', 'ATTACHMENT_READ_FAILED', { cause: error })
    }
  }

  /** Publish one normalized image and return its durable reference. */
  override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    if (!this.configured()) return await super.saveImage(input)
    const prepared = await prepareImageFile(input, this.imageLimits, this.normalizationPolicy)
    const digest = imageDigest(prepared.ref)
    await this.put(`${OBJECT_PREFIX}/${digest.slice(0, 2)}/${digest}`, prepared.data, prepared.ref.mediaType)
    return prepared.ref
  }

  /** Publish one normalized image batch. */
  override async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> {
    if (!this.configured()) return await super.saveImages(inputs)
    const prepared = await Promise.all(
      inputs.map(input => prepareImageFile(input, this.imageLimits, this.normalizationPolicy)),
    )
    const refs: ImageAttachmentRef[] = []
    for (const image of prepared) {
      const digest = imageDigest(image.ref)
      await this.put(`${OBJECT_PREFIX}/${digest.slice(0, 2)}/${digest}`, image.data, image.ref.mediaType)
      refs.push(image.ref)
    }
    return refs
  }

  /** Read and verify one normalized image, falling back to the old local store. */
  override async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    if (!this.configured()) return await super.readImage(ref, signal)
    signal?.throwIfAborted()
    // Animated GIFs are stored verbatim (file-objects) because normalization
    // would collapse them to a single frame. Model-request projection later
    // converts this first frame as usual.
    if (ref.mediaType === 'image/gif') {
      const digest = imageDigest(ref)
      try {
        const data = await this.get(`${FILE_OBJECT_PREFIX}/${digest}`)
        if (sha256(data) !== digest) {
          throw new AttachmentError('Stored GIF attachment does not match its reference.', 'ATTACHMENT_CORRUPT')
        }
        return { ref, data }
      } catch (error) {
        if (!(error instanceof AttachmentError) || error.code !== 'ATTACHMENT_NOT_FOUND') throw error
      }
    }
    let data: Uint8Array
    try {
      const digest = imageDigest(ref)
      data = await this.get(`${OBJECT_PREFIX}/${digest.slice(0, 2)}/${digest}`)
    } catch (error) {
      if (!(error instanceof AttachmentError) || error.code !== 'ATTACHMENT_NOT_FOUND') throw error
      // Transitional read path: attachments written before the OSS migration
      // still live on the replica that wrote them.
      try {
        return await super.readImage(ref, signal)
      } catch {
        throw error
      }
    }
    const prepared = await prepareImageFile(
      {
        data,
        mediaType: ref.mediaType,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      },
      this.imageLimits,
      this.normalizationPolicy,
    )
    if (
      prepared.ref.attachmentId !== ref.attachmentId ||
      prepared.ref.mediaType !== ref.mediaType ||
      prepared.ref.bytes !== ref.bytes ||
      prepared.ref.width !== ref.width ||
      prepared.ref.height !== ref.height
    ) {
      throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
    }
    return { ref, data }
  }

  /** OSS objects have no brain-host path; the seam allows undefined. */
  override imageHostPath(): string {
    return undefined as unknown as string
  }

  /** Generate a model-request variant through the local bounded cache. */
  override async readImageRequest(
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    return await super.readImageRequest(ref, target, signal)
  }

  /** Store one verbatim file in OSS. */
  override async saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    if (!this.configured()) return await super.saveFile(input)
    const name = fileName(input.name)
    const digest = sha256(input.data)
    await this.put(`${FILE_OBJECT_PREFIX}/${digest}`, input.data)
    return {
      attachmentId: `sha256:${digest}` as FileAttachmentRef['attachmentId'],
      name,
      bytes: input.data.byteLength,
    }
  }

  /** Collect a bounded producer and store it. This is only used for explicit files. */
  override async saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
    const chunks: Uint8Array[] = []
    for await (const chunk of input.data) {
      input.signal?.throwIfAborted()
      chunks.push(chunk)
    }
    return await this.saveFile({ data: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))), ...(input.name === undefined ? {} : { name: input.name }) })
  }

  /** Read one verbatim file as one chunk. */
  override async *readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    if (!this.configured()) {
      yield* super.readFileStream(ref, signal)
      return
    }
    signal?.throwIfAborted()
    yield await this.get(`${FILE_OBJECT_PREFIX}/${fileDigest(ref)}`)
  }

  /** OSS objects have no brain-host path; the seam allows undefined. */
  override fileHostPath(): string {
    return undefined as unknown as string
  }
}

