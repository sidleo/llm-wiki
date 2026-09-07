# 安装 skill 版（大部分 agent 通用）

skill 版 = `SKILL.md` 说明 + `wiki` CLI，任何支持 Agent Skills 的宿主
（Claude Code / Codex / Cursor / DSH / pi 等）都能通过读取同一份
`SKILL.md` 并使用同一份数据 bundle。

## 1. 安装 CLI

把 `wiki` 放进 PATH（三选一）：

```bash
# 方式 A：软链（推荐，仓库更新即同步）
ln -s "$(pwd)/packages/skill/bin/wiki.mjs" /usr/local/bin/wiki
chmod +x /usr/local/bin/wiki

# 方式 B：npm 全局
npm link ./packages/skill          # 在本仓库根目录执行

# 方式 C：直接用 node 调用
node packages/skill/bin/wiki.mjs list
```

验证：`wiki list --dataDir examples/demo-bundle`

## 2. 让 agent 加载 SKILL.md

按你宿主的 skill 机制放入 skills 目录，例如：

```bash
# DSH / 通用 Agent Skills 惯例
mkdir -p ~/.agents/skills/wiki
cp packages/skill/SKILL.md ~/.agents/skills/wiki/SKILL.md
ln -s "$(pwd)/packages/skill/bin/wiki.mjs" /usr/local/bin/wiki   # CLI 已在 PATH
```

`SKILL.md` 的 `metadata.requires.bins: ["wiki"]` 声明依赖 `wiki` 命令，
宿主会提示/校验该 bin 可用。

## 3. 数据目录

- 默认 `~/.agents/wiki`
- 覆盖：`WIKI_DATA_DIR` 环境变量，或每条命令 `--dataDir DIR`
- 首次使用可用 `examples/demo-bundle` 当参考；真实知识按
  `scripts/migrate.mjs` 从旧 kb/sqlkb 迁移，或直接 `wiki create` 建概念。

## 4. 只读命令无需任何授权；写命令按 SKILL.md 的门控规范执行。
