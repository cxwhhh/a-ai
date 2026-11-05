"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { DEFAULT_SETTINGS, modelOptions, type Settings, type UsageStats } from "@/lib/settings";
import type { ToolInfo, UserMemory } from "@/lib/shared";
import { Avatar, type SettingsTab } from "./UserMenu";
import { Connections } from "./Connections";
import { SandboxPane } from "./SandboxPane";
import { SkillsPane } from "./SkillsPane";
import { IChart, IChip, IGear, IInfo, IKeyboard, ISpark, IThink, IX } from "./Icons";

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "通用", icon: <IGear /> },
  { id: "model", label: "模型", icon: <IChip /> },
  { id: "memory", label: "记忆", icon: <IThink /> },
  { id: "skills", label: "技能", icon: <ISpark /> },
  { id: "usage", label: "用量", icon: <IChart /> },
  { id: "keys", label: "快捷键", icon: <IKeyboard /> },
  { id: "about", label: "关于", icon: <IInfo /> },
];

/**
 * 设置弹窗：左侧标签页，右侧内容（内容区最宽 680px，居中，像一页文档）。
 * 每一页分成几个小节（Section）：小节标题 + 一组设置行，行与行之间一条细线。
 * 改动即时保存（文本框停止输入 500ms 后保存），右上角显示“已保存”。
 */
export function SettingsModal(props: {
  tab: SettingsTab;
  settings: Settings;
  model: string;
  tools: ToolInfo[];
  modKey: string;
  onTab(t: SettingsTab): void;
  onChange(s: Settings): void;
  onClose(): void;
}) {
  const { settings: s, modKey } = props;
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const [defaultPrompt, setDefaultPrompt] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.settings().then((r) => setDefaultPrompt(r.defaultSystemPrompt)).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props]);

  const flash = () => {
    setSaved("saved");
    setTimeout(() => setSaved("idle"), 1500);
  };

  /** 本地先更新（界面立即生效），再保存到服务端；debounce 用于文本输入 */
  const update = (patch: Partial<Settings>, debounce = 0) => {
    props.onChange({ ...s, ...patch });
    if (timer.current) clearTimeout(timer.current);
    setSaved("saving");
    timer.current = setTimeout(async () => {
      try {
        props.onChange(await api.saveSettings(patch));
        flash();
      } catch {
        setSaved("idle");
      }
    }, debounce);
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-label="设置">
        <nav className="modal-nav">
          <div className="modal-nav-title">设置</div>
          {TABS.map((t) => (
            <button key={t.id} className={`modal-tab ${props.tab === t.id ? "on" : ""}`} onClick={() => props.onTab(t.id)}>
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </nav>

        <section className="modal-main">
          <header className="modal-head">
            <span className={`save-state ${saved}`}>{saved === "saving" ? "保存中…" : saved === "saved" ? "已保存" : ""}</span>
            <button className="icon-btn" onClick={props.onClose} title="关闭 Esc">
              <IX />
            </button>
          </header>

          <div className="modal-body">
            <div className="set-page">
              <h2 className="set-title">{TABS.find((t) => t.id === props.tab)?.label}</h2>

              {props.tab === "general" && (
                <>
                  <Section title="个人资料">
                    <Row label="名称" hint="显示在左下角和欢迎语里">
                      <div className="set-inline">
                        <Avatar name={s.name} size={28} />
                        <input className="set-input" value={s.name} maxLength={32} onChange={(e) => update({ name: e.target.value }, 500)} />
                      </div>
                    </Row>
                  </Section>

                  <Section title="外观">
                    <div className="set-block">
                      <div className="set-label">主题</div>
                      <div className="theme-cards">
                        {(
                          [
                            ["light", "浅色"],
                            ["dark", "深色"],
                            ["system", "跟随系统"],
                          ] as const
                        ).map(([v, l]) => (
                          <button key={v} className={`theme-card ${s.theme === v ? "on" : ""}`} onClick={() => update({ theme: v })}>
                            <span className={`theme-mock ${v}`}>
                              <i />
                              <b />
                              <b />
                            </span>
                            <span>{l}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <Row label="对话宽度" hint="对话内容占中间区域的比例：窄 40%、标准 50%、宽 70%">
                      <Seg
                        value={s.chatWidth}
                        options={[
                          ["narrow", "窄"],
                          ["normal", "标准"],
                          ["wide", "宽"],
                        ]}
                        onChange={(v) => update({ chatWidth: v as Settings["chatWidth"] })}
                      />
                    </Row>
                    <Row label="字体大小" hint="对话内容和输入框的字号">
                      <Seg
                        value={s.fontSize}
                        options={[
                          ["small", "小"],
                          ["normal", "标准"],
                          ["large", "大"],
                        ]}
                        onChange={(v) => update({ fontSize: v as Settings["fontSize"] })}
                      />
                    </Row>
                    {/* 预览：用和对话区一样的变量，改了立刻看到效果 */}
                    <div className="set-preview">
                      <div className="set-preview-thread">
                        <div className="bubble">帮我把这段代码改成异步的</div>
                        <p>好的。下面把读取文件改成 await，并给调用方加上 async，其余逻辑保持不变。</p>
                      </div>
                    </div>
                    <Row label="左栏字号" hint="左边栏里的文字：新建、搜索、项目、分组、对话名等（logo 不变）">
                      <Seg
                        value={s.sideFontSize}
                        options={[
                          ["small", "小"],
                          ["normal", "标准"],
                          ["large", "大"],
                          ["xlarge", "特大"],
                        ]}
                        onChange={(v) => update({ sideFontSize: v as Settings["sideFontSize"] })}
                      />
                    </Row>
                  </Section>

                  <Section title="使用习惯">
                    <Row label="发送方式" hint={s.sendKey === "enter" ? "Enter 发送，Shift+Enter 换行" : `${modKey}Enter 发送，Enter 换行`}>
                      <Seg
                        value={s.sendKey}
                        options={[
                          ["enter", "Enter"],
                          ["mod-enter", `${modKey}Enter`],
                        ]}
                        onChange={(v) => update({ sendKey: v as Settings["sendKey"] })}
                      />
                    </Row>
                    <Row label="自动打开产出" hint="生成网页、文档、代码后自动在右侧打开">
                      <Toggle on={s.autoOpen} onChange={(v) => update({ autoOpen: v })} />
                    </Row>
                  </Section>
                </>
              )}

              {props.tab === "model" && (
                <>
                  <Section title="当前模型">
                    <Row label="对话使用的模型" hint="也可以在输入框下方随时切换">
                      <select className="set-input select" value={s.currentModel} onChange={(e) => update({ currentModel: e.target.value })}>
                        {Object.entries(groupBy(modelOptions(s), (o) => o.group)).map(([g, opts]) => (
                          <optgroup key={g} label={g}>
                            {opts.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </Row>
                  </Section>

                  <Section title="模型连接" hint="填写 API 地址和 Key 接入 DeepSeek、OpenAI、Kimi、Ollama 等 OpenAI 兼容服务。Key 只保存在服务器上。">
                    <div className="set-block">
                      <Connections
                        connections={s.connections}
                        currentModel={s.currentModel}
                        onSave={async (connections, currentModel) => {
                          props.onChange(await api.saveSettings(currentModel ? { connections, currentModel } : { connections }));
                          flash();
                        }}
                      />
                    </div>
                  </Section>

                  <Section title="Agent 运行">
                    <Row label="最大步数" hint="一轮对话最多调用模型几次，防止无限循环">
                      <Stepper value={s.maxSteps} min={1} max={100} onChange={(v) => update({ maxSteps: v }, 400)} />
                    </Row>
                    <Row label="自动修复轮数" hint="代码运行报错时，把报错发回模型修改再运行；0 表示关闭">
                      <Stepper value={s.maxFixRounds} min={0} max={10} onChange={(v) => update({ maxFixRounds: v }, 400)} />
                    </Row>
                    <Row
                      label="命令确认"
                      hint={
                        s.commandApproval === "ask"
                          ? "每条终端命令都先问你"
                          : s.commandApproval === "auto"
                            ? "终端命令都直接运行（危险命令仍会被拒绝）。只建议在沙箱里这样用"
                            : "ls、cat、grep 这类只读命令直接运行，其余先问你"
                      }
                    >
                      <Seg
                        value={s.commandApproval}
                        options={[
                          ["ask", "每次询问"],
                          ["readonly", "只读自动"],
                          ["auto", "全部自动"],
                        ]}
                        onChange={(v) => update({ commandApproval: v as Settings["commandApproval"] })}
                      />
                    </Row>
                  </Section>

                  <SandboxPane />

                  <Section title="可用工具" hint={`${props.tools.length} 个，模型会按需调用`}>
                    <div className="tool-grid">
                      {props.tools.map((t) => (
                        <div key={t.name} className="tool-cell" title={t.description}>
                          <div className="mono">{t.name}</div>
                          <div className="tool-cell-desc">{firstSentence(t.description)}</div>
                        </div>
                      ))}
                    </div>
                  </Section>
                </>
              )}

              {props.tab === "memory" && (
                <MemoryPane
                  enabled={s.memory}
                  onEnabled={(v) => update({ memory: v })}
                  systemPrompt={s.systemPrompt}
                  defaultPrompt={defaultPrompt}
                  onSystemPrompt={(v, d) => update({ systemPrompt: v }, d)}
                />
              )}

              {props.tab === "skills" && (
                <SkillsPane
                  enabled={s.skills}
                  autoEnable={s.skillAutoEnable}
                  onEnabled={(v) => update({ skills: v })}
                  onAutoEnable={(v) => update({ skillAutoEnable: v })}
                />
              )}

              {props.tab === "usage" && <UsagePane />}

              {props.tab === "keys" && (
                <Section title="键盘快捷键">
                  {[
                    [s.sendKey === "enter" ? "Enter" : `${modKey}Enter`, "发送"],
                    [s.sendKey === "enter" ? "Shift+Enter" : "Enter", "换行"],
                    [`${modKey}K`, "新对话"],
                    [`${modKey}B`, "展开 / 收起左栏"],
                    [`${modKey}\\`, "打开 / 关闭任务卡片"],
                    [`${modKey},`, "打开设置"],
                    ["Esc", "停止运行 / 关闭弹窗和大视图"],
                    ["/", "聚焦输入框"],
                  ].map(([k, d]) => (
                    <Row key={k} label={d}>
                      <kbd className="kbd">{k}</kbd>
                    </Row>
                  ))}
                </Section>
              )}

              {props.tab === "about" && (
                <div className="about">
                  <div className="about-mark">A.ai</div>
                  <div className="set-hint">版本 0.1.0 · 极简、高效的 AI agent</div>
                  <dl>
                    <dt>技术栈</dt>
                    <dd>Next.js 16 · React 19 · TypeScript · SSE</dd>
                    <dt>Agent 循环</dt>
                    <dd className="mono">src/lib/agent/run.ts</dd>
                    <dt>模型接口</dt>
                    <dd className="mono">src/lib/llm/types.ts</dd>
                    <dt>数据目录</dt>
                    <dd className="mono">.data/（会话、设置、工作区）</dd>
                    <dt>学习笔记</dt>
                    <dd className="mono">docs/学习笔记.md</dd>
                  </dl>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/* ---------------- 记忆 ---------------- */

/**
 * 记忆页：A.ai 每次对话都会带上的“背景信息”放在一起管理——
 *   系统提示词（你写给 A.ai 的固定指示）+ 自动总结的长期记忆（关于你、习惯与偏好、错误与反思）。
 * 长期记忆的改动直接 PUT 整份到 /api/memory；系统提示词仍然存在设置里。
 */
function MemoryPane(props: {
  enabled: boolean;
  onEnabled(v: boolean): void;
  systemPrompt: string;
  defaultPrompt: string;
  onSystemPrompt(v: string, debounce: number): void;
}) {
  const [m, setM] = useState<UserMemory | null>(null);
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    api.memory().then(setM).catch((e) => setErr(String(e)));
  }, []);

  const save = (next: UserMemory, debounce = 0) => {
    setM(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => api.saveMemory(next).then(setM).catch(() => {}), debounce);
  };

  const empty = !m || (!m.profile && !m.habits.length && !m.lessons.length);

  return (
    <>
      <Section title="系统提示词" hint="每次调用模型时放在最前面。留空使用内置提示词（框里的灰字）">
        <div className="set-block">
          <textarea
            className="set-input area"
            rows={7}
            value={props.systemPrompt}
            placeholder={props.defaultPrompt}
            onChange={(e) => props.onSystemPrompt(e.target.value, 600)}
          />
          {props.systemPrompt && (
            <div className="set-actions">
              <button className="btn ghost" onClick={() => props.onSystemPrompt(DEFAULT_SETTINGS.systemPrompt, 0)}>
                恢复默认
              </button>
            </div>
          )}
        </div>
      </Section>

      <Section title="长期记忆">
        <Row label="启用记忆" hint="每轮对话结束后，自动总结你的背景、习惯和 A.ai 犯过的错，下次对话带上">
          <Toggle on={props.enabled} onChange={props.onEnabled} />
        </Row>
      </Section>

      {err ? (
        <div className="set-hint">读取失败：{err}</div>
      ) : !m ? (
        <div className="set-hint">读取中…</div>
      ) : (
        <>
          <Section title="关于你" hint={m.updatedAt ? `最后更新：${new Date(m.updatedAt).toLocaleString()}` : "还没有记忆，多聊几轮会自动生成"}>
            <div className="set-block">
              <textarea
                className="set-input area"
                rows={3}
                value={m.profile}
                placeholder="例如：后端工程师，正在学习 agent 开发"
                onChange={(e) => save({ ...m, profile: e.target.value }, 600)}
              />
            </div>
          </Section>

          <Section title="习惯与偏好" hint={m.habits.length ? `${m.habits.length} 条` : undefined}>
            {m.habits.length ? (
              m.habits.map((h, i) => (
                <MemItem key={i} onDelete={() => save({ ...m, habits: m.habits.filter((_, j) => j !== i) })}>
                  <div className="mem-text">{h}</div>
                </MemItem>
              ))
            ) : (
              <div className="set-empty">暂无</div>
            )}
          </Section>

          <Section title="错误与反思" hint="A.ai 犯过的错和总结出的规则，会作为“必须遵守”写进提示词，次数多的排在前面">
            {m.lessons.length ? (
              m.lessons.map((l, i) => (
                <MemItem key={i} onDelete={() => save({ ...m, lessons: m.lessons.filter((_, j) => j !== i) })}>
                  <div className="mem-text">{l.lesson}</div>
                  <div className="mem-sub">
                    {l.mistake}
                    {l.count > 1 && <span className="mem-count">{l.count} 次</span>}
                  </div>
                </MemItem>
              ))
            ) : (
              <div className="set-empty">暂无</div>
            )}
          </Section>

          {!empty && (
            <div className="set-actions">
              <button className="btn danger" onClick={() => confirm("清空全部记忆？") && api.clearMemory().then(setM)}>
                清空全部记忆
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

/** 一条记忆：文字 + 悬停时右侧出现删除按钮 */
function MemItem(props: { onDelete(): void; children: React.ReactNode }) {
  return (
    <div className="mem-item">
      <div className="mem-body">{props.children}</div>
      <button className="icon-btn mem-del" onClick={props.onDelete} title="删除">
        <IX width={13} height={13} />
      </button>
    </div>
  );
}

/* ---------------- 用量 ---------------- */

const KIND_LABEL: Record<UsageStats["byKind"][number]["kind"], string> = { chat: "对话", compact: "上下文压缩", reflect: "记忆整理", learn: "技能学习" };

function UsagePane() {
  const [u, setU] = useState<UsageStats | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.usage().then(setU).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div className="set-hint">读取失败：{err}</div>;
  if (!u) return <div className="set-hint">统计中…</div>;

  const max = Math.max(1, ...u.byDay.map((d) => d.turns));
  const tiles: [string, string, string?][] = [
    ["对话轮次", fmt(u.turns), `${u.sessions} 个会话`],
    ["模型调用", fmt(u.modelCalls), `平均 ${sec(u.modelCalls ? u.modelMs / u.modelCalls : 0)}`],
    ["工具调用", fmt(u.toolCalls), [u.toolErrors ? `${u.toolErrors} 次出错` : "全部成功", u.toolSkipped ? `${u.toolSkipped} 次未执行` : ""].filter(Boolean).join(" · ")],
    ["Tokens", fmt(u.inputTokens + u.outputTokens), `输入 ${fmt(u.inputTokens)} · 输出 ${fmt(u.outputTokens)}${u.cacheHitTokens ? ` · 缓存命中 ${fmt(u.cacheHitTokens)}` : ""}`],
  ];

  return (
    <div className="usage">
      <div className="tiles">
        {tiles.map(([k, v, sub]) => (
          <div key={k} className="tile">
            <div className="tile-k">{k}</div>
            <div className="tile-v">{v}</div>
            {sub && <div className="tile-sub">{sub}</div>}
          </div>
        ))}
      </div>

      <div className="chart-block">
        <div className="chart-title">
          近 14 天对话轮次 <span className="set-hint">模型耗时合计 {sec(u.modelMs)} · 工具耗时合计 {sec(u.toolMs)}</span>
        </div>
        <div className="bars" role="img" aria-label="近 14 天每天的对话轮次">
          {u.byDay.map((d) => (
            <div key={d.date} className="bar-col">
              <div className="bar-tip">
                {d.date.slice(5)} · {d.turns} 轮 · {fmt(d.tokens)} tokens
              </div>
              <div className="bar" style={{ height: `${(d.turns / max) * 100}%` }} data-zero={d.turns === 0 || undefined} />
            </div>
          ))}
        </div>
        <div className="bar-axis">
          <span>{u.byDay[0]?.date.slice(5)}</span>
          <span>今天</span>
        </div>
      </div>

      <table className="usage-table">
        <thead>
          <tr>
            <th>工具</th>
            <th>次数</th>
            <th>出错</th>
            <th>平均耗时</th>
          </tr>
        </thead>
        <tbody>
          {u.byTool.map((t) => (
            <tr key={t.name}>
              <td className="mono">{t.name}</td>
              <td>{t.count}</td>
              <td className={t.errors ? "err" : ""}>{t.errors}</td>
              <td>{sec(t.avgMs)}</td>
            </tr>
          ))}
          {!u.byTool.length && (
            <tr>
              <td colSpan={4} className="set-hint">
                还没有工具调用
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {u.byKind.length > 0 && (
        <div className="set-hint">
          {u.byKind.map((k) => `${KIND_LABEL[k.kind]} ${k.calls} 次 · ${fmt(k.tokens)} tokens`).join("　·　")}
        </div>
      )}
      <div className="set-hint">
        Token 来自 API 返回的 usage，包括对话的每一步、上下文压缩、记忆整理和技能学习。
        {u.estimatedTokens > 0 && ` 其中 ${fmt(u.estimatedTokens)} 是按字数估算的（Mock 模型、没返回用量的服务、中途停止的请求）。`}
        每一步都会把历史作为输入重新发送，所以输入 token 会比对话字数多得多；上下文压缩就是为了减少这部分。
      </div>
    </div>
  );
}

/* ---------------- 小组件 ---------------- */

/** 小节：标题（+ 说明）+ 一组设置行 */
function Section(props: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="set-sec">
      <div className="set-sec-head">
        <h3>{props.title}</h3>
        {props.hint && <div className="set-hint">{props.hint}</div>}
      </div>
      <div className="set-group">{props.children}</div>
    </section>
  );
}

/** 数字步进器：－ 数字 ＋，比原生 number 输入框好点、也不会输入越界 */
function Stepper(props: { value: number; min: number; max: number; onChange(v: number): void }) {
  const set = (v: number) => props.onChange(Math.min(props.max, Math.max(props.min, v)));
  return (
    <div className="stepper">
      <button onClick={() => set(props.value - 1)} disabled={props.value <= props.min} aria-label="减少">
        −
      </button>
      <span>{props.value}</span>
      <button onClick={() => set(props.value + 1)} disabled={props.value >= props.max} aria-label="增加">
        +
      </button>
    </div>
  );
}

const groupBy = <T,>(xs: T[], key: (x: T) => string) =>
  xs.reduce<Record<string, T[]>>((acc, x) => ((acc[key(x)] ??= []).push(x), acc), {});
/** 工具说明只取第一句，完整的放在鼠标悬停提示里 */
const firstSentence = (t: string) => t.split(/(?<=[。.!！?？])\s*/)[0];

function Row(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div>
        <div className="set-label">{props.label}</div>
        {props.hint && <div className="set-hint">{props.hint}</div>}
      </div>
      <div className="set-ctl">{props.children}</div>
    </div>
  );
}

function Seg(props: { value: string; options: [string, string][]; onChange(v: string): void }) {
  return (
    <div className="seg text">
      {props.options.map(([v, l]) => (
        <button key={v} className={props.value === v ? "on" : ""} onClick={() => props.onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Toggle(props: { on: boolean; onChange(v: boolean): void }) {
  return (
    <button className={`switch ${props.on ? "on" : ""}`} role="switch" aria-checked={props.on} onClick={() => props.onChange(!props.on)}>
      <span />
    </button>
  );
}

const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString());
const sec = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}min`);
