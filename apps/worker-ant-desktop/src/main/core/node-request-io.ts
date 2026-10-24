/**
 * zx_20261004 M12（维特根斯坦·一个规则一处）: 中转队列的**真 IO**——拉待办 / 回传终态。
 *
 * 为什么单独成模块（而不塞进 `node-request-worker.ts`）：那个模块的头号纪律是**不触网**——
 *   它只认注入的 `RequestIo`/`RequestRunner`，正因如此受控回归能喂假实现、不出网跑真逻辑。
 *   网络那一半单独放这里，`ansSignedRequest`（**到 ANS 的唯一出路**）在 main 侧的出现面就仍是一处可查。
 *
 * ⚠ 失败**抛**（不把"没拉到"与"没有待办"混成一个空数组）——由 `node-request-worker` 按其语义分流：
 *   `list` 抛 ⇒ 本轮没取到（不改任何一件的状态）；`report` 抛 ⇒ 这件**不谎报成功**，下轮重拉（至少一次）。
 * ⚠ 日志按"原因变了才出声"去噪：节点尚未注册时每次心跳都会 403，逐跳刷屏等于把真问题淹掉。
 */
import type Database from 'better-sqlite3';
import { ansFailureNote, ansSignedRequest, resolveAnsCreds, type AnsSettingDb } from './ans-signed-request.js';
import { createLogger } from './logger.js';
import { ensureNodeIdentity, type NodeSettingDb } from './node-identity.js';
import type { RequestIo } from './node-request-worker.js';
import type { ClarifyIo } from './node-clarify.js';
import type { AnsNodeRequest, NodeQuestion } from '@worker-ant/shared-types';

const logger = createLogger('node-request-io');

/**
 * 真 IO：拉待办/回传（`RequestIo`）**并**澄清问答（`ClarifyIo`）——同一份签名请求的三种用法。
 * 返回类型是并集 ⇒ 调用方按需取用（worker 只认 `RequestIo`；`ask_user` 的 asker 只认 `ClarifyIo`）。
 */
export function makeAnsRequestIo(db: Database.Database): RequestIo & ClarifyIo {
  const credsDb = db as unknown as AnsSettingDb;
  const settingDb = db as unknown as NodeSettingDb;
  let lastNote = '';

  /** 同一原因只出一次声；原因变化（新问题/换了问题）再出一次。 */
  const noteOnce = (op: string, note: string): void => {
    if (note === lastNote) return;
    lastNote = note;
    logger.warn({ op, note }, '中转队列请求失败');
  };

  return {
    async list(nodeId: string): Promise<AnsNodeRequest[]> {
      const r = await ansSignedRequest(resolveAnsCreds(credsDb), `/api/v1/nodes/requests?node_id=${encodeURIComponent(nodeId)}`, { method: 'GET' });
      if (!r.ok) { const note = ansFailureNote(r); noteOnce('list', note); throw new Error(note); }
      try {
        const body = (await r.response!.json()) as { data?: AnsNodeRequest[] };
        return Array.isArray(body.data) ? body.data : [];
      } catch (e) {
        const note = `响应解析失败 — ${(e as Error)?.message || String(e)}`;
        noteOnce('list', note);
        throw new Error(note);
      }
    },

    async report(id, report) {
      const r = await ansSignedRequest(resolveAnsCreds(credsDb), `/api/v1/nodes/requests/${encodeURIComponent(id)}/result`, { method: 'POST', body: report });
      if (!r.ok) { const note = ansFailureNote(r); noteOnce('report', note); throw new Error(note); }
      return r.status;
    },

    // ==================== M4 双向澄清（B 端提问 / 读作答） ====================
    /** `POST /requests/:id/question`——本机（被派方）就这一单提问；`node_id` 由本机身份派生（不自报）。 */
    async ask(id: string, question: NodeQuestion): Promise<void> {
      const nodeId = ensureNodeIdentity(settingDb).id;
      const r = await ansSignedRequest(resolveAnsCreds(credsDb), `/api/v1/nodes/requests/${encodeURIComponent(id)}/question`, {
        method: 'POST',
        body: {
          node_id: nodeId,
          question: question.question,
          ...(question.options !== undefined ? { options: question.options } : {}),
        },
      });
      if (!r.ok) { const note = ansFailureNote(r); noteOnce('ask', note); throw new Error(note); }
    },

    /** `GET /requests/:id` → 作答串。未答为 `null`；读不到（网络/鉴权）**抛**（由 `askRequester` 折成"继续等"）。 */
    async readAnswer(id: string): Promise<string | null> {
      const r = await ansSignedRequest(resolveAnsCreds(credsDb), `/api/v1/nodes/requests/${encodeURIComponent(id)}`, { method: 'GET' });
      if (!r.ok) { const note = ansFailureNote(r); noteOnce('readAnswer', note); throw new Error(note); }
      let body: { data?: AnsNodeRequest };
      try {
        body = (await r.response!.json()) as { data?: AnsNodeRequest };
      } catch (e) {
        const note = `响应解析失败 — ${(e as Error)?.message || String(e)}`;
        noteOnce('readAnswer', note);
        throw new Error(note);
      }
      const answer = body.data?.answer;
      return answer && typeof answer.answer === 'string' ? answer.answer : null;
    },
  };
}
