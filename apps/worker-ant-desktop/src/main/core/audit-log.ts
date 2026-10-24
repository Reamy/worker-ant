/**
 * zx_20261017_1 批二（管子·度量衡 / 维特根斯坦·意义即使用）: 团队审计视图的**读写真源**。
 *
 * 病根：用户要回答"谁在什么时候改了什么"，而账本此前**分三处**——`wa_audit_events`（本批新账）、
 *   `wa_device_actions`（设备控制）、`wa_external_calls`（外部终端调用）；三张表各查一遍，
 *   用户得自己拼时间线。本模块给一个**读模型**：三本账投影成同一把尺，按时间倒序一屏。
 *
 * ⚠ **不复用** `wa_audit_trail`：它 `task_id NOT NULL`，装不下"改节点档位 / 激活许可 / 分享库件"
 *   这类非任务事件。两张审计表并存是双真源风险，故本轮**不复活**它（仍零写入，见 rr 判据 R-12）。
 * ⚠ 写点只写"会改变世界"的动作（改档 / 派活 / 团队库增删 / 许可激活），**不写浏览**。
 * ⚠ **永不抛**：审计是旁账，写失败不该改变主动作的结局（console.warn 如实留痕，不静默）。
 * ⚠ 本模块不引 electron：`AuditDb` 只要求 prepare/run/all/get，rr 直跑真逻辑（同 node-orchestrate 范式）。
 * ⚠ 锁定档位下 `listAuditEventsGated` **不查库**（先判 Team 闸、再取数）——读口也不该白读。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { teamFeatureRefusal } from './team-gate.js';
import type { LicenseSettingDb, ResolveLicenseOpts } from './license.js';
import type { AuditEventRow, AuditSource } from './audit-labels.js';
import { isAuditSource } from './audit-labels.js';
import type { NodePatch } from '@worker-ant/shared-types';

/** 最小库接口（可脱 better-sqlite3 被 rr 直跑）。 */
export interface AuditDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

/** 发起者：本机用户 / 网络内节点 / 系统。 */
export type AuditActorKind = 'local' | 'node' | 'system';

export interface AuditEventInput {
  actorKind: AuditActorKind;
  /** 发起者的具体身份（本机用户 id / 节点 id；无则空串，**不猜**）。 */
  actorRef?: string;
  /** 机器可读动词，如 `node.dispatch`。 */
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}

export interface AuditFilter {
  limit?: number;
  offset?: number;
  /** 精确匹配动作动词（如只看 `node.dispatch`）。 */
  action?: string;
  source?: AuditSource;
}

const MAX_LIMIT = 500;

function tableExists(db: AuditDb, name: string): boolean {
  try {
    return db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== undefined;
  } catch {
    return false;
  }
}

function parseDetail(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    // 原行载荷坏掉 ⇒ 如实留空对象（不把"读不成"编成一条假明细）。
    return {};
  }
}

/**
 * 写一条审计事件。返回是否真落库（`false` 即表缺/写失败——调用方**不必**因此失败）。
 */
export function recordAudit(db: AuditDb, event: AuditEventInput): boolean {
  try {
    db.prepare(
      `INSERT INTO wa_audit_events (id, actor_kind, actor_ref, action, target_type, target_id, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      event.actorKind,
      event.actorRef ?? '',
      event.action,
      event.targetType ?? '',
      event.targetId ?? '',
      JSON.stringify(event.detail ?? {}),
    );
    return true;
  } catch (e) {
    console.warn('[audit] 写审计事件失败（主动作不受影响）:', event.action, (e as Error)?.message || String(e));
    return false;
  }
}

/**
 * zx_20261017_1 批四（管子·度量衡）: **改档**的审计写点——一处，供 IPC 转调与受控回归直跑。
 *
 * 只记"改的是哪台 · 改了哪几项 · 是不是自己改自己"；**不复制档位值**成第二份事实（档位真源在 ANS 台账，
 * 审计只答"谁动过手"）。`fields` 由 `NodePatch` 的键派生（新增字段自动纳入，不手抄一张白名单）。
 * 返回是否真落库（`false` 即表缺/写失败——主动作已由 ANS 完成，不因旁账失败而回滚）。
 */
export function recordNodeUpdate(
  db: AuditDb,
  args: { nodeId: string; localNodeId: string; patch: NodePatch },
): boolean {
  const fields = (['name', 'role', 'weight', 'participate'] as const).filter((k) => args.patch[k] !== undefined);
  return recordAudit(db, {
    actorKind: 'local',
    actorRef: args.localNodeId,
    action: 'node.update',
    targetType: 'node',
    targetId: args.nodeId,
    detail: { fields, self: args.nodeId === args.localNodeId },
  });
}

/**
 * 合并三本账的**统一读模型**（时间倒序分页）。
 *   · `wa_audit_events`：source = actor_kind（local/node/system）；
 *   · `wa_device_actions`：投影成 `device.control`（result 保留 ok/denied/error）；
 *   · `wa_external_calls`：投影成 `external.call`（note 保留机器可读拒因）。
 * 缺表（旧库/夹具）⇒ 该本账不入 UNION，其余照常返回——不因一本账缺席而整屏空。
 */
export function listAuditEvents(db: AuditDb, filter: AuditFilter = {}): AuditEventRow[] {
  const parts: string[] = [];
  if (tableExists(db, 'wa_audit_events')) {
    parts.push(
      `SELECT id, actor_kind AS source, action, actor_kind, actor_ref, target_type, target_id,
              '' AS result, '' AS note, detail_json, created_at
         FROM wa_audit_events`,
    );
  }
  if (tableExists(db, 'wa_device_actions')) {
    parts.push(
      `SELECT id, 'device' AS source, 'device.control' AS action, actor_kind, actor_ref,
              'device' AS target_type, device_id AS target_id, result, '' AS note,
              args_json AS detail_json, created_at
         FROM wa_device_actions`,
    );
  }
  if (tableExists(db, 'wa_external_calls')) {
    parts.push(
      `SELECT id, 'terminal' AS source, 'external.call' AS action, 'terminal' AS actor_kind,
              terminal_id AS actor_ref, 'terminal' AS target_type, terminal_id AS target_id,
              result, reason AS note, args_json AS detail_json, created_at
         FROM wa_external_calls`,
    );
  }
  if (parts.length === 0) return [];

  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100), 1), MAX_LIMIT);
  const offset = Math.max(Math.trunc(filter.offset ?? 0), 0);
  const action = typeof filter.action === 'string' && filter.action ? filter.action : '';
  const source = isAuditSource(filter.source) ? filter.source : '';

  const sql =
    `SELECT * FROM (${parts.join(' UNION ALL ')}) AS a ` +
    `WHERE (? = '' OR a.action = ?) AND (? = '' OR a.source = ?) ` +
    `ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`;

  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(sql).all(action, action, source, source, limit, offset) as Array<Record<string, unknown>>;
  } catch (e) {
    console.warn('[audit] 读审计视图失败:', (e as Error)?.message || String(e));
    return [];
  }

  return rows.map((r) => {
    const src = String(r.source ?? '');
    return {
      id: String(r.id ?? ''),
      source: (isAuditSource(src) ? src : 'system') as AuditSource,
      action: String(r.action ?? ''),
      actorKind: String(r.actor_kind ?? ''),
      actorRef: String(r.actor_ref ?? ''),
      targetType: String(r.target_type ?? ''),
      targetId: String(r.target_id ?? ''),
      result: String(r.result ?? ''),
      note: String(r.note ?? ''),
      detail: parseDetail(r.detail_json),
      createdAt: String(r.created_at ?? ''),
    };
  });
}

/** 读口结局（`unlocked:false` 时 `events` 必空——**未查库**，不是"查了没有"）。 */
export interface GatedAuditList {
  unlocked: boolean;
  refusal: string;
  events: AuditEventRow[];
}

/**
 * 面板读口：先过 Team 软闸，**再**查库。锁定 ⇒ 如实回拒因且零读（不是"查完再藏起来"）。
 * 单一真源：闸判据在 `core/team-gate.ts`，此处只做"先闸后读"的次序。
 */
export function listAuditEventsGated(
  db: AuditDb,
  licDb: LicenseSettingDb | null | undefined,
  filter: AuditFilter = {},
  opts: ResolveLicenseOpts = {},
): GatedAuditList {
  const refusal = teamFeatureRefusal(licDb, 'audit_view', opts);
  if (refusal) return { unlocked: false, refusal, events: [] };
  return { unlocked: true, refusal: '', events: listAuditEvents(db, filter) };
}

/* ── 导出（zx_20261018_3 批七）────────────────────────────────────────────── */

/**
 * CSV 转义（RFC 4180）：含逗号/引号/换行/回车的字段整体加引号，内部引号翻倍。
 * 不做"看上去没问题"的宽松处理——一个逗号就能把一列拆成两列。
 */
export function csvEscape(value: string): string {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 导出列（顺序即表头；`detail` 写 JSON 原文）。 */
const CSV_COLUMNS = [
  'id',
  'created_at',
  'source',
  'action',
  'actor_kind',
  'actor_ref',
  'target_type',
  'target_id',
  'result',
  'note',
  'detail',
] as const;

/** 把审计行序列化成 CSV 文本（表头 + 每行 + 末尾换行；CRLF 行尾）。 */
export function auditRowsToCsv(rows: readonly AuditEventRow[]): string {
  const cell = (r: AuditEventRow, col: (typeof CSV_COLUMNS)[number]): string => {
    switch (col) {
      case 'id': return r.id;
      case 'created_at': return r.createdAt;
      case 'source': return r.source;
      case 'action': return r.action;
      case 'actor_kind': return r.actorKind;
      case 'actor_ref': return r.actorRef;
      case 'target_type': return r.targetType;
      case 'target_id': return r.targetId;
      case 'result': return r.result;
      case 'note': return r.note;
      case 'detail': return JSON.stringify(r.detail ?? {});
    }
  };
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvEscape(cell(r, c))).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** 导出结局（锁定态 `unlocked:false` ⇒ **未读库、未落文件**；不是"读了但没写"）。 */
export interface GatedAuditExport {
  unlocked: boolean;
  refusal: string;
  saved: boolean;
  /** 实际落盘路径；未落盘时为空串。 */
  path: string;
  /** 写入 CSV 的行数（不含表头）；未落盘时为 0。 */
  rows: number;
  /** 落盘失败时的人话原因（成功时为空串）。 */
  error: string;
}

/** 导出不设上限、不分页**参数**，但内部按 `MAX_LIMIT` 分页读完（分页是读法，不是筛选）。 */
export type AuditExportFilter = Omit<AuditFilter, 'limit' | 'offset'>;

function listAllAuditEvents(db: AuditDb, filter: AuditExportFilter): AuditEventRow[] {
  const all: AuditEventRow[] = [];
  for (let offset = 0; ; offset += MAX_LIMIT) {
    const page = listAuditEvents(db, { ...filter, limit: MAX_LIMIT, offset });
    all.push(...page);
    if (page.length < MAX_LIMIT) break;
  }
  return all;
}

/**
 * 审计导出：**先过 Team 软闸，再读库，最后落盘**。
 *   锁定 ⇒ 当场回拒因；`licDb` 之外**不碰**任何 db、不创建目录、不写文件。
 *   解锁 ⇒ 读全部匹配行（忽略分页参数），写 `targetPath`；行数与读到的行数一致。
 * ⚠ 闸判据仍是 `team-gate.ts` 一处（本函数不写第二份档位判断）。
 */
export function exportAuditCsvGated(
  db: AuditDb,
  licDb: LicenseSettingDb | null | undefined,
  targetPath: string,
  filter: AuditExportFilter = {},
  opts: ResolveLicenseOpts = {},
): GatedAuditExport {
  const refusal = teamFeatureRefusal(licDb, 'audit_export', opts);
  if (refusal) return { unlocked: false, refusal, saved: false, path: '', rows: 0, error: '' };

  const rows = listAllAuditEvents(db, {
    ...(typeof filter.action === 'string' && filter.action ? { action: filter.action } : {}),
    ...(isAuditSource(filter.source) ? { source: filter.source } : {}),
  });
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, auditRowsToCsv(rows), 'utf8');
    return { unlocked: true, refusal: '', saved: true, path: targetPath, rows: rows.length, error: '' };
  } catch (e) {
    return {
      unlocked: true,
      refusal: '',
      saved: false,
      path: '',
      rows: 0,
      error: (e as Error)?.message || String(e),
    };
  }
}
