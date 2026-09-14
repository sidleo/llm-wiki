/**
 * pi-wiki — Pi 扩展（llm-wiki 通用知识库，OKF v0.2）。
 *
 * 复用 @sidleo3/llm-wiki-core 的全部逻辑（与 DSH 插件 / skill CLI 同一实现），
 * 注册 14 个 wiki_* 工具 + prompt 引导。数据目录默认 ~/.agents/wiki，
 * 环境变量 PI_WIKI_DATA_DIR 覆盖；多目录用命名 bundle（注册表
 * ~/.agents/wiki-registry.json，env WIKI_REGISTRY_FILE 覆盖），wiki_use 切换
 * 全局默认（pi 无会话态，无 DSH 的 per-agent 会话级切换）。
 *
 * Pi 无 DSH 的 system-prompt section 瀑布：用每个工具的 promptSnippet +
 * promptGuidelines 注入静态引导（「第一步先 wiki_list」等硬要求）。
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 加载 core：优先同包 vendor-core（复制安装/自包含），回退本仓库 packages/core（开发态）
let corePromise: Promise<any> | null = null;
function loadCore(): Promise<any> {
  if (corePromise) return corePromise;
  const vendorPath = path.join(__dirname, "..", "vendor-core", "index.mjs");
  corePromise = import(vendorPath).catch(async () => {
    const devPath = path.join(__dirname, "..", "..", "core", "index.mjs");
    return import(devPath);
  });
  return corePromise;
}

const WIKI_GUIDELINES = [
  "llm-wiki 知识库（OKF v0.2）：概念 = frontmatter(type 必填)+正文的 .md 文件，目录自由分层，真实链接交叉引用；index.md/log.md/AGENTS.md 是保留文件。",
  "做知识相关工作第一步先 wiki_list 看全貌（渐进披露），再 wiki_search / wiki_get 按需取明细。",
  "wiki_get 自动附 backlinks（引用它的概念/坑点）。写入前先 wiki_rules <目录> 看 AGENTS.md 门控。",
  "主动知识记录行为由各分类目录 APPEND_SYSTEM_PROMPT.md 决定：做某分类工作前若该目录（含祖先）有该文件，其正文即追加行为规则，照做。",
  "frontmatter 只用 OKF 字段，不引入自定义字段；断链 = 未写入知识，lint 归集，不必修。",
  "在线知识库用 wiki_sync：status 看远端/领先落后/冲突，sync 提交+拉取合并+推送（概念冲突会停止并报清单，index.md 自动重生成、log.md 取并集）；绝不 force push。",
].join("\n");

const textOut = { text: Type.String() };
const ok = (text: string) => ({ text });
const err = (e: unknown) => ({ text: `错误：${e instanceof Error ? e.message : String(e)}` });
const listVal = (v: unknown): string[] =>
  v === undefined || v === null || v === ""
    ? []
    : String(v).split(/\s*,\s*/).filter(Boolean);

function registerTools(pi: ExtensionAPI, config: Record<string, unknown>, injectSnapshot = ""): void {
  const guidelines = () => (injectSnapshot ? [WIKI_GUIDELINES + injectSnapshot] : [WIKI_GUIDELINES]);

  /** 当前生效 bundle 根（全局默认：注册表 active 或 default；pi 无会话态）。 */
  async function resolveDir(): Promise<string> {
    const core = await loadCore();
    const r = await core.resolveBundleRoot(config, {});
    return r.path;
  }
  // wiki_list
  pi.registerTool({
    name: "wiki_list",
    label: "Wiki List",
    description:
      "列出 llm-wiki 知识库（OKF v0.2 bundle）的目录树与概念清单（type/title/id）。【硬要求】做知识相关工作第一步先调用本工具看全貌。",
    promptSnippet: "知识库列表：知识工作第一步先 wiki_list 看目录树与概念全貌",
    promptGuidelines: guidelines(),
    parameters: Type.Object({
      type: Type.Optional(Type.String({ description: "按 type 过滤（Table / Attested Computation / Pitfall / Metric…）" })),
      status: Type.Optional(Type.String({ description: "按 status 过滤（draft/stable/deprecated）" })),
    }),
    async execute(_id, params) {
      try {
        const core = await loadCore();
        const dataDir = await resolveDir();
        const tree = await core.listBundle(dataDir, { type: params.type, status: params.status });
        if (!tree.length) return ok("（知识库为空或过滤后无概念）");
        const lines: string[] = [];
        for (const t of tree) {
          lines.push(`[${t.dir || "(root)"}]`);
          for (const c of t.concepts) {
            lines.push(`  ${c.type}: ${c.title}  (${c.id})${c.status === "deprecated" ? " [deprecated]" : ""}`);
          }
        }
        lines.push(`\n共 ${tree.reduce((n: number, t: any) => n + t.concepts.length, 0)} 个概念。`);
        return ok(lines.join("\n"));
      } catch (e) {
        return err(e);
      }
    },
  });

  // wiki_search
  pi.registerTool({
    name: "wiki_search",
    label: "Wiki Search",
    description:
      "搜索 llm-wiki 知识库：匹配 frontmatter（type/title/description/tags）+ 正文；词元拆分、量词后缀兜底、强匹配 ★ 排前；支持 type/tag 过滤。未命中提示 wiki_list / wiki_lint。",
    promptSnippet: "知识库检索：用关键词/type/tag 缩小范围",
    promptGuidelines: guidelines(),
    parameters: Type.Object({
      query: Type.String({ description: "关键词（空格分隔多词，任一词命中即命中）" }),
      type: Type.Optional(Type.String({ description: "限定 type" })),
      tag: Type.Optional(Type.String({ description: "限定标签（tags 精确包含）" })),
      limit: Type.Optional(Type.Number({ description: "最多返回条数（默认 20）" })),
    }),
    async execute(_id, params) {
      try {
        const q = String(params.query || "").trim();
        if (!q) return ok("query 不能为空");
        const core = await loadCore();
        const dataDir = await resolveDir();
        const graph = await core.buildGraph(dataDir);
        const res = core.searchGraph(graph, q, { type: params.type, tag: params.tag, limit: params.limit || 20 });
        if (!res.length) return ok("无匹配。若这是工作中遇到的真实表/知识：可用 wiki_create 主动补录（探查事实自动记录；新口径先与用户确认）。或 wiki_list 看全貌 / wiki_lint 看缺失。");
        return ok(res.map((r: any) => `${r.strong ? "★" : ""}${r.type}: ${r.title}  (${r.id})\n    ${r.description || ""}`).join("\n"));
      } catch (e) {
        return err(e);
      }
    },
  });

  // wiki_get
  pi.registerTool({
    name: "wiki_get",
    label: "Wiki Get",
    description: "读取单个概念完整正文（id 或 title）。自动附 backlinks：引用它的概念（坑点/口径等），无需额外字段。",
    promptSnippet: "知识库明细：按 id/title 读单个概念全文 + backlinks",
    promptGuidelines: guidelines(),
    parameters: Type.Object({ id: Type.String({ description: "Concept ID（如 tables/orders）或 title" }) }),
    async execute(_id, params) {
      try {
        const core = await loadCore();
        const dataDir = await resolveDir();
        const got = await core.getConcept(dataDir, params.id);
        if (!got) return ok(`未找到: ${params.id}。若这是真实表/概念可用 wiki_create 主动补录。或 wiki_list 看全貌。`);
        if (got.ambiguous) return ok(`标题「${params.id}」有多个候选: ${got.candidates.join(", ")}。请用完整 id。`);
        const lines = [
          `# ${got.title}  (${got.id})`,
          `type: ${got.type}${got.meta.status ? ` | status: ${got.meta.status}` : ""}${got.meta.runtime ? ` | runtime: ${got.meta.runtime}` : ""}`,
          "",
          got.desc || "",
          "",
          `--- backlinks (${got.backlinks.length}) ---`,
          ...(got.backlinks.length ? got.backlinks.map((b: any) => `  ${b.type}: ${b.title}  (${b.id})`) : ["  （无入链）"]),
          "",
          "--- body ---",
          got.body.trim(),
        ];
        return ok(lines.join("\n"));
      } catch (e) {
        return err(e);
      }
    },
  });

  // wiki_create
  pi.registerTool({
    name: "wiki_create",
    label: "Wiki Create",
    description:
      "新增概念（纯 OKF frontmatter：type 必填 + title/description/tags…；完整字段说明查 wiki_help frontmatter：sources/stale_after 按需手写，generated/verified 由 confirmed 自动维护）。写入门控完全由目标目录链 AGENTS.md 的「## 门控」声明决定（子目录覆盖父目录；链上无声明则默认全部自动记录），需确认的类型以 confirmed:true 调用带 human verified。自动维护 log.md/index.md。",
    promptSnippet: "知识库写入：新增概念；目录 AGENTS.md 门控决定是否需 confirmed:true",
    promptGuidelines: guidelines(),
    parameters: Type.Object({
      path: Type.String({ description: "Concept ID（bundle 相对路径，不含 .md，如 tables/orders）" }),
      type: Type.String({ description: "OKF type（Table / Attested Computation / Pitfall / Reference / Metric / Playbook…）" }),
      title: Type.Optional(Type.String({ description: "显示名，缺省用文件名" })),
      description: Type.Optional(Type.String({ description: "一句话摘要" })),
      body: Type.Optional(Type.String({ description: "markdown 正文（# Schema / # Computation / # Gotchas…）" })),
      tags: Type.Optional(Type.String({ description: "逗号分隔标签" })),
      status: Type.Optional(Type.String({ description: "draft/stable/deprecated" })),
      confirmed: Type.Optional(Type.Boolean({ description: "true=用户已确认（写入带 human verified）" })),
      user: Type.Optional(Type.String({ description: "确认人标识，形如 zhang3" })),
    }),
    async execute(_id, params) {
      try {
        const core = await loadCore();
        const dataDir = await resolveDir();
        const dir = path.posix.dirname(params.path) === "." ? "" : path.posix.dirname(params.path);
        const gate = await core.gateForType(dataDir, dir, params.type);
        if (gate.needConfirm && !params.confirmed) {
          return ok(
            `该写入需用户确认（AGENTS.md 门控规则${gate.via ? ` ${gate.via}` : ""}要求 ${params.type} 类写入需 human 确认）。请先展示拟改动内容并征得同意后以 confirmed:true 调用。`,
          );
        }
        const created = await core.createConcept(dataDir, {
          id: params.path,
          type: params.type,
          title: params.title,
          description: params.description,
          body: params.body,
          tags: listVal(params.tags),
          status: params.status,
          opts: { confirmed: params.confirmed === true, user: params.user || "human:unknown", producer: "@sidleo3/pi-wiki", version: "0.2.0" },
        });
        return ok(`已创建 ${created.id}`);
      } catch (e) {
        return err(e);
      }
    },
  });

  // wiki_update
  pi.registerTool({
    name: "wiki_update",
    label: "Wiki Update",
    description: "更新已有概念：只更新传入字段；trust 自动刷新；confirmed 追加 human verified。",
    promptSnippet: "知识库更新：改已有概念字段/正文",
    promptGuidelines: guidelines(),
    parameters: Type.Object({
      id: Type.String({ description: "Concept ID" }),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      type: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      tags: Type.Optional(Type.String()),
      confirmed: Type.Optional(Type.Boolean({ description: "true=用户已确认" })),
      user: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      try {
        const core = await loadCore();
        const dataDir = await resolveDir();
        await core.updateConcept(dataDir, params.id, {
          title: params.title,
          description: params.description,
          body: params.body,
          type: params.type,
          status: params.status,
          tags: params.tags !== undefined ? listVal(params.tags) : undefined,
          opts: { confirmed: params.confirmed === true, user: params.user || "human:unknown", producer: "@sidleo3/pi-wiki", version: "0.2.0" },
        });
        return ok(`已更新 ${params.id}`);
      } catch (e) {
        return err(e);
      }
    },
  });

  // wiki_validate
  pi.registerTool({
    name: "wiki_validate",
    label: "Wiki Validate",
    description: "校验知识库 OKF v0.2 合规（非保留 .md 有 frontmatter + 非空 type；保留文件结构）。缺可选字段/断链不判失败。",
    promptSnippet: "知识库校验：新增/修改后确认 OKF 合规",
    promptGuidelines: guidelines(),
    parameters: Type.Object({}),
    async execute() {
      try {
        const core = await loadCore();
        const dataDir = await resolveDir();
        const v = await core.validateBundle(dataDir);
        const lines = [v.ok ? "OKF v0.2 合规 ✓" : "不合规："];
        for (const e of v.errors) lines.push("ERROR " + e);
        for (const w of v.warnings) lines.push("warn " + w);
        return ok(lines.join("\n"));
      } catch (e) {
        return err(e);
      }
    },
  });

  // wiki_lint
  pi.registerTool({
    name: "wiki_lint",
    label: "Wiki Lint",
    description: "知识库体检：断链（提及但无目标=未写入知识）、孤儿页、过期（stale_after）、缺 index、缺 description、重复标题。",
    promptSnippet: "知识库体检：断链/孤儿/过期/缺 index",
    promptGuidelines: guidelines(),
    parameters: Type.Object({}),
    async execute() {
      try {
        const core = await loadCore();
        const dataDir = await resolveDir();
        const l = await core.lintBundle(dataDir);
        const lines = l.issues.length ? l.issues.map((i: any) => `${i.sev === "warn" ? "WARN" : "info"} [${i.kind}] ${i.msg}`) : ["lint clean ✓"];
        lines.push(`\nsummary: ${JSON.stringify(l.summary)}`);
        return ok(lines.join("\n"));
      } catch (e) {
        return err(e);
      }
    },
  });

  // wiki_ingest
  pi.registerTool({
    name: "wiki_ingest",
    label: "Wiki Ingest",
    description: "登记外部源文件进知识库（copy 不改源，生成 type: Reference 来源概念页），供后续提炼写入。",
    promptSnippet: "知识库收录：把外部源文件登记进 bundle",
    promptGuidelines: guidelines(),
    parameters: Type.Object({
      source: Type.String({ description: "外部源文件绝对路径" }),
      ref_dir: Type.Optional(Type.String({ description: "登记目录（缺省 references）" })),
    }),
    async execute(_id, params) {
      try {
        const core = await loadCore();
        const dataDir = await resolveDir();
        const r = await core.ingestSource(dataDir, { source: params.source, refDir: params.ref_dir }, { producer: "@sidleo3/pi-wiki", version: "0.2.0" });
        return ok(`ingested → ${r.refPath}${r.existed ? " (existed)" : ""}; 来源概念 ${r.sourceConceptId}`);
      } catch (e) {
        return err(e);
      }
    },
  });

  // wiki_deprecate
  pi.registerTool({
    name: "wiki_deprecate",
    label: "Wiki Deprecate",
    description: "目录级批量停用：把某目录（含子目录）下全部概念标 status: deprecated（数据零删除，可恢复）。",
    promptSnippet: "知识库停用：整目录批量标 deprecated",
    promptGuidelines: guidelines(),
    parameters: Type.Object({ path: Type.Optional(Type.String({ description: "目录（bundle 相对，如 tables；空=全库）" })) }),
    async execute(_id, params) {
      try {
        const core = await loadCore();
        const dataDir = await resolveDir();
        const r = await core.deprecateDir(dataDir, String(params.path || ""));
        return ok(`已停用 ${r.deprecated}/${r.total} 个概念`);
      } catch (e) {
        return err(e);
      }
    },
  });

  // wiki_rules
  pi.registerTool({
    name: "wiki_rules",
    label: "Wiki Rules",
    description: "查看某目录生效的 AGENTS.md 规则（向上遍历取最近、子覆盖父），写入前先看它确认门控。",
    promptSnippet: "知识库规则：写入前查看目录 AGENTS.md 门控",
    promptGuidelines: guidelines(),
    parameters: Type.Object({ path: Type.Optional(Type.String({ description: "目录（bundle 相对，空=根）" })) }),
    async execute(_id, params) {
      try {
        const core = await loadCore();
        const dataDir = await resolveDir();
        const rules = await core.resolveRules(dataDir, String(params.path || ""));
        if (!rules.length) return ok("（无 AGENTS.md 规则）");
        return ok(rules.map((r: any) => `===== ${r.path} =====\n${r.content.trimEnd()}`).join("\n\n"));
      } catch (e) {
        return err(e);
      }
    },
  });

  // wiki_dirs
  pi.registerTool({
    name: "wiki_dirs",
    label: "Wiki Dirs",
    description:
      "查看全部 wiki 目录分支（命名 bundle）与当前激活项。bundle 来源：注册表 ~/.agents/wiki-registry.json ∪ 插件配置 dataDirs（同名配置优先）；隐式 default 兜底。注册新目录：编辑注册表；切换用 wiki_use。详见 wiki_help bundle。",
    promptSnippet: "知识库分支：查看已注册目录与当前激活项",
    promptGuidelines: guidelines(),
    parameters: Type.Object({}),
    async execute() {
      try {
        const core = await loadCore();
        const rows = await core.listBundles(config);
        const active = await resolveDir();
        const lines = rows.map((r: any) => `${r.active ? "*" : " "} [${r.name}] ${r.path}${r.active ? "  ← 全局默认" : ""}`);
        lines.push(`\n当前生效目录：${active}`);
        lines.push("\n切换：wiki_use <name> [global:true]；注册新目录：~/.agents/wiki-registry.json（详见 wiki_help bundle）。");
        return ok(lines.join("\n"));
      } catch (e) {
        return err(e);
      }
    },
  });

  // wiki_use
  pi.registerTool({
    name: "wiki_use",
    label: "Wiki Use",
    description:
      "切换当前 wiki 目录分支（全局默认，写注册表 ~/.agents/wiki-registry.json 的 active，影响后续所有工具调用与新会话）。pi 无会话态：不支持 DSH 的会话级切换；不带 global:true 时仅校验 name 并展示目标。",
    promptSnippet: "知识库切换：改全局默认目录分支（写注册表 active）",
    promptGuidelines: guidelines(),
    parameters: Type.Object({
      name: Type.String({ description: "bundle 名（wiki_dirs 查看）或 default" }),
      global: Type.Optional(Type.Boolean({ description: "true=持久化为全局默认（写注册表 active）；缺省仅校验展示" })),
    }),
    async execute(_id, params) {
      try {
        const core = await loadCore();
        const resolved = await core.resolveBundleRoot(config, { name: params.name });
        if (params.global === true) await core.writeRegistryActive(resolved.name);
        const scope = params.global === true ? "全局默认，后续工具调用与新会话生效" : "校验通过（pi 无会话态；需 global:true 才持久化）";
        return ok(`[${resolved.name}] ${resolved.path}（${scope}）`);
      } catch (e) {
        return err(e);
      }
    },
  });

  // wiki_help
  pi.registerTool({
    name: "wiki_help",
    label: "Wiki Help",
    description: "查 llm-wiki 机制文档：保留文件一览 / 怎么写目录 AGENTS.md / 怎么写 APPEND_SYSTEM_PROMPT.md（分类行为注入）/ OKF frontmatter 速查 / 门控判定逻辑。想给分类加行为规则或门控时先查它。",
    promptSnippet: "机制文档：查保留文件/AGENTS/APPEND 写法",
    promptGuidelines: guidelines(),
    parameters: Type.Object({ topic: Type.Optional(Type.String({ description: "主题：quickstart | files | agents | append | frontmatter | gate | bundle | sync（缺省 quickstart）" })) }),
    async execute(_id, params) {
      try {
        const core = await loadCore();
        return ok(core.getHelp(params.topic));
      } catch (e) {
        return err(e);
      }
    },
  });

  // wiki_sync —— 在线知识库同步（本地目录→Git；飞书云盘库→lark-cli），与 DSH 形态同一 core 实现
  pi.registerTool({
    name: "wiki_sync",
    label: "Wiki Sync",
    description: "在线知识库同步，按 bundle 后端自动分派：本地目录走 Git 远端（status/sync/init/clone），飞书云盘库走 lark-cli（status/sync/pull/push/init；文件级增量、永不删两端）。index.md 重生成、log.md 取并集；概念冲突停下来报清单，绝不 force/覆盖。",
    promptSnippet: "在线知识库同步：Git 远端 / 飞书云盘库（status/sync/pull/push/init/clone）",
    promptGuidelines: guidelines(),
    parameters: Type.Object({
      action: Type.String({ description: "status | sync | pull | push | init | clone", enum: ["status", "sync", "pull", "push", "init", "clone"] }),
      message: Type.Optional(Type.String({ description: "git sync 的提交信息" })),
      bundle: Type.Optional(Type.String({ description: "目标命名 bundle（缺省=当前生效）" })),
      remote: Type.Optional(Type.String({ description: "init（git）：远端 URL" })),
      folder_token: Type.Optional(Type.String({ description: "init（飞书）：文件夹 URL 或 token" })),
      new_folder: Type.Optional(Type.String({ description: "init（飞书）：在我的空间新建同名文件夹" })),
      cache_dir: Type.Optional(Type.String({ description: "init（飞书）：本地缓存目录" })),
      adopt: Type.Optional(Type.String({ description: "飞书首次同步裁决：local | remote", enum: ["local", "remote"] })),
      url: Type.Optional(Type.String({ description: "clone：远端 URL" })),
      dir: Type.Optional(Type.String({ description: "clone：本地目标目录" })),
      name: Type.Optional(Type.String({ description: "init/clone：注册为命名 bundle" })),
      use: Type.Optional(Type.Boolean({ description: "init/clone：注册后设为全局默认" })),
      branch: Type.Optional(Type.String({ description: "init（git）：初始分支名" })),
    }),
    async execute(_id, params) {
      try {
        const core = await loadCore();
        const action = String(params.action || "");
        if (action === "clone") {
          if (!params.url || !params.dir) return ok("clone 需要 url 与 dir 参数。");
          return ok(formatSync("git", action, await core.gitClone(params.url, params.dir, { name: params.name, use: params.use === true })));
        }
        if (action === "init" && (params.folder_token || params.new_folder)) {
          return ok(formatSync("feishu", "init", await core.feishuInit({ name: params.name, folderToken: params.folder_token, newFolder: params.new_folder, cacheDir: params.cache_dir, use: params.use === true })));
        }
        const resolved = params.bundle
          ? await core.resolveBundleRoot(config, { name: params.bundle })
          : await core.resolveBundleRoot(config, {});
        const feishu = resolved.kind === "feishu";

        if (action === "status") {
          return ok(feishu ? formatSync("feishu", action, await core.feishuStatus(resolved)) : formatSync("git", action, await core.gitStatus(resolved.path)));
        }
        if (feishu) {
          if (action === "sync") return ok(formatSync("feishu", action, { ...(await core.feishuSync(resolved, { adopt: params.adopt, message: params.message })), bundle: resolved }));
          if (action === "pull" || action === "push") {
            const before = await core.feishuStatus(resolved);
            if (!before.ok) return ok(formatSync("feishu", action, before));
            if (action === "push" && before.conflict.length) {
              return ok(formatSync("feishu", action, { ok: false, step: "conflict", conflicts: before.conflict.map((x: any) => x.rel), error: `${before.conflict.length} 个文件两侧都改过`, next: "请先人工处理冲突（飞书或本地任选一侧）再重跑。" }));
            }
            const r = action === "pull"
              ? await core.feishuPull(resolved, { paths: before.pull.map((x: any) => x.rel) })
              : await core.feishuPush(resolved, { paths: before.push.map((x: any) => x.rel) });
            return ok(formatSync("feishu", action, { ...r, bundle: resolved }));
          }
          return ok(`飞书后端不支持 action「${params.action}」：可用 status | sync | pull | push | init。`);
        }
        if (action === "sync" || action === "push" || action === "pull") {
          return ok(formatSync("git", action, { ...(await core.gitSync(resolved.path, { message: params.message, push: action !== "pull" })), bundle: resolved }));
        }
        if (action === "init") {
          return ok(formatSync("git", "init", { ...(await core.gitInit(resolved.path, { remote: params.remote, branch: params.branch, name: params.name, use: params.use === true })), bundle: resolved }));
        }
        return ok(`未知 action「${params.action}」：可用 status | sync | pull | push | init | clone。`);
      } catch (e) {
        return err(e);
      }
    },
  });
}

/** 在线同步结果文本化（git / 飞书两种后端）。 */
function formatSync(kind: string, action: string, r: any): string {
  if (kind === "feishu") {
    if (action === "status") {
      if (!r.ok) return `在线库状态：不可用\n- ${r.error}${r.next ? `\n- 下一步：${r.next}` : ""}`;
      const c = r.counts || {};
      const lines = [`在线库状态：待推送 ${c.push} / 待拉取 ${c.pull} / 冲突 ${c.conflict}｜本地 ${c.local} 个 .md，远端 ${c.remote} 个 .md`];
      if (r.conflict.length) lines.push(`- 冲突（两侧都改）：${r.conflict.map((x: any) => x.rel).join("、")}`);
      if (r.remoteDeleted.length) lines.push(`- 远端已删（本地保留）：${r.remoteDeleted.join("、")}`);
      return lines.join("\n");
    }
    if (r.ok) {
      if (action === "init") return `飞书在线库初始化完成：${r.name}\n- 文件夹：${r.url}\n- 本地缓存：${r.cacheDir}\n（首次 wiki_sync sync 会把本地内容推上去）`;
      const lines = [`${action === "pull" ? "拉取完成" : action === "push" ? "推送完成" : "同步完成"}${r.bundle ? `：${r.bundle.name}` : ""}`];
      if (r.pushed && r.pushed.length) lines.push(`- 推送 ${r.pushed.length} 个文件（新增 ${(r.created || []).length}）`);
      if (r.pulled && r.pulled.length) lines.push(`- 拉取 ${r.pulled.length} 个文件`);
      if (r.after) lines.push(`- 现在：待推送 ${r.after.push} / 待拉取 ${r.after.pull} / 冲突 ${r.after.conflict}`);
      for (const s of r.steps || []) lines.push(`  · ${s}`);
      return lines.join("\n");
    }
    const lines = [`${action}失败（${r.step || "unknown"}）：${r.error || "未知错误"}`];
    if (r.conflicts && r.conflicts.length) lines.push(`- 冲突文件：${r.conflicts.join("、")}`);
    if (r.next) lines.push(`- 下一步：${r.next}`);
    return lines.join("\n");
  }
  return formatGit(action, r);
}

/** wiki_sync 结果文本化（与 DSH 形态语义一致）。 */
function formatGit(action: string, r: any): string {
  if (action === "status") {
    if (!r.ok) return `同步状态：不可用\n- ${r.error}${r.next ? `\n- 下一步：${r.next}` : ""}`;
    return [
      `同步状态：${r.remote || "(未配置远端)"}`,
      `- 分支：${r.branch || "(detached)"}${r.upstream ? ` → ${r.upstream}` : "（未设 upstream）"}`,
      `- 领先 ${r.ahead} / 落后 ${r.behind}`,
      `- 工作区改动：${r.dirty.length} 个文件`,
      r.conflicts.length ? `- 冲突：${r.conflicts.join("、")}` : "",
      `- 最后提交：${r.lastCommit || "(无)"}`,
    ].filter(Boolean).join("\n");
  }
  if (r.ok) {
    if (action === "clone") return `已克隆：${r.dir}${r.registered ? `（注册为「${r.registered}」）` : ""}`;
    const lines = [`${action === "init" ? "初始化完成" : "同步完成"}${r.bundle ? `：${r.bundle.name} → ${r.bundle.path}` : ""}`];
    if (r.committed) lines.push(`- 本地提交：${r.committed} 个文件`);
    if (r.merged) lines.push("- 已合并远端变更");
    if (r.pushed) lines.push("- 已推送");
    if (r.status) lines.push(`- 现在：领先 ${r.status.ahead} / 落后 ${r.status.behind}`);
    return lines.join("\n");
  }
  const lines = [`${action === "init" ? "初始化" : "同步"}失败（${r.step || "unknown"}）：${r.error || "未知错误"}`];
  if (r.conflicts && r.conflicts.length) lines.push(`- 冲突文件：${r.conflicts.join("、")}`);
  if (r.next) lines.push(`- 下一步：${r.next}`);
  return lines.join("\n");
}

/**
 * Pi 扩展默认导出：注册 14 个 wiki_* 工具。
 * 数据目录默认 ~/.agents/wiki，环境变量 PI_WIKI_DATA_DIR 覆盖；多目录用命名
 * bundle（注册表 ~/.agents/wiki-registry.json），wiki_use 切换全局默认。
 *
 * 启动快照：加载时读一次各目录 APPEND_SYSTEM_PROMPT.md，把目录清单与正文
 * 并入 guidelines。做不到 DSH 的每轮更新（pi 无 system-prompt 瀑布钩子），
 * 但保证 agent 在会话启动时见过一次注入规则全文，而不只是「有这机制」一句话。
 * 若启动后 APPEND 文件变化，agent 可用 wiki_rules 按需重读。
 */
export default async function (pi: ExtensionAPI, _ctx?: ExtensionContext): Promise<void> {
  const config: Record<string, unknown> = { dataDir: process.env.PI_WIKI_DATA_DIR || undefined };
  let extra = "";
  try {
    const core = await loadCore();
    const { path: dataDir } = await core.resolveBundleRoot(config, {});
    const prompts = await core.collectInjectPrompts(dataDir);
    if (prompts.length) {
      const parts = prompts.map((p: any) =>
        p.dir ? `### [${p.dir}]\n${p.content}` : `### (bundle 根规则)\n${p.content}`,
      );
      extra =
        "\n【知识库自定义规则快照】以下为各目录 APPEND_SYSTEM_PROMPT.md 在扩展加载时的内容（后续变更用 wiki_rules 按需重读）：\n" +
        parts.join("\n\n");
    }
  } catch {
    // 读不到不影响工具注册（静默降级）
  }
  registerTools(pi, config, extra);
}
