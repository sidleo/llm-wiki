/**
 * migrate.mjs —— 把旧 dsh-kb（~/.agents/kb）与 dsh-sqlkb（~/.agents/sqlkb）
 * 数据迁移成 OKF v0.2 合规 bundle（copy 不 move、默认 --dry-run）。
 *
 * 映射规则：
 * - kb 条目（目录即分类）→ 目标 <target>/<分类路径>/<文件名>.md
 *   type 按分类路径末段推断（口径/架构/数据分析→Reference 或自定义），默认 Reference
 * - sqlkb tables → <target>/tables/<表名>.md，type: Table
 * - sqlkb examples → <target>/examples/…，type: Attested Computation（含 SQL 则保留）
 * - sqlkb pitfalls → <target>/pitfalls/<坑名>.md，type: Pitfall
 *
 * frontmatter 映射：title=旧 name，description=旧 summary/purpose/type 说明，
 * tags 逗号串→数组，丢弃 related/enabled 等旧字段；generated 记迁移时间。
 * 绝不删除源目录；输出变更清单 + 冲突报告。
 *
 * 用法：
 *   node scripts/migrate.mjs --fromKb ~/.agents/kb --fromSqlkb ~/.agents/sqlkb --to ~/.agents/wiki --dry-run
 *   node scripts/migrate.mjs --to ~/.agents/wiki          # 用默认源路径
 */

import { readdir, readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises'
import { join, relative, basename, dirname, extname } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_KB = join(homedir(), '.agents', 'kb')
const DEFAULT_SQLKB = join(homedir(), '.agents', 'sqlkb')
const DEFAULT_TO = join(homedir(), '.agents', 'wiki')

function parseArgs(argv) {
  const o = { dryRun: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--to') o.to = argv[++i]
    else if (a === '--fromKb') o.fromKb = argv[++i]
    else if (a === '--fromSqlkb') o.fromSqlkb = argv[++i]
    else if (a === '--real') o.dryRun = false
    else if (a === '--dry-run') o.dryRun = true
  }
  return o
}

/** 简单 frontmatter 读取（旧库 frontmatter 结构扁平，无需完整 YAML） */
function parseLegacyFM(text) {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return { meta: {}, body: text }
  const end = lines.indexOf('---', 1)
  if (end < 0) return { meta: {}, body: text }
  const meta = {}
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(lines[i])
    if (m) meta[m[1]] = m[2].trim()
  }
  return { meta, body: lines.slice(end + 1).join('\n').trim() }
}

function toList(v) {
  return String(v || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function nowIso() {
  return new Date().toISOString()
}

function serializeDoc(meta, body) {
  const inline = (v) => {
    if (v === null || v === undefined) return 'null'
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    if (typeof v === 'number') return String(v)
    if (Array.isArray(v)) return '[' + v.map((x) => (typeof x === 'object' ? inline(x) : q(x))).join(', ') + ']'
    if (typeof v === 'object') {
      return '{ ' + Object.entries(v).map(([k, val]) => `${k}: ${inline(val)}`).join(', ') + ' }'
    }
    return q(v)
  }
  const q = (s) => {
    const str = String(s)
    const needs = /[\s,:\[\]{}#"]/.test(str) || /^[\-?]/.test(str) || /^(true|false|null)$/i.test(str)
    return needs ? `"${str.replace(/"/g, '\\"')}"` : str
  }
  const fm = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${inline(v)}`)
    .join('\n')
  return `---\n${fm}\n---\n\n${String(body || '').trimEnd()}\n`
}

/** 收集目录下全部 .md（相对路径，posix） */
async function collectMd(root) {
  const out = []
  async function walk(rel) {
    let entries
    try { entries = await readdir(join(root, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(r)
      else if (e.isFile() && e.name.endsWith('.md') && !['README.md'].includes(e.name)) out.push(r)
    }
  }
  await walk('')
  return out.sort()
}

function inferKbType(dirRel) {
  const seg = dirRel.split('/')
  const last = seg[seg.length - 1] || ''
  const map = {
    口径: '口径',
    业务口径: '口径',
    架构: '架构',
    组织架构: '架构',
    数据分析: '经验',
    经验: '经验',
    基础设施: '基础设施',
    看板应用: '笔记',
    笔记: '笔记',
  }
  return map[last] || 'Reference'
}

/** 把旧正文里的表名/相关条目转成链接（尽力而为） */
function linkifyBody(body, tableIds) {
  let b = String(body || '')
  // 反引号包裹的表名（dm.dm_xxx）如果 tableIds 里有，转 markdown 链接
  const re = /`([a-z0-9_.]+)`/gi
  b = b.replace(re, (full, name) => {
    const lower = name.toLowerCase()
    if (tableIds.has(lower)) return `[${name}](/sqlkb/tables/${lower}.md)`
    return full
  })
  return b
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const fromKb = o.fromKb || DEFAULT_KB
  const fromSqlkb = o.fromSqlkb || DEFAULT_SQLKB
  const to = o.to || DEFAULT_TO

  console.log(`migrate ${o.dryRun ? '(DRY-RUN)' : '(REAL)'}`)
  console.log(`  from kb:    ${fromKb}`)
  console.log(`  from sqlkb: ${fromSqlkb}`)
  console.log(`  to:         ${to}`)
  console.log('')

  const report = { created: [], conflicts: [], errors: [] }

  // 预扫 sqlkb tables 全集（供 linkify）
  const tableIds = new Set()
  const sqlkbTablesDir = join(fromSqlkb, 'tables')
  try {
    for (const f of await readdir(sqlkbTablesDir)) {
      if (f.endsWith('.md')) tableIds.add(f.slice(0, -3).toLowerCase())
    }
  } catch { /* sqlkb 不存在 */ }

  async function planWrite(relTarget, content) {
    const dest = join(to, relTarget)
    try {
      await access(dest)
      report.conflicts.push(`${relTarget}: 目标已存在，跳过`)
      return
    } catch {
      // 不存在
    }
    report.created.push(relTarget)
    if (!o.dryRun) {
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, content)
    }
  }

  // ── kb 目录 → 领域 kb/（目录即分类保留路径） ──
  let kbDirExists = true
  try { await access(fromKb) } catch { kbDirExists = false }
  if (kbDirExists) {
    const files = await collectMd(fromKb)
    for (const rel of files) {
      const full = join(fromKb, rel)
      const text = await readFile(full, 'utf8')
      const { meta, body } = parseLegacyFM(text)
      const dirRel = dirname(rel).replace(/\\/g, '/')
      const type = inferKbType(dirRel)
      const outMeta = {
        type,
        title: meta.title || meta.name || basename(rel, '.md'),
        description: meta.summary || meta.description || '',
        tags: toList(meta.tags),
        generated: { by: 'process:migrate', at: nowIso() },
      }
      const outBody = `> 迁移自旧 dsh-kb 分类：\`${dirRel}\`\n\n${body}`
      const target = dirRel === '.' ? `${basename(rel, '.md')}.md` : `${dirRel}/${basename(rel, '.md')}.md`
      await planWrite(`kb/${target}`, serializeDoc(outMeta, outBody))
    }
  }

  // ── sqlkb tables → tables/ ──
  const sqlkbExists = await dirExists(join(fromSqlkb, 'tables'))
  if (sqlkbExists) {
    for (const f of await readdir(join(fromSqlkb, 'tables'))) {
      if (!f.endsWith('.md')) continue
      const text = await readFile(join(fromSqlkb, 'tables', f), 'utf8')
      const { meta, body } = parseLegacyFM(text)
      const tableName = meta.name || basename(f, '.md')
      const outMeta = {
        type: 'Table',
        title: tableName,
        description: meta.purpose || meta.description || '',
        tags: toList(meta.tags),
        generated: { by: 'process:migrate', at: nowIso() },
      }
      const engineNote = meta.engines ? `（引擎：${meta.engines}）` : ''
      const execNote = meta.exec ? `；执行：${meta.exec}` : ''
      const legacyType = meta.type ? `；旧分类：${meta.type}` : ''
      const outBody = `> 迁移自旧 dsh-sqlkb tables${legacyType}${engineNote}${execNote}\n\n${body}`
      await planWrite(`sqlkb/tables/${basename(f, '.md')}.md`, serializeDoc(outMeta, outBody))
    }
  }

  // ── sqlkb examples → computations/（Attested Computation 或 Reference） ──
  if (await dirExists(join(fromSqlkb, 'examples'))) {
    for (const f of await readdir(join(fromSqlkb, 'examples'))) {
      if (!f.endsWith('.md')) continue
      const text = await readFile(join(fromSqlkb, 'examples', f), 'utf8')
      const { meta, body } = parseLegacyFM(text)
      const hasSql = /```sql|select\s/i.test(body)
      const outMeta = {
        type: hasSql ? 'Attested Computation' : 'Reference',
        title: meta.name || basename(f, '.md'),
        description: meta.purpose || meta.description || '',
        tags: toList(meta.tags),
        generated: { by: 'process:migrate', at: nowIso() },
      }
      const tableNote = meta.tables ? `；涉及表：${meta.tables}` : ''
      const linkedBody = `> 迁移自旧 dsh-sqlkb examples${tableNote}\n\n${linkifyBody(body, tableIds)}`
      await planWrite(`sqlkb/computations/${basename(f, '.md')}.md`, serializeDoc(outMeta, linkedBody))
    }
  }

  // ── sqlkb pitfalls → pitfalls/ ──
  if (await dirExists(join(fromSqlkb, 'pitfalls'))) {
    for (const f of await readdir(join(fromSqlkb, 'pitfalls'))) {
      if (!f.endsWith('.md')) continue
      const text = await readFile(join(fromSqlkb, 'pitfalls', f), 'utf8')
      const { meta, body } = parseLegacyFM(text)
      const kindNote = meta.type ? `（坑类型：${meta.type}）` : ''
      const sevNote = meta.severity ? `［严重度：${meta.severity}］` : ''
      const desc = `${meta.summary || ''}${sevNote}`.trim()
      const outMeta = {
        type: 'Pitfall',
        title: meta.name || basename(f, '.md'),
        description: desc || body.slice(0, 80),
        tags: toList(meta.tags),
        generated: { by: 'process:migrate', at: nowIso() },
      }
      const linkedBody = `> 迁移自旧 dsh-sqlkb pitfalls${kindNote}\n\n${linkifyBody(body, tableIds)}`
      await planWrite(`sqlkb/pitfalls/${basename(f, '.md')}.md`, serializeDoc(outMeta, linkedBody))
    }
  }

  console.log(`计划创建 ${report.created.length} 个概念文件（kb: ${report.created.filter((c) => c.startsWith('kb/')).length}, sqlkb: ${report.created.length - report.created.filter((c) => c.startsWith('kb/')).length}）`)
  if (report.conflicts.length) {
    console.log('\n冲突（目标已存在，跳过）:')
    for (const c of report.conflicts) console.log('  ' + c)
  }
  if (report.errors.length) {
    console.log('\n错误:')
    for (const e of report.errors) console.log('  ' + e)
  }
  if (o.dryRun) {
    console.log('\nDRY-RUN：未写任何文件。确认无误后加 --real 执行。')
  } else {
    console.log('\n迁移完成（copy，源目录未动）。')
  }
  console.log(`\n查看清单前 20 条：`)
  report.created.slice(0, 20).forEach((c) => console.log('  + ' + c))
  if (report.created.length > 20) console.log(`  … 其余 ${report.created.length - 20} 条`)
}

async function dirExists(p) {
  try { await access(p); return true } catch { return false }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
