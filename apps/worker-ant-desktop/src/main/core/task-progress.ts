/**
 * zx_20261110_2 B7「见」——任务**最后进展**与"已卡多久"（派生量，不落库）。
 *
 * 病根（与 `exec-state.ts` 同一事故）：界面只能看到"状态词"与"已跑时长"，看不到"上一次有动静是什么时候"。
 * 任务在 13:48 之后再没写过一个字，界面却仍在动——用户无从判断"慢"与"死"。
 *
 * 本模块只做两件事：
 *   ① **最后进展时刻** = 三本账里的最大值 —— 事件账（`wa_event_log.occurred_at`）、
 *      对话账（`wa_task_conversations.created_at`）、作业账（`wa_jobs.started_at`）。
 *      任一有更新，就说明引擎还在做事（哪怕只是换了个状态）。
 *   ② **已卡时长** = `now - 最后进展`，**只在** `live`/`ghost` 两态下有意义：
 *      `queued` 是"还没轮到"、`idle` 是"本来就闲着"、`terminal` 是"已了结"——那三态算"卡"是诬告。
 *
 * 取数与判据分开：`latestProgressMs` / `stuckMsOf` 零 IO（rr 用假时钟直跑），`readProgressAt` 只取数。
 */
import type { ExecState } from './exec-state.js';

/** 仅需 `prepare().get()` 的最小库接口（可脱 electron）。 */
export interface ProgressDb {
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

/** 库内时刻 → epoch ms；形状不认 ⇒ null（不猜）。UTC 秒级与 ISO 两种写法都认。 */
export function utcMsOf(v: unknown): number | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const iso = /T|Z$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export interface ProgressSources {
  /** 最后一条事件的时间（`wa_event_log.occurred_at`） */
  eventAt: unknown;
  /** 最后一条对话的时间（`wa_task_conversations.created_at`） */
  conversationAt: unknown;
  /** 最后一条执行作业的起跑时间（`wa_jobs.started_at`） */
  jobStartedAt: unknown;
}

/** 三本账取最大；一本都读不到 ⇒ `null`（"不知道"不等于"很久没动"）。 */
export function latestProgressMs(s: ProgressSources): number | null {
  const vals = [utcMsOf(s.eventAt), utcMsOf(s.conversationAt), utcMsOf(s.jobStartedAt)]
    .filter((v): v is number => v !== null);
  return vals.length === 0 ? null : Math.max(...vals);
}

/** 已卡时长：仅 `live`/`ghost` 且有进展时刻时给出；其余态 `null`（不拿"闲着"当"卡住"）。 */
export function stuckMsOf(state: ExecState | string, lastProgressMs: number | null, nowMs: number): number | null {
  if (lastProgressMs === null) return null;
  if (state !== 'live' && state !== 'ghost') return null;
  return Math.max(0, nowMs - lastProgressMs);
}

export interface ProgressSnapshot {
  /** 最后进展时刻（ISO 字符串，供 IPC 原样过界；无记录 ⇒ null） */
  lastProgressAt: string | null;
  /** 距今毫秒（仅 live/ghost 有值） */
  stuckMs: number | null;
  /** 该任务最老一条 **pending** 执行作业的年龄（ms）；无 pending ⇒ null */
  pendingJobAgeMs: number | null;
}

/**
 * 读三本账 + 待跑作业年龄。缺表/坏库**一律空账不阻断**——派生量本就一秒一变，
 * 不值得为它把任务详情页整页打红（与 `readExecState` 同一纪律）。
 */
export function readProgressAt(
  db: ProgressDb,
  taskId: string,
  opts: { state: ExecState | string; nowMs?: number; pendingJobAgeMs?: number | null },
): ProgressSnapshot {
  const nowMs = opts.nowMs ?? Date.now();
  let eventAt: unknown = null;
  let conversationAt: unknown = null;
  let jobStartedAt: unknown = null;
  try {
    eventAt = (db.prepare('SELECT MAX(occurred_at) AS t FROM wa_event_log WHERE aggregate_id = ?').get(taskId) as { t?: unknown } | undefined)?.t ?? null;
  } catch { /* 缺表 ⇒ 空账 */ }
  try {
    conversationAt = (db.prepare('SELECT MAX(created_at) AS t FROM wa_task_conversations WHERE task_id = ?').get(taskId) as { t?: unknown } | undefined)?.t ?? null;
  } catch { /* 缺表 ⇒ 空账 */ }
  try {
    jobStartedAt = (db.prepare(
      "SELECT MAX(started_at) AS t FROM wa_jobs WHERE status = 'running' AND type IN ('ai-task','resume-ai-task') AND payload LIKE ?",
    ).get(`%"taskId":"${taskId}"%`) as { t?: unknown } | undefined)?.t ?? null;
  } catch { /* 缺表 ⇒ 空账 */ }

  const lastMs = latestProgressMs({ eventAt, conversationAt, jobStartedAt });
  return {
    lastProgressAt: lastMs === null ? null : new Date(lastMs).toISOString(),
    stuckMs: stuckMsOf(opts.state, lastMs, nowMs),
    pendingJobAgeMs: typeof opts.pendingJobAgeMs === 'number' ? opts.pendingJobAgeMs : null,
  };
}
