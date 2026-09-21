/**
 * format.mjs —— 同步结果的文本化（与 dsh 插件逐字一致，保证跨形态输出相同）。
 * 从 packages/dsh/wiki.mjs 复制；改动 dsh 侧时需同步这里（test/parity 会因工具输出对拍而报警）。
 */

/** 飞书同步结果文本化。 */
export function formatFeishuResult(action, r) {
  const lines = []
  if (action === 'status') {
    if (!r.ok) return `在线库状态：不可用\n- ${r.error}${r.next ? `\n- 下一步：${r.next}` : ''}`
    const c = r.counts || {}
    lines.push(`在线库状态：待推送 ${c.push} / 待拉取 ${c.pull} / 冲突 ${c.conflict}｜本地 ${c.local} 个 .md，远端 ${c.remote} 个 .md`)
    if (r.push.length) lines.push(`- 待推送：${r.push.map((x) => x.rel).slice(0, 8).join('、')}${r.push.length > 8 ? ' …' : ''}`)
    if (r.pull.length) lines.push(`- 待拉取：${r.pull.map((x) => x.rel).slice(0, 8).join('、')}${r.pull.length > 8 ? ' …' : ''}`)
    if (r.conflict.length) lines.push(`- 冲突（两侧都改）：${r.conflict.map((x) => x.rel).join('、')}`)
    if (r.remoteDeleted.length) lines.push(`- 远端已删（本地保留，v1 不同步删除）：${r.remoteDeleted.join('、')}`)
    if (r.duplicates && r.duplicates.length) lines.push(`- ⚠ 远端同名重复（飞书允许重名，工具不替你挑）：${r.duplicates.map((d) => d.rel).join('、')}——建议在飞书里删掉多余的那个，否则涉及该目录的推送会停下报错。`)
    if (r.ignored && r.ignored.length) lines.push(`- 已忽略的非 .md 资源：${r.ignored.slice(0, 5).join('、')}${r.ignored.length > 5 ? ' …' : ''}`)
    return lines.join('\n')
  }
  if (r.ok) {
    lines.push(`${action === 'init' ? '在线库初始化完成' : action === 'pull' ? '拉取完成' : action === 'push' ? '推送完成' : '同步完成'}${r.bundle ? `：${r.bundle.name}` : ''}`)
    if (r.createdFolder) lines.push(`- 新建飞书文件夹：${r.createdFolder.name} → ${r.url}`)
    if (r.pushed && r.pushed.length) lines.push(`- 推送 ${r.pushed.length} 个文件（新增 ${(r.created || []).length}）`)
    if (r.pulled && r.pulled.length) lines.push(`- 拉取 ${r.pulled.length} 个文件`)
    for (const w of r.warnings || []) lines.push(`- ⚠ ${w}`)
    if (r.after) lines.push(`- 现在：待推送 ${r.after.push} / 待拉取 ${r.after.pull} / 冲突 ${r.after.conflict}`)
    for (const st of r.steps || []) lines.push(`  · ${st}`)
    if (r.backups && r.backups.length) lines.push(`- 覆盖前备份：${r.backups.slice(0, 3).join('、')}${r.backups.length > 3 ? ' …' : ''}`)
    return lines.join('\n')
  }
  lines.push(`${action === 'init' ? '初始化' : action}失败（${r.step || 'unknown'}）：${r.error || '未知错误'}`)
  if (r.conflicts && r.conflicts.length) lines.push(`- 冲突文件：${r.conflicts.join('、')}`)
  if (r.failed && r.failed.length) lines.push(`- 失败文件：${r.failed.slice(0, 5).map((f) => f.rel).join('、')}`)
  if (r.next) lines.push(`- 下一步：${r.next}`)
  return lines.join('\n')
}

/** git 结果文本化（wiki_sync 工具与诊断共用）。 */
export function formatGitResult(action, r) {
  const lines = []
  if (action === 'status') {
    if (!r.ok) return `同步状态：不可用\n- ${r.error}${r.next ? `\n- 下一步：${r.next}` : ''}`
    lines.push(`同步状态：${r.remote || '(未配置远端)'}`)
    lines.push(`- 分支：${r.branch || '(detached)'}${r.upstream ? ` → ${r.upstream}` : '（未设 upstream）'}`)
    lines.push(`- 领先 ${r.ahead} / 落后 ${r.behind}`)
    lines.push(`- 工作区改动：${r.dirty.length} 个文件`)
    if (r.conflicts.length) lines.push(`- 冲突：${r.conflicts.join('、')}`)
    lines.push(`- 最后提交：${r.lastCommit || '(无)'}`)
    return lines.join('\n')
  }
  if (r.ok) {
    if (action === 'clone') return `已克隆：${r.dir}${r.registered ? `（注册为「${r.registered}」）` : ''}\n${(r.steps || []).join('\n')}`
    lines.push(`${action === 'init' ? '初始化完成' : '同步完成'}${r.bundle ? `：${r.bundle.name} → ${r.bundle.path}` : ''}`)
    if (r.committed) lines.push(`- 本地提交：${r.committed} 个文件`)
    if (r.merged) lines.push('- 已合并远端变更')
    if (r.pushed) lines.push('- 已推送')
    if (r.status) lines.push(`- 现在：领先 ${r.status.ahead} / 落后 ${r.status.behind}`)
    if (r.files) lines.push(`- 重建 index：${r.files.length} 个文件`)
    if (r.steps && r.steps.length) lines.push(...r.steps.map((s) => `  · ${s}`))
    return lines.join('\n')
  }
  lines.push(`${action === 'init' ? '初始化' : '同步'}失败（${r.step || 'unknown'}）：${r.error || '未知错误'}`)
  if (r.conflicts && r.conflicts.length) lines.push(`- 冲突文件：${r.conflicts.join('、')}`)
  if (r.next) lines.push(`- 下一步：${r.next}`)
  return lines.join('\n')
}
