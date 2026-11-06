import "server-only";
import { existsSync, promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { audit } from "../../server/audit";
import { checkCommand, networkHint, runInSandbox, sandboxEnv, sandboxInfo, sandboxRoot, within } from "../../server/sandbox";
import type { Tool, ToolContext } from "./types";

const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;
/** 输出只保留开头和结尾：报错原因常在开头，结论和退出信息在结尾 */
const HEAD = 2000;
const TAIL = 6000;
/** 实时输出每隔多久推一次给前端（合并成一段，避免一行一个事件） */
const FLUSH_MS = 100;

/**
 * 终端工具：在工作区里执行一条 bash 命令（和 Claude Code 的 Bash 工具同一类）。
 *
 * 一次调用的流程：
 *   1. 分级：危险命令直接拒绝；只读命令按设置直接跑；其余先请用户确认（ctx.confirm）
 *   2. 启动：bash -c，独立进程组，stdin 关闭，干净的环境变量（不带 API Key）
 *   3. 收集输出：stdout/stderr 按到达顺序合并，内存里只留头尾；同时每 100ms 推一次给前端
 *   4. 超时 / 停止：杀掉整个进程组（命令里起的子进程也一起结束）
 *   5. 记住命令结束时所在的目录，下一条命令从这里开始（像真的终端一样 cd 会保留）
 *
 * 第 7.25 步起命令都在沙箱里执行（src/lib/server/sandbox.ts）：只能碰到工作区和部署者授权的本机目录，
 * 每一条（包括被拦下、被拒绝的）都写进审计日志（src/lib/server/audit.ts）。
 * 这里的分级和路径检查只是“体验层”，字符串匹配一定能被绕过；真正的边界是沙箱（seatbelt / docker）。
 */
/** description 是旧的参数名（以前的对话历史里还有），和 purpose 同义 */
export const runCommand: Tool<{ command: string; purpose?: string; description?: string; timeout_ms?: number }> = {
  spec: {
    name: "run_command",
    description:
      "在沙箱终端里执行一条 bash 命令，返回 {exitCode, timedOut, output, truncated, ranIn, cwd}。output 是 stdout 和 stderr 合并后的输出，太长时只保留开头和结尾。" +
      "当前目录会保留：每条命令都从上一条命令结束时的目录开始执行（不是每次回到工作区根目录）。ranIn 是这条命令开始时的目录，cwd 是结束后的目录（相对工作区，. = 工作区根目录），下一条命令就从 cwd 开始。" +
      "cd 之前先看上一次结果的 cwd：已经在目标目录就不要再 cd；命令里的相对路径是相对当前目录的。" +
      "适合：git、运行脚本和测试（python -m unittest、pytest、npm test）、解压、批量处理文件。" +
      "不要用于：读写文件（用 read_file、read_document、edit_file、write_file、file_op，不要用 cat、sed、echo >、mkdir、mv、rm）；找文件（用 glob、grep，不要用 find、rg）；纯 Python 计算（用 run_python）。联网以当前沙箱设置为准，关闭时使用 web_fetch、download_file。" +
      "只能访问工作区和授权目录（系统提示里有列表），其他路径和密钥文件会被拒绝。默认限时 30 秒，最长 120 秒。" +
      "不能交互：没有输入，不要运行 vim、top、python（不带脚本）这类等待输入的程序；不要用 & 启动后台常驻进程，命令结束时会被一起结束。" +
      "会修改东西的命令会先请用户确认；被拒绝时不要换个写法再试，换一种做法或询问用户。",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的命令，可以用 &&、| 组合多步。例：unzip -o data.zip -d data && ls data",
        },
        purpose: {
          type: "string",
          description: "一句话说明这条命令要做什么、为什么，显示给用户看（确认卡片上也会显示）。例：运行单元测试，确认 add 函数正确",
        },
        timeout_ms: {
          type: "number",
          description: "预计会比较慢（安装依赖、跑测试）时才填，单位毫秒，最大 120000",
        },
      },
      required: ["command"],
    },
  },

  async run({ command, purpose, description, timeout_ms }, ctx) {
    const cmd = String(command ?? "").trim();
    if (!cmd) throw new Error("command 不能为空：写要执行的 bash 命令，例：python -m unittest discover -s tests");
    const info = sandboxInfo();
    await fs.mkdir(ctx.workspace, { recursive: true });
    const root = sandboxRoot(ctx.workspace);
    const cwd = await currentDir(ctx, root);
    const log = { userId: ctx.userId ?? "", sessionId: ctx.sessionId, tool: "run_command", command: cmd, cwd, sandbox: info.mode };

    // ---- 1. 规则检查：危险命令、授权范围外的路径、密钥文件 → 直接拦下（记审计，告诉模型原因） ----
    const level = classify(cmd);
    const blocked = level.deny ?? checkCommand(cmd, root, cwd);
    if (blocked) {
      audit({ ...log, decision: "blocked", reason: blocked });
      throw new Error(`不允许执行：${blocked}。当前目录：${showDir(root, cwd)}。这是安全限制，不要换个写法绕过：换别的办法，或用 ask_user 告诉用户需要什么`);
    }

    // ---- 2. 用户确认（只读命令按设置可以直接放行） ----
    if (ctx.confirm) {
      const reason = String(purpose ?? description ?? "").trim() || (level.readonly ? "查看信息" : "这条命令可能修改文件、安装软件或联网");
      if (!(await ctx.confirm({ command: cmd, reason, readonly: level.readonly }))) {
        audit({ ...log, decision: "denied", reason: "用户拒绝" });
        return { content: JSON.stringify({ denied: true, cwd: showDir(root, cwd), message: "用户拒绝了这条命令。不要重复执行它：换一种做法，或者问用户想怎么做。" }) };
      }
    }

    // ---- 3. 在沙箱里执行，输出一边收集一边推给前端 ----
    const timeout = Math.min(Math.max(Number(timeout_ms) || DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT);
    // 命令结束（包括中途 exit）时，trap 在 stdout 最后打印一行“目录标记”，用来实现“cd 会保留”。
    // （以前用第 4 个管道 fd 3 传目录，但 docker exec 只转发 stdout/stderr，所以改成标记行，收到后从输出里去掉）
    // Windows 的 Git Bash 里 pwd 是 /c/Users/… 这种写法，用 cygpath -w 换回 C:\Users\…，才能和工作区路径对上
    const pwd = process.platform === "win32" && info.mode !== "docker" ? `$(cygpath -w "$(pwd -P)")` : "$(pwd -P)";
    const script = `trap 'printf "\\n${MARK}%s\\n" "${pwd}"' EXIT\n${cmd}`;
    const out = new HeadTail(HEAD, TAIL);
    const live = { out: "", err: "" };
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      flushTimer = undefined;
      for (const s of ["out", "err"] as const) {
        if (live[s]) ctx.onOutput?.(stripAnsi(live[s]), s);
        live[s] = "";
      }
    };
    let finalDir = "";
    const t0 = Date.now();
    const r = await runInSandbox({
      sessionId: ctx.sessionId,
      workspace: ctx.workspace,
      cwd,
      script,
      env: sandboxEnv(root),
      timeoutMs: timeout,
      signal: ctx.signal,
      onData(s, d) {
        if (s === "out" && d.includes(MARK)) {
          const m = new RegExp(`\\n?${MARK}(.*)\\n?`).exec(d);
          if (m) {
            finalDir = m[1];
            d = d.replace(m[0], "");
          }
        }
        out.push(d);
        live[s] += d;
        flushTimer ??= setTimeout(flush, FLUSH_MS);
      },
    });
    if (flushTimer) clearTimeout(flushTimer);
    flush();

    // ---- 4. 记住目录，记审计，整理结果 ----
    const dir = saveDir(ctx, root, finalDir.trim());
    const output = clean(out.text());
    const notes = [dir.reset && "命令结束时的目录不在允许范围内，已回到工作区根目录", r.code !== 0 && networkHint(output), cdHint(output, showDir(root, cwd))].filter(Boolean);
    audit({ ...log, decision: "allowed", exitCode: r.code, timedOut: r.timedOut, durationMs: Date.now() - t0, outputChars: out.total });
    return {
      content: JSON.stringify({
        exitCode: r.code,
        ...(r.signal && !r.timedOut ? { signal: r.signal } : {}),
        timedOut: r.timedOut,
        output,
        truncated: out.dropped > 0,
        ranIn: showDir(root, cwd),
        cwd: dir.shown,
        sandbox: info.mode,
        ...(notes.length ? { note: notes.join("；") } : {}),
      }),
    };
  },
};

/** 目录标记：\x1e（记录分隔符）开头，正常输出里几乎不会出现 */
const MARK = "\x1eA_AI_CWD:";

/* ---------------- 分级（体验层，不是安全边界） ---------------- */

const DENY: [RegExp, string][] = [
  [/\bsudo\b|\bsu\s/, "不能使用 sudo / su"],
  [/\brm\s+(-\w+\s+)*(\/|~|\$HOME)\/?(\s|$|\*)/, "不能删除根目录或家目录"],
  [/:\(\)\s*\{.*\};\s*:/, "fork 炸弹"],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, "不能下载脚本后直接执行"],
  [/\b(shutdown|reboot|halt|poweroff|mkfs(\.\w+)?)\b|\bdd\s+if=/, "系统级危险命令"],
];

/** 第一个词是这些、而且没有重定向 / 分号 / 子命令的，算只读 */
const READONLY =
  /^(ls|pwd|cat|head|tail|wc|grep|rg|find|fd|fdfind|tree|du|df|file|stat|which|whoami|uname|date|echo|env|printenv|sort|uniq|cut|jq|realpath|readlink|basename|dirname|md5sum|sha256sum|shasum|strings|nl|pdftotext \S+ -|pdfinfo|python3? (--version|-V)|pip3? (list|show|--version)|node (-v|--version)|npm (-v|--version|ls)|git (status|log|diff|show|branch|remote))\b/;

function classify(cmd: string): { deny?: string; readonly: boolean } {
  for (const [re, why] of DENY) if (re.test(cmd)) return { deny: why, readonly: false };
  // find 带 -delete / -exec 也会改东西
  const sideEffect = /[;&>`]|\$\(|\|\s*(sh|bash|xargs|tee)\b|-delete\b|-exec\b/.test(cmd);
  return { readonly: READONLY.test(cmd) && !sideEffect };
}

/* ---------------- 当前目录 ---------------- */

/**
 * 每个会话当前所在的目录（沙箱里看到的路径）。存在内存里：服务重启后回到工作区根目录。
 * 允许停在工作区或授权目录里（cd 到授权目录查文件，下一条命令还在那里）。
 */
const dirs = new Map<string, string>();

const allowedRoots = (root: string) => [root, ...sandboxInfo().dirs.map((d) => d.path)];
const inside = within;

async function currentDir(ctx: ToolContext, root: string) {
  const d = dirs.get(ctx.sessionId);
  if (!d || !inside(d, allowedRoots(root))) return root;
  if (sandboxInfo().mode === "docker") return d; // 目录在容器里，这里看不到；不存在的话 docker exec 会报错，下次自动回根目录
  try {
    if ((await fs.stat(d)).isDirectory()) return d;
  } catch {
    /* 目录被删了：回到根目录 */
  }
  return root;
}

function saveDir(ctx: ToolContext, root: string, finalDir: string) {
  // pwd -P 给的是真实路径，工作区路径可能经过软链接（macOS 的 /var → /private/var），比较前把两边都换成真实路径
  const realRoot = sandboxInfo().mode === "docker" || !existsSync(root) ? root : realpathSync(root);
  // 没拿到目录标记（命令被超时 / 停止杀掉了）：留在原来的目录
  let dir = !finalDir ? (dirs.get(ctx.sessionId) ?? root) : finalDir.startsWith(realRoot) ? root + finalDir.slice(realRoot.length) : finalDir;
  let reset = false;
  if (!inside(dir, allowedRoots(root))) {
    reset = true;
    dir = root;
  }
  dirs.set(ctx.sessionId, dir);
  return { shown: showDir(root, dir), reset };
}

/** 显示给模型的目录：工作区里用相对路径（. = 根目录），授权目录用绝对路径 */
function showDir(root: string, dir: string) {
  const rel = path.relative(root, dir);
  return rel.startsWith("..") || path.isAbsolute(rel) ? dir : rel || ".";
}

/**
 * cd 失败最常见的原因：已经在那个目录里了，又 cd 一次相对路径（cd proj → proj/proj 不存在）。
 * 报错里直接告诉模型命令是在哪个目录执行的，不用再 pwd、list_files 来回确认。
 */
function cdHint(output: string, ranIn: string) {
  if (!/\bcd: .*(No such file or directory|没有那个文件或目录|Not a directory)/.test(output)) return "";
  return `cd 失败：这条命令是在 ${ranIn} 里执行的，cd 的相对路径是相对这个目录的。如果已经在目标目录里，就去掉 cd；否则用相对工作区根目录的完整路径`;
}

/* ---------------- 输出处理 ---------------- */

/** 只留开头 head 字和结尾 tail 字，中间的只计数。命令输出 1GB 也只占几 KB 内存 */
class HeadTail {
  private head = "";
  private tail = "";
  dropped = 0;
  constructor(
    private h: number,
    private t: number,
  ) {}
  total = 0;
  push(s: string) {
    this.total += s.length;
    if (this.head.length < this.h) {
      const take = this.h - this.head.length;
      this.head += s.slice(0, take);
      s = s.slice(take);
    }
    this.tail += s;
    if (this.tail.length > this.t * 2) this.trim(); // 攒够两倍再切，少做字符串复制
  }
  private trim() {
    if (this.tail.length <= this.t) return;
    this.dropped += this.tail.length - this.t;
    this.tail = this.tail.slice(-this.t);
  }
  text() {
    this.trim();
    return this.dropped ? `${this.head}\n…省略 ${this.dropped} 字…\n${this.tail}` : this.head + this.tail;
  }
}

/** 去掉终端颜色 / 光标控制码 */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, "");

/** 去颜色码；进度条用 \r 反复刷新同一行，只保留每行最后一次的内容 */
const clean = (s: string) =>
  stripAnsi(s)
    .split("\n")
    .map((l) => l.split("\r").filter(Boolean).at(-1) ?? "")
    .join("\n")
    .replace(/\n+$/, "");
