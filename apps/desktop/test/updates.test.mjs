import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createTestDirectory } from "../../../packages/storage-manager/src/index.ts";
import path from "node:path";
import { test } from "node:test";
import desktopUpdates from "../src/updates.cjs";
import clientPaths from "../src/client-paths.cjs";

const { createDesktopUpdates, resolveWindowsInstallDirectory } = desktopUpdates;

function fixture(overrides = {}) {
  const updater = new EventEmitter();
  const calls = [];
  const states = [];
  updater.checkForUpdates = async () => {
    calls.push("check");
    return { isUpdateAvailable: true, updateInfo: { version: "0.1.4" } };
  };
  updater.downloadUpdate = async () => {
    calls.push("download");
    updater.emit("download-progress", { percent: 34.9 });
    updater.emit("download-progress", { percent: 20 });
    updater.emit("download-progress", { percent: 100 });
  };
  updater.quitAndInstall = (...flags) => calls.push(flags);
  const updates = createDesktopUpdates({
    updater, currentVersion: "0.1.3", confirmInstall: async () => true, onChange: (state) => states.push(state),
    ...overrides,
  });
  return { updates, updater, calls, states };
}

test("检查更新只取版本清单，点击下载后报告进度并允许安装", async () => {
  const { updates, updater, calls, states } = fixture();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  await updates.download();
  assert.deepEqual(calls, []);

  const checked = updates.check();
  assert.strictEqual(updates.check(), checked);
  assert.equal(updates.state().phase, "checking");
  assert.deepEqual(await checked, { phase: "available", version: "0.1.4", currentVersion: "0.1.3" });
  assert.deepEqual(calls, ["check"]);

  const downloaded = updates.download();
  assert.strictEqual(updates.download(), downloaded);
  assert.equal((await updates.check()).phase, "downloading");
  assert.equal((await downloaded).phase, "ready");
  assert.deepEqual(states.filter((state) => state.phase === "downloading").map((state) => state.progress), [0, 34, 99]);
  assert.equal((await updates.install()).phase, "installing");
  assert.deepEqual(calls, ["check", "download", [true, true]]);
});

test("失败后允许重试，取消重启时保留已下载状态", async () => {
  let confirm = false;
  const { updates, updater, calls } = fixture({ confirmInstall: async () => confirm });
  const originalCheck = updater.checkForUpdates;
  updater.checkForUpdates = async () => { throw Object.assign(new Error(), { statusCode: 404 }); };
  assert.match((await updates.check()).message, /版本清单/);
  updater.checkForUpdates = originalCheck;
  await updates.check();

  const originalDownload = updater.downloadUpdate;
  updater.downloadUpdate = async () => { throw new Error("校验出错"); };
  assert.equal((await updates.download()).action, "download");
  updater.downloadUpdate = originalDownload;
  await updates.download();
  assert.equal((await updates.install()).phase, "ready");
  assert.deepEqual(calls, ["check", "download"]);

  confirm = true;
  const originalInstall = updater.quitAndInstall;
  updater.quitAndInstall = () => updater.emit("error", new Error("安装器无法启动"));
  assert.equal((await updates.install()).action, "install");
  updater.quitAndInstall = originalInstall;
  assert.equal((await updates.install()).phase, "installing");
});

test("开发模式无需访问更新源，未签名的 macOS 打开下载页面", async () => {
  const disabled = fixture({ unavailable: "开发模式不检查更新。" });
  assert.equal((await disabled.updates.check()).phase, "unavailable");
  assert.deepEqual(disabled.calls, []);

  const opened = [];
  const manual = fixture({ openInstaller: async (info) => opened.push(info.version) });
  await manual.updates.check();
  assert.deepEqual(opened, []);
  await manual.updates.download();
  assert.deepEqual(opened, ["0.1.4"]);
  assert.deepEqual(manual.calls, ["check"]);
});

test("Windows 更新在启动安装器前传入用户确认的目录，取消后保留下载", async () => {
  let selected = false;
  const { updates, updater, calls } = fixture({ confirmInstall: async () => selected });
  const destination = "D:\\Applications\\A.ai";
  updater.quitAndInstall = (...flags) => calls.push([updater.installDirectory, ...flags]);
  await updates.check();
  await updates.download();
  assert.equal((await updates.install()).phase, "ready");
  assert.deepEqual(calls, ["check", "download"]);

  selected = destination;
  assert.equal((await updates.install()).phase, "installing");
  assert.deepEqual(calls.at(-1), [destination, true, true]);
});

test("安装位置沿用现有目录或创建独立目录，拒绝写进原目录内部或占用目录", async () => {
  const fixtureRoot = createTestDirectory(clientPaths.temporaryDirectory("tests"), "aai-install-dir");
  const current = path.join(fixtureRoot, "A.ai");
  const other = path.join(fixtureRoot, "other");
  await mkdir(current);
  await mkdir(other);
  await writeFile(path.join(current, "A.ai.exe"), "当前程序");
  assert.equal(await resolveWindowsInstallDirectory(current, fixtureRoot), current);
  await assert.rejects(resolveWindowsInstallDirectory(current, current), /当前安装目录以外/);
  const target = path.join(other, "A.ai");
  assert.equal(await resolveWindowsInstallDirectory(current, other), target);
  await mkdir(target);
  assert.equal(await resolveWindowsInstallDirectory(current, other), target);
  await writeFile(path.join(target, "document.txt"), "用户的文件");
  await assert.rejects(resolveWindowsInstallDirectory(current, other), /已被占用/);
});
