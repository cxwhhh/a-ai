"use client";
import { useLayoutEffect, useRef } from "react";
import "./WebThumbnail.css";

const VIEWPORT_WIDTH = 960;
const PREVIEW_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

/** 用桌面宽度排版网页再缩小。缩略图不可操作，完整应用在用户点开后才运行。 */
export function WebThumbnail(props: { appId: string; revision: number } | { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useLayoutEffect(() => {
    const element = frame.current;
    const container = element?.parentElement;
    if (!element || !container) return;
    const resize = () => {
      const { clientWidth, clientHeight } = container;
      if (!clientWidth || !clientHeight) return;
      const scale = clientWidth / VIEWPORT_WIDTH;
      element.style.height = `${Math.ceil(clientHeight / scale)}px`;
      element.style.transform = `scale(${scale})`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const source = "appId" in props
    ? { src: `/api/workspace-apps?${new URLSearchParams({ id: props.appId, thumbnail: "1", revision: String(props.revision) })}` }
    : { srcDoc: `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}">${props.html.replace(/^\s*<!doctype\s+html[^>]*>/i, "")}` };
  return (
    <span className="web-thumbnail" aria-hidden="true" inert>
      <iframe ref={frame} {...source} width={VIEWPORT_WIDTH} loading="lazy" sandbox="" tabIndex={-1}
        referrerPolicy="no-referrer" title="网页缩略图" />
    </span>
  );
}
