import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWiki as createCodexWiki } from '../lib/tools.mjs'
import { loadCore as loadCodexCore } from '../lib/core.mjs'
import { createWiki as createMcpWiki } from '../../mcp/lib/tools.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(ROOT, '..', '..')
const DEMO = join(REPO, 'examples', 'demo-bundle')

describe('Codex 与 MCP/DSH 工具契约对拍', () => {
  let tmp
  let codex
  let mcp

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'codex-wiki-parity-'))
    await cp(DEMO, tmp, { recursive: true })
    const core = await loadCodexCore()
    const config = { dataDir: tmp }
    codex = createCodexWiki({ core, config, version: '0.6.3', producer: 'codex-wiki' })
    mcp = createMcpWiki({ core, config })
  })

  after(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  test('工具名、描述与参数 schema 完全一致', () => {
    assert.deepStrictEqual([...codex.tools.keys()].sort(), [...mcp.tools.keys()].sort())
    for (const name of codex.tools.keys()) {
      const a = codex.tools.get(name)
      const b = mcp.tools.get(name)
      assert.equal(a.description, b.description, `${name} 描述漂移`)
      assert.deepStrictEqual(a.parameters, b.parameters, `${name} 参数 schema 漂移`)
    }
  })

  test('只读工具输出完全一致', async () => {
    for (const [name, args] of [
      ['wiki_list', {}],
      ['wiki_search', { query: '销售额' }],
      ['wiki_get', { id: 'tables/orders' }],
      ['wiki_validate', {}],
    ]) {
      const a = await codex.tools.get(name).run(args)
      const b = await mcp.tools.get(name).run(args)
      assert.equal(a.text, b.text, `${name} 输出漂移`)
    }
  })
})
