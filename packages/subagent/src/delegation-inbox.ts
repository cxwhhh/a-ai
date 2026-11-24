import type { TaskRecord } from "./ownership-claim";

interface Assignment {
  record: TaskRecord;
  finished: Promise<TaskRecord>;
}

export interface DelegationSettlement {
  sequence: number;
  record: TaskRecord;
  failed: boolean;
}

/** 每次工具调用拥有独立的收件箱。事件只能唤醒一次，取走后等待新的任务结算。 */
export async function collectSettlements(assignments: readonly Assignment[], receive?: (event: DelegationSettlement) => void) {
  const pending = new Set(assignments.map(({ record }) => record.id));
  const queue: DelegationSettlement[] = [];
  const received = new Map<string, DelegationSettlement>();
  let sequence = 0;
  let wake: (() => void) | undefined;
  const publish = (record: TaskRecord, failed: boolean) => {
    if (!pending.delete(record.id)) return;
    queue.push({ sequence: ++sequence, record, failed });
    wake?.();
  };
  for (const { record, finished } of assignments) {
    // finished 在持久结算之后完成。写入失败仍唤醒父轮，并保留失败标志交代缺口。
    void finished.then((task) => publish(task, false), () => publish(record, true));
  }
  while (pending.size || queue.length) {
    if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; });
    wake = undefined;
    for (const event of queue.splice(0)) {
      received.set(event.record.id, event);
      receive?.(event);
    }
  }
  // 向父轮实时交付按完成顺序，最终工具结果仍对应原分工顺序。
  return assignments.map(({ record }) => received.get(record.id)!);
}
