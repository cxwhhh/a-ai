const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WINDOWS_CLIENT_FOLDER = "A.ai";
const WINDOWS_UPDATE_FOLDER = "updates";

/** 与 electron-updater 的 Windows 缓存根一致。 */
function windowsLocalAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

/** Windows 的项目测试和打包暂存归入同一个客户端目录。其他系统沿用原来的临时目录。 */
function temporaryDirectory(group) {
  if (process.platform !== "win32") return os.tmpdir();
  const directory = path.join(windowsLocalAppData(), WINDOWS_CLIENT_FOLDER, group);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

module.exports = { WINDOWS_CLIENT_FOLDER, WINDOWS_UPDATE_FOLDER, windowsLocalAppData, temporaryDirectory };
