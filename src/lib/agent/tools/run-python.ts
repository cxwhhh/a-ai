import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { audit } from "../../server/audit";
import { networkHint, runInSandbox, sandboxEnv, sandboxInfo, sandboxRoot } from "../../server/sandbox";
import type { Tool } from "./types";

const TIMEOUT_MS = 20000;
const MAX_OUT = 8000;

/**
 * 运行 Python 代码：agent 最强大、也最危险的工具。
 * - 在沙箱里执行（第 7.25 步，和 run_command 共用 src/lib/server/sandbox.ts），工作目录是当前用户的工作区
 * - 超时自动结束；用户点“停止”也会结束进程；每次运行都记进审计日志
 * 用哪个解释器：A_PYTHON 环境变量，默认 python3
 */
export const runPython: Tool<{ code: string; purpose?: string }> = {
  spec: {
    name: "run_python",
    description:
      "在沙箱里运行一段 Python 3 代码，返回 {exitCode, timedOut, stdout, stderr}（各保留最后 8000 字）。结果必须用 print 输出，否则看不到。" +
      "适合：数据处理与分析（pandas）、读写 csv/json/xlsx、多步计算、画图（matplotlib，plt.savefig 保存成 png，中文字体已配置好）、处理图片等二进制文件、验证代码。" +
      "工作目录是工作区，能直接读写工作区里的文件，也能读授权目录（用绝对路径）。限时 20 秒。Docker 沙箱里装了 pandas、numpy、matplotlib、openpyxl、python-docx、pypdf，实际可用的以系统提示的「运行环境」为准；没装的库不要自己从头实现（例如手写 PNG 编码），换别的办法或告诉用户。" +
      "不要用于：单个算式（用 calculator）；读 PDF/Word/Excel/PPT 的文字（用 read_document）；git、跑测试、解压这类命令行操作（用 run_command）。联网以当前沙箱设置为准，关闭时使用 web_fetch、download_file。",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "完整、可直接运行的 Python 代码，用 print 输出结果。例：import statistics\nprint(statistics.mean([3, 5, 8]))",
        },
      },
      required: ["code"],
    },
  },
  async run({ code }, ctx) {
    const info = sandboxInfo();
    const dir = path.join(ctx.workspace, ".runs");
    await fs.mkdir(dir, { recursive: true });
    const name = `run_${Date.now()}.py`;
    await fs.writeFile(path.join(dir, name), String(code ?? ""), "utf8");

    // 和 run_command 一样在沙箱里跑：只能读写工作区和授权目录，读不到 a.db 和别的用户的文件
    const root = sandboxRoot(ctx.workspace);
    const bin = info.mode === "docker" ? "python3" : process.env.A_PYTHON || "python3";
    let stdout = "";
    let stderr = "";
    const t0 = Date.now();
    const r = await runInSandbox({
      sessionId: ctx.sessionId,
      workspace: ctx.workspace,
      cwd: root,
      script: `exec ${shellQuote(bin)} .runs/${name}`,
      // Windows：不经过 bash，直接 python.exe 脚本路径（没装 Git Bash 也能跑；路径里的 \ 和空格也不用转义）
      argv: [bin, path.join(".runs", name)],
      env: sandboxEnv(root),
      timeoutMs: TIMEOUT_MS,
      signal: ctx.signal,
      onData: (s, d) => (s === "out" ? (stdout = (stdout + d).slice(-MAX_OUT * 4)) : (stderr = (stderr + d).slice(-MAX_OUT * 4))),
    });
    await fs.rm(path.join(dir, name), { force: true });
    audit({
      userId: ctx.userId ?? "", sessionId: ctx.sessionId, tool: "run_python", command: String(code ?? ""), cwd: root, sandbox: info.mode,
      decision: "allowed", exitCode: r.code, timedOut: r.timedOut, durationMs: Date.now() - t0, outputChars: stdout.length + stderr.length,
    });

    return {
      content: JSON.stringify({
        exitCode: r.code,
        timedOut: r.timedOut,
        stdout: stdout.slice(-MAX_OUT),
        stderr: stderr.slice(-MAX_OUT),
        ...(r.code !== 0 && networkHint(stderr) ? { note: networkHint(stderr) } : {}),
      }),
    };
  },
};

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
