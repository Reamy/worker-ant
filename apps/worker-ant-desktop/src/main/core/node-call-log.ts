/**
 * zx_20261004 M13（维特根斯坦·意义即用法 / 黑格尔·合理才存在）: AI 终端**调用记录**的聚合面。
 *
 * 病根（若无本模块）：M12 让"AI 终端能派活给工蚁"成立，但派了什么、办成没办成、耗时多久、
 *   是谁派的——**散在两处**（ANS 的 `ans_node_requests` 一行、本机两条事件）而**无一面可看**。
 *   看不见的机制等于没有（"合理才存在"：不上屏者，用户无从确认它是否在运行）。
 *
 * 数据源＝**本机不可变事件日志**（`wa_event_log`）里 `aggregate_type='node_request'` 的两类事件
 *   （M12 的 `node.request_received` / `node.request_completed`，**已入** `EVENT_AGGREGATE_MAP` ⇒ 真落库）。
 *   为何读事件日志而非另建一张调用表：事件**已经是**这条账的真源（一次派单 = 两条事件），
 *   再建一张表就是"同一件事两处各记各的"（auto-memory `feedback_enum_value_sweep_readers` 的病根形态）。
 *
 * ⚠ 零网络依赖（纯 DB 读）⇒ 受控回归可直引跑真实现（承 `node-identity.ts` 范式）。
 */
/** 读事件日志的最小库接口（使本模块可脱 better-sqlite3 被 rr 直跑）。 */
export interface CallLogDb {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
}

/** 一条调用记录（**聚合两条事件**所得；`pending` = 已到场未收口）。 */
export interface NodeCallRecord {
  requestId: string;
  category: string;
  /** 请求方（AI 终端）key 前缀——**仅前缀**。 */
  requesterKeyPrefix: string;
  /**
   * 派来的那份**请求载荷**（真机上＝`{ prompt }`）。台账行须能答"派来的是什么"，否则只知有人派过一单
   * （承 zx_20261011 M9 追加批：与出站侧同病同治）。
   */
  requestPayload: Record<string, unknown> | null;
  /** 到场时刻（`received` 事件的 `occurred_at`，ISO）。 */
  receivedAt: string;
  /** 收口时刻（`completed` 的 `occurred_at`）；未收口为 `null`。 */
  completedAt: string | null;
  /**
   * 聚合态：`pending`（只到场）/ `done` / `error` / `cancelled`（zx_20261030_1 M3：派活方叫停后真停，
   *   既非完成也非失败）。
   */
  status: 'pending' | 'done' | 'error' | 'cancelled';
  result: Record<string, unknown> | null;
  /** 耗时（毫秒）＝收口 − 到场；两时刻缺一即 `null`（不编一个 0 冒充"瞬时完成"）。 */
  durationMs: number | null;
}

function parseJson(s: unknown): Record<string, unknown> {
  if (typeof s !== 'string' || s.length === 0) return {};
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

/**
 * 聚合本机 AI 终端调用记录，最近到场在前。
 * 按 `aggregate_id`（= requestId）归并两类事件——**一条请求一行**，不是"两条事件两行"。
 */
export function listNodeCallRecords(db: CallLogDb, limit = 50): NodeCallRecord[] {
  const rows = db.prepare(
    `SELECT event_type, aggregate_id, payload, occurred_at FROM wa_event_log
     WHERE aggregate_type = 'node_request' AND event_type IN ('node.request_received', 'node.request_completed')
     ORDER BY id ASC`,
  ).all() as Array<{ event_type: string; aggregate_id: string; payload: string; occurred_at: string }>;

  const byId = new Map<string, NodeCallRecord>();
  for (const r of rows) {
    const p = parseJson(r.payload);
    const rec = byId.get(r.aggregate_id) ?? {
      requestId: r.aggregate_id,
      category: '',
      requesterKeyPrefix: '',
      requestPayload: null,
      receivedAt: '',
      completedAt: null,
      status: 'pending' as const,
      result: null,
      durationMs: null,
    };
    if (p.category !== undefined) rec.category = String(p.category);
    if (p.requesterKeyPrefix !== undefined) rec.requesterKeyPrefix = String(p.requesterKeyPrefix);
    if (p.requestPayload && typeof p.requestPayload === 'object' && !Array.isArray(p.requestPayload)) {
      rec.requestPayload = p.requestPayload as Record<string, unknown>;
    }
    if (r.event_type === 'node.request_received') {
      rec.receivedAt = r.occurred_at;
    } else {
      rec.completedAt = r.occurred_at;
      // M3：三档如实分——叫停不是失败，也不能读成"办成了"。
      rec.status = p.status === 'error' ? 'error' : p.status === 'cancelled' ? 'cancelled' : 'done';
      rec.result = p.result && typeof p.result === 'object' && !Array.isArray(p.result) ? (p.result as Record<string, unknown>) : null;
    }
    byId.set(r.aggregate_id, rec);
  }

  const out = [...byId.values()];
  for (const rec of out) {
    if (rec.receivedAt && rec.completedAt) {
      const a = Date.parse(rec.receivedAt);
      const b = Date.parse(rec.completedAt);
      rec.durationMs = Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
    }
  }
  // 最近到场在前（无到场的排最后，靠 requestId 稳定序）。
  out.sort((x, y) => (y.receivedAt || '').localeCompare(x.receivedAt || '') || x.requestId.localeCompare(y.requestId));
  return out.slice(0, limit);
}
