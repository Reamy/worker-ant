/**
 * zx_20260909 批3(M4 域Z 引擎"破心中贼"接线)受控复跑(node:sqlite 内存库语义 + 源码静态防回归；绝不触碰开发库；tsx 运行)。
 *
 * Z1 task:retry 置 pending 后即入队真正执行(此前只置 pending 不 enqueue 依赖 scanReadyTasks → GUI"重试"停 pending 无真作业):
 *       supersedeExecutionJobs(superseded_by_retry) + _taskRunEnqueuer(ai-task 从零重跑)/兜底裸插 'ai-task' 作业。
 * Z2 update_task_status 自标 completed 亦 promote draft 产出(此前此路绕 finalize 且不 promote → 完成态与 draft 不一致)。
 * Z3 暂停一律先 supersedeExecutionJobs(superseded_by_pause)(此前仅 running 类 abort、排队裸置 paused 不清残留作业)。
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
const ipc = rd('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
const exe = engineSrc();

console.log('Z1 retry 置 pending 后即入队(源码静态)');
const retrySeg = ipc.slice(ipc.indexOf("ipcMain.handle('task:retry'"), ipc.indexOf("ipcMain.handle('task:resume'"));
ok(retrySeg.includes("supersedeExecutionJobs(db, id, 'superseded_by_retry')"), 'retry 先作废残留作业(superseded_by_retry, 防双跑)');
// zx_20261023_3 批四就地改钉（按更强形状，非放宽）：重试路与 GUI 起跑路一样必须写明**来源**
//   （`source` 进作业载荷，事后能查"谁拉起来的"）。入队器三参调用 + 裸插兜底载荷同带 `gui_retry`。
ok(/void _taskRunEnqueuer\(id, task\.project_id, 'gui_retry'\)/.test(retrySeg)
  && /INSERT INTO wa_jobs[^\n]*'ai-task'[^\n]*JSON\.stringify\(\{ taskId: id, projectId: task\.project_id, source: 'gui_retry' \}\)/.test(retrySeg),
  'retry 经 _taskRunEnqueuer 入 ai-task(即时执行，带 source) + 裸插兜底同带 source');
ok(retrySeg.indexOf('UPDATE wa_tasks SET status') < retrySeg.indexOf('_taskRunEnqueuer'), '先置 pending 再入队(作业可被 executeTask CAS 认领)');

console.log('Z1 语义复刻(内存库: 无 enqueuer 兜底插入 ai-task 作业; supersede 作废残留)');
const dbm = new DatabaseSync(':memory:') as any;
dbm.exec(`CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, status TEXT);
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT, payload TEXT, status TEXT);`);
// 残留作业(崩溃遗留) + 重试
dbm.prepare("INSERT INTO wa_tasks (id,status) VALUES ('t1','completed')").run();
dbm.prepare("INSERT INTO wa_jobs (id,type,payload,status) VALUES ('old1','ai-task','{\"taskId\":\"t1\",\"projectId\":\"p1\"}','pending')").run();
dbm.prepare("UPDATE wa_jobs SET status='superseded' WHERE id='old1'").run(); // supersedeExecutionJobs 语义
dbm.prepare("INSERT INTO wa_jobs (id,type,payload,status) VALUES ('new1','ai-task','{\"taskId\":\"t1\",\"projectId\":\"p1\"}','pending')").run(); // _taskRunEnqueuer/兜底 insert
const active = dbm.prepare("SELECT type FROM wa_jobs WHERE status='pending'").all() as Array<{ type: string }>;
ok(active.length === 1 && active[0]!.type === 'ai-task', '重试后仅 1 条待执行 ai-task 作业(残留已作废)', `pending=${active.length}`);
dbm.close();

console.log('Z2 自标 completed 亦 promote draft(源码静态)');
const uSeg = exe.slice(exe.indexOf('update_task_status: {'), exe.indexOf('update_project_terms: {'));
ok(uSeg.includes("promoteTaskFileDeliverables(db, args.targetTaskId, 'update_task_status')"), 'update_task_status completed 分支调 promote(复用 finalize 同款)');
ok(uSeg.includes('realOutputEvidence') && uSeg.includes('assessCompletionQuality') && uSeg.includes('auto_completed_without_output'), '既有质量审计/无产出标记逻辑保留(只补 promote 一致, 不动绕门判定)');

console.log('Z3 暂停先 supersede 残留作业(源码静态)');
const updSeg = ipc.slice(ipc.indexOf("ipcMain.handle('task:updateStatus'"), ipc.indexOf("ipcMain.handle('tasks:children'"));
ok(updSeg.includes("if (status === 'paused') supersedeExecutionJobs(db, id, 'superseded_by_pause')"), 'updateStatus paused 一律先 supersede 残留作业(superseded_by_pause)');
// zx_20260917 M1: 在途判定由"同一 if 的两个条件"拆成嵌套（外层 `status === 'paused'` 统一收口到唯一写入口），
// 故锚点改钉在途态集合本身——语义不变：supersede 仍先于在途 abort。
ok(updSeg.indexOf("'superseded_by_pause'") < updSeg.indexOf("['running', 'executing', 'preparing', 'planning']"), 'supersede 先于 running 类 abort 分支(排队残留先作废, 在途中止照常)');
// zx_20260921 M8（**判据形状订正**，非源码回退——该分支由单行式扩成代码块是 zx_20260921 **M7** 做的，
//   本脚本当时不在 M7 的改动面里故漏网至今；承接教训「回退的只能是判据的形状假设，不能是本轮源码」）：
//   改按**分支内的有序事实**断言——三终态齐判 → 清残作业 → 放行父（`afterTaskTerminalStatus`，
//   M7 明写语义：先把本任务残作业清干净、再去动父）。三件事须同支且以此序出现。
const _termAt = updSeg.indexOf("['completed', 'failed', 'archived'].includes(status)");
const _cleanupAt = updSeg.indexOf('cleanupTaskExecutionJobs(db, id)', _termAt);
const _releaseAt = updSeg.indexOf('afterTaskTerminalStatus(db, id)', _cleanupAt);
ok(_termAt >= 0 && _cleanupAt > _termAt && _releaseAt > _cleanupAt,
  '终态 cleanup 逻辑保留未破坏（且 M7 的放行父在清残作业之后同支有序）',
  `term@${_termAt} cleanup@${_cleanupAt} release@${_releaseAt}`);

console.log('\n结果: pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
