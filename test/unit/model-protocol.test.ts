import { describe, expect, it } from 'vitest'
import { providerOfApi, PROVIDER_PROTOCOLS } from '../../packages/dsh-platform-api/src/model-protocol.ts'

/**
 * 线协议 → provider 路由。
 *
 * pi-ai 的 `api` 是路由级配置，所以每种协议独占一条路由；这里钉住翻译表，
 * 以及「老平台不带请求头时仍走 `user`」这条兼容性。
 */
describe('providerOfApi', () => {
  it('四种协议各走各的路由，openai-completions 沿用历史名字 user', () => {
    expect(providerOfApi('openai-completions')).toBe('user')
    expect(providerOfApi('openai-responses')).toBe('user-openai-responses')
    expect(providerOfApi('anthropic-messages')).toBe('user-anthropic-messages')
    expect(providerOfApi('google-generative-ai')).toBe('user-google-generative-ai')
  })

  it('不带协议时按 OpenAI 兼容处理', () => {
    expect(providerOfApi(undefined)).toBe('user')
    expect(providerOfApi('')).toBe('user')
  })

  it('不认识的协议是请求方的 400，不是网络错误', () => {
    expect(() => providerOfApi('openai')).toThrowError(
      expect.objectContaining({ status: 400, code: 'model-protocol-invalid' }),
    )
  })

  it('反查表覆盖所有路由', () => {
    expect(PROVIDER_PROTOCOLS).toEqual({
      user: 'openai-completions',
      'user-openai-responses': 'openai-responses',
      'user-anthropic-messages': 'anthropic-messages',
      'user-google-generative-ai': 'google-generative-ai',
    })
  })
})
