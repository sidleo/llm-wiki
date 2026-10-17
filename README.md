# llm-wiki — Agent Knowledge Base in Pure OKF v0.2 Markdown

[English](README.md) · [简体中文](README.zh-CN.md)

An open-source, generic, agent-first knowledge base: **the format layer strictly follows the [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)**, and the operations layer follows Karpathy's [llm-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (ingest / query / lint + index / log). It ships in four consumption forms that share one core library and one data bundle.

## Design Principles

1. **Strictly OKF v0.2** — the official spec is the single source of truth for the format; no custom frontmatter fields, no magic features at the consumption layer.
2. **Generic and vendor-neutral** — not tied to any business or domain; the same bundle is readable and writable by any agent.

## Features

- **Progressive disclosure** — every session carries injected tool guidance plus the active bundle/category list; `wiki_list` shows the whole tree first, then you search and drill in.
- **Real cross-links + automatic backlinks** — concepts reference each other with Markdown links; reading a concept automatically surfaces the pitfalls and rules that cite it.
- **Directory-level rules (`AGENTS.md`)** — per-directory write gates (which concept types need human confirmation) and behavioral conventions, resolved bottom-up with child directories overriding parents.
- **Per-directory prompt injection (`APPEND_SYSTEM_PROMPT.md`)** — each category defines its own behavior rules; identical content across all five forms and effective immediately after an edit. DSH rides a constant section plus a runtime-context snapshot; the pi extension hooks `before_agent_start` to re-read them **every turn** and append them to that turn's system prompt; the Codex plugin injects them through `SessionStart` / `UserPromptSubmit` hooks (no duplicate injection when unchanged, refresh next turn, rebuild after compaction); the MCP server sends the same text through the `initialize` `instructions` field (the protocol only delivers it once per connection — reconnect or call `wiki rules` after an edit); the skill/CLI form has no injection hook, so it uses `wiki rules` (no args = load every rule verbatim) plus rules automatically appended to `wiki get/create/update` responses — the rules travel with the data, so nothing depends on the agent remembering to load them. See [SPEC-EXTENSIONS.md](SPEC-EXTENSIONS.md).
- **Lifecycle** — `stale_after` expiry, `status: deprecated` (concept-level) and directory-level deprecation, auto-maintained `index.md` / `log.md`.
- **Validation & health** — `wiki_validate` (OKF compliance) and `wiki_lint` (broken links, orphans, stale entries, missing index).
- **Multiple bundles** — register several wiki directories as named bundles and switch between them (session-level or persisted globally).
- **Online knowledge base (two backends)** — one `wiki_sync` / `wiki sync` entry point, dispatched by the bundle's backend:
  - **Local directory + Git remote**: commit → fetch/merge → push for multi-machine collaboration; force-push is never used.
  - **Feishu cloud drive**: the bundle lives in a Feishu Drive folder as a tree of **native `.md` files** (zero OKF format loss), read and written file-by-file through `lark-cli`; humans browse/download in Feishu, agents do the reading and writing.
  Both backends share one conflict policy: `index.md` is regenerated locally, `log.md` is merged as a union (never blocks), and a concept / `AGENTS.md` changed on both sides **stops the sync with a conflict list** — nothing is auto-overwritten. The Feishu backend **never deletes files on either side** (deletions are only reported).
- **Graphical configuration (DSH Web GUI, DSH 0.1.7-rc.2+; re-verified against 0.2.1-rc.2)** — one page registered into two slots: **Settings → llm-wiki** and the **sidebar Plugins → `@sidleo3/dsh-wiki`** page. Named directories (add/rename/remove/set default), online-sync status with one-click sync/init/clone, scheduled auto-sync, and a health panel (validate/lint counts + rebuild index). Runtime parameters are deployment-level (the profile's `cordis.patch.yml`) and are deliberately not editable from the page.

## The Wiki Bundle (Directory Structure)

A knowledge base is an OKF v0.2 bundle: any directory tree of Markdown concept files.

```
my-wiki/
├── index.md                  # reserved: directory index (progressive-disclosure entry; root may carry okf_version)
├── log.md                    # reserved: timestamped change history
├── AGENTS.md                 # reserved: write gates («## 门控» section) and per-directory conventions
├── APPEND_SYSTEM_PROMPT.md   # reserved (optional): behavior rules injected into the agent's prompt
├── tables/
│   ├── orders.md             # concept: YAML frontmatter (type: Table) + Markdown body
│   └── customers.md
└── pitfalls/
    └── join-inflation.md     # type: Pitfall, cross-links back to tables/orders.md
```

- **Concept** — one `.md` file with `type`-required OKF frontmatter plus a Markdown body. The concept id is its path relative to the bundle root (e.g. `tables/orders`).
- **Cross-links** — reference other concepts with `[label](/path.md)` or `[[wiki-link]]`; reading a concept automatically surfaces backlinks (the concepts/pitfalls that cite it).
- **Reserved files** — at any depth, only `index.md` / `log.md` / `AGENTS.md` / `APPEND_SYSTEM_PROMPT.md` are special; every other `.md` is a concept.
- **Progressive disclosure** — start from the injected bundle/category list → `wiki_list` → `wiki_search` → `wiki_get`.

## Repository Layout

```
llm-wiki/
├── schema.md               # Format spec, the single source of truth (OKF v0.2 aligned)
├── SPEC-EXTENSIONS.md      # Declared extensions to OKF (AGENTS.md / APPEND_SYSTEM_PROMPT.md reserved files)
├── packages/
│   ├── core/               # Shared core: parse / link graph / search / validate / lint / index-log / rules
│   ├── dsh/                # DSH plugin → npm @sidleo3/dsh-wiki
│   ├── pi/                 # pi extension → npm @sidleo3/pi-wiki
│   ├── mcp/                # MCP server (stdio) → npm @sidleo3/mcp-wiki
│   ├── codex/              # Codex plugin (skill + bundled MCP + hooks) → npm @sidleo3/codex-wiki
│   └── skill/              # skill form → SKILL.md + `wiki` CLI
├── examples/demo-bundle/   # Synthetic demo bundle (openable in Obsidian)
├── scripts/                # Dev helper scripts
├── tests/fixtures/         # Synthetic test data
└── obsidian/               # Obsidian templates / Dataview examples
```

## Five Consumption Forms

| Form | Install | Capability |
|------|---------|-----------|
| DSH plugin | `dsh plugin --profile web add @sidleo3/dsh-wiki` | Layered injection (constant section + runtime-context snapshot) + `wiki_*` tools |
| pi extension | `pi install npm:@sidleo3/pi-wiki` | `wiki_*` tools + prompt guidance + per-turn category rules via `before_agent_start` |
| MCP server | see `packages/mcp/README.md` (absolute node path in the host's MCP config) | the same 14 `wiki_*` tools; rules delivered via `instructions` + response appendices; works in any MCP-capable host |
| Codex plugin | `codex plugin add codex@personal` (see `packages/codex/README.md`) | bundled skill + the same 14 `wiki_*` MCP tools + `SessionStart`/`UserPromptSubmit` rule injection |
| skill + CLI | `~/.agents/skills/wiki/` (see `packages/skill/INSTALL.md`) | SKILL.md guidance + `wiki` CLI (any agent harness); rules via `wiki rules` and get/create/update responses |

All five forms read and write **the same bundle** with identical behavior — they reuse `packages/core`, no duplicated implementation.

## Tools (14)

`wiki_list` · `wiki_search` · `wiki_get` (with backlinks) · `wiki_create` · `wiki_update` · `wiki_validate` · `wiki_lint` · `wiki_ingest` · `wiki_deprecate` · `wiki_rules` · `wiki_help` · `wiki_dirs` · `wiki_use` · `wiki_sync`

### Online knowledge base (Git remote sync)

```bash
# Existing local bundle: attach a remote and push (--name also registers a named bundle)
wiki sync init --remote git@host:group/wiki.git --name team --use

# A new machine: clone and register
wiki sync clone git@host:group/wiki.git ~/Documents/llm-wiki --name team --use

# Daily: check status, then sync (commit local changes → fetch/merge → push)
wiki sync status
wiki sync --message "add pricing notes"
```

Conflict policy: `index.md` is derived and regenerated from the merged tree; `log.md` is append-only and merged as a union per date block; concepts / `AGENTS.md` / `APPEND_SYSTEM_PROMPT.md` are authored content — on conflict the sync stops, reports the paths and restores the pre-sync working tree (local commits kept), so a human can merge and re-run. Credentials stay with git (SSH agent / credential helper): no tokens are stored and force-push is never used. See `wiki help sync`.

### Feishu online knowledge base (Drive folder + native .md)

```bash
# Replicate an existing local bundle into a Feishu online library (dry-run by default; --apply to execute; copy, never move)
node scripts/migrate-to-feishu.mjs --from ~/Documents/llm-wiki --name feishu-kb --new-folder "team wiki" --apply

# Or create a folder in "My Space" and register it
wiki sync init --new-folder "team wiki" --name feishu-kb --use
# Attach an existing folder / another machine
wiki sync init --folder-token https://feishu.cn/drive/folder/fldcnXXXX --name feishu-kb

# Daily
wiki sync status          # to-push / to-pull / changed-on-both / deleted-remotely
wiki sync                 # push local changes + pull remote changes (only changed files)

# Scheduled auto-sync (interval/identity per machine; timer runs inside the DSH plugin)
wiki sync autosync status|on|off [--interval 5] [--identity auto|user|bot]

# Real deletion (Feishu backend): v1 does not sync deletions, so deleting one side is
# undone by the next sync. This deletes both sides + prunes the ledger. Dry-run by default.
wiki sync delete <path...>          # preview only
wiki sync delete <path...> --apply  # execute
```

Three-way state lives in the cache's `.wiki-cloud.json` (fileToken, remote `modified_time`, local mtime/size): one-sided changes transfer, two-sided changes stop the sync with a conflict list. A pull that overwrites a local file backs it up under `.backup/<timestamp>/` first. Requires `lark-cli` (`lark-cli auth login`, or a bot identity with scopes + folder access); see `wiki help feishu`.

**Identity is auto-selected.** Every action reads the identity state from `lark-cli auth status` once (never a probe read/write against the remote) and picks: `auto` (default — user if ready, else bot), or a pinned `user`/`bot` that errors instead of falling back. Note that a bot's permissions come from the app: private "My Space" folders are usually unreachable for it, so `auto` normally resolves to `user`.

**Deletion (Feishu backend)**: v1 never syncs deletions — the three-way diff treats "present on one side only" as *new*, so a one-sided delete is resurrected by the next sync (local delete → pulled back; Feishu delete → pushed back). `wiki sync delete` (or `wiki_sync` with `action: delete`) removes both sides and prunes the ledger entry. Two non-negotiable guards: it only deletes **explicitly named paths** (never infers deletions from a diff), and it **refuses when the other side has unsynced changes** (reports the list instead of overwriting). Dry-run is the default. For content that is merely superseded, prefer `status: deprecated`. Note that scheduled auto-sync widens the window in which a stray delete gets resurrected.

**Scheduled auto-sync** (off by default) stores its switch/interval/identity per machine in `~/.agents/wiki-autosync.json` — default interval **5 minutes** (min 1, max 1440). The timer lives in the DSH plugin's host process (so it stops when DSH stops; use a system scheduler to run `wiki sync` otherwise) and only ever drives **Feishu** bundles, since Git remote sync involves merges that should stay manual. One bundle never runs concurrently, a failure is recorded rather than fatal, and conflicts still stop and report without overwriting either side.

### Graphical configuration (DSH Web GUI)

Settings → **llm-wiki** (or the sidebar **Plugins** → `@sidleo3/dsh-wiki` page — the same page registers into both slots since DSH 0.1.7, and the slot contract was re-verified on DSH 0.2.1-rc.2):

| Section | What it edits | Where it lands |
|---------|---------------|----------------|
| Named directories | add / rename / remove / set default | `~/.agents/wiki-registry.json` (shared with CLI/pi; removal only unregisters, never deletes) |
| Online sync | backend-aware: Git (remote/branch/ahead-behind) or Feishu (to-push/to-pull/conflicts/folder link) + sync / pull / push / init / clone | core `git.mjs` / `feishu.mjs`, the same implementation as `wiki_sync` |
| Named directories | add as **local path** or **Feishu cloud drive** (one click to create the folder in Feishu and register it) | `~/.agents/wiki-registry.json` (Feishu entries are objects: kind/folderToken/cacheDir) |
| Scheduled auto-sync | on/off, interval (default 5 min), identity, plus "sync now" and last-run status | `~/.agents/wiki-autosync.json` (per machine), driven by the plugin's in-host timer |
| Health & index | validate/lint counts and details, rebuild index | core `validateBundle` / `lintBundle` / `refreshIndex` |

(Runtime parameters are not in the page: data dir, injection section name/order, limits and cache TTL are deployment-level and live in the profile's `cordis.patch.yml`.)

## Multiple Bundles (Named Directories)

The default data directory is `~/.agents/wiki`. To manage several wiki directories, register them as named bundles:

- **Registry file** (shared across all five forms; default `~/.agents/wiki-registry.json`, overridable via env `WIKI_REGISTRY_FILE`):

  ```json
  { "bundles": { "work": "/abs/path/a", "personal": "~/notes/wiki" }, "active": "work" }
  ```

- **DSH plugin** can also declare them in its config (merged with the registry; config wins on name conflicts):

  ```yaml
  - id: wiki-registry
    config:
      dataDirs:
        work: /abs/path/a
        personal: ~/notes/wiki
  ```

- **Switching** — `wiki_use <name> [global: true]`: session-level by default in the DSH host (isolated per conversation); `global: true` persists it as the global default (writes the registry `active`, affecting new sessions and the CLI/pi/codex forms). `wiki_dirs` lists the branches. The CLI uses `wiki dirs` / `wiki use NAME [--global]`, and any command accepts `--wiki NAME`.
- Resolution order (no explicit name): registry `active` (if a known name) → `default` (`dataDir` fallback). See `wiki help bundle`.

## Quick Start

```bash
# 1. Explore the demo bundle
node packages/skill/bin/wiki.mjs list --dataDir examples/demo-bundle

# 2. Validate OKF compliance
node packages/skill/bin/wiki.mjs validate --dataDir examples/demo-bundle

# 3. Search + read details (backlinks show the concepts/pitfalls that cite it)
node packages/skill/bin/wiki.mjs search revenue --dataDir examples/demo-bundle
node packages/skill/bin/wiki.mjs get tables/orders --dataDir examples/demo-bundle

# 4. Open examples/demo-bundle in Obsidian to see graph view and Dataview (see obsidian/)
```

## Testing

```bash
node --test                               # whole suite, 214 checks — do not use a `tests/*.test.mjs` glob: it silently skips the `*-test.mjs` DSH files
node scripts/smoke-test.mjs              # 36 checks: core tool chain + registry + ingest/lint end-to-end
node tests/dsh-mock-test.mjs             # 35 checks: DSH plugin (mock host) tools + injection layers + gates + multi-bundle + sync
node --test tests/dsh-config-test.mjs    # 14 checks: configuration page host half (/api/dsh-wiki/* routes, incl. handler execution)
node --test tests/git-sync.test.mjs      # 8 checks: Git remote sync (sequential writes / concurrent log / index / concept conflicts)
node --test tests/feishu-backend.test.mjs # 25 checks: Feishu cloud-drive backend (3-way diff, changed-files-only, conflict stop, log union, argv safety, user/bot identity selection)
node --test tests/autosync.test.mjs      # 17 checks: scheduled auto-sync (config persistence, interval/identity clamping, run recording, scheduler + conflict safety)
node --test tests/feishu-delete.test.mjs # 11 checks: real deletion (explicit-paths-only, refuses unsynced-side deletes, dry-run default, no resurrection, stop-on-first-failure, CLI end-to-end)
node --test tests/dsh-client-bundle-test.mjs   # 8 checks: config page bundle contract (both slots) + jsdom render smoke
node --test tests/dsh-020-contract-test.mjs    # 9 checks: DSH 0.2.0 contract pinned offline (baseline modules / peer gate / both slots / host tools + routes)
(cd packages/pi && npm install --legacy-peer-deps && npm test)   # 16 checks: pi extension (mock pi)
(cd packages/mcp && npm install && npm test)   # 17 checks: MCP form (SDK stdio client end-to-end + tool/output parity with the DSH plugin + stdout purity)
(cd packages/codex && npm test)               # 10 checks: Codex plugin (manifest/hook + zero-dependency MCP + tool-contract parity)
node --test tests/three-forms.test.mjs   # 5 checks: all three forms read/write the same bundle consistently
node --test tests/ref-abs-path.test.mjs  # 19 checks: concept refs carry a real absolute path (angle-bracketed), id semantics intact, cwd-mismatch dead link locked out
node --test tests/overview.test.mjs      # 24 checks: wiki_list full inventory (every title listed, no absolute paths, no silent truncation, no split lines)
node --test tests/vendor-sync.test.mjs   # 4 checks: vendor-core snapshots byte-identical to packages/core (guards the "edited core, forgot vendor" false-green)
#   ^ also appended to packages/{mcp,pi,codex} test scripts: those load vendor-core first, so a
#     stale snapshot makes them silently run old logic — the guard has to run where they do.
```

## License

MIT