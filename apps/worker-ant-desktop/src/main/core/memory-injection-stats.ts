/**
 * zx_20261018_3 批一（维特根斯坦·意义即用法 / 管子·度量衡）: **注入账的读者**。
 *
 * 病根：`wa_context_injections` 早已把每次注入记成明细账，但 `source='memory'` 的行**全仓无人读**
 * ——账写了、没读者，等于没写。本模块给记忆页和 rr 一个统一的读口：
 *   · `injected`        = 注入行数（记忆·次；同一任务重复注入按唯一键只留一行，与写口同尺）
 *   · `distinctMemories`= 被注入过的**不同记忆**条数
 *   · `usedTimes`       = 这些记忆的 `use_count` 之和（**主动引用**，与注入分账）
 *   · 结局三态           = completed / failed / pending（由 `backfillInjectionOutcomes` 回填）
 *
 * zx_20261101_2 M5（管子·度量衡）：再把「值不值」变成可算的数——
 *   · `charsInjected` = 注入字符数之和（`SUM(chars)`；记忆行按写入规则封顶 300 字/条）
 *   · `hitRate`       = `usedTimes / distinctMemories`（每条被注入的记忆平均被主动引用了多少次；
 *                       0 条被注入时记 0，不除零）
 *   · `failedShare`   = 落进失败任务的注入行 / 总注入行（"注入了但任务没成"的占比）
 *   · `wasteChars`    = 失败结局对应行的字符数之和（"白注了"的字数）
 *
 * 口径与 `knowledgeInjectionStats` 对称：都按 `task_id` 归到项目；本函数只看 `source='memory'`。
 * 纯 SQL、零 electron 依赖（rr 直跑）。
 */
import type Database from 'better-sqlite3';
import { INJECTION_SOURCES, injectionSourceLabel } from './injection-sources.js';
import { teamFeatureRefusal } from './team-gate.js';
import type { ResolveLicenseOpts } from './license.js';

export interface MemoryInjectionStats {
  /** 注入行数（记忆·次）。 */
  injected: number;
  /** 被注入过的不同记忆条数。 */
  distinctMemories: number;
  /** 这些记忆的主动引用次数之和（`use_count`）。 */
  usedTimes: number;
  completed: number;
  failed: number;
  pending: number;
  /** zx_20261101_2 M5：注入字符数之和（`SUM(chars)`）。 */
  charsInjected: number;
  /** `usedTimes / distinctMemories`（0..∞；无注入记录时 0）。 */
  hitRate: number;
  /** 失败任务的注入行 / 总注入行（0..1；无注入记录时 0）。 */
  failedShare: number;
  /** 失败结局对应行的字符数之和（白注入的字数）。 */
  wasteChars: number;
}

type ReadDb = Pick<Database.Database, 'prepare'>;

export function memoryInjectionStats(db: ReadDb, projectId?: string): MemoryInjectionStats {
  const scope = projectId ? 't.project_id = ? AND ' : '';
  const params = projectId ? [projectId] : [];

  const outcomes = db.prepare(
    `SELECT ci.outcome AS outcome, COUNT(*) AS cnt
       FROM wa_context_injections ci
       JOIN wa_tasks t ON t.id = ci.task_id
      WHERE ${scope}ci.source = 'memory'
      GROUP BY ci.outcome`,
  ).all(...params) as Array<{ outcome: string | null; cnt: number }>;

  const distinct = db.prepare(
    `SELECT COUNT(DISTINCT ci.ref_id) AS n
       FROM wa_context_injections ci
       JOIN wa_tasks t ON t.id = ci.task_id
      WHERE ${scope}ci.source = 'memory'`,
  ).get(...params) as { n: number } | undefined;

  const used = db.prepare(
    `SELECT COALESCE(SUM(m.use_count), 0) AS n
       FROM (SELECT DISTINCT ci.ref_id AS id
               FROM wa_context_injections ci
               JOIN wa_tasks t ON t.id = ci.task_id
              WHERE ${scope}ci.source = 'memory') x
       JOIN wa_memories m ON m.id = x.id`,
  ).get(...params) as { n: number } | undefined;

  const chars = db.prepare(
    `SELECT COALESCE(SUM(ci.chars), 0) AS total,
            COALESCE(SUM(CASE WHEN ci.outcome = 'failed' THEN ci.chars ELSE 0 END), 0) AS waste
       FROM wa_context_injections ci
       JOIN wa_tasks t ON t.id = ci.task_id
      WHERE ${scope}ci.source = 'memory'`,
  ).get(...params) as { total: number; waste: number } | undefined;

  const stats: MemoryInjectionStats = {
    injected: 0,
    distinctMemories: Number(distinct?.n) || 0,
    usedTimes: Number(used?.n) || 0,
    completed: 0,
    failed: 0,
    pending: 0,
    charsInjected: Number(chars?.total) || 0,
    hitRate: 0,
    failedShare: 0,
    wasteChars: Number(chars?.waste) || 0,
  };
  for (const r of outcomes) {
    const n = Number(r.cnt) || 0;
    stats.injected += n;
    if (r.outcome === 'completed') stats.completed += n;
    else if (r.outcome === 'failed') stats.failed += n;
    else stats.pending += n;
  }
  if (stats.distinctMemories > 0) stats.hitRate = stats.usedTimes / stats.distinctMemories;
  if (stats.injected > 0) stats.failedShare = stats.failed / stats.injected;
  return stats;
}

/* ════════════════════════════════════════════════════════════════════════════
 * zx_20261107_1 B4（管子·度量衡 / 夏克特·来源标注）: **注入 ROI 的只读读口**
 *
 * 此前每个来源各有一个窄读口（memory / knowledge / knowledge_card / domain_pack / project_profile），
 * 拼不成一张「注入了什么、成了没有、白注多少」的总账。本段只做一件事：把同一本
 * `wa_context_injections` 按**来源**与**任务**两个切面摊开，**只读**——
 * 不自动降权、不删记忆、不改写任何行（账是事实，不是待优化的队列）。
 *
 * 档位：来源合计**全档可看**；每任务明细归 Team「审计视图」（复用 `audit_view` 软闸）。
 * 锁定 ⇒ 明细**先闸后读**（零查询），如实回拒因，不是"查完再藏起来"。
 * 词表外历史来源不丢弃：如实以原始 `source` 上屏。
 * ════════════════════════════════════════════════════════════════════════════ */

/** 单一来源的 ROI 一行（`source` 为词表键或历史原值）。 */
export interface InjectionSourceRoi {
  source: string;
  label: string;
  injections: number;
  chars: number;
  estTokens: number;
  completed: number;
  failed: number;
  pending: number;
  /** 落进失败任务的字数（"白注了"）。 */
  wasteChars: number;
  /** `completed / (completed + failed)`；无已结算行 ⇒ 0（不除零，`pending` 自己会说话）。 */
  successRate: number;
}

export interface InjectionRoiSummary {
  projectId: string | null;
  /** 词表五源**固定顺序**（无行的也如实给 0）+ 词表外历史来源（按名排序）。 */
  sources: InjectionSourceRoi[];
  totals: InjectionSourceRoi;
}

/** 单任务明细（按来源再拆一次；只列真有的来源）。 */
export interface InjectionTaskRoi {
  taskId: string;
  title: string;
  status: string;
  injections: number;
  chars: number;
  estTokens: number;
  completed: number;
  failed: number;
  pending: number;
  wasteChars: number;
  lastAt: string;
  bySource: Array<{
    source: string;
    label: string;
    injections: number;
    chars: number;
    completed: number;
    failed: number;
  }>;
}

export interface InjectionTaskDetail {
  rows: InjectionTaskRoi[];
  /** 命中 `limit` 且还有更多 ⇒ true（界面如实说"还有更多"，不静默截断）。 */
  truncated: boolean;
}

export interface InjectionRoiView {
  summary: InjectionRoiSummary;
  detail: { unlocked: boolean; refusal: string; rows: InjectionTaskRoi[]; truncated: boolean };
}

/** 明细默认条数：够一屏；上限 200（不让一次读拖垮界面）。 */
export const INJECTION_DETAIL_DEFAULT_LIMIT = 50;
export const INJECTION_DETAIL_MAX_LIMIT = 200;

interface SourceAggRow {
  source: string;
  n: number;
  chars: number | null;
  tokens: number | null;
  completed: number | null;
  failed: number | null;
  pending: number | null;
  waste: number | null;
}

function roiRow(source: string, r: Partial<SourceAggRow> | undefined): InjectionSourceRoi {
  const completed = Number(r?.completed) || 0;
  const failed = Number(r?.failed) || 0;
  const settled = completed + failed;
  return {
    source,
    label: injectionSourceLabel(source),
    injections: Number(r?.n) || 0,
    chars: Number(r?.chars) || 0,
    estTokens: Number(r?.tokens) || 0,
    completed,
    failed,
    pending: Number(r?.pending) || 0,
    wasteChars: Number(r?.waste) || 0,
    successRate: settled > 0 ? completed / settled : 0,
  };
}

/** 按来源摊开合计账（全档可看）。`projectId` 缺省＝全库口径（与 `memoryInjectionStats` 同归法）。 */
export function injectionRoiSummary(db: ReadDb, projectId?: string): InjectionRoiSummary {
  const scope = projectId ? 't.project_id = ? AND ' : '';
  const params = projectId ? [projectId] : [];
  const rows = db.prepare(
    `SELECT ci.source AS source,
            COUNT(*) AS n,
            COALESCE(SUM(ci.chars), 0) AS chars,
            COALESCE(SUM(ci.est_tokens), 0) AS tokens,
            SUM(CASE WHEN ci.outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN ci.outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN ci.outcome NOT IN ('completed', 'failed') THEN 1 ELSE 0 END) AS pending,
            COALESCE(SUM(CASE WHEN ci.outcome = 'failed' THEN ci.chars ELSE 0 END), 0) AS waste
       FROM wa_context_injections ci
       JOIN wa_tasks t ON t.id = ci.task_id
      WHERE ${scope}1 = 1
      GROUP BY ci.source`,
  ).all(...params) as SourceAggRow[];

  const byKey = new Map<string, SourceAggRow>();
  for (const r of rows) byKey.set(String(r.source ?? ''), r);

  const sources: InjectionSourceRoi[] = INJECTION_SOURCES.map((s) => roiRow(s, byKey.get(s)));
  const extras = [...byKey.keys()]
    .filter((s) => !(INJECTION_SOURCES as readonly string[]).includes(s))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const s of extras) sources.push(roiRow(s, byKey.get(s)));

  // 合计按**全部**行算（含词表外），逐项相加与 SQL 同值——两处不一致即为读坏。
  const totals = roiRow('*', rows.reduce<Partial<SourceAggRow>>((acc, r) => ({
    n: (acc.n ?? 0) + (Number(r.n) || 0),
    chars: (acc.chars ?? 0) + (Number(r.chars) || 0),
    tokens: (acc.tokens ?? 0) + (Number(r.tokens) || 0),
    completed: (acc.completed ?? 0) + (Number(r.completed) || 0),
    failed: (acc.failed ?? 0) + (Number(r.failed) || 0),
    pending: (acc.pending ?? 0) + (Number(r.pending) || 0),
    waste: (acc.waste ?? 0) + (Number(r.waste) || 0),
  }), {}));
  totals.label = '合计';

  return { projectId: projectId ?? null, sources, totals };
}

/**
 * 每任务明细（Team 审计视图）。按最后更新时间倒序；`limit` 有界，多出的如实标 `truncated`。
 * **只读**：全程 SELECT。
 */
export function injectionTaskDetail(db: ReadDb, projectId?: string, limit?: number): InjectionTaskDetail {
  const cap = Math.min(
    INJECTION_DETAIL_MAX_LIMIT,
    Math.max(1, Number.isFinite(limit) ? Math.floor(Number(limit)) : INJECTION_DETAIL_DEFAULT_LIMIT),
  );
  const scope = projectId ? 't.project_id = ? AND ' : '';
  const params = projectId ? [projectId] : [];
  const heads = db.prepare(
    `SELECT ci.task_id AS task_id,
            t.title AS title,
            t.status AS status,
            COUNT(*) AS n,
            COALESCE(SUM(ci.chars), 0) AS chars,
            COALESCE(SUM(ci.est_tokens), 0) AS tokens,
            SUM(CASE WHEN ci.outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN ci.outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN ci.outcome NOT IN ('completed', 'failed') THEN 1 ELSE 0 END) AS pending,
            COALESCE(SUM(CASE WHEN ci.outcome = 'failed' THEN ci.chars ELSE 0 END), 0) AS waste,
            MAX(ci.updated_at) AS last_at
       FROM wa_context_injections ci
       JOIN wa_tasks t ON t.id = ci.task_id
      WHERE ${scope}1 = 1
      GROUP BY ci.task_id
      ORDER BY last_at DESC, ci.task_id
      LIMIT ?`,
  ).all(...params, cap + 1) as Array<SourceAggRow & { task_id: string; title: string | null; status: string | null; last_at: string | null }>;

  const truncated = heads.length > cap;
  const kept = truncated ? heads.slice(0, cap) : heads;
  const rows: InjectionTaskRoi[] = kept.map((h) => ({
    taskId: String(h.task_id ?? ''),
    title: String(h.title ?? ''),
    status: String(h.status ?? ''),
    injections: Number(h.n) || 0,
    chars: Number(h.chars) || 0,
    estTokens: Number(h.tokens) || 0,
    completed: Number(h.completed) || 0,
    failed: Number(h.failed) || 0,
    pending: Number(h.pending) || 0,
    wasteChars: Number(h.waste) || 0,
    lastAt: String(h.last_at ?? ''),
    bySource: [],
  }));

  if (rows.length > 0) {
    const places = rows.map(() => '?').join(', ');
    const parts = db.prepare(
      `SELECT ci.task_id AS task_id,
              ci.source AS source,
              COUNT(*) AS n,
              COALESCE(SUM(ci.chars), 0) AS chars,
              SUM(CASE WHEN ci.outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN ci.outcome = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM wa_context_injections ci
        WHERE ci.task_id IN (${places})
        GROUP BY ci.task_id, ci.source
        ORDER BY ci.source`,
    ).all(...rows.map((r) => r.taskId)) as Array<{ task_id: string; source: string; n: number; chars: number | null; completed: number | null; failed: number | null }>;
    const byTask = new Map(rows.map((r) => [r.taskId, r]));
    for (const p of parts) {
      const row = byTask.get(String(p.task_id ?? ''));
      if (!row) continue;
      row.bySource.push({
        source: String(p.source ?? ''),
        label: injectionSourceLabel(String(p.source ?? '')),
        injections: Number(p.n) || 0,
        chars: Number(p.chars) || 0,
        completed: Number(p.completed) || 0,
        failed: Number(p.failed) || 0,
      });
    }
  }

  return { rows, truncated };
}

/**
 * 面板唯一读口：合计账全档可看；每任务明细**先过 Team 审计视图闸，再**查库。
 * `opts` 只把 `now`/`fingerprint` 等验签参数透传给档位判定；`limit` 不参与闸。
 */
export function injectionRoi(
  db: ReadDb,
  licDb: ReadDb | null | undefined,
  projectId?: string,
  opts: ResolveLicenseOpts & { limit?: number } = {},
): InjectionRoiView {
  const summary = injectionRoiSummary(db, projectId);
  const { limit, ...licOpts } = opts;
  const refusal = teamFeatureRefusal(licDb, 'audit_view', licOpts);
  if (refusal) {
    return { summary, detail: { unlocked: false, refusal, rows: [], truncated: false } };
  }
  const detail = injectionTaskDetail(db, projectId, limit);
  return { summary, detail: { unlocked: true, refusal: '', rows: detail.rows, truncated: detail.truncated } };
}
