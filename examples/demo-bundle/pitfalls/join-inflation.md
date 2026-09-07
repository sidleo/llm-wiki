---
type: Pitfall
title: One-to-many join inflates sales
description: 订单 join 明细/地址等多行侧时销售额被重复求和放大。
tags: [join, inflation, sales]
status: stable
generated: { by: agent:llm-wiki/0.1.0, at: 2026-09-01T00:00:00Z }
---

# 坑

[orders](/tables/orders.md) 与 [line_items](/tables/line_items.md) 是 1:N；若直接在订单粒度的 `total_usd` 上 join 行项再 `sum(total_usd)`，总额被放大 N 倍。

# 正确做法

- 需要订单级金额：在 [orders](/tables/orders.md) 单表聚合，或 join 后对行项金额 `sum(amount_usd)`（行项自带金额）。
- 需要行项级明细：按 `order_id` 层先聚合订单金额、再 join 行项。

相关：[revenue](/computations/revenue.md) 的口径已把金额唯一来源限定在行项 `amount_usd`。
