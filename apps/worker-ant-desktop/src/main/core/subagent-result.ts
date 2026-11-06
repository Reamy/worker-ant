/**
 * zx_20261105_1 M4（王阳明·知行合一 / 维特根斯坦·意义即用法）：**子代理结论结构化**。
 *
 * 病根：验证子代理的结论只藏在对话行与自由文本里——父任务、详情页、判卷各读一版，
 * "过了没有""凭什么过的""哪里没跑成"三样混成一段散文。结论必须与证据、限定条件分开落。
 *
 * 写法（一条链，一处真源）：
 *   1. 从**最后一条 assistant 文本**里找 JSON 代码块；块内带 `conclusion` 或 `criteria` ⇒ 结构化采用；
 *   2. 解析失败 ⇒ `verdict:'unknown'`（**绝不推断为 pass**），`summary` 取末条正文截断 1000 字；
 *   3. `limitations` **只取自本任务 `wa_task_runtime_evidence` 中 `ok=0` 的记录**，不由模型自述——
 *      台账说"被拒 2 次"，结论里就不能写"无 shell 约束"；
 *   4. `build` 从 `context_json.run_features.build` 派生（本模块不写第二个 build 字面量，防 P6 双源）。
 *
 * 写入 best-effort：只对 `context_json.type === 'subagent'` 生效；写失败返回 null，不阻断收口。
 * 本模块零 electron 依赖，rr 可直跑真实现。
 */
import type Database from 'better-sqlite3';
import { listRuntimeEvidence, evidenceIdOf, type RuntimeEvidenceRow } from './runtime-evidence.js';
import { mergeTaskContext } from './context-merge.js';

export const SUBAGENT_RESULT_KEY = 'subagent_result';

export type SubagentVerdict = 'pass' | 'fail' | 'unknown';

export const SUBAGENT_VERDICT_LABEL: Record<SubagentVerdict, string> = {
  pass: '通过',
  fail: '未通过',
  unknown: '未判明',
};

export function verdictLabelOf(v: SubagentVerdict): string {
  return SUBAGENT_VERDICT_LABEL[v] ?? SUBAGENT_VERDICT_LABEL.unknown;
}

export interface SubagentCriterion {
  criterion: string;
  passed: boolean | null;
  reason: string;
  evidence_refs: string[];
}

export interface SubagentResult {
  subagentType: string | null;
  verdict: SubagentVerdict;
  summary: string;
  criteria: SubagentCriterion[];
  limitations: string[];
  concluded_at: string;
  build?: string;
}

export interface ParsedSubagentConclusion {
  verdict: SubagentVerdict;
  summary: string;
  criteria: SubagentCriterion[];
  /** 是否真认出一个结构化块（false ⇒ 走 fallback unknown + 原文摘要）。 */
  structured: boolean;
}

const SUMMARY_LIMIT = 1000;
const TEXT_LIMIT = 300;
const MAX_CRITERIA = 20;
const MAX_REFS = 10;
const MAX_LIMITATIONS = 6;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const oneLine = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max);

function normalizeVerdict(v: unknown): SubagentVerdict | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'pass' || s === 'passed') return 'pass';
  if (s === 'fail' || s === 'failed') return 'fail';
  if (s === 'unknown') return 'unknown';
  return null;
}

/** 文本里的 ```json 代码块 → 对象列表；块前若有一句导语，取首个 `{` 起的部分再试一次。 */
function jsonObjectsIn(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const re = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = (m[1] || '').trim();
    if (!body) continue;
    const candidates = [body];
    const start = body.indexOf('{');
    if (start > 0) candidates.push(body.slice(start));
    for (const c of candidates) {
      try {
        const parsed = JSON.parse(c) as unknown;
        const obj = asRecord(parsed);
        if (obj) { out.push(obj); break; }
      } catch { /* 试下一个候选 */ }
    }
  }
  return out;
}

function normalizeCriterion(raw: unknown): SubagentCriterion | null {
  if (typeof raw === 'string') {
    const criterion = oneLine(raw, TEXT_LIMIT);
    return criterion ? { criterion, passed: null, reason: '', evidence_refs: [] } : null;
  }
  const o = asRecord(raw);
  if (!o) return null;
  const criterion = oneLine(
    typeof o.criterion === 'string' ? o.criterion : typeof o.name === 'string' ? o.name : '',
    TEXT_LIMIT,
  );
  if (!criterion) return null;
  let passed: boolean | null = typeof o.passed === 'boolean' ? o.passed : null;
  if (passed === null) {
    const byVerdict = normalizeVerdict(o.verdict);
    if (byVerdict === 'pass') passed = true;
    else if (byVerdict === 'fail') passed = false;
  }
  const reason = oneLine(typeof o.reason === 'string' ? o.reason : '', TEXT_LIMIT);
  const refsRaw = Array.isArray(o.evidence_refs) ? o.evidence_refs : Array.isArray(o.evidence) ? o.evidence : [];
  const refs: string[] = [];
  for (const r of refsRaw) {
    if (typeof r !== 'string') continue;
    const ref = r.trim();
    if (!/^run:[\w-]+$/.test(ref) || refs.includes(ref)) continue;
    refs.push(ref);
    if (refs.length >= MAX_REFS) break;
  }
  return { criterion, passed, reason, evidence_refs: refs };
}

/**
 * 解析结论。**只认代码块**（正文里出现 JSON 字符不算）；块里认 `criteria` 或 `conclusion`。
 * verdict 优先取显式字段；没有显式 verdict 时，仅当每条判据都有明确 `passed` 才从判据聚合，
 * 其余一律 `unknown`——「没说」不当作「通过」。
 */
export function parseSubagentConclusion(text: string | null | undefined): ParsedSubagentConclusion {
  const raw = String(text ?? '');
  const fallbackSummary = raw.trim().slice(0, SUMMARY_LIMIT);
  let best: Record<string, unknown> | null = null;
  for (const obj of jsonObjectsIn(raw)) {
    if ('criteria' in obj || 'conclusion' in obj) best = obj; // 多个块：取最后一个（末轮结论）
  }
  if (!best) return { verdict: 'unknown', summary: fallbackSummary, criteria: [], structured: false };

  const criteria: SubagentCriterion[] = [];
  if (Array.isArray(best.criteria)) {
    for (const c of best.criteria) {
      const n = normalizeCriterion(c);
      if (n) criteria.push(n);
      if (criteria.length >= MAX_CRITERIA) break;
    }
  }

  let verdict = normalizeVerdict(best.verdict) ?? normalizeVerdict(best.conclusion);
  if (!verdict) {
    if (criteria.length > 0 && criteria.every((c) => c.passed === true)) verdict = 'pass';
    else if (criteria.some((c) => c.passed === false)) verdict = 'fail';
    else verdict = 'unknown';
  }

  const modelSummary = typeof best.summary === 'string' ? best.summary.trim() : '';
  const summary = (modelSummary || fallbackSummary).slice(0, SUMMARY_LIMIT);
  return { verdict, summary, criteria, structured: true };
}

/**
 * 限定条件**只来自台账**：`wa_task_runtime_evidence` 中 `ok=0` 的拒绝/失败/超时记录，按原因聚合计数。
 * 模型自述的 limitations 一律丢弃——它与台账矛盾时，以台账为准。
 */
export function limitationsFromEvidence(rows: readonly RuntimeEvidenceRow[]): string[] {
  const groups = new Map<string, { text: string; count: number }>();
  for (const r of rows) {
    if (r.ok !== 0) continue;
    const tool = String(r.tool || 'unknown');
    let text: string;
    if (r.deny_reason) text = `${tool} 被守卫拒绝（${oneLine(String(r.deny_reason), 120)}）`;
    else if (r.timed_out) text = `${tool} 执行超时`;
    else text = `${tool} 执行失败（退出码 ${r.exit_code == null ? '未知' : String(r.exit_code)}）`;
    const g = groups.get(text);
    if (g) g.count += 1;
    else groups.set(text, { text, count: 1 });
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_LIMITATIONS)
    .map((g) => (g.count > 1 ? `${g.text} ${g.count} 次` : g.text));
}

/** `context_json.type === 'subagent'` —— 唯一判据，读点/写点/展示同取这一份。 */
export function isSubagentTaskContext(contextJson: string | null | undefined): boolean {
  try {
    return asRecord(JSON.parse(contextJson || '{}'))?.type === 'subagent';
  } catch {
    return false;
  }
}

/** 读已落库的结构化结论；无键/坏形状返回 null——**不编造**。 */
export function readSubagentResult(contextJson: string | null | undefined): SubagentResult | null {
  try {
    const raw = asRecord(JSON.parse(contextJson || '{}'))?.[SUBAGENT_RESULT_KEY];
    const o = asRecord(raw);
    if (!o) return null;
    const verdict = normalizeVerdict(o.verdict) ?? 'unknown';
    const criteria: SubagentCriterion[] = [];
    if (Array.isArray(o.criteria)) {
      for (const c of o.criteria) {
        const n = normalizeCriterion(c);
        if (n) criteria.push(n);
        if (criteria.length >= MAX_CRITERIA) break;
      }
    }
    const result: SubagentResult = {
      subagentType: typeof o.subagentType === 'string' && o.subagentType ? o.subagentType : null,
      verdict,
      summary: typeof o.summary === 'string' ? o.summary.slice(0, SUMMARY_LIMIT) : '',
      criteria,
      limitations: Array.isArray(o.limitations)
        ? o.limitations.filter((x): x is string => typeof x === 'string').slice(0, MAX_LIMITATIONS)
        : [],
      concluded_at: typeof o.concluded_at === 'string' ? o.concluded_at : '',
    };
    if (typeof o.build === 'string' && /^zx_[0-9_]+$/.test(o.build)) result.build = o.build;
    return result;
  } catch {
    return null;
  }
}

/** build 从既有 `run_features.build` 派生——本模块**不写第二个** `zx_…` 字面量（P6 单源）。 */
function buildTagOf(ctx: Record<string, unknown>): string | undefined {
  const b = asRecord(ctx.run_features)?.build;
  return typeof b === 'string' && /^zx_[0-9_]+$/.test(b) ? b : undefined;
}

function lastAssistantText(db: Database.Database, taskId: string): string {
  try {
    const r = db.prepare(
      "SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(taskId) as { content?: string } | undefined;
    return typeof r?.content === 'string' ? r.content : '';
  } catch {
    return '';
  }
}

export interface WriteSubagentResultInput {
  /** 本 run 的终态文本（在收口作用域内直接给；缺/空则回查最近一条 assistant）。 */
  finalText?: string;
}

/**
 * 终态收口处调用：仅对 `type === 'subagent'` 生效，经 `mergeTaskContext` 合并写 `subagent_result`。
 * 返回落下的结论；未写/写失败返回 null（best-effort，不阻断收口）。
 */
export function writeSubagentResult(
  db: Database.Database,
  taskId: string,
  opts?: WriteSubagentResultInput,
): SubagentResult | null {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as
      | { context_json?: string | null }
      | undefined;
    if (!row) return null;
    let ctx: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.context_json || '{}') as unknown;
      const obj = asRecord(parsed);
      if (!obj) return null;
      ctx = obj;
    } catch {
      return null;
    }
    if (ctx.type !== 'subagent') return null;

    const text = opts?.finalText?.trim() ? opts.finalText : lastAssistantText(db, taskId);
    const parsed = parseSubagentConclusion(text);
    const evidence = listRuntimeEvidence(db, taskId, 50);
    const validRefs = new Set(evidence.map(evidenceIdOf));
    const result: SubagentResult = {
      subagentType: typeof ctx.subagentType === 'string' && ctx.subagentType ? ctx.subagentType : null,
      verdict: parsed.verdict,
      summary: parsed.summary,
      // 判据引用只能落到本任务账上真有的 `run:<id>`：模型自造的编号一律剔掉（引用须可回查）。
      criteria: parsed.criteria.map((c) => ({
        ...c,
        evidence_refs: c.evidence_refs.filter((r) => validRefs.has(r)),
      })),
      limitations: limitationsFromEvidence(evidence),
      concluded_at: new Date().toISOString(),
    };
    const build = buildTagOf(ctx);
    if (build) result.build = build;

    if (!mergeTaskContext(db, taskId, { [SUBAGENT_RESULT_KEY]: result })) return null;
    return result;
  } catch {
    return null;
  }
}
