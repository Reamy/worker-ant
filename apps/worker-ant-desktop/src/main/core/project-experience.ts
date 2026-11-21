/**
 * zx_20261121_1 M4「数·尺」：**项目经验账**——把已发生的事实变成可核对的一页。
 *
 * 病根（真库 2026-11-21）：项目已有 `tool_usage`（按项目×archetype 记工具成败）与执行打法注入，
 *   但只有“优先/避免工具”两句；答不出“这个项目一般花多少 token/多少步、哪些命令总被拒、
 *   哪些失败总重演、服务调用成不成、注入值不值”。预算仍按静态 `ARCHETYPE_BUDGETS`。
 *
 * 四条纪律：
 *   ① **零 LLM / 零网络 / 零 electron**：只读既有表；rr 可拿内存库直跑真实现。
 *   ② **每数可回查**：规模取 `execution_metrics`、坑取 `wa_task_runtime_evidence.deny_reason`、
 *      失败取 `task.failed` 事件、服务取 `wa_service_calls`、ROI 取 `wa_context_injections`；
 *      不用 `wa_task_conversations` 求和（resume 会双计）。
 *   ③ **证据不足说不足**：样本不过门槛 ⇒ 不列该行/`enough=false`，不把未知写成 0。
 *   ④ **不据此自动改行为**：预算只给建议；注入只给一句提醒；人不点就不变。
 */
import { createHash } from 'node:crypto';
import type { ServiceCallReport } from './service-call-ledger.js';
import { describeServiceCalls } from './service-call-ledger.js';
import { sourceRoiRows, type SourceRoiRow } from './context-roi.js';
import { denialKindOf } from './tool-denials.js';
import { redactCommand } from './runtime-evidence.js';
import { estimateTokensFromChars, TOKEN_CHARS_PER_UNIT } from './token-estimate.js';
import {
  EXPERIENCE_INJECT_MAX_TOKENS,
  EXPERIENCE_MIN_ARCHETYPE_TASKS,
  EXPERIENCE_MIN_COMPLETED,
  EXPERIENCE_MIN_TOOL_CALLS,
  EXPERIENCE_TOP_PITFALLS,
  EXPERIENCE_WINDOW_DAYS,
  PITFALL_ADVICE,
  PITFALL_LABEL,
} from './project-experience-labels.js';

export interface ExperienceDb {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
}

export interface ExperienceScaleRow {
  archetype: string;
  tasks: number;
  tokensP50: number | null;
  tokensP90: number | null;
  stepsP50: number | null;
  stepsP90: number | null;
  /** 有执行账的单 / 该形态完成单（0..1）。 */
  coverage: number;
}

export interface ExperienceToolRow {
  tool: string;
  archetype: string;
  success: number;
  fail: number;
  total: number;
  rate: number | null;
}

export interface ExperiencePitfall {
  kind: string;
  count: number;
  lastAt: string | null;
  advice: string;
  /** 一条脱敏后的样例（≤80 字；可能为空）。 */
  sample?: string;
}

export interface ExperienceRealFailure {
  tool: string;
  count: number;
  lastAt: string | null;
}

export interface ExperienceFailure {
  cause: string;
  phase: string;
  count: number;
  lastAt: string;
  taskIds: string[];
}

export interface ExperienceInjectionRoi {
  rows: SourceRoiRow[];
  baseline: number | null;
  samples: number;
}

export interface ProjectExperienceBrief {
  projectId: string;
  generatedAt: string;
  windowDays: number;
  sourceHash: string;
  evidence: {
    completed: number;
    failed: number;
    withMetrics: number;
    toolCalls: number;
    pitfalls: number;
    failures: number;
  };
  enough: boolean;
  scale: ExperienceScaleRow[];
  tools: ExperienceToolRow[];
  pitfalls: ExperiencePitfall[];
  realFailures: ExperienceRealFailure[];
  failures: ExperienceFailure[];
}

export interface ProjectExperience extends ProjectExperienceBrief {
  services: ServiceCallReport | null;
  injections: ExperienceInjectionRoi;
}

export interface ExperienceOptions {
  sinceDays?: number;
  /** ROI 最小样本（默认 10；rr 可放小）。 */
  minSamples?: number;
}

/** 线性插值分位数；空/全非有限 ⇒ null。 */
export function percentile(values: readonly number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const q = Math.max(0, Math.min(100, p));
  if (xs.length === 1) return xs[0]!;
  const idx = (q / 100) * (xs.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return xs[lo]!;
  const w = idx - lo;
  return xs[lo]! + (xs[hi]! - xs[lo]!) * w;
}

const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_HEX_RE = /\b[0-9a-f]{16,}\b/gi;
const URL_QUERY_RE = /(https?:\/\/[^\s?]+)\?[^\s]*/gi;

/** 脱敏 + 归一 + 截断：失败因只到“可归并的一类”，不留明文口令。 */
export function normalizeFailureCause(raw: unknown): string {
  let s = String(raw ?? '');
  s = redactCommand(s);
  s = s.replace(URL_QUERY_RE, '$1');
  s = s.replace(ISO_RE, '<time>').replace(UUID_RE, '<id>').replace(LONG_HEX_RE, '<hex>');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '未记录原因';
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

function redactSample(raw: unknown): string {
  const s = redactCommand(String(raw ?? '')).replace(/\s+/g, ' ').trim();
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '未记录';
  return Math.round(n).toLocaleString('en-US');
}

function emptyBrief(projectId: string, windowDays: number): ProjectExperienceBrief {
  return {
    projectId,
    generatedAt: new Date().toISOString(),
    windowDays,
    sourceHash: '',
    evidence: { completed: 0, failed: 0, withMetrics: 0, toolCalls: 0, pitfalls: 0, failures: 0 },
    enough: false,
    scale: [],
    tools: [],
    pitfalls: [],
    realFailures: [],
    failures: [],
  };
}

/** 轻量版：规模 + 工具 + 浪费坑 + 真失败（不查服务账/ROI）。 */
export function deriveExperienceBrief(
  db: ExperienceDb,
  projectId: string,
  opts: ExperienceOptions = {},
): ProjectExperienceBrief {
  const pid = String(projectId ?? '').trim();
  const windowDays = Math.max(1, Math.trunc(opts.sinceDays ?? EXPERIENCE_WINDOW_DAYS));
  const out = emptyBrief(pid, windowDays);
  if (!pid) return out;
  const since = `-${windowDays} days`;

  // 1) 完成/失败单数
  try {
    const counts = db.prepare(
      `SELECT
         SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS bad
       FROM wa_tasks WHERE project_id = ? AND created_at >= datetime('now', ?)`,
    ).get(pid, since) as { done?: number | null; bad?: number | null } | undefined;
    out.evidence.completed = Number(counts?.done) || 0;
    out.evidence.failed = Number(counts?.bad) || 0;
  } catch { /* 读不到 ⇒ 保持 0 并在 enough=false 体现 */ }

  // 2) 规模账：只用 execution_metrics（不用会话求和，防 resume 双计）
  try {
    const rows = db.prepare(
      `SELECT COALESCE(json_extract(context_json,'$.execution_metrics.archetype'), 'unknown') AS archetype,
              json_extract(context_json,'$.execution_metrics.totalTokens') AS tokens,
              json_extract(context_json,'$.execution_metrics.stepsUsed') AS steps
         FROM wa_tasks
        WHERE project_id = ? AND status='completed' AND created_at >= datetime('now', ?)
          AND json_extract(context_json,'$.execution_metrics.totalTokens') IS NOT NULL`,
    ).all(pid, since) as Array<{ archetype?: string; tokens?: number | null; steps?: number | null }>;
    const groups = new Map<string, { tokens: number[]; steps: number[] }>();
    for (const r of rows) {
      const a = String(r.archetype ?? 'unknown');
      const g = groups.get(a) ?? { tokens: [], steps: [] };
      const t = Number(r.tokens);
      const s = Number(r.steps);
      if (Number.isFinite(t) && t >= 0) g.tokens.push(t);
      if (Number.isFinite(s) && s >= 0) g.steps.push(s);
      groups.set(a, g);
    }
    out.evidence.withMetrics = rows.length;
    // 覆盖率分母：同形态完成单（含无执行账者）
    const denomRows = db.prepare(
      `SELECT COALESCE(json_extract(context_json,'$.execution_metrics.archetype'), json_extract(context_json,'$.archetype'), 'unknown') AS archetype,
              COUNT(*) AS n
         FROM wa_tasks
        WHERE project_id = ? AND status='completed' AND created_at >= datetime('now', ?)
        GROUP BY archetype`,
    ).all(pid, since) as Array<{ archetype?: string; n?: number | null }>;
    const denom = new Map(denomRows.map((r) => [String(r.archetype ?? 'unknown'), Number(r.n) || 0]));
    for (const [archetype, g] of groups) {
      if (g.tokens.length < EXPERIENCE_MIN_ARCHETYPE_TASKS) continue;
      const total = denom.get(archetype) || g.tokens.length;
      out.scale.push({
        archetype,
        tasks: g.tokens.length,
        tokensP50: percentile(g.tokens, 50),
        tokensP90: percentile(g.tokens, 90),
        stepsP50: g.steps.length > 0 ? percentile(g.steps, 50) : null,
        stepsP90: g.steps.length > 0 ? percentile(g.steps, 90) : null,
        coverage: total > 0 ? Math.round((g.tokens.length / total) * 10000) / 10000 : 0,
      });
    }
    out.scale.sort((a, b) => b.tasks - a.tasks || a.archetype.localeCompare(b.archetype));
  } catch { /* 读不到 ⇒ 空账 */ }

  // 3) 工具可靠度：复用 project.context_json.tool_usage（F5/F6），不另记一份
  try {
    const row = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(pid) as { context_json?: string } | undefined;
    const ctx = JSON.parse(row?.context_json || '{}') as {
      tool_usage?: Record<string, { toolName?: string; archetype?: string; successCount?: number; failCount?: number }>;
    };
    const list: ExperienceToolRow[] = [];
    let allCalls = 0;
    for (const rec of Object.values(ctx.tool_usage ?? {})) {
      const success = Number(rec.successCount) || 0;
      const fail = Number(rec.failCount) || 0;
      const total = success + fail;
      allCalls += total;
      if (total < 3) continue;
      list.push({
        tool: String(rec.toolName ?? 'unknown'),
        archetype: String(rec.archetype ?? 'unknown'),
        success,
        fail,
        total,
        rate: total > 0 ? Math.round((success / total) * 10000) / 10000 : null,
      });
    }
    list.sort((a, b) => b.total - a.total || a.tool.localeCompare(b.tool) || a.archetype.localeCompare(b.archetype));
    out.evidence.toolCalls = allCalls;
    out.tools = allCalls >= EXPERIENCE_MIN_TOOL_CALLS ? list.slice(0, 10) : [];
  } catch { /* 读不到 ⇒ 空账 */ }

  // 4) 浪费坑 + 真命令失败：运行证据按项目收窄
  try {
    const rows = db.prepare(
      `SELECT e.deny_reason AS reason, e.command AS command, e.ok AS ok, e.tool AS tool, e.created_at AS at
         FROM wa_task_runtime_evidence e
         JOIN wa_tasks t ON t.id = e.task_id
        WHERE t.project_id = ? AND t.created_at >= datetime('now', ?)`,
    ).all(pid, since) as Array<{ reason?: string | null; command?: string | null; ok?: number | null; tool?: string | null; at?: string | null }>;
    const pit = new Map<string, { count: number; lastAt: string | null; sample: string }>();
    const real = new Map<string, { count: number; lastAt: string | null }>();
    for (const r of rows) {
      const reason = String(r.reason ?? '').trim();
      if (!reason) {
        if (Number(r.ok) === 0) {
          const tool = String(r.tool ?? 'unknown');
          const cur = real.get(tool) ?? { count: 0, lastAt: null };
          cur.count++;
          if (r.at && (!cur.lastAt || r.at > cur.lastAt)) cur.lastAt = r.at;
          real.set(tool, cur);
        }
        continue;
      }
      const kind = denialKindOf(reason);
      const cur = pit.get(kind) ?? { count: 0, lastAt: null, sample: '' };
      cur.count++;
      if (r.at && (!cur.lastAt || r.at > cur.lastAt)) cur.lastAt = r.at;
      if (!cur.sample && r.command) cur.sample = redactSample(r.command);
      pit.set(kind, cur);
    }
    out.pitfalls = [...pit.entries()]
      .map(([kind, v]) => ({ kind, count: v.count, lastAt: v.lastAt, advice: PITFALL_ADVICE[kind] ?? '', ...(v.sample ? { sample: v.sample } : {}) }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
    out.realFailures = [...real.entries()]
      .map(([tool, v]) => ({ tool, count: v.count, lastAt: v.lastAt }))
      .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
    out.evidence.pitfalls = out.pitfalls.reduce((n, p) => n + p.count, 0);
  } catch { /* 读不到 ⇒ 空账 */ }

  // 5) 失败因：task.failed 事件，归并同类、带 taskId
  try {
    const rows = db.prepare(
      `SELECT e.aggregate_id AS task_id, e.payload AS payload, e.occurred_at AS at
         FROM wa_event_log e
         JOIN wa_tasks t ON t.id = e.aggregate_id
        WHERE e.event_type = 'task.failed' AND t.project_id = ? AND e.occurred_at >= datetime('now', ?)
        ORDER BY e.occurred_at DESC LIMIT 500`,
    ).all(pid, since) as Array<{ task_id?: string; payload?: string; at?: string }>;
    const map = new Map<string, { cause: string; phase: string; count: number; lastAt: string; ids: string[] }>();
    for (const r of rows) {
      let err = '';
      let phase = '';
      try {
        const p = JSON.parse(String(r.payload ?? '{}')) as { error?: unknown; phase?: unknown };
        err = typeof p.error === 'string' ? p.error : '';
        phase = typeof p.phase === 'string' ? p.phase : '';
      } catch { /* 坏载荷 ⇒ 未记录原因 */ }
      const cause = normalizeFailureCause(err);
      const key = `${phase}|${cause}`;
      const cur = map.get(key) ?? { cause, phase, count: 0, lastAt: '', ids: [] };
      cur.count++;
      if (r.at && (!cur.lastAt || r.at > cur.lastAt)) cur.lastAt = r.at;
      const tid = String(r.task_id ?? '');
      if (tid && cur.ids.length < 3 && !cur.ids.includes(tid)) cur.ids.push(tid);
      map.set(key, cur);
    }
    out.failures = [...map.values()]
      .filter((f) => f.count >= 2)
      .map((f) => ({ cause: f.cause, phase: f.phase, count: f.count, lastAt: f.lastAt, taskIds: f.ids }))
      .sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));
    out.evidence.failures = rows.length;
  } catch { /* 读不到 ⇒ 空账 */ }

  out.enough = out.evidence.completed >= EXPERIENCE_MIN_COMPLETED && (out.scale.length > 0 || out.pitfalls.length > 0);
  out.sourceHash = experienceSourceHash(out);
  return out;
}

/** 全量版：轻量版 + 服务调用账 + 注入 ROI（只读，不据此决策）。 */
export function deriveProjectExperience(
  db: ExperienceDb,
  projectId: string,
  opts: ExperienceOptions = {},
): ProjectExperience {
  const brief = deriveExperienceBrief(db, projectId, opts);
  let services: ServiceCallReport | null = null;
  try { services = describeServiceCalls(db as never, brief.projectId); } catch { services = null; }
  let injections: ExperienceInjectionRoi = { rows: [], baseline: null, samples: 0 };
  try {
    injections = sourceRoiRows(db as never, {
      projectId: brief.projectId,
      sinceDays: brief.windowDays,
      minSamples: Math.max(1, Math.trunc(opts.minSamples ?? 10)),
    });
  } catch { injections = { rows: [], baseline: null, samples: 0 }; }
  return { ...brief, services, injections };
}

/** 输入指纹（不含 generatedAt）；同一输入必得同一值。 */
export function experienceSourceHash(exp: Pick<ProjectExperienceBrief, 'projectId' | 'windowDays' | 'evidence' | 'scale' | 'tools' | 'pitfalls' | 'realFailures' | 'failures'>): string {
  const canonical = JSON.stringify({
    projectId: exp.projectId,
    windowDays: exp.windowDays,
    evidence: exp.evidence,
    scale: exp.scale,
    tools: exp.tools,
    pitfalls: exp.pitfalls,
    realFailures: exp.realFailures,
    failures: exp.failures,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export function experienceRefId(exp: Pick<ProjectExperienceBrief, 'sourceHash'>): string {
  return `experience:${exp.sourceHash || 'unknown'}`;
}

export interface RenderedExperience {
  text: string;
  tokens: number;
  lines: string[];
}

/**
 * 渲染注入段：整行取舍、绝不截半句；默认 ≤120 token。
 * 无证据/证据不足 ⇒ 空段（调用方不注入、不记账）。
 */
export function renderExperienceBrief(exp: ProjectExperienceBrief, maxTokens = EXPERIENCE_INJECT_MAX_TOKENS): RenderedExperience {
  if (!exp.enough) return { text: '', tokens: 0, lines: [] };
  const lines: string[] = [];
  const topScale = exp.scale[0];
  if (topScale) {
    const archLabel = topScale.archetype === 'unknown' ? '未分类任务' : topScale.archetype;
    lines.push(`近${exp.windowDays}天已完成 ${exp.evidence.completed} 单；${archLabel} ${topScale.tasks} 单，p50 ${fmtNum(topScale.tokensP50)} / p90 ${fmtNum(topScale.tokensP90)} token。`);
  }
  const topPits = exp.pitfalls.filter((p) => p.count >= 3).slice(0, EXPERIENCE_TOP_PITFALLS);
  for (const p of topPits) {
    const label = PITFALL_LABEL[p.kind] ?? p.kind;
    lines.push(`坑：${label} ${p.count} 次${p.advice ? `；${p.advice}` : '。'}`);
  }
  const realTotal = exp.realFailures.reduce((n, r) => n + r.count, 0);
  if (realTotal >= 3) lines.push(`真命令失败 ${realTotal} 次；先跑最小测试/构建定位。`);

  let kept = lines;
  let text = kept.join('\n');
  const capChars = Math.max(0, maxTokens * TOKEN_CHARS_PER_UNIT);
  while (kept.length > 1 && text.length > capChars) {
    kept = kept.slice(0, -1);
    text = kept.join('\n');
  }
  if (kept.length === 1 && text.length > capChars) {
    // 单行也超：宁可整段不注入，也不截半句。
    return { text: '', tokens: 0, lines: [] };
  }
  return { text, tokens: estimateTokensFromChars(text.length), lines: kept };
}
