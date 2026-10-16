/**
 * zx_20261011_4 受控复跑 —— 协同**编排层**：让本机拆出来的子任务真能派给他机、结果真能回流、
 *   依赖链真能推进（C2 的下半场：管道早已修好，本轮**首次有人去用它**）。
 *
 * 本轮口径一句话（维特根斯坦·意义即使用 / 道德经·知止）：**派得出去不算数，"外派"这个词的意义在于
 *   它真正使用起来的后果**——远端 done ⇒ 本地子任务**真** `completed` ∧ 父任务**真**恢复；本机跑得过来
 *   就**不外派**（不自足者不外派）；等远端**有界**，超时即**收回**（不无限等一个可能已死的对端）。
 *
 * 病根（本轮方案 §1）：
 *   N1 管道在、无人用——`dispatchNodeRequest` 全仓唯一调用方是人手点的「派活」卡，**引擎从不自动派活**。
 *   N2 不新增 status，复用 `pending` + `context_json` 三键（避开新增枚举的四类读点穷举爆炸半径）。
 *   N3 外派须"有人可派"（无在线可派对端 ⇒ 不外派，免得造一张永远没人接的悬空单）。
 *   N4 超时必收回（否则任务树永久悬空、父任务永等不到子完成 ⇒ 互锁）。
 *   N5 名实：远端收口 ≠ 本机验收（远端自报完成，本机未复核——如实边界写进文案与断言）。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据一律静态导入生产导出（被删/改名即编译期失败）。
 *   G-2 **两侧标本**：凡判"命中/放行/收窄/终态"的判据，反面标本（不命中）一并喂。
 *   G-4 **不碰真实网络/墙钟**：到 ANS 的请求一概注入假实现；时刻一律用**冻结基准**（不取 `Date.now`）。
 *   G-5 判"用户可见文案还在不在"读 `stripKeepingLines` 后的代码（注释里提到旧文案不构成本文之病）。
 *   G-6 **无轮次字面量**：本轮方案路径/脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 *   ⚠ 计数器类断言一律**正面**（"值从 0 变 1"），不只断言"不抛"——被 `try/catch` 吞掉的写入只有正面断言抓得住。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**全部静态导入** ⇒ 被删/改名即编译期失败（而非"扫了个空、静默假绿"）。
import {
  REMOTE_ASSIGN_NODE_KEY,
  REMOTE_ASSIGN_REQUEST_KEY,
  REMOTE_ASSIGN_AT_KEY,
  REMOTE_RESULT_KEY,
  REMOTE_SUMMARY_KEY,
  REMOTE_RESULT_AT_KEY,
  ORCHESTRATE_MODES,
  ORCHESTRATE_OVERFLOW_PER_TICK,
  isOrchestrateMode,
  readOrchestrateMode,
  remoteAssignOf,
  isRemoteAssigned,
  remoteTaskView,
  markRemoteAssigned,
  clearRemoteAssigned,
  countRemoteAssignedPending,
  planOffloads,
  type OrchestrateMode,
} from '../apps/worker-ant-desktop/src/main/core/node-orchestrate.js';
// C：远端驱动的收口真实现（真读回、真 CAS、真走既有 checkParentTaskAfterChildDone）。
import {
  driveRemoteSubtasks,
  REMOTE_ASSIGN_TIMEOUT_MS,
  type DriveRemoteResult,
} from '../apps/worker-ant-desktop/src/main/core/node-remote-driver.js';
// D：编排左半场的真驱动（真闸、真派、真写归属）。
import { driveOrchestration, ORCHESTRATE_CATEGORY } from '../apps/worker-ant-desktop/src/main/core/orchestrator.js';
import { TaskScheduler } from '../apps/worker-ant-desktop/src/main/core/task-scheduler.js';
// F：上屏词表（判据一处、可两标本直跑）。
import { orchestrationLabel, REMOTE_RESULT_CAVEAT } from '../apps/worker-ant-desktop/renderer/src/lib/node-view.js';
import { NODE_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/node-identity.js';
import { PROJECT_CONCURRENCY_DEFAULT, PROJECT_RUNNING_STATUSES } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import type { AnsNode, AnsNodeRequest, NodeRequestSubmit } from '../packages/shared-types/src/nodes.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 等值断言（把实际值一并打出——红的时候要能立刻看出"差在哪"）。 */
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
/** 静态判据读**原文**；判"用户可见文案还在不在"用 `CODE()`（G-5）。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261011_4

type AnyDb = import('better-sqlite3').Database;

/* ── 夹具 ────────────────────────────────────────────────────────────────── */

/** G-4：冻结基准时刻——判"在不在线"/"超没超时"不取墙钟，标本才在任意时刻为真。 */
const NOW_MS = Date.parse('2026-10-11T00:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * 夹具 schema —— 按 `main/database.ts` DDL 摘相关列（NOT NULL 照抄，防"夹具比生产宽松"的假绿）。
 * 覆盖本轮真正读写的表：wa_settings（入网/编排模式/角色）、wa_projects（扫描面/并发）、
 * wa_tasks（外派/收口/父恢复）、wa_task_conversations（system 留痕/逐子简报）、wa_jobs（父恢复入队）、
 * wa_event_log（D5 幂等守卫落点）、wa_deliverables（buildTaskOutcome 计数）。
 */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '', status TEXT DEFAULT 'active',
  context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, parent_task_id TEXT DEFAULT '', title TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0, acceptance_criteria TEXT DEFAULT '',
  depends_on TEXT DEFAULT '', context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL DEFAULT 'user', content TEXT DEFAULT '',
  token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT '', payload TEXT DEFAULT '{}', status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_type TEXT, aggregate_id TEXT, event_type TEXT, payload TEXT, occurred_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, file_path TEXT, created_at TEXT DEFAULT (datetime('now')));
`;

const dbBase = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };
const set = (d: AnyDb, key: string, value: string): void =>
  d.prepare('INSERT OR REPLACE INTO wa_settings (key,value,updated_at) VALUES (?,?,datetime(\'now\'))').run(key, value);

/** 本机入网（`node.id` ∧ `node.resource_group=node:<id>` ⇒ `isNodeEnrolled` 真），并给派发方角色。 */
function enroll(d: AnyDb, opts: { mode?: OrchestrateMode | string; role?: string; id?: string } = {}): void {
  const id = opts.id ?? 'n-self';
  set(d, NODE_SETTING_KEYS.id, id);
  set(d, NODE_SETTING_KEYS.resourceGroup, `node:${id}`);
  set(d, NODE_SETTING_KEYS.ansApiKey, 'wa_rr_enrolled_key'); // zx_20261012：判据增②（非占位凭据）补齐真形状
  set(d, NODE_SETTING_KEYS.role, opts.role ?? 'primary'); // 缺省 primary ⇒ canDispatch 真
  if (opts.mode !== undefined) set(d, NODE_SETTING_KEYS.orchestrateMode, String(opts.mode));
}

const PROJ = 'proj-orch';

/** 建一个 active 项目 + 若干占用并发的任务（`PROJECT_RUNNING_STATUSES` 之一 ⇒ 占位）。 */
function addOccupied(d: AnyDb, n: number): void {
  d.prepare("INSERT OR REPLACE INTO wa_projects (id,name,status,context_json) VALUES (?,?, 'active', '{}')").run(PROJ, '编排项目');
  for (let i = 0; i < n; i++) {
    const st = PROJECT_RUNNING_STATUSES[i % PROJECT_RUNNING_STATUSES.length]!;
    d.prepare("INSERT INTO wa_tasks (id,project_id,title,status) VALUES (?,?,?,?)").run(`run-${i}`, PROJ, `在跑${i}`, st);
  }
}
/** 插一件 pending 子任务（可带标题/描述/验收/上下文），返回 id。 */
function addPending(d: AnyDb, id: string, over: { title?: string; description?: string; acceptance?: string; parent?: string; ctx?: Record<string, unknown> } = {}): string {
  d.prepare(`INSERT INTO wa_tasks (id,project_id,parent_task_id,title,description,acceptance_criteria,status,context_json)
    VALUES (?,?,?,?,?,?, 'pending', ?)`)
    .run(id, PROJ, over.parent ?? '', over.title ?? '', over.description ?? '', over.acceptance ?? '', JSON.stringify(over.ctx ?? {}));
  return id;
}
const ctxOf = (d: AnyDb, id: string): Record<string, unknown> =>
  JSON.parse((d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}');
const statusOf = (d: AnyDb, id: string): string =>
  (d.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
const notesOf = (d: AnyDb, id: string): string[] =>
  (d.prepare("SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'system' ORDER BY rowid ASC").all(id) as Array<{ content: string }>).map((r) => r.content);

/** 一条中转请求（只填本轮判据用得到的字段；其余取与生产同形的缺省）。 */
function ansReq(over: Partial<AnsNodeRequest>): AnsNodeRequest {
  return {
    id: 'rq-0001', category: 'project_task', payload: { prompt: '干活' },
    requester_key_prefix: 'ab12', requester_node_id: 'n-self', target_node_id: 'n-peer',
    status: 'assigned', result: null,
    question: null, answer: null, question_status: null,
    created_at: iso(NOW_MS), claimed_at: null, done_at: null,
    ...over,
  };
}

/** 一台在线 ∧ 可派的对端标本（worker ∧ 参与 ∧ 刚心跳过）。 */
function peer(id: string): AnsNode {
  return {
    node_id: id, name: `对端-${id}`, api_key_prefix: 'ab', resource_group: `node:${id}`, platform: 'darwin',
    role: 'worker', weight: 1, participate: true, capabilities: [], card: null, status: null,
    enrolled_at: iso(NOW_MS - 3600_000), last_seen_at: iso(NOW_MS - 5000),
  };
}

/** 假 IO：记录每次 `submit` 的入参（判"真没派"＝零调用，而非"派了没记"）。 */
function fakeSubmit(responder: (req: NodeRequestSubmit) => AnsNodeRequest): { calls: NodeRequestSubmit[]; io: { submit: (r: NodeRequestSubmit) => Promise<AnsNodeRequest>; get: (id: string) => Promise<AnsNodeRequest>; answer: (id: string, a: string) => Promise<AnsNodeRequest> } } {
  const calls: NodeRequestSubmit[] = [];
  return {
    calls,
    io: {
      submit: async (r) => { calls.push(r); return responder(r); },
      get: async () => { throw new Error('unused-get'); },
      answer: async () => { throw new Error('unused-answer'); },
    },
  };
}

/** 假 IO：读回返回固定 request（驱动收口用）。 */
const readIo = (req: AnsNodeRequest) => ({
  submit: async () => { throw new Error('unused-submit'); },
  get: async () => req,
  answer: async () => { throw new Error('unused-answer'); },
});

async function main(): Promise<void> {
  // ═══ A｜键与谓词四格 + 写口 RMW（维特根斯坦·意义即使用：外派这个词得有一处记法）══════════
  console.log('\n【A】三键/回传键一处真源 + 谓词四格 + 写口不抹兄弟键');
  {
    eq([REMOTE_ASSIGN_NODE_KEY, REMOTE_ASSIGN_REQUEST_KEY, REMOTE_ASSIGN_AT_KEY], ['assigned_node_id', 'assigned_request_id', 'assigned_at'],
      'A-1 ★「已外派」三键一处真源（散落即"同一件事两个名字"，必有一处漂）');
    eq([REMOTE_RESULT_KEY, REMOTE_SUMMARY_KEY, REMOTE_RESULT_AT_KEY], ['remote_result', 'completion_summary', 'remote_result_at'],
      'A-2 ★回传三键一处真源（写口 driver / 读口投影同引它）');
    eq([...ORCHESTRATE_MODES], ['off', 'auto'],
      'A-3 ★编排模式词表＝off/auto（缺省 off——不惊扰既有行为）；增删一格须同步全部读点');
    eq([isOrchestrateMode('off'), isOrchestrateMode('auto'), isOrchestrateMode('on'), isOrchestrateMode(1)],
      [true, true, false, false], 'A-4 词表收窄：仅 off/auto 为真（脏值一律不认）');

    const assigned = JSON.stringify({ [REMOTE_ASSIGN_NODE_KEY]: 'n-peer', [REMOTE_ASSIGN_REQUEST_KEY]: 'rq-1', [REMOTE_ASSIGN_AT_KEY]: iso(NOW_MS), sibling_key: 'keep', depth: 2 });
    // —— 四格穷举（承 feedback_predicate_needs_both_sides_specimen：只喂"该命中"那只 ⇒ 任何过宽变体全票通过）——
    eq([
      remoteAssignOf('{}'),                                                              // 无三键 ⇒ null
      remoteAssignOf(JSON.stringify({ [REMOTE_ASSIGN_NODE_KEY]: 'n-peer' })),             // 仅 nodeId（无 requestId）⇒ null
      remoteAssignOf(assigned),                                                           // 两键齐 ⇒ 有值
      remoteAssignOf('not json'),                                                         // 非法 JSON ⇒ null
    ], [null, null, { nodeId: 'n-peer', requestId: 'rq-1', assignedAt: iso(NOW_MS) }, null],
      'A-5 ★★四格穷举：仅「nodeId ∧ requestId 两键皆非空」算外派；缺键 / 非法 JSON **皆落选**（单边变体挡得住才算数）');
    eq([isRemoteAssigned(assigned), isRemoteAssigned('{}'), isRemoteAssigned(null), isRemoteAssigned(JSON.stringify({ [REMOTE_ASSIGN_NODE_KEY]: '', [REMOTE_ASSIGN_REQUEST_KEY]: 'rq' }))],
      [true, false, false, false],
      'A-6 `isRemoteAssigned` 与 `remoteAssignOf` **同一判据**（空串 nodeId 也不算外派）');

    // —— 写口 RMW 整份（**正面断言**：mark 后兄弟键仍在、清后仍在）——
    const d = dbBase();
    addPending(d, 't1', { ctx: { sibling_key: 'keep', depth: 2 } });
    ok(markRemoteAssigned(d as unknown as never, 't1', { nodeId: 'n-peer', requestId: 'rq-1' }, iso(NOW_MS)), 'A-7a `markRemoteAssigned` 真写成功（changes>0）');
    const c1 = ctxOf(d, 't1');
    eq([c1[REMOTE_ASSIGN_NODE_KEY], c1[REMOTE_ASSIGN_REQUEST_KEY], c1[REMOTE_ASSIGN_AT_KEY], c1.sibling_key, c1.depth],
      ['n-peer', 'rq-1', iso(NOW_MS), 'keep', 2],
      'A-7b ★★写口 **读-改-写整份**：三键写齐 ∧ 兄弟键 `sibling_key`/`depth` **仍在**（不抹——`updateContext` 是整体替换，故 RMW 必须整份）');
    ok(clearRemoteAssigned(d as unknown as never, 't1'), 'A-8a `clearRemoteAssigned` 真写成功');
    const c2 = ctxOf(d, 't1');
    ok(!(REMOTE_ASSIGN_NODE_KEY in c2) && !(REMOTE_ASSIGN_REQUEST_KEY in c2) && !(REMOTE_ASSIGN_AT_KEY in c2) && c2.sibling_key === 'keep',
      'A-8b ★撤归属**只删三键、留其余**（兄弟键仍在——不能把整份抹成空对象）');
    eq(countRemoteAssignedPending(d as unknown as never, PROJ), 0,
      'A-9 撤归属后本项目"已外派 pending"计数归 0');

    // —— M4 展示投影：远端回传与未回传两侧标本（不把"没回传"伪造成有值）——
    const dView = dbBase();
    addPending(dView, 'v0', { ctx: { plain: 1 } });
    eq(remoteTaskView(ctxOf(dView, 'v0') ? JSON.stringify(ctxOf(dView, 'v0')) : null), null,
      'A-10 非外派（无三键）⇒ 投影 `null`（"这不是一件外派的活"）');
    addPending(dView, 'v1', { ctx: { [REMOTE_ASSIGN_NODE_KEY]: 'n-peer', [REMOTE_ASSIGN_REQUEST_KEY]: 'rq-1', [REMOTE_ASSIGN_AT_KEY]: iso(NOW_MS) } });
    const va = remoteTaskView(JSON.stringify(ctxOf(dView, 'v1')))!;
    eq([va.nodeId, va.requestId, va.result, va.summary, va.resultAt], ['n-peer', 'rq-1', null, '', ''],
      'A-11 ★已外派未回传 ⇒ `result=null` / `summary=\'\'` / `resultAt=\'\'`（**不把"没回传"伪造成有值**）');
    addPending(dView, 'v2', { ctx: { [REMOTE_ASSIGN_NODE_KEY]: 'n-peer', [REMOTE_ASSIGN_REQUEST_KEY]: 'rq-2', [REMOTE_ASSIGN_AT_KEY]: iso(NOW_MS), [REMOTE_RESULT_KEY]: { taskStatus: 'completed' }, [REMOTE_SUMMARY_KEY]: '远端任务态：completed', [REMOTE_RESULT_AT_KEY]: iso(NOW_MS + 1000) } });
    const vb = remoteTaskView(JSON.stringify(ctxOf(dView, 'v2')))!;
    eq([vb.result, vb.summary, vb.resultAt], [{ taskStatus: 'completed' }, '远端任务态：completed', iso(NOW_MS + 1000)],
      'A-12 ★已回传 ⇒ 投影带出 result/summary/resultAt（面板下钻的真源，与 driver 写口同处）');
  }

  // ═══ B｜调度让位（知止：已外派的子任务，本机不抢跑）════════════════════════════════
  console.log('\n【B】真 `TaskScheduler.getReadyTasks` 让位 + 撤归属复现（反证）');
  {
    const d = dbBase();
    addOccupied(d, 0);
    addPending(d, 'A', { title: '甲' });
    addPending(d, 'B', { title: '乙' });
    const sched = new TaskScheduler(d);
    const ready = () => sched.getReadyTasks(PROJ).map((t) => String(t.id)).sort();
    eq(ready(), ['A', 'B'], 'B-0 基准：两件 pending 皆就绪（后续"让位"的对照）');

    markRemoteAssigned(d as unknown as never, 'A', { nodeId: 'n-peer', requestId: 'rq-1' }, iso(NOW_MS));
    eq(ready(), ['B'], 'B-1 ★★已外派者**不出现在就绪表**（引擎不抢跑——正是"复用 pending 但本机不跑"的那道显式排除）');
    eq(countRemoteAssignedPending(d as unknown as never, PROJ), 1, 'B-2 ★留可见理由的那个计数从 0 变 1（正面断言）');

    clearRemoteAssigned(d as unknown as never, 'A');
    eq(ready(), ['A', 'B'], 'B-3 ★★反证：撤归属后**复现**在就绪表（让位靠判据而非丢数据）');
    eq(countRemoteAssignedPending(d as unknown as never, PROJ), 0, 'B-4 计数回落 0（与 B-2 成对）');

    const SCHED = CODE(`${A}/src/main/core/task-scheduler.ts`);
    ok(/\.filter\(t => !isRemoteAssigned\(t\.context_json/.test(SCHED),
      'B-5 ★接线：让位判据**一处**（`getReadyTasks` 里 `isRemoteAssigned` 过滤——非页面/别处各写一份 `!assigned_node_id`）');
    ok(/countRemoteAssignedPending\(/.test(SCHED) && /本机不抢跑/.test(SCHED),
      'B-6 ★扫描路**留可见理由**（`countRemoteAssignedPending` + 日志文案"本机不抢跑"——不留静默分叉）');
  }

  // ═══ C｜远端驱动收口（核心：意义即使用——本地任务树真动了）════════════════════════════
  console.log('\n【C】`driveRemoteSubtasks`：done 真收口 ∧ 父真恢复 ∧ 幂等 ∧ error/超时两侧标本');
  {
    const d = dbBase();
    enroll(d);
    addOccupied(d, 0);
    // 父任务 paused（等子态）——子完成后应被既有 checkParentTaskAfterChildDone 恢复为 pending。
    d.prepare("INSERT INTO wa_tasks (id,project_id,parent_task_id,title,status) VALUES ('P',?, '', '父任务', 'paused')").run(PROJ);
    addPending(d, 'C1', { title: '外派子任务', parent: 'P' });
    markRemoteAssigned(d as unknown as never, 'C1', { nodeId: 'n-peer', requestId: 'rq-1' }, iso(NOW_MS - 60_000));

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const enqueued: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const deps = {
      io: readIo(ansReq({ id: 'rq-1', status: 'done', result: { taskStatus: 'completed', summary: '远端已做完' } })),
      emit: (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return true; },
      enqueue: async (type: string, payload: Record<string, unknown>) => { enqueued.push({ type, payload }); return ''; },
      now: () => NOW_MS,
    };
    const r1: DriveRemoteResult = await driveRemoteSubtasks(d as unknown as never, deps as never);
    eq([r1.checked, r1.completed, r1.failed, r1.reclaimed], [1, 1, 0, 0], 'C-1a 本拍扫到 1 件、收口 1 件 completed');
    eq(statusOf(d, 'C1'), 'completed', 'C-1b ★★端到端：远端 done ⇒ 本地子任务**真** `completed`（CAS 命中；不是"键写进去了"）');
    eq(events.filter((e) => e.type === 'task.completed').length, 1,
      'C-1c ★★正面断言：`task.completed` 事件**恰 1 条**（满足 invariant #1：completed 必有事件；计数器非"不抛"）');
    const cc = ctxOf(d, 'C1');
    eq([typeof cc[REMOTE_RESULT_KEY], cc[REMOTE_SUMMARY_KEY], typeof cc[REMOTE_RESULT_AT_KEY]],
      ['object', '远端任务态：completed', 'string'],
      'C-1d ★回传结果/摘要/时刻落进 context（面板可下钻 ∧ 父逐子简报取得到——同一处真源）');
    ok(notesOf(d, 'C1').some((s) => s.includes('未复核')),
      'C-1e ★★N5 如实边界：system 留痕含「远端自报完成，本机未复核」（不冒充"本机验收通过"）');
    eq([statusOf(d, 'P'), enqueued.map((e) => e.type)], ['pending', ['resume-ai-task']],
      'C-1f ★★父任务经**既有** `checkParentTaskAfterChildDone` **真恢复** `pending` ∧ 入队 `resume-ai-task`（复用机制，不新增）');

    // —— 幂等：再跑一次⇒completed=0、无第二条事件（CAS changes=0）——
    const before = events.filter((e) => e.type === 'task.completed').length;
    const r2 = await driveRemoteSubtasks(d as unknown as never, deps as never);
    eq([r2.checked, r2.completed, events.filter((e) => e.type === 'task.completed').length],
      [0, 0, before],
      'C-2 ★幂等：已 `completed` 的子任务下拍不再被扫到（`checked=0`）⇒ 不重复 emit（CAS `changes=0` 即"已被别的路处理"）');

    // —— 反面标本 error（真失败如实置 failed，且**不静默恢复父**）——
    const de = dbBase(); enroll(de); addOccupied(de, 0);
    de.prepare("INSERT INTO wa_tasks (id,project_id,parent_task_id,title,status) VALUES ('P2',?, '', '父2', 'paused')").run(PROJ);
    addPending(de, 'C2', { title: '会失败的', parent: 'P2' });
    markRemoteAssigned(de as unknown as never, 'C2', { nodeId: 'n-peer', requestId: 'rq-2' }, iso(NOW_MS - 60_000));
    const evErr: string[] = [];
    const rErr = await driveRemoteSubtasks(de as unknown as never, {
      io: readIo(ansReq({ id: 'rq-2', status: 'error', result: { error: '远端真失败' } })),
      emit: (t: string) => { evErr.push(t); return true; },
      enqueue: async () => '', now: () => NOW_MS,
    } as never);
    eq([rErr.failed, statusOf(de, 'C2')], [1, 'failed'], 'C-3a ★`error` ⇒ 本地如实 `failed`（不假装完成）');
    ok(evErr.includes('task.failed'), 'C-3b ★`error` ⇒ emit `task.failed` 在册');
    eq(statusOf(de, 'P2'), 'paused', 'C-3c ★反面标本：有失败子 ⇒ 父**不静默恢复**（保持 paused，children-gate 自行处置）');

    // —— error ∧ 等作答 ⇒ 非终态，不动（与 refreshDispatchResult 同判据）——
    const dq = dbBase(); enroll(dq); addOccupied(dq, 0);
    addPending(dq, 'C3');
    markRemoteAssigned(dq as unknown as never, 'C3', { nodeId: 'n-peer', requestId: 'rq-3' }, iso(NOW_MS - 60_000));
    const rQ = await driveRemoteSubtasks(dq as unknown as never, {
      io: readIo(ansReq({ id: 'rq-3', status: 'error', question_status: 'asked', question: { question: '要中文吗？' } })),
      emit: () => true, enqueue: async () => '', now: () => NOW_MS,
    } as never);
    eq([rQ.failed, rQ.reclaimed, statusOf(dq, 'C3'), isRemoteAssigned(JSON.stringify(ctxOf(dq, 'C3')))],
      [0, 0, 'pending', true],
      'C-4 ★★`error ∧ asked` ⇒ **非终态**：仍 `pending` ∧ 归属键仍在（B 端在问，等作答——不误判死、不误收）');

    // —— 超时收回（知止：不无限等一个可能已死的对端）——
    const dt = dbBase(); enroll(dt); addOccupied(dt, 0);
    addPending(dt, 'C4');
    markRemoteAssigned(dt as unknown as never, 'C4', { nodeId: 'n-peer', requestId: 'rq-4' }, iso(NOW_MS - (REMOTE_ASSIGN_TIMEOUT_MS + 60_000)));
    const rT = await driveRemoteSubtasks(dt as unknown as never, {
      io: readIo(ansReq({ id: 'rq-4', status: 'assigned' })), // 仍非终态
      emit: () => true, enqueue: async () => '', now: () => NOW_MS,
    } as never);
    eq([rT.reclaimed, statusOf(dt, 'C4'), isRemoteAssigned(JSON.stringify(ctxOf(dt, 'C4')))],
      [1, 'pending', false],
      'C-5 ★★超时 ⇒ 撤归属退回 `pending`（三键已清 ⇒ 本地调度器自然接手）——不无限等');
    ok(notesOf(dt, 'C4').some((s) => s.includes('超时收回')),
      'C-5b ★超时留痕如实说明（"对端崩/断网/慢"＋已退回本机）');

    // —— 反面标本：未超时的非终态 ⇒ 不动（宁可多等一拍，不误收正在跑的远端活）——
    const dn = dbBase(); enroll(dn); addOccupied(dn, 0);
    addPending(dn, 'C5');
    markRemoteAssigned(dn as unknown as never, 'C5', { nodeId: 'n-peer', requestId: 'rq-5' }, iso(NOW_MS - 60_000));
    const rN = await driveRemoteSubtasks(dn as unknown as never, {
      io: readIo(ansReq({ id: 'rq-5', status: 'assigned' })), emit: () => true, enqueue: async () => '', now: () => NOW_MS,
    } as never);
    eq([rN.reclaimed, isRemoteAssigned(JSON.stringify(ctxOf(dn, 'C5')))], [0, true],
      'C-6 ★反面标本：未超时的 `assigned` ⇒ **不动**（`reclaimed=0`、归属键仍在）');
  }

  // ═══ D｜外派接线（四道闸 + 真派 + 写齐三键）════════════════════════════════════════
  console.log('\n【D】`driveOrchestration`：四闸各带反证 + 占满真派 3 件 + 写齐三键 + RMW');
  {
    const peers = [peer('n-peer')];

    // —— 闸①：mode 缺省 off ⇒ 不外派（反证：置 auto ⇒ 派）——
    const offDb = dbBase(); enroll(offDb, { role: 'primary' }); addOccupied(offDb, 3); addPending(offDb, 'd1', { title: '溢出件' });
    const offSub = fakeSubmit(() => ansReq({}));
    const offRes = await driveOrchestration(offDb as unknown as never, {
      io: offSub.io as never, emit: () => true, listPeers: async () => peers, readyTasks: () => [{ id: 'd1' }], now: () => NOW_MS,
    } as never);
    ok(offRes.note.startsWith('mode=off') && offSub.calls.length === 0,
      'D-1 ★★闸①：缺省 `off` ⇒ 不外派，且 `io.submit` **零调用**（真没派，不是"派了没记"）', offRes.note);

    // —— 闸②：未入网 ⇒ 不外派（反证：无凭据就别谈读回）——
    const neDb = dbBase(); addOccupied(neDb, 3); addPending(neDb, 'd1');
    set(neDb, NODE_SETTING_KEYS.orchestrateMode, 'auto'); // 开了编排，但**没**入网
    const neSub = fakeSubmit(() => ansReq({}));
    const neRes = await driveOrchestration(neDb as unknown as never, {
      io: neSub.io as never, emit: () => true, listPeers: async () => peers, readyTasks: () => [{ id: 'd1' }], now: () => NOW_MS,
    } as never);
    ok(neRes.note === 'not-enrolled' && neSub.calls.length === 0,
      'D-2 ★★闸②：未入网 ⇒ 不外派（`not-enrolled` ∧ 零调用——没有身份就没有读回凭据）', neRes.note);

    // —— 闸③：Team 软闸未开 ⇒ 不外派 ——
    const tgDb = dbBase(); enroll(tgDb, { mode: 'auto' }); addOccupied(tgDb, 3); addPending(tgDb, 'd1');
    const tgSub = fakeSubmit(() => ansReq({}));
    const tgRes = await driveOrchestration(tgDb as unknown as never, {
      io: tgSub.io as never, emit: () => true, listPeers: async () => peers, readyTasks: () => [{ id: 'd1' }],
      teamRefusal: () => '多机协同需 Team 档', now: () => NOW_MS,
    } as never);
    ok(tgRes.note.startsWith('team-gate') && tgSub.calls.length === 0,
      'D-3 ★★闸③：Team 软闸未开 ⇒ 不外派（`team-gate:` 前缀 ∧ 零调用）', tgRes.note);

    // —— 闸④：无在线可派对端 ⇒ 不外派（N3：免得造一张永远没人接的悬空单）——
    const npDb = dbBase(); enroll(npDb, { mode: 'auto' }); addOccupied(npDb, 3); addPending(npDb, 'd1');
    const npSub = fakeSubmit(() => ansReq({}));
    const npRes = await driveOrchestration(npDb as unknown as never, {
      io: npSub.io as never, emit: () => true, listPeers: async () => [], readyTasks: () => [{ id: 'd1' }],
      teamRefusal: () => null, now: () => NOW_MS, // 闸③放行 ⇒ 才走得到闸④
    } as never);
    ok(npRes.note === 'no-dispatchable-peer' && npSub.calls.length === 0,
      'D-4 ★★闸④（预查）：无可派对端 ⇒ 不外派（`no-dispatchable-peer` ∧ 零调用——不造悬空单）', npRes.note);

    // —— 放行标本：auto ∧ 入网 ∧ Team 开 ∧ 有对端 ∧ 并发占满 ⇒ 恰 3 件派出，写齐三键 ——
    const d = dbBase(); enroll(d, { mode: 'auto' }); addOccupied(d, 3); // limit=3, running=3 ⇒ available=0
    eq(PROJECT_CONCURRENCY_DEFAULT, 3, 'D-5a 前置：缺省项目并发上限＝3（占满需 3 件在跑）');
    addPending(d, 'd1', { title: '子任务一', description: '做甲', acceptance: '甲成' });
    addPending(d, 'd2', { title: '子任务二' });
    addPending(d, 'd3', { title: '子任务三' });
    addPending(d, 'd4', { title: '第四件（本拍不该派）' }, { });
    d.prepare("UPDATE wa_tasks SET context_json = '{\"keep\":\"v\"}' WHERE id = 'd1'").run();
    const sub = fakeSubmit((req) => ansReq({ id: `rq-${req.payload?.prompt}`, target_node_id: 'n-peer', status: 'assigned' }));
    const res = await driveOrchestration(d as unknown as never, {
      io: sub.io as never, emit: () => true, listPeers: async () => peers, teamRefusal: () => null,
      readyTasks: () => [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }, { id: 'd4' }], now: () => NOW_MS,
    } as never);
    eq([res.mode, res.peers, res.offloaded, res.note], ['auto', 1, 3, ''],
      'D-5b ★★放行标本：占满 ∧ 有对端 ⇒ **恰 3 件**派出（`ORCHESTRATE_OVERFLOW_PER_TICK`＝知止：不一拍倒光）');
    eq(sub.calls.length, 3, 'D-5c 真派 3 次（与 `offloaded` 一致——算了却不用＝摆设）');
    eq(sub.calls.every((c) => c.category === ORCHESTRATE_CATEGORY), true,
      'D-5d ★类目恒为 `project_task`（每台工蚁卡恒含，按余力/角色选目标——不凭空推类目）');
    const c1 = sub.calls[0]!;
    eq([c1.payload?.prompt, c1.payload?.acceptance_criteria], ['子任务一\n\n做甲', '甲成'],
      'D-5e ★载荷取标题+描述拼 prompt ∧ 验收标准**另存一栏**（不混进 prompt——B 端要能分辨"做什么"与"做到什么算数"）');
    const a1 = ctxOf(d, 'd1');
    eq([a1[REMOTE_ASSIGN_NODE_KEY], typeof a1[REMOTE_ASSIGN_REQUEST_KEY], typeof a1[REMOTE_ASSIGN_AT_KEY], a1.keep],
      ['n-peer', 'string', 'string', 'v'],
      'D-5f ★★`ok` 后写齐三键（正面读到 nodeId/requestId/assignedAt）∧ **RMW 保留兄弟键** `keep`');
    eq(isRemoteAssigned(JSON.stringify(ctxOf(d, 'd3'))), true, 'D-5g 三件皆已标外派（d2/d3 同形）');
    ok(!isRemoteAssigned(JSON.stringify(ctxOf(d, 'd4'))),
      'D-5h ★★第 4 件（未选中）**不写**归属键（有界：本拍只取前 N——`d4` 仍待本机/下拍）');

    // —— 反面标本：本机还有空位 ⇒ 不外派（跑得过来就不外派）——
    const dr = dbBase(); enroll(dr, { mode: 'auto' }); addOccupied(dr, 1); // available=2
    addPending(dr, 'r1'); addPending(dr, 'r2');
    const subR = fakeSubmit(() => ansReq({}));
    const resR = await driveOrchestration(dr as unknown as never, {
      io: subR.io as never, emit: () => true, listPeers: async () => peers, teamRefusal: () => null,
      readyTasks: () => [{ id: 'r1' }, { id: 'r2' }], now: () => NOW_MS,
    } as never);
    ok(resR.note === 'no-overflow' && subR.calls.length === 0,
      'D-6 ★★反面标本：本机还有空位（`available>0`）⇒ 不外派（`no-overflow` ∧ 零调用——知止：不自足者不外派）', resR.note);

    // —— `!ok`（提交抛）⇒ 不外派、**零归属键**（本地跑，不假装派了）——
    const df = dbBase(); enroll(df, { mode: 'auto' }); addOccupied(df, 3);
    addPending(df, 'f1'); addPending(df, 'f2'); addPending(df, 'f3');
    const subF = { calls: [] as NodeRequestSubmit[], io: { submit: async (r: NodeRequestSubmit) => { subF.calls.push(r); throw new Error('network down'); }, get: async () => { throw new Error('x'); }, answer: async () => { throw new Error('x'); } } };
    const resF = await driveOrchestration(df as unknown as never, {
      io: subF.io as never, emit: () => true, listPeers: async () => peers, teamRefusal: () => null,
      readyTasks: () => [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }], now: () => NOW_MS,
    } as never);
    eq([resF.offloaded, isRemoteAssigned(JSON.stringify(ctxOf(df, 'f1')))], [0, false],
      'D-7 ★★`!ok`（提交抛）⇒ **零归属键**（本地跑——派不出去就不假装派了）');
    ok(resF.note.startsWith('offload-failed'),
      'D-7b 如实回报"派了却没成"（`offload-failed (n)`——不静默）', resF.note);

    // —— 静态接线：装配同拍 + readyTasks 真源 ——
    const IDX = CODE(`${A}/src/main/index.ts`);
    ok(/void driveRemoteSubtasks\(driverDb, \{ io: dispatchIo \}\)/.test(IDX)
      && /void driveOrchestration\(driverDb, \{/.test(IDX),
      'D-8 ★装配：读回 driver 与左半场 orchestrator **同拍**（心跳 `onTick`，均不 await）');
    ok(/readyTasks: \(projectId\) => _scheduler\?\.getReadyTasks\(projectId\) \?\? \[\]/.test(IDX),
      'D-9 ★★`readyTasks` 真源＝调度器 `getReadyTasks`（就绪判据/排序与本地拉起**同一份**，不自写第二套 SQL）');
    ok(/listScannableProjectIds/.test(CODE(`${A}/src/main/core/orchestrator.ts`))
      && /projectScanVerdict/.test(CODE(`${A}/src/main/core/orchestrator.ts`)),
      'D-10 ★项目扫描面与调度器**同一判据** `projectScanVerdict`（本机不跑的项目不推给他机——不静默越权）');
  }

  // ═══ E｜开关词表与决策纯函数（知止：只在本机跑不过来时外派）════════════════════════
  console.log('\n【E】`readOrchestrateMode` 三态 + `planOffloads` 四格（纯函数直跑）');
  {
    eq([readOrchestrateMode(dbBase() as never), readOrchestrateMode((() => { const d = dbBase(); set(d, NODE_SETTING_KEYS.orchestrateMode, 'auto'); return d; })() as never), readOrchestrateMode((() => { const d = dbBase(); set(d, NODE_SETTING_KEYS.orchestrateMode, 'bogus'); return d; })() as never)],
      ['off', 'auto', 'off'],
      'E-1 ★未配 ⇒ off（不惊扰既有行为）；设 auto ⇒ auto；非法值 ⇒ 回落 off');

    const rdy = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
    eq([
      planOffloads({ ready: rdy, localOccupied: 3, available: 0, mode: 'off' }),                 // ① 未开 ⇒ 不外派
      planOffloads({ ready: rdy, localOccupied: 1, available: 2, mode: 'auto' }),                // ② 还有空位 ⇒ 不外派
      planOffloads({ ready: rdy, localOccupied: 0, available: 0, mode: 'auto' }),                // ③ 上限=0 误配 ⇒ 不外派
      planOffloads({ ready: rdy, localOccupied: 3, available: 0, mode: 'auto', maxPerTick: 0 }), // ④ 上限 0 ⇒ 不外派
    ], [[], [], [], []],
      'E-2 ★★四格穷举（该不派）：mode=off / 有空位 / 本机无在跑（排除"上限=0"误配）/ `maxPerTick<=0` ⇒ **皆不派**');
    eq(planOffloads({ ready: rdy, localOccupied: 3, available: 0, mode: 'auto' }), ['a', 'b', 'c'],
      'E-3 ★★该派标本：占满 ∧ 有在跑 ⇒ 取溢出前 N（`ORCHESTRATE_OVERFLOW_PER_TICK`＝3），**原序不变**（不自作主张重排）');
    eq(planOffloads({ ready: rdy, localOccupied: 3, available: 0, mode: 'auto', maxPerTick: 2 }), ['a', 'b'],
      'E-4 `maxPerTick` 覆盖生效（有界——改常量即改缺省，不写死）');
  }

  // ═══ F｜上屏与设置（词表第二个落点：renderer 不手抄 off/auto）══════════════════════════
  console.log('\n【F】上屏徽标词表 + 设置读写接线（main ↔ renderer 两处同形）');
  {
    // —— `orchestrationLabel` 纯函数：相位取自**本地子任务状态**（不读第二份"远端请求态"）＋ 节点名回落 ——
    const nameOf = (id: string) => (id === 'n-peer' ? '对端甲' : '');
    eq([
      orchestrationLabel({ nodeId: 'n-peer' }, 'pending', nameOf),     // 等待
      orchestrationLabel({ nodeId: 'n-peer' }, 'completed', nameOf),   // 完成
      orchestrationLabel({ nodeId: 'n-peer' }, 'failed', nameOf),      // 失败
      orchestrationLabel({ nodeId: 'n-unknown-node-xyz' }, 'pending', nameOf), // 主台账无此名 ⇒ 显 nodeId 前 8 位
      orchestrationLabel(null, 'pending', nameOf),                     // 非外派 ⇒ 空串
    ], ['已外派给 对端甲 · 等待', '已外派给 对端甲 · 完成', '已外派给 对端甲 · 失败', '已外派给 n-unknow · 等待', ''],
      'F-1 ★★四格穷举：相位词由**本地子任务状态**派生（等待/完成/失败）；取不到节点名 ⇒ 显 nodeId 前 8 位（不伪造节点名）；非外派 ⇒ 空串');
    eq(REMOTE_RESULT_CAVEAT, '远端自报完成，本机未复核',
      'F-2 ★N5 如实边界文案一处真源（徽标下钻共用——远端收口 ≠ 本机验收）');

    // —— renderer 词表落点 + 使用 ——
    const NV = CODE(`${A}/renderer/src/lib/node-view.ts`);
    ok(/export function orchestrationLabel/.test(NV) && /export const REMOTE_RESULT_CAVEAT/.test(NV),
      'F-3 词表具名导出在 `node-view.ts`（与 `isNodeOnline`/`canRemovePeer` 同处的第二落点）');
    const TDP = CODE(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
    ok(/orchestrationLabel\(c\.remote, c\.status, remoteNameOf\)/.test(TDP),
      'F-4 ★接线：任务详情子任务行渲染徽标经 `orchestrationLabel`（判据一处，非页面内联拼串）');
    ok(/\{REMOTE_RESULT_CAVEAT\}/.test(TDP) && /c\.remote\.summary/.test(TDP),
      'F-5 ★下钻块**真用** N5 边界文案 ∧ 显示远端摘要（命名即契约：写在屏上的就是断言的那句）');
    ok(/import \{ orchestrationLabel, REMOTE_RESULT_CAVEAT[^}]*\} from '\.\.\/lib\/node-view'/.test(RD(`${A}/renderer/src/pages/TaskDetailPage.tsx`)),
      'F-6 两处词表经 import 自 `node-view`（不在页面重抄"已外派给…"或"未复核"文案）');

    // —— Settings：词表由 main 下发，renderer 不手抄 off/auto ——
    const SET = CODE(`${A}/renderer/src/pages/SettingsPage.tsx`);
    ok(/nodesApi\.orchestrateMode\(\)/.test(SET) && /setOrchModes\(Array\.isArray\(r\.modes\)/.test(SET),
      'F-7 ★★设置页**从 main 取词表**（`r.modes`）——renderer 不手抄 `off`/`auto`（承"renderer 是词表第二落点"）');
    ok(/await nodesApi\.setOrchestrateMode\(mode\)/.test(SET) && /ORCH_LABEL\[m\] \?\? m/.test(SET),
      'F-8 ★写口真调 `setOrchestrateMode` ∧ 选项人话标签经 `ORCH_LABEL`（非把英文 key 直摆上屏）');
    ok(!/(const|let)\s+\w*STATUS\w*(Label|LABEL|Txt|TXT)\s*[:=]/.test(SET),
      'F-9 ★反证：设置页**无** `*STATUS*Label` 形状的表（不弄红 `rr_zx_20260930` 的 D-c-2 词表计数——命名避开）');

    // —— ipc 两处同形 ——
    const RIPC = CODE(`${A}/renderer/src/lib/ipc.ts`);
    ok(/orchestrateMode: \(\) => ipcCall<OrchestrateModePayload>\('nodes:orchestrate-mode'\)/.test(RIPC)
      && /setOrchestrateMode: \(mode: string\) => ipcCall<\{ mode: string \}>\('nodes:set-orchestrate-mode', \{ mode \}\)/.test(RIPC),
      'F-10 ★renderer `nodes.orchestrateMode/setOrchestrateMode` 指向 main 的两个通道名（对得上）');
    const NIPC = CODE(`${A}/src/main/ipc/nodes.ipc.ts`);
    ok(/ipcMain\.handle\('nodes:orchestrate-mode', \(\) => \{/.test(NIPC)
      && /return \{ data: \{ mode: readOrchestrateMode\(settingDb\), modes: ORCHESTRATE_MODES \} \}/.test(NIPC),
      'F-11 ★main 读口回 `{mode, modes}`（词表随读一并回传——一处真源）');
    ok(/if \(!isOrchestrateMode\(mode\)\) return \{ error: \{ code: 'INVALID'/.test(NIPC)
      && /writeNodeSetting\(settingDb, NODE_SETTING_KEYS\.orchestrateMode, mode\)/.test(NIPC)
      && /broadcastSetting\(NODE_SETTING_KEYS\.orchestrateMode, mode\)/.test(NIPC),
      'F-12 ★main 写口：非法值如实 `INVALID` ∧ 经 `NODE_SETTING_KEYS.orchestrateMode` 落库 ∧ `broadcastSetting` 热更');

    // —— tasks:children 投影同引 remoteTaskView（上屏与 driver 写口同一处真源）——
    const PIPC = CODE(`${A}/src/main/ipc/project.ipc.ts`);
    ok(/remoteTaskView\(r\.context_json/.test(PIPC) && /delete out\.context_json/.test(PIPC),
      'F-13 ★`tasks:children` 经 `remoteTaskView` 投影 ∧ 去掉原始 `context_json`（只把上屏用得到的给渲染层）');

    // —— driver 不再手抄回传键（写口引 node-orchestrate 常量）——
    const DRV = CODE(`${A}/src/main/core/node-remote-driver.ts`);
    ok(/\[REMOTE_RESULT_KEY\]: req\.result/.test(DRV) && /\[REMOTE_SUMMARY_KEY\]: summary/.test(DRV) && /\[REMOTE_RESULT_AT_KEY\]:/.test(DRV),
      'F-14 ★★driver 写口引回传三键常量（不手抄 `remote_result` 字面量——同一件事两个名字必有一处漂）');
    ok(/import \{[\s\S]*?REMOTE_RESULT_KEY[\s\S]*?\} from '\.\/node-orchestrate\.js'/.test(RD(`${A}/src/main/core/node-remote-driver.ts`)),
      'F-15 三键经 import 自一处真源 `node-orchestrate.ts`');
    // 失败收口走**唯一写手**（M6-A：`failed` 全树一个落笔口）——手写 SQL 即弄红 `rr_zx_20260923` M6-A。
    // 批五 M5 后此口**还须交出真因**（`reason: summary`，summary 取自远端回传的 summarizeResult）
    //   ——失败 IM 由 markTaskFailed 一处发，缺了因由那次失败就永远没有通知。
    ok(!/wa_tasks\s+SET\s+status\s*=\s*'failed'/.test(CODE(`${A}/src/main/core/node-remote-driver.ts`))
      && /const summary = summarizeResult\('error', req\.result\)/.test(CODE(`${A}/src/main/core/node-remote-driver.ts`))
      && /markTaskFailed\(db as unknown as TaskTerminalDb, taskId, \{ expectStatus: 'pending', reason: summary \}\)/.test(CODE(`${A}/src/main/core/node-remote-driver.ts`)),
      'F-16 ★★失败收口走**唯一写手** `markTaskFailed` 且**交出真因**（不手写 SQL；`reason` 取自远端回传 summarizeResult——承 M6-A「`failed` 只有一个写手」+ 批五「一处发」）');
  }

  // ═══ S｜哑雷自检 + build 钉（派生核对，不写轮次字面量）════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261011_4: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261011_4 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261011_4: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
