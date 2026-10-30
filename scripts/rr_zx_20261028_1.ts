/**
 * zx_20261028_1 受控复跑 —— 「一」：**一次派发，只做一遍；凡说得出，做得到**。
 *
 * 真标本：任务 `b1020d75`（怡寿里·「初识化数据库脚本问题修复」）一次 GUI 重试，
 * 日志里两条 `[智能拆解] 任务启动`、两套同名子任务；余量账里写着 `验证修复结果` 而同名子任务早已存在；
 * 三棵子树全停后父任务静默钉在 `children_incomplete` 等一个永不到来的"子完成"。
 *
 * 六组判据，全部**直引生产导出跑真实现**（G-1）：
 *   A「一次只跑一份」：`processPending` 在途期间再扫不得二次入队（两侧标本：在途挡下 / 结束后照常）；
 *      同批按任务优先级降序；失败后清标记、可再派发。
 *   B「拆解占位」：先到者成功、后到者退让；TTL 过期可重占；释放后可重占；
 *      并发真跑 `tryAutoDecomposeAtStart` 两路 ⇒ 只建一套子任务、后到者零写且返回 true。
 *   C「同名不重造」：标本那股余量（与既有子任务同名）⇒ 零新建、清账、留一行；
 *      混合股 ⇒ 只建新项、同名序号映射到既有 id（依赖边不悬空）；既有未建余量账不被覆写；
 *      两句余量文案各自说真话。
 *   D「失败说人话」：`fetch failed` 原文字串仍在场且含"ANS"；不相干错误逐字返回（反证）。
 *   E「停摆必出声」：父等子、子全停 ⇒ `pause_note` 0→1、`[停摆]` 会话 0→1、自愈账 0→1；
 *      有可跑子 / 父不是等子暂停 ⇒ 零写；同签名再扫不重复。
 *   F「读点同源」：`TaskDetailPage.tsx` 跨 root 直引 `recordedPauseNote` 并真渲染；不手抄键名。
 *
 * 纪律（承 auto-memory）：
 *   G-1 真源直 import（删/改名 ⇒ 编译期失败）。
 *   G-2 两只标本（该做的做了 / 不该动的没动）。
 *   G-4 计数器断言必有 0→1 正面。
 *   G-6 无轮次字面量：方案名/脚本名由 `path.basename(__filename)` 派生。
 *   ⚠ 判据文案不得含失败字形（全量汇总按字形计失败数）。
 *   ⚠ 末尾 build 钉读 `dist` ⇒ 常规须 `tsup` 先于本脚本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { TaskScheduler } from '../apps/worker-ant-desktop/src/main/core/task-scheduler.js';
import {
  claimAutoDecompose,
  releaseAutoDecomposeClaim,
  AUTO_DECOMPOSE_CLAIM_TTL_MS,
  createDeferredSubtasks,
  deferredStateOf,
  shortfallNotice,
  autoDecomposeForTask,
  type DecomposeDeps,
} from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
import { tryAutoDecomposeAtStart } from '../apps/worker-ant-desktop/src/main/core/jobs/ai-task.js';
import { describeExecutionError } from '../apps/worker-ant-desktop/src/main/core/exec-error.js';
import {
  noticeStalledWaitingParents,
  stallNoticeText,
  SELF_HEALING_LOGS_DDL,
} from '../apps/worker-ant-desktop/src/main/core/self-healing-monitor.js';
import {
  recordedPauseNote,
  PAUSE_REASON_CHILDREN_INCOMPLETE,
  PAUSE_REASON_NO_OUTPUT,
  PAUSE_REASON_USER_INTERRUPT,
} from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';

type AnyDb = import('better-sqlite3').Database;

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
/** G-6：轮次标识由**载体自身**派生，本文件不写任何轮次字面量。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/**
 * 夹具库：与生产同形的列（`wa_tasks` 对齐 `planSubtasksFromTemplate` 的 INSERT、
 * `wa_jobs` 对齐调度器的取/更新、`wa_projects` 对齐扫描判据）。
 */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', cron_schedule TEXT, working_dir TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '', source TEXT DEFAULT 'user',
  acceptance_criteria TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, error TEXT,
  created_at TEXT DEFAULT (datetime('now')));
` + SELF_HEALING_LOGS_DDL;

function mkdb(): AnyDb {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  return d as unknown as AnyDb;
}

function addProject(db: AnyDb, id: string, status = 'active'): void {
  db.prepare('INSERT INTO wa_projects (id, name, status) VALUES (?, ?, ?)').run(id, id, status);
}

function addTask(db: AnyDb, o: {
  id: string; project?: string; title?: string; status?: string; parent?: string;
  deps?: string; priority?: number; ctx?: Record<string, unknown>; source?: string;
}): void {
  db.prepare(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, parent_task_id, depends_on, priority, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      o.id, o.project ?? 'proj', o.title ?? `T-${o.id}`, o.status ?? 'pending',
      JSON.stringify(o.ctx ?? {}), o.parent ?? '', o.deps ?? '', o.priority ?? 0, o.source ?? 'user',
    );
}

const ctxOf = (db: AnyDb, id: string): Record<string, unknown> =>
  JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}') as Record<string, unknown>;
const statusOf = (db: AnyDb, id: string): string =>
  (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
const childCount = (db: AnyDb, parent: string): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM wa_tasks WHERE parent_task_id = ?').get(parent) as { c: number }).c;
const convsOf = (db: AnyDb, id: string): string[] =>
  (db.prepare('SELECT content FROM wa_task_conversations WHERE task_id = ? ORDER BY rowid').all(id) as Array<{ content: string }>)
    .map((r) => r.content);
const healingCount = (db: AnyDb): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM wa_self_healing_logs').get() as { c: number }).c;

type SchedInternals = {
  pending: Map<string, { type: string; payload: Record<string, unknown>; jobId?: string }>;
  inflight: Set<string>;
  processPending(): Promise<void>;
  scanReadyTasks(): void;
};

async function main(): Promise<void> {
  // ═══ A｜一次只跑一份（M1） ═══════════════════════════════════════════════════
  console.log('\n【A】M1 一次派发只跑一份：在途期间不得二次入队');
  {
    const db = mkdb();
    addProject(db, 'pA');
    addTask(db, { id: 'tA', project: 'pA' });

    const sch = new TaskScheduler(db as never);
    const inside = sch as unknown as SchedInternals;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    sch.register('ai-task', async () => { calls++; await gate; });

    inside.scanReadyTasks();
    ok(inside.pending.has('tA'), 'A-1 软闸把待办放进内存队列（逐字旧行为）');

    const p1 = inside.processPending();
    await new Promise((r) => setTimeout(r, 10));
    eq(calls, 1, 'A-2 处理器已起跑（此刻条目已离开 pending、在 inflight 里）');
    ok(inside.inflight.has('tA'), 'A-3 在途标记在册（挂在待处理键上）');

    // 真标本的第二次派发表征：拆解那几秒里 `scanReadyTasks` 又扫到这条待办。
    inside.scanReadyTasks();
    eq(inside.pending.has('tA'), false,
      'A-4 ★在途期间再扫不得二次入队（旧实现只看 pending ⇒ 必然又塞一份）');

    // 更强的判据：即便有人硬把同键塞回 pending，processPending 也不得并发第二份。
    inside.pending.set('tA', { type: 'ai-task', payload: { taskId: 'tA', projectId: 'pA' } });
    await inside.processPending();
    eq(calls, 1, 'A-5 ★在途期间同键条目不并发执行（挡的是"执行"，不是"入队"）');
    ok(inside.pending.has('tA'), 'A-6 被挡下的条目仍留在队里（不静默丢弃，下一跳再看）');

    release();
    await p1;
    eq(calls, 1, 'A-7 放行后仍只执行过一份');
    ok(!inside.inflight.has('tA'), 'A-8 执行完毕清掉在途标记');

    inside.pending.clear();
    inside.scanReadyTasks();
    ok(inside.pending.has('tA'), 'A-9 ★不在途时再扫照常入队（闸不是永久的，两侧标本）');
  }

  // A-10..A-12：同批按优先级降序；失败后清标记且可再派发
  {
    const db = mkdb();
    addProject(db, 'pA');
    addTask(db, { id: 'tLow', project: 'pA', priority: 0 });
    addTask(db, { id: 'tHigh', project: 'pA', priority: 5 });
    const sch = new TaskScheduler(db as never);
    const inside = sch as unknown as SchedInternals;
    const order: string[] = [];
    sch.register('ai-task', async (p) => { order.push(String(p.taskId)); });
    await sch.enqueue('ai-task', { taskId: 'tLow', projectId: 'pA', source: 'test' });
    await sch.enqueue('ai-task', { taskId: 'tHigh', projectId: 'pA', source: 'test' });
    await inside.processPending();
    eq(order, ['tHigh', 'tLow'], 'A-10 同批按任务优先级降序先跑高的（优先级一次批量取）');
  }
  {
    const db = mkdb();
    addProject(db, 'pA');
    addTask(db, { id: 'tErr', project: 'pA' });
    const sch = new TaskScheduler(db as never);
    const inside = sch as unknown as SchedInternals;
    let calls = 0;
    sch.register('ai-task', async () => { calls++; throw new Error('boom'); });
    await sch.enqueue('ai-task', { taskId: 'tErr', projectId: 'pA', source: 'test' });
    await inside.processPending();
    eq(calls, 1, 'A-11 失败那一次照常执行（错误被本层接住，不外抛）');
    ok(!inside.inflight.has('tErr'), 'A-12 ★失败后清在途标记（否则该任务永久卡在"正要跑"）');
    sch.register('ai-task', async () => { calls++; });
    await sch.enqueue('ai-task', { taskId: 'tErr', projectId: 'pA', source: 'test' });
    await inside.processPending();
    eq(calls, 2, 'A-13 失败后可重新派发（闸不是一次失败即终身）');
  }

  // ═══ B｜拆解占位（M2） ═══════════════════════════════════════════════════════
  console.log('\n【B】M2 拆解占位：先到者拆、后到者让位、残留 TTL 后可重占');
  {
    const db = mkdb();
    addProject(db, 'pB');
    addTask(db, { id: 'b1', project: 'pB', status: 'pending' });

    ok(claimAutoDecompose(db, 'b1'), 'B-1 首个占位成功');
    eq(claimAutoDecompose(db, 'b1'), false, 'B-2 未过期时第二个占位失败（后到者让位）');
    releaseAutoDecomposeClaim(db, 'b1');
    ok(claimAutoDecompose(db, 'b1'), 'B-3 释放后可重占（正常路径不锁死）');

    const old = new Date(Date.now() - AUTO_DECOMPOSE_CLAIM_TTL_MS - 60_000).toISOString();
    db.prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.auto_decompose_claim', json_quote(?)) WHERE id = 'b1'").run(old);
    ok(claimAutoDecompose(db, 'b1'), 'B-4 ★残留超过 TTL ⇒ 允许重占（进程半途被杀不会永久锁死拆解）');
    eq(claimAutoDecompose(db, 'ghost'), false, 'B-5 不存在的任务不得占位（不编成功）');
    // 占位不抹兄弟键
    addTask(db, { id: 'b2', project: 'pB', ctx: { goal_summary: '兄弟键', depth: 0 } });
    ok(claimAutoDecompose(db, 'b2'), 'B-6 占位写入成功');
    eq(ctxOf(db, 'b2').goal_summary, '兄弟键', 'B-7 写占位不抹兄弟键（json_set 单键）');
    releaseAutoDecomposeClaim(db, 'b2');
    eq(ctxOf(db, 'b2').auto_decompose_claim, undefined, 'B-8 释放后键被删（不留空壳冒充在拆）');
  }
  {
    // ★并发真跑：两路同时越过闸③，只能有一路真拆。
    const db = mkdb();
    addProject(db, 'pB');
    addTask(db, { id: 'b3', project: 'pB', title: '优化方案设计', description: '给这条链路出一个优化方案', ctx: { depth: 0 } });

    const tmpl = [
      { title: '定位问题', description: '梳理现状', acceptance_criteria: '问题清单', purpose: '让后续有靶子' },
      { title: '修复脚本', description: '改脚本', acceptance_criteria: '脚本可跑', purpose: '修复问题', dependsOn: [1] },
      { title: '整理交付说明', description: '写说明', acceptance_criteria: '说明可读', purpose: '让人能复核', dependsOn: [2] },
    ];
    const origFetch = globalThis.fetch;
    let chats = 0;
    globalThis.fetch = (async () => {
      chats++;
      // 模拟拆解 LLM 的 ~5s await：让第二条派发真有窗口插进来（不靠运气）。
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(tmpl) } }] }) };
    }) as unknown as typeof fetch;
    const getAnsClient = async () => ({
      getOptimalModel: async () => ({ url: 'http://ans.local/v1', api_key: 'k', model_name: 'm' }),
    });
    let results: boolean[] = [];
    try {
      results = await Promise.all([
        tryAutoDecomposeAtStart(db as never, { taskId: 'b3', projectId: 'pB', getAnsClient }),
        tryAutoDecomposeAtStart(db as never, { taskId: 'b3', projectId: 'pB', getAnsClient }),
      ]);
    } finally {
      globalThis.fetch = origFetch;
    }
    eq(results, [true, true], 'B-9 ★两路都返回 true（后到者让位，但调用方同样不得再执行父任务）');
    eq(chats, 1, 'B-10 ★拆解模型只被问了一次（后到者零 HTTP）');
    eq(childCount(db, 'b3'), tmpl.length, 'B-11 ★★子任务只建一套（旧实现：一次派发拆两遍、两套同名子）');
    eq(convsOf(db, 'b3').filter((c) => c.includes('[智能拆解] 任务启动')).length, 1, 'B-12 拆解会话行 0→1（后到者零写）');
    eq(ctxOf(db, 'b3').auto_decomposed, true, 'B-13 共享层标记 `$.auto_decomposed` 落盘');
    eq(ctxOf(db, 'b3').auto_decompose_claim, undefined, 'B-14 占位键已释放（收尾走到 finally）');
    eq(statusOf(db, 'b3'), 'paused', 'B-15 父任务按既有路径置 paused 等子');
    eq(ctxOf(db, 'b3').pause_reason, PAUSE_REASON_CHILDREN_INCOMPLETE, 'B-16 暂停因由如实为 children_incomplete');
  }
  {
    // 拆解失败 ⇒ 按单任务照跑（false）且占位已释放（否则这条任务 15 分钟内再也不能拆）。
    const db = mkdb();
    addProject(db, 'pB');
    addTask(db, { id: 'b4', project: 'pB', title: '优化方案设计', description: '给这条链路出一个优化方案', ctx: { depth: 0 } });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    let r = true;
    try {
      r = await tryAutoDecomposeAtStart(db as never, {
        taskId: 'b4', projectId: 'pB',
        getAnsClient: async () => ({ getOptimalModel: async () => ({ url: 'http://ans.local/v1', api_key: 'k', model_name: 'm' }) }),
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    eq(r, false, 'B-17 拆解失败 ⇒ 不阻断执行（返回 false，按单任务照跑）');
    eq(ctxOf(db, 'b4').auto_decompose_claim, undefined, 'B-18 ★失败同样释放占位（finally 兜住）');
    ok(convsOf(db, 'b4').some((c) => c.includes('未能拆解')), 'B-19 失败留痕 0→1（不是无声）');
  }

  // ═══ C｜同名不重造 + 文案说真话（M3） ═══════════════════════════════════════
  console.log('\n【C】M3 续拆去重：同名已在就不再造；余量账不被覆写');
  {
    // C-1..C-6 标本原样：余量里那条 `验证修复结果` 与既有子任务同名。
    const db = mkdb();
    addProject(db, 'proj');
    addTask(db, {
      id: 'pD', project: 'proj', title: '初识化数据库脚本问题修复', status: 'paused',
      ctx: {
        goal_summary: '兄弟键',
        decomposition_deferred: {
          planned: 3, created: 2,
          createdRefs: [{ index: 1, title: '定位问题', id: 'd1' }, { index: 2, title: '修复脚本', id: 'd2' }],
          remaining: [{ index: 3, title: '验证修复结果', description: '跑一遍验证', acceptance_criteria: '通过', dependsOn: [2] }],
        },
      },
    });
    addTask(db, { id: 'd1', project: 'proj', title: '定位问题', status: 'completed', parent: 'pD' });
    addTask(db, { id: 'd2', project: 'proj', title: '修复脚本', status: 'completed', parent: 'pD' });
    addTask(db, { id: 'd3', project: 'proj', title: '验证修复结果', status: 'completed', parent: 'pD' });
    const before = childCount(db, 'pD');
    const r = createDeferredSubtasks(db as never, { parentTaskId: 'pD', projectId: 'proj' });
    eq(r, { created: 0, remaining: 0 }, 'C-1 ★标本那股余量 ⇒ 零新建、余量归零（不再造第三个同名子）');
    eq(childCount(db, 'pD'), before, 'C-2 子任务行数不变（0 新增）');
    eq(deferredStateOf(db as never, 'pD'), null, 'C-3 余量键被删（不留空壳，父按既有路径被唤醒）');
    const roll = convsOf(db, 'pD').filter((c) => c.startsWith('[续拆]'));
    eq(roll.length, 1, 'C-4 续拆会话行 0→1（如实说"已并入"）');
    ok(roll[0]?.includes('同名') && roll[0]?.includes('不重复建'), 'C-5 那句话点名"同名已并入、不重复建"');
    eq(ctxOf(db, 'pD').goal_summary, '兄弟键', 'C-6 清余量不抹兄弟键');
  }
  {
    // C-7..C-11 混合股：同名项并入既有 id，新项照建，依赖边解析到既有行（不悬空）。
    const db = mkdb();
    addProject(db, 'proj');
    addTask(db, {
      id: 'pE', project: 'proj', title: '混合续拆', status: 'paused',
      ctx: {
        decomposition_deferred: {
          planned: 4, created: 2,
          createdRefs: [{ index: 1, title: '定位问题', id: 'e1' }, { index: 2, title: '修复脚本', id: 'e2' }],
          remaining: [
            { index: 3, title: '验证  修复结果', description: '跑验证', acceptance_criteria: '通过', dependsOn: [2] },
            { index: 4, title: '整理交付说明', description: '写说明', acceptance_criteria: '可读', dependsOn: [3] },
          ],
        },
      },
    });
    addTask(db, { id: 'e1', project: 'proj', title: '定位问题', status: 'completed', parent: 'pE' });
    addTask(db, { id: 'e2', project: 'proj', title: '修复脚本', status: 'completed', parent: 'pE' });
    // 空白差异不影响同名判定（规范化后相等）
    addTask(db, { id: 'e3', project: 'proj', title: '验证 修复结果', status: 'completed', parent: 'pE' });
    const r = createDeferredSubtasks(db as never, { parentTaskId: 'pE', projectId: 'proj' });
    eq(r.created, 1, 'C-7 ★只建"新项"1 个（同名项并入，不重造）');
    eq(r.remaining, 0, 'C-8 余量清空');
    const st = deferredStateOf(db as never, 'pE');
    eq(st, null, 'C-9 余量键被删');
    const made = db.prepare("SELECT id, title, depends_on FROM wa_tasks WHERE parent_task_id = 'pE' AND title = '整理交付说明'").get() as
      { id: string; title: string; depends_on: string } | undefined;
    ok(!!made, 'C-10 新项真被建出（0→1 正面断言）');
    ok(!!made && made.depends_on.split(',').includes('e3'),
      'C-11 ★跨批前置解析到**既有行**的真实 id（序号 3 ⇒ e3，不悬空）', made?.depends_on);
  }
  {
    // C-12..C-13 反证：归档 = 放弃；同名的新活允许重开，不并入已放弃的行。
    const db = mkdb();
    addProject(db, 'proj');
    addTask(db, {
      id: 'pF', project: 'proj', title: '归档同名', status: 'paused',
      ctx: { decomposition_deferred: { planned: 1, created: 0, createdRefs: [], remaining: [
        { index: 1, title: '验证修复结果', description: 'x', acceptance_criteria: 'y' },
      ] } },
    });
    addTask(db, { id: 'f1', project: 'proj', title: '验证修复结果', status: 'archived', parent: 'pF' });
    const r = createDeferredSubtasks(db as never, { parentTaskId: 'pF', projectId: 'proj' });
    eq(r.created, 1, 'C-12 ★归档行不参与同名判定（同名的新活照建）');
    eq(childCount(db, 'pF'), 2, 'C-13 既有归档行保留 + 新行在册');
  }
  {
    // C-14..C-16 既有未建余量账不被本轮新模板覆写（标本里那条账正是这么留下的）。
    const db = mkdb();
    addProject(db, 'proj');
    addTask(db, {
      id: 'pG', project: 'proj', title: '规划八件', description: '按方案推进', ctx: {
        depth: 0,
        decomposition_deferred: {
          planned: 2, created: 1,
          createdRefs: [{ index: 1, title: '旧一', id: 'old1' }],
          remaining: [{ index: 2, title: '旧账待建', description: 'x', acceptance_criteria: 'y' }],
        },
      },
    });
    const items = Array.from({ length: 8 }, (_, i) => ({
      title: `阶段${i + 1}`, description: `第 ${i + 1} 步`, acceptance_criteria: `第 ${i + 1} 步可核对`, purpose: '推进父目标',
    }));
    const deps: DecomposeDeps = {
      async resolveModel() { return { url: 'http://stub', api_key: 'k', model_name: 'stub' }; },
      async chat() { return { ok: true as const, text: JSON.stringify(items) }; },
    };
    const r = await autoDecomposeForTask({
      db: db as never, taskId: 'pG', projectId: 'proj', goal: '按方案推进八件', depth: 0,
      getDeps: async () => deps, label: '任务启动', noDepWhen: '立即启动',
    });
    ok(!!r && r.created > 0 && r.created < r.planned, 'C-14 本轮实建少于规划（广度闸触发）',
      r ? `${r.created}/${r.planned}` : 'null');
    const st = deferredStateOf(db as never, 'pG');
    eq(st?.remaining.map((x) => x.title), ['旧账待建'], 'C-15 ★既有未建余量账仍在（未被本轮新模板盖掉）');
    const conv = convsOf(db, 'pG').join('\n');
    ok(conv.includes('已登记'), 'C-16 余量账在册时如实说"已登记"');
  }
  {
    // C-17..C-19 两句余量文案各自说真话（登记的才承诺；并说明它何时失效）。
    const d = shortfallNotice(3, 1, undefined, { deferred: true });
    ok(d.includes('已登记') && d.includes('自动续建'), 'C-17 已登记 ⇒ 说"自动续建"（既有判据的两个词保留）');
    ok(d.includes('卡住不动') && d.includes('人工处置'), 'C-18 ★补上承诺的失效边界：卡住不动 ⇒ 续建不会发生、需人工');
    const plain = shortfallNotice(3, 1);
    ok(!plain.includes('自动续建'), 'C-19 反证：没登记的那支不承诺自动续建');
    ok(plain.includes('未建、亦未自动排期'), 'C-20 没登记的那支如实说"未自动排期"');
    eq(shortfallNotice(3, 3), '', 'C-21 建满不报缺');
  }

  // ═══ D｜失败说人话（M4） ═════════════════════════════════════════════════════
  console.log('\n【D】M4 失败文案：说清怎么办，原文不丢');
  {
    const ff = describeExecutionError(new Error('fetch failed'));
    ok(ff.includes('fetch failed'), 'D-1 ★原文 `fetch failed` 仍以子串在场（日志/旧断言检索不丢）');
    ok(ff.includes('ANS') && ff.includes('pnpm dev:ans'), 'D-2 ★说清怎么办：先启动 ANS', ff.slice(0, 40));
    const ec = describeExecutionError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:27183'), { code: 'ECONNREFUSED' }));
    ok(ec.includes('ECONNREFUSED') && ec.includes('ANS'), 'D-3 ECONNREFUSED 同族同译（原文保留）');
    const s = describeExecutionError('socket hang up');
    ok(s.includes('socket hang up') && s.includes('ANS'), 'D-4 字符串形态的错误同样处理');
    const ua = describeExecutionError(new Error('401 Unauthorized'));
    ok(ua.includes('API Key') && ua.includes('401 Unauthorized'), 'D-5 鉴权失败指向「模型」页密钥（原文保留）');
    const rl = describeExecutionError(new Error('429 Too Many Requests'));
    ok(rl.includes('限流') && rl.includes('429'), 'D-6 限流给出稍后重试的走法');
    eq(describeExecutionError(new Error('endpoint boom')), 'endpoint boom', 'D-7 反证：不相干的错误逐字返回（不瞎翻）');
    eq(describeExecutionError(''), '未知错误', 'D-8 空错误不编内容');
  }
  {
    // D-9/D-10 接线：执行器的 catch 与失败落账同取这一处话术
    const ex = CODE(`${A}/src/main/core/agent-executor.ts`);
    ok(/const errorMsg = describeExecutionError\(err\);/.test(ex),
      'D-9 执行器 catch 用 describeExecutionError 生成落账/日志文案（接线不在等价自造里）');
    const ai = CODE(`${A}/src/main/core/jobs/ai-task.ts`);
    ok(/const msg = describeExecutionError\(err\)\.slice\(0, 300\);/.test(ai),
      'D-10 失败落账同源（不各写一份翻译）');
  }

  // ═══ E｜停摆必出声（M5） ═════════════════════════════════════════════════════
  console.log('\n【E】M5 停摆必出声：写一次说明，不重复说');
  {
    const db = mkdb();
    addProject(db, 'proj');
    // 该喊：父等子、子一停一被停住的前置挡住（标本三态）。
    addTask(db, {
      id: 'pStall', project: 'proj', title: '等子父', status: 'paused',
      ctx: { pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE },
    });
    addTask(db, { id: 's1', project: 'proj', title: '验证修复结果', status: 'paused', parent: 'pStall', ctx: { pause_reason: PAUSE_REASON_NO_OUTPUT } });
    addTask(db, { id: 's2', project: 'proj', title: '整理交付说明', status: 'pending', parent: 'pStall', deps: 's1' });
    // 不该喊：仍有在途子。
    addTask(db, {
      id: 'pMoving', project: 'proj', title: '还有人在动', status: 'paused',
      ctx: { pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE },
    });
    addTask(db, { id: 'm1', project: 'proj', title: '还在跑', status: 'executing', parent: 'pMoving' });
    // 不该喊：pending 子无前置（它自己会跑）。
    addTask(db, {
      id: 'pRunnable', project: 'proj', title: '子可跑', status: 'paused',
      ctx: { pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE },
    });
    addTask(db, { id: 'r1', project: 'proj', title: '可立即动工', status: 'pending', parent: 'pRunnable' });
    // 不该喊：父不是因等子而停（用户在停）。
    addTask(db, {
      id: 'pUser', project: 'proj', title: '用户在停', status: 'paused',
      ctx: { pause_reason: PAUSE_REASON_USER_INTERRUPT },
    });
    addTask(db, { id: 'u1', project: 'proj', title: '被人停的子', status: 'paused', parent: 'pUser', ctx: { pause_reason: PAUSE_REASON_USER_INTERRUPT } });

    const r1 = noticeStalledWaitingParents(db as never);
    eq(r1.noticed, ['pStall'], 'E-1 ★只有"父等子且子树全停"的那一个被点名（两侧标本）');

    const note = recordedPauseNote(JSON.stringify(ctxOf(db, 'pStall')));
    ok(note.includes('[停摆]'), 'E-2 停摆说明写进 `$.pause_note`（0→1）');
    ok(note.includes('「验证修复结果」已暂停（无产出）'), 'E-3 逐子点名：暂停的子带人话因由');
    ok(note.includes('「整理交付说明」无法启动'), 'E-4 逐子点名：被死前置挡住的子说"无法启动"');
    ok(note.includes('①') && note.includes('②') && note.includes('③'), 'E-5 给三条可执行的处置路子');
    eq(convsOf(db, 'pStall').filter((c) => c.startsWith('[停摆]')).length, 1, 'E-6 `[停摆]` 系统会话行 0→1');
    eq(healingCount(db), 1, 'E-7 自愈账 0→1（outcome=recorded，可查）');

    for (const id of ['pMoving', 'pRunnable', 'pUser']) {
      eq(recordedPauseNote(JSON.stringify(ctxOf(db, id))), '', `E-8 ${id} 零写（还有路可走 / 不是等子暂停）`);
    }

    const r2 = noticeStalledWaitingParents(db as never);
    eq(r2.noticed, [], 'E-9 同签名再扫不重复说（签名去重）');
    eq(convsOf(db, 'pStall').filter((c) => c.startsWith('[停摆]')).length, 1, 'E-10 会话行不刷屏');
    eq(healingCount(db), 1, 'E-11 自愈账不虚增');
  }
  {
    const txt = stallNoticeText([
      { id: 'a', title: '甲', state: 'paused', why: '无产出' },
      { id: 'b', title: '乙', state: 'blocked', why: '前置已失败：丙' },
    ]);
    ok(txt.startsWith('[停摆]'), 'E-12 文案开宗明义');
    ok(txt.includes('「甲」已暂停（无产出）') && txt.includes('「乙」无法启动（前置已失败：丙）'),
      'E-13 停因与挡因分别说清');
    ok(txt.includes('不会自动恢复') && txt.includes('不会再自动派发'),
      'E-14 ★如实说明"等下去没有结果"（这正是旧实现让人误以为"还在等"的那一格）');
  }

  // ═══ F｜读点同源（M5 渲染层） ═══════════════════════════════════════════════
  console.log('\n【F】M5 渲染层：暂停附注有读点且不手抄键名');
  {
    const page = CODE(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
    ok(/import \{[^}]*recordedPauseNote[^}]*\} from '\.\.\/\.\.\/\.\.\/src\/main\/core\/pause-reason\.js'/.test(page),
      'F-1 ★跨 root 直引 `recordedPauseNote`（键名不在渲染层手抄）');
    ok(/const pauseNote = task\?\.status === 'paused' \? recordedPauseNote\(task\.context_json\) : '';/.test(page),
      'F-2 仅暂停态读取（按状态词派生，不猜）');
    ok(/\{pauseNote && <p /.test(page), 'F-3 ★附注真被渲染（写了不显示等于没写）');
    ok(!/\.pause_note\b/.test(page) && !/['"]pause_note['"]/.test(page),
      'F-4 反证：渲染层零处直接摸 `pause_note`（唯一读点在 pause-reason.ts）');
    const pr = CODE(`${A}/src/main/core/pause-reason.ts`);
    ok(/export function recordedPauseNote\(contextJson: string \| null \| undefined\): string \{/.test(pr),
      'F-5 读点真实现导出（rr 与渲染层同引一份）');
  }

  // ═══ S｜哑雷自检 + build 钉 ═══════════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfPath = `scripts/${path.basename(__filename)}`;
    const selfLines = stripKeepingLines(RD(selfPath)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6）', selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 方向性自指：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)), 'S3 本套件在册（脚本名由载体派生）');

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告
//   unhandled rejection 之前把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\nrr_${SELF_ROUND} 未捕获异常（复跑未跑完，不得读作通过）：`, e);
  fail++;
  console.log(`\nFAIL rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
