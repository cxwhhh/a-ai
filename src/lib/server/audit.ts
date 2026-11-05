import "server-only";
import { db } from "./db";

/**
 * 审计日志：run_command / run_python 每执行（或被拦下）一次就记一行，存在 SQLite 的 audit_log 表。
 * 和对话记录分开存：删了对话，审计记录还在，事后能查“agent 在这台机器上到底执行过什么”。
 *
 * decision：
 *   allowed  执行了（只读命令自动放行，或用户点了允许）
 *   denied   用户在确认卡片上拒绝了
 *   blocked  被规则拦下（危险命令、访问授权范围外的路径、读密钥）
 */
export type AuditDecision = "allowed" | "denied" | "blocked";

export interface AuditEntry {
  id: number;
  userId: string;
  sessionId: string;
  tool: string;
  command: string;
  cwd: string;
  sandbox: string;
  decision: AuditDecision;
  reason: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputChars: number;
  createdAt: number;
}

export function audit(e: Omit<AuditEntry, "id" | "createdAt" | "reason" | "exitCode" | "timedOut" | "durationMs" | "outputChars"> & Partial<AuditEntry>) {
  try {
    db()
      .prepare(
        `INSERT INTO audit_log (user_id, session_id, tool, command, cwd, sandbox, decision, reason, exit_code, timed_out, duration_ms, output_chars, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.userId,
        e.sessionId,
        e.tool,
        e.command.slice(0, 4000),
        e.cwd,
        e.sandbox,
        e.decision,
        e.reason ?? "",
        e.exitCode ?? null,
        e.timedOut ? 1 : 0,
        e.durationMs ?? 0,
        e.outputChars ?? 0,
        Date.now(),
      );
  } catch (err) {
    // 审计写失败不能影响命令本身，但要在服务端日志里看得到
    console.warn("[audit] 写入失败：", err instanceof Error ? err.message : err);
  }
}

/** 某个用户最近的记录，新的在前 */
export function listAudit(userId: string, limit = 200): AuditEntry[] {
  const rows = db()
    .prepare("SELECT * FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .all(userId, Math.min(Math.max(limit, 1), 1000)) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    userId: String(r.user_id),
    sessionId: String(r.session_id ?? ""),
    tool: String(r.tool),
    command: String(r.command),
    cwd: String(r.cwd ?? ""),
    sandbox: String(r.sandbox ?? ""),
    decision: r.decision as AuditDecision,
    reason: String(r.reason ?? ""),
    exitCode: r.exit_code === null ? null : Number(r.exit_code),
    timedOut: !!r.timed_out,
    durationMs: Number(r.duration_ms ?? 0),
    outputChars: Number(r.output_chars ?? 0),
    createdAt: Number(r.created_at),
  }));
}
