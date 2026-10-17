/**
 * tests/ref-abs-path.test.mjs —— 概念引用「真实绝对路径」渲染回归测试。
 *
 * 锁死的是**死链根因**：wiki 工具历史上只返回 bundle 相对 id（如 `永辉/sql/…`），
 * 而宿主（DSH）的系统提示词要求「引用已存在的文件时用相对 cwd 的路径或绝对路径」，
 * 模型于是把 id 原样当 cwd 相对路径贴进 Markdown —— bundle 却常挂在 cwd 之外
 * （iCloud / 飞书缓存），于是必然死链。
 *
 * 修法是让工具直接吐出**真实绝对路径**。本文件就用「路径存在吗、指向对吗、
 * id 有没有被污染」这三把尺子把它钉住，覆盖五个形态（core / skill CLI / dsh / mcp / pi）。
 *
 * 设计要点（反假绿）：
 * - bundle 一律建在 **cwd 之外**（os.tmpdir()），并断言输出路径 **不等于** join(cwd, id)；
 * - 路径里**故意带空格**（`dir with spaces`），空路径不包 `<>` 会被 CommonMark 截断；
 * - 每条断言都从**输出文本**里抠出路径再喂 fs.existsSync，而不是自己拼一条对的路径自证。
 *
 * 注意：这里的 bundle 不是真实用户库，是 mkdtemp 合成的（含中文/空格/数字开头 id），
 * 跑完清理，绝不触碰 ~/.agents/wiki 或 iCloud 上的真实知识库。
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

/** 合成 bundle 里的概念（id → 内容）。刻意覆盖：中文、空格、数字开头、多级目录。 */
const CONCEPTS = {
  'tables/订单明细': {
    type: 'Table',
    title: '订单明细表',
    desc: '订单行级明细',
  },
  '工具环境/含空格 的目录/5楼服务器服务清单': {
    type: 'Reference',
    title: '5楼服务器服务清单',
    desc: '长驻服务清单',
  },
}

/** 写一个最小合法 OKF bundle（每个概念一个 .md），返回其绝对根路径。 */
async function makeBundle(root) {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), '# 测试库\n', 'utf8')
  await writeFile(join(root, 'index.md'), '# index\n', 'utf8')
  for (const [id, c] of Object.entries(CONCEPTS)) {
    const file = join(root, `${id}.md`)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `---\ntype: ${c.type}\ntitle: ${c.title}\ndescription: ${c.desc}\n---\n\n# 正文\n\n${c.desc}\n`, 'utf8')
  }
  return root
}

/**
 * 从一行渲染输出里抠出「给出的链接目标」。
 *
 * 只认 `-> <path>` 形态（尖括号）与 `-> path`（裸路径兜底），
 * 且**去掉尖括号后必须原样是路径**——不做任何 strip/trim 掉空格的宽容处理，
 * 因为「路径被空格截断」正是要抓的 bug，宽容处理会让测试失去意义。
 */
function linkTargetOf(line) {
  const m = /->\s+(.*)$/.exec(line)
  if (!m) return null
  let p = m[1].trim()
  if (p.startsWith('<') && p.endsWith('>')) p = p.slice(1, -1)
  return p
}

/**
 * 行尾锚定的尖括号路径提取（唯一正确的姿势）。
 *
 * 【别用 /<([^>]+)>/g】真实标题本身可能含 `<`/`>`，例如
 *   `npm -g 升级 openclaw 失败（Node < 24.16 装不了 2026.9.4）`
 *   `pi-ai < 0.86 不发导致 400 MissingSessionID`
 * 非贪婪匹配会从标题里的 `Node <` 一路吃到路径末尾的 `>`，
 * 把「标题片段 + (id) + ->」整段当成路径 → existsSync=false 的**假失败**。
 * 锚定 `$` 后只会匹配末尾那一段真正的路径。
 */
const ABS_TAIL_RE = /->\s+<([^>]+)>\s*$/

/** 一行里 `(id)` 段的内容（概念身份）。取**最后一个** `(...)` 再要求其后紧跟 `->` 或行尾。 */
function idOf(line) {
  const m = /\(([^()]*)\)\s*(?:->\s|$)/g
  let last = null
  let hit
  while ((hit = m.exec(line.trim())) !== null) last = hit[1]
  return last
}

describe('概念引用输出真实绝对路径（死链根因回归）', () => {
  let spaced // cwd 之外的 bundle 根；目录名**带空格**（模拟 iCloud / 飞书缓存）
  let regDir
  let prevReg

  before(async () => {
    // 目录名里**带空格**，模拟真实 bundle（`Mobile Documents/iCloud~md~obsidian/…`）
    spaced = await mkdtemp(join(tmpdir(), 'wiki-ref with spaces-'))
    await makeBundle(spaced)
    // 隔离注册表，避免读到用户真实 ~/.agents/wiki-registry.json
    regDir = await mkdtemp(join(tmpdir(), 'wiki-ref-reg-'))
    prevReg = process.env.WIKI_REGISTRY_FILE
    process.env.WIKI_REGISTRY_FILE = join(regDir, 'reg.json')
  })

  after(async () => {
    if (prevReg === undefined) delete process.env.WIKI_REGISTRY_FILE
    else process.env.WIKI_REGISTRY_FILE = prevReg
    for (const d of [spaced, regDir]) {
      if (d) await rm(d, { recursive: true, force: true })
    }
  })

  // ───────────────────────── 1. core：契约本身 ─────────────────────────

  describe('core 契约（conceptAbsPath / formatConceptRef）', () => {
    test('conceptAbsPath 返回的裸路径真实存在，且不等于 join(cwd, id)', async () => {
      const core = await import(join(REPO, 'packages', 'core', 'index.mjs'))
      for (const id of Object.keys(CONCEPTS)) {
        const p = core.conceptAbsPath(spaced, id)

        assert.equal(typeof p, 'string')
        assert.ok(p.startsWith('/'), `应为绝对路径: ${p}`)
        // 关键断言：路径真实存在（没扩展名 / 被截断都会在这里挂）
        assert.ok(existsSync(p), `给出的路径必须真实存在: ${p}`)
        // 关键断言：它**不是** cwd 相对解释下的那个路径（原 bug 的形状）
        assert.notEqual(p, join(process.cwd(), id))
        assert.ok(!p.includes('%20'), `不得 URL-encode: ${p}`)
        assert.ok(p.includes(' '), `空格必须原样保留: ${p}`)
        // 裸路径不该自带尖括号（尖括号是 formatConceptRef 的职责）
        assert.ok(!p.includes('<') && !p.includes('>'), `conceptAbsPath 应是裸路径: ${p}`)
      }
    })

    test('formatConceptRef 用 <...> 包裹含空格路径，抠出来即真实文件', async () => {
      const core = await import(join(REPO, 'packages', 'core', 'index.mjs'))
      for (const [id, c] of Object.entries(CONCEPTS)) {
        const line = core.formatConceptRef(spaced, { id, ...c })
        // 含空格路径必须被尖括号包住，否则 CommonMark 在第一个空格截断 → 死链
        assert.match(line, /->\s+<[^>]+>$/, `含空格路径必须用尖括号包裹: ${line}`)
        const target = linkTargetOf(line)
        assert.ok(existsSync(target), `尖括号里的路径必须真实存在: ${target}`)
        assert.equal(target, core.conceptAbsPath(spaced, id))
      }
    })

    test('id 语义未被污染：(id) 处仍是 bundle 相对 id，不是绝对路径', async () => {
      const core = await import(join(REPO, 'packages', 'core', 'index.mjs'))
      for (const [id, c] of Object.entries(CONCEPTS)) {
        const line = core.formatConceptRef(spaced, { id, ...c })
        assert.equal(idOf(line), id, `(id) 必须原样是 bundle 相对 id: ${line}`)
        // 概念对象本身不得被就地改写成绝对路径
        assert.equal(c.id, undefined)
      }
    })

    test('root 为空时降级为旧格式，且不抛错', async () => {
      const core = await import(join(REPO, 'packages', 'core', 'index.mjs'))
      assert.equal(core.conceptAbsPath('', 'tables/订单明细'), '')
      assert.equal(core.conceptAbsPath(null, 'tables/订单明细'), '')
      const line = core.formatConceptRef('', { id: 'tables/订单明细', type: 'Table', title: '订单明细表' })
      assert.equal(line, 'Table: 订单明细表  (tables/订单明细)')
      assert.ok(!line.includes('->'), `无 root 时不该出现箭头/绝对路径: ${line}`)
    })

    test('含 ? 的路径宁可降级也不给死链（宿主对 ? 直接放弃解析）', async () => {
      const core = await import(join(REPO, 'packages', 'core', 'index.mjs'))
      const line = core.formatConceptRef('/tmp/x?y', { id: 'a/b', type: 'Table', title: 'T' })
      assert.ok(!line.includes('->'), `? 路径必须降级: ${line}`)
    })

    test('后缀语义由 id 决定：root 目录名恰好以 .md 结尾也不受影响', async () => {
      const core = await import(join(REPO, 'packages', 'core', 'index.mjs'))
      // 语义收窄守卫：扩展名只看 rel。真实 bundle 目录名就是 `…/llm-wiki` 这种形态，
      // 这里用 `.md` 结尾的 root 把「扩展名由谁决定」钉住。
      assert.equal(core.conceptAbsPath('/tmp/kb.md', 'a/b'), '/tmp/kb.md/a/b.md')
      assert.equal(core.conceptAbsPath('/tmp/kb', 'a/b.md'), '/tmp/kb/a/b.md')
      assert.ok(!core.conceptAbsPath('/tmp/kb.md', 'a/b').endsWith('.md.md'))
    })
  })

  // ───────────────────────── 2. 五形态一致性 ─────────────────────────

  describe('五形态产出的路径指向同一文件', () => {
    /** 收集某一形态对 wiki_get 的输出文本。 */
    async function dshText(id) {
      const mod = await import(join(REPO, 'packages', 'dsh', 'wiki.mjs'))
      const tools = new Map()
      const ctx = {
        on() {},
        tools: { register(t) { tools.set(t.name, t) } },
        systemPrompt: {},
        inject(_d, cb) { return cb({ get() { return undefined } }) },
      }
      mod.apply(ctx, { dataDir: spaced })
      const r = await tools.get('wiki_get').execute({ id })
      return r.text
    }

    async function mcpText(id) {
      const core = await import(join(REPO, 'packages', 'core', 'index.mjs'))
      const { createWiki } = await import(join(REPO, 'packages', 'mcp', 'lib', 'tools.mjs'))
      const w = createWiki({ core, config: { dataDir: spaced } })
      const r = await w.tools.get('wiki_get').run({ id })
      return r.content ? r.content[0].text : String(r.text ?? r)
    }

    async function piText(id) {
      process.env.PI_WIKI_DATA_DIR = spaced
      const mod = await import(join(REPO, 'packages', 'pi', 'extensions', 'index.ts'))
      const tools = new Map()
      await mod.default({ registerTool: (d) => tools.set(d.name, d), on() {} }, {})
      const r = await tools.get('wiki_get').execute('id', { id }, undefined, undefined, {})
      delete process.env.PI_WIKI_DATA_DIR
      return r.text
    }

    function cliText(id) {
      const r = spawnSync(process.execPath, [CLI, 'get', id, '--dataDir', spaced], {
        encoding: 'utf8',
        env: { ...process.env, WIKI_REGISTRY_FILE: process.env.WIKI_REGISTRY_FILE },
      })
      assert.equal(r.status, 0, `CLI 退出码应为 0，实际 ${r.status}: ${r.stderr}`)
      return r.stdout
    }

    test('core / skill / dsh / mcp / pi 五处给出同一个真实路径', async () => {
      const id = '工具环境/含空格 的目录/5楼服务器服务清单'
      const core = await import(join(REPO, 'packages', 'core', 'index.mjs'))
      const expected = core.conceptAbsPath(spaced, id)
      assert.ok(existsSync(expected), `基准路径必须存在: ${expected}`)

      const outputs = {
        skill: cliText(id),
        dsh: await dshText(id),
        mcp: await mcpText(id),
        pi: await piText(id),
      }

      for (const [form, text] of Object.entries(outputs)) {
        assert.ok(text.includes(expected),
          `${form} 形态应输出同一绝对路径\n期望含: ${expected}\n实际:\n${text.slice(0, 400)}`)
        // 五形态都必须带尖括号（含空格路径的唯一正确形态）
        assert.ok(text.includes(`<${expected}>`),
          `${form} 形态应用尖括号包裹含空格路径（否则 Markdown 截断）:\n${text.slice(0, 400)}`)
        // id 未被污染
        assert.ok(text.includes(`(${id})`), `${form} 形态 (id) 处必须仍是 bundle 相对 id:\n${text.slice(0, 300)}`)
      }

      // 五形态给出的是**同一个**字符串
      const targets = Object.entries(outputs).map(([form, text]) => {
        const line = text.split('\n').find((l) => l.includes('->'))
        assert.ok(line, `${form} 形态缺少 -> 行`)
        return [form, linkTargetOf(line)]
      })
      for (const [form, t] of targets) {
        assert.equal(t, expected, `${form} 形态路径与基准不一致`)
      }
    })

    test('wiki_list / wiki_search 也带绝对路径（不只是 wiki_get）', async () => {
      const core = await import(join(REPO, 'packages', 'core', 'index.mjs'))
      const mod = await import(join(REPO, 'packages', 'dsh', 'wiki.mjs'))
      const tools = new Map()
      const ctx = {
        on() {},
        tools: { register(t) { tools.set(t.name, t) } },
        systemPrompt: {},
        inject(_d, cb) { return cb({ get() { return undefined } }) },
      }
      mod.apply(ctx, { dataDir: spaced })

      // 【wiki_list 全量清单不含路径】——这是**设计取舍**：绝对路径单条约 150 字符
      // （bundle 根前缀就占 ~76），带路径全量需 75K > 上限 40000 → 曾致 49.5% 静默丢失。
      // 清单改为「标题 + [type]」全量列出，路径能力交给 wiki_search / wiki_get
      // （见下方与 tests/overview.test.mjs）。
      const list = await tools.get('wiki_list').execute({})
      assert.match(list.text, /知识库清单（\d+ 个目录 \/ \d+ 个概念）/,
        `wiki_list 应是全量清单形态:\n${list.text.slice(0, 300)}`)
      assert.ok(!list.text.includes('->'),
        `清单不应含绝对路径（那是 wiki_search / wiki_get 的职责）:\n${list.text.slice(0, 300)}`)
      // 清单里每个目录、每条标题都要出现（全覆盖）
      const tree = await core.listBundle(spaced, {})
      for (const d of tree) {
        assert.ok(list.text.includes(d.dir || '(root)'), `清单缺少目录 ${d.dir}:\n${list.text}`)
        for (const c of d.concepts) {
          assert.ok(list.text.includes(c.title), `清单缺少条目「${c.title}」（全量清单不该漏）`)
        }
      }

      const search = await tools.get('wiki_search').execute({ query: '订单' })
      const searchPaths = search.text.split('\n').map(linkTargetOf).filter(Boolean)
      assert.ok(searchPaths.length > 0, `wiki_search 应给出路径:\n${search.text.slice(0, 400)}`)
      for (const p of searchPaths) {
        assert.ok(existsSync(p), `wiki_search 给出的路径必须存在: ${p}`)
      }
      assert.equal(core.conceptAbsPath(spaced, 'tables/订单明细'),
        searchPaths.find((p) => p.includes('订单明细')))

      // wiki_get 也必须给真实路径（路径真实性的第二个承担者）
      const got = await tools.get('wiki_get').execute({ id: 'tables/订单明细' })
      const gotPath = linkTargetOf(got.text.split('\n').find((l) => l.includes('->')) || '')
      assert.ok(gotPath && existsSync(gotPath), `wiki_get 应给出存在的路径: ${gotPath}`)
    })
  })

  // ───────────────────────── 3. 降级：不抛错、不退化 ─────────────────────────

  describe('降级路径', () => {
    test('bundle 含空格 + CLI 正常，输出未 URL-encode 也未截断', () => {
      const r = spawnSync(process.execPath,
        [CLI, 'get', '工具环境/含空格 的目录/5楼服务器服务清单', '--dataDir', spaced],
        { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      assert.ok(!r.stdout.includes('%20'), '不得 URL-encode 空格')
      // 空白被吞/截断的话，斜括号里就会少掉空格后的部分
      // 用行尾锚定的正则逐行提取；**不要**用 /<([^>]+)>/g —— 标题里的 `<` 会造成假失败
      const blocks = r.stdout.split('\n').map((l) => {
        const m = ABS_TAIL_RE.exec(l)
        return m ? m[1] : null
      }).filter(Boolean)
      assert.ok(blocks.length > 0, 'CLI 输出应含 <path>')
      for (const b of blocks) {
        assert.ok(b.includes(' '), `尖括号内应保留空格: ${b}`)
      }
    })

    test('bundle 不存在时不抛错，且不编造绝对路径', async () => {
      const core = await import(join(REPO, 'packages', 'core', 'index.mjs'))
      const ghost = join(tmpdir(), 'wiki-ref-definitely-missing-xyz')
      // conceptAbsPath 是纯拼接，不负责存在性；这里锁的是「调用方拿到路径也不崩」
      const p = core.conceptAbsPath(ghost, 'a/b')
      assert.equal(p, join(ghost, 'a/b.md'))

      const mod = await import(join(REPO, 'packages', 'dsh', 'wiki.mjs'))
      const tools = new Map()
      const ctx = {
        on() {},
        tools: { register(t) { tools.set(t.name, t) } },
        systemPrompt: {},
        inject(_d, cb) { return cb({ get() { return undefined } }) },
      }
      mod.apply(ctx, { dataDir: ghost })
      // 不存在的 bundle：工具应给出错误文本而不是抛异常
      const r = await tools.get('wiki_get').execute({ id: 'a/b' })
      assert.equal(typeof r.text, 'string')
    })

    test('统一使用 / 分隔符，且路径中没有重复分隔符', async () => {
      const core = await import(join(REPO, 'packages', 'core', 'index.mjs'))
      const p = core.conceptAbsPath(spaced, '工具环境/含空格 的目录/5楼服务器服务清单')
      assert.ok(!p.includes('//'), `不得出现双斜杠: ${p}`)
      assert.ok(!p.endsWith('/'), `不得以分隔符结尾: ${p}`)
      assert.ok(p.endsWith('.md'), `应带 .md 后缀: ${p}`)
    })
  })

  // ─────────── 3.5 deprecated：fixture 固定覆盖 + 不变量守卫 ───────────
  //
  // 背景：旧 `wiki_list` 会在路径**之后**追加 ` [deprecated]`，使行尾锚定的
  // `/->\s+<([^>]+)>\s*$/` 失配 → 那些行被 `.filter(Boolean)` 静默丢弃，
  // 即「真实库上 deprecated 概念的路径从未被断言过」。
  // 改为全量清单后该后缀已不在路径行上，但**风险类别仍在**（将来谁再追加就会重演）。
  // 因此这里用 fixture 固定覆盖废弃渲染，并加一条不变量守卫把这个类别钉死，
  // 而**不**退化成非锚定提取（那会把「标题含 `<`/`>`」的假阳性放回来）。

  describe('deprecated 概念不被静默丢弃', () => {
    const DEP = join(__dirname, 'fixtures', 'deprecated-bundle')

    test('fixture 里确有 deprecated 概念（否则本组覆盖为空）', async () => {
      const core = await import(join(REPO, 'packages', 'core', 'index.mjs'))
      const tree = await core.listBundle(DEP, {})
      const all = tree.flatMap((d) => d.concepts)
      assert.ok(all.some((c) => c.status === 'deprecated'), 'fixture 必须含 status: deprecated')
      assert.ok(all.some((c) => c.status !== 'deprecated'), 'fixture 也要含正常概念作对照')
    })

    test('废弃概念的路径照样能渲染出来且文件真实存在', async () => {
      const core = await import(join(REPO, 'packages', 'core', 'index.mjs'))
      const tree = await core.listBundle(DEP, {})
      const dep = tree.flatMap((d) => d.concepts).filter((c) => c.status === 'deprecated')
      for (const c of dep) {
        const line = core.formatConceptRef(DEP, c)
        const m = ABS_TAIL_RE.exec(line)
        assert.ok(m, `废弃概念的行也应能以锚定提取到路径（不该被静默丢弃）: ${line}`)
        assert.ok(existsSync(m[1]), `废弃概念的路径必须存在: ${m[1]}`)
        assert.ok(line.includes(`(${c.id})`), `(id) 不应被污染: ${line}`)
      }
    })

    test('不变量守卫：工具输出的 `-> <路径>` 行必须闭合且无尾随内容', async () => {
      // 这条守卫的是「在路径之后追加任何内容 → 锚定失配 → 静默丢行」这一整类回归。
      // 若哪天有人给路径行追加标记，本断言立刻变红（而不是悄悄丢行）。
      const mod = await import(join(REPO, 'packages', 'dsh', 'wiki.mjs'))
      const tools = new Map()
      const ctx = {
        on() {},
        tools: { register(t) { tools.set(t.name, t) } },
        systemPrompt: {},
        inject(_d, cb) { return cb({ get() { return undefined } }) },
      }
      mod.apply(ctx, { dataDir: DEP })

      // wiki_get 覆盖废弃概念（清单本身已不含路径行）
      const got = await tools.get('wiki_get').execute({ id: '永辉/sql/已废弃' })
      const arrowLines = got.text.split('\n').filter((l) => l.includes('->'))
      assert.ok(arrowLines.length > 0, `wiki_get 应输出带 -> 的行:\n${got.text.slice(0, 200)}`)
      for (const l of arrowLines) {
        assert.match(l, /->\s+<[^>]+>\s*$/, `路径行必须闭合且无尾随内容: ${l}`)
      }
    })
  })

  // ─────────────── 4. 本机真实 bundle（只读；存在才跑） ───────────────

  describe('真实 bundle 抽查（只读，存在才跑）', () => {
    // 真实库路径含空格（`Mobile Documents`），这本身就是最关键的测试点。
    const REAL = '/Users/zhang3/Library/Mobile Documents/iCloud~md~obsidian/Documents/llm-wiki'
    const hasReal = existsSync(REAL)

    test('真实库每个概念的路径都真实存在（只读，不改动）', async (t) => {
      if (!hasReal) return t.skip(`本机无该 bundle: ${REAL}`)
      const core = await import(join(REPO, 'packages', 'core', 'index.mjs'))
      const tree = await core.listBundle(REAL, {})

      let total = 0
      const bad = []
      for (const dir of tree) {
        for (const c of dir.concepts) {
          total++
          const line = core.formatConceptRef(REAL, c)
          const m = ABS_TAIL_RE.exec(line)
          if (!m) { bad.push([c.id, 'no <path> tail']); continue }
          if (!existsSync(m[1])) bad.push([c.id, 'path missing', m[1]])
          if (line.includes('%20')) bad.push([c.id, 'url-encoded'])
          if (!line.includes(`(${c.id})`)) bad.push([c.id, 'id polluted'])
        }
      }

      assert.ok(total > 0, '真实库应能列出概念')
      assert.deepEqual(bad, [], `以下概念渲染有问题:\n${bad.map((b) => b.join(' | ')).join('\n')}`)
    })

    test('真实库 dsh 形态：wiki_list 是全量清单 + search 路径全部存在且保留空格', async (t) => {
      if (!hasReal) return t.skip(`本机无该 bundle: ${REAL}`)
      const mod = await import(join(REPO, 'packages', 'dsh', 'wiki.mjs'))
      const tools = new Map()
      const ctx = {
        on() {},
        tools: { register(x) { tools.set(x.name, x) } },
        systemPrompt: {},
        inject(_d, cb) { return cb({ get() { return undefined } }) },
      }
      mod.apply(ctx, { dataDir: REAL })
      // 【wiki_list 全量清单不含路径】路径真实性由同一真实库上的 wiki_search / wiki_get 承担。
      const r = await tools.get('wiki_list').execute({})
      assert.match(r.text, /知识库清单（\d+ 个目录 \/ \d+ 个概念）/,
        `真实库 wiki_list 应是全量清单:\n${r.text.slice(0, 200)}`)
      assert.ok(!r.text.includes('->'), '清单不应含绝对路径')

      const core = await import(join(REPO, 'packages', 'core', 'index.mjs'))
      const tree = await core.listBundle(REAL, {})
      for (const d of tree) {
        assert.ok(r.text.includes(d.dir || '(root)'), `真实库清单缺少目录 ${d.dir}`)
        for (const c of d.concepts) {
          assert.ok(r.text.includes(c.title), `真实库清单缺少条目「${c.title}」`)
        }
      }

      const s = await tools.get('wiki_search').execute({ query: '服务器' })
      const paths = s.text.split('\n').map((l) => {
        const m = ABS_TAIL_RE.exec(l)
        return m ? m[1] : null
      }).filter(Boolean)
      assert.ok(paths.length > 0, `wiki_search 应给出路径:\n${s.text.slice(0, 300)}`)
      for (const p of paths) {
        assert.ok(existsSync(p), `真实库路径必须存在: ${p}`)
      }
      assert.ok(paths.some((p) => p.includes(' ')), '真实库路径应含空格（Mobile Documents）')
    })
  })

  // ───────────────────────── 5. 反假绿守卫 ─────────────────────────

  describe('反假绿守卫（测试本身能抓到静默退化）', () => {
    test('标题含 < 时，行尾锚定提取不会把标题片段误当路径', () => {
      // 真实库存在这类标题（`Node < 24.16` / `pi-ai < 0.86` / `firm_s_id<>''`）。
      // 用未锚定的 /<([^>]+)>/g 会把「标题 + (id) + ->」整段当成路径 → 假失败。
      const line = 'Reference: npm -g 升级 openclaw 失败（Node < 24.16 装不了 2026.9.4）'
        + '  (工具环境/npm全局升级openclaw失败并拖累同批包)  ->  </tmp/ref with spaces/a.md>'

      const anchored = ABS_TAIL_RE.exec(line)
      assert.ok(anchored, '行尾锚定应能提取到路径')
      assert.equal(anchored[1], '/tmp/ref with spaces/a.md')

      // 反证：未锚定的写法确实会抓错（这就是不能用它的原因）
      const naive = [...line.matchAll(/<([^>]+)>/g)].map((m) => m[1])
      assert.ok(naive.length > 1 && naive[0] !== '/tmp/ref with spaces/a.md',
        '未锚定写法应暴露其误抓行为，否则本守卫无意义')

      // idOf 必须取到真正的 id，而不是被标题里的括号带偏
      assert.equal(idOf(line), '工具环境/npm全局升级openclaw失败并拖累同批包')
    })

    test('断言真的在检查存在性：故意用错路径必须失败', async () => {
      const core = await import(join(REPO, 'packages', 'core', 'index.mjs'))
      const wrong = join(process.cwd(), '工具环境/含空格 的目录/5楼服务器服务清单')
      // 这正是原 bug 的形状：cwd 相对解释 —— 必须不存在
      assert.equal(existsSync(wrong), false,
        'cwd 下的同名路径不该存在，否则这条守卫失去意义')
      const right = core.conceptAbsPath(spaced, '工具环境/含空格 的目录/5楼服务器服务清单')
      assert.notEqual(right, wrong)
      assert.ok(existsSync(right))
    })

    test('linkTargetOf 不做宽容处理：被截断的裸路径会暴露', () => {
      // 模拟「没加尖括号」的错误形态：CommonMark 会在第一个空格截断
      const bad = 'Reference: 5楼服务器服务清单  (工具环境/x)  ->  /tmp/wiki-ref with spaces/a.md'
      const t = linkTargetOf(bad)
      assert.equal(t, '/tmp/wiki-ref with spaces/a.md')
      // 而 Markdown 真正会拿到的只有第一个空格之前那段 —— 必须不存在
      assert.equal(existsSync(t.split(' ')[0]), false,
        '被截断的那段必须不存在，否则守卫无效')
    })
  })
})
