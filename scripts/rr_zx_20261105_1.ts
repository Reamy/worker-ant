/**
 * zx_20261105_1「验」受控回归 —— 判卷要有据，归档要有账。
 *
 * A 运行证据：成功/失败/超时/拒绝四态落表；运行类判据无证据强制降级；纯文档判据 fail-open；
 *   空判据不再冒充 0/0；`verified` 由结论派生；命令脱敏；按任务隔离。
 * B 归档闸：验收类暂停的直接子任务空理由双入口拒；带理由放；其余暂停因由与终态不误伤；
 *   被拒时库未动、事件未发。
 * C 归档留账：快照键齐全、兄弟键不丢；实时账翻页；重复归档保首次判卷；坏账仍归档。
 * D 子代理结论：结构化采用；`unknown` 不冒充通过；限定只取证据账；自造引用剔除；父摘要不补 pass。
 * E 形态兜底：长题面 + 运行/写 ⇒ code；只运行 ⇒ analysis；纯调研不升级；关键词与覆盖优先级不变。
 * F 工具面：只读内省放行、危险命令仍拒、构建命令不计探索、`deny_kind` 入证据。
 * G 判据候选：有依据才有候选；候选不自动采用；合并写不抹兄弟键。
 * H 同名去重：在途复用、终态编号、上限拒绝、不同题面不合并。
 * I 归档可见：详情字段、子任务投影、上屏文案、以原题面新建不改原行。
 * J 静态钉：`checkBuildPins`、`ROUND_RE`、IPC 字段、renderer 调用、合并写唯一口；哑雷零命中。
 *
 * 纪律：零网络 / 零 electron；夹具按生产列形自建 DDL；计数器带 0→1 正面断言；
 *   断言文案不含失败/通过字形；不写"只为下一轮"的字面量（build 值由源码派生）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  RUNTIME_EVIDENCE_DDL,
  recordRuntimeEvidence,
  listRuntimeEvidence,
  evidenceIdOf,
  denyReasonText,
  redactCommand,
  renderRuntimeEvidence,
} from '../apps/worker-ant-desktop/src/main/core/runtime-evidence.js';
import {
  criterionNeedsRuntime,
  enforceEvidenceBoundChecks,
  RUNTIME_EVIDENCE_REQUIRED_REASON,
  decideAcceptanceOutcome,
  buildAcceptanceCheckPayload,
  buildUnverifiedCheckPayload,
  acceptanceVerdictOf,
  suggestCriteriaFromText,
  readProposedAcceptance,
  proposeAcceptanceCriteria,
  CRITERIA_SUGGESTION_LIMIT,
  PROPOSED_ACCEPTANCE_KEY,
} from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';
import {
  archiveDecision,
  archiveTask,
  archivedSnapshotOf,
  archivedReasonOf,
  ARCHIVED_SNAPSHOT_KEY,
  ARCHIVE_REASON_KEY,
} from '../apps/worker-ant-desktop/src/main/core/task-archive.js';
import { turnAccountPage } from '../apps/worker-ant-desktop/src/main/core/task-terminal.js';
import {
  parseSubagentConclusion,
  limitationsFromEvidence,
  readSubagentResult,
  writeSubagentResult,
  isSubagentTaskContext,
  SUBAGENT_RESULT_KEY,
  verdictLabelOf,
} from '../apps/worker-ant-desktop/src/main/core/subagent-result.js';
import { mergeTaskContext, applyContextPatch } from '../apps/worker-ant-desktop/src/main/core/context-merge.js';
import { buildChildBriefs } from '../apps/worker-ant-desktop/src/main/core/jobs/ai-task.js';
import {
  capabilityNeedsOf,
  classifyArchetypeDetailed,
  ARCHETYPE_TOOL_CATEGORIES,
} from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';
import { resolvePinnedArchetype } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import {
  SAFE_READONLY_COMMANDS,
  isReadonlyIntrospectionCommand,
  validateReadonlyBashCommand,
  evaluateMultiSegment,
} from '../apps/worker-ant-desktop/src/main/core/tool-guards.js';
import {
  BUILD_RUN_COMMANDS,
  isExplorationCall,
  isReadOnlyProbeCommand,
  countsTowardToolQuota,
  makeNonExplorationCappedTool,
} from '../apps/worker-ant-desktop/src/main/core/exec-strategy.js';
import { resourceTools, normalizeSubagentTitle, SUBAGENT_REPEAT_LIMIT } from '../apps/worker-ant-desktop/src/main/core/tools/resource.js';
import { buildArchiveDraft } from '../apps/worker-ant-desktop/src/main/core/archive-draft.js';
import { eventBus } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';
import { ROUND_RE, checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';

const ROOT = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const SELF_ROUND = path.basename(__filename, '.ts').replace(/^rr_/, '');
const SRC_BUILD = deriveBuildTag(fs.readFileSync(path.join(ROOT, `${A}/src/main/core/agent-executor.ts`), 'utf-8')).tag;
/** 轮次序号（`zx_YYYYMMDD[_n]` → 可比较数值）；后续轮次推进 build 不应弄红套件。 */
const roundOrd = (tag: string): number => {
  const m = /^zx_(\d{8})(?:_(\d+))?$/.exec(tag);
  return m ? Number(m[1]) * 1000 + Number(m[2] ?? 1) : -1;
};

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}
function readText(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}
function readCode(rel: string): string {
  return stripKeepingLines(readText(rel)).join('\n');
}
const asBetter = (d: DatabaseSync) => d as unknown as import('better-sqlite3').Database;

/** 取一个 IPC handler 的源码体（到下一个 `ipcMain.handle(` 为止）。 */
function handlerBody(code: string, channel: string): string {
  const marker = `'${channel}'`;
  const start = code.indexOf(marker);
  if (start < 0) return '';
  const next = code.indexOf('ipcMain.handle(', start + marker.length);
  return code.slice(start, next < 0 ? code.length : next);
}

/* ═══ A 运行证据 ═══════════════════════════════════════════════════════════ */
function sectionA(): void {
  console.log('\n【A】运行证据：跑没跑过，是判卷的凭据');
  const d = new DatabaseSync(':memory:');
  d.exec(RUNTIME_EVIDENCE_DDL);
  const okId = recordRuntimeEvidence(asBetter(d), {
    taskId: 'T-A', tool: 'bash', command: 'mvn -q test', ok: true, exitCode: 0, outputTail: 'BUILD SUCCESS',
  });
  const failId = recordRuntimeEvidence(asBetter(d), {
    taskId: 'T-A', tool: 'bash', command: 'mvn -q compile', ok: false, exitCode: 1, outputTail: 'compile error',
  });
  const timeoutId = recordRuntimeEvidence(asBetter(d), {
    taskId: 'T-A', tool: 'execute_command', command: 'pnpm build', ok: false, timedOut: true,
  });
  const denyId = recordRuntimeEvidence(asBetter(d), {
    taskId: 'T-A', tool: 'bash', command: 'jar cf out.jar A.class', ok: false,
    denyReason: '只读白名单不允许', denyKind: 'not_in_whitelist',
  });
  const rows = listRuntimeEvidence(asBetter(d), 'T-A', 50);
  ok([okId, failId, timeoutId, denyId].every((x) => typeof x === 'string' && x.length > 0), 'A1 四态各落一行且返回行 id');
  eq(rows.length, 4, 'A2 同一任务四态共四行');
  const byId = (id: string | null) => rows.find((r) => r.id === id)!;
  eq([byId(okId).ok, byId(okId).exit_code, byId(okId).timed_out, byId(okId).deny_reason], [1, 0, 0, null], 'A3 成功态字段');
  eq([byId(failId).ok, byId(failId).exit_code], [0, 1], 'A4 失败态带退出码');
  eq([byId(timeoutId).ok, byId(timeoutId).timed_out], [0, 1], 'A5 超时态可辨');
  eq(byId(denyId).deny_reason, 'deny_kind=not_in_whitelist; 只读白名单不允许', 'A6 拒绝态带类别前缀');
  ok(renderRuntimeEvidence(rows).includes(`[运行证据 run:${okId}] tool=bash ok=1 exit=0 timedOut=0`), 'A7 证据串格式固定（判卷可引）');
  ok(renderRuntimeEvidence(rows).includes('deny=deny_kind=not_in_whitelist'), 'A8 拒绝行以 deny 代替退出码');
  eq(evidenceIdOf({ id: 'abc' }), 'run:abc', 'A9 引用编号由行 id 派生');
  eq(denyReasonText('原因', 'destructive'), 'deny_kind=destructive; 原因', 'A10 拒绝原因写口归一');
  eq(redactCommand('curl --token abc123 https://x'), 'curl --token *** https://x', 'A11 显式令牌脱敏');
  eq(redactCommand('API_KEY=secret-value run'), 'API_KEY=*** run', 'A12 环境变量密钥脱敏');
  ok(!redactCommand('sk-1234567890abcdef').includes('1234567890abcdef'), 'A13 常见密钥前缀遮蔽');
  recordRuntimeEvidence(asBetter(d), { taskId: 'T-B', tool: 'bash', command: 'ls', ok: true, exitCode: 0 });
  eq([listRuntimeEvidence(asBetter(d), 'T-A', 50).length, listRuntimeEvidence(asBetter(d), 'T-B', 50).length], [4, 1],
    'A14 证据按任务为界（不串任务）');

  ok(criterionNeedsRuntime('重启后端不报错'), 'A15 动作/结果词命中 ⇒ 需运行证据');
  ok(criterionNeedsRuntime('接口返回 success'), 'A16 结果词单独命中 ⇒ 需运行证据');
  ok(!criterionNeedsRuntime('报告包含三节'), 'A17 纯文档判据 fail-open（不误降）');
  ok(!criterionNeedsRuntime('') && !criterionNeedsRuntime(null), 'A18 空判据不判运行类');

  const evidenceIndex = new Set(rows.map(evidenceIdOf));
  const enforced = enforceEvidenceBoundChecks([
    { criterion: '重启后端不报错', passed: true, reason: '看过日志', evidence_refs: [] },
    { criterion: '重启后端不报错', passed: true, evidence_refs: [`run:${okId}`] },
    { criterion: '重启后端不报错', passed: true, evidence_refs: ['run:made-up'] },
    { criterion: '报告包含三节', passed: true, evidence_refs: [] },
    { criterion: '运行测试通过', passed: false, reason: '已有失败', evidence_refs: [] },
  ], evidenceIndex);
  eq([enforced[0]!.passed, enforced[0]!.evidence_missing], [false, true], 'A19 运行类判据无引用 ⇒ 强制降级');
  ok(String(enforced[0]!.reason).includes(RUNTIME_EVIDENCE_REQUIRED_REASON) && String(enforced[0]!.reason).includes('看过日志'),
    'A20 降级保留原理由并追加固定文案');
  eq(enforced[1]!.passed, true, 'A21 引用本任务真证据 ⇒ 维持通过');
  eq([enforced[2]!.passed, enforced[2]!.evidence_missing], [false, true], 'A22 自造 run:<id> 不算证据');
  eq(enforced[3]!.passed, true, 'A23 纯文档判据 fail-open 原样放行');
  eq([enforced[4]!.passed, enforced[4]!.reason, enforced[4]!.evidence_missing], [false, '已有失败', undefined],
    'A24 模型已判未过的条目不改判');

  const emptyExplicit = decideAcceptanceOutcome({ kind: 'ok', text: '', checks: [] });
  eq([emptyExplicit.outcome.ran, (emptyExplicit.outcome as { reason?: string }).reason], [false, 'empty_checks'],
    'A25 显式空数组 ⇒ empty_checks（不冒充全过）');
  const emptyParsed = decideAcceptanceOutcome({ kind: 'ok', text: '[]' });
  eq([emptyParsed.outcome.ran, (emptyParsed.outcome as { reason?: string }).reason], [false, 'empty_checks'],
    'A26 文本空数组同样 ⇒ empty_checks');
  eq(decideAcceptanceOutcome({ kind: 'ok', text: '无 JSON' }).outcome, { ran: false, reason: 'no_json' }, 'A27 无可解析结论 ⇒ no_json');
  eq(decideAcceptanceOutcome({ kind: 'no_model', text: null }).outcome, { ran: false, reason: 'no_model' }, 'A28 无模型 ⇒ no_model');
  eq(decideAcceptanceOutcome({ kind: 'exception', text: null }).outcome, { ran: false, reason: 'error' }, 'A29 异常 ⇒ error');
  const passedOutcome = decideAcceptanceOutcome({ kind: 'ok', text: '[{"criterion":"a","passed":true}]' });
  eq([passedOutcome.outcome.ran, (passedOutcome.outcome as { passed?: boolean }).passed], [true, true], 'A30 全过 ⇒ ran/passed');
  const failedOutcome = decideAcceptanceOutcome({
    kind: 'ok', text: '[{"criterion":"a","passed":true},{"criterion":"b","passed":false,"reason":"缺数据"}]',
  });
  ok(failedOutcome.outcome.ran && (failedOutcome.outcome as { passed?: boolean }).passed === false
    && String((failedOutcome.outcome as { block?: string }).block).includes('b') , 'A31 有未过 ⇒ 阻断并点名判据');

  const pEmpty = buildAcceptanceCheckPayload([]);
  eq([pEmpty.verified, pEmpty.criteria_total, acceptanceVerdictOf(pEmpty)], [false, 0, 'not_checked'],
    'A32 verified 由条目派生：空数组不是已验证');
  const pPass = buildAcceptanceCheckPayload([{ criterion: 'a', passed: true }]);
  eq([pPass.verified, pPass.passed_total, acceptanceVerdictOf(pPass)], [true, 1, 'passed'], 'A33 有通过条目 ⇒ verified/passed');
  const pFail = buildAcceptanceCheckPayload([{ criterion: 'a', passed: true }, { criterion: 'b', passed: false }]);
  eq([pFail.verified, pFail.failed.length, acceptanceVerdictOf(pFail)], [true, 1, 'failed'], 'A34 verified 表示真判过，胜负另判');
  eq(acceptanceVerdictOf(buildUnverifiedCheckPayload('empty_checks')), 'unjudged', 'A35 空判据 ⇒ unjudged');
  eq(acceptanceVerdictOf(buildUnverifiedCheckPayload('no_criteria')), 'not_checked', 'A36 无题目 ⇒ not_checked');

  // zx_20261109_1 B6：判卷整块搬至 `exec-acceptance.ts` ⇒ A37/A38 随实现走。
  const accept = readCode(`${A}/src/main/core/exec-acceptance.ts`);
  ok(accept.includes("evidenceIndex = new Set(bundle.runtimeEvidence.map(evidenceIdOf))") && accept.includes('enforceEvidenceBoundChecks(parsed, evidenceIndex)'),
    'A37 判卷先解析、再按本任务证据强制降级');
  ok(accept.includes('每条判据须附 evidence_refs') && accept.includes('run:<id>'), 'A38 判卷提示词要求引用运行证据');
  const ev = readCode(`${A}/src/main/core/exec-evidence.ts`);
  ok(ev.includes('listRuntimeEvidence(db, taskId)') && ev.includes('renderRuntimeEvidence(bundle.runtimeEvidence)'),
    'A39 判卷证据面同源取运行证据');
  const shell = readCode(`${A}/src/main/core/tools/shell.ts`);
  ok(shell.includes('recordRuntimeEvidence(db, { taskId, tool, command, ok: false, denyReason: text, denyKind: kind })'),
    'A40 逐调用拒绝把 deny_kind 落证据');
  const ipc = readCode(`${A}/src/main/ipc/project.ipc.ts`);
  ok(ipc.includes('runtimeEvidence: listRuntimeEvidence(db, id, 50)'), 'A41 任务详情回传运行证据');
  const page = readCode(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  ok(page.includes('setRuntimeEvidence(taskData.runtimeEvidence || [])') && page.includes('setRuntimeEvidence(data.runtimeEvidence || [])'),
    'A42 两条加载路都接收运行证据');
  ok(page.includes('运行证据') && page.includes('r.deny_reason') && page.includes('runtimeEvidence.filter(r => !r.ok)'),
    'A43 详情上屏证据、拒绝原因与被拒条数');
}

/* ═══ B 归档闸 ═════════════════════════════════════════════════════════════ */
const ARCHIVE_SCHEMA = `
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, parent_task_id TEXT DEFAULT '', status TEXT DEFAULT 'pending',
  context_json TEXT DEFAULT '{}', quality_score REAL, updated_at TEXT DEFAULT (datetime('now'))
);
`;
function archiveDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(ARCHIVE_SCHEMA);
  return d;
}
function addRow(d: DatabaseSync, id: string, parent: string, status: string, ctx: Record<string, unknown>, quality: number | null = null): void {
  d.prepare('INSERT INTO wa_tasks (id, project_id, parent_task_id, status, context_json, quality_score) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'p1', parent, status, JSON.stringify(ctx), quality);
}
const ctxOf = (d: DatabaseSync, id: string) => JSON.parse(
  (d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}',
) as Record<string, unknown>;
const statusOf = (d: DatabaseSync, id: string) => String(
  (d.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status,
);

function sectionB(): void {
  console.log('\n【B】归档闸：放弃可以，但不能把"没判/没过"静默抹掉');
  const reject = archiveDecision({ status: 'paused', isDirectChild: true, pauseReason: 'acceptance_unjudged' });
  ok(reject.allow === false && reject.code === 'archive_reason_required', 'B1 验收未判的直接子任务，空理由 ⇒ 拒');
  ok(archiveDecision({ status: 'paused', isDirectChild: true, pauseReason: 'acceptance_unjudged', reason: '   ' }).allow === false,
    'B2 纯空白理由视同未填');
  eq(archiveDecision({ status: 'paused', isDirectChild: true, pauseReason: 'acceptance_unjudged', reason: '方向作废' }).allow,
    true, 'B3 写了理由 ⇒ 放行');
  ok(archiveDecision({ status: 'paused', isDirectChild: true, pauseReason: 'acceptance_failed' }).allow === false,
    'B4 验收失败的直接子任务同样要理由');
  eq(archiveDecision({ status: 'paused', isDirectChild: true, pauseReason: 'acceptance_failed', reason: '改用方案 B' }).allow,
    true, 'B5 验收失败写理由 ⇒ 放行');
  eq(archiveDecision({ status: 'paused', isDirectChild: true, pauseReason: 'user_interrupt' }).allow, true,
    'B6 用户中断不误伤（正常清理免理由）');
  eq(archiveDecision({ status: 'paused', isDirectChild: true, pauseReason: 'children_incomplete' }).allow, true,
    'B7 等子暂停不误伤');
  eq(archiveDecision({ status: 'paused', isDirectChild: false, pauseReason: 'acceptance_unjudged' }).allow, true,
    'B8 非直接子任务不在父代理处置范围（放行）');
  eq(archiveDecision({ status: 'completed', isDirectChild: true, pauseReason: 'acceptance_unjudged' }).allow, true,
    'B9 仅拦 paused；其余状态照旧');
  ok(reject.message.includes('放弃理由'), 'B10 拒因说清要写放弃理由');

  const d = archiveDb();
  addRow(d, 'B-rej', 'P', 'paused', { pause_reason: 'acceptance_unjudged', keep_me: 1 }, 77);
  const before = d.prepare('SELECT * FROM wa_tasks WHERE id = ?').get('B-rej') as Record<string, unknown>;
  let events = 0;
  const handler = (e: { data: Record<string, unknown> }) => { if (e.data.taskId === 'B-rej') events++; };
  eventBus.on('task.status_changed', handler);
  const rejected = archiveTask(d as never, { taskId: 'B-rej' });
  const after = d.prepare('SELECT * FROM wa_tasks WHERE id = ?').get('B-rej') as Record<string, unknown>;
  ok(rejected.changed === false && rejected.pageTurned === false && rejected.rejected?.code === 'archive_reason_required',
    'B11 被拒：changed/pageTurned 皆 false 且带可辨代码');
  eq(after, before, 'B12 被拒时库一行未动（先于任何写返回）');
  eq(events, 0, 'B13 被拒时不发状态事件（0 次）');
  eventBus.off('task.status_changed', handler);

  const accepted = archiveTask(d as never, { taskId: 'B-rej', reason: '确认放弃' });
  ok(accepted.changed === true, 'B14 带理由再归档 ⇒ 放行（同一行、同一入口）');
  eq(statusOf(d, 'B-rej'), 'archived', 'B15 状态真落 archived');
  eq(archivedReasonOf((d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('B-rej') as { context_json: string }).context_json),
    '确认放弃', 'B16 理由落账');
  ok(ctxOf(d, 'B-rej').keep_me === 1, 'B17 归档不丢兄弟键');

  const okRow = archiveDb();
  addRow(okRow, 'B-ready', 'P', 'paused', { pause_reason: 'children_incomplete' });
  let okEvents = 0;
  const h2 = (e: { data: Record<string, unknown> }) => { if (e.data.taskId === 'B-ready') okEvents++; };
  eventBus.on('task.status_changed', h2);
  const r2 = archiveTask(okRow as never, { taskId: 'B-ready' });
  eventBus.off('task.status_changed', h2);
  ok(r2.changed === true && okEvents === 1, 'B18 放行路径：库改 + 事件各一次（0→1）');

  const ipc = readCode(`${A}/src/main/ipc/project.ipc.ts`);
  const updateStatus = handlerBody(ipc, 'task:updateStatus');
  ok(updateStatus.includes('archiveTask(db, { taskId: id, reason })') && updateStatus.includes('archivedRes.rejected')
    && updateStatus.includes("code: archivedRes.rejected.code"), 'B19 GUI 改状态入口经唯一写手并在被拒时回因由');
  const archiveEntry = handlerBody(ipc, 'task:archive');
  ok(archiveEntry.includes('archiveTask(db, { taskId: id, reason })') && archiveEntry.includes('archivedRes.rejected'),
    'B20 GUI 归档入口同一把闸');
  const control = readCode(`${A}/src/main/core/tools/control.ts`);
  ok(control.includes('archiveTask(db, { taskId: args.targetTaskId, reason: args.reason })') && control.includes('archivedRes.rejected'),
    'B21 编排工具入口同样经唯一写手（无绕过口）');
  ok(ipc.includes("import { archiveTask, archivedSnapshotOf, archivedReasonOf } from '../core/task-archive.js'"),
    'B22 归档读写皆取同一模块');
}

/* ═══ C 归档留账 ═══════════════════════════════════════════════════════════ */
function sectionC(): void {
  console.log('\n【C】归档留账：先留底、再翻页');
  {
    const acc = { checked_at: '2026-11-05T01:00:00.000Z', verified: true, criteria_total: 2, passed_total: 1, failed: [{ criterion: 'x', reason: 'y' }] };
    const cq = { score: 80, goal_achieved: true, via: 'run_close', feedback: 'ok' };
    const d = archiveDb();
    addRow(d, 'C1', '', 'paused', { acceptance_check: acc, completion_quality: cq, goal_achieved: true, pause_reason: 'quality_below_bar', pause_note: '留个注' }, 80);
    const r = archiveTask(d as never, { taskId: 'C1', reason: '方向作废' });
    const ctx = ctxOf(d, 'C1');
    const snap = archivedSnapshotOf(JSON.stringify(ctx))!;
    ok(r.changed === true, 'C1 归档成功');
    ok(ctx.acceptance_check === undefined && ctx.completion_quality === undefined, 'C2 实时账已翻页（两键已清）');
    eq((d.prepare('SELECT quality_score FROM wa_tasks WHERE id = ?').get('C1') as { quality_score: number | null }).quality_score,
      null, 'C3 quality_score 列已置 NULL');
    ok(JSON.stringify(snap.acceptance_check) === JSON.stringify(acc), 'C4 快照留原验收结论');
    ok(JSON.stringify(snap.completion_quality) === JSON.stringify(cq), 'C5 快照留原完成账');
    eq(snap.quality_score, 80, 'C6 快照留原分');
    ok(typeof snap.archived_at === 'string' && snap.archived_at.length > 10, 'C7 快照带归档时刻');
    eq(snap.archive_reason, '方向作废', 'C8 快照带归档理由');
    eq(ctx[ARCHIVE_REASON_KEY], '方向作废', 'C9 顶层理由仍落');
    ok(ctx.pause_reason === 'quality_below_bar' && ctx.pause_note === '留个注'
      && Object.prototype.hasOwnProperty.call(ctx, 'goal_achieved') && ctx.goal_achieved === false,
      'C10 兄弟键不丢（goal_achieved 按归档即未达成置 false）');
    eq(archivedReasonOf(JSON.stringify(ctx)), '方向作废', 'C11 读点取顶层理由');
  }
  {
    const d = archiveDb();
    addRow(d, 'C2', '', 'paused', { pause_reason: 'user_interrupt', pause_note: 'x' });
    const r = archiveTask(d as never, { taskId: 'C2' });
    const ctx = ctxOf(d, 'C2');
    ok(r.changed === true && !(ARCHIVED_SNAPSHOT_KEY in ctx), 'C12 归档前无账 ⇒ 不写空快照');
    eq(archivedSnapshotOf(JSON.stringify(ctx)), null, 'C13 无快照读点回 null');
    eq(archivedReasonOf(JSON.stringify(ctx)), '', 'C14 无理由读点回空串（不编造）');
  }
  {
    const acc1 = { verified: true, criteria_total: 1, passed: ['先'], failed: [] };
    const d = archiveDb();
    addRow(d, 'C3', '', 'paused', { acceptance_check: acc1, completion_quality: { score: 70 }, goal_achieved: true }, 70);
    archiveTask(d as never, { taskId: 'C3', reason: '第一次放弃' });
    const first = archivedSnapshotOf((d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('C3') as { context_json: string }).context_json)!;
    const ctx = ctxOf(d, 'C3');
    (ctx[ARCHIVED_SNAPSHOT_KEY] as Record<string, unknown>).archived_at = '2000-01-01T00:00:00.000Z';
    ctx.acceptance_check = { verified: false, criteria_total: 9 };
    d.prepare('UPDATE wa_tasks SET status = ?, context_json = ? WHERE id = ?').run('completed', JSON.stringify(ctx), 'C3');
    archiveTask(d as never, { taskId: 'C3', reason: '第二次放弃' });
    const snap2 = archivedSnapshotOf((d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('C3') as { context_json: string }).context_json)!;
    ok(JSON.stringify(snap2.acceptance_check) === JSON.stringify(acc1), 'C15 重复归档保首次判卷（不被清空后的现账覆盖）');
    ok(snap2.archived_at !== '2000-01-01T00:00:00.000Z', 'C16 重复归档刷新时刻');
    eq(snap2.archive_reason, '第二次放弃', 'C17 重复归档更新理由');
    eq(first.quality_score, 70, 'C18 首次快照本身带分');
  }
  {
    const d = archiveDb();
    addRow(d, 'C4', '', 'paused', {});
    d.prepare("UPDATE wa_tasks SET context_json = 'not-json' WHERE id = 'C4'").run();
    const r = archiveTask(d as never, { taskId: 'C4', reason: '坏账也归档' });
    ok(r.changed === true && statusOf(d, 'C4') === 'archived', 'C19 坏账不阻断归档');
    eq(archivedReasonOf((d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('C4') as { context_json: string }).context_json),
      '坏账也归档', 'C20 坏账只落因由');
  }
  ok(archivedSnapshotOf('not-json') === null && archivedReasonOf('[]') === '', 'C21 读点坏 JSON 回空不抛');
  {
    const d = archiveDb();
    addRow(d, 'C5', '', 'paused', { acceptance_check: { verified: true }, completion_quality: { score: 60 }, goal_achieved: true }, 60);
    archiveTask(d as never, { taskId: 'C5', reason: 'r' });
    const before = (d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('C5') as { context_json: string }).context_json;
    turnAccountPage(d as never, 'C5');
    const after = (d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('C5') as { context_json: string }).context_json;
    ok(before === after && !!archivedSnapshotOf(after), 'C22 翻页函数重跑不动快照');
  }
  const src = readCode(`${A}/src/main/core/task-archive.ts`);
  ok(src.indexOf("ctx[ARCHIVED_SNAPSHOT_KEY] = snap") < src.lastIndexOf('turnAccountPage(db, taskId)'),
    'C23 顺序钉：先留底、再翻页');
  const ipc = readCode(`${A}/src/main/ipc/project.ipc.ts`);
  ok(ipc.includes('archivedSnapshot: archivedSnap') && ipc.includes('archiveReason: archivedReasonOf(ctxJson) || null'),
    'C24 详情 IPC 回传快照与理由');
  ok(ipc.includes('archivedAt: archivedSnap?.archived_at ?? null'), 'C25 归档时刻同出快照一处读点');
  const page = readCode(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  ok(page.includes('setArchivedSnap(taskData.archivedSnapshot ?? null)') && page.includes('setArchivedSnap(data.archivedSnapshot ?? null)'),
    'C26 两条加载路都回填快照');
  ok(page.includes('snapshotActive && archivedSnap?.acceptance_check'), 'C27 归档态验收块优先读快照');
  ok(page.includes('归档时快照') && page.includes('归档时无验收账'), 'C28 快照标注与无账如实提示');
}

/* ═══ D 子代理结论 ═════════════════════════════════════════════════════════ */
const SUB_SCHEMA = `
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_task_conversations (
  id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '', tool_calls TEXT,
  token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_deliverables (
  id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL, name TEXT DEFAULT '',
  description TEXT DEFAULT '', file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
${RUNTIME_EVIDENCE_DDL}
`;
const mkSubDb = (): DatabaseSync => { const d = new DatabaseSync(':memory:'); d.exec(SUB_SCHEMA); return d; };
const addSubTask = (d: DatabaseSync, id: string, status: string, parent = '', ctx: Record<string, unknown> = {}, created = '2026-11-05 00:00:00') =>
  d.prepare('INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'p', id, status, parent, JSON.stringify(ctx), created);

const STRUCTURED = '验证完成\n```json\n{"verdict":"pass","summary":"编译通过","criteria":[{"criterion":"mvn 编译","passed":true,"reason":"BUILD SUCCESS","evidence_refs":["run:abc","bad",42]}],"limitations":["无 shell 约束"]}\n```';

async function sectionD(): Promise<void> {
  console.log('\n【D】子代理结论：结构化、可回查、不补 pass');
  {
    const r = parseSubagentConclusion(STRUCTURED);
    ok(r.structured && r.verdict === 'pass' && r.summary === '编译通过', 'D1 结构化块被采用');
    ok(r.criteria.length === 1 && r.criteria[0]!.criterion === 'mvn 编译' && r.criteria[0]!.passed === true, 'D2 判据落成');
    eq(r.criteria[0]!.evidence_refs, ['run:abc'], 'D3 只留 run:<id> 形状的引用');
  }
  {
    const r = parseSubagentConclusion('只是散文。'.repeat(300));
    ok(r.verdict === 'unknown' && !r.structured, 'D4 无 JSON 块 ⇒ unknown（不推断 pass）');
    eq(r.summary.length, 1000, 'D5 fallback 摘要截断 1000 字');
  }
  eq(parseSubagentConclusion('```json\n{"criteria":[{"criterion":"a","passed":false},{"criterion":"b","passed":true}]}\n```').verdict,
    'fail', 'D6 判据含未过 ⇒ fail（聚合而非散文）');
  eq(parseSubagentConclusion('```json\n{"criteria":[{"criterion":"a"}]}\n```').verdict, 'unknown', 'D7 判据无 passed ⇒ unknown');

  {
    const rows = [
      { ok: 0, tool: 'execute_command', deny_reason: '只读白名单：javap 不允许', timed_out: 0, exit_code: null },
      { ok: 0, tool: 'execute_command', deny_reason: '只读白名单：javap 不允许', timed_out: 0, exit_code: null },
      { ok: 0, tool: 'bash', deny_reason: null, timed_out: 0, exit_code: 1 },
      { ok: 0, tool: 'bash', deny_reason: null, timed_out: 1, exit_code: null },
      { ok: 1, tool: 'execute_command', deny_reason: null, timed_out: 0, exit_code: 0 },
    ];
    const lim = limitationsFromEvidence(rows as never);
    ok(lim.some((x) => x.includes('被守卫拒绝') && x.includes('2 次')), 'D8 拒绝按原因聚合计数');
    ok(lim.some((x) => x.includes('退出码 1')), 'D9 失败退出码如实列');
    ok(lim.some((x) => x.includes('超时')), 'D10 超时如实列');
    ok(!lim.some((x) => x.includes('ok=1')), 'D11 成功记录不进限定');
  }
  {
    const d = mkSubDb();
    addSubTask(d, 's1', 'completed', '', {
      type: 'subagent', subagentType: 'verifier', run_features: { build: SRC_BUILD },
      attachments: [{ name: 'a.txt' }], task_goal: { goal: '验证编译' },
    });
    const realId = recordRuntimeEvidence(asBetter(d), { taskId: 's1', tool: 'execute_command', command: 'mvn -q test', ok: true, exitCode: 0 });
    recordRuntimeEvidence(asBetter(d), { taskId: 's1', tool: 'execute_command', command: 'javap -c X', ok: false, denyReason: '只读白名单：javap 不允许' });
    const text = STRUCTURED.replace('"run:abc","bad",42', `"run:${realId}","run:made-up","bad",42`);
    d.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES ('m1','s1','assistant',?)").run(text);
    const res = writeSubagentResult(d as never, 's1', { finalText: text })!;
    const ctx = ctxOf(d, 's1');
    ok(!!res && res.verdict === 'pass', 'D12 子代理结论落库');
    eq(res.build, SRC_BUILD, 'D13 build 由 run_features 派生（无第二个字面量）');
    ok(res.limitations.some((x) => x.includes('被守卫拒绝')) && !res.limitations.some((x) => x.includes('无 shell 约束')),
      'D14 限定取自证据账、丢弃模型自述');
    eq(res.criteria[0]?.evidence_refs, [`run:${realId}`], 'D15 判据引用只留账上真有的编号');
    ok(Object.prototype.hasOwnProperty.call(ctx, 'attachments') && Object.prototype.hasOwnProperty.call(ctx, 'task_goal'),
      'D16 合并写不抹兄弟键');
    eq(readSubagentResult((d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('s1') as { context_json: string }).context_json)?.verdict,
      'pass', 'D17 读点回读同值');
  }
  {
    const d = mkSubDb();
    addSubTask(d, 's2', 'completed', '', { type: 'subagent', subagentType: 'verifier' });
    d.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES ('m2','s2','assistant',?)")
      .run('我检查过了，应该没问题。');
    const res = writeSubagentResult(d as never, 's2')!;
    ok(res.verdict === 'unknown' && res.summary.includes('应该没问题'), 'D18 末条无 JSON ⇒ unknown + 原文摘要');
    eq(res.limitations.length, 0, 'D19 无失败台账 ⇒ 限定为空（不编造）');
  }
  {
    const d = mkSubDb();
    addSubTask(d, 'n1', 'completed', '', { type: 'task' });
    ok(writeSubagentResult(d as never, 'n1', { finalText: STRUCTURED }) === null && !(SUBAGENT_RESULT_KEY in ctxOf(d, 'n1')),
      'D20 非子代理不写结论');
    ok(!isSubagentTaskContext('not-json') && isSubagentTaskContext(JSON.stringify({ type: 'subagent' })), 'D21 类型判据坏 JSON 不抛');
  }
  {
    const d = mkSubDb();
    addSubTask(d, 'c1', 'paused', '', { keep: 1 });
    ok(mergeTaskContext(d as never, 'c1', { add: 2, absent: undefined }) === true, 'D22 合并写成功');
    const c = ctxOf(d, 'c1');
    ok(c.keep === 1 && c.add === 2 && !('absent' in c), 'D23 合并保留旧键、跳过 undefined');
    d.prepare("UPDATE wa_tasks SET context_json = 'not-json' WHERE id = 'c1'").run();
    ok(mergeTaskContext(d as never, 'c1', { x: 1 }) === false
      && (d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('c1') as { context_json: string }).context_json === 'not-json',
      'D24 坏账不当底座（原样保留）');
    eq(applyContextPatch({ a: 1 }, { b: 2 }), { a: 1, b: 2 }, 'D25 纯合并形状');
  }
  {
    const d = mkSubDb();
    addSubTask(d, 'P', 'paused', '', {}, '2026-11-05 00:00:01');
    addSubTask(d, 'c1', 'completed', 'P', { type: 'subagent', subagentType: 'verifier' }, '2026-11-05 00:00:02');
    d.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES ('mc1','c1','assistant',?)").run(STRUCTURED);
    recordRuntimeEvidence(asBetter(d), { taskId: 'c1', tool: 'execute_command', command: 'javap -c X', ok: false, denyReason: '只读白名单：javap 不允许' });
    writeSubagentResult(d as never, 'c1', { finalText: STRUCTURED });
    addSubTask(d, 'c2', 'completed', 'P', { type: 'subagent' }, '2026-11-05 00:00:03');
    addSubTask(d, 'c3', 'completed', 'P', { completion_summary: '普通子任务完成' }, '2026-11-05 00:00:04');
    const briefs = buildChildBriefs(d as never, 'P');
    const b1 = briefs.find((b) => b.startsWith('c1｜')) || '';
    const b2 = briefs.find((b) => b.startsWith('c2｜')) || '';
    const b3 = briefs.find((b) => b.startsWith('c3｜')) || '';
    ok(b1.includes('结论 通过') && b1.includes('限定'), 'D26 父简报带结论与限定', b1);
    ok(b2.includes('未提供结构化结论'), 'D27 缺结论如实说（不补 pass）', b2);
    ok(!b3.includes('结论 ') && !b3.includes('未提供结构化结论') && b3.split('｜').length === 5,
      'D28 普通子任务保持五段形状', b3);
    eq(verdictLabelOf('unknown'), '未判明', 'D29 词表：unknown 用中性词');
  }
  {
    const d = mkSubDb();
    addSubTask(d, 'P2', 'executing', '', {}, '2026-11-05 00:00:01');
    addSubTask(d, 'c1', 'completed', 'P2', { type: 'subagent' }, '2026-11-05 00:00:02');
    d.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES ('mh1','c1','assistant',?)").run(STRUCTURED);
    writeSubagentResult(d as never, 'c1', { finalText: STRUCTURED });
    addSubTask(d, 'c2', 'executing', 'P2', { type: 'subagent' }, '2026-11-05 00:00:03');
    const calls: Array<Record<string, unknown>> = [];
    const deps = {
      db: d, taskId: 'P2', projectId: 'p', ctx: {}, workingDir: '/tmp', ensureSkillsLoaded: async () => {},
      pauseTask: ((_db: unknown, o: Record<string, unknown>) => { calls.push(o); return { changed: true }; }) as never,
    };
    const aw = (resourceTools(deps as never) as unknown as { await_subagents: { execute: (a?: Record<string, unknown>) => Promise<string> } }).await_subagents;
    const waiting = JSON.parse(await aw.execute(undefined)) as {
      status?: string; count?: number; subagentResults?: Array<{ taskId: string; verdict: string; summary: string }>;
    };
    ok(waiting.status === 'waiting' && waiting.count === 1, 'D30 有在跑的子 ⇒ waiting/1');
    const hs = waiting.subagentResults ?? [];
    eq(hs.find((x) => x.taskId === 'c1')?.verdict, 'pass', 'D31 已到站子代理带结构化结论');
    ok(hs.find((x) => x.taskId === 'c2')?.verdict === 'unprovided'
      && hs.find((x) => x.taskId === 'c2')?.summary === '未提供结构化结论', 'D32 无结论 ⇒ unprovided + 人话');
    d.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = 'c2'").run();
    const none = JSON.parse(await aw.execute(undefined)) as { status?: string; subagentResults?: unknown[] };
    ok(none.status === 'nothing_to_wait' && (none.subagentResults?.length ?? 0) === 2, 'D33 无未完成子仍回传结论');
  }

  const ef = readCode(`${A}/src/main/core/exec-finalize.ts`);
  const efIdx = ef.indexOf('writeSubagentResult(db, taskId, { finalText: finalContent });');
  const efDone = ef.indexOf("UPDATE wa_tasks SET status = 'completed'");
  ok(efIdx > efDone && efDone >= 0, 'D34 run_close：先标完成、后落结论');
  const ae = readCode(`${A}/src/main/core/agent-executor.ts`);
  ok(ae.indexOf('writeSubagentResult(db, taskId, { finalText: finalContent });') > ae.indexOf("UPDATE wa_tasks SET status = 'completed'"),
    'D35 finalize 收口同一顺序');
  const ipc = readCode(`${A}/src/main/ipc/project.ipc.ts`);
  ok(ipc.includes('readSubagentResult') && ipc.includes('isSubagentTaskContext') && ipc.includes('out.subagentResult = sub'),
    'D36 详情 IPC 投影结构化结论');
  const page = readCode(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  ok(page.includes('c.isSubagent') && page.includes('子代理结论') && page.includes('未提供结构化结论'),
    'D37 子任务卡显示结论/摘要/限定');
  const ai = readCode(`${A}/src/main/core/jobs/ai-task.ts`);
  ok(ai.includes('const subPart = isSubagentTaskContext(k.context_json)'), 'D38 父简报结论段只给子代理补');
}

/* ═══ E 形态兜底 ═══════════════════════════════════════════════════════════ */
function sectionE(): void {
  console.log('\n【E】形态兜底：先问能力需求，再定形态');
  const SPEC_TITLE = '后台好像是没有把 出生日期 和 居住地址 中的 省、市、区 进行保存';
  const SPEC_DESC = '后台处理类 /Users/yangmujiang/works/flying/总经理室/银发/代码/yishouli_backend/openapi/src/main/java/com/sfi/yishouli/auth/cmdservice/AuthService.java\n没有把 出生日期 和 居住地址 中的 省、市、区 保存到 ElderlyEntity 实体中';
  const SPEC = `${SPEC_TITLE} ${SPEC_DESC}`;

  const a = capabilityNeedsOf('重启后端并运行测试');
  eq([a.shell, a.write, a.network], [true, false, false], 'E1 运行/重启/测试 ⇒ shell，不误判 write');
  const b = capabilityNeedsOf('修改 AuthService.java 并保存');
  eq([b.write, b.shell], [true, true], 'E2 修改/保存 ⇒ write，路径里的 java 认作 shell');
  const c = capabilityNeedsOf('调用这个 HTTP 接口抓取数据');
  eq([c.network, c.write], [true, false], 'E3 http/接口/抓取 ⇒ network');

  ok(SPEC.length > 200, 'E4 标本真长（>200 字）');
  const d1 = classifyArchetypeDetailed(SPEC);
  eq([d1.archetype, d1.source], ['code', 'fallback'], 'E5 长题面 + 写文件 + 运行 ⇒ code / fallback');
  ok(/写文件/.test(d1.reason) && /运行/.test(d1.reason), 'E6 理由点名写文件与运行能力', d1.reason);
  const shellOnly = ('重启后端服务并运行测试，观察日志是否正常。').repeat(10);
  const d2 = classifyArchetypeDetailed(shellOnly);
  eq([d2.archetype, d2.source], ['analysis', 'fallback'], 'E7 只要运行不写 ⇒ analysis');
  ok(/运行/.test(d2.reason), 'E8 理由点名运行能力', d2.reason);
  ok(ARCHETYPE_TOOL_CATEGORIES.analysis.includes('shell'), 'E9 analysis 档真含 shell（升级不是空话）');
  const plain = '甲乙丙丁戊己庚辛壬癸'.repeat(21);
  const d3 = classifyArchetypeDetailed(plain);
  eq(d3.archetype, 'research', 'E10 无 shell/write 信号的长题面仍 research');
  ok(!/需要/.test(d3.reason), 'E11 未被升级分支接走', d3.reason);
  const plan = '优化方案：梳理本轮改进项并写入 plans/improve/x.md';
  const d4 = classifyArchetypeDetailed(plan);
  eq([d4.archetype, d4.source], ['research', 'keyword'], 'E12 计划+产出 .md 仍走既有词表');
  ok(/规划\/调研/.test(d4.reason), 'E13 理由保持既有词表原文', d4.reason);

  const m = resolvePinnedArchetype(JSON.stringify({ archetype_override: 'code' }));
  ok(!!m && m.archetype === 'code' && m.source === 'manual', 'E14 手动覆盖最高优先');
  const n = resolvePinnedArchetype(JSON.stringify({ node_archetype: 'configuration' }));
  ok(!!n && n.source === 'node', 'E15 节点指定次之');
  ok(resolvePinnedArchetype(JSON.stringify({ archetype_override: 'nope' })) === null, 'E16 非法覆盖值当没写');

  const ae = readCode(`${A}/src/main/core/agent-executor.ts`);
  ok(ae.includes('capabilityNeedsOf(`${title} ${description}`)') && ae.includes('能力需求与形态不一致'),
    'E17 起跑处按能力需求留痕（只记日志）');
  ok(ae.includes('taskCtx.archetype_source = decision.source;') && ae.includes('taskCtx.archetype_reason = decision.reason;'),
    'E18 升级来源与理由走既有落账点');
  ok(!/archetype\s*=\s*needs\./.test(ae) && !/needs\.shell\s*\?/.test(ae), 'E19 执行器不二次改形态');
  const ta = readCode(`${A}/src/main/core/task-archetype.ts`);
  ok(ta.includes('export function capabilityNeedsOf') && ta.includes('need.shell && need.write') && ta.includes('if (need.shell)'),
    'E20 能力升级只在长度兜底一支、映射一处');
  const page = readCode(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  ok(page.includes("archetypeSource === 'fallback' && (task.status === 'paused' || task.status === 'failed')")
    && page.includes('切换任务形态') && page.includes('仅影响后续运行，不改历史账'),
    'E21 兜底形态 + 暂停/失败 ⇒ 提示与覆盖入口');
}

/* ═══ F 工具面 ═════════════════════════════════════════════════════════════ */
async function sectionF(): Promise<void> {
  console.log('\n【F】工具面：只读内省放行，危险命令仍拒，构建不计数');
  for (const cmd of ['javap -c -p Foo', 'stat package.json', 'shasum -a 256 README.md', 'md5sum a.txt', 'file src/index.ts',
    'jar tf app.jar', 'jar --list app.jar', 'unzip -l app.zip']) {
    ok(validateReadonlyBashCommand(cmd).ok, `F1 放行只读内省：${cmd}`);
  }
  ok(!SAFE_READONLY_COMMANDS.has('jar') && !SAFE_READONLY_COMMANDS.has('unzip'), 'F2 集合不收录会写盘的 jar/unzip');
  ok(isReadonlyIntrospectionCommand('jar tf x.jar') && !isReadonlyIntrospectionCommand('jar cf out.jar a.class'),
    'F3 子命令判据认列表、拒创建');
  ok(!isReadonlyIntrospectionCommand('unzip x.zip') && !isReadonlyIntrospectionCommand('unzip -o x.zip'),
    'F4 裸 unzip / -o 解压不放行');

  {
    const v = validateReadonlyBashCommand('rm -rf /tmp/x');
    ok(!v.ok && (v as { payload: { deny_kind: string } }).payload.deny_kind === 'destructive', 'F5 破坏性命令拒且带 deny_kind');
    const w = validateReadonlyBashCommand('jar cf out.jar a.class');
    ok(!w.ok && (w as { payload: { deny_kind: string } }).payload.deny_kind === 'not_in_whitelist', 'F6 非白名单子命令带类别');
    const x = validateReadonlyBashCommand('cat a\nrm b');
    ok(!x.ok && (x as { payload: { deny_kind: string } }).payload.deny_kind === 'illegal_char', 'F7 非法字符带类别');
    const y = evaluateMultiSegment('ls && rm -rf /tmp/x', 'execute_command', ROOT);
    ok(!y.ok && y.payload.deny_kind === 'destructive', 'F8 多段逐段判、整串拒');
  }

  for (const cmd of ['mvn -q compile', 'gradle build', 'npm run build', 'pnpm build', 'javac A.java']) {
    const head = cmd.split(/\s+/)[0]!;
    ok(BUILD_RUN_COMMANDS.has(head), `F9 构建命令收录：${head}`);
    ok(!isExplorationCall('bash', { command: cmd }) && !countsTowardToolQuota('bash', { command: cmd }),
      `F10 构建不占探索额度：${cmd}`);
  }
  ok(isExplorationCall('bash', { command: 'ls -la' }) && countsTowardToolQuota('bash', { command: 'ls -la' }),
    'F11 只读列举仍计探索');
  ok(isExplorationCall('bash', { command: 'javap -c Foo' }) && isReadOnlyProbeCommand({ command: 'stat a.txt' }),
    'F12 内省探测属只读探测');
  ok(isExplorationCall('execute_command', { command: 'python3 -m py_compile a.py' })
    && !countsTowardToolQuota('execute_command', { command: 'python3 -m py_compile a.py' }), 'F13 既有 py_compile 语义不变');

  // 逐调用判定：探索调用拒且带类别；收尾命令原样转交（不是整把工具一刀切掉）
  const capped = makeNonExplorationCappedTool('bash', { execute: async () => 'DELEGATED' }, '探索配额耗尽');
  const denyRaw = await capped.execute({ command: 'ls -la' }, {});
  const denyPayload = JSON.parse(String(denyRaw)) as { error?: string; deny_kind?: string };
  eq([denyPayload.error, denyPayload.deny_kind], ['探索配额耗尽', 'exploration_limit'], 'F14 探索调用被拒：文案沿用、类别为 exploration_limit');
  eq(String(await capped.execute({ command: 'pnpm build' }, {})), 'DELEGATED', 'F14b 构建命令原样转交（不被配额误杀）');
  const execStep = readCode(`${A}/src/main/core/exec-step.ts`);
  ok(execStep.includes('const capNonExploration = (k: string, reason: string): void =>') && execStep.includes("denyKind: 'exploration_limit'")
    && execStep.includes('recordRuntimeEvidence(d.db, {'), 'F15 逐调用拒绝落证据且带类别');
  const reg = readCode(`${A}/src/main/core/subagent-registry.ts`);
  ok(reg.includes('命令被守卫拒绝时，须在结论中逐条列出拒绝原因（工具、命令、deny_kind）')
    && reg.includes('不得概括为「无 shell/无权限」'), 'F16 验证者提示词要求逐条列拒绝原因');
  void capped;
}

/* ═══ G 判据候选 ═══════════════════════════════════════════════════════════ */
function sectionG(): void {
  console.log('\n【G】判据候选：有依据才有候选，采用后才成判据');
  {
    const s = suggestCriteriaFromText('写方案', '产出 plans/improve/a.md 与 docs/b.json');
    ok(s.includes('产出文件 `plans/improve/a.md` 存在且非空'), 'G1 文本路径字面量 ⇒ 产出文件候选');
    ok(s.includes('产出文件 `docs/b.json` 存在且非空'), 'G2 多个路径各自成条');
    ok(suggestCriteriaFromText('任务', '无路径', ['out/report.md']).includes('产出文件 `out/report.md` 存在且非空'),
      'G3 deliverableNames 有则产出');
    eq(suggestCriteriaFromText('任务', '无路径'), [], 'G4 无依据 ⇒ 空（不凑数）');
    eq(suggestCriteriaFromText('随手记一则', '无路径、无产出物', [null, '  ']), [], 'G5 空名/空白名不算依据');
    eq(suggestCriteriaFromText('x', 'a.md b.md c.md d.md e.md f.md g.md').length, CRITERIA_SUGGESTION_LIMIT,
      'G6 候选最多 5 条');
    eq(suggestCriteriaFromText('x', 'a.md a.md a.md').length, 1, 'G7 同一条只落一次');
    ok(suggestCriteriaFromText('构建', '请运行 `pnpm build` 并确认').includes('命令 `pnpm build` 退出码为 0'),
      'G8 反引号内已知命令 ⇒ 命令候选');
    eq(suggestCriteriaFromText('x', '运行 pnpm build'), [], 'G9 未显式写出的命令不猜');
    ok(suggestCriteriaFromText('接口', '接口返回包含「success」即通过').includes('页面/接口返回包含 `success`'),
      'G10 结果语境 + 引号关键字 ⇒ 结果候选');
    eq(suggestCriteriaFromText('x', '返回包含 success（无引号）'), [], 'G11 无引号关键字 ⇒ 不猜');
  }
  eq(readProposedAcceptance(null), [], 'G12 无上下文 ⇒ 空');
  eq(readProposedAcceptance('not json'), [], 'G13 坏 JSON ⇒ 空（不猜）');
  eq(readProposedAcceptance(JSON.stringify({ proposed_acceptance: 'x' })), [], 'G14 非数组 ⇒ 空');
  eq(readProposedAcceptance(JSON.stringify({ proposed_acceptance: [' 产出文件 `a.md` 存在且非空 ', '', 42] })),
    ['产出文件 `a.md` 存在且非空', '42'], 'G15 逐项 trim/过滤并保留有值项');
  eq(PROPOSED_ACCEPTANCE_KEY, 'proposed_acceptance', 'G16 键名单一真源');

  {
    const withDel = proposeAcceptanceCriteria({
      title: '写方案', description: '请运行 `pnpm build`',
      deliverables: [{ name: 'a', file_path: 'out/a.md' }], pathExists: () => true,
    });
    ok(withDel.proposed.some((c) => c.includes('产出物已落盘')), 'G17 既有证据规则仍产出');
    ok(!withDel.proposed.some((c) => c.includes('pnpm build')), 'G18 既有产出时不掺入命令候选');
    const noEvidence = proposeAcceptanceCriteria({ title: '构建', description: '请运行 `pnpm build`', deliverables: [], pathExists: () => true });
    const cmd = noEvidence.checked.find((c) => c.criterion === '命令 `pnpm build` 退出码为 0');
    ok(!!cmd, 'G19 双无证据 ⇒ 采用文本候选');
    eq(cmd?.passed, false, 'G20 候选不得记 passed（未核实）');
    ok(String(cmd?.note).includes('未执行核实'), 'G21 候选注记如实说明未核实');
    eq(proposeAcceptanceCriteria({ title: '随手记一则', description: '无路径、无产出物', deliverables: [] }).proposed, [],
      'G22 仍无依据 ⇒ 空（不凑数）');
  }
  {
    const d = new DatabaseSync(':memory:');
    d.exec('CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT)');
    d.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('t1', JSON.stringify({
      attachments: [{ name: 'a.png' }], task_goal: { goal: 'g' }, scheme_ref: { plan_task_id: 'p' },
    }));
    ok(mergeTaskContext(d as never, 't1', { [PROPOSED_ACCEPTANCE_KEY]: ['c1'] }), 'G23 合并写成功');
    const ctx = ctxOf(d, 't1');
    eq(ctx[PROPOSED_ACCEPTANCE_KEY], ['c1'], 'G24 新键落库');
    ok(Array.isArray(ctx.attachments) && ctx.attachments.length === 1 && (ctx.task_goal as { goal?: string })?.goal === 'g'
      && (ctx.scheme_ref as { plan_task_id?: string })?.plan_task_id === 'p', 'G25 兄弟键一个不丢');
    d.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify({ [PROPOSED_ACCEPTANCE_KEY]: ['c2'] }), 't1');
    ok(ctxOf(d, 't1').attachments === undefined, 'G26 反证：裸覆写确实丢附件（合并写口必要）');
  }
  const ipc = readCode(`${A}/src/main/ipc/project.ipc.ts`);
  ok(ipc.includes("ipcMain.handle('task:suggestCriteria'") && ipc.includes('return { data: suggestCriteriaFromText(title, description) };'),
    'G27 实时候选出口注册');
  ok(ipc.includes('suggestedCriteria = String(taskRow.acceptance_criteria ?? \'\').trim()'), 'G28 已有用户判据时详情候选为空');
  ok(ipc.includes('suggestedCriteria,') && ipc.includes('proposedAcceptance,'), 'G29 详情回执带候选与引擎登记');
  const control = readCode(`${A}/src/main/core/tools/control.ts`);
  ok(control.includes('mergeTaskContext(db, id, { [PROPOSED_ACCEPTANCE_KEY]: suggestedCriteria })') && control.includes('criteriaHint:'),
    'G30 create_task 经合并写口登记候选并告知待采用');
  const res = readCode(`${A}/src/main/core/tools/resource.ts`);
  ok(res.includes('mergeTaskContext(db, id, { [PROPOSED_ACCEPTANCE_KEY]: suggestedCriteria })') && res.includes('criteriaHint:'),
    'G31 spawn_subagent 同口径登记');
  const tasksPage = readCode(`${A}/renderer/src/pages/TasksPage.tsx`);
  ok(tasksPage.includes('tasksApi.suggestCriteria(newTask.title, newTask.description)')
    && tasksPage.includes('const adoptCriteria = (items: string[])') && tasksPage.includes('全部采用'),
    'G32 建单弹窗实时候选 + 采用入口');
  const detail = readCode(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  ok(detail.includes('setSuggestedCriteria(taskData.suggestedCriteria || [])') && detail.includes('handleSaveCriteria(task.id, c)'),
    'G33 详情加载候选并可逐条采用');
  const api = readCode(`${A}/renderer/src/lib/ipc.ts`);
  ok(api.includes("ipcCall<string[]>('task:suggestCriteria'"), 'G34 renderer SDK 通道名一致');
}

/* ═══ H 同名去重 ═══════════════════════════════════════════════════════════ */
type TaskRow = { id: string; title: string; status: string; context_json: string | null };
function makeSpawnTool() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE wa_tasks (
    id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT, status TEXT,
    priority INTEGER, context_json TEXT, parent_task_id TEXT, source TEXT,
    depends_on TEXT, acceptance_criteria TEXT, created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec('CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT, payload TEXT, status TEXT)');
  (db as unknown as { transaction: unknown }).transaction = (fn: () => unknown) => () => fn();
  db.prepare(`INSERT INTO wa_tasks (id, project_id, title, description, status, priority, context_json, parent_task_id, source, depends_on, acceptance_criteria)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('parent', 'p1', '父任务', '父', 'running', 1, '{"depth":0}', null, 'agent', '', '');
  const tools = resourceTools({ db, taskId: 'parent', projectId: 'p1', workingDir: '/tmp', ensureSkillsLoaded: async () => {}, ctx: {} } as never) as unknown as {
    spawn_subagent: { execute: (a: Record<string, unknown>) => Promise<string> };
  };
  const spawn = async (taskTitle: string, extra: Record<string, unknown> = {}) =>
    JSON.parse(await tools.spawn_subagent.execute({ prompt: '产出 out/r.md', taskTitle, ...extra }) as string) as Record<string, unknown>;
  const rows = () => db.prepare("SELECT id, title, status, context_json FROM wa_tasks WHERE parent_task_id = 'parent' ORDER BY rowid ASC").all() as unknown as TaskRow[];
  const jobs = () => (db.prepare('SELECT COUNT(*) c FROM wa_jobs').get() as { c: number }).c;
  const setStatus = (id: string, status: string) => db.prepare('UPDATE wa_tasks SET status = ? WHERE id = ?').run(status, id);
  return { db, spawn, rows, jobs, setStatus };
}

async function sectionH(): Promise<void> {
  console.log('\n【H】同名去重：在途复用、终态编号、上限拒绝');
  eq(normalizeSubagentTitle('[Sub] 写报告'), '写报告', 'H1 去前缀');
  eq(normalizeSubagentTitle('[Sub] 写报告（第 2 次）'), '写报告', 'H2 去全角次数后缀');
  eq(normalizeSubagentTitle('[Sub] 写报告(第3次)'), '写报告', 'H3 去半角次数后缀');
  eq(normalizeSubagentTitle('  写   报告  '), '写 报告', 'H4 折叠空白并 trim');
  eq(normalizeSubagentTitle(null), '', 'H5 空值归一为空');
  eq(SUBAGENT_REPEAT_LIMIT, 3, 'H6 上限单一常量=3');

  {
    const t = makeSpawnTool();
    const first = await t.spawn('写报告');
    ok(typeof first.subTaskId === 'string' && first.status === 'dispatched', 'H7 首次派发落行');
    eq([t.rows().length, t.jobs()], [1, 1], 'H8 首派一行一作业');
    const second = await t.spawn('写报告');
    eq([second.reused, second.taskId, second.status], [true, first.subTaskId, 'pending'], 'H9 同名在途 ⇒ reused 指向既有行');
    eq(second.subTaskId, undefined, 'H10 复用时不再返回新 subTaskId');
    eq([t.rows().length, t.jobs()], [1, 1], 'H11 复用时不再落行/入队');
    eq((await t.spawn('  写报告  ')).taskId, first.subTaskId, 'H12 空白差异视为同题面');
    eq((await t.spawn('写报告（第 9 次）')).taskId, first.subTaskId, 'H13 手写次数后缀归一为同题面');
  }
  {
    const t = makeSpawnTool();
    const a = await t.spawn('写报告');
    t.setStatus(String(a.subTaskId), 'completed');
    const b = await t.spawn('写报告');
    ok(b.subTaskId !== a.subTaskId && b.repeatIndex === 2, 'H14 终态后重派 ⇒ 新行、序号 2');
    const rowB = t.rows().find((r) => r.id === b.subTaskId)!;
    eq(rowB.title, '[Sub] 写报告（第 2 次）', 'H15 标题带次数');
    eq(JSON.parse(rowB.context_json || '{}').subagent_repeat_index, 2, 'H16 上下文记重复序号');
    t.setStatus(String(b.subTaskId), 'failed');
    const c = await t.spawn('写报告');
    eq(c.repeatIndex, 3, 'H17 第三次 ⇒ 序号 3');
    eq(t.rows().length, 3, 'H18 三次终态共三行');
    t.setStatus(String(c.subTaskId), 'failed');
    eq((await t.spawn('写报告')).error, 'duplicate_subagent_limit', 'H19 第 4 次 ⇒ 拒（上限 3）');
    eq(t.rows().length, 3, 'H20 被拒时不落行');
    const forced = await t.spawn('写报告', { allow_duplicate: true });
    eq([forced.repeatIndex, t.rows().length], [4, 4], 'H21 allow_duplicate 显式覆盖上限');
  }
  {
    const t = makeSpawnTool();
    const a = await t.spawn('写报告');
    const other = await t.spawn('写别的');
    ok(other.subTaskId && other.subTaskId !== a.subTaskId, 'H22 不同题面各成一行');
    t.setStatus(String(a.subTaskId), 'completed');
    const b = await t.spawn('写报告');
    t.setStatus(String(b.subTaskId), 'completed');
    const c = await t.spawn('写报告');
    t.setStatus(String(c.subTaskId), 'completed');
    t.db.prepare(`INSERT INTO wa_tasks (id, project_id, title, description, status, priority, context_json, parent_task_id, source, depends_on, acceptance_criteria)
      VALUES ('live','p1','[Sub] 写报告','x','running',2,'{}','parent','agent','','')`).run();
    const re = await t.spawn('写报告');
    eq([re.reused, re.taskId], [true, 'live'], 'H23 有在途 ⇒ 复用优先于上限判定');
  }
  {
    const t = makeSpawnTool();
    const a = await t.spawn('产出报告');
    ok(Array.isArray(a.suggestedCriteria) && a.suggestedCriteria.some((c: string) => c.includes('out/r.md')),
      'H24 新派仍登记判据候选');
    const before = (t.rows()[0]!.context_json || '');
    const re = await t.spawn('产出报告');
    ok(re.reused === true && t.rows()[0]!.context_json === before, 'H25 复用时上下文一字未动');
  }
  const res = readCode(`${A}/src/main/core/tools/resource.ts`);
  ok(res.includes('export function normalizeSubagentTitle') && res.includes('db.transaction('), 'H26 归一化具名纯函数、查建同事务');
  ok(res.includes("error: 'duplicate_subagent_limit'") && res.includes("allow_duplicate: { type: 'boolean'"),
    'H27 上限拒绝可辨、覆盖参数入 schema');
  const page = readCode(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  ok(page.includes('已存在同名在途子任务，已复用（未重复派发）'), 'H28 父会话显示复用说明');
}

/* ═══ I 归档可见 ═══════════════════════════════════════════════════════════ */
type DraftRow = Record<string, unknown>;
function draftTitle(row: DraftRow): string | null {
  const r = buildArchiveDraft(row);
  return r.ok ? r.draft.title : null;
}
function draftParent(row: DraftRow): string | null {
  const r = buildArchiveDraft(row);
  return r.ok ? r.draft.parent_task_id : 'NOT_OK';
}
function sectionI(): void {
  console.log('\n【I】归档可见：理由上屏、原题面新建不复活');
  const archivedRow = {
    id: 'task-1', project_id: 'proj-1', status: 'archived',
    title: '[Sub] 核对盘口数据', description: '原描述\n第二行', acceptance_criteria: '1) 有数\n2) 有结论',
    parent_task_id: 'parent-9',
  };
  const r1 = buildArchiveDraft(archivedRow);
  ok(r1.ok === true, 'I1 已归档行出草稿');
  if (r1.ok) {
    eq(r1.draft.title, '核对盘口数据', 'I2 标题去 [Sub] 前缀');
    eq(r1.draft.description, '原描述\n第二行', 'I3 描述原样（含换行）');
    eq(r1.draft.acceptance_criteria, '1) 有数\n2) 有结论', 'I4 验收判据原样');
    eq([r1.draft.projectId, r1.draft.parent_task_id, r1.draft.sourceTaskId], ['proj-1', 'parent-9', 'task-1'], 'I5 项目/父级/来源取自原行');
  }
  eq(draftTitle({ ...archivedRow, title: '[sub] 小写前缀也应剥掉' }), '小写前缀也应剥掉', 'I6 [sub] 前缀大小写不敏感');
  eq(draftTitle({ ...archivedRow, title: '同名（第 3 次）' }), '同名（第 3 次）', 'I7 重复次数后缀保留（有信息量）');
  eq(draftParent({ ...archivedRow, parent_task_id: null }), null, 'I8 根任务父级为 null');
  eq(draftParent({ ...archivedRow, parent_task_id: '' }), null, 'I9 空父级归一为 null');
  const r6 = buildArchiveDraft({ ...archivedRow, status: 'completed' });
  ok(r6.ok === false && r6.code === 'NOT_ARCHIVED', 'I10 非归档态拒出草稿');
  const r8 = buildArchiveDraft(undefined);
  ok(r8.ok === false && r8.code === 'NOT_FOUND', 'I11 无行如实 NOT_FOUND');

  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT,
    acceptance_criteria TEXT, parent_task_id TEXT, status TEXT, context_json TEXT, updated_at TEXT)`);
  d.prepare('INSERT INTO wa_tasks VALUES (?,?,?,?,?,?,?,?,?)').run('t-arch', 'p-1', '[Sub] 写报告', '描述', '判据', null, 'archived',
    JSON.stringify({ archived_snapshot: { archived_at: '2026-11-05 01:02:03', archive_reason: '验收未判' }, archive_reason: '验收未判', attachments: [{ name: 'a.txt' }] }),
    '2026-11-05 01:02:03');
  const before = d.prepare('SELECT * FROM wa_tasks WHERE id = ?').get('t-arch') as Record<string, unknown>;
  const row = d.prepare('SELECT id, project_id, title, description, acceptance_criteria, parent_task_id, status FROM wa_tasks WHERE id = ?').get('t-arch');
  const dr = buildArchiveDraft(row as Record<string, unknown>);
  const after = d.prepare('SELECT * FROM wa_tasks WHERE id = ?').get('t-arch') as Record<string, unknown>;
  ok(dr.ok === true, 'I12 真库行出草稿');
  eq(after, before, 'I13 出草稿后原行逐字段不变');
  eq(after.status, 'archived', 'I14 原任务仍 archived（终态不可覆写）');
  ok(String(after.context_json).includes('archived_snapshot'), 'I15 原上下文快照未被改写');

  const ipc = readCode(`${A}/src/main/ipc/project.ipc.ts`);
  ok(/ipcMain\.handle\('task:archiveDraft'/.test(ipc), 'I16 main 注册 task:archiveDraft');
  const draftSeg = handlerBody(ipc, 'task:archiveDraft');
  ok(/SELECT id, project_id, title, description, acceptance_criteria, parent_task_id, status FROM wa_tasks WHERE id = \?/.test(draftSeg),
    'I17 草稿只读 SELECT');
  ok(!/UPDATE|DELETE|INSERT/.test(draftSeg), 'I18 草稿处理器不含任何写语句');
  ok(draftSeg.includes('buildArchiveDraft(row as Record<string, unknown> | undefined)'), 'I19 处理器引 core 具名函数（不内联手拼）');
  ok(ipc.includes("import { buildArchiveDraft } from '../core/archive-draft.js'"), 'I20 core 函数同一处引用');
  ok(ipc.includes('out.archiveReason = archivedReasonOf(ctxJson) || null;') && ipc.includes('out.archivedAt = archivedSnapshotOf(ctxJson)?.archived_at ?? null;'),
    'I21 子任务投影带归档因由与时刻');
  ok(ipc.includes('delete out.context_json'), 'I22 原始 context_json 不出进程边界');

  const lib = readCode(`${A}/renderer/src/lib/ipc.ts`);
  ok(/archiveDraft: \(id: string\) =>[\s\S]*?'task:archiveDraft'/.test(lib), 'I23 renderer SDK 通道名一致');
  const page = readCode(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  ok(page.includes('setArchiveReason(taskData.archiveReason ?? null)') && page.includes('setArchivedAt(taskData.archivedAt ?? null)'),
    'I24 首载落归档因由/时刻');
  ok(page.includes('setArchiveReason(data.archiveReason ?? null)') && page.includes('setArchivedAt(data.archivedAt ?? null)'),
    'I25 切任务同样落归档因由/时刻');
  ok(page.includes('归档理由：') && page.includes('未填写理由'), 'I26 头部显示理由，缺失写「未填写理由」');
  ok(page.includes('c.archiveReason ? c.archiveReason : <span className="text-gray-400">未填写理由</span>'), 'I27 归档子卡显示理由（缺失占位）');
  // zx_20261107_1 B9：时刻格式化收敛到 `lib/format` 的 `formatTimeOrRaw`（缺时刻时不印"Invalid Date"）。
  //   "归档子卡显示归档时间"这一判据不变，只随真源改名。
  ok(page.includes('formatTimeOrRaw(c.archivedAt)'), 'I28 归档子卡显示归档时间');
  ok(page.includes('以原题面新建') && page.includes('const d = await tasks.archiveDraft(task.id);'), 'I29 按钮草稿取自服务端');
  ok(page.includes('原任务仍为已归档'), 'I30 回执明说原任务未被复活');
  ok(page.includes("const projectId = createCtx.mode === 'archive' && createCtx.projectId ? createCtx.projectId : task.project_id;"),
    'I31 建单项目按来路取');
  ok(page.includes("const parentId = createCtx.mode === 'archive' ? (createCtx.parentTaskId ?? undefined) : task.id;"),
    'I32 以原题面新建挂原父级，不挂归档任务下');
  const resumeLines = page.split('\n').filter((l) => l.includes('<button') && /\bhandleResume\(/.test(l));
  ok(resumeLines.length > 0 && !resumeLines.some((l) => l.includes("'archived'")), 'I33 归档态无恢复按钮');
  ok(!/status==='archived'[^\n]*handleResume/.test(page), 'I34 归档态不接任何 resume 调用');
}

/* ═══ J 静态钉与套件自检 ═══════════════════════════════════════════════════ */
function sectionJ(): void {
  console.log('\n【J】接线静态钉与套件自检');
  checkBuildPins(ok, { distDir: path.join(ROOT, `${A}/dist`) });
  ok(ROUND_RE.test(SELF_ROUND), 'J-1 本轮标识由载体自身派生且格式合法', SELF_ROUND);
  ok(fs.existsSync(path.join(ROOT, `plans/improve/${SELF_ROUND}.md`)), `J-2 本轮方案在册：plans/improve/${SELF_ROUND}.md`);
  // 原为 `SRC_BUILD === SELF_ROUND`——只在"本轮"成立、下一轮必红的哑雷（同 rr_zx_20261018_1 R-76b）。
  //   改由载体自身派生后做方向性比较：源码 build 只许**不早于**本套件轮次。
  eq(roundOrd(SRC_BUILD) >= roundOrd(SELF_ROUND), true,
    'J-3 源码 build 不早于本套件轮次（开新轮只改源码一处，本钉随轮次前移仍成立）', SRC_BUILD);

  const ipc = readCode(`${A}/src/main/ipc/project.ipc.ts`);
  ok(ipc.includes('archivedSnapshot: archivedSnap,') && ipc.includes('archiveReason: archivedReasonOf(ctxJson) || null,')
    && ipc.includes('archivedAt: archivedSnap?.archived_at ?? null,') && ipc.includes('suggestedCriteria,')
    && ipc.includes('proposedAcceptance,') && ipc.includes('runtimeEvidence: listRuntimeEvidence(db, id, 50),'),
    'J-4 详情 IPC 六个新字段按名落座（非仅出现字串）');
  const page = readCode(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  ok(['tasks.archiveDraft(', 'tasks.suggestCriteria(', 'setRuntimeEvidence(', 'setSuggestedCriteria(', 'setArchiveReason(']
    .every((s) => page.includes(s)), 'J-5 renderer 侧调用在册');
  const lib = readCode(`${A}/renderer/src/lib/ipc.ts`);
  ok(lib.includes("'task:archiveDraft'") && lib.includes("'task:suggestCriteria'"), 'J-6 renderer SDK 两个新通道在册');

  const control = readCode(`${A}/src/main/core/tools/control.ts`);
  const res = readCode(`${A}/src/main/core/tools/resource.ts`);
  const sub = readCode(`${A}/src/main/core/subagent-result.ts`);
  ok(control.includes('mergeTaskContext(db, id, { [PROPOSED_ACCEPTANCE_KEY]: suggestedCriteria })')
    && res.includes('mergeTaskContext(db, id, { [PROPOSED_ACCEPTANCE_KEY]: suggestedCriteria })')
    && sub.includes('mergeTaskContext(db, taskId, { [SUBAGENT_RESULT_KEY]: result })'),
    'J-7 新增上下文字段一律经合并写口');
  ok(!/UPDATE wa_tasks SET context_json = \?/.test(sub), 'J-8 结论模块不裸覆写 context_json');

  const selfLines = stripKeepingLines(fs.readFileSync(__filename, 'utf-8'));
  const dud = selfLines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /(?:eq\([^,)]*,\s*|===?\s*|!==?\s*)'zx_\d{8}(?:_\d+)?'/.test(line));
  ok(dud.length === 0, 'J-9 本套件无「只为下一轮」字面量', dud.map((x) => `${x.i + 1}:${x.line.trim()}`).join(' | '));

  const selfText = fs.readFileSync(__filename, 'utf-8');
  const badGlyphs = [0x2717, 0x2713].map((c) => String.fromCodePoint(c));
  ok(!badGlyphs.some((g) => selfText.includes(g)), 'J-10 本套件文案无失败/通过字形（全量汇总器按失败字形计数）');
  ok(/通过 \/ .*失败/.test(selfText), 'J-11 收尾行如实印出断言数（通过 / 失败）');
}

async function main(): Promise<void> {
  console.log(`rr_${SELF_ROUND} 受控回归（验：判卷要有据，归档要有账）`);
  sectionA();
  sectionB();
  sectionC();
  await sectionD();
  sectionE();
  await sectionF();
  sectionG();
  await sectionH();
  sectionI();
  sectionJ();
  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
}

void main()
  .then(() => process.exit(fail === 0 ? 0 : 1))
  .catch((e: unknown) => {
    console.error(`rr_${SELF_ROUND} 未捕获异常（复跑未跑完，不得读作通过）：`, e);
    console.log(`\nFAIL rr_${SELF_ROUND}: ${pass} 通过 / ${fail + 1} 失败\n`);
    process.exit(1);
  });
