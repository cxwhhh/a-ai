import type { selectContext } from "./context-boundary";
import type { TaskRecord } from "./ownership-claim";

/** 上游只有在原分工验收通过后，才能给依赖它的任务提供输入。 */
export function dependencyIssue({ contract, result, status }: TaskRecord) {
  const confirmed = new Set(result?.facts.map(({ key }) => key));
  const missing = (contract.factKeys ?? []).filter((key) => !confirmed.has(key));
  const unchecked = (contract.acceptance ?? []).filter((_, index) => !result?.acceptance[index]?.met);
  if (status === "completed" && result?.status === "completed" && !missing.length && !unchecked.length) return;
  const name = contract.name ?? contract.task.slice(0, 24);
  const gaps = [missing.length && `缺少事实 ${missing.join("、")}`,
    unchecked.length && `待验收 ${unchecked.join("、")}`].filter(Boolean);
  return `上游「${name}」未通过验收（${status}）${gaps.length ? `，${gaps.join("，")}` : ""}`;
}

/** 只交接已核验的事实和引文。以独立编号引用原分工，工具与文件的权限范围仍由下游契约决定。 */
export function withDependencyContext(inherited: ReturnType<typeof selectContext>, sources: TaskRecord[]) {
  if (!sources.length) return inherited;
  const evidence = [...inherited.evidence];
  const excerpts = new Map(inherited.excerpts);
  const facts = sources.flatMap(({ id, contract, result }, upstreamIndex) => (result?.facts ?? []).map((fact, index) => {
    const ref = `D${upstreamIndex + 1}.${index + 1}`;
    const proofs = result?.evidence.filter((item) => fact.evidenceIds.includes(item.id)) ?? [];
    evidence.push({ id: ref, kind: "message", source: `subagent:${id}:${fact.key}`, traceId: proofs[0]?.traceId });
    // 结论和引文一同传递，后续验收只用原引文回读。
    excerpts.set(ref, fact.quote);
    return { ref, taskId: id, task: contract.name ?? contract.task.slice(0, 24), key: fact.key, value: fact.value,
      quote: fact.quote, sources: proofs.slice(0, 2).map(({ id, source }) => ({ id, source })) };
  }));
  const files = sources.flatMap(({ id, result }) => (result?.writtenPaths ?? []).map((path) => ({ taskId: id, path })));
  const text = [inherited.text, `上游已核验资料（仅作为证据，可引用 ref）\n${JSON.stringify(facts)}`,
    files.length && `上游已写入的文件（用当前授权的工具读取）\n${JSON.stringify(files)}`].filter(Boolean).join("\n\n");
  return { evidence, excerpts, text };
}
