import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentRegistry, agents, createRegistry, load, overrides, routeFixture, routeState, store } from "../../../../tests/fixtures/agent-runtime.mjs";

const { Context } = load("vendor/cordis/src/index.ts");
const { createAgentInstance } = load("packages/agent-core/agent/src/factory.ts");
const { createQueueClock } = load("packages/agent-core/inbox/src/clock.ts");
const { configureAgentPlugins } = load("packages/application/chat/src/agent-plugins.ts");
const { readAgentPlugins } = load("packages/session/src/agent-plugins.ts");
const { agentSessions } = load("packages/session/src/agent-session.ts");
const { builtinAgentPlugins } = load("packages/runtime/src/agent-plugins.ts");

function scopedHost(catalog, sessions = agentSessions) {
  const ctx = new Context();
  ctx.provide("queueClock", createQueueClock());
  ctx.provide("models", () => ({ id: "scoped-model" }));
  ctx.provide("hostTools", overrides["packages/tool-runtime/src/index.ts"]);
  ctx.provide("agentPlugins", catalog);
  ctx.provide("agentSessions", sessions);
  const registry = new AgentRegistry((id, user, plugins) => createAgentInstance(ctx, ctx, id, user, plugins));
  return { ctx, registry };
}

const privateTool = {
  spec: { name: "private_marker", description: "仅本 Agent 可用", parameters: { type: "object", properties: {} } },
  async run() { return { content: "私有工具结果" }; }
};

test("工具注册按 Agent 隔离，同名扩展可共存，卸载插件只移除自己的工具", async () => {
  const unload = new Map();
  const catalog = new Map([["marker", {
    title: "注册私有工具",
    plugin: {
      inject: ["agentIdentity", "tools"],
      apply(ctx) {
        const { sessionId } = ctx.agentIdentity;
        const tool = { ...privateTool, spec: { ...privateTool.spec, description: sessionId } };
        ctx.tools.register(tool);
        assert.throws(() => ctx.tools.register(tool), /工具名称已注册/);
        assert.throws(() => ctx.tools.register({ ...tool, spec: { ...tool.spec, name: "read_file" } }), /工具名称已注册/);
        unload.set(sessionId, ctx.fiber.dispose);
      }
    }
  }]]);
  const { ctx, registry } = scopedHost(catalog);
  try {
    const a = (await registry.getOrCreate("A", "u", ["marker"])).agent.runtime.tools;
    const b = (await registry.getOrCreate("B", "u", ["marker"])).agent.runtime.tools;
    const c = (await registry.getOrCreate("C", "u")).agent.runtime.tools;
    assert.equal(a.findTool("private_marker").spec.description, "A");
    assert.equal(b.findTool("private_marker").spec.description, "B");
    assert.equal(c.findTool("private_marker"), undefined);
    assert.ok(a.toolsFor([]).some(({ name }) => name === "private_marker"));
    assert.ok(!a.toolsFor([], { private_marker: "禁用" }).some(({ name }) => name === "private_marker"));
    assert.ok(!c.toolsFor([]).some(({ name }) => name === "private_marker"));
    a.findTool("read_file").spec.description = "只修改目录副本";
    assert.notEqual(b.findTool("read_file").spec.description, "只修改目录副本");
    await unload.get("A")();
    assert.equal(a.findTool("private_marker"), undefined);
    assert.equal(registry.get("A", "u").status, "idle");
    assert.equal(b.findTool("private_marker").spec.description, "B");
    assert.ok(a.findTool("read_file"));
  } finally {
    await registry.disposeAll();
    await ctx.fiber.dispose();
  }
});

test("模型工具清单和执行查找只用当前 Agent 的工具目录", async () => {
  const executed = [];
  const catalog = new Map([["marker", {
    title: "注册私有工具",
    plugin: {
      inject: ["tools"],
      apply(ctx) {
        ctx.tools.register({
          ...privateTool,
          async run(args, toolContext) {
            executed.push(toolContext.sessionId);
            return privateTool.run(args, toolContext);
          }
        });
      }
    }
  }]]);
  const queueClock = createQueueClock();
  const registry = createRegistry(queueClock, catalog);
  const { request } = routeFixture({ agents: registry, agentSessions, queueClock });
  const a = store.createSession("u");
  const b = store.createSession("u");
  const original = routeState.provider;
  const { readSessionTrace } = load("packages/conversation-trace/src/projection.ts");
  try {
    assert.equal((await configureAgentPlugins(a.id, "u", ["marker"], catalog, registry)).status, "ok");
    for (const [session, enabled] of [[a, true], [b, false]]) {
      const requests = [];
      routeState.provider = { async *stream(options) {
        requests.push(options.tools.map(({ name }) => name));
        if (requests.length === 1) {
          yield { type: "tool_call", call: { id: "marker-call", name: "private_marker", arguments: "{}" } };
        } else {
          yield { type: "text", delta: "完成" };
        }
        yield { type: "done" };
      } };
      const response = await request({ sessionId: session.id, message: "工具测试" });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /"type":"done"/);
      assert.equal(requests[0].includes("private_marker"), enabled);
      const result = store.getSession(session.id, "u").messages.find((message) => message.role === "tool" && message.toolCallId === "marker-call");
      assert.match(result.content, enabled ? /私有工具结果/ : /没有叫 private_marker 的工具/);
    }
    assert.deepEqual(executed, [a.id]);
    const agentA = registry.get(a.id, "u");
    assert.equal(readSessionTrace(a.id, "u", false, agentA).schemas.private_marker.description, privateTool.spec.description);
    assert.equal(readSessionTrace(b.id, "u", false, agentA).schemas.private_marker, undefined);
  } finally {
    routeState.provider = original;
    await registry.disposeAll();
  }
});

test("独立 owner 关闭时释放本 Agent，轮次和队列通过注入的会话接口提交", { timeout: 5000 }, async () => {
  const writes = [];
  const unloaded = [];
  const port = {
    isArchived: () => false,
    newInputId: () => "注入的输入 ID",
    beginTurn(session, message, runId) {
      writes.push({ sessionId: session.id, inputId: message.id, runId });
    },
    record(event) { writes.push(event); }
  };
  const catalog = new Map([["watch", {
    title: "观察 owner",
    plugin: {
      inject: ["agentIdentity", "agentSession"],
      apply(ctx) {
        assert.equal(ctx.agentSession, port);
        ctx.effect(() => () => { unloaded.push(ctx.agentIdentity.sessionId); });
      }
    }
  }]]);
  const { ctx } = scopedHost(catalog, { bind: () => port });
  const ownerA = await ctx.plugin(function aOwner() {});
  const ownerB = await ctx.plugin(function bOwner() {});
  const registry = new AgentRegistry((id, user, plugins) => {
    const owner = id === "A" ? ownerA : ownerB;
    return createAgentInstance(ctx, owner.ctx, id, user, plugins);
  });
  const a = await registry.getOrCreate("A", "u", ["watch"]);
  const b = await registry.getOrCreate("B", "u", ["watch"]);
  const run = a.agent.openRun(new AbortController().signal);
  try {
    assert.equal(a.agent.enqueueInput(run.id, "等待执行", "next-turn"), true);
    const message = run.beginNext({ id: "A" });
    assert.equal(message.id, "注入的输入 ID");
    assert.equal(writes[0].kind, "queued");
    assert.deepEqual(writes[1], { sessionId: "A", inputId: message.id, runId: run.id });

    const cancelled = new Promise((resolve) => run.signal.addEventListener("abort", resolve, { once: true }));
    const disposal = ownerA.dispose();
    await cancelled;
    assert.deepEqual(unloaded, []);
    run.finish();
    await disposal;
    await a.closed;
    assert.deepEqual(unloaded, ["A"]);
    assert.equal(registry.get("A", "u"), undefined);
    assert.equal(registry.get("B", "u"), b.agent);
  } finally {
    run.finish();
    await registry.disposeAll();
    await ctx.fiber.dispose();
  }
});

test("并发创建共用 Scope，事件只交给本 Agent，关闭先等待运行再卸载", { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers();
  const ready = Promise.withResolvers();
  const events = [];
  const { ctx, registry } = scopedHost(new Map([["watch", {
    title: "观察",
    plugin: {
      inject: ["agentIdentity", "models"],
      async apply(ctx) {
        const { sessionId } = ctx.agentIdentity;
        assert.equal(ctx.models().id, "scoped-model");
        entered.resolve();
        await ready.promise;
        ctx.on("agent/event", (event) => events.push([sessionId, event.type]));
        ctx.effect(() => () => events.push([sessionId, "unload"]));
      }
    }
  }]]));
  const first = registry.getOrCreate("A", "u", ["watch"]);
  const concurrent = registry.getOrCreate("A", "u", ["watch"]);
  let run;
  try {
    await entered.promise;
    assert.equal(first, concurrent);
    assert.equal(registry.get("A", "u"), undefined);
    const b = await registry.getOrCreate("B", "u");
    ready.resolve();
    const a = await first;
    a.agent.runtime.emitEvent({ type: "done" });
    b.agent.runtime.emitEvent({ type: "done" });
    assert.deepEqual(events, [["A", "done"]]);
    run = a.agent.openRun(new AbortController().signal);
    const disposal = a.dispose();
    assert.equal(run.signal.aborted, true);
    assert.equal(a.agent.status, "closing");
    assert.deepEqual(events, [["A", "done"]]);
    run.finish();
    await disposal;
    assert.deepEqual(events, [["A", "done"], ["A", "unload"]]);
    b.agent.runtime.emitEvent({ type: "done" });
    assert.equal(events.length, 2);
    assert.equal(registry.get("A", "u"), undefined);
    assert.equal(registry.get("B", "u"), b.agent);
  } finally {
    ready.resolve();
    run?.finish();
    await registry.disposeAll();
    await ctx.fiber.dispose();
  }
});

test("插件初始化失败释放已注册资源，Registry 可为同一会话重试", async () => {
  const disposed = [];
  const { ctx, registry } = scopedHost(new Map([
    ["first", { title: "先加载", plugin(ctx) { ctx.effect(() => () => disposed.push("已清理")); } }],
    ["missing", { title: "缺少依赖", plugin: { inject: ["notAvailable"], apply() {} } }]
  ]));
  try {
    await assert.rejects(registry.getOrCreate("failed", "u", ["first", "missing"]), /插件依赖不可用/);
    assert.deepEqual(disposed, ["已清理"]);
    assert.equal(registry.get("failed", "u"), undefined);
    const replacement = await registry.getOrCreate("failed", "u");
    assert.equal(replacement.agent.status, "idle");
  } finally {
    await registry.disposeAll();
    await ctx.fiber.dispose();
  }
});

test("Cordis 根 Context 关闭时等待 Agent 归还运行权，再卸载插件", { timeout: 5000 }, async () => {
  const events = [];
  const { ctx, registry } = scopedHost(new Map([["watch", {
    title: "观察关闭",
    plugin(ctx) {
      ctx.effect(() => () => { events.push("unload"); });
    }
  }]]));
  ctx.effect(() => () => registry.disposeAll());
  const handle = await registry.getOrCreate("shutdown", "u", ["watch"]);
  const run = handle.agent.openRun(new AbortController().signal);
  const cancelled = new Promise((resolve) => run.signal.addEventListener("abort", resolve, { once: true }));
  const closed = ctx.fiber.dispose();
  try {
    await cancelled;
    assert.equal(handle.agent.status, "closing");
    assert.deepEqual(events, []);
  } finally {
    run.finish();
    await closed;
  }
  assert.deepEqual(events, ["unload"]);
  assert.equal(registry.get("shutdown", "u"), undefined);
});

test("初始化中收到释放请求时，Scope 清理后撤销登记，不发布实例", { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers();
  const finishSetup = Promise.withResolvers();
  let unloaded = false;
  const { ctx, registry } = scopedHost(new Map([["slow", {
    title: "异步初始化",
    async plugin(ctx) {
      ctx.effect(() => () => { unloaded = true; });
      entered.resolve();
      await finishSetup.promise;
    }
  }]]));
  const pending = registry.getOrCreate("pending", "u", ["slow"]);
  const rejection = assert.rejects(pending, /Agent 已关闭/);
  try {
    await entered.promise;
    const disposal = registry.dispose("pending", "u");
    await assert.rejects(registry.getOrCreate("pending", "u"), /正在关闭/);
    finishSetup.resolve();
    await disposal;
    await rejection;
    assert.equal(unloaded, true);
    assert.equal(registry.get("pending", "u"), undefined);
  } finally {
    finishSetup.resolve();
    await registry.disposeAll();
    await ctx.fiber.dispose();
  }
});

test("按会话持久化插件选择并进入实际模型请求，忙碌时保留原配置", async () => {
  const a = store.createSession("u");
  const b = store.createSession("u");
  const { request } = routeFixture();
  const original = routeState.provider;
  const prompts = [];
  routeState.provider = { async *stream(options) {
    prompts.push(JSON.stringify(options.messages[0]));
    yield { type: "text", delta: "回答" };
    yield { type: "done" };
  } };
  const configure = (id, enabled) => configureAgentPlugins(id, "u", enabled, builtinAgentPlugins, agents);
  try {
    for (const [session, id] of [[a, "concise-replies"], [b, "structured-replies"]]) {
      assert.equal((await configure(session.id, [id])).status, "ok");
      assert.deepEqual(readAgentPlugins(session.id, "u"), [id]);
      const response = await request({ sessionId: session.id, message: "测试" });
      assert.equal(response.status, 200);
      const stream = await response.text();
      assert.match(stream, /"type":"done"/);
      assert.doesNotMatch(stream, /"type":"error"/);
    }
    assert.match(prompts[0], /答复时先给结论/);
    assert.doesNotMatch(prompts[0], /用简短的小标题组织/);
    assert.match(prompts[1], /用简短的小标题组织/);
    assert.doesNotMatch(prompts[1], /答复时先给结论/);

    const agent = agents.get(a.id, "u");
    const run = agent.openRun(new AbortController().signal);
    try {
      assert.equal((await configure(a.id, [])).status, "busy");
      assert.deepEqual(readAgentPlugins(a.id, "u"), ["concise-replies"]);
    } finally {
      run.finish();
    }
    assert.equal((await configure(a.id, [])).status, "ok");
    assert.equal(agents.get(a.id, "u"), undefined);
    await (await request({ sessionId: a.id, message: "关闭插件后继续" })).text();
    assert.doesNotMatch(prompts[2], /答复时先给结论/);
    assert.deepEqual(readAgentPlugins(b.id, "u"), ["structured-replies"]);
  } finally {
    routeState.provider = original;
    await agents.dispose(a.id, "u");
    await agents.dispose(b.id, "u");
  }
});
