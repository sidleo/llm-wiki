/**
 * Bundle 扫描与链接图。
 *
 * bundle = 目录树。保留文件 index.md / log.md / AGENTS.md 不作 concept。
 * Concept ID = bundle 相对路径去掉 .md（如 tables/orders）。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, dirname, basename } from 'node:path'
import { splitFrontmatter, extractLinks } from './doc.mjs'

export const RESERVED = new Set(['index.md', 'log.md', 'AGENTS.md', 'CLAUDE.md', 'CODEBUDDY.md'])

/** 是否为保留文件名（任意层级） */
export function isReserved(name) {
  return RESERVED.has(name)
}

/** 递归扫描 bundle，返回 concept 文件相对路径列表（posix 形式）。 */
export async function scanConceptPaths(root) {
  const out = []
  async function walk(dir, rel) {
    let entries
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue // 隐藏文件/目录（.obsidian 等）
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        await walk(dir, relPath)
      } else if (e.isFile() && e.name.endsWith('.md') && !isReserved(e.name)) {
        out.push(relPath)
      }
    }
  }
  await walk(root, '')
  return out.sort()
}

/**
 * 读取并解析单个 concept 文件。
 * @returns {Promise<{id:string, path:string, meta:object, body:string, title:string, type:string, desc:string, hasFM:boolean}> | null}
 */
export async function readConcept(root, id) {
  const relPath = `${id}.md`
  let text
  try {
    text = await readFile(join(root, relPath), 'utf8')
  } catch {
    return null
  }
  const { meta, body, hasFM } = splitFrontmatter(text)
  const type = meta.type != null ? String(meta.type) : ''
  const title = meta.title != null ? String(meta.title) : basename(id)
  const desc = meta.description != null ? String(meta.description) : ''
  return { id, path: relPath, meta, body, title, type, desc, hasFM }
}

/**
 * 构建链接图。返回 Map<conceptId, {concept, links:Set<id>}> 及派生反向索引。
 * broken links 保留（不剔除），供 lint。
 */
export async function buildGraph(root) {
  const paths = await scanConceptPaths(root)
  const nodes = new Map() // id -> concept
  const forward = new Map() // id -> Set<targetId>
  const back = new Map() // targetId -> Set<id>（含 broken target）
  for (const relPath of paths) {
    const id = relPath.endsWith('.md') ? relPath.slice(0, -3) : relPath
    const concept = await readConcept(root, id)
    if (!concept) continue
    nodes.set(id, concept)
    const baseDir = dirname(id).replace(/\\/g, '/')
    const links = extractLinks(concept.body, baseDir === '.' ? '' : baseDir)
    forward.set(id, new Set(links))
    for (const t of links) {
      if (!back.has(t)) back.set(t, new Set())
      back.get(t).add(id)
    }
  }
  return { nodes, forward, back }
}

/** 从链接图读取；backlinks 由 buildGraph 提供。 */
export function dirOf(id) {
  return dirname(id).replace(/\\/g, '/')
}

/** bundle 根 index.md 的 okf_version 读取。 */
export async function readOkfVersion(root) {
  try {
    const text = await readFile(join(root, 'index.md'), 'utf8')
    if (!text.trim().startsWith('---')) return null
    const { meta } = splitFrontmatter(text)
    return meta.okf_version != null ? String(meta.okf_version) : null
  } catch {
    return null
  }
}

export { relative }
