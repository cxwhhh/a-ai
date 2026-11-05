"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { Skill } from "@/lib/shared";
import { ISpark, IX } from "./Icons";
import "./SkillsPane.css";

/**
 * 对话结束后提示“学会了新技能 / 改进了技能”。
 * 技能学习是回答发完以后在服务端后台做的（learn.ts，要再调一次模型），这时候 SSE 已经关了，推不过来；
 * 所以每次运行结束（runEnd 变了），隔几秒去问一下 /api/skills?since=运行结束时间，问到了就显示，问 3 次没有就算了。
 */
export function SkillToast(props: { runEnd: number; onOpen(): void }) {
  const [hit, setHit] = useState<Skill | null>(null);

  useEffect(() => {
    if (!props.runEnd) return;
    const since = props.runEnd - 2000; // 留一点余量：服务端可能比浏览器先收尾
    let stop = false;
    const timers = [4000, 12000, 30000].map((ms) =>
      setTimeout(async () => {
        if (stop) return;
        const list = await api.skills(since).catch(() => []);
        if (list.length && !stop) {
          stop = true;
          setHit(list[0]);
        }
      }, ms),
    );
    return () => {
      stop = true;
      timers.forEach(clearTimeout);
    };
  }, [props.runEnd]);

  useEffect(() => {
    if (!hit) return;
    const t = setTimeout(() => setHit(null), 12000);
    return () => clearTimeout(t);
  }, [hit]);

  if (!hit) return null;
  const created = hit.version === 1;
  return (
    <div className="sk-toast" role="status">
      <ISpark width={16} height={16} />
      <div className="sk-toast-text">
        {created ? "学会了新技能" : "改进了技能"} <b>{hit.name}</b>
        {created && hit.status === "pending" ? "，等你确认" : created ? "，已启用" : `（v${hit.version}）`}
      </div>
      <button
        className="btn"
        onClick={() => {
          setHit(null);
          props.onOpen();
        }}
      >
        {hit.status === "pending" ? "去确认" : "查看"}
      </button>
      <button className="icon-btn" onClick={() => setHit(null)} title="关闭">
        <IX width={13} height={13} />
      </button>
    </div>
  );
}
