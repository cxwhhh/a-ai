import "server-only";
import { httpHint, safeFetch, UA } from "./web-fetch";
import type { Tool } from "./types";

/**
 * 调用公开的 HTTP API（天气、汇率、GitHub、公开数据接口…），拿回 JSON。
 * web_fetch 只会 GET 网页并把 HTML 变成正文，不能带请求头、不能 POST，也不保留 JSON 结构；这个工具补上这一块。
 *
 * 安全：
 *   - 和 web_fetch 共用 safeFetch：只能访问公网，本机和内网地址（包括重定向过去的）一律拒绝，防 SSRF
 *   - GET / HEAD 只读，直接执行；POST、PUT、PATCH、DELETE 会在别人的系统里留下改动（发消息、下单、删数据），
 *     每次都先请用户确认（和 run_command 的确认卡片是同一个）
 *   - 模型拿不到用户的任何密钥：要 API Key 的接口，需要用户在对话里自己给出
 */
const MAX_BODY = 12000;
type Args = { url: string; method?: string; headers?: Record<string, string>; body?: unknown };

export const httpRequest: Tool<Args> = {
  spec: {
    name: "http_request",
    description:
      "向公开 API 发送 HTTP 请求，返回 {status, contentType, body}（JSON 会解析好，最多约 12000 字）。" +
      "适合：调用有文档的 REST API（天气、汇率、公开数据、用户提供了 Key 的服务），需要自定义请求头或 POST JSON。" +
      "GET 直接执行；POST、PUT、PATCH、DELETE 会先请用户确认。" +
      "不要用于：读网页正文（用 web_fetch）；下载文件（用 download_file）；本机和内网地址（不允许）。不要编造接口地址，不确定时先 web_search 查文档。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "完整网址，查询参数直接写在里面。例：https://api.frankfurter.app/latest?from=USD&to=JPY" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], description: "默认 GET" },
        headers: { type: "object", description: "请求头。例：{\"Accept\":\"application/json\"}" },
        body: { type: "string", description: "请求体。JSON 直接写成 JSON 字符串，会自动加 Content-Type: application/json" },
      },
      required: ["url"],
    },
  },
  async run({ url, method, headers, body }, ctx) {
    const m = String(method || "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(m)) throw new Error(`method 只能是 GET、POST、PUT、PATCH、DELETE、HEAD，收到：${method}`);
    let h: Record<string, string> = {};
    try {
      const raw = typeof headers === "string" ? JSON.parse(headers) : headers ?? {};
      h = Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    } catch {
      throw new Error('headers 要是对象，例：{"Accept":"application/json"}');
    }
    let payload: string | undefined;
    if (body !== undefined && body !== null && body !== "") {
      if (m === "GET" || m === "HEAD") throw new Error(`${m} 请求不能带 body。参数写进网址的 ?a=1&b=2 里`);
      payload = typeof body === "string" ? body : JSON.stringify(body);
      const isJson = (() => { try { JSON.parse(payload); return true; } catch { return false; } })();
      if (isJson && !Object.keys(h).some((k) => k.toLowerCase() === "content-type")) h["Content-Type"] = "application/json";
    }

    // 会改动别人系统的请求：先问用户
    if (m !== "GET" && m !== "HEAD" && ctx.confirm) {
      const preview = payload ? `\n${payload.length > 300 ? payload.slice(0, 300) + "…" : payload}` : "";
      const ok = await ctx.confirm({ command: `${m} ${url}${preview}`, reason: "这个请求可能会修改对方系统里的数据（发送、创建、删除）", readonly: false });
      if (!ok) return { content: JSON.stringify({ denied: true, message: "用户拒绝了这个请求。不要换个方式再发，先问用户想怎么做" }) };
    }

    const timeout = AbortSignal.timeout(20_000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    const res = await safeFetch(url, { method: m, signal, body: payload, headers: { "User-Agent": UA, Accept: "application/json, text/plain, */*", ...h } });
    const type = (res.headers.get("content-type") || "").split(";")[0];
    if (m === "HEAD" || res.status === 204) return { content: JSON.stringify({ status: res.status, contentType: type, headers: Object.fromEntries(res.headers) }) };
    if (type && !/json|text|xml|javascript|html/i.test(type)) {
      await res.body?.cancel();
      throw new Error(`返回的是 ${type}（二进制文件）。下载文件请用 download_file`);
    }
    const text = await res.text();
    let parsed: unknown = text;
    if (/json/i.test(type) || /^\s*[[{]/.test(text))
      try {
        parsed = JSON.parse(text);
      } catch {
        /* 不是 JSON，按文本返回 */
      }
    const shown = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    const truncated = shown.length > MAX_BODY;
    return {
      content: JSON.stringify({
        status: res.status,
        contentType: type,
        body: truncated ? shown.slice(0, MAX_BODY) : parsed,
        ...(truncated ? { truncated: true, note: "结果太长被截断了。用接口的分页、筛选参数只取需要的部分" } : {}),
        ...(res.ok ? {} : { error: `请求失败：HTTP ${res.status}${httpHint(res.status)}` }),
      }),
      // 4xx / 5xx 也把响应体交给模型（API 的报错说明常在里面），但状态记为失败，过程里显示红色
      ...(res.ok ? {} : { status: "error" as const, errorKind: "network" as const }),
    };
  },
};
