/**
 * zx_20261112_1 B3「答」: IM 里「暂停/继续 + 任务名」的**目标解析与澄清**。
 *
 * 病根：IM 只有「开始」一条任务级入口，暂停/继续全靠回电脑前点 GUI；且"开始+任务名"
 *   走的是关键词命中——多候选时只列暂停列表、0 命中时回兜底，**答不出"你说的是哪个"**。
 *
 * 纪律：
 *   ① 状态合法性只在此处判一次（`pauseRefusal`/`resumeRefusal`），路由不写第二套；
 *   ② 候选澄清 = 5 分钟时效的编号选择（与项目候选同族，但键与 TTL 各自独立）；
 *   ③ 读不到就如实说"没找到"，不猜、不拿最大项目顶替。
 *
 * ⚠ 纯 Node 依赖（无 electron）；rr 用 `node:sqlite` 内存库直跑真实现。
 */
import type Database from 'better-sqlite3';
import { isTerminalStatus } from './status-terms.js';
import { taskStatusWord } from './task-notice.js';

export type TaskAction = 'pause' | 'resume';

export interface ActiveTaskRow {
  id: string;
  title: string;
  status: string;
}

/** 候选澄清的时效：与项目候选同为 5 分钟（"马上挑一个"，不是"想清楚再答"）。 */
export const DISAMBIGUATION_TTL_MS = 5 * 60_000;

export interface PendingTaskDisambiguation {
  action: TaskAction;
  /** 本轮问过用户的那几条候选，按展示顺序（编号 = 下标 + 1）。 */
  ids: string[];
  expiresAt: number;
}

export function buildDisambiguation(action: TaskAction, ids: string[], now = Date.now()): PendingTaskDisambiguation {
  return { action, ids: [...ids], expiresAt: now + DISAMBIGUATION_TTL_MS };
}

export function isDisambiguationExpired(p: PendingTaskDisambiguation, now = Date.now()): boolean {
  return p.expiresAt <= now;
}

/** 纯数字回复 → 候选 id；越界/非纯数字 → `null`（调用方交回主流程，不静默吞）。 */
export function pickDisambiguation(p: PendingTaskDisambiguation, msgText: string): string | null {
  const raw = String(msgText ?? '').trim();
  if (!/^\d{1,2}$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > p.ids.length) return null;
  return p.ids[n - 1] ?? null;
}

/* ── 状态合法性（唯一判据） ─────────────────────────────────────────────── */

export function pauseRefusal(status: string): string | null {
  if (status === 'paused') return '任务已经在暂停中，无需再暂停。';
  if (status === 'archived') return '任务已归档，无需暂停。';
  if (status === 'completed') return '任务已完成，无需暂停。';
  if (status === 'failed') return '任务已经结束（失败），无需暂停。';
  return null;
}

export function resumeRefusal(status: string): string | null {
  if (status === 'paused' || status === 'failed') return null;
  if (status === 'archived') return '任务已归档，不能再继续。';
  if (status === 'completed') return '任务已完成，无需继续。';
  if (status === 'pending') return '任务已在队列里等待执行，无需继续。';
  return '任务正在执行，无需继续。';
}

/* ── 目标解析 ───────────────────────────────────────────────────────────── */

const ACTIVE_LIMIT = 5;

/**
 * 当前项目（给了 projectId 就限定项目）**活跃任务**里按标题包含匹配。
 * `query` 为空 ⇒ 直接列最近 N 条活跃任务（供"先「暂停」再回复编号"）。
 * 排序：最近更新在前；同刻按 rowid 倒序（与系统状态查询同一把尺）。
 */
export function findActiveTasks(
  db: Pick<Database.Database, 'prepare'>,
  opts: { projectId?: string | null; query: string; limit?: number },
): ActiveTaskRow[] {
  const limit = Math.max(1, Math.min(opts.limit ?? ACTIVE_LIMIT, 20));
  const where: string[] = ["status NOT IN ('completed','failed','archived')"];
  const params: unknown[] = [];
  if (opts.projectId) {
    where.push('project_id = ?');
    params.push(opts.projectId);
  }
  const q = String(opts.query ?? '').trim();
  if (q) {
    where.push("instr(lower(title), lower(?)) > 0");
    params.push(q);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT id, title, status FROM wa_tasks
        WHERE ${where.join(' AND ')}
        ORDER BY datetime(updated_at) DESC, rowid DESC
        LIMIT ?`,
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ id: String(r.id ?? ''), title: String(r.title ?? ''), status: String(r.status ?? '') }));
}

export function getTaskRow(
  db: Pick<Database.Database, 'prepare'>,
  taskId: string,
): ActiveTaskRow | null {
  const row = db.prepare('SELECT id, title, status FROM wa_tasks WHERE id = ?').get(taskId) as
    | Record<string, unknown>
    | undefined;
  return row ? { id: String(row.id ?? ''), title: String(row.title ?? ''), status: String(row.status ?? '') } : null;
}

/* ── 文案（用户看得懂"为什么不能/该选哪个"） ───────────────────────────── */

function candidateLines(rows: readonly ActiveTaskRow[]): string[] {
  return rows.map((r, i) => `${i + 1}. 「${r.title.slice(0, 40)}」 [${taskStatusWord(r.status)}]`);
}

export function disambiguationPrompt(action: TaskAction, rows: readonly ActiveTaskRow[]): string {
  const verb = action === 'pause' ? '暂停' : '继续';
  return [
    `找到 ${rows.length} 个匹配的任务，回复编号决定${verb}哪一个：`,
    ...candidateLines(rows),
    '（5 分钟内有效；直接发别的消息则视为新指令。）',
  ].join('\n');
}

export function noMatchText(action: TaskAction, query: string, rows: readonly ActiveTaskRow[]): string {
  const verb = action === 'pause' ? '暂停' : '继续';
  const head = query ? `没找到名字含「${query}」的活跃任务。` : `当前活跃任务如下：`;
  if (rows.length === 0) return `${head}\n现在没有可${verb}的活跃任务。`;
  return [
    head,
    ...candidateLines(rows),
    `要${verb}哪一个，请回复「${verb}+任务名」。`,
  ].join('\n');
}

export function expiredDisambiguationText(action: TaskAction): string {
  const verb = action === 'pause' ? '暂停' : '继续';
  return `上一条候选已超过 5 分钟，作废了。请重新发送「${verb}+任务名」。`;
}

export function pausedText(title: string, aborted: boolean): string {
  const head = `⏸ 已暂停任务「${title.slice(0, 40)}」`;
  return aborted ? `${head}，并已中止在途执行。` : `${head}。`;
}

export function resumedText(title: string): string {
  return `✅ 已继续任务「${title.slice(0, 40)}」。`;
}

/** 终态判定与引擎同一把尺（供路由层判断要不要进入本路）。 */
export { isTerminalStatus };
