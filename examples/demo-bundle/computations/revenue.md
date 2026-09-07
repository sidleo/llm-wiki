---
type: Attested Computation
title: Revenue for fiscal year
description: Recognized revenue for a fiscal year, per Finance's definition.
tags: [finance, revenue]
status: stable
runtime: bigquery
parameters:
  - { name: year, type: integer, required: true }
computation: references/computations/revenue.sql
executor:
  resource: references/skills/run-on-bq.md
  receipt: [job_id, executed_sql, result]
attester: { resource: references/attesters/sql-equality.md }
generated: { by: reference_agent/gemini-2.5-pro, at: 2026-06-28T14:00:00Z }
verified: { by: human:ahormati, at: 2026-06-25T09:00:00Z }
stale_after: 2026-12-31T00:00:00Z
sources:
  - id: rev-policy
    resource: /references/revenue-recognition.md
    title: Revenue recognition policy
---

# Definition

Recognized revenue sums `amount_usd` over rows booked to the fiscal year on the [orders](/tables/orders.md) table, per the revenue recognition policy.[^rev-policy]

[^rev-policy]: Revenue recognition policy notes
