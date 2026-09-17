/**
 * parity.test.mjs —— MCP 形态 vs DSH 插件的工具定义/输出对拍（防四形态漂移）。
 *
 * 断言三件事：
 * 1) 14 个工具名集合一致；
 * 2) 参数 schema 结构一致（除 wiki_dirs/wiki_use/wiki_rules/wiki_sync 这 4 个改写措辞的
 *    工具外，其余连描述文字都逐字一致）；
 * 3) 同一 bundle 上 wiki_list / wiki_search / wiki_get 的输出文本逐字节一致。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ROOT, DEMO, TOOL_NAMES, DIVERGENT, loadDshTools, stripDescriptions } from './helpers.mjs'
import { createWiki } from '../lib/tools.mjs'
import { loadCore } from '../lib/core.mjs'
import { MCP_VERSION } from '../lib/config.mjs'

describe('MCP 形态与 DSH 插件对拍', () => {
  let tmp
  let prevReg
  let mcp // createWiki 的返回
  let dsh // Map<name, tool>
  let core

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'mcp-parity-'))
    await cp(DEMO, tmp, { recursive: true })
    prevReg = process.env.WIKI_REGISTRY_FILE
    process.env.WIKI_REGISTRY_FILE = join(tmp, 'reg.json')
    core = await loadCore()
    mcp = createWiki({ core, config: { dataDir: tmp } })
    dsh = await loadDshTools({ dataDir: tmp })
  })

  after(async () => {
    if (prevReg === undefined) delete process.env.WIKI_REGISTRY_FILE
    else process.env.WIKI_REGISTRY_FILE = prevReg
    await rm(tmp, { recursive: true, force: true })
  })

  test('版本号与 package.json 一致', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
    assert.equal(MCP_VERSION, pkg.version)
  })

  test('工具名集合一致（14 个）', () => {
    assert.deepStrictEqual([...mcp.tools.keys()].sort(), [...TOOL_NAMES].sort())
    assert.deepStrictEqual([...dsh.keys()].sort(), [...TOOL_NAMES].sort())
  })

  test('参数 schema 一致（分歧工具只允许措辞差异）', () => {
    for (const name of TOOL_NAMES) {
      const mine = mcp.tools.get(name)
      const theirs = dsh.get(name)
      if (DIVERGENT.has(name)) {
        assert.deepStrictEqual(
          stripDescriptions(mine.parameters),
          stripDescriptions(theirs.parameters),
          `${name} 的参数结构漂了`,
        )
      } else {
        assert.deepStrictEqual(mine.parameters, theirs.parameters, `${name} 的参数 schema 漂了`)
      }
    }
  })

  test('工具描述逐字一致（分歧工具除外，且必须非空）', () => {
    for (const name of TOOL_NAMES) {
      const mine = mcp.tools.get(name)
      const theirs = dsh.get(name)
      assert.ok(mine.description && mine.description.length > 0, `${name} 描述为空`)
      if (!DIVERGENT.has(name)) {
        assert.equal(mine.description, theirs.description, `${name} 的描述漂了`)
      }
    }
  })

  test('wiki_list / wiki_search / wiki_get 输出与 DSH 逐字节一致', async () => {
    const cases = [
      ['wiki_list', {}],
      ['wiki_list', { type: 'Table' }],
      ['wiki_search', { query: '销售额' }],
      ['wiki_search', { query: 'revenue' }],
      ['wiki_search', { query: '不存在的内容xyz' }],
      ['wiki_get', { id: 'tables/orders' }],
      ['wiki_validate', {}],
    ]
    for (const [name, args] of cases) {
      const a = await mcp.tools.get(name).run(args)
      const b = await dsh.get(name).execute(args, {})
      assert.equal(a.text, b.text, `${name}(${JSON.stringify(args)}) 输出不一致`)
    }
  })

  test('wiki_help 输出一致（同一份 core 文档）', async () => {
    for (const topic of ['quickstart', 'gate', 'bundle', 'sync']) {
      const a = await mcp.tools.get('wiki_help').run({ topic })
      const b = await dsh.get('wiki_help').execute({ topic }, {})
      assert.equal(a.text, b.text, `wiki_help ${topic} 输出不一致`)
    }
  })
})
