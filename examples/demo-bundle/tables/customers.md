---
type: Table
title: customers
description: Customer master profiles, one row per customer.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=customers
tags: [customer, dimension]
status: stable
generated: { by: agent:llm-wiki/0.1.0, at: 2026-09-01T00:00:00Z }
---

# Schema

| Column | Type | Description |
|--------|------|-------------|
| `customer_id` | STRING | Globally unique customer identifier. |
| `signup_at` | TIMESTAMP | When the account was created. |
| `country` | STRING | Billing country. |

# Notes

Referenced from [orders](/tables/orders.md). Active-buyer computation joins back here — see [active customers](/computations/active-customers.md).
