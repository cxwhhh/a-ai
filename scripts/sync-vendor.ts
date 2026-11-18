import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [upstream, revision, mode] = process.argv.slice(2);
if (!upstream || !revision || (mode !== undefined && mode !== "--apply")) {
  throw new Error("用法：node scripts/sync-vendor.ts <DSH 仓库> <提交 SHA> [--apply]");
}
if (!/^[0-9a-f]{7,40}$/i.test(revision)) throw new Error("请使用指定的 Git 提交 SHA");
const root = path.resolve(import.meta.dirname, "..");
const git = (...args: string[]) => execFileSync("git", ["-C", path.resolve(upstream), ...args], { encoding: "utf8" });
const commit = git("rev-parse", "--verify", `${revision}^{commit}`).trim();
const updates: { filename: string; content: string }[] = [];
for (const pkg of ["cordis", "cosmokit"]) {
  const folder = `vendor/${pkg}`;
  const files = git("ls-tree", "-r", "--name-only", commit, `${folder}/src`, `${folder}/LICENSE`, `${folder}/README.md`).trim().split(/\r?\n/);
  if (!files.includes(`${folder}/LICENSE`)) throw new Error(`缺少 ${folder} 原许可证`);
  for (const file of files) {
    if (!file.startsWith(`${folder}/`) || file.split("/").includes("..")) throw new Error(`无效源码路径 ${file}`);
    const filename = path.join(root, file);
    let content = git("show", `${commit}:${file}`);
    if (pkg === "cordis" && file.includes("/src/")) content = content.replaceAll("@deepseek-ai/cosmokit", "@a-ai/cosmokit");
    if (!fs.existsSync(filename) || fs.readFileSync(filename, "utf8").replace(/\r\n/g, "\n") !== content.replace(/\r\n/g, "\n")) {
      updates.push({ filename, content });
      console.log(file);
    }
  }
}
if (mode === "--apply") for (const { filename, content } of updates) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}
console.log(`${commit} ${updates.length} 个文件${mode === "--apply" ? "已同步" : "待同步"}。检验后更新 vendor/README.md 的来源记录。`);
