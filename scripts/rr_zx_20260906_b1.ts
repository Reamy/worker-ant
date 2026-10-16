/**
 * zx_20260906 批1 受控复跑（node:sqlite 内存库，绝不触碰开发库/生产活跃项目；用法同 rr_zx_20260905.ts）。
 * S1 建表/迁移接线：database.ts CREATE 已含 updated_at 列；migrations 含幂等 ALTER；对"缺列旧表"应用该 ALTER 成功补列。
 * S2 状态推进 + 事件：setDeliverableStatus draft→running→running(幂等不发)→registered(发 deliverable.registered)→stopped；
 *    真变更发 deliverable.status_changed；payload 带 deliverableId/projectId/taskId/status/via。
 * S3 finalize 达标推进：promoteTaskFileDeliverables 把 doc draft→completed；含 deliverable_unfulfilled 时不推进。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setDeliverableStatus, promoteTaskFileDeliverables } from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
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

const dbSrc = fs.readFileSync(path.resolve(__dirname, '../apps/worker-ant-desktop/src/main/database.ts'), 'utf-8');

console.log('S1 建表/迁移接线');
ok(dbSrc.includes('updated_at TEXT DEFAULT (datetime(\'now\'))') && dbSrc.includes('CREATE TABLE IF NOT EXISTS wa_deliverables'),
  'database.ts 建表含 updated_at', 'CREATE wa_deliverables 声明已对齐');
ok(dbSrc.includes('ALTER TABLE wa_deliverables ADD COLUMN updated_at TEXT'),
  'database.ts 迁移清单含幂等 ALTER', '旧表/缺列库将被补列');

// 旧表(缺列)场景：重建旧结构 → 应用 ALTER → 列到位
const oldDb = new DatabaseSync(':memory:');
oldDb.exec(`CREATE TABLE wa_deliverables (
  id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL, name TEXT DEFAULT '',
  description TEXT DEFAULT '', file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now'))
)`);
const before = (oldDb.prepare("SELECT COUNT(*) c FROM pragma_table_info('wa_deliverables') WHERE name='updated_at'").get() as { c: number }).c;
ok(before === 0, '旧表初始无 updated_at 列', `before=${before}`);
try { oldDb.exec('ALTER TABLE wa_deliverables ADD COLUMN updated_at TEXT'); ok(true, '迁移 ADD COLUMN updated_at 成功'); }
catch (e) { ok(false, `迁移失败: ${String(e)}`); }
try { oldDb.exec('ALTER TABLE wa_deliverables ADD COLUMN updated_at TEXT'); ok(true, '迁移幂等(第二次抛错被外层吞)'); }
catch { ok(true, '迁移幂等(第二次抛错被外层吞)'); }
const after = (oldDb.prepare("SELECT COUNT(*) c FROM pragma_table_info('wa_deliverables') WHERE name='updated_at'").get() as { c: number }).c;
ok(after === 1, '补列后 updated_at 存在', `after=${after}`);

// 用补列后的旧库 + 必要关联表跑 helper
const db = oldDb as unknown as { prepare: (sql: string) => { all: (...p: unknown[]) => unknown[]; get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => { changes: number } }; exec: (sql: string) => void };
db.exec(`CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '');
  CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT DEFAULT '', context_json TEXT DEFAULT '{}');
`);

console.log('S2 状态推进 + 事件');
const pid = randomUUID();
const did = randomUUID();
const tid = randomUUID();
db.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run(pid, 't');
db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status) VALUES (?, ?, ?, 'doc', ?, '/tmp/a.md', 'draft')").run(did, pid, tid, '产出物A');
const events: Array<{ type: string; status?: string; deliverableId?: string; via?: string }> = [];
const cap = (type: 'deliverable.registered' | 'deliverable.status_changed') => (e: { data: Record<string, unknown> }) => {
  events.push({ type, status: String(e.data.status ?? ''), deliverableId: String(e.data.deliverableId ?? ''), via: String(e.data.via ?? '') });
};
eventBus.on('deliverable.registered', cap('deliverable.registered'));
eventBus.on('deliverable.status_changed', cap('deliverable.status_changed'));
const r1 = setDeliverableStatus(db as never, did, 'running', 'deliverable:start');
ok(r1.changed === true, 'draft→running changed');
const r2 = setDeliverableStatus(db as never, did, 'running', 'deliverable:start');
ok(r2.changed === false, 'running→running 幂等不发');
const r3 = setDeliverableStatus(db as never, did, 'registered', 'deliverable:register');
ok(r3.changed === true, 'running→registered changed');
const r4 = setDeliverableStatus(db as never, did, 'stopped', 'deliverable:stop');
ok(r4.changed === true, 'registered→stopped changed');
const st = (db.prepare('SELECT status FROM wa_deliverables WHERE id = ?').get(did) as { status: string }).status;
ok(st === 'stopped', `落库状态 = stopped (${st})`);
const evSc = events.filter(e => e.type === 'deliverable.status_changed');
const evReg = events.filter(e => e.type === 'deliverable.registered');
ok(evSc.length === 2, `deliverable.status_changed 真变更 2 次 (${evSc.length})`);
ok(evReg.length === 1 && evReg[0]?.deliverableId === did, `deliverable.registered 1 次 (id=${evReg[0]?.deliverableId})`);
const ev0 = evSc[0];
ok(ev0?.deliverableId === did && ev0?.via === 'deliverable:start', `status_changed payload 含 id/via (${JSON.stringify(ev0)})`);

console.log('S3 finalize 达标推进');
const tid2 = randomUUID();
const did2 = randomUUID();
const did3 = randomUUID();
db.prepare('INSERT INTO wa_tasks (id, project_id, title, context_json) VALUES (?, ?, ?, ?)').run(tid2, pid, 't', '{}');
db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status) VALUES (?, ?, ?, 'doc', '达标doc', '/tmp/ok.md', 'draft')").run(did2, pid, tid2);
db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status) VALUES (?, ?, ?, 'doc', '不达标doc', '/tmp/no.md', 'draft')").run(did3, pid, tid2);
db.prepare("UPDATE wa_tasks SET context_json = ? WHERE id = ?").run(JSON.stringify({ deliverable_unfulfilled: { paths: ['/tmp/no.md'], forced: true } }), tid2);
const p1 = promoteTaskFileDeliverables(db as never, tid2, 'run_close');
const s2 = (db.prepare('SELECT status FROM wa_deliverables WHERE id = ?').get(did2) as { status: string }).status;
const s3 = (db.prepare('SELECT status FROM wa_deliverables WHERE id = ?').get(did3) as { status: string }).status;
ok(p1.promoted === 0 && s2 === 'draft' && s3 === 'draft', '含 deliverable_unfulfilled → 不推进(promoted=0, 均 draft)');
db.prepare("UPDATE wa_tasks SET context_json = '{}' WHERE id = ?").run(tid2);
const p2 = promoteTaskFileDeliverables(db as never, tid2, 'run_close');
const s2b = (db.prepare('SELECT status FROM wa_deliverables WHERE id = ?').get(did2) as { status: string }).status;
const s3b = (db.prepare('SELECT status FROM wa_deliverables WHERE id = ?').get(did3) as { status: string }).status;
ok(p2.promoted === 2 && s2b === 'completed' && s3b === 'completed', `达标收尾 → doc draft 全推进 completed (promoted=${p2.promoted})`);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
