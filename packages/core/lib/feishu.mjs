/**
 * feishu.mjs —— 飞书在线知识库后端（云盘文件夹 + 原生 .md 文件树）。
 *
 * 设计要点：
 * - **格式零损失**：在线库就是一组原生 `.md` 文件（OKF v0.2 bundle 原样），
 *   本地 cacheDir 与本地 bundle 同构 → core 的解析/校验/检索/index 全部照旧复用。
 * - **三方状态**（像 git）：`.wiki-cloud.json` 记录上次同步时每文件的
 *   `{fileToken, remoteModified, localMtimeMs, localSize}`，据此判断
 *   「本地改过 / 远端改过 / 双侧都改（冲突）」，而不是靠 mtime 猜方向。
 * - **只推被改的文件**：`markdown +overwrite`（已有，带 fileToken）/ `+create`（新增）；
 *   新目录用 `drive +create-folder`。可选 `mode:'batch'` 走 `drive +push/+pull` 整目录修复。
 * - **安全默认**：永不删除远端文件、永不因拉取删本地文件（不传 --delete-remote/--delete-local）；
 *   拉取覆盖本地前先备份到 `.backup/<时间戳>/`。认证完全交给 lark-cli，不落任何 token。
 * - 冲突不静默：概念/AGENTS.md 双侧都改 → 停止同步并报清单；`index.md` 本地重生成、
 *   `log.md` 用 mergeLogText 取并集（与 git 同步同一套规则）。
 *
 * 依赖：`lark-cli`（user 身份，可由 `WIKI_LARK_BIN` 覆盖路径，测试用假桩）。
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile, readdir, stat, copyFile, rm } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { expandTilde, writeRegistry, resolveBundleRoot, defaultCloudDir, normalizeCacheDir, effectiveBundles } from './registry.mjs'
import { refreshIndex, mergeLogText } from './indexlog.mjs'

/** 云盘同步状态文件（放在 cacheDir，不参与同步）。 */
export const CLOUD_INDEX_FILE = '.wiki-cloud.json'
/** 拉取覆盖前的本地备份目录（不参与同步）。 */
const BACKUP_DIR = '.backup'
const DEFAULT_TIMEOUT_MS = 120000
/** 首次全量（上百文件）留更长时间。 */
export const FEISHU_FULL_TIMEOUT_MS = 600000
/** 不参与同步的本地路径（前缀匹配）。 */
const SKIP_PREFIXES = ['.git', '.obsidian', BACKUP_DIR, CLOUD_INDEX_FILE, '.DS_Store']
/** lark-cli 并发上限：每条命令一个子进程，飞书 Drive API 限流远高于此（列表/拉取/推送都用它）。 */
const LARK_CONCURRENCY = 6

/** 有并发上限的 map（结果顺序与入参一致）。 */
async function mapLimit(items, limit, worker) {
  const list = [...items]
  const out = new Array(list.length)
  let next = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    for (let i = next++; i < list.length; i = next++) out[i] = await worker(list[i], i)
  })
  await Promise.all(runners)
  return out
}

/** 路径排序（保证并发遍历后的输出稳定、可比对）。 */
function byPath(a, b) {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
}

function larkBin(opts = {}) {
  return opts.larkBin || process.env.WIKI_LARK_BIN || 'lark-cli'
}

/** 执行一条 lark-cli 命令；永不 reject。 */
async function runLark(args, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  return new Promise((resolve) => {
    execFile(
      larkBin(opts),
      args,
      {
        cwd: opts.cwd || process.cwd(),
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        shell: false,
        env: { ...process.env },
      },
      (err, stdout, stderr) => {
        const out = String(stdout || '')
        const errText = String(stderr || '')
        if (!err) return resolve({ ok: true, stdout: out, stderr: errText, json: tryJson(out) })
        const code = typeof err.code === 'number' ? err.code : null
        const ecode = typeof err.code === 'string' ? err.code : null
        let error
        if (ecode === 'ENOENT') error = `未找到 lark-cli（${larkBin(opts)}）；安装后执行 lark-cli auth login，或用 WIKI_LARK_BIN 指定路径`
        else if (err.killed || code === null) error = `lark-cli 执行超时（${timeoutMs}ms）：${args.slice(0, 3).join(' ')}`
        else error = (errText || out || `lark-cli ${args.slice(0, 3).join(' ')} 失败（exit ${code}）`).trim()
        resolve({ ok: false, code, error, stdout: out, stderr: errText, json: tryJson(out) })
      },
    )
  })
}

function tryJson(text) {
  const t = String(text || '').trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

/** 统一信封：成功 → {ok:true, data}；失败 → {ok:false, error, next?}。 */
function unwrap(res) {
  if (!res.ok) return { ok: false, error: res.error, next: hintFor(res.error) }
  if (res.json && res.json.ok === false) {
    const e = res.json.error
    const msg = (e && (e.message || e.type)) || JSON.stringify(e || res.json)
    return { ok: false, error: String(msg), next: hintFor(String(msg)) }
  }
  return { ok: true, data: res.json && typeof res.json === 'object' && 'data' in res.json ? res.json.data : res.json }
}

function hintFor(msg = '') {
  if (/scope|permission denied|forbidden/i.test(msg)) return '飞书授权缺少 scope：执行 lark-cli auth login 补齐（drive / markdown / wiki 读写）。'
  if (/auth|token|login|unauthor/i.test(msg)) return '飞书身份不可用：执行 lark-cli auth login（user 身份）。'
  if (/rate_limit|too many/i.test(msg)) return '触发飞书限流：稍后重试。'
  return undefined
}

/** 归一化传入的 bundle spec（兼容 resolveBundleRoot 结果与裸 spec）。 */
export function feishuSpecOf(input) {
  const decl = input && typeof input.decl === 'object' && input.decl ? input.decl : input && typeof input === 'object' ? input : {}
  const cacheDir = expandTilde(String((input && input.path) || decl.cacheDir || ''))
  const folderToken = String(decl.folderToken || (input && input.folderToken) || '')
  return { name: (input && input.name) || '', cacheDir, folderToken, label: decl.label }
}

/** 本地路径是否属于同步域。 */
function inSyncScope(rel) {
  if (!rel || rel === '.') return false
  return !SKIP_PREFIXES.some((p) => rel === p || rel.startsWith(p + '/'))
}

/** 扫描本地 cacheDir：rel → {size, mtimeMs}（跳过 .git/.obsidian/.backup/索引）。 */
async function scanLocal(root) {
  const out = new Map()
  async function walk(rel) {
    const dir = rel ? join(root, rel) : root
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const child = rel ? `${rel}/${ent.name}` : ent.name
      if (!inSyncScope(child)) continue
      if (ent.isDirectory()) await walk(child)
      else if (ent.isFile() && ent.name.endsWith('.md')) {
        const st = await stat(join(root, child))
        out.set(child, { size: st.size, mtimeMs: Math.round(st.mtimeMs) })
      }
    }
  }
  await walk('')
  return out
}

async function readIndex(cacheDir) {
  try {
    const idx = JSON.parse(await readFile(join(cacheDir, CLOUD_INDEX_FILE), 'utf8'))
    return { folderToken: idx.folderToken || '', files: idx.files || {}, dirTokens: idx.dirTokens || {}, lastSyncAt: idx.lastSyncAt || null }
  } catch {
    return { folderToken: '', files: {}, dirTokens: {}, lastSyncAt: null }
  }
}

async function writeIndex(cacheDir, idx) {
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, CLOUD_INDEX_FILE), JSON.stringify({ ...idx, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
}

/** lark-cli 是否可用（含 user 身份状态）。 */
export async function larkAvailable(opts = {}) {
  // 注意：lark-cli auth status 不接受 --format（本身就输出 JSON）
  const res = await runLark(['auth', 'status'], opts)
  if (!res.ok) return { ok: false, error: res.error, next: res.error && /ENOENT|未找到/.test(res.error) ? '安装 lark-cli（@larksuite/cli）。' : undefined }
  const raw = res.json || {}
  const identities = raw.identities || {}
  const user = identities.user || {}
  const bot = identities.bot || {}
  return {
    ok: true,
    appId: raw.appId,
    brand: raw.brand,
    user: { ready: user.available === true, status: user.status, userName: user.userName, openId: user.openId },
    bot: { ready: bot.available === true, status: bot.status },
    error: user.available === true ? undefined : '飞书 user 身份不可用',
    next: user.available === true ? undefined : '执行 lark-cli auth login（user 身份）后再试。',
  }
}

/**
 * 递归列出远端 .md 文件与目录 token。
 * @returns {Promise<{ok:boolean, files?:Map<string,{fileToken:string, modifiedTime:number, url?:string}>, dirs?:Map<string,string>, ignored?:string[], error?:string}>}
 */
export async function feishuListRemote(spec, opts = {}) {
  const s = feishuSpecOf(spec)
  if (!s.folderToken) return { ok: false, error: '缺少 folderToken', next: '先 wiki sync init --folder-token <URL|token> 或用 --new-folder 新建。' }
  const files = new Map()
  const dirs = new Map([['', s.folderToken]])
  const ignored = []
  const duplicates = []
  const timeoutMs = opts.timeoutMs || FEISHU_FULL_TIMEOUT_MS

  async function listFolder(folderToken) {
    const entries = []
    let pageToken = ''
    do {
      const params = { folder_token: folderToken, page_size: 200 }
      if (pageToken) params.page_token = pageToken
      const r = unwrap(await runLark(['drive', 'files', 'list', '--params', JSON.stringify(params), '--format', 'json', '--as', 'user'], { ...opts, timeoutMs }))
      if (!r.ok) return r
      const data = r.data || {}
      entries.push(...(data.files || []))
      pageToken = data.has_more ? data.next_page_token || '' : ''
    } while (pageToken)
    return { ok: true, entries }
  }

  // 每层内部并发（并发度 6）：19 个目录 ≈ 3 轮，实测 19s → 3s。
  async function walk(folderToken, prefix) {
    const listed = await listFolder(folderToken)
    if (!listed.ok) return listed
    // 同一父目录下的同名兄弟：飞书允许重名，我们的 rel 键装不下两个 →
    // 记下来报给用户（绝不静默挑一个，否则会写错地方或再建第三个）。
    const byName = new Map()
    for (const f of listed.entries) {
      const group = byName.get(f.name) || []
      group.push(f)
      byName.set(f.name, group)
    }
    const subs = []
    for (const [name, group] of byName) {
      const rel = prefix ? `${prefix}/${name}` : name
      if (group.length > 1) duplicates.push({ rel, kind: group[0].type, tokens: group.map((f) => f.token) })
      const f = group[0]
      if (f.type === 'folder') {
        dirs.set(rel, f.token)
        subs.push([rel, f.token])
      } else if (f.type === 'file' && String(f.name || '').endsWith('.md')) {
        files.set(rel, { fileToken: f.token, modifiedTime: Number(f.modified_time || 0), url: f.url })
      } else {
        ignored.push(`${rel}（${f.type}）`)
      }
    }
    const results = await mapLimit(subs, LARK_CONCURRENCY, ([rel, token]) => walk(token, rel))
    for (const r of results) if (!r.ok) return r
    return { ok: true }
  }

  const walked = await walk(s.folderToken, '')
  if (!walked.ok) return walked
  return {
    ok: true,
    files: new Map([...files].sort(byPath)),
    dirs: new Map([...dirs].sort(byPath)),
    ignored: ignored.sort(),
    duplicates: duplicates.sort(byPath),
  }
}

/**
 * 远端树有同名重复时的硬闸门：rel 键装不下两个同名兄弟，此时列举结果必然只覆盖
 * 其中一棵（另一棵的内容会被误判成「本地新增」而去推送/覆盖），任何同步动作都不安全。
 * 因此状态/拉取/推送一律停下报清单，绝不猜、也绝不在重复状态下动数据。
 * @returns {null | {ok:false, step:string, error:string, duplicates:object[], next:string}}
 */
function duplicateGuard(remote) {
  const dups = (remote && remote.duplicates) || []
  if (!dups.length) return null
  return {
    ok: false,
    step: 'duplicate-remote',
    error: `远端有 ${dups.length} 处同名重复（飞书允许重名）：${dups.map((d) => d.rel).join('、')}`,
    duplicates: dups,
    next: '在飞书云盘里删掉多余的那个（保留有内容的那个），再重跑；本工具不会替你猜，也不会在重复状态下同步。',
  }
}

/**
 * 三方差异（不写任何一侧）。
 * @returns {Promise<{ok:boolean, push?:object[], pull?:object[], conflict?:object[], remoteDeleted?:string[], counts?:object, ignored?:string[], error?:string, next?:string}>}
 */
export async function feishuStatus(spec, opts = {}) {
  const s = feishuSpecOf(spec)
  if (!s.cacheDir) return { ok: false, error: '缺少 cacheDir（飞书 bundle 的本地工作目录）', next: '注册 bundle 时给 cacheDir，或用默认 ~/.agents/wiki-cloud/<名字>。' }
  await mkdir(s.cacheDir, { recursive: true })
  const idx = await readIndex(s.cacheDir)
  const remote = await feishuListRemote(s, opts)
  if (!remote.ok) return remote
  const dup = duplicateGuard(remote)
  if (dup) return dup
  const local = await scanLocal(s.cacheDir)

  const push = []
  const pull = []
  const conflict = []
  const remoteDeleted = []
  const adopt = opts.adopt // 'local' | 'remote'：无索引记录（首次）时以哪一侧为准

  for (const [rel, lf] of local) {
    const rf = remote.files.get(rel)
    if (!rf) {
      push.push({ rel, reason: 'new-local' })
      continue
    }
    const rec = idx.files[rel]
    if (!rec) {
      if (adopt === 'remote') pull.push({ rel, fileToken: rf.fileToken, reason: 'unknown-remote-wins' })
      else push.push({ rel, fileToken: rf.fileToken, reason: 'unknown-local-wins' })
      continue
    }
    const localChanged = rec.localMtimeMs !== lf.mtimeMs || rec.localSize !== lf.size
    const remoteChanged = rec.remoteModified !== rf.modifiedTime
    if (localChanged && remoteChanged) conflict.push({ rel, fileToken: rf.fileToken })
    else if (localChanged) push.push({ rel, fileToken: rf.fileToken })
    else if (remoteChanged) pull.push({ rel, fileToken: rf.fileToken, modifiedTime: rf.modifiedTime })
  }
  for (const [rel, rf] of remote.files) {
    if (local.has(rel)) continue
    pull.push({ rel, fileToken: rf.fileToken, reason: 'new-remote', modifiedTime: rf.modifiedTime })
  }
  for (const rel of Object.keys(idx.files)) {
    if (!remote.files.has(rel) && !local.has(rel)) remoteDeleted.push(rel)
  }

  return {
    ok: true,
    detection: '3way',
    push,
    pull,
    conflict,
    remoteDeleted,
    ignored: remote.ignored || [],
    duplicates: remote.duplicates || [],
    counts: { push: push.length, pull: pull.length, conflict: conflict.length, remoteDeleted: remoteDeleted.length, local: local.size, remote: remote.files.size, duplicates: (remote.duplicates || []).length },
  }
}

/** 拉取前把本地文件备份到 .backup/<时间戳>/。 */
async function backupIfExists(cacheDir, rel) {
  const src = join(cacheDir, rel)
  try {
    await stat(src)
  } catch {
    return null
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dest = join(cacheDir, BACKUP_DIR, stamp, rel)
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(src, dest)
  return join(BACKUP_DIR, stamp, rel)
}

/**
 * 拉取远端文件到本地缓存（覆盖前备份）。只拉给定列表，不做删除。
 * @returns {Promise<{ok:boolean, pulled:string[], failed:object[], error?:string}>}
 */
export async function feishuPull(spec, opts = {}) {
  const s = feishuSpecOf(spec)
  const remote = await feishuListRemote(s, opts)
  if (!remote.ok) return remote
  const dup = duplicateGuard(remote)
  if (dup) return dup
  const rels = Array.isArray(opts.paths) && opts.paths.length ? opts.paths : [...remote.files.keys()]
  const pulled = []
  const failed = []
  const backups = []
  const results = await mapLimit(rels, LARK_CONCURRENCY, async (rel) => {
    const rf = remote.files.get(rel)
    if (!rf) return { rel, error: '远端不存在该文件' }
    await mkdir(dirname(join(s.cacheDir, rel)), { recursive: true })
    const backup = await backupIfExists(s.cacheDir, rel)
    const r = unwrap(
      await runLark(['markdown', '+fetch', '--file-token', rf.fileToken, '--output', rel, '--overwrite', '--format', 'json', '--as', 'user'], { ...opts, cwd: s.cacheDir, timeoutMs: opts.timeoutMs || FEISHU_FULL_TIMEOUT_MS }),
    )
    if (!r.ok) {
      if (backup) await copyFile(join(s.cacheDir, backup), join(s.cacheDir, rel)).catch(() => {})
      return { rel, error: r.error }
    }
    return { rel, ok: true, backup }
  })
  for (const r of results) {
    if (r.ok) {
      pulled.push(r.rel)
      if (r.backup) backups.push(r.backup)
    } else failed.push({ rel: r.rel, error: r.error })
  }
  // 顺手把远端目录 token 记进账本：新缓存/换机器后账本没有 dirTokens，
  // 下次推送会凭名字重建同名目录（重复目录事故）——这里自愈。
  if (remote.dirs && remote.dirs.size) {
    const idx = await readIndex(s.cacheDir)
    const merged = { ...(idx.dirTokens || {}) }
    for (const [rel, token] of remote.dirs) if (token) merged[rel] = token
    idx.dirTokens = merged
    await writeIndex(s.cacheDir, idx)
  }
  return { ok: failed.length === 0, pulled, failed, backups }
}

/**
 * 确保远端目录存在，返回 rel → folderToken 映射。
 *
 * **以活体远端列举为准**（remoteDirs），本地账本只作补充：账本可能缺失
 * （新缓存 / 换机器 / 首次拉取后没有 dirTokens），此时若只凭名字 +create-folder，
 * 就会在已有同名目录旁边再建一个同名目录（飞书允许重名）——这正是 0.4.6 之前的
 * 重复目录事故根因。同名兄弟已存在（duplicates）时绝不猜：停下来报给用户。
 */
async function ensureRemoteDirs(s, dirsNeeded, opts, remoteDirs = new Map(), duplicates = []) {
  const idx = await readIndex(s.cacheDir)
  const dirTokens = { ...(idx.dirTokens || {}), '': s.folderToken }
  for (const [rel, token] of remoteDirs) if (token) dirTokens[rel] = token
  const ambiguous = new Set((duplicates || []).filter((d) => d.kind === 'folder').map((d) => d.rel))
  const created = []
  const sorted = [...dirsNeeded].sort((a, b) => a.split('/').length - b.split('/').length)
  for (const dir of sorted) {
    if (dirTokens[dir]) continue
    if (ambiguous.has(dir)) {
      return {
        ok: false,
        error: `远端存在多个同名目录（${dir}），无法安全判定用哪个`,
        next: '在飞书里删掉多余的同名目录后重跑；本工具不会替你猜，也不会再建第三个。',
      }
    }
    const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
    const parentToken = dirTokens[parent]
    if (parentToken === undefined) return { ok: false, error: `无法确定父目录 token：${parent || '(根)'}` }
    const r = unwrap(await runLark(['drive', '+create-folder', '--name', basename(dir), '--folder-token', parentToken, '--format', 'json', '--as', 'user'], opts))
    if (!r.ok) return r
    const token = r.data && (r.data.folder_token || r.data.token || r.data.file_token)
    if (!token) return { ok: false, error: `创建目录成功但未取到 token：${dir}` }
    dirTokens[dir] = token
    created.push(dir)
  }
  idx.dirTokens = dirTokens
  await writeIndex(s.cacheDir, idx)
  return { ok: true, dirTokens, created }
}

/**
 * 推送本地改动到远端（只推给定文件；不删远端）。
 * @returns {Promise<{ok:boolean, pushed:string[], created:string[], dirs:string[], failed:object[], error?:string}>}
 */
export async function feishuPush(spec, opts = {}) {
  const s = feishuSpecOf(spec)
  const remote = await feishuListRemote(s, opts)
  if (!remote.ok) return remote
  const dup = duplicateGuard(remote)
  if (dup) return dup
  const local = await scanLocal(s.cacheDir)
  const rels = Array.isArray(opts.paths) && opts.paths.length ? opts.paths : [...local.keys()]
  const dirsNeeded = new Set(rels.map((rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')).filter((d) => d !== ''))
  const dirs = await ensureRemoteDirs(s, dirsNeeded, opts, remote.dirs, remote.duplicates)
  if (!dirs.ok) return dirs

  const pushed = []
  const created = []
  const failed = []
  const idx = await readIndex(s.cacheDir)
  idx.folderToken = s.folderToken
  const results = await mapLimit(rels, LARK_CONCURRENCY, async (rel) => {
    if (!local.has(rel)) return { rel, error: '本地不存在该文件' }
    const rf = remote.files.get(rel)
    const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    const parentToken = dirs.dirTokens[parentRel]
    const args = rf
      ? ['markdown', '+overwrite', '--file-token', rf.fileToken, '--file', rel, '--format', 'json', '--as', 'user']
      : ['markdown', '+create', '--name', basename(rel), '--file', rel, '--folder-token', parentToken, '--format', 'json', '--as', 'user']
    const r = unwrap(await runLark(args, { ...opts, cwd: s.cacheDir, timeoutMs: opts.timeoutMs || FEISHU_FULL_TIMEOUT_MS }))
    if (!r.ok) return { rel, error: r.error, next: r.next }
    const token = (r.data && (r.data.file_token || r.data.token)) || (rf && rf.fileToken)
    const st = local.get(rel)
    return { rel, ok: true, token, isNew: !rf, mtimeMs: st.mtimeMs, size: st.size }
  })
  for (const r of results) {
    if (!r.ok) {
      failed.push({ rel: r.rel, error: r.error, next: r.next })
      continue
    }
    pushed.push(r.rel)
    if (r.isNew) created.push(r.rel)
    idx.files[r.rel] = { fileToken: r.token, remoteModified: 0, localMtimeMs: r.mtimeMs, localSize: r.size }
  }
  idx.lastSyncAt = new Date().toISOString()
  await writeIndex(s.cacheDir, idx)
  // 新建/覆盖后刷新远端 modified_time（一次列举即可）
  const after = await feishuListRemote(s, opts)
  if (after.ok) {
    for (const rel of pushed) {
      const rf = after.files.get(rel)
      if (rf) idx.files[rel] = { ...idx.files[rel], fileToken: rf.fileToken, remoteModified: rf.modifiedTime }
    }
    await writeIndex(s.cacheDir, idx)
  }
  return { ok: failed.length === 0, pushed, created, dirs: dirs.created, failed }
}

/**
 * 一键同步：三方差异 → 冲突停止 → 本地派生文件处理 → 推本地改动 → 拉远端改动 → 复核。
 * @param {{adopt?:'local'|'remote', message?:string}} [opts]
 */
export async function feishuSync(spec, opts = {}) {
  const s = feishuSpecOf(spec)
  const before = await feishuStatus(s, opts)
  if (!before.ok) return before

  const conceptConflicts = before.conflict.filter((c) => c.rel !== 'log.md')
  const logConflict = before.conflict.find((c) => c.rel === 'log.md')
  if (conceptConflicts.length) {
    return {
      ok: false,
      step: 'conflict',
      conflicts: conceptConflicts.map((c) => c.rel),
      error: `${conceptConflicts.length} 个文件两侧都改过：${conceptConflicts.map((c) => c.rel).join('、')}`,
      next: '这些是人工/agent 撰写的知识：请在飞书或本地任选一侧改好后重跑（本工具不自动合并，也不覆盖任何一侧）。',
      counts: before.counts,
    }
  }

  const steps = []
  const pushList = before.push.map((x) => x.rel)

  // 派生文件：index.md 一旦要推，就按本地目录树先重生成（重新生成的结果严格正确）
  if (pushList.some((r) => basename(r) === 'index.md')) {
    const regenerated = await refreshIndex(s.cacheDir)
    steps.push(`重生成 index：${regenerated.files.length} 个`)
    const local = await scanLocal(s.cacheDir)
    const idx = await readIndex(s.cacheDir)
    for (const rel of regenerated.files) {
      const st = local.get(rel)
      const rec = idx.files[rel]
      if (!st) continue
      const changed = !rec || rec.localMtimeMs !== st.mtimeMs || rec.localSize !== st.size
      if (changed && !pushList.includes(rel)) pushList.push(rel)
    }
  }

  // log.md 双侧都改 → 并集（永不阻塞）
  if (logConflict) {
    const remoteText = logConflict.fileToken
      ? unwrap(await runLark(['markdown', '+fetch', '--file-token', logConflict.fileToken, '--format', 'json', '--as', 'user'], opts))
      : { ok: false }
    const localText = await readFile(join(s.cacheDir, 'log.md'), 'utf8').catch(() => '')
    if (remoteText.ok && remoteText.data && remoteText.data.content) {
      const merged = mergeLogText(localText, String(remoteText.data.content))
      await writeFile(join(s.cacheDir, 'log.md'), merged, 'utf8')
      steps.push('合并 log.md（并集）')
      if (!pushList.includes('log.md')) pushList.push('log.md')
    } else {
      pushList.push('log.md')
      steps.push('log.md 为两侧改动但远端内容不可读：以本地为准推送')
    }
  }

  let pushed = { ok: true, pushed: [], created: [], failed: [] }
  if (pushList.length) {
    pushed = await feishuPush(s, { ...opts, paths: pushList })
    if (!pushed.ok && pushed.failed && pushed.failed.length) {
      return { ok: false, step: 'push', error: `推送失败 ${pushed.failed.length} 个文件`, failed: pushed.failed, pushed: pushed.pushed, next: '检查飞书授权/网络后重跑（远端未被破坏）。' }
    }
    steps.push(`推送 ${pushed.pushed.length} 个文件（新增 ${pushed.created.length}）`)
  }

  const pullRel = before.pull.map((x) => x.rel).filter((r) => !pushList.includes(r))
  let pulled = { ok: true, pulled: [], failed: [] }
  if (pullRel.length) {
    pulled = await feishuPull(s, { ...opts, paths: pullRel })
    steps.push(`拉取 ${pulled.pulled.length} 个文件`)
    const idx = await readIndex(s.cacheDir)
    const local = await scanLocal(s.cacheDir)
    const remote = await feishuListRemote(s, opts)
    for (const rel of pulled.pulled) {
      const st = local.get(rel)
      const rf = remote.ok ? remote.files.get(rel) : null
      if (st) idx.files[rel] = { fileToken: (rf && rf.fileToken) || (idx.files[rel] && idx.files[rel].fileToken) || '', remoteModified: rf ? rf.modifiedTime : (idx.files[rel] && idx.files[rel].remoteModified) || 0, localMtimeMs: st.mtimeMs, localSize: st.size }
    }
    idx.lastSyncAt = new Date().toISOString()
    await writeIndex(s.cacheDir, idx)
  }

  const after = await feishuStatus(s, opts)
  return {
    ok: true,
    steps,
    pushed: pushed.pushed || [],
    created: pushed.created || [],
    pulled: pulled.pulled || [],
    remoteDeleted: before.remoteDeleted,
    ignored: before.ignored,
    before: before.counts,
    after: after.ok ? after.counts : undefined,
  }
}

/**
 * 初始化：可选新建云盘文件夹 + 注册为命名 bundle（写 core 注册表，三形态共享）。
 * @param {{name:string, folderToken?:string, newFolder?:string, cacheDir?:string, label?:string, use?:boolean}} p
 */
export async function feishuInit(p, opts = {}) {
  const name = String(p.name || '').trim()
  if (!name) return { ok: false, step: 'args', error: '需要 bundle 名（--name）', next: '例：wiki sync init --new-folder 团队知识库 --name 飞书库' }
  let folderToken = feishuParseFolderToken(p.folderToken)
  let createdFolder = null
  if (!folderToken && p.newFolder) {
    const r = unwrap(await runLark(['drive', '+create-folder', '--name', String(p.newFolder), '--format', 'json', '--as', 'user'], opts))
    if (!r.ok) return { ok: false, step: 'create-folder', error: r.error, next: r.next }
    folderToken = (r.data && (r.data.folder_token || r.data.token || r.data.file_token)) || ''
    if (!folderToken) return { ok: false, step: 'create-folder', error: '建目录成功但未取到 token' }
    createdFolder = { name: String(p.newFolder), token: folderToken }
  }
  if (!folderToken) return { ok: false, step: 'args', error: '需要 --folder-token <URL|token> 或 --new-folder <名称>', next: '云盘文件夹 URL 形如 https://feishu.cn/drive/folder/fldcnXXX' }

  // cacheDir 一律显式落到注册表（默认 ~/.agents/wiki-cloud/<名字>），便于卡片/CLI 显示与排障
  const cache = normalizeCacheDir(p.cacheDir, name)
  if (!cache.ok) return { ok: false, step: 'args', error: cache.error, next: '例：--cache-dir ~/Documents/feishu-wiki' }
  const cacheDir = cache.dir
  await mkdir(cacheDir, { recursive: true }).catch(() => {})
  const spec = { kind: 'feishu', folderToken, cacheDir, ...(p.label ? { label: String(p.label) } : {}) }
  await writeRegistry({ bundles: { [name]: spec }, ...(p.use ? { active: name } : {}) })
  const idx = await readIndex(cacheDir)
  idx.folderToken = folderToken
  await writeIndex(cacheDir, idx)
  const resolved = await resolveBundleRoot({}, { name })
  return { ok: true, name, folderToken, cacheDir: resolved.path, createdFolder, url: feishuFolderUrl(folderToken), registered: true }
}

/** 从 URL 或裸 token 解析云盘文件夹 token。 */
export function feishuParseFolderToken(input) {
  const raw = String(input || '').trim()
  if (!raw) return ''
  if (/^[A-Za-z0-9_-]{6,}$/.test(raw) && !raw.includes('/')) return raw
  const m = raw.match(/\/folder\/([A-Za-z0-9_-]+)/) || raw.match(/[?&]folder_token=([A-Za-z0-9_-]+)/) || raw.match(/\/drive\/folder\/([A-Za-z0-9_-]+)/)
  return m ? m[1] : ''
}

/**
 * 按本地工作目录反查飞书 bundle（写工具用：判断"这个 root 是不是在线库"）。
 * @returns {Promise<{name:string, kind:'feishu', path:string, decl:object}|null>}
 */
export async function feishuBundleForPath(root, config = {}) {
  const bundles = await effectiveBundles(config)
  for (const [name, spec] of Object.entries(bundles)) {
    if (spec.kind === 'feishu' && spec.path === root) return { name, kind: 'feishu', path: spec.path, decl: spec.decl }
  }
  return null
}

/**
 * 写前冲突闸门：目标文件若在远端也被改过（三方状态判定为冲突），拒绝写入。
 * @returns {Promise<{blocked:boolean, conflict?:string[], text?:string}|null>} null = 不是飞书 bundle（无需检查）
 */
export async function feishuWriteGuard(root, { paths = [] } = {}, config = {}) {
  const spec = await feishuBundleForPath(root, config)
  if (!spec) return null
  const st = await feishuStatus(spec)
  if (!st.ok) return { blocked: true, text: `在线库状态不可用：${st.error}${st.next ? `（${st.next}）` : ''}` }
  const wanted = new Set(paths.map((p) => String(p).replace(/^\/+/, '')))
  const hit = st.conflict.filter((c) => wanted.size === 0 || wanted.has(c.rel))
  if (!hit.length) return { blocked: false, pending: st.push.length, pull: st.pull.length }
  return {
    blocked: true,
    conflict: hit.map((c) => c.rel),
    text: `拒绝对 ${hit.map((c) => c.rel).join('、')} 的写入：这些文件在飞书侧也被改过（两侧都改）。请先 wiki_sync status 看清单，人工在飞书或本地保留一侧后重跑同步，再改。`,
  }
}

/**
 * 写后上线：把该飞书 bundle 的待推送文件推上去（本地目录 bundle 返回 null = 无需动作）。
 * 推送失败不改变写入结果，但会把原因回报给调用方。
 */
export async function feishuFlush(root, config = {}, opts = {}) {
  const spec = await feishuBundleForPath(root, config)
  if (!spec) return null
  const st = await feishuStatus(spec)
  if (!st.ok) return { ok: false, step: 'status', error: st.error, next: st.next, bundle: spec }
  if (st.conflict.length) {
    return { ok: false, step: 'conflict', conflicts: st.conflict.map((c) => c.rel), error: `${st.conflict.length} 个文件两侧都改过（本次改动已在本地缓存，未上线）`, next: '先处理冲突再 wiki_sync。', bundle: spec }
  }
  if (!st.push.length) return { ok: true, pushed: [], created: [], bundle: spec, nothingToPush: true }
  const r = await feishuPush(spec, { ...opts, paths: st.push.map((x) => x.rel) })
  return { ...r, bundle: spec, files: st.push.map((x) => x.rel) }
}

/** 云盘文件夹链接（人可在飞书里打开）。 */
export function feishuFolderUrl(folderToken) {
  return folderToken ? `https://feishu.cn/drive/folder/${folderToken}` : ''
}

/** 供诊断：读取缓存索引。 */
export async function feishuCacheInfo(spec) {
  const s = feishuSpecOf(spec)
  const idx = await readIndex(s.cacheDir)
  const local = await scanLocal(s.cacheDir)
  return { cacheDir: s.cacheDir, folderToken: s.folderToken || idx.folderToken, localFiles: local.size, trackedFiles: Object.keys(idx.files).length, lastSyncAt: idx.lastSyncAt }
}

/** 清空本地缓存索引（下次同步按 adopt 策略重建）；不删任何 .md。 */
export async function feishuForget(spec) {
  const s = feishuSpecOf(spec)
  await rm(join(s.cacheDir, CLOUD_INDEX_FILE), { force: true })
  return { ok: true, cacheDir: s.cacheDir }
}
