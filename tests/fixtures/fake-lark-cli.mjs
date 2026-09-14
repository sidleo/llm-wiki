#!/usr/bin/env node
/**
 * tests/fixtures/fake-lark-cli.mjs —— 有状态的假 lark-cli（离线测试飞书后端）。
 *
 * 只实现 feishu.mjs 用到的那几条命令，并把每次调用追加进 FAKE_LARK_LOG，
 * 供测试断言「调用顺序」与「argv 黑名单」（不得出现 --delete-remote/--delete-local/--force）。
 *
 * 环境变量：
 *   FAKE_LARK_STATE  状态 JSON 路径（{ files: {rel:{fileToken,content,modified,parent}}, dirs: {rel:{token,parent}} }）
 *   FAKE_LARK_LOG    调用日志路径（每行一个 JSON：{argv}）
 *   FAKE_LARK_ROOT   根文件夹 token（默认 fldcnROOT）
 *
 * 支持：
 *   auth status --format json
 *   drive files list --params '{"folder_token":...}'
 *   drive +create-folder --name X [--folder-token P]
 *   markdown +create --name X.md --file rel --folder-token P
 *   markdown +overwrite --file-token T --file rel
 *   markdown +fetch --file-token T [--output rel] [--overwrite]
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const STATE = process.env.FAKE_LARK_STATE
const LOG = process.env.FAKE_LARK_LOG
const ROOT = process.env.FAKE_LARK_ROOT || 'fldcnROOT'

function load() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return { files: {}, dirs: {}, nextId: 1 }
  }
}
function save(st) {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify(st, null, 2))
}
function ok(data) {
  process.stdout.write(JSON.stringify({ ok: true, identity: 'user', data }) + '\n')
  process.exit(0)
}
function fail(message, type = 'api_error') {
  process.stdout.write(JSON.stringify({ ok: false, identity: 'user', error: { type, message } }) + '\n')
  process.exit(1)
}
function flag(name) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : undefined
}
function has(name) {
  return argv.includes(name)
}
/** 本地文件相对 cacheDir 的路径：cwd 由调用方设为 cacheDir。 */
function localPath(rel) {
  return join(process.cwd(), rel)
}
function tokenOfDirRel(st, rel) {
  if (rel === '' || rel === undefined || rel === null) return ROOT
  const d = st.dirs[rel]
  return d ? d.token : undefined
}
function relOfDirToken(st, token) {
  if (token === ROOT) return ''
  const hit = Object.entries(st.dirs).find(([, d]) => d.token === token)
  return hit ? hit[0] : undefined
}

if (LOG) appendFileSync(LOG, JSON.stringify({ argv }) + '\n')

const [domain, cmd] = argv
const st = load()

if (domain === 'auth' && cmd === 'status') {
  // 真实 lark-cli auth status 输出的是裸对象（无 {ok,data} 信封）
  process.stdout.write(JSON.stringify({ appId: 'cli_fake', brand: 'feishu', defaultAs: 'auto', identities: { user: { status: 'ready', available: true, userName: '测试用户', openId: 'ou_test' }, bot: { status: 'ready', available: true } } }) + '\n')
  process.exit(0)
}

if (domain === 'drive' && cmd === 'files' && argv[2] === 'list') {
  const params = JSON.parse(flag('--params') || '{}')
  const folderToken = params.folder_token === undefined ? '' : params.folder_token
  const rel = folderToken === '' ? '' : relOfDirToken(st, folderToken)
  if (rel === undefined) fail(`folder not found: ${folderToken}`, 'not_found')
  const entries = []
  for (const [d, info] of Object.entries(st.dirs)) {
    if ((info.parent || '') === rel) entries.push({ type: 'folder', token: info.token, name: d.split('/').pop(), parent_token: folderToken })
  }
  for (const [f, info] of Object.entries(st.files)) {
    if ((info.parent || '') === rel) entries.push({ type: 'file', token: info.fileToken, name: f.split('/').pop(), parent_token: folderToken, modified_time: String(info.modified) })
  }
  ok({ files: entries, has_more: false, next_page_token: '' })
}

if (domain === 'drive' && cmd === '+create-folder') {
  const name = flag('--name')
  const parentToken = flag('--folder-token') || ROOT
  const parentRel = relOfDirToken(st, parentToken)
  if (parentRel === undefined) fail(`parent not found: ${parentToken}`, 'not_found')
  if (Object.keys(st.files).some((f) => (st.files[f].parent || '') === parentRel && f.split('/').pop() === name)) fail(`name conflicts with a file: ${name}`, 'validation')
  const rel = parentRel ? `${parentRel}/${name}` : name
  const token = `fldcnFAKE${st.nextId++}`
  st.dirs[rel] = { token, parent: parentRel }
  save(st)
  ok({ folder_token: token, parent_folder_token: parentToken, name, url: `https://feishu.cn/drive/folder/${token}` })
}

if (domain === 'markdown' && cmd === '+create') {
  const name = flag('--name')
  if (!name || !name.endsWith('.md')) fail('name must end with .md', 'validation')
  const parentToken = flag('--folder-token')
  const parentRel = parentToken === undefined ? '' : relOfDirToken(st, parentToken)
  if (parentRel === undefined) fail(`parent not found: ${parentToken}`, 'not_found')
  const rel = parentRel ? `${parentRel}/${name}` : name
  if (st.files[rel]) fail(`file exists: ${rel}`, 'validation')
  const content = readFileSync(localPath(flag('--file')), 'utf8')
  const fileToken = `boxcnFAKE${st.nextId++}`
  st.files[rel] = { fileToken, content, modified: Date.now(), parent: parentRel }
  save(st)
  ok({ file_token: fileToken, file_name: name, url: `https://feishu.cn/file/${fileToken}`, size_bytes: Buffer.byteLength(content) })
}

if (domain === 'markdown' && cmd === '+overwrite') {
  const token = flag('--file-token')
  const hit = Object.entries(st.files).find(([, f]) => f.fileToken === token)
  if (!hit) fail(`file not found: ${token}`, 'not_found')
  const content = readFileSync(localPath(flag('--file')), 'utf8')
  hit[1].content = content
  hit[1].modified = Date.now()
  save(st)
  ok({ file_token: token, version: `v${st.nextId++}`, size_bytes: Buffer.byteLength(content) })
}

if (domain === 'markdown' && cmd === '+fetch') {
  const token = flag('--file-token')
  const hit = Object.entries(st.files).find(([, f]) => f.fileToken === token)
  if (!hit) fail(`file not found: ${token}`, 'not_found')
  const out = flag('--output')
  if (out) {
    const dest = localPath(out)
    if (!has('--overwrite')) {
      try {
        readFileSync(dest)
        fail(`output exists: ${out}`, 'validation')
      } catch {
        /* 不存在则继续 */
      }
    }
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, hit[1].content)
    ok({ file_token: token, file_name: hit[0].split('/').pop(), saved_path: dest, size_bytes: Buffer.byteLength(hit[1].content) })
  }
  ok({ file_token: token, file_name: hit[0].split('/').pop(), content: hit[1].content, size_bytes: Buffer.byteLength(hit[1].content) })
}

fail(`fake lark-cli: 未实现的命令 ${argv.join(' ')}`, 'unsupported')
