/**
 * server.test.mjs —— MCP 形态端到端（真实 stdio 子进程 + 官方 SDK 客户端）。
 *
 * 覆盖：initialize/instructions（恒定引导 + bundle/目录/APPEND 规则）、tools/list（14 个）、
 * 检索类工具输出、写入门控（无 confirmed → 需确认；带 confirmed → human verified）、
 * wiki_use 进程态切换与 global 持久化、wiki_sync 在非 git bundle 上的可读报错、
 * 跨形态读回（MCP 写 → CLI 读）、以及 stdout 只含 JSON-RPC。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { BIN, CLI, DEMO, TOOL_NAMES, waitFor } from './helpers.mjs'

const APPEND_TEXT = '# 表规则\n\n用前先 DESCRIBE 核对线上结构。\n'
const GATE_AGENTS = '# 测试库规则\n\n## 门控\n- 需 human 确认: Metric\n'

function env(regFile) {
  return { ...process.env, WIKI_REGISTRY_FILE: regFile }
}

describe('MCP server 端到端（stdio）', () => {
  let tmp
  let tmp2
  let regDir
  let regFile
  let client
  let transport

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'mcp-wiki-'))
    tmp2 = await mkdtemp(join(tmpdir(), 'mcp-wiki2-'))
    regDir = await mkdtemp(join(tmpdir(), 'mcp-wiki-reg-'))
    regFile = join(regDir, 'reg.json')
    await cp(DEMO, tmp, { recursive: true })
    await cp(DEMO, tmp2, { recursive: true })
    await writeFile(join(tmp, 'AGENTS.md'), GATE_AGENTS, 'utf8')
    await writeFile(join(tmp, 'tables', 'APPEND_SYSTEM_PROMPT.md'), APPEND_TEXT, 'utf8')

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, '--data-dir', tmp, '--bundles', `其他=${tmp2}`],
      env: env(regFile),
      stderr: 'pipe',
    })
    client = new Client({ name: 'wiki-mcp-test', version: '1.0.0' })
    await client.connect(transport)
  })

  after(async () => {
    try { await client?.close() } catch { /* 已关闭 */ }
    await rm(tmp, { recursive: true, force: true })
    await rm(tmp2, { recursive: true, force: true })
    await rm(regDir, { recursive: true, force: true })
  })

  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    return { text: r.content.map((c) => c.text || '').join('\n'), isError: r.isError === true }
  }

  test('initialize：instructions 含恒定引导 + 当前库 + APPEND 规则', () => {
    const instructions = client.getInstructions()
    assert.ok(instructions, 'instructions 为空')
    assert.match(instructions, /【硬要求】.*wiki_list/)
    assert.match(instructions, /工具名以 `wiki_` 开头/)
    assert.match(instructions, new RegExp(`当前知识库：default（${tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}）`))
    assert.match(instructions, /可用目录：.*tables/)
    assert.match(instructions, /【知识库自定义规则】/)
    assert.match(instructions, /用前先 DESCRIBE 核对线上结构。/)
    assert.equal(client.getServerVersion().name, 'mcp-wiki')
  })

  test('tools/list：14 个工具，名字与 DSH 版一致', async () => {
    const { tools } = await client.listTools()
    assert.deepStrictEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort())
    const get = tools.find((t) => t.name === 'wiki_get')
    assert.deepStrictEqual(get.inputSchema.required, ['id'])
    assert.equal(get.inputSchema.properties.id.type, 'string')
  })

  test('wiki_list / wiki_search / wiki_get 正常返回', async () => {
    const list = await call('wiki_list')
    assert.match(list.text, /\[tables\]/)
    assert.match(list.text, /共 11 个概念。/)

    const search = await call('wiki_search', { query: '销售额' })
    assert.match(search.text, /pitfalls\/join-inflation/)

    const miss = await call('wiki_search', { query: '不存在的内容xyz' })
    assert.match(miss.text, /无匹配/)

    const got = await call('wiki_get', { id: 'tables/orders' })
    assert.match(got.text, /^# .+\(tables\/orders\)/)
    assert.match(got.text, /--- backlinks \(\d+\) ---/)
    assert.match(got.text, /--- body ---/)
  })

  test('写入门控：Metric 无 confirmed 被拦，带 confirmed 落盘 human verified', async () => {
    const blocked = await call('wiki_create', { path: 'metrics/mcp-gate-test', type: 'Metric', body: '# Computation\n\nx\n' })
    assert.match(blocked.text, /该写入需用户确认/)
    assert.match(blocked.text, /Metric/)

    const ok = await call('wiki_create', {
      path: 'metrics/mcp-gate-test', type: 'Metric', body: '# Computation\n\nx\n',
      confirmed: true, user: 'tester',
    })
    assert.match(ok.text, /已创建 metrics\/mcp-gate-test/)
    const written = await readFile(join(tmp, 'metrics', 'mcp-gate-test.md'), 'utf8')
    assert.match(written, /human:tester/)
    assert.match(written, /type: Metric/)
  })

  test('探查事实自动记录：Table 无需确认，producer 标 mcp-wiki', async () => {
    const r = await call('wiki_create', { path: 'tables/mcp-probe-test', type: 'Table', body: '# Schema\n\n| a |\n|---|\n' })
    assert.match(r.text, /已创建 tables\/mcp-probe-test/)
    const written = await readFile(join(tmp, 'tables', 'mcp-probe-test.md'), 'utf8')
    assert.match(written, /agent:mcp-wiki\/0\.4\.11/)
    assert.doesNotMatch(written, /verified/)
  })

  test('跨形态：MCP 写入的内容 CLI 能读到', async () => {
    const res = spawnSync(process.execPath, [CLI, 'get', 'metrics/mcp-gate-test', '--dataDir', tmp], {
      encoding: 'utf8',
      env: env(regFile),
    })
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /mcp-gate-test/)
    assert.match(res.stdout, /type: Metric/)
    // CLI/get 输出不带 frontmatter 的 verified 字段：这一条只证明「同一份 bundle 读得到」
    const raw = await readFile(join(tmp, 'metrics', 'mcp-gate-test.md'), 'utf8')
    assert.match(raw, /human:tester/)
  })

  test('wiki_dirs / wiki_use：进程级切换 + global 持久化', async () => {
    const before = await call('wiki_dirs')
    assert.match(before.text, /\[其他\]/)
    assert.match(before.text, new RegExp(`当前生效目录：${tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

    const used = await call('wiki_use', { name: '其他' })
    assert.match(used.text, /已切换到 其他/)
    assert.match(used.text, /进程级/)
    // instructions 不会自动更新：切库后的规则随本次结果送达
    assert.match(used.text, /当前知识库：其他/)

    const after = await call('wiki_dirs')
    assert.match(after.text, /← 当前进程/)

    const listNow = await call('wiki_list')
    assert.match(listNow.text, /共 11 个概念。/) // 已切到 tmp2（同为 demo 副本）

    const global = await call('wiki_use', { name: '其他', global: true })
    assert.match(global.text, /已持久化为全局默认/)
    const reg = JSON.parse(await readFile(regFile, 'utf8'))
    assert.equal(reg.active, '其他')

    const unknown = await call('wiki_use', { name: '不存在的库' })
    assert.match(unknown.text, /错误：未知 bundle/)
  })

  test('wiki_sync 在非 git bundle 上给可读报错（不抛协议错误）', async () => {
    const r = await call('wiki_sync', { action: 'status' })
    assert.equal(r.isError, false)
    assert.match(r.text, /同步状态：不可用/)
  })

  test('未知工具返回 isError + 可用清单（不抛协议错误）', async () => {
    const r = await call('wiki_nope')
    assert.equal(r.isError, true)
    assert.match(r.text, /未知工具：wiki_nope/)
    assert.match(r.text, /wiki_list/)
  })

  test('wiki_validate / wiki_lint 可用', async () => {
    const v = await call('wiki_validate')
    assert.match(v.text, /OKF v0\.2 合规 ✓/)
    const l = await call('wiki_lint')
    assert.match(l.text, /summary: \{/)
  })
})

describe('stdio 协议纯净性', () => {
  let tmp
  let regDir

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'mcp-wiki-raw-'))
    regDir = await mkdtemp(join(tmpdir(), 'mcp-wiki-raw-reg-'))
    await cp(DEMO, tmp, { recursive: true })
  })

  after(async () => {
    await rm(tmp, { recursive: true, force: true })
    await rm(regDir, { recursive: true, force: true })
  })

  test('stdout 的每一行都是 JSON-RPC（手写协议帧，不经 SDK 客户端）', async () => {
    const child = spawn(process.execPath, [BIN, '--data-dir', tmp], {
      env: env(join(regDir, 'reg.json')),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })

    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1.0.0' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wiki_list', arguments: {} } })

    const done = await waitFor(() => out.includes('"id":3'))
    child.kill()
    assert.ok(done, `未收到 id:3 响应；stdout=${out}\nstderr=${err}`)

    const lines = out.split('\n').filter(Boolean)
    assert.ok(lines.length >= 3, `响应行数不足：${lines.length}`)
    const frames = lines.map((l) => JSON.parse(l)) // 任何一行非 JSON 都会抛
    for (const f of frames) assert.equal(f.jsonrpc, '2.0')

    const init = frames.find((f) => f.id === 1)
    assert.equal(typeof init.result.protocolVersion, 'string')
    assert.equal(init.result.serverInfo.name, 'mcp-wiki')
    assert.match(init.result.instructions, /wiki_list/)
    assert.deepStrictEqual(init.result.capabilities.tools, {})

    const list = frames.find((f) => f.id === 2)
    assert.equal(list.result.tools.length, 14)

    const call = frames.find((f) => f.id === 3)
    assert.match(call.result.content[0].text, /共 11 个概念。/)
  })
})
