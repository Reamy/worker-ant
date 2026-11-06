/**
 * zx_20260908 批2 受控复跑（node:sqlite 内存库语义 + 源码静态防回归；绝不触碰开发库；tsx 运行）。
 * B1 项目「成果交付单」: project:deliveryDigest 聚合——done 里程碑→落地任务 / 主要成果·已验收 doc / 高质任务；纯派生。
 * B2a 任务列表成果摘要: task:list 派生 deliverable_count/primary_count/acc p-t（TasksPage 已完成任务显示）。
 * B2b primary 主要成果标记: wa_deliverables.is_primary 列 + deliverable:setPrimary 切换（DeliverablesPage ★ + 交付单聚合）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isAcceptanceType } from '../apps/worker-ant-desktop/src/main/core/deliverable-types.js';
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => any };

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const dbm = new DatabaseSync(':memory:') as any;
dbm.exec(`CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT, quality_score REAL, context_json TEXT, updated_at TEXT);
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, name TEXT, type TEXT, status TEXT, is_primary INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT);
CREATE TABLE wa_plan_milestones (id TEXT PRIMARY KEY, plan_task_id TEXT, milestone TEXT, status TEXT, implemented_by_task_id TEXT, updated_at TEXT);`);

// 造数据：方案A(M0 done→任务tA落地)、doc 已验收(任务tB,2/2)、primary doc(任务tB另一doc,is_primary=1)、高质任务 tC(quality 90)
dbm.prepare("INSERT INTO wa_projects (id,name) VALUES ('p1','项目A')").run();
dbm.prepare("INSERT INTO wa_projects (id,name) VALUES ('p2','项目B')").run();
dbm.prepare("INSERT INTO wa_plan_milestones (id,plan_task_id,milestone,status,implemented_by_task_id) VALUES ('m0','pt','M0','done','tA'),('m1','pt','M1','pending',NULL)").run();
dbm.prepare("INSERT INTO wa_tasks (id,project_id,title,status,quality_score,context_json) VALUES ('pt','p1','方案','completed',90,'{}')").run();
dbm.prepare("INSERT INTO wa_tasks (id,project_id,title,status,quality_score,context_json) VALUES ('tA','p1','落地任务A','completed',88,'{}')").run();
dbm.prepare("INSERT INTO wa_tasks (id,project_id,title,status,quality_score,context_json) VALUES ('tB','p1','任务B(已验收)','completed',82,'{\"acceptance_check\":{\"criteria_total\":2,\"passed_total\":2,\"checked_at\":\"2026-09-08\",\"passed\":[\"a\",\"b\"]}}')").run();
dbm.prepare("INSERT INTO wa_tasks (id,project_id,title,status,quality_score,context_json) VALUES ('tC','p1','任务C高质','completed',90,'{}')").run();
dbm.prepare("INSERT INTO wa_deliverables (id,project_id,task_id,name,type,status,is_primary,updated_at) VALUES ('d1','p1','tA','方案一.md','doc','completed',1,'2026-09-08')").run();
dbm.prepare("INSERT INTO wa_deliverables (id,project_id,task_id,name,type,status,is_primary,updated_at) VALUES ('d2','p1','tB','验收文档.md','doc','completed',0,'2026-09-08')").run();
dbm.prepare("INSERT INTO wa_deliverables (id,project_id,task_id,name,type,status,is_primary,updated_at) VALUES ('d3','p2','tC','别项目.doc','doc','completed',1,'2026-09-07')").run();

console.log('B1 交付单聚合语义');
const mDone = dbm.prepare("SELECT m.milestone AS milestone, m.implemented_by_task_id AS impl_task_id, t.title AS impl_title FROM wa_plan_milestones m JOIN wa_tasks pt ON pt.id=m.plan_task_id LEFT JOIN wa_tasks t ON t.id=m.implemented_by_task_id WHERE pt.project_id='p1' AND m.status='done' AND m.implemented_by_task_id IS NOT NULL").all();
ok(mDone.length === 1 && mDone[0].impl_task_id === 'tA' && mDone[0].impl_title === '落地任务A', 'B1 done 里程碑→落地任务(单跳数据齐)');
const rowsP = dbm.prepare("SELECT d.id AS deliverable_id, d.name, d.type, d.is_primary, d.task_id, t.title AS task_title, t.quality_score AS quality FROM wa_deliverables d JOIN wa_tasks t ON t.id=d.task_id WHERE d.project_id='p1' AND d.status!='retired'").all();
const accMap = new Map<string, { criteria_total: number; passed_total: number }>();
for (const row of dbm.prepare("SELECT id, context_json FROM wa_tasks WHERE project_id='p1'").all()) {
  try { const ac = JSON.parse(row.context_json||'{}').acceptance_check; if (ac?.checked_at) accMap.set(row.id, { criteria_total: Number(ac.criteria_total)||0, passed_total: Number(ac.passed_total)||0, checked_at: String(ac.checked_at) }); } catch { /* skip */ }
}
const primary = rowsP.filter(r => Number(r.is_primary) === 1);
// zx_20260913 M2-6: 类型判据直调共享 isAcceptanceType（doc/code），不在脚本内复刻第二份 'doc' 词表。
const verified = rowsP.filter(r => isAcceptanceType(r.type) && !!accMap.get(r.task_id as string)?.checked_at);
ok(primary.length === 1 && primary[0].deliverable_id === 'd1', 'B1 主要成果(is_primary=1) 聚合', `count=${primary.length}`);
ok(verified.length === 1 && verified[0].deliverable_id === 'd2', 'B1 已验收 doc 聚合(按任务 ctx acceptance)', `count=${verified.length}`);
const hq = dbm.prepare("SELECT id AS task_id, title, quality_score AS quality FROM wa_tasks WHERE project_id='p1' AND status='completed' AND quality_score>=80 ORDER BY updated_at DESC LIMIT 8").all();
ok(hq.length >= 3, 'B1 高质已完成任务(≥80)聚合', `count=${hq.length}`);

console.log('B2b primary 标记语义');
ok(dbm.prepare("SELECT COUNT(*) c FROM pragma_table_info('wa_deliverables') WHERE name='is_primary'").get().c === 1, 'B2b wa_deliverables.is_primary 列存在(迁移)');
dbm.prepare("UPDATE wa_deliverables SET is_primary = ?, updated_at = datetime('now') WHERE id = 'd2'").run(1);
ok(dbm.prepare("SELECT is_primary FROM wa_deliverables WHERE id='d2'").get().is_primary === 1, 'B2b setPrimary 切换可写');
ok(dbm.prepare("SELECT COUNT(*) c FROM wa_deliverables WHERE project_id='p1' AND is_primary=1").get().c === 2, 'B2b 项目内可多主要成果(交付单聚合随之更新)');

console.log('B2a 任务列表成果摘要派生语义');
const tl = dbm.prepare(`SELECT t.id,
  (SELECT COUNT(*) FROM wa_deliverables d WHERE d.task_id=t.id AND d.status!='retired') AS deliverable_count,
  (SELECT COUNT(*) FROM wa_deliverables d WHERE d.task_id=t.id AND d.status!='retired' AND d.is_primary=1) AS primary_count,
  json_extract(t.context_json,'$.acceptance_check.criteria_total') AS acc_total,
  json_extract(t.context_json,'$.acceptance_check.passed_total') AS acc_passed
  FROM wa_tasks t WHERE t.project_id='p1'`).all();
const b = tl.find((r: { id: string }) => r.id === 'tB') as { deliverable_count: number; acc_total: number | null; acc_passed: number | null };
ok(b.deliverable_count === 1 && b.acc_total === 2 && b.acc_passed === 2, 'B2a task:list 派生 deliverable_count + 验收 p/t', `count=${b.deliverable_count} acc=${b.acc_passed}/${b.acc_total}`);
const a = tl.find((r: { id: string }) => r.id === 'tA') as { deliverable_count: number; primary_count: number };
ok(a.deliverable_count === 1 && a.primary_count === 1, 'B2a task:list 派生 primary_count(★主)');

console.log('源码静态防回归');
const dts = rd('apps/worker-ant-desktop/src/main/database.ts');
ok(dts.includes('is_primary INTEGER DEFAULT 0') && dts.includes('wa_deliverables ADD COLUMN is_primary'), 'database 迁移 is_primary 在案');
ok(dts.includes('deliverable.show_delivery_digest') && dts.includes('deliverable.task_achievement_summary') && dts.includes('deliverable.primary_marker'), 'database 默认键 3 个 deliverable.* 在案');
const ipc = rd('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
ok(ipc.includes("ipcMain.handle('project:deliveryDigest'") && ipc.includes('milestonesDone') && ipc.includes('primaryDeliverables') && ipc.includes('verifiedDocs'), 'project.ipc project:deliveryDigest 在案');
// zx_20260911_2 M4-G1: 置★/清兄弟收敛到共享 applyPrimary（互斥语义单一实现）——断言改指 applyPrimary，判据(仍置 is_primary)不变
ok(ipc.includes("ipcMain.handle('deliverable:setPrimary'") && ipc.includes('applyPrimary(db,'), 'project.ipc deliverable:setPrimary 在案(置★经共享 applyPrimary)');
ok(ipc.includes('deliverable_count') && ipc.includes('acc_total') && ipc.includes('json_extract(t.context_json'), 'project.ipc task:list 成果摘要派生在案');
const dlp = rd('apps/worker-ant-desktop/renderer/src/pages/DeliverablesPage.tsx');
ok(dlp.includes('is_primary?: number') && dlp.includes('setPrimary') && dlp.includes('<Star'), 'DeliverablesPage primary 星标在案');
const tsp = rd('apps/worker-ant-desktop/renderer/src/pages/TasksPage.tsx');
ok(tsp.includes("['deliverable.task_achievement_summary']") && tsp.includes('deliverable_count') && tsp.includes('✓验收'), 'TasksPage 成果摘要 chip 在案');
const pdp = rd('apps/worker-ant-desktop/renderer/src/pages/ProjectDetailPage.tsx');
ok(pdp.includes('DeliveryDigestCard') && pdp.includes('<DeliveryDigestCard'), 'ProjectDetail 挂载 DeliveryDigestCard 在案');
const dd = rd('apps/worker-ant-desktop/renderer/src/components/DeliveryDigestCard.tsx');
ok(dd.includes('deliveryDigest') && dd.includes('milestonesDone') && dd.includes('primaryDeliverables') && dd.includes('highQualityTasks'), 'DeliveryDigestCard 消费 deliveryDigest 各段在案');
ok(dd.includes("['deliverable.show_delivery_digest']") && dd.includes("['deliverable.primary_marker']"), 'DeliveryDigestCard config 开关在案');

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
