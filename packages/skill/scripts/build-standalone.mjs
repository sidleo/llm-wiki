/**
 * build-standalone.mjs —— 把 skill 版打包成自包含目录（可复制到任意宿主 skills 目录）。
 *
 * 产物：
 *   <target>/
 *   ├── SKILL.md               # 说明（可选覆写）
 *   ├── scripts/
 *   │   ├── wiki.mjs           # CLI（loadCore 优先同目录 wiki-core）
 *   │   ├── install.sh         # 软链 wiki 到 /usr/local/bin
 *   │   └── wiki-core/         # core 全量（index.mjs + lib/），零外部依赖
 *
 * 用法：node packages/skill/scripts/build-standalone.mjs --target /tmp/wiki-skill
 */

import { readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const skillRoot = join(here, '..') // packages/skill
const repoRoot = join(skillRoot, '..', '..')
const coreRoot = join(repoRoot, 'packages', 'core')

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

const target = arg('--target')
if (!target) {
  console.error('用法: node packages/skill/scripts/build-standalone.mjs --target <dir>')
  process.exit(1)
}

await mkdir(join(target, 'scripts', 'wiki-core', 'lib'), { recursive: true })

// 1. SKILL.md（默认用仓库版）
const skillDoc = arg('--skill') || join(skillRoot, 'SKILL.md')
await cp(skillDoc, join(target, 'SKILL.md'))

// 2. CLI（源文件 loadCore 已支持三级回退：wiki-core → 仓库 core → npm；直接复制即可）
await cp(join(skillRoot, 'bin', 'wiki.mjs'), join(target, 'scripts', 'wiki.mjs'))

// 3. install.sh
await cp(join(skillRoot, 'scripts-install.sh'), join(target, 'scripts', 'install.sh')).catch(async () => {
  // 仓库无该文件则内联生成
  await writeFile(
    join(target, 'scripts', 'install.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
chmod +x "$DIR/wiki.mjs"
ln -sf "$DIR/wiki.mjs" /usr/local/bin/wiki
echo "wiki CLI 已安装: $(which wiki)"
`,
  )
})

// 4. core 全量
await cp(join(coreRoot, 'index.mjs'), join(target, 'scripts', 'wiki-core', 'index.mjs'))
for (const f of await import('node:fs/promises').then((fs) => fs.readdir(join(coreRoot, 'lib')))) {
  if (f.endsWith('.mjs')) await cp(join(coreRoot, 'lib', f), join(target, 'scripts', 'wiki-core', 'lib', f))
}

console.log(`自包含 skill 已生成 → ${target}`)
console.log('安装：bash scripts/install.sh（软链 wiki 到 /usr/local/bin），然后把整个目录放进宿主的 skills 目录')
