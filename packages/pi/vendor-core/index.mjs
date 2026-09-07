/**
 * llm-wiki core —— 统一入口。
 *
 * 纯 ESM、无宿主依赖。三形态（dsh 插件 / pi 扩展 / skill CLI）都只依赖本包。
 *
 * 导出 9 个工具函数（与 wiki_* 工具一一对应）：
 *   list / search / get / create / update / validate / lint / ingest / deprecate
 * 加辅助：resolveRules（AGENTS.md 规则解析）、appendLog/updateIndex（维护）、
 * parseDoc/serializeDoc（格式工具，供上层自定义编辑）。
 */

import { dirname } from 'node:path'

export { parseYaml, stringifyYaml } from './lib/yaml.mjs'
export { splitFrontmatter, serializeDoc, extractLinks, normalizeLink, extractFootnoteIds } from './lib/doc.mjs'
export { scanConceptPaths, readConcept, buildGraph, isReserved, RESERVED, readOkfVersion, collectInjectPrompts } from './lib/bundle.mjs'
export { validateBundle } from './lib/validate.mjs'
export { lintBundle } from './lib/lint.mjs'
export { searchGraph, getConcept } from './lib/search.mjs'
export { findRules, readRules, resolveRules, parseGateDecl, gateForType } from './lib/rules.mjs'
export { getHelp, HELP_TOPICS } from './lib/help.mjs'
export { renderIndexBody, writeDirIndex, updateIndex, appendLog } from './lib/indexlog.mjs'
export { createConcept, updateConcept, deprecateDir, nowIso, checkId } from './lib/write.mjs'
export { ingestSource } from './lib/ingest.mjs'

// 命名 bundle 注册表：默认数据目录 ~/.agents/wiki + 多目录注册/切换（跨三形态）
export {
  defaultDataDir,
  registryFile,
  readRegistry,
  writeRegistry,
  writeRegistryActive,
  expandTilde,
  effectiveBundles,
  fallbackPath,
  resolveBundleRoot,
  listBundles,
} from './lib/registry.mjs'

/** 列出 bundle 树（目录 → 概念列表 + 该目录 rules 提示），供 wiki_list。 */
export async function listBundle(root, { type, status } = {}) {
  const { buildGraph } = await import('./lib/bundle.mjs')
  const graph = await buildGraph(root)
  const tree = new Map() // dir -> concepts[]
  for (const [id, concept] of graph.nodes) {
    if (type && concept.type !== type) continue
    if (status && concept.meta.status !== status) continue
    const d = dirname(id).replace(/\\/g, '/') === '.' ? '' : dirname(id).replace(/\\/g, '/')
    if (!tree.has(d)) tree.set(d, [])
    tree.get(d).push({ id, type: concept.type, title: concept.title, desc: concept.desc, status: concept.meta.status })
  }
  const dirs = [...tree.keys()].sort()
  const out = []
  for (const d of dirs) {
    out.push({ dir: d, concepts: tree.get(d).sort((a, b) => a.title.localeCompare(b.title, 'zh')) })
  }
  return out
}
