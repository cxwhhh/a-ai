import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTestDirectory, currentRunScope, failedFixtureRetention, publishRunFiles, StorageManager } from "../src/index.ts";

const root = createTestDirectory(os.tmpdir(), "storage-manager-tests");

test("失败现场按 TTL 回收，已固定的基线和活动测试保留", async () => {
  let clock = Date.now();
  const manager = new StorageManager(path.join(root, "retention"), () => clock);
  const active = manager.create("test", "fixture");
  const success = manager.create("evaluation", "eval");
  success.finish();
  assert.ok(!existsSync(success.directory));
  const failed = manager.create("evaluation", "eval");
  failed.finish({ retainMs: failedFixtureRetention });
  const baseline = manager.create("report", "eval");
  baseline.finish({ retainMs: Infinity, pinned: true });
  clock++;
  for (let i = 0; i < 2; i++) {
    manager.create("report", "eval").finish({ retainMs: Infinity });
    clock++;
  }
  manager.trimReports("eval", 1);
  clock += failedFixtureRetention;
  manager.sweep();
  assert.ok(existsSync(baseline.directory));
  assert.ok(existsSync(active.directory));
  assert.ok(!existsSync(failed.directory));
  assert.equal(manager.retained("report", "eval").length, 2);
  assert.equal((await manager.usage("visitor", false)).report.count, 0);
  active.finish();
});

test("node:test 的失败夹具跨进程保留，成功夹具回收", () => {
  const managerRoot = path.join(root, "subprocess");
  const entry = new URL("../src/index.ts", import.meta.url).href;
  const script = path.join(root, "child.test.mjs");
  writeFileSync(script, `import { test } from 'node:test';
    import { createTestDirectory } from ${JSON.stringify(entry)};
    createTestDirectory('.', 'child');
    test('child', () => { if (process.env.AAI_FAIL_FIXTURE === '1') throw new Error('expected failure'); });`);
  const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
  const run = (fail) => spawnSync(process.execPath, ["--experimental-strip-types", "--test", script], {
    env: { ...environment, A_TEST_STORAGE_DIR: managerRoot, AAI_FAIL_FIXTURE: fail ? "1" : "0" }, encoding: "utf8", timeout: 10_000,
  });
  const success = run(false);
  assert.equal(success.status, 0, success.stderr || success.stdout);
  const manager = new StorageManager(managerRoot);
  assert.equal(manager.retained("test").length, 0);
  const failed = run(true);
  assert.equal(failed.status, 1, failed.stderr || failed.stdout);
  assert.equal(manager.retained("test").length, 1);
});

test("运行作用域独立，失败时照常释放，显式交付的文件可用", async () => {
  const manager = new StorageManager(path.join(root, "run"));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  manager.setRunLimit(128);
  let destroyed = false;
  let scopePath;
  await assert.rejects(manager.withRun("owner", async () => {
    const scope = currentRunScope();
    assert.equal(scope.limitMiB, 128);
    scopePath = scope.directory;
    scope.onClose(async () => { destroyed = true; });
    const stage = path.join(scope.directory, "stage");
    mkdirSync(stage);
    writeFileSync(path.join(stage, "交付.txt"), "唯一需要保存的文件");
    assert.throws(() => publishRunFiles(scope, workspace, stage, ["../越界.txt"]), /无效/);
    const [output] = publishRunFiles(scope, workspace, stage, ["交付.txt"]);
    assert.equal(readFileSync(path.join(workspace, output), "utf8"), "唯一需要保存的文件");
    throw new Error("模拟失败");
  }), /模拟失败/);
  assert.equal(destroyed, true);
  assert.ok(!existsSync(scopePath));
  assert.equal(currentRunScope(), undefined);
});

test("缓存配额按最近使用时间回收且不影响其他账号", async () => {
  let clock = Date.now();
  const manager = new StorageManager(path.join(root, "cache"), () => clock);
  const make = (owner) => {
    clock++;
    const scope = manager.create("cache", owner);
    writeFileSync(path.join(scope.directory, "data"), "12345");
    scope.finish({ retainMs: failedFixtureRetention });
    return scope;
  };
  const old = make("one");
  const recent = make("one");
  const other = make("two");
  manager.touch(old.id, "one");
  assert.equal(await manager.trimCache("one", 5), 5);
  assert.ok(existsSync(old.directory));
  assert.ok(!existsSync(recent.directory));
  assert.ok(existsSync(other.directory));
});
