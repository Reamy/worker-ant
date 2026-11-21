/**
 * zx_20261116_1 「续·界·辨」受控复跑。
 *
 * 分组（与方案 §3 批次一一对应，按实施顺序追加）：
 *   A「续」失败子恢复后，父任务因由必须降回 children_incomplete（M1）
 *   B「辨」核实问题抽取三账分账（M3）
 *   C「界」方案轮“不动代码”沿祖先链继承（M2）
 *   D「接」pending 任务的「开始执行」接到开跑（M4）
 *   E「溯」429 来源标记（M5，按实证结果追加）
 *   F「净/序」成果路径围栏 + 派生修复任务串行边界（M6）
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引生产函数/真实现（被删/改名即编译期失败）。
 *   · 两侧标本同试；计数器类断言给 0→1 正面值。
 *   · 断言文案不含失败字形（汇总器按字形计数）。
 *   · 表结构走生产 `initDatabase`（自建 DDL 照不出建表/迁移缺陷）。
 *   · 夹具按生产初始化顺序：先 initDatabase，再插数据行。
 *   · 不以轮次字面量做等值断言；build 钉由 `checkBuildPins` 派生核对。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';
import { checkParentTaskAfterChildDone } from '../apps/worker-ant-desktop/src/main/core/jobs/ai-task.js';
import { buildTools } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { extractVerificationIssues, createVerificationFixTask, MAX_VERIFICATION_ISSUES } from '../apps/worker-ant-desktop/src/main/core/verification-issues.js';
import { inFlightSiblingIds } from '../apps/worker-ant-desktop/src/main/core/task-siblings.js';
import { nextActionForTask, resolveNextActionRoute } from '../apps/worker-ant-desktop/src/main/core/next-action.js';
import { computeSimilarTasks } from '../apps/worker-ant-desktop/src/main/core/task-similarity.js';
import { isRateLimitedError } from '../apps/worker-ant-desktop/src/main/core/exec-error.js';
import {
  PAUSE_REASON_CHILDREN_FAILED,
  PAUSE_REASON_CHILDREN_INCOMPLETE,
} from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ok ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261116-1-'));
let dbSeq = 0;

function mkdb(): Database.Database {
  const db = initDatabase(path.join(tmpdir, `db-${++dbSeq}`));
  db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p', 'P', ?)").run(tmpdir);
  return db;
}

function addTask(db: Database.Database, id: string, status: string, parent = '', ctx: Record<string, unknown> = {}): void {
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id, context_json) VALUES (?, 'p', ?, ?, ?, ?)")
    .run(id, id, status, parent, JSON.stringify(ctx));
}

function statusOf(db: Database.Database, id: string): string {
  return (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
}

function ctxOf(db: Database.Database, id: string): Record<string, unknown> {
  return JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}');
}

function healingCount(db: Database.Database): number {
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM wa_self_healing_logs').get() as { c: number }).c;
  } catch {
    return 0; // 表由 logHealing 建（唯一入口）；还没记过账时为 0
  }
}

/* ═══ A｜M1：失败子恢复后，父因由降回“等子” ═══════════════════════════════ */

async function groupA(): Promise<void> {
  console.log('\n【A】M1 失败子恢复后，父因由降回 children_incomplete');

  {
    const db = mkdb();
    addTask(db, 'a-p1', 'paused', '', { pause_reason: PAUSE_REASON_CHILDREN_FAILED, keep_me: 'x' });
    addTask(db, 'a-c1', 'failed', 'a-p1');
    addTask(db, 'a-c2', 'pending', 'a-p1');
    db.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = 'a-c1'").run();
    const jobs: Array<{ type: string }> = [];
    checkParentTaskAfterChildDone(db, 'a-c1', { enqueue: (type) => { jobs.push({ type }); return Promise.resolve(); } });
    eq(statusOf(db, 'a-p1'), 'paused', 'A1 仍有 pending 兄弟 ⇒ 父保持 paused');
    eq(ctxOf(db, 'a-p1').pause_reason, PAUSE_REASON_CHILDREN_INCOMPLETE,
      'A1 失败子归零 ⇒ 父因由由 children_failed 降回 children_incomplete');
    eq(ctxOf(db, 'a-p1').keep_me, 'x', 'A1 兄弟键 keep_me 未被整体重写抹掉');
    eq(jobs.length, 0, 'A1 仍有 pending 兄弟 ⇒ 不入队恢复（0 次）');
  }

  {
    const db = mkdb();
    addTask(db, 'a-p2', 'paused', '', { pause_reason: PAUSE_REASON_CHILDREN_FAILED });
    addTask(db, 'a-c21', 'failed', 'a-p2');
    addTask(db, 'a-c22', 'pending', 'a-p2');
    db.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = 'a-c21'").run();
    checkParentTaskAfterChildDone(db, 'a-c21', { enqueue: () => Promise.resolve() });
    db.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = 'a-c22'").run();
    const jobs: Array<{ type: string; payload: Record<string, unknown> }> = [];
    checkParentTaskAfterChildDone(db, 'a-c22', {
      enqueue: (type, payload) => { jobs.push({ type, payload }); return Promise.resolve(); },
    });
    eq(statusOf(db, 'a-p2'), 'pending', 'A2 兄弟也完成后 ⇒ 父自动恢复 status=pending');
    eq(jobs.length, 1, 'A2 resume-ai-task 作业 0→1（既有防死锁判据未回退）');
    eq(jobs[0]?.type, 'resume-ai-task', 'A2 走既有 resume-ai-task 通道');
  }

  {
    const db = mkdb();
    addTask(db, 'a-p3', 'paused', '', { pause_reason: PAUSE_REASON_CHILDREN_FAILED });
    addTask(db, 'a-c31', 'failed', 'a-p3');
    addTask(db, 'a-c32', 'completed', 'a-p3');
    addTask(db, 'a-c33', 'pending', 'a-p3');
    const jobs: Array<{ type: string }> = [];
    checkParentTaskAfterChildDone(db, 'a-c32', { enqueue: (type) => { jobs.push({ type }); return Promise.resolve(); } });
    eq(ctxOf(db, 'a-p3').pause_reason, PAUSE_REASON_CHILDREN_FAILED,
      'A3 有真实 failed 子 ⇒ 因由保持 children_failed（不被一降了之）');
    eq(jobs.length, 0, 'A3 有真实 failed 子 ⇒ 不入队恢复');
  }

  {
    const db = mkdb();
    addTask(db, 'a-p4', 'pending', '', { pause_reason: PAUSE_REASON_CHILDREN_FAILED });
    addTask(db, 'a-c41', 'completed', 'a-p4');
    addTask(db, 'a-c42', 'pending', 'a-p4');
    checkParentTaskAfterChildDone(db, 'a-c41', { enqueue: () => Promise.resolve() });
    eq(ctxOf(db, 'a-p4').pause_reason, PAUSE_REASON_CHILDREN_FAILED,
      'A4 父不在 paused 态（pending）时**不改**因由');
  }

  {
    // 严格读：读失败返回 null，不返回 0
    const cg = await import('../apps/worker-ant-desktop/src/main/core/children-gate.js');
    const countStrict = (cg as unknown as { countFailedChildrenStrict?: (db: unknown, parentId: string) => number | null }).countFailedChildrenStrict;
    ok(typeof countStrict === 'function', 'A5 严格读数已导出（countFailedChildrenStrict）');
    if (countStrict) {
      const broken = { prepare: () => { throw new Error('db unavailable'); } };
      eq(countStrict(broken, 'x'), null, 'A5 严格读：查询失败 ⇒ null（不是 0）');
    }
  }

  {
    const db = mkdb();
    addTask(db, 'a-p5', 'paused', '', { pause_reason: PAUSE_REASON_CHILDREN_FAILED });
    addTask(db, 'a-c51', 'pending', 'a-p5');
    const before = healingCount(db);
    const mod = await import('../apps/worker-ant-desktop/src/main/core/self-healing-monitor.js');
    const fn = (mod as unknown as { reconcileStaleChildrenFailedReasons?: (db: Database.Database) => { repaired: string[] } }).reconcileStaleChildrenFailedReasons;
    ok(typeof fn === 'function', 'A5 巡检函数已导出（reconcileStaleChildrenFailedReasons）');
    if (fn) {
      const r = fn(db);
      eq(r.repaired, ['a-p5'], 'A5 巡检：0 failed + 1 pending 子 ⇒ 修复 1 个父任务');
      eq(ctxOf(db, 'a-p5').pause_reason, PAUSE_REASON_CHILDREN_INCOMPLETE, 'A5 巡检后因由降为 children_incomplete');
      eq(healingCount(db) - before, 1, 'A5 自愈账 0→1（正面断言）');
    }
  }

  {
    const db = mkdb();
    addTask(db, 'a-p6', 'paused', '', { pause_reason: PAUSE_REASON_CHILDREN_FAILED });
    addTask(db, 'a-c61', 'failed', 'a-p6');
    addTask(db, 'a-p7', 'paused', '', { pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE });
    addTask(db, 'a-c71', 'pending', 'a-p7');
    const mod = await import('../apps/worker-ant-desktop/src/main/core/self-healing-monitor.js');
    const fn = (mod as unknown as { reconcileStaleChildrenFailedReasons?: (db: Database.Database) => { repaired: string[] } }).reconcileStaleChildrenFailedReasons;
    if (fn) {
      const r = fn(db);
      eq(r.repaired, [], 'A5 反证：有真实 failed 子 / 本来就是等子因由 ⇒ 0 次');
      eq(ctxOf(db, 'a-p6').pause_reason, PAUSE_REASON_CHILDREN_FAILED, 'A5 反证：有 failed 子的父因由不变');
    }
  }

  {
    // 真实事故形状：2 completed + 3 pending、0 failed
    const db = mkdb();
    addTask(db, 'a-p8', 'paused', '', { pause_reason: PAUSE_REASON_CHILDREN_FAILED });
    addTask(db, 'a-c81', 'completed', 'a-p8');
    addTask(db, 'a-c82', 'completed', 'a-p8');
    addTask(db, 'a-c83', 'pending', 'a-p8');
    addTask(db, 'a-c84', 'pending', 'a-p8');
    addTask(db, 'a-c85', 'pending', 'a-p8');
    const mod = await import('../apps/worker-ant-desktop/src/main/core/self-healing-monitor.js');
    const fn = (mod as unknown as { reconcileStaleChildrenFailedReasons?: (db: Database.Database) => { repaired: string[] } }).reconcileStaleChildrenFailedReasons;
    if (fn) {
      fn(db);
      eq(ctxOf(db, 'a-p8').pause_reason, PAUSE_REASON_CHILDREN_INCOMPLETE,
        'A7 真库事故形状（2 completed + 3 pending + 0 failed）⇒ 因由降回 children_incomplete');
    }
  }

  {
    // 静态：回退写点只此一处，用 json_set，不整体重写
    const src = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/jobs/ai-task.ts'), 'utf8')).join('\n');
    eq((src.match(/countFailedChildrenStrict\(db, pid\)/g) || []).length, 1,
      'A6 静态：D1 内严格读数恰 1 处');
    ok(src.includes("json_set(COALESCE(context_json, '{}'), '$.pause_reason', ?)"),
      'A6 静态：因由回退走 json_set（不整体重写 context_json）');
    const gate = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/children-gate.ts'), 'utf8')).join('\n');
    eq((gate.match(/status = 'failed'/g) || []).length, 1,
      'A6 静态：failed 子谓词仍只在 children-gate 一处');
    ok(gate.includes('export function countFailedChildrenStrict'),
      'A6 静态：严格读数从 children-gate 导出（同一真源）');
  }
}

/* ═══ B｜M3：核实问题抽取三账分账 ═══════════════════════════════════════ */

async function groupB(): Promise<void> {
  console.log('\n【B】M3 核实问题抽取：可修 / 待人 / 提醒风险 三账分账');

  const realLine = '   | `hutool-core` | `5.8.36` | 工具（⚠ 与易宝 SDK 的 commons-lang3 依赖冲突史相关，见 §1.9 风险） |';
  {
    const ext = extractVerificationIssues([realLine]);
    eq(ext.issues, [], 'B1 真标本第 78 行不再进可修账');
    eq(ext.advisories.length, 1, 'B1 同一条进 advisories（登记、不立项）');
    ok(ext.advisories[0]?.includes('hutool-core'), 'B1 advisories 保留原文主语（可追溯）');
  }

  {
    const prod = '| 生产就绪 | ❌ 不通过 | 3 项上线阻断：后端 /upload 缺失、属地化定价未落地、履约定位为模拟实现 |';
    const ext = extractVerificationIssues([prod]);
    ok(ext.issues.some((s) => s.includes('缺失') || s.includes('未落地')), 'B2 同表可修行仍进 issues（含缺失/未落地）');
    eq(ext.advisories, [], 'B2 可修行不因新增 advisories 而漂');
  }

  {
    const row = '| 页面数据来源真实性 | ⚠️ 部分通过 | 11 页仍读静态 mock，其中**价格与后端锁价不同源**（R-10，交易正确性风险） |';
    const ext = extractVerificationIssues([row]);
    ok(ext.issues.some((s) => s.includes('不同源')), 'B3 既有 REPORT_TEXT 行仍进 issues（不同源优先于风险）');
  }

  {
    const heading = '## ❌ 支付回调未接入';
    const ext = extractVerificationIssues([heading]);
    eq(ext.issues.length, 1, 'B4 标题行“支付回调未接入”仍进 issues（既有行为不变）');
  }

  {
    const human = [
      '## ❌ 需 GUI 人工操作验证支付回调',
      '## ❌ 需运行实例 + MySQL 测试库',
      '## ❌ 需要在你们的服务器上重编译部署',
      '## ⚠️ 需扫码登录后手动截图核对',
      '## ❌ 分页 offset 与 total 不一致',
    ].join('\n');
    const ext = extractVerificationIssues([human]);
    eq(ext.manualItems.length, 4, 'B5 四条待人项仍进 manualItems');
    eq(ext.issues.length, 1, 'B5 可修项仍进 issues（待人/可修不互吞）');
    eq(ext.advisories, [], 'B5 待人/可修都不进 advisories');
  }

  {
    const mixed = '## ❌ 支付回调未接入（安全风险）';
    const ext = extractVerificationIssues([mixed]);
    eq(ext.issues.length, 1, 'B6 同时含可修词与风险 ⇒ 可修优先（进 issues）');
    eq(ext.advisories, [], 'B6 不在 advisories 重复记账');
  }

  {
    const many = Array.from({ length: MAX_VERIFICATION_ISSUES + 1 }, (_, i) => `## ⚠ 风险提示第 ${i + 1} 项，见风险登记`).join('\n');
    const ext = extractVerificationIssues([many]);
    eq(ext.advisories.length, MAX_VERIFICATION_ISSUES, 'B6 advisories 上限生效');
    eq(ext.advisoryOverflow, 1, 'B6 advisories 超出数如实计数（不被静默截断）');
    eq(ext.issues, [], 'B6 风险提示不混进可修账');
  }

  {
    const dup = `${realLine}\n${realLine}`;
    eq(extractVerificationIssues([dup]).advisories.length, 1, 'B6 同一条提醒重复出现 ⇒ 去重后 1 条');
  }
}

/* ═══ C｜M2：方案轮“不动代码”沿祖先链继承 ═══════════════════════════════ */

function addDoc(db: Database.Database, id: string, taskId: string, filePath: string): void {
  db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, status, file_path) VALUES (?, 'p', ?, 'doc', ?, 'draft', ?)")
    .run(id, taskId, path.basename(filePath), filePath);
}

function addConv(db: Database.Database, taskId: string): void {
  db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count) VALUES (?, ?, 'assistant', ?, 0)")
    .run(`conv-${taskId}`, taskId, '核验完成，详见报告');
}

async function finalizeReport(db: Database.Database, taskId: string): Promise<{ status?: string; checks?: string[]; error?: string }> {
  const tools = buildTools({ db } as never, taskId, 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
  const raw = await tools.finalize_task!.execute({ summary: '核验完成', quality: 'good' });
  return JSON.parse(raw) as { status?: string; checks?: string[]; error?: string };
}

function seedReport(db: Database.Database, reportId: string, plan: { id: string; status: string; title: string; description: string }, reportCtx: Record<string, unknown> = {}): string {
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, description, context_json) VALUES (?, 'p', ?, ?, ?, ?)")
    .run(plan.id, plan.title, plan.status, plan.description, JSON.stringify({}));
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id, context_json) VALUES (?, 'p', ?, 'executing', ?, ?)")
    .run(reportId, '核实报告', plan.id, JSON.stringify(reportCtx));
  const reportPath = path.join(tmpdir, `${reportId}.md`);
  fs.writeFileSync(reportPath, [
    '# 核实报告',
    '',
    '## ❌ 支付回调未接入',
    '',
    '| hutool-core | 5.8.36 | 工具（⚠ 与易宝 SDK 的 commons-lang3 依赖冲突史相关，见 §1.9 风险） |',
  ].join('\n'), 'utf-8');
  addDoc(db, `doc-${reportId}`, reportId, reportPath);
  addConv(db, reportId);
  return reportPath;
}

async function groupC(): Promise<void> {
  console.log('\n【C】M2 方案轮“只形成方案不动代码”沿祖先链继承');

  {
    const db = mkdb();
    seedReport(db, 'c-report', {
      id: 'c-plan', status: 'paused',
      title: '新后端对接易宝支付对接规划方案',
      description: '此次任务只形成方案不动代码',
    }, { verification_manual_items: ['m'], keep_me: 'x' });
    const out = await finalizeReport(db, 'c-report');
    eq(out.status, 'finalized', 'C1 报告照常收口（不因方案边界被卡）');
    const fixes = (db.prepare("SELECT COUNT(*) c FROM wa_tasks WHERE depends_on = 'c-report'").get() as { c: number }).c;
    eq(fixes, 0, 'C1 上层为方案轮 ⇒ 不自动派修复任务（0 个）');
    const ctx = ctxOf(db, 'c-report');
    eq((ctx.verification_deferred_items as string[]).length, 1, 'C1 未落地问题登记到 verification_deferred_items（0→1）');
    eq((ctx.verification_advisories as string[]).length, 1, 'C1 提醒/风险项登记到 verification_advisories（0→1，M3 接线）');
    ok((out.checks ?? []).join('\n').includes('不自动派修复任务'), 'C1 checks 明说“不自动派修复任务”');
    eq(ctx.verification_manual_items, ['m'], 'C5 json_set 保留兄弟键 verification_manual_items');
    eq(ctx.keep_me, 'x', 'C5 json_set 保留兄弟键 keep_me');
  }

  {
    const db = mkdb();
    seedReport(db, 'c-report2', {
      id: 'c-plan2', status: 'paused',
      title: '实施任务', description: '按方案改代码',
    });
    const out = await finalizeReport(db, 'c-report2');
    eq(out.status, 'finalized', 'C2 无方案边界的报告照常收口');
    const fixes = (db.prepare("SELECT COUNT(*) c FROM wa_tasks WHERE depends_on = 'c-report2'").get() as { c: number }).c;
    eq(fixes, 1, 'C2 反证：无方案边界 ⇒ 修复任务 0→1（既有行为不变）');
    eq((ctxOf(db, 'c-report2').verification_advisories as string[]).length, 1, 'C2 修复任务照建，提醒/风险项仍登记（两账不互吞）');
  }

  {
    const db = mkdb();
    seedReport(db, 'c-report3', {
      id: 'c-plan3', status: 'completed',
      title: '新后端对接易宝支付对接规划方案',
      description: '此次任务只形成方案不动代码',
    });
    const out = await finalizeReport(db, 'c-report3');
    eq(out.status, 'finalized', 'C3 终态方案祖先下的报告照常收口');
    const fixes = (db.prepare("SELECT COUNT(*) c FROM wa_tasks WHERE depends_on = 'c-report3'").get() as { c: number }).c;
    eq(fixes, 1, 'C3 终态祖先不继承（本轮裁定）⇒ 修复任务仍可建');
  }

  {
    const scopeSrc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/plan-scope.ts'), 'utf8')).join('\n');
    eq((scopeSrc.match(/PLAN_ONLY_RE/g) || []).length, 2, 'C4 静态：PLAN_ONLY_RE 只在一处定义 + 一处使用');
    ok(scopeSrc.includes('collectAncestorIds'), 'C4 静态：祖先收集走既有唯一真源 collectAncestorIds');
    const cfSrc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/control-finalize.ts'), 'utf8')).join('\n');
    ok(cfSrc.includes('planOnlyScope(db, taskId)'), 'C4 静态：检查 7 已接 planOnlyScope');
    // zx_20261117_1 M1「案」：旧裸正则已被纯函数取代——按**更强新真源**重定向（禁删/禁放宽）：
    //   钉"调用纯函数"与"旧裸正则已删"两条，而不是继续钉旧实现。
    ok(cfSrc.includes('isPlanProposalText(planTitle, planDescription)'), 'C4 静态：检查 7 使用 isPlanProposalText（可复核纯函数）');
    ok(!cfSrc.includes('/(规划|排期)/'), 'C4 静态：旧裸正则 /(规划|排期)/ 已删（不再全题面误伤）');
  }
}

/* ═══ D｜M4：pending 的「开始执行」接到开跑 ═══════════════════════════════ */

function groupD(): void {
  console.log('\n【D】M4 第一行动作按状态分流');

  eq(resolveNextActionRoute('start_task', 'pending'), 'start', 'D1 pending + start_task ⇒ start（走 task:updateStatus running）');
  eq(resolveNextActionRoute('start_task', 'failed'), 'resume', 'D1 failed + start_task ⇒ resume');
  eq(resolveNextActionRoute('start_task', 'paused'), 'resume', 'D1 paused + start_task ⇒ resume');
  eq(resolveNextActionRoute('start_task', 'executing'), 'resume', 'D1 ghost(executing) + start_task ⇒ resume（live/queued 不产生动作）');
  eq(resolveNextActionRoute('answer_task', 'paused'), 'reply', 'D1 answer_task ⇒ reply');
  eq(resolveNextActionRoute('view_tasks', 'paused'), 'ignore', 'D1 其余动作 ⇒ ignore');

  const na = nextActionForTask({ status: 'pending', depState: 'met', execState: 'idle' });
  eq([na.key, na.action?.id], ['task.pending', 'start_task'], 'D3 pending 第一行动作的 key/id 不变（文案与稳定键不漂）');

  const page = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf8')).join('\n');
  ok(page.includes('resolveNextActionRoute(aid, task.status)'), 'D2 静态：页面第一行动作走 resolveNextActionRoute');
  ok(!page.includes("else if (aid === 'start_task') void handleResume(task.id)"),
    'D2 静态：旧的“start_task 一律 handleResume”接线已移除');
  ok(page.includes("route === 'start'") && page.includes("handleStatus(task.id, 'running')"),
    'D2 静态：start 路由接到 task:updateStatus running');

  const ipc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/ipc/project.ipc.ts'), 'utf8')).join('\n');
  ok(ipc.includes("['paused', 'failed', 'completed'].includes(task.status)"),
    'D4 反证：task:resume 的状态守卫仍不含 pending（不为了让按钮可用而放宽后端）');
}

/* ═══ G｜M6.5：相似任务读失败要说出真因 ═══════════════════════════════════ */

function groupG(): void {
  console.log('\n【G】M6.5 相似任务：纯函数 + 真因 + 有界重试');

  {
    const db = mkdb();
    addTask(db, 'g-target', 'executing', '', { task_embedding: [1, 0, 0] });
    addTask(db, 'g-c1', 'completed', '', { task_embedding: [1, 0, 0] });
    addTask(db, 'g-c2', 'completed', '', { task_embedding: [0.9, 0.1, 0] });
    addTask(db, 'g-c3', 'completed', '', { task_embedding: [0, 1, 0] });
    addTask(db, 'g-c4', 'completed', '', { task_embedding: [0.8, 0.2, 0] });
    const r = computeSimilarTasks(db, 'g-target', 'p', 5);
    ok(r.ok, 'G1 正常库 ⇒ ok:true');
    if (r.ok) {
      eq(r.items.length, 4, 'G1 返回全部可比候选');
      eq(r.items[0]?.id, 'g-c1', 'G1 相似度 1.0 排第一');
      ok(r.items.every((x, i) => i === 0 || r.items[i - 1]!.similarity >= x.similarity), 'G1 按相似度降序');
    }
    const limited = computeSimilarTasks(db, 'g-target', 'p', 2);
    ok(limited.ok && limited.items.length === 2, 'G1 limit=2 生效');
  }

  {
    const db = mkdb();
    const r = computeSimilarTasks(db, 'missing', 'p');
    ok(!r.ok, 'G2 目标任务不存在 ⇒ ok:false');
    if (!r.ok) ok(r.reason.trim().length > 0, 'G2 reason 非空（不伪装空列表）', r.reason);
  }

  {
    const broken = { prepare: () => { throw 'boom'; } };
    const r = computeSimilarTasks(broken as never, 't', 'p');
    ok(!r.ok, 'G3 故障桩（抛字符串）⇒ ok:false');
    if (!r.ok) {
      ok(r.reason.trim().length > 0, 'G3 非 Error 也有非空 reason（旧 handler 会得到空 message）', r.reason);
      eq(r.retryable, false, 'G3 非 busy 错误不标可重试');
    }
  }

  {
    const busy = { prepare: () => { throw new Error('SQLITE_BUSY: database is locked'); } };
    const r = computeSimilarTasks(busy as never, 't', 'p');
    ok(!r.ok, 'G4 SQLITE_BUSY ⇒ ok:false');
    if (!r.ok) eq(r.retryable, true, 'G4 SQLITE_BUSY 标 retryable（handler 据此重试一次）');
  }

  {
    const ipc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/ipc/project.ipc.ts'), 'utf8')).join('\n');
    const start = ipc.indexOf("ipcMain.handle('task:similar'");
    const end = ipc.indexOf("ipcMain.handle(", start + 10);
    const slice = start >= 0 && end > start ? ipc.slice(start, end) : '';
    ok(slice.includes('computeSimilarTasks(db, id, projectId)'), 'G5 静态：handler 走纯函数');
    ok(slice.includes('retryable') && slice.includes('setTimeout'), 'G5 静态：handler 对 retryable 做一次短退避重试');
    ok(!slice.includes('Math.sqrt'), 'G5 静态：handler 内不再内联余弦循环');
    const simSrc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/task-similarity.ts'), 'utf8')).join('\n');
    ok(simSrc.includes('Math.sqrt'), 'G5 静态：余弦实现只在 task-similarity.ts');
  }
}

/* ═══ F｜M6：成果路径围栏 + 派生修复任务串行边界 ═══════════════════════ */

async function groupF(): Promise<void> {
  console.log('\n【F】M6 成果路径围栏 + 派生修复任务串行边界');

  {
    const db = mkdb();
    addTask(db, 'f-t1', 'executing');
    const wdir = path.join(tmpdir, 'f-wdir');
    const dataDir = path.join(tmpdir, 'f-data');
    fs.mkdirSync(wdir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'attachments', '20261116'), { recursive: true });
    const inside = path.join(wdir, 'a.md');
    const attachment = path.join(dataDir, 'attachments', '20261116', 'b.md');
    const outside = path.join(os.tmpdir(), `zx-20261116-1-outside-${process.pid}.md`);
    const traverse = path.join(wdir, '..', 'zx-20261116-1-traverse.md');
    for (const p of [inside, attachment, outside, traverse]) fs.writeFileSync(p, '# x\n', 'utf-8');

    const tools = buildTools({ db, dataDir } as never, 'f-t1', 'p', wdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
    const reg = async (filePath: string) => JSON.parse(await tools.register_deliverable!.execute({ name: path.basename(filePath), type: 'doc', filePath })) as { ok?: boolean; error?: string };

    const r1 = await reg(inside);
    ok(r1.ok === true, 'F1 工作目录内绝对路径 ⇒ 登记成功（0→1）');
    const r2 = await reg(attachment);
    ok(r2.ok === true, 'F1 数据目录/attachments 下 ⇒ 登记成功（附件根合法）');
    const r3 = await reg(outside);
    ok(r3.ok !== true && String(r3.error ?? '').includes('越出'), 'F1 工作目录/数据目录外 ⇒ 拒绝且说明越界');
    const r4 = await reg(traverse);
    ok(r4.ok !== true, 'F1 ../ 解析到根外 ⇒ 拒绝');
    const countOutside = (db.prepare('SELECT COUNT(*) c FROM wa_deliverables WHERE file_path = ?').get(outside) as { c: number }).c;
    eq(countOutside, 0, 'F1 越界路径未写库（0 行）');
    const r5 = await reg('rel.md');
    ok(r5.ok === true, 'F1 相对路径 ⇒ 按工作目录解析并登记成功', JSON.stringify(r5));
    const relRow = db.prepare("SELECT file_path FROM wa_deliverables WHERE file_path LIKE '%rel.md'").get() as { file_path?: string } | undefined;
    eq(relRow?.file_path, path.join(wdir, 'rel.md'), 'F1 相对路径落库为工作目录内绝对路径');
    for (const p of [inside, attachment, outside, traverse]) fs.rmSync(p, { force: true });
  }

  {
    // F3/F4/F5：同父在途兄弟进前置；pending 不纳入；无在途只含报告任务
    const db = mkdb();
    addTask(db, 'f-plan', 'paused');
    addTask(db, 'f-report', 'executing', 'f-plan');
    addTask(db, 'f-sib', 'executing', 'f-plan');
    addTask(db, 'f-pend', 'pending', 'f-plan');
    const extra = inFlightSiblingIds(db, 'f-report');
    eq(extra, ['f-sib'], 'F3 在途兄弟恰 1 个（pending 不纳入）');
    const fix = createVerificationFixTask({ db, taskId: 'f-report', projectId: 'p', issues: ['未落地 A'], extraDependsOn: extra });
    const row = db.prepare('SELECT depends_on, parent_task_id, status FROM wa_tasks WHERE id = ?').get(fix.id) as { depends_on: string; parent_task_id: string | null; status: string };
    eq(row.depends_on, 'f-report,f-sib', 'F3 修复任务前置 = 报告任务 + 在途兄弟');
    eq([row.parent_task_id, row.status], [null, 'pending'], 'F5 仍是根任务 + pending');
    const jobs = (db.prepare("SELECT COUNT(*) c FROM wa_jobs WHERE json_extract(payload,'$.taskId') = ?").get(fix.id) as { c: number }).c;
    eq(jobs, 0, 'F5 不立即入队（wa_jobs 0 行）');

    const db2 = mkdb();
    addTask(db2, 'f-plan2', 'paused');
    addTask(db2, 'f-report2', 'executing', 'f-plan2');
    addTask(db2, 'f-pend2', 'pending', 'f-plan2');
    eq(inFlightSiblingIds(db2, 'f-report2'), [], 'F4 只有 pending 兄弟 ⇒ 不串（窄版）');
    const fix2 = createVerificationFixTask({ db: db2, taskId: 'f-report2', projectId: 'p', issues: ['未落地 B'] });
    const row2 = db2.prepare('SELECT depends_on FROM wa_tasks WHERE id = ?').get(fix2.id) as { depends_on: string };
    eq(row2.depends_on, 'f-report2', 'F4 无额外前置时逐字回旧行为（只含报告任务）');
  }

  {
    const src = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/write.ts'), 'utf8')).join('\n');
    ok(src.includes('isInsideRoot(realOrResolved(fp), root)'), 'F2 静态：围栏只在 register_deliverable 的落库前（isInsideRoot）');
    ok(src.includes('ctx.dataDir'), 'F2 静态：根包含数据目录（附件根）');
    const ipc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/ipc/project.ipc.ts'), 'utf8')).join('\n');
    const createIdx = ipc.indexOf("ipcMain.handle('deliverable:create'");
    const slice = createIdx >= 0 ? ipc.slice(createIdx, createIdx + 2000) : '';
    ok(!slice.includes('isInsideRoot'), 'F2 反证：GUI 手工登记（deliverable:create）不被此围栏拦截');
  }
}

/* ═══ E｜M5：429 归因——限流不记任务失败 ═══════════════════════════════════ */

function groupE(): void {
  console.log('\n【E】M5 429 归因：瞬时限流不落任务失败');
  ok(isRateLimitedError(new Error('ANS request failed (429): {"error":{"code":"RATE_LIMITED","message":"Rate limit exceeded. Retry after 7s"}}')),
    'E1 真标本 429 + RATE_LIMITED + Retry after ⇒ true');
  ok(isRateLimitedError(new Error('Rate limit exceeded')), 'E1 Rate limit 文案 ⇒ true');
  ok(isRateLimitedError('RATE_LIMITED'), 'E1 裸字符串 RATE_LIMITED ⇒ true');
  ok(!isRateLimitedError(new Error('ECONNREFUSED')), 'E1 反证：ECONNREFUSED ⇒ false');
  ok(!isRateLimitedError(new Error('任务内容校验失败')), 'E1 反证：普通业务错误 ⇒ false');

  const ae = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf8')).join('\n');
  const catchStart = ae.lastIndexOf('} catch (err) {');
  const catchEnd = ae.indexOf('} finally {', catchStart);
  const catchBody = catchStart >= 0 && catchEnd > catchStart ? ae.slice(catchStart, catchEnd) : '';
  const limitIdx = catchBody.indexOf('if (isRateLimitedError(err))');
  const failIdx = catchBody.indexOf('markTaskFailed(db, taskId)');
  ok(limitIdx >= 0, 'E2 静态：外层 catch 有限流分支');
  ok(limitIdx >= 0 && failIdx > limitIdx, 'E2 静态：限流判断先于 markTaskFailed');
  const branch = limitIdx >= 0 ? catchBody.slice(limitIdx, catchBody.indexOf('console.error', limitIdx)) : '';
  ok(branch.includes('PAUSE_REASON_AI_SDK_UNAVAILABLE'), 'E2 静态：限流分支落 ai_sdk_unavailable 暂停');
  ok(branch.includes('sdkExhausted: true'), 'E2 静态：限流分支返回 sdkExhausted（handler 不再重排队）');
  ok(!branch.includes("emit('task.failed'"), 'E2 静态：限流分支不发 task.failed（不记任务失败）');
  ok(catchBody.includes('markTaskFailed(db, taskId)'), 'E2 反证：非限流路径仍保留既有失败处置');

  const ee = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/exec-error.ts'), 'utf8')).join('\n');
  ok(ee.includes('模型端点限流'), 'E3 静态：429 的人话文案仍在（可读性不退）');
}

async function main(): Promise<void> {
  console.log('rr_zx_20261116_1 受控复跑');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  await groupA();
  await groupB();
  await groupC();
  groupD();
  groupG();
  await groupF();
  groupE();
  console.log(`\n[rr_zx_20261116_1] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
