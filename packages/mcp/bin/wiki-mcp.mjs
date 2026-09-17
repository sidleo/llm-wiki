#!/usr/bin/env node
/**
 * wiki-mcp —— llm-wiki 知识库的 MCP 服务端（stdio）。
 *
 * 用法：
 *   node /abs/path/to/packages/mcp/bin/wiki-mcp.mjs            # stdio 服务（宿主配置里用这个）
 *   node /abs/path/to/packages/mcp/bin/wiki-mcp.mjs --check    # 安装自检：打印生效目录/规则/工具清单后退出
 *
 * 参数：
 *   --data-dir DIR | --dataDir DIR   数据目录（缺省 $WIKI_DATA_DIR 或 ~/.agents/wiki）
 *   --bundles 名=路径[,名2=路径2]     声明命名 bundle（与注册表合并，同名优先）
 *   --version / --help
 *
 * 【硬约束】stdout 是 JSON-RPC 通道：任何日志只能写 stderr，否则会污染协议流。
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildConfig, DEFAULTS, MCP_VERSION } from '../lib/config.mjs'
import { loadCore } from '../lib/core.mjs'
import { createWikiServer } from '../lib/server.mjs'

const argv = process.argv.slice(2)

const HELP = `wiki-mcp ${MCP_VERSION} —— llm-wiki 知识库 MCP 服务端（stdio）

用法：
  wiki-mcp [--data-dir DIR] [--bundles 名=路径[,名=路径]] [--check]

选项：
  --data-dir, --dataDir DIR   数据目录（缺省 $WIKI_DATA_DIR 或 ~/.agents/wiki）
  --bundles SPEC              声明命名 bundle，如 --bundles 工作=/abs/wiki,个人=~/notes/wiki
  --check                     打印生效目录 / instructions / 工具清单后退出（安装自检）
  --version, --help

环境变量：WIKI_DATA_DIR / WIKI_BUNDLES / WIKI_REGISTRY_FILE / WIKI_LARK_BIN
数据目录默认：${DEFAULTS.dataDir}
`

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(HELP)
  process.exit(0)
}
if (argv.includes('--version') || argv.includes('-V')) {
  process.stdout.write(MCP_VERSION + '\n')
  process.exit(0)
}

// 任何异常都只进 stderr：stdout 归 JSON-RPC
process.on('unhandledRejection', (e) => {
  process.stderr.write(`wiki-mcp unhandledRejection: ${e && e.stack ? e.stack : e}\n`)
})
process.on('uncaughtException', (e) => {
  process.stderr.write(`wiki-mcp uncaughtException: ${e && e.stack ? e.stack : e}\n`)
})

try {
  const config = buildConfig({ argv })
  const core = await loadCore()
  const { server, wiki, instructions, active } = await createWikiServer({ core, config })

  if (argv.includes('--check')) {
    const lines = [
      `wiki-mcp ${MCP_VERSION}`,
      `数据目录：${config.dataDir}`,
      `命名 bundle：${Object.keys(config.dataDirs).length ? Object.keys(config.dataDirs).join('、') : '（仅注册表）'}`,
      `当前生效：${active ? `${active.name}（${active.kind}）→ ${active.path}` : '（无法解析，见下）'}`,
      '',
      `--- instructions（${instructions.length} 字符）---`,
      instructions,
      '',
      `--- tools（${wiki.tools.size}）---`,
      ...[...wiki.tools.values()].map((t) => `  ${t.name}  (${Object.keys(t.parameters.properties || {}).join(', ') || '无参数'})`),
      '',
      'OK：把 bin/wiki-mcp.mjs 配进宿主的 MCP 配置即可（command 用 node 绝对路径）。',
    ]
    process.stdout.write(lines.join('\n') + '\n')
    process.exit(0)
  }

  await server.connect(new StdioServerTransport())
} catch (e) {
  process.stderr.write(`wiki-mcp 启动失败：${e && e.stack ? e.stack : e}\n`)
  process.exit(1)
}
