/**
 * wiki_lint —— bundle 体检。
 *
 * 覆盖：断链（提及但无目标）、孤儿页（无入链且无出链）、过期概念
 * （now >= stale_after）、缺 index 目录、缺 description 概念、重复 title。
 * 「矛盾检测」为 LLM 辅助（消费方外部做），本模块输出结构事实。
 */

import { buildGraph, scanConceptPaths, readConcept } from './bundle.mjs'
import { readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

/**
 * @param {string} root
 * @param {{ now?: Date, includeAllDirs?: boolean }} opts
 */
export async function lintBundle(root, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date()
  const { nodes, forward, back } = await buildGraph(root)
  const issues = []

  const seenIds = new Set(nodes.keys())
  for (const [src, targets] of forward) {
    for (const t of targets) {
      if (!seenIds.has(t)) {
        issues.push({ sev: 'warn', kind: 'broken-link', src, target: t, msg: `${src} → 指向不存在的概念 ${t}（可能是未写入的知识）` })
      }
    }
  }

  for (const [id, concept] of nodes) {
    const outs = forward.get(id) || new Set()
    const ins = back.get(id) || new Set()
    // 孤儿：既无出链也无入链（索引/日志不在概念图内；仅对概念自身判定）
    if (outs.size === 0 && ins.size === 0) {
      issues.push({ sev: 'info', kind: 'orphan', id, msg: `${id}: 无入链也无出链（孤儿页）` })
    }
    // 过期
    if (concept.meta.stale_after != null) {
      const t = Date.parse(String(concept.meta.stale_after))
      if (!Number.isNaN(t) && t <= now.getTime()) {
        issues.push({ sev: 'warn', kind: 'stale', id, msg: `${id}: 已过期（stale_after=${concept.meta.stale_after}）` })
      }
    }
    // deprecated 提示
    if (concept.meta.status === 'deprecated') {
      issues.push({ sev: 'info', kind: 'deprecated', id, msg: `${id}: 已废弃（status: deprecated）` })
    }
    // 缺 description
    if (!concept.desc) {
      issues.push({ sev: 'info', kind: 'no-description', id, msg: `${id}: 缺 description（index/检索摘要不可用）` })
    }
  }

  // 重复 title（同目录内或全局）
  const byTitle = new Map()
  for (const [id, concept] of nodes) {
    if (!byTitle.has(concept.title)) byTitle.set(concept.title, [])
    byTitle.get(concept.title).push(id)
  }
  for (const [title, ids] of byTitle) {
    if (ids.length > 1) {
      issues.push({ sev: 'warn', kind: 'dup-title', ids, msg: `标题「${title}」被 ${ids.length} 个概念共用: ${ids.join(', ')}` })
    }
  }

  // 目录缺 index.md（不含已有点 index.md 的目录）
  const dirsWithIndex = new Set()
  const allDirs = await collectDirs(root)
  for (const d of allDirs) {
    const idx = join(root, d, 'index.md')
    if (await fileExists(idx)) dirsWithIndex.add(d)
  }
  // 有概念但缺 index 的目录（根目录若存在概念也应检查）
  const conceptDirs = new Set()
  for (const [id] of nodes) {
    const d = dirname(id).replace(/\\/g, '/')
    conceptDirs.add(d === '.' ? '' : d)
  }
  for (const d of conceptDirs) {
    if (!dirsWithIndex.has(d) && d !== '') {
      issues.push({ sev: 'info', kind: 'no-index', dir: d, msg: `${d}: 含概念但缺 index.md（建议补目录索引）` })
    }
  }

  issues.sort((a, b) => (a.kind === b.kind ? 0 : a.kind < b.kind ? -1 : 1))
  return {
    issues,
    summary: {
      concepts: nodes.size,
      broken: issues.filter((i) => i.kind === 'broken-link').length,
      stale: issues.filter((i) => i.kind === 'stale').length,
      orphans: issues.filter((i) => i.kind === 'orphan').length,
    },
  }
}

async function collectDirs(root) {
  const out = ['']
  async function walk(rel) {
    let entries
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (!e.isDirectory()) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      out.push(r)
      await walk(r)
    }
  }
  await walk('')
  return out
}

async function fileExists(p) {
  try {
    const { access } = await import('node:fs/promises')
    await access(p)
    return true
  } catch {
    return false
  }
}
