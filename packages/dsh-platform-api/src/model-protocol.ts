/**
 * 线协议 → pi-ai provider 路由名。
 *
 * pi-ai 的 `api` 是路由级配置：一条路由只能说一种线协议，所以每种协议
 * 在 `llm-pi-ai` 里单独占一条路由。平台在 `x-dsh-model-api` 里下发成员
 * 选的协议，脑只在这里翻译成路由名，别处不再猜协议。
 *
 * `openai-completions` 沿用历史路由名 `user`，老平台不带这个头时行为不变。
 *
 * @module @brain/dsh-platform-api/model-protocol
 */

import { HttpError } from './http.ts'

/** 协议标识符 → provider 路由名。 */
const PROTOCOL_PROVIDERS: Readonly<Record<string, string>> = {
  'openai-completions': 'user',
  'openai-responses': 'user-openai-responses',
  'anthropic-messages': 'user-anthropic-messages',
  'google-generative-ai': 'user-google-generative-ai',
}

/** 每条路由的协议；`user` 是 openai-completions 的历史名字。 */
export const PROVIDER_PROTOCOLS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PROTOCOL_PROVIDERS).map(([protocol, provider]) => [provider, protocol]),
)

/**
 * 本次请求该用哪条 provider 路由。
 * @param api - 平台下发的协议标识符；缺省按 OpenAI 兼容处理。
 * @returns provider 路由名。
 * @throws {HttpError} 400 `model-protocol-invalid`，协议不认识。
 */
export function providerOfApi(api: string | undefined): string {
  if (api === undefined || api === '') return 'user'
  const provider = PROTOCOL_PROVIDERS[api]
  if (provider === undefined) {
    throw new HttpError(400, 'model-protocol-invalid', `unknown model protocol "${api}"`)
  }
  return provider
}
