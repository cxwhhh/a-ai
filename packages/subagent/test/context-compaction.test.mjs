import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "../../../tests/fixtures/agent-runtime.mjs";

const { planChildCompaction, validateChildCompaction, readEvidence, boundedContext } = load("packages/subagent/src/context-boundary.ts");

const toolGroup = (step, calls) => [
  { role: "assistant", content: `第 ${step} 步思考`, toolCalls: calls.map((id) => ({ id, name: "read_file", arguments: `{"path":"f${id}.txt"}` })) },
  ...calls.map((id) => ({ role: "tool", toolCallId: id, content: `[E${step}.1]\n工具回执 ${id}` })),
];

test("planChildCompaction 保留前缀与最近两组完整工具调用，绝不拆散 assistant 与 tool 配对", () => {
  const prefix = [
    { role: "system", content: "系统提示" },
    { role: "user", content: "任务目标" },
    { role: "user", content: "继承资料" },
  ];

  // 不足 4 组不触发压缩
  const shortHistory = [...prefix, ...toolGroup(1, ["c1"]), ...toolGroup(2, ["c2"]), ...toolGroup(3, ["c3"])];
  assert.equal(planChildCompaction(shortHistory, prefix.length), null);

  // 4 组完整调用（含单步多并行工具调用）+ 尾部用户补充
  const g1 = toolGroup(1, ["c1a", "c1b"]);
  const g2 = toolGroup(2, ["c2"]);
  const g3 = toolGroup(3, ["c3a", "c3b"]);
  const g4 = toolGroup(4, ["c4"]);
  const tailNote = { role: "user", content: "【用户直接补充】请保留口径" };
  const full = [...prefix, ...g1, ...g2, ...g3, ...g4, tailNote];

  const plan = planChildCompaction(full, prefix.length);
  assert.ok(plan);
  assert.deepEqual(plan.prefix, prefix);
  // 应折叠 g1 + g2 + g3，保留最近 2 组（g4 与 tailNote）
  assert.deepEqual(plan.part, [...g1, ...g2, ...g3]);
  assert.deepEqual(plan.tail, [...g4, tailNote]);

  // 确认折叠段与保留段各自的 assistant toolCalls 与 tool 回执均成对完整
  for (const segment of [plan.part, plan.tail]) {
    const declared = new Set(segment.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)));
    const returned = new Set(segment.filter((m) => m.role === "tool").map((m) => m.toolCallId));
    assert.deepEqual(returned, declared);
  }
});

test("validateChildCompaction 校验原文引文、兼容 JSON 包装和围栏，过滤幻觉引用", () => {
  const excerpts = new Map([
    ["E1.1", "2026 年 Q3 营收为  1,250 万元，同比增长 18%。"],
    ["E2.1", JSON.stringify({ path: "src/math.ts", content: "export const add = (a, b) => a + b;" })],
  ]);

  const fenced = "```json\n" + JSON.stringify({
    summary: "  已完成营收与代码读取  ",
    confirmedEvidence: [
      { id: "E1.1", quote: "营收为 1,250 万元" }, // 空白规范化后可匹配
      { id: "E2.1", quote: "add = (a, b) => a + b" }, // JSON content 字段内可匹配
      { id: "E1.1", quote: "营收为 9,999 万元" }, // 幻觉引文 -> 应被过滤
      { id: "E9.9", quote: "不存在的编号" }, // 不存在的证据编号 -> 应被过滤
    ],
    completedSteps: ["读取财报", "", "读取源码"],
    writtenFiles: ["src/math.ts"],
    pending: ["运行单元测试"],
  }) + "\n```";

  const validated = JSON.parse(validateChildCompaction(fenced, excerpts));
  assert.equal(validated.summary, "已完成营收与代码读取");
  assert.deepEqual(validated.confirmedEvidence, [
    { id: "E1.1", quote: "营收为 1,250 万元" },
    { id: "E2.1", quote: "add = (a, b) => a + b" },
  ]);
  assert.deepEqual(validated.completedSteps, ["读取财报", "读取源码"]);
  assert.deepEqual(validated.writtenFiles, ["src/math.ts"]);
  assert.deepEqual(validated.pending, ["运行单元测试"]);

  // 格式非法或缺少 summary 时抛错以触发安全降级
  assert.throws(() => validateChildCompaction("[]", excerpts), /JSON 对象/);
  assert.throws(() => validateChildCompaction('{"summary":"   "}', excerpts), /缺少 summary/);
  assert.throws(() => validateChildCompaction("不是 JSON", excerpts));
});

test("readEvidence 与 boundedContext 在压缩后仍支持关键词定位、分页回读与已引用引文钉住", () => {
  const marker = "CRITICAL-ANCHOR-9001";
  const longText = "常规日志前导段落。".repeat(260) + `\n${marker} 关键结论在此。\n` + "后续归档说明。".repeat(260);
  const excerpts = new Map([["E1.1", longText]]);

  // 关键词定位
  const hit = readEvidence({ evidenceId: "E1.1", query: marker }, excerpts);
  assert.match(hit, /^\[原文 E1\.1\]/);
  assert.ok(hit.includes(marker));
  assert.match(hit, /nextOffset=\d+/);

  // 分页读取
  const page1 = readEvidence({ evidenceId: "E1.1", offset: 0 }, excerpts);
  const next = Number(/nextOffset=(\d+)/.exec(page1)?.[1]);
  assert.ok(next > 0);
  const page2 = readEvidence({ evidenceId: "E1.1", offset: next }, excerpts);
  assert.match(page2, /^\[原文 E1\.1\]/);

  // 越权编号、未命中关键词与越界偏移均明确报错
  assert.throws(() => readEvidence({ evidenceId: "E9.9" }, excerpts), /不在当前子任务的可用范围内/);
  assert.throws(() => readEvidence({ evidenceId: "E1.1", query: "NO-SUCH-WORD" }, excerpts), /没有找到这个关键词/);
  assert.throws(() => readEvidence({ evidenceId: "E1.1", offset: longText.length + 10 }, excerpts), /已读到末尾/);

  // boundedContext 在极紧预算下仍钉住已引用引文
  const packed = boundedContext(
    [{ role: "tool", content: `[E1.1]\n${longText}` }],
    undefined,
    300,
    { terms: ["关键结论"], quotes: new Map([["E1.1", [`${marker} 关键结论在此。`]]]) },
  );
  assert.equal(packed.compactedEvidence, true);
  assert.ok(packed.messages[0].content.includes(marker));
  assert.ok(packed.messages[0].content.includes("read_evidence"));
});
