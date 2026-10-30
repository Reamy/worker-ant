/**
 * zx_20261004 M1：工蚁**节点**的路由——注册（令牌换 key）+ 心跳 + 列表 + 改档 + 令牌台。
 *
 * 两个构造器，因为**认证闸不同**：
 *   - `nodeEnrollRoute(db)` —— `POST /register` 走**令牌闸**（K-9）。此刻桌面还没有 key，
 *     不可能签出 HMAC，故这条**必须**挂在公开组。令牌本身即凭证。
 *   - `nodesRoutes(db)` —— 心跳/列表/改档/令牌台走 **HMAC**，挂 `hmacApi` 组。
 *
 * ⚠ 计划原文写"`nodesRoutes(db)` 整挂 hmacApi"，但注册端点**不能**在 HMAC 组内（是先有 key 还是先注册
 *   的鸡生蛋问题）。故拆成两个构造器；此偏离已在方案 §2.9 注记。
 */
import type Database from 'better-sqlite3';
import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode, conflict, notFound } from '../utils/errors.js';
import { ApiKeyManager, getResourceGroupsFromApiKey } from '../utils/security.js';
import { parsePagination, paginationClause, paginationArgs, pageMeta } from '../utils/pagination.js';
import { generateApiKey } from '@worker-ant/ans-client';
import {
  DEFAULT_NODE_ROLE,
  NODE_OFFLINE_SEC,
  isNodeCardCategory,
  isNodeRole,
  isNodeRequestStatus,
  isNodeQuestionStatus,
  canDispatch,
  type AnsNode,
  type AnsNodeRequest,
  type NodeAnswer,
  type NodeQuestion,
  type NodeRequestProgress,
  type NodeRequestStatus,
} from '@worker-ant/shared-types';
import {
  describeNode,
  explainSelection,
  rankDispatchCandidates,
  reliabilityOf,
  RELIABILITY_WINDOW,
  type NodeReliability,
  type RequestOutcomeRow,
  type SelectionSnapshot,
} from './node-ranking.js';

interface NodeRow {
  id: string;
  node_id: string;
  name: string;
  api_key_prefix: string;
  resource_group: string;
  platform: string;
  role: string;
  weight: number;
  participate: number;
  capabilities_json: string;
  card_json: string;
  status_json: string;
  enrolled_at: string;
  last_seen_at: string | null;
  status: string;
}

/** 落库 JSON 列 → 对上面（**收窄**：`role` 非法值回落缺省，不让脏值上屏）。 */
function toNode(row: NodeRow): AnsNode {
  return {
    node_id: row.node_id,
    name: row.name,
    api_key_prefix: row.api_key_prefix,
    resource_group: row.resource_group,
    platform: row.platform,
    role: isNodeRole(row.role) ? row.role : DEFAULT_NODE_ROLE,
    weight: row.weight,
    participate: row.participate === 1,
    capabilities: jsonArray(row.capabilities_json),
    card: jsonObject(row.card_json),
    status: jsonObject(row.status_json),
    enrolled_at: row.enrolled_at,
    last_seen_at: row.last_seen_at,
  };
}

function jsonArray(s: string): string[] {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function jsonObject(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `question_json` → `NodeQuestion`（**收窄**：缺 `question` 串即 `null`——宁可不给，不编一句空问题）。 */
function jsonQuestion(s: string | null): NodeQuestion | null {
  if (s == null) return null;
  const o = jsonObject(s);
  if (!o || typeof o.question !== 'string' || o.question.length === 0) return null;
  const options = Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === 'string') : undefined;
  return { question: o.question, ...(options && options.length > 0 ? { options } : {}) };
}

/** `answer_json` → `NodeAnswer`（**收窄**：缺 `answer` 串即 `null`）。 */
function jsonAnswer(s: string | null): NodeAnswer | null {
  if (s == null) return null;
  const o = jsonObject(s);
  return o && typeof o.answer === 'string' ? { answer: o.answer } : null;
}

/**
 * `progress_json` → `NodeRequestProgress`（**收窄**）：`step` 必须是非负整数，`at` 必须是非空串；
 * 缺任一即整条丢弃（`null`）——半截进度比没有进度更容易被读成结论。
 */
function jsonProgress(s: string | null | undefined): NodeRequestProgress | null {
  if (s == null) return null;
  const o = jsonObject(s);
  if (!o) return null;
  const { step, total, note, at } = o;
  if (typeof step !== 'number' || !Number.isInteger(step) || step < 0) return null;
  if (typeof at !== 'string' || at.length === 0) return null;
  const totalOk = typeof total === 'number' && Number.isInteger(total) && total >= 0 ? total : null;
  return { step, total: totalOk, note: typeof note === 'string' ? note : '', at };
}

/** `ans_node_requests` 行形状（M12）。 */
interface NodeRequestRow {
  id: string;
  category: string;
  payload_json: string;
  requester_key_prefix: string;
  requester_node_id: string | null;
  target_node_id: string | null;
  status: string;
  result_json: string | null;
  question_json: string | null;
  answer_json: string | null;
  question_status: string | null;
  selection_json: string | null;
  /** zx_20261030_1 M2：进度快照（旧库补列后为空；对端未上报亦为空）。 */
  progress_json: string | null;
  /** zx_20261030_1 M3：叫停标志（1 = 派活方已请求停止；旧库补列后为 0）。 */
  cancel_requested: number | null;
  created_at: string;
  claimed_at: string | null;
  done_at: string | null;
}

/** 行 → 对上面（**收窄**：`status` 非法值回落 `pending`，不让脏值上屏）。 */
function toNodeRequest(row: NodeRequestRow): AnsNodeRequest {
  return {
    id: row.id,
    category: row.category,
    payload: jsonObject(row.payload_json) ?? {},
    requester_key_prefix: row.requester_key_prefix,
    requester_node_id: row.requester_node_id ?? null,
    target_node_id: row.target_node_id,
    status: (isNodeRequestStatus(row.status) ? row.status : 'pending') as NodeRequestStatus,
    result: row.result_json == null ? null : jsonObject(row.result_json),
    // M4：`question/answer` 按 JSON 列解出（收窄：非对象/缺关键字段即 `null`）；`question_status` 非法值即 `null`。
    question: jsonQuestion(row.question_json),
    answer: jsonAnswer(row.answer_json),
    question_status: isNodeQuestionStatus(row.question_status) ? row.question_status : null,
    selection: row.selection_json == null ? null : jsonObject(row.selection_json),
    progress: jsonProgress(row.progress_json),
    cancel_requested: row.cancel_requested === 1,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    done_at: row.done_at,
  };
}

/**
 * zx_20261011 M1：请求方身份——**由调用方凭据派生**，不信请求体。
 * 调用方 key 的资源组若含 `node:<id>`（即"它本身是一台已注册工蚁"），则请求方即该节点；
 * 否则 `null`（外部 AI 终端 / dev 凭据）。**从凭据读**⇒ 冒名无从下手（改 body 无用）。
 */
export function deriveRequesterNodeId(db: Database.Database, request: Request): string | null {
  const groups = getResourceGroupsFromApiKey(db, request);
  const g = groups.find((x) => x.startsWith('node:'));
  return g ? g.slice('node:'.length) : null;
}

/**
 * 可派单判据的 **WHERE 片段唯一处**（M12 抽共用 / zx_20261011 M2）：`selectTargetNode`（自动选）
 * 与 `nodeQualifies`（手动目标校验）**同引此常量**，杜绝两处 SQL 各写一套而漂。
 * ⚠ 两个占位符顺序恒为 `(offlineMod, category)` —— 各调用点用 `?` 前的列上下文自行对齐。
 * 语义：可派单（`participate=1 ∧ role!='observer'`，与 `isDispatchable` 同义）∧ 在线（阈值读
 * `NODE_OFFLINE_SEC` 同源常量，不写死数字）∧ 卡类目命中（`card_json.categories ∋ category`）。
 */
const DISPATCHABLE_WHERE = `status = 'active'
       AND participate = 1
       AND role != 'observer'
       AND last_seen_at IS NOT NULL
       AND last_seen_at > datetime('now', ?)
       AND EXISTS (SELECT 1 FROM json_each(ans_nodes.card_json, '$.categories') WHERE json_each.value = ?)`;

/**
 * 某节点此刻**接不接**某类目的活（手动目标的校验据）。与 `selectTargetNode` **同源**（`DISPATCHABLE_WHERE`）。
 */
function nodeQualifies(db: Database.Database, nodeId: string, category: string): boolean {
  const offlineMod = `-${NODE_OFFLINE_SEC} seconds`;
  const row = db
    .prepare(`SELECT 1 FROM ans_nodes WHERE node_id = ? AND ${DISPATCHABLE_WHERE} LIMIT 1`)
    .get(nodeId, offlineMod, category);
  return row !== undefined;
}

/** 调用方（AI 终端/工蚁）的 key 前缀——**仅前缀**，便于追责不泄全键。 */
function callerKeyPrefix(request: Request): string {
  return (request.headers.get('x-api-key') ?? '').slice(0, 8);
}

/**
 * zx_20261030_1 M1（毛选·没有调查，没有发言权）: **历史可靠性取自既有请求行**——
 *   `ans_node_requests` 已有 `status/claimed_at/done_at`，不新增上报字段、不拍脑袋。
 *   一次查询按目标节点分组（节点上限 20，不做 N+1），每组只留最近 `RELIABILITY_WINDOW` 条。
 *   取消不计失败（M3 起会出现 `cancelled` 终态）；表/列缺失时如实回空表（不崩、不编）。
 */
function reliabilityByNode(db: Database.Database, nodeIds: readonly string[]): Map<string, NodeReliability> {
  const out = new Map<string, NodeReliability>();
  if (nodeIds.length === 0) return out;
  const ph = nodeIds.map(() => '?').join(', ');
  let rows: Array<{ target_node_id: string; status: string; claimed_at: string | null; done_at: string | null }>;
  try {
    rows = db
      .prepare(
        `SELECT target_node_id, status, claimed_at, done_at
           FROM ans_node_requests
          WHERE target_node_id IN (${ph})
            AND status IN ('done', 'error', 'cancelled')
          ORDER BY COALESCE(done_at, created_at) DESC`,
      )
      .all(...nodeIds) as typeof rows;
  } catch {
    return out;
  }
  const grouped = new Map<string, RequestOutcomeRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.target_node_id) ?? [];
    if (list.length < RELIABILITY_WINDOW) {
      list.push({ status: row.status, claimed_at: row.claimed_at, done_at: row.done_at });
    }
    grouped.set(row.target_node_id, list);
  }
  for (const [nodeId, list] of grouped) out.set(nodeId, reliabilityOf(list));
  return out;
}

/**
 * 选目标**唯一处**（M12；zx_20261011 M2 纳入负载；zx_20261027_3 M1 改三层排序）。
 * `DISPATCHABLE_WHERE` 只负责**过滤**；排序交给纯函数 `node-ranking.ts`——
 * 原因：旧 SQL 把「余力未知」`COALESCE(..., 1.0)` 当成**满血空闲**，一台没上报容量的机器
 * 会与真正空闲的机器同分，甚至凭高权重压过一台已知 70% 空闲的机器。
 * 现在固定三层：已知有余力（`weight × ratio`）→ 未知（按 weight）→ 已知满负荷。
 * 节点上限 20，全量取回后 JS 排序的成本可忽略。
 * 无合适 ⇒ `null`（调用方置 `pending`）。
 */
function selectTargetNode(
  db: Database.Database,
  category: string,
): { row: NodeRow; selection: SelectionSnapshot } | null {
  const offlineMod = `-${NODE_OFFLINE_SEC} seconds`;
  const rows = db.prepare(`SELECT * FROM ans_nodes WHERE ${DISPATCHABLE_WHERE}`).all(offlineMod, category) as NodeRow[];
  if (rows.length === 0) return null;
  const reliability = reliabilityByNode(
    db,
    rows.map((r) => r.node_id),
  );
  const ranked = rankDispatchCandidates(
    rows.map((row) => ({
      node_id: row.node_id,
      weight: row.weight,
      status_json: row.status_json,
      last_seen_at: row.last_seen_at,
      reliability: reliability.get(row.node_id) ?? null,
      row,
    })),
  );
  const best = ranked[0];
  if (!best) return null;
  return { row: best.item.row, selection: explainSelection(best) };
}

/**
 * `pending → assigned` 那一跳（M12）：工蚁来拉时，顺手把**提交当刻无可派节点**而积压的件，
 * 按"本节点卡类目命中"分给自己。
 *
 * 为什么必须有这一步：提交时的 `selectTargetNode` 只看**那一刻**在线的节点；若无人在线即落 `pending`。
 * 没有本函数，`pending` 就是**死档**——先在线的一方永远等不到后来上线的工蚁（状态机名存实亡）。
 * 认领判据与 `selectTargetNode` 同源（active ∧ participate ∧ 非观察者 ∧ 卡类目命中），不另写一套。
 */
function claimPendingForNode(db: Database.Database, nodeId: string): number {
  const node = db
    .prepare(
      "SELECT card_json FROM ans_nodes WHERE node_id = ? AND status = 'active' AND participate = 1 AND role != 'observer'",
    )
    .get(nodeId) as { card_json: string } | undefined;
  if (!node) return 0;
  // ⚠ `card_json` 是**对象**（`{name,node_id,platform,categories}`），不是裸数组——类目在 `$.categories`。
  // 与 `selectTargetNode` 的 `json_each(card_json, '$.categories')` 同源；此处把裸 `jsonArray` 误用在
  // 对象上会恒取到 `[]` ⇒ 一个积压件也认领不了（M12-④ 判据正是照这个的）。
  const card = jsonObject(node.card_json);
  const cats = card && Array.isArray(card.categories) ? card.categories.filter(isNodeCardCategory) : [];
  if (cats.length === 0) return 0;
  const placeholders = cats.map(() => '?').join(', ');
  const r = db
    .prepare(
      `UPDATE ans_node_requests SET target_node_id = ?, status = 'assigned'
     WHERE status = 'pending' AND category IN (${placeholders})`,
    )
    .run(nodeId, ...cats);
  return r.changes;
}

/**
 * 公开：**令牌换 key**。体校验令牌（存在/未过期/未用尽）→ 签发绑定本节点的 key（K-5）→ 落 `ans_nodes`。
 * 三段校验合在**一个事务**里：并发两次用同一枚一次性令牌，须恰好一次成功（`used_count` 自增与判活同批）。
 */
export function nodeEnrollRoute(db: Database.Database) {
  const keyManager = new ApiKeyManager(db);

  return new Elysia({ prefix: '/api/v1/nodes' }).post(
    '/register',
    ({ body, set }) => {
      const result = db.transaction(() => {
        const tok = db
          .prepare(
            `SELECT token, max_uses, used_count,
                  CASE WHEN expires_at IS NOT NULL AND expires_at <= datetime('now') THEN 1 ELSE 0 END AS expired
           FROM ans_enrollment_tokens WHERE token = ?`,
          )
          .get(body.enrollment_token) as
          | { token: string; max_uses: number; used_count: number; expired: number }
          | undefined;
        // 三支各自一句文案（排查时是三件事；合成一个 403 就只能靠猜）。
        if (!tok) throw new AppError(ErrorCode.FORBIDDEN, 'Invalid enrollment token', 403);
        if (tok.expired === 1) throw new AppError(ErrorCode.FORBIDDEN, 'Enrollment token expired', 403);
        if (tok.used_count >= tok.max_uses) throw new AppError(ErrorCode.FORBIDDEN, 'Enrollment token exhausted', 403);

        if (db.prepare('SELECT node_id FROM ans_nodes WHERE node_id = ?').get(body.node_id)) {
          throw conflict(`Node already registered: ${body.node_id}`);
        }

        const role = isNodeRole(body.role) ? body.role : DEFAULT_NODE_ROLE;
        const resourceGroup = `node:${body.node_id}`;
        const { apiKey, secret } = keyManager.createApiKey(body.name ?? body.node_id, [resourceGroup]);

        db.prepare(
          `INSERT INTO ans_nodes
             (id, node_id, name, api_key_prefix, resource_group, platform, role, weight, participate, capabilities_json, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          body.node_id,
          body.name ?? '',
          apiKey.slice(0, 8),
          resourceGroup,
          body.platform ?? '',
          role,
          1.0,
          body.participate === false ? 0 : 1,
          JSON.stringify(body.capabilities ?? []),
          'active',
        );
        db.prepare('UPDATE ans_enrollment_tokens SET used_count = used_count + 1 WHERE token = ?').run(
          body.enrollment_token,
        );

        return { node_id: body.node_id, api_key: apiKey, secret, resource_group: resourceGroup };
      })();

      set.status = 201;
      return result;
    },
    {
      body: t.Object({
        enrollment_token: t.String(),
        node_id: t.String(),
        name: t.Optional(t.String()),
        platform: t.Optional(t.String()),
        role: t.Optional(t.String()),
        capabilities: t.Optional(t.Array(t.String())),
        // zx_20261011_1 M1：缺省 `true`（老客户端不带 ⇒ 落 1，向后兼容；见 shared-types 注释）。
        participate: t.Optional(t.Boolean()),
      }),
    },
  );
}

/** HMAC：心跳 / 列表 / 改档 / 删除 / 令牌台。 */
export function nodesRoutes(db: Database.Database) {
  // zx_20261011_3：删除节点时吊销其 key 用（`ApiKeyManager` 构造器负责建表，幂等）。
  const keyManager = new ApiKeyManager(db);
  return (
    new Elysia({ prefix: '/api/v1/nodes' })
      // 心跳：更新环境/负载快照与 last_seen_at。未注册节点 ⇒ 404（"认不得的节点"不是"已收到"）。
      .post(
        '/heartbeat',
        ({ body }) => {
          const sets = ["last_seen_at = datetime('now')"];
          const args: Array<string | number> = [];
          if (body.status !== undefined) {
            sets.push('status_json = ?');
            args.push(JSON.stringify(body.status));
          }
          if (body.card !== undefined) {
            sets.push('card_json = ?');
            args.push(JSON.stringify(body.card));
          }
          args.push(body.node_id);
          const r = db.prepare(`UPDATE ans_nodes SET ${sets.join(', ')} WHERE node_id = ?`).run(...args);
          if (r.changes === 0) throw notFound('Node', body.node_id);
          const row = db.prepare('SELECT * FROM ans_nodes WHERE node_id = ?').get(body.node_id) as NodeRow;
          return { data: toNode(row) };
        },
        {
          body: t.Object({
            node_id: t.String(),
            status: t.Optional(t.Any()),
            card: t.Optional(t.Any()),
          }),
        },
      )
      // 列表（分页；缺省只列 active，`?all=1` 含已吊销）。
      .get('/', ({ query }) => {
        const includeAll = (query as Record<string, unknown> | undefined)?.all === '1';
        const filter = includeAll ? '' : "WHERE status = 'active'";
        const page = parsePagination(query as Record<string, unknown>);
        const total = (db.prepare(`SELECT COUNT(*) AS c FROM ans_nodes ${filter}`).get() as { c: number }).c;
        const rows = db
          .prepare(`SELECT * FROM ans_nodes ${filter} ORDER BY enrolled_at DESC${paginationClause(page)}`)
          .all(...paginationArgs(page)) as NodeRow[];
        return { data: rows.map(toNode), ...pageMeta(total, page, rows.length) };
      })
      // 改档：`id` 指 **node_id**（客户端手上的是它，不是内部 UUID）。
      .patch(
        '/:nodeId',
        ({ params: { nodeId }, body, request }) => {
          // zx_20261017_1 批四（毛选·谁是我们的敌人 / 维特根斯坦·意义即使用）：**改档须有资格**。
          //   此前 PATCH 只校验体、不校验调用方 ⇒ 网络内任一节点都能改他机档位（谁是主节点可由任何一个
          //   `worker` 自己改写）。三档判定，次序即语义：
          //     ① 身份**由凭据派生**（`deriveRequesterNodeId`，不信 body）——非节点终端（null）一律 403；
          //     ② 本机改自己放行（worker 也能调自己的权重/参与，这是"我的机器我说了算"）；
          //     ③ 改他机须 `canDispatch`（primary/observer）——worker 只接不分，同样不该分权。
          const requesterNodeId = deriveRequesterNodeId(db, request);
          if (!requesterNodeId) {
            throw new AppError(ErrorCode.FORBIDDEN, 'Only enrolled nodes can modify node settings', 403);
          }
          const row = db.prepare('SELECT * FROM ans_nodes WHERE node_id = ?').get(nodeId) as NodeRow | undefined;
          if (!row) throw notFound('Node', nodeId);
          if (requesterNodeId !== nodeId) {
            const requester = db.prepare('SELECT role FROM ans_nodes WHERE node_id = ?').get(requesterNodeId) as
              | { role?: string }
              | undefined;
            if (!requester || !isNodeRole(requester.role)) {
              throw new AppError(ErrorCode.FORBIDDEN, `Requester ${requesterNodeId} is not an active node`, 403);
            }
            if (!canDispatch({ role: requester.role })) {
              throw new AppError(
                ErrorCode.FORBIDDEN,
                `Node ${requesterNodeId} is a worker (receive-only) and cannot modify peer node settings`,
                403,
              );
            }
          }
          if (body.role !== undefined && !isNodeRole(body.role)) {
            throw new AppError(ErrorCode.INVALID_REQUEST, `Invalid node role: ${String(body.role)}`, 400);
          }
          const sets: string[] = [];
          const args: Array<string | number> = [];
          if (body.name !== undefined) {
            sets.push('name = ?');
            args.push(body.name);
          }
          if (body.role !== undefined) {
            sets.push('role = ?');
            args.push(body.role);
          }
          if (body.weight !== undefined) {
            sets.push('weight = ?');
            args.push(body.weight);
          }
          if (body.participate !== undefined) {
            sets.push('participate = ?');
            args.push(body.participate ? 1 : 0);
          }
          if (sets.length > 0) {
            args.push(nodeId);
            db.prepare(`UPDATE ans_nodes SET ${sets.join(', ')} WHERE node_id = ?`).run(...args);
          }
          return { data: toNode(db.prepare('SELECT * FROM ans_nodes WHERE node_id = ?').get(nodeId) as NodeRow) };
        },
        {
          body: t.Object({
            name: t.Optional(t.String()),
            role: t.Optional(t.String()),
            weight: t.Optional(t.Number()),
            participate: t.Optional(t.Boolean()),
          }),
        },
      )
      // zx_20261011_3（老子·知止 / 维特根斯坦·意义即使用）: **删除离线节点**——把退场/换机/长期离线的
      //   工蚁行从台账里清出去（此前只增不减，面板成了只进不出的名单）。语义**硬删 + 吊销该节点 key**：
      //   - 硬删（非软删）：注册路由的重复判据不看 `status`（见 `nodeEnrollRoute`）⇒ 软删会让同一 `node_id`
      //     **永久**不能再注册，且其心跳 `UPDATE … WHERE node_id=?` 会命中该行而回 200（**假的成功**）却永不进
      //     列表。硬删则"回来 ⇒ 重新注册"即恢复，语义干净。
      //   - 吊销 key：入网后 `ans_api_key` 就是该节点自己的 key ⇒ 吊销即"这台机器被移出网络"（后续全 401，响得响）。
      //   守卫三条（**次序即判据**，各一句文案）：不存在 404 / 自删 400 / 在线 409（复用 `NODE_OFFLINE_SEC` 同一把尺）。
      .delete('/:nodeId', ({ params: { nodeId }, request }) => {
        const row = db.prepare('SELECT * FROM ans_nodes WHERE node_id = ?').get(nodeId) as NodeRow | undefined;
        if (!row) throw notFound('Node', nodeId);
        // 自删：删自己 = 退出协同网络（且会吊销自己的凭据）——与"清理他机"是两件事。身份**由凭据派生**
        //   （不信路径，承 `deriveRequesterNodeId` 口径）⇒ 冒名无从下手。
        if (deriveRequesterNodeId(db, request) === nodeId) {
          throw new AppError(ErrorCode.INVALID_REQUEST, `Node ${nodeId} cannot remove itself`, 400);
        }
        // 在线不可删：对方仍在网（心跳在窗口内）——删了它下一拍即回，且删完对方立刻大面积 401，语义混乱。
        const onlineMod = `-${NODE_OFFLINE_SEC} seconds`;
        const online = db
          .prepare(
            "SELECT 1 FROM ans_nodes WHERE node_id = ? AND last_seen_at IS NOT NULL AND last_seen_at > datetime('now', ?) LIMIT 1",
          )
          .get(nodeId, onlineMod);
        if (online) throw conflict(`Node ${nodeId} is online and cannot be removed (offline only)`);
        const requeued = db.transaction(() => {
          // ① 解套停滞请求：把该节点名下**非终态**的件退回可再派（`claimPendingForNode` 只做 `pending→assigned`，
          //    不退则这批件永远卡在"待回"，派活方轮询到天荒地老）。终态（done/error）行**不动**——那是历史账。
          const n = db
            .prepare(
              `UPDATE ans_node_requests
                    SET status = 'pending', target_node_id = NULL, question_json = NULL,
                        answer_json = NULL, question_status = NULL, claimed_at = NULL
                  WHERE target_node_id = ? AND status IN ('assigned', 'awaiting_answer')`,
            )
            .run(nodeId).changes;
          // ② 吊销该节点 key——此后它的 HMAC 一律 401（"被移出网络"的诚实语义）。
          keyManager.revokeApiKey(row.api_key_prefix);
          // ③ 硬删台账行——"回来 ⇒ 重新注册"即恢复。
          db.prepare('DELETE FROM ans_nodes WHERE node_id = ?').run(nodeId);
          return n;
        })();
        return { data: { node_id: nodeId, removed: true, key_revoked: true, requeued } };
      })
      // ==================== M12 中转队列（AI 终端 → ANS → 工蚁 → 回传） ====================
      // 提交：AI 终端凭**自己的 key** 提交类目级请求；ANS 按 role/weight/participate/online 选目标。
      // 无合适节点 ⇒ 落 `pending`（`target_node_id NULL`）——不伪造一个目标。
      // zx_20261011 M1/M2：请求方身份**由凭据派生**（不信 body）；可**手动指定目标**（同源判据校验，不合格 400）。
      .post(
        '/requests',
        ({ body, request, set }) => {
          if (!isNodeCardCategory(body.category)) {
            throw new AppError(ErrorCode.INVALID_REQUEST, `Invalid request category: ${body.category}`, 400);
          }
          // zx_20261011_1 M3（C2/M9 角色语义 · 毛泽东《中国社会各阶级的分析》）: **派发侧也要看角色**——
          //   此前只有接收侧 `isDispatchable` 闸，派发侧谁都放行 ⇒ `worker`（只接不分）也能派。
          //   判据取**凭据派生**的请求方身份（不信 body，承 zx_20261011 M1）⇒ 查该节点 role，`worker` ⇒ 400。
          //   ⚠ **非节点终端**（无 `requester_node_id`）**不受此闸**：AI 终端没有 role，另面（承 §1.3）。
          const requesterNodeId = deriveRequesterNodeId(db, request);
          if (requesterNodeId) {
            const rrow = db.prepare('SELECT role FROM ans_nodes WHERE node_id = ?').get(requesterNodeId) as
              | { role?: string }
              | undefined;
            if (rrow && isNodeRole(rrow.role) && !canDispatch({ role: rrow.role })) {
              throw new AppError(
                ErrorCode.INVALID_REQUEST,
                `Node ${requesterNodeId} is a worker (receive-only) and cannot dispatch`,
                400,
              );
            }
          }
          // 手动指定目标：以 `nodeQualifies`（与自动选**同源**）校验——不合格**如实拒绝**，不静默改派。
          let target: { row: NodeRow; selection: SelectionSnapshot } | null;
          if (body.target_node_id !== undefined) {
            const wanted = String(body.target_node_id);
            if (!nodeQualifies(db, wanted, body.category)) {
              throw new AppError(
                ErrorCode.INVALID_REQUEST,
                `Target node ${wanted} cannot take category ${body.category} (not dispatchable/offline/card-miss)`,
                400,
              );
            }
            const manualRow = db.prepare('SELECT * FROM ans_nodes WHERE node_id = ?').get(wanted) as NodeRow;
            // 手动目标也留一份快照（同一 explain 口径），理由前缀标明「手动指定」，
            // 免得事后读 `selection_json` 误以为是自动择机的结果。
            const snapshot = describeNode({
              node_id: manualRow.node_id,
              weight: manualRow.weight,
              status_json: manualRow.status_json,
              last_seen_at: manualRow.last_seen_at,
            });
            target = { row: manualRow, selection: { ...snapshot, reason: `手动指定：${snapshot.reason}` } };
          } else {
            target = selectTargetNode(db, body.category);
          }
          // zx_20261017_1 批一：自动外派路径**无目标即拒**（409，不落行）——这类调用方本机仍会
          //   本地执行，若留一张 pending 单，后到的节点把它接走就成重复执行。人手派活不置此位，语义不变。
          if (!target && body.require_target === true) {
            throw new AppError(
              ErrorCode.CONFLICT,
              `No dispatchable node for category ${body.category}; require_target refuses to queue a pending request`,
              409,
            );
          }
          const id = randomUUID();
          db.prepare(
            `INSERT INTO ans_node_requests
               (id, category, payload_json, requester_key_prefix, requester_node_id, target_node_id, status, selection_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            body.category,
            JSON.stringify(body.payload ?? {}),
            callerKeyPrefix(request),
            requesterNodeId,
            target?.row.node_id ?? null,
            target ? 'assigned' : 'pending',
            target ? JSON.stringify(target.selection) : null,
          );
          const row = db.prepare('SELECT * FROM ans_node_requests WHERE id = ?').get(id) as NodeRequestRow;
          set.status = 201;
          return { data: toNodeRequest(row) };
        },
        {
          body: t.Object({
            category: t.String(),
            payload: t.Optional(t.Any()),
            target_node_id: t.Optional(t.String()),
            require_target: t.Optional(t.Boolean()),
          }),
        },
      )
      // zx_20261011 M1：**请求方读回**（闭环的另一半）。此前只有 `GET /requests?node_id=`（被派方读待办），
      //   全仓无"请求方读自己派的那一件"的路 ⇒ 派活的人看不到结果。鉴权两条，任一即通过：
      //     ① 调用方 key 的资源组含 `node:<requester_node_id>`（请求方本身就是那台工蚁）；
      //     ② 调用方 key 前缀 === `requester_key_prefix`（非节点终端持原 key 读回自身请求的退路）。
      //   二者皆无 ⇒ 403（读不到 ≠ 猜得到；承"无知之幕"）。⚠ 前缀仅 8 位可撞，属已知弱点，待 C3 终端台账收紧。
      .get('/requests/:id', ({ params: { id }, request }) => {
        const row = db.prepare('SELECT * FROM ans_node_requests WHERE id = ?').get(id) as NodeRequestRow | undefined;
        if (!row) throw notFound('Node request', id);
        const groups = getResourceGroupsFromApiKey(db, request);
        const byNode = row.requester_node_id != null && groups.includes(`node:${row.requester_node_id}`);
        // M4：**目标节点也可读**——B 端（被派方）要轮询自己那一单的作答（`question_status='answered'`）。
        //   边界的道理：请求的**两方**（派活方 A 与执行方 B）都已知这一单，读它不越"无知之幕"（第三方仍 403）。
        const byTarget = row.target_node_id != null && groups.includes(`node:${row.target_node_id}`);
        // zx_20261018_3 批三（管子·度量衡）：前缀兜底**只给没有节点身份的请求方**（`requester_node_id IS NULL`，
        //   如 dev 直连 key）。请求方有节点身份时，8 位前缀可撞 ⇒ 同前缀的另一台节点能读走别人的单。
        //   有身份就只认身份（`node:<requester_node_id>`），兜底不得把身份闸架空。
        const byPrefix =
          row.requester_node_id == null &&
          row.requester_key_prefix !== '' &&
          callerKeyPrefix(request) === row.requester_key_prefix;
        if (!byNode && !byTarget && !byPrefix) {
          throw new AppError(ErrorCode.FORBIDDEN, `Key is not a party to request ${id}`, 403);
        }
        return { data: toNodeRequest(row) };
      })
      // 拉取：工蚁心跳周期拉**派给自己的** assigned 件。**越权防线**：调用方 key 的资源组须含
      // `node:<node_id>` —— 否则别的节点只要在 query 里换个 node_id 就能读走他人待办。
      // 首次拉到即记 `claimed_at`（COALESCE 幂等：不覆盖首拉时刻）——M13 据此算耗时。
      .get('/requests', ({ query, request }) => {
        const nodeId = String((query as Record<string, unknown> | undefined)?.node_id ?? '');
        if (!nodeId) throw new AppError(ErrorCode.INVALID_REQUEST, 'node_id is required', 400);
        const groups = getResourceGroupsFromApiKey(db, request);
        if (!groups.includes(`node:${nodeId}`)) {
          throw new AppError(ErrorCode.FORBIDDEN, `Key is not bound to node ${nodeId}`, 403);
        }
        // 先认领积压的 pending 件（`pending → assigned`），再回本节点的 assigned 件。
        claimPendingForNode(db, nodeId);
        db.prepare(
          "UPDATE ans_node_requests SET claimed_at = COALESCE(claimed_at, datetime('now')) WHERE target_node_id = ? AND status = 'assigned'",
        ).run(nodeId);
        const rows = db
          .prepare(
            "SELECT * FROM ans_node_requests WHERE target_node_id = ? AND status = 'assigned' ORDER BY created_at ASC",
          )
          .all(nodeId) as NodeRequestRow[];
        return { data: rows.map(toNodeRequest) };
      })
      // 回传：**越权防线**双校验——`target_node_id === node_id` **且** 调用方 key 的资源组含
      // `node:<node_id>`。二者缺一即 403（非目标节点不得回传，即便猜中 id）。
      .post(
        '/requests/:id/result',
        ({ params: { id }, body, request }) => {
          const row = db.prepare('SELECT * FROM ans_node_requests WHERE id = ?').get(id) as NodeRequestRow | undefined;
          if (!row) throw notFound('Node request', id);
          const groups = getResourceGroupsFromApiKey(db, request);
          if (row.target_node_id !== body.node_id || !groups.includes(`node:${body.node_id}`)) {
            throw new AppError(ErrorCode.FORBIDDEN, `Node ${body.node_id} is not the target of request ${id}`, 403);
          }
          // zx_20261011_1 M2（C2/M8 协议加固 · 老子·知止）: **终态一次**——已收口的件**不再被重复投递改写**。
          //   病根：网络重试/心跳重投会让同一件回传两次，旧实现每次都 `UPDATE … done_at = now()` ⇒
          //   ①结果被**迟到的第二笔覆写**（`error` 后一记 `done` 就翻案）；②`done_at` 被刷新（耗时统计失真）。
          //   ⚠ 双校验（403）**先跑**——非目标节点的重复投递仍是 403，幂等守卫只对**已通过双校验**者生效。
          if (row.status === 'done' || row.status === 'error' || row.status === 'cancelled') {
            return { data: toNodeRequest(row) }; // 原样回既有结果；不 UPDATE（首次终态即定，重复不产生第二条）
          }
          const result = body.result === undefined ? null : JSON.stringify(body.result);
          db.prepare(
            "UPDATE ans_node_requests SET status = ?, result_json = ?, done_at = datetime('now') WHERE id = ?",
          ).run(body.status, result, id);
          const updated = db.prepare('SELECT * FROM ans_node_requests WHERE id = ?').get(id) as NodeRequestRow;
          return { data: toNodeRequest(updated) };
        },
        {
          body: t.Object({
            node_id: t.String(),
            // zx_20261030_1 M3：执行方收到叫停后回传 `cancelled`（既非完成也非失败）。
            status: t.Union([t.Literal('done'), t.Literal('error'), t.Literal('cancelled')]),
            result: t.Optional(t.Any()),
          }),
        },
      )
      // zx_20261030_1 M2「见」: **进度上报**（B 端＝被派方，跑一步报一步）。
      //   双校验与回传端**同形**（`target_node_id === node_id` ∧ 资源组含 `node:<node_id>`）——
      //   进度也是"这件活的执行方才知道的事"，非目标节点不得代报。
      //   ⚠ **终态不因迟到进度翻案**：已 `done`/`error` 的件收到进度 ⇒ 原样回既有行（200，不 4xx）——
      //     对端收尾瞬间的在途上报不该被读成错误；但也**不覆盖**已有进度（收口之后没有"进行中"可言）。
      //   ⚠ 只存快照，不做节流：节流是上报方（runner）的责任（每 ≤2s 一次）；此处若再丢，就分不清
      //     "对端没报"与"被服务端吞了"。
      .post(
        '/requests/:id/progress',
        ({ params: { id }, body, request }) => {
          const row = db.prepare('SELECT * FROM ans_node_requests WHERE id = ?').get(id) as NodeRequestRow | undefined;
          if (!row) throw notFound('Node request', id);
          const groups = getResourceGroupsFromApiKey(db, request);
          if (row.target_node_id !== body.node_id || !groups.includes(`node:${body.node_id}`)) {
            throw new AppError(ErrorCode.FORBIDDEN, `Node ${body.node_id} is not the target of request ${id}`, 403);
          }
          if (row.status === 'done' || row.status === 'error' || row.status === 'cancelled')
            return { data: toNodeRequest(row) };
          if (!Number.isInteger(body.step) || body.step < 0) {
            throw new AppError(ErrorCode.INVALID_REQUEST, `Invalid progress step: ${body.step}`, 400);
          }
          if (body.total !== undefined && body.total !== null && (!Number.isInteger(body.total) || body.total < 0)) {
            throw new AppError(ErrorCode.INVALID_REQUEST, `Invalid progress total: ${body.total}`, 400);
          }
          const at = (db.prepare("SELECT datetime('now') AS at").get() as { at: string }).at;
          const progress = {
            step: body.step,
            total: typeof body.total === 'number' ? body.total : null,
            note: typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '',
            at,
          };
          db.prepare('UPDATE ans_node_requests SET progress_json = ? WHERE id = ?').run(JSON.stringify(progress), id);
          return {
            data: toNodeRequest(db.prepare('SELECT * FROM ans_node_requests WHERE id = ?').get(id) as NodeRequestRow),
          };
        },
        {
          body: t.Object({
            node_id: t.String(),
            step: t.Number(),
            total: t.Optional(t.Union([t.Number(), t.Null()])),
            note: t.Optional(t.String()),
          }),
        },
      )
      // zx_20261030_1 M3「止」: **请求停止**（A 端＝派活方叫停）。
      //   鉴权与**作答端同源**（`node:<requester_node_id>` ∨ 无节点身份时的 key 前缀兜底）——
      //   停是自己的决定，只有请求方谈得上；目标节点也**不能**替派活方叫停别人的单。
      //   两档处置（按 row 此刻的真实状态，不猜）：
      //     ① 已终态（done/error/cancelled）⇒ 200 原样回既有（幂等；不翻案）；
      //     ② `pending`（尚无执行方在跑）⇒ **直接置 `cancelled`**（没有执行体需要通知，立即收口）；
      //     ③ `assigned`/`awaiting_answer`（执行方在跑）⇒ 只置 `cancel_requested=1`、**状态不动**：
      //        真停由执行方在检查点完成并回传 `cancelled`。旧版本执行方不读该位 ⇒ 会跑完，
      //        此时 `status` 仍是它回传的真实结局（done/error）——界面据此如实说话，不假设"点了就停"。
      .post('/requests/:id/cancel', ({ params: { id }, request }) => {
        const row = db.prepare('SELECT * FROM ans_node_requests WHERE id = ?').get(id) as NodeRequestRow | undefined;
        if (!row) throw notFound('Node request', id);
        const groups = getResourceGroupsFromApiKey(db, request);
        const byNode = row.requester_node_id != null && groups.includes(`node:${row.requester_node_id}`);
        const byPrefix =
          row.requester_node_id == null &&
          row.requester_key_prefix !== '' &&
          callerKeyPrefix(request) === row.requester_key_prefix;
        if (!byNode && !byPrefix) {
          throw new AppError(ErrorCode.FORBIDDEN, `Key is not the requester of request ${id}`, 403);
        }
        if (row.status === 'done' || row.status === 'error' || row.status === 'cancelled') {
          return { data: toNodeRequest(row) };
        }
        if (row.status === 'pending') {
          db.prepare(
            "UPDATE ans_node_requests SET status = 'cancelled', cancel_requested = 1, done_at = datetime('now') WHERE id = ?",
          ).run(id);
        } else {
          db.prepare('UPDATE ans_node_requests SET cancel_requested = 1 WHERE id = ?').run(id);
        }
        return {
          data: toNodeRequest(db.prepare('SELECT * FROM ans_node_requests WHERE id = ?').get(id) as NodeRequestRow),
        };
      })
      // ==================== M4 双向澄清（B 端提问 / A 端作答，两跳） ====================
      // 新跳① 提问（B 端＝被派的中继执行体）：**双校验同形**（与回传端一致）——`target_node_id === node_id`
      //   且调用方 key 的资源组含 `node:<node_id>`。前置 `status='assigned'`（已认领、跑在手上才谈得上提问）；
      //   落 `question_json` 与 `question_status='asked'`，并把请求转 `awaiting_answer`（等派活方答）。
      .post(
        '/requests/:id/question',
        ({ params: { id }, body, request }) => {
          const row = db.prepare('SELECT * FROM ans_node_requests WHERE id = ?').get(id) as NodeRequestRow | undefined;
          if (!row) throw notFound('Node request', id);
          const groups = getResourceGroupsFromApiKey(db, request);
          if (row.target_node_id !== body.node_id || !groups.includes(`node:${body.node_id}`)) {
            throw new AppError(ErrorCode.FORBIDDEN, `Node ${body.node_id} is not the target of request ${id}`, 403);
          }
          // 只有"跑在手上（assigned）"才谈得上提问——终态/已答/待分配一律如实拒（不把状态机搅乱）。
          if (row.status !== 'assigned') {
            throw new AppError(
              ErrorCode.INVALID_REQUEST,
              `Request ${id} is not in 'assigned' state (now '${row.status}')`,
              400,
            );
          }
          const question = {
            question: body.question,
            ...(body.options !== undefined ? { options: body.options } : {}),
          };
          db.prepare(
            "UPDATE ans_node_requests SET status = 'awaiting_answer', question_json = ?, answer_json = NULL, question_status = 'asked' WHERE id = ?",
          ).run(JSON.stringify(question), id);
          return {
            data: toNodeRequest(db.prepare('SELECT * FROM ans_node_requests WHERE id = ?').get(id) as NodeRequestRow),
          };
        },
        {
          body: t.Object({
            node_id: t.String(),
            question: t.String(),
            options: t.Optional(t.Array(t.String())),
          }),
        },
      )
      // 新跳② 作答（A 端＝派活方）：鉴权与**读回端同源**（`node:<requester_node_id>` ∨ key 前缀）。
      //   前置 `question_status='asked'`；落 `answer_json` 与 `question_status='answered'`，并把请求转回 `assigned`
      //   （工蚁可继续跑）。**幂等**：已答的重复作答 ⇒ 200 + 既有（不覆盖上次的答案、状态不再翻动）。
      .post(
        '/requests/:id/answer',
        ({ params: { id }, body, request }) => {
          const row = db.prepare('SELECT * FROM ans_node_requests WHERE id = ?').get(id) as NodeRequestRow | undefined;
          if (!row) throw notFound('Node request', id);
          const groups = getResourceGroupsFromApiKey(db, request);
          const byNode = row.requester_node_id != null && groups.includes(`node:${row.requester_node_id}`);
          // zx_20261018_3 批三：与读回端**同一把尺**——请求方有节点身份时不再接受前缀兜底（8 位可撞）。
          const byPrefix =
            row.requester_node_id == null &&
            row.requester_key_prefix !== '' &&
            callerKeyPrefix(request) === row.requester_key_prefix;
          if (!byNode && !byPrefix) {
            throw new AppError(ErrorCode.FORBIDDEN, `Key is not the requester of request ${id}`, 403);
          }
          // 幂等：已作答 ⇒ 原样回既有（不改 answer、不再翻状态）。
          if (row.question_status === 'answered') return { data: toNodeRequest(row) };
          // zx_20261011_2 D10（老子·知止 / 名实）: **终态不可复活**——与 `/result` 的"终态一次"守卫对称。
          //   病根（实机坐实）：一件 `done ∧ question_status='asked'`（B 未获作答、自决收口）的单子，
          //   此前仍可被作答：本路由把它置回 `status='assigned'` ⇒ worker 重拉 ⇒ **把一件已完成的活重跑一遍**。
          //   次序即判据：**已答**的重投仍在上一步幂等 200（答案确已落地，不该因收口而报错）；
          //   只有**未答**的终态件才落到这里被挡（那正是"复活"路径）。`/question` 已要求 `assigned`，无需同步加闸。
          if (row.status === 'done' || row.status === 'error' || row.status === 'cancelled') {
            throw new AppError(
              ErrorCode.INVALID_REQUEST,
              `Request ${id} is already terminal ('${row.status}') — its question can no longer be answered`,
              400,
            );
          }
          if (row.question_status !== 'asked') {
            throw new AppError(ErrorCode.INVALID_REQUEST, `Request ${id} has no pending question to answer`, 400);
          }
          db.prepare(
            "UPDATE ans_node_requests SET status = 'assigned', answer_json = ?, question_status = 'answered' WHERE id = ?",
          ).run(JSON.stringify({ answer: body.answer }), id);
          return {
            data: toNodeRequest(db.prepare('SELECT * FROM ans_node_requests WHERE id = ?').get(id) as NodeRequestRow),
          };
        },
        {
          body: t.Object({ answer: t.String() }),
        },
      )
      // 令牌台（HMAC）：签发 / 列表 / 吊销。
      .post(
        '/enrollment-tokens',
        ({ body, set }) => {
          const token = generateApiKey('enr');
          const maxUses = body.max_uses ?? 1;
          const sec = body.expires_in_sec ?? null;
          // 修饰串在 JS 侧成形（`+30 seconds` / `-10 seconds`）——SQLite 的 `datetime('now', ?)` 只认良构修饰，
          // 把裸数字拼成 '+<n> seconds' 在 n 为负时会成 '+-10 seconds'（不可解析 ⇒ expires_at 落 NULL）。
          const mod = sec === null ? null : `${sec < 0 ? '-' : '+'}${Math.abs(sec)} seconds`;
          db.prepare(
            `INSERT INTO ans_enrollment_tokens (token, created_by, note, max_uses, expires_at)
         VALUES (?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END)`,
          ).run(token, body.created_by ?? 'api', body.note ?? '', maxUses, mod, mod);
          const row = db
            .prepare(
              'SELECT token, created_by, note, max_uses, used_count, expires_at, created_at FROM ans_enrollment_tokens WHERE token = ?',
            )
            .get(token);
          set.status = 201;
          return { data: row };
        },
        {
          body: t.Object({
            note: t.Optional(t.String()),
            created_by: t.Optional(t.String()),
            max_uses: t.Optional(t.Number()),
            expires_in_sec: t.Optional(t.Number()),
          }),
        },
      )
      .get('/enrollment-tokens', () => {
        const rows = db
          .prepare(
            'SELECT token, created_by, note, max_uses, used_count, expires_at, created_at FROM ans_enrollment_tokens ORDER BY created_at DESC',
          )
          .all();
        return { data: rows };
      })
      .delete('/enrollment-tokens/:token', ({ params: { token } }) => {
        const r = db.prepare('DELETE FROM ans_enrollment_tokens WHERE token = ?').run(token);
        if (r.changes === 0) throw notFound('Enrollment token', token);
        return { data: { token, revoked: true } };
      })
  );
}
