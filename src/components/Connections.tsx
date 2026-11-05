"use client";
import { useState } from "react";
import { api } from "@/lib/client";
import { PRESETS, isMasked, type Connection, type ModelEntry } from "@/lib/settings";
import { IPlus, IX } from "./Icons";

/**
 * 设置 → 模型 → 模型连接。
 * 用户在这里手动填写 Base URL 和 API Key；“测试连接”会请求 {baseUrl}/models 验证 Key 并取回模型列表。
 * Key 只保存在服务端（.data/settings.json），浏览器拿到的永远是打码后的 ••••abcd。
 */
export function Connections(props: { connections: Connection[]; currentModel: string; onSave(next: Connection[], currentModel?: string): Promise<void> }) {
  const [editing, setEditing] = useState<Connection | null>(null);
  const [isNew, setIsNew] = useState(false);

  const add = (preset: Connection["preset"]) => {
    const p = PRESETS[preset];
    setEditing({ ...p, models: p.models.map((m) => ({ ...m })), id: "c" + Date.now().toString(36), apiKey: "" });
    setIsNew(true);
  };

  const save = async (c: Connection) => {
    const next = isNew ? [...props.connections, c] : props.connections.map((x) => (x.id === c.id ? c : x));
    // 第一次添加连接时，自动切换到它的第一个模型
    const auto = props.currentModel === "mock" && isNew && c.models[0] ? `${c.id}/${c.models[0].id}` : undefined;
    await props.onSave(next, auto);
    setEditing(null);
  };

  const remove = async (id: string) => {
    const next = props.connections.filter((c) => c.id !== id);
    await props.onSave(next, props.currentModel.startsWith(id + "/") ? "mock" : undefined);
  };

  return (
    <div className="conns">
      {props.connections.map((c) =>
        editing && !isNew && editing.id === c.id ? (
          <ConnForm key={c.id} value={editing} onCancel={() => setEditing(null)} onSave={save} />
        ) : (
          <div key={c.id} className="conn">
            <div className="conn-head">
              <span className="conn-name">{c.name}</span>
              <span className="tag">{c.preset === "deepseek" ? "DeepSeek" : "OpenAI 兼容"}</span>
              <div className="spacer" />
              <button className="link-btn" onClick={() => (setEditing({ ...c, models: c.models.map((m) => ({ ...m })) }), setIsNew(false))}>
                编辑
              </button>
              <button className="link-btn danger" onClick={() => remove(c.id)}>
                删除
              </button>
            </div>
            <div className="conn-meta mono">{c.baseUrl || "（未填写地址）"}</div>
            <div className="conn-meta">
              Key：<span className="mono">{c.apiKey || "未填写"}</span>
              {c.preset === "deepseek" && <> · 思考：{c.thinking === "default" ? "默认" : c.thinking === "enabled" ? "开启" : "关闭"}</>}
            </div>
            <div className="conn-models">
              {c.models.map((m) => (
                <span key={m.id} className="pill mono">
                  {m.id}
                  <span className="pill-dim">{fmtK(m.contextWindow)}</span>
                </span>
              ))}
              {!c.models.length && <span className="set-hint">还没有模型</span>}
            </div>
          </div>
        ),
      )}

      {editing && isNew && <ConnForm value={editing} isNew onCancel={() => setEditing(null)} onSave={save} />}

      {!editing && (
        <div className="conn-add">
          <button className="btn" onClick={() => add("deepseek")}>
            <IPlus width={13} height={13} /> 添加 DeepSeek
          </button>
          <button className="btn" onClick={() => add("custom")}>
            <IPlus width={13} height={13} /> 添加 OpenAI 兼容接口
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------------- 编辑表单 ---------------- */

function ConnForm(props: { value: Connection; isNew?: boolean; onCancel(): void; onSave(c: Connection): Promise<void> }) {
  const [c, setC] = useState<Connection>(props.value);
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "err"; msg?: string; models?: string[] }>({ state: "idle" });
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Connection>) => setC((x) => ({ ...x, ...patch }));
  const setModel = (i: number, patch: Partial<ModelEntry>) => set({ models: c.models.map((m, j) => (j === i ? { ...m, ...patch } : m)) });

  const runTest = async () => {
    setTest({ state: "testing" });
    const r = await api.testConnection({ id: c.id, baseUrl: c.baseUrl, apiKey: c.apiKey });
    setTest(
      r.ok
        ? { state: "ok", msg: `连接成功 · ${r.ms}ms · 可用模型 ${r.models?.length ?? 0} 个${r.note ? `。${r.note}` : ""}`, models: r.models }
        : { state: "err", msg: r.error },
    );
  };

  /** 把接口返回的模型加进列表（已有的不重复） */
  const addFetched = (ids: string[]) => {
    const have = new Set(c.models.map((m) => m.id));
    const def = PRESETS[c.preset].models[0]?.contextWindow ?? 128_000;
    set({ models: [...c.models, ...ids.filter((id) => !have.has(id)).map((id) => ({ id, contextWindow: def }))] });
  };

  const canSave = c.name.trim() && /^https?:\/\//.test(c.baseUrl.trim()) && c.apiKey.trim() && c.models.length > 0 && c.models.every((m) => m.id.trim());

  return (
    <div className="conn editing">
      <div className="form-grid">
        <label>名称</label>
        <input className="set-input" value={c.name} onChange={(e) => set({ name: e.target.value })} />

        <label>Base URL</label>
        <input className="set-input mono" value={c.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => set({ baseUrl: e.target.value })} />

        <label>API Key</label>
        <input
          className="set-input mono"
          type="password"
          autoComplete="off"
          value={c.apiKey}
          placeholder="sk-..."
          onFocus={(e) => isMasked(c.apiKey) && e.currentTarget.select()}
          onChange={(e) => set({ apiKey: e.target.value })}
        />
        {isMasked(c.apiKey) && <div className="form-note">已保存的 Key 已打码；不修改就保持原样，重新输入则替换。</div>}

        <label>模型</label>
        <div className="model-rows">
          {c.models.map((m, i) => (
            <div key={i} className="model-row">
              <input className="set-input mono" value={m.id} placeholder="模型名，如 deepseek-flash" onChange={(e) => setModel(i, { id: e.target.value })} />
              <input
                className="set-input num"
                type="number"
                min={1}
                value={m.contextWindow}
                title="上下文长度（tokens）"
                onChange={(e) => setModel(i, { contextWindow: Number(e.target.value) })}
              />
              <button className="icon-btn" onClick={() => set({ models: c.models.filter((_, j) => j !== i) })} title="移除">
                <IX width={13} height={13} />
              </button>
            </div>
          ))}
          <button className="link-btn" onClick={() => set({ models: [...c.models, { id: "", contextWindow: PRESETS[c.preset].models[0]?.contextWindow ?? 128_000 }] })}>
            + 添加模型
          </button>
          <div className="form-note">右侧数字是上下文长度（tokens），用于输入框下方的占用百分比。</div>
        </div>

        {c.preset === "deepseek" && (
          <>
            <label>思考模式</label>
            <div>
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
              <div className="form-note">DeepSeek 默认开启思考。关闭后响应更快、更省 token，但中栏不再显示思考过程。</div>
            </div>
          </>
        )}

        <label>回传思考</label>
        <div>
          <button className={`switch ${c.sendReasoning ? "on" : ""}`} role="switch" aria-checked={c.sendReasoning} onClick={() => set({ sendReasoning: !c.sendReasoning })}>
            <span />
          </button>
          <div className="form-note">把历史思考内容作为 reasoning_content 发回。DeepSeek 思考模式下调用工具时必须开启，否则接口返回 400；其他服务一般关闭。</div>
        </div>
      </div>

      {test.state !== "idle" && (
        <div className={`test-line ${test.state}`}>
          {test.state === "testing" ? "测试中…" : test.msg}
          {test.state === "ok" && test.models && test.models.some((id) => !c.models.find((m) => m.id === id)) && (
            <button className="link-btn" onClick={() => addFetched(test.models!)}>
              加入返回的模型
            </button>
          )}
        </div>
      )}

      <div className="form-actions">
        <button className="btn" onClick={runTest} disabled={!c.baseUrl || !c.apiKey || test.state === "testing"}>
          测试连接
        </button>
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

const fmtK = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
