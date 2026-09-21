---
name: wiki
version: 0.6.3
description: >-
  使用 Codex 插件的 llm-wiki 工作知识库（OKF v0.2 markdown bundle）检索与沉淀知识。
  当任务要引用既有事实或结构（表、字段、接口、清单、术语、组织）、遵守既有约定或口径
  （指标算法、命名、流程、权限、过滤范围）、按既有做法执行（写 SQL、写代码、配环境、出报表、发布）、
  排查数据或结果不一致、复盘踩坑，或用户提到「按我们的规定」「上次那个坑」「库里的口径」
  「知识库」「llm-wiki」「OKF」时，先查库再回答或动手。也负责把探查结论、业务规则和坑点主动写回库。
---

# llm-wiki Codex Skill

本插件把同一个 OKF v0.2 知识库 bundle 接到 Codex，提供 14 个 `wiki_*` MCP 工具
（Codex 可能显示为 `mcp__wiki__wiki_*`，指向同一个工具）。数据目录默认
`~/.agents/wiki`，多目录注册表与 DSH、Pi、MCP、Skill 四种形态共用。

## 硬要求

1. 要做知识相关工作时，第一步先调用 `wiki_list` 看目录树与概念全貌，再按需
   `wiki_search`、`wiki_get`。不要凭记忆猜表结构、字段、指标口径或既有流程。
2. 读到的规则和坑点是约束。命中 Pitfall 时先按记录规避；口径、流程有冲突时，
   说明冲突并请用户确认，不要静默采用。
3. 写入前先调用 `wiki_rules <目标目录>`。目录链上的 AGENTS.md 若要求 human 确认，
   先向用户展示拟写内容并取得同意，再以 `confirmed: true` 写入。
4. 概念 frontmatter 只用 OKF 字段，不造自定义字段。`generated` / `verified`
   通常由 `confirmed` 自动维护。

## 检索流程

1. `wiki_list`：无参数看全貌；`type` / `status` 可选过滤。
2. `wiki_search`：先用任务里的业务词、表名、字段名、指标名或坑点关键词搜索。
3. `wiki_get`：读取命中的完整正文；响应自带 backlinks，优先继续查看引用它的坑点与口径。
4. 没命中并不等于没有事实。若这是需要实际探查的问题，先执行可验证的只读探查，
   再把结论写回；不要为了“有结果”编造知识。

## 主动记录

- 用到库里没有、且已通过实际探查确认的表/接口/系统/术语 → `wiki_create`，通常 type `Table` 或 `Reference`。
- 踩坑并查到根因 → `wiki_create`，type `Pitfall`，把触发条件与规避方式写清。
- 与用户确认过的新口径 → type `Metric` 或 `Attested Computation`，带 `confirmed: true`。
- 相关概念用 markdown 链接（`/path.md` 或 `[[wiki-link]]`）交叉引用；断链表示尚未写入，不影响保存。

## 维护与多目录

- `wiki_validate` 检查 OKF 合规；`wiki_lint` 看断链、孤儿页、过期与缺索引。
- `wiki_dirs` 查看命名 bundle；`wiki_use` 切换当前 MCP 进程的默认库，`global: true` 写全局默认。
- `wiki_help` 可查 frontmatter、AGENTS.md 门控、APPEND_SYSTEM_PROMPT.md、bundle 与同步说明。
- `wiki_sync` 按后端分派：本地 bundle 走 Git，飞书云盘库走 lark-cli。冲突必须停下处理，绝不覆盖或 force push。

## 规则注入

插件 hook 会在会话开始注入当前 bundle、目录清单和各目录 APPEND_SYSTEM_PROMPT.md；
规则修改后，下一轮用户提交会自动刷新。MCP `instructions` 还会提供固定工具引导。
即使注入失败，也必须通过 `wiki_rules` 主动读取适用规则。
