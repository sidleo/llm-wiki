/**
 * git.mjs —— Git 远端同步（在线知识库）。
 *
 * bundle 仍是本地 markdown 目录树，本模块只负责「与远端收敛」：
 *   gitAvailable / gitStatus / gitSync / gitInit / gitClone
 *
 * 设计不变量（每条都对应一个失败模式）：
 * - 绝不 `push --force`、绝不 `reset --hard`、绝不代用户 abort 别人的中断态。
 * - bundle 必须是 git 仓库顶层（show-toplevel == root），否则拒绝——
 *   防止把用户其他项目的文件一起 commit / pull。
 * - index.md 是派生文件：冲突或陈旧一律用 core 重新生成，永不阻塞同步。
 * - log.md 是追加式、格式自有：冲突用 mergeLogText 取并集，永不阻塞同步。
 * - 概念 / AGENTS.md / APPEND_SYSTEM_PROMPT.md 冲突 → `merge --abort` + 报清单，
 *   工作区回到同步前状态（已完成的本地提交保留）。
 * - 所有 git 调用：无交互（GIT_TERMINAL_PROMPT=0 / BatchMode）、无编辑器、
 *   带超时，凭证完全交给 git，本模块不落任何 token。
 *
 * 远端配置只存在 git 自己（.git/config），llm-wiki 不新增任何配置字段。
 */

import { execFile } from 'node:child_process'
import { writeFile, access, readdir, realpath } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { mergeLogText, refreshIndex } from './indexlog.mjs'
import { writeRegistry, expandTilde } from './registry.mjs'

/** 默认超时（ms）：fetch/push 走网络，但工具调用不能无限等。 */
export const DEFAULT_GIT_TIMEOUT_MS = 60000

/** 缺省忽略文件（仅 init 且文件缺失时创建，绝不覆盖已有）。 */
const DEFAULT_GITIGNORE = ['.DS_Store', '.obsidian/workspace*.json', '*.tmp', ''].join('\n')

function gitBin(opts = {}) {
  return opts.gitBin || process.env.WIKI_GIT_BIN || 'git'
}

/** 执行一条 git 命令；永不 reject（失败信息进返回值，便于上层组织指引）。 */
async function run(root, args, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_GIT_TIMEOUT_MS
  return new Promise((resolve) => {
    execFile(
      gitBin(opts),
      args,
      {
        cwd: root || process.cwd(),
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: 'echo',
          SSH_ASKPASS: 'echo',
          GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
          GIT_EDITOR: 'true',
          GIT_PAGER: 'cat',
        },
      },
      (err, stdout, stderr) => {
        const out = String(stdout || '')
        const errText = String(stderr || '')
        if (!err) return resolve({ ok: true, code: 0, stdout: out, stderr: errText })
        const code = typeof err.code === 'number' ? err.code : null
        const ecode = typeof err.code === 'string' ? err.code : null
        let error
        if (ecode === 'ENOENT') error = `未找到可执行的 git（${gitBin(opts)}）；安装 git 或用 WIKI_GIT_BIN 指定路径`
        else if (err.killed || code === null) error = `git 执行超时（${timeoutMs}ms）：git ${args.join(' ')}`
        else error = (errText || out || `git ${args.join(' ')} 失败（exit ${code}）`).trim()
        resolve({ ok: false, code, error, stdout: out, stderr: errText })
      },
    )
  })
}

/** git 是否可用（附带版本）。 */
export async function gitAvailable(opts = {}) {
  const r = await run(null, ['--version'], opts)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, version: r.stdout.trim() }
}

/** concept 冲突时不可自动合并的说明。 */
const CONCEPT_CONFLICT_NEXT = '这些是人工/agent 撰写的知识，不自动合并：请人工解决冲突后重跑同步（工作区已恢复到同步前状态）。'

async function pathExists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** git 内部路径（.git 可能不是同名目录）。 */
async function gitPath(root, rel, opts = {}) {
  const r = await run(root, ['rev-parse', '--git-path', rel], opts)
  if (!r.ok) return null
  const p = r.stdout.trim()
  return p.startsWith('/') ? p : join(root, p)
}

/** 是否有未完成的 merge / rebase（绝不替用户处理）。 */
async function inProgressOperation(root, opts = {}) {
  for (const rel of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply']) {
    const p = await gitPath(root, rel, opts)
    if (p && (await pathExists(p))) return rel
  }
  return null
}

/** 解析远端名：显式 remote > origin > 唯一远端。 */
async function resolveRemote(root, explicit, opts = {}) {
  if (explicit) return explicit
  const r = await run(root, ['remote'], opts)
  if (!r.ok) return null
  const remotes = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  if (!remotes.length) return null
  if (remotes.includes('origin')) return 'origin'
  return remotes.length === 1 ? remotes[0] : remotes[0]
}

async function upstreamOf(root, opts = {}) {
  const r = await run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], opts)
  return r.ok ? r.stdout.trim() : null
}

/** 前置检查：git 可用 / 是仓库 / 是仓库顶层 / 无中断态。返回 {ok} 或 {ok:false, step, error, next}。 */
async function precheck(root, opts = {}) {
  const git = await gitAvailable(opts)
  if (!git.ok) return { ok: false, step: 'git', error: git.error, next: '安装 git 或用 WIKI_GIT_BIN 指定 git 路径。' }

  const inRepo = await run(root, ['rev-parse', '--git-dir'], opts)
  if (!inRepo.ok) {
    return { ok: false, step: 'repo', isRepo: false, error: `${root} 不是 git 仓库`, next: '先用 action=init 初始化远端，或用 action=clone 克隆已有知识库。' }
  }
  const top = await run(root, ['rev-parse', '--show-toplevel'], opts)
  const topLevel = top.ok ? top.stdout.trim() : null
  if (!topLevel) return { ok: false, step: 'repo', isRepo: true, error: '无法解析仓库顶层', next: '检查 .git 是否损坏。' }

  let realRoot = root
  let realTop = topLevel
  try { realRoot = await realpath(root) } catch { /* 保留原值 */ }
  try { realTop = await realpath(topLevel) } catch { /* 保留原值 */ }
  if (realRoot !== realTop) {
    return {
      ok: false,
      step: 'guard',
      isRepo: true,
      topLevel,
      error: `bundle（${root}）不是 git 仓库顶层（顶层是 ${topLevel}）`,
      next: '为避免把该仓库其它内容一起 commit/pull：请把 bundle 拆成独立仓库，或用仓库顶层作为 bundle 根。',
    }
  }

  const pending = await inProgressOperation(root, opts)
  if (pending) {
    return { ok: false, step: 'pending', isRepo: true, error: `仓库有未完成的 ${pending}（merge/rebase 进行中）`, next: '请先人工完成或中止该操作，再重跑同步（本工具不会替你 abort）。' }
  }
  return { ok: true, isRepo: true, topLevel, realRoot }
}

/**
 * 只读状态。永不改动仓库。
 * @returns {Promise<{ok:boolean, isRepo?:boolean, git?:string, topLevel?:string, remote?:string|null, branch?:string|null, upstream?:string|null, ahead?:number, behind?:number, dirty?:string[], conflicts?:string[], lastCommit?:string|null, error?:string, next?:string}>}
 */
export async function gitStatus(root, opts = {}) {
  const pre = await precheck(root, opts)
  if (!pre.ok) return pre

  const remote = await resolveRemote(root, opts.remote, opts)
  const branchR = await run(root, ['rev-parse', '--abbrev-ref', 'HEAD'], opts)
  const branch = branchR.ok ? branchR.stdout.trim() : null
  const upstream = await upstreamOf(root, opts)

  let ahead = 0
  let behind = 0
  if (upstream) {
    const c = await run(root, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`], opts)
    if (c.ok) {
      const [b, a] = c.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10) || 0)
      behind = b || 0
      ahead = a || 0
    }
  }

  const st = await run(root, ['status', '--porcelain'], opts)
  const dirty = st.ok ? st.stdout.split('\n').map((s) => s.trimEnd()).filter(Boolean) : []
  const cf = await run(root, ['diff', '--name-only', '--diff-filter=U'], opts)
  const conflicts = cf.ok ? cf.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
  const log = await run(root, ['log', '-1', '--format=%h %ad %s', '--date=short'], opts)
  const lastCommit = log.ok && log.stdout.trim() ? log.stdout.trim() : null

  return {
    ok: true,
    isRepo: true,
    version: (await gitAvailable(opts)).version,
    topLevel: pre.topLevel,
    remote,
    branch,
    upstream,
    ahead,
    behind,
    dirty,
    conflicts,
    lastCommit,
  }
}

/** 读冲突文件的某一侧（2=ours 本地，3=theirs 远端）。 */
async function stageText(root, path, stage, opts = {}) {
  const r = await run(root, ['show', `:${stage}:${path}`], opts)
  return r.ok ? r.stdout : null
}

/**
 * 同步：提交本地 → fetch → merge（必要时）→ 重生成 index → push。
 *
 * @param {string} root bundle 根（必须是仓库顶层）
 * @param {{message?:string, remote?:string, push?:boolean, timeoutMs?:number, gitBin?:string}} [opts]
 */
export async function gitSync(root, opts = {}) {
  const pre = await precheck(root, opts)
  if (!pre.ok) return pre

  const steps = []
  const remote = await resolveRemote(root, opts.remote, opts)
  if (!remote) {
    return { ok: false, step: 'remote', error: '仓库未配置远端', next: '用 action=init 添加远端，或手动 `git remote add origin <url>`。' }
  }

  // 1) 提交本地改动（保证不丢），无改动则跳过
  let committed = 0
  const add = await run(root, ['add', '-A', '.'], opts)
  if (!add.ok) return { ok: false, step: 'add', error: add.error, next: '检查工作区是否有不可读文件。' }
  const staged = await run(root, ['diff', '--cached', '--name-only'], opts)
  const stagedFiles = staged.ok ? staged.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
  if (stagedFiles.length) {
    const msg = opts.message || `wiki: sync ${stagedFiles.length} 个文件`
    const ci = await run(root, ['commit', '-m', msg], opts)
    if (!ci.ok) return { ok: false, step: 'commit', error: ci.error, next: '检查是否有 git hook 失败或用户身份未配置（user.name/user.email）。' }
    committed = stagedFiles.length
    steps.push(`本地提交 ${committed} 个文件`)
  }

  // 2) fetch
  const fetch = await run(root, ['fetch', '--prune', remote], { ...opts, timeoutMs: opts.timeoutMs })
  if (!fetch.ok) return { ok: false, step: 'fetch', error: fetch.error, next: '检查网络与凭证（本工具不保存 token；SSH 需免密/agent）。' }

  const upstream = (await upstreamOf(root, opts)) || (await remoteUpstream(root, remote, opts))
  const before = await run(root, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`], opts)
  let behind = 0
  let ahead = 0
  if (before.ok) {
    const [b, a] = before.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10) || 0)
    behind = b || 0
    ahead = a || 0
  }

  let merged = false
  let mergeConflicts = []
  if (behind > 0) {
    if (ahead === 0) {
      const ff = await run(root, ['merge', '--ff-only', upstream], opts)
      if (!ff.ok) return { ok: false, step: 'merge', error: ff.error, next: '远端历史与本地不兼容，请人工检查。' }
      merged = true
      steps.push(`快进 ${behind} 个远端提交`)
    } else {
      const mg = await run(root, ['merge', '--no-ff', '--no-commit', upstream], opts)
      const unmergedR = await run(root, ['diff', '--name-only', '--diff-filter=U'], opts)
      const unmerged = unmergedR.ok ? unmergedR.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
      const conceptConflicts = unmerged.filter((p) => !(basename(p) === 'index.md' || p === 'log.md'))
      if (conceptConflicts.length) {
        await run(root, ['merge', '--abort'], opts)
        return {
          ok: false,
          step: 'merge',
          conflicts: unmerged,
          error: `${conceptConflicts.length} 个概念/配置文件冲突：${conceptConflicts.join('、')}`,
          next: CONCEPT_CONFLICT_NEXT,
          committed,
        }
      }
      // log.md：追加式并集
      if (unmerged.includes('log.md')) {
        const ours = (await stageText(root, 'log.md', 2, opts)) ?? ''
        const theirs = (await stageText(root, 'log.md', 3, opts)) ?? ''
        const mergedText = mergeLogText(ours, theirs)
        await writeFile(join(root, 'log.md'), mergedText)
        const a2 = await run(root, ['add', '--', 'log.md'], opts)
        if (!a2.ok) return { ok: false, step: 'merge', error: a2.error, next: 'log.md 合并写回失败。' }
        steps.push('合并 log.md（并集）')
      }
      // index.md：派生文件，先取任一侧占位，merge 后统一重生成
      for (const p of unmerged.filter((x) => basename(x) === 'index.md')) {
        const t = await run(root, ['checkout', '--theirs', '--', p], opts)
        if (!t.ok) await run(root, ['checkout', '--ours', '--', p], opts)
        await run(root, ['add', '--', p], opts)
        steps.push(`index.md 冲突占位待重生成：${p}`)
      }
      mergeConflicts = unmerged
      const mc = await run(root, ['commit', '--no-edit'], opts)
      if (!mc.ok) return { ok: false, step: 'merge', error: mc.error, next: '合并提交失败，请人工检查工作区。' }
      merged = true
      steps.push(`合并 ${behind} 个远端提交`)
    }
  }
  // 3) 重生成 index（派生文件）：无论是否 merge 都做，保证与目录树一致
  const idx = await refreshIndex(root)
  const dirtyIdx = await run(root, ['status', '--porcelain', '--', 'index.md'], opts)
  const indexChanged = dirtyIdx.ok && dirtyIdx.stdout.split('\n').some((l) => l.trim())
  if (indexChanged) {
    await run(root, ['add', '-A', '--', 'index.md'], opts)
    const ci = await run(root, ['commit', '-m', 'wiki: refresh index'], opts)
    if (ci.ok) steps.push('重生成 index.md')
  }

  // 4) push（不 force）
  let pushed = false
  if (opts.push !== false) {
    const branchR = await run(root, ['rev-parse', '--abbrev-ref', 'HEAD'], opts)
    const branch = branchR.ok ? branchR.stdout.trim() : 'HEAD'
    const pushArgs = upstream
      ? ['push', remote, `HEAD:${upstream.replace(/^[^/]+\//, 'refs/heads/')}`]
      : ['push', '-u', remote, `HEAD:refs/heads/${branch}`]
    const p = await run(root, pushArgs, { ...opts })
    if (!p.ok) {
      const rejected = /rejected|non-fast-forward|fetch first|behind/i.test(p.stderr || p.error || '')
      return {
        ok: false,
        step: 'push',
        error: p.error,
        next: rejected ? '远端在同步期间又前进了：重跑同步即可（不做 force push）。' : '检查推送权限与网络；本工具不保存凭证。',
        committed,
        merged,
      }
    }
    pushed = true
    steps.push('push')
  }

  const st = await gitStatus(root, opts)
  return {
    ok: true,
    committed,
    merged,
    conflicts: mergeConflicts,
    indexFiles: idx.files.length,
    pushed,
    steps,
    status: st.ok ? { remote: st.remote, branch: st.branch, ahead: st.ahead, behind: st.behind } : null,
  }
}

/** 无 upstream 时用 remote 的默认分支作为比较对象。 */
async function remoteUpstream(root, remote, opts = {}) {
  const r = await run(root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], opts)
  if (r.ok && r.stdout.trim()) return r.stdout.trim()
  return `${remote}/main`
}

/**
 * 初始化：git init + 最小 .gitignore（仅缺失时）+ 首提交 + 可选远端/首推/注册命名 bundle。
 *
 * @param {string} root bundle 根
 * @param {{remote?:string, branch?:string, name?:string, use?:boolean, push?:boolean, message?:string, timeoutMs?:number, gitBin?:string}} [opts]
 */
export async function gitInit(root, opts = {}) {
  const git = await gitAvailable(opts)
  if (!git.ok) return { ok: false, step: 'git', error: git.error, next: '安装 git 或用 WIKI_GIT_BIN 指定 git 路径。' }

  const branch = opts.branch || 'main'
  const inRepo = await run(root, ['rev-parse', '--git-dir'], opts)
  const steps = []
  if (!inRepo.ok) {
    const init = await run(root, ['init', '-b', branch], opts)
    if (!init.ok) {
      // 老版本 git 无 -b
      const legacy = await run(root, ['init'], opts)
      if (!legacy.ok) return { ok: false, step: 'init', error: legacy.error, next: '检查目录权限。' }
      await run(root, ['checkout', '-b', branch], opts)
    }
    steps.push(`git init（分支 ${branch}）`)
  }

  const ignorePath = join(root, '.gitignore')
  if (!(await pathExists(ignorePath))) {
    await writeFile(ignorePath, DEFAULT_GITIGNORE)
    steps.push('创建最小 .gitignore')
  }

  const remotesR = await run(root, ['remote'], opts)
  const remotes = remotesR.ok ? remotesR.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
  let remote = remotes.includes('origin') ? 'origin' : remotes[0] || null
  if (opts.remote) {
    if (!remote) {
      const add = await run(root, ['remote', 'add', 'origin', expandTilde(opts.remote)], opts)
      if (!add.ok) return { ok: false, step: 'remote', error: add.error, next: '检查远端 URL 是否合法/可访问。' }
      remote = 'origin'
      steps.push(`添加远端 origin → ${opts.remote}`)
    } else if (remote !== 'origin' || opts.remote) {
      const urlR = await run(root, ['remote', 'get-url', remote], opts)
      const cur = urlR.ok ? urlR.stdout.trim() : ''
      if (cur !== expandTilde(opts.remote)) {
        return { ok: false, step: 'remote', error: `仓库已有远端 ${remote} → ${cur}`, next: '如需更换请手动 `git remote set-url`，或用 action=sync 走既有远端。' }
      }
    }
  }

  const add = await run(root, ['add', '-A', '.'], opts)
  if (!add.ok) return { ok: false, step: 'add', error: add.error, next: '检查工作区是否有不可读文件。' }
  const staged = await run(root, ['diff', '--cached', '--name-only'], opts)
  if (staged.ok && staged.stdout.trim()) {
    const ci = await run(root, ['commit', '-m', opts.message || 'wiki: initial commit'], opts)
    if (!ci.ok) return { ok: false, step: 'commit', error: ci.error, next: '配置 git 用户身份（user.name/user.email）后重试。' }
    steps.push('首个提交')
  }

  let pushed = false
  if (remote && opts.push !== false) {
    const p = await run(root, ['push', '-u', remote, `HEAD:refs/heads/${branch}`], opts)
    if (!p.ok) {
      return { ok: false, step: 'push', error: p.error, next: '远端可能已有内容或凭证不可用：检查后重跑（不 force push）。', steps }
    }
    pushed = true
    steps.push('push -u')
  }

  let registered = null
  if (opts.name && String(opts.name).trim()) {
    const name = String(opts.name).trim()
    await writeRegistry({ bundles: { [name]: root }, ...(opts.use ? { active: name } : {}) })
    registered = name
    steps.push(`注册命名 bundle「${name}」`)
  }

  return { ok: true, root, branch, remote, pushed, registered, steps }
}

/**
 * 克隆远端为本地 bundle，可选注册命名 bundle（写 core 注册表，三形态共享）。
 *
 * @param {string} url
 * @param {string} dir 目标目录（须不存在或为空）
 * @param {{name?:string, use?:boolean, timeoutMs?:number, gitBin?:string}} [opts]
 */
export async function gitClone(url, dir, opts = {}) {
  const git = await gitAvailable(opts)
  if (!git.ok) return { ok: false, step: 'git', error: git.error, next: '安装 git 或用 WIKI_GIT_BIN 指定 git 路径。' }
  if (!url || !dir) return { ok: false, step: 'args', error: 'clone 需要 url 与目标目录', next: '用法：wiki sync clone <url> <dir> [--name N] [--use]。' }

  const target = expandTilde(dir)
  if (await pathExists(target)) {
    const entries = await readdir(target).catch(() => null)
    if (entries === null) return { ok: false, step: 'target', error: `${target} 不可读`, next: '检查路径权限。' }
    if (entries.length) return { ok: false, step: 'target', error: `${target} 已存在且非空`, next: '换一个目标目录，或直接对已有目录用 action=sync。' }
  }

  const parent = dirname(target)
  const clone = await run(parent, ['clone', url, basename(target)], opts)
  if (!clone.ok) return { ok: false, step: 'clone', error: clone.error, next: '检查 URL、网络与凭证（不保存 token）。' }

  const steps = [`克隆到 ${target}`]
  let registered = null
  if (opts.name && String(opts.name).trim()) {
    const name = String(opts.name).trim()
    await writeRegistry({ bundles: { [name]: target }, ...(opts.use ? { active: name } : {}) })
    registered = name
    steps.push(`注册命名 bundle「${name}」`)
  }
  return { ok: true, dir: target, registered, steps }
}
