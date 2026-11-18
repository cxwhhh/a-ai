import type { bootstrap } from "../../../packages/runtime/src/bootstrap";

export type Runtime = Awaited<ReturnType<typeof bootstrap>>["root"];
type Parameters = Record<string, string>;
export interface RouteContext {
  params: Promise<Parameters>;
  runtime: Runtime;
}
type Handler = (request: Request, context: RouteContext) => Response | Promise<Response>;

/** 路由按固定段与参数段匹配。动态参数解码一次，业务处理函数只收到自己的参数。 */
export class Router {
  private readonly routes: { segments: string[]; methods: Record<string, Handler> }[] = [];

  register(pathname: string, methods: object) {
    this.routes.push({ segments: pathname.split("/"), methods: methods as Record<string, Handler> });
  }

  async dispatch(request: Request, runtime: Runtime): Promise<Response | undefined> {
    const pathname = new URL(request.url).pathname.replace(/\/$/, "") || "/";
    const incoming = pathname.split("/");
    for (const { segments, methods } of this.routes) {
      if (segments.length !== incoming.length) continue;
      const params: Parameters = {};
      let matches = true;
      for (const [index, segment] of segments.entries()) {
        if (segment.startsWith(":")) {
          try { params[segment.slice(1)] = decodeURIComponent(incoming[index]); }
          catch { return Response.json({ error: "无效的 URL 参数" }, { status: 400 }); }
        } else if (segment !== incoming[index]) { matches = false; break; }
      }
      if (!matches) continue;
      const handler = methods[request.method] ?? (request.method === "HEAD" ? methods.GET : undefined);
      if (handler) return handler(request, { params: Promise.resolve(params), runtime });
      const allow = Object.keys(methods).filter((method) => /^[A-Z]+$/.test(method));
      if (methods.GET && !methods.HEAD) allow.push("HEAD");
      return new Response(null, { status: request.method === "OPTIONS" ? 204 : 405, headers: { Allow: [...allow, "OPTIONS"].join(", ") } });
    }
  }
}
