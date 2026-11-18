import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AuthError,
  authenticate,
  DEFAULT_HEADERS,
  loadCredentials,
  type AppCredential,
} from '../../packages/dsh-platform-api/src/auth.ts'

const apps: AppCredential[] = [
  { appId: 'platform', appKey: 'k'.repeat(24) },
  { appId: 'ops', appKey: 'o'.repeat(24) },
]

function headerBag(values: Record<string, string>): (name: string) => string | undefined {
  return (name) => values[name]
}

describe('platform-api auth', () => {
  it('正确凭据通过并带出用户', () => {
    const caller = authenticate(
      headerBag({ 'x-app-id': 'platform', 'x-app-key': 'k'.repeat(24), 'x-dsh-user-id': 'u1' }),
      apps,
      DEFAULT_HEADERS,
    )
    expect(caller.appId).toBe('platform')
    expect(caller.userId).toBe('u1')
    expect(caller.requestId).toMatch(/[0-9a-f-]{36}/)
  })

  it('调用方给的 requestId 原样带回', () => {
    const caller = authenticate(
      headerBag({ 'x-app-id': 'platform', 'x-app-key': 'k'.repeat(24), 'x-request-id': 'req-1' }),
      apps,
      DEFAULT_HEADERS,
    )
    expect(caller.requestId).toBe('req-1')
    expect(caller.userId).toBeUndefined()
  })

  it('缺少头、错误 key、未知 appId 都是同一个错误', () => {
    expect(() => authenticate(headerBag({}), apps, DEFAULT_HEADERS)).toThrow(AuthError)
    expect(() => authenticate(headerBag({ 'x-app-id': 'platform' }), apps, DEFAULT_HEADERS)).toThrow(AuthError)
    expect(() =>
      authenticate(headerBag({ 'x-app-id': 'platform', 'x-app-key': 'x'.repeat(24) }), apps, DEFAULT_HEADERS),
    ).toThrow(AuthError)
    expect(() =>
      authenticate(headerBag({ 'x-app-id': 'nobody', 'x-app-key': 'k'.repeat(24) }), apps, DEFAULT_HEADERS),
    ).toThrow(AuthError)
  })

  it('appId 与 key 必须来自同一对', () => {
    expect(() =>
      authenticate(headerBag({ 'x-app-id': 'ops', 'x-app-key': 'k'.repeat(24) }), apps, DEFAULT_HEADERS),
    ).toThrow(AuthError)
  })

  it('支持自定义头名', () => {
    const names = { appId: 'x-a', appKey: 'x-b', userId: 'x-u', requestId: 'x-r' }
    const caller = authenticate(headerBag({ 'x-a': 'ops', 'x-b': 'o'.repeat(24), 'x-u': 'u9' }), apps, names)
    expect(caller).toMatchObject({ appId: 'ops', userId: 'u9' })
  })

  it('凭据文件校验', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-auth-'))
    try {
      const good = join(dir, 'good.json')
      await writeFile(good, JSON.stringify({ apps: [{ appId: 'platform', appKey: 'k'.repeat(24), name: '平台' }] }))
      expect(loadCredentials(good)).toEqual([{ appId: 'platform', appKey: 'k'.repeat(24), name: '平台' }])

      const cases: Array<[string, unknown]> = [
        ['empty.json', {}],
        ['not-array.json', { apps: {} }],
        ['no-apps.json', []],
        ['bad-key.json', { apps: [{ appId: 'a', appKey: 'short' }] }],
        ['no-id.json', { apps: [{ appId: '', appKey: 'k'.repeat(24) }] }],
        ['dup.json', { apps: [{ appId: 'a', appKey: 'k'.repeat(24) }, { appId: 'a', appKey: 'l'.repeat(24) }] }],
      ]
      for (const [name, body] of cases) {
        const file = join(dir, name)
        await writeFile(file, JSON.stringify(body))
        expect(() => loadCredentials(file), name).toThrow()
      }

      const broken = join(dir, 'broken.json')
      await writeFile(broken, '{')
      expect(() => loadCredentials(broken)).toThrow('not valid JSON')
      expect(() => loadCredentials(join(dir, 'missing.json'))).toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
