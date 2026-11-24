const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { ipcMain, nativeTheme, WebContentsView } = require("electron");

const HEIGHT = 36;
const titlebarFile = path.join(__dirname, "titlebar.html");
const titlebarUrl = pathToFileURL(titlebarFile).href;

function isMainFrame(event, contents) {
  return !!contents && !contents.isDestroyed() && event.sender === contents &&
    !!event.senderFrame && event.senderFrame === contents.mainFrame;
}

/** Windows 顶栏由本地页面绘制，内容视图从它下方开始，网页仍可使用完整的工作区布局。 */
function createTitlebar({ currentMode, menuFor, isAppOrigin }) {
  let window;
  let page;
  let theme = "system";

  const dark = () => theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
  const overlay = () => dark()
    ? { height: HEIGHT, color: "#18181b", symbolColor: "#ececee" }
    : { height: HEIGHT, color: "#f5f5f6", symbolColor: "#111113" };

  function refreshTheme() {
    if (!window || window.isDestroyed()) return;
    window.setTitleBarOverlay(overlay());
    if (window.webContents.getURL() === titlebarUrl) {
      window.webContents.send("a-ai:titlebar-theme", dark());
    }
  }

  function openMenu(name, x) {
    if (!window || window.isDestroyed()) return;
    const menu = menuFor(name);
    if (!menu) return;
    const [width] = window.getContentSize();
    const left = Number.isFinite(x) ? Math.round(Math.min(Math.max(0, x), width)) : 8;
    // 原生编辑和视图菜单应作用于工作区，即使刚点击的是顶栏按钮。
    page.focus();
    return new Promise((resolve) => menu.popup({ window, x: left, y: HEIGHT, callback: resolve }));
  }

  function connect() {
    ipcMain.handle("a-ai:titlebar-state", (event) => {
      if (!isMainFrame(event, window?.webContents) || event.senderFrame.url !== titlebarUrl) {
        throw new Error("当前页面不能访问窗口菜单");
      }
      return { mode: currentMode(), dark: dark() };
    });
    ipcMain.handle("a-ai:titlebar-menu", (event, name, x) => {
      if (!isMainFrame(event, window?.webContents) || event.senderFrame.url !== titlebarUrl) {
        throw new Error("当前页面不能打开窗口菜单");
      }
      if (name === "application" || name === "environment") return openMenu(name, x);
    });
    ipcMain.on("a-ai:page-theme", (event, next) => {
      if (!isMainFrame(event, page) || !isAppOrigin(event.senderFrame.url)) return;
      if (!["system", "light", "dark"].includes(next) || theme === next) return;
      theme = next;
      refreshTheme();
    });
    nativeTheme.on("updated", refreshTheme);
  }

  function attach(win, webPreferences) {
    window = win;
    const view = new WebContentsView({ webPreferences });
    const contents = view.webContents;
    page = contents;
    view.setBackgroundColor(overlay().color);
    win.contentView.addChildView(view);
    const resize = () => {
      const [width, height] = win.getContentSize();
      view.setBounds({ x: 0, y: HEIGHT, width, height: Math.max(0, height - HEIGHT) });
    };
    win.on("resize", resize);
    resize();

    // 保留应用菜单和快捷键，平时收起原生菜单栏。F10 可从工作区打开同一菜单。
    win.setMenuBarVisibility(false);
    const shortcut = (event, input) => {
      if (input.type !== "keyDown" || input.key !== "F10" || input.alt ||
          input.control || input.meta || input.shift) return;
      event.preventDefault();
      if (!input.isAutoRepeat) void openMenu("application", 8);
    };
    contents.on("before-input-event", shortcut);
    win.webContents.on("before-input-event", shortcut);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.on("closed", () => {
      // 嵌入的 WebContentsView 随主窗口释放，避免退出后保留网页进程。
      if (!contents.isDestroyed()) contents.close();
      window = undefined;
      page = undefined;
      theme = "system";
    });
    return { contents, chromeReady: win.loadFile(titlebarFile) };
  }

  return { attach, connect, overlay };
}

module.exports = { createTitlebar, isMainFrame };
