"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CoreLogo, type CoreLogoHandle } from "./CoreLogo";

/**
 * 介绍页 /A.ai（客户端组件，因为有动画和滚动互动）。
 *
 * 结构（从上到下）：
 *   1. 首屏：粒子球（流散—融合）+ 四角的定位标记 + 逐字出现的标题 + 状态行
 *   2. 工具跑马灯：工具名无限横向滚动
 *   3. 工作方式：一整段连贯的动画（Pipeline）——输入 → Agent 链路 → 成果，三栏用流动的连线串起来
 *   4. 能力：bento 格子，鼠标经过时边框有一圈跟着走的光
 *   5. 数字：进入视口时从 0 数到目标值
 *   6. 宣言：随滚动逐字变清楚
 *   7. 部署 + 结尾 + 页脚
 * 视觉：黑白灰；背景是一层渐隐的点阵网格 + 颗粒噪点；小标签用等宽字体（科技感）；圆角 10–14px，不加多余边框。
 */

export function Intro({ user }: { user: string | null }) {
  const root = useRef<HTMLDivElement>(null);
  const orb = useRef<CoreLogoHandle>(null);

  // 滚动淡入：元素进入视口时加上 .in
  useEffect(() => {
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add("in");
          io.unobserve(e.target);
        }),
      { root: root.current, threshold: 0.15, rootMargin: "0px 0px -40px 0px" },
    );
    root.current?.querySelectorAll(".reveal").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div className="intro" ref={root}>
      <header className="ix-nav">
        <Link className="ix-brand" href="/A.ai">
          <CoreLogo size={20} />
          A.ai
        </Link>
        <nav className="ix-links">
          <a href="#how">工作方式</a>
          <a href="#ability">能力</a>
          <a href="#deploy">部署</a>
        </nav>
        <div className="ix-nav-end">
          <Link className="ix-ghost" href={user ? "/A.ai/chat" : "/login"}>
            {user ?? "登录"}
          </Link>
          <Link className="ix-btn small" href="/A.ai/chat">
            开始使用
          </Link>
        </div>
      </header>

      <main>
        {/* ---------- 1. 首屏 ---------- */}
        <section className="ix-hero">
          <div className="ix-grid-bg" aria-hidden />
          <div className="ix-orb-wrap">
            {/* 四角的定位标记 + 坐标小字：像取景框一样框住粒子球 */}
            <i className="ix-corner tl" />
            <i className="ix-corner tr" />
            <i className="ix-corner bl" />
            <i className="ix-corner br" />
            <span className="ix-coord l">A.AI / CORE</span>
            <span className="ix-coord r">v0.1 · 2026</span>
            <button className="ix-orb" onClick={() => orb.current?.mutate()} aria-label="A.ai">
              <CoreLogo variant="particles" ref={orb} size={280} follow wild />
            </button>
          </div>
          <div className="ix-status reveal">
            <i />
            在线 · 14 个工具 · 自动修复 · 长期记忆
          </div>
          <h1 className="ix-title">
            <SplitText text="说出任务，" delay={0.2} />
            <SplitText text="直接拿结果。" delay={0.55} />
          </h1>
          <p className="ix-lead reveal">它会自己拆解步骤、调用工具、写代码并运行，把文档、网页和表格交到你手上。</p>
          <div className="ix-actions reveal">
            <Link className="ix-btn" href="/A.ai/chat">
              开始使用 <Arrow />
            </Link>
            <a className="ix-ghost" href="#how">
              看它怎么工作
            </a>
          </div>
          <div className="ix-scroll" aria-hidden>
            <i />
          </div>
        </section>

        {/* ---------- 2. 工具跑马灯 ---------- */}
        <div className="marquee" aria-hidden>
          <div className="marquee-track">
            {[0, 1].map((k) => (
              <div key={k}>
                {["web_search", "web_fetch", "run_python", "run_command", "glob", "grep", "read_file", "edit_file", "write_file", "todo_write", "calculator", "create_artifact"].map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* ---------- 3. 工作方式 ---------- */}
        <section className="ix-section" id="how">
          <Heading n="01" kicker="工作方式" title="从一句话，到一份成果。" />
          <Pipeline />
        </section>

        {/* ---------- 4. 能力 ---------- */}
        <section className="ix-section" id="ability">
          <Heading n="02" kicker="能力" title="会想，也会动手。" />
          <div className="bento">
            <Tile className="wide" title="并行调用" text="互不依赖的事同时做。三次网页抓取，只等一次的时间。">
              <div className="viz-par">
                {["web_fetch · 新闻", "web_fetch · 股价", "web_fetch · 天气"].map((l, i) => (
                  <div key={l} className="viz-bar" style={{ "--d": `${i * 0.12}s` } as React.CSSProperties}>
                    <span>{l}</span>
                    <i />
                  </div>
                ))}
              </div>
            </Tile>
            <Tile title="写代码，并运行" text="不只是给你代码，而是跑出结果。">
              <pre className="viz-term">
                <span>{"$ python main.py"}</span>
                <span>{"[0, 1, 1, 2, 3, 5, 8, 13]"}</span>
                <span className="dim">{"sum = 33"}</span>
              </pre>
            </Tile>
            <Tile title="出错会自己修" text="运行报错时读懂报错、改代码、再运行。">
              <div className="viz-fix">
                <span className="bad">NameError: name 'fib' is not defined</span>
                <span className="good">修复后运行通过</span>
              </div>
            </Tile>
            <Tile title="记得你" text="你的习惯、它犯过的错，都会记下来，下次不再重复。">
              <div className="viz-chips">
                <span>用中文回答</span>
                <span>先给结论</span>
                <span>表格优先</span>
              </div>
            </Tile>
            <Tile title="成果直接交付" text="文档、网页、代码在右侧直接预览，可以复制，也可以下载。">
              <div className="viz-doc">
                <div className="viz-doc-head">复利表.md</div>
                {[100, 82, 92, 64].map((w, i) => (
                  <i key={i} style={{ width: `${w}%`, animationDelay: `${i * 0.15}s` }} />
                ))}
              </div>
            </Tile>
          </div>
        </section>

        {/* ---------- 5. 数字 ---------- */}
        <section className="stats">
          <Stat value={14} label="内置工具" />
          <Stat value={3} label="轮自动修复" />
          <Stat value={60} label="帧流式渲染" suffix="fps" />
          <Stat value={1} label="条命令部署" />
        </section>

        {/* ---------- 6. 宣言 ---------- */}
        <Manifesto text="没有多余的按钮，也没有复杂的设置。只有一个输入框，和你要的结果。" root={root} />

        {/* ---------- 7. 部署 ---------- */}
        <section className="ix-section" id="deploy">
          <Heading n="03" kicker="部署" title="安静地运行在你自己的机器上。" />
          <div className="facts reveal">
            {[
              ["01", "各自独立", "每个账号的对话、文件和设置互不相见。"],
              ["02", "有边界地执行", "代码只在限定的目录里运行，超时就停下，内网地址一律不碰。"],
              ["03", "轻装部署", "一个容器就能跑起来；模型由你挑选，随时可以换。"],
            ].map(([n, t, d]) => (
              <div key={n}>
                <span className="facts-n">{n}</span>
                <h3>{t}</h3>
                <p>{d}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="ix-end reveal">
          <div className="ix-grid-bg" aria-hidden />
          <h2>现在就开始。</h2>
          <p>说出你的第一个任务。</p>
          <Link className="ix-btn" href="/A.ai/chat">
            开始使用 <Arrow />
          </Link>
        </section>
      </main>

      <footer className="ix-foot">
        <span className="ix-brand small">
          <CoreLogo size={16} />
          A.ai
        </span>
        <span className="mono">BUILT FOR FOCUS</span>
        <span>© 2026</span>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Arrow() {
  return (
    <svg className="ix-arrow" width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 标题逐字出现：每个字从下方、模糊状态浮上来，依次错开 40ms */
function SplitText({ text, delay = 0 }: { text: string; delay?: number }) {
  return (
    <span className="split" aria-label={text}>
      {Array.from(text).map((ch, i) => (
        <span key={i} aria-hidden style={{ animationDelay: `${delay + i * 0.04}s` }}>
          {ch}
        </span>
      ))}
    </span>
  );
}

function Heading({ n, kicker, title }: { n: string; kicker: string; title: string }) {
  return (
    <div className="ix-head reveal">
      <span className="ix-eyebrow">
        <b>{n}</b> / {kicker}
      </span>
      <h2>{title}</h2>
    </div>
  );
}

/** 格子：鼠标位置写进 --x / --y，CSS 用它画一圈跟着鼠标走的边框高光 */
function Tile({ title, text, className, children }: { title: string; text: string; className?: string; children: React.ReactNode }) {
  return (
    <div
      className={`tile-x reveal ${className ?? ""}`}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty("--x", `${e.clientX - r.left}px`);
        e.currentTarget.style.setProperty("--y", `${e.clientY - r.top}px`);
      }}
    >
      <div className="tile-viz">{children}</div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

/** 数字：进入视口后 1.2 秒内从 0 数到目标值（缓出曲线，越接近越慢） */
function Stat({ value, label, suffix }: { value: number; label: string; suffix?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const t0 = performance.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / 1200);
        setN(Math.round(value * (1 - (1 - p) ** 3)));
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }, { threshold: 0.6 });
    io.observe(el);
    return () => (io.disconnect(), cancelAnimationFrame(raf));
  }, [value]);
  return (
    <div className="stat" ref={ref}>
      <div className="stat-v">
        {n}
        {suffix && <small>{suffix}</small>}
      </div>
      <div className="stat-l">{label}</div>
    </div>
  );
}

/* ---------------- 工作方式：一整段连贯的动画 ---------------- */

/**
 * 一条 13 秒的时间线，所有画面都由同一个时间 t 算出来（不是几张画面来回切换），所以动作是连贯的：
 *   0.6–2.4s  左栏输入框里逐字打出任务
 *   2.6s      发送：任务变成气泡；一个光点沿左边的连线流向中间
 *   3.2–8.6s  中栏 Agent 链路：理解 → 规划 → 执行（三个工具依次转圈、打勾）→ 交付，竖线跟着一点点画出来
 *   8.8–9.6s  光点沿右边的连线流向右栏
 *   9.6s 起   右栏成果展开：表格逐行出现，合计数字从 0 数到 16,288.95
 *   12.2–13s  整体淡出，从头再来
 * 底部的进度轨道显示当前在哪个阶段。只在进入视口时播放。
 */
const LOOP = 13000;
const ASK = "把 10000 元按年利率 5% 复利算 10 年，做成表格";
const NODES = [
  { name: "理解", at: 3200, detail: "本金 10000 · 年利率 5% · 10 年" },
  { name: "规划", at: 4200, detail: "计算 → 生成明细 → 整理成表格" },
  { name: "执行", at: 5400, detail: "" },
  { name: "交付", at: 8400, detail: "复利表.md" },
];
const TOOLS = [
  { name: "calculator", at: 5600, out: "16288.95" },
  { name: "run_python", at: 6600, out: "10 行明细" },
  { name: "create_artifact", at: 7600, out: "复利表.md" },
];
const ROWS: [string, string][] = [
  ["1", "10,500.00"],
  ["3", "11,576.25"],
  ["5", "12,762.82"],
  ["8", "14,774.55"],
  ["10", "16,288.95"],
];
const seg = (t: number, a: number, b: number) => Math.min(1, Math.max(0, (t - a) / (b - a)));
const easeOut = (x: number) => 1 - (1 - x) ** 3;

function Pipeline() {
  const box = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setT(11000);
    let raf = 0, visible = false, last = 0, acc = 0;
    const tick = (now: number) => {
      raf = 0;
      if (!visible) return;
      acc = (acc + Math.min(50, now - (last || now))) % LOOP; // 切到后台再回来不会一下子跳很远
      last = now;
      setT(acc);
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      last = 0;
      if (visible && !raf) raf = requestAnimationFrame(tick);
    }, { threshold: 0.25 });
    io.observe(el);
    return () => (io.disconnect(), cancelAnimationFrame(raf));
  }, []);

  const fade = 1 - seg(t, 12200, 13000); // 结尾淡出
  const typed = Math.floor(seg(t, 600, 2400) * ASK.length);
  const sent = t >= 2600;
  const chain = seg(t, 3200, 8600); // 中栏竖线画到哪
  const art = easeOut(seg(t, 9600, 10400));
  const total = 16288.95 * easeOut(seg(t, 9900, 11000));
  const phase = t < 3200 ? 0 : t < 8800 ? 1 : 2;

  return (
    <div className="pipe reveal" ref={box}>
      <div className="pipe-stage" style={{ opacity: Math.min(fade, 0.15 + seg(t, 0, 500) * 0.85) }}>
        {/* 左栏：输入 */}
        <div className={`pipe-col ${phase === 0 ? "on" : ""}`}>
          <div className="pipe-label">INPUT</div>
          <div className="pipe-in">
            {sent && <div className="pipe-bubble">{ASK}</div>}
            <div className="pipe-input">
              <span>
                {sent ? <em>输入任务…</em> : ASK.slice(0, typed)}
                {!sent && <i className="demo-caret" />}
              </span>
              <b className={sent ? "" : typed === ASK.length ? "ready" : ""}>
                <Arrow />
              </b>
            </div>
          </div>
        </div>

        <Wire progress={seg(t, 2600, 3200)} />

        {/* 中栏：Agent 链路 */}
        <div className={`pipe-col mid ${phase === 1 ? "on" : ""}`}>
          <div className="pipe-label">AGENT</div>
          <div className="pipe-chain">
            <i className="pipe-rail" style={{ transform: `scaleY(${chain})` }} />
            {NODES.map((n, k) => {
              const on = t >= n.at;
              const done = k < NODES.length - 1 ? t >= NODES[k + 1].at : t >= 8600;
              return (
                <div key={n.name} className={`pipe-node ${on ? "on" : ""} ${done ? "done" : ""}`}>
                  <span className="pipe-dot" />
                  <div>
                    <div className="pipe-name">{n.name}</div>
                    {n.detail && <div className="pipe-detail">{n.detail}</div>}
                    {k === 2 && (
                      <div className="pipe-tools">
                        {TOOLS.map((tl, j) => {
                          const st = t < tl.at ? "" : t < (TOOLS[j + 1]?.at ?? 8400) - 200 ? "run" : "ok";
                          return (
                            <div key={tl.name} className={`pipe-tool ${st}`}>
                              <code>{tl.name}</code>
                              <span>{st === "ok" ? tl.out : ""}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <Wire progress={seg(t, 8800, 9600)} />

        {/* 右栏：成果 */}
        <div className={`pipe-col ${phase === 2 ? "on" : ""}`}>
          <div className="pipe-label">OUTPUT</div>
          {art < 1 && <div className="pipe-wait" style={{ opacity: 1 - art }}>AWAITING OUTPUT</div>}
          <div className="pipe-art" style={{ opacity: art, transform: `translateY(${(1 - art) * 12}px) scale(${0.97 + art * 0.03})` }}>
            <div className="pipe-art-head">
              <span>复利表.md</span>
              <span className="mono">{total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
            <table>
              <tbody>
                {ROWS.map((r, k) => {
                  const o = seg(t, 10000 + k * 160, 10300 + k * 160);
                  return (
                    <tr key={r[0]} style={{ opacity: o, transform: `translateX(${(1 - o) * 8}px)` }}>
                      <td>第 {r[0]} 年</td>
                      <td>{r[1]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 进度轨道：三个阶段 + 一根随时间走的细线 */}
      <div className="pipe-track">
        <i style={{ transform: `scaleX(${t / LOOP})` }} />
        {["输入", "执行", "交付"].map((l, k) => (
          <span key={l} className={phase === k ? "on" : phase > k ? "past" : ""}>
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 两栏之间的连线：一根细线 + 一个沿线流动的光点（progress 0→1） */
function Wire({ progress }: { progress: number }) {
  return (
    <div className="wire" aria-hidden>
      <i className="wire-line" />
      <i className="wire-flow" style={{ left: `${progress * 100}%`, opacity: progress > 0 && progress < 1 ? 1 : 0 }} />
    </div>
  );
}

/* ---------------- 宣言：随滚动逐字变清楚 ---------------- */

/**
 * 把一段话拆成单个字，每个字的透明度由“这段话在视口里滚动到了哪里”决定：
 * 刚进入视口时全部很淡，滚到视口中间时全部变清楚，像被一个字一个字读出来。
 * 滚动容器是 .intro（不是 window），所以监听它的 scroll。
 */
function Manifesto({ text, root }: { text: string; root: React.RefObject<HTMLDivElement | null> }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const sc = root.current;
    const el = ref.current;
    if (!sc || !el) return;
    const chars = [...el.querySelectorAll<HTMLSpanElement>("span")];
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // 段落顶部在视口 85% 处时为 0，段落底部到视口 55% 处时为 1
      const p = Math.min(1, Math.max(0, (vh * 0.85 - r.top) / (r.height + vh * 0.3)));
      const lit = p * chars.length;
      chars.forEach((c, k) => (c.style.opacity = String(0.14 + 0.86 * Math.min(1, Math.max(0, lit - k)))));
    };
    const onScroll = () => !raf && (raf = requestAnimationFrame(update));
    update();
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      sc.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [root]);
  return (
    <section className="ix-manifesto">
      <p ref={ref} aria-label={text}>
        {Array.from(text).map((ch, k) => (
          <span key={k} aria-hidden>
            {ch}
          </span>
        ))}
      </p>
    </section>
  );
}
