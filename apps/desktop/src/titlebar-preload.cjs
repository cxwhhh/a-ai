const { ipcRenderer } = require("electron");

// 本地顶栏页面由桌面包提供。事件留在隔离环境里，页面无需访问 Electron API。
if (process.isMainFrame) {
  ipcRenderer.on("a-ai:titlebar-theme", (_event, dark) => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  });
  window.addEventListener("DOMContentLoaded", () => {
    const application = document.getElementById("application");
    const environment = document.getElementById("environment");
    for (const button of [application, environment]) {
      button.addEventListener("click", async () => {
        button.setAttribute("aria-expanded", "true");
        try {
          await ipcRenderer.invoke("a-ai:titlebar-menu", button.id, button.getBoundingClientRect().left);
        } finally {
          button.setAttribute("aria-expanded", "false");
        }
      });
    }
    void ipcRenderer.invoke("a-ai:titlebar-state").then(({ mode, dark }) => {
      const label = mode === "server" ? "A.ai 服务器" : mode === "device" ? "本地项目" : "本机工作区";
      environment.querySelector("span").textContent = label;
      environment.setAttribute("aria-label", `运行环境，当前为${label}`);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    });
  }, { once: true });
}
