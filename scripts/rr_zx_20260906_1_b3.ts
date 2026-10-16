/**
 * zx_20260906_1 批3 受控复跑（node:sqlite 内存库 + 源码静态防回归；绝不触碰开发库；用法同 rr_zx_20260906_1_b1.ts）。
 * S1 3c 临时探针排除语义（运行时）：temp doc(**显式前缀** _verify/_probe/_tmp)不计入 total；真实 doc/mcp 计入。
 *    （`test_<6 位十六进制>.py` 形状判据已于 zx_20260916_3 M2 按 D3 裁定删除，见下方 PRED 注）
 * S2 3c 探针排除已接线：project-engine deliverableStats、admin:stats、project:knowledgePanorama delivStats 三处含排除谓词。
 * S3 3a 列表数据位/排序：deliverable:list JOIN task_quality_score；write_file 覆盖写 bump updated_at。
 * S4 3a/3b 页面能力：DeliverablesPage 有 质量/最近变更列、状态/时间窗筛选、可排序列头(静态锚)。
 * S5 3d preview 溯源：project.ipc preview 回传 file_exists/file_mode。
 * S6 3e 信息差闭环：task:get 回传 retiredCount（zx_20260914 M2-3② 起与成果列表同集合，含子树）；TaskDetail 退休提示；
 *    ProjectDetail/Dashboard M chip 可点进落地任务。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => { exec: (s: string) => void } };
import { docNotProbe } from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import { engineSrc } from './lib/rr-engine-src.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const app = (...s: string[]) => fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop', ...s), 'utf-8');
// zx_20260909 X2③: 谓词改 COALESCE(file_path,name) 且去掉 'file_path IS NULL' 短路——file_path NULL 但 name 含探针特征(_tmp/_probe/_verify)亦排除(实库 name-only 漏网); 真实 doc(file 或 name 正常)仍计入
// zx_20260916_3 M2（D3 裁定）: 本行此前是**手抄的谓词副本**（含 `test_<6 位十六进制>.py` 形状 GLOB）。该 GLOB 已按裁定整条删除
//   （系统性误伤 a-stock 全部 7 个 `test_a2026*_m<N>_*.py` 真测试脚本，§1.2-②），手抄副本随之**不再手抄**——直接引生产真源，
//   否则本脚本会成为"第二把尺"，且是一把**过期**的尺。反证（旧 GLOB 确会误判）在新脚本 `scripts/rr_zx_20260916_3.ts` §B-3。
const PRED = `(type != 'doc' OR ${docNotProbe('')})`;

console.log('S1 3c 临时探针排除语义(运行时)');
const db = new DatabaseSync(':memory:') as unknown as { prepare: (s: string) => { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => { changes: number } } };
db.exec("CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, type TEXT, name TEXT, status TEXT, file_path TEXT);");
const ins = db.prepare("INSERT INTO wa_deliverables (id, project_id, type, name, status, file_path) VALUES (?, 'p', ?, ?, 'completed', ?)");
ins.run('a', 'doc', 'a', '/work/_verify_check.py');
ins.run('b', 'doc', 'b', '/work/_probe_x.py');
ins.run('c', 'doc', 'c', '/work/_tmp_t.py');
// zx_20260916_3 M2: 此条**判据已翻面**——`test_abcd1234.py` 除"名字像随机命名"外无任何探针宣告，
//   旧 GLOB 判它为探针（正是 a-stock 7 个真测试脚本被系统性误伤的同一条规则），现判为**真实产出**（计入）。
ins.run('d', 'doc', 'd', '/work/test_abcd1234.py');
ins.run('e', 'doc', 'e', '/work/report.md');           // 真实 doc
ins.run('f', 'mcp', 'f', null);                        // 服务
ins.run('g', 'doc', '/work/_tmp_g_nameonly.py', null); // X2③: file_path NULL 但 name 探针 → 亦排除
const total = (db.prepare(`SELECT COUNT(*) as c FROM wa_deliverables WHERE status != 'retired' AND ${PRED}`).get() as { c: number }).c;
ok(total === 3, 'temp 探针(显式前缀 3 类 + name-only 1)不计入，真实 doc×2 + mcp 计入(共3)', `total=${total}`);

console.log('S2 3c 排除谓词接线(静态)');
const pe = app('src/main/core/project-engine.ts');
const adm = app('src/main/ipc/admin.ipc.ts');
const prj = app('src/main/ipc/project.ipc.ts');
// zx_20260930 M4-1: 谓词**进一步上收**——三处不再各自拼 `(type != 'doc' OR docNotProbe(...))`，
//   而是调共享**取数范围真源**（`deliverableScopeSql`/`countDeliverables`/`countDeliverablesByType`）。
//   判据(探针不计入成果数)一字不变，钉的东西更强：从"引了那把尺"升为"连谓词组合都不在自己手里"。
ok(pe.includes('countDeliverablesByType(this.db, { projectId: String(p.id) })'), 'project-engine deliverableStats 经共享取数范围真源计数');
// zx_20260930 M4-1: 同上——admin 侧由 `docNotProbe()` 升为共享计数出口，并保留反向断言(内联字面量不在本文件)
ok(adm.includes('countDeliverables(db)'), 'admin:stats totalDeliverables 经共享取数范围真源计数');
ok(!adm.includes("file_path NOT LIKE '%/_verify%'"), 'admin.ipc 不再内联探针字面量(真源唯一)');
ok(prj.includes('countDeliverablesByType(db, { projectId: id })'), 'knowledgePanorama delivStats 经共享取数范围真源分组(zx_20260930 M4-1 进一步上收)');

console.log('S3 3a 列表数据位/updated_at 语义');
ok(prj.includes('t.quality_score as task_quality_score'), 'deliverable:list JOIN 回传 task_quality_score');
ok(engineSrc().includes("UPDATE wa_deliverables SET updated_at = datetime('now') WHERE id = ?"), 'write_file 覆盖写 bump updated_at');

console.log('S4 3a/3b 页面能力(静态)');
const dp = app('renderer/src/pages/DeliverablesPage.tsx');
ok(dp.includes('task_quality_score') && dp.includes('最近变更'), '列表质量/最近变更数据位');
ok(dp.includes('filterStatus') && dp.includes('recentDays') && dp.includes('toggleSort'), '状态/时间窗筛选 + 排序列头');
ok(dp.includes("'任务完成'") && dp.includes('d.task_status'), '产出任务状态 chip(区分 任务完成/进行中/失败)');
ok(dp.includes('质量列(产出任务质量分') , '质量列渲染锚');
ok(dp.includes('最近内容/状态变更时间'), '最近变更列渲染锚');

console.log('S5 3d preview 溯源诚实(静态)');
ok(prj.includes('file_exists: fileExists') && prj.includes('file_mode'), 'preview 回传 file_exists/file_mode');
ok(dp.includes('磁盘文件已缺失/被移动'), '预览弹窗 文件缺失显式提示');

console.log('S6 3e 信息差闭环(静态)');
// zx_20260914 M2-3②: 退休计数改与成果列表**同集合**(task_id IN ownerIds，含子树)——断言锚定该 SQL 的形状，
//   不再钉旧字面量 `task_id = ?`（那正是"同一页两把尺"的病根）
const rcSql = /const retiredCount = \(db\.prepare\(`([^`]*)`\)/.exec(prj)?.[1] || '';
ok(rcSql.includes("status = 'retired'") && /task_id IN \(\$\{ownerIds/.test(rcSql), 'task:get 回传 retiredCount(与成果列表同集合 task_id IN ownerIds)', rcSql.slice(0, 140));
const td = app('renderer/src/pages/TaskDetailPage.tsx');
ok(td.includes('retiredCount') && td.includes('项旧成果已退休'), 'TaskDetail 空成果退休透出');
const pdPage = app('renderer/src/pages/ProjectDetailPage.tsx');
ok(pdPage.includes('m.impl') && pdPage.includes('打开落地任务'), 'ProjectDetail M chip 可点进落地任务');
const dash = app('renderer/src/pages/DashboardPage.tsx');
ok(dash.includes('po.milestoneList') && dash.includes('m.impl ? String(m.impl)'), 'Dashboard milestoneList 结构化可点进落地任务');
ok(adm.includes('milestoneList') && adm.includes('m.implemented_by_task_id AS impl'), 'admin:overview 回传 milestoneList(含 impl)');

console.log(`结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
