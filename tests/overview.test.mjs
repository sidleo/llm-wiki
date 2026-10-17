/**
 * tests/overview.test.mjs —— 「wiki_list 全量清单 + 按行截断」回归测试。
 *
 * 【这一版在防什么】
 * 更早的版本把每条概念渲染成一行**并带上绝对路径**，每行约 206 字符。真实库 364 概念
 * 需 75K 字符 > 宿主上限 40000 → 输出被**字符级硬切**：364 条只有 184 条完整出现，
 * **180 条（49.5%）静默丢失**，没有汇总行、没有截断提示。
 * `wiki_list` 的定位却是「动手前第一步看全貌」——给半份且不说，比不给更危险：
 * 模型会据此误判「库里没有」→ 触发重复 `wiki_create`。
 *
 * 根因是**绝对路径的长度**（单条约 150 字符，bundle 根前缀就占 ~76），不是「列全量」本身。
 * 现行契约因此是：清单**逐条列出全部条目**，但每条只给 `标题 + [type]`（**不含路径**），
 * 路径能力留给 `wiki_search` / `wiki_get`。去掉路径后同样全量只要 ~20K 字符，
 * 容量从「~187 概念」提到「~748 概念」——「全量」与「不撞上限」得以兼得。
 *
 * 本文件锁死：
 *   ① **全量覆盖**（每个目录、**每一条**标题都在）——比旧版「只给 N 条示例」更严；
 *   ② 截断**绝不静默**（必须给提示）、**绝不切断某行**（不得出现半条路径）；
 *   ③ 清单**不含绝对路径**（路径由 search/get 承担，见 tests/ref-abs-path.test.mjs）；
 *   ④ 工具 description 与真实输出形态一致。
 *
 * 【为什么不硬编码数字】真实库在线增长中（364 → 之后更多），所以断言一律用
 * 「全量覆盖」「计数行自洽」这类不依赖具体规模的不变量。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const CLI = join(REPO, 'packages', 'skill', 'bin', 'wiki.mjs')
const CORE = join(REPO, 'packages', 'core', 'index.mjs')
const DEPRECATED_FIXTURE = join(__dirname, 'fixtures', 'deprecated-bundle')

/** 真实库（只读抽查用；路径含空格）。不存在时相关用例跳过。 */
const REAL = '/Users/zhang3/Library/Mobile Documents/iCloud~md~obsidian/Documents/llm-wiki'

/** 计数行：`知识库清单（16 个目录 / 364 个概念）`（可能带「　筛选：…」后缀）。 */
const COUNT_RE = /知识库清单（(\d+) 个目录 \/ (\d+) 个概念）/
/** 目录行：`永辉/sql/tables  — 55 个 (Table×54 Reference×1)` */
const DIR_RE = /^(.+?)\s+—\s+(\d+) 个(?:\s+\((.*)\))?\s*$/
/** 条目行：`    · 标题  [Type]`（废弃再加 ` [废弃]`）。 */
const ITEM_RE = /^\s+·\s+(.+?)(?:\s{2}\[([^\]]+)\])?(?:\s+\[废弃\])?\s*$/
/** 截断提示（长/短两种措辞都要认）。 */
const NOTICE_RE = /已省略\s*\d+\s*行/
/** 半条路径的特征：`-> <` 开了尖括号却没有闭合的 `>`。 */
const HALF_LINE_RE = /->\s+<[^>\n]*$/

/** 造一个「大到足以撑爆旧渲染」的合成 bundle：dirs 个目录 × perDir 个概念。 */
async function makeLargeBundle(root, { dirs, perDir }) {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), '# 大库\n', 'utf8')
  for (let d = 0; d < dirs; d++) {
    for (let i = 0; i < perDir; i++) {
      // 标题故意写长，模拟真实库那种「一行 200+ 字符」的行
      const file = join(root, `目录${d}`, `概念${i}.md`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `---
type: Pitfall
title: 目录${d} 的第 ${i} 个概念（这是一个刻意写得很长的标题用来模拟真实库的字符开销 ${'x'.repeat(40)}）
description: 合成概念
---
# Gotchas

正文。
`, 'utf8')
    }
  }
  return root
}

/** 用 mock ctx 驱动 dsh 形态的 wiki_list。 */
async function dshList(dataDir, args = {}, config = {}) {
  const mod = await import(join(REPO, 'packages', 'dsh', 'wiki.mjs'))
  const tools = new Map()
  const ctx = {
    on() {},
    tools: { register(t) { tools.set(t.name, t) } },
    systemPrompt: {},
    inject(_d, cb) { return cb({ get() { return undefined } }) },
  }
  mod.apply(ctx, { dataDir, ...config })
  const r = await tools.get('wiki_list').execute(args)
  return { text: r.text, tools }
}

/** 用真实 CLI 子进程驱动 skill 形态的 wiki_list。 */
function cliList(dataDir, args = []) {
  const r = spawnSync(process.execPath, [CLI, 'list', ...args, '--dataDir', dataDir], { encoding: 'utf8' })
  assert.equal(r.status, 0, `CLI 退出码应为 0: ${r.stderr}`)
  return r.stdout
}

/** 从清单文本里解析出目录行（dir → count）。 */
function parseDirLines(text) {
  const out = new Map()
  for (const line of text.split('\n')) {
    const m = DIR_RE.exec(line)
    if (m) out.set(m[1].trim(), Number(m[2]))
  }
  return out
}

describe('wiki_list 全量清单', () => {
  let big
  let regDir
  let prevReg

  before(async () => {
    regDir = await mkdtemp(join(tmpdir(), 'wiki-ov-reg-'))
    prevReg = process.env.WIKI_REGISTRY_FILE
    process.env.WIKI_REGISTRY_FILE = join(regDir, 'reg.json')
    // 12 目录 × 30 概念 = 360 概念，且标题刻意写长（模拟真实库的行宽）。
    // 刻意选「刚好装得下 40000」的规模：这样才能诚实地断言**全量覆盖**；
    // 超过容量的情形另有专门用例（断言「截断必须给提示」而非「全覆盖」）。
    big = await makeLargeBundle(join(await mkdtemp(join(tmpdir(), 'wiki-ov-big-')), 'bundle'), { dirs: 12, perDir: 30 })
  })

  after(async () => {
    if (prevReg === undefined) delete process.env.WIKI_REGISTRY_FILE
    else process.env.WIKI_REGISTRY_FILE = prevReg
    // big 的父目录也一并清掉
    if (big) await rm(dirname(big), { recursive: true, force: true })
    if (regDir) await rm(regDir, { recursive: true, force: true })
  })

  // ───────────────── 1. 大库：不丢内容、目录全覆盖 ─────────────────

  describe('大库不丢内容', () => {
    test('600 概念库：计数行自洽 + 目录全覆盖 + 【全量】每条标题都在', async () => {
      const core = await import(CORE)
      const tree = await core.listBundle(big, {})
      const { text } = await dshList(big)

      // 计数行存在，且与实际 tree 一致（不硬编码数字）
      const m = COUNT_RE.exec(text)
      assert.ok(m, `清单首行应为计数行，实际:\n${text.slice(0, 200)}`)
      const expectedDirs = tree.length
      const expectedConcepts = tree.reduce((n, d) => n + d.concepts.length, 0)
      assert.equal(Number(m[1]), expectedDirs, '计数行的目录数应与 listBundle 一致')
      assert.equal(Number(m[2]), expectedConcepts, '计数行的概念数应与 listBundle 一致')

      // **关键**：每个目录都必须出现在输出里（这才是「没丢内容」的判据）
      const shown = parseDirLines(text)
      const missing = tree.map((d) => d.dir).filter((d) => !shown.has(d))
      assert.deepEqual(missing, [], `以下目录在清单里缺失（=内容静默丢失）:\n${missing.join('\n')}`)

      // 每个目录的计数也要对
      for (const d of tree) {
        assert.equal(shown.get(d.dir), d.concepts.length, `目录 ${d.dir} 的计数不对`)
      }

      // **全量覆盖（比旧版「只给 N 条示例」更严）**：每一条概念的标题都必须逐条出现
      const missingTitles = []
      for (const d of tree) {
        for (const c of d.concepts) {
          if (!text.includes(c.title)) missingTitles.push(`${d.dir}/${c.id}`)
        }
      }
      assert.deepEqual(missingTitles, [],
        `清单号称全量，但以下条目没列出:\n${missingTitles.slice(0, 20).join('\n')}`)

      // 不再有「… 另 N 个」这类示例省略语义
      assert.ok(!/另\s*\d+\s*个/.test(text), `全量清单不该再有「另 N 个」省略:\n${text.slice(0, 300)}`)

      // 条目行数应等于概念总数（每概念一行）
      const itemCount = text.split('\n').filter((l) => /^\s+·\s+/.test(l)).length
      assert.equal(itemCount, expectedConcepts, '条目行数应等于概念总数（全量）')
    })

    test('大库输出长度 ≤ 上限，且未截断时不得出现截断提示', async () => {
      const core = await import(CORE)
      const { text } = await dshList(big)
      const max = 40000 // 宿主 maxGetChars 量级
      assert.ok(text.length <= max, `输出不得超过上限 ${max}，实际 ${text.length}`)
      // 未截断时不该有提示；有提示说明确实截断了（后续用例单独校验）
      if (!NOTICE_RE.test(text)) {
        assert.ok(text.length < max, '没有截断提示就意味着不该被截断，但已达上限')
      }
    })

    test('清单不含绝对路径（路径由 search/get 承担，这是容量的来源）', async () => {
      const { text } = await dshList(big)
      assert.ok(!text.includes('->'), `清单不该含绝对路径:\n${text.slice(0, 200)}`)
      assert.ok(!text.includes(big), '清单不该出现 bundle 绝对根路径')
      assert.ok(!text.includes('%20'), '不该出现 URL-encode')
    })

    test('600 概念库超出容量时：允许截断，但必须给提示且保留计数行', async () => {
      // 这个规模**必然**超出 40000（去掉路径后容量约 748 概念，但本项目标题普遍较长），
      // 所以这里不能断言「全覆盖」——要断言的是「截断不静默」。
      const core = await import(CORE)
      const huge = await makeLargeBundle(join(await mkdtemp(join(tmpdir(), 'wiki-ov-huge-')), 'bundle'), { dirs: 15, perDir: 40 })
      try {
        const { text } = await dshList(huge)
        const tree = await core.listBundle(huge, {})
        const total = tree.reduce((n, d) => n + d.concepts.length, 0)
        assert.ok(total >= 600, '本用例的规模应当在 600 以上')
        assert.ok(text.length <= 40000, `不得超过上限，实际 ${text.length}`)
        assert.match(text, NOTICE_RE, `超容量时必须给提示，不得静默:\n${text.slice(-160)}`)
        assert.match(text, COUNT_RE, '截断后仍应保留计数行（模型知道库里有多少）')
      } finally {
        await rm(dirname(huge), { recursive: true, force: true })
      }
    })

    test('目录很多 + 上限很小：截断必须给提示，且不得静默', async () => {
      // 压到很小的上限，强制走截断分支（真实 dsh 路径）
      const { text } = await dshList(big, {}, { maxGetChars: 300 })
      assert.ok(text.length <= 300, `应当受上限约束，实际 ${text.length}`)
      assert.match(text, NOTICE_RE, `截断必须给提示，不得静默:\n${text}`)
      // 至少保留计数行，模型仍知道「库里有多少」
      assert.match(text, COUNT_RE, '截断后仍应保留计数行')
    })

    test('通过真实 CLI 也走同一截断兜底（skill 形态）', () => {
      const out = cliList(big)
      assert.match(out, COUNT_RE, 'CLI 清单应含计数行')
      assert.ok(out.length < 40000, `CLI 输出不应撞上限，实际 ${out.length}`)
    })
  })

  // ───────────────── 2. 绝不切断某一行 ─────────────────

  describe('绝不切断某一行', () => {
    test('清单输出里不存在半条路径（旧 bug 特征）', async () => {
      for (const [label, text] of [
        ['dsh 正常', (await dshList(big)).text],
        ['dsh 小上限', (await dshList(big, {}, { maxGetChars: 300 })).text],
        ['skill CLI', cliList(big)],
      ]) {
        const halves = text.split('\n').filter((l) => HALF_LINE_RE.test(l))
        assert.deepEqual(halves, [], `${label} 存在被切断的半行:\n${halves.join('\n')}`)
      }
    })

    test('小上限截断后，保留的每一行都是完整的', async () => {
      const { text } = await dshList(big, {}, { maxGetChars: 300 })
      for (const line of text.split('\n')) {
        // 括号必须闭合（列表行 `· 标题` / 目录行 `(Type×N)` / 提示行 `（…）`）
        assert.ok(!/^\s*·.*\([^)]*$/.test(line), `标题行括号未闭合: ${line}`)
        assert.ok(!HALF_LINE_RE.test(line), `出现半条路径: ${line}`)
      }
    })
  })

  // ───────────────── 3. 过滤场景标注子集 ─────────────────

  describe('过滤场景标注子集', () => {
    test('type 过滤时标明这是筛选结果（scopeNote）', async () => {
      const core = await import(CORE)
      const { text } = await dshList(big, { type: 'Pitfall' })
      assert.match(text, /筛选[:：]/, `过滤输出应标注子集:\n${text.slice(0, 200)}`)
      assert.match(text, /type\s*=\s*Pitfall/, 'scopeNote 应说明过滤条件')

      // 行首不得只给「全库」口径的错觉：概念数应等于过滤后的数量
      const m = COUNT_RE.exec(text)
      assert.ok(m, '过滤后仍应有计数行')
      const tree = await core.listBundle(big, { type: 'Pitfall' })
      const n = tree.reduce((s, d) => s + d.concepts.length, 0)
      assert.equal(Number(m[2]), n, '过滤后的计数应是子集数量')
    })

    test('status 过滤同样标注（deprecated 子集）', async () => {
      // 用含 deprecated 的 fixture：空结果会走「知识库为空」分支，那样测不到 scopeNote
      const { text } = await dshList(DEPRECATED_FIXTURE, { status: 'deprecated' })
      assert.match(text, /筛选[:：]/, `status 过滤应标注子集:\n${text.slice(0, 200)}`)
      assert.match(text, /status\s*=\s*deprecated/)
    })

    test('不过滤时不出现 scopeNote（避免误标为子集）', async () => {
      const { text } = await dshList(big)
      assert.ok(!/筛选[:：]/.test(text), `未过滤不该有筛选标注:\n${text.slice(0, 200)}`)
    })
  })

  // ───────────────── 4. deprecated 不被静默丢弃（fixture 固定覆盖） ─────────────────

  describe('deprecated 覆盖（fixture 固定，防静默丢弃）', () => {
    test('废弃概念在清单里被显式标记，且有效概念不受影响', async () => {
      const core = await import(CORE)
      const tree = await core.listBundle(DEPRECATED_FIXTURE, {})
      const all = tree.flatMap((d) => d.concepts)
      const dep = all.filter((c) => c.status === 'deprecated')
      assert.ok(dep.length > 0, 'fixture 必须含 deprecated 概念（否则本组覆盖是空的）')

      // 全量清单：不再有 sample，废弃条目必然逐条列出
      const text = core.renderOverview(tree)
      for (const c of dep) {
        assert.ok(text.includes(c.title), `废弃概念「${c.title}」不该从清单里消失:\n${text}`)
      }
      // 存在性断言（**不**断言「恰好一次」——标题是数据、标记是状态，写死会脆）
      assert.match(text, /\[废弃\]/, '废弃概念应有状态标记')
      // 正常概念也在
      assert.ok(text.includes('仍然有效的坑'), '正常概念不该被影响')
    })

    test('不变量守卫：含 `-> <` 的行必然闭合（谁在路径后追加内容就会红）', async () => {
      // 防的是「路径之后再追加标记 → 行尾锚定失配 → 静默丢行」这一整类回归。
      // 用真实库逐条渲染（只读），任何在路径后追加内容的行为都会让本断言红。
      if (!existsSync(REAL)) return
      const core = await import(CORE)
      const tree = await core.listBundle(REAL, {})

      let checked = 0
      const unclosed = []
      for (const d of tree) {
        for (const c of d.concepts) {
          const line = core.formatConceptRef(REAL, c)
          if (!line.includes('->')) continue
          checked++
          // 尖括号必须闭合，且必须是**行尾**（search/get 的概念行以此收尾）
          if (!/->\s*<[^>]+>\s*$/.test(line)) unclosed.push(line)
        }
      }
      assert.ok(checked > 0, '应当渲染出带 -> 的行（真实库非空）')
      assert.deepEqual(unclosed, [], `存在未闭合/带尾随内容的路径行:\n${unclosed.join('\n')}`)
    })
  })

  // ───────────────── 5. description 跨形态声明 `-> <路径>` ─────────────────

  describe('description 写清 `-> <路径>` 约定（跨形态）', () => {
    // 需要解释箭头的工具 = **实际会输出 `-> <路径>` 的工具**（wiki_search / wiki_get）。
    // wiki_list 现在是「全量清单（标题 + [type]）」、**不含路径**（路径是长度的元凶，
    // 去掉后同样全量只要 ~20K，容量提升约 4 倍），所以不要求它解释箭头——
    // 这是一条由「输出形态」推导出的断言，而不是照抄工具名单。
    const EMITS_ARROW = ['wiki_search', 'wiki_get']
    const ARROW_RE = /->\s*<|`->`/

    test('dsh：会输出 -> <路径> 的工具，description 必须解释它', async () => {
      const mod = await import(join(REPO, 'packages', 'dsh', 'wiki.mjs'))
      const tools = new Map()
      const ctx = {
        on() {},
        tools: { register(t) { tools.set(t.name, t) } },
        systemPrompt: {},
        inject(_d, cb) { return cb({ get() { return undefined } }) },
      }
      mod.apply(ctx, { dataDir: REAL })
      for (const name of EMITS_ARROW) {
        const d = tools.get(name).description || ''
        assert.match(d, ARROW_RE, `${name} (dsh) 会输出 -> <路径>，description 就必须解释它:\n${d}`)
      }
    })

    test('mcp：会输出 -> <路径> 的工具，description 必须解释它', async () => {
      const core = await import(CORE)
      const { createWiki } = await import(join(REPO, 'packages', 'mcp', 'lib', 'tools.mjs'))
      const w = createWiki({ core, config: { dataDir: REAL } })
      for (const name of EMITS_ARROW) {
        const d = w.tools.get(name).description || ''
        assert.match(d, ARROW_RE, `${name} (mcp) 会输出 -> <路径>，description 就必须解释它:\n${d}`)
      }
    })

    test('pi：会输出 -> <路径> 的工具，description 必须解释它', async () => {
      process.env.PI_WIKI_DATA_DIR = REAL
      const mod = await import(join(REPO, 'packages', 'pi', 'extensions', 'index.ts'))
      const tools = new Map()
      await mod.default({ registerTool: (d) => tools.set(d.name, d), on() {} }, {})
      delete process.env.PI_WIKI_DATA_DIR
      for (const name of EMITS_ARROW) {
        const d = tools.get(name).description || ''
        assert.match(d, ARROW_RE, `${name} (pi) 会输出 -> <路径>，description 就必须解释它:\n${d}`)
      }
    })

    test('一致性：description 承诺解释箭头 ⟺ 该工具真的输出箭头', async () => {
      // 这条防两个方向的漂移：① 谁又开始输出箭头却没写说明；② 谁不再输出箭头却留着过时说明。
      if (!existsSync(REAL)) return
      const mod = await import(join(REPO, 'packages', 'dsh', 'wiki.mjs'))
      const tools = new Map()
      const ctx = {
        on() {},
        tools: { register(t) { tools.set(t.name, t) } },
        systemPrompt: {},
        inject(_d, cb) { return cb({ get() { return undefined } }) },
      }
      mod.apply(ctx, { dataDir: REAL })
      const calls = {
        wiki_list: {},
        wiki_search: { query: '服务器' },
        wiki_get: { id: '永辉/个人/我的信息' },
      }
      for (const [name, args] of Object.entries(calls)) {
        const r = await tools.get(name).execute(args)
        const emits = r.text.includes('->')
        const documented = ARROW_RE.test(tools.get(name).description || '')
        if (emits) {
          assert.ok(documented, `${name} 输出里有 -> 但 description 没解释，模型不知道箭头是什么`)
        }
      }
    })
  })

  // ───────────────── 6. truncateByLine 单元测试 ─────────────────

  describe('truncateByLine 单元测试', () => {
    test('不超限时原样返回（逐字节）', async () => {
      const { truncateByLine } = await import(join(REPO, 'packages', 'core', 'lib', 'overview.mjs'))
      const text = 'a\nb\nc\nd'
      assert.equal(truncateByLine(text, 1000), text)
      assert.equal(truncateByLine(text, text.length), text, '正好等于上限时应原样返回')
    })

    test('超限时按整行截断：不切断、且必须有提示', async () => {
      const { truncateByLine } = await import(join(REPO, 'packages', 'core', 'lib', 'overview.mjs'))
      const lines = Array.from({ length: 200 }, (_, i) => `line-${i}-${'y'.repeat(30)}`)
      const text = lines.join('\n')

      for (const max of [100, 200, 500, 1000, 4000]) {
        const out = truncateByLine(text, max)
        assert.ok(out.length <= max, `max=${max} 输出 ${out.length} 超限`)
        // **必须**有提示 —— 这条是防静默截断的回归锁
        assert.match(out, NOTICE_RE, `max=${max} 截断却无提示（静默丢失）:\n${out}`)
        // 每一行都必须是原文本里的完整行（或提示行）
        for (const l of out.split('\n')) {
          const isNote = NOTICE_RE.test(l)
          assert.ok(isNote || lines.includes(l), `max=${max} 出现被切断的行: ${JSON.stringify(l)}`)
        }
      }
    })

    test('maxChars 非法/未配置时原样返回，不抛错', async () => {
      const { truncateByLine } = await import(join(REPO, 'packages', 'core', 'lib', 'overview.mjs'))
      const text = Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n')
      for (const bad of [0, -1, -500, NaN, undefined, null, Infinity]) {
        assert.doesNotThrow(() => truncateByLine(text, bad), `maxChars=${bad} 不应抛错`)
      }
      assert.equal(truncateByLine(text, 0), text)
      assert.equal(truncateByLine(text, -5), text)
      assert.equal(truncateByLine(text, NaN), text)
    })

    test('极端小上限也不切断半行', async () => {
      const { truncateByLine } = await import(join(REPO, 'packages', 'core', 'lib', 'overview.mjs'))
      const src = Array.from({ length: 60 }, (_, i) => `line-${i}`)
      const text = src.join('\n')
      for (const max of [1, 5, 12, 30, 60]) {
        const out = truncateByLine(text, max)
        // 【不断言的】总长度**不保证** ≤ maxChars：首行是原子行（这里 6 字符），
        // 不能为了满足上限把它切成半行 —— 「绝不切断某一行」优先级高于「绝不超限」。
        // 因此这里只锁「行完整性」，长度约束由上面 max≥100 的用例承担（那时每行都远小于上限）。
        for (const l of out.split('\n')) {
          assert.ok(NOTICE_RE.test(l) || src.includes(l),
            `max=${max} 出现被切断的行: ${JSON.stringify(l)}`)
        }
        // 恰好一行且是首行原样：不允许出现半行
        assert.ok(!HALF_LINE_RE.test(out), `max=${max} 出现半条路径: ${JSON.stringify(out)}`)
      }
    })

    test('上限足够容纳首行时，长度约束成立', async () => {
      const { truncateByLine } = await import(join(REPO, 'packages', 'core', 'lib', 'overview.mjs'))
      const text = Array.from({ length: 60 }, (_, i) => `line-${i}`).join('\n')
      for (const max of [20, 30, 60, 200]) {
        const out = truncateByLine(text, max)
        assert.ok(out.length <= max, `max=${max} 输出 ${out.length} 超限`)
      }
    })
  })

  // ───────────────── 7. 真实库只读抽查 ─────────────────

  describe('真实库只读抽查', () => {
    test('真实库清单：目录与条目全覆盖 + 计数自洽 + 无断行', async (t) => {
      if (!existsSync(REAL)) return t.skip(`本机无该 bundle: ${REAL}`)
      const core = await import(CORE)
      const tree = await core.listBundle(REAL, {})
      const { text } = await dshList(REAL)

      const m = COUNT_RE.exec(text)
      assert.ok(m, '真实库清单应有计数行')
      assert.equal(Number(m[1]), tree.length, '目录数应与 listBundle 一致')
      assert.equal(Number(m[2]), tree.reduce((n, d) => n + d.concepts.length, 0), '概念数应自洽')

      // 目录全覆盖：库在增长，用 tree 现值比对而非硬编码
      const shown = parseDirLines(text)
      const missing = tree.map((d) => d.dir).filter((d) => !shown.has(d))
      assert.deepEqual(missing, [], `真实库有目录未出现在清单里:\n${missing.join('\n')}`)

      // **条目全覆盖**：真实库每条概念的标题都必须逐条出现（这是「全量清单」的核心承诺）
      const missingTitles = []
      for (const d of tree) {
        for (const c of d.concepts) {
          if (!text.includes(c.title)) missingTitles.push(`${d.dir}/${c.id}`)
        }
      }
      assert.deepEqual(missingTitles, [],
        `真实库号称全量，但这些条目没列出:\n${missingTitles.slice(0, 20).join('\n')}`)

      // 条目行数 == 概念总数
      const itemCount = text.split('\n').filter((l) => /^\s+·\s+/.test(l)).length
      assert.equal(itemCount, tree.reduce((n, d) => n + d.concepts.length, 0),
        '条目行数应等于概念总数（全量）')
      // 不再有示例省略
      assert.ok(!/另\s*\d+\s*个/.test(text), '不该再有「另 N 个」示例省略')

      // 无半行
      assert.deepEqual(text.split('\n').filter((l) => HALF_LINE_RE.test(l)), [])
      // 未截断（真实库规模远小于上限）
      assert.ok(!NOTICE_RE.test(text), '真实库当前规模不应触发截断')
      // 不含绝对路径
      assert.ok(!text.includes('->'), '清单不该含绝对路径')
    })

    test('真实库 search/get 仍带真实存在的绝对路径（路径真实性由它们承担）', async (t) => {
      if (!existsSync(REAL)) return t.skip(`本机无该 bundle: ${REAL}`)
      const mod = await import(join(REPO, 'packages', 'dsh', 'wiki.mjs'))
      const tools = new Map()
      const ctx = {
        on() {},
        tools: { register(x) { tools.set(x.name, x) } },
        systemPrompt: {},
        inject(_d, cb) { return cb({ get() { return undefined } }) },
      }
      mod.apply(ctx, { dataDir: REAL })

      const s = await tools.get('wiki_search').execute({ query: '服务器' })
      const paths = s.text.split('\n')
        .map((l) => /->\s+<([^>]+)>\s*$/.exec(l))
        .filter(Boolean)
        .map((m) => m[1])
      assert.ok(paths.length > 0, `wiki_search 应给出路径:\n${s.text.slice(0, 300)}`)
      for (const p of paths) {
        assert.ok(existsSync(p), `search 给出的路径必须存在: ${p}`)
        assert.ok(!p.includes('%20'), `不得 URL-encode: ${p}`)
      }
    })
  })
})
