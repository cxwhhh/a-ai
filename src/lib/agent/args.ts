/**
 * 把模型给的工具参数（JSON 字符串）解析成对象，尽量“宽容”。
 *
 * 为什么需要：模型不一定每次都给出标准 JSON。实际遇到过的情况：
 *   ""、"null"、"  "                → 没有参数，当成 {}
 *   "{}{}"、'{"a":1}{"a":1}'        → 同一个调用的参数被发了两遍（部分 OpenAI 兼容服务 / 本地模型在流式输出时会重复）
 *   "```json\n{...}\n```"           → 套了一层 markdown 代码块
 *   '{"a":1}\n' + 多余的文字         → 对象后面跟了别的内容
 *   '{"a":1,}'                      → 末尾多一个逗号
 * 以前一律报“参数不是合法 JSON”，模型又看不到自己到底发了什么，只能一遍遍重试同样的错误。
 * 现在：能修就修（取第一个完整的 JSON 对象）；实在修不了，报错里带上收到的原文，让模型知道错在哪。
 */
export function parseToolArgs(raw: string | undefined): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const s = String(raw ?? "").trim();
  if (!s || s === "null" || s === "{}") return { ok: true, args: {} };

  const direct = tryObject(s);
  if (direct) return { ok: true, args: direct };

  // 去掉 ```json … ``` 外壳
  const unfenced = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  // 取第一个括号配平的 {...}：解决“参数重复两遍”和“后面跟了多余文字”
  const first = firstObject(unfenced);
  for (const candidate of [unfenced, first, first?.replace(/,\s*([}\]])/g, "$1")]) {
    const v = candidate ? tryObject(candidate) : null;
    if (v) return { ok: true, args: v };
  }

  const shown = s.length > 300 ? s.slice(0, 300) + "…" : s;
  return {
    ok: false,
    error:
      `参数不是合法 JSON。收到的原文是：${shown}\n` +
      "参数必须是一个 JSON 对象，例如 {\"path\": \"a.txt\"}；这个工具不需要参数时传 {}。",
  };
}

function tryObject(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    if (v === null) return {};
    return typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** 从头扫描，返回第一个括号配平的 {...}（会跳过字符串里的括号和转义） */
function firstObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/**
 * 存进历史之前先把能修的参数修成标准 JSON：
 * 这条 assistant 消息下次会原样发回模型，带着 "{}{}" 这种参数，有的 API 会直接返回 400，模型也会照着学错。
 * 修不了的保持原样，执行时会报错并告诉模型原文。
 */
export function normalizeArgs(raw: string | undefined): string {
  const r = parseToolArgs(raw);
  if (!r.ok) return String(raw ?? "");
  const s = String(raw ?? "").trim();
  return tryObject(s) && s !== "null" ? s : JSON.stringify(r.args);
}
