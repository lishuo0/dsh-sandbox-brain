import { describe, expect, it } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import E2bSubprocess from '../../packages/dsh-e2b/src/subprocess.ts'
import { createSessionSecrets, type SessionSecretStore } from '../../packages/dsh-platform-api/src/session-setup.ts'
import { testContext } from '../helpers/brain.ts'

/**
 * 会话令牌注入：点在沙箱子进程的 env，不在沙箱创建时的环境里。
 * 令牌由平台在 create 时下发，固定在内存表里；子代理会话没有自己的令牌时，
 * 沿 parentSession 继承，和模型密钥、沙箱归属走同一条链。
 */

type Env = Record<string, string> | undefined

function fakeSandboxes() {
  const envs: Env[] = []
  const service = {
    async ensureCurrent() {
      return { workspaceRoot: '/desk', externalId: 'sbx-1' }
    },
    async client() {
      return {
        capabilities: { pty: false, reattach: false, signal: false, fileVersion: false },
        process: {
          async start(spec: { env?: Env }) {
            envs.push(spec.env)
            return { pid: 7 }
          },
          async status() {
            return { pid: 7, argv: [], state: 'exited' as const, exitCode: 0 }
          },
          async kill() {},
          async list() {
            return []
          },
          async connect() {
            // eslint-disable-next-line require-yield
            return (async function* () {})()
          },
        },
      }
    },
  }
  return { service, envs }
}

function spec(env?: NodeJS.ProcessEnv): SubprocessSpawnSpec {
  return {
    argv: ['bash', '-c', 'true'],
    cwd: '/desk',
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    graceMs: 1000,
    ...(env === undefined ? {} : { env }),
  }
}

async function spawned(
  secrets: SessionSecretStore,
  agents: unknown,
): Promise<{ envs: Env[]; run: (env?: NodeJS.ProcessEnv) => Promise<void> }> {
  const sandboxes = fakeSandboxes()
  const ctx = testContext({ sandboxes: sandboxes.service, sessionSecrets: secrets, agents })
  const subprocess = new E2bSubprocess(ctx)
  return {
    envs: sandboxes.envs,
    run: async env => {
      await subprocess.spawn(spec(env)).done
    },
  }
}

describe('沙箱子进程的会话令牌', () => {
  it('每次 spawn 都带上当前会话的令牌', async () => {
    const secrets = createSessionSecrets()
    secrets.set('s1', { env: 'GH_TOKEN', value: 'ghs_x' })
    const { envs, run } = await spawned(secrets, { currentInitiator: () => ({ session: { id: 's1' } }) })
    await run()
    expect(envs).toEqual([{ GH_TOKEN: 'ghs_x' }])
  })

  it('令牌覆盖调用方自己传的同名环境变量', async () => {
    const secrets = createSessionSecrets()
    secrets.set('s1', { env: 'GH_TOKEN', value: 'ghs_platform' })
    const { envs, run } = await spawned(secrets, { currentInitiator: () => ({ session: { id: 's1' } }) })
    await run({ PATH: '/bin', GH_TOKEN: 'model-supplied' })
    expect(envs).toEqual([{ PATH: '/bin', GH_TOKEN: 'ghs_platform' }])
  })

  it('会话没有令牌时不注入任何东西', async () => {
    const { envs, run } = await spawned(createSessionSecrets(), {
      currentInitiator: () => ({ session: { id: 's1' } }),
    })
    await run({ PATH: '/bin' })
    expect(envs).toEqual([{ PATH: '/bin' }])
  })

  it('子代理会话沿 parentSession 继承父会话的令牌', async () => {
    const secrets = createSessionSecrets()
    secrets.set('root', { env: 'GH_TOKEN', value: 'ghs_parent' })
    const agents = {
      currentInitiator: () => ({ session: { id: 'child' } }),
      get: (id: string) => (id === 'child' ? { session: { header: { parentSession: 'root' } } } : undefined),
    }
    const { envs, run } = await spawned(secrets, agents)
    await run()
    expect(envs).toEqual([{ GH_TOKEN: 'ghs_parent' }])
  })
})
