/**
 * zx_20261120_1 M7「省·尺」：上下文注入的**来源 ROI**（相关，非因果）与影子预算。
 *
 * 病根：`wa_context_injections` 已把「哪一单注入了什么、后来成没成」记全，预算器却按固定顺序硬砍，
 *   不看「注入过的那几单后来有没有成」。
 *
 * 三条纪律：
 *   ① 只报**相关**：来源成功率与同期总成功率的差（`lift`），**不是**因果；
 *   ② 样本不足/结局未结清 ⇒ `lift=null`，**不给建议**（不拿 3 条样本改预算）；
 *   ③ 首轮影子：`context.roi_budget='0'`（缺省）⇒ 只算只显示，行为零变化。
 */
import type Database from 'better-sqlite3';
import { applyContextBudget, type ContextBudgetResult } from './context-budget.js';
import { readBoolSettingDefaultOff, type BoolSettingDb } from './settings-bool.js';

export const ROI_BUDGET_KEY = 'context.roi_budget';
export const ROI_DEFAULT_MIN_SAMPLES = 20;
export const ROI_FLOOR_RATIO = 0.1;

/** 可裁三源里，注入账能直接对应的两源（历史无注入账，不参与提案）。 */
export type RoiCapSource = 'knowledge' | 'memory';

export interface SourceRoiRow {
  source: string;
  /** 注入明细条数。 */
  injections: number;
  /** 估算 token 合计。 */
  tokens: number;
  /** 结局未回填的条数。 */
  pending: number;
  /** 有结局的任务数（completed+failed，去重）。 */
  evaluatedTasks: number;
  completed: number;
  failed: number;
  /** 来源成功率；样本不足/无结局 ⇒ `null`。 */
  successRate: number | null;
  /** 来源成功率 − 同期总成功率；任一为空 ⇒ `null`。 */
  lift: number | null;
  basis: 'correlation' | 'insufficient';
}

export interface RoiCapsProposal {
  caps: Partial<Record<RoiCapSource, number>>;
  rationale: string[];
  /** 无任何可执行建议（样本不足或全部非负）。 */
  unchanged: boolean;
  reason: string;
  rows: SourceRoiRow[];
  baseline: number | null;
  samples: number;
}

export interface RoiBudgetRecord {
  applied: boolean;
  proposal: RoiCapsProposal;
  at: string;
}

export interface RoiReadOpts {
  projectId?: string;
  sinceDays?: number;
  minSamples?: number;
}

/**
 * 按来源读 ROI。只读；任何读失败回空（`baseline=null`），不编 0。
 * 成功率按**任务**去重（同任务多条注入只算一票）。
 */
export function sourceRoiRows(db: Database.Database, opts: RoiReadOpts = {}): { rows: SourceRoiRow[]; baseline: number | null; samples: number } {
  const days = Math.max(1, Math.trunc(opts.sinceDays ?? 60));
  const minSamples = Math.max(1, Math.trunc(opts.minSamples ?? ROI_DEFAULT_MIN_SAMPLES));
  const where = ['t.created_at >= datetime(\'now\', ?)'];
  const args: unknown[] = [`-${days} days`];
  if (opts.projectId) { where.push('t.project_id = ?'); args.push(opts.projectId); }
  const scope = where.join(' AND ');

  let baseline: number | null = null;
  let samples = 0;
  try {
    const b = db.prepare(
      `SELECT SUM(status = 'completed') AS done, SUM(status = 'failed') AS bad
         FROM wa_tasks t WHERE ${scope} AND t.status IN ('completed','failed')`,
    ).get(...args) as { done?: number | null; bad?: number | null } | undefined;
    const done = Number(b?.done) || 0;
    const bad = Number(b?.bad) || 0;
    samples = done + bad;
    baseline = samples > 0 ? done / samples : null;
  } catch { baseline = null; samples = 0; }

  type Agg = { injections: number; tokens: number; pending: number; completed: number; failed: number };
  const agg = new Map<string, Agg>();
  try {
    const rows = db.prepare(
      `SELECT i.source AS source, COUNT(*) AS n, COALESCE(SUM(i.est_tokens), 0) AS tokens,
              SUM(CASE WHEN i.outcome = 'pending' THEN 1 ELSE 0 END) AS pending
         FROM wa_context_injections i JOIN wa_tasks t ON t.id = i.task_id
        WHERE ${scope}
        GROUP BY i.source`,
    ).all(...args) as Array<{ source: string; n: number; tokens: number; pending: number }>;
    for (const r of rows) {
      agg.set(String(r.source), { injections: Number(r.n) || 0, tokens: Number(r.tokens) || 0, pending: Number(r.pending) || 0, completed: 0, failed: 0 });
    }
    const outcomes = db.prepare(
      `SELECT i.source AS source, t.status AS status, COUNT(DISTINCT t.id) AS n
         FROM wa_context_injections i JOIN wa_tasks t ON t.id = i.task_id
        WHERE ${scope} AND t.status IN ('completed','failed')
        GROUP BY i.source, t.status`,
    ).all(...args) as Array<{ source: string; status: string; n: number }>;
    for (const r of outcomes) {
      const a = agg.get(String(r.source));
      if (!a) continue;
      if (r.status === 'completed') a.completed += Number(r.n) || 0;
      else a.failed += Number(r.n) || 0;
    }
  } catch { /* 读不到 ⇒ 无行 */ }

  const rows: SourceRoiRow[] = [...agg.entries()].map(([source, a]): SourceRoiRow => {
    const evaluatedTasks = a.completed + a.failed;
    const successRate = evaluatedTasks >= minSamples ? a.completed / evaluatedTasks : null;
    const lift = successRate != null && baseline != null ? successRate - baseline : null;
    return {
      source, injections: a.injections, tokens: a.tokens, pending: a.pending,
      evaluatedTasks, completed: a.completed, failed: a.failed,
      successRate, lift,
      basis: successRate != null && lift != null ? 'correlation' : 'insufficient',
    };
  }).sort((x, y) => y.injections - x.injections);
  return { rows, baseline, samples };
}

/**
 * 只给**负 lift 且样本足**的来源降上限（floor = 预算的 10%）；其余不动。
 * 样本不足或结局未结清（pending 过半）⇒ `unchanged`。
 */
export function roiCapsProposal(
  input: { rows: SourceRoiRow[]; baseline: number | null; samples: number },
  opts: { budgetTokens: number; minSamples?: number; floorRatio?: number },
): RoiCapsProposal {
  const budget = Math.max(1, Math.trunc(opts.budgetTokens));
  const minSamples = Math.max(1, Math.trunc(opts.minSamples ?? ROI_DEFAULT_MIN_SAMPLES));
  const floor = Math.max(1, Math.round(budget * (opts.floorRatio ?? ROI_FLOOR_RATIO)));
  const caps: Partial<Record<RoiCapSource, number>> = {};
  const rationale: string[] = [];
  const cand = input.rows.filter((r): r is SourceRoiRow & { source: RoiCapSource; lift: number } =>
    (r.source === 'knowledge' || r.source === 'memory') && r.lift != null && r.evaluatedTasks >= minSamples);
  for (const r of cand) {
    const pendingShare = r.injections > 0 ? r.pending / r.injections : 0;
    if (pendingShare >= 0.5) {
      rationale.push(`${r.source}：${Math.round(pendingShare * 100)}% 结局未结清，不下结论`);
      continue;
    }
    if (r.lift < 0) {
      caps[r.source] = floor;
      rationale.push(`${r.source}：成功率 ${Math.round((r.successRate ?? 0) * 100)}% 低于同期基线 ${Math.round((input.baseline ?? 0) * 100)}%（样本 ${r.evaluatedTasks}），上限降至 ${floor}`);
    }
  }
  const unchanged = Object.keys(caps).length === 0;
  const reason = unchanged
    ? (input.samples < minSamples ? `样本不足（${input.samples}/${minSamples}）` : '无可执行建议（无负 lift 或结局未结清）')
    : rationale.join('；');
  return { caps, rationale, unchanged, reason, rows: input.rows, baseline: input.baseline, samples: input.samples };
}

/**
 * 影子/生效两态预算：影子（`apply=false`）⇒ 与旧实现**逐字节相同**，只把建议带出；
 * 生效 ⇒ 先把建议上限折成字符数压 **knowledge/memory**，再交给既有 `applyContextBudget`
 *   （顺序、永不裁源、超预算如实 `overAfter` 全部不变），差额计入 `trimmedChars` 供下游真删。
 */
export function applyRoiAwareBudget(input: {
  chars: Partial<Record<string, number>>;
  budgetTokens: number;
  capsTokens?: Partial<Record<string, number>>;
  proposal: RoiCapsProposal;
  apply: boolean;
}): { budget: ContextBudgetResult; applied: boolean } {
  const baseInput = { chars: input.chars, budgetTokens: input.budgetTokens, capsTokens: input.capsTokens };
  if (!input.apply || input.proposal.unchanged) {
    return { budget: applyContextBudget(baseInput), applied: false };
  }
  const reduced: Partial<Record<string, number>> = { ...input.chars };
  const extra = new Map<string, number>();
  for (const [src, capTok] of Object.entries(input.proposal.caps) as Array<[RoiCapSource, number]>) {
    const cur = Math.max(0, Math.floor(Number(input.chars[src]) || 0));
    const capChars = Math.max(0, Math.floor(capTok * 4));
    if (cur > capChars) {
      reduced[src] = capChars;
      extra.set(src, cur - capChars);
    }
  }
  const budget = applyContextBudget({ ...baseInput, chars: reduced });
  for (const [src, chars] of extra) {
    budget.trimmedChars[src as keyof typeof budget.trimmedChars] += chars;
  }
  return { budget, applied: true };
}

export function readRoiBudgetSwitch(db: BoolSettingDb): boolean {
  return readBoolSettingDefaultOff(db, ROI_BUDGET_KEY);
}

/**
 * 装配段的一跳：读 ROI → 提案 → 两态预算 → 落 `context_json.roi_budget`。
 * **永不抛**；失败回落到旧 `applyContextBudget`（与改前逐字节一致）。
 */
export function computeRoiBudget(db: Database.Database, input: {
  taskId: string;
  projectId: string;
  chars: Partial<Record<string, number>>;
  budgetTokens: number;
  capsTokens?: Partial<Record<string, number>>;
}): { budget: ContextBudgetResult; applied: boolean } {
  try {
    const roiRows = sourceRoiRows(db, { projectId: input.projectId });
    const proposal = roiCapsProposal(roiRows, { budgetTokens: input.budgetTokens });
    const roi = applyRoiAwareBudget({
      chars: input.chars,
      budgetTokens: input.budgetTokens,
      capsTokens: input.capsTokens,
      proposal,
      apply: readRoiBudgetSwitch(db as unknown as BoolSettingDb),
    });
    try {
      db.prepare("UPDATE wa_tasks SET context_json = json_set(context_json, '$.roi_budget', json(?)) WHERE id = ?")
        .run(JSON.stringify({ applied: roi.applied, proposal, at: new Date().toISOString() }), input.taskId);
    } catch { /* 记账失败不影响装配 */ }
    return roi;
  } catch {
    return { budget: applyContextBudget({ chars: input.chars, budgetTokens: input.budgetTokens, capsTokens: input.capsTokens }), applied: false };
  }
}

/** 收口账的一行（无记录 ⇒ `null`；不编「未生效」）。 */
export function roiBudgetCheckLine(db: Database.Database, taskId: string): string | null {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string | null } | undefined;
    const ctx = JSON.parse(String(row?.context_json ?? '{}')) as { roi_budget?: RoiBudgetRecord };
    const rec = ctx.roi_budget;
    if (!rec || typeof rec !== 'object') return null;
    const p = rec.proposal;
    if (!p || p.unchanged) {
      return `[INFO] 上下文按效预算（影子）：${p?.reason ?? '样本不足'}——本轮未改裁剪`;
    }
    const parts = (Object.entries(p.caps) as Array<[RoiCapSource, number]>).map(([src, cap]) => `${src} → ${cap} token`);
    return rec.applied
      ? `[INFO] 上下文按效预算：${parts.join(' / ')}；依据：样本 ${p.samples}（相关，非因果）`
      : `[INFO] 上下文按效预算（影子）：建议 ${parts.join(' / ')}；本轮未生效（开关关闭；相关，非因果）`;
  } catch {
    return null;
  }
}
