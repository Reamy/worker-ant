/**
 * zx_20261110_2 B7「见」——任务详情页的**执行态徽标**与"最后进展 / 已卡多久"的展示换算。
 *
 * 词表的**第二落点**（第一落点是 main 的 `core/exec-state.ts`）：这里只做展示换算与文案，
 * 不另判一次"跑没跑"——`state` 一律由 main 派生后回传（`task:get.execState`），页面只照着画。
 * 状态名从 main 的零依赖纯模块**取类型**，改名即编译不过，不给"两处各写一套"留缝。
 *
 * 四态（`terminal`/`idle` 不画徽标）：
 *   · live   —— 真有执行体在跑（**压过状态词**）；
 *   · queued —— 没在跑，但有未超龄的执行作业在排队；
 *   · ghost  —— 状态词写着在跑、实则既无 run 也无作业（事故 `339ef167` 的形态，**必须给出口**）；
 *   · idle   —— 其余非终态（本来就闲着，不是故障）。
 */
import type { ExecState } from '../../../src/main/core/exec-state.js';
import { parseDbTime } from '../../../../../packages/shared-types/src/db-time.js';

/** 徽标文案（`terminal` 不出徽标，`idle` 也不出——"闲着"不是需要一眼看见的事）。 */
export const EXEC_STATE_LABEL: Record<ExecState, string> = {
  live: '运行中（真实执行体）',
  queued: '已排队',
  ghost: '幽灵：无执行体在跑',
  idle: '空闲',
  terminal: '已结束',
};

/** 徽标色调（Tailwind 片段；与仓库其它徽标同风格——浅底 + 深字 + 细边）。 */
export const EXEC_STATE_TONE: Record<ExecState, string> = {
  live: 'bg-green-50 text-green-700 border-green-200',
  queued: 'bg-blue-50 text-blue-700 border-blue-200',
  ghost: 'bg-red-50 text-red-700 border-red-200',
  idle: 'bg-gray-50 text-gray-600 border-gray-200',
  terminal: 'bg-gray-50 text-gray-500 border-gray-200',
};

/** 哪些态值得在标题旁显示（`idle`/`terminal` 不出徽标，避免每页都挂一个灰章）。 */
export function execBadgeVisible(state: string | null | undefined): state is ExecState {
  return state === 'live' || state === 'queued' || state === 'ghost';
}

/**
 * 徽标要画的两样东西（文案 + 色调）。`null` = 这个态不出徽标。
 * 页面只用这个函数取词表——不在 JSX 里再 `as` 一次，改名/改态集只改上面一处。
 */
export function execBadge(state: string | null | undefined): { label: string; tone: string } | null {
  return execBadgeVisible(state) ? { label: EXEC_STATE_LABEL[state], tone: EXEC_STATE_TONE[state] } : null;
}

/** 时刻距现在多少毫秒；无/坏时刻 ⇒ `null`（不冒充"刚刚"）。
 *  zx_20261111_3「显」：导出给任务详情第一行用（同一把换算尺，不另写距离计算）。 */
export function ageMsOf(at: string | null | undefined, nowMs: number): number | null {
  const d = parseDbTime(at ?? null);
  return d ? Math.max(0, nowMs - d.getTime()) : null;
}

/** 毫秒 → 人话时长（"已卡 2 小时 5 分钟"用）。负数/非数 ⇒ `''`（不编一个 0）。
 *  zx_20261111_3「显」：实现上收 main `core/duration-text.ts`——页面第一行与执行态徽标共用同一把尺。
 *  本文件只**转出**，不再自带第二份换算。 */
import { durationText } from '../../../src/main/core/duration-text.js';
export { durationText };

/** 时刻 → "多久前"。无时刻如实 `—`（"没有这个时刻"不说成"刚刚"）。 */
export function progressAgoText(at: string | null | undefined, nowMs: number): string {
  const age = ageMsOf(at, nowMs);
  if (age === null) return '—';
  return durationText(age) + '前';
}

/**
 * 一行话的展示事实（页面只拼一遍，不在 JSX 里各写各的）：
 *   · live  —— "运行中 · 最后进展 12 秒前"；
 *   · queued—— "已排队 · 最老作业等了 3 分钟"（`pendingJobAgeMs`）；
 *   · ghost —— "状态写着在跑，实则无执行体 · 已卡 55 分钟"。
 */
export function execStateLine(input: {
  state: string | null | undefined;
  lastProgressAt?: string | null;
  stuckMs?: number | null;
  pendingJobAgeMs?: number | null;
  nowMs: number;
}): string {
  const state = input.state;
  if (state === 'live') {
    const ago = input.lastProgressAt ? progressAgoText(input.lastProgressAt, input.nowMs) : '';
    return ago ? `运行中 · 最后进展 ${ago}` : '运行中';
  }
  if (state === 'queued') {
    const wait = durationText(input.pendingJobAgeMs);
    return wait ? `已排队 · 最老作业等了 ${wait}` : '已排队';
  }
  if (state === 'ghost') {
    // 优先按 `lastProgressAt + 当前时钟` 现算（页面每秒重渲染，卡住时长随之走）；
    //   没有进展时刻才退回 main 派生时给的 `stuckMs`（那是取数那一刻的快照）。
    const stuck = durationText(ageMsOf(input.lastProgressAt, input.nowMs) ?? input.stuckMs);
    return stuck
      ? `状态写着在跑，实则无执行体 · 已卡 ${stuck}`
      : '状态写着在跑，实则无执行体';
  }
  return '';
}
