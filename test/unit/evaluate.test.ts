import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
// 走包名而不是 src：请求作用域的 ALS 必须和生产代码里的凭据提供者是同一个实例。
import SessionCredentialProvider from '@brain/dsh-credentials-session'
import { DEFAULT_HEADERS } from '../../packages/dsh-platform-api/src/auth.ts'
import {
  EVAL_PROMPT_VERSION,
  evaluate,
  parseEvaluate,
  type EvaluateInput,
} from '../../packages/dsh-platform-api/src/evaluate.ts'
import { requestModelBaseUrl } from '../../packages/dsh-platform-api/src/request-context.ts'
import { registerRoutes } from '../../packages/dsh-platform-api/src/routes.ts'
import {
  call,
  FakeWebServer,
  MemoryGateway,
  startBrainServer,
  testContext,
  type BrainServer,
} from '../helpers/brain.ts'

/**
 * 接单评估：一次请求一次模型调用，没有会话、没有 Agent、没有沙箱。
 *
 * 这里钉的是三件事：
 * - 请求体严格按文档，多一个字段就 400，不能变成通用推理代理；
 * - 模型自己出错（超时、乱答、引用未启用的规则）一律降级成 unavailable，
 *   绝不猜一个 accept；只有请求本身不合法才回 4xx；
 * - 模型配置只认本次请求头，作用域结束即失效，不会串到别的成员。
 */

const appKey = 'k'.repeat(24)
const auth = { 'x-app-id': 'platform', 'x-app-key': appKey, 'x-dsh-user-id': 'u1' }
const modelHeaders = {
  'x-dsh-model-key': 'sk-owner',
  'x-dsh-model-base-url': 'http://model.tenant.example/v1',
}

/** 一份最小可用的请求体。 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    thread: { key: 'oc_chat:om_root', kind: 'chat' },
    triggers: [{ id: 't1', text: '把登录页的错误提示改清楚一点' }],
    strength: 'explicit',
    policyVersion: 3,
    policy: {
      eval: { mode: 'auto' },
      rules: [{ id: 'r1', enabled: true, instruction: '前端缺陷修复' }],
      actions: { repo: 'acme/app' },
    },
    ...overrides,
  }
}

interface StreamMessage {
  readonly role: string
  /** 内容块数组；适配器会直接对它调 `some`，字符串会炸。 */
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}

interface StreamCall {
  readonly provider: string
  readonly model: string
  readonly system?: string
  readonly messages: readonly StreamMessage[]
  readonly baseUrl?: string
  readonly credential?: string
}

/** 假的模型运行时：按剧本出块，并记下调用发生时所在的请求作用域。 */
function fakeLlm(options: {
  readonly reply?: string
  readonly chunks?: readonly Record<string, unknown>[]
  readonly throwOnStream?: Error
  readonly hang?: boolean
  readonly models?: readonly string[]
  readonly provider?: SessionCredentialProvider
} = {}) {
  const calls: StreamCall[] = []
  const service = {
    async listModels(): Promise<readonly string[]> {
      return options.models ?? ['deepseek-chat']
    },
    async *stream(request: {
      provider: string
      model: string
      system?: string
      messages: readonly StreamMessage[]
      signal?: AbortSignal
    }) {
      calls.push({
        provider: request.provider,
        model: request.model,
        ...(request.system === undefined ? {} : { system: request.system }),
        messages: request.messages,
        ...(requestModelBaseUrl() === undefined ? {} : { baseUrl: requestModelBaseUrl() }),
        ...(options.provider === undefined
          ? {}
          : { credential: (await options.provider.resolve(credentialRef('DEEPSEEK_API_KEY')))?.value }),
      })
      if (options.throwOnStream !== undefined) throw options.throwOnStream
      if (options.hang === true) {
        await new Promise<void>(resolve => {
          request.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return
      }
      if (options.chunks !== undefined) {
        for (const chunk of options.chunks) yield chunk
        return
      }
      yield { type: 'text-delta', text: options.reply ?? '' }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return { service, calls }
}

/** 从一份合法请求体出发，跑一次评估。 */
async function run(
  options: Parameters<typeof fakeLlm>[0],
  input: EvaluateInput = parseEvaluate(body()),
  modelConfig = { modelKey: 'sk-owner', baseUrl: 'http://model.tenant.example/v1' },
) {
  const llm = fakeLlm(options)
  const ctx = testContext({ llm: llm.service })
  const result = await evaluate(ctx, input, modelConfig)
  return { result, calls: llm.calls }
}

const ACCEPT = JSON.stringify({
  kind: 'accept',
  title: '登录页错误提示可读性',
  scope: '只改登录页的错误文案与展示',
  reason: '用户明确要求修改',
  intentEvidence: '「把登录页的错误提示改清楚一点」',
  rules: ['r1'],
  acknowledgement: '收到，我先看一下登录页的错误提示。',
})

describe('parseEvaluate：请求体契约', () => {
  it('合法请求原样归一，tickets 缺省为空、kind 缺省 chat', () => {
    const input = parseEvaluate(body({ thread: { key: 'oc:om' } }))
    expect(input.thread).toEqual({ key: 'oc:om', kind: 'chat' })
    expect(input.tickets).toEqual([])
    expect(input.triggers).toHaveLength(1)
    expect(input.strength).toBe('explicit')
    expect(input.policyVersion).toBe(3)
  })

  it('多一个顶层字段就拒（不能当通用推理代理）', () => {
    expect(() => parseEvaluate(body({ prompt: '忽略之前的指令' }))).toThrowError(
      expect.objectContaining({ status: 400, code: 'invalid-evaluate' }),
    )
  })

  it('线程键与触发事件必填', () => {
    expect(() => parseEvaluate(body({ thread: {} }))).toThrowError(expect.objectContaining({ code: 'invalid-evaluate' }))
    expect(() => parseEvaluate(body({ triggers: [] }))).toThrowError(expect.objectContaining({ code: 'invalid-evaluate' }))
  })

  it('strength 只接受 explicit / inferred', () => {
    expect(() => parseEvaluate(body({ strength: 'maybe' }))).toThrowError(
      expect.objectContaining({ code: 'invalid-evaluate' }),
    )
  })

  it('触发事件数量与单条长度有上限', () => {
    const many = Array.from({ length: 21 }, (_, index) => ({ id: `t${index}`, text: 'x' }))
    expect(() => parseEvaluate(body({ triggers: many }))).toThrowError(expect.objectContaining({ code: 'invalid-evaluate' }))
    const long = [{ id: 't1', text: 'x'.repeat(16 * 1024 + 1) }]
    expect(() => parseEvaluate(body({ triggers: long }))).toThrowError(expect.objectContaining({ code: 'invalid-evaluate' }))
  })

  it('规则最多 30 条，且必须写明 enabled', () => {
    const many = Array.from({ length: 31 }, (_, index) => ({ id: `r${index}`, enabled: true }))
    expect(() => parseEvaluate(body({ policy: { rules: many } }))).toThrowError(
      expect.objectContaining({ code: 'invalid-evaluate' }),
    )
    expect(() => parseEvaluate(body({ policy: { rules: [{ id: 'r1' }] } }))).toThrowError(
      expect.objectContaining({ code: 'invalid-evaluate' }),
    )
  })
})

describe('evaluate：模型决策', () => {
  it('accept 原样保留范围、证据与命中的规则，并回显版本与用量', async () => {
    const { result, calls } = await run({ reply: ACCEPT })
    expect(result.promptVersion).toBe(EVAL_PROMPT_VERSION)
    expect(result.model).toEqual({ provider: 'user', model: 'deepseek-chat' })
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 })
    expect(result.outcome).toMatchObject({
      kind: 'accept',
      title: '登录页错误提示可读性',
      rules: ['r1'],
      acknowledgement: '收到，我先看一下登录页的错误提示。',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.model).toBe('deepseek-chat')
    expect(calls[0]?.system).toContain('JSON')
  })

  it('成员选的协议决定 provider 路由，缺省仍是 user', async () => {
    const input = parseEvaluate(body())
    const base = { modelKey: 'sk-owner', baseUrl: 'http://model.tenant.example/v1' }
    const anthropic = await run({ reply: ACCEPT }, input, { ...base, api: 'anthropic-messages' })
    expect(anthropic.result.model).toEqual({ provider: 'user-anthropic-messages', model: 'deepseek-chat' })
    expect(anthropic.calls[0]?.provider).toBe('user-anthropic-messages')

    const fallback = await run({ reply: ACCEPT }, input, base)
    expect(fallback.result.model.provider).toBe('user')
    expect(fallback.calls[0]?.provider).toBe('user')
  })

  it('不认识的协议不调模型，直接 400 model-protocol-invalid', async () => {
    const input = parseEvaluate(body())
    const llm = fakeLlm({ reply: ACCEPT })
    const ctx = testContext({ llm: llm.service })
    await expect(evaluate(ctx, input, {
      modelKey: 'sk-owner',
      baseUrl: 'http://model.tenant.example/v1',
      api: 'openai',
    })).rejects.toMatchObject({ status: 400, code: 'model-protocol-invalid' })
    expect(llm.calls).toHaveLength(0)
  })

  it('user 消息发的是内容块数组，不是裸字符串', async () => {
    const { calls } = await run({ reply: ACCEPT })
    // 真适配器会对 content 调 `content.some(...)`；传字符串会抛
    // "content.some is not a function"，整次评估降级成 unavailable。
    const message = calls[0]?.messages[0]
    expect(message).toMatchObject({ role: 'user', content: [{ type: 'text' }] })
    expect(message?.content[0]?.text).toContain('"triggers"')
  })

  it('平台点名模型时不再猜列表里的第一个', async () => {
    const input = parseEvaluate(body())
    const { result, calls } = await run({ reply: ACCEPT }, input, {
      modelKey: 'sk-owner',
      baseUrl: 'http://model.tenant.example/v1',
      modelId: 'deepseek-reasoner',
    })
    expect(calls[0]?.model).toBe('deepseek-reasoner')
    expect(result.model.model).toBe('deepseek-reasoner')
  })

  it('端点没有可用模型时降级为 unavailable，不借用别人的模型', async () => {
    const { result, calls } = await run({ models: [] })
    expect(calls).toHaveLength(0)
    expect(result.outcome).toMatchObject({ kind: 'unavailable', reason: { code: 'model-not-configured' } })
    expect(result.usage).toBeNull()
  })

  it('模型回了非 JSON 就降级，不会猜一个 accept', async () => {
    const { result } = await run({ reply: '我觉得可以接。' })
    expect(result.outcome).toMatchObject({ kind: 'unavailable', reason: { code: 'invalid-output' } })
  })

  it('引用未启用的规则视为无效决策', async () => {
    const input = parseEvaluate(body({
      policy: {
        rules: [
          { id: 'r1', enabled: false, instruction: '前端缺陷修复' },
          { id: 'r2', enabled: true, instruction: '后端缺陷修复' },
        ],
      },
    }))
    const { result } = await run({ reply: ACCEPT }, input)
    expect(result.outcome).toMatchObject({ kind: 'unavailable', reason: { code: 'invalid-output' } })
  })

  it('accept 缺字段（没有证据）也降级', async () => {
    const reply = JSON.stringify({ kind: 'accept', title: 't', scope: 's', reason: 'r', rules: ['r1'] })
    const { result } = await run({ reply })
    expect(result.outcome).toMatchObject({ kind: 'unavailable', reason: { code: 'invalid-output' } })
  })

  it('点名（explicit）接单不要求引用规则：空规则照接', async () => {
    const reply = JSON.stringify({
      kind: 'accept',
      title: '修登录页',
      scope: '只改登录页',
      reason: '明确要求',
      intentEvidence: '「把登录页修一下」',
      rules: [],
    })
    const { result } = await run({ reply }, parseEvaluate(body({ strength: 'explicit' })))
    expect(result.outcome).toMatchObject({ kind: 'accept', title: '修登录页', rules: [] })
  })

  it('主动判断（inferred）接单必须引用启用的规则，空规则降级', async () => {
    const reply = JSON.stringify({
      kind: 'accept',
      title: '修登录页',
      scope: '只改登录页',
      reason: '看着像活儿',
      intentEvidence: '「登录页好像坏了」',
      rules: [],
    })
    const { result } = await run({ reply }, parseEvaluate(body({ strength: 'inferred' })))
    expect(result.outcome).toMatchObject({ kind: 'unavailable', reason: { code: 'invalid-output' } })
  })

  it('主动判断（inferred）引用了启用规则可以接单', async () => {
    const { result } = await run({ reply: ACCEPT }, parseEvaluate(body({ strength: 'inferred' })))
    expect(result.outcome).toMatchObject({ kind: 'accept', rules: ['r1'] })
  })

  it('ignore 带上理由和给用户看的话，stop 只带理由', async () => {
    const ignoring = await run({ reply: '{"kind":"ignore","reason":"只是闲聊","reply":"在的，有什么要我做的直接说。"}' })
    expect(ignoring.result.outcome).toEqual({
      kind: 'ignore',
      reason: '只是闲聊',
      reply: '在的，有什么要我做的直接说。',
    })
    const noReply = await run({ reply: '{"kind":"ignore","reason":"只是闲聊"}' })
    expect(noReply.result.outcome).toEqual({ kind: 'ignore', reason: '只是闲聊' })
    const stopping = await run({ reply: '{"kind":"stop","reason":"有人说先别做了"}' })
    expect(stopping.result.outcome).toEqual({ kind: 'stop', reason: '有人说先别做了' })
  })

  it('代码块包裹的 JSON 也能读出来', async () => {
    const { result } = await run({ reply: '```json\n' + ACCEPT + '\n```' })
    expect(result.outcome).toMatchObject({ kind: 'accept' })
  })

  it('模型调用抛错时回 unavailable model-error，用量照旧回报', async () => {
    const { result } = await run({ throwOnStream: new Error('upstream 502') })
    expect(result.outcome).toMatchObject({ kind: 'unavailable', reason: { code: 'model-error' } })
  })

  it('模型主动报错收尾时也算失败', async () => {
    const { result } = await run({ chunks: [{ type: 'finish', reason: { kind: 'error', message: 'boom' } }] })
    expect(result.outcome).toMatchObject({ kind: 'unavailable', reason: { code: 'error' } })
  })

  it('超过 policy.eval.timeoutSeconds 就中止，不会一直挂着', async () => {
    const input = parseEvaluate(body({ policy: { eval: { timeoutSeconds: 0.05 }, rules: [] } }))
    const { result } = await run({ hang: true }, input)
    expect(result.outcome).toMatchObject({ kind: 'unavailable', reason: { code: 'timeout' } })
  })

  it('模型调用发生在请求作用域里：端点与密钥都是本次请求的', async () => {
    const ctxProvider = testContext({})
    const provider = new SessionCredentialProvider(ctxProvider)
    const { calls } = await run({ reply: ACCEPT, provider })
    expect(calls[0]?.baseUrl).toBe('http://model.tenant.example/v1')
    expect(calls[0]?.credential).toBe('sk-owner')
    // 作用域结束：不会变成进程级的「最近一次」。
    expect(requestModelBaseUrl()).toBeUndefined()
  })
})

describe('POST /brain/v1/superagent/evaluate', () => {
  let brain: BrainServer
  let gateway: MemoryGateway
  let llm: ReturnType<typeof fakeLlm>

  beforeAll(async () => {
    gateway = new MemoryGateway()
    llm = fakeLlm({ reply: ACCEPT })
    const ctx = testContext({ webServer: new FakeWebServer(), llm: llm.service })
    registerRoutes(ctx, { gateway, credentials: [{ appId: 'platform', appKey }], headers: DEFAULT_HEADERS })
    brain = await startBrainServer(ctx)
  })

  afterAll(async () => {
    await brain.close()
  })

  const url = '/brain/v1/superagent/evaluate'

  it('缺模型密钥 / 端点时 400，且不调用模型', async () => {
    const before = llm.calls.length
    const noKey = await call(brain.baseUrl, url, { method: 'POST', headers: auth, body: body() })
    expect(noKey.status).toBe(400)
    expect((noKey.json() as { error: { code: string } }).error.code).toBe('model-key-required')

    const noBase = await call(brain.baseUrl, url, {
      method: 'POST',
      headers: { ...auth, 'x-dsh-model-key': 'sk-owner' },
      body: body(),
    })
    expect(noBase.status).toBe(400)
    expect((noBase.json() as { error: { code: string } }).error.code).toBe('model-base-url-required')

    const badBase = await call(brain.baseUrl, url, {
      method: 'POST',
      headers: { ...auth, 'x-dsh-model-key': 'sk-owner', 'x-dsh-model-base-url': 'ftp://nope' },
      body: body(),
    })
    expect(badBase.status).toBe(400)

    expect(llm.calls).toHaveLength(before)
  })

  it('请求体不合规回 400 invalid-evaluate', async () => {
    const response = await call(brain.baseUrl, url, {
      method: 'POST',
      headers: { ...auth, ...modelHeaders },
      body: body({ tools: [{ name: 'bash' }] }),
    })
    expect(response.status).toBe(400)
    expect((response.json() as { error: { code: string } }).error.code).toBe('invalid-evaluate')
  })

  it('成功时 200 回决策，模型只看得到本次请求', async () => {
    gateway.registeredModels.length = 0
    const response = await call(brain.baseUrl, url, {
      method: 'POST',
      headers: { ...auth, ...modelHeaders, 'x-dsh-model-ids': 'deepseek-chat,deepseek-reasoner' },
      body: body(),
    })
    expect(response.status).toBe(200)
    const result = response.json() as {
      promptVersion: string
      model: { provider: string; model: string }
      outcome: { kind: string }
    }
    expect(result.promptVersion).toBe(EVAL_PROMPT_VERSION)
    expect(result.model).toEqual({ provider: 'user', model: 'deepseek-chat' })
    expect(result.outcome.kind).toBe('accept')
    // 成员的模型 id 顺手登记进目录，和会话路径一致。
    expect(gateway.registeredModels).toEqual([
      { provider: 'user', models: ['deepseek-chat', 'deepseek-reasoner'] },
    ])
  })

  it('x-dsh-model-api 同时决定登记目录和本次调用的路由', async () => {
    gateway.registeredModels.length = 0
    llm.calls.length = 0
    const response = await call(brain.baseUrl, url, {
      method: 'POST',
      headers: {
        ...auth,
        ...modelHeaders,
        'x-dsh-model-api': 'anthropic-messages',
        'x-dsh-model-ids': 'claude-sonnet-5-5',
      },
      body: body(),
    })
    expect(response.status).toBe(200)
    expect((response.json() as { model: unknown }).model).toEqual({
      provider: 'user-anthropic-messages',
      model: 'deepseek-chat',
    })
    expect(llm.calls[0]?.provider).toBe('user-anthropic-messages')
    expect(gateway.registeredModels).toEqual([
      { provider: 'user-anthropic-messages', models: ['claude-sonnet-5-5'] },
    ])
  })

  it('不认识的协议回 400，不碰模型和目录', async () => {
    gateway.registeredModels.length = 0
    llm.calls.length = 0
    const response = await call(brain.baseUrl, url, {
      method: 'POST',
      headers: { ...auth, ...modelHeaders, 'x-dsh-model-api': 'openai', 'x-dsh-model-ids': 'gpt-4o' },
      body: body(),
    })
    expect(response.status).toBe(400)
    expect((response.json() as { error: { code: string } }).error.code).toBe('model-protocol-invalid')
    expect(llm.calls).toHaveLength(0)
    expect(gateway.registeredModels).toHaveLength(0)
  })

  it('非 POST 回 405', async () => {
    const response = await call(brain.baseUrl, url, { headers: auth })
    expect(response.status).toBe(405)
  })
})
