import path from "node:path";
import { lstatSync, readFileSync, statSync } from "node:fs";
import type { ToolSpec } from "../../llm/src/types";
import type { ToolRegistry } from "../../tool-runtime/src/types";
import { findTool, toolSpecs } from "../../tool-runtime/src/index";
import { resolvePath } from "../../workspace/src/access";
import { isSensitivePath, sandboxInfo } from "../../sandbox/src/sandbox";
import type { TaskContract } from "./task-contract";
import { SubagentRequestError } from "./task-contract";
import { EXECUTION_TOOLS, WRITE_TOOLS } from "./role-budget";

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

/** 写权限按工作区内的明确文件授权。路径别名或目标链接变化后，原授权不能落到别的文件。 */
function resolveWriteTarget(workspace: string, requested: string) {
  const spelling = requested.replace(/\\/g, "/");
  const parts = spelling.split("/");
  const file = resolvePath(workspace, spelling, "write");
  if (!file.inWorkspace || file.shown === "." || path.posix.normalize(spelling) !== file.shown ||
      parts.some((name) => ["..", ".git", ".runs", ".task-home", ".npmrc", ".pypirc", ".git-credentials"].includes(name.toLowerCase())) ||
      /[*?<>|:\x00-\x1f]/.test(spelling) || isSensitivePath(file.full)) {
    throw new Error("只能写入当前工作区内明确指定的普通文件");
  }
  try {
    if (!lstatSync(file.full).isFile()) throw new Error("写入目标必须是普通文件");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return file;
}

/** 父 Agent 的目录用于收紧可见范围。文件微调也使用内置实现，插件无法替换执行入口。 */
export function capabilityScope(task: TaskContract, roleTools: readonly string[], options: {
  workspace: string;
  disabled: Record<string, string>;
  registry?: Pick<ToolRegistry, "toolSpecs">;
  revisionFile?: ReturnType<typeof resolveRevisionFile>;
  readOnlyFollowup?: boolean;
  priorTools?: string[];
}) {
  const { workspace, disabled, registry, revisionFile, readOnlyFollowup, priorTools } = options;
  const implementation = task.role === "implementation" && !readOnlyFollowup;
  if (!implementation && task.writePaths !== undefined) throw new SubagentRequestError("只有 implementation 可声明 writePaths", 403);
  const targets = new Map<string, string>();
  for (const requested of task.writePaths ?? []) {
    try {
      const file = resolveWriteTarget(workspace, requested);
      targets.set(file.shown, file.full);
    } catch (error) { throw new SubagentRequestError(`写入目标 ${requested} 无效。${(error as Error).message}`, 403); }
  }
  const sandbox = implementation && (task.tools === undefined || task.tools.some((name) => name === "run_python" || name === "run_command"))
    ? sandboxInfo().mode : undefined;
  const canRunPython = !readOnlyFollowup && sandbox === "docker";
  const canRunCommand = !readOnlyFollowup && (sandbox === "docker" || sandbox === "seatbelt");
  const parentTools = new Set((registry?.toolSpecs() ?? toolSpecs()).map(({ name }) => name));
  const readPaths = task.paths ?? (task.role === "implementation" ? task.contextFiles ?? [] : undefined);
  const roots = readPaths?.map((item) => {
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
    : roleTools.includes(name) && (priorTools === undefined || priorTools.includes(name)) &&
    (!readOnlyFollowup || !EXECUTION_TOOLS.has(name)) &&
    (task.tools === undefined || task.tools.includes(name)) &&
    !(roots?.length === 0 && !targets.size && FILE_READ_TOOLS.has(name)) &&
    (!WRITE_TOOLS.has(name) || targets.size > 0) && (name !== "run_python" || canRunPython) &&
    (name !== "run_command" || canRunCommand) &&
    !(hosts && (name === "web_search" || (hosts.length === 0 && WEB_TOOLS.has(name))))))
    .map((spec): ToolSpec => spec.name === "run_python" ? {
      ...spec,
      description: "在无网络的独立 Docker 中做计算或验证。用相对路径读取明确引用的 contextFiles 和本任务已写入的文件。用 print 报告检查结果。持久文件通过获准的文件工具交付。",
      parameters: { ...spec.parameters, properties: { code: spec.parameters.properties?.code ?? { type: "string" },
        purpose: spec.parameters.properties?.purpose ?? { type: "string" } } },
    } : spec.name === "run_command" ? {
      ...spec,
      description: "在独立项目副本中用 bash 运行脚本、构建和测试。副本含 paths、contextFiles 和本任务当前可写的文件，每次从项目根目录开始。"
        + (sandbox === "docker" ? "命令退出码为零时，可用 outputs 提交已获准且实际改变的具体文件。" : "使用 write_file 或 edit_file 保存工作区文件，再运行命令测试。"),
      parameters: { ...spec.parameters, properties: {
        command: spec.parameters.properties?.command ?? { type: "string" }, purpose: spec.parameters.properties?.purpose ?? { type: "string" },
        timeout_ms: spec.parameters.properties?.timeout_ms ?? { type: "number" },
        ...(sandbox === "docker" && { outputs: { type: "array", items: { type: "string" }, description: "需要提交的精确文件路径，必须在 writePaths 内。测试命令可以省略。" } }),
      } },
    } : spec);
  const granted = new Set(specs.map(({ name }) => name));

  function readPath(requested?: string) {
    const resolved = resolvePath(workspace, requested, "read");
    if (revisionFile && resolved.full !== revisionFile.full) throw new Error("只能读取所选微调文件");
    if (implementation && isSensitivePath(resolved.full)) throw new Error("子任务不能读取敏感文件");
    if (roots && !targets.has(resolved.shown) && !roots.some((root) => {
      const relative = path.relative(root, resolved.full);
      return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    })) throw new Error("文件路径超出此子任务的读取范围");
    return resolved;
  }

  function writePath(requested: string) {
    if (revisionFile) {
      if (readPath(requested).full !== revisionFile.full) throw new Error("只能修改所选微调文件");
      const file = resolveRevisionFile(workspace, requested);
      if (file.full !== revisionFile.full) throw new Error("文件路径已改变，请重新打开文件");
      return file;
    }
    const file = resolveWriteTarget(workspace, requested);
    if (targets.get(file.shown) !== file.full) throw new Error("文件不在此子任务的 writePaths 中");
    return file;
  }

  function checkUrl(url: URL) {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        (hosts && !hosts.includes(url.hostname.toLowerCase()))) {
      throw new Error("网页地址超出此子任务的访问范围");
    }
  }

  return {
    specs, readPath, checkUrl, writePath,
    writablePaths: revisionFile ? [revisionFile.shown] : [...targets.keys()],
    pythonInputs: task.contextFiles ?? [],
    commandInputs: [...new Set([...(readPaths ?? []), ...(task.contextFiles ?? [])])],
    revisionPath: revisionFile?.shown,
    // 缓存命中也必须使用相同权限范围。授权目录解析使用真实路径，避免别名扩大权限。
    identity: { tools: [...granted].sort(), roots, hosts, workspace, revisionPath: revisionFile?.shown,
      writePaths: targets.size ? [...targets].sort() : undefined },
    find(name: string) { return granted.has(name) && !disabled[name] ? findTool(name) : undefined; },
  };
}

export type CapabilityScope = ReturnType<typeof capabilityScope>;
