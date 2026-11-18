import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const manager = process.env.npm_execpath;
if (!manager || !path.basename(manager).includes("pnpm")) throw new Error("请通过 pnpm dist:win 或 pnpm dist:mac 打包");
const target = process.argv[2];
if (target !== "--win" && target !== "--mac") throw new Error("缺少桌面构建目标");
const staged = mkdtempSync(path.join(tmpdir(), "aai-desktop-runtime-"));

function run(file, args, env = process.env) {
  const result = spawnSync(process.execPath, [file, ...args], { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(file)} 构建失败，退出码 ${result.status}`);
}

try {
  // Windows 默认的 pnpm 依赖是绝对 junction。安装包需要真实目录，才能拷到另一台机器直接启动。
  run(manager, ["--config.node-linker=hoisted", "--filter", "@a-ai/server", "deploy", "--prod", "--legacy", staged]);
  run(require.resolve("electron-builder/cli.js"), [target, "--publish", "never"], { ...process.env, A_AI_SERVER_DEPLOY_DIR: staged });
} finally {
  rmSync(staged, { recursive: true, force: true });
}
