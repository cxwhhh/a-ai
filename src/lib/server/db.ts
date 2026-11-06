import "server-only";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 数据库：SQLite，整个库就是一个文件 .data/a.db。
 * 用 Node 自带的 node:sqlite（Node 22.13+），不需要装任何依赖。
 *
 * 所有业务表都带 user_id（或通过 session 间接属于某个用户），
 * 查询时一律加上 user_id 条件 —— 这就是“按用户隔离”。
 * 以后换 PostgreSQL：表结构基本不变，只需改这个文件和 store.ts 等数据访问层。
 */
export const DATA_DIR = path.resolve(process.env.A_DATA_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), ".data"));

const SCHEMA = `
-- 全局沙箱联网策略；无记录时兼容 A_SANDBOX_NETWORK，保存后以数据库为准。
CREATE TABLE IF NOT EXISTS sandbox_network (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- 登录状态：只存 token 的哈希，数据库泄露了也拿不到能用的 token
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0
);

-- 项目：name 和创建时间单独一列，其余设置（说明、记忆方式、是否共享）放在 data（JSON），以后加设置不用改表
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id, created_at);

-- 项目自己的记忆（项目设置里选了“项目独立记忆”时用），格式和 memories 一样。删项目时一起删
CREATE TABLE IF NOT EXISTS project_memories (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  group_id   TEXT REFERENCES groups(id) ON DELETE SET NULL,  -- 删掉分组，对话自动回到“未分组”
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id, updated_at DESC);

-- 一条消息一行：新增消息只 INSERT，不再整段重写
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,  -- 在对话里的顺序
  role       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data       TEXT NOT NULL      -- 完整的 StoredMessage（JSON）
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  data       TEXT NOT NULL      -- 完整的 Artifact（JSON）
);
CREATE INDEX IF NOT EXISTS artifacts_session ON artifacts(session_id, created_at);

-- 每个用户自己的设置（模型连接、API Key、主题……）
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data    TEXT NOT NULL
);

-- 长期记忆：每个用户一行，data 是 UserMemory（JSON）。删用户时一起删
CREATE TABLE IF NOT EXISTS memories (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 技能：从使用中自动总结的“做某类任务的固定做法”，每个技能一行，data 是 Skill（JSON）。
-- name 在同一个用户下唯一：自动学习时同名就是“改进已有的技能”
CREATE TABLE IF NOT EXISTS skills (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL,     -- pending / active / disabled
  updated_at INTEGER NOT NULL,
  data       TEXT NOT NULL,
  UNIQUE (user_id, name)
);

-- 审计日志：agent 执行过（或被拦下）的每一条命令 / 每一段 Python。不随对话删除
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  session_id   TEXT,
  tool         TEXT NOT NULL,     -- run_command / run_python
  command      TEXT NOT NULL,     -- 命令原文（Python 代码只存前 4000 字）
  cwd          TEXT,
  sandbox      TEXT,              -- docker / seatbelt / local
  decision     TEXT NOT NULL,     -- allowed / denied（用户拒绝）/ blocked（规则拦下）
  reason       TEXT,
  exit_code    INTEGER,
  timed_out    INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  output_chars INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_user ON audit_log(user_id, id DESC);

-- 用量日志：每一次模型调用（对话的每一步、上下文压缩、记忆整理）记一行。
-- 和对话分开存：删了对话，用量统计不会跟着变少（以前用量是从消息里现算的，删对话就丢了）
CREATE TABLE IF NOT EXISTS usage_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  session_id    TEXT,
  kind          TEXT NOT NULL,     -- chat / compact / reflect / learn
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_tokens  INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  estimated     INTEGER NOT NULL DEFAULT 0,  -- 1 = API 没返回用量，按字数估算
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_user ON usage_log(user_id, created_at);
`;

function open() {
  mkdirSync(DATA_DIR, { recursive: true });
  const d = new DatabaseSync(path.join(/*turbopackIgnore: true*/ DATA_DIR, "a.db"));
  d.exec("PRAGMA busy_timeout = 5000"); // 遇到别的进程正在写入时等一会儿，而不是直接报错（要最先设置）
  d.exec("PRAGMA journal_mode = WAL"); // 读写互不阻塞
  d.exec("PRAGMA foreign_keys = ON"); // 让 ON DELETE CASCADE 生效（SQLite 默认关闭）
  d.exec(SCHEMA);
  migrate(d);
  return d;
}

/**
 * 给旧数据库补新列。CREATE TABLE IF NOT EXISTS 不会改已经存在的表，所以新加的列要单独 ALTER：
 * 先查 PRAGMA table_info 看列在不在，不在才加，重复启动也不会出错。
 */
function migrate(d: DatabaseSync) {
  const has = (table: string, col: string) => d.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === col);
  // 对话属于哪个项目。删掉项目时对话不删，只是回到“不属于任何项目”
  if (!has("sessions", "project_id")) d.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL");
  if (!has("sessions", "group_sort")) d.exec("ALTER TABLE sessions ADD COLUMN group_sort INTEGER"); // 分组内手动拖拽的顺序，NULL = 没拖过
}

/**
 * 第一次用到时才打开数据库（不在模块加载时打开：next build 时会加载所有接口模块，不应该去碰数据库）。
 * 开发模式下代码热更新会重新执行模块，挂在 globalThis 上避免反复打开连接。
 */
const g = globalThis as unknown as { __aDb?: DatabaseSync };
export const db = () => (g.__aDb ??= open());

export function newId(prefix = "") {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 把几条写操作放进一个事务：要么全部成功，要么全部不生效 */
export function tx<T>(fn: () => T): T {
  db().exec("BEGIN");
  try {
    const r = fn();
    db().exec("COMMIT");
    return r;
  } catch (e) {
    db().exec("ROLLBACK");
    throw e;
  }
}
