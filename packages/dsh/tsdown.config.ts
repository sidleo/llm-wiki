import { defineConfig } from 'tsdown'

/** 包名：必须与 package.json 的 name 一致（bundle id 与 loader 图行的 id 逐一对应）。 */
const PLUGIN_ID = '@sidleo3/dsh-wiki'

/**
 * DSH shell 的平台基线模块（staticModules）：构建期外部化，
 * 运行时经 loader 的 `require` 命中同一实例（自带副本会导致 React 双实例）。
 * 其余依赖一律打进 bundle。
 */
const PLATFORM_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']

/**
 * 构建配置：只出浏览器半（宿主半 wiki.mjs 是手写 ESM，不参与构建）。
 *
 * 产物 = lib/client.js：CJS 工厂包一层 `window.__ModuleLoader__.load({ id, factory })`，
 * 导出 `inject`（cordis 服务名）+ `apply(ctx)`，由 DSH 的 client-modules 经 /plugins 提供。
 * 格式契约（DSH 0.1.5-rc.2）：
 *   - 经典脚本、无顶层 ESM 语法；
 *   - 第一行必须是 load 调用（多了 "use strict" 前缀该行会认不出来）；
 *   - factory 内 require 走模块表，返回值是 module.exports。
 */
export default defineConfig([
  {
    name: 'dsh-wiki/client',
    entry: { client: 'src/client/index.ts' },
    format: 'cjs',
    platform: 'browser',
    outDir: 'lib',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: { neverBundle: [...PLATFORM_EXTERNALS] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
