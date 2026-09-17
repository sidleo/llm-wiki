# @sidleo3/mcp-wiki — MCP 服务端（llm-wiki 知识库）

给**任何支持 MCP 的 agent 宿主**（Claude Code / Cursor / Codex / …）提供 llm-wiki 通用知识库访问：
**内嵌 vendor-core，与 DSH 插件 `@sidleo3/dsh-wiki` / pi 扩展 `@sidleo3/pi-wiki` / skill CLI 完全相同的实现**
（`scripts/sync-vendor.mjs` 从 `packages/core` 同步），读写同一份 OKF v0.2 bundle（默认 `~/.agents/wiki`）。

设计目标：**在没有插件机制的宿主里，把体验做到尽量接近 DSH 版**——同样的 14 个 `wiki_*` 工具（同名/同参/同输出文本）、
同样的目录规则下发、同样的写入门控与 trust 语义。

## 与 DSH 版的能力对照

| | DSH 插件 | MCP 形态 |
|---|---|---|
| 14 个 `wiki_*` 工具 | ✅ | ✅ 同名同参同输出（`test/parity.test.mjs` 逐字节对拍） |
| 恒定工具引导 | system-prompt section | `initialize` 的 `instructions` 字段 |
| 当前 bundle / 目录清单 / 各目录 `APPEND_SYSTEM_PROMPT.md` 规则 | runtime context 快照（每轮） | 同一段文本，随 `instructions` 一次下发 |
| 规则改动后即时生效 | 下一轮自动重读 | 需重连，或调 `wiki_rules` / 读 `wiki get/create/update`（响应末尾自动附规则） |
| `wiki_use` 切换粒度 | 会话级（按对话隔离） | **进程级**（一个 server 进程 ≈ 一个宿主会话）；`global:true` 仍写共享注册表 |
| 命名目录 / 同步 / 体检的图形化面板 | Settings 卡片 | 无 GUI，用 `wiki_dirs` / `wiki_sync` / `wiki_lint` 工具 |
| 运行期网络 | 无（除 `wiki_sync`） | 无（除 `wiki_sync`），stdout 只走 JSON-RPC |

## 安装

### 方式 A：从本仓库直接跑（推荐，零额外步骤）

`bin/wiki-mcp.mjs` 已内嵌 vendor-core，只需装一次依赖（MCP SDK）：

```bash
cd packages/mcp && npm install --omit=dev
node "$PWD/bin/wiki-mcp.mjs" --check     # 自检：打印生效目录 / instructions / 14 个工具
```

### 方式 B：npm 安装

```bash
npm install -g @sidleo3/mcp-wiki     # 提供 wiki-mcp 命令
```

> **不要用 `npx -y` 启动。** 那样宿主会在首次运行/缓存失效时访问 npm registry——这是「完全本地运行」里唯一会漏网的地方。
> 宿主配置里请写**绝对路径的 node + 绝对路径的 `bin/wiki-mcp.mjs`**（顺带绕开 GUI 宿主 PATH 里没有 `/usr/local/bin` 的老问题）。

## 宿主配置

各宿主的字段名大同小异，核心就是「本地 stdio 服务 + 命令 + 参数」。下面三种为常见形态（**以各宿主文档为准**）：

**Claude Code**（项目根 `.mcp.json`，或 `claude mcp add wiki -s user -- node /abs/path/bin/wiki-mcp.mjs`）：

```json
{
  "mcpServers": {
    "wiki": {
      "command": "/usr/local/bin/node",
      "args": ["/abs/path/to/packages/mcp/bin/wiki-mcp.mjs"]
    }
  }
}
```

**Cursor**（`~/.cursor/mcp.json`，同一份 `mcpServers` 结构）：

```json
{
  "mcpServers": {
    "wiki": { "command": "/usr/local/bin/node", "args": ["/abs/path/to/packages/mcp/bin/wiki-mcp.mjs"] }
  }
}
```

**Codex**（`~/.codex/config.toml`）：

```toml
[mcp_servers.wiki]
command = "/usr/local/bin/node"
args = ["/abs/path/to/packages/mcp/bin/wiki-mcp.mjs"]
```

配好后重启宿主，模型侧应看到 14 个 `wiki_*` 工具（部分宿主会显示为 `mcp__wiki__wiki_list` 这类带前缀的名字，
指向的是同一个工具；`instructions` 里已说明这层映射）。

## 命令行参数与环境变量

```
wiki-mcp [--data-dir DIR] [--bundles 名=路径[,名=路径]] [--check]
```

| 项 | 说明 |
|---|---|
| `--data-dir` / `--dataDir` / `WIKI_DATA_DIR` | 数据目录，缺省 `~/.agents/wiki` |
| `--bundles` / `WIKI_BUNDLES` | 声明命名 bundle（如 `--bundles 工作=/abs/wiki,个人=~/notes/wiki`），与注册表合并、同名优先 |
| `--check` | 安装自检：打印生效目录 + `instructions` + 工具清单后退出 |
| `WIKI_REGISTRY_FILE` | 命名 bundle 注册表路径覆盖（默认 `~/.agents/wiki-registry.json`） |
| `WIKI_LARK_BIN` | 飞书同步用的 `lark-cli` 路径覆盖 |

命名 bundle 注册表与另三形态**共享同一份**：`wiki_dirs` 查看、`wiki_use <名字> [global:true]` 切换。

## 纯本地说明

- **传输**：stdio（宿主拉起的子进程 + stdin/stdout 管道），不开端口、不发心跳。
- **依赖**：`@modelcontextprotocol/sdk`（+ 其 peer `zod`）。core 本身零依赖，随包 vendor 进来。
- **网络**：只有 `wiki_sync` 会出网——本地库走外部 `git`、飞书库走外部 `lark-cli`（认证交给它们，core 不落 token）。
  不配远端时整库离线可用；要更硬的隔离，就别调用 `wiki_sync`。
- **stdout 是 JSON-RPC 通道**：本服务只往 stderr 写日志，`test/server.test.mjs` 有一项就是「stdout 每行都能 JSON.parse」。
- 「本地运行」不等于「数据不出本机」：检索命中的知识仍会作为工具返回内容进模型上下文——这与 skill/CLI 形态一致。

## 注入与规则：`instructions` 之外还有三条兜底

MCP 协议只在 `initialize` 时下发一次 `instructions`，因此规则送达有四条路，丢了哪条都不至于漏掉规则：

1. `instructions`：恒定工具引导 + 当前 bundle（名 + 路径）+ 可用目录 + 各目录 `APPEND_SYSTEM_PROMPT.md` 正文；
2. `wiki_rules`：随时取全库或某目录生效规则（含 `AGENTS.md` 门控链）；
3. `wiki get/create/update` 的响应末尾**自动附带**目标目录生效规则（core 行为，四形态一致）；
4. `wiki_use` 切库后，把新库的规则上下文直接附在切换结果里。

若你的宿主要求「常驻 system prompt」里必须出现使用要求，跑 `wiki prompt`（CLI）拿到一段可直接粘贴的文本，
写进宿主自己的「自定义指令 / 系统提示词 / 项目 AGENTS.md」即可——换任何宿主都是同一招。

## 测试

```bash
cd packages/mcp && npm install && npm test
# parity：14 个工具名/参数/描述与 DSH 插件对拍 + wiki_list/search/get/help 输出逐字节一致
# server：initialize instructions、tools/list、门控、（un)confirmed 写入、进程级 wiki_use、非 git 库的 sync 报错、
#         MCP 写 → CLI 读回的跨形态一致性、手写协议帧验证 stdout 纯净
```

## 相关

- 数据格式：[`schema.md`](../../schema.md)（OKF v0.2 对齐）
- 目录规则与注入机制：[`SPEC-EXTENSIONS.md`](../../SPEC-EXTENSIONS.md)
- 另三形态：DSH 插件 [`packages/dsh`](../dsh)、pi 扩展 [`packages/pi`](../pi)、skill + CLI [`packages/skill`](../skill)
