# @sidleo3/llm-wiki-core

llm-wiki 通用知识库的共享核心引擎（Node ESM，零外部依赖）。

实现：OKF v0.2 解析/序列化、链接归一化与链接图（含 backlinks）、检索、合规校验、
lint、index/log 维护（refreshIndex 重生成、mergeLogText 冲突并集）、
AGENTS.md / APPEND_SYSTEM_PROMPT.md 规则解析（向上遍历）、
写入门控（gateForType）、ingest、migrate、Git 远端同步
（gitAvailable/gitStatus/gitSync/gitInit/gitClone：本地目录后端；无三方依赖、凭证交给 git、
绝不 force push；index 重生成、log 取并集，概念冲突停止并回滚工作区）、
飞书云盘在线库后端（feishuStatus/feishuSync/feishuPull/feishuPush/feishuInit：经 lark-cli 把云盘文件夹
当作原生 .md bundle 读写；三方状态 .wiki-cloud.json、只推改动文件、永不删两端、冲突停下报清单）。

被三形态复用：DSH 插件 `@sidleo3/dsh-wiki`、pi 扩展 `@sidleo3/pi-wiki`、skill CLI `wiki`
（后两者内嵌 vendor-core 自包含，本包供仓库开发态/自定义集成引用）。

```js
import { validateBundle, buildGraph, searchGraph, gitStatus, gitSync } from '@sidleo3/llm-wiki-core'
```

详细用法与格式规范见仓库根 README / schema.md / SPEC-EXTENSIONS.md。
MIT
