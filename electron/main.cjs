/**
 * A.ai 桌面版的 Electron 主进程。
 *
 * 原理：桌面版 = 本机起一个 Next 服务器 + 一个窗口去打开它。前端和 /api 代码和 Docker 版完全一样。
 *   1. 找一个空闲端口，用 utilityProcess 在子进程里跑 Next standalone 的 server.js（只监听 127.0.0.1）
 *   2. 等服务器能响应，窗口从启动页切到 http://127.0.0.1:端口
 *   3. 退出时把服务器子进程一起关掉
 *
 * 数据（a.db、工作区、产出物）放在用户目录里，不放在安装目录：安装目录会被更新整个替换，用户目录不会。
 *   Windows：%APPDATA%\A.ai\data      macOS：~/Library/Application Support/A.ai/data
 * 同目录的 a-ai.env 可以写服务端环境变量（A_SANDBOX_DIRS、A_PYTHON…），第一次启动会生成一份带说明的模板。
 *
 * 更新：electron-updater 读更新源上的 latest.yml / latest-mac.yml，版本号比安装的新就下载（见 setupUpdater）。
 * 打包后这个文件会被 esbuild 和 electron-updater 打成一个文件（scripts/electron-prepare.mjs）。
 */
const { app, BrowserWindow, Menu, dialog, shell, utilityProcess } = require("electron");
const { autoUpdater } = require("electron-updater");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

// 同一时间只开一个 A.ai：再双击图标就把已有窗口拉到前面，不会起第二个服务器去抢同一个 a.db
if (!app.requestSingleInstanceLock()) app.exit(0);

const USER_DIR = app.getPath("userData");
const DATA_DIR = path.join(USER_DIR, "data");
const ENV_FILE = path.join(USER_DIR, "a-ai.env");
const LOG_DIR = path.join(USER_DIR, "logs");
// 安装后 server 目录在 resources/server（electron-builder 的 extraResources）；开发时直接用 next build 的产物
const SERVER_DIR = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(__dirname, "..", ".next", "standalone");

let win = null;
let server = null;
let baseUrl = "";
let quitting = false;

/* ---------------- 环境：PATH、Python、用户配置 ---------------- */

/**
 * macOS 从访达/程序坞启动的应用只拿到最基本的 PATH（/usr/bin:/bin…），看不到 Homebrew、pyenv、conda 装的 python3。
 * 所以用登录 shell 跑一次 echo $PATH，取用户终端里的 PATH（和 VS Code 等桌面应用的做法一样）。
 */
function loadShellPath() {
  if (process.platform !== "darwin") return;
  try {
    const shellBin = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shellBin, ["-ilc", "printf '__A_PATH__%s__A_PATH__' \"$PATH\""], { encoding: "utf8", timeout: 5000 });
    const m = /__A_PATH__(.*)__A_PATH__/.exec(out);
    if (m && m[1]) process.env.PATH = m[1];
  } catch {
    /* 拿不到就用默认 PATH */
  }
}

/**
 * 找电脑上装的 Python，返回它的完整路径（交给服务端的 A_PYTHON）。
 * 用 python -c "print(sys.executable)" 问 Python 自己在哪：
 *   - Windows 上命令可能叫 python，也可能只有 py 启动器（py -3），这里统一换成 python.exe 的完整路径
 *   - Windows 的「应用商店 python.exe 占位程序」运行会失败，自然会被跳过
 */
function findPython() {
  const candidates = process.platform === "win32" ? [["python"], ["py", "-3"], ["python3"]] : [["python3"], ["python"]];
  for (const [bin, ...pre] of candidates) {
    try {
      const out = execFileSync(bin, [...pre, "-c", "import sys; print(sys.executable)"], { encoding: "utf8", timeout: 8000, windowsHide: true }).trim();
      if (out && fs.existsSync(out)) return out;
    } catch {
      /* 试下一个 */
    }
  }
  return "";
}

const ENV_TEMPLATE = `# A.ai 桌面版的服务端设置（改完重启 A.ai 生效）。一行一个 KEY=VALUE，# 开头是注释。
#
# 授权 agent 访问的本机目录，分号分隔，后面加 :ro（只读，默认）或 :rw（可读写）。例：
# A_SANDBOX_DIRS=C:\\Users\\me\\Documents\\资料:ro;D:\\work:rw
#
# 用哪个 Python 跑 run_python。不写 = 自动找电脑上装的 python。例：
# A_PYTHON=C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python312\\python.exe
#
# Windows 上 run_command 用 Git for Windows 自带的 bash，装在别的位置时在这里写：
# A_BASH=D:\\Git\\bin\\bash.exe
#
# run_command / run_python 能不能联网（1 = 可以）。桌面版默认可以，pip install 能用
A_SANDBOX_NETWORK=1
`;

/** 读 a-ai.env（没有就生成模板）。只认 KEY=VALUE，不做变量替换 */
function readUserEnv() {
  if (!fs.existsSync(ENV_FILE)) fs.writeFileSync(ENV_FILE, ENV_TEMPLATE, "utf8");
  const env = {};
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}

/* ---------------- 服务器 ---------------- */

/** 让系统分配一个空闲端口：监听 0 号端口，看系统给了哪个，再关掉 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const userEnv = readUserEnv();
  const port = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(port),
    HOSTNAME: "127.0.0.1", // 只给本机访问，局域网里的其他电脑连不上
    A_DATA_DIR: DATA_DIR,
    A_DESKTOP: "1",
    // 桌面版只有自己用：第一个账号能注册，之后关闭注册
    A_ALLOW_SIGNUP: "0",
    PYTHONIOENCODING: "utf-8",
    ...userEnv,
  };
  if (!env.A_PYTHON) {
    const py = findPython();
    if (py) env.A_PYTHON = py;
  }
  // 这是 Electron 自己的变量，传下去会让子进程里的 Node 行为不一样
  delete env.ELECTRON_RUN_AS_NODE;

  const log = fs.createWriteStream(path.join(LOG_DIR, "server.log"), { flags: "a" });
  log.write(`\n===== ${new Date().toISOString()} A.ai ${app.getVersion()} 端口 ${port} Python ${env.A_PYTHON || "(没找到)"} =====\n`);

  // utilityProcess：Electron 推荐的“跑 Node 子进程”方式，用的是 Electron 自带的 Node（不用另外装 Node）。
  // 服务器在独立进程里，agent 跑长任务不会卡住窗口；服务器崩了主进程还在，能提示用户
  server = utilityProcess.fork(path.join(SERVER_DIR, "server.js"), [], { cwd: SERVER_DIR, env, stdio: "pipe", serviceName: "A.ai server" });
  server.stdout.on("data", (d) => log.write(d));
  server.stderr.on("data", (d) => log.write(d));
  server.on("exit", (code) => {
    log.write(`[server exited ${code}]\n`);
    server = null;
    if (!quitting) {
      dialog.showErrorBox("A.ai 服务停止了", `后台服务意外退出（代码 ${code}）。日志在：\n${path.join(LOG_DIR, "server.log")}`);
      app.quit();
    }
  });

  baseUrl = `http://127.0.0.1:${port}`;
  await waitReady(`${baseUrl}/login`, 60_000);
}

/** 每 200ms 请求一次 /login，能响应就说明服务器起来了（和 Dockerfile 的 HEALTHCHECK 一样） */
async function waitReady(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!server) throw new Error("服务器启动失败");
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status < 500) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("服务器 60 秒内没有启动");
}

/* ---------------- 窗口 ---------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "A.ai",
    backgroundColor: "#f7f6f3",
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(__dirname, "splash.html"));

  // 页面里点外部链接：用系统浏览器打开；本站的新窗口（例如在新标签打开产出物）就开一个 A.ai 窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (baseUrl && url.startsWith(baseUrl)) return { action: "allow" };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("file:") || (baseUrl && url.startsWith(baseUrl))) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  win.on("closed", () => (win = null));
}

function buildMenu() {
  const help = {
    label: "帮助",
    submenu: [
      { label: "检查更新", click: () => checkUpdates(true) },
      { label: "打开数据目录", click: () => shell.openPath(USER_DIR) },
      { label: "打开设置文件 a-ai.env", click: () => shell.openPath(ENV_FILE) },
      { label: "打开服务日志", click: () => shell.openPath(path.join(LOG_DIR, "server.log")) },
      { type: "separator" },
      { label: `版本 ${app.getVersion()}`, enabled: false },
    ],
  };
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : [{ label: "文件", submenu: [{ role: "quit", label: "退出" }] }]),
    { role: "editMenu", label: "编辑" },
    { role: "viewMenu", label: "视图" },
    { role: "windowMenu", label: "窗口" },
    help,
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- 自动更新 ---------------- */

/**
 * electron-updater 的流程：
 *   1. 读打包时写进安装目录的 app-update.yml，知道更新源地址（electron-builder.yml 里 publish.url）
 *   2. 下载更新源上的 latest.yml（Windows）/ latest-mac.yml（macOS），和自己的版本号（package.json version）比较
 *   3. 有新版本：下载安装包，用 yml 里的 sha512 校验，下载完提示重启；退出时自动安装
 * macOS 的自动安装要求应用有 Apple 开发者签名。没签名时只提示“有新版本”，点按钮去下载新的 dmg 手动覆盖。
 */
// package.json 的 macSigned：有了 Apple 签名后改成 true（esbuild 打包时把 package.json 内联进来，所以是打包时决定的）
const MAC_UNSIGNED = process.platform === "darwin" && !require("../package.json").macSigned;
let manualCheck = false;

function setupUpdater() {
  if (!app.isPackaged) return; // 开发时没有 app-update.yml
  autoUpdater.autoDownload = !MAC_UNSIGNED;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", async (info) => {
    if (!MAC_UNSIGNED) return; // Windows：后台下载，下完再提示
    const r = await dialog.showMessageBox(win, { type: "info", message: `A.ai 有新版本 ${info.version}`, detail: "下载新的安装包，打开后把 A.ai 拖进「应用程序」覆盖旧版即可，数据不会丢。", buttons: ["去下载", "以后再说"], defaultId: 0 });
    if (r.response === 0) {
      const dmg = (info.files || []).find((f) => f.url.endsWith(".dmg"));
      shell.openExternal(dmg ? new URL(dmg.url, updateBase()).href : updateBase());
    }
  });
  autoUpdater.on("update-not-available", () => {
    if (manualCheck) dialog.showMessageBox(win, { type: "info", message: `已经是最新版本（${app.getVersion()}）` });
  });
  autoUpdater.on("update-downloaded", async (info) => {
    const r = await dialog.showMessageBox(win, { type: "info", message: `A.ai ${info.version} 已下载好`, detail: "重启后完成更新。选「稍后」的话，下次退出 A.ai 时自动安装。", buttons: ["现在重启", "稍后"], defaultId: 0 });
    if (r.response === 0) {
      quitting = true;
      autoUpdater.quitAndInstall();
    }
  });
  autoUpdater.on("error", (e) => {
    if (manualCheck) dialog.showMessageBox(win, { type: "warning", message: "检查更新失败", detail: String(e?.message || e) });
  });
  checkUpdates(false);
  setInterval(() => checkUpdates(false), 6 * 3600_000); // 一直开着也会每 6 小时查一次
}

function checkUpdates(manual) {
  if (!app.isPackaged) return void (manual && dialog.showMessageBox(win, { message: "开发模式不检查更新" }));
  manualCheck = manual;
  autoUpdater.checkForUpdates().catch(() => {});
}

/** 更新源地址（从 app-update.yml 里读 url），macOS 没签名时拼下载链接用 */
function updateBase() {
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, "app-update.yml"), "utf8");
    const url = /^url:\s*(\S+)/m.exec(yml)?.[1] ?? "";
    return url.endsWith("/") ? url : url + "/";
  } catch {
    return "";
  }
}

/* ---------------- 生命周期 ---------------- */

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  loadShellPath();
  buildMenu();
  createWindow();
  try {
    await startServer();
    // 桌面版直接进聊天页（没登录会自动跳到登录页），不显示网站的介绍首页
    if (win) win.loadURL(`${baseUrl}/A.ai/chat`);
    setupUpdater();
  } catch (e) {
    dialog.showErrorBox("A.ai 启动失败", `${e?.message || e}\n\n日志：${path.join(LOG_DIR, "server.log")}`);
    quitting = true;
    app.quit();
  }
});

// macOS 关掉窗口不退出（程序坞点图标再打开）；其他系统关窗口就退出
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (!win && baseUrl) {
    createWindow();
    win.loadURL(`${baseUrl}/A.ai/chat`);
  }
});
app.on("before-quit", () => {
  quitting = true;
  if (server) server.kill();
});
