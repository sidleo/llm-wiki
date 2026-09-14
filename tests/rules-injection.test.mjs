/**
 * tests/rules-injection.test.mjs —— 三形态「分类行为规则」到达 agent 的通道验证。
 *
 * 背景：APPEND_SYSTEM_PROMPT.md 的正文是三形态共同的行为规则。DSH 靠
 * system-prompt 注入、pi 靠 before_agent_start 钩子（见 packages/pi/test）；
 * skill/CLI 宿主没有注入钩子，只能靠 `wiki rules` 显式载入 + 工具响应**附带**
 * （规则随数据到达）。这里验证 core helper 与 CLI 这条通道。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import * as core from '../packages/core/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'packages', 'skill', 'bin', 'wiki.mjs')

/** 跑 CLI，返回 stdout（失败时抛出含 stderr 的错误）。 */
function cli(args, env) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WIKI_DATA_DIR: env, WIKI_REGISTRY_FILE: join(env, 'reg-nothing.json') },
  })
}

describe('规则到达通道（core + skill CLI）', () => {
  let bundle

  before(async () => {
    bundle = await mkdtemp(join(tmpdir(), 'wiki-rules-'))
    // 根规则 + 分类规则（两级）+ 门控声明
    await writeFile(join(bundle, 'APPEND_SYSTEM_PROMPT.md'), '# 库级规则\n\n所有分类都先查库再动手。\n', 'utf8')
    await writeFile(join(bundle, 'AGENTS.md'), '# 根规则\n\n## 约定\n\n这里是给人读的长篇约定，不应随每次响应重复下发。\n', 'utf8')
    await mkdir(join(bundle, 'sql', 'computations'), { recursive: true })
    await writeFile(join(bundle, 'sql', 'APPEND_SYSTEM_PROMPT.md'), '# SQL 规则\n\n用了库中不存在的表 → 自动建 Table。\n', 'utf8')
    await writeFile(join(bundle, 'sql', 'AGENTS.md'), '# SQL 门控\n\n## 门控\n\n- 需 human 确认: Metric\n- 自动记录: Table, Pitfall\n', 'utf8')
    await writeFile(
      join(bundle, 'sql', 'computations', 'rev.md'),
      '---\ntype: Attested Computation\ntitle: 收入\n---\n\n# Computation\n\nselect 1;\n',
      'utf8',
    )
  })

  after(async () => {
    await rm(bundle, { recursive: true, force: true })
  })

  test('readAppends 返回祖先链（根→近）', async () => {
    const appends = await core.readAppends(bundle, 'sql/computations')
    assert.deepEqual(appends.map((a) => a.dir), ['', 'sql'])
    assert.match(appends[0].content, /库级规则/)
    assert.match(appends[1].content, /SQL 规则/)
  })

  test('ruleContextFor 同时给出 APPEND 与 AGENTS 链', async () => {
    const ctx = await core.ruleContextFor(bundle, 'sql/computations')
    assert.equal(ctx.dir, 'sql/computations')
    assert.deepEqual(ctx.appends.map((a) => a.path), ['APPEND_SYSTEM_PROMPT.md', 'sql/APPEND_SYSTEM_PROMPT.md'])
    assert.deepEqual(ctx.rules.map((r) => r.path), ['AGENTS.md', 'sql/AGENTS.md'])
  })

  test('extractGateSection 只取「## 门控」节', async () => {
    const section = core.extractGateSection('---\n# t\n\n## 约定\n\n给人读的\n\n## 门控\n\n- 需 human 确认: Metric\n')
    assert.match(section, /需 human 确认: Metric/)
    assert.doesNotMatch(section, /给人读的/)
    assert.equal(core.extractGateSection('# 无门控节\n\n正文\n'), '')
  })

  test('formatRuleAppendix：带行为规则 + 门控节，不带 AGENTS.md 长篇约定', async () => {
    const text = await core.formatRuleAppendix(bundle, 'sql/computations')
    assert.match(text, /库级规则/)
    assert.match(text, /SQL 规则/)
    assert.match(text, /需 human 确认: Metric/)
    assert.doesNotMatch(text, /这里是给人读的长篇约定/)
  })

  test('formatRuleAppendix：只继承根规则时仅带根 APPEND（无门控节）', async () => {
    await mkdir(join(bundle, 'plain'), { recursive: true })
    await writeFile(join(bundle, 'plain', 'x.md'), '---\ntype: Reference\ntitle: x\n---\n\n正文\n', 'utf8')
    const text = await core.formatRuleAppendix(bundle, 'plain')
    assert.match(text, /库级规则/, '根 APPEND 对所有目录生效')
    assert.doesNotMatch(text, /门控/, '根本没有门控声明就不该出现门控段')
    assert.doesNotMatch(text, /这里是给人读的长篇约定/, '不随响应下发 AGENTS.md 正文')
  })

  test('CLI `wiki rules`（无参）= 载入全部 APPEND 规则全文', () => {
    const out = cli(['rules'], bundle)
    assert.match(out, /本 bundle 全部规则/)
    assert.match(out, /库级规则/)
    assert.match(out, /SQL 规则/)
  })

  test('CLI `wiki rules <目录>` = 该目录生效规则（APPEND 链 + 门控链）', () => {
    const out = cli(['rules', 'sql/computations'], bundle)
    assert.match(out, /APPEND_SYSTEM_PROMPT\.md/)
    assert.match(out, /sql\/APPEND_SYSTEM_PROMPT\.md/)
    assert.match(out, /需 human 确认: Metric/)
  })

  test('CLI `wiki get` 响应自动附带该目录生效规则', () => {
    const out = cli(['get', 'sql/computations/rev'], bundle)
    assert.match(out, /select 1;/)
    assert.match(out, /sql\/computations 生效规则/)
    assert.match(out, /SQL 规则/)
    assert.match(out, /需 human 确认: Metric/)
  })

  test('CLI `wiki create` 响应自动附带该目录生效规则', async () => {
    const out = cli(['create', 'sql/computations/rev2', '--type', 'Table', '--title', 't2', '--body', '正文'], bundle)
    assert.match(out, /created sql\/computations\/rev2/)
    assert.match(out, /sql\/computations 生效规则/)
    assert.match(out, /SQL 规则/)
  })

  test('CLI `wiki prompt` 生成宿主常驻要求（含当前默认库与关键条款）', () => {
    const out = cli(['prompt'], bundle)
    assert.match(out, /自定义指令/, '带粘贴位置说明')
    assert.match(out, /先查库再回答/, '要求先查库')
    assert.match(out, /不要凭记忆回答表结构与口径/, '禁止凭记忆')
    assert.match(out, /wiki rules/, '指明规则载入入口')
    assert.match(out, /--confirmed/, '写明门控确认方式')
    assert.match(out, /scripts\/wiki\.mjs/, 'GUI 宿主 PATH 兜底')
    assert.match(out, /wiki dirs/, '多库提示')
  })

  test('CLI `wiki prompt --raw` 只输出正文；--full 追加同步条款', () => {
    const raw = cli(['prompt', '--raw'], bundle)
    assert.doesNotMatch(raw, /^# 把下面虚线/, '--raw 不带粘贴说明')
    assert.match(raw, /^【llm-wiki 知识库使用要求】/)
    assert.doesNotMatch(raw, /在线同步/, '默认紧凑版不含同步条款')
    assert.match(cli(['prompt', '--raw', '--full'], bundle), /在线同步/)
  })

  test('CLI `wiki help prompt` 解释该命令的用途', () => {
    const out = cli(['help', 'prompt'], bundle)
    assert.match(out, /wiki prompt/)
    assert.match(out, /before_agent_start|system prompt/)
  })
})
