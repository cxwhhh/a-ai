import assert from "node:assert/strict";
import { writeFile as saveFixture } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { load, overrides, store } from "../../../tests/fixtures/agent-runtime.mjs";

const { openSessionWorkspace } = load("packages/workspace/src/session-workspace.ts");
const { budgetLimits, EXECUTION_TOOLS, MAX_TASK_TOKENS, ROLES } = load("packages/subagent/src/role-budget.ts");
const { parseTaskContract } = load("packages/subagent/src/task-contract.ts");
const { capabilityScope } = load("packages/subagent/src/capability-scope.ts");
const { readFile: readText, writeFile, editFile } = load("packages/tools/src/files.ts");
const { writeDocument } = load("packages/tools/src/write-document.ts");
const { runPython } = load("packages/tools/src/run-python.ts");
const { runCommand } = load("packages/tools/src/run-command.ts");
const sandbox = load("packages/sandbox/src/sandbox.ts");

function useAllExecTools() {
  const registry = overrides["packages/tool-runtime/src/index.ts"];
  const saved = { ...registry };
  const extra = [readText, writeFile, editFile, writeDocument, runPython, runCommand];
  const byName = new Map(extra.map((t) => [t.spec.name, t]));
  registry.findTool = (name) => byName.get(name) ?? saved.findTool(name);
  registry.toolSpecs = () => [...saved.toolSpecs().filter(({ name }) => !byName.has(name)), ...extra.map(({ spec }) => spec)];
  return () => Object.assign(registry, saved);
}

test("role-budget 与 parseTaskContract 按角色分配步数、工具次数和 256k 累计预算上限", () => {
  // 只读角色保持 16 默认 / 24 上限，默认 tokens 等于 max(48k, contextWindow)
  assert.deepEqual(
    { steps: budgetLimits("research", {}, 32_000).steps, toolCalls: budgetLimits("research", {}, 32_000).toolCalls, tokens: budgetLimits("research", {}, 32_000).tokens },
    { steps: 8, toolCalls: 16, tokens: 48_000 },
  );
  assert.equal(budgetLimits("review", {}, 128_000).tokens, 128_000);
  assert.equal(budgetLimits("analysis", { tokens: 12_000 }, 128_000).tokens, 12_000);

  // implementation 角色默认 24 步、36 工具次数（上限 48），默认累计额度按双倍窗口且不超过 MAX_TASK_TOKENS
  const impl128k = budgetLimits("implementation", {}, 128_000);
  assert.equal(impl128k.steps, 24);
  assert.equal(impl128k.toolCalls, 36);
  assert.equal(impl128k.tokens, 256_000);
  assert.equal(budgetLimits("implementation", {}, 200_000).tokens, MAX_TASK_TOKENS);
  assert.equal(budgetLimits("implementation", {}, 32_000).tokens, 64_000);
  assert.equal(budgetLimits("implementation", { tokens: 100_000, toolCalls: 48 }, 128_000).tokens, 100_000);
  assert.equal(budgetLimits("implementation", { toolCalls: 48 }, 128_000).toolCalls, 48);

  // 契约边界校验
  assert.equal(parseTaskContract({ task: "大执行", role: "implementation", budget: { steps: 24, toolCalls: 48, tokens: 256_000 } }).budget.toolCalls, 48);
  assert.throws(() => parseTaskContract({ task: "超工具数", role: "implementation", budget: { toolCalls: 49 } }), /toolCalls/);
  assert.throws(() => parseTaskContract({ task: "只读超工具数", role: "review", budget: { toolCalls: 25 } }), /toolCalls/);
  assert.throws(() => parseTaskContract({ task: "超 token 上限", role: "implementation", budget: { tokens: MAX_TASK_TOKENS + 1 } }), /tokens/);
});

test("capabilityScope 在 readOnlyFollowup 下彻底屏蔽执行工具，并按沙箱模式精确开放能力", async () => {
  const session = store.createSession("u");
  const { workspace } = openSessionWorkspace("u", session.id);
  await saveFixture(path.join(workspace, "app.ts"), "export const x = 1;\n");
  const restoreTools = useAllExecTools();
  const realMode = sandbox.sandboxInfo;

  try {
    // 1) Docker 模式下，普通只读续聊即使省略 tools 也绝不暴露任何 EXECUTION_TOOLS
    sandbox.sandboxInfo = () => ({ ...realMode(), mode: "docker" });
    const followupScope = capabilityScope(
      { task: "解释刚才的改动", role: "implementation", paths: ["app.ts"] },
      ROLES.implementation.tools,
      { workspace, disabled: {}, readOnlyFollowup: true },
    );
    const followupNames = followupScope.specs.map(({ name }) => name);
    assert.ok(followupNames.includes("read_file"));
    for (const name of EXECUTION_TOOLS) {
      assert.ok(!followupNames.includes(name), `readOnlyFollowup 不应暴露 ${name}`);
      assert.equal(followupScope.find(name), undefined);
    }

    // readOnlyFollowup 误传 writePaths 直接报 403
    assert.throws(
      () => capabilityScope(
        { task: "越权续聊", role: "implementation", paths: ["app.ts"], writePaths: ["app.ts"] },
        ROLES.implementation.tools,
        { workspace, disabled: {}, readOnlyFollowup: true },
      ),
      /只有 implementation 可声明 writePaths/,
    );

    // 2) 正常 implementation 在三种沙箱模式下的能力差异
    const implContract = { task: "修改并验证", role: "implementation", paths: ["app.ts"], writePaths: ["app.ts"] };

    sandbox.sandboxInfo = () => ({ ...realMode(), mode: "docker" });
    const dockerScope = capabilityScope(implContract, ROLES.implementation.tools, { workspace, disabled: {} });
    assert.ok(dockerScope.find("run_python"));
    assert.ok(dockerScope.find("run_command"));
    assert.ok(dockerScope.specs.find(({ name }) => name === "run_command").parameters.properties.outputs);

    sandbox.sandboxInfo = () => ({ ...realMode(), mode: "seatbelt" });
    const seatbeltScope = capabilityScope(implContract, ROLES.implementation.tools, { workspace, disabled: {} });
    assert.equal(seatbeltScope.find("run_python"), undefined);
    assert.ok(seatbeltScope.find("run_command"));
    assert.equal(seatbeltScope.specs.find(({ name }) => name === "run_command").parameters.properties.outputs, undefined);

    sandbox.sandboxInfo = () => ({ ...realMode(), mode: "local" });
    const localScope = capabilityScope(implContract, ROLES.implementation.tools, { workspace, disabled: {} });
    assert.equal(localScope.find("run_python"), undefined);
    assert.equal(localScope.find("run_command"), undefined);
    assert.ok(localScope.find("write_file"));
    assert.ok(localScope.find("edit_file"));
  } finally {
    sandbox.sandboxInfo = realMode;
    restoreTools();
  }
});
