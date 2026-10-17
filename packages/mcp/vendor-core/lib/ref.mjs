/**
 * ref.mjs —— 概念引用的绝对路径渲染（五形态共用）。
 *
 * 背景：`wiki_list` / `wiki_search` / `wiki_get` 等工具一直以来只返回 **bundle 相对 id**
 * （如 `永辉/sql/computations/某查询`）。宿主（DSH 等）的系统提示词要求「给已存在的文件
 * 加链接时用相对工作目录的路径或绝对路径」，模型于是把这个 id 原样套进 Markdown 链接；
 * 而 bundle 常挂在 iCloud / 飞书缓存等 **cwd 之外** 的目录，`永辉/...` 在 cwd 下必然解析失败。
 *
 * 修法不是加一条提示词禁令（模型仍可违反、且每种形态都要各自注入），而是**让工具直接给出
 * 真实绝对路径**：模型复制即可被宿主正确解析，歧义从源头消失。
 *
 * 约定：
 * - id 仍是概念身份（写入、检索、链接图一律用 id），**绝不改成绝对路径**；
 * - 绝对路径只作为**附带展示信息**，用于回复里贴链接 / 给宿主解析；
 * - 渲染成 `title  (id)  ->  /abs/path.md` 形态，箭头指向可直接用作链接目标的真实路径。
 */

import { isAbsolute, join, normalize, sep } from 'node:path'

/** bundle 根（绝对路径）→ 规范化：去尾分隔符，保证可直接与 id 拼接。 */
export function bundleRootOf(root) {
  if (!root) return ''
  let r = normalize(String(root))
  while (r.length > 1 && r.endsWith(sep)) r = r.slice(0, -1)
  return r
}

/**
 * 概念 id → 该概念文件的绝对路径。
 * - root 为空 → 返回空串（调用方自行降级，不抛错）；
 * - root 本身是绝对路径则原样参与拼接（不做 resolve，避免把相对路径错误地锚到 cwd）。
 *
 * 【后缀判定只看 rel（id），不看拼接结果】——id 才是扩展名的唯一来源；
 * 拿 joined 判定会把「root 目录名恰好以 .md 结尾」这类情况搅进来，语义含糊。
 */
export function conceptAbsPath(root, id) {
  const base = bundleRootOf(root)
  if (!base || !id) return ''
  const rel = String(id).replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel) return ''
  if (isAbsolute(rel)) return rel
  return base + '/' + (rel.endsWith('.md') ? rel : rel + '.md')
}

/**
 * 路径是否可安全用作宿主（DSH 等）的链接目标。
 *
 * 宿主解析器（DSH `k8`）的实际行为：取 `#` 前部分为路径 → 对含 `?` 的直接放弃 →
 * 拒绝空串/控制字符/`//` 开头/带 scheme 的串 → 其余 `decodeURIComponent` 后当文件路径。
 * 因此含 `?` 的路径必然解析失败，宁可不给（降级为不带绝对路径的旧形态），也不给死链。
 */
function linkable(path) {
  if (!path) return false
  if (path.includes('?')) return false
  return !/[\u0000-\u001f\u007f]/.test(path)
}

/**
 * 概念 id → 可直接粘贴进 Markdown 链接的绝对路径（**含尖括号**）。
 *
 * 【为什么必须带尖括号】宿主提示词与 CommonMark 都要求含空格的路径用 `<...>` 包裹；
 * 本机 bundle 路径含空格（`Mobile Documents/iCloud~md~obsidian/…`），裸路径会在第一个
 * 空格处被截断成死链。宿主解析器（DSH `k8`）取到的则是尖括号内的裸路径。
 *
 * 【为什么统一在这里加，而不是各形态各加】五形态（dsh/codex/pi/mcp/skill）都要渲染这行，
 * 各加一次必然漂移（`mcp/test/parity.test.mjs` 正是逐字节对拍 MCP 与 DSH 输出）。
 * 各形态一律消费本函数，一致性由构造保证，不靠约定。
 *
 * 不可链接（无 root / 含 `?` / 含控制字符）时返回空串，调用方降级为不输出。
 */
export function conceptLinkTarget(root, id) {
  const abs = conceptAbsPath(root, id)
  return linkable(abs) ? `<${abs}>` : ''
}

/**
 * 概念的一行引用：`type: title  (id)  ->  <abs path>`
 *
 * 路径本身不做 URL-encode（宿主会 decodeURIComponent，`%20` 反而会被二次编码）。
 * 无 root / 路径不可链接时退化为原形态 `type: title  (id)`——保持旧输出，调用方无需分支。
 */
export function formatConceptRef(root, concept, { typePrefix = '' } = {}) {
  const c = concept || {}
  const head = `${typePrefix}${c.type ? `${c.type}: ` : ''}${c.title || ''}  (${c.id || ''})`
  const target = conceptLinkTarget(root, c.id)
  return target ? `${head}  ->  ${target}` : head
}
