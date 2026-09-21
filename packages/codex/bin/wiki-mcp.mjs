#!/usr/bin/env node
/**
 * wiki-mcp —— Codex 插件内置的 llm-wiki MCP 服务端（stdio）。
 *
 * 这是零运行时依赖的 MCP stdio transport：直接实现 MCP 所需的 JSON-RPC 消息
 * （initialize / ping / tools-list / tools-call），工具实现复用同步进来的
 * packages/mcp/lib/tools.mjs，保证与 DSH / Pi / MCP / Skill 形态同名同参同输出。
 *
 * 用法：
 *   node bin/wiki-mcp.mjs            # 由插件 .mcp.json 启动
 *   node bin/wiki-mcp.mjs --check    # 安装自检
 *
 * 【硬约束】stdout 只允许输出 JSON-RPC；日志一律写 stderr。
 */

import { createInterface } from 'node:readline'
import { buildConfig, DEFAULTS, MCP_VERSION, PRODUCER } from '../lib/config.mjs'
import { loadCore } from '../lib/core.mjs'
import { createWiki } from '../lib/tools.mjs'
import { SECTION_TEXT, buildInstructions } from '../lib/instructions.mjs'

const argv = process.argv.slice(2)
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0]

const HELP = `wiki-mcp ${MCP_VERSION} —— llm-wiki Codex 插件 MCP 服务端（stdio）

用法：
  wiki-mcp [--data-dir DIR] [--bundles 名=路径[,名=路径]] [--check]

选项：
  --data-dir, --dataDir DIR   数据目录（缺省 $WIKI_DATA_DIR 或 ~/.agents/wiki）
  --bundles SPEC              声明命名 bundle，如 --bundles 工作=/abs/wiki,个人=~/notes/wiki
  --check                     打印生效目录 / instructions / 工具清单后退出
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

/** 输出一行 JSON-RPC。 */
function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

/** 构造并处理当前 Codex 知识库服务。 */
async function main() {
  const config = buildConfig({ argv })
  const core = await loadCore()
  const wiki = createWiki({ core, config, version: MCP_VERSION, producer: PRODUCER })

  let active = null
  let instructions = SECTION_TEXT
  try {
    active = await wiki.state.globalActive()
    instructions = await buildInstructions({ core, active })
  } catch {
    // bundle 不可读时仍启动协议层，工具调用时会返回可读错误。
  }

  if (argv.includes('--check')) {
    const lines = [
      `wiki-mcp ${MCP_VERSION}`,
      `数据目录：${config.dataDir}`,
      `命名 bundle：${Object.keys(config.dataDirs).length ? Object.keys(config.dataDirs).join('、') : '（仅注册表）'}`,
      `当前生效：${active ? `${active.name}（${active.kind}）→ ${active.path}` : '（无法解析）'}`,
      '',
      `--- instructions（${instructions.length} 字符）---`,
      instructions,
      '',
      `--- tools（${wiki.tools.size}）---`,
      ...[...wiki.tools.values()].map((t) => `  ${t.name}  (${Object.keys(t.parameters.properties || {}).join(', ') || '无参数'})`),
      '',
      'OK：.mcp.json 已指向本文件。',
    ]
    process.stdout.write(lines.join('\n') + '\n')
    return null
  }

  const ok = (id, result) => writeMessage({ jsonrpc: '2.0', id, result })
  const fail = (id, code, message) => writeMessage({ jsonrpc: '2.0', id, error: { code, message } })

  async function handle(message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
        fail(message.id ?? null, -32600, 'Invalid Request')
      }
      return
    }

    const { id, method, params = {} } = message
    const notification = !Object.prototype.hasOwnProperty.call(message, 'id')

    if (notification) return
    try {
      if (method === 'initialize') {
        const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL
        ok(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'codex-wiki', title: 'LLM Wiki', version: MCP_VERSION },
          instructions,
        })
        return
      }

      if (method === 'ping' || method === 'logging/setLevel' || method === 'shutdown') {
        ok(id, {})
        return
      }

      if (method === 'tools/list') {
        ok(id, {
          tools: [...wiki.tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
          })),
        })
        return
      }

      if (method === 'tools/call') {
        const name = String(params && params.name ? params.name : '')
        const tool = wiki.tools.get(name)
        if (!tool) {
          ok(id, {
            content: [{ type: 'text', text: `未知工具：${name}。可用：${[...wiki.tools.keys()].join(' | ')}` }],
            isError: true,
          })
          return
        }
        try {
          const result = await tool.run((params && params.arguments) || {})
          ok(id, { content: [{ type: 'text', text: result.text }] })
        } catch (e) {
          ok(id, {
            content: [{ type: 'text', text: `错误：${e && e.message ? e.message : String(e)}` }],
            isError: true,
          })
        }
        return
      }

      fail(id, -32601, `Method not found: ${method}`)
    } catch (e) {
      fail(id, -32603, e && e.message ? e.message : String(e))
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let chain = Promise.resolve()
  rl.on('line', (line) => {
    const raw = line.trim()
    if (!raw) return
    chain = chain.then(async () => {
      let message
      try {
        message = JSON.parse(raw)
      } catch (e) {
        writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${e.message}` } })
        return
      }
      await handle(message)
    })
  })
  rl.on('close', () => {
    chain.finally(() => process.exit(0))
  })
  return null
}

main().catch((e) => {
  process.stderr.write(`wiki-mcp 启动失败：${e && e.stack ? e.stack : e}\n`)
  process.exit(1)
})
