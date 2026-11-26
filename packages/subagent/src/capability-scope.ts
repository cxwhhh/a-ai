import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import type { ToolRegistry } from "../../tool-runtime/src/types";
import { findTool, toolSpecs } from "../../tool-runtime/src/index";
import { resolvePath } from "../../workspace/src/access";
import { isSensitivePath } from "../../sandbox/src/sandbox";
import type { TaskContract } from "./task-contract";
import { SubagentRequestError } from "./task-contract";

export const FILE_TOOLS = new Set(["read_file", "read_document", "grep", "glob", "list_files"]);
// 单 path 的工具可在执行入口预检。多输入和多操作工具需在实现里按读路径检查。
const FILE_READ_TOOLS = new Set([...FILE_TOOLS, "query_data", "archive", "file_op"]);
const WEB_TOOLS = new Set(["web_search", "web_fetch", "download_file", "http_request"]);

/** 微调只接收现有 UTF-8 文本，避免文本替换损坏二进制或把读取扩大到授权外部目录。 */
export function resolveRevisionFile(workspace: string, requested: string) {
  const file = resolvePath(workspace, requested, "write");
  if (!file.inWorkspace || isSensitivePath(file.full)) throw new Error("只能微调当前对话内的普通文本文件");
  const stat = statSync(file.full);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("仅支持不超过 1 MB 的文本文件微调");
  const bytes = readFileSync(file.full);
  if (bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes)) throw new Error("仅支持 UTF-8 文本文件微调");
  return file;
}

/** 父 Agent 的目录用于收紧可见范围。文件微调也使用内置实现，插件无法替换执行入口。 */
export function capabilityScope(task: TaskContract, roleTools: readonly string[], options: {
  workspace: string;
  disabled: Record<string, string>;
  registry?: Pick<ToolRegistry, "toolSpecs">;
  revisionFile?: ReturnType<typeof resolveRevisionFile>;
}) {
  const { workspace, disabled, registry, revisionFile } = options;
  const parentTools = new Set((registry?.toolSpecs() ?? toolSpecs()).map(({ name }) => name));
  const roots = task.paths?.map((item) => {
    try { return resolvePath(workspace, item, "read").full; }
    catch { throw new SubagentRequestError("子任务的文件范围超出当前工作区或已有授权", 403); }
  }).sort();
  const hosts = task.hosts?.map((host) => {
    if (!/^[a-z0-9.-]+$/i.test(host) || host.startsWith(".") || host.endsWith(".")) {
      throw new SubagentRequestError("hosts 只能填写明确的主机名");
    }
    return host.toLowerCase();
  }).sort();
  const specs = toolSpecs().filter(({ name }) => parentTools.has(name) && !disabled[name] && (revisionFile
    ? name === "read_file" || name === "edit_file"
    : roleTools.includes(name) &&
    (task.tools === undefined || task.tools.includes(name)) &&
    !(roots?.length === 0 && FILE_READ_TOOLS.has(name)) &&
    !(hosts && (name === "web_search" || (hosts.length === 0 && WEB_TOOLS.has(name))))));
  const granted = new Set(specs.map(({ name }) => name));

  function readPath(requested?: string) {
    const resolved = resolvePath(workspace, requested, "read");
    if (revisionFile && resolved.full !== revisionFile.full) throw new Error("只能读取所选微调文件");
    if (roots && !roots.some((root) => {
      const relative = path.relative(root, resolved.full);
      return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    })) throw new Error("文件路径超出此子任务的读取范围");
    return resolved;
  }

  function checkUrl(url: URL) {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        (hosts && !hosts.includes(url.hostname.toLowerCase()))) {
      throw new Error("网页地址超出此子任务的访问范围");
    }
  }

  return {
    specs, readPath, checkUrl,
    revisionPath: revisionFile?.shown,
    editPath(requested: string) {
      if (!revisionFile || readPath(requested).full !== revisionFile.full) throw new Error("只能修改所选微调文件");
      const file = resolveRevisionFile(workspace, requested);
      if (file.full !== revisionFile.full) throw new Error("文件路径已改变，请重新打开文件");
      return file;
    },
    // 缓存命中也必须使用相同权限范围。授权目录解析使用真实路径，避免别名扩大权限。
    identity: { tools: [...granted].sort(), roots, hosts, workspace, revisionPath: revisionFile?.shown },
    find(name: string) { return granted.has(name) && !disabled[name] ? findTool(name) : undefined; },
  };
}

export type CapabilityScope = ReturnType<typeof capabilityScope>;
