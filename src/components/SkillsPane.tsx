"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { Skill } from "@/lib/shared";
import { IChevron, IPlus } from "./Icons";
import "./SkillsPane.css";

/**
 * 设置 → 技能：A.ai 从你的使用中总结出来的“做某类任务的固定做法”（见 src/lib/agent/learn.ts）。
 *   上面两个开关：要不要自动学习、新技能要不要先给你确认
 *   下面按状态分三组：待确认（启用 / 不要）、已启用、已停用。点一行展开，可以改名字、说明和步骤，
 *   看它是怎么来的、改过几次，恢复上一版，停用或删除。
 * 改动即时保存（停止输入 600ms 后 PATCH /api/skills/[id]）。
 */
export function SkillsPane(props: { enabled: boolean; autoEnable: boolean; onEnabled(v: boolean): void; onAutoEnable(v: boolean): void }) {
  const [list, setList] = useState<Skill[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api.skills().then(setList).catch((e) => setErr(String(e)));
  }, []);

  const replace = (s: Skill) => setList((l) => (l ? l.map((x) => (x.id === s.id ? s : x)) : l));
  const remove = async (s: Skill) => {
    if (!confirm(`删除技能「${s.name}」？`)) return;
    await api.deleteSkill(s.id);
    setList((l) => l?.filter((x) => x.id !== s.id) ?? l);
  };
  const add = async () => {
    try {
      const names = new Set(list?.map((s) => s.name));
      let name = "新技能";
      for (let i = 2; names.has(name); i++) name = `新技能 ${i}`;
      const s = await api.createSkill({ name, description: "当用户…时", body: "## 适用场景\n\n## 步骤\n1. \n\n## 用户的固定要求\n\n## 注意事项\n\n## 怎么验证做对了\n" });
      setList((l) => [s, ...(l ?? [])]);
      setOpen(s.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const groups: [Skill["status"], string, string][] = [
    ["pending", "待确认", "A.ai 自动总结出来的，你点“启用”后才会用"],
    ["active", "已启用", "对话时提示词里只放名字和一句话，任务对得上时 A.ai 才读取全文"],
    ["disabled", "已停用", "不会被使用。成功率太低的技能会被自动停到这里"],
  ];

  return (
    <>
      <section className="set-sec">
        <div className="set-sec-head">
          <h3>自动学习</h3>
        </div>
        <div className="set-group">
          <div className="set-row">
            <div>
              <div className="set-label">启用技能</div>
              <div className="set-hint">把你反复做的事、做成功的复杂任务总结成技能，下次同类任务按技能做；用了出问题会自动改进</div>
            </div>
            <div className="set-ctl">
              <Toggle on={props.enabled} onChange={props.onEnabled} />
            </div>
          </div>
          <div className="set-row">
            <div>
              <div className="set-label">新技能自动启用</div>
              <div className="set-hint">{props.autoEnable ? "总结出来就直接用，不用你确认" : "总结出来先放进“待确认”，你看过点启用才会用"}</div>
            </div>
            <div className="set-ctl">
              <Toggle on={props.autoEnable} onChange={props.onAutoEnable} />
            </div>
          </div>
        </div>
      </section>

      {err ? (
        <div className="set-hint">读取失败：{err}</div>
      ) : !list ? (
        <div className="set-hint">读取中…</div>
      ) : (
        <>
          {groups.map(([status, title, hint]) => {
            const items = list.filter((s) => s.status === status);
            if (!items.length && status !== "active") return null;
            return (
              <section key={status} className="set-sec">
                <div className="set-sec-head sk-sec-head">
                  <div>
                    <h3>
                      {title}
                      {items.length > 0 && <span className="sk-n">{items.length}</span>}
                    </h3>
                    <div className="set-hint">{hint}</div>
                  </div>
                  {status === "active" && (
                    <button className="btn ghost" onClick={add}>
                      <IPlus width={13} height={13} />
                      新建
                    </button>
                  )}
                </div>
                <div className="set-group">
                  {items.length ? (
                    items.map((s) => (
                      <SkillItem key={s.id} skill={s} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} onChange={replace} onDelete={() => remove(s)} />
                    ))
                  ) : (
                    <div className="set-empty">还没有技能。多用几次，A.ai 会把常做的事总结成技能；也可以点“新建”自己写一个</div>
                  )}
                </div>
              </section>
            );
          })}
        </>
      )}
    </>
  );
}

/** 一个技能：收起时一行（名字、说明、用过几次）；展开后可以编辑 */
function SkillItem(props: { skill: Skill; open: boolean; onToggle(): void; onChange(s: Skill): void; onDelete(): void }) {
  const { skill: s } = props;
  const [draft, setDraft] = useState({ name: s.name, description: s.description, body: s.body });
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 还没保存完的输入次数：大于 0 时不拿服务端的内容覆盖编辑框，免得刚打的字被旧内容冲掉 */
  const typing = useRef(0);

  // 服务端的内容变了（恢复上一版、自动改进）：编辑框跟着更新
  useEffect(() => {
    if (!typing.current) setDraft({ name: s.name, description: s.description, body: s.body });
  }, [s.name, s.description, s.body]);

  const save = (patch: Partial<typeof draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (timer.current) clearTimeout(timer.current);
    const n = ++typing.current;
    timer.current = setTimeout(async () => {
      try {
        const next = await api.updateSkill(s.id, patch);
        if (n === typing.current) typing.current = 0;
        props.onChange(next);
        setError("");
      } catch (e) {
        if (n === typing.current) typing.current = 0;
        setError(e instanceof Error ? e.message : String(e));
      }
    }, 600);
  };
  const act = async (patch: Parameters<typeof api.updateSkill>[1]) => {
    try {
      props.onChange(await api.updateSkill(s.id, patch));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const meta = [
    s.uses ? `用过 ${s.uses} 次 · 顺利 ${Math.round((s.successes / s.uses) * 100)}%` : "还没用过",
    `v${s.version}`,
    s.source === "auto" ? "自动总结" : "手动新建",
  ].join(" · ");

  return (
    <div className={`sk-item ${props.open ? "open" : ""}`}>
      <div className="sk-head">
        <button className="sk-main" onClick={props.onToggle} aria-expanded={props.open}>
          <IChevron className="sk-chev" width={12} height={12} />
          <span className="sk-text">
            <span className="sk-name">{s.name}</span>
            <span className="sk-desc">{s.description}</span>
            <span className="sk-meta">{meta}</span>
          </span>
        </button>
        {s.status === "pending" && (
          <div className="sk-quick">
            <button className="btn primary" onClick={() => act({ status: "active" })}>
              启用
            </button>
            <button className="btn ghost" onClick={props.onDelete}>
              不要
            </button>
          </div>
        )}
      </div>

      {props.open && (
        <div className="sk-edit">
          <div className="form-grid">
            <label>名字</label>
            <input className="set-input" value={draft.name} maxLength={40} onChange={(e) => save({ name: e.target.value })} />
            <label>什么时候用</label>
            <input className="set-input" value={draft.description} maxLength={200} onChange={(e) => save({ description: e.target.value })} />
            <div className="form-note">A.ai 靠这一句判断要不要用这个技能，写出能触发它的关键词</div>
            <label>步骤</label>
            <textarea className="set-input area" rows={12} value={draft.body} onChange={(e) => save({ body: e.target.value })} />
          </div>
          {error && <div className="sk-err">{error}</div>}
          {s.history.length > 0 && (
            <ul className="sk-hist">
              {s.history.map((h, i) => (
                <li key={i}>
                  <span>{new Date(h.at).toLocaleString()}</span>
                  {h.note}
                </li>
              ))}
            </ul>
          )}
          <div className="set-actions">
            {s.previous && (
              <button className="btn ghost" onClick={() => act({ restore: true })} title="自动改进改坏了？回到改之前的内容">
                恢复到 v{s.previous.version}
              </button>
            )}
            {s.status === "active" ? (
              <button className="btn" onClick={() => act({ status: "disabled" })}>
                停用
              </button>
            ) : (
              <button className="btn" onClick={() => act({ status: "active" })}>
                启用
              </button>
            )}
            <button className="btn danger" onClick={props.onDelete}>
              删除
            </button>
          </div>
        </div>
      )}
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
