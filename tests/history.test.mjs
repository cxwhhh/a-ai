import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";

/**
 * 历史版本存储的行为回归：测试真实 SQL 和事务，不调用模型，也不使用用户数据库。
 * 所有数据库、迁移备份和编译文件都放在临时目录，结束后清理。
 *
 * 项目还没有独立的 TS 测试运行器，这里复用已有 TypeScript 编译器，把实际存储源码编成 CJS。
 * 只移除 Next 的 server-only 环境标记、调整测试目录中的 db 模块引用，不替换业务逻辑。
 * 除了正确结果，还通过故障注入验证：写入和迁移中途失败时，数据库与内存都不留下半份状态。
 */
const dir = mkdtempSync(path.join(tmpdir(), "aai-history-test-"));
process.env.A_DATA_DIR = dir;
for (const name of ["db", "store", "projects", "memory", "../attachments", "../agentIcons"]) {
  const source = readFileSync(new URL("../src/lib/server/" + name + ".ts", import.meta.url), "utf8")
    .replace('import "server-only";', "");
  writeFileSync(path.join(dir, path.basename(name) + ".cjs"), ts.transpileModule(
    source.replace(/from "(?:\.\/|\.\.\/)(db|memory|attachments|agentIcons)"/g, 'from "./$1.cjs"'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } },
  ).outputText);
}
const require = createRequire(import.meta.url);
// 先创建升级前表，验证真实旧库迁移。
const old = new DatabaseSync(path.join(dir, "a.db"));
old.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT, password_hash TEXT, created_at INTEGER);
CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT,title TEXT,group_id TEXT,created_at INTEGER,updated_at INTEGER);
CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT,seq INTEGER,role TEXT,created_at INTEGER,data TEXT);
CREATE TABLE artifacts(id TEXT PRIMARY KEY,session_id TEXT,created_at INTEGER,data TEXT);
INSERT INTO users VALUES('u','test','not-a-password',0);
INSERT INTO users VALUES('other','other','not-a-password',0);
INSERT INTO sessions VALUES('legacy','u','old',NULL,0,0);
INSERT INTO messages VALUES('old-msg','legacy',0,'user',0,'{"id":"old-msg","role":"user","content":"old","createdAt":0}');`);
old.close();
const database = require(path.join(dir, "db.cjs"));
const store = require(path.join(dir, "store.cjs"));
const projects = require(path.join(dir, "projects.cjs"));
let serial = 0;
const msg = (role = "user", extra = {}) => ({ id: "msg" + ++serial, role, content: "text", createdAt: 100, ...extra });
const art = (extra = {}) => ({ id: "art" + ++serial, title: "output", kind: "markdown", content: "old", createdAt: 100, ...extra });
const session = () => store.createSession("u");

test("项目列表隔离用户，编辑后只统计当前回答、产出和去重路径", () => {
  const p = projects.createProject("u", { name: "test", description: "", memory: "off", share: false });
  assert.equal(projects.projectChats(p.id, "other"), null);
  assert.equal(projects.projectChats("missing", "u"), null);
  assert.deepEqual(projects.projectChats(p.id, "u"), []);
  const s = store.createSession("u", "chat", p.id);
  const cut = msg(); store.addMessage(s, cut);
  store.addMessage(s, msg("assistant", { content: "旧回答", toolCalls: [{ id: "old-call", name: "write_file", arguments: '{"path":"old.txt"}' }] }));
  store.addArtifact(s, art({ sourceToolCallId: "old-call" }));
  store.truncateFrom(s, cut.id);
  store.addMessage(s, msg());
  store.addMessage(s, msg("assistant", { content: "", toolCalls: [
    { id: "new-call", name: "write_file", arguments: '{"path":"new.txt"}' },
    { id: "repeat", name: "write_document", arguments: '{"path":"new.txt"}' },
    { id: "broken", name: "write_file", arguments: '{' },
  ] }));
  store.addMessage(s, msg("assistant", { content: "**新回答**\n内容" }));
  store.addArtifact(s, art({ sourceToolCallId: "new-call" }));
  const list = projects.projectChats(p.id, "u");
  assert.equal(list.length, 1);
  assert.equal(list[0].preview, "新回答 内容");
  assert.equal(list[0].files, 2);
});
after(() => { globalThis.__aDb?.close(); delete globalThis.__aDb; rmSync(dir, { recursive: true, force: true }); });

test("旧库迁移保留原文，重复打开不重复迁移", () => {
  assert.equal(store.getSession("legacy", "u").messages[0].content, "old");
  assert.equal(store.getSession("legacy", "other"), null);
  const backups = readdirSync(path.join(dir, "backups"));
  assert.equal(backups.length, 1);
  const snapshot = new DatabaseSync(path.join(dir, "backups", backups[0]));
  assert.equal(snapshot.prepare("SELECT data FROM messages WHERE id='old-msg'").get().data.includes("old"), true);
  assert.equal(snapshot.prepare("PRAGMA table_info(messages)").all().some(r => r.name === "superseded_by"), false);
  snapshot.close();
  database.db().close(); delete globalThis.__aDb;
  assert.equal(store.getSession("legacy", "u").messages.length, 1);
  assert.equal(readdirSync(path.join(dir, "backups")).length, 1);
  for (const table of ["messages", "artifacts"])
    assert.equal(database.db().prepare("PRAGMA table_info(" + table + ")").all().filter(r => r.name === "superseded_by").length, 1);
});

test("编辑只退出当前视图，旧工具链和变更前快照仍在", () => {
  const s = session();
  const prefix = msg(), cut = msg(), call = msg("assistant", { toolCalls: [{ id: "call", name: "create_artifact", arguments: "{}" }] });
  const result = msg("tool", { toolCallId: "call" });
  for (const m of [prefix, cut, call, result]) store.addMessage(s, m);
  const a = art({ sourceToolCallId: "call" }); store.addArtifact(s, a);
  assert.equal(store.truncateFrom(s, cut.id), true);
  assert.deepEqual(store.getSession(s.id, "u").messages.map(m => m.id), [prefix.id]);
  assert.equal(store.getSession(s.id, "u").artifacts.length, 0);
  assert.equal(database.db().prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id=?").get(s.id).n, 4);
  const revision = database.db().prepare("SELECT * FROM session_revisions WHERE session_id=?").get(s.id);
  assert.deepEqual(JSON.parse(revision.message_ids), [prefix.id, cut.id, call.id, result.id]);
  assert.deepEqual(JSON.parse(revision.artifact_ids), [a.id]);
  assert.equal(store.listArtifacts("u").some(x => x.id === a.id), false);
});

test("同毫秒产出按来源关联，旧 artifactId 兼容，来源不明保守保留", () => {
  const s = session(), first = msg(), cut = msg();
  store.addMessage(s, first);
  const keep = art({ sourceToolCallId: "earlier" }), legacy = art(), unknown = art();
  store.addMessage(s, cut);
  store.addMessage(s, msg("tool", { toolCallId: "legacy-call", artifactId: legacy.id }));
  for (const a of [keep, legacy, unknown]) store.addArtifact(s, a);
  store.truncateFrom(s, cut.id);
  assert.deepEqual(store.getSession(s.id, "u").artifacts.map(a => a.id).sort(), [keep.id, unknown.id].sort());
});

test("重复编辑后序号持续递增，刷新只见新版本；旧摘要一并退出", () => {
  const s = session(), first = msg(); store.addMessage(s, first);
  store.addMessage(s, msg("user", { feedback: { kind: "compact", summary: "old" }, compact: { keepFrom: first.id } }));
  store.truncateFrom(s, first.id);
  const second = msg(); store.addMessage(s, second);
  store.truncateFrom(s, second.id);
  const third = msg(); store.addMessage(s, third);
  assert.deepEqual(store.getSession(s.id, "u").messages.map(m => m.id), [third.id]);
  const seq = database.db().prepare("SELECT seq FROM messages WHERE session_id=? ORDER BY seq").all(s.id).map(r => r.seq);
  assert.deepEqual(seq, [0, 1, 2, 3]);
  assert.equal(store.listSessions("u").find(x => x.id === s.id).hasFiles, false);
});

test("非法锚点无写入，过期快照拒绝截断", () => {
  const s = session(), assistant = msg("assistant"); store.addMessage(s, assistant);
  assert.equal(store.truncateFrom(s, assistant.id), false);
  assert.equal(store.truncateFrom(s, "missing"), false);
  const cut = msg(); store.addMessage(s, cut);
  const stale = store.getSession(s.id, "u");
  store.addMessage(s, msg());
  assert.throws(() => store.truncateFrom(stale, cut.id), /刷新/);
  assert.equal(stale.messages.length, 2);
});

test("中途数据库错误回滚消息、产出、版本记录与内存", () => {
  const s = session(), cut = msg(); store.addMessage(s, cut);
  const a = art(); store.addArtifact(s, a);
  store.addMessage(s, msg("tool", { artifactId: a.id }));
  database.db().exec("CREATE TEMP TRIGGER fail_artifact BEFORE UPDATE OF superseded_by ON artifacts BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  try {
    assert.throws(() => store.truncateFrom(s, cut.id), /injected failure/);
    assert.equal(s.messages.length, 2); assert.equal(s.artifacts.length, 1);
    assert.equal(store.getSession(s.id, "u").messages.length, 2);
    assert.equal(database.db().prepare("SELECT COUNT(*) AS n FROM session_revisions WHERE session_id=?").get(s.id).n, 0);
  } finally { database.db().exec("DROP TRIGGER fail_artifact"); }
});

test("追加写入失败不提前污染内存", () => {
  const s = session(), m = msg(); store.addMessage(s, m);
  assert.throws(() => store.addMessage(s, m));
  assert.equal(s.messages.length, 1);
  const a = art(); store.addArtifact(s, a);
  assert.throws(() => store.addArtifact(s, a));
  assert.equal(s.artifacts.length, 1);
});

test("彻底删除语义不变，新库外键级联清理修订记录", () => {
  const s = session(), m = msg(); store.addMessage(s, m); store.truncateFrom(s, m.id);
  assert.equal(store.deleteSession(s.id, "other"), false);
  assert.equal(store.deleteSession(s.id, "u"), true);
  assert.equal(database.db().prepare("SELECT COUNT(*) AS n FROM session_revisions WHERE session_id=?").get(s.id).n, 0);
});

test("全新数据库可使用，彻底删除级联清理所有版本与产出", () => {
  const fresh = mkdtempSync(path.join(dir, "fresh-"));
  const code = `
    const assert = require("node:assert/strict");
    const {db} = require(${JSON.stringify(path.join(dir, "db.cjs"))});
    const store = require(${JSON.stringify(path.join(dir, "store.cjs"))});
    db().exec("INSERT INTO users VALUES('u','u','x',0)");
    const s = store.createSession('u');
    store.addMessage(s, {id:'m',role:'user',content:'x',createdAt:0});
    store.addArtifact(s, {id:'a',title:'x',kind:'markdown',content:'x',createdAt:0});
    store.truncateFrom(s,'m');
    store.deleteSession(s.id,'u');
    for (const t of ['messages','artifacts','session_revisions'])
      assert.equal(db().prepare('SELECT COUNT(*) AS n FROM '+t).get().n,0);
    db().close();
  `;
  const r = spawnSync(process.execPath, ["-e", code], {env:{...process.env,A_DATA_DIR:fresh},encoding:"utf8"});
  assert.equal(r.status, 0, r.stderr);
});

test("迁移中途失败会回滚新列，不留下半份历史迁移", () => {
  const broken = mkdtempSync(path.join(dir, "broken-"));
  const d = new DatabaseSync(path.join(broken, "a.db"));
  // 故障注入：故意创建与新索引不兼容的同名表，让迁移在增加列之后失败。
  d.exec("CREATE TABLE session_revisions(id TEXT)");
  d.close();
  const code = `require(${JSON.stringify(path.join(dir,"db.cjs"))}).db()`;
  const r = spawnSync(process.execPath, ["-e", code], {env:{...process.env,A_DATA_DIR:broken},encoding:"utf8"});
  assert.notEqual(r.status, 0);
  const check = new DatabaseSync(path.join(broken, "a.db"));
  for (const t of ["messages","artifacts"])
    assert.equal(check.prepare("PRAGMA table_info("+t+")").all().some(row => row.name === "superseded_by"), false);
  check.close();
});
