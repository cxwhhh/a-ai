import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import { data, load } from "../../../tests/fixtures/agent-runtime.mjs";

const { runCommand } = load("packages/tools/src/run-command.ts");
const { isSensitivePath } = load("packages/sandbox/src/sandbox.ts");
const { webFetch, safeFetch } = load("packages/tools/src/web-fetch.ts");
const { httpRequest } = load("packages/tools/src/http-request.ts");
const { isPrivateHost } = load("packages/sandbox/src/public-fetch.ts");
const { fetchModel } = load("packages/llm/src/providers/provider-fetch.ts");
const { writeDocument } = load("packages/tools/src/write-document.ts");

test("命令只在单条安全查询时标为只读，测试中所有命令都拒绝执行", async () => {
  const workspace = await mkdtemp(path.join(data, "command-policy-"));
  for (const [command, expected] of [["ls -la", true], ["ls\npwd", false], ["ls\rpwd", false],
    ["echo hello | cat", false], ["cat <(printf sample)", false], ["node --version", true]]) {
    let readonly;
    const result = await runCommand.run({ command }, { workspace, sessionId: "fixture", confirm: (request) => {
      readonly = request.readonly;
      return false;
    } });
    assert.equal(readonly, expected);
    assert.equal(JSON.parse(result.content).denied, true);
  }
  for (const file of ["C:\\Users\\user\\.env", "C:\\Users\\user\\.SSH\\id_rsa", "C:\\Users\\user\\.config\\gcloud\\tokens"]) {
    assert.equal(isSensitivePath(file), true);
  }
  assert.equal(isSensitivePath("C:\\data\\report.txt"), false);
});

test("公网请求统一识别映射地址，并在换源时丢弃凭据和自定义头", async (t) => {
  for (const host of ["[::ffff:7f00:1]", "::ffff:172.16.1.2", "::ffff:100.127.1.2", "::ffff:0.1.2.3", "fe90::1"]) {
    assert.equal(isPrivateHost(host), true);
  }
  assert.equal(isPrivateHost("::ffff:8.8.8.8"), false);
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.215.14", family: 4 }]);
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, { headers }) => {
    sent.push({ host: url.hostname, headers });
    return url.hostname === "first.example" ? Response.redirect("https://second.example/") : new Response("ok");
  });
  const headers = { Authorization: "fixture", Cookie: "fixture", "X-API-Key": "fixture" };
  assert.equal(await (await safeFetch("https://first.example/", { headers })).text(), "ok");
  assert.equal(sent[0].headers.get("authorization"), "fixture");
  assert.deepEqual([...sent[1].headers.keys()], ["accept", "user-agent"]);
});

test("模型服务例外按部署者配置的 origin 匹配，模型请求禁止自动重定向", async (t) => {
  const prev = process.env.A_PRIVATE_MODEL_ORIGINS;
  const desktop = process.env.A_DESKTOP;
  process.env.A_PRIVATE_MODEL_ORIGINS = "http://127.0.0.1:35401";
  delete process.env.A_DESKTOP;
  t.after(() => {
    if (prev === undefined) delete process.env.A_PRIVATE_MODEL_ORIGINS;
    else process.env.A_PRIVATE_MODEL_ORIGINS = prev;
    if (desktop !== undefined) process.env.A_DESKTOP = desktop;
  });
  const fetch = t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.redirect, "error");
    return new Response("fixture");
  });
  await assert.rejects(fetchModel("http://127.0.0.1:35402/v1/models"), /A_PRIVATE_MODEL_ORIGINS/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(await (await fetchModel("http://127.0.0.1:35401/v1/models")).text(), "fixture");
  assert.equal(fetch.mock.callCount(), 1);
});

test("网页和 API 工具在读取无长度响应时按字节取消过大的正文", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.215.14", family: 4 }]);
  let cancellations = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancellations++; },
  })));
  const workspace = await mkdtemp(path.join(data, "bounded-response-"));
  for (const tool of [webFetch, httpRequest]) {
    await assert.rejects(tool.run({ url: "https://public.example/" }, { workspace }), /响应正文超过/);
  }
  assert.equal(cancellations, 2);
});

test("工作表后缀仍碰撞时继续递增，回执与工作簿中的名称一致", async () => {
  const workspace = await mkdtemp(path.join(data, "xlsx-names-"));
  const base = "a".repeat(31);
  const names = [base, base.slice(0, 29) + "_4", base.toUpperCase(), base];
  const output = JSON.parse((await writeDocument.run({
    path: "sheets.xlsx", sheets: names.map((name) => ({ name, rows: [["数据"]] })),
  }, { workspace })).content);
  const zip = await JSZip.loadAsync(await readFile(path.join(workspace, output.path)));
  const xml = await zip.file("xl/workbook.xml").async("string");
  const written = [...xml.matchAll(/<sheet name="([^"]+)"/g)].map(([, name]) => name);
  assert.deepEqual(written, output.sheets.map(({ name }) => name));
  assert.equal(new Set(written.map((name) => name.toLowerCase())).size, 4);
  assert.ok(written.every((name) => name.length <= 31));
});
