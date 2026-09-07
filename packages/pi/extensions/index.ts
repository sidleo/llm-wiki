/**
 * pi-wiki — Pi 扩展（llm-wiki 通用知识库，OKF v0.2）。
 *
 * 复用 llm-wiki-core 的全部逻辑（与 DSH 插件 / skill CLI 同一实现），
 * 注册 11 个 wiki_* 工具 + prompt 引导。数据目录默认 ~/.agents/wiki，
 * 环境变量 PI_WIKI_DATA_DIR 覆盖。
 *
 * Pi 无 DSH 的 system-prompt section 瀑布：用每个工具的 promptSnippet +
 * promptGuidelines 注入静态引导（「第一步先 wiki_list」等硬要求）。
 */

import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".agents", "wiki");
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
].join("\n");

const textOut = { text: Type.String() };
const ok = (text: string) => ({ text });
const err = (e: unknown) => ({ text: `错误：${e instanceof Error ? e.message : String(e)}` });
const listVal = (v: unknown): string[] =>
  v === undefined || v === null || v === ""
    ? []
    : String(v).split(/\s*,\s*/).filter(Boolean);

function registerTools(pi: ExtensionAPI, dataDir: string): void {
  // wiki_list
  pi.registerTool({
    name: "wiki_list",
    label: "Wiki List",
    description:
      "列出 llm-wiki 知识库（OKF v0.2 bundle）的目录树与概念清单（type/title/id）。【硬要求】做知识相关工作第一步先调用本工具看全貌。",
    promptSnippet: "知识库列表：知识工作第一步先 wiki_list 看目录树与概念全貌",
    promptGuidelines: WIKI_GUIDELINES,
    parameters: Type.Object({
      type: Type.Optional(Type.String({ description: "按 type 过滤（Table / Attested Computation / Pitfall / Metric…）" })),
      status: Type.Optional(Type.String({ description: "按 status 过滤（draft/stable/deprecated）" })),
    }),
    async execute(_id, params) {
      try {
        const core = await loadCore();
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
    promptGuidelines: WIKI_GUIDELINES,
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
        const graph = await core.buildGraph(dataDir);
        const res = core.searchGraph(graph, q, { type: params.type, tag: params.tag, limit: params.limit || 20 });
        if (!res.length) return ok("无匹配。可 wiki_list 看全貌，或 wiki_lint 查看缺失概念/断链清单。");
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
    promptGuidelines: WIKI_GUIDELINES,
    parameters: Type.Object({ id: Type.String({ description: "Concept ID（如 tables/orders）或 title" }) }),
    async execute(_id, params) {
      try {
        const core = await loadCore();
        const got = await core.getConcept(dataDir, params.id);
        if (!got) return ok(`未找到: ${params.id}。可 wiki_list 看全貌。`);
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
    promptGuidelines: WIKI_GUIDELINES,
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
          opts: { confirmed: params.confirmed === true, user: params.user || "human:unknown", producer: "pi-wiki", version: "0.1.0" },
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
    promptGuidelines: WIKI_GUIDELINES,
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
        await core.updateConcept(dataDir, params.id, {
          title: params.title,
          description: params.description,
          body: params.body,
          type: params.type,
          status: params.status,
          tags: params.tags !== undefined ? listVal(params.tags) : undefined,
          opts: { confirmed: params.confirmed === true, user: params.user || "human:unknown", producer: "pi-wiki", version: "0.1.0" },
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
    promptGuidelines: WIKI_GUIDELINES,
    parameters: Type.Object({}),
    async execute() {
      try {
        const core = await loadCore();
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
    promptGuidelines: WIKI_GUIDELINES,
    parameters: Type.Object({}),
    async execute() {
      try {
        const core = await loadCore();
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
    promptGuidelines: WIKI_GUIDELINES,
    parameters: Type.Object({
      source: Type.String({ description: "外部源文件绝对路径" }),
      ref_dir: Type.Optional(Type.String({ description: "登记目录（缺省 references）" })),
    }),
    async execute(_id, params) {
      try {
        const core = await loadCore();
        const r = await core.ingestSource(dataDir, { source: params.source, refDir: params.ref_dir }, { producer: "pi-wiki", version: "0.1.0" });
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
    promptGuidelines: WIKI_GUIDELINES,
    parameters: Type.Object({ path: Type.Optional(Type.String({ description: "目录（bundle 相对，如 tables；空=全库）" })) }),
    async execute(_id, params) {
      try {
        const core = await loadCore();
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
    promptGuidelines: WIKI_GUIDELINES,
    parameters: Type.Object({ path: Type.Optional(Type.String({ description: "目录（bundle 相对，空=根）" })) }),
    async execute(_id, params) {
      try {
        const core = await loadCore();
        const rules = await core.resolveRules(dataDir, String(params.path || ""));
        if (!rules.length) return ok("（无 AGENTS.md 规则）");
        return ok(rules.map((r: any) => `===== ${r.path} =====\n${r.content.trimEnd()}`).join("\n\n"));
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
    promptGuidelines: WIKI_GUIDELINES,
    parameters: Type.Object({ topic: Type.Optional(Type.String({ description: "主题：quickstart | files | agents | append | frontmatter | gate（缺省 quickstart）" })) }),
    async execute(_id, params) {
      try {
        const core = await loadCore();
        return ok(core.getHelp(params.topic));
      } catch (e) {
        return err(e);
      }
    },
  });
}

/**
 * Pi 扩展默认导出：注册 11 个 wiki_* 工具。
 * 数据目录可用环境变量 PI_WIKI_DATA_DIR 覆盖（默认 ~/.agents/wiki）。
 */
export default function (pi: ExtensionAPI, _ctx?: ExtensionContext): void {
  const dataDir = process.env.PI_WIKI_DATA_DIR || DEFAULT_DATA_DIR;
  registerTools(pi, dataDir);
}
