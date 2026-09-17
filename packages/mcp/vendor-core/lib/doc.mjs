/**
 * Concept 文档解析：frontmatter 切分、提取、链接抽取与归一化。
 */

import { parseYaml } from './yaml.mjs'

/** 从文本切分 frontmatter 与正文。返回 { meta, body, hasFM } */
export function splitFrontmatter(text) {
  const lines = String(text).split('\n')
  if (lines[0]?.trim() !== '---') return { meta: {}, body: text, hasFM: false }
  const end = lines.indexOf('---', 1)
  if (end < 0) return { meta: {}, body: text, hasFM: false }
  const fm = lines.slice(1, end).join('\n')
  return { meta: parseYaml(fm), body: lines.slice(end + 1).join('\n'), hasFM: true }
}

/** 从 meta + body 序列化回 markdown 文件文本。 */
export function serializeDoc({ meta, body }) {
  const fm = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${inlineValue(v)}`)
    .join('\n')
  const out = ['---', fm, '---']
  const b = String(body || '').trim()
  if (b) out.push('', b)
  return out.join('\n') + '\n'
}

function inlineValue(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) {
    return '[' + v.map((x) => (isObj(x) || Array.isArray(x) ? inlineValue(x) : inlineScalar(x))).join(', ') + ']'
  }
  if (typeof v === 'object') {
    const parts = Object.entries(v).map(([k, val]) => `${k}: ${inlineValue(val)}`)
    return '{ ' + parts.join(', ') + ' }'
  }
  return inlineScalar(v)
}

function isObj(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function inlineScalar(s) {
  const str = String(s)
  if (str === '') return "''"
  const needs =
    /^[\s\-?:,\[\]{}#&*!|>'"%@`]/.test(str) ||
    /[\s,:\[\]{}#]/.test(str) ||
    /^(true|false|null|~)$/i.test(str) ||
    /^-?\d+(\.\d+)?$/.test(str)
  return needs ? `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : str
}

// ── 链接 ────────────────────────────────────────────────

/** 相对路径归一化为 bundle 相对（以 / 开头）。baseDir 为概念文件所在目录（bundle 内相对，不含前导 /）。 */
export function normalizeLink(raw, baseDir) {
  let target = String(raw || '').trim()
  if (!target) return null
  // 去掉锚点
  target = target.split('#')[0]
  if (!target) return null
  // 外部 URL 不算内部链接
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return null
  if (target.startsWith('mailto:') || target.startsWith('tel:')) return null
  if (target.startsWith('/')) {
    // bundle 相对：去掉前导 /，去掉 .md 后缀保持统一（Concept ID 无 .md）
    return stripMd(target.slice(1))
  }
  // 相对路径：相对 baseDir 解析
  const parts = []
  if (baseDir) parts.push(...baseDir.split('/').filter(Boolean))
  for (const seg of target.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return stripMd(parts.join('/'))
}

function stripMd(p) {
  return p.endsWith('.md') ? p.slice(0, -3) : p
}

/** 从正文抽取全部内部链接（归一化后的 bundle 相对 ID 集合）。支持 markdown 链接与 [[wiki-link]]。 */
export function extractLinks(body, baseDir) {
  const out = new Set()
  const text = String(body || '')
  // markdown 链接 [text](target) —— 排除图片 ![]( ) 与脚注 [^id]
  const mdRe = /(?<![!^])\[[^\]]*\]\(([^)]+)\)/g
  let m
  while ((m = mdRe.exec(text)) !== null) {
    const t = m[1]
    // 去掉 title 部分 "title" 与可选空格
    const bare = t.replace(/\s+["'].*["']\s*$/, '').trim()
    const n = normalizeLink(bare, baseDir)
    if (n) out.add(n)
  }
  // obsidian [[wiki-link|alias]] 与 [[#anchor]] 与 [[path/to/file]]
  // wiki-link 语义：始终按 bundle 根解析（不含 / 的最短名 = 根相对 ID；
  // 含 / 的路径 = 完整 Concept ID），不叠加 baseDir —— 与 Obsidian 一致
  const wlRe = /\[\[([^\]]+)\]\]/g
  while ((m = wlRe.exec(text)) !== null) {
    let t = m[1].trim()
    t = t.split('|')[0].trim() // 去掉 alias
    if (t.startsWith('#')) continue // 内部锚点
    if (t.startsWith('^')) continue // 块引用
    const n = normalizeLink(t, '')
    if (n) out.add(n)
  }
  return [...out]
}

/** 从正文抽取来源脚注 label 集：[^id] 的 id。 */
export function extractFootnoteIds(body) {
  const out = new Set()
  const re = /\[\^([A-Za-z0-9_.\-]+)\]/g
  let m
  while ((m = re.exec(String(body || ''))) !== null) out.add(m[1])
  return [...out]
}
