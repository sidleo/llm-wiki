/**
 * registry.mjs —— 命名 bundle 注册表（跨三形态的宿主无关状态）。
 *
 * 单个数据目录默认 ~/.agents/wiki；要管理多个 wiki 目录，用「命名 bundle」：
 * - 注册表文件（默认 ~/.agents/wiki-registry.json，env WIKI_REGISTRY_FILE 覆盖）：
 *     { "bundles": { "工作": "/abs/path/a", "个人": "~/notes/wiki" }, "active": "工作" }
 * - 宿主侧声明式 dataDirs 与注册表合并（同名时宿主配置优先）：
 *     config.dataDirs = { 工作: '/abs/path/a', 个人: '~/notes/wiki' }
 * - 隐式 default bundle = config.dataDir || ~/.agents/wiki（未配置任何名字时的兜底）。
 *
 * 解析顺序（无显式 name）：注册表 active（若为已知名字）→ default。
 * 会话级切换由各宿主层管理（如 dsh 每对话一个 agent）；global 持久化 = 写注册表 active。
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/** 默认数据目录 ~/.agents/wiki（不硬编码绝对路径）。 */
export function defaultDataDir() {
  return join(homedir(), '.agents', 'wiki')
}

/** 注册表文件路径（env WIKI_REGISTRY_FILE 覆盖，测试用）。 */
export function registryFile() {
  return process.env.WIKI_REGISTRY_FILE || join(homedir(), '.agents', 'wiki-registry.json')
}

/** 展开 ~ 为 home 目录（相对路径原样返回）。 */
export function expandTilde(p) {
  if (typeof p !== 'string' || !p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/** 读注册表；文件缺失/损坏返回空注册表。 */
export async function readRegistry() {
  try {
    const data = JSON.parse(await readFile(registryFile(), 'utf8'))
    return {
      bundles: data && typeof data.bundles === 'object' && data.bundles ? data.bundles : {},
      active: data && typeof data.active === 'string' && data.active ? data.active : null,
    }
  } catch {
    return { bundles: {}, active: null }
  }
}

/** 写注册表（原子替换：先写 tmp 再 rename）。 */
export async function writeRegistry(patch = {}) {
  const cur = await readRegistry()
  const next = {
    bundles: { ...cur.bundles, ...(patch.bundles || {}) },
    active: patch.active !== undefined ? patch.active : cur.active,
  }
  const file = registryFile()
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
  return next
}

/** 持久化全局默认激活 bundle。 */
export async function writeRegistryActive(name) {
  return writeRegistry({ active: name })
}

/** 有效 bundle 表（name → 绝对路径）：注册表 ∪ 宿主 config.dataDirs（同名 config 优先）。 */
export async function effectiveBundles(config = {}) {
  const reg = await readRegistry()
  const out = {}
  for (const [name, p] of Object.entries(reg.bundles || {})) {
    if (typeof p === 'string' && p) out[name] = expandTilde(p)
  }
  for (const [name, p] of Object.entries(config.dataDirs || {})) {
    if (typeof p === 'string' && p) out[name] = expandTilde(p)
  }
  return out
}

/** 兜底路径：config.dataDir || 默认目录。 */
export function fallbackPath(config = {}) {
  return expandTilde(config.dataDir) || defaultDataDir()
}

/**
 * 解析当前 bundle 根。
 * @param {object} [config] 宿主配置（{ dataDir, dataDirs }）
 * @param {{ name?: string }} [opts] name=显式 bundle 名（缺省按注册表 active 或 default 解析）
 * @returns {Promise<{name: string, path: string}>}
 */
export async function resolveBundleRoot(config = {}, { name } = {}) {
  const bundles = await effectiveBundles(config)
  if (name !== undefined && name !== null && name !== '') {
    if (name === 'default') return { name: 'default', path: fallbackPath(config) }
    if (bundles[name]) return { name, path: bundles[name] }
    throw new Error(`未知 bundle「${name}」。可用 wiki_dirs 查看已注册目录；注册方式见 wiki_help bundle。`)
  }
  const reg = await readRegistry()
  if (reg.active === 'default') return { name: 'default', path: fallbackPath(config) }
  if (reg.active && bundles[reg.active]) return { name: reg.active, path: bundles[reg.active] }
  return { name: 'default', path: fallbackPath(config) }
}

/** 列出有效 bundle（含隐式 default）与全局默认激活项。 */
export async function listBundles(config = {}) {
  const bundles = await effectiveBundles(config)
  const { name: activeName } = await resolveBundleRoot(config)
  const rows = Object.entries(bundles).map(([name, path]) => ({ name, path, active: name === activeName }))
  if (!bundles.default) rows.push({ name: 'default', path: fallbackPath(config), active: activeName === 'default' })
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}
