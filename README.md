# llm-wiki — Agent Knowledge Base in Pure OKF v0.2 Markdown

[English](README.md) · [简体中文](README.zh-CN.md)

An open-source, generic, agent-first knowledge base: **the format layer strictly follows the [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)**, and the operations layer follows Karpathy's [llm-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (ingest / query / lint + index / log). It ships in three consumption forms that share one core library and one data bundle.

## Design Principles

1. **Strictly OKF v0.2** — the official spec is the single source of truth for the format; no custom frontmatter fields, no magic features at the consumption layer.
2. **Generic and vendor-neutral** — not tied to any business or domain; the same bundle is readable and writable by any agent.

## Features

- **Progressive disclosure** — every session carries injected tool guidance plus the active bundle/category list; `wiki_list` shows the whole tree first, then you search and drill in.
- **Real cross-links + automatic backlinks** — concepts reference each other with Markdown links; reading a concept automatically surfaces the pitfalls and rules that cite it.
- **Directory-level rules (`AGENTS.md`)** — per-directory write gates (which concept types need human confirmation) and behavioral conventions, resolved bottom-up with child directories overriding parents.
- **Per-directory prompt injection (`APPEND_SYSTEM_PROMPT.md`)** — each category can define its own behavior rules. On DSH they ride the runtime-context snapshot (session tail, re-appended only when branch or rules change); on pi they load once per session. They stay out of the system prompt so injection never invalidates the prompt prefix cache.
- **Lifecycle** — `stale_after` expiry, `status: deprecated` (concept-level) and directory-level deprecation, auto-maintained `index.md` / `log.md`.
- **Validation & health** — `wiki_validate` (OKF compliance) and `wiki_lint` (broken links, orphans, stale entries, missing index).
- **Multiple bundles** — register several wiki directories as named bundles and switch between them (session-level or persisted globally).
- **Online knowledge base (Git remote sync)** — the bundle stays a local Markdown tree; attach a remote and several machines / people / agents read and write the same one through `wiki_sync` (or `wiki sync`): commit → fetch/merge → push. `index.md` is regenerated, `log.md` is merged as a union (concurrent writes never block); concept conflicts stop the sync and list the files, the working tree returns to its pre-sync state, and force-push is never used.
- **Graphical configuration (DSH Web GUI)** — an llm-wiki card under Settings → Plugins → Plugin configuration: named directories (add/rename/remove/set default), Git remote status with one-click sync/init/clone, and a health panel (validate/lint counts + rebuild index). Runtime parameters are deployment-level (the profile's `cordis.patch.yml`) and are deliberately not editable from the card.

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
│   └── skill/              # skill form → SKILL.md + `wiki` CLI
├── examples/demo-bundle/   # Synthetic demo bundle (openable in Obsidian)
├── scripts/                # Dev helper scripts
├── tests/fixtures/         # Synthetic test data
└── obsidian/               # Obsidian templates / Dataview examples
```

## Three Consumption Forms

| Form | Install | Capability |
|------|---------|-----------|
| DSH plugin | `dsh plugin --profile web add @sidleo3/dsh-wiki` | Layered injection (constant section + session snapshot, optional) + `wiki_*` tools |
| pi extension | `pi install npm:@sidleo3/pi-wiki` | `wiki_*` tools + prompt guidance |
| skill + CLI | `~/.agents/skills/wiki/` (see `packages/skill/INSTALL.md`) | SKILL.md guidance + `wiki` CLI (any agent harness) |

All three forms read and write **the same bundle** with identical behavior — they reuse `packages/core`, no duplicated implementation.

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

### Graphical configuration (DSH Web GUI)

Settings → Plugins → Plugin configuration → llm-wiki card (the host renders the intersection of *served settings namespaces* and *registered cards*; the card key is `dsh-wiki`):

| Section | What it edits | Where it lands |
|---------|---------------|----------------|
| Named directories | add / rename / remove / set default | `~/.agents/wiki-registry.json` (shared with CLI/pi; removal only unregisters, never deletes) |
| Git sync | remote/branch/ahead-behind/conflicts + sync / init / clone | core `git.mjs`, the same implementation as `wiki_sync` |
| Health & index | validate/lint counts and details, rebuild index | core `validateBundle` / `lintBundle` / `refreshIndex` |

(Runtime parameters are not in the card: data dir, injection section name/order, limits and cache TTL are deployment-level and live in the profile's `cordis.patch.yml`.)

## Multiple Bundles (Named Directories)

The default data directory is `~/.agents/wiki`. To manage several wiki directories, register them as named bundles:

- **Registry file** (shared across all three forms; default `~/.agents/wiki-registry.json`, overridable via env `WIKI_REGISTRY_FILE`):

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

- **Switching** — `wiki_use <name> [global: true]`: session-level by default in the DSH host (isolated per conversation); `global: true` persists it as the global default (writes the registry `active`, affecting new sessions and the CLI/pi forms). `wiki_dirs` lists the branches. The CLI uses `wiki dirs` / `wiki use NAME [--global]`, and any command accepts `--wiki NAME`.
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
node scripts/smoke-test.mjs              # 36 checks: core tool chain + registry + ingest/lint end-to-end
node tests/dsh-mock-test.mjs             # 33 checks: DSH plugin (mock host) tools + injection layers + gates + multi-bundle + sync
node --test tests/dsh-config-test.mjs    # 9 checks: config card host half (settings namespace + /api/dsh-wiki/* routes)
node --test tests/git-sync.test.mjs      # 8 checks: Git remote sync (sequential writes / concurrent log / index / concept conflicts)
node --test tests/dsh-client-bundle-test.mjs   # 5 checks: card bundle contract + jsdom render smoke
(cd packages/pi && npm install --legacy-peer-deps && npm test)   # 13 checks: pi extension (mock pi)
node --test tests/three-forms.test.mjs   # 5 checks: all three forms read/write the same bundle consistently
```

## License

MIT