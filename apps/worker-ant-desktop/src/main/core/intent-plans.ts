/**
 * 意图计划存储（zx_20261018_1 批二「意」）——resolve 与 execute 之间的**那本账**。
 *
 * 口径（王阳明·知行合一 ／ 道德经·图难于其易）：
 *   · resolve **零副作用**（不碰设备），只把"打算怎么做"落成 `wa_intent_plans.status='planned'`；
 *   · execute **只执行一次**——认领用一条 `UPDATE ... WHERE status='planned'` 决胜（并发下也只有一人拿到）；
 *   · 计划有**寿命**（缺省 120 秒）：过期即 `plan_expired`，不执行任何一步。
 *
 * ⚠ 时刻一律用 DB 格式 UTC 串（`YYYY-MM-DD HH:MM:SS`），与 `datetime('now')` 同基准；
 *   比较是字符串字典序——同格式下与时间顺序一致。
 */
import { randomUUID } from 'node:crypto';

export interface IntentPlanDb {
  prepare(sql: string): {
    run(...args: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
    get(...args: unknown[]): unknown;
  };
}

export type IntentPlanStatus = 'planned' | 'executing' | 'executed' | 'failed';

/** 计划由谁排出（zx_20261029_2 M2）——`rule`＝确定性规则表，`model`＝规则排不出时的模型补充。 */
export type IntentPlanSource = 'rule' | 'model';

/** 人话来源（面板与门内回执共用；表外按规则处理，不冒充模型）。 */
export const INTENT_PLAN_SOURCE_LABEL: Record<IntentPlanSource, string> = {
  rule: '规则解析',
  model: '模型辅助解析',
};

export function intentPlanSourceLabel(value: string): string {
  return value === 'model' ? INTENT_PLAN_SOURCE_LABEL.model : INTENT_PLAN_SOURCE_LABEL.rule;
}

export interface IntentPlanRow {
  id: string;
  terminal_id: string;
  capability: string;
  params_json: string;
  plan_json: string;
  status: string;
  source: string;
  created_at: string;
  expires_at: string;
  executed_at: string | null;
  result_json: string;
}

export interface IntentStep {
  call_name: string;
  action: string;
  args?: Record<string, unknown>;
  reason?: string;
}

export interface IntentSkip {
  call_name: string;
  reason: string;
}

/** 计划寿命（秒）——一处真源（resolve 回包与到期判据同取此值）。 */
export const INTENT_PLAN_TTL_SEC = 120;

/** 与 `datetime('now')` 同基准同格式（UTC）。 */
export function dbNowUtc(at: Date = new Date()): string {
  return at.toISOString().slice(0, 19).replace('T', ' ');
}

export interface CreatedIntentPlan {
  id: string;
  expiresAt: string;
  expiresIn: number;
  source: IntentPlanSource;
}

/** 落一条计划（`status='planned'`）。**只写库，不碰设备**。 */
export function createIntentPlan(
  db: IntentPlanDb,
  input: {
    terminalId: string;
    capability: string;
    params: Record<string, unknown>;
    steps: IntentStep[];
    skipped: IntentSkip[];
    /** 未传 ⇒ `rule`（老调用点语义不变；模型路径显式传 `model`）。 */
    source?: IntentPlanSource;
    now?: Date;
    ttlSec?: number;
  },
): CreatedIntentPlan {
  const id = randomUUID();
  const now = input.now ?? new Date();
  const ttlSec = input.ttlSec ?? INTENT_PLAN_TTL_SEC;
  const source = input.source ?? 'rule';
  const createdAt = dbNowUtc(now);
  const expiresAt = dbNowUtc(new Date(now.getTime() + ttlSec * 1000));
  db.prepare(
    `INSERT INTO wa_intent_plans (id, terminal_id, capability, params_json, plan_json, status, source, created_at, expires_at, result_json)
     VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?, '{}')`,
  ).run(
    id,
    input.terminalId,
    input.capability,
    JSON.stringify(input.params),
    JSON.stringify({ steps: input.steps, skipped: input.skipped }),
    source,
    createdAt,
    expiresAt,
  );
  return { id, expiresAt, expiresIn: ttlSec, source };
}

export function getIntentPlan(db: IntentPlanDb, id: string): IntentPlanRow | null {
  const row = db.prepare('SELECT * FROM wa_intent_plans WHERE id = ?').get(id) as IntentPlanRow | undefined;
  return row ?? null;
}

export function parsePlanJson(row: IntentPlanRow): { steps: IntentStep[]; skipped: IntentSkip[] } {
  try {
    const v = JSON.parse(row.plan_json || '{}') as { steps?: unknown; skipped?: unknown };
    const steps = Array.isArray(v.steps) ? (v.steps as IntentStep[]) : [];
    const skipped = Array.isArray(v.skipped) ? (v.skipped as IntentSkip[]) : [];
    return { steps, skipped };
  } catch {
    return { steps: [], skipped: [] };
  }
}

export type ClaimIntentPlanResult =
  | { ok: true; plan: IntentPlanRow }
  | { ok: false; reason: 'plan_not_found' | 'plan_expired' | 'plan_already_executed' | 'plan_executing' };

/**
 * 认领一条计划：`UPDATE ... WHERE status='planned' AND expires_at > now`。
 * 单条 UPDATE 决胜——第二次 execute 拿不到（R-16）；过期拿不到（R-15）。
 * 失败时按**行现状**如实分因，不合并成一句"不能用"。
 */
export function claimIntentPlan(db: IntentPlanDb, id: string, now: Date = new Date()): ClaimIntentPlanResult {
  const nowStr = dbNowUtc(now);
  const res = db.prepare(
    `UPDATE wa_intent_plans SET status = 'executing' WHERE id = ? AND status = 'planned' AND expires_at > ?`,
  ).run(id, nowStr);
  if (Number(res.changes ?? 0) === 1) {
    const plan = getIntentPlan(db, id);
    return plan ? { ok: true, plan } : { ok: false, reason: 'plan_not_found' };
  }
  const row = getIntentPlan(db, id);
  if (!row) return { ok: false, reason: 'plan_not_found' };
  if (row.status === 'planned') return { ok: false, reason: 'plan_expired' };
  if (row.status === 'executing') return { ok: false, reason: 'plan_executing' };
  return { ok: false, reason: 'plan_already_executed' };
}

export interface IntentStepResult {
  call_name: string;
  action: string;
  ok: boolean;
  result?: string;
  error?: string;
}

/** 收口：全步成功 ⇒ `executed`；任一步失败 ⇒ `failed`（**不回滚**已执行的步——如实记）。 */
export function finishIntentPlan(
  db: IntentPlanDb,
  id: string,
  results: IntentStepResult[],
  now: Date = new Date(),
): 'executed' | 'failed' {
  const status: 'executed' | 'failed' = results.every((r) => r.ok) ? 'executed' : 'failed';
  db.prepare(
    `UPDATE wa_intent_plans SET status = ?, executed_at = ?, result_json = ? WHERE id = ? AND status = 'executing'`,
  ).run(status, dbNowUtc(now), JSON.stringify({ steps: results }), id);
  return status;
}

/** 一步的执行结果（传动层已归一——`denied` 与"传动失败"都算失败，但原因分开记）。 */
export interface IntentStepControlResult {
  ok: boolean;
  denied?: boolean;
  reason?: string;
  result?: string;
}

/**
 * 已认领计划的**共享执行器**（zx_20261018_1 批五）——门外终端、本地工具、面板三路**同一份**逐步落实次序。
 *
 * 口径：
 *   · 严格按计划顺序逐条执行（说的话与做的事逐条对得上）；
 *   · **部分失败不回滚**：某步失败仍继续尝试后续步骤，全部如实记结果；
 *   · 每步只经注入的 `control`（生产绑定 `runDeviceControl`——K-6 闸/审计/状态/事件仍只有那一份）。
 * ⚠ 调用前必须已 `claimIntentPlan` 成功；本函数只负责"执行 + 收口"。
 */
export async function executeClaimedIntentPlan(
  db: IntentPlanDb,
  plan: IntentPlanRow,
  control: (step: IntentStep) => Promise<IntentStepControlResult>,
  now: Date = new Date(),
): Promise<{ status: 'executed' | 'failed'; steps: IntentStepResult[] }> {
  const { steps } = parsePlanJson(plan);
  const results: IntentStepResult[] = [];
  for (const step of steps) {
    const outcome = await control(step);
    if (outcome.ok) {
      results.push({ call_name: step.call_name, action: step.action, ok: true, result: outcome.result });
    } else if (outcome.denied) {
      results.push({ call_name: step.call_name, action: step.action, ok: false, error: outcome.reason ?? 'denied' });
    } else {
      results.push({ call_name: step.call_name, action: step.action, ok: false, error: outcome.result ?? outcome.reason ?? 'error' });
    }
  }
  const status = finishIntentPlan(db, plan.id, results, now);
  return { status, steps: results };
}
