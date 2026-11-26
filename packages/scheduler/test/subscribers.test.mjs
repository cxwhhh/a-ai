import assert from "node:assert/strict";
import { test } from "node:test";
import { ScheduledRun } from "../src/index.ts";

test("故障订阅不影响其余订阅收到最后一帧并正常关闭", async () => {
  const run = new ScheduledRun("owner", "session", { id: "run" }, new AbortController());
  run.subscribers.add({ enqueue() { throw new Error("已断开"); } });
  const listener = run.subscribe(0);
  run.emit({ type: "done" });
  assert.equal(run.subscribers.size, 1);
  const healthy = [...run.subscribers][0];
  run.subscribers.clear();
  run.subscribers.add({ close() { throw new Error("已断开"); } });
  run.subscribers.add(healthy);
  run.finish();
  assert.match(await listener.text(), /"type":"done"/);
  assert.equal(run.subscribers.size, 0);
});
