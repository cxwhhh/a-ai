const { contextBridge, ipcRenderer } = require("electron");

// 只给主页面提供固定更新操作。调用方无法传入安装路径、更新地址或任意 IPC 频道。
if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("aaiWorkspace", {
    state: () => ipcRenderer.invoke("a-ai:workspace-mode", "state"),
    createLocal: () => ipcRenderer.invoke("a-ai:workspace-mode", "create-local"),
  });
  const call = (action) => ipcRenderer.invoke("a-ai:updates", action);
  contextBridge.exposeInMainWorld("aaiUpdates", {
    state: () => call("state"),
    check: () => call("check"),
    download: () => call("download"),
    install: () => call("install"),
    subscribe: (onChange) => {
      const listener = (_event, state) => onChange(state);
      ipcRenderer.on("a-ai:update-state", listener);
      return () => { ipcRenderer.removeListener("a-ai:update-state", listener); };
    },
  });
  if (process.platform === "win32") {
    window.addEventListener("DOMContentLoaded", () => {
      const root = document.documentElement;
      const syncTheme = () => ipcRenderer.send("a-ai:page-theme", root.dataset.theme ?? "system");
      new MutationObserver(syncTheme).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
      syncTheme();
    }, { once: true });
  }
}
