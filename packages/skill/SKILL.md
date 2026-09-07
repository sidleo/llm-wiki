---
name: wiki
version: 0.1.0
description: >-
  llm-wiki 通用知识库（OKF v0.2 格式 + llm-wiki 运维范式）。读写同一份
  markdown knowledge bundle（表结构/口径计算/坑点/指标等概念，带 frontmatter
  type 与真实交叉链接），通过 `wiki` CLI 完成 list/search/get/create/update/
  validate/lint/ingest/deprecate。当用户提到 llm-wiki、OKF、Open Knowledge
  Format、知识库 bundle、agent knowledge、表口径文档、SQL 知识库，或需要
  检索/记录工作环境中的表结构与口径经验时使用。
metadata:
  requires:
    bins: ["wiki"]
  cliHelp: "wiki --help"
  bundle-format: "OKF v0.2 (https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)"
  data-dir-default: "~/.agents/wiki（可用 --dataDir 或 WIKI_DATA_DIR 覆盖）"
---

# llm-wiki Skill

一个知识库（OKF v0.2 + llm-wiki 范式）的通用访问层。**格式与数据是唯一事实**：任何 agent（本 skill 只是其中之一）都能读写同一 bundle。

## 1. 何时使用本 Skill

以下场景应使用本 skill：

- 需要检索/查询工作环境的知识库（表结构、字段、口径、坑点、指标、流程）
- 用户提到「知识库」「表口径」「这个表怎么查」「踩过的坑」等，且存在 `~/.agents/wiki`（或 `WIKI_DATA_DIR`）bundle
- 需要把新的源资料/经验写入知识库（create / ingest）
- 需要体检知识库（validate / lint）或停用整块知识（deprecate）

## 2. 前置条件

1. `wiki` CLI 已安装且可用（`metadata.requires.bins: ["wiki"]`）。安装：将 `packages/skill/bin/wiki.mjs` 软链/复制为 PATH 中的 `wiki`。
2. 默认数据目录 `~/.agents/wiki`；其他路径用 `--dataDir DIR` 或 `WIKI_DATA_DIR`。
3. 若目录不存在或为空，可用 demo bundle 参考结构：仓库 `examples/demo-bundle/`。

## 3. 标准链路（渐进披露）

与 llm-wiki 的 index.md 渐进披露一致——**先看全貌，再按需取明细**：

1. `wiki list [--dataDir DIR]` —— 目录树与全部概念（type/title/id）
2. `wiki search <关键词> [--type T] [--tag TAG]` —— 关键词检索（匹配 frontmatter + 正文）
3. `wiki get <id 或 title>` —— 读单个概念全文，**自动附 backlinks（谁引用了它 → 相关坑点/概念自然出现）**
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
| `wiki rules DIR` | 查看该目录生效的 AGENTS.md 规则（含向上遍历结果） |
| `wiki help [主题]` | 查机制文档：quickstart｜files｜agents（怎么写 AGENTS.md）｜append（怎么写 APPEND_SYSTEM_PROMPT.md）｜frontmatter｜gate |

想给某分类加行为规则 → 在该目录新建 `APPEND_SYSTEM_PROMPT.md`（正文即追加进 system prompt 的行为引导，写法见 `wiki help append`）；想定写门控 → 在该目录 AGENTS.md 写「## 门控」节（写法见 `wiki help agents`）。

## 5. 主动知识记录（分类自定义规则驱动）

本 skill 本身不写死任何场景的「主动记录」规则。行为由各分类目录的
`APPEND_SYSTEM_PROMPT.md`（system prompt 注入文件）决定：

- 做某分类相关工作前，若该目录（或其祖先）有 `APPEND_SYSTEM_PROMPT.md`，
  其正文即该分类的追加行为规则——**照做**（例：sql 目录要求「用了库中
  不存在的表 → 自动建 Table；踩坑 → 直接记 Pitfall；新口径先确认后建 Metric」）。
- `SKILL.md` 与本 skill 只负责通用流程（list→search→get→create）；具体
  「什么场景自动记、什么场景先确认」以各目录注入规则为准。
- 通用兜底（某分类无任何注入规则时）：检索未命中若确属缺失知识 → 可建概念
  补录；任务收尾可 `wiki lint` 看断链/缺失清单。

## 6. 写入规范（门控与 trust）

- **写前先 `wiki rules <目标目录>`**：看该目录 AGENTS.md 规则是否要求 human 确认。
- 需确认的（如口径类）：先向用户确认，用户同意后加 `--confirmed`（并把 `WIKI_USER` 设为用户名），写入会带 `verified: [{by: human:<user>}]`。
- 探查事实（表结构等）：可直接 `wiki create`（自动写 `generated: {by: agent…}`，无 verified = unverified 态，可消费但标未确认）。
- frontmatter 只用 OKF 字段：`type`(必填) / `title` / `description` / `tags` / `sources` / `generated` / `verified` / `status` / `stale_after`；Attested Computation 用 `runtime`/`parameters`/`computation`/`executor`/`attester`。**不引入自定义字段**。
- 正文引用相关概念用 markdown 链接 `/path.md` 或 `[[wiki-link]]`；读到引用即代表关系。

## 7. 数据与格式约定

- bundle 结构：`index.md`/`log.md`/`AGENTS.md` 是保留文件（不作概念）；其余 `.md` 都是概念。
- 概念 = YAML frontmatter（`type` 必填）+ markdown 正文；`# Schema` 放字段清单、`# Computation` 放口径 SQL、`# Gotchas` 放表级坑。
- 过期：`stale_after`（绝对时刻）；停用：`status: deprecated`；零删除，可恢复。
- 目录规则：AGENTS.md 向上遍历、子目录覆盖父目录——`wiki rules DIR` 可查生效结果。

## 8. 坑与边界

- skill 无「每轮自动注入」：本 skill 靠你主动按标准链路走（先 list / index 再按需 get），这是平台物理边界。
- 断链不是错误：`[[未写概念]]` 代表尚未写入的知识，lint 归集提示，不必修。
- 数据目录若不存在，先 `wiki list` 会报错——此时用 demo bundle 参考或先 `wiki ingest` 建第一个概念。
