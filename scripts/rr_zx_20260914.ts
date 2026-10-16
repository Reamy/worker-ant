/**
 * zx_20260914 受控复跑。六块：
 *   §S1–S4  M0.5-2「因等子而暂停，不算停摆」——解父/子互锁（本文件原始范围，见下）。
 *   §S5     M0.5-1 作业入队一处真源——17 处裸插改调 enqueueJob + 全仓防复发扫描。
 *   §S6     M0.5-3 自暂停须告知——两处「父等子而暂停」接 markPauseNeeded，且措辞如实（自愈≠需人工）。
 *   §S7–S13 **轮级收口段**（M4-2 追加）：build 派生一致性（§S7 派生化 / §S8 P1–P6 全绿 /
 *           §S9 字面量清零 + **哑雷专项**）、§S10 接线在册、§S11 基线归档在册、
 *           §S12 跨 M0.5–M3 整轮不变式、§S13 产物同源（本轮改动真被烧进 main 产物）。
 *
 * ⚠ §S8/§S13 读 `dist` ⇒ **tsup 必须先于本脚本**。顺序：改代码 → typecheck → tsup → renderer build → rr。
 *
 * M4-1 已刷 build 钉为 `zx_20260914`（**只改源码一处**；rr 侧由 `scripts/lib/rr-pins.ts` 派生核对）。
 * ⚠ 顺带订正一处**哑雷**：`rr_zx_20260913.ts` 原有一行 `eq(tag, 'zx_20260913', …)`——硬编码轮次字面量，
 *   `scanBuildPins` 的 PIN_RE 认不出它，故躲过 P5、只会在下一轮刷新后变红。已改为**由文件名派生**的
 *   单调守卫；§S9 增"哑雷专项"扫描防复发（见方案 M4 细化规划 订正3 与 §5.2 第 6 条）。
 *
 * ── M0.5-2 病根（真库实证，见任务 f07ad74a「20260914 功能优化规划」）──
 *
 * 病根（真库实证，见任务 f07ad74a「20260914 功能优化规划」）：
 *   收口/收尾发现子任务未完成时，执行器把父任务置 `paused` 等子完成（agent-executor.ts 两处）；
 *   而调度器 `scanReadyTasks` 对**祖先链含 paused** 的后继一律不拉起（A2，防「用户暂停后依赖链又自动执行」，
 *   task-scheduler.ts:chainStalled）。二者相遇即互锁：父因等子而暂停 ⇒ 子因父暂停而永不起 ⇒
 *   父等不到子完成而永不恢复。实证旁证：子任务作业 `7d850e29`(M0) 创建后 8 分钟 `started_at` 仍为空，
 *   6/6 子任务停在 pending、父停在 paused。
 *
 * 改法（一处真源）：暂停之「因」落库（`context_json.pause_reason`），调度器读它把
 *   「因等子任务而暂停」与「用户在停」分开——前者继续上溯不拦，后者照旧拦。
 *   判据只在 `core/pause-reason.ts` 一份；写点两处（收口/收尾）、清点一处（认领 CAS）。
 *
 * 断言两类（承 feedback「往返/闭环类判据须在生产入参上证」与「rr 夹具须按生产初始化顺序」）：
 *   ① 行为断言动态 import **真实现**——`isChildrenIncompletePause` 与 `TaskScheduler.chainStalled`
 *      （真类、真方法、真库），生产 SQL **从源码就地取出**再执行（生产 SQL × 生产夹具）；
 *   ② 每项修复点均附**反证**：旧判据（paused 一律停摆）喂同一夹具必红，证明断言真的抓得住。
 *
 * ⚠ 本文件不打开任何真库（真库只读实测见 data/baseline_zx_20260914.json）。
 * ⚠ 本批为热修，未纳入轮级 build 钉子（build 仍 zx_20260913；刷 zx_20260914 属方案 M4 收口）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  checkBuildPins, deriveBuildTag, scanBuildPins, listStrayPinLiterals, stripKeepingLines,
} from './lib/rr-pins.js';
import { engineSrc } from './lib/rr-engine-src.js';
import {
  PAUSE_REASON_CHILDREN_INCOMPLETE, isChildrenIncompletePause,
} from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
// zx_20260917 M1：暂停写口（唯一真源）——本脚本 §S2 就地调它验读写往返。
import { pauseTask } from '../apps/worker-ant-desktop/src/main/core/pause-task.js';
import { TaskScheduler } from '../apps/worker-ant-desktop/src/main/core/task-scheduler.js';
import { enqueueJob, setJobEnqueuer } from '../apps/worker-ant-desktop/src/main/core/job-enqueuer.js';
import { TOOL_METAS } from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';
import { buildTools } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';

let pass = 0; let fail = 0;
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

// 夹具 schema 按 database.ts DDL 摘取相关列（NOT NULL 照抄，防"夹具比生产宽松"的假绿）
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', parent_task_id TEXT DEFAULT '',
  title TEXT DEFAULT '', description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0,
  context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '', source TEXT DEFAULT 'test',
  acceptance_criteria TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, error TEXT,
  created_at TEXT DEFAULT (datetime('now')));
`;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };
const addTask = (db: AnyDb, id: string, status: string, parent = '', ctx: Record<string, unknown> = {}): void => {
  db.prepare('INSERT INTO wa_tasks (id, project_id, parent_task_id, title, status, depends_on, context_json) VALUES (?,?,?,?,?,\'\',?)')
    .run(id, 'p', parent, id, status, JSON.stringify(ctx));
};
const ctxOf = (db: AnyDb, id: string) => (db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json;
/** 真实现：真类 + 真私有方法（chainStalled 是 scanReadyTasks 的唯一停摆判据） */
const stalled = (db: AnyDb, id: string) => (new TaskScheduler(db) as unknown as { chainStalled: (t: string) => boolean }).chainStalled(id);

const aeSrc = stripComments(engineSrc());
const schedSrc = stripComments(RD(`${A}/src/main/core/task-scheduler.ts`));

// ── 生产写点（zx_20260917 M1 起）──
// 本节原先从 `agent-executor` 里"捞出"4 条裸 `UPDATE … SET status='paused', context_json=json_set(…)` 语句
// 再就地执行。M1 把这 24 处直写点收成一个语义化入口 `pauseTask`（`core/pause-task.ts`），**裸 SQL 全数退场**——
// 故取法随之改：不再捞散落语句（那种取法本身就是在给"散落"背书），改为核**唯一写入口本身**。
// 这比旧法更强：旧法数的是"散落点有几处"，新法钉的是"写口只有一处，且那一处必带因"。
const pauseWriter = stripComments(RD(`${A}/src/main/core/pause-task.ts`));
// 反证面：执行器内**不得**再有任何裸写（否则"唯一"二字是空话）
const AE_RAW_PAUSE_WRITES = aeSrc.match(/UPDATE wa_tasks SET status = 'paused'/g) || [];
// 认领清点：任务已认领（在跑）⇒ 该暂停已成过去（仍在 agent-executor，未随写口迁移）
const CLEAR_SQL = (aeSrc.match(/"UPDATE wa_tasks SET context_json = json_remove[^"]*"/) || [''])[0].slice(1, -1);
// 旧判据逐字复刻（仅用于反证：paused 一律停摆）
const oldChainStalled = (db: AnyDb, id: string): boolean => {
  const row = db.prepare('SELECT id, parent_task_id, status FROM wa_tasks WHERE id = ?').get(id) as { parent_task_id: string } | undefined;
  let cur: { parent_task_id: string; status: string } | undefined = row as never;
  while (cur?.parent_task_id) {
    cur = db.prepare('SELECT id, parent_task_id, status FROM wa_tasks WHERE id = ?').get(cur.parent_task_id) as never;
    if (!cur) break;
    if (['paused', 'failed', 'archived'].includes(cur.status)) return true;
  }
  return false;
};

console.log('\n【S1】暂停之因 · 真源模块行为');
eq(PAUSE_REASON_CHILDREN_INCOMPLETE, 'children_incomplete', '常量值即约定字面量（调度器/执行器共用一份）');
ok(isChildrenIncompletePause(JSON.stringify({ pause_reason: 'children_incomplete' })), '带因 ⇒ 是「等子而暂停」');
ok(!isChildrenIncompletePause(JSON.stringify({ pause_reason: 'goal_deviation_pause' })), '反证：别的暂停因不冒充等子');
ok(!isChildrenIncompletePause('{}'), '无因 ⇒ 否（用户在停走这一支）');
ok(!isChildrenIncompletePause(null) && !isChildrenIncompletePause(undefined), '空值 ⇒ 否，不抛');
ok(!isChildrenIncompletePause('not json'), '坏 JSON ⇒ 否（判据失败不拦截）');

console.log('\n【S2】写点/清点 · 生产 SQL × 生产夹具');
eq((pauseWriter.match(/UPDATE wa_tasks SET status = 'paused'/g) || []).length, 1,
  '唯一写入口 `pauseTask` 内恰 1 条置 paused 语句（写点由 24 处收成 1 处）');
ok(pauseWriter.includes('ctx.pause_reason = reason'),
  '该写入口必写 pause_reason（不靠事件旁证：事件是瞬时量；且 `reason` 为必填形参 ⇒ 无因暂停不可表达）');
eq(AE_RAW_PAUSE_WRITES.length, 0,
  `反证：agent-executor 内**零处**裸写 status='paused'（实测 ${AE_RAW_PAUSE_WRITES.length} 处）⇒「唯一」不是空话`);
ok(aeSrc.includes('extraContext: { run_mutations:'),
  'P0-1 新支经 `extraContext` 同写 run_mutations（诊断量，方案 §1.4(d) 明载非判据）');
ok(CLEAR_SQL.includes('json_remove') && CLEAR_SQL.includes('IS NOT NULL'), '认领清点 SQL 在册（且仅在真带因时才写）');
ok(schedSrc.includes("isChildrenIncompletePause("), '调度器消费该因（读点真的接上了，不是只写不读）');

{
  const db = mkdb();
  addTask(db, 'parent', 'paused', '', {});
  addTask(db, 'child', 'pending', 'parent', {});
  // 0 → 1：先证"未落库时读不到"，再执行生产 SQL 证"落库后读到"
  ok(!isChildrenIncompletePause(ctxOf(db, 'parent')), '落库前：读点为否（0 态）');
  // 就地调**生产写入口本尊**（不再复刻它的 SQL）：写口与读点的往返在生产入参上成立
  pauseTask(db, { taskId: 'parent', reason: PAUSE_REASON_CHILDREN_INCOMPLETE });
  ok(isChildrenIncompletePause(ctxOf(db, 'parent')), '落库后：读点为真（0→1 正面断言，非"不抛"）');
  db.prepare(CLEAR_SQL).run('parent');
  ok(!isChildrenIncompletePause(ctxOf(db, 'parent')), '认领清点后：因消失（1→0）');
}

console.log('\n【S3】chainStalled · 真类真方法（本轮修复点）');
{
  const db = mkdb();
  // 修好的一支：父因等子而暂停 ⇒ 后继应被拉起（不视为停摆）
  addTask(db, 'p1', 'paused', '', { pause_reason: 'children_incomplete' });
  addTask(db, 'c1', 'pending', 'p1');
  eq(stalled(db, 'c1'), false, '父「因等子而暂停」⇒ 后继**不**视为停摆（互锁解除）');
  // 反证：旧判据在同一夹具上必红
  eq(oldChainStalled(db, 'c1'), true, '反证：旧判据（paused 一律停摆）在同一夹具上返回 true ⇒ 断言抓得住');
}
{
  const db = mkdb();
  // A2 守则未被削弱：用户主动暂停（无因）仍拦
  addTask(db, 'p2', 'paused', '', {});
  addTask(db, 'c2', 'pending', 'p2');
  eq(stalled(db, 'c2'), true, '父「用户在停」（无因）⇒ 仍拦住（A2 原意不削弱）');
}
{
  const db = mkdb();
  // 豁免只在 paused，且须逐级上溯：近祖先豁免不放过远祖先
  addTask(db, 'gp', 'paused', '', {});
  addTask(db, 'p3', 'paused', 'gp', { pause_reason: 'children_incomplete' });
  addTask(db, 'c3', 'pending', 'p3');
  eq(stalled(db, 'c3'), true, '近祖先带因豁免，但远祖先在停 ⇒ 仍停摆（逐级上溯不短路）');
}
{
  const db = mkdb();
  // failed / archived 与因无关，照拦
  addTask(db, 'f1', 'failed', '', {});
  addTask(db, 'cf', 'pending', 'f1');
  eq(stalled(db, 'cf'), true, '祖先 failed ⇒ 停摆（带不带因都一样）');
  addTask(db, 'a1', 'archived', '', { pause_reason: 'children_incomplete' });
  addTask(db, 'ca', 'pending', 'a1');
  eq(stalled(db, 'ca'), true, '祖先 archived ⇒ 停摆（因不豁免终态）');
}
{
  const db = mkdb();
  // 非暂停祖先 / 无祖先：不因本次改动而变
  addTask(db, 'r1', 'executing', '', { pause_reason: 'children_incomplete' });
  addTask(db, 'cr', 'pending', 'r1');
  eq(stalled(db, 'cr'), false, '祖先在跑（非暂停）⇒ 不拦（行为不变）');
  addTask(db, 'top', 'pending', '');
  eq(stalled(db, 'top'), false, '顶层任务无祖先 ⇒ 不停摆（行为不变）');
}

console.log('\n【S4】夹具同生产初始化顺序（防"夹具比生产宽松"的假绿）');
{
  // chainStalled 走的是裸 SELECT，无触发器/FTS 依赖；此处如实记"无顺序敏感项"，
  // 但正面断言一次真库读点，证明方法确实读到了库（而非被 catch 吞掉恒返回 false）。
  const db = mkdb();
  addTask(db, 'x', 'pending', '');
  const s = new TaskScheduler(db) as unknown as { chainStalled: (t: string) => boolean };
  eq(s.chainStalled('不存在的任务'), false, '查不到的行 ⇒ false（且不抛）');
  eq(s.chainStalled('x'), false, '查得到的顶层行 ⇒ false（真读到库，非恒真/恒假）');
}

console.log('\n【S5】作业入队一处真源（M0.5-1）');
// 病根：内存队列 `TaskScheduler.pending` 只由 enqueue()（写库**并**入内存）与启动恢复 start()
// （**只在进程启动时读一次库**）填充 ⇒ 任何绕过 enqueue 的裸插作业在**运行期一律不被消费**，
// 要等下次重启才被看见（"IM 回了『已启动』、作业却躺着不动"、"自恢复一轮其实跑不起来"）。
// 本节就把这个病根**用真类直接证出来**，再证修复后的 enqueueJob 两条路径都对。

// ── ① 缺陷本体：真类真方法证"裸插不入内存队列" ──
{
  const db = mkdb();
  const s = new TaskScheduler(db) as unknown as {
    pending: Map<string, unknown>;
    enqueue: (t: string, p: Record<string, unknown>) => Promise<string>;
  };
  eq(s.pending.size, 0, '起步：调度器内存队列为空（0 态）');
  // enqueue 虽是 async，体内**无 await**（写库 + 入内存同步完成），故此处不 await 也不会漏断言；
  // 若将来其体内出现 await，本组断言会红——那正是提醒"这里是交错点"。
  void s.enqueue('ai-task', { taskId: 'q1' });
  eq(s.pending.size, 1, 'enqueue ⇒ 入内存队列（0→1 正向断言）');
  db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES (?, 'ai-task', ?, 'pending')")
    .run('raw-1', JSON.stringify({ taskId: 'q2' }));
  eq((db.prepare('SELECT count(*) AS c FROM wa_jobs').get() as { c: number }).c, 2, '裸插确实落库（库里共 2 行）');
  eq(s.pending.size, 1, '反证：裸插**不入**内存队列（size 仍为 1，非 2）⇒ 断言真的抓得住缺陷本体');
}

// ── ② 未注入 ⇒ 兜底裸插（0→1 正面断言 + payload 逐字保真）──
{
  const db = mkdb();
  setJobEnqueuer(null);
  enqueueJob(db, 'ai-task', { taskId: 'f1', projectId: 'p', source: 'x' });
  const r = db.prepare('SELECT type, payload, status FROM wa_jobs').get() as { type: string; payload: string; status: string };
  eq([r.type, r.status], ['ai-task', 'pending'], '未注入 ⇒ 兜底裸插，type/status 正确');
  eq(JSON.parse(r.payload), { taskId: 'f1', projectId: 'p', source: 'x' }, '兜底裸插 payload 逐字保真（不丢字段、不改名）');
}

// ── ③ 已注入 ⇒ 恰好调用一次 enqueuer，且**自身不写库**（防双写）──
{
  const db = mkdb();
  const calls: Array<[string, Record<string, unknown>]> = [];
  setJobEnqueuer((t, p) => { calls.push([t, p]); });
  enqueueJob(db, 'resume-ai-task', { taskId: 'f2', message: 'm' });
  eq(calls.length, 1, '已注入 ⇒ 恰好调用 enqueuer 一次（0→1 正向断言）');
  eq(calls[0], ['resume-ai-task', { taskId: 'f2', message: 'm' }], '注入路径 type/payload 逐字保真');
  eq((db.prepare('SELECT count(*) AS c FROM wa_jobs').get() as { c: number }).c, 0, '注入路径**自身不写库**（写库交由 scheduler.enqueue）⇒ 不会双写作业');
  // 入队失败不得冒泡：IM 已回"已启动"，不能因入队异常把回话链路打断
  setJobEnqueuer(() => { throw new Error('boom'); });
  let threw = false;
  try { enqueueJob(db, 'ai-task', { taskId: 'f3' }); } catch { threw = true; }
  ok(!threw, 'enqueuer 抛出 ⇒ 不冒泡到调用方（回话链路不因入队失败而中断）');
  setJobEnqueuer(null);
}

// ── ④ 防复发：全仓 src/main 扫裸插，白名单外即失败 ──
// 该缺陷已被修过三次（zx_20260907 M5 / zx_20260908 实机复核 / zx_20260909 Z1），
// 每次只修一处、余者仍在。故此处把"裸插只许出现在白名单"变成判据，防第 4 次复发。
const MAIN = path.join(root, A, 'src/main');
const walkTs = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walkTs(path.join(d, e.name)) : (e.name.endsWith('.ts') ? [path.join(d, e.name)] : []));
type RawHit = { rel: string; n: number };
// 白名单（各有其存在的理由，非"漏网"）：
//   task-scheduler.ts —— enqueue/schedule/start 自身的实现，就是正确侧
//     （zx_20260930 M11-4：原名单里的 `batchEnqueue` 已删——全仓零调用方，"注释说有、代码零调用"。
//      计数随之 4→3；**是生产先减一处、判据跟着减**，不是判据放宽。）
//   job-enqueuer.ts   —— 未注入时的兜底裸插（本处真源）
//   project.ipc.ts    —— 既有两处 enqueuer 的兜底（zx_20260907 M5 修时留下的正确范式）
const RAW_WHITELIST = ['core/task-scheduler.ts', 'core/job-enqueuer.ts', 'ipc/project.ipc.ts'];
const rawCount = (rel: string): number =>
  (stripComments(fs.readFileSync(path.join(MAIN, rel), 'utf-8')).match(/INSERT INTO wa_jobs/gi) || []).length;
const offenders = (hits: RawHit[]): RawHit[] => hits.filter((h) => !RAW_WHITELIST.includes(h.rel));
{
  const hits: RawHit[] = walkTs(MAIN)
    .map((f) => ({ rel: path.relative(MAIN, f).split(path.sep).join('/'), n: (stripComments(fs.readFileSync(f, 'utf-8')).match(/INSERT INTO wa_jobs/gi) || []).length }))
    .filter((h) => h.n > 0);
  eq(offenders(hits), [], `白名单外**无**裸插（实测扫描面 ${walkTs(MAIN).length} 个 .ts 文件）`);
  // 反证：若新增一处裸插，判据必须抓住（否则本断言只是"扫描面为空"的假绿）
  eq(offenders([{ rel: 'core/some-new-feature.ts', n: 1 }]), [{ rel: 'core/some-new-feature.ts', n: 1 }], '反证：白名单外的裸插会被判据抓住');

  // 白名单内计数钉死（多了说明有人往调度器/兜底里塞新裸插，须人工过目）
  eq(rawCount('core/task-scheduler.ts'), 3, 'task-scheduler.ts 裸插恰 3 处（enqueue/schedule/start；zx_20260930 M11-4 删 batchEnqueue 后 4→3）');
  eq(rawCount('core/job-enqueuer.ts'), 1, 'job-enqueuer.ts 裸插恰 1 处（唯一兜底）');
  eq(rawCount('ipc/project.ipc.ts'), 3, 'project.ipc.ts 裸插恰 3 处（既有两处 enqueuer 的兜底）');

  // 17 处调用点：已全部改为 enqueueJob，裸插归零
  eq(rawCount('core/agent-executor.ts'), 0, 'agent-executor.ts 裸插 0 处（原 8 处已改调 enqueueJob）');
  eq(rawCount('services/im-router.ts'), 0, 'im-router.ts 裸插 0 处（原 8 处已改调 enqueueJob）');
  eq(rawCount('index.ts'), 0, 'index.ts 裸插 0 处（原 cron 1 处已改调 enqueueJob）');
  // zx_20260920_1 M1 就地订正：原属 `agent-executor.ts` 的那 8 处随工具实现搬进了 `core/tools/*.ts`。
  // 计数口径随之改为「**执行体 ∪ 工具模块** + im-router + index」——仍要求**恰 17 次**（8+8+1）：
  // 搬迁只改落点、不改次数，数字对得上才说明"没有人在搬家路上把某处悄悄丢了或写重了"。
  const callSites = ['services/im-router.ts', 'index.ts']
    .reduce((n, rel) => n + (stripComments(fs.readFileSync(path.join(MAIN, rel), 'utf-8')).match(/enqueueJob\(/g) || []).length,
      (stripComments(engineSrc()).match(/enqueueJob\(/g) || []).length);
  eq(callSites, 17, `三处调用点合计 enqueueJob 恰 17 次（8+8+1，与方案清点一致）`);
  // 注入点：index.ts 必须真的把 scheduler.enqueue 接上去（只写不注入 ⇒ 全走兜底，等于没修）
  const idx = stripComments(fs.readFileSync(path.join(MAIN, 'index.ts'), 'utf-8'));
  // 判据须容忍箭头函数自身的括号：实际入参是 `((type, payload) => scheduler.enqueue(...))`，
  // `[^)]*` 会在 `(type, payload)` 的右括号处截断 ⇒ 断言假红（是本断言写错，非生产码错）。
  ok(/setJobEnqueuer\([\s\S]{0,200}?scheduler\.enqueue/.test(idx),
    'index.ts 注入 setJobEnqueuer(... scheduler.enqueue)（注入真的接上了，不是只定义）');
}

// ══════════════════════════════════════════════════════════════════
console.log('\n【S6】M0.5-3 自暂停须告知（父等子而暂停，此前独此一路静默）');
{
  // 定位两处「父等子而暂停」分支体：从各自的未完成子查询起，到各自的 logger.warn 止。
  // 扫描面 = 这两个分支体本身（断言名须=扫描面，不让别处的同名字符串充当证据）。
  const branch = (q: string, warnMarker: string): string => {
    const s = aeSrc.indexOf(q);
    const w = aeSrc.indexOf(warnMarker, s);
    return s >= 0 && w > s ? aeSrc.slice(s, w + warnMarker.length) : '';
  };
  const b1 = branch('const unfinishedForFinalize = db.prepare(', 'finalize 收口前有未完成子任务，改置 paused 不标完成');
  // zx_20261013_2 批二：`unfinishedAtClose` 的 SQL 已收归 `children-gate.ts` 一处真源（`unfinishedChildren`），
  //   与 `exec-close.ts` 的 `prematureEnd` 闸同尺。锚点据此由「内联 SQL 字面」改钉**更强**的「绑共享实现」
  //   （按符号、不按字面；承 `feedback_retarget_assertions_to_stronger_source`——只钉更强的形状，不放宽）。
  const b2 = branch('const unfinishedAtClose =', 'run_close 前有未完成子任务，改置 paused 不标完成');
  ok(b1.length > 0 && b2.length > 0, '两处「父等子而暂停」分支体均已定位（finalize 收口闸 / run_close 闸）');
  ok(b2.includes('unfinishedChildren(db, taskId)'),
    'b2 改钉更强真源：run_close 闸的「未完成子」谓词绑**共享实现** `unfinishedChildren`（一处真源，防两处各判一遍而分家）');

  // zx_20260917 M1：告知动作随写口一并迁入 `pauseTask`——分支侧的表达变成"`pauseTask(... note: … )`"。
  //   判据实质未变（**该分支是否带了人话因由**），故改钉 `note:`（`note` 传即告知，见 pause-task.ts 头注释）。
  const isSilent = (b: string): boolean => !/(^|[^A-Za-z0-9_])note:/.test(b);
  ok(!isSilent(b1) && !isSilent(b2), '两处分支均已告知创建人（此前静默——用户只能自己去 GUI 翻，f07ad74a 实机即如此）');
  // 反证：把 note 实参摘掉，同一判据必须判为静默（否则本断言只是"全文里出现过某字符串"的假绿）
  const stripNote = (b: string) => b.replace(/,\s*note:\s*`[^`]*`/g, '');
  eq([isSilent(stripNote(b1)), isSilent(stripNote(b2))], [true, true],
    '反证：摘掉 `note` 实参后同判据判为静默 ⇒ 判据真的抓得住"静默暂停"');

  // 措辞如实：这是**自愈**暂停（子任务完成即自动恢复），不是要人介入——不得说成"需人工/待人工"。
  for (const [name, b] of [['finalize 收口闸', b1], ['run_close 闸', b2]] as const) {
    const msg = (b.match(/note:\s*`([^`]*)`/) || [])[1] || '';
    ok(msg.includes('非故障') && msg.includes('自动恢复'), `${name}：理由含「非故障」「自动恢复」（自愈暂停，不谎称需人工）`, `实测「${msg}」`);
    ok(!/需人工|待人工/.test(msg), `${name}：理由**不**含「需人工/待人工」（与那 6 个真介入暂停划清，不冒充）`);
  }

  // 顺序：须**先置 paused 再告知**——否则用户收到消息时状态还是旧的（"说已暂停而其实还在跑"）。
  //   收口写入口后此序由**结构保证**（写口内部先落库再 `markPauseNeeded`），比"分支里两行的先后"更强。
  const beforeNotify = (b: string): boolean => { const p = b.indexOf('pauseTask(db, {'); return p >= 0 && p < b.indexOf('note:'); };
  ok(beforeNotify(b1) && beforeNotify(b2), '两处都是**先置 paused、后告知**（消息到达时状态已一致）');
  // zx_20261012_2 批五 M5 重定向：`note` 之外新增一条**自带因由**的兜底（`policy_paused`），
  //   故判据的那一跳由 `if (note)` 变为 `if (effectiveNote)`。窗口相应略放宽（仍**只**用以证"UPDATE 在前、
  //   告知在后"这一条序——本文件 `markPauseNeeded(` 无第二处，窗口大小不是判据的松紧所在）。
  ok(/UPDATE wa_tasks SET status = 'paused'[\s\S]{0,800}?markPauseNeeded\(db, taskId, effectiveNote\)/.test(pauseWriter),
    '写口内部同序：先 UPDATE 落库、后 markPauseNeeded（调用方不可能写反这个序）');

  // 与那 6 个介入暂停同尺：走同一条通告通道（不新造第二条），且不吞掉暂停主流程。
  ok(!/pushImNotify|sendImNotification|sendImCompletionNotice/.test(b1 + b2), '两处只经 pauseTask 一处通道（不新造第二条通告路）');
  ok(pauseWriter.includes("import { markPauseNeeded } from './im/im-notify.js'"), '写口经既有通道告知（agent-executor 不再直接依赖通知模块）');
}

// ══════════════════════════════════════════════════════════════════
// 以下为 **轮级收口段**（§S7–§S13，zx_20260914 M4-2 追加）。
// 上方 §S1–§S6 是本文件原始范围（M0.5 热修批）；此处不复述 M1/M2/M3 的逐项断言
// （在 rr_zx_20260914_1.._3.ts 各自的断言里），只做轮级四件事：build 派生一致性、
// 基线在册、跨批不变式、产物同源。
// ⚠ §S8/§S13 读 `dist` ⇒ **tsup 必须先于本脚本**；§S13 亦读 renderer 产物的兄弟项 →
//   顺序：改代码 → typecheck → tsup → renderer build → rr。
// ══════════════════════════════════════════════════════════════════
const SCRIPTS = path.join(root, 'scripts');
const PLANS = path.join(root, 'plans/improve');
const SRC = path.join(root, `${A}/src/main/core/agent-executor.ts`);
const DIST = path.join(root, `${A}/dist`);
const realSrc = engineSrc();
const { tag } = deriveBuildTag(realSrc);
// 夹具字面量刻意经 q() 拼接：夹具是**数据**，不是扫描器要核的"钉子"。
// 直接写死会让本脚本自身被扫成"残留钉子"（§S9 必红）——这是"扫全量"的必然代价，如实处理，不为此放宽扫描面。
const q = (s: string) => "'" + s + "'";
/** 本脚本轮次**由文件名派生**（不写字面量——写了就是给下一轮设哑雷，见 §S9）。 */
const thisRound = (path.basename(__filename).match(/^rr_(zx_\d{8}(?:_\d+)?)/) || [])[1] || '';

/** 收集式 ok：把 checkBuildPins 的播报收进内存，供"点名某一条判据"用。 */
function collect(): { rec: Array<{ cond: boolean; label: string; detail: string }>; sink: (c: boolean, l: string, d?: string) => void } {
  const rec: Array<{ cond: boolean; label: string; detail: string }> = [];
  return { rec, sink: (cond, label, detail) => { rec.push({ cond, label, detail: detail ?? '' }); } };
}

// ══════════════════════════════════════════════════════════════════
console.log('\n【S7】派生化：真源码单一真源 + 纪律注记在册');
{
  const d = deriveBuildTag(realSrc);
  ok(d.count === 1 && d.tag === tag, `真源码 build 轮次标识恰好 1 处（${d.tag}）`, `count=${d.count}`);
  ok(realSrc.includes('rr 侧**不再手抄本行值**'), '源码写值处仍带「rr 侧不再手抄本行值」纪律注记（承 0912 M5，勿删）');
  // 判据**由文件名派生**：真源标签只许不早于本脚本轮次 —— 刷新后同轮成立，后续轮次仍成立，永不随轮停更。
  // zx_20260922 收口：原为 `thisRound === 'zx_20260914'`，与标签「不写字面量」自相矛盾（同 0913 那处）；
  //   下一行的 `tag >= thisRound` 已把该证的事证全，此处只证"派生成功"。
  ok(thisRound.length > 0 && thisRound.startsWith('zx_'), '本脚本轮次由文件名派生成功（判据内不写轮次字面量）', thisRound);
  ok(tag >= thisRound, `真源标签 ${tag} 不早于本脚本轮次 ${thisRound}（M4 已刷新）`);
  eq(deriveBuildTag(`const a = { build: ${q('zx_19000101')} };\nconst b = { build: ${q('zx_20000202')} };\n`).count, 2,
    '反证：人造"陈旧第二值"源 → count=2 ⇒ 计数判据非空转');
}

// ══════════════════════════════════════════════════════════════════
console.log('\n【S8】全量现状：P1–P6 全绿（含产物同值）');
{
  const { rec, sink } = collect();
  checkBuildPins(sink, { distDir: DIST });
  eq(rec.length, 8, 'P1–P6 共 8 条判据在册');
  ok(rec.every((r) => r.cond), 'P1–P6 全绿', rec.filter((r) => !r.cond).map((r) => `${r.label}：${r.detail}`).join('｜'));
  ok(rec.some((r) => r.label.includes('产物内 build 值与源码同值')), '其中含"产物 build 值与源码同值"（真源已烧进产物）');
  ok(rec.some((r) => r.label.includes('复跑脚本在册')), '其中含"复跑脚本在册"（P4：本文件自身即其凭据）');
  ok(rec.some((r) => r.label.includes(`方案在册：plans/improve/${tag}.md`)), `其中含"方案在册"（P3：${tag}.md）`);
}

// ══════════════════════════════════════════════════════════════════
console.log('\n【S9】字面量清零 + 哑雷专项（订正3 的病根）');
{
  // ① 承 0913 的字面量清零：`scanBuildPins` 认得的钉形已全部消除。
  eq(listStrayPinLiterals(SCRIPTS, ['rr_zx_20260909_fixes.ts'], root), [],
    '除历史负钉外，rr 脚本无任何 build 轮次字面量（开新轮只改源码一处）');
  const allPins = scanBuildPins(SCRIPTS, root);
  eq(allPins.length, 1, '全量 rr 脚本仅剩 1 处钉');
  eq([allPins[0]!.kind, path.basename(allPins[0]!.file)], ['reverse', 'rr_zx_20260909_fixes.ts'],
    '该处即 09_fixes 的历史负钉（反向；其"钉格式不钉轮次"的改法正是先例）');

  // ② **哑雷专项**（订正3）：`scanBuildPins` 的 PIN_RE 只认 `build:`/`ROUND =`/`includes(` 前缀，
  //    故「把派生来的 build 标签与轮次字面量直接比对」这种写法**躲得过 P5**，却会在下一轮刷新后变红
  //    —— 红与"真退化"无从区分，旧轮脚本只能被弃用（`rr_zx_20260913.ts:68` 原形即此，由上一轮收口引入）。
  //    判据：任何 rr 脚本的**代码行**（去注释后）不得同时含 `tag` 标识符与轮次字面量。
  const ROUND_LIT = /['"`](zx_\d{8}(?:_\d+)?)['"`]/;
  const landmineIn = (src: string): number[] => {
    const hits: number[] = [];
    stripKeepingLines(src).forEach((line, i) => {
      if (/\btag\b/.test(line) && ROUND_LIT.test(line)) hits.push(i + 1);
    });
    return hits;
  };
  const offenders: string[] = [];
  for (const name of fs.readdirSync(SCRIPTS).filter((f) => f.startsWith('rr_') && f.endsWith('.ts')).sort()) {
    for (const ln of landmineIn(fs.readFileSync(path.join(SCRIPTS, name), 'utf-8'))) offenders.push(`${name}:${ln}`);
  }
  eq(offenders, [], `哑雷专项：全量 rr 脚本无"派生标签 × 轮次字面量"比对（实测扫描面 ${fs.readdirSync(SCRIPTS).filter((f) => f.startsWith('rr_') && f.endsWith('.ts')).length} 个脚本）`);
  // 反证：把 0913 那行的**原形**喂进同一判据，必须命中（否则本断言只是"扫描面为空"的假绿）。
  // ⚠ 夹具须**两段拼接**：`q()` 只能骗过 PIN_RE（它认 `build:` 前缀），骗不过本处的 ROUND_LIT
  //   ——真写一个整字面量，**本行自己**就成了一行的形状，会被上面那条判据扫成 offender（首版即此，§S9 自红）。
  eq(landmineIn(`  eq(tag, ${q('zx_' + '20200101')}, '本轮真源标签 = …（M5 已刷新）');\n`),
    [1], '反证：把那行原形喂进判据 ⇒ 命中第 1 行（判据真的抓得住这类哑雷）');
  ok(fs.readFileSync(path.join(SCRIPTS, 'rr_zx_20260913.ts'), 'utf-8').includes('thisRound'),
    'rr_zx_20260913.ts 已改为**由文件名派生**的单调守卫（原硬编码字面量已删）');
}

// ══════════════════════════════════════════════════════════════════
console.log('\n【S10】接线在册：派生模块被 18 个脚本真实调用（防"写了没用上"）');
{
  ok(fs.existsSync(path.join(SCRIPTS, 'lib/rr-pins.ts')), 'scripts/lib/rr-pins.ts 在位');
  const wired = [
    'rr_zx_20260910_3_b5.ts', 'rr_zx_20260910_5.ts', 'rr_zx_20260910_6.ts',
    'rr_zx_20260911_1.ts', 'rr_zx_20260911_2.ts', 'rr_zx_20260911_3.ts',
    'rr_zx_20260911_4.ts', 'rr_zx_20260911_5.ts', 'rr_zx_20260912.ts',
    'rr_zx_20260913.ts', 'rr_zx_20260913_1.ts', 'rr_zx_20260913_2.ts',
    'rr_zx_20260913_3.ts', 'rr_zx_20260913_4.ts',
    // 本轮：M4-2 给 _2/_3 之外的另两个补上 build 闸（订正5：_1 原缺、轮级本文件一并接上）
    'rr_zx_20260914.ts', 'rr_zx_20260914_1.ts', 'rr_zx_20260914_2.ts', 'rr_zx_20260914_3.ts',
  ];
  const missing = wired.filter((f) => !fs.readFileSync(path.join(SCRIPTS, f), 'utf-8').includes("from './lib/rr-pins.js'")
    || !fs.readFileSync(path.join(SCRIPTS, f), 'utf-8').includes('checkBuildPins('));
  eq(missing, [], `18 个脚本均已 import 且调用 checkBuildPins（实测 ${wired.length - missing.length}/${wired.length}）`);
  // 反证：名单里凭空多一个不存在的脚本 ⇒ 判据必红
  const fake = [...wired, 'rr_zx_19990101.ts'];
  const fakeMissing = fake.filter((f) => !fs.existsSync(path.join(SCRIPTS, f)));
  eq(fakeMissing, ['rr_zx_19990101.ts'], '反证：名单外挂一个不存在的脚本 ⇒ 判据抓得住（非"名单恒绿"）');
}

// ══════════════════════════════════════════════════════════════════
console.log('\n【S11】基线归档在册：data/baseline_zx_20260914.json');
{
  const bp = path.join(root, 'data/baseline_zx_20260914.json');
  ok(fs.existsSync(bp), '基线文件在位（M4 细化规划订正2：此前四个脚本均引它，而它**从未存在**）');
  const base = JSON.parse(fs.readFileSync(bp, 'utf-8')) as Record<string, unknown>;
  eq(base.round, 'zx_20260914', '基线 round 正确');
  const ev = base.evidence as Record<string, unknown>;
  for (const k of ['dbCounts', 'dbFacts', 'codeEnumerations', 'settledM0_5', 'settledM0_6', 'contextWatermarkBaseline']) {
    ok(ev[k] !== undefined, `M0 证据段在册：evidence.${k}`);
  }
  const cw = base.closingWatermark as Record<string, unknown> | undefined;
  ok(!!cw, '收口段 closingWatermark 在册');
  if (cw) {
    ok(cw.measuredUnderThisBuild === false, '如实记载：收口时**本轮构建未跑过任何真实任务**', String(cw.note ?? ''));
    ok(Array.isArray(cw.samplesFromPriorBuilds) && (cw.samplesFromPriorBuilds as unknown[]).length > 0,
      'M0 口径的历史样本如实附上（非空）');
    ok(cw.gapNote !== undefined, '口径缺口（工具 schema 维度无实测值）如实标注');
    const dist = cw.buildDistribution as Record<string, number>;
    ok(dist['zx_20260914'] === 0, 'build 分布如实：zx_20260914 = 0 行（与 measuredUnderThisBuild=false 自洽）');
  }
  // 反证：删掉一个证据段 ⇒ 判据必红
  const fakeEv: Record<string, unknown> = { ...ev };
  delete fakeEv.settledM0_6;
  eq(['dbCounts', 'dbFacts', 'codeEnumerations', 'settledM0_5', 'settledM0_6', 'contextWatermarkBaseline']
    .filter((k) => fakeEv[k] === undefined), ['settledM0_6'], '反证：缺段对象 ⇒ 判据抓得住');
}

// ══════════════════════════════════════════════════════════════════
console.log('\n【S12】整轮不变式（跨 M0.5–M3）');
{
  // ① 作业入队一处真源（M0.5-1）：白名单外**无**裸插
  const MAIN = path.join(root, A, 'src/main');
  const walkTs = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkTs(path.join(d, e.name)) : (e.name.endsWith('.ts') ? [path.join(d, e.name)] : []));
  const stripC = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const RAW_WHITELIST = ['core/task-scheduler.ts', 'core/job-enqueuer.ts', 'ipc/project.ipc.ts'];
  const rawHits = walkTs(MAIN)
    .map((f) => ({ rel: path.relative(MAIN, f).split(path.sep).join('/'), n: (stripC(fs.readFileSync(f, 'utf-8')).match(/INSERT INTO wa_jobs/gi) || []).length }))
    .filter((h) => h.n > 0 && !RAW_WHITELIST.includes(h.rel));
  eq(rawHits, [], '① M0.5-1：白名单外无 `INSERT INTO wa_jobs` 裸插（运行期不再空转）');

  // ② failed 对话行**恰三处**（M1-1 新增手工回话后扫描面须含 manual-send.ts；
  //    zx_20260920 M2 新增机器回话失败记账点 reply-accounting.ts —— 第三个写者，不是拆出来的）
  const IM_FILES = [
    'core/im/im-outbox.ts', 'core/im/reply-accounting.ts', 'core/im/manual-send.ts', 'ipc/im.ipc.ts', 'services/im-router.ts',
    'services/wechat-adapter.ts', 'services/dingtalk-adapter.ts', 'services/wecom-adapter.ts',
    'services/feishu-adapter.ts', 'services/qqbot-adapter.ts',
    // zx_20260930 M2-c: 出站行的唯一落点（五家适配器 9 处内联已迁入）——扫描面跟着写入者走。
    'core/im/outbound-record.ts',
  ].filter((f) => fs.existsSync(path.join(MAIN, f)));
  const failedWriters: string[] = [];
  let convInserts = 0;
  let manualSent = 0;
  for (const f of IM_FILES) {
    for (const l of stripKeepingLines(fs.readFileSync(path.join(MAIN, f), 'utf-8'))) {
      if (!l.includes('INSERT INTO wa_im_conversations')) continue;
      convInserts++;
      // zx_20260929 M8-c（**改钉更强的真源，非放宽**）：失败行的状态值已移入绑定参数
      //   （failed / blocked_quota 同表），`'failed'` 字面量只剩 im-outbox 一家 ⇒ 旧判据假红。
      //   改以**是否显式写 status 列**为据：列 DEFAULT='sent' 只管成功行，写 status 者即失败行写者。
      if (/\bstatus\b/.test(l)) failedWriters.push(path.basename(f));
      if (l.includes("'sent'")) manualSent++;
    }
  }
  eq(failedWriters.sort(), ['im-outbox.ts', 'im.ipc.ts', 'reply-accounting.ts'],
    '② failed 对话行写入恰三处：通知记账点(im-outbox) + 手动重发失败(im.ipc) + 机器回话失败(reply-accounting)（以"写 status 列"为据，不靠 \'failed\' 字面量）');
  eq(failedWriters.length, 3, '② 显式写 status 列的对话 INSERT 恰 3 处（其余靠列 DEFAULT 一处真源，非手抄清单）');
  eq(manualSent, 0, '② 反证：无一 INSERT 手写 status=\'sent\'（送达态一处真源 = 列 DEFAULT；手抄清单即红）');
  // zx_20260930 M2-c（**改钉更强的真源，非放宽**）：出站行形状收成**一处**——旧判据"INSERT 读点 ≥9"
  //   在 9 处内联迁走后必然下跌，故改为钉**形状**（适配器零内联 + 落点含 task_id），下界只作自证。
  const ADAPTER_RELS = ['wechat', 'dingtalk', 'wecom', 'feishu', 'qqbot'].map((n) => `services/${n}-adapter.ts`);
  eq(ADAPTER_RELS.filter((f) => fs.readFileSync(path.join(MAIN, f), 'utf-8').includes('INSERT INTO wa_im_conversations')), [],
    '② 五家适配器**零内联**出站 INSERT（出站行已迁入 `core/im/outbound-record.ts` 单一落点）');
  ok(/INSERT INTO wa_im_conversations[\s\S]{0,200}?task_id/.test(fs.readFileSync(path.join(MAIN, 'core/im/outbound-record.ts'), 'utf-8')),
    '② 落点那一句 INSERT 的**列清单含 task_id**（M2-c 靶心：这一行答得出"属于哪个任务"）');
  ok(convInserts >= 8, `② 对话表 INSERT 读点下界成立（实测 ${convInserts} ≥ 8，扫描面 ${IM_FILES.length} 文件；五家 9 处内联 → 落点 1 处，净减 8）`);
  ok(IM_FILES.includes('core/im/manual-send.ts'), '② 扫描面含 M1-1 新增的写入者 manual-send.ts（漏它则"恰两处"只是"在我看的地方恰两处"）');

  // ③ 两处工具登记表同长且同一集合（M3-1b）
  const db = mkdb();
  db.prepare("INSERT INTO wa_settings (key,value) VALUES ('ans_server_url','http://127.0.0.1:1')").run();
  const tools = buildTools({ db } as never, 't1', 'p1', process.cwd()) as unknown as Record<string, unknown>;
  const metaNames = TOOL_METAS.map((m) => (m as { name: string }).name).sort();
  const builtNames = Object.keys(tools).sort();
  eq(metaNames.filter((n) => !builtNames.includes(n)), [], '③ TOOL_METAS 的每条都有实现（无"登记了却没做"）');
  eq(builtNames.filter((n) => !metaNames.includes(n)), [], '③ buildTools 的每个都有登记（无"做了却没登记"，否则被剔出只读步）');
  const regSrc = fs.readFileSync(path.join(MAIN, 'core/tool-registry.ts'), 'utf-8');
  const declared = Number((regSrc.match(/(\d+)\s*个工具的元数据表/) || [])[1]);
  eq(declared, TOOL_METAS.length, `③ 注释声明数 === 运行期 TOOL_METAS.length（各 ${TOOL_METAS.length}；写错即红）`);

  // ④ panorama 归档例外三处在册（M3-2），第四处（antithesis 按 id）有意不动
  const mmLines = stripKeepingLines(fs.readFileSync(path.join(MAIN, 'core/memory-manager.ts'), 'utf-8'));
  const archiveLines = mmLines.filter((l) => /UPDATE wa_memories SET memory_type = 'archived'/.test(l));
  const withException = archiveLines.filter((l) => l.includes("NOT IN ('archived', 'panorama')"));
  eq(withException.length, 3, `④ 归档 UPDATE 中带 panorama 例外者恰 3 处（实测共 ${archiveLines.length} 处归档语句）`);
  const byIdArchive = archiveLines.filter((l) => l.includes('WHERE id = ?'));
  eq(byIdArchive.length, 1, '④ 四处归档中按 id 者恰 1 处（antithesis）');
  eq(byIdArchive.every((l) => !l.includes('panorama')), true,
    '④ 例外只加在"批量归档"上，按 id 的 antithesis 归档不掺例外（不可达，护卫条件另有 rr 钉死）');

  // ⑤ T1 红线：prompt caching 架构改造本轮不做 ⇒ 源码无 cache 参数
  ok(!/cache_control/.test(stripC(realSrc)), '⑤ T1 红线：源码无 cache_control 透传（§7.2 挂账未偷偷落地）');
  ok(!/providerOptions/.test(stripC(realSrc)), '⑤ T1 红线：streamText 调用未加 providerOptions（本轮只降本、不改调用架构）');
}

// ══════════════════════════════════════════════════════════════════
console.log('\n【S13】产物同源：本轮改动真被烧进 main 产物（防"改了源码没重新构建"）');
{
  let blob = '';
  let n = 0;
  try {
    const files = fs.readdirSync(DIST, { recursive: true })
      .filter((f): f is string => typeof f === 'string' && f.endsWith('.js'));
    n = files.length;
    blob = files.map((f) => fs.readFileSync(path.join(DIST, f), 'utf-8')).join('\n');
  } catch { /* 未构建 */ }
  ok(n > 0, `dist 构建产物在位（${n} 个 .js）`, n ? '' : '(请先 tsup)');
  // 本轮新增/改动的可辨识符号（tsup 不压缩 main ⇒ 标识符保真）
  for (const [marker, what] of [
    ['toolsCount', 'M3-3 水位分项 toolsCount'],
    ['toolsChars', 'M3-3 水位分项 toolsChars'],
    ['list_skills', 'M3-1 新工具 list_skills'],
    ['pause_reason', 'M0.5-2 暂停之因落库'],
    ['enqueueJob', 'M0.5-1 作业入队一处真源'],
    ['client_request_id', 'M0.6 幂等键'],
  ] as const) {
    ok(blob.includes(marker), `产物内含 ${what}（'${marker}'）`);
  }
  // 反证：凭空一个不存在于本轮产物的标识符 ⇒ 判据为否
  ok(!blob.includes('__zzz_not_a_real_marker__'), '反证：不存在的标识符在产物内为否 ⇒ 上方判据非"恒真"');
}

// ══════════════════════════════════════════════════════════════════
// 【S14】IPC 契约与门控读点（M4-4 端到端对齐复核 → 落钉）
//
// 复核口径 = 方案 M4-4 的三问（"头大脚轻 / 做了没用上 / 接口参数不一致"），逐条变成可复跑断言：
//   ① 参数一致   main handler 解构键集 === renderer 载荷键集（**逐字比对**，不靠人眼扫）
//   ② 做了没用上 本轮新增的每个 renderer 通道函数都须有**真实消费点**
//   ③ 词表不全   main 产出的每个拒绝 reason 都须有**归属**（被消费 or 明文静默），无第三种下落
//   ④ 判据分家   同一开关的每处读取都须经**同一判据函数**（`boolSetting`），不自造第二个谓词
//   ⑤ 不虚构通道 `list_skills` 是**主进程内**工具，不是 IPC —— 不得为它编一条 renderer 可达通道
//
// ⚠ 本节的"对齐"是**源码层三处同名同参 + 静态穷举**，**不含**运行期实机点击（后者归 M4-6 交用户）。
// ⚠ 本节刻意**不写**"某失败态尚无文案"这类"现状缺席"断言——那会随修好而变红，正是 §S9 刚拆掉的哑雷形状。
console.log('\n【S14】IPC 契约与门控读点（M4-4 端到端对齐复核）');
{
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (/\.tsx?$/.test(e.name)) acc.push(p);
    }
    return acc;
  };
  const rendererRoot = path.join(root, A, 'renderer/src');
  const rendererAll = walk(rendererRoot).map((f) => ({ rel: path.relative(rendererRoot, f), s: fs.readFileSync(f, 'utf-8') }));
  const rendererBlob = rendererAll.map((f) => f.s).join('\n');
  ok(rendererAll.length > 40, `① renderer 扫描面非空（实测 ${rendererAll.length} 个 .ts/.tsx）`);
  ok(rendererAll.some((f) => f.rel === 'lib/ipc.ts'), '② 反证：扫描面确实含 lib/ipc.ts（"排除它"不是"没找到它"）');

  // ── ① 三处同名同参：main handler 解构键集 ↔ renderer 载荷键集 ──
  const keySet = (inner: string) => inner.split(',').map((k) => k.trim().split(':')[0]!.trim()).filter(Boolean).sort();
  for (const c of [
    { ch: 'im:send', main: 'ipc/im.ipc.ts', keys: ['channelId', 'externalUserId', 'text'] },
    { ch: 'deliverable:accept', main: 'ipc/project.ipc.ts', keys: ['id'] },
    { ch: 'deliverable:previewImage', main: 'ipc/project.ipc.ts', keys: ['id'] },
    // zx_20260930 M4-2 就地订正（**改钉真契约，非放宽**）：`task:get` 原钉 `keys: ['id']`。
    //   本轮给任务详情加**真分页**（对话/成果各带 limit+offset），两侧契约一起长。它从本表**移出**
    //   是因为本表 `keys` 是**手抄字面量**，而 `task:get` 的载荷是 `{ id, ...page }`（展开式，
    //   字面量根本列不全）——留在表里只能手抄两处、且一改就红。改为下方**由 renderer 自己的
    //   `page` 类型声明派生**主侧应然的键集 ⇒ 两侧不同步即红，且没有字面量可抄错。
  ]) {
    const mainSrc = RD(`${A}/src/main/${c.main}`);
    const hits = [...mainSrc.matchAll(new RegExp(`ipcMain\\.handle\\('${c.ch}',`, 'g'))];
    ok(hits.length === 1, `① main 侧 \`${c.ch}\` handler 恰 1 处（多一处即有第二个真相）`, `实测 ${hits.length} 处`);
    const m = hits.length ? mainSrc.slice(hits[0]!.index!).match(new RegExp(`^ipcMain\\.handle\\('${c.ch}',\\s*async\\s*\\([^,]*,\\s*\\{([^}]*)\\}`)) : null;
    eq(m ? keySet(m[1]!) : null, c.keys, `① main \`${c.ch}\` 解构键集 === 约定（${c.keys.join('/')}）`);

    const rf = rendererAll.find((f) => f.s.includes(`('${c.ch}'`));
    ok(!!rf, `① renderer 侧 \`${c.ch}\` 调用点恰 1 个文件（实测 ${rf ? rf.rel : '无'}）`);
    const rp = rf ? rf.s.slice(rf.s.indexOf(`'${c.ch}'`)).match(new RegExp(`^'${c.ch}',\\s*\\{([^}]*)\\}`)) : null;
    eq(rp ? keySet(rp[1]!) : null, c.keys, `① renderer \`${c.ch}\` 载荷键集 === 约定（与 main 逐字相等）`);
  }

  // ── ①b `task:get` 分页契约（M4-2）：**主侧键集由 renderer 的 `page` 类型派生** ──
  //   派生链：renderer `get(id, page?: {convLimit?…})` → 键集(page) ∪ {id} === main 解构键集。
  //   这样"两侧逐字相等"不再靠人抄：改任一侧而另一侧不跟 ⇒ 红。
  {
    const ipcSrc = RD(`${A}/renderer/src/lib/ipc.ts`);
    const pageType = ipcSrc.match(/get:\s*\(id:\s*string,\s*page\?:\s*\{([^}]*)\}\)/) ?? null;
    // 与通用表同覆盖：main 侧 handler **恰 1 处**、renderer 侧调用点**恰 1 个文件**
    //   （`task:get` 移出通用表后这两条须在此补回，否则是**净减覆盖面**）
    const hAll = RD(`${A}/src/main/ipc/project.ipc.ts`).match(/ipcMain\.handle\('task:get',/g) || [];
    eq(hAll.length, 1, '①b main 侧 `task:get` handler 恰 1 处（多一处即有第二个真相）');
    const rFiles = rendererAll.filter((f) => f.s.includes("('task:get'")).map((f) => f.rel);
    eq(rFiles.length, 1, '①b renderer 侧 `task:get` 调用点恰 1 个文件', rFiles.join('/'));
    ok(!!pageType, '①b renderer `tasks.get` 第二参 `page?` 的类型声明在场（派生源可信）');
    // 键分隔符**两种**都要认：TS 类型字面量里成员用 `;`（可省），对象字面量里用 `,`
    const optKeys = (inner: string) => inner.split(/[;,]/).map((k) => k.trim().split(':')[0]!.trim().replace(/\?$/, '')).filter(Boolean).sort();
    const pageKeys = pageType ? optKeys(pageType[1]!) : [];
    const wantKeys = [...pageKeys, 'id'].sort();
    const mainSrc = RD(`${A}/src/main/ipc/project.ipc.ts`);
    // 不加 `^`/`m` 锚：handler 缩进两格，行首锚会静默失配（实测过一次：得 null 而非报错）
    const h = mainSrc.match(/ipcMain\.handle\('task:get',\s*async\s*\([^,]*,\s*\{([^}]*)\}/);
    eq(h ? keySet(h[1]!) : null, wantKeys,
      '①b main `task:get` 解构键集 === renderer `page` 类型派生（派生自 ipc.ts，两处不同步即红）');
    ok(pageKeys.length >= 4 && pageKeys.includes('convLimit') && pageKeys.includes('delivOffset'),
      '①b 派生源本身非空且含四键（防"类型没解析出来 ⇒ 两侧都空 ⇒ 假绿"）', pageKeys.join('/'));
    // renderer 载荷确为 `{ id, ...page }`：id 在、分页经由 page 展开（不是把四键手抄进载荷）
    ok(/\('task:get',\s*\{\s*id,\s*\.\.\.page\s*\}\)/.test(ipcSrc),
      '①b renderer 载荷 = `{ id, ...page }`（分页走展开，不手抄四键）');
  }
  // preload 是**通用透传**（无按通道白名单）——若哪天改成枚举，本表必须同步补，故此处钉死字形
  const preloadSrc = RD(`${A}/src/preload/index.ts`);
  ok(/invoke:\s*\(channel:\s*string,\s*\.\.\.args: unknown\[\]\)[\s\S]{0,80}ipcRenderer\.invoke\(channel,\s*\.\.\.args\)/.test(preloadSrc),
    '① preload 为通用透传（channel+...args 直送 ipcRenderer.invoke）');
  ok(!/ipcRenderer\.invoke\('(im:send|deliverable:accept|deliverable:previewImage|task:get)'/.test(preloadSrc),
    '① 反证：preload 未把上述通道改成"按通道枚举"（改则本行红，提示同步本表）');

  // ── ② 做了没用上：本轮新增的 renderer 通道函数须有真实消费点 ──
  for (const c of [
    { expr: 'im.send(', min: 1, what: 'M1-1 手工回话入口' },
    { expr: 'deliverables.previewImage(', min: 1, what: 'M2-2 图片就地预览' },
    { expr: 'deliverables.accept(', min: 2, what: 'M2-4 手动标验收（D2 裁定=列表行 + 抽屉，故下界 2）' },
    { expr: 'im.unread(', min: 1, what: 'M1-3 导航红点取初值' },
    // 度量是**消费文件数**（不是调用点个数）：同一文件内的两处调用（如任务详情的首载 + 刷新）
    // 只算一个消费面——把调用点个数当判据会让"同文件再调一次"这种无害改动变红（狼来了）。
    { expr: 'tasks.get(', min: 1, what: '任务详情取数' },
  ]) {
    const hits = rendererAll.filter((f) => f.rel !== 'lib/ipc.ts' && f.s.includes(c.expr)).map((f) => f.rel);
    ok(hits.length >= c.min, `② ${c.what} 有真实消费点（'${c.expr}'，消费文件数下界 ${c.min}）`, JSON.stringify(hits));
  }

  // ── ③ 词表不全：main 产出的拒绝原因须全部有归属 ──
  const accReasons = new Set([...RD(`${A}/src/main/core/deliverable-lifecycle.ts`).matchAll(/reason: '([a-z_]+)'/g)].map((x) => x[1]!));
  if (RD(`${A}/src/main/ipc/project.ipc.ts`).includes("reason: 'disabled'")) accReasons.add('disabled');
  const accTextSrc = RD(`${A}/renderer/src/lib/ipc.ts`);
  const accTextBody = accTextSrc.match(/ACCEPT_REASON_TEXT[^=]*=\s*\{([\s\S]*?)\n\};/);
  const accTextKeys = new Set([...(accTextBody ? accTextBody[1]!.matchAll(/^\s{2}([a-z_]+):/gm) : [])].map((x) => x[1]!));
  ok(accReasons.size >= 6, `③ main 侧 accept 拒绝原因下界成立（实测 ${accReasons.size} 种：${[...accReasons].sort().join('/')}）`);
  eq([...accReasons].filter((r) => !accTextKeys.has(r)).sort(), [], '③ main 产出的每个 accept 原因在 renderer 词表里都有话可说（无凭空消失）');

  const pjSrc = RD(`${A}/src/main/ipc/project.ipc.ts`);
  const pvStart = pjSrc.indexOf("'deliverable:previewImage'");
  const pvNext = pjSrc.indexOf('ipcMain.handle', pvStart);
  const pvHandler = pjSrc.slice(pvStart, pvNext > 0 ? pvNext : undefined);
  const pvReasons = new Set([
    ...[...RD(`${A}/src/main/core/image-preview.ts`).matchAll(/reason: '([a-z_]+)'/g)].map((x) => x[1]!),
    ...[...pvHandler.matchAll(/reason: '([a-z_]+)'/g)].map((x) => x[1]!),
  ]);
  // 每个 reason 必须**有归属**：要么抽屉显式消费并占版面，要么**明文**列在"静默"一侧。
  // 加一个 reason 却两处都不列 ⇒ 下面这条判红（"生产了却没人管"）。
  const PV_CONSUMED = new Set(['oversize']);
  const PV_SILENT = new Set(['unsupported', 'missing', 'not_found']);
  ok(pvReasons.size >= 4, `③ 图片预览 reason 下界成立（实测 ${pvReasons.size} 种：${[...pvReasons].sort().join('/')}）`);
  eq([...pvReasons].filter((r) => !PV_CONSUMED.has(r) && !PV_SILENT.has(r)).sort(), [],
    '③ 每个图片预览 reason 都有归属（被消费 or 明文静默），无"第三种下落"');
  ok(rendererBlob.includes("r?.reason === 'oversize'"), '③ oversize 真被抽屉消费（不是"产出了没人看"）');
  // ⚠ M4-4 复核发现（已记方案挂账，不擅自改 UI——越 M2 用户裁定边界）：
  //   `missing`（文件已不在磁盘）与 `not_found` 当前**静默**。二者与 oversize 同属"用户可采取行动的差异"，
  //   却无一句说明 ⇒ 是"信息失落"的残留口子。修则把该 reason 从 PV_SILENT 移到 PV_CONSUMED，本判据仍成立。

  // ── ④ 判据分家：同一开关的每处读取都须经同一判据函数 ──
  const GATE = "key = 'deliverable.show_acceptance'";
  const gateScan = (srcs: Array<{ f: string; s: string }>) => {
    const sites: string[] = []; const bad: string[] = [];
    for (const { f, s } of srcs) {
      const lines = s.split('\n');
      lines.forEach((l, i) => {
        if (!l.includes(GATE)) return;
        sites.push(`${f}:${i + 1}`);
        if (!/boolSetting\(/.test(lines.slice(i, i + 3).join('\n'))) bad.push(`${f}:${i + 1}`);
      });
    }
    return { sites, bad };
  };
  const mainTs = walk(path.join(root, A, 'src/main')).map((f) => ({ f: path.relative(root, f), s: fs.readFileSync(f, 'utf-8') }));
  const g = gateScan(mainTs);
  ok(g.sites.length >= 5, `④ 门控 \`deliverable.show_acceptance\` 读点下界成立（实测 ${g.sites.length} 处）`, g.sites.join(', '));
  eq(g.bad, [], '④ 每处读取都经唯一判据 boolSetting（无自造的第二个谓词）');
  eq(gateScan([{ f: 'fixture.ts', s: [
    `const c = db.prepare("SELECT value FROM wa_settings WHERE ${GATE}").get();`,
    `const on = (c?.value ?? 'true') !== 'false';`,
  ].join('\n') }]).bad, ['fixture.ts:1'], '④ 反证：自造第二个谓词（不经 boolSetting）⇒ 该读取被判红');

  // ── ⑤ 不虚构通道：list_skills 是主进程内工具，不是 IPC ──
  const mainBlob = mainTs.map((f) => f.s).join('\n');
  ok(!mainBlob.includes("ipcMain.handle('list_skills'"), '⑤ list_skills 未虚构 IPC 通道（主进程内工具，renderer 不可达）');
  ok(TOOL_METAS.some((m) => (m as { name: string }).name === 'list_skills'), '⑤ list_skills 登记在册（与 §S12③ 同尺：登记 ↔ buildTools 键集）');
  ok(mainBlob.includes("ipcMain.handle('task:get'"), '⑤ 反证：同一条判据对**真存在的**通道为真 ⇒ 上面那条不是"恒真"');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260914: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
