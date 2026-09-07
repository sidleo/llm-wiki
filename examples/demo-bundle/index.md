---
okf_version: "0.2"
---
# Demo Knowledge Bundle

脱敏合成的零售数据分析知识库示例，展示 OKF v0.2 结构：表、口径计算、坑点、指标互相交叉链接。可直接用 Obsidian 打开本目录浏览 graph view。

## tables

* [orders](/tables/orders.md) — Completed customer orders.  `Table`
* [customers](/tables/customers.md) — Customer master profiles.  `Table`
* [line_items](/tables/line_items.md) — Per-line order items.  `Table`

## computations

* [revenue](/computations/revenue.md) — Recognized revenue per Finance definition.  `Attested Computation`
* [active-customers](/computations/active-customers.md) — Distinct buyers in a date window.  `Attested Computation`

## metrics

* [customer-lifetime-value](/metrics/customer-lifetime-value.md) — Narrates CLV from its computations.  `Metric`

## pitfalls

* [stat-flag-duplication](/pitfalls/stat-flag-duplication.md) — stat_flag 不匹配导致行重复。  `Pitfall`
* [join-inflation](/pitfalls/join-inflation.md) — 一对多 join 造成销售额膨胀。  `Pitfall`

## references

* [revenue-recognition](/references/revenue-recognition.md) — Revenue recognition policy notes.  `Reference`
