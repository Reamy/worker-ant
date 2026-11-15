/**
 * zx_20261115_2 M1（老子·知止）：中继任务树的**真停**——超时/叫停时整棵树一起收口。
 *
 * 病根：`node-request-runner.ts` 10 分钟超时此前只停止等待、回传 error；
 *   `archiveTask(root)` 又只翻单行、不级联 ⇒ 远端根任务与 pending 子任务继续跑，
 *   超时后再 cancel 还会被 ANS 终态短路。真机 E2E 的 `[Sub] [Sub] 复核…` 就是这么留下的孤儿树。
 *
 * 本模块只做一件事：以中继根为起点，**先叫停远端已外派的成员，再归档所有非终态成员**。
 *   - 本地：`archiveTask`（会 abort 在途执行体、发 `task.status_changed`；幂等）；
 *   - 远端：对 `assigned_request_id` 调 `cancelNodeRequest`；读不到/未入网 ⇒ 如实进 errors，不谎称已停。
 *
 * ⚠ 不碰已终态成员（completed / failed / archived）：收口是"让还在跑的停下来"，不是改写历史。
 * ⚠ 永不抛：单条失败装进 errors，调用方据此如实回传 `archived` / `cancelledRemote` 计数。
 */
import type Database from 'better-sqlite3';
import { archiveTask } from './task-archive.js';
import { collectSubtreeIds } from './task-accounting.js';
import { remoteAssignOf } from './node-orchestrate.js';
import { cancelNodeRequest } from './node-dispatcher.js';

const TERMINAL = new Set(['completed', 'failed', 'archived']);

export interface TerminateRelayTreeResult {
  /** 本次真翻到 `archived` 的行数（已终态的不计）。 */
  archived: number;
  /** 整棵树的成员数（含根；含已终态的）。 */
  treeSize: number;
  /** 成功发出远端叫停的成员数（不把"发出了"说成"对端已停"）。 */
  cancelledRemote: number;
  /** 逐条失败原因（不吞；空数组 = 全成）。 */
  errors: string[];
}

export interface TerminateRelayTreeOpts {
  /**
   * 远端叫停实现（rr 注入假实现即不出网；生产缺省走 `cancelNodeRequest`）。
   * 返回 `{ ok:false }` / 抛错都只记 errors，不改本地归档。
   */
  cancel?: (requestId: string) => Promise<{ ok?: boolean; note?: string }>;
}

/**
 * 真停整棵中继任务树。**先远端、后本地**：先告诉对端停，再把本机行归档；
 * 反序会让对端在收到叫停前继续跑一拍（不过归档会 abort 本机侧等待，最终仍以 errors 如实留痕）。
 */
export async function terminateRelayTree(
  db: Database.Database,
  rootTaskId: string,
  reason: string,
  opts: TerminateRelayTreeOpts = {},
): Promise<TerminateRelayTreeResult> {
  const out: TerminateRelayTreeResult = { archived: 0, treeSize: 0, cancelledRemote: 0, errors: [] };
  if (!rootTaskId) return out;
  let ids: string[] = [];
  try {
    ids = [rootTaskId, ...collectSubtreeIds(db, rootTaskId)];
  } catch (e) {
    out.errors.push(`collect subtree: ${(e as Error)?.message || String(e)}`);
    ids = [rootTaskId];
  }
  out.treeSize = ids.length;
  for (const id of ids) {
    let row: { status?: string | null; context_json?: string | null } | undefined;
    try {
      row = db.prepare('SELECT status, context_json FROM wa_tasks WHERE id = ?').get(id) as
        | { status?: string | null; context_json?: string | null }
        | undefined;
    } catch (e) {
      out.errors.push(`${id.slice(0, 8)} read: ${(e as Error)?.message || String(e)}`);
      continue;
    }
    if (!row) continue;
    const status = String(row.status ?? '');
    if (TERMINAL.has(status)) continue;
    const assign = remoteAssignOf(row.context_json);
    if (assign) {
      try {
        const r = opts.cancel
          ? await opts.cancel(assign.requestId)
          : await cancelNodeRequest(db, assign.requestId);
        if (r?.ok === false) out.errors.push(`${id.slice(0, 8)} cancel: ${r.note || 'remote cancel not confirmed'}`);
        else out.cancelledRemote++;
      } catch (e) {
        out.errors.push(`${id.slice(0, 8)} cancel: ${(e as Error)?.message || String(e)}`);
      }
    }
    try {
      const r = archiveTask(db, { taskId: id, reason });
      if (r.changed) out.archived++;
    } catch (e) {
      out.errors.push(`${id.slice(0, 8)} archive: ${(e as Error)?.message || String(e)}`);
    }
  }
  return out;
}
