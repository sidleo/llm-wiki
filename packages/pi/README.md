# pi-wiki — Pi 的 llm-wiki 知识库扩展

为 [Pi](https://github.com/earendil-works/pi)（AI coding agent）提供 llm-wiki 通用知识库访问：
**复用与 DSH 插件 `@sidleo3/dsh-wiki` / skill CLI 完全相同的实现（`llm-wiki-core`）**，读写同一份
OKF v0.2 bundle（默认 `~/.agents/wiki`），一套数据三处共享、无重复维护。

## 能力

Pi 会话注入 10 个工具 + prompt 引导：

| 工具 | 用途 |
|------|------|
| `wiki_list` | 目录树 + 概念清单（**知识工作第一步先调用**） |
| `wiki_search` | 关键词检索（frontmatter + 正文；type/tag 过滤；★ 强匹配） |
| `wiki_get` | 读单概念全文，**自动附 backlinks**（引用它的坑点/概念） |
| `wiki_create` | 新增概念（门控读 AGENTS.md 规则；确认后带 human verified） |
| `wiki_update` | 更新概念字段/正文（只更新传入字段） |
| `wiki_validate` | OKF v0.2 合规校验 |
| `wiki_lint` | 体检：断链/孤儿/过期/缺 index |
| `wiki_ingest` | 登记外部源文件进 bundle（copy 不改源） |
| `wiki_deprecate` | 目录级批量停用（status: deprecated，零删除） |
| `wiki_rules` | 查看目录生效的 AGENTS.md 规则（向上遍历取最近） |

## 安装

```bash
# 本地源码目录（改代码即生效）
pi install /path/to/packages/pi

# 或发布后
pi install npm:pi-wiki
```

## 配置

- 数据目录默认 `~/.agents/wiki`（与 DSH 插件同一份 bundle），环境变量 `PI_WIKI_DATA_DIR` 覆盖。
- 需 core 依赖可用：开发态用本仓库 `packages/core`，发布态 npm 依赖 `llm-wiki-core`。

## 知识库格式

与 schema.md 一致（OKF v0.2）：概念 = frontmatter（`type` 必填）+ 正文 markdown；
`index.md`/`log.md`/`AGENTS.md` 为保留文件；真实链接交叉引用；`stale_after` 过期、
`status: deprecated` 停用。详见仓库根 `schema.md` 与 `SPEC-EXTENSIONS.md`。

## 开发

```bash
npm install            # typebox + @earendil-works/pi-coding-agent 类型
node --experimental-strip-types --check extensions/index.ts
npm test               # mock pi 单测（不触碰真实库）
```
