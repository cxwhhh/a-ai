import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runInSandbox, sandboxEnv, sandboxInfo, sandboxRoot } from "../server/sandbox";

/**
 * 把运行环境告诉模型，让它不用靠试错去发现（第 3 步“把环境告诉它”）。
 *
 * 分成两部分，放在不同的位置，是为了不破坏模型服务的“前缀缓存”：
 * - envPrompt()：一天内基本不变的信息（日期、沙箱里装了哪些 Python 包和命令）→ 接在系统提示词后面。
 *   系统提示词在每次请求的最前面，只要它不变，DeepSeek 等服务就能复用缓存（命中部分更便宜、更快）。
 * - turnEnv()：每轮都可能变的信息（几点几分、工作区里有哪些文件）→ 附在本轮用户消息后面（只在请求里，不存进数据库）。
 *   如果把它也放进系统提示词，每轮开头都变，整段历史的缓存都会失效。
 */

const TZ = process.env.A_TZ || "Asia/Tokyo";
const PROBE_TTL = 30 * 60_000;
const MAX_FILES = 30;
/** 本机模式下系统 Python 可能装了上百个包，只列前面这些，免得每次请求多几百 token */
const MAX_PKGS = 60;
/** 工作区概览里跳过的目录：运行时的临时文件、依赖、版本库 */
const SKIP = new Set([".runs", "node_modules", "__pycache__", ".git", ".venv", "venv"]);

let probe: { at: number; text: string } | null = null;
let probing: Promise<string> | null = null;

/** 系统提示词后面的“环境”一节。探测失败也不影响对话，只是少一段说明 */
export async function envPrompt(workspace: string): Promise<string> {
  const lines = ["## 环境", `- 今天是 ${fmtDate(new Date())}（${TZ}）。问日期、星期不用再调用 current_time；需要精确到分钟或别的时区时再调用。`];
  const tools = await probeSandbox(workspace).catch(() => "");
  if (tools) lines.push(tools);
  return lines.join("\n");
}

/** 本轮用户消息后面附加的环境快照：现在的时间 + 工作区里有什么 */
export async function turnEnv(workspace: string): Promise<string> {
  const files = await listWorkspace(workspace).catch(() => [] as string[]);
  const now = new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const body = files.length
    ? `工作区文件（前 ${MAX_FILES} 个，按修改时间从新到旧）：\n${files.map((f) => "- " + f).join("\n")}`
    : "工作区是空的。";
  return `<环境>\n现在 ${now}（${TZ}）。${body}\n</环境>`;
}

/**
 * 在沙箱里跑一次：列出 Python 包和常用命令。结果缓存 30 分钟（镜像不常变，每轮都跑太浪费）。
 * 几个请求同时进来时只跑一次。
 */
async function probeSandbox(workspace: string): Promise<string> {
  if (probe && Date.now() - probe.at < PROBE_TTL) return probe.text;
  probing ??= (async () => {
    const root = sandboxRoot(workspace);
    // 加引号：A_PYTHON 可能是 Windows 的 C:\Users\…\python.exe（bash 会把没加引号的 \ 吃掉），路径里也可能有空格
    const bin = sandboxInfo().mode === "docker" ? "python3" : `'${(process.env.A_PYTHON || "python3").replace(/'/g, `'\\''`)}'`;
    let out = "";
    const r = await runInSandbox({
      sessionId: "env-probe",
      workspace,
      cwd: root,
      script:
        `${bin} --version 2>&1; echo '--pkgs'; ${bin} -m pip list --format=freeze 2>/dev/null; echo '--cmds'; ` +
        "for c in git rg fd jq curl unzip zip pdftotext tree node; do command -v $c >/dev/null 2>&1 && echo $c; done",
      env: sandboxEnv(root),
      timeoutMs: 15_000,
      onData: (s, d) => s === "out" && (out += d),
    });
    if (r.code !== 0 && !out.includes("--pkgs")) throw new Error("探测失败");
    const [head, rest = ""] = out.split("--pkgs");
    const [pkgPart, cmdPart = ""] = rest.split("--cmds");
    const pkgs = pkgPart
      .split("\n")
      .map((l) => l.split("==")[0].trim())
      .filter((p) => p && !/^(pip|setuptools|wheel)$/i.test(p));
    const cmds = cmdPart.split("\n").map((s) => s.trim()).filter(Boolean);
    const text = [
      `- 运行代码的沙箱：${head.trim() || "Python"}。已安装的 Python 包：${pkgs.length ? pkgs.slice(0, MAX_PKGS).join("、") + (pkgs.length > MAX_PKGS ? ` 等 ${pkgs.length} 个` : "") : "（只有标准库）"}。没列出的包就是没有，先想办法用已有的包完成，不要先 import 试错。`,
      cmds.length ? `- 终端里可用的命令：${cmds.join("、")}。` : "",
    ]
      .filter(Boolean)
      .join("\n");
    probe = { at: Date.now(), text };
    return text;
  })().finally(() => (probing = null));
  return probing;
}

/** 工作区里的文件，最近改过的在前（最近的文件最可能和当前任务有关） */
async function listWorkspace(workspace: string): Promise<string[]> {
  const found: { rel: string; mtime: number }[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 3 || found.length > 500) return;
    const entries = await fs.readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const full = path.join(/*turbopackIgnore: true*/ dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else {
        const st = await fs.stat(/*turbopackIgnore: true*/ full).catch(() => null);
        if (st) found.push({ rel: path.relative(workspace, full) + `（${fmtSize(st.size)}）`, mtime: st.mtimeMs });
      }
    }
  }
  await walk(workspace, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  const shown = found.slice(0, MAX_FILES).map((f) => f.rel);
  if (found.length > MAX_FILES) shown.push(`……还有 ${found.length - MAX_FILES} 个文件，用 glob / list_files 查看`);
  return shown;
}

const fmtDate = (d: Date) =>
  new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(d);
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
