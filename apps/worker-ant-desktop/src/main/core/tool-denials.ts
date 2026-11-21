/**
 * zx_20261119_2 M7「度」——**工具拒绝计数与步数账**（零 electron，rr 可直跑）。
 *
 * 病根（真标本 S7/S8）：一次成功任务链路里工具被拒 40+ 次（`exploration_limit` 17、
 * `illegal_char` 17、重定向 4），另一个子任务 90 步（估算 25 步）被迫收尾——但收口账上
 * 只有"总分"，没有任何一笔能说明"这 90 步里有多少花在撞墙上"。
 *
 * 本模块只记账，不改评分、不改步数上限、不改续额策略。
 * 计数来源：`wa_task_runtime_evidence.deny_reason`（只有**被拒**才写），按 `deny_kind` 归类；
 * 步数来源：`context_json.execution_metrics.stepsUsed` + `task_estimate.steps` + `step_cap_grants`。
 */
/** 最小库接口（`get` 供文本字段、`run` 供落账）——与 `task-outcome.TaskOutcomeDb` 同形可互传。 */
export interface DenialDb {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): { changes?: number };
  };
}

export interface DenialSummary {
  /** 被拒次数（= 有 deny_reason 的行数） */
  total: number;
  /** 按类别计数（`deny_kind`；无该字段的按文案归类，归不了进 `other`） */
  byKind: Record<string, number>;
  /** 本轮运行证据总条数 */
  calls: number;
  /** 其中成功条数 */
  ok: number;
}

/** `deny_kind=…` 优先；历史文案没有该字段的按已知措辞归类；仍归不了进 `other`。 */
export function denialKindOf(reason: string): string {
  const m = /deny_kind=([a-z_]+)/.exec(String(reason ?? ''));
  if (m) return m[1]!;
  const s = String(reason ?? '');
  if (/重定向被禁止/.test(s)) return 'redirect';
  if (/不在只读白名单/.test(s)) return 'not_in_whitelist';
  if (/破坏性命令/.test(s)) return 'destructive';
  return 'other';
}

export function summarizeToolDenials(db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } }, taskId: string): DenialSummary {
  const out: DenialSummary = { total: 0, byKind: {}, calls: 0, ok: 0 };
  try {
    const rows = db.prepare('SELECT ok, deny_reason FROM wa_task_runtime_evidence WHERE task_id = ?')
      .all(taskId) as Array<{ ok?: number | null; deny_reason?: string | null }>;
    out.calls = rows.length;
    for (const r of rows) {
      if (Number(r.ok) === 1) out.ok++;
      const reason = String(r.deny_reason ?? '').trim();
      if (!reason) continue;
      out.total++;
      const kind = denialKindOf(reason);
      out.byKind[kind] = (out.byKind[kind] || 0) + 1;
    }
  } catch {
    /* 读不到运行证据 ⇒ 全 0（不编） */
  }
  return out;
}

export interface StepsLedger {
  used: number;
  estimate: number;
  grants: number;
}

export function readStepsLedger(ctxJson: unknown): StepsLedger | null {
  const ctx = (ctxJson && typeof ctxJson === 'object' ? ctxJson : {}) as Record<string, unknown>;
  const used = Number((ctx.execution_metrics as { stepsUsed?: unknown } | undefined)?.stepsUsed) || 0;
  if (used <= 0) return null;
  const estimate = Number((ctx.task_estimate as { steps?: unknown } | undefined)?.steps) || 0;
  const grants = Number(ctx.step_cap_grants) || 0;
  return { used, estimate, grants };
}

/**
 * zx_20261120_2 M5「实」：**真实命令失败**（不是被拒）。
 *
 * 病根（真标本 `6f8b6f33`）：收口账上的「工具拒绝 17 次」只数 `deny_reason` 非空的行，
 * 而本轮真跑的 `mvn -Dtest=JpaAuditingWiringTest test` 失败了（缺 `schema-local.sql`）——
 * `ok=0` 且无 `deny_reason`，于是这条真实失败在收口账上**一个字都没有**。
 *
 * 本模块只记账、只出 INFO；不改评分、不封顶、不阻塞完成（方案 §6.5）。
 */
export interface CommandFailureSummary {
  /** 本任务「跑了但失败」且形态属测试/构建/类型检查的命令条数 */
  total: number;
  /** 按形态计数：`test` / `build` / `typecheck` */
  byKind: Record<string, number>;
  /** 前 3 条命令（截断到 120 字符），供收口行点名 */
  samples: string[];
}

/**
 * 命令形态归类——只认「测试/构建/类型检查」三类（方案 §5 R5：探索性失败/预期失败不误记）。
 * 命令本身可含 `&&`/`;`，按**首个可识别形态**归类；归不了 ⇒ `null`（不记）。
 */
export function commandKindOf(command: string): 'test' | 'build' | 'typecheck' | null {
  const s = String(command ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  // 类型检查优先：`vue-tsc -b && vite build` 这类组合按"类型检查"记（它先跑且最常红）。
  if (/\bvue-tsc\b|\btypecheck\b|\btype-check\b|\btsc\b/.test(s)) return 'typecheck';
  if (/\bpytest\b/.test(s)) return 'test';
  if (/\bgo\s+test\b/.test(s)) return 'test';
  if (/\bcargo\s+test\b/.test(s)) return 'test';
  if (/\bmvn\b/.test(s) && /\btest\b/.test(s)) return 'test';
  if (/\b(?:npm|pnpm|yarn)\b[^&|;]*\btest\b/.test(s)) return 'test';
  if (/\bnpx\b[^&|;]*\b(?:vitest|jest)\b/.test(s)) return 'test';
  if (/\b(?:npm|pnpm|yarn)\b[^&|;]*\brun\b[^&|;]*\bbuild\b/.test(s)) return 'build';
  if (/\btsup\b/.test(s)) return 'build';
  if (/\bvite\s+build\b/.test(s)) return 'build';
  if (/\buni\s+build\b/.test(s)) return 'build';
  if (/\bgradlew?\b[^&|;]*\bbuild\b/.test(s)) return 'build';
  return null;
}

/**
 * 统计本任务「真跑了但失败」的测试/构建/类型检查命令。
 *
 * 判据（与 `summarizeToolDenials` 互补、互斥）：`ok=0` **且** `deny_reason` 为空/空白
 * ——有 `deny_reason` 的归「工具拒绝」，两类各归各（方案 §3 M5 修法 1）。
 */
// 只读 → 入参收为最小形状（只 `prepare().all()`）：`task-outcome.TaskOutcomeDb` 没有 `run`，
// 若声明成 `DenialDb` 则 `buildTaskOutcome` 传参在 tsc 下不可赋（缺 `run`）。
export function summarizeCommandFailures(
  db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } },
  taskId: string,
): CommandFailureSummary {
  const out: CommandFailureSummary = { total: 0, byKind: {}, samples: [] };
  try {
    const rows = db.prepare(
      "SELECT command FROM wa_task_runtime_evidence WHERE task_id = ? AND ok = 0 AND (deny_reason IS NULL OR TRIM(deny_reason) = '') ORDER BY created_at ASC, rowid ASC",
    ).all(taskId) as Array<{ command?: string | null }>;
    for (const r of rows) {
      const cmd = String(r.command ?? '').replace(/\s+/g, ' ').trim();
      if (!cmd) continue;
      const kind = commandKindOf(cmd);
      if (!kind) continue;
      out.total++;
      out.byKind[kind] = (out.byKind[kind] || 0) + 1;
      if (out.samples.length < 3) out.samples.push(cmd.slice(0, 120));
    }
  } catch {
    /* 读不到运行证据 ⇒ 全 0（不编） */
  }
  return out;
}

/**
 * 收口行（两个收口出口共用这一份文案，不各写一遍）。无失败 ⇒ 空串（不出空行）。
 * 语气固定为「仅记账，不改评分」——方案 §6.5：只记 INFO，不改分、不封顶、不阻塞完成。
 */
export function commandFailureCheckLine(s: CommandFailureSummary): string {
  if (!s || s.total <= 0) return '';
  const kinds = kindText(s.byKind);
  const samplePart = s.samples.length > 0 ? `（前 ${s.samples.length} 条：${s.samples.join('；')}）` : '';
  return `[INFO] 本轮测试/构建命令失败 ${s.total} 次${kinds ? `（${kinds}）` : ''}${samplePart}——仅记账，不改评分。`;
}

function kindText(byKind: Record<string, number>): string {
  return Object.entries(byKind)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([k, n]) => `${k} ${n}`)
    .join(' / ');
}

/**
 * 收口账行。无拒绝且无步数 ⇒ `null`（不出空行——"没这笔账"≠"账上是 0"）。
 * 被迫收尾且拒绝 ≥10 次 ⇒ 升级为 WARN，点名"把步数花在撞墙上"。
 */
export function buildDenialCheckLine(s: DenialSummary, steps: StepsLedger | null, premature = false): string | null {
  const parts: string[] = [];
  if (s.total > 0) parts.push(`工具拒绝 ${s.total} 次（${kindText(s.byKind)}）`);
  if (steps) parts.push(`步数 ${steps.used}${steps.estimate > 0 ? `/${steps.estimate}` : ''}${steps.grants > 0 ? `（续额 ${steps.grants} 次）` : ''}`);
  if (parts.length === 0) return null;
  if (premature && s.total >= 10) {
    return `[WARN] 被迫收尾且${parts.join('，')}——优先核验是否「把步数花在撞墙上」（探索/被拒命令）；若是，下次先看工具能力简报再动手。`;
  }
  return `[INFO] 本轮${parts.join('，')}。`;
}

/**
 * 落账 + 返回收口行：写 `$.tool_denials` 与 `$.steps_ledger`（`json_set` 单格，不动兄弟键）。
 * 无内容 ⇒ 不写、返回 `null`。
 */
export function recordToolDenialLedger(
  db: DenialDb,
  taskId: string,
  opts: { premature?: boolean } = {},
): string | null {
  const summary = summarizeToolDenials(db, taskId);
  let steps: StepsLedger | null = null;
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string | null } | undefined;
    steps = readStepsLedger(JSON.parse(row?.context_json || '{}'));
  } catch { /* 步数读不到 ⇒ 只报拒绝 */ }
  const line = buildDenialCheckLine(summary, steps, opts.premature === true);
  if (summary.total > 0) {
    try {
      db.prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json, '{}'), '$.tool_denials', json(?)) WHERE id = ?")
        .run(JSON.stringify(summary), taskId);
    } catch { /* 记账失败不阻断收口 */ }
  }
  if (steps) {
    try {
      db.prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json, '{}'), '$.steps_ledger', json(?)) WHERE id = ?")
        .run(JSON.stringify(steps), taskId);
    } catch { /* 同上 */ }
  }
  return line;
}
