import { db, tx } from "../../storage/src/db";
import { modelOptions, reasoningOptions, type Settings } from "../../protocol/src/lib/settings";
import type { AgentModelSelection } from "../../protocol/src/agent-events";
import { recordAgentLog } from "./log";

/** 校验外部输入或已保存的选择。模型须出现在当前配置中，强度须由该模型支持。 */
export function parseModelSelection(input: unknown, settings: Settings): AgentModelSelection | null {
  if (!input || typeof input !== "object") return null;
  const { model, effort } = input as Partial<AgentModelSelection>;
  if (typeof model !== "string" || !modelOptions(settings).some((option) => option.value === model)) return null;
  if (effort === undefined || !reasoningOptions(settings, model).includes(effort)) return null;
  return {
    model,
    effort
  };
}

/** 读取调用者名下的会话配置。无可读记录时返回 undefined，由运行入口决定默认值。 */
export function readModelSelection(sessionId: string, userId: string): AgentModelSelection | undefined {
  const row = db().prepare(`SELECT m.model,m.effort FROM agent_model_selection m JOIN sessions s ON s.id=m.session_id
    WHERE s.id=? AND s.user_id=?`).get(sessionId, userId);
  return row ? {
    model: String(row.model),
    effort: row.effort as AgentModelSelection["effort"]
  } : undefined;
}

/** 在同一事务保存会话选择和变更事件。重复选择直接成功，日志写入失败时回滚配置。 */
export function setModelSelection(sessionId: string, userId: string, value: AgentModelSelection): boolean {
  return tx(() => {
    if (!db().prepare("SELECT 1 FROM sessions WHERE id=? AND user_id=?").get(sessionId, userId)) return false;
    const old = readModelSelection(sessionId, userId);
    if (old?.model === value.model && old.effort === value.effort) return true;
    db().prepare(`INSERT INTO agent_model_selection(session_id,model,effort) VALUES(?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET model=excluded.model,effort=excluded.effort`).run(sessionId, value.model, value.effort);
    recordAgentLog(sessionId, {
      kind: "model-selected",
      detail: {
        model: value.model,
        effort: value.effort
      }
    });
    return true;
  });
}

/**
 * 开始运行前优先使用该会话已保存的选择。模型或强度失效时提示用户重选，避免悄悄切换。
 * 会话没有选择时，从全局默认值初始化并保存。默认强度不可用时尝试该模型的 default。
 */
export function resolveModelSelection(sessionId: string, userId: string, settings: Settings): AgentModelSelection {
  const stored = readModelSelection(sessionId, userId);
  if (stored) {
    if (!parseModelSelection(stored, settings)) throw new Error("此对话保存的模型或思考强度已不可用，请在输入框下方重新选择");
    return stored;
  }
  const model = settings.currentModel || "mock";
  const effort = settings.reasoningEffort ?? "default";
  const value = parseModelSelection({
    model,
    effort
  }, settings) ?? parseModelSelection({
    model,
    effort: "default"
  }, settings);
  if (!value) throw new Error("默认模型已不可用，请在输入框下方选择模型");
  setModelSelection(sessionId, userId, value);
  return value;
}
