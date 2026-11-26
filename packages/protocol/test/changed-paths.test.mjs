import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const { outputFiles: [module] } = await build({
  entryPoints: ["packages/protocol/src/lib/outputs.ts"], bundle: true, write: false, format: "esm",
});
const { collectChangedPaths } = await import(`data:text/javascript;base64,${Buffer.from(module.contents).toString("base64")}`);

const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });
const assistant = (...toolCalls) => ({ role: "assistant", toolCalls });
const result = (toolCallId, fields, status = "ok") => ({ role: "tool", toolCallId, content: JSON.stringify(fields), status });

test("文件计数以成功结果的路径为准，同一文件多次修改只计一次", () => {
  const messages = [
    assistant(call("repeat", "write_file", { path: "obsolete.py" })),
    result("repeat", { path: "/workspace/src/job.py" }),
    assistant(call("repeat", "edit_file", { path: "src/job.py" }), call("second", "edit_file", { path: "./src/job.py" })),
    result("repeat", { path: "./src/./job.py" }),
    result("second", { path: "src/job.py" }),
    assistant(call("repeat", "edit_file", { path: "other.py" }), call("failed", "write_file", { path: "failed.py" })),
    result("repeat", { path: "other.py" }),
    result("failed", { path: "failed.py" }, "error"),
  ];
  assert.deepEqual(collectChangedPaths(messages, []), ["other.py", "src/job.py"]);
});

test("文件计数纳入写盘的图表、下载、归档和脚本交付，排除只读操作及外部路径", () => {
  const messages = [
    assistant(call("chart", "make_chart", {}), call("download", "download_file", {}), call("zip", "archive", { action: "zip" }),
      call("run", "run_python", {}), call("read", "read_file", {}), call("external", "write_file", {})),
    { ...result("chart", { path: "charts/data.svg" }), artifactId: "chart" },
    result("download", { path: "./report.pdf" }),
    result("zip", { path: "bundle.zip" }),
    result("run", { outputs: ["output/data.txt", "../outside.txt"] }),
    result("read", { path: "read-only.txt" }),
    result("external", { path: "/external/settings.txt" }),
    { role: "tool", content: "已保存", status: "ok", toolResult: { name: "write_document", fields: { path: "doc.xlsx" } } },
  ];
  const artifacts = [{ id: "chart", file: "charts/data.svg" }, { id: "other", file: "unrelated.svg" }];
  assert.deepEqual(collectChangedPaths(messages, artifacts), ["doc.xlsx", "output/data.txt", "bundle.zip", "report.pdf", "charts/data.svg"]);
});
