/**
 * zx_20260909 续跑(规划→独立实施模型) 受控复跑(node:sqlite 语义复刻 + 源码静态；绝不触碰开发库)。
 *
 * 模型: 规划任务产出方案(含 M0-Mn 方案里程碑) → 确认后另建"独立实施"任务(非规划子任务)落地;
 *       实施锚父经 ctx.scheme_ref.plan_task_id 显式"关联方案"; M 子任务创建继承; 动工→doing、finalize→done+implemented=自身
 *       (scheme_ref 仅带 plan_task_id 时里程碑按标题 M{n} 派生——显式关联, 不受同项目多方案"唯一 M"歧义影响)。
 *       方案(规划)面板另可手动"选落地任务"(同项目任意任务, 不限于子任务)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { engineSrc } from './lib/rr-engine-src.js';
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => any };

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const exe = engineSrc();
// zx_20260910_2 M1: 里程碑联动逻辑已抽到 task-accounting.ts（finalize 与 update_task_status 共用一份真实现），
// 故"收口侧 honor scheme_ref / 标题 M 派生"的断言换源到该模块（语义不变，仅换断言所依据的文件）。
const acc = rd('apps/worker-ant-desktop/src/main/core/task-accounting.ts');
const ipc = rd('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
const adm = rd('apps/worker-ant-desktop/src/main/ipc/admin.ipc.ts');
const tdp = rd('apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx');

console.log('模型·子任务继承 scheme_ref.plan_task_id(实施锚父→M 子任务)');
const dbm = new DatabaseSync(':memory:') as any;
dbm.exec(`CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, parent_task_id TEXT, title TEXT, context_json TEXT);
CREATE TABLE wa_plan_milestones (id TEXT PRIMARY KEY, project_id TEXT, plan_task_id TEXT, milestone TEXT, status TEXT, implemented_by_task_id TEXT);`);
// 锚父关联方案 ctx.scheme_ref.plan_task_id = 899e8653
dbm.prepare("INSERT INTO wa_tasks (id,project_id,parent_task_id,title,context_json) VALUES ('anchor','p1',NULL,'20260908方案实施','{\"scheme_ref\":{\"plan_task_id\":\"plan1\"}}')").run();
// task:create 子任务继承(复刻 project.ipc 继承谓词)
const parent = JSON.parse(dbm.prepare("SELECT context_json FROM wa_tasks WHERE id='anchor'").get().context_json || '{}');
const planId = parent.scheme_ref?.plan_task_id;
dbm.prepare("INSERT INTO wa_tasks (id,project_id,parent_task_id,title,context_json) VALUES ('m3','p1','anchor','M3 O3目标单源化','{\"depth\":1}')").run();
if (planId) dbm.prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.scheme_ref', json(?)) WHERE id='m3'").run(JSON.stringify({ plan_task_id: String(planId) }));
const m3ctx = JSON.parse(dbm.prepare("SELECT context_json FROM wa_tasks WHERE id='m3'").get().context_json || '{}');
ok(m3ctx.scheme_ref?.plan_task_id === 'plan1', '子任务继承父 scheme_ref.plan_task_id', `=${m3ctx.scheme_ref?.plan_task_id}`);

console.log('模型·动工/收口自动落地(scheme_ref 仅 plan_task_id → 里程碑按标题 M 派生)');
// 复刻 finalize 自动回写谓词: scheme_ref.plan_task_id + title M3 → 置 done+implemented=self; doing 同理(pending→doing)
function autoMilestone(db: any, taskId: string, to: 'doing' | 'done'): string {
  const t = db.prepare("SELECT id,title,context_json FROM wa_tasks WHERE id=?").get(taskId);
  const c = JSON.parse(t.context_json || '{}');
  const sr = c.scheme_ref as { plan_task_id?: string } | undefined;
  const m = /^M(\d+)/.exec(String(t.title || ''));
  let link: { plan_task_id: string; milestone: string } | null = null;
  if (sr?.plan_task_id && m) link = { plan_task_id: sr.plan_task_id, milestone: `M${m[1]}` };
  if (!link) return 'NO_LINK';
  if (to === 'doing') db.prepare("UPDATE wa_plan_milestones SET status='doing' WHERE plan_task_id=? AND milestone=? AND status='pending'").run(link.plan_task_id, link.milestone);
  else db.prepare("UPDATE wa_plan_milestones SET status='done', implemented_by_task_id=? WHERE plan_task_id=? AND milestone=? AND status!='done'").run(taskId, link.plan_task_id, link.milestone);
  return `done@${link.milestone}`;
}
dbm.prepare("INSERT INTO wa_plan_milestones (id,project_id,plan_task_id,milestone,status,implemented_by_task_id) VALUES ('ms3','p1','plan1','M3','pending',NULL)").run();
autoMilestone(dbm, 'm3', 'doing');
ok(dbm.prepare("SELECT status FROM wa_plan_milestones WHERE id='ms3'").get().status === 'doing', '动工(实施锚父下 M 子任务) → 方案里程碑 M3 置 doing(仅 scheme_ref.plan_task_id 即可, 标题 M 派生)');
autoMilestone(dbm, 'm3', 'done');
const ms = dbm.prepare("SELECT status,implemented_by_task_id FROM wa_plan_milestones WHERE id='ms3'").get();
ok(ms.status === 'done' && ms.implemented_by_task_id === 'm3', '收口 finalize → 方案里程碑 M3 done + implemented=该子任务(显式关联, 不受多方案歧义)', `status=${ms.status} impl=${ms.implemented_by_task_id}`);
dbm.close();

console.log('模型·歧义免疫(同项目多方案均有 M3 时, 显式 scheme_ref 不误标他案)');
const db2 = new DatabaseSync(':memory:') as any;
db2.exec(`CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, context_json TEXT);
CREATE TABLE wa_plan_milestones (id TEXT PRIMARY KEY, project_id TEXT, plan_task_id TEXT, milestone TEXT, status TEXT, implemented_by_task_id TEXT);`);
db2.prepare("INSERT INTO wa_plan_milestones (id,project_id,plan_task_id,milestone,status) VALUES ('a','p1','planA','M3','pending'),('b','p1','planB','M3','pending')").run();
db2.prepare("INSERT INTO wa_tasks (id,project_id,context_json) VALUES ('child','p1','{\"scheme_ref\":{\"plan_task_id\":\"planB\"}}')").run();
const c2 = JSON.parse(db2.prepare("SELECT context_json FROM wa_tasks WHERE id='child'").get().context_json || '{}');
db2.prepare("UPDATE wa_plan_milestones SET status='done',implemented_by_task_id='child' WHERE plan_task_id=? AND milestone='M3' AND status!='done'").run(c2.scheme_ref.plan_task_id);
const rows = db2.prepare("SELECT plan_task_id,status,implemented_by_task_id FROM wa_plan_milestones WHERE milestone='M3'").all();
ok(rows.find((r: any) => r.plan_task_id === 'planA')?.status === 'pending' && rows.find((r: any) => r.plan_task_id === 'planB')?.status === 'done', '显式 scheme_ref=planB 只落地 planB.M3, planA.M3 不受影响(跨方案不误标)');
db2.close();

console.log('模型·实现静态');
// zx_20260910_3 M2a: 动工路径的内联 scheme_ref 判据已收敛——`if (sr?.plan_task_id)` 现只存在于
// task-accounting.resolveTaskMilestoneLink 一处；agent-executor 改经该单点联动。断言随之改判"接线"，语义不变。
ok(exe.includes('resolveTaskMilestoneLink(db, taskId, tctx)') && acc.includes('if (sr?.plan_task_id)'), 'doing(agent-executor) 与收口(task-accounting.writeMilestoneDone) 两处联动均 honor scheme_ref.plan_task_id', `exe 接线=${exe.includes('resolveTaskMilestoneLink(db, taskId, tctx)')} acc 判据=${acc.includes('if (sr?.plan_task_id)')}`);
// zx_20260910_2 M2b: 收口的标题 M 派生随判据一并挪进 resolveTaskMilestoneLink，且该函数先 `if (!tr) return null`
// 再做 `tr.title`，可选链因此消失（语义不变：旧 `tr?.title` 在 tr 为 undefined 时同样得 ''）——同语义换字面。
// zx_20260910_3 M2b: 进一步的，标题判据本身收敛为 milestoneFromTitle 单点（正向两处 + 反向一处共用），
// 故 `exe` 侧的 `/^M(\d+)/.exec(String(task.title` 字面已不存在——改为断言"单点定义 + 三处引用"。
ok(acc.includes('export function milestoneFromTitle') && (acc.match(/milestoneFromTitle\(/g) || []).length >= 3 && !exe.includes('/^M(\\d+)/.exec'), 'doing/finalize 均以标题 M 派生(显式关联, 无歧义)——判据已收敛为 milestoneFromTitle 单点');
// zx_20260910_2 M1: 收口的两条通路（finalize_task 与 update_task_status）必须都调同一份 writeMilestoneDone，
// 否则又回到"update_task_status 完成却不落地里程碑"（现象3 后半）。
ok((exe.match(/writeMilestoneDone\(db, taskId, ctxJson/g) || []).length >= 1 && exe.includes('writeMilestoneDone(db, args.targetTaskId, wctx'), 'finalize_task 与 update_task_status 共用 writeMilestoneDone(完成必落地里程碑)');
ok(exe.includes("eventBus.emit('project.milestone_changed'"), '收口自动落地后补发 project.milestone_changed(交付单即时刷新)');
ok(ipc.includes('scheme_ref') && ipc.includes('parent_task_id') && ipc.includes('$.scheme_ref'), 'task:create 子任务继承父 scheme_ref.plan_task_id');
ok(adm.includes("plan:projectPlans") && adm.includes("plan:linkPlan") && adm.includes("plan:projectTasks"), 'admin 新增 关联方案/同项目方案清单/同项目任务清单 IPC');
ok(tdp.includes('关联方案(规划)') && tdp.includes('plan:linkPlan') && tdp.includes('bindLanding') && tdp.includes('plan:projectTasks'), 'TaskDetail: 实施任务"关联方案"控件 + 方案面板每 M 行"选落地任务"');

console.log('\n结果: pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
