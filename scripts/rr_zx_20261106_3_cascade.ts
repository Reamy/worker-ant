/**
 * zx_20261106_3「协」B6 受控回归 —— 父任务失败后的级联收口。
 *
 * A 纯决策：仍在跑（非终态、非 paused）才收；本机/远端分流；终态与 paused 一支不动。
 * B 本机级联（真 `driveFailureCascades`）：父 failed ⇒ running/pending 子归档、孙辈一并收；
 *   已完成子不动；paused 子不动；兄弟 context 键保留；会话留下人话。
 * C 远端已确认：叫停回来 cancelled ⇒ 子归档 + 状态 confirmed；不再重复叫停。
 * D 远端未确认：叫停只发出（ANW 仍 assigned）⇒ 子**仍 pending**、状态 requested、下拍再试；
 *   下一拍确认 cancelled ⇒ 才归档。**未确认不写「已停止」。**
 * E 叫停失败（抛错/ok=false）：不归档，记 errors，下拍再试。
 * F 反证：父 completed / 父 failed 但子皆终态 ⇒ 一支不动。
 * G 幂等：同一父连跑两拍，第二拍零动作、不重复写会话。
 * H 静态接线：心跳拍真调 `driveFailureCascades`；归档只走 `archiveTask`；叫停只走 `cancelNodeRequest`；
 *   终态名单来自 `TERMINAL_STATUSES` 真源。
 *
 * 纪律：零网络 / 零 electron / 零墙钟（now 注入）；断言只做方向性与符号比较；不使用会干扰汇总器的失败字形。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AnsNodeRequest } from '../packages/shared-types/src/nodes.js';
import {
  CASCADE_ARCHIVE_REASON,
  PARENT_FAILURE_CASCADE_KEY,
  cascadeStateOf,
  driveFailureCascades,
  planFailureCascade,
  type CascadeChild,
  type FailureCascadeResult,
} from '../apps/worker-ant-desktop/src/main/core/task-failure-cascade.js';
import { TERMINAL_STATUSES, isTerminalStatus } from '../apps/worker-ant-desktop/src/main/core/task-jobs.js';
import { markRemoteAssigned, remoteAssignOf } from '../apps/worker-ant-desktop/src/main/core/node-orchestrate.js';
import { NODE_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/node-identity.js';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/* ── 夹具 ────────────────────────────────────────────────────────────────── */

const NOW = Date.parse('2026-11-06T00:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const PROJ = 'proj-cascade';

const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '', status TEXT DEFAULT 'active',
  context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, parent_task_id TEXT DEFAULT '', title TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0, acceptance_criteria TEXT DEFAULT '',
  depends_on TEXT DEFAULT '', context_json TEXT DEFAULT '{}', quality_score REAL,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL DEFAULT 'user', content TEXT DEFAULT '',
  token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT '', payload TEXT DEFAULT '{}', status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_type TEXT, aggregate_id TEXT, event_type TEXT, payload TEXT, occurred_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, file_path TEXT, created_at TEXT DEFAULT (datetime('now')));
`;

type AnyDb = import('better-sqlite3').Database;
const dbBase = (): AnyDb => {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  d.prepare("INSERT OR REPLACE INTO wa_projects (id,name,status,context_json) VALUES (?,?, 'active', '{}')").run(PROJ, '级联项目');
  // 叫停/归档路要过入网闸与设置读口——夹具按生产同形补上。
  const set = (k: string, v: string): void => {
    d.prepare("INSERT OR REPLACE INTO wa_settings (key,value,updated_at) VALUES (?,?,datetime('now'))").run(k, v);
  };
  set(NODE_SETTING_KEYS.id, 'n-self');
  set(NODE_SETTING_KEYS.resourceGroup, 'node:n-self');
  set(NODE_SETTING_KEYS.ansApiKey, 'wa_rr_enrolled_key');
  set(NODE_SETTING_KEYS.role, 'primary');
  return d as unknown as AnyDb;
};

function insertTask(
  d: AnyDb,
  id: string,
  over: { status?: string; parent?: string; ctx?: Record<string, unknown> } = {},
): void {
  d.prepare(`INSERT INTO wa_tasks (id,project_id,parent_task_id,title,status,context_json)
    VALUES (?,?,?,?,?,?)`)
    .run(id, PROJ, over.parent ?? '', id, over.status ?? 'pending', JSON.stringify(over.ctx ?? {}));
}
const statusOf = (d: AnyDb, id: string): string =>
  (d.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
const ctxOf = (d: AnyDb, id: string): Record<string, unknown> =>
  JSON.parse((d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}');
const notesOf = (d: AnyDb, id: string): string[] =>
  (d.prepare("SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'system' ORDER BY created_at, rowid").all(id) as Array<{ content: string }>)
    .map((r) => r.content);

function ansReq(over: Partial<AnsNodeRequest> = {}): AnsNodeRequest {
  return {
    id: 'rq-c1', category: 'project_task', payload: { prompt: '干活' },
    requester_key_prefix: 'ab12', requester_node_id: 'n-self', target_node_id: 'n-peer',
    status: 'assigned', result: null,
    question: null, answer: null, question_status: null,
    created_at: iso(NOW), claimed_at: null, done_at: null,
    ...over,
  };
}

/** 假叫停：按队列给出结局；记录每次被调用。 */
function cancelQueue(...outcomes: Array<AnsNodeRequest | Error | { ok: false; note: string }>): {
  calls: string[];
  fn: (requestId: string) => Promise<{ ok: boolean; request: AnsNodeRequest | null; note: string }>;
} {
  const calls: string[] = [];
  const fn = async (requestId: string) => {
    calls.push(requestId);
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    if (next && typeof next === 'object' && 'ok' in next && (next as { ok: boolean }).ok === false) {
      return { ok: false, request: null, note: (next as { note: string }).note };
    }
    return { ok: true, request: next as AnsNodeRequest, note: '' };
  };
  return { calls, fn };
}

async function tick(d: AnyDb, cancel?: (id: string) => Promise<{ ok: boolean; request: AnsNodeRequest | null; note: string }>): Promise<FailureCascadeResult> {
  return driveFailureCascades(d as unknown as never, {
    emit: () => true,
    now: () => NOW,
    ...(cancel ? { cancel } : {}),
  } as never);
}

/* ═══ A｜纯决策 ═════════════════════════════════════════════════════════════ */
function sectionA(): void {
  console.log('\n【A】纯决策：只收仍在跑的；终态与 paused 一支不动');
  const children: CascadeChild[] = [
    { id: 'local-run', status: 'running', remote: false },
    { id: 'local-pending', status: 'pending', remote: false },
    { id: 'remote-run', status: 'pending', remote: true },
    { id: 'done', status: 'completed', remote: false },
    { id: 'failed', status: 'failed', remote: false },
    { id: 'archived', status: 'archived', remote: true },
    { id: 'paused', status: 'paused', remote: false },
  ];
  const plan = planFailureCascade(children);
  eq(plan.localToArchive, ['local-run', 'local-pending'], 'A-1 本机仍在跑的进归档；终态/paused 不进');
  eq(plan.remoteToCancel, ['remote-run'], 'A-2 远端仍在跑的进叫停；远端终态不进');
  ok(isTerminalStatus('paused') === false, 'A-3 `paused` 不在终态名单里（它是"等人"，不是了结）');
  for (const s of TERMINAL_STATUSES) ok(!plan.localToArchive.includes(s) && !plan.remoteToCancel.includes(s), `A-4 终态 ${s} 不被级联`, '');
  eq(planFailureCascade([]), { localToArchive: [], remoteToCancel: [] }, 'A-5 空子集 ⇒ 空计划（不抛）');
}

/* ═══ B｜本机级联（真驱动）══════════════════════════════════════════════════ */
async function sectionB(): Promise<void> {
  console.log('\n【B】父 failed ⇒ 本机子任务归档（含孙辈）；已完成/暂停不动；兄弟键保留');
  const d = dbBase();
  insertTask(d, 'P', { status: 'failed' });
  insertTask(d, 'C-run', { parent: 'P', status: 'running', ctx: { keep_me: 'yes', attachment: { name: 'a.txt' } } });
  insertTask(d, 'C-todo', { parent: 'P', status: 'pending' });
  insertTask(d, 'G-run', { parent: 'C-run', status: 'running' });
  insertTask(d, 'C-done', { parent: 'P', status: 'completed' });
  insertTask(d, 'C-paused', { parent: 'P', status: 'paused' });

  const out = await tick(d);
  eq(out.roots, 1, 'B-1 识别到 1 个失败根');
  eq(out.checked, 3, 'B-2 仍在跑的后代 3 件（C-run/C-todo/G-run）');
  eq(out.localArchived, 3, 'B-3 三件本机子任务全部归档（含孙辈）');
  eq(statusOf(d, 'C-run'), 'archived', 'B-4 running 子任务归档');
  eq(statusOf(d, 'C-todo'), 'archived', 'B-5 pending 子任务归档');
  eq(statusOf(d, 'G-run'), 'archived', 'B-6 孙辈也归档（父失败后整棵子树都不会再被唤醒）');
  eq(statusOf(d, 'C-done'), 'completed', 'B-7 已完成子任务不动（反证）');
  eq(statusOf(d, 'C-paused'), 'paused', 'B-8 paused 子任务不动（等人处置，不越权）');

  const ctx = ctxOf(d, 'C-run');
  eq(ctx.keep_me, 'yes', 'B-9 兄弟键 `keep_me` 保留（合并写口，不整份覆写）');
  eq((ctx.attachment as { name: string }).name, 'a.txt', 'B-10 兄弟键 `attachment` 保留');
  eq(ctx.archive_reason, CASCADE_ARCHIVE_REASON, 'B-11 归档因由落 `archive_reason`');
  eq(CASCADE_ARCHIVE_REASON, 'parent_failed', 'B-12 因由值就是 `parent_failed`');
  ok(notesOf(d, 'C-run').some((n) => n.includes('父失败收口')), 'B-13 子任务会话留下人话证据');
}

/* ═══ C/D/E｜远端三态 ═════════════════════════════════════════════════════ */
async function sectionRemote(): Promise<void> {
  console.log('\n【C】远端叫停已确认 ⇒ 归档；【D】未确认 ⇒ 只记"已发出"；【E】叫停失败不谎称');

  // C：第一拍就 cancelled
  {
    const d = dbBase();
    insertTask(d, 'P', { status: 'failed' });
    insertTask(d, 'R', { parent: 'P', status: 'pending', ctx: { keep: 1 } });
    markRemoteAssigned(d as never, 'R', { nodeId: 'n-peer', requestId: 'rq-c1' }, iso(NOW));
    const c = cancelQueue(ansReq({ id: 'rq-c1', status: 'cancelled' }));
    const out = await tick(d, c.fn);
    eq(out.remoteCancelConfirmed, 1, 'C-1 确认叫停 1 件');
    eq(out.remoteCancelRequested, 0, 'C-2 没有"未确认"残留');
    eq(statusOf(d, 'R'), 'archived', 'C-3 确认后才归档');
    const st = cascadeStateOf((d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('R') as { context_json: string }).context_json);
    eq(st?.state, 'confirmed', 'C-4 级联状态记 confirmed');
    eq(ctxOf(d, 'R').keep, 1, 'C-5 兄弟键保留');
    eq(c.calls, ['rq-c1'], 'C-6 只叫停一次');
    eq(remoteAssignOf(JSON.stringify(ctxOf(d, 'R')))?.requestId, 'rq-c1', 'C-7 归档不动外派归属键（供复盘）');
  }

  // D：assigned ⇒ 不归档；下一拍 cancelled ⇒ 才归档
  {
    const d = dbBase();
    insertTask(d, 'P', { status: 'failed' });
    insertTask(d, 'R', { parent: 'P', status: 'pending' });
    markRemoteAssigned(d as never, 'R', { nodeId: 'n-peer', requestId: 'rq-d1' }, iso(NOW));
    const c = cancelQueue(
      ansReq({ id: 'rq-d1', status: 'assigned' }),
      ansReq({ id: 'rq-d1', status: 'cancelled' }),
    );
    const out1 = await tick(d, c.fn);
    eq(out1.remoteCancelRequested, 1, 'D-1 第一拍叫停已发出（未确认）');
    eq(statusOf(d, 'R'), 'pending', 'D-2 ★未确认 ⇒ 子任务仍是 pending（不写「已停止」）');
    const st1 = cascadeStateOf((d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('R') as { context_json: string }).context_json);
    eq(st1?.state, 'requested', 'D-3 级联状态 requested');
    ok((st1?.note ?? '').includes('assigned'), 'D-4 备注如实写远端当前状态');
    ok(!JSON.stringify(ctxOf(d, 'R')).includes('已停止'), 'D-5 ★账上没有任何「已停止」字样');

    const out2 = await tick(d, c.fn);
    eq(out2.remoteCancelConfirmed, 1, 'D-6 下一拍确认叫停');
    eq(statusOf(d, 'R'), 'archived', 'D-7 确认后才归档');
    eq(c.calls.length, 2, 'D-8 未确认 ⇒ 下拍重试（共两次）');
  }

  // E：抛错 / ok=false ⇒ 不归档
  {
    const d = dbBase();
    insertTask(d, 'P', { status: 'failed' });
    insertTask(d, 'R', { parent: 'P', status: 'pending' });
    markRemoteAssigned(d as never, 'R', { nodeId: 'n-peer', requestId: 'rq-e1' }, iso(NOW));
    const c = cancelQueue(new Error('network down'));
    const out = await tick(d, c.fn);
    eq(out.errors, 1, 'E-1 叫停失败记 errors');
    eq(statusOf(d, 'R'), 'pending', 'E-2 失败不归档（不把"发不出去"当"停了"）');
    const st = cascadeStateOf((d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('R') as { context_json: string }).context_json);
    eq(st?.state, 'requested', 'E-3 仍记 requested，下拍再试');
  }

  // E2：ok=false 同判
  {
    const d = dbBase();
    insertTask(d, 'P', { status: 'failed' });
    insertTask(d, 'R', { parent: 'P', status: 'pending' });
    markRemoteAssigned(d as never, 'R', { nodeId: 'n-peer', requestId: 'rq-e2' }, iso(NOW));
    const c = cancelQueue({ ok: false, note: 'not-enrolled' });
    const out = await tick(d, c.fn);
    eq(out.errors, 1, 'E-4 ok=false 也计 errors');
    eq(statusOf(d, 'R'), 'pending', 'E-5 未入网/读不回时不动子任务');
  }
}

/* ═══ F｜反证：父完成 / 子皆终态 ════════════════════════════════════════════ */
async function sectionF(): Promise<void> {
  console.log('\n【F】反证：父 completed ⇒ 一支不动；父 failed 但子皆终态 ⇒ 零动作');
  {
    const d = dbBase();
    insertTask(d, 'P-done', { status: 'completed' });
    insertTask(d, 'C-run', { parent: 'P-done', status: 'running' });
    const out = await tick(d);
    eq([out.roots, out.checked, out.localArchived], [0, 0, 0], 'F-1 父完成 ⇒ 不级联（收口由正常路径负责）');
    eq(statusOf(d, 'C-run'), 'running', 'F-2 子任务照常运行');
  }
  {
    const d = dbBase();
    insertTask(d, 'P', { status: 'failed' });
    insertTask(d, 'C1', { parent: 'P', status: 'completed' });
    insertTask(d, 'C2', { parent: 'P', status: 'archived' });
    insertTask(d, 'C3', { parent: 'P', status: 'failed' });
    const out = await tick(d);
    eq([out.roots, out.checked], [0, 0], 'F-3 子皆终态 ⇒ SQL 直接滤空（不空转）');
  }
}

/* ═══ G｜幂等 ═══════════════════════════════════════════════════════════════ */
async function sectionG(): Promise<void> {
  console.log('\n【G】幂等：连跑两拍，第二拍零动作、不重复写会话');
  const d = dbBase();
  insertTask(d, 'P', { status: 'failed' });
  insertTask(d, 'C', { parent: 'P', status: 'running' });
  const out1 = await tick(d);
  const notes1 = notesOf(d, 'C').length;
  const out2 = await tick(d);
  eq(out1.localArchived, 1, 'G-1 首拍归档 1 件');
  eq([out2.roots, out2.checked, out2.localArchived], [0, 0, 0], 'G-2 第二拍零动作');
  eq(notesOf(d, 'C').length, notes1, 'G-3 会话不重复追加');
}

/* ═══ H｜静态接线 ═══════════════════════════════════════════════════════════ */
function sectionH(): void {
  console.log('\n【H】静态接线：心跳真调 · 归档唯一写口 · 叫停唯一入口 · 终态真源');
  const MAIN = CODE(`${A}/src/main/index.ts`);
  ok(/import\('\.\/core\/task-failure-cascade\.js'\)/.test(MAIN), 'H-1 心跳运行体真引入级联模块');
  ok(/driveFailureCascades\(driverDb,\s*\{\s*io:\s*dispatchIo\s*\}\)/.test(MAIN), 'H-2 心跳拍真调 `driveFailureCascades`（不是"建了没用上"）');
  ok(MAIN.indexOf('driveRemoteSubtasks(') < MAIN.indexOf('driveFailureCascades('), 'H-3 先按远端真回传收口，再级联叫停（次序不反）');

  const SRC = CODE(`${A}/src/main/core/task-failure-cascade.ts`);
  ok(/archiveTask\(terminalDb/.test(SRC), 'H-4 归档只走唯一写入口 `archiveTask`（不手写 UPDATE status）');
  ok(/cancelNodeRequest\(db,\s*requestId/.test(SRC), 'H-5 远端叫停只走 `cancelNodeRequest`');
  ok(/TERMINAL_STATUSES/.test(SRC) && /'paused'/.test(SRC), 'H-6 跳过集合由终态真源 + paused 组成（不手抄状态名）');
  ok(!/UPDATE\s+wa_tasks\s+SET\s+status/i.test(SRC), 'H-7 模块内没有裸 SQL 改状态（状态只经 `archiveTask`）');
  ok(/PARENT_FAILURE_CASCADE_KEY/.test(SRC), 'H-8 级联状态写在 `context_json` 的具名键（可供界面解释）');
}

async function main(): Promise<void> {
  sectionA();
  await sectionB();
  await sectionRemote();
  await sectionF();
  await sectionG();
  sectionH();
  checkBuildPins(ok);
  console.log(`\n汇总：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

void main();
