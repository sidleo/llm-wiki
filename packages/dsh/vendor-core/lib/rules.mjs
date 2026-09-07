/**
 * AGENTS.md 目录规则解析（向上遍历取最近 + 逐级叠加、子覆盖父）。
 *
 * 保留文件语义（本项目扩展，见 SPEC-EXTENSIONS.md）：
 * AGENTS.md 无 frontmatter、不作 concept；对任意目录 D，生效规则 =
 * 从 D 向上遍历到 bundle 根遇到的最近 AGENTS.md；若存在多条，返回
 * 根→叶有序列表（最近者最后、优先级最高，消费方叠加时后者覆盖前者）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 返回目录 dir（bundle 相对，如 'tables' 或 '' 表示根）到 bundle 根路径上
 * 存在的全部 AGENTS.md 相对路径，按「根→近」排序（最近的排最后）。
 * @param {string} root bundle 根
 * @param {string} dir bundle 相对目录；'' 表示根目录
 * @returns {Promise<string[]>} AGENTS.md 相对路径列表
 */
export async function findRules(root, dir) {
  const parts = dir ? dir.split('/') : []
  const found = []
  // 从根往下到 dir：根→近
  for (let depth = 0; depth <= parts.length; depth++) {
    const d = parts.slice(0, depth).join('/')
    const p = join(root, d, 'AGENTS.md')
    try {
      await readFile(p, 'utf8')
      found.push(d ? `${d}/AGENTS.md` : 'AGENTS.md')
    } catch {
      // 不存在，跳过
    }
  }
  return found // 根在前，最近的（叶子目录的）在后
}

/**
 * 读取解析后的规则内容列表（顺序同 findRules：根→近，后者优先）。
 * @returns {Promise<{path:string, content:string}[]>}
 */
export async function readRules(root, dir) {
  const paths = await findRules(root, dir)
  const out = []
  for (const p of paths) {
    try {
      out.push({ path: p, content: await readFile(join(root, p), 'utf8') })
    } catch {
      // 忽略竞态
    }
  }
  return out
}

/**
 * 便捷：解析出某目录生效的规则文本（根→近拼接；实际叠加语义由调用方按需
 * 处理——规则正文是 agent 指令，通常只需把全部规则文本交给 agent，靠
 * 「后者覆盖前者」的自然阅读顺序即可）。
 */
export async function resolveRules(root, dir) {
  const rules = await readRules(root, dir)
  return rules.map((r) => ({ path: r.path, content: r.content }))
}
