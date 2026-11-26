import { build } from "esbuild";
import { build as buildWeb } from "vite";
import path from "node:path";
import { copyFile } from "node:fs/promises";

const root = path.resolve(import.meta.dirname, "..");
await buildWeb({ configFile: path.join(root, "apps/web/vite.config.mts") });
await copyFile(path.join(root, "packages/ui/src/icon.svg"), path.join(root, "dist/server/web/icon.svg"));
await build({
  absWorkingDir: root,
  entryPoints: ["apps/server/src/main.ts"],
  bundle: true,
  target: "node22",
  platform: "node",
  format: "esm",
  // Cordis 由工作区源码进入产物。模型 SDK、文档处理等依赖在部署时安装。
  alias: { "@A-ai/cordis": "./vendor/cordis/src/index.ts", "@a-ai/cosmokit": "./vendor/cosmokit/src/index.ts" },
  packages: "external",
  outfile: "dist/server/server.mjs",
  logLevel: "info",
});
await build({ absWorkingDir: root, entryPoints: ["apps/cli/src/main.ts"], bundle: true, target: "node22", platform: "node", format: "esm", outfile: "dist/cli/main.mjs" });
await build({ absWorkingDir: root, entryPoints: ["evals/run.mjs"], bundle: true, target: "node22", platform: "node", format: "esm", outfile: "dist/server/evals/run.mjs" });
for (const file of ["cases.json", "harness.json", "tools.json"]) await copyFile(path.join(root, "evals", file), path.join(root, "dist/server/evals", file));
