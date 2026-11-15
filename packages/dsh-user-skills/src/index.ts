/**
 * Skills mounted from two read-only directories.
 *
 * Private skills belong to the session user and live under `privateRoot`.
 * Public skills are shared by the deployment and live under `publicRoot`.
 * The platform records which ones are enabled in `dsh_skills`. This provider
 * registers on the Agent scope and reads `SKILL.md` through the sandbox
 * filesystem. A private skill with the same name hides the public one.
 *
 * @module @brain/dsh-user-skills
 */

import type {} from '@brain/dsh-database'
import type {} from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
} from '@deepseek-ai/dsh-skill'

/** Plugin configuration. */
export interface Config {
  /** Guest directory for this member's skills. */
  readonly privateRoot?: string
  /** Guest directory for skills shared by the deployment. */
  readonly publicRoot?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionDirectory?: {
      userOf(sessionId: string): Promise<{ userId: string } | undefined>
    }
  }
}

const PRIVATE_ROOT = '/skillbox/own'
const PUBLIC_ROOT = '/skillbox/common'

interface SkillRow {
  name: string
  description: string
  scope: string
}

interface SandboxFs {
  resolve(path: string, opts?: { signal?: AbortSignal }): Promise<unknown>
  readText(target: unknown, signal?: AbortSignal): Promise<string>
}

/**
 * Register one provider per Agent, scoped to that Agent's user.
 */
export default class UserSkillsPlugin {
  static readonly inject = ['db', 'sessionDirectory']

  constructor(ctx: Context, config: Config = {}) {
    const privateRoot = normalizeRoot(config.privateRoot, PRIVATE_ROOT)
    const publicRoot = normalizeRoot(config.publicRoot, PUBLIC_ROOT)
    ctx.on('agent/created', async ({ agent }) => {
      const directory = ctx.get('sessionDirectory') as
        | { userOf(sessionId: string): Promise<{ userId: string } | undefined> }
        | undefined
      const user = await directory?.userOf(agent.session.id)
      if (user === undefined) return
      agent.ctx.inject(['skills'], (scope) => {
        scope.skills.registerProvider((control) =>
          createProvider(ctx, control, user.userId, privateRoot, publicRoot, agent.ctx),
        )
      })
    })
  }
}

function createProvider(
  ctx: Context,
  control: SkillProviderControl,
  userId: string,
  privateRoot: string,
  publicRoot: string,
  agentCtx: Context,
): SkillProvider {
  return {
    name: 'user-skills',
    async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
      options.signal?.throwIfAborted()
      const rows = await ctx.db.query<SkillRow>(
        `SELECT name, description, scope FROM dsh_skills
          WHERE enabled = true
            AND ((scope = 'private' AND user_id = $1) OR scope = 'public')
          ORDER BY name`,
        [userId],
      )
      const chosen = new Map<string, SkillRow>()
      for (const row of rows) {
        const current = chosen.get(row.name)
        if (current === undefined || (current.scope !== 'private' && row.scope === 'private')) {
          chosen.set(row.name, row)
        }
      }
      return [...chosen.values()].map((row) => candidate(row, rootOf(row, privateRoot, publicRoot)))
    },
    async get(candidateValue: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
      options.signal?.throwIfAborted()
      const locator = candidateValue.locator as { name?: unknown; scope?: unknown } | undefined
      const name = locator?.name
      const scope = locator?.scope === 'public' ? 'public' : 'private'
      if (typeof name !== 'string' || name === '') return undefined
      const root = scope === 'public' ? publicRoot : privateRoot
      const skillPath = `${root}/${name}/SKILL.md`
      const fs = agentCtx.get('fs') as SandboxFs | undefined
      if (fs === undefined) return undefined
      try {
        const target = await fs.resolve(skillPath, { signal: options.signal })
        const content = await fs.readText(target, options.signal)
        return definition(name, candidateValue, root, skillPath, content)
      } catch (error) {
        control.signal.throwIfAborted()
        ctx.logger?.warn?.(`user-skills: failed to read "${skillPath}": ${String(error)}`)
        return undefined
      }
    },
  }
}

function rootOf(row: SkillRow, privateRoot: string, publicRoot: string): string {
  return row.scope === 'public' ? publicRoot : privateRoot
}

function definition(
  name: string,
  candidateValue: SkillCandidate,
  root: string,
  skillPath: string,
  content: string,
): SkillDefinition {
  return {
    name,
    description: candidateValue.description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'custom',
    provider: 'user-skills',
    path: skillPath,
    resourceBase: { kind: 'directory', path: `${root}/${name}` },
    content,
  }
}

function candidate(row: SkillRow, root: string): SkillCandidate {
  return {
    name: row.name,
    description: row.description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'custom',
    provider: 'user-skills',
    rank: row.scope === 'private' ? 300 : 200,
    locator: { name: row.name, scope: row.scope },
    path: `${root}/${row.name}/SKILL.md`,
    resourceBase: { kind: 'directory', path: `${root}/${row.name}` },
  }
}

function normalizeRoot(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim()
  if (trimmed === '') return fallback
  return trimmed.replace(/\/+$/g, '')
}
