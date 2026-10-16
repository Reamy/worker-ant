/**
 * 通知文案的一处真源（zx_20260915 P0-4：**IM 通知与任务状态同源**）。
 *
 * 病根：同一件事（任务到头了）全仓**十处**各写一版文案——`jobs/ai-task.ts` 六处、
 * `core/im/im-notify.ts` 一处、`core/notification-service.ts` 三处——**没有一处从
 * `wa_tasks.status` 取真值**。于是"通知说失败、DB 里从头到尾没有 failed"成为可能：
 * 实测 `f07ad74a` 08:19:00 IM 报「执行失败: FOREIGN KEY constraint failed」，
 * 而该任务的 `status_changed` 序列为
 * `executing → paused → pending → executing`——**从头到尾没有 failed**（§3.1 病根 C）。
 *
 * 治法不是"把十处文案改成同一句"，而是**结构上让调用方无法谎报**：
 * 状态词（"已完成"/"失败"/"已暂停"…）一律由本函数**现查 DB**得出，
 * **函数签名里不提供"状态"参数**，`kind` 只决定句子的**框架**与附带什么（详情/暂停因）。
 * 于是"调用方说 completed、账上是 failed"时，输出**仍说失败**——这正是 §4.3 的可判定证据。
 *
 * 回退开关 `im.notice_single_source`（关 ⇒ 状态词改由 `kind` 出，即旧的"调用方自述"语义；
 * **不复活任何手写字面量**，调用点计数恒为 10）。
 *
 * zx_20260915 M4 增第 5 个 kind `'goal_deviation'`：它是**唯一**绕过状态词的 kind
 * （偏离不是状态事态——事件发生在任务仍在 executing 之时，说"待复核/可恢复"即是谎报），
 * 故其句子只陈述"偏离了什么"与"去哪看"，不给恢复引导、不出现任何状态词。
 */

import { boolSetting } from './settings-bool.js';
import { buildPauseNotice, recordedPauseReason } from './pause-reason.js';
import { parseDepIds } from './dep-graph.js';
import { MAX_CHILD_BREADTH, countActiveChildren } from './task-accounting.js';

/**
 * 最小库接口（同 settings-bool 范式：可脱 better-sqlite3 跑真实现）。
 *
 * zx_20260917 M2：从「只需 get」放宽为与 `task-accounting.AccountingStmt` **同形**——
 * 本模块要用 `countActiveChildren`（槽位尺）与 `.all()`（下游扫描）算暂停拦住谁。
 * 同形而非另写一套签名：`AccountingDb` 能**直接**传进来，不必 `as` 断言
 * （断言一写，"接口对不对"就没人审了）。
 */
export interface TaskNoticeDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): { changes?: number };
  };
}

export type TaskNoticeKind = 'completed' | 'failed' | 'paused' | 'awaiting_input' | 'goal_deviation';
export type TaskNoticeLevel = 'ok' | 'fail' | 'warn';

export interface TaskNotice {
  /** 语气档位——**由 DB 状态派生**（开关关时由 `kind` 派生） */
  level: TaskNoticeLevel;
  /** 原生通知标题 */
  title: string;
  /** 原生通知正文 */
  body: string;
  /** IM 推送单串（`sendImNotification` 收一个 message，三处调用方各拼一次即又一处分家） */
  message: string;
  /** 本函数实际据以出词的状态词来源，供 rr 断言"词确由 DB 出"（不在契约面上） */
  status: string | null;
}

/** `wa_tasks.status` → 人话状态词。**词表只此一份**（GUI/IM/会话行皆从此取） */
const STATUS_WORD: Record<string, string> = {
  completed: '已完成',
  failed: '失败',
  paused: '已暂停',
  archived: '已归档',
  pending: '待执行',
  preparing: '准备中',
  executing: '执行中',
  running: '执行中',
};

/** 状态 → 语气档。失败显式归 `fail`，其余未完成态归 `warn`（"需要人看一眼"） */
const STATUS_LEVEL: Record<string, TaskNoticeLevel> = {
  completed: 'ok',
  failed: 'fail',
};

/** 开关关时的旧语义：档位/词取自调用方自述的 `kind` */
const KIND_WORD: Record<TaskNoticeKind, string> = {
  completed: '已完成',
  failed: '失败',
  paused: '已暂停',
  awaiting_input: '已暂停',
  // zx_20260915 M4：`goal_deviation` **走不到这里**（见 buildTaskNotice 的提前返回——它不声明状态）。
  // 补位只为让 Record 完备；若哪天真被取到，'warn' + 「偏离目标」也是不计入状态词的口径。
  goal_deviation: '偏离目标',
};

const KIND_LEVEL: Record<TaskNoticeKind, TaskNoticeLevel> = {
  completed: 'ok',
  failed: 'fail',
  paused: 'warn',
  awaiting_input: 'warn',
  goal_deviation: 'warn',
};

const ICON: Record<TaskNoticeLevel, string> = { ok: '✅', fail: '❌', warn: '⚠️' };

/**
 * 本次暂停**拦住了几个下游**——非终态、且 `depends_on` 指向本任务者（zx_20260917 M2 ②）。
 *
 * 「不讲这一句，读者无从判断值不值得现在管」：暂停告知只说自己停了，用户就不知道这条要不要紧。
 *
 * `depends_on` 是逗号连接的 id 串，SQL 侧只能做**超集**粗筛（`LIKE '%'||?||'%'` 会把子串也捞进来，
 * 如 `abc` 命中 `abcd`），真判据在 JS 侧用 `dep-graph` 的 `parseDepIds` 精确切分——与调度器
 * （`classifyDep`）**同一把尺**，不在此另写一套分隔/去重规则。非终态的定义也与槽位尺一致
 * （`completed`/`failed`/`archived` 不算数），两个"还有几个活着的"不是两把尺。
 *
 * 读不到（老库无 `depends_on` 列等）按 0——**少说**胜过编一句"拦住了 N 个"。
 */
function countBlockedDownstream(db: TaskNoticeDb, taskId: string): number {
  if (!taskId) return 0;
  try {
    const rows = db.prepare(
      "SELECT depends_on FROM wa_tasks WHERE depends_on LIKE '%' || ? || '%' AND status NOT IN ('completed','failed','archived')",
    ).all(taskId) as Array<{ depends_on?: string | null }>;
    return rows.filter((r) => parseDepIds(r?.depends_on).includes(taskId)).length;
  } catch {
    return 0;
  }
}

/**
 * 本任务是否**占着父任务的槽位且父已满**——父因此建不出后续子任务（zx_20260917 M2 ②）。
 *
 * 用 `task-accounting` 的在途槽位尺（`countActiveChildren` + `MAX_CHILD_BREADTH`），
 * 与 `create_task` 那道闸**同一个数**：那边拒建的条件正是 `active >= MAX_CHILD_BREADTH`，
 * 故此处同式判"满"——两处各写一遍就该漂了。
 *
 * 本任务此刻是 `paused`（非终态）⇒ 必然计入 `active`，即"父满"里确实有它一份。
 * 未满/无父/读不到一律 null（整句不出现，不写"槽位 1/5"这种没人要的信息）。
 */
function parentSlotSaturation(db: TaskNoticeDb, parentId: string | null): { active: number; max: number } | null {
  if (!parentId) return null;
  try {
    const active = countActiveChildren(db, parentId);
    return active >= MAX_CHILD_BREADTH ? { active, max: MAX_CHILD_BREADTH } : null;
  } catch {
    return null;
  }
}

/** 状态词：未知状态**原文回显**（不吞、不编；`status` 读不出时退回 `kind` 自述） */
function statusWordOf(status: string | null, kind: TaskNoticeKind, singleSource: boolean): string {
  if (!singleSource) return KIND_WORD[kind];
  if (!status) return KIND_WORD[kind];
  return STATUS_WORD[status] || status;
}

/**
 * `wa_tasks.status` → 人话状态词的**唯一读口**（zx_20260920_1 M6 开：IM 的「查看系统状态」
 * 要报任务状态，**不许在 `im-router.ts` 再抄一份词表**——那正是"同一件事两处各写一遍"的病）。
 *
 * 与 `statusWordOf` 的分工：那一个还带"回退开关关时按 `kind` 自述"的旧语义（通知专用），
 * 这一个只问词表本身。未知状态**原文回显**（不回退、不编造）。
 *
 * ⚠ 上面 `STATUS_WORD` 的注释声称「GUI/IM/会话行皆从此取」，**该半句今日不成立**：
 *   renderer 侧另有 `TasksPage.tsx` / `TaskDetailPage.tsx` / `CommandPalette.tsx` 三份手抄
 *   （renderer 不在 `src/main` 扫描面内，也用不了 main 的真源）。已登记方案 §五挂账，本轮不动。
 */
export function taskStatusWord(status: string): string {
  return STATUS_WORD[status] || status;
}

/**
 * 通知文案的**唯一**构造处。
 *
 * - `db` 现查 `wa_tasks`（状态 + 标题）与 `context_json.pause_reason`，**不信任调用方的转述**；
 * - `kind` 只决定句子框架与该带什么附带信息；
 * - `extra.detail`：完成时是成果摘要、失败时是错误原因、暂停时是补充说明（可选）。
 */
export function buildTaskNotice(
  db: TaskNoticeDb,
  taskId: string,
  kind: TaskNoticeKind,
  extra?: { detail?: string },
): TaskNotice {
  const singleSource = boolSetting(
    (() => {
      try {
        const r = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get('im.notice_single_source') as { value?: string } | undefined;
        return r?.value;
      } catch {
        return undefined; // 读不到按"缺省即开"，与 boolSetting 语义同向
      }
    })(),
  );

  let status: string | null = null;
  let name = `任务 ${taskId.slice(0, 8)}`;
  let pauseReason = '';
  let parentId: string | null = null;
  try {
    const row = db.prepare('SELECT title, status, context_json, parent_task_id FROM wa_tasks WHERE id = ?').get(taskId) as
      | { title?: string | null; status?: string | null; context_json?: string | null; parent_task_id?: string | null }
      | undefined;
    if (row?.title) name = row.title;
    status = row?.status ?? null;
    parentId = row?.parent_task_id || null;
    // 暂停因只在**账上确是 paused** 时取——否则是拿一条不相干的缘由给别的状态作注。
    // 解析走 `pause-reason` 的共用读点（M3 已把"读出因由原文"收成一处），不在此另写一遍 JSON.parse。
    if (status === 'paused') pauseReason = recordedPauseReason(row?.context_json);
  } catch {
    /* 读不出则如实退回占位名 + `kind` 自述（不编状态） */
  }

  // zx_20260915 M4：`goal_deviation` **绕过状态词**——偏离不是状态事态。
  // 该事件发生在任务**仍在 executing** 之时（abort 之后才转 paused/failed），若走上面的状态词，
  // 会得到「任务执行中，待复核：可在桌面处理/恢复」——给一个没停的任务发恢复指引。
  // 故此处不声明状态、不给恢复引导，只说"偏离了什么"与"下一步去哪看"。
  if (kind === 'goal_deviation') {
    const why = (extra?.detail || '').trim();
    const body = `任务「${name}」偏离核心目标${why ? `：${why}` : ''}。请在详情页查看并回正。`;
    return { level: 'warn', title: `任务偏离目标：${name}`, body, message: `${ICON.warn} ${body}`, status };
  }

  const level: TaskNoticeLevel = singleSource ? STATUS_LEVEL[status || ''] || 'warn' : KIND_LEVEL[kind];
  const word = statusWordOf(status, kind, singleSource);
  const icon = ICON[level];
  const detail = (extra?.detail || '').trim();

  let body: string;
  let message: string;
  switch (kind) {
    case 'completed':
      body = `任务「${name}」${word}。${detail ? `\n${detail}` : ''}`;
      message = `${icon} ${body}`;
      break;
    case 'failed':
      body = `任务「${name}」${word}${detail ? `：${detail}` : '，请查看详情处理。'}`;
      message = `${icon} ${body}`;
      break;
    case 'paused': {
      // 正文构造**抽出**到 `pause-reason.buildPauseNotice`（词表所在、零 import，故受控回归能直调真实现）。
      // 因由与补充说明**并列**而非二选一；拦住了谁、占没占满父的槽位一并说——三件事缺一件这通知就白发了。
      body = buildPauseNotice({
        name,
        word,
        pauseReason,
        note: detail,
        blockedDownstream: countBlockedDownstream(db, taskId),
        parentSlots: parentSlotSaturation(db, parentId),
      });
      message = `${icon} ${body}`;
      break;
    }
    case 'awaiting_input':
      body = `任务「${name}」${word}，等待你回复/决策。${detail ? `\n${detail}` : ''}`;
      message = `${icon} ${body}`;
      break;
  }

  return { level, title: `任务${word}：${name}`, body, message, status };
}
