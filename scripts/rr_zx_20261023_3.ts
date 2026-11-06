/**
 * zx_20261023_3 受控复跑 —— 「令」：**令下即止，越界即拒**。
 *
 * 六组判据对应本轮六处引擎缺陷（全部**直引生产导出**跑真实现，不照抄等价物）：
 *   A「一道令，起跑前就生效」：`runStartRefusal` 只在 executing/preparing/running 放行；
 *      paused / 终态 / 查不到行各报其名；句柄已 abort 时优先报 aborted。接线：句柄登记在
 *      prelude **之前**、prelude 之后到 streamText 之前**再复核一次**、interrupt 如实回报有没有真中止。
 *   B「一步一步也听令」：`stepStopVerdict`——ask_user 是软收尾（不 abort）；
 *      paused ⇒ `status_paused`；终态 ⇒ `status_terminal:<s>`；正常态不动作。
 *   C「越界即拒」：`mutationGateVerdict`——暂停/终态/查不到行时**变更类**一律拒，
 *      只读与表态类（ask_user/escalate/interrupt/decide）仍放行；与工具注册表逐成员对账。
 *   D「发句话不等于复活」：`deliverPeerMessage` 只落会话、不改状态（paused 仍是 paused，
 *      pending 仍是 pending，updated_at 不动）；目标任务不存在时 `ok:false` 且不插孤儿行。
 *   E「谁拉起来的查得到」：`withJobSource` 给漏网的 ai-task 补 `unspecified`；既有入队点逐个带 source。
 *   F「归档不是完成」：父唤醒文案把暂停/归档子**分列**；全完成时才说「所有子任务已完成」。
 *
 * 纪律（承 auto-memory）：
 *   G-1 真源直 import（删/改名 ⇒ 编译期失败）。
 *   G-2 两只标本（该拒的拒 / 不该动的没动）。
 *   G-4 计数器正面断言（会话行 0→1、唤醒入队 0→1）。
 *   G-6 无轮次字面量：方案名/脚本名由 `path.basename(__filename)` 派生。
 *   ⚠ 判据文案不得含失败字形（全量汇总按字形计失败数）。
 *   ⚠ 末尾 build 钉读 `dist` ⇒ 常规须 `tsup` 先于本脚本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { runStartRefusal, stepStopVerdict, isRunnableStatus } from '../apps/worker-ant-desktop/src/main/core/stop-signals.js';
import {
  WORLD_MUTATING_TOOLS,
  NON_MUTATING_CONTROL_TOOLS,
  mutationGateVerdict,
  isWorldMutatingTool,
} from '../apps/worker-ant-desktop/src/main/core/tools/mutation-gate.js';
import { deliverPeerMessage } from '../apps/worker-ant-desktop/src/main/core/peer-message.js';
import { withJobSource } from '../apps/worker-ant-desktop/src/main/core/job-enqueuer.js';
import { checkParentTaskAfterChildDone } from '../apps/worker-ant-desktop/src/main/core/jobs/ai-task.js';
import { TOOL_METAS } from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';

type AnyDb = import('better-sqlite3').Database;

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
/** G-6：轮次标识由**载体自身**派生，本文件不写任何轮次字面量。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/** 夹具库：与生产同形的列（D1 / 跨任务消息 / 工具闸所触及的表）。 */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '', source TEXT DEFAULT 'user',
  acceptance_criteria TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, project_id TEXT, name TEXT NOT NULL,
  type TEXT DEFAULT 'doc', status TEXT DEFAULT 'draft', file_path TEXT, created_at TEXT DEFAULT (datetime('now')));
`;
const mkdb = (): AnyDb => {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  d.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('proj', '试作项目', '')").run();
  return d as unknown as AnyDb;
};

async function main(): Promise<void> {
  // ═══ A｜起跑前判据 ═════════════════════════════════════════════════════════════
  console.log('\n【A】起跑前判据：一道令，起跑前就生效');
  {
    for (const s of ['executing', 'preparing', 'running']) {
      eq(runStartRefusal(s, false), null, `A-1 在途态 ${s} 放行`);
      ok(isRunnableStatus(s), `A-1′ isRunnableStatus('${s}') 为真`);
    }
    eq(runStartRefusal('paused', false), 'status_paused', 'A-2 暂停拒起跑（因由码原样）');
    eq(runStartRefusal('completed', false), 'status_terminal:completed', 'A-3 终态 completed 拒起跑');
    eq(runStartRefusal('failed', false), 'status_terminal:failed', 'A-3b 终态 failed 拒起跑');
    eq(runStartRefusal('archived', false), 'status_terminal:archived', 'A-3c 终态 archived 拒起跑');
    eq(runStartRefusal('pending', false), 'status_pending', 'A-4 其它态按名回报（不压成一句模糊话）');
    eq(runStartRefusal(undefined, false), 'status_missing', 'A-5 查不到行如实报 status_missing');
    eq(runStartRefusal(null, false), 'status_missing', 'A-5b null 同报 status_missing');
    eq(runStartRefusal('executing', true), 'aborted', 'A-6 句柄已中止 ⇒ 优先报 aborted（即便状态还没落成 paused）');
    eq(runStartRefusal('paused', true), 'aborted', 'A-6b 中止与暂停同时成立时报 aborted（先停手上的活）');
    ok(!isRunnableStatus('paused') && !isRunnableStatus(null), 'A-7 反证：暂停/缺失不算可跑');

    // 接线：句柄登记必须在 prelude 之前（旧实现挂在 prelude 之后，暂停落在那千行里就 abort 不到）。
    const ex = CODE(`${A}/src/main/core/agent-executor.ts`);
    const iRegister = ex.indexOf('registerTaskRun(taskId, controller)');
    const iStream = ex.indexOf('const result = await streamText(');
    ok(iRegister >= 0, 'A-8 执行体确实登记了中断句柄');
    ok(iRegister >= 0 && iStream > iRegister, 'A-9 登记先于调用模型（prelude 期间也能被 abort 到）');
    ok(/const startRefusal = runStartRefusal\(claimedStatus, controller\.signal\.aborted\)/.test(ex),
      'A-10 认领后立刻复核一次（暂停落在这段里也不起跑）');
    ok(/const preStartRefusal = runStartRefusal\(preStartStatus, controller\.signal\.aborted\)/.test(ex),
      'A-11 调用模型前再复核一次（prelude 期间被暂停不漏网）');
    ok(/const aborted = abortTaskRun\([^)]*\);/.test(ex)
      && /aborted\s*\?[\s\S]{0,160}?:/.test(ex), 'A-12 interrupt 如实回报有没有真中止（旧实现丢弃返回值）');
    ok(/finally \{[\s\S]{0,400}?unregisterTaskRun\(taskId, controller\);/.test(ex),
      'A-13 所有出口统一注销句柄（含抛错）');

    // 每步判据的接线：exec-step 只调判据、真 abort，不再"记个旗继续跑"。
    const st = CODE(`${A}/src/main/core/exec-step.ts`);
    ok(/const stop = stepStopVerdict\(/.test(st), 'A-14 每步判据由 stop-signals 一处回答');
    ok(/d\.controller\.abort\(new Error\(stop\.abortReason\)\)/.test(st), 'A-15 判据给出因由时真 abort');
    ok(!/=== 'paused'/.test(st), 'A-16 反证：exec-step 里已无第二份 paused 判据（不再只置旗标）');
  }

  // ═══ B｜每步判据 ══════════════════════════════════════════════════════════════
  console.log('\n【B】每步判据：ask_user 软收尾，暂停/终态真中止');
  {
    eq(stepStopVerdict(['ask_user', 'write_file'], 'executing'),
      { askUser: true, abortReason: null }, 'B-1 ask_user 是软收尾（不 abort）');
    eq(stepStopVerdict(['ask_user'], 'paused'),
      { askUser: true, abortReason: null }, 'B-2 ask_user 优先于状态（它自己会把任务置 paused，别 abort 成失败）');
    eq(stepStopVerdict(['write_file'], 'paused'),
      { askUser: false, abortReason: 'status_paused' }, 'B-3 暂停 ⇒ 真中止');
    eq(stepStopVerdict(['write_file'], 'completed'),
      { askUser: false, abortReason: 'status_terminal:completed' }, 'B-4 终态 ⇒ 真中止');
    eq(stepStopVerdict(['write_file'], 'failed'),
      { askUser: false, abortReason: 'status_terminal:failed' }, 'B-4b failed 同样中止');
    eq(stepStopVerdict(['write_file'], 'executing'),
      { askUser: false, abortReason: null }, 'B-5 正常态不动作');
    eq(stepStopVerdict(['write_file'], undefined),
      { askUser: false, abortReason: null }, 'B-6 查不到行不在此处 abort（交给工具闸，避免误记失败）');
    eq(stepStopVerdict([], 'paused'),
      { askUser: false, abortReason: 'status_paused' }, 'B-7 空步也看状态（不被"无工具"短路）');
  }

  // ═══ C｜工具闸 ════════════════════════════════════════════════════════════════
  console.log('\n【C】越界即拒：变更类工具调用时看状态');
  {
    // zx_20261030_2 M3：不再写死件数（那是"只为下一轮"的哑雷）——由注册表派生：
    //   非只读件数 − 刻意豁免的表态类 = 变更类应有件数（逐成员对齐仍由 C-11/C-13 钉）。
    const nonReadonly = TOOL_METAS.filter((m) => !m.isReadOnly).length;
    eq(WORLD_MUTATING_TOOLS.length, nonReadonly - NON_MUTATING_CONTROL_TOOLS.length,
      'C-1 变更类工具清单与注册表非只读件数对账（逐类：write/control/shell/memory/resource/device）');

    let allRefused = true; let firstOk = '';
    for (const name of WORLD_MUTATING_TOOLS) {
      const v = mutationGateVerdict('paused', name);
      if (v.ok) { allRefused = false; firstOk ||= name; }
    }
    ok(allRefused, 'C-2 暂停时**每一件**变更类工具都被拒（无漏网）', firstOk ? `漏网：${firstOk}` : `${WORLD_MUTATING_TOOLS.length} 件全拒`);
    eq(mutationGateVerdict('paused', 'edit_file').reason, 'status_paused', 'C-3 拒因码 status_paused');
    ok(!!mutationGateVerdict('paused', 'edit_file').message, 'C-4 拒时给模型一句可执行说明（不是空字符串）');

    let allAllowed = true;
    for (const name of WORLD_MUTATING_TOOLS) {
      for (const s of ['executing', 'preparing', 'running']) {
        if (!mutationGateVerdict(s, name).ok) allAllowed = false;
      }
    }
    ok(allAllowed, 'C-5 反证：在途三态下变更类工具全部放行（不误伤正常执行）');

    // 表态类：暂停中也得说得出话（守卫只拦会改变世界的动作）。
    for (const name of NON_MUTATING_CONTROL_TOOLS) {
      const v = mutationGateVerdict('paused', name);
      ok(v.ok && !isWorldMutatingTool(name), `C-6 表态类 ${name} 暂停中仍放行`);
    }
    // 只读工具：看不是越界。
    for (const name of ['read_file', 'list_files', 'task_get']) {
      ok(mutationGateVerdict('paused', name).ok, `C-7 只读 ${name} 暂停中仍放行`);
    }
    eq(mutationGateVerdict('completed', 'write_file').reason, 'status_terminal:completed', 'C-8 终态拒因码');
    eq(mutationGateVerdict(undefined, 'write_file').reason, 'status_missing', 'C-9 查不到行一律拒（宁可不动）');
    eq(mutationGateVerdict('pending', 'write_file').reason, 'status_pending', 'C-10 非在途态按名拒');

    // 与注册表逐成员对账：非只读的每一件都必须有归属（变更类或被刻意豁免的表态类）。
    const stateSet = new Set(TOOL_METAS.filter((m) => !m.isReadOnly).map((m) => m.name));
    const covered = new Set<string>([...WORLD_MUTATING_TOOLS, ...NON_MUTATING_CONTROL_TOOLS]);
    const uncovered = [...stateSet].filter((n) => !covered.has(n));
    eq(uncovered, [], 'C-11 注册表非只读工具与闸清单逐成员对齐（新增非只读工具必须归类，否则此处红）');
    const ghost = [...covered].filter((n) => !TOOL_METAS.some((m) => m.name === n));
    eq(ghost, [], 'C-12 反证：闸清单里的名字全部在注册表在册（不写不存在的工具）');
    eq(stateSet.size, WORLD_MUTATING_TOOLS.length + NON_MUTATING_CONTROL_TOOLS.length,
      'C-13 两表之和等于注册表非只读件数（无重复计数）');

    // 接线：闸包在「Step1 只读限制」之前（否则 savedTools 还原回未包壳原件，闸被绕开）。
    const ex = CODE(`${A}/src/main/core/agent-executor.ts`);
    const iGate = ex.indexOf('for (const name of WORLD_MUTATING_TOOLS)');
    const iSaved = ex.indexOf('const savedTools: Record<string, unknown> = {}');
    ok(iGate >= 0, 'C-14 执行体真给变更类工具包了状态闸');
    ok(iGate >= 0 && iSaved > iGate, 'C-15 包壳先于 Step1 的 savedTools 捕获（还原不会绕过闸）');
    ok(/const nowStatus = \(db\.prepare\('SELECT status FROM wa_tasks WHERE id = \?'\)\.get\(taskId\)/.test(ex),
      'C-16 闸在**调用时**读库（不是装配时快照）');
    ok(/const verdict = mutationGateVerdict\(nowStatus, name\)/.test(ex), 'C-17 接线用本模块判据（无第二份等价物）');
    ok(/return JSON\.stringify\(\{ error: verdict\.message, refused: verdict\.reason, tool: name \}\)/.test(ex),
      'C-18 被拒时如实回因由（模型能看出是"没执行"而非"执行失败"）');
  }

  // ═══ D｜跨任务消息 ═════════════════════════════════════════════════════════════
  console.log('\n【D】发句话不等于复活：消息只落会话，不改状态');
  {
    const db = mkdb();
    const insTask = (id: string, status: string) => db.prepare(
      'INSERT INTO wa_tasks (id, project_id, title, status, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, 'proj', id, status, '2020-01-01 00:00:00');
    insTask('d-from-12345678', 'executing');
    insTask('d-to-paused', 'paused');
    insTask('d-to-pending', 'pending');

    const statusOf = (id: string) => (db.prepare('SELECT status, updated_at FROM wa_tasks WHERE id = ?').get(id) as { status: string; updated_at: string });

    // 正标本：暂停中的目标任务——旧实现会把它裸 UPDATE 回 pending。
    const convBefore = (db.prepare("SELECT COUNT(*) AS c FROM wa_task_conversations WHERE task_id = 'd-to-paused'").get() as { c: number }).c;
    eq(convBefore, 0, 'D-1 起点：目标任务会话 0 行');
    const r1 = deliverPeerMessage(db, { fromTaskId: 'd-from-12345678', toTaskId: 'd-to-paused', content: '请复核 3/6 的验收' });
    ok(r1.ok, 'D-2 投递成功');
    eq(r1.ok && r1.delivered, 'on_resume', 'D-3 暂停目标标记为恢复后可读（on_resume）');
    eq(statusOf('d-to-paused').status, 'paused', 'D-4 状态仍是 paused（消息不复活任务）');
    eq(statusOf('d-to-paused').updated_at, '2020-01-01 00:00:00', 'D-5 updated_at 不动（不制造"刚更新过"的假象）');
    const convAfter = (db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = 'd-to-paused'").all() as Array<{ content: string }>);
    eq(convAfter.length, 1, 'D-6 会话行 0→1（正面断言）');
    ok(convAfter[0]!.content.startsWith('[来自任务 d-from-1] ') && convAfter[0]!.content.includes('请复核 3/6 的验收'),
      'D-7 行内带来源任务前缀与原文', convAfter[0]!.content);

    // 反标本：pending 目标——不改状态，标记立即读取。
    const r2 = deliverPeerMessage(db, { fromTaskId: 'd-from-12345678', toTaskId: 'd-to-pending', content: '补充材料已落盘' });
    eq(r2.ok && r2.delivered, 'now', 'D-8 pending 目标标记为当前可读（now）');
    eq(statusOf('d-to-pending').status, 'pending', 'D-9 状态仍是 pending（不借投递改队列）');

    // 目标不存在：ok:false，且**不插孤儿会话行**（旧实现先插行后查目标）。
    const totalBefore = (db.prepare('SELECT COUNT(*) AS c FROM wa_task_conversations').get() as { c: number }).c;
    const r3 = deliverPeerMessage(db, { fromTaskId: 'd-from-12345678', toTaskId: 'd-no-such-task', content: '无人可读' });
    ok(!r3.ok, 'D-10 目标任务不存在 ⇒ ok:false');
    ok(!r3.ok && r3.error.includes('不存在'), 'D-11 失败原因如实（不是静默成功）');
    const totalAfter = (db.prepare('SELECT COUNT(*) AS c FROM wa_task_conversations').get() as { c: number }).c;
    eq(totalAfter, totalBefore, 'D-12 反证：失败投递不改会话账（无孤儿行）');

    // 接线：工具执行的是这一处实现，不是自己再写一份。
    const ctl = CODE(`${A}/src/main/core/tools/control.ts`);
    ok(/deliverPeerMessage\(db, \{ fromTaskId: taskId, toTaskId: args\.toTaskId, content: args\.content \}\)/.test(ctl),
      'D-13 send_message_to_task 直调唯一投递实现');
    ok(!/UPDATE wa_tasks SET status = 'pending'[\s\S]{0,200}send_message/.test(ctl)
      && !/send_message_to_task[\s\S]{0,400}UPDATE wa_tasks SET status/.test(ctl),
      'D-14 反证：该工具内已无裸改状态的语句');
  }

  // ═══ E｜作业来源 ══════════════════════════════════════════════════════════════
  console.log('\n【E】谁拉起来的查得到：ai-task 载荷必有 source');
  {
    eq(withJobSource('ai-task', { taskId: 't1', projectId: 'p' }),
      { taskId: 't1', projectId: 'p', source: 'unspecified' }, 'E-1 漏网的一发补 source:unspecified（兄弟键保留）');
    eq(withJobSource('ai-task', { taskId: 't1', source: 'gui_start' }),
      { taskId: 't1', source: 'gui_start' }, 'E-2 已带 source 的原样（不覆盖真实来源）');
    eq(withJobSource('resume-ai-task', { taskId: 't1' }),
      { taskId: 't1' }, 'E-3 反证：非 ai-task 类型不加这个键');
    const tidShort = withJobSource('ai-task', { taskId: '28e6a12f-1111' }) as { source?: string };
    eq(tidShort.source, 'unspecified', 'E-4 实测标本形（只有 taskId/projectId）也被补上');

    // 两条入队路都过同一归一化：scheduler.enqueue（内存队列）与 enqueueJob 的兜底裸插。
    const sch = CODE(`${A}/src/main/core/task-scheduler.ts`);
    ok(/import \{ withJobSource \} from '\.\/job-enqueuer\.js'/.test(sch), 'E-5 调度器复用同一实现（无第二份判断）');
    ok(/const finalPayload = withJobSource\(type, payload\)/.test(sch), 'E-6 调度器入队前归一化');
    ok(/JSON\.stringify\(finalPayload\)/.test(sch) && /payload: finalPayload/.test(sch),
      'E-7 写库与内存队列用的是**同一份**归一化载荷');
    const enq = CODE(`${A}/src/main/core/job-enqueuer.ts`);
    ok((enq.match(/finalPayload/g) ?? []).length >= 3,
      'E-8 enqueueJob 的两条支路（注入 enqueuer / 兜底裸插）都带归一化结果');

    // 静态扫面：src/main 下所有 ai-task 入队点的载荷都写了 source（逐文件枚举，不是数个数）。
    //   三种形态都算入队面：`enqueueJob(db, 'ai-task', …)`、`scheduler.enqueue('ai-task', …)`、
    //   GUI 的**裸插** `INSERT INTO wa_jobs … 'ai-task'`（zx_20261023_3 批四正是为这两处补的 source）。
    //   调度器/入队器自己的总闸不在此列——它们的载荷由 `withJobSource` 归一（E-5–E-8 已钉）。
    const GATEWAYS = new Set(['core/task-scheduler.ts', 'core/job-enqueuer.ts']);
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : (e.name.endsWith('.ts') ? [p] : []);
    });
    const ENQ = /(?:enqueueJob\(\s*[A-Za-z0-9_.]+(?:\s+as\s+[^,]+)?,\s*|\.enqueue\(\s*)'ai-task',\s*\{|INSERT INTO wa_jobs[^"']*'ai-task'/g;
    const hits: Array<{ file: string; hasSource: boolean }> = [];
    for (const f of walk(path.join(root, A, 'src/main'))) {
      const rel = path.relative(path.join(root, A, 'src/main'), f);
      if (GATEWAYS.has(rel)) continue;
      const src = stripKeepingLines(fs.readFileSync(f, 'utf-8')).join('\n');
      for (const m of src.matchAll(ENQ)) {
        const payloadText = src.slice(Math.max(0, (m.index ?? 0) - 200), (m.index ?? 0) + 400);
        hits.push({ file: `src/main/${rel}`, hasSource: /\bsource\b/.test(payloadText) });
      }
    }
    const files = [...new Set(hits.map((h) => h.file))];
    const expected = [
      'src/main/core/node-request-runner.ts',
      'src/main/core/tools/resource.ts',
      'src/main/core/tools/control.ts',
      'src/main/core/jobs/ai-task.ts',
      'src/main/core/self-healing-monitor.ts',
      'src/main/ipc/project.ipc.ts',
      'src/main/index.ts',
      'src/main/services/im-router.ts',
    ];
    const missingFiles = expected.filter((f) => !files.includes(f));
    eq(missingFiles, [], 'E-9 已审计的 8 处入队面全部扫到（扫面按成员枚举）');
    const noSource = hits.filter((h) => !h.hasSource).map((h) => h.file);
    eq(noSource, [], `E-10 每个 ai-task 入队点都写了 source（共 ${hits.length} 处）`);
  }

  // ═══ F｜父唤醒文案 ═════════════════════════════════════════════════════════════
  console.log('\n【F】归档不是完成：父唤醒如实分列暂停/归档');
  {
    const mkParent = (db: AnyDb, pid: string) => db.prepare(
      "INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, 'proj', ?, 'paused', '{}')",
    ).run(pid, pid);
    const mkKid = (db: AnyDb, id: string, pid: string, status: string) => db.prepare(
      'INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id) VALUES (?, ?, ?, ?, ?)',
    ).run(id, 'proj', id, status, pid);
    const statusOf = (db: AnyDb, id: string) => (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
    const runD1 = (db: AnyDb, kid: string): string[] => {
      const jobs: string[] = [];
      checkParentTaskAfterChildDone(db, kid, {
        enqueue: (_type, payload) => { jobs.push(String(payload.message ?? '')); return Promise.resolve(); },
      });
      return jobs;
    };

    // 正标本 1：全完成 ⇒ 沿用旧文案（rr 与界面按此句识别）。
    {
      const db = mkdb();
      mkParent(db, 'f-all');
      mkKid(db, 'f-all-a', 'f-all', 'completed');
      mkKid(db, 'f-all-b', 'f-all', 'completed');
      const jobs = runD1(db, 'f-all-a');
      eq(jobs.length, 1, 'F-1 全部完成 ⇒ 唤醒父 0→1');
      ok(jobs[0]!.startsWith('[系统] 所有子任务已完成，恢复父任务。'), 'F-2 全完成文案逐字不变（既有识别句）', jobs[0]);
      eq(statusOf(db, 'f-all'), 'pending', 'F-3 父被置回 pending（既有防死锁路原样）');
    }

    // 正标本 2：另有**归档**子 ⇒ 不许说"已完成"（实测事故：归档两个无效子被读成子跑完了）。
    {
      const db = mkdb();
      mkParent(db, 'f-arch');
      mkKid(db, 'f-arch-a', 'f-arch', 'completed');
      mkKid(db, 'f-arch-b', 'f-arch', 'archived');
      const jobs = runD1(db, 'f-arch-a');
      eq(jobs.length, 1, 'F-4 归档子场景：父仍被唤醒复核 0→1（已停 ⇒ 父须处置）');
      ok(jobs[0]!.includes('归档 1 个'), 'F-5 唤醒文案如实写「归档 1 个」', jobs[0]);
      ok(jobs[0]!.includes('子任务已全部结束') && !jobs[0]!.includes('所有子任务已完成'),
        'F-6 反证：归档不等于完成，不得用"所有子任务已完成"');
      eq(statusOf(db, 'f-arch'), 'pending', 'F-7 父置回 pending 等人复核');
    }

    // 正标本 3：暂停子 ⇒ 分列"暂停 N 个"（与归档各说各的）。
    {
      const db = mkdb();
      mkParent(db, 'f-pause');
      mkKid(db, 'f-pause-a', 'f-pause', 'completed');
      mkKid(db, 'f-pause-b', 'f-pause', 'paused');
      const jobs = runD1(db, 'f-pause-a');
      eq(jobs.length, 1, 'F-8 暂停子场景：父被唤醒复核 0→1');
      ok(jobs[0]!.includes('暂停 1 个') && !jobs[0]!.includes('归档'), 'F-9 只说暂停 1 个，不夹带归档', jobs[0]);
      ok(!jobs[0]!.includes('所有子任务已完成'), 'F-10 反证：暂停也不等于完成');
    }

    // 正标本 4：暂停+归档并存 ⇒ 两样都分列（"其中暂停 1 个、归档 1 个"）。
    {
      const db = mkdb();
      mkParent(db, 'f-both');
      mkKid(db, 'f-both-a', 'f-both', 'completed');
      mkKid(db, 'f-both-b', 'f-both', 'paused');
      mkKid(db, 'f-both-c', 'f-both', 'archived');
      const jobs = runD1(db, 'f-both-a');
      ok(jobs.length === 1 && jobs[0]!.includes('暂停 1 个、归档 1 个'),
        'F-11 暂停与归档并存的文案两口账都数全', jobs[0]);
      ok(jobs[0]!.includes('（其中暂停 1 个、归档 1 个）'), 'F-12 分列格式稳定（两数同现）', jobs[0]);
    }
  }

  // ═══ S｜哑雷自检 + build 钉 ═══════════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfPath = `scripts/${path.basename(__filename)}`;
    const selfLines = stripKeepingLines(RD(selfPath)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6）', selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 方向性自指：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)), 'S3 本套件在册（脚本名由载体派生）');

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告
//   unhandled rejection 之前把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\nrr_${SELF_ROUND} 未捕获异常（复跑未跑完，不得读作通过）：`, e);
  fail++;
  console.log(`\nFAIL rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
