/**
 * config.mjs —— Codex 插件配置面，与 DSH / Pi / MCP / Skill 使用同一注册表。
 *
 * 来源优先级：
 *   dataDir  = --data-dir/--dataDir DIR > WIKI_DATA_DIR > ~/.agents/wiki
 *   dataDirs = --bundles 名=路径（可重复、可逗号分隔）∪ WIKI_BUNDLES
 * 命名 bundle 注册表默认读 ~/.agents/wiki-registry.json（WIKI_REGISTRY_FILE 可覆盖）。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'

/** 插件版本（写入门控的 producer 版本、MCP initialize 的 serverInfo 版本）。 */
export const MCP_VERSION = '0.7.2'

/** 写入记录里的 producer 标识（区分第五形态）。 */
export const PRODUCER = 'codex-wiki'

/** 与 DSH 插件使用同一套输出上限，保证跨形态阅读体验一致。 */
export const DEFAULTS = {
  dataDir: join(homedir(), '.agents', 'wiki'),
  maxGetChars: 40000,
  maxContextChars: 12000,
  cacheTtlMs: 30000,
}

/** `名=路径,名2=路径2` → 追加进 dataDirs（忽略无 = 的片段）。 */
function addBundles(target, spec) {
  for (const part of String(spec || '').split(',')) {
    const s = part.trim()
    if (!s) continue
    const i = s.indexOf('=')
    if (i > 0) target[s.slice(0, i).trim()] = s.slice(i + 1).trim()
  }
}

/** 解析 argv（只认数据目录相关开关，其余留给宿主）。 */
export function parseArgv(argv = []) {
  const out = { dataDir: undefined, dataDirs: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i])
    const eq = a.indexOf('=')
    const key = eq >= 0 ? a.slice(0, eq) : a
    const inline = eq >= 0 ? a.slice(eq + 1) : undefined
    const next = () => (inline !== undefined ? inline : String(argv[++i] ?? ''))
    if (key === '--data-dir' || key === '--dataDir') out.dataDir = next()
    else if (key === '--bundles') addBundles(out.dataDirs, next())
  }
  return out
}

/** 生成 core 认得的 config（resolveBundleRoot/effectiveBundles 直接使用）。 */
export function buildConfig({ argv = [], env = process.env } = {}) {
  const parsed = parseArgv(argv)
  const dataDir = parsed.dataDir || env.WIKI_DATA_DIR || DEFAULTS.dataDir
  const dataDirs = { ...parsed.dataDirs }
  if (env.WIKI_BUNDLES) addBundles(dataDirs, env.WIKI_BUNDLES)
  return { dataDir, dataDirs }
}
