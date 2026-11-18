/**
 * electron-builder 的 afterPack 钩子：程序文件拷好、还没做成安装包（也还没签名）时调用。
 * 把自研服务、Vite 产物和生产依赖拷到安装目录的 resources/server：
 *   Windows：…\A.ai\resources\server      macOS：A.ai.app/Contents/Resources/server
 * 主进程从 process.resourcesPath/server 启动 server.mjs。
 */
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(ctx) {
  const from = path.join(ctx.packager.projectDir, "dist", "server");
  if (!process.env.A_AI_SERVER_DEPLOY_DIR) throw new Error("未准备桌面服务的生产依赖");
  const dependencies = path.join(process.env.A_AI_SERVER_DEPLOY_DIR, "node_modules");
  const resources =
    ctx.electronPlatformName === "darwin"
      ? path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(ctx.appOutDir, "resources");
  const to = path.join(resources, "server");
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  fs.cpSync(dependencies, path.join(to, "node_modules"), { recursive: true, verbatimSymlinks: true });
  console.log(`  • A.ai 服务器已拷贝  to=${to}`);
};
