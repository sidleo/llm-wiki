/**
 * index.md / log.md 维护。
 *
 * - index.md：目录索引。按目录分组列出概念链接 + description。
 *   根 index.md 可带 okf_version frontmatter；子目录 index.md 无 frontmatter。
 * - log.md：变更历史，ISO-8601 日期标题（YYYY-MM-DD），最新在前，追加式。
 *
 * 维护策略：写操作后刷新「受影响目录 + 根」两处 index（可配置关闭）。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { buildGraph } from './bundle.mjs'
import { splitFrontmatter } from './doc.mjs'

/**
 * 渲染 index.md 正文。
 * - dir=''（根）：按目录分组渲染全库概念 + 子目录链接
 * - dir='xxx'：渲染该目录下的全部概念（含子目录，链接用相对路径）
 */
export function renderIndexBody(graph, dir) {
  const lines = [`# ${dir || 'Knowledge Bundle'}`, '']
  if (dir) {
    const prefix = dir + '/'
    const items = [...graph.nodes]
      .filter(([id]) => id.startsWith(prefix))
      .sort((a, b) => a[1].title.localeCompare(b[1].title, 'zh'))
    for (const [id, c] of items) {
      const rel = id.slice(prefix.length)
      const desc = c.desc ? ` — ${c.desc}` : ''
      lines.push(`* [${c.title}](${rel}.md)${desc}  \`${c.type}\``)
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
