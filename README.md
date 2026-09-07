# llm-wiki —— 纯 OKF v0.2 + llm-wiki 范式的通用知识库

一个开源、通用、agent-first 的知识库项目：**格式层严格遵守 [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)，运维层采用 [Karpathy 的 llm-wiki 范式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)**（ingest/query/lint + index/log），交付三种消费形态，共用同一核心库与同一份数据 bundle。

设计三条铁律：

1. **必须遵守 OKF**（官方 v0.2 SPEC）。
2. **以 llm-wiki 为主**——能被 OKF/llm-wiki 原生替代的能力一律不保留旧设计。
3. **通用性优先**——不绑定任何业务；本地私有知识仅作迁移输入与脱敏测试样例，不进仓库。

## 仓库结构

```
llm-wiki/
├── schema.md               # 格式规范唯一事实源（OKF v0.2 对齐）
├── SPEC-EXTENSIONS.md      # 对 OKF 的扩展声明（AGENTS.md / APPEND_SYSTEM_PROMPT.md 保留文件）
├── packages/
│   ├── core/               # 共享核心：解析/链接图/检索/校验/lint/index-log/规则解析/migrate
│   ├── dsh/                # DSH 插件 → npm @sidleo3/dsh-wiki
│   ├── pi/                 # pi 扩展 → npm pi-wiki
│   └── skill/              # skill 版 → SKILL.md + CLI `wiki`
├── examples/demo-bundle/   # 脱敏合成示例 bundle（Obsidian 可直接打开）
├── scripts/                # migrate.mjs / smoke-test.mjs
├── tests/fixtures/         # 合成测试数据
└── obsidian/               # Obsidian 模板 / Dataview 查询示例
```

## 三种消费形态

| 形态 | 安装 | 能力 |
|------|------|------|
| DSH 插件 | `dsh plugin --profile web add @sidleo3/dsh-wiki` | 每轮描述层注入（可选优化）+ `wiki_*` 工具 |
| pi 扩展 | `pi install npm:pi-wiki` | `wiki_*` 工具 + prompt 引导 |
| skill + CLI | `~/.agents/skills/wiki/`（见 packages/skill/INSTALL.md） | SKILL.md 引导 + `wiki` CLI（任意 agent 可用） |

三形态读写**同一份 bundle**、行为一致——都复用 `packages/core`，无重复实现。

## 工具（11 个）

`wiki_list` · `wiki_search` · `wiki_get`（附 backlinks）· `wiki_create` · `wiki_update` · `wiki_validate` · `wiki_lint` · `wiki_ingest` · `wiki_deprecate` · `wiki_rules` · `wiki_help`

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
node scripts/smoke-test.mjs              # 27 项：core 工具链 + ingest/lint/migrate 端到端
node tests/dsh-mock-test.mjs             # 16 项：DSH 插件（mock 宿主）工具注册 + 描述层 + 门控
(cd packages/pi && npm install --legacy-peer-deps && npm test)   # 11 项：pi 扩展（mock pi）
node --test tests/three-forms.test.mjs   # 4 项：三形态读写同一 bundle 一致性
```

## 迁移旧 dsh-kb / dsh-sqlkb 数据

```bash
node scripts/migrate.mjs --dry-run        # 预览（copy，不 move，不删源）
node scripts/migrate.mjs --real           # 执行 → 默认 ~/.agents/wiki
```

迁移输出自动转成 OKF v0.2 合规概念（kb → Reference/口径…，sqlkb tables → Table、
examples → Attested Computation、pitfalls → Pitfall），可用 `wiki validate` 复核。

## 许可

MIT
