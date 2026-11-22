/**
 * zx_20261122_1 M1「省·账」（管子·度量衡 / 道德经·少则得 / 康德·先划界）:
 *   **模型实绩**的唯一读模型——从本机**已经发生**的任务账里派生「每个模型跑了多少、成没成、花多少」。
 *
 * 数据源（不新增表、不双写）：
 *   · `wa_tasks.context_json.last_model` —— 每次执行结束时写下的真实模型名；
 *   · `context_json.execution_metrics.totalTokens` —— 同一把 token 尺；
 *   · `context_json.cost_estimate.cost` —— 同一份成本账。
 *
 * 三条纪律：
 *   ① **相关非因果**：不同模型的单子不是随机分组；建议只标「相关」，不承诺「换模型省 X%」；
 *   ② **样本不足就说不足**：成功率分母 < 3 ⇒ `null`；无 token/成本 ⇒ `null`，**不补 0**；
 *   ③ **同一把尺**：分位数复用 `project-experience.percentile`，不另写一套。
 *
 * ⚠ 零 electron / 零网络 / 零 LLM / 只读：rr 拿内存库可直跑真实现。
 */
import type Database from 'better-sqlite3';
import { percentile } from './project-experience.js';

/** 成功率的最小分母（一单成功不叫「稳」）。 */
export const MODEL_PERF_MIN_SAMPLES = 3;
/** 默认窗口（天）。 */
export const MODEL_PERF_DEFAULT_WINDOW_DAYS = 90;
/** 单次最多看多少单（有界，避免长史拖慢首屏）。 */
export const MODEL_PERF_MAX_TASKS = 5000;
/** 项目内建议：成功率容忍带（百分点）。 */
export const MODEL_PERF_SUCCESS_TOLERANCE = 5;
/** 项目内建议：成本至少低这么多才开口（比例）。 */
export const MODEL_PERF_COST_GAIN = 0.1;

export interface ModelPerfRow {
  model: string;
  /** 有 `last_model` 的任务数（含非终态）。 */
  tasks: number;
  completed: number;
  failed: number;
  /** completed / (completed + failed)；分母 < MIN_SAMPLES ⇒ null。 */
  successRate: number | null;
  /** 仅 completed 且有 finite > 0 的 totalTokens。 */
  tokensP50: number | null;
  tokensP90: number | null;
  /** 仅 completed 且有 finite cost 的均值；没有 ⇒ null（不补 0）。 */
  avgCost: number | null;
  lastUsedAt: string;
}

export interface ModelPerfRecommendation {
  model: string;
  vsModel: string;
  /** 人话理由：含「相关」与样本数。 */
  reason: string;
}

export interface ModelPerfView {
  windowDays: number;
  projectId: string | null;
  rows: ModelPerfRow[];
  recommendation: ModelPerfRecommendation | null;
  samples: { tasks: number; completed: number; failed: number };
}

export interface ModelPerfOpts {
  projectId?: string | null;
  windowDays?: number;
  /** 注入时钟（受控回归用）；缺省 `Date.now()`。 */
  now?: number;
}

interface RawRow {
  model?: unknown;
  status?: unknown;
  tokens?: unknown;
  cost?: unknown;
  updated_at?: unknown;
}

function finiteNum(v: unknown): number | null {
  // ⚠ `Number(null) === 0`：缺键/JSON null 必须当「没有这个数」，不能悄悄变成 0。
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** UTC 的 SQLite datetime 文本（与库内 `datetime('now')` 同形）。 */
function utcSqlText(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 收模型实绩。读不到任务表 / JSON 坏 / 无数据 ⇒ 空行（不抛）；
 * `projectId` 非空时只统计该项目，并尝试给出**项目内**建议。
 */
export function collectModelPerformance(db: Database.Database, opts: ModelPerfOpts = {}): ModelPerfView {
  const windowDays = Math.max(1, Math.floor(Number(opts.windowDays) || MODEL_PERF_DEFAULT_WINDOW_DAYS));
  const projectId = typeof opts.projectId === 'string' && opts.projectId.trim() ? opts.projectId.trim() : null;
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const since = utcSqlText(now - windowDays * 24 * 60 * 60 * 1000);

  let raw: RawRow[] = [];
  try {
    const where = [
      "context_json LIKE '%\"last_model\"%'",
      'json_valid(context_json)',
      'updated_at >= ?',
    ];
    const params: unknown[] = [since];
    if (projectId) { where.push('project_id = ?'); params.push(projectId); }
    raw = db.prepare(
      `SELECT json_extract(context_json, '$.last_model') AS model,
              status,
              json_extract(context_json, '$.execution_metrics.totalTokens') AS tokens,
              json_extract(context_json, '$.cost_estimate.cost') AS cost,
              updated_at
         FROM wa_tasks
        WHERE ${where.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT ?`,
    ).all(...params, MODEL_PERF_MAX_TASKS) as RawRow[];
  } catch {
    return { windowDays, projectId, rows: [], recommendation: null, samples: { tasks: 0, completed: 0, failed: 0 } };
  }

  const groups = new Map<string, {
    tasks: number; completed: number; failed: number;
    tokens: number[]; costs: number[]; lastUsedAt: string;
  }>();
  let totalCompleted = 0;
  let totalFailed = 0;
  for (const r of raw) {
    const model = typeof r.model === 'string' ? r.model.trim() : '';
    if (!model) continue;
    const g = groups.get(model) ?? { tasks: 0, completed: 0, failed: 0, tokens: [], costs: [], lastUsedAt: '' };
    g.tasks += 1;
    const status = String(r.status ?? '');
    if (status === 'completed') {
      g.completed += 1; totalCompleted += 1;
      const tok = finiteNum(r.tokens);
      if (tok !== null && tok > 0) g.tokens.push(tok);
      const cost = finiteNum(r.cost);
      if (cost !== null && cost >= 0) g.costs.push(cost);
    } else if (status === 'failed') {
      g.failed += 1; totalFailed += 1;
    }
    const at = String(r.updated_at ?? '');
    if (at > g.lastUsedAt) g.lastUsedAt = at;
    groups.set(model, g);
  }

  const rows: ModelPerfRow[] = [...groups.entries()].map(([model, g]) => {
    const denom = g.completed + g.failed;
    return {
      model,
      tasks: g.tasks,
      completed: g.completed,
      failed: g.failed,
      successRate: denom >= MODEL_PERF_MIN_SAMPLES ? g.completed / denom : null,
      tokensP50: percentile(g.tokens, 50),
      tokensP90: percentile(g.tokens, 90),
      avgCost: g.costs.length > 0 ? g.costs.reduce((a, b) => a + b, 0) / g.costs.length : null,
      lastUsedAt: g.lastUsedAt,
    };
  }).sort((a, b) => b.tasks - a.tasks || a.model.localeCompare(b.model));

  return {
    windowDays,
    projectId,
    rows,
    // 建议只在**同一项目**内比较（不同项目的任务构成不同；全局混在一起会误导）。
    recommendation: projectId ? pickRecommendation(rows) : null,
    samples: { tasks: raw.length, completed: totalCompleted, failed: totalFailed },
  };
}

/**
 * 项目内建议（纯函数）：成功率在最高者 5 个百分点内、且均成本低 ≥10% ⇒ 推荐。
 * 任一成本未知 ⇒ **不建议**（不知道就不说）。
 */
export function pickRecommendation(rows: readonly ModelPerfRow[]): ModelPerfRecommendation | null {
  const qualified = rows.filter((r) => r.successRate !== null && r.avgCost !== null && r.completed + r.failed >= MODEL_PERF_MIN_SAMPLES);
  if (qualified.length < 2) return null;
  const best = qualified.reduce((a, b) => ((b.successRate! > a.successRate!) || (b.successRate === a.successRate && b.tasks > a.tasks) ? b : a));
  const tolerance = MODEL_PERF_SUCCESS_TOLERANCE / 100;
  const candidates = qualified.filter((r) => r.model !== best.model && r.successRate! >= best.successRate! - tolerance);
  if (candidates.length === 0) return null;
  const cheapest = candidates.reduce((a, b) => (b.avgCost! < a.avgCost! ? b : a));
  if (!(cheapest.avgCost! < best.avgCost! * (1 - MODEL_PERF_COST_GAIN))) return null;
  const gainPct = Math.round((1 - cheapest.avgCost! / best.avgCost!) * 100);
  return {
    model: cheapest.model,
    vsModel: best.model,
    reason: `同项目近 ${MODEL_PERF_DEFAULT_WINDOW_DAYS} 天：${cheapest.model} 成功率 ${Math.round(cheapest.successRate! * 100)}%（${cheapest.completed + cheapest.failed} 单），与 ${best.model}（${Math.round(best.successRate! * 100)}%）相近；均成本低约 ${gainPct}%。相关，非因果。`,
  };
}
