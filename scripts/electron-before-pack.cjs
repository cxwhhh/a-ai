const path = require("node:path");
const { WINDOWS_CLIENT_FOLDER, WINDOWS_UPDATE_FOLDER } = require("../apps/desktop/src/client-paths.cjs");

module.exports = function beforePack(context) {
  if (context.electronPlatformName !== "win32") return;
  // 同一个 AppInfo 同时生成 app-update.yml 和 NSIS 的安装包基线位置，两者必须相同。
  Object.defineProperty(context.packager.appInfo, "updaterCacheDirName", {
    value: path.win32.join(WINDOWS_CLIENT_FOLDER, WINDOWS_UPDATE_FOLDER),
    configurable: true,
  });
};
