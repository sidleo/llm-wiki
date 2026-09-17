/**
 * server.mjs —— MCP 服务端装配（低层 Server API）。
 *
 * 用低层 `Server` + `setRequestHandler` 而不是高层 `McpServer`：工具参数是**纯 JSON Schema**
 * （直接复用 dsh 那份 parameters 对象），不经 zod→JSON Schema 转换，于是四形态的参数定义
 * 可以做 deepStrictEqual 对拍（见 test/parity.test.mjs）。
 *
 * 注入：initialize 响应的 `instructions`（恒定引导 + 当前 bundle/目录/APPEND 规则）。
 * 协议只在连接时下发一次，之后靠 wiki_rules 与 get/create/update 响应附带规则兜住。
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createWiki } from './tools.mjs'
import { SECTION_TEXT, buildInstructions } from './instructions.mjs'
import { MCP_VERSION } from './config.mjs'

/**
 * 装配 server（不连接传输，便于测试与 --check）。
 * @param {{core:object, config?:object}} deps
 * @returns {Promise<{server:Server, wiki:object, instructions:string, active:object}>}
 */
export async function createWikiServer({ core, config = {} }) {
  const wiki = createWiki({ core, config })

  let active = null
  let instructions = SECTION_TEXT
  try {
    active = await wiki.state.globalActive()
    instructions = await buildInstructions({ core, active })
  } catch {
    // 解析不出 bundle（路径不存在/注册表异常）：只下发恒定层，工具调用时再报具体错误
  }

  const server = new Server(
    { name: 'mcp-wiki', version: MCP_VERSION },
    { capabilities: { tools: {} }, instructions },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...wiki.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req && req.params ? req.params.name : ''
    const tool = wiki.tools.get(String(name))
    if (!tool) {
      return {
        content: [{ type: 'text', text: `未知工具：${name}。可用：${[...wiki.tools.keys()].join(' | ')}` }],
        isError: true,
      }
    }
    try {
      const r = await tool.run((req.params && req.params.arguments) || {})
      return { content: [{ type: 'text', text: r.text }] }
    } catch (e) {
      // 工具内的 core 调用已各自兜错；这里是最后一道，绝不把异常抛成协议级错误
      return { content: [{ type: 'text', text: `错误：${e && e.message ? e.message : String(e)}` }], isError: true }
    }
  })

  return { server, wiki, instructions, active }
}
