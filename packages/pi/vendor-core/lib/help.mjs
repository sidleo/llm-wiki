/**
 * wiki_help —— 静态机制文档（零磁盘依赖的纯文本常量）。
 *
 * 用途：让 agent 在需要创建 AGENTS.md / APPEND_SYSTEM_PROMPT.md，或想了解
 * OKF 字段、门控写法时，可通过 `wiki help <主题>` 自助查阅官方答案，
 * 不依赖猜测。内容随本项目规范版本走（SPEC-EXTENSIONS.md 的执行摘要）。
 */

export const HELP_TOPICS = ['quickstart', 'files', 'agents', 'append', 'frontmatter', 'gate', 'bundle']

function doc(title, body) {
  return `# ${title}\n\n${body.trim()}\n`
}

const SECTIONS = {
  quickstart: doc(
    'llm-wiki 快速上手',
    `
知识库 = OKF v0.2 bundle：一个 markdown 目录树。每个概念 = 一个 .md 文件
（YAML frontmatter + 正文）。工作链路：

1. wiki_list —— 看全貌（目录树 + 概念清单，渐进披露第一步）
2. wiki_search <关键词> —— 检索（frontmatter + 正文）
3. wiki_get <id 或 title> —— 读单个概念完整正文（自动附 backlinks）
4. wiki_validate / wiki_lint —— 合规校验 / 体检
5. 写入：wiki_create / wiki_update；停用：wiki_deprecate；查规则：wiki_rules
6. 多目录：wiki_dirs 查看分支，wiki_use <name> [global: true] 切换

更多主题：wiki help files | agents | append | frontmatter | gate | bundle`,
  ),

  files: doc(
    '保留文件一览',
    `
每个目录可放三类保留文件（任意层级，豁免 type 校验、不作 concept）：

| 文件名 | 读者 | 时机 | 语义 |
|--------|------|------|------|
| index.md | 人/agent | 按需读 | 目录索引（渐进披露入口；根可带 okf_version） |
| log.md | 人/agent | 按需读 | 时间线变更历史（ISO-8601 日期标题） |
| AGENTS.md | core 工具代码 | wiki_create/update 执行时 resolveRules；wiki_rules 调用时 | 目录规则：怎么写、写前是否需确认（「## 门控」节） |
| APPEND_SYSTEM_PROMPT.md | 正在用库的 agent | 描述层每轮注入 system prompt | 该目录自定义的追加行为引导正文 |

其余所有 .md 都是概念文档（含 type 必填的 frontmatter）。`,
  ),

  agents: doc(
    '如何写 AGENTS.md（目录规则）',
    `
位置：任意目录（如 bundle 根、或 永辉/sql/）。可多级：对目录 D 生效的是
D → bundle 根链上「最近」的 AGENTS.md，多条逐级叠加、子覆盖父。

用途：给写工具（wiki_create/update）的确定性门控读 —— 不是给 LLM 看的行为引导。

格式：普通 markdown，无 frontmatter。门控约定节（可选）：

## 门控

- 需 human 确认: Metric, Attested Computation
- 自动记录: Table, Pitfall

- 「需 human 确认」列出的 type：未带 confirmed:true 的写入会被拦回，要求先向用户展示并确认。
- 未列 / 无门控节：默认全部自动记录（通用库默认开放）。
- 子目录声明覆盖父目录（取链上最近含门控节的声明）。
- 除门控节外可自由写该目录的其他约定（由人读，或将来工具扩展解析）。`,
  ),

  append: doc(
    '如何写 APPEND_SYSTEM_PROMPT.md（目录提示词注入）',
    `
位置：任意目录（如 永辉/sql/APPEND_SYSTEM_PROMPT.md）。正文是什么，就会
原样追加进使用该 bundle 的 agent 的 system prompt 每轮注入。

用途：定义该分类的「行为规则」——比如主动记录约定（什么场景自动记、什么场景先确认）、
先查库再动手的约定、口径红线、表过期探查策略等。插件本身不含任何场景写死的提示词；
各分类的行为完全由这份文件决定。

格式：普通 markdown，无 frontmatter。建议结构：

# <分类>知识工作规则

做 <分类> 相关工作时遵循：

## 先查库，不凭印象写

1. 先 wiki_search 缩小范围，再 wiki_get 读明细（示例与数据都要读）。
2. 读明细时注意 backlinks 附带的相关条目，先读避免重复踩坑。

## 主动记录（不等用户吩咐）

- <触发场景1> → wiki_create（type: X）自动补录，无需确认
- <触发场景2 需确认> → 展示给用户，确认后 wiki_create（type: Y，带 confirmed）

## <该分类特有的红线/约定>

（写该分类的口径红线、过期策略等。）

生效：文件落盘后，描述层下个缓存窗口（约 30 秒）自动收录并注入，无需改插件、无需重启。
注意：每轮都注入，写精简有力的规则（建议 < 30 行），超长会被截断。`,
  ),

  frontmatter: doc(
    'OKF v0.2 frontmatter 字段速查',
    `
必填：type（种类名，自由值，例 Table / Attested Computation / Pitfall / Reference / Metric / Playbook）。

推荐：title（显示名，缺省用文件名）、description（一句话摘要）、tags（数组）、resource（底层资产 URI）。

可信与生命周期：sources（来源列表，{id, resource, title, author, usage_count, last_modified}；正文用 [^id] 脚注引用）、
generated（{by: agent:x/y 或 human:id 或 process:id, at: ISO8601}）、verified（[{by, at}] 列表）、
status（draft/stable/deprecated，缺省 stable）、stale_after（绝对过期时刻）。

Attested Computation 族：runtime（bigquery/postgres/dbt/python…）、parameters（[{name, type, required}]）、
computation（计算文件路径，缺省用正文 # Computation 代码块）、executor（{resource, receipt}）、attester（{resource}）。

规则：不引入任何上述之外的自定义 frontmatter 字段；正文引用用 markdown 链接 /path.md 或 [[wiki-link]]。`,
  ),

  gate: doc(
    '门控判定逻辑（wiki_create/update 如何决定拦不拦）',
    `
判定完全由目标目录链 AGENTS.md 的「## 门控」声明决定（core.gateForType）：

1. resolveRules(dir) 读出 D → bundle 根链上全部 AGENTS.md（根在前、最近在后）。
2. 从最近往根找第一个含「## 门控」节的声明；该节「需 human 确认」列表含写入 type → 拦截（返回展示确认引导）。
3. 链上没有任何门控节 → 默认全部自动记录（不拦截）。

子目录声明覆盖父目录。confirmed:true 调用带 human verified 落盘。`,
  ),

  bundle: doc(
    'wiki 目录分支（多 bundle 注册与切换）',
    `
默认数据目录 ~/.agents/wiki；要管理多个 wiki 目录，用「命名 bundle」：

注册（二选一，可并存、同名宿主配置优先）：
- 注册表文件（跨三形态共用，默认 ~/.agents/wiki-registry.json，env WIKI_REGISTRY_FILE 覆盖）：
    { "bundles": { "工作": "/abs/path/a", "个人": "~/notes/wiki" }, "active": "工作" }
- DSH 插件配置声明式注册（与注册表合并）：
    config: { dataDirs: { 工作: '/abs/path/a', 个人: '~/notes/wiki' } }
- 隐式 default = config.dataDir || ~/.agents/wiki：未配置任何名字时的兜底。

切换：
- wiki_dirs —— 查看全部 bundle 与当前激活项
- wiki_use <name> [global: true] —— 会话级切换（DSH 按对话隔离，仅当前对话生效）；
  global: true 同时持久化为全局默认（写注册表 active，影响新会话与其他宿主）
- CLI：wiki dirs 查看 / wiki use NAME [--global] 切换；每条命令可 --wiki NAME 指定

解析顺序（无显式 name）：注册表 active（若为已知名字）→ default。`,
  ),
}

/**
 * @param {string} topic quickstart|files|agents|append|frontmatter|gate（大小写不敏感；缺省 quickstart）
 */
export function getHelp(topic) {
  const t = String(topic || 'quickstart').trim().toLowerCase()
  if (SECTIONS[t]) return SECTIONS[t]
  const names = HELP_TOPICS.join(' | ')
  return doc('wiki help', `未知主题「${topic}」。可用主题：${names}\n例：wiki help append`)
}
