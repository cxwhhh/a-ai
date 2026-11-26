"use client";

import { useState } from "react";
import { extOf, iconForExt } from "../../../protocol/src/lib/outputs";
import { cx } from "../utils/cx";
import { api } from "../lib/client";
import { join, useFile } from "./FileDrawer";
import { IChevron } from "./Icons";
import { KindIcon } from "./KindIcon";
import { Button } from "./shadcn/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./shadcn/collapsible";

/** 目录展开时读取一层。用户可从旧账号工作区挑选文件复制进当前对话。 */
export function FileTree({ sessionId, activePath, refreshKey, canImport, onOpen }: {
  sessionId: string; activePath?: string; refreshKey: string; canImport: boolean; onOpen(path: string): void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [legacy, setLegacy] = useState(false);
  const [importFolders, setImportFolders] = useState<ReadonlySet<string>>(() => new Set());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [importCount, setImportCount] = useState(0);
  async function importFile(path: string) {
    if (importing) return;
    setImporting(true);
    setError("");
    try {
      await api.importLegacyFile(sessionId, path);
      setLegacy(false);
      setImportFolders(new Set());
      // 导入保留相对路径，展开父级后就能在对话树中看到新文件。
      const parents = path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"));
      setExpanded((previous) => new Set([...previous, ...parents]));
      setImportCount((count) => count + 1);
      onOpen(path);
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法导入文件");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="workspace-file-tree">
      {sessionId ? <FileTreeBranch sessionId={sessionId} path="." legacy={false}
        refreshKey={`${refreshKey}:${importCount}`} activePath={activePath}
        expanded={expanded} setExpanded={setExpanded} onOpen={onOpen} />
        : <div className="panel-empty">工作区暂无文件。</div>}
      {error && <div className="panel-empty" role="alert">{error}</div>}
      {sessionId && canImport && (
        <Collapsible open={legacy} onOpenChange={setLegacy} className="workspace-tree-import">
          <CollapsibleTrigger render={<Button className="workspace-tree-row" />} disabled={importing}>
            <IChevron className="workspace-tree-chevron" width={13} height={13} aria-hidden />
            从旧工作区导入
          </CollapsibleTrigger>
          <CollapsibleContent aria-label="旧工作区文件">
            <FileTreeBranch sessionId={sessionId} path="." legacy refreshKey={refreshKey}
              expanded={importFolders} setExpanded={setImportFolders} onOpen={(path) => void importFile(path)} />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function FileTreeBranch({ path, ...props }: {
  path: string;
  sessionId: string;
  legacy: boolean;
  refreshKey: string;
  activePath?: string;
  expanded: ReadonlySet<string>;
  setExpanded(update: (previous: ReadonlySet<string>) => ReadonlySet<string>): void;
  onOpen(path: string): void;
}) {
  const { res } = useFile(props.sessionId, path, props.refreshKey, true, props.legacy);
  if (!res) return <div className="panel-empty" role="status">读取中…</div>;
  if ("error" in res) {
    const message = path === "." && res.error === "文件不存在" ? "工作区暂无文件。" : res.error;
    return <div className="panel-empty" role="status">{message}</div>;
  }
  if (res.type !== "dir") return <div className="panel-empty" role="status">此路径已不是目录。</div>;
  if (!res.items.length) return <div className="panel-empty">{path === "." ? "工作区暂无文件。" : "空目录"}</div>;

  return (
    <ul className="workspace-tree-list" role="list">
      {res.items.map((entry) => {
        const childPath = join(path, entry.name);
        const active = props.activePath === childPath;
        return (
          <li key={childPath}>
            {entry.dir ? (
              <Collapsible open={props.expanded.has(childPath)} onOpenChange={(open) => props.setExpanded((previous) => {
                const next = new Set(previous);
                if (open) next.add(childPath);
                else next.delete(childPath);
                return next;
              })}>
                <CollapsibleTrigger render={<Button className="workspace-tree-row" />} title={childPath}>
                  <IChevron className="workspace-tree-chevron" width={13} height={13} aria-hidden />
                  <KindIcon kind="folder" />
                  <span className="ellipsis">{entry.name}</span>
                </CollapsibleTrigger>
                <CollapsibleContent className="workspace-tree-children">
                  <FileTreeBranch {...props} path={childPath} />
                </CollapsibleContent>
              </Collapsible>
            ) : (
              <Button className={cx("workspace-tree-row workspace-tree-file", active && "active")} aria-current={active || undefined}
                title={props.legacy ? `导入 ${childPath}` : childPath} onClick={() => props.onOpen(childPath)}>
                <KindIcon kind={iconForExt(extOf(entry.name))} />
                <span className="ellipsis">{entry.name}</span>
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
