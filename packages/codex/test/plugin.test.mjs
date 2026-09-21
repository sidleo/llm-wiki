import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCore } from '../lib/core.mjs'
import { createWiki } from '../lib/tools.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(ROOT, '..', '..')
const TOOL_NAMES = [
  'wiki_list', 'wiki_search', 'wiki_get', 'wiki_create', 'wiki_update',
  'wiki_validate', 'wiki_lint', 'wiki_ingest', 'wiki_deprecate', 'wiki_rules',
  'wiki_dirs', 'wiki_use', 'wiki_help', 'wiki_sync',
]

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

describe('Codex plugin 结构', () => {
  test('manifest 声明 skill 与内置 MCP，且字段可被 plugin-creator 接受', async () => {
    const plugin = await readJson(join(ROOT, '.codex-plugin', 'plugin.json'))
    assert.equal(plugin.name, 'codex')
    assert.match(plugin.version, /^0\.6\.3(?:\+codex\..+)?$/)
    assert.equal(plugin.skills, './skills/')
    assert.equal(plugin.mcpServers, './.mcp.json')
    assert.deepEqual(plugin.interface.capabilities, ['Read', 'Write'])
    assert.equal('hooks' in plugin, false, 'hooks 走 Codex 默认的 hooks/hooks.json 发现')
  })

  test('.mcp.json 使用插件根目录启动自包含服务', async () => {
    const mcp = await readJson(join(ROOT, '.mcp.json'))
    assert.deepEqual(mcp.mcpServers.wiki, {
      command: 'node',
      args: ['./bin/wiki-mcp.mjs'],
      cwd: '.',
    })
  })

  test('hooks 同时覆盖会话建立与每轮规则刷新', async () => {
    const hooks = await readJson(join(ROOT, 'hooks', 'hooks.json'))
    assert.ok(hooks.hooks.SessionStart)
    assert.ok(hooks.hooks.UserPromptSubmit)
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      const command = hooks.hooks[event][0].hooks[0]
      assert.equal(command.type, 'command')
      assert.match(command.command, /\$\{PLUGIN_ROOT\}\/hooks\/inject-context\.mjs/)
      assert.equal(command.additionalContextLimit, 3500)
    }
  })

  test('skill 与插件入口可加载，并注册 14 个 wiki 工具', async () => {
    const skill = await readFile(join(ROOT, 'skills', 'wiki', 'SKILL.md'), 'utf8')
    assert.match(skill, /^---\nname: wiki/m)
    assert.match(skill, /wiki_list/)
    const core = await loadCore()
    const wiki = createWiki({ core, config: { dataDir: join(REPO, 'examples', 'demo-bundle') } })
    assert.deepStrictEqual([...wiki.tools.keys()].sort(), [...TOOL_NAMES].sort())
  })
})
