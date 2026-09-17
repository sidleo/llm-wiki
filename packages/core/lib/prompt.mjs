/**
 * prompt.mjs —— 生成「宿主常驻要求」文本（给没有注入能力的 agent 宿主用）。
 *
 * 四形态里 DSH 插件、pi 扩展、MCP 服务端都能自己把规则下发给 agent，
 * 但豆包 / WorkBuddy / 其他 GUI agent 只能靠宿主自己的「自定义指令 / 系统提示词」。
 * 本模块产出那段可直接粘贴的文本（由 `wiki prompt` 打印），
 * 让 agent 或用户把它写进宿主指令——换任何宿主都能这么干。
 *
 * 两种形态的文案分开：`form: 'cli'`（默认）说 `wiki` CLI；`form: 'mcp'` 说 MCP 工具。
 * 混用会反向误导 agent（MCP 宿主里让它去 bash 调 CLI）。
 */

/** 紧凑版：常驻要求正文（约 15 行；每轮都会进上下文，故保持简短）。 */
function shortBody({ name, path }) {
  const bundleLine = name ? `当前默认库：${name}（${path}）` : '当前默认库：（未解析到，先跑 `wiki dirs` 看）'
  return `【llm-wiki 知识库使用要求】
本机有工作知识库（表结构 / 字段 / 指标口径 / 取数经验 / 踩坑记录），用 \`wiki\` CLI 读写。${bundleLine}

1) 先查库再回答：涉及表、字段、表结构，指标口径与取数来源，要写或改 SQL，数据对不上或口径不一致，
   想知道某张表有什么坑时——先执行 \`wiki rules\`（不带参数＝载入全部分类行为规则，务必遵守），
   再 \`wiki search <业务词或表名>\`，命中就 \`wiki get <id>\` 读全文。**不要凭记忆回答表结构与口径。**
2) 主动记录：用到库里没有的表 → 探查结构后 \`wiki create <路径> --type Table ...\`；
   踩坑或查到根因 → \`--type Pitfall\`；与用户确认过的新口径 → \`--type Metric\` 或 \`Attested Computation\`。
3) 写入前看门控：\`wiki rules <目标目录>\` 的「## 门控」若要求 human 确认，必须先向用户展示并征得同意，
   再带 \`--confirmed\`（并把 WIKI_USER 设为用户名）写入。
4) 收尾自查：\`wiki lint\` 看断链 / 缺失清单。
5) 命令不在 PATH 时（GUI 宿主常见）用绝对路径：\`node "$HOME/.agents/skills/wiki/scripts/wiki.mjs" <子命令>\`。
6) 多库：\`wiki dirs\` 查看已注册库，\`wiki use <名字> --global\` 切换全局默认。

（DSH 插件与 pi 扩展已自动注入同一套规则，无需再加；上面这段是给不自带注入能力的宿主用的。）`
}

/** 完整版：额外包含在线同步与体检。 */
function fullExtra() {
  return `
7) 在线同步：\`wiki sync status\` 看远端状态，\`wiki sync\` 双向同步（本地目录走 Git 远端、飞书库走云盘）。
   冲突会停下来报清单，绝不 force、绝不删任一端的文件；\`index.md\` 自动重生成、\`log.md\` 取并集。
8) 体检：\`wiki validate\`（OKF 合规）/ \`wiki lint\`（断链、孤儿、过期、缺 index）。`
}

/** MCP 版：说 MCP 工具名（宿主已配 wiki MCP 服务端时用，混用 CLI 文案会反向误导）。 */
function mcpBody({ name, path }) {
  const bundleLine = name ? `当前默认库：${name}（${path}）` : '当前默认库：（未解析到，先调 wiki_dirs 看）'
  return `【llm-wiki 知识库使用要求（MCP 形态）】
本机已配置 wiki MCP 服务端，读写本机工作知识库（表结构 / 字段 / 指标口径 / 取数经验 / 踩坑记录）。${bundleLine}
工具名以 \`wiki_\` 开头；部分宿主会加前缀（如 \`mcp__wiki__wiki_search\`），指向同一个工具。

1) **何时必须查库**（不查就会答错的那种）：问某张表 / 字段 / 表结构；问指标怎么算、口径是什么、该从哪张表取；
   要写或改 SQL；数据对不上、算出来不一致、排查异常；问某张表有什么坑 / 上次踩过的坑。→ 先调 \`wiki_list\` 看全貌
   或 \`wiki_search\` 检索，命中就 \`wiki_get\` 读全文。**不要凭记忆回答表结构与口径。**
2) 读了概念就照它的口径执行：\`wiki_get\` / \`wiki_search\` 里带的「规则 / 门控」是硬约束。
3) 主动记录（不必等用户吩咐）：用到库里没有的表 → 探查结构后 \`wiki_create\`（type: Table）；
   踩坑或查到根因 → \`wiki_create\`（type: Pitfall）；与用户确认过的新口径 → \`wiki_create\`（type: Metric 或
   Attested Computation，带 confirmed: true）。
4) 写入前先 \`wiki_rules <目标目录>\`：门控要求 human 确认的，必须先向用户展示并征得同意再带 \`confirmed: true\`。
5) 收尾可 \`wiki_lint\` 看断链 / 缺失清单；多库用 \`wiki_dirs\` / \`wiki_use\`。

（MCP 服务端连接时已通过 instructions 下发同一套引导；这段是给不读 instructions 的宿主补的常驻要求。）`
}

/**
 * 生成宿主常驻要求文本。
 * @param {{name?:string, path?:string, full?:boolean, form?:'cli'|'mcp'}} [opts]
 * @returns {string}
 */
export function buildAgentPrompt(opts = {}) {
  if (opts.form === 'mcp') return mcpBody({ name: opts.name || '', path: opts.path || '' })
  const body = shortBody({ name: opts.name || '', path: opts.path || '' }) + (opts.full ? fullExtra() : '')
  return body
}

/**
 * 带使用说明的完整输出（`wiki prompt` 默认形态；虚线以下可直接整段粘贴）。
 * @param {{name?:string, path?:string, full?:boolean, form?:'cli'|'mcp'}} [opts]
 * @returns {string}
 */
export function buildAgentPromptDoc(opts = {}) {
  const mcp = opts.form === 'mcp'
  const hint = [
    '# 把下面虚线以下的整段，加入宿主的「自定义指令 / 系统提示词 / 项目 AGENTS.md」',
    '# 常见位置：WorkBuddy 设置 → 个性化 → 自定义指令；GUI agent 的系统提示词或 AGENTS.md；CLI agent 的项目 AGENTS.md',
    mcp
      ? '# 本段是 MCP 形态文案（宿主已配 wiki MCP 服务端）；纯 CLI 宿主用 wiki prompt（不带 --mcp）'
      : '# 本段是 CLI 形态文案；宿主已配 wiki MCP 服务端时改用 wiki prompt --mcp（否则会引导 agent 去 bash 调 CLI）',
    `# 重新生成：wiki prompt${mcp ? ' --mcp' : ''} [--full] [--raw]`,
    '# ------------------------------------------------------------------',
  ].join('\n')
  return `${hint}\n${buildAgentPrompt(opts)}\n`
}
