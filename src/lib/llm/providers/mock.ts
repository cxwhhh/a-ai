import type { ChatRequest, LLMProvider, StreamChunk, ToolCall } from "../types";
import { estimateTokens } from "../../tokens";
import { FEEDBACK_TAG } from "../../agent/verify";
import { NOTE_TAG } from "../../server/notes";
import { ENV_RE, PLAN_MARK } from "../../agent/steer";

/**
 * 假模型：不联网，按关键字走固定“剧本”，用来在没接 API 时演示完整的 agent 链路。
 * 它和真模型遵守完全相同的协议：看到工具结果后决定下一步，所以 agent 循环、界面都是真实运行的。
 *
 * 试试这些输入：
 *   演示全部工具        → 时间 → 计算 → Python → 写文件 → 列目录 → 右栏报告（6 步链路）
 *   做一个网页 / 写一份文档 / 写段代码 → 时间 → 右栏产出
 *   算一下 (12.5*4)^2/sqrt(16)       → 计算器
 *   现在几点                          → 时间
 *   读一下 https://example.com       → 网页抓取
 *   用 python 运行 / 看看工作区文件
 *   演示终端                          → 只读命令直接跑 → 写文件的命令先请你确认 → 实时输出 → cd 被保留
 *   演示自动修复                      → 写出有 bug 的代码 → 运行报错 → 自动检查打回 → 修复 → 运行通过
 *   演示提问                          → agent 用 ask_user 问你要什么格式 → 你选 / 补充 → 按回答生成
 *   演示全部工具（做完后）            → 后台把这次的做法总结成技能「工具链路报告」→ 设置 → 技能 里确认启用 →
 *                                       再说一次“演示全部工具”，第一步先 load_skill 读取技能再做
 */
export class MockProvider implements LLMProvider {
  readonly id = "mock";

  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    const { signal } = req;
    const msgs = req.messages;
    // 整理长期记忆的请求（src/lib/agent/reflect.ts 的 REFLECT_TAG）：返回一份 JSON
    if (msgs[0]?.content.startsWith("[A.ai:reflect]")) {
      await sleep(200, signal);
      const out = mockReflect(msgs[1]?.content ?? "");
      yield { type: "text", delta: out };
      yield { type: "done", finishReason: "stop", usage: { estimated: true, inputTokens: estimateTokens(msgs.map((m) => m.content).join("")), outputTokens: estimateTokens(out) } };
      return;
    }
    // 技能学习的请求（src/lib/agent/learn.ts 的 LEARN_TAG）：总结 / 改进技能，返回 JSON
    if (msgs[0]?.content.startsWith("[A.ai:learn]")) {
      await sleep(200, signal);
      const out = mockLearn(msgs[1]?.content ?? "");
      yield { type: "text", delta: out };
      yield { type: "done", finishReason: "stop", usage: { estimated: true, inputTokens: estimateTokens(msgs.map((m) => m.content).join("")), outputTokens: estimateTokens(out) } };
      return;
    }
    // 上下文压缩的请求（src/lib/agent/context.ts 的 COMPACT_TAG）：把用户说过的话列成摘要
    if (msgs[0]?.content.startsWith("[A.ai:compact]")) {
      await sleep(200, signal);
      const asks = (msgs[1]?.content ?? "").split("\n").filter((l) => l.startsWith("[用户]")).map((l) => "- " + l.slice(4).trim().slice(0, 80));
      const out = `### 用户的要求\n${asks.join("\n") || "- （无）"}\n\n### 进展\n- Mock 模型的演示摘要：真实模型会在这里总结已完成的事、改过的文件和待办。`;
      yield { type: "text", delta: out };
      yield { type: "done", finishReason: "stop", usage: { estimated: true, inputTokens: estimateTokens(msgs.map((m) => m.content).join("")), outputTokens: estimateTokens(out) } };
      return;
    }
    // 剧本模式（测试执行层用）：用户消息以 [A.ai:script] 开头，后面是 JSON，按步骤原样发出工具调用。见 evals/harness.json
    const script = scriptOf(msgs);
    if (script) {
      yield* script;
      return;
    }
    // 自动检查的反馈、运行中的补充想法也是 role=user，但不是用户的新问题：往前找真正的用户消息
    const u = lastIndex(msgs, (m) => m.role === "user" && !m.content.startsWith(FEEDBACK_TAG) && !m.content.startsWith(NOTE_TAG));
    // 去掉系统附上的环境快照（时间、文件列表），只看用户自己写的话
    const userText = (msgs[u]?.content ?? "").replace(ENV_RE, "");
    // load_skill、load_tools 那一步不算剧本里的步骤：先读技能 / 加载工具，再照常走剧本
    const skillIds = new Set(msgs.flatMap((m) => m.toolCalls ?? []).filter((c) => c.name === "load_skill" || c.name === "load_tools").map((c) => c.id));
    const isSkillStep = (m: (typeof msgs)[number]) => !!m.toolCalls?.some((c) => skillIds.has(c.id)) || (m.role === "tool" && skillIds.has(m.toolCallId ?? ""));
    const after = msgs.slice(u + 1).filter((m) => !isSkillStep(m));
    const loadedSkill = msgs.slice(u + 1).some((m) => m.toolCalls?.some((c) => c.name === "load_skill"));
    // 第一步写的规划不算执行步骤：剧本从规划之后的第一步开始
    const planned = after.some((m) => m.role === "assistant" && m.content.startsWith(PLAN_MARK));
    const step = after.filter((m) => m.role === "assistant").length - (planned ? 1 : 0);
    const results = after.filter((m) => m.role === "tool").map((m) => parse(m.content));
    // 能用的工具 = 已经发来说明书的 + 系统提示词「按需加载的工具」目录里的（要先 load_tools 才有说明书）
    const sent = new Set(req.tools?.map((t) => t.name));
    const catalog = deferredNames(msgs[0]?.role === "system" ? msgs[0].content : "");
    const available = new Set([...sent, ...(sent.has("load_tools") ? catalog : [])]);

    await sleep(350, signal); // 模拟网络与首字延迟

    // 用量：真模型由 API 返回；这里按字数粗略估算，让“用量”页面有数据可看
    const input = estimateTokens(msgs.map((m) => m.content).join("") + JSON.stringify(req.tools ?? []));

    // 上一轮以 ask_user 结束 → 这条用户消息是对问题的回答
    const answered = msgs[u - 1]?.role === "tool" && msgs[u - 1].content.includes('"waiting_for_user"');
    if ((answered || /演示提问|提问演示|交互演示/.test(userText)) && available.has("ask_user")) {
      const notes = after.filter((m) => m.role === "user" && m.content.startsWith(NOTE_TAG)).map((m) => m.content.slice(NOTE_TAG.length));
      yield* askDemo(answered ? userText : null, step, notes, input, signal);
      return;
    }

    if (/自动修复|反馈闭环|修复演示/.test(userText) && available.has("run_python")) {
      yield* fixDemo(msgs[msgs.length - 1], results, input, signal);
      return;
    }

    // 学会过对得上的技能（系统提示词里的技能目录）：像真实模型一样，动手前先 load_skill 读取步骤
    const skill = !loadedSkill && step === 0 && !planned && available.has("load_skill") ? matchSkill(msgs[0]?.role === "system" ? msgs[0].content : "", userText) : null;
    if (skill) {
      const c = call("load_skill", { purpose: `这个任务和学过的技能「${skill}」对得上，先读取它的步骤`, name: skill });
      yield* stream("reasoning", `用户的请求和我学过的技能「${skill}」对得上。先读取技能里的步骤和注意事项，再按步骤做。`, signal);
      yield { type: "tool_call", call: c };
      yield { type: "done", finishReason: "tool_calls", usage: { estimated: true, inputTokens: input, outputTokens: estimateTokens(c.arguments) } };
      return;
    }

    const plan = makePlan(userText).filter((s) => available.has(s.tool));
    // 演示全部工具是 6 步的复杂任务：像真实模型一样，第一步先写规划、不调用工具
    if (!planned && step === 0 && plan.length > 3) {
      const text = `${PLAN_MARK}\n目标：依次调用 ${plan.length} 个工具，最后生成一份报告。\n已知：工作区和时间都在环境信息里，工具都可用。\n缺什么：时间、计算结果、Python 输出要实际调用工具拿到。\n路线：${plan.map((s) => s.tool).join(" → ")}。`;
      yield* stream("reasoning", "这是一个多步任务，先写规划再动手。", signal);
      yield* stream("text", text, signal);
      yield { type: "done", finishReason: "stop", usage: { estimated: true, inputTokens: input, outputTokens: estimateTokens(text) } };
      return;
    }
    // 接下来要用的工具还没加载：像真实模型一样，先看目录、一次把要用的都加载上
    const missing = [...new Set(plan.slice(step).map((s) => s.tool).filter((t) => !sent.has(t) && catalog.includes(t)))];
    if (step < plan.length && missing.length) {
      const c = call("load_tools", { purpose: `接下来要用 ${missing.join("、")}，它们在按需工具目录里，先加载`, names: missing });
      yield* stream("reasoning", `接下来要用的 ${missing.join("、")} 现在只在目录里，看不到参数。先用 load_tools 一次加载，下一步就能调用。`, signal);
      yield { type: "tool_call", call: c };
      yield { type: "done", finishReason: "tool_calls", usage: { estimated: true, inputTokens: input, outputTokens: estimateTokens(c.arguments) } };
      return;
    }
    if (step < plan.length) {
      const s = plan[step];
      const thought = s.thought(results);
      const c = call(s.tool, s.args(results));
      yield* stream("reasoning", thought, signal);
      if (s.say) yield* stream("text", s.say, signal);
      // 像真实模型一样，先把工具参数一点点“写”出来（界面上能看到代码在增长），再给出完整的调用
      for (const part of c.arguments.match(/[\s\S]{1,3}/g) ?? []) {
        if (signal?.aborted) return;
        await sleep(25, signal);
        yield { type: "tool_call_delta", index: 0, name: c.name, delta: part };
      }
      yield { type: "tool_call", call: c };
      yield { type: "done", finishReason: "tool_calls", usage: { estimated: true, inputTokens: input, outputTokens: estimateTokens(thought + (s.say ?? "") + c.arguments) } };
      return;
    }

    const final = finish(userText, plan, results);
    yield* stream("reasoning", final.thought, signal);
    yield* stream("text", final.answer, signal);
    yield { type: "done", finishReason: "stop", usage: { estimated: true, inputTokens: input, outputTokens: estimateTokens(final.thought + final.answer) } };
  }
}

/* ------------------------------------------------------------------ */

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Step {
  tool: string;
  thought: (prev: R[]) => string;
  args: (prev: R[]) => R;
  say?: string;
}

function makePlan(text: string): Step[] {
  const t = text.toLowerCase();

  // 演示改代码：先用 Python 生成一个旧文件，再用 edit_file 改几行 → 右侧看板能看到改动（新增绿色 +、删除红色 -）
  if (/改代码|修改代码|演示修改|diff/.test(t)) {
    return [
      // 第 1 步用 Python 生成文件（不是 write_file），这样它算“对话之前就有的文件”，右侧整体改动能看到红色的删除行
      {
        tool: "run_python",
        thought: () => "第 1 步：先准备一个计算斐波那契数列的旧脚本（递归版）。",
        args: () => ({ code: `import os\nos.makedirs("demo", exist_ok=True)\nopen("demo/fib.py", "w", encoding="utf-8").write(${JSON.stringify(FIB_V1)})\nprint("ok")` }),
      },
      {
        tool: "edit_file",
        thought: () => "第 2 步：递归版本太慢，改成循环，顺便加上类型标注和注释。",
        args: () => ({ path: "demo/fib.py", old_string: FIB_V1.split("\n\n")[0], new_string: FIB_V2_HEAD }),
      },
    ];
  }

  // 放在“演示全部工具”前面：“演示终端”里也有“演示”两个字
  if (/终端|命令行|terminal|shell|bash/.test(t)) {
    return [
      { tool: "run_command", thought: () => "用户想看终端工具。第 1 步：先看看工作区里有什么，ls 是只读命令，默认不用确认。", args: () => ({ command: "ls -la", purpose: "查看工作区文件" }) },
      {
        tool: "run_command",
        thought: (p) => `工作区输出了 ${String(p[0]?.output ?? "").split("\n").length} 行。\n第 2 步：建一个 demo 目录、进入它，再逐秒输出几行（演示实时输出；最后一行写到 stderr，界面上是红色）。会写文件，需要用户确认。`,
        args: () => ({ command: 'mkdir -p demo && cd demo && for i in 1 2 3; do echo "第 $i 步"; sleep 1; done && echo "这一行来自 stderr" >&2', purpose: "新建 demo 目录并演示实时输出" }),
      },
      { tool: "run_command", thought: (p) => (p[1]?.denied ? "用户拒绝了第 2 步，不再继续写文件。看一下当前目录就结束。" : "第 3 步：上一条命令 cd 进了 demo，验证目录被保留了。") , args: () => ({ command: "pwd", purpose: "确认当前目录" }) },
    ];
  }

  if (/演示|demo|全部工具|所有工具/.test(t)) {
    return [
      { tool: "current_time", thought: () => "用户想看完整的工具链路。我按顺序调用每个工具，最后汇总成一份报告。\n第 1 步：先拿到当前时间，报告里要用。", args: () => ({ timezone: "Asia/Tokyo" }), say: "开始演示，依次调用 6 个工具。" },
      { tool: "calculator", thought: (p) => `已拿到东京时间：${p[0]?.text ?? "?"}。\n第 2 步：测试计算器，算一个复利：10000 × 1.05^10。`, args: () => ({ expression: "10000*1.05^10" }) },
      { tool: "run_python", thought: (p) => `计算器结果 ${p[1]?.result}。\n第 3 步：用 Python 交叉验证同一个数，并统计 1~100 的质数个数。`, args: () => ({ code: "import math\nprint(round(10000*1.05**10, 2))\nprint(sum(1 for n in range(2,101) if all(n%d for d in range(2,int(math.isqrt(n))+1))))" }) },
      { tool: "write_file", thought: (p) => `Python 输出：${(p[2]?.stdout ?? "").trim().replace(/\n/g, " / ")}，与计算器一致。\n第 4 步：把结果写进工作区文件，留档。`, args: (p) => ({ path: "demo/result.txt", content: `time: ${p[0]?.iso}\ncompound: ${p[1]?.result}\npython: ${(p[2]?.stdout ?? "").trim()}\n` }) },
      { tool: "list_files", thought: () => "文件已写入。\n第 5 步：列出目录，确认文件确实存在。", args: () => ({ path: "demo" }) },
      { tool: "create_artifact", thought: (p) => `目录里有 ${p[4]?.items?.map((i: R) => i.name).join(", ")}。\n第 6 步：所有信息齐了，生成报告放到右侧。`, args: (p) => ({ title: "工具链路演示报告", kind: "markdown", content: demoReport(p) }) },
    ];
  }

  const kind = /页面|网页|html|landing|page/.test(t) ? "html" : /代码|脚本|code|script|函数/.test(t) ? "code" : /文档|报告|总结|计划|表格|doc|report|plan|table/.test(t) ? "markdown" : null;
  if (kind) {
    return [
      { tool: "current_time", thought: () => `用户要一份${kind === "html" ? "网页" : kind === "code" ? "代码" : "文档"}。\n先获取当前时间，用来标注生成日期。`, args: () => ({}) },
      { tool: "create_artifact", thought: (p) => `时间：${p[0]?.text ?? ""}。\n内容是完整成品，用户会保存或继续改，所以放到右侧面板，而不是贴在对话里。`, args: (p) => sample(kind, text, p[0]?.text ?? "") },
    ];
  }

  const url = /https?:\/\/[^\s，。]+/.exec(text)?.[0];
  if (url) return [{ tool: "web_fetch", thought: () => `用户给了链接 ${url}。我不知道页面内容，需要先抓取。`, args: () => ({ url }) }];

  // 把非数学字符换成空格，再取“从第一个数字/括号到最后一个数字/括号”的片段
  const expr = /[\d(][\d\s+\-*/^%().a-z]*[\d)]/i.exec(text.replace(/[^\d\s+\-*/^%().a-zA-Z]/g, " "))?.[0]?.trim();
  if (expr && /[-+*/^%]|sqrt|log|ln|abs/.test(expr)) {
    return [{ tool: "calculator", thought: () => `这是计算题：${expr}。\n心算容易出错，交给计算器。`, args: () => ({ expression: expr }) }];
  }

  if (/python|运行|执行|跑一下/.test(t)) {
    return [{ tool: "run_python", thought: () => "用户想执行代码。我写一段小程序：生成斐波那契数列前 15 项并求和。", args: () => ({ code: "fib=[0,1]\nfor _ in range(13): fib.append(fib[-1]+fib[-2])\nprint(fib)\nprint('sum =', sum(fib))" }) }];
  }

  if (/文件|目录|工作区|workspace|files?/.test(t)) {
    return [{ tool: "list_files", thought: () => "用户想看工作区里有什么，列出根目录。", args: () => ({}) }];
  }

  if (/时间|几点|日期|今天|time|date/.test(t)) {
    return [{ tool: "current_time", thought: () => "我自己不知道现在的时间，需要调用 current_time。", args: () => ({}) }];
  }

  return [];
}

function finish(text: string, plan: Step[], r: R[]): { thought: string; answer: string } {
  const last = r[r.length - 1];
  const tool = plan[plan.length - 1]?.tool;

  if (last?.error) {
    return { thought: `工具返回了错误：${last.error}\n如实告诉用户，并给出下一步建议。`, answer: `执行失败：${last.error}` };
  }
  switch (tool) {
    case "edit_file":
      return {
        thought: "两步都成功了。说明改了什么，提醒去右侧看改动。",
        answer: `已把 demo/fib.py 里的递归改成了循环，点右上角的文件图标打开 \`demo/fib.py\`，切到“改动”就能看到新增和删除的行。\n\n改完后的核心函数：\n\n\`\`\`python\n${FIB_V2_HEAD}\n\`\`\``,
      };
    case "create_artifact":
      return {
        thought: `工具已返回：产出物已展示。${plan.length > 2 ? `\n${plan.length} 个工具全部成功，链路完整。` : ""}\n收尾：一句话说明结果在哪。`,
        answer: plan.length > 2 ? `演示完成：6 个工具依次执行成功，报告在右侧。` : "已完成，内容在右侧。需要调整直接说。",
      };
    case "calculator":
      return { thought: `计算器返回 ${last?.result}。直接给结果。`, answer: `**${last?.expression} = ${last?.result}**` };
    case "current_time":
      return { thought: "已拿到时间，直接回答。", answer: `现在是 ${last?.text}（${last?.timezone}）。` };
    case "web_fetch":
      return {
        thought: `抓取成功，标题「${last?.title}」。提炼开头部分给用户。`,
        answer: `**${last?.title || last?.url}**\n\n${String(last?.content ?? "").slice(0, 300)}${last?.content?.length > 300 ? "…" : ""}`,
      };
    case "run_python":
      return {
        thought: `进程退出码 ${last?.exitCode}。把输出展示给用户。`,
        answer: "运行结果：\n\n```\n" + (String(last?.stdout || last?.stderr || "(无输出)").trim()) + "\n```",
      };
    case "run_command":
      return {
        thought: `最后一条命令退出码 ${last?.exitCode}，当前目录 ${last?.cwd}。`,
        answer: r[1]?.denied
          ? "第 2 步被你拒绝了，所以没有创建 demo 目录。只读命令（ls、pwd）不需要确认。"
          : `终端演示完成：只读的 \`ls\` 直接执行；\`mkdir … && cd demo\` 先请你确认，再实时输出；最后 \`pwd\` 显示当前目录是 \`${last?.cwd}\`，说明 cd 被保留了。`,
      };
    case "list_files":
      return {
        thought: `目录下有 ${last?.items?.length ?? 0} 项。`,
        answer: last?.items?.length ? last.items.map((i: R) => `- \`${i.name}\``).join("\n") : "工作区还是空的。试试“演示全部工具”，会写入一个文件。",
      };
  }
  return {
    thought: "这个问题不需要工具，直接回答。\n当前是 Mock 模型，说明一下能做什么。",
    answer: [
      `收到：「${text.slice(0, 60)}${text.length > 60 ? "…" : ""}」`,
      "",
      "当前运行的是 **Mock 模型**，用来演示 agent 链路。试试：",
      "",
      "- `演示全部工具`：6 步完整链路",
      "- `做一个网页` / `写一份文档`",
      "- `算一下 (12.5*4)^2/sqrt(16)`",
      "- `用 python 跑一下`",
      "- `演示终端`：命令确认 + 实时输出",
      "",
      "接入真实模型：编辑 `src/lib/llm/providers/custom.ts`，并在 `.env.local` 设置 `A_PROVIDER=custom`。",
    ].join("\n"),
  };
}

/* ------------------------------------------------------------------ */

/**
 * 反馈闭环演示：故意模仿一个“粗心”的模型——
 *   1. 写出有 bug 的代码并运行 → NameError
 *   2. 不看报错就说“完成了” → 被 agent 的自动检查打回（verify.ts）
 *   3. 看到反馈后修复代码再运行 → 通过 → 交付
 */
async function* fixDemo(last: ChatRequest["messages"][number] | undefined, results: R[], input: number, signal?: AbortSignal): AsyncIterable<StreamChunk> {
  const runs = results.filter((r) => "exitCode" in r);
  const lastRun = runs[runs.length - 1];
  const gotFeedback = last?.role === "user" && last.content.startsWith(FEEDBACK_TAG);
  const emitCall = async function* (thought: string, code: string) {
    const c = call("run_python", { code });
    yield* stream("reasoning", thought, signal);
    for (const part of c.arguments.match(/[\s\S]{1,3}/g) ?? []) {
      await sleep(15, signal);
      yield { type: "tool_call_delta", index: 0, name: c.name, delta: part } as StreamChunk;
    }
    yield { type: "tool_call", call: c } as StreamChunk;
    yield { type: "done", finishReason: "tool_calls", usage: { estimated: true, inputTokens: input, outputTokens: estimateTokens(thought + code) } } as StreamChunk;
  };
  const answer = async function* (thought: string, text: string) {
    yield* stream("reasoning", thought, signal);
    yield* stream("text", text, signal);
    yield { type: "done", finishReason: "stop", usage: { estimated: true, inputTokens: input, outputTokens: estimateTokens(thought + text) } } as StreamChunk;
  };

  if (!runs.length) {
    yield* emitCall(
      "用户要算三个人的平均分。写一段 Python 运行一下。",
      'scores = {"张三": 92, "李四": 78, "王五": 85}\navg = sum(scores.values()) / len(score)\nprint(f"平均分：{avg:.1f}")',
    );
  } else if (lastRun.exitCode !== 0 && gotFeedback) {
    yield* emitCall(
      "自动检查说运行失败了。报错最后一行：NameError: name 'score' is not defined —— 变量名写错了，应该是 scores。改掉再运行。",
      'scores = {"张三": 92, "李四": 78, "王五": 85}\navg = sum(scores.values()) / len(scores)\nbest = max(scores, key=scores.get)\nprint(f"平均分：{avg:.1f}")\nprint(f"最高分：{best} {scores[best]}")',
    );
  } else if (lastRun.exitCode !== 0) {
    // 粗心的模型：没看报错就交付
    yield* answer("代码写好了，应该没问题。", "已经写好并运行了，平均分计算完成。");
  } else {
    yield* answer(
      `修复后运行通过，退出码 0。输出：${String(lastRun.stdout).trim().replace(/\n/g, " / ")}`,
      "已运行通过（第一次把 `scores` 写成了 `score`，报 NameError，已修复）：\n\n```\n" + String(lastRun.stdout).trim() + "\n```",
    );
  }
}

/**
 * 提问演示：
 *   第 1 轮（用户说“演示提问”）：调用 ask_user 问格式 → 本轮结束
 *   第 2 轮（用户的回答）：按回答生成周报放到右侧（运行中补充的想法也会写进去）→ 一句话交付
 */
async function* askDemo(answer: string | null, step: number, notes: string[], input: number, signal?: AbortSignal): AsyncIterable<StreamChunk> {
  const done = (out: string) => ({ type: "done", finishReason: "stop", usage: { estimated: true, inputTokens: input, outputTokens: estimateTokens(out) } }) as StreamChunk;
  const toolCall = async function* (thought: string, name: string, args: R) {
    const c = call(name, args);
    yield* stream("reasoning", thought, signal);
    for (const part of c.arguments.match(/[\s\S]{1,4}/g) ?? []) {
      await sleep(15, signal);
      yield { type: "tool_call_delta", index: 0, name, delta: part } as StreamChunk;
    }
    yield { type: "tool_call", call: c } as StreamChunk;
    yield { ...done(thought + c.arguments), finishReason: "tool_calls" } as StreamChunk;
  };

  if (!answer) {
    yield* toolCall("用户要我做一份周报，但没说要什么格式。格式会决定后面所有工作，猜错要返工，先问清楚。", "ask_user", {
      question: "周报要做成什么格式？",
      options: ["Markdown 文档", "网页", "表格"],
    });
    return;
  }
  const extra = notes.length ? `\n\n## 你补充的想法\n${notes.map((n) => `- ${n}`).join("\n")}` : "";
  if (step === 0) {
    const html = /网页|html/i.test(answer);
    yield* toolCall(
      `用户回答：「${answer.replace(/\n/g, " / ")}」。按这个格式生成。${notes.length ? `\n运行中还补充了：${notes.join("；")}，一起写进去。` : ""}`,
      "create_artifact",
      html
        ? { title: "本周周报", kind: "html", content: `<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:32px"><h1>本周周报</h1><p>你的要求：${answer.replace(/</g, "&lt;")}</p><ul><li>完成 A.ai 反馈闭环</li><li>完成长期记忆</li><li>完成提问交互</li></ul></body>` }
        : { title: "本周周报", kind: "markdown", content: `# 本周周报\n\n> 你的要求：${answer.replace(/\n/g, "；")}\n\n| 事项 | 状态 |\n|---|---|\n| 反馈闭环 | 完成 |\n| 长期记忆 | 完成 |\n| 提问交互 | 完成 |${extra}` },
    );
    return;
  }
  // 产出生成后用户又补充了想法：说明已经看到，下一步会怎么改
  const text = notes.length ? `周报已生成在右侧。你补充的「${notes.join("；")}」我也看到了，已写进最后一节。` : "周报已按你的选择生成，在右侧。需要调整直接说。";
  yield* stream("reasoning", "产出已经生成，交付。", signal);
  yield* stream("text", text, signal);
  yield done(text);
}

/** 假的“整理记忆”：从本轮对话里找 Python 报错，写成一条教训；同类错误次数 +1 */
function mockReflect(input: string): string {
  const memText = /现有记忆：\n(.*)\n\n本轮对话：/s.exec(input)?.[1] ?? "{}";
  let mem: R;
  try {
    mem = JSON.parse(memText);
  } catch {
    mem = {};
  }
  const talk = input.slice(input.indexOf("本轮对话："));
  const habits: string[] = Array.isArray(mem.habits) ? mem.habits : [];
  if (/用户：.*[\u4e00-\u9fff]/.test(talk) && !habits.includes("用中文交流")) habits.push("用中文交流");
  const lessons: R[] = Array.isArray(mem.lessons) ? mem.lessons : [];
  // 对话里的报错是 JSON 转义过的（换行是字面的 \n），所以从大写字母开始匹配，避免把 “n” 吃进去
  const err = /([A-Z][a-zA-Z]*Error): ([^\n"\\]+)/.exec(talk);
  if (err) {
    const same = lessons.find((l) => String(l.mistake).includes(err[1]));
    if (same) same.count = (Number(same.count) || 1) + 1;
    else lessons.push({ mistake: `运行 Python 时出现 ${err[1]}：${err[2].slice(0, 60)}`, lesson: `写完代码先自查 ${err[1]} 这类问题（变量名拼写、定义顺序），再运行验证`, count: 1 });
  }
  return JSON.stringify({ profile: mem.profile || "", habits, lessons });
}

/** 技能目录（skillsPrompt）里描述写成「当用户说“…”」的技能：用户这次说的话包含引号里的内容就算对得上 */
function matchSkill(system: string, userText: string): string | null {
  const at = system.indexOf("## 你学会的技能");
  if (at < 0) return null;
  for (const line of system.slice(at).split("\n")) {
    const m = /^- (.+?)：(.*)$/.exec(line);
    const key = m && /“([^”]+)”/.exec(m[2])?.[1];
    if (m && key && userText.includes(key)) return m[1];
  }
  return null;
}

/**
 * 假的“技能学习”：
 * - 要求改进技能（用了技能但出了问题）→ 在原来的注意事项后面补一条，action=update
 * - 否则把本轮用过的工具按顺序写成步骤，action=create（同名的已经有了就是 update）
 */
function mockLearn(input: string): string {
  const section = (name: string) => new RegExp(`${name}：\\n([\\s\\S]*?)(?:\\n\\n[^\\n]+：\\n|$)`).exec(input)?.[1] ?? "";
  const talk = input.slice(input.indexOf("本轮对话："));
  const revise = /「([^」]+)」[^\n]*(改进这个技能|改进它)/.exec(section("为什么要你看这一轮"));
  const fail = /工具结果（失败）：(.{0,80})/.exec(talk)?.[1] ?? /系统检查：([^\n]{0,80})/.exec(talk)?.[1] ?? "结果不对，被用户纠正";
  if (revise) {
    const name = revise[1];
    const full = new RegExp(`### ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n适用：([^\\n]*)\\n([\\s\\S]*?)(?=\\n### |\\n\\n用户以前|\\n\\n本轮对话|$)`).exec(input);
    const body = (full?.[2] ?? "## 步骤\n1. 按用户的要求完成").trimEnd() + `\n- 上次用这个技能时出过问题：${fail.replace(/\s+/g, " ")}。这一步先检查清楚再继续`;
    return JSON.stringify({ action: "update", name, description: full?.[1] || `当用户提到「${name}」相关的任务时`, body, note: "补充了上次踩的坑" });
  }
  const ask = /用户：([^\n]+)/.exec(talk)?.[1]?.trim() ?? "";
  const key = ask.replace(/[，。！？,.!?].*$/, "").slice(0, 16) || "常用任务";
  const name = /演示全部工具/.test(ask) ? "工具链路报告" : key.slice(0, 12);
  const steps = [...talk.matchAll(/A\.ai 调用 (\w+)：(.*)/g)].map((m, i) => {
    const purpose = /"purpose":"([^"]+)"/.exec(m[2])?.[1];
    return `${i + 1}. 用 \`${m[1]}\`${purpose ? `：${purpose}` : ""}`;
  });
  if (!steps.length) return JSON.stringify({ action: "none", note: "这一轮没有可以复用的步骤" });
  const body = [
    "## 适用场景",
    `用户说“${key}”或类似的请求。`,
    "",
    "## 步骤",
    ...steps,
    "",
    "## 用户的固定要求",
    /[\u4e00-\u9fff]/.test(ask) ? "- 用中文回答" : "无",
    "",
    "## 注意事项",
    /（失败）/.test(talk) ? `- 上次出过错：${fail}` : "- 每一步看清工具结果再做下一步",
    "",
    "## 怎么验证做对了",
    "- 每一步的工具结果都成功，最后的产出在右侧能打开",
  ].join("\n");
  return JSON.stringify({ action: "create", name, description: `当用户说“${key}”或类似的请求时`, body, note: `这一轮用了 ${steps.length} 个工具顺利完成` });
}

async function* stream(type: "text" | "reasoning", s: string, signal?: AbortSignal): AsyncIterable<StreamChunk> {
  const parts = s.match(/[\s\S]{1,2}/g) ?? [];
  const delay = type === "reasoning" ? 16 : 10;
  for (const p of parts) {
    if (signal?.aborted) return;
    await sleep(delay, signal);
    yield { type, delta: p };
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

const call = (name: string, args: R): ToolCall => ({ id: `call_${Math.random().toString(36).slice(2, 10)}`, name, arguments: JSON.stringify(args) });

function parse(s: string): R {
  if (s.startsWith("工具执行失败")) return { error: s.replace(/^工具执行失败：/, "") };
  try {
    return JSON.parse(s);
  } catch {
    return { text: s };
  }
}

function lastIndex<T>(a: T[], f: (x: T) => boolean) {
  for (let i = a.length - 1; i >= 0; i--) if (f(a[i])) return i;
  return -1;
}

function demoReport(p: R[]) {
  return `# 工具链路演示报告

| 步骤 | 工具 | 结果 |
|---|---|---|
| 1 | \`current_time\` | ${p[0]?.text ?? "-"} |
| 2 | \`calculator\` | 10000 × 1.05^10 = ${p[1]?.result ?? "-"} |
| 3 | \`run_python\` | ${(p[2]?.stdout ?? "-").trim().replace(/\n/g, "，")}（复利验证，1~100 质数个数） |
| 4 | \`write_file\` | 写入 \`${p[3]?.path ?? "-"}\`，${p[3]?.bytes ?? 0} 字节 |
| 5 | \`list_files\` | ${(p[4]?.items ?? []).map((i: R) => i.name).join("、") || "-"} |
| 6 | \`create_artifact\` | 本报告 |

## 这条链路说明了什么

1. 模型每一步只决定“下一步调用什么工具、用什么参数”。
2. 程序执行工具，把结果作为 \`role: "tool"\` 消息加回对话历史。
3. 模型看到结果，再决定下一步，直到不再调用工具。

这就是 **ReAct 循环**（Reason → Act → Observe），代码在 \`src/lib/agent/run.ts\`。
`;
}

function sample(kind: "html" | "markdown" | "code", prompt: string, time: string) {
  const topic = prompt.replace(/^(写一份文档|做一个网页|写一段代码|整理成表格)[：:]?/, "").slice(0, 24) || "示例";
  if (kind === "html") {
    return {
      title: `${topic} · 页面`,
      kind,
      content: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;display:grid;place-items:center;min-height:100vh;background:#fafafa;color:#111}
  main{max-width:520px;padding:48px 24px;text-align:center}
  h1{font-size:40px;letter-spacing:-.02em;margin:0 0 12px}
  p{color:#666;line-height:1.6;margin:0 0 28px}
  small{display:block;color:#aaa;margin-top:28px}
  button{border:0;background:#111;color:#fff;padding:12px 22px;border-radius:999px;font-size:15px;cursor:pointer}
</style></head><body><main>
  <h1>${escapeHtml(topic)}</h1>
  <p>这是 Mock 模型生成的示例页面。接入真实模型后，这里会是完整的成品。</p>
  <button onclick="this.textContent='已点击 ✓'">开始</button>
  <small>生成于 ${escapeHtml(time)}</small>
</main></body></html>`,
    };
  }
  if (kind === "code") {
    return {
      title: `${topic} · 脚本`,
      kind,
      language: "python",
      content: `"""${topic}\n生成于 ${time}\n"""\n\n\ndef main():\n    items = [3, 1, 2]\n    print(sorted(items))\n\n\nif __name__ == "__main__":\n    main()\n`,
    };
  }
  return {
    title: `${topic} · 文档`,
    kind,
    content: `# ${topic}\n\n> 生成于 ${time}\n\n## 目标\n\n- 用最少的步骤完成任务\n- 结果可直接使用\n\n## 步骤\n\n| # | 事项 | 负责人 | 状态 |\n|---|---|---|---|\n| 1 | 明确需求 | 我 | 完成 |\n| 2 | 生成初稿 | A.ai | 完成 |\n| 3 | 审阅修改 | 我 | 待办 |\n`,
  };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}


const FIB_V1 = `def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

if __name__ == "__main__":
    print([fib(i) for i in range(10)])  # 前 10 项
`;
const FIB_V2_HEAD = `def fib(n: int) -> int:
    """第 n 个斐波那契数（循环版，O(n)）"""
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a`;

/* ------------------------------------------------------------------ */

const SCRIPT_TAG = "[A.ai:script]";

/**
 * 剧本模式：{"steps": [[{"name": "write_file", "args": {...}}, …], …], "final": "回答"}
 * 第 n 次调用模型就发出 steps[n] 里的工具调用（同一步多个 = 模型一次发出多个调用），步骤用完给出 final。
 * 用来测试 agent 循环本身（参数检查、跳过、取消、状态），不依赖真实模型的随机性。
 */
function scriptOf(msgs: ChatRequest["messages"]): AsyncGenerator<StreamChunk> | null {
  const u = lastIndex(msgs, (m) => m.role === "user" && m.content.startsWith(SCRIPT_TAG));
  if (u < 0 || lastIndex(msgs, (m) => m.role === "user" && !m.content.startsWith(FEEDBACK_TAG) && !m.content.startsWith(NOTE_TAG)) !== u) return null;
  let plan: { steps?: { name: string; args?: Record<string, unknown>; raw?: string }[][]; final?: string };
  try {
    plan = JSON.parse(msgs[u].content.slice(SCRIPT_TAG.length).replace(/\n*<(环境|附件)>[\s\S]*$/, ""));
  } catch {
    return null;
  }
  const step = msgs.slice(u + 1).filter((m) => m.role === "assistant").length;
  const calls = plan.steps?.[step];
  return (async function* () {
    if (calls?.length) {
      for (const [i, c] of calls.entries()) yield { type: "tool_call", call: { id: `call_${step}_${i}_${Date.now().toString(36)}`, name: c.name, arguments: c.raw ?? JSON.stringify(c.args ?? {}) } };
      yield { type: "done", finishReason: "tool_calls", usage: { estimated: true, inputTokens: 10, outputTokens: 10 } };
    } else {
      yield { type: "text", delta: plan.final ?? "剧本结束" };
      yield { type: "done", finishReason: "stop", usage: { estimated: true, inputTokens: 10, outputTokens: 10 } };
    }
  })();
}

/** 系统提示词里「按需加载的工具」目录列出的工具名（每行 “- 名字：用途”） */
function deferredNames(system: string): string[] {
  const part = system.split("## 按需加载的工具")[1]?.split(/\n## /)[0] ?? "";
  return [...part.matchAll(/^- ([a-z_]+)：/gm)].map((m) => m[1]);
}
