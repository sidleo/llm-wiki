/**
 * 写操作：create / update / deprecate（含门控规则读取与 log/index 维护）。
 *
 * 门控：不在此强制弹窗。写入方（工具/CLI）调用前先 resolveRules(dir)
 * 读取 AGENTS.md 门控约定，需要 human 确认的类型由上层交互；本模块
 * 负责把 trust 字段正确写入：
 * - 无 confirmed  → generated:{by: agent:<producer>/<ver>}，无 verified
 * - confirmed     → 追加 verified:[{by: human:<user>}]
 */

import { readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { splitFrontmatter, serializeDoc } from './doc.mjs'
import { isReserved, buildGraph } from './bundle.mjs'
import { appendLog, updateIndex } from './indexlog.mjs'

/** 当前时间 ISO 8601（UTC） */
export function nowIso() {
  return new Date().toISOString()
}

/** 检查 id（concept 相对路径）是否合法：非空、不以 / 结尾、不以 . 段开头、非保留名。 */
export function checkId(id) {
  if (!id || typeof id !== 'string') return 'id 不能为空'
  const clean = id.replace(/^\/+/, '').replace(/\.md$/, '')
  const segs = clean.split('/')
  for (const s of segs) {
    if (!s) return `id 含空路径段: ${id}`
    if (s === '.' || s === '..') return `id 不得含 . / .. : ${id}`
    if (isReserved(s) && segs.length === 1) return `id 与保留文件名冲突: ${id}`
  }
  return null
}

function buildMeta({ type, title, description, resource, tags, status, staleAfter, runtime, parameters, computation, executor, attester, sources, extra }) {
  const meta = {}
  if (type) meta.type = type
  if (title) meta.title = title
  if (description) meta.description = description
  if (resource) meta.resource = resource
  if (tags?.length) meta.tags = tags
  if (status) meta.status = status
  if (staleAfter) meta.stale_after = staleAfter
  if (runtime) meta.runtime = runtime
  if (parameters?.length) meta.parameters = parameters
  if (computation) meta.computation = computation
  if (executor) meta.executor = executor
  if (attester) meta.attester = attester
  if (sources?.length) meta.sources = sources
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== null && v !== '') meta[k] = v
    }
  }
  return meta
}

/**
 * 新增 concept。
 * @param {string} root
 * @param {object} p
 * @param {string} p.id Concept ID（bundle 相对路径，不含 .md）
 * @param {string} p.type REQUIRED
 * @param {string} [p.title] 缺省用文件名
 * @param {string} [p.description]
 * @param {string} [p.body]
 * @param {{confirmed?:boolean, user?:string, producer?:string, version?:string, logAction?:boolean}} [p.opts]
 */
export async function createConcept(root, p) {
  const idErr = checkId(p.id)
  if (idErr) throw new Error(idErr)
  if (!p.type) throw new Error('type 必填')
  const file = join(root, `${p.id}.md`)
  const existing = await fileExists(file)
  if (existing) throw new Error(`概念已存在: ${p.id}（如需修改用 update）`)

  const meta = buildMeta({ ...p, type: p.type, title: p.title, description: p.description })
  const producer = p.opts?.producer || 'llm-wiki'
  const version = p.opts?.version || '0.1.0'
  const gen = { by: p.opts?.confirmed ? `agent:${producer}/${version}` : `agent:${producer}/${version}`, at: nowIso() }
  meta.generated = gen
  if (p.opts?.confirmed) {
    const user = p.opts.user || 'human:unknown'
    meta.verified = [{ by: user.startsWith('human:') ? user : `human:${user}`, at: nowIso() }]
  }

  const text = serializeDoc({ meta, body: p.body || '' })
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)

  if (p.opts?.logAction !== false) {
    const title = meta.title || p.id.split('/').pop()
    const dir = dirname(p.id).replace(/\\/g, '/') === '.' ? '' : dirname(p.id).replace(/\\/g, '/')
    await appendLog(root, 'Creation', `Added [${title}](${p.id}.md)`)
    await updateIndex(root, { dirs: [dir] })
  }
  return { id: p.id, file }
}

/**
 * 更新已有 concept：仅更新传入字段；meta 由 newMeta 整段替换（调用方传全量）或 merge。
 * 本实现取 merge 语义：读旧 meta，覆盖传入字段，保留其余；trust 字段自动维护。
 */
export async function updateConcept(root, id, p) {
  const file = join(root, `${id}.md`)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw new Error(`概念不存在: ${id}`)
  }
  const { meta: oldMeta, body: oldBody, hasFM } = splitFrontmatter(text)
  if (!hasFM) throw new Error(`概念缺少 frontmatter，拒绝覆写: ${id}`)

  const next = { ...oldMeta }
  const assign = (k, v) => {
    if (v !== undefined && v !== null) next[k] = v
  }
  if (p.type) assign('type', p.type)
  if (p.title !== undefined) assign('title', p.title)
  if (p.description !== undefined) assign('description', p.description)
  if (p.resource !== undefined) assign('resource', p.resource)
  if (p.tags !== undefined) assign('tags', p.tags)
  if (p.status !== undefined) assign('status', p.status)
  if (p.staleAfter !== undefined) assign('stale_after', p.staleAfter)
  if (p.runtime !== undefined) assign('runtime', p.runtime)
  if (p.parameters !== undefined) assign('parameters', p.parameters)
  if (p.computation !== undefined) assign('computation', p.computation)
  if (p.executor !== undefined) assign('executor', p.executor)
  if (p.attester !== undefined) assign('attester', p.attester)
  if (p.sources !== undefined) assign('sources', p.sources)
  // trust：更新总是刷新 generated.at（内容变化）；confirmed 追加 verified
  const producer = p.opts?.producer || 'llm-wiki'
  const version = p.opts?.version || '0.1.0'
  next.generated = { by: `agent:${producer}/${version}`, at: nowIso() }
  if (p.opts?.confirmed) {
    const user = (p.opts.user || 'human:unknown').startsWith('human:') ? p.opts.user : `human:${p.opts.user || 'unknown'}`
    const list = Array.isArray(next.verified) ? next.verified : next.verified ? [next.verified] : []
    const existing = list.filter((v) => v && v.by === user)
    if (existing.length) {
      existing[0].at = nowIso()
    } else {
      list.push({ by: user, at: nowIso() })
    }
    next.verified = list
  }

  const body = p.body !== undefined ? p.body : oldBody
  const outText = serializeDoc({ meta: next, body })
  await writeFile(file, outText)

  const title = next.title || id.split('/').pop()
  const dir = dirname(id).replace(/\\/g, '/') === '.' ? '' : dirname(id).replace(/\\/g, '/')
  await appendLog(root, 'Update', `Updated [${title}](${id}.md)`)
  await updateIndex(root, { dirs: [dir] })
  return { id }
}

/**
 * 批量标 deprecated（目录级生效开关）。
 * @param {string} root
 * @param {string} dir bundle 相对目录（'' = 全库）
 */
export async function deprecateDir(root, dir) {
  const graph = await buildGraph(root)
  const prefix = dir ? dir.replace(/\/+$/, '') + '/' : ''
  const targets = [...graph.nodes.keys()].filter((id) => (prefix ? id.startsWith(prefix) : true))
  let n = 0
  for (const id of targets) {
    const file = join(root, `${id}.md`)
    const text = await readFile(file, 'utf8')
    const { meta, body, hasFM } = splitFrontmatter(text)
    if (!hasFM) continue
    if (meta.status === 'deprecated') continue
    meta.status = 'deprecated'
    const producer = 'llm-wiki'
    meta.generated = { by: `agent:${producer}/0.1.0`, at: nowIso() }
    await writeFile(file, serializeDoc({ meta, body }))
    n++
  }
  if (n > 0) {
    await appendLog(root, 'Deprecation', `Deprecated ${n} concept(s) under ${dir || '(bundle root)'}`)
    await updateIndex(root, { dirs: [dir] })
  }
  return { deprecated: n, total: targets.length }
}

async function fileExists(p) {
  try {
    await import('node:fs/promises').then((fs) => fs.access(p))
    return true
  } catch {
    return false
  }
}
