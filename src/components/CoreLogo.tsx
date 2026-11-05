"use client";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

/**
 * 动态 logo：黑白粒子球，两种密度，共用同一个动画节奏
 * （一个周期约 2.6 秒：粒子组成的球缓慢自转 → 突然不规则地散开 → 像被磁力吸回一样重新聚成球）。
 *   - variant="sparse"（默认，agent 页面左上角、登录页）：点少而大，22px 这么小也看得清
 *   - variant="particles"（介绍页）：上千个小点，适合大尺寸；小于 48px 时画成实心圆
 * 只用文字色 currentColor：浅色主题是黑，深色主题自动变白。
 * morph={false}：只自转、不散开（新对话欢迎页用），画布也不再留散开的余量。
 * wild：介绍页首屏专用的“流散—融合”动画（见 drawWild）：表面像液体一样起伏、扭转，
 *   一部分粒子像碎屑一样被一股看不见的气流带出去，再顺着同一股气流流回来，融回球面。
 *   所有运动都是位置和时间的连续函数，起止都是平滑的，没有突然的跳变；节奏也不固定。
 *
 * 画法（Canvas 2D，每帧重画）：用“斐波那契球面”在球面上均匀撒点，每帧旋转后投影到平面，
 * 近的点大而深、远的点小而淡，于是有了立体感。突变时每个点沿半径方向被噪声推开，再弹回。
 * 突变强度由“包络函数” envelope() 控制：平时是 0，突变时快速冲到 1，再像弹簧一样衰减回 0。
 */

export type CoreLogoHandle = { mutate: () => void };

const CYCLE = 2600; // 一个周期（毫秒）
const CALM = 1100; // 其中保持球体的时间，剩下的是突变 + 恢复

export function CoreLogo({
  size = 22,
  variant = "sparse",
  loop = true,
  follow = false,
  morph = true,
  wild = false,
  className,
  ref,
}: {
  size?: number;
  variant?: "sparse" | "particles";
  /** true：一直按周期突变；false：只在 mutate() 或鼠标移入时突变 */
  loop?: boolean;
  /** true：球体朝鼠标方向微微转动 */
  follow?: boolean;
  /** false：去掉散开再聚拢的变换，只保留旋转（loop 和鼠标移入都不再触发突变） */
  morph?: boolean;
  /** 介绍页首屏：更大、更不规则的碎裂—融合动画（只对 particles 且 size ≥ 120 生效） */
  wild?: boolean;
  className?: string;
  ref?: Ref<CoreLogoHandle>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  /** 本次突变开始的时间；-1 = 没在突变 */
  const burst = useRef(-1);
  const seed = useRef(Math.random() * 100);

  const mutate = () => {
    if (burst.current < 0) {
      burst.current = performance.now();
      seed.current = Math.random() * 100;
    }
  };
  useImperativeHandle(ref, () => ({ mutate }));

  // 画布比显示尺寸大一圈，给散开的粒子留位置；多出来的部分用负 margin 抵消，不影响布局
  // 不变形时只需留出点本身的半径
  const isWild = wild && variant === "particles" && size >= 120;
  const pad = !morph ? Math.ceil(size / 21) * 2 : isWild ? size * 0.6 : size * (variant === "particles" && size < 48 ? 0.35 : 0.8);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = size + pad * 2;
    el.width = Math.round(W * dpr);
    el.height = Math.round(W * dpr);
    ctx.scale(dpr, dpr);
    // 点的数量和大小：sparse 不管多大都是 42 个点（点的大小随尺寸放大），particles 点多而小
    const sparse = variant === "sparse";
    const particles = sparse ? sphere(42) : size >= 48 ? sphere(Math.round(Math.min(1400, size * size * 0.045))) : null;
    const dot = sparse ? Math.max(1, size / 21) : Math.max(0.9, size / 140);
    const spread = sparse ? 0.7 : 1; // sparse 用在侧边栏，散开范围小一点，免得盖住旁边的文字

    // 鼠标让球体倾斜：tilt 是目标角度，cur 每帧向它靠近一点（缓动）
    const tilt = { x: 0, y: 0 };
    const cur = { x: 0, y: 0 };
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      tilt.y = clamp((e.clientX - (r.left + r.width / 2)) / 600, -1, 1) * 0.5;
      tilt.x = clamp((e.clientY - (r.top + r.height / 2)) / 600, -1, 1) * -0.4;
    };
    if (follow) window.addEventListener("pointermove", onMove);

    let raf = 0;
    let visible = true;
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(draw);
    });
    io.observe(el);

    // wild 模式：下一次流散开始的时间；文字色缓存起来，不必每帧都读样式
    const wildState = isWild && particles ? createWild(particles) : null;
    let nextWild = performance.now() + 600;
    let wildInk = getComputedStyle(el).color;
    let frame = 0;

    const start = performance.now();
    let fired = -1; // 已经触发过突变的周期序号，保证每个周期只触发一次
    function draw(now: number) {
      raf = 0;
      const t = (now - start) / 1000;
      const n = Math.floor((now - start) / CYCLE);
      if (wildState) {
        // 节奏不固定：每次碎裂结束后，随机停 0.9–1.8 秒再来下一次
        if (loop && !reduce && burst.current < 0 && now >= nextWild) {
          mutate();
        }
        let p = -1;
        if (burst.current >= 0) {
          p = (now - burst.current) / WILD_MS;
          if (p >= 1) {
            burst.current = -1;
            p = -1;
            nextWild = now + 700 + Math.random() * 1100;
          }
        }
        cur.x += (tilt.x - cur.x) * 0.06;
        cur.y += (tilt.y - cur.y) * 0.06;
        ctx!.clearRect(0, 0, W, W);
        if (++frame % 30 === 0) wildInk = getComputedStyle(el!).color; // 每 30 帧读一次，切换深浅色也能跟上
        drawWild(ctx!, particles!, wildState, W, size / 2, t, p, seed.current, cur, wildInk, dot);
        if (visible && !reduce) raf = requestAnimationFrame(draw);
        return;
      }
      if (morph && loop && !reduce && n !== fired && (now - start) % CYCLE >= CALM) {
        fired = n;
        mutate();
      }
      let amp = 0;
      if (burst.current >= 0) {
        const p = (now - burst.current) / (CYCLE - CALM);
        if (p >= 1) burst.current = -1;
        else amp = envelope(p);
      }
      cur.x += (tilt.x - cur.x) * 0.06;
      cur.y += (tilt.y - cur.y) * 0.06;
      const ink = getComputedStyle(el!).color; // 每帧读：切换深浅色主题时立即跟着变
      ctx!.clearRect(0, 0, W, W);
      if (particles) drawParticles(ctx!, particles, W, size / 2 - (sparse ? dot : 0), t, amp * spread, seed.current, cur, ink, dot);
      else drawSolid(ctx!, W, size / 2, t, amp, seed.current, ink);
      if (visible && !reduce) raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener("pointermove", onMove);
    };
  }, [size, pad, variant, loop, follow, morph, isWild]);

  return (
    <span className={`core-logo ${className ?? ""}`} style={{ width: size, height: size }} onPointerEnter={loop || !morph ? undefined : mutate}>
      <canvas ref={canvas} aria-hidden style={{ width: size + pad * 2, height: size + pad * 2, margin: -pad }} />
    </span>
  );
}

/** 突变强度随时间的变化：0→1 很快（前 12%），然后弹簧式衰减回 0 */
function envelope(p: number) {
  const rise = 0.12;
  if (p < rise) return 1 - (1 - p / rise) ** 3;
  const x = (p - rise) / (1 - rise);
  return Math.exp(-3.6 * x) * Math.cos(x * Math.PI * 2.6) * (1 - x);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 斐波那契球面：在单位球面上撒 n 个几乎均匀分布的点 */
function sphere(n: number) {
  const pts: { x: number; y: number; z: number; k: number }[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const a = golden * i;
    pts.push({ x: Math.cos(a) * r, y, z: Math.sin(a) * r, k: Math.random() });
  }
  return pts;
}

/** 三维噪声的简化版：几条不同方向的正弦叠加，足够做出“不规则”的形变 */
function noise3(x: number, y: number, z: number, t: number, s: number) {
  return (
    Math.sin(x * 3.1 + y * 1.7 + s + t * 1.9) * 0.5 +
    Math.sin(y * 4.3 - z * 2.9 + s * 1.3 - t * 2.6) * 0.3 +
    Math.sin(z * 5.7 + x * 2.3 + s * 0.7 + t * 3.3) * 0.2
  );
}

function drawParticles(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number; z: number; k: number }[],
  W: number,
  R: number,
  t: number,
  amp: number,
  s: number,
  tilt: { x: number; y: number },
  ink: string,
  dot: number, // 点的基准半径（px）
) {
  const c = W / 2;
  const ry = t * 0.35 + tilt.y; // 绕竖轴自转 + 鼠标带来的偏转
  const rx = 0.35 + tilt.x; // 稍微俯视，能看到球的顶部
  const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
  ctx.fillStyle = ink;
  for (const p of pts) {
    // 散开范围：噪声最多推出 0.95R，再加每个点自己的随机量，最远约到 2.4 倍半径；向内最多缩到 0.25，避免穿过球心
    const d = Math.max(0.25, 1 + amp * (0.95 * noise3(p.x, p.y, p.z, t, s) + 0.75 * (p.k - 0.25) * Math.abs(amp)));
    const x = p.x * d, y = p.y * d, z = p.z * d;
    // 旋转：先绕 y 轴，再绕 x 轴
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const y1 = y * cx - z1 * sx;
    const z2 = y * sx + z1 * cx;
    const depth = (z2 + 1.6) / 3.2; // 0（最远）～1（最近）
    ctx.globalAlpha = 0.12 + depth * 0.88;
    ctx.beginPath();
    ctx.arc(c + x1 * R, c + y1 * R, dot * (0.55 + depth * 0.75), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** 粒子球的小尺寸版本：实心圆，突变时轮廓像液体一样起伏 */
function drawSolid(ctx: CanvasRenderingContext2D, W: number, R: number, t: number, amp: number, s: number, ink: string) {
  const c = W / 2;
  ctx.beginPath();
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    const r = R * (1 + amp * 0.22 * noise3(Math.cos(a), Math.sin(a), 0, t * 2, s));
    if (i === 0) ctx.moveTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    else ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fillStyle = ink;
  ctx.fill();
}

/* ================= wild：流散—融合 ================= */

const WILD_MS = 3400; // 一次流散 + 融合的时长（慢一点才丝滑）
const BUCKETS = 10; // 按深浅把点分成 10 组，每组一次性画完（见 drawWild）

type Pt = { x: number; y: number; z: number; k: number };

/**
 * 每个点预先算好的固定属性：
 *   lag  —— 开始运动的先后（0–0.3）。由点在球面上的位置决定（平滑的噪声），
 *           所以相邻的点几乎同时动，运动像波一样从球的一侧传到另一侧，而不是所有点一起跳；
 *   dust —— 是不是“碎屑”（约三成的点）以及碎屑飞出去的远近，碎屑会被气流带离球面再流回来。
 */
function createWild(pts: Pt[]) {
  const n = pts.length;
  const lag = new Float32Array(n);
  const dust = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const q = pts[i];
    lag[i] = 0.15 + 0.15 * noise3(q.x * 0.8, q.y * 0.8, q.z * 0.8, 0, 7.3);
    dust[i] = q.k > 0.7 ? 0.35 + ((q.k - 0.7) / 0.3) * 0.75 : 0;
  }
  return { lag, dust, X: new Float32Array(n), Y: new Float32Array(n), B: new Uint8Array(n), S: new Float32Array(n) };
}

/** 强度曲线：sin² —— 从 0 平滑升到 1 再平滑落回 0，起点和终点的速度都是 0，所以开始和结束都不会“顿”一下 */
const ease = (x: number) => (x <= 0 || x >= 1 ? 0 : Math.sin(Math.PI * x) ** 2);

function drawWild(
  ctx: CanvasRenderingContext2D,
  pts: Pt[],
  w: ReturnType<typeof createWild>,
  W: number,
  R: number,
  t: number,
  p: number, // 本次流散的进度 0–1；-1 = 平静
  s: number,
  tilt: { x: number; y: number },
  ink: string,
  dot: number,
) {
  const c = W / 2;
  const ry = t * 0.28 + tilt.y, rx = 0.35 + tilt.x;
  const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
  const n = pts.length;
  const { X, Y, B, S } = w;
  const tt = t * 0.55; // 气流随时间缓慢变化

  for (let i = 0; i < n; i++) {
    const q = pts[i];
    const a = p < 0 ? 0 : ease((p - w.lag[i]) / 0.7);
    // 1) 液体表面：平静时轻轻呼吸，流散时起伏变大（低频噪声 → 大块、柔和的鼓起和凹陷）
    const swell = 0.03 * noise3(q.x, q.y, q.z, tt, s) + a * 0.26 * noise3(q.x * 0.9, q.y * 0.9, q.z * 0.9, tt, s + 3.1);
    let x = q.x * (1 + swell), y = q.y * (1 + swell), z = q.z * (1 + swell);
    if (a > 0) {
      // 2) 扭转：越靠上、越靠下转得越多方向相反，整个球像被拧了一下
      const tw = a * 0.55 * q.y;
      const ct = Math.cos(tw), st = Math.sin(tw);
      const x0 = x;
      x = x0 * ct + z * st;
      z = -x0 * st + z * ct;
      // 3) 碎屑：沿“半径 + 一股平滑的气流”飞出去。气流方向由噪声场给出，相邻碎屑方向相近，
      //    所以它们是一缕一缕地飘出去，而不是四散乱飞；a 回到 0 时沿原路流回球面
      const d = w.dust[i];
      if (d > 0) {
        const f = a * d;
        const fx = noise3(q.y, q.z, q.x, tt, s + 11);
        const fy = noise3(q.z, q.x, q.y, tt, s + 23);
        const fz = noise3(q.x, q.z, q.y, tt, s + 37);
        x += (q.x * 0.7 + fx * 0.6) * f;
        y += (q.y * 0.7 + fy * 0.6) * f;
        z += (q.z * 0.7 + fz * 0.6) * f;
      }
    }
    const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    const y1 = y * cx - z1 * sx, z2 = y * sx + z1 * cx;
    X[i] = c + x1 * R;
    Y[i] = c + y1 * R;
    const depth = Math.min(1, Math.max(0, (z2 + 1.6) / 3.2));
    B[i] = Math.min(BUCKETS - 1, Math.floor(depth * BUCKETS));
    // 飞出去的碎屑稍微变小，看起来更“碎”
    S[i] = dot * (0.5 + depth * 0.8) * (1 - 0.35 * (w.dust[i] > 0 ? a : 0));
  }

  // 按深浅分组批量绘制：每组只设置一次透明度、只调用一次 fill()。
  // 一千多个点逐个 fill 会让每帧多出上千次绘制调用，这是之前卡顿的主要原因
  ctx.fillStyle = ink;
  for (let b = 0; b < BUCKETS; b++) {
    ctx.globalAlpha = 0.12 + ((b + 0.5) / BUCKETS) * 0.88;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (B[i] !== b) continue;
      ctx.moveTo(X[i] + S[i], Y[i]);
      ctx.arc(X[i], Y[i], S[i], 0, Math.PI * 2);
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
