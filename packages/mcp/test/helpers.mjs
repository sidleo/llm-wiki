/**
 * helpers.mjs —— 测试共用：路径常量、dsh 插件 mock 宿主、schema 归一化。
 * （文件名不含 .test.，不会被 node --test 当用例执行。）
 */

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const ROOT = join(here, '..') // packages/mcp
export const REPO = join(ROOT, '..', '..')
export const BIN = join(ROOT, 'bin', 'wiki-mcp.mjs')
export const DEMO = join(REPO, 'examples', 'demo-bundle')
export const CLI = join(REPO, 'packages', 'skill', 'bin', 'wiki.mjs')

export const TOOL_NAMES = [
  'wiki_list', 'wiki_search', 'wiki_get', 'wiki_create', 'wiki_update',
  'wiki_validate', 'wiki_lint', 'wiki_ingest', 'wiki_deprecate', 'wiki_rules',
  'wiki_dirs', 'wiki_use', 'wiki_help', 'wiki_sync',
]

/** 允许与 DSH 措辞分歧的工具（改写的都是形态相关内容，结构必须一致）。 */
export const DIVERGENT = new Set(['wiki_dirs', 'wiki_use', 'wiki_rules', 'wiki_sync'])

/** 前置了「何时用」触发段的读类工具（MCP 无保证注入通道，靠工具描述兜）。 */
export const WHEN_PREFIXED = new Set(['wiki_list', 'wiki_search', 'wiki_get', 'wiki_rules'])

/**
 * 用 mock ctx 加载 dsh 插件的工具表（与 tests/dsh-mock-test.mjs 同一套 mock 形态，
 * 不依赖真实 dsh 运行时）。
 * @returns {Promise<Map<string,{name:string,description:string,parameters:object,execute:Function}>>}
 */
export async function loadDshTools(config) {
  const plugin = await import(join(REPO, 'packages', 'dsh', 'wiki.mjs'))
  const tools = new Map()
  const ctx = {
    on() {},
    tools: { register(t) { tools.set(t.name, t) } },
    systemPrompt: {},
    inject(_deps, cb) { return cb({ get() { return undefined } }) },
  }
  plugin.apply(ctx, config)
  return tools
}

/** 递归剥掉 description：只比结构（属性名/类型/enum/required），不比措辞。 */
export function stripDescriptions(v) {
  if (Array.isArray(v)) return v.map(stripDescriptions)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      if (k === 'description') continue
      out[k] = stripDescriptions(val)
    }
    return out
  }
  return v
}

/** 轮询等待条件成立（默认 10s）。 */
export async function waitFor(fn, { timeoutMs = 10000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, stepMs))
  }
}
