import "server-only";
import type { ToolSpec } from "../../llm/types";
import type { Tool } from "./types";
import { calculator } from "./calculator";
import { createArtifact } from "./create-artifact";
import { currentTime } from "./current-time";
import { editFile, listFiles, readFile, writeFile } from "./files";
import { runCommand } from "./run-command";
import { runPython } from "./run-python";
import { glob, grep } from "./search";
import { todoWrite } from "./todo";
import { webFetch } from "./web-fetch";
import { webSearch } from "./web-search";
import { askUser } from "./ask-user";
import { loadSkill } from "./load-skill";
import { readDocument } from "./documents";
import { downloadFile, fileOp } from "./file-ops";
import { writeDocument } from "./write-document";
import { queryData } from "./query-data";
import { makeChart } from "./make-chart";
import { archive } from "./archive";
import { httpRequest } from "./http-request";
import { remember } from "./remember";
import { makeLoadTools } from "./load-tools";
import { prepare } from "./validate";
import type { StoredMessage } from "../../shared";

export type { Tool, ToolContext, ToolResult } from "./types";

/**
 * 工具注册表。
 * 新增工具 = 在本目录新建一个文件导出 Tool 对象，再加进这个数组。模型会自动“看到”它。
 * 不常用的工具再加进下面的 DEFERRED（写一句用途）：平时只在目录里露个名字，模型用 load_tools 加载后才发完整说明书。
 * 每个工具都会经过 prepare()（validate.ts）：自动加上必填的 purpose 参数、执行前检查参数、把系统错误翻译成下一步怎么办。
 *
 * 分工（描述里也写了“什么时候不要用它”，功能相近的工具靠这个分开）：
 *   找文件   list_files 看一层目录 · glob 按文件名递归找 · grep 按内容找
 *   读文件   read_file 文本/代码 · read_document PDF/Word/Excel/PPT · run_python 图片等其他二进制
 *   改文件   edit_file 改一部分 · write_file 新建或整体重写 · file_op 建目录/移动/复制/删除 · archive 解压/打包 zip
 *   数据     query_data 用 SQL 汇总、筛选表格 · make_chart 把算好的数画成图 · run_python 复杂清洗、统计、画复杂的图
 *   计算     calculator 单个算式 · run_python 多步计算 · run_command 命令行程序（git、测试）
 *   联网     web_search 找网址 · web_fetch 读网页 · download_file 下载文件 · http_request 调 API（JSON、POST）
 *   交付     create_artifact 给用户看的成品 · write_file 文本文件 · write_document Word/Excel/PPT 文件
 *   记忆     remember 用户明确要求记住的偏好
 *   经验     load_skill 读取以往任务里总结出的技能（步骤、坑），见 learn.ts
 * 为什么不合并：calculator、file_op、read_document、query_data、make_chart、archive、write_document 都不依赖 Docker 沙箱，沙箱不可用时它们照样能用；
 * 合进 run_python / run_command 的话，沙箱一坏这些能力就全没了。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RAW: Tool<any>[] = [
  // 计划
  todoWrite,
  // 文件：找 → 读 → 改 → 整理
  listFiles, glob, grep, readFile, readDocument, editFile, writeFile, fileOp, archive,
  // 数据：查询 → 画图
  queryData, makeChart,
  // 执行
  runCommand, runPython, calculator, currentTime,
  // 联网
  webSearch, webFetch, downloadFile, httpRequest,
  // 交付
  createArtifact, writeDocument,
  // 和用户互动：不清楚就问；要求记住的事记下来
  askUser, remember,
  // 经验：按需读取学会的技能
  loadSkill,
];

/**
 * 按需加载（load-tools.ts）：下面这些工具平时不把完整说明书发给模型，系统提示词里只有一行目录（名字 + 这一句用途）。
 * 模型判断任务用得上 → 调用 load_tools 加载 → 下一步起才把它们的说明书放进 tools。
 * 选哪些放这里：用得少、说明书长、且不加载也不会影响常规任务的。
 * 读写文件、终端、搜索、提问这些几乎每个任务都用，放在常用里，免得每次都多走一步加载。
 */
const DEFERRED: Record<string, string> = {
  write_document: "生成 Word / Excel / PPT 文件（docx、xlsx、pptx）",
  query_data: "用 SQL 查询 CSV / Excel 表格：汇总、筛选、排序、关联",
  make_chart: "把算好的数据画成柱状图、折线图、饼图（SVG）",
  archive: "解压或打包 zip",
  file_op: "建目录、移动、复制、重命名、删除文件",
  download_file: "从网址下载文件（PDF、表格、图片）到工作区",
  http_request: "调用 API：带请求头、POST、要 JSON",
  calculator: "精确计算单个算式（百分比、单位换算、日期差）",
  current_time: "精确到分钟的当前时间、其他时区的时间",
  remember: "用户明确要求记住的偏好，以后的对话都会用到",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOLS: Tool<any>[] = [...RAW, makeLoadTools(() => TOOLS.filter((t) => t.spec.name in DEFERRED))].map(prepare);

/** 所有工具的说明书（设置页列表、子 agent 用）。主循环用 toolsFor，只发需要的那些 */
export const toolSpecs = (): ToolSpec[] => TOOLS.map((t) => t.spec);
/** 按名字找工具：没加载的按需工具也能找到，模型直接调用也照样执行（相当于自动加载） */
export const findTool = (name: string) => TOOLS.find((t) => t.spec.name === name);
export const isDeferred = (name: string) => name in DEFERRED;

/**
 * 从对话历史里找出已经加载过的按需工具：
 *   - 调用过 load_tools，参数里写了的
 *   - 没加载就直接调用过的（模型从目录里知道名字，直接调也照样执行）
 * 不单独存状态：历史就是状态，刷新页面、下一轮对话、服务重启都一样。加载过的一直保留到会话结束，
 * 这样 tools 列表只在加载那一步变一次，之后每一步都和上一步相同，模型服务的前缀缓存才能命中。
 */
export function loadedTools(history: Pick<StoredMessage, "toolCalls">[]): Set<string> {
  const loaded = new Set<string>();
  for (const m of history) {
    for (const c of m.toolCalls ?? []) {
      if (isDeferred(c.name)) loaded.add(c.name);
      if (c.name !== "load_tools") continue;
      try {
        const names = JSON.parse(c.arguments || "{}").names;
        for (const n of Array.isArray(names) ? names : [names]) if (isDeferred(String(n))) loaded.add(String(n));
      } catch {
        /* 参数坏了：这次加载没成功，模型会看到报错再调一次 */
      }
    }
  }
  return loaded;
}

/**
 * 这一步发给模型的工具：常用工具 + 已加载的按需工具，去掉这次不可用的。
 * 顺序固定按注册表（RAW）排，同样的集合永远是同样的顺序，请求前缀才稳定。
 */
export function toolsFor(history: Pick<StoredMessage, "toolCalls">[], disabled: Record<string, string> = {}): ToolSpec[] {
  const loaded = loadedTools(history);
  return TOOLS.filter((t) => !disabled[t.spec.name] && (!isDeferred(t.spec.name) || loaded.has(t.spec.name))).map((t) => t.spec);
}

/** 接在系统提示词后面的目录：按需工具只有名字和一句用途。全部不可用时不写 */
export function deferredCatalog(disabled: Record<string, string> = {}): string {
  const list = Object.entries(DEFERRED).filter(([n]) => !disabled[n]);
  if (!list.length) return "";
  return (
    "## 按需加载的工具\n" +
    "下面的工具现在只列了名字和用途，看不到参数。任务用得上时，先调用 load_tools 加载（例：load_tools({names:[\"write_document\"]})，用得上几个就一次加载几个），下一步起就能正常调用。加载过的整个会话都能用，不用再加载。\n" +
    list.map(([n, brief]) => `- ${n}：${brief}`).join("\n")
  );
}
