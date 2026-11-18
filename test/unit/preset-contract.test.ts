import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

/**
 * 预设与 profile 是部署契约：这里只做静态校验，不启动 DSH。
 * 防止把宿主已经注册的工具再挂一遍（会遮蔽宿主配置），
 * 或者误删宿主工具 / 关掉预设依赖的服务。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BUNDLE = resolve(ROOT, 'packages/dsh-platform-bundle')
const PROFILE = resolve(ROOT, 'profile/api/cordis.patch.yml')
const require = createRequire(import.meta.url)

const jsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: () => '' })
const schema = yaml.DEFAULT_SCHEMA.extend([jsType])

interface Row {
  id?: string
  name?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: Row[]
}

function load(file: string): { insert: Row[]; rows: Row[] } {
  const doc = yaml.load(readFileSync(file, 'utf8'), { schema }) as Row[]
  const rows: Row[] = []
  const collect = (list: Row[]): void => {
    for (const row of list) {
      rows.push(row)
      if (Array.isArray(row.insert)) collect(row.insert)
    }
  }
  collect(doc)
  return { insert: doc.flatMap((row) => row.insert ?? []), rows }
}

const profile = load(PROFILE)
const bundlePatch = load(resolve(BUNDLE, 'cordis.patch.yml'))

function pluginsOf(file: string): Row[] {
  const { rows } = load(file)
  const presetRow = rows.find((row) => row.name === '@deepseek-ai/dsh-agent-preset')
  expect(presetRow).toBeDefined()
  const plugins = (presetRow?.config as { plugins?: Row[] } | undefined)?.plugins
  expect(Array.isArray(plugins)).toBe(true)
  return plugins ?? []
}

function rowById(rows: Row[], id: string): Row | undefined {
  return rows.find((row) => row.id === id)
}

describe('platform 预设', () => {
  const plugins = pluginsOf(resolve(BUNDLE, 'presets/platform.patch.yml'))

  it('每个插件都有唯一 id，且包能解析到', () => {
    const ids = plugins.map((plugin) => plugin.id)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    for (const plugin of plugins) {
      expect(plugin.name).toBeTruthy()
      expect(() => require.resolve(plugin.name!)).not.toThrow()
    }
  })

  it('有面向用户的名称和描述（预设页只展开声明插件，描述要写全）', () => {
    const { rows } = load(resolve(BUNDLE, 'presets/platform.patch.yml'))
    const row = rows.find((item) => item.name === '@deepseek-ai/dsh-agent-preset')
    const config = row?.config as { id?: string; name?: string; description?: string } | undefined
    expect(config?.id).toBe('platform')
    expect(config?.name).toBe('标准模式')
    // 客户端预设页只列出 plugins，不展开宿主工具，所以描述必须自己说明宿主能力。
    expect(config?.description).toContain('宿主')
  })

  it('补上了宿主不注册的 ask_user_question 与 present', () => {
    const names = plugins.map((plugin) => plugin.name)
    expect(names).toContain('@deepseek-ai/dsh-tool-ask-user')
    expect(names).toContain('@deepseek-ai/dsh-tool-present')
  })

  it('不重复注册宿主工具（同名会遮蔽宿主的配置）', () => {
    const names = new Set(plugins.map((plugin) => plugin.name))
    for (const hostTool of ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-jobs']) {
      expect(names.has(hostTool)).toBe(false)
    }
  })
})

describe('profile 接线', () => {
  it('宿主工具行保持启用', () => {
    for (const id of ['tool-bash', 'tool-jobs', 'tool-web', 'tool-goal', 'tool-subagent']) {
      expect(rowById(profile.rows, id)?.disabled).not.toBe(true)
    }
  })

  it('会落到脑宿主执行的工具行保持关闭', () => {
    for (const id of [
      'fs-sandbox',
      'session-persistence-jsonl',
      'ptc-runtime',
      'workflow-ptc',
      'tool-workflow',
      'tool-fs-search',
      'skill-filesystem',
      'tool-working-directory',
      'attachment-local',
      'web-search-deepseek',
    ]) {
      expect(rowById(profile.rows, id)?.disabled).toBe(true)
    }
  })

  it('ask_user_question 依赖的 user-questions 服务没被关掉', () => {
    expect(rowById(profile.rows, 'user-questions')?.disabled).not.toBe(true)
  })

  it('不挂任何会注册 /api 或 Upgrade 的 Host 面插件', () => {
    // 脑只对外暴露 `/brain/v1`；这些插件注册 `/api` 前缀路由、Remote 命名空间
    // 或 `/api/remote.mux` 的 Upgrade，一律不进 profile。
    for (const id of ['connection', 'file-upload', 'api-remotes', 'job-controller', 'ui-settings']) {
      expect(rowById(profile.rows, id)).toBeUndefined()
    }
    // typert-gateway 只留内部 `typertGateway` 服务（session-controller 依赖）；
    // 没有 connection 它不注册 Upgrade，也没有任何 HTTP 路由。
    expect(rowById(profile.rows, 'typert-gateway')?.disabled).not.toBe(true)
  })

  it('默认预设就是 platform', () => {
    const registry = bundlePatch.rows.find((row) => row.name === '@deepseek-ai/dsh-agent-preset-registry')
    expect((registry?.config as { default?: string } | undefined)?.default).toBe('platform')
  })

  it('genui 宿主半挂在 profile 上，注册工具但不碰沙箱', () => {
    const row = rowById(profile.rows, 'genui')
    expect(row?.name).toBe('@changfenhuang/dsh-genui')
    expect(row?.disabled).not.toBe(true)
    expect(() => require.resolve('@changfenhuang/dsh-genui')).not.toThrow()
  })

  it('预设引用的包都在 bundle 依赖里', () => {
    const manifest = JSON.parse(readFileSync(resolve(BUNDLE, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const deps = manifest.dependencies ?? {}
    for (const plugin of pluginsOf(resolve(BUNDLE, 'presets/platform.patch.yml'))) {
      expect(deps[plugin.name!]).toBeTruthy()
    }
  })
})
