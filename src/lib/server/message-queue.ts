import "server-only";
import type { ChatMessage } from "../llm/types";
import type { QueuedMessage, Session } from "../shared";
import { db, newId, tx } from "./db";

/**
 * 待发送草稿与正式消息分开保存：queued 可以编辑/删除/上移，ready 表示用户已选择插队，
 * received 表示已经写入正式历史，sent 才表示包含这条消息的请求收到了模型响应。
 * 停止、刷新和服务重启都不删除草稿；已交给执行器的消息锁定，避免用户编辑与模型读取互相竞态。
 */
function owner(sessionId: string, userId: string) {
  if (!db().prepare("SELECT id FROM sessions WHERE id = ? AND user_id = ?").get(sessionId, userId)) throw new Error("会话不存在");
}

type Row = Record<string, unknown>;
function fromRow(r: Row): QueuedMessage {
  return { id: String(r.id), text: String(r.content), status: r.status as QueuedMessage["status"],
    position: Number(r.position), ...(r.message_id ? { messageId: String(r.message_id) } : {}) };
}

/** 未发送内容完整保留；只展示最近三条已送达回执，不让输入框上方无限增长。 */
export function listQueue(sessionId: string, userId: string): QueuedMessage[] {
  owner(sessionId, userId);
  const pending = db().prepare("SELECT * FROM message_queue WHERE session_id = ? AND status != 'sent' ORDER BY position, id").all(sessionId);
  const sent = db().prepare("SELECT * FROM message_queue WHERE session_id = ? AND status = 'sent' ORDER BY sent_at DESC, id DESC LIMIT 3").all(sessionId);
  return [...pending, ...sent].map(fromRow);
}

/** 稳定的客户端 ID 用于请求重试去重；同一句文字可以作为两条不同消息排队。 */
export function enqueue(sessionId: string, userId: string, text: string, id = newId("q")) {
  owner(sessionId, userId);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("消息编号无效");
  text = text.trim();
  if (!text || text.length > 12000) throw new Error("消息需要 1～12000 个字符");
  tx(() => {
    const old = db().prepare("SELECT * FROM message_queue WHERE id = ?").get(id);
    if (old) {
      if (old.session_id !== sessionId || old.content !== text) throw new Error("消息编号已被使用");
      return;
    }
    const count = Number(db().prepare("SELECT COUNT(*) AS n FROM message_queue WHERE session_id = ? AND status != 'sent'").get(sessionId)!.n);
    if (count >= 50) throw new Error("待处理消息最多 50 条，请先处理已有消息");
    db().prepare("INSERT INTO message_queue(id,session_id,content,status,position,created_at,message_id) VALUES(?,?,?,'queued',?,?,?)")
      .run(id, sessionId, text, Number(db().prepare("SELECT COALESCE(MAX(position),0)+1 AS n FROM message_queue WHERE session_id=?").get(sessionId)!.n), Date.now(), "mq_" + id);
  });
}

/** 操作前在同一事务内重新检查状态与顺序，前端过时的按钮不能修改已送入执行器的消息。 */
export function changeQueue(sessionId: string, userId: string, id: string, action: "edit" | "remove" | "up" | "steer", text?: string) {
  owner(sessionId, userId);
  tx(() => {
    const row = db().prepare("SELECT * FROM message_queue WHERE id=? AND session_id=?").get(id, sessionId);
    if (!row) throw new Error("队列消息不存在");
    if (action === "steer" && row.status === "ready") return; // 网络重试不会重复插入。
    if (row.status !== "queued") throw new Error("消息已经交给执行器，不能再编辑或移动");
    if (action === "edit") {
      const content = String(text ?? "").trim();
      if (!content || content.length > 12000) throw new Error("消息需要 1～12000 个字符");
      db().prepare("UPDATE message_queue SET content=? WHERE id=?").run(content, id);
    } else if (action === "remove") db().prepare("DELETE FROM message_queue WHERE id=?").run(id);
    else {
      const previous = db().prepare("SELECT id,position FROM message_queue WHERE session_id=? AND status='queued' AND position < ? ORDER BY position DESC LIMIT 1").get(sessionId, row.position as number);
      if (action === "up") {
        if (!previous) throw new Error("第一条消息请使用插队按钮");
        db().prepare("UPDATE message_queue SET position=? WHERE id=?").run(previous.position as number, id);
        db().prepare("UPDATE message_queue SET position=? WHERE id=?").run(row.position as number, String(previous.id));
      } else {
        if (previous) throw new Error("请先将消息上移到第一位");
        db().prepare("UPDATE message_queue SET status='ready' WHERE id=?").run(id);
      }
    }
  });
}

/** 只窥视、不删除：失败或停止后仍可投递；每批最多六条，避免一次把全部草稿塞入模型请求。 */
export function readyNotes(sessionId: string): QueuedMessage[] {
  return db().prepare("SELECT * FROM message_queue WHERE session_id=? AND status='ready' ORDER BY position,id LIMIT 6").all(sessionId).map(fromRow);
}

export function noteSaved(sessionId: string, id: string, messageId: string) {
  db().prepare("UPDATE message_queue SET status='received', message_id=? WHERE session_id=? AND id=? AND status='ready'").run(messageId, sessionId, id);
}

/** 首个模型响应到达后才确认送达；只确认本次请求实际含有的原文，压缩掉的旧消息不能冒充送达。 */
export function notesSent(session: Session, messages: ChatMessage[]) {
  const rows = db().prepare("SELECT id,message_id FROM message_queue WHERE session_id=? AND status='received'").all(session.id);
  const included = new Set(messages.filter((m) => m.role === "user").map((m) => m.sourceMessageId));
  for (const r of rows) {
    // 用消息身份确认，不能用相同文字猜测；同文消息、被摘要掉的消息必须分别处理。
    if (included.has(String(r.message_id))) {
      db().prepare("UPDATE message_queue SET status='sent', sent_at=? WHERE id=? AND status='received'").run(Date.now(), String(r.id));
    }
  }
}

/** 当前运行已结束时，第一条队列消息可以作为新轮次发送；服务端读取正文，不能相信客户端替换内容。 */
export function queuedTurn(sessionId: string, userId: string, id: string): QueuedMessage {
  const queue = listQueue(sessionId, userId);
  const item = queue.find((m) => m.id === id);
  if (!item || !["queued", "ready", "received"].includes(item.status)) throw new Error("消息已处理，请刷新队列");
  if (queue.find((m) => m.status !== "sent")?.id !== id) throw new Error("请先处理第一条等待中的消息");
  return item;
}
