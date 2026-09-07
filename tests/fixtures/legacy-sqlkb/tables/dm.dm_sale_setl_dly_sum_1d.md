---
name: dm.dm_sale_setl_dly_sum_1d
type: 事实表（销售汇总日）
purpose: 销售结算日汇总表，按天聚合销售流水，日常销售查询首选
exec: yh_bigdata
engines: impala, hive
tags: 销售, 汇总, 日报
related: dws.dws_sale_setl_dly_sum_1d
---
## dm.dm_sale_setl_dly_sum_1d

| 字段 | 类型 | 说明 |
|------|------|------|
| shop_id | string | 门店 |
| restore_sales_amt | decimal | 销售额 |
