import type { TestPool } from './pg.ts'
import { MockPlatform } from '../../packages/dsh-e2b/src/mock-adapter.ts'
import type { SandboxHandle } from '../../packages/dsh-e2b/src/contract.ts'
import SessionDirectoryService from '../../packages/dsh-session-directory/src/index.ts'
import UserSkillsPlugin from '../../packages/dsh-user-skills/src/index.ts'
import { testContext } from './brain.ts'

/** 脑的 db 服务契约：`query()` 直接返回行数组。 */
export interface BrainDbLike {
  readonly dialect?: string
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>
  transaction?: TestPool['transaction']
}

/** 把测试句柄转成脑的 db 服务形状；联合测试里也可以传平台侧的 rows 包装。 */
export function dbOf(pool: BrainDbLike) {
  return {
    dialect: pool.dialect,
    query: <T>(text: string, params?: readonly unknown[]): Promise<T[]> => pool.query<T>(text, params),
    transaction: pool.transaction,
  }
}

/** 沙箱文件读接口，Provider 的 fs 只需要这两个。 */
export interface SandboxFiles {
  read(path: string): Promise<Uint8Array>
  stat(path: string): Promise<{ type: string } | undefined>
}

/** 技能 Provider 在本测试里用到的最小接口。 */
export interface SkillProviderView {
  list(options: { signal?: AbortSignal }): Promise<readonly SkillCandidateView[]>
  get(candidate: SkillCandidateView, options: { signal?: AbortSignal }): Promise<SkillDefinitionView | undefined>
}

export interface SkillCandidateView {
  name: string
  description: string
  rank: number
  provider: string
  locator: { name: string; scope: string }
  path: string
  resourceBase: { kind: string; path: string }
  source: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
}

export interface SkillDefinitionView {
  name: string
  provider: string
  source: string
  path: string
  content: string
  resourceBase: { kind: string; path: string }
}

/**
 * 用真实的 SessionDirectory + UserSkillsPlugin 组装一个技能 Provider，
 * fs 读写走给定沙箱——和脑在真实会话里看到的一致。
 */
export async function createSkillProvider(options: {
  db: ReturnType<typeof dbOf>
  sessionId: string
  files: SandboxFiles
}): Promise<SkillProviderView> {
  const ctx = testContext({
    db: options.db,
    agents: { get: () => undefined },
  })
  new SessionDirectoryService(ctx, { cacheTtlMs: 0 })
  new UserSkillsPlugin(ctx, {})

  const providers: SkillProviderView[] = []
  const agent = {
    session: { id: options.sessionId },
    ctx: {
      inject: (_names: string[], callback: (scope: unknown) => void) => {
        callback({
          skills: {
            registerProvider: (factory: (control: { signal: AbortSignal }) => SkillProviderView) => {
              providers.push(factory({ signal: new AbortController().signal }))
            },
          },
        })
      },
      get: (name: string) =>
        name === 'fs'
          ? {
              resolve: async (path: string) => {
                if ((await options.files.stat(path)) === undefined) throw new Error(`ENOENT ${path}`)
                return path
              },
              readText: async (path: string) => Buffer.from(await options.files.read(path)).toString('utf8'),
            }
          : undefined,
    },
  }
  ctx.emit('agent/created', { agent })

  const deadline = Date.now() + 5_000
  while (providers.length === 0) {
    if (Date.now() > deadline) throw new Error('技能 Provider 未注册')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return providers[0]!
}

/**
 * 建一个和平台约定一致的沙箱：工作区、个人技能、公共技能三处挂载。
 * @param platform - 共享对象目录模式的 MockPlatform。
 * @param input - 工作区与会话属主。
 */
export function mountSkillSandbox(
  platform: MockPlatform,
  input: { workspaceId: string; userId: string },
): Promise<SandboxHandle> {
  const guestRoot = '/desk'
  return platform.create({
    key: 'e2e',
    template: 'mock',
    timeoutMs: 60_000,
    workspaceRoot: guestRoot,
    mounts: [
      { bucketName: 'b', bucketPath: `desks/${input.workspaceId}`, endpoint: 'x', mountDir: guestRoot },
      { bucketName: 'b', bucketPath: `members/${input.userId}/skills`, endpoint: 'x', mountDir: '/skillbox/own' },
      { bucketName: 'b', bucketPath: 'common/skills', endpoint: 'x', mountDir: '/skillbox/common', readOnly: true },
    ],
  })
}
