# @sidleo3/llm-wiki-core

llm-wiki 通用知识库的共享核心引擎（Node ESM，零外部依赖）。

实现：OKF v0.2 解析/序列化、链接归一化与链接图（含 backlinks）、检索、合规校验、
lint、index/log 维护（refreshIndex 重生成、mergeLogText 冲突并集）、
AGENTS.md / APPEND_SYSTEM_PROMPT.md 规则解析（向上遍历）、
写入门控（gateForType）、ingest、migrate、Git 远端同步
（gitAvailable/gitStatus/gitSync/gitInit/gitClone：本地目录后端；无三方依赖、凭证交给 git、
绝不 force push；index 重生成、log 取并集，概念冲突停止并回滚工作区）、
飞书云盘在线库后端（feishuStatus/feishuSync/feishuPull/feishuPush/feishuInit：经 lark-cli 把云盘文件夹
当作原生 .md bundle 读写；三方状态 .wiki-cloud.json、只推改动文件、永不删两端、冲突停下报清单；
身份可自动选择——resolveLarkIdentity 按 identity 选项（auto/user/bot）读 lark-cli 身份态后挑可用者，
不为了试探而读写远端）、
定时自动同步的配置持久化（autosync.mjs：开关/间隔/身份按机器存 ~/.agents/wiki-autosync.json，
间隔默认 5 分钟；含运行结果记录与陈旧 running 判据。定时器本身属宿主能力，由 DSH 插件执行）。

被五形态复用：DSH 插件 `@sidleo3/dsh-wiki`、Codex 插件 `@sidleo3/codex-wiki`、pi 扩展 `@sidleo3/pi-wiki`、MCP 服务端 `@sidleo3/mcp-wiki`、skill CLI `wiki`
（后三者内嵌 vendor-core 自包含，本包供仓库开发态/自定义集成引用）。

```js
import { validateBundle, buildGraph, searchGraph, gitStatus, gitSync } from '@sidleo3/llm-wiki-core'
```

详细用法与格式规范见仓库根 README / schema.md / SPEC-EXTENSIONS.md。
MIT
