import type { StreamChunk } from "./types";

/** 传输结束时缺少模型的结束信号。已收到的文字可保留，工具参数不能交给执行器。 */
export class ModelStreamInterrupted extends Error {
  constructor() {
    super("模型响应提前中断，已保留收到的内容。请重新生成或重试。");
    this.name = "ModelStreamInterrupted";
  }
}

/** 防止适配器直接结束迭代时，调用方误把未确认的响应当成完整结果。 */
export async function* requireModelEnd(stream: AsyncIterable<StreamChunk>, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
  let completed = false;
  for await (const chunk of stream) {
    if (chunk.type === "done") completed = true;
    yield chunk;
  }
  if (!completed && !signal?.aborted) throw new ModelStreamInterrupted();
}
