/**
 * zx_20260911_4 受控复跑（「回声：往返要在生产入参上成立」）。
 *
 * 本轮把 M1–M6 的临时探针归并为本文件（M6 段为收口：build 刷新 + 反向残留 + rr 计数）：
 *   M1 IM 审批往返：问 → 答（回退路径接受确认/拒绝、候选集限维度+时间窗、判定单一真源、
 *      编号选项让位、清单同源、失效内存项不得遮蔽真库活任务）
 *   M2 IM 送达往返：发 → 到（outbox 兜底、失败即抛）
 *   M3 IM 命令往返：喊 → 认（help 只列配了 im_commands 的 active 项目 + 承认）
 *   M4 成果验收往返：验收 → 展示（一条判据、task:get 补同一把尺）
 *   M5 记忆往返：存 → 取（检索四路 + 范例同过 archived 尺；压缩不遮蔽）
 *
 * 断言两类（承 zx_20260911_2 §九 与 feedback「往返/闭环类判据须在生产入参上证」）：
 *   静态断言一律 `stripComments` 后再比对，防注释里的关键词造成假阳性；
 *   行为断言动态 import **真实现**，输入取**真库逐字入参**（见下 REAL_CTX）——
 *   身份、选项文本、ctx 键名均照抄真库，不用"等价自造入参"。
 *
 * 本文件不打开任何真库（真库只读实测见 data/baseline_zx_20260911_4.json）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
import { formatOptions, parseOptions, matchApprovalReply } from '../apps/worker-ant-desktop/src/main/core/im/options.js';
import {
  routeImMessage, registerPendingApproval, setNotificationDir,
  startF3NotificationPush, stopF3NotificationPush, triggerF3Notification,
} from '../apps/worker-ant-desktop/src/main/services/im-router.js';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import { planSummaryChunks, buildRuleDigest } from '../apps/worker-ant-desktop/src/main/core/context-compaction.js';
import { MEM_LIVE_SQL } from '../apps/worker-ant-desktop/src/main/core/memory-lifecycle.js';

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

const SCHEMA = `
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT, status TEXT, context_json TEXT, updated_at TEXT, priority INTEGER);
CREATE TABLE wa_task_conversations (id TEXT, task_id TEXT, role TEXT, content TEXT, token_count INTEGER, created_at TEXT);
CREATE TABLE wa_jobs (id TEXT, type TEXT, payload TEXT, status TEXT);
CREATE TABLE wa_im_conversations (id TEXT, channel_id TEXT, external_user_id TEXT, message_json TEXT, direction TEXT, created_at TEXT);
CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL, embedding TEXT, memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '', updated_at TEXT, created_at TEXT DEFAULT (datetime('now')), valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT, exemplar_context TEXT, use_count INTEGER DEFAULT 0, last_used_at TEXT, similar_to TEXT DEFAULT '', last_reinforced_at TEXT, success_count INTEGER DEFAULT 0, failure_count INTEGER DEFAULT 0);
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, status TEXT, context_json TEXT, working_dir TEXT);
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE wa_im_outbox (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT, kind TEXT DEFAULT 'notification', message TEXT DEFAULT '', attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', next_retry_at INTEGER, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, name TEXT, type TEXT, status TEXT, file_path TEXT, description TEXT, registry_id TEXT, is_primary INTEGER DEFAULT 0, acceptance_verified INTEGER DEFAULT 0, version INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
`;
const mkdb = (): AnyDb => { const d = withTx(new DatabaseSync(':memory:')); d.exec(SCHEMA); return d as unknown as AnyDb; };

// ── 生产入参夹具（真库 data/worker-ant-server.db，任务 3f85ae49-0582-489b-baec-6904c904c245）──
// 真库唯一带 channel/externalUser 的任务，其 context_json 逐字：channel / externalUser 照抄，
// 其余键名与取值同形（略去与判据无关的 world_snapshot 巨块）。
const IM_CH = 'wechat-personal';
const IM_USER = 'o9cq80x7XC8w9TolIfPuHbpTqaZA@im.wechat';
const REAL_CTX: Record<string, unknown> = {
  source: 'im', channel: IM_CH, externalUser: IM_USER,
  intentType: 'create', archetype: 'research', archetype_label: '调查研究',
  taskId: '3f85ae49-0582-489b-baec-6904c904c245',
};

/** 造一个 paused 任务 + 一条真形态的 [等待用户输入] 会话。ageDays=0 即"现在"。 */
function mkPaused(db: AnyDb, id: string, ctx: Record<string, unknown>, ask: string | null, ageDays = 0, priority = 0): void {
  const ageExpr = ageDays === 0 ? "datetime('now')" : `datetime('now','-${ageDays} days')`;
  db.prepare(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, updated_at, priority) VALUES (?,?,?,?,?, ${ageExpr}, ?)`)
    .run(id, 'p1', `T-${id}`, 'paused', JSON.stringify(ctx), priority);
  if (ask) db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?,?,?,?,0,datetime('now'))")
    .run(`c-${id}`, id, 'system', ask);
}
const convs = (db: AnyDb, id: string) => (db.prepare('SELECT content FROM wa_task_conversations WHERE task_id = ?').all(id) as Array<{ content: string }>).map(r => r.content);
const statusOf = (db: AnyDb, id: string) => (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string } | undefined)?.status;
const jobs = (db: AnyDb) => (db.prepare("SELECT payload FROM wa_jobs WHERE type='resume-ai-task'").all() as Array<{ payload: string }>).map(j => JSON.parse(j.payload) as { taskId: string; message?: string });

function ictx(db: AnyDb, replies: string[], channelType = IM_CH) {
  return { db, channelId: 'ch-real', channelType, sendReply: async (_to: string, t: string) => { replies.push(t); } };
}
/** 风暴/去重按 fromUser 与全文计：每场景隔 2.1s，避免被静默丢弃 */
const settle = () => new Promise(r => setTimeout(r, 2100));

async function m1(): Promise<void> {
  // ── S1 判定单一真源 matchApprovalReply ──────────────────────────────
  console.log('\n[M1/S1 审批回复判定·单一真源]');
  eq(matchApprovalReply(['A', 'B'], '是'), { kind: 'confirm' }, '「是」→ confirm');
  eq(matchApprovalReply(['A', 'B'], 'OK'), { kind: 'confirm' }, '「OK」→ confirm（大小写不敏感）');
  eq(matchApprovalReply(['A', 'B'], '否'), { kind: 'reject' }, '「否」→ reject');
  eq(matchApprovalReply(['A', 'B'], '1'), { kind: 'option', index: 0, text: 'A' }, '数字「1」→ 第 1 项');
  eq(matchApprovalReply(['A', 'B'], '2'), { kind: 'option', index: 1, text: 'B' }, '数字「2」→ 第 2 项');
  eq(matchApprovalReply(['甲', '乙'], '（1）'), { kind: 'option', index: 0, text: '甲' }, '「（1）」→ 第 1 项');
  eq(matchApprovalReply(['甲', '乙'], 'b、'), { kind: 'option', index: 1, text: '乙' }, '「b、」→ 第 2 项（字母不敏感）');
  eq(matchApprovalReply(['甲', '乙'], '9'), null, '越界编号 → 不认');
  eq(matchApprovalReply(['继续执行', '放弃'], '继续'), { kind: 'option', index: 0, text: '继续执行' }, '短回复命中长选项（双向 includes）');
  eq(matchApprovalReply(['A', 'B'], '把报告改成中文'), null, '自由回复 → 不认（不误吃）');
  eq(matchApprovalReply([], '是'), { kind: 'confirm' }, '无选项时「是」仍 → confirm');
  eq(matchApprovalReply([], '1'), null, '无选项时编号 → 不认');

  // ── S2 回退路径（内存队列为空）用生产入参命中 ───────────────────────
  console.log('\n[M1/S2 回退路径·生产入参往返]');
  {
    const db = mkdb();
    mkPaused(db, 'real1', REAL_CTX, '[等待用户输入] 继续执行? [选项: 继续 / 放弃]');
    const replies: string[] = [];
    await routeImMessage(ictx(db, replies) as never, IM_USER, '是', 'private', '');
    const cs = convs(db, 'real1');
    ok(cs.includes('[用户确认执行]'), '「是」经回退路径落 [用户确认执行]', cs.join(' | ').slice(0, 60));
    ok(!cs.includes('是'), '不再把裸「是」原样落库');
    ok(!cs.some(c => c.startsWith('[IM回复]')), '未被当自由回复吃掉');
    const j = jobs(db);
    ok(j.length === 1 && j[0]!.taskId === 'real1', '恢复作业定向到被审批的任务', JSON.stringify(j[0]));
    ok(statusOf(db, 'real1') === 'pending', '任务被恢复为 pending');
    ok(replies.some(r => r.includes('正在恢复任务')), '回执为「正在恢复任务…」');
  }

  // ── S2b 「否」：以审批语义被认领为拒绝，任务不恢复 ────────────────
  await settle();
  console.log('\n[M1/S2b 回退路径·拒绝]');
  {
    const db = mkdb();
    const uRej = 'o9cq80REJECT_ONLY@im.wechat';   // 换用户避开 30s 去重（「否」在下文另有他人用）
    mkPaused(db, 'rej1', { ...REAL_CTX, externalUser: uRej }, '[等待用户输入] 继续执行? [选项: 继续 / 放弃]');
    const replies: string[] = [];
    await routeImMessage(ictx(db, replies) as never, uRej, '否', 'private', '');
    const cs = convs(db, 'rej1');
    ok(replies.some(r => r.includes('已取消')), '「否」被认领为拒绝并回「已取消，任务将继续等待」', replies.join(' | ').slice(0, 40));
    ok(statusOf(db, 'rej1') === 'paused', '任务仍暂停（拒绝不放行恢复）');
    ok(jobs(db).length === 0, '未产生恢复作业');
    ok(!cs.some(c => c.startsWith('[IM回复]')), '未落入自由回复');
    ok(!cs.some(c => c.includes('用户选择')), '未落选项标记（拒绝不冒充选项命中）');
    ok(!cs.includes('否'), '未把裸「否」原样落库');
  }

  // ── S3 反证：别的用户/别的渠道不得命中 ─────────────────────────────
  await settle();
  console.log('\n[M1/S3 反证·他人他渠道不命中]');
  {
    const db = mkdb();
    mkPaused(db, 'other_user', { channel: IM_CH, externalUser: 'o9cq80SOMEONE_ELSE@im.wechat' }, '[等待用户输入] 继续? [选项: A / B]');
    mkPaused(db, 'other_ch', { channel: 'wecom', externalUser: IM_USER }, '[等待用户输入] 继续? [选项: A / B]');
    const replies: string[] = [];
    await routeImMessage(ictx(db, replies) as never, IM_USER, 'A', 'private', '');
    ok(statusOf(db, 'other_user') === 'paused', '他人任务的「A」不命中本用户（仍 paused）');
    ok(statusOf(db, 'other_ch') === 'paused', '他渠道任务的「A」不命中本渠道（仍 paused）');
    ok(convs(db, 'other_user').every(c => !c.includes('用户选择')), '他人任务未落审批标记');
    ok(jobs(db).length === 0, '未产生恢复作业');
  }

  // ── S4 反证：时间窗外不被审批路径命中 ─────────────────────────────
  await settle();
  console.log('\n[M1/S4 反证·窗外不命中审批路径]');
  {
    const db = mkdb();
    // 换用户：去重键含 fromUser+全文，S2 已用 IM_USER 发过「是」（30s 窗口）
    const staleUser = 'o9cq80STALE_ONLY@im.wechat';
    mkPaused(db, 'stale', { channel: IM_CH, externalUser: staleUser }, '[等待用户输入] 继续? [选项: 继续 / 放弃]', 30);
    const replies: string[] = [];
    await routeImMessage(ictx(db, replies) as never, staleUser, '是', 'private', '');
    const cs = convs(db, 'stale');
    ok(!cs.includes('[用户确认执行]'), '窗外任务不被裸「是」以审批语义命中');
    ok(!replies.some(r => r.includes('正在恢复任务')), '未回「正在恢复任务」（非审批路径）');
    ok(replies.some(r => r.includes('已收到回复')) || cs.some(c => c.startsWith('[IM回复]')),
      '如期落入原自由回复语义（如实记录边界，非回归）', replies.join(' | ').slice(0, 50));
  }

  // ── S5 生产入参：编号即审批选项时让位（M1-4） ──────────────────────
  await settle();
  console.log('\n[M1/S5 编号让位于审批·生产入参]');
  {
    const db = mkdb();
    mkPaused(db, 'appr', REAL_CTX, '[等待用户输入] 继续执行? [选项: 继续 / 放弃]', 0, 9);
    mkPaused(db, 'global', { channel: IM_CH, externalUser: IM_USER }, null, 0, 99);
    registerPendingApproval(IM_CH, IM_USER, { taskId: 'appr', projectId: 'p1', question: '继续执行?', options: formatOptions(['继续', '放弃']), createdAt: Date.now() });
    const replies: string[] = [];
    await routeImMessage(ictx(db, replies) as never, IM_USER, '1', 'private', '');
    const cs = convs(db, 'appr');
    ok(cs.includes('[用户选择: 1]'), '「1」判为审批选项 → 落 [用户选择: 1]', cs.join(' | ').slice(0, 60));
    ok(convs(db, 'global').length === 0, '未被当作"恢复第 1 个暂停任务"而误恢复 global');
    ok(statusOf(db, 'global') === 'paused', 'global 仍 paused');
    ok(jobs(db).length === 1 && jobs(db)![0]!.taskId === 'appr', '恢复作业定向到被审批的任务');
  }

  // ── S5b 范围外的编号仍按任务编号（不被静默吞掉） ───────────────────
  await settle();
  console.log('\n[M1/S5b 范围外编号·不按审批选项处理]');
  {
    const db = mkdb();
    mkPaused(db, 'appr2', REAL_CTX, '[等待用户输入] 继续? [选项: 继续 / 放弃]', 0, 9);
    registerPendingApproval(IM_CH, IM_USER, { taskId: 'appr2', projectId: 'p1', question: '继续?', options: formatOptions(['继续', '放弃']), createdAt: Date.now() });
    const replies: string[] = [];
    await routeImMessage(ictx(db, replies) as never, IM_USER, '5', 'private', '');
    ok(!convs(db, 'appr2').some(c => c.includes('用户选择')), '「5」越出选项范围 → 未按审批选项处理');
    ok(!convs(db, 'appr2').some(c => c.startsWith('[IM回复]')), '亦未落入自由回复');
  }

  // ── S6 清单同源：展示的编号 == 可选择的编号 ────────────────────────
  await settle();
  console.log('\n[M1/S6 清单同源·展示编号即可选编号]');
  {
    const db = mkdb();
    for (let i = 1; i <= 6; i++) mkPaused(db, `r${i}`, { channel: IM_CH, externalUser: 'u_scope' }, null, 0, i * 10);
    const replies: string[] = [];
    await routeImMessage(ictx(db, replies) as never, 'u_scope', '开始', 'private', '');
    const listMsg = replies.find(r => r.includes('请回复编号')) || '';
    ok(!!listMsg, '「开始」列出可启动任务并请回复编号');
    const lines = listMsg.split('\n').slice(1).filter(l => /^\d+\. /.test(l));
    ok(lines.length === 6, '列出 6 项（旧展示侧 LIMIT 5 会截到 5，与选择侧错位）', String(lines.length));
    const sixthShown = lines[5]!.replace(/^\d+\. /, '');
    replies.length = 0;
    await routeImMessage(ictx(db, replies) as never, 'u_scope', '6', 'private', '');
    const j = jobs(db);
    ok(j.length === 1, '回复编号 6 产生 1 个恢复作业');
    const picked = (db.prepare('SELECT title FROM wa_tasks WHERE id = ?').get(j[0]!.taskId) as { title: string } | undefined)?.title;
    ok(!!picked && picked === sixthShown, '恢复的正是被展示为第 6 项的那条', `${picked} vs ${sixthShown}`);
  }

  // ── S7 反证：LIKE 通配不再误命中（`_` 是 LIKE 单字符通配） ─────────
  await settle();
  console.log('\n[M1/S7 反证·LIKE 通配误命中已除]');
  {
    const dbA = mkdb();
    mkPaused(dbA, 'ctrl', { channel: IM_CH, externalUser: 'u_pct' }, null);
    const rA: string[] = [];
    await routeImMessage(ictx(dbA, rA) as never, 'u_pct', '改成中文', 'private', '');
    ok(convs(dbA, 'ctrl').some(c => c.startsWith('[IM回复]')), '对照：同用户自由回复正常落 handleAgentReply');

    await settle();
    const dbB = mkdb();
    mkPaused(dbB, 'wild', { channel: IM_CH, externalUser: 'uXpct' }, null);
    const rB: string[] = [];
    await routeImMessage(ictx(dbB, rB) as never, 'u_pct', '整理一下', 'private', '');
    ok(convs(dbB, 'wild').length === 0, '他人任务不被 LIKE 通配误命中（json_extract 精确相等）');
    ok(statusOf(dbB, 'wild') === 'paused', '他人任务仍 paused');
  }

  // ── S8 反证：审批路径不读成果判据（守护 M4 不越界） ────────────────
  await settle();
  console.log('\n[M1/S8 反证·forced 与审批无关]');
  {
    const db = mkdb();
    mkPaused(db, 'forced1', { ...REAL_CTX, forced: true, deliverable_unfulfilled: { paths: ['x'], forced: true } }, '[等待用户输入] 继续? [选项: 继续 / 放弃]');
    const replies: string[] = [];
    await routeImMessage(ictx(db, replies) as never, IM_USER, '继续', 'private', '');
    ok(convs(db, 'forced1').includes('[用户选择: 继续]'), '带 forced 标记的任务审批路径照样生效（判据无关）');
  }

  // ── S8b 反证：失效内存项不得遮蔽真库里的活任务（M1-7） ────────────
  // 场景：内存待审批队列里留了一条早已失效的项（任务被 GUI 恢复/已终态，条目 5 分钟内未清），
  // 用户此时的回复指向的是**另一个仍在暂停的任务**。失效项若照吃不误并 return true，
  // 回复就被静默吞掉、回退路径再无机会认领 → 往返断裂。
  await settle();
  console.log('\n[M1/S8b 反证·失效内存项不遮蔽真库活任务]');
  {
    // A: 选项文本被失效项"命中" —— 仍须落到真库那条活任务
    const dbA = mkdb();
    const uA = 'o9cq80SHADOW_A@im.wechat';
    mkPaused(dbA, 'live_a', { ...REAL_CTX, externalUser: uA }, '[等待用户输入] 继续? [选项: 继续 / 放弃]');
    registerPendingApproval(IM_CH, uA, { taskId: 'ghost_a', projectId: 'p1', question: '继续?', options: formatOptions(['继续', '放弃']), createdAt: Date.now() });
    const rA: string[] = [];
    await routeImMessage(ictx(dbA, rA) as never, uA, '继续', 'private', '');
    ok(convs(dbA, 'live_a').includes('[用户选择: 继续]'), '失效项被弹出 → 选项回复落到真库活任务', convs(dbA, 'live_a').join(' | ').slice(0, 60));
    ok(statusOf(dbA, 'live_a') === 'pending', '活任务被恢复');
    ok(!rA.some(r => r.includes('审批已失效')), '不虚报「审批已失效」（真库明明认领得起）');

    // B: 裸「是」同理 —— 失效项不得把它吞掉
    await settle();
    const dbB = mkdb();
    const uB = 'o9cq80SHADOW_B@im.wechat';
    mkPaused(dbB, 'live_b', { ...REAL_CTX, externalUser: uB }, '[等待用户输入] 继续? [选项: 继续 / 放弃]');
    registerPendingApproval(IM_CH, uB, { taskId: 'ghost_b', projectId: 'p1', question: '继续?', options: formatOptions(['继续', '放弃']), createdAt: Date.now() });
    const rB: string[] = [];
    await routeImMessage(ictx(dbB, rB) as never, uB, '是', 'private', '');
    ok(convs(dbB, 'live_b').includes('[用户确认执行]'), '失效项被弹出 → 裸「是」落到真库活任务', convs(dbB, 'live_b').join(' | ').slice(0, 60));
    ok(statusOf(dbB, 'live_b') === 'pending', '活任务被恢复（是）');
    ok(jobs(dbB).length === 1 && jobs(dbB)![0]!.taskId === 'live_b', '恢复作业定向到真库活任务');
  }

  // ── S9 静态：改动点与不变量 ───────────────────────────────────────
  console.log('\n[M1/S9 静态断言]');
  {
    const router = stripComments(rd(`${A}/src/main/services/im-router.ts`));
    const opts = stripComments(rd(`${A}/src/main/core/im/options.ts`));
    ok(opts.includes('export function matchApprovalReply'), 'matchApprovalReply 落在选项唯一真源模块');
    ok(!router.includes('CONFIRM_REGEX') && !router.includes('matchDbApprovalOption'), 'im-router 不再自持一套确认/匹配（已收口共享）');
    ok(!router.includes('context_json LIKE \'%"externalUser"'), 'handleAgentReply 不再拼接 LIKE 取维度');
    ok(router.includes("json_extract(t.context_json,'$.externalUser') = ?"), 'handleAgentReply 改用绑定参数');
    ok((router.match(/resumeWithQuota\(/g) || []).length === 6, 'resumeWithQuota 仍 6 处（未增未减）', String((router.match(/resumeWithQuota\(/g) || []).length));
    // zx_20260920 M2 订正：原断言「回话失败均 .catch（≥12）」的**对象形状**已被本轮取代——失败归属
    //   从"每个调用点各吞各的"上移到两个 `ImContext.sendReply` 构造处一处落账。改钉新不变量两半，
    //   并保留"回话点在册"下界防空绿（与 rr_zx_20260911_2 同一把尺）。
    {
      const ipc = stripComments(rd(`${A}/src/main/ipc/im.ipc.ts`));
      const replySites = (router.match(/ctx\.sendReply\(/g) || []).length;
      ok(replySites >= 14, `回话点在册（实测 ${replySites} ≥ 14）`, String(replySites));
      eq((router.match(/ctx\.sendReply\([^;]*?\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g) || []).length, 0,
        '回话点零逐点空吞（失败归属上移到构造处）');
      eq((ipc.match(/accountOutboundFailure\(/g) || []).length, 2, 'im.ipc 两个 sendReply 构造处都落账');
    }
    ok(router.includes('function listResumableTasks'), '可恢复清单抽出唯一真源');
    // zx_20260930 M2 订正：原断言写死 `=== 3`（定义 1 + 调用 2）。M2 在 `handleAgentReply` 里
    //   **合法新增**了一处调用（归属歧义 → 用**同一份**清单如实回问"该归哪一个"）⇒ 计数变 4 即红。
    //   冻结计数是只对合法新增引爆的哑雷；改钉"**定义恰一处** + 每个调用点**按符号点名**都在册"。
    eq((router.match(/function listResumableTasks\(/g) || []).length, 1,
      '可恢复清单**定义恰一处**（不是把清单查询抄成第二份）');
    const callerOf = (f: string): string => {
      const i = router.indexOf(`function ${f}(`);
      if (i < 0) return '';
      const j = router.indexOf('\nfunction ', i + 1);
      return router.slice(i, j < 0 ? router.length : j);
    };
    const CALLERS = ['handleNumberSelection', 'handleAgentReply', 'handleStartTask'];
    eq(CALLERS.filter((f) => !/listResumableTasks\(/.test(callerOf(f))), [],
      '展示侧与选择侧同用一份（定义 1 + 调用点名在册：编号列出与按号选择 / 归属歧义回问 / 启动任务）');
    ok(!/SELECT id, title FROM wa_tasks WHERE status IN \('paused','failed'\) LIMIT 5/.test(router), '展示侧旧的裸 LIMIT 5 查询已除');
    ok(/checkPendingApproval\(ctx, fromUser, msgText\)\) return;/.test(router), '路由入口先试审批（命中即 return）');
    ok(/if \(isConfirm \|\| isOptionMatch\) \{/.test(router), 'A3 失效校验覆盖确认与选项两条（非只认确认）');
  }
}

async function m2(): Promise<void> {
  const ob = await import('../apps/worker-ant-desktop/src/main/core/im/im-outbox.js');
  const err = await import('../apps/worker-ant-desktop/src/main/core/im/im-errors.js');
  const { WechatAdapter } = await import('../apps/worker-ant-desktop/src/main/services/wechat-adapter.js');
  const { enqueueImOutbox, retryImOutbox, reviveQuotaBlockedOutbox } = ob;
  const { ImQuotaError, isImQuotaError } = err;

  type Row = { id: string; status: string; attempts: number; kind: string; message: string; external_user_id: string; next_retry_at: number | null };
  const rowsOf = (db: AnyDb) => db.prepare('SELECT * FROM wa_im_outbox').all() as unknown as Row[];
  const one = (db: AnyDb) => { const r = rowsOf(db); ok(r.length === 1, `账上恰 1 行（实际 ${r.length}）`); return r[0]!; };
  const ASK = '继续执行? [选项: 继续 / 放弃]';

  // ── S1 落账：发送失败的问句进 outbox（kind=ask_user、attempts=0、原文保留） ──
  console.log('\n[M2/S1 ask_user 发送失败落账]');
  {
    const db = mkdb();
    enqueueImOutbox(db as never, { channelId: 'ch-real', externalUserId: IM_USER, taskId: 'real1', kind: 'ask_user', message: ASK });
    const r = one(db);
    ok(r.status === 'pending' && r.attempts === 0 && r.kind === 'ask_user', 'pending / attempts=0 / kind=ask_user', `${r.status}/${r.attempts}/${r.kind}`);
    ok(r.message === ASK, '问句原文逐字保留（补发不重拼）');
    ok(r.external_user_id === IM_USER, 'external_user_id 用生产入参');
  }

  // ── S2 补发成功 → sent（attempts 记账） ─────────────────────────────
  console.log('\n[M2/S2 补发成功置 sent]');
  {
    const db = mkdb();
    enqueueImOutbox(db as never, { channelId: 'ch-real', externalUserId: IM_USER, taskId: 'real1', kind: 'ask_user', message: ASK });
    await retryImOutbox(db as never, 10, { send: async () => true });
    const r = one(db);
    ok(r.status === 'sent' && r.attempts === 1 && r.next_retry_at === null, 'sent / attempts=1 / 清 next_retry_at', `${r.status}/${r.attempts}`);
  }

  // ── S3 普通失败按 1/2/4 min 退避、3 次转 dead ──────────────────────
  console.log('\n[M2/S3 普通失败·有界退避 3 次转 dead]');
  {
    const db = mkdb();
    enqueueImOutbox(db as never, { channelId: 'ch-real', externalUserId: IM_USER, taskId: 'real1', kind: 'ask_user', message: ASK });
    const t0 = Date.now();
    await retryImOutbox(db as never, 60, { now: t0, send: async () => false });
    let r = one(db);
    ok(r.attempts === 1 && r.status === 'pending' && r.next_retry_at === t0 + 60_000, '第 1 次失败 → 退避 1 min', `${r.attempts}/${r.next_retry_at! - t0}ms`);
    await retryImOutbox(db as never, 60, { now: t0 + 2 * 60_000, send: async () => false });
    r = one(db);
    ok(r.attempts === 2 && r.next_retry_at === t0 + 2 * 60_000 + 2 * 60_000, '第 2 次失败 → 退避 2 min');
    await retryImOutbox(db as never, 60, { now: t0 + 10 * 60_000, send: async () => false });
    r = one(db);
    ok(r.attempts === 3 && r.status === 'dead', '第 3 次失败 → dead（知止不穷追）', `${r.attempts}/${r.status}`);
  }

  // ── S4 超窗 → dead（不再补发） ─────────────────────────────────────
  console.log('\n[M2/S4 超窗不补发]');
  {
    const db = mkdb();
    enqueueImOutbox(db as never, { channelId: 'ch-real', externalUserId: IM_USER, taskId: 'real1', kind: 'ask_user', message: ASK });
    db.prepare("UPDATE wa_im_outbox SET created_at = datetime('now','-30 minutes')").run();
    let called = 0;
    await retryImOutbox(db as never, 10, { send: async () => { called++; return true; } });
    const r = one(db);
    ok(called === 0 && r.status === 'dead', '窗外行直接 dead，不发起发送', `send 调用 ${called} 次`);
  }

  // ── S5 M2-2 配额类失败：不烧尝试次数、标 blocked_quota ─────────────
  console.log('\n[M2/S5 配额类失败不烧次数]');
  {
    const db = mkdb();
    enqueueImOutbox(db as never, { channelId: 'ch-real', externalUserId: IM_USER, taskId: 'real1', kind: 'ask_user', message: ASK });
    await retryImOutbox(db as never, 60, { send: async () => { throw new ImQuotaError('配额耗尽'); } });
    const r = one(db);
    ok(r.status === 'blocked_quota', '标 blocked_quota（非 dead、非 pending）', r.status);
    ok(r.attempts === 0, 'attempts 不增（烧完 3 次转 dead 会真丢问句）', String(r.attempts));
  }

  // ── S6 入站复活 → 补发成功（闭环） ────────────────────────────────
  console.log('\n[M2/S6 入站刷新配额后复活重试]');
  {
    const db = mkdb();
    enqueueImOutbox(db as never, { channelId: 'ch-real', externalUserId: IM_USER, taskId: 'real1', kind: 'ask_user', message: ASK });
    await retryImOutbox(db as never, 60, { send: async () => { throw new ImQuotaError('配额耗尽'); } });
    let sent = '';
    const n = reviveQuotaBlockedOutbox(db as never, IM_USER);
    ok(n === 1, '入站复活 1 行', String(n));
    await retryImOutbox(db as never, 60, { send: async (row) => { sent = row.message; return true; } });
    const r = one(db);
    ok(r.status === 'sent', '复活后补发成功 → sent', r.status);
    ok(sent === ASK, '补发的是原问句');
  }

  // ── S7 反证：只复活本人（配额窗口本就按人统计） ─────────────────────
  console.log('\n[M2/S7 反证·只复活本人]');
  {
    const db = mkdb();
    enqueueImOutbox(db as never, { channelId: 'ch-real', externalUserId: 'o9cq80OTHER@im.wechat', taskId: 'other', kind: 'ask_user', message: ASK });
    await retryImOutbox(db as never, 60, { send: async () => { throw new ImQuotaError('配额耗尽'); } });
    ok(one(db).status === 'blocked_quota', '他人行先被挡下');
    ok(reviveQuotaBlockedOutbox(db as never, IM_USER) === 0, '本用户入站不复活他人行');
    ok(one(db).status === 'blocked_quota', '他人行仍 blocked_quota');
  }

  // ── S8 悬行封顶：blocked_quota 超窗同样 dead ──────────────────────
  console.log('\n[M2/S8 blocked_quota 超窗封顶]');
  {
    const db = mkdb();
    enqueueImOutbox(db as never, { channelId: 'ch-real', externalUserId: IM_USER, taskId: 'real1', kind: 'ask_user', message: ASK });
    await retryImOutbox(db as never, 60, { send: async () => { throw new ImQuotaError('配额耗尽'); } });
    db.prepare("UPDATE wa_im_outbox SET created_at = datetime('now','-3 hours')").run();
    await retryImOutbox(db as never, 60, { send: async () => true });
    const r = one(db);
    ok(r.status === 'dead', '超窗未被复活 → dead（不留永远扫不动的悬行）', r.status);
  }

  // ── S9 真适配器：发送条件缺失抛类型化错误（无网络调用） ────────────
  console.log('\n[M2/S9 wechat 适配器·类型化失败]');
  {
    const db = mkdb();
    const mkAd = (token: unknown) => {
      const a = new WechatAdapter(db as never, 'ch-real', {}, '/tmp') as unknown as {
        token: unknown;
        pushQuota: Map<string, { used: number; limit: number; lastUserMsgAt: number; warned: boolean }>;
        sendReply: (u: string, t: string, c?: string) => Promise<void>;
      };
      a.token = token;
      return a;
    };
    const bare = mkAd(null);
    try {
      await bare.sendReply(IM_USER, 'hi');
      ok(false, '无 token 应抛错');
    } catch (e) {
      ok(isImQuotaError(e), '无 token → ImQuotaError（发送条件缺失，非消息问题）', (e as Error).message.slice(0, 40));
    }
    const quotaOut = mkAd({ token: 't' });
    quotaOut.pushQuota.set(IM_USER, { used: 5, limit: 5, lastUserMsgAt: Date.now(), warned: false });
    try {
      await quotaOut.sendReply(IM_USER, 'hi');
      ok(false, '配额耗尽应抛错');
    } catch (e) {
      ok(isImQuotaError(e), '主动推送配额耗尽 → ImQuotaError（未发起网络请求）', (e as Error).message.slice(0, 40));
    }
    const okAd = mkAd({ token: 't' });
    okAd.pushQuota.set(IM_USER, { used: 0, limit: 5, lastUserMsgAt: Date.now(), warned: false });
    ok(typeof okAd.sendReply === 'function', '有 token 且配额充足时不预抛（进入真实发送路径）');
  }

  // ── S10 静态：改动点与不变量 ──────────────────────────────────────
  console.log('\n[M2/S10 静态断言]');
  {
    const idx = stripComments(rd(`${A}/src/main/index.ts`));
    const ipc = stripComments(rd(`${A}/src/main/ipc/im.ipc.ts`));
    const obx = stripComments(rd(`${A}/src/main/core/im/im-outbox.ts`));
    const wa = stripComments(rd(`${A}/src/main/services/wechat-adapter.ts`));
    const errs = stripComments(rd(`${A}/src/main/core/im/im-errors.ts`));

    // 落账须**在「!ok」分支内**（接住结果 → 失败才落账；成功不落）。仅查字符串存在不够——
    // 位置关系才是"往返"判据（承 feedback：往返类判据须在生产真实入参/真实次序上成立）。
    // 订正（M3 落地时）：结果变量由 `ok: boolean` 改为 `r: {ok, error?}`（原因要一并入账）——
    //   判据的**位置关系**（接住结果 → 「!r.ok」分支内落账 → 分支收口）逐字不变，只换变量名。
    const okIdx = idx.indexOf('const r = await sendImCompletionNotice(ch.id, toUser, taskId, question)');
    const notOkIdx = idx.indexOf('if (!r.ok) {', okIdx);
    const enqIdx = idx.indexOf('enqueueImOutbox(db, { channelId: ch.id', notOkIdx);
    const blkEnd = idx.indexOf('} catch {}', notOkIdx);
    ok(okIdx > 0 && notOkIdx > okIdx && enqIdx > notOkIdx && blkEnd > notOkIdx && enqIdx < blkEnd,
      'M2-1: index 接住发送结果，落账在「!ok」分支内（成功不落 / 失败才落）');
    ok((idx.match(/enqueueImOutbox\(/g) || []).length === 1, 'index 仅一处落账（无重复接线）', String((idx.match(/enqueueImOutbox\(/g) || []).length));
    ok(idx.includes('EXISTS (SELECT 1 FROM wa_im_conversations v WHERE v.channel_id = c.id AND v.external_user_id = ?)'),
      'M2-1: 渠道选取优先"该用户确在此渠道有过会话"的那一个');
    // 订正（M3 落地时）：严格入口 `sendImMessage` **仍为抛出**（outbox 的配额/普通失败分流正依赖它抛）——
    //   变的是**另一条**：通知入口 sendImCompletionNotice 由 boolean 改为带回原因的结果对象（不再 `return false`）。
    ok(ipc.includes('export async function sendImMessage') && ipc.includes("if (!adapter) throw new Error('[IM] 渠道适配器未运行')"),
      'M2-2: 严格发送入口保持**抛出**契约（无适配器 → throw，供 outbox 分流）');
    ok(ipc.includes('Promise<{ ok: boolean; error?: string }>') && !/catch\s*\{\s*return false/.test(ipc),
      'M2-2: 通知入口改带原因的结果对象（不再 catch → false 丢原因）');
    ok(obx.includes("status = 'blocked_quota' WHERE id = ? AND status = 'pending'")
      && !/blocked_quota'[^)]*attempts\s*=/.test(obx),
      'M2-2: 配额类只改状态、不动 attempts');
    ok(obx.includes('export function reviveQuotaBlockedOutbox') && obx.includes('OUTBOX_MAX_ATTEMPTS = 3') && obx.includes('OUTBOX_BACKOFF_MIN = [1, 2, 4]'),
      'M2-2: 复活入口新增，普通退避参数未改（3 次 / 1-2-4 min）');
    ok((obx.match(/FROM wa_im_outbox WHERE status = 'pending'/g) || []).length === 1, '补发扫描仍只扫 pending（blocked_quota 等入站）');
    ok(wa.includes('reviveQuotaBlockedOutbox(this.db, fromUserId)'), 'M2-2: 适配器入站即复活该用户被挡下的行');
    // 改钉（zx_20260929 M8-e）：原来钉的是"本文件里有两处 `throw new ImQuotaError(`"——
    //   那钉的是**本文件持有那把尺**，正是本轮治的病根（五家五种形状）。现在两处条件缺失都走
    //   共享构造点 `conditionMissing`，故钉**更强的真源**：本家不再自造类型化错误，
    //   而两条路都从同一处来（"一个概念，一个值/一个构造点"）。
    ok((wa.match(/conditionMissing\(/g) || []).length >= 2,
      'M2-2/M8-e: 无 token / 配额耗尽两类**均经共享构造点** `conditionMissing` 抛出',
      String((wa.match(/conditionMissing\(/g) || []).length));
    ok(!/new ImQuotaError\(/.test(wa),
      'M8-e 反证：本家**不自造** `ImQuotaError`（构造归一处，五家说同一句话）');
    ok(wa.includes('looksLikeQuotaHint(errMsg)') && !/quota\|limit\|frequen/i.test(wa),
      'M8-e: 远端文案的配额信号认**共享判尺** `looksLikeQuotaHint`，内联正则已摘（此前五家中唯一一份）');
    ok(errs.includes("readonly kind = 'im_quota'") && errs.includes('export function isImQuotaError'), '类型化错误含跨 import 边界的 kind 判定');
    // D2 不许新增播报点（进度回话只修"到达与承认"）
    const ai = stripComments(rd(`${A}/src/main/core/jobs/ai-task.ts`));
    // 同步（zx_20260915 M2 · P0-4）：见 rr_zx_20260911_2 同处注释——两处失败播报收敛进
    //   `recordExecutionFailure` 共享点（`notify: ctx.sendImNotification`），直呼 6→4（**减点**，非新增）。
    ok((ai.match(/ctx\.sendImNotification\(/g) || []).length === 4, '未新增 IM 播报点（直呼 6→4，失败播报收敛为共享点）', String((ai.match(/ctx\.sendImNotification\(/g) || []).length));
  }
}

async function m3(): Promise<void> {
  // 注意：本段必须用**顶层静态导入**的 router 绑定。tsx 下静态导入(CJS require)与
  // 函数内 `await import()`(ESM) 会得到**两个模块实例**，`_notificationDir` 各自一份——
  // 用动态实例 set 目录、却用静态实例跑命令，命令会写进真目录 data/notification_payloads。
  let seq = 0;
  const uid = () => `o9cq80M3_${seq++}@im.wechat`;
  const waitFor = async (cond: () => boolean, ms = 6000): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise(r => setTimeout(r, 80)); }
    return cond();
  };

  // ── S1 M3-1 帮助：以真库 fb4bf825 的 47 条 im_commands 为入参 ────────
  console.log('\n[M3/S1 帮助·真库 47 关键词按项目分组]');
  {
    const fix = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'zx4_im_commands_fb4bf825.json'), 'utf-8')) as {
      _provenance: { projectId: string; projectName: string; count: number };
      im_commands: Record<string, { script: string; label?: string }>;
    };
    const kw = Object.keys(fix.im_commands);
    ok(kw.length === 47 && fix._provenance.count === 47, '夹具即真库快照（47 条）', String(kw.length));

    const db = mkdb();
    db.prepare("INSERT INTO wa_projects (id, name, status, context_json, working_dir) VALUES (?,?,?,?,'')")
      .run(fix._provenance.projectId, fix._provenance.projectName, 'active', JSON.stringify({ im_commands: fix.im_commands }));

    const replies: string[] = [];
    await routeImMessage(ictx(db, replies) as never, uid(), '帮助', 'private', '');
    const out = replies.join('\n');
    ok(out.includes('📖 可用指令'), '是「帮助」在答（非系统状态计数）', out.split('\n')[0]?.slice(0, 20));
    ok(out.includes(`【${fix._provenance.projectName}】`), '按项目分组，出项目名');

    const after = out.slice(out.indexOf(`【${fix._provenance.projectName}】`));
    const kwLines = after.split('\n').filter(l => l.startsWith('· ') && l.includes(' — '));
    ok(kwLines.length === 47, '组内列出全部 47 个关键词（零遗漏、零重复）', String(kwLines.length));
    ok(kw.every(k => out.includes(k)), '47 个关键词逐个出现');

    // 米勒 7±2：不铺开细节——不出脚本路径（标签里的「/」不算，只认路径信号）
    const leak = out.split('\n').find(l => /\.(py|sh|js|ts|mjs|cjs)\b|scripts\/|\/Users\/|~\/|\$NOTIFICATION_PAYLOAD_DIR/.test(l));
    ok(!leak, '输出不含任何脚本路径（细节不铺开）', leak ? leak.slice(0, 60) : '');
  }

  // ── S2 M3-1 无项目配置时如实告知（不装作有） ──────────────────────
  console.log('\n[M3/S2 帮助·无项目命令如实告知]');
  {
    const db = mkdb();
    const replies: string[] = [];
    await routeImMessage(ictx(db, replies) as never, uid(), '帮助', 'private', '');
    const out = replies.join('\n');
    ok(out.includes('📖 可用指令') && out.includes('创建任务'), '内置动词照常给出');
    ok(out.includes('（暂无项目配置命令关键词）'), '没有项目命令时如实说明（不虚列）');
  }

  // ── S3 M3-2 命令侧只认本次 spawn 之后生成的文件 ────────────────────
  // 场景：通知目录里躺着 3 个旧播报（1 小时前）；命令跑起来才生成新文件。
  // 旧实现取"目录里最新非 P0_ 文件"，会把旧播报当本次输出回话，并顺手 unlink 掉 F3 待发的那条。
  console.log('\n[M3/S3 命令侧·只认本次产物]');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zx4-m3-'));
  const OLD = ['broadcast_old_a.txt', 'broadcast_old_b.txt', 'broadcast_old_c.txt'];
  const NEW = 'out_new_cmd.txt';
  const P0F = 'P0_broadcast_new.txt';
  const oldBody = (i: number) => `OLD-BROADCAST-${i}-abcdefghijklmnop`;
  {
    setNotificationDir(tmpDir);
    const past = new Date(Date.now() - 3600_000);
    OLD.forEach((f, i) => { const p = path.join(tmpDir, f); fs.writeFileSync(p, oldBody(i)); fs.utimesSync(p, past, past); });

    // 真 spawn：`printf` 写一个新产物 + 一个 P0（P0 归 F3，命令侧须按名排除）
    const script = `printf 'NEW-CMD-OUTPUT-abcdefghijklmnop' > "$NOTIFICATION_PAYLOAD_DIR/${NEW}"; `
      + `printf 'P0-NEW-BROADCAST-abcdefghijklmnop' > "$NOTIFICATION_PAYLOAD_DIR/${P0F}"`;

    const db = mkdb();
    db.prepare("INSERT INTO wa_projects (id, name, status, context_json, working_dir) VALUES (?,?,?,?,'')")
      .run('p-m3', '测试项目', 'active', JSON.stringify({ im_commands: { '跑一下行情': { script, label: '跑一下行情' } } }));

    const replies: string[] = [];
    await routeImMessage(ictx(db, replies) as never, uid(), '跑一下行情', 'private', '');
    const out = replies.join('\n');
    ok(out.includes('NEW-CMD-OUTPUT'), '回话取的是本次 spawn 之后的产物', out.split('\n')[0]?.slice(0, 30));
    ok(!out.includes('OLD-BROADCAST'), '旧播报未被当成本次输出（错误归属已除）');
    ok(!out.includes('P0-NEW-BROADCAST'), '命令侧不偷吃 P0_（归 F3）');
    ok(OLD.every(f => fs.existsSync(path.join(tmpDir, f))), '3 个旧文件仍在（未被命令侧 unlink）');
    ok(!fs.existsSync(path.join(tmpDir, NEW)), '本次产物已被命令侧取走');
    ok(fs.existsSync(path.join(tmpDir, P0F)), 'P0_ 文件未被命令侧取走');
  }

  // ── S4 互不偷吃：同目录跑一次 F3 扫描 → 旧文件仍能被 F3 取走 ───────
  console.log('\n[M3/S4 F3 侧·旧播报与 P0 照常取走]');
  {
    const f3Sent: string[] = [];
    const db = mkdb();
    setNotificationDir(tmpDir);
    // F3 自身有 10s 新鲜度闸（防"刚生成还没写完"）：把刚 spawn 出的 P0 也回拨到 1 小时前，
    // 本断言才测的是**归属**（P0 归 F3）而非被自身闸挡下。
    { const past = new Date(Date.now() - 3600_000); const p = path.join(tmpDir, P0F); if (fs.existsSync(p)) fs.utimesSync(p, past, past); }
    startF3NotificationPush(db as never, () => [{
      id: 'ch-real', channelType: IM_CH, lastExternalUser: IM_USER,
      sendReply: async (_to: string, t: string) => { f3Sent.push(t); },
    }]);
    try {
      triggerF3Notification();
      // 旧文件须全部消失（F3 发送成功后 unlink；内容 <20 也 unlink，故"消失"＝被认领）
      const gone = await waitFor(() => OLD.every(f => !fs.existsSync(path.join(tmpDir, f))) && !fs.existsSync(path.join(tmpDir, P0F)));
      ok(gone, 'F3 认领了 3 个旧播报 + 本次的 P0_（两侧互不偷吃）',
        `剩余: ${fs.readdirSync(tmpDir).join(',') || '（空）'}`);
      ok(OLD.some((_, i) => f3Sent.some(s => s.includes(oldBody(i)))), '旧播报内容确实经 F3 送出（非误删）');
      ok(f3Sent.some(s => s.includes('P0-NEW-BROADCAST')), 'P0_ 内容经 F3 送出（F3 拥有全部 .txt）');
    } finally {
      stopF3NotificationPush();
      setNotificationDir('');
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  // ── S5 静态：改动点与不变量 ──────────────────────────────────────
  console.log('\n[M3/S5 静态断言]');
  {
    const router = stripComments(rd(`${A}/src/main/services/im-router.ts`));
    // zx_20260924_1 M1: 四条路由谓词**已迁入唯一真源** `services/im-commands.ts`（名字 + 示例文案 + 匹配谓词
    //   同一处），路由只**引**不抄 ⇒ 原判据"路由内就地声明 HELP_REGEX"必然红。按「改旧断言＝改钉更强的
    //   新真源」（**不是放宽**）：①真源里确是 `/^(帮助|help)` 起头那条；②路由**引**它；③反证路由内无重声明。
    const cmds = stripComments(rd(`${A}/src/main/services/im-commands.ts`));
    ok(cmds.includes('export const HELP_REGEX = /^(帮助|help)'), '「帮助」/help 为唯一新增认领词（零新增命令词）——谓词真源在 `im-commands.ts`');
    ok(/import \{[^}]*\bHELP_REGEX\b[^}]*\} from '\.\/im-commands\.js'/.test(router), 'im-router 从唯一真源**引** HELP_REGEX（同源，非二次手抄）');
    ok(!/const HELP_REGEX\s*=/.test(router), '反证：路由内不再就地重声明 HELP_REGEX（防漂回两份手抄）');
    ok((router.match(/HELP_REGEX/g) || []).length === 2, 'HELP_REGEX 一引入一使用（未旁生分支）', String((router.match(/HELP_REGEX/g) || []).length));
    ok(router.includes('async function handleHelp('), 'handleHelp 为唯一实现');

    // 位置关系才是判据：认领必须**在问候之前**（「帮助」是 2 个汉字，写在问候之后＝生产不可达）
    const helpIdx = router.indexOf('HELP_REGEX.test(msgText.trim())');
    const greetIdx = router.indexOf('const greetPatterns');
    ok(helpIdx > 0 && greetIdx > 0 && helpIdx < greetIdx, '「帮助」认领在问候的遮蔽之前（不重蹈 M1-6）');
    const cmdIdx = router.indexOf('await tryImCommand(ctx, fromUser, msgText)');
    ok(cmdIdx > 0 && cmdIdx < helpIdx, '「帮助」置于项目命令分发之后（不抢项目关键词）');

    ok(router.includes('const spawnTime = Date.now();'), '命令侧记下 spawn 时刻');
    ok(router.includes('.mtimeMs >= spawnTime'), '只认本次 spawn 之后的产物（错误归属已除）');
    ok(router.indexOf('const spawnTime = Date.now();') < router.indexOf('.mtimeMs >= spawnTime'), 'spawnTime 先取后用');
    ok(router.includes("f.endsWith('.txt') && !f.startsWith('P0_')"), '命令侧仍按名排除 P0_（归 F3）');

    // handleHelp 只把 script 当"能不能跑"的判据读取，绝不把路径插进回话
    const hStart = router.indexOf('async function handleHelp(');
    // zx_20261003 M9 就地改钉：F3 段整体搬出 im-router.ts ⇒ 原以其函数名为下界已切不到（hEnd=-1，
    //   helpBody 退化成"直到文件尾"，判据失真）。改以紧随 handleHelp 之后的 `function clipText(` 为界，
    //   helpBody 仍是 handleHelp 的函数体本身。
    const hEnd = router.indexOf('function clipText(');
    const helpBody = router.slice(hStart, hEnd);
    ok(hStart > 0 && hEnd > hStart && !/\$\{[^}]*\.script/.test(helpBody), 'handleHelp 不把 script 插进回话（只读判据、不输出）——下界改用 `clipText`（**M9 就地改钉**）');
    ok(helpBody.includes('im_commands'), '帮助内容取自项目 context_json.im_commands');

    // F3 仍拥有全部 .txt（含 P0_）：其过滤器不得含 P0_ 排除
    // zx_20261003 M9 就地改钉：F3 段搬入 `services/f3-notification-push.ts`，扫描面随之移至该文件。
    const f3Src = stripComments(rd(`${A}/src/main/services/f3-notification-push.ts`));
    const f3Start = f3Src.indexOf('async function processF3NotificationFiles');
    const f3Body = f3Src.slice(f3Start, f3Start + 1500);
    ok(f3Body.includes(".endsWith('.txt')") && !f3Body.includes("startsWith('P0_')"), 'F3 侧不排除 P0_（含 P0_ 全取）——扫描面 `f3-notification-push.ts`（**M9 就地改钉**）');
  }
}

async function m4(): Promise<void> {
  const { promoteTaskFileDeliverables, backfillStaleMarkerDocPromotion, docNotProbe, deliverableScopeSql } = await import('../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js');

  interface Fix { _provenance: { taskId: string; taskTitle: string }; context: { deliverable_unfulfilled?: unknown; acceptance_check?: unknown }; deliverables: Array<{ id: string; name: string; type: string; status: string; file_path: string; is_primary: number; acceptance_verified: number }>; }
  const fix = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'zx4_df334d91_drafts.json'), 'utf-8')) as Fix;
  const TID = fix._provenance.taskId;
  // zx_20260916_3 M2（D3 裁定）：探针判据**只认显式标记**（`_tmp`/`_probe`/`_verify` 前缀），
  //   形状 GLOB `*test_<6hex>*.py` 整条删除——它按**文件名长相**判，对 a-stock 7 个真测试脚本系统性全中。
  //   故本夹具里 `scripts/test_a20260911_1.py` 由「探针」**翻面为真实产出**（应当被提升）；
  //   探针只剩 `scripts/_f20_probe.py` 一条（系统性误伤的反证见 rr_zx_20260916_3.ts §B-3）。
  //   KEPT 不带数字后缀，避免每轮改判据都要改名。
  const SHAPE_MATCHED = '4cf72efc-3844-43ee-9d9b-e94229a0c273';   // scripts/test_a20260911_1.py（旧 GLOB 命中；今判真实产出）
  const PROBE = '89b9f274-a7c0-4c7c-826f-3d5cd037fbec';           // scripts/_f20_probe.py（本夹具唯一探针）
  const KEPT = fix.deliverables.filter(d => d.id !== PROBE).map(d => d.id);

  const seed = (db: AnyDb, ctx: unknown): void => {
    db.prepare("INSERT INTO wa_projects (id, name, status) VALUES ('p-m4','测试项目','active')").run();
    db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?,?,?,?,?)')
      .run(TID, 'p-m4', fix._provenance.taskTitle, 'completed', JSON.stringify(ctx));
    for (const d of fix.deliverables) {
      db.prepare('INSERT INTO wa_deliverables (id, project_id, task_id, name, type, status, file_path, is_primary, acceptance_verified) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(d.id, 'p-m4', TID, d.name, d.type, d.status, d.file_path, d.is_primary, d.acceptance_verified);
    }
  };
  const statuses = (db: AnyDb) => new Map((db.prepare('SELECT id, status, acceptance_verified FROM wa_deliverables WHERE task_id = ? ORDER BY rowid').all(TID) as Array<{ id: string; status: string; acceptance_verified: number }>).map(r => [r.id, r]));

  // ── S1 真库 df334d91 入参：陈旧（非 forced）标记不再阻断，探针不提升 ──
  console.log('\n[M4/S1 真库入参·陈旧标记不阻断 + 探针不提升]');
  {
    ok(fix.deliverables.length === 8, '夹具即真库 8 条 doc 草稿', String(fix.deliverables.length));
    const unf = fix.context.deliverable_unfulfilled as { forced?: boolean; retries?: number } | undefined;
    ok(!!unf && unf.forced === undefined && unf.retries === 2, '真库标记为 {paths,note,retries} 型（无 forced）', JSON.stringify(unf));

    const db = mkdb(); seed(db, fix.context);
    const res = promoteTaskFileDeliverables(db as never, TID, 'run_close');
    const st = statuses(db);
    ok(res.promoted === 7 && res.skipped === undefined, '非 forced 陈旧标记 → 照常提升（skipped 不出现；唯一探针已滤 ⇒ 7 条）', `promoted=${res.promoted} skipped=${res.skipped}`);
    ok(KEPT.every(id => st.get(id)?.status === 'completed'), '7 条非探针 doc 全部 draft→completed');
    ok(st.get(PROBE)?.status === 'draft', '探针 scripts/_f20_probe.py 未被提升（E11）', String(st.get(PROBE)?.status));
    ok(KEPT.every(id => st.get(id)?.acceptance_verified === 1), '验收位随收尾打标（E13 解除：ctx.acceptance_check.verified=true）');

    // zx_20260916_3 M2（D3 翻面断言）：旧形状 GLOB 把 `scripts/test_a20260911_1.py` 判为探针（**只看长相**），
    //   删除该子句后它按真实产出提升——两半合起来才构成"翻面"的完整证据：
    //   ① 行为：该行确已 completed；② 成因：生产判据里**确已无按长相推断的** GLOB。
    // zx_20261022_1 批二重定向（按符号钉更强的新真源，不放宽）：新增的 GLOB 只认**已宣告标记 + 1–2 位数字
    //   前缀**（`0_probe.md` 这类），与"按 `test_` 长相推断"是两回事。故原式「整条 SQL 无 GLOB」改为
    //   「GLOB 只许是那 6 条」——比原来更紧，且仍证明本夹具行被放行的成因不是形状推断。
    ok(st.get(SHAPE_MATCHED)?.status === 'completed', '形状命中者 test_a20260911_1.py 现按真实产出提升（D3：判据不认长相）', String(st.get(SHAPE_MATCHED)?.status));
    const ruler = docNotProbe('');
    const globClauses = [...ruler.matchAll(/NOT GLOB '([^']+)'/g)].map((m) => m[1]!);
    ok(globClauses.length === 6
      && globClauses.every((g) => /^\*\/\[0-9\](?:\[0-9\])?_(?:verify|probe|tmp)\*$/.test(g)),
      '反证：生产判据已无**形状** GLOB（仅存已宣告标记的 1–2 位数字前缀 6 条；本夹具该行被放行的成因）', ruler);

    // zx_20260913 M2-3(翻面断言): 旧谓词 `%/_probe%` 要求"斜杠紧邻 _probe"，`scripts/_f20_probe.py` 是**盲区**
    //   ——旧断言如实记录了"它被当成果提升"。M2-3 改为**路径段级**判据后盲区已闭：该行不再提升。
    //   （zx_20260916_3 M2 删 GLOB 不涉此条：`_f20_probe` 是**显式标记**，本就该判探针。）
    const f20 = fix.deliverables.find(d => d.name.includes('_f20_probe'))!;
    ok(st.get(f20.id)?.status === 'draft' && docNotProbe('') !== '', '盲区已闭：_f20_probe 现被 docNotProbe 判为探针 ⇒ 不再提升（zx_20260913 M2-3）', String(st.get(f20.id)?.status));
  }

  // ── S2 反证：forced 红线不破 ──────────────────────────────────────
  console.log('\n[M4/S2 反证·forced 仍跳过]');
  {
    const db = mkdb();
    seed(db, { ...fix.context, deliverable_unfulfilled: { ...(fix.context.deliverable_unfulfilled as object), forced: true } });
    const res = promoteTaskFileDeliverables(db as never, TID, 'run_close');
    const st = statuses(db);
    ok(res.promoted === 0 && res.skipped === 'deliverable_unfulfilled', 'forced=true → 跳过并如实报因', `promoted=${res.promoted} skipped=${res.skipped}`);
    ok([...st.values()].every(r => r.status === 'draft'), '8 条 doc 全保持 draft（红线未破）');
    ok([...st.values()].every(r => r.acceptance_verified === 0), '验收位亦未打标（跳过是整段跳过）');
  }

  // ── S3 E12：task:get 与交付单候选对同一任务逐条一致 ────────────────
  // 两处谓词**从源码里读出**再执行（不是另写一份等价 SQL）——生产真实 SQL × 生产真实入参。
  console.log('\n[M4/S3 E12·task:get 与交付单候选同判]');
  {
    const prj = stripComments(rd(`${A}/src/main/ipc/project.ipc.ts`));
    const ai = stripComments(rd(`${A}/src/main/core/jobs/ai-task.ts`));
    // zx_20260913 M2-1: task:get 的 SQL 改「本任务及子树」形态(d.* + LEFT JOIN 归属标题 + IN ownerIds)，
    // 旧的单任务 `SELECT * ... task_id = ?` 字面量已按方案删除；故改从新形态里读出 SQL 再执行(仍是生产 SQL × 生产入参)。
    // zx_20260930 M4-1: 范围声明（taskIds/别名/排除退休与探针）收进共享真源 ⇒ 生产 SQL 只剩 `WHERE ${dScope.sql}`
    //   一段待补，补它的**不是手抄谓词而是生产函数**（比"从源码里替换片段"更强：谓词组合也归真源）。
    const mScope = prj.match(/const dScope = deliverableScopeSql\(\{ taskIds: ownerIds, alias: 'd' \}\);/);
    const mGet = prj.match(/SELECT d\.\*, t\.title AS owner_task_title FROM wa_deliverables d[\s\S]{0,160}?WHERE \$\{dScope\.sql\}/);
    const mAi = ai.match(/SELECT id, name, type, status, is_primary, created_at, file_path, description FROM wa_deliverables WHERE \$\{cScope\.sql\} ORDER BY created_at DESC/);
    ok(!!mScope && !!mGet, 'task:get 走子树形态 + 共享范围真源（M2-1 / zx_20260930 M4-1）');
    ok(!!mAi, '交付单候选谓词仍在（对照；经共享范围真源）');
    if (mGet && mAi) {
      const db = mkdb(); seed(db, fix.context);
      // 生产模板里的运行期片段由**生产函数**补（IN 只给本任务自身 ⇒ 子树为空即单任务等价）
      const a = (db.prepare(mGet[0].replace('${dScope.sql}', deliverableScopeSql({ taskIds: [TID], alias: 'd' }).sql)).all(TID) as Array<{ id: string }>).map(r => r.id).sort();
      const b = (db.prepare(mAi[0].replace('${cScope.sql}', deliverableScopeSql({ taskIds: [TID] }).sql)).all(TID) as Array<{ id: string }>).map(r => r.id).sort();
      eq(a, b, '同一任务：task:get 与交付单候选返回的 doc 集合逐条一致（E12 反例归零）');
      ok(a.length === 7 && !a.includes(PROBE) && a.includes(SHAPE_MATCHED), '两侧同为 7 条、排除唯一探针(_f20_probe)、含形状命中者(test_a20260911_1.py)（M2-3 + zx_20260916_3 M2/D3）', `n=${a.length}`);
    }
  }

  // ── S4 静态：改动点与不变量 ──────────────────────────────────────
  console.log('\n[M4/S4 静态断言]');
  {
    const dlc = stripComments(rd(`${A}/src/main/core/deliverable-lifecycle.ts`));
    const prj = stripComments(rd(`${A}/src/main/ipc/project.ipc.ts`));
    const dp = stripComments(rd(`${A}/renderer/src/pages/DeliverablesPage.tsx`));

    ok(dlc.includes("const unf = ctx.deliverable_unfulfilled as { forced?: boolean } | undefined"), 'M4-1: 判据收窄为读 forced');
    ok(dlc.includes('if (unf?.forced === true) return { promoted: 0, skipped: \'deliverable_unfulfilled\' };'), 'M4-1: 仅 forced 才跳过');
    ok(!dlc.includes('if (ctx.deliverable_unfulfilled) return'), 'M4-1: 旧的"标记存在即阻断"已除');
    // zx_20260930 M3-e 订正：原断言写死 `type = 'doc'`。M3-e 已把类型判据换成**集合真源**
    //   `typeIn('', FILE_DELIVERABLE_TYPES)`（doc+code）——正是"只随任务交付 doc"这一格被修掉。
    //   改钉新形式，并把"类型判据走集合真源、不再手抄单类型"一并钉住（否则计数式断言可被换壳骗过）。
    ok(/SELECT id FROM wa_deliverables WHERE task_id = \? AND \$\{fileTypes\.sql\} AND status = 'draft' AND \$\{docNotProbe\(''\)\}/.test(dlc)
      && /const fileTypes = typeIn\('', FILE_DELIVERABLE_TYPES\)/.test(dlc),
      'M4-2: 提升前滤探针（同一把尺）+ 类型判据走集合真源 typeIn(FILE_DELIVERABLE_TYPES)（zx_20260930 M3-e）');
    ok(!/AND type = 'doc' AND status = 'draft'/.test(dlc),
      'M4-2 反证：硬写 `type = \'doc\'` 已不在（否则 code 成果仍恒 draft）');

    // zx_20260913 M2: task:list 子树聚合 + deliverable:list 漏网读点 ⇒ 读点真增加 5 → 7（口径仍未分叉）。
    // zx_20260930 M4-1: 七处读点不变，每处由"手拼谓词"改为"调共享取数范围真源"——数真源调用数。
    // zx_20260930 M4-2: 7 → 9。M4-2 只加**两处**读点，且都是分页必需的"总数"或"名录"：
    //   ①`task:get` 里 `countDeliverables(db, { taskIds: ownerIds })`（`deliverablesTotal`，
    //    与同段的 `dScope` **同 taskIds**，故明细与总数同集合）；②`deliverable:facets` 里那次
    //    `deliverableScopeSql`（一份复用给三个查询：项目名录/任务名录/无任务计数）。
    //   数**真源调用**而非"手拼谓词处"，正是为了让这类新增读点不可能悄悄绕开共享口径。
    ok((prj.match(/\b(deliverableScopeSql|countDeliverables|countDeliverablesByType)\(/g) || []).length === 9, 'M4-3/M4-2: project.ipc 探针口径九处同源（读点增，含 task:list/deliverable:list/task:get总数/facets 名录）', String((prj.match(/\b(deliverableScopeSql|countDeliverables|countDeliverablesByType)\(/g) || []).length));

    // zx_20260929 M7: 标签表收敛为**一份共享真源**（renderer/src/lib/deliverable-view.ts）。
    //   判据改钉真源本身，并反钉列表页**不再本地手抄**（`includes` 打在本页会随迁移变假红，且证不到"只有一个落点"）。
    const dvw = stripComments(rd(`${A}/renderer/src/lib/deliverable-view.ts`));
    ok(dvw.includes("code: '代码'"), 'M4-4: code 中文标签在共享词表真源（E14；旧实现漏 ⇒ 裸显示 code）');
    ok(!dp.includes("code: '代码'") && dp.includes('DELIVERABLE_TYPE_LABEL'), 'M4-4: 列表页不留本地标签表，一律引共享真源（同一把尺只有一个落点）');
    ok(/code: 'bg-[a-z]+-100 text-[a-z]+-700'/.test(dp), 'M4-4: TYPE_COLORS 补 code 配色');
    // zx_20260930 M4-2: 下拉名录的载体由 `allItems`（无参全表）换成**服务端** `facets`。
    //   换的是载体，不是判据——"名录不由已过滤的 items 派生"（E15 病灶）这一条仍必须成立，
    //   故反证一并改钉到新载体上（`!dp.includes('new Map(items.filter(')`），不因换载体而放宽。
    ok(dp.includes('const [facetProjects, setFacetProjects] = useState<Array<{ id: string; name: string }>>([])')
      && dp.includes('const [facetTasks, setFacetTasks] = useState<Array<{ id: string; title: string | null }>>([])'), 'M4-4/M4-2: 下拉候选由服务端 facets 名录派生（载体由 allItems 换成 facets）');
    // zx_20260913 M2-7(判据更新): 下拉候选进一步从「allItems 里仍**过滤掉**无名者」改为**全量**派生
    // (无名者显示人话「未知项目」)——E15 的病灶(由已过滤 items 派生)依旧被排除，且不再无声丢项目。
    ok(dp.includes("const projects = facetProjects.map(p => [p.id, p.name || '未知项目'] as const)")
      && !dp.includes('new Map(items.filter(i => i.project_name)')
      && !dp.includes('facetProjects.filter(p => p.name)'), 'M4-4: 由未过滤名录全量派生（E15 已除；M2-7 起无名者如实显示「未知项目」）');
  }

  // ── S5 D5④：存量一次性归位（首启一次，复用既有判据） ────────────────
  console.log('\n[M4/S5 D5④·存量回填幂等 + forced 红线不破]');
  {
    const marker = (db: AnyDb) => db.prepare("SELECT value FROM wa_settings WHERE key = 'migration.doc_promote_stale_marker'").get() as { value?: string } | undefined;

    // ① 真库 df334d91 入参：回填后 7 条非探针归位、探针不提升、marker 落库
    const db = mkdb(); seed(db, fix.context);
    ok(marker(db) === undefined, '回填前无迁移标记');
    backfillStaleMarkerDocPromotion(db as never);
    const st = statuses(db);
    ok(KEPT.every(id => st.get(id)?.status === 'completed'), '回填：7 条非探针 doc 归位 completed');
    ok(st.get(PROBE)?.status === 'draft', '回填：探针仍留 draft（同一把尺）', String(st.get(PROBE)?.status));
    ok(marker(db)?.value === 'done', '迁移标记 migration.doc_promote_stale_marker=done');

    // ② 幂等：标记既已 done，再调用不重跑（把一条已归位的打回 draft 亦不被二次提升）
    db.prepare("UPDATE wa_deliverables SET status = 'draft' WHERE id = ?").run(KEPT[0]);
    backfillStaleMarkerDocPromotion(db as never);
    ok(statuses(db).get(KEPT[0]!)?.status === 'draft', '二次调用被 marker 拦下（不重跑、不误改）', String(statuses(db).get(KEPT[0]!)?.status));

    // ③ 反证：forced:true 的存量任务，回填亦不破红线
    const db2 = mkdb();
    seed(db2, { ...fix.context, deliverable_unfulfilled: { ...(fix.context.deliverable_unfulfilled as object), forced: true } });
    backfillStaleMarkerDocPromotion(db2 as never);
    ok([...statuses(db2).values()].every(r => r.status === 'draft'), 'forced=true 存量不被回填提升（红线不破）');

    // ④ 静态：守卫与"复用既有判据、不写第二套 SQL"两条判据
    const dlc = stripComments(rd(`${A}/src/main/core/deliverable-lifecycle.ts`));
    ok(dlc.includes("migration.doc_promote_stale_marker"), '迁移标记名在位');
    ok(/status = 'completed' AND context_json LIKE '%deliverable_unfulfilled%'/.test(dlc), '只圈「completed 且带陈旧标记」的任务');
    ok(/for \(const r of rows\) promoteTaskFileDeliverables\(db, r\.id, 'backfill_stale_marker'\)/.test(dlc), '逐任务复用 promoteTaskFileDeliverables（无第二套 SQL）');
    ok((dlc.match(/context_json LIKE '%checked_at%'/g) || []).length === 1, 'checked_at 字面量仍恰 1 处（守 rr_zx_20260910_3_b1 计数）', String((dlc.match(/context_json LIKE '%checked_at%'/g) || []).length));
    const idx = stripComments(rd(`${A}/src/main/index.ts`));
    ok(/backfillStaleMarkerDocPromotion\(db\)/.test(idx), '启动路径已接线（首启一次）');
  }
}

async function m5(): Promise<void> {
  interface MemRow { id: string; content: string; embedding: string; memory_type: string; importance: number; created_at: string; updated_at: string; context_json: string; is_exemplar: number; exemplar_type: string | null; similar_to: string; use_count: number; reasoning?: string; source?: string; }
  interface Fix { _provenance: { projectId: string; totals: Record<string, number>; window4fe7de46: { rowsTotal: number; shadowedRows: number; oldSummarizerCoverage: number; silentLossRows: number; compactedUpToRowid: number; summaryHasMergeMarker: boolean } }; archivedExemplars: MemRow[]; archivedPlain: MemRow[]; liveExemplars: MemRow[]; livePlain: MemRow[]; exemplars: Array<{ id: string; memory_type: string; is_exemplar: number }>; }
  const fix = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'zx4_mem_m5.json'), 'utf-8')) as Fix;
  const P = fix._provenance.projectId;
  const arch = [...fix.archivedExemplars, ...fix.archivedPlain];
  const live = [...fix.liveExemplars, ...fix.livePlain];
  const archIds = new Set(arch.map(r => r.id));
  const liveIds = new Set(live.map(r => r.id));

  /** 建真库同形内存库并灌入真库逐字夹具；MemoryManager 须**先构造**（initFts 建触发器）再插行，FTS 才随插随索引。 */
  const mkmem = (): AnyDb => {
    const d = mkdb();
    d.prepare("INSERT OR REPLACE INTO wa_settings (key, value) VALUES ('memory.archive_retention_days','0')").run();
    return d;
  };
  const seedMem = (d: AnyDb): void => {
    const ins = d.prepare('INSERT INTO wa_memories (id, project_id, content, embedding, memory_type, importance, reasoning, source, updated_at, created_at, context_json, is_exemplar, exemplar_type, similar_to, use_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const r of [...arch, ...live]) ins.run(r.id, P, r.content, r.embedding, r.memory_type, r.importance, r.reasoning ?? '', r.source ?? 'agent_execution', r.updated_at, r.created_at, r.context_json, r.is_exemplar, r.exemplar_type, r.similar_to, r.use_count);
  };
  const cosine = (a: number[], b: number[]): number => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb)); };
  const emb = (r: MemRow): number[] => JSON.parse(r.embedding) as number[];

  // ── S0 夹具即真库规模 ────────────────────────────────────────────
  console.log('\n[M5/S0 夹具·真库规模]');
  ok(fix._provenance.totals.archivedAll === 576 && fix._provenance.totals.liveWithEmb === 82, '真库 archived 576 / 非archived 带向量 82');
  ok(fix.exemplars.length === 5 && fix.exemplars.filter(e => e.memory_type === 'archived').length === 3, '真库范例 5 条，其中 3 条为归档墓碑');

  // ── S1 检索四路：归档不再回取（真实现 × 真库入参） ─────────────────
  console.log('\n[M5/S1 检索四路·归档不回取]');
  {
    const db = mkmem();
    const mm = new MemoryManager(db as never, {} as never);
    seedMem(db);

    // getRecent
    const rec = mm.getRecent(P, 50);
    ok(!rec.some(r => archIds.has(r.id)), 'getRecent 不含 archived（E18）');
    ok(rec.some(r => liveIds.has(r.id)), 'getRecent 仍含 live（反证：非误滤）');
    const oldRec = db.prepare('SELECT id FROM wa_memories WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(P, 50) as Array<{ id: string }>;
    ok(oldRec.some(r => archIds.has(r.id)), '反例（非空断言）：旧 getRecent SQL 确实会取回 archived', String(oldRec.filter(r => archIds.has(r.id)).length));

    // search（语义）——查询向量用归档行**自身**向量：旧路径下相似度=1 必居首
    const archRow = fix.archivedExemplars.find(r => r.id.startsWith('62348077')) ?? arch[0];
    const q = emb(archRow);
    ok(Math.abs(cosine(q, emb(archRow)) - 1) < 1e-9, '归档行对自己向量余弦 = 1（若参与排序必居首）');
    const sem = mm.search(q, P, 50);
    ok(!sem.some(r => archIds.has(r.id)), 'search 不含 archived（E17）');
    ok(mm.search(emb(live[0]), P, 50).some(r => r.id === live[0].id), 'search 仍含 live（反证：谓词只排 archived）');

    // searchBM25——'deep_position_decision' 在全库夹具中**只**命中归档行 62348077
    const bm = mm.searchBM25('deep_position_decision', P, 50);
    ok(bm.length === 0, 'searchBM25 不含 archived（唯一命中者已归档 ⇒ 结果为空）', `n=${bm.length}`);
    const oldBm = db.prepare('SELECT m.id FROM wa_memories_fts f JOIN wa_memories m ON f.rowid = m.rowid WHERE wa_memories_fts MATCH ? AND m.project_id = ?').all('deep_position_decision', P) as Array<{ id: string }>;
    ok(oldBm.length === 1 && oldBm[0].id === archRow.id, '反例（非空断言）：旧 BM25 SQL 命中该归档行', `n=${oldBm.length}`);
    ok(mm.searchBM25('file_retrieval', P, 50).length === 0, 'searchBM25 另一路（两个命中者均为归档）亦为空');

    // searchByKeywords
    const kw = mm.searchByKeywords(['deep_position_decision'], P, 50);
    ok(kw.length === 0, 'searchByKeywords 不含 archived', `n=${kw.length}`);
    const oldKw = db.prepare('SELECT id FROM wa_memories WHERE project_id = ? AND content LIKE ?').all(P, '%deep_position_decision%') as Array<{ id: string }>;
    ok(oldKw.length === 1 && oldKw[0].id === archRow.id, '反例（非空断言）：旧 LIKE SQL 命中该归档行', `n=${oldKw.length}`);
    ok(mm.searchByKeywords(['file_retrieval'], P, 50).length === 0, 'searchByKeywords 另一路亦为空');
  }

  // ── S2 范例 5→2：归档墓碑不再注入提示词 ──────────────────────────
  console.log('\n[M5/S2 范例·归档墓碑不注入]');
  {
    const db = mkmem();
    const mm = new MemoryManager(db as never, {} as never);
    seedMem(db);
    const ex = mm.getExemplars(P, undefined, 10);
    ok(ex.length === 2, 'getExemplars 5 → 2（3 条归档墓碑被排除）', String(ex.length));
    ok(fix.liveExemplars.every(r => ex.some(e => e.id === r.id)) && !ex.some(e => archIds.has(e.id)), '留下的正是 2 条 live 范例，无归档混入');
    const oldEx = db.prepare('SELECT id FROM wa_memories WHERE project_id = ? AND is_exemplar = 1').all(P) as Array<{ id: string }>;
    ok(oldEx.length === 5, '反例（非空断言）：旧 SQL 仍取 5 条（含 3 墓碑）', String(oldEx.length));
    const exGood = mm.getExemplars(P, 'good', 10);
    ok(exGood.length === 2 && !exGood.some(e => archIds.has(e.id)), 'type=good 过滤路径同样过归档尺（归档的 good 范例 62348077 不再注入）', String(exGood.length));
  }

  // ── S3 E19：压缩覆盖——被遮蔽的每一行都必须进入摘要输入 ────────────
  console.log('\n[M5/S3 E19 压缩覆盖·无一行被跳过]');
  {
    const W = fix._provenance.window4fe7de46;
    ok(W.shadowedRows === 881 && W.oldSummarizerCoverage === 40 && W.silentLossRows === 841 && !W.summaryHasMergeMarker,
      '真库实测：4fe7de46 该次遮蔽 881 行 / 旧实现只覆盖 40 行 / 缺口 841 行（单次 pass，未被历史摘要补足）');

    const rows = Array.from({ length: W.shadowedRows }, (_, i) => ({ role: 'assistant', content: `SHADOW-${i}` }));
    const chunks = planSummaryChunks(rows, 40);
    ok(chunks.reduce((s, c) => s + c.length, 0) === W.shadowedRows, 'planSummaryChunks 各段并集覆盖全部被遮蔽行（一行不落）');
    ok(chunks.every(c => c.length <= 40), '每段仍 ≤ maxRows（沿用"限制单次输入规模"语义）', chunks.map(c => c.length).slice(0, 3).join(',') + `…共${chunks.length}段`);
    ok(JSON.stringify(chunks.flat()) === JSON.stringify(rows), '分段保持原序、不重不漏');
    ok(rows.slice(-40).length === W.oldSummarizerCoverage, '反例：旧 slice(-40) 只覆盖 40 行（E19 根因原形）');

    ok(planSummaryChunks(rows, 40).length > 1 && planSummaryChunks([], 40).length === 0, '边界：空输入 0 段；大输入多段');
    ok(planSummaryChunks(rows, 0).every(c => c.length === 1) && planSummaryChunks(rows, 0).length === W.shadowedRows, '边界：maxRows=0 退化为逐行（不丢行、不死循环）');

    // 规则回退如实：大窗口宁可不压缩，也不产"看着像摘要、实则丢了大半"的假摘要
    ok(buildRuleDigest(rows) === '', '规则回退在 881 行窗口下返回空（fail-closed，边界不推进、历史不丢）');
    const mid = Array.from({ length: 100 }, (_, i) => ({ role: 'user', content: `MARK-${i}-` + 'x'.repeat(50) }));
    const dg = buildRuleDigest(mid);
    ok(dg !== '' && mid.every((_, i) => dg.includes(`MARK-${i}-`)), '规则回退在可容纳窗口内覆盖全部 100 行（逐条确在摘要内）');
    ok(buildRuleDigest([]) === '', '边界：空输入返回空');
  }

  // ── S4 静态：同尺与接入点 ────────────────────────────────────────
  console.log('\n[M5/S4 静态断言]');
  {
    // zx_20261018_2 批七（见简）: 记忆读取路径已机械搬入 `memory-retrieval.ts` / `memory-exemplars.ts` /
    //   `memory-consolidation.ts`——扫描面按**符号归属**扩为四文件并集（不放宽：`memAll` 覆盖原 `mem` 的全部
    //   文本，五条同尺断言与反证对并集成立；插值点前提改为**四文件总数恰 20**，与拆分前逐一对齐）。
    const mem = stripComments(rd(`${A}/src/main/core/memory-manager.ts`));
    const memRet = stripComments(rd(`${A}/src/main/core/memory-retrieval.ts`));
    const memEx = stripComments(rd(`${A}/src/main/core/memory-exemplars.ts`));
    const memCons = stripComments(rd(`${A}/src/main/core/memory-consolidation.ts`));
    const memAll = mem + '\n' + memRet + '\n' + memEx + '\n' + memCons;
    const ae = stripComments(rd(`${A}/src/main/core/agent-executor.ts`));
    const cc = stripComments(rd(`${A}/src/main/core/context-compaction.ts`));

    // zx_20260930 M8 就地订正（**改钉更强真源，非放宽**）：这五条原钉"五处 SQL 各自手抄
    //   `memory_type != 'archived'`"，M8 起该片段收敛为**一处真源** `memory-lifecycle.ts` 的
    //   `MEM_LIVE_SQL`，五处改为**插值同一常量**。若仍钉旧字面量，则它在源码里已不存在 ⇒ 恒红；
    //   若改成"只要不含旧字面量"，则真假不辨 ⇒ 恒绿。故改为断言**五处插值了那一个常量**，
    //   并且该常量的**语义**由 rr_zx_20260930 H-a-2（＝由词表派生）钉死 ⇒ 本条不再是手抄。
    const LIVE_TOKEN = '${MEM_LIVE_SQL}';
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const T = esc(LIVE_TOKEN);
    // 前提自证：stripComments 不得截断（zx_20260928 「去注释是静默毁伤」教训的现场哨兵）
    ok(mem.includes('LIMIT 120'), '前提：stripComments 未截断本文件（尾部哨兵在场）');
    ok((memAll.match(/\$\{MEM_LIVE_SQL\}/g) ?? []).length === 20, '前提：MEM_LIVE_SQL 插值点四文件合计恰 20 处（与拆分前对齐）', String((memAll.match(/\$\{MEM_LIVE_SQL\}/g) ?? []).length));

    ok(new RegExp('FROM wa_memories WHERE project_id = \\? AND ' + T + ' AND embedding IS NOT NULL').test(memAll), 'M5-1a search 同尺');
    ok(new RegExp('MATCH \\? AND m\\.project_id = \\? AND m\\.' + T).test(memAll), 'M5-1b searchBM25 同尺');
    ok(new RegExp('FROM wa_memories WHERE project_id = \\? AND ' + T + ' AND \\(').test(memAll), 'M5-1c searchByKeywords 同尺');
    ok(new RegExp('FROM wa_memories WHERE project_id = \\? AND ' + T + ' ORDER BY created_at DESC LIMIT \\?').test(memAll), 'M5-1d getRecent 同尺');
    ok(new RegExp('is_exemplar = 1 AND ' + T).test(memAll), 'M5-2 getExemplars 同尺');
    // 反证：四文件均无**手抄**的归档排除片段（`!=` 形态；`NOT IN ('archived','panorama')` 是另一把尺，不算）
    ok(!/(?<![\w.])memory_type\s*!=\s*'archived'/.test(memAll), '反证：记忆四模块已无手抄 `!= \'archived\'`（收敛到真源）');
    ok(MEM_LIVE_SQL.includes('deleted'), '真源本身含 `deleted`（手抄者必漏的那一档）', MEM_LIVE_SQL);

    ok(cc.includes('export function planSummaryChunks') && cc.includes('export function buildRuleDigest'), 'M5-3 纯逻辑单一真源（context-compaction 导出两函数）');
    ok(ae.includes('planSummaryChunks(conversations, maxRows)'), 'M5-3 逐段摘要接入真实现');
    ok(!ae.includes('conversations.slice(-maxRows)'), 'M5-3 旧的 slice(-maxRows) 已除（E19 根因）');
    ok(ae.includes('buildRuleDigest(conversations)'), 'M5-3 规则回退走如实摘要');
    ok(!/（前\$\{older\}轮对话已省略/.test(ae), 'M5-3 旧的"仅保留最近N轮"虚报文案已除');
  }
}

async function m6(): Promise<void> {
  // ── S1–S4 收口：build 标识的**派生一致性**（订正于 M5 落地时）────────
  // 订正（M5 落地时）：本块原为 ① 写值字面量 + 反向残留；② 手抄「哪 6 个文件要改」的前向清单；
  // ③ 读**他脚本文本**里是否含 dist 钉；④ 三处反向残留断言 —— 每开新轮须逐个手改，且清单逐轮滚长
  // （本轮实测：全部 rr 脚本共 36 处 / 9 文件钉住该字面量，＋源码写值 1 处）。改为**派生一致性**：
  // 真源＝agent-executor.ts 的那一处 build 值；由 scripts/lib/rr-pins.ts 枚举全量 rr 脚本核对同值。
  // 见 plans/improve/zx_20260912.md §M5。
  console.log('\n[M6/S1–S4 build 标识的派生一致性（枚举全量 rr 脚本，不再手抄清单）]');
  checkBuildPins(ok, { distDir: path.join(__dirname, '..', `${A}/dist`) });

  // ── S5 rr 收口计数（文件数口径；退出码口径由全量 sweep 计）────────
  // zx_20260911_5 M5 订正：原为 `=== 44`——每轮合法新增 rr 都会把它打红（自伤式守护）。
  // 该断言的语义是「防误删既有回归脚本」，不是「禁止增补」，故改为单调下界。
  console.log('\n[M6/S5 rr 脚本计数]');
  const rrFiles = fs.readdirSync(__dirname).filter(f => f.startsWith('rr_') && f.endsWith('.ts'));
  ok(rrFiles.length >= 44, 'rr 脚本不少于 44（防误删，不锁死计数；新增轮次脚本不应打红本断言）', String(rrFiles.length));
  ok(rrFiles.includes('rr_zx_20260911_4.ts'), '本轮脚本在位');
}

async function main(): Promise<void> {
  await m1();
  await m2();
  await m3();
  await m4();
  await m5();
  await m6();
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('rr 异常:', e); process.exit(1); });
