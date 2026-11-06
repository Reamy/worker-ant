/**
 * IM **通知意图账**（zx_20261012_2 批五 M5）——"这次到底有没有尝试通知、被聚并了几条"的唯一可写账。
 *
 * ## 为什么必须另立一本账（不是抄 `im-outbox` 一份）
 *
 * 真实发送走 `pushImNotify` → 发送真源 `core/im/im-send.ts`（zx_20261106_1 M1 起**静态**引用）。
 * 受控回归跑在 node 里、没有 electron ⇒ 适配器注册表为空，发送会以"渠道适配器未运行"失败——
 * 但**意图**这条事实仍必须落在一本**不依赖 electron** 的表上：`wa_im_notify_log` 记的是
 * "**决定要发**"这一刻。三本账各司其职——意图账（本表，判"有没有想过发"）／
 * `wa_im_outbox`（判"发了没成、待补"）／`wa_im_conversations`（判"真送到"）。
 *
 * ## 结果列（zx_20261106_1 M1）
 *
 * 单行表达「意图 → 结果」：`outcome` ∈ `NOTIFY_OUTCOMES`，`detail` 记原因/目标数。
 * 旧库无此二列时**降级写旧形状**（不因缺列丢通知），旧夹具照常可跑。
 *
 * ## 聚并语义（治的是"一次失败两条通知"）
 *
 * 同一 `(project_id, kind)` 在 `IM_FAIL_AGG_WINDOW_MS` 窗口内至多**真发一条**；其间的计入 `suppressed=1`。
 * 窗口基线是**最近一条真发**（`suppressed = 0`）那行的 `at`——被聚并的行**不**刷新窗口。
 * **没发出去的那次（`skipped`/`error`）不得占用/刷新窗口**：否则一次"无目标可投"就能把
 * 下一次真能送达的失败通知挡在门外。
 */
import crypto from 'node:crypto';
import type { ImDb } from './im-db.js';
import { createLogger } from '../logger.js';

const log = createLogger('im-notify-log');

/** 失败类通知的聚并窗口：同项目同类型此窗内至多真发一条。 */
export const IM_FAIL_AGG_WINDOW_MS = 5 * 60_000;

/** 参与聚并的类目。其余类目照样入账（留痕），但 `suppressed` 恒 0。 */
export const IM_AGG_KINDS: readonly string[] = ['task_failed'];

/** 一条通知意图的**结果**词表（一处真源；renderer/查询按此展示）。 */
export const NOTIFY_OUTCOMES = ['intent', 'sent', 'skipped', 'suppressed', 'error'] as const;
export type NotifyOutcome = (typeof NOTIFY_OUTCOMES)[number];

/** 不占用失败聚并窗口的结果——"没发出去"不等于"发过"。 */
const NON_WINDOW_OUTCOMES: readonly NotifyOutcome[] = ['skipped', 'error'];

export interface NotifyIntent {
  projectId?: string | null;
  taskId?: string;
  kind: string;
  /** 注入时钟（受控回归可喂定值）；缺省取墙钟毫秒。窗口与此同基准。 */
  now?: number;
  /** 登记时的结果（缺省 `intent`；无目标等"根本没发"的情形直接记 `skipped`）。 */
  outcome?: NotifyOutcome;
  /** 结果原因/目标数（人读，不记通知正文）。 */
  detail?: string;
}

function shortId(id: string): string {
  return id ? id.slice(0, 8) : '';
}

/**
 * 登记一次"决定要发"的通知意图，并回答**本次是否被聚并**。
 *
 * 返回 `{ suppressed: true, id }` ⇒ 调用方应**跳过发送**；
 * `false` ⇒ 应继续发送（发送完成后用 `finishNotifyIntent` 回填结果）。
 * 表缺席/缺列（老库、旧夹具）⇒ 退化为 `{ suppressed: false, id: null }`（不聚并照发，绝不因记账失败吞通知）。
 */
export function recordNotifyIntent(db: ImDb, intent: NotifyIntent): { suppressed: boolean; id: string | null } {
  const now = intent.now ?? Date.now();
  const projectId = intent.projectId ?? '';
  const taskId = intent.taskId ?? '';
  const { kind } = intent;
  const outcome: NotifyOutcome = intent.outcome ?? 'intent';
  const detail = intent.detail ?? '';
  try {
    let suppressed = false;
    if (IM_AGG_KINDS.includes(kind)) {
      // 缺列（旧库/旧夹具）时回退到旧查询——不能因本列缺失把整条通知吞掉。
      try {
        const last = db
          .prepare(`SELECT at FROM wa_im_notify_log WHERE project_id = ? AND kind = ? AND suppressed = 0 AND COALESCE(outcome, '') NOT IN (${NON_WINDOW_OUTCOMES.map(() => '?').join(',')}) ORDER BY at DESC LIMIT 1`)
          .get(projectId, kind, ...NON_WINDOW_OUTCOMES) as { at?: number } | undefined;
        if (last && typeof last.at === 'number' && now - last.at < IM_FAIL_AGG_WINDOW_MS) suppressed = true;
      } catch {
        const last = db
          .prepare('SELECT at FROM wa_im_notify_log WHERE project_id = ? AND kind = ? AND suppressed = 0 ORDER BY at DESC LIMIT 1')
          .get(projectId, kind) as { at?: number } | undefined;
        if (last && typeof last.at === 'number' && now - last.at < IM_FAIL_AGG_WINDOW_MS) suppressed = true;
      }
    }
    const id = crypto.randomUUID();
    try {
      db.prepare('INSERT INTO wa_im_notify_log (id, project_id, task_id, kind, suppressed, outcome, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        id,
        projectId,
        taskId,
        kind,
        suppressed ? 1 : 0,
        outcome,
        detail,
        now,
      );
    } catch {
      // 旧库/旧夹具没有 outcome/detail 两列：降级写旧形状，**不丢这条意图**。
      db.prepare('INSERT INTO wa_im_notify_log (id, project_id, task_id, kind, suppressed, at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id,
        projectId,
        taskId,
        kind,
        suppressed ? 1 : 0,
        now,
      );
    }
    return { suppressed, id };
  } catch (err) {
    // zx_20261106_1 M1（私人语言 → 公共账）: 记账失败**不再无声**——按天日志留一行，仍不阻断通知。
    log.error({ taskId: shortId(taskId), kind, outcome, error: (err as Error).message || String(err) }, '通知意图记账失败');
    return { suppressed: false, id: null };
  }
}

/** 发送完成后回填结果。`id === null`（记账失败/旧库降级）时无事可做；失败只记日志。 */
export function finishNotifyIntent(db: ImDb, id: string | null, outcome: NotifyOutcome, detail?: string): void {
  if (!id) return;
  try {
    db.prepare('UPDATE wa_im_notify_log SET outcome = ?, detail = ? WHERE id = ?').run(outcome, detail ?? '', id);
  } catch (err) {
    log.error({ outcome, error: (err as Error).message || String(err) }, '通知意图结果回填失败');
  }
}
