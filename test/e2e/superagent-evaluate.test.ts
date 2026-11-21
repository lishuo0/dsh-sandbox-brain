import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import SessionCredentialProvider from '@brain/dsh-credentials-session'
import { apply } from '../../packages/dsh-platform-api/src/index.ts'
import {
  call,
  FakeWebServer,
  startBrainServer,
  testContext,
  type BrainServer,
} from '../helpers/brain.ts'

/**
 * 接单评估的全链路：真实 `apply()` + 真实 HTTP + 真实上游。
 *
 * 上方单元测试只验「请求作用域里能读到密钥和端点」；这里验的是**装配**：
 * 模型运行时发出的哨兵域名请求，被改写到本次请求的端点（而不是进程里
 * 最近一次登记的端点），并且上游收到的是本次请求的密钥。
 *
 * 模型上游是本地 HTTP 服务，不碰文件系统、不起子进程。
 */

const appKey = 'p'.repeat(24)
const auth = { 'x-app-id': 'platform', 'x-app-key': appKey, 'x-dsh-user-id': 'u1' }

const ACCEPT = JSON.stringify({
  kind: 'accept',
  title: '登录页错误提示',
  scope: '只改登录页的错误文案',
  reason: '用户明确要求修改',
  intentEvidence: '「把登录页的错误提示改清楚一点」',
  rules: ['r1'],
})

const EVALUATE_PATH = '/brain/v1/superagent/evaluate'

let brain: BrainServer
let ctx: Context
let upstream: Server
let upstreamUrl = ''
/** 上游这次回什么 JSON；默认是一个接单结论。 */
let upstreamContent = ACCEPT
let seen: Array<{ url: string; authorization: string | undefined }>
/** 真实运行时收到的消息；用来钉住「内容块数组」这个形状。 */
let seenMessages: Array<readonly { role: string; content: readonly { type: string; text?: string }[] }[]>
/** 每次调用走的路由；协议由 `x-dsh-model-api` 决定。 */
let seenProviders: string[]
const originalFetch = globalThis.fetch

/** 一次评估请求体。 */
function body(): Record<string, unknown> {
  return {
    thread: { key: 'oc_chat:om_root' },
    triggers: [{ id: 't1', text: '把登录页的错误提示改清楚一点' }],
    strength: 'explicit',
    policyVersion: 1,
    policy: {
      rules: [{ id: 'r1', enabled: true, instruction: '前端缺陷修复' }],
    },
  }
}

beforeAll(async () => {
  seen = []
  seenMessages = []
  seenProviders = []
  upstream = createServer((req, res) => {
    seen.push({ url: req.url ?? '', authorization: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: upstreamContent } }] }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`

  // 当前会话故意指向一个没有登记端点和密钥的会话：评估必须完全不依赖它。
  ctx = testContext({
    webServer: new FakeWebServer(),
    agents: { currentInitiator: () => ({ session: { id: 'someone-elses-session' } }) },
  })
  // 构造即注册 `credentials` 服务，和真实装配一致。
  new SessionCredentialProvider(ctx)
  ctx.provide('llm', {
    async listModels() {
      return [{ id: 'deepseek-chat' }]
    },
    async *stream(request: {
      provider: string
      messages: readonly { role: string; content: readonly { type: string; text?: string }[] }[]
      signal?: AbortSignal
    }) {
      seenMessages.push(request.messages)
      seenProviders.push(request.provider)
      // 真实运行时就是这么发请求的：先解析本次请求的密钥，再发到哨兵域名，
      // 由 platform-api 改写到本次端点。
      const provider = ctx.get('credentials') as SessionCredentialProvider
      const credential = await provider.resolve(credentialRef('DEEPSEEK_API_KEY'))
      const response = await fetch('http://dsh-model.invalid/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential?.value ?? 'none'}` },
        body: JSON.stringify({ messages: [] }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      const payload = await response.json() as { choices: Array<{ message: { content: string } }> }
      yield { type: 'text-delta', text: payload.choices[0]?.message.content ?? '' }
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 6 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  apply(ctx, { apps: [{ appId: 'platform', appKey }] })
  brain = await startBrainServer(ctx)

  // 先登记一个「最近一次」端点：评估不能用它。
  const stale = ctx.get('sessionModelBaseUrls') as {
    set(sessionId: string, baseUrl: string): void
    latest(): string | undefined
  }
  stale.set('someone-elses-session', 'http://127.0.0.1:9/gone')
  expect(stale.latest()).toBe('http://127.0.0.1:9/gone')
})

afterAll(async () => {
  await brain.close()
  upstream.closeAllConnections?.()
  await new Promise<void>(resolve => upstream.close(() => resolve()))
  // apply() 改写了 globalThis.fetch；关掉装配后恢复。
  globalThis.fetch = originalFetch
})

describe('评估的模型调用只认本次请求', () => {
  it('哨兵域名被改写到本次请求的端点，并带上本次请求的密钥', async () => {
    const response = await call(brain.baseUrl, EVALUATE_PATH, {
      method: 'POST',
      headers: {
        ...auth,
        'x-dsh-model-key': 'sk-owner',
        'x-dsh-model-base-url': upstreamUrl,
      },
      body: body(),
    })
    expect(response.status).toBe(200)
    const result = response.json() as {
      model: { provider: string; model: string }
      usage: unknown
      outcome: { kind: string; rules?: string[] }
    }
    expect(result.model).toEqual({ provider: 'user', model: 'deepseek-chat' })
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 6 })
    expect(result.outcome).toMatchObject({ kind: 'accept', rules: ['r1'] })

    // 上游是本地服务而不是那个「最近一次」登记的端点。
    expect(seen).toEqual([{ url: '/v1/chat/completions', authorization: 'Bearer sk-owner' }])

    // 送给运行时的是内容块数组；裸字符串会让适配器在 `content.some` 上抛错。
    expect(seenMessages).toHaveLength(1)
    expect(seenMessages[0]?.[0]).toMatchObject({ role: 'user', content: [{ type: 'text' }] })
    expect(seenMessages[0]?.[0]?.content[0]?.text).toContain('"triggers"')
  })

  it('ignore 结论连同给用户看的话一起返回', async () => {
    upstreamContent = JSON.stringify({
      kind: 'ignore',
      reason: '只是打招呼',
      reply: '在的，有什么要我做的直接说。',
    })
    try {
      const response = await call(brain.baseUrl, EVALUATE_PATH, {
        method: 'POST',
        headers: {
          ...auth,
          'x-dsh-model-key': 'sk-owner',
          'x-dsh-model-base-url': upstreamUrl,
        },
        body: body(),
      })
      expect(response.status).toBe(200)
      expect((response.json() as { outcome: unknown }).outcome).toEqual({
        kind: 'ignore',
        reason: '只是打招呼',
        reply: '在的，有什么要我做的直接说。',
      })
    } finally {
      upstreamContent = ACCEPT
    }
  })

  it('点名（explicit）接单可以不带规则；主动（inferred）没规则则降级', async () => {
    upstreamContent = JSON.stringify({
      kind: 'accept',
      title: '修登录页',
      scope: '只改登录页',
      reason: '明确要求',
      intentEvidence: '「把登录页修一下」',
      rules: [],
    })
    try {
      const explicit = await call(brain.baseUrl, EVALUATE_PATH, {
        method: 'POST',
        headers: { ...auth, 'x-dsh-model-key': 'sk-owner', 'x-dsh-model-base-url': upstreamUrl },
        body: body(),
      })
      expect(explicit.status).toBe(200)
      expect((explicit.json() as { outcome: { kind: string; rules?: string[] } }).outcome).toMatchObject({
        kind: 'accept',
        rules: [],
      })

      const inferred = await call(brain.baseUrl, EVALUATE_PATH, {
        method: 'POST',
        headers: { ...auth, 'x-dsh-model-key': 'sk-owner', 'x-dsh-model-base-url': upstreamUrl },
        body: { ...body(), strength: 'inferred' },
      })
      expect(inferred.status).toBe(200)
      expect((inferred.json() as { outcome: { kind: string } }).outcome.kind).toBe('unavailable')
    } finally {
      upstreamContent = ACCEPT
    }
  })

  it('x-dsh-model-api 决定走哪条协议路由', async () => {
    seenProviders.length = 0
    const response = await call(brain.baseUrl, EVALUATE_PATH, {
      method: 'POST',
      headers: {
        ...auth,
        'x-dsh-model-key': 'sk-owner',
        'x-dsh-model-base-url': upstreamUrl,
        'x-dsh-model-api': 'anthropic-messages',
      },
      body: body(),
    })
    expect(response.status).toBe(200)
    expect((response.json() as { model: { provider: string } }).model.provider).toBe('user-anthropic-messages')
    expect(seenProviders).toEqual(['user-anthropic-messages'])
  })

  it('不认识的协议回 400，不是降级成 unavailable', async () => {
    const response = await call(brain.baseUrl, EVALUATE_PATH, {
      method: 'POST',
      headers: {
        ...auth,
        'x-dsh-model-key': 'sk-owner',
        'x-dsh-model-base-url': upstreamUrl,
        'x-dsh-model-api': 'openai',
      },
      body: body(),
    })
    expect(response.status).toBe(400)
    expect((response.json() as { error: { code: string } }).error.code).toBe('model-protocol-invalid')
  })

  it('上游不可用时降级为 unavailable，请求本身仍然成功', async () => {
    const response = await call(brain.baseUrl, EVALUATE_PATH, {
      method: 'POST',
      headers: {
        ...auth,
        'x-dsh-model-key': 'sk-owner',
        // 没人监听：改写本身成功，只是上游连不上。
        'x-dsh-model-base-url': 'http://127.0.0.1:9/v1',
      },
      body: body(),
    })
    expect(response.status).toBe(200)
    const outcome = (response.json() as { outcome: { kind: string; reason: { code: string } } }).outcome
    expect(outcome.kind).toBe('unavailable')
    expect(outcome.reason.code).toBe('model-error')
  })
})
