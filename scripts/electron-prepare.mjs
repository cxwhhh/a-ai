/**
 * 打包桌面版前的准备（npm run dist:win / dist:mac 会先跑 next build，再跑这个脚本）：
 *   1. 把 .next/static 和 public 拷进 .next/standalone（standalone 不带这两样，和 Dockerfile 里的 COPY 一样）
 *   2. 用 esbuild 把 electron/main.cjs 和 electron-updater 打成一个文件 dist-electron/main.cjs
 *      这样安装包里不用带 node_modules：Next 服务器自己的依赖已经在 standalone/node_modules 里了
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const standalone = path.join(root, ".next", "standalone");
if (!fs.existsSync(path.join(standalone, "server.js"))) {
  console.error("找不到 .next/standalone/server.js，先运行 npm run build（next.config.ts 要有 output: \"standalone\"）");
  process.exit(1);
}

const copy = (from, to) => {
  if (!fs.existsSync(from)) return;
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
};
copy(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"));
copy(path.join(root, "public"), path.join(standalone, "public"));
// 开发时的数据目录可能被 next build 追踪进来，别把自己的聊天记录打进安装包
fs.rmSync(path.join(standalone, ".data"), { recursive: true, force: true });

const out = path.join(root, "dist-electron");
fs.rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, "electron", "main.cjs")],
  outfile: path.join(out, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  logLevel: "warning",
});
fs.copyFileSync(path.join(root, "electron", "splash.html"), path.join(out, "splash.html"));
console.log("桌面版准备完成：.next/standalone + dist-electron/");
