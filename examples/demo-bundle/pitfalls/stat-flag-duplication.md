---
type: Pitfall
title: stat_flag mismatch duplicates rows
description: 客流/销售 join 时 stat_flag 不匹配导致行重复放大。
tags: [stat_flag, join, customer-flow]
status: stable
generated: { by: agent:llm-wiki/0.1.0, at: 2026-09-01T00:00:00Z }
---

# 坑

对 [orders](/tables/orders.md) 或客流表做 join 时，若两侧 `stat_flag` 口径不一致（一侧含退货/取消行），一行订单会被放大成多行，造成销售额与客单虚高。

# 正确做法

join 前先确认两侧 `stat_flag` 过滤条件一致，或先各自聚合再 join（先 reduce 再 join）。相关口径见 [revenue](/computations/revenue.md)。
