/**
 * wiki_ingest —— 读源入库（llm-wiki 范式，显式触发）。
 *
 * ingest 是「LLM 辅助合成」流程，core 提供确定性骨架：
 * 1. 把外部源文件（raw source）登记进 bundle 的 references/ 区（copy，不改源）
 * 2. 若该源尚无概念页，引导建立来源概念（type: Reference）
 * 3. 实际「提炼/写摘要/补链接」由调用方（agent）基于读到的源内容，
 *    通过 createConcept/updateConcept 完成（走同一门控）
 *
 * 本模块聚焦 1+2 的确定性部分 + 返回给 agent 的 ingest 建议。
 */

import { readFile, copyFile, mkdir, access } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import { createConcept, nowIso } from './write.mjs'
import { readConcept } from './bundle.mjs'
import { appendLog, updateIndex } from './indexlog.mjs'

function sanitizeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|#\[\]\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * 登记一个外部源文件进 bundle。
 * @param {string} root
 * @param {object} p
 * @param {string} p.source 外部源文件绝对路径
 * @param {string} [p.refDir] 登记目录（缺省 references）
 * @param {{producer?:string, version?:string}} [ingestOpts]
 * @returns {Promise<{refPath:string, existed:boolean, sourceConceptId:string|null}>}
 */
export async function ingestSource(root, p, ingestOpts = {}) {
  const refDir = p.refDir || 'references'
  const name = sanitizeName(basename(p.source))
  if (!name) throw new Error('无法从源文件名推导登记名')
  const rel = `${refDir}/${name}`
  const dest = join(root, rel)
  let existed = true
  try {
    await access(dest)
  } catch {
    existed = false
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(p.source, dest)
  }
  // 源概念页（type: Reference，resource 指向登记文件）——若已存在跳过
  // concept id = 登记文件去掉扩展名的 .md（如 references/ingest-src）
  const stem = name.replace(/\.[^.]+$/, '')
  const conceptId = `${refDir}/${stem}`
  const existing = await readConcept(root, conceptId)
  let sourceConceptId = existing ? conceptId : null
  if (!existing) {
    let srcText = ''
    try {
      srcText = await readFile(p.source, 'utf8')
    } catch {
      srcText = '(binary)'
    }
    const firstLine = srcText.split('\n').find((l) => l.trim() && !l.startsWith('---')) || ''
    const title = stem
    const created = await createConcept(root, {
      id: conceptId,
      type: 'Reference',
      title,
      description: `原始来源登记：${stem}`,
      resource: `/${rel}`,
      body: `> Ingested from \`${p.source}\` at ${nowIso()}\n\n${firstLine.slice(0, 200)}`,
      opts: { producer: ingestOpts?.producer || 'llm-wiki', version: ingestOpts?.version || '0.1.0', logAction: false },
    })
    sourceConceptId = created.id
    await appendLog(root, 'Ingest', `Ingested source [${stem}](${conceptId}.md)`)
    await updateIndex(root, { dirs: [refDir] })
  }
  return { refPath: rel, existed, sourceConceptId }
}
