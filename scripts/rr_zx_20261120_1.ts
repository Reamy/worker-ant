/**
 * zx_20261120_1 「例·远·省·运」受控复跑。
 *
 * 分组（与方案 §3 批次一一对应）：
 *   A「例·基」岗位例行：模型 / 五态判据 / 相似任务建议（只读）
 *   B「例·跑」岗位例行：到期建单 / 幂等 / 跳过留痕 / 终态回填
 *   C「例·见」岗位例行：IPC 形状 / 手动跑 / 看板分账 / 词表扫面
 *   D「远·仓」仓库绑定 / 有界工作区 / 任务工作目录解析
 *   E「远·派」派发准入 / 只读护栏 / 只读回执
 *   F「远·证」派发结局上屏与 E2E 判据（E2E 另跑脚本）
 *   G「省·尺」来源 ROI / 影子预算
 *   H「省·见」收口账 / 详情投影 / 开关
 *   I「运·一页」运维概览八块读数
 *   J「证」build 钉与源码形状
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引生产函数 / 真实现（被删/改名即编译期失败）。
 *   · 两侧标本同试；计数器类断言给 0→N 的正面值。
 *   · 断言文案不含失败字形；表结构走生产 `initDatabase`。
 *   · 夹具按生产初始化顺序：先 initDatabase，再插数据行。
 *   · 不以轮次字面量做等值断言；build 钉由 `checkBuildPins` 派生核对。
 *   · 未实施组用 `skip()` 如实标注，不记 pass（占位不是绿灯）。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { checkBuildPins, buildNotOlderThan, stripKeepingLines } from './lib/rr-pins.js';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';
import {
  periodKeyOf, routineFireDecision, routineBindingVerdict, suggestRoutineCandidates, createRoutine, routineBoard,
} from '../apps/worker-ant-desktop/src/main/core/position-routines.js';
import { runRoutine, backfillRoutineRunForTask } from '../apps/worker-ant-desktop/src/main/core/routine-runner.js';
import {
  sanitizeRepoBinding, prepareRemoteWorkspace, cleanupRemoteWorkspace, redactUrl, isRemoteWorkspacePath,
} from '../apps/worker-ant-desktop/src/main/core/remote-workspace.js';
import { resolveTaskWorkingDir } from '../apps/worker-ant-desktop/src/main/core/exec-task-dir.js';
import { taskNeedsLocalWorkspace, decideCreateDispatch, buildDispatchPayload } from '../apps/worker-ant-desktop/src/main/core/collab-dispatch.js';
import { verifyRemoteReceipt, receiptNote } from '../apps/worker-ant-desktop/src/main/core/node-receipt.js';
import { applyContextBudget } from '../apps/worker-ant-desktop/src/main/core/context-budget.js';
import {
  sourceRoiRows, roiCapsProposal, applyRoiAwareBudget, roiBudgetCheckLine, readRoiBudgetSwitch,
  type SourceRoiRow,
} from '../apps/worker-ant-desktop/src/main/core/context-roi.js';
import { buildOpsOverview, ansHealthUrl } from '../apps/worker-ant-desktop/src/main/core/ops-overview.js';

let pass = 0;
let fail = 0;
let skipped = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ok ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}
/** 未实施组的如实占位：不进 pass，也不进 fail。 */
function skip(label: string): void { skipped++; console.log(`  · SKIP ${label}`); }

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261120-1-'));
let dbSeq = 0;
function mkdb(): Database.Database {
  const db = initDatabase(path.join(tmpRoot, `db-${++dbSeq}`));
  db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p','P',?)").run(tmpRoot);
  return db;
}
const SELF = path.basename(__filename).replace(/\.ts$/, '');
/** D 组的异步 clone 验证（CJS 不支持顶层 await；尾部统一等它收摊）。 */
let d2Done: Promise<void> = Promise.resolve();
/** I 组的异步运维读模型（同上）。 */
let iTestDone: Promise<void> = Promise.resolve();

// ── A 组「例·基」 ────────────────────────────────────────────────────────────
{
  // A1 五态判据：顺序即优先级，各态一只标本
  const base = { routineEnabled: true, projectStatus: 'active', positionEnabled: true, bindingEnabled: true, previousRunOpen: false, periodDuplicate: false };
  const d1 = routineFireDecision({ ...base, routineEnabled: false }, 'k');
  eq(d1.skipReason, 'routine_disabled', 'A1 停用例行 → routine_disabled');
  const d2 = routineFireDecision({ ...base, projectStatus: 'paused' }, 'k');
  eq(d2.skipReason, 'project_inactive', 'A1 项目非 active → project_inactive');
  const d3 = routineFireDecision({ ...base, positionEnabled: false }, 'k');
  eq(d3.skipReason, 'position_disabled', 'A1 岗位停用 → position_disabled');
  const d4 = routineFireDecision({ ...base, bindingEnabled: false }, 'k');
  eq(d4.skipReason, 'binding_disabled', 'A1 绑定停用 → binding_disabled');
  const d5 = routineFireDecision({ ...base, previousRunOpen: true }, 'k');
  eq(d5.skipReason, 'previous_run_open', 'A1 上一单在跑 → previous_run_open');
  const d6 = routineFireDecision({ ...base, periodDuplicate: true }, 'k');
  eq(d6.skipReason, 'period_duplicate', 'A1 同期已有账 → period_duplicate');
  const d0 = routineFireDecision(base, 'k');
  ok(d0.ok === true && d0.skipReason === null && d0.periodKey === 'k', 'A1 全新且无在跑 → 放行');
  // 优先级：定义先于项目（同时坏两只，报定义）
  eq(routineFireDecision({ ...base, routineEnabled: false, projectStatus: 'archived' }, 'k').skipReason, 'routine_disabled', 'A1 定义优先于项目');

  // A2 期次派生：日级/小时级/分钟级三档；同一分钟同键
  const t = Date.UTC(2026, 10, 20, 9, 30, 15);
  eq(periodKeyOf('30 9 1 * *', Date.UTC(2026, 10, 1, 9, 30)), '2026-11-01', 'A2 日级（dom 固定）取日期');
  eq(periodKeyOf('30 9 * * *', t), '2026-11-20T09', 'A2 小时级取小时桶');
  eq(periodKeyOf('* * * * *', t), '2026-11-20T09:30', 'A2 分钟级取分钟桶');
  ok(periodKeyOf('30 9 1 * *', t) === periodKeyOf('30 9 1 * *', t + 30_000), 'A2 同一期内两次触发同键');
  eq(periodKeyOf('bad', new Date('not-a-date')), '', 'A2 非法时刻 → 空键（不猜）');

  // A3 归属判据：岗位启用 ∧ 项目 active ∧ 绑定启用
  {
    const db = mkdb();
    const pos = (db.prepare('SELECT id FROM wa_positions ORDER BY id LIMIT 1').get() as { id: string }).id;
    db.prepare("INSERT INTO wa_project_positions (project_id, position_id, enabled) VALUES ('p', ?, 1)").run(pos);
    ok(routineBindingVerdict(db, pos, 'p').ok === true, 'A4 三条件齐备 → 可建');
    db.prepare('UPDATE wa_project_positions SET enabled = 0 WHERE project_id = ? AND position_id = ?').run('p', pos);
    eq(routineBindingVerdict(db, pos, 'p').reason, 'binding_disabled', 'A4 绑定停用 → binding_disabled');
    db.prepare('UPDATE wa_project_positions SET enabled = 1 WHERE project_id = ? AND position_id = ?').run('p', pos);
    db.prepare("UPDATE wa_projects SET status = 'paused' WHERE id = 'p'").run();
    eq(routineBindingVerdict(db, pos, 'p').reason, 'project_inactive', 'A4 项目暂停 → project_inactive');
    db.prepare("UPDATE wa_projects SET status = 'active' WHERE id = 'p'").run();
    db.prepare('UPDATE wa_positions SET enabled = 0 WHERE id = ?').run(pos);
    eq(routineBindingVerdict(db, pos, 'p').reason, 'position_disabled', 'A4 岗位停用 → position_disabled');
    db.close();
  }

  // A4 相似任务建议：4 条同形 → 1 簇；不同形 → 不命中；零写入
  {
    const db = mkdb();
    const pos = (db.prepare('SELECT id FROM wa_positions ORDER BY id LIMIT 1').get() as { id: string }).id;
    const ins = db.prepare("INSERT INTO wa_tasks (id, project_id, position_id, title, status, updated_at) VALUES (?, 'p', ?, ?, 'completed', datetime('now'))");
    for (let i = 0; i < 4; i++) ins.run(crypto.randomUUID(), pos, `审核销售部第 ${i + 1} 周报销单`);
    const before = (db.prepare('SELECT COUNT(*) AS c FROM wa_position_routines').get() as { c: number }).c;
    const s = suggestRoutineCandidates(db, { projectId: 'p', positionId: pos });
    eq(s.length, 1, 'A3 同形 4 次 → 1 条建议');
    eq(s[0]?.runs, 4, 'A3 建议计数 = 4');
    eq((db.prepare('SELECT COUNT(*) AS c FROM wa_position_routines').get() as { c: number }).c, before, 'A3 建议零写入（行数不变）');
    const ins2 = db.prepare("INSERT INTO wa_tasks (id, project_id, position_id, title, status, updated_at) VALUES (?, 'p', ?, ?, 'completed', datetime('now'))");
    ins2.run(crypto.randomUUID(), pos, '处理税务申报');
    ins2.run(crypto.randomUUID(), pos, '整理合同台账');
    eq(suggestRoutineCandidates(db, { projectId: 'p', positionId: pos }).length, 1, 'A3 不同形不新增建议');
    db.close();
  }
}

// ── B 组「例·跑」 ────────────────────────────────────────────────────────────
{
  const setup = (): { db: Database.Database; positionId: string; routineId: string } => {
    const db = mkdb();
    const pos = (db.prepare('SELECT id FROM wa_positions ORDER BY id LIMIT 1').get() as { id: string }).id;
    db.prepare("INSERT INTO wa_project_positions (project_id, position_id, enabled) VALUES ('p', ?, 1)").run(pos);
    const created = createRoutine(db, {
      position_id: pos, project_id: 'p', name: '每周报销审核', cron: '0 9 * * 1',
      title: '审核销售部本周报销单', description: '生成审核意见与异常清单', acceptance_criteria: '产出审核意见',
    });
    ok(created.ok, 'B0 例行创建成功', created.reason);
    return { db, positionId: pos, routineId: created.id };
  };
  const fireAt = new Date('2026-11-23T09:00:00Z');

  // B1 到期建单：任务四键 + run 行 0→1
  {
    const { db, positionId, routineId } = setup();
    let enq = 0;
    const r = runRoutine(db, routineId, { trigger: 'schedule', fireAt, enqueue: () => { enq++; } });
    ok(r.ok, 'B1 到期放行', r.reason);
    eq(enq, 1, 'B1 入队恰好一次（0→1）');
    const task = db.prepare('SELECT * FROM wa_tasks WHERE id = ?').get(r.taskId) as Record<string, unknown>;
    eq(task.source, 'routine', 'B1 任务 source=routine');
    eq(task.position_id, positionId, 'B1 任务带岗位');
    eq(task.status, 'pending', 'B1 任务初始 pending');
    const ctx = JSON.parse(String(task.context_json ?? '{}')) as Record<string, unknown>;
    eq(ctx.source, 'routine', 'B1 context.source=routine');
    eq(ctx.routine_id, routineId, 'B1 context.routine_id');
    eq(ctx.routine_name, '每周报销审核', 'B1 context.routine_name');
    ok(typeof ctx.period_key === 'string' && ctx.period_key.length > 0, 'B1 context.period_key 非空');
    eq(ctx.cron_triggered, true, 'B1 context.cron_triggered');
    eq((db.prepare('SELECT COUNT(*) AS c FROM wa_position_routine_runs WHERE routine_id = ?').get(routineId) as { c: number }).c, 1, 'B1 run 行 0→1');

    // B2 上一单未终态时，同期第二次先报「在跑」（顺序即优先级）；结单后再报「同期重复」
    let enq2 = 0;
    const r2 = runRoutine(db, routineId, { trigger: 'schedule', fireAt, enqueue: () => { enq2++; } });
    eq(r2.skipped, 'previous_run_open', 'B2 上一单未终态 → previous_run_open');
    eq(enq2, 0, 'B2 不再入队');
    db.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = ?").run(r.taskId);
    backfillRoutineRunForTask(db, r.taskId, 'completed');
    const r2b = runRoutine(db, routineId, { trigger: 'schedule', fireAt, enqueue: () => { enq2++; } });
    eq(r2b.skipped, 'period_duplicate', 'B2 同期待重 → period_duplicate');
    eq(enq2, 0, 'B2 同期重复不再入队');
    eq((db.prepare('SELECT COUNT(*) AS c FROM wa_tasks WHERE source = ?').get('routine') as { c: number }).c, 1, 'B2 任务仍 1 条');
    eq((db.prepare('SELECT COUNT(*) AS c FROM wa_position_routine_runs WHERE routine_id = ?').get(routineId) as { c: number }).c, 1, 'B2 run 行仍 1 条（跳过不写第二行）');
    db.close();
  }

  // B3 上一单在跑 ⇒ 跳过并留痕；终态回填后可跑下一期
  {
    const { db, routineId } = setup();
    const r1 = runRoutine(db, routineId, { trigger: 'schedule', fireAt, enqueue: () => {} });
    ok(r1.ok, 'B3 首单放行');
    const r2 = runRoutine(db, routineId, { trigger: 'schedule', fireAt: new Date('2026-11-30T09:00:00Z'), enqueue: () => {} });
    eq(r2.skipped, 'previous_run_open', 'B3 上一单未终态 → previous_run_open');
    const skipped = db.prepare("SELECT * FROM wa_position_routine_runs WHERE routine_id = ? AND status = 'skipped'").get(routineId) as { reason?: string } | undefined;
    eq(skipped?.reason, 'previous_run_open', 'B3 跳过留痕带原因');
    db.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = ?").run(r1.taskId);
    eq(backfillRoutineRunForTask(db, r1.taskId, 'completed'), 1, 'B4 终态回填 0→1');
    eq((db.prepare('SELECT status FROM wa_position_routine_runs WHERE task_id = ?').get(r1.taskId) as { status: string }).status, 'completed', 'B4 run 行已结');
    eq(backfillRoutineRunForTask(db, r1.taskId, 'failed'), 0, 'B4 重复回填不改已结行');
    const r3 = runRoutine(db, routineId, { trigger: 'schedule', fireAt: new Date('2026-12-07T09:00:00Z'), enqueue: () => {} });
    ok(r3.ok, 'B3 上一单已终态 → 下一期放行', r3.reason);
    db.close();
  }

  // B4 绑定停用 ⇒ skipped；入队抛错 ⇒ 留账但不回 ok；手动跑不受同期限制
  {
    const { db, positionId, routineId } = setup();
    db.prepare('UPDATE wa_project_positions SET enabled = 0 WHERE project_id = ? AND position_id = ?').run('p', positionId);
    const r = runRoutine(db, routineId, { trigger: 'schedule', fireAt: new Date('2026-11-23T09:00:00Z'), enqueue: () => {} });
    eq(r.skipped, 'binding_disabled', 'B4 绑定停用 → binding_disabled');
    db.prepare('UPDATE wa_project_positions SET enabled = 1 WHERE project_id = ? AND position_id = ?').run('p', positionId);

    const bad = runRoutine(db, routineId, { trigger: 'schedule', fireAt: new Date('2026-11-30T09:00:00Z'), enqueue: () => { throw new Error('queue down'); } });
    ok(!bad.ok && bad.reason.startsWith('enqueue_failed'), 'B4 入队失败不回 ok', bad.reason);
    eq((db.prepare('SELECT COUNT(*) AS c FROM wa_tasks WHERE id = ?').get(bad.taskId) as { c: number }).c, 1, 'B4 入队失败仍留任务账');
    eq((db.prepare('SELECT status FROM wa_position_routine_runs WHERE task_id = ?').get(bad.taskId) as { status: string }).status, 'created', 'B4 入队失败仍留运行账');

    const manual = runRoutine(db, routineId, { trigger: 'manual', fireAt: new Date('2026-12-01T09:00:00Z'), enqueue: () => { throw new Error('x'); } });
    eq(manual.skipped, 'previous_run_open', 'B4 手动跑仍受上一单在跑限制');
    db.prepare("UPDATE wa_tasks SET status = 'failed' WHERE id = ?").run(bad.taskId);
    backfillRoutineRunForTask(db, bad.taskId, 'failed');
    const manual2 = runRoutine(db, routineId, { trigger: 'manual', fireAt: new Date('2026-12-01T09:01:00Z'), enqueue: () => {} });
    ok(manual2.ok, 'B4 手动跑不受「本期已跑」限制（仍可跑）', manual2.reason);
    eq((db.prepare('SELECT COUNT(*) AS c FROM wa_tasks WHERE source = ?').get('routine') as { c: number }).c, 2, 'B4 手动跑新增 1 条任务');
    db.close();
  }
}

// ── C 组「例·见」 ────────────────────────────────────────────────────────────
{
  // C1 看板分账：例行 vs 临时；验收通过只认 acceptance_check.verified
  {
    const db = mkdb();
    const pos = (db.prepare('SELECT id FROM wa_positions ORDER BY id LIMIT 1').get() as { id: string }).id;
    const ins = db.prepare(
      `INSERT INTO wa_tasks (id, project_id, position_id, source, title, status, context_json, created_at, updated_at)
       VALUES (?, 'p', ?, ?, ?, ?, ?, datetime('now'), ?)`,
    );
    const now = new Date().toISOString();
    ins.run('r1', pos, 'routine', '例行一', 'completed', JSON.stringify({ acceptance_check: { verified: true }, execution_metrics: { totalTokens: 100, stepsUsed: 5 } }), now);
    ins.run('r2', pos, 'routine', '例行二', 'failed', JSON.stringify({}), now);
    ins.run('a1', pos, 'user', '临时一', 'completed', JSON.stringify({ acceptance_check: { verified: false }, execution_metrics: { totalTokens: 300, stepsUsed: 15 } }), now);
    ins.run('a2', pos, 'agent', '临时二', 'completed', JSON.stringify({ acceptance_check: { verified: true } }), now);
    const b = routineBoard(db, { positionId: pos, projectId: 'p' });
    eq(b.routine.tasks, 2, 'C1 例行 2 件');
    eq(b.routine.completed, 1, 'C1 例行完成 1');
    eq(b.routine.acceptance_passed, 1, 'C1 例行验收通过 1');
    eq(b.routine.avg_tokens, 100, 'C1 例行平均 token 取有账样本');
    eq(b.routine.avg_steps, 5, 'C1 例行平均步数');
    eq(b.adhoc.tasks, 2, 'C1 临时 2 件');
    eq(b.adhoc.completed, 2, 'C1 临时完成 2');
    eq(b.adhoc.acceptance_passed, 1, 'C1 临时验收通过 1');
    eq(b.adhoc.avg_tokens, 300, 'C1 临时平均 token 只算有账的 1 件');
    ok(b.routine.avg_duration_ms === 0 || b.routine.avg_duration_ms !== null, 'C1 时长估算有值（同刻落的账为 0 差）');
    db.close();
  }

  // C2 接线扫面：IPC 六个出口 / 渲染页三个入口 / 词表第二落点
  {
    const ipc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/ipc/positions.ipc.ts'), 'utf-8')).join('\n');
    for (const ch of ['list', 'create', 'update', 'delete', 'runNow', 'suggestions', 'board']) {
      ok(new RegExp(`positionRoutine:${ch}`).test(ipc), `C2 IPC 出口在册：positionRoutine:${ch}`);
    }
    // 信封：七个出口的成功返回都须是 `{ data }`（渲染层 `ipcCall` 只认此形）。按每个 handler 的语句
    // 区间分别断言——只查通道名存在挡不住裸返回（2026-11-22 运维页即此漏网）。
    for (const ch of ['list', 'create', 'update', 'delete', 'runNow', 'suggestions', 'board']) {
      const start = ipc.indexOf(`positionRoutine:${ch}'`);
      const next = ipc.indexOf('ipcMain.handle(', start + 1);
      const blockText = ipc.slice(start, next < 0 ? undefined : next);
      ok(/return\s*\{\s*data\b/.test(blockText), `C2 ${ch} 出口以 { data } 信封交出`);
    }
    const page = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/PositionsPage.tsx'), 'utf-8')).join('\n');
    ok(/positionRoutines as routinesIpc/.test(page), 'C2 页面经共享 IPC 客户端调用');
    ok(/例行（到点该做的那件事）/.test(page), 'C2 页面有例行区块');
    ok(/设为例行/.test(page), 'C2 建议卡可一键设为例行');
    ok(/routineSkipLabel/.test(page), 'C2 跳过原因有人话（词表在 lib/，页面不自持）');
    const routineView = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/lib/routine-view.ts'), 'utf-8')).join('\n');
    ok(/ROUTINE_SKIP_LABEL/.test(routineView) && /ROUTINE_RUN_STATUS_LABEL/.test(routineView), 'C2 例行词表落在 lib/ 一处');
    const src = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/lib/task-source.ts'), 'utf-8')).join('\n');
    ok(/routine:\s*'岗位例行'/.test(src), 'C3 任务来路词表含 routine');
    ok(/cron:/.test(src), 'C3 词表第二落点与既有 cron 同处（不另造一份）');
    const dbSrc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/database.ts'), 'utf-8')).join('\n');
    ok(/POSITION_ROUTINES_DDL/.test(dbSrc), 'C2 生产建表引 DDL 真源');
    const idx = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/index.ts'), 'utf-8')).join('\n');
    ok(/registerRoutineJob/.test(idx) && /backfillRoutineRunForTask/.test(idx), 'C2 启动注册与终态回填已接线');
    ok(/routine_no_success_push/.test(idx), 'C2 例行完成默认不推 IM（跳过留痕）');
  }
}

// ── D 组「远·仓」 ────────────────────────────────────────────────────────────
{
  // D1 契约三态
  ok(sanitizeRepoBinding({ url: 'https://example.com/a.git', ref: 'main' }) != null, 'D1 https 合法');
  ok(sanitizeRepoBinding({ url: 'git@example.com:a.git', ref: 'abc123' }) != null, 'D1 git@ 合法');
  ok(sanitizeRepoBinding({ url: 'file:///tmp/a.git', ref: 'main' }) === null, 'D1 file:// 生产拒绝');
  ok(sanitizeRepoBinding({ url: 'file:///tmp/a.git', ref: 'main' }, { allowFile: true }) != null, 'D1 file:// 回归开关放行');
  ok(sanitizeRepoBinding({ url: 'https://e.com/a', ref: 'a b' }) === null, 'D1 ref 含空白拒绝');
  ok(sanitizeRepoBinding({ url: 'https://e.com/a', ref: 'main', subdir: '../etc' }) === null, 'D1 subdir 逃逸拒绝');
  ok(sanitizeRepoBinding({ url: 'ftp://e.com/a', ref: 'main' }) === null, 'D1 未知协议拒绝');
  eq(redactUrl('https://u:p@example.com/a.git?token=x'), 'https://example.com/a.git', 'D1 脱敏去 userinfo 与查询串');
  eq(sanitizeRepoBinding({ url: 'https://ghp_secret@example.com/a.git?x=1', ref: 'main' })?.url, 'https://example.com/a.git', 'D1 随单 URL 剥掉凭据（token 不代传）');
  ok(sanitizeRepoBinding({ url: 'ssh://git@example.com/a.git', ref: 'main' })?.url === 'ssh://git@example.com/a.git', 'D1 ssh 用户名保留（不是密钥）');

  // D2 工作区：clone / 复用 / 失败；D3 围栏
  d2Done = (async () => {
  const rroot = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-remote-ws-'));
  try {
    const bare = path.join(rroot, 'bare.git');
    fs.mkdirSync(bare);
    execFileSync('git', ['init', '--bare', '-q', bare]);
    const work = path.join(rroot, 'work');
    execFileSync('git', ['clone', '-q', bare, work]);
    fs.writeFileSync(path.join(work, 'a.txt'), 'hello');
    const g = (args: string[]) => execFileSync('git', ['-C', work, '-c', 'user.name=rr', '-c', 'user.email=rr@example.com', ...args], { encoding: 'utf-8' });
    g(['add', 'a.txt']); g(['commit', '-qm', 'init']); g(['push', '-q', 'origin', 'HEAD']);
    const branch = g(['symbolic-ref', '--short', 'HEAD']).trim();
    const head = g(['rev-parse', 'HEAD']).trim();
    const base = path.join(rroot, 'remote-workspaces');
    const url = `file://${bare}`;
    const r1 = await prepareRemoteWorkspace({ repo: { url, ref: branch }, baseDir: base, allowFile: true });
    ok(r1.ok && r1.commit === head && !r1.cached, 'D2 首次 clone 且提交一致');
    ok(fs.existsSync(path.join(r1.dir, 'a.txt')), 'D2 工作区内容在盘');
    ok(isRemoteWorkspacePath(r1.dir), 'D3 工作区路径在 remote-workspaces 根下');
    const r2 = await prepareRemoteWorkspace({ repo: { url, ref: branch }, baseDir: base, allowFile: true });
    ok(r2.ok && r2.cached && r2.dir === r1.dir, 'D2 二次复用同一目录');
    const r3 = await prepareRemoteWorkspace({ repo: { url: `file://${path.join(rroot, 'nope.git')}`, ref: branch }, baseDir: base, allowFile: true });
    ok(!r3.ok && r3.reason === 'clone_failed', 'D2 坏远端 → clone_failed');
    const r4 = await prepareRemoteWorkspace({ repo: null, baseDir: base, allowFile: true });
    ok(!r4.ok && r4.reason === 'no_remote', 'D2 无绑定 → no_remote');
    ok(!isRemoteWorkspacePath(path.join(rroot, 'elsewhere')), 'D3 根外路径不认');
    ok(cleanupRemoteWorkspace(base, 0) >= 1, 'D2 清理可删（keep=0）');
  } finally {
    fs.rmSync(rroot, { recursive: true, force: true });
  }
  })();

  // D4 任务工作目录：本地逐字不变 + 远程 override + 围栏
  {
    const db = mkdb();
    const ws = path.join(tmpRoot, 'remote-workspaces', 'aa');
    fs.mkdirSync(ws, { recursive: true });
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES ('t-local','p','本地','pending','{}')").run();
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES ('t-remote','p','远程','pending',?)")
      .run(JSON.stringify({ remote_readonly: true, remote_workspace: ws }));
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES ('t-out','p','越界','pending',?)")
      .run(JSON.stringify({ remote_readonly: true, remote_workspace: path.join(tmpRoot, 'elsewhere') }));
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES ('t-miss','p','缺失','pending',?)")
      .run(JSON.stringify({ remote_readonly: true, remote_workspace: path.join(tmpRoot, 'remote-workspaces', 'missing') }));
    eq(resolveTaskWorkingDir(db, 't-local'), { dir: tmpRoot, source: 'project', reason: '' }, 'D4 本地任务逐字回项目目录');
    eq(resolveTaskWorkingDir(db, 't-remote').source, 'remote', 'D4 远程任务用 clone 工作区');
    eq(resolveTaskWorkingDir(db, 't-remote').dir, ws, 'D4 远程路径原样');
    eq(resolveTaskWorkingDir(db, 't-out').reason, 'remote_workspace_outside_root', 'D4 根外路径拒绝');
    eq(resolveTaskWorkingDir(db, 't-miss').reason, 'remote_workspace_missing', 'D4 工作区缺失如实报');
    db.close();
  }
}

// ── E 组「远·派」 ────────────────────────────────────────────────────────────
{
  const repo = { url: 'https://e.com/a.git', ref: 'abc' };
  const baseIn = { projectHasWorkingDir: true, category: 'research' as const, title: '扫描仓库生成技术债报告', description: '只读分析', hasAttachments: false };
  ok(taskNeedsLocalWorkspace({ ...baseIn, repoBinding: repo, remoteReadonlyEnabled: true }) === false, 'E1 研究类 + 有仓 + 开关开 → 可派');
  ok(taskNeedsLocalWorkspace({ ...baseIn, repoBinding: repo, remoteReadonlyEnabled: false }) === true, 'E4 开关关 → 留本机');
  ok(taskNeedsLocalWorkspace({ ...baseIn, repoBinding: null, remoteReadonlyEnabled: true }) === true, 'E1 无仓 + 题面涉仓 → 留本机');
  ok(taskNeedsLocalWorkspace({ ...baseIn, category: 'code', repoBinding: repo, remoteReadonlyEnabled: true }) === true, 'E1 代码类 → 留本机');
  ok(taskNeedsLocalWorkspace({ ...baseIn, hasAttachments: true, repoBinding: repo, remoteReadonlyEnabled: true }) === true, 'E1 带附件 → 留本机');

  // E1 理由码
  const f0 = { settingOn: true, teamUnlocked: true, enrolled: true, hasDependencies: false, hasAttachments: false, decomposed: false, category: 'research' as const, needsLocalWorkspace: true, repoBinding: null, remoteReadonlyEnabled: true };
  eq(decideCreateDispatch(f0).reason, 'repo-binding-missing', 'E1 无 origin 的理由码');
  eq(decideCreateDispatch({ ...f0, repoBinding: repo, remoteReadonlyEnabled: false }).reason, 'readonly-code-off', 'E4 开关关的理由码');
  ok(decideCreateDispatch({ ...f0, needsLocalWorkspace: false, repoBinding: repo }).eligible === true, 'E1 可派时准入通过');

  // E2 载荷：有仓才出现 repo/readonly 键；无仓旧形状不变
  const task = { id: 't1', title: '扫描仓库', description: '只读分析' };
  const withRepo = buildDispatchPayload(task as never, [], null, repo) as Record<string, unknown>;
  eq(withRepo.readonly, true, 'E2 只读标记随单');
  eq((withRepo.repo as Record<string, unknown>).url, repo.url, 'E2 仓库绑定随单');
  const withoutRepo = buildDispatchPayload(task as never, [], null, null) as Record<string, unknown>;
  ok(!('repo' in withoutRepo) && !('readonly' in withoutRepo), 'E2 无仓不出现新键（旧形状不变）');

  // E2 只读护栏接线（装配期 + 运行期）
  const runner = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/node-request-runner.ts'), 'utf-8')).join('\n');
  ok(/readonly_deny_tools/.test(runner) && /remote_readonly: true/.test(runner), 'E2 接收端写只读上下文与禁用面');
  ok(/readonly_requires_research/.test(runner) && /repo_unavailable/.test(runner), 'E2 非研究类/坏仓如实拒');
  const exec = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf-8')).join('\n');
  ok(/mutationGateVerdict\(nowStatus, name, readonlyDenyTools\)/.test(exec), 'E2 运行期变更闸带只读禁用面');
  ok(/readonlyDenyToolsOf\(subagentCtxJson/.test(exec), 'E2 装配期禁用面已读');
  const gate = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/mutation-gate.ts'), 'utf-8')).join('\n');
  ok(/readonly_run/.test(gate) && /readonlyDeny\?\.includes\(toolName\)/.test(gate), 'E2 只读拒绝在变更闸一处判');

  // E3 只读回执认结论；普通任务旧尺不变
  const okReceipt = verifyRemoteReceipt({ localTaskId: 't1', result: { taskId: 't1', taskStatus: 'completed', readonly: true, summary: '这是一段足够长的只读分析结论，用于核对回执。' }, hasLocalEvent: true, checkedAt: '' });
  eq(okReceipt.verdict, 'verified', 'E3 只读 + 结论 → verified');
  eq(okReceipt.outputCount, 1, 'E3 结论即 1 项产物');
  ok(receiptNote(okReceipt).includes('只读分析回执'), 'E3 文案说清是只读回执');
  const badReceipt = verifyRemoteReceipt({ localTaskId: 't1', result: { taskId: 't1', taskStatus: 'completed', readonly: true, summary: '' }, hasLocalEvent: true, checkedAt: '' });
  eq(badReceipt.verdict, 'self-reported', 'E3 空结论 → self-reported');
  ok(badReceipt.missing.includes('summary'), 'E3 缺结论列明');
  const normal = verifyRemoteReceipt({ localTaskId: 't1', result: { taskId: 't1', taskStatus: 'completed', outputs: [] }, hasLocalEvent: true, checkedAt: '' });
  eq(normal.verdict, 'self-reported', 'E3 普通任务空产出仍按旧尺');

  // E4 开关默认开（缺省值口径）与 GUI 读写口
  const sb = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/settings-bool.ts'), 'utf-8')).join('\n');
  ok(/node\.remote_readonly_code/.test(sb), 'E4 开关进布尔白名单');
  const peers = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/PeersPage.tsx'), 'utf-8')).join('\n');
  ok(/node\.remote_readonly_code/.test(peers) && /跨机只读代码分析/.test(peers), 'E4 Peers 页有读写口');
}

// ── F 组「远·证」 ────────────────────────────────────────────────────────────
{
  const ipc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/ipc/project.ipc.ts'), 'utf-8')).join('\n');
  ok(/dispatch_readonly/.test(ipc) && /readonly-remote/.test(ipc), 'F1 派发结局投影只读模式');
  ok(/dispatch_repo_url/.test(ipc) && /dispatch_repo_ref/.test(ipc), 'F1 仓库脱敏串与提交上屏');
  const page = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf-8')).join('\n');
  ok(/做只读分析/.test(page), 'F1 任务详情写明只读分析');
  const dispatch = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/collab-dispatch.ts'), 'utf-8')).join('\n');
  ok(/dispatch_readonly/.test(dispatch) && /dispatch_repo_url/.test(dispatch), 'F1 派发成功后落只读标记');
  skip('F2 E2E 判据（另跑 scripts/e2e_zx_20261120_1.ts）');
}

// ── G 组「省·尺」 ────────────────────────────────────────────────────────────
{
  const seedRoi = (db: Database.Database) => {
    const insTask = db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, created_at) VALUES (?, 'p', ?, ?, datetime('now'))");
    const insInj = db.prepare("INSERT INTO wa_context_injections (id, task_id, source, ref_id, chars, est_tokens, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)");
    // 基线：20 完成 / 5 失败 = 0.8
    for (let i = 0; i < 25; i++) insTask.run(`base-${i}`, 't', i < 20 ? 'completed' : 'failed');
    // knowledge：12 完成 / 8 失败 = 0.6（负 lift）
    for (let i = 0; i < 20; i++) {
      insTask.run(`k-${i}`, '知识任务', i < 12 ? 'completed' : 'failed');
      insInj.run(crypto.randomUUID(), `k-${i}`, 'knowledge', 'sec', 100, 25, i < 12 ? 'completed' : 'failed');
    }
    // memory：18 完成 / 2 失败 = 0.9（正 lift）
    for (let i = 0; i < 20; i++) {
      insTask.run(`m-${i}`, '记忆任务', i < 18 ? 'completed' : 'failed');
      insInj.run(crypto.randomUUID(), `m-${i}`, 'memory', 'mem', 80, 20, i < 18 ? 'completed' : 'failed');
    }
  };

  // G1/G2 ROI 与提案
  {
    const db = mkdb();
    seedRoi(db);
    const roi = sourceRoiRows(db, { projectId: 'p', sinceDays: 60 });
    eq(roi.samples, 65, 'G1 基线样本 = 完成+失败');
    const k = roi.rows.find((r) => r.source === 'knowledge')!;
    eq(k.evaluatedTasks, 20, 'G1 knowledge 样本 20');
    ok(k.lift != null && k.lift < 0, 'G1 knowledge 负 lift', String(k.lift));
    const m = roi.rows.find((r) => r.source === 'memory')!;
    ok(m.lift != null && m.lift > 0, 'G1 memory 正 lift', String(m.lift));
    const p = roiCapsProposal(roi, { budgetTokens: 1000 });
    eq(p.caps.knowledge, 100, 'G2 负 lift 降至 floor（预算 10%）');
    eq(p.caps.memory, undefined, 'G2 正 lift 不降');
    ok(p.unchanged === false, 'G2 有可执行建议');
    db.close();
  }

  // G1 样本不足 ⇒ unchanged
  {
    const db = mkdb();
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, created_at) VALUES ('x','p','x','completed',datetime('now'))").run();
    const roi = sourceRoiRows(db, { projectId: 'p' });
    ok(roi.baseline != null && roi.samples === 1, 'G1 小样本仍如实回基线');
    const p = roiCapsProposal(roi, { budgetTokens: 1000 });
    ok(p.unchanged && p.reason.includes('样本不足'), 'G1 样本不足 ⇒ unchanged', p.reason);
    db.close();
  }

  // G3 影子：与旧实现逐字节相同；生效：上限真压到 chars
  {
    const chars = { knowledge: 2000, memory: 1000, history: 1000, user: 500, system: 500, tools: 500 };
    const fakeRows: SourceRoiRow[] = [
      { source: 'knowledge', injections: 20, tokens: 500, pending: 0, evaluatedTasks: 20, completed: 12, failed: 8, successRate: 0.6, lift: -0.2, basis: 'correlation' },
    ];
    const proposal = roiCapsProposal({ rows: fakeRows, baseline: 0.8, samples: 65 }, { budgetTokens: 1000 });
    const direct = applyContextBudget({ chars, budgetTokens: 1000 });
    const shadow = applyRoiAwareBudget({ chars, budgetTokens: 1000, proposal, apply: false });
    eq(shadow.applied, false, 'G3 影子不生效');
    eq(shadow.budget.trimmedChars, direct.trimmedChars, 'G3 影子裁剪逐字节一致');
    const live = applyRoiAwareBudget({ chars, budgetTokens: 1000, proposal, apply: true });
    eq(live.applied, true, 'G3 生效标记');
    ok(live.budget.trimmedChars.knowledge >= 1600, 'G3 生效后 knowledge 至少砍到上限（2000→400）', String(live.budget.trimmedChars.knowledge));
  }
}

// ── H 组「省·见」 ────────────────────────────────────────────────────────────
{
  // H1 收口账：无记录不出行；影子/生效两态
  {
    const db = mkdb();
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES ('t-none','p','无账','pending','{}')").run();
    eq(roiBudgetCheckLine(db, 't-none'), null, 'H1 无记录不出行（不编"未生效"）');
    const shadow = { applied: false, proposal: { caps: { knowledge: 100 }, rationale: ['x'], unchanged: false, reason: 'r', rows: [], baseline: 0.8, samples: 65 }, at: 'now' };
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES ('t-shadow','p','影子','pending',?)").run(JSON.stringify({ roi_budget: shadow }));
    const line = roiBudgetCheckLine(db, 't-shadow');
    ok(!!line && line.includes('影子') && line.includes('未生效') && line.includes('knowledge → 100'), 'H1 影子行说清未生效', line ?? '');
    const live = { ...shadow, applied: true };
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES ('t-live','p','生效','pending',?)").run(JSON.stringify({ roi_budget: live }));
    const line2 = roiBudgetCheckLine(db, 't-live');
    ok(!!line2 && line2.includes('上下文按效预算') && !line2.includes('未生效') && line2.includes('相关，非因果'), 'H1 生效行带样本与「相关」标签', line2 ?? '');
    db.close();
  }

  // H2 详情投影与组件接线（静态）
  const ipc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/ipc/project.ipc.ts'), 'utf-8')).join('\n');
  ok(/roiBudget/.test(ipc) && /roi_budget/.test(ipc), 'H2 task:get 投影 roiBudget');
  const page = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf-8')).join('\n');
  ok(/roiBudget=\{roiBudget\}/.test(page), 'H2 任务详情把 roiBudget 传给账组件');
  const comp = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/components/task/TaskContextLedger.tsx'), 'utf-8')).join('\n');
  ok(/按效预算/.test(comp) && /影子/.test(comp) && /已生效/.test(comp), 'H2 账组件三态文案');
  const exec = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf-8')).join('\n');
  ok(/computeRoiBudget\(db, \{ taskId, projectId/.test(exec), 'H2 装配段已接按效预算（一跳进 context-roi）');
  const roi = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/context-roi.ts'), 'utf-8')).join('\n');
  ok(/roi_budget/.test(roi) && /applyRoiAwareBudget/.test(roi), 'H2 记账与两态预算在 context-roi 一处');
  const fin = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/exec-finalize.ts'), 'utf-8')).join('\n');
  const cf = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/control-finalize.ts'), 'utf-8')).join('\n');
  ok(/roiBudgetCheckLine/.test(fin) && /roiBudgetCheckLine/.test(cf), 'H2 两个收口出口同尺');

  // H3 开关：缺省关；'0' 关；'1' 开；非法值按关
  {
    const db = mkdb();
    eq(readRoiBudgetSwitch(db), false, 'H3 缺省关');
    db.prepare("INSERT INTO wa_settings (key, value) VALUES ('context.roi_budget', '1')").run();
    eq(readRoiBudgetSwitch(db), true, 'H3 显式 1 → 开');
    db.prepare("UPDATE wa_settings SET value = '0' WHERE key = 'context.roi_budget'").run();
    eq(readRoiBudgetSwitch(db), false, 'H3 显式 0 → 关');
    db.prepare("UPDATE wa_settings SET value = 'maybe' WHERE key = 'context.roi_budget'").run();
    eq(readRoiBudgetSwitch(db), false, 'H3 非法值按关');
    const sb = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/settings-bool.ts'), 'utf-8')).join('\n');
    ok(/context\.roi_budget/.test(sb), 'H3 进布尔白名单（设置页可点）');
    const settings = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/SettingsPage.tsx'), 'utf-8')).join('\n');
    ok(/ADVANCED_DEFAULT_OFF_KEYS/.test(settings) && /context\.roi_budget/.test(settings), 'H3 设置页按缺省关渲染');
    db.close();
  }
}

// ── I 组「运·一页」 ──────────────────────────────────────────────────────────
{
  const mkOps = () => {
    const dir = path.join(tmpRoot, `ops-${++dbSeq}`);
    const db = initDatabase(dir);
    return { db, dir };
  };

  iTestDone = (async () => {
  // I1 空库：可数的块如实为 0；读不到的块 ok:false + 原因（不伪装 0）
  {
    const { db, dir } = mkOps();
    const o = await buildOpsOverview({ db, dataDir: dir, ansBaseUrl: '' });
    ok(o.jobs.ok && o.jobs.value!.pending === 0 && o.jobs.value!.running === 0, 'I1 空库调度计数为 0（真 0）');
    ok(o.tasks.ok && o.tasks.value!.stale === 0, 'I1 空库无卡死任务');
    ok(o.locks.ok && o.locks.value!.total === 0, 'I1 无锁目录如实 0');
    ok(o.im.ok && o.im.value!.dead === 0, 'I1 空补发账如实 0');
    ok(o.cron.ok && o.cron.value!.heartbeatAgeMs === null && o.cron.value!.heartbeatOk === null, 'I1 无心跳 ⇒ null（不写 0）');
    ok(!o.ans.ok && !!o.ans.reason, 'I1 未配 ANS ⇒ ok:false + 原因');
    ok(o.disk.ok, 'I1 磁盘可读');
    db.close();
  }

  // I2 造数：作业 / 卡死 / IM / 锁 / cron 阈值 / ANS 探活
  {
    const { db, dir } = mkOps();
    db.prepare("INSERT INTO wa_jobs (id, type, status, created_at) VALUES ('j1','ai-task','pending',datetime('now','-20 minutes'))").run();
    db.prepare("INSERT INTO wa_jobs (id, type, status, created_at) VALUES ('j2','ai-task','running',datetime('now'))").run();
    db.prepare("INSERT INTO wa_jobs (id, type, status, created_at, completed_at) VALUES ('j3','ai-task','failed',datetime('now'),datetime('now'))").run();
    db.prepare("INSERT INTO wa_projects (id, name) VALUES ('pr','P')").run();
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, updated_at) VALUES ('stale','pr','卡死','executing',datetime('now','-1 hour'))").run();
    // IM 补发账（表由 initDatabase 建）
    db.prepare("INSERT INTO wa_im_outbox (id, status) VALUES ('o1','dead')").run();
    db.prepare("INSERT INTO wa_im_outbox (id, status) VALUES ('o2','pending')").run();
    // 锁：有效 / 过期 / 坏 JSON
    const lockDir = path.join(dir, 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    const past = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(path.join(lockDir, 'build_a.json'), JSON.stringify({ repoRoot: '/a', taskId: 't1', command: 'mvn clean', expiresAt: future }));
    fs.writeFileSync(path.join(lockDir, 'build_b.json'), JSON.stringify({ repoRoot: '/b', taskId: 't2', command: 'pnpm build', expiresAt: past }));
    fs.writeFileSync(path.join(lockDir, 'build_c.json'), '{bad json');
    // cron 心跳：31 分钟前
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    fs.writeFileSync(path.join(dir, 'cron_heartbeat.json'), JSON.stringify({ project_id: 'pr', cron_expression: '0 9 * * *', last_fire: old, success: true }));
    const o = await buildOpsOverview({
      db, dataDir: dir, ansBaseUrl: 'http://ans.local',
      probeAns: async () => ({ ok: true, latencyMs: 12, reason: '' }),
    });
    eq(o.jobs.value!.pending, 1, 'I2 待执行 1');
    eq(o.jobs.value!.running, 1, 'I2 执行中 1');
    eq(o.jobs.value!.failed24h, 1, 'I2 24h 失败 1');
    ok((o.jobs.value!.oldestPendingMs ?? 0) >= 19 * 60_000, 'I2 最老待执行年龄 ≥19 分钟');
    eq(o.tasks.value!.stale, 1, 'I2 卡死执行态 1');
    eq(o.im.value!.dead, 1, 'I2 IM 死信 1');
    eq(o.im.value!.pending, 1, 'I2 IM 待补发 1');
    eq(o.locks.value!.active, 1, 'I3 有效锁 1');
    eq(o.locks.value!.expired, 1, 'I3 过期锁 1');
    eq(o.locks.value!.bad, 1, 'I3 坏文件 1');
    eq(o.cron.value!.heartbeatOk, false, 'I3 31 分钟前心跳 → 不新鲜');
    eq(o.cron.value!.lastSuccess, true, 'I3 上次成功如实带出');
    eq(o.ans.value!.reachable, true, 'I2 ANS 探活可达');
    eq(o.ans.value!.latencyMs, 12, 'I2 延迟如实');
    db.close();
  }

  // I4 ANS 探活 URL 走真路由 `/api/v1/health`（曾打根下 `/health` ⇒ 运维页恒报「不可达：http_404」）。
  //   纯函数断言，不起网络：探针的实际 URL 由 `ansHealthUrl` 一处给出。
  {
    eq(ansHealthUrl('http://localhost:27183'), 'http://localhost:27183/api/v1/health', 'I4 探活 URL 拼 /api/v1/health');
    eq(ansHealthUrl('http://localhost:27183/'), 'http://localhost:27183/api/v1/health', 'I4 尾斜杠不产生双斜杠');
    ok(ansHealthUrl('http://localhost:27183') !== 'http://localhost:27183/health', 'I4 不再用根下 /health');
  }
  })();

  // I3 接线扫面：IPC 只读、页面八块、导航独立项
  {
    const ipc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/ipc/ops.ipc.ts'), 'utf-8')).join('\n');
    ok(/ops:overview/.test(ipc) && !/ipcMain\.handle\('ops:(?!overview)/.test(ipc), 'I3 运维 IPC 只有只读出口');
    // 信封契约（2026-11-22 修）：渲染层 `ipcCall` 只认 `{ data } | { error }`。裸返回会被解成
    // `undefined`，「运维」页八块因此恒显示「加载中」——按语句形状钉死，不靠人工目视。
    ok(/return\s*\{\s*data\b/.test(ipc), 'I3 运维 IPC 以 { data } 信封交出（渲染层只认此形）');
    ok(!/return\s+buildOpsOverview\s*\(/.test(ipc), 'I3 运维 IPC 不裸返回读模型（否则渲染层解成 undefined）');
    const page = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/OpsPage.tsx'), 'utf-8')).join('\n');
    for (const t of ['调度队列', '任务态', '构建锁', '数据库文件', 'IM 补发', 'cron 心跳', 'ANS', '磁盘']) {
      ok(page.includes(t), `I3 页面含「${t}」块`);
    }
    const nav = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/lib/navConfig.ts'), 'utf-8')).join('\n');
    ok(/to: '\/ops'/.test(nav) && /label: '运维'/.test(nav), 'I3 导航新增独立运维项');
    const idx = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/index.ts'), 'utf-8')).join('\n');
    ok(/initOpsIpc\(db, \{ dataDir \}\)/.test(idx), 'I3 IPC 已接线（传 dataDir）');
  }
}

// ── J 组「证」 ───────────────────────────────────────────────────────────────

{
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  const src = fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf-8');
  const m = /build:\s*'(zx_\d{8}(?:_\d+)?)'/.exec(src);
  const tag = m?.[1] ?? '';
  ok(buildNotOlderThan(tag, SELF.replace(/^rr_/, '')), 'J1 build 不早于本套件轮次', `${tag} vs ${SELF}`);
}

Promise.allSettled([d2Done, iTestDone]).finally(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(fail === 0 ? 0 : 1);
});
