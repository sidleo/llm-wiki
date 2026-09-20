/**
 * tests/feishu-delete.test.mjs —— 飞书后端「真删除」（feishuDelete）验收。
 *
 * 背景：v1 不同步删除，把「一侧有、另一侧无」当新增，所以只删一侧必被下次同步复活。
 * 要真删除必须两侧都删 + 清账本条目。本文件验收这套动作，重点是**两条安全红线**：
 *   1. 只删显式传入的路径（绝不按差异推断）；
 *   2. 另一侧有未同步改动时拒删并报清单（绝不覆盖式删除）。
 * 另验：dry-run 默认不删、首个失败即停不假装成功、删完不复活且账本归零。
 */

import { mkdtemp, rm, readFile, writeFile, mkdir, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test, describe, before, after, beforeEach } from 'node:test'

import * as core from '../packages/core/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FAKE = join(__dirname, 'fixtures', 'fake-lark-cli.mjs')

const exists = (p) => stat(p).then(() => true, () => false)
const readLog = async (p) => {
  try {
    return (await readFile(p, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).argv)
  } catch {
    return []
  }
}

describe('飞书后端真删除（feishuDelete）', () => {
  let tmp
  let cacheDir
  let stateFile
  let logFile
  let prevEnv

  before(async () => {
    await chmod(FAKE, 0o755)
  })

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'wiki-del-'))
    cacheDir = join(tmp, 'cache')
    stateFile = join(tmp, 'lark-state.json')
    logFile = join(tmp, 'lark-calls.log')
    await mkdir(join(cacheDir, 'tables'), { recursive: true })
    await writeFile(stateFile, JSON.stringify({ files: {}, dirs: {}, nextId: 1 }))
    await writeFile(logFile, '')
    prevEnv = { ...process.env }
    process.env.WIKI_LARK_BIN = FAKE
    process.env.WIKI_REGISTRY_FILE = join(tmp, 'registry.json')
    process.env.FAKE_LARK_STATE = stateFile
    process.env.FAKE_LARK_LOG = logFile
    process.env.FAKE_LARK_ROOT = 'fldcnROOT'
  })

  after(async () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  const spec = () => ({ name: '云库', kind: 'feishu', path: cacheDir, decl: { kind: 'feishu', folderToken: 'fldcnROOT', cacheDir } })
  const readState = async () => JSON.parse(await readFile(stateFile, 'utf8'))
  const readLedger = async () => JSON.parse(await readFile(join(cacheDir, '.wiki-cloud.json'), 'utf8'))

  /** 建立基线：两个文件推上去（账本齐全，两侧一致）。 */
  async function baseline() {
    await writeFile(join(cacheDir, 'tables/a.md'), '# A\n')
    await writeFile(join(cacheDir, 'tables/b.md'), '# B\n')
    const r = await core.feishuSync(spec(), { adopt: 'local' })
    assert.equal(r.ok, true, JSON.stringify(r))
  }

  test('必须显式给路径：paths 为空直接报错（绝不按差异推断该删什么）', async () => {
    await baseline()
    const r = await core.feishuDelete(spec(), {})
    assert.equal(r.ok, false)
    assert.match(r.error, /显式指定路径/)
    assert.deepEqual(await readLog(logFile).then((c) => c.filter((a) => a.includes('+delete'))), [])
  })

  test('拒绝同步域外的路径（非 .md / .backup / 账本等）', async () => {
    await baseline()
    for (const bad of ['tables/a.txt', '.wiki-cloud.json', 'index.md.bak']) {
      const r = await core.feishuDelete(spec(), { paths: [bad], apply: true })
      assert.equal(r.ok, false, `${bad} 不该被允许`)
      assert.match(r.error, /不可删除的路径/)
    }
  })

  test('dry-run 默认：只预演，两侧都不动', async () => {
    await baseline()
    const r = await core.feishuDelete(spec(), { paths: ['tables/a.md'] })
    assert.equal(r.ok, true)
    assert.equal(r.dryRun, true)
    assert.deepEqual(r.willDelete, ['tables/a.md'])
    assert.equal(await exists(join(cacheDir, 'tables/a.md')), true, 'dry-run 不得删本地')
    assert.ok((await readState()).files['tables/a.md'], 'dry-run 不得删远端')
    assert.deepEqual(await readLog(logFile).then((c) => c.filter((a) => a.includes('+delete'))), [])
  })

  test('apply：两侧都删 + 清账本，且后续同步不再复活、remoteDeleted 归零', async () => {
    await baseline()
    const r = await core.feishuDelete(spec(), { paths: ['tables/a.md'], apply: true })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual(r.deleted, ['tables/a.md'])
    assert.equal(r.failed.length, 0)

    assert.equal(await exists(join(cacheDir, 'tables/a.md')), false, '本地应已删')
    assert.equal((await readState()).files['tables/a.md'], undefined, '远端应已删')
    assert.equal((await readLedger()).files['tables/a.md'], undefined, '账本条目应已清')

    // 关键：接下来的同步不能把它拉回来
    const st = await core.feishuStatus(spec())
    assert.deepEqual(st.pull, [], '不该再有待拉取（复活）')
    assert.deepEqual(st.push, [], '也不该有待推送（推回远端）')
    assert.deepEqual(st.remoteDeleted, [], '账本已清，不该再重复报告远端已删')
    const sync = await core.feishuSync(spec())
    assert.equal(sync.ok, true)
    assert.deepEqual(sync.pushed, [])
    assert.deepEqual(sync.pulled, [])
    assert.equal(await exists(join(cacheDir, 'tables/a.md')), false, '同步后仍不该复活')
  })

  test('另一侧有未同步改动时拒删并报清单（绝不覆盖式删除）', async () => {
    await baseline()
    // 本地改了但没同步 → 删掉会丢改动
    await writeFile(join(cacheDir, 'tables/a.md'), '# A 改过\n')
    const local = await core.feishuDelete(spec(), { paths: ['tables/a.md'], apply: true })
    assert.equal(local.ok, false)
    assert.equal(local.step, 'blocked')
    assert.match(local.error, /未同步的改动/)
    assert.equal(await exists(join(cacheDir, 'tables/a.md')), true, '拒删时本地不动')
    assert.ok((await readState()).files['tables/a.md'], '拒删时远端不动')

    // 远端改了但本地没动 → 同样拒删
    await core.feishuSync(spec()) // 先把上面的本地改动同步掉，回到一致
    const st = await readState()
    st.files['tables/b.md'].content = '# B 远端改过\n'
    st.files['tables/b.md'].modified += 9999
    await writeFile(stateFile, JSON.stringify(st))
    const remote = await core.feishuDelete(spec(), { paths: ['tables/b.md'], apply: true })
    assert.equal(remote.ok, false)
    assert.match(remote.error, /远端该文件在上次同步后被改过/)
    assert.ok((await readState()).files['tables/b.md'], '拒删时远端不动')
    assert.equal(await exists(join(cacheDir, 'tables/b.md')), true, '拒删时本地不动')
  })

  test('无账本记录（两侧都在但没基线）时不猜，要求先同步', async () => {
    await writeFile(join(cacheDir, 'tables/a.md'), '# A\n')
    // 直接手工造一个远端文件，绕过同步（因此没有账本记录）
    const st = await readState()
    st.files['tables/a.md'] = { fileToken: 'boxcnMANUAL', content: '# A\n', modified: Date.now(), parent: 'tables' }
    st.dirs.tables = { token: 'fldcnT', parent: '' }
    await writeFile(stateFile, JSON.stringify(st))

    const r = await core.feishuDelete(spec(), { paths: ['tables/a.md'], apply: true })
    assert.equal(r.ok, false)
    assert.match(r.error, /没有同步账本记录/)
  })

  test('幂等：两侧都已不存在 → 记入 missing 并（若有）清掉账本残留，不报错', async () => {
    await baseline()
    await core.feishuDelete(spec(), { paths: ['tables/a.md'], apply: true })
    const again = await core.feishuDelete(spec(), { paths: ['tables/a.md'], apply: true })
    assert.equal(again.ok, true)
    assert.deepEqual(again.deleted, [])
    assert.deepEqual(again.missing, ['tables/a.md'])
  })

  test('只删点名文件：同目录其它文件一律不动', async () => {
    await baseline()
    const r = await core.feishuDelete(spec(), { paths: ['tables/a.md'], apply: true })
    assert.equal(r.ok, true)
    assert.equal(await exists(join(cacheDir, 'tables/b.md')), true, 'b.md 必须在')
    assert.ok((await readState()).files['tables/b.md'], 'b.md 远端必须在')
    const dels = (await readLog(logFile)).filter((a) => a.includes('+delete'))
    assert.equal(dels.length, 1, `应只删一个文件，实际 ${dels.length}`)
  })

  test('远端删除被拒时如实报告并停止（不假装成功、不删后续）', async () => {
    await baseline()
    process.env.FAKE_LARK_DENY_WRITES = '1' // 让 +delete 失败（列表仍可读）
    try {
      const r = await core.feishuDelete(spec(), { paths: ['tables/a.md', 'tables/b.md'], apply: true })
      assert.equal(r.ok, false)
      assert.equal(r.failed.length, 1)
      assert.equal(r.failed[0].step, 'remote')
      assert.deepEqual(r.deleted, [], '首个失败即停，不该有已删')
      assert.equal(await exists(join(cacheDir, 'tables/a.md')), true, '远端没删成功，本地也不该删')
      assert.ok((await readState()).files['tables/a.md'], '远端应还在')
      assert.ok((await readState()).files['tables/b.md'], '失败后不该继续删第二个')
    } finally {
      delete process.env.FAKE_LARK_DENY_WRITES
    }
  })

  test('CLI 端到端：wiki sync delete 预演 → --apply → 同步不复活', async () => {
    const { spawnSync } = await import('node:child_process')
    const REG = process.env.WIKI_REGISTRY_FILE
    // 用 CLI 自己的注册表副本，避免与 core 直连用例互相污染
    const regCli = join(tmp, 'registry-cli.json')
    await writeFile(regCli, JSON.stringify({ bundles: { 云库: { kind: 'feishu', folderToken: 'fldcnROOT', cacheDir } }, active: '云库' }))
    await writeFile(join(cacheDir, 'tables/cli.md'), '# CLI\n')
    const env = { ...process.env, WIKI_REGISTRY_FILE: regCli }
    const cli = join(__dirname, '..', 'packages', 'skill', 'bin', 'wiki.mjs')
    const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env })

    assert.equal(run(['sync', '--wiki', '云库']).status, 0, '基线同步应成功')

    const dry = run(['sync', 'delete', 'tables/cli.md', '--wiki', '云库'])
    assert.equal(dry.status, 0)
    assert.match(dry.stdout, /预演：将删除 1 个文件/)
    assert.equal(await exists(join(cacheDir, 'tables/cli.md')), true, '预演不得删本地')
    assert.ok((await readState()).files['tables/cli.md'], '预演不得删远端')

    const applied = run(['sync', 'delete', 'tables/cli.md', '--wiki', '云库', '--apply'])
    assert.equal(applied.status, 0)
    assert.match(applied.stdout, /已删除 1 个文件/)
    assert.equal(await exists(join(cacheDir, 'tables/cli.md')), false, 'CLI 应删掉本地')
    assert.equal((await readState()).files['tables/cli.md'], undefined, 'CLI 应删掉远端')

    const post = run(['sync', '--wiki', '云库'])
    assert.equal(post.status, 0)
    assert.equal(await exists(join(cacheDir, 'tables/cli.md')), false, 'CLI 同步后不该复活')
    void REG
  })

  test('批量删多个：一次调用全部删掉', async () => {
    await baseline()
    const r = await core.feishuDelete(spec(), { paths: ['tables/a.md', 'tables/b.md'], apply: true })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual(r.deleted.sort(), ['tables/a.md', 'tables/b.md'])
    const st = await core.feishuStatus(spec())
    assert.deepEqual(st.pull, [])
    assert.deepEqual(st.push, [])
    assert.deepEqual(st.remoteDeleted, [])
  })
})
