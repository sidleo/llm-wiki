/**
 * smoke-test.mjs —— 无宿主运行时的端到端冒烟测试。
 *
 * 覆盖 9 工具（list/search/get/create/update/validate/lint/ingest/deprecate）
 * + AGENTS.md 规则解析 + migrate 输出合规性。全部用合成数据（examples/demo-bundle
 * 与 tests/fixtures），绝不触碰真实 ~/.agents 数据。
 *
 * 用法：
 *   node scripts/smoke-test.mjs
 */

import { mkdtemp, rm, cp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const core = await import(join(repoRoot, 'packages', 'core', 'index.mjs'))

let passed = 0
let failed = 0
const failures = []

function check(name, cond, extra) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

async function main() {
  console.log('llm-wiki smoke test')
  console.log('root:', repoRoot)
  const demo = join(repoRoot, 'examples', 'demo-bundle')

  // ── validate ──
  console.log('\n[validate]')
  const v = await core.validateBundle(demo)
  check('demo-bundle OKF 合规', v.ok, v.errors.join('; '))

  // ── list ──
  console.log('\n[list]')
  const tree = await core.listBundle(demo)
  check('列出 11 concepts', tree.reduce((n, t) => n + t.concepts.length, 0) === 11)
  check('含 tables 目录', tree.some((t) => t.dir === 'tables'))

  // ── search ──
  console.log('\n[search]')
  const graph = await core.buildGraph(demo)
  const s1 = core.searchGraph(graph, '销售额', {})
  check('中文检索命中坑点', s1.some((r) => r.id === 'pitfalls/join-inflation'))
  const s2 = core.searchGraph(graph, 'revenue', {})
  check('英文检索命中口径', s2.some((r) => r.id === 'computations/revenue'))
  const s3 = core.searchGraph(graph, '不存在的内容xyz', {})
  check('未命中返回空', s3.length === 0)

  // ── get + backlinks ──
  console.log('\n[get/backlinks]')
  const orders = await core.getConcept(demo, 'tables/orders')
  check('get 命中 orders', orders && orders.title === 'orders')
  check('orders backlinks 含 2 坑点', orders.backlinks.some((b) => b.id === 'pitfalls/join-inflation') && orders.backlinks.some((b) => b.id === 'pitfalls/stat-flag-duplication'))
  const byTitle = await core.getConcept(demo, 'Revenue for fiscal year')
  check('get 按 title 命中', byTitle && byTitle.id === 'computations/revenue')
  const miss = await core.getConcept(demo, 'nope/not-exist')
  check('get 未命中返回 null', miss === null)

  // ── lint ──
  console.log('\n[lint]')
  const lint = await core.lintBundle(demo)
  check('lint 无断链', lint.summary.broken === 0)
  check('lint 无过期', lint.summary.stale === 0)

  // ── AGENTS.md rules ──
  console.log('\n[rules]')
  const rulesRef = await core.resolveRules(demo, 'references/attesters')
  check('references 子目录命中 2 条规则（根+子）', rulesRef.length === 2, `got ${rulesRef.length}`)
  check('最近规则是 references/AGENTS.md', rulesRef[rulesRef.length - 1].path === 'references/AGENTS.md')
  const rulesRoot = await core.resolveRules(demo, '')
  check('根目录命中 1 条规则', rulesRoot.length === 1)

  // ── 写操作（临时 bundle）──
  console.log('\n[create/update/deprecate]')
  const tmp = await mkdtemp(join(tmpdir(), 'wiki-smoke-'))
  await cp(demo, tmp, { recursive: true })

  const created = await core.createConcept(tmp, {
    id: 'tables/tmp_probe',
    type: 'Table',
    title: 'tmp probe',
    description: 'smoke',
    body: 'See [orders](/tables/orders.md).',
    opts: { producer: 'smoke', version: '0.0.1' },
  })
  check('create 成功', created.id === 'tables/tmp_probe')
  const createdFile = await readFile(join(tmp, 'tables', 'tmp_probe.md'), 'utf8')
  check('create 自动写 generated(unverified)', createdFile.includes('generated:') && !createdFile.includes('verified'))
  const v2 = await core.validateBundle(tmp)
  check('create 后仍合规', v2.ok)

  await core.updateConcept(tmp, 'tables/tmp_probe', {
    description: 'human ok',
    opts: { confirmed: true, user: 'human:tester', producer: 'smoke', version: '0.0.1' },
  })
  const updatedFile = await readFile(join(tmp, 'tables', 'tmp_probe.md'), 'utf8')
  check('update confirmed 写 verified human', updatedFile.includes('verified') && updatedFile.includes('human:tester'))

  const dep = await core.deprecateDir(tmp, 'tables')
  check('deprecate 目录级生效', dep.deprecated >= 4, `deprecated ${dep.deprecated}`)
  const ordersFile = await readFile(join(tmp, 'tables', 'orders.md'), 'utf8')
  check('orders 被标 deprecated', ordersFile.includes('status: deprecated'))

  // log/index 维护
  const logFile = await readFile(join(tmp, 'log.md'), 'utf8')
  check('log 有 Creation 记录', logFile.includes('Creation'))

  // ── ingest ──
  console.log('\n[ingest]')
  const srcFile = join(tmp, 'ingest-src.txt')
  await import('node:fs/promises').then((fs) => fs.writeFile(srcFile, 'sample external source content\nline2'))
  const ing = await core.ingestSource(tmp, { source: srcFile, refDir: 'references' }, { producer: 'smoke', version: '0.0.1' })
  check('ingest 登记源概念', ing.sourceConceptId === 'references/ingest-src', JSON.stringify(ing))
  check('ingest 源文件已 copy', (await readdir(join(tmp, 'references'))).includes('ingest-src.txt'))
  const v3 = await core.validateBundle(tmp)
  check('ingest 后仍合规', v3.ok, v3.errors.join('; '))

  // ── migrate 输出合规 ──
  console.log('\n[migrate]')
  const migOut = await mkdtemp(join(tmpdir(), 'wiki-mig-'))
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(process.execPath, [
    join(repoRoot, 'scripts', 'migrate.mjs'),
    '--fromKb', join(repoRoot, 'tests', 'fixtures', 'legacy-kb'),
    '--fromSqlkb', join(repoRoot, 'tests', 'fixtures', 'legacy-sqlkb'),
    '--to', migOut,
    '--real',
  ], { encoding: 'utf8' })
  check('migrate 进程成功', r.status === 0, r.stderr)
  const vm = await core.validateBundle(migOut)
  check('migrate 输出 OKF 合规', vm.ok, vm.errors.join('; '))

  await rm(tmp, { recursive: true, force: true })
  await rm(migOut, { recursive: true, force: true })

  console.log(`\n结果: ${passed} passed, ${failed} failed`)
  if (failed) {
    console.log('失败项:', failures.join(' | '))
    process.exit(1)
  }
}

await main()
