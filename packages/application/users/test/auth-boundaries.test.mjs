import assert from "node:assert/strict";
import { test } from "node:test";
import { db, load } from "../../../../tests/fixtures/agent-runtime.mjs";

const { login, logout, register, startLogin } = load("packages/application/users/src/auth.ts");

test("注册的设置写入失败时，事务回滚已插入的用户", () => {
  db().exec(`CREATE TRIGGER reject_fixture_settings BEFORE INSERT ON settings
    BEGIN SELECT RAISE(ABORT, 'fixture settings failure'); END`);
  try {
    assert.throws(() => register("registration-fixture", "test-password"), /fixture settings failure/);
    assert.equal(db().prepare("SELECT 1 FROM users WHERE username = ?").get("registration-fixture"), undefined);
  } finally {
    db().exec("DROP TRIGGER reject_fixture_settings");
  }
});

test("锁定到期后重新计数，HTTPS 注销使用对应的 Cookie 属性", (t) => {
  const user = register("login-fixture", "test-password");
  assert.equal(typeof user, "object");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal(login(user.username, "incorrect"), "用户名或密码不对");
  assert.match(login(user.username, "test-password"), /错误次数太多/);
  now += 60_000;
  assert.equal(login(user.username, "incorrect"), "用户名或密码不对");
  assert.deepEqual(login(user.username, "test-password"), user);
  const https = new Request("http://local.test", { headers: { "x-forwarded-proto": "https" } });
  assert.match(new Headers(startLogin(https, user.id)).get("set-cookie"), /; Secure$/);
  assert.match(new Headers(logout(https)).get("set-cookie"), /Max-Age=0.*; Secure$/);
  assert.doesNotMatch(new Headers(logout(new Request("http://localhost"))).get("set-cookie"), /Secure/);
});
