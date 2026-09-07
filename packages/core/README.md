# llm-wiki-core

llm-wiki 通用知识库的共享核心引擎（Node ESM，零外部依赖）。

实现：OKF v0.2 解析/序列化、链接归一化与链接图（含 backlinks）、检索、合规校验、
lint、index/log 维护、AGENTS.md / APPEND_SYSTEM_PROMPT.md 规则解析（向上遍历）、
写入门控（gateForType）、ingest、migrate。

被三形态复用：DSH 插件 `@sidleo3/dsh-wiki`、pi 扩展 `@sidleo3/pi-wiki`、skill CLI `wiki`
（后两者内嵌 vendor-core 自包含，本包供仓库开发态/自定义集成引用）。

```js
import { validateBundle, buildGraph, searchGraph } from 'llm-wiki-core'
```

详细用法与格式规范见仓库根 README / schema.md / SPEC-EXTENSIONS.md。
MIT
