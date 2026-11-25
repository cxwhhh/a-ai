import { STATUS_LABEL } from "../../protocol/src/lib/shared";
import type { ErrorKind, ToolStatus } from "../../protocol/src/lib/shared";
import { REASONING_EFFORTS } from "../../protocol/src/lib/reasoning-effort";
import type { DatabaseSync } from "node:sqlite";

/** 字符串数组声明可用枚举值。ID 要求非空，计数从 0 开始，步骤号从 1 开始。 */
type FieldType = "text" | "id" | "number" | "count" | "step" | "boolean" | readonly string[];

/** 字段默认必填。nullable 接受显式 null，optional 允许对象里缺少该键。 */
type Field = FieldType | {
  type: FieldType;
  nullable?: true;
  optional?: true;
};

type Scope = "run-input" | "run" | "input" | "session";

const nullable = <T extends FieldType>(type: T) => ({
  type,
  nullable: true
} as const);
const optional = <T extends FieldType>(type: T) => ({
  type,
  optional: true
} as const);
const optionalNullable = <T extends FieldType>(type: T) => ({
  type,
  optional: true,
  nullable: true
} as const);

const modelSelection = {
  model: "id",
  effort: REASONING_EFFORTS,
} as const;

const modelStep = {
  ...modelSelection,
  step: "step",
} as const;

const archive = {
  target: ["session", "project"],
  targetId: "id",
} as const;

const errorKinds = ["args", "exit", "blocked", "unavailable", "tool", "dependency", "protocol", "network"] as const satisfies readonly ErrorKind[];
const toolStatuses = Object.keys(STATUS_LABEL) as ToolStatus[];

/**
 * 逐事件定义作用域和明细。types.ts 从这里推导事件联合类型，SQLite 用它生成写入约束。
 * 新增事件时一起声明明细和作用域。例如工具结果需要当前轮的 runId 和 inputId，
 * 以及该步的 callId。耗时缺失时写 null，durationMs 字段仍须存在。
 */
export const agentLogSchema = {
  /** 当前运行接收待处理输入。日志保存预览，完整正文存在实例队列里。 */
  queued: {
    scope: "run-input",
    detail: {
      target: ["next-turn", "next-step"],
      preview: "text",
    },
  },
  /** 已在队列里的普通输入被改为当前轮的下一步引导。 */
  steered: {
    scope: "run-input",
    detail: {
      target: ["next-step"],
    },
  },
  /** 主输入已经写入会话，后续是否进入模型由 model-request 确认。 */
  accepted: {
    scope: "run-input",
    detail: {
      preview: "text",
    },
  },
  /** 引导正文已写入会话。turnInputId 关联本轮主输入，缺少主输入时为 null。 */
  guidance: {
    scope: "run-input",
    detail: {
      turnInputId: nullable("id"),
      preview: "text",
    },
  },
  /** 运行收尾时尚未写入会话的引导被转回普通排队。 */
  deferred: {
    scope: "input",
    detail: {
      reason: "text",
    },
  },
  /** 排队输入在执行前被移除。运行中的取消通过 stop-requested 和 turn-end 记录。 */
  cancelled: {
    scope: "input",
    detail: {
      reason: "text",
    },
  },
  /** 记录编辑或重发产生的历史修订。模型输出触及长度限制由模型和轮次结果记录。 */
  truncated: {
    scope: "input",
    detail: {
      revision: "id",
      reason: ["edit", "regenerate", "resend"],
      cutMessageId: "id",
      preview: "text",
    },
  },
  /** 标记主输入所属轮次的开始，输入内容可由 inputId 关联。 */
  "turn-start": {
    scope: "run-input",
    detail: {},
  },
  /** 一轮执行的最终结果。一条聊天流可包含多个有各自结果的轮次。 */
  "turn-end": {
    scope: "run-input",
    detail: {
      outcome: ["completed", "cancelled", "failed", "waiting-for-answer", "output-truncated", "interrupted"],
    },
  },
  /** 进入模型循环的一步，随后可能准备上下文、发起模型请求和执行工具。 */
  "step-start": {
    scope: "run-input",
    detail: modelStep,
  },
  /** 此步已经走到收尾边界。结果和工具副作用仍要查对应事件。 */
  "step-end": {
    scope: "run-input",
    detail: modelStep,
  },
  /** 运行收到取消信号。执行方可能仍在等待工具退出或写回结果。 */
  "stop-requested": {
    scope: "run",
    detail: {
      reason: "text",
    },
  },
  /** 主循环开始一次模型请求，记录输入规模和进入请求的引导 ID。 */
  "model-request": {
    scope: "run-input",
    detail: {
      ...modelStep,
      // 逗号分隔的引导 ID 用于按输入查询与轮次投影。
      guidanceIds: "text",
      messageCount: "count",
      toolCount: "count",
    },
  },
  /** 本次模型调用的结果。一个模型结果可能还带有待执行的工具调用。 */
  "model-result": {
    scope: "run-input",
    detail: {
      ...modelStep,
      guidanceIds: "text",
      outcome: ["completed", "cancelled", "failed", "output-truncated"],
      durationMs: "number",
      messageId: "id",
      // 失败可能发生在用量返回前，此时省略指标。
      finishReason: optionalNullable("text"),
      inputTokens: optional("count"),
      outputTokens: optional("count"),
      estimatedUsage: optional("boolean"),
      toolCalls: optional("count"),
    },
  },
  /** 工具进入执行阶段，后续用轮次、步骤号和调用 ID 配对结果。 */
  "tool-start": {
    scope: "run-input",
    detail: {
      step: "step",
      callId: "id",
      name: "id",
    },
  },
  /** 工具结果及其可用的耗时、错误类别和产出引用。 */
  "tool-result": {
    scope: "run-input",
    detail: {
      step: "step",
      callId: "id",
      status: toolStatuses,
      durationMs: nullable("number"),
      errorKind: nullable(errorKinds),
      artifactId: nullable("id"),
    },
  },
  /** 工具产生的产出物引用。正文和实际文件由产出存储负责。 */
  artifact: {
    scope: "run-input",
    detail: {
      artifactId: "id",
      title: "text",
      path: nullable("text"),
    },
  },
  /** 会话保存新的模型和强度选择，实际请求用到的配置另见步骤事件。 */
  "model-selected": {
    scope: "session",
    detail: modelSelection,
  },
  /** 会话受一次归档影响，target 区分由会话还是所属项目发起。 */
  archived: {
    scope: "session",
    detail: archive,
  },
  /** 归档标记被解除。项目恢复后，独立归档的会话仍需单独恢复。 */
  restored: {
    scope: "session",
    detail: archive,
  },
} as const satisfies Record<string, {
  scope: Scope;
  detail: Record<string, Field>;
}>;

type PrimitiveValue<T> =
  T extends readonly string[] ? T[number] :
  T extends "number" | "count" | "step" ? number :
  T extends "boolean" ? boolean :
  string;

type FieldValue<T> = T extends { type: infer Type }
  ? PrimitiveValue<Type> | (T extends { nullable: true } ? null : never)
  : PrimitiveValue<T>;

type Detail<Fields> = keyof Fields extends never
  ? Record<string, never>
  : {
      -readonly [Key in keyof Fields as Fields[Key] extends { optional: true } ? never : Key]: FieldValue<Fields[Key]>;
    } & {
      -readonly [Key in keyof Fields as Fields[Key] extends { optional: true } ? Key : never]?: FieldValue<Fields[Key]>;
    };

export type AgentLogDetail<K extends keyof typeof agentLogSchema> = Detail<(typeof agentLogSchema)[K]["detail"]>;

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
const nonEmpty = (value: string) => `length(trim(${value}, char(9, 10, 13, 32))) > 0`;

function valueCheck(type: FieldType, jsonType: string, value: string): string {
  if (typeof type !== "string") return `${jsonType} = 'text' AND ${value} IN (${type.map(sqlString).join(", ")})`;
  switch (type) {
    case "text": return `${jsonType} = 'text'`;
    case "id": return `${jsonType} = 'text' AND ${nonEmpty(value)}`;
    case "number": return `${jsonType} IN ('integer', 'real') AND ${value} BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308`;
    case "count": return `${jsonType} = 'integer' AND ${value} BETWEEN 0 AND 9007199254740991`;
    case "step": return `${jsonType} = 'integer' AND ${value} BETWEEN 1 AND 9007199254740991`;
    case "boolean": return `${jsonType} IN ('true', 'false')`;
  }
}

/** json_type 可区分键缺失产生的 SQL NULL 和字段值显式写入的 JSON null。 */
function fieldCheck(path: string, field: Field): string {
  const jsonType = `json_type(detail, ${path})`;
  const value = `json_extract(detail, ${path})`;
  if (typeof field !== "object" || !("type" in field)) return valueCheck(field, jsonType, value);
  const checks = [`(${valueCheck(field.type, jsonType, value)})`];
  if (field.optional) checks.push(`${jsonType} IS NULL`);
  if (field.nullable) checks.push(`${jsonType} = 'null'`);
  return checks.join(" OR ");
}

const scopeChecks: Record<Scope, string> = {
  "run-input": "run_id IS NOT NULL AND input_id IS NOT NULL",
  run: "run_id IS NOT NULL",
  input: "input_id IS NOT NULL",
  session: "run_id IS NULL AND input_id IS NULL",
};

/** 对象形状、未知字段和 NULL 都在 SQL 边界检查，直接写库也服从同一契约。 */
function agentLogSqlCheck(): string {
  const cases = Object.entries(agentLogSchema).map(([kind, rule]) => {
    const fields = Object.entries(rule.detail).map(([key, field]) => [sqlString(`$.${key}`), field] as const);
    // 移除所有已声明字段后必须是空对象，才能防止拼错的字段名或其他事件的字段悄悄落库。
    const remaining = fields.length ? `json_remove(detail, ${fields.map(([path]) => path).join(", ")})` : "json(detail)";
    const checks = [scopeChecks[rule.scope], `${remaining} = '{}'`, ...fields.map(([path, field]) => `(${fieldCheck(path, field)})`)];
    return `WHEN ${sqlString(kind)} THEN (${checks.join(" AND ")})`;
  });
  // CHECK 会放行 NULL，必填字段缺失必须明确判为不符合约束。
  return `COALESCE(CASE WHEN json_valid(detail) = 1
    THEN json_type(detail) = 'object'
      AND (run_id IS NULL OR ${nonEmpty("run_id")})
      AND (input_id IS NULL OR ${nonEmpty("input_id")})
      AND CASE kind ${cases.join("\n")} ELSE 0 END
    ELSE 0 END, 0)`;
}

/**
 * 在调用者的事务内创建或升级事件表。已有记录先复制到新表接受校验，再替换原表。
 * 任一记录未通过约束时抛错，由调用者回滚。已带当前约束标记的表直接复用。
 * 事件约束有变动时要更新版本标记和迁移，使已部署的表也能应用新定义。
 */
export function migrateAgentLogTable(db: DatabaseSync): void {
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_events'").get();
  if (typeof existing?.sql === "string" && existing.sql.includes("CONSTRAINT agent_event_contract_v2")) return;

  const table = existing ? "agent_events_next" : "agent_events";
  db.exec(`CREATE TABLE ${table} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    run_id TEXT,
    input_id TEXT,
    detail TEXT NOT NULL,
    CONSTRAINT agent_event_contract_v2 CHECK (${agentLogSqlCheck()})
  ) STRICT`);
  if (existing) {
    const previousSequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'agent_events'").get();
    db.exec(`INSERT INTO agent_events_next(id, session_id, at, kind, run_id, input_id, detail)
      SELECT id, session_id, at, kind, run_id, input_id, detail FROM agent_events;
      DROP TABLE agent_events;
      ALTER TABLE agent_events_next RENAME TO agent_events;`);
    // 已删除的事件 ID 也不能被重用，否则客户端的旧游标可能跳过新日志。
    if (previousSequence) {
      db.prepare(`INSERT INTO sqlite_sequence(name, seq)
        SELECT 'agent_events', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'agent_events')`).run();
      db.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'agent_events'").run(previousSequence.seq);
    }
  }
  db.exec("CREATE INDEX agent_events_session ON agent_events(session_id, id DESC)");
}
