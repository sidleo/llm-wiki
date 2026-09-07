/**
 * tests/dsh-mock-test.mjs —— DSH 插件宿主无关验证（mock ctx）。
 *
 * 不依赖真实 dsh web 运行时：构造最小 ctx（on/工具注册表），
 * 验证 apply 注册 10 个工具、描述层 section 组装、关键工具可执行。
 */

import { mkdtemp, rm, cp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const plugin = await import(join(__dirname, '..', 'packages', 'dsh', 'wiki.mjs'))

let passed = 0
let failed = 0
const failures = []
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
  await cp(join(__dirname, '..', 'examples', 'demo-bundle'), tmp, { recursive: true })

  // mock ctx
  const tools = new Map()
  const handlers = {}
  const ctx = {
    on(evt, fn) { handlers[evt] = fn },
    tools: {
      register(t) { tools.set(t.name, t) },
    },
    systemPrompt: {},
  }

  const assembly = { sections: [] }
  plugin.apply(ctx, { dataDir: tmp })

  check('插件名 wiki-registry', plugin.name === 'wiki-registry')
  check('依赖 systemPrompt/tools', plugin.inject.join(',') === 'systemPrompt,tools')
  const expected = ['wiki_list', 'wiki_search', 'wiki_get', 'wiki_create', 'wiki_update', 'wiki_validate', 'wiki_lint', 'wiki_ingest', 'wiki_deprecate', 'wiki_rules']
  check('注册 10 个工具', expected.every((n) => tools.has(n)) && tools.size === 10, `got ${tools.size}`)

  // 描述层组装
  await handlers['system-prompt/assemble'](assembly, {}, async () => {})
  const section = assembly.sections.find((s) => s.name === 'wiki-registry')
  check('描述层注入', section && section.text.includes('llm-wiki'))
  check('描述层含数据源路径', section && section.text.includes(tmp))

  // 执行关键工具
  const list = await tools.get('wiki_list').execute({})
  check('wiki_list 返回概念', /11 个概念|concepts/.test(list.text) || list.text.includes('orders'))

  const search = await tools.get('wiki_search').execute({ query: 'revenue' })
  check('wiki_search 命中', search.text.includes('computations/revenue'))

  const got = await tools.get('wiki_get').execute({ id: 'tables/orders' })
  check('wiki_get 含 backlinks 坑点', got.text.includes('pitfalls/join-inflation'))

  const val = await tools.get('wiki_validate').execute({})
  check('wiki_validate 合规', val.text.includes('OKF v0.2 合规'))

  // create 门控：Attested Computation 在根 AGENTS.md 声明需 human 确认 → 未 confirmed 被拦
  const gate = await tools.get('wiki_create').execute({ path: 'computations/rev-x', type: 'Attested Computation', title: 'x', description: 'd' })
  check('口径类未确认被门控拦截', /需用户确认|human 确认/.test(gate.text), gate.text)

  const createOk = await tools.get('wiki_create').execute({
    path: 'tables/probe_x', type: 'Table', title: 'probe', description: 'p', confirmed: true, user: 'tester',
  })
  check('Table 确认后创建成功', /已创建/.test(createOk.text), createOk.text)
  const fileText = await readFile(join(tmp, 'tables', 'probe_x.md'), 'utf8')
  check('创建文件含 verified human', fileText.includes('verified') && fileText.includes('tester'))

  await rm(tmp, { recursive: true, force: true })
  console.log(`\n结果: ${passed} passed, ${failed} failed`)
  if (failed) { console.log('失败:', failures.join(' | ')); process.exit(1) }
}

await main().catch((e) => { console.error(e); process.exit(1) })
