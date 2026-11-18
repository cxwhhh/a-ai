import { readAgentEvents, recordAgentLog } from "../../src/log";
import { projectSession } from "../../../session-projection/src/projection";
import { resolvePath } from "../../../workspace/src/access";
import { db } from "../../../storage/src/db";
import { readFileHash } from "../../../workspace/src/file-fingerprint";
import { toolStatus, type Session, type StoredMessage } from "../../../protocol/src/lib/shared";

type Verification = "matches-expected" | "matches-before" | "changed" | "unreadable";

export interface FileRecovery {
  assistantId: string;
  callId: string;
  inputId: string;
  path: string;
  verification: Verification;
  checkedAt: number;
}

type FileWriteRow = {
  assistant_id: string;
  call_id: string;
  run_id: string;
  input_id: string;
  step: number;
  path: string;
  before_hash: string | null;
  expected_hash: string;
};

export interface ToolWriteScope {
  sessionId: string;
  runId: string;
  inputId: string;
  assistantId: string;
  step: number;
  callId: string;
}

/** 在文件操作前提交。调用方已取得会话运行权，助手的调用声明也已经保存。 */
export function recordFileWrite(scope: ToolWriteScope, path: string, before: string | null, expected: string): void {
  db().prepare(`INSERT INTO agent_file_writes
    (session_id, assistant_id, call_id, run_id, input_id, step, path, before_hash, expected_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(scope.sessionId, scope.assistantId, scope.callId, scope.runId, scope.inputId, scope.step, path, before, expected);
}

export function readFileRecoveries(sessionId: string, userId: string): FileRecovery[] {
  return db().prepare(`SELECT w.assistant_id AS assistantId, w.call_id AS callId, w.input_id AS inputId, w.path,
      w.verification, w.checked_at AS checkedAt
    FROM agent_file_writes w JOIN sessions s ON s.id=w.session_id
    WHERE s.id=? AND s.user_id=? AND w.verification IS NOT NULL`).all(sessionId, userId) as unknown as FileRecovery[];
}

/** 工具结果只能和本条助手消息配对，不能匹配后续轮次里复用的 callId。 */
function resultFor(messages: StoredMessage[], assistantId: string, callId: string): StoredMessage | undefined {
  const i = messages.findIndex((message) => message.id === assistantId && message.role === "assistant");
  if (i < 0) return;
  for (let j = i + 1; messages[j]?.role === "tool"; j++) {
    if (messages[j].toolCallId === callId) return messages[j];
  }
}

/**
 * 续聊前对账最近一轮。正常结果优先，缺少结果时只读检查带检查点的文件。
 * 已有的核验是某一时点的事实。历史、步骤状态和文件正文保持原记录。
 */
export async function recoverInterruptedTurn(session: Session, userId: string, workspace: string, signal: AbortSignal): Promise<string | undefined> {
  // 找当前分支上最后一个实际输入，避免把更早的已截断轮次当作这次需要恢复的任务。
  let lastInputId: string | undefined;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i];
    if (message.role === "user" && !message.feedback) {
      lastInputId = message.id;
      break;
    }
  }
  if (!lastInputId) return;
  const events = readAgentEvents(userId, session.id);
  const turn = projectSession(session, events).turns.filter((item) => item.inCurrentHistory).at(-1);
  if (!turn || turn.inputId !== lastInputId || (turn.endEventId !== null && turn.outcome !== "interrupted")) return;

  // 恢复补记可能晚于旧轮结束。对账读原始事件，轮次投影会略过结束之后的步骤事件。
  const logged = new Set(events.flatMap((event) => event.kind === "tool-result"
    && event.runId === turn.runId && event.inputId === turn.inputId
    ? [JSON.stringify([event.detail.step, event.detail.callId])]
    : []));
  const writes = db().prepare(`SELECT w.* FROM agent_file_writes w
    JOIN sessions s ON s.id=w.session_id
    JOIN messages m ON m.id=w.assistant_id AND m.session_id=w.session_id AND m.superseded_by IS NULL
    WHERE s.id=? AND s.user_id=? AND w.run_id=? AND w.input_id=? AND w.verification IS NULL`)
    .all(session.id, userId, turn.runId, turn.inputId) as unknown as FileWriteRow[];
  for (const write of writes) {
    signal.throwIfAborted();
    if (logged.has(JSON.stringify([write.step, write.call_id]))) continue;
    const result = resultFor(session.messages, write.assistant_id, write.call_id);
    if (result) {
      // 只补已有消息支持的事件，继续保留结果正文、状态和原轮次。
      recordAgentLog(session.id, {
        kind: "tool-result",
        runId: write.run_id,
        inputId: write.input_id,
        detail: {
          step: write.step,
          callId: write.call_id,
          status: toolStatus(result),
          durationMs: result.durationMs ?? null,
          errorKind: result.errorKind ?? null,
          artifactId: result.artifactId ?? null
        }
      });
      continue;
    }

    let hash: string | null = null;
    let verification: Verification = "unreadable";
    try {
      const target = resolvePath(workspace, write.path, "read");
      // 路径经过符号链接后可能换了目标。只核验仍指向原工作区相对位置的文件。
      if (target.inWorkspace && target.shown === write.path) {
        hash = await readFileHash(target.full, signal);
        verification = hash === write.expected_hash ? "matches-expected"
          : hash === write.before_hash ? "matches-before" : "changed";
      }
    } catch {
      // 读取权限、路径或类型出错时保留未知结果，不触碰目标。
    }
    signal.throwIfAborted();
    db().prepare(`UPDATE agent_file_writes SET verification=?, checked_hash=?, checked_at=?
      WHERE session_id=? AND assistant_id=? AND call_id=? AND verification IS NULL`)
      .run(verification, hash, Date.now(), session.id, write.assistant_id, write.call_id);
  }
  return turn.inputId;
}

export function fileRecoveryLabel(verification: Verification): string {
  switch (verification) {
    case "matches-expected": return "恢复核验：目标状态已满足";
    case "matches-before": return "恢复核验：文件与写入前一致";
    case "changed": return "恢复核验：文件已变化，结果未知";
    case "unreadable": return "恢复核验：无法读取原目标，结果未知";
  }
}

export function fileRecoveryMessage(recovery: FileRecovery): string {
  const instruction = recovery.verification === "matches-expected"
    ? "核验时目标内容已存在。继续后续步骤前如需要确认现状，可重新读取该文件。"
    : recovery.verification === "matches-before"
      ? "核验时观察到原状态。是否重新写入需要根据当前任务和文件现状决定。"
      : "重新写入前请先核对当前文件和用户意图。";
  return `${fileRecoveryLabel(recovery.verification)}（路径 ${JSON.stringify(recovery.path)}，核验时间 ${new Date(recovery.checkedAt).toISOString()}）。${instruction}`;
}
