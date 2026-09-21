import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(ROOT, '..', '..')
const BIN = join(ROOT, 'bin', 'wiki-mcp.mjs')
const DEMO = join(REPO, 'examples', 'demo-bundle')
const TOOL_NAMES = [
  'wiki_list', 'wiki_search', 'wiki_get', 'wiki_create', 'wiki_update',
  'wiki_validate', 'wiki_lint', 'wiki_ingest', 'wiki_deprecate', 'wiki_rules',
  'wiki_dirs', 'wiki_use', 'wiki_help', 'wiki_sync',
]

describe('Codex MCP 服务端', () => {
  let tmp
  let regDir

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'codex-wiki-'))
    regDir = await mkdtemp(join(tmpdir(), 'codex-wiki-reg-'))
    await cp(DEMO, tmp, { recursive: true })
    await writeFile(join(tmp, 'tables', 'APPEND_SYSTEM_PROMPT.md'), '# 表规则\n\n先核对结构。\n', 'utf8')
  })

  after(async () => {
    await rm(tmp, { recursive: true, force: true })
    await rm(regDir, { recursive: true, force: true })
  })

  test('--check 输出数据目录、instructions 与 14 个工具', () => {
    const r = spawnSync(process.execPath, [BIN, '--check', '--data-dir', tmp], {
      env: { ...process.env, WIKI_REGISTRY_FILE: join(regDir, 'reg.json') },
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /wiki-mcp 0\.6\.3/)
    assert.match(r.stdout, /先核对结构/)
    assert.match(r.stdout, /wiki_list/)
    assert.match(r.stdout, new RegExp(`--- tools（${TOOL_NAMES.length}）---`))
  })

  test('stdio JSON-RPC：initialize / tools-list / tools-call / unknown', async () => {
    const child = spawn(process.execPath, [BIN, '--data-dir', tmp], {
      env: { ...process.env, WIKI_REGISTRY_FILE: join(regDir, 'reg.json') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })
    const send = (message) => child.stdin.write(JSON.stringify(message) + '\n')

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wiki_list', arguments: {} } })
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'wiki_nope', arguments: {} } })

    const deadline = Date.now() + 10000
    while (!out.includes('"id":4') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    child.kill()
    await new Promise((resolve) => child.once('close', resolve))

    const lines = out.split('\n').filter(Boolean)
    const frames = lines.map((line) => JSON.parse(line))
    assert.ok(err.length < 2000)
    const init = frames.find((f) => f.id === 1)
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.equal(init.result.serverInfo.name, 'codex-wiki')
    assert.match(init.result.instructions, /先核对结构/)
    assert.deepStrictEqual(init.result.capabilities.tools, {})

    const list = frames.find((f) => f.id === 2)
    assert.deepStrictEqual(list.result.tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort())

    const call = frames.find((f) => f.id === 3)
    assert.match(call.result.content[0].text, /共 11 个概念/)

    const unknown = frames.find((f) => f.id === 4)
    assert.equal(unknown.result.isError, true)
    assert.match(unknown.result.content[0].text, /未知工具：wiki_nope/)
  })
})
