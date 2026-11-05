import type { StoredMessage } from "./shared";

/**
 * 按行对比两段文字，算出哪些行是新增（+）、删除（-）、不变（空格）。
 * 算法：最长公共子序列（LCS）。用一张表 dp[i][j] 记“a 的后 i 行和 b 的后 j 行最多有几行相同”，
 * 再从头走一遍：两行相同就是“不变”，否则看往哪边走公共部分更长，决定先删还是先加。
 * 复杂度 O(n×m)：几百行的代码毫无压力；超过 2000×2000 时直接当作“全删 + 全加”，避免卡住页面。
 */
export type DiffLine = { kind: "add" | "del" | "same"; text: string; oldNo?: number; newNo?: number };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) {
    return [...a.map((t, i) => ({ kind: "del" as const, text: t, oldNo: i + 1 })), ...b.map((t, j) => ({ kind: "add" as const, text: t, newNo: j + 1 }))];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) out.push({ kind: "same", text: a[i], oldNo: ++i, newNo: ++j });
    // 两边都能走时先删后加（和 git diff 一样：先显示旧的红色行，再显示新的绿色行）
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) out.push({ kind: "del", text: a[i], oldNo: ++i });
    else out.push({ kind: "add", text: b[j], newNo: ++j });
  }
  return out;
}

export const countDiff = (d: DiffLine[]) => ({ add: d.filter((x) => x.kind === "add").length, del: d.filter((x) => x.kind === "del").length });

/**
 * 一个文件在本次对话里被改过的每一次：
 * - edit_file：old_string → new_string 就是改动本身；line 是工具返回的起始行号（行号对齐用）
 * - write_file：如果之前在这个对话里写过同一个文件，就和上一次的内容对比；否则整篇都算新增
 * 纯前端从消息里算，不需要额外接口。
 */
export interface FileChange {
  id: string;
  tool: "edit_file" | "write_file";
  before: string;
  after: string;
  startLine: number;
  isNew: boolean; // write_file 且之前没写过：整篇新增
  ts: number;
}

const norm = (p: string) => p.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");

export function fileChanges(messages: StoredMessage[], path: string): FileChange[] {
  const target = norm(path);
  const results = new Map<string, StoredMessage>();
  for (const m of messages) if (m.role === "tool" && m.toolCallId) results.set(m.toolCallId, m);
  const out: FileChange[] = [];
  let last: string | null = null; // 本对话里上一次 write_file 写进去的全文
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) {
      if (c.name !== "edit_file" && c.name !== "write_file") continue;
      const r = results.get(c.id);
      if (!r || r.isError) continue;
      let a: Record<string, unknown>;
      try {
        a = JSON.parse(c.arguments || "{}");
      } catch {
        continue;
      }
      if (norm(String(a.path ?? "")) !== target) continue;
      let res: Record<string, unknown> = {};
      try {
        res = JSON.parse(r.content);
      } catch {
        /* 结果不是 JSON 时没有行号，从 1 开始 */
      }
      if (c.name === "edit_file") {
        out.push({ id: c.id, tool: "edit_file", before: String(a.old_string ?? ""), after: String(a.new_string ?? ""), startLine: Number(res.line) || 1, isNew: false, ts: r.createdAt });
        // 如果之前整篇写过，把这次替换也应用上，下一次 write_file 才能和“改完之后”的内容对比
        if (last !== null) last = last.replace(String(a.old_string ?? ""), String(a.new_string ?? ""));
      } else {
        const content = String(a.content ?? "");
        out.push({ id: c.id, tool: "write_file", before: last ?? "", after: content, startLine: 1, isNew: last === null, ts: r.createdAt });
        last = content;
      }
    }
  }
  return out;
}

/**
 * 整体改动：这个文件“对话开始前”的样子 → 现在的样子。
 * 拿现在的内容，把本次对话里的修改从最后一次开始往回撤销：
 *   - edit_file：把 new_string 换回 old_string
 *   - write_file：整篇被覆盖过。之前在本对话里写过，就退回上一次写入的内容；第一次写入则当作新文件，原样是空的
 */
export function originalOf(current: string, changes: FileChange[]): string {
  let text = current;
  for (let k = changes.length - 1; k >= 0; k--) {
    const c = changes[k];
    if (c.tool === "edit_file") text = text.replace(c.after, c.before);
    else if (c.isNew) return "";
    else text = c.before;
  }
  return text;
}
