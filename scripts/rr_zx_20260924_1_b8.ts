/**
 * zx_20260924_1 批次 M8 受控复跑 —— 「本通道发不了件」：能力表要有人读（F11 / 用户补充①）。
 *
 * 病根（`plans/improve/zx_20260924_1.md` §1.12 四段链条）：
 *   ① `channel-capabilities.ts` 写下 `'wechat-personal': { …, media: false }` 与"本通道不支持发送文件"，
 *      同文件注释还写着"调用方据此**如实拒绝**"；
 *   ② 而全仓**唯一读者是 `im:diagnose`**——补发路根本不读；
 *   ③ 补发路的入参里连 `channel_type` 都没有(`listOutbox` 只取渠道名) ⇒ 手上拿不到能力表所需的键；
 *   ④ 终态也照做：可补发集合含 `dead` ⇒ 硬发下去、`sendImMedia` 抛错被包成 `ImSendError`
 *      ⇒ 走**普通失败路**(attempts+1、退避、再置 dead)，界面显示"未送达"。
 *   用户看到的是"这条没送到"，真相是"**这条永远不会送达**，因为这个通道根本发不了件"。
 *
 * 本脚本核的七件事：
 *   M8-1 **该拒**（手动路）：`media:false` 渠道 + 媒体行 + `dead` ⇒ 拒、不抛、`attempts` 逐位不变、行落 `unsupported_media`；
 *   M8-2 **该拒**（自动路）：同形行 `pending` 且到期 ⇒ 同上（并核"能力闸在超窗闸之前"）；
 *   M8-3 **不该拒**①：同渠道 + **纯文本**行 ⇒ 照常补发（防"修媒体闸误伤文本补发"）；
 *   M8-4 **不该拒**②：`media:true` 渠道(qqbot) + 媒体行 ⇒ 照常**发件**(抓到的 entry 带 mediaPath)；
 *   M8-5 **同源**：抛出的理由串含 `MEDIA_UNSUPPORTED_TEXT` 的**值**（import 常量来比，不手抄字面量），
 *         且该值在能力表源码里**只出现一次**（那处常量声明）——不许有第二份同义文案；
 *   M8-6 **不是死结**：`unsupported_media` 行在渠道**长出**发件能力后照样补发得成（可补发集合含该态）；
 *   M8-7 **界面如实**：`listOutbox` 派生的 `media_unsupported(_reason)`（渲染层只用它）、分组表与文案在位、
 *         补发结果按 status 分"还没成/已经不会成了"两说；另核旧库(无 `media_*` 列)不影响明细可读。
 *
 * §G 不变式门：
 *   G-1 **真源在位**：判据/文案一律 `import` 生产符号（被删/改名 ⇒ 编译期失败），**不手抄字面量**；
 *   G-2 **两只标本**：每条判据两侧都有真标本（该拒 / 该不拒），且"两个条件缺一不可"逐个试；
 *   G-3 **扫描面自证**：源码面断言一并报出扫描面大小。
 *
 * ⚠ 本脚本**不写任何轮次字面量**（`scripts/lib/rr-pins.ts` 的 P5 逐处点名 file:line）。
 * ⚠ 夹具按 `database.ts` 的**真 DDL** 搭（列名不猜）；`im-outbox.ts` 无 electron 依赖
 *   (`im.ipc.js` 是动态 import) ⇒ 直跑**真实现**。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
import {
  retryOutboxEntry, retryImOutbox, listOutbox, outboxStats, reviveQuotaBlockedOutbox, enqueueImOutbox,
} from '../apps/worker-ant-desktop/src/main/core/im/im-outbox.js';
import {
  MEDIA_UNSUPPORTED_TEXT, mediaUnsupportedReason, channelCapabilities,
} from '../apps/worker-ant-desktop/src/main/core/im/channel-capabilities.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const RD = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

type AnyDb = import('better-sqlite3').Database;

// ── 夹具：列名逐字照 `database.ts` 的真 DDL（`wa_im_outbox` 含 M4 的 media_* 两列）──────────
const SCHEMA = `
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, name TEXT DEFAULT '', config TEXT NOT NULL DEFAULT '{}', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT, status TEXT, context_json TEXT, updated_at TEXT, priority INTEGER);
CREATE TABLE wa_im_outbox (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT,
  kind TEXT DEFAULT 'notification', message TEXT DEFAULT '', attempts INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending', next_retry_at INTEGER, created_at TEXT DEFAULT (datetime('now')),
  last_error TEXT, last_attempt_at TEXT, media_path TEXT, media_kind TEXT);
CREATE TABLE wa_im_conversations (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT, message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound', created_at TEXT DEFAULT (datetime('now')), status TEXT DEFAULT 'sent', last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT '');
`;
// M4 之前出站账的形状（无 media_* 两列）——历史 rr 夹具就是这个形状，明细表不得因此翻不开。
const LEGACY_SCHEMA = SCHEMA.replace(', media_path TEXT, media_kind TEXT', '');

const mkdb = (schema = SCHEMA): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(schema); return d as unknown as AnyDb; };
const seedChannel = (db: AnyDb, id: string, type: string) =>
  db.prepare('INSERT INTO wa_im_channels (id, channel_type, name, status) VALUES (?, ?, ?, ?)').run(id, type, `渠道-${type}`, 'running');

const WECHAT = 'ch-wechat';
const QQ = 'ch-qq';
const USER = 'u-m8';
/** 媒体行的落库形（真列名）：`media_path` 非空 = 这条账发的是**件**。 */
function seedRow(db: AnyDb, o: {
  id: string; channelId: string; status: string; attempts?: number;
  mediaPath?: string; kind?: string; createdAt?: string; nextRetryAt?: number | null;
}): void {
  // created_at 与库内 `datetime('now')` 同口径：**UTC 秒级**文本（不带 Z），供超窗判据按 UTC 解析。
  const createdAt = o.createdAt || new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(
    "INSERT INTO wa_im_outbox (id, channel_id, external_user_id, task_id, kind, message, attempts, status, next_retry_at, created_at, media_path, media_kind) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    o.id, o.channelId, USER, o.kind || 'primary_deliverable', o.mediaPath ? '' : '✅ 任务「B8」已完成',
    o.attempts ?? 0, o.status, o.nextRetryAt ?? null, createdAt,
    o.mediaPath || null, o.mediaPath ? 'file' : null,
  );
}
const statusOf = (db: AnyDb, id: string) => (db.prepare('SELECT status FROM wa_im_outbox WHERE id = ?').get(id) as { status: string } | undefined)?.status;
const attemptsOf = (db: AnyDb, id: string) => (db.prepare('SELECT attempts FROM wa_im_outbox WHERE id = ?').get(id) as { attempts: number } | undefined)?.attempts;
const errOf = (db: AnyDb, id: string) => (db.prepare('SELECT last_error FROM wa_im_outbox WHERE id = ?').get(id) as { last_error: string | null } | undefined)?.last_error;

/** 抓 entry 的假 send（**成功**）——`retryOutboxEntry`/`retryImOutbox` 都可注入，不必碰真实适配器。 */
type Captured = { mediaPath?: string; message: string };
function spySend(ret = true): { calls: Captured[]; send: (e: Captured) => Promise<boolean> } {
  const calls: Captured[] = [];
  return { calls, send: async (e: Captured) => { calls.push(e); return ret; } };
}
async function callNoThrow<T>(fn: () => Promise<T>): Promise<{ threw: boolean; value?: T; err?: string }> {
  try { return { threw: false, value: await fn() }; } catch (e) { return { threw: true, err: (e as Error).message }; }
}

// ═════════════════════════════════════════════════════════════════════════════
// M8-1 该拒（手动路）：不调 send、不抛、attempts 逐位不变、行落 unsupported_media
// ═════════════════════════════════════════════════════════════════════════════
async function m8_1(): Promise<void> {
  console.log('\n[M8-1 「该拒」手动补发：media:false 渠道 + 媒体行 + dead]');
  const db = mkdb();
  seedChannel(db, WECHAT, 'wechat-personal');
  // 真库活标本同形：kind=primary_deliverable / status=dead / attempts=4
  seedRow(db, { id: 'ob-media', channelId: WECHAT, status: 'dead', attempts: 4, mediaPath: '/d/attachments/20260924/report.pdf' });
  const spy = spySend();
  const before = attemptsOf(db, 'ob-media');
  const r = await callNoThrow(() => retryOutboxEntry(db, 'ob-media', { send: spy.send }));

  ok(!r.threw, '**不抛**（此前会硬发下去、由 sendImMedia 抛出后被当普通失败）', r.err || '');
  ok(!r.value?.ok && r.value?.status === 'unsupported_media', '返回 ok:false / status=unsupported_media', `status=${r.value?.status}`);
  eq(r.value?.attempts, before, '**attempts 与调用前逐位相等**（能力不支持不是"这一次没成功"）');
  ok(spy.calls.length === 0, '**没有调 send**（在进入发送之前就拒）', `send 调用 ${spy.calls.length} 次`);
  eq(statusOf(db, 'ob-media'), 'unsupported_media', '**行上状态确已翻**（正面断言：dead → unsupported_media）');
  ok(String(errOf(db, 'ob-media') || '').includes(MEDIA_UNSUPPORTED_TEXT), '账上记了真原因（取自那处真源）', String(errOf(db, 'ob-media')));
}

// ═════════════════════════════════════════════════════════════════════════════
// M8-2 该拒（自动路）：同一个判据、同一份结果；且能力闸在超窗闸之前
// ═════════════════════════════════════════════════════════════════════════════
async function m8_2(): Promise<void> {
  console.log('\n[M8-2 「该拒」自动补发：pending 到期 + 超窗标本]');
  const db = mkdb();
  seedChannel(db, WECHAT, 'wechat-personal');
  const now = Date.now();
  seedRow(db, { id: 'ob-due', channelId: WECHAT, status: 'pending', attempts: 1, mediaPath: '/d/a.pdf', nextRetryAt: now - 1000 });
  // 第二只标本：落账已超窗（时间上是 `dead` 的料）——能力闸在超窗闸之前 ⇒ 仍说结构性问题，不误说"超窗"
  seedRow(db, { id: 'ob-old', channelId: WECHAT, status: 'pending', attempts: 1, mediaPath: '/d/b.pdf', nextRetryAt: now - 1000, createdAt: '2020-01-01 00:00:00' });
  const spy = spySend();
  const before = [attemptsOf(db, 'ob-due'), attemptsOf(db, 'ob-old')];
  const r = await callNoThrow(() => retryImOutbox(db, 60 * 24, { now, send: spy.send }));

  ok(!r.threw, '**不抛**', r.err || '');
  eq(statusOf(db, 'ob-due'), 'unsupported_media', '到期 pending 件行 → unsupported_media');
  eq([attemptsOf(db, 'ob-due'), attemptsOf(db, 'ob-old')], before, '**两行的 attempts 都没动**（不烧次数）');
  ok(spy.calls.length === 0, '自动路同样**没有调 send**', `send 调用 ${spy.calls.length} 次`);
  eq(statusOf(db, 'ob-old'), 'unsupported_media',
    '超窗标本同样落 unsupported_media（能力闸在超窗闸**之前**——一件在发不了件的渠道上放到过期，真相仍是"到不了"）');
}

// ═════════════════════════════════════════════════════════════════════════════
// M8-3/M8-4 不该拒（两只标本）：纯文本行照常补发；能发件的渠道照常发件
// ═════════════════════════════════════════════════════════════════════════════
async function m8_3_4(): Promise<void> {
  console.log('\n[M8-3/M8-4 「不该拒」：纯文本行 + media:true 渠道的媒体行]');
  const db = mkdb();
  const now = Date.now();
  seedChannel(db, WECHAT, 'wechat-personal');
  seedChannel(db, QQ, 'qqbot');
  seedRow(db, { id: 'ob-text', channelId: WECHAT, status: 'dead', attempts: 1 });
  // ⚠ 到期才入扫描面：自动路只取 `next_retry_at IS NOT NULL AND <= now` 的 pending 行。
  seedRow(db, { id: 'ob-qq', channelId: QQ, status: 'pending', attempts: 0, mediaPath: '/d/pic.png', nextRetryAt: now - 1000 });

  const spyText = spySend();
  const rText = await callNoThrow(() => retryOutboxEntry(db, 'ob-text', { send: spyText.send }));
  ok(rText.value?.ok === true && rText.value?.status === 'sent', '**该不拒**①：同渠道的**纯文本**行照常补发成功（正面断言：dead → sent）', `status=${rText.value?.status}`);
  eq(spyText.calls.length, 1, '纯文本行确实走到了 send');
  eq(spyText.calls[0]?.mediaPath, undefined, '且走的是**文本**那支（entry 无 mediaPath）');

  const spyQq = spySend();
  const rQq = await callNoThrow(() => retryImOutbox(db, 60 * 24, { now, send: spyQq.send }));
  ok(!rQq.threw && statusOf(db, 'ob-qq') === 'sent', '**该不拒**②：`media:true` 渠道(qqbot)的媒体行照常补发（正面断言：pending → sent）', `status=${statusOf(db, 'ob-qq')}`);
  ok(spyQq.calls.length === 1 && !!spyQq.calls[0]?.mediaPath, '且抓到的 entry **带 mediaPath**（发的是件，不是文件名文字）', `mediaPath=${spyQq.calls[0]?.mediaPath}`);

  // ⚠ **反向标本**：件在**能发件**的渠道上真发失败 ⇒ 仍走**普通失败路**（attempts 0→1、退回 pending 等退避）。
  //   没有这一格，"不烧次数"就可能被写成"凡是件都不烧次数"——那是把本批的判据从"渠道没这个能力"
  //   悄悄放宽成"件一律不试"，与本轮「能拒的是此刻发不了、不是永远不许试」正相反。
  seedRow(db, { id: 'ob-fail', channelId: QQ, status: 'pending', attempts: 0, mediaPath: '/d/big.zip', nextRetryAt: now - 1000 });
  const spyFail = spySend(false);
  const beforeFail = attemptsOf(db, 'ob-fail');
  const rFail = await callNoThrow(() => retryOutboxEntry(db, 'ob-fail', { send: spyFail.send }));
  ok(spyFail.calls.length === 1 && attemptsOf(db, 'ob-fail') === beforeFail + 1 && statusOf(db, 'ob-fail') === 'pending',
    '**反向**：能发件的渠道上件真发失败 ⇒ 照旧烧次数（正面断言：0 → 1、退回 pending 退避），本批的"不烧次数"**只给"渠道没有这能力"**',
    `attempts ${beforeFail}→${attemptsOf(db, 'ob-fail')} status=${statusOf(db, 'ob-fail')} send=${spyFail.calls.length} 次${rFail.err ? ` err=${rFail.err}` : ''}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// M8-5 同源：理由串来自那处常量；能力表里不许有第二份同义文案
// ═════════════════════════════════════════════════════════════════════════════
async function m8_5(): Promise<void> {
  console.log('\n[M8-5 同源：文案真源唯一]');
  // 判据本身（能力表那一列）——两只标本一起试
  eq(mediaUnsupportedReason('wechat-personal'), MEDIA_UNSUPPORTED_TEXT, '判据函数在该拒的渠道上返回那句真源');
  eq(mediaUnsupportedReason('qqbot'), '', '**不该拒**：能发件的渠道返回空串（不是"恒拒"）');
  ok(channelCapabilities('wechat-personal').note.includes(MEDIA_UNSUPPORTED_TEXT),
    '能力表 `note` 的值就是那句真源（运行期回读）', channelCapabilities('wechat-personal').note);
  ok(mediaUnsupportedReason('这个渠道类型不存在') === MEDIA_UNSUPPORTED_TEXT,
    '未知渠道类型按能力表兜底如实拒绝（与 `media` 列的登记同尺，不静默放行）');

  // 源码面：该值在全文件里**只出现一次**（常量声明处）；调用方一律引用标识符
  const capSrc = stripComments(RD(`${A}/src/main/core/im/channel-capabilities.ts`));
  const inCap = capSrc.split(MEDIA_UNSUPPORTED_TEXT).length - 1;
  eq(inCap, 1, '该文案在能力表源码里**只出现一次**（那处 `MEDIA_UNSUPPORTED_TEXT` 声明）', `扫描面 ${capSrc.length} 字节`);
  // ⚠ 上面那条运行期回读**分不出**"由常量拼出"与"手抄一句同值的"（实测：把内插换成手写同一句，
  //   `note.includes(值)` 仍为真 ⇒ 判据照绿）。故这里查**写法本身**：`wechat-personal` 那一行必须内插标识符。
  const wxLine = capSrc.split('\n').find(l => l.includes("'wechat-personal'")) || '';
  ok(wxLine.includes('${MEDIA_UNSUPPORTED_TEXT}'),
    '**该行内插**该标识符（不是碰巧写着一句同义的）——否则"一处真源"只是句子撞了车', `该行 ${wxLine.length} 字符`);
  const ipcSrc = stripComments(RD(`${A}/src/main/ipc/im.ipc.ts`));
  ok(!ipcSrc.includes(MEDIA_UNSUPPORTED_TEXT), '`sendImMedia` 所在文件不再手写该文案（改为引用共享常量）', `扫描面 ${ipcSrc.length} 字节`);
  const pageSrc = stripComments(RD(`${A}/renderer/src/pages/IMPage.tsx`));
  ok(!pageSrc.includes(MEDIA_UNSUPPORTED_TEXT), '渲染层不手抄该文案（理由由 main 派生下发）', `扫描面 ${pageSrc.length} 字节`);

  // 拒绝时返回的 error 串确实含那处真源的值（在生产函数上取，不在本脚本里手抄）
  const db = mkdb();
  seedChannel(db, WECHAT, 'wechat-personal');
  seedRow(db, { id: 'ob-src', channelId: WECHAT, status: 'dead', attempts: 0, mediaPath: '/d/x.pdf' });
  const r = await retryOutboxEntry(db, 'ob-src', { send: spySend().send });
  ok(String(r.error || '').includes(MEDIA_UNSUPPORTED_TEXT), '拒绝理由串含真源的值', String(r.error));
}

// ═════════════════════════════════════════════════════════════════════════════
// M8-6 不是死结：渠道长出 `sendMedia` 后，`unsupported_media` 行补发得成
// ═════════════════════════════════════════════════════════════════════════════
async function m8_6(): Promise<void> {
  console.log('\n[M8-6 不是死结：可补发集合含 unsupported_media]');
  const db = mkdb();
  seedChannel(db, WECHAT, 'wechat-personal');
  seedRow(db, { id: 'ob-revive', channelId: WECHAT, status: 'unsupported_media', attempts: 2, mediaPath: '/d/y.pdf' });
  const spyNo = spySend();
  const rNo = await callNoThrow(() => retryOutboxEntry(db, 'ob-revive', { send: spyNo.send }));
  ok(rNo.value?.status === 'unsupported_media' && spyNo.calls.length === 0,
    '此刻再点：**当场再拒一次**（能拒的是"此刻发不了"，不是"永远不许试"）', `status=${rNo.value?.status}`);

  // 渠道类型换成能发件的（同一 channel_id）——"适配器补上了 sendMedia"的最小可观测替身
  db.prepare("UPDATE wa_im_channels SET channel_type = 'qqbot' WHERE id = ?").run(WECHAT);
  const spyYes = spySend();
  const rYes = await callNoThrow(() => retryOutboxEntry(db, 'ob-revive', { send: spyYes.send }));
  ok(rYes.value?.ok === true && statusOf(db, 'ob-revive') === 'sent',
    '**正面断言**：能力变成 `media:true` 后照样补发得成（unsupported_media → sent）——否则这一态是永久死结', `status=${statusOf(db, 'ob-revive')}`);
  eq(spyYes.calls[0]?.mediaPath, '/d/y.pdf', '且发的是那件（entry 仍带 mediaPath）');

  // 反向：入站复活只管 blocked_quota，不碰这一态（"等人入站"解决不了"渠道发不了件"）
  const db2 = mkdb();
  seedChannel(db2, WECHAT, 'wechat-personal');
  seedRow(db2, { id: 'ob-bq', channelId: WECHAT, status: 'blocked_quota', attempts: 0, mediaPath: '/d/z.pdf' });
  seedRow(db2, { id: 'ob-us', channelId: WECHAT, status: 'unsupported_media', attempts: 0, mediaPath: '/d/z.pdf' });
  const revived = reviveQuotaBlockedOutbox(db2, USER);
  eq(revived, 1, '`reviveQuotaBlockedOutbox` 只复活 blocked_quota 一行');
  eq([statusOf(db2, 'ob-bq'), statusOf(db2, 'ob-us')], ['pending', 'unsupported_media'], '该态**不**被人入站复活（等的是渠道长出能力，不是等人说话）');
}

// ═════════════════════════════════════════════════════════════════════════════
// M8-7 界面如实：main 派生的结论字段 / 分组与文案在位 / 终态说终态 / 旧库可读
// ═════════════════════════════════════════════════════════════════════════════
async function m8_7(): Promise<void> {
  console.log('\n[M8-7 界面如实：派生字段 + 分组文案 + 两说 + 旧库可读]');
  const db = mkdb();
  seedChannel(db, WECHAT, 'wechat-personal');
  seedChannel(db, QQ, 'qqbot');
  seedRow(db, { id: 'l-media', channelId: WECHAT, status: 'dead', attempts: 4, mediaPath: '/d/r.pdf' });
  seedRow(db, { id: 'l-text', channelId: WECHAT, status: 'dead', attempts: 4 });
  seedRow(db, { id: 'l-qq', channelId: QQ, status: 'dead', attempts: 4, mediaPath: '/d/r.pdf' });
  seedRow(db, { id: 'l-us', channelId: WECHAT, status: 'unsupported_media', attempts: 4, mediaPath: '/d/r.pdf' });
  const rows = listOutbox(db);
  const byId = (id: string) => rows.find(r => r.id === id)!;

  eq(byId('l-media').channel_type, 'wechat-personal', '明细带出 `channel_type`（补发路/界面取能力表所需的键）');
  eq(byId('l-media').media_path, '/d/r.pdf', '明细带出 `media_path`（"这是不是一条件"由它定）');
  ok(byId('l-media').media_unsupported === true && byId('l-media').media_unsupported_reason === MEDIA_UNSUPPORTED_TEXT,
    '**该命中**：发不了件的渠道 + 媒体行 ⇒ 派生字段为真、理由即那句真源', JSON.stringify(byId('l-media').media_unsupported_reason));
  // 两个条件缺一不可——三只标本各试一边
  ok(byId('l-text').media_unsupported === false, '**该不命中**：同渠道的**文本**行（media_path 为空）不受影响');
  ok(byId('l-qq').media_unsupported === false, '**该不命中**：能发件的渠道 + 媒体行不受影响');
  ok(byId('l-text').media_unsupported_reason === '', '不命中时理由为空串（界面 title 不显示空话）');

  // 统计：新取值由既有 `other` 兜底（**正面断言**：dead 三行仍归 dead、新态恰落 other=1，不静默消失）。
  //   ⚠ 不新增 `OutboxStats` 键：整对象 `eq()` 断言散在既有脚本里(`rr_zx_20260911_5`/`rr_zx_20260912`)，
  //   加键会连带弄红它们——那些脚本本批不许改。故新态走既有 `other`，界面明细另立分组(见下)。
  //   （zx_20260930 M4-3 的处置：界面要"逐状态各几条"，**仍不加键**——另立 `outboxStatusCounts` 纯函数，
  //    折叠档与未折叠档同出一次 `GROUP BY status`；此处 `other` 的兜底语义因此逐字未变。）
  const s = outboxStats(db);
  eq([s.dead, s.other], [3, 1], '`outboxStats` 的 other 兜住新态（横幅在全为该态时照样出场）');

  // 旧库（无 media_* 列）——明细表**照样翻得开**
  const legacy = mkdb(LEGACY_SCHEMA);
  seedChannel(legacy, WECHAT, 'wechat-personal');
  legacy.prepare("INSERT INTO wa_im_outbox (id, channel_id, external_user_id, kind, message, attempts, status, created_at) VALUES ('leg-1', ?, ?, 'notification', 'x', 0, 'dead', '2026-09-24 00:00:00')").run(WECHAT, USER);
  const legOk = await callNoThrow(async () => listOutbox(legacy));
  ok(!legOk.threw, '旧库/旧夹具（无 `media_*` 列）`listOutbox` 不抛 `no such column`（账翻得开）', legOk.err || '');
  eq(legOk.value?.[0]?.media_unsupported, false, '旧库上派生态如实为假（不猜）');

  // 渲染层：分组表/文案/两说——源码面（renderer 不在 main 侧扫描面内，须单独看这一处）
  const pageSrc = stripComments(RD(`${A}/renderer/src/pages/IMPage.tsx`));
  ok(pageSrc.includes('unsupported_media') && /OUTBOX_GROUP_LABEL[^;]*unsupported_media/.test(pageSrc),
    '`OUTBOX_GROUP_LABEL` 有该态的中文文案（界面不许显示生字符串）', `扫描面 ${pageSrc.length} 字节`);
  // 订正（zx_20260930 M4-3，**改钉更强的真源、非放宽**）：分组表原先是**写死五个字面量**的数组
  //   （`['pending','blocked_quota','unsupported_media','dead','sent'].map(`），故旧判据只能问
  //   "那张清单里有没有它"——清单本身就是漏网的入口（新态漏在清单外 ⇒ 行整段不渲染）。
  //   现在成员由**统计**（`byStatus`，即 main 侧那次 `GROUP BY status`）派生、次序表只定先后，
  //   于是拆成两条更强的判据：①该态在次序表里挂号（有位置）②组键由统计派生（成员不可能被清单筛掉）。
  ok(/OUTBOX_GROUP_ORDER\s*=\s*\[[^\]]*'unsupported_media'[^\]]*\]/.test(pageSrc),
    '分组次序表登记该态（有位置；中文文案见上一条）');
  ok(/Object\.keys\(outboxCounts\)/.test(pageSrc) && /outboxGroupKeys\.map\(/.test(pageSrc),
    '分组**成员由统计派生**（`outboxGroupKeys` 含统计里出现的每个态）——新态不可能被清单筛掉，行照样渲染');
  ok(pageSrc.includes('media_unsupported') && pageSrc.includes('media_unsupported_reason'),
    '渲染层消费 main 派生的 `media_unsupported(_reason)`（不自己判能力表）');
  ok(/disabled=\{[^}]*media_unsupported/.test(pageSrc), '补发钮对这类行**置灰**（V-10 裁定：禁用不隐藏）');
  const handle = pageSrc.slice(pageSrc.indexOf('async function handleOutboxRetry'), pageSrc.indexOf('const convChannelRef'));
  ok(handle.includes('unsupported_media') && handle.includes('仍会继续补发') && handle.includes('最终未送达'),
    '补发结果按 status 分两说：**还没成**(仍会继续补发) / **已经不会成了**(最终未送达/不会再送达)'
    + '（此前不论青红皂白都说「未送达」）', `切出 handleOutboxRetry ${handle.length} 字符`);
}

// ═════════════════════════════════════════════════════════════════════════════
// M8-8 落账侧不受影响（同一本账）：件行仍然是"件"
// ═════════════════════════════════════════════════════════════════════════════
function m8_8(): void {
  console.log('\n[M8-8 反证：落账侧未被本批改动波及]');
  const db = mkdb();
  seedChannel(db, WECHAT, 'wechat-personal');
  enqueueImOutbox(db, { channelId: WECHAT, externalUserId: USER, taskId: 't-1', kind: 'notification', message: '', mediaPath: '/d/n.pdf', mediaKind: 'file' });
  const row = db.prepare('SELECT status, attempts, media_path FROM wa_im_outbox').get() as Record<string, unknown>;
  eq([row.status, row.attempts, row.media_path], ['pending', 0, '/d/n.pdf'],
    '**落账照旧**：新账行仍是 pending/0 次（拒发生在**补发时**，不是落账时——刚落的账还要走正常退避）');
  const cast = channelCapabilities('wechat-personal');
  ok(cast.media === false, '**其余渠道条目的 media 取值一字未动**（那是按适配器实际有无 sendMedia 的如实登记）',
    `wechat-personal.media=${cast.media} / qqbot.media=${channelCapabilities('qqbot').media} / dingtalk.media=${channelCapabilities('dingtalk').media} / feishu.media=${channelCapabilities('feishu').media} / wecom.media=${channelCapabilities('wecom').media}`);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n【S】build 钉（派生核对，不写轮次字面量）');
checkBuildPins(ok, { distDir: path.join(root, `${A}/dist`) });

async function main(): Promise<void> {
  await m8_1();
  await m8_2();
  await m8_3_4();
  await m8_5();
  await m8_6();
  await m8_7();
  m8_8();
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260924_1_b8: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}
void main();
