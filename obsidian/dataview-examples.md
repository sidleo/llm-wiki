# Obsidian Dataview 查询示例

在 Obsidian 中打开 bundle 根目录为 vault，并安装 Dataview 社区插件后，
在任意笔记中用如下查询。

## 按 type 聚合全部概念

```dataview
TABLE type, status, file.mtime as updated
FROM ""
WHERE file.name != "index" AND file.name != "log"
SORT type ASC
```

## 只看 Table（表清单）

```dataview
TABLE description, status
FROM ""
WHERE type = "Table"
SORT file.name ASC
```

## 坑点清单（type: Pitfall）

```dataview
LIST description
FROM ""
WHERE type = "Pitfall"
```

## 已过期的概念（stale_after < now）

```dataview
TABLE stale_after, type
FROM ""
WHERE stale_after AND date(stale_after) < date(now)
SORT stale_after ASC
```

## 已停用（status: deprecated）

```dataview
LIST
FROM ""
WHERE status = "deprecated"
```

## Attested Computation（口径计算）与其 runtime

```dataview
TABLE runtime, parameters
FROM ""
WHERE type = "Attested Computation"
```

> 提示：backlinks 无需查询——Obsidian 右侧面板原生显示；graph view（图谱视图）
> 直接展示全部真实链接形成的网络。frontmatter 的 `[[...]]` 与 `/path.md` 链接
> 都会被 Obsidian 识别（wiki-link 原生支持；/path.md 形式的 markdown 链接在
> graph view 中亦成边）。
