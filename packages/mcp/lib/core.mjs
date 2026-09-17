/**
 * core.mjs —— 加载 @sidleo3/llm-wiki-core（唯一事实实现）。
 *
 * 优先同包 vendor-core（npm 单包自包含安装），回退本仓库 packages/core（开发态）。
 * 与 dsh/pi 两个适配层同一套加载策略。
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
    throw new Error('llm-wiki-core 未找到：请运行 packages/mcp/scripts/sync-vendor.mjs 同步 vendor-core')
  }
}
