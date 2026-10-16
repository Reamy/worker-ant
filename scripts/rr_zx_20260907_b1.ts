/**
 * zx_20260907 批1 受控复跑（node:sqlite 内存库语义 + 源码静态防回归；绝不触碰开发库；tsx 运行，用法同 rr_zx_20260906_2_b1.ts）。
 * A1 归档池保留期: memory.archive_retention_days(默认90;0=关闭) → 过期 archived 清理,幂等,关闭时不删。
 * A2 验收→可复用配方: finalize 验收通过 + doc 产出 → storeText(semantic·outcome_exemplar·reusableExperience) + importance≥0.8 + markExemplar('good', outcome_success)。
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
dbm.exec(`CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT, memory_type TEXT, importance REAL DEFAULT 0.5, valence TEXT, source TEXT, reusable_experience INTEGER, is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT, exemplar_context TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);`);

console.log('A1 归档保留期清理语义');
dbm.prepare("INSERT INTO wa_memories (id, project_id, content, memory_type, created_at) VALUES ('old1','p','a','archived',datetime('now','-95 days'))").run();
dbm.prepare("INSERT INTO wa_memories (id, project_id, content, memory_type, created_at) VALUES ('mid1','p','b','archived',datetime('now','-30 days'))").run();
dbm.prepare("INSERT INTO wa_memories (id, project_id, content, memory_type, created_at) VALUES ('act1','p','c','semantic',datetime('now','-95 days'))").run();
// 语义: 按 -90d 清理 archived(不动 active/semantic)
const del = dbm.prepare("DELETE FROM wa_memories WHERE memory_type='archived' AND created_at < datetime('now', ?)").run('-90 days');
ok(del.changes === 1, 'A1 过期archived(95d)被清, 30d保留', `changes=${del.changes}`);
ok(dbm.prepare("SELECT COUNT(*) c FROM wa_memories WHERE id='mid1'").get().c === 1, 'A1 未过期archived保留');
ok(dbm.prepare("SELECT COUNT(*) c FROM wa_memories WHERE id='act1'").get().c === 1, 'A1 非archived(active)不受影响');
// 0=关闭
dbm.prepare("INSERT INTO wa_settings (key,value) VALUES ('memory.archive_retention_days','0')").run();
const days0 = Number((dbm.prepare("SELECT value v FROM wa_settings WHERE key='memory.archive_retention_days'").get().v ?? '90'));
ok(!(days0 > 0), 'A1 0=关闭(跳过清理)');

console.log('A2 验收→可复用配方语义');
dbm.prepare("INSERT INTO wa_memories (id, project_id, task_id, content, memory_type, importance, source, reusable_experience, valence) VALUES ('m1','p','t1','x','semantic',0.5,'agent_execution',0,'neutral')").run();
const sid = 'm1';
dbm.prepare('UPDATE wa_memories SET importance = MAX(importance, 0.8) WHERE id = ?').run(sid);
dbm.prepare("UPDATE wa_memories SET is_exemplar = 1, exemplar_type = ?, exemplar_context = ? WHERE id = ?").run('good', JSON.stringify({ archetype: 'outcome_success' }), sid);
const r = dbm.prepare("SELECT source, importance, is_exemplar, exemplar_type, reusable_experience FROM wa_memories WHERE id='m1'").get();
ok(r.importance >= 0.8, 'A2 importance 抬高≥0.8', `importance=${r.importance}`);
ok(r.is_exemplar === 1 && r.exemplar_type === 'good', 'A2 标记 exemplar(good/outcome_success)');

console.log('源码静态防回归');
const dts = rd('apps/worker-ant-desktop/src/main/database.ts');
ok(dts.includes("memory.archive_retention_days") && dts.includes('90'), 'database 默认键 memory.archive_retention_days=90');
ok(dts.includes("memory.outcome_exemplar"), 'database 默认键 memory.outcome_exemplar');
const mm = rd('apps/worker-ant-desktop/src/main/core/memory-manager.ts');
ok(mm.includes('pruneArchivedMemory'), 'memory-manager 含 pruneArchivedMemory');
// zx_20260930 M8 就地订正（**改钉更强真源，非放宽**）：本条原钉 memory-manager 内那句物理删
//   `DELETE … memory_type = 'archived' AND created_at < datetime('now',…)`。M8 起保留期届满
//   **落墓碑**（不再物理删），该字面量在源码里已不存在。若仍钉旧串 ⇒ 恒红；若改成"不再含旧串"
//   ⇒ 真假不辨、恒绿。故改为钉三件事：①memory-manager 内的保留期 SQL 已**除**（旧路径不留残骸）；
//   ②它**委派**给唯一实现（语句形状，非子串）；③该实现在 memory-lifecycle.ts，且谓词用
//   `MEM_TYPE_ARCHIVED` **常量**（不是手抄 `'archived'`）。
ok(!/DELETE FROM wa_memories[\s\S]{0,120}memory_type = 'archived'/.test(mm), 'memory-manager 旧物理删归档路径已除');
ok(/tombstoneExpiredArchived\(this\.db, days\)/.test(mm), 'memory-manager 保留期清理委派唯一实现（语句形状）');
const lc = rd('apps/worker-ant-desktop/src/main/core/memory-lifecycle.ts');
ok(/SELECT id FROM wa_memories WHERE memory_type = \? AND created_at < \?/.test(lc), '真源：保留期谓词在 memory-lifecycle');
ok(lc.includes('MEM_TYPE_ARCHIVED, cutoff'), '真源：谓词绑定常量 MEM_TYPE_ARCHIVED（非手抄字面量）');
ok(lc.includes("retention: '归档保留期届满'"), '真源：落墓缘由单源（retention）');
const ae = engineSrc();
ok(ae.includes("source: 'outcome_exemplar'") && ae.includes('reusableExperience: true') && ae.includes('markExemplar('), 'agent-executor finalize 验收通过 A2 沉淀在案');
// zx_20260907 M3(复核补): A2 死路修正——doc promote 到 completed 在 finalize 成功后,此刻同 run doc 仍 draft,须纳入 draft 否则永远落不成 exemplar
ok(ae.includes("type = 'doc' AND status IN ('draft','registered','completed')"), 'A2 doc 产出物过滤含 draft(M3 死路修正)');

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
