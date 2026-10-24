/**
 * zx_20260911_2 受控复跑（IM 渠道实时友好交互 + 成果判据/口径归一 + 展示组）。
 *
 * 本轮三线：
 *   M1–M3 IM 渠道：选项单一真源、审批先于自由回复、失败即抛、出站可见、企微能力如实。
 *   M4    成果判据：★互斥、自动 primary 单一实现、digest 锚、计数同源、IM 同开关、手工入口补事件。
 *   M4b   展示组（附批）：任务详情 ★/验收徽标、预览 file_exists 如实、digest 质量正名。
 *
 * 断言分两类（zx_20260910_3/_4/_5/_6 的教训）：静态断言一律 `stripComments` 后再比对，防注释里的
 * 关键词造成假阳性；行为断言动态 import 真实模块，在**渲染/返回结果**上证，而非只扫源码。
 *
 * 本文件不连任何真库（真库只读复核见方案 §四 与 data/baseline_zx_20260911_2.json）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
import { engineSrc } from './lib/rr-engine-src.js';
import { eventBus } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';
import { formatOptions, parseOptions, formatAwaitingInputMessage } from '../apps/worker-ant-desktop/src/main/core/im/options.js';
import { channelCapabilities } from '../apps/worker-ant-desktop/src/main/core/im/channel-capabilities.js';
import { emitOutboundMessage } from '../apps/worker-ant-desktop/src/main/core/im/outbound-event.js';
import { primaryScope, applyPrimary, autoAssignPrimary, emitDeliverableEvent, loadDeliverableRow } from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import { describeAcceptance } from '../apps/worker-ant-desktop/src/main/core/im-reply.js';
import { routeImMessage, registerPendingApproval } from '../apps/worker-ant-desktop/src/main/services/im-router.js';
import { FeishuAdapter } from '../apps/worker-ant-desktop/src/main/services/feishu-adapter.js';
import { DingtalkAdapter } from '../apps/worker-ant-desktop/src/main/services/dingtalk-adapter.js';
import { WecomAdapter } from '../apps/worker-ant-desktop/src/main/services/wecom-adapter.js';
import { QqbotAdapter } from '../apps/worker-ant-desktop/src/main/services/qqbot-adapter.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const rd = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const app = (rel: string) => rd(`${A}/${rel}`);

// node:sqlite 无 better-sqlite3 的 .transaction()——补最小等价 shim（同步执行，无嵌套）
const withTx = (d: DatabaseSync) => { (d as unknown as { transaction: unknown }).transaction = (fn: () => void) => () => fn(); return d; };
const mkdb = () => withTx(new DatabaseSync(':memory:')) as unknown as import('better-sqlite3').Database;

// ─────────────────────────────────────────────────────────────
// S0 行为探针（动态 import 真实模块）
// ─────────────────────────────────────────────────────────────
async function s0(): Promise<void> {
  console.log('\n[S0.1 选项单一真源·渲染/解析往返]');
  eq(formatOptions(['A', 'B']), 'A / B', 'formatOptions 唯一形态 A / B');
  eq(parseOptions('[等待用户输入] 选哪个? [选项: A / B]'), ['A', 'B'], 'parseOptions 解析新形态');
  eq(parseOptions('A | B'), ['A', 'B'], 'parseOptions 兼容旧 | 形态');
  eq(parseOptions('A, B'), ['A', 'B'], 'parseOptions 兼容旧 , 形态');
  eq(parseOptions('A、B；C'), ['A', 'B', 'C'], 'parseOptions 兼容 、；');
  eq(formatAwaitingInputMessage('选哪个?', ['A', 'B']), '[等待用户输入] 选哪个? [选项: A / B]', '暂停系统消息单一形态');
  eq(parseOptions(formatAwaitingInputMessage('q', ['选项甲', '选项乙'])), ['选项甲', '选项乙'], '渲染→解析 往返恒等');

  console.log('\n[S0.2 渠道能力单一真源]');
  const wc = channelCapabilities('wechat-personal');
  ok(wc.inbound && wc.outbound, 'wechat-personal 收发均可', wc.note);
  ok(channelCapabilities('qqbot').inbound && channelCapabilities('qqbot').outbound, 'qqbot 收发均可');
  ok(channelCapabilities('dingtalk').inbound && channelCapabilities('dingtalk').outbound, 'dingtalk 收发均可');
  ok(channelCapabilities('feishu').inbound && channelCapabilities('feishu').outbound, 'feishu 收发均可');
  const wm = channelCapabilities('wecom');
  ok(!wm.inbound && wm.outbound, 'wecom 仅出站（入站如实为不可用）', wm.note);
  const unk = channelCapabilities('nope');
  ok(!unk.inbound && !unk.outbound, '未知渠道 → 收发均 false 且 note 如实');

  console.log('\n[S0.3 ★作用域与互斥（primaryScope + applyPrimary）]');
  ok(primaryScope({ task_id: 't1', project_id: 'p1' }).sql === 'task_id = ?', '任务内作用域 → task_id = ?');
  const ms = primaryScope({ task_id: null, project_id: 'p1' });
  ok(ms.sql === 'project_id = ? AND task_id IS NULL' && ms.params[0] === 'p1', '手工成果作用域 → project_id + task_id IS NULL', ms.sql);
  const db = mkdb();
  db.exec('CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, name TEXT, type TEXT, file_path TEXT, status TEXT, is_primary INTEGER DEFAULT 0, updated_at TEXT);');
  const ins = (id: string, project: string, task: string | null, name: string) =>
    db.prepare('INSERT INTO wa_deliverables (id, project_id, task_id, name, type, status) VALUES (?,?,?,?,?,?)').run(id, project, task, name, 'doc', 'completed');
  const prim = (id: string) => (db.prepare('SELECT is_primary c FROM wa_deliverables WHERE id = ?').get(id) as { c: number }).c;
  ins('d1', 'p1', 't1', 'A'); ins('d2', 'p1', 't1', 'B'); ins('d3', 'p1', 't2', 'C');
  ins('m1', 'p1', null, '手工1'); ins('m2', 'p1', null, '手工2');
  applyPrimary(db, { id: 'd1', project_id: 'p1', task_id: 't1' }, 1);
  ok(prim('d1') === 1 && prim('d2') === 0, '同任务内置 ★ → 兄弟被清');
  applyPrimary(db, { id: 'd2', project_id: 'p1', task_id: 't1' }, 1);
  ok(prim('d2') === 1 && prim('d1') === 0, '再置 d2 → d1 让位（同任务互斥）');
  ok(prim('d3') === 0, '跨任务不受影响');
  applyPrimary(db, { id: 'm1', project_id: 'p1', task_id: null }, 1);
  applyPrimary(db, { id: 'm2', project_id: 'p1', task_id: null }, 1);
  ok(prim('m1') === 0 && prim('m2') === 1, '手工成果组内互斥');
  ok(prim('d2') === 1, '手工置位不影响任务内 ★（两组独立）');
  applyPrimary(db, { id: 'm2', project_id: 'p1', task_id: null }, 0);
  ok(prim('m2') === 0, '撤位仅影响本行');

  console.log('\n[S0.4 autoAssignPrimary 三态]');
  // zx_20260915 P0-8(b): 候选排序改读**事件表**（本任务有无该路径的 `file.created`）⇒ 夹具须按生产 DDL 建此表。
  //   缺表 ⇒ 查询抛错被 `catch` 吞成 `{}`、★ 恒不指派——夹具比生产宽松，断言就只在自我印证（本仓既有教训）。
  const EVENT_LOG_DDL = "CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, aggregate_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}', metadata TEXT DEFAULT '{}', occurred_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));";
  const d2 = mkdb();
  d2.exec("CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT, name TEXT, file_path TEXT, status TEXT, is_primary INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT); CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);" + EVENT_LOG_DDL);
  const ins2 = (id: string, task: string, name: string, file: string) =>
    d2.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status, created_at) VALUES (?, 'p', ?, 'doc', ?, ?, 'draft', datetime('now'))").run(id, task, name, file);
  ins2('x1', 't9', 'real.md', '/tmp/real.md');
  ins2('x2', 't9', '_probe.md', '/tmp/_probe.md');
  d2.prepare("INSERT INTO wa_settings (key, value) VALUES ('deliverable.primary_auto', 'true')").run();
  let r = autoAssignPrimary(d2, 't9');
  ok(r.assigned === 'x1', '开关开 → 选最新**非探针** doc 置 ★', String(r.assigned));
  ok((d2.prepare("SELECT is_primary c FROM wa_deliverables WHERE id='x2'").get() as { c: number }).c === 0, '探针 doc 不被选为主要成果');
  d2.prepare("UPDATE wa_settings SET value='false' WHERE key='deliverable.primary_auto'").run();
  d2.prepare('UPDATE wa_deliverables SET is_primary=0').run();
  ok(autoAssignPrimary(d2, 't9').assigned === undefined, '开关关 → 不置 ★');
  const d3 = mkdb();
  d3.exec("CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT, name TEXT, file_path TEXT, status TEXT, is_primary INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT); CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);" + EVENT_LOG_DDL);
  d3.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status, is_primary, created_at) VALUES ('y1','p','t9','doc','a.md','/a.md','draft',1,datetime('now'))").run();
  d3.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status, created_at) VALUES ('y2','p','t9','doc','b.md','/b.md','draft',datetime('now'))").run();
  d3.prepare("INSERT INTO wa_settings (key, value) VALUES ('deliverable.primary_auto', 'true')").run();
  ok(autoAssignPrimary(d3, 't9').assigned === undefined, '已有 ★ → 不覆盖（priCnt 前置）');

  console.log('\n[S0.5 验收徽标同一开关·向后兼容]');
  const verified = { criteria_total: 3, passed_total: 3, checked_at: '2026-09-11T00:00:00Z', verified: true };
  ok(describeAcceptance(verified) === '✓已验收 3/3', '默认(未传开关)向后兼容：仍播验收徽标', String(describeAcceptance(verified)));
  ok(describeAcceptance(verified, false) === null, 'show_acceptance=false → 不播验收徽标');
  ok(describeAcceptance({ criteria_total: 3, passed_total: 3, checked_at: 'x', verified: false }, true) === null, '未核验载荷(verified=false)不播');

  console.log('\n[S0.6 产出物事件成对联结（手工入口与状态机共用起草处）]');
  const seen: Array<{ t: string; d: Record<string, unknown> }> = [];
  eventBus.on('deliverable.registered', ((e: { data: Record<string, unknown> }) => { seen.push({ t: 'registered', d: e.data }); }) as never);
  eventBus.on('deliverable.status_changed', ((e: { data: Record<string, unknown> }) => { seen.push({ t: 'status_changed', d: e.data }); }) as never);
  const ev1 = mkdb();
  ev1.exec("CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, name TEXT, type TEXT, file_path TEXT, status TEXT, is_primary INTEGER DEFAULT 0, updated_at TEXT);");
  ev1.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, name, type, status) VALUES ('z1','p','t','N','doc','completed')").run();
  const row = loadDeliverableRow(ev1, 'z1')!;
  emitDeliverableEvent(row, 'registered', 'manual:create', '');
  emitDeliverableEvent(row, row.old_status, 'manual:update', row.old_status);
  emitDeliverableEvent(row, 'deleted', 'manual:delete', row.old_status);
  await new Promise((res) => setTimeout(res, 10));
  ok(seen.length === 3, '三条事件均触达订阅者', `${seen.length}`);
  ok(seen[0]!.t === 'registered' && seen[0]!.d.status === 'registered', 'create → deliverable.registered');
  ok(seen[1]!.t === 'status_changed' && seen[1]!.d.via === 'manual:update', 'update → deliverable.status_changed');
  ok(seen[2]!.t === 'status_changed' && seen[2]!.d.status === 'deleted', 'delete → status_changed(status=deleted)');
  ok(seen.every(s => s.d.deliverable_id === s.d.deliverableId && s.d.task_id === (s.d.taskId ?? null)), 'payload 双写别名同形');

  console.log('\n[S0.7 出站瞬态事件闭环]');
  let got: Record<string, unknown> | null = null;
  eventBus.on('im.message_outbound', ((e: { data: unknown }) => { got = e.data as Record<string, unknown>; }) as never);
  emitOutboundMessage({ channelId: 'c9', channelType: 'wecom', toUser: 'u9', preview: 'x'.repeat(200) });
  await new Promise(res => setTimeout(res, 10));
  ok(got !== null, 'emitOutboundMessage 触达 im.message_outbound 订阅者');
  const g = got as unknown as Record<string, unknown>;
  ok(!!g && g.channelId === 'c9' && g.channel_id === 'c9' && g.channelType === 'wecom' && g.channel_type === 'wecom', 'channelId/channelType 双写别名一致');
  ok(!!g && g.toUser === 'u9' && g.to_user_id === 'u9', 'toUser/to_user_id 双写别名一致');
  ok(!!g && typeof g.preview === 'string' && (g.preview as string).length === 60, 'preview 截断至 60 字', String((g?.preview as string | undefined)?.length));

  console.log('\n[S0.8 审批先于自由回复·定向不错]');
  const rd2 = mkdb();
  rd2.exec(`CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT, context_json TEXT, updated_at TEXT);
CREATE TABLE wa_task_conversations (id TEXT, task_id TEXT, role TEXT, content TEXT, token_count INTEGER, created_at TEXT);
CREATE TABLE wa_jobs (id TEXT, type TEXT, payload TEXT, status TEXT);
CREATE TABLE wa_im_conversations (id TEXT, channel_id TEXT, external_user_id TEXT, message_json TEXT, direction TEXT, created_at TEXT);
CREATE TABLE wa_memories (id TEXT, user_id TEXT, project_id TEXT, task_id TEXT, memory_type TEXT, content TEXT, source TEXT, importance REAL, reasoning TEXT, valence REAL, updated_at TEXT);`);
  const mkTask = (id: string, user: string, age: string) =>
    rd2.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json, updated_at) VALUES (?,?,?,?,?,?)")
      .run(id, 'p1', `T-${id}`, 'paused', JSON.stringify({ channel: 'wechat-personal', externalUser: user }), age);
  mkTask('t_old', 'u1', "datetime('now','-2 hour')");
  mkTask('t_new', 'u1', "datetime('now')");
  mkTask('t_u2', 'u2', "datetime('now')");
  const replies: string[] = [];
  const ictx = { db: rd2, channelId: 'ch1', channelType: 'wechat-personal', sendReply: async (_to: string, t: string) => { replies.push(t); } };
  registerPendingApproval('wechat-personal', 'u1', { taskId: 't_old', projectId: 'p1', question: '[待回复] 继续?', options: 'A / B', createdAt: Date.now() });
  await routeImMessage(ictx as never, 'u1', '是', 'private', '');
  const convOld = rd2.prepare("SELECT content FROM wa_task_conversations WHERE task_id='t_old'").all() as Array<{ content: string }>;
  ok(convOld.some(c => c.content === '[用户确认执行]'), '「是」落审批语义（记录用户确认执行）');
  ok(!convOld.some(c => c.content.startsWith('[IM回复]')), '「是」未被当自由回复吃掉');
  const convNew = (rd2.prepare("SELECT COUNT(*) c FROM wa_task_conversations WHERE task_id='t_new'").get() as { c: number }).c;
  ok(convNew === 0, '未错落到另一任务', `t_new 会话数=${convNew}`);
  const jobTo = rd2.prepare("SELECT payload FROM wa_jobs WHERE type='resume-ai-task'").all() as Array<{ payload: string }>;
  ok(jobTo.length === 1 && JSON.parse(jobTo[0]!.payload).taskId === 't_old', '恢复作业定向到被审批的任务');
  ok(replies.some(x => x.includes('已确认')), '回执为「已确认」');
  replies.length = 0;
  await routeImMessage(ictx as never, 'u2', '把报告改成中文', 'private', '');
  const convU2 = rd2.prepare("SELECT content FROM wa_task_conversations WHERE task_id='t_u2'").all() as Array<{ content: string }>;
  ok(convU2.some(c => c.content.startsWith('[IM回复]')), '无审批项时自由回复仍落 handleAgentReply');

  console.log('\n[S0.9 四家适配器·失败即抛 + 成功落 outbound]');
  const adb = new DatabaseSync(':memory:');
  // zx_20260930 M2-c：出站行由 `outbound-record.recordOutboundConversation` 统一落库，该语句**点名 `task_id`**
  //   （生产 DDL `database.ts` 基表已含此列，另有同列 ALTER 兜老库）。夹具此前是 M1 之前的旧形状 ⇒ 四家适配器
  //   `sendReply` 一落库即 `no column named task_id` 硬崩。夹具不得比生产**窄**：按生产形状补齐（本段只跑出站，
  //   `task_id` 归属断言归 `rr_zx_20260930` B-c 组，此处不重复）。
  adb.exec("CREATE TABLE wa_im_conversations (id TEXT, channel_id TEXT, external_user_id TEXT, message_json TEXT, direction TEXT, created_at TEXT, task_id TEXT DEFAULT '');");
  const adbC = adb as unknown as import('better-sqlite3').Database;
  let msgMode: 'ok' | 'fail' = 'ok'; let failToken = false;
  const json = (o: unknown) => Promise.resolve({ ok: (o as { _ok?: boolean })._ok !== false, status: (o as { _status?: number })._status ?? 200, json: () => Promise.resolve(o) });
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.includes('tenant_access_token')) return failToken ? json({ code: 1 }) : json({ code: 0, tenant_access_token: 't' });
    if (u.includes('oauth2/accessToken')) return failToken ? json({}) : json({ accessToken: 't', expiresIn: 7200 });
    if (u.includes('/gettoken')) return failToken ? json({ errcode: 40013 }) : json({ errcode: 0, access_token: 't', expires_in: 7200 });
    if (u.includes('getAppAccessToken')) return failToken ? json({ _ok: false, _status: 401 }) : json({ access_token: 't', expires_in: 3600 });
    if (u.includes('im/v1/messages')) return msgMode === 'ok' ? json({ code: 0 }) : json({ code: 230002, msg: 'bot not in chat' });
    if (u.includes('batchSend')) return msgMode === 'ok' ? json({ processQueryKey: 'qk' }) : json({ code: 40035 });
    if (u.includes('message/send')) return msgMode === 'ok' ? json({ errcode: 0 }) : json({ errcode: 60011, errmsg: 'no privilege' });
    if (u.includes('/messages')) return msgMode === 'ok' ? json({ _ok: true }) : json({ _ok: false, _status: 500 });
    return json({});
  }) as unknown as typeof fetch;
  const outCount = () => (adb.prepare("SELECT COUNT(*) c FROM wa_im_conversations WHERE direction='outbound'").get() as { c: number }).c;
  const mk = () => [
    ['feishu', new FeishuAdapter(adbC, 'c1', { appId: 'a', appSecret: 's' })],
    ['dingtalk', new DingtalkAdapter(adbC, 'c2', { clientId: 'a', clientSecret: 's', robotCode: 'r' })],
    ['wecom', new WecomAdapter(adbC, 'c3', { corpId: 'a', corpSecret: 's', agentId: '1' })],
    ['qqbot', new QqbotAdapter(adbC, 'c4', { appId: 'a', clientSecret: 's' })],
  ] as const;
  const threw = async (p: Promise<unknown>, l: string) => { try { await p; ok(false, l, '未抛异常'); } catch (e) { ok(true, l, (e as Error).message.slice(0, 50)); } };
  for (const [name, ad] of mk()) { msgMode = 'ok'; failToken = false; const b = outCount(); await ad.sendReply('u1', 'hi'); ok(outCount() === b + 1, `${name}: 成功路径落 outbound 行`); }
  for (const [name, ad] of mk()) { msgMode = 'fail'; await threw(ad.sendReply('u1', 'hi'), `${name}: 上游失败 → sendReply 抛异常`); }
  for (const [name, ad] of mk()) { msgMode = 'ok'; failToken = true; await threw(ad.sendReply('u1', 'hi'), `${name}: 取 token 失败 → sendReply 抛异常`); }
  const n0 = outCount();
  msgMode = 'ok'; failToken = false;
  await mk()[0]![1].sendReply('u1', '');
  ok(outCount() === n0, '空文本不发、不落行（原语义保留）');

  console.log('\n[S0.10 审批登记取结构化 options·首选项可命中队列路径]');
  // zx_20260911_2 M1 修订: question 入参是发出去的 IM 文案（`[待回复] …\n选项: A / B`，无方括号）——
  // 从它反推选项会把前言与首选项熔成一段 ⇒ 首选项永不匹配（退化为 DB 兜底）。故登记真源必须是结构化 options。
  const rd3 = mkdb();
  rd3.exec(`CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT, context_json TEXT, updated_at TEXT);
CREATE TABLE wa_task_conversations (id TEXT, task_id TEXT, role TEXT, content TEXT, token_count INTEGER, created_at TEXT);
CREATE TABLE wa_jobs (id TEXT, type TEXT, payload TEXT, status TEXT);
CREATE TABLE wa_im_conversations (id TEXT, channel_id TEXT, external_user_id TEXT, message_json TEXT, direction TEXT, created_at TEXT);
CREATE TABLE wa_memories (id TEXT, user_id TEXT, project_id TEXT, task_id TEXT, memory_type TEXT, content TEXT, source TEXT, importance REAL, reasoning TEXT, valence REAL, updated_at TEXT);`);
  rd3.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json, updated_at) VALUES (?,?,?,?,?,?)')
    .run('t_q', 'p1', 'T-q', 'paused', JSON.stringify({ channel: 'wechat-personal', externalUser: 'uq' }), "datetime('now')");
  // 令 DB 兜底亦"可命中"（会话含正确 [选项: …]）——以此证明命中来自队列路径而非兜底
  rd3.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES ('cq0','t_q','system','[等待用户输入] 继续? [选项: A / B]',0,datetime('now'))").run();
  // 与 index.ts sendImAskUser 同法：登记取 formatOptions(结构化 options)
  registerPendingApproval('wechat-personal', 'uq', { taskId: 't_q', projectId: 'p1', question: '[待回复] 继续?', options: formatOptions(['A', 'B']), createdAt: Date.now() });
  const replies3: string[] = [];
  const ictx3 = { db: rd3, channelId: 'chq', channelType: 'wechat-personal', sendReply: async (_t: string, t: string) => { replies3.push(t); } };
  await routeImMessage(ictx3 as never, 'uq', 'A', 'private', '');
  const conv3 = rd3.prepare("SELECT content FROM wa_task_conversations WHERE task_id='t_q'").all() as Array<{ content: string }>;
  ok(conv3.some(c => c.content === '[用户选择: A]'), '回复首选项「A」→ 走队列审批路径（记为 [用户选择: A]）');
  ok(!conv3.some(c => c.content === 'A'), '未被当自由回复/DB 兜底原样落库（证明非兜底命中）');
  ok(!conv3.some(c => c.content.startsWith('[IM回复]')), '「A」未被当自由回复吃掉');
  ok(replies3.some(x => x.includes('已确认')), '回执为「已确认」');
  const job3 = rd3.prepare("SELECT payload FROM wa_jobs WHERE type='resume-ai-task'").all() as Array<{ payload: string }>;
  ok(job3.length === 1 && JSON.parse(job3[0]!.payload).taskId === 't_q', '恢复作业定向到被审批任务');
  ok(parseOptions(`[待回复] 继续?\n选项: ${formatOptions(['A', 'B'])}`)[0] !== 'A', '反证：从 IM 文案反推选项会熔入前言（故登记必须取结构化 options）');
}

// ─────────────────────────────────────────────────────────────
// S1–S13 静态断言（stripComments 后）
// ─────────────────────────────────────────────────────────────
function statics(): void {
  const opts = stripComments(app('src/main/core/im/options.ts'));
  const exe = stripComments(engineSrc());
  const idx = stripComments(app('src/main/index.ts'));
  const router = stripComments(app('src/main/services/im-router.ts'));
  const ipc = stripComments(app('src/main/ipc/im.ipc.ts'));
  const prj = stripComments(app('src/main/ipc/project.ipc.ts'));
  const pe = stripComments(app('src/main/core/project-engine.ts'));
  const ai = stripComments(app('src/main/core/jobs/ai-task.ts'));
  const eb = stripComments(app('src/main/core/event-bus.ts'));
  const dlc = stripComments(app('src/main/core/deliverable-lifecycle.ts'));
  const ddc = app('renderer/src/components/DeliveryDigestCard.tsx');
  const tdp = app('renderer/src/pages/TaskDetailPage.tsx');
  const imp = app('renderer/src/pages/IMPage.tsx');

  console.log('\n[S1 选项单一真源·四处渲染/解析经同一函数]');
  ok(opts.includes('.join(\' / \')') && /OPTION_BLOCK_RE/.test(opts), 'options.ts 渲染唯一形态 ` / `');
  ok(exe.includes('formatOptions(') && idx.includes('formatOptions(') && router.includes('parseOptions('), 'agent-executor/index/im-router 经共享函数');
  ok(!/(options|opts|pending)\.join\(/.test(exe) && !/(options|opts|pending)\.join\(/.test(router), '选项不再各自 join 拼接');

  console.log('\n[S2 登记唯一入口·死接线已清·取结构化 options]');
  ok(idx.includes('registerPendingApproval('), 'sendImAskUser 内含 registerPendingApproval');
  ok(!ipc.includes('setAskUserHandler'), 'setAskUserHandler 死接线已不存在');
  ok(!/parseOptions\(\s*question\s*\)/.test(idx), '登记不再从 IM 文案反推选项（无 parseOptions(question)）');
  ok(idx.includes('formatOptions(options)') && /options\?: string\[\]/.test(idx) && /options\?: string\[\]/.test(exe) && /options\?: string\[\]/.test(ai), 'sendImAskUser 三端签名均带 options，登记取 formatOptions(options)');

  console.log('\n[S3 次序归位·审批先于自由回复]');
  ok(router.indexOf('function checkPendingApproval') < router.indexOf('function handleAgentReply'), 'checkPendingApproval 定义先于 handleAgentReply');
  ok(/checkPendingApproval\(ctx, fromUser, msgText\)\) return;/.test(router), '路由入口先试审批（命中即 return，不落入自由回复）');
  ok(router.includes('pendingApprovals'), 'handleAgentReply 侧保留对 pendingApprovals 的定向');

  console.log('\n[S4 失败即抛·通知仍吞]');
  for (const [n, f] of [['feishu', 'services/feishu-adapter.ts'], ['dingtalk', 'services/dingtalk-adapter.ts'], ['wecom', 'services/wecom-adapter.ts'], ['qqbot', 'services/qqbot-adapter.ts']] as const) {
    ok(stripComments(app(`src/main/${f}`)).includes('throw'), `${n} 适配器 sendReply 路径含 throw`);
  }
  // 订正（M3 落地时）：仍是 catch → 返回结果对象（**不抛**，通知失败不阻断主流程）；差别只在结果里多带
  //   一句**真原因**（boolean 版无法表达"为什么没送到"）。
  ok(/catch\s*\(err\)\s*\{\s*return \{ ok: false, error:/.test(ipc), 'sendImCompletionNotice 仍为 catch → ok:false（不抛，带原因）');

  console.log('\n[S5 回话不掀翻路由]');
  ok((ipc.match(/adapter\.onMessage\(/g) || []).length === 2, 'im.ipc 两处 onMessage 包装在册');
  // zx_20260920 M2 订正：本组原先断言"im-router 回话失败均 .catch（≥12 处）"——那条**断言对象的形状**
  //   已被本轮设计取代（不是被绕过）：失败归属从"32 个调用点各吞各的"上移到**两个构造处一处落账**
  //   （`accountOutboundFailure`），调用点因此不需要兜底。若只把它从 ≥12 改成 ==0，就成了一条
  //   既不能证明"不掀翻路由"、又随时可被"外加一层 try"糊弄过去的空断言 ⇒ 改钉**新不变量**的两半：
  //   ① 调用点零逐点空吞（失败没有第二个归属）；② 两个构造处**都**落账（不是只落一处）。
  //   两侧都钉住，"不掀翻路由"才有依据：构造处 catch 一切 ⇒ `sendReply` 永不 reject。
  const replySites = (router.match(/ctx\.sendReply\(/g) || []).length;
  ok(replySites >= 14, `回话点在册（实测 ${replySites} ≥ 14）——防"扫不到 ⇒ 空吞为 0"的假绿`, String(replySites));
  eq((router.match(/ctx\.sendReply\([^;]*?\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g) || []).length, 0,
    'im-router 回话点**零**逐点空吞（失败归属已上移到构造处，见 ImContext.sendReply 接口注释）');
  eq((ipc.match(/accountOutboundFailure\(/g) || []).length, 2,
    'im.ipc 两个 ImContext.sendReply 构造处**都**落账（漏一处则"回话没送到"在该路径上仍无行）');

  console.log('\n[S6 出站可见·三处齐全]');
  ok(eb.includes("'im.message_outbound'") && idx.includes("'im.message_outbound'") && imp.includes("'im.message_outbound'"), 'event-bus 类型 + index 转发 + IMPage 订阅三处齐全');

  console.log('\n[S7 企微如实]');
  ok(channelCapabilities('wecom').inbound === false, 'channelCapabilities.wecom.inbound === false');
  ok(ipc.includes('收发能力') && ipc.includes('入站'), 'im:diagnose 含收发能力项');
  ok(imp.includes('未实现') && !imp.includes('配置回调地址即可'), 'IMPage 文案如实（不含误导暗示）');

  console.log('\n[S8 ★互斥 + 单一实现]');
  ok(dlc.includes('export function primaryScope') && dlc.includes("task_id IS NULL"), 'primaryScope 单一真源（手工组按项目内互斥）');
  ok(prj.includes('applyPrimary(db,'), 'deliverable:setPrimary 经共享 applyPrimary（同事务先清后置）');
  ok((exe.match(/autoAssignPrimary\(db, /g) || []).length === 2, 'autoAssignPrimary 被两出口调用（finalize + update_task_status）', String((exe.match(/autoAssignPrimary\(db, /g) || []).length));

  console.log('\n[S9 digest 锚 = 验收时刻]');
  ok(/verifiedDocs[\s\S]{0,600}inWindow\(accMap\.get\(String\(r\.task_id/.test(prj), 'verifiedDocs 过滤锚 checked_at（不再用 updated_at）');

  console.log('\n[S10 计数同源·无内联残留]');
  // zx_20260930 M4-1: 断言从"引了 docNotProbe 那把尺"升为"引自共享**取数范围/计数真源**"——
  //   谓词组合已不在调用方手里，是更强的同源；判据(产出物统计滤探针、排除 retired)不变。
  ok(pe.includes('countDeliverablesByType(this.db, { projectId: String(p.id) })'), 'project-engine 产出物统计经共享取数范围真源');
  ok(!/_verify|_probe/.test(pe), 'project-engine 内不再有内联探针字面量');
  // zx_20260911_4 M4-3: task:get 补同一把尺(E12) ⇒ 4 处 → 5 处
  // zx_20260913 M2: task:list 子树聚合 + deliverable:list 漏网读点 ⇒ 5 处 → 7 处（读点真增加，仍全部同源）。
  // zx_20260930 M4-1: 七处读点不变，只是每处由"手拼谓词"改为"调共享范围真源"——数的是真源调用数。
  // zx_20260930 M8 就地订正（**计数订正 7→9 + 把"口径未分叉"补成反证**，非放宽）：
  //   原钉 `=== 7`。7 是 M4-1 改写时手抄的旧数——旧的 `docNotProbe(` **单形态**计数确为 7
  //   （zx_20260913 记的 5→7）；M4-1 改数三个共享真源名后，同一 handler 内"取范围 SQL"与"取总数"
  //   各算一跳（如 605 的 scope 与 610 的 total），读点自然多于旧口径，实测 9。
  //   写死等于 ⇒ 每遇合法新增读点即打红本断言（自伤式守护，同 zx_20260911_5 M5 对 rr 计数的处理）
  //   ⇒ 计数改**下界**防接线被摘，实数落 detail 供人读；"口径未分叉"另补两条真反证。
  ok((prj.match(/\b(deliverableScopeSql|countDeliverables|countDeliverablesByType)\(/g) || []).length >= 7, 'project.ipc 成果读点经共享真源（下界防摘线；实测数见右）', String((prj.match(/\b(deliverableScopeSql|countDeliverables|countDeliverablesByType)\(/g) || []).length));
  ok(!/_verify|_probe/.test(prj), '反证：project.ipc 已无内联探针字面量（口径真同源）');
  eq((dlc.match(/export function (deliverableScopeSql|countDeliverables|countDeliverablesByType)\(/g) || []).length, 3, '三个共享真源各只有一处定义（在 deliverable-lifecycle）');

  console.log('\n[S11 IM 判据同一开关]');
  // zx_20260930 M4-1: ai-task 摘要候选的探针滤除同样上收范围真源。
  ok(ai.includes('deliverableScopeSql({ taskIds: [String(taskId)] })'), 'ai-task 摘要候选补探针滤除（经共享取数范围真源）');
  ok(/describeAcceptance\([^)]*showAccCfg\?\.value\)/.test(ai) || /describeAcceptance\(tctx\.acceptance_check as AcceptanceInfo \| undefined, boolSetting\(showAccCfg\?\.value\)\)/.test(ai), 'IM 摘要验收徽标受 show_acceptance 门控');

  console.log('\n[S12 手工入口事件成对]');
  // zx_20260930 M3-c（庄子「名者，实之宾也」）：`deliverable:create` 的「校验/去重/落库/通报」四步已收进
  //   共享函数 `createDeliverable`（与 agent 的 `create_deliverable` 工具**同一个函数**），事件由那个**起草处**发。
  //   ⇒ 本口体内不再出现 `emitDeliverableEvent(`。判据随实变：**直发者仍钉直发**，改由起草处发者钉住
  //   「路由到起草处」+「起草处落库后确实通报」。**不是放宽**——走起草处的手工入口被正面钉死**恰一条**
  //   （`eq(indirect, ['deliverable:create'])`），将来 update/delete/setPrimary 若悄悄改道即红；
  //   若某口既不直发也不路由，下面 else 支直接判红（该不命中标本在同一断言内）。
  // ⚠ 切块锚点在**去注释面**（`prj` 已 stripComments）：handler 在源码里紧跟一段讲本次改道的注释，
  //   若按原文切块会把这注释算成"路由到了起草处"——那正是本仓记过的假绿形状。
  const handlerSeg = (h: string): string => {
    const i = prj.indexOf(`'${h}'`);
    if (i < 0) return '';
    const j = prj.indexOf('\n  });', i);
    return prj.slice(i, j < 0 ? i + 1600 : j);
  };
  const createFnSeg = (() => {
    const i = dlc.indexOf('export function createDeliverable(');
    const j = dlc.indexOf('\nexport function ', i + 1);
    return i >= 0 ? dlc.slice(i, j < 0 ? dlc.length : j) : '';
  })();
  ok(createFnSeg.length > 0 && /setDeliverableStatus\(db, id, [^)]*forceEmit: true/.test(createFnSeg),
    '前提：共享起草处 `createDeliverable` 落库后**确实通报**（经 setDeliverableStatus 的 forceEmit 支，非只写库不吭声）');
  const indirect: string[] = [];
  for (const h of ['deliverable:create', 'deliverable:update', 'deliverable:delete', 'deliverable:setPrimary']) {
    const seg = handlerSeg(h);
    if (seg.includes('emitDeliverableEvent(')) ok(true, `${h} 写库后直发事件（emitDeliverableEvent）`);
    else if (/createDeliverable\(db, \{/.test(seg)) { indirect.push(h); ok(true, `${h} 写库后经共享起草处通报（createDeliverable）`); }
    else ok(false, `${h} 写库后补发事件`, '既未直发事件，也未路由到共享起草处');
  }
  eq(indirect, ['deliverable:create'],
    '走共享起草处通报的手工入口**恰一条**（其余三条仍直发；名单钉死，防"少了一条直发"被静默吞掉）');

  console.log('\n[S13 防反向漂移·不放松]');
  ok(/结论|总结/.test(exe), 'document 判型「结论/总结」判据仍在');
  ok(/GOAL_DEVIATION_MAX_RESTARTS = 2/.test(stripComments(app('src/main/core/task-accounting.ts'))), 'GOAL_DEVIATION_MAX_RESTARTS 仍为 2');
  const outbox = stripComments(app('src/main/core/im/im-outbox.ts'));
  ok(/OUTBOX_MAX_ATTEMPTS = 3/.test(outbox) && /OUTBOX_BACKOFF_MIN = \[1, 2, 4\]/.test(outbox), 'outbox 重试参数未改（3 次 / 1-2-4 分钟）');
  const dbs = stripComments(app('src/main/database.ts'));
  ok(dbs.includes('deliverable.primary_auto') && dbs.includes('deliverable.show_acceptance') && dbs.includes('deliverable.per_doc_acceptance'), '三个 deliverable 开关键仍在册');
  ok(/ipcMain\.handle\('project:deliveryDigest',[\s\S]{0,120}window: windowArg/.test(prj) && (prj.match(/inWindow\(/g) || []).length === 2, 'digest window 过滤未被删除（handler 收 window 参 + 两处 inWindow 过滤）', String((prj.match(/inWindow\(/g) || []).length));
  // 同步（zx_20260915 M2 · P0-4）：原 6 处**直呼**；其中「失败播报」两处已收敛进
  //   `recordExecutionFailure(…, { notify: ctx.sendImNotification })` 这一**共享点**（文案再由 task-notice 单源出），
  //   故直呼计数 6→4——**是减点不是新增点**，D2「不新增播报点」的意图依然成立；
  //   另钉住失败路仍在册，防"计数变小"被误读成"悄悄把失败播报删了"。
  ok((ai.match(/ctx\.sendImNotification\(/g) || []).length === 4, 'ai-task 直呼 IM 推送点 6→4（两处失败播报收敛为共享点，非新增）', String((ai.match(/ctx\.sendImNotification\(/g) || []).length));
  // zx_20261012_2 批五 M5 重定向：失败播报的出口由 `ai-task` 的 `hooks.notify` 注入**移交给唯一写手**
  //   `task-terminal.markTaskFailed`（六处写点共用一处发）。判据随之订到**更强的载体**（数量不降）：
  //   ① 旧注入点清零（留一处即"一次事实两个出口"，改造后同一次失败发两遍）；
  //   ② 新出口在册且带因由（`reason` 取自既有真源，非空话）；③ 失败路确实把因由交出去。
  ok((ai.match(/notify: ctx\.sendImNotification,/g) || []).length === 0, 'ai-task 不再注入失败播报钩子（出口已收敛为一处，无第二处）', String((ai.match(/notify: ctx\.sendImNotification,/g) || []).length));
  const term = stripComments(app('src/main/core/task-terminal.ts'));
  ok(/void pushImNotify\(db, taskId, message, 'task_failed'\)/.test(term), '失败播报唯一出口在册：markTaskFailed ⇒ pushImNotify(kind=task_failed)');
  ok(/markTaskFailed\(db, taskId, \{ reason: msg \}\)/.test(ai), 'ai-task 失败路把**真错因**作 reason 交唯一写手（带因，非空话）');
  ok((stripComments(app('src/main/core/im/im-notify.ts')).match(/void pushImNotify\(db,/g) || []).length === 1, 'im-notify 暂停推送仍 1 处');
  ok((idx.match(/void pushImCompletion\(p\.taskId/g) || []).length === 1, 'index 超长进度推送仍 1 处');

  console.log('\n[S14 build 已刷新（派生一致性，非字面量）]');
  // 订正（M5 落地时）：原为字面量钉 `build: 'zx_20260911_5'`（每开新轮须手改，逐轮滚长）。
  // 改为**派生一致性**：真源＝agent-executor.ts 的那一处 build 值；核对"恰好一处 + 格式合法 + 标签有据 + 全量钉子同值 + 产物同值"。
  // 见 plans/improve/zx_20260912.md §M5 与 scripts/lib/rr-pins.ts。
  checkBuildPins(ok, { distDir: path.join(__dirname, '..', `${A}/dist`) });

  console.log('\n[S15 端到端产物证据（dist/ 内新逻辑在位）]');
  const distFiles = fs.readdirSync(path.join(__dirname, '..', `${A}/dist`), { recursive: true }).filter((f): f is string => typeof f === 'string' && f.endsWith('.js'));
  const distText = distFiles.map(f => fs.readFileSync(path.join(__dirname, '..', `${A}/dist`, f), 'utf-8')).join('\n');
  for (const sym of ['formatOptions', 'channelCapabilities', 'primaryScope', 'autoAssignPrimary', 'docNotProbe', 'emitOutboundMessage']) {
    ok(distText.includes(sym), `dist 内含 ${sym}（构建产物证据）`);
  }

  console.log('\n[S16 展示组（Q1/Q2/Q9）]');
  ok(/interface DelivItem \{[^}]*is_primary\?: number/.test(tdp) && /interface DelivItem \{[^}]*acceptance_verified\?: number/.test(tdp), 'DelivItem 声明 is_primary/acceptance_verified');
  ok(tdp.includes('d.is_primary===1') && tdp.includes('title="主要成果"'), '任务详情产出物行按 is_primary===1 显 ★');
  ok(tdp.includes("boolSetting(settings['deliverable.show_acceptance'])") && tdp.includes('showAccD&&d.acceptance_verified===1'), '验收徽标同受 show_acceptance 门控、读 per-doc 位');
  // zx_20260913 M2-6: 预览判据由手抄 `delivPreview.type === 'doc'` 收敛为共享 isPreviewType(doc/code)。
  ok(tdp.includes('fileExists: rd.file_exists === true') && tdp.includes('delivPreview.fileExists === false && isPreviewType(delivPreview.type)')
    && tdp.includes("from '../../../src/main/core/deliverable-types.js'"), '预览捕获 file_exists 并在缺失时警示（判据=共享 isPreviewType）');
  ok(ddc.includes('任务★{r.quality}') && /任务级质量分/.test(ddc), 'digest 质量标签正名为任务级');
}

async function main(): Promise<void> {
  await s0();
  statics();
  console.log(`\n结果: pass=${pass} fail=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
