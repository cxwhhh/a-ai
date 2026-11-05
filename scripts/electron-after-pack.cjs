/**
 * electron-builder 的 afterPack 钩子：程序文件拷好、还没做成安装包（也还没签名）时调用。
 * 把 .next/standalone 原样拷到安装目录的 resources/server：
 *   Windows：…\A.ai\resources\server      macOS：A.ai.app/Contents/Resources/server
 * 主进程（electron/main.cjs）从 process.resourcesPath/server 启动 server.js。
 */
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(ctx) {
  const from = path.join(ctx.packager.projectDir, ".next", "standalone");
  const resources =
    ctx.electronPlatformName === "darwin"
      ? path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(ctx.appOutDir, "resources");
  const to = path.join(resources, "server");
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  console.log(`  • A.ai 服务器已拷贝  to=${to}`);
};
