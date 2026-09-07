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

- **描述层注入**（可选宿主优化）：每轮 system prompt 注入精简 section——bundle 路径 +
  目录树摘要 + 工具用法 + 【硬要求】第一步先 `wiki_list`。与 dsh-kb 同机制
  （`system-prompt/assemble` 瀑布，apply 同步注册，异步读盘不外抛）。
- **11 个工具**：`wiki_list` / `wiki_search` / `wiki_get`（附 backlinks）/ `wiki_create` /
  `wiki_update` / `wiki_validate` / `wiki_lint` / `wiki_ingest` / `wiki_deprecate` /
  `wiki_rules` / `wiki_help`（机制文档自助查）。
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
    maxGetChars: 40000
    cacheTtlMs: 30000
```

## 开发与测试

```bash
node --check wiki.mjs
node tests/dsh-mock-test.mjs        # 宿主无关 mock：11 工具注册 + 描述层 + 门控
```

## 依赖

运行时需 `llm-wiki-core` npm 包（发布后）；开发态自动优先加载本仓库 `packages/core`。

## 许可

MIT
