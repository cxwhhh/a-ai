"use client";
import { useState } from "react";
import { api } from "@/lib/client";
import { PRESETS, isMasked, type Connection, type ModelEntry } from "@/lib/settings";
import { ICheck, IChevron, IPencil, IPlus, IX } from "./Icons";
import "./Connections.css";

/**
 * 设置 → 模型 → 模型服务。
 * 列表：每个服务一张卡片（头像字母 + 名称 + 地址/Key），下面是它的模型，点模型直接设为当前模型。
 * 添加：一个“添加模型服务”按钮 → 选服务商（自动填好地址）→ 分三步填表：连接信息 / 模型 / 高级选项。
 * Key 只保存在服务端（.data/settings.json），浏览器拿到的永远是打码后的 ••••abcd。
 */

/**
 * 常见服务商。Claude 走 Anthropic 自己的协议（preset "anthropic"）；DeepSeek 单独一个 preset（有思考模式开关）；
 * 其余都是 OpenAI 兼容接口，只是地址不同。通义千问用国际站地址（中国大陆的 Key 要改成 dashscope.aliyuncs.com）
 */
const PROVIDERS: { key: string; name: string; preset: Connection["preset"]; baseUrl: string; keyHint?: string; desc: string }[] = [
  { key: "claude", name: "Claude", preset: "anthropic", baseUrl: PRESETS.anthropic.baseUrl, keyHint: "sk-ant-...", desc: "Opus / Sonnet / Haiku" },
  { key: "openai", name: "OpenAI", preset: "custom", baseUrl: "https://api.openai.com/v1", desc: "GPT 系列" },
  { key: "deepseek", name: "DeepSeek", preset: "deepseek", baseUrl: PRESETS.deepseek.baseUrl, desc: "已预置两个模型" },
  { key: "qwen", name: "通义千问", preset: "custom", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", desc: "阿里云 Model Studio" },
  { key: "ollama", name: "Ollama", preset: "custom", baseUrl: "http://localhost:11434/v1", keyHint: "随便填，比如 ollama", desc: "本机运行的模型" },
  { key: "custom", name: "其他", preset: "custom", baseUrl: "", desc: "任意 OpenAI 兼容接口" },
];

export function Connections(props: {
  connections: Connection[];
  currentModel: string;
  onSave(next: Connection[], currentModel?: string): Promise<void>;
  onPick(model: string): void;
}) {
  const [editing, setEditing] = useState<Connection | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [picking, setPicking] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const add = (p: (typeof PROVIDERS)[number]) => {
    const base = PRESETS[p.preset];
    setEditing({
      ...base,
      name: p.key === "custom" ? "" : p.name,
      baseUrl: p.baseUrl,
      models: base.models.map((m) => ({ ...m })),
      id: "c" + Date.now().toString(36),
      apiKey: "",
    });
    setIsNew(true);
    setPicking(false);
  };

  const save = async (c: Connection) => {
    const next = isNew ? [...props.connections, c] : props.connections.map((x) => (x.id === c.id ? c : x));
    // 第一次添加连接时，自动切换到它的第一个模型
    const auto = props.currentModel === "mock" && isNew && c.models[0] ? `${c.id}/${c.models[0].id}` : undefined;
    await props.onSave(next, auto);
    setEditing(null);
  };

  const remove = async (id: string) => {
    setConfirmDel(null);
    const next = props.connections.filter((c) => c.id !== id);
    await props.onSave(next, props.currentModel.startsWith(id + "/") ? "mock" : undefined);
  };

  return (
    <div className="cx">
      {props.connections.map((c) =>
        editing && !isNew && editing.id === c.id ? (
          <ConnForm key={c.id} value={editing} onCancel={() => setEditing(null)} onSave={save} />
        ) : (
          <div key={c.id} className={`cx-card ${props.currentModel.startsWith(c.id + "/") ? "in-use" : ""}`}>
            <div className="cx-head">
              <span className="cx-ava">{avatar(c.name)}</span>
              <div className="cx-title">
                <div className="cx-name">
                  {c.name}
                  {props.currentModel.startsWith(c.id + "/") && <span className="cx-use">使用中</span>}
                </div>
                <div className="cx-meta">
                  <span className="mono">{c.baseUrl || "未填写地址"}</span>
                  <span className="cx-dot" />
                  <span className="mono">{c.apiKey || "未填写 Key"}</span>
                </div>
              </div>
              {confirmDel === c.id ? (
                <div className="cx-confirm">
                  <span>删除这个服务？</span>
                  <button className="btn ghost" onClick={() => setConfirmDel(null)}>
                    取消
                  </button>
                  <button className="btn danger" onClick={() => remove(c.id)}>
                    删除
                  </button>
                </div>
              ) : (
                <div className="cx-acts">
                  <button
                    className="icon-btn"
                    title="编辑"
                    onClick={() => (setEditing({ ...c, models: c.models.map((m) => ({ ...m })) }), setIsNew(false), setPicking(false))}
                  >
                    <IPencil width={14} height={14} />
                  </button>
                  <button className="icon-btn" title="删除" onClick={() => setConfirmDel(c.id)}>
                    <IX width={14} height={14} />
                  </button>
                </div>
              )}
            </div>
            <div className="cx-models">
              {c.models.map((m) => {
                const v = `${c.id}/${m.id}`;
                const on = props.currentModel === v;
                return (
                  <button key={m.id} className={`cx-model ${on ? "on" : ""}`} title={on ? "当前模型" : "设为当前模型"} onClick={() => !on && props.onPick(v)}>
                    {on && <ICheck width={12} height={12} />}
                    <span className="mono">{m.id}</span>
                    <span className="cx-ctx">{fmtK(m.contextWindow)}</span>
                  </button>
                );
              })}
              {!c.models.length && <span className="set-hint">还没有模型，点编辑添加</span>}
            </div>
          </div>
        ),
      )}

      {editing && isNew && <ConnForm value={editing} isNew onCancel={() => setEditing(null)} onSave={save} />}

      {!editing &&
        (picking ? (
          <div className="cx-pick">
            <div className="cx-pick-head">
              <span>选择服务商</span>
              <button className="icon-btn" title="取消" onClick={() => setPicking(false)}>
                <IX width={14} height={14} />
              </button>
            </div>
            <div className="cx-pick-grid">
              {PROVIDERS.map((p) => (
                <button key={p.key} className="cx-prov" onClick={() => add(p)}>
                  <span className="cx-ava sm">{p.key === "custom" ? <IPlus width={13} height={13} /> : avatar(p.name)}</span>
                  <span className="cx-prov-txt">
                    <b>{p.name}</b>
                    <span>{p.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <button className="cx-add" onClick={() => setPicking(true)}>
            <IPlus width={14} height={14} /> 添加模型服务
          </button>
        ))}
    </div>
  );
}

/* ---------------- 编辑表单：① 连接信息 ② 模型 ③ 高级选项 ---------------- */

function ConnForm(props: { value: Connection; isNew?: boolean; onCancel(): void; onSave(c: Connection): Promise<void> }) {
  const [c, setC] = useState<Connection>(props.value);
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "err"; msg?: string; models?: string[] }>({ state: "idle" });
  const [saving, setSaving] = useState(false);
  const [adv, setAdv] = useState(false);
  const set = (patch: Partial<Connection>) => setC((x) => ({ ...x, ...patch }));
  const setModel = (i: number, patch: Partial<ModelEntry>) => set({ models: c.models.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const defCtx = PRESETS[c.preset].models[0]?.contextWindow ?? 128_000;
  const keyHint = PROVIDERS.find((p) => p.baseUrl && p.baseUrl === c.baseUrl)?.keyHint;

  const runTest = async () => {
    setTest({ state: "testing" });
    const r = await api.testConnection({ id: c.id, baseUrl: c.baseUrl, apiKey: c.apiKey, preset: c.preset });
    setTest(
      r.ok
        ? { state: "ok", msg: `连接成功 · ${r.ms}ms${r.models?.length ? ` · 找到 ${r.models.length} 个模型` : ""}${r.note ? `。${r.note}` : ""}`, models: r.models }
        : { state: "err", msg: r.error },
    );
  };

  const has = (id: string) => c.models.some((m) => m.id === id);
  const toggleFetched = (id: string) =>
    set({ models: has(id) ? c.models.filter((m) => m.id !== id) : [...c.models.filter((m) => m.id.trim()), { id, contextWindow: defCtx }] });

  const canSave = c.name.trim() && /^https?:\/\//.test(c.baseUrl.trim()) && c.apiKey.trim() && c.models.length > 0 && c.models.every((m) => m.id.trim());

  return (
    <div className="cx-form">
      <div className="cx-form-title">
        <span className="cx-ava">{avatar(c.name || "?")}</span>
        {props.isNew ? `添加 ${c.name || "模型服务"}` : `编辑 ${c.name}`}
      </div>

      {/* ① 连接信息 */}
      <div className="cx-step">
        <div className="cx-step-head">
          <i>1</i>连接信息
        </div>
        <div className="cx-fields">
          <label className="cx-field">
            <span>名称</span>
            <input className="set-input" value={c.name} placeholder="随便起，比如 我的 OpenAI" onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="cx-field">
            <span>接口地址</span>
            <input className="set-input mono" value={c.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => set({ baseUrl: e.target.value })} />
          </label>
          <label className="cx-field">
            <span>API Key</span>
            <div className="cx-key">
              <input
                className="set-input mono"
                type="password"
                autoComplete="off"
                value={c.apiKey}
                placeholder={keyHint ?? "sk-..."}
                onFocus={(e) => isMasked(c.apiKey) && e.currentTarget.select()}
                onChange={(e) => set({ apiKey: e.target.value })}
              />
              <button className="btn" onClick={runTest} disabled={!c.baseUrl || !c.apiKey || test.state === "testing"}>
                {test.state === "testing" ? "测试中…" : "测试连接"}
              </button>
            </div>
          </label>
          {isMasked(c.apiKey) && <div className="form-note">已保存的 Key 已打码；不改就保持原样，重新输入则替换。</div>}
          {(test.state === "ok" || test.state === "err") && <div className={`cx-test ${test.state}`}>{test.msg}</div>}
        </div>
      </div>

      {/* ② 模型 */}
      <div className="cx-step">
        <div className="cx-step-head">
          <i>2</i>模型
          <span className="cx-step-hint">至少一个；上下文长度用于输入框下方的占用百分比</span>
        </div>
        {test.state === "ok" && !!test.models?.length && (
          <div className="cx-fetched">
            <div className="form-note">接口返回的模型，点一下加入或移除：</div>
            <div className="cx-models">
              {test.models.map((id) => (
                <button key={id} className={`cx-model ${has(id) ? "on" : ""}`} onClick={() => toggleFetched(id)}>
                  {has(id) ? <ICheck width={12} height={12} /> : <IPlus width={12} height={12} />}
                  <span className="mono">{id}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="cx-mtable">
          {c.models.length > 0 && (
            <div className="cx-mrow cx-mhead">
              <span>模型名</span>
              <span>上下文（tokens）</span>
              <span />
            </div>
          )}
          {c.models.map((m, i) => (
            <div key={i} className="cx-mrow">
              <input className="set-input mono" value={m.id} placeholder="如 gpt-4o-mini" onChange={(e) => setModel(i, { id: e.target.value })} />
              <input
                className="set-input num"
                type="number"
                min={1}
                value={m.contextWindow}
                onChange={(e) => setModel(i, { contextWindow: Number(e.target.value) })}
              />
              <button className="icon-btn" onClick={() => set({ models: c.models.filter((_, j) => j !== i) })} title="移除">
                <IX width={13} height={13} />
              </button>
            </div>
          ))}
          <button className="link-btn cx-addm" onClick={() => set({ models: [...c.models, { id: "", contextWindow: defCtx }] })}>
            <IPlus width={12} height={12} /> 手动添加模型
          </button>
        </div>
      </div>

      {/* ③ 高级选项（默认收起） */}
      <div className="cx-step">
        <button className={`cx-step-head cx-adv ${adv ? "open" : ""}`} onClick={() => setAdv((v) => !v)}>
          <i>3</i>高级选项
          <span className="cx-step-hint">一般不用改</span>
          <IChevron width={14} height={14} />
        </button>
        {adv && (
          <div className="cx-fields">
            {c.preset === "deepseek" && (
              <div className="cx-opt">
                <div>
                  <div className="cx-opt-label">思考模式</div>
                  <div className="form-note">关闭后响应更快、更省 token，但中栏不再显示思考过程。</div>
                </div>
                <div className="seg text">
                  {(
                    [
                      ["default", "默认"],
                      ["enabled", "开启"],
                      ["disabled", "关闭"],
                    ] as const
                  ).map(([v, l]) => (
                    <button key={v} className={c.thinking === v ? "on" : ""} onClick={() => set({ thinking: v })}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {c.preset === "anthropic" ? (
              <div className="form-note">Claude 的思考固定开启（adaptive），会自动把思考内容连同签名发回，不需要设置。</div>
            ) : (
            <div className="cx-opt">
              <div>
                <div className="cx-opt-label">回传思考</div>
                <div className="form-note">把历史思考作为 reasoning_content 发回。DeepSeek 思考模式下调用工具必须开启，其他服务一般关闭。</div>
              </div>
              <button className={`switch ${c.sendReasoning ? "on" : ""}`} role="switch" aria-checked={c.sendReasoning} onClick={() => set({ sendReasoning: !c.sendReasoning })}>
                <span />
              </button>
            </div>
            )}
          </div>
        )}
      </div>

      <div className="cx-foot">
        {!canSave && <span className="cx-need">{need(c)}</span>}
        <div className="spacer" />
        <button className="btn ghost" onClick={props.onCancel}>
          取消
        </button>
        <button
          className="btn primary"
          disabled={!canSave || saving}
          onClick={async () => {
            setSaving(true);
            await props.onSave({ ...c, name: c.name.trim(), baseUrl: c.baseUrl.trim(), apiKey: c.apiKey.trim(), models: c.models.map((m) => ({ ...m, id: m.id.trim() })) });
            setSaving(false);
          }}
        >
          {props.isNew ? "添加" : "保存"}
        </button>
      </div>
    </div>
  );
}

/** 保存按钮灰着时，告诉用户还差什么 */
function need(c: Connection) {
  if (!c.name.trim()) return "还差：名称";
  if (!/^https?:\/\//.test(c.baseUrl.trim())) return "还差：接口地址（http:// 或 https:// 开头）";
  if (!c.apiKey.trim()) return "还差：API Key";
  if (!c.models.length || !c.models.every((m) => m.id.trim())) return "还差：至少一个模型名";
  return "";
}

/** 头像：取名称第一个字（英文取首字母大写） */
const avatar = (name: string) => (name.trim()[0] ?? "?").toUpperCase();

const fmtK = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
