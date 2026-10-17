/**
 * overview.mjs —— `wiki_list` 的清单渲染（五形态共用）。
 *
 * 背景（实测）：把每条概念渲染成一行、**带上绝对路径**后，每行约 206 字符。真实库 364 个
 * 概念需 75K 字符，超出宿主 `maxGetChars`（40000）→ 输出被字符级硬切：**364 个概念里只有
 * 184 个完整出现，180 个（49.5%）静默丢失**，且无任何截断提示。而 `wiki_list` 的定位恰恰是
 * 「动手前第一步看全貌」——给半份且不说，比不给更危险（模型会误判「库里没有」→ 重复写入）。
 *
 * 根因是**绝对路径的长度**（单条约 150 字符，bundle 根前缀就占 ~76），不是「列全量」本身。
 * 因此修法是：清单只给 `标题 + type`（不含路径），路径能力留给 `wiki_search` / `wiki_get`。
 *
 * 容量对比（真实库实测，上限 40000）：
 *   - 带路径全量：75K，**约 187 概念即撞线**（当前 364 已超）；
 *   - 标题+type 全量：约 19.8K（49.5%），**约 748 概念**才撞线。
 * 即：既保住了「全量清单」，又把容量提升约 4 倍。
 *
 * 【不变量】本函数只做**渲染**，不改 `listBundle` 的返回结构——config 页的体检计数
 * （dsh wiki.mjs 的 /api/dsh-wiki 路由）与 wiki_lint 仍依赖完整 tree。
 */

/**
 * 渲染全量清单。
 *
 * @param {Array<{dir:string, concepts:Array<{id,type,title,status}>}>} tree listBundle 结果
 * @param {object} [opts]
 * @param {string} [opts.scopeNote] 过滤说明（如「仅 type=Pitfall」），非空时标注输出是子集
 * @returns {string}
 */
export function renderOverview(tree, { scopeNote = '' } = {}) {
  const dirs = Array.isArray(tree) ? tree : []
  const total = dirs.reduce((n, d) => n + (d.concepts ? d.concepts.length : 0), 0)
  const lines = []

  const head = `知识库清单（${dirs.length} 个目录 / ${total} 个概念）`
  lines.push(scopeNote ? `${head}　筛选：${scopeNote}` : head)
  lines.push('')

  for (const d of dirs) {
    const cs = d.concepts || []
    const kinds = {}
    // type 缺失时归为「未标 type」——OKF 要求 type 必填（wiki_validate 会拦），
    // 但渲染层不该把 undefined 直接漏进输出。
    for (const k of cs) {
      const t = k.type || '未标 type'
      kinds[t] = (kinds[t] || 0) + 1
    }
    const kindStr = Object.entries(kinds)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}×${n}`)
      .join(' ')
    lines.push(`${d.dir || '(root)'}  — ${cs.length} 个${kindStr ? ` (${kindStr})` : ''}`)
    for (const k of cs) {
      const dep = k.status === 'deprecated' ? ' [废弃]' : ''
      lines.push(`    · ${k.title}${k.type ? `  [${k.type}]` : ''}${dep}`)
    }
  }

  lines.push('')
  lines.push('【怎么用】本清单给出全部条目标题与类型，用于判断「库里有没有」。取具体内容：`wiki_search <关键词>`（可加 type 过滤）；已知 id 用 `wiki_get`——这两个工具的检索结果会带该条目的**真实绝对路径**，可直接用作链接目标。')
  return lines.join('\n')
}

/**
 * 按**整行**截断到 maxChars 以内，绝不切断某一行。
 *
 * 兜底用：概览通常远低于上限，但目录/示例极多时仍可能超。字符级 `slice` 会切出半条
 * 路径（实测过 `</Users/zhang3/Librar` 这种废行），按行截断则保证：
 * ① 输出的每一条都是完整可用的；② 明确告知被省略，不静默。
 *
 * @returns {string} 截断后的文本（含省略提示）
 */
export function truncateByLine(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return text
  if (text.length <= maxChars) return text
  const lines = String(text).split('\n')
  const head = lines[0] || ''

  // 【不变量】截断必须自述——「静默丢内容」正是本模块要根除的病，截断本身也不许静默。
  // 因此**先为提示行预留预算**再装正文：不这么做的话，正文会吃光额度、提示塞不下被丢掉，
  // 结果是「内容少了且不说」（实测 maxChars=200 时会出现这种静默）。
  // 空间越紧用越短的提示；短到连最小提示都放不下时，至少保证正文不被切断。
  const noteFull = (n) => `…（超出输出上限，已省略 ${n} 行；用 wiki_search 或加 type/status 过滤缩小范围）`
  const noteMin = (n) => `…（已省略 ${n} 行）`
  const reserve = Math.min(noteFull(9999).length + 1, Math.max(0, Math.floor(maxChars / 4))) + 1

  const kept = [head]
  let used = head.length + 1
  const budget = maxChars - reserve
  let dropped = 0
  for (const l of lines.slice(1)) {
    if (used + l.length + 1 > budget) { dropped++; continue }
    kept.push(l)
    used += l.length + 1
  }
  // 先试完整提示，放不下退最小提示；都放不下则不加（此时 maxChars 小到无意义，正文仍完整）
  for (const note of [noteFull(dropped), noteMin(dropped)]) {
    if (used + note.length + 1 <= maxChars) { kept.push(note); break }
  }
  return kept.join('\n')
}
