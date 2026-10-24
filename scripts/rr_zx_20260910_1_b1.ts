/**
 * zx_20260910_1 受控复跑（纯函数行为 + 源码静态防回归；绝不触碰开发库；经桌面 node_modules/.bin/tsx 运行）。
 *
 * 本轮问题：任务详情页「等待你的回复」在需要确认时出现**重复两块**（一块排版好、一块不换行），
 * 且有时只有一块但界面不刷新（仍显"执行中"，手刷才变）。根因是同一后端状态有两条独立 UI 通路
 * （DB 会话标记 [等待用户输入] → 琥珀横幅 vs 事件 task.awaiting_input → DecisionCard），
 * 外加 8 处系统侧暂停点只改 DB 不补发事件。
 *
 * S1 M1 渲染层收敛：DecisionCard 已删，等待输入只剩横幅一处，真源 ctxJson.awaiting_input，
 *    会话标记仅作兼容回落且取"最后一条"（原 convs.find 取最旧 → 已回答过的旧问题顶在横幅上）。
 * S2 M2 main 侧真源唯一化：两条暂停路径（ask_user / 门禁）共用 persistAwaitingInput，真源同形。
 * S3 M3 暂停事件全覆盖：每个置 paused 点均补发 status_changed(paused)（唯一豁免=委托调用方的 interruptTask）。
 * S4 M4 应答幂等：判据纯函数行为（同轮×同决策×同值×15s 内=重复）+ 后端路由 + 前端连点护栏。
 * S5 M4 本轮消息单写：用户回复的权威写入点在用户输入边界，执行器只写合成消息 → 同句回复不再落库多行。
 * （GUI 目视/事件实时到达为集成语义，归桌面实机复核，见方案 §十。）
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { engineExecSideFiles } from './lib/rr-engine-src.js';
import { isDuplicatePauseResponse, settlePause, persistTurnMessage, REPEAT_SUBMIT_WINDOW_MS, type PauseDb } from '../apps/worker-ant-desktop/src/main/core/pause-settlement.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const read = (...s: string[]) => fs.readFileSync(path.join(ROOT, ...s), 'utf-8');
const tdp = read('apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx');
const ipcTs = read('apps/worker-ant-desktop/renderer/src/lib/ipc.ts');
const ipc = read('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
const ps = read('apps/worker-ant-desktop/src/main/core/pause-settlement.ts');
const exe = read('apps/worker-ant-desktop/src/main/core/agent-executor.ts');
// zx_20260921 M8: `executeTask` 入口段（含**门禁**那条暂停路径）搬至 `core/exec-claim.ts`。
//   凡断言"两条暂停路径共用真源"的扫描面须随实现落点走（扩面只许更严）。
// zx_20260929 M9: `executeTask` **收尾段**（含 D1 闸那处暂停）再外移到 `core/exec-close.ts` ⇒
//   原"`exe` ∪ `exec-claim`"的手抄两文件并集**又漏一处**（暂停点实测 10 处 < 在册下限 11 处）。
//   改取 `lib/rr-engine-src.ts` 的**一处真源**：执行体 ∪ 全部 `exec-*.ts`（**减**工具段——工具侧的暂停
//   是另一条路、另有判据）。此后每次搬迁两个面自动同进退，不必再逐个手抄。
const execSurface = engineExecSideFiles()
  .map((p) => read(p)).join('\n');
const aiTask = read('apps/worker-ant-desktop/src/main/core/jobs/ai-task.ts');

console.log('S1 M1 渲染层收敛：横幅唯一化');
ok(!fs.existsSync(path.join(ROOT, 'apps/worker-ant-desktop/renderer/src/components/DecisionCard.tsx')), 'DecisionCard 组件已删（重复的第二块来源）');
ok(!/import[^\n]*DecisionCard/.test(tdp) && !/<DecisionCard/.test(tdp),
  'TaskDetailPage 不再 import/渲染 DecisionCard（注释里的历史说明不算）');
ok(tdp.includes('awaiting_input?: { question?: string; options?: string[]; decision_type?: string }'), '横幅真源=ctxJson.awaiting_input（结构化）');
ok(tdp.includes("c.content || '').startsWith('[等待用户输入]')") && tdp.includes('hits[hits.length - 1]'), 'DB 标记仅作兼容回落且取最后一条（原取最旧→旧问题顶横幅）');
ok(tdp.includes('text-amber-900 whitespace-pre-wrap break-words'), '问题正文换行呈现（重复块不换行的观感缺陷已消）');
ok(tdp.includes('AWAIT_TYPE_LABEL') && tdp.includes('pending_confirmation'), '决策类型标签随横幅呈现（原 DecisionCard 能力上移）');

console.log('S2 M2 main 侧真源唯一化');
ok(exe.includes('export function persistAwaitingInput'), 'persistAwaitingInput 已抽出并导出');
// zx_20260915 P0-5(d) 同步：asked_at 由内联字面量改为先取 `const askedAt = …` 再整体覆盖写，
// 使「事件载荷的 asked_at」与「ctx.awaiting_input.asked_at」同源（此前各算一次、微秒级必不相等）。
// 原断言按单语句字面匹配，改判「同一次写里两处都在场」——语义（每次暂停整体覆盖）未变。
ok(exe.includes('const askedAt = new Date().toISOString()') && exe.includes('actx.awaiting_input = { ...payload, asked_at: askedAt }'),
  '每次暂停整体覆盖写 asked_at（M4 判据依赖此语义；事件与 ctx 同源取自 askedAt）');
// ask_user 与门禁两条路径都必须落到同一处真源
const persistCalls = execSurface.split('persistAwaitingInput(db, taskId').length - 1;
ok(persistCalls >= 2, `两条暂停路径共用真源（调用点 ${persistCalls} 处，扫描面=执行体∪exec-*.ts，不含工具段）`);

console.log('S3 M3 暂停事件全覆盖');
// zx_20260917 M1: 「置暂停」收成唯一写入口 `pauseTask`（状态/因/事件一次写全）——
// 判据随之从"逐站点按邻近窗配对补发事件"（脆：窗宽随代码漂）改为**结构性**判据：
// 每个暂停点都经 `pauseTask` 且带因；广播由唯一写入口一处发出（不存在"漏补一处"的可能）。
const pauseSites: number[] = [];
for (let i = execSurface.indexOf('pauseTask(db, {'); i >= 0; i = execSurface.indexOf('pauseTask(db, {', i + 1)) pauseSites.push(i);
const unpaired = pauseSites.filter((i) => !execSurface.slice(i, i + 400).includes('reason:'));
ok(pauseSites.length >= 11 && unpaired.length === 0,
  `执行体一侧每个暂停点均经 pauseTask 且带因（${pauseSites.length} 处暂停点，未带因 ${unpaired.length}）`
  + '——扫描面=执行体∪`exec-*.ts`（不含工具段）',
  unpaired.length > 0 ? `未带因行: ${unpaired.map(i => execSurface.slice(0, i).split('\n').length).join(',')}` : undefined);
const pauseWriter = read('apps/worker-ant-desktop/src/main/core/pause-task.ts');
ok(pauseWriter.includes("'task.status_changed'") && pauseWriter.includes("newStatus: 'paused'"),
  '唯一写入口 pauseTask 发出 status_changed(paused)（落库与广播同一次写全）');
// ai-task 三处暂停点（非正常结束 ×1 / 偏离收敛 ×2）同样经入口
ok((aiTask.match(/pauseTask\(db, \{/g) || []).length >= 3 && !aiTask.includes("newStatus: 'paused'"),
  'jobs/ai-task 非正常结束/偏离收敛等暂停点经 pauseTask（不再自带 emit）');
const sc = read('apps/worker-ant-desktop/src/main/core/task-scheduler.ts');
const sh = read('apps/worker-ant-desktop/src/main/core/self-healing-monitor.ts');
const inv = read('apps/worker-ant-desktop/src/main/core/architectural-invariants.ts');
ok(sc.includes('pauseTask(this.db, {') && sc.includes('PAUSE_REASON_PLANNING_TIMEOUT'), 'task-scheduler 计划超时暂停经 pauseTask 且带因');
ok(sh.includes('pauseTask(db, {') && sh.includes('PAUSE_REASON_EXEC_TIMEOUT'), 'self-healing-monitor 自愈暂停经 pauseTask 且带因');
ok(inv.includes("SELECT id FROM wa_tasks WHERE status IN ('executing','preparing')") && inv.includes('pauseTask(db, {') && inv.includes('PAUSE_REASON_STALE_TIMEOUT'),
  'architectural-invariants 滞留任务"先取 id 再逐条经 pauseTask"（批量 SQL 落不下因、也无事件）');

console.log('S4 M4 应答幂等：判据行为（真逻辑，非复刻）');
const W = REPEAT_SUBMIT_WINDOW_MS;
const asked = '2026-09-10T03:13:33.000Z';
const ctxOf = (over: Record<string, unknown> = {}) => ({
  awaiting_input: { question: 'q', options: [], decision_type: 'privilege_approval', asked_at: asked },
  pause_response: { at: Date.now(), decision: 'deny', value: null, asked_at: asked },
  ...over,
});
const T = Date.now();
ok(isDuplicatePauseResponse(ctxOf(), 'deny', undefined) === true, '同轮×同决策×同值×未超窗 → 判重（连续拒绝重复点）');
ok(isDuplicatePauseResponse(ctxOf(), 'deny', undefined, T) === true, '注入 now 同刻 → 判重');
ok(isDuplicatePauseResponse(ctxOf(), 'allow', undefined) === false, '决策不同 → 不判重');
ok(isDuplicatePauseResponse(ctxOf(), 'option', 'A') === false, '值不同 → 不判重');
ok(isDuplicatePauseResponse(ctxOf({ pause_response: { at: T - (W - 1), decision: 'deny', value: null, asked_at: asked } }), 'deny', undefined, T) === true, '窗内边界(W-1ms) → 判重');
ok(isDuplicatePauseResponse(ctxOf({ pause_response: { at: T - W, decision: 'deny', value: null, asked_at: asked } }), 'deny', undefined, T) === false, '窗外边界(≥W) → 不判重（可再次提交）');
ok(isDuplicatePauseResponse(ctxOf({ awaiting_input: { question: '新问题', asked_at: '2026-09-10T03:20:00.000Z' } }), 'deny', undefined, T) === false,
  '恢复后又暂停出新问题(asked_at 变) → 不判重（不误伤真实新应答）');
ok(isDuplicatePauseResponse(ctxOf({ awaiting_input: undefined }), 'deny', undefined, T) === false, '无 awaiting_input（系统侧自动暂停）→ 不判重（判不了就不拦）');
ok(isDuplicatePauseResponse(ctxOf({ pause_response: { at: T, decision: 'deny', value: null, asked_at: null } }), 'deny', undefined, T) === false, 'asked_at 缺失 → 不判重（保守）');
ok(isDuplicatePauseResponse({ awaiting_input: { asked_at: asked } }, 'deny', undefined, T) === false, '无历史应答 → 不判重（首次提交放行）');
ok(isDuplicatePauseResponse(ctxOf(), 'resume', '继续') === false, 'resume 语义首答放行（值与历史 deny 不同）');

console.log('S4b M4 后端路由 + 前端连点护栏');
ok(ipc.includes("export function isDuplicatePauseResponse") === false && ipc.includes("from '../core/pause-settlement.js'"),
  'project.ipc 复用 core/pause-settlement 判据（单一实现，无副本）');
ok(ipc.split("code: 'ALREADY_RESPONDED'").length - 1 === 2, 'task:resume / task:respond 两处均返回 ALREADY_RESPONDED');
const resumeGuard = ipc.indexOf("isDuplicatePauseResponse(ctx, 'resume', reply)");
const respondGuard = ipc.indexOf('isDuplicatePauseResponse(ctx, decision, value)');
const resumeStatusGuard = ipc.indexOf("if (!['paused', 'failed'].includes(task.status))");
const respondStatusGuard = ipc.indexOf("if (task.status !== 'paused') return { error: { code: 'INVALID_STATUS'");
ok(resumeGuard > resumeStatusGuard && resumeGuard > -1, 'resume 判重位于状态守卫之后（不动既有语义）');
ok(respondGuard > respondStatusGuard && respondGuard > -1, 'respond 判重位于状态守卫之后');
// zx_20260915 P0-5(a) 同步：settlePause 增第 7 参 source（缺省 'gui'），GUI 三处显式传 'gui' 便于溯源。
ok(ipc.includes("settlePause(db, id, ctx, decision, value, false, 'gui')") && ipc.includes("settlePause(db, id, ctx, decision, value, true, 'gui')"),
  '连续拒绝(保持 paused) 落账但保留 awaiting_input（clear=false）；恢复路径 clear=true');
ok(ps.includes('(ctx.awaiting_input as { asked_at?: string } | undefined)?.asked_at ?? null'),
  '落账记录 asked_at（跨轮区分真源，取自当前 awaiting_input）');
ok(ipcTs.includes('export class IpcError') && ipcTs.includes('throw new IpcError(result.error.code, result.error.message)'),
  'renderer ipcCall 保留错误码（此前只透 message，业务码丢失）');
ok(tdp.includes('async function submitPauseOp') && tdp.includes("e instanceof IpcError && e.code === 'ALREADY_RESPONDED'"),
  '前端把 ALREADY_RESPONDED 视同成功静默收口（不弹"操作未生效"）');
// zx_20261018_3 D7 起，"提交中禁用"由 `submitting` state 升级为 `actionLocked = submitting || actionCooldown`
//   （状态一翻同一坐标按钮就反向 ⇒ 还需冷却窗口），重入护栏改由 `beginAction()` 用 ref **同步**挡第二击。
//   按新载体重定向（更强：同一事件循环里的第二下才挡得住），判据本身不放宽。
ok(tdp.split('disabled={actionLocked}').length - 1 >= 4,
  '恢复/允许/拒绝/回复并恢复按钮均加提交中（含冷却）禁用（防连点）');
{
  const body = tdp.slice(tdp.indexOf('async function submitPauseOp'), tdp.indexOf('async function handleResume('));
  ok(body.includes('if (!beginAction()) return;'), '提交护栏重入直接返回');
  ok(tdp.includes('if (actionBusyRef.current) return false;'),
    '重入护栏是 ref 同步挡（React state 同一事件循环里读到旧值，挡不住第二击）');
}

console.log('S5 M2/M4 settlePause 真库行为（内存库，真逻辑真 SQL）');
{
  const db = new DatabaseSync(':memory:');
  db.exec(
    "CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT DEFAULT '{}');" +
    "CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, content TEXT DEFAULT '', token_count INTEGER DEFAULT 0, created_at TEXT);"
  );
  const seed = (ctx: Record<string, unknown>) => {
    db.exec("DELETE FROM wa_tasks; DELETE FROM wa_task_conversations;");
    db.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('t1', JSON.stringify(ctx));
    const ins = db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, 't1', ?, ?, 0, '2026-09-10 03:13:33')");
    ins.run('m1', 'system', '[等待用户输入] 是否批准执行特权命令？ [选项: 允许, 拒绝]');
    ins.run('m2', 'system', '[等待用户输入] 任务执行前需确认：产出物范围');
    ins.run('m3', 'user', '历史回复');
  };
  const ctxOf = () => ({
    awaiting_input: { question: '是否批准？', options: [], decision_type: 'privilege_approval', asked_at: asked },
    pending_approval: { type: 'privilege', fingerprint: 'fp1' },
  });
  const ctxRow = () => JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('t1') as { context_json: string }).context_json) as Record<string, unknown>;
  const markers = () => (db.prepare('SELECT id FROM wa_task_conversations ORDER BY id').all() as Array<{ id: string }>).map(r => r.id).join(',');
  const pdb = db as unknown as PauseDb;

  // clear=false：保持暂停（连续拒绝）——落账判重、awaiting_input 与标记全留
  seed(ctxOf());
  const ctxA = ctxOf();
  settlePause(pdb, 't1', ctxA, 'deny', undefined, false);
  const a = ctxRow();
  ok(a.awaiting_input !== undefined, 'clear=false：awaiting_input 保留（同轮判重仍成立）');
  ok((a.pause_response as { decision?: string }).decision === 'deny', 'clear=false：pause_response 落账 decision');
  ok((a.pause_response as { asked_at?: string | null }).asked_at === asked, 'clear=false：落账 asked_at 取自当前 awaiting_input');
  ok('pending_approval' in a, 'clear=false：settlePause 不动 pending_approval（清理职责归调用方）');
  ok(markers() === 'm1,m2,m3', 'clear=false：会话标记一条不删');
  ok(isDuplicatePauseResponse(a, 'deny', undefined) === true, 'clear=false 落账后 → 重复点击被拦（连续拒绝场景闭环）');

  // clear=true：恢复路径——清 awaiting_input + 等待标记，保留门禁标记与用户回复行
  seed(ctxOf());
  const ctxB = ctxOf();
  settlePause(pdb, 't1', ctxB, 'allow', '是', true);
  const b = ctxRow();
  ok(b.awaiting_input === undefined, 'clear=true：ctxJson.awaiting_input 已清（横幅真源收口）');
  ok((b.pause_response as { value?: string | null }).value === '是', 'clear=true：落账 value 保留（allow 的回复文本）');
  ok(!markers().includes('m1'), 'clear=true：本次等待标记 [等待用户输入] 已删（旧问题不再顶横幅）');
  ok(markers().includes('m2'), 'clear=true：门禁标记「任务执行前需确认」不删（C1 回填仍需读它）');
  ok(markers().includes('m3'), 'clear=true：用户历史回复不动');
  ok(isDuplicatePauseResponse(b, 'allow', '是') === false, 'clear=true 后 → 新应答不再被判重（不误伤）');
  db.close();
}

console.log('S6 M4 本轮消息单写：3→1 真库行为（重复气泡根因）');
{
  const db = new DatabaseSync(':memory:');
  db.exec(
    "CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, content TEXT DEFAULT '', token_count INTEGER DEFAULT 0, created_at TEXT);"
  );
  const pdb = db as unknown as PauseDb;
  const reply = '全部确认，按此提交';
  const rows = () => db.prepare('SELECT role, content FROM wa_task_conversations ORDER BY rowid').all() as Array<{ role: string; content: string }>;
  const userRows = (c: string) => rows().filter(r => r.role === 'user' && r.content === c).length;

  // 旧链路三处写：IPC 边界 + jobs/ai-task + 执行器 → 同句回复 3 行（对照，非本实现路径）
  db.prepare("INSERT INTO wa_task_conversations (id,task_id,role,content,token_count,created_at) VALUES ('x1','t',  'user',?,0,'2026-09-10 03:13:33')").run(reply);
  db.prepare("INSERT INTO wa_task_conversations (id,task_id,role,content,token_count,created_at) VALUES ('x2','t',  'user',?,0,'2026-09-10 03:13:33')").run(reply);
  db.prepare("INSERT INTO wa_task_conversations (id,task_id,role,content,token_count,created_at) VALUES ('x3','t',  'user',?,0,'2026-09-10 03:13:39')").run(reply);
  ok(userRows(reply) === 3, '对照：旧链路同句回复落库 3 行（实测库中形态：同秒 2 行 + 6s 后 1 行）');

  // 新链路：IPC 边界写 1 行 → 执行器 persistTurnMessage 判「最新行已是同一句」→ 不重写
  db.exec('DELETE FROM wa_task_conversations');
  db.prepare("INSERT INTO wa_task_conversations (id,task_id,role,content,token_count,created_at) VALUES ('n1','t','user',?,0,datetime('now'))").run(reply);
  persistTurnMessage(pdb, 't', reply);
  ok(userRows(reply) === 1, '新链路：回复路径同句回复只落 1 行（IPC 边界为权威写入点，执行器不重写）');

  // 合成消息仍由执行器写（[系统恢复] / 默认「请执行任务：…」）
  persistTurnMessage(pdb, 't', '[系统恢复] 你之前的任务已恢复。…');
  ok(rows().filter(r => r.content.startsWith('[系统恢复]')).length === 1, '执行器仍写合成消息（[系统恢复]）——单写不等于不写');
  persistTurnMessage(pdb, 't', '[系统恢复] 你之前的任务已恢复。…（第二次，上下文更新）');
  ok(rows().filter(r => r.content.startsWith('[系统恢复]')).length === 1, '多次 resume 后 [系统恢复] 至多 1 行（单份化保留）');
  ok(userRows(reply) === 1, '单份化清理不误删用户回复行');

  // 全新任务（无任何消息）：默认「请执行任务：…」正常落库
  db.exec('DELETE FROM wa_task_conversations');
  persistTurnMessage(pdb, 't', '请执行任务：X');
  ok(rows().length === 1 && rows()[0]!.content === '请执行任务：X', '空历史任务：默认执行消息正常落 1 行');

  // 尾行不是同句（如中间夹了 assistant 回复）→ 不改写既有语义，照常追加
  db.exec('DELETE FROM wa_task_conversations');
  db.prepare("INSERT INTO wa_task_conversations (id,task_id,role,content,token_count,created_at) VALUES ('a1','t','assistant','好',0,datetime('now'))").run();
  persistTurnMessage(pdb, 't', reply);
  ok(userRows(reply) === 1, '尾行为 assistant → 用户消息照常追加（不误判）');
  db.close();
}
ok(!/if \(finalMsg\) \{\s*db\.prepare\([\s\S]{0,200}INSERT INTO wa_task_conversations/.test(aiTask),
  'jobs/ai-task 不再自写 finalMsg（原三处各写一遍的中间一层已去）');
// ⚠ 断言的是**语义**（唯一写入点、末参由 `taskMessage` 派生），不是调用点的逐字形状：
// zx_20260921 M2 给末参加了 `persistNotes` 尾注后，末参成为三目表达式，逐字串判据即失效。
// 「改了源码就改判据」在本条上是正当的——变的只是**判据的形状假设**，被断言的语义一字未动。
const exePersist = exe.match(/persistTurnMessage\(db, taskId, [\s\S]{0,200}?\);/);
ok(exePersist !== null && exePersist[0].includes('taskMessage'),
  '执行器收口改用 core/pause-settlement.persistTurnMessage（单一实现；末参由 taskMessage 派生）');
ok(exe.includes("content LIKE '[系统恢复]%'") === false, '清理 SQL 已不在执行器内联（随逻辑收归 core 模块）');
ok(ipc.includes("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'user'"),
  '用户回复的权威写入点仍在用户输入边界（task:resume/task:respond）');

console.log(`结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
