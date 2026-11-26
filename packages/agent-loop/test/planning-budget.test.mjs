import assert from "node:assert/strict";
import { test } from "node:test";
import { readRun, routeFixture, routeState } from "../../../tests/fixtures/agent-runtime.mjs";

test("关闭自动修复时，规划与交付自检仍保留最后一次模型请求", async (t) => {
  const original = routeState.provider;
  const steps = [
    { type: "text", delta: "【规划】先读材料，再总结" },
    { type: "tool_call", call: { id: "read-for-plan", name: "read_file", arguments: "{}" } },
    { type: "text", delta: "草稿" },
    { type: "text", delta: "自检后的交付" },
  ];
  const inputs = [];
  routeState.provider = { async *stream(request) {
    inputs.push(request);
    yield steps[inputs.length - 1];
    yield { type: "done" };
  } };
  t.after(() => { routeState.provider = original; });
  const flow = await readRun(await routeFixture().request({ message: "先读文件，再总结" }));
  const events = await flow.rest();
  assert.equal(inputs.length, 4);
  assert.ok(events.some((event) => event.type === "text" && event.delta === "自检后的交付"));
});
