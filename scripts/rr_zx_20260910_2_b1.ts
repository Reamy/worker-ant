/**
 * zx_20260910_2 受控复跑（真实现 + node:sqlite 真 SQL；绝不触碰开发库）。
 *
 * 本轮问题：「20260910方案实施」的三条现象同源于**任务记账**缺陷——底层产物真实（726d449 已落地
 * M0-M8），任务记录却失真：父任务 paused、5 个"完成"子任务零事件、两块里程碑板 18 行全 pending。
 *
 * S1 M1 完成记账闭环：
 *   - selfCompleteBan：禁止把「当前正在执行的任务」直接置 completed（完成唯一合法出口是 finalize_task
 *     的三道门禁）。此前允许 targetTaskId===当前任务，AI 用它绕过门禁自我宣告完成 ⇒ 不留事件
 *     （不变量 task-completion-audit 实库 5 例违规）+ run 收口随即翻回 paused ⇒ 界面闪现「已完成」
 *     又变执行中（现象1 死因）。
 *   - update_task_status 写状态后必发 task.status_changed（行为可达性：status 行 + 事件行成对）。
 *   - writeMilestoneDone：经本工具完成亦落地里程碑（此前只有 finalize 做 ⇒ 子任务永远不写
 *     implemented_by_task_id，方案板 M{n} 恒 pending，现象3 后半）。
 * S2 M2 里程碑连对板：
 *   - buildChildContext：create_task 子任务继承父任务 scheme_ref（现象2/3：用户已选关联方案，
 *     整棵子树却无一节点能连上里程碑板）。
 *   - milestoneBoardOwner：finalize 登记板主优先取被关联的方案任务（此前恒以 self 登记，仅凭标题含
 *     「方案」就让实施锚父长出第二块并行空板，现象3 前半）。
 * S3 真实现单一化：finalize 与 update_task_status 共用同一份 writeMilestoneDone / 解析器。
 *
 * ⚠ 本脚本直接导入 core/task-accounting.ts 跑真实现，不在测试里复刻判据（复刻的断言只是自我印证）。
 * GUI 目视/事件实时到达为集成语义，归桌面实机复核，见方案 §五。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  selfCompleteBan, buildChildContext, milestoneBoardOwner,
  resolveTaskMilestoneAutoLink, resolveTaskMilestoneLink, writeMilestoneDone, type MilestoneChangedEvent,
} from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import { engineSrc } from './lib/rr-engine-src.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const exe = engineSrc();
const acc = rd('apps/worker-ant-desktop/src/main/core/task-accounting.ts');
const adm = rd('apps/worker-ant-desktop/src/main/ipc/admin.ipc.ts');

/** 建一个带 wa_tasks / wa_plan_milestones 的内存库（列与生产 schema 一致） */
function makeDb(): any {
  const db = new DatabaseSync(':memory:') as any;
  db.exec(`
    CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, parent_task_id TEXT, context_json TEXT);
    CREATE TABLE wa_plan_milestones (
      id TEXT PRIMARY KEY, project_id TEXT, plan_task_id TEXT NOT NULL, milestone TEXT NOT NULL,
      status TEXT DEFAULT 'pending', implemented_by_task_id TEXT, updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}
const addTask = (db: any, id: string, projectId: string, title: string, parent: string | null = null) =>
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, parent_task_id) VALUES (?, ?, ?, ?)').run(id, projectId, title, parent);
const addMs = (db: any, id: string, projectId: string, planTaskId: string, milestone: string, status = 'pending') =>
  db.prepare('INSERT INTO wa_plan_milestones (id, project_id, plan_task_id, milestone, status) VALUES (?, ?, ?, ?, ?)').run(id, projectId, planTaskId, milestone, status);
const msOf = (db: any, planTaskId: string, milestone: string) =>
  db.prepare('SELECT status, implemented_by_task_id FROM wa_plan_milestones WHERE plan_task_id = ? AND milestone = ?').get(planTaskId, milestone) as { status: string; implemented_by_task_id: string | null } | undefined;

// ─────────────────────────────────────────────────────────────
console.log('S1 selfCompleteBan——完成的唯一出口是 finalize_task');

ok(selfCompleteBan('me', 'me', 'completed') !== null, '当前任务自我宣告 completed 被拒', String(selfCompleteBan('me', 'me', 'completed'))?.slice(0, 24));
ok(selfCompleteBan('me', 'child', 'completed') === null, '完成「子任务」放行(编排父吸收工作的合法模式)');
ok(selfCompleteBan('me', 'me', 'paused') === null, '当前任务自我暂停放行(暂停不是"宣告完成")');
ok(selfCompleteBan('me', 'me', 'failed') === null, '当前任务自我置 failed 放行(放弃是合法动作)');
ok(
  (selfCompleteBan('me', 'me', 'completed') || '').includes('finalize_task'),
  '拒绝理由给出正确指引(指向 finalize_task 而非只报错)',
);

// ─────────────────────────────────────────────────────────────
console.log('\nS2 buildChildContext——子任务继承显式关联方案(现象2/3 根因)');

const withRef = buildChildContext({ depth: 0, scheme_ref: { plan_task_id: 'plan1' } }, 1);
ok(withRef.depth === 1, 'depth 递增(保持原语义)', `=${withRef.depth}`);
ok((withRef.scheme_ref as any)?.plan_task_id === 'plan1', '继承父任务 scheme_ref.plan_task_id', `=${(withRef.scheme_ref as any)?.plan_task_id}`);
ok(
  Object.keys(buildChildContext({ depth: 0 }, 1)).length === 1,
  '父任务无 scheme_ref 时不凭空注入字段(仅 depth)',
  `keys=${Object.keys(buildChildContext({ depth: 0 }, 1)).join(',')}`,
);
ok(
  (buildChildContext({ depth: 0, scheme_ref: { plan_task_id: 'p', milestone: 'M3' } }, 1).scheme_ref as any)?.milestone === 'M3',
  'scheme_ref 整体继承(含 milestone 等附加键)',
);

console.log('\nS2 milestoneBoardOwner——登记板主优先取被关联的方案');

ok(milestoneBoardOwner({ scheme_ref: { plan_task_id: 'plan1' } }) === 'plan1', '有显式关联 → 返回被关联方案任务 id');
ok(milestoneBoardOwner({}) === null, '无 scheme_ref → null(调用方回落自建板：规划任务登记自己是正确语义)');
ok(milestoneBoardOwner({ scheme_ref: {} }) === null, 'scheme_ref 空对象 → null');
ok(milestoneBoardOwner({ scheme_ref: { plan_task_id: '   ' } }) === null, 'plan_task_id 空白串 → null(不留空板主)');
ok(milestoneBoardOwner({ scheme_ref: { plan_task_id: ' plan1 ' } }) === 'plan1', 'plan_task_id 去空白');

// ─────────────────────────────────────────────────────────────
console.log('\nS1 resolveTaskMilestoneAutoLink——三级解析(迁入 task-accounting 后行为不变)');

{
  const db = makeDb();
  addTask(db, 'planA', 'p1', '方案A');
  addTask(db, 'planB', 'p1', '方案B');
  addTask(db, 'child', 'p1', 'M3 做点事', 'planA');
  addMs(db, 'a1', 'p1', 'planA', 'M3');
  addMs(db, 'b1', 'p1', 'planB', 'M3');
  const l = resolveTaskMilestoneAutoLink(db, { id: 'child', title: 'M3 做点事', project_id: 'p1', parent_task_id: 'planA' });
  ok(l?.plan_task_id === 'planA' && l?.milestone === 'M3', '②a 父任务持有该 M → 唯一绑定父板', `${l?.plan_task_id}.${l?.milestone}`);
  db.close();
}
{
  const db = makeDb();
  addTask(db, 'planA', 'p1', '方案A');
  addTask(db, 'solo', 'p1', 'M5 独立实施');
  addMs(db, 'a5', 'p1', 'planA', 'M5');
  const l = resolveTaskMilestoneAutoLink(db, { id: 'solo', title: 'M5 独立实施', project_id: 'p1', parent_task_id: null });
  ok(l?.plan_task_id === 'planA', '②b 同项目内该 M 恰有一个持有者 → 绑定', `${l?.plan_task_id}.${l?.milestone}`);
  db.close();
}
{
  const db = makeDb();
  addTask(db, 'planA', 'p1', '方案A');
  addTask(db, 'planB', 'p1', '方案B');
  addTask(db, 'solo', 'p1', 'M3 独立实施');
  addMs(db, 'a1', 'p1', 'planA', 'M3');
  addMs(db, 'b1', 'p1', 'planB', 'M3');
  ok(resolveTaskMilestoneAutoLink(db, { id: 'solo', title: 'M3 独立实施', project_id: 'p1', parent_task_id: null }) === null, '多方案歧义 → null(不误标他案，留给手动/族验收)');
  db.close();
}
{
  const db = makeDb();
  addTask(db, 'noM', 'p1', '20260910方案实施');
  addMs(db, 'a1', 'p1', 'planA', 'M3');
  db.prepare("UPDATE wa_plan_milestones SET implemented_by_task_id = 'noM' WHERE id = 'a1'").run();
  const l = resolveTaskMilestoneAutoLink(db, { id: 'noM', title: '20260910方案实施', project_id: 'p1', parent_task_id: null });
  ok(l?.plan_task_id === 'planA', '① 已登记为实施者(implemented_by) → 优先命中，无需标题 M 前缀', `${l?.plan_task_id}.${l?.milestone}`);
  db.close();
}
{
  const db = makeDb();
  addTask(db, 'noM', 'p1', '20260910方案实施');
  ok(resolveTaskMilestoneAutoLink(db, { id: 'noM', title: '20260910方案实施', project_id: 'p1', parent_task_id: null }) === null, '标题无 M 前缀且无登记 → null(锚父不绑到任意单个里程碑)');
  db.close();
}

// ─────────────────────────────────────────────────────────────
console.log('\nS2b resolveTaskMilestoneLink——显式关联优先(写路径与 GUI 读路径同一判据)');

{
  // 同项目两块板都有 M3：显式关联必须免疫歧义（这正是 GUI 读路径此前缺失的护栏）
  const db = makeDb();
  addTask(db, 'planA', 'p1', '方案A');
  addTask(db, 'planB', 'p1', '方案B');
  addTask(db, 'child', 'p1', 'M3 做点事');
  addMs(db, 'a3', 'p1', 'planA', 'M3');
  addMs(db, 'b3', 'p1', 'planB', 'M3');
  const l = resolveTaskMilestoneLink(db, 'child', { scheme_ref: { plan_task_id: 'planB' } });
  ok(l?.plan_task_id === 'planB' && l?.milestone === 'M3', '显式 scheme_ref 优先且免疫歧义(不因多板返 null，也不误标 planA)', `${l?.plan_task_id}.${l?.milestone}`);
  ok(resolveTaskMilestoneAutoLink(db, { id: 'child', title: 'M3 做点事', project_id: 'p1', parent_task_id: null }) === null, '对照：同一任务无 scheme_ref 时 autoLink 因歧义 → null(即旧读路径会返回 2 行)');
  db.close();
}
{
  // scheme_ref 显式带 milestone（标题无 M 前缀）→ 直接采用
  const db = makeDb();
  addTask(db, 'planA', 'p1', '方案A');
  addTask(db, 't', 'p1', '不含里程碑前缀的实施任务');
  addMs(db, 'a5', 'p1', 'planA', 'M5');
  const l = resolveTaskMilestoneLink(db, 't', { scheme_ref: { plan_task_id: 'planA', milestone: 'M5' } });
  ok(l?.plan_task_id === 'planA' && l?.milestone === 'M5', 'scheme_ref.milestone 显式给出 → 无需标题 M 前缀', `${l?.plan_task_id}.${l?.milestone}`);
  db.close();
}
{
  // scheme_ref 只给板、标题又无 M → 落回 autoLink → null（不瞎认里程碑）
  const db = makeDb();
  addTask(db, 'planA', 'p1', '方案A');
  addTask(db, 't', 'p1', '无前缀任务');
  addMs(db, 'a3', 'p1', 'planA', 'M3');
  ok(resolveTaskMilestoneLink(db, 't', { scheme_ref: { plan_task_id: 'planA' } }) === null, 'scheme_ref 只给板、标题无 M → null(不瞎认里程碑)');
  db.close();
}
{
  // 无 scheme_ref → 落回 autoLink，既有语义不回归（②a 父持有该 M）
  const db = makeDb();
  addTask(db, 'planA', 'p1', '方案A');
  addTask(db, 'child', 'p1', 'M3 做点事', 'planA');
  addMs(db, 'a3', 'p1', 'planA', 'M3');
  const l = resolveTaskMilestoneLink(db, 'child', {});
  ok(l?.plan_task_id === 'planA' && l?.milestone === 'M3', '无 scheme_ref → 回落 autoLink(②a 父持有该 M)', `${l?.plan_task_id}.${l?.milestone}`);
  db.close();
}
{
  const db = makeDb();
  let threw = false;
  let l: unknown = 'sentinel';
  try { l = resolveTaskMilestoneLink(db, 'not-exist', { scheme_ref: { plan_task_id: 'planA' } }); } catch { threw = true; }
  ok(!threw && l === null, '任务不存在 → null 且不抛(GUI 读路径不因脏 taskId 崩)');
  db.close();
}

// ─────────────────────────────────────────────────────────────
console.log('\nS1 writeMilestoneDone——完成即落地(现象3 后半的直接修复)');

{
  const db = makeDb();
  addTask(db, 'planA', 'p1', '方案A');
  addTask(db, 'child', 'p1', 'M3 做点事', 'planA');
  addMs(db, 'a3', 'p1', 'planA', 'M3');
  const events: MilestoneChangedEvent[] = [];
  const l = writeMilestoneDone(db, 'child', { scheme_ref: { plan_task_id: 'planA' } }, (e) => events.push(e));
  const row = msOf(db, 'planA', 'M3');
  ok(l?.milestone === 'M3', 'scheme_ref 优先 → 命中 M3(标题派生)');
  ok(row?.status === 'done' && row?.implemented_by_task_id === 'child', '里程碑置 done + implemented_by=实施者', `status=${row?.status} impl=${row?.implemented_by_task_id}`);
  ok(events.length === 1 && events[0].milestone === 'M3' && events[0].projectId === 'p1' && events[0].status === 'done', 'emit 载荷完整(projectId/planTaskId/milestone/status)', JSON.stringify(events[0]));
  db.close();
}
{
  // 同项目多方案均有 M3 → 显式 scheme_ref 必须只落地被关联的那块板（跨方案不误标）
  const db = makeDb();
  addTask(db, 'planA', 'p1', '方案A');
  addTask(db, 'planB', 'p1', '方案B');
  addTask(db, 'child', 'p1', 'M3 做点事', 'planA');
  addMs(db, 'a3', 'p1', 'planA', 'M3');
  addMs(db, 'b3', 'p1', 'planB', 'M3');
  writeMilestoneDone(db, 'child', { scheme_ref: { plan_task_id: 'planB' } });
  ok(msOf(db, 'planB', 'M3')?.status === 'done' && msOf(db, 'planA', 'M3')?.status === 'pending', '显式 scheme_ref=planB 只落地 planB.M3，planA.M3 不受影响');
  db.close();
}
{
  // 无 scheme_ref（老任务）→ 回退标题 M 派生，行为不回退
  const db = makeDb();
  addTask(db, 'planA', 'p1', '方案A');
  addTask(db, 'child', 'p1', 'M3 做点事', 'planA');
  addMs(db, 'a3', 'p1', 'planA', 'M3');
  writeMilestoneDone(db, 'child', {});
  ok(msOf(db, 'planA', 'M3')?.status === 'done', '无 scheme_ref → 回退标题 M 派生(既有语义不回归)');
  db.close();
}
{
  // 幂等：二次调用 changes=0 且不再 emit（finalize 后又被 update_task_status 标一次是真实场景）
  const db = makeDb();
  addTask(db, 'planA', 'p1', '方案A');
  addTask(db, 'child', 'p1', 'M3 做点事', 'planA');
  addMs(db, 'a3', 'p1', 'planA', 'M3');
  const events: MilestoneChangedEvent[] = [];
  writeMilestoneDone(db, 'child', { scheme_ref: { plan_task_id: 'planA' } }, (e) => events.push(e));
  writeMilestoneDone(db, 'child', { scheme_ref: { plan_task_id: 'planA' } }, (e) => events.push(e));
  ok(events.length === 1, '重复回写幂等：第二次不再 emit(WHERE status != done)', `emit=${events.length} 次`);
  db.close();
}
{
  // 无匹配 → 返回 null 且不 emit（不该为空转完成伪造里程碑）
  const db = makeDb();
  addTask(db, 'orphan', 'p1', '无 M 无关联的任务');
  const events: MilestoneChangedEvent[] = [];
  const l = writeMilestoneDone(db, 'orphan', {}, (e) => events.push(e));
  ok(l === null && events.length === 0, '无匹配 → null 且不 emit(不伪造里程碑)');
  db.close();
}
{
  // 任务不存在 → 不抛异常（收口路径必须 best-effort，不能因回写失败阻断收口）
  const db = makeDb();
  let threw = false;
  try { writeMilestoneDone(db, 'not-exist', { scheme_ref: { plan_task_id: 'planA' } }); } catch { threw = true; }
  ok(!threw, '任务不存在 → 静默返回(null)，不抛(收口不被回写失败阻断)');
  db.close();
}

// ─────────────────────────────────────────────────────────────
console.log('\nS3 真实现单一化 + 生产接线(静态，覆盖测试触达不到的工具闭包体)');

ok((acc.match(/export function writeMilestoneDone/g) || []).length === 1, 'writeMilestoneDone 只有一份定义(单一真实现)');
ok(
  (exe.match(/writeMilestoneDone\(db, taskId, ctxJson/g) || []).length === 1
  && (exe.match(/writeMilestoneDone\(db, args\.targetTaskId, wctx/g) || []).length === 1,
  'finalize_task 与 update_task_status 两处均接线到同一份 writeMilestoneDone',
);
ok(!/function resolveTaskMilestoneAutoLink/.test(exe), 'agent-executor 不再持有解析器副本(已迁出)');
ok(
  /eventBus\.emit\('task\.status_changed', \{ taskId: args\.targetTaskId/.test(exe),
  'update_task_status 写状态后必发 task.status_changed(记账必留痕)',
);
ok(
  /selfCompleteBan\(taskId, args\.targetTaskId, args\.status\)/.test(exe),
  'update_task_status 接线自完成禁令',
);
// zx_20260915 P0-2: create_task 的 INSERT 增列 `acceptance_criteria`（agent 自建任务从此能带验收标准，
//   方案 §2.1①/§2.3(a)）⇒ source 之后、ctx 之前多了这一枚占位符。
//
// zx_20261021_2 D4 就地订正：旧判据的两半是**各自在全文中找**——第一半（`'agent', ?, ?)")`）当时
//   命中的其实是 `control-finalize.ts` 里那段另砌的修复任务 INSERT（与 create_task 形状巧合相同），
//   并非 create_task 本身（"判据的自我印证"）。D4 把那段内联 INSERT 收走后它才露馅。
//   现改为**按语句取整段**：INSERT 的列序+占位尾 与 紧随其后的 `.run(… buildChildContext …)` 必须在
//   **同一段文字**里——两半绑在同一句上，才真的钉住"create_task 用它落 ctx"。
ok(
  /INSERT INTO wa_tasks \(id, project_id, title, description, status, priority, parent_task_id, depends_on, source, acceptance_criteria, context_json\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, 'agent', \?, \?\)"\s*\)\s*\.run\([\s\S]{0,800}?JSON\.stringify\(buildChildContext\(parentCtx, childDepth\)\)\)/.test(exe),
  'create_task 用 buildChildContext 落子任务 ctx(子任务继承 scheme_ref)',
);
ok(
  /const ownerTaskId = milestoneBoardOwner\(bctx\) \?\? taskId;/.test(exe),
  'finalize 登记板主 = 被关联方案 ?? 本任务(不再恒自建板)',
);
ok(
  /SELECT project_id FROM wa_tasks WHERE id = \?/.test(exe) && exe.includes('ownerProjectId'),
  '板主跨任务时取该任务自身 project_id(不给里程碑挂错项目)',
);
ok(
  acc.includes('WHERE status != ') && acc.includes("SET status = 'done'") && acc.includes('implemented_by_task_id = ?'),
  '回写只前进不回退(WHERE status != done)且带 implemented_by',
);
ok(
  /writeMilestoneDone\([\s\S]{0,600}?resolveTaskMilestoneLink\(/.test(acc),
  'writeMilestoneDone 内部走 resolveTaskMilestoneLink(写路径不另立判据)',
);
ok(
  // zx_20260910_3 M2b: 同一行 import 现同时引入反向入口 resolveMilestoneImplementer，故改按名字匹配
  /import \{[^}]*\bresolveTaskMilestoneLink\b[^}]*\} from '\.\.\/core\/task-accounting\.js'/.test(adm)
  && /plan:taskMilestones[\s\S]{0,1200}?resolveTaskMilestoneLink\(db, taskId/.test(adm),
  'M2b: GUI 读路径 plan:taskMilestones 接线同一份 resolveTaskMilestoneLink',
);
ok(
  !/plan_task_id IN \(SELECT id FROM wa_tasks WHERE project_id = \?\) AND milestone = \?/.test(adm),
  'M2b: 旧的全项目回退 SQL(无 scheme_ref、无歧义护栏)已从 GUI 读路径移除',
);
{
  // 断言"代码不依赖 eventBus"——必须先剥注释：本模块的文档注释里为说明"emit 由调用方注入"本就写着 eventBus.emit
  const accCode = acc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/eventBus/.test(accCode) && !/from '\.\/event-bus/.test(accCode), 'task-accounting 代码不依赖 eventBus(注释提及不算；脱 electron，受控回归可跑真实现)');
}

console.log('\n结果: pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
