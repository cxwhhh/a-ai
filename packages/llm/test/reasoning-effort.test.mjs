import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSync } from "esbuild";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const settingsEntry = fileURLToPath(new URL("../../protocol/src/lib/settings.ts", import.meta.url));
const [providerCode, settingsCode] = buildSync({
  entryPoints: [entry, settingsEntry], bundle: true, format: "cjs", platform: "node",
  packages: "external", write: false, outdir: "unused",
}).outputFiles;
const load = (code) => {
  const module = { exports: {} };
  new Function("require", "module", "exports", code.text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
};
const { getProvider } = load(providerCode);
const { PRESETS, normalizeSettings, reasoningOptions } = load(settingsCode);

function config(preset, model, effort, options = {}) {
  const { baseUrl, reasoningEfforts } = options;
  return normalizeSettings({
    currentModel: `test/${model}`, reasoningEffort: effort,
    connections: [{
      ...PRESETS[preset], id: "test", apiKey: "fixture", baseUrl: baseUrl ?? PRESETS[preset].baseUrl,
      models: [{ id: model, contextWindow: 128_000, reasoningEfforts }],
    }],
  });
}

const messages = [{ role: "system", content: "系统指令" }, { role: "user", content: "分析" }];
const tools = [{ name: "inspect", description: "读取示例", parameters: { type: "object" } }];
const request = { messages, tools, temperature: 0, maxOutputTokens: 4096 };
async function read(provider, req = request) {
  const chunks = [];
  for await (const chunk of provider.stream(req)) chunks.push(chunk);
  return chunks;
}
const sse = (...events) => new Response(events.map((event) =>
  `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""),
{ headers: { "Content-Type": "text/event-stream" } });

test("模型提供独立的档位，自定义配置保留受支持的有序值", () => {
  const levels = (s) => reasoningOptions(s, s.currentModel);
  assert.deepEqual(levels(config("deepseek", "deepseek-v4-pro", "max")), ["default", "low", "high", "max"]);
  assert.deepEqual(levels(config("anthropic", "claude-opus-5-5", "max")), ["default", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(levels(config("custom", "gpt-5.5", "xhigh", { baseUrl: "https://api.openai.com/v1" })),
    ["default", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(levels(config("custom", "gpt-6.2-sol", "max", { baseUrl: "https://api.openai.com/v1" })),
    ["default", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(levels(config("custom", "gpt-6.2-sol", "default", { baseUrl: "https://proxy.example/v1" })), ["default"]);
  const gateway = config("custom", "alias", "xhigh", {
    baseUrl: "https://proxy.example/v1", reasoningEfforts: ["max", "bogus", "xhigh", "low", "xhigh"],
  });
  assert.equal(gateway.reasoningEffort, "xhigh");
  assert.deepEqual(levels(gateway), ["default", "low", "xhigh", "max"]);
  assert.throws(() => getProvider(config("deepseek", "deepseek-v4-pro", "xhigh")), /不支持所选思考强度/);
});

test("Chat Completions 和 Claude 原样发送选择的强度", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.215.14", family: 4 }]);
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push([String(url instanceof Request ? url.url : url), JSON.parse(init?.body ?? await url.text())]);
    return sse({ choices: [{ delta: { content: "好" }, finish_reason: "stop" }] }, "[DONE]");
  });
  for (const effort of ["low", "max"]) await read(getProvider(config("deepseek", "deepseek-v4-pro", effort)));
  const gateway = (effort) => config("custom", "alias", effort, {
    baseUrl: "https://proxy.example/v1", reasoningEfforts: ["xhigh", "max"],
  });
  await read(getProvider(gateway("max")));
  await read(getProvider(gateway("default")));
  await read(getProvider(config("custom", "gpt-5.5", "xhigh", { baseUrl: "https://api.openai.com/v1" })));
  assert.deepEqual(sent.slice(0, 3).map(([, body]) => [body.reasoning_effort, body.thinking?.type]),
    [["low", "enabled"], ["max", "enabled"], ["max", undefined]]);
  assert.equal(sent[3][1].reasoning_effort, undefined);
  assert.equal(sent[4][1].reasoning_effort, "xhigh");
  assert.equal(sent[4][1].max_completion_tokens, 4096);
  assert.equal(sent[4][1].max_tokens, undefined);
  assert.equal(sent[4][1].temperature, undefined);

  // 用可判定的上游响应结束 Claude SDK 请求，并断言进入 HTTP 层的真实 JSON。
  globalThis.fetch.mock.mockImplementation(async (url, init) => {
    sent.push([String(url instanceof Request ? url.url : url), JSON.parse(init?.body ?? await url.text())]);
    return new Response(JSON.stringify({ error: { message: "fixture end" } }), { status: 400 });
  });
  for (const effort of ["xhigh", "max"]) {
    await assert.rejects(read(getProvider(config("anthropic", "claude-opus-5-5", effort))), /fixture end/);
  }
  assert.deepEqual(sent.slice(-2).map(([url, body]) => [new URL(url).pathname, body.output_config.effort, body.thinking.type]),
    [["/v1/messages", "xhigh", "adaptive"], ["/v1/messages", "max", "adaptive"]]);
});

test("官方 GPT-6 发送各档位，完成后重放工具调用和加密思考并保留计量", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.215.14", family: 4 }]);
  const seen = [];
  const call = { type: "function_call", call_id: "call_1", name: "inspect", arguments: "{}" };
  const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "fixture-encrypted" };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    const body = JSON.parse(init.body);
    seen.push(body);
    return sse(
      { type: "response.reasoning_summary_text.delta", delta: "正在分析" },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: "{}" },
      { type: "response.completed", response: { output: [{ type: "reasoning" }, call], usage: {
        input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 16 },
      } } },
    );
  });
  const model = (effort) => getProvider(config("custom", "gpt-6.2-sol", effort, { baseUrl: "https://api.openai.com/v1" }));
  const low = await read(model("low"));
  assert.deepEqual(low.find((chunk) => chunk.type === "tool_call")?.call, { id: "call_1", name: "inspect", arguments: "{}" });
  assert.equal(low.at(-1).usage.reasoningTokens, 16);
  const raw = low.find((chunk) => chunk.type === "raw").raw;
  await read(model("max"), { ...request, messages: [
    ...messages, { role: "assistant", content: "", raw }, { role: "tool", toolCallId: "call_1", content: "结果" },
  ] });
  assert.deepEqual(seen.map((body) => body.reasoning.effort), ["low", "max"]);
  assert.equal(model("max").requestOptions(request).reasoningEffort, "max");
  assert.ok(seen.every((body) => body.store === false && body.temperature === undefined && body.tools[0].strict === false));
  assert.deepEqual(seen[1].input.slice(-3), [reasoning, call, { type: "function_call_output", call_id: "call_1", output: "结果" }]);

  globalThis.fetch.mock.mockImplementation(async () => sse(
    { type: "response.output_item.added", output_index: 0, item: call },
    { type: "response.incomplete", response: { output: [call], incomplete_details: { reason: "max_output_tokens" } } },
  ));
  assert.deepEqual(await read(model("max")), [{ type: "done", finishReason: "length", usage: undefined }]);
  globalThis.fetch.mock.mockImplementation(async () => sse({ type: "response.output_item.done", item: call }));
  await assert.rejects(read(model("max")), { name: "ModelStreamInterrupted" });
});
