/**
 * migrate-to-feishu.mjs —— 把本地 bundle 复刻成一个飞书云盘在线库（一次性，copy 不 move）。
 *
 * 步骤：新建/挂载云盘文件夹 → 注册命名 bundle → 复制本地 .md 树到本地缓存 → 首推 → 校验。
 * 默认 **dry-run**（只打印计划，不建文件夹、不上传）；确认后加 `--apply`。
 *
 * 用法：
 *   node scripts/migrate-to-feishu.mjs --from ~/Documents/llm-wiki --name 飞书库 --new-folder 永辉知识库 --apply
 *   node scripts/migrate-to-feishu.mjs --from ~/Documents/llm-wiki --name 飞书库 --folder-token https://feishu.cn/drive/folder/fldcnXXX --apply
 *   # 预演（默认）：
 *   node scripts/migrate-to-feishu.mjs --from ~/Documents/llm-wiki --name 飞书库 --new-folder 永辉知识库
 *
 * 选项：--cache-dir DIR（缺省 ~/.agents/wiki-cloud/<名字>）--use（注册后设为默认）--skip-index（不重建 index）
 */

import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as core from '../packages/core/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

function arg(name, def) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def
}
const has = (name) => process.argv.includes(name)

const from = arg('--from')
const name = arg('--name')
const folderToken = arg('--folder-token')
const newFolder = arg('--new-folder')
const cacheDir = arg('--cache-dir')
const use = has('--use')
const apply = has('--apply')
const skipIndex = has('--skip-index')

if (!from || !name) {
  console.error('用法: node scripts/migrate-to-feishu.mjs --from <本地 bundle> --name <飞书库名> (--new-folder 名称 | --folder-token URL|TOKEN) [--apply]')
  process.exit(1)
}

/** 收集本地 bundle 里要同步的 .md（跳过 .git/.obsidian/.DS_Store 等）。 */
async function collect(root, rel = '') {
  const out = []
  const dir = rel ? join(root, rel) : root
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    if (e.isDirectory()) out.push(...(await collect(root, child)))
    else if (e.name.endsWith('.md')) out.push(child)
  }
  return out
}

const lark = await core.larkAvailable()
const files = await collect(from)
const localStat = await stat(from).then((s) => s.isDirectory(), () => false)

console.log('=== 迁移计划 ===')
console.log(`本地来源：${from}${localStat ? '' : '（不存在！）'}`)
console.log(`飞书库名：${name}`)
console.log(`目标文件夹：${newFolder ? `新建「${newFolder}」（我的空间根）` : folderToken ? `挂载 ${folderToken}` : '（未指定，需 --new-folder 或 --folder-token）'}`)
console.log(`本地缓存：${cacheDir || core.defaultCloudDir(name)}`)
console.log(`待上传：${files.length} 个 .md（跳过 .git / .obsidian / .DS_Store 等）`)
console.log(`lark-cli：${lark.ok ? `可用（${lark.user && lark.user.userName}）` : `不可用 — ${lark.error || ''} ${lark.next || ''}`}`)
if (!apply) {
  console.log('\n（dry-run：未做任何写入。确认无误后加 --apply 执行）')
  process.exit(0)
}
if (!localStat) {
  console.error('\n本地来源不是目录，终止。')
  process.exit(1)
}
if (!newFolder && !folderToken) {
  console.error('\n需要 --new-folder <名称> 或 --folder-token <URL|TOKEN>，终止。')
  process.exit(1)
}

console.log('\n=== 执行 ===')
const init = await core.feishuInit({ name, folderToken, newFolder, cacheDir, use })
if (!init.ok) {
  console.error('初始化失败：', init.error, init.next || '')
  process.exit(1)
}
console.log(`✓ 注册 bundle「${init.name}」→ ${init.url}`)
console.log(`✓ 本地缓存 ${init.cacheDir}`)

// 复制 .md 树（copy 不 move）
let copied = 0
for (const rel of files) {
  const dest = join(init.cacheDir, rel)
  await mkdir(dirname(dest), { recursive: true })
  await cp(join(from, rel), dest)
  copied++
}
console.log(`✓ 复制 ${copied} 个 .md 到缓存`)

if (!skipIndex) {
  const idx = await core.refreshIndex(init.cacheDir)
  console.log(`✓ 重建 index：${idx.files.length} 个`)
}

const spec = await core.resolveBundleRoot({}, { name })
const sync = await core.feishuSync(spec, { adopt: 'local' })
if (!sync.ok) {
  console.error('首推失败：', sync.error, sync.next || '')
  process.exit(1)
}
console.log(`✓ 首推完成：推送 ${sync.pushed.length}（新增 ${sync.created.length}），拉取 ${sync.pulled.length}`)
const after = await core.feishuStatus(spec)
console.log(`✓ 复核：本地 ${after.counts.local} / 远端 ${after.counts.remote}，待推送 ${after.counts.push} / 待拉取 ${after.counts.pull} / 冲突 ${after.counts.conflict}`)
console.log('\n完成。用 wiki_dirs 查看分支、wiki_use 切换；卡片「在线同步」区可一键同步。')
