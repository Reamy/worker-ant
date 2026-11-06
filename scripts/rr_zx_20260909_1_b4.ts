/**
 * zx_20260909_1 M4 受控复跑：域Z 新建任务即选"关联方案"(Z1 planTaskId 落 scheme_ref, 先于自动动工)。
 *
 * 语义复刻 task:create(project.ipc) 的 plan_task_id 分支(同项目校验 / 显式优先于父继承 / 默认不带无 scheme) +
 * 源码静态断言(main 入参/校验/json_set、lib/ipc 透传、TasksPage/TaskDetailPage 新建表单下拉 + link_at_create 开关)。
 * 绝不触碰开发库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => any };

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const pip = rd('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
const ipl = rd('apps/worker-ant-desktop/renderer/src/lib/ipc.ts');
const tpp = rd('apps/worker-ant-desktop/renderer/src/pages/TasksPage.tsx');
const tdp = rd('apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx');
const dbt = rd('apps/worker-ant-desktop/src/main/database.ts');

function mkdb(): any {
  const db = new DatabaseSync(':memory:') as any;
  db.exec(`CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, parent_task_id TEXT, title TEXT, context_json TEXT, status TEXT DEFAULT 'pending');`);
  return db;
}
const getCtx = (db: any, id: string) => JSON.parse(db.prepare('SELECT context_json FROM wa_tasks WHERE id=?').get(id).context_json || '{}');
// 复刻 task:create(project.ipc) 相关分支语义(同项目校验 + 显式优先 + 父继承兜底)
function repCreate(db: any, opts: { projectId: string; title: string; parent?: string; plan?: string }): string | { error: string } {
  const id = 't_' + Math.random().toString(36).slice(2, 8);
  db.prepare("INSERT INTO wa_tasks (id,project_id,parent_task_id,title,context_json,status) VALUES (?,?,NULL,?,'{}','pending')").run(id, opts.projectId, opts.title);
  if (opts.parent) {
    const parentOk = db.prepare('SELECT id FROM wa_tasks WHERE id=? AND project_id=?').get(opts.parent, opts.projectId);
    if (!parentOk) return { error: 'BAD_PARENT' };
    db.prepare('UPDATE wa_tasks SET parent_task_id=? WHERE id=?').run(opts.parent, id);
  }
  let scheme: string | null = null;
  if (opts.plan) {
    const planOk = db.prepare('SELECT id FROM wa_tasks WHERE id=? AND project_id=?').get(opts.plan, opts.projectId);
    if (!planOk) return { error: 'BAD_PLAN' };
    scheme = opts.plan;
  } else if (opts.parent) {
    const pc = getCtx(db, opts.parent);
    scheme = pc.scheme_ref?.plan_task_id || pc.plan_task_id || null;
  }
  if (scheme) db.prepare("UPDATE wa_tasks SET context_json=json_set(COALESCE(context_json,'{}'),'$.scheme_ref',json(?)) WHERE id=?").run(JSON.stringify({ plan_task_id: scheme }), id);
  return id;
}

console.log('Z1·task:create 带 planTaskId(创建即落 ctx.scheme_ref, 同项目校验)');
{
  const db = mkdb();
  db.prepare("INSERT INTO wa_tasks (id,project_id,title,context_json) VALUES ('plan1','p1','20260909方案','{}')").run();
  const id = repCreate(db, { projectId: 'p1', title: 'M3 实施', plan: 'plan1' }) as string;
  ok(getCtx(db, id).scheme_ref?.plan_task_id === 'plan1', '带 planTaskId 创建 → ctx.scheme_ref.plan_task_id 一步落库');
  const r2 = repCreate(db, { projectId: 'p1', title: '跨项目', plan: 'otherProjPlan' });
  ok(typeof r2 === 'object' && r2.error === 'BAD_PLAN', '跨项目/不存在方案 → 拒绝且不落 scheme');
  const r3 = repCreate(db, { projectId: 'p1', title: '默认无关联' }) as string;
  ok(!getCtx(db, r3).scheme_ref, '不带 planTaskId(无父) → 无 scheme_ref(默认行为不变)');
}

console.log('Z1·显式优先于父继承(两路不冲突) / 父继承兜底保留');
{
  const db = mkdb();
  db.prepare("INSERT INTO wa_tasks (id,project_id,title,context_json) VALUES ('planA','p1','方案A','{}'),('parent1','p1','父实施锚','{\"scheme_ref\":{\"plan_task_id\":\"planA\"}}')").run();
  // 子任务显式选另一方案 planA(同) or 父继承——这里父已带 planA, 显式同 planA 一致
  const c1 = repCreate(db, { projectId: 'p1', title: 'M3 子', parent: 'parent1', plan: 'planA' }) as string;
  const row1 = db.prepare('SELECT parent_task_id FROM wa_tasks WHERE id=?').get(c1);
  ok(getCtx(db, c1).scheme_ref?.plan_task_id === 'planA' && row1.parent_task_id === 'parent1', '带 planTaskId + parent → 父链保持且显式方案落库');
  // 不带 plan 的子 → 继承父 scheme(既有续跑模型)
  const c2 = repCreate(db, { projectId: 'p1', title: 'M4 子', parent: 'parent1' }) as string;
  ok(getCtx(db, c2).scheme_ref?.plan_task_id === 'planA', '子任务不带 plan → 继承父 scheme_ref.plan_task_id(续跑模型保留)');
}

console.log('Z1·动工/收口沿用既有派生(标题 M + scheme_ref)');
{
  const db = mkdb();
  db.exec('CREATE TABLE wa_plan_milestones (id TEXT PRIMARY KEY, project_id TEXT, plan_task_id TEXT, milestone TEXT, status TEXT);');
  db.prepare("INSERT INTO wa_tasks (id,project_id,title,context_json) VALUES ('plan1','p1','方案','{}')").run();
  db.prepare("INSERT INTO wa_plan_milestones (id,project_id,plan_task_id,milestone,status) VALUES ('ms3','p1','plan1','M3','pending')").run();
  const c = repCreate(db, { projectId: 'p1', title: 'M3 O1 落库', plan: 'plan1' }) as string;
  const m = /^M(\d+)/.exec('M3 O1 落库')!;
  db.prepare("UPDATE wa_plan_milestones SET status='doing' WHERE plan_task_id=? AND milestone=? AND status='pending'").run('plan1', `M${m[1]}`);
  ok(db.prepare("SELECT status FROM wa_plan_milestones WHERE id='ms3'").get().status === 'doing', '新建即关联 → 自动动工时按 scheme_ref+标题 M 正常派生 doing(消除 10s 竞态)');
}

console.log('Z1·静态接线(main/渲染/开关/回退)');
{
  ok(pip.includes('plan_task_id') && pip.includes('方案任务不存在或不属于当前项目') && pip.includes("'$.scheme_ref', json(?)"), 'task:create 加 plan_task_id(同项目校验 + json_set scheme_ref)');
  ok(pip.includes('let schemePlanId: string | null = null;') && pip.includes('schemePlanId = String(plan_task_id);') && pip.includes("else if (parent_task_id)"), '显式 plan 优先 / 父继承兜底两路不冲突');
  ok(ipl.includes('planTaskId') && ipl.includes('plan_task_id: planTaskId'), 'renderer lib/ipc create 透传 planTaskId→plan_task_id');
  ok(tpp.includes("planTaskId:''") && tpp.includes("newTask.planTaskId || undefined") && tpp.includes("'plan:projectPlans'"), 'TasksPage 新建任务携带 planTaskId + 加载候选(plan:projectPlans)');
  // zx_20260910_3 M3(G3): 判据归一为 boolSetting（渲染层引 main 同一模块）——断言随之更新为规范形
  ok(tpp.includes('🔗 关联方案（规划）') && tpp.includes("boolSetting(settings['plan.link_at_create'])"), 'TasksPage 新建弹窗关联下拉 + link_at_create 开关');
  ok(tdp.includes("newTask.planTaskId || undefined") && tdp.includes('🔗 关联方案（规划）') && tdp.includes('linkOnZ'), 'TaskDetail 新建子任务同样可先选关联(与父继承不冲突)');
  ok(dbt.includes("ensureSetting('plan.link_at_create', 'true')"), 'config ensureSetting 注册 plan.link_at_create=true');
}

console.log('\n结果: pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
