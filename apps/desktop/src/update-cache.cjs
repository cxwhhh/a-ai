const { createHash } = require("node:crypto");
const { createReadStream, promises: fs, constants } = require("node:fs");
const path = require("node:path");
const { WINDOWS_CLIENT_FOLDER, WINDOWS_UPDATE_FOLDER } = require("./client-paths.cjs");

const INSTALLER = "installer.exe";
const BLOCKMAP = "current.blockmap";
const UPDATE_INFO = "update-info.json";

async function fileInfo(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function sha512(file) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("base64");
}

async function removeFile(file) {
  if ((await fileInfo(file))?.isFile()) await fs.unlink(file);
}

async function removeEmpty(directory) {
  try { await fs.rmdir(directory); }
  catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; }
}

function isOlderStableVersion(version, installedVersion) {
  const stable = /^\d+\.\d+\.\d+$/;
  if (!stable.test(version) || !stable.test(installedVersion)) return false;
  const installedParts = installedVersion.split(".").map(Number);
  const difference = version.split(".").map((part, index) => Number(part) - installedParts[index]).find((part) => part !== 0);
  return (difference ?? 0) < 0;
}

/** 校验运行中的安装和下载副本。手动升级时，已经落后的正式版下载也可以清理。 */
async function cleanInstalledWindowsUpdate(cache, version, installedCache = cache) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) return false;
  if (!(await fileInfo(cache))?.isDirectory() || !(await fileInfo(installedCache))?.isDirectory()) return false;
  const pending = path.join(cache, "pending");
  if (!(await fileInfo(pending))?.isDirectory()) return false;

  const infoPath = path.join(pending, UPDATE_INFO);
  const installed = path.join(installedCache, INSTALLER);
  const [info, installedFile] = await Promise.all([fileInfo(infoPath), fileInfo(installed)]);
  if (!info?.isFile() || info.size > 4096 || !installedFile?.isFile()) return false;
  let update;
  try { update = JSON.parse(await fs.readFile(infoPath, "utf8")); }
  catch (error) { if (error instanceof SyntaxError) return false; throw error; }
  if (typeof update?.fileName !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(update.sha512 ?? "")) return false;
  const downloadedVersion = /^A\.ai-Setup-(\d+\.\d+\.\d+(?:-[\w.-]+)?)\.exe$/.exec(update.fileName)?.[1];
  if (!downloadedVersion) return false;
  const sameVersion = downloadedVersion === version;
  if (!sameVersion && !isOlderStableVersion(downloadedVersion, version)) return false;
  const download = path.join(pending, update.fileName);
  const downloadedFile = await fileInfo(download);
  if (!downloadedFile?.isFile() || (sameVersion && downloadedFile.size !== installedFile.size)) return false;
  const hashes = await Promise.all([sha512(download), ...(sameVersion ? [sha512(installed)] : [])]);
  if (hashes.some((hash) => hash !== update.sha512)) return false;

  const pendingMap = path.join(pending, BLOCKMAP);
  if (sameVersion && (await fileInfo(pendingMap))?.isFile()) {
    // 旧客户端下载新版时仍写入旧目录，把新版差分索引同步至新基线目录。
    await fs.copyFile(pendingMap, path.join(installedCache, BLOCKMAP), constants.COPYFILE_EXCL).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  await fs.unlink(download);
  await removeFile(pendingMap);
  await fs.unlink(infoPath);
  await removeEmpty(pending);
  return true;
}

/** Windows 新版启动后归并旧缓存。旧版尚未安装的下载可直接交给新更新器复用。 */
async function prepareWindowsUpdateCache(localAppData, version) {
  const root = path.join(localAppData, WINDOWS_CLIENT_FOLDER);
  const current = path.join(root, WINDOWS_UPDATE_FOLDER);
  const legacy = path.join(localAppData, "a-ai-updater");
  if (!(await fileInfo(root))?.isDirectory() || !(await fileInfo(current))?.isDirectory()) return;
  if (!(await fileInfo(path.join(current, INSTALLER)))?.isFile()) return;

  await cleanInstalledWindowsUpdate(current, version);
  if (!(await fileInfo(legacy))?.isDirectory()) return;
  await cleanInstalledWindowsUpdate(legacy, version, current);
  const legacyPending = path.join(legacy, "pending");
  const currentPending = path.join(current, "pending");
  if ((await fileInfo(legacyPending))?.isDirectory() && !(await fileInfo(currentPending))) {
    await fs.rename(legacyPending, currentPending);
  }
  // 新版安装器已经在集中目录写入基线，旧目录中的基线及索引可以退出。
  await removeFile(path.join(legacy, INSTALLER));
  await removeFile(path.join(legacy, BLOCKMAP));
  if ((await fs.readdir(legacy)).length === 0) await removeEmpty(legacy);
  else if (!(await fileInfo(path.join(current, "legacy")))) await fs.rename(legacy, path.join(current, "legacy"));
}

module.exports = { cleanInstalledWindowsUpdate, prepareWindowsUpdateCache };
