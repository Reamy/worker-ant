/**
 * zx_20260924_1 受控复跑 —— M2「无 @ 时，这句话算谁的」（批 M2，main 侧）。
 *
 * ── 病根（方案 §1.2 F2 / 挂账 H-1）──
 *   无 `@项目名` 的 IM 消息，原兜底只有一条 `ORDER BY COUNT(t.id) DESC LIMIT 1`
 *   ——**谁任务多就归谁**，与发消息的人、与这句话的内容**都无关**。
 *   在任务最多的项目上（真库实测 A股智能投顾 150 / 次高 32），几乎每条无 @ 的消息都被它吸走。
 *   而"这句话跟谁有关"的判别信号**本来就在场**：该用户上一笔 IM 任务写在哪个项目
 *   （`wa_tasks.context_json` 的 `{source:'im', channel, externalUser}`）。
 *
 * ── 本文件怎么证的（承 feedback「判据须用两只标本一起试」「往返须在生产入参上证」）──
 *   §B2.0 判据落点：认领函数只此一处实现、三条回执各挂一次依据句、**H-2 未开写**
 *         （`wa_im_conversations` 的 INSERT 列清单里没有 `project_id`——它是待坐实的坑，不是本轮的桥）。
 *   §B2.1 **函数级** `resolveProjectForUser` 直跑真实现（非复刻）：八格标本覆盖
 *         `recent` / 退 `most-active` / 渠道维度 / 归档项目不参选 / 非 IM 来源不参选 /
 *         更近的赢 / 脏 `context_json` 不抛且不参选 / 无活跃项目 ⇒ `null`。
 *   §B2.2 **路由级**（方案点名的那两只标本，缺一不可）：
 *         项目 A 任务多、项目 B 是该用户**最近一笔 IM 任务**所属 ⇒ 无 @ 的消息**必须**落 B
 *         且回执带「你最近一笔 IM 任务所属项目」；**删掉 B 的那笔任务** ⇒ **必须**落 A
 *         且依据变「当前最活跃项目」。两只都在同一夹具上一次跑完（只试一只 ⇒ 任何过宽/过窄的
 *         变体全票通过：只造 A 会漏掉"其实还在用最活跃"，只造 B 会漏掉"其实根本没变"）。
 *   §B2.3 第三态（`@项目名` 在场）：依据句**不出现**——那句话里的 @ 就是依据，不必再附一句。
 *   §B2.4 哑雷专项：本脚本零处"轮次等值字面量"（`=== 'zx_…'` 只对下一轮引爆），
 *         轮次标签**由载体自身派生**（`path.basename(__filename)`），两只标本一起试。
 *
 * ⚠ 本文件不打开任何真库；`routeImMessage` 顶层无 electron 依赖，故**真 import 真跑**（非复刻）。
 * ⚠ 夹具里所有时刻**显式给定**（`2000-01-01`／`2026-01-01` 这类定值），判据**不读墙钟**：
 *   `datetime('now')` 的秒级粒度也不是本文件任何断言的依据（同秒并列由 `t.rowid DESC` 兜底）。
 * ⚠ 风暴闸按用户计（窗 2s / 阈值 2，**第 3 条**起判暴）：§B2.2 同一用户恰 2 条 ⇒ 结构性不判暴，
 *   不必 sleep（夹具不许靠墙钟）。§B2.2 另加反证：回执里没有风暴提示。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  routeImMessage, resolveProjectForUser, projectBasisNote, STORM_NOTICE,
} from '../apps/worker-ant-desktop/src/main/services/im-router.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (p: string) => fs.readFileSync(path.join(root, p), 'utf-8');
type AnyDb = import('better-sqlite3').Database;

/** node:sqlite 无 better-sqlite3 的 `.transaction()`——补最小等价 shim（与其它 rr 同法）。 */
const withTx = (d: DatabaseSync) => { (d as unknown as { transaction: unknown }).transaction = (fn: () => void) => () => fn(); return d; };

/** 夹具 schema：**照抄 `database.ts` 的 DDL**（夹具比生产宽松即假绿）。 */
const SCHEMA = `
CREATE TABLE wa_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', cron_schedule TEXT, working_dir TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace',
  owner_id TEXT, cron_timezone TEXT DEFAULT 'Asia/Shanghai',
  autonomous_mode TEXT DEFAULT 'off', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_task_conversations (
  id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '',
  tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_memories (
  id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL, embedding TEXT,
  memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '',
  source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '', valence TEXT DEFAULT 'neutral',
  context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT, exemplar_context TEXT,
  updated_at TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_im_conversations (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT,
  message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound',
  created_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'sent', last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT ''
);
CREATE TABLE wa_jobs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}', status TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3, scheduled_at TEXT, started_at TEXT,
  completed_at TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
`;
const mkDb = (): AnyDb => { const d = withTx(new DatabaseSync(':memory:')); d.exec(SCHEMA); return d as unknown as AnyDb; };

const CH = 'wechat-personal';
const countOf = (db: AnyDb, sql: string, ...p: unknown[]): number => (db.prepare(sql).get(...p) as { c: number }).c;
const taskCount = (db: AnyDb): number => countOf(db, 'SELECT COUNT(*) c FROM wa_tasks');

/** 建一个活跃项目（`ctxJson` 缺省 `{}`——与生产里 GUI 建的项目同形）。 */
function seedProject(db: AnyDb, id: string, name: string, status = 'active'): void {
  db.prepare('INSERT INTO wa_projects (id, name, status) VALUES (?, ?, ?)').run(id, name, status);
}
/** IM 任务在 `context_json` 上的形状（**与生产三处同族写点一字不差**：source/channel/externalUser）。 */
const imCtx = (user: string, channel = CH): Record<string, unknown> => ({ source: 'im', channel, externalUser: user });

/** 建一条任务。时刻**显式给**（缺省锁在 2000 年，故"毫秒前后的相对次序"不读墙钟）。 */
function seedTask(db: AnyDb, id: string, projectId: string, title: string, opts?: { status?: string; ctx?: Record<string, unknown>; createdAt?: string }): void {
  const at = opts?.createdAt ?? '2000-01-01 00:00:00';
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, projectId, title, opts?.status ?? 'completed', JSON.stringify(opts?.ctx ?? {}), at, at);
}
const taskProject = (db: AnyDb, id: string): string | undefined =>
  (db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(id) as { project_id: string } | undefined)?.project_id;

/** 把一条消息接到**真 routeImMessage**上（生产入站链路），收集回话。 */
function send(db: AnyDb, from: string, text: string): { replies: string[]; run: () => Promise<void> } {
  const replies: string[] = [];
  const ctx = { db, channelId: 'ch-1', channelType: CH, sendReply: async (_to: string, t: string) => { replies.push(t); } };
  return { replies, run: () => routeImMessage(ctx as never, from, text, 'p2p', 'ctx-0', undefined) };
}

/**
 * 底架：项目 A 任务多、项目 B 是该用户（u_x）**最近一笔 IM 任务**所属、项目 C 有一条更晚的
 * **非 IM 来源**任务。§B2.1 各格在此之上改一处、验一处。
 */
function base(): AnyDb {
  const db = mkDb();
  seedProject(db, 'pA', '项目甲');
  seedProject(db, 'pB', '项目乙');
  seedProject(db, 'pC', '项目丙');
  seedTask(db, 'tA1', 'pA', '甲的活一', { createdAt: '2026-01-01 00:00:01' });
  seedTask(db, 'tA2', 'pA', '甲的活二', { createdAt: '2026-01-01 00:00:02' });
  seedTask(db, 'tA3', 'pA', '甲的活三', { createdAt: '2026-01-01 00:00:03' });
  seedTask(db, 'tB1', 'pB', '乙的活', { ctx: imCtx('u_x'), createdAt: '2026-01-02 00:00:00' });
  // 更晚、同渠道、同用户，但**来源不是 im** ⇒ 不该成为"最近一笔 IM 任务"
  seedTask(db, 'tC1', 'pC', '丙的活（非 IM 来源）', { ctx: { source: 'gui', channel: CH, externalUser: 'u_x' }, createdAt: '2026-01-03 00:00:00' });
  return db;
}

// ====== §B2.0 判据落点 ======
function s0(): void {
  console.log('\n[B2.0 判据落点（唯一实现 / 三条回执挂依据 / H-2 未开写）]');
  const src = stripKeepingLines(RD(`${A}/src/main/services/im-router.ts`)).join('\n');
  const raw = RD(`${A}/src/main/services/im-router.ts`);

  eq((src.match(/export function resolveProjectForUser/g) || []).length, 1, '认领判据只有**一处**实现（export 恰 1 次）');
  eq((src.match(/export function projectBasisNote/g) || []).length, 1, '依据句只有**一处**产出');
  ok(/resolveProjectForUser\(ctx\.db, \{ externalUser: toUser, channelType: ctx\.channelType \}\)/.test(src),
    '建任务兜底**真的调它**（不是新写一份同义 SQL 留在原地）');
  eq((src.match(/\$\{basisNote\}/g) || []).length, 3, '三条回执各挂一次依据（拆解成功 / 待执行 / 暂停）');
  // ② 那条"谁任务多归谁"的 SQL 已**搬家**：旧位置不再有一份副本
  eq((src.match(/ORDER BY COUNT\(t\.id\) DESC/g) || []).length, 1, '「最活跃」SQL 全文件只此一份（只作退路，不再各写一遍）');

  // ③ H-2：`wa_im_conversations.project_id` 在 src/main **零写点**（本轮**不**把它当桥）
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) files.push(p);
    }
  };
  walk(path.join(root, `${A}/src/main`));
  const cols = (text: string): string[][] => [...text.matchAll(/INSERT INTO wa_im_conversations\s*\(([^)]*)\)/g)].map((m) => m[1]!.split(',').map((s) => s.trim()));
  let insCount = 0; const offenders: string[] = [];
  for (const f of files) {
    for (const c of cols(fs.readFileSync(f, 'utf-8'))) {
      insCount++;
      if (c.includes('project_id')) offenders.push(`${path.relative(root, f)}: (${c.join(', ')})`);
    }
  }
  // 两只标本一起试：先证扫描器**扫到了东西**（否则"零命中"是空集的假绿），再证它**抓得住**该抓的
  ok(insCount > 0, `扫描器自证：src/main 里 wa_im_conversations 的 INSERT 列清单扫到 ${insCount} 处`, String(insCount));
  eq(cols("INSERT INTO wa_im_conversations (id, channel_id, project_id, message_json) VALUES (?,?,?,?)")[0]!.includes('project_id'), true,
    '扫描器自证：列清单里出现 project_id 时**抓得住**（判据不是恒假）');
  eq(offenders, [], 'H-2 未开写：`wa_im_conversations` 的写入列清单里**没有** `project_id`（它恒 NULL，不是认领判据的来源）');
  // 只读侧也不许拿它当来源——弱判据（注释内容）：防"漏记"，防不了"记错"
  ok(raw.includes('`wa_im_conversations.project_id` 不在此路'), '弱判据：源码里写明「该列不在此路」（防日后有人改从它取）');

  // ④ 两句话的**正文**（用户可见文案）
  eq(projectBasisNote('recent'), '（依据：你最近一笔 IM 任务所属项目）', '「最近一笔」依据句（逐字）');
  eq(projectBasisNote('most-active'), '（依据：当前最活跃项目）', '「最活跃」依据句（逐字）');
  eq([projectBasisNote(null), projectBasisNote(undefined)], ['', ''], '第三态**不硬凑**：@项目名 / 新建项目时依据句为空');
  ok(projectBasisNote('recent') !== projectBasisNote('most-active'), '反证：两种依据**不是同一句话**（否则"变依据"不可观测）');
}

// ====== §B2.1 函数级 ======
function s1(): void {
  console.log('\n[B2.1 resolveProjectForUser 直跑真实现（八格标本）]');
  const db = base();

  // ① 最近一笔 IM 任务所属 ⇒ recent
  eq(resolveProjectForUser(db, { externalUser: 'u_x', channelType: CH }), { id: 'pB', name: '项目乙', basis: 'recent' },
    '①该用户最近一笔 IM 任务在 B ⇒ recent/B（丙那条**更晚**但不是 IM 来源，不得赢）');

  // ② 无历史 ⇒ 退最活跃（SQL 一字未改）
  eq(resolveProjectForUser(db, { externalUser: 'u_y', channelType: CH }), { id: 'pA', name: '项目甲', basis: 'most-active' },
    '②无 IM 历史的用户 ⇒ most-active/A（A=3 条，多于 B=1、C=1）');

  // ③ 渠道是键的一部分：同一用户在**别的渠道**没有历史
  eq(resolveProjectForUser(db, { externalUser: 'u_x', channelType: 'dingtalk' }), { id: 'pA', name: '项目甲', basis: 'most-active' },
    '③换渠道后**同一用户**也不是 recent（渠道进了判据键，不是只看 externalUser）');

  // ④ 更近的另一笔 IM 任务会赢（次序真的按时间，不是"第一个碰上的"）
  seedTask(db, 'tB2', 'pA', '甲的新活', { ctx: imCtx('u_x'), createdAt: '2026-01-05 00:00:00' });
  eq(resolveProjectForUser(db, { externalUser: 'u_x', channelType: CH })?.id, 'pA', '④同一用户有**更近**的 IM 任务时，就近的那笔赢');
  db.prepare("DELETE FROM wa_tasks WHERE id = 'tB2'").run();
  eq(resolveProjectForUser(db, { externalUser: 'u_x', channelType: CH })?.id, 'pB', '④反向：删掉更近那笔 ⇒ 退回 B（与删前不同，证明上一条不是恒真）');

  // ⑤ 归档项目不参选（JOIN 上的 `p.status='active'`）
  db.prepare("UPDATE wa_projects SET status = 'archived' WHERE id = 'pB'").run();
  eq(resolveProjectForUser(db, { externalUser: 'u_x', channelType: CH })?.basis, 'most-active',
    '⑤用户那笔 IM 任务所属项目已归档 ⇒ 不参选（回落到最活跃，而不是把话投进坟场）');

  // ⑥ 脏 `context_json`：不抛、不参选（`json_valid` 守卫的两只标本）
  {
    const d2 = base();
    // 少一个引号的坏 JSON——无守卫时 `json_extract` 会**抛**，把整条查询打掉（所有行一起退到最活跃＝静默降级）
    d2.prepare(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, created_at, updated_at)
                VALUES ('tD1', 'pC', '脏行', 'completed', '{not valid json', '2026-01-09 00:00:00', '2026-01-09 00:00:00')`).run();
    const r = resolveProjectForUser(d2, { externalUser: 'u_x', channelType: CH });
    eq(r, { id: 'pB', name: '项目乙', basis: 'recent' }, '⑥脏 context_json 的行：既不抛，也不参选（真实现照样认出 B）');
    ok(r !== null, '⑥反证：这一格真的求值了（不是被 catch 吞成"无候选"）');
  }

  // ⑦ 一个活跃项目都没有 ⇒ null（调用方据此走"新建『IM对话项目』"，本函数不替它拿主意）
  {
    const d3 = mkDb();
    eq(resolveProjectForUser(d3, { externalUser: 'u_x', channelType: CH }), null, '⑦空库 ⇒ null');
    seedProject(d3, 'pZ', '只剩归档的', 'archived');
    eq(resolveProjectForUser(d3, { externalUser: 'u_x', channelType: CH }), null, '⑦只有归档项目 ⇒ 同样 null（不退到一个非活跃项目上）');
  }

  // ⑧ 本函数**只读**：调用前后三张表行数不变（"不读也不写"里可证的那一半）
  {
    const d4 = base();
    const before = ['wa_projects', 'wa_tasks', 'wa_im_conversations'].map((t) => countOf(d4, `SELECT COUNT(*) c FROM ${t}`));
    const r = resolveProjectForUser(d4, { externalUser: 'u_x', channelType: CH });
    const after = ['wa_projects', 'wa_tasks', 'wa_im_conversations'].map((t) => countOf(d4, `SELECT COUNT(*) c FROM ${t}`));
    eq(after, before, '⑧认领判据是**纯读**（projects/tasks/im_conversations 行数一字未动）');
    eq(r?.id, 'pB', '⑧且它确实给出了答案（不是靠"没跑"换来的干净）');
  }
}

// ====== §B2.2 路由级（方案点名的两只标本） ======
async function s2(): Promise<void> {
  console.log('\n[B2.2 真 routeImMessage：无 @ 的消息落谁（两只标本一起试）]');
  const db = base();
  seedTask(db, 'tR1', 'pB', '该用户上一笔 IM 任务', { ctx: imCtx('u_r'), createdAt: '2026-01-04 00:00:00' });

  // ── 标本一：B 在场上 ⇒ 落 B，且回执说"凭什么" ─────────────────────────────
  const r1 = send(db, 'u_r', '创建任务+记账口径');
  await r1.run();
  eq(r1.replies.length, 1, '标本一恰回一句');
  const first = r1.replies[0] ?? '';
  ok(first.includes('（依据：你最近一笔 IM 任务所属项目）'), '标本一：回执带「你最近一笔 IM 任务所属项目」', first);
  ok(first.includes('（项目: 项目乙）'), '标本一：落的是**项目乙**（B）');
  ok(!first.includes('（依据：当前最活跃项目）'), '标本一：**没有**出现"最活跃"那句（两者互斥、不会被同时写上）');
  ok(!first.includes(STORM_NOTICE), '反证：这句不是风暴提示（风暴闸未拦）');
  const new1 = taskCount(db);
  const id1 = (db.prepare('SELECT id FROM wa_tasks ORDER BY rowid DESC LIMIT 1').get() as { id: string }).id;
  eq(taskProject(db, id1), 'pB', '标本一：新建任务的 `project_id` **真落 B**（不只看回执那句文案）');
  const ctx1 = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id1) as { context_json: string }).context_json) as Record<string, unknown>;
  eq([ctx1.source, ctx1.channel, ctx1.externalUser], ['im', CH, 'u_r'], '标本一：新任务带齐 IM 溯源三件（下一句才认得出它）');

  // H-2：认领没往 `wa_im_conversations.project_id` 里写东西（该列仍恒 NULL）
  const imTotal = countOf(db, 'SELECT COUNT(*) c FROM wa_im_conversations');
  eq(countOf(db, 'SELECT COUNT(*) c FROM wa_im_conversations WHERE project_id IS NOT NULL'), 0,
    `H-2 未开写：${imTotal} 条入站行里 project_id 非空的**仍为 0**`);
  ok(imTotal > 0, `反证：这一格不是空集的假绿（确有 ${imTotal} 条入站行在册）`);

  // ── 标本二：删掉 B 的那笔任务 ⇒ 落 A，且依据变"最活跃" ────────────────────
  //   ⚠ 这一步**是**载重的：标本一留下的那条任务状态为 `paused`（≤10 字的短消息），
  //     而 `handleAgentReply`（步骤1）在建任务路（步骤6）**之前**——不删，第二句会被它当"回复"吃掉。
  eq(countOf(db, "SELECT COUNT(*) c FROM wa_tasks WHERE project_id = 'pB' AND status = 'paused'"), 1,
    '前置：标本一确实留下一条 `paused` 任务在 B（故"删 B"这一步是载重的，不是在走过场）');
  const del = db.prepare("DELETE FROM wa_tasks WHERE project_id = 'pB'").run();
  const changes = (del as { changes: number }).changes;
  ok(changes >= 1, '删掉 B 的全部任务', `changes=${changes}`);
  eq(taskCount(db), new1 - changes, '删掉的**恰是 B 的那几笔**（不是整表清空）');
  eq((db.prepare('SELECT DISTINCT project_id AS p FROM wa_tasks ORDER BY project_id').all() as Array<{ p: string }>).map((r) => r.p),
    ['pA', 'pC'], '场上只剩 A 与 C 的任务（B 已清空——"最近一笔"这条线索真的断了）');

  const r2 = send(db, 'u_r', '创建任务+复核口径');
  await r2.run();
  eq(r2.replies.length, 1, '标本二恰回一句');
  const second = r2.replies[0] ?? '';
  ok(second.includes('（依据：当前最活跃项目）'), '标本二：依据**变了**——回执带「当前最活跃项目」', second);
  ok(second.includes('（项目: 项目甲）'), '标本二：落的是**项目甲**（A，任务最多）');
  ok(!second.includes('（依据：你最近一笔 IM 任务所属项目）'), '标本二：**不再**说"最近一笔"（旧依据确实退场了）');
  ok(!second.includes(STORM_NOTICE), '反证：同一用户第 2 条仍未判暴（阈值是"第 3 条起"）');
  const id2 = (db.prepare('SELECT id FROM wa_tasks ORDER BY rowid DESC LIMIT 1').get() as { id: string }).id;
  eq(taskProject(db, id2), 'pA', '标本二：新建任务的 `project_id` **真落 A**');

  // 两只标本的落点必须**不同**，否则"变依据"三个字无从谈起
  ok(taskProject(db, id1) !== taskProject(db, id2), '两标本落点不同（B → A）：改的是行为，不只是文案');
}

// ====== §B2.3 第三态：@项目名在场 ======
async function s3(): Promise<void> {
  console.log('\n[B2.3 `@项目名` 在场（依据句**不出现**，那句 @ 就是依据）]');
  const db = mkDb();
  seedProject(db, 'pA', '项目甲');
  seedTask(db, 'tA1', 'pA', '甲的活', { createdAt: '2026-01-01 00:00:00' });
  // 该用户**没有**任何 IM 历史 ⇒ 若 @ 未被认领，兜底会落回最活跃（A）——两路都指向 A，
  // 故必须另有一条判据把两者分开：**依据句在不在**。
  const { replies, run } = send(db, 'u_at', '@项目甲 创建任务+写周报');
  await run();
  eq(replies.length, 1, '@ 消息恰回一句');
  const out = replies[0] ?? '';
  ok(out.includes('（项目: 项目甲）'), '@ 命中的项目 = 项目甲', out);
  ok(!out.includes('（依据：'), '@ 在场时**不附依据句**（第三态：没有第二种解释可挑）');
  const idn = (db.prepare('SELECT id FROM wa_tasks ORDER BY rowid DESC LIMIT 1').get() as { id: string }).id;
  eq(taskProject(db, idn), 'pA', '@ 命中的任务真落 项目甲');
  ok(projectBasisNote(null) === '', '反证：第三态的依据句**就是**空串（与上面回执的缺席同一件事）');
}

// ====== §B2.4 哑雷专项 ======
function s4(): void {
  console.log('\n[B2.4 哑雷专项：本脚本零处"轮次等值字面量"]');
  // 轮次标签**由载体自身派生**（本脚本的文件名），不手抄常量——
  // 凡 `=== 'zx_20260924_1'` 这类等值断言就是"只对下一轮引爆"的哑雷，且换个语法外壳即可躲过前缀正则。
  const ROUND = (path.basename(__filename).match(/zx_\d{8}(?:_\d+)?/) ?? [''])[0]!;
  ok(ROUND.length > 0, '自证：轮次标签由 `path.basename(__filename)` 派生（不手抄任何轮次常量）', ROUND);
  // 判据的形状与扫描面**同一处**：等值比较（`eq(x, 'zx_…')` / `=== 'zx_…'` / `!== 'zx_…'`）
  const RE_DUMB = /(?:eq\([^,)]*,\s*|===?\s*|!==?\s*)['"](zx_\d{8}(?:_\d+)?)['"]/g;
  const scan = (s: string): string[] => [...s.matchAll(RE_DUMB)].map((m) => m[1]!);
  const hits = scan(stripKeepingLines(fs.readFileSync(__filename, 'utf-8')).join('\n'));
  // 两只标本一起试：只用"该命中"⇒ 任何过窄的变体全票通过；只用"该不命中"⇒ 任何过宽的变体全票通过
  eq(scan(`ok(x === '${ROUND}', 'x')`).length, 1, '正标本：等值字面量**抓得住**（判据不是恒假）');
  eq(scan(`ok(x !== '${ROUND}', 'x')`).length, 1, '正标本：`!==` 那种外壳同样抓得住');
  eq(scan('ok(x >= ROUND, "x")'), [], '负标本：**派生比较**放过（正是本文件的写法）');
  eq(scan(`ok(p.includes('plans/improve/${ROUND}.md'), 'x')`), [], '负标本：方案路径（含轮次但非等值判据）放过');
  eq(hits, [], `本文件零处轮次等值字面量（派生的 ${ROUND} 不算）`);

  // 另一条同族哑雷：判据依赖**真实墙钟**（同族"按钟引爆"，只在某时间窗内为真）。
  // ⚠ 判据不得被**自己的形状**咬到：下面这正则由**现拼**的片段构成，源码里不出现那两个字面形态——
  //   第一版写成 `/new Date\(|Date\.now\(\)/` 就是本行自己命中了自己（现成的教训）。
  const CLOCK_RE = new RegExp(`${'Date'}\\.${'now'}\\(\\)|new ${'Date'}\\(`);
  const selfSrc = stripKeepingLines(fs.readFileSync(__filename, 'utf-8')).join('\n');
  eq(CLOCK_RE.test(`const t = ${'Date'}.${'now'}();`), true, '正标本：读墙钟的写法**抓得住**（判据不是恒假）');
  eq(CLOCK_RE.test("createdAt: '2026-01-01 00:00:00'"), false, '负标本：显式定值时刻放过');
  eq(CLOCK_RE.test(selfSrc), false, '本文件不读墙钟：`Date` 取当前时刻的写法零处');
}

async function main(): Promise<void> {
  s0();
  s1();
  await s2();
  await s3();
  s4();
  console.log('\n[B2.5 轮级 build 钉子（P1–P6 派生一致性）]');
  checkBuildPins(ok, { distDir: path.join(root, `${A}/dist`) });
  console.log(`\n结果: pass=${pass} fail=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
