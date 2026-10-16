/**
 * zx_20260911_3 受控复跑（「牌子对不上树」：关联须在整棵树上成立）。
 *
 * 本文件把 M1–M5 的临时探针（/tmp/probe_m1..m5.ts）**归并**为受控回归：
 *   M1 计划模式两处入口不再整体覆写 context（mergePlanModeContext：只补写、不重建）
 *   M2 子任务/子 agent 创建时**上溯祖先链**取 scheme_ref（继承在生产从未生效 E2 11/0 → 1）
 *   M3 事后关联**向下回填子树** + 匹配时**祖先优先**（②a′）+ 工具层三处「沉默错误」：
 *      search_content 单文件语义、bash 引号感知切分（白名单一字未动）、压缩前孤立代理净化
 *   M4 完成计数**如实分类**（空壳/失败不得冒名"全部完成"）
 *   M5 广度上限截断后「剩余 M」**补归口**（父自述 且 无卡 且 板上未落地）
 *
 * 断言两类（承 zx_20260911_2 §九 教训）：静态断言一律 `stripComments` 后再比对，防注释里关键词假阳性；
 * 行为断言动态 import **真实现**，并以**生产入参**（真库 df334d91 / 板 101ec358 的逐字快照，见下 PROD）
 * 为输入——断言全绿 ≠ 端到端成立，故判据必须在生产形态的树上验。
 *
 * 本文件不打开任何真库（真库只读/回填证据见 data/baseline_zx_20260911_3.json）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
import { engineSrc } from './lib/rr-engine-src.js';
import {
  buildChildContext, resolveAncestorSchemeRef, collectAncestorIds, collectSubtreeIds,
  backfillDescendantSchemeRef, milestoneFromTitle, resolveTaskMilestoneAutoLink, resolveTaskMilestoneLink,
  writeMilestoneDone, backfillBoardRemainderToSelf, classifyChildCompletion, childCompletionCheckLabel,
  milestoneBoardOwner, MAX_CHILD_BREADTH, type MilestoneChangedEvent,
} from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import {
  splitShellPipes, validateReadonlyBashCommand, sanitizeLoneSurrogates, searchPathForPattern, SAFE_READONLY_COMMANDS,
} from '../apps/worker-ant-desktop/src/main/core/tool-guards.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const rd = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const app = (rel: string) => rd(`${A}/${rel}`);
const EXE = 'src/main/core/agent-executor.ts';
const exe = stripComments(engineSrc());

// 生产入参：真库 df334d91（20260911-1 方案实施）与其方案板 101ec358 的**逐字**快照（回填前，2026-09-11）。
// 见 data/baseline_zx_20260911_3.json E6/E8 与 df334d91 的 ctx.plan。
const PROD = {
  projectId: 'fb4bf825-50fe-4e78-bfc0-573a10882d4b',
  planId: '101ec358-e2ab-4ea4-89bf-1bacb70ab1ac',
  implId: 'df334d91-1b23-4b39-b39b-e2a4bb55d16b',
  implTitle: '20260911-1 方案实施',
  planText: '关键路径 M0→M1→M2→M3→M4→M5→M6 串行。已按里程碑命名建立 5 个依赖子任务（受 create_task 上限 5 约束）：M0 基线固化、M1 F1+F3 出口收口、M2 F2+F4 止损临近收口+T+1 豁免、M3 F5 统一去重、M4 F6+F7 门禁⑳+僵尸import清理；M5 全量回归（新增 test_a20260911_1.py）与 M6 真实交易日验收因上限并入父任务执行。预估 ~3 工作日工作量，本轮在单上下文内高效串行完成 M0-M5 并做 M6 可执行验收部分，逐里程碑验证并回标注 plans/project/A_20260911_1.md，最后以用户署名 git 提交。',
  cards: [
    { id: 'e7a28f54-038e-4667-9403-a69b4d04177b', title: 'M0 基线固化（三处旁路快照 + 门禁/单测全绿）' },
    { id: '3f4a73c5-115d-4ea9-85dc-13f2af81f17a', title: 'M1 F1+F3 出口收口（drawdown / risk_monitor）' },
    { id: 'be198931-af44-4242-9e4a-ea7c6ea868e3', title: 'M2 F2+F4 止损临近收口 + T+1 建仓初期豁免' },
    { id: '281138bf-aaa8-4230-a4a3-a49475e83bfc', title: 'M3 F5 统一告警去重（收口到 push_gate 出口）' },
    { id: 'b236d669-81cf-4f87-bcdb-24f13b7cd5f6', title: 'M4 F6+F7 门禁⑳ + 僵尸 import 清理' },
    { id: 'cd41d445-42a8-4fe0-8992-a8457e73a1b3', title: '[Sub] 取回 A_20260911_1 实施所需的精确源码片段' },
  ],
};

/** 内存库（列与生产 schema 一致的最小集） */
function mkdb(): any {
  const db = new DatabaseSync(':memory:') as any;
  db.exec(`
    CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT, parent_task_id TEXT, status TEXT, context_json TEXT, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_plan_milestones (
      id TEXT PRIMARY KEY, project_id TEXT, plan_task_id TEXT NOT NULL, milestone TEXT NOT NULL,
      status TEXT DEFAULT 'pending', implemented_by_task_id TEXT, updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}
const addTask = (db: any, id: string, title: string, parent: string | null, project = 'P', status = 'completed', ctx: any = {}, desc = '') =>
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, description, parent_task_id, status, context_json) VALUES (?,?,?,?,?,?,?)')
    .run(id, project, title, desc, parent, status, JSON.stringify(ctx));
const addMs = (db: any, planTaskId: string, milestone: string, project = 'P') =>
  db.prepare('INSERT INTO wa_plan_milestones (id, project_id, plan_task_id, milestone, status) VALUES (?,?,?,?,\'pending\')')
    .run(`${planTaskId}-${milestone}`, project, planTaskId, milestone);
const msRow = (db: any, planTaskId: string, milestone: string) =>
  db.prepare('SELECT status, implemented_by_task_id FROM wa_plan_milestones WHERE plan_task_id=? AND milestone=?').get(planTaskId, milestone) as any;
const board = (db: any, planTaskId: string) =>
  db.prepare('SELECT milestone, status, implemented_by_task_id FROM wa_plan_milestones WHERE plan_task_id=? ORDER BY milestone').all(planTaskId) as any[];

/** 用生产入参搭树：板 7 行 + 实施父（父=板主）+ 6 个子任务（5 张 M 卡 + 1 [Sub]） */
function seedProd() {
  const db = mkdb();
  addTask(db, PROD.planId, '20260911-1 功能优化规划', null, PROD.projectId);
  for (const m of ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6']) addMs(db, PROD.planId, m, PROD.projectId);
  addTask(db, PROD.implId, PROD.implTitle, PROD.planId, PROD.projectId, 'executing', { mode: 'execution', plan: PROD.planText, subtaskCount: 5 });
  for (const c of PROD.cards) addTask(db, c.id, c.title, PROD.implId, PROD.projectId, 'completed', { depth: 1 });
  return db;
}

async function s1(): Promise<void> {
  console.log('\n[S1 M1 计划模式两处入口·只补写不重建]');
  const mod = await import(pathToFileURL(path.join(__dirname, '..', A, EXE)).href) as {
    mergePlanModeContext?: (c: Record<string, unknown> | null | undefined, p: Record<string, unknown>) => Record<string, unknown>;
  };
  ok(typeof mod.mergePlanModeContext === 'function', 'mergePlanModeContext 可 import（行为可验，非只扫源码）');
  const merge = mod.mergePlanModeContext!;
  const realCtx = { mode: 'planning', plan: '旧', scheme_ref: { plan_task_id: PROD.planId }, task_goal: { t: 1 }, depth: 1 };
  const afterExit = merge(realCtx, { mode: 'execution', plan: 'P', subtaskCount: 5 });
  ok(afterExit.scheme_ref && (afterExit.scheme_ref as any).plan_task_id === PROD.planId, 'exit: scheme_ref 幸存（真入参）');
  eq(afterExit.task_goal, realCtx.task_goal, 'exit: task_goal 等既有键仍在');
  ok(afterExit.mode === 'execution' && afterExit.plan === 'P' && afterExit.subtaskCount === 5, 'exit: mode/plan/subtaskCount 三键精确落位');
  ok(Object.keys(realCtx).every((k) => k in afterExit), 'exit: 既有键一个不少（纯合并，非整体重建）');
  ok(afterExit.subtaskCount === 5 && Object.keys(afterExit).length === Object.keys(realCtx).length + 1,
    'exit: 仅新增声明键，未丢既有键（旧写法会只剩 3 键）');
  const afterEnter = merge(realCtx, { mode: 'planning', goal: 'G', depth: 1, enteredAt: 'T' });
  ok(afterEnter.scheme_ref && afterEnter.mode === 'planning' && afterEnter.goal === 'G' && afterEnter.depth === 1 && afterEnter.enteredAt === 'T', 'enter: scheme_ref 幸存且四键精确落位');
  ok(merge(null, { mode: 'x' }).mode === 'x' && merge(undefined, { mode: 'x' }).mode === 'x', '空/undefined 入参安全');
  ok(!/JSON\.stringify\(\{ mode: 'execution', plan: args\.plan_summary, subtaskCount/.test(exe), '旧「整体覆写」写法已移除（exit_plan_mode 处）');
  ok(!/JSON\.stringify\(\{ mode: 'planning', goal: args\.goal|JSON\.stringify\(\{ mode: 'planning', goal: args\.goal_summary/.test(exe), '旧「整体覆写」写法已移除（enter_plan_mode 处）');
}

async function s2(): Promise<void> {
  console.log('\n[S2 M2 创建时上溯祖先取 scheme_ref]');
  eq(buildChildContext({ depth: 0 }, 1), { depth: 1 }, '无关联父 → 子不凭空多字段（约定未破）');
  eq(buildChildContext({ scheme_ref: { plan_task_id: 'X' } }, 2), { depth: 2, scheme_ref: { plan_task_id: 'X' } }, '有 scheme_ref 父 → 子继承');
  ok(!('plan' in buildChildContext({ depth: 0, plan: 'P' }, 1)), '子 ctx 不继承 plan 文本（M5 归口判据不被子树污染）');

  const db = seedProd();
  ok(resolveAncestorSchemeRef(db, PROD.cards[0].id) === null, '真库形态：卡自身与父链**皆无** scheme_ref 时如实返回 null');
  db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify({ scheme_ref: { plan_task_id: PROD.planId } }), PROD.implId);
  eq(resolveAncestorSchemeRef(db, PROD.cards[0].id), { plan_task_id: PROD.planId }, '板上有关联 → 卡经**祖先链**取到（E2 的真解）');
  eq(resolveAncestorSchemeRef(db, PROD.implId), { plan_task_id: PROD.planId }, '实施父自身即关联源');
  db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run('{坏JSON', PROD.implId);
  ok(resolveAncestorSchemeRef(db, PROD.cards[0].id) === null, '脏 ctx 视作此级无关联（不抛）');
  ok(resolveAncestorSchemeRef(db, '不存在') === null, '缺行 → null');
  ok(resolveAncestorSchemeRef(db, PROD.cards[0].id, 0) === null, 'maxHops=0 → null（环/深链截断保护）');
  db.close();

  ok(/resolveAncestorSchemeRef\(db, taskId\)/.test(exe), 'create_task 走祖先链解析');
  ok(/JSON\.stringify\(buildChildContext\(parentCtx, childDepth\)\)/.test(exe), 'create_task INSERT 仍走 buildChildContext（老断言零回归）');
  ok(/resolveAncestorSchemeRef\(db, taskId\)/.test(exe) && /subagentSr/.test(exe), 'spawn_subagent 同走祖先链（两条路径都继承）');
}

async function s3(): Promise<void> {
  console.log('\n[S3 M3 向下回填 + 祖先优先 + 工具层三处沉默错误]');
  const db = seedProd();
  eq(collectAncestorIds(db, PROD.cards[0].id), [PROD.implId, PROD.planId], '祖先链自近及远（排除自身）');
  eq(collectSubtreeIds(db, PROD.planId).length, 7, '子树 = 1 实施父 + 6 卡');
  db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify({ scheme_ref: { plan_task_id: PROD.planId } }), PROD.implId);
  ok(backfillDescendantSchemeRef(db, PROD.implId, { plan_task_id: PROD.planId }) === 6, '向下回填命中 6 个后代');
  ok(backfillDescendantSchemeRef(db, PROD.implId, { plan_task_id: 'OTHER' }) === 0, '补缺式：已指别板者不被越权改写');
  db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify({ scheme_ref: { plan_task_id: 'KEEP' } }), PROD.cards[0].id);
  ok(backfillDescendantSchemeRef(db, PROD.implId, null, PROD.planId) === 5, '清空式：仅当前值 === clearPlanId 才清（6 子中 5 个命中、1 个指别板者保留）');
  ok((JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(PROD.cards[0].id) as any).context_json) as any).scheme_ref.plan_task_id === 'KEEP', '清空式：指别板者未被误清');

  // ②a′ 祖先优先：本项目再造 10 块同名板（共 11 块持 M0，②b 必 null）仍唯一定位祖先板
  for (let k = 0; k < 10; k++) {
    addTask(db, `DECOY${k}`, `干扰板${k}`, null, PROD.projectId);
    for (const m of ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6']) addMs(db, `DECOY${k}`, m, PROD.projectId);
  }
  const link = resolveTaskMilestoneAutoLink(db, { id: PROD.cards[0].id, title: PROD.cards[0].title, project_id: PROD.projectId, parent_task_id: PROD.implId });
  eq(link, { plan_task_id: PROD.planId, milestone: 'M0' }, '②a′ 祖先优先：11 块持 M0 的板下仍定位到祖先板（E4/E5 双解）');
  const amb = mkdb();
  addTask(amb, 'G1', 'G1', null); addTask(amb, 'G2', 'G2', 'G1'); addTask(amb, 'P', 'P', 'G2'); addTask(amb, 'K', 'M0 卡', 'P');
  addMs(amb, 'G1', 'M0'); addMs(amb, 'G2', 'M0');
  ok(resolveTaskMilestoneAutoLink(amb, { id: 'K', title: 'M0 卡', project_id: 'P', parent_task_id: 'P' }) === null, '反证：祖先链上两块持同 M → 不擅选板，落回 ②b → null（护栏未削弱）');
  amb.close();
  db.close();

  // ③a search_content 单文件语义（路径不存在 ≠ 无匹配）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr113_'));
  fs.writeFileSync(path.join(tmp, 'a.py'), 'x = 1\ndef _gate_pub():\n    pass\n_gate_pub()\n');
  fs.writeFileSync(path.join(tmp, 'b.py'), 'y = 2\n_gate_pub\n');
  // zx_20260916_2 M2: searchPathForPattern 改 async（让出事件循环）；此处**只补 await，断言一字不改**
  const asFile = await searchPathForPattern({ pattern: '_gate_pub', workingDir: tmp, dirPath: 'a.py' });
  const asDir = await searchPathForPattern({ pattern: '_gate_pub', workingDir: tmp });
  ok(asFile.ok && asFile.matches > 0 && asFile.scope === 'file', `单文件语义：路径是文件 → 真扫（命中 ${asFile.ok ? asFile.matches : 'ERR'}，E11 反例归零）`);
  ok(asDir.ok && asDir.matches > 0 && asDir.scope === 'dir', `目录语义：递归聚合（命中 ${asDir.ok ? asDir.matches : 'ERR'}）`);
  const missing = await searchPathForPattern({ pattern: 'x', workingDir: tmp, dirPath: 'nope.py' });
  ok(!missing.ok && /路径不存在/.test(missing.ok ? '' : missing.error), '路径不存在 → 明确报错（与「无匹配 0」区分，判据未合并）');
  const noMatch = await searchPathForPattern({ pattern: '绝不存在zzz', workingDir: tmp, dirPath: 'a.py' });
  ok(noMatch.ok && noMatch.matches === 0, '真无匹配 → 0 且 ok（与路径错误可区分）');
  fs.rmSync(tmp, { recursive: true, force: true });

  // ③b bash 引号感知切分（白名单集合一字未动）
  eq(SAFE_READONLY_COMMANDS.size, 26, 'SAFE 白名单仍 26 条（不放宽）');
  eq(splitShellPipes('grep "a|b" f.txt'), ['grep "a|b" f.txt'], '引号内竖线不当管道切');
  eq(splitShellPipes('ls | grep x').length, 2, '真管道仍切两段');
  ok(validateReadonlyBashCommand('grep "a|b" f.txt').ok, '引号内交替（正则）放行（E12 反例归零）');
  ok(!validateReadonlyBashCommand('ls | rm -rf /tmp/x').ok, '管道段不在白名单 → 拦');
  ok(!validateReadonlyBashCommand('sed -i "" s/a/b/ f').ok, 'sed -i 仍拦');
  ok(!validateReadonlyBashCommand('find . -exec rm {} \\;').ok, 'find -exec 仍拦');
  ok(!validateReadonlyBashCommand('cat a > b').ok, '重定向仍拦');
  ok(!validateReadonlyBashCommand('echo $(date)').ok, '$() 仍拦');
  ok(!validateReadonlyBashCommand('ls; rm -rf /').ok, '分隔符仍拦');
  ok(validateReadonlyBashCommand('ls -la').ok, '白名单命令照常放行');

  // ③c 孤立代理净化（合法代理对不误伤）
  eq(sanitizeLoneSurrogates('a\uD83Db'), 'a�b', '孤立高代理 → U+FFFD');
  eq(sanitizeLoneSurrogates('a\uDC00b'), 'a�b', '孤立低代理 → U+FFFD');
  eq(sanitizeLoneSurrogates('😀'), '😀', '合法代理对（emoji）不误伤');
  ok(!/\uD83D/.test(sanitizeLoneSurrogates('x\uD83dy')), '净化后可安全进 JSON（E13 反例归零）');

  ok(/validateReadonlyBashCommand\(command\)/.test(exe) && !/command\.split\('\|'\)/.test(exe), 'bash 改走引号感知校验（裸 split 已移除）');
  ok(/searchPathForPattern\(/.test(exe), 'search_content 走单文件语义真源');
  ok(/sanitizeLoneSurrogates\(/.test(exe), '压缩前净化接线在案');
}

async function s4(): Promise<void> {
  console.log('\n[S4 M4 完成计数如实分类]');
  const R = (n: number, shell = false) => ({ status: 'completed', context_json: JSON.stringify(shell ? { auto_completed_without_output: true } : { depth: 1 }) });
  {
    const l = childCompletionCheckLabel(classifyChildCompletion([R(1), R(2), R(3), R(4, true), R(5, true)]));
    ok(l.includes('已完成 5（其中未产出 2 个）'), '方案断言：3 真完成 + 2 空壳 → 已完成 5（其中未产出 2 个）');
    ok(!/所有5个子任务已完成/.test(l), '有空壳时不再出现"全部完成"字样');
    ok(/空壳/.test(l) && /核验/.test(l), '显式披露空壳并请人工核验');
  }
  ok(childCompletionCheckLabel(classifyChildCompletion([R(1, true), R(2, true), R(3, true), R(4, true), R(5, true)])).includes('已完成 5（其中未产出 5 个）'), '边界：全空壳 → 已完成 5（其中未产出 5 个）');
  eq(childCompletionCheckLabel(classifyChildCompletion([R(1), R(2), R(3), R(4), R(5)])), '[PASS] 所有5个子任务已完成', '边界：全真完成 → 原措辞保留');
  eq(childCompletionCheckLabel(classifyChildCompletion([])), '[PASS] 无子任务', '边界：无子任务不变');
  {
    const c = classifyChildCompletion([R(1), { status: 'failed', context_json: '{}' }, R(3, true), { status: 'pending', context_json: '{}' }]);
    ok(c.done === 1 && c.failed === 1 && c.emptyShell === 1 && c.incomplete === 1, '失败/未完成亦如实分列（旧文案把失败也算进"已完成"）');
    // zx_20261015_2 D5 重定向（按**更强**真源钉形状，非放宽）：有 `incomplete`（含 archived/pending）时，
    //   头句**不再**把未了结者算进"已终结 N"——如实分列 完成/归档·未了结/失败/未产出。
    //   （旧串「已终结 4（其中失败 1 个、未产出 1 个）」把那个 pending 也算作"已终结"，名实不符。）
    ok(childCompletionCheckLabel(c).includes('共 4 个子任务（完成 1 个、归档/未了结 1 个、失败 1 个、未产出 1 个）'), '有未了结(含 archived/pending)时不冒名"已终结 N"→「共 N 个子任务（…）」逐项如实');
    ok(!/已终结 4/.test(childCompletionCheckLabel(c)), '且不再出现"已终结 4"（未了结者不得算作已终结）');
    ok(/归档\/未了结 1 个/.test(childCompletionCheckLabel(c)), '显式披露归档/未了结数');
  }
  ok(classifyChildCompletion([{ status: 'completed', context_json: '{坏JSON' }]).done === 1, '脏 ctx 不误判为空壳（宁可少报）');
  ok(classifyChildCompletion([{ status: 'completed', context_json: null }]).done === 1, '无 ctx 视为真完成（不凭空扣分）');
  ok(classifyChildCompletion([{ status: 'completed', context_json: JSON.stringify({ auto_completed_without_output: 'true' }) }]).done === 1, '非布尔 true 不认定空壳（严格 === true）');
  // 生产入参：真库这 6 个子任务实为「5 空壳 + 1 真完成」
  {
    const kids = PROD.cards.slice(0, 5).map((_, i) => ({ status: 'completed', context_json: JSON.stringify({ auto_completed_without_output: true }) }))
      .concat([{ status: 'completed', context_json: JSON.stringify({ type: 'subagent', depth: 1 }) }]);
    const c = classifyChildCompletion(kids);
    ok(c.emptyShell === 5 && c.done === 1 && c.total === 6, '生产入参：df334d91 的 6 子任务 = 空壳 5 / 真完成 1');
    ok(childCompletionCheckLabel(c).includes('已完成 6（其中未产出 5 个）'), '生产入参文案 → 已完成 6（其中未产出 5 个）（旧文案为恒真「所有6个子任务已完成」）');
  }
  // zx_20260920_1 M1 就地订正：这两处随 `create_task` 工具体搬进了 `core/tools/control.ts`
  // ⇒ 扫描面改「执行体 ∪ 工具模块」（判据不变：写入点与判据都须在场）。
  ok(/tctx\.auto_completed_without_output = true;/.test(engineSrc()), '写入点 auto_completed_without_output 原样保留（方案硬约束）');
  ok(/const hasOut = realOutputEvidence\(db, args\.targetTaskId\);/.test(engineSrc()), '其判据 realOutputEvidence 未改');
  ok(/childCompletionCheckLabel\(classifyChildCompletion\(myChildren\)\)/.test(exe), 'finalize 改走分类文案单一真源');
  ok(/SELECT id, title, status, context_json FROM wa_tasks WHERE parent_task_id = \?/.test(exe), '子任务查询补 context_json 供分类');
  ok(!/所有\$\{myChildren\.length\}个子任务已完成/.test(exe), '旧的"所有N个已完成"恒真文案已移除');
}

async function s5(): Promise<void> {
  console.log('\n[S5 M5 上限截断后「剩余 M」补归口]');
  {
    const db = seedProd();
    for (const c of PROD.cards.slice(0, 5)) writeMilestoneDone(db, c.id, {});
    const r = backfillBoardRemainderToSelf(db, PROD.implId, { mode: 'execution', plan: PROD.planText, subtaskCount: 5 });
    ok(!!r && r.planTaskId === PROD.planId, '归口到生产板 101ec358');
    eq(r?.milestones.slice().sort(), ['M5', 'M6'], '仅归 M5/M6（父自述且无卡）');
    const b = board(db, PROD.planId);
    ok(b.length === 7 && b.every((x) => x.status === 'done'), '方案断言：板上 7 行全 done');
    ok(b.every((x) => !!x.implemented_by_task_id), '方案断言：7 行 implemented_by_task_id 全非空');
    ok(b.slice(0, 5).every((x, i) => x.implemented_by_task_id === PROD.cards[i].id), 'M0–M4 的实施者 = 生产各 M 卡（经 ②a′ 祖先链定位，非标题全局碰巧）');
    ok(msRow(db, PROD.planId, 'M5').implemented_by_task_id === PROD.implId && msRow(db, PROD.planId, 'M6').implemented_by_task_id === PROD.implId, 'M5/M6 的实施者 = 生产实施父 df334d91 自身');
    db.close();
  }
  {
    const db = seedProd();
    const terse = '本任务只串行完成 M0→M1→M2→M3→M4，其余另行安排。';
    db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify({ mode: 'execution', plan: terse }), PROD.implId);
    for (const c of PROD.cards.slice(0, 5)) writeMilestoneDone(db, c.id, {});
    ok(backfillBoardRemainderToSelf(db, PROD.implId, { mode: 'execution', plan: terse }) === null, '边界①：父未声明者不归（返回 null）');
    ok(msRow(db, PROD.planId, 'M5').status === 'pending' && msRow(db, PROD.planId, 'M6').status === 'pending', '边界①：M5/M6 保持 pending（不冒名）');
    db.close();
  }
  {
    const db = seedProd();
    addTask(db, 'FAILCARD', 'M5 全量回归', PROD.implId, PROD.projectId, 'failed', { depth: 1 });
    for (const c of PROD.cards.slice(0, 5)) writeMilestoneDone(db, c.id, {});
    const r = backfillBoardRemainderToSelf(db, PROD.implId, { mode: 'execution', plan: PROD.planText });
    eq(r?.milestones, ['M6'], '边界②：有卡（即便失败）不代标 → 只归 M6');
    ok(msRow(db, PROD.planId, 'M5').status === 'pending', '边界②：失败卡的 M 留 pending 交人工核验');
    db.close();
  }
  {
    const db = seedProd();
    addTask(db, 'LEAF', 'M9 单卡', PROD.planId, PROD.projectId, 'completed', { scheme_ref: { plan_task_id: PROD.planId } });
    ok(backfillBoardRemainderToSelf(db, 'LEAF', { scheme_ref: { plan_task_id: PROD.planId } }) === null, '边界③：叶任务（无子任务）no-op');
    ok(msRow(db, PROD.planId, 'M0').implemented_by_task_id === null, '边界③：叶任务未动任何板行');
    const d2 = mkdb(); addTask(d2, 'ORPH', '孤父', null); addTask(d2, 'KID', 'M0 卡', 'ORPH');
    ok(backfillBoardRemainderToSelf(d2, 'ORPH', { plan: 'M0→M5' }) === null, '边界③：祖先链无板主 → null（不动别人的板）');
    d2.close();
    const d3 = seedProd(); d3.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run('{}', PROD.implId);
    ok(backfillBoardRemainderToSelf(d3, PROD.implId, {}) === null, '边界③：无自述 → null');
    d3.close();
    db.close();
  }
  {
    const db = seedProd();
    addTask(db, 'PLAN_B', '另一块方案', null, PROD.projectId); addMs(db, 'PLAN_B', 'M5', PROD.projectId);
    const r = backfillBoardRemainderToSelf(db, PROD.implId, { plan: PROD.planText, scheme_ref: { plan_task_id: 'PLAN_B' } });
    ok(!!r && r.planTaskId === 'PLAN_B', '边界④：显式关联优先（板 ≠ 祖先持有的板）');
    ok(msRow(db, 'PLAN_B', 'M5').implemented_by_task_id === PROD.implId && msRow(db, PROD.planId, 'M5').status === 'pending', '边界④：只动 scheme_ref 指定的板');
    db.close();
  }
  {
    const db = seedProd();
    backfillBoardRemainderToSelf(db, PROD.implId, { plan: PROD.planText });
    ok(backfillBoardRemainderToSelf(db, PROD.implId, { plan: PROD.planText }) === null, '边界⑤：幂等（二次无新增）');
    db.close();
  }
  ok(/if \(children\.length === 0\) return null;/.test(rd(`${A}/src/main/core/task-accounting.ts`).replace(/\/\*[\s\S]*?\*\//g, '')), '源码：非编排父 no-op 护栏在案');
  ok(/backfillBoardRemainderToSelf\(db, taskId, ctxJson, \(e\) => \{/.test(exe), 'finalize 接线：writeMilestoneDone 后接补归口');
  // 订正（zx_20260916_3 M1）：原断言为
  //   `!/create_task 上限|sibCount >= 5/.test(exe.replace(/sibCount >= 5/g, '')) || /if \(sibCount >= 5\)/.test(exe)`
  // ——M1 把 `sibCount` 整条换成真源 `childBreadthRefusal` 后，该式**恒真**（替换掉 `sibCount >= 5` 之后，
  // 正则剩下的那一项在源码里根本不存在；`||` 右项亦恒假）。**恒真的断言等于没有断言**，且名字仍在声称
  // "上限仍 5"——正是本仓反复记的「断言名不得冒充覆盖面 / 名实不符」。
  // 其**本义**是「广度上限仍为 5，D3 不放宽」，与实现形状无关，故按本义重写：由真源常量**派生**后比对
  // （不写死实现细节，也不写"只为本轮为真"的字面量——5 是 D3 的**裁定值**，非轮次值）。
  ok(MAX_CHILD_BREADTH === 5, `create_task 广度上限仍 5（D3 不放宽；取真源派生值 ${MAX_CHILD_BREADTH}）`);
}

async function s6(): Promise<void> {
  console.log('\n[S6 收口：build 刷新（派生一致性，非字面量） + 零残留 + 端到端产物]');
  // 订正（M5 落地时）：原为字面量钉 `build: 'zx_20260911_5'` + 反向残留 `!/build: 'zx_20260911_4'/`，以及
  // 产物侧的 `blob.includes('zx_…')` 子串判定（会被产物注释里的轮次名假阳性命中）。改为**派生一致性**：
  // 真源＝agent-executor.ts 的那一处 build 值；P1「恰好一处」严格强于原反向钉，P6 取产物 build **值本身**。
  // 见 plans/improve/zx_20260912.md §M5 与 scripts/lib/rr-pins.ts。
  const distDir = path.join(__dirname, '..', A, 'dist');
  checkBuildPins(ok, { distDir });
  let files: string[] = [];
  try { files = fs.readdirSync(distDir, { recursive: true }).filter((f): f is string => typeof f === 'string' && f.endsWith('.js')); } catch { /* 未构建 */ }
  const blob = files.map((f) => fs.readFileSync(path.join(distDir, f), 'utf-8')).join('\n');
  ok(blob.includes('backfillBoardRemainderToSelf'), '★产物内含补归口（M5）');
  ok(blob.includes('classifyChildCompletion') && blob.includes('childCompletionCheckLabel'), '★产物内含如实分类（M4）');
  ok(blob.includes('searchPathForPattern') && blob.includes('sanitizeLoneSurrogates'), '★产物内含工具层真源（M3 B 线）');
}

async function main(): Promise<void> {
  await s1(); await s2(); await s3(); await s4(); await s5(); await s6();
  console.log(`\n结果: pass=${pass} fail=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
