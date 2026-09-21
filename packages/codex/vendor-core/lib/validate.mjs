/**
 * wiki_validate —— OKF v0.2 合规校验。
 *
 * 判据：
 * 1. 每个非保留 .md 含可解析 YAML frontmatter
 * 2. 每个 frontmatter 含非空 type
 * 3. 保留文件（index/log/AGENTS.md）符合既定结构
 *
 * 不因缺可选字段/未知 type/未知键/断链/缺 index 判失败（只进 warn）。
 */

import { scanConceptPaths, readConcept, isReserved } from './bundle.mjs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * @param {string} root bundle 根
 * @returns {Promise<{ok:boolean, errors:string[], warnings:string[]}>}
 */
export async function validateBundle(root) {
  const errors = []
  const warnings = []
  const paths = await scanConceptPaths(root)

  // 1+2. 概念文档
  for (const relPath of paths) {
    const id = relPath.endsWith('.md') ? relPath.slice(0, -3) : relPath
    const concept = await readConcept(root, id)
    if (!concept) { errors.push(`${relPath}: 无法读取`); continue }
    if (!concept.hasFM) {
      errors.push(`${relPath}: 缺少 frontmatter（须以 --- 开头）`)
    } else if (!concept.type) {
      errors.push(`${relPath}: frontmatter 缺少非空 type 字段`)
    }
    // stale/status 家族检查（仅 warn）
    const { meta } = concept
    if (meta.stale_after != null && !/^\d{4}-\d{2}-\d{2}T/.test(String(meta.stale_after))) {
      warnings.push(`${relPath}: stale_after 建议用 ISO 8601 datetime（${meta.stale_after}）`)
    }
    if (meta.generated && typeof meta.generated === 'object' && meta.generated.by == null) {
      warnings.push(`${relPath}: generated 缺少 by 字段`)
    }
  }

  // 3. 保留文件结构检查
  await checkReservedFiles(root, errors, warnings)

  return { ok: errors.length === 0, errors, warnings }
}

async function checkReservedFiles(root, errors, warnings) {
  // index.md / log.md / AGENTS.md 可出现在任意层级；递归检查所有目录
  const dirs = await collectDirs(root)
  for (const d of dirs) {
    const rel = d ? d + '/' : ''
    // index.md：无 frontmatter（除根目录可带 okf_version）
    for (const name of ['index.md']) {
      const p = join(root, rel + name)
      const { exists, startsFM } = await probeFile(p)
      if (!exists) continue
      if (startsFM && rel !== '') {
        errors.push(`${rel}index.md: 非根目录 index.md 不应含 frontmatter`)
      }
    }
    // AGENTS.md：本项目保留文件，无结构要求（豁免 type）
    // log.md：日期标题约定仅 warn
    const logP = join(root, rel + 'log.md')
    const logExists = await fileExists(logP)
    if (logExists) {
      warnings.push(`${rel}log.md: 存在（结构约定：ISO-8601 日期标题，最新在前）`)
    }
  }
}

async function collectDirs(root) {
  const out = []
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

async function probeFile(p) {
  try {
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(p, 'utf8')
    return { exists: true, startsFM: text.trim().startsWith('---') }
  } catch {
    return { exists: false, startsFM: false }
  }
}

async function fileExists(p) {
  try {
    await import('node:fs/promises').then((fs) => fs.access(p))
    return true
  } catch {
    return false
  }
}
