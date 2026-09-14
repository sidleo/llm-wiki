/**
 * index.md / log.md 维护。
 *
 * - index.md：目录索引。按目录分组列出概念链接 + description。
 *   根 index.md 可带 okf_version frontmatter；子目录 index.md 无 frontmatter。
 * - log.md：变更历史，ISO-8601 日期标题（YYYY-MM-DD），最新在前，追加式。
 *
 * 维护策略：写操作后刷新「受影响目录 + 根」两处 index（可配置关闭）。
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { buildGraph } from './bundle.mjs'
import { splitFrontmatter } from './doc.mjs'

/**
 * 渲染 index.md 正文（目录入口式）。
 * - dir=''（根）：只列顶级目录入口 + 根目录散落概念
 * - dir='xxx'：先列该目录的【子目录入口】，再列该目录【直接概念】（不含子目录内容）
 * 明细下沉到各目录自己的 index.md。
 */
export function renderIndexBody(graph, dir) {
  const lines = [`# ${dir || 'Knowledge Bundle'}`, '']
  if (dir) {
    const prefix = dir + '/'
    const subdirs = new Set()
    const direct = []
    for (const [id, c] of graph.nodes) {
      if (!id.startsWith(prefix)) continue
      const rest = id.slice(prefix.length)
      if (rest.includes('/')) {
        subdirs.add(rest.split('/')[0])
        continue
      }
      direct.push({ title: c.title, desc: c.desc, type: c.type, rel: rest })
    }
    for (const s of [...subdirs].sort()) {
      lines.push(`* [${s}](${s}/index.md)`)
    }
    if (subdirs.size && direct.length) lines.push('')
    for (const it of direct.sort((a, b) => a.title.localeCompare(b.title, 'zh'))) {
      lines.push(indexLine(it))
    }
    lines.push('')
    return lines.join('\n').trimEnd() + '\n'
  }
  // 根视图：目录入口式——只列顶级目录入口 + 根目录散落概念，
  // 明细下沉到各目录自己的 index.md（避免全库平铺）
  const groups = new Map() // 一级目录名 -> count
  const rootItems = []
  for (const [id] of graph.nodes) {
    const segs = id.split('/')
    if (segs.length === 1) {
      rootItems.push(id)
      continue
    }
    const top = segs[0]
    groups.set(top, (groups.get(top) || 0) + 1)
  }
  const keys = [...groups.keys()].sort()
  for (const k of keys) {
    lines.push(`* [${k}](${k}/index.md) — ${groups.get(k)} 个概念`)
  }
  if (rootItems.length) {
    lines.push('', '## (root)', '')
    for (const id of rootItems.sort((a, b) => a.localeCompare(b, 'zh'))) {
      const c = graph.nodes.get(id)
      const desc = c.desc ? ` — ${c.desc}` : ''
      lines.push(`* [${c.title}](${id}.md)${desc}  \`${c.type}\``)
    }
  }
  lines.push('')
  return lines.join('\n').trimEnd() + '\n'
}

function indexLine(it) {
  const desc = it.desc ? ` — ${it.desc}` : ''
  return `* [${it.title}](${it.rel}.md)${desc}  \`${it.type}\``
}

/**
 * 写入某目录 index.md。
 * @param {string} root bundle 根
 * @param {string} dir bundle 相对目录，'' = 根
 * @param {{ okfVersion?: string }} opts
 */
export async function writeDirIndex(root, dir, opts = {}) {
  const graph = await buildGraph(root)
  const relDir = dir ? dir + '/' : ''
  const file = join(root, relDir + 'index.md')
  let oldHeader = ''
  try {
    const old = await readFile(file, 'utf8')
    const { meta, body } = splitFrontmatter(old)
    if (meta.okf_version) oldHeader = `okf_version: ${String(meta.okf_version)}\n`
  } catch {
    // 不存在
  }
  const bodyText = renderIndexBody(graph, dir)
  const text =
    (dir === '' && (oldHeader || opts.okfVersion) ? `---\n${oldHeader || `okf_version: ${opts.okfVersion}`}---\n\n` : '') +
    bodyText
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

/** 刷新根 index + 指定目录 index（目录缺省只刷新根）。 */
export async function updateIndex(root, { dirs = [], okfVersion } = {}) {
  await writeDirIndex(root, '', { okfVersion })
  for (const d of new Set(dirs.filter(Boolean))) {
    await writeDirIndex(root, d)
  }
}

/**
 * 重生成全部 index.md：根 + 所有「已有 index.md 或含概念」的目录。
 * index 是派生文件——从目录树重新生成，结果是严格正确的。
 * @returns {Promise<{files: string[]}>} 写出的 bundle 相对路径列表
 */
export async function refreshIndex(root) {
  const graph = await buildGraph(root)
  const dirs = new Set()
  for (const [id] of graph.nodes) {
    const d = dirname(id).replace(/\\/g, '/')
    if (d !== '.') dirs.add(d)
  }
  async function walk(rel) {
    let entries
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(r)
      else if (e.name === 'index.md' && rel) dirs.add(rel)
    }
  }
  await walk('')
  await updateIndex(root, { dirs: [...dirs] })
  return { files: ['index.md', ...[...dirs].sort().map((d) => `${d}/index.md`)] }
}

/**
 * 合并两侧 log.md 文本（git 冲突时用）。
 *
 * log.md 是追加式、格式自有：按「## YYYY-MM-DD」分块，块内条目行取并集去重；
 * 日期块顺序保持「先出现的在前」，对方独有日期追加在后——不改动既有排版，
 * 且不丢任何一侧条目。产出与 appendLog 兼容。
 */
export function mergeLogText(ours, theirs) {
  const parse = (text) => {
    const order = []
    const map = new Map()
    const preamble = []
    let cur = null
    for (const line of String(text || '').split('\n')) {
      const h = /^##\s+(\S+)\s*$/.exec(line)
      if (h) {
        cur = h[1]
        if (!map.has(cur)) {
          map.set(cur, [])
          order.push(cur)
        }
        continue
      }
      if (!line.trim()) continue
      if (cur === null) preamble.push(line.trim())
      else map.get(cur).push(line.trim())
    }
    return { order, map, preamble }
  }
  const a = parse(ours)
  const b = parse(theirs)
  const dates = [...a.order, ...b.order.filter((d) => !a.map.has(d))]
  const lines = []
  const pre = a.preamble.length ? a.preamble : b.preamble
  for (const p of pre) if (!lines.includes(p)) lines.push(p)
  if (pre.length) lines.push('')
  for (const d of dates) {
    const seen = new Set()
    const entries = []
    for (const e of [...(a.map.get(d) || []), ...(b.map.get(d) || [])]) {
      if (seen.has(e)) continue
      seen.add(e)
      entries.push(e)
    }
    lines.push(`## ${d}`, ...entries, '')
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n'
}

/**
 * log.md 追加条目。
 * @param {string} root
 * @param {string} action Update|Creation|Deprecation|Lint|Ingest
 * @param {string} entry 如 'Added [orders](/tables/orders.md)'
 * @param {string} [date] YYYY-MM-DD，缺省今天
 */
export async function appendLog(root, action, entry, date) {
  const d = date || new Date().toISOString().slice(0, 10)
  const file = join(root, 'log.md')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    // 新建
  }
  const line = `* **${action}**: ${entry}`
  const heading = `## ${d}`
  if (text.includes(heading)) {
    const idx = text.indexOf(heading)
    const nl = text.indexOf('\n', idx)
    const insertAt = nl >= 0 ? nl + 1 : text.length
    text = text.slice(0, insertAt) + line + '\n' + text.slice(insertAt)
  } else {
    text = (text ? text.trimEnd() + '\n\n' : '') + `${heading}\n${line}\n`
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}
