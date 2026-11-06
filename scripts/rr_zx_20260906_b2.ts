/**
 * zx_20260906 批2 受控复跑（node:sqlite 内存库 + /tmp 临时文件；用法同 rr_zx_20260905.ts）。
 * S4 2c 真实产出证据：无产出无工具→false；doc 文件落盘→true；doc 文件缺失且无工具→false；服务 running→true；仅有 write_file 工具记录→true。
 * S5 2b 校验同 run 缓存：命中同文件同 sig→sigOk=true 复用；文件被改(mtime/size 变)→sigOk=false 需重验。
 * （2a lessons 去重 / 2d single-flight / 2e 诚实标记 属集成语义，随真实 run 复核，见方案 §九）
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { realOutputEvidence, cachedOutputValidation } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { engineSrc } from './lib/rr-engine-src.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path?: string) => { exec: (sql: string) => void; prepare: (sql: string) => { all: (...p: unknown[]) => unknown[]; get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => { changes: number } } };
};

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const db = new DatabaseSync(':memory:') as unknown as { prepare: (sql: string) => { all: (...p: unknown[]) => unknown[]; get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => { changes: number } }; exec: (sql: string) => void };
db.exec(`CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '');
  CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT DEFAULT '', context_json TEXT DEFAULT '{}');
  CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT DEFAULT '', name TEXT DEFAULT '', status TEXT DEFAULT 'draft', file_path TEXT);
  CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT DEFAULT '', content TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
`);

const pid = randomUUID();
db.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run(pid, 't');
const newTask = (): string => { const id = randomUUID(); db.prepare('INSERT INTO wa_tasks (id, project_id, title) VALUES (?, ?, ?)').run(id, pid, 't'); return id; };

console.log('S4 2c 真实产出证据(hasDeliverable 口径)');
const t1 = newTask();
ok(realOutputEvidence(db as never, t1) === false, '无产出无工具 → false');
const t2 = newTask();
const realFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rr_b2_')), 'ok.md');
fs.writeFileSync(realFile, '内容', 'utf-8');
db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, status, file_path) VALUES (?, ?, ?, 'doc', 'd', 'draft', ?)").run(randomUUID(), pid, t2, realFile);
ok(realOutputEvidence(db as never, t2) === true, 'doc 文件已落盘 → true');
const t3 = newTask();
db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, status, file_path) VALUES (?, ?, ?, 'doc', 'd', 'draft', '/no/such/file.md')").run(randomUUID(), pid, t3);
ok(realOutputEvidence(db as never, t3) === false, 'doc 文件缺失且无工具 → false');
const t4 = newTask();
db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, status, file_path) VALUES (?, ?, ?, 'mcp', 'svc', 'running', NULL)").run(randomUUID(), pid, t4);
ok(realOutputEvidence(db as never, t4) === true, '服务类 running → true');
const t5 = newTask();
db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?, ?, 'tool', '[tool] write_file 写入')").run(randomUUID(), t5);
ok(realOutputEvidence(db as never, t5) === true, '仅 write_file 工具记录 → true');

console.log('S5 2b 校验同 run 缓存');
const cacheFile = path.join(path.dirname(realFile), 'cache.md');
fs.writeFileSync(cacheFile, 'v1 内容足够长用于 size', 'utf-8');
const st1 = fs.statSync(cacheFile);
ok(cachedOutputValidation({ output_validations: [] } as never, cacheFile) === null, '无缓存 → null');
const ctxJson: Record<string, unknown> = { output_validations: [{ file: cacheFile, status: 'sufficient', sufficient: true, size: st1.size, mtimeMs: st1.mtimeMs }] };
const hit1 = cachedOutputValidation(ctxJson, cacheFile);
ok(hit1 !== null && hit1.sigOk === true && (hit1.entry.sufficient as boolean) === true, '同文件同 sig → 命中可复用');
fs.writeFileSync(cacheFile, 'v2 内容被修改后足够长以改变 size', 'utf-8');
const hit2 = cachedOutputValidation(ctxJson, cacheFile);
ok(hit2 !== null && hit2.sigOk === false, '文件被改(mtime/size 变) → sigOk=false 需重验');

fs.rmSync(path.dirname(realFile), { recursive: true, force: true });

// S6 (2026-09-06 终核补强): 完成真实性诚实标记有消费 + 2d 幂等收口接线（源接线断言，防"做了没用"）
console.log('S6 终核补强接线');
const aeSrc = engineSrc();
const jobsSrc = fs.readFileSync(path.resolve(__dirname, '../apps/worker-ant-desktop/src/main/core/jobs/index.ts'), 'utf-8');
const aiTaskSrc = fs.readFileSync(path.resolve(__dirname, '../apps/worker-ant-desktop/src/main/core/jobs/ai-task.ts'), 'utf-8');
const tdSrc = fs.readFileSync(path.resolve(__dirname, '../apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx'), 'utf-8');
ok(aeSrc.includes("qVia === 'update_task_status' || qVia.startsWith('update_task_status')"), '2e 不覆盖 finalize 审计(仅本工具打标/改写 via)');
ok(tdSrc.includes('auto_completed_without_output') && tdSrc.includes('⚠ 未达成果门禁'), '2e 诚实标记有消费——TaskDetail 透出"未达成果门禁"(警示人工复核)');
// zx_20260930 M5 重钉：幂等预检从"只看有没有复过盘"升级为"**同一终态才**算复过盘"——
//   失败复盘 (`focus='lessons'`) 与完成复盘 (`focus='recipe'`) 是两份账，按时间戳一刀切会让
//   "先 completed 复过盘、后改判 failed" 的任务永久拿不到 lessons。故此处钉**状态也参与比对**，
//   比旧钉 `if (pre.background_reviewed_at) return;` 更强（旧形状正是被修掉的那个洞）。
ok(jobsSrc.includes('pre.background_reviewed_at') && /if \(pre\.background_reviewed_at && reviewedStatus === reviewStatus\) return;/.test(jobsSrc)
  && jobsSrc.includes('pre.background_reviewed_status') && jobsSrc.includes('rctx.background_reviewed_status = reviewStatus;'),
  '2d background-review 持久化幂等预检(**按终态**去重：同任务改判后仍能补复一次盘)');
// zx_20260930 M5 重钉：不再写死 `'completed'`，改由可复盘终态集真源判定（钉**更强的真源**，非放宽）：
//   ① 那一跳按语句形状走 `isReviewableStatus(taskRow.status)`；② 真源本身含 completed+failed、
//   不含 paused/archived；③ 反证：该文件里不再有 `=== 'completed'` 挡在复盘调度前。
ok(/if \(taskRow && isReviewableStatus\(taskRow\.status\)\)/.test(aiTaskSrc) && aiTaskSrc.includes("scheduler.enqueue('background-review'"),
  '2d[M5] resume 按**可复盘终态集**调度(完成与失败各复盘一次，暂停/部分不再整批重复)');
ok(jobsSrc.includes('isReviewableStatus') && /REVIEWABLE_STATUSES = \['completed', 'failed'\] as const/.test(
  fs.readFileSync(path.resolve(__dirname, '../apps/worker-ant-desktop/src/main/core/task-terminal.ts'), 'utf-8')),
  '2d[M5] 可复盘终态集真源=completed+failed（`paused`/`archived` 刻意不在内：暂停未结束、归档已出账）');
ok(!/status === 'completed'\)\s*\{[^}]{0,120}background-review/.test(aiTaskSrc),
  '2d[M5] 反证：复盘调度前不再有写死 `=== \'completed\'` 的旧闸');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
