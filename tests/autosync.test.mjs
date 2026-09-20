/**
 * tests/autosync.test.mjs —— 定时自动同步：配置持久化 + 调度判据 + 插件调度器接线。
 *
 * 覆盖：默认值（未配置 = 关闭）与默认间隔 5 分钟、间隔夹取、身份规整、
 * 结果回写、陈旧 running 判定，以及 DSH 插件里调度器的「只跑飞书 bundle /
 * 未开启不跑 / 冲突不覆盖」边界。全离线（假 lark-cli），不依赖真实飞书。
 */

import { mkdtemp, rm, chmod, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test, describe, before, after, beforeEach } from 'node:test'

import * as core from '../packages/core/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FAKE = join(__dirname, 'fixtures', 'fake-lark-cli.mjs')

/** 最小 ctx：只需 tools.inject 与 on（与 dsh-mock-test 同风格）。 */
function mockCtx() {
  const handlers = {}
  return {
    on(evt, fn) {
      handlers[evt] = fn
    },
    tools: { register() {} },
    systemPrompt: {},
    inject(_deps, cb) {
      return cb({ get() {
        return undefined
      } })
    },
    _handlers: handlers,
  }
}

describe('定时自动同步配置（core/autosync）', () => {
  let tmp
  let file
  let prevEnv

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'wiki-autosync-'))
    file = join(tmp, 'autosync.json')
    prevEnv = process.env.WIKI_AUTOSYNC_FILE
    process.env.WIKI_AUTOSYNC_FILE = file
  })

  after(async () => {
    if (prevEnv === undefined) delete process.env.WIKI_AUTOSYNC_FILE
    else process.env.WIKI_AUTOSYNC_FILE = prevEnv
    await rm(tmp, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await rm(file, { force: true })
  })

  test('默认：未配置的 bundle 一律关闭，间隔默认 5 分钟、身份 auto', async () => {
    const s = await core.autosyncSettingsFor('云库')
    assert.equal(s.enabled, false)
    assert.equal(s.intervalMinutes, 5)
    assert.equal(s.identity, 'auto')
    assert.equal(s.lastRunAt, null)
  })

  test('默认间隔常量就是 5 分钟（用户可改，默认值固定）', () => {
    assert.equal(core.DEFAULT_INTERVAL_MINUTES, 5)
  })

  test('间隔夹取：小于下限抬到 1，大于上限压到 1440，非法回落默认', () => {
    assert.equal(core.normalizeInterval(0.2), core.MIN_INTERVAL_MINUTES)
    assert.equal(core.normalizeInterval(99999), core.MAX_INTERVAL_MINUTES)
    assert.equal(core.normalizeInterval('abc'), core.DEFAULT_INTERVAL_MINUTES)
    assert.equal(core.normalizeInterval(7), 7)
  })

  test('身份规整：非法值回落 auto；canUseBot=false 时 bot 降级为 auto', () => {
    assert.equal(core.normalizeIdentity('robot'), 'auto')
    assert.equal(core.normalizeIdentity('BOT'), 'bot')
    assert.equal(core.normalizeIdentity('bot', { canUseBot: false }), 'auto')
    assert.equal(core.normalizeIdentity(undefined), 'auto')
  })

  test('写入只动传入字段，其余保留；落盘是原子 JSON', async () => {
    await core.setAutosyncSettings('云库', { enabled: true, intervalMinutes: 10, identity: 'user' })
    await core.setAutosyncSettings('云库', { intervalMinutes: 30 })
    const s = await core.autosyncSettingsFor('云库')
    assert.equal(s.enabled, true, '只改间隔不应把开启状态改掉')
    assert.equal(s.identity, 'user')
    assert.equal(s.intervalMinutes, 30)
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.bundles['云库'].intervalMinutes, 30)
  })

  test('多 bundle 互不干扰', async () => {
    await core.setAutosyncSettings('A', { enabled: true, intervalMinutes: 5 })
    await core.setAutosyncSettings('B', { enabled: false, intervalMinutes: 60 })
    assert.equal((await core.autosyncSettingsFor('A')).enabled, true)
    assert.equal((await core.autosyncSettingsFor('A')).intervalMinutes, 5)
    assert.equal((await core.autosyncSettingsFor('B')).enabled, false)
    assert.equal((await core.autosyncSettingsFor('B')).intervalMinutes, 60)
  })

  test('运行结果回写：成功与失败都记（卡片要看「上次同步」）', async () => {
    await core.recordAutosyncRun('云库', { ok: true, pushed: ['a.md', 'b.md'], pulled: ['c.md'] })
    let s = await core.autosyncSettingsFor('云库')
    assert.ok(s.lastRunAt)
    assert.deepEqual(s.lastResult, { ok: true, pushed: 2, pulled: 1, conflicts: 0, error: null })

    await core.recordAutosyncRun('云库', { ok: false, error: 'user 与 bot 身份都不可用' })
    s = await core.autosyncSettingsFor('云库')
    assert.equal(s.lastResult.ok, false)
    assert.match(s.lastResult.error, /都不可用/)
  })

  test('running 标记与陈旧判定：正常运行不算陈旧，超时（崩溃残留）才接管', async () => {
    assert.equal(core.isStaleRunning(null, 5), false)
    assert.equal(core.isStaleRunning(new Date().toISOString(), 5), false)
    assert.equal(core.isStaleRunning(new Date(Date.now() - 60 * 60 * 1000).toISOString(), 5), true)
    assert.equal(core.isStaleRunning('不是时间', 5), true)
    await core.markAutosyncRunning('云库', true)
    assert.ok((await core.autosyncSettingsFor('云库')).runningSince)
    await core.markAutosyncRunning('云库', false)
    assert.equal((await core.autosyncSettingsFor('云库')).runningSince, null)
  })

  test('坏配置（非 JSON / 结构不对）不炸，回落默认', async () => {
    await writeFile(file, '这不是 JSON')
    assert.equal((await core.autosyncSettingsFor('云库')).enabled, false)
    await writeFile(file, JSON.stringify({ version: 1, bundles: 'not-an-object' }))
    assert.equal((await core.autosyncSettingsFor('云库')).intervalMinutes, 5)
  })

  test('配置文件是机器本地事实：默认落在 ~/.agents/ 下，不进 bundle', async () => {
    const prev = process.env.WIKI_AUTOSYNC_FILE
    delete process.env.WIKI_AUTOSYNC_FILE
    try {
      assert.match(core.autosyncFile(), /\.agents\/wiki-autosync\.json$/)
    } finally {
      if (prev !== undefined) process.env.WIKI_AUTOSYNC_FILE = prev
    }
  })
})

describe('定时自动同步调度器（DSH 插件）', () => {
  let tmp
  let cacheDir
  let prevEnv
  let plugin

  before(async () => {
    plugin = await import(join(__dirname, '..', 'packages', 'dsh', 'wiki.mjs'))
    await chmod(FAKE, 0o755)
  })

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'wiki-autosync-dsh-'))
    cacheDir = join(tmp, 'cache')
    await mkdir(join(cacheDir, 'tables'), { recursive: true })
    await writeFile(join(cacheDir, 'tables/orders.md'), '# orders\n')
    prevEnv = { ...process.env }
    process.env.WIKI_LARK_BIN = FAKE
    process.env.WIKI_REGISTRY_FILE = join(tmp, 'registry.json')
    process.env.WIKI_AUTOSYNC_FILE = join(tmp, 'autosync.json')
    process.env.FAKE_LARK_STATE = join(tmp, 'state.json')
    process.env.FAKE_LARK_LOG = join(tmp, 'log')
    process.env.FAKE_LARK_ROOT = 'fldcnROOT'
    await writeFile(process.env.FAKE_LARK_STATE, JSON.stringify({ files: {}, dirs: {}, nextId: 1 }))
    await writeFile(
      process.env.WIKI_REGISTRY_FILE,
      JSON.stringify({ bundles: { 云库: { kind: 'feishu', folderToken: 'fldcnROOT', cacheDir } }, active: '云库' }),
    )
  })

  after(async () => {
    // 必须还原环境：WIKI_AUTOSYNC_FILE 若不还原，会残留本用例的临时路径，
    // 甚至让别的用例把条目写进真实 ~/.agents/wiki-autosync.json（曾把 demo 泄漏进去）。
    for (const [k, v] of Object.entries(prevEnv || {})) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(tmp, { recursive: true, force: true })
  })

  /**
   * 造一个真实控制器：loadCore 走插件同款解析（vendor-core），effectiveConfig 给最小配置。
   * 这样测的是调度器本体，而不是它的复制品。
   */
  async function controller() {
    const vcore = await import(join(__dirname, '..', 'packages', 'dsh', 'vendor-core', 'index.mjs'))
    return plugin.createAutosync({
      loadCore: async () => vcore,
      effectiveConfig: () => ({ dataDir: cacheDir, cacheTtlMs: 0 }),
      invalidateCaches: () => {},
    })
  }

  test('未开启任何 bundle 时，一次 tick 不发起任何飞书调用（默认关闭是硬默认）', async () => {
    const auto = await controller()
    await auto.tick()
    const calls = await readFile(process.env.FAKE_LARK_LOG, 'utf8').catch(() => '')
    assert.equal(calls.trim(), '', '未开启任何 bundle 时不应发起飞书调用')
  })

  test('开启后 tick 真正把本地改动推上去，并回写 lastRunAt/lastResult', async () => {
    const auto = await controller()
    await core.setAutosyncSettings('云库', { enabled: true, intervalMinutes: 5, identity: 'auto' })
    await auto.tick()
    const s = await core.autosyncSettingsFor('云库')
    assert.ok(s.lastRunAt, '应记录上次运行时间')
    assert.equal(s.lastResult.ok, true, JSON.stringify(s.lastResult))
    assert.equal(s.lastResult.pushed, 1)
    assert.equal(s.runningSince, null, '跑完后 running 标记应清掉')
    const state = JSON.parse(await readFile(process.env.FAKE_LARK_STATE, 'utf8'))
    assert.ok(state.files['tables/orders.md'], '文件应已推到远端')
  })

  test('到点判据：间隔内重跑会被跳过（不重复打飞书）', async () => {
    const auto = await controller()
    await core.setAutosyncSettings('云库', { enabled: true, intervalMinutes: 30, identity: 'auto' })
    await auto.tick()
    await writeFile(process.env.FAKE_LARK_LOG, '')
    await auto.tick()
    const calls = await readFile(process.env.FAKE_LARK_LOG, 'utf8')
    assert.equal(calls.trim(), '', '间隔内不应再次同步')
  })

  test('同步失败不抛异常，只把错误记进配置（定时器必须活下去）', async () => {
    const auto = await controller()
    await core.setAutosyncSettings('云库', { enabled: true, intervalMinutes: 5, identity: 'auto' })
    process.env.FAKE_LARK_USER_READY = '0'
    process.env.FAKE_LARK_BOT_READY = '0'
    try {
      await auto.tick()
    } finally {
      delete process.env.FAKE_LARK_USER_READY
      delete process.env.FAKE_LARK_BOT_READY
    }
    const s = await core.autosyncSettingsFor('云库')
    assert.equal(s.lastResult.ok, false)
    assert.match(s.lastResult.error, /都不可用/)
    assert.equal(s.runningSince, null)
  })

  test('冲突时停下只报告，绝不覆盖任何一侧', async () => {
    const auto = await controller()
    // 先建立基线：本地推送一次
    await core.setAutosyncSettings('云库', { enabled: true, intervalMinutes: 5, identity: 'auto' })
    await auto.tick()
    const idx = JSON.parse(await readFile(join(cacheDir, '.wiki-cloud.json'), 'utf8'))
    const rel = 'tables/orders.md'
    // 远端改：动 modified 时间与内容
    const state = JSON.parse(await readFile(process.env.FAKE_LARK_STATE, 'utf8'))
    state.files[rel].content = '# 远端版本\n'
    state.files[rel].modified = idx.files[rel].remoteModified + 5000
    await writeFile(process.env.FAKE_LARK_STATE, JSON.stringify(state))
    await writeFile(join(cacheDir, rel), '# 本地版本\n')

    auto.stop()
    const auto2 = await controller()
    await auto2.tick()
    assert.equal(await readFile(join(cacheDir, rel), 'utf8'), '# 本地版本\n', '冲突时本地不被覆盖')
    const after = JSON.parse(await readFile(process.env.FAKE_LARK_STATE, 'utf8'))
    assert.equal(after.files[rel].content, '# 远端版本\n', '冲突时远端不被覆盖')
    const s = await core.autosyncSettingsFor('云库')
    assert.equal(s.lastResult.ok, false)
    assert.equal(s.lastResult.conflicts, 1)
  })

  test('派生文件（index.md）双侧都改时不阻塞定时同步——5 楼实测回归', async () => {
    // 两台机器各自重生成 index.md（内容只是概念计数不同），曾被判为冲突 →
    // 定时同步每 5 分钟失败一次、永远同步不了。index.md 是派生文件，必须重生成而非阻塞。
    const auto = await controller()
    await core.refreshIndex(cacheDir)
    await core.setAutosyncSettings('云库', { enabled: true, intervalMinutes: 5, identity: 'auto' })
    await auto.tick()
    assert.equal((await core.autosyncSettingsFor('云库')).lastResult.ok, true, '基线同步应成功')

    // 两侧都动 index.md
    await core.refreshIndex(cacheDir)
    const st = JSON.parse(await readFile(process.env.FAKE_LARK_STATE, 'utf8'))
    assert.ok(st.files['index.md'], '基线后远端应有 index.md')
    st.files['index.md'].content = '# Knowledge Bundle\n\n（远端自己的一份）\n'
    st.files['index.md'].modified += 5000
    await writeFile(process.env.FAKE_LARK_STATE, JSON.stringify(st))

    auto.stop()
    const auto2 = await controller()
    await auto2.tick()
    const s2 = await core.autosyncSettingsFor('云库')
    assert.equal(s2.lastResult.ok, true, `index.md 不该阻塞定时同步：${JSON.stringify(s2.lastResult)}`)
    assert.equal(s2.lastResult.conflicts, 0)
  })

  test('真冲突（概念文件两侧都改）仍然阻塞定时同步——豁免只给派生文件', async () => {
    const auto = await controller()
    await core.setAutosyncSettings('云库', { enabled: true, intervalMinutes: 5, identity: 'auto' })
    await auto.tick()
    // 远端改概念文件 + 本地也改 → 真冲突
    const st = JSON.parse(await readFile(process.env.FAKE_LARK_STATE, 'utf8'))
    st.files['tables/orders.md'].content = '# 远端版\n'
    st.files['tables/orders.md'].modified += 5000
    await writeFile(process.env.FAKE_LARK_STATE, JSON.stringify(st))
    await writeFile(join(cacheDir, 'tables/orders.md'), '# 本地版\n')

    auto.stop()
    const auto2 = await controller()
    await auto2.tick()
    const s2 = await core.autosyncSettingsFor('云库')
    assert.equal(s2.lastResult.ok, false, '真冲突必须停下报告')
    assert.equal(s2.lastResult.conflicts, 1)
    // 两侧内容都不许被覆盖
    assert.equal(await readFile(join(cacheDir, 'tables/orders.md'), 'utf8'), '# 本地版\n')
    const after = JSON.parse(await readFile(process.env.FAKE_LARK_STATE, 'utf8'))
    assert.equal(after.files['tables/orders.md'].content, '# 远端版\n')
  })

  test('runNow 对未注册的 bundle 明确报错（不静默当作无事发生）', async () => {
    const auto = await controller()
    await assert.rejects(() => auto.runNow('不存在'), /未知 bundle/)
  })

  test('status 汇总给出每个飞书 bundle 的设置与间隔（卡片数据源）', async () => {
    const auto = await controller()
    await core.setAutosyncSettings('云库', { enabled: true, intervalMinutes: 15 })
    const st = await auto.status()
    assert.equal(st.ok, true)
    const row = st.bundles.find((b) => b.name === '云库')
    assert.equal(row.enabled, true)
    assert.equal(row.intervalMinutes, 15)
    assert.match(st.file, /autosync\.json$/)
  })
})

