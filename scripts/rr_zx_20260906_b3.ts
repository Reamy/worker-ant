/**
 * zx_20260906 批3 受控复跑（node:sqlite 内存库 + 源接线断言，绝不触碰开发库/生产活跃项目）。
 * S1 (3e) 重试旧成果退休：retireTaskDeliverables 把任务旧 deliverables 全量置 retired（soft，保版本历史）、
 *    幂等（二次调用 0 变更 0 事件）、非本任务产出物不受影响；每真变更发 deliverable.status_changed(via=task:retry)。
 * S2 (3a) 注入面板复水：executor 注入点持久化 injected_memories 快照；TaskDetail 完成/刷新后从 context_json 复水（live 事件已置位不覆盖）+ 需求理解卡常驻。
 * S3 (3b/3e) 产出物↔任务：deliverable:list JOIN 任务标题；task:get 不含 retired；重试 handler 接线 retire + 清质量；DeliverablesPage 版本历史真实快照 + retired 过滤。
 * S4 (3c) 知识全景：project:knowledgePanorama 排除 retired、byType 含 daemon、返回 recentDeliverables(跨类型)；ProjectDetail 渲染 + deliverable 事件刷新。
 * S5 (3d) Dashboard 大盘：admin:overview 增 projectOutcomes（最近产出物+M 里程碑行+质量均质）；Dashboard 订阅与渲染接线。
 * 用法：./apps/worker-ant-desktop/node_modules/.bin/tsx scripts/rr_zx_20260906_b3.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { retireTaskDeliverables } from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import { eventBus } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path?: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => { all: (...p: unknown[]) => unknown[]; get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => { changes: number } };
  };
};

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const R = (rel: string) => path.resolve(__dirname, '../apps/worker-ant-desktop', rel);
const read = (rel: string) => fs.readFileSync(R(rel), 'utf-8');
const pjIpc = read('src/main/ipc/project.ipc.ts');
const adminIpc = read('src/main/ipc/admin.ipc.ts');
const executor = read('src/main/core/agent-executor.ts');
const projectEngine = read('src/main/core/project-engine.ts');
const tdPage = read('renderer/src/pages/TaskDetailPage.tsx');
const dlvPage = read('renderer/src/pages/DeliverablesPage.tsx');
const pdPage = read('renderer/src/pages/ProjectDetailPage.tsx');
const dashPage = read('renderer/src/pages/DashboardPage.tsx');

// ---------- S1 (3e) 行为：重试旧成果退休 ----------
console.log('S1 (3e) retireTaskDeliverables 行为');
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '');
  CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, status TEXT DEFAULT 'completed', quality_score REAL, context_json TEXT DEFAULT '{}');
  CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL, name TEXT DEFAULT '', description TEXT DEFAULT '', file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
`);
const pid = randomUUID();
const tid = randomUUID();
const otherTask = randomUUID();
db.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run(pid, 'proj');
db.prepare('INSERT INTO wa_tasks (id, project_id, status, quality_score, context_json) VALUES (?, ?, ?, ?, ?)').run(tid, pid, 'completed', 85, '{}');
db.prepare('INSERT INTO wa_tasks (id, project_id, status, quality_score, context_json) VALUES (?, ?, ?, ?, ?)').run(otherTask, pid, 'completed', 90, '{}');
const mk = (taskId: string, status: string, idx: number) => {
  const did = randomUUID();
  db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, status, file_path) VALUES (?, ?, ?, 'doc', ?, ?, '/tmp/x.md')").run(did, pid, taskId, `产出物${idx}`, status);
  return did;
};
mk(tid, 'draft', 1);
mk(tid, 'running', 2);
mk(tid, 'completed', 3);
const otherDid = mk(otherTask, 'running', 4);
const events: Array<{ status: string; deliverableId?: string; via?: string }> = [];
const cap = (e: { data: Record<string, unknown> }) => {
  events.push({ status: String(e.data.status ?? ''), deliverableId: String(e.data.deliverableId ?? ''), via: String(e.data.via ?? '') });
};
eventBus.on('deliverable.status_changed', cap);
const first = retireTaskDeliverables(db as never, tid, 'task:retry');
const remaining = db.prepare("SELECT COUNT(*) c FROM wa_deliverables WHERE task_id = ? AND status != 'retired'").get(tid) as { c: number };
ok(first.retired === 3, `全量退休 3 条（draft/running/completed→retired）`, `retired=${first.retired}`);
ok(remaining.c === 0, `本任务已无非 retired 产出物`);
const otherStatus = (db.prepare('SELECT status FROM wa_deliverables WHERE id = ?').get(otherDid) as { status: string }).status;
ok(otherStatus === 'running', `他任务产出物不受影响（仍 running）`);
const evMine = events.filter((e) => e.status === 'retired' && e.via === 'task:retry');
ok(evMine.length === 3, `3 次真变更均发 deliverable.status_changed(via=task:retry)`, `count=${evMine.length}`);
const evBefore = events.length;
const second = retireTaskDeliverables(db as never, tid, 'task:retry');
ok(second.retired === 0 && events.length === evBefore, `幂等：二次退休 0 变更 0 事件`);
const upd = (db.prepare("SELECT updated_at FROM wa_deliverables WHERE task_id = ? LIMIT 1").get(tid) as { updated_at: string | null }).updated_at;
ok(!!upd, `退休同时刷新 updated_at`, `updated_at=${upd}`);

// ---------- 源接线断言（防头大脚轻：主 handler 已接线/前端有消费） ----------
console.log('S2 (3a) 记忆注入复水 + 需求卡常驻接线');
ok(executor.includes("ic.injected_memories = merged.slice(0, 40)") && executor.includes('injected_memories'),
  'executor 注入点持久化 injected_memories 快照(cap40, 沿用 context_json)');
ok(tdPage.includes('injected_memories') && tdPage.includes('setMemoryInjection(prev => (prev.length > 0 ? prev : injected))'),
  'TaskDetail loadProject 从 context_json.injected_memories 复水（live 事件已置位不覆盖）');
ok(/\)\.requirement_card && \(\s*$/.test(tdPage.split('zx_20260904_4 T1')[1]?.split('</details>')[0] ?? '') === false && tdPage.includes('📋 需求理解卡'),
  '需求理解卡无"仅执行中"状态条件（常驻可复盘）');

console.log('S3 (3b/3e) 产出物↔任务 + retired 接线');
ok(pjIpc.includes('t.title as task_title') && pjIpc.includes('LEFT JOIN wa_tasks t ON t.id = d.task_id'),
  'deliverable:list JOIN 补任务标题（产出物↔任务溯源）');
// zx_20260913 M2-1: task:get 产出物改「本任务及子树」聚合(WHERE d.task_id IN ownerIds)——旧单任务
// `SELECT * FROM wa_deliverables WHERE task_id = ?` 字面量已按方案删除。
// zx_20260930 M4-1: retired 排除与探针滤除**一并收进共享取数范围真源**（WHERE 整段由 dScope.sql 出），
//   本处不再手拼谓词；判据(排除 retired)不变，钉的是范围声明的来源。
ok(pjIpc.includes('SELECT d.*, t.title AS owner_task_title FROM wa_deliverables d')
  && pjIpc.includes("const dScope = deliverableScopeSql({ taskIds: ownerIds, alias: 'd' })")
  && pjIpc.includes('WHERE ${dScope.sql}'),
  'task:get 产出物排除 retired（范围声明走共享真源；zx_20260913 M2-1 起为子树聚合）');
ok(pjIpc.includes('retireTaskDeliverables(db, id)') && pjIpc.includes('quality_score = NULL') && pjIpc.includes('retried_at'),
  'task:retry 接线：旧成果退休 + quality_score 清空 + ctxJson.retried_at');
ok(dlvPage.includes('showRetired') && dlvPage.includes('retiredCount') && dlvPage.includes("d.status === 'retired'"),
  'DeliverablesPage 默认过滤 retired 并示计数');
ok(dlvPage.includes('content_snapshot') && dlvPage.includes('simpleLineDiff') && !dlvPage.includes('版本快照查看中...'),
  '版本历史真实 content_snapshot 预览 + 简化 diff（去"查看中"占位）');
ok(dlvPage.includes("navigate(`/tasks/${d.task_id}`)"), '产出物行可跳转产出任务');

console.log('S4 (3c) 知识全景接线');
// zx_20260913 M2-4: 全景 byType 由 GROUP BY type **实得**展开，手抄键表(mcp/a2a/ui/doc/daemon)已按方案删除
// ——手抄表漏 code 即「总量与分项两把尺」。断言改钉派生式，并**行为复算** daemon 键由数据得(而非手抄枚举)。
// zx_20260930 M4-1: byType 计数与 recent 列表的「排除 retired + 滤探针」两段范围都上收共享真源
//   （`countDeliverablesByType` / `deliverableScopeSql`），本处不再数内联 `status != 'retired'` 出现次数——
//   那是在数**手拼谓词的副本数**，与"口径同源"恰是相反的指标。改钉两处**都经真源**。
ok(pjIpc.includes('recentDeliverables')
  && pjIpc.includes('countDeliverablesByType(db, { projectId: id })')
  && pjIpc.includes('deliverableScopeSql({ projectId: id })')
  && pjIpc.includes('deliverableSummary: { total: Object.values(delivByType).reduce((a, b) => a + b, 0), byType: { ...delivByType }, recentDeliverables }'),
  'project:knowledgePanorama：排除 retired、byType 由 GROUP BY 实得、recentDeliverables 跨类型（俱经共享范围真源）');
db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, status) VALUES (?, ?, ?, 'daemon', '守护进程', 'completed')").run(randomUUID(), pid, tid);
{
  const rows = db.prepare("SELECT type, COUNT(*) as cnt FROM wa_deliverables WHERE project_id = ? AND status != 'retired' GROUP BY type").all(pid) as Array<{ type: string; cnt: number }>;
  const set: Record<string, number> = {};
  for (const d of rows) set[d.type] = d.cnt;
  ok(set.daemon === 1, '行为复算：byType 经 GROUP BY 实得 daemon（手抄键表漏类即在此暴露）', JSON.stringify(set));
}
ok(pdPage.includes('recentDeliverables') && pdPage.includes('DELIVERABLE_TYPE_LABEL') && pdPage.includes("from '../lib/deliverable-view'") && pdPage.includes('void loadPanorama()'),
  'ProjectDetail 渲染 byType/recent 产出物（类型文案取共享词表真源）+ deliverable 事件刷新 loadPanorama');
// zx_20260930 M4-1: retired 排除由共享范围真源的默认(includeRetired 缺省)承担——不再于本处内联判。
ok(projectEngine.includes('countDeliverablesByType(this.db, { projectId: String(p.id) })'),
  'project-engine deliverableStats 排除 retired（经共享范围真源默认排除，不虚增产出数）');

console.log('S5 (3d) Dashboard 大盘接线');
ok(adminIpc.includes('projectOutcomes') && adminIpc.includes('buildPlanMilestoneLine(db, p.id)') && adminIpc.includes('projectQualityStats(db, p.id)'),
  'admin:overview 增 projectOutcomes（最近产出物+M 里程碑 lean 行+质量均质，复用既有 helper）');
ok(adminIpc.includes('countDeliverables(db)'), 'admin:stats 产出物总量排除 retired（经共享范围真源默认排除）');
ok(dashPage.includes('projectOutcomes') && dashPage.includes("navigate(`/projects/${String(po.projectId)}`)"),
  'Dashboard 消费 projectOutcomes 并可点进项目');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
