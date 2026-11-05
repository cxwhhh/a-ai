#!/usr/bin/env node
/**
 * A.ai 自动测评：把 evals/cases.json 里的题目一道道发给正在运行的 A.ai，自动判分，并和上一次结果对比。
 *
 * 用法（先启动 A.ai，再在项目根目录运行；只需要 Node 22，不用装依赖）：
 *   node evals/run.mjs --user eval --pass eval12345            # 跑全部题目
 *   node evals/run.mjs --user eval --pass eval12345 --only F04,E02 --repeat 3
 *   node evals/run.mjs --base http://服务器:3000 --category 改文件,多步 --model "conn/model"
 *
 * 参数：
 *   --base       A.ai 地址，默认 http://localhost:3000（也可用环境变量 A_EVAL_BASE）
 *   --user/--pass 测评账号（A_EVAL_USER / A_EVAL_PASS）。登录失败会自动注册。
 *                 建议单独建一个测评账号，在界面里给它配好要测的模型；新账号默认是 Mock 模型
 *   --model      临时切换模型（值和设置里一样：mock 或 “连接id/模型名”），跑完改回去
 *   --only       只跑这些题号，逗号分隔；--category 只跑这些分类
 *   --repeat     每道题跑几次（模型有随机性，3 次以上更能看出稳定性），默认 1
 *   --timeout    每道题最多等几秒，默认 300
 *   --compare    和哪次结果对比（results 里的文件名），默认和上一次
 *   --label      给这次结果起个名字，比如 "改提示词后"，会出现在报告里
 *   --cases      换一份题目文件（默认 evals/cases.json），比如自己另写一份只测某个功能的
 *
 * 跑的时候会临时把账号设置改成：关闭长期记忆（题目之间互不影响）、终端命令不用确认（没人点确认）。
 * 跑完恢复原样。结果存在 evals/results/<时间>.json 和同名 .md 报告。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, "results");

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null);

const BASE = opt("base", process.env.A_EVAL_BASE || "http://localhost:3000").replace(/\/$/, "");
const USER = opt("user", process.env.A_EVAL_USER || "eval");
const PASS = opt("pass", process.env.A_EVAL_PASS || "eval12345");
const MODEL = opt("model", "");
const ONLY = list(opt("only"));
const CATS = list(opt("category"));
const REPEAT = Math.max(1, Number(opt("repeat", 1)) || 1);
const TIMEOUT = Math.max(10, Number(opt("timeout", 300)) || 300) * 1000;
const COMPARE = opt("compare", "");
const LABEL = opt("label", "");
const CASES = opt("cases", path.join(HERE, "cases.json"));

/* ---------------- HTTP ---------------- */

let cookie = "";

async function api(method, url, body, extra = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body && !isForm ? { "Content-Type": "application/json" } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    ...extra,
  });
  return res;
}
async function json(method, url, body) {
  const res = await api(method, url, body);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data.error ?? ""}`);
  return data;
}

async function signIn() {
  for (const ep of ["/api/auth/login", "/api/auth/register"]) {
    const res = await api("POST", ep, { username: USER, password: PASS });
    if (res.ok) {
      // 只取 name=value，属性（Path、HttpOnly…）不用带回去
      cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      return ep.endsWith("register") ? "已注册新账号" : "已登录";
    }
  }
  throw new Error(`登录 ${USER} 失败：检查 --user / --pass，或确认 ${BASE} 能打开`);
}

/**
 * 发一条消息，读完整个 SSE 流。
 * 遇到命令确认就自动“允许”：测评时没人点按钮（设置里也已改成 auto，这里是兜底）。
 */
async function chat(sessionId, message, signal) {
  const res = await api("POST", "/api/chat", { sessionId, message }, { signal });
  if (!res.ok || !res.body) throw new Error(`POST /api/chat → ${res.status}`);
  const out = { sessionId, errors: [], approvals: 0 };
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!line.startsWith("data: ")) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === "session") out.sessionId = ev.session.id;
      else if (ev.type === "error") out.errors.push(ev.message);
      else if (ev.type === "approval") {
        out.approvals++;
        await api("POST", "/api/approve", { callId: ev.callId, decision: "allow" }).catch(() => {});
      }
    }
  }
  return out;
}

async function readFile(p) {
  const res = await api("GET", `/api/files?path=${encodeURIComponent(p)}`);
  const data = await res.json().catch(() => ({}));
  return res.ok && data.type === "file" ? data : null;
}

/* ---------------- 准备题目 ---------------- */

/** 太大的附件不写在 JSON 里，用生成器现做 */
function generate(spec) {
  if (spec.gen === "log") {
    const lines = [];
    for (let n = 1; n <= spec.lines; n++) {
      const t = new Date(Date.UTC(2026, 9, 27, 0, 0, n)).toISOString();
      lines.push(n === spec.errorAt ? `${t} ${spec.error}` : `${t} INFO request id=${100000 + n} status=200 ${n % 7 === 0 ? "WARN slow=1.2s" : "ok"}`);
    }
    return lines.join("\n") + "\n";
  }
  throw new Error(`不认识的生成器 ${spec.gen}`);
}
const contentOf = (spec) => (typeof spec === "string" ? spec : generate(spec));

/** 每道题的附件放进自己的 uploads/<dir>/：上一次测评留下的同名文件不会混进来 */
async function upload(files, dir) {
  const map = {};
  for (const [name, spec] of Object.entries(files ?? {})) {
    const form = new FormData();
    form.append("dir", dir);
    form.append("file", new Blob([contentOf(spec)]), name);
    const data = await json("POST", "/api/upload", form);
    map[name] = data.files[0].path;
  }
  return map;
}

/** {dir} / {file:x} / {name:x} 换成实际值 */
function fill(s, ctx) {
  return s
    .replaceAll("{dir}", ctx.dir)
    .replace(/\{file:([^}]+)\}/g, (_, n) => ctx.files[n] ?? n)
    .replace(/\{name:([^}]+)\}/g, (_, n) => (ctx.files[n] ?? n).split("/").pop());
}

/* ---------------- 统计 ---------------- */

/**
 * 从会话记录里数指标。只看本题发出的消息（会话是新建的，所以就是全部）。
 * steps = 模型被调用几次；toolErrors = 失败的工具调用；repeatedErrors = 同一个工具 + 同样参数又失败了一次（原地打转）；
 * feedback = 自动检查打回几次（运行报错、写了没验证、步数用完）
 */
function measure(session) {
  const msgs = session.messages ?? [];
  const calls = new Map();
  const m = { steps: 0, toolCalls: 0, tools: {}, toolErrors: 0, toolSkipped: 0, repeatedErrors: 0, feedback: 0, compacts: 0, inputTokens: 0, outputTokens: 0, estimated: false, answer: "", askedUser: false, calls: [] };
  const seenErr = new Set();
  for (const x of msgs) {
    if (x.role === "assistant") {
      m.steps++;
      if (x.usage) {
        m.inputTokens += x.usage.inputTokens ?? 0;
        m.outputTokens += x.usage.outputTokens ?? 0;
        if (x.usage.estimated) m.estimated = true;
      }
      for (const c of x.toolCalls ?? []) {
        m.toolCalls++;
        m.tools[c.name] = (m.tools[c.name] ?? 0) + 1;
        calls.set(c.id, c);
        if (c.name === "ask_user") m.askedUser = true;
      }
      if (x.content?.trim()) m.answer = x.content.trim();
    }
    if (x.role === "tool") m.calls.push({ name: calls.get(x.toolCallId)?.name ?? "?", status: statusOf(x) });
    if (x.role === "assistant") {
      /* 上面已经处理 */
    } else if (x.role === "tool" && (statusOf(x) === "skipped" || statusOf(x) === "cancelled" || statusOf(x) === "denied")) {
      m.toolSkipped++;
    } else if (x.role === "tool" && statusOf(x) !== "ok") {
      // 和 A.ai 界面同一套规则（src/lib/shared.ts toolStatus）：命令退出码非 0 也算出错
      m.toolErrors++;
      const c = calls.get(x.toolCallId);
      const key = c ? c.name + c.arguments : x.content;
      if (seenErr.has(key)) m.repeatedErrors++;
      seenErr.add(key);
    } else if (x.role === "user" && x.feedback) {
      if (x.feedback.kind === "compact") m.compacts++;
      else if (x.feedback.kind !== "note") m.feedback++;
    }
  }
  // 最后一轮如果是 ask_user 收尾，回答就是问题本身
  const last = [...msgs].reverse().find((x) => x.role === "assistant");
  const ask = last?.toolCalls?.find((c) => c.name === "ask_user");
  if (ask && !last.content?.trim()) {
    try {
      m.answer = JSON.parse(ask.arguments).question ?? m.answer;
    } catch {
      /* 参数坏了就用之前的回答 */
    }
  }
  return m;
}

/** 工具结果的状态：新版本 A.ai 存了 status；老数据按内容推断（和 shared.ts 的 inferStatus 一致） */
function statusOf(x) {
  if (x.status) return x.status;
  if (x.isError) return "error";
  if (!x.content?.startsWith("{") || !/"(exitCode|denied|timedOut)"/.test(x.content)) return "ok";
  try {
    const r = JSON.parse(x.content);
    return r.denied ? "denied" : r.timedOut ? "timeout" : r.exitCode !== undefined && r.exitCode !== 0 ? "error" : "ok";
  } catch {
    return "ok";
  }
}

/* ---------------- 判分 ---------------- */

const norm = (s) => String(s).toLowerCase();

/** 每条规则返回 [是否通过, 说明]。一道题所有规则都通过才算通过 */
async function grade(checks, m, ctx, setup) {
  const out = [];
  const add = (ok, what) => out.push({ ok: !!ok, what });
  const a = norm(m.answer);
  if (checks.answerAll) for (const s of checks.answerAll) add(a.includes(norm(s)), `回答包含「${s}」`);
  if (checks.answerAny) add(checks.answerAny.some((s) => a.includes(norm(s))), `回答包含其一：${checks.answerAny.join(" / ")}`);
  if (checks.answerNone) for (const s of checks.answerNone) add(!a.includes(norm(s)), `回答不含「${s}」`);
  if (checks.answerRegex) add(new RegExp(checks.answerRegex, "i").test(m.answer), `回答匹配 /${checks.answerRegex}/`);
  if (checks.maxAnswerChars) add([...stripMd(m.answer)].length <= checks.maxAnswerChars, `回答不超过 ${checks.maxAnswerChars} 字（实际 ${[...stripMd(m.answer)].length}）`);
  if (checks.answerJson) {
    let ok = false;
    try {
      const v = JSON.parse(m.answer.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      ok = Object.entries(checks.answerJson).every(([k, x]) => JSON.stringify(v[k]) === JSON.stringify(x));
    } catch {
      /* 不是合法 JSON */
    }
    add(ok, "回答是要求的 JSON");
  }
  if (checks.asksUser) add(m.askedUser || /[？?]\s*$|[？?]/.test(m.answer), "先向用户提问（ask_user 或回答里提问）");
  if (checks.mustUse) for (const t of checks.mustUse) add(m.tools[t], `用了 ${t}`);
  if (checks.mustUseAny) add(checks.mustUseAny.some((t) => m.tools[t]), `用了其一：${checks.mustUseAny.join(" / ")}`);
  if (checks.mustNotUse) for (const t of checks.mustNotUse) add(!m.tools[t], `没用 ${t}`);
  if (checks.maxToolCalls !== undefined) add(m.toolCalls <= checks.maxToolCalls, `工具调用 ≤ ${checks.maxToolCalls}（实际 ${m.toolCalls}）`);
  // 工具结果的状态：这个工具的每次调用都应该是这个状态（测试执行层用，见 evals/harness.json）
  for (const st of checks.statuses ?? []) {
    const got = m.calls.filter((c) => c.name === st.tool).map((c) => c.status);
    add(got.length > 0 && got.every((g) => g === st.status), `${st.tool} 的状态是 ${st.status}（实际 ${got.join("、") || "没有调用"}）`);
  }
  if (checks.maxSteps !== undefined) add(m.steps <= checks.maxSteps, `步数 ≤ ${checks.maxSteps}（实际 ${m.steps}）`);
  for (const f of checks.files ?? []) {
    const p = fill(f.path, ctx);
    const file = await readFile(p);
    const text = file?.content ?? "";
    if (f.exists === false) {
      add(!file, `${p} 不存在`);
      continue;
    }
    add(file, `${p} 存在`);
    if (!file) continue;
    for (const s of f.includes ?? []) add(text.includes(s), `${p} 包含「${s}」`);
    for (const s of f.excludes ?? []) add(!text.includes(s), `${p} 不含「${s}」`);
    if (f.regex) add(new RegExp(f.regex, "m").test(text), `${p} 匹配 /${f.regex}/`);
    if (f.lines) {
      const n = text.replace(/\n$/, "").split("\n").length;
      add(n === f.lines, `${p} 正好 ${f.lines} 行（实际 ${n}）`);
    }
    if (f.listItems) {
      const n = text.split("\n").filter((l) => /^\s*([-*+]|\d+[.)])\s+\S/.test(l)).length;
      add(n === f.listItems, `${p} 正好 ${f.listItems} 条列表（实际 ${n}）`);
    }
    if (f.unchanged) add(text === contentOf(setup[f.path.match(/^\{file:(.+)\}$/)?.[1]] ?? ""), `${p} 没被改动`);
    if (f.sameAs) add(text.trim() === contentOf(setup[f.sameAs]).trim(), `${p} 和 ${f.sameAs} 内容一样`);
  }
  return out;
}

/** 字数限制按“看到的字”算：去掉 Markdown 符号和首尾空白 */
const stripMd = (s) => s.replace(/[*_`#>]/g, "").trim();

/* ---------------- 跑一道题 ---------------- */

async function runCase(c, runId, round) {
  const t0 = Date.now();
  const ctx = { dir: `eval-runs/${runId}/${c.id}${REPEAT > 1 ? `-${round}` : ""}`, files: {} };
  const r = { id: c.id, category: c.category, title: c.title, round, pass: false, score: 0, checks: [], error: "" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    ctx.files = await upload(c.files, `eval-${runId}-${c.id}${REPEAT > 1 ? `-${round}` : ""}`);
    const turns = c.turns ?? [c.prompt];
    let sessionId;
    for (let i = 0; i < turns.length; i++) {
      let msg = fill(turns[i], ctx);
      // 和界面上传附件一样：路径附在第一条消息末尾
      const paths = Object.values(ctx.files);
      if (i === 0 && paths.length) msg += `\n\n<附件>\n${paths.join("\n")}\n</附件>`;
      const res = await chat(sessionId, msg, ac.signal);
      sessionId = res.sessionId;
      if (res.errors.length) r.error = res.errors.join("；");
    }
    const session = await json("GET", `/api/sessions/${sessionId}`);
    Object.assign(r, { sessionId }, measure(session));
    r.checks = await grade(c.checks ?? {}, r, ctx, c.files ?? {});
    const passed = r.checks.filter((x) => x.ok).length;
    r.score = r.checks.length ? passed / r.checks.length : 0;
    r.pass = !r.error && passed === r.checks.length;
  } catch (e) {
    r.error = ac.signal.aborted ? `超时（${TIMEOUT / 1000} 秒）` : e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  r.durationMs = Date.now() - t0;
  return r;
}

/* ---------------- 汇总、对比、报告 ---------------- */

function summarize(rows) {
  const n = rows.length || 1;
  const sum = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  return {
    cases: rows.length,
    passed: rows.filter((r) => r.pass).length,
    passRate: rows.filter((r) => r.pass).length / n,
    avgScore: sum("score") / n,
    avgSteps: sum("steps") / n,
    avgToolCalls: sum("toolCalls") / n,
    toolErrors: sum("toolErrors"),
    repeatedErrors: sum("repeatedErrors"),
    feedback: sum("feedback"),
    tokens: sum("inputTokens") + sum("outputTokens"),
    avgTokens: (sum("inputTokens") + sum("outputTokens")) / n,
    avgSeconds: sum("durationMs") / n / 1000,
  };
}

/** 同一道题跑了多次时，按题合并：通过率 = 通过次数 / 次数 */
function byCase(rows) {
  const g = new Map();
  for (const r of rows) g.set(r.id, [...(g.get(r.id) ?? []), r]);
  return [...g.entries()].map(([id, rs]) => ({
    id,
    title: rs[0].title,
    category: rs[0].category,
    runs: rs.length,
    passRate: rs.filter((r) => r.pass).length / rs.length,
    steps: avg(rs, "steps"),
    toolCalls: avg(rs, "toolCalls"),
    toolErrors: avg(rs, "toolErrors"),
    tokens: avg(rs, "inputTokens") + avg(rs, "outputTokens"),
    seconds: avg(rs, "durationMs") / 1000,
    failed: [...new Set(rs.flatMap((r) => [...r.checks.filter((x) => !x.ok).map((x) => x.what), ...(r.error ? [r.error] : [])]))],
  }));
}
const avg = (rs, k) => rs.reduce((s, r) => s + (r[k] ?? 0), 0) / rs.length;

const pct = (x) => `${Math.round(x * 100)}%`;
const num = (x, d = 1) => (Number.isInteger(x) ? String(x) : x.toFixed(d));
const delta = (now, before, { lowerIsBetter = false, fmt = num } = {}) => {
  if (before === undefined) return "";
  const d = now - before;
  if (Math.abs(d) < 1e-9) return " (=)";
  const good = lowerIsBetter ? d < 0 : d > 0;
  return ` (${d > 0 ? "+" : "−"}${fmt(Math.abs(d))} ${good ? "↑好" : "↓差"})`;
};

function report(result, prev) {
  const s = result.summary;
  const p = prev?.summary;
  const L = [];
  L.push(`# A.ai 测评报告 ${result.startedAt}${result.label ? ` · ${result.label}` : ""}`, "");
  L.push(`模型：${result.model}　题目：${s.cases} 次（${result.cases.length} 道 × ${result.repeat}）${prev ? `　对比：${prev.file}${prev.label ? `（${prev.label}）` : ""}` : ""}`, "");
  L.push("| 指标 | 本次 | 说明 |", "|---|---|---|");
  L.push(`| 通过率 | ${pct(s.passRate)}${delta(s.passRate, p?.passRate, { fmt: pct })} | 所有规则都满足才算通过 |`);
  L.push(`| 平均得分 | ${pct(s.avgScore)}${delta(s.avgScore, p?.avgScore, { fmt: pct })} | 满足的规则比例，看“差多少” |`);
  L.push(`| 平均步数 | ${num(s.avgSteps)}${delta(s.avgSteps, p?.avgSteps, { lowerIsBetter: true })} | 每道题调用模型几次 |`);
  L.push(`| 平均工具调用 | ${num(s.avgToolCalls)}${delta(s.avgToolCalls, p?.avgToolCalls, { lowerIsBetter: true })} | |`);
  L.push(`| 工具出错 | ${s.toolErrors}${delta(s.toolErrors, p?.toolErrors, { lowerIsBetter: true })} | 其中原地重复出错 ${s.repeatedErrors} 次 |`);
  L.push(`| 自动检查打回 | ${s.feedback}${delta(s.feedback, p?.feedback, { lowerIsBetter: true })} | 运行报错 / 没验证 / 步数用完 |`);
  L.push(`| 平均 token | ${Math.round(s.avgTokens)}${delta(s.avgTokens, p?.avgTokens, { lowerIsBetter: true, fmt: (x) => String(Math.round(x)) })} | 输入 + 输出${result.rows.some((r) => r.estimated) ? "（部分是估算）" : ""} |`);
  L.push(`| 平均耗时 | ${num(s.avgSeconds)} 秒${delta(s.avgSeconds, p?.avgSeconds, { lowerIsBetter: true })} | |`, "");

  const before = new Map((prev?.byCase ?? []).map((c) => [c.id, c]));
  L.push("## 每道题", "", "| 题 | 分类 | 结果 | 步数 | 工具 | 出错 | token | 秒 | 没通过的规则 |", "|---|---|---|---|---|---|---|---|---|");
  for (const c of result.byCase) {
    const b = before.get(c.id);
    const mark = c.passRate === 1 ? "✅" : c.passRate === 0 ? "❌" : `⚠️ ${pct(c.passRate)}`;
    const change = b ? (c.passRate > b.passRate ? " ⬆" : c.passRate < b.passRate ? " ⬇" : "") : "";
    L.push(`| ${c.id} ${c.title} | ${c.category} | ${mark}${change} | ${num(c.steps)} | ${num(c.toolCalls)} | ${num(c.toolErrors)} | ${Math.round(c.tokens)} | ${num(c.seconds)} | ${c.failed.join("；").replace(/\|/g, "\\|") || ""} |`);
  }
  if (prev) {
    const up = result.byCase.filter((c) => before.get(c.id) && c.passRate > before.get(c.id).passRate).map((c) => c.id);
    const down = result.byCase.filter((c) => before.get(c.id) && c.passRate < before.get(c.id).passRate).map((c) => c.id);
    L.push("", `变好：${up.join("、") || "无"}　变差：${down.join("、") || "无"}`);
  }
  L.push("", "每道题的完整过程可以在 A.ai 里打开对应会话查看（标题就是题目），sessionId 在 json 结果里。");
  return L.join("\n") + "\n";
}

/**
 * 找对比对象：--compare 指定的那次；没指定就找最近一次“跑的题目完全一样”的结果。
 * 题目不同（比如只跑了 --only F04）时对比没有意义，宁可不比
 */
async function previous(current, ids) {
  const names = (await fs.readdir(RESULTS).catch(() => [])).filter((f) => f.endsWith(".json") && f !== current).sort().reverse();
  const load = async (name) => {
    try {
      return { file: name, ...JSON.parse(await fs.readFile(path.join(RESULTS, name), "utf8")) };
    } catch {
      return null;
    }
  };
  if (COMPARE) return load(COMPARE.endsWith(".json") ? COMPARE : COMPARE + ".json");
  for (const name of names) {
    const r = await load(name);
    if (r && JSON.stringify(r.cases) === JSON.stringify(ids)) return r;
  }
  return null;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const { cases: all } = JSON.parse(await fs.readFile(CASES, "utf8"));
  const cases = all.filter((c) => (!ONLY || ONLY.includes(c.id)) && (!CATS || CATS.includes(c.category)));
  if (!cases.length) throw new Error("没有符合条件的题目");

  console.log(`A.ai 测评 → ${BASE}　账号 ${USER}：${await signIn()}`);
  const { settings: original } = await json("GET", "/api/settings");
  const patch = { memory: false, commandApproval: "auto", ...(MODEL ? { currentModel: MODEL } : {}) };
  await json("PUT", "/api/settings", patch);
  const restore = async () => {
    await json("PUT", "/api/settings", { memory: original.memory, commandApproval: original.commandApproval, currentModel: original.currentModel }).catch((e) =>
      console.warn("恢复设置失败，请到设置页手动改回：", e.message),
    );
  };
  process.once("SIGINT", async () => {
    console.log("\n中断，恢复设置…");
    await restore();
    process.exit(130);
  });

  const info = await json("GET", "/api/info");
  console.log(`模型：${info.model}　题目：${cases.length} 道 × ${REPEAT} 次`);
  if (/mock/i.test(info.model)) console.log("⚠️  当前是 Mock 模型：只能验证测评流程能跑通，分数没有意义。用 --model 或在设置里给测评账号换成真实模型。");

  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const rows = [];
  try {
    for (const c of cases)
      for (let k = 1; k <= REPEAT; k++) {
        process.stdout.write(`  ${c.id} ${c.title}${REPEAT > 1 ? ` #${k}` : ""} … `);
        const r = await runCase(c, runId, k);
        rows.push(r);
        console.log(
          `${r.pass ? "✅" : "❌"} ${Math.round(r.score * 100)}%  ${r.steps ?? 0} 步 · ${r.toolCalls ?? 0} 次工具${r.toolErrors ? ` · ${r.toolErrors} 次出错` : ""} · ${Math.round(((r.inputTokens ?? 0) + (r.outputTokens ?? 0)) / 100) / 10}k token · ${(r.durationMs / 1000).toFixed(1)}s`,
        );
        for (const x of r.checks.filter((x) => !x.ok)) console.log(`      ✗ ${x.what}`);
        if (r.error) console.log(`      ✗ ${r.error}`);
      }
  } finally {
    await restore();
  }

  const result = {
    startedAt: startedAt.toISOString(),
    label: LABEL,
    base: BASE,
    model: info.model,
    repeat: REPEAT,
    cases: cases.map((c) => c.id),
    summary: summarize(rows),
    byCase: byCase(rows),
    rows,
  };
  await fs.mkdir(RESULTS, { recursive: true });
  const file = `${runId}.json`;
  const prev = await previous(file, result.cases);
  await fs.writeFile(path.join(RESULTS, file), JSON.stringify(result, null, 2));
  const md = report(result, prev);
  await fs.writeFile(path.join(RESULTS, `${runId}.md`), md);

  const s = result.summary;
  const p = prev?.summary;
  console.log(
    `\n通过 ${s.passed}/${s.cases}（${pct(s.passRate)}${delta(s.passRate, p?.passRate, { fmt: pct })}）　平均得分 ${pct(s.avgScore)}　平均 ${num(s.avgSteps)} 步　工具出错 ${s.toolErrors}　平均 ${Math.round(s.avgTokens)} token　平均 ${num(s.avgSeconds)} 秒`,
  );
  console.log(prev ? `对比：${prev.file}` : "没有跑过同一批题的旧结果，这次先当基线。");
  console.log(`报告：${path.relative(process.cwd(), path.join(RESULTS, `${runId}.md`))}`);
}

main().catch((e) => {
  console.error("测评失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
