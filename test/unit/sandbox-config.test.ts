import { describe, expect, it } from 'vitest'
import { sandboxConfigOf } from '../../packages/dsh-platform-api/src/routes.ts'

/**
 * 平台下发的运行时配置按组收：E2B 和附件 OSS 互不依赖。
 * 之前的实现要求 E2B 三元组齐全才返回整份配置，docker/mock 部署因此拿不到
 * 平台下发的 OSS，输入框里的文件和粘贴图片都会退回脑本地盘。
 */

const E2B = {
  'x-dsh-e2b-api-key': 'e2b-key',
  'x-dsh-e2b-api-url': 'https://e2b.internal',
  'x-dsh-e2b-domain': 'e2b.internal',
  'x-dsh-e2b-template': 'dsh-desk',
  'x-dsh-e2b-role-arn': 'arn:aws:iam::1:role/e2b',
}

const OSS = {
  'x-dsh-oss-bucket': 'attachments',
  'x-dsh-oss-endpoint': 'https://oss.internal',
  'x-dsh-oss-region': 'cn-hangzhou',
  'x-dsh-oss-access-key-id': 'oss-id',
  'x-dsh-oss-access-key-secret': 'oss-secret',
}

describe('sandboxConfigOf', () => {
  it('两组都齐时整份返回', () => {
    expect(sandboxConfigOf({ ...E2B, ...OSS })).toEqual({
      apiKey: 'e2b-key',
      apiUrl: 'https://e2b.internal',
      domain: 'e2b.internal',
      template: 'dsh-desk',
      roleArn: 'arn:aws:iam::1:role/e2b',
      ossBucket: 'attachments',
      ossEndpoint: 'https://oss.internal',
      ossRegion: 'cn-hangzhou',
      ossAccessKeyId: 'oss-id',
      ossAccessKeySecret: 'oss-secret',
    })
  })

  it('只有 OSS 时照样返回，且不掺入空的 E2B 字段', () => {
    expect(sandboxConfigOf(OSS)).toEqual({
      ossBucket: 'attachments',
      ossEndpoint: 'https://oss.internal',
      ossRegion: 'cn-hangzhou',
      ossAccessKeyId: 'oss-id',
      ossAccessKeySecret: 'oss-secret',
    })
  })

  it('E2B 不全但 OSS 全时只收 OSS', () => {
    const value = sandboxConfigOf({ 'x-dsh-e2b-api-key': 'only-key', ...OSS })
    expect(value?.apiKey).toBeUndefined()
    expect(value?.ossBucket).toBe('attachments')
  })

  it('OSS 不全但 E2B 全时只收 E2B', () => {
    const value = sandboxConfigOf({ ...E2B, 'x-dsh-oss-bucket': 'attachments' })
    expect(value?.apiKey).toBe('e2b-key')
    expect(value?.ossBucket).toBeUndefined()
  })

  it('两组都不全或都没有时返回 undefined', () => {
    expect(sandboxConfigOf({})).toBeUndefined()
    expect(sandboxConfigOf({ 'x-dsh-e2b-api-key': 'k', 'x-dsh-oss-bucket': 'b' })).toBeUndefined()
  })

  it('请求头数组取第一个并去掉两边空白', () => {
    const value = sandboxConfigOf({
      ...OSS,
      'x-dsh-oss-bucket': [' attachments ', 'other'],
      'x-dsh-oss-endpoint': ' https://oss.internal ',
    })
    expect(value?.ossBucket).toBe('attachments')
    expect(value?.ossEndpoint).toBe('https://oss.internal')
  })
})
