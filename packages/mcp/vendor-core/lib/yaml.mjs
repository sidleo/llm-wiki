/**
 * YAML 子集解析/序列化 —— 覆盖 OKF frontmatter 实际用到的结构。
 *
 * 支持：
 * - 顶层 `key: value` 标量（裸/引号/数字/bool/null）
 * - 行内序列 `[a, b]` 与行内映射 `{ a: x, b: y }`（可嵌套）
 * - 缩进块映射（`key:` 换行后子键）与块序列（`- item` / `- key: val` 项 map）
 * - 全行注释（`#` 开头）
 *
 * 不求覆盖完整 YAML 规范；OKF 官方样例与常规 frontmatter 均在覆盖内。
 * 序列化统一采用「行内风格」写出，保证 round-trip 语义一致。
 */

// ── 词法/基础工具 ──────────────────────────────────────

function inferScalar(raw) {
  const v = raw.trim()
  if (v === '' || v === '~' || v === 'null' || v === 'Null' || v === 'NULL') return null
  if (v === 'true' || v === 'True' || v === 'TRUE') return true
  if (v === 'false' || v === 'False' || v === 'FALSE') return false
  if (/^-?\d+$/.test(v)) return Number(v)
  if (/^-?\d+\.\d+$/.test(v)) return Number(v)
  return v
}

function unquote(v) {
  const s = v.trim()
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) {
    return s.slice(1, -1).replace(/\\(['\\])/g, '$1')
  }
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  return s
}

function isObj(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function parseValueExpr(expr) {
  const e = expr.trim()
  if (!e) return ''
  if (e[0] === '[') {
    if (!e.endsWith(']')) return unquote(e)
    const inner = e.slice(1, -1).trim()
    if (!inner) return []
    return splitTopLevel(inner).map((seg) => parseValueExpr(seg))
  }
  if (e[0] === '{') {
    if (!e.endsWith('}')) return unquote(e)
    const inner = e.slice(1, -1).trim()
    if (!inner) return {}
    const out = {}
    for (const seg of splitTopLevel(inner)) {
      const m = splitKeyVal(seg)
      if (m) out[m[0]] = parseValueExpr(m[1])
    }
    return out
  }
  return inferScalar(unquote(e))
}

function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let cur = ''
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      cur += ch
      if (ch === quote && text[i - 1] !== '\\') quote = ''
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue }
    if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) parts.push(cur)
  return parts
}

function splitKeyVal(seg) {
  const s = seg.trim()
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === quote && s[i - 1] !== '\\') quote = ''
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === ':') {
      const key = s.slice(0, i).trim()
      if (!key) return null
      if (!/^[A-Za-z0-9_.\-/]+$/.test(key)) return null
      return [key, s.slice(i + 1).trim()]
    }
  }
  return null
}

function indentOf(line) {
  let n = 0
  while (n < line.length && line[n] === ' ') n++
  return n
}

// ── 解析（递归下降：map 块 / seq 块）──────────────────

/**
 * @param {{indent:number,text:string}[]} lines
 * @param {number} start 起始下标
 * @param {number} indent 本块行的基准缩进
 * @param {'map'|'seq'} kind
 * @returns {{value: unknown, next: number}}
 */
function parseBlock(lines, start, indent, kind) {
  if (kind === 'map') return parseMap(lines, start, indent)
  return parseSeq(lines, start, indent)
}

/** 解析「键行组」：同一 indent、非 `- ` 开头、形如 key[: value] 的行。 */
function parseMap(lines, start, indent) {
  const out = {}
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent < indent) break
    if (line.indent > indent) { i++; continue } // 防御：过度缩进跳过
    if (line.text.startsWith('- ')) break // 属于外层 seq
    const kv = splitKeyVal(line.text)
    if (!kv) { i++; continue }
    if (kv[1]) {
      out[kv[0]] = parseValueExpr(kv[1])
      i++
    } else {
      // 值在子块：peek 下一行
      const next = i + 1 < lines.length ? lines[i + 1] : null
      if (next && next.indent > indent) {
        const subKind = next.text.startsWith('- ') ? 'seq' : 'map'
        const sub = parseBlock(lines, i + 1, next.indent, subKind)
        out[kv[0]] = sub.value
        i = sub.next
      } else {
        out[kv[0]] = ''
        i++
      }
    }
  }
  return { value: out, next: i }
}

/** 解析序列块：同一 indent 的 `- ` 行；项 body 为 key: val 时该项是 map。 */
function parseSeq(lines, start, indent) {
  const out = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent < indent) break
    if (line.indent > indent) { i++; continue }
    if (!line.text.startsWith('- ')) break // 属于外层 map
    const body = line.text.slice(2).trim()
    const kv = splitKeyVal(body)
    if (!kv) {
      out.push(parseValueExpr(body))
      i++
      continue
    }
    // 项 map
    const item = {}
    if (kv[1]) item[kv[0]] = parseValueExpr(kv[1])
    i++
    // 项 map 的其余键：更深缩进、非 `- ` 行，直至回到本 seq 的 indent 层
    let j = i
    while (j < lines.length && lines[j].indent > indent && !lines[j].text.startsWith('- ')) {
      // 该项 map 的剩余键可能与首行键同层也可能更深；按 键行组 处理：
      const sub = parseMap(lines, j, lines[j].indent)
      for (const [k, v] of Object.entries(sub.value)) {
        if (!(k in item)) item[k] = v
      }
      j = sub.next
    }
    if (kv[1] === undefined || kv[1] === '') {
      // 首键空值：若下一行更深且是 map/seq 子块，已由上面循环处理；若 body 无值且无子行，置空
      if (!(kv[0] in item)) item[kv[0]] = ''
    }
    out.push(item)
    i = j
  }
  return { value: out, next: i }
}

/**
 * 解析 YAML 子集文本为 JS 对象。
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parseYaml(text) {
  const lines = []
  for (const raw of String(text).split('\n')) {
    const s = raw.replace(/^\uFEFF/, '').replace(/\r$/, '')
    const t = s.trim()
    if (!t || t.startsWith('#')) continue
    lines.push({ indent: indentOf(s), text: t })
  }
  if (!lines.length) return {}
  // 顶层必须是 0 缩进的 map
  return parseMap(lines, 0, 0).value
}

// ── 序列化 ─────────────────────────────────────────────

function quoteScalar(s) {
  const str = String(s)
  if (str === '') return "''"
  const needs =
    /^[\s\-?:,\[\]{}#&*!|>'"%@`]/.test(str) ||
    /[\s,:\[\]{}#]/.test(str) ||
    /^(true|false|null|~)$/i.test(str) ||
    /^-?\d+(\.\d+)?$/.test(str)
  if (!needs) return str
  return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function inlineValue(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) {
    return '[' + v.map((x) => (isObj(x) || Array.isArray(x) ? inlineValue(x) : quoteScalar(x))).join(', ') + ']'
  }
  if (typeof v === 'object') {
    const parts = Object.entries(v).map(([k, val]) => `${k}: ${inlineValue(val)}`)
    return '{ ' + parts.join(', ') + ' }'
  }
  return quoteScalar(v)
}

/** 把 JS 对象序列化为 YAML 子集文本（顶层键值 + 嵌套行内）。 */
export function stringifyYaml(obj) {
  const lines = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue
    lines.push(`${k}: ${inlineValue(v)}`)
  }
  return lines.join('\n')
}
