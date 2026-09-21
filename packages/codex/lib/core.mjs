/**
 * core.mjs —— 加载 @sidleo3/llm-wiki-core。
 *
 * 优先同包 vendor-core（本地 marketplace 安装后自包含），回退仓库 packages/core
 * （开发态直接运行）。与 DSH / Pi / MCP 的加载策略一致。
 */

import { access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
let core = null

export async function loadCore() {
  if (core) return core
  const vendor = join(here, '..', 'vendor-core', 'index.mjs')
  try {
    await access(vendor)
    core = await import(vendor + '?t=' + Date.now())
    return core
  } catch {
    // vendor 缺失 → 回退开发态
  }
  const dev = join(here, '..', '..', 'core', 'index.mjs')
  try {
    await access(dev)
    core = await import(dev + '?t=' + Date.now())
    return core
  } catch {
    throw new Error('llm-wiki-core 未找到：请运行 packages/codex/scripts/sync-upstream.mjs')
  }
}
