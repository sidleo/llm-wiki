# dsh-wiki — DSH 插件（llm-wiki 知识库）

为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 提供的
llm-wiki 通用知识库插件：**内嵌 vendor-core，与 pi 扩展 / skill CLI 同一实现**（`packages/dsh/scripts/sync-vendor.mjs` 从 `packages/core` 同步），
读写同一份 OKF v0.2 bundle（默认 `~/.agents/wiki`）。

## 安装

```bash
# 从 npm（发布后）
dsh plugin --profile web add @sidleo3/dsh-wiki

# 本地开发（源码目录）
dsh plugin --profile web add link:/path/to/packages/dsh
```

> 修改 profile 组合后需**重启 `dsh web`** 生效。

## 能力

- **注入分两层**（可选宿主优化；`system-prompt/assemble` 瀑布，apply 同步注册，异步读盘不外抛）：
  - **恒定层**：工具用法 + 【硬要求】第一步先 `wiki_list`，作为 system prompt section
    （`sectionOrder: 62`）注入。文本是模块级常量——任何会话 / 任何 bundle 分支 / 任何用户
    逐字节相同，所以注入内容永远不会打断提供方的前缀缓存。
  - **会话层**：当前 bundle（名 + 路径）+ 目录清单 + 各目录 `APPEND_SYSTEM_PROMPT.md` 规则，
    走 **runtime context 快照**（宿主追加在会话尾部，内容未变则不产生新消息；切换分支 /
    改规则才更新一条）。放进 system prompt 的代价是一字节变化就得重发整份 prompt，
    在目标续跑等请求序列边界上更是整段前缀作废——故不放。
  - **概念计数不参与注入**（每次写入都变的高频源），目录树与分支清单按需用
    `wiki_list` / `wiki_dirs` 获取。
- **14 个工具**：`wiki_list` / `wiki_search` / `wiki_get`（附 backlinks）/ `wiki_create` /
  `wiki_update` / `wiki_validate` / `wiki_lint` / `wiki_ingest` / `wiki_deprecate` /
  `wiki_rules` / `wiki_help`（机制文档自助查）/ `wiki_dirs` / `wiki_use` / `wiki_sync`。
- **两种在线后端（同一 `wiki_sync` 入口按 kind 分派）**：
  - 本地目录 bundle → Git 远端（`git.mjs`：status/sync/init/clone，绝不 force push）；
  - 飞书云盘库 bundle（`kind:'feishu'`，云盘文件夹里存原生 `.md`）→ `lark-cli`（`feishu.mjs`：
    status/sync/pull/push/init，三方状态增量、只推改动文件、永不删两端、冲突停下报清单）。
- **图形化配置（设置 → 插件 → 插件配置）**：注册设置命名空间 `dsh-wiki`（空 schema，仅作卡片
  可见性钥匙），浏览器半 `lib/client.js` 按 key = 命名空间注册卡片，三区：命名目录管理 /
  在线同步（按后端显示 Git 或飞书状态）/ 体检与索引；命名目录新增时可选「本地目录 / 飞书云盘库」，
  并支持一键在飞书新建文件夹并注册。**运行参数不提供界面编辑**（部署级配置，改 profile 的 `cordis.patch.yml`）。
  宿主半另注册 `/api/dsh-wiki/*` RPC（卡片只走这些端点）。**卡片可见性依赖命名空间注册**：
  宿主「插件配置」Tab 只渲染「已服务命名空间 ∩ 已注册卡片」。
- **多目录（命名 bundle）**：注册多个 wiki 目录并切换。`wiki_dirs` 查看分支；
  `wiki_use <name>` 会话级切换（按对话隔离，仅当前对话生效），`global: true`
  持久化为全局默认（写注册表 `~/.agents/wiki-registry.json`，新会话与 CLI/pi 生效）。
- **门控**：写入前读目标目录 AGENTS.md 规则（`wiki_rules`），需 human 确认的类型经
  agent 交互确认后带 `verified`（无代码强制弹窗；格式仍是纯 OKF）。

## 配置

数据目录默认 `~/.agents/wiki`；用 id 定向补丁覆盖：

```yaml
# cordis.patch.yml（profile 层）
- id: wiki-registry
  config:
    dataDir: /absolute/path/to/bundle
    sectionName: wiki-registry
    sectionOrder: 62
    maxSectionChars: 6000
    contextOrder: 130
    maxContextChars: 12000
    maxGetChars: 40000
    cacheTtlMs: 30000
```

多目录：`config.dataDirs` 声明命名 bundle（与注册表 `~/.agents/wiki-registry.json`
合并，同名配置优先）：

```yaml
  config:
    dataDirs:
      工作: /absolute/path/to/bundle-a
      个人: ~/notes/wiki
```

切换：`wiki_use <name> [global:true]`（会话级/持久化全局默认），`wiki_dirs` 查看。
也可以直接编辑注册表 `~/.agents/wiki-registry.json`：

```json
{ "bundles": { "工作": "/abs/path/a", "个人": "~/notes/wiki" }, "active": "工作" }
```

## 开发与测试

```bash
node --check wiki.mjs
node tests/dsh-mock-test.mjs        # 宿主无关 mock：14 工具注册 + 注入分层 + 门控 + 多目录 + 同步诊断（33 项）
node --test tests/dsh-config-test.mjs       # 配置卡片宿主半：设置命名空间 + /api/dsh-wiki/* + 飞书分派（10 项）
node --test tests/feishu-backend.test.mjs   # 飞书云盘后端（假 lark-cli，12 项）
node --test tests/dsh-client-bundle-test.mjs # 卡片产物契约 + jsdom 渲染（5 项）

# 浏览器半构建（改 src/client/ 后必须重跑）
npm install && npm run build        # 产出 lib/client.js（tsdown，banner = __ModuleLoader__.load）
npm run typecheck                   # tsc --noEmit

# 本地迭代：profile 用仓库目录替换 registry 版本（改 host 半需重启 dsh web）
dsh plugin --profile web add link:/path/to/packages/dsh
```

## 依赖

宿主半运行时自包含（vendor-core 内嵌，`npm run sync-vendor` 从仓库 `packages/core` 同步）；独立引用 core 可用 `@sidleo3/llm-wiki-core`。浏览器半额外依赖 `schemastery`（宿主半注册设置命名空间的 schema；缺失时插件照常工作，只是卡片不出现）与 React（平台基线模块，构建期 external，运行时由 loader 提供）。

## 许可

MIT
