---
name: stat_flag 不匹配导致客流重复
type: 口径
tables: dm.dm_sale_setl_dly_sum_1d
related_examples: 销售多维度汇总查询
tags: 客流, stat_flag
severity: 高
---
## 坑描述
join 时 stat_flag 不匹配导致行重复，销售额虚高。
