import type { ToolSpec } from "../../llm/types";
import type { Tool } from "./types";

/**
 * 所有工具共用的“外壳”：在注册表里（index.ts）给每个工具套一层，工具文件本身不用重复写这些。
 *
 *   1. purpose 必填：每个工具的参数里都加一个 purpose（这一步的目的），放在第一个。
 *      模型按参数顺序生成 JSON，purpose 在最前面 = 先写“为什么做这一步”，再写具体参数，相当于逼它先想一下。
 *      过程（Trace）里用它当这一步的标题，用户也能看懂 agent 在干什么。
 *      运行时不因为缺 purpose 报错：为了一个说明字段让整个调用失败、多耗一步，不划算。
 *   2. 执行前检查参数：缺必填参数、类型不对、枚举值写错、参数名写错（file_path / filepath 写成 path）
 *      → 报错里说清楚“缺什么、应该怎么写、例子”，而不是让工具跑到一半抛一个看不懂的错。
 *      能安全修正的直接修正：数字写成了字符串 "10"、布尔写成 "true"、数组写成了 JSON 字符串。
 *   3. 把 Node 的系统错误（EACCES、ENOSPC…）翻译成中文，并附上下一步怎么办。
 */

type Schema = { type?: string; enum?: unknown[]; description?: string; items?: Schema; properties?: Record<string, Schema>; required?: string[] };

const PURPOSE: Schema = {
  type: "string",
  description: "这一步的目的：为什么要做、想得到什么，一句话，显示在过程里给用户看。先想清楚再写。例：确认数据文件的列名，再决定怎么统计",
};

/** 参数里加上必填的 purpose，并排在第一个（工具自己写了更具体的 purpose 说明就用它的） */
export function withPurpose(spec: ToolSpec): ToolSpec {
  const params = spec.parameters as Schema;
  const props = params.properties ?? {};
  const { purpose = PURPOSE, ...rest } = props;
  const required = ["purpose", ...(params.required ?? []).filter((r) => r !== "purpose")];
  return { ...spec, parameters: { ...params, type: "object", properties: { purpose, ...rest }, required } as ToolSpec["parameters"] };
}

/**
 * 检查并（在安全的情况下）修正参数。返回修正后的参数；有修不了的问题就抛错，错误信息直接给模型看。
 * 只看第一层参数：嵌套对象（todo_write 的 todos[]）由工具自己检查。
 */
export function checkArgs(spec: ToolSpec, input: Record<string, unknown>, opts: { strict?: boolean } = {}): Record<string, unknown> {
  const params = spec.parameters as Schema;
  const props = params.properties ?? {};
  const args = { ...input };
  const problems: string[] = [];

  for (const [key, schema] of Object.entries(props)) {
    if (args[key] === undefined || args[key] === null) continue;
    const fixed = coerce(args[key], schema);
    if (fixed.ok) args[key] = fixed.value;
    else problems.push(`${key} 应该是${typeName(schema)}，收到的是 ${preview(args[key])}`);
    if (fixed.ok && schema.enum && !schema.enum.includes(args[key])) problems.push(`${key} 只能是 ${schema.enum.map((v) => JSON.stringify(v)).join(" / ")}，收到的是 ${preview(args[key])}`);
    // 数组元素也检查（只检查简单类型：字符串、数字…；对象元素由工具自己检查）
    if (fixed.ok && Array.isArray(args[key]) && schema.items?.type && schema.items.type !== "object") {
      const arr = args[key] as unknown[];
      arr.forEach((item, i) => {
        const f = coerce(item, schema.items!);
        if (f.ok) arr[i] = f.value;
        else problems.push(`${key}[${i}] 应该是${typeName(schema.items!)}，收到的是 ${preview(item)}`);
      });
    }
  }

  // purpose 是 withPurpose() 统一加的，不在工具自己的 spec 里，不算“不认识的参数”
  const unknown = Object.keys(args).filter((k) => !(k in props) && k !== "purpose");
  for (const key of params.required ?? []) {
    if (key === "purpose") continue;
    // 空字符串不算缺：edit_file 的 new_string=""（删除）、write_file 的空文件都是合法的，由工具自己判断
    if (args[key] !== undefined && args[key] !== null) continue;
    // 参数名写错是最常见的原因：file_path、filepath、file 其实就是 path
    const alias = unknown.find((u) => similar(u, key));
    // 写文件、跑代码这类有副作用的工具（strict）不自动改参数名：猜错了就是写错文件、清空内容（M1-01），只在报错里提示
    if (alias !== undefined && opts.strict) {
      problems.push(`缺少必填参数 ${key}（你传的 ${alias} 是不是想写 ${key}？这个工具会修改文件或运行代码，不会自动猜参数，请改成 ${key} 重新调用）`);
      continue;
    }
    if (alias !== undefined) {
      args[key] = coerce(args[alias], props[key] ?? {}).value ?? args[alias];
      delete args[alias];
      continue;
    }
    problems.push(`缺少必填参数 ${key}（${typeName(props[key] ?? {})}${props[key]?.description ? `：${props[key].description}` : ""}）`);
  }

  if (problems.length) {
    const names = Object.keys(props).filter((k) => k !== "purpose");
    const extra = unknown.filter((k) => k in args);
    throw new Error(
      `参数有误：${problems.join("；")}。` +
        (extra.length ? `不认识的参数：${extra.join("、")}。` : "") +
        `${spec.name} 的参数是 ${names.map((n) => ((params.required ?? []).includes(n) ? `${n}（必填）` : n)).join("、")}，改好后再调用一次。`,
    );
  }
  return args;
}

function coerce(v: unknown, s: Schema): { ok: boolean; value?: unknown } {
  switch (s.type) {
    case "string":
      if (typeof v === "string") return { ok: true, value: v };
      if (typeof v === "number" || typeof v === "boolean") return { ok: true, value: String(v) };
      // 要字符串却给了对象 / 数组：多半是 JSON 内容（http_request 的 body 最常见），原样转成 JSON 文本，不改内容
      if (v && typeof v === "object") return { ok: true, value: JSON.stringify(v) };
      return { ok: false };
    case "integer":
    case "number": {
      const n = typeof v === "string" && v.trim() ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) return { ok: false };
      return { ok: true, value: s.type === "integer" ? Math.trunc(n) : n };
    }
    case "boolean":
      if (typeof v === "boolean") return { ok: true, value: v };
      if (v === "true" || v === "false") return { ok: true, value: v === "true" };
      return { ok: false };
    case "array":
      if (Array.isArray(v)) return { ok: true, value: v };
      // 有的模型把数组写成字符串：'["a","b"]'
      if (typeof v === "string") {
        try {
          const p = JSON.parse(v);
          if (Array.isArray(p)) return { ok: true, value: p };
        } catch {
          /* 不是 JSON */
        }
        // 只有一个值时直接写成了字符串："a.csv" → ["a.csv"]
        if (v.trim() && (!s.items?.type || s.items.type === "string")) return { ok: true, value: [v] };
      }
      return { ok: false };
    default:
      return { ok: true, value: v };
  }
}

/** file_path ≈ path、filepath ≈ path、cmd ≈ command、query_text ≈ query…：去掉 _ 后一个包含另一个 */
function similar(a: string, b: string) {
  const x = a.toLowerCase().replace(/[_-]/g, "");
  const y = b.toLowerCase().replace(/[_-]/g, "");
  return x !== y && (x.includes(y) || y.includes(x) || (ALIASES[y] ?? []).includes(x));
}
const ALIASES: Record<string, string[]> = { command: ["cmd"], content: ["text", "body"], code: ["script", "source"], pattern: ["regex", "glob"], url: ["link", "href"] };

const typeName = (s: Schema) =>
  ({ string: "字符串", integer: "整数", number: "数字", boolean: "true/false", array: "数组", object: "对象" })[s.type ?? ""] ?? "任意值";

const preview = (v: unknown) => {
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
};

/**
 * Node 系统错误 → 中文原因 + 下一步。工具里没有专门处理的 fs 错误都会走到这里。
 * 已经是中文说明的错误（工具自己抛的）原样保留。
 */
export function explainError(e: unknown): Error {
  const err = e as NodeJS.ErrnoException;
  const where = err.path ? `（${err.path}）` : "";
  const hint: Record<string, string> = {
    ENOENT: `文件或目录不存在${where}。先用 glob 或 list_files 确认路径，路径相对工作区`,
    EACCES: `没有权限${where}。换到工作区里操作；确实需要这个位置时用 ask_user 请用户授权`,
    EPERM: `操作被系统拒绝${where}。换到工作区里操作，或用 ask_user 说明需要什么权限`,
    EISDIR: `这是目录不是文件${where}。用 list_files 看里面有什么`,
    ENOTDIR: `路径中间有一段是文件不是目录${where}。用 list_files 检查路径`,
    EEXIST: `已经存在${where}。换一个名字，或先确认要不要覆盖`,
    ENOTEMPTY: `目录不是空的${where}`,
    ENOSPC: "磁盘空间不足。删掉不需要的大文件后再试，或告诉用户磁盘满了",
    EMFILE: "同时打开的文件太多。减少一次处理的文件数，分批做",
    ETIMEDOUT: "连接超时。稍后再试一次；仍然超时就换一个来源或告诉用户",
    ECONNREFUSED: "连接被拒绝：对方服务没有运行或不允许访问",
    ENOTFOUND: "域名解析失败：检查网址是否拼错",
  };
  if (err?.code && hint[err.code]) return new Error(hint[err.code]);
  return e instanceof Error ? e : new Error(String(e));
}

/** 给工具套上外壳：spec 加 purpose，run 之前检查参数，run 抛的系统错误翻译成中文 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function prepare(tool: Tool<any>): Tool<any> {
  const spec = withPurpose(tool.spec);
  return {
    ...tool,
    spec,
    async run(args, ctx) {
      // 只读工具参数名写错可以自动纠正；有副作用的工具严格检查
      const checked = checkArgs(tool.spec, args ?? {}, { strict: !tool.parallelSafe });
      try {
        return await tool.run(checked, ctx);
      } catch (e) {
        throw explainError(e);
      }
    },
  };
}
