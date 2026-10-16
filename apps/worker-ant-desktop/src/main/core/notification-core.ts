/**
 * 通知核（zx_20260915 M4/P0-6）：**零 electron** 的「落行 · 已读 · 去重 · 订阅装配」。
 *
 * 为何要把这一半从 `notification-service.ts` 里抽出来：判据必须**直跑真实现**。
 * 该服务顶部 `import { Notification, BrowserWindow, app } from 'electron'` ⇒ 受控回归
 * （tsx/node）**不能** import 它，只能"复刻一份实现"来自我印证——那正是本仓反复判为假绿的那种断言
 * （同 `task-notice.ts` / `pause-settlement.ts` 的既有处置）。
 *
 * 切分面：**读库/写库**的留在这里，**碰 electron 的**（原生横幅、Dock 角标）由装配处经
 * `setNotifPopup` / `setNotifBadge` 注入。未注入时**不弹也不设角标**——不静默吞错：
 * 回归里"没收到弹窗请求"正是缺注入的可观测信号。
 *
 * P0-6 治的病（三条，全部结构性）：
 * (a) 引擎自置的暂停（`children_incomplete`/`children_failed`/`no_output`/预算到顶）此前
 *     **结构上不可能**产生通知行——`status_changed` 处理器把非 `completed` 一律 `return` 掉；
 * (b) `status_changed{new_status:'failed'}`（`update_task_status` 工具路，实测发生的就是它）
 *     同样被丢弃（只有独立的 `task.failed` 事件才落）；
 * (c) `task.goal_deviation` **从未被订阅**，偏离提醒只进会话流，不进入用户可见面。
 * 三者的共同特征是"**事态到了、通知面没到**"，故治法在**订阅面**，不在投递（投递本就是好的）。
 *
 * ⚠ 「未绑 IM 渠道 ⇒ 无处可去」是 **IM 通路**（`im/im-notify.ts` 的 `pushImNotify`）的性质，
 * 不是本模块的性质：本模块只写 `wa_notifications`，与渠道绑定无关。这正是
 * `markPauseNeeded` 保持 IM-only、而"到得了人"由本模块承担的依据（方案 §6.3(c) 已撤销）。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createLogger } from './logger.js';
import { readBoolSetting } from './settings-bool.js';
import type { EventBus, AppEvent } from './event-bus.js';
import { buildTaskNotice, type TaskNotice, type TaskNoticeKind } from './task-notice.js';

const logger = createLogger('notification-core');

/** 回退开关（§十二 总表）：关 ⇒ `paused`/`goal_deviation` 不落通知面（逐字回到本轮前行为） */
export const PAUSE_DEVIATION_KEY = 'notification.pause_and_deviation';

/**
 * 「转回执行类状态 ⇒ 同任务旧通知随之已读」的状态集（zx_20260906_1 4b 既有裁定）。
 * 抽成具名常量：`markTaskRead` 的触发条件与被订阅的 `status_changed` 分支共用一份，不各写一版。
 */
export const EXECUTING_STATUSES: readonly string[] = ['executing', 'running', 'pending', 'preparing'];

type TaskEventData = {
  taskId?: string;
  task_id?: string;
  projectId?: string;
  title?: string;
  status?: string;
  new_status?: string;
  /** P0-3 起 `task.failed` 载荷带真实错因（旧事件无此字段 ⇒ 退回不带细节的句子） */
  error?: string;
  /** `task.goal_deviation` 载荷的偏离因由 */
  reason?: string;
};

// ───────────────────────── 装配接口（electron 侧注入） ─────────────────────────

/** 原生横幅请求。核判定"未被去重"后交给装配处；**该不该弹**（聚焦/勿扰/开关）由装配处定。 */
export interface NotifPopupRequest {
  type: string;
  title: string;
  body: string;
  taskId?: string;
  /** 仅当窗口失焦/最小化时弹（用于成功完成等不打扰场景） */
  onlyWhenAway?: boolean;
}

let _popup: ((req: NotifPopupRequest) => void) | null = null;
/** 注入原生弹窗施加器（`notification-service.ts` 传 electron 版）；传 null 卸下。 */
export function setNotifPopup(fn: ((req: NotifPopupRequest) => void) | null): void {
  _popup = fn;
}

let _badge: ((count: number) => void) | null = null;
/** 注入角标施加器（macOS Dock / Windows 任务栏）。 */
export function setNotifBadge(fn: ((count: number) => void) | null): void {
  _badge = fn;
}

// ───────────────────────── 焦点（去扰） ─────────────────────────

let currentTaskId: string | null = null;

export function setTaskFocus(taskId: string | null): void {
  currentTaskId = taskId;
}

/** 供自检/断言读取当前焦点（不在契约面上，同 `TaskNotice.status` 的处置） */
export function getTaskFocus(): string | null {
  return currentTaskId;
}

// ───────────────────────── 表 / 角标 ─────────────────────────

export function ensureNotificationsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS wa_notifications (
    id TEXT PRIMARY KEY,
    event_id TEXT,
    type TEXT NOT NULL,
    task_id TEXT,
    project_id TEXT,
    title TEXT NOT NULL,
    body TEXT,
    read_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

/** 未读数（真源）——角标只是它的显示面 */
export function countUnread(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS c FROM wa_notifications WHERE read_at IS NULL').get() as { c: number };
    return row.c;
  } catch {
    return 0;
  }
}

/** 刷新未读角标（Dock/任务栏）。写入/已读后调用。 */
export function refreshUnreadBadge(db: Database.Database): void {
  try {
    _badge?.(countUnread(db));
  } catch {
    /* 角标失败不影响通知本身 */
  }
}

// ───────────────────────── 写入 ─────────────────────────

/** 同一关键事态短时间内重复到达去重（completed 与 status_changed 双事件、failed 重发等） */
const recordDedupe = new Map<string, number>();
const DEDUPE_WINDOW_MS = 8_000;

// ─────────────────────── 暂停簇：一次停只发一条通知（zx_20260917 M2 ③） ───────────────────────

/**
 * 属于「同一次停止」的通知族。
 *
 * 病根（§1.4-Ⅱ 实测）：同一次暂停落出**三条**行——`task.paused` / `task.awaiting_input` /
 * `task.goal_deviation`，三条各自为政。上面的 `recordDedupe` **结构上拦不住**：它的键是
 * `type:taskId`，这三是**三族不同的 type**，本就不算"重复到达"。
 *
 * 更糟的是**留下的那条未必有用**（§1.4-Ⅳ 第二实证）：标题写着"已暂停"的那条正文是通用模板、
 * 一个字的原因都读不到，因由只在**另一条** `task.goal_deviation` 里。故本簇**不是**"先到先得"，
 * 而是**按说明力仲裁**——留下的必须是说明力最强的那条。
 */
const PAUSE_CLUSTER_TYPES: readonly string[] = ['task.paused', 'task.awaiting_input', 'task.goal_deviation'];

/**
 * 说明力次序（大者胜出），按"它说得出多少为什么"定：
 *   `task.paused`(3)          —— 正文＝暂停因由 ＋ 拦住了谁 ＋ 是否占满父槽位，最具体；
 *   `task.goal_deviation`(2)  —— 说得出"偏离了什么"，但**不宣称暂停**（偏离可在任务仍在跑时发生）；
 *   `task.awaiting_input`(1)  —— 只说"等你回复/决策"，最泛。
 */
const PAUSE_CLUSTER_RANK: Record<string, number> = {
  'task.paused': 3,
  'task.goal_deviation': 2,
  'task.awaiting_input': 1,
};

/**
 * 簇窗口——**取既有的去重窗口**（同一次停止的三种说法本就同秒到达，不另立第二个数）。
 * 导出供断言引用：判据须由载体自身派生，不得在回归里另抄一个字面量。
 */
export const PAUSE_CLUSTER_WINDOW_MS = DEDUPE_WINDOW_MS;

/** taskId → 该任务窗口内**已落的那条**（存行 id，供"后者更具体"时**就地升级**它） */
const pauseCluster = new Map<string, { at: number; rank: number; rowId: string }>();

type PauseClusterVerdict =
  /** 不属本簇 / 无 taskId / 上一条已过期 ⇒ 正常新落一行 */
  | { action: 'pass' }
  /** 窗口内已有**更弱**的一条 ⇒ 不新落，就地把它升级成这条 */
  | { action: 'overwrite'; rowId: string; rank: number }
  /** 窗口内已有**同等或更强**的一条 ⇒ 这条不落（事件照发，GUI 实时态靠事件） */
  | { action: 'drop' };

/**
 * 同一次停止至多留一条：返回该落 / 该升级 / 该丢。
 *
 * **升级而非"先到先得"**是本判据的要害（§4.2：「行数变 1 不算达标，留下的那条必须含因」）——
 * 若只是把后到的丢掉，去重后留下的可能恰是通用模板那条，行数达标而**病更重**。
 * 升级用 `UPDATE` 原地改那一行（而非删旧插新）：行 id 不变，读者侧不会看到"通知闪现又消失"。
 *
 * ⚠ 不假设"一定有 `task.paused` 那条来兜底"：重启型偏离发生时任务**仍在 executing**，
 * 只有偏离、没有暂停时，留下的就是偏离那条（如实说偏离，不编一个暂停）。
 */
function arbitratePauseCluster(taskId: string, type: string, now: number): PauseClusterVerdict {
  if (!taskId || !PAUSE_CLUSTER_TYPES.includes(type)) return { action: 'pass' };
  const prev = pauseCluster.get(taskId);
  if (!prev || now - prev.at >= PAUSE_CLUSTER_WINDOW_MS) return { action: 'pass' };
  const rank = PAUSE_CLUSTER_RANK[type] ?? 0;
  if (rank > prev.rank) return { action: 'overwrite', rowId: prev.rowId, rank };
  return { action: 'drop' };
}

/**
 * zx_20260915 M4/P0-6(d): 落库失败**不再无声**。
 * 此前 `catch {}` 把写入异常吞得与"被 8s 去重"完全同形（两者都 `return false`）——
 * 于是 `wa_notifications` 空表时无从判断是"没事件"还是"每次写入都炸"。
 * **只加诊断，不改返回值语义**（改它会牵动原生弹窗路径 `if (!deduped) popup(...)`；列 §十一 挂账）。
 */
let notificationWriteFailures = 0;
export function getNotificationWriteFailures(): number {
  return notificationWriteFailures;
}

/**
 * 写入一条用户可见通知并刷新未读角标。
 * 同 key（type+taskId）8 秒内重复到达自动跳过，避免双事件造成重复通知。
 *
 * `opts.now` 是**时钟注入口**（缺省 `Date.now()`）——只为让回归能构造"相隔远"这类跨窗口场景，
 * 而不必真等 8 秒（wall-clock 依赖的判据会在别的时间窗里自己变红，本仓已有教训）。
 */
export function recordNotification(
  db: Database.Database,
  f: { type: string; taskId?: string; projectId?: string; title: string; body: string },
  opts?: { now?: number },
): boolean {
  try {
    ensureNotificationsTable(db);
    const key = `${f.type}:${f.taskId ?? ''}`;
    const now = opts?.now ?? Date.now();
    const last = recordDedupe.get(key);
    if (last && now - last < DEDUPE_WINDOW_MS) return true;
    recordDedupe.set(key, now);
    if (recordDedupe.size > 300) {
      const oldest = recordDedupe.keys().next().value;
      if (oldest !== undefined) recordDedupe.delete(oldest);
    }

    // zx_20260917 M2 ③：一次停只发一条——同一次停止的三种说法按说明力仲裁，至多留一条。
    const tid = f.taskId ?? '';
    const cluster = arbitratePauseCluster(tid, f.type, now);
    if (cluster.action === 'drop') return true;
    if (cluster.action === 'overwrite') {
      // 就地升级已有那行：行 id 不变，故读者侧不会看到"通知闪现又消失"
      db.prepare('UPDATE wa_notifications SET type = ?, title = ?, body = ? WHERE id = ?')
        .run(f.type, f.title, f.body, cluster.rowId);
      pauseCluster.set(tid, { at: now, rank: cluster.rank, rowId: cluster.rowId });
      refreshUnreadBadge(db);
      return false;
    }

    // zx_20260906_1 4c: 焦点去扰——正在观看该任务时仍落中心记录但即置已读（不制造新未读/徽标+1）
    const viewing = !!f.taskId && currentTaskId === f.taskId;
    const rowId = randomUUID();
    if (viewing) {
      db.prepare(
        "INSERT INTO wa_notifications (id, type, task_id, project_id, title, body, read_at, created_at) VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))"
      ).run(rowId, f.type, f.taskId ?? null, f.projectId ?? null, f.title, f.body);
    } else {
      db.prepare(
        'INSERT INTO wa_notifications (id, type, task_id, project_id, title, body, created_at) VALUES (?,?,?,?,?,?,datetime(\'now\'))'
      ).run(rowId, f.type, f.taskId ?? null, f.projectId ?? null, f.title, f.body);
    }
    // 本簇登记（只登记本族；其余 type 不受簇仲裁管辖）
    if (tid && PAUSE_CLUSTER_TYPES.includes(f.type)) {
      pauseCluster.set(tid, { at: now, rank: PAUSE_CLUSTER_RANK[f.type] ?? 0, rowId });
      if (pauseCluster.size > 300) {
        const oldest = pauseCluster.keys().next().value;
        if (oldest !== undefined) pauseCluster.delete(oldest);
      }
    }
    refreshUnreadBadge(db);
    return false;
  } catch (e) {
    notificationWriteFailures += 1;
    logger.error({ err: (e as Error)?.message, type: f.type, taskId: f.taskId }, '通知落库失败（已计入 getNotificationWriteFailures）');
    return false;
  }
}

/** zx_20260906_1 4b: 按任务把其通知置为已读（处置即已读——resume/respond/恢复后铃/徽标不再残留） */
export function markTaskRead(db: Database.Database, taskId: string): void {
  try {
    ensureNotificationsTable(db);
    db.prepare("UPDATE wa_notifications SET read_at = datetime('now') WHERE task_id = ? AND read_at IS NULL").run(taskId);
    refreshUnreadBadge(db);
  } catch { /* best-effort */ }
}

// ───────────────────────── 订阅装配 ─────────────────────────

function extract(data: Record<string, unknown>): TaskEventData {
  return (data ?? {}) as TaskEventData;
}

/**
 * P0-4：文案一律经 `buildTaskNotice` **现查 `wa_tasks.status`** 得出——
 * 调用方只给 `kind`（句子框架），**不提供状态词**，故"事件说 failed、账上是 completed"时
 * 通知仍如实说账上的那个（承诺见 `task-notice.ts` 头注释）。
 */
export function subscribeTaskNotifications(opts: { db: Database.Database; eventBus: EventBus }): void {
  const { db, eventBus } = opts;
  ensureNotificationsTable(db);

  const handleTaskEvent = (type: string, e: AppEvent, opts_: NotifPopupRequest) => {
    const d = extract(e.data);
    const taskId = d.taskId ?? d.task_id;
    const projectId = d.projectId;
    // zx_20260908 D3: 去重标志上移——被去重(8s 内同类双事件)则不再弹原生(completed + status_changed(completed) 只弹一次)
    const deduped = recordNotification(db, { type, taskId, projectId, title: opts_.title, body: opts_.body });
    if (!deduped) _popup?.({ ...opts_, taskId });
  };

  // 任务名优先取事件 title，其次回查 DB——通知中心显示任务名称而非 ID（2026-09-04_2 修复）
  const resolveName = (d: TaskEventData): string => {
    const id = d.taskId ?? d.task_id;
    if (d.title) return d.title;
    if (id) {
      try {
        const row = db.prepare('SELECT title FROM wa_tasks WHERE id = ?').get(id) as { title?: string } | undefined;
        if (row?.title) return row.title;
      } catch { /* ignore */ }
      return `任务 ${id.slice(0, 8)}`;
    }
    return '任务';
  };

  /**
   * 无 `taskId` 的事件无从查账 ⇒ 返回 null，调用方退回任务名本身
   * （不编状态词、不另立一族字面量）。
   */
  const noticeOf = (kind: TaskNoticeKind, d: TaskEventData, detail?: string): TaskNotice | null => {
    const taskId = d.taskId ?? d.task_id;
    if (!taskId) return null;
    try {
      return buildTaskNotice(db, taskId, kind, { detail });
    } catch {
      return null;
    }
  };

  eventBus.on('task.failed', (e: AppEvent) => {
    const d = extract(e.data);
    const name = resolveName(d);
    const n = noticeOf('failed', d, typeof d.error === 'string' ? d.error : '');
    handleTaskEvent('task.failed', e, { type: 'task.failed', title: n?.title ?? name, body: n?.body ?? name });
  });

  eventBus.on('task.awaiting_input', (e: AppEvent) => {
    const d = extract(e.data);
    const name = resolveName(d);
    const n = noticeOf('awaiting_input', d);
    handleTaskEvent('task.awaiting_input', e, { type: 'task.awaiting_input', title: n?.title ?? name, body: n?.body ?? name });
  });

  const completed = (e: AppEvent) => {
    const d = extract(e.data);
    const name = resolveName(d);
    const n = noticeOf('completed', d);
    handleTaskEvent('task.completed', e, { type: 'task.completed', title: n?.title ?? name, body: n?.body ?? name, onlyWhenAway: true });
  };

  eventBus.on('task.completed', completed);

  /**
   * `status_changed` 兜底路（部分流程只发它，不单独发对应事件）——**P0-6 扩面点**：
   * - 执行类状态 ⇒ 同任务旧通知随之已读（既有裁定，防刷屏）；
   * - `completed` ⇒ 与 `task.completed` 同规则（record/popup 均去重）；
   * - **`paused` / `failed` ⇒ 新增落行**（此前在此被 `return` 丢弃 ⇒ 引擎自置暂停结构上无通知）；
   * - 其余（`archived` 等）维持既有：不落。
   * 开关 `notification.pause_and_deviation` **恒订阅、在此处门控**——订阅与否在装配那一刻决定，
   * 而本仓开关一律读库即时生效，按"不订阅"实现会要重启才生效（与 `isEnabled`/`isQuietTime` 同款）。
   */
  eventBus.on('task.status_changed', (e: AppEvent) => {
    const d = extract(e.data);
    const ns = (d.new_status ?? d.status) as string | undefined;
    const taskId = d.taskId ?? d.task_id;
    // zx_20260906_1 4b: 处置即已读——任务被 恢复/继续/respond/前往 转入执行类状态时，同任务旧通知(awaiting_input/failed)随之已读（铃/dock/家族计数不残留）
    if (ns && EXECUTING_STATUSES.includes(ns)) {
      if (taskId) markTaskRead(db, taskId);
    }
    if (ns === 'completed') return completed(e);
    if (ns !== 'paused' && ns !== 'failed') return;
    if (!readBoolSetting(db, PAUSE_DEVIATION_KEY)) return;
    const name = resolveName(d);
    // 暂停行**不传 detail**：因由由账上的 `ctx.pause_reason` 派生（`buildTaskNotice` 内现查）——
    // 调用方自述因由正是 P0-4 要治的那件事。失败行则传 `d.error`（`update_task_status` 载荷自带 `error: args.reason`）。
    const n = ns === 'paused'
      ? noticeOf('paused', d)
      : noticeOf('failed', d, typeof d.error === 'string' ? d.error : '');
    handleTaskEvent(`task.${ns}`, e, { type: `task.${ns}`, title: n?.title ?? name, body: n?.body ?? name });
  });

  /**
   * P0-6(c): `task.goal_deviation` —— 此前**从未被订阅** ⇒ 偏离提醒只进会话流。
   * 与 `paused` 分开一事：偏离发生时任务**尚在 executing**（abort 之后才转），
   * 故 kind 用 `'goal_deviation'`（句子不声明状态），不用 `'paused'` 框架。
   */
  eventBus.on('task.goal_deviation', (e: AppEvent) => {
    if (!readBoolSetting(db, PAUSE_DEVIATION_KEY)) return;
    const d = extract(e.data);
    const name = resolveName(d);
    const n = noticeOf('goal_deviation', d, typeof d.reason === 'string' ? d.reason : '');
    handleTaskEvent('task.goal_deviation', e, { type: 'task.goal_deviation', title: n?.title ?? name, body: n?.body ?? name });
  });
}
