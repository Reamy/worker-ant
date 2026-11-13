/**
 * zx_20261108_1 B3（维特根斯坦·意义即使用 / 管子·度量衡）: **IM 理解审计**的只读取数。
 *
 * 病根：路由把消息判成任务/查询/闲聊之后，**判定本身不留痕**——用户看到「已创建任务」，
 *   却无从知道是哪条规则把它推下去的；平台重投同一条消息时也无从核对是否被挡。
 * 本模块做两件事：把入站行的 `intent/route/route_reason` 连同正文摘要取出来；按同一份行生成 CSV 并落盘。
 *
 * ⚠ 与路由**同一张表、同一份列**（`wa_im_conversations`）：不另建审计表，避免两本账各说各话。
 * ⚠ 只读：不 INSERT/UPDATE/DELETE，不触发发送。导出只写 `<dataDir>/exports/` 下的 CSV。
 * ⚠ 档位判据只经 `teamFeatureRefusal`（`audit_view` / `audit_export`），不在这里另写一份；
 *   锁定档位下**先拒、不读库、不建目录、不写文件**（与 `core/audit-log.ts` 同一判断次序）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { teamFeatureRefusal } from '../team-gate.js';
import type { LicenseSettingDb, ResolveLicenseOpts } from '../license.js';

/** 最小库接口（可脱 better-sqlite3 被 rr 直跑）。 */
export interface IntentAuditDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

export interface IntentAuditFilter {
  channelId?: string;
  limit?: number;
  offset?: number;
}

export interface IntentAuditRow {
  id: string;
  channelId: string;
  channelName: string;
  externalUserId: string;
  intent: string;
  route: string;
  routeReason: string;
  taskId: string | null;
  createdAt: string;
  /** 正文摘要（不超过 `TEXT_PREVIEW_CHARS` 字）——只作核对用，不重放整条媒体。 */
  text: string;
}

export interface IntentAuditResult {
  rows: IntentAuditRow[];
  total: number;
}

const TEXT_PREVIEW_CHARS = 120;
const MAX_LIMIT = 500;

function previewOf(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '';
  try {
    const obj = JSON.parse(raw) as { text?: unknown; body?: unknown };
    const text = typeof obj.text === 'string' ? obj.text : typeof obj.body === 'string' ? obj.body : '';
    return text.slice(0, TEXT_PREVIEW_CHARS);
  } catch {
    return '';
  }
}

const SELECT_COLUMNS = `c.id, c.channel_id, ch.name AS channel_name, c.external_user_id,
       c.intent, c.route, c.route_reason, c.task_id, c.created_at, c.message_json`;

function selectRows(db: IntentAuditDb, channelId: string, limit: number, offset: number): IntentAuditRow[] {
  const base = `SELECT ${SELECT_COLUMNS}
     FROM wa_im_conversations c
     LEFT JOIN wa_im_channels ch ON ch.id = c.channel_id
     WHERE c.direction = 'inbound' AND (? = '' OR c.channel_id = ?)
     ORDER BY c.rowid DESC`;
  const raw = limit > 0
    ? db.prepare(`${base} LIMIT ? OFFSET ?`).all(channelId, channelId, limit, offset)
    : db.prepare(base).all(channelId, channelId);
  return (raw as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id ?? ''),
    channelId: String(r.channel_id ?? ''),
    channelName: String(r.channel_name ?? ''),
    externalUserId: String(r.external_user_id ?? ''),
    intent: String(r.intent ?? ''),
    route: String(r.route ?? ''),
    routeReason: String(r.route_reason ?? ''),
    taskId: typeof r.task_id === 'string' && r.task_id ? r.task_id : null,
    createdAt: String(r.created_at ?? ''),
    text: previewOf(r.message_json),
  }));
}

/** 入站理解账，按插入序倒序（最新在上）。`total` 与 `rows` 同一 WHERE，翻得到底。 */
export function listIntentAudit(db: IntentAuditDb, opts: IntentAuditFilter = {}): IntentAuditResult {
  const channelId = (opts.channelId || '').trim();
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), MAX_LIMIT);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const totalRow = db.prepare(
    `SELECT COUNT(*) AS n FROM wa_im_conversations
     WHERE direction = 'inbound' AND (? = '' OR channel_id = ?)`
  ).get(channelId, channelId) as { n: number } | undefined;
  return { rows: selectRows(db, channelId, limit, offset), total: Number(totalRow?.n ?? 0) };
}

export type GatedIntentAuditList =
  | { unlocked: false; refusal: string; rows: []; total: 0 }
  | { unlocked: true; refusal: ''; rows: IntentAuditRow[]; total: number };

/** 先过 `audit_view` 闸、再读库；锁定档位下返回拒因且**不查库**。 */
export function listIntentAuditGated(
  db: IntentAuditDb,
  licDb: LicenseSettingDb | null | undefined,
  filter: IntentAuditFilter = {},
  opts: ResolveLicenseOpts = {},
): GatedIntentAuditList {
  const refusal = teamFeatureRefusal(licDb, 'audit_view', opts);
  if (refusal) return { unlocked: false, refusal, rows: [], total: 0 };
  const r = listIntentAudit(db, filter);
  return { unlocked: true, refusal: '', rows: r.rows, total: r.total };
}

const CSV_HEADER = ['创建时间', '渠道', '用户', '意图', '路由', '理由', '任务ID', '正文'];

function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 同一份审计行导出 CSV（表头中文，正文摘要已在取数时截断）。 */
export function intentAuditCsv(rows: IntentAuditRow[]): string {
  const lines = rows.map((r) => [
    r.createdAt,
    r.channelName || r.channelId,
    r.externalUserId,
    r.intent,
    r.route,
    r.routeReason,
    r.taskId || '',
    r.text,
  ]);
  return [CSV_HEADER, ...lines].map((cols) => cols.map(csvCell).join(',')).join('\n');
}

export type GatedIntentAuditExport =
  | { unlocked: false; refusal: string; saved: false; path: ''; rows: 0; error: '' }
  | { unlocked: true; refusal: ''; saved: boolean; path: string; rows: number; error: string };

/** 先过 `audit_export` 闸、再读库、再落盘；锁定档位下不读库、不建目录、不写文件。 */
export function exportIntentAuditCsvGated(
  db: IntentAuditDb,
  licDb: LicenseSettingDb | null | undefined,
  targetPath: string,
  filter: IntentAuditFilter = {},
  opts: ResolveLicenseOpts = {},
): GatedIntentAuditExport {
  const refusal = teamFeatureRefusal(licDb, 'audit_export', opts);
  if (refusal) return { unlocked: false, refusal, saved: false, path: '', rows: 0, error: '' };

  // 导出吃的是**筛选**，不是分页：limit/offset 不接；limit=-1 表示取全部。
  const rows = selectRows(db, (filter.channelId || '').trim(), -1, 0);
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, intentAuditCsv(rows), 'utf8');
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
