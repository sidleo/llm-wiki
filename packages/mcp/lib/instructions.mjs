/**
 * instructions.mjs —— MCP 侧的「描述层注入」文本。
 *
 * MCP 没有 DSH 的 system-prompt/assemble 瀑布，也没有 pi 的 before_agent_start 钩子：
 * 唯一的下发通道是 initialize 响应的 `instructions` 字段（静态，连接时一次）。
 * 因此这里产出两段拼起来的文本，与 DSH 注入的两层同源同结构：
 *   1) 恒定层 SECTION_TEXT（与 DSH 逐句对应；仅 DSH 特有的 GUI 那行按形态改写）；
 *   2) 会话层 buildContextText（当前 bundle 名+路径 / 可用目录 / 各目录 APPEND_SYSTEM_PROMPT 正文）。
 *
 * 规则改动后 instructions 不会自动更新（协议限制）：靠 wiki_rules 工具、以及
 * core 在 wiki get/create/update 响应末尾自动附带目标目录规则来兜住。
 */

import { DEFAULTS } from './config.mjs'

/**
 * 恒定层正文：所有 bundle / 所有会话都适用。
 * 与 packages/dsh/wiki.mjs 的 SECTION_TEXT 逐句对齐，差异只有两处（形态相关）：
 * - 「图形化配置…卡片」→ 本形态的目录管理入口；
 * - 补一行 MCP 工具名前缀说明（宿主可能显示为 mcp__<server>__wiki_*）。
 */
export const SECTION_TEXT = [
  '## 通用知识库（llm-wiki · OKF v0.2）',
  '> 目录自由分层（表/口径计算/坑点/指标…靠 type 区分），概念间用真实链接交叉引用。',
  '> 【硬要求】涉及知识检索/写入的第一步：先 `wiki_list` 看全貌（渐进披露），再决定下一步——不要凭印象直接搜或写。',
  '> 工具名以 `wiki_` 开头；部分宿主会给 MCP 工具加前缀（如 `mcp__<server>__wiki_search`），指向的是同一个工具。',
  '- 步骤1 wiki_list — 目录树 + 概念清单（type/title/id）',
  '- 步骤2 wiki_search — 关键词检索（匹配 frontmatter + 正文）',
  '- 步骤3 wiki_get — 读取单个概念完整正文（自动附 backlinks：引用它的坑点/概念）',
  '- wiki_create / wiki_update — 写入（门控读目录 AGENTS.md 规则，确认后带 human verified）',
  '- wiki_validate — OKF v0.2 合规校验；wiki_lint — 体检（断链/孤儿/过期/缺 index）',
  '- wiki_ingest — 登记外部源文件进 bundle；wiki_deprecate — 目录级批量停用（status: deprecated）',
  '- wiki_dirs — 查看已配置的目录分支；wiki_use <name> [global:true] — 切换当前分支（进程级/持久化全局默认）',
  '- wiki_sync — 在线知识库同步（按 bundle 后端分派）：本地目录走 Git 远端（status/sync/init/clone），飞书云盘库走 lark-cli（status/sync/pull/push/init，文件级增量、永不删两端）。冲突都停下来报清单，绝不 force/覆盖。见 wiki_help sync 与 wiki_help feishu。',
  '- 命名目录：wiki_dirs 查看、wiki_use 切换；注册新目录编辑 `~/.agents/wiki-registry.json`，或用启动参数 `--bundles 名=路径`（本形态无 GUI 配置）。',
  '- wiki_help — 查机制文档（保留文件/怎么写 AGENTS.md/怎么写 APPEND_SYSTEM_PROMPT.md/frontmatter/门控/多目录）。想给某分类加行为规则 → 在该目录建 APPEND_SYSTEM_PROMPT.md（正文即追加的 system prompt）；想定写门控 → 在该目录 AGENTS.md 写「## 门控」节。详情 wiki help。',
].join('\n')

/** 会话层标题（与 dsh 插件同一句话，便于跨形态辨认）。 */
export const RULES_TITLE =
  '【知识库自定义规则】以下内容来自各目录 APPEND_SYSTEM_PROMPT.md（用户为该分类定义的 system prompt 追加）：'

/**
 * 会话层正文：当前 bundle（名 + 路径）+ 目录名清单 + 各目录 APPEND_SYSTEM_PROMPT.md 规则。
 * 【不变量】只放「变化很慢」的事实：概念计数属高频 churn，绝不进这层（归 wiki_list）。
 * 与 packages/dsh/wiki.mjs 的 buildContext 同结构、同措辞。
 */
export async function buildContextText({ core, active, maxChars = DEFAULTS.maxContextChars }) {
  const lines = [`当前知识库：${active.name || 'default'}（${active.path}）`]
  try {
    const tree = await core.listBundle(active.path)
    if (tree.length) lines.push(`可用目录：${tree.map((t) => t.dir || '(root)').join('、')}`)
  } catch {
    // 读盘失败不影响规则注入
  }
  try {
    const prompts = await core.collectInjectPrompts(active.path)
    if (prompts.length) {
      lines.push('', RULES_TITLE, '')
      for (const p of prompts) {
        lines.push(p.dir ? `### [${p.dir}]` : '### (bundle 根规则)', '', p.content, '')
      }
    }
  } catch {
    // 注入失败不影响描述层（静默降级）
  }
  let text = lines.join('\n')
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（instructions 超限截断）'
  return text
}

/** 完整的 instructions：恒定层 + 会话层。 */
export async function buildInstructions({ core, active, maxChars }) {
  const context = await buildContextText({ core, active, maxChars })
  return `${SECTION_TEXT}\n\n${context}`
}
