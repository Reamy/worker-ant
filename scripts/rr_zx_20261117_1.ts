/**
 * zx_20261117_1 「案·账·证·忆·接」受控复跑。
 *
 * 分组（与方案 §3 批次一一对应，按实施顺序追加）：
 *   G「案」规划类判据收窄 / 未落地项抽取 / 自动立项与不立项（M1）
 *   H「账」子任务异常账 not_achieved（M2）
 *   I「证」运行证据绑定 / 子任务归属 / grep 反证（M3）
 *   J「忆」验收失败记忆解除（M4）
 *   K「接」已完成父任务后补子任务提示与只读计数（M5）
 *   L「名/费」形态回归标本 / resume 提示 / 工具面 brief（M6）
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引生产函数 / 真实现（被删/改名即编译期失败）。
 *   · 两侧标本同试；计数器类断言给 0→1 正面值。
 *   · 断言文案不含失败字形；表结构走生产 `initDatabase`。
 *   · 夹具按生产初始化顺序：先 initDatabase，再插数据行。
 *   · 不以轮次字面量做等值断言；build 钉由 `checkBuildPins` 派生核对。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { checkBuildPins } from './lib/rr-pins.js';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';
import { collectEvidence, renderEvidence } from '../apps/worker-ant-desktop/src/main/core/exec-evidence.js';
import {
  extractDeferredItems,
  extractVerificationIssues,
  isHumanOnlyIssue,
  isPlanProposalText,
  createVerificationFixTask,
} from '../apps/worker-ant-desktop/src/main/core/verification-issues.js';
import { enforceEvidenceBoundChecks } from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';
import { evidenceIdOf } from '../apps/worker-ant-desktop/src/main/core/runtime-evidence.js';
import { resolveAcceptanceFailureMemory } from '../apps/worker-ant-desktop/src/main/core/acceptance-memory.js';
import { countChildrenCreatedAfterCompletion } from '../apps/worker-ant-desktop/src/main/core/task-followup.js';
import { buildChildBriefs } from '../apps/worker-ant-desktop/src/main/core/jobs/ai-task.js';
import { classifyArchetypeDetailed } from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261117-1-'));
let dbSeq = 0;
function mkdb(): Database.Database {
  const db = initDatabase(path.join(tmpRoot, `db-${++dbSeq}`));
  db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p','P',?)").run(tmpRoot);
  return db;
}
function addTask(
  db: Database.Database,
  id: string,
  status: string,
  parent = '',
  ctx: Record<string, unknown> = {},
  criteria = '',
  title = '',
): void {
  db.prepare(
    "INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id, context_json, acceptance_criteria) VALUES (?, 'p', ?, ?, ?, ?, ?)",
  ).run(id, title || id, status, parent, JSON.stringify(ctx), criteria);
}
function addConv(db: Database.Database, taskId: string, role: string, content: string): void {
  db.prepare(
    "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count) VALUES (?, ?, ?, ?, 0)",
  ).run(`c-${taskId}-${Math.random().toString(36).slice(2)}`, taskId, role, content);
}
function addDeliverable(db: Database.Database, id: string, taskId: string, filePath: string): void {
  db.prepare(
    "INSERT INTO wa_deliverables (id, project_id, task_id, type, name, status, file_path) VALUES (?, 'p', ?, 'doc', ?, 'completed', ?)",
  ).run(id, taskId, path.basename(filePath), filePath);
}
function addEvidence(
  db: Database.Database,
  id: string,
  taskId: string,
  tool: string,
  command: string,
  exitCode = 0,
): void {
  db.prepare(
    "INSERT INTO wa_task_runtime_evidence (id, task_id, tool, command, ok, exit_code, timed_out, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))",
  ).run(id, taskId, tool, command, exitCode === 0 ? 1 : 0, exitCode);
}
function ctxOf(db: Database.Database, taskId: string): Record<string, any> {
  return JSON.parse(
    (db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string }).context_json || '{}',
  );
}

async function groupG(): Promise<void> {
  console.log('\n── G「案」──');

  // G1 标本 01：方案实施（描述含模板句「实施排期计划…细化规划」）⇒ 非规划类
  const a55Desc = '请开始按计划分步实施方案 plans/backend/20261116-新后端易宝支付对接方案.md，方案实施要求：'
    + '1、每开始一项任务前请先根据实施排期计划进行一次细化规划后再开始实施；2、实施子任务时尽量新建子任务来实施。';
  ok(isPlanProposalText('新后端对接易宝支付方案实施', a55Desc) === false, 'G1 方案实施题面判非规划类（标本 01）');
  ok(isPlanProposalText('20260911-1 方案实施', a55Desc) === false, 'G1 同类标本 df334d91 判非规划类');

  // G2 真规划任务不误伤
  ok(isPlanProposalText('20260914 功能优化规划', '规划本季度功能优化') === true, 'G2 标题以规划结尾仍为规划类');
  ok(isPlanProposalText('撰写一份实施方案', '写一份可执行的实施方案') === true, 'G2 显式撰写方案仍为规划类');
  ok(isPlanProposalText('新后端对接易宝支付规划方案', '输出规划方案') === true, 'G2 标题含规划/排期仍为规划类');
  ok(isPlanProposalText('20260924 规划方案实施结果核验', '核验规划方案 plans/backend/20260924.md') === false, 'G2 核验类不误判为规划类');

  // G3 纯文本「留到后续批」命中；边界/已完成/待人项不误收
  const g3 = extractDeferredItems(['1. **`OrderEntity` 的 `payNo`/`transactionId` 字段与 `applyPayResult` 两行 `set` —— 留到 B2 后续批**。']);
  // zx_20261119_2 M1：命中批次号（B2）⇒ 记为「交接项」而非缺口；**仍不丢**（两项之和为 1）。
  eq(g3.items.length + g3.handoffItems.length, 1, 'G3 纯文本「留到 B2 后续批」命中 1 条（交接桶）');
  eq(g3.handoffItems.length, 1, 'G3 批次号承接 ⇒ 归 handoffItems');
  eq(extractDeferredItems(['明确不做：真 MySQL 部署。']).items, [], 'G3 明确不做边界声明不立项');
  eq(extractDeferredItems(['已完成（2026-11-17 B2 后续批落地，提交 881905f）']).items, [], 'G3 已完成行不误收');
  const g3manual = extractDeferredItems(['真机部署留到后续批。']);
  eq(g3manual.items, [], 'G3 待人项不进 items');
  ok(g3manual.manualItems.length === 1 && isHumanOnlyIssue(g3manual.manualItems[0]!), 'G3 待人项进 manualItems');
  eq(extractDeferredItems(['这一项留到后续批。']).items.length, 1, 'G3 最短合法形态命中');

  // G4 修复任务：根任务 + 前置=报告任务（复用既有 createVerificationFixTask）
  const db = mkdb();
  addTask(db, 'g-report', 'executing', '', {}, '', '方案实施');
  const fix = createVerificationFixTask({ db, taskId: 'g-report', projectId: 'p', issues: ['A 未落地', 'B 未落地'] });
  const fixRow = db.prepare('SELECT parent_task_id, depends_on, context_json FROM wa_tasks WHERE id = ?').get(fix.id) as {
    parent_task_id: string | null; depends_on: string; context_json: string;
  };
  eq(fixRow.parent_task_id, null, 'G4 修复任务是根任务（parent_task_id=NULL）');
  eq(fixRow.depends_on, 'g-report', 'G4 修复任务前置=报告任务');
  ok(JSON.parse(fixRow.context_json).verification_fix === true, 'G4 修复任务带 verification_fix 标记');

  // G5 静态：finalize 已接新真源（按符号钉，不按行号）
  const cfSrc = fs.readFileSync(path.join(root, A, 'src/main/core/tools/control-finalize.ts'), 'utf8');
  ok(cfSrc.includes('isPlanProposalText(planTitle, planDescription)'), 'G5 finalize 使用 isPlanProposalText');
  // zx_20261119_2 M1：抽取增第二参（兄弟标题），仍走同一函数。
  ok(cfSrc.includes('extractDeferredItems(planContents') && cfSrc.includes('siblingTitles'), 'G5 finalize 使用 extractDeferredItems（并喂兄弟标题）');
  ok(cfSrc.includes('$.verification_deferred_items'), 'G5 finalize 写 verification_deferred_items');
  ok(cfSrc.includes('MAX_DEFERRED_ITEMS'), 'G5 未落地登记有上限');

  // G6 旧字形通道不退（反证：不因新通道重复/吞掉）
  const glyph = extractVerificationIssues(['| 渠道单号 | ❌ 未落地 |']);
  ok(glyph.issues.length >= 1, 'G6 旧 ❌ 字形通道仍能立项');
  eq(extractDeferredItems(['已落地：留到后续批已全部完成']).items, [], 'G6 已完成措辞不被新通道重复收');
}

async function groupH(): Promise<void> {
  console.log('\n── H「账」──');
  const db = mkdb();
  addTask(db, 'h-parent', 'completed', '', {}, '', '父任务');
  // 标本 03：completed / 45 分 / no_criteria / goal_achieved=false
  addTask(db, 'h-child', 'completed', 'h-parent', {
    acceptance_check: { verified: false, reason: 'no_criteria', criteria_total: 0, passed_total: 0 },
    completion_quality: { score: 45, goal_achieved: false, feedback: '质量: acceptable（本轮无新增产出）' },
  }, '', '复跑 PaymentChannelOrderNoH2Test');
  // 反证：no_criteria 但 goal_achieved=true
  addTask(db, 'h-ok', 'completed', 'h-parent', {
    acceptance_check: { verified: false, reason: 'no_criteria', criteria_total: 0, passed_total: 0 },
    completion_quality: { score: 90, goal_achieved: true },
  }, '', '正常完成');
  // archived 不入账
  addTask(db, 'h-arch', 'archived', 'h-parent', {
    completion_quality: { score: 45, goal_achieved: false },
  }, '', '已归档');
  // 覆盖完成优先（不重复列 not_achieved）
  addTask(db, 'h-override', 'completed', 'h-parent', {
    completion_override: { reason: '实质达成，仅缺本任务账 run' },
    completion_quality: { score: 45, goal_achieved: false },
  }, '', '覆盖完成');
  // 验收未通过优先（不重复列 not_achieved）
  addTask(db, 'h-failed', 'completed', 'h-parent', {
    acceptance_check: { verified: true, passed_total: 1, criteria_total: 2, reason: '' },
    completion_quality: { score: 45, goal_achieved: false },
  }, '', '验收未通过');

  const bundle = collectEvidence(db, 'h-parent');
  const kinds = new Map((bundle.childExceptions || []).map((x) => [x.id, x.kind]));
  eq(kinds.get('h-child'), 'not_achieved', 'H1 no_criteria + goal_achieved=false 入异常账（not_achieved）');
  const child = (bundle.childExceptions || []).find((x) => x.id === 'h-child');
  eq(child?.score, 45, 'H1 异常账带真实分数');
  ok(!kinds.has('h-ok'), 'H2 反证：goal_achieved=true 不入账');
  ok(!kinds.has('h-arch'), 'H3 archived 不入账');
  eq(kinds.get('h-override'), 'override', 'H4 覆盖完成优先于 not_achieved');
  eq(kinds.get('h-failed'), 'failed', 'H4 验收未通过优先于 not_achieved');
  const rendered = renderEvidence(bundle, () => null);
  ok(rendered.includes('完成·未达目标(score=45)'), 'H1 渲染含「完成·未达目标(score=45)」');
  ok(rendered.includes('[子任务异常账]'), 'H1 渲染含子任务异常账段');
}

async function groupI(): Promise<void> {
  console.log('\n── I「证」──');
  const db = mkdb();
  addTask(db, 'i-parent', 'executing', '', {}, '', '父任务');
  addTask(db, 'i-child', 'completed', 'i-parent', {}, '', '子任务跑测试');
  addEvidence(db, 'i-own-exec', 'i-parent', 'execute_command', 'mvn -o -f backend/pom.xml test -Dtest=Foo', 0);
  addEvidence(db, 'i-own-grep', 'i-parent', 'bash', 'grep -c "@Test" src/Foo.java', 0);
  addEvidence(db, 'i-child-exec', 'i-child', 'execute_command', 'mvn -o -f backend/pom.xml test -Dtest=Foo', 0);

  const bundle = collectEvidence(db, 'i-parent');
  eq(bundle.childRuntimeEvidence?.length, 1, 'I1 直接子任务执行证据进 bundle（1 条）');
  eq(bundle.childRuntimeEvidence?.[0]?.ownerTaskId, 'i-child', 'I1 子任务证据带归属 taskId');
  ok(bundle.childRuntimeEvidence?.[0]?.ownerTitle === '子任务跑测试', 'I1 子任务证据带归属标题');
  const rendered = renderEvidence(bundle, () => null);
  ok(rendered.includes('[子任务运行证据]'), 'I1 证据串含子任务运行证据段');
  ok(rendered.includes('run:i-child-exec'), 'I1 子任务 run id 可被判卷引用');

  const ownCmd = new Map(bundle.runtimeEvidence.map((r) => [evidenceIdOf(r), { tool: r.tool, command: r.command ?? '' }]));
  const treeCmd = new Map((bundle.childRuntimeEvidence ?? []).map((r) => [evidenceIdOf(r), { tool: r.tool, command: r.command ?? '' }]));
  const ci = { own: ownCmd, tree: treeCmd };
  const mk = (refs: string[], criterion = 'H2 测试全绿') => ({ criterion, passed: true, reason: 'ok', evidence_refs: refs });

  eq(enforceEvidenceBoundChecks([mk(['run:i-own-exec'])], new Set(['run:i-own-exec', 'run:i-own-grep']), ci)[0]?.passed, true,
    'I1 本任务执行 run 可绑结果类判据');
  eq(enforceEvidenceBoundChecks([mk(['run:i-own-grep'])], new Set(['run:i-own-grep']), ci)[0]?.passed, false,
    'I2 纯 grep 不得绑「全绿」结果类判据');
  eq(enforceEvidenceBoundChecks([mk(['run:i-child-exec'])], new Set([]), ci)[0]?.passed, true,
    'I3 子任务执行 run 可绑结果类判据（带归属）');
  eq(enforceEvidenceBoundChecks([mk(['run:i-own-grep'], '测试使用 H2 且 URL 含 MODE=MySQL')], new Set(['run:i-own-grep']), ci)[0]?.passed, true,
    'I4 非结果类运行判据仍按旧口径（任意本任务 run）');
  eq(enforceEvidenceBoundChecks([mk(['run:i-own-grep'])], new Set(['run:i-own-grep']))[0]?.passed, true,
    'I5 未传命令索引的旧调用方保持旧口径（向后兼容）');
  const noRef = enforceEvidenceBoundChecks([mk([])], new Set(['run:i-own-exec']), ci)[0];
  eq(noRef?.passed, false, 'I5 空 refs 的结果类判据仍强制降级');
  ok(String(noRef?.reason).includes('未提供运行证据'), 'I5 降级文案沿用固定真源');
}

async function groupJ(): Promise<void> {
  console.log('\n── J「忆」──');
  const db = mkdb();
  db.prepare("INSERT INTO wa_memories (id, project_id, content, memory_type, importance, source, context_json) VALUES ('m1','p',?,'acceptance_failure',0.8,'acceptance_check','{}')")
    .run('任务「H2幂等测试」验收未达：新增测试类中存在至少 2 个 @Test 方法；未提供运行证据（需附 run:<id>）');
  const memoryApi = {
    retrieveByType: (_t: string, pid: string, limit = 5) => db.prepare(
      "SELECT id, content, reasoning FROM wa_memories WHERE project_id = ? AND memory_type = 'acceptance_failure' ORDER BY importance DESC LIMIT ?",
    ).all(pid, limit) as Array<{ id: string; content: string; reasoning?: string }>,
    updateMemory: (id: string, content: string, reasoning?: string) => {
      db.prepare('UPDATE wa_memories SET content = ?, reasoning = ? WHERE id = ?').run(content, reasoning ?? '', id);
    },
  };
  const at = new Date('2026-11-17T00:53:43.000Z');
  eq(resolveAcceptanceFailureMemory(db, memoryApi, 'p', 'H2幂等测试', 'task-1', at), true, 'J1 任务通过 ⇒ 写入解除标记');
  const mem = db.prepare("SELECT content, context_json FROM wa_memories WHERE id='m1'").get() as { content: string; context_json: string };
  ok(mem.content.includes('[已解除] 任务「H2幂等测试」于 2026-11-17T00:53:43.000Z 通过验收'), 'J1 正文追加 [已解除] 行');
  ok(mem.content.includes('验收未达'), 'J3 历史正文保留（不删不改写）');
  eq(JSON.parse(mem.context_json).acceptance_resolved['task-1'], '2026-11-17T00:53:43.000Z', 'J1 context_json.acceptance_resolved 0→1');
  eq(resolveAcceptanceFailureMemory(db, memoryApi, 'p', 'H2幂等测试', 'task-1', at), false, 'J1 重复解除幂等（不再追加）');
  const before = (db.prepare("SELECT content FROM wa_memories WHERE id='m1'").get() as { content: string }).content;
  eq(resolveAcceptanceFailureMemory(db, memoryApi, 'p', '别的任务', 'task-2', at), false, 'J2 反证：无关任务不写解除');
  eq((db.prepare("SELECT content FROM wa_memories WHERE id='m1'").get() as { content: string }).content, before, 'J2 反证：正文逐字不变');
  const mcSrc = fs.readFileSync(path.join(root, A, 'src/main/core/memory-context.ts'), 'utf8');
  ok(mcSrc.includes('标 [已解除] 的条目只作历史，不代表当前状态'), 'J3 注入段含固定说明');
}

async function groupK(): Promise<void> {
  console.log('\n── K「接」──');
  const db = mkdb();
  addTask(db, 'k-parent', 'completed', '', { completion_quality: { at: '2026-11-16T09:40:43.941Z' } }, '', '已完成父任务');
  addTask(db, 'k-before', 'completed', 'k-parent', {}, '', '完成前子任务');
  addTask(db, 'k-after', 'completed', 'k-parent', {}, '', '完成后子任务');
  db.prepare("UPDATE wa_tasks SET created_at = '2026-11-16 09:00:00' WHERE id = 'k-before'").run();
  db.prepare("UPDATE wa_tasks SET created_at = '2026-11-16 09:53:12' WHERE id = 'k-after'").run();
  const parent = db.prepare('SELECT * FROM wa_tasks WHERE id = ?').get('k-parent') as Record<string, unknown>;
  eq(countChildrenCreatedAfterCompletion(db, parent), 1, 'K3 父完成后新增 1 个子任务 ⇒ 计数 1');
  eq(countChildrenCreatedAfterCompletion(db, { ...parent, status: 'executing' }), 0, 'K3 反证：父未完成 ⇒ 0');

  // 事件回退：context 无 completion_quality.at 时用最后一条 task.completed
  addTask(db, 'k-parent2', 'completed', '', {}, '', '已完成父任务 2');
  addTask(db, 'k-late2', 'completed', 'k-parent2', {}, '', '完成后子任务 2');
  db.prepare("UPDATE wa_tasks SET created_at = '2026-11-16 10:00:00' WHERE id = 'k-late2'").run();
  db.prepare("INSERT INTO wa_event_log (event_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, occurred_at) VALUES ('ev-k2','task.completed','task','k-parent2',1,'{}','2026-11-16T09:40:43.941Z')").run();
  const parent2 = db.prepare('SELECT * FROM wa_tasks WHERE id = ?').get('k-parent2') as Record<string, unknown>;
  eq(countChildrenCreatedAfterCompletion(db, parent2), 1, 'K3 无 completion_quality.at 时走 task.completed 事件回退');

  // K1/K4 静态接线：IPC 回执 + 两个 renderer 入口
  const ipcSrc = fs.readFileSync(path.join(root, A, 'src/main/ipc/project.ipc.ts'), 'utf8');
  ok(ipcSrc.includes('task.parentCompleted = true'), 'K1 task:create 回执写 parentCompleted');
  ok(ipcSrc.includes('新增子任务不会触发父任务重判'), 'K1 回执带人话 hint');
  ok(ipcSrc.includes('countChildrenCreatedAfterCompletion(db, task'), 'K3 task:get 回传后补计数');
  const tasksPageSrc = fs.readFileSync(path.join(root, A, 'renderer/src/pages/TasksPage.tsx'), 'utf8');
  ok(tasksPageSrc.includes('created?.parentCompleted'), 'K4 TasksPage 消费 parentCompleted 提示');
  const detailSrc = fs.readFileSync(path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf8');
  ok(detailSrc.includes('childrenAfterCompletion') && detailSrc.includes('父结论未重算'), 'K4 TaskDetailPage 显示后补徽标');
}

async function groupL(): Promise<void> {
  console.log('\n── L「名/费」──');

  // L1 标本 08 原题面回归：当前构建必须判 code（不是 document/research）
  const l1Text = 'H2幂等测试 在 backend 测试目录新增 H2(MODE=MySQL) 集成测试类，覆盖两例：'
    + '①回调带 payNo/transactionId → 调用 applyPayResult 后从库中读回两值一致；'
    + '②同一订单重复回调 → 两值不被重复覆盖/不产生重复写入（幂等）。'
    + '测试使用 backend 现有测试基础设施与 schema.sql，产出落在 backend 的测试源码目录。';
  const l1 = classifyArchetypeDetailed(l1Text);
  eq(l1.archetype, 'code', 'L1 标本 08 题面判 code（不再误判文档形态）');
  ok(l1.source === 'keyword' || l1.source === 'capability', 'L1 来源为 keyword 或能力升级');

  // L2 resume 简报：子任务已有成功执行 run ⇒ 带 run:<id> 与"不必再派复跑子任务"
  const db = mkdb();
  addTask(db, 'l-parent', 'executing', '', {}, '', '父任务');
  addTask(db, 'l-child', 'completed', 'l-parent', { completion_summary: '已跑 mvn 测试' }, '', '子任务跑测试');
  addEvidence(db, 'l-run', 'l-child', 'execute_command', 'mvn -o -f backend/pom.xml test -Dtest=Foo', 0);
  const briefs = buildChildBriefs(db, 'l-parent');
  const b = briefs.find((x) => x.startsWith('子任务跑测试｜')) || '';
  ok(b.includes('run:l-run'), 'L2 简报带子任务成功 run id');
  ok(b.includes('不必再派复跑子任务'), 'L2 简报带轻量收口提示');
  addTask(db, 'l-parent2', 'executing', '', {}, '', '父任务2');
  addTask(db, 'l-child2', 'completed', 'l-parent2', { completion_summary: '只写了文档' }, '', '子任务写文档');
  const b2 = (buildChildBriefs(db, 'l-parent2')[0] || '');
  ok(!b2.includes('不必再派复跑子任务'), 'L2 反证：无成功执行 run 的子任务不加提示');

  // L3 工具面 brief 之外的执行纪律（不改 buildToolFaceBrief 的零收窄短句，旧断言不退）
  const aeSrc = fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf8');
  ok(aeSrc.includes('不要派生只做复跑的子任务'), 'L3 exec 提示含「不要派生只做复跑的子任务」');
  ok(aeSrc.includes("toolFace.kept.includes('execute_command') || toolFace.kept.includes('bash')"), 'L3 提示只在有 shell 的形态注入');
  const briefSrc = fs.readFileSync(path.join(root, A, 'src/main/core/task-archetype.ts'), 'utf8');
  ok(!briefSrc.includes('不要派生只做复跑的子任务'), 'L3 buildToolFaceBrief 未被加长（零收窄短句旧断言不退）');
}

async function main(): Promise<void> {
  console.log('zx_20261117_1 受控复跑');
  await groupG();
  await groupH();
  await groupI();
  await groupJ();
  await groupK();
  await groupL();

  console.log('\n── M0 build 钉 ──');
  ok(fs.existsSync(path.join(root, 'plans/improve/zx_20261117_1.md')), '本轮方案文件在册');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

  console.log(`\n[rr_zx_20261117_1] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('套件异常：', e);
  process.exit(1);
});
