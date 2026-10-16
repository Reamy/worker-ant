/**
 * zx_20261011 M3（维特根斯坦·意义即用法）: 本机**派出去**的活（出站台账）的聚合面。
 *
 * 与接收侧 `node-call-log.ts`（入站：AI 终端派给**我**的）**刻意对照**——两个方向各一本账：
 *   入站答"谁派给我、我办成没办成"；出站答"**我派给谁、办成没办成**"。合成一本会分不清
 *   "这件是我派的"还是"派给我的"（同一 requestId 在两侧语义相反）。
 *
 * 数据源＝**本机不可变事件日志**（`wa_event_log`）里 `aggregate_type='node_dispatch'` 的两类事件
 *   （M3 的 `node.request_dispatched` / `node.request_result`，**已入** `EVENT_AGGREGATE_MAP` ⇒ 真落库）。
 *   为何读事件日志而非另建一张表：事件**已经是**这条账的真源（一次派发 = 两条事件），
 *   再建一张表就是"同一件事两处各记各的"（承 `node-call-log.ts` 同裁）。
 *
 * ⚠ 零网络依赖（纯 DB 读）⇒ 受控回归可直引跑真实现（同 `node-call-log.ts` 范式）。
 */
import type { NodeAnswer, NodeQuestion } from '@worker-ant/shared-types';

/** 读事件日志的最小库接口（使本模块可脱 better-sqlite3 被 rr 直跑）。 */
export interface DispatchLogDb {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
}

/** 一条出站记录（**聚合 2–4 条事件**所得；`pending` = 已派出未收口）。 */
export interface NodeDispatchRecord {
  requestId: string;
  category: string;
  /** 目标节点 id（`dispatched` 事件携带；自动选时由 ANS 定）。未定目标时为 `''`。 */
  targetNodeId: string;
  /**
   * 派出去的那份**请求载荷**（真机上＝`{ prompt }`，即用户在「派活」卡填的活）。
   * 无此字段则台账行只答"派过一单"，答不了"派的是什么"——故随事件落库、随记录聚合。
   */
  requestPayload: Record<string, unknown> | null;
  /** 派出时刻（`dispatched` 事件的 `occurred_at`，ISO）。 */
  dispatchedAt: string;
  /** 收口时刻（`result` 的 `occurred_at`）；未收口为 `null`。 */
  resultAt: string | null;
  /** 聚合态：`pending`（只派出）/ `done`/`error`。 */
  status: 'pending' | 'done' | 'error';
  result: Record<string, unknown> | null;
  /** 耗时（毫秒）＝收口 − 派出；两时刻缺一即 `null`（不编一个 0 冒充"瞬时完成"）。 */
  durationMs: number | null;
  /** zx_20261011_1 M4: B 端（执行方）**最近的提问**（`node.request_question` 事件）；从未提问为 `null`。 */
  question: NodeQuestion | null;
  /** zx_20261011_1 M4: 本机（派活方）**最近一次作答**（`node.request_answered`）；从未作答为 `null`。 */
  answer: NodeAnswer | null;
  /**
   * zx_20261011_1 M4: 问题状态——`asked`（B 端刚问、等我答）/ `answered`（我已答，B 端可继续跑）。
   *   与 `status` **分开**：`status` 答"这单走到哪一步"（派/回），`questionStatus` 答"这一问答没答"。
   */
  questionStatus: 'asked' | 'answered' | null;
}

function parseJson(s: unknown): Record<string, unknown> {
  if (typeof s !== 'string' || s.length === 0) return {};
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

/** `node.request_question` 载荷 → `NodeQuestion`（无 `question` 串 ⇒ `null`，不编一句空问题）。 */
function parseQuestion(p: Record<string, unknown>): NodeQuestion | null {
  if (typeof p.question !== 'string' || p.question.length === 0) return null;
  const options = Array.isArray(p.options) ? p.options.filter((o): o is string => typeof o === 'string') : undefined;
  return { question: p.question, ...(options && options.length > 0 ? { options } : {}) };
}

/** `node.request_answered` 载荷 → `NodeAnswer`（无 `answer` 串 ⇒ `null`）。 */
function parseAnswer(p: Record<string, unknown>): NodeAnswer | null {
  return typeof p.answer === 'string' ? { answer: p.answer } : null;
}

/**
 * 聚合本机派出去的活，最近派出在前。
 * 按 `aggregate_id`（= requestId）归并两类事件——**一次派发一行**，不是"两条事件两行"。
 */
export function listNodeDispatchRecords(db: DispatchLogDb, limit = 50): NodeDispatchRecord[] {
  const rows = db.prepare(
    `SELECT event_type, aggregate_id, payload, occurred_at FROM wa_event_log
     WHERE aggregate_type = 'node_dispatch' AND event_type IN ('node.request_dispatched', 'node.request_result', 'node.request_question', 'node.request_answered')
     ORDER BY id ASC`,
  ).all() as Array<{ event_type: string; aggregate_id: string; payload: string; occurred_at: string }>;

  const byId = new Map<string, NodeDispatchRecord>();
  for (const r of rows) {
    const p = parseJson(r.payload);
    const rec = byId.get(r.aggregate_id) ?? {
      requestId: r.aggregate_id,
      category: '',
      targetNodeId: '',
      requestPayload: null,
      dispatchedAt: '',
      resultAt: null,
      status: 'pending' as const,
      result: null,
      durationMs: null,
      question: null,
      answer: null,
      questionStatus: null,
    };
    if (p.category !== undefined) rec.category = String(p.category);
    if (p.targetNodeId !== undefined && p.targetNodeId !== null) rec.targetNodeId = String(p.targetNodeId);
    if (p.requestPayload && typeof p.requestPayload === 'object' && !Array.isArray(p.requestPayload)) {
      rec.requestPayload = p.requestPayload as Record<string, unknown>;
    }
    if (r.event_type === 'node.request_dispatched') {
      rec.dispatchedAt = r.occurred_at;
    } else if (r.event_type === 'node.request_result') {
      rec.resultAt = r.occurred_at;
      rec.status = p.status === 'error' ? 'error' : 'done';
      rec.result = p.result && typeof p.result === 'object' && !Array.isArray(p.result) ? (p.result as Record<string, unknown>) : null;
    } else if (r.event_type === 'node.request_question') {
      // B 端提问 ⇒ 待我答（`asked`）。问题形状由 `node.request_question` 载荷携（`question`/`options`）。
      rec.question = parseQuestion(p);
      rec.questionStatus = 'asked';
    } else {
      // 本机作答 ⇒ `answered`（覆盖上一条 question 的 `asked`）。
      rec.answer = parseAnswer(p);
      rec.questionStatus = 'answered';
    }
    byId.set(r.aggregate_id, rec);
  }

  const out = [...byId.values()];
  for (const rec of out) {
    if (rec.dispatchedAt && rec.resultAt) {
      const a = Date.parse(rec.dispatchedAt);
      const b = Date.parse(rec.resultAt);
      rec.durationMs = Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
    }
  }
  // 最近派出在前（无派出的排最后，靠 requestId 稳定序）。
  out.sort((x, y) => (y.dispatchedAt || '').localeCompare(x.dispatchedAt || '') || x.requestId.localeCompare(y.requestId));
  return out.slice(0, limit);
}
