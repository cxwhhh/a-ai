import "server-only";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSensitivePath, sandboxInfo, within } from "./sandbox";

/**
 * 文件工具的“能访问哪里”：和 run_command 用同一套规则（第 7.27 步的授权目录）。
 *
 * 以前文件工具只认工作区，终端却能进授权目录，于是常见这样的报错链：
 *   run_command 找到 /Users/me/Documents/q3.txt → read_file 读它 → “路径超出工作区”
 *   run_command 在 Docker 里 pwd 得到 /workspace/data → glob 用这个路径 → 同样报错
 * 现在所有文件工具都走 resolvePath()：
 *   相对路径            → 工作区里
 *   /workspace/…        → 换算成工作区（Docker 沙箱里看到的工作区路径）
 *   ~/… 或其他绝对路径  → 必须在工作区或某个授权目录里；写操作要求是 :rw 授权目录
 *   密钥、.env 这类文件 → 授权目录里也拒绝（工作区是用户自己的，不限制）
 * 符号链接会先取真实路径再检查，防止用链接跳到授权范围外。
 */
export interface Resolved {
  /** 本机上的绝对路径，直接交给 fs */
  full: string;
  /** 显示给模型的路径：工作区里用相对路径，授权目录用绝对路径 */
  shown: string;
  inWorkspace: boolean;
}

/** 模型能访问的目录，用在报错里：告诉它该去哪找，而不是只说“不行” */
export function accessibleDirs(): string {
  const dirs = sandboxInfo().dirs.map((d) => `${d.path}（${d.mode === "ro" ? "只读" : "可读写"}）`);
  return ["工作区（用相对路径）", ...dirs].join("、");
}

export function resolvePath(workspace: string, p: string | undefined, mode: "read" | "write"): Resolved {
  let raw = String(p ?? "").trim() || ".";
  if (raw === "~" || raw.startsWith("~/")) raw = path.join(os.homedir(), raw.slice(1));
  if (raw === "/workspace" || raw.startsWith("/workspace/")) raw = "." + raw.slice("/workspace".length);

  const ws = real(workspace);
  const full = real(path.isAbsolute(raw) ? path.resolve(/*turbopackIgnore: true*/ raw) : path.resolve(/*turbopackIgnore: true*/ ws, raw));
  if (within(full, [ws])) return { full, shown: path.relative(ws, full).split(path.sep).join("/") || ".", inWorkspace: true };

  if (!path.isAbsolute(raw)) throw new Error(`路径超出工作区：${p}`);
  const dir = sandboxInfo().dirs.find((d) => within(full, [d.path]));
  if (!dir) throw new Error(`${p} 不在授权范围内。可以访问的位置：${accessibleDirs()}`);
  if (isSensitivePath(full)) throw new Error(`不允许访问密钥、凭据或 .env 这类文件：${p}`);
  if (mode === "write" && dir.mode === "ro") throw new Error(`${dir.path} 是只读授权目录，不能修改。需要改的话先复制到工作区再处理`);
  // A.ai 自己跑在 Docker 里时看不到宿主机的授权目录，只有 run_command 的沙箱容器挂载了它们
  if (!existsSync(/*turbopackIgnore: true*/ dir.path)) throw new Error(`${dir.path} 只能通过 run_command 访问（A.ai 运行在容器里，文件工具看不到这个宿主机目录）`);
  return { full, shown: full, inWorkspace: false };
}

/**
 * 取真实路径（解开符号链接）。文件还不存在时（要新建），取最近一层存在的上级目录的真实路径再拼回去，
 * 这样 macOS 的 /tmp → /private/tmp 这类情况也能和授权目录对上。
 */
function real(p: string): string {
  let cur = p;
  const rest: string[] = [];
  while (!existsSync(/*turbopackIgnore: true*/ cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return p;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(/*turbopackIgnore: true*/ realpathSync(/*turbopackIgnore: true*/ cur), ...rest);
}
