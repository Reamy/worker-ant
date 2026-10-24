/**
 * 跨任务消息的**唯一投递实现**（zx_20261023_3 批三「名实」）。
 *
 * 实测事故：`send_message_to_task` 对 `paused` / `pending` 的目标任务执行裸 `UPDATE status='pending'`
 * ——不发事件、不动 `updated_at`、不入队。结果是：用户明明按了暂停，另一个 Agent 发一句话就把任务
 * "复活"了，且台账上只看见末日事件 `paused`、任务行却是 `pending`，账实两说。
 *
 * 语义只有两条：
 *  - **消息只落会话**，不改状态。暂停中的任务恢复后自然读到这句话（`delivered: 'on_resume'`）；
 *    其它状态随当前/下一次执行读到（`delivered: 'now'`）。
 *  - 目标任务不存在 ⇒ `{ ok: false }`，**不插孤儿会话行**（此前先插行后查目标，目标不存在时留下无人读的子串）。
 *
 * 本模块只依赖最小 db 接口，rr 可用内存库直跑真实现。
 */
import crypto from 'node:crypto';

export interface PeerMessageStmt {
  run(...args: unknown[]): { changes?: number };
  get(...args: unknown[]): unknown;
}
export interface PeerMessageDb {
  prepare(sql: string): PeerMessageStmt;
}

export interface PeerMessageInput {
  fromTaskId: string;
  toTaskId: string;
  content: string;
}

export type PeerMessageResult =
  | { ok: true; delivered: 'now' | 'on_resume'; from: string; to: string; targetStatus: string }
  | { ok: false; error: string; from: string; to: string };

export function deliverPeerMessage(db: PeerMessageDb, input: PeerMessageInput): PeerMessageResult {
  const { fromTaskId, toTaskId } = input;
  const content = String(input.content ?? '');
  const target = db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(toTaskId) as { status?: string } | undefined;
  if (!target || !target.status) {
    return { ok: false, error: '目标任务不存在，消息未投递', from: fromTaskId, to: toTaskId };
  }
  db.prepare(
    "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'user', ?, 0, datetime('now'))"
  ).run(crypto.randomUUID(), toTaskId, `[来自任务 ${fromTaskId.slice(0, 8)}] ${content}`);
  // 状态**一律不改**：暂停就是暂停，要复活只能由人（GUI/IM）或恢复链路决定。
  return {
    ok: true,
    delivered: target.status === 'paused' ? 'on_resume' : 'now',
    from: fromTaskId,
    to: toTaskId,
    targetStatus: target.status,
  };
}
