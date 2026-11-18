/**
 * 行形状归一：PostgreSQL 返回 jsonb 对象 / bigint 字符串，SQLite 返回 JSON 文本 /
 * 整数。服务层用这几个小函数，两种方言拿到同一形状。
 *
 * @module @brain/dsh-database/row
 */

/** jsonb 列：PG 已是对象，SQLite 是 JSON 文本。 */
export function asJson<T = Record<string, unknown>>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T
  return value as T
}

/** bigint / 字符串数字统一成 number；空值给 0。 */
export function asNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return 0
}
