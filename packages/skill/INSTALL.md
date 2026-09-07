# 安装 skill 版（大部分 agent 通用）

skill 版 = `SKILL.md` 说明 + `wiki` CLI，任何支持 Agent Skills 的宿主
（Claude Code / Codex / Cursor / DSH / pi / Workbuddy 等）都能通过读取同一份
`SKILL.md` 并使用同一份数据 bundle。

## 方式 A：自包含打包（推荐，零外部依赖）

生成一个可整体复制进任意宿主 skills 目录的自包含目录（含 CLI + 全部 core）：

```bash
node packages/skill/scripts/build-standalone.mjs --target /tmp/wiki-skill
# 产物：SKILL.md + scripts/{wiki.mjs, install.sh, wiki-core/}

# 安装 CLI 到 PATH：
bash /tmp/wiki-skill/scripts/install.sh

# 放进宿主的 skills 目录（示例：workbuddy）
mkdir -p ~/.workbuddy/skills/wiki
cp -r /tmp/wiki-skill/. ~/.workbuddy/skills/wiki/
```

## 方式 B：从本仓库直接使用

把 CLI 放进 PATH（三选一）：

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

## 3. 数据目录

- 默认 `~/.agents/wiki`
- 覆盖：`WIKI_DATA_DIR` 环境变量，或每条命令 `--dataDir DIR`
- 首次使用可用 `examples/demo-bundle` 当参考；真实知识直接用 `wiki create` 建概念。

## 4. 宿主加载与授权

- 把含 `SKILL.md` 的目录放进宿主 skills 目录即被识别（`metadata.requires.bins: ["wiki"]` 声明依赖 `wiki` 命令）。
- 只读命令（list/search/get/validate/lint/rules）无需任何授权；写命令（create/update/ingest/deprecate）按 SKILL.md 的门控规范执行（口径类先向用户确认）。
