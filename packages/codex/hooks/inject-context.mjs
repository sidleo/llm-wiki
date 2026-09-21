#!/usr/bin/env node
/**
 * inject-context.mjs —— 把当前 bundle、目录清单与 APPEND_SYSTEM_PROMPT.md 规则
 * 作为 developer context 注入 Codex。
 *
 * 行为对齐 DSH 的会话层 runtime context：
 * - SessionStart：注入一次当前快照（包括 compact 后重建上下文）；
 * - UserPromptSubmit：内容未变不重复注入，规则改动后下一轮自动刷新；
 * - 状态按 session_id 存入 PLUGIN_DATA，避免每轮重复塞同一段文本；
 * - 任何错误都静默退出，工具仍可经 wiki_rules 获取规则，不阻塞用户发送。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildConfig, DEFAULTS } from '../lib/config.mjs'
import { loadCore } from '../lib/core.mjs'
import { buildContextText } from '../lib/instructions.mjs'

async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

async function main() {
  const event = await readStdin()
  const config = buildConfig({ argv: [], env: process.env })
  const core = await loadCore()
  const active = await core.resolveBundleRoot(config, {})
  const text = await buildContextText({ core, active, maxChars: DEFAULTS.maxContextChars })
  if (!text.trim()) return

  const eventName = String(event.hook_event_name || '')
  const sessionId = String(event.session_id || 'default')
  const force = eventName === 'SessionStart'
  const stateDir = join(process.env.PLUGIN_DATA || join(tmpdir(), 'codex-wiki-hook'), 'context')
  const stateFile = join(stateDir, sha256(sessionId) + '.sha256')
  const digest = sha256(text)

  if (!force) {
    try {
      if ((await readFile(stateFile, 'utf8')).trim() === digest) return
    } catch {
      // 首次提交或状态不可读：继续注入。
    }
  }

  try {
    await mkdir(stateDir, { recursive: true })
    await writeFile(stateFile, digest + '\n', 'utf8')
  } catch {
    // 状态目录不可写时仍注入；代价是可能少一次去重，而不是丢失规则。
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: eventName === 'SessionStart' ? 'SessionStart' : 'UserPromptSubmit',
      additionalContext: text,
    },
  }
  process.stdout.write(JSON.stringify(output) + '\n')
}

main().catch(() => {
  // 注入是增强能力，失败不阻塞当前 prompt。
  process.exit(0)
})
