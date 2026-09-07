---
type: Attested Computation
title: Active customers in window
description: Distinct buyers with at least one order in the window, per Growth definition.
tags: [growth, customers]
status: stable
runtime: bigquery
parameters:
  - { name: from, type: date, required: true }
  - { name: to, type: date, required: true }
executor: { resource: references/skills/run-on-bq.md, receipt: [job_id, executed_sql] }
generated: { by: reference_agent/gemini-2.5-pro, at: 2026-06-20T10:00:00Z }
verified: { by: human:ahormati, at: 2026-06-22T09:00:00Z }
---

# Computation

```sql
select count(distinct customer_id) as active_customers
from `sales.orders`
where date(placed_at) between date(@from) and date(@to)
```

# Note

Distinct on `customer_id` from [orders](/tables/orders.md); does not require [customers](/tables/customers.md) unless country dimension is needed.
