/**
 * tests/git-sync.test.mjs —— 在线知识库（Git 远端同步）验收。
 *
 * 用临时 bare 仓库当 origin，两个 clone 模拟两台机器：
 *   顺序写 / 并发 log / index 计数冲突 / 概念冲突 / 错误路径。
 * 无 git 可执行文件时整体 skip（并打印原因）。
 */

import { mkdtemp, cp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";

import * as core from "../packages/core/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEMO = join(ROOT, "examples", "demo-bundle");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function exists(p) {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

const gitOk = (await core.gitAvailable()).ok;
const skip = gitOk ? false : "本机无 git 可执行文件，跳过同步验收";

describe("git remote sync (在线知识库)", { skip }, () => {
  let tmp;
  let origin;
  let A;
  let B;
  let prevRegEnv;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wiki-git-"));
    origin = join(tmp, "origin.git");
    execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "ignore" });

    prevRegEnv = process.env.WIKI_REGISTRY_FILE;
    process.env.WIKI_REGISTRY_FILE = join(tmp, "registry.json");

    A = join(tmp, "A");
    await cp(DEMO, A, { recursive: true });
  });

  after(async () => {
    if (prevRegEnv === undefined) delete process.env.WIKI_REGISTRY_FILE;
    else process.env.WIKI_REGISTRY_FILE = prevRegEnv;
    await rm(tmp, { recursive: true, force: true });
  });

  test("init --remote：首个提交 + push -u + 注册命名 bundle", async () => {
    const r = await core.gitInit(A, { remote: origin, branch: "main", name: "probe", use: false });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.pushed, true);
    assert.equal(r.registered, "probe");

    const reg = JSON.parse(await readFile(process.env.WIKI_REGISTRY_FILE, "utf8"));
    assert.equal(reg.bundles.probe, A);

    // 最小 .gitignore 只在缺失时创建，且不覆盖已有
    assert.match(await readFile(join(A, ".gitignore"), "utf8"), /\.DS_Store/);
    await writeFile(join(A, ".gitignore"), "# mine\n");
    await core.gitInit(A, { remote: origin, branch: "main" });
    assert.equal(await readFile(join(A, ".gitignore"), "utf8"), "# mine\n");
  });

  test("clone 到第二台机器并注册 bundle", async () => {
    B = join(tmp, "B");
    const r = await core.gitClone(origin, B, { name: "probe-b" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.registered, "probe-b");

    // 目标目录非空 → 拒绝
    const again = await core.gitClone(origin, B, {});
    assert.equal(again.ok, false);
    assert.match(again.error, /已存在且非空/);
  });

  test("A 写入 → sync → B sync 后看到；再反向一轮，双方概念齐全", async () => {
    await core.createConcept(A, { id: "tables/probe_a", type: "Table", title: "Probe A", description: "a", body: "# Schema\n", opts: { producer: "git-sync-test" } });
    const s1 = await core.gitSync(A, { message: "A: add probe_a" });
    assert.equal(s1.ok, true, JSON.stringify(s1));
    assert.equal(s1.pushed, true);

    const s2 = await core.gitSync(B, {});
    assert.equal(s2.ok, true, JSON.stringify(s2));
    assert.equal(await exists(join(B, "tables/probe_a.md")), true);

    await core.createConcept(B, { id: "tables/probe_b", type: "Table", title: "Probe B", description: "b", body: "# Schema\n", opts: { producer: "git-sync-test" } });
    const s3 = await core.gitSync(B, { message: "B: add probe_b" });
    assert.equal(s3.ok, true, JSON.stringify(s3));

    const s4 = await core.gitSync(A, {});
    assert.equal(s4.ok, true, JSON.stringify(s4));
    assert.equal(await exists(join(A, "tables/probe_b.md")), true);

    // index 与目录树一致（新概念进了目录 index）
    const idx = await readFile(join(A, "tables", "index.md"), "utf8");
    assert.match(idx, /Probe B/);
    assert.match(idx, /Probe A/);

    const v = await core.validateBundle(A);
    assert.equal(v.ok, true, JSON.stringify(v.errors));
  });

  test("同日期并发追加 log：并集合并、无冲突标记、双方条目都在", async () => {
    const log = await readFile(join(A, "log.md"), "utf8");
    assert.equal(/<<<<<<<|>>>>>>>|=======/.test(log), false, "log.md 不应残留冲突标记");
    // 两个 probe 的 Creation 条目（appendLog 由 createConcept 写入）都在
    assert.match(log, /probe_a/i, log.slice(-400));
    assert.match(log, /probe_b/i, log.slice(-400));
  });

  test("同目录各加概念（根 index 计数行冲突）→ 自动解决", async () => {
    // A 与 B 同时往同一个子目录各加一个概念：根/目录 index 的计数行必然冲突
    await core.createConcept(A, { id: "tables/probe_c", type: "Table", title: "Probe C", description: "c", body: "# Schema\n", opts: { producer: "git-sync-test" } });
    const a = await core.gitSync(A, { message: "A: add probe_c" });
    assert.equal(a.ok, true, JSON.stringify(a));

    await core.createConcept(B, { id: "tables/probe_d", type: "Table", title: "Probe D", description: "d", body: "# Schema\n", opts: { producer: "git-sync-test" } });
    const b = await core.gitSync(B, { message: "B: add probe_d" });
    assert.equal(b.ok, true, JSON.stringify(b));

    const a2 = await core.gitSync(A, {});
    assert.equal(a2.ok, true, JSON.stringify(a2));
    assert.equal(a2.merged, true);
    assert.equal(await exists(join(A, "tables/probe_d.md")), true);

    const idx = await readFile(join(A, "tables", "index.md"), "utf8");
    assert.match(idx, /Probe C/);
    assert.match(idx, /Probe D/);
    assert.equal(/<<<<<<<|>>>>>>>/.test(idx), false);
  });

  test("同一概念双写 → 停止同步、报冲突清单、工作区不被破坏", async () => {
    await writeFile(join(A, "tables", "probe_a.md"), "---\ntype: Table\ntitle: A 版本\n---\n\nA\n");
    assert.equal((await core.gitSync(A, { message: "A: edit probe_a" })).ok, true);

    await writeFile(join(B, "tables", "probe_a.md"), "---\ntype: Table\ntitle: B 版本\n---\n\nB\n");
    const r = await core.gitSync(B, { message: "B: edit probe_a" });
    assert.equal(r.ok, false);
    assert.equal(r.step, "merge");
    assert.deepEqual(r.conflicts, ["tables/probe_a.md"]);
    assert.match(r.next, /人工/);

    // 工作区干净、无冲突标记、本地提交保留
    assert.equal(git(["status", "--porcelain"], B).trim(), "");
    const content = await readFile(join(B, "tables", "probe_a.md"), "utf8");
    assert.match(content, /B 版本/);
    assert.equal(/<<<<<<<|>>>>>>>/.test(content), false);
    assert.match(git(["log", "-1", "--format=%s"], B), /B: edit probe_a/);
    // 远端未被这次失败污染
    const remoteTip = git(["--git-dir", origin, "log", "-1", "--format=%s", "main"]);
    assert.match(remoteTip, /A: edit probe_a/);
  });

  test("status：非仓库/仓库子目录/无 git 都给可执行指引", async () => {
    const notRepo = await core.gitStatus(join(tmp, "nope"));
    assert.equal(notRepo.ok, false);
    assert.match(notRepo.next, /init|clone/);

    // bundle 位于更大仓库的子目录 → 拒绝（避免误提交他处文件）
    const big = join(tmp, "bigrepo");
    await mkdir(join(big, "wiki"), { recursive: true });
    await cp(DEMO, join(big, "wiki"), { recursive: true });
    git(["init", "-b", "main"], big);
    const guarded = await core.gitStatus(join(big, "wiki"));
    assert.equal(guarded.ok, false);
    assert.equal(guarded.step, "guard");
    assert.match(guarded.next, /独立仓库|顶层/);

    // git 不可用
    const prev = process.env.WIKI_GIT_BIN;
    process.env.WIKI_GIT_BIN = "/nonexistent/git-bin";
    try {
      const r = await core.gitStatus(A);
      assert.equal(r.ok, false);
      assert.match(r.error, /未找到可执行的 git/);
    } finally {
      if (prev === undefined) delete process.env.WIKI_GIT_BIN;
      else process.env.WIKI_GIT_BIN = prev;
    }
  });

  test("sync 失败路径：无远端仓库给配置指引", async () => {
    const solo = join(tmp, "solo");
    await cp(DEMO, solo, { recursive: true });
    const init = await core.gitInit(solo, { branch: "main", push: false });
    assert.equal(init.ok, true, JSON.stringify(init));
    const r = await core.gitSync(solo, {});
    assert.equal(r.ok, false);
    assert.equal(r.step, "remote");
    assert.match(r.next, /remote add|init/);
  });
});
