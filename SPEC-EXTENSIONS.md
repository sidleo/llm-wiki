# SPEC-EXTENSIONS.md —— 对 OKF 的项目级扩展声明

本项目以 **Open Knowledge Format v0.2** 为格式层的唯一事实标准，遵守其全部强制性条款。唯一的有意扩展如下，特此公开声明，保证开源透明与互操作可预期。

## 扩展 1：`AGENTS.md` 作为第三类保留文件

**OKF v0.2 规定**保留文件只有 `index.md` 与 `log.md`；其余 `.md` 文件一律视为 concept，需含 frontmatter + 非空 `type`。

**本项目的扩展**：将 `AGENTS.md`（任意层级）追加为**第三类保留文件**——无 frontmatter、不作 concept、不参与 type 校验，语义为「该目录（及整棵子树）的 agent 规则」。规则解析采用「向上遍历取最近 + 逐级叠加、子目录覆盖父目录」。

**动机**：`AGENTS.md` 在 agent 生态（Claude Code / Codex / pi 等）已有「按目录自动加载规则」的既有语义。本项目将知识库的目录级「怎么写、写前是否需确认」等规则承载于此，使规则与知识同库、随 bundle 分发、三形态行为一致。

**互操作影响评估**：
- OKF 官方 conformance 本就极其宽松——consumer 必须容忍「未知额外 frontmatter 键 / 未知 type / 断链 / 缺 index」，且未知 `.md` 若缺 frontmatter 只会在严格校验下被 flag。
- 本项目 `wiki_validate` 将 `AGENTS.md` 与 `index.md`/`log.md` 同等豁免 type 检查，判定合规。
- 第三方 consumer（Graph 渲染、其他 agent 工具）可将 `AGENTS.md` 视为普通文件忽略或加载，不影响其余概念文档的可读性。

**本扩展不影响 OKF 的任何必选字段、保留文件名、链接与合规判据的其余部分。**

## 明确不扩展的部分

- 不新增任何 OKF 之外的 frontmatter 必选/自定义语义字段（`name`/`summary`/`related`/`enabled` 等旧设计一律不使用）。
- 不改变保留文件名、链接形式、conformance 判据。
- 消费层行为（检索/backlinks/lint/门控交互）不写入格式层。
