import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

test("本地 Cordis 服务可注入，插件释放会移除自己的监听和资源", async () => {
  const result = await build({
    entryPoints: ["vendor/cordis/src/index.ts"], bundle: true, platform: "node", format: "esm", write: false,
    alias: { "@a-ai/cosmokit": "./vendor/cosmokit/src/index.ts" },
  });
  const { Context } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
  const root = new Context();
  const seen = [];
  await root.plugin(function provider(ctx) { ctx.provide("fixture", { label: "本地服务" }); });
  const dependent = await root.plugin(Object.assign(function watch(ctx) {
    ctx.on("fixture/tick", () => seen.push(ctx.fixture.label));
    ctx.effect(() => () => seen.push("已清理"));
  }, { inject: ["fixture"] }));
  root.emit("fixture/tick");
  await dependent.dispose();
  root.emit("fixture/tick");
  assert.deepEqual(seen, ["本地服务", "已清理"]);
  await root.fiber.dispose();
});
