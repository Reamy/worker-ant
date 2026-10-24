/**
 * zx_20261011 M3（王阳明·知行合一 / 维特根斯坦·意义即使用）: 工蚁**派活出去**的核心。
 *
 * 病根（`zx_20261011` §1.1）：接收侧（拉待办 → 本地跑 → 回传）此前已齐备（M12），但**发送侧零调用**——
 *   工蚁桌面**从不主动派活**。"派活"这个能力写在类型里、写在面板上，却没有任何一行代码真的去派
 *   ⇒ 名存实亡（"意义即使用"：一个从不被使用的动词，等于没有这个动词）。
 *
 * 本模块只补**发送侧**：把"这台工蚁要派一单活给网络里的某台工蚁"变成一个动作。三件事：
 *   ① **未入网 ⇒ 如实拒**（`not-enrolled`）：没有身份就没有读回凭据；派发方**必须**是节点
 *      ⇒ 桌面↔桌面是**对等**派发（承 `zx_20261010_1` 的入网门——不是节点就别谈读回）。
 *   ② 经注入的 `DispatchIo` 提交 ⇒ 成功则 emit 本地事件 `node.request_dispatched`（出站台账的到场）。
 *   ③ 读回（`refreshDispatchResult`）⇒ 终态则 emit `node.request_result`（出站台账的收口）。
 *
 * ⚠ 本模块**不触网**：`io` 与 `emit` 皆可注入（真机＝`makeAnsDispatchIo` / `eventBus.emit`；回归喂假），
 *   正因如此受控回归能不出网跑真逻辑（同 `node-request-worker.ts` 的纪律）。
 * ⚠ **永不抛**：失败装进 `{ ok:false, note }`（`ansFailureNote` 形状），由调用方（IPC）如实上屏。
 * ⚠ 目标节点 id **由 ANS 定**（自动选）或调用方**显式指定**；本模块不自己算一份候选（承"一个规则一处"）。
 */
import type Database from 'better-sqlite3';
import { isNodeEnrolled } from './node-heartbeat.js';
import { NODE_SETTING_KEYS, readNodeSetting, type NodeSettingDb } from './node-identity.js';
import { recordAudit, type AuditDb } from './audit-log.js';
import { DEFAULT_NODE_ROLE, canDispatch, isNodeRole, type AnsNodeRequest, type NodeRequestSubmit, type NodeRequestStatus } from '@worker-ant/shared-types';

/**
 * 提交 / 读回接口（**消费者处定义**，同 `RequestIo` 于 `node-request-worker.ts` 的范式）。
 * 真实现＝`makeAnsDispatchIo`（`node-dispatch-io.ts`，唯一触网处）；回归喂假。
 */
export interface DispatchIo {
  /** `POST /api/v1/nodes/requests` —— 提交一单，**抛**于失败/无 data。 */
  submit(req: NodeRequestSubmit): Promise<AnsNodeRequest>;
  /** `GET /api/v1/nodes/requests/:id` —— 读回（请求方鉴权），**抛**于失败/无 data。 */
  get(id: string): Promise<AnsNodeRequest>;
  /**
   * zx_20261011_1 M4: `POST /api/v1/nodes/requests/:id/answer` —— 派活方**作答**B 端的一问，
   *   转回 `assigned`（B 端可继续跑），**抛**于失败/无 data。
   */
  answer(id: string, answer: string): Promise<AnsNodeRequest>;
}

/** 事件出口（真机＝`eventBus.emit`；回归喂假）——与 `NodeRequestWorkerOpts.onEvent` 同一手法。 */
export type DispatchEventSink = (
  type: 'node.request_dispatched' | 'node.request_result' | 'node.request_question' | 'node.request_answered',
  data: Record<string, unknown>,
) => unknown;

export interface DispatchOpts {
  /** 注入 IO（缺省懒建真实现 `makeAnsDispatchIo(db)`）。 */
  io?: DispatchIo;
  /** 注入事件出口（缺省懒取 `eventBus.emit`）。 */
  emit?: DispatchEventSink;
}

/** 派发入参（IPC / rr 共用；**类目级**，承 K-10）。 */
export interface DispatchInput {
  category: string;
  payload?: Record<string, unknown>;
  /** 留空 = ANS 自动选；给定 = 手动指定（ANS 校验，不合格则失败）。 */
  targetNodeId?: string;
  /**
   * zx_20261017_1 批一：**必须有确定目标**才落单。自动外派路径置 `true` ⇒ ANS 无合格目标时
   *   409 且**不落 pending 行**——否则一张无人认领的单可能被后到的节点接走，与本机重复执行。
   *   人手「派活」卡**不置**此位（保留既有"无目标即挂起，等人来领"的语义）。
   */
  requireTarget?: boolean;
}

/** 派发结局（**永不抛**的如实装填）。`note` 空串 = 成功。 */
export interface DispatchResult {
  ok: boolean;
  /** 成功时的 requestId（供面板读回）；失败为空串。 */
  requestId: string;
  /** 目标节点（自动选时由 ANS 在响应里回填；失败且未定目标时 `null`）。 */
  targetNodeId: string | null;
  /** ANS 侧状态（成功时；失败为空串）。 */
  status: NodeRequestStatus | '';
  note: string;
}

/** 读回结局（**永不抛**）。`request` 为 `null` 即没读到，`note` 是真原因。 */
export interface DispatchReadResult {
  ok: boolean;
  request: AnsNodeRequest | null;
  note: string;
}

/** 懒建真 IO——只在没注入时才构造，保持本模块 import 图不绑死网络实现。 */
async function resolveIo(db: Database.Database, injected?: DispatchIo): Promise<DispatchIo> {
  if (injected) return injected;
  const { makeAnsDispatchIo } = await import('./node-dispatch-io.js');
  return makeAnsDispatchIo(db);
}

/** 懒取事件出口——只在没注入时才引 eventBus。 */
async function resolveEmit(injected?: DispatchEventSink): Promise<DispatchEventSink> {
  if (injected) return injected;
  const { eventBus } = await import('./event-bus.js');
  return (type, data) => eventBus.emit(type, data);
}

/**
 * 派一单活出去。**永不抛**——未入网 / 提交失败皆如实装进返回值。
 *
 * ⚠ 未入网先短路：**没有身份就没有读回凭据**（`GET /requests/:id` 按 `node:<id>` 鉴权），
 *   派出去也读不回 ⇒ 与其造一个"派得出去、收不回来"的假闭环，不如如实说"你还没入网"。
 */
export async function dispatchNodeRequest(
  db: Database.Database,
  input: DispatchInput,
  opts: DispatchOpts = {},
): Promise<DispatchResult> {
  if (!isNodeEnrolled(db as unknown as NodeSettingDb)) {
    return { ok: false, requestId: '', targetNodeId: input.targetNodeId ?? null, status: '', note: 'not-enrolled' };
  }

  // zx_20261011_1 M3（C2/M9 角色语义）: **派发侧角色闸**——本地**先**判，`!canDispatch` 即短路、**不触网**
  //   （承"失败如实且快"：既然 ANS 侧必 400，何必绕一趟网络）。判据与 ANS 侧**同源**（`canDispatch`）。
  //   ⚠ 本地角色缺省取 `DEFAULT_NODE_ROLE`（'worker'）——与 ANS 列默认一致 ⇒ 新机默认"只接不分"，
  //     要派活须先把自己升为 `primary`/`observer`（面板改档会同步 ANS 并镜像本地，故此处不落后）。
  const roleRaw = readNodeSetting(db as unknown as NodeSettingDb, NODE_SETTING_KEYS.role);
  const localRole = isNodeRole(roleRaw) ? roleRaw : DEFAULT_NODE_ROLE;
  if (!canDispatch({ role: localRole })) {
    return { ok: false, requestId: '', targetNodeId: input.targetNodeId ?? null, status: '', note: `role-cannot-dispatch: ${localRole} 只接不分` };
  }

  const io = await resolveIo(db, opts.io);
  const emit = await resolveEmit(opts.emit);

  let created: AnsNodeRequest;
  try {
    created = await io.submit({
      category: input.category,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.targetNodeId !== undefined ? { target_node_id: input.targetNodeId } : {}),
      ...(input.requireTarget !== undefined ? { require_target: input.requireTarget } : {}),
    });
  } catch (e) {
    return { ok: false, requestId: '', targetNodeId: input.targetNodeId ?? null, status: '', note: (e as Error)?.message || String(e) };
  }

  // 到场事件——出站台账的左半（`node_dispatch` 聚合）。
  //   ⚠ **带上 `requestPayload`**（真机上＝用户在「派活」卡里填的那份）：台账行若只有 requestId/类目/目标，
  //   用户事后翻账看见的是"派过一单 project_task"却**不知派的是什么**（E2E 实测：摘要读得懂、任务认不出）。
  //   记的就是**发出去的那份**（`input.payload`），不在台账里另算一个摘要（承"一个值一处"）。
  try {
    await emit('node.request_dispatched', {
      requestId: created.id,
      category: created.category,
      targetNodeId: created.target_node_id,
      requestPayload: input.payload ?? {},
    });
  } catch { /* 台账刷新失败不该改这单的结局 */ }

  // zx_20261017_1 批二: 团队审计留痕——**真派出去了**才写（手动/自动/溢出三路都经此一跳）。
  //   明细只记单号/类目/是否要求确定目标；**不复制 payload**（审计不该成为第二份任务内容）。
  recordAudit(db as unknown as AuditDb, {
    actorKind: 'local',
    actorRef: readNodeSetting(db as unknown as NodeSettingDb, NODE_SETTING_KEYS.id) ?? '',
    action: 'node.dispatch',
    targetType: 'node',
    targetId: created.target_node_id ?? '',
    detail: {
      requestId: created.id,
      category: created.category,
      status: created.status,
      requireTarget: input.requireTarget === true,
    },
  });

  return { ok: true, requestId: created.id, targetNodeId: created.target_node_id, status: created.status, note: '' };
}

/** 该 requestId 是否**已有**某类事件（防同一单被读回多次时重复落账）。 */
function eventAlreadyRecorded(db: Database.Database, requestId: string, eventType: string): boolean {
  try {
    const row = db
      .prepare(`SELECT 1 FROM wa_event_log WHERE aggregate_type='node_dispatch' AND event_type=? AND aggregate_id=? LIMIT 1`)
      .get(eventType, requestId);
    return row !== undefined;
  } catch {
    return false; // 表未建 ⇒ 视作未记（保守：宁可多记一次也不吞掉收口）
  }
}

/**
 * 读回一单的终态。**永不抛**。
 *
 * 终态（`done`/`error`）⇒ emit `node.request_result`（出站台账的右半），**幂等**：同一单
 *   已有收口事件则不再重复落账（面板有界轮询会反复调它）。
 * 非终态（`pending`/`assigned`）⇒ 如实回 `ok:true` 但不落收口事件（还在路上）。
 * zx_20261011_1 M4：非终态里**若 B 端在问**（`question_status='asked'`）⇒ 顺带 emit `node.request_question`
 *   （面板据此上屏"待答问题"）；已答则 emit `node.request_answered`。二者各**幂等**（同 result 手法）。
 */
export async function refreshDispatchResult(
  db: Database.Database,
  id: string,
  opts: DispatchOpts = {},
): Promise<DispatchReadResult> {
  if (!isNodeEnrolled(db as unknown as NodeSettingDb)) {
    return { ok: false, request: null, note: 'not-enrolled' };
  }

  const io = await resolveIo(db, opts.io);
  const emit = await resolveEmit(opts.emit);

  let request: AnsNodeRequest;
  try {
    request = await io.get(id);
  } catch (e) {
    return { ok: false, request: null, note: (e as Error)?.message || String(e) };
  }

  // zx_20261011_2 D5（道德经·知止）：有一问**未答**（`question_status='asked'`）时的 `error` 不是结论——
  //   它只是执行方"暂停等人答"的回传（relay 遇 `paused` 报 error）。若照它落 `node.request_result`，
  //   台账行即被钉成 `error`，幂等守卫又挡住重跑后的 `done` ⇒ A 端永远显"失败"，即便 ANS 已 `done`。
  //   故**不落账**：行保持 `pending`、面板继续轮询（`PendingKey` 含它），作答后重跑的 `done` 自然收口。
  const errorAwaitingAnswer = request.status === 'error' && request.question_status === 'asked';
  if ((request.status === 'done' || request.status === 'error') && !errorAwaitingAnswer && !eventAlreadyRecorded(db, request.id, 'node.request_result')) {
    try {
      await emit('node.request_result', {
        requestId: request.id,
        category: request.category,
        targetNodeId: request.target_node_id,
        status: request.status,
        result: request.result,
      });
    } catch { /* 台账刷新失败不该改读回的结局 */ }
  }

  // zx_20261011_1 M4：读回时**顺手把澄清问答记进台账**（与上面 result 同一"读回即落账"手法，幂等）——
  //   否则 B 端问的问题只活在 ANS 侧，面板刷新一次就看不见（A 端无从作答）。各按 `question_status` 分记。
  if (request.question && request.question_status === 'asked' && !eventAlreadyRecorded(db, request.id, 'node.request_question')) {
    try {
      await emit('node.request_question', {
        requestId: request.id,
        category: request.category,
        targetNodeId: request.target_node_id,
        question: request.question.question,
        ...(request.question.options ? { options: request.question.options } : {}),
      });
    } catch { /* 台账刷新失败不该改读回的结局 */ }
  }
  if (request.answer && request.question_status === 'answered' && !eventAlreadyRecorded(db, request.id, 'node.request_answered')) {
    try {
      await emit('node.request_answered', {
        requestId: request.id,
        category: request.category,
        targetNodeId: request.target_node_id,
        answer: request.answer.answer,
      });
    } catch { /* 台账刷新失败不该改读回的结局 */ }
  }

  return { ok: true, request, note: '' };
}

/**
 * zx_20261011_1 M4: 派活方（A 端）**作答** B 端的一问。**永不抛**——失败装进返回值如实上屏。
 *
 * 成功后 emit `node.request_answered`（本机出站台账右半的"这一问答了"），**幂等**：同一单已记则不再落。
 * ⚠ 未入网先短路（同 `dispatchNodeRequest`/`refreshDispatchResult`）：没有身份就没有作答凭据（ANS 侧按请求方 key 鉴权）。
 * ⚠ 不做本地角色闸：**只有派得出去的人才收得到问题**——能走到这一步，早已过过 `canDispatch` 闸。
 */
export async function answerQuestion(
  db: Database.Database,
  input: { id: string; answer: string },
  opts: DispatchOpts = {},
): Promise<DispatchReadResult> {
  if (!isNodeEnrolled(db as unknown as NodeSettingDb)) {
    return { ok: false, request: null, note: 'not-enrolled' };
  }

  const io = await resolveIo(db, opts.io);
  const emit = await resolveEmit(opts.emit);

  let request: AnsNodeRequest;
  try {
    request = await io.answer(input.id, input.answer);
  } catch (e) {
    return { ok: false, request: null, note: (e as Error)?.message || String(e) };
  }

  if (!eventAlreadyRecorded(db, request.id, 'node.request_answered')) {
    try {
      await emit('node.request_answered', {
        requestId: request.id,
        category: request.category,
        targetNodeId: request.target_node_id,
        answer: input.answer,
      });
    } catch { /* 台账刷新失败不该改作答的结局 */ }
  }

  return { ok: true, request, note: '' };
}
