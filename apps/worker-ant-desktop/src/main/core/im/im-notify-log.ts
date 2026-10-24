/**
 * IM **通知意图账**（zx_20261012_2 批五 M5）——"这次到底有没有尝试通知、被聚并了几条"的唯一可写账。
 *
 * ## 为什么必须另立一本账（不是抄 `im-outbox` 一份）
 *
 * 真实发送走 `pushImNotify` → 动态 `import('../../ipc/im.ipc.js')`（该文件**静态** `import { ipcMain } from 'electron'`）。
 * 受控回归跑在 node 里、起不了 electron ⇒ **发送路径整段不触发**，`wa_im_conversations`/`wa_im_outbox` 都不会有新行。
 * 于是"该发没发"这类缺陷（本批要治的病）在回归里**无从正面断言**——只能断言"不抛"，而那正是本仓反复
 * 点名的假绿形态（被 try/catch 吞掉的写入只有 0→1 的正面断言抓得住）。
 *
 * 故"意图"必须落在**不依赖 electron** 的表上：`wa_im_notify_log` 记的是"**决定要发**"这一刻，
 * 与后两个账各司其职——意图账（本表，判"有没有想过发"）／`wa_im_outbox`（判"发了没成、待补"）／
 * `wa_im_conversations`（判"真送到"）。这正是本仓"判某消息发没发的三本账"的思路（同 a-stock 侧既有约定）。
 *
 * ## 聚并语义（治的是"一次失败两条通知"）
 *
 * `recordExecutionFailure` 既直接调 `markTaskFailed`，又 `emit('task.failed')`（事件投影器**再**调一次
 * `markTaskFailed`）——同一次失败因此**两跳**到通知口。若不去重就是两条 IM。做法：同一
 * `(project_id, kind)` 在 `IM_FAIL_AGG_WINDOW_MS` 窗口内至多**真发一条**；其间的计入 `suppressed=1`。
 *
 * 窗口基线是**最近一条真发**（`suppressed = 0`）那行的 `at`——被聚并的行**不**刷新窗口，
 * 否则"连续失败"会把窗口无限顺延、永远发不出去第二条。故"已真发条数"＝`suppressed=0` 的行数。
 *
 * ⚠ 无目标可投时**不走本模块**（`pushImNotify` 先解析目标，`targets.length === 0` 即 return）：
 *   什么都没打算发，就不该消耗窗口（否则下一次真能送达时反而被上一轮"哑火"挡住）。
 */
import crypto from 'node:crypto';
import type { ImDb } from './im-db.js';

/** 失败类通知的聚并窗口：同项目同类型此窗内至多真发一条。 */
export const IM_FAIL_AGG_WINDOW_MS = 5 * 60_000;

/** 参与聚并的类目。其余类目照样入账（留痕），但 `suppressed` 恒 0。 */
export const IM_AGG_KINDS: readonly string[] = ['task_failed'];

export interface NotifyIntent {
  projectId?: string | null;
  taskId?: string;
  kind: string;
  /** 注入时钟（受控回归可喂定值）；缺省取墙钟毫秒。窗口与此同基准。 */
  now?: number;
}

/**
 * 登记一次"决定要发"的通知意图，并回答**本次是否被聚并**。
 *
 * 返回 `{ suppressed: true }` ⇒ 调用方应**跳过发送**（窗口内已有真发的一条）；
 * `false` ⇒ 应继续发送（本行也即刷成新的窗口基线）。
 * 表缺席（老库/夹具未建）⇒ 退化为 `{ suppressed: false }`（不聚并照发，绝不因记账失败吞掉通知）。
 */
export function recordNotifyIntent(db: ImDb, intent: NotifyIntent): { suppressed: boolean } {
  const now = intent.now ?? Date.now();
  const projectId = intent.projectId ?? '';
  const taskId = intent.taskId ?? '';
  const { kind } = intent;
  try {
    let suppressed = false;
    if (IM_AGG_KINDS.includes(kind)) {
      const last = db
        .prepare('SELECT at FROM wa_im_notify_log WHERE project_id = ? AND kind = ? AND suppressed = 0 ORDER BY at DESC LIMIT 1')
        .get(projectId, kind) as { at?: number } | undefined;
      if (last && typeof last.at === 'number' && now - last.at < IM_FAIL_AGG_WINDOW_MS) suppressed = true;
    }
    db.prepare('INSERT INTO wa_im_notify_log (id, project_id, task_id, kind, suppressed, at) VALUES (?, ?, ?, ?, ?, ?)').run(
      crypto.randomUUID(),
      projectId,
      taskId,
      kind,
      suppressed ? 1 : 0,
      now,
    );
    return { suppressed };
  } catch {
    return { suppressed: false };
  }
}
