/**
 * zx_20261110_2 B3 复跑 —— 「恒」：**状态词写着在跑，不等于真在跑**。
 *
 * 真标本（事故 339ef167，2026-11-10）：`wa_tasks.status = 'executing'`，而没有任何执行体在跑
 * （handler 永不返回）。用户点「恢复」→ 处理器只读状态词就 `return`（"已在执行"）⇒ **点了什么都不发生**；
 * GUI 也只读状态词 ⇒ 一直显示在跑。同一个词，两个用法：库里是"曾经置过"，界面读成"此刻在跑"。
 *
 * 本轮治法：执行态是**派生量**（`exec-state.ts` 纯函数），恢复入口的**动作**也由它一处裁决
 * （`resumeAction`）；幽灵自动接管有账有顶（`exec-ghost.ts`）；到顶出声（会话行 + 置暂停）。
 *
 * 判据（对应方案 §B3 的五条验收 + 接线在册）：
 *   R-1 `live`   ⇒ `skip_live`（真有在途 run 才跳）；
 *   R-2 `ghost`  ⇒ `ghost`（**不跳**），且 `excludeRunning` 不摘自己那条时判不出来（两只标本）；
 *   R-3 `terminal` ⇒ `skip_terminal`；`idle` ⇒ `proceed`（终态不复活、无作业可跑则照常往下走）；
 *   R-4 `queued` 且**有 pending 兄弟** ⇒ `yield_sibling`（让位给更新的那条）；只有 running 作业行 ⇒ `proceed`；
 *   R-5 幽灵接管**有账有顶**：第 1、2 次照常接管，第 3 次到顶；兄弟键不被覆写；到顶落会话行 + 置暂停。
 *
 * 纪律（承 auto-memory）：
 *   G-1 真源直 import（`readExecState` / `resumeAction` / `bumpGhostRequeueCount` / `pauseTask` 本尊），
 *       判定不复刻第二份 SQL；
 *   G-2 两只标本（该判 ghost 的判成 ghost **且** 该判 live 的仍判 live）；
 *   G-3 计数器断言有 0→1 正面；
 *   G-6 无轮次字面量（轮次由 `path.basename(__filename)` 派生，只做方向性比较）；
 *   ⚠ 判据文案不得含失败字形（全量汇总器按字形计失败数）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines, buildNotOlderThan } from './lib/rr-pins.js';
import { readExecState } from '../apps/worker-ant-desktop/src/main/core/exec-state-read.js';
import { deriveExecState, resumeAction } from '../apps/worker-ant-desktop/src/main/core/exec-state.js';
import {
  GHOST_REQUEUE_CAP, bumpGhostRequeueCount, ghostCapReached, ghostSelfHealStopLine, readGhostRequeueCount,
} from '../apps/worker-ant-desktop/src/main/core/exec-ghost.js';
import { registerTaskRun, unregisterTaskRun } from '../apps/worker-ant-desktop/src/main/core/task-run-registry.js';
import { pauseTask } from '../apps/worker-ant-desktop/src/main/core/pause-task.js';
import { PAUSE_REASON_GHOST_LOOP, pauseReasonLabel } from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';

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
/** G-6：轮次由**载体自身**派生（批次后缀属批次、不属轮次，须剥掉）。 */
const SELF_ROUND = /^(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''))?.[1] ?? '';
const A = 'apps/worker-ant-desktop';
const CODE = (rel: string) => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');

const SCHEMA = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'active',
  working_dir TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '', source TEXT DEFAULT 'user',
  acceptance_criteria TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_event_log (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, aggregate_type TEXT DEFAULT '',
  aggregate_id TEXT DEFAULT '', payload TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
`;

function mkdb(): AnyDb {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db as unknown as AnyDb;
}

/** 固定假时钟基准（无"某个真实时间窗"依赖）。 */
const T0 = Date.parse('2026-11-10T05:00:00Z');
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function addTask(db: AnyDb, id: string, status: string, ctx: Record<string, unknown> = {}): void {
  db.prepare("INSERT OR IGNORE INTO wa_projects (id, name) VALUES ('p1', '项目')").run();
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'p1', `任务 ${id}`, status, JSON.stringify(ctx));
}
function addJob(db: AnyDb, id: string, taskId: string, status: string, createdMs: number, type = 'resume-ai-task'): void {
  db.prepare('INSERT INTO wa_jobs (id, type, payload, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, type, JSON.stringify({ taskId }), status, utc(createdMs));
}
const statusOf = (db: AnyDb, id: string) => (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
const ctxOf = (db: AnyDb, id: string): Record<string, unknown> =>
  JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}');

async function main(): Promise<void> {
  // ═══ K｜构建钉 ═══════════════════════════════════════════════════════════
  console.log('\n【K】构建钉（P1–P6，P6 读 dist 产物）');
  {
    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
    // 方向性比较：当前 build 快照**不早于**本脚本轮次（不是 `===` 那种只对下一轮引爆的哑雷）。
    const src = fs.readFileSync(path.join(root, `${A}/src/main/core/agent-executor.ts`), 'utf-8');
    const tag = /build:\s*'(zx_[0-9_]+)'/.exec(stripKeepingLines(src).join('\n'))?.[1] ?? '';
    ok(!!tag && buildNotOlderThan(tag, SELF_ROUND), 'K-7 当前 build 快照不早于本脚本轮次（方向性比较）', `${tag} vs ${SELF_ROUND}`);
  }

  // ═══ R-1｜live 才跳 ═════════════════════════════════════════════════════
  console.log('\n【R-1】`live`：真有在途 run ⇒ 跳过（这一条压过状态词）');
  {
    const db = mkdb();
    addTask(db, 't-live', 'executing');
    ok(!readExecState(db as never, 't-live', { nowMs: T0 }).hasLiveRun, 'R-1a 前置：登记前无在途 run');
    registerTaskRun('t-live', { abort: () => {} } as unknown as Parameters<typeof registerTaskRun>[1]);
    const snap = readExecState(db as never, 't-live', { nowMs: T0 });
    eq(snap.state, 'live', 'R-1b ★ 有在途 run ⇒ `live`（状态词写着 executing 也一样，另一只标本见 R-2）');
    eq(resumeAction(snap, snap.pendingExecJobs), 'skip_live', 'R-1c 动作为 `skip_live`（真在跑才跳，不误伤幽灵）');
    unregisterTaskRun('t-live');
    eq(readExecState(db as never, 't-live', { nowMs: T0 }).state, 'ghost',
      'R-1d 反证：同一个任务摘掉 run 后**当场**变成 `ghost` ⇒ 判据真的看 run，不是看状态词');
  }

  // ═══ R-2｜ghost 必须往下走 ══════════════════════════════════════════════
  console.log('\n【R-2】`ghost`：状态词写着在跑、实则无执行体 ⇒ **不跳**（事故 339ef167 的正解）');
  {
    const db = mkdb();
    addTask(db, 't-ghost', 'executing');
    const snap = readExecState(db as never, 't-ghost', { nowMs: T0 });
    eq(snap.state, 'ghost', 'R-2a ★ executing + 无 run + 无作业 ⇒ `ghost`');
    eq(snap.reason, 'ghost_no_job', 'R-2b 因由点名"没有作业"，不是一个含糊的词');
    eq(resumeAction(snap, snap.pendingExecJobs), 'ghost', 'R-2c 动作为 `ghost` ⇒ 处理器**继续往下走**，不再 `return`');

    // 两只标本：`excludeRunning` 摘不摘自己那条，结论必须相反——否则"幽灵永远判不出来"
    addTask(db, 't-self', 'executing');
    addJob(db, 'j-self', 't-self', 'running', T0 - 1_000);
    const withSelf = readExecState(db as never, 't-self', { nowMs: T0 });
    const withoutSelf = readExecState(db as never, 't-self', { nowMs: T0, excludeRunning: 1 });
    eq(withSelf.state, 'queued', 'R-2d 不摘自己那条 ⇒ 看到"有 1 条 running 作业"，判成 `queued`');
    eq(withoutSelf.state, 'ghost', 'R-2e ★ 摘掉自己那条 ⇒ 才是真相 `ghost`（处理器必须带 `excludeRunning: 1`）');
    eq(resumeAction(withoutSelf, withoutSelf.pendingExecJobs), 'ghost', 'R-2f 摘掉之后动作是 `ghost`（不跳）');

    // preparing / running 同属 running 族：同样是无执行体就是幽灵
    addTask(db, 't-prep', 'preparing');
    addTask(db, 't-run', 'running');
    eq(readExecState(db as never, 't-prep', { nowMs: T0 }).state, 'ghost', 'R-2g `preparing` 同族同判');
    eq(readExecState(db as never, 't-run', { nowMs: T0 }).state, 'ghost', 'R-2h `running` 同族同判');
  }

  // ═══ R-3｜terminal / idle ═══════════════════════════════════════════════
  console.log('\n【R-3】终态不复活；无作业可跑则照常往下走');
  {
    const db = mkdb();
    for (const st of ['completed', 'failed', 'archived']) {
      addTask(db, `t-${st}`, st);
      const s = readExecState(db as never, `t-${st}`, { nowMs: T0 });
      eq([s.state, resumeAction(s, s.pendingExecJobs)], ['terminal', 'skip_terminal'], `R-3 ${st} ⇒ terminal/skip_terminal`);
    }
    addTask(db, 't-paused', 'paused');
    const idle = readExecState(db as never, 't-paused', { nowMs: T0 });
    eq(idle.state, 'idle', 'R-3d 暂停且无作业 ⇒ `idle`');
    eq(resumeAction(idle, idle.pendingExecJobs), 'proceed', 'R-3e 动作 `proceed`（恢复暂停的正常路径不因本批而变）');
  }

  // ═══ R-4｜queued 的两种来源处置相反 ═════════════════════════════════════
  console.log('\n【R-4】`queued`：有更新的 pending 兄弟 ⇒ 让位；只有 running 作业行 ⇒ 继续');
  {
    const db = mkdb();
    addTask(db, 't-q1', 'paused');
    addJob(db, 'j-q1', 't-q1', 'pending', T0 - 5_000);
    const q1 = readExecState(db as never, 't-q1', { nowMs: T0 });
    eq([q1.state, q1.pendingExecJobs], ['queued', 1], 'R-4a 有 1 条 pending 兄弟 ⇒ `queued`');
    eq(resumeAction(q1, q1.pendingExecJobs), 'yield_sibling',
      'R-4b ★ 让位（本次是队列里靠前的那条；让给后者才用得上最新的那句话，也不会同一件事做两遍）');

    addTask(db, 't-q2', 'executing');
    addJob(db, 'j-q2', 't-q2', 'running', T0 - 5_000);
    const q2 = readExecState(db as never, 't-q2', { nowMs: T0 });
    eq([q2.state, q2.pendingExecJobs], ['queued', 0], 'R-4c 只有 running 作业行、无 pending ⇒ 仍 `queued` 但 pending 数为 0（另一只标本）');
    eq(resumeAction(q2, q2.pendingExecJobs), 'proceed', 'R-4d 动作为 `proceed`（没有在途 run 的 running 行是幽灵的另一面）');

    // 超龄作业不算"排上了"：宽限外的 pending 会让 queued 退成 ghost（否则 stale 作业能永远冒充在跑）
    addTask(db, 't-q3', 'executing');
    addJob(db, 'j-q3', 't-q3', 'pending', T0 - 10 * 60_000);
    const q3 = readExecState(db as never, 't-q3', { nowMs: T0 });
    eq(q3.state, 'ghost', 'R-4e ★ 超龄（10 分钟）的 pending 作业不算"排在跑" ⇒ 判 `ghost`（否则陈旧作业能永远冒充执行中）');
    eq(q3.reason, 'ghost_stale_jobs:1', 'R-4f 因由如实说是"有陈旧作业"');
  }

  // ═══ R-5｜幽灵接管有账有顶 ═════════════════════════════════════════════
  console.log('\n【R-5】幽灵自动接管：记账、封顶、到顶出声');
  {
    // 纯判据
    eq(GHOST_REQUEUE_CAP, 2, 'R-5a 上界常量 = 2（方案 §6 同一把尺）');
    eq([ghostCapReached(1), ghostCapReached(2), ghostCapReached(3)], [false, false, true],
      'R-5b ★ 第 1、2 次照常接管，第 3 次才停（`>` 而非 `>=`，边界说清）');

    const db = mkdb();
    addTask(db, 't-g', 'executing', { attachments: [{ name: 'a.pdf' }], goal: '把报表做完', archetype: 'analysis' });
    eq(readGhostRequeueCount(db as never, 't-g'), 0, 'R-5c 前置 0 态（计数器正面断言的起点）');
    eq(bumpGhostRequeueCount(db as never, 't-g'), 1, 'R-5d ★ 0→1：第一次接管如实记 1');
    eq(bumpGhostRequeueCount(db as never, 't-g'), 2, 'R-5e 第二次记 2');
    eq(bumpGhostRequeueCount(db as never, 't-g'), 3, 'R-5f 第三次记 3（到顶由判据裁定，账照记）');
    const after = ctxOf(db, 't-g');
    eq(after.ghostRequeueCount, 3, 'R-5g 账落在 `context_json.ghostRequeueCount`');
    eq(after.attachments, [{ name: 'a.pdf' }], 'R-5h ★ 兄弟键 `attachments` 仍在（读-改-写，不是裸对象覆写）');
    eq(after.goal, '把报表做完', 'R-5i ★ 兄弟键 `goal` 仍在');
    eq(after.archetype, 'analysis', 'R-5j ★ 兄弟键 `archetype` 仍在（裸覆写会静默抹掉，本仓已复发三次）');
    ok(ghostCapReached(readGhostRequeueCount(db as never, 't-g')), 'R-5k 读回的账也判到顶（写读同源）');

    // 坏 JSON：**不覆写**、按"已到顶"处置（fail-closed）——把读不懂的账覆写成 `{}` 会抹掉兄弟键
    db.prepare("UPDATE wa_tasks SET context_json = 'not-json' WHERE id = ?").run('t-g');
    eq(bumpGhostRequeueCount(db as never, 't-g'), GHOST_REQUEUE_CAP + 1,
      'R-5l ★ 坏 JSON ⇒ 返回"已到顶"（fail-closed：宁可停下让人看见，也不假装接管成功）');
    eq((db.prepare('SELECT context_json AS c FROM wa_tasks WHERE id = ?').get('t-g') as { c: string }).c, 'not-json',
      'R-5l2 ★ 坏账**原样留着**（覆写成 `{}` 等于亲手抹掉可能还在的兄弟键）');

    // 到顶的处置（真 `pauseTask` 本尊 + 会话行文案一处真源）
    const line = ghostSelfHealStopLine(GHOST_REQUEUE_CAP);
    ok(line.includes('自动接管') && line.includes('手动恢复'), 'R-5m 到顶文案说人话（说清停了、说清怎么办）', line.slice(0, 24) + '…');
    ok(!/[✗✓]/.test(line), 'R-5n 文案不含失败字形（全量汇总器按字形计失败数）');
    addTask(db, 't-cap', 'executing');
    pauseTask(db, { taskId: 't-cap', reason: PAUSE_REASON_GHOST_LOOP });
    eq(statusOf(db, 't-cap'), 'paused', 'R-5o ★ 到顶 ⇒ 置暂停（不再假装在跑）');
    eq(ctxOf(db, 't-cap').pause_reason, PAUSE_REASON_GHOST_LOOP, 'R-5p ★ 因由码落账 = `ghost_loop_cap`（不是无因暂停）');
    ok(pauseReasonLabel(PAUSE_REASON_GHOST_LOOP).includes('无执行体'),
      'R-5q 该因在词表里有可上屏的 label（GUI 与 IM 同源取它）');
  }

  // ═══ R-6｜派生量本身（纯函数，次序即语义） ═════════════════════════════
  console.log('\n【R-6】派生次序：终态 > live > queued > ghost > idle');
  {
    const base = { dbStatus: 'executing', hasLiveRun: false, pendingExecJobs: 0, runningExecJobs: 0, oldestJobAgeMs: null };
    eq(deriveExecState({ ...base, dbStatus: 'completed', hasLiveRun: true }).state, 'terminal',
      'R-6a 终态压过一切（哪怕还有在途 run，任务也已了结）');
    eq(deriveExecState({ ...base, hasLiveRun: true, pendingExecJobs: 3, oldestJobAgeMs: 0 }).state, 'live',
      'R-6b live 压过作业数（真在跑就是真在跑）');
    eq(deriveExecState({ ...base, dbStatus: 'paused', pendingExecJobs: 1, oldestJobAgeMs: 1_000 }).state, 'queued',
      'R-6c 宽限内的作业 ⇒ queued（刚入队不能一入队就判幽灵）');
    eq(deriveExecState({ ...base, dbStatus: 'paused', pendingExecJobs: 1, oldestJobAgeMs: 999_999 }).state, 'idle',
      'R-6d 非 running 族的任务即便挂着超龄作业也只是 idle（不冒充幽灵，也不冒充在跑）');
    eq(deriveExecState({ ...base, oldestJobAgeMs: 999_999, pendingExecJobs: 1 }).state, 'ghost',
      'R-6e running 族 + 超龄作业 ⇒ ghost（状态词空着）');
  }

  // ═══ R-7｜接线在册 ══════════════════════════════════════════════════════
  console.log('\n【R-7】三处调用方真接上了（不是只建了文件）');
  {
    const ait = CODE(`${A}/src/main/core/jobs/ai-task.ts`);
    ok(/readExecState\(db as never, taskId, \{ excludeRunning: 1 \}\)/.test(ait),
      'R-7a 恢复入口按派生态取数，且**摘掉自己那条作业**（否则幽灵永远判不出来）');
    ok(/const action = resumeAction\(exec, exec\.pendingExecJobs\)/.test(ait),
      'R-7b 动作由纯函数一处裁决（处理器不再自己看状态词）');
    ok(/if \(action === 'skip_live'\)/.test(ait) && /if \(action === 'yield_sibling'\)/.test(ait) && /if \(action === 'ghost'\)/.test(ait),
      'R-7c 三条分支都在（跳过 / 让位 / 接管），不是一个 switch 里只写了一半');
    ok(/ghostCapReached\(ghostCount\)/.test(ait) && /ghostSelfHealStopLine\(GHOST_REQUEUE_CAP\)/.test(ait)
      && /pauseTask\(db, \{ taskId, reason: PAUSE_REASON_GHOST_LOOP \}\)/.test(ait),
      'R-7d 到顶三件事齐：判到顶 / 落会话行（文案一处真源）/ 置暂停');
    ok(/status = 'pending'.{0,80}WHERE id = \? AND status = 'executing'/.test(ait),
      'R-7e 幽灵的状态词**用 CAS 归位**（`executing` 不在可抢占集里，不归位则 CAS 必 0 行、恢复照样白点一次）');
    ok(/!hasTaskRun\(taskId\)/.test(ait),
      'R-7f 归位前复核"是不是刚有真 run 起来"（把 read 与 CAS 之间的窗口缩到最小）');

    const ipc = CODE(`${A}/src/main/ipc/project.ipc.ts`);
    ok(/execState = \{ state: es\.state, reason: es\.reason \}/.test(ipc),
      'R-7g `task:get` 回传派生执行态（界面不再只读状态词）');
    ok(/preExec\?\.state === 'ghost'[\s\S]{0,400}_taskRunReleaser\(id, 'released_by_ghost_start'\)/.test(ipc),
      'R-7h `task:updateStatus("running")`：幽灵先释放残留作业与在途键，再入队（否则 `hasPendingExecutionJob` 挡死）');
    ok(/ghostResumable = resumeExec\?\.state === 'ghost'/.test(ipc) && /released_by_ghost_resume/.test(ipc),
      'R-7i `task:resume` 接受幽灵态，恢复前释放内存键（只清库行会留一把占位键）');
    ok(/resumedFromGhost: ghostResumable/.test(ipc),
      'R-7j 回执如实标出这次接管的是不是幽灵（界面可据此说人话）');

    const idx = CODE(`${A}/src/main/index.ts`);
    ok(/setTaskRunReleaser\(\(taskId, reason\) => scheduler\.releaseTaskRun\(taskId, reason\)\)/.test(idx),
      'R-7k 释放口由装配层接线（内存在途表在调度器里，别处清不到）');

    const pr = CODE(`${A}/src/main/core/pause-reason.ts`);
    ok(/export const PAUSE_REASON_GHOST_LOOP = 'ghost_loop_cap'/.test(pr) && /\| typeof PAUSE_REASON_GHOST_LOOP/.test(pr),
      'R-7l 因由码进词表**且在联合类型里**（否则 `pauseTask` 的强类型落不下它）');
    ok(/PAUSE_REASON_GHOST_LOOP\]:/.test(pr), 'R-7m 该因有 label（有值才能上屏）');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
