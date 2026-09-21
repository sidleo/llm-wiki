import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(ROOT, '..', '..')
const HOOK = join(ROOT, 'hooks', 'inject-context.mjs')
const DEMO = join(REPO, 'examples', 'demo-bundle')

describe('Codex hook 规则注入', () => {
  let tmp
  let state
  let regDir
  let env

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'codex-wiki-hook-'))
    state = await mkdtemp(join(tmpdir(), 'codex-wiki-state-'))
    regDir = await mkdtemp(join(tmpdir(), 'codex-wiki-hook-reg-'))
    await cp(DEMO, tmp, { recursive: true })
    await writeFile(join(tmp, 'tables', 'APPEND_SYSTEM_PROMPT.md'), '# 表规则\n\n正文一。\n', 'utf8')
    env = {
      ...process.env,
      WIKI_DATA_DIR: tmp,
      WIKI_REGISTRY_FILE: join(regDir, 'reg.json'),
      PLUGIN_DATA: state,
    }
  })

  after(async () => {
    await rm(tmp, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
    await rm(regDir, { recursive: true, force: true })
  })

  function runHook(event) {
    return spawnSync(process.execPath, [HOOK], {
      env,
      input: JSON.stringify(event),
      encoding: 'utf8',
    })
  }

  test('SessionStart 注入当前 bundle 与 APPEND 规则', () => {
    const r = runHook({ hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' })
    assert.equal(r.status, 0, r.stderr)
    const frame = JSON.parse(r.stdout)
    assert.equal(frame.hookSpecificOutput.hookEventName, 'SessionStart')
    assert.match(frame.hookSpecificOutput.additionalContext, new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(frame.hookSpecificOutput.additionalContext, /正文一/)
  })

  test('规则未变不重复注入，规则变化后下一轮刷新', async () => {
    const same = runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: '继续' })
    assert.equal(same.status, 0, same.stderr)
    assert.equal(same.stdout, '')

    await writeFile(join(tmp, 'tables', 'APPEND_SYSTEM_PROMPT.md'), '# 表规则\n\n正文二。\n', 'utf8')
    const changed = runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: '继续' })
    assert.equal(changed.status, 0, changed.stderr)
    const frame = JSON.parse(changed.stdout)
    assert.equal(frame.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
    assert.match(frame.hookSpecificOutput.additionalContext, /正文二/)
    assert.doesNotMatch(frame.hookSpecificOutput.additionalContext, /正文一/)
  })
})
