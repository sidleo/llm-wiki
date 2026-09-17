/**
 * tools.mjs —— MCP 形态的 14 个 wiki_* 工具（与 dsh 插件同名同参同输出）。
 *
 * 与 packages/dsh/wiki.mjs 的关系：**同一批 core 函数、同一份参数 schema、同一套输出文本**；
 * 唯一的结构差异是会话态——MCP 没有 per-agent 身份，`wiki_use` 的「会话级切换」落成
 * **进程级 override**（一个 stdio server 进程 ≈ 一个宿主会话）；global:true 仍写共享注册表。
 *
 * 工具描述里凡涉及 DSH 特有的东西（图形化配置卡片、按对话隔离）都按本形态改写，
 * 其余逐字照搬——test/parity.test.mjs 会盯住这件事。
 */

import { dirname } from 'node:path'
import { DEFAULTS, MCP_VERSION, PRODUCER } from './config.mjs'
import { buildContextText } from './instructions.mjs'
import { formatFeishuResult, formatGitResult } from './format.mjs'

function strErr(e) {
  return { text: `错误：${e && e.message ? e.message : String(e)}` }
}

/**
 * 构造工具表。
 * @param {{core:object, config?:object, version?:string, producer?:string}} deps
 * @returns {{tools:Map<string,{name:string,description:string,parameters:object,run:(args?:object)=>Promise<{text:string}>}>, state:object}}
 */
export function createWiki({ core, config = {}, version = MCP_VERSION, producer = PRODUCER }) {
  const limits = {
    maxGetChars: DEFAULTS.maxGetChars,
    maxContextChars: DEFAULTS.maxContextChars,
    cacheTtlMs: DEFAULTS.cacheTtlMs,
  }

  // —— 进程态目录状态（wiki_use 非 global 时生效；global 持久化写注册表）——
  let override = null
  let cachedGlobal = null // 全局默认（注册表 active 或 default）短缓存
  let cachedGlobalAt = 0

  async function globalActive() {
    const now = Date.now()
    if (cachedGlobal && now - cachedGlobalAt < limits.cacheTtlMs) return cachedGlobal
    cachedGlobal = await core.resolveBundleRoot(config, {})
    cachedGlobalAt = now
    return cachedGlobal
  }

  /** 当前生效 bundle：进程级 override 优先，否则全局默认。 */
  async function resolveActive() {
    return override || (await globalActive())
  }

  /** 配置 / bundle 变更后让全局解析缓存失效。 */
  function invalidateCaches() {
    cachedGlobal = null
  }

  /** wiki_use 之外的重置（sync/clone/init 成功后回到注册表解析）。 */
  function clearOverride() {
    override = null
  }

  const needConfirmed = (reason) => ({
    text: `该写入需用户确认（AGENTS.md 门控规则：${reason || '内容需 human 确认'}）。请先向用户展示拟改动内容并获得明确同意，同意后以 confirmed: true 重新调用（写入将带 verified: {by: human:<user>}）。`,
  })

  /** 飞书在线库：写前闸门 + 写后上线（本地目录 bundle 自动 no-op）。 */
  async function onlineGuard(dataDir, paths) {
    try {
      const g = await core.feishuWriteGuard(dataDir, { paths }, config)
      if (g && g.blocked) return g.text
    } catch {
      // 状态不可用时不阻断写入（稍后同步会报告冲突）
    }
    return null
  }
  async function onlineFlush(dataDir) {
    try {
      const r = await core.feishuFlush(dataDir, config)
      if (!r || (r.ok && r.nothingToPush)) return ''
      return r.ok
        ? `\n\n[在线库] 已同步上线：推送 ${(r.pushed || []).length} 个文件（新增 ${(r.created || []).length}）`
        : `\n\n[在线库] 尚未上线：${r.error}${r.next ? `（${r.next}）` : ''}`
    } catch (e) {
      return `\n\n[在线库] 尚未上线：${e && e.message ? e.message : String(e)}`
    }
  }

  const tools = new Map()
  const add = (name, description, parameters, run) =>
    tools.set(name, { name, description: Array.isArray(description) ? description.join('\n') : description, parameters, run })

  // ──────────────────────────── wiki_list ────────────────────────────
  add(
    'wiki_list',
    [
      '列出 llm-wiki 知识库（OKF v0.2 bundle）的目录树与概念清单。',
      '【硬要求】做任何知识相关工作的第一步，必须先调用本工具看全貌，再决定下一步。',
    ],
    {
      type: 'object',
      properties: {
        type: { type: 'string', description: '按 type 过滤（如 Table / Attested Computation / Pitfall）' },
        status: { type: 'string', description: '按 status 过滤（draft/stable/deprecated）' },
      },
    },
    async (args = {}) => {
      try {
        const dataDir = (await resolveActive()).path
        const tree = await core.listBundle(dataDir, { type: args.type, status: args.status })
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
        return { text: lines.join('\n').slice(0, limits.maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  )

  // ──────────────────────────── wiki_search ────────────────────────────
  add(
    'wiki_search',
    [
      '搜索 llm-wiki 知识库：匹配 frontmatter（type/title/description/tags）+ 正文；支持词元拆分与量词后缀兜底；强匹配标 ★ 排前。',
      '支持 type 与 tag 过滤。未命中会提示用 wiki_list / wiki_lint。',
    ],
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（可空格分隔多词，任一词命中即命中）' },
        type: { type: 'string', description: '限定 type' },
        tag: { type: 'string', description: '限定标签（tags 精确包含）' },
        limit: { type: 'number', description: '最多返回条数（默认 20）' },
      },
      required: ['query'],
    },
    async (args = {}) => {
      try {
        const q = String(args.query || '').trim()
        if (!q) return { text: 'query 不能为空' }
        const dataDir = (await resolveActive()).path
        const graph = await core.buildGraph(dataDir)
        const res = core.searchGraph(graph, q, { type: args.type, tag: args.tag, limit: Number(args.limit) || 20 })
        if (!res.length) return { text: '无匹配。若你正在用的表/知识确实不在库中：这是主动记录信号——探查其结构后用 wiki_create 建概念（Table 自动记录无需确认；新口径展示给用户确认后建 Metric/Attested Computation）。也可 wiki_list 看全貌或 wiki_lint 看缺失清单。' }
        const lines = res.map((r) => `${r.strong ? '★' : ''}${r.type}: ${r.title}  (${r.id})\n    ${r.description || ''}`)
        return { text: lines.join('\n').slice(0, limits.maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  )

  // ──────────────────────────── wiki_get ────────────────────────────
  add(
    'wiki_get',
    '读取单个概念完整正文（id 或 title）。自动附 backlinks：引用它的概念（坑点/口径等），无需额外字段。',
    {
      type: 'object',
      properties: { id: { type: 'string', description: 'Concept ID（如 tables/orders）或 title' } },
      required: ['id'],
    },
    async (args = {}) => {
      try {
        const dataDir = (await resolveActive()).path
        const got = await core.getConcept(dataDir, args.id)
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
        return { text: lines.join('\n').slice(0, limits.maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  )

  // ──────────────────────────── wiki_create ────────────────────────────
  add(
    'wiki_create',
    [
      '新增概念到 llm-wiki 知识库（纯 OKF frontmatter：type 必填 + title/description/tags/…）。',
      '完整字段说明查 wiki help frontmatter：sources（来源，{id,resource,…}，正文用[^id]引用）/ stale_after（绝对过期时刻 ISO8601）/ status 按需手写；generated 与 verified 由 confirmed 自动维护，一般不用手写。',
      '写入门控：是否需要用户确认，完全由目标目录 AGENTS.md 的「## 门控」声明决定（该声明列出需 human 确认的 type；未声明则全部自动记录）。各分类可自行定义；confirmed: true 调用带 human verified。',
      '写入后自动维护 log.md 与 index.md。',
    ],
    {
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
    async (args = {}) => {
      try {
        const dataDir = (await resolveActive()).path
        const dir = dirname(args.path).replace(/\\/g, '/') === '.' ? '' : dirname(args.path).replace(/\\/g, '/')
        // 门控：完全由目标目录链 AGENTS.md 的「## 门控」声明决定（子目录覆盖父目录；
        // 链上无声明则默认全部自动记录——通用库不做任何 type 硬编码假设）
        const gate = await core.gateForType(dataDir, dir, args.type)
        if (gate.needConfirm && !args.confirmed) {
          return needConfirmed(gate.via ? `目录规则 ${gate.via} 要求 ${args.type} 类写入需 human 确认` : `${args.type} 类写入需 human 确认`)
        }
        const created = await core.createConcept(dataDir, {
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
            producer,
            version,
          },
        })
        return { text: `已创建 ${created.id}${await onlineFlush(dataDir)}` }
      } catch (e) { return strErr(e) }
    },
  )

  // ──────────────────────────── wiki_update ────────────────────────────
  add(
    'wiki_update',
    '更新已有概念：只更新传入字段；trust 自动刷新；confirmed 追加 human verified。',
    {
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
    async (args = {}) => {
      try {
        const dataDir = (await resolveActive()).path
        const patch = {
          title: args.title, description: args.description, body: args.body,
          type: args.type, status: args.status,
          tags: args.tags ? args.tags.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          opts: { confirmed: args.confirmed === true, user: args.user || 'human:unknown', producer, version },
        }
        const blocked = await onlineGuard(dataDir, [`${args.id}.md`])
        if (blocked) return { text: blocked }
        await core.updateConcept(dataDir, args.id, patch)
        return { text: `已更新 ${args.id}${await onlineFlush(dataDir)}` }
      } catch (e) { return strErr(e) }
    },
  )

  // ──────────────────────────── wiki_validate ────────────────────────────
  add(
    'wiki_validate',
    '校验知识库是否 OKF v0.2 合规（每个非保留 .md 有 frontmatter + 非空 type；保留文件结构）。缺可选字段/断链不判失败。',
    { type: 'object', properties: {} },
    async () => {
      try {
        const dataDir = (await resolveActive()).path
        const v = await core.validateBundle(dataDir)
        const lines = [v.ok ? 'OKF v0.2 合规 ✓' : '不合规：']
        for (const e of v.errors) lines.push('ERROR ' + e)
        for (const w of v.warnings) lines.push('warn ' + w)
        return { text: lines.join('\n') }
      } catch (e) { return strErr(e) }
    },
  )

  // ──────────────────────────── wiki_lint ────────────────────────────
  add(
    'wiki_lint',
    '知识库体检：断链（提及但无目标，=未写入知识）、孤儿页、过期（stale_after）、缺 index、缺 description、重复标题。',
    { type: 'object', properties: {} },
    async () => {
      try {
        const dataDir = (await resolveActive()).path
        const l = await core.lintBundle(dataDir)
        const lines = l.issues.length ? l.issues.map((i) => `${i.sev === 'warn' ? 'WARN' : 'info'} [${i.kind}] ${i.msg}`) : ['lint clean ✓']
        lines.push(`\nsummary: ${JSON.stringify(l.summary)}`)
        return { text: lines.join('\n').slice(0, limits.maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  )

  // ──────────────────────────── wiki_ingest ────────────────────────────
  add(
    'wiki_ingest',
    '登记外部源文件进知识库（copy 不改源，生成 type: Reference 来源概念页），供后续提炼写入。',
    {
      type: 'object',
      properties: {
        source: { type: 'string', description: '外部源文件绝对路径' },
        ref_dir: { type: 'string', description: '登记目录（缺省 references）' },
      },
      required: ['source'],
    },
    async (args = {}) => {
      try {
        const dataDir = (await resolveActive()).path
        const r = await core.ingestSource(dataDir, { source: args.source, refDir: args.ref_dir }, { producer, version })
        return { text: `ingested → ${r.refPath}${r.existed ? ' (existed)' : ''}; 来源概念 ${r.sourceConceptId}${await onlineFlush(dataDir)}` }
      } catch (e) { return strErr(e) }
    },
  )

  // ──────────────────────────── wiki_deprecate ────────────────────────────
  add(
    'wiki_deprecate',
    '目录级批量停用：把某目录（含子目录）下全部概念标 status: deprecated（数据零删除，可恢复）。',
    {
      type: 'object',
      properties: { path: { type: 'string', description: '目录（bundle 相对，如 tables；空=全库）' } },
    },
    async (args = {}) => {
      try {
        const dataDir = (await resolveActive()).path
        const dir = String(args.path || '').replace(/^\/+|\/+$/g, '')
        const blocked = await onlineGuard(dataDir, [])
        if (blocked) return { text: blocked }
        const r = await core.deprecateDir(dataDir, dir)
        return { text: `已停用 ${r.deprecated}/${r.total} 个概念${await onlineFlush(dataDir)}` }
      } catch (e) { return strErr(e) }
    },
  )

  // ──────────────────────────── wiki_rules ────────────────────────────
  add(
    'wiki_rules',
    '查看某目录生效的规则：APPEND_SYSTEM_PROMPT.md（行为规则，= 连接时经 instructions 下发的内容）+ AGENTS.md（门控/写入规则，向上遍历取最近、子覆盖父）。不带 path 时返回本 bundle 全部 APPEND + 根 AGENTS.md。写入前先看它确认门控。',
    {
      type: 'object',
      properties: { path: { type: 'string', description: '目录（bundle 相对，空=根；不传则返回全部 APPEND）' } },
    },
    async (args = {}) => {
      try {
        const dataDir = (await resolveActive()).path
        const dir = String(args.path || '')
        const text = dir
          ? core.formatRuleContext(await core.ruleContextFor(dataDir, dir))
          : core.formatRuleContext(
              { dir: '', appends: await core.collectInjectPrompts(dataDir), rules: await core.resolveRules(dataDir, '') },
              { title: '【本 bundle 全部规则】（APPEND 为行为规则，= 连接时经 instructions 下发的全文）' },
            )
        return { text: (text || (dir ? `（${dir} 无生效规则）` : '（无规则：既无 APPEND_SYSTEM_PROMPT.md 也无 AGENTS.md）')).slice(0, limits.maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  )

  // ──────────────────────────── wiki_dirs ────────────────────────────
  add(
    'wiki_dirs',
    [
      '查看全部 wiki 目录分支（命名 bundle）与当前激活项。',
      'bundle 来源：注册表 ~/.agents/wiki-registry.json ∪ 启动参数 --bundles 名=路径（同名参数优先）；隐式 default = dataDir 兜底。',
      '注册新目录：编辑注册表，或用启动参数 --bundles 名=路径；切换用 wiki_use。详见 wiki_help bundle。',
    ],
    { type: 'object', properties: {} },
    async () => {
      try {
        const rows = await core.listBundles(config)
        const active = override || (await globalActive())
        const lines = rows.map((r) => {
          const markers = []
          if (r.active) markers.push('全局默认')
          if (override && override.name === r.name) markers.push('当前进程')
          const m = markers.length ? `  ← ${markers.join(' / ')}` : ''
          return `${r.kind === 'feishu' ? '飞书 ' : ''}[${r.name}] ${r.path}${m}`
        })
        lines.push('', `当前生效目录：${active.path}`)
        lines.push('', '切换：wiki_use <name> [global:true]；注册新目录：~/.agents/wiki-registry.json 或启动参数 --bundles（详见 wiki_help bundle）。')
        return { text: lines.join('\n').slice(0, limits.maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  )

  // ──────────────────────────── wiki_use ────────────────────────────
  add(
    'wiki_use',
    [
      '切换当前 wiki 目录分支。name = bundle 名（wiki_dirs 查看）或 default。',
      '默认进程级：仅当前 MCP server 进程生效（一个进程 = 一个宿主会话；不写盘、不影响其他客户端）。',
      'global: true 同时持久化为全局默认（写注册表 active，影响其他形态与 CLI/pi）。',
    ],
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'bundle 名（wiki_dirs 查看）或 default' },
        global: { type: 'boolean', description: 'true=同时持久化为全局默认（写 ~/.agents/wiki-registry.json 的 active）' },
      },
      required: ['name'],
    },
    async (args = {}) => {
      try {
        const resolved = await core.resolveBundleRoot(config, { name: String(args.name) })
        if (args.global === true) {
          await core.writeRegistryActive(resolved.name)
          invalidateCaches() // 全局缓存失效：其他形态下次解析读到新默认
        }
        override = resolved
        const lines = [`已切换到 ${resolved.name} → ${resolved.path}`]
        lines.push(args.global === true ? '（已持久化为全局默认，新会话与 CLI/pi 生效）' : '（进程级，仅当前 MCP server 生效）')
        // instructions 只在连接时下发一次，不会因切库更新：把新库的规则随本次结果送达
        try {
          lines.push('', await buildContextText({ core, active: resolved, maxChars: limits.maxContextChars }))
        } catch {
          // 规则读取失败不影响切换本身
        }
        return { text: lines.join('\n') }
      } catch (e) { return strErr(e) }
    },
  )

  // ──────────────────────────── wiki_help ────────────────────────────
  add(
    'wiki_help',
    '查 llm-wiki 机制文档：保留文件一览 / 怎么写目录 AGENTS.md / 怎么写 APPEND_SYSTEM_PROMPT.md（分类行为注入）/ OKF frontmatter 速查 / 门控判定逻辑 / 在线同步（Git 远端）。想给某分类加行为规则或门控时先查它。',
    {
      type: 'object',
      properties: { topic: { type: 'string', description: '主题：quickstart | files | agents | append | frontmatter | gate | bundle | sync（缺省 quickstart）' } },
    },
    async (args = {}) => {
      try {
        return { text: core.getHelp(args.topic).slice(0, limits.maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  )

  // ──────────────────────────── wiki_sync ────────────────────────────
  add(
    'wiki_sync',
    [
      '在线知识库同步（多台机器/多人/多个 agent 读写同一份 bundle），按当前 bundle 的后端自动分派：',
      '· 本地目录 bundle → Git 远端：status 看远端/分支/ahead-behind/脏文件/冲突；sync 提交+拉取合并+推送；init 挂远端并首推；clone 克隆远端。',
      '· 飞书 bundle（云盘文件夹存原生 .md）→ lark-cli：status 看待推送/待拉取/两侧都改/远端已删；sync 推本地改动+拉远端改动；pull/push 单向；init 新建或挂载云盘文件夹并注册命名 bundle。',
      '冲突策略（两种后端一致）：index.md 本地重生成、log.md 取并集 → 永不阻塞；概念/AGENTS.md 两侧都改会停止同步并报清单，绝不 force/覆盖；飞书后端永不删除两端文件（删除只报告）。',
      '凭证与认证：git 交给 git；飞书交给 lark-cli（user 身份）。详见 wiki_help sync / wiki_help feishu。',
    ],
    {
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
        name: { type: 'string', description: 'init/clone：同时注册为命名 bundle（各形态共享注册表）' },
        use: { type: 'boolean', description: 'init/clone：注册后设为全局默认分支' },
        branch: { type: 'string', description: 'init（git）：初始分支名（缺省 main）' },
      },
      required: ['action'],
    },
    async (args = {}) => {
      try {
        const action = String(args.action || '')

        if (action === 'clone') {
          if (!args.url || !args.dir) return { text: 'clone 需要 url 与 dir 参数。' }
          const r = await core.gitClone(String(args.url), String(args.dir), { name: args.name, use: args.use === true })
          if (r.ok) { invalidateCaches(); clearOverride() }
          return { text: formatGitResult(action, r) }
        }

        // 飞书初始化：新建/挂载云盘文件夹（与 git init 并列的入口）
        if (action === 'init' && (args.folder_token || args.new_folder)) {
          const r = await core.feishuInit({ name: args.name, folderToken: args.folder_token, newFolder: args.new_folder, cacheDir: args.cache_dir, use: args.use === true })
          invalidateCaches()
          return { text: formatFeishuResult('init', r) }
        }

        const active = args.bundle
          ? await core.resolveBundleRoot(config, { name: String(args.bundle) })
          : await resolveActive()
        const isFeishu = active.kind === 'feishu'

        if (action === 'status') {
          return { text: isFeishu ? formatFeishuResult('status', await core.feishuStatus(active)) : formatGitResult('status', await core.gitStatus(active.path)) }
        }
        if (isFeishu) {
          if (action === 'pull') {
            const before = await core.feishuStatus(active)
            if (!before.ok) return { text: formatFeishuResult('pull', before) }
            const r = await core.feishuPull(active, { paths: before.pull.map((x) => x.rel) })
            invalidateCaches()
            return { text: formatFeishuResult('pull', { ...r, bundle: active, files: before.pull.length }) }
          }
          if (action === 'push') {
            const before = await core.feishuStatus(active)
            if (!before.ok) return { text: formatFeishuResult('push', before) }
            if (before.conflict.length) {
              return { text: formatFeishuResult('push', { ok: false, step: 'conflict', conflicts: before.conflict.map((x) => x.rel), error: `${before.conflict.length} 个文件两侧都改过`, next: '请先人工处理冲突（飞书或本地任选一侧）再重跑。' }) }
            }
            const r = await core.feishuPush(active, { paths: before.push.map((x) => x.rel) })
            invalidateCaches()
            return { text: formatFeishuResult('push', { ...r, bundle: active }) }
          }
          if (action === 'sync') {
            const r = await core.feishuSync(active, { adopt: args.adopt, message: args.message })
            invalidateCaches()
            if (r.ok) clearOverride()
            return { text: formatFeishuResult('sync', { ...r, bundle: active }) }
          }
          return { text: `飞书后端不支持 action「${args.action}」：可用 status | sync | pull | push | init。` }
        }

        if (action === 'sync' || action === 'push' || action === 'pull') {
          const r = await core.gitSync(active.path, { message: args.message, push: action !== 'pull' })
          invalidateCaches()
          if (r.ok) clearOverride()
          return { text: formatGitResult(action, { ...r, bundle: active }) }
        }
        if (action === 'init') {
          const r = await core.gitInit(active.path, { remote: args.remote, branch: args.branch, name: args.name, use: args.use === true })
          invalidateCaches()
          return { text: formatGitResult('init', { ...r, bundle: active }) }
        }
        return { text: `未知 action「${args.action}」：可用 status | sync | pull | push | init | clone。` }
      } catch (e) { return strErr(e) }
    },
  )

  return {
    tools,
    state: {
      resolveActive,
      globalActive,
      invalidateCaches,
      clearOverride,
      getOverride: () => override,
      limits,
    },
  }
}
