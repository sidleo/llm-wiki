---
name: wiki
version: 0.4.10
description: >-
  工作知识库（表结构/字段/指标口径/SQL 取数经验/踩坑记录/业务流程），OKF v0.2 markdown
  bundle，用 `wiki` CLI 读写。**以下情况先用本 skill 查库，不要凭记忆或印象回答**：
  问某张表/某字段/表结构（有哪些列、什么类型、怎么关联、是否分区）；问某个指标怎么算、
  口径是什么、该从哪张表取（销售额/客流/客单价/有货率/毛利等任何业务指标）；
  要写或改 SQL 取数；数据对不上、算出来不一致、排查异常；想知道某张表有什么坑、注意事项、
  历史踩坑；需要沉淀经验（踩坑、业务规则、探查结论、新表结构）；用户提到知识库、经验库、
  表口径文档、取数经验、SQL 知识库、踩过的坑、llm-wiki、OKF、Open Knowledge Format、
  knowledge bundle、agent knowledge；要把外部资料收进知识库、体检知识库（断链/过期/索引）、
  或在多台机器/多人之间同步知识库。不负责：与知识库无关的通用编程问答与闲聊；
  具体数据本身由数据平台工具（如 yh-bigdata）查询，本 skill 提供的是「口径是什么、
  怎么取、有哪些坑」这类知识。
metadata:
  requires:
    bins: ["wiki"]
  cliHelp: "wiki --help"
  bundle-format: "OKF v0.2 (https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)"
  data-dir-default: "~/.agents/wiki（可用 --dataDir 或 WIKI_DATA_DIR 覆盖）"
  multi-bundle: "命名 bundle：注册表 ~/.agents/wiki-registry.json；wiki dirs 查看、wiki use NAME [--global] 切换、--wiki NAME 指定"
---

# llm-wiki Skill

一个知识库（OKF v0.2 + llm-wiki 范式）的通用访问层。**格式与数据是唯一事实**：任何 agent（本 skill 只是其中之一）都能读写同一 bundle。

> CLI 位置：`wiki`（在 PATH 中时直接用；装法见 `~/.agents/skills/wiki/scripts/install.sh`）。
> 若宿主报 `command not found`（GUI 应用的 PATH 常不含 /usr/local/bin），
> 改用绝对路径调用：`node "$HOME/.agents/skills/wiki/scripts/wiki.mjs" <子命令>`。

## 0. 主动使用条款（本 skill 的核心价值）

**先查库、再动手**。以下情况**必须**先查库，不许凭记忆答：

- 涉及**表/字段/表结构**的任何问题 → `wiki search <表名或业务词>`，命中就读 `wiki get <id>` 全文
- 涉及**指标口径/取数来源**（怎么算、从哪张表取、过滤条件、时间口径）→ 先 `wiki search`；没命中就先实际探查再回答，不臆造口径
- **写 SQL 之前** → 先读表结构与该分类的**口径红线**；读到的坑点（Pitfall）必须遵守
- **数据对不上/异常/口径不一致** → 先查同类踩坑记录，再排查、再下结论
- 用户说「上次那个坑」「按我们库里的口径」→ 先查库

**主动记录**（不必等用户吩咐；细节规则以 `wiki rules` 的输出为准）：

- 用了库里没有的表 → 探查结构后用 `wiki create`（type: Table）补录
- 踩了坑 / 查出根因 → 记 `Pitfall`；与用户确认过的新口径 → 记 `Metric` 或 `Attested Computation`
- 规则声明需 human 确认的类型 → 先向用户展示、确认后加 `--confirmed`
- 收尾可 `wiki lint` 看断链/缺失清单

**把上面这些变成宿主的常驻要求（建议做一次）**：本 skill 只在宿主加载它时才生效，
宿主是否加载、加载后会不会真去查库，不由我们决定。跑 `wiki prompt` 拿到一段可直接粘贴的
「宿主常驻要求」，写进**宿主自己的**「自定义指令 / 系统提示词 / 项目 AGENTS.md」——
相当于替这个宿主补上每轮注入（你有文件权限就直接写，没有就让用户粘贴）。
换任何新宿主都是同一招；DSH 插件与 pi 扩展已自动注入，不需要。详见 `wiki help prompt`。

## 1. 何时使用本 Skill

以下场景应使用本 skill：

- 需要检索/查询工作环境的知识库（表结构、字段、口径、坑点、指标、流程）
- 用户提到「知识库」「表口径」「这个表怎么查」「踩过的坑」等，且存在 `~/.agents/wiki`（或 `WIKI_DATA_DIR`）bundle
- 需要把新的源资料/经验写入知识库（create / ingest）
- 需要体检知识库（validate / lint）或停用整块知识（deprecate）
- 需要多机/多人共享同一份知识库（`wiki sync`，Git 远端或飞书云盘库）

## 2. 前置条件

1. `wiki` CLI 已安装且可用（`metadata.requires.bins: ["wiki"]`）。安装：`bash ~/.agents/skills/wiki/scripts/install.sh`（软链到 /usr/local/bin）。
   **若宿主找不到 `wiki`**（GUI 应用的 PATH 常常没有 /usr/local/bin）：用绝对路径
   `node "$HOME/.agents/skills/wiki/scripts/wiki.mjs" <子命令>`，或让用户把 /usr/local/bin 加进宿主 PATH。
2. 默认数据目录 `~/.agents/wiki`；其他路径用 `--dataDir DIR` 或 `WIKI_DATA_DIR`。
3. 多目录：命名 bundle 注册在 `~/.agents/wiki-registry.json`（`{ "bundles": { "名字": "/path" }, "active": "名字" }`）；`wiki dirs` 查看分支、`wiki use NAME [--global]` 切换、命令加 `--wiki NAME` 指定。
4. 若目录不存在或为空，可用 demo bundle 参考结构：仓库 `examples/demo-bundle/`。

## 3. 标准链路（渐进披露）

与 llm-wiki 的 index.md 渐进披露一致——**先看规则、再看全貌、再按需取明细**：

0. `wiki rules` —— **开工第一步**：载入各分类 `APPEND_SYSTEM_PROMPT.md` 行为规则全文
   （本 skill 无 system prompt 注入，这一步就是替代入口；`wiki get/create/update` 的响应
   也会自动附带目标目录的规则，兜住忘记的情况）
1. `wiki list [--dataDir DIR]` —— 目录树与全部概念（type/title/id）
2. `wiki search <关键词> [--type T] [--tag TAG]` —— 关键词检索（匹配 frontmatter + 正文）
3. `wiki get <id 或 title>` —— 读单个概念全文，**自动附 backlinks（谁引用了它 → 相关坑点/概念自然出现）+ 该目录生效规则**
4. 需要校验/体检：`wiki validate` / `wiki lint`

## 4. 命令速查

| 命令 | 作用 |
|------|------|
| `wiki list [--type T] [--status S]` | 列出全部概念（按目录分组） |
| `wiki search QUERY [--type T] [--tag TAG]` | 关键词检索 |
| `wiki get ID` | 读单概念（id 或 title），附 backlinks |
| `wiki create PATH --type TYPE [--title T] [--description D] [--body @file] [--tags a,b]` | 新增概念 |
| `wiki update ID [--title T] [--description D] [--body @file] [--status S]` | 更新概念 |
| `wiki validate` | OKF v0.2 合规校验 |
| `wiki lint` | 体检：断链/孤儿/过期/缺 index |
| `wiki ingest SOURCE [--ref-dir DIR]` | 登记外部源文件进 bundle（copy 不改源） |
| `wiki deprecate DIR` | 目录级批量标 `status: deprecated` |
| `wiki rules [DIR]` | **载入规则**：不带 DIR = 本 bundle 全部 `APPEND_SYSTEM_PROMPT.md` 正文（= 本应被注入的全文）+ 根 AGENTS.md；带 DIR = 该目录生效的 APPEND 链 + AGENTS.md 门控链 |
| `wiki prompt [--raw] [--full]` | 生成「宿主常驻要求」文本（贴进宿主的自定义指令/系统提示词；换宿主通用，见 `wiki help prompt`） |
| `wiki index [DIR]` | 重生成目录 index.md（写操作已自动维护，手工修复时用） |
| `wiki sync [status\|pull\|push]` | 在线同步（按 bundle 后端分派）：Git 远端或飞书云盘库；`status` 只读 |
| `wiki sync init --remote URL [--name N] [--use]` | 本地 bundle 挂 Git 远端并首推 |
| `wiki sync init --new-folder 名称 --name N [--cache-dir D] [--use]` | 在飞书「我的空间」新建文件夹并注册为在线库（原生 .md） |
| `wiki sync init --folder-token URL\|TOKEN --name N` | 挂载已有飞书文件夹（另一台机器/多人共享） |
| `wiki sync clone URL DIR [--name N] [--use]` | 克隆 Git 远端知识库到本地并注册 |
| `wiki help [主题]` | 查机制文档：quickstart｜files｜agents（怎么写 AGENTS.md）｜append（怎么写 APPEND_SYSTEM_PROMPT.md）｜frontmatter｜gate｜bundle｜sync（在线同步与冲突策略） |

想给某分类加行为规则 → 在该目录新建 `APPEND_SYSTEM_PROMPT.md`（正文即追加进 system prompt 的行为引导，写法见 `wiki help append`）；想定写门控 → 在该目录 AGENTS.md 写「## 门控」节（写法见 `wiki help agents`）。

## 5. 主动知识记录（分类自定义规则驱动）

本 skill 本身不写死任何场景的「主动记录」规则。行为由各分类目录的
`APPEND_SYSTEM_PROMPT.md`（system prompt 注入文件）决定：

- **本宿主的落地方式**：DSH/pi 形态由插件每轮（pi 每回合）注入 system prompt；
  **skill 形态没有注入钩子**，所以规则靠两条路到达：
  1. **开工先跑 `wiki rules`**（不带参数）——一次性载入全部 APPEND 规则全文；
  2. `wiki get` / `wiki create` / `wiki update` 的**响应末尾自动附带**该目录生效规则
     （行为规则 + AGENTS.md 门控），所以即使忘了第 1 步，读写时也一定会看到。
- 做某分类相关工作前，若该目录（或其祖先）有 `APPEND_SYSTEM_PROMPT.md`，
  其正文即该分类的追加行为规则——**照做**（例：sql 目录要求「用了库中
  不存在的表 → 自动建 Table；踩坑 → 直接记 Pitfall；新口径先确认后建 Metric」）。
- `SKILL.md` 与本 skill 只负责通用流程（rules→list→search→get→create）；具体
  「什么场景自动记、什么场景先确认」以各目录规则为准。
- 通用兜底（某分类无任何规则时）：检索未命中若确属缺失知识 → 可建概念
  补录；任务收尾可 `wiki lint` 看断链/缺失清单。

## 6. 写入规范（门控与 trust）

- **写前先 `wiki rules <目标目录>`**：看该目录 AGENTS.md 规则是否要求 human 确认。
- 需确认的（如口径类）：先向用户确认，用户同意后加 `--confirmed`（并把 `WIKI_USER` 设为用户名），写入会带 `verified: [{by: human:<user>}]`。
- 探查事实（表结构等）：可直接 `wiki create`（自动写 `generated: {by: agent…}`，无 verified = unverified 态，可消费但标未确认）。
- frontmatter 只用 OKF 字段：`type`(必填) / `title` / `description` / `tags` / `sources` / `generated` / `verified` / `status` / `stale_after`；Attested Computation 用 `runtime`/`parameters`/`computation`/`executor`/`attester`。**不引入自定义字段**。字段格式细节查 `wiki help frontmatter`。
- 分工：`generated`/`verified` 由 confirmed 自动维护（一般不用手写）；`sources`/`stale_after`/`status` 按需手写。
- 正文引用相关概念用 markdown 链接 `/path.md` 或 `[[wiki-link]]`；读到引用即代表关系。

## 7. 数据与格式约定

- bundle 结构：`index.md`/`log.md`/`AGENTS.md` 是保留文件（不作概念）；其余 `.md` 都是概念。
- 概念 = YAML frontmatter（`type` 必填）+ markdown 正文；`# Schema` 放字段清单、`# Computation` 放口径 SQL、`# Gotchas` 放表级坑。
- 过期：`stale_after`（绝对时刻）；停用：`status: deprecated`；零删除，可恢复。
- 目录规则：AGENTS.md 向上遍历、子目录覆盖父目录——`wiki rules DIR` 可查生效结果。

## 8. 坑与边界

- 断链不是错误：`[[未写概念]]` 代表尚未写入的知识，lint 归集提示，不必修。
- 数据目录若不存在，先 `wiki list` 会报错——此时用 demo bundle 参考或先 `wiki ingest` 建第一个概念。
