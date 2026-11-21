/**
 * zx_20261109_1 B5（G13 · 完成账可回查 / 大野耐一「消除浪费」）:
 * **一次 run 的收口痕迹**——完成事件不重复发、收口自检行能看出是哪一轮。
 *
 * 病根（真库实证）：`eb797102` 3 次、`e7368ef3` 2 次 `task.completed`（续跑各算一轮，但同一 run 内
 * 两个收口出口没有互相设防）；`finalize_checks` 续跑后新旧混作一团，看不出哪行属于哪一轮。
 *
 * 治法：run 身份由 `executeTask` 一处派生，两个出口共用同一份 ctx；事件载荷带 `run_id`，
 * 同一 `run_id` 只发一次；自检行在级别标签之后插 `[run <8 位>]`，旧条目**原样保留**（不抹历史）。
 * 纯函数、零 IO——rr 可直跑真实现。
 */
import { randomUUID } from 'node:crypto';

export function newRunId(): string {
  return randomUUID();
}

/** UUID → 8 位小写标识（去连字符后取前 8 位）。空值返回空串。 */
export function shortRunId(runId: string | undefined | null): string {
  const s = String(runId ?? '').trim().toLowerCase().replace(/-/g, '');
  return s.slice(0, 8);
}

/** 行首的级别标签 [`[PASS]`/`[WARN]`/`[FAIL]`/`[INFO]`]，以及**已有**的 run 前缀（用于幂等）。 */
const LEVEL_TAG_RE = /^\[(PASS|WARN|FAIL|INFO)\]( \[run [0-9a-z]{1,8}\])?/;

/**
 * 在级别标签**之后**插 `[run <8 位>]`。renderer 按 `startsWith('[PASS]' …)` 着色，
 * 故前缀必须落在级别标签之后；无级别标签的行原样返回（不硬加）。
 */
export function tagWithRun(line: string, runId?: string | null): string {
  const text = String(line ?? '');
  const short = shortRunId(runId);
  if (!short) return text;
  const m = LEVEL_TAG_RE.exec(text);
  if (!m) return text;
  if (m[2]) return text;
  return `${m[0]} [run ${short}]${text.slice(m[0].length)}`;
}

/**
 * 合并 `finalize_checks`：旧条目**原样保留**；新条目加 run 前缀；相邻同文去重（同一次收口重复推同一条时）。
 * 返回新数组，不改入参。
 */
export function mergeFinalizeChecks(prev: unknown, fresh: readonly string[], runId?: string | null): string[] {
  const out = Array.isArray(prev) ? prev.map((x) => String(x ?? '')).filter((x) => x.length > 0) : [];
  for (const raw of fresh ?? []) {
    const line = String(raw ?? '').trim();
    if (!line) continue;
    const tagged = tagWithRun(line, runId);
    if (out.length > 0 && out[out.length - 1] === tagged) continue;
    out.push(tagged);
  }
  return out;
}

/** run 幂等账本（挂在 `AgentContext` 上，每 run 新建）。 */
export interface CompletedEmitContext {
  runId?: string;
  completedRuns?: string[];
}

/**
 * `claimCompletedEmit` 的**只读**判定（zx_20261119_1 M1「迹」）：把"为什么没发"变成可记的账。
 *
 * 不加这一步时，`claimCompletedEmit` 返回 `false` 的分支是**静默**的——真库标本 `91dfe739`
 * 完成态无 `task.completed`，而账上既无持久化错误、也无任何一行说明，无从判断"是没调"还是"被判已发过"。
 * 纯函数、零 IO：`claimCompletedEmit` 改为复用它，行为逐字不变。
 */
export interface CompletedEmitDecision {
  /** 本次 run 身份；空串表示 ctx 上没有 run 身份（旧行为：一律放行） */
  id: string;
  /** 本 run 之前已记过的 run 身份（最多 10 条） */
  seen: string[];
  /** 是否放行本次发射 */
  allow: boolean;
}

export function completedEmitDecision(ctx: CompletedEmitContext, runId?: string | null): CompletedEmitDecision {
  const id = String(runId ?? ctx.runId ?? '').trim();
  const seen = Array.isArray(ctx.completedRuns) ? ctx.completedRuns : [];
  if (!id) return { id: '', seen, allow: true };
  return { id, seen, allow: !seen.includes(id) };
}

/**
 * 同一 `run_id` 只放行一次 `task.completed`。返回值 `false` 表示**本 run 已发过**，调用方应跳过。
 * ctx 上没有 run 身份时返回 `true`（保持旧行为——不因未接线而吞事件）。
 */
export function claimCompletedEmit(ctx: CompletedEmitContext, runId?: string | null): boolean {
  const decision = completedEmitDecision(ctx, runId);
  if (!decision.allow) return false;
  if (!decision.id) return true;
  ctx.completedRuns = [...decision.seen, decision.id].slice(-10);
  return true;
}
