/**
 * zx_20261122_1 M3「自·产」（毛选·没有调查没有发言权 / 道德经·少则得 / 康德·先划界）:
 *   **拒绝留痕 → 自省规则提案**的确定性生产者。
 *
 * 病根：`wa_task_runtime_evidence.deny_reason` 已记下 3,842 条工具拒绝（非法字符 235、重定向 127、探索超限 220+），
 *   但 `rule` 类自进化提案**只有应用器、没有生产者**——「自我优化」停在半环；同一个坑反复犯，只进了项目经验账。
 *
 * 三条纪律：
 *   ① **只从已发生的拒绝归并**：不猜、不做 LLM 总结；同一类 ≥ `minCount` 次才立规（一次失误不立规）；
 *   ② **只产 `pending`，绝不自动应用**：规则改变执行期行为，必须过 `selfEvolve:decide` 人工闸；
 *   ③ **去重**：同 target 已有 pending ⇒ 不重复投；`agent.self_rules` 已有同文本 ⇒ 不重复投。
 *
 * ⚠ `target = self_rules.<kind>`（非源码树，过 `assertProposalTargetAllowed`）；`skill` 类**不产出**（无应用器）。
 * ⚠ 零 electron / 零网络 / 零 LLM：rr 拿内存库可直跑真实现。
 */
import type Database from 'better-sqlite3';
import { hasPendingProposalFor, readSelfEvolveRules, recordProposal } from './self-evolve.js';

/** 默认窗口（天）。 */
export const DENIAL_SCAN_WINDOW_DAYS = 30;
/** 默认最少次数（同类拒绝达到才立规）。 */
export const DENIAL_SCAN_MIN_COUNT = 20;

/** 有模板的拒绝类型——唯一定处；新增一类须同时补模板与 rr 标本。 */
export const DENIAL_RULE_TEMPLATES: Record<string, string> = {
  illegal_char: '命令里不要用换行、分号、&&、||、管道 | 或 $()；一条命令一次调用；需要管道请改用 bash 工具。',
  redirection: '写文件用 write_file / edit_file，不要用 > 或 >> 重定向。',
  exploration_limit: '盘点优先 read_file / search_content / list_files（不占 shell 探索配额）；shell 留给测试、构建与 git。',
  not_in_whitelist: 'bash 不支持 cd；切目录用 execute_command。白名单外的只读命令先用 ask_user 说明用途，不要反复试。',
};

export type DenialSkipReason = 'below_threshold' | 'pending_exists' | 'rule_exists' | 'no_template' | 'write_failed';

export interface DenialScanResult {
  windowDays: number;
  minCount: number;
  counts: Array<{ kind: string; count: number }>;
  created: Array<{ kind: string; proposalId: string }>;
  skipped: Array<{ kind: string; reason: DenialSkipReason; count: number }>;
}

export interface DenialScanOpts {
  windowDays?: number;
  minCount?: number;
  /** 注入时钟（受控回归用）。 */
  now?: number;
}

function utcSqlText(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** `deny_kind=illegal_char; …` → `illegal_char`；非此形 ⇒ 空串（不猜）。 */
export function parseDenyKind(reason: unknown): string {
  const s = String(reason ?? '');
  const m = /^deny_kind=([a-z0-9_]+);/.exec(s);
  return m?.[1] ?? '';
}

/**
 * 扫描拒绝留痕并投 `rule` 提案。读不到证据表 ⇒ 空结果（不抛）；写入失败只记 `write_failed`。
 */
export function generateDenialRuleProposals(db: Database.Database, opts: DenialScanOpts = {}): DenialScanResult {
  const windowDays = Math.max(1, Math.floor(Number(opts.windowDays) || DENIAL_SCAN_WINDOW_DAYS));
  const minCount = Math.max(1, Math.floor(Number(opts.minCount) || DENIAL_SCAN_MIN_COUNT));
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const since = utcSqlText(now - windowDays * 24 * 60 * 60 * 1000);

  const counts = new Map<string, number>();
  try {
    const rows = db.prepare(
      "SELECT deny_reason FROM wa_task_runtime_evidence WHERE created_at >= ? AND deny_reason LIKE 'deny_kind=%'",
    ).all(since) as Array<{ deny_reason?: unknown }>;
    for (const r of rows) {
      const kind = parseDenyKind(r.deny_reason);
      if (!kind) continue;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  } catch {
    return { windowDays, minCount, counts: [], created: [], skipped: [] };
  }

  const result: DenialScanResult = {
    windowDays,
    minCount,
    counts: [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    created: [],
    skipped: [],
  };
  const existingRules = new Set(readSelfEvolveRules(db));

  for (const { kind, count } of result.counts) {
    if (count < minCount) { result.skipped.push({ kind, reason: 'below_threshold', count }); continue; }
    const text = DENIAL_RULE_TEMPLATES[kind];
    if (!text) { result.skipped.push({ kind, reason: 'no_template', count }); continue; }
    const target = `self_rules.${kind}`;
    if (hasPendingProposalFor(db, target)) { result.skipped.push({ kind, reason: 'pending_exists', count }); continue; }
    if (existingRules.has(text)) { result.skipped.push({ kind, reason: 'rule_exists', count }); continue; }
    const rec = recordProposal(db, {
      kind: 'rule',
      target,
      payload: { text, denyKind: kind, windowDays, evidenceCount: count },
      source: 'denial_audit',
      note: `近 ${windowDays} 天同类工具拒绝 ${count} 次（${kind}）——建议写成执行期规则；批准后才生效。`,
    });
    if (!rec.ok) { result.skipped.push({ kind, reason: 'write_failed', count }); continue; }
    result.created.push({ kind, proposalId: rec.id });
    existingRules.add(text);
  }
  return result;
}
