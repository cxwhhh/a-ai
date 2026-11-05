import { getSettings } from "@/lib/server/settings";
import { isMasked } from "@/lib/settings";
import { currentUser, unauthorized } from "@/lib/server/auth";
import { joinUrl, readError } from "@/lib/llm/providers/openai-compatible";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/models/test  { id?, baseUrl, apiKey }
 * 测试连接：请求 {baseUrl}/models（OpenAI 兼容接口都有），成功则返回可用模型列表。
 * 浏览器里只有打码的 Key，所以如果传来的是 ••••abcd，就用服务端保存的真实 Key。
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const b = (await req.json().catch(() => ({}))) as { id?: string; baseUrl?: string; apiKey?: string };
  let key = (b.apiKey ?? "").trim();
  if (!key || isMasked(key)) key = getSettings(user.id).connections.find((c) => c.id === b.id)?.apiKey ?? "";
  const base = (b.baseUrl ?? "").trim();
  if (!/^https?:\/\//.test(base)) return Response.json({ ok: false, error: "Base URL 需要以 http:// 或 https:// 开头" });
  if (!key) return Response.json({ ok: false, error: "请先填写 API Key" });

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(joinUrl(base, "/models"), {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return Response.json({ ok: false, error: `连接失败：${causeOf(e)}${localHint(base)}` });
  }

  // 有些反代 / 本地服务只实现了 /chat/completions，没有 /models：连得上就算成功，模型名让用户手动填
  if (res.status === 404 || res.status === 405 || res.status === 501)
    return Response.json({ ok: true, ms: Date.now() - t0, models: [], note: NO_LIST });
  if (!res.ok) return Response.json({ ok: false, error: await readError(res) });

  const models = parseModels(await res.json().catch(() => null));
  return Response.json({ ok: true, ms: Date.now() - t0, models, note: models.length ? undefined : NO_LIST });
}

const NO_LIST = "这个接口没有返回模型列表。点下面的“+ 添加模型”，手动填上模型名（和你在其他客户端里填的一样）即可";

/**
 * 各家返回的模型列表格式不完全一样，常见的几种都认：
 *   { data: [{ id }] }       OpenAI 标准
 *   { models: [{ name }] }   Ollama 等
 *   [{ id }] 或 ["名字"]      一些反代直接返回数组
 */
function parseModels(j: unknown): string[] {
  const list = Array.isArray(j) ? j : j && typeof j === "object" ? ((j as Record<string, unknown>).data ?? (j as Record<string, unknown>).models) : null;
  if (!Array.isArray(list)) return [];
  const ids = list
    .map((m) => (typeof m === "string" ? m : m && typeof m === "object" ? ((m as Record<string, unknown>).id ?? (m as Record<string, unknown>).name ?? (m as Record<string, unknown>).model) : null))
    .filter((x): x is string => typeof x === "string" && !!x.trim());
  return [...new Set(ids)].sort();
}

/** fetch 失败时真正的原因藏在 e.cause 里（例如 ECONNREFUSED），把它拿出来 */
function causeOf(e: unknown) {
  const c = (e as { cause?: { code?: string; message?: string } })?.cause;
  return c?.code || c?.message || (e instanceof Error ? e.message : String(e));
}

/**
 * 地址是 127.0.0.1 / localhost 却连不上，最常见的原因是 A.ai 和这个服务不在同一台机器（或同一个容器）里：
 * 127.0.0.1 永远指“A.ai 服务端自己”，而不是你的浏览器所在的电脑
 */
function localHint(base: string) {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)[:/]/i.test(base)) return "";
  return "。注意：127.0.0.1 指的是运行 A.ai 服务端的那台机器。如果 A.ai 跑在 Docker 里，请改成 http://host.docker.internal:端口/v1；如果 A.ai 跑在别的服务器上，要填这个服务所在电脑的局域网 IP，并让服务监听 0.0.0.0";
}
