import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import E2bFileSystem from '../../packages/dsh-e2b/src/fs.js'
import { MockPlatform } from '../../packages/dsh-e2b/src/mock-adapter.js'
import SandboxRegistry, { type SessionDirectory, type SessionOwner } from '../../packages/dsh-e2b/src/registry.js'
import { runWithSandboxSession } from '../../packages/dsh-e2b/src/session-scope.js'
import { testContext } from '../helpers/brain.js'

/**
 * 沙箱文件写策略走完整链路：真实注册表 → mock 沙箱 → 文件提供者。
 * 单元测试覆盖围栏判定，这里确认在真实绑定和挂载上也会拦下来，
 * 且工作区内的写入真的落进沙箱卷。
 */

const dirs: string[] = []

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function setup(): Promise<{ fs: E2bFileSystem; registry: SandboxRegistry; sessionId: string }> {
  const objectDir = await temp('dsh-fs-policy-objects-')
  const rootDir = await temp('dsh-fs-policy-root-')
  const platform = new MockPlatform({ objectDir, rootDir })
  const owners = new Map<string, SessionOwner>([['s_policy', { userId: 'u1', workspaceId: 'w1' }]])
  const directory: SessionDirectory = { owner: async (id) => owners.get(id) }
  const ctx = testContext()
  ctx.provide('sandboxPolicy', { defaultMode: 'workspace-write' })
  const registry = new SandboxRegistry(ctx, {
    adapter: 'mock',
    scope: 'workspace',
    platform,
    directory,
    mock: { objectDir, rootDir },
  })
  return { fs: new E2bFileSystem(ctx), registry, sessionId: 's_policy' }
}

describe('沙箱文件写策略（注册表 + mock 沙箱）', () => {
  it('工作区内的写入落进沙箱卷，工作区外和 read-only 被拒绝', async () => {
    const { fs, registry, sessionId } = await setup()
    const binding = await registry.ensure(sessionId)
    await runWithSandboxSession(sessionId, async () => {
      // mock 适配器的「虚拟机路径」就是它自己的临时卷目录；E2B 上这里是 /desk。
      const inside = await fs.resolve('notes/policy.txt')
      await fs.writeText(inside, '写在沙箱里', undefined, undefined, {
        mode: 'workspace-write',
        workspaceRoot: binding.workspaceRoot,
      })
      expect(await fs.readText(inside)).toBe('写在沙箱里')

      const outside = await fs.resolve('/etc/policy.txt')
      await expect(
        fs.writeText(outside, 'pwned', undefined, undefined, {
          mode: 'workspace-write',
          workspaceRoot: binding.workspaceRoot,
        }),
      ).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' } satisfies Partial<FsError>)

      await expect(
        fs.writeText(inside, '不许改', undefined, undefined, { mode: 'read-only', workspaceRoot: binding.workspaceRoot }),
      ).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' } satisfies Partial<FsError>)
      expect(await fs.readText(inside)).toBe('写在沙箱里')
    })
  })

  it('内部调用不带策略时仍可写工作区路径', async () => {
    const { fs, registry, sessionId } = await setup()
    await registry.ensure(sessionId)
    await runWithSandboxSession(sessionId, async () => {
      const target = await fs.resolve('upload.bin')
      await fs.writeText(target, 'upload')
      expect(await fs.readText(target)).toBe('upload')
    })
  })
})
