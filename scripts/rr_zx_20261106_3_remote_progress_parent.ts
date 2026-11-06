/**
 * zx_20261106_3「协」B5 受控回归 —— 远端进度「看得见、不装活」＋ 父任务「等全部子」＋ 超时撤归属。
 *
 * A 新鲜度：阈值只认共享真源（两侧同读）；边界三态（阈值内新鲜 / 恰在阈值 / 超阈值陈旧）；
 *   坏时刻不判陈旧但也不画"刚刚"；无进度如实 `null`（不伪造 0%）。
 * B 人话投影：步数分母缺失不编分母；non-string note 不编；`remoteRunBadgeOf` 四格（未外派/外派未回/已回/无名回落前缀）。
 * C 父等全部子（真 `driveRemoteSubtasks`）：两件远端子，先回一件 ⇒ 父**仍暂停**、零入队；
 *   第二件回 ⇒ 父恢复 `pending` ∧ 恰一次 `resume-ai-task`；父已完成 ⇒ 一支不动（反证）。
 * D 三路终态：done 放行 / cancelled 归档并放行 / error 如实失败且父暂停因升级 `children_failed`；
 *   静态钉：驱动四个终态落脚处都走既有 `checkParentTaskAfterChildDone`（不新开第二套放行）。
 * E 超时撤归属：超上限 ⇒ 收回 `pending` + 三键清空；恰在上限 ⇒ 不动（严格大于；宁可多等一拍）。
 * F 静态接线：`task.remote_redispatched` 真转渲染层；列表摘录含七个远端键（键名由共享真源派生）；
 *   页面真用进度投影与徽标；阈值无第二份字面量。
 *
 * 纪律：零网络 / 零 electron / 零墙钟（now 注入）；断言只做方向性与符号比较；不使用会干扰汇总器的失败字形。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  REMOTE_PROGRESS_STALE_SEC,
  type AnsNodeRequest,
} from '../packages/shared-types/src/nodes.js';
import {
  isRemoteProgressStale,
  remoteProgressView,
  remoteRunBadgeOf,
} from '../apps/worker-ant-desktop/renderer/src/lib/node-view.js';
import {
  driveRemoteSubtasks,
  REMOTE_ASSIGN_TIMEOUT_MS,
  type DriveRemoteResult,
} from '../apps/worker-ant-desktop/src/main/core/node-remote-driver.js';
import {
  REMOTE_ASSIGN_AT_KEY,
  REMOTE_ASSIGN_NODE_KEY,
  REMOTE_ASSIGN_REQUEST_KEY,
  REMOTE_ATTEMPTS_KEY,
  REMOTE_CATEGORY_KEY,
  REMOTE_RESULT_AT_KEY,
  REMOTE_SUMMARY_KEY,
  isRemoteAssigned,
  markRemoteAssigned,
} from '../apps/worker-ant-desktop/src/main/core/node-orchestrate.js';
import { NODE_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/node-identity.js';
import { PAUSE_REASON_CHILDREN_FAILED } from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
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

/** 冻结基准时刻——判"新不新鲜/超没超时"不取墙钟。 */
const NOW = Date.parse('2026-11-06T00:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
/** 库内时间列形（UTC 且不带 Z，与 `datetime('now')` 同形）。 */
const dbTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

const PROJ = 'proj-collab';

/**
 * 夹具 schema —— 按生产 DDL 摘相关列（`quality_score` 是 `archiveTask`/`turnAccountPage` 真读的列，
 * 夹具漏掉会在 cancelled 路直接抛错，照不出收口真假）。
 */
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
  d.prepare("INSERT OR REPLACE INTO wa_projects (id,name,status,context_json) VALUES (?,?, 'active', '{}')").run(PROJ, '协同项目');
  // 读回门（`refreshDispatchResult`）先验入网：没有身份就没有凭据——夹具按生产同形补上。
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
/** 回执核对要求"本机台账有痕"——生产上派单即写事件；夹具照同形补一条。 */
const markLedger = (d: AnyDb, id: string): void => {
  d.prepare("INSERT INTO wa_event_log (aggregate_type, aggregate_id, event_type, payload) VALUES ('task',?,'node.dispatch','{}')").run(id);
};

function ansReq(over: Partial<AnsNodeRequest> = {}): AnsNodeRequest {
  return {
    id: 'rq-1', category: 'project_task', payload: { prompt: '干活' },
    requester_key_prefix: 'ab12', requester_node_id: 'n-self', target_node_id: 'n-peer',
    status: 'assigned', result: null,
    question: null, answer: null, question_status: null,
    created_at: iso(NOW), claimed_at: null, done_at: null,
    ...over,
  };
}

/** 按 requestId 分派的假 IO（一拍扫多件时各读各的）。 */
const ioOf = (byId: Record<string, AnsNodeRequest>) => ({
  submit: async () => { throw new Error('unused-submit'); },
  get: async (id: string) => {
    const r = byId[id];
    if (!r) throw new Error(`unknown request ${id}`);
    return r;
  },
  answer: async () => { throw new Error('unused-answer'); },
});

/** 走到终态的一拍。 */
async function tick(
  d: AnyDb,
  byId: Record<string, AnsNodeRequest>,
  enqueued: string[],
): Promise<DriveRemoteResult> {
  return driveRemoteSubtasks(d as unknown as never, {
    io: ioOf(byId),
    emit: () => true,
    enqueue: async (type: string) => { enqueued.push(type); return ''; },
    now: () => NOW,
  } as never);
}

/* ═══ A｜新鲜度与阈值（一个概念一个值）═══════════════════════════════════════ */
function sectionA(): void {
  console.log('\n【A】远端进度新鲜度：阈值共享真源 · 边界三态 · 坏时刻不装活');
  const staleMs = REMOTE_PROGRESS_STALE_SEC * 1000;
  ok(REMOTE_PROGRESS_STALE_SEC > 0, 'A-1 阈值是正数（由共享真源提供，不是页面里的魔法数字）');

  const atFresh = dbTime(NOW - (staleMs - 1000));
  const atBoundary = dbTime(NOW - staleMs);
  const atStale = dbTime(NOW - (staleMs + 1000));
  eq(
    [
      isRemoteProgressStale({ at: atFresh }, NOW),
      isRemoteProgressStale({ at: atBoundary }, NOW),
      isRemoteProgressStale({ at: atStale }, NOW),
    ],
    [false, false, true],
    'A-2 ★边界三态：阈值内 ⇒ 新鲜；**恰在阈值** ⇒ 仍新鲜（严格大于才陈）；超阈值 ⇒ 陈旧',
  );
  eq(
    [
      isRemoteProgressStale(null, NOW),
      isRemoteProgressStale(undefined, NOW),
      isRemoteProgressStale({ at: '不是时间' }, NOW),
    ],
    [false, false, false],
    'A-3 无时刻/坏时刻 ⇒ **不判陈旧**（"不知道"不等于"失联"；调用方另按 `ago` 如实说不知道）',
  );

  eq(remoteProgressView(null, NOW), null, 'A-4 对端尚未上报 ⇒ `null`（界面如实说"没有进度"，不画 0%）');
  eq(remoteProgressView(undefined, NOW), null, 'A-4b undefined 同 `null`（不留第二种"空"形状）');

  const withTotal = remoteProgressView({ step: 3, total: 5, note: '正在写文件', at: atFresh }, NOW);
  eq([withTotal?.stepText, withTotal?.note, withTotal?.stale], ['第 3/5 步', '正在写文件', false],
    'A-5 有分母 ⇒ "第 3/5 步"；摘要原样；新鲜 ⇒ 不标失联');

  const noTotal = remoteProgressView({ step: 3, total: null, note: '', at: atFresh }, NOW);
  eq([noTotal?.stepText, noTotal?.note], ['已走 3 步', ''],
    'A-6 ★未知分母 ⇒ 只报步数（不编 `/5`）；对端没说摘要 ⇒ 空串（不编）');

  const zeroTotal = remoteProgressView({ step: 0, total: 0, note: null as unknown as string, at: atStale }, NOW);
  eq([zeroTotal?.stepText, zeroTotal?.note, zeroTotal?.stale], ['已走 0 步', '', true],
    'A-7 `total<=0` 同"未知分母"；non-string note ⇒ 空串；超阈值 ⇒ 标陈旧（停更不装活）');

  const badAt = remoteProgressView({ step: 1, total: null, note: 'x', at: 'bad' }, NOW);
  eq(badAt?.ago, '—', 'A-8 坏时刻 ⇒ `ago` 如实 `—`（不说成"刚刚"）');

  const negStep = remoteProgressView({ step: -2 as number, total: null, note: '', at: atFresh }, NOW);
  eq(negStep?.stepText, '已走 0 步', 'A-9 负/坏步数收回 0（不把脏值直接印到界面）');
}

/* ═══ B｜任务行徽标（列表摘录的四个可能）═══════════════════════════════════ */
function sectionB(): void {
  console.log('\n【B】`remoteRunBadgeOf`：未外派 / 外派未回 / 已回 / 无名回落前缀');
  eq(remoteRunBadgeOf({}, () => '甲机'), null, 'B-1 未外派 ⇒ 不出徽标');
  eq(remoteRunBadgeOf(null, () => '甲机'), null, 'B-2 无上下文 ⇒ 不出徽标（不抛）');
  eq(remoteRunBadgeOf({ [REMOTE_ASSIGN_NODE_KEY]: 'n-alpha' }, (id) => (id === 'n-alpha' ? '甲机' : '')),
    { nodeId: 'n-alpha', label: '在 甲机 上运行' },
    'B-3 ★外派 ∧ 未回传 ⇒ 「在 X 上运行」（节点名取自节点表）');
  eq(remoteRunBadgeOf({ [REMOTE_ASSIGN_NODE_KEY]: 'n-alpha', [REMOTE_RESULT_AT_KEY]: iso(NOW) }, () => '甲机'),
    null,
    'B-4 ★已回传 ⇒ 不再说"正在运行"（`remote_result_at` 一到，徽标退场）');
  eq(remoteRunBadgeOf({ [REMOTE_ASSIGN_NODE_KEY]: '0123456789abcdef' }, undefined),
    { nodeId: '0123456789abcdef', label: '在 01234567 上运行' },
    'B-5 取不到节点名 ⇒ 显 nodeId 前 8 位（不伪造名字）');
  eq(remoteRunBadgeOf({ [REMOTE_ASSIGN_NODE_KEY]: '' }, () => '甲机'), null, 'B-6 空节点号 ⇒ 不算外派');
}

/* ═══ C｜父等全部子（真驱动）════════════════════════════════════════════════ */
async function sectionC(): Promise<void> {
  console.log('\n【C】父等全部远端子：先回一件不唤醒，全部终态才放行');
  {
    const d = dbBase();
    insertTask(d, 'P', { status: 'paused' });
    insertTask(d, 'c1', { parent: 'P' });
    insertTask(d, 'c2', { parent: 'P' });
    markRemoteAssigned(d as unknown as never, 'c1', { nodeId: 'n-peer', requestId: 'rq-1' }, iso(NOW));
    markRemoteAssigned(d as unknown as never, 'c2', { nodeId: 'n-peer', requestId: 'rq-2' }, iso(NOW));
    markLedger(d, 'c1'); markLedger(d, 'c2');

    const reqs: Record<string, AnsNodeRequest> = {
      'rq-1': ansReq({ id: 'rq-1', status: 'done', result: { taskId: 'c1', taskStatus: 'completed' } }),
      'rq-2': ansReq({ id: 'rq-2', status: 'assigned' }),
    };
    const enqueued: string[] = [];

    const r1 = await tick(d, reqs, enqueued);
    eq([r1.checked, r1.completed], [2, 1], 'C-1 首拍扫到两件、收口一件（另一件仍 assigned）');
    eq(statusOf(d, 'c1'), 'completed', 'C-2 先回的那件真 `completed`');
    eq(statusOf(d, 'P'), 'paused', 'C-3 ★★父**仍暂停**——还有兄弟在跑，不得提前收口');
    eq(enqueued, [], 'C-4 ★★零入队（没有提前唤醒父；计数器"不抛"不算，必须是 0）');

    reqs['rq-2'] = ansReq({ id: 'rq-2', status: 'done', result: { taskId: 'c2', taskStatus: 'completed' } });
    const r2 = await tick(d, reqs, enqueued);
    eq([r2.checked, r2.completed], [1, 1], 'C-5 第二拍只扫到剩下那件并收口');
    eq([statusOf(d, 'P'), enqueued], ['pending', ['resume-ai-task']],
      'C-6 ★★全部子终态 ⇒ 父恢复 `pending` ∧ **恰一次** `resume-ai-task`（复用既有放行口）');

    const r3 = await tick(d, reqs, enqueued);
    eq([r3.checked, enqueued.length], [0, 1], 'C-7 幂等：再拍无可扫，不重复唤醒父');
  }

  {
    // 反证：父已完成 ⇒ 子回传只收子，父一支不动。
    const d = dbBase();
    insertTask(d, 'P2', { status: 'completed' });
    insertTask(d, 'c9', { parent: 'P2' });
    markRemoteAssigned(d as unknown as never, 'c9', { nodeId: 'n-peer', requestId: 'rq-9' }, iso(NOW));
    markLedger(d, 'c9');
    const enqueued: string[] = [];
    const r = await tick(d, { 'rq-9': ansReq({ id: 'rq-9', status: 'done', result: { taskId: 'c9', taskStatus: 'completed' } }) }, enqueued);
    eq([r.completed, statusOf(d, 'c9'), statusOf(d, 'P2'), enqueued], [1, 'completed', 'completed', []],
      'C-8 ★反面标本：**父已完成** ⇒ 子照常收口，父状态与父侧入队**一支不动**');
  }
}

/* ═══ D｜三路终态（done 放行 / cancelled 归档 / error 失败）═════════════════ */
async function sectionD(): Promise<void> {
  console.log('\n【D】三路终态处置：cancelled 归档并放行 · error 如实失败并升级暂停因');
  {
    const d = dbBase();
    insertTask(d, 'PC', { status: 'paused' });
    insertTask(d, 'd1', { parent: 'PC' });
    markRemoteAssigned(d as unknown as never, 'd1', { nodeId: 'n-peer', requestId: 'rq-c' }, iso(NOW));
    const enqueued: string[] = [];
    const r = await tick(d, { 'rq-c': ansReq({ id: 'rq-c', status: 'cancelled', result: { summary: '用户叫停' } }) }, enqueued);
    eq([r.cancelled, statusOf(d, 'd1')], [1, 'archived'],
      'D-1 ★远端真停 ⇒ 本机子**归档**（既非完成也非失败——不冒认办成）');
    eq([statusOf(d, 'PC'), enqueued], ['pending', ['resume-ai-task']],
      'D-2 ★归档也是"了结" ⇒ 父照常放行（不因叫停把父永久挂住）');
    // 归档不清归属键（那是历史），"不再捞"由扫描面 `status='pending'` 挡住——两件事分开判。
    const r2 = await tick(d, { 'rq-c': ansReq({ id: 'rq-c', status: 'cancelled' }) }, enqueued);
    eq([r2.checked, statusOf(d, 'd1')], [0, 'archived'],
      'D-3 ★归档件下拍**不再被扫到**（扫描面只取 `pending`；归属键留作历史，不冒充"仍在跑"）');
  }

  {
    const d = dbBase();
    insertTask(d, 'PE', { status: 'paused' });
    insertTask(d, 'e1', { parent: 'PE' });
    markRemoteAssigned(d as unknown as never, 'e1', { nodeId: 'n-peer', requestId: 'rq-e' }, iso(NOW));
    markLedger(d, 'e1');
    const enqueued: string[] = [];
    const r = await tick(d, { 'rq-e': ansReq({ id: 'rq-e', status: 'error', result: { error: '远端真失败' } }) }, enqueued);
    eq([r.failed, statusOf(d, 'e1')], [1, 'failed'], 'D-4 ★error ⇒ 本地如实 `failed`');
    eq([statusOf(d, 'PE'), ctxOf(d, 'PE').pause_reason], ['paused', PAUSE_REASON_CHILDREN_FAILED],
      'D-5 ★★有失败子 ⇒ 父**保持暂停**且暂停因升级为 `children_failed`（不静默恢复；不把失败说成"子跑完就好"）');
    eq(enqueued, [], 'D-6 失败不放行：零入队');
  }

  console.log('\n【D2】静态钉：四个终态落脚处都走既有放行口（不新开第二套）');
  const DRIVER = CODE(`${A}/src/main/core/node-remote-driver.ts`);
  const calls = (DRIVER.match(/checkParentTaskAfterChildDone\(db, taskId, \{ enqueue \}\)/g) ?? []).length;
  eq(calls, 4,
    'D-7 ★★驱动里有 **4** 处终态落脚调用既有 `checkParentTaskAfterChildDone`：done / 回执不符 / cancelled / error'
    + '（新增终态分支必须同走这道口，否则父会挂死）');
  ok(/if \(req\.status === 'done'\)/.test(DRIVER) && /req\.status === 'cancelled'/.test(DRIVER)
    && /req\.status === 'error' && req\.question_status !== 'asked'/.test(DRIVER),
    'D-8 三路终态判据在册（done / cancelled / error∧非等作答）');
}

/* ═══ E｜超时撤归属（严格大于；宁可多等一拍）════════════════════════════════ */
async function sectionE(): Promise<void> {
  console.log('\n【E】超时撤归属：超上限才收，恰在上限不动');
  {
    const d = dbBase();
    insertTask(d, 't1');
    markRemoteAssigned(d as unknown as never, 't1', { nodeId: 'n-peer', requestId: 'rq-t' }, iso(NOW - (REMOTE_ASSIGN_TIMEOUT_MS + 60_000)));
    const enqueued: string[] = [];
    const r = await tick(d, { 'rq-t': ansReq({ id: 'rq-t', status: 'assigned' }) }, enqueued);
    eq([r.reclaimed, statusOf(d, 't1'), isRemoteAssigned(JSON.stringify(ctxOf(d, 't1')))], [1, 'pending', false],
      'E-1 ★超上限且仍非终态 ⇒ 撤归属退回 `pending`（三键清空，本地调度器自然接手）');
  }
  {
    const d = dbBase();
    insertTask(d, 't2');
    markRemoteAssigned(d as unknown as never, 't2', { nodeId: 'n-peer', requestId: 'rq-t2' }, iso(NOW - REMOTE_ASSIGN_TIMEOUT_MS));
    const enqueued: string[] = [];
    const r = await tick(d, { 'rq-t2': ansReq({ id: 'rq-t2', status: 'assigned' }) }, enqueued);
    eq([r.reclaimed, statusOf(d, 't2'), isRemoteAssigned(JSON.stringify(ctxOf(d, 't2')))], [0, 'pending', true],
      'E-2 ★边界标本：**恰在上限**不撤（严格大于；宁可多等一拍，不误收正在跑的远端活）');
  }
}

/* ═══ F｜静态接线（做得成，还得接得上）═════════════════════════════════════ */
async function sectionF(): Promise<void> {
  console.log('\n【F】接线：改派事件真转渲染层 · 列表摘录真带远端键 · 页面真用投影');
  const MAIN = CODE(`${A}/src/main/index.ts`);
  ok(/eventBus\.on\('task\.remote_redispatched'/.test(MAIN)
    && /forwardToRenderer\('task\.remote_redispatched'/.test(MAIN),
    'F-1 ★`task.remote_redispatched` 从事件总线**真转**渲染层（只 emit 不转，界面永远看不见改派）');

  const IPC = RD(`${A}/src/main/ipc/project.ipc.ts`);
  // zx_20261106_3 B8「协」: 摘录再补改派账与类目——协同看板要答「派过几次、每次给了谁、为何改派」。
  const keys = [
    REMOTE_ASSIGN_NODE_KEY, REMOTE_ASSIGN_REQUEST_KEY, REMOTE_ASSIGN_AT_KEY, REMOTE_RESULT_AT_KEY, REMOTE_SUMMARY_KEY,
    REMOTE_ATTEMPTS_KEY, REMOTE_CATEGORY_KEY,
  ];
  const missing = keys.filter((k) => !new RegExp(`'${k}',\\s*json_extract\\(t\\.context_json, '\\$\\.${k}'\\)`).test(IPC));
  eq(missing, [],
    'F-2 ★★列表摘录（`task:list` 的 `context_digest`）含七个远端键——键名由共享真源派生，不手抄'
    + '（少一个，任务行就说不出"在 X 上运行"/"已回传"/"改派过几次"）');

  const TASKS = CODE(`${A}/renderer/src/pages/TasksPage.tsx`);
  ok(/remoteRunBadgeOf\(/.test(TASKS) && /event\.type === 'task\.remote_redispatched'/.test(TASKS),
    'F-3 任务列表真用徽标投影 ∧ 真订阅改派事件（不是"加载了函数没挂上"）');

  const DETAIL = CODE(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  ok(/remoteProgressView\(/.test(DETAIL) && /nodes\.dispatchResult\(/.test(DETAIL),
    'F-4 任务详情真按 requestId 读回进度并用同一投影上屏');

  const VIEW = CODE(`${A}/renderer/src/lib/node-view.ts`);
  ok(/REMOTE_PROGRESS_STALE_SEC/.test(VIEW) && !/120\s*\*\s*1000/.test(VIEW),
    'F-5 ★阈值只有一处（`node-view` 引共享常量，**无** `120 * 1000` 第二份字面量）');
  const NODES_IPC = CODE(`${A}/src/main/ipc/nodes.ipc.ts`);
  ok(/ipcMain\.handle\('nodes:dispatch-result'/.test(NODES_IPC) && /refreshDispatchResult\(db, id\)/.test(NODES_IPC),
    'F-6 ★`nodes:dispatch-result` 在 main 侧**真读回**（进度缓存由读回刷新，不在渲染层自造）');
}

async function main(): Promise<void> {
  sectionA();
  sectionB();
  await sectionC();
  await sectionD();
  await sectionE();
  await sectionF();
  checkBuildPins(ok);
  console.log(`\n汇总：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

void main();
