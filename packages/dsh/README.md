# dsh-wiki — DSH 插件（llm-wiki 知识库）

为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 提供的
llm-wiki 通用知识库插件：**内嵌 vendor-core，与 pi 扩展 / MCP 服务端 / skill CLI 同一实现**（`packages/dsh/scripts/sync-vendor.mjs` 从 `packages/core` 同步），
读写同一份 OKF v0.2 bundle（默认 `~/.agents/wiki`）。

## 安装

```bash
# 从 npm（发布后）
dsh plugin --profile web add @sidleo3/dsh-wiki

# 本地开发（源码目录）
dsh plugin --profile web add link:/path/to/packages/dsh
```

> 修改 profile 组合后需**重启 `dsh web`** 生效。

## 兼容性（DSH 版本）

已核对版本：**0.1.7-rc.2**（开发基线）、**0.2.0-rc.1** 与 **0.2.1-rc.2**（复核，桌面版实测加载：14 个 `wiki_*` 工具可用、system prompt 注入可见、`/api/dsh-wiki/state` 与 `/health` 返回 200）。

**客户端契约**（0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.1-rc.2 一致）：

- 产物是经典脚本 + CJS 工厂 `window.__ModuleLoader__.load({ id, factory })`；第一行必须是 `load` 调用（多一个 `"use strict"` 前缀该行就认不出来），factory 内 `require` 走 loader 模块表。
- 模块表基线种子 0.2.1 为 11 项：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`；0.2.0 及更早为 9 项（无 `zod`、`@tanstack/react-virtual`，旧 9 项是子集）。本插件只 require `react`，故不需要 `dsh.client.external`。
- **非基线模块必须写进 `dsh.client.external`**：漏了不是单插件静默失效，而是 factory 物化时抛错、**整个 web boot 失败**（`web boot: N entries did not activate`）。
- slot 的声明方与 key 语义：`settings.section`（list，声明方 `dsh-client-ui-settings-general`，`id` 即导航项）与 `plugins.bundle.config`（keyed，声明方 `dsh-client-ui-plugin-manager`，key = 包名）。

**版本门**：

- 0.2.1 起强制执行**顶层** `engines.dsh`（与 `engines.node` 并列）：声明了它就只按它判定，`peerDependencies` 被忽略。本插件顶层声明 `>=0.1.7-rc.2`，覆盖 0.1.7-rc.2 到 0.2.x。
- 0.1.7-rc.2 与 0.2.0-rc.1 没有任何代码读取 `engines.dsh`，门是 `peerDependencies` 里的 `@deepseek-ai/dsh*` 加 `semver.satisfies(runtime, range, { includePrerelease: true })`（`dsh-app-boot`）；本插件不声明这类 peer（peer 只有 `react`）→ 缺省不设限。
- **永远不要写 `^0.1.7-rc.2`** 这类下界精确到 prerelease 的写法：`^` 的上界卡在 0.2.0 之前，对 0.2.x 判 false，会让整个 bundle 被静默 skip。

**复核方法**：`tests/dsh-client-bundle-test.mjs` 是离线契约闸门（外壳格式 + 两个 slot + jsdom 渲染）；`tests/dsh-020-contract-test.mjs` 钉 0.2.0 的基线表与 slot 契约，并校验当前 package.json 的顶层 `engines.dsh`；真机复核看 Settings 的「llm-wiki 知识库」与侧栏 Plugins 的 bundle 页。

## 能力

- **注入分两层**（可选宿主优化；`system-prompt/assemble` 瀑布，apply 同步注册，异步读盘不外抛）：
  - **恒定层**：工具用法 + 【硬要求】第一步先 `wiki_list`，作为 system prompt section
    （`sectionOrder: 62`）注入。文本是模块级常量——任何会话 / 任何 bundle 分支 / 任何用户
    逐字节相同，所以注入内容永远不会打断提供方的前缀缓存。
  - **会话层**：当前 bundle（名 + 路径）+ 目录清单 + 各目录 `APPEND_SYSTEM_PROMPT.md` 规则，
    走 **runtime context 快照**（宿主追加在会话尾部，内容未变则不产生新消息；切换分支 /
    改规则才更新一条）。注入对象带 `interpolate: false`：APPEND 正文里的 `{{...}}` 保持字面量，
    不会被宿主当作提示词变量解析。放进 system prompt 的代价是一字节变化就得重发整份 prompt，
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
    **身份自动选择**：动作前读一次 `auth status` 的身份态（不做试探性读写）后挑 user/bot——
    `auto`（默认：user ready 用 user，否则回退 bot）或锁定身份（不可用即报错、不回退）。
    **真删除**：`wiki_sync` 的 `delete` 动作（v1 不同步删除，只删一侧必复活，故两侧一起删 + 清账本）；
    只删显式 `paths`、另一侧有未同步改动即拒删、默认预演（`apply:false`）。
- **定时自动同步**（默认关闭）：插件内在宿主进程里跑定时器，对**飞书** bundle 按间隔自动
  推拉（默认 5 分钟，最小 1、最大 1440）。只驱动飞书后端——Git 远端同步涉及合并，保持手动。
  设置按机器存 `~/.agents/wiki-autosync.json`（core `autosync.mjs`）；同一 bundle 不并发，
  失败只记录不停表，冲突照旧停下报清单、绝不覆盖。
- **图形化配置**（DSH **0.1.7-rc.2 起；0.2.1-rc.2 已复核**）：浏览器半 `lib/client.js` 把同一个配置页注册进两个 slot——
  `settings.section`（**设置 → llm-wiki 知识库**，一等区块）与 `plugins.bundle.config`
  （**侧栏「插件」→ `@sidleo3/dsh-wiki` 页面**，key = 包名）。四区：命名目录管理 /
  在线同步（按后端显示 Git 或飞书状态）/ 定时自动同步（开关·间隔·身份·立即同步）/
  体检与索引；命名目录新增时可选「本地目录 / 飞书云盘库」，
  并支持一键在飞书新建文件夹并注册。**运行参数不提供界面编辑**（部署级配置，改 profile 的 `cordis.patch.yml`）。
  宿主半另注册 `/api/dsh-wiki/*` RPC（页面只走这些端点）。
  0.1.7 起官方移除了「设置 → 插件 → 插件配置」Tab（`settings.plugin.item` 与设置命名空间钥匙一并作废），
  故 0.7.0 起要求 `dsh >= 0.1.7-rc.2`。
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
node tests/dsh-mock-test.mjs        # 宿主无关 mock：14 工具注册 + 注入分层 + 门控 + 多目录 + 同步诊断（35 项）
node --test tests/dsh-config-test.mjs       # 配置页宿主半：/api/dsh-wiki/* + 飞书分派 + 定时同步 RPC（14 项）
node --test tests/feishu-backend.test.mjs   # 飞书云盘后端（假 lark-cli，25 项，含 user/bot 身份选择）
node --test tests/autosync.test.mjs         # 定时自动同步（配置持久化 + 调度器 + 冲突安全，17 项）
node --test tests/feishu-delete.test.mjs    # 真删除（只删点名路径 / 拒删未同步 / 预演默认 / 不复活，11 项）
node --test tests/dsh-client-bundle-test.mjs # 配置页产物契约（两个 slot）+ jsdom 渲染（8 项）

# 浏览器半构建（改 src/client/ 后必须重跑）
npm install && npm run build        # 产出 lib/client.js（tsdown，banner = __ModuleLoader__.load）
npm run typecheck                   # tsc --noEmit

# 本地迭代：profile 用仓库目录替换 registry 版本（改 host 半需重启 dsh web）
dsh plugin --profile web add link:/path/to/packages/dsh
```

## 依赖

宿主半运行时自包含（vendor-core 内嵌，`npm run sync-vendor` 从仓库 `packages/core` 同步）；独立引用 core 可用 `@sidleo3/llm-wiki-core`。浏览器半只依赖 React（平台基线模块，构建期 external，运行时由 loader 提供）；页面经 DSH 的 `slots` 服务注册，服务缺席时静默跳过。

## 许可

MIT
