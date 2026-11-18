import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  handle,
  HttpError,
  MAX_BODY_BYTES,
  query,
  readJson,
  segmentsAfter,
  sendJson,
  SseWriter,
} from '../../packages/dsh-platform-api/src/http.ts'

function request(body: string | Buffer): IncomingMessage {
  return Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
}

interface FakeResponse {
  status?: number
  headers?: Record<string, string>
  chunks: string[]
  ended: boolean
  headersSent: boolean
  writeHead(status: number, headers?: Record<string, string>): FakeResponse
  write(chunk: string): boolean
  end(chunk?: string): void
  on(): void
}

function response(): FakeResponse {
  const res: FakeResponse = {
    chunks: [],
    ended: false,
    headersSent: false,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
      res.headersSent = true
      return res
    },
    write(chunk) {
      res.chunks.push(chunk)
      return true
    },
    end(chunk) {
      if (chunk !== undefined) res.chunks.push(chunk)
      res.ended = true
    },
    on() {},
  }
  return res
}

describe('platform-api http helpers', () => {
  it('readJson 解析对象', async () => {
    expect(await readJson(request('{"a":1}'))).toEqual({ a: 1 })
  })

  it('readJson 拒绝空体', async () => {
    await expect(readJson(request(''))).rejects.toMatchObject({ status: 400, code: 'body-required' })
  })

  it('readJson 拒绝坏 JSON', async () => {
    await expect(readJson(request('{'))).rejects.toMatchObject({ status: 400, code: 'invalid-json' })
  })

  it('readJson 拒绝超大请求体', async () => {
    const big = Buffer.alloc(MAX_BODY_BYTES + 1, 0x61)
    await expect(readJson(request(big))).rejects.toMatchObject({ status: 413, code: 'body-too-large' })
  })

  it('sendJson 写内容类型与长度', () => {
    const res = response()
    sendJson(res as unknown as ServerResponse, 201, { ok: true })
    expect(res.status).toBe(201)
    expect(res.headers?.['content-type']).toContain('application/json')
    expect(res.chunks.join('')).toBe('{"ok":true}')
    expect(res.ended).toBe(true)
  })

  it('handle 把 HttpError 映射成响应', async () => {
    const res = response()
    await handle(request(''), res as unknown as ServerResponse, async () => {
      throw new HttpError(404, 'nope', '未找到')
    })
    expect(res.status).toBe(404)
    expect(JSON.parse(res.chunks.join(''))).toEqual({ error: { code: 'nope', message: '未找到' } })
  })

  it('handle 对未知错误只回 internal，并把原因交给诊断', async () => {
    const res = response()
    const seen: unknown[] = []
    await handle(request(''), res as unknown as ServerResponse, async () => {
      throw new Error('SELECT * FROM secrets')
    }, (error) => seen.push(error))
    expect(res.status).toBe(500)
    const body = JSON.parse(res.chunks.join('')) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('internal')
    expect(body.error.message).toBe('internal error')
    expect(seen).toHaveLength(1)
  })

  it('handle 在响应已开始时只结束连接', async () => {
    const res = response()
    res.headersSent = true
    await handle(request(''), res as unknown as ServerResponse, async () => {
      throw new Error('late')
    })
    expect(res.ended).toBe(true)
  })

  it('SseWriter 写事件、心跳与关闭，关闭后不再写', () => {
    const res = response()
    const sse = new SseWriter(res as unknown as ServerResponse)
    expect(res.status).toBe(200)
    expect(res.headers?.['content-type']).toContain('text/event-stream')
    sse.send('event', { a: 1 })
    sse.comment('keepalive')
    sse.close()
    sse.close()
    sse.send('late', {})
    const text = res.chunks.join('')
    expect(text).toContain(': connected')
    expect(text).toContain('event: event\ndata: {"a":1}')
    expect(text).toContain(': keepalive')
    expect(text).not.toContain('late')
    expect(sse.isClosed).toBe(true)
  })

  it('segmentsAfter 解出前缀后的路径段', () => {
    expect(segmentsAfter('/brain/v1/sessions/s1/messages', '/brain/v1/sessions')).toEqual(['s1', 'messages'])
    expect(segmentsAfter('/brain/v1/sessions/s1/goal/pause', '/brain/v1/sessions')).toEqual(['s1', 'goal', 'pause'])
    expect(segmentsAfter('/brain/v1/sessions/s1/', '/brain/v1/sessions')).toEqual(['s1'])
    expect(segmentsAfter('/brain/v1/sessions/a%20b/messages', '/brain/v1/sessions')).toEqual(['a b', 'messages'])
    expect(segmentsAfter('/brain/v1/sessions', '/brain/v1/sessions')).toEqual([])
  })

  it('query 读参数', () => {
    expect(query('/x?after=3&from=0', 'after')).toBe('3')
    expect(query('/x', 'after')).toBeUndefined()
  })
})
