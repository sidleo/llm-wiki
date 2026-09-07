/**
 * pi-wiki mock 测试：捕获 registerTool 注册的工具并对临时 demo bundle 执行。
 * 用 node --experimental-strip-types 运行，不触碰真实知识库。
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 捕获工具注册
function mockPi() {
  const tools = new Map();
  return {
    tools,
    api: {
      registerTool(def) {
        tools.set(def.name, def);
      },
    },
  };
}

describe("pi-wiki extension", () => {
  let tmpDir;
  let registered;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pi-wiki-"));
    await cp(join(__dirname, "..", "..", "..", "examples", "demo-bundle"), tmpDir, { recursive: true });
    process.env.PI_WIKI_DATA_DIR = tmpDir;

    const extMod = await import(join(__dirname, "..", "extensions", "index.ts"));
    const mocked = mockPi();
    registered = mocked.tools;
    extMod.default(mocked.api, {});
  });

  after(async () => {
    delete process.env.PI_WIKI_DATA_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  const tool = (name) => registered.get(name);
  const run = async (name, params) => {
    const t = tool(name);
    assert.ok(t, `工具 ${name} 已注册`);
    return t.execute("id", params || {}, undefined, undefined, {});
  };

  test("注册 10 个 wiki_* 工具", () => {
    const expected = ["wiki_list", "wiki_search", "wiki_get", "wiki_create", "wiki_update", "wiki_validate", "wiki_lint", "wiki_ingest", "wiki_deprecate", "wiki_rules", "wiki_help"];
    for (const n of expected) assert.ok(registered.has(n), `缺少 ${n}`);
    assert.equal(registered.size, 11);
  });

  test("wiki_validate 合规", async () => {
    const r = await run("wiki_validate");
    assert.match(r.text, /OKF v0\.2 合规/);
  });

  test("wiki_list 列概念", async () => {
    const r = await run("wiki_list");
    assert.match(r.text, /tables\/orders/);
    assert.match(r.text, /computations\/revenue/);
  });

  test("wiki_get 附 backlinks 坑点", async () => {
    const r = await run("wiki_get", { id: "tables/orders" });
    assert.match(r.text, /pitfalls\/join-inflation/);
    assert.match(r.text, /pitfalls\/stat-flag-duplication/);
  });

  test("wiki_search 中文命中坑点", async () => {
    const r = await run("wiki_search", { query: "销售额" });
    assert.match(r.text, /pitfalls\/join-inflation/);
  });

  test("wiki_rules 向上遍历", async () => {
    const r = await run("wiki_rules", { path: "references/attesters" });
    assert.match(r.text, /AGENTS\.md/);
    assert.match(r.text, /references\/AGENTS\.md/);
  });

  test("无门控声明时默认自动记录", async () => {
    const r = await run("wiki_create", {
      path: "computations/rev-auto", type: "Attested Computation", title: "p", description: "d",
    });
    assert.match(r.text, /已创建/);
  });

  test("带门控节的 AGENTS.md 拦截未确认口径写入", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tmpDir, "AGENTS.md"), "# 根规则\n\n## 门控\n\n- 需 human 确认: Metric, Attested Computation\n", "utf8");
    const r = await run("wiki_create", {
      path: "computations/rev-probe", type: "Attested Computation", title: "p", description: "d",
    });
    assert.match(r.text, /需用户确认|human 确认/);
  });

  test("create + update confirmed 写 verified", async () => {
    const c = await run("wiki_create", {
      path: "tables/probe", type: "Table", title: "probe", description: "p", confirmed: true, user: "zhang3",
    });
    assert.match(c.text, /已创建/);
    const f = await readFile(join(tmpDir, "tables", "probe.md"), "utf8");
    assert.match(f, /verified/);
    assert.match(f, /human:zhang3/);

    const u = await run("wiki_update", { id: "tables/probe", description: "updated desc", confirmed: true, user: "zhang3" });
    assert.match(u.text, /已更新/);
  });

  test("wiki_lint 无断链", async () => {
    const r = await run("wiki_lint");
    assert.match(r.text, /"broken":0/);
  });

  test("wiki_help 返回机制文档", async () => {
    const r = await run("wiki_help", { topic: "append" });
    assert.match(r.text, /APPEND_SYSTEM_PROMPT/);
    const q = await run("wiki_help", {});
    assert.match(q.text, /quickstart|快速上手/);
  });
});
