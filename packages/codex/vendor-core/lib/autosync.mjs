/**
 * autosync.mjs —— 定时自动同步的**配置持久化**（纯读写，不含定时器）。
 *
 * 为什么配置放 core 而不是插件：四形态（DSH / pi / MCP / skill CLI）都要读同一份设置，
 * 「每台机器一份」的事实必须落在同一个路径上——`~/.agents/wiki-autosync.json`。
 * 定时器本身属于宿主能力（DSH 插件内跑），CLI 只做 `wiki autosync` 的开关与状态查询。
 *
 * 文件是**纯机器本地**的（不进 bundle、不进 git、不参与飞书同步），因为
 * 「本机是否要定时同步、间隔多少」是设备事实，跨设备同步这条配置没有意义。
 *
 * 结构：
 * {
 *   version: 1,
 *   bundles: {
 *     "<bundle 名>": { enabled: bool, intervalMinutes: number, identity: 'auto'|'user'|'bot',
 *                      lastRunAt, lastResult: {ok, pushed, pulled, conflicts, error}, runningSince }
 *   }
 * }
 *
 * 默认值：未声明的 bundle = 关闭。所有 bundle 默认关闭是刻意的——
 * 一个会自己往飞书推东西的定时器，必须由人显式打开。
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { expandTilde } from './registry.mjs'

/** 默认间隔（分钟）：用户可改，默认 5。 */
export const DEFAULT_INTERVAL_MINUTES = 5
/** 间隔下限：低于它会把飞书限流和本机 CPU 都拖垮。 */
export const MIN_INTERVAL_MINUTES = 1
/** 间隔上限：一天。 */
export const MAX_INTERVAL_MINUTES = 1440
/** 身份取值（auto = 谁可用用谁）。 */
export const AUTOSYNC_IDENTITIES = ['auto', 'user', 'bot']

/** 配置文件路径（可用 WIKI_AUTOSYNC_FILE 覆盖，测试用）。 */
export function autosyncFile() {
  return expandTilde(process.env.WIKI_AUTOSYNC_FILE || join(homedir(), '.agents', 'wiki-autosync.json'))
}

const EMPTY = { version: 1, bundles: {} }

/** 读配置（缺文件/坏 JSON 一律回落空配置，绝不因此让同步崩掉）。 */
export async function readAutosync(file) {
  const path = file || autosyncFile()
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'))
    const bundles = raw && typeof raw.bundles === 'object' && raw.bundles ? raw.bundles : {}
    return { version: 1, bundles }
  } catch {
    return { ...EMPTY, bundles: {} }
  }
}

/** 原子写（tmp + rename），避免卡片读到半截文件。 */
export async function writeAutosync(data, file) {
  const path = file || autosyncFile()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify({ version: 1, bundles: (data && data.bundles) || {} }, null, 2) + '\n', 'utf8')
  await rename(tmp, path)
  return path
}

/** 把任意输入规整成合法间隔（非法 → 默认值；越界 → 夹到边界）。 */
export function normalizeInterval(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MINUTES
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(n)))
}

/** 规整身份取值（非法 → auto，并按 canUseBot 决定是否降级）。 */
export function normalizeIdentity(value, { canUseBot = true } = {}) {
  const v = String(value || 'auto').toLowerCase()
  if (!AUTOSYNC_IDENTITIES.includes(v)) return 'auto'
  if (v === 'bot' && !canUseBot) return 'auto'
  return v
}

/**
 * 某 bundle 的生效自动同步设置（未配置 = 关闭 + 默认值）。
 * @returns {{enabled:boolean, intervalMinutes:number, identity:string, lastRunAt:string|null, lastResult:object|null, runningSince:string|null}}
 */
export async function autosyncSettingsFor(name, opts = {}) {
  const data = await readAutosync(opts.file)
  const raw = (data.bundles && data.bundles[String(name || '')]) || {}
  return {
    enabled: raw.enabled === true,
    intervalMinutes: normalizeInterval(raw.intervalMinutes),
    identity: normalizeIdentity(raw.identity, { canUseBot: opts.canUseBot !== false }),
    lastRunAt: raw.lastRunAt || null,
    lastResult: raw.lastResult || null,
    runningSince: raw.runningSince || null,
  }
}

/**
 * 合并写入某 bundle 的设置（只动传入的字段，其余保留）。
 * @returns {Promise<object>} 写入后的该 bundle 设置
 */
export async function setAutosyncSettings(name, patch = {}, opts = {}) {
  const key = String(name || '')
  if (!key) throw new Error('自动同步设置需要 bundle 名')
  const data = await readAutosync(opts.file)
  const prev = (data.bundles && data.bundles[key]) || {}
  const next = { ...prev }
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true
  if (patch.intervalMinutes !== undefined) next.intervalMinutes = normalizeInterval(patch.intervalMinutes)
  if (patch.identity !== undefined) next.identity = normalizeIdentity(patch.identity, { canUseBot: opts.canUseBot !== false })
  data.bundles[key] = next
  const path = await writeAutosync(data, opts.file)
  return { ...next, path }
}

/** 记录一次运行结果（成功/失败都记：卡片要显示「上次同步」而不是静默）。 */
export async function recordAutosyncRun(name, result, opts = {}) {
  const key = String(name || '')
  if (!key) return null
  const data = await readAutosync(opts.file)
  const prev = (data.bundles && data.bundles[key]) || {}
  data.bundles[key] = {
    ...prev,
    lastRunAt: new Date().toISOString(),
    lastResult: {
      ok: result && result.ok === true,
      pushed: Array.isArray(result && result.pushed) ? result.pushed.length : 0,
      pulled: Array.isArray(result && result.pulled) ? result.pulled.length : 0,
      conflicts: Array.isArray(result && result.conflicts) ? result.conflicts.length : 0,
      error: (result && result.error) || null,
    },
  }
  await writeAutosync(data, opts.file)
  return data.bundles[key]
}

/** 标记「正在跑」（进程被 kill 后由 nextRun 的陈旧判定自动接管）。 */
export async function markAutosyncRunning(name, running, opts = {}) {
  const key = String(name || '')
  if (!key) return null
  const data = await readAutosync(opts.file)
  const prev = (data.bundles && data.bundles[key]) || {}
  data.bundles[key] = { ...prev, runningSince: running ? new Date().toISOString() : null }
  await writeAutosync(data, opts.file)
  return data.bundles[key]
}

/** 是否为「陈旧 running」（进程崩溃留下的标记）：超过 2 倍间隔 + 1 分钟即视为陈旧。 */
export function isStaleRunning(runningSince, intervalMinutes, now = Date.now()) {
  if (!runningSince) return false
  const at = Date.parse(runningSince)
  if (!Number.isFinite(at)) return true
  const grace = (normalizeInterval(intervalMinutes) * 2 + 1) * 60 * 1000
  return now - at > grace
}
