/**
 * A.ai 桌面版的 Electron 主进程。
 *
 * 有服务器地址时默认连接服务器。历史本机工作区和无服务器配置的开发环境使用内置 HTTP 服务。
 *   1. 找一个空闲端口，启动打包后的 A.ai HTTP 服务（只监听 127.0.0.1）
 *   2. 等服务器能响应，窗口从启动页切到 http://127.0.0.1:端口
 *   3. 退出时把服务器子进程一起关掉
 *
 * 数据（a.db、工作区、产出物）放在用户目录里，不放在安装目录：安装目录会被更新整个替换，用户目录不会。
 *   Windows：%APPDATA%\A.ai\data      macOS：~/Library/Application Support/A.ai/data
 * 同目录的 a-ai.env 可以写服务端环境变量（A_SANDBOX_DIRS、A_PYTHON…），第一次启动会生成一份带说明的模板。
 *
 * 更新：electron-updater 检查更新源上的版本清单，账号栏负责显示并发起下载和安装。
 * 打包后由 esbuild 打包主进程，并复制隔离的 preload（scripts/electron-prepare.mjs）。
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell, utilityProcess } = require("electron");
const { autoUpdater } = require("electron-updater");
const { execFileSync } = require("node:child_process");
const { createHash, createHmac, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { desktopConnection, serviceUrl } = require("./connection.cjs");
const { windowsLocalAppData } = require("./client-paths.cjs");
const { prepareWindowsUpdateCache } = require("./update-cache.cjs");
const { createDesktopUpdates, resolveWindowsInstallDirectory } = require("./updates.cjs");
const { createTitlebar, isMainFrame } = require("./titlebar.cjs");

// 同一时间只开一个 A.ai：再双击图标就把已有窗口拉到前面，不会起第二个服务器去抢同一个 a.db
if (!app.requestSingleInstanceLock()) app.exit(0);

const USER_DIR = app.getPath("userData");
const DATA_DIR = path.join(USER_DIR, "data");
const ENV_FILE = path.join(USER_DIR, "a-ai.env");
const CONNECTION_FILE = path.join(USER_DIR, "desktop-connection.json");
const DEVICE_KEY_FILE = path.join(USER_DIR, "local-workspace-key");
const LOCAL_WORKSPACE_ARG = "--aai-local-workspace";
const LOCAL_PROJECT_ARG = "--aai-new-local-project";
const CLOUD_PARTITION = "persist:a-ai-server";
const DEVICE_PARTITION = "a-ai-local-projects";
const LOG_DIR = path.join(USER_DIR, "logs");
// 内置服务使用桌面用户目录。服务器模式直接使用远端的账号、文件和运行环境。
const SERVER_DIR = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(__dirname, "..", "dist", "server");

let win = null;
let mainContents = null;
let server = null;
let baseUrl = "";
let quitting = false;
let remoteMode = false;
let serverUrl = "";
let deviceMode = false;
const titlebar = process.platform === "win32" ? createTitlebar({
  currentMode: () => remoteMode ? "server" : deviceMode ? "device" : "local",
  menuFor: (name) => {
    const menu = Menu.getApplicationMenu();
    return name === "environment" ? menu?.getMenuItemById("environment")?.submenu : menu;
  },
  isAppOrigin: sameOrigin,
}) : null;

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
# 默认连接的 A.ai 服务器地址。留空则使用打包的 /updates/ 所在服务器。
# A_SERVER_URL=https://你的服务器
# 服务器更换更新源时才填写。客户端重启后生效。
# A_UPDATE_URL=https://你的服务器/updates/
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

async function startServer(userEnv, device) {
  const dataDir = device ? path.join(DATA_DIR, "profiles", device.profile) : DATA_DIR;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const port = await freePort();
  const env = {
    ...process.env,
    ...userEnv,
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1", // 只给本机访问，局域网里的其他电脑连不上
    A_DATA_DIR: dataDir,
    A_DESKTOP: "1",
    // 桌面版只有自己用：第一个账号能注册，之后关闭注册
    A_ALLOW_SIGNUP: "0",
    PYTHONIOENCODING: "utf-8",
  };
  delete env.A_DESKTOP_PROFILE_CREDENTIAL;
  if (device) env.A_DESKTOP_PROFILE_CREDENTIAL = JSON.stringify(device.credential);
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
  server = utilityProcess.fork(path.join(SERVER_DIR, "server.mjs"), [], { cwd: SERVER_DIR, env, stdio: "pipe", serviceName: "A.ai server" });
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

/** 云端会话只用于确认账号，项目和密码在本机生成。以服务器来源与不可变账号 ID 分目录。 */
async function cloudIdentity() {
  const response = await session.fromPartition(CLOUD_PARTITION).fetch(`${serverUrl}/api/info`, {
    credentials: "include", redirect: "error", signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("请先登录 A.ai 服务器账号");
  const { username, userId } = await response.json();
  if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(username ?? "") || !/^[a-zA-Z0-9_-]{1,100}$/.test(userId ?? "")) {
    throw new Error("服务器未返回有效账号信息，请更新 A.ai 服务器");
  }
  return { username, profile: createHash("sha256").update(JSON.stringify([serverUrl, userId])).digest("hex") };
}

function deviceCredential({ username, profile }) {
  if (!fs.existsSync(DEVICE_KEY_FILE)) fs.writeFileSync(DEVICE_KEY_FILE, randomBytes(32), { flag: "wx", mode: 0o600 });
  const password = createHmac("sha256", fs.readFileSync(DEVICE_KEY_FILE)).update(profile).digest("hex");
  return { username, password };
}

async function signInDevice(credential) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", redirect: "error",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(credential) });
  const cookie = /^a_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (!response.ok || !cookie) throw new Error("无法登录本地工作区");
  await session.fromPartition(DEVICE_PARTITION).cookies.set({ url: baseUrl, name: "a_session", value: cookie, path: "/", httpOnly: true, sameSite: "lax" });
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
  const partition = remoteMode ? CLOUD_PARTITION : deviceMode ? DEVICE_PARTITION : undefined;
  if (partition) {
    const cloudSession = session.fromPartition(partition);
    cloudSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    cloudSession.setPermissionCheckHandler(() => false);
  }
  const pagePreferences = { contextIsolation: true, nodeIntegration: false, sandbox: true, partition, preload: path.join(__dirname, "preload.cjs") };
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "A.ai",
    backgroundColor: "#f7f6f3",
    show: false,
    ...(titlebar ? {
      titleBarStyle: "hidden",
      titleBarOverlay: titlebar.overlay(),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, "titlebar-preload.cjs") },
    } : { webPreferences: pagePreferences }),
  });
  win = window;
  const surface = titlebar?.attach(window, pagePreferences);
  const contents = surface?.contents ?? window.webContents;
  mainContents = contents;
  window.once("ready-to-show", () => {
    window.show();
    contents.focus();
  });

  // 页面里点外部链接：用系统浏览器打开；本站的新窗口（例如在新标签打开产出物）就开一个 A.ai 窗口
  contents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) return { action: "allow" };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  const checkNavigation = (e, url) => {
    if (sameOrigin(url)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  };
  contents.on("will-navigate", checkNavigation);
  contents.on("will-redirect", checkNavigation);
  window.on("closed", () => {
    win = null;
    mainContents = null;
  });
  return Promise.all([surface?.chromeReady, contents.loadFile(path.join(__dirname, "splash.html"))]);
}

function sameOrigin(value) {
  try { return Boolean(baseUrl) && new URL(value).origin === baseUrl; } catch { return false; }
}

function changeMode(remote) {
  if (!deviceMode && remoteMode === remote) return;
  fs.writeFileSync(CONNECTION_FILE, JSON.stringify({ mode: remote ? "server" : "legacy-local" }), "utf8");
  relaunchWorkspace();
}

function relaunchWorkspace(flag) {
  const args = process.argv.slice(1).filter((arg) => arg !== LOCAL_WORKSPACE_ARG && arg !== LOCAL_PROJECT_ARG);
  app.relaunch({ args: flag ? [...args, flag] : args });
  app.quit();
}

async function enterDeviceWorkspace(createProject) {
  try {
    await cloudIdentity();
    relaunchWorkspace(createProject ? LOCAL_PROJECT_ARG : LOCAL_WORKSPACE_ARG);
    return { ok: true };
  } catch (error) {
    return { error: error?.message ?? "无法打开本地工作区" };
  }
}

async function showChat() {
  try {
    await mainContents?.loadURL(`${baseUrl}/A.ai/chat`);
  } catch {
    await showMessage({ type: "warning", message: "无法连接 A.ai 服务器",
      detail: `${baseUrl}\n请检查网络，然后在「运行环境」中选择重新连接服务器。` });
  }
}

const showMessage = (options) => win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);

function buildMenu() {
  const help = {
    label: "帮助",
    submenu: [
      { label: "检查更新", click: () => void checkUpdatesFromMenu() },
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
    {
      id: "environment",
      label: "运行环境",
      submenu: [
        { label: serverUrl ? `A.ai 服务器（${new URL(serverUrl).host}）` : "A.ai 服务器", type: "radio",
          enabled: Boolean(serverUrl), checked: remoteMode, click: () => changeMode(true) },
        { label: "重新连接服务器", enabled: remoteMode, click: () => void showChat() },
        { label: "此设备的本地项目", type: "radio", checked: deviceMode, enabled: remoteMode || deviceMode, click: () => {
          if (remoteMode) void enterDeviceWorkspace(false).then((result) => {
            if (result.error) void showMessage({ type: "warning", message: result.error });
          });
        } },
        { type: "separator" },
        { label: serverUrl ? "旧版数据 · 本机工作区" : "本机工作区", type: "radio", checked: !remoteMode && !deviceMode,
          click: () => changeMode(false) },
      ],
    },
    help,
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- 自动更新 ---------------- */

// package.json 的 macSigned：有了 Apple 签名后改成 true（esbuild 打包时把 package.json 内联进来，所以是打包时决定的）
const MAC_UNSIGNED = process.platform === "darwin" && !require("../../../package.json").macSigned;
const UPDATE_INTERVAL = 15 * 60_000;
let updates;
let menuChecking = false;

function isChatPage(url) {
  return sameOrigin(url) && /^\/A\.ai\/chat(?:\/|$)/.test(new URL(url).pathname);
}

/** Windows 更新器会跳过目录页，因此在启动安装器前由主进程确认最终目录。 */
async function confirmUpdateInstall(version) {
  const windows = process.platform === "win32";
  const current = windows ? path.dirname(app.getPath("exe")) : "";
  const buttons = windows ? ["沿用当前目录", "选择安装位置", "稍后"] : ["安装并重启", "稍后"];
  const result = await showMessage({
    type: "question", message: `安装 A.ai ${version}？`,
    detail: (windows ? `当前安装位置\n${current}\n\n` : "") + "安装时会关闭并重新打开客户端。请先保存正在编辑的内容。",
    buttons, defaultId: 0, cancelId: buttons.length - 1,
  });
  if (result.response === 0) return windows ? current : true;
  if (!windows || result.response !== 1) return false;

  const folderOptions = {
    title: "选择 A.ai 安装目录的上一级文件夹", defaultPath: path.dirname(current),
    properties: ["openDirectory", "createDirectory"],
  };
  const folder = await (win && !win.isDestroyed() ? dialog.showOpenDialog(win, folderOptions) : dialog.showOpenDialog(folderOptions));
  if (folder.canceled || !folder.filePaths[0]) return false;
  let destination;
  try {
    destination = await resolveWindowsInstallDirectory(current, folder.filePaths[0]);
  } catch (error) {
    await showMessage({ type: "warning", message: "无法使用所选安装位置",
      detail: error?.code ? "请检查文件夹权限，或选择其他位置。" : String(error.message) });
    return false;
  }
  const choice = await showMessage({
    type: "question", message: `安装 A.ai ${version}？`, detail: `安装位置\n${destination}`,
    buttons: ["安装并重启", "稍后"], defaultId: 0, cancelId: 1,
  });
  return choice.response === 0 ? destination : false;
}

function setupUpdater(feed, override) {
  const unavailable = !app.isPackaged ? "开发模式不检查更新。" : !feed ? "尚未配置有效的更新源。" : "";
  if (!unavailable && override) autoUpdater.setFeedURL({ provider: "generic", url: feed, useMultipleRangeRequest: false });
  updates = createDesktopUpdates({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    unavailable,
    openInstaller: MAC_UNSIGNED ? async (info) => {
      const file = info.files?.find((entry) => entry.url.endsWith(".dmg"))?.url;
      const url = serviceUrl(new URL(file ?? feed, feed).href);
      if (!url) throw new Error("无效的 macOS 安装包地址");
      await shell.openExternal(url.href);
    } : undefined,
    confirmInstall: confirmUpdateInstall,
    onChange: (state) => {
      if (!win || win.isDestroyed()) return;
      win.setProgressBar(state.phase === "downloading" ? state.progress / 100 : -1);
      if (mainContents && !mainContents.isDestroyed() && isChatPage(mainContents.getURL())) {
        mainContents.send("a-ai:update-state", state);
      }
    },
  });

  // 同源页面也可能包含用户生成的 iframe。只允许当前窗口的聊天主文档请求更新。
  ipcMain.handle("a-ai:updates", async (event, action) => {
    if (!isMainFrame(event, mainContents) || !isChatPage(event.senderFrame.url)) {
      throw new Error("当前页面无法管理桌面更新");
    }
    switch (action) {
      case "state": return updates.state();
      case "check": return updates.check();
      case "download": {
        const result = await updates.download();
        // 用户主动下载后即提供安装确认。「稍后」会保留账号栏的安装按钮。
        return result.phase === "ready" ? updates.install() : result;
      }
      case "install": return updates.install();
      default: throw new Error("未知的更新操作");
    }
  });
  if (!unavailable) {
    void updates.check();
    setInterval(() => void updates.check(), UPDATE_INTERVAL).unref();
  }
}

/** 登录页和旧版服务界面也能通过原生菜单看到更新反馈。 */
async function checkUpdatesFromMenu() {
  if (menuChecking || !updates) return;
  menuChecking = true;
  try {
    let state = updates.state();
    if (["idle", "checking", "current", "available"].includes(state.phase) ||
        (state.phase === "error" && state.action !== "install")) {
      const notice = new AbortController();
      const showing = showMessage({ message: "正在检查更新…", buttons: ["在后台检查"], signal: notice.signal }).catch(() => {});
      try {
        state = await updates.check();
      } finally {
        notice.abort();
        await showing;
      }
    }
    if (state.phase === "available") {
      const result = await showMessage({
        type: "info", message: `A.ai ${state.version} 可以下载`,
        buttons: ["下载更新", "稍后"], defaultId: 0, cancelId: 1,
      });
      if (result.response !== 0) return;
      state = await updates.download();
      if (state.phase === "available") return; // 未签名的 macOS 版本已打开浏览器。
    }
    if (state.phase === "ready" || state.action === "install") {
      state = await updates.install();
      if (state.phase !== "error") return;
    }
    const message = state.message ?? (state.phase === "current"
      ? `已经是最新版本（${state.currentVersion}）`
      : state.phase === "downloading" ? `正在下载更新，已完成 ${state.progress}%` : "正在安装更新…");
    await showMessage({ type: state.phase === "error" ? "warning" : "info", message });
  } finally {
    menuChecking = false;
  }
}

/** 更新源地址（从 app-update.yml 里读 url），macOS 没签名时拼下载链接用 */
function updateBase() {
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, "app-update.yml"), "utf8");
    return serviceUrl(/^url:\s*["']?([^\s"']+)/m.exec(yml)?.[1]);
  } catch {
    return null;
  }
}

/* ---------------- 生命周期 ---------------- */

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    const env = readUserEnv();
    let savedMode;
    try { savedMode = JSON.parse(fs.readFileSync(CONNECTION_FILE, "utf8")).mode; } catch { /* 缺少旧设置时使用新默认值 */ }
    const connection = desktopConnection(env, updateBase(), savedMode);
    const { override, feed } = connection;
    ({ serverUrl, remoteMode } = connection);
    const openProject = process.argv.includes(LOCAL_PROJECT_ARG);
    if (serverUrl && (openProject || process.argv.includes(LOCAL_WORKSPACE_ARG))) {
      remoteMode = false;
      deviceMode = true;
    }
    if (remoteMode) baseUrl = serverUrl;
    if (app.isPackaged && process.platform === "win32") {
      // 在更新器启动前完成对旧缓存的处理，避免与新版下载同时改写目录。
      await prepareWindowsUpdateCache(windowsLocalAppData(), app.getVersion()).catch((error) => {
        console.warn("无法整理 Windows 更新缓存", error?.code ?? error?.message);
      });
    }
    setupUpdater(feed ? feed.href.replace(/\/?$/, "/") : "", Boolean(override));
    buildMenu();
    titlebar?.connect();
    ipcMain.handle("a-ai:workspace-mode", (event, action) => {
      if (!isMainFrame(event, mainContents) || !isChatPage(event.senderFrame.url)) return { error: "当前页面无法切换工作区" };
      if (action === "state") return { local: !remoteMode, canCreateLocal: remoteMode };
      if (action === "create-local" && remoteMode) return enterDeviceWorkspace(true);
      return { error: "当前工作区无法创建本地项目" };
    });
    await createWindow();
    if (remoteMode) await showChat();
    else {
      loadShellPath();
      const identity = deviceMode ? await cloudIdentity() : null;
      const device = identity ? { ...identity, credential: deviceCredential(identity) } : undefined;
      await startServer(env, device);
      if (device) await signInDevice(device.credential);
      // 使用已登录的规范路径，避免服务端重定向丢掉打开新建项目弹窗的参数。
      const destination = device && openProject ? `/${encodeURIComponent(device.username)}?newLocalProject=1` : "";
      await mainContents?.loadURL(`${baseUrl}/A.ai/chat${destination}`);
    }
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
    void createWindow().then(showChat).catch((error) => {
      dialog.showErrorBox("无法打开 A.ai 窗口", String(error?.message ?? error));
    });
  }
});
app.on("before-quit", () => {
  quitting = true;
  if (server) server.kill();
});
