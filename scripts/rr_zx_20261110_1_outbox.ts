/**
 * zx_20261110_1 B7 受控回归 —— IM 出站补发账可关闭。
 *
 * 病根：`dead`（超窗/超次）与 `unsupported_media`（通道结构上发不了件）在自动补发里是终态，
 *   但它们会**永远**留在账上；横幅的"待处理"数字也就永远不归零。用户看得见、点不动、清不掉。
 *
 * 本套件钉住：
 *   A 单条关闭：dead/unsupported_media/blocked_quota 可关（状态→dismissed，时间留痕）；
 *   B 拒绝面：sent / pending / 不存在 一律不许关，状态不变；
 *   C 回指清理：关联会话 outbox_id 同事务置空；
 *   D 批量：只动白名单三态，pending/sent 不受影响，空清单/未知状态不动作；
 *   E 统计口径：dismissed 单列一档，不混入 other（"待处理"不因历史关闭项失真）；
 *   F 静态钉：IPC 两入口在册、UI 关闭按钮与批量入口在册、构建标识与哑雷纪律。
 *
 * 纪律：零网络 / 零 electron；夹具按生产列形自建 DDL；断言文案不含失败/通过字形。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  dismissOutboxEntry,
  dismissAllTerminal,
  outboxStats,
  outboxStatusCounts,
  listOutbox,
  OUTBOX_DISMISSABLE,
} from '../apps/worker-ant-desktop/src/main/core/im/im-outbox.js';
import { ROUND_RE, checkBuildPins, deriveBuildTag, listStrayPinLiterals, stripKeepingLines } from './lib/rr-pins.js';

const ROOT = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const SRC_BUILD = deriveBuildTag(fs.readFileSync(path.join(ROOT, `${A}/src/main/core/agent-executor.ts`), 'utf-8')).tag;
const roundOrd = (tag: string): number => {
  const m = /^zx_(\d{8})(?:_(\d+))?$/.exec(tag);
  return m ? Number(m[1]) * 1000 + Number(m[2] ?? 1) : -1;
};

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const rd = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/* ═══ 夹具（生产列形；刻意**不带** dismissed_at/dismiss_reason ⇒ 走 ensureDismissColumns 的补列路径） ═══ */
const SCHEMA = `
CREATE TABLE wa_im_outbox (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT,
  kind TEXT DEFAULT 'notification', message TEXT DEFAULT '', attempts INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending', next_retry_at INTEGER, created_at TEXT DEFAULT (datetime('now')),
  last_error TEXT, last_attempt_at TEXT, media_path TEXT, media_kind TEXT
);
CREATE TABLE wa_im_conversations (
  id TEXT PRIMARY KEY, outbox_id TEXT DEFAULT '', status TEXT DEFAULT 'failed'
);
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, name TEXT DEFAULT '', channel_type TEXT DEFAULT '');
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, title TEXT DEFAULT '');
`;
function fixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}
function addRow(db: DatabaseSync, id: string, status: string, msg = ''): void {
  db.prepare("INSERT INTO wa_im_outbox (id, channel_id, external_user_id, task_id, kind, message, attempts, status) VALUES (?, 'ch1', 'u1', '', 'notification', ?, 1, ?)").run(id, msg || `消息 ${id}`, status);
}
function rowOf(db: DatabaseSync, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM wa_im_outbox WHERE id = ?').get(id) as Record<string, unknown> | undefined;
}

/* ═══ A 单条关闭 ═══════════════════════════════════════════════════════ */
{
  console.log('【A】单条关闭：终态三兄弟都可关，且留痕');
  const db = fixture();
  addRow(db, 'o-dead', 'dead');
  addRow(db, 'o-unsup', 'unsupported_media');
  addRow(db, 'o-blocked', 'blocked_quota');

  const a = dismissOutboxEntry(db, 'o-dead', '用户关闭');
  ok(a.ok && a.status === 'dismissed', 'A-1 dead 可关闭且状态变 dismissed', JSON.stringify(a));
  const ra = rowOf(db, 'o-dead');
  ok(!!ra?.dismissed_at, 'A-2 关闭时刻已留痕（dismissed_at 非空）', String(ra?.dismissed_at));
  ok(ra?.dismiss_reason === '用户关闭', 'A-3 关闭理由已留痕', String(ra?.dismiss_reason));

  const b = dismissOutboxEntry(db, 'o-unsup');
  ok(b.ok, 'A-4 unsupported_media 可关闭');
  const c = dismissOutboxEntry(db, 'o-blocked');
  ok(c.ok, 'A-5 blocked_quota 可关闭（用户明确放弃等条件恢复）');
  ok(OUTBOX_DISMISSABLE.join(',') === 'dead,unsupported_media,blocked_quota', 'A-6 白名单恰为三态（集合与实现同源）', OUTBOX_DISMISSABLE.join(','));
}

/* ═══ B 拒绝面 ════════════════════════════════════════════════════════ */
{
  console.log('【B】拒绝面：已送达 / 待补发 / 不存在一律不许关');
  const db = fixture();
  addRow(db, 'o-sent', 'sent');
  addRow(db, 'o-pending', 'pending');

  const s = dismissOutboxEntry(db, 'o-sent');
  ok(!s.ok && s.code === 'not_dismissable', 'B-1 sent 关闭被拒', JSON.stringify(s));
  ok(rowOf(db, 'o-sent')?.status === 'sent', 'B-2 sent 状态未被改动');

  const p = dismissOutboxEntry(db, 'o-pending');
  ok(!p.ok && p.code === 'not_dismissable', 'B-3 pending 关闭被拒（它还会再试）');
  ok(rowOf(db, 'o-pending')?.status === 'pending', 'B-4 pending 状态未被改动');

  const n = dismissOutboxEntry(db, 'o-none');
  ok(!n.ok && n.code === 'not_found', 'B-5 不存在的行如实说"不存在"');
}

/* ═══ C 回指清理 ══════════════════════════════════════════════════════ */
{
  console.log('【C】会话回指：关闭后 outbox_id 置空（不留悬挂入口）');
  const db = fixture();
  addRow(db, 'o-dead', 'dead');
  db.prepare("INSERT INTO wa_im_conversations (id, outbox_id, status) VALUES ('c1', 'o-dead', 'failed')").run();
  db.prepare("INSERT INTO wa_im_conversations (id, outbox_id, status) VALUES ('c2', 'o-other', 'failed')").run();
  dismissOutboxEntry(db, 'o-dead', '用户关闭');
  const c1 = db.prepare("SELECT outbox_id FROM wa_im_conversations WHERE id = 'c1'").get() as { outbox_id?: string };
  const c2 = db.prepare("SELECT outbox_id FROM wa_im_conversations WHERE id = 'c2'").get() as { outbox_id?: string };
  ok(c1.outbox_id === '', 'C-1 被关闭行关联的会话 outbox_id 已置空', String(c1.outbox_id));
  ok(c2.outbox_id === 'o-other', 'C-2 反证：别的会话回指不被误清', String(c2.outbox_id));
}

/* ═══ D 批量关闭 ══════════════════════════════════════════════════════ */
{
  console.log('【D】批量：只动白名单三态，其余不动');
  const db = fixture();
  addRow(db, 'd1', 'dead');
  addRow(db, 'd2', 'dead');
  addRow(db, 'u1', 'unsupported_media');
  addRow(db, 'b1', 'blocked_quota');
  addRow(db, 'p1', 'pending');
  addRow(db, 's1', 'sent');

  const n = dismissAllTerminal(db, ['dead', 'unsupported_media', 'blocked_quota'], '用户批量关闭');
  ok(n === 4, 'D-1 批量关闭命中 4 行', String(n));
  ok(['d1', 'd2', 'u1', 'b1'].every((id) => rowOf(db, id)?.status === 'dismissed'), 'D-2 三态行全部变 dismissed');
  ok(rowOf(db, 'p1')?.status === 'pending', 'D-3 反证：pending 行不受影响');
  ok(rowOf(db, 's1')?.status === 'sent', 'D-4 反证：sent 行不受影响');

  const n2 = dismissAllTerminal(db, ['pending'], '用户批量关闭');
  ok(n2 === 0 && rowOf(db, 'p1')?.status === 'pending', 'D-5 未知/越界状态被白名单过滤，不动作');
  const n3 = dismissAllTerminal(db, [], '用户批量关闭');
  ok(n3 === 0, 'D-6 空清单不动作（禁无过滤全清）');
}

/* ═══ E 统计口径 ══════════════════════════════════════════════════════ */
{
  console.log('【E】统计：dismissed 单列一档，不混入 other');
  const db = fixture();
  addRow(db, 'x1', 'dead');
  addRow(db, 'x2', 'sent');
  addRow(db, 'x3', 'weird_status');
  dismissOutboxEntry(db, 'x1', '用户关闭');

  const st = outboxStats(db);
  ok(st.dismissed === 1, 'E-1 已关闭单列一档', JSON.stringify(st));
  ok(st.other === 1, 'E-2 other 只兜未知态，不再吃 dismissed', String(st.other));
  ok(st.dead === 0, 'E-3 关闭后 dead 归零（"待处理"可归零）');
  ok(outboxStatusCounts(db).dismissed === 1, 'E-4 逐状态原始计数仍如实含 dismissed');
}

/* ═══ F 明细可回查 + 静态钉 ═══════════════════════════════════════════ */
{
  console.log('【F】明细可回查与静态接线');
  const db = fixture();
  db.prepare("INSERT INTO wa_im_channels (id, name, channel_type) VALUES ('ch1', '测试渠道', 'wechat-personal')").run();
  addRow(db, 'l1', 'dead');
  dismissOutboxEntry(db, 'l1', '用户关闭');
  const rows = listOutbox(db, { limit: 10 });
  ok(rows.length === 1 && rows[0].status === 'dismissed' && !!rows[0].dismissed_at,
    'F-1 明细仍可取到已关闭行，且带关闭时刻', JSON.stringify({ status: rows[0]?.status, at: rows[0]?.dismissed_at }));

  const ipc = rd(`${A}/src/main/ipc/im.ipc.ts`);
  ok(/im:outboxDismiss'/.test(ipc) && /im:outboxDismissTerminal'/.test(ipc), 'F-2 IPC 两个关闭入口均在册');
  const ui = rd(`${A}/renderer/src/pages/IMPage.tsx`);
  ok(ui.includes('OUTBOX_DISMISSABLE') && ui.includes('handleOutboxDismiss') && ui.includes('关闭全部无法补发项'),
    'F-3 UI 单条关闭与批量关闭入口均在册');
  const core = stripKeepingLines(rd(`${A}/src/main/core/im/im-outbox.ts`));
  ok(/export const OUTBOX_DISMISSABLE\s*=\s*\['dead',\s*'unsupported_media',\s*'blocked_quota'\]/.test(core),
    'F-4 白名单常量定义在 core（一处真源）');

  checkBuildPins(ok, { distDir: path.join(ROOT, `${A}/dist`) });
  ok(ROUND_RE.test(SELF_ROUND), 'F-5 本轮标识由载体自身派生且格式合法', SELF_ROUND);
  ok(roundOrd(SRC_BUILD) >= roundOrd(SELF_ROUND), 'F-6 源码 build 不早于本套件轮次', SRC_BUILD);
  ok(listStrayPinLiterals(path.join(ROOT, 'scripts'), ['rr_zx_20260909_fixes.ts'], ROOT).length === 0,
    'F-7 除历史负钉外无轮次字面量');
  const GLYPHS = new RegExp('[' + String.fromCharCode(0x2717) + String.fromCharCode(0x2713) + ']');
  ok(!GLYPHS.test(rd('scripts/rr_zx_20261110_1_outbox.ts')), 'F-8 本套件断言文案不含失败/通过字形');
}

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_zx_20261110_1_outbox: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
