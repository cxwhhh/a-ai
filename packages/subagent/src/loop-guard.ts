const MIN_REPEAT_CHARS = 96;
const MIN_REPEATS = 4;
const TAIL_CHARS = 2_048;
const SAMPLE_INTERVAL = 32;

/** 按字符检查连续周期。保留短尾部，识别跨流片段拆开的复读。 */
export class StreamRepetition {
  private tail = "";
  private sinceCheck = 0;

  append(delta: string) {
    const content = delta.replace(/\s/g, "");
    this.tail = (this.tail + content).slice(-TAIL_CHARS);
    this.sinceCheck += content.length;
    return this.sinceCheck >= SAMPLE_INTERVAL ? this.repeatedTail() : 0;
  }

  repeatedTail() {
    this.sinceCheck = 0;
    const tail = this.tail;
    if (tail.length < MIN_REPEAT_CHARS) return 0;
    for (let period = 1; period <= Math.floor(tail.length / MIN_REPEATS); period++) {
      let start = tail.length - period;
      while (start > 0 && tail[start - 1] === tail[start - 1 + period]) start--;
      const count = tail.length - start;
      if (count >= Math.max(MIN_REPEAT_CHARS, MIN_REPEATS * period)) return count;
    }
    return 0;
  }
}

/** 退回已识别的尾部字符，保留此前正文的原始格式。 */
export function beforeRepeatedTail(text: string, count: number) {
  let end = text.length;
  while (end > 0 && count > 0) {
    if (/\S/.test(text[--end])) count--;
  }
  // 周期可能向前匹配到上一句的句号。收尾时保留该句的结束标点。
  if (end > 0 && /[。！？.!?]/.test(text[end] ?? "")) end++;
  return text.slice(0, end).trimEnd();
}

/** 两轮工具操作都只有已见过的结果时停止，交替重跑 A、B 也会触发。 */
export class ToolRepetition {
  private readonly results = new Map<string, string>();
  private unchangedSteps = 0;

  previous(key: string) { return this.results.get(key); }

  record(key: string, evidenceId: string) { this.results.set(key, evidenceId); }

  endStep(hasNewResult: boolean) {
    this.unchangedSteps = hasNewResult ? 0 : this.unchangedSteps + 1;
    return this.unchangedSteps >= 2;
  }
}
