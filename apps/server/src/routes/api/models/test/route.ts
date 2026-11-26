import { getSettings } from "../../../../../../../packages/application/settings/src/settings";
import { isMasked } from "../../../../../../../packages/protocol/src/lib/settings";
import { currentUser, unauthorized } from "../../../../../../../packages/application/users/src/auth";
import { joinUrl, readError } from "../../../../../../../packages/llm/src/providers/openai-compatible";
import { fetchModel } from "../../../../../../../packages/llm/src/providers/provider-fetch";
import { httpUrl, PrivateAddressError, readBoundedText } from "../../../../../../../packages/sandbox/src/public-fetch";
import Anthropic from "@anthropic-ai/sdk";


/**
 * POST /api/models/test  { id?, baseUrl, apiKey }
 * 测试连接：请求 {baseUrl}/models（OpenAI 兼容接口都有），成功则返回可用模型列表。
 * 浏览器里只有打码的 Key，所以如果传来的是 ••••abcd，就用服务端保存的真实 Key。
 */
export async function POST(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const b = (await req.json().catch(() => null)) as { id?: unknown; baseUrl?: unknown; apiKey?: unknown; preset?: unknown } | null;
  const base = typeof b?.baseUrl === "string" ? b.baseUrl.trim() : "";
  let origin: string;
  try { origin = httpUrl(base).origin; } catch {
    return Response.json({ ok: false, error: "请填写完整的 HTTP 或 HTTPS Base URL" });
  }
  let key = typeof b?.apiKey === "string" ? b.apiKey.trim() : "";
  if (!key || isMasked(key)) {
    const saved = getSettings(user.id).connections.find((c) => c.id === b?.id);
    if (saved?.apiKey) {
      // 打码值只引用原服务的密钥。地址变更后由用户提供该服务使用的 Key。
      try {
        if (httpUrl(saved.baseUrl).origin === origin) key = saved.apiKey;
        else key = "";
      } catch { key = ""; }
      if (!key) return Response.json({ ok: false, error: "接口地址已换站，请重新填写 API Key" });
    } else key = "";
  }
  if (!key) return Response.json({ ok: false, error: "请先填写 API Key" });

  const t0 = Date.now();
  if (b?.preset === "anthropic") return Response.json(await testAnthropic(base, key, t0));
  let res: Response;
  try {
    res = await fetchModel(joinUrl(base, "/models"), {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return Response.json({ ok: false, error: `连接失败：${causeOf(e)}${e instanceof PrivateAddressError ? "" : localHint(base)}` });
  }

  // 有些反代 / 本地服务只实现了 /chat/completions，没有 /models：连得上就算成功，模型名让用户手动填
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    await res.body?.cancel();
    return Response.json({ ok: true, ms: Date.now() - t0, models: [], note: NO_LIST });
  }
  if (!res.ok) return Response.json({ ok: false, error: await readError(res) });

  let responseText: string;
  try {
    responseText = await readBoundedText(res);
  } catch (error) {
    return Response.json({ ok: false, error: causeOf(error) });
  }
  let payload: unknown;
  try { payload = JSON.parse(responseText); } catch { /* 某些兼容服务不提供模型列表。 */ }
  const models = parseModels(payload);
  return Response.json({ ok: true, ms: Date.now() - t0, models, note: models.length ? undefined : NO_LIST });
}

/** Claude：用官方 SDK 列出模型（Anthropic 的 /v1/models 和 OpenAI 的格式、鉴权方式都不一样） */
async function testAnthropic(base: string, key: string, t0: number) {
  const fetchModelList: typeof fetch = async (input, init) => {
    const response = await fetchModel(input, init);
    return new Response(response.body ? await readBoundedText(response) : null, { status: response.status, headers: response.headers });
  };
  const client = new Anthropic({ apiKey: key, baseURL: base.replace(/\/+$/, "").replace(/\/v1$/, ""), timeout: 15000, maxRetries: 0, fetch: fetchModelList });
  try {
    const models: string[] = [];
    for await (const m of client.models.list({}, { signal: AbortSignal.timeout(15000) })) models.push(m.id);
    return { ok: true, ms: Date.now() - t0, models };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, error: "API Key 无效（401）" };
    if (e instanceof Anthropic.PermissionDeniedError) return { ok: false, error: "这个 Key 没有权限（403）" };
    if (e instanceof Anthropic.APIConnectionError) return { ok: false, error: `连接失败：${causeOf(e)}` };
    if (e instanceof Anthropic.APIError) return { ok: false, error: `接口返回 ${e.status}：${e.message.slice(0, 300)}` };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
