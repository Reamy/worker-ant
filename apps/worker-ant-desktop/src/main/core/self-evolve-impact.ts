/**
 * zx_20261122_1 M4「自·见」（维特根斯坦·一个用途一个词 / 毛选·实事求是）:
 *   **自省规则的影响复盘**——只回答一件事：批准这条规则之后，同类工具拒绝**变多还是变少**。
 *
 * 纪律：
 *   ① 只报**频率**（次/天），不报因果；窗口按天归一，长短窗口可比；
 *   ② 证据不足就说不足：批准后 < 3 天、或批准前一个都没有 ⇒ `insufficient`；
 *   ③ 只对 `rule` 且 `applied/rolled_back` 的提案算；未生效的提案没有「前后」。
 *
 * ⚠ 零 electron / 零网络 / 零 LLM：rr 拿内存库可直跑真实现。
 */
import type Database from 'better-sqlite3';
import type { SelfEvolveProposal } from './self-evolve.js';

export type ImpactVerdict = 'better' | 'worse' | 'flat' | 'insufficient';

export interface RuleProposalImpact {
  denyKind: string;
  windowDays: number;
  before: number;
  beforePerDay: number;
  after: number;
  afterPerDay: number;
  daysSince: number;
  verdict: ImpactVerdict;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 批准后至少观察几天才敢说好坏。 */
export const IMPACT_MIN_AFTER_DAYS = 3;
/** 好/坏阈值（相对批准前每日频率）。 */
export const IMPACT_BETTER_RATIO = 0.7;
export const IMPACT_WORSE_RATIO = 1.2;

function utcSqlText(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** 库内 UTC 时间串（可带 Z / T / 毫秒）→ epoch ms；解析不了 ⇒ null。 */
export function parseDbUtcMs(raw: unknown): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const iso = s.includes('T') ? (s.endsWith('Z') ? s : `${s}Z`) : `${s.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function countDenials(db: Database.Database, kind: string, fromText: string, toText: string): number {
  try {
    const row = db.prepare(
      "SELECT COUNT(*) AS c FROM wa_task_runtime_evidence WHERE deny_reason LIKE 'deny_kind=' || ? || ';%' AND created_at >= ? AND created_at < ?",
    ).get(kind, fromText, toText) as { c?: unknown } | undefined;
    const n = Number(row?.c);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/**
 * 计算一条 rule 提案的影响；不适用（非 rule / 未生效 / 无 denyKind / 时间坏）⇒ `null`。
 */
export function ruleProposalImpact(
  db: Database.Database,
  proposal: Pick<SelfEvolveProposal, 'kind' | 'status' | 'decided_at' | 'payload_json'>,
  opts: { now?: number } = {},
): RuleProposalImpact | null {
  if (String(proposal.kind ?? '') !== 'rule') return null;
  const status = String(proposal.status ?? '');
  if (status !== 'applied' && status !== 'rolled_back') return null;
  const decidedMs = parseDbUtcMs(proposal.decided_at);
  if (decidedMs === null) return null;
  let payload: { denyKind?: unknown; windowDays?: unknown } = {};
  try { payload = JSON.parse(String(proposal.payload_json ?? '{}')) as typeof payload; } catch { return null; }
  const denyKind = typeof payload.denyKind === 'string' ? payload.denyKind.trim() : '';
  if (!denyKind) return null;
  const windowDays = Math.max(1, Math.floor(Number(payload.windowDays) || 30));
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  if (now <= decidedMs) return null;

  const beforeFrom = decidedMs - windowDays * DAY_MS;
  const before = countDenials(db, denyKind, utcSqlText(beforeFrom), utcSqlText(decidedMs));
  const after = countDenials(db, denyKind, utcSqlText(decidedMs), utcSqlText(now));
  const daysSince = Math.max(0, (now - decidedMs) / DAY_MS);
  const beforePerDay = before / windowDays;
  const afterPerDay = daysSince > 0 ? after / daysSince : 0;

  let verdict: ImpactVerdict;
  if (daysSince < IMPACT_MIN_AFTER_DAYS || before === 0) verdict = 'insufficient';
  else if (afterPerDay < beforePerDay * IMPACT_BETTER_RATIO) verdict = 'better';
  else if (afterPerDay > beforePerDay * IMPACT_WORSE_RATIO) verdict = 'worse';
  else verdict = 'flat';

  return { denyKind, windowDays, before, beforePerDay, after, afterPerDay, daysSince, verdict };
}
