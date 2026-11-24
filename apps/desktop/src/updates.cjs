const { promises: fs } = require("node:fs");
const path = require("node:path");

/** 更新会先移除旧程序。新位置放在独立的 A.ai 目录，避免写入其他软件或原安装目录的子目录。 */
async function resolveWindowsInstallDirectory(currentDirectory, parentDirectory) {
  const [current, parent] = await Promise.all([fs.realpath(currentDirectory), fs.realpath(parentDirectory)]);
  const destination = path.join(parent, "A.ai");
  const relative = path.relative(current, destination);
  if (!relative) return current;
  if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) {
    throw new Error("请选择当前安装目录以外的文件夹。");
  }
  try {
    const stat = await fs.lstat(destination);
    if (!stat.isDirectory() || (await fs.readdir(destination)).length > 0) {
      throw new Error("目标位置的 A.ai 文件夹已被占用，请选择其他位置。");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return destination;
}

/** 主进程保存更新状态。窗口切换或刷新后，新的页面可以继续显示同一次下载。 */
function createDesktopUpdates({ updater, currentVersion, unavailable, openInstaller, confirmInstall, onChange }) {
  let current = unavailable
    ? { phase: "unavailable", currentVersion, message: unavailable }
    : { phase: "idle", currentVersion };
  let candidate;
  let checkTask;
  let downloadTask;
  let installTask;

  function publish(next) {
    current = { ...next, currentVersion };
    onChange(current);
    return current;
  }

  function failed(action, error) {
    const message = action === "check"
      ? (error?.statusCode === 404 ? "更新源找不到版本清单。" : "无法检查更新，请确认能连接到更新服务器。")
      : action === "download"
        ? "更新下载或校验失败，请重试。"
        : "无法启动更新安装，请重试。";
    return publish({ phase: "error", action, message, version: candidate?.version });
  }

  if (!unavailable) {
    // 检查只读版本清单，点击下载后才取安装包。完成后由用户选择安装时机。
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.on("download-progress", ({ percent }) => {
      if (current.phase !== "downloading" || !Number.isFinite(percent)) return;
      const progress = Math.min(99, Math.floor(percent));
      if (progress > current.progress) publish({ ...current, progress });
    });
    updater.on("error", (error) => {
      // 检查和下载的错误会由对应 Promise 返回，安装错误通过事件返回。
      if (current.phase === "installing") failed("install", error);
    });
  }

  function check() {
    if (checkTask) return checkTask;
    if (unavailable || downloadTask || installTask || current.phase === "ready" ||
        current.phase === "installing" || current.action === "install") return Promise.resolve(current);
    publish({ phase: "checking" });
    checkTask = Promise.resolve().then(() => updater.checkForUpdates()).then((result) => {
      if (!result) return failed("check");
      candidate = result.isUpdateAvailable ? result.updateInfo : undefined;
      return candidate ? publish({ phase: "available", version: candidate.version }) : publish({ phase: "current" });
    }).catch((error) => failed("check", error)).finally(() => { checkTask = undefined; });
    return checkTask;
  }

  function download() {
    if (downloadTask) return downloadTask;
    if (!candidate || (current.phase !== "available" && current.action !== "download")) return Promise.resolve(current);
    const update = candidate;
    publish({ phase: "downloading", version: update.version, progress: 0 });
    downloadTask = Promise.resolve().then(async () => {
      if (openInstaller) {
        await openInstaller(update);
        return publish({ phase: "available", version: update.version });
      }
      // electron-updater 校验安装包，并保留路径供 quitAndInstall 使用。
      await updater.downloadUpdate();
      return publish({ phase: "ready", version: update.version });
    }).catch((error) => failed("download", error)).finally(() => { downloadTask = undefined; });
    return downloadTask;
  }

  function install() {
    if (installTask) return installTask;
    if (!candidate || (current.phase !== "ready" && current.action !== "install")) return Promise.resolve(current);
    const { version } = candidate;
    installTask = Promise.resolve().then(async () => {
      const destination = await confirmInstall(version);
      if (destination) {
        // Windows 确认后返回安装路径，NSIS 的 /D 参数会覆盖旧安装位置或默认目录。
        if (typeof destination === "string") updater.installDirectory = destination;
        publish({ phase: "installing", version });
        updater.quitAndInstall(true, true);
      }
      return current;
    }).catch((error) => failed("install", error)).finally(() => { installTask = undefined; });
    return installTask;
  }

  return { state: () => current, check, download, install };
}

module.exports = { createDesktopUpdates, resolveWindowsInstallDirectory };
