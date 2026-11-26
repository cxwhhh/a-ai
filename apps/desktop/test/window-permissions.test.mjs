import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const mainFile = fileURLToPath(new URL("../src/main.cjs", import.meta.url));
const source = readFileSync(mainFile, "utf8");
const requireMain = createRequire(mainFile);

function verifyWindow(remote, device, partition, hasTitlebar) {
  function fakeSession() {
    return {
      setPermissionRequestHandler(handler) { this.onRequest = handler; },
      setPermissionCheckHandler(handler) { this.onCheck = handler; },
    };
  }
  const defaultSession = fakeSession();
  const selectedSession = partition ? fakeSession() : defaultSession;
  const partitions = [];
  let loads = 0;
  function content(prefs) {
    return {
      on() {}, setWindowOpenHandler() {},
      async loadFile(file) {
        assert.equal(path.basename(file), "splash.html");
        assert.equal(prefs.session, selectedSession);
        assert.equal(selectedSession.onCheck(), false);
        const responses = [];
        selectedSession.onRequest(this, "media", (allowed) => responses.push(allowed));
        assert.deepEqual(responses, [false]);
        loads++;
      },
    };
  }
  const electron = {
    app: {
      requestSingleInstanceLock: () => true, getPath: () => path.dirname(mainFile),
      on() {}, whenReady: () => ({ then() {} }),
    },
    session: { defaultSession, fromPartition: (value) => { partitions.push(value); return selectedSession; } },
    BrowserWindow: class {
      constructor({ webPreferences }) { this.webContents = content(webPreferences); }
      on() {}
      once() {}
    },
  };
  const createWindow = runInNewContext(`${source}\n(remote, device) => { remoteMode = remote; deviceMode = device; return createWindow(); };`, {
    __dirname: path.dirname(mainFile), process: { platform: "win32" },
    require(id) {
      if (id === "electron") return electron;
      if (id === "electron-updater") return {};
      if (id === "./titlebar.cjs") return { createTitlebar: () => hasTitlebar ? {
        overlay: () => ({}), attach: (_window, prefs) => ({ contents: content(prefs), chromeReady: Promise.resolve() }),
      } : null };
      return requireMain(id);
    },
  });

  return createWindow(remote, device).then(() => {
    assert.equal(loads, 1);
    assert.deepEqual(partitions, partition ? [partition] : []);
    if (partition) assert.equal(defaultSession.onRequest, undefined);
  });
}

test("三种桌面模式在内容页面加载前为实际 session 安装权限拒绝钩子", async () => {
  for (const hasTitlebar of [false, true]) {
    await verifyWindow(false, false, undefined, hasTitlebar);
    await verifyWindow(true, false, "persist:a-ai-server", hasTitlebar);
    await verifyWindow(false, true, "a-ai-local-projects", hasTitlebar);
  }
});
