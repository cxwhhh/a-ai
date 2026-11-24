import path from "node:path";
import type { ToolRegistry } from "../../tool-runtime/src/types";
import { findTool, toolSpecs } from "../../tool-runtime/src/index";
import { resolvePath } from "../../workspace/src/access";
import type { TaskContract } from "./task-contract";
import { SubagentRequestError } from "./task-contract";

export const FILE_TOOLS = new Set(["read_file", "read_document", "grep", "glob", "list_files"]);
const WEB_TOOLS = new Set(["web_search", "web_fetch"]);

/** 固定使用内置只读实现。父 Agent 的目录只用于收紧可见范围，插件无法替换这里的实现。 */
export function capabilityScope(task: TaskContract, roleTools: readonly string[], options: {
  workspace: string;
  disabled: Record<string, string>;
  registry?: Pick<ToolRegistry, "toolSpecs">;
}) {
  const { workspace, disabled, registry } = options;
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
  const specs = toolSpecs().filter(({ name }) => roleTools.includes(name) && parentTools.has(name) && !disabled[name] &&
    (task.tools === undefined || task.tools.includes(name)) &&
    !(roots?.length === 0 && FILE_TOOLS.has(name)) &&
    !(hosts && (name === "web_search" || (hosts.length === 0 && WEB_TOOLS.has(name)))));
  const granted = new Set(specs.map(({ name }) => name));

  function readPath(requested?: string) {
    const resolved = resolvePath(workspace, requested, "read");
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
    // 缓存命中也必须使用相同权限范围。授权目录解析使用真实路径，避免别名扩大权限。
    identity: { tools: [...granted].sort(), roots, hosts, workspace },
    find(name: string) { return granted.has(name) && !disabled[name] ? findTool(name) : undefined; },
  };
}

export type CapabilityScope = ReturnType<typeof capabilityScope>;
