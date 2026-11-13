/**
 * zx_20261110_2 B7 复跑 —— 「看得见」：执行态四态上屏、"最后进展 / 已卡多久"、幽灵态的人工出口。
 *
 * 病根（事故 `339ef167`）：界面只有 DB 状态词。任务状态写着 `running`，实则既无在途执行体、
 * 也无活着的执行作业——用户看到的是"在跑"，引擎那边是"早就没人了"。按下「恢复」被静默跳过，
 * 界面仍在动。**看得见才谈得上管得住**：状态词是"账上怎么说"，执行态是"此刻到底有没有人在做"，
 * 两者是两件事，必须并排给人看。
 *
 * 判据（与方案 §B7 对齐）：
 *   E-1 `deriveExecState` 五态各归其位（终态压过一切 / live 压过状态词 / 排队宽限 / ghost 仅 running 族 / 其余空闲）；
 *   P-1 时间换算：库内 UTC 两种写法都认、坏值不猜（`null` 而不是 0 或"刚刚"）；
 *   P-2 最后进展 = 三本账（事件 / 对话 / 作业）取最大；一本都读不到 ⇒ `null`；
 *   P-3 已卡时长**只在** live/ghost 有意义（queued/idle/terminal 算"卡"是诬告）；
 *   P-4 `readProgressAt` 真读库：缺表不炸（空账），有行则取到真值（0→1 的正面断言，不只"不抛"）；
 *   W-1 静态接线：`task:get` 回传四个派生键、`task:releaseAndRequeue` 已注册且三重校验、
 *       renderer 侧有同名方法、详情页只在 ghost 态给按钮、按钮真调那个方法；
 *   W-2 「不新增轮询」：本页没有为执行态另起定时器（复用的是既有的按事件重载）。
 *
 * 纪律：真源直 import（`deriveExecState` / `task-progress` / 渲染层词表本尊）；
 *       文案不含失败字形；无"只本轮为真"的字面量（轮次由 `path.basename(__filename)` 派生方向性比较）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines, buildNotOlderThan } from './lib/rr-pins.js';
import { deriveExecState, EXEC_QUEUE_GRACE_MS } from '../apps/worker-ant-desktop/src/main/core/exec-state.js';
import {
  utcMsOf, latestProgressMs, stuckMsOf, readProgressAt,
} from '../apps/worker-ant-desktop/src/main/core/task-progress.js';
import {
  execBadge, execBadgeVisible, execStateLine, durationText, progressAgoText, EXEC_STATE_LABEL,
} from '../apps/worker-ant-desktop/renderer/src/lib/exec-view.js';

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
const SELF_ROUND = /^(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''))?.[1] ?? '';
const A = 'apps/worker-ant-desktop';
const CODE = (rel: string) => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');

async function main(): Promise<void> {
  // ── E-1 执行态五态 ─────────────────────────────────────────────
  console.log('\n[E-1] deriveExecState 五态');
  {
    const base = { dbStatus: 'running', hasLiveRun: false, pendingExecJobs: 0, runningExecJobs: 0, oldestJobAgeMs: null };
    eq(deriveExecState({ ...base, dbStatus: 'completed', hasLiveRun: true }).state, 'terminal', 'E-1a 终态压过"在途执行体"');
    eq(deriveExecState({ ...base, dbStatus: 'failed' }).state, 'terminal', 'E-1b failed 也是终态');
    eq(deriveExecState({ ...base, hasLiveRun: true }).state, 'live', 'E-1c 有在途 run ⇒ live（压过状态词）');
    eq(deriveExecState({ ...base, dbStatus: 'paused', hasLiveRun: true }).state, 'live',
      'E-1d 暂停后收尾未完的执行体仍算 live（状态词不是唯一依据）');
    eq(deriveExecState({ ...base, pendingExecJobs: 1, oldestJobAgeMs: 1000 }).state, 'queued', 'E-1e 年轻作业在排 ⇒ queued');
    eq(deriveExecState({ ...base, pendingExecJobs: 1, oldestJobAgeMs: EXEC_QUEUE_GRACE_MS + 1 }).state, 'ghost',
      'E-1f 作业超龄 + running 族 ⇒ ghost');
    eq(deriveExecState({ ...base }).state, 'ghost', 'E-1g running 族且无 run 无作业 ⇒ ghost');
    eq(deriveExecState({ ...base, dbStatus: 'pending' }).state, 'idle', 'E-1h 非 running 族的非终态 ⇒ idle');
    eq(deriveExecState({ ...base }).reason, 'ghost_no_job', 'E-1i ghost 的因由可读（进任务详情 tooltip）');
  }

  // ── P-1 时间换算 ───────────────────────────────────────────────
  console.log('\n[P-1] 库内时刻换算');
  {
    const utc = utcMsOf('2026-11-11 02:03:04');
    eq(utc, Date.UTC(2026, 10, 11, 2, 3, 4), 'P-1a `YYYY-MM-DD HH:MM:SS` 按 UTC 解（与库内 datetime(\'now\') 同基准）');
    eq(utcMsOf('2026-11-11T02:03:04Z'), utc, 'P-1b ISO-Z 写法与空格写法同一时刻');
    eq(utcMsOf(''), null, 'P-1c 空串 ⇒ null（不猜成 0）');
    eq(utcMsOf(null), null, 'P-1d null ⇒ null');
    eq(utcMsOf('不是时间'), null, 'P-1e 坏值 ⇒ null');
  }

  // ── P-2 三本账取最大 ──────────────────────────────────────────
  console.log('\n[P-2] 最后进展 = 三本账取最大');
  {
    const e = '2026-11-11 01:00:00';
    const c = '2026-11-11 02:00:00';
    const j = '2026-11-11 03:00:00';
    eq(latestProgressMs({ eventAt: e, conversationAt: c, jobStartedAt: j }), Date.UTC(2026, 10, 11, 3, 0, 0),
      'P-2a 取最新那一本（作业）');
    eq(latestProgressMs({ eventAt: j, conversationAt: c, jobStartedAt: e }), Date.UTC(2026, 10, 11, 3, 0, 0),
      'P-2b 顺序无关（同样取最大）');
    eq(latestProgressMs({ eventAt: null, conversationAt: c, jobStartedAt: null }), Date.UTC(2026, 10, 11, 2, 0, 0),
      'P-2c 只有一本也有值');
    eq(latestProgressMs({ eventAt: null, conversationAt: null, jobStartedAt: null }), null,
      'P-2d 一本都读不到 ⇒ null（"不知道"不等于"很久没动"）');
  }

  // ── P-3 已卡时长只在 live/ghost 成立 ───────────────────────────
  console.log('\n[P-3] 已卡时长的适用范围');
  {
    const last = 1000;
    eq(stuckMsOf('live', last, 61_000), 60_000, 'P-3a live 有已卡时长');
    eq(stuckMsOf('ghost', last, 61_000), 60_000, 'P-3b ghost 有已卡时长');
    eq(stuckMsOf('queued', last, 61_000), null, 'P-3c queued 不算卡（只是还没轮到）');
    eq(stuckMsOf('idle', last, 61_000), null, 'P-3d idle 不算卡（本来就闲着）');
    eq(stuckMsOf('terminal', last, 61_000), null, 'P-3e terminal 不算卡（已了结）');
    eq(stuckMsOf('ghost', null, 61_000), null, 'P-3f 没有进展时刻 ⇒ 不给数字（不编一个 0）');
    eq(stuckMsOf('ghost', 61_000, 61_000), 0, 'P-3g 同一时刻 ⇒ 0 秒（真值，不是缺值）');
  }

  // ── P-4 readProgressAt 真读库 ─────────────────────────────────
  console.log('\n[P-4] readProgressAt 真读库');
  {
    const db = new DatabaseSync(':memory:') as unknown as AnyDb;
    // 先建行、后建表：先证明"缺表不炸"，再建表证明"有行取得到"（两面都验）
    const empty = readProgressAt(db as never, 't1', { state: 'ghost', nowMs: 10_000 });
    eq([empty.lastProgressAt, empty.stuckMs, empty.pendingJobAgeMs], [null, null, null],
      'P-4a 表都不在 ⇒ 空账（不抛、不编）');
    db.exec(`
      CREATE TABLE wa_event_log (aggregate_id TEXT, occurred_at TEXT);
      CREATE TABLE wa_task_conversations (task_id TEXT, created_at TEXT);
      CREATE TABLE wa_jobs (type TEXT, status TEXT, payload TEXT, started_at TEXT);
    `);
    const stillEmpty = readProgressAt(db as never, 't1', { state: 'ghost', nowMs: Date.UTC(2026, 10, 11, 4, 0, 0) });
    eq(stillEmpty.lastProgressAt, null, 'P-4b 表在但没有行 ⇒ 仍是 null');
    // zx 纪律：计数器/取值断言须有"从无到有"的正面断言
    db.prepare('INSERT INTO wa_event_log (aggregate_id, occurred_at) VALUES (?, ?)').run('t1', '2026-11-11 01:00:00');
    db.prepare('INSERT INTO wa_event_log (aggregate_id, occurred_at) VALUES (?, ?)').run('t1', '2026-11-11 02:00:00');
    db.prepare('INSERT INTO wa_event_log (aggregate_id, occurred_at) VALUES (?, ?)').run('other', '2026-11-11 09:00:00');
    db.prepare('INSERT INTO wa_task_conversations (task_id, created_at) VALUES (?, ?)').run('t1', '2026-11-11 01:30:00');
    db.prepare('INSERT INTO wa_jobs (type, status, payload, started_at) VALUES (?, ?, ?, ?)')
      .run('ai-task', 'running', '{"taskId":"t1"}', '2026-11-11 02:30:00');
    db.prepare('INSERT INTO wa_jobs (type, status, payload, started_at) VALUES (?, ?, ?, ?)')
      .run('ai-task', 'running', '{"taskId":"other"}', '2026-11-11 08:00:00');
    const nowMs = Date.UTC(2026, 10, 11, 3, 0, 0);
    const got = readProgressAt(db as never, 't1', { state: 'ghost', nowMs, pendingJobAgeMs: 42 });
    eq(got.lastProgressAt, new Date(Date.UTC(2026, 10, 11, 2, 30, 0)).toISOString(),
      'P-4c 取到三本账里的最大值（且只算本任务的作业）');
    eq(got.stuckMs, 30 * 60_000, 'P-4d 已卡 = now − 最后进展（30 分钟）');
    eq(got.pendingJobAgeMs, 42, 'P-4e 排队作业年龄原样传递（不在这一层重算）');
    const idle = readProgressAt(db as never, 't1', { state: 'idle', nowMs });
    eq([idle.lastProgressAt !== null, idle.stuckMs], [true, null],
      'P-4f 同一份账在 idle 下：进展时刻照给、已卡时长不给');
  }

  // ── R-1 渲染层词表 ────────────────────────────────────────────
  console.log('\n[R-1] 渲染层词表与展示换算');
  {
    eq(execBadgeVisible('live') && execBadgeVisible('queued') && execBadgeVisible('ghost'), true,
      'R-1a 三态出徽标');
    eq(execBadgeVisible('idle') || execBadgeVisible('terminal'), false, 'R-1b 空闲/已结束不出徽标（不挂灰章）');
    eq(execBadge(null), null, 'R-1c 取不到执行态 ⇒ 不画（"不知道"不画成"空闲"）');
    eq(execBadge('ghost')?.label, EXEC_STATE_LABEL.ghost, 'R-1d 徽标文案取词表真源');
    ok(/red/.test(execBadge('ghost')?.tone ?? ''), 'R-1e 幽灵态用告警色（与"正常排队"区分得开）');

    const now = Date.UTC(2026, 10, 11, 5, 0, 0);
    eq(execStateLine({ state: 'live', lastProgressAt: new Date(now - 12_000).toISOString(), nowMs: now }),
      '运行中 · 最后进展 12 秒前', 'R-1f live 一行话带"最后进展"');
    eq(execStateLine({ state: 'live', lastProgressAt: null, nowMs: now }), '运行中',
      'R-1g 没有进展时刻就只说"运行中"（不编时间）');
    eq(execStateLine({ state: 'queued', pendingJobAgeMs: 180_000, nowMs: now }),
      '已排队 · 最老作业等了 3 分钟', 'R-1h queued 说"等了多久"');
    eq(execStateLine({ state: 'ghost', lastProgressAt: new Date(now - 3_600_000).toISOString(), nowMs: now }),
      '状态写着在跑，实则无执行体 · 已卡 1 小时', 'R-1i ghost 说"已卡多久"');
    eq(execStateLine({ state: 'idle', nowMs: now }), '', 'R-1j idle 不出一行话');
    eq(durationText(0), '0 秒', 'R-1k 0 毫秒是真值');
    eq(durationText(-1), '', 'R-1l 负数 ⇒ 空（不印"-1 秒"）');
    eq(durationText(null), '', 'R-1m null ⇒ 空');
    eq(progressAgoText(null, now), '—', 'R-1n 没有时刻如实 `—`');
  }

  // ── W-1 静态接线：main / preload 侧 ───────────────────────────
  console.log('\n[W-1] 静态接线：main 侧');
  {
    const ipc = CODE(`${A}/src/main/ipc/project.ipc.ts`);
    ok(ipc.includes('readProgressAt(db as never, id, { state: es.state'),
      'W-1a `task:get` 用执行态 + 同一次取数算进展（不另判一次"跑没跑"）');
    ok(/return \{[\s\S]{0,4000}lastProgressAt[\s\S]{0,400}stuckMs[\s\S]{0,400}pendingJobAgeMs/.test(ipc),
      'W-1b `task:get` 回传三个派生键（渲染层才拿得到）');
    ok(/execState\s*\[\s*'?"?state"?'?\s*\]|execState:\s*\{\s*state:/.test(ipc) || ipc.includes('execState = { state: es.state, reason: es.reason }'),
      'W-1c `task:get` 回传执行态（state + reason 两样）');

    ok(/ipcMain\.handle\('task:releaseAndRequeue'/.test(ipc), 'W-1d IPC `task:releaseAndRequeue` 已注册');
    const body = ipc.slice(ipc.indexOf("ipcMain.handle('task:releaseAndRequeue'"));
    const end = body.indexOf('task:dispatchReason');
    const h = end > 0 ? body.slice(0, end) : body;
    ok(/before\.state !== 'ghost'/.test(h), 'W-1e 第一道校验：非 ghost 直接拒（返回当前态，不闷掉）');
    ok(h.includes('INVALID_STATE'), 'W-1f 拒绝带稳定错误码（界面可读因由）');
    ok(/if \(hasTaskRun\(id\)\)/.test(h), 'W-1g 第二道校验：真有在途执行体不释放（防误杀正在跑的任务）');
    ok(h.includes('abortTaskRun(id'), 'W-1h 先真断（中止残留执行）');
    ok(/_taskRunReleaser\(id/.test(h), 'W-1i 再走调度器的 `releaseTaskRun`（清 in-flight + 残留作业）');
    ok(/AND status NOT IN \('completed','failed','archived'\)/.test(h), 'W-1j 置 pending 不越权改终态');
    ok(h.includes('[人工释放并重排]'), 'W-1k 留痕：系统会话行写明依据');
    ok(h.includes('task.released_by_user'), 'W-1l 事件账可查（谁放的、基于哪条因由）');
    ok(h.includes('released: released.length'), 'W-1m 返回值带清理条数（界面如实显示做了什么）');
    ok(h.includes('execState: after'), 'W-1n 返回新的执行态（界面不必再猜）');
  }

  // ── W-2 静态接线：renderer 侧 ─────────────────────────────────
  console.log('\n[W-2] 静态接线：renderer 侧');
  {
    const client = CODE(`${A}/renderer/src/lib/ipc.ts`);
    ok(/releaseAndRequeue:\s*\(id: string\)/.test(client), 'W-2a 客户端有 `releaseAndRequeue(id)`');
    ok(client.includes("'task:releaseAndRequeue'"), 'W-2b 通道名与 main 侧一字不差');
    ok(/lastProgressAt\?: string \| null/.test(client) && /pendingJobAgeMs\?: number \| null/.test(client),
      'W-2c `tasks.get` 返回类型带派生键（参数/返回不漏项）');

    const page = CODE(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
    ok(page.includes("from '../lib/exec-view'"), 'W-2d 详情页引渲染层词表真源（不手抄一份）');
    ok(page.includes('execBadge(execState?.state)'), 'W-2e 徽标由执行态派生');
    ok(page.includes('execStateLine({ state: execState?.state'), 'W-2f "最后进展/已卡多久"一行话同源');
    ok(page.includes('execState?.state === \'ghost\' &&'), 'W-2g 只有幽灵态才给「释放并重排」按钮');
    ok(page.includes('handleReleaseAndRequeue(task.id)'), 'W-2h 按钮真调那个动作（不是只画个样子）');
    ok(/confirm\(/.test(page.slice(page.indexOf('async function handleReleaseAndRequeue'), page.indexOf('async function handleReleaseAndRequeue') + 800)),
      'W-2i 二次确认（释放会中断执行，不给一键误触）');
    ok(page.includes('tasks.releaseAndRequeue(taskId)'), 'W-2j 动作走客户端方法（不经第二套通道）');
    ok(/r\.released/.test(page) && page.includes('r.aborted'),
      'W-2k 结果如实回显（清理了几条、有没有中止句柄）');
    // 反证：页面对该方法只有一处调用（没有别处偷偷释放）
    eq((page.match(/tasks\.releaseAndRequeue\(/g) || []).length, 1, 'W-2l 释放动作只有一处调用点');
    ok(!/setInterval\(\(\)\s*=>\s*(void\s+)?loadProject/.test(page),
      'W-2m 未为执行态新增轮询（复用既有按事件重载）；卡住时长由每秒时钟现算');
  }

  // ── W-3 打包版数据根不再拖垮 renderer 构建 ───────────────────
  console.log('\n[W-3] 构建面：`node:module` 不再进 renderer 图');
  {
    const ap = CODE(`${A}/src/main/core/app-paths.ts`);
    ok(!/^import .* from 'node:module'/m.test(ap), 'W-3a `app-paths.ts` 不顶层 import `node:module`（否则 renderer 整包构建失败）');
    ok(ap.includes("getBuiltinModule('module')"), 'W-3b 改为运行时取内置模块（Node ≥20.16 / Electron 33 都有）');
    ok(/typeof process === 'undefined'/.test(ap), 'W-3c 无 process 的环境先判空（浏览器安全）');
  }

  // ── 构建钉 ────────────────────────────────────────────────────
  console.log('\n[PINS] build 标识与产物');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  const srcText = fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf-8');
  const tag = /build:\s*'(zx_[0-9_]+)'/.exec(srcText)?.[1] ?? '';
  ok(!!tag && buildNotOlderThan(tag, SELF_ROUND), 'PINS 产物不早于本轮（由脚本名派生，不写死轮次字面量）', `${tag} vs ${SELF_ROUND}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
