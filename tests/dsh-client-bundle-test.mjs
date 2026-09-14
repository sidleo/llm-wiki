/**
 * tests/dsh-client-bundle-test.mjs —— DSH 客户端半（配置卡片）验收。
 *
 * 两层验证：
 * 1) 产物契约：lib/client.js 必须是 __ModuleLoader__ 外壳 + CJS 工厂，id 等于包名，
 *    只 require 平台基线模块，导出 apply/inject，卡片 key 等于设置命名空间；
 * 2) 渲染冒烟：jsdom 里挂载卡片，用打桩的 /api/dsh-wiki/state 与 /git 断言四个区真的渲染。
 *
 * 需要 packages/dsh/node_modules（cd packages/dsh && pnpm install && pnpm build）。
 */

import { readFile, readdir, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test, describe, before } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PKG = join(ROOT, 'packages', 'dsh')
const BUNDLE = join(PKG, 'lib', 'client.js')

/** DSH shell 的平台基线模块（发布版 staticModules，只有这些可以不进 dsh.client.external）。 */
const BASELINE = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const built = await access(BUNDLE).then(() => true, () => false)
const depsOk = await access(join(PKG, 'node_modules', 'react', 'package.json')).then(() => true, () => false)
const skip = !built ? `客户端半未构建（cd packages/dsh && pnpm install && pnpm run build）` : !depsOk ? 'packages/dsh/node_modules 缺失（pnpm install）' : false

describe('DSH 配置卡片（客户端半）', { skip }, () => {
  let source

  before(async () => {
    source = await readFile(BUNDLE, 'utf8')
  })

  test('产物契约：__ModuleLoader__ 外壳 + 包名 id + 只 require 基线模块', () => {
    assert.match(source, /^window\.__ModuleLoader__\.load\(/, '第一行必须是 load 调用（前面多任何字节宿主都认不出）')
    assert.match(source, /@sidleo3\/dsh-wiki/, 'bundle id 必须等于包名')
    assert.match(source, /factory: \(require\) =>/)
    assert.match(source, /return module\.exports;/)
    const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
    assert.ok(required.length > 0, '应当 require react')
    for (const spec of new Set(required)) {
      assert.ok(BASELINE.includes(spec), `require("${spec}") 不在平台基线内（需要 dsh.client.external + 供给行）`)
    }
  })

  test('package.json 声明：exports["./client"] + dsh.client.platform=web', async () => {
    const pkg = JSON.parse(await readFile(join(PKG, 'package.json'), 'utf8'))
    assert.equal(pkg.exports['./client'], './lib/client.js')
    assert.equal(pkg.dsh.client.platform, 'web')
    assert.ok(pkg.files.includes('lib/client.js'))
    assert.ok(pkg.dependencies.schemastery, '宿主半注册命名空间需要 schemastery')
  })
})

describe('DSH 配置卡片（jsdom 渲染冒烟）', { skip }, () => {
  const calls = []
  let container
  let teardown = []

  before(async () => {
    const { JSDOM } = await import(pathToFileURL(join(PKG, 'node_modules', 'jsdom', 'lib', 'api.js')).href).then((m) => m.default || m)
    const React = (await import(pathToFileURL(join(PKG, 'node_modules', 'react', 'index.js')).href)).default
    const jsxRuntime = await import(pathToFileURL(join(PKG, 'node_modules', 'react', 'jsx-runtime.js')).href)
    const { createRoot } = await import(pathToFileURL(join(PKG, 'node_modules', 'react-dom', 'client.js')).href)

    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:3080/' })
    global.window = dom.window
    global.document = dom.window.document
    global.IS_REACT_ACT_ENVIRONMENT = true // 让 React.act 生效（消除 act 警告）
    // Node 自带只读 global.navigator：不要覆盖（React DOM 会用它做特性判断）

    // 打桩后端：卡片只跟 /api/dsh-wiki/* 对话
    const state = {
      ok: true,
      settingsNamespace: 'dsh-wiki',
      active: { name: '永辉', path: '/tmp/wiki' },
      dataDir: '/tmp/fallback',
      registryPath: '/tmp/wiki-registry.json',
      entries: [{ name: '永辉', path: '/tmp/wiki', source: 'registry', shadowed: false, active: true, exists: true, isDir: true, isBundle: true }],
      git: { ok: true, version: 'git version 2' },
    }
    const git = { ok: true, remote: 'origin', branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, dirty: [' M log.md'], conflicts: [], lastCommit: 'abc1234 2026-01-01 wiki: sync' }
    global.fetch = async (url) => {
      calls.push(String(url))
      const u = String(url)
      const body = u.includes('/sync') ? { ok: true, bundle: state.active, backend: 'git', git } : state
      return { ok: true, status: 200, json: async () => body }
    }

    // 捕获 bundle 工厂并执行（等价于 DSH 的 /plugins 装载）
    let registration = null
    dom.window.__ModuleLoader__ = { load(reg) { registration = reg } }
    await import(pathToFileURL(BUNDLE).href + '?t=' + Date.now())
    assert.ok(registration, 'bundle 必须调用 __ModuleLoader__.load')
    assert.equal(registration.id, '@sidleo3/dsh-wiki')

    const reactShim = { __esModule: true, default: React, ...React }
    const exports_ = registration.factory((spec) => {
      if (spec === 'react') return reactShim
      if (spec === 'react/jsx-runtime') return jsxRuntime
      throw new Error('unexpected require: ' + spec)
    })
    assert.equal(typeof exports_.apply, 'function')
    assert.deepEqual(exports_.inject, ['slots'])

    let slotName = null
    let options = null
    let Component = null
    exports_.apply({
      get: (n) => (n === 'slots' ? { inject: (key, cb) => { slotName = key; cb() }, register: (opts, Comp) => { options = opts; Component = Comp; return () => {} } } : undefined),
    })
    assert.equal(slotName, 'settings.plugin.item')
    assert.equal(options.key, 'dsh-wiki', 'card key 必须等于宿主设置命名空间')
    assert.ok(Component, '卡片组件未注册')

    container = document.getElementById('root')
    const root = createRoot(container)
    const act = React.act || React.unstable_act
    await act(async () => {
      root.render(React.createElement(Component))
      await new Promise((r) => setTimeout(r, 30))
    })
    teardown.push(() => act(() => root.unmount()))
  })

  test('折叠态先渲染卡片标题与当前默认分支摘要', () => {
    const text = container.textContent
    assert.match(text, /llm-wiki 知识库/)
    assert.match(text, /默认：永辉/)
  })

  test('展开后三个区都渲染，且不再有运行参数区，并读了 /state 与 /git', async () => {
    const React = (await import(pathToFileURL(join(PKG, 'node_modules', 'react', 'index.js')).href)).default
    const act = React.act || React.unstable_act
    const header = container.querySelector('button.dwHeader')
    await act(async () => {
      header.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 40))
    })
    const text = container.textContent
    for (const title of ['命名目录（bundle）', '在线同步', '体检与索引']) {
      assert.ok(text.includes(title), `缺少区块：${title}\n${text.slice(0, 400)}`)
    }
    assert.equal(text.includes('运行参数'), false, '运行参数区应已删除')
    assert.equal(text.includes('保存参数'), false, '保存参数按钮应已删除')
    assert.equal(/[ABCD] · /.test(text), false, '区块标题不应再有 A/B/C/D 前缀')
    assert.ok(text.includes('origin') && text.includes('领先 1'), 'git 状态未渲染')
    assert.ok(text.includes('/tmp/wiki-registry.json'), '注册表路径未渲染')
    assert.ok(calls.some((u) => u.includes('/api/dsh-wiki/state')), '未读取 /state')
    assert.ok(calls.some((u) => u.includes('/api/dsh-wiki/sync')), '未读取 /sync')
    assert.equal(calls.some((u) => u.includes('/api/dsh-wiki/config')), false, '不应再调用 /config')
    // 新增表单支持两种后端
    assert.ok(text.includes('本地目录') && text.includes('飞书云盘库'), '缺少新增类型切换（本地/飞书）')
  })

  test('teardown', async () => {
    for (const fn of teardown) await fn()
    teardown = []
  })
})

// 保持引用：部分运行时（node --test）会 GC 掉未使用的 import
void readdir
