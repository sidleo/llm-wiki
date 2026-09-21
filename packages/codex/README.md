# @sidleo3/codex-wiki — Codex 插件（llm-wiki 知识库）

Codex 形态把 llm-wiki 接进 Codex 插件体系，目标是尽量对齐最完整的 DSH 版：

- **内置 skill**：`skills/wiki/SKILL.md` 负责“何时必须查库、怎么检索、何时主动记录”。
- **14 个 `wiki_*` MCP 工具**：与 DSH / Pi / MCP / Skill 形态同名、同参、同输出。
- **会话规则注入**：`UserPromptSubmit` / `SessionStart` hook 读取当前 bundle 与
  各目录 `APPEND_SYSTEM_PROMPT.md`，规则变化后下一轮自动刷新；内容未变不重复注入。
- **同一份数据与注册表**：默认 `~/.agents/wiki`，多目录走
  `~/.agents/wiki-registry.json`；写入门控、trust、Git/飞书同步仍然只由 `packages/core` 实现。
- **零运行时依赖**：插件内嵌 `vendor-core` 与 MCP 工具层，自带轻量 stdio transport，
  安装后不依赖仓库路径或 npm registry。

## 与 DSH 版的能力对照

| | DSH 插件 | Codex 插件 |
|---|---|---|
| 14 个 `wiki_*` 工具 | ✅ | ✅ 同名同参同输出 |
| 恒定工具引导 | system-prompt section | MCP `instructions` + skill |
| 当前 bundle / 目录 / APPEND 规则 | runtime context，每轮现读 | hook 注入；内容变化才刷新，compact 后重建 |
| 规则改动即时生效 | 下一轮 | 下一轮 |
| `wiki_use` 切换粒度 | 会话级 | 一个 MCP 进程级；Codex 会话通常各自启动进程 |
| 图形化设置卡片 | ✅ | ❌ Codex 插件无对应设置页；用注册表 / 工具管理 |
| 定时自动同步 | DSH 进程内定时器 | ❌ 保持手动 `wiki_sync` |

## 安装（本地 marketplace）

插件目录必须完整复制到 marketplace 指向的位置。推荐把本仓库的
`packages/codex` 链接为 `~/plugins/codex`，再在个人 marketplace 中注册：

```bash
mkdir -p ~/plugins
ln -s /absolute/path/to/llm-wiki/packages/codex ~/plugins/codex
```

在 `~/.agents/plugins/marketplace.json` 中加入：

```json
{
  "name": "personal",
  "interface": { "displayName": "Personal" },
  "plugins": [
    {
      "name": "codex",
      "source": {
        "source": "local",
        "path": "./plugins/codex"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

然后在 Codex 中打开 Plugins / `/plugins` 安装，或执行：

```bash
codex plugin add codex@personal
```

安装或更新后请新开一个会话，让 Codex 重新加载插件 skill、MCP 工具与 hooks。
非 managed hook 首次运行前需要在 `/hooks` 中 review 并 trust。

## MCP 配置

`.mcp.json` 使用插件根目录作为 cwd，并启动同包服务：

```json
{
  "mcpServers": {
    "wiki": {
      "command": "node",
      "args": ["./bin/wiki-mcp.mjs"],
      "cwd": "."
    }
  }
}
```

可用以下命令自检：

```bash
node packages/codex/bin/wiki-mcp.mjs --check
```

## 目录结构

```text
packages/codex/
├── .codex-plugin/plugin.json   # Codex 插件 manifest
├── .mcp.json                   # 内置 wiki MCP 服务
├── bin/wiki-mcp.mjs            # 零依赖 stdio transport
├── hooks/
│   ├── hooks.json              # SessionStart / UserPromptSubmit
│   └── inject-context.mjs
├── skills/wiki/SKILL.md        # Codex 工作流说明
├── lib/                        # MCP 工具层（同步自 packages/mcp）
├── vendor-core/                # core（同步自 packages/core）
└── scripts/sync-upstream.mjs
```

## 开发与验证

```bash
node packages/codex/scripts/sync-upstream.mjs
npm --prefix packages/codex run check
npm --prefix packages/codex test
python3 /Users/zhang3/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py packages/codex
```

修改 `packages/core` 或 `packages/mcp/lib` 后，重新运行 `sync-upstream.mjs`，确保
vendor 副本同步后再提交。

## 许可

MIT
