/**
 * config.mjs —— MCP 形态的配置面（与 dsh/pi 的 config 形态一致：{ dataDir, dataDirs }）。
 *
 * 来源优先级：
 *   dataDir   = --data-dir/--dataDir DIR > WIKI_DATA_DIR > ~/.agents/wiki
 *   dataDirs  = --bundles 名=路径（可重复、可逗号分隔）∪ WIKI_BUNDLES
 * 注册表（~/.agents/wiki-registry.json，env WIKI_REGISTRY_FILE）由 core 直接读，
 * 命名 bundle = 注册表 ∪ dataDirs（同名 dataDirs 优先）——与另三形态共享同一份状态。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'

/** 包版本（写入门控的 producer 版本；与 package.json 保持一致，见 test/parity）。 */
export const MCP_VERSION = '0.4.13'

/** 写入记录里的 producer 标识（区分四形态）。 */
export const PRODUCER = 'mcp-wiki'

/** 与 dsh 插件同一套上限口径（保证工具输出文本逐字节一致）。 */
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

/** 解析 argv（只认自己需要的两个开关；其余留给宿主配置）。 */
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

/** 生成 core 认得的 config（resolveBundleRoot/effectiveBundles 直接用）。 */
export function buildConfig({ argv = [], env = process.env } = {}) {
  const parsed = parseArgv(argv)
  const dataDir = parsed.dataDir || env.WIKI_DATA_DIR || DEFAULTS.dataDir
  const dataDirs = { ...parsed.dataDirs }
  if (env.WIKI_BUNDLES) addBundles(dataDirs, env.WIKI_BUNDLES)
  return { dataDir, dataDirs }
}
