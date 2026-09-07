/**
 * dsh-wiki —— DSH 宿主插件（llm-wiki 通用知识库，纯 OKF v0.2）。
 *
 * 复用 llm-wiki-core（packages/core）的全部逻辑；本文件只做宿主适配：
 * - 描述层注入（system-prompt/assemble 瀑布，可选宿主优化）
 * - 注册 9 个 wiki_* 工具
 * - 写入门控：读 AGENTS.md 规则后由 agent 交互确认（无代码强制弹窗）
 *
 * 数据目录默认 ~/.agents/wiki（os.homedir() 计算，可经 profile 补丁 config
 * dataDir 覆盖）。工具 schema 遵循宿主 DSL 形态。
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
  maxGetChars: 40000,
  cacheTtlMs: 30000,
}

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
  const dataDir = String(config?.dataDir || DEFAULTS.dataDir)
  const sectionName = String(config?.sectionName || DEFAULTS.sectionName)
  const sectionOrder = Number.isFinite(config?.sectionOrder) ? config.sectionOrder : DEFAULTS.sectionOrder
  const maxSectionChars = Number.isFinite(config?.maxSectionChars) ? config.maxSectionChars : DEFAULTS.maxSectionChars
  const maxGetChars = Number.isFinite(config?.maxGetChars) ? config.maxGetChars : DEFAULTS.maxGetChars
  const cacheTtlMs = Number.isFinite(config?.cacheTtlMs) ? config.cacheTtlMs : DEFAULTS.cacheTtlMs

  let cachedSection = null
  let cachedAt = 0

  async function buildSection() {
    const c = await loadCore()
    const tree = await c.listBundle(dataDir)
    const total = tree.reduce((n, t) => n + t.concepts.length, 0)
    const lines = [
      '## 通用知识库（llm-wiki · OKF v0.2）',
      `> 数据源：${dataDir}。共 ${total} 个概念，目录自由分层（表/口径计算/坑点/指标…靠 type 区分），概念间用真实链接交叉引用。`,
      '> 【硬要求】涉及知识检索/写入的第一步：先 `wiki_list` 看全貌（渐进披露），再决定下一步——不要凭印象直接搜或写。',
      '- 步骤1 wiki_list — 目录树 + 概念清单（type/title/id）',
      '- 步骤2 wiki_search — 关键词检索（匹配 frontmatter + 正文）',
      '- 步骤3 wiki_get — 读取单个概念完整正文（自动附 backlinks：引用它的坑点/概念）',
      '- wiki_create / wiki_update — 写入（门控读目录 AGENTS.md 规则，确认后带 human verified）',
      '- wiki_validate — OKF v0.2 合规校验；wiki_lint — 体检（断链/孤儿/过期/缺 index）',
      '- wiki_ingest — 登记外部源文件进 bundle；wiki_deprecate — 目录级批量停用（status: deprecated）',
      '',
      ...tree.map((t) => {
        const dep = t.concepts.filter((c) => c.status === 'deprecated').length
        return `- [${t.dir || '(root)'}] ${t.concepts.length} concepts${dep ? `（${dep} deprecated）` : ''}`
      }),
    ]
    let text = lines.join('\n')
    if (text.length > maxSectionChars) text = text.slice(0, maxSectionChars) + '\n…（描述层超限截断）'
    return text
  }

  async function getSectionText() {
    const now = Date.now()
    if (cachedSection !== null && now - cachedAt < cacheTtlMs) return cachedSection
    cachedSection = await buildSection()
    cachedAt = Date.now()
    return cachedSection
  }

  // —— 描述层注入（同步注册监听器；异步读盘包 try/catch；绝不在回调后调 section）——
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    try {
      const text = await getSectionText()
      if (assembly && Array.isArray(assembly.sections)) {
        const existing = assembly.sections.findIndex((s) => s && s.name === sectionName)
        const section = { name: sectionName, text, order: sectionOrder }
        if (existing >= 0) assembly.sections[existing] = section
        else assembly.sections.push(section)
      }
    } catch {
      // 静默降级
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
    async execute(args) {
      try {
        const c = await loadCore()
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
    async execute(args) {
      try {
        const q = String(args.query || '').trim()
        if (!q) return { text: 'query 不能为空' }
        const c = await loadCore()
        const graph = await c.buildGraph(dataDir)
        const res = c.searchGraph(graph, q, { type: args.type, tag: args.tag, limit: Number(args.limit) || 20 })
        if (!res.length) return { text: '无匹配。可 wiki_list 看全貌，或 wiki_lint 查看缺失概念/断链清单。' }
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
    async execute(args) {
      try {
        const c = await loadCore()
        const got = await c.getConcept(dataDir, args.id)
        if (!got) return { text: `未找到: ${args.id}。可 wiki_list 看全貌。` }
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
      '写入门控：自动记录（表结构等探查事实）直接写；需用户确认的内容先展示并征得同意后以 confirmed: true 调用。',
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
    async execute(args) {
      try {
        const c = await loadCore()
        const dir = dirname(args.path).replace(/\\/g, '/') === '.' ? '' : dirname(args.path).replace(/\\/g, '/')
        // 门控：读目录 AGENTS.md 规则，粗判是否需要 confirmed（规则含「需 human 确认」关键词且未 confirmed）
        const rules = await c.resolveRules(dataDir, dir)
        const ruleText = rules.map((r) => r.content).join('\n')
        const gateTypes = ['Attested Computation', 'Metric', '口径']
        const sensitive = /human\s*确认|human-confirm|confirmed|确认/i.test(ruleText)
        const typeSensitive = gateTypes.some((t) => t === args.type)
        if ((sensitive && typeSensitive) && !args.confirmed) {
          return needConfirmed(`目录规则 ${rules.map((r) => r.path).join(', ')} 要求 ${args.type} 类写入需 human 确认`)
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
            version: '0.1.0',
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
    async execute(args) {
      try {
        const c = await loadCore()
        const patch = {
          title: args.title, description: args.description, body: args.body,
          type: args.type, status: args.status,
          tags: args.tags ? args.tags.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          opts: { confirmed: args.confirmed === true, user: args.user || 'human:unknown', producer: 'dsh-wiki', version: '0.1.0' },
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
    async execute() {
      try {
        const c = await loadCore()
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
    async execute() {
      try {
        const c = await loadCore()
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
    async execute(args) {
      try {
        const c = await loadCore()
        const r = await c.ingestSource(dataDir, { source: args.source, refDir: args.ref_dir }, { producer: 'dsh-wiki', version: '0.1.0' })
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
    async execute(args) {
      try {
        const c = await loadCore()
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
    async execute(args) {
      try {
        const c = await loadCore()
        const rules = await c.resolveRules(dataDir, String(args.path || ''))
        if (!rules.length) return { text: '（无 AGENTS.md 规则）' }
        return { text: rules.map((r) => `===== ${r.path} =====\n${r.content.trimEnd()}`).join('\n\n').slice(0, maxGetChars) }
      } catch (e) { return strErr(e) }
    },
  })
}
