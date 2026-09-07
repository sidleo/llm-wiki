# llm-wiki 格式规范（OKF v0.2 对齐）

> 本文是知识 bundle 的**格式规范唯一事实源**。格式层严格遵守
> [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)，
> 本文件只做落地约定说明，不新增任何 OKF 之外的自定义 frontmatter 字段。
> 唯一的项目级扩展是 `AGENTS.md` 与 `APPEND_SYSTEM_PROMPT.md` 作为保留文件，见 [SPEC-EXTENSIONS.md](SPEC-EXTENSIONS.md)。

## 1. Bundle

一个 **knowledge bundle** 是自包含、可分层、以 git 分发的 markdown 目录树。

```
<dataDir>/                     # 默认 ~/.agents/wiki，可配置覆盖
├── index.md                   # 保留：目录索引（渐进披露入口）
├── log.md                     # 保留：时间线（ISO-8601 日期标题，最新在前）
├── AGENTS.md                  # 保留（本项目扩展）：bundle 级规则
├── APPEND_SYSTEM_PROMPT.md      # 保留（本项目扩展）：bundle 级 system prompt 注入
├── <领域>/                    # 目录自由分层，路径即分组
│   ├── AGENTS.md              # 可选：该目录规则（缺失时向上遍历）
│   ├── APPEND_SYSTEM_PROMPT.md  # 可选：该目录自定义注入（描述层并入 system prompt）
│   ├── index.md               # 可选：该目录索引
│   └── <concept>.md           # 概念文档
```

## 2. 保留文件（reserved files）

| 文件名 | 用途 |
|--------|------|
| `index.md` | 目录索引。无 frontmatter（bundle 根可带 `okf_version`）。正文=分组标题 + 链接列表 |
| `log.md` | 变更历史。日期标题 `YYYY-MM-DD`，最新在前。条目形如 `* **Update**: …` |
| `AGENTS.md` | **本项目扩展**：该目录（子树）的 agent 规则。无 frontmatter、不作 concept、不参与 OKF type 校验。见 SPEC-EXTENSIONS.md |
| `APPEND_SYSTEM_PROMPT.md` | **本项目扩展**：该目录用户自定义的 system prompt 追加内容。无 frontmatter、不作 concept。描述层每轮并入。见 SPEC-EXTENSIONS.md |

保留文件**不得**用作概念文档；其余所有 `.md` 都是 concept。

## 3. Concept 文档

每个 concept = UTF-8 markdown 文件，由两部分组成：

1. **YAML frontmatter**（`---` 分隔）
2. **markdown body**（正文）

### 3.1 frontmatter 字段

```yaml
---
type: <Type name>                  # REQUIRED，唯一强制字段
title: <display name>             # 推荐：缺省从文件名推导
description: <one-line summary>   # 推荐：进 index 条目与检索摘要
resource: <canonical URI>         # 可选：底层资产 URI（表→中台地址）
tags: [tag1, tag2]                # 可选：跨域标注（YAML 列表）
# 来源族
sources:
  - id: <stable key>              # 可选：供正文 [^id] 脚注引用
    resource: <URI or scope>      # REQUIRED（条目内）
    title: <label>
    author: <actor>
    usage_count: <int>
    last_modified: <ISO 8601>
# 信任族
generated: { by: <actor>, at: <ISO 8601> }
verified: [{ by: <actor>, at: <ISO 8601> }]   # 或单映射 {by, at}
# 生命周期族
status: stable                     # draft | stable | deprecated，缺省 stable
stale_after: <ISO 8601>            # 可选：绝对过期时刻
# Attested Computation 族（type: Attested Computation 时）
runtime: bigquery                  # REQUIRED：bigquery/postgres/dbt/python…
parameters: [{name, type, required}]   # 可选
computation: <path>                # 可选：指向计算文件，替代正文 # Computation
executor: { resource, receipt: [fields] }
attester: { resource }
# … 其他 producer 自定义键（消费方须容忍并 round-trip 保留）
---
```

### 3.2 Actor 约定

- agent/工具：`<producer>/<version>`，如 `llm-wiki/0.1.0`
- 人：`human:<id>`（trust 分级按 `human:` 前缀）
- 进程：`process:<id>`

### 3.3 正文常规标题

| 标题 | 用途 |
|------|------|
| `# Schema` | 结构化字段清单（表/API/数据集） |
| `# Examples` | 用法示例（fenced code block） |
| `# Computation` | Attested Computation 的计算体（唯一 fenced code block） |
| `# Gotchas` / `# Constraints` | 坑点（表级坑直接写这里） |

来源引用：正文用 `[^id]` 脚注，label 键到 `sources[].id`。

### 3.4 常用 type 约定

| type | 用途 | 关键字段/正文 |
|------|------|--------------|
| `Table` | SQL 表/数据集 | `resource` 指中台；`# Schema` 字段清单 |
| `Attested Computation` | 参数化口径计算 | `runtime`/`parameters`/`# Computation`（或 `computation` 指向文件）/`executor`/`attester` |
| `Pitfall` | 跨表/口径级坑点 | 正文链接相关 Table/Computation |
| `Reference` | 概念/经验/笔记/口径文档 | 自由 |
| `Playbook` / `Metric` | 流程 / 指标定义 | OKF 常规用法 |

type 值**不注册中心**、可自定义、consumer 容忍未知值。

## 4. 交叉链接

概念间用标准 markdown 链接互相引用，两种形式：

- **绝对（bundle 相对）**：以 `/` 开头，相对 bundle 根解析。**推荐**（文档移动不失效）。
- **相对**：标准 markdown 相对路径。

链接表达「有关系」，具体种类（引用/join/依赖…）由正文措辞承载，链接本身不带类型。graph consumer 把链接当作无类型有向边。

**Consumers MUST tolerate broken links**：指向不存在目标的链接不是畸形——可能代表尚未写入的知识（lint 归集为「提及但无独立页」）。

本项目同时接受 Obsidian 风格 `[[wiki-link]]`，由 core 归一化为 bundle 相对路径（链接解析等价），以便 Obsidian graph view 直接可用。

## 5. 合规判据（wiki_validate）

OKF v0.2 合规 = 全部满足：

1. 每个非保留 `.md` 文件含可解析 YAML frontmatter
2. 每个 frontmatter 含非空 `type`
3. 保留文件符合既定结构（index/log/AGENTS.md/APPEND_SYSTEM_PROMPT.md）

**不得**因以下原因拒绝 bundle（只 lint warn）：

- 缺可选 frontmatter 字段
- 未知 `type` 值
- 未知额外 frontmatter 键
- 断链
- 缺 `index.md`

## 6. 过期与生效

- **过期**：`stale_after`（绝对 ISO 8601 时刻），`now >= stale_after` 即过期；配合 `generated.at` 判断「多久没更新」。只提示不替探查。
- **停用**：`status: deprecated`，概念级；数据零删除，可恢复。目录级批量用 `wiki_deprecate <path>`。
- `draft`：未评审/可能不完整；`stable`：缺省；`deprecated`：保留供链接与历史，不再推荐使用。

## 7. 目录规则（AGENTS.md）

对任意目录 D 或 concept 所在目录，生效规则 = 从 D 向上遍历到 bundle 根**取最近的 `AGENTS.md`**；存在多条时**逐级叠加、子目录覆盖父目录**（最近优先）。core 的 `resolveRules(dir)` 返回从根到叶的有序规则列表，三形态共用。规则正文可含门控约定（如「`Attested Computation` 写入前需 human 确认」），写入门控按它执行。
