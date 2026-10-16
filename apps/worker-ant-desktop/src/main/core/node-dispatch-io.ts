/**
 * zx_20261011 M3（维特根斯坦·一个规则一处）: 派发（发送侧）的**真 IO**——提交 / 读回。
 *
 * 为什么单独成模块（而不塞进 `node-dispatcher.ts`）：那个模块的头号纪律是**不触网**——
 *   它只认注入的 `DispatchIo`，正因如此受控回归能喂假实现、不出网跑真逻辑（同 `node-request-io.ts`
 *   与 `node-request-worker.ts` 的分工）。网络那一半单独放这里，`ansSignedRequest`（**到 ANS 的唯一出路**）
 *   在 main 侧的出现面就仍是一处可查。
 *
 * ⚠ 与**接收侧** `RequestIo`（`node-request-io.ts`）刻意分开：那条路是"我作为被派方拉待办/回传"，
 *   这条路是"我作为派发方提交/读回"。二者都是到 ANS 的签名请求，但**语义相反**（一取一送），
 *   合成一个接口会把两件事混成一件事（同 `node-call-log` 与 `node-dispatch-log` 的取舍方向）。
 *
 * ⚠ 失败**抛**（不把"没提交上"与"提交上但没 id"混成同一个空值）——由 `node-dispatcher` 按其语义
 *   分流成 `{ ok:false, note }`，**永不外溢**。读回失败同理：抛 ⇒ 调用方如实报"这次没读到"。
 * ⚠ 日志按"原因变了才出声"去噪（同 `node-request-io.ts`）：未注册时每轮都 403，逐轮刷屏等于把真问题淹掉。
 */
import type Database from 'better-sqlite3';
import { ansFailureNote, ansSignedRequest, resolveAnsCreds, type AnsSettingDb } from './ans-signed-request.js';
import { createLogger } from './logger.js';
import type { DispatchIo } from './node-dispatcher.js';
import type { AnsNodeRequest, NodeRequestSubmit } from '@worker-ant/shared-types';

const logger = createLogger('node-dispatch-io');

export function makeAnsDispatchIo(db: Database.Database): DispatchIo {
  const credsDb = db as unknown as AnsSettingDb;
  let lastNote = '';

  /** 同一原因只出一次声；原因变化（新问题/换了问题）再出一次。 */
  const noteOnce = (op: string, note: string): void => {
    if (note === lastNote) return;
    lastNote = note;
    logger.warn({ op, note }, '派发请求失败');
  };

  /** 从响应里取 `data`——ANS 侧提交/读回**皆是** `{ data: AnsNodeRequest }`（`routes/nodes.ts`）。 */
  const readData = async (r: { response?: Response }, op: string): Promise<AnsNodeRequest> => {
    let body: { data?: AnsNodeRequest };
    try {
      body = (await r.response!.json()) as { data?: AnsNodeRequest };
    } catch (e) {
      const note = `响应解析失败 — ${(e as Error)?.message || String(e)}`;
      noteOnce(op, note);
      throw new Error(note);
    }
    if (!body.data) {
      const note = '响应缺少 data';
      noteOnce(op, note);
      throw new Error(note);
    }
    return body.data;
  };

  return {
    async submit(req: NodeRequestSubmit): Promise<AnsNodeRequest> {
      const r = await ansSignedRequest(resolveAnsCreds(credsDb), '/api/v1/nodes/requests', { method: 'POST', body: req });
      if (!r.ok) { const note = ansFailureNote(r); noteOnce('submit', note); throw new Error(note); }
      return readData(r, 'submit');
    },

    async get(id: string): Promise<AnsNodeRequest> {
      const r = await ansSignedRequest(resolveAnsCreds(credsDb), `/api/v1/nodes/requests/${encodeURIComponent(id)}`, { method: 'GET' });
      if (!r.ok) { const note = ansFailureNote(r); noteOnce('get', note); throw new Error(note); }
      return readData(r, 'get');
    },

    // zx_20261011_1 M4: 作答 B 端的一问——`POST /requests/:id/answer`，ANS 侧按**请求方身份**鉴权（`byNode`/`byPrefix`）。
    async answer(id: string, answer: string): Promise<AnsNodeRequest> {
      const r = await ansSignedRequest(resolveAnsCreds(credsDb), `/api/v1/nodes/requests/${encodeURIComponent(id)}/answer`, { method: 'POST', body: { answer } });
      if (!r.ok) { const note = ansFailureNote(r); noteOnce('answer', note); throw new Error(note); }
      return readData(r, 'answer');
    },
  };
}
