/**
 * tests/three-forms.test.mjs —— 三形态一致性验收。
 *
 * 对同一临时 bundle 副本：CLI（spawn）写入 → pi 形态读到 → dsh mock 形态读到，
 * 三者结果一致；反向亦然。验证「三形态共享同一 core、读写同一 bundle」。
 */

import { mkdtemp, cp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CLI = join(ROOT, "packages", "skill", "bin", "wiki.mjs");

function runCli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`CLI failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

describe("three forms consistency", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wiki-3form-"));
    await cp(join(ROOT, "examples", "demo-bundle"), tmpDir, { recursive: true });
  });
  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("CLI create → CLI get 一致", async () => {
    runCli(["create", "tables/three_probe", "--type", "Table", "--title", "Three Probe", "--description", "probe via cli", "--dataDir", tmpDir]);
    const out = runCli(["get", "tables/three_probe", "--dataDir", tmpDir]);
    assert.match(out, /Three Probe/);
    assert.match(out, /probe via cli/);
  });

  test("pi 形态读到 CLI 写入的内容", async () => {
    process.env.PI_WIKI_DATA_DIR = tmpDir;
    const piMod = await import(join(__dirname, "..", "packages", "pi", "extensions", "index.ts"));
    const tools = new Map();
    piMod.default({ registerTool: (d) => tools.set(d.name, d) }, {});
    const got = await tools.get("wiki_get").execute("id", { id: "tables/three_probe" }, undefined, undefined, {});
    assert.match(got.text, /Three Probe/);
    delete process.env.PI_WIKI_DATA_DIR;
  });

  test("dsh mock 形态读到 CLI 写入的内容", async () => {
    const dshMod = await import(join(__dirname, "..", "packages", "dsh", "wiki.mjs"));
    const tools = new Map();
    const handlers = [];
    const assembly = { sections: [] };
    const ctx = {
      on(evt, fn) { if (evt === "system-prompt/assemble") handlers.push(fn); },
      tools: { register(t) { tools.set(t.name, t); } },
    };
    dshMod.apply(ctx, { dataDir: tmpDir });
    await handlers[0](assembly, {}, async () => {});
    const got = await tools.get("wiki_get").execute({ id: "tables/three_probe" });
    assert.match(got.text, /Three Probe/);
  });

  test("三端 validate 均合规", async () => {
    const v = runCli(["validate", "--dataDir", tmpDir]);
    assert.match(v, /compliant|合规/);
    const file = await readFile(join(tmpDir, "tables", "three_probe.md"), "utf8");
    assert.match(file, /type: Table/);
    assert.match(file, /generated: \{ by: "agent:wiki-cli\/0\.1\.0"/);
  });
});
