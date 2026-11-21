/**
 * zx_20261119_2 「核」受控复跑。
 *
 * 分组（与方案 §3 批次一一对应）：
 *   A「录」派生修复：标题带摘要 / 修复自可追溯 / 同父去重合并 / 交接项不立项
 *   B「账」开局改动跨子仓基线 + 提交前对账（开局既有 / 本轮新增 / 本轮消失）
 *   C「审」父任务收口前有界机检（只核存在性，不冒充验收）
 *   D「径」代拟判据的相对路径认得一层子仓
 *   E「通」bash 只读多段放行（每段过只读白名单）
 *   F「序」同仓构建锁（认领 / 拒绝 / 过期 / 释放 / 触发面）
 *   G「度」收口账纳入工具拒绝计数与步数效率
 *   H「证」build 钉与源码形状
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
import { createVerificationFixTask, extractDeferredItems, isDeferredHandoff } from '../apps/worker-ant-desktop/src/main/core/verification-issues.js';
import { parsePorcelain, collectRepoStatuses, statusPaths } from '../apps/worker-ant-desktop/src/main/core/working-tree.js';
import { captureRunStartBaseline } from '../apps/worker-ant-desktop/src/main/core/run-baseline.js';
import { reconcileStartBaseline, buildBaselineReconcileChecks, baselineReconcileChecks, isCommitLikeTask } from '../apps/worker-ant-desktop/src/main/core/start-baseline-reconcile.js';
import { gitWorkingTreeAdvice } from '../apps/worker-ant-desktop/src/main/core/git-advisory.js';
import { preflightChildrenArtifacts, buildArtifactPrecheckNote } from '../apps/worker-ant-desktop/src/main/core/parent-artifact-precheck.js';
import { findPathCandidates } from '../apps/worker-ant-desktop/src/main/core/path-candidates.js';
import { proposeAcceptanceCriteria } from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';
import { validateReadonlyBashCommand, buildToolConstraintBrief } from '../apps/worker-ant-desktop/src/main/core/tool-guards.js';
import { acquireBuildLock, releaseBuildLock, readBuildLock, buildLockPath, isRepoWideBuildCommand, buildLockRoot } from '../apps/worker-ant-desktop/src/main/core/repo-build-lock.js';
import { readBoolSetting } from '../apps/worker-ant-desktop/src/main/core/settings-bool.js';
import { summarizeToolDenials, buildDenialCheckLine, recordToolDenialLedger } from '../apps/worker-ant-desktop/src/main/core/tool-denials.js';
import { buildTaskOutcome } from '../apps/worker-ant-desktop/src/main/core/task-outcome.js';

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
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261119-2-'));
let dbSeq = 0;
function mkdb(): Database.Database {
  const db = initDatabase(path.join(tmpRoot, `db-${++dbSeq}`));
  db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p','P',?)").run(tmpRoot);
  return db;
}
const SELF = path.basename(__filename).replace(/\.ts$/, '');

// ── A 组「录」 ───────────────────────────────────────────────────────────────
{
  // A1 立项：标题带首条问题摘要；context 记来源标题
  {
    const db = mkdb();
    const t1 = crypto.randomUUID();
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?, 'p', '核实报告', 'completed')").run(t1);
    const fix = createVerificationFixTask({
      db, taskId: t1, projectId: 'p',
      issues: ['S1 接口未接入回调', 'S2 端点缺失'],
      reportTitle: '核实报告',
    });
    ok(fix.merged === false, 'A1 首次立项不合并');
    ok(fix.title.startsWith('修复核实发现的未落地问题（2 个）：S1 接口未接入回调'), 'A1 标题带首条问题摘要', fix.title);
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(fix.id) as { context_json: string };
    const ctx = JSON.parse(row.context_json) as Record<string, unknown>;
    eq(ctx.verification_fix_of, t1, 'A1 context.verification_fix_of = 报告任务');
    eq(ctx.verification_fix_of_title, '核实报告', 'A1 context.verification_fix_of_title = 来源标题');
    db.close();
  }

  // A2 同父同源合并：不新建行、追加新条目、幂等
  {
    const db = mkdb();
    const t1 = crypto.randomUUID();
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?, 'p', '核实报告', 'completed')").run(t1);
    const first = createVerificationFixTask({ db, taskId: t1, projectId: 'p', issues: ['S1 接口未接入回调'] });
    const second = createVerificationFixTask({ db, taskId: t1, projectId: 'p', issues: ['S1 接口未接入回调', 'S2 端点缺失'] });
    eq(second.id, first.id, 'A2 同父同源合并到同一行');
    ok(second.merged === true, 'A2 第二次标 merged=true');
    eq((db.prepare("SELECT COUNT(*) AS c FROM wa_tasks WHERE json_extract(context_json,'$.verification_fix_of')=?").get(t1) as { c: number }).c, 1, 'A2 行数仍为 1（0→1 正面断言）');
    const row = db.prepare('SELECT title, description, context_json FROM wa_tasks WHERE id = ?').get(first.id) as { title: string; description: string; context_json: string };
    ok(row.title.includes('（2 个）'), 'A2 标题条数随合并更新', row.title);
    ok(row.description.includes('S1 接口未接入回调') && row.description.includes('S2 端点缺失'), 'A2 描述含两条');
    const ctx = JSON.parse(row.context_json) as { verification_fix_merged?: string[] };
    eq(ctx.verification_fix_merged, ['S2 端点缺失'], 'A2 合并痕只记新增条目');
    const third = createVerificationFixTask({ db, taskId: t1, projectId: 'p', issues: ['S1 接口未接入回调', 'S2 端点缺失'] });
    ok(third.merged === true, 'A2 重复投递仍走合并');
    ok(third.description === row.description, 'A2 重复投递不改描述（幂等）');
    db.close();
  }

  // A3 不同报告任务各自立项（反证：去重不能跨源）
  {
    const db = mkdb();
    const t1 = crypto.randomUUID();
    const t2 = crypto.randomUUID();
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?, 'p', '报告一', 'completed')").run(t1);
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?, 'p', '报告二', 'completed')").run(t2);
    const a = createVerificationFixTask({ db, taskId: t1, projectId: 'p', issues: ['S1 未接入'] });
    const b = createVerificationFixTask({ db, taskId: t2, projectId: 'p', issues: ['S1 未接入'] });
    ok(a.id !== b.id, 'A3 不同来源任务各立一条');
    eq((db.prepare("SELECT COUNT(*) AS c FROM wa_tasks WHERE source='agent'").get() as { c: number }).c, 2, 'A3 派生任务数 0→2');
    db.close();
  }

  // A4 交接判据：真标本两句 → handoff；真缺口 → items；待人 → manual
  {
    const sibling = ['后端测试用例补充与回归'];
    ok(isDeferredHandoff('未跑 Maven 编译：本轮零逻辑改动，编译留待 S1–S7 批次统一验证', sibling), 'A4 批次号 → 交接', 'S1–S7');
    ok(isDeferredHandoff('S1/S2/S6 的运行时行为证据留待子任务「后端测试用例补充与回归」（U1/U2/U3，H2 档）补齐', sibling), 'A4 点名子任务 → 交接');
    ok(isDeferredHandoff('真库回填留待子任务补齐', sibling), 'A4 仅含"子任务"字样 → 交接');
    ok(!isDeferredHandoff('回调地址未接入', sibling), 'A4 真缺口不判交接（反证）');
    ok(!isDeferredHandoff('存量数据留到下一批回填', sibling), 'A4 无承接方线索仍算缺口');
    const ex = extractDeferredItems([
      '编译留待 S1–S7 批次统一验证',
      '存量数据留到下一批回填',
      '留待人工在 GUI 补录',
    ], { siblingTitles: sibling });
    eq(ex.handoffItems, ['编译留待 S1–S7 批次统一验证'], 'A4 交接项单独成桶');
    eq(ex.items, ['存量数据留到下一批回填'], 'A4 真缺口仍在 items');
    eq(ex.manualItems, ['留待人工在 GUI 补录'], 'A4 待人项仍在 manualItems');
  }

  // A5 三层接线：IPC 摘要 / 列表徽标 / 详情入口
  {
    const ipc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/ipc/project.ipc.ts'), 'utf-8')).join('\n');
    ok(/verification_fix_of_title/.test(ipc), 'A5 task:list 摘要投影修复来源标题');
    const badges = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/lib/task-badges.ts'), 'utf-8')).join('\n');
    ok(/修复自：/.test(badges), 'A5 列表徽标 tooltip 含「修复自」');
    const page = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf-8')).join('\n');
    ok(/修复自：/.test(page) && /verification_fix_of_title/.test(page), 'A5 详情头部有可追溯入口');
  }

  // A6 收口接线：交接项不并入 issues、来源标题传给立项、登记行存在
  {
    const cf = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/control-finalize.ts'), 'utf-8')).join('\n');
    ok(/extractDeferredItems\(planContents, \{ siblingTitles \}\)/.test(cf), 'A6 兄弟标题已喂给延迟项抽取');
    ok(/deferred\.handoffItems/.test(cf), 'A6 交接项在收口路径被读取');
    ok(/\[交接登记\]/.test(cf), 'A6 交接项有独立登记行');
    ok(/reportTitle: planTitle/.test(cf), 'A6 立项时传入来源标题');
    ok(/merged\s*\?/.test(cf), 'A6 合并与新建分文案');
  }
}

// ── B 组「账」 ───────────────────────────────────────────────────────────────
{
  // B1 porcelain 解析（既有口径逐字保持：`??` 未跟踪，M/D/A/R 已修改）
  {
    const p = parsePorcelain('?? new.txt\n M a.txt\nD  b.txt\nR  c.txt -> d.txt\n!! ignored.txt\n');
    eq(p.untracked, ['new.txt'], 'B1 ?? 归未跟踪');
    eq(p.modified, ['a.txt', 'b.txt', 'c.txt -> d.txt'], 'B1 M/D/R 归已修改');
    ok(p.truncated === false, 'B1 未截断');
    const t = parsePorcelain('?? a\n?? b\n?? c\n', 2);
    ok(t.truncated === true && t.untracked.length === 2, 'B1 超上限如实标截断');
  }

  // B2 跨仓采集：根非仓 + 两个子仓
  const multi = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-wt-multi-'));
  const r1 = path.join(multi, 'r1');
  const r2 = path.join(multi, 'r2');
  try {
    for (const r of [r1, r2]) {
      fs.mkdirSync(r, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: r });
    }
    fs.writeFileSync(path.join(r1, 'a.txt'), 'x');
    fs.writeFileSync(path.join(r2, 'b.txt'), 'y');
    const statuses = collectRepoStatuses(multi);
    eq(statuses.map((s) => s.rel).sort(), ['r1', 'r2'], 'B2 采到两个子仓');
    eq(statuses.find((s) => s.rel === 'r1')!.untracked, ['a.txt'], 'B2 子仓内路径按仓内相对');
    eq(statusPaths(statuses.find((s) => s.rel === 'r1')!), ['r1/a.txt'], 'B2 并集路径带子仓前缀');

    // B3 起点基线：非仓根也能采（旧实现此处恒 null）
    const base = captureRunStartBaseline(multi, 'run-multi');
    ok(!!base, 'B3 非仓根布局仍采到基线（旧实现为 null）');
    ok(!!base && base.untracked.includes('r1/a.txt') && base.untracked.includes('r2/b.txt'), 'B3 并集含两仓路径');
    eq(base?.repos?.map((r) => r.rel).sort(), ['r1', 'r2'], 'B3 repos 逐仓明细在册');

    // B4 干净仓 ⇒ 不计入；全干净 ⇒ 基线 null
    execFileSync('git', ['-C', r1, '-c', 'user.name=rr', '-c', 'user.email=rr@example.com', 'add', 'a.txt']);
    execFileSync('git', ['-C', r1, '-c', 'user.name=rr', '-c', 'user.email=rr@example.com', 'commit', '-qm', 'x']);
    const onlyR2 = captureRunStartBaseline(multi, 'run-clean-r1');
    ok(!!onlyR2 && onlyR2.untracked.includes('r2/b.txt') && !onlyR2.untracked.includes('r1/a.txt'), 'B4 干净仓不出现在基线');
    execFileSync('git', ['-C', r2, '-c', 'user.name=rr', '-c', 'user.email=rr@example.com', 'add', 'b.txt']);
    execFileSync('git', ['-C', r2, '-c', 'user.name=rr', '-c', 'user.email=rr@example.com', 'commit', '-qm', 'y']);
    eq(captureRunStartBaseline(multi, 'run-all-clean'), null, 'B4 全干净 ⇒ null（不编基线）');

    // B5 单仓布局逐字兼容：untracked 为仓内相对路径（rr_zx_20261116_3 C4 同形）
    const single = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-wt-single-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: single });
      fs.writeFileSync(path.join(single, 'pre-existing.txt'), 'x');
      const b = captureRunStartBaseline(single, 'run-1');
      ok(!!b && b.untracked.includes('pre-existing.txt'), 'B5 单仓基线路径逐字不变');
    } finally {
      fs.rmSync(single, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(multi, { recursive: true, force: true });
  }

  // B6 三组对账（纯函数）
  {
    const baseline = { runId: 'r', at: '2026-11-19T00:00:00.000Z', untracked: ['a.txt', 'b.txt'], modified: ['m.txt'] };
    const g = reconcileStartBaseline(baseline, ['b.txt', 'c.txt', 'm.txt']);
    eq(g.preexisting, ['b.txt', 'm.txt'], 'B6 开局既有 = 交集');
    eq(g.added, ['c.txt'], 'B6 本轮新增 = 现状差集');
    eq(g.vanished, ['a.txt'], 'B6 开局消失 = 基线差集');
    // 纯函数本身如实把现状归「新增」；"无基线不误报"由取数器守（无基线直接返回空）。
    eq(reconcileStartBaseline(null, ['x']), { preexisting: [], added: ['x'], vanished: [] }, 'B6 纯函数对空基线的分组如实');
    const db = mkdb();
    const tid = crypto.randomUUID();
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?, 'p', '无基线任务', 'completed')").run(tid);
    eq(baselineReconcileChecks(db, tid, tmpRoot), [], 'B6 无基线 ⇒ 收口行全空（不拿"没基线"当"开局全干净"）');
    db.close();
  }

  // B7 收口行渲染：提交类任务要求报告逐条说明；非提交类不查报告
  {
    const groups = { preexisting: ['backend/src/test/resources/application-it.yml', 'b.txt'], added: ['c.txt'], vanished: [] };
    const commit = buildBaselineReconcileChecks(groups, { title: '方案收口与提交', description: '', reportText: '本次只提 backend 代码' });
    ok(commit.some((s) => s.includes('开局既有改动 2 项')), 'B7 开局既有行在册');
    ok(commit.some((s) => s.includes('本轮新增改动 1 项')), 'B7 本轮新增行在册');
    ok(commit.some((s) => s.startsWith('[WARN] 报告未逐条说明')), 'B7 提交类 + 报告未提 ⇒ WARN');
    const mentioned = buildBaselineReconcileChecks(groups, { title: '方案收口与提交', reportText: '删除 application-it.yml（开局既有）与 b.txt' });
    ok(!mentioned.some((s) => s.startsWith('[WARN] 报告未逐条说明')), 'B7 报告提到文件名 ⇒ 不告警');
    const nonCommit = buildBaselineReconcileChecks(groups, { title: '修复回调', reportText: '无关' });
    ok(!nonCommit.some((s) => s.includes('报告未逐条说明')), 'B7 非提交类不查报告');
    ok(isCommitLikeTask('方案收口与提交', '') && isCommitLikeTask('入库变更', ''), 'B7 提交类判据命中');
    ok(!isCommitLikeTask('实现回调', '实现提现打款'), 'B7 普通任务不误判');
  }

  // B8 Git 提示跨仓 + 两出口接线
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-wt-adv-'));
    try {
      for (const n of ['x1', 'x2']) {
        const r = path.join(dir, n);
        fs.mkdirSync(r, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: r });
        fs.writeFileSync(path.join(r, 'f.txt'), 'z');
      }
      const advice = gitWorkingTreeAdvice(dir);
      ok(!!advice && advice.includes('跨 2 个仓') && advice.includes('x1') && advice.includes('x2'), 'B8 多仓提示按仓分列', advice ?? 'null');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const cf = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/control-finalize.ts'), 'utf-8')).join('\n');
    ok(/baselineReconcileChecks\(db, taskId, workingDir\)/.test(cf), 'B8 finalize_task 出口接对账');
    const ef = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/exec-finalize.ts'), 'utf-8')).join('\n');
    ok(/baselineReconcileChecks\(db, taskId, workingDir\)/.test(ef), 'B8 run_close 出口同尺');
    const rb = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/run-baseline.ts'), 'utf-8')).join('\n');
    ok(/collectRepoStatuses\(workingDir\)/.test(rb), 'B8 基线改走跨仓采集');
  }
}

// ── C 组「审」 ───────────────────────────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-precheck-'));
  const f1 = path.join(dir, 'a.md');
  const f2 = path.join(dir, 'b.md');
  const missing = path.join(dir, 'gone.md');
  fs.writeFileSync(f1, 'x');
  fs.writeFileSync(f2, 'y');
  const addTask = (db: Database.Database, id: string, title: string, parent: string | null): void => {
    db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id) VALUES (?, ?, ?, ?, ?)').run(id, 'p', title, 'completed', parent);
  };
  const addDeliv = (db: Database.Database, taskId: string, p: string): void => {
    db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status) VALUES (?, 'p', ?, 'doc', ?, ?, 'completed')")
      .run(crypto.randomUUID(), taskId, path.basename(p), p);
  };

  // C1 有缺件：如实点名，不说"通过/验收"
  {
    const db = mkdb();
    const parent = crypto.randomUUID();
    const c1 = crypto.randomUUID();
    const c2 = crypto.randomUUID();
    addTask(db, parent, '父', null);
    addTask(db, c1, '子一', parent);
    addTask(db, c2, '子二', parent);
    addDeliv(db, c1, f1);
    addDeliv(db, c1, f2);
    addDeliv(db, c1, missing);
    const r = preflightChildrenArtifacts(db, parent);
    eq(r.children, 2, 'C1 直接子任务数 0→2');
    eq(r.checked, 3, 'C1 核对 3 件');
    eq(r.missing.map((m) => m.path), [missing], 'C1 缺件恰为不在盘上的那件');
    eq(r.childrenWithoutDeliverables, 1, 'C1 未登记产出物的子任务数=1（不是"缺文件"）');
    const note = buildArtifactPrecheckNote(r);
    ok(note.includes(missing) && note.includes('不得声称已完成'), 'C1 提示词点名缺件并要求如实说明', note);
    ok(!note.includes('验收'), 'C1 提示词不出现"验收"（不冒充验收）');
    db.close();
  }

  // C2 全在盘上：只报"均在盘上"
  {
    const db = mkdb();
    const parent = crypto.randomUUID();
    const c1 = crypto.randomUUID();
    addTask(db, parent, '父', null);
    addTask(db, c1, '子', parent);
    addDeliv(db, c1, f1);
    addDeliv(db, c1, f2);
    const r = preflightChildrenArtifacts(db, parent);
    eq(r.missing, [], 'C2 无缺件');
    eq(r.checked, 2, 'C2 核对 2 件');
    const note = buildArtifactPrecheckNote(r);
    ok(note.includes('均在盘上') && !note.includes('不得声称'), 'C2 全在时只报在盘', note);
    db.close();
  }

  // C3 上限：每子 2 / 总数 3，5+5 件 ⇒ 核 3、未核 7（不静默突破）
  {
    const db = mkdb();
    const parent = crypto.randomUUID();
    addTask(db, parent, '父', null);
    for (const [i, child] of [crypto.randomUUID(), crypto.randomUUID()].entries()) {
      addTask(db, child, `子${i}`, parent);
      for (let k = 0; k < 5; k++) addDeliv(db, child, path.join(dir, `f-${i}-${k}.md`));
    }
    const r = preflightChildrenArtifacts(db, parent, { perChild: 2, totalLimit: 3 });
    eq(r.checked, 3, 'C3 总数上限生效（3 件）');
    eq(r.skipped, 7, 'C3 未核件数如实上报（10-3）');
    ok(buildArtifactPrecheckNote(r).includes('另有 7 件未核'), 'C3 提示词报未核件数');
    db.close();
  }

  // C4 没有任何可核产出物 / 没有子任务
  {
    const db = mkdb();
    const parent = crypto.randomUUID();
    addTask(db, parent, '父', null);
    const c1 = crypto.randomUUID();
    addTask(db, c1, '子', parent);
    const r1 = preflightChildrenArtifacts(db, parent);
    eq(r1.checked, 0, 'C4 无可核件 checked=0');
    ok(buildArtifactPrecheckNote(r1).includes('未登记可核产出物'), 'C4 如实说未登记');
    const r0 = preflightChildrenArtifacts(db, crypto.randomUUID());
    eq(buildArtifactPrecheckNote(r0), '[机检] 没有直接子任务，无可核产出物。', 'C4 无子任务如实说无可核');
    db.close();
  }

  // C5 接线：强制收口前调用并落账
  {
    const src = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/jobs/ai-task.ts'), 'utf-8')).join('\n');
    ok(/preflightChildrenArtifacts\(db, taskId\)/.test(src), 'C5 强制收口前调用机检');
    ok(/buildArtifactPrecheckNote\(precheck\)/.test(src), 'C5 机检结果渲染进提示词');
    ok(/parent_artifact_precheck/.test(src), 'C5 机检结果落 context');
    ok(/artifactPrecheckNote \? `\\n\\n\$\{artifactPrecheckNote\}`/.test(src), 'C5 提示词尾部拼接机检段');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── D 组「径」 ───────────────────────────────────────────────────────────────
{
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-path-'));
  const sub = path.join(wd, 'platform-web');
  const deep = path.join(sub, 'src', 'utils');
  fs.mkdirSync(deep, { recursive: true });
  const real = path.join(deep, 'bank-codes.ts');
  fs.writeFileSync(real, 'export const x = 1');

  // D1 后缀候选：非 git 仓走有界遍历
  {
    const cands = findPathCandidates([{ root: sub, label: 'platform-web' }], 'utils/bank-codes.ts');
    eq(cands.map((c) => c.path), [real], 'D1 子仓内按后缀找到文件');
    eq(cands.map((c) => c.label), ['platform-web'], 'D1 候选带仓名');
  }

  // D2 深度上限：深度 5 的文件不被遍历命中
  {
    const deepDir = path.join(sub, 'a', 'b', 'c', 'd', 'e');
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(path.join(deepDir, 'too-deep.ts'), 'x');
    const cands = findPathCandidates([{ root: sub, label: 'platform-web' }], 'too-deep.ts', { maxDepth: 3 });
    eq(cands, [], 'D2 超出深度上限不命中（有界）');
  }

  // D3 多命中截断到 limit
  {
    const many = path.join(wd, 'many');
    for (const n of ['a', 'b', 'c', 'd']) {
      fs.mkdirSync(path.join(many, n), { recursive: true });
      fs.writeFileSync(path.join(many, n, 'same.ts'), 'x');
    }
    const cands = findPathCandidates([{ root: many, label: 'many' }], 'same.ts', { limit: 3 });
    eq(cands.length, 3, 'D3 每字面量最多 3 个候选');
  }

  // D4 代拟判据：主路径缺失 + 子仓候选命中 ⇒ passed + 注明仓名
  {
    const res = proposeAcceptanceCriteria({
      title: 'x', description: '新建 utils/bank-codes.ts', deliverables: [],
      pathExists: fs.existsSync,
      resolveRelative: (p) => (path.isAbsolute(p) ? p : path.join(wd, p)),
      resolveRelativeCandidates: (p) => findPathCandidates([{ root: sub, label: 'platform-web' }], p),
    });
    const c = res.checked.find((x) => x.criterion.includes('utils/bank-codes.ts'));
    ok(c?.passed === true, 'D4 子仓命中即判达成', JSON.stringify(c));
    ok(!!c?.note && c.note.includes('位于子仓 platform-web'), 'D4 注明位于子仓');
  }

  // D5 反证：候选全不命中 ⇒ 仍 ✗，并如实报"已查 N 个子仓候选"
  {
    const res = proposeAcceptanceCriteria({
      title: 'x', description: '新建 utils/none.ts', deliverables: [],
      pathExists: fs.existsSync,
      resolveRelative: (p) => (path.isAbsolute(p) ? p : path.join(wd, p)),
      resolveRelativeCandidates: () => [{ path: path.join(wd, 'nope1.ts'), label: 'a' }, { path: path.join(wd, 'nope2.ts'), label: 'b' }],
    });
    const c = res.checked.find((x) => x.criterion.includes('utils/none.ts'));
    ok(c?.passed === false, 'D5 候选全不命中仍判未达成');
    ok(!!c?.note && c.note.includes('另查 2 个子仓候选未命中'), 'D5 如实报候选数');
  }

  // D6 旧行为不变：不注入候选 ⇒ 文案与旧口径逐字一致
  {
    const res = proposeAcceptanceCriteria({
      title: 'x', description: '新建 utils/none.ts', deliverables: [],
      pathExists: fs.existsSync,
      resolveRelative: (p) => (path.isAbsolute(p) ? p : path.join(wd, p)),
    });
    const c = res.checked.find((x) => x.criterion.includes('utils/none.ts'));
    ok(!!c?.note && c.note.includes('项目工作目录下不存在该路径') && !c.note.includes('子仓候选'), 'D6 未注入候选时文案不变');
  }

  // D7 接线：exec-acceptance 注入候选
  {
    const src = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/exec-acceptance.ts'), 'utf-8')).join('\n');
    ok(/collectRepoBoundary\(workingDir\)/.test(src), 'D7 候选根取仓边界');
    ok(/findPathCandidates\(candidateRoots, p\)/.test(src), 'D7 候选解析接线');
    ok(/resolveRelativeCandidates:/.test(src), 'D7 只在有候选根时注入');
  }
  fs.rmSync(wd, { recursive: true, force: true });
}

// ── E 组「通」 ───────────────────────────────────────────────────────────────
{
  const v = (cmd: string, allow = true) => validateReadonlyBashCommand(cmd, { allowMultiSegment: allow });

  // E1 只读多段放行（开关开）
  for (const cmd of ['grep -n x a.java ; grep -n y b.java', 'ls ; pwd', 'cat a | head -5', 'ls && pwd', 'ls || pwd']) {
    ok(v(cmd).ok, `E1 放行：${cmd}`);
  }

  // E2 任一段可写/越界 ⇒ 整串拒（逐段检查，不看首段）
  for (const [cmd, why] of [
    ['grep x a ; rm -rf b', '写类命令'],
    ['ls ; npm run build', '非白名单'],
    ['ls > out.txt', '重定向'],
    ['ls ; cd /tmp', 'cd'],
    ['ls &', '单个 &'],
    ['echo $(whoami)', '命令替换'],
  ] as const) {
    ok(!v(cmd).ok, `E2 仍拒：${why} — ${cmd}`);
  }

  // E3 关开关 ⇒ 逐字回到旧行为（分隔符一律拒）
  ok(!v('ls ; pwd', false).ok, 'E3 开关关 ⇒ ; 仍拒');
  ok(v('cat a | head -5', false).ok, 'E3 开关关 ⇒ 管道仍放行（旧行为）');

  // E4 段数上限
  {
    const many = Array.from({ length: 9 }, () => 'ls').join(';');
    const bad = v(many);
    ok(!bad.ok, 'E4 超过 8 段拒绝');
    if (!bad.ok) ok(JSON.stringify(bad.payload).includes('超过单次上限'), 'E4 拒绝文案报段数上限');
  }

  // E5 能力简报与工具描述同步（不写死条数）
  {
    const brief = buildToolConstraintBrief();
    ok(brief.includes('只读多段'), 'E5 能力简报说明只读多段');
    const shellSrc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/shell.ts'), 'utf-8')).join('\n');
    ok(shellSrc.includes('只读多段'), 'E5 bash 工具描述说明只读多段');
    ok(/validateReadonlyBashCommand\(command, \{ allowMultiSegment: readBoolSetting\(db, 'engine.shell_multi_segment'\) \}\)/.test(shellSrc), 'E6 开关接线（缺省开、可关）');
  }
}

// ── F 组「序」 ───────────────────────────────────────────────────────────────
{
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-lock-'));
  const locks = path.join(rootDir, 'locks');
  const repo = path.join(rootDir, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const base = { repoRoot: repo, taskId: 'ta', command: 'mvn clean', lockDirOverride: locks };

  // F1 无锁 ⇒ 认领成功
  {
    const r = acquireBuildLock(base);
    ok(r.ok, 'F1 无锁认领成功');
    ok(fs.existsSync(r.lockPath), 'F1 锁文件落盘');
    eq(readBuildLock(r.lockPath)?.taskId, 'ta', 'F1 锁内 taskId 正确');
  }

  // F2 有主 ⇒ 第二次拒绝并带回持有者
  {
    const r = acquireBuildLock({ ...base, taskId: 'tb', command: 'pnpm build' });
    ok(!r.ok, 'F2 有主时第二次拒绝');
    if (!r.ok) {
      eq(r.holder.taskId, 'ta', 'F2 持有者 taskId');
      eq(r.holder.command, 'mvn clean', 'F2 持有者命令');
    }
  }

  // F3 同任务重入 ⇒ 成功（幂等续期）
  {
    const r = acquireBuildLock({ ...base, now: Date.now() + 1000 });
    ok(r.ok, 'F3 同任务重入成功');
  }

  // F4 过期自愈 ⇒ 他人可接管
  {
    const r = acquireBuildLock({ ...base, taskId: 'tc', now: Date.now() + 60 * 60 * 1000 });
    ok(r.ok, 'F4 过期后他人可接管');
    eq(readBuildLock(r.ok ? r.lockPath : '')?.taskId, 'tc', 'F4 接管后持有者易主');
  }

  // F5 释放：非本人不删、本人删净
  {
    ok(!releaseBuildLock({ ...base, taskId: 'td' }), 'F5 非持有者释放失败');
    ok(fs.existsSync(buildLockPath(repo, locks)), 'F5 非持有者释放后文件仍在');
    ok(releaseBuildLock({ ...base, taskId: 'tc' }), 'F5 持有者释放成功');
    ok(!fs.existsSync(buildLockPath(repo, locks)), 'F5 释放后锁文件消失');
    ok(releaseBuildLock({ ...base, taskId: 'tc' }), 'F5 重复释放幂等');
  }

  // F6 触发面：只认全仓构建/清理
  for (const cmd of ['mvn -o test', 'mvn clean', 'cd backend && mvn package', 'gradle build', './gradlew clean', 'npm run build', 'pnpm build', 'yarn build', 'tsc -b', 'rm -rf target', 'rm -rf node_modules']) {
    ok(isRepoWideBuildCommand(cmd), `F6 触发：${cmd}`);
  }
  for (const cmd of ['mvn -v', 'grep -n x a.java', 'tsc file.ts', 'npm run dev', 'rm -rf build', 'ls target']) {
    ok(!isRepoWideBuildCommand(cmd), `F6 不触发：${cmd}`);
  }

  // F7 锁根：`cd backend` 且该目录是仓 ⇒ 锁在 backend
  {
    fs.mkdirSync(path.join(repo, 'backend', '.git'), { recursive: true });
    eq(buildLockRoot(repo, 'cd backend && mvn -o test'), path.join(repo, 'backend'), 'F7 cd 到子仓 ⇒ 锁子仓');
    eq(path.resolve(buildLockRoot(repo, 'grep x')), repo, 'F7 无 cd ⇒ 回落 cwd');
  }

  // F8 锁文件位置：有 .git 目录 ⇒ 仓内；否则临时目录
  {
    ok(buildLockPath(repo).endsWith(path.join('.git', 'wa-build.lock')), 'F8 有 .git ⇒ 锁在仓内');
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-nogit-lock-'));
    const p = buildLockPath(noGit);
    ok(!p.startsWith(noGit), 'F8 无 .git ⇒ 回落系统临时目录');
    fs.rmSync(noGit, { recursive: true, force: true });
  }

  // F9 开关接线与缺省值
  {
    const db = mkdb();
    ok(readBoolSetting(db, 'engine.repo_build_lock') === true, 'F9 开关缺省即开');
    db.close();
    const shellSrc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/shell.ts'), 'utf-8')).join('\n');
    ok(/isRepoWideBuildCommand\(args\.command\)/.test(shellSrc), 'F9 执行前判是否全仓构建');
    ok(/acquireBuildLock\(\{ repoRoot, taskId, command: args\.command \}\)/.test(shellSrc), 'F9 认领锁');
    ok(/releaseBuildLock\(\{ repoRoot: buildLock\.repoRoot, taskId, lockPath: buildLock\.lockPath \}\)/.test(shellSrc), 'F9 释放锁');
    ok(/deny_kind: 'build_locked'/.test(shellSrc), 'F9 拒绝有独立 deny_kind');
    const sb = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/settings-bool.ts'), 'utf-8')).join('\n');
    ok(/engine\.repo_build_lock/.test(sb), 'F9 开关在白名单');
    const sp = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/SettingsPage.tsx'), 'utf-8')).join('\n');
    ok(/'engine\.repo_build_lock':/.test(sp), 'F9 设置页有中文名（GUI 可点）');
  }
  fs.rmSync(rootDir, { recursive: true, force: true });
}

// ── G 组「度」 ───────────────────────────────────────────────────────────────
{
  const addEvidence = (db: Database.Database, taskId: string, ok: number, deny: string | null, cmd = 'ls'): void => {
    db.prepare(
      "INSERT INTO wa_task_runtime_evidence (id, task_id, tool, command, ok, exit_code, timed_out, deny_reason, created_at) VALUES (?, ?, 'bash', ?, ?, 0, 0, ?, datetime('now'))",
    ).run(crypto.randomUUID(), taskId, cmd, ok, deny);
  };

  // G1 计数与归类（deny_kind 优先；历史文案按措辞；无 deny_reason 不计入拒绝）
  {
    const db = mkdb();
    const tid = crypto.randomUUID();
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?, 'p', 't', 'completed')").run(tid);
    addEvidence(db, tid, 1, null);
    addEvidence(db, tid, 0, 'deny_kind=exploration_limit; 探索配额耗尽');
    addEvidence(db, tid, 0, 'deny_kind=illegal_char; 命令包含非法字符');
    addEvidence(db, tid, 0, '重定向被禁止，写文件请用 write_file');
    addEvidence(db, tid, 0, null); // 普通命令失败（退出码非 0），不是拒绝
    const s = summarizeToolDenials(db, tid);
    eq(s.calls, 5, 'G1 运行证据总条数 0→5');
    eq(s.ok, 1, 'G1 成功条数');
    eq(s.total, 3, 'G1 拒绝只数有 deny_reason 的行');
    eq(s.byKind, { exploration_limit: 1, illegal_char: 1, redirect: 1 }, 'G1 类别归类（deny_kind 优先 + 措辞兜底）');
    db.close();
  }

  // G2 收口行：无账不出行；被迫收尾且拒绝多 ⇒ WARN
  {
    eq(buildDenialCheckLine({ total: 0, byKind: {}, calls: 0, ok: 0 }, null), null, 'G2 无账不出行');
    const info = buildDenialCheckLine({ total: 3, byKind: { exploration_limit: 2, illegal_char: 1 }, calls: 9, ok: 6 }, null);
    ok(!!info && info.startsWith('[INFO] 本轮工具拒绝 3 次'), 'G2 有拒绝出 INFO', info ?? 'null');
    const many = { total: 12, byKind: { exploration_limit: 12 }, calls: 40, ok: 28 };
    const warn = buildDenialCheckLine(many, { used: 90, estimate: 25, grants: 1 }, true);
    ok(!!warn && warn.startsWith('[WARN] 被迫收尾且'), 'G2 被迫收尾 + 拒绝≥10 ⇒ WARN', warn ?? 'null');
    const noWarn = buildDenialCheckLine(many, null, false);
    ok(!!noWarn && noWarn.startsWith('[INFO]'), 'G2 非被迫收尾 ⇒ 仍 INFO');
  }

  // G3 落账：写 tool_denials / steps_ledger；无账不写
  {
    const db = mkdb();
    const tid = crypto.randomUUID();
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, 'p', 't', 'completed', ?)")
      .run(tid, JSON.stringify({ execution_metrics: { stepsUsed: 90 }, task_estimate: { steps: 25 }, step_cap_grants: 1 }));
    eq(recordToolDenialLedger(db, tid), '[INFO] 本轮步数 90/25（续额 1 次）。', 'G3 只有步数 ⇒ 只报步数');
    let ctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id=?').get(tid) as { context_json: string }).context_json) as Record<string, unknown>;
    eq(ctx.steps_ledger, { used: 90, estimate: 25, grants: 1 }, 'G3 步数账落 context');
    eq(ctx.tool_denials, undefined, 'G3 无拒绝不写 tool_denials（不编 0）');
    addEvidence(db, tid, 0, 'deny_kind=exploration_limit; x');
    addEvidence(db, tid, 0, 'deny_kind=illegal_char; y');
    const line = recordToolDenialLedger(db, tid);
    ok(!!line && line.includes('工具拒绝 2 次'), 'G3 有拒绝后收口行含计数', line ?? 'null');
    ctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id=?').get(tid) as { context_json: string }).context_json) as Record<string, unknown>;
    eq((ctx.tool_denials as { total: number }).total, 2, 'G3 tool_denials 落 context');
    db.close();
  }

  // G4 完成事件：quality 带 tool_denials / steps（无账不带）
  {
    const db = mkdb();
    const t1 = crypto.randomUUID();
    const t2 = crypto.randomUUID();
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, 'p', '有账', 'completed', ?)")
      .run(t1, JSON.stringify({ completion_quality: { score: 80, via: 'run_close', goal_achieved: true, goal_evidence: 'score_only' }, execution_metrics: { stepsUsed: 90 }, task_estimate: { steps: 25 }, step_cap_grants: 1 }));
    addEvidence(db, t1, 0, 'deny_kind=exploration_limit; x');
    const o1 = buildTaskOutcome(db as never, t1);
    eq(o1.quality?.tool_denials?.total, 1, 'G4 完成事件带工具拒绝计数');
    eq(o1.quality?.steps, { used: 90, estimate: 25, grants: 1 }, 'G4 完成事件带步数');
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, 'p', '无账', 'completed', ?)")
      .run(t2, JSON.stringify({ completion_quality: { score: 80, via: 'finalize_task', goal_achieved: true, goal_evidence: 'score_only' } }));
    const o2 = buildTaskOutcome(db as never, t2);
    eq(o2.quality?.tool_denials, undefined, 'G4 无拒绝不带该键（不编 0）');
    eq(o2.quality?.steps, undefined, 'G4 无步数不带该键');
    db.close();
  }

  // G5 接线：两出口 + 摘要 + 详情
  {
    const cf = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/control-finalize.ts'), 'utf-8')).join('\n');
    ok(/recordToolDenialLedger\(db, taskId, \{ premature \}\)/.test(cf), 'G5 finalize_task 出口落账');
    const ef = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/exec-finalize.ts'), 'utf-8')).join('\n');
    ok(/recordToolDenialLedger\(db, taskId\)/.test(ef), 'G5 run_close 出口同尺');
    const ipc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/ipc/project.ipc.ts'), 'utf-8')).join('\n');
    ok(/tool_denials/.test(ipc) && /steps_ledger/.test(ipc), 'G5 列表摘要投影两项');
    const page = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf-8')).join('\n');
    ok(/工具拒绝 \{denialSummary\.total\} 次/.test(page) && /步数 \{stepsLedger\.used\}/.test(page), 'G5 详情页可见');
  }
}

// ── H 组「证」 ───────────────────────────────────────────────────────────────

{
  checkBuildPins(ok);
  const src = fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf-8');
  const m = /build:\s*'(zx_\d{8}(?:_\d+)?)'/.exec(src);
  const tag = m?.[1] ?? '';
  ok(buildNotOlderThan(tag, SELF.replace(/^rr_/, '')), 'H1 build 不早于本套件轮次', `${tag} vs ${SELF}`);
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail === 0 ? 0 : 1);
