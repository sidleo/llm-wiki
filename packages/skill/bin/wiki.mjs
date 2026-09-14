#!/usr/bin/env node
/**
 * wiki CLI —— 镜像 llm-wiki core 的 9 个工具，供任意 agent 以命令行使用。
 *
 * 用法：
 *   wiki list [--dataDir DIR] [--type T] [--status S]
 *   wiki search QUERY [--dataDir DIR] [--type T] [--tag TAG] [--limit N]
 *   wiki get ID [--dataDir DIR]
 *   wiki create PATH --type TYPE [--title T] [--description D] [--body FILE|TEXT] [--tags a,b] [--confirmed]
 *   wiki update ID [--title T] [--description D] [--body FILE] [--status S] [--confirmed] [--clear-status]
 *   wiki validate [--dataDir DIR]
 *   wiki lint [--dataDir DIR]
 *   wiki ingest SOURCE [--dataDir DIR] [--ref-dir DIR]
 *   wiki deprecate DIR [--dataDir DIR]
 *   wiki rules DIR [--dataDir DIR]
 *   wiki dirs [--dataDir DIR]
 *   wiki use NAME [--global] [--dataDir DIR]
 *   wiki sync [status|pull|push] [--message M] [--dataDir DIR] [--wiki NAME]
 *   wiki sync init --remote URL [--branch B] [--name N] [--use]          # 本地目录 → Git 远端
 *   wiki sync init --folder-token URL|TOKEN [--name N] [--cache-dir D] [--use]   # 飞书云盘库
 *   wiki sync init --new-folder 名称 --name N [--cache-dir D] [--use]    # 飞书新建文件夹
 *   wiki sync clone URL DIR [--name N] [--use]
 *
 * 环境变量 WIKI_DATA_DIR 可覆盖默认数据目录 ~/.agents/wiki。
 * 多目录（命名 bundle）：注册表 ~/.agents/wiki-registry.json（env WIKI_REGISTRY_FILE 覆盖）；
 * --wiki NAME 指定分支（缺省用注册表 active 或 default）；wiki dirs 查看、wiki use 切换。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 加载 core：优先同目录 wiki-core（自包含安装），回退本仓库 packages/core（开发态），再回退 npm
async function loadCore() {
  const bundledCore = join(__dirname, 'wiki-core', 'index.mjs')
  try {
    readFileSync(bundledCore)
    return await import(bundledCore + '?t=' + Date.now())
  } catch {
    const devCore = join(__dirname, '..', '..', 'core', 'index.mjs')
    try {
      readFileSync(devCore)
      return await import(devCore + '?t=' + Date.now())
    } catch {
      return await import('@sidleo3/llm-wiki-core')
    }
  }
}

/** CLI 版本（写入门控的 producer 版本；随 package.json 同步）。 */
const CLI_VERSION = '0.4.2'

function dataDirFromArgs(argv) {
  const i = argv.indexOf('--dataDir')
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  if (process.env.WIKI_DATA_DIR) return process.env.WIKI_DATA_DIR
  return join(homedir(), '.agents', 'wiki')
}

/** 解析数据目录：--wiki NAME 指定命名 bundle；显式 --dataDir/WIKI_DATA_DIR 为路径覆盖；
 *  两者都缺省时跟随注册表 active（或 default ~/.agents/wiki）。 */
async function resolveDataDir(argv, core) {
  const name = arg(argv, '--wiki')
  const explicit = argv.includes('--dataDir') || !!process.env.WIKI_DATA_DIR
  if (name) return core.resolveBundleRoot({ dataDir: dataDirFromArgs(argv) }, { name })
  if (explicit) return { name: 'default', path: dataDirFromArgs(argv) }
  return core.resolveBundleRoot({}, {})
}

function arg(argv, name, def) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : def
}

function has(argv, name) {
  return argv.includes(name)
}

/** 提取非选项的位置参数：剥掉所有 --opt [value]（含 --opt=value）后取剩余。 */
function positional(argv) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      if (a.includes('=')) continue
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) i++
      continue
    }
    out.push(a)
  }
  return out
}

function bodyFrom(p) {
  if (!p) return ''
  // 若以 @ 开头视作文件路径，否则当字面正文
  if (p.startsWith('@')) {
    try {
      return readFileSync(p.slice(1), 'utf8')
    } catch {
      return p
    }
  }
  return p
}

/** 飞书在线库：写后上线（返回追加说明，本地 bundle 为空串）。 */
async function onlineFlush(core, dir) {
  try {
    const r = await core.feishuFlush(dir)
    if (!r || (r.ok && r.nothingToPush)) return ''
    return r.ok ? `\n[在线库] 已同步上线：推送 ${(r.pushed || []).length} 个文件` : `\n[在线库] 尚未上线：${r.error}`
  } catch (e) {
    return `\n[在线库] 尚未上线：${e && e.message ? e.message : String(e)}`
  }
}

/** 飞书在线库：写前冲突闸门（返回引导文本或 null）。 */
async function onlineGuard(core, dir, paths) {
  try {
    const g = await core.feishuWriteGuard(dir, { paths })
    return g && g.blocked ? g.text : null
  } catch {
    return null
  }
}

/** 飞书同步结果文本化。 */
function printFeishu(action, r) {
  if (action === 'status') {
    if (!r.ok) {
      console.log(`在线库状态：不可用\n- ${r.error}${r.next ? `\n- 下一步：${r.next}` : ''}`)
      return
    }
    const c = r.counts || {}
    console.log(`在线库状态：待推送 ${c.push} / 待拉取 ${c.pull} / 冲突 ${c.conflict}｜本地 ${c.local} 个 .md，远端 ${c.remote} 个 .md`)
    if (r.push.length) console.log(`- 待推送：${r.push.map((x) => x.rel).slice(0, 8).join('、')}${r.push.length > 8 ? ' …' : ''}`)
    if (r.pull.length) console.log(`- 待拉取：${r.pull.map((x) => x.rel).slice(0, 8).join('、')}${r.pull.length > 8 ? ' …' : ''}`)
    if (r.conflict.length) console.log(`- 冲突（两侧都改）：${r.conflict.map((x) => x.rel).join('、')}`)
    if (r.remoteDeleted.length) console.log(`- 远端已删（本地保留）：${r.remoteDeleted.join('、')}`)
    if (r.ignored && r.ignored.length) console.log(`- 已忽略的非 .md 资源：${r.ignored.slice(0, 5).join('、')}`)
    return
  }
  if (r.ok) {
    if (action === 'init') {
      console.log(`飞书在线库初始化完成：${r.name} → ${r.url}`)
      console.log(`- 本地缓存：${r.cacheDir}`)
      console.log('（接着执行 wiki sync 会把本地内容推上去）')
      return
    }
    console.log(`${action === 'pull' ? '拉取完成' : action === 'push' ? '推送完成' : '同步完成'}${r.bundle ? `：${r.bundle.name}` : ''}`)
    if (r.pushed && r.pushed.length) console.log(`- 推送 ${r.pushed.length} 个文件（新增 ${(r.created || []).length}）`)
    if (r.pulled && r.pulled.length) console.log(`- 拉取 ${r.pulled.length} 个文件`)
    if (r.after) console.log(`- 现在：待推送 ${r.after.push} / 待拉取 ${r.after.pull} / 冲突 ${r.after.conflict}`)
    for (const s of r.steps || []) console.log(`  · ${s}`)
    if (r.backups && r.backups.length) console.log(`- 覆盖前备份：${r.backups.slice(0, 3).join('、')}`)
    return
  }
  console.error(`${action}失败（${r.step || 'unknown'}）：${r.error || '未知错误'}`)
  if (r.conflicts && r.conflicts.length) console.error(`- 冲突文件：${r.conflicts.join('、')}`)
  if (r.failed && r.failed.length) console.error(`- 失败文件：${r.failed.slice(0, 5).map((f) => f.rel).join('、')}`)
  if (r.next) console.error(`- 下一步：${r.next}`)
}

/** wiki sync 结果文本化（与 DSH/pi 形态语义一致）。 */
function printSync(action, r) {
  if (action === 'status') {
    if (!r.ok) {
      console.log(`同步状态：不可用\n- ${r.error}${r.next ? `\n- 下一步：${r.next}` : ''}`)
      return
    }
    console.log(`同步状态：${r.remote || '(未配置远端)'}`)
    console.log(`- 分支：${r.branch || '(detached)'}${r.upstream ? ` → ${r.upstream}` : '（未设 upstream）'}`)
    console.log(`- 领先 ${r.ahead} / 落后 ${r.behind}`)
    console.log(`- 工作区改动：${r.dirty.length} 个文件`)
    if (r.conflicts.length) console.log(`- 冲突：${r.conflicts.join('、')}`)
    console.log(`- 最后提交：${r.lastCommit || '(无)'}`)
    return
  }
  if (r.ok) {
    if (action === 'clone') {
      console.log(`已克隆：${r.dir}${r.registered ? `（注册为「${r.registered}」）` : ''}`)
    } else {
      console.log(`${action === 'init' ? '初始化完成' : '同步完成'}${r.bundle ? `：${r.bundle.name ? `${r.bundle.name} → ` : ''}${r.bundle.path}` : ''}`)
      if (r.committed) console.log(`- 本地提交：${r.committed} 个文件`)
      if (r.merged) console.log('- 已合并远端变更')
      if (r.pushed) console.log('- 已推送')
      if (r.status) console.log(`- 现在：领先 ${r.status.ahead} / 落后 ${r.status.behind}`)
    }
    for (const s of r.steps || []) console.log(`  · ${s}`)
    return
  }
  console.error(`${action === 'init' ? '初始化' : '同步'}失败（${r.step || 'unknown'}）：${r.error || '未知错误'}`)
  if (r.conflicts && r.conflicts.length) console.error(`- 冲突文件：${r.conflicts.join('、')}`)
  if (r.next) console.error(`- 下一步：${r.next}`)
}

async function main() {
  const core = await loadCore()
  const args = process.argv.slice(2)
  const cmd = args[0]
  const rest = args.slice(1)
  const resolvedBundle = await resolveDataDir(args, core)
  const dataDir = resolvedBundle.path
  const isFeishu = resolvedBundle.kind === 'feishu'
  const resolved = resolvedBundle

  const fmtTitle = (c) => `${c.strong ? '★' : ''}${c.type}: ${c.title}  (${c.id})\n    ${c.description || ''}`

  switch (cmd) {
    case 'list': {
      const tree = await core.listBundle(dataDir, { type: arg(rest, '--type'), status: arg(rest, '--status') })
      for (const { dir, concepts } of tree) {
        console.log(`\n[${dir || '(root)'}]`)
        for (const c of concepts) console.log(`  ${c.type}: ${c.title}  (${c.id})${c.status === 'deprecated' ? ' [deprecated]' : ''}`)
      }
      const total = tree.reduce((n, t) => n + t.concepts.length, 0)
      console.log(`\n${total} concepts`)
      break
    }
    case 'search': {
      const q = positional(rest).join(' ') || arg(rest, '--query')
      if (!q) { console.error('usage: wiki search QUERY'); process.exit(1) }
      const graph = await core.buildGraph(dataDir)
      const res = core.searchGraph(graph, q, {
        type: arg(rest, '--type'),
        tag: arg(rest, '--tag'),
        limit: Number(arg(rest, '--limit', '20')),
      })
      if (!res.length) {
        console.log('无匹配。若这是工作中遇到的真实表/知识：可 `wiki create` 主动补录（Table 自动记录；新口径先与用户确认）。或 `wiki list` 看全貌 / `wiki lint` 看缺失。')
        break
      }
      for (const r of res) console.log(fmtTitle(r))
      break
    }
    case 'get': {
      const id = positional(rest).join(' ') || arg(rest, '--id')
      if (!id) { console.error('usage: wiki get ID'); process.exit(1) }
      const got = await core.getConcept(dataDir, id)
      if (!got) { console.error(`未找到: ${id}。若这是真实表/概念可用 wiki create 主动补录。`); process.exit(1) }
      if (got.ambiguous) { console.error(`标题「${id}」有多个候选: ${got.candidates.join(', ')}`); process.exit(1) }
      console.log(`# ${got.title}  (${got.id})`)
      console.log(`type: ${got.type} | status: ${got.meta.status || 'stable'}`)
      if (got.meta.runtime) console.log(`runtime: ${got.meta.runtime}`)
      if (got.desc) console.log(`\n${got.desc}`)
      console.log(`\n--- backlinks (${got.backlinks.length}) ---`)
      for (const b of got.backlinks) console.log(`  ${b.type}: ${b.title}  (${b.id})`)
      console.log(`\n--- body ---\n${got.body.trim()}`)
      break
    }
    case 'create': {
      const id = positional(rest).join(' ') || arg(rest, '--path')
      if (!id) { console.error('usage: wiki create PATH --type TYPE [--title T] …'); process.exit(1) }
      const createType = arg(rest, '--type', '')
      if (createType) {
        const { dirname } = await import('node:path')
        const dir = dirname(id).replace(/\\/g, '/') === '.' ? '' : dirname(id).replace(/\\/g, '/')
        const gate = await core.gateForType(dataDir, dir, createType)
        if (gate.needConfirm && !has(rest, '--confirmed')) {
          console.error(`该写入需用户确认（AGENTS.md 门控规则${gate.via ? ' ' + gate.via : ''}要求 ${createType} 类写入需 human 确认）。先向用户展示并征得同意后加 --confirmed 重试。`)
          process.exit(2)
        }
      }
      const out = await core.createConcept(dataDir, {
        id,
        type: createType,
        title: arg(rest, '--title'),
        description: arg(rest, '--description'),
        tags: arg(rest, '--tags') ? arg(rest, '--tags').split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        status: arg(rest, '--status'),
        body: bodyFrom(arg(rest, '--body') || ''),
        opts: { confirmed: has(rest, '--confirmed'), user: process.env.WIKI_USER, producer: 'wiki-cli', version: CLI_VERSION },
      })
      console.log(`created ${out.id}${await onlineFlush(core, dataDir)}`)
      break
    }
    case 'update': {
      const id = positional(rest).join(' ') || arg(rest, '--id')
      if (!id) { console.error('usage: wiki update ID [--title T] …'); process.exit(1) }
      const patch = { opts: { confirmed: has(rest, '--confirmed'), user: process.env.WIKI_USER, producer: 'wiki-cli', version: CLI_VERSION } }
      const t = arg(rest, '--title'); if (t !== undefined) patch.title = t
      const d = arg(rest, '--description'); if (d !== undefined) patch.description = d
      const s = arg(rest, '--status'); if (s !== undefined) patch.status = s
      const tag = arg(rest, '--tags'); if (tag !== undefined) patch.tags = tag.split(',').map((x) => x.trim()).filter(Boolean)
      const type = arg(rest, '--type'); if (type !== undefined) patch.type = type
      const b = arg(rest, '--body'); if (b !== undefined) patch.body = bodyFrom(b)
      const blocked = await onlineGuard(core, dataDir, [`${id}.md`])
      if (blocked) { console.error(blocked); process.exit(2) }
      await core.updateConcept(dataDir, id, patch)
      console.log(`updated ${id}${await onlineFlush(core, dataDir)}`)
      break
    }
    case 'validate': {
      const v = await core.validateBundle(dataDir)
      if (!v.ok) { for (const e of v.errors) console.error('ERROR ' + e); process.exit(1) }
      console.log('OKF v0.2 compliant ✓')
      for (const w of v.warnings) console.log('warn: ' + w)
      break
    }
    case 'lint': {
      const l = await core.lintBundle(dataDir)
      if (!l.issues.length) console.log('lint clean ✓')
      for (const i of l.issues) console.log(`${i.sev === 'warn' ? 'WARN' : i.sev === 'info' ? 'info' : 'ERROR'}  [${i.kind}] ${i.msg}`)
      console.log(`summary: ${JSON.stringify(l.summary)}`)
      break
    }
    case 'ingest': {
      const src = positional(rest).join(' ')
      if (!src) { console.error('usage: wiki ingest SOURCE'); process.exit(1) }
      const out = await core.ingestSource(dataDir, { source: src, refDir: arg(rest, '--ref-dir') }, { producer: 'wiki-cli', version: CLI_VERSION })
      console.log(`ingested → ${out.refPath}${out.existed ? ' (existed)' : ''}${await onlineFlush(core, dataDir)}`)
      break
    }
    case 'deprecate': {
      const dir = positional(rest).join(' ') || ''
      const blocked = await onlineGuard(core, dataDir, [])
      if (blocked) { console.error(blocked); process.exit(2) }
      const out = await core.deprecateDir(dataDir, dir)
      console.log(`deprecated ${out.deprecated}/${out.total} concepts${await onlineFlush(core, dataDir)}`)
      break
    }
    case 'rules': {
      const dir = positional(rest).join(' ') || ''
      const rules = await core.resolveRules(dataDir, dir)
      if (!rules.length) { console.log('(no AGENTS.md rules found)'); break }
      for (const r of rules) {
        console.log(`\n===== ${r.path} =====\n${r.content.trimEnd()}\n`)
      }
      break
    }
    case 'sync': {
      const pos = positional(rest)
      const sub = ['status', 'sync', 'pull', 'push', 'init', 'clone'].includes(pos[0]) ? pos[0] : 'sync'

      if (sub === 'clone') {
        const url = pos[1] || arg(rest, '--url')
        const dir = pos[2] || arg(rest, '--dir')
        if (!url || !dir) {
          console.error('usage: wiki sync clone <URL> <DIR> [--name N] [--use]')
          process.exit(1)
        }
        const r = await core.gitClone(url, dir, { name: arg(rest, '--name'), use: has(rest, '--use') })
        printSync('clone', r)
        if (!r.ok) process.exit(1)
        break
      }

      const folderToken = arg(rest, '--folder-token')
      const newFolder = arg(rest, '--new-folder')

      if (sub === 'init' && (folderToken || newFolder)) {
        const r = await core.feishuInit({
          name: arg(rest, '--name'),
          folderToken,
          newFolder,
          cacheDir: arg(rest, '--cache-dir'),
          use: has(rest, '--use'),
        })
        printFeishu('init', r)
        if (!r.ok) process.exit(1)
        break
      }

      if (sub === 'init') {
        const r = await core.gitInit(dataDir, {
          remote: arg(rest, '--remote'),
          branch: arg(rest, '--branch'),
          name: arg(rest, '--name'),
          use: has(rest, '--use'),
        })
        printSync('init', { ...r, bundle: { name: '', path: dataDir } })
        if (!r.ok) process.exit(1)
        break
      }

      // 其余动作：按 bundle 后端分派
      if (isFeishu) {
        if (sub === 'status') {
          const r = await core.feishuStatus(resolved)
          printFeishu('status', r)
          if (!r.ok) process.exit(1)
          break
        }
        if (sub === 'pull' || sub === 'push') {
          const before = await core.feishuStatus(resolved)
          if (!before.ok) {
            printFeishu(sub, before)
            process.exit(1)
          }
          if (sub === 'push' && before.conflict.length) {
            printFeishu('push', { ok: false, step: 'conflict', conflicts: before.conflict.map((x) => x.rel), error: `${before.conflict.length} 个文件两侧都改过`, next: '请先人工处理冲突（飞书或本地任选一侧）再重跑。' })
            process.exit(1)
          }
          const r = sub === 'pull'
            ? await core.feishuPull(resolved, { paths: before.pull.map((x) => x.rel) })
            : await core.feishuPush(resolved, { paths: before.push.map((x) => x.rel) })
          printFeishu(sub, { ...r, bundle: resolved })
          if (!r.ok) process.exit(1)
          break
        }
        const r = await core.feishuSync(resolved, { adopt: arg(rest, '--adopt') })
        printFeishu('sync', { ...r, bundle: resolved })
        if (!r.ok) process.exit(1)
        break
      }

      if (sub === 'status') {
        const r = await core.gitStatus(dataDir)
        printSync('status', r)
        if (!r.ok) process.exit(1)
        break
      }
      const r = await core.gitSync(dataDir, { message: arg(rest, '--message'), push: sub !== 'pull' })
      printSync(sub, { ...r, bundle: { name: '', path: dataDir } })
      if (!r.ok) process.exit(1)
      break
    }
    case 'index': {
      const dir = positional(rest).join(' ') || ''
      await core.updateIndex(dataDir, { dirs: [dir] })
      console.log(`index updated for ${dir || '(root)'}`)
      break
    }
    case 'dirs': {
      const rows = await core.listBundles({ dataDir: dataDirFromArgs(args) })
      for (const r of rows) {
        const kind = r.kind === 'feishu' ? '飞书 ' : ''
        console.log(`${r.active ? '*' : ' '} ${kind}[${r.name}] ${r.path}${r.active ? '  ← 全局默认' : ''}`)
      }
      console.log(`\n当前生效目录：${dataDir}`)
      console.log('\n切换：wiki use <name> [--global]；注册新目录：编辑 ~/.agents/wiki-registry.json（详见 wiki help bundle）')
      break
    }
    case 'use': {
      const name = positional(rest).join(' ') || arg(rest, '--name')
      if (!name) { console.error('usage: wiki use NAME [--global]'); process.exit(1) }
      const resolved = await core.resolveBundleRoot({ dataDir: dataDirFromArgs(args) }, { name })
      if (has(rest, '--global')) {
        await core.writeRegistryActive(resolved.name)
        console.log(`[${resolved.name}] ${resolved.path}（已持久化为全局默认）`)
      } else {
        console.log(`[${resolved.name}] ${resolved.path}（校验通过；CLI 无会话态，加 --global 才持久化）`)
      }
      break
    }
    case 'help': {
      const topic = positional(rest).join(' ') || arg(rest, '--topic')
      console.log(core.getHelp(topic))
      break
    }
    default:
      console.log(`wiki CLI — llm-wiki core 工具
用法: wiki <list|search|get|create|update|validate|lint|ingest|deprecate|rules|index|dirs|use|sync|help> [args] [--dataDir DIR] [--wiki NAME]
       wiki sync [status|pull|push] [--message M] | wiki sync init --remote URL
       wiki sync init --folder-token URL|TOKEN [--name N] | wiki sync init --new-folder 名称 --name N
       wiki sync clone URL DIR [--name N] [--use]
主题: wiki help [quickstart|files|agents|append|frontmatter|gate|bundle|sync|feishu]`)
      process.exit(cmd ? 1 : 0)
  }
}

main().catch((e) => {
  console.error(e && e.message ? e.message : e)
  process.exit(1)
})
