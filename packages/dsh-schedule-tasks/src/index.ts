/**
 * 会话定时任务。
 *
 * 手脑分离：工具只把定义写进共用的 dsh_schedule_tasks。到期由平台副本认领，
 * 再走平台自己的发消息把模型和沙箱配置补回去。沙箱仍在真正读文件时才恢复。
 * 不挂官方 @deepseek-ai/dsh-schedule，那个计时器会在脑进程里直接唤醒会话。
 * 脑也不回拨平台。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { registerTools } from './tools.ts'
import type { ScheduleDB } from './tasks.ts'

export const name = 'schedule-tasks'
export const inject = ['tools', 'db', 'agents']

export function apply(ctx: Context): void {
  registerTools(ctx, (ctx as Context & { db: ScheduleDB }).db)
}
