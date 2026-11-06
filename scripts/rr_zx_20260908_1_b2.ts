/**
 * zx_20260908_1 批2 受控复跑（node:sqlite 内存库语义 + 源码静态防回归；绝不触碰开发库；tsx 运行）。
 * B1 成果交付单时间窗归口: project:deliveryDigest 可选 window('30'/'7'=近N天/'all'=全部)——done里程碑(以落地任务 updated_at 为锚)/已验收doc/高质任务按窗过滤, primary 累计位不受窗; renderer 加切换条, deliverable.digest_window_switch 开关。
 * B2 finalize 自动落首个 primary: 验收全过后该任务非 retired 产出无 primary → 自动把最新验收 doc 置 is_primary=1(可人工撤, 撤后不再自动覆盖), deliverable.primary_auto 开关。
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
dbm.exec(`CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, type TEXT, status TEXT, is_primary INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT, quality_score INTEGER, updated_at TEXT);
CREATE TABLE wa_plan_milestones (id TEXT, plan_task_id TEXT, project_id TEXT, milestone TEXT, status TEXT, implemented_by_task_id TEXT);`);

console.log('B2 自动 primary 语义(finalize 验收全过 → 无 primary 则置最新 doc; 已有则不覆盖)');
dbm.prepare("INSERT INTO wa_deliverables (id,task_id,type,status,is_primary,created_at,updated_at) VALUES ('d1','t1','doc','draft',0,datetime('now','-1 hour'),datetime('now','-1 hour')),('d2','t1','doc','draft',0,datetime('now'),datetime('now'))").run();
// 复刻 agent-executor B2: 若 priCnt==0 → 取 type=doc 且 status in(draft/registered/completed) 最新 created_at 置 primary
function autoPrimaryIfNone(taskId: string): void {
  const priCnt = dbm.prepare("SELECT COUNT(*) c FROM wa_deliverables WHERE task_id=? AND status!='retired' AND is_primary=1").get(taskId).c;
  if (priCnt === 0) {
    const cand = dbm.prepare("SELECT id FROM wa_deliverables WHERE task_id=? AND type='doc' AND status IN ('draft','registered','completed') ORDER BY created_at DESC, rowid DESC LIMIT 1").get(taskId);
    if (cand) dbm.prepare("UPDATE wa_deliverables SET is_primary=1, updated_at=datetime('now') WHERE id=?").run(cand.id);
  }
}
autoPrimaryIfNone('t1');
ok(dbm.prepare("SELECT is_primary p FROM wa_deliverables WHERE id='d2'").get().p === 1, 'B2 无 primary → 自动把最新 doc(d2) 置 is_primary=1');
ok(dbm.prepare("SELECT COUNT(*) c FROM wa_deliverables WHERE task_id='t1' AND is_primary=1").get().c === 1, 'B2 仅置一条 primary(不覆盖/不重复)');
autoPrimaryIfNone('t1');
ok(dbm.prepare("SELECT COUNT(*) c FROM wa_deliverables WHERE task_id='t1' AND is_primary=1").get().c === 1, 'B2 二次 finalize 已有 primary 不重复置/不换标');
dbm.prepare("UPDATE wa_deliverables SET is_primary=0 WHERE id='d2'").run();
autoPrimaryIfNone('t1');
ok(dbm.prepare("SELECT is_primary p FROM wa_deliverables WHERE id='d2'").get().p === 1, 'B2 人工撤后(清零)再次收口可自动补回(仍最新 doc)');

console.log('B1 时间窗语义(done里程碑/高质任务/已验收doc 按窗, primary 累计不受窗)');
dbm.prepare("INSERT INTO wa_tasks (id,project_id,title,status,quality_score,updated_at) VALUES ('tt1','p','old', 'completed', 90, datetime('now','-60 days')),('tt2','p','new','completed',92,datetime('now','-2 days'))").run();
dbm.prepare("INSERT INTO wa_plan_milestones (id,plan_task_id,project_id,milestone,status,implemented_by_task_id) VALUES ('m1','plan1','p','M1','done','tt1'),('m2','plan2','p','M2','done','tt2')").run();
function inWin(ts: string | null, sinceDays: number): boolean {
  if (sinceDays <= 0) return true;
  if (!ts) return false;
  // 与 project.ipc inWindow 同步的时区感知版(2026-09-09 修): 兼容 ISO-Z 与 SQLite 空格格式——旧写法无条件 +'Z' 致 ISO '…ZZ' Invalid Date
  const s = String(ts).trim();
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const ms = new Date(hasZone ? s : s.replace(' ', 'T') + 'Z').getTime();
  return !isNaN(ms) && ms >= Date.now() - sinceDays * 86_400_000;
}
const newTaskUpdated = dbm.prepare("SELECT updated_at FROM wa_tasks WHERE id='tt2'").get().updated_at;
const oldTaskUpdated = dbm.prepare("SELECT updated_at FROM wa_tasks WHERE id='tt1'").get().updated_at;
const ts10 = new Date(Date.now() - 10 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19); // 10 天前(UTC, 与 DB datetime 同格式)
ok(inWin(newTaskUpdated, 7) && !inWin(oldTaskUpdated, 7), 'B1 近7天: 窗内任务(tt2)保留/窗外(tt1 60天前)过滤');
ok(inWin(ts10, 30) && !inWin(ts10, 7), 'B1 近30天含 10天前, 近7天不含 10天前(窗边界正确)');
ok(inWin(oldTaskUpdated, 90), 'B1 近90天含 60天前任务');
ok(inWin(newTaskUpdated, 0) && inWin(oldTaskUpdated, 0), 'B1 all/缺省=全部(不过滤)');
// B1 里程碑锚=落地任务 updated_at(实库落 ISO-Z '2026-09-04T01:02:48.582Z')——旧 inWindow 拼 '…ZZ' 误滤(实机缺陷 2026-09-09): 时区感知后 ISO-Z 窗内须保留
const isoIn = new Date(Date.now() - 2 * 86_400_000).toISOString();          // 2 天前 ISO-Z
const isoOld = new Date(Date.now() - 60 * 86_400_000).toISOString();        // 60 天前 ISO-Z
ok(inWin(isoIn, 7) === true, 'B1 ISO-Z 窗内里程碑保留(修复: 不再因 …ZZ Invalid Date 误滤)', isoIn);
ok(inWin(isoIn, 30) === true, 'B1 ISO-Z 窗内里程碑近30天保留');
ok(inWin(isoOld, 7) === false && inWin(isoOld, 90) === true, 'B1 ISO-Z 窗外里程碑排除(60天前近7无/近90有)');
const naiveMs = new Date(String(isoIn).replace(' ', 'T') + 'Z').getTime();
ok(Number.isNaN(naiveMs), 'B1 旧写法对 ISO-Z 无条件 +Z → Invalid Date(证明本缺陷被时区感知版修复覆盖)');
// 高质任务窗内只统计新(tt2): where updated_at > datetime(now,-7 days)
const hq7 = dbm.prepare("SELECT id FROM wa_tasks WHERE project_id='p' AND status='completed' AND quality_score>=80 AND updated_at > datetime('now','-7 days')").all();
ok(hq7.length === 1 && hq7[0].id === 'tt2', 'B1 高质任务近7天仅含 tt2(窗外 tt1 不计)');

console.log('config 默认键');
const dts = rd('apps/worker-ant-desktop/src/main/database.ts');
ok(dts.includes("deliverable.digest_window_switch") && dts.includes("deliverable.primary_auto"), 'database 默认键 digest_window_switch/primary_auto=true');

console.log('源码静态防回归');
const pi = rd('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
ok(pi.includes("window: windowArg") && pi.includes("sinceDays") && pi.includes("inWindow"), 'project.ipc deliveryDigest 加 window 参数+inWindow 过滤在案');
ok(pi.includes("impl_updated") && pi.includes("primaryDeliverables") && pi.includes("milestonesDone.filter"), 'project.ipc 里程碑按落地任务 updated_at 过滤 + primary 累计保留');
const ae = engineSrc();
// zx_20260911_2 M4-G2: 自动 primary 抽取为 autoAssignPrimary（finalize + update_task_status 两出口共用）——断言改指共享实现，判据不变
const dlc = rd('apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.ts');
ok(dlc.includes("key = 'deliverable.primary_auto'") && dlc.includes("status != 'retired' AND is_primary = 1"), 'autoAssignPrimary 自动 primary(无 primary 才置)在案');
// zx_20260915 P0-8(b): 候选查询改带表别名 `d`（排序里要 JOIN 派生列），"取最新"前先插一列
//   「本任务 file.created 命中优先」（事件派生，方案 §8.3(b)）——判据(无 ★ 才置、探针滤除、非 retired)不变。
// zx_20260924_1 M5-a(一处真源): 置位动作**改走 `applyPrimary`**——原先此处的第二条内联写法
//   （只置自己、不清兄弟）正是"已退休 ★ + 自动置位 ⇒ 同作用域两行 is_primary=1"的病根。
//   **改钉更强的真源**（不是放宽）：判据从"文件里某处有条内联 UPDATE 串"升级为
//   "`autoAssignPrimary` 的**函数体内**不再有内联置位、且必须经 `applyPrimary` 落地"——
//   按**符号**切出函数体（不按行号，行号是位置会漂），故顺手也能挡住"在别处再抄一条内联置位"。
//   排序基线那一半判据原样保留。
const iAA = dlc.indexOf('export function autoAssignPrimary');
const iAfter = dlc.indexOf('export function selectProbeDeliverables');
const aaBody = iAA >= 0 && iAfter > iAA ? dlc.slice(iAA, iAfter) : '';
ok(aaBody.length > 0, 'autoAssignPrimary 函数体可按符号切出（锚点按符号，不按行号）');
ok(!aaBody.includes("SET is_primary = 1") && /applyPrimary\(db,\s*cand,\s*1\)/.test(aaBody),
  'autoAssignPrimary 落位改走 applyPrimary（体内已无内联 `SET is_primary = 1`——它不清兄弟，是两 ★ 并存病根）');
ok(dlc.includes("ORDER BY d.created_at DESC, d.rowid DESC"), 'autoAssignPrimary 排序基线仍是 created_at DESC（「新建优先」派生列另插在前）');
ok((ae.match(/autoAssignPrimary\(db, /g) || []).length === 2, 'agent-executor 两出口(finalize + update_task_status)接线 autoAssignPrimary 在案');
const ddc = rd('apps/worker-ant-desktop/renderer/src/components/DeliveryDigestCard.tsx');
ok(ddc.includes("digest_window_switch") && ddc.includes("近30天") && ddc.includes("setWin("), 'DeliveryDigestCard 窗口切换条(受开关门控)在案');
const ipc = rd('apps/worker-ant-desktop/renderer/src/lib/ipc.ts');
ok(ipc.includes("deliveryDigest: (id: string, window?: string)") && ipc.includes("window: window ?? 'all'"), 'renderer 桥 deliveryDigest 透传 window 参数');

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
