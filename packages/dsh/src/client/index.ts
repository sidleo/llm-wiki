// @ts-nocheck — DSH 客户端半是普通 JS 工厂（tsdown 打成 CJS + __ModuleLoader__ 外壳）。
/**
 * dsh-wiki 客户端半 —— 设置 → 插件 → 插件配置 里的 llm-wiki 卡片。
 *
 * 契约（DSH 0.1.5-rc.2）：
 * - bundle = 经典脚本 + CJS 工厂 `window.__ModuleLoader__.load({ id, factory })`，导出 `inject` / `apply`；
 * - 卡片注册进 keyed slot `settings.plugin.item`，`key` 必须等于宿主注册的设置命名空间（这里是 dsh-wiki）——
 *   宿主「插件配置」Tab 只渲染「已服务命名空间 ∩ 已注册卡片」；
 * - React 与平台模块经 loader 模块表 require（构建期 external），服务经 `ctx.get` 取；
 * - 宿主半可用性探测：卡片自绘（primitives 无 Switch/Select/表单渲染器，官方 Field 未导出）。
 *
 * 三个区（全部通过宿主 RPC /api/dsh-wiki/* 读写）：
 *   命名目录（写 core 注册表，与 CLI/pi 共享）/ 在线同步（core Git 远端）/ 体检与索引
 * 运行参数不在这里改：它是部署级配置，改 profile 的 cordis.patch.yml（插件不会自动改写它）。
 */

import React from 'react'

export const inject = ['slots']

const NS = 'dsh-wiki'
const API = '/api/dsh-wiki'

const e = React.createElement

/** 一次性注入样式；带 data-plugin 便于 HMR 卸载时清理。 */
const CSS = `
.dwCard { list-style:none; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-layer-3); margin:0; transition:border-color .16s,background .16s }
.dwCard:hover { border-color:var(--dsw-alias-label-dimmed) }
.dwCardOpen { background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-label-dimmed) }
.dwHeader { width:100%; appearance:none; border:0; background:none; font:inherit; color:inherit; text-align:left; cursor:pointer; display:flex; align-items:center; gap:12px; padding:14px 16px; border-radius:12px }
.dwHeader:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:-2px }
.dwHeadText { flex:1; min-width:0; display:flex; flex-direction:column; gap:4px }
.dwName { font-size:15px; font-weight:600; line-height:1.4; color:var(--dsw-alias-label-primary) }
.dwDesc { font-size:13px; line-height:1.5; color:var(--dsw-alias-label-tertiary) }
.dwChevron { flex:none; color:var(--dsw-alias-label-tertiary); display:inline-flex }
.dwBody { border-top:1px solid var(--dsw-alias-border-l2); margin:0 16px; padding:10px 0 4px }
.dwSection { margin-bottom:14px }
.dwSectionTitle { font-size:13px; font-weight:600; line-height:1.4; color:var(--dsw-alias-label-primary); margin:0 0 6px }
.dwHint { font-size:12px; line-height:1.5; color:var(--dsw-alias-label-tertiary); margin:2px 0 6px }
.dwWarn { font-size:12px; line-height:1.5; color:var(--dsw-alias-label-error); margin:4px 0 }
.dwOk { font-size:12px; line-height:1.5; color:var(--dsw-alias-label-primary); margin:4px 0 }
.dwField { display:flex; flex-direction:column; gap:3px; margin:6px 0 }
.dwLabel { font-size:12.5px; color:var(--dsw-alias-label-secondary) }
.dwInput { padding:5px 8px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px }
.dwInput:disabled { opacity:.6 }
.dwGrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:8px }
.dwRow { display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--dsw-alias-border-l2) }
.dwRowMain { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px }
.dwRowName { font-size:13px; color:var(--dsw-alias-label-primary); display:flex; align-items:center; gap:6px }
.dwRowPath { font-size:11.5px; color:var(--dsw-alias-label-tertiary); word-break:break-all }
.dwBadge { flex:none; font-size:11px; padding:1px 6px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-tertiary) }
.dwBadgeOn { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-label-dimmed) }
.dwBtn { appearance:none; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; padding:4px 10px; background:none; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12.5px; cursor:pointer }
.dwBtn:hover { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-label-dimmed) }
.dwBtn:disabled { opacity:.45; cursor:default }
.dwBtnPrimary { background:var(--dsw-alias-label-primary); color:var(--dsw-alias-bg-layer-3); border-color:transparent }
.dwPre { background:var(--dsw-alias-bg-layer-2); border-radius:8px; padding:8px; margin:6px 0; max-height:200px; overflow:auto; font-size:12px; line-height:1.5; white-space:pre-wrap; word-break:break-word; color:var(--dsw-alias-label-secondary) }
.dwCheck { display:flex; align-items:center; gap:6px; font-size:12.5px; color:var(--dsw-alias-label-secondary) }
`

function injectStyles() {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css="dsh-wiki/client"]')) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-wiki'
  tag.dataset.pluginCss = 'dsh-wiki/client'
  tag.textContent = CSS
  document.head.appendChild(tag)
}

async function api(path, init) {
  const res = await fetch(API + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok || (body && body.ok === false)) {
    throw new Error((body && body.error) || `${path} 请求失败（HTTP ${res.status}）`)
  }
  return body
}

const post = (path, payload) => api(path, { method: 'POST', body: JSON.stringify(payload || {}) })

function Field(props) {
  return e(
    'label',
    { className: 'dwField' },
    e('span', { className: 'dwLabel' }, props.label),
    e('input', {
      className: 'dwInput',
      type: props.type || 'text',
      value: props.value === undefined || props.value === null ? '' : String(props.value),
      placeholder: props.placeholder || '',
      disabled: props.disabled === true,
      onChange: (ev) => props.onChange(ev.target.value),
    }),
    props.hint ? e('span', { className: 'dwHint' }, props.hint) : null,
  )
}

function Section(props) {
  return e('div', { className: 'dwSection' }, e('div', { className: 'dwSectionTitle' }, props.title), props.hint ? e('div', { className: 'dwHint' }, props.hint) : null, props.children)
}

function Chevron({ open }) {
  return e(
    'span',
    { className: 'dwChevron', style: { transform: open ? 'rotate(180deg)' : 'none' } },
    e('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' }, e('path', { d: 'M4 6l4 4 4-4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })),
  )
}

function BundleRow(props) {
  const b = props.bundle
  const [renaming, setRenaming] = React.useState(false)
  const [newName, setNewName] = React.useState(b.name)
  const [editingCache, setEditingCache] = React.useState(false)
  const [newCache, setNewCache] = React.useState('')
  const readOnly = b.source === 'config'
  const isFeishu = b.kind === 'feishu'
  const status = !b.exists ? '目录不存在' : !b.isDir ? '不是目录' : !b.isBundle ? '不像 bundle（无 .md）' : ''
  return e(
    'li',
    { className: 'dwRow' },
    e('input', {
      type: 'radio',
      name: 'dw-active',
      checked: b.active === true,
      disabled: props.busy || readOnly,
      title: '设为默认分支',
      onChange: () => props.onActivate(b.name),
    }),
    e(
      'div',
      { className: 'dwRowMain' },
      renaming
        ? e('input', { className: 'dwInput', value: newName, disabled: props.busy, onChange: (ev) => setNewName(ev.target.value) })
        : e(
            'div',
            { className: 'dwRowName' },
            b.name,
            b.active ? e('span', { className: 'dwBadge dwBadgeOn' }, '默认') : null,
            isFeishu ? e('span', { className: 'dwBadge' }, '飞书') : null,
            readOnly ? e('span', { className: 'dwBadge' }, 'profile 配置') : null,
            status ? e('span', { className: 'dwBadge' }, status) : null,
          ),
      editingCache
        ? e(
            'div',
            null,
            e(Field, {
              label: '新的本地缓存目录（绝对路径或 ~/…；留空 = 默认 ~/.agents/wiki-cloud/<名称>）',
              value: newCache,
              placeholder: b.path,
              onChange: setNewCache,
            }),
            e('div', { className: 'dwHint' }, '换目录只改注册表：旧缓存原样留在磁盘上（不删），新目录为空时首次同步会把飞书内容拉下来；旧缓存还有待推送/冲突时会拒绝。若新目录里已有同内容的 .md（例如就是原来的本地库），首次同步会把它们当作「本地改动」重推一遍（字节相同、只是时间戳与飞书记录不同），属正常：推一次即对齐。'),
          )
        : e('div', { className: 'dwRowPath' }, b.path),
    ),
    renaming
      ? [
          e('button', { key: 'ok', className: 'dwBtn', disabled: props.busy, onClick: () => props.onRename(b.name, newName) }, '确定'),
          e('button', { key: 'cancel', className: 'dwBtn', onClick: () => { setRenaming(false); setNewName(b.name) } }, '取消'),
        ]
      : editingCache
        ? [
            e('button', { key: 'ok', className: 'dwBtn dwBtnPrimary', disabled: props.busy, onClick: () => props.onSetCache(b.name, newCache) }, '确定改缓存'),
            e('button', { key: 'cancel', className: 'dwBtn', onClick: () => { setEditingCache(false); setNewCache('') } }, '取消'),
          ]
        : [
            readOnly ? null : e('button', { key: 'rename', className: 'dwBtn', disabled: props.busy, onClick: () => setRenaming(true) }, '改名'),
            readOnly || !isFeishu ? null : e('button', { key: 'cache', className: 'dwBtn', disabled: props.busy, title: '修改这个飞书库的本地缓存目录（不动磁盘数据）', onClick: () => { setEditingCache(true); setNewCache('') } }, '缓存目录'),
            readOnly ? null : props.confirmingRemove === b.name
              ? [
                  e('button', { key: 'yes', className: 'dwBtn', disabled: props.busy, onClick: () => props.onRemove(b.name) }, '确认删除'),
                  e('button', { key: 'no', className: 'dwBtn', onClick: () => props.onCancelRemove() }, '取消'),
                ]
              : e('button', { key: 'del', className: 'dwBtn', disabled: props.busy, title: '只从注册表摘除，不删除目录数据', onClick: () => props.onAskRemove(b.name) }, '删除'),
          ],
  )
}

function Card() {
  const [open, setOpen] = React.useState(false)
  const [state, setState] = React.useState(null)
  const [err, setErr] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const syncSeq = React.useRef(0)
  const [confirmingRemove, setConfirmingRemove] = React.useState('')
  const [addName, setAddName] = React.useState('')
  const [addPath, setAddPath] = React.useState('')
  const [addKind, setAddKind] = React.useState('local') // local | feishu
  const [addFolder, setAddFolder] = React.useState('') // 飞书文件夹 URL 或 token
  const [addCache, setAddCache] = React.useState('') // 飞书库本地缓存目录（可选）
  const [newFolderName, setNewFolderName] = React.useState('')
  const [viewBundle, setViewBundle] = React.useState('')
  const [syncInfo, setSyncInfo] = React.useState(null)
  const [syncLoading, setSyncLoading] = React.useState(false)
  const [health, setHealth] = React.useState(null)
  const [remoteUrl, setRemoteUrl] = React.useState('')
  const [cloneUrl, setCloneUrl] = React.useState('')
  const [cloneDir, setCloneDir] = React.useState('')
  const [cloneName, setCloneName] = React.useState('')
  const [cloneUse, setCloneUse] = React.useState(false)
  const [showClone, setShowClone] = React.useState(false)

  const run = React.useCallback(async (fn) => {
    setBusy(true)
    setErr('')
    try {
      await fn()
    } catch (error) {
      setErr(error && error.message ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [])

  const load = React.useCallback(async () => {
    const next = await api('/state')
    setState(next)
    setViewBundle((cur) => (cur && next.entries.some((x) => x.name === cur) ? cur : next.active.name))
    return next
  }, [])

  React.useEffect(() => {
    // 折叠态也要读一次：卡片头摘要需要当前默认分支（与官方卡片一致，挂载即读）
    if (state) return
    void run(() => load())
  }, [state, run, load])

  // 在线状态是只读查询（飞书要列远端目录，秒级），不能占用 busy 把整张卡片锁死：
  // 单独 loading 标记 + 序号防乱序（切换目标目录时旧响应不许覆盖新响应）。
  const loadSync = React.useCallback(async (bundle) => {
    const seq = syncSeq.current + 1
    syncSeq.current = seq
    setSyncLoading(true)
    try {
      const r = await api(`/sync${bundle ? `?bundle=${encodeURIComponent(bundle)}` : ''}`)
      if (syncSeq.current === seq) setSyncInfo({ ...r, forBundle: bundle })
    } catch (error) {
      if (syncSeq.current === seq) setErr(error && error.message ? error.message : String(error))
    } finally {
      if (syncSeq.current === seq) setSyncLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (!open) return
    void loadSync(viewBundle)
    setHealth(null)
  }, [open, viewBundle, loadSync])

  const bundleNames = state ? state.entries.map((x) => x.name) : []
  const activeEntry = state ? state.entries.find((x) => x.name === viewBundle) : null
  const isFeishu = Boolean(activeEntry && activeEntry.kind === 'feishu')
  const sync = syncInfo && syncInfo.forBundle === viewBundle ? syncInfo : null

  const afterMutation = async (message) => {
    setNotice(message)
    await load()
    await loadSync(viewBundle)
  }

  if (!open) {
    const summary = state
      ? `默认：${state.active.name}（${state.active.path}）｜${state.entries.length} 个命名目录`
      : '展开以查看/管理知识库目录与同步'
    return e(
      'li',
      { className: 'dwCard' },
      e(
        'button',
        { type: 'button', className: 'dwHeader', 'aria-expanded': 'false', onClick: () => setOpen(true) },
        e('span', { className: 'dwHeadText' }, e('span', { className: 'dwName' }, 'llm-wiki 知识库'), e('span', { className: 'dwDesc' }, summary)),
        e(Chevron, { open: false }),
      ),
    )
  }

  return e(
    'li',
    { className: 'dwCard dwCardOpen' },
    e(
      'button',
      { type: 'button', className: 'dwHeader', 'aria-expanded': 'true', onClick: () => setOpen(false) },
      e(
        'span',
        { className: 'dwHeadText' },
        e('span', { className: 'dwName' }, 'llm-wiki 知识库'),
        e('span', { className: 'dwDesc' }, state ? `默认：${state.active.name}（${state.active.path}）` : '正在读取…'),
      ),
      e(Chevron, { open: true }),
    ),
    e(
      'div',
      { className: 'dwBody' },
      err ? e('div', { className: 'dwWarn' }, `✕ ${err}`) : null,
      notice ? e('div', { className: 'dwOk' }, `✓ ${notice}`) : null,
      busy ? e('div', { className: 'dwHint' }, '执行中…（首次同步要拉取上百个文件，约 1 分钟；请勿关闭页面，完成后自动刷新状态）') : null,

      // ── A 命名 bundle 管理 ──
      e(
        Section,
        { title: '命名目录（bundle）', hint: `写入 ${state ? state.registryPath : '~/.agents/wiki-registry.json'}，与 CLI / pi 形态共享；删除只摘除注册，不动磁盘数据。` },
        state
          ? e(
              'ul',
              { style: { listStyle: 'none', margin: 0, padding: 0 } },
              state.entries.length
                ? state.entries.map((b) => e(BundleRow, { key: b.name, bundle: b, busy, confirmingRemove, onActivate: (name) => run(async () => { await post('/bundles', { op: 'activate', name }); await afterMutation(`已把「${name}」设为默认`) }), onRename: (name, newName) => run(async () => { await post('/bundles', { op: 'rename', name, newName, path: state.entries.find((x) => x.name === name).path }); await afterMutation(`已改名为「${newName}」`) }), onRemove: (name) => run(async () => { await post('/bundles', { op: 'remove', name }); setConfirmingRemove(''); await afterMutation(`已从注册表移除「${name}」`) }), onAskRemove: (name) => setConfirmingRemove(name), onCancelRemove: () => setConfirmingRemove(''), onSetCache: (name, cacheDir) => run(async () => { const r = await post('/bundles', { op: 'cache-dir', name, cacheDir }); await afterMutation(r && r.unchanged ? `「${name}」缓存目录未变` : `已把「${name}」的本地缓存目录改为 ${r.path}（旧缓存保留在磁盘上）`) }) }))
                : e('li', { className: 'dwHint' }, '尚未注册任何命名目录。'),
            )
          : e('div', { className: 'dwHint' }, '正在读取…'),
        e(
          'div',
          { className: 'dwCheck', style: { marginBottom: 6 } },
          e('span', null, '新增类型：'),
          e('button', { className: addKind === 'local' ? 'dwBtn dwBtnPrimary' : 'dwBtn', disabled: busy, onClick: () => setAddKind('local') }, '本地目录'),
          e('button', { className: addKind === 'feishu' ? 'dwBtn dwBtnPrimary' : 'dwBtn', disabled: busy, onClick: () => setAddKind('feishu') }, '飞书云盘库'),
        ),
        e(
          'div',
          { className: 'dwGrid' },
          e(Field, { label: '名称', value: addName, placeholder: addKind === 'feishu' ? '如 飞书库' : '如 永辉', onChange: setAddName }),
          addKind === 'local'
            ? e(Field, { label: '目录（绝对路径或 ~/…）', value: addPath, placeholder: '/Users/you/Documents/llm-wiki', onChange: setAddPath })
            : e(Field, { label: '飞书文件夹 URL 或 token', value: addFolder, placeholder: 'https://feishu.cn/drive/folder/fldcnXXX', onChange: setAddFolder }),
        ),
        addKind === 'feishu'
          ? e(Field, {
              label: '本地缓存目录（可选，留空用默认）',
              value: addCache,
              placeholder: `~/.agents/wiki-cloud/${addName || '<名称>'}`,
              onChange: setAddCache,
            })
          : null,
        addKind === 'feishu'
          ? e('div', { className: 'dwHint' }, '同步在本地缓存目录里进行（与本地库同构的一组 .md）。留空 → ~/.agents/wiki-cloud/<名称>；想改已有库的缓存目录：先从注册表移除再用新目录挂载，缓存文件不会被删。')
          : null,
        addKind === 'local'
          ? e('button', { className: 'dwBtn', disabled: busy || !addName || !addPath, onClick: () => run(async () => { await post('/bundles', { op: 'add', name: addName, path: addPath }); setAddName(''); setAddPath(''); await afterMutation('已注册本地目录') }) }, '＋ 添加本地目录')
          : e('div', null,
              e('button', { className: 'dwBtn', disabled: busy || !addName || !addFolder, onClick: () => run(async () => { await post('/bundles', { op: 'add', name: addName, kind: 'feishu', folderToken: addFolder, cacheDir: addCache }); setAddName(''); setAddFolder(''); setAddCache(''); await afterMutation('已挂载飞书文件夹') }) }, '＋ 挂载已有文件夹'),
              e('div', { className: 'dwGrid', style: { marginTop: 8 } },
                e(Field, { label: '新建文件夹名称（建在「我的空间」根）', value: newFolderName, placeholder: '永辉知识库', onChange: setNewFolderName }),
              ),
              e('button', { className: 'dwBtn', disabled: busy || !addName || !newFolderName, onClick: () => run(async () => { const r = await post('/sync', { op: 'feishu-init', name: addName, newFolder: newFolderName, cacheDir: addCache }); setNotice(`已在飞书新建文件夹：${r.url || newFolderName}`); setNewFolderName(''); setAddCache(''); await afterMutation(`已注册飞书云盘库（本地缓存：${r.cacheDir || '默认'}）`) }) }, '在飞书新建文件夹并注册'),
            ),
      ),

      // ── C 在线同步（按后端渲染：git 仓库 / 飞书云盘库）──
      e(
        Section,
        {
          title: '在线同步',
          hint: isFeishu
            ? '飞书云盘库：文件级增量（只推改动文件），index.md 本地重生成、log.md 取并集；两侧都改会停下来报清单，永不删除两端文件。'
            : 'Git 远端：index.md 自动重生成、log.md 取并集 → 不阻塞；概念冲突会停止并列出文件（工作区回到同步前）。',
        },
        e(
          'div',
          { className: 'dwCheck', style: { marginBottom: 6 } },
          e('span', null, '目标目录：'),
          e(
            'select',
            { className: 'dwInput', value: viewBundle, disabled: busy || !bundleNames.length, onChange: (ev) => setViewBundle(ev.target.value) },
            bundleNames.map((n) => {
              const entry = state.entries.find((x) => x.name === n)
              return e('option', { key: n, value: n }, `${n}${entry && entry.kind === 'feishu' ? '（飞书）' : ''}`)
            }),
          ),
          e('button', { className: 'dwBtn', disabled: busy || syncLoading, onClick: () => loadSync(viewBundle) }, syncLoading ? '读取中…' : '刷新状态'),
        ),
        isFeishu
          ? e(
              'div',
              null,
              syncLoading && !sync
                ? e('div', { className: 'dwHint' }, '正在读取飞书状态…（列远端目录，通常 2–5 秒）')
                : null,
              sync && sync.feishu && sync.feishu.ok
                ? e(
                    'div',
                    null,
                    e('div', { className: 'dwHint' }, `待推送 ${sync.feishu.counts.push}｜待拉取 ${sync.feishu.counts.pull}｜冲突 ${sync.feishu.counts.conflict}｜本地 ${sync.feishu.counts.local} 个 .md，远端 ${sync.feishu.counts.remote} 个 .md`),
                    activeEntry && activeEntry.folderUrl ? e('div', { className: 'dwHint' }, `文件夹：${activeEntry.folderUrl}`) : null,
                    activeEntry && activeEntry.cacheDir ? e('div', { className: 'dwHint' }, `本地缓存：${activeEntry.cacheDir}`) : null,
                    sync.feishu.ignored && sync.feishu.ignored.length ? e('div', { className: 'dwHint' }, `已忽略的非 .md 资源：${sync.feishu.ignored.slice(0, 5).join('、')}`) : null,
                  )
                : null,
              sync && sync.feishu && sync.feishu.conflict && sync.feishu.conflict.length
                ? e('div', { className: 'dwWarn' }, `冲突（两侧都改，需人工处理）：${sync.feishu.conflict.map((x) => x.rel).join('、')}`)
                : null,
              sync && sync.feishu && sync.feishu.duplicates && sync.feishu.duplicates.length
                ? e('div', { className: 'dwWarn' }, `⚠ 远端同名重复：${sync.feishu.duplicates.map((x) => x.rel).join('、')}——飞书允许重名，工具不替你挑；请在飞书里删掉多余的那个（涉及该目录的推送会停下报错）。`)
                : null,
              sync && sync.feishu && sync.feishu.remoteDeleted && sync.feishu.remoteDeleted.length
                ? e('div', { className: 'dwHint' }, `远端已删（本地保留）：${sync.feishu.remoteDeleted.join('、')}`)
                : null,
              !syncLoading && !(sync && sync.feishu && sync.feishu.ok)
                ? e(
                    'div',
                    null,
                    e('div', { className: 'dwHint' }, (sync && sync.feishu && sync.feishu.error) || '飞书状态不可用（需要 lark-cli 已登录）'),
                    sync && sync.feishu && sync.feishu.next ? e('div', { className: 'dwHint' }, sync.feishu.next) : null,
                  )
                : null,
              e(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 } },
                e('button', { className: 'dwBtn dwBtnPrimary', disabled: busy || syncLoading || !(sync && sync.feishu && sync.feishu.ok), onClick: () => run(async () => { const r = await post('/sync', { op: 'sync', bundle: viewBundle }); setNotice(`同步完成：推送 ${(r.pushed || []).length}，拉取 ${(r.pulled || []).length}`); await loadSync(viewBundle) }) }, '一键同步'),
                e('button', { className: 'dwBtn', disabled: busy || syncLoading || !(sync && sync.feishu && sync.feishu.ok), onClick: () => run(async () => { const r = await post('/sync', { op: 'pull', bundle: viewBundle }); setNotice(`已拉取 ${(r.pulled || []).length} 个文件`); await loadSync(viewBundle) }) }, '拉取'),
                e('button', { className: 'dwBtn', disabled: busy || syncLoading || !(sync && sync.feishu && sync.feishu.ok), onClick: () => run(async () => { const r = await post('/sync', { op: 'push', bundle: viewBundle }); setNotice(`已推送 ${(r.pushed || []).length} 个文件`); await loadSync(viewBundle) }) }, '推送'),
                activeEntry && activeEntry.folderUrl ? e('a', { className: 'dwBtn', href: activeEntry.folderUrl, target: '_blank', rel: 'noreferrer' }, '在飞书中打开') : null,
              ),
            )
          : e(
              'div',
              null,
              state && state.git && state.git.ok === false ? e('div', { className: 'dwWarn' }, `✕ ${state.git.error || 'git 不可用'}`) : null,
              sync && sync.git
                ? sync.git.ok
                  ? e(
                      'div',
                      null,
                      e('div', { className: 'dwHint' }, `远端：${sync.git.remote || '（未配置）'}｜分支：${sync.git.branch || '(detached)'}${sync.git.upstream ? ` → ${sync.git.upstream}` : ''}｜领先 ${sync.git.ahead} / 落后 ${sync.git.behind}｜改动 ${sync.git.dirty.length} 个文件`),
                      sync.git.lastCommit ? e('div', { className: 'dwHint' }, `最后提交：${sync.git.lastCommit}`) : null,
                      sync.git.conflicts && sync.git.conflicts.length ? e('div', { className: 'dwWarn' }, `存在冲突：${sync.git.conflicts.join('、')}`) : null,
                    )
                  : e(
                      'div',
                      null,
                      e('div', { className: 'dwHint' }, sync.git.error || 'git 状态不可用'),
                      sync.git.next ? e('div', { className: 'dwHint' }, sync.git.next) : null,
                    )
                : e('div', { className: 'dwHint' }, syncLoading ? '正在读取 git 状态…' : '（未读取到状态，点「刷新状态」重试）'),
              e(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 } },
                e('button', { className: 'dwBtn dwBtnPrimary', disabled: busy, onClick: () => run(async () => { const r = await post('/sync', { op: 'sync', bundle: viewBundle }); setNotice(`已同步${r.merged ? '（含远端合并）' : ''}${r.pushed ? ' 并推送' : ''}`); await loadSync(viewBundle) }) }, sync && sync.git && sync.git.ok ? '立即同步' : '重试同步'),
                sync && sync.git && sync.git.ok
                  ? null
                  : e('button', { className: 'dwBtn', disabled: busy || !remoteUrl, onClick: () => run(async () => { await post('/sync', { op: 'init', bundle: viewBundle, remote: remoteUrl }); setRemoteUrl(''); await afterMutation('已初始化远端并首推') }) }, '初始化远端并首推'),
              ),
              sync && sync.git && sync.git.ok ? null : e(Field, { label: '远端 URL（init 用）', value: remoteUrl, placeholder: 'git@host:group/wiki.git', disabled: busy, onChange: setRemoteUrl }),
              e('button', { className: 'dwBtn', onClick: () => setShowClone(!showClone), disabled: busy }, showClone ? '收起「克隆远端」' : '克隆远端到本地…'),
              showClone
                ? e(
                    'div',
                    null,
                    e(Field, { label: '远端 URL', value: cloneUrl, disabled: busy, onChange: setCloneUrl }),
                    e(
                      'div',
                      { className: 'dwGrid' },
                      e(Field, { label: '本地目标目录', value: cloneDir, disabled: busy, onChange: setCloneDir }),
                      e(Field, { label: '注册名称（可选）', value: cloneName, disabled: busy, onChange: setCloneName }),
                    ),
                    e('label', { className: 'dwCheck' }, e('input', { type: 'checkbox', checked: cloneUse, disabled: busy, onChange: (ev) => setCloneUse(ev.target.checked) }), '注册后设为默认分支'),
                    e('button', { className: 'dwBtn', disabled: busy || !cloneUrl || !cloneDir, onClick: () => run(async () => { await post('/sync', { op: 'clone', url: cloneUrl, dir: cloneDir, name: cloneName || undefined, use: cloneUse }); setCloneUrl(''); setCloneDir(''); setCloneName(''); setShowClone(false); await afterMutation('已克隆并登记') }) }, '开始克隆'),
                  )
                : null,
            ),
      ),

      // ── D 体检 ──
      e(
        Section,
        { title: '体检与索引', hint: '只读校验 + 显式重建 index.md（派生文件）。' },
        e(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          e('button', { className: 'dwBtn', disabled: busy, onClick: () => run(async () => { setHealth(await api(`/health?bundle=${encodeURIComponent(viewBundle)}`)) }) }, '运行体检'),
          e('button', { className: 'dwBtn', disabled: busy, onClick: () => run(async () => { const r = await post('/index', { bundle: viewBundle }); setNotice(`已重建 index：${r.files.length} 个文件`) }) }, '重建 index'),
        ),
        health
          ? e(
              'div',
              null,
              e('div', { className: 'dwHint' }, `目录 ${health.tree.dirs} 个｜概念 ${health.tree.concepts} 个｜OKF ${health.validate.ok ? '合规 ✓' : `不合规（${health.validate.errors.length} 错 / ${health.validate.warnings.length} 警）`}｜断链 ${health.lint.summary.broken}｜过期 ${health.lint.summary.stale}｜孤儿 ${health.lint.summary.orphans}｜问题合计 ${health.lint.issues.length}`),
              health.validate.errors.length ? e('div', { className: 'dwWarn' }, health.validate.errors.slice(0, 5).join('；')) : null,
              health.lint.issues.length
                ? e('div', { className: 'dwPre' }, health.lint.issues.slice(0, 60).map((i) => `[${i.kind}] ${i.msg}`).join('\n'))
                : e('div', { className: 'dwOk' }, 'lint clean ✓'),
            )
          : null,
      ),
    ),
  )
}

export function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  injectStyles()
  slots.inject('settings.plugin.item', () =>
    slots.register(
      { name: 'settings.plugin.item', id: 'dsh-wiki', key: NS, order: 40, label: 'llm-wiki 知识库' },
      () => e(Card),
    ),
  )
}
