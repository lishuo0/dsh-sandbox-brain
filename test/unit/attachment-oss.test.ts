import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OssAttachmentStore, {
  FILE_OBJECT_PREFIX,
  OBJECT_PREFIX,
} from '../../packages/dsh-attachment-oss/src/index.ts'
import { testContext } from '../helpers/brain.ts'

/**
 * OSS 附件存储：内容寻址、前缀布局、平台下发配置与本地回退。
 *
 * ali-oss 被替换成内存实现——只验本仓库自己的落点/读回/校验逻辑，不碰网络。
 */

interface OSSState {
  readonly objects: Map<string, Buffer>
  readonly puts: Array<{ key: string; mime?: string }>
  readonly configs: Array<Record<string, unknown>>
}

const ossState = vi.hoisted<OSSState>(() => ({ objects: new Map(), puts: [], configs: [] }))

vi.mock('ali-oss', () => {
  class FakeOss {
    constructor(options: Record<string, unknown>) {
      ossState.configs.push(options)
    }

    async put(key: string, data: Buffer, options?: { mime?: string }): Promise<void> {
      ossState.puts.push({ key, ...(options?.mime === undefined ? {} : { mime: options.mime }) })
      ossState.objects.set(key, Buffer.from(data))
    }

    async get(key: string): Promise<{ content: Buffer }> {
      const content = ossState.objects.get(key)
      if (content === undefined) {
        throw Object.assign(new Error('NoSuchKey'), { status: 404, code: 'NoSuchKey' })
      }
      return { content }
    }
  }
  return { default: FakeOss }
})

/** 1x1 PNG，足够走完整的解码/归一化流程。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const OSS_CONFIG = {
  ossBucket: 'attachments',
  ossEndpoint: 'https://oss.internal.example.com',
  ossRegion: 'cn-hangzhou',
  ossAccessKeyId: 'key-id',
  ossAccessKeySecret: 'key-secret',
}

let homeDir: string
const savedEnv: Record<string, string | undefined> = {}

function store(options: { runtime?: Record<string, string>; sandboxConfig?: unknown } = {}) {
  const services: Record<string, unknown> = {}
  if (options.sandboxConfig !== undefined) services.sandboxConfig = options.sandboxConfig
  const ctx = testContext(services)
  return new OssAttachmentStore(ctx, { dshHome: homeDir })
}

function withSandboxConfig(config: Record<string, string>) {
  return { get: () => config }
}

beforeEach(async () => {
  ossState.objects.clear()
  ossState.puts.length = 0
  ossState.configs.length = 0
  homeDir = await mkdtemp(join(tmpdir(), 'dsh-attachment-home-'))
  for (const name of ['OSS_BUCKET', 'OSS_ENDPOINT', 'OSS_REGION', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET']) {
    savedEnv[name] = process.env[name]
    delete process.env[name]
  }
})

afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(homeDir, { recursive: true, force: true })
})

describe('attachment-oss：文件对象', () => {
  it('用平台下发的配置落 OSS，key 是附件前缀 + sha256', async () => {
    const attachments = store({ sandboxConfig: withSandboxConfig(OSS_CONFIG) })
    const data = Buffer.from('hello 附件')
    const ref = await attachments.saveFile({ data, name: '../../evil?.txt' })

    expect(ref.name).toBe('evil_.txt')
    expect(ref.bytes).toBe(data.byteLength)
    const digest = ref.attachmentId.slice('sha256:'.length)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(ossState.puts.map((put) => put.key)).toEqual([`${FILE_OBJECT_PREFIX}/${digest}`])
    expect(ossState.objects.get(`${FILE_OBJECT_PREFIX}/${digest}`)?.toString()).toBe('hello 附件')

    // 客户端按 endpoint 去协议、按 https 置 secure、带 region。
    expect(ossState.configs[0]).toMatchObject({
      bucket: 'attachments',
      endpoint: 'oss.internal.example.com',
      region: 'cn-hangzhou',
      secure: true,
    })
  })

  it('readFileStream 从同一 key 读回', async () => {
    const attachments = store({ sandboxConfig: withSandboxConfig(OSS_CONFIG) })
    const ref = await attachments.saveFile({ data: Buffer.from('stream me'), name: 'note.txt' })
    const chunks: Uint8Array[] = []
    for await (const chunk of attachments.readFileStream(ref)) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString()).toBe('stream me')
  })

  it('流式保存走同一个内容寻址落点', async () => {
    const attachments = store({ sandboxConfig: withSandboxConfig(OSS_CONFIG) })
    async function* source() {
      yield Buffer.from('ab')
      yield Buffer.from('cd')
    }
    const ref = await attachments.saveFileStream({ data: source(), name: 's.txt' })
    expect(ref.bytes).toBe(4)
    expect(ossState.objects.get(`${FILE_OBJECT_PREFIX}/${ref.attachmentId.slice(7)}`)?.toString()).toBe('abcd')
  })

  it('对象缺失时读回报 ATTACHMENT_NOT_FOUND', async () => {
    const attachments = store({ sandboxConfig: withSandboxConfig(OSS_CONFIG) })
    const ref = await attachments.saveFile({ data: Buffer.from('x'), name: 'x.txt' })
    ossState.objects.clear()
    await expect(attachments.readFileStream(ref).next()).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
  })
})

describe('attachment-oss：图片对象', () => {
  it('saveImage 发布归一化后的字节，readImage 校验元数据后读回', async () => {
    const attachments = store({ sandboxConfig: withSandboxConfig(OSS_CONFIG) })
    const ref = await attachments.saveImage({ data: PNG, mediaType: 'image/png', name: 'pixel.png' })

    const digest = ref.attachmentId.slice('sha256:'.length)
    const key = `${OBJECT_PREFIX}/${digest.slice(0, 2)}/${digest}`
    expect(ossState.puts.map((put) => put.key)).toContain(key)
    expect(ossState.puts.find((put) => put.key === key)?.mime).toBe(ref.mediaType)

    const read = await attachments.readImage(ref)
    expect(read.ref).toEqual(ref)
    expect(Buffer.from(read.data).equals(ossState.objects.get(key)!)).toBe(true)
  })

  it('引用元数据与重新解码结果不一致时按损坏拒绝', async () => {
    const attachments = store({ sandboxConfig: withSandboxConfig(OSS_CONFIG) })
    const ref = await attachments.saveImage({ data: PNG, mediaType: 'image/png' })

    // 存储的字节仍合法；只把引用里的字节数改掉，必须被对账拦住。
    await expect(attachments.readImage({ ...ref, bytes: ref.bytes + 1 })).rejects.toMatchObject({
      code: 'ATTACHMENT_CORRUPT',
    })
  })

  it('imageHostPath / fileHostPath 不暴露脑宿主路径', () => {
    const attachments = store({ sandboxConfig: withSandboxConfig(OSS_CONFIG) })
    expect(attachments.imageHostPath()).toBeUndefined()
    expect(attachments.fileHostPath()).toBeUndefined()
  })
})

describe('attachment-oss：配置来源与回退', () => {
  it('平台配置缺密钥时视为未配置，退回本地存储（不写 OSS）', async () => {
    const attachments = store({
      sandboxConfig: withSandboxConfig({ ossBucket: 'b', ossEndpoint: 'https://e', ossAccessKeyId: '', ossAccessKeySecret: '' }),
    })
    const ref = await attachments.saveFile({ data: Buffer.from('local'), name: 'local.txt' })
    expect(ossState.puts).toHaveLength(0)
    const chunks: Uint8Array[] = []
    for await (const chunk of attachments.readFileStream(ref)) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString()).toBe('local')
  })

  it('没有平台配置时用部署环境变量', async () => {
    process.env.OSS_BUCKET = 'env-bucket'
    process.env.OSS_ENDPOINT = 'oss.env.example.com'
    process.env.OSS_ACCESS_KEY_ID = 'env-id'
    process.env.OSS_ACCESS_KEY_SECRET = 'env-secret'
    const attachments = store()
    const ref = await attachments.saveFile({ data: Buffer.from('env'), name: 'e.txt' })

    expect(ossState.configs[0]).toMatchObject({ bucket: 'env-bucket', endpoint: 'oss.env.example.com', secure: false })
    expect(ossState.puts.map((put) => put.key)).toEqual([`${FILE_OBJECT_PREFIX}/${ref.attachmentId.slice(7)}`])
  })

  it('平台下发的配置优先于环境变量', async () => {
    process.env.OSS_BUCKET = 'env-bucket'
    process.env.OSS_ENDPOINT = 'oss.env.example.com'
    process.env.OSS_ACCESS_KEY_ID = 'env-id'
    process.env.OSS_ACCESS_KEY_SECRET = 'env-secret'
    const attachments = store({ sandboxConfig: withSandboxConfig(OSS_CONFIG) })
    await attachments.saveFile({ data: Buffer.from('x'), name: 'x.txt' })
    expect(ossState.configs[0]?.bucket).toBe('attachments')
  })

  it('同一内容多次保存共享一个对象（内容寻址）', async () => {
    const attachments = store({ sandboxConfig: withSandboxConfig(OSS_CONFIG) })
    const first = await attachments.saveFile({ data: Buffer.from('same'), name: 'a.txt' })
    const second = await attachments.saveFile({ data: Buffer.from('same'), name: 'b.txt' })

    expect(first.attachmentId).toBe(second.attachmentId)
    expect(ossState.objects.size).toBe(1)
  })
})
