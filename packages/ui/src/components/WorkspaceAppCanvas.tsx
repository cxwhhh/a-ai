"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { WorkspaceApp, WorkspaceAppReply, WorkspaceRecordCommand } from "../../../protocol/src/workspace-app";
import { KindIcon } from "./KindIcon";
import { IDownload, IX } from "./Icons";

interface AppMessage {
  id: number;
  command: WorkspaceRecordCommand;
}

/** 已部署页面从服务器读取。文档只通过自己的消息端口操作应用记录。 */
export function WorkspaceAppCanvas({ id, revision, title, outputSwitch, onClose }: {
  id: string; revision?: number; title: string; outputSwitch?: ReactNode; onClose(): void;
}) {
  const [state, setState] = useState<{ id: string; app?: WorkspaceApp; error?: string } | null>(null);
  const [attempt, retry] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const url = `/api/workspace-apps?id=${encodeURIComponent(id)}`;
  const current = state?.id === id ? state : null;
  const app = current?.app;

  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const result: WorkspaceAppReply = await response.json();
        if (controller.signal.aborted) return;
        if ("app" in result) setState({ id, app: result.app });
        else setState({ id, error: "error" in result ? result.error : "应用加载失败" });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ id, error: "应用加载失败" });
      });
    return () => controller.abort();
  }, [id, url, revision, attempt]);

  useEffect(() => {
    const iframe = frame.current;
    if (!iframe || !app) return;
    const controller = new AbortController();
    let port: MessagePort | undefined;
    let running = 0;
    const listen = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || event.origin !== "null" ||
          event.data !== "aai-records-connect" || port || event.ports.length !== 1) return;
      port = event.ports[0];
      port.onmessage = ({ data }: MessageEvent<AppMessage>) => {
        if (!Number.isSafeInteger(data?.id) || !data.command) return;
        const { id, command } = data;
        if (running >= 2) {
          port?.postMessage({ id, error: "请等待当前保存完成" });
          return;
        }
        running++;
        void Promise.resolve().then(() => fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
          signal: controller.signal,
        })).then((response) => response.json()).then((reply: WorkspaceAppReply) => {
          if ("error" in reply) port?.postMessage({ id, error: reply.error });
          else port?.postMessage({ id, reply });
        }).catch(() => {
          if (!controller.signal.aborted) port?.postMessage({ id, error: "连接中断，请重新读取记录后再试" });
        }).finally(() => { running--; });
      };
    };
    // 先准备接收，再开启 iframe 内联脚本。之后只用 MessagePort 回复数据。
    window.addEventListener("message", listen);
    iframe.srcdoc = appDocument(app.html);
    return () => {
      window.removeEventListener("message", listen);
      controller.abort();
      port?.close();
    };
  }, [app, url]);

  return (
    <section className="viewer" aria-label="账号应用">
      <div className="viewer-head">
        <KindIcon kind="web" tile className="viewer-icon" />
        <div className="viewer-title ellipsis">{app?.title ?? title}</div>
        <div className="spacer" />
        {app && <a className="icon-btn" href={`${url}&download=1`} download title="下载网页源码"><IDownload /></a>}
        {outputSwitch}
        <button className="icon-btn" onClick={onClose} title="关闭 Esc"><IX /></button>
      </div>
      <div className="viewer-body">
        {app ? <iframe key={app.id} ref={frame} className="frame" sandbox="allow-scripts allow-forms" title={app.title} />
          : current?.error ? (
            <div className="view-empty" role="status">
              <p>{current.error}</p>
              <button className="btn" onClick={() => { setState(null); retry((n) => n + 1); }}>重新加载</button>
            </div>
          ) : <div className="view-empty" role="status">正在打开应用…</div>}
      </div>
    </section>
  );
}

function appDocument(html: string) {
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";
  // 应用脚本运行在不带登录凭据的独立文档。父窗口只将专用端口绑定到当前应用。
  const bridge = `
    (() => {
      const channel = new MessageChannel();
      parent.postMessage("aai-records-connect", ${JSON.stringify(window.location.origin)}, [channel.port2]);
      let next = 0;
      const waiting = new Map();
      channel.port1.onmessage = ({data}) => {
        const call = waiting.get(data.id);
        if (!call) return;
        waiting.delete(data.id);
        clearTimeout(call.timer);
        if (data.error) call.reject(new Error(data.error));
        else call.resolve(data.reply);
      };
      function request(command) {
        return new Promise((resolve, reject) => {
          const id = ++next;
          const timer = setTimeout(() => {
            waiting.delete(id);
            reject(new Error("保存或读取超时，请重新读取记录"));
          }, 18000);
          waiting.set(id, {resolve, reject, timer});
          try { channel.port1.postMessage({id, command}); }
          catch (error) { clearTimeout(timer); waiting.delete(id); reject(error); }
        });
      }
      window.aai = Object.freeze({records: Object.freeze({
        list: ({before} = {}) => request({action:"list", before}),
        create: async (data) => (await request({action:"create", data})).record,
        update: async (id, revision, data) => (await request({action:"update", id, revision, data})).record,
        remove: async (id, revision) => (await request({action:"remove", id, revision})).removed
      })});
    })();
  `;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><script>${bridge}</script>${html.replace(/^\s*<!doctype\s+html[^>]*>/i, "")}`;
}
