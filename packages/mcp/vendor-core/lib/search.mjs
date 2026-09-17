/**
 * wiki_search —— 全文/元数据检索 + wiki_get（附 backlinks）。
 *
 * 匹配范围：frontmatter（type/title/description/tags/自定义键值）+ 正文。
 * 支持词元拆分（空格分词，任一词命中即命中）与量词后缀兜底（如
 * 「销售总额」→「销售」前缀命中）。强匹配（标题/type 精确）标 ★ 排前。
 */

import { buildGraph } from './bundle.mjs'

const STOP = new Set(['的', '了', '与', '和', '及', '或', '在', '是', '有', '对', '为'])

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[\s,，。；;:：()（）\[\]【】{}「」"'、/\\|_-]+/)
    .map((t) => t.trim())
    .filter((t) => t && !STOP.has(t))
}

function stripUnit(s) {
  // 量词后缀兜底：去掉尾部常见量词/通用词再试
  return String(s).replace(/(总额|金额|数量|个数|次数|数据|信息|情况|表|图|的)$/g, '')
}

/** 全文索引：把 concept 的 meta+body 展平成可搜文本与片段。 */
function indexable(concept) {
  const parts = []
  const meta = concept.meta || {}
  for (const k of ['type', 'title', 'description', 'resource']) {
    if (meta[k] != null) parts.push(`${k}:${String(meta[k])}`)
  }
  if (Array.isArray(meta.tags)) parts.push(`tags:${meta.tags.join(' ')}`)
  if (meta.generated && meta.generated.by) parts.push(`generated.by:${meta.generated.by}`)
  if (meta.status) parts.push(`status:${meta.status}`)
  if (meta.runtime) parts.push(`runtime:${meta.runtime}`)
  parts.push(String(concept.body || ''))
  return parts.join('\n')
}

/**
 * @param {import('./bundle.mjs').buildGraph} graph
 * @param {string} query
 * @param {{ type?: string, tag?: string, limit?: number }} opts
 */
export function searchGraph(graph, query, opts = {}) {
  const { type, tag, limit = 20 } = opts
  const qTokens = tokenize(query)
  const qRaw = String(query || '').trim().toLowerCase()
  if (!qRaw) return []
  // 全串匹配（先试），再加词元、再加量词兜底词元
  const altTokens = new Set(qTokens)
  for (const t of qTokens) altTokens.add(stripUnit(t))
  for (const t of [...qTokens]) {
    if (t.length >= 2) altTokens.add(t.slice(0, t.length - 1))
  }

  const results = []
  for (const [id, concept] of graph.nodes) {
    if (type && concept.type !== type) continue
    if (tag) {
      const tags = concept.meta.tags || []
      if (!(Array.isArray(tags) ? tags : [tags]).includes(tag)) continue
    }
    const hay = indexable(concept)
    const hayLower = hay.toLowerCase()
    // 强匹配：title/type/description 前缀或包含全串
    let score = 0
    let strong = false
    const titleLower = concept.title.toLowerCase()
    if (titleLower === qRaw || concept.type.toLowerCase() === qRaw) { score = 100; strong = true }
    else if (titleLower.includes(qRaw)) { score = 80; strong = true }
    else if (String(concept.desc).toLowerCase().includes(qRaw)) score = 40

    const hits = []
    for (const t of altTokens) {
      if (!t) continue
      if (hayLower.includes(t)) hits.push(t)
    }
    if (hits.length === 0 && !strong) continue
    if (hits.length) score += Math.min(hits.length * 10, 40)
    // 关键词在标题/type 中加权
    for (const t of hits) {
      if (titleLower.includes(t) || concept.type.toLowerCase().includes(t)) score += 5
    }
    results.push({ id, concept, score, strong, hits })
  }
  results.sort((a, b) => b.score - a.score || (a.strong === b.strong ? 0 : a.strong ? -1 : 1))
  const top = results.slice(0, limit)
  return top.map((r) => ({
    id: r.id,
    type: r.concept.type,
    title: r.concept.title,
    description: r.concept.desc,
    strong: r.strong,
    score: r.score,
  }))
}

/**
 * wiki_get：读单 concept + backlinks。
 * @param {string} root bundle 根
 * @param {string} id concept id 或 title（模糊匹配：精确 id > 精确 title > 唯一前缀）
 */
export async function getConcept(root, id) {
  const graph = await buildGraph(root)
  const want = String(id || '').trim()
  if (!want) return null
  // 1) 精确 id
  if (graph.nodes.has(want)) return compose(graph, want)
  // 2) 去掉 .md
  const noMd = want.endsWith('.md') ? want.slice(0, -3) : want
  if (graph.nodes.has(noMd)) return compose(graph, noMd)
  // 3) title 精确（唯一）
  const byTitle = [...graph.nodes.values()].filter((c) => c.title === want || c.title === noMd)
  if (byTitle.length === 1) return compose(graph, byTitle[0].id)
  if (byTitle.length > 1) return { ambiguous: true, candidates: byTitle.map((c) => c.id) }
  // 4) 唯一前缀（目录路径前缀）
  const prefixes = [...graph.nodes.keys()].filter((k) => k.startsWith(want) || k.startsWith(noMd))
  if (prefixes.length === 1) return compose(graph, prefixes[0])
  return null
}

function compose(graph, id) {
  const concept = graph.nodes.get(id)
  const ins = graph.back.get(id) ? [...graph.back.get(id)].sort() : []
  const outs = graph.forward.get(id) ? [...graph.forward.get(id)].sort() : []
  const backlinks = ins.map((srcId) => {
    const c = graph.nodes.get(srcId)
    return c ? { id: srcId, type: c.type, title: c.title } : { id: srcId }
  })
  const outlinks = outs.map((t) => {
    const c = graph.nodes.get(t)
    return c ? { id: t, type: c.type, title: c.title, exists: true } : { id: t, exists: false }
  })
  return { ...concept, backlinks, outlinks }
}
