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
 * 并发安全：core 会并发调用（并发度 6），假桩用 <STATE>.lock 串行化 + 原子替换写状态；
 * 每次调用都会释放锁，被 kill 留下的陈旧锁 10s 后自动接管。
 *
 * 支持：
 *   auth status --format json
 *   drive files list --params '{"folder_token":...}'
 *   drive +create-folder --name X [--folder-token P]
 *   markdown +create --name X.md --file rel --folder-token P
 *   markdown +overwrite --file-token T --file rel
 *   markdown +fetch --file-token T [--output rel] [--overwrite]
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, unlinkSync, openSync, closeSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const STATE = process.env.FAKE_LARK_STATE
const LOG = process.env.FAKE_LARK_LOG
const ROOT = process.env.FAKE_LARK_ROOT || 'fldcnROOT'

/**
 * 身份：镜像真实 CLI 的 --as（user | bot），并支持用环境变量把某个身份做成
 * 「不可用 / 无 scope」，用于测「user 不可用则自动回退 bot」这类分支。
 *   FAKE_LARK_USER_READY=0  → auth status 里 user.available=false
 *   FAKE_LARK_BOT_READY=0   → auth status 里 bot.available=false
 *   FAKE_LARK_USER_DENIED=1 → 由 user 发起的调用一律返回授权错误
 *   FAKE_LARK_BOT_DENIED=1  → 由 bot 发起的调用返回 app_scope_not_applied
 *   FAKE_LARK_DENY_WRITES=1 → 只让写命令（+create / +overwrite / +create-folder）失败，
 *                             用于测「列举通过、单文件写被拒」这条分支
 *   FAKE_LARK_DENY_FETCH=1  → 只让 markdown +fetch 失败（列举仍可读），
 *                             用于测「双侧都变但读不到远端内容」时的保守回退
 */
const AS = (() => {
  const i = argv.indexOf('--as')
  const v = i >= 0 ? argv[i + 1] : undefined
  return v === 'bot' || v === 'user' ? v : 'user'
})()
const deny = process.env.FAKE_LARK_USER_DENIED === '1' && AS === 'user' ? true : process.env.FAKE_LARK_BOT_DENIED === '1' && AS === 'bot'
const WRITE_CMDS = ['+create', '+overwrite', '+create-folder', '+delete']
const denyWriteOnly = process.env.FAKE_LARK_DENY_WRITES === '1'
const denyFetch = process.env.FAKE_LARK_DENY_FETCH === '1'
const denyMessage =
  AS === 'bot'
    ? 'access denied: app cli_fake has not applied for the required scope(s): drive:drive, space:document:retrieve'
    : 'access denied: user token expired, please login again'

/**
 * 并发安全：core 现在会并发调用 lark-cli（列表/拉取/推送并发度 6），
 * 而真 CLI 背后是服务端、天然并发安全；假桩共用一份 JSON 状态文件，
 * 必须自己加锁 + 原子替换，否则并发调用会互相覆盖（丢文件/丢目录）。
 */
const LOCK = STATE ? `${STATE}.lock` : null
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
let locked = false
function acquireLock() {
  if (!LOCK) return
  const deadline = Date.now() + 20000
  for (;;) {
    try {
      closeSync(openSync(LOCK, 'wx'))
      locked = true
      return
    } catch (err) {
      if (err.code !== 'EEXIST') return
      // 陈旧锁（进程被杀）超过 10s 直接接管
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 10000) unlinkSync(LOCK)
      } catch {
        /* 锁已被别人释放 */
      }
      if (Date.now() > deadline) throw new Error(`fake lark-cli: 等锁超时 ${LOCK}`)
      sleepSync(3)
    }
  }
}
function releaseLock() {
  if (!locked) return // 读命令不持锁，绝不能删别人的锁
  locked = false
  try {
    unlinkSync(LOCK)
  } catch {
    /* 已释放 */
  }
}
function load() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return { files: {}, dirs: {}, nextId: 1 }
  }
}
function save(st) {
  mkdirSync(dirname(STATE), { recursive: true })
  const tmp = `${STATE}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(st, null, 2))
  renameSync(tmp, STATE)
}
function ok(data) {
  releaseLock()
  process.stdout.write(JSON.stringify({ ok: true, identity: AS, data }) + '\n')
  process.exit(0)
}
function fail(message, type = 'api_error') {
  releaseLock()
  process.stdout.write(JSON.stringify({ ok: false, identity: AS, error: { type, message } }) + '\n')
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
// 只有写命令需要串行化；读命令靠 save() 的原子替换（tmp+rename）保证读不到半截状态
if ((domain === 'drive' && (cmd === '+create-folder' || cmd === '+delete')) || (domain === 'markdown' && (cmd === '+create' || cmd === '+overwrite'))) acquireLock()
const st = load()

if (domain === 'auth' && cmd === 'status') {
  // 严格镜像真实 CLI：auth status 不接受 --format，且输出裸对象（无 {ok,data} 信封）
  if (has('--format')) fail('unknown flag "--format" for "lark-cli auth status"', 'validation')
  const userReady = process.env.FAKE_LARK_USER_READY !== '0'
  const botReady = process.env.FAKE_LARK_BOT_READY !== '0'
  process.stdout.write(
    JSON.stringify({
      appId: 'cli_fake',
      brand: 'feishu',
      defaultAs: 'auto',
      identities: {
        user: { status: userReady ? 'ready' : 'expired', available: userReady, userName: '测试用户', openId: 'ou_test' },
        bot: { status: botReady ? 'ready' : 'unavailable', available: botReady },
      },
    }) + '\n',
  )
  process.exit(0)
}

// 身份被做成不可用/无 scope 时：任何真实调用都失败（auth status 除外，它是探测入口）
if (deny || (denyWriteOnly && WRITE_CMDS.includes(cmd))) fail(denyMessage, AS === 'bot' ? 'authorization' : 'auth')
if (denyFetch && domain === 'markdown' && cmd === '+fetch') fail('fetch unavailable (FAKE_LARK_DENY_FETCH)', 'api_error')

if (domain === 'drive' && cmd === 'files' && argv[2] === 'list') {
  const params = JSON.parse(flag('--params') || '{}')
  const folderToken = params.folder_token === undefined ? '' : params.folder_token
  const rel = folderToken === '' ? '' : relOfDirToken(st, folderToken)
  if (rel === undefined) fail(`folder not found: ${folderToken}`, 'not_found')
  const entries = []
  for (const [d, info] of Object.entries(st.dirs)) {
    // info.name 可显式覆盖：用于构造「同一父目录下同名兄弟」（真实飞书允许重名）
    if ((info.parent || '') === rel) entries.push({ type: 'folder', token: info.token, name: info.name || d.split('/').pop(), parent_token: folderToken })
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

if (domain === 'drive' && cmd === '+delete') {
  const token = flag('--file-token')
  const hit = Object.entries(st.files).find(([, f]) => f.fileToken === token)
  if (!hit) fail(`file not found: ${token}`, 'not_found')
  // 真 CLI 是 high-risk-write，必须有 --yes；假桩照抄这条契约，防止调用方漏传
  if (!has('--yes')) fail('high-risk operation requires --yes', 'validation')
  delete st.files[hit[0]]
  save(st)
  ok({ deleted: true, file_token: token, type: flag('--type') || 'file', status: 'success' })
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
