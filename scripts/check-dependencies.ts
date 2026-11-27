import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const allowedClient = new Set(["apps/web", "packages/ui", "packages/protocol"]);
const exceptions = new Set([
  "react", "react-dom", "vite", "@vitejs/plugin-react", "tailwind-merge", "react-markdown", "remark-gfm", "highlight.js",
  "@shadcn/react/questionnaire", "react-aria-components", "@remixicon/react",
  "@base-ui/react/button", "@base-ui/react/collapsible", "@base-ui/react/menu", "@base-ui/react/switch",
]);
const violations: string[] = [];

function scan(dir: string) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const name = `${dir}/${entry.name}`;
    if (entry.isDirectory()) { scan(name); continue; }
    if (!/\.[cm]?tsx?$/.test(name) || name.endsWith("vite.config.mts")) continue;
    const source = ts.createSourceFile(name, fs.readFileSync(path.join(root, name), "utf8"), ts.ScriptTarget.Latest);
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.importClause?.isTypeOnly) continue;
      const spec = node.moduleSpecifier.text;
      if (!spec.startsWith(".")) {
        if (![...exceptions].some((lib) => spec === lib || spec.startsWith(`${lib}/`))) violations.push(`${name} -> ${spec}`);
        continue;
      }
      const dest = path.posix.normalize(path.posix.join(path.posix.dirname(name), spec));
      if (![...allowedClient].some((prefix) => dest.startsWith(`${prefix}/`))) violations.push(`${name} -> ${spec}`);
    }
  }
}

for (const dir of ["apps/web/src", "packages/ui/src", "packages/protocol/src"]) scan(dir);
if (violations.length) { console.error(`客户端依赖越界\n${violations.join("\n")}`); process.exitCode = 1; }
else console.log("客户端只引用可在浏览器运行的模块");
