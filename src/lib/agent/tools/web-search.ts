import "server-only";
import { decode } from "./web-fetch";
import type { Tool } from "./types";

/**
 * 网页搜索：给关键词，返回一组 {title, url, snippet}。
 * 和 web_fetch 配合使用：先 web_search 找到网址，再 web_fetch 读正文 —— 之前没有它，模型没有网址时只能瞎猜。
 *
 * 搜索后端按环境变量自动选（在 .env.local 里配置，Docker 部署写进 .env）：
 *   TAVILY_API_KEY        → Tavily（专为 agent 设计，结果质量好，有免费额度）
 *   BRAVE_SEARCH_API_KEY  → Brave Search API
 *   都没配                → DuckDuckGo 的 HTML 版（免费、不用 Key，但请求多了可能被限流）
 * 每个后端都转换成同一种结果格式，模型不需要知道用的是哪家（和 LLMProvider 是同一个思路：接口统一、实现可换）。
 */
interface Hit {
  title: string;
  url: string;
  snippet: string;
}

export const webSearch: Tool<{ query: string; max_results?: number }> = {
  parallelSafe: true,
  spec: {
    name: "web_search",
    description:
      "用搜索引擎搜索网页，返回 {query, engine, results: [{title, url, snippet}]}。" +
      "适合：需要最新信息（新闻、价格、版本、文档、报错的解决办法），或不知道确切网址。snippet 只是摘要，需要细节时再用 web_fetch 打开最相关的 1~3 个网址。关键词要具体，可以同时发几个不同角度的搜索。" +
      "不要用于：已经有网址时（直接 web_fetch）；工作区里的文件（用 grep / glob）；你本来就确定知道的常识。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词。例：pandas read_excel engine openpyxl 报错、2026 日本 AI agent 求人" },
        max_results: { type: "integer", description: "返回几条，默认 6，最多 10" },
      },
      required: ["query"],
    },
  },
  async run({ query, max_results }, ctx) {
    const q = String(query ?? "").trim();
    if (!q) throw new Error("query 不能为空。写几个具体的关键词，例：pandas read_excel 中文乱码");
    const n = Math.min(Math.max(1, Math.floor(Number(max_results) || 6)), 10);
    const timeout = AbortSignal.timeout(15000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;

    const [engine, search] = process.env.TAVILY_API_KEY
      ? ["tavily", tavily]
      : process.env.BRAVE_SEARCH_API_KEY
        ? ["brave", brave]
        : ["duckduckgo", duckduckgo];
    let results: Hit[];
    try {
      results = await search(q, n, signal);
    } catch (e) {
      // fetch 连不上时只会说“fetch failed”，真正的原因（DNS、超时、被墙）在 cause 里
      const err = e as Error & { cause?: { code?: string; message?: string } };
      if (err.name === "TimeoutError") throw new Error(`${engine} 搜索超时（15 秒）。换个更短的关键词再试一次；仍然超时就告诉用户现在搜不了`);
      if (err.message === "fetch failed") throw new Error(`连不上 ${engine}：${err.cause?.code ?? err.cause?.message ?? "网络错误"}。服务器现在可能不能联网，不要反复重试，告诉用户需要检查网络或代理`);
      throw e;
    }

    return { content: JSON.stringify({ query: q, engine, results: results.slice(0, n) }) };
  },
};

async function tavily(q: string, n: number, signal: AbortSignal): Promise<Hit[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({ query: q, max_results: n }),
  });
  if (!res.ok) throw new Error(`Tavily 搜索失败：HTTP ${res.status}`);
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: clip(r.content ?? "") }));
}

async function brave(q: string, n: number, signal: AbortSignal): Promise<Hit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`;
  const res = await fetch(url, { signal, headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY! } });
  if (!res.ok) throw new Error(`Brave 搜索失败：HTTP ${res.status}`);
  const data = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
  return (data.web?.results ?? []).map((r) => ({ title: strip(r.title ?? ""), url: r.url ?? "", snippet: clip(strip(r.description ?? "")) }));
}

/**
 * DuckDuckGo 的无 JS 版本（html.duckduckgo.com）：返回普通 HTML，用正则取出每条结果。
 * 结果链接是跳转地址 //duckduckgo.com/l/?uddg=<真实网址>，要把 uddg 参数解出来。
 * 这是“爬网页”，页面结构变了就会失效 —— 正式使用建议配一个搜索 API Key。
 */
async function duckduckgo(q: string, n: number, signal: AbortSignal): Promise<Hit[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    },
    body: new URLSearchParams({ q }).toString(),
  });
  if (!res.ok) throw new Error(`DuckDuckGo 搜索失败：HTTP ${res.status}。可以在 .env.local 里配置 TAVILY_API_KEY 换成更稳定的搜索 API`);
  const html = await res.text();

  const hits: Hit[] = [];
  // 每条结果：<a class="result__a" href="…">标题</a> … <a class="result__snippet" …>摘要</a>
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1);
  for (const b of blocks) {
    const a = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    const href = decode(a[1]);
    let url = href;
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) url = decodeURIComponent(uddg[1]);
    else if (url.startsWith("//")) url = "https:" + url;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // 广告
    const snip = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    hits.push({ title: strip(a[2]), url, snippet: clip(strip(snip?.[1] ?? "")) });
    if (hits.length >= n) break;
  }
  if (!hits.length && /anomaly|captcha|challenge/i.test(html))
    throw new Error("DuckDuckGo 暂时限制了搜索请求（需要人机验证）。可以稍后再试，或在 .env.local 里配置 TAVILY_API_KEY");
  return hits;
}

/** 去掉 HTML 标签（标题里的 <b> 高亮）并还原实体 */
const strip = (s: string) => decode(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const clip = (s: string) => (s.length > 400 ? s.slice(0, 400) + "…" : s);
