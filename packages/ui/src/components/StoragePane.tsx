"use client";
import { useEffect, useState } from "react";
import { IconButton } from "./base/buttons/icon-button";
import { IRetry } from "./Icons";

type Usage = { bytes: number; count: number };
type StorageState = {
  admin: boolean;
  mode: string;
  limitMiB: number;
  workspace: { uploads: number; output: number; other: number };
  managed: Record<"run" | "cache" | "test" | "evaluation" | "report", Usage>;
  dockerCache: { containers: number; bytes: number | null; scratchBytes: number | null };
};
const format = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;

export function StoragePane() {
  const [data, setData] = useState<StorageState | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [quota, setQuota] = useState(512);
  const load = async () => {
    const response = await fetch("/api/storage", { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取存储用量");
    const snapshot: StorageState = await response.json();
    setData(snapshot);
    setQuota(snapshot.limitMiB);
  };
  useEffect(() => { void load().catch((error) => setStatus(error.message)); }, []);

  const change = async (action: string) => {
    setBusy(true);
    setStatus("");
    try {
      if (action === "refresh") await load();
      else {
        const response = await fetch("/api/storage", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, mib: quota }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "操作失败");
        await load();
        setStatus(action === "set-quota" ? "配额已保存，从下一轮临时执行开始生效。"
          : `已回收 ${result.removed} 项${result.failed ? `，${result.failed} 项暂无法回收` : ""}。`);
      }
    } catch (error) { setStatus(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  };

  return (
    <section className="set-sec">
      <div className="set-sec-head"><div className="flex items-center justify-between"><h3>存储占用</h3><IconButton icon={IRetry} size="small" aria-label="刷新存储用量" disabled={busy} onClick={() => void change("refresh")} /></div></div>
      {data ? <div className="set-group">
        <div className="set-row"><span className="set-label">上传附件</span><span>{format(data.workspace.uploads)}</span></div>
        <div className="set-row"><span className="set-label">交付文件</span><span>{format(data.workspace.output)}</span></div>
        <div className="set-row"><span className="set-label">其他工作区文件</span><span>{format(data.workspace.other)}</span></div>
        <div className="set-row"><span className="set-label">运行暂存文件</span><span>{data.dockerCache.scratchBytes === null ? "部分容器用量暂不可用" : format(data.managed.run.bytes + data.dockerCache.scratchBytes)}</span></div>
        <div className="set-row"><span className="set-label">工具缓存</span>
          <div className="set-ctl gap-3">
            <span>{data.dockerCache.bytes === null ? "部分容器用量暂不可用" : format(data.managed.cache.bytes + data.dockerCache.bytes)}</span>
            <button className="btn ghost" disabled={busy} onClick={() => void change("clear-cache")}>清理空闲缓存</button>
          </div>
        </div>
        {data.admin && <>
          <div className="set-row"><span className="set-label">测试现场</span><div className="set-ctl gap-3">
            <span>{format(data.managed.test.bytes + data.managed.evaluation.bytes)}</span>
            <button className="btn ghost" disabled={busy} onClick={() => { if (window.confirm("删除已结束测试的临时现场？测评报告将保留。")) void change("clear-tests"); }}>清理测试文件</button>
          </div></div>
          <div className="set-row"><span className="set-label">测评报告</span><span>{format(data.managed.report.bytes)}</span></div>
        </>}
        {data.mode === "docker" && <div className="set-row">
          <div><label className="set-label" htmlFor="storage-quota">单轮临时空间</label><div className="set-hint">Docker 临时执行和该容器的缓存共用</div></div>
          {data.admin ? <div className="set-ctl gap-3">
            <input id="storage-quota" className="set-input" type="number" min={32} max={512} step={1} value={quota} onChange={(event) => setQuota(Number(event.target.value))} />
            <button className="btn ghost" disabled={busy || quota === data.limitMiB || !Number.isInteger(quota) || quota < 32 || quota > 512} onClick={() => void change("set-quota")}>保存 MiB</button>
          </div> : <span id="storage-quota">{data.limitMiB} MiB</span>}
        </div>}
      </div> : !status && <p className="set-hint">正在读取存储用量</p>}
      <p className="set-hint" role="status">{status}</p>
    </section>
  );
}
