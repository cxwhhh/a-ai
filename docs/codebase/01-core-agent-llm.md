# A.ai agent 核心层摘要（src/lib/agent + src/lib/llm）

## 1. 概览

- **范围**：`src/lib/agent/**` 18 个文件 / 2050 行，`src/lib/llm/**` 5 个文件 / 814 行 → 共 **23 个文件、2864 行**，全部用 read 完整读完（均为单页 ≤460 行，无需分页）。
- **职责**：把一条用户消息编译成一轮「ReAct 循环」——组装系统提示词 → 调模型流式产出 → 解析/执行工具 → 结果写回历史 → 反复直到交付或触顶；同时负责 LLM 接入（provider 抽象、SSE 解析、usage 统计）与工具集（文件、搜索、终端、Python、联网、产出、提问）。
- **分层图（文字版）**：

```
浏览器 ──POST /api/chat──► app/api/chat/route.ts（转 SSE）
   ├ getProvider(settings)            ← llm/index.ts
   ├ runAgent({provider, session, …}) ← agent/run.ts
   ▼
run.ts 主循环（budget 初始 = settings.maxSteps，默认 25）
   ├─ provider.stream({messages, tools}) ──► llm/types.ts 契约
   │      ├ mock.ts（离线剧本）
   │      └ openai-compatible.ts（SSE）
   ├─ tools/index.ts 注册表（15 个） ──► agent/tools/*.ts
   │      └ 副作用/事件：ToolContext(ctx) → emit / onOutput / confirm / emitArtifact
   ├─ verifier.check()（verify.ts）──► 反馈消息回到 messages
   └─ store.addMessage / addArtifact（store.ts）──► SQLite（session.messages 是唯一事实源）
```

- 关键约定：**历史即状态**。工具清单、todo、verifier 判据都从 `Session.messages` 与本次运行内存在推出来，除了 sqlite 没有额外状态机。

## 2. 逐文件

### `src/lib/agent/run.ts`（302）
- 作用：ReAct 主循环内核，把模型流、工具执行、反馈闭环、notes 注入、审批串成一个 `AsyncGenerator<AgentEvent>`。
- 导出：`runAgent(opts: {provider; session; workspace; userId; commandApproval?; signal?; systemPrompt?; maxSteps?; maxFixRounds?; memory?; notes?}): AsyncGenerator<AgentEvent>`。
- 关键逻辑：
  - `run.ts:15-18` 常量 `DEFAULT_MAX_STEPS=25`、`DEFAULT_MAX_FIX_ROUNDS=3`、`STEPS_PER_FIX=2`。
  - `run.ts:65-70` 系统提示 = 设置里的 systemPrompt（trim 后非空）或 `SYSTEM_PROMPT`，再追加 `memory`；`budget = maxSteps`。
  - `run.ts:77-92` 工具侧的实时事件先进 `live[]` 队列，由 `emit/wake` 唤醒第 4 步的 `Promise.race`；`confirm()` 的放行条件是 `mode==="auto" || (mode==="readonly" && req.readonly) || isSessionAllowed(session.id)`。
  - `run.ts:114` 调模型：`tools: lastStep ? undefined : toolSpecs()`；`115-131` 把 `reasoning/text/tool_call_delta/tool_call/done` 分别映射成事件与 `assistant.reasoning`、`.content`、`.toolCalls`、`.usage`。
  - `run.ts:147-149` 先落库 assistant 再推 `assistant_end`；最后一步即使模型仍发工具调用也丢掉（没有结果的调用会让下次请求报 400）。
  - `run.ts:154-167` 无工具调用 → `verifier.check()`；返回 null 则交付，否则发反馈并把 `budget` 增加 `STEPS_PER_FIX`（上限 `maxSteps + 2*maxRounds`）。
  - `run.ts:172-193` 按 `toBatches()` 分组执行；`181-186` 用 `Promise.race([...running, tick])` 做到「谁先完成先推谁」且工具运行中也能推实时输出。
  - `run.ts:196` 调用链里出现 `endsTurn` 工具（ask_user）→ 本轮直接结束。
- 依赖：`server/store`、`server/approvals`、`server/notes`、`verify`、`tools/index`、`args`、`prompt`；被 `app/api/chat/route.ts:48` 唯一引用。
- 风险：`toModelMessages`（234-239）每步重发全量历史，无截断/摘要；`notes` 分支（159）抬预算时没有 165 行的上限钳制（见问题 4/5）。

### `src/lib/agent/verify.ts`（158）
- 作用：交付前的「裁判」——运行失败或写了 Python 却没跑过，就生成一条反馈把模型打回。
- 导出：`FEEDBACK_TAG`（`"【A.ai 自动检查】"`，5 行）、`class Verifier{ observe(call,result); check(): {content, feedback} | null; rounds; maxRounds }`、`limitFeedback(maxSteps)`。
- 关键逻辑：
  - `verify.ts:44-86` `observe()` 按工具名分派：`run_python`（46-65，`ok = exitCode===0 && !timedOut`）、`run_command` 且命令匹配 `RUNS_CODE`（66-77）、`write_file` 的 `.py`（78-79）、`edit_file` 的 `.py`（80-82，内容记空串，只能靠"运行了这个文件名"算验证）、`create_artifact` 且 `kind==="code"` 且语言是 py（83-84）。
  - `verify.ts:88-91` `track()` 先查 `passed`（运行成功过的代码），同一份代码先跑后存不重复计数。
  - `verify.ts:96-132` `check()`：`rounds >= maxRounds` 直接放行（97）；`lastChance` 时追加「最后一次机会」footer（99-102）；运行失败 → `retry`（104-116）；有未验证代码且没提醒过 → `unverified`（118-130，`nudged` 只触发一次）。
  - `verify.ts:155` `RUNS_CODE = /\b(python3?|pytest)\b(?!\s+(-V|--version)\b)(?!\s+-m\s+(pip|venv)\b)/`——只把「跑代码/测试」的命令算作验证。
- 依赖：`llm/types`、`shared`；被 `run.ts:10`、`mock.ts:3` 引用。
- 风险：`63`/`77` 的验证匹配是文件名子串（`code.includes(baseName(key))`），`a.py` 会被 `data.py` 命中；`57` 在结果非 JSON 时文案会变成「退出码 undefined」。

### `src/lib/agent/reflect.ts`（114）
- 作用：一轮结束后「后台」更新长期记忆（profile/habits/lessons），失败只打日志。
- 导出：`REFLECT_TAG`（`"[A.ai:reflect]"`，7 行）、`reflect({provider,userId,session,turnStart,signal?})`、`shouldReflect(session, turn, memory): boolean`。
- 关键逻辑：
  - `reflect.ts:9-19` 反思提示词规定输出纯 JSON `{profile, habits[], lessons[{mistake,lesson,count}]}`，并明确「不要记录密码/API Key」。
  - `reflect.ts:34-35` 只处理 `session.messages.slice(turnStart)`；`shouldReflect` 不通过就返回 null。
  - `reflect.ts:58-64` 反思时机：`hadError`（有 feedback / isError / tool 结果里失败的 run）`|| CORRECTION.test(userText)`（22 行的纠正词表）`|| memory 为空 || userTurns % 3 === 0`。
  - `reflect.ts:38-47` 独立一次 `provider.stream`，`temperature: 0`，只取 `text` 增量。
  - `reflect.ts:49-55` `parseJson` 失败直接抛错；成功则 `normalizeMemory`，并按 lesson 文本沿用旧 `updatedAt`。
  - `reflect.ts:81-99` `transcript()` 会带「上一轮 A.ai 的回答」（84-85），工具失败结果多留内容（93），总长 >9000 时保留头 3000 + 尾 6000。
- 依赖：`server/memory`、`shared`、`llm/types`；被 `app/api/chat/route.ts:66` 引用（不 await）。
- 风险：`userTurns % 3 === 0` 里 userTurns 是全会话计数，含本轮；Mock 模式下 reflect 走 `mockReflect` 剧本（mock.ts:28-34）。

### `src/lib/agent/prompt.ts`（22）
- 作用：内置系统提示词，定义 A.ai 的性格与工作方式（唯一导出 `SYSTEM_PROMPT`，5-22 行）。
- 关键逻辑：`10` 行要求「互不依赖的工具同一轮发出，系统会并行执行」；`12` 行要求「写代码必须先 run_python 验证，报错看最后一行和行号」；`13` 行说明「【A.ai 自动检查】不是用户说的话」；`19` 行要求 ask_user 单独调用；`20` 行说明「【用户补充】优先级最高」。
- 依赖：只被 `run.ts:7` 引用；被 `settings.systemPrompt` 覆盖。
- 风险：文中点名 `run_python/run_command/todo_write/glob/grep/read_file/edit_file/write_file/web_search/web_fetch/create_artifact/ask_user`，改工具名时这里没有编译期约束。

### `src/lib/agent/args.ts`（76）
- 作用：宽容解析模型给的工具参数 JSON。
- 导出：`parseToolArgs(raw): {ok:true,args} | {ok:false,error}`、`normalizeArgs(raw): string`。
- 关键逻辑：`args.ts:15` 空串/`"null"`/`"{}"` 直接当 `{}`；`17-18` 先试直连解析；`21-27` 再依次试「去 ```json 围栏」「括号配平取第一个对象」「修末尾多逗号」；`49-64` `firstObject` 扫描时跳过字符串内的括号与转义；`29-35` 修不了时把原文（截断 300 字）写进错误让模型自查；`71-76` `normalizeArgs` 只在原文已是合法对象时原样保留，否则 `JSON.stringify` 规整后写入历史。
- 依赖：只被 `run.ts:12,128,275` 使用。
- 风险：修不了的类型错误（如数组）会被 `tryObject` 返回 null 而落到报错分支，行为正确但错误文案统一为「不是合法 JSON」。

### `src/lib/agent/tools/index.ts`（39）
- 作用：工具注册表与查找门面。
- 导出：`toolSpecs(): ToolSpec[]`（38）、`findTool(name)`（39）、以及 `export type {Tool, ToolContext, ToolResult}`（16）。
- 关键逻辑：`index.ts:23-36` `TOOLS` 数组按「计划 / 文件（找→读→改）/ 执行 / 联网 / 交付 / 互动」分组共 15 个工具；新增工具 = 新文件 + 加进数组（注释 18-21）。
- 依赖：15 个工具模块 + `llm/types`；被 `run.ts`、`app/api/info/route.ts:22` 引用。
- 风险：`findTool` 是线性查找，且未知名字返回 `undefined`（`run.ts:250` 里用 `?? false` 兜底，未知工具被当作非并行安全）。

### `src/lib/agent/tools/types.ts`（58）
- 作用：工具契约（spec + run + 两个语义开关）。
- 导出：`ToolContext`、`ApprovalRequest`、`ToolResult`、`Tool<A>`。
- 关键逻辑：`types.ts:5-23` `ToolContext{sessionId; userId?; workspace; emitArtifact; signal?; onOutput?; confirm?}`；`26-33` `ApprovalRequest{command; reason; readonly}`；`36-39` `ToolResult{content; artifactId?}`；`45-58` `Tool<A>{spec; parallelSafe?; endsTurn?; run(args, ctx)}`，其中 `48-51` 明确「有副作用的工具不要设 parallelSafe」。
- 依赖：`llm/types.ToolSpec`、`shared.Artifact`；被所有工具与 `run.ts` 引用。
- 风险：`userId` 可选，`run-command.ts:67`/`run-python.ts:61` 用 `?? ""` 兜底，脱离循环调用时审计日志会缺用户。

### `src/lib/agent/tools/current-time.ts`（28）
- 作用：返回当前时间（时区可指定）。
- 导出：`currentTime: Tool<{timezone?: string}>`。
- 关键逻辑：`current-time.ts:5` `parallelSafe: true`；`19-20` 未给时区就用 `Intl.DateTimeFormat().resolvedOptions().timeZone`；`21-26` 用 `zh-CN` + `dateStyle:"full"`/`timeStyle:"long"` 格式化，返回 `{timezone, iso, text}`。
- 依赖：无。风险：非法时区名会让 `Intl` 抛 `RangeError`，被 `execTool` 转成 isError 文本回给模型（可接受）。

### `src/lib/agent/tools/calculator.ts`（99）
- 作用：精确算术，杜绝 `eval`，手写递归下降解析器。
- 导出：`calculator: Tool<{expression: string}>`、`evaluate(src): number`。
- 关键逻辑：`calculator.ts:9` `parallelSafe: true`；`42` 预处理（去空格、`×÷`→`*/`、`**`→`^`）；`47-68` 文法 `expr → term → power → unary → primary`（`^` 右结合，68 行处理一元正负）；`34-38` 白名单函数 `sqrt/abs/round/floor/ceil/log(10底)/ln/sin/cos/tan` 与常量 `pi/e`；`29` 非有限数抛错；`30` 结果用 `+value.toPrecision(15)` 去浮噪。
- 依赖：无；`evaluate` 目前只在本文件内被 `run` 使用。
- 风险：`round()` 只接受一个参数（多参数表达式会报「多余字符」），spec（21 行示例 `round(3.14159*100)/100`）已规避。

### `src/lib/agent/tools/search.ts`（233）
- 作用：`glob` 按文件名找、`grep` 按内容找，纯 Node 实现（不依赖 rg/find）。
- 导出：`glob: Tool<{pattern; path?}>`、`grep: Tool<{pattern; path?; glob?; ignore_case?; output_mode?; context?; max_results?}>`、`globToRegExp(glob): RegExp`。
- 关键逻辑：
  - `search.ts:18-22` `SKIP_DIRS={node_modules,__pycache__,venv,site-packages}`、`MAX_FILES=20000`、`MAX_GREP_SIZE=2MB`。
  - `search.ts:32-50` `walk()` 深度优先生成器，跳过隐藏项（41），预算耗尽即返回（40,45），读不到目录静默跳过（36-38）。
  - `search.ts:57-85` glob→正则，支持 `* ** ? {a,b} [abc]`，末尾/独立 `**` 语义分开处理（62-66）。
  - `search.ts:89-93` 不含 `/` 的模式只比文件名，含 `/` 比相对路径；`95-129` `glob` 按 mtime 倒序、最多 200 条、返回 `truncated`。
  - `search.ts:162-231` `grep`：正则编译失败给出明确错误（166-168），`context` 上限 5、`max_results` 上限 500（172-173），>2MB 文件跳过并计数（192-195），含 `\0` 视为二进制跳过（197），三种 `output_mode` 分别返回（227-229），上下文行用 `-` 分隔、重复行去重（211-217）。
- 依赖：`files.safePath`；被 `index.ts:10`、`run.ts` 经注册表引用。
- 风险：`84` 正则固定带 `i` 标志 → glob 永远大小写不敏感（spec 未说明）；`path` 参数存在时「相对路径」实际相对 `path` 而非工作区（118-120）。

### `src/lib/agent/tools/files.ts`（224）
- 作用：工作区沙箱内的四个文件工具 + 路径安全工具函数。
- 导出：`workspaceOf(userId): string`（15-18）、`safePath(root, p="."): string`（20-24）、`listFiles`、`readFile`、`editFile`、`writeFile`。
- 关键逻辑：
  - `files.ts:15-24` `workspaceOf` 用 `/^[a-z0-9_-]+$/i` 校验 userId；`safePath` resolve 后要求 `full===root || full.startsWith(root+sep)`，否则抛「路径超出工作区」。
  - `files.ts:26-52` `listFiles`：`parallelSafe`，隐藏项过滤（44），目录名补 `/`（47）。
  - `files.ts:58-108` `readFile`：前 8000 字符含 `\0` 判为二进制（81）；每行 `padStart(6)` 加行号（94）；双上限 `max`（默认 400，最大 2000）与 `MAX_READ=20000` 字符（13,85,92）；返回 `nextOffset`/`totalLines`。
  - `files.ts:116-177` `editFile`：CRLF 文件自动把 `old_string` 换行风格对齐（148-151）；非唯一时报出前 10 处行号（153-159）；替换用 `split/join` 避免 `$&` 被当替换符（162）；返回修改处前后各 2 行预览（166-175）。
  - `files.ts:191-201` 找不到时给线索：识别「带上了行号」、用首行定位并展示原文。
  - `files.ts:203-224` `writeFile` 自动建父目录并返回 `bytes`。
- 依赖：`server/db.DATA_DIR`；被 `search.ts`、`run-command`/`run-python`（间接）、`app/api/chat/route.ts:6` 引用。
- 风险：`79` 对不存在的文件直接暴露 `fs.stat` 的英文 ENOENT（`edit_file:139-142` 才有友好提示）；无大小上限，超大文本会整文件读入内存。

### `src/lib/agent/tools/run-command.ts`（250）
- 作用：沙箱终端执行 bash 命令，含分级、审批、实时输出、`cd` 保持、输出头尾截断。
- 导出：`runCommand: Tool<{command; description?; timeout_ms?}>`（内部还有 `classify`、`HeadTail`、`currentDir/saveDir`）。
- 关键逻辑：
  - `run-command.ts:8-14` `DEFAULT_TIMEOUT=30s`、`MAX_TIMEOUT=120s`、`HEAD=2000`、`TAIL=6000`、`FLUSH_MS=100`。
  - `151-157` `DENY` 黑名单（sudo/su、删根或家目录、fork 炸弹、curl|sh、关机/格式化/dd）；`160-161` `READONLY` 首个词白名单；`163-168` 出现 `; & > \` $( | sh|bash|xargs|tee -delete -exec` 任一侧效标记，就不再算只读。
  - `run-command.ts:70-75` 先 `classify().deny`，否则 `checkCommand(cmd, root, cwd)`，被拦就写审计并抛错。
  - `run-command.ts:78-84` 有 `ctx.confirm` 时按 `readonly` 决定确认文案；用户拒绝返回 `{denied:true}` 并明确要求「不要重复执行它」。
  - `run-command.ts:87-90` 超时钳到 `[1000, 120000]`；用 `trap 'printf "\n<MARK>%s\n" "$(pwd -P)"' EXIT` 在结束时输出目录标记（90）后从输出里剥掉（111-122）。
  - `run-command.ts:176-206` 目录记忆：会话级 `Map`，只允许停在工作区或授权目录内，越界则 `reset` 回根目录并附 `note`。
  - `211-239` `HeadTail` 只保留头 2000 + 尾 6000 字，中间只计数；`242-250` 去 ANSI、按 `\r` 取每行最后一次内容。
- 依赖：`server/sandbox`（`checkCommand/runInSandbox/sandboxEnv/sandboxInfo/sandboxRoot`）、`server/audit`；被 `index.ts:8` 注册。
- 风险：注释（28）已承认分级只是体验层、真正边界靠沙箱；`saveDir`（197）用 `startsWith` 做前缀比较未带分隔符（`/ws` 会命中 `/ws2`，但随后 199-202 的 `inside()` 会把它 reset 回根，属自愈路径）。

### `src/lib/agent/tools/run-python.ts`（76）
- 作用：在沙箱里运行一段 Python 3 代码（限时 20s）。
- 导出：`runPython: Tool<{code: string}>`。
- 关键逻辑：`run-python.ts:8-9` `TIMEOUT_MS=20000`、`MAX_OUT=8000`；`38-41` 把代码写到 `<workspace>/.runs/run_<ts>.py`；`45` 解释器 = docker 模式的 `python3` 或 `A_PYTHON` 环境变量（默认 `python3`）；`49-58` 走 `runInSandbox`，`cwd` 是沙箱根，`onData` 里只保留最后 32KB；`59` 运行后删文件；`60-63` 每次运行记审计；`69-70` 只返回 stdout/stderr 各最后 8000 字。
- 依赖：`server/sandbox`、`server/audit`；被 `index.ts:9` 注册。
- 风险：`59` 的 `fs.rm` 没有 `try/finally`，沙箱启动异常时 `.runs/*.py` 残留，而 `.runs` 是隐藏目录（`files.ts:44`、`search.ts:41` 都会跳过）→ 残留不可见。

### `src/lib/agent/tools/web-fetch.ts`（89）
- 作用：抓取网页正文（HTML→纯文本），带头 SSRF 防护。
- 导出：`webFetch: Tool<{url: string}>`、`decode(s): string`（被 `web-search.ts:2` 复用）。
- 关键逻辑：`web-fetch.ts:10` `parallelSafe`；`28-30` 只允许 http/https 且拒绝本机/内网 host；`32-34` 15s 超时并与 `ctx.signal` 用 `AbortSignal.any` 合并，UA 为 `A.ai/0.1 (+agent)`；`39-40` 用正则取 `<title>`，`content-type` 含 html 才走 `htmlToText`；`53-63` 去 script/style/head、块级标签转换行、压缩空白；`41-47` 超过 `MAX_CHARS=8000`（3 行）截断并标 `truncated`。
- 依赖：无（仅 `./types`）；被 `index.ts:12` 注册。
- 风险：`77-89` 的私网黑名单只比对 hostname 字面量（不解析 DNS），未覆盖 `100.64/10`、`fc00::/7`、`::ffff:127.0.0.1`、`0.0.0.1` 等，理论上可被 DNS rebinding 绕过。

### `src/lib/agent/tools/web-search.ts`（126）
- 作用：网页搜索，三家后端统一成 `{title,url,snippet}`。
- 导出：`webSearch: Tool<{query; max_results?}>`。
- 关键逻辑：`web-search.ts:22` `parallelSafe`；`45-49` 后端选择顺序 `TAVILY_API_KEY → BRAVE_SEARCH_API_KEY → DuckDuckGo HTML`；`41` 结果数默认 6、上限 10；`51-59` 错误翻译（`TimeoutError` → 「搜索超时（15 秒）」，`fetch failed` 时取 `cause.code`）；`65-75` Tavily POST；`77-83` Brave GET；`90-122` DuckDuckGo：正则分块解析（105-108）、从 `uddg` 参数解真实地址（111-113）、跳过 `y.js` 广告（114）、识别 captcha 时给出配置 Key 的提示（119-120）。
- 依赖：`web-fetch.decode`；被 `index.ts:13` 注册。
- 风险：DDG 是爬 HTML（注释 88 已声明易失效）；`tavily` 把 `Authorization: Bearer` 放在 POST 头，Key 缺失时后端选择阶段就会跳过，不会误用。

### `src/lib/agent/tools/todo.ts`（67）
- 作用：模型自用的任务清单（对应 Claude Code 的 TodoWrite），无服务端状态。
- 导出：`todoWrite: Tool<{todos: {content; status}[]}>`。
- 关键逻辑：`todo.ts:21-67` 未设 `parallelSafe`（有"覆盖语义"）；`48` 非数组直接抛错；`49-55` 过滤空内容、`slice(0,30)`、content 截 200 字、status 只认三值否则归 `pending`；`56-64` 返回 `todos/progress` 并在「多个 in_progress」「全部 completed」两种情况下附 `note` 提示。
- 依赖：`server-only`；被 `index.ts:11` 注册。
- 风险：清单只存在对话历史里（注释 12-13），历史被截断时清单也随之消失。

### `src/lib/agent/tools/ask-user.ts`（50）
- 作用：向用户提问并结束本轮（唯一 `endsTurn` 工具）。
- 导出：`askUser: Tool<{question; options?; multiple?}>`。
- 关键逻辑：`ask-user.ts:14` `endsTurn: true`；`36-39` question 空则抛错，options 统一 trim/去空并 `slice(0,6)`；`40-48` 返回 `{status:"waiting_for_user", question, options, multiple, note}`，用户回答作为下一条 user 消息。
- 依赖：`./types`；被 `index.ts:14` 注册。
- 风险：`multiple` 默认 false 但未在服务端校验用户答案；与其它工具同轮出现时 `run.ts:196` 仍在整批执行完后才 break。

### `src/lib/agent/tools/create-artifact.ts`（39）
- 作用：把成品（markdown/html/code）推到右侧面板。
- 导出：`createArtifact: Tool<{title; kind: ArtifactKind; content; language?}>`。
- 关键逻辑：`create-artifact.ts:8` 标了 `parallelSafe: true`；`34` content 空抛错；`35` kind 白名单外一律降级 `markdown`；`36-37` 调 `ctx.emitArtifact` 落库并返回 `已在右侧面板展示「…」(id=…)` + `artifactId`。
- 依赖：`shared.ArtifactKind`；被 `index.ts:5` 注册。
- 风险：`parallelSafe` 与 `types.ts:47-51` 的「有副作用不要设」约定冲突（`run.ts:286-291` 里会 `addArtifact` 写库）。

### `src/lib/llm/types.ts`（80）
- 作用：与任何模型之间的**唯一契约**（OpenAI Chat Completions 形状）。
- 导出：`Role`、`ToolCall{id,name,arguments}`、`ChatMessage{role,content,reasoning?,toolCalls?,toolCallId?}`、`JSONSchema`、`ToolSpec{name,description,parameters}`、`ChatRequest{messages,tools?,temperature?,signal?}`、`Usage{inputTokens,outputTokens,cacheHitTokens?,reasoningTokens?}`、`StreamChunk`（5 种分支）、`LLMProvider{id,stream}`。
- 关键逻辑：`types.ts:68-73` 五种块 `reasoning|text|tool_call_delta|tool_call|done`，其中 `tool_call_delta` 只给界面看、执行以拼完整后的 `tool_call` 为准；`66` 说明 OpenAI 需要 `stream_options.include_usage` 才有 usage。
- 依赖：被 `agent/run.ts`、`verify.ts`、`reflect.ts`、所有工具、两个 provider 引用。
- 风险：`21` 行注释写「reasoning 只用于展示，不再发回给模型」，与 `run.ts:237`、`openai-compatible.ts:116` 的实现相反（见问题 2）。

### `src/lib/llm/index.ts`（31）
- 作用：按设置创建 provider 的工厂。
- 导出：`getProvider(s: Pick<Settings,"connections"|"currentModel">): LLMProvider`（另 `export * from "./types"`）。
- 关键逻辑：`index.ts:15` `currentModel` 为空或 `"mock"` → `MockProvider`；`16-18` 按 `"连接id/模型名"` 用第一个 `/` 拆分；`20-22` 连接不存在 / 缺 apiKey / 缺 baseUrl 分别抛出可读错误；`23-30` 其余一律 `OpenAICompatibleProvider`，透传 `sendReasoning`、`thinking`（`"default"` 转 undefined）、`label`。
- 依赖：`providers/mock`、`providers/openai-compatible`、`settings`；`custom.ts` **未被引用**。
- 风险：`16-18` 不校验是否含 `/`（见问题 9）。

### `src/lib/llm/providers/mock.ts`（460）
- 作用：离线假模型，用关键字剧本驱动完整 agent 链路，协议与真模型完全一致。
- 导出：`class MockProvider implements LLMProvider`（`id="mock"`）。
- 关键逻辑：
  - `mock.ts:28-34` 首条消息以 `[A.ai:reflect]` 开头 → 走 `mockReflect`（329-349：找 `XxxError`、同类 count+1、中文对话补「用中文交流」习惯）。
  - `mock.ts:36-41` 往前找「真正的用户消息」（跳过 `FEEDBACK_TAG`/`NOTE_TAG`），`step` = 其后 assistant 条数，`results` = 其后 tool 结果；`available` 来自 `req.tools`。
  - `mock.ts:49-59` 上一轮以 ask_user 结束或命中「演示提问」→ `askDemo`；命中「自动修复」→ `fixDemo`（243-282，故意先写 bug 再被 Verifier 打回）。
  - `mock.ts:61-77` 主剧本：`makePlan()`（96-170，含「改代码/终端/演示全部工具/网页文档代码/URL/算式/python/文件/时间」九类脚本）按 `step` 逐步发调用，并先把 `arguments` 每 3 字一片作为 `tool_call_delta` 流出（69-73）。
  - `mock.ts:79-82` 剧本走完 → `finish()`（172-233）按最后一个工具名生成收尾话术。
  - `mock.ts:351-359` `stream()` 每片 1-2 字、text 10ms / reasoning 16ms，尊重 `signal`。
- 依赖：`tokens.estimateTokens`、`agent/verify.FEEDBACK_TAG`、`server/notes.NOTE_TAG`（provider 反向依赖 agent 层）。
- 风险：`41` 的 `available` 在最后一步为 undefined（`run.ts:114`）→ `plan` 被清空，直接落到兜底回答；`230` 的引导文案（编辑 custom.ts + `A_PROVIDER=custom`）已失效（见问题 1）。

### `src/lib/llm/providers/custom.ts`（39）
- 作用：**已被取代的模板/死代码**——文件头自述「已被 openai-compatible.ts 取代，保留作为练习模板」（3-4 行）。
- 导出：`class CustomProvider implements LLMProvider`（21-38），`stream()` 一律 `throw new Error("CustomProvider 尚未实现…")`（37）。
- 关键逻辑：构造时从 `A_API_BASE/A_API_KEY/A_MODEL` 读默认值（24-30），`id = model || "custom"`。
- 依赖：仅 `../types`；**全仓无任何 import**（grep `CustomProvider|providers/custom` 只命中本文件与 mock.ts:230 的文案）。
- 风险：`19` 行「写完后在 .env.local 设 A_PROVIDER=custom」没有任何代码读取 `A_PROVIDER`，属过期指引。

### `src/lib/llm/providers/openai-compatible.ts`（204）
- 作用：唯一在用的真实 provider，负责 OpenAI 协议请求构造 + SSE 解析 + usage 归一。
- 导出：`OpenAICompatibleProvider`、`OpenAICompatibleOptions{baseUrl,apiKey,model,sendReasoning?,thinking?,label?}`、`joinUrl`、`readError`。
- 关键逻辑：
  - `openai-compatible.ts:33-43` 请求体：`stream:true` + `stream_options.include_usage:true`（37），有 tools 才加 `tools`（39-41），`temperature` 可选（42），`thinking:{type}`（43）。
  - `openai-compatible.ts:55-96` SSE 循环：`d.reasoning_content → reasoning`（72）、`d.content → text`（73）；`tool_calls` 按 `index` 累积到 `calls[]`，`slotOf` 记 index→槽位。
  - `openai-compatible.ts:80-87` 容错：同一 index 上出现不同 `id`，或上一个参数已是完整 JSON 又来新 `name` → 视为新调用（`isCompleteJson`，174-181），修掉「参数被拼成 `{}{}`」的老问题。
  - `openai-compatible.ts:93` 同时把参数增量作为 `tool_call_delta` 推给界面；`99-104` 流结束后按顺序补发 `tool_call`（无 name 的残片丢弃，参数空则 `"{}"`），最后发 `done{finishReason, usage}`。
  - `openai-compatible.ts:110-121` `toOpenAI`：assistant 有 toolCalls 时 `content` 置 `null`（112）、`sendReasoning && m.reasoning` 时回传 `reasoning_content`（116）、tool 消息映射 `tool_call_id`（119）。
  - `openai-compatible.ts:142-149` usage 归一（兼容 `prompt_cache_hit_tokens` 与 `prompt_tokens_details.cached_tokens`）；`154-170` SSE 切分（跨包缓冲、去 `\r`、只认 `data:` 行）；`188-204` 错误翻译（401/402/404/429 附中文提示，正文截 300 字）。
- 依赖：`../types`；被 `llm/index.ts:23` 使用。
- 风险：`169` 尾部残留行没去 `\r`，可能静默丢最后一块（见问题 8）；不支持 `event:` 行/多行 data，也没有重试与超时（只有 `req.signal`）。

## 3. 专题：ReAct 主循环时序

1. **准备**（`run.ts:64-70`）：拼系统提示（自定义或内置 + memory）、`maxSteps`、`Verifier`、`budget=maxSteps`、`pending[]`/`held[]` 两个队列。
2. **进入第 step 轮**（`run.ts:94-95`）：`for (let step = 0; step < budget; step++)`，每轮先查 `signal.aborted`。
3. **notes 注入**（`run.ts:98, 202-219`）：`injectNotes()` 用 `opts.notes()`（即 `takeNotes(sessionId)`）取出用户运行中补充的想法，写成 `role:"user"` + `NOTE_TAG` 前缀 + `feedback:{kind:"note"}` 的消息落库并推 `message` 事件 → 模型下一步就能看到。
4. **最后一步标记**（`run.ts:101`）：`lastStep = step === budget - 1 && step > 0`；若是，先发一条 `limitFeedback(budget)`（102，文案见 `verify.ts:136-143`：「已达步数上限，不能再调用工具，请直接总结」）。
5. **调模型**（`run.ts:114`）：`provider.stream({messages: toModelMessages(session, system), tools: lastStep ? undefined : toolSpecs(), signal})`；流式块边收边 yield 事件（115-131），`done.usage` 记到 `assistant.usage`（129-131）。
6. **落库 assistant**（`run.ts:145-149`）：无论有无工具调用都先 `addMessage` 再推 `assistant_end`（中途点停止也不丢消息）。`147` 行：最后一步不写 `toolCalls`。
7. **终止判定**（`run.ts:154-167`）：
   - `!calls.length || lastStep` → 若不是最后一步则 `verifier.check()`；`null` 表示放行 → **交付**（162 `break`）；
   - 若此时 `opts.notes` 又有补充想法（158），`budget = max(budget, step+2)` 后 `continue`，再来一步；
   - 否则 `sendFeedback(session, fb)`（164）把 retry/unverified 反馈作为 user 消息写进历史，`budget = min(budget + 2, maxSteps + 2*maxRounds)`（165），`continue` 回去继续改。
8. **执行工具**（`run.ts:172-193`）：`toBatches()`（246-255）把连续 `parallelSafe` 的调用合成一批（例 `[read,read,write,read] → [[read,read],[write],[read]]`），批内 `execTool` 并发、批间串行；`181-192` 用 `Promise.race` 先到先推，`verifier.observe()` 逐个结果喂给裁判，`pending` 里的 artifact 以 `artifact` 事件推出，最后 `addMessage` + `message` 事件。
9. **ask_user 短路**（`run.ts:196`）：本轮任一次调用是 `endsTurn` 工具 → 直接 `break`，等用户下一条消息。
10. **收尾**（`run.ts:199`）：`yield {type:"done"}`；随后 `route.ts:65-68` 若不 await 地触发 `reflect()`。

要点：**步数预算**是「模型调用次数」而非工具次数，一次可并发多个工具；**反馈闭环**不额外占 step 的独立配额，而是把预算抬高 `STEPS_PER_FIX=2`（最多多 `2*maxRounds` 步）；**Hermes 式修复**由 `verify.ts` 的 `rounds/nudged` 两个计数器控制次数。

## 4. 专题：工具注册表与 Tool 接口语义

- 注册表：`tools/index.ts:23-36` 一个数组，`toolSpecs()`（38）直接映射成 `ToolSpec[]` 传给 provider；`findTool`（39）按 `spec.name` 查找。**没有分组元数据、没有 enable/disable、没有权限表**——是否并行、是否结束轮次全靠工具自身的两个布尔量。
- `Tool` 字段语义（`tools/types.ts:45-58`）：
  - `spec`：给模型看的说明书（name / description / JSONSchema `parameters`），是「模型知不知道、会不会用」的唯一来源（`prompt.ts:3` 明确不在提示词里写工具用法）。
  - `parallelSafe`：只读且互不影响 → 同一轮可与相邻 `parallelSafe` 调用并行（`run.ts:250-251`，缺省 `false`）。
  - `endsTurn`：执行完本轮结束、等用户回答（仅 `ask_user`；`run.ts:196` 判定）。
  - `run(args, ctx)`：真正执行；`ctx` 提供 `sessionId/userId/workspace/signal` 4 个读能力与 `onOutput`（实时输出，只显示不发给模型）、`confirm`（审批，按 `commandApproval` 由 `run.ts:84-92` 决定是否真弹）、`emitArtifact`（写库 + 推事件）3 个写/交互能力。
- 15 个工具一句话 + schema 要点：
  1. `todo_write`（todo.ts:21）：维护完整待办清单；必填 `todos[{content,status}]`，最多 30 条，返回 progress 与提示 note；非并行。
  2. `list_files`（files.ts:26）：列目录；可选 `path`（相对工作区，默认 `.`），隐藏项不返回；并行。
  3. `glob`（search.ts:95）：按文件名找；必填 `pattern`（支持 `* ** ? {a,b} [abc]`），可选 `path`；最多 200、按 mtime 倒序；并行。
  4. `grep`（search.ts:131）：按正则搜内容；必填 `pattern`，可选 `path/glob/ignore_case/output_mode(content|files|count)/context(≤5)/max_results(≤500)`；并行。
  5. `read_file`（files.ts:58）：读文本；必填 `path`，可选 `offset/limit`（默认 400 行、上限 2000 行、2 万字符）；二进制拒绝；并行。
  6. `edit_file`（files.ts:116）：精确替换；必填 `path/old_string/new_string`，可选 `replace_all`；要求唯一、返回 preview；非并行。
  7. `write_file`（files.ts:203）：新建或整体覆盖；必填 `path/content`；非并行。
  8. `run_command`（run-command.ts:30）：沙箱 bash；必填 `command`，可选 `description/timeout_ms`（默认 30s、上限 120s）；返回 exitCode/timedOut/output/truncated/cwd/sandbox；非并行。
  9. `run_python`（run-python.ts:17）：沙箱跑 Python；必填 `code`（须 print）；返回 exitCode/timedOut/stdout/stderr 各 8000 字；非并行。
  10. `calculator`（calculator.ts:8）：精确算术；必填 `expression`（`+ - * / % ^`、括号、白名单函数与 `pi/e`）；并行。
  11. `current_time`（current-time.ts:4）：当前时间；可选 `timezone`（IANA 名）；并行。
  12. `web_search`（web-search.ts:21）：搜索；必填 `query`，可选 `max_results`（默认 6、上限 10）；并行。
  13. `web_fetch`（web-fetch.ts:9）：抓网页正文；必填 `url`（http/https、禁内网）；8000 字上限；并行。
  14. `create_artifact`（create-artifact.ts:7）：右栏成品；必填 `title/kind/content`（`kind` 枚举 markdown|html|code），`kind=code` 需 `language`；并行（有副作用）。
  15. `ask_user`（ask-user.ts:13）：提问并结束本轮；必填 `question`，可选 `options`（≤6）/`multiple`；`endsTurn`。

## 5. 专题：LLMProvider 契约与三个 provider

- **契约**（`llm/types.ts:75-80`）：只有一个方法 `stream(req: ChatRequest): AsyncIterable<StreamChunk>`，加一个只读 `id`。`ChatRequest = {messages, tools?, temperature?, signal?}`。
- **ChatMessage**（18-27）：`role: system|user|assistant|tool`、`content: string`（必填，assistant 只有工具调用时为空串）、`reasoning?`、`toolCalls?: ToolCall[]`、`toolCallId?`。与 OpenAI 的差异只在命名（`toolCalls/toolCallId` ↔ `tool_calls/tool_call_id`），由 provider 各自转换。
- **StreamChunk**（68-73）五个分支：`reasoning{delta}` / `text{delta}` / `tool_call_delta{index,name,delta}` / `tool_call{call}` / `done{finishReason?,usage?}`。**执行只认 `tool_call`**，`tool_call_delta` 纯展示。
- **Usage**（53-58）：`inputTokens`（=本次上下文占用）、`outputTokens`（含思考）、`cacheHitTokens?`（DeepSeek 的 `prompt_cache_hit_tokens`）、`reasoningTokens?`。
- **mock 剧本机制**（`mock.ts`）：读 `req.messages` 做无状态推断——找最后一条「真用户消息」（跳过 `FEEDBACK_TAG`/`NOTE_TAG`，36-37），用「其后 assistant 条数」当 `step`（39），用关键字选剧本（`makePlan` 96-170），按 `step` 发第 N 步调用，走完则 `finish()` 按最后工具名生成回答。特殊分支：`[A.ai:reflect]` → `mockReflect`（28-34）；ask_user 的上一轮 → `askDemo`（49-59）；「自动修复」→ `fixDemo`（243-282）。它还能识别 `req.tools` 是否存在（41），因此会被「最后一步不给工具」影响。
- **openai-compatible 的 SSE 解析与 reasoning 回传**：`sseData`（154-170）跨网络包缓冲、按 `\n` 切行、去 `\r`、只取 `data:` 前缀、遇 `[DONE]` 结束（61）；`reasoning_content` 直接转 `reasoning` 块（72）；`tool_calls` 按 index 分片累积（74-94）；usage 取最后出现的那块（68）。**回传方向**：`toOpenAI`（110-121）只在 `sendReasoning` 为真时把历史 `assistant.reasoning` 写回 `reasoning_content`（116）——DeepSeek 思考模式 + 工具调用场景不开会 400（注释 17-18，`run.ts:231-232` 同样说明）。
- **custom 与它的关系**：`custom.ts` 是 openai-compatible 之前的「自己写一个 provider」模板，`stream()` 永远抛错（37），`index.ts` 不 import 它，属死代码；两者的契约完全一致（都 `implements LLMProvider`），差异只是 custom 没有实现。

## 6. 问题清单（真实存在）

1. **死代码 + 过期指引**：`custom.ts` 全仓无 import；`custom.ts:19` 与 `mock.ts:230` 都让用户设置 `A_PROVIDER=custom`，但 `llm/index.ts:14-31` 只看 `settings.currentModel`，grep 全仓 `A_PROVIDER` 仅这 2 处文本、无读取点。
2. **注释与实现矛盾**：`types.ts:21` 写「reasoning 不再发回给模型」，但 `run.ts:237` 保留 `reasoning`、`openai-compatible.ts:116` 在 `sendReasoning` 时回传 `reasoning_content`（且 17-18 行注释说必须回传）。
3. **注释错位**：`run.ts:92` 行尾注释「每发一次修复反馈，预算加 STEPS_PER_FIX」挂在 `confirm` 函数结尾，真实逻辑在 `run.ts:165`。
4. **预算可越界**：`run.ts:159` 的 notes 分支 `budget = Math.max(budget, step + 2)` 没有 `165` 行的 `maxSteps + 2*maxRounds` 上限钳制，补充想法可以把总步数顶到设置值之上。
5. **maxSteps=1 的边界缺陷**：`run.ts:101` `lastStep = step === budget-1 && step > 0`，预算为 1（`settings.ts:139` 的 clamp 下限就是 1）时第 0 步永远不满足 `step > 0`；若模型发出工具调用，工具会正常执行（172-193），但 `step` 自增后 `94` 行的 `step < budget` 直接失败退出，模型既没收到 `limitFeedback` 也没有总结机会——本轮以「只有工具结果、没有回答」结束。
6. **验证匹配过宽**：`verify.ts:63`、`77` 用 `code.includes(baseName(key))` 判「跑过这个文件」，`a.py` 会被 `data.py` 的调用命中，导致未验证代码被误判为已验证。
7. **契约不一致**：`create-artifact.ts:8` 声明 `parallelSafe: true`，但其 `run` 通过 `ctx.emitArtifact` 在 `run.ts:286-291` 写库并推事件，违反 `types.ts:48-51`「有副作用的工具不要设 parallelSafe」。
8. **分层倒置**：`mock.ts:3-4` 让 llm 层的 provider 反向 import 了 agent 层与 server 层（`../../agent/verify` 的 `FEEDBACK_TAG`、`../../server/notes` 的 `NOTE_TAG`），只是因为要识别「这条 user 消息是系统反馈/用户补充」；将来把 llm 层单独抽出或复用时会形成循环依赖，两个 tag 常量更适合下沉到 `shared.ts`。
9. **currentModel 缺 `/` 时静默错切**：`llm/index.ts:16-18` 不校验分隔符，`indexOf` 返回 -1 时 `connId` 变成「去掉最后一个字符的整串」，最终报「所选模型的连接已被删除」，误导排查方向。
10. **临时文件泄漏**：`run-python.ts:59` 的 `fs.rm` 不在 `try/finally` 里；沙箱异常时 `<workspace>/.runs/run_*.py` 残留，而 `.runs` 被 `files.ts:44` 与 `search.ts:41` 的隐藏目录规则跳过，用户/模型都看不见。
11. **SSRF 防护面窄**：`web-fetch.ts:77-89` 只做 hostname 字面量黑名单，不解析 DNS（rebinding 可绕过），也未覆盖 `100.64/10`、`fc00::/7`、`::ffff:127.0.0.1`、`0.0.0.0` 之外的 0/8 地址。
12. **错误提示不一致**：`files.ts:79` 的 `read_file` 对不存在的文件直接抛 `fs.stat` 的英文 ENOENT，而 `edit_file:139-142` 有中文友好提示。
13. **glob 语义与 spec 不符**：`search.ts:84` 正则固定加 `i`，glob 永远大小写不敏感（spec `search.ts:101` 未说明）；`path` 参数存在时 `118-120` 匹配的是相对 `path` 的路径，与「相对工作区」的描述有出入。
14. **mock 在触顶预算时丢结果**：`run.ts:114` 最后一步 `tools: undefined` → `mock.ts:41` 的 `available` 为空 → `61` 行 `plan` 被清空，直接走 `finish()` 的兜底回答（含 `mock.ts:230` 的过期指引），此前的演示结果被丢弃。
15. **endsTurn 只在批末生效**：`run.ts:196` 在执行完所有批次后才检查 `endsTurn`；而「单独调用」只是 `ask-user.ts:21` spec 里的一句提示词（`prompt.ts:19` 也只说要先问），若模型仍把 `ask_user` 与其它工具放同一轮，其它工具会照常执行且 `ask_user` 的结果也已落库，无运行时拦截。