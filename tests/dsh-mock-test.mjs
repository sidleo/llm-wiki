/**
 * tests/dsh-mock-test.mjs —— DSH 插件宿主无关验证（mock ctx）。
 *
 * 不依赖真实 dsh web 运行时：构造最小 ctx（on/工具注册表），
 * 验证 apply 注册 13 个工具、描述层 section 组装、关键工具可执行、
 * 多目录 wiki_dirs/wiki_use（会话级切换 + 全局持久）。
 */

import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises'
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
  const tmp2 = await mkdtemp(join(tmpdir(), 'dsh-wiki2-'))
  const regTmp = await mkdtemp(join(tmpdir(), 'dsh-wiki-reg-'))
  await cp(join(__dirname, '..', 'examples', 'demo-bundle'), tmp, { recursive: true })
  await cp(join(__dirname, '..', 'examples', 'demo-bundle'), tmp2, { recursive: true })
  const prevReg = process.env.WIKI_REGISTRY_FILE
  process.env.WIKI_REGISTRY_FILE = join(regTmp, 'reg.json')

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
  plugin.apply(ctx, { dataDir: tmp, dataDirs: { demo: tmp, other: tmp2 } })

  check('插件名 wiki-registry', plugin.name === 'wiki-registry')
  check('依赖 systemPrompt/tools', plugin.inject.join(',') === 'systemPrompt,tools')
  const expected = ['wiki_list', 'wiki_search', 'wiki_get', 'wiki_create', 'wiki_update', 'wiki_validate', 'wiki_lint', 'wiki_ingest', 'wiki_deprecate', 'wiki_rules', 'wiki_help', 'wiki_dirs', 'wiki_use']
  check('注册 13 个工具', expected.every((n) => tools.has(n)) && tools.size === 13, `got ${tools.size}`)

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

  // 门控数据化：默认无声明时自动记录
  const autoGate = await tools.get('wiki_create').execute({ path: 'computations/rev-x', type: 'Attested Computation', title: 'x', description: 'd' })
  check('无门控声明时默认自动记录', /已创建/.test(autoGate.text), autoGate.text)

  // 在 bundle 根写入带门控节的 AGENTS.md → 口径类未 confirmed 被拦
  await writeFile(join(tmp, 'AGENTS.md'), '# 根规则\n\n## 门控\n\n- 需 human 确认: Metric, Attested Computation\n- 自动记录: Table, Pitfall\n', 'utf8')
  const gate = await tools.get('wiki_create').execute({ path: 'computations/rev-y', type: 'Attested Computation', title: 'y', description: 'd' })
  check('口径类未确认被门控拦截', /需用户确认|human 确认/.test(gate.text), gate.text)

  const createOk = await tools.get('wiki_create').execute({
    path: 'tables/probe_x', type: 'Table', title: 'probe', description: 'p', confirmed: true, user: 'tester',
  })
  check('Table 确认后创建成功', /已创建/.test(createOk.text), createOk.text)
  const fileText = await readFile(join(tmp, 'tables', 'probe_x.md'), 'utf8')
  check('创建文件含 verified human', fileText.includes('verified') && fileText.includes('tester'))

  // wiki_help：机制文档自助查询
  const helpAppend = await tools.get('wiki_help').execute({ topic: 'append' })
  check('wiki_help append 讲清注入文件写法', /APPEND_SYSTEM_PROMPT/.test(helpAppend.text) && /正文/.test(helpAppend.text), helpAppend.text.slice(0, 120))
  const helpAgents = await tools.get('wiki_help').execute({ topic: 'agents' })
  check('wiki_help agents 讲清门控节写法', /门控/.test(helpAgents.text), helpAgents.text.slice(0, 120))
  const helpUnknown = await tools.get('wiki_help').execute({ topic: 'nope' })
  check('wiki_help 未知主题回主题列表', /quickstart/.test(helpUnknown.text))

  // ── 多目录：wiki_dirs / wiki_use（会话级隔离 + 全局持久）──
  await writeFile(join(tmp2, 'marker.md'), '---\ntype: Reference\ntitle: marker\n---\n\nmarker body\n', 'utf8')
  const agentA = {}
  const agentB = {}
  const dirs = await tools.get('wiki_dirs').execute({}, { agent: agentA })
  check('wiki_dirs 列出两个 bundle', /\[demo\]/.test(dirs.text) && /\[other\]/.test(dirs.text), dirs.text.slice(0, 200))
  check('wiki_dirs 标记全局默认', /全局默认/.test(dirs.text), dirs.text.slice(0, 200))
  const use = await tools.get('wiki_use').execute({ name: 'other' }, { agent: agentA })
  check('wiki_use 会话级切换', /已切换到 other/.test(use.text) && /会话级/.test(use.text), use.text)
  const listA = await tools.get('wiki_list').execute({}, { agent: agentA })
  check('会话切换后 list 指向 other', listA.text.includes('marker'), 'marker 未命中: ' + listA.text.slice(0, 200))
  const listB = await tools.get('wiki_list').execute({}, { agent: agentB })
  check('其他对话不受会话切换影响', !listB.text.includes('marker'), listB.text.slice(0, 200))
  const dirsA = await tools.get('wiki_dirs').execute({}, { agent: agentA })
  check('wiki_dirs 标记当前会话', /当前会话/.test(dirsA.text), dirsA.text.slice(0, 300))
  // 描述层跟随会话切换：wiki_use 后 assemble（同一 agent）数据源指向 other
  const assembly2 = { sections: [] }
  await handlers['system-prompt/assemble'](assembly2, { agent: agentA }, async () => {})
  const sec2 = assembly2.sections.find((s) => s.name === 'wiki-registry')
  check('描述层跟随会话切换', sec2 && sec2.text.includes(tmp2), (sec2 && sec2.text.slice(0, 120)) || 'no section')
  // 全局持久：无 agent 调用 + global:true → 写注册表；新 agent 默认跟随
  const useGlobal = await tools.get('wiki_use').execute({ name: 'other', global: true }, { agent: agentB })
  check('wiki_use 全局持久', /全局默认/.test(useGlobal.text), useGlobal.text)
  const agentC = {}
  const listC = await tools.get('wiki_list').execute({}, { agent: agentC })
  check('新对话默认跟随注册表 active', listC.text.includes('marker'), listC.text.slice(0, 200))
  const dirsAfter = await tools.get('wiki_dirs').execute({}, { agent: agentC })
  check('wiki_dirs 全局默认移到 other', /\[other\].*全局默认/.test(dirsAfter.text.replace(/\n/g, ' ')), dirsAfter.text.slice(0, 300))

  if (prevReg === undefined) delete process.env.WIKI_REGISTRY_FILE
  else process.env.WIKI_REGISTRY_FILE = prevReg
  await rm(tmp, { recursive: true, force: true })
  await rm(tmp2, { recursive: true, force: true })
  await rm(regTmp, { recursive: true, force: true })
  console.log(`\n结果: ${passed} passed, ${failed} failed`)
  if (failed) { console.log('失败:', failures.join(' | ')); process.exit(1) }
}

await main().catch((e) => { console.error(e); process.exit(1) })
