"use client";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { STATUS_LABEL, toolStatus, type Artifact, type StoredMessage, type ToolStatus } from "@/lib/shared";
import type { ToolCall } from "@/lib/llm/types";
import { Markdown } from "./Markdown";
import { PLAN_MARK } from "@/lib/agent/steer";
import { CodeBlock, DiffBlock, diffStat } from "./Code";
import { join } from "./FileDrawer";
import { IChevron } from "./Icons";
import { DotSpinner } from "./DotSpinner";
import { TraceIcon } from "./TraceIcon";
import { useApprovals, useLiveOutput, type OutputChunk } from "@/lib/live";

/* =====================================================================
   一轮 agent 执行的过程（仿 Claude）：一个细边框盒子，里面一行一个动作。

     用户想看完整的工具链路，我按顺序调用每个工具…        ← 思考：灰色句子，可展开看全文
     已获取时间  2026年10月22日 00:43:03                   ›
     已计算      10000*1.05^10 = 16288.95                  ›
   图标 正在运行 Python  import math … ◌                    ← 每步保留类型图标，只有进行中有加载动画
     已写入      demo/result.txt  78 B                     ›   ← 文件名可点，右侧打开

   - 运行中：盒子展开，上方一行显示当前在做什么 + 计时
   - 全部完成：摘要显示本轮做过的操作与耗时，停止加载动画；展开/收起仍由用户控制
   - 每一行默认收起，点击看参数和结果
   ===================================================================== */

/** 每个工具的动词（完成 / 进行中）和“目标”怎么显示。新增工具在这里加一项 */
type Ctx = { a: R; r: R | null; openFile(p: string): void; openArtifact?: () => void };
const TOOLS: Record<string, { done: string; run: string; label: string; target(c: Ctx): ReactNode }> = {
  current_time: { done: "已获取时间", run: "正在获取时间", label: "获取时间", target: ({ a, r }) => (r ? str(r.text) : str(a.timezone) || "本地时区") },
  calculator: {
    done: "已计算", run: "正在计算", label: "计算",
    target: ({ a, r }) => <code>{str(a.expression)}{r ? ` = ${str(r.result)}` : ""}</code>,
  },
  web_fetch: {
    done: "已读取网页", run: "正在读取网页", label: "读取网页",
    target: ({ a, r }) => (
      <a className="tr-link" href={str(a.url)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
        {str(r?.title) || str(a.url)}
      </a>
    ),
  },
  list_files: {
    done: "已查看目录", run: "正在查看目录", label: "查看目录",
    target: ({ a, r, openFile }) => (
      <>
        <FileLink path={str(a.path) || "."} openFile={openFile} />
        {Array.isArray(r?.items) && <span className="tr-dim"> · {r.items.length} 项</span>}
      </>
    ),
  },
  read_file: {
    done: "已读取", run: "正在读取", label: "读取文件",
    target: ({ a, r, openFile }) => (
      <>
        <FileLink path={str(a.path)} openFile={openFile} />
        {r && r.totalLines !== undefined && (
          <span className="tr-dim"> · {r.startLine > 1 || r.nextOffset ? `第 ${str(r.startLine)}–${str(r.endLine)} 行 / 共 ${str(r.totalLines)} 行` : `${str(r.totalLines)} 行`}</span>
        )}
      </>
    ),
  },
  edit_file: {
    done: "已修改", run: "正在修改", label: "修改文件",
    target: ({ a, r, openFile }) => (
      <>
        <FileLink path={str(a.path)} openFile={openFile} />
        {r && <span className="tr-dim"> · {Number(r.replacements) > 1 ? `替换了 ${str(r.replacements)} 处` : `第 ${str(r.line)} 行`}</span>}
        <EditStat a={a} />
      </>
    ),
  },
  glob: {
    done: "已查找文件", run: "正在查找文件", label: "查找文件",
    target: ({ a, r }) => (
      <>
        <code>{str(a.pattern)}</code>
        {r && <span className="tr-dim"> · {str(r.total)} 个</span>}
      </>
    ),
  },
  grep: {
    done: "已搜索", run: "正在搜索", label: "搜索内容",
    target: ({ a, r }) => (
      <>
        <code>{str(a.pattern)}</code>
        {a.glob && <span className="tr-dim"> 在 {str(a.glob)}</span>}
        {r && <span className="tr-dim"> · {str(r.totalMatches)} 处 / {str(r.files)} 个文件</span>}
      </>
    ),
  },
  ask_user: {
    done: "已向你提问", run: "正在提问", label: "提问",
    target: ({ a }) => str(a.question),
  },
  todo_write: {
    done: "已更新计划", run: "正在更新计划", label: "更新计划",
    target: ({ a, r }) => {
      const list = (Array.isArray(a.todos) ? a.todos : []) as { content?: string; status?: string }[];
      const now = list.find((t) => t.status === "in_progress") ?? list.find((t) => t.status !== "completed");
      return (
        <>
          {now ? str(now.content) : list.length ? "全部完成" : ""}
          {r && <span className="tr-dim"> · {str(r.progress)}</span>}
        </>
      );
    },
  },
  research: {
    done: "已调研", run: "子 agent 正在调研", label: "调研",
    target: ({ a }) => clip(str(a.task).replace(/\s+/g, " "), 80),
  },
  web_search: {
    done: "已搜索网页", run: "正在搜索网页", label: "搜索网页",
    target: ({ a, r }) => (
      <>
        {str(a.query)}
        {Array.isArray(r?.results) && <span className="tr-dim"> · {r.results.length} 条结果</span>}
      </>
    ),
  },
  write_file: {
    done: "已写入", run: "正在写入", label: "写入文件",
    target: ({ a, r, openFile }) => (
      <>
        <FileLink path={str(a.path)} openFile={openFile} />
        {r && <span className="tr-dim"> · {fmtBytes(Number(r.bytes))}</span>}
      </>
    ),
  },
  read_document: {
    done: "已读取文档", run: "正在读取文档", label: "读取文档",
    target: ({ a, r, openFile }) => (
      <>
        <FileLink path={str(a.path)} openFile={openFile} />
        {a.pages && <span className="tr-dim"> 第 {str(a.pages)} 页</span>}
        {r && (
          <span className="tr-dim">
            {" · "}
            {r.totalPages !== undefined ? `${str(r.totalPages)} 页` : Array.isArray(r.sheets) ? `${r.sheets.length} 个工作表` : r.slides !== undefined ? `${str(r.slides)} 张幻灯片` : ""}
            {r.totalChars !== undefined ? ` · ${str(r.totalChars)} 字` : ""}
          </span>
        )}
      </>
    ),
  },
  file_op: {
    done: "已整理文件", run: "正在整理文件", label: "整理文件",
    target: ({ a, r, openFile }) => (
      <>
        {{ mkdir: "新建目录 ", move: "移动 ", copy: "复制 ", delete: "删除 " }[str(a.action)] ?? ""}
        <FileLink path={str(a.path)} openFile={openFile} />
        {a.to ? (
          <>
            {" → "}
            <FileLink path={str(a.to)} openFile={openFile} />
          </>
        ) : null}
        {r?.denied ? <span className="tr-dim"> · 已拒绝</span> : null}
      </>
    ),
  },
  write_document: {
    done: "已生成文件", run: "正在生成文件", label: "生成文件",
    target: ({ a, r, openFile }) => (r ? <FileLink path={str(r.path)} openFile={openFile} /> : <code>{str(a.path)}</code>),
  },
  query_data: {
    done: "已查询数据", run: "正在查询数据", label: "查询数据",
    target: ({ a, r }) => (
      <>
        <code>{firstLine(str(a.sql))}</code>
        {r && <span className="tr-dim"> · {str(r.rowCount)} 行</span>}
      </>
    ),
  },
  make_chart: {
    done: "已画图", run: "正在画图", label: "画图",
    target: ({ a, r, openFile }) => (r ? <FileLink path={str(r.path)} openFile={openFile} /> : <code>{str(a.title) || str(a.type)}</code>),
  },
  archive: {
    done: "已处理压缩包", run: "正在处理压缩包", label: "压缩包",
    target: ({ a, r }) => (
      <>
        <code>{str(a.path)}</code>
        {r && r.extracted !== undefined && <span className="tr-dim"> · 解压 {str(r.extracted)} 个文件</span>}
        {r && r.files !== undefined && r.extracted === undefined && !Array.isArray(r.files) && <span className="tr-dim"> · {str(r.files)} 个文件</span>}
      </>
    ),
  },
  http_request: {
    done: "已调用接口", run: "正在调用接口", label: "调用接口",
    target: ({ a, r }) => (
      <>
        <code>{str(a.method) || "GET"} {str(a.url)}</code>
        {r && r.status !== undefined && <span className={Number(r.status) >= 400 ? "tr-err" : "tr-dim"}> · {str(r.status)}</span>}
      </>
    ),
  },
  load_tools: {
    done: "已加载工具", run: "正在加载工具", label: "加载工具",
    target: ({ a }) => <code>{(Array.isArray(a.names) ? a.names : [a.names]).map(str).join("、")}</code>,
  },
  remember: {
    done: "已记住", run: "正在记住", label: "记住",
    target: ({ a }) => <span>{str(a.text)}</span>,
  },
  download_file: {
    done: "已下载", run: "正在下载", label: "下载文件",
    target: ({ a, r, openFile }) =>
      r ? (
        <>
          <FileLink path={str(r.path)} openFile={openFile} />
          <span className="tr-dim"> · {fmtBytes(Number(r.bytes))}</span>
        </>
      ) : (
        <code>{str(a.url)}</code>
      ),
  },
  run_python: {
    done: "已运行 Python", run: "正在运行 Python", label: "运行 Python",
    target: ({ a, r }) => (
      <>
        <code>{firstLine(str(a.code))}</code>
        {r && r.exitCode !== 0 && <span className="tr-err"> · {r.timedOut ? "超时" : `退出码 ${str(r.exitCode)}`}</span>}
      </>
    ),
  },
  run_command: {
    done: "已运行", run: "正在运行", label: "运行命令",
    target: ({ a, r }) => (
      <>
        <code title={str(a.purpose ?? a.description) || undefined}>$ {firstLine(str(a.command))}</code>
        {r && failedCmd(r) && <span className="tr-err"> · {cmdStatus(r)}</span>}
      </>
    ),
  },
  create_artifact: {
    done: "已生成", run: "正在生成", label: "生成产出",
    target: ({ a, openArtifact }) =>
      openArtifact ? (
        <button className="tr-link" onClick={(e) => (e.stopPropagation(), openArtifact())}>
          {str(a.title)}
        </button>
      ) : (
        str(a.title)
      ),
  },
};

export function Trace(props: {
  steps: StoredMessage[]; // 本轮的 assistant + tool 消息，按时间顺序
  live: boolean;
  running: Record<string, number>; // 正在执行的工具 callId → 开始时间
  artifacts: Artifact[];
  onOpenArtifact(id: string): void;
  onOpenFile(path: string): void;
}) {
  const { steps, live, running } = props;

  // 默认收起（运行中也是）：只显示一行标题，用户手动点开才展示每一步
  const [open, setOpen] = useState(false);
  const now = useNow(live);
  /**
   * 每个工具调用行是否展开，由这里统一记住（key = 消息 id:第几个调用）。
   * 写代码时显示的是 DraftRow，写完后换成 ToolRow，是两个不同的组件；
   * 如果展开状态放在行自己里面，换组件时状态会丢，所以提到父组件来管。
   */
  const [rows, setRows] = useState<Record<string, boolean>>({});
  const rowProps = (key: string) => ({ open: !!rows[key], onToggle: () => setRows((m) => ({ ...m, [key]: !m[key] })) });

  const results = useMemo(() => {
    const m = new Map<string, StoredMessage>();
    for (const s of steps) if (s.role === "tool" && s.toolCallId) m.set(s.toolCallId, s);
    return m;
  }, [steps]);

  const assistants = steps.filter((s) => s.role === "assistant");
  const calls = assistants.flatMap((a) => a.toolCalls ?? []);
  const started = steps[0]?.createdAt;
  const lastStep = steps[steps.length - 1];
  const ended = lastStep ? lastStep.createdAt + (lastStep.durationMs ?? 0) : started;
  const elapsed = started ? ((live ? now : ended ?? now) - started) / 1000 : 0;
  // 失败数：真正失败、超时、结果不确定的；用户拒绝、取消、系统跳过不算“出错”（M1-02）
  const failed = calls.filter((c) => {
    const r = results.get(c.id);
    return r && rowState(toolStatus(r)) === "err";
  }).length;

  // 有命令在等用户确认：标题直接说在等什么（确认弹窗在输入框上方，见 ApprovalDock）
  const approvals = useApprovals();
  const waitingCall = calls.find((c) => approvals[c.id] && !results.has(c.id));

  // 本地模型很快时，标题每秒会变几十次而闪烁；运行中最多每 400ms 换一次
  const phase = useThrottled(live ? currentPhase(assistants, calls, results, running) : "", 400);
  const liveHeadline = waitingCall ? `等待你确认：$ ${firstLine(approvals[waitingCall.id].command)}` : phase;
  const fixes = steps.filter((x) => x.feedback?.kind === "retry").length;
  const headline = live ? liveHeadline : summarize(assistants, calls, failed) + (fixes ? `，自动修复 ${fixes} 轮` : "");
  // 收起后也保留类型提示；运行中看当前工具/参数草稿，结束后用最后一次操作的图标。
  const activeCall = calls.find((c) => running[c.id] && !results.has(c.id));
  const draftName = assistants.at(-1)?.drafts?.at(-1)?.name;
  const summaryIcon = live ? activeCall?.name || draftName || "thinking" : calls.at(-1)?.name || "thinking";

  return (
    <div className={`trace ${open ? "open" : ""} ${live ? "live" : ""}`}>
      <button className="trace-sum" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <TraceIcon name={summaryIcon} />
        <span className={`trace-sum-text ${live ? "shimmer" : ""}`}>{headline}</span>
        {live && <DotSpinner size={12} label="运行中" />}
        <span className="trace-sum-time">{elapsed.toFixed(1)}s</span>
        <IChevron className="trace-chev" width={11} height={11} />
      </button>

      <div className="ti-panel outer">
        <div className="ti-inner">
          {/* 收起时不渲染里面的内容：模型输出很快时，省掉大量看不见的重绘 */}
          {open && (
          <div className="trace-box">

            {/* 按时间顺序：模型的每一步，以及 agent 自动发回的检查反馈（运行报错 → 让模型修复） */}
            {steps.filter((x) => x.role === "assistant" || x.feedback).map((a) => {
              if (a.feedback)
                return (
                  <Row
                    key={a.id}
                    iconName={a.feedback.kind}
                    state="done"
                    verb={a.feedback.kind === "note" ? "你补充" : a.feedback.kind === "compact" ? "已压缩上下文" : "自动检查"}
                    target={<span className={a.feedback.kind === "retry" ? "tr-err" : a.feedback.kind === "note" ? "" : "tr-thought"}>{a.feedback.summary}</span>}
                    meta={a.feedback.kind === "compact" && a.durationMs !== undefined ? sec(a.durationMs) : undefined}
                  >
                    {/* 压缩：展开看摘要全文（之后发给模型的就是这段摘要 + 最近两轮原文） */}
                    {a.feedback.kind === "compact" ? (
                      <div className="tr-think">
                        <Markdown text={a.content} />
                      </div>
                    ) : (
                      a.feedback.kind !== "note" && <div className="tr-think">{a.content}</div>
                    )}
                  </Row>
                );
              const i = assistants.indexOf(a);
              const aLive = live && i === assistants.length - 1 && a.durationMs === undefined;
              const thinking = aLive && !a.content && !a.toolCalls && !a.drafts?.length; // 已经开始写工具参数，就不再算“正在思考”
              return (
                <Fragment key={a.id}>
                  {(a.reasoning || thinking) && (
                    <Row
                      state={thinking ? "run" : "done"}
                      verb={thinking ? "正在思考" : undefined}
                      target={<span className="tr-thought">{thoughtLine(a.reasoning ?? "", thinking) || "…"}</span>}
                      meta={a.reasoningMs !== undefined ? sec(a.reasoningMs) : undefined}
                    >
                      {/* 思考只有一句、标题行已经完整显示时，不再展开重复一遍 */}
                      {a.reasoning && !thinking && !fitsHeadline(a.reasoning) && (
                        <div className="tr-think">
                          <Markdown text={restOfThought(a.reasoning)} />
                        </div>
                      )}
                    </Row>
                  )}

                  {/* 中间步骤说的话（包括被自动检查打回的“完成了”）放进过程里；最后一步的文字是最终回答，在外面显示 */}
                  {isPlan(a.content) ? (
                    <div className="tr tr-say tr-plan">
                      <TraceIcon name="plan" />
                      <Markdown text={planMd(a.content)} />
                    </div>
                  ) : (a.toolCalls?.length || a.drafts?.length || i < assistants.length - 1) && a.content.trim() ? (
                    <div className="tr tr-say">
                      <TraceIcon />
                      <Markdown text={a.content} />
                    </div>
                  ) : null}

                  {a.toolCalls?.map((c, j) =>
                    c.name === "run_command" ? (
                      <CommandRow
                        key={c.id}
                        {...rowProps(`${a.id}:${j}`)}
                        call={c}
                        result={results.get(c.id)}
                        startedAt={running[c.id]}
                        live={live}
                        now={now}
                      />
                    ) : (
                    <ToolRow
                      key={c.id}
                      {...rowProps(`${a.id}:${j}`)}
                      call={c}
                      result={results.get(c.id)}
                      startedAt={running[c.id]}
                      live={live}
                      now={now}
                      artifacts={props.artifacts}
                      onOpenArtifact={props.onOpenArtifact}
                      onOpenFile={props.onOpenFile}
                    />
                    ),
                  )}

                  {/* 模型正在生成的工具调用：参数一边生成一边显示（写代码 / 写文件时能看到内容在增长） */}
                  {!a.toolCalls && a.drafts?.map((d, j) => <DraftRow key={j} {...rowProps(`${a.id}:${j}`)} draft={d} onOpenFile={props.onOpenFile} />)}
                </Fragment>
              );
            })}

            {/* 等待模型的空档（刚发出请求，或上一步工具刚执行完）也显示一行“正在思考” */}
            {live && waitingModel(assistants, calls, results, running) && <Row state="run" verb="正在思考" target={<span className="tr-thought">等待模型响应…</span>} />}
          </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- 一次工具调用 ---------------- */

function ToolRow(props: {
  open: boolean;
  onToggle(): void;
  call: ToolCall;
  result?: StoredMessage;
  startedAt?: number;
  live: boolean;
  now: number;
  artifacts: Artifact[];
  onOpenArtifact(id: string): void;
  onOpenFile(path: string): void;
}) {
  const { call, result, startedAt, live, now } = props;
  const t = TOOLS[call.name];
  const a = parse(call.arguments);
  const r = result && !result.isError ? parse(result.content) : null;
  const status = result ? toolStatus(result) : null;
  const state: RowState = status ? rowState(status) : startedAt || live ? "run" : "err";
  const artifact = result?.artifactId ? props.artifacts.find((x) => x.id === result.artifactId) : undefined;

  const verb =
    state === "run" ? t?.run ?? `正在调用 ${call.name}` : status && status !== "ok" ? `${t?.label ?? call.name}${STATUS_LABEL[status]}` : state === "err" ? `${t?.label ?? call.name}失败` : t?.done ?? `已调用 ${call.name}`;
  // 模型写了“这一步的目的”（purpose）就用它当标题，比代码第一行好懂；具体内容在展开后
  const purpose = str(a.purpose);
  const target =
    status && status !== "ok" && result ? (
      // 工具抛错：显示错误第一行；正常返回但失败（run_python 退出码 1）：显示退出码
      <span className={state === "err" ? "tr-err" : "tr-dim"}>{purpose ? `${purpose} · ` : ""}{result.isError ? firstLine(result.content.replace(/^(工具执行失败|未执行（[^）]+）)：/, "")) : r ? cmdStatus(r) : ""}</span>
    ) : purpose ? (
      <span className="tr-purpose">{purpose}</span>
    ) : t ? (
      t.target({ a, r, openFile: props.onOpenFile, openArtifact: artifact ? () => props.onOpenArtifact(artifact.id) : undefined })
    ) : (
      <code>{firstLine(JSON.stringify(a))}</code>
    );
  const meta = state === "run" ? (startedAt ? `${((now - startedAt) / 1000).toFixed(1)}s` : undefined) : result?.durationMs !== undefined ? sec(result.durationMs) : undefined;

  // 先算出展开内容：没有内容（null）时这一行不能点开
  const body = toolBody({ call, a, r, result, onOpenFile: props.onOpenFile });
  return (
    <Row iconName={call.name} state={state} verb={verb} target={target} meta={meta} open={props.open} onToggle={props.onToggle}>
      {body}
    </Row>
  );
}

/**
 * 展开后的内容（仿 Claude）：只放“用户想看的那一块”，不列出参数名和原始 JSON。
 *   代码类：代码框（运行 Python 再加一个输出框）     文件类：文件内容 / 改动对比
 *   网页类：标题链接 + 摘要                           列表类：可点的文件名
 * 标题行已经说清楚的工具（计算、时间、文件操作……）没有展开内容，返回 null，行也就不能点开。
 */
const isPlan = (t: string) => t.trimStart().startsWith(PLAN_MARK);
/**
 * 第一步的规划：「【规划】」后面是“目标：… / 已知：… / 缺什么：… / 路线：…”几行。
 * Markdown 里单个换行会被合成一段，所以转成列表，标签加粗
 */
function planMd(t: string) {
  const lines = t.trimStart().slice(PLAN_MARK.length).split("\n").map((l) => l.trim()).filter(Boolean);
  return "**规划**\n\n" + lines.map((l) => "- " + l.replace(/^[-*]\s*/, "").replace(/^([^：:]{1,6})[：:]/, "**$1**：")).join("\n");
}

function toolBody({ call, a, r, result, onOpenFile }: { call: ToolCall; a: R; r: R | null; result?: StoredMessage; onOpenFile(p: string): void }) {
  if (result?.isError) return <pre className="io-code err">{result.content.replace(/^工具执行失败：/, "")}</pre>;
  switch (call.name) {
    case "edit_file":
      return typeof a.old_string === "string" ? <DiffBlock before={str(a.old_string)} after={str(a.new_string)} lang={str(a.path)} startLine={Number(r?.line) || 1} /> : null;
    case "write_file":
      return a.content ? <CodeBlock className="io-code" code={str(a.content).replace(/\n$/, "")} lang={str(a.path)} /> : null;
    case "create_artifact":
      // 产出物在右侧面板里看（标题行的名字可以点），这里不再重复一遍源码
      return null;
    case "run_python": {
      const out = r ? [str(r.stdout), str(r.stderr)].filter(Boolean).join("\n").replace(/\n$/, "") : "";
      return (
        <>
          <CodeBlock className="io-code" code={str(a.code).replace(/\n$/, "")} lang="python" />
          {r && <pre className={`io-out ${r.exitCode !== 0 ? "err" : ""}`}>{out || "（没有输出）"}</pre>}
          {r?.note ? <div className="io-note">{str(r.note)}</div> : null}
        </>
      );
    }
    case "read_file":
      // 结果里每行前面带着行号（给模型定位用），显示时去掉
      return r?.content ? <CodeBlock className="io-code" code={str(r.content).replace(/^ *\d+\t/gm, "")} lang={str(a.path)} /> : null;
    case "read_document":
      return r?.content ? <pre className="io-out">{clip(str(r.content), 1500)}</pre> : null;
    case "web_fetch":
      return r?.content ? <pre className="io-out">{clip(str(r.content), 800)}</pre> : null;
    case "web_search":
      return Array.isArray(r?.results) && r.results.length ? (
        <ul className="io-results">
          {(r.results as { title: string; url: string; snippet: string }[]).map((x) => (
            <li key={x.url}>
              <a className="tr-link" href={x.url} target="_blank" rel="noreferrer">
                {x.title || x.url}
              </a>
              {x.snippet && <div className="tr-dim">{x.snippet}</div>}
            </li>
          ))}
        </ul>
      ) : null;
    case "glob":
    case "list_files": {
      const items = call.name === "glob" ? (Array.isArray(r?.files) ? (r.files as { path: string }[]).slice(0, 50).map((f) => f.path) : []) : Array.isArray(r?.items) ? (r.items as { name: string }[]).map((it) => join(str(a.path) || ".", it.name)) : [];
      return items.length ? (
        <div className="io-files">
          {items.map((p) => (
            <button key={p} className="tr-link mono" onClick={() => onOpenFile(p)}>
              {call.name === "list_files" ? p.split("/").pop() : p}
            </button>
          ))}
        </div>
      ) : null;
    }
    case "grep":
      return r ? <pre className="io-out">{str(r.output) || (Array.isArray(r.paths) ? (r.paths as string[]).join("\n") : "") || "（没有匹配）"}</pre> : null;
    case "todo_write":
      return Array.isArray(a.todos) ? (
        <ul className="io-todos">
          {(a.todos as { content?: string; status?: string }[]).map((t, i) => (
            <li key={i} className={`todo-${str(t.status)}`}>
              <span className="todo-box">{t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : ""}</span>
              {str(t.content)}
            </li>
          ))}
        </ul>
      ) : null;
    case "research":
      // 结果是子 agent 写的 Markdown（结论、要点、来源），末尾附着它调用过的工具
      return result?.content ? <Markdown text={result.content} /> : null;
    case "calculator":
    case "current_time":
    case "ask_user":
    case "file_op":
    case "download_file":
      return null;
    default:
      // 没有专门显示方式的新工具：仍然给出参数和结果，方便排查
      return (
        <div className="io">
          <IOView json={call.arguments} />
          {result && <IOView json={result.content} />}
        </div>
      );
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/* ---------------- 终端命令（run_command）：终端样式的输出 + 确认卡片 ---------------- */

function CommandRow(props: { open: boolean; onToggle(): void; call: ToolCall; result?: StoredMessage; startedAt?: number; live: boolean; now: number }) {
  const { call, result, startedAt, live, now } = props;
  const a = parse(call.arguments);
  const r = result && !result.isError ? parse(result.content) : null;
  const chunks = useLiveOutput(call.id);
  const approval = useApprovals()[call.id];
  const status = result ? toolStatus(result) : null;
  const state: RowState = status ? rowState(status) : startedAt || live ? "run" : "err";
  const command = str(a.command);

  const verb = approval ? "等待确认" : state === "run" ? "正在运行" : status && status !== "ok" ? `命令${STATUS_LABEL[status]}` : state === "err" ? "运行命令失败" : "已运行";
  // 运行中在行尾显示最新一行输出：不用展开也知道它没卡住（比如安装进度、训练的 epoch）
  const lastLine = state === "run" && chunks ? lastNonEmptyLine(chunks.map((c) => c.t).join("")) : "";
  // 标题：有 purpose（这条命令的目的；旧对话里叫 description）就显示目的，命令本身在展开后的终端框里；只有失败时才写状态
  const purpose = str(a.purpose ?? a.description);
  const target =
    result?.isError ? (
      <span className={state === "err" ? "tr-err" : "tr-dim"}>{firstLine(result.content.replace(/^(工具执行失败|未执行（[^）]+）)：/, ""))}</span>
    ) : (
      <>
        {purpose ? <span className="tr-purpose">{purpose}</span> : <code>$ {firstLine(command)}</code>}
        {r && failedCmd(r) && <span className="tr-err"> · {cmdStatus(r)}</span>}
        {lastLine && <span className="tr-dim term-last"> {lastLine}</span>}
      </>
    );
  const meta = approval ? undefined : state === "run" ? (startedAt ? `${((now - startedAt) / 1000).toFixed(1)}s` : undefined) : result?.durationMs !== undefined ? sec(result.durationMs) : undefined;

  // 结束后以结果里的 output 为准（截断过、刷新页面也一样）；运行中显示实时输出
  const output: OutputChunk[] | string = r ? (r.denied ? "（用户拒绝执行这条命令）" : str(r.output)) : (chunks ?? []);

  return (
    <>
      <Row iconName="run_command" state={approval ? "run" : state} verb={verb} target={target} meta={meta} open={props.open} onToggle={props.onToggle} canToggle>
        <TerminalView command={command} output={output} follow={state === "run"} />
        {r && !r.denied && (failedCmd(r) || r.truncated || r.note) ? (
          <div className="term-foot">
            {[failedCmd(r) ? cmdStatus(r) : "", r.truncated ? "输出太长，中间已省略" : "", r.note ? str(r.note) : ""].filter(Boolean).join(" · ")}
          </div>
        ) : null}
      </Row>
    </>
  );
}

/** 终端框：第一行 $ 命令，下面是输出（stderr 标红）。运行中自动滚到底；用户往上翻就不再跟随 */
function TerminalView({ command, output, follow }: { command: string; output: OutputChunk[] | string; follow: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && follow && stick.current) el.scrollTop = el.scrollHeight;
  });
  const empty = typeof output === "string" ? !output : !output.length;
  return (
    <pre
      ref={ref}
      className="term"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      <span className="term-ps">$ </span>
      {command}
      {"\n"}
      {empty ? (
        <span className="term-dim">{follow ? "等待输出…" : "（没有输出）"}</span>
      ) : typeof output === "string" ? (
        output
      ) : (
        output.map((c, i) => (
          <span key={i} className={c.s === "err" ? "term-err" : undefined}>
            {c.t}
          </span>
        ))
      )}
    </pre>
  );
}

const failedCmd = (r: R) => !!(r.denied || r.timedOut || r.signal || r.exitCode !== 0);

function cmdStatus(r: R) {
  if (r.denied) return "已拒绝";
  if (r.timedOut) return "超时";
  if (r.signal) return `被结束（${str(r.signal)}）`;
  return r.exitCode === 0 ? "成功" : `退出码 ${str(r.exitCode)}`;
}

function lastNonEmptyLine(s: string) {
  const lines = s.split(/\r?\n|\r/);
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i].trim().slice(0, 120);
  return "";
}

/* ---------------- 模型正在生成的工具调用 ---------------- */

/** “已修改 demo/fib.py · 第 1 行 · +6 -4”：这一次修改加了几行、删了几行 */
function EditStat({ a }: { a: Record<string, unknown> }) {
  if (typeof a.old_string !== "string" || typeof a.new_string !== "string") return null;
  const s = diffStat(a.old_string, a.new_string);
  return (
    <span className="tab-stat">
      <b className="add">+{s.add}</b>
      <b className="del">-{s.del}</b>
    </span>
  );
}

/** 这个工具的代码是什么语言：写文件看扩展名，run_python 是 Python，run_command 是 Bash */
function codeLang(name: string, a: Record<string, unknown>) {
  if (name === "run_python") return "python";
  if (name === "run_command") return "bash";
  if (name === "create_artifact") return str(a.language) || (a.kind === "html" ? "html" : a.kind === "markdown" ? "markdown" : "");
  return str(a.path); // write_file / edit_file / read_file：按文件扩展名
}

/** 参数里某个字段的语言：stdout / stderr / 报错是纯文本，其余的跟着工具的语言走 */
function fieldLang(key: string, lang?: string) {
  if (/^(stdout|stderr|output|error|traceback|message)$/i.test(key)) return "plaintext";
  if (key === "content" || key === "code" || key === "command" || key === "preview" || key.endsWith("_string")) return lang;
  return "plaintext";
}

/** 这些工具的参数里有一大段正文，生成时实时显示出来 */
const LIVE_FIELD: Record<string, string> = { write_file: "content", edit_file: "new_string", create_artifact: "content", run_python: "code", run_command: "command" };

function DraftRow({ draft, onOpenFile, open, onToggle }: { draft: { name: string; arguments: string }; onOpenFile(p: string): void; open: boolean; onToggle(): void }) {
  const t = TOOLS[draft.name];
  const a = parsePartial(draft.arguments);
  const field = LIVE_FIELD[draft.name];
  const body = field ? str(a[field]) : "";
  const verb = t?.run ?? (draft.name ? `正在调用 ${draft.name}` : "正在准备工具");
  const target = t ? t.target({ a, r: null, openFile: onOpenFile }) : null;
  const meta = body ? `${body.split("\n").length} 行` : undefined;
  return (
    // 代码默认收起，只显示“正在运行 Python · 12 行”；写的过程中随时可以点开、再点收起
    <Row iconName={draft.name} state="run" verb={verb} target={target} meta={meta} open={open} onToggle={onToggle} canToggle>
      {body ? <CodeBlock className="io-code" code={body} lang={codeLang(draft.name, a)} /> : <span className="tr-thought">等待参数…</span>}
    </Row>
  );
}

/* ---------------- 一行：[◌] 动词  目标 …  耗时  › ---------------- */

/** run 进行中 · done 成功 · err 失败（红色）· skip 没有执行（拒绝、取消、跳过：灰色，不算出错） */
export type RowState = "run" | "done" | "err" | "skip";

/** 工具状态 → 行的样式。结果不确定（unknown）按失败显示：可能改了东西，要用户注意 */
export function rowState(s: ToolStatus): RowState {
  return s === "ok" ? "done" : s === "denied" || s === "cancelled" || s === "skipped" ? "skip" : "err";
}

function Row(props: {
  state: RowState;
  /** 操作类型与执行状态分开：失败、跳过和完成后也保留原操作图标。 */
  iconName?: string;
  verb?: string;
  target: ReactNode;
  meta?: string;
  children?: ReactNode;
  /** 传了 open/onToggle 就由父组件控制展开状态，否则行自己记 */
  open?: boolean;
  onToggle?(): void;
  /** 内容还没出来时也允许点开（写代码的行一开始参数是空的） */
  canToggle?: boolean;
}) {
  // 每一行也默认收起，点击才展开参数和结果
  const [own, setOwn] = useState(false);
  const open = props.open ?? own;
  const can = !!props.children || !!props.canToggle;
  const toggle = () => can && (props.onToggle ? props.onToggle() : setOwn((v) => !v));
  return (
    <div className={`tr s-${props.state} ${open ? "open" : ""} ${can ? "can" : ""}`}>
      <div
        className="tr-row"
        role={can ? "button" : undefined}
        tabIndex={can ? 0 : undefined}
        aria-expanded={can ? open : undefined}
        onClick={toggle}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}
      >
        <TraceIcon name={props.iconName} />
        {props.verb && <span className="tr-verb">{props.verb}</span>}
        <span className="tr-target">{props.target}</span>
        {/* 类型图标始终在行首，状态动画放在内容后；结束时只移除动画，不让行首变成空白。 */}
        {props.state === "run" && <DotSpinner size={12} />}
        {props.meta && <span className="tr-meta">{props.meta}</span>}
        {can && <IChevron className="tr-chev" width={11} height={11} />}
      </div>
      {can && (
        <div className="ti-panel">
          <div className="ti-inner">
            {open && <div className="tr-body">{props.children}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function FileLink({ path, openFile }: { path: string; openFile(p: string): void }) {
  return (
    <button className="tr-link mono" onClick={(e) => (e.stopPropagation(), openFile(path))} title="在右侧打开">
      {path === "." ? "工作区" : path}
    </button>
  );
}

/* ---------------- 标题行文字 ---------------- */

/** 完成后的一行摘要：说清楚“这一轮做了什么” */
function summarize(assistants: StoredMessage[], calls: ToolCall[], failed: number) {
  if (!calls.length) {
    const ms = assistants.reduce((n, a) => n + (a.reasoningMs ?? 0), 0);
    return ms ? `思考了 ${sec(ms)}` : "直接回答";
  }
  const labels = [...new Set(calls.map((c) => TOOLS[c.name]?.label ?? c.name))];
  const shown = labels.slice(0, 4).join("、") + (labels.length > 4 ? ` 等 ${labels.length} 类` : "");
  return `${shown}，共 ${calls.length} 次操作${failed ? `，${failed} 次失败` : ""}`;
}

/**
 * 运行中的标题行：显示“此刻真正在发生什么”
 *   工具在执行 / 模型在写工具参数 → “正在写入 index.html”
 *   模型在思考                   → 思考内容的最新一句（模型返回的原文）
 *   其余（等待模型、输出回答）   → 本轮最近一句思考；没有思考内容时才用“正在思考 / 正在回答”
 */
function currentPhase(assistants: StoredMessage[], calls: ToolCall[], results: Map<string, StoredMessage>, running: Record<string, number>) {
  // 标题行本身是按钮，里面不能再放链接按钮，所以目标用纯文字
  const toolPhrase = (name: string, args: string) => {
    const a = parsePartial(args);
    const target = str(a.path ?? a.title ?? a.expression ?? a.url ?? a.query ?? a.pattern ?? (a.command ? `$ ${firstLine(str(a.command))}` : a.code ? firstLine(str(a.code)) : ""));
    return `${TOOLS[name]?.run ?? `正在调用 ${name}`}${target ? ` ${target}` : ""}`;
  };
  const runningCall = calls.find((c) => running[c.id] && !results.has(c.id));
  if (runningCall) return toolPhrase(runningCall.name, runningCall.arguments);

  const a = assistants[assistants.length - 1];
  const modelLive = a && a.durationMs === undefined;
  const draft = modelLive ? a.drafts?.filter(Boolean).at(-1) : undefined;
  if (draft?.name) return toolPhrase(draft.name, draft.arguments);
  if (modelLive && a.reasoning && !a.content) return thoughtLine(a.reasoning, true);

  const lastThought = [...assistants].reverse().find((x) => x.reasoning?.trim())?.reasoning;
  if (lastThought) return thoughtLine(lastThought, true);
  return modelLive && a.content ? "正在回答" : "正在思考";
}

/** 是否处于“等模型”的空档：还没有任何输出，或最后一步的工具都已执行完、新的模型输出还没到 */
function waitingModel(assistants: StoredMessage[], calls: ToolCall[], results: Map<string, StoredMessage>, running: Record<string, number>) {
  const a = assistants[assistants.length - 1];
  if (!a) return true;
  if (a.durationMs === undefined) return false; // 模型正在输出，由它自己那一行显示
  if (!a.toolCalls?.length) return false; // 已经是最终回答
  return a.toolCalls.every((c) => results.has(c.id)) && !calls.some((c) => running[c.id] && !results.has(c.id));
}

/** 思考行显示一句：运行中显示最新一句，完成后显示第一句 */
/** 展开后的思考：标题行已经显示了第一行，这里从第二行开始，避免同一句话出现两次 */
function restOfThought(s: string) {
  const first = thoughtLine(s, false);
  const i = s.indexOf(first);
  return i >= 0 && first.length <= 60 ? s.slice(i + first.length).replace(/^\s+/, "") : s;
}

/** 思考内容只有一行而且不长：标题行就能完整显示 */
function fitsHeadline(s: string) {
  const lines = s.split("\n").filter((l) => l.trim());
  return lines.length <= 1 && (lines[0]?.trim().length ?? 0) <= 60;
}

function thoughtLine(s: string, live: boolean) {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return (live ? lines[lines.length - 1] : lines[0]) ?? "";
}

/** 给右侧任务面板用的纯文字描述：动词 + 目标（面板里不需要可点的链接） */
export function describeStep(name: string, args: string, state: RowState) {
  const t = TOOLS[name];
  const a = parsePartial(args);
  const target = str(a.path ?? a.title ?? a.expression ?? a.url ?? a.query ?? a.pattern ?? (a.command ? `$ ${firstLine(str(a.command))}` : a.code ? firstLine(str(a.code)) : ""));
  const verb = !t ? name : state === "run" ? t.run : state === "err" ? `${t.label}失败` : state === "skip" ? `${t.label}（未执行）` : t.label;
  return { verb, target };
}

/* ---------------- 工具函数 ---------------- */

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const sec = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

function parse(s: string): R {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : { value: v };
  } catch {
    return {};
  }
}

/**
 * 解析“还没生成完”的 JSON 参数，例如 {"path": "index.html", "content": "<html>\n<bo
 * 完整的直接 JSON.parse；不完整时用正则取出每个字符串字段（最后一个字段可以没有结尾引号）。
 */
function parsePartial(s: string): R {
  const whole = parse(s);
  if (Object.keys(whole).length) return whole;
  const out: R = {};
  const re = /"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)("?)/g;
  for (let m; (m = re.exec(s)); ) {
    // 末尾可能停在半个转义符上（如 \ 或 \u12），先去掉再解码
    const raw = m[3] ? m[2] : m[2].replace(/\\(u[0-9a-fA-F]{0,3})?$/, "");
    try {
      out[m[1]] = JSON.parse(`"${raw}"`);
    } catch {
      out[m[1]] = raw;
    }
  }
  return out;
}

/**
 * 参数 / 结果的显示：短字段一行一个 key  value；多行字符串（代码、文件内容、stdout）单独放进代码框，
 * 保留原样缩进，不自动折行（横向滚动），看起来和编辑器里一致。
 */
function IOView({ json, error, lang }: { json: string; error?: boolean; lang?: string }) {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return <pre className={`io-code ${error ? "err" : ""}`}>{json}</pre>;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return <CodeBlock className="io-code" code={JSON.stringify(v, null, 2)} lang="json" />;
  const entries = Object.entries(v);
  if (!entries.length) return <div className="io-kv io-dim">（无参数）</div>;
  return (
    <div className="io-view">
      {entries.map(([k, x]) =>
        typeof x === "string" && (x.includes("\n") || x.length > 120) ? (
          <div key={k} className="io-field">
            <div className="io-k">{k}</div>
            <CodeBlock className="io-code" code={x.replace(/\n$/, "")} lang={fieldLang(k, lang)} />
          </div>
        ) : (
          <div key={k} className="io-kv">
            <span className="io-k">{k}</span>
            <span className="io-v">{typeof x === "string" ? x : JSON.stringify(x)}</span>
          </div>
        ),
      )}
    </div>
  );
}


/** 节流：value 变化时最多每 ms 毫秒更新一次显示（最后一次变化一定会显示出来） */
function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      setShown(value);
      return;
    }
    const t = setTimeout(() => {
      last.current = Date.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(t);
  }, [value, ms]);
  return shown;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [active]);
  return now;
}
