---
type: Table
title: orders
description: One row per completed customer order across all channels.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=orders
tags: [sales, orders, revenue]
status: stable
generated: { by: agent:llm-wiki/0.1.0, at: 2026-09-01T00:00:00Z }
---

# Schema

| Column | Type | Description |
|--------|------|-------------|
| `order_id` | STRING | Globally unique order identifier. |
| `customer_id` | STRING | Foreign key into [customers](/tables/customers.md). |
| `total_usd` | NUMERIC | Order total in US dollars. |
| `placed_at` | TIMESTAMP | When the customer submitted the order. |

# Joins

Joined with [customers](/tables/customers.md) on `customer_id`. One order has many [line_items](/tables/line_items.md); join carefully — see [join inflation](/pitfalls/join-inflation.md).

# Computation

Revenue is computed from this table by the [revenue computation](/computations/revenue.md).

# Gotchas

- 本表按 `placed_at` 分区；跨分区扫描注意成本。
- 关联 [customers](/tables/customers.md) 时若含历史地址多行，订单会被放大——见 [join inflation](/pitfalls/join-inflation.md)。
