import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { audit } from "../../telemetry/src/audit";
import { networkHint, runInSandbox, sandboxEnv, sandboxInfo, sandboxRoot } from "../../sandbox/src/sandbox";
import type { Tool, ToolContext } from "../../tool-runtime/src/types";
import { useTemporaryStorage } from "../../storage-manager/src/index";

const TIMEOUT_MS = 20000;
const MAX_OUT = 8000;

/**
 * 运行 Python 代码：agent 最强大、也最危险的工具。
 * - 默认在用户工作区执行。Docker 的一次性验证可以在本次调用的临时目录执行。
 * - 超时自动结束；用户点“停止”也会结束进程；每次运行都记进审计日志
 * 用哪个解释器：A_PYTHON 环境变量，默认 python3
 */
export const runPython: Tool<{
  code: string;
  purpose?: string;
  temporary?: boolean;
  outputs?: string[];
}> = {
  spec: {
    name: "run_python",
    description:
      "在沙箱里运行一段 Python 3 代码，返回 {exitCode, timedOut, stdout, stderr}（各保留最后 8000 字）。结果必须用 print 输出，否则看不到。" +
      "适合：数据处理与分析（pandas）、读写 csv/json/xlsx、多步计算、画图（matplotlib，plt.savefig 保存成 png，中文字体已配置好）、处理图片等二进制文件、验证代码。" +
      "服务器默认从本轮临时目录执行，按 /workspace/… 读取原文件。要交付的文件写到当前目录并用 outputs 显式列出。只有绑定项目的会话可显式传 temporary: false 在持久工作区执行。" +
      "本机默认工作目录是工作区。限时 20 秒。Docker 沙箱里装了 pandas、numpy、matplotlib、openpyxl、python-docx、pypdf，实际可用的以系统提示的「运行环境」为准；没装的库不要自己从头实现（例如手写 PNG 编码），换别的办法或告诉用户。" +
      "不要用于：单个算式（用 calculator）；读 PDF/Word/Excel/PPT 的文字（用 read_document）；git、跑测试、解压这类命令行操作（用 run_command）。联网以当前沙箱设置为准，关闭时使用 web_fetch、download_file。",
    parameters: {
      type: "object",
      properties: {
        temporary: { type: "boolean", description: "服务器默认临时执行。项目需要写入工作区时才显式传 false。" },
        outputs: { type: "array", items: { type: "string" }, description: "temporary 模式要交付的成品文件名，使用临时工作目录下的文件名。" },
        code: {
          type: "string",
          description: "完整、可直接运行的 Python 代码，用 print 输出结果。例：import statistics\nprint(statistics.mean([3, 5, 8]))",
        },
      },
      required: ["code"],
    },
  },
  async run({ code, temporary: requested, outputs }, ctx) {
    if (ctx.isolatedPython) {
      if (requested === false || outputs?.length) throw new Error("子任务的 Python 用于隔离计算和验证。持久文件请用授权的文件工具保存");
      return isolatedPython(String(code ?? ""), ctx, ctx.isolatedPython);
    }
    const info = sandboxInfo();
    const temporary = useTemporaryStorage(requested);
    if (temporary && info.mode !== "docker") throw new Error("临时执行模式需要 Docker 沙箱");
    const source = String(code ?? "");
    const dir = path.join(ctx.workspace, ".runs");
    const name = `run_${randomUUID()}.py`;
    const file = path.join(dir, name);
    await fs.mkdir(temporary ? ctx.workspace : dir, { recursive: true });

    // 和 run_command 一样在沙箱里跑：只能读写工作区和授权目录，读不到 a.db 和别的用户的文件
    const root = sandboxRoot(ctx.workspace);
    const bin = info.mode === "docker" ? "python3" : process.env.A_PYTHON || "python3";
    let stdout = "";
    let stderr = "";
    const t0 = Date.now();
    let r;
    try {
      if (!temporary) await fs.writeFile(file, source, "utf8");
      r = await runInSandbox({
        sessionId: ctx.sessionId,
        workspace: ctx.workspace,
        cwd: root,
        // 临时模式从 stdin 接收源码，主服务无需把脚本写进持久卷。
        script: temporary ? 'cat > "$TMPDIR/run.py" && exec python3 "$TMPDIR/run.py"' : `exec ${shellQuote(bin)} .runs/${name}`,
        ...(temporary ? { temporary, input: source } : { argv: [bin, path.join(".runs", name)] }),
        outputs,
        env: sandboxEnv(root),
        timeoutMs: TIMEOUT_MS,
        signal: ctx.signal,
        onData: (s, d) => (s === "out" ? (stdout = (stdout + d).slice(-MAX_OUT * 4)) : (stderr = (stderr + d).slice(-MAX_OUT * 4))),
      });
    } finally {
      if (!temporary) await fs.rm(file, { force: true });
    }
    audit({
      userId: ctx.userId ?? "",
      sessionId: ctx.sessionId,
      tool: "run_python",
      command: source,
      cwd: temporary ? "临时目录" : root,
      sandbox: info.mode,
      decision: "allowed",
      exitCode: r.code,
      timedOut: r.timedOut,
      durationMs: Date.now() - t0,
      outputChars: stdout.length + stderr.length,
    });

    return {
      content: JSON.stringify({
        exitCode: r.code,
        timedOut: r.timedOut,
        stdout: stdout.slice(-MAX_OUT),
        stderr: stderr.slice(-MAX_OUT),
        ...(r.outputs?.length ? { outputs: r.outputs } : {}),
        ...(r.code !== 0 && networkHint(stderr) ? { note: networkHint(stderr) } : {}),
      }),
    };
  },
};

/** 只复制明确引用的材料和已生成的授权文件。模型代码没有挂载工作区的能力。 */
async function isolatedPython(code: string, ctx: ToolContext, scope: NonNullable<ToolContext["isolatedPython"]>) {
  const files = new Map<string, string>();
  let remaining = 2 * 1024 * 1024;
  for (const requested of [...scope.inputs, ...scope.optionalOutputs]) {
    ctx.signal?.throwIfAborted();
    const file = ctx.readPath?.(requested);
    if (!file?.inWorkspace || file.shown === ".") throw new Error("Python 只能接收明确引用的工作区文件");
    if (files.has(file.shown)) continue;
    const stat = await fs.stat(file.full).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && !scope.inputs.includes(requested)) return null;
      throw error;
    });
    if (!stat) continue;
    if (!stat.isFile() || stat.size > remaining) throw new Error("Python 输入必须是普通文件，合计最多 2 MiB");
    const bytes = await fs.readFile(file.full, { signal: ctx.signal });
    remaining -= bytes.length;
    if (remaining < 0) throw new Error("Python 输入合计最多 2 MiB");
    files.set(file.shown, bytes.toString("base64"));
  }
  const captured = { out: "", err: "" };
  const t0 = Date.now();
  const result = await runInSandbox({
    sessionId: ctx.sessionId, workspace: ctx.workspace, cwd: "/tmp", script: "", env: {}, isolatedPython: true,
    input: JSON.stringify({ code, files: [...files] }), signal: ctx.signal, timeoutMs: TIMEOUT_MS,
    onData: (stream, delta) => {
      captured[stream] = (captured[stream] + delta).slice(-MAX_OUT);
      ctx.onOutput?.(delta, stream);
    },
  });
  audit({ userId: ctx.userId ?? "", sessionId: ctx.sessionId, tool: "run_python", command: code, cwd: "子任务临时目录",
    sandbox: "docker", decision: "allowed", exitCode: result.code, timedOut: result.timedOut, durationMs: Date.now() - t0,
    outputChars: captured.out.length + captured.err.length });
  return { content: JSON.stringify({ exitCode: result.code, timedOut: result.timedOut, stdout: captured.out, stderr: captured.err }) };
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
