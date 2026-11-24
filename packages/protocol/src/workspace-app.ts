/** 云应用的身份来自工作区，面板和应用数据都引用同一个部署 ID。 */
export interface WorkspaceAppSummary {
  id: string;
  title: string;
  revision: number;
  updatedAt: number;
  /** 创建应用时所在的项目。旧网页和独立对话的应用可以没有项目。 */
  projectId?: string;
}

export interface WorkspaceApp extends WorkspaceAppSummary {
  html: string;
}

export interface WorkspaceAppRecord {
  id: string;
  data: Record<string, unknown>;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type WorkspaceRecordCommand =
  | { action: "list"; before?: number }
  | { action: "create"; data: Record<string, unknown> }
  | { action: "update"; id: string; revision: number; data: Record<string, unknown> }
  | { action: "remove"; id: string; revision: number };

export type WorkspaceAppCommand =
  | { type: "list-apps" }
  | { type: "read-app"; appId: string; projectId?: string }
  | { type: "deploy-app"; appId?: string; title: string; html: string; projectId?: string; attachLegacy?: boolean }
  | { type: "records"; appId: string; command: WorkspaceRecordCommand };

export type WorkspaceAppReply =
  | { apps: WorkspaceAppSummary[] }
  | { app: WorkspaceApp }
  | { records: WorkspaceAppRecord[]; nextBefore?: number }
  | { record: WorkspaceAppRecord }
  | { removed: true }
  | { status: 400 | 404 | 409 | 413 | 503; error: string };

export const APP_RECORD_BYTES = 16_384;
export const APP_HTML_BYTES = 524_288;
// JSON 可以用最长六字符编码一个字符，工具入参和容器回复要留出转义空间。
export const APP_WORKER_JSON_CHARS = APP_HTML_BYTES * 6 + 4096;

export function isWorkspaceAppId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}
