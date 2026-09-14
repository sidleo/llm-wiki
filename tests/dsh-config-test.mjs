/**
 * tests/dsh-config-test.mjs —— DSH 宿主半配置界面验收（mock 宿主，无需 dsh 运行时）。
 *
 * 覆盖：设置命名空间注册（dsh-wiki + schema + base 层）、/api/dsh-wiki/* 路由、
 * 命名 bundle 增删改名/设默认（与 core 注册表一致）、参数保存（写设置层并即时生效）、
 * 体检/重建 index、git 状态与错误指引、服务缺席时的优雅降级。
 *
 * schemastery 未安装（cd packages/dsh && pnpm install）时，依赖设置服务的两节自动 skip。
 */

import { mkdtemp, cp, rm, readFile, access, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, describe, before, after } from 'node:test'

import * as core from '../packages/core/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const plugin = await import(join(ROOT, 'packages', 'dsh', 'wiki.mjs'))

const schemasteryOk = await access(join(ROOT, 'packages', 'dsh', 'node_modules', 'schemastery', 'package.json')).then(() => true, () => false)
const noSchema = schemasteryOk ? false : 'schemastery 未安装（cd packages/dsh && pnpm install）'

/** 最小 host mock：on / tools / inject / get + 假 settings / webServer 服务。 */
function makeCtx({ settingsLive = true } = {}) {
  const tools = new Map()
  const handlers = {}
  const routes = new Map()
  const registered = []
  const services = {}

  if (settingsLive) {
    // 插件只调 register()（空 schema，仅作卡片可见性钥匙）；返回的 scope 不被使用
    services.settings = { register(ns, schema, opts) { registered.push({ ns, schema, opts }); return {} } }
  }
  services.webServer = {
    register(r) {
      // 宿主按路径匹配：同一路径重复注册 = 后注册覆盖前者（真实宿主同样只认一条）
      if (routes.has(r.path)) throw new Error(`重复注册路由 ${r.path}（同一路径只能一条，method 在 handler 内分派）`)
      assert.equal(r.kind, 'exact')
      routes.set(r.path, r)
      return () => {}
    },
  }

  const scoped = { get: (name) => services[name] }
  const ctx = {
    on(evt, fn) { handlers[evt] = fn },
    tools: { register(t) { tools.set(t.name, t) } },
    inject(_deps, cb) { cb(scoped) },
    get: (name) => services[name],
    logger: { warn() {}, error() {} },
  }
  return { ctx, tools, handlers, routes, registered, scoped, services }
}

/** 事件先缓冲、有监听者再投递（handler 首个 await 之后才挂 data/end 监听，时序不能假设）。 */
function makeReq(method, url, body) {
  const req = { method, url, _h: {}, _q: [] }
  req.on = (evt, cb) => {
    ;(req._h[evt] = req._h[evt] || []).push(cb)
    req._flush()
    return req
  }
  req._emit = (evt, arg) => {
    req._q.push([evt, arg])
    req._flush()
  }
  req._flush = () => {
    const rest = []
    for (const [evt, arg] of req._q) {
      const listeners = req._h[evt]
      if (!listeners || !listeners.length) {
        rest.push([evt, arg])
        continue
      }
      for (const cb of listeners) cb(arg)
    }
    req._q = rest
  }
  return req
}

async function callRoute(route, { method = 'GET', url = route.path, body } = {}) {
  const req = makeReq(method, url, body)
  const captured = { code: 200, body: null }
  const res = {
    writeHead(code) { captured.code = code },
    end(text) { captured.body = text ? JSON.parse(text) : null },
  }
  const pending = route.handler(req, res)
  if (body !== undefined) req._emit('data', Buffer.from(JSON.stringify(body)))
  req._emit('end')
  await pending
  return captured
}

const settle = () => new Promise((r) => setTimeout(r, 60))

describe('DSH 插件配置卡片（宿主半）', () => {
  let tmp
  let demo
  let regFile
  let prevRegEnv
  let mock
  let routes
  const route = (path) => routes.get(path)

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'dsh-wiki-config-'))
    demo = join(tmp, 'demo')
    await cp(join(ROOT, 'examples', 'demo-bundle'), demo, { recursive: true })

    prevRegEnv = process.env.WIKI_REGISTRY_FILE
    regFile = join(tmp, 'registry.json')
    process.env.WIKI_REGISTRY_FILE = regFile

    mock = makeCtx()
    routes = mock.routes
    plugin.apply(mock.ctx, { dataDir: demo, dataDirs: { demo }, cacheTtlMs: 0 })
    await settle()
  })

  after(async () => {
    if (prevRegEnv === undefined) delete process.env.WIKI_REGISTRY_FILE
    else process.env.WIKI_REGISTRY_FILE = prevRegEnv
    await rm(tmp, { recursive: true, force: true })
  })

  test('工具与注入不受配置界面影响（14 个工具 + 恒定层 section）', async () => {
    assert.equal(plugin.inject.join(','), 'systemPrompt,tools')
    assert.equal(mock.tools.size, 14)
    const assembly = { sections: [], contexts: [] }
    await mock.handlers['system-prompt/assemble'](assembly, {}, async () => {})
    const section = assembly.sections.find((s) => s.name === 'wiki-registry')
    assert.ok(section, '恒定层 section 缺失')
    assert.match(section.text, /wiki_sync/)
  })

  test('RPC 路由全部注册在 /api/dsh-wiki/*（运行参数已不在卡片里）', () => {
    for (const key of [
      '/api/dsh-wiki/state',
      '/api/dsh-wiki/bundles',
      '/api/dsh-wiki/health',
      '/api/dsh-wiki/index',
      '/api/dsh-wiki/sync',
    ]) {
      assert.ok(routes.has(key), `缺少路由 ${key}`)
    }
  })

  test('卡片调用的 RPC 路径与宿主注册的路由一一对应（防拼写漂移）', async () => {
    const cardSrc = await readFile(join(ROOT, 'packages', 'dsh', 'src', 'client', 'index.ts'), 'utf8')
    const base = (cardSrc.match(/const API = '([^']+)'/) || [])[1]
    assert.ok(base, '未找到卡片里的 API 前缀常量')
    const rels = new Set([...cardSrc.matchAll(/\b(?:api|post)\(\s*[`'"](\/[a-z-]+)/g)].map((m) => m[1]))
    assert.ok(rels.size >= 5, `卡片里只找到 ${rels.size} 个 RPC 路径`)
    const used = new Set([...rels].map((r) => base + r))
    for (const p of used) assert.ok(routes.has(p), `卡片调用了未注册的路由 ${p}`)
    for (const p of routes.keys()) assert.ok(used.has(p), `宿主注册了卡片没用到的路由 ${p}`)
  })

  test('GET /state：注册表 ∪ 部署声明（同名配置优先并标 shadowed）', async () => {
    await core.writeRegistry({ bundles: { demo, 工作: demo }, active: 'demo' })
    const r = await callRoute(route('/api/dsh-wiki/state'))
    assert.equal(r.body.ok, true, JSON.stringify(r.body))
    const names = r.body.entries.map((x) => x.name).sort()
    assert.deepEqual(names, ['demo', '工作'])
    const demoEntry = r.body.entries.find((x) => x.name === 'demo')
    assert.equal(demoEntry.source, 'config')
    assert.equal(demoEntry.shadowed, true, 'config 与注册表同名时应标记 shadowed')
    assert.equal(demoEntry.isBundle, true)
    assert.equal(r.body.active.name, 'demo')
    assert.equal(r.body.settingsNamespace, 'dsh-wiki')
    assert.equal(r.body.config, undefined, '运行参数不应再出现在 /state 里')
  })

  test('POST /bundles：增/设默认/改名/删除，且写回 core 注册表', async () => {
    const other = join(tmp, 'other')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, 'x.md'), '---\ntype: Reference\ntitle: x\n---\n\nx\n')

    let r = await callRoute(route('/api/dsh-wiki/bundles'), { method: 'POST', body: { op: 'add', name: '临时', path: other } })
    assert.equal(r.body.ok, true, JSON.stringify(r.body))
    assert.equal((await core.readRegistry()).bundles['临时'], other)

    r = await callRoute(route('/api/dsh-wiki/bundles'), { method: 'POST', body: { op: 'activate', name: '临时' } })
    assert.equal(r.body.ok, true, JSON.stringify(r.body))
    assert.equal((await core.readRegistry()).active, '临时')

    r = await callRoute(route('/api/dsh-wiki/bundles'), { method: 'POST', body: { op: 'rename', name: '临时', newName: '改名后' } })
    assert.equal(r.body.ok, true, JSON.stringify(r.body))
    let reg = await core.readRegistry()
    assert.equal(reg.bundles['改名后'], other)
    assert.equal(reg.bundles['临时'], undefined)
    assert.equal(reg.active, '改名后', '重命名 active 时应跟随')

    // 删除当前默认 → 拒绝；先切默认再删除 → 成功且不删数据
    r = await callRoute(route('/api/dsh-wiki/bundles'), { method: 'POST', body: { op: 'remove', name: '改名后' } })
    assert.equal(r.body.ok, false)
    assert.match(r.body.error, /默认分支/)

    await callRoute(route('/api/dsh-wiki/bundles'), { method: 'POST', body: { op: 'activate', name: 'demo' } })
    r = await callRoute(route('/api/dsh-wiki/bundles'), { method: 'POST', body: { op: 'remove', name: '改名后' } })
    assert.equal(r.body.ok, true, JSON.stringify(r.body))
    assert.equal((await core.readRegistry()).bundles['改名后'], undefined)
    assert.equal(await access(join(other, 'x.md')).then(() => true, () => false), true, '删除注册不能动磁盘数据')

    // 非法输入
    for (const body of [{ op: 'add', name: 'default', path: other }, { op: 'add', name: 'a/b', path: other }, { op: 'add', name: 'x', path: '' }, { op: 'nope' }]) {
      const bad = await callRoute(route('/api/dsh-wiki/bundles'), { method: 'POST', body })
      assert.equal(bad.body.ok, false, JSON.stringify(body))
    }
    // 重名保护：已存在 / 已被部署配置声明 → 拒绝（避免静默覆盖或被遮蔽）
    await core.writeRegistry({ bundles: { 已存在: other } })
    const dup = await callRoute(route('/api/dsh-wiki/bundles'), { method: 'POST', body: { op: 'add', name: '已存在', path: other } })
    assert.equal(dup.body.ok, false)
    assert.match(dup.body.error, /已存在/)
    const shadow = await callRoute(route('/api/dsh-wiki/bundles'), { method: 'POST', body: { op: 'add', name: 'demo', path: other } })
    assert.equal(shadow.body.ok, false)
    assert.match(shadow.body.error, /部署配置/)
    const renameToExisting = await callRoute(route('/api/dsh-wiki/bundles'), { method: 'POST', body: { op: 'rename', name: '已存在', newName: 'demo' } })
    assert.equal(renameToExisting.body.ok, false)
    await core.removeBundle('已存在')

    // 部署配置声明的目录不可在线删除
    const protectedOne = await callRoute(route('/api/dsh-wiki/bundles'), { method: 'POST', body: { op: 'remove', name: 'demo' } })
    assert.equal(protectedOne.body.ok, false)
    assert.match(protectedOne.body.error, /部署配置/)
  })

  test('飞书库可在挂载时指定本地缓存目录（显式绝对路径 / ~ 展开 / 默认 / 拒绝相对路径）', async () => {
    const token = 'fldcnCACHE1'
    // 1) 显式绝对路径
    const explicit = join(tmp, 'my-feishu-cache')
    let r = await callRoute(route('/api/dsh-wiki/bundles'), { method: 'POST', body: { op: 'add', name: '云库A', kind: 'feishu', folderToken: token, cacheDir: explicit } })
    assert.equal(r.body.ok, true, JSON.stringify(r.body))
    assert.equal(r.body.path, explicit, '注册后 path 应指向指定缓存目录')
    let reg = await core.readRegistry()
    assert.equal(reg.bundles['云库A'].cacheDir, explicit)
    assert.equal(reg.bundles['云库A'].kind, 'feishu')

    // 2) ~/… 展开为 home 绝对路径
    r = await callRoute(route('/api/dsh-wiki/bundles'), { method: 'POST', body: { op: 'add', name: '云库B', kind: 'feishu', folderToken: token, cacheDir: '~/.agents/wiki-cloud/wiki-test-cache' } })
    assert.equal(r.body.ok, true, JSON.stringify(r.body))
    assert.equal(r.body.path, join(process.env.HOME, '.agents', 'wiki-cloud', 'wiki-test-cache'))
    await core.removeBundle('云库B')

    // 3) 留空 → 默认 ~/.agents/wiki-cloud/<名称>
    r = await callRoute(route('/api/dsh-wiki/bundles'), { method: 'POST', body: { op: 'add', name: '云库C', kind: 'feishu', folderToken: token } })
    assert.equal(r.body.ok, true, JSON.stringify(r.body))
    assert.equal(r.body.path, core.defaultCloudDir('云库C'))
    await core.removeBundle('云库C')

    // 4) 相对路径 → 明确拒绝（否则不同宿主 cwd 各认一份）
    r = await callRoute(route('/api/dsh-wiki/bundles'), { method: 'POST', body: { op: 'add', name: '云库D', kind: 'feishu', folderToken: token, cacheDir: 'relative/dir' } })
    assert.equal(r.body.ok, false)
    assert.match(r.body.error, /绝对路径/)
    assert.equal((await core.readRegistry()).bundles['云库D'], undefined, '校验失败不得写注册表')

    // 5) 改名沿用原缓存目录
    r = await callRoute(route('/api/dsh-wiki/bundles'), { method: 'POST', body: { op: 'rename', name: '云库A', newName: '云库A2' } })
    assert.equal(r.body.ok, true, JSON.stringify(r.body))
    assert.equal(r.body.path, explicit, '改名不应改动缓存目录')
    await core.removeBundle('云库A2')
  })

  test('GET /health 与 POST /index（体检 + 派生文件重建）', async () => {
    const h = await callRoute(route('/api/dsh-wiki/health'), { url: '/api/dsh-wiki/health?bundle=demo' })
    assert.equal(h.body.ok, true, JSON.stringify(h.body))
    assert.ok(h.body.tree.concepts > 0)
    assert.equal(typeof h.body.validate.ok, 'boolean')
    assert.ok(Array.isArray(h.body.lint.issues))

    const before = await readFile(join(demo, 'index.md'), 'utf8')
    // 只破坏索引正文、保留根的 okf_version frontmatter（真实场景：手改/合并丢条目）
    await writeFile(join(demo, 'index.md'), '---\nokf_version: 0.2\n---\n\n# 过期的索引\n')
    assert.notEqual(await readFile(join(demo, 'index.md'), 'utf8'), before)
    const idx = await callRoute(route('/api/dsh-wiki/index'), { method: 'POST', body: { bundle: 'demo' } })
    assert.equal(idx.body.ok, true, JSON.stringify(idx.body))
    assert.ok(idx.body.files.includes('index.md'))
    assert.equal(await readFile(join(demo, 'index.md'), 'utf8'), before, 'index.md 应按目录树重新生成')

    const missing = await callRoute(route('/api/dsh-wiki/health'), { url: '/api/dsh-wiki/health?bundle=不存在' })
    assert.equal(missing.body.ok, false)
  })

  test('GET/POST /sync：git 后端状态/失败指引 + 飞书后端初始化', async () => {
    const st = await callRoute(route('/api/dsh-wiki/sync'), { url: '/api/dsh-wiki/sync?bundle=demo' })
    assert.equal(st.body.ok, true, JSON.stringify(st.body))
    assert.equal(st.body.backend, 'git')
    assert.equal(st.body.git.isRepo, false, '示例 bundle 不是 git 仓库')

    const sync = await callRoute(route('/api/dsh-wiki/sync'), { method: 'POST', body: { op: 'sync', bundle: 'demo' } })
    assert.equal(sync.body.ok, false)
    assert.equal(sync.code, 409)
    assert.match(sync.body.next, /init|clone/)

    const cloneNoArgs = await callRoute(route('/api/dsh-wiki/sync'), { method: 'POST', body: { op: 'clone' } })
    assert.equal(cloneNoArgs.body.ok, false)
    assert.match(cloneNoArgs.body.error, /url/)

    // 真仓库：init 后 status 应可用
    const repo = join(tmp, 'repo')
    await cp(join(ROOT, 'examples', 'demo-bundle'), repo, { recursive: true })
    const origin = join(tmp, 'origin.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
    await core.writeRegistry({ bundles: { repo } })
    const init = await callRoute(route('/api/dsh-wiki/sync'), { method: 'POST', body: { op: 'init', bundle: 'repo', remote: origin, branch: 'main' } })
    assert.equal(init.body.ok, true, JSON.stringify(init.body))
    const st2 = await callRoute(route('/api/dsh-wiki/sync'), { url: '/api/dsh-wiki/sync?bundle=repo' })
    assert.equal(st2.body.git.isRepo, true)
    assert.equal(st2.body.git.remote, 'origin')
  })

  test('飞书后端：feishu-init 注册 + /state 带 kind/folderUrl + /sync 分派到飞书', async () => {
    const prevBin = process.env.WIKI_LARK_BIN
    const prevState = process.env.FAKE_LARK_STATE
    const prevRoot = process.env.FAKE_LARK_ROOT
    const stateFile = join(tmp, 'lark-state.json')
    process.env.WIKI_LARK_BIN = join(ROOT, 'tests', 'fixtures', 'fake-lark-cli.mjs')
    process.env.FAKE_LARK_STATE = stateFile
    process.env.FAKE_LARK_ROOT = 'fldcnROOT'
    await writeFile(stateFile, JSON.stringify({ files: {}, dirs: {}, nextId: 1 }))
    try {
      const feishuCache = join(tmp, 'feishu-cache')
      const initR = await callRoute(route('/api/dsh-wiki/sync'), { method: 'POST', body: { op: 'feishu-init', name: '飞书库', newFolder: '永辉知识库', cacheDir: feishuCache, use: false } })
      assert.equal(initR.body.ok, true, JSON.stringify(initR.body))
      assert.match(initR.body.url, /feishu\.cn\/drive\/folder\//)

      const st = await callRoute(route('/api/dsh-wiki/state'))
      const entry = st.body.entries.find((x) => x.name === '飞书库')
      assert.equal(entry.kind, 'feishu')
      assert.ok(entry.folderToken, 'state 应带 folderToken')
      assert.match(entry.folderUrl, /feishu\.cn\/drive\/folder\//)
      assert.equal(entry.cacheDir, feishuCache, 'cacheDir 应为显式传入的隔离目录')
      assert.match(core.defaultCloudDir('飞书库'), /wiki-cloud\/飞书库$/)

      const status = await callRoute(route('/api/dsh-wiki/sync'), { url: '/api/dsh-wiki/sync?bundle=' + encodeURIComponent('飞书库') })
      assert.equal(status.body.backend, 'feishu')
      assert.equal(status.body.feishu.ok, true, JSON.stringify(status.body.feishu))
      assert.equal(status.body.feishu.counts.push, 0, '空缓存 + 空远端 → 无待推送')

      const badOp = await callRoute(route('/api/dsh-wiki/sync'), { method: 'POST', body: { op: 'clone', bundle: '飞书库' } })
      assert.equal(badOp.body.ok, false)
      await core.removeBundle('飞书库')
    } finally {
      for (const [k, v] of [['WIKI_LARK_BIN', prevBin], ['FAKE_LARK_STATE', prevState], ['FAKE_LARK_ROOT', prevRoot]]) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  test('settings 服务缺席时：不注册命名空间（卡片不出现），工具与 RPC 照常', async () => {
    const bare = makeCtx({ settingsLive: false })
    plugin.apply(bare.ctx, { dataDir: demo, dataDirs: { demo } })
    await settle()
    assert.equal(bare.registered.length, 0)
    assert.equal(bare.tools.size, 14)
    assert.ok(bare.routes.has('/api/dsh-wiki/state') && bare.routes.has('/api/dsh-wiki/sync'))
    const st = await callRoute(bare.routes.get('/api/dsh-wiki/state'))
    assert.equal(st.body.ok, true)
  })

  describe('设置命名空间（需 schemastery）', { skip: noSchema }, () => {
    test('注册 dsh-wiki 命名空间：空 schema，仅作为卡片可见性钥匙', () => {
      assert.equal(mock.registered.length, 1, JSON.stringify(mock.registered))
      const { ns, schema, opts } = mock.registered[0]
      assert.equal(ns, 'dsh-wiki')
      assert.equal(opts.applies, 'live')
      assert.equal(opts.base, undefined, '运行参数已不再作为设置层 base 注入')
      // schemastery 的 Schema 实例可调用（宿主会 schema(value) + schema.toJSON()）
      assert.ok(schema && (typeof schema === 'object' || typeof schema === 'function'))
      assert.equal(typeof schema, 'function')
      assert.equal(typeof schema.toJSON, 'function')
      assert.deepEqual(schema({ 未知字段: 1 }), { 未知字段: 1 }, '空 schema 不应拒绝未知键（旧分节不会导致注册失败）')
    })
  })
})
