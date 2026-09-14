/**
 * dsh-wiki —— DSH 宿主插件（llm-wiki 通用知识库，纯 OKF v0.2）。
 *
 * 复用 @sidleo3/llm-wiki-core（packages/core）的全部逻辑；本文件只做宿主适配：
 * - 描述层注入（system-prompt/assemble 瀑布，可选宿主优化）
 * - 注册 11 个 wiki_* 工具
 * - 写入门控：读 AGENTS.md 规则后由 agent 交互确认（无代码强制弹窗）
 *
 * 注入分两层（前缀缓存决定，勿混）：
 * - 恒定层：工具引导 section（order 62），模块级常量，任何会话/分支/用户逐字节相同；
 *   system prompt 渲染不变 → DSH 的 SystemPromptProjection 恒为 no-op（不追加、不改写）。
 * - 会话层：当前 bundle/目录清单/APPEND_SYSTEM_PROMPT 规则 → runtime context 快照，
 *   由宿主追加在会话尾部，只在内容真变化时产生新消息；绝不放 system prompt——
 *   否则最小代价是「追加一整份完整 prompt」，在请求序列边界（如 goal round）是「整段前缀作废」。
 *   因此计数（共 N 个概念 / N concepts）不进注入：它是每次写入都变的高频 churn 源，
 *   清单归 wiki_list / wiki_dirs。
 *
 * 数据目录默认 ~/.agents/wiki（os.homedir() 计算，可经 profile 补丁 config
 * dataDir 覆盖）。多目录：config.dataDirs 声明命名 bundle（与注册表
 * ~/.agents/wiki-registry.json 合并，同名 config 优先）；wiki_use 会话级切换
 * （按对话 agent 隔离），global:true 持久化为全局默认。工具 schema 遵循宿主 DSL 形态。
 *
 * 图形化配置（设置 → 插件 → 插件配置）：
 * - 注册设置命名空间 dsh-wiki（skills 服务可选接入，见 registerSettingsNamespace），
 *   cordis 配置为 base 层、用户改动落在 ~/.dsh/settings.yaml，即时生效（live）；
 * - 注册 /api/dsh-wiki/* 只读/写路由（webServer 可选接入）：命名 bundle 管理、
 *   在线同步（core git）、体检（validate/lint/index）；
 *   运行参数（dataDir/注入 section/上限/缓存 TTL）是部署级配置，只读 profile 的 cordis.patch.yml。
 * - 卡片本体在浏览器半 lib/client.js（src/client/index.ts 构建，见 tsdown.config.ts）。
 *   卡片 key 必须等于设置命名空间名：DSH 插件配置 Tab 只渲染 host 已服务命名空间的卡片。
 *
 * 在线同步：两种后端——本地目录 bundle 用 core git.mjs（Git 远端），
 * 飞书 bundle（kind:'feishu'，云盘文件夹存原生 .md）用 core feishu.mjs；
 * agent 侧同一入口 wiki_sync，按当前 bundle 的 kind 自动分派。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'wiki-registry'
export const inject = ['systemPrompt', 'tools']

/** 插件版本（写入门控的 producer 版本、卡片状态展示共用）。 */
const PLUGIN_VERSION = '0.4.3'

/** 设置命名空间（小写字母/数字/连字符）；卡片 key 必须与它一致（只为卡片可见性而注册）。 */
const SETTINGS_NS = 'dsh-wiki'

// core 加载：优先同包 vendor-core（自包含安装），回退本仓库 packages/core（开发态）
const __dirname = dirname(fileURLToPath(import.meta.url))
let core
async function loadCore() {
  if (core) return core
  const vendor = join(__dirname, 'vendor-core', 'index.mjs')
  try {
    await import('node:fs/promises').then((fs) => fs.access(vendor))
    core = await import(vendor + '?t=' + Date.now())
  } catch {
    const dev = join(__dirname, '..', 'core', 'index.mjs')
    try {
      await import('node:fs/promises').then((fs) => fs.access(dev))
      core = await import(dev + '?t=' + Date.now())
    } catch {
      throw new Error('llm-wiki-core 未找到：请运行 packages/dsh/scripts/sync-vendor.mjs 同步 vendor-core')
    }
  }
  return core
}

const DEFAULTS = {
  dataDir: join(homedir(), '.agents', 'wiki'),
  sectionName: 'wiki-registry',
  sectionOrder: 62,
  maxSectionChars: 6000,
  contextOrder: 130,
  maxContextChars: 12000,
  maxGetChars: 40000,
  cacheTtlMs: 30000,
}

/** 会话层 runtime context 的稳定名（第一方约定 `ns:name`，见 sandbox:policy / subagent:delegation）。 */
const CONTEXT_NAME = 'wiki-registry:bundle'

/**
 * 恒定层正文：所有会话、所有 bundle 分支、所有用户逐字节相同。
 * 【不变量】禁止加入任何会话/机器可变值（路径、计数、时间戳、bundle 名、版本号）——
 * 一个字节的差异就会让整个 system prompt 前缀失去复用。
 */
const SECTION_TEXT = [
  '## 通用知识库（llm-wiki · OKF v0.2）',
  '> 目录自由分层（表/口径计算/坑点/指标…靠 type 区分），概念间用真实链接交叉引用。',
  '> 【硬要求】涉及知识检索/写入的第一步：先 `wiki_list` 看全貌（渐进披露），再决定下一步——不要凭印象直接搜或写。',
  '- 步骤1 wiki_list — 目录树 + 概念清单（type/title/id）',
  '- 步骤2 wiki_search — 关键词检索（匹配 frontmatter + 正文）',
  '- 步骤3 wiki_get — 读取单个概念完整正文（自动附 backlinks：引用它的坑点/概念）',
  '- wiki_create / wiki_update — 写入（门控读目录 AGENTS.md 规则，确认后带 human verified）',
  '- wiki_validate — OKF v0.2 合规校验；wiki_lint — 体检（断链/孤儿/过期/缺 index）',
  '- wiki_ingest — 登记外部源文件进 bundle；wiki_deprecate — 目录级批量停用（status: deprecated）',
  '- wiki_dirs — 查看已配置的目录分支；wiki_use <name> [global:true] — 切换当前分支（会话级/持久化全局默认）',
  '- wiki_sync — 在线知识库同步（按 bundle 后端分派）：本地目录走 Git 远端（status/sync/init/clone），飞书云盘库走 lark-cli（status/sync/pull/push/init，文件级增量、永不删两端）。冲突都停下来报清单，绝不 force/覆盖。见 wiki_help sync 与 wiki_help feishu。',
  '- 图形化配置：设置 → 插件 → 插件配置 → llm-wiki 卡片（命名目录管理 / 在线同步 / 体检与索引）；运行参数属部署级，改 profile 的 cordis.patch.yml。',
  '- wiki_help — 查机制文档（保留文件/怎么写 AGENTS.md/怎么写 APPEND_SYSTEM_PROMPT.md/frontmatter/门控/多目录）。想给某分类加行为规则 → 在该目录建 APPEND_SYSTEM_PROMPT.md（正文即追加的 system prompt）；想定写门控 → 在该目录 AGENTS.md 写「## 门控」节。详情 wiki help。',
].join('\n')

function listVal(v) {
  if (v === undefined || v === null || v === '') return []
  return String(v).split(/\s*,\s*/).filter(Boolean)
}

function parseArgs(args) {
  return {
    type: args?.type,
    tag: args?.tag,
    status: args?.status,
    query: args?.query,
    id: args?.id,
    path: args?.path,
    title: args?.title,
    description: args?.description,
    body: args?.body,
    tags: listVal(args?.tags),
    user_approved: args?.user_approved === true,
    confirmed: args?.confirmed === true,
  }
}

/** 工具统一输出为文本。 */
function textOutput() {
  return {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
    render: (_a, v) => [{ type: 'text', text: v.text }],
  }
}

function strErr(e) {
  return { text: `错误：${e && e.message ? e.message : String(e)}` }
}

// ──────────────────────────── 设置界面支撑（宿主半）────────────────────────────

/** schemastery 是可选依赖：缺失时插件照常工作，只是不注册设置命名空间（卡片不出现）。 */
async function loadSchemastery() {
  try {
    return (await import('schemastery')).default
  } catch {
    return null
  }
}

/** bundle 名（注册表 key）合法性与保留名。 */
function validateBundleName(name) {
  const n = String(name || '').trim()
  if (!n) return '名称不能为空'
  if (n === 'default') return '「default」是兜底入口名，不能注册'
  if (/[\\/]/.test(n)) return '名称不能含路径分隔符'
  if (n.length > 64) return '名称过长（≤64 字符）'
  return null
}

/** 目录探查：存在？是目录？像不像 bundle（有 .md 或子目录）？ */
async function probeBundlePath(path) {
  try {
    const st = await stat(path)
    if (!st.isDirectory()) return { exists: true, isDir: false, isBundle: false }
    const entries = await readdir(path, { withFileTypes: true })
    const isBundle = entries.some((e) => e.isFile() && e.name.endsWith('.md')) || entries.some((e) => e.isDirectory() && !e.name.startsWith('.'))
    return { exists: true, isDir: true, isBundle }
  } catch {
    return { exists: false, isDir: false, isBundle: false }
  }
}

async function readJsonBody(req) {
  const chunks = []
  await new Promise((resolve, reject) => {
    if (typeof req.on !== 'function') return resolve()
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
    req.on('end', resolve)
    req.on('error', reject)
  })
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  return JSON.parse(text)
}

function jsonResponse(res, body, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 飞书同步结果文本化。 */
function formatFeishuResult(action, r) {
  const lines = []
  if (action === 'status') {
    if (!r.ok) return `在线库状态：不可用\n- ${r.error}${r.next ? `\n- 下一步：${r.next}` : ''}`
    const c = r.counts || {}
    lines.push(`在线库状态：待推送 ${c.push} / 待拉取 ${c.pull} / 冲突 ${c.conflict}｜本地 ${c.local} 个 .md，远端 ${c.remote} 个 .md`)
    if (r.push.length) lines.push(`- 待推送：${r.push.map((x) => x.rel).slice(0, 8).join('、')}${r.push.length > 8 ? ' …' : ''}`)
    if (r.pull.length) lines.push(`- 待拉取：${r.pull.map((x) => x.rel).slice(0, 8).join('、')}${r.pull.length > 8 ? ' …' : ''}`)
    if (r.conflict.length) lines.push(`- 冲突（两侧都改）：${r.conflict.map((x) => x.rel).join('、')}`)
    if (r.remoteDeleted.length) lines.push(`- 远端已删（本地保留，v1 不同步删除）：${r.remoteDeleted.join('、')}`)
    if (r.ignored && r.ignored.length) lines.push(`- 已忽略的非 .md 资源：${r.ignored.slice(0, 5).join('、')}${r.ignored.length > 5 ? ' …' : ''}`)
    return lines.join('\n')
  }
  if (r.ok) {
    lines.push(`${action === 'init' ? '在线库初始化完成' : action === 'pull' ? '拉取完成' : action === 'push' ? '推送完成' : '同步完成'}${r.bundle ? `：${r.bundle.name}` : ''}`)
    if (r.createdFolder) lines.push(`- 新建飞书文件夹：${r.createdFolder.name} → ${r.url}`)
    if (r.pushed && r.pushed.length) lines.push(`- 推送 ${r.pushed.length} 个文件（新增 ${(r.created || []).length}）`)
    if (r.pulled && r.pulled.length) lines.push(`- 拉取 ${r.pulled.length} 个文件`)
    if (r.after) lines.push(`- 现在：待推送 ${r.after.push} / 待拉取 ${r.after.pull} / 冲突 ${r.after.conflict}`)
    for (const st of r.steps || []) lines.push(`  · ${st}`)
    if (r.backups && r.backups.length) lines.push(`- 覆盖前备份：${r.backups.slice(0, 3).join('、')}${r.backups.length > 3 ? ' …' : ''}`)
    return lines.join('\n')
  }
  lines.push(`${action === 'init' ? '初始化' : action}失败（${r.step || 'unknown'}）：${r.error || '未知错误'}`)
  if (r.conflicts && r.conflicts.length) lines.push(`- 冲突文件：${r.conflicts.join('、')}`)
  if (r.failed && r.failed.length) lines.push(`- 失败文件：${r.failed.slice(0, 5).map((f) => f.rel).join('、')}`)
  if (r.next) lines.push(`- 下一步：${r.next}`)
  return lines.join('\n')
}

/** git 结果文本化（wiki_sync 工具与诊断共用）。 */
function formatGitResult(action, r) {
  const lines = []
  if (action === 'status') {
    if (!r.ok) return `同步状态：不可用\n- ${r.error}${r.next ? `\n- 下一步：${r.next}` : ''}`
    lines.push(`同步状态：${r.remote || '(未配置远端)'}`)
    lines.push(`- 分支：${r.branch || '(detached)'}${r.upstream ? ` → ${r.upstream}` : '（未设 upstream）'}`)
    lines.push(`- 领先 ${r.ahead} / 落后 ${r.behind}`)
    lines.push(`- 工作区改动：${r.dirty.length} 个文件`)
    if (r.conflicts.length) lines.push(`- 冲突：${r.conflicts.join('、')}`)
    lines.push(`- 最后提交：${r.lastCommit || '(无)'}`)
    return lines.join('\n')
  }
  if (r.ok) {
    if (action === 'clone') return `已克隆：${r.dir}${r.registered ? `（注册为「${r.registered}」）` : ''}\n${(r.steps || []).join('\n')}`
    lines.push(`${action === 'init' ? '初始化完成' : '同步完成'}${r.bundle ? `：${r.bundle.name} → ${r.bundle.path}` : ''}`)
    if (r.committed) lines.push(`- 本地提交：${r.committed} 个文件`)
    if (r.merged) lines.push('- 已合并远端变更')
    if (r.pushed) lines.push('- 已推送')
    if (r.status) lines.push(`- 现在：领先 ${r.status.ahead} / 落后 ${r.status.behind}`)
    if (r.files) lines.push(`- 重建 index：${r.files.length} 个文件`)
    if (r.steps && r.steps.length) lines.push(...r.steps.map((s) => `  · ${s}`))
    return lines.join('\n')
  }
  lines.push(`${action === 'init' ? '初始化' : '同步'}失败（${r.step || 'unknown'}）：${r.error || '未知错误'}`)
  if (r.conflicts && r.conflicts.length) lines.push(`- 冲突文件：${r.conflicts.join('、')}`)
  if (r.next) lines.push(`- 下一步：${r.next}`)
  return lines.join('\n')
}

/**
 * 注册 /api/dsh-wiki/* 路由（webServer 可选接入；非 web 部署不注册，插件照常工作）。
 * 卡片（lib/client.js）只跟这些端点对话：命名 bundle 管理 / 参数 / 体检 / index / 在线同步。
 */
function registerWebRoutes(ctx, deps) {
  const { effectiveConfig, loadCore, invalidateCaches } = deps
  const webServer = ctx.get('webServer')
  if (!webServer || typeof webServer.register !== 'function') return

  const route = (path, handler) => webServer.register({ kind: 'exact', path, handler })

  /** 解析目标 bundle：显式 name > 当前激活；未知名字抛错（卡片显示原文）。 */
  async function target(core, name) {
    const cfg = effectiveConfig()
    return name ? core.resolveBundleRoot(cfg, { name: String(name) }) : core.resolveBundleRoot(cfg, {})
  }

  // GET /api/dsh-wiki/state —— 注册表 + 部署声明 + 生效参数 + 目录探查
  route('/api/dsh-wiki/state', async (_req, res) => {
    try {
      const c = await loadCore()
      const cfg = effectiveConfig()
      const reg = await c.readRegistry()
      const declared = cfg.dataDirs && typeof cfg.dataDirs === 'object' ? cfg.dataDirs : {}
      const active = await c.resolveBundleRoot(cfg, {})
      const names = [...new Set([...Object.keys(reg.bundles || {}), ...Object.keys(declared)])].sort((a, b) => a.localeCompare(b, 'zh'))
      const entries = []
      for (const n of names) {
        const fromConfig = Object.prototype.hasOwnProperty.call(declared, n)
        const raw = fromConfig ? declared[n] : reg.bundles[n]
        const spec = c.normalizeBundleSpec(raw, { name: n })
        if (!spec) continue
        const path = spec.path
        const decl = spec.decl && typeof spec.decl === 'object' ? spec.decl : {}
        entries.push({
          name: n,
          kind: spec.kind,
          path,
          source: fromConfig ? 'config' : 'registry',
          shadowed: fromConfig && Object.prototype.hasOwnProperty.call(reg.bundles || {}, n),
          active: n === active.name,
          ...(spec.kind === 'feishu'
            ? { folderToken: decl.folderToken || '', folderUrl: decl.folderToken ? c.feishuFolderUrl(decl.folderToken) : '', cacheDir: path }
            : {}),
          ...(await probeBundlePath(path)),
        })
      }
      jsonResponse(res, {
        ok: true,
        settingsNamespace: SETTINGS_NS,
        active: { name: active.name, path: active.path },
        registryPath: c.registryFile(),
        entries,
        git: await c.gitAvailable(),
      })
    } catch (e) {
      jsonResponse(res, { ok: false, error: e && e.message ? e.message : String(e) }, 500)
    }
  })

  // POST /api/dsh-wiki/bundles —— 命名 bundle 增删改名/设默认（只写注册表，不删数据）
  route('/api/dsh-wiki/bundles', async (req, res) => {
    try {
      const c = await loadCore()
      const body = await readJsonBody(req)
      const op = String(body.op || '')
      const reg = await c.readRegistry()
      const declared = effectiveConfig().dataDirs || {}
      const isConfigDeclared = (n) => Object.prototype.hasOwnProperty.call(declared, n)

      if (op === 'add' || op === 'rename') {
        const name = String(body.name || '').trim()
        const nextName = op === 'rename' ? String(body.newName || '').trim() : name
        for (const [n, label] of [[name, '名称'], [nextName, '新名称']]) {
          const err = validateBundleName(n)
          if (err) return jsonResponse(res, { ok: false, error: `${label}：${err}` }, 400)
        }
        const prevDecl = op === 'rename' ? reg.bundles[name] : undefined
        const prevSpec = op === 'rename' ? c.normalizeBundleSpec(prevDecl, { name }) : null
        if (op === 'rename') {
          if (!Object.prototype.hasOwnProperty.call(reg.bundles || {}, name)) {
            return jsonResponse(res, { ok: false, error: `注册表里没有「${name}」（部署配置声明的目录不可改名）` }, 400)
          }
          if (isConfigDeclared(name)) {
            return jsonResponse(res, { ok: false, error: `「${name}」由部署配置声明，不能在线改名或删除` }, 400)
          }
        }
        // 目标名冲突直接拒绝：避免静默覆盖注册表条目，或被部署配置遮蔽而"看起来没生效"
        if (nextName !== name || op === 'add') {
          if (isConfigDeclared(nextName)) return jsonResponse(res, { ok: false, error: `「${nextName}」已由部署配置声明（profile 的 dataDirs），不能重名` }, 400)
          if (Object.prototype.hasOwnProperty.call(reg.bundles || {}, nextName)) {
            return jsonResponse(res, { ok: false, error: `「${nextName}」已存在：改用改名，或先删除该条目` }, 400)
          }
        }

        // 后端类型：默认沿用原条目（rename）或本地目录（add，提供了 path）
        const kind = body.kind === 'feishu' ? 'feishu' : body.folderToken ? 'feishu' : prevSpec ? prevSpec.kind : 'local'
        let spec
        if (kind === 'feishu') {
          const folderToken = c.feishuParseFolderToken(body.folderToken || (prevSpec && prevSpec.decl && prevSpec.decl.folderToken) || '')
          if (!folderToken) return jsonResponse(res, { ok: false, error: '飞书库需要云盘文件夹 URL 或 token（或先用「在飞书新建文件夹」）' }, 400)
          const prevCache = prevSpec && prevSpec.decl ? prevSpec.decl.cacheDir : ''
          const cacheDir = String(body.cacheDir || '').trim() || (prevCache && prevCache !== c.defaultCloudDir(name) ? prevCache : c.defaultCloudDir(nextName))
          spec = { kind: 'feishu', folderToken, cacheDir: c.expandTilde(cacheDir) }
        } else {
          const path = c.expandTilde(String(body.path || (prevSpec ? prevSpec.path : '')).trim())
          if (!path) return jsonResponse(res, { ok: false, error: '目录路径不能为空' }, 400)
          spec = path
        }

        if (op === 'rename') await c.removeBundle(name)
        await c.writeRegistry({ bundles: { [nextName]: spec }, ...(op === 'rename' && reg.active === name ? { active: nextName } : {}) })
        invalidateCaches()
        const resolved = await c.resolveBundleRoot(effectiveConfig(), { name: nextName })
        const probe = await probeBundlePath(resolved.path)
        return jsonResponse(res, { ok: true, name: nextName, kind: resolved.kind, path: resolved.path, ...probe })
      }

      if (op === 'remove') {
        const name = String(body.name || '').trim()
        if (!name) return jsonResponse(res, { ok: false, error: '名称不能为空' }, 400)
        if (isConfigDeclared(name)) return jsonResponse(res, { ok: false, error: `「${name}」由部署配置声明，不能在线删除` }, 400)
        if (reg.active === name) return jsonResponse(res, { ok: false, error: `「${name}」是当前默认分支：先把其它分支设为默认，再删除` }, 400)
        const r = await c.removeBundle(name)
        invalidateCaches()
        return jsonResponse(res, { ok: true, removed: r.removed, active: r.active })
      }

      if (op === 'activate') {
        const name = String(body.name || '').trim()
        const resolved = await c.resolveBundleRoot(effectiveConfig(), { name })
        await c.writeRegistryActive(resolved.name)
        invalidateCaches()
        return jsonResponse(res, { ok: true, active: resolved })
      }

      jsonResponse(res, { ok: false, error: `未知操作：${op}` }, 400)
    } catch (e) {
      jsonResponse(res, { ok: false, error: e && e.message ? e.message : String(e) }, 400)
    }
  })

  // GET /api/dsh-wiki/health?bundle=NAME —— validate + lint + 树统计
  route('/api/dsh-wiki/health', async (req, res) => {
    try {
      const c = await loadCore()
      const url = new URL(req.url || '/', 'http://localhost')
      const t = await target(c, url.searchParams.get('bundle'))
      const [validate, lint, tree] = await Promise.all([c.validateBundle(t.path), c.lintBundle(t.path), c.listBundle(t.path)])
      jsonResponse(res, {
        ok: true,
        bundle: t,
        validate,
        lint,
        tree: { dirs: tree.length, concepts: tree.reduce((n, x) => n + x.concepts.length, 0), dirList: tree.map((x) => x.dir) },
      })
    } catch (e) {
      jsonResponse(res, { ok: false, error: e && e.message ? e.message : String(e) }, 400)
    }
  })

  // POST /api/dsh-wiki/index —— 重建 index.md（派生文件，显式触发）
  route('/api/dsh-wiki/index', async (req, res) => {
    try {
      const c = await loadCore()
      const body = await readJsonBody(req)
      const t = await target(c, body.bundle)
      const r = await c.refreshIndex(t.path)
      invalidateCaches()
      jsonResponse(res, { ok: true, bundle: t, files: r.files })
    } catch (e) {
      jsonResponse(res, { ok: false, error: e && e.message ? e.message : String(e) }, 400)
    }
  })

  // GET/POST /api/dsh-wiki/sync —— 在线同步（按 bundle 后端分派：git 仓库 / 飞书云盘库）
  // （同一路径只能注册一条路由：宿主按路径匹配，handler 内自行按 method 分派）
  route('/api/dsh-wiki/sync', async (req, res) => {
    try {
      const c = await loadCore()
      const method = String((req && req.method) || 'GET').toUpperCase()
      const isFeishu = (t) => t.kind === 'feishu'

      if (method === 'GET') {
        const url = new URL(req.url || '/', 'http://localhost')
        const t = await target(c, url.searchParams.get('bundle'))
        if (isFeishu(t)) {
          const feishu = await c.feishuStatus(t)
          return jsonResponse(res, { ok: true, bundle: t, backend: 'feishu', feishu, url: t.decl && t.decl.folderToken ? c.feishuFolderUrl(t.decl.folderToken) : '' })
        }
        return jsonResponse(res, { ok: true, bundle: t, backend: 'git', git: await c.gitStatus(t.path) })
      }

      const body = await readJsonBody(req)
      const op = String(body.op || 'sync')

      // 飞书后端初始化：新建/挂载云盘文件夹 + 注册命名 bundle（再首推由 op=sync 完成）
      if (op === 'feishu-init') {
        const r = await c.feishuInit({ name: body.name, folderToken: body.folderToken, newFolder: body.newFolder, cacheDir: body.cacheDir, label: body.label, use: body.use === true })
        invalidateCaches()
        return jsonResponse(res, r, r.ok ? 200 : 400)
      }

      if (op === 'clone') {
        if (!body.url) return jsonResponse(res, { ok: false, error: 'clone 需要 url' }, 400)
        if (!body.dir) return jsonResponse(res, { ok: false, error: 'clone 需要目标目录 dir' }, 400)
        const r = await c.gitClone(String(body.url), String(body.dir), { name: body.name, use: body.use === true })
        invalidateCaches()
        return jsonResponse(res, r, r.ok ? 200 : 400)
      }

      const t = await target(c, body.bundle)

      if (isFeishu(t)) {
        if (op === 'status') {
          const r = await c.feishuStatus(t)
          return jsonResponse(res, { ...r, bundle: t, backend: 'feishu' }, r.ok ? 200 : 400)
        }
        if (op === 'pull') {
          const before = await c.feishuStatus(t)
          if (!before.ok) return jsonResponse(res, before, 400)
          const paths = before.pull.map((x) => x.rel)
          const r = await c.feishuPull(t, { paths })
          invalidateCaches()
          return jsonResponse(res, { ...r, bundle: t, files: paths.length }, r.ok ? 200 : 409)
        }
        if (op === 'push') {
          const before = await c.feishuStatus(t)
          if (!before.ok) return jsonResponse(res, before, 400)
          if (before.conflict.length) {
            return jsonResponse(res, { ok: false, step: 'conflict', conflicts: before.conflict.map((x) => x.rel), error: `${before.conflict.length} 个文件两侧都改过`, next: '请先人工处理冲突（飞书或本地任选一侧）再重跑。' }, 409)
          }
          const r = await c.feishuPush(t, { paths: before.push.map((x) => x.rel) })
          invalidateCaches()
          return jsonResponse(res, { ...r, bundle: t }, r.ok ? 200 : 409)
        }
        if (op === 'sync') {
          const r = await c.feishuSync(t, { adopt: body.adopt, message: body.message })
          invalidateCaches()
          return jsonResponse(res, { ...r, bundle: t, backend: 'feishu' }, r.ok ? 200 : 409)
        }
        return jsonResponse(res, { ok: false, error: `飞书后端不支持操作：${op}（可用 status/pull/push/sync）` }, 400)
      }

      if (op === 'sync' || op === 'push' || op === 'pull') {
        const r = await c.gitSync(t.path, { message: body.message, push: op !== 'pull' })
        invalidateCaches()
        return jsonResponse(res, { ...r, bundle: t, backend: 'git' }, r.ok ? 200 : 409)
      }
      if (op === 'init') {
        const r = await c.gitInit(t.path, { remote: body.remote, branch: body.branch, name: body.name, use: body.use === true })
        invalidateCaches()
        return jsonResponse(res, { ...r, bundle: t, backend: 'git' }, r.ok ? 200 : 400)
      }
      jsonResponse(res, { ok: false, error: `未知操作：${op}` }, 400)
    } catch (e) {
      jsonResponse(res, { ok: false, error: e && e.message ? e.message : String(e) }, 400)
    }
  })
}

export function apply(ctx, config) {
  // —— 配置：cordis config 为 base 层，设置界面（dsh-wiki 命名空间）为用户层覆盖 ——
  const baseConfig = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  let configEpoch = 0 // bundle 变更代数：使会话级快照缓存失效

  /** 生效配置：cordis 配置（profile 的 cordis.patch.yml）→ 内置默认；运行参数不在这里改。 */
  function effectiveConfig() {
    const merged = { ...baseConfig }
    for (const k of ['sectionOrder', 'maxSectionChars', 'contextOrder', 'maxContextChars', 'maxGetChars', 'cacheTtlMs']) {
      if (!Number.isFinite(merged[k])) merged[k] = DEFAULTS[k]
    }
    merged.sectionName = String(merged.sectionName || DEFAULTS.sectionName)
    // 空字符串 = 清除该字段的用户覆盖，回落到部署配置（base）而不是内置默认
    merged.dataDir = String(merged.dataDir || baseConfig.dataDir || DEFAULTS.dataDir)
    return merged
  }

  /** 恒定层正文：按当前 maxSectionChars 截断（内容仍与会话/分支无关）。 */
  function sectionTextNow() {
    const max = effectiveConfig().maxSectionChars
    return SECTION_TEXT.length > max ? SECTION_TEXT.slice(0, max) + '\n…（描述层超限截断）' : SECTION_TEXT
  }

  // —— 会话级目录状态：按对话 agent 隔离；无 agent（重放等）走 plainActive ——
  const sessionActive = new WeakMap() // agent → {name, path}（wiki_use 会话级切换）
  const sessionContextCache = new WeakMap() // agent → {name, path, text, at, epoch}
  let plainActive = null // agent 缺失时的会话态兜底
  let plainContextCache = null
  let cachedGlobal = null // 全局默认（注册表 active 或 default）短缓存
  let cachedGlobalAt = 0

  /** 全局默认 bundle（注册表 active 或 default），TTL 内复用。 */
  async function globalActive() {
    const now = Date.now()
    const ttl = effectiveConfig().cacheTtlMs
    if (cachedGlobal && now - cachedGlobalAt < ttl) return cachedGlobal
    const c = await loadCore()
    cachedGlobal = await c.resolveBundleRoot(effectiveConfig(), {})
    cachedGlobalAt = now
    return cachedGlobal
  }

  /** 当前生效 bundle：会话级覆盖优先，否则全局默认。 */
  async function resolveActive(agent) {
    if (agent) {
      const hit = sessionActive.get(agent)
      if (hit) return hit
    } else if (plainActive) {
      return plainActive
    }
    return globalActive()
  }

  /** wiki_use 后清理该对话的会话态与注入缓存（下轮 assemble 重建）。 */
  function clearSession(agent) {
    if (agent) {
      sessionActive.delete(agent)
      sessionContextCache.delete(agent)
    } else {
      plainActive = null
      plainContextCache = null
    }
  }

  /**
   * 会话层正文：当前 bundle（名 + 路径）+ 目录名清单 + 各目录 APPEND_SYSTEM_PROMPT.md 规则。
   * 【不变量】只放「变化很慢」的事实：目录**计数**属高频 churn，绝不进快照（归 wiki_list）。
   */
  async function buildContext(active) {
    const c = await loadCore()
    const lines = [`当前知识库：${active.name || 'default'}（${active.path}）`]
    try {
      const tree = await c.listBundle(active.path)
      if (tree.length) lines.push(`可用目录：${tree.map((t) => t.dir || '(root)').join('、')}`)
    } catch {
      // 读盘失败不影响规则注入
    }
    // 目录自定注入：各目录 APPEND_SYSTEM_PROMPT.md 内容（根 + 全部子目录）
    // 通用插件本身不含任何场景写死的提示词；各分类自己决定注入什么规则
    try {
      const prompts = await c.collectInjectPrompts(active.path)
      if (prompts.length) {
        lines.push('', '【知识库自定义规则】以下内容来自各目录 APPEND_SYSTEM_PROMPT.md（用户为该分类定义的 system prompt 追加）：', '')
        for (const p of prompts) {
          lines.push(p.dir ? `### [${p.dir}]` : '### (bundle 根规则)', '', p.content, '')
        }
      }
    } catch {
      // 注入失败不影响描述层（静默降级）
    }
    let text = lines.join('\n')
    const maxContext = effectiveConfig().maxContextChars
    if (text.length > maxContext) text = text.slice(0, maxContext) + '\n…（会话上下文快照超限截断）'
    return text
  }

  async function getContextText(active, agent) {
    const now = Date.now()
    const cfg = effectiveConfig()
    const key = agent || null
    const hit = key ? sessionContextCache.get(key) : plainContextCache
    if (hit && hit.name === active.name && hit.path === active.path && hit.epoch === configEpoch && now - hit.at < cfg.cacheTtlMs) return hit.text
    const text = await buildContext(active)
    const entry = { name: active.name, path: active.path, text, at: now, epoch: configEpoch }
    if (key) sessionContextCache.set(key, entry)
    else plainContextCache = entry
    return text
  }

  // —— 描述层注入（同步注册监听器；异步读盘包 try/catch；绝不在回调后调 section）——
  ctx.on('system-prompt/assemble', async (assembly, assembleContext, next) => {
    try {
      const agent = (assembleContext && (assembleContext.agent || assembleContext.scope)) || null
      const cfg = effectiveConfig()
      // 恒定层：不读盘、无会话态 → 任何会话渲染结果逐字节相同，投影恒为 no-op
      if (assembly && Array.isArray(assembly.sections)) {
        const existing = assembly.sections.findIndex((s) => s && s.name === cfg.sectionName)
        const section = { name: cfg.sectionName, text: sectionTextNow(), order: cfg.sectionOrder }
        if (existing >= 0) assembly.sections[existing] = section
        else assembly.sections.push(section)
      }
      // 会话层：交给 runtime context 快照（会话尾部追加；内容未变则宿主不产生消息）
      const active = await resolveActive(agent)
      const text = await getContextText(active, agent)
      if (text && assembly && Array.isArray(assembly.contexts)) {
        const existing = assembly.contexts.findIndex((c) => c && c.name === CONTEXT_NAME)
        const context = { name: CONTEXT_NAME, order: cfg.contextOrder, text }
        if (existing >= 0) assembly.contexts[existing] = context
        else assembly.contexts.push(context)
      }
    } catch {
      // 静默降级（恒定层已在上方写入，不因会话态解析失败而丢失）
    }
    return next()
  })

  const out = textOutput()
  const needConfirmed = (reason) => ({
    text: `该写入需用户确认（AGENTS.md 门控规则：${reason || '内容需 human 确认'}）。请先向用户展示拟改动内容并获得明确同意，同意后以 confirmed: true 重新调用（写入将带 verified: {by: human:<user>}）。`,
  })

  /** 配置 / bundle 变更后让注入缓存与全局解析缓存失效（下轮 assemble 重建）。 */
  function invalidateCaches() {
    configEpoch++
    cachedGlobal = null
  }

  /**
   * 飞书在线库：写前闸门 + 写后上线（本地目录 bundle 自动 no-op）。
   * - 闸门：目标文件在远端也改过 → 拒绝写入并给出引导；
   * - 上线：写成功后把待推送文件推上去；失败只报告，不改变写入结果。
   */
  async function onlineGuard(core, dataDir, paths) {
    try {
      const g = await core.feishuWriteGuard(dataDir, { paths }, effectiveConfig())
      if (g && g.blocked) return g.text
    } catch {
      // 状态不可用时不阻断写入（稍后同步会报告冲突）
    }
    return null
  }
  async function onlineFlush(core, dataDir) {
    try {
      const r = await core.feishuFlush(dataDir, effectiveConfig())
      if (!r || (r.ok && r.nothingToPush)) return ''
      return r.ok
        ? `\n\n[在线库] 已同步上线：推送 ${(r.pushed || []).length} 个文件（新增 ${(r.created || []).length}）`
        : `\n\n[在线库] 尚未上线：${r.error}${r.next ? `（${r.next}）` : ''}`
    } catch (e) {
      return `\n\n[在线库] 尚未上线：${e && e.message ? e.message : String(e)}`
    }
  }

  // —— 设置命名空间（可选服务）：只作为「插件配置卡片」的可见性钥匙 ——
  // DSH 的插件配置 Tab 只渲染「宿主已服务命名空间 ∩ 已注册卡片」，卡片 key = 本命名空间。
  // 运行参数不在这里配置（schema 为空）：部署级参数改 profile 的 cordis.patch.yml。
  const schemaPromise = loadSchemastery()
  ctx.inject(['settings'], (settingsCtx) => {
    void (async () => {
      try {
        const z = await schemaPromise
        if (!z) return
        const svc = settingsCtx.get('settings')
        if (!svc || typeof svc.register !== 'function') return
        svc.register(SETTINGS_NS, z.object({}), { applies: 'live' })
      } catch {
        // 注册失败（无 schemastery / 命名空间冲突）不影响插件本体：工具与注入照常
      }
    })()
  })

  // —— 图形化配置 RPC（可选服务 webServer；非 web 部署不注册）——
  ctx.inject(['webServer'], (webCtx) => {
    registerWebRoutes(webCtx, { effectiveConfig, loadCore, invalidateCaches })
  })

  // —— wiki_list ——
  ctx.tools.register({
    name: 'wiki_list',
    description: [
      '列出 llm-wiki 知识库（OKF v0.2 bundle）的目录树与概念清单。',
      '【硬要求】做任何知识相关工作的第一步，必须先调用本工具看全貌，再决定下一步。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '按 type 过滤（如 Table / Attested Computation / Pitfall）' },
        status: { type: 'string', description: '按 status 过滤（draft/stable/deprecated）' },
      },
    },
    output: out,
    async execute(args, exec) {
      try {
        const c = await loadCore()
        const dataDir = (await resolveActive(exec && exec.agent)).path
        const tree = await c.listBundle(dataDir, { type: args.type, status: args.status })
        if (!tree.length) return { text: '（知识库为空或过滤后无概念）' }
        const lines = []
        for (const t of tree) {
          lines.push(`[${t.dir || '(root)'}]`)
          for (const item of t.concepts) {
            lines.push(`  ${item.type}: ${item.title}  (${item.id})${item.status === 'deprecated' ? ' [deprecated]' : ''}`)
          }
        }
        const total = tree.reduce((n, t) => n + t.concepts.length, 0)
        lines.push(`\n共 ${total} 个概念。`)
        return { text: lines.join('\n').slice(0, effectiveConfig().maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  })

  // —— wiki_search ——
  ctx.tools.register({
    name: 'wiki_search',
    description: [
      '搜索 llm-wiki 知识库：匹配 frontmatter（type/title/description/tags）+ 正文；支持词元拆分与量词后缀兜底；强匹配标 ★ 排前。',
      '支持 type 与 tag 过滤。未命中会提示用 wiki_list / wiki_lint。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（可空格分隔多词，任一词命中即命中）' },
        type: { type: 'string', description: '限定 type' },
        tag: { type: 'string', description: '限定标签（tags 精确包含）' },
        limit: { type: 'number', description: '最多返回条数（默认 20）' },
      },
      required: ['query'],
    },
    output: out,
    async execute(args, exec) {
      try {
        const q = String(args.query || '').trim()
        if (!q) return { text: 'query 不能为空' }
        const c = await loadCore()
        const dataDir = (await resolveActive(exec && exec.agent)).path
        const graph = await c.buildGraph(dataDir)
        const res = c.searchGraph(graph, q, { type: args.type, tag: args.tag, limit: Number(args.limit) || 20 })
        if (!res.length) return { text: '无匹配。若你正在用的表/知识确实不在库中：这是主动记录信号——探查其结构后用 wiki_create 建概念（Table 自动记录无需确认；新口径展示给用户确认后建 Metric/Attested Computation）。也可 wiki_list 看全貌或 wiki_lint 看缺失清单。' }
        const lines = res.map((r) => `${r.strong ? '★' : ''}${r.type}: ${r.title}  (${r.id})\n    ${r.description || ''}`)
        return { text: lines.join('\n').slice(0, effectiveConfig().maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  })

  // —— wiki_get ——
  ctx.tools.register({
    name: 'wiki_get',
    description: '读取单个概念完整正文（id 或 title）。自动附 backlinks：引用它的概念（坑点/口径等），无需额外字段。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Concept ID（如 tables/orders）或 title' } },
      required: ['id'],
    },
    output: out,
    async execute(args, exec) {
      try {
        const c = await loadCore()
        const dataDir = (await resolveActive(exec && exec.agent)).path
        const got = await c.getConcept(dataDir, args.id)
        if (!got) return { text: `未找到: ${args.id}。若这是你工作中遇到的真实表/概念，可用 wiki_create 主动补录（探查事实自动记录）。或 wiki_list 看全貌。` }
        if (got.ambiguous) return { text: `标题「${args.id}」有多个候选: ${got.candidates.join(', ')}。请用完整 id。` }
        const lines = [
          `# ${got.title}  (${got.id})`,
          `type: ${got.type}${got.meta.status ? ` | status: ${got.meta.status}` : ''}${got.meta.runtime ? ` | runtime: ${got.meta.runtime}` : ''}`,
          '',
          got.desc || '',
          '',
          `--- backlinks (${got.backlinks.length}) ---`,
          ...(got.backlinks.length ? got.backlinks.map((b) => `  ${b.type}: ${b.title}  (${b.id})`) : ['  （无入链）']),
          '',
          '--- body ---',
          got.body.trim(),
        ]
        return { text: lines.join('\n').slice(0, effectiveConfig().maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  })

  // —— wiki_create ——
  ctx.tools.register({
    name: 'wiki_create',
    description: [
      '新增概念到 llm-wiki 知识库（纯 OKF frontmatter：type 必填 + title/description/tags/…）。',
      '完整字段说明查 wiki help frontmatter：sources（来源，{id,resource,…}，正文用[^id]引用）/ stale_after（绝对过期时刻 ISO8601）/ status 按需手写；generated 与 verified 由 confirmed 自动维护，一般不用手写。',
      '写入门控：是否需要用户确认，完全由目标目录 AGENTS.md 的「## 门控」声明决定（该声明列出需 human 确认的 type；未声明则全部自动记录）。各分类可自行定义；confirmed: true 调用带 human verified。',
      '写入后自动维护 log.md 与 index.md。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Concept ID（bundle 相对路径，不含 .md，如 tables/orders 或 口径/销售额）' },
        type: { type: 'string', description: 'OKF type，必填（Table / Attested Computation / Pitfall / Reference / Metric / Playbook…）' },
        title: { type: 'string', description: '显示名，缺省用文件名' },
        description: { type: 'string', description: '一句话摘要' },
        body: { type: 'string', description: 'markdown 正文（# Schema / # Computation / # Gotchas…）' },
        tags: { type: 'string', description: '逗号分隔标签' },
        status: { type: 'string', description: 'draft/stable/deprecated' },
        confirmed: { type: 'boolean', description: 'true=用户已确认（写入带 human verified）' },
        user: { type: 'string', description: '确认人标识，形如 zhang3' },
      },
      required: ['path', 'type'],
    },
    output: out,
    async execute(args, exec) {
      try {
        const c = await loadCore()
        const dataDir = (await resolveActive(exec && exec.agent)).path
        const dir = dirname(args.path).replace(/\\/g, '/') === '.' ? '' : dirname(args.path).replace(/\\/g, '/')
        // 门控：完全由目标目录链 AGENTS.md 的「## 门控」声明决定（子目录覆盖父目录；
        // 链上无声明则默认全部自动记录——通用库不做任何 type 硬编码假设）
        const gate = await c.gateForType(dataDir, dir, args.type)
        if (gate.needConfirm && !args.confirmed) {
          return needConfirmed(gate.via ? `目录规则 ${gate.via} 要求 ${args.type} 类写入需 human 确认` : `${args.type} 类写入需 human 确认`)
        }
        const created = await c.createConcept(dataDir, {
          id: args.path,
          type: args.type,
          title: args.title,
          description: args.description,
          body: args.body,
          tags: args.tags ? args.tags.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          status: args.status,
          opts: {
            confirmed: args.confirmed === true,
            user: args.user || 'human:unknown',
            producer: 'dsh-wiki',
            version: PLUGIN_VERSION,
          },
        })
        return { text: `已创建 ${created.id}${await onlineFlush(c, dataDir)}` }
      } catch (e) { return strErr(e) }
    },
  })

  // —— wiki_update ——
  ctx.tools.register({
    name: 'wiki_update',
    description: '更新已有概念：只更新传入字段；trust 自动刷新；confirmed 追加 human verified。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Concept ID' },
        title: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' },
        type: { type: 'string' }, status: { type: 'string' }, tags: { type: 'string' },
        confirmed: { type: 'boolean', description: 'true=用户已确认' },
        user: { type: 'string' },
      },
      required: ['id'],
    },
    output: out,
    async execute(args, exec) {
      try {
        const c = await loadCore()
        const dataDir = (await resolveActive(exec && exec.agent)).path
        const patch = {
          title: args.title, description: args.description, body: args.body,
          type: args.type, status: args.status,
          tags: args.tags ? args.tags.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          opts: { confirmed: args.confirmed === true, user: args.user || 'human:unknown', producer: 'dsh-wiki', version: PLUGIN_VERSION },
        }
        const blocked = await onlineGuard(c, dataDir, [`${args.id}.md`])
        if (blocked) return { text: blocked }
        await c.updateConcept(dataDir, args.id, patch)
        return { text: `已更新 ${args.id}${await onlineFlush(c, dataDir)}` }
      } catch (e) { return strErr(e) }
    },
  })

  // —— wiki_validate ——
  ctx.tools.register({
    name: 'wiki_validate',
    description: '校验知识库是否 OKF v0.2 合规（每个非保留 .md 有 frontmatter + 非空 type；保留文件结构）。缺可选字段/断链不判失败。',
    parameters: { type: 'object', properties: {} },
    output: out,
    async execute(_args, exec) {
      try {
        const c = await loadCore()
        const dataDir = (await resolveActive(exec && exec.agent)).path
        const v = await c.validateBundle(dataDir)
        const lines = [v.ok ? 'OKF v0.2 合规 ✓' : '不合规：']
        for (const e of v.errors) lines.push('ERROR ' + e)
        for (const w of v.warnings) lines.push('warn ' + w)
        return { text: lines.join('\n') }
      } catch (e) { return strErr(e) }
    },
  })

  // —— wiki_lint ——
  ctx.tools.register({
    name: 'wiki_lint',
    description: '知识库体检：断链（提及但无目标，=未写入知识）、孤儿页、过期（stale_after）、缺 index、缺 description、重复标题。',
    parameters: { type: 'object', properties: {} },
    output: out,
    async execute(_args, exec) {
      try {
        const c = await loadCore()
        const dataDir = (await resolveActive(exec && exec.agent)).path
        const l = await c.lintBundle(dataDir)
        const lines = l.issues.length ? l.issues.map((i) => `${i.sev === 'warn' ? 'WARN' : 'info'} [${i.kind}] ${i.msg}`) : ['lint clean ✓']
        lines.push(`\nsummary: ${JSON.stringify(l.summary)}`)
        return { text: lines.join('\n').slice(0, effectiveConfig().maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  })

  // —— wiki_ingest ——
  ctx.tools.register({
    name: 'wiki_ingest',
    description: '登记外部源文件进知识库（copy 不改源，生成 type: Reference 来源概念页），供后续提炼写入。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '外部源文件绝对路径' },
        ref_dir: { type: 'string', description: '登记目录（缺省 references）' },
      },
      required: ['source'],
    },
    output: out,
    async execute(args, exec) {
      try {
        const c = await loadCore()
        const dataDir = (await resolveActive(exec && exec.agent)).path
        const r = await c.ingestSource(dataDir, { source: args.source, refDir: args.ref_dir }, { producer: 'dsh-wiki', version: PLUGIN_VERSION })
        return { text: `ingested → ${r.refPath}${r.existed ? ' (existed)' : ''}; 来源概念 ${r.sourceConceptId}${await onlineFlush(c, dataDir)}` }
      } catch (e) { return strErr(e) }
    },
  })

  // —— wiki_deprecate ——
  ctx.tools.register({
    name: 'wiki_deprecate',
    description: '目录级批量停用：把某目录（含子目录）下全部概念标 status: deprecated（数据零删除，可恢复）。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录（bundle 相对，如 tables；空=全库）' } },
    },
    output: out,
    async execute(args, exec) {
      try {
        const c = await loadCore()
        const dataDir = (await resolveActive(exec && exec.agent)).path
        const dir = String(args.path || '').replace(/^\/+|\/+$/g, '')
        const blocked = await onlineGuard(c, dataDir, [])
        if (blocked) return { text: blocked }
        const r = await c.deprecateDir(dataDir, dir)
        return { text: `已停用 ${r.deprecated}/${r.total} 个概念${await onlineFlush(c, dataDir)}` }
      } catch (e) { return strErr(e) }
    },
  })

  // —— wiki_rules ——
  ctx.tools.register({
    name: 'wiki_rules',
    description: '查看某目录生效的 AGENTS.md 规则（向上遍历取最近、子覆盖父），写入前先看它确认门控。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录（bundle 相对，空=根）' } },
    },
    output: out,
    async execute(args, exec) {
      try {
        const c = await loadCore()
        const dataDir = (await resolveActive(exec && exec.agent)).path
        const rules = await c.resolveRules(dataDir, String(args.path || ''))
        if (!rules.length) return { text: '（无 AGENTS.md 规则）' }
        return { text: rules.map((r) => `===== ${r.path} =====\n${r.content.trimEnd()}`).join('\n\n').slice(0, effectiveConfig().maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  })

  // —— wiki_dirs ——
  ctx.tools.register({
    name: 'wiki_dirs',
    description: [
      '查看全部 wiki 目录分支（命名 bundle）与当前激活项。',
      'bundle 来源：注册表 ~/.agents/wiki-registry.json ∪ 插件配置 dataDirs（同名配置优先）；隐式 default = dataDir 兜底。',
      '注册新目录：设置 → 插件 → 插件配置 → llm-wiki 卡片（或直接编辑注册表 / 插件配置 dataDirs）；切换用 wiki_use。详见 wiki_help bundle。',
    ].join('\n'),
    parameters: { type: 'object', properties: {} },
    output: out,
    async execute(_args, exec) {
      try {
        const c = await loadCore()
        const agent = exec && exec.agent
        const rows = await c.listBundles(effectiveConfig())
        const session = agent ? sessionActive.get(agent) : plainActive
        const active = session || (await globalActive())
        const lines = rows.map((r) => {
          const markers = []
          if (r.active) markers.push('全局默认')
          if (session && session.name === r.name) markers.push('当前会话')
          const m = markers.length ? `  ← ${markers.join(' / ')}` : ''
          return `${r.kind === 'feishu' ? '飞书 ' : ''}[${r.name}] ${r.path}${m}`
        })
        lines.push('', `当前生效目录：${active.path}`)
        lines.push('', '切换：wiki_use <name> [global:true]；注册新目录：~/.agents/wiki-registry.json 或插件配置 dataDirs（详见 wiki_help bundle）。')
        return { text: lines.join('\n').slice(0, effectiveConfig().maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  })

  // —— wiki_use ——
  ctx.tools.register({
    name: 'wiki_use',
    description: [
      '切换当前 wiki 目录分支。name = bundle 名（wiki_dirs 查看）或 default。',
      '默认会话级：仅当前对话生效（DSH 按对话隔离，不影响其他会话）。',
      'global: true 同时持久化为全局默认（写注册表 active，影响新会话与 CLI/pi）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'bundle 名（wiki_dirs 查看）或 default' },
        global: { type: 'boolean', description: 'true=同时持久化为全局默认（写 ~/.agents/wiki-registry.json 的 active）' },
      },
      required: ['name'],
    },
    output: out,
    async execute(args, exec) {
      try {
        const c = await loadCore()
        const agent = exec && exec.agent
        const resolved = await c.resolveBundleRoot(effectiveConfig(), { name: String(args.name) })
        if (args.global === true) {
          await c.writeRegistryActive(resolved.name)
          cachedGlobal = null // 全局缓存失效：其他会话下次解析读到新默认
        }
        if (agent) {
          sessionActive.set(agent, resolved)
          sessionContextCache.delete(agent)
        } else {
          plainActive = resolved
          plainContextCache = null
        }
        const lines = [`已切换到 ${resolved.name} → ${resolved.path}`]
        lines.push(args.global === true ? '（已持久化为全局默认，新会话与 CLI/pi 生效）' : '（会话级，仅当前对话生效）')
        return { text: lines.join('\n') }
      } catch (e) { return strErr(e) }
    },
  })

  // —— wiki_help ——
  ctx.tools.register({
    name: 'wiki_help',
    description: '查 llm-wiki 机制文档：保留文件一览 / 怎么写目录 AGENTS.md / 怎么写 APPEND_SYSTEM_PROMPT.md（分类行为注入）/ OKF frontmatter 速查 / 门控判定逻辑 / 在线同步（Git 远端）。想给某分类加行为规则或门控时先查它。',
    parameters: {
      type: 'object',
      properties: { topic: { type: 'string', description: '主题：quickstart | files | agents | append | frontmatter | gate | bundle | sync（缺省 quickstart）' } },
    },
    output: out,
    async execute(args, exec) {
      try {
        const c = await loadCore()
        const dataDir = (await resolveActive(exec && exec.agent)).path
        return { text: c.getHelp(args.topic).slice(0, effectiveConfig().maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  })

  // —— wiki_sync ——（按 bundle 后端分派：本地目录→Git；飞书云盘库→lark-cli）
  ctx.tools.register({
    name: 'wiki_sync',
    description: [
      '在线知识库同步（多台机器/多人/多个 agent 读写同一份 bundle），按当前 bundle 的后端自动分派：',
      '· 本地目录 bundle → Git 远端：status 看远端/分支/ahead-behind/脏文件/冲突；sync 提交+拉取合并+推送；init 挂远端并首推；clone 克隆远端。',
      '· 飞书 bundle（云盘文件夹存原生 .md）→ lark-cli：status 看待推送/待拉取/两侧都改/远端已删；sync 推本地改动+拉远端改动；pull/push 单向；init 新建或挂载云盘文件夹并注册命名 bundle。',
      '冲突策略（两种后端一致）：index.md 本地重生成、log.md 取并集 → 永不阻塞；概念/AGENTS.md 两侧都改会停止同步并报清单，绝不 force/覆盖；飞书后端永不删除两端文件（删除只报告）。',
      '凭证与认证：git 交给 git；飞书交给 lark-cli（user 身份）。详见 wiki_help sync / wiki_help feishu。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'status=只读 | sync=双向同步 | pull=只拉 | push=只推 | init=初始化（git 远端或飞书文件夹） | clone=克隆 git 远端', enum: ['status', 'sync', 'pull', 'push', 'init', 'clone'] },
        message: { type: 'string', description: 'git sync 时的提交信息（缺省自动生成）' },
        bundle: { type: 'string', description: '目标命名 bundle（缺省=当前生效目录）' },
        remote: { type: 'string', description: 'init（git）：远端 URL' },
        folder_token: { type: 'string', description: 'init（飞书）：云盘文件夹 URL 或 token' },
        new_folder: { type: 'string', description: 'init（飞书）：在我的空间新建同名文件夹（与 folder_token 二选一）' },
        cache_dir: { type: 'string', description: 'init（飞书）：本地缓存目录（缺省 ~/.agents/wiki-cloud/<名字>）' },
        adopt: { type: 'string', description: '飞书首次同步的裁决：local=以本地为准推送，remote=以远端为准拉取（缺省 local）', enum: ['local', 'remote'] },
        url: { type: 'string', description: 'clone：远端 URL' },
        dir: { type: 'string', description: 'clone：本地目标目录（须不存在或为空）' },
        name: { type: 'string', description: 'init/clone：同时注册为命名 bundle（三形态共享注册表）' },
        use: { type: 'boolean', description: 'init/clone：注册后设为全局默认分支' },
        branch: { type: 'string', description: 'init（git）：初始分支名（缺省 main）' },
      },
      required: ['action'],
    },
    output: out,
    async execute(args, exec) {
      try {
        const c = await loadCore()
        const action = String(args.action || '')
        const agent = exec && exec.agent

        if (action === 'clone') {
          if (!args.url || !args.dir) return { text: 'clone 需要 url 与 dir 参数。' }
          const r = await c.gitClone(String(args.url), String(args.dir), { name: args.name, use: args.use === true })
          if (r.ok) { invalidateCaches(); clearSession(agent) }
          return { text: formatGitResult(action, r) }
        }

        // 飞书初始化：新建/挂载云盘文件夹（与 git init 并列的入口）
        if (action === 'init' && (args.folder_token || args.new_folder)) {
          const r = await c.feishuInit({ name: args.name, folderToken: args.folder_token, newFolder: args.new_folder, cacheDir: args.cache_dir, use: args.use === true })
          invalidateCaches()
          return { text: formatFeishuResult('init', r) }
        }

        const active = args.bundle
          ? await c.resolveBundleRoot(effectiveConfig(), { name: String(args.bundle) })
          : await resolveActive(agent)
        const isFeishu = active.kind === 'feishu'

        if (action === 'status') {
          return { text: isFeishu ? formatFeishuResult('status', await c.feishuStatus(active)) : formatGitResult('status', await c.gitStatus(active.path)) }
        }
        if (isFeishu) {
          if (action === 'pull') {
            const before = await c.feishuStatus(active)
            if (!before.ok) return { text: formatFeishuResult('pull', before) }
            const r = await c.feishuPull(active, { paths: before.pull.map((x) => x.rel) })
            invalidateCaches()
            return { text: formatFeishuResult('pull', { ...r, bundle: active, files: before.pull.length }) }
          }
          if (action === 'push') {
            const before = await c.feishuStatus(active)
            if (!before.ok) return { text: formatFeishuResult('push', before) }
            if (before.conflict.length) {
              return { text: formatFeishuResult('push', { ok: false, step: 'conflict', conflicts: before.conflict.map((x) => x.rel), error: `${before.conflict.length} 个文件两侧都改过`, next: '请先人工处理冲突（飞书或本地任选一侧）再重跑。' }) }
            }
            const r = await c.feishuPush(active, { paths: before.push.map((x) => x.rel) })
            invalidateCaches()
            return { text: formatFeishuResult('push', { ...r, bundle: active }) }
          }
          if (action === 'sync') {
            const r = await c.feishuSync(active, { adopt: args.adopt, message: args.message })
            invalidateCaches()
            if (r.ok) clearSession(agent)
            return { text: formatFeishuResult('sync', { ...r, bundle: active }) }
          }
          return { text: `飞书后端不支持 action「${args.action}」：可用 status | sync | pull | push | init。` }
        }

        if (action === 'sync' || action === 'push' || action === 'pull') {
          const r = await c.gitSync(active.path, { message: args.message, push: action !== 'pull' })
          invalidateCaches()
          if (r.ok) clearSession(agent)
          return { text: formatGitResult(action, { ...r, bundle: active }) }
        }
        if (action === 'init') {
          const r = await c.gitInit(active.path, { remote: args.remote, branch: args.branch, name: args.name, use: args.use === true })
          invalidateCaches()
          return { text: formatGitResult('init', { ...r, bundle: active }) }
        }
        return { text: `未知 action「${args.action}」：可用 status | sync | pull | push | init | clone。` }
      } catch (e) { return strErr(e) }
    },
  })
}
