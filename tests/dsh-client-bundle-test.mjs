/**
 * tests/dsh-client-bundle-test.mjs —— DSH 客户端半（配置页）验收。
 *
 * 两层验证：
 * 1) 产物契约：lib/client.js 必须是 __ModuleLoader__ 外壳 + CJS 工厂，id 等于包名，
 *    只 require 平台基线模块，导出 apply/inject，并注册进两个 slot
 *    （settings.section 的 id / plugins.bundle.config 的 key 都要对得上）；
 *    0.2.0 的清单/基线口径见 tests/dsh-020-contract-test.mjs（那份钉 0.2.0-rc.1 的出处）；
 * 2) 渲染冒烟：jsdom 里挂载页面，用打桩的 /api/dsh-wiki/state 与 /sync 断言四个区真的渲染。
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

/**
 * DSH shell 的平台基线模块（发布版 staticModules，只有这些可以不进 dsh.client.external）。
 * 表值与 DSH 0.2.0-rc.1 一致：@deepseek-ai/dsh-web-frontend@0.2.0-rc.1
 * dist/assets/index-Dy0OhsZ5.js 的 `QS()`（`create({boot, staticModules: QS()})`）。
 * 0.1.7-rc.2 与 0.2.0-rc.1 这张表相同；0.2.1-rc.2 为 11 项（多 zod、@tanstack/react-virtual，
 * 旧 9 项是子集，本断言只按子集校验）；升级 DSH 后按同法重新核对。
 */
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

/** 插件配置面：两个 slot 各一处入口，同一个页面组件（slot 契约 0.1.7 起未变，0.2.0-rc.1 同）。 */
const SECTION_SLOT = 'settings.section'
const BUNDLE_SLOT = 'plugins.bundle.config'

const built = await access(BUNDLE).then(() => true, () => false)
const depsOk = await access(join(PKG, 'node_modules', 'react', 'package.json')).then(() => true, () => false)
const skip = !built ? `客户端半未构建（cd packages/dsh && pnpm install && pnpm run build）` : !depsOk ? 'packages/dsh/node_modules 缺失（pnpm install）' : false

describe('DSH 配置页（客户端半）', { skip }, () => {
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

  test('package.json 声明：exports["./client"] + dsh.client.platform=web + 引擎下限', async () => {
    const pkg = JSON.parse(await readFile(join(PKG, 'package.json'), 'utf8'))
    assert.equal(pkg.exports['./client'], './lib/client.js')
    assert.equal(pkg.dsh.client.platform, 'web')
    assert.ok(pkg.files.includes('lib/client.js'))
    assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'), 'slots 服务来自该包')
    assert.match(pkg.engines.dsh, />=0\.1\.7/, `页面只面向 0.1.7+ 的 slot 契约，实际声明 ${pkg.engines.dsh}`)
  })

  test('不再注册已移除的旧 slot（settings.plugin.item）与旧设置命名空间钥匙', () => {
    assert.equal(/inject\(\s*["']settings\.plugin\.item/.test(source), false, '旧 slot 已随 DSH 0.1.7 移除')
    assert.equal(/name:\s*["']settings\.plugin\.item["']/.test(source), false)
    assert.equal(source.includes('settingsNamespace'), false, '旧「已服务命名空间 ∩ 已注册卡片」钥匙应已移除')
  })
})

describe('DSH 配置页（jsdom 渲染冒烟）', { skip }, () => {
  const calls = []
  let container
  let teardown = []
  let registrations = []

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

    // 打桩后端：页面只跟 /api/dsh-wiki/* 对话
    const state = {
      ok: true,
      active: { name: '工作', path: '/tmp/wiki' },
      dataDir: '/tmp/fallback',
      registryPath: '/tmp/wiki-registry.json',
      entries: [{ name: '工作', path: '/tmp/wiki', source: 'registry', shadowed: false, active: true, exists: true, isDir: true, isBundle: true }],
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

    // 打桩 slots 服务：真实宿主里 slot 由官方包声明，声明出现后回调；这里立即回调
    registrations = []
    const slots = {
      inject(_name, cb) { cb() },
      register(opts, Comp) { registrations.push({ opts, Comp }); return () => {} },
    }
    exports_.apply({ get: (n) => (n === 'slots' ? slots : undefined) })

    container = document.getElementById('root')
    const root = createRoot(container)
    const act = React.act || React.unstable_act
    await act(async () => {
      root.render(React.createElement(registrations[0].Comp))
      await new Promise((r) => setTimeout(r, 30))
    })
    teardown.push(() => act(() => root.unmount()))
  })

  test('注册进两个 slot：设置区块 + bundle 页面（同一个页面组件）', () => {
    assert.deepEqual(registrations.map((r) => r.opts.name), [SECTION_SLOT, BUNDLE_SLOT], '两个入口都要注册')

    const section = registrations[0].opts
    assert.equal(section.id, 'llm-wiki', 'settings.section 的 id 就是导航项 key')
    assert.equal(typeof section.order, 'number')
    assert.equal(section.label, 'llm-wiki 知识库')

    const bundle = registrations[1].opts
    assert.equal(bundle.key, '@sidleo3/dsh-wiki', 'plugins.bundle.config 的 key = bundle 包名')
    assert.ok(registrations.every((r) => r.Comp !== undefined && r.Comp !== null), '组件未注册')
  })

  test('页面先渲染标题与当前默认分支摘要', () => {
    const text = container.textContent
    assert.match(text, /llm-wiki 知识库/)
    assert.match(text, /默认：工作/)
    assert.ok(container.querySelector('h2.dwTitle'), '设置区块自绘标题')
    assert.equal(container.querySelector('li.dwCard'), null, '旧折叠卡片外壳应已移除')
  })

  test('四个区都渲染，并读了 /state、/sync、/autosync', async () => {
    await new Promise((r) => setTimeout(r, 40))
    const text = container.textContent
    for (const title of ['命名目录（bundle）', '在线同步', '定时自动同步', '体检与索引']) {
      assert.ok(text.includes(title), `缺少区块：${title}\n${text.slice(0, 400)}`)
    }
    assert.equal(text.includes('运行参数'), false, '运行参数区应已删除')
    assert.equal(text.includes('保存参数'), false, '保存参数按钮应已删除')
    assert.equal(/[ABCD] · /.test(text), false, '区块标题不应再有 A/B/C/D 前缀')
    assert.ok(text.includes('origin') && text.includes('领先 1'), 'git 状态未渲染')
    assert.ok(text.includes('/tmp/wiki-registry.json'), '注册表路径未渲染')
    assert.ok(calls.some((u) => u.includes('/api/dsh-wiki/state')), '未读取 /state')
    assert.ok(calls.some((u) => u.includes('/api/dsh-wiki/sync')), '未读取 /sync')
    assert.ok(calls.some((u) => u.includes('/api/dsh-wiki/autosync')), '未读取 /autosync')
    assert.equal(calls.some((u) => u.includes('/api/dsh-wiki/config')), false, '不应再调用 /config')
    // 新增表单支持两种后端
    assert.ok(text.includes('本地目录') && text.includes('飞书云盘库'), '缺少新增类型切换（本地/飞书）')
  })

  test('飞书后端：派生文件的冲突与概念冲突分开显示（前者同步会自动处理）', async () => {
    const React = (await import(pathToFileURL(join(PKG, 'node_modules', 'react', 'index.js')).href)).default
    const { createRoot } = await import(pathToFileURL(join(PKG, 'node_modules', 'react-dom', 'client.js')).href)
    const act = React.act || React.unstable_act
    const prevFetch = global.fetch
    global.fetch = async (url) => {
      const u = String(url)
      const body = u.includes('/sync')
        ? {
            ok: true,
            backend: 'feishu',
            feishu: {
              ok: true,
              counts: { push: 0, pull: 0, conflict: 4, local: 10, remote: 10 },
              conflict: [{ rel: 'index.md' }, { rel: '工具环境/index.md' }, { rel: 'log.md' }, { rel: 'tables/orders.md' }],
            },
          }
        : {
            ok: true,
            active: { name: '工作', path: '/tmp/wiki' },
            registryPath: '/tmp/wiki-registry.json',
            entries: [{ name: '工作', path: '/tmp/wiki', kind: 'feishu', folderToken: 'fldX', folderUrl: 'https://feishu.cn/drive/folder/fldX', cacheDir: '/tmp/wiki', source: 'registry', active: true, exists: true, isDir: true, isBundle: true }],
            git: { ok: true },
          }
      return { ok: true, status: 200, json: async () => body }
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(React.createElement(registrations[0].Comp))
      await new Promise((r) => setTimeout(r, 60))
    })
    const text = host.textContent
    const human = text.slice(text.indexOf('冲突（两侧都改'), text.indexOf('派生文件两侧都变'))
    assert.ok(human.includes('tables/orders.md'), '概念冲突要列出来：' + human)
    assert.equal(human.includes('index.md'), false, '派生文件不该混进「需人工处理」：' + human)
    assert.ok(/派生文件两侧都变[^]{0,200}index\.md/.test(text), '派生文件应另行说明会自动处理')
    assert.match(text, /log\.md/)
    teardown.push(() => act(() => root.unmount()))
    teardown.push(() => host.remove())
    teardown.push(() => {
      global.fetch = prevFetch
    })
  })

  test('bundle 页面入口不再重复画标题（宿主已画标题与包名）', async () => {
    const React = (await import(pathToFileURL(join(PKG, 'node_modules', 'react', 'index.js')).href)).default
    const { createRoot } = await import(pathToFileURL(join(PKG, 'node_modules', 'react-dom', 'client.js')).href)
    const act = React.act || React.unstable_act
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(React.createElement(registrations[1].Comp))
      await new Promise((r) => setTimeout(r, 30))
    })
    assert.equal(host.querySelector('h2.dwTitle'), null, 'bundle 页面不应重复标题')
    assert.ok(host.textContent.includes('命名目录（bundle）'))
    teardown.push(() => act(() => root.unmount()))
    teardown.push(() => host.remove())
  })

  test('teardown', async () => {
    for (const fn of teardown) await fn()
    teardown = []
  })
})

// 保持引用：部分运行时（node --test）会 GC 掉未使用的 import
void readdir
