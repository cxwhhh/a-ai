import assert from "node:assert/strict";
import { test } from "node:test";
import connection from "../src/connection.cjs";

const { desktopConnection } = connection;
const bundled = new URL("http://10.0.0.5:3000/updates/");

test("新安装和从旧本机模式升级均默认连接内置服务器", () => {
  for (const previous of [undefined, "local", "server"]) {
    const result = desktopConnection({}, bundled, previous);
    assert.equal(result.remoteMode, true);
    assert.equal(result.serverUrl, bundled.origin);
  }
  assert.equal(desktopConnection({}, bundled, "legacy-local").remoteMode, false);
  assert.equal(desktopConnection({}, null).remoteMode, false);
});

test("单独更换更新镜像不改变业务服务器，明确配置的服务器优先", () => {
  const env = { A_UPDATE_URL: "https://update.example.com/updates/" };
  const result = desktopConnection(env, bundled);
  assert.equal(result.feed.href, env.A_UPDATE_URL);
  assert.equal(result.serverUrl, bundled.origin);
  assert.equal(desktopConnection({ ...env, A_SERVER_URL: "https://a-ai.example.com" }, bundled).serverUrl, "https://a-ai.example.com");
});
