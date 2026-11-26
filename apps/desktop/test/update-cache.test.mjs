import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createTestDirectory } from "../../../packages/storage-manager/src/index.ts";
import path from "node:path";
import { test } from "node:test";
import clientPaths from "../src/client-paths.cjs";
import updateCache from "../src/update-cache.cjs";

const { cleanInstalledWindowsUpdate, prepareWindowsUpdateCache } = updateCache;

function fixture() {
  return createTestDirectory(clientPaths.temporaryDirectory("tests"), "aai-updater-cache");
}

async function download(directory, version, content) {
  const pending = path.join(directory, "pending");
  const name = `A.ai-Setup-${version}.exe`;
  await mkdir(pending, { recursive: true });
  await writeFile(path.join(pending, name), content);
  await writeFile(path.join(pending, "update-info.json"), JSON.stringify({
    fileName: name, sha512: createHash("sha512").update(content).digest("base64"),
  }));
  await writeFile(path.join(pending, "current.blockmap"), `blockmap-${version}`);
  return path.join(pending, name);
}

test("新版成功启动后，删除下载副本并保留相同的差分基线", async () => {
  const root = fixture();
  const pending = await download(root, "0.1.8", "installer-0.1.8");
  await writeFile(path.join(root, "installer.exe"), "installer-0.1.8");
  await writeFile(path.join(root, "pending", "unrelated.txt"), "保留其他文件");
  assert.equal(await cleanInstalledWindowsUpdate(root, "0.1.8"), true);
  await assert.rejects(readFile(pending), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, "installer.exe"), "utf8"), "installer-0.1.8");
  assert.equal(await readFile(path.join(root, "current.blockmap"), "utf8"), "blockmap-0.1.8");
  assert.equal(await readFile(path.join(root, "pending", "unrelated.txt"), "utf8"), "保留其他文件");
  assert.equal(await cleanInstalledWindowsUpdate(root, "0.1.8"), false);
});

test("尚未安装或安装基线不匹配时保留下载", async () => {
  const root = fixture();
  const pending = await download(root, "0.1.9", "installer-0.1.9");
  await writeFile(path.join(root, "installer.exe"), "installer-0.1.8");
  assert.equal(await cleanInstalledWindowsUpdate(root, "0.1.8"), false);
  assert.equal(await cleanInstalledWindowsUpdate(root, "0.1.9"), false);
  assert.equal(await readFile(pending, "utf8"), "installer-0.1.9");
});

test("手动安装较新正式版后清理旧下载，旧索引不会覆盖当前索引", async () => {
  const root = fixture();
  const pending = await download(root, "0.1.9", "installer-0.1.9");
  await writeFile(path.join(root, "installer.exe"), "installer-0.1.10");
  await writeFile(path.join(root, "current.blockmap"), "blockmap-0.1.10");
  assert.equal(await cleanInstalledWindowsUpdate(root, "0.1.10"), true);
  await assert.rejects(readFile(pending), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, "current.blockmap"), "utf8"), "blockmap-0.1.10");
});

test("从旧版升级后迁移差分索引并清除旧更新目录中的重复文件", async () => {
  const root = fixture();
  const legacy = path.join(root, "a-ai-updater");
  const current = path.join(root, "A.ai", "updates");
  await download(legacy, "0.1.9", "installer-0.1.9");
  await writeFile(path.join(legacy, "installer.exe"), "installer-0.1.8");
  await mkdir(current, { recursive: true });
  await writeFile(path.join(current, "installer.exe"), "installer-0.1.9");
  await prepareWindowsUpdateCache(root, "0.1.9");
  assert.equal(await readFile(path.join(current, "installer.exe"), "utf8"), "installer-0.1.9");
  assert.equal(await readFile(path.join(current, "current.blockmap"), "utf8"), "blockmap-0.1.9");
  await assert.rejects(realpath(legacy), { code: "ENOENT" });
});

test("旧目录中更高版本的安装包会迁入集中缓存，仍可用于下一次更新", async () => {
  const root = fixture();
  const legacy = path.join(root, "a-ai-updater");
  const current = path.join(root, "A.ai", "updates");
  await download(legacy, "0.1.10", "installer-0.1.10");
  await mkdir(current, { recursive: true });
  await writeFile(path.join(current, "installer.exe"), "installer-0.1.9");
  await prepareWindowsUpdateCache(root, "0.1.9");
  assert.equal(await readFile(path.join(current, "pending", "A.ai-Setup-0.1.10.exe"), "utf8"), "installer-0.1.10");
  await assert.rejects(realpath(legacy), { code: "ENOENT" });
});
