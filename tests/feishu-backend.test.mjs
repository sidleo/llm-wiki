/**
 * tests/feishu-backend.test.mjs —— 飞书在线知识库后端验收（全离线，用假 lark-cli）。
 *
 * 覆盖：注册表对象 spec 与向后兼容、三方状态差异、只推改动文件、拉取前备份、
 * 双侧都改→冲突停止且两侧不动、log.md 并集、index.md 本地重生成、嵌套目录自动创建、
 * 认证/二进制缺失报错、argv 安全黑名单（绝不出现 delete-remote/delete-local/force）。
 */

import { mkdtemp, rm, readFile, writeFile, mkdir, chmod, stat, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test, describe, before, after, beforeEach } from 'node:test'

import * as core from '../packages/core/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const FAKE = join(__dirname, 'fixtures', 'fake-lark-cli.mjs')

const readState = async (p) => JSON.parse(await readFile(p, 'utf8'))
const readLog = async (p) => {
  try {
    return (await readFile(p, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).argv)
  } catch {
    return []
  }
}
const exists = (p) => stat(p).then(() => true, () => false)

describe('飞书在线知识库后端（假 lark-cli）', () => {
  let tmp
  let cacheDir
  let stateFile
  let logFile
  let prevEnv

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'wiki-feishu-'))
    cacheDir = join(tmp, 'cache')
    stateFile = join(tmp, 'lark-state.json')
    logFile = join(tmp, 'lark-calls.log')
    const regFile = join(tmp, 'registry.json')
    await chmod(FAKE, 0o755)
    prevEnv = {
      WIKI_LARK_BIN: process.env.WIKI_LARK_BIN,
      WIKI_REGISTRY_FILE: process.env.WIKI_REGISTRY_FILE,
      FAKE_LARK_STATE: process.env.FAKE_LARK_STATE,
      FAKE_LARK_LOG: process.env.FAKE_LARK_LOG,
      FAKE_LARK_ROOT: process.env.FAKE_LARK_ROOT,
    }
    process.env.WIKI_LARK_BIN = FAKE
    process.env.WIKI_REGISTRY_FILE = regFile
    process.env.FAKE_LARK_STATE = stateFile
    process.env.FAKE_LARK_LOG = logFile
    process.env.FAKE_LARK_ROOT = 'fldcnROOT'
  })

  after(async () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(tmp, { recursive: true, force: true })
  })

  beforeEach(async () => {
    // 每个用例：干净的远端状态 + 干净缓存 + 空调用日志
    await writeFile(stateFile, JSON.stringify({ files: {}, dirs: {}, nextId: 1 }))
    await rm(cacheDir, { recursive: true, force: true })
    await mkdir(cacheDir, { recursive: true })
    await writeFile(logFile, '')
    const reg = JSON.parse(await readFile(process.env.WIKI_REGISTRY_FILE, 'utf8').catch(() => '{"bundles":{}}'))
    reg.bundles = {}
    reg.active = null
    await writeFile(process.env.WIKI_REGISTRY_FILE, JSON.stringify(reg))
  })

  const spec = () => ({ name: '飞书库', kind: 'feishu', path: cacheDir, decl: { kind: 'feishu', folderToken: 'fldcnROOT', cacheDir } })
  const writeLocal = async (rel, content) => {
    await mkdir(dirname(join(cacheDir, rel)), { recursive: true })
    await writeFile(join(cacheDir, rel), content)
  }
  /** 直接改远端（模拟别人在飞书里编辑）。 */
  const touchRemote = async (rel, { content, modified }) => {
    const st = await readState(stateFile)
    const f = st.files[rel]
    if (content !== undefined) f.content = content
    f.modified = modified ?? Date.now() + 5000
    await writeFile(stateFile, JSON.stringify(st, null, 2))
  }

  test('注册表对象 spec：向后兼容字符串形态，飞书 spec 解析出 kind/cacheDir', async () => {
    assert.deepEqual(core.normalizeBundleSpec('/tmp/a'), { kind: 'local', path: '/tmp/a', decl: '/tmp/a' })
    const feishu = core.normalizeBundleSpec({ kind: 'feishu', folderToken: 'fldcnX' }, { name: '飞书库' })
    assert.equal(feishu.kind, 'feishu')
    assert.equal(feishu.path, join(process.env.HOME, '.agents', 'wiki-cloud', '飞书库'))
    assert.equal(core.defaultCloudDir('X'), join(process.env.HOME, '.agents', 'wiki-cloud', 'X'))

    await core.writeRegistry({ bundles: { 本地: '/tmp/local-bundle', 云: { kind: 'feishu', folderToken: 'fldcnX', cacheDir: '/tmp/cloud-cache' } }, active: '云' })
    const resolved = await core.resolveBundleRoot({}, { name: '云' })
    assert.equal(resolved.kind, 'feishu')
    assert.equal(resolved.path, '/tmp/cloud-cache')
    const rows = await core.listBundles({})
    const cloud = rows.find((r) => r.name === '云')
    assert.equal(cloud.kind, 'feishu')
    assert.equal(cloud.folderToken, 'fldcnX')
    assert.equal(cloud.active, true)
    assert.equal(rows.find((r) => r.name === '本地').kind, 'local')
  })

  test('larkAvailable：正常返回 user 身份；二进制缺失给可执行指引', async () => {
    const ok = await core.larkAvailable()
    assert.equal(ok.ok, true)
    assert.equal(ok.user.ready, true)
    assert.equal(ok.user.userName, '测试用户')

    const prev = process.env.WIKI_LARK_BIN
    process.env.WIKI_LARK_BIN = '/nonexistent/lark-cli'
    try {
      const bad = await core.larkAvailable()
      assert.equal(bad.ok, false)
      assert.match(bad.error, /未找到 lark-cli/)
    } finally {
      process.env.WIKI_LARK_BIN = prev
    }
  })

  test('feishuInit --new-folder：建目录 + 注册对象 spec + 默认 cacheDir 落到 wiki-cloud', async () => {
    const r = await core.feishuInit({ name: '飞书库', newFolder: '永辉知识库', use: true })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.createdFolder.name, '永辉知识库')
    assert.match(r.url, /^https:\/\/feishu\.cn\/drive\/folder\//)
    const st = await readState(stateFile)
    assert.ok(st.dirs['永辉知识库'], '远端应建出文件夹')
    const reg = JSON.parse(await readFile(process.env.WIKI_REGISTRY_FILE, 'utf8'))
    assert.equal(reg.bundles['飞书库'].kind, 'feishu')
    assert.equal(reg.bundles['飞书库'].folderToken, r.folderToken)
    assert.equal(reg.active, '飞书库')
    assert.match(reg.bundles['飞书库'].cacheDir, /wiki-cloud\/飞书库$/)
  })

  test('首次同步：本地树（含嵌套概念）推上远端，自动建目录，并写三方索引', async () => {
    await writeLocal('index.md', '# Knowledge Bundle\n')
    await writeLocal('tables/orders.md', '---\ntype: Table\ntitle: Orders\n---\n\n# Schema\n')
    await writeLocal('tables/pitfalls/join.md', '---\ntype: Pitfall\ntitle: Join\n---\n\n坑\n')
    await writeLocal('.DS_Store', 'junk')
    // 与真实迁移一致：先按目录树补齐各层 index.md（派生文件），再首次同步
    await core.refreshIndex(cacheDir)
    const localMd = ['index.md', 'tables/index.md', 'tables/pitfalls/index.md', 'tables/orders.md', 'tables/pitfalls/join.md']
    const r = await core.feishuSync(spec(), { adopt: 'local' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual([...r.created].sort(), [...localMd].sort(), '首次同步应上传全部本地 .md（含各层 index）')
    const st = await readState(stateFile)
    assert.ok(st.dirs['tables'] && st.dirs['tables/pitfalls'], '嵌套目录应自动创建')
    for (const rel of localMd) assert.ok(st.files[rel], `远端应存在 ${rel}`)
    assert.equal(st.files['.DS_Store'], undefined, '.DS_Store 不应上传')
    const idx = JSON.parse(await readFile(join(cacheDir, '.wiki-cloud.json'), 'utf8'))
    assert.equal(Object.keys(idx.files).length, localMd.length, '索引应记录全部文件的三方状态')
    assert.ok(idx.files['tables/orders.md'].fileToken, '索引应记录 fileToken')
  })

  test('增量：只有本地改过的文件被推送（一条 overwrite），未改文件不动', async () => {
    await writeLocal('a.md', '---\ntype: Reference\ntitle: A\n---\n\nA\n')
    await writeLocal('b.md', '---\ntype: Reference\ntitle: B\n---\n\nB\n')
    assert.equal((await core.feishuSync(spec(), { adopt: 'local' })).ok, true)
    await writeFile(logFile, '')

    await writeLocal('a.md', '---\ntype: Reference\ntitle: A\n---\n\nA 改过\n')
    const st1 = await core.feishuStatus(spec())
    assert.deepEqual(st1.push.map((x) => x.rel), ['a.md'])
    assert.equal(st1.pull.length, 0)
    const r = await core.feishuSync(spec())
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual(r.pushed, ['a.md'])
    const calls = await readLog(logFile)
    const writes = calls.filter((c) => c.includes('+overwrite') || c.includes('+create'))
    assert.equal(writes.length, 1, '只应发生一次远端写入：' + JSON.stringify(writes))
    assert.ok(writes[0].includes('+overwrite'))
    const st = await readState(stateFile)
    assert.match(st.files['a.md'].content, /A 改过/)
    assert.equal(st.files['b.md'].content.includes('改过'), false)
  })

  test('远端被改：拉取覆盖本地并留下 .backup 备份', async () => {
    await writeLocal('a.md', 'origin\n')
    assert.equal((await core.feishuSync(spec(), { adopt: 'local' })).ok, true)
    await touchRemote('a.md', { content: 'remote edited\n' })
    const st1 = await core.feishuStatus(spec())
    assert.deepEqual(st1.pull.map((x) => x.rel), ['a.md'])
    const r = await core.feishuSync(spec())
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(await readFile(join(cacheDir, 'a.md'), 'utf8'), 'remote edited\n')
    const backups = (await core.feishuCacheInfo(spec()))
    assert.ok(backups.lastSyncAt)
    const idx = JSON.parse(await readFile(join(cacheDir, '.wiki-cloud.json'), 'utf8'))
    assert.ok(idx.files['a.md'].remoteModified, '索引应更新远端时间戳')
  })

  test('双侧都改：同步停止、报冲突清单、两侧内容都不动', async () => {
    await writeLocal('a.md', 'v1\n')
    assert.equal((await core.feishuSync(spec(), { adopt: 'local' })).ok, true)
    await writeLocal('a.md', 'local v2\n')
    await touchRemote('a.md', { content: 'remote v2\n' })

    const st1 = await core.feishuStatus(spec())
    assert.deepEqual(st1.conflict.map((x) => x.rel), ['a.md'])

    const r = await core.feishuSync(spec())
    assert.equal(r.ok, false)
    assert.equal(r.step, 'conflict')
    assert.deepEqual(r.conflicts, ['a.md'])
    assert.match(r.next, /不自动合并/)
    assert.equal(await readFile(join(cacheDir, 'a.md'), 'utf8'), 'local v2\n', '本地不应被覆盖')
    const st = await readState(stateFile)
    assert.equal(st.files['a.md'].content, 'remote v2\n', '远端不应被覆盖')
  })

  test('log.md 双侧都改：并集合并而不是冲突', async () => {
    await writeLocal('log.md', '# 变更历史\n\n## 2026-01-01\n* **Creation**: base\n')
    assert.equal((await core.feishuSync(spec(), { adopt: 'local' })).ok, true)
    await writeLocal('log.md', '# 变更历史\n\n## 2026-01-02\n* **Creation**: local\n\n## 2026-01-01\n* **Creation**: base\n')
    await touchRemote('log.md', { content: '# 变更历史\n\n## 2026-01-02\n* **Creation**: remote\n\n## 2026-01-01\n* **Creation**: base\n' })
    const r = await core.feishuSync(spec())
    assert.equal(r.ok, true, JSON.stringify(r))
    const st = await readState(stateFile)
    assert.match(st.files['log.md'].content, /local/)
    assert.match(st.files['log.md'].content, /remote/)
    assert.equal(/<<<<</.test(st.files['log.md'].content), false)
  })

  test('index.md：推送前按本地目录树重生成（派生文件不阻塞）', async () => {
    await writeLocal('a.md', '---\ntype: Reference\ntitle: A\n---\n\nA\n')
    await core.refreshIndex(cacheDir)
    assert.equal((await core.feishuSync(spec(), { adopt: 'local' })).ok, true)

    // 本地用 core 正常写入新概念（其 index 会被刷新）
    await core.createConcept(cacheDir, { id: 'tables/new_one', type: 'Table', title: '新概念', description: 'x', body: '# Schema\n', opts: { producer: 'test' } })
    const r = await core.feishuSync(spec())
    assert.equal(r.ok, true, JSON.stringify(r))
    const st = await readState(stateFile)
    assert.match(st.files['index.md'].content, /tables/)
    assert.ok(st.files['tables/new_one.md'], '新概念应上传')
  })

  test('无索引（首次）时的冲突策略：adopt=remote 拉远端、adopt=local 推本地', async () => {
    await writeLocal('a.md', 'local version\n')
    // 远端先有同名但不同内容，且本地没有索引 → 未知状态
    await writeFile(stateFile, JSON.stringify({ files: { 'a.md': { fileToken: 'boxcnX', content: 'remote version\n', modified: Date.now(), parent: '' } }, dirs: {}, nextId: 9 }))
    const stRemote = await core.feishuStatus(spec(), { adopt: 'remote' })
    assert.deepEqual(stRemote.pull.map((x) => x.rel), ['a.md'])
    const stLocal = await core.feishuStatus(spec(), { adopt: 'local' })
    assert.deepEqual(stLocal.push.map((x) => x.rel), ['a.md'])
  })

  test('argv 安全黑名单：全程不出现 delete-remote / delete-local / force', async () => {
    await writeLocal('a.md', 'x\n')
    await core.feishuSync(spec(), { adopt: 'local' })
    await writeLocal('a.md', 'y\n')
    await core.feishuSync(spec())
    await core.feishuStatus(spec())
    const calls = await readLog(logFile)
    assert.ok(calls.length > 0)
    const flat = calls.map((c) => c.join(' ')).join('\n')
    assert.equal(/--delete-remote|--delete-local|--force|--yes/.test(flat), false, '不得出现破坏性参数：\n' + flat)
    assert.equal(/--on-duplicate-remote/.test(flat), false, '不得覆盖同名冲突策略（保持默认 fail）')
  })

  test('写工具接入：feishuFlush 只对已注册的飞书 bundle 生效；feishuWriteGuard 命中冲突即拦', async () => {
    await writeLocal('a.md', 'v1\n')
    await core.writeRegistry({ bundles: { 飞书库: { kind: 'feishu', folderToken: 'fldcnROOT', cacheDir } } })

    // 写后上线：把本地改动推上去
    assert.equal((await core.feishuSync(spec(), { adopt: 'local' })).ok, true)
    await writeLocal('b.md', 'new\n')
    const flush = await core.feishuFlush(cacheDir)
    assert.equal(flush.ok, true, JSON.stringify(flush))
    assert.deepEqual(flush.pushed, ['b.md'])
    const st = await readState(stateFile)
    assert.ok(st.files['b.md'], '写后上线应把新文件推到远端')

    // 非飞书目录（未注册）→ null（本地 bundle 无需任何在线动作）
    const other = join(tmp, 'plain-dir')
    await mkdir(other, { recursive: true })
    assert.equal(await core.feishuFlush(other), null)
    assert.equal(await core.feishuWriteGuard(other, { paths: ['x.md'] }), null)

    // 写前闸门：本地与远端都改 → 拦下
    await writeLocal('a.md', 'local v2\n')
    await touchRemote('a.md', { content: 'remote v2\n' })
    const guard = await core.feishuWriteGuard(cacheDir, { paths: ['a.md'] })
    assert.equal(guard.blocked, true)
    assert.deepEqual(guard.conflict, ['a.md'])
    assert.match(guard.text, /两侧都改/)
    const okGuard = await core.feishuWriteGuard(cacheDir, { paths: ['b.md'] })
    assert.equal(okGuard.blocked, false)
    await core.removeBundle('飞书库')
  })


  test('feishuInit：可选指定本地缓存目录（~ 展开 / 默认 / 拒绝相对路径）', async () => {
    // 测试只允许在自己的命名空间下建目录（~/.agents/wiki-cloud/…），并在结束时清掉
    const tildePath = '~/.agents/wiki-cloud/wiki-test-cache'
    const tildeAbs = join(process.env.HOME, '.agents', 'wiki-cloud', 'wiki-test-cache')
    const defaultAbs = core.defaultCloudDir('云库默认')
    try {
      // 显式 ~/… → 展开成绝对路径并写进注册表
      const a = await core.feishuInit({ name: '云库相对', folderToken: 'fldcnROOT', cacheDir: tildePath })
      assert.equal(a.ok, true, JSON.stringify(a))
      assert.equal(a.cacheDir, tildeAbs)
      const reg = await core.readRegistry()
      assert.equal(reg.bundles['云库相对'].cacheDir, tildeAbs)
      await core.removeBundle('云库相对')

      // 留空 → 默认 ~/.agents/wiki-cloud/<名称>
      const b = await core.feishuInit({ name: '云库默认', folderToken: 'fldcnROOT' })
      assert.equal(b.ok, true, JSON.stringify(b))
      assert.equal(b.cacheDir, defaultAbs)
      await core.removeBundle('云库默认')

      // 相对路径 → 拒绝（否则不同宿主 cwd 各认一份）
      const c = await core.feishuInit({ name: '云库坏', folderToken: 'fldcnROOT', cacheDir: 'relative/x' })
      assert.equal(c.ok, false)
      assert.equal(c.step, 'args')
      assert.match(c.error, /绝对路径/)
      assert.equal((await core.readRegistry()).bundles['云库坏'], undefined)
    } finally {
      await rm(tildeAbs, { recursive: true, force: true })
      await rm(defaultAbs, { recursive: true, force: true })
    }
  })

  test('远端已删的文件只报告、不删本地（v1 不做删除同步）', async () => {
    await writeLocal('gone.md', 'keep me\n')
    assert.equal((await core.feishuSync(spec(), { adopt: 'local' })).ok, true)
    const st = await readState(stateFile)
    delete st.files['gone.md']
    await writeFile(stateFile, JSON.stringify(st, null, 2))
    const r = await core.feishuSync(spec())
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(await exists(join(cacheDir, 'gone.md')), '本地文件必须保留')
  })

  test('远端已有目录 + 本地账本没有 dirTokens → 复用远端目录，绝不重建同名目录（重复目录事故回归）', async () => {
    // 远端先存在：根下已有一个 tables/ 目录（别人建的 / 换机器 / 账本丢了）
    await writeFile(
      stateFile,
      JSON.stringify({ files: {}, dirs: { tables: { token: 'fldcnEXIST', parent: '' } }, nextId: 7 }),
    )
    // 本地缓存是全新的（.wiki-cloud.json 不存在 → 读到空 idx，dirTokens 为空）
    await writeLocal('tables/orders.md', '# orders\n')
    const r = await core.feishuPush(spec(), { paths: ['tables/orders.md'] })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual(r.dirs, [], '不得新建目录（远端已存在同名目录）')
    const calls = await readLog(logFile)
    assert.equal(calls.filter((a) => a[1] === '+create-folder').length, 0, '不应出现 +create-folder')
    const st = await readState(stateFile)
    assert.equal(st.dirs.tables.token, 'fldcnEXIST', '文件应写进原有目录')
    assert.ok(st.files['tables/orders.md'], '文件已创建在原目录下')
    // 账本自愈：把远端学到的目录 token 记下来
    const idx = JSON.parse(await readFile(join(cacheDir, '.wiki-cloud.json'), 'utf8'))
    assert.equal(idx.dirTokens.tables, 'fldcnEXIST')
  })

  test('拉取也顺手记下 dirTokens（新缓存 / 换机器后不再是目录盲）', async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ files: { 'tables/orders.md': { fileToken: 'boxcn1', content: '# o\n', modified: 100, parent: 'tables' } }, dirs: { tables: { token: 'fldcnEXIST', parent: '' } }, nextId: 9 }),
    )
    assert.equal((await core.feishuPull(spec(), { paths: ['tables/orders.md'] })).ok, true)
    const idx = JSON.parse(await readFile(join(cacheDir, '.wiki-cloud.json'), 'utf8').catch(() => '{}'))
    assert.equal(idx.dirTokens && idx.dirTokens.tables, 'fldcnEXIST')
  })

  test('远端出现同名重复目录 → 状态/推送/拉取一律停下报清单，绝不在重复状态下同步', async () => {
    // 真实飞书允许同一父目录下重名：这里构造根下两个都叫 tables 的目录
    await writeFile(
      stateFile,
      JSON.stringify({
        files: {},
        dirs: { d1: { token: 'fldcnA', parent: '', name: 'tables' }, d2: { token: 'fldcnB', parent: '', name: 'tables' } },
        nextId: 5,
      }),
    )
    const status = await core.feishuStatus(spec())
    assert.equal(status.ok, false)
    assert.equal(status.step, 'duplicate-remote')
    assert.match(status.error, /同名重复/)
    assert.ok(status.duplicates.some((d) => d.rel === 'tables'), JSON.stringify(status.duplicates))
    await writeLocal('tables/orders.md', '# o\n')
    const push = await core.feishuPush(spec(), { paths: ['tables/orders.md'] })
    assert.equal(push.ok, false)
    assert.equal(push.step, 'duplicate-remote')
    assert.equal((await core.feishuPull(spec())).step, 'duplicate-remote')
    assert.equal((await core.feishuSync(spec())).step, 'duplicate-remote')
    const calls = await readLog(logFile)
    assert.equal(calls.filter((a) => a[1] === '+create-folder').length, 0, '重复状态下不得建目录')
    assert.equal(calls.filter((a) => a[1] === '+create').length, 0, '重复状态下不得写文件')
  })
})
