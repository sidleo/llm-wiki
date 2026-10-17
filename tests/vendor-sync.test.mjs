/**
 * tests/vendor-sync.test.mjs —— vendor-core 快照一致性闸门。
 *
 * 【为什么需要这条】dsh / mcp / pi / codex 四形态的 `loadCore()` 都**优先加载同包
 * vendor-core**，只在 vendor 缺失时才回退 `packages/core`（开发态）。vendor 是**独立副本**，
 * 不是软链——所以「改了 core 但忘了同步 vendor」不会报错，而是让四形态**静默跑旧逻辑**。
 *
 * 这个假绿模式在本次开发中真实发生过两次：
 *   - `ref.mjs`（概念引用绝对路径）：tester 只改 core，dsh 集成路径照样绿；
 *   - `overview.mjs`（目录概览 / 按行截断）：Lead 实测把 core 的截断提示改成空串后，
 *     走真实 dsh 集成路径仍返回带提示的结果（被 vendor 副本遮蔽）。
 * 危险点在于：**单测跑 packages/core 会红，而集成路径不红**——最该报警的那个人看不见。
 *
 * 本测试把「五份必须逐字节一致」变成一条断言，任何漏同步都会在 CI 里立刻红，
 * 不再依赖人记得跑 sync-vendor。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CORE = join(ROOT, 'packages', 'core')

/** 含 vendor-core 的四形态；skill 形态用 `bin/wiki-core`（自包含产物，见 build-standalone）。 */
const VENDOR_FORMS = ['dsh', 'mcp', 'pi', 'codex']

const vendorDir = (form) => join(ROOT, 'packages', form, 'vendor-core')

/** core 的 index.mjs + lib/*.mjs 是 vendor 的全部内容。 */
async function coreFiles() {
  const libs = (await readdir(join(CORE, 'lib'))).filter((f) => f.endsWith('.mjs')).sort()
  return ['index.mjs', ...libs.map((f) => join('lib', f))]
}

describe('vendor-core 快照一致性（防「改 core 忘同步 vendor」的假绿）', () => {
  test('四形态 vendor-core 都带齐 core 的全部文件', async () => {
    const files = await coreFiles()
    for (const form of VENDOR_FORMS) {
      for (const rel of files) {
        const p = join(vendorDir(form), rel)
        await assert.doesNotReject(
          () => readFile(p),
          `${form}/vendor-core/${rel} 缺失——vendor 落后于 core，该形态会在运行时静默跑旧逻辑。修复：node packages/${form}/scripts/sync-vendor.mjs`,
        )
      }
    }
  })

  test('四形态 vendor-core 与 packages/core 逐字节一致', async () => {
    const files = await coreFiles()
    const drifted = []
    for (const form of VENDOR_FORMS) {
      for (const rel of files) {
        const coreBuf = await readFile(join(CORE, rel))
        let vendorBuf
        try {
          vendorBuf = await readFile(join(vendorDir(form), rel))
        } catch {
          drifted.push(`${form}/${rel}: 缺失`)
          continue
        }
        if (!coreBuf.equals(vendorBuf)) drifted.push(`${form}/${rel}: 内容不一致`)
      }
    }
    assert.deepStrictEqual(
      drifted,
      [],
      `vendor-core 与 core 已漂移（这会让集成路径静默跑旧逻辑，而单测可能仍绿）：\n  ${drifted.join('\n  ')}\n` +
        `修复：逐个跑 node packages/{dsh,mcp,pi}/scripts/sync-vendor.mjs 与 node packages/codex/scripts/sync-upstream.mjs`,
    )
  })

  test('codex 的工具层与 mcp 逐字节一致', async () => {
    // codex 的 lib/ 是 sync-upstream.mjs 从 mcp/lib 拷的（config/core 是它自己的薄封装，不拷）。
    const shared = ['tools.mjs', 'format.mjs', 'instructions.mjs']
    const drifted = []
    for (const f of shared) {
      const a = await readFile(join(ROOT, 'packages', 'mcp', 'lib', f))
      let b
      try {
        b = await readFile(join(ROOT, 'packages', 'codex', 'lib', f))
      } catch {
        drifted.push(`${f}: 缺失`)
        continue
      }
      if (!a.equals(b)) drifted.push(`${f}: 内容不一致`)
    }
    assert.deepStrictEqual(
      drifted,
      [],
      `codex/lib 落后于 mcp/lib：\n  ${drifted.join('\n  ')}\n修复：node packages/codex/scripts/sync-upstream.mjs`,
    )
  })

  test('契约模块确实进了各 vendor（防漏拷新文件）', async () => {
    // 这两份是本轮新增的契约模块；单独点名，避免「文件清单改了但断言没跟上」。
    for (const form of VENDOR_FORMS) {
      for (const rel of ['lib/ref.mjs', 'lib/overview.mjs']) {
        const src = await readFile(join(CORE, rel))
        const dst = await readFile(join(vendorDir(form), rel))
        assert.ok(src.equals(dst), `${form}/vendor-core/${rel} 与 core 不一致`)
      }
    }
  })
})
