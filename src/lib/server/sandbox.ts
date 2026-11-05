import "server-only";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./db";

/**
 * 沙箱：让 run_command / run_python 只能碰到“工作区 + 部署者授权的目录”。
 *
 * 三层防线（越往下越硬）：
 *   1. 路径检查（checkCommand）：命令里写到的绝对路径不在授权范围 → 不执行，直接告诉模型能访问哪些目录。
 *      只是字符串检查，能被绕过，但能让模型马上知道“该去哪找”，查得更准。
 *   2. 用户确认：会改东西的命令先问用户（run.ts 的 confirm，第 7.22 步）。
 *   3. 操作系统级隔离：就算命令绕过了第 1 层，也读不到、写不了授权范围之外的文件。
 *        docker   ：每个会话一个容器，只挂载工作区和授权目录（只读的就只读挂载），默认断网
 *        seatbelt ：macOS 自带的 sandbox-exec，用规则限制读写路径和网络，不需要装 Docker
 *        local    ：没有隔离，只有第 1、2 层（开发时用，设置页会提示“未隔离”）
 *
 * 配置都在服务端环境变量里（.env.local 或 docker-compose.yml），只有部署者能改，聊天里的模型改不了：
 *   A_SANDBOX         auto（默认）| docker | seatbelt | local
 *   A_SANDBOX_DIRS    授权目录，分号分隔，每个后面可加 :ro（只读，默认）或 :rw。例：/Users/me/Documents:ro;/Users/me/data:rw
 *   A_SANDBOX_NETWORK 1 = 允许联网（pip install 需要），默认断网
 *   A_SANDBOX_IMAGE   docker 模式用的镜像，默认 a-ai-sandbox:latest（Dockerfile.sandbox）
 *   A_SANDBOX_DATA_VOLUME  A.ai 自己跑在 Docker 里时填数据卷名（a-ai-data），沙箱容器用它挂载工作区
 */

export type SandboxMode = "docker" | "seatbelt" | "local";
export interface AllowedDir {
  path: string;
  mode: "ro" | "rw";
}
export interface SandboxInfo {
  mode: SandboxMode;
  isolated: boolean;
  network: boolean;
  dirs: AllowedDir[];
  /** 配置有问题时的说明（例如授权目录不存在、Docker 不可用而退回本机） */
  warnings: string[];
}

/** 授权目录里也永远不让碰的东西：密钥、凭据、环境变量文件 */
const SENSITIVE_DIRS = [".ssh", ".gnupg", ".aws", ".kube", ".docker", ".azure", ".config/gcloud", "Library/Keychains"];
const SENSITIVE_RE = /(^|\/)(\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.azure|\.config\/gcloud|Library\/Keychains)(\/|$)|(^|\/)\.env(\.[\w.-]+)?$|(^|\/)\.netrc$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|\.(pem|key|p12|pfx)$/;

/** 这些目录下是“用户的个人文件”：没授权就不能访问。系统目录（/usr、/bin、/opt…）可以读，命令才能正常运行 */
const PRIVATE_ROOTS = ["/Users", "/home", "/root", "/Volumes", "/mnt", "/media", "/srv", "/private/var/root"];

/** 密钥、凭据、.env 这类文件：授权目录里也不让碰（文件工具和 run_command 共用这条规则） */
export const isSensitivePath = (p: string) => SENSITIVE_RE.test(p);

/* ---------------- 配置 ---------------- */

let cached: SandboxInfo | null = null;

export function sandboxInfo(): SandboxInfo {
  if (cached) return cached;
  const warnings: string[] = [];
  const dirs: AllowedDir[] = [];
  for (const raw of (process.env.A_SANDBOX_DIRS ?? "").split(/[;\n]/)) {
    const item = raw.trim();
    if (!item) continue;
    const m = /^(.*?)(?::(ro|rw))?$/.exec(item)!;
    let p = m[1].trim().replace(/^~(?=\/|$)/, os.homedir());
    if (!path.isAbsolute(p)) {
      warnings.push(`授权目录必须是绝对路径，已忽略：${item}`);
      continue;
    }
    p = path.resolve(p);
    // 本机能看到的目录取真实路径（macOS 的 /tmp 其实是 /private/tmp）；A.ai 跑在容器里时看不到宿主机目录，就原样使用
    if (existsSync(/*turbopackIgnore: true*/ p)) p = realpathSync(/*turbopackIgnore: true*/ p);
    if (p === "/" || p === os.homedir()) {
      warnings.push(`不能把整个磁盘或整个家目录设为授权目录，请具体到子目录：${p}`);
      continue;
    }
    dirs.push({ path: p, mode: m[2] === "rw" ? "rw" : "ro" });
  }

  const want = (process.env.A_SANDBOX || "auto").toLowerCase();
  let mode: SandboxMode;
  if (want === "docker" || want === "seatbelt" || want === "local") mode = want;
  else mode = process.platform === "darwin" && existsSync(/*turbopackIgnore: true*/ "/usr/bin/sandbox-exec") ? "seatbelt" : process.env.A_SANDBOX_IMAGE ? "docker" : "local";
  if (mode === "seatbelt" && process.platform !== "darwin") {
    warnings.push("seatbelt 只能在 macOS 上用，已退回本机模式（未隔离）");
    mode = "local";
  }
  if (mode === "local") warnings.push("当前是本机模式：命令没有被隔离，只有路径检查和确认在起作用。部署给别人用时请改成 docker");

  cached = { mode, isolated: mode !== "local", network: process.env.A_SANDBOX_NETWORK === "1", dirs, warnings };
  return cached;
}

/* ---------------- 第 1 层：路径检查 ---------------- */

/**
 * 找出命令里写到的路径，检查是否在允许范围内。返回 null = 通过，否则返回拒绝原因（会原样告诉模型）。
 * root = 工作区在沙箱里看到的路径（docker 里是 /workspace），cwd = 命令开始时所在目录
 */
export function checkCommand(command: string, root: string, cwd: string): string | null {
  const info = sandboxInfo();
  const allowed = [root, ...info.dirs.map((d) => d.path)];
  // 引号里或空白分隔的“像路径”的片段：以 / 或 ~ 开头，或者包含 ..
  const tokens = command.match(/(?<=^|[\s'"=:(<>|;&,])(~?\/[^\s'"`;|&<>()]*|[^\s'"`;|&<>()]*\.\.[^\s'"`;|&<>()]*)/g) ?? [];
  for (const t of tokens) {
    if (/^\/\//.test(t) || /:\/\//.test(t)) continue; // URL
    const abs = t.startsWith("~") ? path.join(os.homedir(), t.slice(1)) : path.resolve(cwd, t);
    if (SENSITIVE_RE.test(abs)) return `不允许访问密钥、凭据类文件：${t}`;
    if (within(abs, allowed)) continue;
    if (PRIVATE_ROOTS.some((r) => within(abs, [r])) || within(abs, [DATA_DIR])) {
      return `${t} 不在授权范围内。可以访问的目录：${allowed.map((p) => (p === root ? `${p}（工作区）` : p)).join("、")}`;
    }
  }
  // 相对路径写的 .env / 私钥（上面只检查了带 / 的路径）
  if (/(^|[\s'"/=])\.env(\.(?!example\b)[\w-]+)?(?=$|[\s'";|&)])|(^|[\s'"/])[\w.-]+\.(pem|key|p12|pfx)(?=$|[\s'";|&)])/.test(command))
    return "不允许读取密钥或 .env 这类环境变量文件";
  return null;
}

export const within = (p: string, roots: string[]) => roots.some((r) => p === r || p.startsWith(r.endsWith("/") ? r : r + "/"));

/* ---------------- 执行 ---------------- */

/**
 * 命令的环境变量：只给必要的几个，不把 process.env 整个传进去（里面有 API Key 等密钥）。
 * HOME 设成工作区：pip install --user 装的包、git 配置都留在用户自己的工作区里。
 * TERM/NO_COLOR/CI/PAGER：让各种工具别输出颜色、别开分页器、别弹交互提示。
 */
export function sandboxEnv(root: string): Record<string, string | undefined> {
  const docker = sandboxInfo().mode === "docker";
  return {
    PATH: `${path.join(root, ".local", "bin")}:${docker ? "/usr/local/bin:/usr/bin:/bin" : (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}`,
    HOME: root,
    LANG: docker ? "C.UTF-8" : process.env.LANG || "C.UTF-8",
    TZ: process.env.TZ,
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1", // Python 脚本的 print 立刻输出，前端才能实时看到
  };
}

export interface ExecOptions {
  sessionId: string;
  /** 工作区在本机的真实路径 */
  workspace: string;
  /** 沙箱里看到的工作目录（root 或其子目录，或某个授权目录） */
  cwd: string;
  script: string;
  env: Record<string, string | undefined>;
}

export interface Exec {
  proc: ChildProcess;
  /** 结束这次运行的所有进程（超时、点停止、命令结束后清理后台进程都用它） */
  kill(): void;
}

/** 工作区在沙箱里的路径：docker 里固定是 /workspace，其余就是本机路径 */
export const sandboxRoot = (workspace: string) => (sandboxInfo().mode === "docker" ? "/workspace" : workspace);

export async function sandboxExec(o: ExecOptions): Promise<Exec> {
  const info = sandboxInfo();
  if (info.mode === "docker") return dockerExec(o, info);

  const args = ["-c", o.script];
  const [bin, argv] = info.mode === "seatbelt" ? ["/usr/bin/sandbox-exec", ["-p", seatbeltProfile(o.workspace, info), "/bin/bash", ...args]] : ["bash", args];
  const proc = spawn(bin, argv, {
    cwd: o.cwd,
    detached: true, // 自成一个进程组：kill(-pid) 能把命令里起的子进程一起结束
    stdio: ["ignore", "pipe", "pipe"],
    env: o.env as NodeJS.ProcessEnv,
  });
  const kill = () => {
    try {
      process.kill(-proc.pid!, "SIGKILL");
    } catch {
      /* 已经结束 */
    }
  };
  return { proc, kill };
}

/* ---------- seatbelt（macOS sandbox-exec） ---------- */

/**
 * 生成 sandbox-exec 的规则（SBPL）。规则从上往下写，后面的规则覆盖前面的：
 *   先全部允许 → 禁止联网 → 禁止所有写 → 允许写工作区、临时目录、读写授权目录
 *   → 禁止读个人目录（/Users 等）和 A.ai 数据目录 → 允许读工作区、授权目录、工具链
 *   → 最后禁止读写密钥类文件（放在最后，授权目录里的 .ssh 也读不到）
 */
// 一个 (regex …) 只放一个模式；同一条规则里的多个过滤条件是"任一命中"
const SEATBELT_SECRET_RE = [
  "/\\.(ssh|gnupg|aws|kube|docker|azure)(/|$)",
  "/\\.config/gcloud(/|$)",
  "/Library/Keychains(/|$)",
  "/\\.env(\\.[A-Za-z0-9_.-]+)?$",
  "/\\.netrc$",
  "/id_(rsa|dsa|ecdsa|ed25519)(\\.pub)?$",
  "\\.(pem|key|p12|pfx)$",
];

export function seatbeltProfile(workspace: string, info: SandboxInfo) {
  const q = (p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const real = (p: string) => (existsSync(/*turbopackIgnore: true*/ p) ? realpathSync(/*turbopackIgnore: true*/ p) : p);
  const ws = real(workspace);
  const tmp = [real(os.tmpdir()), "/private/tmp", "/private/var/folders"];
  const rw = info.dirs.filter((d) => d.mode === "rw").map((d) => d.path);
  const readable = info.dirs.map((d) => d.path);
  // python3、node 等可能装在家目录里（pyenv、conda、nvm、Homebrew 自定义位置），PATH 里这些目录要能读，否则命令都跑不起来
  const home = real(os.homedir());
  const toolchain = new Set<string>();
  for (const p of (process.env.PATH ?? "").split(":")) {
    if (!p || !within(real(p), [home])) continue;
    // 只放行这个 PATH 所在的顶层目录（~/.pyenv、~/miniconda3、~/.nvm…）；~/Library 太大，只放行两层（~/Library/Python）
    const parts = path.relative(home, real(p)).split(path.sep);
    const keep = parts[0] === "Library" ? parts.slice(0, 2) : parts.slice(0, 1);
    if (keep[0] && keep[0] !== "." && keep.length && !SENSITIVE_DIRS.includes(keep.join("/"))) toolchain.add(path.join(home, ...keep));
  }
  const sub = (ps: Iterable<string>) => [...ps].map((p) => `(subpath ${q(p)})`).join(" ");
  const privateRoots = PRIVATE_ROOTS.filter((r) => existsSync(/*turbopackIgnore: true*/ r)).map(real);

  return [
    "(version 1)",
    "(allow default)",
    info.network ? "" : "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* ${sub([ws, ...tmp, ...rw])} (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/(tty|fd/)"))`,
    `(deny file-read* ${sub([...privateRoots, real(DATA_DIR)])})`,
    `(allow file-read* ${sub([ws, ...readable, ...toolchain])})`,
    "(allow file-read-metadata)", // 只是看文件属性（stat），不读内容；没有它连进入授权目录的上级路径都会失败
    `(deny file-read* file-write* ${SEATBELT_SECRET_RE.map((r) => `(regex #"${r}")`).join(" ")})`,
  ]
    .filter(Boolean)
    .join("\n");
}

/* ---------- docker：每个会话一个常驻容器 ---------- */

const IMAGE = () => process.env.A_SANDBOX_IMAGE || "a-ai-sandbox:latest";
const IDLE_MS = 15 * 60_000;
const containers = new Map<string, { lastUsed: number; ready: Promise<void> }>();
let sweeper: ReturnType<typeof setInterval> | undefined;

const docker = (args: string[], timeout = 60_000) =>
  new Promise<string>((resolve, reject) =>
    execFile("docker", args, { timeout, maxBuffer: 4 << 20 }, (e, out, err) => (e ? reject(new Error((err || e.message).trim())) : resolve(out.trim()))),
  );

/**
 * 把 docker 的英文报错翻译成“哪里出了问题、怎么修”。这些都是部署环境的问题，不是命令本身的错，
 * 原样丢给模型它也修不了，所以说清楚给人看（结果会显示在过程里，设置页「沙箱」也会提示）
 */
export function explainDocker(msg: string): string {
  if (/permission denied.*docker\.sock/i.test(msg))
    return "A.ai 没有权限访问 Docker（/var/run/docker.sock）。服务器上运行 `getent group docker | cut -d: -f3` 查出 GID，写进项目根目录 .env 的 DOCKER_GID=，再 docker compose up -d";
  if (/Cannot connect to the Docker daemon|failed to connect to the docker API|docker\.sock.*(no such file|connect)/i.test(msg))
    return "连不上 Docker：Docker 没在运行，或者没把 /var/run/docker.sock 挂进 A.ai 容器。本机开发请先启动 Docker Desktop，或把 A_SANDBOX 改成 seatbelt / local";
  if (/spawn docker ENOENT|docker: not found|executable file not found/i.test(msg))
    return "找不到 docker 命令。A.ai 镜像需要用新的 Dockerfile 重新构建（里面会拷入 docker 命令行）：docker compose up -d --build";
  if (/No such image|Unable to find image|pull access denied/i.test(msg))
    return `沙箱镜像 ${IMAGE()} 不存在，先构建：docker compose build sandbox-image（或 docker build -f Dockerfile.sandbox -t ${IMAGE()} .）`;
  if (/volume-subpath|unknown.*subpath/i.test(msg)) return "Docker 版本太旧，不支持 volume-subpath（需要 25 以上）。请升级 Docker";
  return msg;
}

/**
 * docker 模式下实际检查一次 Docker 能不能用、镜像在不在。返回问题说明，没问题返回 null。
 * 设置页和每次对话开始时都会调（对话开始时用来决定要不要把 run_command / run_python 从工具列表里拿掉），
 * 所以结果缓存 30 秒：连续发消息不用每次都跑两条 docker 命令。
 */
let problemCache: { at: number; value: Promise<string | null> } | null = null;
export function dockerProblem(): Promise<string | null> {
  if (sandboxInfo().mode !== "docker") return Promise.resolve(null);
  if (problemCache && Date.now() - problemCache.at < 30_000) return problemCache.value;
  const value = (async () => {
    try {
      await docker(["version", "--format", "{{.Server.Version}}"], 10_000);
      await docker(["image", "inspect", "--format", "{{.Id}}", IMAGE()], 10_000);
      return null;
    } catch (e) {
      return explainDocker(e instanceof Error ? e.message : String(e));
    }
  })();
  problemCache = { at: Date.now(), value };
  return value;
}

/**
 * 命令或 Python 的输出里有“连不上网”的报错，而沙箱本来就是断网的：在结果里直接告诉模型原因和替代工具，
 * 不然它会以为是网站挂了、换个网址或加重试再来一遍。
 */
const NET_ERROR = /Network is unreachable|Temporary failure in name resolution|Name or service not known|nodename nor servname|Could not resolve host|getaddrinfo|EAI_AGAIN|ENOTFOUND|ENETUNREACH|NewConnectionError|Max retries exceeded|URLError|Failed to establish a new connection|Could not fetch URL|No matching distribution found/i;
export function networkHint(output: string): string | undefined {
  if (sandboxInfo().network || !NET_ERROR.test(output)) return undefined;
  return "沙箱是断网的，这里连不上网（不是网站的问题，重试也没用）。查网页用 web_search / web_fetch，下载文件用 download_file，装不了的包请告诉用户。";
}

/** 对话开始时用：Docker 沙箱坏了就把两个运行工具关掉（名字 → 原因），模型直接知道“这次不能跑代码”，不会一调就报错 */
export async function unavailableTools(): Promise<Record<string, string>> {
  const problem = await dockerProblem();
  if (!problem) return {};
  const why = `Docker 沙箱不可用（${problem}）`;
  return { run_command: why, run_python: why };
}

async function dockerExec(o: ExecOptions, info: SandboxInfo): Promise<Exec> {
  const name = "a-ai-sbx-" + o.sessionId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40);
  let c = containers.get(name);
  if (!c) {
    const ready = createContainer(name, o.workspace, info).catch((e: Error) => {
      throw new Error("沙箱容器启动失败：" + explainDocker(e.message));
    });
    c = { lastUsed: Date.now(), ready };
    containers.set(name, c);
    c.ready.catch(() => containers.delete(name));
  }
  await c.ready;
  c.lastUsed = Date.now();
  startSweeper();

  // 在容器里用 setsid 开一个新会话，把它的进程号记下来，结束时按进程组整组杀掉
  const runId = Math.random().toString(36).slice(2);
  const pidFile = `/tmp/.a-ai-run-${runId}`;
  const wrapped = `echo $$ > ${pidFile}\n${o.script}`;
  const envArgs = Object.entries(o.env).flatMap(([k, v]) => (v === undefined ? [] : ["-e", `${k}=${v}`]));
  const proc = spawn("docker", ["exec", "-w", o.cwd, ...envArgs, name, "setsid", "-w", "bash", "-c", wrapped], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    docker(["exec", name, "bash", "-c", `kill -KILL -- -$(cat ${pidFile}) 2>/dev/null; rm -f ${pidFile}`], 10_000).catch(() => {});
  };
  return { proc, kill };
}

/**
 * 创建会话容器：
 *   --network none        默认断网
 *   --memory/--cpus/--pids-limit  防止吃光机器、fork 炸弹
 *   --cap-drop ALL + no-new-privileges + 非 root 用户
 *   --read-only + tmpfs /tmp   容器自己的文件系统只读，只有工作区、读写授权目录、/tmp 能写
 *   工作区挂到 /workspace；授权目录挂到“和宿主机相同的路径”，模型看到的路径就是用户说的路径
 *   授权目录里的 .ssh 之类目录用空的 tmpfs 盖住
 */
async function createContainer(name: string, workspace: string, info: SandboxInfo) {
  await docker(["rm", "-f", name]).catch(() => {});
  const vol = process.env.A_SANDBOX_DATA_VOLUME;
  const wsMount = vol
    ? `type=volume,src=${vol},dst=/workspace,volume-subpath=${path.relative(DATA_DIR, workspace)}`
    : `type=bind,src=${workspace},dst=/workspace`;
  const dirMounts = info.dirs.flatMap((d) => ["--mount", `type=bind,src=${d.path},dst=${d.path}${d.mode === "ro" ? ",readonly" : ""}`]);
  const base = ["--network", info.network ? "bridge" : "none", "--mount", wsMount, ...dirMounts];

  // 先用一次性容器找出授权目录里的敏感目录（A.ai 自己跑在容器里时看不到宿主机目录，只能这样找）
  let masks: string[] = [];
  if (info.dirs.length) {
    const names = SENSITIVE_DIRS.filter((s) => !s.includes("/")).flatMap((s, i) => (i ? ["-o", "-name", s] : ["-name", s]));
    const found = await docker(["run", "--rm", ...base, "--entrypoint", "find", IMAGE(), ...info.dirs.map((d) => d.path), "-maxdepth", "4", "-type", "d", "(", ...names, ")", "-prune"], 30_000).catch(() => "");
    masks = found.split("\n").filter(Boolean).flatMap((p) => ["--mount", `type=tmpfs,dst=${p}`]);
  }

  await docker([
    "run", "-d", "--name", name, "--label", "a-ai.sandbox=1",
    "--memory", process.env.A_SANDBOX_MEMORY || "1g", "--cpus", process.env.A_SANDBOX_CPUS || "1", "--pids-limit", "256",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000",
    "--read-only", "--tmpfs", "/tmp:rw,exec,size=512m",
    ...base, ...masks,
    "-w", "/workspace", "--entrypoint", "sleep", IMAGE(), "infinity",
  ]);
}

/** 每分钟看一次：15 分钟没用过的会话容器删掉 */
function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    for (const [name, c] of containers)
      if (Date.now() - c.lastUsed > IDLE_MS) {
        containers.delete(name);
        docker(["rm", "-f", name]).catch(() => {});
      }
  }, 60_000);
  sweeper.unref();
  // 服务重启前留下的沙箱容器（不在 containers 里）也清掉
  docker(["ps", "-a", "--filter", "label=a-ai.sandbox=1", "--format", "{{.Names}}"])
    .then((out) => out.split("\n").filter((n) => n && !containers.has(n)).forEach((n) => docker(["rm", "-f", n]).catch(() => {})))
    .catch(() => {});
}

/* ---------------- 给模型的说明 ---------------- */

/** 接在系统提示词后面：告诉模型能访问哪些本机目录、怎么查得准 */
export function sandboxPrompt(): string {
  const info = sandboxInfo();
  const net = info.network
    ? "- run_command / run_python 可以联网。"
    : "- run_command / run_python 在断网的沙箱里运行：pip install、curl、requests、urllib 都连不上网。查网页用 web_search / web_fetch，下载文件用 download_file（下到工作区后再处理）。";
  const parts = ["## 运行环境", net, "- 工作区在沙箱里的路径是 /workspace（Docker 模式）；文件工具用相对路径或 /workspace/… 都可以。"];
  if (info.dirs.length) {
    const list = info.dirs.map((d) => `- ${d.path}（${d.mode === "ro" ? "只读" : "可读写"}）`).join("\n");
    parts.push(
      "",
      "## 本机文件访问",
      "用户授权你访问下面这些本机目录（路径就是用户电脑上的真实路径）。文件工具（list_files、glob、grep、read_file、read_document…）和 run_command 都能用：",
      list,
      "- 除此之外只能访问工作区，其他目录、密钥和 .env 文件都会被拒绝，不要尝试绕过。",
      "- 查找文件先缩小范围再看内容：glob 按文件名找（例：pattern=*合同*.pdf，path=授权目录），grep 按内容找；PDF/Word/Excel/PPT 用 read_document 读。",
      "- 回答要给出完整路径和你实际看到的内容。没找到就说明查过哪些目录、用了什么条件，不要猜。",
      "- 只读目录不能修改；需要改的话先用 file_op 复制到工作区再处理。",
    );
  }
  return parts.join("\n");
}

/* ---------------- 运行一段脚本（run_command / run_python 共用） ---------------- */

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/**
 * 在沙箱里跑 bash 脚本，输出通过 onData 实时交给调用方。
 * 超时 / 用户点停止：结束整组进程。命令里用 & 留下的后台进程会一直占着输出管道（close 事件不来），
 * 所以 bash 退出后最多再等 300ms，然后把整组结束。
 */
export async function runInSandbox(
  o: ExecOptions & { timeoutMs: number; signal?: AbortSignal; onData(stream: "out" | "err", text: string): void },
): Promise<RunResult> {
  const { proc, kill } = await sandboxExec(o);
  let timedOut = false;
  const timer = setTimeout(() => ((timedOut = true), kill()), o.timeoutMs);
  o.signal?.addEventListener("abort", kill, { once: true });
  // docker 模式下命令被杀时，容器里的 setsid 会多打一行“child … did not exit normally”，去掉它，按“被 SIGKILL 结束”报告
  let killedInContainer = false;
  const SETSID_NOISE = /setsid: child \d+ did not exit normally[^\n]*\n?/;
  proc.stdout!.setEncoding("utf8").on("data", (d: string) => o.onData("out", d)); // setEncoding：中文被切在两段数据之间也不会乱码
  proc.stderr!.setEncoding("utf8").on("data", (d: string) => {
    if (SETSID_NOISE.test(d)) {
      killedInContainer = true;
      d = d.replace(SETSID_NOISE, "");
    }
    if (d) o.onData("err", d);
  });
  try {
    return await new Promise<RunResult>((resolve, reject) => {
      let closed = false;
      proc.on("error", (e) => reject(new Error(`无法启动：${e.message}`)));
      proc.on("close", (code, signal) => {
        closed = true;
        resolve(killedInContainer ? { code: null, signal: "SIGKILL", timedOut } : { code, signal, timedOut });
      });
      proc.on("exit", (code, signal) =>
        setTimeout(() => {
          if (closed) return;
          kill();
          resolve({ code, signal, timedOut });
        }, 300).unref(),
      );
    });
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", kill);
    if (sandboxInfo().mode === "docker") kill(); // 容器里的后台进程也清掉（本机模式下进程组已随 bash 结束或在上面被杀）
  }
}
