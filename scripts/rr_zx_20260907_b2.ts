/**
 * zx_20260907 批2 受控复跑（node:sqlite 内存库语义 + 源码静态防回归；绝不触碰开发库；经桌面 node_modules/.bin/tsx 运行）。
 * B1 版本起点基线: write_file 新建 doc(.md/.txt/.py) → wa_deliverable_versions 落 v1(内容=首次写入, changed_by=taskId)；已存不补录；config 开可回退。
 * B2 验收透出: deliverable:list 同源派生产出任务 ctxJson.acceptance_check → acceptance{criteria_total,passed_total,checked_at}；DeliverablesPage doc 已核显徽标。
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
const dbm = new DatabaseSync(':memory:') as any;
dbm.exec(`CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT, name TEXT DEFAULT '', file_path TEXT, status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT);
CREATE TABLE wa_deliverable_versions (id TEXT PRIMARY KEY, deliverable_id TEXT, file_path TEXT NOT NULL, content_snapshot TEXT NOT NULL, size INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, changed_by TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT DEFAULT '{}');
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT);`);

// ---- 复刻 write_file 新建分支的 B1 语义（与 agent-executor 源码逻辑一致）----
function b1OnNewWrite(cfg: string | undefined, fp: string, content: string, taskId: string, deliverableId: string): void {
  if ((cfg ?? 'true') === 'false') return;                       // config 回退
  const docish = fp.endsWith('.md') || fp.endsWith('.txt') || fp.endsWith('.py');
  if (!docish) return;                                           // 仅文档类，避免过度落盘
  const vc = (dbm.prepare('SELECT COUNT(*) as c FROM wa_deliverable_versions WHERE deliverable_id = ?').get(deliverableId) as { c: number }).c;
  if (vc === 0) {                                                // 幂等：有基线不重复
    dbm.prepare('INSERT INTO wa_deliverable_versions (id, deliverable_id, file_path, content_snapshot, size, version, changed_by) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run('vv1', deliverableId, fp, content, content.length, taskId);
  }
}

console.log('B1 新建 doc 落 v1 基线语义');
dbm.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path) VALUES ('d1','p','t1','doc','方案','/x/a.md')").run();
b1OnNewWrite('true', '/x/a.md', '# 首次写入内容', 't1', 'd1');
const v1 = dbm.prepare("SELECT version, content_snapshot, size, changed_by, file_path FROM wa_deliverable_versions WHERE deliverable_id='d1' AND version=1").get() as { version: number; content_snapshot: string; size: number; changed_by: string; file_path: string } | undefined;
ok(!!v1, 'B1 新建 doc 落 v1 基线', v1 ? `version=${v1.version} size=${v1.size} changed_by=${v1.changed_by}` : '未落');
ok(v1?.content_snapshot === '# 首次写入内容', 'B1 v1 内容=首次写入');
ok(v1?.changed_by === 't1', 'B1 v1 changed_by=taskId');
// 幂等：已有 v1 不重复
b1OnNewWrite('true', '/x/a.md', '# 再次写入', 't1', 'd1');
const cnt1 = (dbm.prepare("SELECT COUNT(*) c FROM wa_deliverable_versions WHERE deliverable_id='d1'").get() as { c: number }).c;
ok(cnt1 === 1, 'B1 幂等：已存在 v1 不重复插入', `count=${cnt1}`);
// 非文档扩展名不落
dbm.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path) VALUES ('d2','p','t1','doc','资产','/x/logo.ts')").run();
b1OnNewWrite('true', '/x/logo.ts', 'export const a=1;', 't1', 'd2');
const cnt2 = (dbm.prepare("SELECT COUNT(*) c FROM wa_deliverable_versions WHERE deliverable_id='d2'").get() as { c: number }).c;
ok(cnt2 === 0, 'B1 非文档扩展名(.ts)不落 v1', `count=${cnt2}`);
// config false → 关闭
dbm.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path) VALUES ('d3','p','t1','doc','方案','/x/c.md')").run();
b1OnNewWrite('false', '/x/c.md', '# x', 't1', 'd3');
const cnt3 = (dbm.prepare("SELECT COUNT(*) c FROM wa_deliverable_versions WHERE deliverable_id='d3'").get() as { c: number }).c;
ok(cnt3 === 0, 'B1 config 关闭(deliverable.first_write_v1=false)不落', `count=${cnt3}`);

console.log('B2 验收透出派生语义');
// 产出任务带验收证据 → 派生 acceptance
dbm.prepare("INSERT INTO wa_tasks (id, context_json) VALUES ('t1', ?)").run(JSON.stringify({ acceptance_check: { checked_at: '2026-09-07T01:00:00Z', criteria_total: 3, passed_total: 3, passed: ['a', 'b', 'c'], failed: [] } }));
dbm.prepare("INSERT INTO wa_tasks (id, context_json) VALUES ('t2', '{}')").run();
// 复刻 project.ipc 派生循环
const accMap = new Map<string, { criteria_total: number; passed_total: number; checked_at: string }>();
const ctxRows = dbm.prepare('SELECT id, context_json FROM wa_tasks WHERE id IN (?,?)').all('t1', 't2') as Array<{ id: string; context_json: string }>;
for (const row of ctxRows) {
  const ac = (JSON.parse(row.context_json || '{}') as { acceptance_check?: { criteria_total?: number; passed_total?: number; checked_at?: string } }).acceptance_check;
  if (ac && typeof ac === 'object' && ac.checked_at) accMap.set(row.id, { criteria_total: Number(ac.criteria_total) || 0, passed_total: Number(ac.passed_total) || 0, checked_at: String(ac.checked_at) });
}
const a1 = accMap.get('t1');
ok(!!a1 && a1.criteria_total === 3 && a1.passed_total === 3 && !!a1.checked_at, 'B2 已验收任务派生 acceptance{p,t,checked_at}', a1 ? JSON.stringify(a1) : '');
ok(!accMap.has('t2'), 'B2 无 acceptance_check 任务不派生');
// 全过判据：passed_total===criteria_total → 徽标"已验收"(与 renderer accAllPass 同源)
ok(!!a1 && a1.criteria_total > 0 && a1.passed_total >= a1.criteria_total, 'B2 passed===total 即"✓已验收"判定');

console.log('源码静态防回归');
const dts = rd('apps/worker-ant-desktop/src/main/database.ts');
ok(dts.includes("'deliverable.first_write_v1'") && /ensureSetting\('deliverable\.first_write_v1', 'true'\)/.test(dts), 'database 默认键 deliverable.first_write_v1=true');
ok(dts.includes("'deliverable.show_acceptance'") && /ensureSetting\('deliverable\.show_acceptance', 'true'\)/.test(dts), 'database 默认键 deliverable.show_acceptance=true');
const ae = engineSrc();
ok(ae.includes("'deliverable.first_write_v1'") && ae.includes("!existedBefore && deliverableId"), 'agent-executor write_file 新建分支 B1 在案(新文件+已注册)');
ok(ae.includes('content_snapshot, size, version, changed_by) VALUES (?, ?, ?, ?, ?, 1, ?)'), 'agent-executor v1 基线插入 SQL 在案(version=1)');
ok(ae.includes("args.content, args.content.length, taskId"), 'agent-executor v1 内容=首次写入(args.content)·changed_by=taskId');
ok(ae.includes("fp.endsWith('.md') || fp.endsWith('.txt') || fp.endsWith('.py')"), 'agent-executor B1 仅文档类扩展名守卫');
const ipc = rd('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
ok(ipc.includes("'deliverable.show_acceptance'") && ipc.includes('.acceptance = a'), 'project.ipc deliverable:list 验收派生在案(回退开关+acceptance 下发; zx_20260909_1 M3 改 per-doc 读位带类型转换赋值)');
ok(ipc.includes('acceptance_check'), 'project.ipc 派生源 ctxJson.acceptance_check 在案');
const page = rd('apps/worker-ant-desktop/renderer/src/pages/DeliverablesPage.tsx');
// zx_20260913 M2-6: 判据由手抄 `d.type === 'doc'` 收敛为共享 isAcceptanceType(doc/code)，
// 故此处改钉新谓词 + 其真源导入（旧字面量已按本轮方案删除，钉旧串即钉一段不存在的代码）。
ok(page.includes('acceptance') && page.includes('已验收') && page.includes('isAcceptanceType(d.type) && d.acceptance?.checked_at')
  && page.includes("import { isAcceptanceType, isPreviewType } from '../../../src/main/core/deliverable-types.js'"),
  'DeliverablesPage 已核徽标消费在案（判据=共享 isAcceptanceType，非手抄字面量）');

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
