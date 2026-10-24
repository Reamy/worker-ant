/**
 * zx_20260911_5 受控复跑（「账要翻得开：汇总可下钻 · 失败不静默 · 注入择其要」）。
 *
 * 覆盖：M1 出站补发账可翻开（S1 四态穷尽 / S2 逐条明细 / S3 单条补发语义 / S4 落账即发事件 / S5 端到端接线）；
 *       M2 IM 界面不自欺（S1 徽标如实 / S2 静默 catch 归零 / S3 对话分页 offset 真语义 / S4 二维码收口）；
 *       M3 成果可翻开（S1 列表行接抽屉 / S2 code 同一把尺 / S3 本地直达判据真行为 / S4 截断·回落如实）；
 *       M4 记忆择要注入（S1 整段取舍真行为 / S2 优先级表 / S3 端到端按值取舍+如实注记 / S4 同参只取一次 / S5 度量与红线）；
 *       M5 收口注记（S1–S4 build 标识**派生一致性**（订正于 zx_20260912 M5：不再手抄字面量/清单，改用 scripts/lib/rr-pins.ts）
 *       / S5 dist 端到端实证 / S6 计数）。
 *       ⚠ M5/S1–S4（P6）·S5 读 `dist`，故 **tsup 必须先于本脚本**。
 *
 * 断言两类（承 zx_20260911_2 §九 与 feedback「往返/闭环类判据须在生产入参上证」）：
 *   静态断言一律 `stripComments` 后再比对，防注释里的关键词造成假阳性；
 *   行为断言动态 import **真实现**，输入取**真库逐条入参**（见下 REAL_OUTBOX）——
 *   渠道/用户/kind/消息文本均照抄真库，不用"等价自造入参"。
 *
 * 本文件不打开任何真库（真库只读实测见 data/baseline_zx_20260911_5.json）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
import {
  listOutbox, outboxStats, retryOutboxEntry, enqueueImOutbox,
  OUTBOX_MAX_ATTEMPTS,
} from '../apps/worker-ant-desktop/src/main/core/im/im-outbox.js';
import { ImQuotaError } from '../apps/worker-ant-desktop/src/main/core/im/im-errors.js';
import { buildConversationsQuery } from '../apps/worker-ant-desktop/src/main/core/im/im-conversations-query.js';
import { eventBus } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';
// zx_20260924_1 M7-c: 记忆装配整块迁出到 `core/memory-context.js`（取舍纯函数/优先级表/装配函数同在彼处）。
//   `CTX_MEMORY_MAX_CHARS` **仍留在执行体**（C35 钉其可从执行体 import），预算以实参传入——
//   故此处**import 常量**当实参，免得在调用点另写一个 6000（那才是"另立阈值"）。
import {
  buildMemoryContext, selectMemorySections, sectionPriority, MEM_SECTION_PRIORITY,
  type MemSection,
} from '../apps/worker-ant-desktop/src/main/core/memory-context.js';
import { CTX_MEMORY_MAX_CHARS } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import type { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const rd = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// node:sqlite 无 better-sqlite3 的 .transaction()——补最小等价 shim（同步执行，无嵌套）
const withTx = (d: DatabaseSync) => { (d as unknown as { transaction: unknown }).transaction = (fn: () => void) => () => fn(); return d; };
type AnyDb = import('better-sqlite3').Database;

// 订正（M3 落地时）：wa_im_outbox 补 last_error/last_attempt_at——M3 后 `listOutbox` 的 SELECT 已含这两列，
//   夹具不补则本脚本所有 listOutbox 调用直接抛 "no such column: o.last_error"。
const SCHEMA = `
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT, status TEXT, context_json TEXT, updated_at TEXT, priority INTEGER);
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT, name TEXT, config TEXT, status TEXT, created_at TEXT);
CREATE TABLE wa_im_outbox (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT, kind TEXT DEFAULT 'notification', message TEXT DEFAULT '', attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', next_retry_at INTEGER, created_at TEXT DEFAULT (datetime('now')), last_error TEXT, last_attempt_at TEXT);
CREATE TABLE wa_im_conversations (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, message_json TEXT, direction TEXT, created_at TEXT);
`;
const mkdb = (): AnyDb => { const d = withTx(new DatabaseSync(':memory:')); d.exec(SCHEMA); return d as unknown as AnyDb; };

// ── 生产入参夹具（真库 data/worker-ant-server.db，2026-09-11 只读实测）──
// 真库 4 行的 channel/user/kind/消息前缀逐字照抄（消息正文截断处补全为完整句，供全文展示断言）。
const REAL_CHANNEL = 'e7fd4565-4f7e-49fb-a9ad-1aa832db6311';
const REAL_USER = 'o9cq80x7XC8w9TolIfPuHbpTqaZA@im.wechat';
const REAL_ROWS: Array<{ id: string; kind: string; msg: string; attempts: number; status: string }> = [
  { id: '9bf94524', kind: 'notification', msg: '✅ 任务「20260911-1 方案实施」已完成。\n📄 主要成果：A股智能投资顾问系统', attempts: 3, status: 'dead' },
  { id: '95464104', kind: 'notification', msg: '✅ 任务「[Sub] 取回 A_20260911_1 实施所需的精确源码片段」已完成。', attempts: 3, status: 'dead' },
  { id: '3dadf56b', kind: 'pause_needed', msg: '⚠️ 任务「20260911-1 方案实施」已暂停待复核：产出内容多次未通过充分性校验。', attempts: 3, status: 'dead' },
  { id: '86dcd34c', kind: 'pause_needed', msg: '⚠️ 任务「20260910方案核实」已暂停待复核：目标已多次偏离，已停止自动恢复。', attempts: 3, status: 'sent' },
];
function seedReal(db: AnyDb, extra?: { blocked?: number; pending?: number }): void {
  db.prepare("INSERT INTO wa_im_channels (id, channel_type, name, status) VALUES (?, 'wechat-personal', '微信主号', 'running')").run(REAL_CHANNEL);
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES ('t-real', 'p1', '20260910方案核实', 'paused')").run();
  const ins = db.prepare("INSERT INTO wa_im_outbox (id, channel_id, external_user_id, task_id, kind, message, attempts, status, next_retry_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (const r of REAL_ROWS) ins.run(r.id, REAL_CHANNEL, REAL_USER, r.id === '86dcd34c' ? 't-real' : null, r.kind, r.msg, r.attempts, r.status, null, '2026-09-11 03:37:51');
  for (let i = 0; i < (extra?.blocked ?? 0); i++) ins.run(`bq-${i}`, REAL_CHANNEL, REAL_USER, null, 'notification', '⏳ 等待配额恢复', 0, 'blocked_quota', Date.now(), '2026-09-11 04:00:00');
  for (let i = 0; i < (extra?.pending ?? 0); i++) ins.run(`pd-${i}`, REAL_CHANNEL, REAL_USER, null, 'ask_user', '❓ 请确认是否继续', 0, 'pending', Date.now(), '2026-09-11 04:01:00');
}
const statusOf = (db: AnyDb, id: string) => (db.prepare('SELECT status FROM wa_im_outbox WHERE id = ?').get(id) as { status: string } | undefined)?.status;
const attemptsOf = (db: AnyDb, id: string) => (db.prepare('SELECT attempts FROM wa_im_outbox WHERE id = ?').get(id) as { attempts: number } | undefined)?.attempts;
const nextAtOf = (db: AnyDb, id: string) => (db.prepare('SELECT next_retry_at AS n FROM wa_im_outbox WHERE id = ?').get(id) as { n: number | null } | undefined)?.n;

type SendFn = (row: { channelId: string; externalUserId: string; taskId: string; kind: string; message: string }) => Promise<boolean>;
const sendOk: SendFn = async () => true;
const sendFalse: SendFn = async () => false;
const sendQuota: SendFn = async () => { throw new ImQuotaError('配额耗尽'); };

async function m1(): Promise<void> {
  // ── S1 四态穷尽：blocked_quota 不再漏计 ─────────────────────────────
  console.log('\n[M1/S1 outboxStats 四态穷尽（含 blocked_quota + other 兜底）]');
  {
    const db = mkdb(); seedReal(db, { blocked: 2, pending: 1 });
    const s = outboxStats(db);
    eq(s, { pending: 1, blocked_quota: 2, dead: 3, sent: 1, other: 0 }, '真库 4 行 + 2 blocked + 1 pending 逐态计数');
    // 未知态也须被兜住（康德·范畴穷尽：不得有"看不见"的行）
    db.prepare("INSERT INTO wa_im_outbox (id, status) VALUES ('u1', 'weird_state')").run();
    eq(outboxStats(db).other, 1, '未知状态计入 other，不静默消失');
    // 反证：旧实现只认三态会漏 blocked_quota ⇒ 现实现必须 > 0
    ok(outboxStats(db).blocked_quota === 2, 'blocked_quota 计入（旧实现恒 0 ⇒ 全 blocked 时横幅消失）');
  }

  // ── S2 逐条明细：JOIN 渠道名/任务标题 + 全文 + 过滤/排序/上限 ────────
  console.log('\n[M1/S2 listOutbox 逐条明细（得鱼忘筌）]');
  {
    const db = mkdb(); seedReal(db, { blocked: 1 });
    const all = listOutbox(db);
    eq(all.length, 5, '默认返回全部 5 行');
    ok(all.every(r => r.channel_name === '微信主号'), 'LEFT JOIN 渠道名可达（不再是裸 id）');
    const deadRows = listOutbox(db, { status: 'dead' });
    eq(deadRows.length, 3, 'status=dead 过滤 = 真库 3 条');
    ok(deadRows.every(r => r.status === 'dead'), '过滤后状态齐一');
    ok(deadRows.every(r => r.attempts === 3), '真库 dead 行 attempts=3 如实带出');
    const one = listOutbox(db).find(r => r.id === '86dcd34c');
    eq(one?.task_title, '20260910方案核实', 'task_id 命中时带出任务标题');
    ok(!!one && one.message.includes('目标已多次偏离'), '消息全文带出（不是截断预览）');
    eq(listOutbox(db, { limit: 2 }).length, 2, 'limit 生效');
    eq(listOutbox(db, { limit: 9999 }).length, 5, 'limit 超上限被夹到实际行数（不报错）');
  }

  // ── S3 单条手动补发：与自动补发同一套语义 ───────────────────────────
  console.log('\n[M1/S3 retryOutboxEntry 单条补发（王阳明·知行合一）]');
  {
    // 3a 成功 → sent, attempts+1, next_retry_at 清空
    const db = mkdb(); seedReal(db);
    const r = await retryOutboxEntry(db, '9bf94524', { now: 1000, send: sendOk });
    ok(r.ok && r.status === 'sent', 'dead 行补发成功 → ok/sent');
    eq(statusOf(db, '9bf94524'), 'sent', 'DB 状态置 sent');
    eq(attemptsOf(db, '9bf94524'), 4, 'attempts 3 → 4');
    eq(nextAtOf(db, '9bf94524'), null, 'next_retry_at 清空');

    // 3b 配额类失败 → blocked_quota 且 attempts 不增（不烧次数）
    const db2 = mkdb(); seedReal(db2);
    const r2 = await retryOutboxEntry(db2, '3dadf56b', { now: 1000, send: sendQuota });
    ok(!r2.ok && r2.quota === true && r2.status === 'blocked_quota', '配额类失败 → blocked_quota + quota 标记');
    eq(attemptsOf(db2, '3dadf56b'), 3, '配额类失败 **不烧** attempts（仍 3）');
    eq(statusOf(db2, '3dadf56b'), 'blocked_quota', 'DB 状态置 blocked_quota');

    // 3c 普通失败且未到上限 → 回 pending 并排下次补发（退避 1/2/4）
    const db3 = mkdb(); seedReal(db3);
    db3.prepare("UPDATE wa_im_outbox SET attempts = 0 WHERE id = '95464104'").run();
    const r3 = await retryOutboxEntry(db3, '95464104', { now: 5000, send: sendFalse });
    ok(!r3.ok && r3.status === 'pending', '普通失败(attempts 0→1) → 回 pending');
    eq(attemptsOf(db3, '95464104'), 1, 'attempts 0 → 1');
    eq(nextAtOf(db3, '95464104'), 5000 + 1 * 60_000, 'next_retry_at = now + 退避 1min');

    // 3d 普通失败且达上限 → dead
    const db4 = mkdb(); seedReal(db4);
    const r4 = await retryOutboxEntry(db4, '3dadf56b', { now: 5000, send: sendFalse });
    ok(!r4.ok && r4.status === 'dead', `attempts 3 → ${OUTBOX_MAX_ATTEMPTS} 达上限 → dead`);
    eq(statusOf(db4, '3dadf56b'), 'dead', 'DB 状态置 dead');

    // 3e 已 sent / 不存在：如实回报，不假装
    const db5 = mkdb(); seedReal(db5);
    const rSent = await retryOutboxEntry(db5, '86dcd34c', { send: sendOk });
    ok(!rSent.ok && rSent.status === 'sent' && !!rSent.error, '已 sent 行 → 如实拒绝（不重复发）');
    const rMissing = await retryOutboxEntry(db5, 'nope', { send: sendOk });
    ok(!rMissing.ok && rMissing.status === 'not_found', '不存在的行 → not_found');
  }

  // ── S4 落账即时报（M1-5：失败不再静默） ─────────────────────────────
  console.log('\n[M1/S4 enqueueImOutbox 落账即发事件（复用 im.message_outbound）]');
  {
    const db = mkdb(); seedReal(db);
    let captured: Record<string, unknown> | null = null;
    const h = async (e: { data: Record<string, unknown> }) => { captured = e.data; };
    eventBus.on('im.message_outbound', h);
    enqueueImOutbox(db, { channelId: REAL_CHANNEL, externalUserId: REAL_USER, taskId: 't-real', kind: 'notification', message: '测试落账事件' });
    await new Promise(r => setTimeout(r, 5));
    ok(!!captured, '落账后事件已到达（此前失败完全不上报）');
    ok(captured?.pending === true, '事件带 pending:true，界面据此区分"未送达已入账"');
    ok(captured?.channelId === REAL_CHANNEL && captured?.channel_id === REAL_CHANNEL, 'channelId/channel_id 双写（界面两种取法都命中）');
    eq(captured?.channel_type, 'wechat-personal', '事件带真实渠道类型（lookupChannelType）');
    eq(listOutbox(db, { status: 'pending' }).length, 1, '落账确实写入一行 pending');
    eventBus.off('im.message_outbound', h);
  }

  // ── S5 防「做了没用上」：IPC 注册 + 页面接线 ────────────────────────
  console.log('\n[M1/S5 端到端接线（防头大脚轻/做了没用上）]');
  {
    const ipc = stripComments(rd(`${A}/src/main/ipc/im.ipc.ts`));
    ok(ipc.includes("ipcMain.handle('im:outboxList'"), 'main 注册 im:outboxList');
    ok(ipc.includes("ipcMain.handle('im:outboxRetry'"), 'main 注册 im:outboxRetry');
    // 订正（zx_20260930 M4-3，**改钉更强的真源、非放宽**）：handler 现在一次回两个口径——
    //   折叠档 `outboxStats` 与**未折叠**的 `outboxStatusCounts`。旧判据只钉前者、且钉的是整句字面量
    //   （改一个空格就红，是"形状"不是"实质"）；新判据钉实质：**两个口径都取自纯函数**（handler 里
    //   不出现计数 SQL），故"一处真源"这句话在**多口径**下依然成立。
    ok(/return \{ data: \{ \.\.\.outboxStats\(_dbForIm\), byStatus: outboxStatusCounts\(_dbForIm\) \} \}/.test(ipc),
      'outboxStats 真源单一（两个口径同出纯函数，handler 不自拼 SQL）');
    ok(!/COUNT\(\*\)/.test(ipc), 'handler 内**没有**自己的计数 SQL（计数真源只在 im-outbox）');
    const page = stripComments(rd(`${A}/renderer/src/pages/IMPage.tsx`));
    ok(page.includes("invoke('im:outboxList'"), 'IMPage 调用 im:outboxList');
    ok(page.includes("invoke('im:outboxRetry'"), 'IMPage 调用 im:outboxRetry');
    ok(page.includes('OUTBOX_GROUP_LABEL') && page.includes('blocked_quota'), 'IMPage 渲染四态分组（含 blocked_quota）');
    const oe = stripComments(rd(`${A}/src/main/core/im/outbound-event.ts`));
    ok(oe.includes('pending?: boolean') && oe.includes('args.pending'), 'outbound-event 支持 pending 标记');
    const oo = stripComments(rd(`${A}/src/main/core/im/im-outbox.ts`));
    ok(oo.includes('emitOutboundMessage('), 'im-outbox 落账即发事件');
  }
}

async function m2(): Promise<void> {
  // ── S1 状态徽标如实：error 不再冒充「已停止」 ────────────────────────
  console.log('\n[M2/S1 状态徽标如实（意义即用法）]');
  {
    const page = stripComments(rd(`${A}/renderer/src/pages/IMPage.tsx`));
    ok(page.includes('CH_STATUS_META'), '引入状态元表（单一真源）');
    ok(/error:\s*\{\s*label:'异常'/.test(page), 'error → 「异常」（旧三元落入 else 显示「已停止」）');
    // 订正形态（zx_20260912 M6/G8，**非回归**）：徽标/启停此后统一经 `const sm = statusMeta(ch.status)` 取一次词表，
    // 故不再存在 `statusMeta(ch.status).label` 与裸比 `ch.status==='error'` 这两串字面量；行为等同，改钉新形态。
    ok(/const sm\s*=\s*statusMeta\(ch\.status\)/.test(page) && /sm\.label/.test(page), '徽标改走 statusMeta（不再内联三元；G8 后收敛为"渠道行只取一次词表"）');
    ok(/error:\s*\{[^}]*start:'重新启动'/.test(page) && /sm\.start&&/.test(page), '异常渠道可「重新启动」（如实显示却无法处置 = 没修）');
  }

  // ── S2 错误不静默：8 处 catch{} 归零 ────────────────────────────────
  console.log('\n[M2/S2 关键操作错误不静默（如实）]');
  {
    const page = stripComments(rd(`${A}/renderer/src/pages/IMPage.tsx`));
    const silent = (page.match(/catch\s*\{\s*\}/g) || []).length;
    eq(silent, 0, 'IMPage 静默 catch{} 归零（旧实现 8 处：保存/启停/删除/二维码/对话/诊断）');
    ok(/\$\{editing \? '保存' : '添加'\}渠道失败/.test(page) || /\$\{editing\?'保存':'添加'\}渠道失败/.test(page), '保存/添加渠失败如实上报');
    ok(page.includes('启动渠道失败') && page.includes('停止渠道失败') && page.includes('删除渠道失败'), '启停删失败如实上报');
    ok(page.includes('读取对话失败') && page.includes('加载更多对话失败') && page.includes('诊断失败'), '对话/诊断失败如实上报');
    ok(page.includes('获取二维码失败'), '二维码失败如实上报');
  }

  // ── S3 对话分页：页语义（生产 SQL 直取） ────────────────────────────
  // 订正（zx_20260912 M2-4 落地时）：排序由 `created_at DESC`(秒级并列不稳) 改为 `rowid DESC` + rowid 游标页。
  // 订正（zx_20260913 M1-5 落地时，**非回归**）：取数 SQL 由 `im.ipc.ts` 内联**抽出**为唯一出口
  //   `core/im/im-conversations-query.ts`（`buildConversationsQuery`）——"im:conversations 与受控复跑同源"。
  //   故此处不再从 ipc 里刮字符串，改为**直接动态 import 生产 builder**跑真 SQL（比刮文本更强：跑的是真函数）。
  //   "加载更多"可达 / 页语义 / 参数化 OFFSET / 排序稳定 等**能力**断言全部保留。
  console.log('\n[M2/S3 对话历史可达（上手状态）]');
  {
    const qmod = rd(`${A}/src/main/core/im/im-conversations-query.ts`);
    ok(/export function buildConversationsQuery/.test(qmod), '取数条件有唯一出口 buildConversationsQuery（真源）');
    ok(/FROM wa_im_conversations WHERE \$\{filter\} AND rowid < \? ORDER BY rowid DESC/.test(qmod),
      '游标页 SQL 为生产原文（rowid < 界 + ORDER BY rowid DESC，同一把尺）');
    ok(/FROM wa_im_conversations WHERE \$\{filter\} ORDER BY rowid DESC LIMIT \$\{CONV_PAGE_SIZE\} OFFSET \?/.test(qmod),
      '首页 SQL 同样按 rowid 排序 + 参数化 OFFSET（旧实现 LIMIT 50 到顶）');
    ok(/export const CONV_PAGE_SIZE = 50/.test(qmod), '页大小常量 = 50（与渲染侧 CONV_PAGE 同尺）');
    ok(/message_json LIKE \?/.test(qmod) && /channel_id = \?/.test(qmod) && !/\$\{[^}]*\}\s*LIKE/.test(qmod),
      '过滤条件一律**参数化绑定**（q 只作 LIKE 值，无拼接注入面）');
    // 行为：真 builder + 60 行真夹具 → 首页 50 / 次页 10 / 无重叠 / 合起来是完整 DESC 序列
    {
      const db = mkdb();
      const ins = db.prepare('INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at) VALUES (?,?,?,?,?,?)');
      for (let i = 0; i < 60; i++) ins.run(`c-${i}`, 'ch1', 'u1', `{"text":"m${i}"}`, i % 2 ? 'inbound' : 'outbound', `2026-09-11 03:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`);
      const first = buildConversationsQuery({ channelId: 'ch1', offset: 0 });
      const second = buildConversationsQuery({ channelId: 'ch1', offset: 50 });
      const p1 = db.prepare(first.sql).all(...first.params) as Array<{ id: string }>;
      const p2 = db.prepare(second.sql).all(...second.params) as Array<{ id: string }>;
      eq(p1.length, 50, '第 1 页 50 条（LIMIT 50）');
      eq(p2.length, 10, '第 2 页 10 条（OFFSET 50 生效）');
      eq(p1[0].id, 'c-59', 'DESC 序：最新在前');
      ok(!p1.some(r => p2.some(x => x.id === r.id)), '两页无重叠（追加不会重复）');
      eq([...p1, ...p2].map(r => r.id).length, 60, '两页合起来 == 全部 60 条');
    }
    const lib = stripComments(rd(`${A}/renderer/src/lib/ipc.ts`));
    ok(/conversations:\s*\(channelId: string, opts\?: \{ offset\?: number; beforeSeq\?: number; q\?: string; direction\?: string \}\)/.test(lib),
      'lib/ipc 透传 offset + 游标 beforeSeq + 过滤 q/direction');
    const page = stripComments(rd(`${A}/renderer/src/pages/IMPage.tsx`));
    ok(page.includes("'加载更多'"), '面板有「加载更多」');
    ok(page.includes('[...prev, ...list]'), '按追加而非整体替换（整体替换会跳滚动位）');
    ok(page.includes('convHasMore'), '本页 <50 条判定无更多（与 main LIMIT 50 同尺）');
  }

  // ── S4 二维码不卡死：无码如实 + 终态收口 ────────────────────────────
  console.log('\n[M2/S4 二维码弹窗不卡死（上手状态）]');
  {
    const page = stripComments(rd(`${A}/renderer/src/pages/IMPage.tsx`));
    ok(page.includes('function closeQr()'), '统一收口入口 closeQr');
    ok(/function closeQr\(\)\s*\{[\s\S]*?clearInterval[\s\S]*?setQrChannel\(null\)/.test(page), 'closeQr 清轮询 + 关弹窗');
    ok(page.includes('qrHardStopRef'), '8 分钟硬上限句柄可清（旧实现 setTimeout 后从不清理）');
    ok(page.includes("st==='expired'") && page.includes("q?.status==='expired'"), '过期态：弹窗内如实说明 + 轮询终态收口');
    ok(page.includes('该渠道不支持扫码登录'), 'unsupported 如实告知（不冒充"加载中"）');
    ok(/onClick=\{closeQr\}/.test(page), '关闭按钮/遮罩同样清轮询（旧实现手动关闭会漏）');
    ok(page.includes('qrMsg.text'), '无码时弹窗渲染 qrMsg 说明文本');
    ok(/qrChannel\.img\?<img[\s\S]{0,240}qrMsg\?<p/.test(page), '渲染优先级：有图→二维码图；否则 qrMsg 说明；最后才回落"加载中"');
  }
}

// 从源码里**直取**正则字面量（含转义扫描），供行为复算——不另抄一份判据
function extractRegexLiteral(src: string, startMarker: string): string | null {
  const i = src.indexOf(startMarker);
  if (i < 0) return null;
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === '/') return src.slice(i, j + 1);
    j++;
  }
  return null;
}
// 从源码里直取单行表达式，用 new Function 在生产表达式本身上复算
function extractExpr(src: string, re: RegExp): string | null {
  const m = src.match(re);
  return m ? m[1] : null;
}

async function m3(): Promise<void> {
  // ── S1 列表行接就地抽屉（得鱼忘筌） ─────────────────────────────────
  console.log('\n[M3/S1 产出物列表行可点开就地抽屉（得鱼忘筌）]');
  {
    const page = stripComments(rd(`${A}/renderer/src/pages/DeliverablesPage.tsx`));
    ok(page.includes('useDeliverableDrawer'), '注册既有抽屉（此前 5 个成果入口里唯此页不接，E5）');
    ok(page.includes('const { open: openDeliv } = useDeliverableDrawer()'), '取 open 句柄');
    ok(page.includes("boolSetting(settings['deliverable.doc_drawer'])"), '与其余入口同一门控（doc_drawer）');
    // zx_20260929 M7: 门控关时补了回落分支（有产出任务 ⇒ 跳任务页），故判据由"整行字面量"改为两分支各自成立。
    ok(page.includes('if (drawerOn) openDeliv(d.id)'), '行 onClick 受门控开门（门控关时不自造第二个落点）');
    ok(/else if \(d\.task_id\) navigate\(`\/tasks\/\$\{d\.task_id\}`\)/.test(page),
      '门控关且有产出任务 ⇒ 回落跳任务（同一行两分支，二者必居其一）');
    const stops = (page.match(/stopPropagation\(\)/g) || []).length;
    ok(stops >= 4, `行内按钮吞冒泡 ≥4 处（不误触开抽屉），实测 ${stops}`);
    ok(page.includes("onClick={e => e.stopPropagation()}>") && page.includes('justify-end" onClick'), '操作列整体吞冒泡（一键不触两事）');
  }

  // ── S2 code 与 doc/ui 同一把尺（罗尔斯·同一规则） ──────────────────
  console.log('\n[M3/S2 code 类型补门 + 两处标签同尺（同一规则）]');
  {
    const page = stripComments(rd(`${A}/renderer/src/pages/DeliverablesPage.tsx`));
    // zx_20260913 M2-6: 手抄 `(d.type === 'doc' || d.type === 'code')` 已收敛为共享 isPreviewType；
    // 断言改钉共享谓词，且要求页面真从跨 root 真源导入（否则「同一把尺」不成立）。
    ok(page.includes('isPreviewType(d.type)') && page.includes("from '../../../src/main/core/deliverable-types.js'"), '列表预览入口对 code 开放（判据=共享 isPreviewType）');
    // 选项值清单从源码派生（正则失效则清单为空 ⇒ 断言自证失败，不会静默空过）
    const typeOpts = (page.match(/\{\s*\(\[([^\]]+)\] as const\)\.map\(\(t\) => <option key=\{t\} value=\{t\}>\{DELIVERABLE_TYPE_LABEL\[t\]\}/) ?? [])[1] ?? '';
    ok(typeOpts.includes("'code'"), '类型筛选项含 code，文案一律取共享词表（不再本地手抄「代码」）', `[${typeOpts}]`);
    // 真行为：类型词表**只有一个落点**（E6 同一把尺）。
    // zx_20260929 M7: 原判据「列表 TYPE_LABELS 与抽屉 TYPE_LABEL 键集一致」在收敛成一份真源后
    //   退化为 `eq([], [])` —— 两处都没了，**空过**（全绿而什么也没证）。改钉真源本体 + 两消费点不留本地表。
    const keySet = (src: string, re: RegExp): string[] => {
      const m = src.match(re);
      if (!m) return [];
      return (m[1].match(/(\w+)\s*:/g) || []).map(s => s.replace(/\s*:/, '')).sort();
    };
    const drawerSrc = stripComments(rd(`${A}/renderer/src/components/DeliverableDrawer.tsx`));
    const viewSrc = stripComments(rd(`${A}/renderer/src/lib/deliverable-view.ts`));
    const viewKeys = keySet(viewSrc, /export const DELIVERABLE_TYPE_LABEL: Record<string, string> = \{([^}]*)\}/);
    ok(viewKeys.length > 0 && viewKeys.includes('code'), '共享词表真源可解析且含 code（旧实现漏 ⇒ 裸显示 code）', `[${viewKeys.join(',')}]`);
    ok(!/const TYPE_LABELS?\s*:/.test(page) && page.includes('DELIVERABLE_TYPE_LABEL'), '列表页无本地标签表，一律引共享真源');
    ok(!/const TYPE_LABELS?\s*:/.test(drawerSrc) && drawerSrc.includes('DELIVERABLE_TYPE_LABEL'), '抽屉无本地标签表，一律引共享真源');
  }

  // ── S3 本地直达：判据真行为（上手状态） ─────────────────────────────
  console.log('\n[M3/S3 「在文件夹中显示」——本地路径判据真行为复算]');
  {
    const ipc = stripComments(rd(`${A}/src/main/ipc-handlers.ts`));
    ok(ipc.includes("ipcMain.handle('shell:showItemInFolder'"), 'main 注册 shell:showItemInFolder');
    ok(ipc.includes('path.isAbsolute(filePath)'), '仅绝对路径（相对路径拒绝）');
    ok(ipc.includes('fs.existsSync(filePath)'), '不存在的路径如实拒绝');
    ok(ipc.includes('shell.showItemInFolder(filePath)'), '确实调用系统文件管理器');
    const reLit = extractRegexLiteral(ipc, '/^[a-zA-Z]');
    ok(!!reLit, '从源码直取 scheme 正则字面量（不另抄一份）');
    if (reLit) {
      const schemeRe = new RegExp(reLit.slice(1, -1));
      // 生产判据等价复算：类型/空/带 scheme/非绝对 → 一律拒绝
      const guard = (p: unknown): boolean => !(typeof p !== 'string' || !p || schemeRe.test(p as string) || !path.isAbsolute(p as string));
      ok(guard('/Users/devuser/works/my/study/worker-ant/data/x.txt'), '本地绝对路径 → 放行');
      ok(!guard('file:///Users/a/b.txt'), 'file:// 拒绝（不把 URL 当文件路径）');
      ok(!guard('https://example.com/a.txt'), 'http(s):// 拒绝');
      ok(!guard('data/notification_payloads/a.txt'), '相对路径拒绝');
      ok(!guard('~/x.txt'), '~ 展开式拒绝（非绝对）');
      ok(!guard(''), '空串拒绝');
      ok(!guard(null), '非字符串拒绝');
    }
    const preload = stripComments(rd(`${A}/src/preload/index.ts`));
    ok(preload.includes("ipcRenderer.invoke('shell:showItemInFolder', filePath)"), 'preload 白名单挂桥');
    ok(stripComments(rd(`${A}/src/preload/types.ts`)).includes('showItemInFolder'), 'preload 类型声明补齐');
    ok(stripComments(rd(`${A}/renderer/src/types/electron.d.ts`)).includes('showItemInFolder'), 'renderer 全局类型声明补齐');
    for (const f of ['renderer/src/pages/DeliverablesPage.tsx', 'renderer/src/components/DeliverableDrawer.tsx']) {
      const src = stripComments(rd(`${A}/${f}`));
      ok(src.includes("p.startsWith('/')") && src.includes('showItemInFolder'), `${f} 列表/抽屉本地直达入口（同判据）`);
    }
  }

  // ── S4 截断/回落如实（夏克特·错误归属） ─────────────────────────────
  console.log('\n[M3/S4 内容截断/以描述代之——如实标注（错误归属）]');
  {
    const ipc = stripComments(rd(`${A}/src/main/ipc/project.ipc.ts`));
    ok(ipc.includes('const PREVIEW_CAP = 100_000'), '截断阈值单一真源 100KB');
    ok(ipc.includes('content_truncated: contentTruncated'), '载荷回报 content_truncated');
    ok(ipc.includes('content_source: contentSource'), '载荷回报 content_source');
    ok(ipc.includes("'file' | 'snapshot' | 'description' | 'none'"), '来源四态穷尽（无"看不见"的第五态）');
    // 真行为：在生产表达式本身上复算来源判定
    const srcExpr = extractExpr(ipc, /const contentSource:[^=]*=([^;]+);/);
    ok(!!srcExpr, '从源码直取 contentSource 表达式');
    if (srcExpr) {
      const f = new Function('fileContent', 'snapshotText', 'descText', `return (${srcExpr});`) as (a: string, b: string, c: string) => string;
      eq(f('正文', '快照', '描述'), 'file', '有文件内容 → file（叙述为全文之实）');
      eq(f('', '快照', '描述'), 'snapshot', '无文件内容 → snapshot');
      eq(f('', '', '描述'), 'description', '仅描述 → description（须标注"非文件正文"）');
      eq(f('', '', ''), 'none', '皆无 → none');
    }
    const pickExpr = extractExpr(ipc, /const pickedContent = ([^;]+);/);
    ok(!!pickExpr, '从源码直取 pickedContent 表达式');
    if (pickExpr) {
      const f = new Function('fileContent', 'snapshotText', 'descText', `return (${pickExpr});`) as (a: string, b: string, c: string) => string;
      eq(f('正文', '快照', '描述'), '正文', '取用序：文件 > 快照 > 描述');
      eq(f('', '快照', '描述'), '快照', '');
      eq(f('', '', '描述'), '描述', '');
    }
    const page = stripComments(rd(`${A}/renderer/src/pages/DeliverablesPage.tsx`));
    ok(page.includes('contentTruncated') && page.includes('content_source'), '预览弹窗接到截断/来源字段');
    ok(page.includes('仅为开头 100KB') || page.includes('开头 100KB'), '预览弹窗如实标注截断');
    ok(page.includes('非文件正文'), '预览弹窗如实标注"以描述代之"');
    const drawer = stripComments(rd(`${A}/renderer/src/components/DeliverableDrawer.tsx`));
    ok(drawer.includes('content_truncated') && drawer.includes('content_source'), '抽屉接到截断/来源字段');
    ok(drawer.includes('开头 100KB'), '抽屉如实标注截断');
    ok(drawer.includes('非文件正文'), '抽屉如实标注"以描述代之"');
  }
}

async function m4(): Promise<void> {
  // ── S1 整段取舍真行为（艾宾浩斯·系列位置 + 道德经·知止） ──────────────
  console.log('\n[M4/S1 记忆块整段取舍——按值不按位（真行为）]');
  {
    const sec = (name: string, len: number): MemSection => ({ name, priority: sectionPriority(name), text: 'x'.repeat(len) });
    const names = (arr: MemSection[]) => arr.map(s => s.name);

    // 1) 预算内：一段不丢，原序
    {
      const r = selectMemorySections([sec('记忆有效性', 100), sec('工作记忆', 100)], 1000);
      eq(names(r.kept), ['记忆有效性', '工作记忆'], '预算内整段保留且保持原序');
      eq(names(r.omitted), [], '预算内无省略');
      eq(r.chars, 202, 'chars 如实计含分隔（100+100+2）');
    }
    // 2) 超预算：低优先先丢，丢够即停
    {
      const r = selectMemorySections([sec('记忆有效性', 600), sec('工作记忆', 600)], 1000);
      eq(names(r.omitted), ['记忆有效性'], '超预算先丢低优先段');
      eq(names(r.kept), ['工作记忆'], '高优先段存活（旧实现按位掐尾恰丢末尾的高优先段，E8）');
      eq(r.chars, 600, 'chars 为保留段实长');
    }
    // 3) 丢弃序：低 → 中 → 高；同级内后位先丢
    {
      const r = selectMemorySections([sec('工作记忆', 300), sec('范例记忆', 300), sec('记忆有效性', 300)], 620);
      eq(names(r.kept), ['工作记忆', '范例记忆'], '低优先先于中优先被丢（丢够即停，不多丢）');
      const r2 = selectMemorySections([sec('记忆有效性', 300), sec('跨项目知识迁移', 300)], 400);
      eq(names(r2.kept), ['记忆有效性'], '同级内后位先丢（保留更靠前的主干表述）');
    }
    // 4) 底线：至少留 1 段（宁可超预算也不清空）
    {
      const r = selectMemorySections([sec('工作记忆', 5000)], 10);
      eq(names(r.kept), ['工作记忆'], '单段超预算仍保留（至少 1 段，不清空）');
      eq(names(r.omitted), [], '单段不省略');
    }
    // 5) 整段取舍，绝不掐半句
    {
      const r = selectMemorySections([sec('范例记忆', 900), sec('工作记忆', 50)], 400);
      eq(r.kept.map(s => s.text.length), [50], '保留者整段保留（长度为完整 50，非截断碎片）');
      eq(r.omitted.map(s => s.text.length), [900], '被省略者整段省略（长度为完整 900，内容是整段而非半句）');
    }
  }

  // ── S2 段优先级表（毛选·主要矛盾：最贴任务者为高） ────────────────────
  console.log('\n[M4/S2 段优先级表——三态穷尽，未列默认中]');
  {
    const high = Object.keys(MEM_SECTION_PRIORITY).filter(k => MEM_SECTION_PRIORITY[k] === 'high').sort();
    const low = Object.keys(MEM_SECTION_PRIORITY).filter(k => MEM_SECTION_PRIORITY[k] === 'low').sort();
    eq(high, ['任务关键约束', '任务立志', '工作记忆', '已知盲区提醒', '负空间提醒', '复盘教训', '心中贼提醒', '验收失败预警'].sort(), '高优先 = 最贴当前任务者（E8 那批末尾段）');
    // zx_20261018_3 批一：`项目域知识` 升中——它是**本项目的事实**（实体/约定/坑），不是跨项目泛化背景。
    eq(low, ['记忆有效性', '跨项目知识迁移'].sort(), '低优先 = 泛化背景（可先舍；项目域知识已升中，不在其列）');
    eq(MEM_SECTION_PRIORITY['项目域知识'], 'mid', '项目域知识 = 中优先（本项目事实，不再当泛化背景先舍）');
    eq(sectionPriority('不存在段'), 'mid', '未列入者默认为中（无第四态）');
    ok(Object.values(MEM_SECTION_PRIORITY).every(v => v === 'high' || v === 'mid' || v === 'low'), '优先级取值三态穷尽');
  }

  // ── S3 端到端：按值取舍 + 越界如实注记（管子·度量衡） ─────────────────
  console.log('\n[M4/S3 buildMemoryContext——超预算整段省略且如实标注（真行为）]');
  {
    // 最小 MemoryManager 桩：只喂触发目标段所需，其余一律空
    const stub = (over: Record<string, unknown> = {}) => ({
      findSimilarTasks: () => [], getTaskArchetype: () => null, getTaskText: () => '',
      retrieveByType: () => [], buildMemoryEffectivenessStats: () => [], buildExecutionPlaybook: () => ({}),
      generateExemplarContext: () => '', findCrossProjectSimilarTasks: () => [], getCrossProjectKnowledge: () => [],
      retrieveTaskRelevant: () => [], retrieveByCue: () => [], getProjectKnowledge: () => [],
      retrieveKnowledgeGraphContext: () => [], getTriggeredProspective: () => [], markProspectiveTriggered: () => {},
      getWorkingMemory: () => [], retrieveUnknownHits: () => [], retrieveNegativeHits: () => [],
      getSimilarTaskExperience: () => '', getPeerAcceptanceCriteria: () => [], deepRetrieve: () => [],
      listDomainKnowledge: () => [],
      recordAccess: () => {}, confidenceOf: () => 1, maturityOf: () => 1, applicabilityMismatch: () => false,
      ...over,
    }) as unknown as MemoryManager;
    const goal = { goal: '完成本轮实施', success_criteria: 'rr 全绿', investigate: [] };
    // zx_20261014_4 批五：「项目域知识」= 零 LLM 派生事实册（§K）。册子经 `selectKnowledgeForInject`
    //   按 400-token 内界择节，故单节 content ≤ ~1600 字才会入段（本夹具 1200 字 ⇒ 稳入）。
    // zx_20261018_3 批一：它已由低优先**升为中优先**（本项目事实，不是跨项目泛化背景）——
    //   下列两案按**新真值**重定向：低优先段改由「记忆有效性」担任，项目域知识作为中优先段与范例记忆同台。
    const book = [{ section: 'entities', content: 'k'.repeat(1200), sourceRef: 'wa_knowledge_triples' }];

    // Case A：中(项目域知识 1200) + 中(范例记忆 5000) + 高(约束/立志) ⇒ 同级后位先丢，省范例记忆
    {
      const mem = stub({
        listDomainKnowledge: () => book,
        generateExemplarContext: () => '## 范例记忆\n' + 'e'.repeat(5000),
      });
      const r = buildMemoryContext(mem, 'p1', undefined, 'X'.repeat(30), goal, undefined, CTX_MEMORY_MAX_CHARS);
      ok(!r.context.includes('## 范例记忆'), '超预算时同级内后位段（范例记忆）先被整段省略');
      ok(r.context.includes('## 项目域知识'), '本项目事实（项目域知识）不再被当成泛化背景先舍——这是本轮的口径变更');
      eq(r.meta, { sections: 4, kept: 3, omitted: 1, chars: r.meta.chars }, 'meta 段数如实：4 段 → 留 3 省 1');
      ok(r.context.includes('已省略 1 段：范例记忆'), '越界如实标注省略了哪一段（旧实现无任何交代）');
      ok(r.context.length <= 6000, `context 落在 CTX_MEMORY_MAX_CHARS 内（实测 ${r.context.length}）`);
    }
    // Case B：真低优先(记忆有效性) + 过大中段(范例记忆 7000) ⇒ 低先丢、后位中段再丢；项目域知识留存
    {
      const mem = stub({
        listDomainKnowledge: () => book,
        buildMemoryEffectivenessStats: () => [{ memoryType: 'episodic', successRate: 0.6, sampleCount: 3 }],
        generateExemplarContext: () => '## 范例记忆\n' + 'e'.repeat(7000),
      });
      const r = buildMemoryContext(mem, 'p1', undefined, 'X'.repeat(30), goal, undefined, CTX_MEMORY_MAX_CHARS);
      eq(r.meta.omitted, 2, '低优先 + 过大中优先两段皆省（超预算再多丢一级）');
      ok(r.context.includes('## 任务关键约束') && r.context.includes('## 任务立志'), '最贴当前任务的高优先段被保住（E8 的根因即此）');
      ok(!r.context.includes('## 范例记忆') && !r.context.includes('## 记忆有效性'), '过大中段与低优先段被整段省略（不掐半句）');
      ok(r.context.includes('## 项目域知识'), '项目域知识（本项目事实）在预算内保住');
      ok(/已省略 2 段：记忆有效性、范例记忆/.test(r.context), '省略注记逐段点名，且按段序列出');
      eq(r.meta.sections, 5, 'meta.sections = 实际装配段数');
      eq(r.meta.kept, 3, 'meta.kept = 实留段数');
      ok(r.context.length <= 6000, `context 仍落在上限内（实测 ${r.context.length}）`);
    }
    // 空装配：如实返回零态
    // zx_20261002 M9-③ **就地补判**（本判据如实变红，才改的——不是事后放宽）：返回值多了**兄弟字段**
    //   `segmentChars`（逐段字节账）。`meta` 的四键形状仍按字面核（下一行单独钉），故零态须一并带上
    //   空的 `segmentChars: []`——"无段可账"与"没这一栏"是两回事，如实返回前者。
    // zx_20261018_1 批七同法补判：又多了两个兄弟字段 `knowledgeText` / `knowledgeInjections`
    //   （项目知识注入与其逐节账）。零态同样须**如实带空**（空串/空数组），而不是"没这一栏"。
    // zx_20261021_3 批一同法补判：再添 `domainPackText` / `domainPackInjections`（领域包段与其逐包账）。
    {
      const r = buildMemoryContext(stub(), 'p1', undefined, undefined, undefined, undefined, CTX_MEMORY_MAX_CHARS);
      eq(r.meta, { sections: 0, kept: 0, omitted: 0, chars: 0 }, '无记忆可注入时零态如实（meta 四键一字未动）');
      eq(r, {
        context: '', accessedIds: [], meta: { sections: 0, kept: 0, omitted: 0, chars: 0 },
        // zx_20261022_3 批八同法补判：再添 `profileText` / `profileInjections`（项目画像段与其逐版账）——
        //   零态同样如实带空串/空数组，而不是"没这一栏"。
        // zx_20261023_5 批二同法补判：再添 `cardText` / `cardInjections`（项目知识卡段与其逐卡账）。
        segmentChars: [], profileText: '', profileInjections: [],
        cardText: '', cardInjections: [],
        knowledgeText: '', knowledgeInjections: [],
        domainPackText: '', domainPackInjections: [],
      }, '无记忆可注入时零态如实（不伪造空壳；逐段账/画像账/知识卡账/知识账/领域包账均为空）');
    }
  }

  // ── S4 同参只取一次（M4-3 纯省算，语义不变） ──────────────────────────
  console.log('\n[M4/S4 findSimilarTasks 同参 3 次 → 1 次（不改语义）]');
  {
    let calls = 0;
    const fixture = [{ id: 's1', title: '历史任务A', status: 'completed', similarity: 88 }];
    let seenPre: unknown = null;
    const mem = {
      findSimilarTasks: () => { calls++; return fixture; },
      getTaskArchetype: () => null, getTaskText: () => '实现 X 功能',
      retrieveByType: () => [], buildMemoryEffectivenessStats: () => [], buildExecutionPlaybook: () => ({}),
      generateExemplarContext: () => '', findCrossProjectSimilarTasks: () => [], getCrossProjectKnowledge: () => [],
      retrieveTaskRelevant: () => [], retrieveByCue: () => [], getProjectKnowledge: () => [],
      retrieveKnowledgeGraphContext: () => [], getTriggeredProspective: () => [], markProspectiveTriggered: () => {},
      getWorkingMemory: () => [], retrieveUnknownHits: () => [], retrieveNegativeHits: () => [],
      getSimilarTaskExperience: (_p: string, _t: string, _l: number, pre?: unknown) => { seenPre = pre; return ''; },
      getPeerAcceptanceCriteria: () => [], deepRetrieve: () => [],
      recordAccess: () => {}, confidenceOf: () => 1, maturityOf: () => 1, applicabilityMismatch: () => false,
    } as unknown as MemoryManager;
    const r = buildMemoryContext(mem, 'p1', 't1', undefined, undefined, undefined, CTX_MEMORY_MAX_CHARS);
    ok(calls === 1, `同参只取一次（旧实现 3 次，E9），实测 ${calls}`);
    ok(seenPre === fixture, 'A1 段复用同一份结果（一次取、多处用，结果不变）');
    ok(r.context.includes('历史任务A'), '相似历史任务仍如实入文（省算不改语义）');
  }

  // ── S5 如实度量 + 红线（不改数值/不删记忆） ───────────────────────────
  // zx_20260924_1 M7-c（就地订正，**只增不减**）：记忆装配整块迁出 `core/memory-context.ts`。
  //   ① 凡"钉**实现**在哪"的判据（取舍算式 / MEM_OVERHEAD / 装配函数体）改扫新模块——
  //      旧写法扫执行体会切出**空块**，报成"预算真源没了"，读起来像真回归、实为扫描面没跟着走；
  //   ② 同时**加**反向条：执行体里不得再有第二份（新模块里不得出现 6000 字面量）——
  //      故"迁一半留一半"或"两处各写一份"都会红，比原判据更强；
  //   ③ 锚点按**符号/算式**，不按行号（行号是位置会漂）。
  console.log('\n[M4/S5 度量入 ctx + 红线：CTX_* 数值与检索谓词未动（装配侧扫新模块）]');
  {
    const src = stripComments(rd(`${A}/src/main/core/agent-executor.ts`));
    const memSrc = stripComments(rd(`${A}/src/main/core/memory-context.ts`));
    ok(/const CTX_MEMORY_MAX_CHARS = 6000;/.test(src), 'CTX_MEMORY_MAX_CHARS 仍为 6000 且**仍在执行体**（M4 红线：不改数值；C35 钉它可从执行体 import）');
    ok(memSrc.includes('export const MEM_OVERHEAD = 220'), '包裹开销常量在新模块显式导出（预算 = 上限 − 开销）');
    ok(memSrc.includes('selectMemorySections(parts, Math.max(0, budgetChars - MEM_OVERHEAD))'),
      '取舍预算取自**传入的单一真源**（budgetChars），不另立阈值');
    ok(!/\b6000\b/.test(memSrc), '★反向条：新模块内不出现 6000 —— 预算真源不得被搬成第二处');
    ok(!src.includes('selectMemorySections(parts'), '★反向条：执行体内不再有装配侧预算算式（迁得干净）');
    ok(src.includes('memoryCtxSections: memoryCtxMeta?.sections'), 'context_watermark 如实记段数（调用方仍在执行体）');
    ok(src.includes('memoryCtxKept: memoryCtxMeta?.kept') && src.includes('memoryCtxOmitted: memoryCtxMeta?.omitted'), 'context_watermark 如实记保留/省略段数');
    ok(/buildMemoryContext\([\s\S]{0,400}meta: \{ sections: number; kept: number; omitted: number; chars: number \}/.test(memSrc), 'buildMemoryContext 返回 meta（段数/保留/省略/字符）');
    // 同参重复只在本函数内发生（E9 指 4 段/A1 段/11 段），故只在 buildMemoryContext 体内计数；
    // 执行体那处 `findSimilarTasks` 属 executeTask 的**另一个消费者**（任务耗时预估），非同一调用流。
    // ⚠ 切块锚点：该函数现为**新模块内最后一个声明**（到文件尾），且模块内 `findSimilarTasks(` 只此一处
    //   ⇒ 此处自证"切到了"（体内含 return + 不含空块），防"切成空块"式的假绿。
    const fnStart = memSrc.indexOf('export function buildMemoryContext(');
    const fnBody = fnStart >= 0 ? memSrc.slice(fnStart) : '';
    ok(fnBody.includes('  return {\n    context: `<memory-context>'), `切块自证：buildMemoryContext 体切到（块长 ${fnBody.length}）`);
    const hits = fnBody.match(/findSimilarTasks\(/g) || [];
    eq(hits.length, 1, 'buildMemoryContext 体内 findSimilarTasks 只剩 1 处调用（旧 3 处，E9）');
    ok(/similarTasksCache = memory\.findSimilarTasks\(projectId, taskId, 3\)/.test(fnBody), '该处即缓存闭包内的一次取（其余两处改走 getSimilarTasks()）');
  }
}

async function m5(): Promise<void> {
  // 承 rr_zx_20260911_4 §M6 教训（反向钉子曾三处各停更于不同轮次、守护半失效）。
  // 订正（M5 落地时）：原为 S1 写值字面量 + S2 手抄「6 个文件」前向清单 + S3 读他脚本文本里的 dist 钉 +
  // S4 三处反向残留断言——每开新轮须逐个手改、清单逐轮滚长（本轮实测共 36 处 / 9 文件，＋源码写值 1 处）。
  // 改为**派生一致性**：真源＝agent-executor.ts 的那一处 build 值，由 scripts/lib/rr-pins.ts 枚举全量核对。
  // 见 plans/improve/zx_20260912.md §M5。语义**只增不减**：P1「恰好一处」严格强于原反向钉。
  console.log('\n[M5/S1–S4 build 标识的派生一致性（枚举全量 rr 脚本 + 源码单一真源 + 产物同值）]');
  const distDir = path.join(__dirname, '..', A, 'dist');
  checkBuildPins(ok, { distDir });

  console.log('\n[M5/S5 端到端产物证据（实践论：只验源码不算数，须在构建产物内实测）]');
  {
    let blob = '';
    let n = 0;
    try {
      const files = fs.readdirSync(distDir, { recursive: true }).filter((f): f is string => typeof f === 'string' && f.endsWith('.js'));
      n = files.length;
      blob = files.map(f => fs.readFileSync(path.join(distDir, f), 'utf-8')).join('\n');
    } catch { /* 未构建 */ }
    // 注：原此处的 `blob.includes('zx_…')` 已由 S1–S4 的 P6 取代（取产物 build **值本身**、更强：
    // 子串判定会被产物注释里的轮次名假阳性命中，本轮实测坐实）。
    if (n > 0) {
      ok(blob.includes('selectMemorySections'), '★产物内含本轮 M4 取舍纯函数 selectMemorySections');
      ok(blob.includes('memoryCtxOmitted'), '★产物内含本轮 M4 度量字段 memoryCtxOmitted');
    }
  }

  console.log('\n[M5/S6 rr 脚本计数（单调下界，防误删不锁死）]');
  {
    const rrFiles = fs.readdirSync(__dirname).filter(f => f.startsWith('rr_') && f.endsWith('.ts'));
    ok(rrFiles.length >= 45, 'rr 脚本不少于 45（本轮 44 → 45）', String(rrFiles.length));
    ok(rrFiles.includes('rr_zx_20260911_5.ts'), '本轮脚本在位');
  }
}

async function main(): Promise<void> {
  console.log('=== rr_zx_20260911_5 受控复跑 ===');
  await m1();
  await m2();
  await m3();
  await m4();
  await m5();
  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}
void main();
