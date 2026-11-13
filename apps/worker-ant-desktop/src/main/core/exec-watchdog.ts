/**
 * zx_20261110_2 B1「恒」——执行体**无进展看门狗**：零依赖纯状态机（`now()` 由调用方注入）。
 *
 * ## 病根（真标本：任务 339ef167，2026-11-10）
 *
 * 整轮只有一条 600s **绝对**超时（`agent-executor.ts` 的 `setTimeout(() => controller.abort(...))`）。
 * 那一次的链条是：模型调用 hang → 600s 到点 abort 发出 → `streamText` **不兑现** →
 * 执行体永不返回 → 调度器 `inflight` 键永不释放 → 同任务后续三条恢复作业全被静默跳过
 * ⇒ 用户按「暂停/恢复」都不发生任何事，界面仍显示"在跑"，冻结 **73 分钟**直到进程重启。
 *
 * 两处缺口：
 *   ① **"多久没动静"根本不是判据**——绝对时长量不出"还在动"与"已经死了"的区别；
 *   ② **abort 发出 ≠ abort 被看到**——`controller.abort()` 只是喊了一声，没有任何账记"没人理这声喊"。
 *
 * ## 本模块的两条判据（都只看状态，不碰 IO）
 *
 *   · `idleMs = now - max(lastActivityAt, lastStepAt)`，超过 `idleMs` 阈值 ⇒ `abort`
 *     （"还在动"由每步 / 每工具开始与结束的 `touchActivity` 兑现——长工具 60s 不会被 180s 阈值误杀）；
 *   · `abort` 发出后 `orphanMs` 内**仍未观测到**（`noteAbortObserved` 没被调过）⇒ `orphan`
 *     （"喊了没人应"必须能被判出来，否则调度侧永远不知道该释放哪把钥匙）。
 *
 * 纯函数 + 注入时钟 ⇒ rr 可用假时钟直跑，不依赖真实墙钟（承 auto-memory
 * `feedback_criteria_must_not_depend_on_wallclock`）。
 */

/** 看门狗裁决。`orphan` 不改进程、不杀句柄——只让上层**注销**该 run 的登记，交给调度对账释放键。 */
export type WatchdogAction = 'none' | 'abort' | 'orphan';

export interface WatchdogConfig {
  /** 无进展多久判失联（缺省 180s）。 */
  idleMs: number;
  /** abort 发出后多久没被观测到就判孤儿（缺省 30s）。 */
  orphanMs: number;
  /** `setInterval` 取 verdict 的周期（缺省 15s）。 */
  pollMs: number;
}

export const DEFAULT_WATCHDOG: WatchdogConfig = { idleMs: 180_000, orphanMs: 30_000, pollMs: 15_000 };

export interface WatchdogState {
  /** run 起跑时刻。 */
  startedAt: number;
  /** 最近一次"有动静"（步完成 / 工具开始 / 工具结束）。 */
  lastActivityAt: number;
  /** 最近一次**步**完成时刻（null＝还没走完一步）。 */
  lastStepAt: number | null;
  /** 最近一次 abort 发出时刻（null＝没发过）。 */
  lastAbortAt: number | null;
  /** abort 被观测到（执行体 `finally` 走到）的时刻。 */
  abortObservedAt: number | null;
  /** 判为孤儿的时刻。 */
  orphanedAt: number | null;
  /** abort **发出**次数（"发了"与"真停了"分开记账，发几次就记几次）。 */
  abortsSent: number;
}

export interface WatchdogVerdict {
  action: WatchdogAction;
  /** 稳定可读因由（进事件 payload / 日志）；`none` 时为空串。 */
  reason: string;
  idleMs: number;
}

export function createWatchdogState(now: number): WatchdogState {
  return {
    startedAt: now,
    lastActivityAt: now,
    lastStepAt: null,
    lastAbortAt: null,
    abortObservedAt: null,
    orphanedAt: null,
    abortsSent: 0,
  };
}

/** 记一次"有动静"。返回是否真的推进了（便于断言"touch 生效"）。 */
export function touchActivity(s: WatchdogState, now: number): boolean {
  if (!Number.isFinite(now)) return false;
  if (now <= s.lastActivityAt) return false;
  s.lastActivityAt = now;
  return true;
}

/** 记一步完成（同时推进活动时刻与步时刻）。 */
export function touchStep(s: WatchdogState, now: number): void {
  touchActivity(s, now);
  s.lastStepAt = now;
}

/** abort 发出：记账（幂等推进：同一时刻重复调用只算一次）。 */
export function noteAbortSent(s: WatchdogState, now: number): void {
  s.lastAbortAt = now;
  s.abortsSent += 1;
}

/** abort 被观测到（执行体收尾走到）。**只认第一次**——后续不再改写。 */
export function noteAbortObserved(s: WatchdogState, now: number): void {
  if (s.abortObservedAt === null) s.abortObservedAt = now;
}

/** 判为孤儿（注销句柄的凭据）。 */
export function noteOrphaned(s: WatchdogState, now: number): void {
  if (s.orphanedAt === null) s.orphanedAt = now;
}

/**
 * 取裁决（纯函数）。
 *
 * 次序即语义：
 *   1. 已观测到 abort 收尾 ⇒ `none`（喊了、也应了，事已了）；
 *   2. 已判孤儿 ⇒ `none`（不重复记账）；
 *   3. 发过 abort 但没观测到：满 `orphanMs` ⇒ `orphan`，否则 `none`（**给执行体收尾的窗口**，
 *      这段时间内既不再 abort 一次、也不判死——避免"喊话连发"淹没真因）；
 *   4. 否则看 `idleMs` 是否到阈值 ⇒ `abort` / `none`。
 */
export function watchdogVerdict(
  s: WatchdogState,
  now: number,
  cfg: WatchdogConfig = DEFAULT_WATCHDOG,
): WatchdogVerdict {
  const last = Math.max(s.lastActivityAt, s.lastStepAt ?? 0);
  const idleMs = Math.max(0, now - last);
  if (s.abortObservedAt !== null) return { action: 'none', reason: '', idleMs };
  if (s.orphanedAt !== null) return { action: 'none', reason: '', idleMs };
  if (s.lastAbortAt !== null) {
    if (now - s.lastAbortAt >= cfg.orphanMs) {
      return { action: 'orphan', reason: 'abort_not_observed', idleMs };
    }
    return { action: 'none', reason: '', idleMs };
  }
  if (idleMs >= cfg.idleMs) return { action: 'abort', reason: 'watchdog_idle_timeout', idleMs };
  return { action: 'none', reason: '', idleMs };
}

/**
 * 运行模式：`enforce`（缺省）真 abort；`log` 只记录不 abort（影子跑一轮用）。
 * 环境变量 `WATCHDOG_MODE=log` 可降级——**降级不改判定，只改动作**（判出来的照样记账）。
 */
export function watchdogMode(env: NodeJS.ProcessEnv = process.env): 'log' | 'enforce' {
  return String(env.WATCHDOG_MODE ?? '').trim().toLowerCase() === 'log' ? 'log' : 'enforce';
}

/** 阈值（可被环境变量覆盖，值为秒；非法/非正一律回落缺省，不猜）。 */
export function watchdogConfig(env: NodeJS.ProcessEnv = process.env): WatchdogConfig {
  const sec = (k: string, def: number): number => {
    const n = Number(String(env[k] ?? '').trim());
    return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : def;
  };
  return {
    idleMs: sec('WATCHDOG_IDLE_SEC', DEFAULT_WATCHDOG.idleMs),
    orphanMs: sec('WATCHDOG_ORPHAN_SEC', DEFAULT_WATCHDOG.orphanMs),
    pollMs: sec('WATCHDOG_POLL_SEC', DEFAULT_WATCHDOG.pollMs),
  };
}
