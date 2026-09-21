/**
 * AGENTS.md 目录规则解析（向上遍历取最近 + 逐级叠加、子覆盖父）。
 *
 * 保留文件语义（本项目扩展，见 SPEC-EXTENSIONS.md）：
 * AGENTS.md 无 frontmatter、不作 concept；对任意目录 D，生效规则 =
 * 从 D 向上遍历到 bundle 根遇到的最近 AGENTS.md；若存在多条，返回
 * 根→叶有序列表（最近者最后、优先级最高，消费方叠加时后者覆盖前者）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 返回目录 dir（bundle 相对，如 'tables' 或 '' 表示根）到 bundle 根路径上
 * 存在的全部 AGENTS.md 相对路径，按「根→近」排序（最近的排最后）。
 * @param {string} root bundle 根
 * @param {string} dir bundle 相对目录；'' 表示根目录
 * @returns {Promise<string[]>} AGENTS.md 相对路径列表
 */
export async function findRules(root, dir) {
  const parts = dir ? dir.split('/') : []
  const found = []
  // 从根往下到 dir：根→近
  for (let depth = 0; depth <= parts.length; depth++) {
    const d = parts.slice(0, depth).join('/')
    const p = join(root, d, 'AGENTS.md')
    try {
      await readFile(p, 'utf8')
      found.push(d ? `${d}/AGENTS.md` : 'AGENTS.md')
    } catch {
      // 不存在，跳过
    }
  }
  return found // 根在前，最近的（叶子目录的）在后
}

/**
 * 读取解析后的规则内容列表（顺序同 findRules：根→近，后者优先）。
 * @returns {Promise<{path:string, content:string}[]>}
 */
export async function readRules(root, dir) {
  const paths = await findRules(root, dir)
  const out = []
  for (const p of paths) {
    try {
      out.push({ path: p, content: await readFile(join(root, p), 'utf8') })
    } catch {
      // 忽略竞态
    }
  }
  return out
}

/**
 * 便捷：解析出某目录生效的规则文本（根→近拼接；实际叠加语义由调用方按需
 * 处理——规则正文是 agent 指令，通常只需把全部规则文本交给 agent，靠
 * 「后者覆盖前者」的自然阅读顺序即可）。
 */
export async function resolveRules(root, dir) {
  const rules = await readRules(root, dir)
  return rules.map((r) => ({ path: r.path, content: r.content }))
}

/**
 * 返回目录 dir 到 bundle 根路径上存在的全部 APPEND_SYSTEM_PROMPT.md，按「根→近」排序。
 * 与 AGENTS.md 同理逐级叠加（后者优先/追加）。
 * @returns {Promise<{dir:string, path:string, content:string}[]>} dir='' 为根
 */
export async function readAppends(root, dir) {
  const parts = dir ? dir.split('/') : []
  const out = []
  for (let depth = 0; depth <= parts.length; depth++) {
    const d = parts.slice(0, depth).join('/')
    const p = join(root, d, 'APPEND_SYSTEM_PROMPT.md')
    try {
      const content = (await readFile(p, 'utf8')).trim()
      if (content) out.push({ dir: d, path: d ? `${d}/APPEND_SYSTEM_PROMPT.md` : 'APPEND_SYSTEM_PROMPT.md', content })
    } catch {
      // 不存在，跳过
    }
  }
  return out
}

/**
 * 目录生效的「规则上下文」：APPEND_SYSTEM_PROMPT.md（行为规则，= 描述层注入的内容）
 * + AGENTS.md（门控/写入规则）。三形态共用：DSH 每轮注入、pi 每回合注入、
 * skill/CLI 靠 `wiki rules` 与工具响应附带（skill 宿主无注入钩子）。
 * @returns {Promise<{dir:string, appends:{dir:string,path:string,content:string}[], rules:{path:string,content:string}[]}>}
 */
export async function ruleContextFor(root, dir = '') {
  const appends = await readAppends(root, dir)
  const rules = await readRules(root, dir)
  return { dir: String(dir || ''), appends, rules }
}

/**
 * 把 ruleContextFor 的结果格式化成文本（三形态输出格式一致，便于比对）。
 * @param {{dir?:string, appends?:object[], rules?:object[]}} ctx
 * @param {{title?:string}} [opts]
 * @returns {string} 无任何规则时返回 ''
 */
export function formatRuleContext(ctx, opts = {}) {
  const appends = (ctx && ctx.appends) || []
  const rules = (ctx && ctx.rules) || []
  if (!appends.length && !rules.length) return ''
  const dir = ctx && ctx.dir ? ctx.dir : 'bundle 根'
  const title = (opts && opts.title) || `【${dir} 生效规则】（根→近，后者优先）`
  const blocks = []
  for (const a of appends) blocks.push(`===== ${a.path}（行为规则 = system prompt 注入内容）=====\n${String(a.content).trimEnd()}`)
  for (const r of rules) blocks.push(`===== ${r.path}（门控/写入规则）=====\n${String(r.content).trimEnd()}`)
  return `${title}\n\n${blocks.join('\n\n')}`
}

/**
 * 抽取某份 AGENTS.md 的「## 门控」节原文（无该节返回 ''）。
 * @param {string} text
 * @returns {string}
 */
export function extractGateSection(text) {
  const lines = String(text || '').split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (/^#{1,3}\s*门控/.test(t)) { start = i; continue }
    if (start >= 0 && /^#{1,3}\s/.test(t)) return lines.slice(start, i).join('\n').trimEnd()
  }
  return start >= 0 ? lines.slice(start).join('\n').trimEnd() : ''
}

/**
 * 工具响应附带的**紧凑规则**：APPEND 链（行为规则，根→近）+ 各 AGENTS.md 的「## 门控」节。
 *
 * 用途：skill/CLI 形态宿主不会注入 system prompt，于是让规则**随数据到达**——
 * 挂在 wiki get/create/update 的响应末尾，agent 不必记得先跑 `wiki rules`。
 * 只带门控节而非整份 AGENTS.md：门控是写入时需要的最小信息，正文其余部分是给人读的约定。
 * @returns {Promise<string>} 无任何规则时返回 ''
 */
export async function formatRuleAppendix(root, dir = '') {
  const appends = await readAppends(root, dir)
  const rules = await readRules(root, dir)
  const parts = []
  for (const a of appends) parts.push(`===== ${a.path}（行为规则 = system prompt 注入内容）=====\n${a.content.trimEnd()}`)
  for (const r of rules) {
    const section = extractGateSection(r.content)
    if (section) parts.push(`===== ${r.path}（「## 门控」节）=====\n${section}`)
  }
  if (!parts.length) return ''
  return `【${dir || 'bundle 根'} 生效规则】（规则随响应附带；各形态的注入通道见 instructions / SKILL.md）\n\n${parts.join('\n\n')}`
}

/**
 * 解析某份 AGENTS.md 正文里的「## 门控」节声明。
 *
 * 约定格式（宽松解析，大小写/全半角不敏感）：
 *   ## 门控
 *   - 需 human 确认: Metric, Attested Computation
 *   - 自动记录: Table, Pitfall
 * 未出现「需 human 确认」行即表示该目录对所有 type 无要求（默认全部自动记录）。
 *
 * @returns {{ needConfirm: string[] } | null} 无门控节返回 null（调用方按默认处理）
 */
export function parseGateDecl(text) {
  const lines = String(text || '').split('\n')
  // 找 ## 门控 节（其后的行直到下一个 # 标题）
  let inGate = false
  let needConfirm = []
  let found = false
  for (const ln of lines) {
    const t = ln.trim()
    if (/^#{1,3}\s*门控/.test(t)) { inGate = true; found = true; continue }
    if (inGate && /^#{1,3}\s/.test(t)) break // 下一节
    if (!inGate) continue
    // 匹配「需 human 确认: X, Y」类行；类型列表按逗号/顿号切分（type 名可含空格）
    const m = t.match(/^[>*-]?\s*需\s*(human\s*)?确认\s*[:：]\s*(.+)$/i)
    if (m) {
      needConfirm = m[2].split(/[,，、]+/).map((s) => s.trim()).filter(Boolean)
    }
  }
  if (!found) return null
  return { needConfirm }
}

/**
 * 判定某目录下某 type 是否需要 human 确认。
 * 叠加语义：子目录声明覆盖父目录（取「最近含门控节的声明」；若链上无声明 → 默认自动记录）。
 * @returns {Promise<{ needConfirm: boolean, via: string | null }>}
 */
export async function gateForType(root, dir, type) {
  const rules = await readRules(root, dir)
  // 从最近往根找第一个含门控节的声明
  for (let i = rules.length - 1; i >= 0; i--) {
    const decl = parseGateDecl(rules[i].content)
    if (decl) {
      return { needConfirm: decl.needConfirm.includes(type), via: rules[i].path }
    }
  }
  return { needConfirm: false, via: null }
}
