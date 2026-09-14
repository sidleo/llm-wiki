/**
 * wiki_help —— 静态机制文档（零磁盘依赖的纯文本常量）。
 *
 * 用途：让 agent 在需要创建 AGENTS.md / APPEND_SYSTEM_PROMPT.md，或想了解
 * OKF 字段、门控写法时，可通过 `wiki help <主题>` 自助查阅官方答案，
 * 不依赖猜测。内容随本项目规范版本走（SPEC-EXTENSIONS.md 的执行摘要）。
 */

export const HELP_TOPICS = ['quickstart', 'files', 'agents', 'append', 'frontmatter', 'gate', 'bundle', 'sync', 'feishu', 'prompt']

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

更多主题：wiki help files | agents | append | frontmatter | gate | bundle | sync（Git 远端）| feishu（飞书在线库）| prompt（给宿主配常驻要求）`,
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
| APPEND_SYSTEM_PROMPT.md | 正在用库的 agent | 描述层每轮注入 system prompt（pi 每回合注入；skill 用 \`wiki rules\` 载入 + 随 get/create/update 响应附带） | 该目录自定义的追加行为引导正文 |

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
原样追加进使用该 bundle 的 agent 的 system prompt。

三形态的落地方式（内容一致，机制不同）：
- DSH 插件：system-prompt 瀑布每轮注入（描述层）。
- pi 扩展：before_agent_start 钩子每回合现读并替换本回合 system prompt。
- skill/CLI：宿主没有注入钩子 → 用 \`wiki rules\`（不带目录）一次性载入全部
  APPEND 全文，且 get/create/update 的响应末尾会自动附该目录生效规则
  （规则随数据到达，agent 不必记得先载入）。

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
- DSH Web GUI：设置 → 插件 → 插件配置 → llm-wiki 卡片（命名目录增删改名/设默认、在线同步、
  体检与索引）——与 CLI/pi 共用同一份注册表；运行参数是部署级配置，改 profile 的 cordis.patch.yml
- wiki_use <name> [global: true] —— 会话级切换（DSH 按对话隔离，仅当前对话生效）；
  global: true 同时持久化为全局默认（写注册表 active，影响新会话与其他宿主）
- CLI：wiki dirs 查看 / wiki use NAME [--global] 切换；每条命令可 --wiki NAME 指定

解析顺序（无显式 name）：注册表 active（若为已知名字）→ default。`,
  ),

  feishu: doc(
    '飞书在线知识库（云盘文件夹 + 原生 .md）',
    `
在线库 = 飞书云空间里的一个文件夹，里面就是一组**原生 .md 文件**（目录结构与本地 bundle 同构），
所以 OKF v0.2 格式零损失：frontmatter / 目录 / 链接 / index / log / lint 全部照旧。

## 起步

- 新建在线库：wiki sync init --new-folder 永辉知识库 --name 飞书库 [--use]
  （在“我的空间”根建同名文件夹并注册命名 bundle；私有，仅你可见）
- 挂已有文件夹：wiki sync init --folder-token https://feishu.cn/drive/folder/fldcnXXXX --name 飞书库
- 多机/多人：另一台机器执行 wiki sync init --folder-token <URL> --name 飞书库，
  首次 wiki sync 会把远端内容拉到本地缓存（~/.agents/wiki-cloud/<名字>/）

## 本地缓存目录（可指定）

同步是在**本地缓存目录**里做的（与本地 bundle 同构的一组 .md）：

- 指定：wiki sync init … --cache-dir ~/Documents/feishu-wiki（必须是绝对路径或 ~/…；
  相对路径会因宿主工作目录不同而各认一份，故直接拒绝）
- 不指定：默认 ~/.agents/wiki-cloud/<bundle 名>
- 图形化：设置 → 插件 → 插件配置 → llm-wiki 卡片，飞书库那一栏的「本地缓存目录（可选）」
- 想换已有库的缓存目录：先从注册表移除（删注册不动磁盘），再用新目录挂载；
  或直接把新目录指到旧缓存上复用（账本 .wiki-cloud.json 会决定三方状态）
- 卡片同样支持：命名目录那一行 →「缓存目录」（0.4.9+）。旧缓存不删；旧缓存有
  待推送/冲突、或目标目录被别的飞书库/别的 folderToken 的账本占用时会拒绝
- 注意：换到一个**已有同内容 .md** 的目录（例如就是原来的本地库）时，因为账本里的
  时间戳来自旧缓存，首次同步会把它们全部当作「本地改动」重推一遍——字节相同、
  只是时间戳不同，推一次即对齐（内容无害，只是飞行一次）

## 日常

- wiki sync status —— 只读：待推送 / 待拉取 / 两侧都改（冲突）/ 远端已删 / 被忽略的非 .md 资源
- wiki sync（或 wiki sync pull / wiki sync push）—— 推本地改动 + 拉远端改动

## 怎么判断"谁改过"（三方状态）

本地缓存里有一份 .wiki-cloud.json，记录上次同步时每个文件的
{fileToken, 远端 modified_time, 本地 mtime/size}。据此判断：
- 只有本地变 → 推（markdown +overwrite，只推这个文件）
- 只有远端变 → 拉（覆盖前先备份到 .backup/<时间戳>/）
- 两侧都变 → **冲突，停下来报清单**（index.md 例外：本地按目录树重生成；log.md 例外：取并集）

## 安全边界

- **永不删除远端文件、永不因拉取删本地文件**；v1 不同步删除，只在 status 里报告差异。
- 不保存任何 token：认证归 lark-cli（user 身份）；注册表只存 folderToken（权限在飞书侧）。
- 冲突不静默、不 force：任何一侧都不会被自动覆盖。
- 人是浏览者：在飞书云空间看/下载即可；写入由 agent 通过本工具完成。

## 成本与依赖

- 首次同步 = 逐文件上传/下载（上百文件需要几分钟），之后只传改动文件。
- 依赖 lark-cli 已登录（lark-cli auth login）；缺 scope 时按报错提示补授权。
- 需要"知识库侧边栏"体验或想让人直接在线编辑正文，那是另外两种形态：
  飞书知识库节点（wiki）与多维表格（Base）——v1 未采用，见仓库 README 的取舍说明。`,
  ),

  sync: doc(
    '在线知识库（Git 远端同步）',
    `
bundle 仍是本地 markdown 目录树，远端同步让多台机器 / 多人 / 多个 agent 读写同一份知识库。

## 起步（二选一）

- 已有本地 bundle：在 bundle 根执行 wiki sync init --remote <仓库URL> [--name 名字] [--use]
  （git init + 最小 .gitignore + 首次提交 + push -u；--name 同时注册为命名 bundle）
- 还没有本地目录：wiki sync clone <仓库URL> <目录> [--name 名字] [--use]
  （clone 后注册命名 bundle，三形态共享同一注册表）

## 日常

- wiki sync status —— 只读：远端 / 分支 / ahead-behind / 脏文件 / 冲突 / 最后提交
- wiki sync [--message M] —— 提交本地改动 → fetch → 合并远端 → push（不 force）

## 冲突策略（关键）

- index.md：派生文件，同步时用 core 从合并后的目录树**重新生成**，永不阻塞。
- log.md：追加式且格式自有，冲突按「日期块 + 条目行」取并集去重，永不阻塞。
- 概念 / AGENTS.md / APPEND_SYSTEM_PROMPT.md：人工撰写的知识，**不自动合并**。
  此时同步会 merge --abort 并报冲突清单，工作区回到同步前状态（本地提交保留），
  人工解决后重跑即可。

## 安全边界

- 绝不 push --force、绝不 reset --hard、绝不代你 abort 进行中的 merge/rebase。
- bundle 必须是 git 仓库顶层；bundle 位于更大仓库子目录时直接拒绝（防止误提交他处文件）。
- 凭证完全交给 git（SSH agent / credential helper）；本项目不存储任何 token。
- 无交互执行：GIT_TERMINAL_PROMPT=0 + BatchMode，凭证缺失立即失败并透出 git 报错。
- 远端配置只存在 git 自己（.git/config）；知识库格式层零新增字段。
- 浏览器浏览直接用托管平台（GitHub/GitLab/Gitea）的 markdown 渲染，不另起服务。`,
  ),

  prompt: doc(
    '给没有注入能力的宿主配常驻要求（wiki prompt）',
    `
背景：三形态里 DSH 插件（system-prompt 瀑布）与 pi 扩展（before_agent_start 钩子）
都能自己把规则注入 system prompt，agent 无需记得。**skill/CLI 形态的宿主
（豆包 / WorkBuddy / 其他 GUI agent）没有这种钩子**——宿主只在它认为相关时才加载
SKILL.md，加载与否、加载后是否真去查库，都不由我们决定。

做法：\`wiki prompt\` 打印一段可直接粘贴的常驻要求，把它写进**宿主自己的**
「自定义指令 / 系统提示词 / 项目 AGENTS.md」，就等于给宿主补上了每轮注入：

- \`wiki prompt\` —— 带使用说明的输出（虚线以下整段粘贴）
- \`wiki prompt --raw\` —— 只输出正文（便于脚本/agent 直接写文件）
- \`wiki prompt --full\` —— 追加在线同步与体检条款

正文覆盖：先查库再回答（不许凭记忆答表结构与口径）、主动记录（新表/坑点/确认过的口径）、
写入门控（需 human 确认的类型先征得同意再加 --confirmed）、收尾 lint、CLI 绝对路径兜底、
多库切换。默认库名与路径按当前注册表动态填入。

常见位置：WorkBuddy 设置 → 个性化 → 自定义指令；GUI agent 的系统提示词；
CLI agent 的项目 AGENTS.md。DSH / pi 不需要（已自动注入同一套内容）。

换宿主时的通用姿势：新宿主里能跑命令的话，直接执行 \`wiki prompt\` 把输出贴进它的指令栏即可。`,
  ),
}

/**
 * @param {string} topic quickstart|files|agents|append|frontmatter|gate|bundle|sync|feishu|prompt（大小写不敏感；缺省 quickstart）
 */
export function getHelp(topic) {
  const t = String(topic || 'quickstart').trim().toLowerCase()
  if (SECTIONS[t]) return SECTIONS[t]
  const names = HELP_TOPICS.join(' | ')
  return doc('wiki help', `未知主题「${topic}」。可用主题：${names}\n例：wiki help append`)
}
