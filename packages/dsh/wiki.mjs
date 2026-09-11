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
 */

import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'wiki-registry'
export const inject = ['systemPrompt', 'tools']

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

export function apply(ctx, config) {
  const sectionName = String(config?.sectionName || DEFAULTS.sectionName)
  const sectionOrder = Number.isFinite(config?.sectionOrder) ? config.sectionOrder : DEFAULTS.sectionOrder
  const maxSectionChars = Number.isFinite(config?.maxSectionChars) ? config.maxSectionChars : DEFAULTS.maxSectionChars
  const contextOrder = Number.isFinite(config?.contextOrder) ? config.contextOrder : DEFAULTS.contextOrder
  const maxContextChars = Number.isFinite(config?.maxContextChars) ? config.maxContextChars : DEFAULTS.maxContextChars
  const maxGetChars = Number.isFinite(config?.maxGetChars) ? config.maxGetChars : DEFAULTS.maxGetChars
  const cacheTtlMs = Number.isFinite(config?.cacheTtlMs) ? config.cacheTtlMs : DEFAULTS.cacheTtlMs
  const sectionText = SECTION_TEXT.length > maxSectionChars
    ? SECTION_TEXT.slice(0, maxSectionChars) + '\n…（描述层超限截断）'
    : SECTION_TEXT

  // —— 会话级目录状态：按对话 agent 隔离；无 agent（重放等）走 plainActive ——
  const sessionActive = new WeakMap() // agent → {name, path}（wiki_use 会话级切换）
  const sessionContextCache = new WeakMap() // agent → {name, path, text, at}
  let plainActive = null // agent 缺失时的会话态兜底
  let plainContextCache = null
  let cachedGlobal = null // 全局默认（注册表 active 或 default）短缓存
  let cachedGlobalAt = 0

  /** 全局默认 bundle（注册表 active 或 default），TTL 内复用。 */
  async function globalActive() {
    const now = Date.now()
    if (cachedGlobal && now - cachedGlobalAt < cacheTtlMs) return cachedGlobal
    const c = await loadCore()
    cachedGlobal = await c.resolveBundleRoot(config, {})
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
    if (text.length > maxContextChars) text = text.slice(0, maxContextChars) + '\n…（会话上下文快照超限截断）'
    return text
  }

  async function getContextText(active, agent) {
    const now = Date.now()
    const key = agent || null
    const hit = key ? sessionContextCache.get(key) : plainContextCache
    if (hit && hit.name === active.name && hit.path === active.path && now - hit.at < cacheTtlMs) return hit.text
    const text = await buildContext(active)
    const entry = { name: active.name, path: active.path, text, at: now }
    if (key) sessionContextCache.set(key, entry)
    else plainContextCache = entry
    return text
  }

  // —— 描述层注入（同步注册监听器；异步读盘包 try/catch；绝不在回调后调 section）——
  ctx.on('system-prompt/assemble', async (assembly, assembleContext, next) => {
    try {
      const agent = (assembleContext && (assembleContext.agent || assembleContext.scope)) || null
      // 恒定层：不读盘、无会话态 → 任何会话渲染结果逐字节相同，投影恒为 no-op
      if (assembly && Array.isArray(assembly.sections)) {
        const existing = assembly.sections.findIndex((s) => s && s.name === sectionName)
        const section = { name: sectionName, text: sectionText, order: sectionOrder }
        if (existing >= 0) assembly.sections[existing] = section
        else assembly.sections.push(section)
      }
      // 会话层：交给 runtime context 快照（会话尾部追加；内容未变则宿主不产生消息）
      const active = await resolveActive(agent)
      const text = await getContextText(active, agent)
      if (text && assembly && Array.isArray(assembly.contexts)) {
        const existing = assembly.contexts.findIndex((c) => c && c.name === CONTEXT_NAME)
        const context = { name: CONTEXT_NAME, order: contextOrder, text }
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
        return { text: lines.join('\n').slice(0, maxGetChars) }
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
        return { text: lines.join('\n').slice(0, maxGetChars) }
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
        return { text: lines.join('\n').slice(0, maxGetChars) }
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
            version: '0.2.1',
          },
        })
        return { text: `已创建 ${created.id}` }
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
          opts: { confirmed: args.confirmed === true, user: args.user || 'human:unknown', producer: 'dsh-wiki', version: '0.2.1' },
        }
        await c.updateConcept(dataDir, args.id, patch)
        return { text: `已更新 ${args.id}` }
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
        return { text: lines.join('\n').slice(0, maxGetChars) }
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
        const r = await c.ingestSource(dataDir, { source: args.source, refDir: args.ref_dir }, { producer: 'dsh-wiki', version: '0.2.1' })
        return { text: `ingested → ${r.refPath}${r.existed ? ' (existed)' : ''}; 来源概念 ${r.sourceConceptId}` }
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
        const r = await c.deprecateDir(dataDir, String(args.path || ''))
        return { text: `已停用 ${r.deprecated}/${r.total} 个概念` }
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
        return { text: rules.map((r) => `===== ${r.path} =====\n${r.content.trimEnd()}`).join('\n\n').slice(0, maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  })

  // —— wiki_dirs ——
  ctx.tools.register({
    name: 'wiki_dirs',
    description: [
      '查看全部 wiki 目录分支（命名 bundle）与当前激活项。',
      'bundle 来源：注册表 ~/.agents/wiki-registry.json ∪ 插件配置 dataDirs（同名配置优先）；隐式 default = dataDir 兜底。',
      '注册新目录：编辑注册表或插件配置 dataDirs；切换用 wiki_use。详见 wiki_help bundle。',
    ].join('\n'),
    parameters: { type: 'object', properties: {} },
    output: out,
    async execute(_args, exec) {
      try {
        const c = await loadCore()
        const agent = exec && exec.agent
        const rows = await c.listBundles(config)
        const session = agent ? sessionActive.get(agent) : plainActive
        const active = session || (await globalActive())
        const lines = rows.map((r) => {
          const markers = []
          if (r.active) markers.push('全局默认')
          if (session && session.name === r.name) markers.push('当前会话')
          const m = markers.length ? `  ← ${markers.join(' / ')}` : ''
          return `[${r.name}] ${r.path}${m}`
        })
        lines.push('', `当前生效目录：${active.path}`)
        lines.push('', '切换：wiki_use <name> [global:true]；注册新目录：~/.agents/wiki-registry.json 或插件配置 dataDirs（详见 wiki_help bundle）。')
        return { text: lines.join('\n').slice(0, maxGetChars) }
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
        const resolved = await c.resolveBundleRoot(config, { name: String(args.name) })
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
    description: '查 llm-wiki 机制文档：保留文件一览 / 怎么写目录 AGENTS.md / 怎么写 APPEND_SYSTEM_PROMPT.md（分类行为注入）/ OKF frontmatter 速查 / 门控判定逻辑。想给某分类加行为规则或门控时先查它。',
    parameters: {
      type: 'object',
      properties: { topic: { type: 'string', description: '主题：quickstart | files | agents | append | frontmatter | gate（缺省 quickstart）' } },
    },
    output: out,
    async execute(args, exec) {
      try {
        const c = await loadCore()
        const dataDir = (await resolveActive(exec && exec.agent)).path
        return { text: c.getHelp(args.topic).slice(0, maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  })
}
