# llm-wiki —— 纯 OKF v0.2 Markdown 的通用 Agent 知识库

[English](README.md) · [简体中文](README.zh-CN.md)

一个开源、通用、agent-first 的知识库项目：**格式层严格遵守 [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)**，运维层采用 [Karpathy 的 llm-wiki 范式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)（ingest / query / lint + index / log），交付三种消费形态，共用同一核心库与同一份数据 bundle。

## 设计原则

1. **严格遵循 OKF v0.2**——官方规范是格式层的唯一事实源；零自定义 frontmatter 字段，消费层零魔法特性。
2. **通用、与业务无关**——不绑定任何领域或场景；同一份 bundle 任何 agent 都可读写。

## 特性

- **渐进披露**——每轮会话注入工具引导与当前 bundle / 分类清单；先 `wiki_list` 看全貌，再检索、再深入。
- **真实交叉链接 + 自动 backlinks**——概念用 Markdown 链接互相关联；读取一个概念时自动附带引用它的坑点与规则。
- **目录级规则（`AGENTS.md`）**——每个目录可定义写入门控（哪些概念类型需 human 确认）与行为约定，向上遍历取最近、子目录覆盖父目录。
- **目录级提示词注入（`APPEND_SYSTEM_PROMPT.md`）**——每个分类可自定义行为规则。DSH 形态走运行时上下文快照（会话尾部，分支或规则变了才更新一条）；pi 形态加载期读一次。两者都不放进 system prompt，避免注入内容打断前缀缓存。
- **生命周期**——`stale_after` 过期、`status: deprecated`（概念级）与目录级批量停用、自动维护 `index.md` / `log.md`。
- **校验与体检**——`wiki_validate`（OKF 合规）与 `wiki_lint`（断链、孤儿页、过期、缺 index）。
- **多目录（命名 bundle）**——注册多个 wiki 目录为命名分支，可切换（会话级或全局持久）。
- **在线知识库（两种后端）**——同一个 `wiki_sync` / `wiki sync` 入口，按 bundle 后端自动分派：
  - **本地目录 + Git 远端**：提交→拉取合并→推送，多机/多人协作；**绝不 force push**。
  - **飞书云盘库**：内容存在飞书云空间的文件夹里，就是**一组原生 `.md` 文件**（OKF 格式零损失），经 `lark-cli` 文件级增量读写；人在飞书里浏览/下载，agent 负责读与写。
  两种后端同一套冲突规则：`index.md` 本地重生成、`log.md` 取并集（不阻塞）；概念 / `AGENTS.md` 两侧都改则**停止同步并报清单**，绝不自动覆盖。飞书后端**永不删除两端文件**（删除只报告）。
- **图形化配置（DSH Web GUI）**——设置 → 插件 → 插件配置里的 llm-wiki 卡片：命名目录增删/改名/设默认、在线同步状态与一键同步/初始化/克隆、体检（validate/lint 计数 + 重建 index）。运行参数属部署级配置（profile 的 `cordis.patch.yml`），卡片刻意不提供编辑。

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
- **渐进披露**——从注入的 bundle/分类清单 → `wiki_list` → `wiki_search` → `wiki_get`。

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
| DSH 插件 | `dsh plugin --profile web add @sidleo3/dsh-wiki` | 注入分层（恒定 section + 会话快照，可选优化）+ `wiki_*` 工具 |
| pi 扩展 | `pi install npm:@sidleo3/pi-wiki` | `wiki_*` 工具 + prompt 引导 |
| skill + CLI | `~/.agents/skills/wiki/`（见 packages/skill/INSTALL.md） | SKILL.md 引导 + `wiki` CLI（任意 agent 可用） |

三形态读写**同一份 bundle**、行为一致——都复用 `packages/core`，无重复实现。

## 工具（14 个）

`wiki_list` · `wiki_search` · `wiki_get`（附 backlinks）· `wiki_create` · `wiki_update` · `wiki_validate` · `wiki_lint` · `wiki_ingest` · `wiki_deprecate` · `wiki_rules` · `wiki_help` · `wiki_dirs` · `wiki_use` · `wiki_sync`

### 在线知识库（Git 远端同步）

```bash
# 已有本地 bundle：挂远端并首推（--name 同时注册为命名目录）
wiki sync init --remote git@host:group/wiki.git --name 团队库 --use

# 新机器：克隆并注册
wiki sync clone git@host:group/wiki.git ~/Documents/llm-wiki --name 团队库 --use

# 日常：先看状态，再同步（提交本地改动 → 拉取合并 → 推送）
wiki sync status
wiki sync --message "永辉口径补充"
```

冲突策略：`index.md`（派生文件）同步时按目录树重新生成；`log.md`（追加式）按日期块取并集；概念 / `AGENTS.md` / `APPEND_SYSTEM_PROMPT.md` 属人工撰写内容，冲突时同步停止、报冲突清单并把工作区恢复到同步前（本地提交保留），人工解决后重跑即可。凭证交给 git（SSH agent / credential helper），本工具不保存 token，也绝不 force push。详见 `wiki help sync`。

### 飞书在线知识库（云盘文件夹 + 原生 .md）

```bash
# 把现有本地库复刻成一个飞书在线库（默认 dry-run，--apply 才执行；copy 不 move）
node scripts/migrate-to-feishu.mjs --from ~/Documents/llm-wiki --name 飞书库 --new-folder 永辉知识库 --apply

# 或者：在「我的空间」新建文件夹并注册
wiki sync init --new-folder 永辉知识库 --name 飞书库 --use
# 挂已有文件夹 / 另一台机器
wiki sync init --folder-token https://feishu.cn/drive/folder/fldcnXXXX --name 飞书库

# 日常
wiki sync status          # 待推送 / 待拉取 / 两侧都改 / 远端已删
wiki sync                 # 推本地改动 + 拉远端改动（只传改动文件）
```

三方状态判定（本地缓存里的 `.wiki-cloud.json` 记录每文件的 fileToken、远端 modified_time、本地 mtime/size）：只有一侧变就单向传；两侧都变就停下来报冲突。拉取覆盖本地前会先备份到 `.backup/<时间戳>/`。依赖 `lark-cli` 已登录（`lark-cli auth login`）；详见 `wiki help feishu`。

### 图形化配置（DSH Web GUI）

设置 → 插件 → 插件配置 → llm-wiki 卡片（ADR：宿主按「已服务设置命名空间 ∩ 已注册卡片」渲染，卡片 key = `dsh-wiki`）：

| 区块 | 能改什么 | 落到哪 |
|------|----------|--------|
| 命名目录 | 增删/改名/设默认 | `~/.agents/wiki-registry.json`（与 CLI/pi 共享，删除只摘注册不动数据） |
| 在线同步 | 按后端显示：Git（远端/分支/领先落后）或飞书（待推送/待拉取/冲突/文件夹链接）+ 同步/拉取/推送/初始化/克隆 | 走 core `git.mjs` / `feishu.mjs`，与 `wiki_sync` 同一实现 |
| 命名目录 | 新增类型可选「本地目录」或「飞书云盘库」（可一键在飞书新建文件夹并注册） | `~/.agents/wiki-registry.json`（飞书条目为对象形态：kind/folderToken/cacheDir） |
| 体检与索引 | validate/lint 计数与明细、重建 index | core `validateBundle`/`lintBundle`/`refreshIndex` |

（运行参数不在卡片里：数据目录、注入 section 名/order、各上限、缓存 TTL 都是部署级配置，改 profile 的 `cordis.patch.yml`。）

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
node tests/dsh-mock-test.mjs             # 33 项：DSH 插件（mock 宿主）工具注册 + 注入分层 + 门控 + 多目录 + 同步诊断
node --test tests/dsh-config-test.mjs    # 9 项：配置卡片宿主半（设置命名空间 + /api/dsh-wiki/* 路由）
node --test tests/git-sync.test.mjs      # 8 项：Git 远端同步（顺序写/并发 log/index 冲突/概念冲突/错误路径）
node --test tests/feishu-backend.test.mjs # 12 项：飞书云盘后端（三方差异/只推改动/冲突停止/log 并集/argv 安全黑名单）
node --test tests/dsh-client-bundle-test.mjs   # 5 项：卡片产物契约 + jsdom 渲染冒烟
(cd packages/pi && npm install --legacy-peer-deps && npm test)   # 13 项：pi 扩展（mock pi）
node --test tests/three-forms.test.mjs   # 5 项：三形态读写同一 bundle 一致性
```

## 许可

MIT