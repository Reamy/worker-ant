/**
 * zx_20261118_2 「明」受控复跑。
 *
 * 分组（与方案 §3 批次一一对应）：
 *   A「答」待答信息版式：选项换行拆条 / 问题全文 / 候选竖排
 *   B「问」父任务简报带子任务问题原文，不再重复提问
 *   C「名」/tmp 等根外文件不再登记为成果
 *   D「拆」拆解提示词注入版本控制边界
 *   E「豁」逐条验收豁免（GUI 用户裁定 + 留痕 + finalize 读豁免）
 *   F「计」子任务完成计数含「未达目标」
 *   G「标」自评质量分标注
 *   H「证」build 钉 + 源码形状
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
import { normalizeOptionItems } from '../apps/worker-ant-desktop/src/main/core/im/options.js';
import { buildChildBriefs, checkParentTaskAfterChildDone } from '../apps/worker-ant-desktop/src/main/core/jobs/ai-task.js';
import { classifyChildCompletion, childCompletionCheckLabel } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import { qualityLabel, isSelfAssessedQualityVia } from '../apps/worker-ant-desktop/src/main/core/quality-label.js';
import { isSelfAssessedQuality } from '../apps/worker-ant-desktop/renderer/src/lib/task-badges.js';
import { applyAcceptanceWaivers, readAcceptanceWaivers } from '../apps/worker-ant-desktop/src/main/core/acceptance-waiver.js';
import { decideAcceptanceOutcome, goalEvidenceOf, acceptanceVerdictOf, buildAcceptanceCheckPayload } from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';
import { isInsideAnyRoot } from '../apps/worker-ant-desktop/src/main/core/path-fence.js';
import { collectRepoBoundary, formatRepoBoundary } from '../apps/worker-ant-desktop/src/main/core/repo-boundary.js';
import { buildDecomposePrompt } from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261118-2-'));
let dbSeq = 0;
function mkdb(): Database.Database {
  const db = initDatabase(path.join(tmpRoot, `db-${++dbSeq}`));
  db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p','P',?)").run(tmpRoot);
  return db;
}

const SELF = path.basename(__filename).replace(/\.ts$/, '');

// ── A 组「答」 ───────────────────────────────────────────────────────────────

// A1 选项拆条：真库 S6 的形状（一条元素含四个候选，用换行分隔）
{
  eq(normalizeOptionItems(['A. 仅提交 backend\nB. 复制方案文件\nC. 初始化独立仓库\nD. 其他']),
    ['A. 仅提交 backend', 'B. 复制方案文件', 'C. 初始化独立仓库', 'D. 其他'],
    'A1 单条含多行 → 拆成逐条');
  eq(normalizeOptionItems(['A. x', 'B. y']), ['A. x', 'B. y'], 'A1 已分开的数组原样');
  eq(normalizeOptionItems(['', '  \n ', 'A. 唯一']), ['A. 唯一'], 'A1 空行/纯空白丢弃');
  eq(normalizeOptionItems(['A, B / C; D']), ['A, B / C; D'], 'A1 不按逗号/竖线/分号拆（那是选项分隔符）');
}

// A2 接线（main）：置停落库前规范化，四处共用同一份
{
  const code = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf-8')).join('\n');
  ok(code.includes('const normalized = normalizeOptionItems(options ?? []);'), 'A2 pauseForDecision 落库前规范化');
  ok(/persistAwaitingInput\(db, taskId, \{ question, options: normalized, decision_type: decisionType \}\)/.test(code), 'A2 落库用同一份 normalized');
  ok(/eventBus\.emit\('task\.awaiting_input',[^\n]*options: normalized/.test(code), 'A2 事件用同一份 normalized');
}

// A3 接线（renderer）：NextActionBar 两行、说明不截断；待答块竖排全文
{
  const bar = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/components/NextActionBar.tsx'), 'utf-8')).join('\n');
  ok(!bar.includes('truncate'), 'A3 NextActionBar 说明位不再 truncate');
  ok(/whitespace-pre-wrap break-words max-h-24 overflow-y-auto/.test(bar), 'A3 说明位可换行且超长块内滚动（不省略）');
  ok(/<span className="font-medium min-w-0 flex-1">\{action\.headline\}<\/span>/.test(bar), 'A3 标题独占一行且不再被说明挤窄');

  const page = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf-8')).join('\n');
  ok(/const awaitOpt = normalizeOptionItems\(/.test(page), 'A3 待答块渲染前走 normalizeOptionItems');
  ok(/awaitOpt\.map\(\(o, i\) => \(<li key=\{i\}><button/.test(page), 'A3 候选答案逐项独占一行（li+button）');
  ok(/text-sm leading-relaxed text-amber-900 whitespace-pre-wrap break-words/.test(page), 'A3 问题全文按原样换行、不截断');
}

// ── B 组「问」 ───────────────────────────────────────────────────────────────

// B1 子任务简报：暂停且 awaiting_input 时带问题原文 + 勿重复提示
function mkParentWithChild(
  childCtx: Record<string, unknown>,
  childStatus = 'paused',
): { db: Database.Database; parentId: string; childId: string } {
  const db = mkdb();
  const parentId = 'p-parent';
  const childId = 'c-child';
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, 'p', '父', 'paused', '{}')").run(parentId);
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id, context_json) VALUES (?, 'p', '子', ?, ?, ?)")
    .run(childId, childStatus, parentId, JSON.stringify(childCtx));
  return { db, parentId, childId };
}

{
  const { db, parentId, childId } = mkParentWithChild({
    pause_reason: 'awaiting_input',
    awaiting_input: { question: '请选择提交口径：\nA. 仅提交 backend\nB. 复制方案文件', options: ['A. 仅提交 backend', 'B. 复制方案文件'] },
    completion_summary: '已定位并修复',
  });
  const briefs = buildChildBriefs(db, parentId);
  ok(briefs.length === 1, 'B1 子任务简报恰一行', `len=${briefs.length}`);
  ok(briefs[0]!.includes('在等你答复'), 'B1 简报写明子在等你答复');
  ok(briefs[0]!.includes('请选择提交口径'), 'B1 简报带问题原文');
  ok(briefs[0]!.includes('勿重复提问'), 'B1 简报提示勿重复');

  let message = '';
  // zx_20261119_1 M3：**唯一的**已停子只在等答复时父任务不再被唤醒（见下方 B1b）；
  //   本条要守的是"被唤醒时抬头必须如实点名"——故夹具补一个已归档兄弟，让父仍会被唤醒
  //   （混合场景 = 父确有需复核的东西）。
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id, context_json) VALUES (?, 'p', '已归档子', 'archived', ?, '{}')")
    .run('c-archived', parentId);
  checkParentTaskAfterChildDone(db, childId, {
    enqueue: async (_type, payload) => { message = String(payload.message ?? ''); },
    enqueued: () => {},
  });
  ok(message.includes('在等你答复'), 'B1 父任务抬头点名在等你答复', message.slice(0, 120));
  ok(message.includes('勿重复提问'), 'B1 父任务抬头提示勿重复');
  ok(message.includes('请选择提交口径'), 'B1 父任务抬头/简报带问题原文');
  db.close();
}

// B1b 反向（zx_20261119_1 M3）：唯一子只在等答复 ⇒ 父**不唤醒**（不替子重做）
{
  const { db, parentId, childId } = mkParentWithChild({
    pause_reason: 'awaiting_input',
    awaiting_input: { question: '请选择提交口径：\nA. 仅提交 backend\nB. 复制方案文件', options: ['A. 仅提交 backend', 'B. 复制方案文件'] },
  });
  let enqueued = 0;
  checkParentTaskAfterChildDone(db, childId, { enqueue: async () => { enqueued += 1; return 'job'; }, enqueued: () => {} });
  eq(enqueued, 0, 'B1b 等答子不唤醒父（0 次入队）');
  eq((db.prepare('SELECT status FROM wa_tasks WHERE id=?').get(parentId) as { status: string }).status, 'paused', 'B1b 父任务保持 paused');
  db.close();
}

// B2 反向：普通暂停（非 awaiting）不改变既有抬头逐字
{
  const { db, parentId } = mkParentWithChild({ pause_reason: 'user_interrupt', completion_summary: '人工暂停' });
  const briefs = buildChildBriefs(db, parentId);
  ok(!briefs[0]!.includes('勿重复提问'), 'B2 普通暂停不误报「勿重复」');
  ok(briefs[0]!.includes('暂停·'), 'B2 普通暂停仍如实写暂停');
  db.close();
}

// ── C 组「名」 ───────────────────────────────────────────────────────────────

// C1 根围栏纯判据：两侧同试；同名前缀不误判；空根保守
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-roots-'));
  const inside = path.join(base, 'a', 'x.txt');
  const sibling = `${base}-sibling`;
  ok(isInsideAnyRoot(inside, [base]) === true, 'C1 根内为真');
  ok(isInsideAnyRoot(base, [base]) === true, 'C1 根本身为真');
  ok(isInsideAnyRoot(path.join(os.tmpdir(), 'rr-outside.txt'), [base]) === false, 'C1 根外为假');
  ok(isInsideAnyRoot(path.join(sibling, 'x.txt'), [base]) === false, 'C1 同名前缀不误判');
  ok(isInsideAnyRoot(inside, []) === false, 'C1 空根保守为假');
}

// C2 接线：write_file/edit_file 两处同一围栏；根集合单一构造
{
  const write = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/write.ts'), 'utf-8')).join('\n');
  const hits = write.match(/isInsideAnyRoot\(realOrResolved\(fp\), deliverableRoots\(workingDir, ctx\.dataDir\)\)/g) ?? [];
  eq(hits.length, 2, 'C2 write_file 与 edit_file 两处同围栏');
  ok(write.includes('function deliverableRoots('), 'C2 根集合单一构造');
  ok(!/const roots = \[workingDir, ctx\.dataDir\]/.test(write), 'C2 不再各自手拼根数组');
  ok(write.includes("from '../real-path.js'"), 'C2 真实路径取同一份 realOrResolved');
}

// C3 工具级（根外/根内两条真路径）见 `scripts/rr_zx_20261118_2_c3.ts`——
//   该组要 `await tools.write_file.execute(...)`，而本套件是 CJS（`__dirname`），不能顶层 await；
//   独立成小套件后由全量编排器同批发现（P4 认 `rr_<tag>_*.ts`）。

// ── D 组「拆」 ───────────────────────────────────────────────────────────────

// D1 三种目录标本：自身是仓 / 仅子目录是仓 / 都不是仓
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-repo-'));
  const selfRepo = path.join(base, 'self');
  fs.mkdirSync(selfRepo, { recursive: true });
  execFileSync('git', ['init', '-q', selfRepo]);
  const f1 = collectRepoBoundary(selfRepo);
  ok(f1.selfIsRepo === true, 'D1 自身是仓根');
  ok(formatRepoBoundary(f1).includes('工作目录本身是 git 仓库'), 'D1 渲染自身是仓');

  const root2 = path.join(base, 'r2');
  fs.mkdirSync(path.join(root2, 'sub'), { recursive: true });
  execFileSync('git', ['init', '-q', path.join(root2, 'sub')]);
  const f2 = collectRepoBoundary(root2);
  ok(f2.selfIsRepo === false && f2.repos.includes('sub'), 'D1 仅一层子目录是仓');

  const root3 = path.join(base, 'r3');
  fs.mkdirSync(root3, { recursive: true });
  const f3 = collectRepoBoundary(root3);
  ok(f3.selfIsRepo === false && f3.repos.length === 0, 'D1 都不是仓');
  ok(formatRepoBoundary(f3).includes('不受控'), 'D1 渲染不受控');
}

// D2 提示词：边界为空逐字不变；非空才追加硬规则
{
  const p0 = buildDecomposePrompt('任务', undefined, undefined, undefined, '项目须知');
  const p1 = buildDecomposePrompt('任务', undefined, undefined, undefined, '项目须知', '');
  eq(p1, p0, 'D2 边界为空时提示词逐字不变');
  const p2 = buildDecomposePrompt('任务', undefined, undefined, undefined, '项目须知', '版本控制边界（实测）：\n- 工作目录本身不是 git 仓库');
  ok(p2.includes('版本控制边界（实测）') && p2.includes('不要生成该子任务'), 'D2 边界非空追加硬规则');
}

// D3 探测失败：如实写 probeError、永不抛
{
  const missing = path.join(os.tmpdir(), `rr-repo-missing-${crypto.randomUUID()}`);
  let threw: unknown = null;
  let f: ReturnType<typeof collectRepoBoundary> | null = null;
  try { f = collectRepoBoundary(missing); } catch (e) { threw = e; }
  ok(threw === null, 'D3 目录不存在不抛');
  ok(typeof f?.probeError === 'string' && f!.probeError.length > 0, 'D3 如实记 probeError');
  ok(formatRepoBoundary({ workdir: '', selfIsRepo: false, repos: [] }) === '', 'D3 无工作目录 → 空串（调用方逐字不加）');
}

// D4 接线：拆解路真探测并仅在非空时透传（不是只建了模块没接上）
{
  const dec = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/task-decompose.ts'), 'utf-8')).join('\n');
  ok(dec.includes('collectRepoBoundary(readProjectWorkingDir(opts.db, opts.projectId))'), 'D4 autoDecomposeForTask 实测探测工作目录');
  ok(dec.includes('...(repoBoundaryText ? { repoBoundaryText } : {})'), 'D4 边界段仅在非空时透传给 decomposeTask');
}

// ── E 组「豁」 ───────────────────────────────────────────────────────────────

const W = (criterion: string, reason = '环境上不可能满足'): { criterion: string; reason: string; by: 'user'; at: string } =>
  ({ criterion, reason, by: 'user', at: '2026-11-18T00:00:00Z' });

// E1 套用：只对 failed 生效；不改 passed；已通过/找不到的记 unmatched
{
  const checks = [
    { criterion: 'A', passed: true },
    { criterion: 'B', passed: false, reason: 'plans/ 不在 git 仓' },
    { criterion: 'C', passed: false, reason: '其他' },
  ];
  const r = applyAcceptanceWaivers(checks, [W('B'), W('A'), W('不存在')]);
  ok(r.checks[1]!.waived === true, 'E1 failed 条目打上 waived');
  ok(r.checks[1]!.passed === false, 'E1 不改 passed（不伪造通过）');
  ok(r.checks[0]!.waived !== true, 'E1 已通过条目不套豁免');
  eq(r.waived.map((w) => w.criterion), ['B'], 'E1 只有命中 failed 的豁免生效');
  eq(r.unmatched.map((w) => w.criterion), ['A', '不存在'], 'E1 未落地的豁免不静默');
}

// E2 收口闸：有豁免的未达项不再拒收；无豁免仍拒收
{
  const checks = [
    { criterion: 'A', passed: true, evidence_refs: [] },
    { criterion: 'B', passed: false, reason: '环境不可能满足', evidence_refs: [] },
  ];
  const blocked = decideAcceptanceOutcome({ kind: 'ok', text: '', checks, criteriaOrder: ['A', 'B'] });
  ok(blocked.outcome.ran === true && blocked.outcome.passed === false, 'E2 未豁免时仍拒收');
  ok(String(blocked.outcome.ran && !blocked.outcome.passed ? blocked.outcome.block : '').includes('环境不可能满足'), 'E2 拒收串点明未达项');

  const waived = decideAcceptanceOutcome({ kind: 'ok', text: '', checks, criteriaOrder: ['A', 'B'], waivers: [W('B')] });
  ok(waived.outcome.ran === true && waived.outcome.passed === true, 'E2 豁免后放行');
  ok(waived.checks[1]!.waived === true, 'E2 返回条目带 waived 标记');
}

// E3 凭据：全过 / 含豁免 / 未过 三态各有其名；verdict 同步
{
  const passedAc = { checked_at: 't', verified: true, criteria_total: 2, passed_total: 2, failed: [] };
  const waivedAc = { checked_at: 't', verified: true, criteria_total: 4, passed_total: 3, waived_total: 1, failed: [{ criterion: 'B', reason: 'r', waived: true }] };
  const failedAc = { checked_at: 't', verified: true, criteria_total: 4, passed_total: 3, failed: [{ criterion: 'B', reason: 'r' }] };
  eq(goalEvidenceOf(passedAc), 'acceptance_passed', 'E3 全过凭据不变');
  eq(goalEvidenceOf(waivedAc), 'acceptance_passed_with_waivers', 'E3 豁免后凭据单独命名');
  eq(goalEvidenceOf(failedAc), 'acceptance_failed', 'E3 未豁免仍未过');
  eq(acceptanceVerdictOf(waivedAc), 'passed', 'E3 verdict 把豁免计入满足');
  eq(acceptanceVerdictOf(failedAc), 'failed', 'E3 verdict 无豁免仍 failed');
}

// E4 载荷：failed 条目带 waived、waived_total 单独计数，passed_total 不并进豁免
{
  const payload = buildAcceptanceCheckPayload([
    { criterion: 'A', passed: true },
    { criterion: 'B', passed: false, reason: 'r', waived: true },
  ]);
  eq(payload.passed_total, 1, 'E4 passed_total 只数模型判过');
  eq(payload.waived_total, 1, 'E4 waived_total 单独计数');
  ok(payload.failed[0]?.waived === true, 'E4 failed 条目保留 waived 标记');
}

// E5 读豁免：坏 JSON / 缺理由 / 缺判据一律跳过
{
  eq(readAcceptanceWaivers(null), [], 'E5 无账不抛');
  eq(readAcceptanceWaivers({ acceptance_waiver: { items: 'bad' } }), [], 'E5 坏形状返回空');
  eq(readAcceptanceWaivers({ acceptance_waiver: { items: [{ criterion: 'A', reason: 'r', by: 'user', at: 't' }, { criterion: 'B' }, { reason: 'x' }] } }).map((w) => w.criterion), ['A'], 'E5 缺判据/缺理由的条目不生效');
}

// E6 接线与边界：GUI 写口存在；finalize_task 工具无豁免参数（agent 不能自豁免）
{
  const ipc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/ipc/project.ipc.ts'), 'utf-8')).join('\n');
  ok(ipc.includes("ipcMain.handle('task:waiveAcceptance'"), 'E6 GUI 写口在册');
  ok(ipc.includes('acceptance_passed_with_waivers'), 'E6 写口把凭据改为含豁免');
  ok(ipc.includes('waived_total: waivedTotal'), 'E6 写口落 waived_total');
  ok(ipc.includes('buildCompletionAccount(') && ipc.includes('syncGoalAchievedFromAccount(ctx)'), 'E6 写口经唯一完成账构造器并同步顶层');
  ok(ipc.includes('REASON_REQUIRED') && ipc.includes('NOT_FAILED'), 'E6 写口校验理由与未达项');
  const bus = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/event-bus.ts'), 'utf-8')).join('\n');
  ok(bus.includes("'task.acceptance_waived': { aggregate_type: 'task'"), 'E6 豁免事件有聚合映射（可落库）');
  const tool = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/control-finalize.ts'), 'utf-8')).join('\n');
  ok(!/waive/i.test(tool), 'E6 finalize_task 工具无豁免参数（agent 不能自豁免）');
  const page = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf-8')).join('\n');
  ok(page.includes('豁免此条'), 'E6 验收块有「豁免此条」按钮');
  ok(page.includes('豁免并收口'), 'E6 弹窗有「豁免并收口」');
  ok(page.includes('tasks.waiveAcceptance'), 'E6 页面调用唯一写口');
}

// ── F 组「计」 ───────────────────────────────────────────────────────────────

// F1 completed 但 goal_achieved=false 单独计入 unachieved；不再谎报「所有 N 个已完成」
{
  const cls = classifyChildCompletion([
    { status: 'completed', context_json: JSON.stringify({ completion_quality: { score: 45, goal_achieved: false, via: 'task:updateStatus' } }) },
    { status: 'completed', context_json: JSON.stringify({ completion_quality: { score: 95, goal_achieved: true } }) },
    { status: 'archived', context_json: '{}' },
  ]);
  eq(cls.done, 2, 'F1 done 仍按 completed 计数');
  eq(cls.unachieved, 1, 'F1 未达目标单独计数');
  const label = childCompletionCheckLabel(cls);
  ok(label.includes('未达目标 1 个'), 'F1 自检文案点名未达目标', label);
  ok(!label.includes('所有'), 'F1 自检不再出现「所有…已完成」');
}

// F2 完成且全达成：旧文案逐字不变
{
  const cls = classifyChildCompletion([
    { status: 'completed', context_json: '{}' },
    { status: 'completed', context_json: '{}' },
  ]);
  eq(cls.unachieved, 0, 'F2 全达成不误报未达');
  eq(childCompletionCheckLabel(cls), '[PASS] 所有2个子任务已完成', 'F2 旧文案逐字不变');
}

// F3 空壳与未达目标不双重计数：空壳已由 emptyShell 记账
{
  const cls = classifyChildCompletion([
    { status: 'completed', context_json: JSON.stringify({ auto_completed_without_output: true, completion_quality: { goal_achieved: false } }) },
  ]);
  eq(cls.emptyShell, 1, 'F3 空壳计入 emptyShell');
  eq(cls.unachieved, 0, 'F3 空壳不重复计入 unachieved');
}

// F4 一源：ai-task 与 task-accounting 同引 completion-truth，不再各写一份
{
  const ai = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/jobs/ai-task.ts'), 'utf-8')).join('\n');
  const acc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/task-accounting.ts'), 'utf-8')).join('\n');
  ok(!/function isIncompleteCompletion/.test(ai), 'F4 ai-task 不再自带判据实现');
  ok(ai.includes("from '../completion-truth.js'"), 'F4 ai-task 引同一份 completion-truth');
  ok(acc.includes("from './completion-truth.js'"), 'F4 task-accounting 引同一份 completion-truth');
}

// ── G 组「标」 ───────────────────────────────────────────────────────────────

// G1 分值与来路：自评/引擎两种文案；两侧谓词同源
{
  eq(qualityLabel(95, 'finalize_task'), '自评 95/100', 'G1 收口自评写「自评」');
  eq(qualityLabel(95, 'run_close'), '质量 95/100', 'G1 引擎分写「质量」');
  eq(qualityLabel(80, undefined), '质量 80/100', 'G1 无来路按质量（不冒充自评）');
  ok(isSelfAssessedQualityVia('finalize_task') === true, 'G1 自评谓词命中');
  ok(isSelfAssessedQualityVia('run_close') === false, 'G1 引擎分不命中自评');
  ok(isSelfAssessedQuality({ status: 'completed', context_digest: JSON.stringify({ completion_quality: { score: 95, via: 'finalize_task' } }) }) === true, 'G1 列表徽标同引自评谓词');
  ok(isSelfAssessedQuality({ status: 'completed', context_digest: JSON.stringify({ completion_quality: { score: 95, via: 'run_close' } }) }) === false, 'G1 列表徽标不把引擎分标自评');
}

// G2 接线：通知/列表/详情三处都走同一份文案，且不再各写一份
{
  const notice = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/task-notice.ts'), 'utf-8')).join('\n');
  ok(notice.includes('qualityLabel(score, via)'), 'G2 通知用 qualityLabel');
  ok(!notice.includes('（质量 ${score}/100）'), 'G2 通知不再手写「质量 N/100」');

  const detail = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf-8')).join('\n');
  ok(/completionVia === 'finalize_task' \? '（自评）' : ''/.test(detail), 'G2 详情分数徽标合并「（自评）」');
  ok(!detail.includes('title="finalize_task 的分数是收口方自评'), 'G2 详情不再另贴独立自评小胶囊');

  const list = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/TasksPage.tsx'), 'utf-8')).join('\n');
  ok(/isSelfAssessedQuality\(t\)\s*\?\s*'·自评'\s*:\s*''/.test(list), 'G2 列表分数徽标合并「·自评」');
}

// ── H 组「证」 ───────────────────────────────────────────────────────────────

{
  checkBuildPins(ok);
  const src = fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf-8');
  const m = /build:\s*'(zx_\d{8}(?:_\d+)?)'/.exec(src);
  const tag = m?.[1] ?? '';
  ok(buildNotOlderThan(tag, SELF.replace(/^rr_/, '')), 'H1 build 不早于本套件轮次', `${tag} vs ${SELF}`);
  const code = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/components/NextActionBar.tsx'), 'utf-8')).join('\n');
  ok(!code.includes('truncate'), 'H2 NextActionBar 说明位不再 truncate（待 M1 后成立）');
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail === 0 ? 0 : 1);
