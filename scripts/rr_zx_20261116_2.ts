/**
 * zx_20261116_2 「属·证·覆」受控复跑。
 *
 * 分组（与方案 §3 批次一一对应，按实施顺序追加）：
 *   A「属」共享交付物归属（M1）：wa_task_files 作为文件级归属；产出闸 own ∪ shared
 *   B「证」验收证据有主（M2）
 *   C「覆」完成覆盖留痕（M3）
 *   D「评」自评与“无产出物”口径（M4）
 *   E「迹」完成事件形状（M5，先实证）
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引生产函数 / 真实现（被删/改名即编译期失败）。
 *   · 两侧标本同试；计数器类断言给 0→1 正面值。
 *   · 断言文案不含失败字形；表结构走生产 `initDatabase`。
 *   · 夹具按生产初始化顺序：先 initDatabase，再插数据行。
 *   · 不以轮次字面量做等值断言；build 钉由 `checkBuildPins` 派生核对。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';
import { buildTools } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { checkParentTaskAfterChildDone } from '../apps/worker-ant-desktop/src/main/core/jobs/ai-task.js';
import { taskDeliverableCounts, deliverableContributors, recordContribution } from '../apps/worker-ant-desktop/src/main/core/deliverable-attribution.js';
import { recordTaskFile } from '../apps/worker-ant-desktop/src/main/core/task-file-ledger.js';
import { collectEvidence, renderEvidence } from '../apps/worker-ant-desktop/src/main/core/exec-evidence.js';
import { eventBus } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';

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
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261116-2-'));
let dbSeq = 0;

function mkdb(): Database.Database {
  const db = initDatabase(path.join(tmpdir, `db-${++dbSeq}`));
  db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p','P',?)").run(tmpdir);
  return db;
}
function addTask(db: Database.Database, id: string, status: string, parent = '', ctx: Record<string, unknown> = {}, criteria = ''): void {
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id, context_json, acceptance_criteria) VALUES (?, 'p', ?, ?, ?, ?, ?)")
    .run(id, id, status, parent, JSON.stringify(ctx), criteria);
}
function addConv(db: Database.Database, taskId: string, role: string, content: string): void {
  db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count) VALUES (?, ?, ?, ?, 0)")
    .run(`c-${taskId}-${Math.random().toString(36).slice(2)}`, taskId, role, content);
}
function addDeliverable(db: Database.Database, id: string, taskId: string, filePath: string): void {
  db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, status, file_path) VALUES (?, 'p', ?, 'doc', ?, 'completed', ?)")
    .run(id, taskId, path.basename(filePath), filePath);
}
function fileRowCount(db: Database.Database, taskId: string, filePath: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM wa_task_files WHERE task_id = ? AND path = ?').get(taskId, filePath) as { c: number }).c;
}
function ctxOf(db: Database.Database, taskId: string): Record<string, unknown> {
  return JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string }).context_json || '{}');
}
function childCtx(): Record<string, unknown> {
  return {
    pause_reason: 'acceptance_failed',
    archetype: 'document',
    task_goal: { goal: 'g' },
    acceptance_check: { checked_at: new Date().toISOString(), verified: true, criteria_total: 1, passed_total: 0, passed: [], failed: [{ criterion: 'c', reason: 'r', evidence_refs: ['run:x'] }] },
  };
}
async function finalizeChecks(db: Database.Database, taskId: string): Promise<string[]> {
  const tools = buildTools({ db } as never, taskId, 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
  const raw = await tools.finalize_task!.execute({ summary: '完成', quality: 'good' });
  const out = JSON.parse(raw) as { checks?: string[] };
  return out.checks ?? [];
}

/* ═══ A｜M1：共享交付物归属（wa_task_files 文件级） ═════════════════════════ */

async function groupA(): Promise<void> {
  console.log('\n【A】M1 共享交付物归属（wa_task_files）');

  const shared = path.join(tmpdir, 'shared-plan.md');
  fs.writeFileSync(shared, '# shared plan\n', 'utf-8');

  {
    const db = mkdb();
    addTask(db, 'a-own', 'completed');
    addTask(db, 'a-other', 'executing');
    addDeliverable(db, 'a-d1', 'a-own', shared);
    const tools = buildTools({ db } as never, 'a-other', 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
    const r = JSON.parse(await tools.register_deliverable!.execute({ name: 'shared', type: 'doc', filePath: shared })) as { ok?: boolean; deduplicated?: boolean; attributed?: boolean; ownerTaskId?: string };
    eq(r.deduplicated, true, 'A1 跨任务登记同路径 ⇒ deduplicated:true');
    eq(r.attributed, true, 'A1 跨任务登记 ⇒ attributed:true（本任务参与）');
    eq(r.ownerTaskId, 'a-own', 'A1 owner 仍是 a-own（不夺归属）');
    const rows = db.prepare('SELECT id, task_id FROM wa_deliverables WHERE file_path = ?').all(shared) as Array<{ id: string; task_id: string }>;
    eq(rows.length, 1, 'A1 wa_deliverables 仍 1 行');
    eq(fileRowCount(db, 'a-other', shared), 1, 'A1 本任务 wa_task_files 行 0→1');
    eq(taskDeliverableCounts(db, 'a-other'), { own: 0, shared: 1 }, 'A1 taskDeliverableCounts(shared)=1');
    eq(deliverableContributors(db, 'a-d1'), ['a-own', 'a-other'], 'A4 贡献者含 owner 与本任务');
  }

  {
    const db = mkdb();
    addTask(db, 'a-own2', 'completed');
    addTask(db, 'a-other2', 'executing');
    addDeliverable(db, 'a-d2', 'a-own2', shared);
    const tools = buildTools({ db } as never, 'a-other2', 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
    await tools.register_deliverable!.execute({ name: 'shared', type: 'doc', filePath: shared });
    await tools.register_deliverable!.execute({ name: 'shared', type: 'doc', filePath: shared });
    eq(fileRowCount(db, 'a-other2', shared), 1, 'A2 同一任务重复登记 ⇒ wa_task_files 仍 1 行（幂等）');
  }

  {
    // A3 own>0 ⇒ PASS
    const db = mkdb();
    addTask(db, 'a-own3', 'executing');
    addConv(db, 'a-own3', 'assistant', '已完成');
    addDeliverable(db, 'a-d3', 'a-own3', path.join(tmpdir, 'own3.md'));
    const checks = await finalizeChecks(db, 'a-own3');
    ok(checks.some(c => c.startsWith('[PASS] 所有产出物已注册')), 'A3 own>0 ⇒ [PASS] 所有产出物已注册', checks.join(' | '));
  }

  {
    // A3 own=0 shared>0 ⇒ INFO（不再 WARN）
    const db = mkdb();
    addTask(db, 'a-owner4', 'completed');
    addTask(db, 'a-shared4', 'executing');
    addConv(db, 'a-shared4', 'assistant', '我编辑了共享方案');
    addDeliverable(db, 'a-d4', 'a-owner4', shared);
    recordTaskFile(db, 'a-shared4', shared, 'edit_file');
    const checks = await finalizeChecks(db, 'a-shared4');
    ok(checks.some(c => c.includes('本任务名下无独占产出物') && c.includes('共享成果')), 'A3 own=0/shared>0 ⇒ [INFO] 共享成果，不报无产出物', checks.join(' | '));
    ok(!checks.some(c => c.includes('[WARN] 无产出物')), 'A3 且不再出现 [WARN] 无产出物');
  }

  {
    // A3 own=0 shared=0 ⇒ 仍 WARN（反证）
    const db = mkdb();
    addTask(db, 'a-none5', 'executing');
    addConv(db, 'a-none5', 'assistant', '没有产出');
    const checks = await finalizeChecks(db, 'a-none5');
    ok(checks.some(c => c.includes('[WARN] 无产出物')), 'A3 反证：own=0/shared=0 ⇒ 仍 [WARN] 无产出物', checks.join(' | '));
  }

  {
    // A5 静态：register_deliverable dedup 写 recordTaskFile；产出闸走 taskDeliverableCounts
    const writeSrc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/write.ts'), 'utf8')).join('\n');
    ok(writeSrc.includes("recordTaskFile(db, taskId, fp, 'register_deliverable')"), 'A5 静态：登记 dedup 也记 wa_task_files');
    const cfSrc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/control-finalize.ts'), 'utf8')).join('\n');
    ok(cfSrc.includes('taskDeliverableCounts(db, taskId)'), 'A5 静态：产出闸/封顶走同一归属计数');
    const aeSrc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf8')).join('\n');
    ok(aeSrc.includes('taskDeliverableCounts(db, taskId)'), 'A5 静态：run_close 封顶也计入共享成果');
  }
}

/* ═══ B｜M2：验收证据有主 ═══════════════════════════════════════════════ */

function groupB(): void {
  console.log('\n【B】M2 验收证据归属');

  const shared = path.join(tmpdir, 'b-shared.md');
  fs.writeFileSync(shared, '# shared evidence\n', 'utf-8');

  {
    const db = mkdb();
    addTask(db, 'b-owner', 'completed');
    addTask(db, 'b-contrib', 'executing');
    addDeliverable(db, 'b-d1', 'b-owner', shared);
    recordTaskFile(db, 'b-contrib', shared, 'edit_file');
    recordContribution(db, 'b-contrib', '补了 §5', 'finalize_task');
    const bundle = collectEvidence(db, 'b-contrib');
    const attr = (bundle.fileAttribution ?? []).find((a) => a.file === shared);
    ok(!!attr, 'B1 共享文件进入本任务证据面（即使 owner 在树外）');
    if (attr) {
      eq(attr.ownerTaskId, 'b-owner', 'B1 owner 仍是 b-owner');
      eq(attr.contributors, ['b-owner', 'b-contrib'], 'B1 贡献者含 owner 与本任务');
      eq(attr.taskParticipates, true, 'B1 本任务参与 = true');
      eq(attr.isShared, true, 'B1 标为共享');
    }
    eq(bundle.contribution?.summary, '补了 §5', 'B1 contribution.summary 已带入');
    eq(bundle.contribution?.files, [shared], 'B1 contribution.files 来自 wa_task_files');
    const rendered = renderEvidence(bundle, (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } });
    ok(rendered.includes('[共享文件') && rendered.includes('本任务参与 yes'), 'B1 渲染标共享 + 本任务参与');
    ok(rendered.includes('[本任务贡献声明] 补了 §5'), 'B1 渲染带本任务贡献声明');
  }

  {
    // B2：后代 A 的文件在 B 的树内、B 未参与 ⇒ 标 no，且无 B 的贡献声明
    const db = mkdb();
    addTask(db, 'b-b2', 'executing');
    addTask(db, 'b-a2', 'completed', 'b-b2');
    addDeliverable(db, 'b-d2', 'b-a2', shared);
    const bundle = collectEvidence(db, 'b-b2');
    const attr = (bundle.fileAttribution ?? []).find((a) => a.file === shared);
    ok(!!attr, 'B2 后代共享文件进入证据面');
    if (attr) {
      eq(attr.taskParticipates, false, 'B2 本任务未参与 = false');
      eq(attr.isShared, true, 'B2 标为共享');
    }
    const rendered = renderEvidence(bundle, (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } });
    ok(rendered.includes('本任务参与 no'), 'B2 渲染如实说本任务未参与');
    ok(!rendered.includes('[本任务贡献声明]'), 'B2 无贡献声明时不凭空造一块');
  }

  {
    // B3：单任务自有文件 ⇒ 不加共享块/贡献声明块（旧证据面不退）
    const db = mkdb();
    addTask(db, 'b-own3', 'executing');
    const own = path.join(tmpdir, 'b-own3.md');
    fs.writeFileSync(own, '# own\n', 'utf-8');
    addDeliverable(db, 'b-d3', 'b-own3', own);
    recordContribution(db, 'b-own3', '完成', 'finalize_task');
    const bundle = collectEvidence(db, 'b-own3');
    const attr = (bundle.fileAttribution ?? []).find((a) => a.file === own);
    eq(attr?.isShared, false, 'B3 单任务自有文件 isShared=false');
    const rendered = renderEvidence(bundle, (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } });
    ok(!rendered.includes('[共享文件'), 'B3 单任务不出现共享标签');
    ok(!rendered.includes('[本任务贡献声明]'), 'B3 单任务不出现贡献声明块（旧证据面逐字不变）');
  }

  {
    // B4：recordContribution 用 json_set，保留兄弟键
    const db = mkdb();
    addTask(db, 'b-keep', 'executing', '', { task_goal: { goal: 'g' }, verification_manual_items: ['m'] });
    recordContribution(db, 'b-keep', '摘要', 'update_task_status');
    const ctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('b-keep') as { context_json: string }).context_json);
    eq(ctx.task_goal, { goal: 'g' }, 'B4 兄弟键 task_goal 保留');
    eq(ctx.verification_manual_items, ['m'], 'B4 兄弟键 verification_manual_items 保留');
    eq(ctx.contribution?.summary, '摘要', 'B4 contribution 已写入');
  }

  {
    const ee = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/exec-evidence.ts'), 'utf8')).join('\n');
    ok(ee.includes('deliverableContributors') && ee.includes('readContribution'), 'B5 静态：证据面消费归属/贡献声明');
    const cf = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/control-finalize.ts'), 'utf8')).join('\n');
    ok(cf.includes("recordContribution(db, taskId, args.summary, 'finalize_task')"), 'B5 静态：finalize 前写贡献声明');
    const ct = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/control.ts'), 'utf8')).join('\n');
    ok(ct.includes("recordContribution(db, args.targetTaskId, args.reason || '', 'update_task_status')"), 'B5 静态：update_task_status 完成前写贡献声明');
  }
}

/* ═══ C｜M3：完成覆盖留痕 ═══════════════════════════════════════════════ */

async function groupC(): Promise<void> {
  console.log('\n【C】M3 完成覆盖留痕');

  {
    // C1：无 overrideReason ⇒ 闸（状态零变）
    const db = mkdb();
    addTask(db, 'c-p1', 'executing');
    addTask(db, 'c-c1', 'paused', 'c-p1', childCtx());
    addConv(db, 'c-c1', 'assistant', '已修改方案');
    const tools = buildTools({ db } as never, 'c-p1', 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
    const r = JSON.parse(await tools.update_task_status!.execute({ targetTaskId: 'c-c1', status: 'completed' })) as { error?: string; code?: string };
    ok(!!r.error && r.code === 'override_reason_required', 'C1 无 overrideReason ⇒ 拒绝且 code=override_reason_required', JSON.stringify(r));
    eq((db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get('c-c1') as { status: string }).status, 'paused', 'C1 状态零变');
    eq(ctxOf(db, 'c-c1').completion_override, undefined, 'C1 无覆盖记录');
  }

  {
    // C2：带 reason ⇒ completed + completion_override + 系统行；acceptance 原样
    const db = mkdb();
    addTask(db, 'c-p2', 'executing');
    addTask(db, 'c-c2', 'paused', 'c-p2', childCtx());
    addConv(db, 'c-c2', 'assistant', '已修改方案');
    const tools = buildTools({ db } as never, 'c-p2', 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
    await tools.update_task_status!.execute({ targetTaskId: 'c-c2', status: 'completed', overrideReason: '父任务复核后接受（缺 §7/§8 由父任务补齐）' });
    eq((db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get('c-c2') as { status: string }).status, 'completed', 'C2 状态 completed');
    const ctx = ctxOf(db, 'c-c2');
    const ov = ctx.completion_override as { by?: string; reason?: string; previous_acceptance?: { passed_total?: number; criteria_total?: number } } | undefined;
    eq(ov?.by, 'c-p2', 'C2 覆盖人 = 父任务');
    eq(ov?.reason, '父任务复核后接受（缺 §7/§8 由父任务补齐）', 'C2 覆盖原因已落账');
    eq(ov?.previous_acceptance, { passed_total: 0, criteria_total: 1, failed: [{ criterion: 'c', reason: 'r', evidence_refs: ['run:x'] }] }, 'C2 原验收快照保留');
    eq((ctx.acceptance_check as { passed_total: number }).passed_total, 0, 'C2 acceptance_check 未被篡改');
    const sys = (db.prepare("SELECT COUNT(*) c FROM wa_task_conversations WHERE task_id='c-c2' AND content LIKE '%[覆盖完成]%'").get() as { c: number }).c;
    eq(sys, 1, 'C2 [覆盖完成] 系统行 0→1');
  }

  {
    // C3：D1 文案——含覆盖完成 ⇒ 点名；全真完成 ⇒ 原文案
    const db = mkdb();
    addTask(db, 'c-p3', 'paused', '', { pause_reason: 'children_incomplete' });
    addTask(db, 'c-c31', 'completed', 'c-p3', { completion_override: { by: 'c-p3', reason: '接受', at: 'x', previous_acceptance: { passed_total: 0, criteria_total: 1 } } });
    addTask(db, 'c-c32', 'completed', 'c-p3');
    const jobs: Array<{ type: string; payload: Record<string, unknown> }> = [];
    checkParentTaskAfterChildDone(db, 'c-c31', { enqueue: (type, payload) => { jobs.push({ type, payload }); return Promise.resolve(); } });
    eq(jobs.length, 1, 'C3 父任务被唤醒 1 次');
    ok(String(jobs[0]?.payload.message).includes('覆盖完成·验收未重判'), 'C3 文案点名“覆盖完成·验收未重判”', String(jobs[0]?.payload.message).slice(0, 120));

    const db2 = mkdb();
    addTask(db2, 'c-p4', 'paused', '', { pause_reason: 'children_incomplete' });
    addTask(db2, 'c-c41', 'completed', 'c-p4');
    addTask(db2, 'c-c42', 'completed', 'c-p4');
    const jobs2: Array<{ type: string; payload: Record<string, unknown> }> = [];
    checkParentTaskAfterChildDone(db2, 'c-c41', { enqueue: (type, payload) => { jobs2.push({ type, payload }); return Promise.resolve(); } });
    ok(String(jobs2[0]?.payload.message).includes('所有子任务已完成，恢复父任务'), 'C3 反证：全真完成 ⇒ 原文案逐字不变');
  }

  {
    // C4：无验收失败 ⇒ 不要求 reason（旧行为）
    const db = mkdb();
    addTask(db, 'c-p5', 'executing');
    addTask(db, 'c-c5', 'paused', 'c-p5', { pause_reason: 'user_interrupt', archetype: 'document' });
    addConv(db, 'c-c5', 'assistant', '已修改');
    const tools = buildTools({ db } as never, 'c-p5', 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
    const r = JSON.parse(await tools.update_task_status!.execute({ targetTaskId: 'c-c5', status: 'completed' })) as { error?: string; status?: string };
    eq(r.error, undefined, 'C4 无验收失败 ⇒ 不要求 overrideReason');
    eq((db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get('c-c5') as { status: string }).status, 'completed', 'C4 状态 completed');
    eq(ctxOf(db, 'c-c5').completion_override, undefined, 'C4 不凭空写覆盖记录');
  }

  {
    // C5：静态接线
    const ct = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/control.ts'), 'utf8')).join('\n');
    ok(ct.includes('overrideReason') && ct.includes("code: 'override_reason_required'"), 'C5 静态：工具 schema/闸接线');
    ok(ct.includes("'$.completion_override'"), 'C5 静态：覆盖记录写点');
    const ait = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/jobs/ai-task.ts'), 'utf8')).join('\n');
    ok(ait.includes('overrideKids') && ait.includes('覆盖完成·验收未重判'), 'C5 静态：D1 文案接线');
    const page = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf8')).join('\n');
    ok(page.includes('completionOverride') && page.includes('覆盖完成'), 'C5 静态：任务详情覆盖完成标记');
  }

  {
    // C6：真 finalize（验收通过/无判据）覆盖旧的人工覆盖——清 completion_override，历史仍在会话行
    const db = mkdb();
    addTask(db, 'c-clear', 'executing', '', { completion_override: { by: 'old', reason: '旧覆盖', at: 'x', previous_acceptance: { passed_total: 0, criteria_total: 1 } } });
    addConv(db, 'c-clear', 'assistant', '真收口');
    const tools = buildTools({ db } as never, 'c-clear', 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
    await tools.finalize_task!.execute({ summary: '真收口', quality: 'good' });
    eq(ctxOf(db, 'c-clear').completion_override, undefined, 'C6 真 finalize 清掉旧 completion_override');
    const cf = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/control-finalize.ts'), 'utf8')).join('\n');
    ok(cf.includes('delete (ctxJson as Record<string, unknown>).completion_override'), 'C6 静态：清旧覆盖的写点');
  }
}

/* ═══ D｜M4：自评与“无产出物”口径 ═══════════════════════════════════════ */

async function groupD(): Promise<void> {
  console.log('\n【D】M4 “无产出物”三态与自评标记');

  {
    const db = mkdb();
    addTask(db, 'd-write', 'executing');
    addConv(db, 'd-write', 'assistant', '已写入文件');
    const f = path.join(tmpdir, 'd-write.md');
    fs.writeFileSync(f, '# written\n', 'utf-8');
    recordTaskFile(db, 'd-write', f, 'write_file');
    const checks = await finalizeChecks(db, 'd-write');
    ok(checks.some(c => c.includes('[INFO] 无登记产出物，但有写入证据')), 'D1 有写入证据、无登记产出物 ⇒ [INFO]', checks.join(' | '));
    ok(!checks.some(c => c.includes('[WARN] 无产出物')), 'D1 且不再 [WARN] 无产出物');
  }

  {
    const db = mkdb();
    addTask(db, 'd-none', 'executing');
    addConv(db, 'd-none', 'assistant', '没有产出');
    const checks = await finalizeChecks(db, 'd-none');
    ok(checks.some(c => c.includes('[WARN] 无产出物')), 'D2 反证：完全无产出/无写入 ⇒ 仍 [WARN] 无产出物', checks.join(' | '));
  }

  {
    const cf = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/control-finalize.ts'), 'utf8')).join('\n');
    ok(cf.includes('无登记产出物，但有写入证据'), 'D4 静态：三态文案真源在检查 2');
    const page = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf8')).join('\n');
    ok(page.includes("completionVia === 'finalize_task'") && page.includes('自评'), 'D4 静态：任务详情给 finalize 自评分加“自评”标记');
  }
}

/* ═══ E｜M5：完成事件形状与消费者 ═══════════════════════════════════════ */

async function groupE(): Promise<void> {
  console.log('\n【E】M5 update_task_status 完成补发 task.completed + markCompletedRun');

  {
    const db = mkdb();
    addTask(db, 'e-p', 'executing');
    addTask(db, 'e-c', 'paused', 'e-p', { pause_reason: 'user_interrupt', archetype: 'document' });
    addConv(db, 'e-c', 'assistant', '已修改');
    const events: Array<Record<string, unknown>> = [];
    const h = (e: { data: Record<string, unknown> }) => { if (e.data.taskId === 'e-c') events.push(e.data); };
    eventBus.on('task.completed', h);
    const tools = buildTools({ db } as never, 'e-p', 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
    await tools.update_task_status!.execute({ targetTaskId: 'e-c', status: 'completed' });
    await new Promise((r) => setTimeout(r, 20));
    eventBus.off('task.completed', h);
    eq(events.length, 1, 'E2 task.completed 0→1（update_task_status 完成路）');
    ok(events[0]?.taskId === 'e-c' && events[0]?.projectId === 'p', 'E2 载荷含 taskId/projectId');
    ok('quality' in (events[0] ?? {}), 'E2 载荷带 quality（buildTaskOutcome 同形）');
    eq(ctxOf(db, 'e-c').last_completed_run_id, undefined, 'E2 不伪造 last_completed_run_id（人工完成无 run 身份）');
  }

  {
    const ct = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/control.ts'), 'utf8')).join('\n');
    ok(ct.includes('markCompletedRun(db, args.targetTaskId, null)'), 'E1 静态：完成路调用 markCompletedRun');
    ok(ct.includes("emit('task.completed'"), 'E1 静态：完成路补发 task.completed');
    const idx = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/index.ts'), 'utf8')).join('\n');
    const nc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/notification-core.ts'), 'utf8')).join('\n');
    const inv = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/architectural-invariants.ts'), 'utf8')).join('\n');
    ok(idx.includes("on('task.completed'") && nc.includes("on('task.completed'") && inv.includes('task.completed'),
      'E1 静态：消费者清单（渲染转发 / 通知核 / 审计不变量）在册');
  }

  {
    const nc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/notification-core.ts'), 'utf8')).join('\n');
    ok(nc.includes('8s') || nc.includes('DEDUP') || nc.includes('去重'), 'E3 通知核仍有 completed/status_changed 去重（不双弹）');
  }
}

async function main(): Promise<void> {
  console.log('rr_zx_20261116_2 受控复跑');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  await groupA();
  groupB();
  await groupC();
  await groupD();
  await groupE();
  console.log(`\n[rr_zx_20261116_2] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
