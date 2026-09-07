# llm-wiki 项目规范

> 纯 OKF v0.2 + llm-wiki 范式的通用知识库：格式层零自定义字段，消费层零魔法特性。
> 三形态（DSH 插件 / pi 扩展 / skill+CLI）共享 `packages/core`，读写同一份数据 bundle。

## 核心原则（三铁律）

1. **必须遵守 OKF**（官方 v0.2 SPEC，见 [schema.md](schema.md)）——格式层**零自定义 frontmatter 字段**。
2. **以 llm-wiki 为主**——能被 OKF/llm-wiki 原生替代的能力一律不保留旧设计（related/name/enabled/待补池/user_approved 等旧 kb/sqlkb 概念全部不用）。
3. **通用性优先**——不绑定任何业务；私有知识不进仓库，只作迁移输入 + 脱敏测试样例（`examples/demo-bundle` / `tests/fixtures`）。

## 格式要点（细节见 schema.md）

- concept = frontmatter（`type` 必填）+ body；保留文件仅 `index.md`/`log.md`/`AGENTS.md`（AGENTS.md 是唯一项目扩展，见 SPEC-EXTENSIONS.md，`wiki_validate` 豁免其 type 检查）。
- 交叉链接用 markdown 链接（`/path.md` 推荐），同时接受 `[[wiki-link]]` 由 core 归一化；**容忍断链**（= 未写入的知识，lint 归集）。
- 坑点无专属机制：表级坑写 `# Gotchas` section；跨表坑用 `type: Pitfall` + 链接；读表时 backlinks 自然暴露。
- 过期用 `stale_after` + `generated.at`；停用用 `status: deprecated`（概念级）或 `wiki_deprecate`（目录级批量）。
- 写入门控 = **AGENTS.md 规则 + trust 字段**（无代码强制弹窗）：`generated:{by: agent…}` 无 verified=unverified；确认后加 `verified:[{by: human:<user>}]`=human-reviewed。

## 目录规则（AGENTS.md）解析

每个目录不一定有独立规则：对任意目录 D（或 concept 所在目录），生效规则 = 从 D **向上遍历到 bundle 根取最近 AGENTS.md**；多条**逐级叠加、子目录覆盖父目录**（最近优先）。core 提供 `resolveRules(dir)`，三形态共用；门控规则走同一套解析。

## 仓库结构

```
packages/core/    # 唯一事实实现：解析/序列化/链接归一化/链接图/检索/validate/lint/index-log/规则解析/migrate
packages/dsh/     # DSH 宿主插件（@sidleo3/dsh-wiki）
packages/pi/      # pi 扩展（pi-wiki）
packages/skill/   # SKILL.md + bin/wiki.mjs CLI
examples/demo-bundle/  # 脱敏示例（Obsidian 可打开，只读不改）
tests/fixtures/   # 合成测试数据
scripts/          # migrate.mjs / smoke-test.mjs
obsidian/         # Obsidian 模板/Dataview 示例
```

## 开发与修改

- **改核心逻辑**：只改 `packages/core/`（Node ESM、无宿主依赖），三形态自动同步；不把业务逻辑写进 dsh/pi/skill 适配层。
- **core 导出形态**：纯 ESM `export function …`；工具 schema 遵循 `{ type:'object', additionalProperties:false, properties, required }` 形态；`parameters` 根开放。
- **DSH 插件注入安全**：描述层注入只能走 `system-prompt/assemble` 瀑布（apply 同步注册）；**禁止在异步回调里调 `ctx.systemPrompt.section()`**（上下文失效会崩掉整个 web 进程）。
- **路径默认值**：数据目录用 `os.homedir()` 计算（`~/.agents/wiki`），不硬编码绝对路径；覆盖走 env/profile 补丁 config。
- **门控语义**：门控不是插件代码强制，而是读 AGENTS.md 规则后由 agent 交互确认；三形态语义一致。
- **本地验证**：`node --check` 全部源文件；`node scripts/smoke-test.mjs`（fixtures 全绿）；各包测试命令见各包 README。

## 多工具指令文件约定（与用户其他项目一致）

- `AGENTS.md` 为唯一内容来源；同目录 `CLAUDE.md`、`CODEBUDDY.md` 用相对路径软链接指向它（`ln -s AGENTS.md CLAUDE.md`），保证 git 可移植。

## 行为约束

- 直接执行，不预先检查；改动前先读仓库现有结构，遵循「外科手术式修改」。
- 涉及用户私有知识（`~/.agents/wiki`）的操作：migrate 一律 copy 不 move、`--dry-run` 默认；只读检索可自行执行。
- 开源仓库不含任何用户业务数据；新增样例必须是脱敏/合成的。
