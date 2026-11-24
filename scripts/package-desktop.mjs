import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import clientPaths from "../apps/desktop/src/client-paths.cjs";

const require = createRequire(import.meta.url);
const manager = process.env.npm_execpath;
if (!manager || !path.basename(manager).includes("pnpm")) throw new Error("请通过 pnpm dist:win 或 pnpm dist:mac 打包");
const target = process.argv[2];
if (target !== "--win" && target !== "--mac") throw new Error("缺少桌面构建目标");
const buildRoot = realpathSync(clientPaths.temporaryDirectory("build"));
const staged = mkdtempSync(path.join(buildRoot, "aai-desktop-runtime-"));
const dependencies = path.join(staged, "runtime");
const buildEnv = { ...process.env };

function run(file, args, env) {
  const result = spawnSync(process.execPath, [file, ...args], { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(file)} 构建失败，退出码 ${result.status}`);
}

try {
  if (process.platform === "win32") {
    // 仅本次打包的子进程使用集中暂存目录，安装包的输出路径仍由 electron-builder 配置。
    const scratch = path.join(staged, "temp");
    mkdirSync(scratch);
    Object.assign(buildEnv, { TEMP: scratch, TMP: scratch });
  }
  // Windows 默认的 pnpm 依赖是绝对 junction。安装包需要真实目录，才能拷到另一台机器直接启动。
  run(manager, ["--config.node-linker=hoisted", "--filter", "@a-ai/server", "deploy", "--prod", "--legacy", dependencies], {
    ...buildEnv, pnpm_config_verify_deps_before_run: "false",
  });
  // 下载受限的构建机可以传入经过校验的本地 Electron 压缩包。
  const runtime = process.env.A_ELECTRON_DIST;
  const config = runtime ? [`--config.electronDist=${path.resolve(runtime)}`] : [];
  run(require.resolve("electron-builder/cli.js"), [target, "--publish", "never", ...config], { ...buildEnv, A_AI_SERVER_DEPLOY_DIR: dependencies });
} finally {
  const resolved = realpathSync(staged);
  if (path.dirname(resolved) === buildRoot) rmSync(resolved, { recursive: true, force: true });
}
