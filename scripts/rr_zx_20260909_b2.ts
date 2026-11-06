/**
 * zx_20260909 批2 受控复跑（node:sqlite 内存库语义复刻 + 源码静态防回归；绝不触碰开发库；tsx 运行）。
 *
 * X1 就地成果详情抽屉——M0 决策"复用 deliverable:preview":
 *  - main deliverable:preview 补"抽屉溯源载荷": task_title/project_name/支撑里程碑(经 wa_plan_milestones.implemented_by_task_id 反查)
 *    与验收证据(任务级派生, 随 deliverable.show_acceptance 下发一致);
 *  - renderer DeliverableDrawer(Provider+hook) 各入口(digest 行/最近产出物/任务详情 doc/CommandPalette) open(id) 就地展开, 受 deliverable.doc_drawer 门控;
 *  - diff 抽共享 lib/diff.ts(产出物页与抽屉同源, 防双实现漂移)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// zx_20260914 M2-3③: 验收派生**已收敛为生产唯一实现**——本脚本真调它，不再复刻一份
import { annotateAcceptance } from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => any };

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const ipc = rd('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
const draw = rd('apps/worker-ant-desktop/renderer/src/components/DeliverableDrawer.tsx');
const prov = rd('apps/worker-ant-desktop/renderer/src/lib/deliverableDrawer.tsx');
const app = rd('apps/worker-ant-desktop/renderer/src/App.tsx');
const diffLib = rd('apps/worker-ant-desktop/renderer/src/lib/diff.ts');
const dp = rd('apps/worker-ant-desktop/renderer/src/pages/DeliverablesPage.tsx');
const dig = rd('apps/worker-ant-desktop/renderer/src/components/DeliveryDigestCard.tsx');
const pdp = rd('apps/worker-ant-desktop/renderer/src/pages/ProjectDetailPage.tsx');
const tdp = rd('apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx');
const cpl = rd('apps/worker-ant-desktop/renderer/src/components/CommandPalette.tsx');
const dbts = rd('apps/worker-ant-desktop/src/main/database.ts');
const eb = rd('apps/worker-ant-desktop/src/main/core/event-bus.ts');
const adm = rd('apps/worker-ant-desktop/src/main/ipc/admin.ipc.ts');
const idx = rd('apps/worker-ant-desktop/src/main/index.ts');
const settings = rd('apps/worker-ant-desktop/renderer/src/pages/SettingsPage.tsx');

console.log('X1 preview 溯源载荷语义(main, 复刻 project.ipc 谓词)');
const dbm = new DatabaseSync(':memory:') as any;
dbm.exec(`CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT, status TEXT, is_primary INTEGER DEFAULT 0, acceptance_verified INTEGER DEFAULT 0, name TEXT, file_path TEXT, description TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, context_json TEXT, updated_at TEXT);
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE wa_plan_milestones (id TEXT, plan_task_id TEXT, project_id TEXT, milestone TEXT, status TEXT, implemented_by_task_id TEXT);
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);`);
// 复刻 preview 溯源段：task_title/里程碑/项目名三字段仍是 project.ipc 内联的"二次读"（巨型 handler 不可 import）。
// zx_20260914 M2-3③: **验收段不再复刻**——真调生产 `annotateAcceptance`，门控取自 wa_settings 真键
//   （此前由入参 showAcc 假装门控，复刻的判据还比生产宽松：漏了 isAcceptanceType）。
function enrichForDrawer(db: any, delivId: string): Record<string, unknown> {
  const deliv = db.prepare('SELECT * FROM wa_deliverables WHERE id=?').get(delivId);
  const extra: Record<string, unknown> = {};
  const tId = deliv.task_id as string | null;
  const pId = deliv.project_id as string | null;
  if (tId) {
    const t = db.prepare('SELECT title FROM wa_tasks WHERE id=?').get(tId);
    extra.task_title = t?.title ?? null;
    extra.milestones = db.prepare('SELECT milestone, status FROM wa_plan_milestones WHERE implemented_by_task_id=? ORDER BY milestone ASC').all(tId);
  }
  if (pId) extra.project_name = db.prepare('SELECT name FROM wa_projects WHERE id=?').get(pId)?.name ?? null;
  const row: Record<string, unknown> = { ...deliv };
  annotateAcceptance(db, [row]);            // ← 生产函数，非复刻
  if (row.acceptance) extra.acceptance = row.acceptance;
  return extra;
}
dbm.prepare("INSERT INTO wa_deliverables (id,project_id,task_id,type,status,name,acceptance_verified) VALUES ('dl1','p1','t1','doc','completed','a.md',1)").run();
// 反例行: 类型不在 ACCEPTANCE_TYPES(ui) 却 acceptance_verified=1 —— 收敛前抽屉会显 ✓、列表不显（同一把尺的病根）
dbm.prepare("INSERT INTO wa_deliverables (id,project_id,task_id,type,status,name,acceptance_verified) VALUES ('dl2','p1','t1','ui','completed','ui.html',1)").run();
dbm.prepare("INSERT INTO wa_tasks (id,project_id,title,context_json) VALUES ('t1','p1','产出任务','{\"acceptance_check\":{\"criteria_total\":3,\"passed_total\":3,\"checked_at\":\"2026-09-09\"}}')").run();
dbm.prepare("INSERT INTO wa_projects (id,name) VALUES ('p1','项目X')").run();
dbm.prepare("INSERT INTO wa_plan_milestones (id,plan_task_id,project_id,milestone,status,implemented_by_task_id) VALUES ('m1','pt','p1','M2','done','t1'),('m2','pt','p1','M3','pending','t1')").run();
const setShowAcc = (v: string) => dbm.prepare("INSERT INTO wa_settings (key,value) VALUES ('deliverable.show_acceptance',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(v);
dbm.prepare("INSERT INTO wa_settings (key,value) VALUES ('deliverable.per_doc_acceptance','true')").run();
setShowAcc('true');
const e1 = enrichForDrawer(dbm, 'dl1');
ok(e1.task_title === '产出任务' && e1.project_name === '项目X', 'preview 溯源补 task_title/project_name', `title=${e1.task_title} proj=${e1.project_name}`);
ok((e1.milestones as Array<{ milestone: string; status: string }>).length === 2 && (e1.milestones as Array<{ milestone: string; status: string }>).some((m) => m.milestone === 'M2' && m.status === 'done'), 'preview 反查支撑里程碑(implemented_by_task_id)');
const acc = e1.acceptance as { criteria_total: number; passed_total: number } | undefined;
ok(!!acc && acc.criteria_total === 3 && acc.passed_total === 3, 'preview 补验收证据(任务级派生)');
ok(enrichForDrawer(dbm, 'dl2').acceptance === undefined, '反例: ui 类而位1 → 抽屉不下发验收(收敛前漏判类型, 与列表两说)');
setShowAcc('false');
const e2 = enrichForDrawer(dbm, 'dl1');
ok(!e2.acceptance, 'show_acceptance=false 时 preview 不下发 acceptance(与 list/digest 同判)');

console.log('X1 main preview 实现静态');
ok(ipc.includes('task_title') && ipc.includes('project_name') && ipc.includes('milestones') && ipc.includes("SELECT milestone, status FROM wa_plan_milestones WHERE implemented_by_task_id"), 'project.ipc deliverable:preview 增溯源三字段+里程碑反查');
ok(ipc.includes("key = 'deliverable.show_acceptance'") && ipc.includes("accMeta.acceptance"), 'preview 验收下发随 deliverable.show_acceptance 门控');

console.log('X1 renderer 抽屉组件/Provider');
ok(draw.includes("deliverable:preview") && draw.includes('simpleLineDiff') && draw.includes('deliverables.setPrimary'), 'DeliverableDrawer 用 preview+diff+setPrimary(展示聚合/操作复用既有)');
ok(draw.includes("versions.map") && draw.includes('与上一版对比') && draw.includes('deliverable_id') === false, '抽屉含版本流(diff 对比)');
ok(prov.includes('DeliverableDrawerProvider') && prov.includes('export function useDeliverableDrawer') && prov.includes('DeliverableDrawer id={openId}'), 'Provider+hook 就位');
ok(app.includes('<DeliverableDrawerProvider>') && app.includes('</DeliverableDrawerProvider>'), 'App 挂载 Provider(全局可用)');
ok(diffLib.includes('export function simpleLineDiff') && dp.includes("from '../lib/diff'"), 'diff 抽共享 lib/diff.ts(产出物页改 import, 防双实现)');
ok(!dp.includes('function simpleLineDiff('), 'DeliverablesPage 本地 simpleLineDiff 已移除(单一来源)');

console.log('M3 X2① milestone 事件真实化(main→renderer 全链)');
ok(eb.includes("'project.milestone_changed'") && eb.includes("aggregate_type: 'project', idField: 'projectId'") && eb.includes('project.milestone_changed'), 'event-bus EventType 并集+聚合映射加 project.milestone_changed');
ok(adm.includes("from '../core/event-bus.js'") && adm.includes("emit('project.milestone_changed'") && adm.includes("SELECT project_id FROM wa_plan_milestones"), 'admin plan:milestoneSet 落库后取 projectId 并 emit(不再无事件)');
ok(idx.includes("eventBus.on('project.milestone_changed'") && idx.includes("forwardToRenderer('project.milestone_changed'"), 'index 转发里程碑事件到 renderer(task:event)');
ok(!/t === 'milestone\.done'/.test(dig), 'DeliveryDigestCard 订阅谓词删虚构死监听 milestone.done');
ok(dig.includes("t === 'project.milestone_changed'"), 'DeliveryDigestCard 改订阅真实 project.milestone_changed(标 done 即刷)');

console.log('M3 X2② show_acceptance 两入口一致(digest)');
// zx_20260914 M2-3③: accMap 构建由内联 `taskIds.length > 0 && accOnD` 收敛为真源函数调用——
//   断言改指其真身，判据(off → 空 Map ⇒ verifiedDocs 空/primary 无验收，与 list 同判)不变。
ok(ipc.includes("key = 'deliverable.show_acceptance'") && ipc.includes('const accOnD = boolSetting(') && ipc.includes('accOnD ? verifiedAcceptanceMap(db, taskIds) : new Map<string, AcceptanceMeta>()'), 'deliveryDigest 读 show_acceptance 且 accMap 构建随门控(off → verifiedDocs 空/primary 无验收, 与 list 同判)');

console.log('M3 X2③ 最近产出物探针 name-only 滤除');
// zx_20260930 M4-1: 三处查询的探针滤除**再上收一跳**——从"各调 docNotProbe 片段"变为"各调共享取数范围真源"
//   （范围里已含探针滤除），故本脚本数的不再是 `\${docNotProbe(` 的模板调用数（那是在数副本数），
//   而是真源调用数；COALESCE 口径仍须真身在场（下一条断言核真源自身）。
const scopeCalls = (ipc.match(/\b(deliverableScopeSql|countDeliverables|countDeliverablesByType)\(/g) || []).length;
const dlcSrc = rd('apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.ts');
ok(scopeCalls >= 3 && dlcSrc.includes('COALESCE(${p}file_path, ${p}name)'), 'byType+recent+digest 三查询探针滤除收敛共享取数范围真源(COALESCE(file_path,name) 口径, file_path NULL 但 name 含 _tmp/_probe/test_<hash>.py 亦滤)', `真源调用 ${scopeCalls} 处`);

console.log('M3 X2④ SettingsPage 成果展示开关组');
ok(settings.includes('成果展示') && settings.includes('DELIV_OPTS'), 'SettingsPage 有成果展示开关组定义');
const keys = ['show_delivery_digest','digest_window_switch','primary_marker','primary_auto','show_acceptance','task_achievement_summary','doc_drawer'];
ok(keys.every((k) => settings.includes(`'${k}'`)), '开关组含 7 个 deliverable.* 键(含本轮 doc_drawer)');
ok(settings.includes('settings:set') && settings.includes('deliverable.${key}'), '开关写入走 settings:set 点号键(回退真实可点)');
ok(dbts.includes("ensureSetting('deliverable.doc_drawer', 'true')"), 'doc_drawer ensureSetting 默认 true');

console.log('X1 入口打通(static)');
ok(dig.includes('useDeliverableDrawer') && dig.includes("settings['deliverable.doc_drawer']") && dig.includes('open(r.deliverable_id)'), '交付单 primary/verified 行点成果名开抽屉(doc_drawer 门控, 关回落跳任务)');
ok(pdp.includes('useDeliverableDrawer') && pdp.includes('点行开详情') && pdp.includes('DELIVERABLE_STATUS_LABEL[r.status]'),
  '项目最近产出物行点开抽屉+状态文案取共享词表真源（同一状态同一名）');
// zx_20260929 M7: 本页此前把 draft 特判成「在制」，与列表/抽屉的「草稿」两说（同一条成果两页两名）。
//   判据随收敛改钉**共享词表**，并反钉本页不再留本地特判文案。
ok(!pdp.includes("'在制'") && pdp.includes("from '../lib/deliverable-view'"),
  '项目页不再本地特判「在制」——状态文案收敛到共享真源（改钉更强真源，非放宽）');
ok(tdp.includes('useDeliverableDrawer') && tdp.includes('版本流详情(抽屉)') && tdp.includes("settings['deliverable.doc_drawer']"), '任务详情 doc 行加抽屉入口(保留 eye 预览)');
ok(cpl.includes('useDeliverableDrawer') && cpl.includes('openDeliv(String(o.id))') && cpl.includes("settings['deliverable.doc_drawer']"), 'CommandPalette 产出物命中开抽屉(门控)');
ok(dbts.includes("ensureSetting('deliverable.doc_drawer', 'true')"), 'database 注册 deliverable.doc_drawer 默认 true');

console.log('\n结果: pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
