/**
 * zx_20261011_4 M3（维特根斯坦·一个概念一个值 / 老子·知止）: 「本机可派的对端是谁」的**核心侧真源**。
 *
 * 病根：`GET /api/v1/nodes` 这份台账此前**只有一个读者**——IPC `nodes:list`（面板）。编排器（`orchestrator.ts`）
 *   要判"有没有可派的他机"（N3 预查：没有就不外派，免得造一张永远没人接的悬空单），却取不到这份台账：
 *   原取数口 `fetchNodes` 住在 `ipc/nodes.ipc.ts`（引 electron、且未导出）。若在 core 另写一份 fetch，
 *   就是"同一件事两处各记各的"——台账的形状/失败文案迟早两样。
 *   ⇒ 把**取数**（`fetchNodes`）与**收窄**（`listDispatchablePeers`）移入本模块一处：
 *     - `nodes.ipc.ts` 转调 `fetchNodes`（面板与编排器读**同一份**）；
 *     - 收窄判据 `isDispatchable ∧ isNodeOnline` 与面板 D2 **同源**（皆自 `shared-types`），只多一条
 *       "**排除本机**"——派活的意义是交给**他机**（派给自己等于空转一圈）。
 *
 * ⚠ 本模块**只依赖 electron-free** 的 `ans-signed-request`（全仓唯一出路）与 `shared-types`——
 *   故 core/编排器可直引它，且受控回归喂假 `listPeers` 亦不受影响。
 * ⚠ **永不抛**：失败装进返回值（`error`/`errorStatus`），由面板/编排器各自如实上屏或如实不外派。
 */
import type Database from 'better-sqlite3';
import { ansFailureNote, ansSignedRequest, resolveAnsCreds, type AnsSettingDb } from './ans-signed-request.js';
import { isDispatchable, isNodeOnline, type AnsNode } from '@worker-ant/shared-types';

/** 台账读取的结局（`error` 非空即"没读到，原因是这个"）。`nodes.ipc.ts` 的 `NodesListPayload` 承此再加 `gate`。 */
export interface NodeLedger {
  nodes: AnsNode[];
  localNodeId: string;
  /** 读失败/解析失败的人话原因（成功时缺省）。 */
  error?: string;
  /**
   * zx_20261011_3（维特根斯坦·一个概念一个值）: 读台账失败的 **HTTP 状态码**（传输层失败为 `0`）——
   *   与 `error`（prose）**分开**：面板据**结构化码**判"是不是本机被拒"（401/403），而不是去子串匹配那句
   *   人话（子串判据一改文案就失准，且把"显示"与"判定"两件事搅在一起）。
   */
  errorStatus?: number;
}

/**
 * 取 ANS 上的**全部节点台账**。失败/解析错都装进返回值，永不抛。
 * `localNodeId` 原样回填（"谁是本机"由调用方定，本函数不猜、不按 `name` 认）。
 */
export async function fetchNodes(db: Database.Database, localNodeId: string): Promise<NodeLedger> {
  const creds = resolveAnsCreds(db as unknown as AnsSettingDb);
  const r = await ansSignedRequest(creds, '/api/v1/nodes', { method: 'GET' });
  // zx_20261011_3：失败时一并回**结构化码**（面板据此判"是否本机被拒"，见 `NodeLedger.errorStatus`）。
  if (!r.ok) return { nodes: [], localNodeId, error: ansFailureNote(r), errorStatus: r.status };
  try {
    const body = (await r.response!.json()) as { data?: AnsNode[] };
    return { nodes: Array.isArray(body.data) ? body.data : [], localNodeId };
  } catch (e) {
    return { nodes: [], localNodeId, error: `响应解析失败 — ${(e as Error)?.message || String(e)}` };
  }
}

/**
 * 从台账里挑出**本机此刻可派**的对端——**纯函数**（喂台账标本即可直跑，见 rr）。
 *
 * 三条同时成立（缺一不可）：
 *   - `isDispatchable(node)`：参与 ∧ 非观察者（"谁接得住"的唯一判据，与 ANS `DISPATCHABLE_WHERE` 同义）；
 *   - `isNodeOnline(last_seen_at, nowMs)`：在线（与面板 D2 **同一把尺**）；
 *   - `node_id !== localNodeId`：**排除本机**——派活是"交给他机"，选到自己等于空转一圈
 *     （承 §1 N3：外派的判据是"有**他机**可派"，不是"有人在线"）。
 *
 * ⚠ **不查类目**：本轮类目恒为 `project_task`（每台工蚁卡恒含），且类目命中由 ANS 侧 `DISPATCHABLE_WHERE`
 *   最终把关——此处若再写一份类目判据即"第二把尺"。收窄在此**只做本地能确定的三条**，够不够由 ANS 说了算。
 */
export function listDispatchablePeers(ledger: NodeLedger, nowMs: number): AnsNode[] {
  return ledger.nodes.filter(
    (n) => n.node_id !== ledger.localNodeId && isDispatchable(n) && isNodeOnline(n.last_seen_at, nowMs),
  );
}
