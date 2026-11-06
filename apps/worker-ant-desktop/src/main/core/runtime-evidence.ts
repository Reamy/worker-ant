/**
 * zx_20261105_1 M1（佛学·缘起 / 王阳明·知行合一）：**运行证据**——判卷可引用的执行留痕。
 *
 * 病根（真库标本 `16074137`）：判卷只看"模型有没有说没通过"，不看"这件事到底跑没跑"。
 * 该任务判据含「重启后端不报错」，全会话却只有 `read_file/list_files/search_content`，
 * 从未重启、从未执行命令，账上仍是 `verified:true, 2/2`。
 *
 * 治法：把每次真正落到 shell 的动作（成功/失败/超时/被守卫拒绝）记进独立表，判卷条目的
 * `evidence_refs` 只能引用本任务账上的 `run:<id>`。独立表而非 `context_json`：
 * 后者是高频读改写热点，每步一条 JSON 写入既放大覆写兄弟键的风险，也无法按任务检索。
 *
 * 纪律：写入 best-effort（证据缺失不得拖垮执行）；命令脱敏并截断；只读函数失败返回空集。
 * 本模块零 electron 依赖，rr 可直跑真实现。
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

/** 建表真源——`database.ts` 与 rr 夹具**同引这一份**（防夹具与生产建表漂移）。 */
export const RUNTIME_EVIDENCE_DDL = `
  CREATE TABLE IF NOT EXISTS wa_task_runtime_evidence (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    command TEXT,
    ok INTEGER NOT NULL,
    exit_code INTEGER,
    timed_out INTEGER NOT NULL DEFAULT 0,
    deny_reason TEXT,
    output_path TEXT,
    output_tail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rt_ev_task ON wa_task_runtime_evidence(task_id, created_at);
`;

export interface RuntimeEvidenceRow {
  id: string;
  task_id: string;
  tool: string;
  command: string | null;
  ok: number;
  exit_code: number | null;
  timed_out: number;
  deny_reason: string | null;
  output_path: string | null;
  output_tail: string | null;
  created_at: string;
}

export interface RecordRuntimeEvidenceInput {
  taskId: string;
  tool: string;
  command?: string;
  ok: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  denyReason?: string;
  /**
   * zx_20261105_1 M6：拒绝类别（`exploration_limit` / `illegal_char` / `not_in_whitelist` / `destructive`）。
   * 不新增列——落库时并入 `deny_reason` 前缀（`deny_kind=<kind>; <原因>`），任务详情「运行证据」照现有格式可见。
   */
  denyKind?: string;
  outputPath?: string;
  outputTail?: string;
}

const COMMAND_LIMIT = 500;
const TAIL_LIMIT = 2000;

/**
 * 命令脱敏：把显式口令/令牌值换成 `***`（保留键名以便判卷知道跑的是什么），
 * 再对常见密钥前缀做遮蔽。只在**落库**这一层做，模型可见的工具回话逐字节不变。
 */
export function redactCommand(raw: string): string {
  return raw
    .replace(/(--?(?:password|passwd|token|secret|api[-_]?key)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY))=("[^"]*"|'[^']*'|\S+)/g, '$1=***')
    .replace(/\b(sk|ak)_[A-Za-z0-9_-]{8,}/g, '$1_***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
}

export function evidenceIdOf(row: Pick<RuntimeEvidenceRow, 'id'>): string {
  return `run:${row.id}`;
}

/**
 * 拒绝原因的落库形态：`deny_kind=<kind>; <原因>`（无 kind 时原样截断）。
 * **只**影响证据账；工具回给模型的 JSON 不经此函数（模型可见文案逐字节不变）。
 */
export function denyReasonText(reason: unknown, kind?: unknown): string | null {
  if (reason == null && kind == null) return null;
  const text = reason == null ? '' : String(reason);
  const k = kind == null ? '' : String(kind).trim();
  return ((k ? `deny_kind=${k}; ` : '') + text).slice(0, COMMAND_LIMIT);
}

/** 只 INSERT；写失败返回 null（证据缺失不得拖垮执行）。返回原始行 id（引用时经 `evidenceIdOf`）。 */
export function recordRuntimeEvidence(db: Database.Database, input: RecordRuntimeEvidenceInput): string | null {
  try {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO wa_task_runtime_evidence
        (id, task_id, tool, command, ok, exit_code, timed_out, deny_reason, output_path, output_tail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.taskId,
      String(input.tool || 'unknown'),
      input.command == null ? null : redactCommand(String(input.command)).slice(0, COMMAND_LIMIT),
      input.ok ? 1 : 0,
      input.exitCode == null ? null : input.exitCode,
      input.timedOut ? 1 : 0,
      denyReasonText(input.denyReason, input.denyKind),
      input.outputPath == null ? null : String(input.outputPath),
      input.outputTail == null ? null : String(input.outputTail).slice(-TAIL_LIMIT),
      new Date().toISOString(),
    );
    return id;
  } catch {
    return null; // 表不存在/写盘失败：判卷少一条证据，不阻断执行
  }
}

/** 本任务的运行证据，按时间倒序；读失败返回空集（不抛）。 */
export function listRuntimeEvidence(db: Database.Database, taskId: string, limit = 20): RuntimeEvidenceRow[] {
  try {
    return db.prepare(
      'SELECT * FROM wa_task_runtime_evidence WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ).all(taskId, Math.max(1, limit)) as RuntimeEvidenceRow[];
  } catch {
    return [];
  }
}

const oneLine = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * 固定格式、可反证：`[运行证据 run:<id>] tool=… ok=… exit=… timedOut=… cmd=… tail=…`，
 * 被守卫拒绝者以 `deny=<原因>` 代替退出码/输出。判卷提示词引用 `run:<id>` 即引这一段。
 */
export function renderRuntimeEvidence(rows: readonly RuntimeEvidenceRow[] | null | undefined): string {
  return (rows ?? []).map((r) => {
    const head = `[运行证据 ${evidenceIdOf(r)}] tool=${r.tool} ok=${r.ok ? 1 : 0}`;
    if (r.deny_reason) return `${head} deny=${oneLine(r.deny_reason, 300)} cmd=${oneLine(r.command ?? '', 300)}`;
    const exit = r.exit_code == null ? '-' : String(r.exit_code);
    return `${head} exit=${exit} timedOut=${r.timed_out ? 1 : 0} cmd=${oneLine(r.command ?? '', 300)} tail=${oneLine(r.output_tail ?? '', TAIL_LIMIT)}`;
  }).join('\n');
}
