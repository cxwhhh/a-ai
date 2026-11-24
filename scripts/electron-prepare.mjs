import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const server = path.join(root, "dist", "server");
await fs.access(path.join(server, "server.mjs"));
await fs.access(path.join(server, "web", "index.html"));
const bundle = path.join(root, "dist-electron");
await fs.mkdir(bundle, { recursive: true });
await build({
  entryPoints: [path.join(root, "apps/desktop/src/main.cjs")],
  outfile: path.join(bundle, "main.cjs"),
  bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"],
});
await Promise.all(["splash.html", "preload.cjs", "titlebar.html", "titlebar-preload.cjs"].map((file) =>
  fs.copyFile(path.join(root, "apps/desktop/src", file), path.join(bundle, file)),
));
