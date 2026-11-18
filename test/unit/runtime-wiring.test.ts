import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { brainHome, storageRoot, type BrainConfig } from '../../src/config.js'

/**
 * 部署接线的静态契约：这轮修的都是「配置没接上，功能看起来在、其实不动」。
 * 启动 DSH 之前先把这些值钉住，免得再退回假实现。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PROFILE = resolve(ROOT, 'profile/api/cordis.patch.yml')

const jsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: () => '' })
const schema = yaml.DEFAULT_SCHEMA.extend([jsType])

interface Row {
  id?: string
  name?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: Row[]
}

const rows: Row[] = []
const collect = (list: Row[]): void => {
  for (const row of list) {
    rows.push(row)
    if (Array.isArray(row.insert)) collect(row.insert)
  }
}
collect(yaml.load(readFileSync(PROFILE, 'utf8'), { schema }) as Row[])

function row(id: string): Row | undefined {
  return rows.find((item) => item.id === id)
}

describe('profile 接线', () => {
  it('沙箱默认 workspace-write，工作区根是 /desk', () => {
    expect(row('sandbox-policy')?.config).toMatchObject({ mode: 'workspace-write', workspaceRoot: '/desk' })
  })

  it('权限预设覆盖三档，默认预设已选中，收窄访问走人工确认', () => {
    const config = row('permission')?.config as {
      defaultPreset?: string
      presets?: Record<string, { sandbox?: string; approval?: string }>
    }
    expect(config.defaultPreset).toBe('workspace-write')
    expect(config.presets?.['read-only']).toEqual({ sandbox: 'read-only', approval: 'ask' })
    expect(config.presets?.['workspace-write']).toEqual({ sandbox: 'workspace-write', approval: 'ask' })
    // 完全放行不需要每一步都弹审批。
    expect(config.presets?.['danger-full-access']).toEqual({ sandbox: 'danger-full-access', approval: 'never' })
    expect(row('approval')?.config).toMatchObject({ policy: 'ask' })
  })

  it('目标轮次驱动是开着的', () => {
    expect(row('goal-round-driver')?.disabled).toBe(false)
  })

  it('全局 DSH Host 面已摘除：没有 /api 前缀、Remote 命名空间和 Upgrade 注册项', () => {
    // 脑只留 `/brain/v1`；这些行都会让脑暴露文档之外的 `/api/*` 或 Upgrade。
    for (const id of [
      'connection',
      'file-upload',
      'api-remotes',
      'job-controller',
      'workspace-files',
      'workspace-controller',
      'settings-controller',
      'ui-settings',
    ]) {
      expect(row(id)).toBeUndefined()
    }
    // typert-gateway 保留：它只提供内部 `typertGateway` 服务（session-controller 需要）。
    // 没有 connection 时它不注册 `/api/remote.mux` 的 Upgrade，也不会开任何路由；
    // 「101 不可达」这条契约由平台侧 e2e 兜住。
    expect(row('typert-gateway')?.disabled).not.toBe(true)
  })

  it('会话流和文件面依赖的内部服务还在', () => {
    // 只提供内部服务、不再注册路由的插件必须保留。
    expect(row('session-controller')?.name).toBe('@deepseek-ai/dsh-api-session-controller')
    expect(row('workspace-files-session')?.name).toBe('@brain/dsh-e2b/workspace-files')
    expect(row('workspace')?.name).toBe('@brain/dsh-workspace-platform')
  })

  it('session-controller 的装配依赖都有人提供，不会卡在 pending', () => {
    // 缺 fileUploads / typertGateway 时这个插件永远不激活，projections / fork 全 501。
    // 平台自己收口上传面，脑侧只需一个不会注册路由的占位服务。
    expect(row('file-uploads-stub')?.name).toBe('@brain/dsh-file-uploads-stub')
    expect(row('typert-gateway')?.disabled).not.toBe(true)
  })

  it('回合看门狗有明确的部署预算，不会被静默关掉', () => {
    expect(row('platform-api')?.config).toMatchObject({ turnStallMs: 600000 })
  })

  it('不挂浏览器动态插件的宿主半，也不提供日志导出', () => {
    // 这两项都是官方 Web 的「+」菜单能力；平台不提供，脑侧整行不出现。
    // 它们的基础包（dsh-base / 本仓库的 bundle）本来就没有定义，无需再写 disabled。
    expect(row('dynamic-cordis-runner')).toBeUndefined()
    expect(row('session-log-download')).toBeUndefined()
  })

  it('会写脑宿主机文件/进程的插件保持关闭', () => {
    for (const id of ['attachment-local', 'fs-sandbox', 'session-persistence-jsonl']) {
      expect(row(id)?.disabled).toBe(true)
    }
  })
})

describe('本地运行时目录', () => {
  const config = (dir?: string): BrainConfig => ({ storage: dir === undefined ? undefined : { dir } }) as BrainConfig

  it('没配 storage.dir 时落在仓库的 var/objects，不是仓库根', () => {
    expect(storageRoot(config(), '/repo/brain')).toBe('/repo/brain/var/objects')
    expect(brainHome(config(), '/repo/brain')).toBe('/repo/brain/var/objects/brain-home')
  })

  it('配了 storage.dir 时以它为根，和平台对象目录是同一份', () => {
    const configured = '../dsh-sandbox-platform/var/objects'
    expect(storageRoot(config(configured), '/repo/brain')).toBe('/repo/dsh-sandbox-platform/var/objects')
    expect(brainHome(config(configured), '/repo/brain')).toBe('/repo/dsh-sandbox-platform/var/objects/brain-home')
  })

  it('绝对路径原样使用，空配置按未配置处理', () => {
    expect(brainHome(config('/mnt/dsh/objects'), '/repo/brain')).toBe('/mnt/dsh/objects/brain-home')
    expect(brainHome(config('   '), '/repo/brain')).toBe('/repo/brain/var/objects/brain-home')
  })
})
