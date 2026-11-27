import assert from "node:assert/strict";
import { test } from "node:test";
import { data, load, runAgent, store } from "../../../tests/fixtures/agent-runtime.mjs";

const { buildContext } = load("packages/context-engine/src/context.ts");
const { deriveWorkingState, formatWorkingState } = load("packages/context-engine/src/working-state.ts");
const { createConversationTrace } = load("packages/conversation-trace/src/recorder.ts");
const { listTraceEntries, readTraceEntry } = load("packages/conversation-trace/src/store.ts");
const { searchSavedHistory, readSavedHistoryExecution } = load("packages/tools/src/history.ts");

test("简单纯文本问答不生成工作态，系统提示词不被额外注入", () => {
  const history = [
    { id: "u1", role: "user", content: "你好，介绍一下你自己", createdAt: 1 },
    { id: "a1", role: "assistant", content: "你好，我是 A.ai。", createdAt: 2 },
    { id: "u2", role: "user", content: "谢谢", createdAt: 3 },
  ];
  assert.equal(deriveWorkingState(history), null);
  const ctx = buildContext(history, "固定系统提示", { inputId: "u2" });
  assert.equal(ctx.hasWorkingState, false);
  assert.equal(ctx.messages[0].content, "固定系统提示");
});

test("工作态跟踪目标、计划、文件、失败尝试与产出，约束变化后旧计划和旧验证显式失效", () => {
  const history = [
    { id: "u1", role: "user", content: "整理销售数据并输出汇总脚本", createdAt: 1 },
    { id: "a1", role: "assistant", content: "", createdAt: 2, toolCalls: [
      { id: "t-plan", name: "todo_write", arguments: "{}" },
      { id: "t-read", name: "read_file", arguments: JSON.stringify({ path: "data/orders.csv" }) },
      { id: "t-write", name: "write_file", arguments: JSON.stringify({ path: "scripts/calc.py", content: "print(1)" }) },
      { id: "t-run", name: "run_python", arguments: JSON.stringify({ code: "exec(open('scripts/calc.py').read())" }) },
      { id: "t-fail", name: "web_fetch", arguments: JSON.stringify({ url: "https://example.invalid/spec" }) },
    ] },
    { id: "r-plan", role: "tool", toolCallId: "t-plan", status: "ok", createdAt: 3, content: JSON.stringify({
      todos: [
        { content: "读取 orders.csv", status: "completed" },
        { content: "生成最终图表", status: "in_progress" },
      ],
    }) },
    { id: "r-read", role: "tool", toolCallId: "t-read", status: "ok", createdAt: 4, content: "ok" },
    { id: "r-write", role: "tool", toolCallId: "t-write", status: "ok", createdAt: 5, content: '{"path":"scripts/calc.py"}' },
    { id: "r-run", role: "tool", toolCallId: "t-run", status: "ok", createdAt: 6, content: '{"exitCode":0,"stdout":"1"}' },
    { id: "r-fail", role: "tool", toolCallId: "t-fail", status: "error", isError: true, createdAt: 7, content: '{"error":"连接超时"}' },
    { id: "u-req", role: "user", content: "/任务要求 改成只统计华东地区", taskRequirements: "改成只统计华东地区", createdAt: 8 },
    { id: "u2", role: "user", content: "按新约束继续", createdAt: 9 },
  ];
  const artifacts = [{ id: "art1", title: "销售报告", kind: "markdown", content: "# 报告", file: "output/report.md", createdAt: 6, sourceToolCallId: "t-write" }];

  const ctx = buildContext(history, "基础提示", { inputId: "u2", artifacts });
  assert.equal(ctx.hasWorkingState, true);
  const sys = ctx.messages[0].content;
  assert.match(sys, /## 当前任务工作态/);
  assert.match(sys, /整理销售数据并输出汇总脚本/);
  assert.match(sys, /已过时：生成于最新约束之前/);
  assert.match(sys, /scripts\/calc\.py\(写·验证已过时\)/);
  assert.match(sys, /data\/orders\.csv\(读\)/);
  assert.match(sys, /web_fetch\(https:\/\/example\.invalid\/spec\) \[error\]：连接超时/);
  assert.match(sys, /销售报告\(output\/report\.md\)/);
  // 显式任务要求始终位于工作态之后，保持最高优先级
  assert.ok(sys.indexOf("## 当前任务工作态") < sys.indexOf("## 当前任务要求"));

  const fullState = deriveWorkingState(history, artifacts);
  assert.equal(fullState.plan.stale, true);
  assert.equal(fullState.files.find((f) => f.path === "scripts/calc.py").staleVerification, true);
  assert.ok(formatWorkingState(fullState).includes("生成最终图表"));
});

test("slim() 遇到 /任务要求 指令不误判 turnStart，避免提前裁剪刚执行完的轮次", () => {
  const longResult = "结果详情".repeat(800);
  const history = [
    { id: "u1", role: "user", content: "读取长日志", createdAt: 1 },
    { id: "a1", role: "assistant", content: "正在查看", reasoning: "当前轮推理内容", createdAt: 2, toolCalls: [
      { id: "c1", name: "read_file", arguments: JSON.stringify({ path: "app.log" }) },
    ] },
    { id: "r1", role: "tool", toolCallId: "c1", status: "ok", content: longResult, createdAt: 3 },
    { id: "req", role: "user", content: "/任务要求 保留完整细节", taskRequirements: "保留完整细节", createdAt: 4 },
  ];
  const ctx = buildContext(history, "系统提示", { inputId: "u1" });
  const assistant = ctx.messages.find((m) => m.role === "assistant");
  const toolMsg = ctx.messages.find((m) => m.role === "tool");
  assert.equal(assistant.reasoning, "当前轮推理内容");
  assert.equal(toolMsg.content, longResult);
});

test("同轮内历史召回卡片数量锁定保护前缀缓存，且对话轨迹完整记录上下文治理指标", async () => {
  const s = store.createSession("u");
  const append = (role, content, more = {}) => {
    const m = { id: store.newId("m"), role, content, createdAt: Date.now(), ...more };
    store.addMessage(s, m);
    return m;
  };
  const old1 = append("user", "京都财务台账 ledger_alpha.csv 盘点");
  append("assistant", "", { toolCalls: [{ id: "old-c1", name: "read_file", arguments: '{"path":"ledger_alpha.csv"}' }] });
  append("tool", "旧记录 1", { toolCallId: "old-c1", status: "ok" });
  const old2 = append("user", "京都财务台账 ledger_beta.csv 复核");
  append("assistant", "", { toolCalls: [{ id: "old-c2", name: "read_file", arguments: '{"path":"ledger_beta.csv"}' }] });
  append("tool", "旧记录 2", { toolCallId: "old-c2", status: "ok" });
  const keep = append("user", "近期问题");
  append("assistant", "", { toolCalls: [{ id: "keep-c1", name: "read_file", arguments: '{"path":"summary_notes.md"}' }] });
  append("tool", "近期已读摘要笔记", { toolCallId: "keep-c1", status: "ok" });
  append("user", "已保存摘要", {
    feedback: { kind: "compact", summary: "整理完成" },
    compact: { keepFrom: keep.id, messages: 6, tokensBefore: 5000, tokensAfter: 800 },
  });
  const current = append("user", "请复查京都财务台账 ledger_alpha.csv 和 ledger_beta.csv");

  const echoTool = {
    spec: { name: "echo_step", description: "返回中等长度正文", parameters: { type: "object", properties: { tag: { type: "string" } } } },
    parallelSafe: true,
    run: async ({ tag }) => ({ content: `step-${tag}: ` + "数据".repeat(320) }),
  };
  const known = [echoTool, searchSavedHistory, readSavedHistoryExecution];
  const specs = () => known.map((t) => t.spec);
  const trace = createConversationTrace({ sessionId: s.id, runId: "run-ctx-obs", inputId: current.id, model: "test", effort: "default" });

  let step = 0;
  const seenTurnInputs = [];
  const provider = {
    id: "test",
    async *stream({ messages }) {
      step++;
      const turnInput = messages.find((m) => m.role === "user" && m.content.startsWith(current.content));
      seenTurnInputs.push(turnInput.content);
      if (step <= 2) {
        yield { type: "tool_call", call: { id: `echo-${step}`, name: "echo_step", arguments: JSON.stringify({ tag: String(step) }) } };
        yield { type: "done", finishReason: "tool_calls", usage: { inputTokens: 1200 + step * 300, outputTokens: 80 } };
        return;
      }
      yield { type: "text", delta: "已完成复查" };
      yield { type: "done", finishReason: "stop", usage: { inputTokens: 2000, outputTokens: 40 } };
    },
  };

  for await (const event of runAgent({
    session: s,
    provider,
    userId: "u",
    workspace: data,
    multiAgent: false,
    contextWindow: 16_000,
    maxSteps: 5,
    conversationTrace: trace,
    execution: { runId: "run-ctx-obs", inputId: current.id },
    tools: { toolsFor: specs, toolSpecs: specs, deferredCatalog: () => "", findTool: (name) => known.find((t) => t.spec.name === name) },
  })) {
    assert.notEqual(event.type, "error", event.message);
  }

  assert.equal(step, 3);
  // 同轮 3 步中本轮输入（含锁定后的召回卡片与环境快照）逐字一致，不破坏前缀缓存
  assert.ok(seenTurnInputs[0].includes(old1.id) || seenTurnInputs[0].includes(old2.id));
  assert.equal(seenTurnInputs[1], seenTurnInputs[0]);
  assert.equal(seenTurnInputs[2], seenTurnInputs[0]);

  const entries = listTraceEntries(s.id, "u");
  assert.equal(entries.length, 3);
  const firstDetail = readTraceEntry(s.id, "u", entries[0].id, true);
  assert.equal(firstDetail.kind, "request");
  assert.equal(firstDetail.request.agent.budgetMode, "normal");
  assert.equal(firstDetail.request.agent.hasWorkingState, true);
  assert.equal(firstDetail.request.agent.compactCount, 1);
  assert.ok(firstDetail.request.agent.recalledCards >= 1);
  assert.ok(firstDetail.request.agent.hardLimit > 0);
  assert.ok(firstDetail.request.agent.outputReserve > 0);
  assert.ok(firstDetail.request.agent.calibratedInputTokens > 0);

  const secondDetail = readTraceEntry(s.id, "u", entries[1].id, true);
  // 第 1 步上报了真实 usage，第 2 步记录了校准系数且系统提示词未变
  assert.ok(secondDetail.request.agent.inputScale >= 1);
  assert.equal(secondDetail.context.previous.systemChanged, false);
});
