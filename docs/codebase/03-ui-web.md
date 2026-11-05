# A.ai 界面层（React 组件 + 全局样式 + App Router 页面）

> 阅读范围：`src/components/**`（29 文件 / 5656 行）+ `src/app/{layout,page,globals.css,icon.svg,login/A.ai 各级 page}`（8 文件 / 1650 行）。
> 合计 **37 文件 / 7306 行**，全部逐行读完（大文件分页读到末行）。行号均指该文件当前行号。

## 1. 概览

- 组件 29：Workspace 608、Trace 764、SettingsModal 594、Intro 518、CoreLogo 347、Sidebar 346、ChatPane 317、OutputsCard 283、ComposerBar 251、Connections 222、Canvas 153、Icons 143、SandboxPane 142、LoginForm 109、Code 98、UserMenu 93、AskCard 88、FileDrawer 81、Markdown 77、ApprovalDock 66、Loader3D 25、SvgFrame 27；CSS：code.css 84、LoginForm.css 83、OutputsCard.css 63、ApprovalDock.css 27、ChatPane.css 23、Sidebar.css 16、AskCard.css 8。
- 页面/样式 8：globals.css 1506、icon.svg 48、layout.tsx 34、A.ai/chat/[user]/[[...id]]/page.tsx 20、A.ai/page.tsx 16、login/page.tsx 10、A.ai/chat/page.tsx 10、page.tsx 6。

### 组件树（Workspace 为根）

```
Workspace (608)
├─ Sidebar (346) ─ CoreLogo, UserMenu→Avatar, NameInput
│   └─ 收起时：.side-edge 感应区 + <Sidebar floating>
├─ ChatPane (317)
│   ├─ CoreLogo / Loader3D / Icons / NameInput（标题改名）
│   ├─ Trace (764) ─ Markdown, CodeBlock/DiffBlock/TerminalView, Row/ToolRow/CommandRow/DraftRow, FileLink
│   ├─ AskCard (88) / ApprovalDock (66) / Markdown (77)
│   └─ props.bar = ComposerBar (251) ─ ModelPicker, ContextRing
├─ .right > Canvas (153) ─ iframe(srcDoc), SvgFrame, FileBody→CodeLines(HlLines), FileDiff, Markdown
├─ OutputsCard (283) ─ Sec/chain/FilesPeek；describeStep 来自 Trace
├─ SettingsModal (594) ─ Connections (222), SandboxPane (142), MemoryPane, UsagePane, Section/Row/Seg/Toggle/Stepper
└─ 独立入口：login/page → LoginForm (109)；A.ai/page → Intro (518)；两者都用 CoreLogo
```

### 状态归属

| 状态 | 位置 | 理由 |
|---|---|---|
| sessions / cur / streaming / error / draft | Workspace 59-63 | 三栏都要用；SSE 只在这里归约（Workspace 215） |
| view（右侧大视图）/ listOpen（任务面板）/ viewW / resizing | Workspace 71-76 | Canvas、ChatPane、OutputsCard 三方共享；`viewW` 需写 `<html>` 之外的 `.app` 内联变量（490） |
| groups（对话分组） | Workspace 69 | Sidebar 只回传 `onGroupsChange`（Sidebar 45、134-137） |
| settings / settingsTab / tools / fixedTokens | Workspace 80-89 | 设置弹窗、ComposerBar 上下文环、`:root[data-*]` 都由它派生 |
| running（callId→开始时间） | Workspace 83 | Trace/OutputsCard 都按 `running[callId]` 判断“进行中” |
| 左栏折叠 folded | Sidebar 63（模块缓存 foldedCache 28） | 每次 leftOpen 切换 Sidebar 会重挂载，用模块变量避免闪一下 |
| 项目列表 projects | Sidebar 59（**仅组件内**） | 未落库；随重挂载丢失（见 §7-2） |
| 行展开 rows | Trace 175 | DraftRow→ToolRow 换组件，行内 state 会丢，必须提到父级（注释 170-174） |
| 面板三段折叠 open | OutputsCard 43 + localStorage `a.panelOpen` | 跨会话记忆 |
| 右侧视图记忆 | Workspace 41-55 `a.panels`（最多 200 条） | 按会话 id 存 view/list |

## 2. 逐文件

### 页面层
**`src/app/layout.tsx`（34）** 根布局：`next/font/local` 加载 Manrope 并挂 `--font-brand`（7-12），metadata/viewport（14-26）。
- 关键：`<html lang="zh-CN" className={brandFont.variable}>`（30）——Sidebar.css:16 用它。
- 风险：没有 `suppressHydrationWarning`；主题由客户端 effect 写 `<html data-theme>`（Workspace 149-153），首屏可能闪一下浅色。

**`src/app/page.tsx`（6）** 根路径 `redirect("/A.ai")`（5）。

**`src/app/A.ai/page.tsx`（16）** `force-dynamic`，服务端读 `currentUser()`，把 `user|null` 交给 Intro（14-15）。

**`src/app/A.ai/chat/page.tsx`（10）** 登录则 302 到 `/A.ai/chat/{encodeURIComponent(username)}`，否则 `/login`（8-9）。

**`src/app/A.ai/chat/[user]/[[...id]]/page.tsx`（20）** 身份取自 Cookie；`user` 与登录名不符就重定向并丢弃对话 id（18-19）。
- 关键：`<Workspace user={me.username} initialId={id?.[0]} />`（19）——可选 catch-all，新对话无 id。

**`src/app/login/page.tsx`（10）** 已登录跳 `/A.ai/chat`（8），否则渲染 LoginForm（9）。

**`src/app/icon.svg`（48）** 静态图标：42 个圆点复刻 `CoreLogo` 的稀疏粒子球（第 2 行注释），`g{fill}` 由 `prefers-color-scheme` 切换（4-5）；第 1 行是内嵌 C2PA 元数据（体积占大部分）。

### 骨架与样式
**`src/app/globals.css`（1506）** 唯一全局样式表，按区块分组：变量 7-31 / 深色 34-77 / 基础重置 79-98 / 布局 100-116 / 左栏 119-230 / 中栏 233-267 / 空态 274-281 / 输入框 285-337 / 立方体 340-379 / 思维链 385-490 / 右栏 495-560 / 任务面板 564-650 / Markdown 653-670 / 用户 673-710 / 设置弹窗 713-830 / 快捷键表 835-838 / 用量 847-877 / 输入框下栏 880-941 / 连接 944-980 / 减动效+窄屏 983-998 / 旧登录页 1000-1085 / CoreLogo 1087-1090 / 介绍页 1092-1428 / 终端+确认 1430-1462 / 沙箱 1464-1491 / ask 1492-1506。
- 变量层：`--base/--surface/--surface-2/--soft/--hover/--active/--fg*/--edge/--edge-hi/--shadow-*/--accent*/--danger/--ok/--font/--mono/--side-w/--canvas-w`（7-31）。
- 布局层：`.app{display:flex;height:100dvh}`（101）、`.side`（119-127）、`.chat`（233-237）、`.right`（495-499）、`.resize-handle`（501-513）、`.viewer`（515-523）。
- 组件层：`.trace*`（385-437）、`.io-*`（458-490）、`.panel/.psec`（564-586）、`.oc` 相关在 OutputsCard.css、`.md`（653-670）、`.modal/.set-*`（713-830）、`.ctx-*`（921-941）、`.conn*`（944-980）、`.sbx-*`（1464-1491）。
- 动画层：`side-pop`(139)、`drop-in`(573)、`pop-up`(699)、`modal-in`(727)、`slide-in`(524)、`tumble/pulse`(374-379)、`ring-spin`(447)、`shimmer`(455)、`prog-run`(609)、`grid-drift`(1170)、`marquee`(1233)、`scan`(1191)、`char-in`(1208)、`orb-in`(1174)、`viz-*`、`shake`(1061)。
- 风险：`.login-*`（1000-1085）整套已被 LoginForm 的 `.auth-*` 取代，只剩 `.login-submit` 仍被引用（LoginForm.tsx 89）；`.hint`(330)、`.prog`(602-609)、`.side-day`(167)、`.approve-*`(1444-1462) 无任何使用者。

### 组件（tsx）
**`Workspace.tsx`（608）** 唯一持有业务状态的容器：初始化、会话 CRUD、SSE 归约、快捷键、右侧宽度拖拽。
- state/hooks：sessions/cur/streaming/error/draft/leftOpen/peek/groups/view/listOpen/viewW/resizing/fixedTokens/tools/running/modKey/settings/settingsTab（59-89），ref：inputRef/abortRef/curIdRef/pendingNotes/uiRef/settingsRef（91-96）。
- 初始化一次拉 info/list/groups/settings，并兼容旧链接 `?s=`（99-117）；主题/宽度/字号写 `<html data-*>`（149-159）；URL 用 `replaceState` 同步（162-165）。
- `apply()`（215-308）是本文件核心，见 §4。
- `batcher`（314-329）按帧合并事件，`coalesce`（591-608）把相邻 text/reasoning/tool_input/tool_output 增量拼成一条。
- `send()`（335-354）运行中发送=补充想法走 `api.note`，`pendingNotes` 兜底（380-384）；`start()`（356-386）负责 AbortController、finally 里 `batcher.flush()` 与把会话提到列表首位（373-378）。
- 快捷键（389-417）：⌘, 设置 / ⌘K 新对话 / ⌘B 左栏 / ⌘\ 任务面板 / Esc 关视图或停止 / `/` 聚焦输入框（`isTyping` 守卫 585-588）。
- 宽度拖拽（449-468）：clamp 320 ~ `innerWidth-side-380-20`，双击恢复默认（544）。
- 依赖：`@/lib/{client,live,shared,outputs,settings}`。
- 风险：见 §7-1、§7-3、§7-4。

**`ChatPane.tsx`（317）** 中栏：消息轮切分、滚动贴底、输入框自适应、新建对话欢迎态。
- `toTurns`（25-35）把扁平消息切成“用户消息 + 其后所有步骤”；`useGreeting`（310-317）在 effect 里取本地时间，避免 SSR 不一致。
- 滚动：`useLayoutEffect` 仅在“用户消息数/首条 id”变化时贴底（101-106）；`ResizeObserver` 只在内容变高时重算“是否在底部”（108-116），阈值 80px（112、196）。
- 输入框高度：`height:0 → min(scrollHeight,220)`（122-127），依赖 `[draft, isEmpty]` 以便切换空/非空时重算。
- 文件名点击：`latest` ref 保证 `openName` 恒定，Markdown 的 memo 才不会失效（76-83）。
- 发送键两种模式（285-290），仅流式中且草稿为空时显示停止键（293-301）。
- 文件按钮 + `FilesPeek` 悬停 150/180ms 延迟（88-97、166-188）；大视图打开时按钮让位给 Canvas 标题栏（165）。
- 风险：`useEffect` 依赖写成 `[turns.length === 0]`（116）属隐式依赖；`.chat-title` 用 div+onClick 改名，键盘不可达（150-156）。

**`Trace.tsx`（764）** 一轮 agent 过程：一行一动作、可展开参数/结果、终端行、确认中标题。
- `TOOLS` 表（28-155）集中定义 14 个工具的完成/进行时动词与 target 渲染——新增工具必须在此登记。
- 标题行：运行中 `currentPhase`（619-638）显示真正在发生什么，完成后 `summarize`（603-611）给摘要；节流 400ms 防闪（197、737-754）。
- 展开态提升到本组件 `rows`（175-176），key = `${a.id}:${index}`（261、285），解决 DraftRow→ToolRow 换组件丢状态。
- `useNow(live)` 每 100ms 计时（756-763）；`parsePartial`（685-700）正则解析未写完的 JSON 参数，`LIVE_FIELD`（525）决定哪一段正文边生成边显示。
- 终端行 `CommandRow`（401-444）+ `TerminalView`（447-480）：运行中自动贴底，用户上翻即停止跟随（449-462）。
- 依赖：Markdown、Code、FileDrawer.join、Icons、`@/lib/live` 的 `useApprovals/useLiveOutput`。
- 风险：§7-5、§7-6。

**`Sidebar.tsx`（346）** 左栏：新建、项目（未持久化）、分组折叠/拖拽、会话行、用户菜单。
- 分组计算 `byGroup`（86-96）按 `groups.assign` 归组，无有效分组落“未分组”；搜索仅在 `sessions.length>8` 时出现（210）。
- 拖拽用原生 HTML5 DnD，`DRAG_TYPE="text/a-session"`（26），`dropHandlers`（133-149）在 dragover 时校验 types。
- 折叠态用 map（121-131）双写 localStorage `a.folded` 与模块缓存（28、63-70）。
- `NameInput`（331-346）导出给 ChatPane 复用（标题改名）。
- 风险：§7-2、§7-7。

**`Canvas.tsx`（153）** 右侧大视图：产出物（html/markdown/svg/代码）与工作区文件（内容/目录）统一呈现。
- `changes`（31）取本对话对文件的改动；`tab` 初始值由“是否已有修改”决定（36，刻意用 `viewKey` 而非 view）。
- `useFile(path, props.refreshKey)`（39）——refreshKey 来自 `messages.length`（Workspace 550）。
- 复制/下载（52-66）：Blob + 临时 `<a>`；`safeName`（151-153）清掉非法字符。
- 安全：html 用 `iframe sandbox="allow-scripts allow-forms allow-modals" srcDoc`（129），无 `allow-same-origin`；SVG 交给 SvgFrame（131）。
- 风险：§7-8。

**`OutputsCard.tsx`（283）** 任务面板（悬浮卡片）：状态行、进度条、链路、输出、已使用三段折叠。
- `lastTaskSteps`（255-283）只看最后一条用户消息之后的步骤；`drafts` 也算一步（270），等待模型时补“思考下一步”（280-281）。
- `stats`（60-75）把每个文件本轮的多次改动累加 `+add/-del`；`taskInfo`（186-194）取任务起始时间。
- 定时重绘：流式中 1s、平时 30s（78-82）；`Sec` 必须定义在组件外，否则每次重绘重建 DOM（注释 212-213）。
- `FilesPeek`（238-252）供 ChatPane 悬停使用；`describeStep` 从 Trace 反向依赖（4）。
- 风险：§7-9。

**`ComposerBar.tsx`（251）** 输入框下方一行：上下文环 + 模型选择。
- `ContextRing`（99-207）用最近一次 `usage` 计算占用，缺省回退“系统提示词+工具说明”估算（111-116）；SVG 环用 `stroke-dasharray`（143-146）。
- 堆叠条与图例（162-178）；点外部/Esc 关闭 `usePopover`（222-241）。
- 风险：`fmtK` 与 Connections.tsx 222 重复；Esc 用 capture+stopPropagation（228-231）会吞掉全局 Esc。

**`SettingsModal.tsx`（594）** 设置弹窗：6 个标签页，改动即时保存。
- `update()`（61-73）先本地生效再防抖保存，右上角“保存中/已保存”（90）。
- 记忆页 `MemoryPane`（321-427）读写 `/api/memory`；用量页 `UsagePane`（443-523）画 14 天柱状图 + 工具表。
- 风险：§7-10（共用一个 timer）、§7-11（effect 依赖 props）。

**`Connections.tsx`（222）** 模型连接 CRUD + “测试连接”拉取 `/models`。
- `ConnForm`（89-220）校验 `canSave`（109）；首次添加连接时自动切到它的第一个模型（25）。
- Key 永远只拿到打码值（注释 10，`isMasked` 130）。

**`SandboxPane.tsx`（142）** 只读展示沙箱模式/网络/授权目录 + 审计日志（`/api/sandbox`）。
- 类型在前端重复声明一份（10-23，注释说明 server-only 不能引）。

**`Markdown.tsx`（77）** react-markdown + remark-gfm 封装。
- `pre` 覆写：`language-svg|xml` 且以 `</svg>` 结尾才渲染成图（45），避免流式半张图；其余走 `CodeBlock`（48）。
- 文件名 chip（16-30、52-65）来自 `rehypeFileChips` + `isFileName`；`memo` 依赖稳定 `onOpenFile`。

**`Code.tsx`（98）** 代码显示三件套：`CodeBlock`（14）、`HlLines`（23）、`DiffBlock`（41，支持 `context` 折叠）+ `FileDiff`（87，固定 context=3）+ `diffStat`（96）。

**`FileDrawer.tsx`（81）** 文件内容区 + `useFile` 数据钩子（19-33，`cache:"no-store"`）+ `join/fmtSize` 工具（79-81）。
- 风险：每次 refreshKey 变化都 `setRes(null)`（21）→ 文件视图闪回“读取中…”。

**`ApprovalDock.tsx`（66）** 命令确认卡片，固定在输入框上方；一次只显示最早一条（24）。
- 点完不立刻消失，等服务端 `approval_end`（注释 16、`api.approve` 40）。
- 风险：按钮带 1/2/3 编号（57）但没有数字快捷键；无焦点管理。

**`AskCard.tsx`（88）** `ask_user` 提问卡片：选项多选/单选 + 补充想法，拼成一条消息发出（26）。
- `findAsk`（77-88）从本轮最后一条 assistant 的 toolCalls 里反解参数；`multiple` 用 `role="radiogroup"` 但选项用 `aria-pressed`（36-42），语义不一致。

**`UserMenu.tsx`（93）** 左下角账号 + 菜单（设置/用量/快捷键/关于/退出），`Avatar`（86-93）取首字。

**`LoginForm.tsx`（109）** 登录/注册卡片 + 粒子球；`POST /api/auth/{login|register}`，成功 `location.replace("/A.ai/chat")`（30）。
- 风险：无失败次数提示/禁用节流；错误态靠 `key={shake}` 重播动画（17、85）。

**`Intro.tsx`（518）** 介绍页：首屏粒子球 + 跑马灯 + Pipeline 动画 + bento + 数字 + 宣言 + 部署。
- `Pipeline`（334-463）用单一 13s 时间线 `t` 驱动全部画面（311-330 为常量表），IntersectionObserver 只在可见时 rAF（351-357），`prefers-reduced-motion` 时定格 11000ms（341）。
- `Manifesto`（482-518）监听 `.intro` 容器滚动（不是 window），逐字改 `opacity`（497）。
- `reveal` 淡入由 `.in` 类 + IO 添加（25-37、1393-1394）。
- 风险：每帧 `setT` 重渲染整棵 pipeline 子树（348）。

**`CoreLogo.tsx`（347）** Canvas 2D 粒子球 logo：斐波那契球面撒点、`envelope` 控制散开再聚（168-173），`wild` 模式另有一套“流散—融合”（277-347，按深度分 10 桶批量绘制 336-345）。
- 关键：`IntersectionObserver` 只画可见的（94-98）；`prefers-reduced-motion` 直接不启动 rAF（70、131、150）。
- 风险：普通路径每帧 `getComputedStyle(el)`（146），wild 路径 30 帧才读一次（129），不一致且前者每帧强制样式计算。

**`SvgFrame.tsx`（27）** SVG 放进 `sandbox="allow-scripts"` 的 iframe（17），SMIL/CSS/JS 动画都能跑但拿不到 Cookie；`ratioOf`（21-27）从 viewBox 推宽高比，inline 时用 `aspect-ratio`。

**`Icons.tsx`（143）** 26 个 16px 线性图标，统一 `base()` 1.5 线宽（4-15）；`ILogo` 的横杠换成点（18-24）。

**`Loader3D.tsx`（25）** 纯 CSS 立方体加载动画，靠 `--s` 变量定尺寸（10），样式在 globals 340-379。

### 组件样式（css）
**`code.css`（84）** 变量层：GitHub Light/Dark 两套 `--hl-*`（3-28）；组件层：hljs 词类映射（31-42）、`.diff/.dl/.ln/.sign`（45-58）、`.file-diff` 去框（61-62）、`.file-chip` 浅蓝文件标记（70-84）；禁令 `font-variant-ligatures:none`（79）防止 `->` 变箭头。

**`LoginForm.css`（83）** `.auth` 居中栅格（3-6）；背景层 `.auth-bg::before/::after` 点阵+噪点（9-23）、`.auth-glow` 两团光（24-31）；组件层卡片与字段（39-61）；`.auth .login-submit`（67-74）刻意保留旧类名但改了高度（38px vs globals 44px）。

**`OutputsCard.css`（63）** 布局层：`.app.right-open .panel{right:calc(var(--canvas-w)+22px)}`（5）让面板让开大视图；`.panel.oc{width:340px}`（7）；组件层：`.oc-head/.oc-state`（10-19）、`.oc-bar` 扫光（22-29）、`.oc-prompt`（32-36）、`.chain-ms`（40）、`.oc-out/.oc-ico/.oc-sub/.oc-ext` 两行信息（43-59）；减动效（61-63）。

**`ChatPane.css`（23）** 覆盖层：`.composer .send.stop`（6-13）把 globals 的旋转弧线换成描边方块（`::after{content:none}`）；`.answer .md hr` 隐藏分隔线（16-17）；`.chat .term` 把终端改成浅灰底（21-23）。

**`Sidebar.css`（16）** 布局层 `.side-section.proj`（2）；组件层 `.proj-item*`（3-11）；品牌字体 `.side .brand-text{font-family:var(--font-brand)…;font-size:23px}`（14-16）。

**`ApprovalDock.css`（27）** 全部 `apd-` 前缀：卡片（3-8）、标题/原因（9-10）、命令块（12-16）、竖排按钮（17-26）。

**`AskCard.css`（8）** 只做一件事：`.ask-card .ask-opts` 从横排改为竖排 + `counter` 自动编号（3-8），覆盖 globals:1498-1499。

## 3. 专题：三栏布局与响应式

- 结构：`.app` 是 flex 行（globals 101，`height:100dvh`），三块**都不换行、都不滚动整个页面**，滚动只发生在 `.chat-scroll`（253）与 `.viewer-body`（537）/`.side-list`（166）。
- 左栏：`width:var(--side-w)=252px; flex:none`（28、119-127），只靠 `box-shadow:1px 0 0 var(--edge)` 一条细线分隔，不加投影（注释 118）。
- 中栏：`flex:1; min-width:0`（233-237）——`min-width:0` 是必须的，否则代码块会把 flex 项撑破。内容宽度 `--thread-w`（默认 780，`data-width=narrow|wide` → 680/980，255-260），输入框独立 `max-width:728px`（285，注释说明“宽度固定，不跟着对话宽度设置变”）。
- 右栏：`width:var(--canvas-w)`，默认 `clamp(400px,46vw,940px)`（29），`margin:10px 10px 10px 0` 让它成为一张浮起卡片（495-499）；`--canvas-w` 被 Workspace 用内联变量覆盖（490）以支持拖拽宽度。
- 宽度记忆：`localStorage["a.viewW"]`（Workspace 436-448），拖动 `pointerdown` 挂全局 `pointermove/pointerup`（455-466），拖动时 `.app.resizing` 关掉 iframe 鼠标事件与文字选择（511-513）。
- 任务面板定位：`position:fixed; top:52px; right:14px; width:320px`（globals 564-566）；大视图打开时改用 `right:calc(var(--canvas-w)+22px)`（OutputsCard.css 5）——注意它依赖同一个 `--canvas-w` 内联变量，因此拖宽时面板跟着走。
- 断点只有两档：
  - `@media (max-width:900px)`（987-998）：`.side` 变 fixed 浮层、`.right` 变 `inset:8px` 全屏覆盖、隐藏 `.resize-handle`、`.thread/.composer-wrap` 内边距 16px、隐藏 `.hint`、设置弹窗导航缩到 64px 图标、bento/工具网格单列。
  - `@media (max-width:640px)`（1415-1428）：只影响介绍页（导航间距、粒子球 `scale:0.72`、viz 列宽）。
- 没有 `--panel-w`；面板宽度是硬编码 320（globals 566）/340（OutputsCard.css 7）两处不一致。
- 风险：Workspace 拖拽的 clamp 上界 `innerWidth-side-380-20`（453）在窗口窄于约 700px 时会小于下界 320，`Math.min` 最终取到上界，右侧视图会窄到不可用。

## 4. 专题：SSE 事件 → UI 状态（Workspace.apply，215-308）

事件类型共 13 种（`src/lib/shared.ts:110-123`），`apply` 全覆盖且**无 default 分支**（新增事件类型会被静默忽略）。

| 事件 | 行 | 状态变化 |
|---|---|---|
| `session` | 217-220 | `setCur` 补 id/title/createdAt；`setSessions` 把该条提到数组首位（`{...find(...), ...e.session}`）。 |
| `message` | 221-245 | 若是 note，从 `pendingNotes` 移除对应 summary（222-225）；`setCur` 里用 `tmp`/`tmpnote` 前缀把本地临时消息**替换**成服务端版本，否则按 id 去重后 push（229-236）；带 `toolCallId` 时从 `running` 删除该 call（238-244）。 |
| `reasoning` / `text` | 246-260 | 同一 `messageId` 找不到就新建 assistant 占位，然后 `[field] = 旧值 + e.delta`（253-254），字段分别是 `reasoning`/`content`。 |
| `tool_input` | 261-274 | 拼 `drafts[index]`：`{name: e.name || d.name, arguments: d.arguments + e.delta}`（268-269）——Trace 用它边生成边显示代码/文件内容。 |
| `assistant_end` | 275-283 | 用完整消息**整体替换**该 id（含 `toolCalls`、`durationMs`、`usage`），drafts 随之作废。 |
| `artifact` | 284-290 | append 到 `cur.artifacts`；若 `settingsRef.current.autoOpen` 则 `setView({type:"artifact", id})` 直接打开（287-289）。 |
| `error` | 291-293 | `setError(e.message)`，ChatPane 在输入框上方渲染 `.error-bar`（260-267）。 |
| `tool_start` | 294-296 | `running[callId] = startedAt`，驱动行内环形动画与实时计时。 |
| `tool_output` / `approval` / `approval_end` | 298-302 | 不进 React state，转交 `liveStore`（`src/lib/live.ts`），由 `CommandRow`（`useLiveOutput`）与 `ApprovalDock`（`useApprovals`）各自订阅，避免长终端输出触发整棵树重绘。 |
| `done` | 303-306 | `setRunning({})` + `liveStore.reset()`。 |

- 补充：`ask` 与 `todo` **没有独立事件**。提问卡片由 `findAsk`（AskCard 77-88）从最后一条 assistant 的 `toolCalls` 反解；计划清单由 `Trace` 读 `todo_write` 参数渲染（354-363）；任务面板链路由 `describeStep`（Trace 656-662）复用同一张 `TOOLS` 表。
- 批量策略：`batcher.push` 只入队并 `requestAnimationFrame(flush)`（324-327），`coalesce` 合并相邻同 messageId 的 `text/reasoning/tool_input`（同 index）与同 callId+stream 的 `tool_output`（596-604）；`start()` 的 finally 再 `flush()` 一次（368），保证定稿不漏。
- 事件来源：`streamChat(..., batcher.push, ac.signal)`（364）。

## 5. 专题：交互细节

- **贴底滚动**：只在“用户消息数/首条消息 id”变化时贴底（ChatPane 101-106）；流式输出中不跟随，改由 `ResizeObserver` 检测 `scrollHeight-scrollTop-clientHeight<80` 决定是否显示“回到底部”按钮（108-117、255-259）。globals 253 用 `overflow-anchor:none` 关掉浏览器滚动锚定，否则展开代码块时页面会自己往下跑（注释 250-252）。
- **终端自动跟随**：`TerminalView` 每次渲染后在 `stick.current` 为真时贴底，用户上翻超过 24px 就停止跟随（447-462）。
- **折叠态提升**：Trace 的行展开状态放在父组件 map（175-176），因为正在生成的工具行（`DraftRow`）与完成后的行（`ToolRow`）是不同组件，state 会丢；`OutputsCard.Sec` 必须定义在组件外部，否则每次重绘都是“新组件”，DOM 重建导致转圈动画重播（注释 212-213）。
- **宽度记忆**：`a.viewW`（Workspace 436-448，双击 handle 清除 544）；`a.panels` 按会话存 view/list 并限制 200 条（41-55）；`a.left`（120）、`a.folded`（Sidebar 128）、`a.panelOpen`（OutputsCard 54）。
- **悬浮左栏**：收起后 12px 感应区（globals 133），`showPeek/hidePeek` 用 220ms 延时避免手抖消失（Workspace 124-132），悬浮版 `.side.floating` 定位 fixed + `side-pop` 入场（134-139）。
- **快捷键**：Workspace 389-417；发送键两模式由设置决定（ChatPane 285-290，`sendKey`）；`SettingsModal`/`ComposerBar`/`UserMenu` 各自用 capture 阶段监听 Esc 并 `stopPropagation`（SettingsModal 44-53、ComposerBar 227-232、UserMenu 21-26），形成“最内层先关”的层级。
- **输入框自适应**：`height:0`→`min(scrollHeight,220)`，依赖里带 `isEmpty` 以便空态/对话态切换时重算（ChatPane 122-127）。
- **水合处理**：`useGreeting` 在 effect 里读 `new Date().getHours()`（ChatPane 310-317，注释说明 SSR 与浏览器时区不一致）；`CoreLogo` 只在 effect 里创建 canvas 与 rAF（66）；localStorage 读取全部放在 effect（Workspace 101、436；Sidebar 64-70；OutputsCard 44-49），因此 SSR 首帧是“展开左栏 + 默认宽度”，折叠用户会看到一次跳变。
- **减动效**：globals 983-986、1395-1399、OutputsCard.css 61-63、LoginForm.css 81-83、CoreLogo 70/131/150 均尊重 `prefers-reduced-motion`。

## 6. 全局样式与主题

- 变量清单（globals 7-31）：`--base`(底座) / `--surface`(上浮层) / `--surface-2`(右栏与卡片) / `--soft`(气泡、代码块) / `--hover` / `--active` / `--fg` / `--fg-2` / `--fg-3` / `--edge` / `--edge-hi`(内侧高光) / `--shadow-side` / `--shadow-panel` / `--shadow-card` / `--accent` / `--accent-fg` / `--danger` / `--ok` / `--font` / `--mono` / `--side-w` / `--canvas-w`；局部：`--thread-w`/`--chat-fs`(255-259)、`--ix-*`(1094-1100)、`--hl-*`(code.css 3-14)、`--font-brand`(layout 7-12)、`--stop-a`(globals 327)、`--s`(Loader3D)、`--x/--y`(Intro Tile)。
- 深色模式**两套并存**：`@media (prefers-color-scheme:dark)` 用 `:root:not([data-theme="light"])`（34-56），手动主题用 `:root[data-theme="dark"]`（57-77）——两份变量表逐行重复，改色要改两处（code.css 15-28 同样重复）。
- 主题落点：Workspace 149-153 写/删 `data-theme`（system 时删属性），155-159 写 `data-width`/`data-fs`；介绍页与 `.login-side` 还会局部覆盖 `--fg/--fg-2/--fg-3/--edge`（1005）做“永远深色的一屏”。
- 分层手法的统一约定：**不留间隙、用 1px 边线 + 内高光 + 差值投影**（注释 1-6），`--edge-hi` 只用于上浮卡片的 `inset 0 1px 0`（520、569、594、695、724）。分隔线大量用 `box-shadow` 而不是 `border`（如 `.psec + .psec` 574、`.set-group > * + *` 754、`.facts > div + div` 1378），避免影响布局尺寸。
- 类名冲突/遗留：
  - `.login-*`（1000-1085）与 LoginForm 实际使用的 `.auth-*`（LoginForm.css）是两套登录页样式，旧的一套只剩 `.login-submit` 被引用（LoginForm.tsx 89），且两处高度不同（globals 1065 `44px` vs LoginForm.css 68 `38px`）。
  - `.approve-*`（1444-1462）已被 `apd-*` 取代（ApprovalDock.css），全部无人引用。
  - `.term` 在 globals 是暖深色终端（1432-1437），ChatPane.css 21 又把它改回浅灰，两处意图相反。
  - `.lines/.line/.ln/.lc` 同时被 globals 553-557 与 code.css `.diff` 使用，行号列宽 52px vs 34px 不一致。
  - `!important` 全仓仅 1 处：`.tool-grid{box-shadow:none !important}`（globals 817），用于压掉 `.set-group > * + *` 的分隔线，属可接受的局部手段。
  - `Workspace` 里给 `.app` 加了 `left-open` 类（489），但没有任何 CSS 规则使用它（只有 `right-open`/`resizing` 被用）。

## 7. 问题清单

1. **`send()` 可能吞掉消息**（`Workspace.tsx:335-353`）：第 338 行先 `setDraft("")`，随后 `if (streaming && curIdRef.current)` 不成立、`if (!streaming) await start(...)` 也不成立时（流式已开始但 `session` 事件还没到、`curIdRef` 仍为空串），函数直接返回，用户输入被清空且未发出。
2. **左栏“项目”在收起侧栏时丢失**（`Sidebar.tsx:59` 组件内 state；`Workspace.tsx:492-500` 收起后 Sidebar 被卸载、以 `floating` 重新挂载）：已建项目列表不会保留，注释只承认“刷新就没了”（Sidebar 32、58）。
3. **悬浮左栏与固定左栏不共享折叠态以外的 UI 状态**：`folded` 有模块级缓存兜底（Sidebar 28、63-70），但 `q`（搜索词）、`menu`、`dragging` 没有；同时搜索框在 `sessions.length>8` 才渲染（210），若已输入关键字后会话数降到 8 以下，过滤仍生效却无法清空。
4. **右侧宽度拖拽的钳制在窄窗口下反转**（`Workspace.tsx:453`）：`Math.min(Math.max(w,320), innerWidth-side-380-20)` 的上界可小于 320，最终会取到上界，视口窄时右侧视图被压到不可用且无法用双击恢复（恢复值是 clamp 出来的同一个上界）。
5. **`CommandRow` 每帧拼接全部输出**（`Trace.tsx:412`）：`chunks.map(c => c.t).join("")` 在行内每次渲染（`useNow` 100ms 一次）都对整段输出做 O(n) 拷贝，长输出场景是 O(n²)。
6. **`Trace` 开关无排他**：`open` 与每行 `rows` 独立（168-176），没有“只展开一行”或一键收起全部；且 `useThrottled` 只在 `live` 时生效（197），完成后标题不再更新（可接受，但 `elapsed` 仍读 `now`）。
7. **左栏交互键盘不可达**：分组头是 `div` + onClick/onDoubleClick（`Sidebar.tsx:223`），会话行是 `div` + onClick + draggable（257-269），均无 `role`/`tabIndex`；`ChatPane` 标题改名同样是 `div onClick`（150-156）。
8. **文件视图会闪回“读取中…”**（`FileDrawer.tsx:19-33` 每次 `refreshKey` 变化先 `setRes(null)`；`Canvas.tsx:39` + `Workspace.tsx:550` 用 `messages.length` 当 refreshKey）：agent 每产出一条消息都会让正在看的大视图重建一次。
9. **面板耗时在非流式下不刷新**（`OutputsCard.tsx:78-82` 30s tick 与 `taskInfo` 192 的 `Date.now()`）：面板关闭再打开才准；“N 步”用 `real.length` 统计包含 drafts（270），与 Trace 的 `calls.length` 口径不同。
10. **设置项保存会互相踩踏**（`SettingsModal.tsx:38、61-73`）：所有防抖保存共用一个 `timer` ref，连续修改两个文本型设置时前一个 patch 的定时器被 `clearTimeout`，只保存最后一个。
11. **`SettingsModal` 的 Esc 监听每次渲染都重挂**（`SettingsModal.tsx:44-53`，依赖 `[props]` 而 props 每渲染都是新对象）。
12. **`pendingNotes` 依赖服务端原样回传 `summary`**（`Workspace.tsx:222-225` 用 `indexOf(summary)` 移除，340-342 写入的是原文）：若服务端对 summary 截断/改写，note 不会被移除，`finally` 里会当作新消息再发一次（380-384），产生重复用户消息。
13. **`apply` 无 default 分支**（`Workspace.tsx:215-308` 对应 13 种事件，`src/lib/shared.ts:110-123`）：新增事件类型会被静默丢弃，没有编译期穷尽检查。
14. **`CoreLogo` 每帧读一次计算样式**（`CoreLogo.tsx:146`）：`getComputedStyle` 在动画循环里强制样式计算；wild 路径已改为 30 帧一次（129），普通路径未同步。
15. **`Intro` 每帧 setState**（`Intro.tsx:343-350` 的 `setT(acc)`）驱动整棵 pipeline 子树（含表格与多个节点）60fps 重渲染；同类动画若扩大规模建议改成 CSS 变量或直接写 DOM。
16. 可访问性：`AskCard` 单选场景用 `role="radiogroup"` 但子项用 `aria-pressed`（36-42）；`ApprovalDock` 按钮显示 1/2/3 却没有数字键绑定（55-58）；`SettingsModal` 的 `role="dialog"` 无 `aria-modal`、无焦点陷阱（77）。
17. 死代码/重复：globals 中 `.login-*`（1000-1085，除 `.login-submit`）、`.approve-*`（1444-1462）、`.hint`（330）、`.prog`（602-609）、`.side-day`（167）无引用；`fmtK` 在 `ComposerBar.tsx:244` 与 `Connections.tsx:222` 各写一份；`sec()` 在 `Trace.tsx:670`（毫秒格式化）与 `SettingsModal.tsx:594`（毫秒→min）同名不同义；`.set-sec-head` 连写两条只差 `padding-bottom`（globals 747-748），`.avatar` 的 `box-shadow` 重复声明两次（683）。
18. 注释与实现不一致：`ChatPane.css:2` 声称“这个文件在 globals.css 之后加载”，实际起作用的只是选择器特异性（`.composer .send.stop` vs `.send.stop`）；`LoginForm.css:66` 称类名 `login-submit` 是“自动化测试靠它找按钮”，但 `package.json` 里没有任何测试依赖/脚本。
19. `iframe` 安全边界（`Canvas.tsx:129`、`FileDrawer.tsx:69`、`SvgFrame.tsx:17`）：都给了 `allow-scripts` 且未给 `allow-same-origin`（做法正确），但模型生成的 HTML/SVG 可执行任意脚本；建议在 `srcDoc` 头部注入 CSP 或显式说明这是设计取舍。