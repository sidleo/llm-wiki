# Demo Bundle 目录规则

本 bundle 是 llm-wiki 的演示/测试样例，规则示例：

- 概念一律使用英文 id、frontmatter 必须含 `type` 与 `description`。
- 涉及「口径」的写入（`Attested Computation` / `Metric`）默认需 **human 确认**后才写 `verified`。
- 表结构探查事实（`Table`）可自动记录（unverified）。
- 正文引用相关概念用 markdown 链接 `/path.md`，Obsidian 可用 `[[wiki-link]]` 等价表达。
