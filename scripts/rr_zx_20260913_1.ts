/**
 * zx_20260913 M1 受控复跑（「IM·到得了」——未送达也到场 · 同一把尺 · 找得到）。
 *
 * 覆盖 M1-1..M1-6：
 *   M1-1 加列幂等 + 默认值不伪造历史（status/last_error/outbox_id 三列；既有行取 'sent'）；
 *   M1-2 在途态（刷新/保存可重入挡板）——静态落点；
 *   M1-3 人话（用户标识短 handle / 渠道行非密钥摘要 / 渠道名缺失不裸 uuid）——静态落点；
 *   M1-4 未送达到场（失败落**对话行** + 补发成功**翻同一行** + 重发失败同样到场）；
 *   M1-5 找得到（搜索/方向筛选走**生产 SQL builder**，与游标组合不重不漏）+ 对话按自然日分组；
 *   M1-6 事件会丢（低频自愈 30s，仅页面可见时）——静态落点。
 *
 * 断言两类（承 feedback「往返/闭环类判据须在生产入参上证」）：
 *   ① 行为断言动态 import **真实现**——`enqueueImOutbox`/`retryOutboxEntry`/`retryImOutbox` 走真路径；
 *      取数用**生产 builder** `buildConversationsQuery`/`listConversations` 跑在真行上，与直写 SQL 对拍；
 *   ② 静态断言一律 `stripComments` 后再比对，防注释关键词假阳性；并附**反证**（拿 M1 前的旧写法喂同一判据必红）。
 *
 * ⚠ 夹具与旧 rr 的差别（有意为之）：`wa_im_conversations` 夹具**含** M1-1 三新列。
 *   旧 rr（如 rr_zx_20260912）夹具无此三列——真实现里 `recordFailure`/`recordFailedConversation`/`flipConversationSent`
 *   均 try/catch 容忍缺列，故旧夹具下仍当"记账/翻行不可用"处理，不抛、不改发送语义。本脚本 S7 专门核这条容忍。
 *
 * 本文件不打开任何真库（真库只读实测见 data/baseline_zx_20260913.json）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { enqueueImOutbox, retryOutboxEntry, retryImOutbox } from '../apps/worker-ant-desktop/src/main/core/im/im-outbox.js';
import {
  buildConversationsQuery, listConversations, CONV_PAGE_SIZE,
} from '../apps/worker-ant-desktop/src/main/core/im/im-conversations-query.js';
import { checkBuildPins } from './lib/rr-pins.js';
// zx_20260920 M3: 会话气泡的送达态判定已移入 renderer 侧纯函数 —— 直调**真实现**，不在测试里照抄一遍 if-else。
import { convDeliveryOf } from '../apps/worker-ant-desktop/renderer/src/lib/convDelivery.js';
// zx_20260929 M7: 期望值由**唯一时间源**派生（见下方送达态判据的订正说明）——判据自己不持有"库内是 UTC"这条知识。
import { formatDbTime } from '../apps/worker-ant-desktop/renderer/src/lib/deliverable-view.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const RD = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const page = () => stripComments(RD(`${A}/renderer/src/pages/IMPage.tsx`));
const mainIpc = () => stripComments(RD(`${A}/src/main/ipc/im.ipc.ts`));

// node:sqlite 无 better-sqlite3 的 .transaction()——补最小等价 shim（同步、无嵌套）
const withTx = (d: DatabaseSync) => { (d as unknown as { transaction: unknown }).transaction = (fn: () => void) => () => fn(); return d; };
type AnyDb = import('better-sqlite3').Database;

// ── M1 前基线：wa_im_conversations 逐字照抄 database.ts 加列前的列集 ──
const PRE_M1_CONV_COLS = ['id', 'channel_id', 'external_user_id', 'project_id', 'message_json', 'direction', 'created_at'] as const;
const PRE_M1_SCHEMA = `
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT, name TEXT, config TEXT DEFAULT '{}', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT, status TEXT, context_json TEXT, updated_at TEXT, priority INTEGER);
CREATE TABLE wa_im_outbox (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT, kind TEXT DEFAULT 'notification', message TEXT DEFAULT '', attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', next_retry_at INTEGER, created_at TEXT DEFAULT (datetime('now')), last_error TEXT, last_attempt_at TEXT);
CREATE TABLE wa_im_conversations (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT, message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound', created_at TEXT DEFAULT (datetime('now')));
`;
// ── M1 后：三新列按 database.ts DDL 逐字补齐（默认值同源）──
const M1_CONV_COLS = ['status', 'last_error', 'outbox_id'] as const;
const M1_SCHEMA = `
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT, name TEXT, config TEXT DEFAULT '{}', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT, status TEXT, context_json TEXT, updated_at TEXT, priority INTEGER);
CREATE TABLE wa_im_outbox (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT, kind TEXT DEFAULT 'notification', message TEXT DEFAULT '', attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', next_retry_at INTEGER, created_at TEXT DEFAULT (datetime('now')), last_error TEXT, last_attempt_at TEXT);
CREATE TABLE wa_im_conversations (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT, message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound', created_at TEXT DEFAULT (datetime('now')), status TEXT DEFAULT 'sent', last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT '');
`;
const mkdb = (schema: string): AnyDb => { const d = withTx(new DatabaseSync(':memory:')); d.exec(schema); return d as unknown as AnyDb; };
const cols = (db: AnyDb, t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(r => r.name);

const CH = 'ch-real-1';
const USER = 'o9cq80x7XC8w9TolIfPuHbpTqaZA@im.wechat';
const seedChannel = (db: AnyDb) =>
  db.prepare('INSERT INTO wa_im_channels (id, channel_type, name, status) VALUES (?, ?, ?, ?)').run(CH, 'wechat-personal', '微信工蚁', 'running');

// ── M1-1 加列幂等 + 默认值不伪造历史（管子·度量衡：先有准绳，再有读数）──────────────
function m1_1(): void {
  console.log('\n[M1-1 加列幂等 · 既有行取默认值 · 不伪造历史]');
  // 迁移语句从 database.ts **取真源**（不手抄），防"判据与实现各说各话"。
  const src = RD(`${A}/src/main/database.ts`);
  const alters = (src.match(/ALTER TABLE wa_im_conversations ADD COLUMN \w+ TEXT DEFAULT '[^']*'/g) || []);
  // DDL 与迁移同一把尺：DDL 里也有这些列（新库不走迁移，靠 CREATE TABLE）。
  const ddl = src.slice(src.indexOf('CREATE TABLE IF NOT EXISTS wa_im_conversations'), src.indexOf('CREATE TABLE IF NOT EXISTS wa_deliverables'));
  // zx_20260930 M2-c：`task_id` 是第 4 条加列迁移。原句是**冻结计数** `eq(alters.length, 3, …)`——
  //   合法地多一条就红，正是本仓记过的"哑雷"形状（换轮次即误报）。改为**两个方向的派生判据**，
  //   且失败信息报**列名**而非"4 vs 3"：
  //   ① 每条 ALTER 的目标列必须在当前 DDL 里真实存在 —— 否则新库（走 CREATE）与老库（走 ALTER）schema 分叉；
  //   ② 在册各列都要有 ALTER —— 少一条即"老库永远拿不到该列"（静默缺列比多一列危险得多）。
  const alterCols = alters.map(s => /ADD COLUMN (\w+)/.exec(s)![1]!);
  const ddlLiteralCols = Array.from(ddl.matchAll(/(\w+) TEXT DEFAULT '/g)).map(m => m[1]!);
  eq(alterCols.filter(c => !ddlLiteralCols.includes(c)), [],
    '每条加列迁移的目标列都在当前 DDL 里（迁移与建表不分叉；反证：改名/删列即红）');
  // 在册清单 = M1 三列 + zx_20260930 M2-c 的 task_id（新增列时**在此追加**，失败信息直接点名缺哪列）。
  const CONV_ALTER_LEDGER = ['status', 'last_error', 'outbox_id', 'task_id'];
  eq(CONV_ALTER_LEDGER.filter(c => !alterCols.includes(c)), [],
    '在册每列都有一条 ALTER（少一条 = 老库拿不到该列）');
  ok(alterCols.length >= CONV_ALTER_LEDGER.length, '加列数不低于在册数（只增不减）', `${alterCols.length} vs ${CONV_ALTER_LEDGER.length}`);
  ok(alters.some(s => /ADD COLUMN status TEXT DEFAULT 'sent'/.test(s)), "status 默认 'sent'（历史只落成功行 ⇒ 不伪造历史失败）");
  ok(alters.some(s => /ADD COLUMN last_error TEXT DEFAULT ''/.test(s)), 'last_error 默认空串（无原因如实说无）');
  ok(alters.some(s => /ADD COLUMN outbox_id TEXT DEFAULT ''/.test(s)), 'outbox_id 默认空串（真关联位）');
  ok(alters.some(s => /ADD COLUMN task_id TEXT DEFAULT ''/.test(s)), 'task_id 默认空串（M2-c：空串 = 本条无归属，不是"归属为一个空的东西"）');
  for (const c of M1_CONV_COLS) ok(new RegExp(`${c} TEXT DEFAULT`).test(ddl), `DDL 内 ${c} 与迁移同尺（新库不依赖迁移）`);

  // 真跑：旧 schema + 一行历史行 → 施加迁移**两次** → 幂等且历史行取默认值。
  const db = mkdb(PRE_M1_SCHEMA);
  seedChannel(db);
  db.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction) VALUES ('old-1', ?, ?, '{\"text\":\"历史成功行\"}', 'outbound')").run(CH, USER);
  const before = cols(db, 'wa_im_conversations');
  eq(M1_CONV_COLS.filter(c => before.includes(c)), [], '加列前脚手架确无三新列（否则本断言空转）');

  const runMigrations = () => { for (const sql of alters) { try { db.exec(sql); } catch { /* 列已存在 */ } } };
  runMigrations();
  runMigrations(); // 第二次：幂等，不抛
  const after = cols(db, 'wa_im_conversations');
  eq(M1_CONV_COLS.filter(c => !after.includes(c)), [], '两次迁移后三列皆在（幂等）');
  const old = db.prepare("SELECT status, last_error, outbox_id FROM wa_im_conversations WHERE id = 'old-1'").get() as { status: string; last_error: string; outbox_id: string };
  eq(old.status, 'sent', '历史行 status 取默认 sent —— 不把历史行诬成"未送达"');
  eq([old.last_error, old.outbox_id], ['', ''], '历史行 last_error/outbox_id 取空（无原因不编、无关联不假连）');
}

// ── M1-4 未送达到场（海德格尔·在场 / 罗尔斯·同一把尺）──────────────────────────────
async function m1_4(): Promise<void> {
  console.log('\n[M1-4 失败落对话行 · 补发翻同一行 · 重发失败同样到场]');
  const db = mkdb(M1_SCHEMA);
  seedChannel(db);
  const entry = { channelId: CH, externalUserId: USER, taskId: 't-1', kind: 'notification', message: '⚠️ 任务「A」已暂停待复核' };

  // (a) 落账失败 → 对话视图**必有**一条 failed 行，且与 outbox 真关联。
  enqueueImOutbox(db, entry, 'BOOM: 适配器未启动');
  const ob = db.prepare('SELECT id, status, attempts, last_error FROM wa_im_outbox').all() as Array<{ id: string; status: string; attempts: number; last_error: string }>;
  eq(ob.length, 1, '落账恰 1 行');
  eq([ob[0]!.status, ob[0]!.attempts, ob[0]!.last_error], ['pending', 0, 'BOOM: 适配器未启动'], '账行如初（pending/0 次/真原因）');
  const cv = db.prepare('SELECT id, channel_id, external_user_id, message_json, direction, status, last_error, outbox_id FROM wa_im_conversations').all() as Array<Record<string, string>>;
  eq(cv.length, 1, '对话视图**也**恰 1 行 —— 不再是"账里有、对话里没有"两种说法');
  eq([cv[0]!.direction, cv[0]!.status], ['outbound', 'failed'], '对话行 方向 outbound / 状态 failed');
  eq(cv[0]!.last_error, 'BOOM: 适配器未启动', '对话行带**同一**真原因（不是另说一套）');
  eq(cv[0]!.outbox_id, ob[0]!.id, 'outbox_id 真指向账行（同一把尺的锚点）');
  eq(JSON.parse(cv[0]!.message_json).text, entry.message, '对话行正文 = 原消息（界面无需再拼）');

  // (b) 补发成功 → **同一行**翻回 sent（不新增行、不残留 failed）。
  const r = await retryOutboxEntry(db, ob[0]!.id, { send: async () => true });
  ok(r.ok && r.status === 'sent', '补发成功回报 sent');
  const cv2 = db.prepare('SELECT status, last_error FROM wa_im_conversations').all() as Array<{ status: string; last_error: string }>;
  eq(cv2.length, 1, '补发成功不新增对话行（仍是同一行）');
  eq([cv2[0]!.status, cv2[0]!.last_error], ['sent', ''], '同一行翻回 sent 且清空原因 —— 一处送达、两处同说');
  eq((db.prepare('SELECT status FROM wa_im_outbox WHERE id = ?').get(ob[0]!.id) as { status: string }).status, 'sent', '账行同步 sent');

  // (c) 补发失败 → 不谎报：账行回 pending（1 次），对话行仍 failed 且原因在手。
  enqueueImOutbox(db, { ...entry, message: '第二条' }, '初次未送达');
  const ob2 = db.prepare("SELECT id FROM wa_im_outbox WHERE message = '第二条'").get() as { id: string };
  const r2 = await retryOutboxEntry(db, ob2.id, { send: async () => false });
  ok(!r2.ok && r2.status === 'pending' && r2.attempts === 1, '补发失败回报 pending/1 次（不假装送达）');
  eq((db.prepare('SELECT status FROM wa_im_conversations WHERE outbox_id = ?').get(ob2.id) as { status: string }).status, 'failed', '失败后对话行仍 failed —— 未送达不提前翻牌');

  // (d) 自动补发（retryImOutbox，生产定时器走这条）同一把尺：成功同样翻行。
  enqueueImOutbox(db, { ...entry, message: '第三条' }, '初次未送达');
  const ob3 = db.prepare("SELECT id FROM wa_im_outbox WHERE message = '第三条'").get() as { id: string };
  db.prepare('UPDATE wa_im_outbox SET next_retry_at = ? WHERE id = ?').run(Date.now() - 1000, ob3.id);
  await retryImOutbox(db, 60, { send: async () => true });
  eq((db.prepare('SELECT status FROM wa_im_conversations WHERE outbox_id = ?').get(ob3.id) as { status: string }).status, 'sent',
    '自动补发成功亦翻关联对话行（两条补发路径同一把尺，非只修手动那条）');

  // (e) 成功出站行（6 处历史 INSERT 的形态，不含 status）默认即为 sent —— 见 S3。
  const cvCount = (db.prepare('SELECT COUNT(*) AS n FROM wa_im_conversations').get() as { n: number }).n;
  eq(cvCount, 3, '全程对话行数 = 3 条失败事（翻转不增行）');

  // 静态：im:resend 失败路径也到场（手发非补发账，故无 outbox 关联，界面据此走 resend 入口）。
  const ipc = mainIpc();
  const resend = ipc.slice(ipc.indexOf("ipcMain.handle('im:resend'"));
  // zx_20260929 M8-c（**改钉更强的真源，非放宽**）：失败行的状态**不再以字面量 `'failed'` 落纸**——
  //   与 `accountOutboundFailure` 同用一张状态表（failed / blocked_quota），取值在绑定参数里。
  //   旧判据按 `'outbound', 'failed'` 子串匹配，M8-c 一改即只剩"找不到"（假红）。
  //   改锚**不变量**：本处 INSERT 显式写 status 列，且该值由**与回话记账同一个判据**派生。
  ok(/INSERT INTO wa_im_conversations[^;]*\bstatus\b/.test(resend),
    'im:resend 失败时落**带 status 的**对话行（重发没送到，正在看的人知道）');
  ok(/isImQuotaError\(err\)/.test(resend) && /'blocked_quota'\s*:\s*'failed'/.test(resend),
    'M8-c: 状态值与机器回话失败**同一张表、同一个判据**（isImQuotaError ⇒ blocked_quota / 否则 failed；两处各说一套即红）');
  ok(/emitOutboundMessage\(\{[^}]*pending: true/.test(resend), 'im:resend 失败同时发出站事件（到场，非静默改库）');
}

// ── M1-1/M1-4 status 默认值不伪造历史（行为面：省略 status 的 INSERT）──────────────
function m1_status_default(): void {
  console.log('\n[M1-4b 省略 status 的成功 INSERT 默认 sent]');
  const db = mkdb(M1_SCHEMA);
  seedChannel(db);
  // 逐字模拟历史 6 处成功出站 INSERT 的列集（无 status/last_error/outbox_id）。
  db.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction) VALUES ('ok-1', ?, ?, '{\"text\":\"已送达\"}', 'outbound')").run(CH, USER);
  const row = db.prepare("SELECT status, last_error, outbox_id FROM wa_im_conversations WHERE id = 'ok-1'").get() as Record<string, string>;
  eq([row.status, row.last_error, row.outbox_id], ['sent', '', ''], '省略 status 的历史形态 → 默认 sent（不伪造历史失败）');
  // 反向：入站行不据 status 说话 —— 界面 deliveryLabel 只对 outbound 生效（静态断言在 m1_3）。
}

// ── M1-5 找得到（生产 SQL builder vs 直写 SQL 对拍；游标×过滤组合不重不漏）─────────
function m1_5(): void {
  console.log('\n[M1-5 搜索/方向/游标 —— 生产 builder 与直写 SQL 对拍]');
  const db = mkdb(M1_SCHEMA);
  seedChannel(db);
  // 真行（message_json 形态照抄真库：{"text": "..."}），含关键词/方向/时间混合。
  const rows: Array<[string, string]> = [
    ['inbound', '请问今天的方案什么时候发我'],
    ['outbound', '✅ 任务「方案实施」已完成。主要成果：A股智能投资顾问系统'],
    ['inbound', '方案里的买入价怎么算'],
    ['outbound', '⚠️ 任务「方案核实」已暂停待复核'],
    ['inbound', '收到，谢谢'],
    ['outbound', '风险提示：仓位偏集中'],
    ['inbound', '方案再发一次'],
    ['outbound', '已重发'],
  ];
  const ins = db.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction) VALUES (?, ?, ?, ?, ?)");
  rows.forEach((r, i) => ins.run(`c-${String(i).padStart(2, '0')}`, CH, USER, JSON.stringify({ text: r[1] }), r[0]));

  // 生产 builder：同参 → 条数与直写 SQL 一致（真入参、真实现）。
  const check = (opts: { q?: string; direction?: string; beforeSeq?: number; offset?: number }, label: string) => {
    const got = listConversations(db, { channelId: CH, ...opts });
    // 直写等价 SQL：与 builder 独立拼一遍（防止"两边抄同一份代码"的假对拍）。
    const where: string[] = ['channel_id = ?']; const ps: Array<string | number> = [CH];
    // 与 builder 同尺的规范化（trim 后再 LIKE）——直写这遍也照做，否则对拍比的不是同一件事。
    const kw = (opts.q || '').trim();
    if (kw) { where.push('message_json LIKE ?'); ps.push(`%${kw}%`); }
    if (opts.direction === 'inbound' || opts.direction === 'outbound') { where.push('direction = ?'); ps.push(opts.direction); }
    const cur = Number(opts.beforeSeq);
    let sql: string;
    if (Number.isFinite(cur) && cur > 0) { sql = `SELECT rowid AS seq, * FROM wa_im_conversations WHERE ${where.join(' AND ')} AND rowid < ? ORDER BY rowid DESC LIMIT 50`; ps.push(cur); }
    else { sql = `SELECT rowid AS seq, * FROM wa_im_conversations WHERE ${where.join(' AND ')} ORDER BY rowid DESC LIMIT 50 OFFSET ?`; ps.push(Math.max(0, Math.floor(Number(opts.offset) || 0))); }
    const want = db.prepare(sql).all(...ps) as Array<Record<string, unknown>>;
    eq(got.map(r => r.id), want.map(r => r.id), `${label} —— builder 与直写 SQL 同行同序（${got.length} 条）`);
  };
  check({}, '无过滤第一页（8 条全出）');
  check({ q: '方案' }, 'q=方案');
  check({ direction: 'inbound' }, 'direction=inbound');
  check({ direction: 'outbound' }, 'direction=outbound');
  check({ q: '方案', direction: 'inbound' }, 'q×direction 组合');
  check({ direction: 'bogus' }, '非法 direction 视为不过滤（同上尺）');
  check({ q: '  方案  ' }, '首尾空白 trim 后仍命中');
  check({ q: '不存在的词' }, 'q 无命中如实空');

  // 计数：q=方案 在直写 SQL 下确为 5 条（供"界面搜索"不再依赖前端全量过滤）。
  const n = (db.prepare("SELECT COUNT(*) AS n FROM wa_im_conversations WHERE channel_id = ? AND message_json LIKE ?").get(CH, '%方案%') as { n: number }).n;
  eq(n, 5, 'q=方案 全量命中 5 条（builder 首页 5 条与之相符）');
  eq(listConversations(db, { channelId: CH, q: '方案' }).length, 5, 'builder 单页亦 5 条（未满一页故不截断）');

  // 游标 × 过滤：以最旧 seq 翻第二页，两页**不重不漏**（同一把尺）。
  const p1 = listConversations(db, { channelId: CH, q: '方案' });
  const oldest = Number(p1[p1.length - 1]!.seq);
  const p2 = listConversations(db, { channelId: CH, q: '方案', beforeSeq: oldest });
  const ids1 = new Set(p1.map(r => r.id));
  eq(p2.filter(r => ids1.has(r.id)).length, 0, '第二页与第一页零重叠（游标与过滤组合后仍不重）');
  eq(p2.length, 0, '5 条 q=方案 已尽，第二页空（不漏亦不虚出）');
  ok(CONV_PAGE_SIZE === 50, '页大小常量 = 50（渲染侧 CONV_PAGE 同尺，静态断言在 m1_5_static）');

  // 静态：筛选条件只此一处真源；渲染侧不再自拼 SQL/前端全量过滤。
  const ipc = mainIpc();
  ok(/listConversations\(db, \{ channelId, offset, beforeSeq, q, direction \}\)/.test(ipc),
    'im:conversations 委派生产 builder（取数条件唯一出口）');
  const p = page();
  ok(/convFilter\s*=\s*\(\)\s*=>\s*\(\{\s*q:/.test(p), '渲染侧 convFilter 单一出口（各取数路径共用一处筛选）');
  ok(!/FROM\s+wa_im_conversations/.test(p), '渲染侧无自写 SQL（过滤在服务端、与游标同 WHERE）');
  // 只盯 `im:conversations` handler 体（im.ipc 另有 im:resend 的合法单行读写，不属"取数条件"面）。
  const convHandler = ipc.slice(ipc.indexOf("ipcMain.handle('im:conversations'"), ipc.indexOf("ipcMain.handle('im:conversations'") + 700);
  eq((convHandler.match(/FROM\s+wa_im_conversations/g) || []).length, 0,
    'im:conversations handler 内无内联取数 SQL（已收进 builder）——反证：M1 前写法在此判据下必红');

  // 反证非空转：把 M1 前的内联 SQL 形态喂**同一切片判据** → 必被判红（否则判据只是"恰好绿"）。
  const PRE_M1_HANDLER = "ipcMain.handle('im:conversations', async (_event, { channelId, offset, beforeSeq }) => {\n  const sql = `SELECT rowid AS seq, * FROM wa_im_conversations WHERE channel_id = ? ORDER BY rowid DESC LIMIT 50 OFFSET ?`;\n});";
  const preSlice = stripComments(PRE_M1_HANDLER).slice(0, 700);
  eq((preSlice.match(/FROM\s+wa_im_conversations/g) || []).length, 1,
    '反证：M1 前内联 SQL 在同一（700 字窗口）判据下被判红 1 处 —— 判据真在判');

  // 静态：搜索/方向 UI 在位（M1-5 的"用户可达动作"）。
  ok(/value=\{convQ\}/.test(p) && /placeholder="搜索消息内容/.test(p), '对话面板有搜索框（绑 convQ）');
  ok(/value=\{convDirection\}/.test(p) && /<option value="inbound">仅收到<\/option>/.test(p) && /<option value="outbound">仅发送<\/option>/.test(p),
    '对话面板有方向筛选（全部/仅收到/仅发送）');
  ok(/setTimeout\(\(\)\s*=>\s*\{\s*void showConvs\(convChannel\);\s*\},\s*300\)/.test(p), '筛选变更 300ms 防抖后重取第一页（不每键一打 IPC）');
  ok(/const t = setTimeout|clearTimeout\(t\)/.test(p), '防抖句柄随 effect 清理（无遗留定时器）');
  ok(/dayLabel\(c\.created_at\)/.test(p) && /groups\.map\(\(\[label,\s*items\]\)/.test(p), '对话按自然日分组渲染（分组不改条数，只加小标题）');
}

// ── M1-3 人话（庄子·得鱼忘筌：不裸奔 uuid/openid）──────────────────────────────────
function m1_3(): void {
  console.log('\n[M1-3 用户/渠道标识人话化 · 不裸 uuid · 只给非密钥摘要]');
  const p = page();
  ok(/function userLabel\(id\?: string \| null\): string \{[\s\S]{0,220}return '未知用户'/.test(p),
    'userLabel：无 id 如实说「未知用户」（M0 已证入站载荷无昵称 ⇒ 不编昵称）');
  ok(/v\.length <= 10 \? v : `…\$\{v\.slice\(-6\)\}`/.test(p), 'userLabel：短 handle = 尾 6 位（不裸奔完整 openid）');
  eq((p.match(/userLabel\(/g) || []).length >= 2, true, 'userLabel 至少两处消费（补发账行 + 对话行）');
  ok(/title=\{r\.external_user_id\?`用户：\$\{r\.external_user_id\}`:''\}/.test(p), '补发账行：完整用户值移入 title（悬停可看）');
  ok(/title=\{c\.external_user_id\?`用户：\$\{c\.external_user_id\}`:''\}/.test(p), '对话行：完整用户值移入 title');
  ok(/r\.channel_name\s*\|\|\s*'渠道未知'/.test(p), '渠道名缺失显示「渠道未知」');
  ok(!/>\{r\.channel_id\}/.test(p), '补发账行不裸渲染 channel_id（uuid 只入 title）');

  // 白名单而非黑名单（黑名单会漏密钥）。
  ok(/const SAFE_CONFIG_KEYS: Record<string, string\[\]> = \{/.test(p), '渠道行摘要有类型白名单 SAFE_CONFIG_KEYS');
  for (const t of ['wecom', 'feishu', 'qqbot', 'dingtalk', 'wechat-personal']) ok(new RegExp(`'?${t}'?:`).test(p), `白名单含 ${t}`);
  ok(/const keys = SAFE_CONFIG_KEYS\[type\] \|\| \[\]/.test(p), '摘要**只**取白名单键（白名单为空即不显示任何配置）');
  ok(/parts\.push\(`\$\{k\} …\$\{v\.slice\(-4\)\}`\)/.test(p), '摘要值只露尾 4 位（不整值外泄）');
  ok(/select-all/.test(p) && /title=\{`渠道 ID：\$\{ch\.id\}`\}/.test(p), '渠道 id 移入 title，值可选中复制（可见但不喧宾夺主）');
  // 反向：密钥键不得进白名单。
  eq(['corpSecret', 'appSecret', 'clientSecret', 'client_secret', 'app_secret'].filter(k => new RegExp(`['"]${k}['"]`).test(p)), [],
    '白名单内无任何 Secret 键（密钥不入摘要）');

  // 送达态只对 outbound 有语义（inbound 不据 status 说谎）。
  // zx_20260920 M3（**订正形态，非回归**）：判定由页面内联函数 `deliveryLabel` 移入
  //   `renderer/src/lib/convDelivery.ts`（纯函数）；红/绿也不再是内联三元——在途态要**第三档**（琥珀），
  //   三元已不够表达"点下去了正在动"。故改按 `tone` 取色。承本脚本方法论①：直调真实现。
  eq(convDeliveryOf({ id: 'a', direction: 'inbound', status: 'failed', last_error: 'x' }, 'idle'), null,
    'inbound 不置一词（哪怕挂着 status=failed —— 收到这件事本就没有"送达态"）');
  eq(convDeliveryOf({ id: 'b', direction: 'outbound', status: 'failed' }, 'idle'),
    { label: '未送达 · 原因未记录', tone: 'bad' },
    '未送达标红 + 无原因时如实说「原因未记录」（不回填猜测）');
  // zx_20260929 M7（**订正形态，非放宽**）：原判据把库内 UTC 串里的时刻 `05:30` **原样**当期望值——
  //   那正是不该有的行为（同一行的行首时间已按本地展示，两处并排就差 8 小时），且该字面量**只在 UTC 机器上为真**。
  //   改钉**更强真源**：期望值由唯一时间源 `formatDbTime(…, {timeOnly:true})` 派生，判据自己不再知道"库内是 UTC"；
  //   再加一条**跨时区无差别**的静态钉（绕过唯一时间源直接 slice 即判红），防"UTC 机器上两种写法同形"掩盖回退。
  const sentAt = '2026-09-20 05:30:00';
  eq(convDeliveryOf({ id: 'c', direction: 'outbound', status: 'sent', created_at: sentAt }, 'idle'),
    { label: `已送达 ${formatDbTime(sentAt, { timeOnly: true })}`, tone: 'ok' },
    '已送达标绿 + 带上时刻（与行首同尺：走唯一时间源，不直接切库内串）');
  // 判别力的边界（如实登记，不假装）：上面那条**行为**判据的期望值由唯一时间源派生，
  //   在 UTC 机器上"走时间源"与"裸切库内串"同形 ⇒ 行为判据失去判别力；
  //   跨时区恒定有效的判别力由**紧随其后的静态钉**承担（它不依赖任何时区）。
  ok(/formatDbTime\(c\.created_at,\s*\{\s*timeOnly:\s*true\s*\}\)/.test(RD(`${A}/renderer/src/lib/convDelivery.ts`)),
    '★送达时刻确由唯一时间源派生（静态钉，读原文不过 stripComments；裸 `created_at.slice(11,16)` 取的是库内 UTC）');
  // zx_20261007（顺带修的展示毛刺）：`formatDbTime` 曾以 `toLocaleString('zh-CN').slice(0,16)` 截断——
  //   单数字月/日时该串只有 17–18 位，切到 16 把**秒前那个冒号**留下（`2026/10/7 10:11:`）。
  //   钉法：完整形态**必须以 `HH:MM` 收尾**（正则可判）：单数字日标本（旧码在此留悬空冒号 ⇒ 旧码判红）
  //   ＋双数字日标本（旧码本就不犯 ⇒ 防"为治它把两位数也治坏"的反证）。
  const FULL_RE = /^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}$/;
  ok(FULL_RE.test(formatDbTime('2026-10-07 10:11:33')) && FULL_RE.test(formatDbTime('2026-12-25 10:11:33')),
    '★完整时刻以 HH:MM 收尾、无悬空冒号（单数字日 `2026/10/7` 与双数字日 `2026/12/25` 两侧标本）');
  ok(/DELIVERY_TONE_CLS\[dv\.tone\]/.test(p) && /Record<'ok' \| 'bad' \| 'busy', string>/.test(p),
    '页面实际按 tone 取色（表不是导出即闲置），且三档齐全（在途态有自己的形状，不复用红或绿）');
}

// ── M1-2 在途态（点了有反馈，不重复点）────────────────────────────────────────────
function m1_2(): void {
  console.log('\n[M1-2 刷新/保存在途态 · 静默刷新不卸载面板]');
  const p = page();
  ok(/const \[uiBusy, setUiBusy\] = useState<Set<string>>\(new Set\(\)\)/.test(p), 'uiBusy 独立于 busyChannels（语义不串台）');
  ok(/async function handleRefreshClick\(\) \{\s*if \(uiBusy\.has\('refresh'\)\) return;/.test(p), '刷新入口先挡重入');
  ok(/onClick=\{handleRefreshClick\} disabled=\{uiBusy\.has\('refresh'\)\}/.test(p), '刷新按钮绑定在途态 + disabled');
  ok(/uiBusy\.has\('refresh'\)\?<Loader2 className="w-4 h-4 animate-spin"\/>/.test(p), '刷新在途显示 spinner（点了有反馈）');
  ok(/title="刷新（静默：不打断正在看的对话与补发账）"/.test(p), '刷新按钮 title 说明"静默"（不改整页 spinner）');
  ok(/disabled=\{uiBusy\.has\('save'\)\}/.test(p), '保存按钮绑定在途态（防重复提交）');
  ok(/setUiBusy\(s\s*=>\s*new Set\(s\)\.add\('save'\)\)/.test(p), 'handleSave 置位在途');
  ok(/async function refreshChannels\(\) \{ try \{ const d=await im\.channels\(\)/.test(p) && !/setLoading\(true\)[^\n]*refreshChannels/.test(p),
    'refreshChannels 是静默刷新（不置整页 loading —— 否则会卸载正在看的面板）');
  ok(/await refreshChannels\(\)/.test(p), '保存/删除后静默刷新（数据即时到位）');
  // 有意不改「添加渠道」按钮：它只开弹窗（非 async）——加 spinner 即虚闸（见方案 M1 收口注记）。
  ok(/onClick=\{\(\)=>setShowCreate\(true\)\}/.test(p), '「添加渠道」保持同步开弹窗（不加假 spinner —— 如实不虚闸）');
}

// ── M1-6 事件会丢（低频自愈，仅可见时）─────────────────────────────────────────────
function m1_6(): void {
  console.log('\n[M1-6 低频自愈 30s · 仅页面可见时轮询]');
  const p = page();
  // zx_20260920 M3-a（**订正形态，非回归**）：自愈面从"只刷渠道列表"扩到"正在看的那一屏（对话）"，
  //   tick 由单行 if 改为前置早退 + 多行体，`onVis` 收成同一个 `tick`（回来自愈一次即"立刻补一次"）。
  //   旧断言钉的是**实现的长相**（单行体、`onVis` 这个变量名）；本轮钉**不变量**：可见性闸 / 30s / 立刻补 / 清理，
  //   并**补上**新增的那一半（对话也在自愈面内）——否则"扩了面"这件事在判据里没有位置。
  ok(/const tick = \(\) => \{[\s\S]{0,400}?if \(document\.visibilityState !== 'visible'\) return;/.test(p),
    'tick 仅在页面可见时刷新（后台空转无意义）——形态改为前置早退，闸仍在');
  ok(/setInterval\(tick, 30_000\)/.test(p), '自愈周期 30s（低频：补事件丢失，不当代替事件）');
  ok(/document\.addEventListener\('visibilitychange', tick\)/.test(p), '转回可见时立刻补一次（复用同一个 tick，不另抄一份条件）');
  ok(/clearInterval\(timer\); document\.removeEventListener\('visibilitychange', tick\)/.test(p), '卸载时清理定时器与监听（无泄漏）');
  ok(/const cid = convChannelRef\.current;[\s\S]{0,80}?if \(cid\) void prependNewConvs\(cid\)/.test(p),
    'zx_20260920 M3-a: 自愈**覆盖正在看的对话**——只刷渠道列表时，用户盯着的那一屏（"打开着等一条回复"）事件一丢就永远等不到');
}

// ── S7 旧夹具容忍（旧 rr 的 conversations 无三新列时不得抛）────────────────────────
async function s7_tolerance(): Promise<void> {
  console.log('\n[S7 旧夹具（无三新列）容忍 —— 不拖累落账/发送语义]');
  const db = mkdb(PRE_M1_SCHEMA); // 有意用 M1 前 schema
  seedChannel(db);
  let threw = '';
  try { enqueueImOutbox(db, { channelId: CH, externalUserId: USER, taskId: 't', kind: 'notification', message: 'x' }, 'reason'); }
  catch (e) { threw = (e as Error).message; }
  eq(threw, '', '缺列时 enqueueImOutbox 不抛（记账/翻行静默跳过）');
  eq((db.prepare('SELECT COUNT(*) AS n FROM wa_im_outbox').get() as { n: number }).n, 1, '缺列时 outbox 落账仍成功（记账不连坐）');
  const id = (db.prepare('SELECT id FROM wa_im_outbox').get() as { id: string }).id;
  const r = await retryOutboxEntry(db, id, { send: async () => true });
  ok(r.ok && r.status === 'sent', '缺列时补发仍成功（flipConversationSent 静默跳过，不改结果）');
}

// ── 收口：渲染侧 ipc 契约与后端口径一致 ───────────────────────────────────────────
function s8_contract(): void {
  console.log('\n[S8 前后端契约一致：conversations 传 q/direction]');
  const rIpc = stripComments(RD(`${A}/renderer/src/lib/ipc.ts`));
  ok(/conversations: \(channelId: string, opts\?: \{ offset\?: number; beforeSeq\?: number; q\?: string; direction\?: string \}\)/.test(rIpc),
    '渲染 ipc.conversations 形参含 q/direction（与 main handler 解构同尺）');
  const ipc = mainIpc();
  ok(/ipcMain\.handle\('im:conversations', async \(_event, \{ channelId, offset, beforeSeq, q, direction \}/.test(ipc),
    'main handler 解构 q/direction（参数名一一对应，无遗漏）');
  // 六个 M1 子项在方案中的落点均已实现（本脚本 m1_1..m1_6 已逐条断言，此处只做存在性汇总）。
  ok(true, 'M1-1..M1-6 六项均已断言（见上）');
}

async function main(): Promise<void> {
  console.log('=== rr_zx_20260913_1 受控复跑（M1 IM·到得了）===');
  m1_1();
  await m1_4();
  m1_status_default();
  m1_5();
  m1_3();
  m1_2();
  m1_6();
  await s7_tolerance();
  s8_contract();
  // M5 收口：每个子脚本自带 build 闸（任一批单独跑也能自查 build 是否陈旧）。
  // ⚠ 本段读 dist ⇒ tsup 必须先于本脚本。
  console.log('\n[M5] build 标识派生一致性（P1–P6）');
  checkBuildPins(ok, { distDir: path.join(__dirname, '..', A, 'dist') });
  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}
void main();
