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

/**
 * 从注册表移除一个命名 bundle（只动注册表，不删磁盘数据）。
 * 被移除的是全局默认时，active 置空（下次解析回落到 default）。
 * @returns {Promise<{removed:boolean, active:string|null}>}
 */
export async function removeBundle(name) {
  const cur = await readRegistry()
  if (!Object.prototype.hasOwnProperty.call(cur.bundles, name)) return { removed: false, active: cur.active }
  const bundles = { ...cur.bundles }
  delete bundles[name]
  const next = { bundles, active: cur.active === name ? null : cur.active }
  const file = registryFile()
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
  return { removed: true, active: next.active }
}

/** 飞书后端的默认本地缓存目录：~/.agents/wiki-cloud/<bundle 名>（可被 cacheDir 覆盖）。 */
export function defaultCloudDir(name) {
  return join(homedir(), '.agents', 'wiki-cloud', String(name || 'cloud'))
}

/**
 * 归一化飞书库的本地缓存目录：展开 `~`；未给则用默认 `~/.agents/wiki-cloud/<名称>`。
 * 必须是绝对路径——相对路径在不同宿主下会落到不同 cwd，账本/同步会各认一份。
 * @returns {{ok:boolean, dir:string, fromInput:boolean, error?:string}}
 */
export function normalizeCacheDir(input, name) {
  const raw = String(input || '').trim()
  if (!raw) return { ok: true, dir: defaultCloudDir(name), fromInput: false }
  const dir = expandTilde(raw)
  if (!dir.startsWith('/')) {
    return { ok: false, dir: '', fromInput: true, error: '本地缓存目录必须是绝对路径（或 ~/… 开头）：相对路径在不同宿主的工作目录下会解析成不同位置' }
  }
  return { ok: true, dir, fromInput: true }
}

/**
 * 归一化 bundle 声明（两种形态共存）：
 * - `"~/notes/wiki"`                        → 本地目录（历史形态，向后兼容）
 * - `{ kind:'feishu', folderToken, cacheDir }` → 飞书云盘后端；本地工作目录 = cacheDir
 * 远程后端的 `path` 一律指向**本地缓存目录**，于是 core 的读写/校验全部照旧在目录上跑。
 * @param {string|object} decl
 * @param {{name?:string}} [opts]
 * @returns {{kind:string, path:string, decl:string|object}|null}
 */
export function normalizeBundleSpec(decl, { name } = {}) {
  if (typeof decl === 'string' && decl) return { kind: 'local', path: expandTilde(decl), decl }
  if (decl && typeof decl === 'object' && !Array.isArray(decl)) {
    const kind = decl.kind === 'feishu' ? 'feishu' : 'local'
    const raw = kind === 'feishu' ? decl.cacheDir || defaultCloudDir(name) : decl.path
    if (typeof raw !== 'string' || !raw) return null
    return { kind, path: expandTilde(raw), decl }
  }
  return null
}

/** 有效 bundle 表（name → 归一化 spec）：注册表 ∪ 宿主 config.dataDirs（同名 config 优先）。 */
export async function effectiveBundles(config = {}) {
  const reg = await readRegistry()
  const out = {}
  for (const [name, decl] of Object.entries(reg.bundles || {})) {
    const spec = normalizeBundleSpec(decl, { name })
    if (spec) out[name] = spec
  }
  for (const [name, decl] of Object.entries(config.dataDirs || {})) {
    const spec = normalizeBundleSpec(decl, { name })
    if (spec) out[name] = spec
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
 * @returns {Promise<{name:string, kind:string, path:string, decl:string|object|null}>} feishu 时 path=本地缓存目录
 */
export async function resolveBundleRoot(config = {}, { name } = {}) {
  const bundles = await effectiveBundles(config)
  const local = { kind: 'local', path: fallbackPath(config), decl: null }
  if (name !== undefined && name !== null && name !== '') {
    if (name === 'default') return { name: 'default', ...local }
    if (bundles[name]) return { name, ...bundles[name] }
    throw new Error(`未知 bundle「${name}」。可用 wiki_dirs 查看已注册目录；注册方式见 wiki_help bundle。`)
  }
  const reg = await readRegistry()
  if (reg.active === 'default') return { name: 'default', ...local }
  if (reg.active && bundles[reg.active]) return { name: reg.active, ...bundles[reg.active] }
  return { name: 'default', ...local }
}

/** 列出有效 bundle（含隐式 default）与全局默认激活项。 */
export async function listBundles(config = {}) {
  const bundles = await effectiveBundles(config)
  const { name: activeName } = await resolveBundleRoot(config)
  const rows = Object.entries(bundles).map(([name, spec]) => ({
    name,
    kind: spec.kind,
    path: spec.path,
    folderToken: spec.kind === 'feishu' && spec.decl ? spec.decl.folderToken : undefined,
    active: name === activeName,
  }))
  if (!bundles.default) rows.push({ name: 'default', kind: 'local', path: fallbackPath(config), active: activeName === 'default' })
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}
