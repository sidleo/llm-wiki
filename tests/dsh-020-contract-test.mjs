/**
 * tests/dsh-020-contract-test.mjs —— DSH **0.2.0** 契约固化（离线可跑，不依赖网络与本机 DSH 安装）。
 *
 * 与 tests/dsh-client-bundle-test.mjs 的分工：那份做客户端半的产物契约 + jsdom 渲染冒烟；
 * 这份只钉「0.2.0 这一版平台给的是什么、插件必须怎么对齐」，并把真实 0.2.0 运行时里
 * 实跑观测到的宿主半工具/路由面固化成断言。
 *
 * ── 契约出处（全部取自本机已安装的 0.2.0-rc.1 产物，逐条写明包名+版本+文件）─────────────
 *
 * [A] 平台基线模块表 staticModules（浏览器里能直接 require 的模块，共 9 个）
 *     @deepseek-ai/dsh-web-frontend@0.2.0-rc.1
 *       dist/assets/index-Dy0OhsZ5.js，`function QS(){return{...}}`，由 `iM.run()` 传给
 *       `__ModuleLoader__.create({boot, staticModules: QS(), ...})`。
 *     【版本相关】hash 文件名随版本变；升级 DSH 后要重新核对这张表。
 *     0.2.1-rc.2（dsh-web-frontend dist/assets/index-CN7NIWNw.js 的 `SZ()`）为 11 项：
 *     旧 9 项 + `zod`、`@tanstack/react-virtual`，无删除；本文件仍按 0.2.0 的 9 项固化。
 * [B] 客户端外壳与引导门面
 *     @deepseek-ai/dsh-client-modules@0.2.0-rc.1 lib/client.js（browser half）：
 *       经典脚本，执行即 `window.__ModuleLoader__.load({id, factory})`；
 *       web shell 注入的 HTML 内联脚本给出门面 `{mode:"queue", pendingQueue, load(), create()}`，
 *       `create()` 取出 id === "@deepseek-ai/dsh-client-modules" 的那条，跑它的 factory 后调用
 *       `exports.createClientModuleSystem(this, {id, exports}, options)`。
 *       工厂的 export 面：`apply` / `inject` / `ClientModuleSystem` / `createClientModuleSystem` /
 *       `parseBootManifest` / `parseDshClient` / `stripClientSuffix`。
 * [C] package.json 清单字段
 *     @deepseek-ai/dsh-package-manifest@0.2.0-rc.1 lib/types/types.d.ts：
 *       DshClientManifest { platform, inject?, immediately?, external? }，
 *         external 原文注释：「Exact module-table requests beyond the implicit client baseline,
 *         including subpaths such as `<pkg>/client`; absent means baseline externals only.」
 *       DshBundleManifest { patch: string | string[] } —— patch 可以是单个路径或有序数组。
 *       DshEnginesManifest.dsh 原文注释：「DSH compatibility is declarative until a reader
 *         enforces it.」→ 0.2.0 只声明不校验；0.2.1 起**顶层** engines.dsh 被 app-boot 的
 *         `unmetRequirements()` 强制执行（声明后 peerDependencies 被忽略）。
 *       peerDependencies 门：
 *       @deepseek-ai/dsh-app-boot@0.2.0-rc.1 lib/index.js `evaluatePluginCompatibility()` ——
 *       只挑 peerDependencies 里名字为 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的条目，
 *       用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 比对运行时版本
 *       （runtimeVersion = app-boot 自己的 package.json version = 0.2.0-rc.1）；
 *       不合就进 peers 清单被拒载（0.2.1 的返回字段为 requirements）。
 * [D] slot 契约（两个 slot 的 kind / 必填 registerOptions）
 *     @deepseek-ai/dsh-cordis-client-runner@0.2.0-rc.1 lib/client.js 内嵌 slot-contract 表：
 *       settings.section      kind=list  scope=root  registerOptions: id(required,string)、
 *                             order(optional,number)、label(optional,string|()=>string)
 *       plugins.bundle.config kind=keyed scope=root  registerOptions: key(required,string)，
 *                             key 域 = bundle 的包名（owner 按此 key 派发）
 *     校验器 @deepseek-ai/dsh-client-ui-slots@0.2.0-rc.1 lib/index.js `SlotCore.register()`：
 *       - slot 未声明 → `slot "x" is not declared (...)`
 *       - kind=list 缺 id → `list slot "x" requires options.id`
 *       - kind=keyed 缺 key → `keyed slot "x" requires options.key`
 *       - 只白名单化 key/id/order/label/priority 进 entry.options（其余字段不进条目，但不报错）
 * [E] 宿主半（真 0.2.0-rc.1 运行时实跑观测值，见 /tmp/dsh-e2e/baseline.md §E2E）
 *     在 scratch profile（bundles = dsh-base [+ dsh-web-app] + @sidleo3/dsh-wiki）里挂载后：
 *       - `ctx.tools.schemas()` 里 wiki_* 工具恰好 14 个（名字见 HOST_TOOLS）
 *       - web 部署下注册 6 条 /api/dsh-wiki/* 路由（GET/POST 在 handler 内分派）
 *       - 插件导出 name = 'wiki-registry'，inject = ['systemPrompt', 'tools']
 */

import { readFile, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test, describe, before, after } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PKG = join(ROOT, 'packages', 'dsh')
const BUNDLE = join(PKG, 'lib', 'client.js')
const HOST = join(PKG, 'wiki.mjs')

/** [A] @deepseek-ai/dsh-web-frontend@0.2.0-rc.1 dist/assets/index-Dy0OhsZ5.js `QS()` 的返回值（键序一致）。 */
const BASELINE_020 = [
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

/** [D] 两个 slot 的 0.2.0 契约：kind + 该 kind 的必填 registerOptions 字段 + key 语义。 */
const SLOT_CONTRACT_020 = {
  'settings.section': { kind: 'list', requiredOption: 'id', keySemantics: 'section key（id 唯一，驱动 only 过滤）' },
  'plugins.bundle.config': { kind: 'keyed', requiredOption: 'key', keySemantics: 'bundle 的包名' },
}

/** [C] 被验证的 DSH 运行时版本（@deepseek-ai/dsh-app-boot@0.2.0-rc.1 的 peer 门基准）。 */
const RUNTIME_020 = '0.2.0-rc.1'

/** [E] 真 0.2.0-rc.1 运行时实跑观测到的宿主半工具面。 */const HOST_TOOLS = [
  'wiki_list', 'wiki_search', 'wiki_get', 'wiki_create', 'wiki_update', 'wiki_validate', 'wiki_lint',
  'wiki_ingest', 'wiki_deprecate', 'wiki_rules', 'wiki_help', 'wiki_dirs', 'wiki_use', 'wiki_sync',
]

/** [E] 宿主半在 web 部署下注册的路由（路径 → handler 内分派的 method）。 */
const HOST_ROUTES = {
  '/api/dsh-wiki/state': ['GET'],
  '/api/dsh-wiki/bundles': ['GET', 'POST'],
  '/api/dsh-wiki/health': ['GET'],
  '/api/dsh-wiki/index': ['POST'],
  '/api/dsh-wiki/autosync': ['GET', 'POST'],
  '/api/dsh-wiki/sync': ['GET', 'POST'],
}

const built = await access(BUNDLE).then(() => true, () => false)
const depsOk = await access(join(PKG, 'node_modules', 'react', 'package.json')).then(() => true, () => false)
const skip = !built
  ? '客户端半未构建（cd packages/dsh && pnpm install && pnpm run build）'
  : !depsOk ? 'packages/dsh/node_modules 缺失（pnpm install）' : false

/** 极简宿主 mock：只提供宿主半用到的 on/tools/inject/get/effect。 */
function makeHostCtx() {
  const tools = new Map()
  const routes = new Map()
  const handlers = new Map()
  const disposers = []
  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error(`重复注册路由 ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const services = { webServer, systemPrompt: {} }
  const effect = (fn) => {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  }
  const scoped = { get: (name) => services[name], effect }
  const ctx = {
    on(evt, fn) { handlers.set(evt, fn) },
    tools: { register(t) { tools.set(t.name, t) } },
    inject(_deps, cb) { cb(scoped) },
    get: (name) => services[name],
    effect,
    logger: { warn() {}, error() {} },
  }
  return { ctx, tools, routes, handlers, services, disposers }
}

describe('DSH 0.2.0 契约（客户端半产物）', { skip }, () => {
  let source
  let pkg

  before(async () => {
    source = await readFile(BUNDLE, 'utf8')
    pkg = JSON.parse(await readFile(join(PKG, 'package.json'), 'utf8'))
  })

  test('外壳：第一行就是 window.__ModuleLoader__.load({ id, factory })（经典脚本，0.2.0 门面同样认）', () => {
    assert.match(source, /^window\.__ModuleLoader__\.load\(\{/, '第一行必须是 load 调用（前面多任何字节宿主都认不出）')
    assert.match(source, /id:\s*"@sidleo3\/dsh-wiki"/, 'bundle id 必须等于包名（loader 图行 id 逐一对应）')
    assert.match(source, /factory:\s*\(require\)\s*=>/, '0.2.0 的 CJS 工厂形参就是 require')
    assert.match(source, /return module\.exports;/, '工厂必须返回 module.exports')
  })

  test('[A] require 的模块必须都在 0.2.0 平台基线内，否则要在 package.json 声明 dsh.client.external', () => {
    const required = [...new Set([...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]))]
    assert.ok(required.length > 0, '应当 require 平台基线模块（react）')
    const external = pkg.dsh?.client?.external ?? []
    for (const spec of required) {
      const inBaseline = BASELINE_020.includes(spec)
      assert.ok(
        inBaseline || external.includes(spec),
        `require("${spec}") 不在 0.2.0 平台基线内（基线 ${BASELINE_020.length} 个，见 @deepseek-ai/dsh-web-frontend@0.2.0-rc.1 QS()）`
          + `——需要 dsh.client.external: ["${spec}"] 让宿主提供该模块表项`,
      )
    }
    // 反向：声明的 external 不该是凭空多出来的（多了意味着清单与产物漂移）
    for (const spec of external) {
      assert.ok(required.includes(spec), `dsh.client.external 声明了 "${spec}"，但产物里没有 require("${spec}")`)
    }
  })

  test('[A] 基线表本身是 0.2.0 的那 9 个（防有人把常量改窄/改宽）', () => {
    assert.equal(BASELINE_020.length, 9, '0.2.0-rc.1 的 staticModules 就是 9 个')
    assert.equal(BASELINE_020[0], 'react', 'react 排在首位（shell QS() 的键序）')
    assert.ok(BASELINE_020.includes('@deepseek-ai/dsh-client-ui-slots'), 'slots 是平台基线模块')
  })

  test('[C] package.json：0.2.0 认的 client/bundle 清单字段都在且取值对', async () => {
    assert.equal(pkg.exports['./client'], './lib/client.js', '客户端半入口')
    assert.equal(pkg.dsh.client.platform, 'web', 'DshClientManifest.platform')
    assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'), 'informational 依赖：slots 包')
    assert.ok(pkg.files.includes('lib/client.js'), '发布产物必须带上客户端半')
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml', 'DshBundleManifest.patch（0.2.0 允许 string 或 string[]）')
    assert.match(pkg.engines.dsh, />=0\.1\.7/, `顶层 engines.dsh 声明（0.2.1 起强制执行；>=0.1.7-rc.2 覆盖 0.2.x，实际 ${pkg.engines.dsh}）`)
    // 0.2.0 的 scan 会算 external 列表；我们不在基线外取任何模块
    const external = pkg.dsh.client.external
    assert.ok(external === undefined || Array.isArray(external), 'dsh.client.external 若存在必须是数组')
  })

  test('[C] peer 门：不可声明 0.2.0-rc.1 不满足的 @deepseek-ai/dsh* peerDependency', () => {
    const gated = Object.entries(pkg.peerDependencies ?? {})
      .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    assert.deepEqual(
      gated.map(([name]) => `${name}@${gated.find(([n]) => n === name)[1]}`), [],
      `@deepseek-ai/dsh-app-boot@0.2.0-rc.1 会拿 peerDependencies 里的 @deepseek-ai/dsh* 条目`
        + ` 与运行时版本 ${RUNTIME_020}（includePrerelease）比对，不满足即拒载；`
        + `当前声明了 ${JSON.stringify(Object.fromEntries(gated))}`,
    )
    assert.equal(pkg.peerDependencies?.react, '^18.2.0', 'react 是平台 peer（不受该门约束）')
  })

  test('[D] 两个 slot 名与 key 语义：settings.section 用 id、plugins.bundle.config 用「包名」作 key', async () => {
    // 用真产物跑一次注册（不需要 jsdom：只执行工厂 + apply 到桩 slots）
    const originalWindow = globalThis.window
    let registration = null
    globalThis.window = { __ModuleLoader__: { load(reg) { registration = reg } } }
    try {
      await import(pathToFileURL(BUNDLE).href + '?contract=' + Date.now())
    } finally {
      if (originalWindow === undefined) delete globalThis.window
      else globalThis.window = originalWindow
    }
    assert.ok(registration, 'bundle 必须调用 __ModuleLoader__.load')
    assert.equal(registration.id, '@sidleo3/dsh-wiki')

    const React = (await import(pathToFileURL(join(PKG, 'node_modules', 'react', 'index.js')).href)).default
    const factory = registration.factory
    const exports_ = factory((spec) => {
      assert.equal(spec, 'react', `产物只该 require("react")，实际 require("${spec}")`)
      return { __esModule: true, default: React, ...React }
    })
    assert.equal(typeof exports_.apply, 'function', '工厂要导出 apply')
    assert.deepEqual(exports_.inject, ['slots'], '工厂要导出 inject = ["slots"]')

    const regs = []
    const slots = {
      inject(name, cb) { cb(name) },
      register(opts, comp) { regs.push({ opts, comp }); return () => {} },
    }
    exports_.apply({ get: (n) => (n === 'slots' ? slots : undefined) })

    assert.deepEqual(regs.map((r) => r.opts.name), Object.keys(SLOT_CONTRACT_020), '两个 slot 都要注册')
    for (const { opts } of regs) {
      const contract = SLOT_CONTRACT_020[opts.name]
      assert.ok(contract, `注册了契约外的 slot：${opts.name}`)
      // 0.2.0 的 SlotCore.register() 按 kind 校验必填项：list 要 id、keyed 要 key
      const required = opts[contract.requiredOption]
      assert.equal(typeof required, 'string', `0.2.0 契约：${opts.name}（kind=${contract.kind}）必须带 options.${contract.requiredOption}`)
      assert.ok(required.length > 0, `options.${contract.requiredOption} 不能为空串`)
      assert.equal(typeof opts.name, 'string', 'register 选项里必须带 name（SlotCore 用它查声明）')
    }
    // key 语义：plugins.bundle.config 的 key = bundle 包名
    const bundleReg = regs.find((r) => r.opts.name === 'plugins.bundle.config')
    assert.equal(bundleReg.opts.key, pkg.name, 'keyed slot 的 key 必须是 bundle 包名（owner 按此 key 派发）')
    // settings.section 的 id 决定导航项 key；order/label 是 0.2.0 的 list 可选字段
    const sectionReg = regs.find((r) => r.opts.name === 'settings.section')
    assert.equal(sectionReg.opts.id, 'llm-wiki', '导航项 key')
    assert.equal(typeof sectionReg.opts.order, 'number', '0.2.0 list 契约的 order 是 number')
    assert.equal(typeof sectionReg.opts.label, 'string', '0.2.0 list 契约的 label 是 string | (() => string)')
    assert.ok(regs.every((r) => typeof r.comp === 'function' || (r.comp !== undefined && r.comp !== null)), '组件/渲染 thunk 必须给出')
  })
})

describe('DSH 0.2.0 契约（宿主半，mock ctx）', () => {
  let plugin
  let host

  before(async () => {
    plugin = await import(pathToFileURL(HOST).href)
    host = makeHostCtx()
    await plugin.apply(host.ctx, {})
  })

  test('[E] 导出面：name = wiki-registry，inject = ["systemPrompt", "tools"]', () => {
    assert.equal(plugin.name, 'wiki-registry')
    assert.deepEqual(plugin.inject, ['systemPrompt', 'tools'], '0.2.0 的服务名不变')
  })

  test('[E] 在 0.2.0 下仍注册 14 个 wiki_* 工具（与真运行时实跑一致）', () => {
    assert.deepEqual([...host.tools.keys()].sort(), [...HOST_TOOLS].sort(), `工具数/名不符：${[...host.tools.keys()].sort()}`)
    assert.equal(HOST_TOOLS.length, 14)
    for (const [name, def] of host.tools) {
      assert.equal(def.name, name)
      assert.equal(typeof def.description, 'string', `${name} 缺 description`)
      assert.ok(def.parameters !== undefined || def.inputSchema !== undefined, `${name} 缺参数 schema`)
    }
  })

  test('[E] 六条 /api/dsh-wiki/* 路由都在，且不再有运行参数路由', () => {
    assert.deepEqual([...host.routes.keys()].sort(), Object.keys(HOST_ROUTES).sort())
    assert.equal(host.routes.has('/api/dsh-wiki/config'), false, '运行参数接口已下线')
  })

  test('[E] 路由与定时器绑到 fiber 生命周期：dispose 后释放，重新 apply 不撞重复路由', async () => {
    const h = makeHostCtx()
    await plugin.apply(h.ctx, {})
    assert.equal(h.routes.size, 6)
    assert.ok(h.disposers.length >= 7, `应有 6 条路由 + autosync 的 disposer，实际 ${h.disposers.length}`)
    for (const dispose of h.disposers.splice(0).reverse()) dispose()
    assert.equal(h.routes.size, 0, 'dispose 后路由应全部移除')
    await plugin.apply(h.ctx, {})
    assert.equal(h.routes.size, 6, '重新 apply 不应撞 webserver duplicate route')
  })
})
