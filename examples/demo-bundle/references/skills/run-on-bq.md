---
type: Reference
title: Run on BigQuery (executor)
description: Executor run instructions for Attested Computations (demo placeholder).
tags: [executor, bigquery]
status: stable
generated: { by: agent:llm-wiki/0.1.0, at: 2026-09-01T00:00:00Z }
---
# 运行 BigQuery 的 executor 说明（demo 占位）

执行 [revenue](/computations/revenue.md) 这类 Attested Computation 时：
1. 从 frontmatter 读 `parameters`，只允许填参数值。
2. 取 `computation` 指向的 `.sql` 文件（或正文 `# Computation` 代码块）绑定参数。
3. 运行后返回 receipt：`job_id` / `executed_sql` / `result`。
