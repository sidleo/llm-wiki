---
type: Table
title: line_items
description: One row per line item inside an order.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=line_items
tags: [sales, orders]
status: stable
generated: { by: agent:llm-wiki/0.1.0, at: 2026-09-01T00:00:00Z }
---

# Schema

| Column | Type | Description |
|--------|------|-------------|
| `order_id` | STRING | FK into [orders](/tables/orders.md). |
| `sku` | STRING | Product identifier. |
| `qty` | INT64 | Units purchased. |
| `amount_usd` | NUMERIC | Line total in US dollars. |
