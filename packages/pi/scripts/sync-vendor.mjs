/**
 * sync-vendor.mjs —— 把 packages/core 同步进 packages/pi/vendor-core/。
 *
 * pi 扩展以包分发（`pi install` 复制源码到 ~/.pi/...），不解析 npm 依赖；
 * core 作为 vendor 打进包，extensions/index.ts 的 loadCore 优先同包 vendor-core。
 *
 * 用法：node packages/pi/scripts/sync-vendor.mjs
 */

import { readdir, copyFile, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const piRoot = join(here, '..')
const coreRoot = join(piRoot, '..', 'core')
const vendor = join(piRoot, 'vendor-core')

await mkdir(join(vendor, 'lib'), { recursive: true })
await copyFile(join(coreRoot, 'index.mjs'), join(vendor, 'index.mjs'))
const libFiles = (await readdir(join(coreRoot, 'lib'))).filter((f) => f.endsWith('.mjs'))
for (const f of libFiles) {
  await copyFile(join(coreRoot, 'lib', f), join(vendor, 'lib', f))
}
const corePkg = JSON.parse(await readFile(join(coreRoot, 'package.json'), 'utf8'))
await writeFile(
  join(vendor, 'package.json'),
  JSON.stringify(
    {
      name: 'llm-wiki-core-vendor',
      version: corePkg.version,
      description: 'llm-wiki-core vendored into @sidleo3/pi-wiki (auto-generated; do not edit)',
      type: 'module',
      main: 'index.mjs',
    },
    null,
    2,
  ) + '\n',
)
console.log(`pi vendor-core 已同步（${libFiles.length} lib 文件 + index.mjs）`)
