# llm-wiki —— 纯 OKF v0.2 Markdown 的通用 Agent 知识库

[English](README.md) · [简体中文](README.zh-CN.md)

一个开源、通用、agent-first 的知识库项目：**格式层严格遵守 [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)**，运维层采用 [Karpathy 的 llm-wiki 范式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)（ingest / query / lint + index / log），交付三种消费形态，共用同一核心库与同一份数据 bundle。

## 设计原则

1. **严格遵循 OKF v0.2**——官方规范是格式层的唯一事实源；零自定义 frontmatter 字段，消费层零魔法特性。
2. **通用、与业务无关**——不绑定任何领域或场景；同一份 bundle 任何 agent 都可读写。

## 特性

- **渐进披露**——每轮会话注入精简的知识库摘要；先 `wiki_list` 看全貌，再检索、再深入。
- **真实交叉链接 + 自动 backlinks**——概念用 Markdown 链接互相关联；读取一个概念时自动附带引用它的坑点与规则。
- **目录级规则（`AGENTS.md`）**——每个目录可定义写入门控（哪些概念类型需 human 确认）与行为约定，向上遍历取最近、子目录覆盖父目录。
- **目录级提示词注入（`APPEND_SYSTEM_PROMPT.md`）**——每个分类可自定义行为规则，正文原样追加进 agent 的 system prompt 每轮注入。
- **生命周期**——`stale_after` 过期、`status: deprecated`（概念级）与目录级批量停用、自动维护 `index.md` / `log.md`。
- **校验与体检**——`wiki_validate`（OKF 合规）与 `wiki_lint`（断链、孤儿页、过期、缺 index）。
- **多目录（命名 bundle）**——注册多个 wiki 目录为命名分支，可切换（会话级或全局持久）。

## Wiki 目录结构（bundle）

一个知识库 = OKF v0.2 bundle：任意目录树，每个概念是一个 Markdown 文件。

```
my-wiki/
├── index.md                  # 保留文件：目录索引（渐进披露入口；根可带 okf_version）
├── log.md                    # 保留文件：时间线变更历史
├── AGENTS.md                 # 保留文件：写入门控（「## 门控」节）与目录约定
├── APPEND_SYSTEM_PROMPT.md   # 保留文件（可选）：注入 agent prompt 的分类行为规则
├── tables/
│   ├── orders.md             # 概念：YAML frontmatter（type: Table）+ 正文
│   └── customers.md
└── pitfalls/
    └── join-inflation.md     # type: Pitfall，交叉链接回 tables/orders.md
```

- **概念** = 一个 `.md` 文件：OKF 合规 frontmatter（`type` 必填）+ markdown 正文；概念 id = 相对 bundle 根的路径（如 `tables/orders`）。
- **交叉链接**——用 `[label](/path.md)` 或 `[[wiki-link]]` 引用其他概念；读取一个概念时自动附带 backlinks（引用它的概念/坑点）。
- **保留文件**——任意层级只有 `index.md` / `log.md` / `AGENTS.md` / `APPEND_SYSTEM_PROMPT.md` 是特殊的；其余所有 `.md` 都是概念。
- **渐进披露**——从注入的摘要 → `wiki_list` → `wiki_search` → `wiki_get`。

## 仓库结构

```
llm-wiki/
├── schema.md               # 格式规范唯一事实源（OKF v0.2 对齐）
├── SPEC-EXTENSIONS.md      # 对 OKF 的扩展声明（AGENTS.md / APPEND_SYSTEM_PROMPT.md 保留文件）
├── packages/
│   ├── core/               # 共享核心：解析/链接图/检索/校验/lint/index-log/规则解析
│   ├── dsh/                # DSH 插件 → npm @sidleo3/dsh-wiki
│   ├── pi/                 # pi 扩展 → npm @sidleo3/pi-wiki
│   └── skill/              # skill 版 → SKILL.md + CLI `wiki`
├── examples/demo-bundle/   # 合成示例 bundle（Obsidian 可直接打开）
├── scripts/                # 开发辅助脚本
├── tests/fixtures/         # 合成测试数据
└── obsidian/               # Obsidian 模板 / Dataview 查询示例
```

## 三种消费形态

| 形态 | 安装 | 能力 |
|------|------|------|
| DSH 插件 | `dsh plugin --profile web add @sidleo3/dsh-wiki` | 每轮描述层注入（可选优化）+ `wiki_*` 工具 |
| pi 扩展 | `pi install npm:@sidleo3/pi-wiki` | `wiki_*` 工具 + prompt 引导 |
| skill + CLI | `~/.agents/skills/wiki/`（见 packages/skill/INSTALL.md） | SKILL.md 引导 + `wiki` CLI（任意 agent 可用） |

三形态读写**同一份 bundle**、行为一致——都复用 `packages/core`，无重复实现。

## 工具（13 个）

`wiki_list` · `wiki_search` · `wiki_get`（附 backlinks）· `wiki_create` · `wiki_update` · `wiki_validate` · `wiki_lint` · `wiki_ingest` · `wiki_deprecate` · `wiki_rules` · `wiki_help` · `wiki_dirs` · `wiki_use`

## 多目录（命名 bundle）

默认数据目录 `~/.agents/wiki`；要管理多个 wiki 目录，用「命名 bundle」注册与切换：

- **注册表**（跨三形态共用，默认 `~/.agents/wiki-registry.json`，env `WIKI_REGISTRY_FILE` 覆盖）：

  ```json
  { "bundles": { "工作": "/abs/path/a", "个人": "~/notes/wiki" }, "active": "工作" }
  ```

- **DSH 插件**也可在配置里声明式注册（与注册表合并、同名配置优先）：

  ```yaml
  - id: wiki-registry
    config:
      dataDirs:
        工作: /abs/path/a
        个人: ~/notes/wiki
  ```

- **切换**——`wiki_use <name> [global: true]`：DSH 宿主默认会话级（按对话隔离，仅当前对话生效）；`global: true` 持久化为全局默认（写注册表 `active`，影响新会话与 CLI/pi）。`wiki_dirs` 查看分支。CLI 用 `wiki dirs` / `wiki use NAME [--global]`，每条命令可 `--wiki NAME` 指定。
- 解析顺序（无显式 name）：注册表 `active`（若为已知名字）→ `default`（`dataDir` 兜底）。详见 `wiki help bundle`。

## 快速开始

```bash
# 1. 查看 demo bundle
node packages/skill/bin/wiki.mjs list --dataDir examples/demo-bundle

# 2. 校验 OKF 合规
node packages/skill/bin/wiki.mjs validate --dataDir examples/demo-bundle

# 3. 检索 + 读明细（backlinks 自动显示引用它的坑点/概念）
node packages/skill/bin/wiki.mjs search 销售额 --dataDir examples/demo-bundle
node packages/skill/bin/wiki.mjs get tables/orders --dataDir examples/demo-bundle

# 4. 用 Obsidian 打开 examples/demo-bundle 看 graph view 与 Dataview（见 obsidian/）
```

## 测试

```bash
node scripts/smoke-test.mjs              # 36 项：core 工具链 + 注册表 + ingest/lint 端到端
node tests/dsh-mock-test.mjs             # 26 项：DSH 插件（mock 宿主）工具注册 + 描述层 + 门控 + 多目录
(cd packages/pi && npm install --legacy-peer-deps && npm test)   # 13 项：pi 扩展（mock pi）
node --test tests/three-forms.test.mjs   # 5 项：三形态读写同一 bundle 一致性
```

## 许可

MIT