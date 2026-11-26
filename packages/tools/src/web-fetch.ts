import type { Tool } from "../../tool-runtime/src/types";
import { fetchPublic, httpUrl, readBoundedText } from "../../sandbox/src/public-fetch";
export { isPrivateHost } from "../../sandbox/src/public-fetch";

const MAX_CHARS = 8000;

/**
 * 读取网页正文。让 agent 能获取训练数据之外的最新信息。
 * 安全：只允许 http/https，拒绝本机和内网地址（防止 SSRF：模型被诱导去访问你的内网服务）。
 */
export const webFetch: Tool<{
  url: string;
  purpose?: string
}> = {
  parallelSafe: true,
  spec: {
    name: "web_fetch",
    description:
      "抓取一个公开网页，返回 {url, title, content, truncated}，content 是纯文本正文，最多约 8000 字（truncated=true 表示被截断）。" +
      "适合：用户给了链接，或要看 web_search 结果里某个网页的详细内容。" +
      "不要用于：搜索（它不能搜索，没有确切网址时先 web_search，不要编造网址）；PDF、Excel、图片等文件（用 download_file 下载后再读）。不能访问本机和内网地址。",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "完整的 http(s) 网址，必须来自用户或之前的工具结果。例：https://docs.python.org/3/whatsnew/3.13.html",
        },
      },
      required: ["url"],
    },
  },
  async run({ url }, ctx) {
    const timeout = AbortSignal.timeout(15000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    const res = await safeFetch(url, {
      signal,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,text/plain,*/*"
      }
    }, ctx.checkWebUrl);
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`打开网页失败：HTTP ${res.status}${httpHint(res.status)}`);
    }

    const type = res.headers.get("content-type") || "";
    // PDF、Office 文档、图片、压缩包：按文本读会是一堆乱码，告诉模型换工具
    if (type && !/text\/|html|xml|json|javascript/i.test(type)) {
      await res.body?.cancel();
      throw new Error(`这个网址返回的是 ${type.split(";")[0]}，不是网页。请用 download_file 下载到工作区，再用 read_document（PDF/Word/Excel/PPT）或 run_python 处理`);
    }
    const raw = await readBoundedText(res);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim() ?? "";
    const text = type.includes("html") ? htmlToText(raw) : raw;
    const truncated = text.length > MAX_CHARS;
    return {
      content: JSON.stringify({
        url: res.url,
        title: decode(title),
        content: text.slice(0, MAX_CHARS),
        truncated,
      }),
    };
  },
};

/** HTTP 状态码 → 下一步怎么办（web_fetch、download_file 共用） */
export function httpHint(status: number) {
  if (status === 404 || status === 410) return "，网页不存在。不要猜网址，用 web_search 找正确的链接";
  if (status === 401 || status === 403) return "，网站拒绝访问（可能要登录或禁止抓取）。换 web_search 结果里的其他来源";
  if (status === 429) return "，请求太频繁被限流。换一个来源，不要马上重试";
  if (status >= 500) return "，对方服务器出错。稍后再试一次，或换一个来源";
  return "";
}
export const UA = "Mozilla/5.0 (compatible; A.ai/0.1; +agent)";

/**
 * 防 SSRF 的 fetch：只允许 http/https，每一跳都检查目标不是本机或内网。
 *   - 不只看网址里写的主机名，还做一次 DNS 解析：evil.example.com 也可能解析到 127.0.0.1
 *   - 自己处理重定向（redirect: "manual"）：公网地址 302 跳到 http://192.168.1.1 也会被拦下
 */
export async function safeFetch(url: string, init: RequestInit & { signal?: AbortSignal }, checkUrl?: (url: URL) => void): Promise<Response> {
  let u: URL;
  try {
    u = httpUrl(String(url ?? ""));
  } catch {
    throw new Error(`不是有效的网址：${url}。要写完整的 http(s)://… 地址；没有网址就先 web_search`);
  }
  let headers = new Headers(init.headers);
  headers.delete("host");
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  for (let hop = 0; hop < 6; hop++) {
    checkUrl?.(u);
    const res = await fetchPublic(u, {
      ...init,
      headers, method, body,
      redirect: "manual"
    });
    const loc = res.headers.get("location");
    if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
      await res.body?.cancel();
      const next = httpUrl(new URL(loc, u));
      if (next.origin !== u.origin) {
        // 自定义头也可能携带 API Key。换源后仅保留工具生成的通用头。
        headers = new Headers({ Accept: "*/*", "User-Agent": UA });
        if (method !== "GET" && method !== "HEAD") throw new Error("会修改数据的 HTTP 请求不能跨站重定向");
      }
      if ((res.status === 303 && method !== "HEAD") || ([301, 302].includes(res.status) && method === "POST")) {
        method = "GET";
        body = undefined;
        for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) headers.delete(name);
      }
      u = next;
      continue;
    }
    return res;
  }
  throw new Error("重定向次数太多");
}

function htmlToText(html: string) {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export function decode(s: string) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}
