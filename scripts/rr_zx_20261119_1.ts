/**
 * zx_20261119_1 「循」受控复跑。
 *
 * 分组（与方案 §3 批次一一对应）：
 *   A「迹」完成事件：claim 三态 / 自检判据 / 不变量收紧与回填
 *   B「循」自动模板：意图相容 + 更强证据（S1 真实文本对为反证）
 *   C「止」等答子不唤醒父：双面（不唤醒 / 完成后仍唤醒）
 *   D「通」工具面：/dev/null 放行、写文件仍拒、拒绝文案点名免费替代
 *   E「名」探针窄规则 + 成果退休写口
 *   F「证」build 钉与源码形状
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引生产函数 / 真实现（被删/改名即编译期失败）。
 *   · 两侧标本同试；计数器类断言给 0→N 的正面值。
 *   · 断言文案不含失败字形；表结构走生产 `initDatabase`。
 *   · 夹具按生产初始化顺序：先 initDatabase，再插数据行。
 *   · 不以轮次字面量做等值断言；build 钉由 `checkBuildPins` 派生核对。
 *   · 未实施组用 `skip()` 如实标注，不记 pass（占位不是绿灯）。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { checkBuildPins, buildNotOlderThan, stripKeepingLines } from './lib/rr-pins.js';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';
import { claimCompletedEmit, completedEmitDecision } from '../apps/worker-ant-desktop/src/main/core/run-trace.js';
import { hasCompletionEvent } from '../apps/worker-ant-desktop/src/main/core/task-outcome.js';
import { runAllInvariants, repairInvariant } from '../apps/worker-ant-desktop/src/main/core/architectural-invariants.js';
import {
  intentOfText, autoTemplateRejectReason, decideTemplateMatch, loadTemplatePool, matchTaskTemplate,
} from '../apps/worker-ant-desktop/src/main/core/task-templates.js';
import { checkParentTaskAfterChildDone } from '../apps/worker-ant-desktop/src/main/core/jobs/ai-task.js';
import { archiveTask } from '../apps/worker-ant-desktop/src/main/core/task-archive.js';
import { validateReadonlyBashCommand } from '../apps/worker-ant-desktop/src/main/core/tool-guards.js';
import { deriveShellExploreQuota, SHELL_EXPLORE_QUOTA } from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';
import { resolveExplorationQuota } from '../apps/worker-ant-desktop/src/main/core/step-budget.js';
import { isProbePath, docNotProbe, retireDeliverable } from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';

let pass = 0;
let fail = 0;
let skipped = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ok ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}
/** 未实施组的如实占位：不进 pass，也不进 fail。 */
function skip(label: string): void { skipped++; console.log(`  · SKIP ${label}`); }

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261119-1-'));
let dbSeq = 0;
function mkdb(): Database.Database {
  const db = initDatabase(path.join(tmpRoot, `db-${++dbSeq}`));
  db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p','P',?)").run(tmpRoot);
  return db;
}
const SELF = path.basename(__filename).replace(/\.ts$/, '');

// ── A 组「迹」 ───────────────────────────────────────────────────────────────

{
  // A1 claim 三态（空 runId / 首次 / 重复）——计数器给 0→1 的正面值
  {
    const empty: { runId?: string; completedRuns?: string[] } = {};
    ok(claimCompletedEmit(empty) === true, 'A1 无 runId 放行');
    eq(empty.completedRuns, undefined, 'A1 无 runId 不改 completedRuns');
    const ctx: { runId?: string; completedRuns?: string[] } = { runId: 'run-a' };
    const first = completedEmitDecision(ctx);
    ok(first.allow === true && first.seen.length === 0, 'A1 首次判定放行且 seen=0');
    ok(claimCompletedEmit(ctx) === true, 'A1 首次 claim 放行');
    eq(ctx.completedRuns, ['run-a'], 'A1 首次 claim 后 completedRuns 从 0 变 1');
    const second = completedEmitDecision(ctx);
    ok(second.allow === false && second.seen[0] === 'run-a', 'A1 重复判定为不放行且带回 seen');
    ok(claimCompletedEmit(ctx) === false, 'A1 重复 claim 拒绝');
    eq(ctx.completedRuns, ['run-a'], 'A1 重复 claim 不重复入账');
  }

  // A2 hasCompletionEvent：只认 task.completed（status_changed 不顶替）
  {
    const db = mkdb();
    const tid = crypto.randomUUID();
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?, 'p', 't', 'completed')").run(tid);
    ok(hasCompletionEvent(db, tid) === false, 'A2 无任何事件 → false');
    db.prepare("INSERT INTO wa_event_log (event_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, occurred_at) VALUES (?, 'task.status_changed', 'task', ?, 1, '{}', '2026-11-19T00:00:00.000Z')")
      .run(crypto.randomUUID(), tid);
    ok(hasCompletionEvent(db, tid) === false, 'A2 仅 status_changed → false（旧式完成不顶替）');
    db.prepare("INSERT INTO wa_event_log (event_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, occurred_at) VALUES (?, 'task.completed', 'task', ?, 2, '{}', '2026-11-19T00:00:01.000Z')")
      .run(crypto.randomUUID(), tid);
    ok(hasCompletionEvent(db, tid) === true, 'A2 有 task.completed → true');
    db.close();
  }

  // A3 不变量收紧 + 勾选回填（真库同类形状：有完成事件 / 只有 status_changed / 零事件）
  {
    const db = mkdb();
    const t1 = crypto.randomUUID();
    const t2 = crypto.randomUUID();
    const t3 = crypto.randomUUID();
    for (const [id, title] of [[t1, '有完成事件'], [t2, '仅状态事件'], [t3, '零事件']] as const) {
      db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, aggregate_version) VALUES (?, 'p', ?, 'completed', 0)").run(id, title);
    }
    const ev = (type: string, id: string) => db.prepare("INSERT INTO wa_event_log (event_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, occurred_at) VALUES (?, ?, 'task', ?, 1, '{}', '2026-11-19T00:00:00.000Z')").run(crypto.randomUUID(), type, id);
    ev('task.completed', t1);
    ev('task.status_changed', t2);

    const inv = () => runAllInvariants(db).find((r) => r.name === 'task-completion-audit');
    const before = inv()!;
    ok(before.passed === false, 'A3 三类标本下不变量为违规');
    eq(before.violations.map((v) => v.refId), [t2, t3], 'A3 违规恰为「仅状态事件」与「零事件」两条（完整 id）');
    ok(before.violations[0]!.detail.includes('旧式完成'), 'A3 第一条标注「旧式完成」');
    ok(before.violations[1]!.detail.includes('无任何完成事件'), 'A3 第二条标注「无任何完成事件」');

    const noop = repairInvariant(db, 'task-completion-audit', { ids: [] });
    eq(noop.repaired, 0, 'A3 空勾选 → 一条都不回填');
    ok(inv()!.violations.length === 2, 'A3 空勾选后违规数不变');

    const r2 = repairInvariant(db, 'task-completion-audit', { ids: [t2] });
    eq(r2.repaired, 1, 'A3 只回填所选（t2）');
    eq(inv()!.violations.map((v) => v.refId), [t3], 'A3 回填后仅剩 t3');
    ok(hasCompletionEvent(db, t2) === true, 'A3 t2 现已具备完成事件');
    const meta = db.prepare("SELECT metadata FROM wa_event_log WHERE aggregate_id=? AND event_type='task.completed' ORDER BY id DESC LIMIT 1").get(t2) as { metadata: string };
    ok(meta.metadata.includes('audit-backfill'), 'A3 回填事件带 audit-backfill 标记');

    const r3 = repairInvariant(db, 'task-completion-audit', { ids: [t3] });
    eq(r3.repaired, 1, 'A3 回填 t3');
    ok(inv()!.passed === true, 'A3 两条都回填后不变量通过');
    db.close();
  }

  // A4 源码形状：两个收口出口走**同一实现**（completion-emit.ts），按语句形状、不按行号
  {
    for (const rel of ['src/main/core/agent-executor.ts', 'src/main/core/exec-finalize.ts']) {
      const code = stripKeepingLines(fs.readFileSync(path.join(root, A, rel), 'utf-8')).join('\n');
      ok(/emitCompletionEvent\(\{/.test(code), `A4 ${rel} 走统一发射口`);
      ok(/verifyCompletionEvent\(\{/.test(code), `A4 ${rel} 走统一自检口`);
    }
    const ce = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/completion-emit.ts'), 'utf-8')).join('\n');
    ok(/claimCompletedEmit\(ctx\)/.test(ce), 'A4 统一口复用 claim 幂等门');
    ok(/完成事件发射失败/.test(ce) && /完成事件判定为本 run 已发过/.test(ce), 'A4 统一口两个失败/跳过分支均有痕迹');
    ok(/hasCompletionEvent\(db, taskId\)/.test(ce), 'A4 自检走只认 task.completed 的真源判据');
  }
}

// ── B 组「循」 ───────────────────────────────────────────────────────────────

{
  // B1 意图判定：S1 的真实文本对（诊断模板 vs 接口实施任务）
  const TPL_NAME = '新后端执行提现打款时报错问题诊断分析';
  const TPL_DESC = '基于 3 次同 archetype 成功拆解（成功率 100%）自动提炼：1、新后端目录：backend/；2、通过后端管理页面（项目目录： platform-web/） 提现申请（路由地址：order/withdrawals）进行提现审批并确认打款报错';
  const TASK2_TITLE = '新后端易宝支付代付提现接口调整';
  const TASK2_DESC = '1、新后端目录：backend/；2、易宝支付SDK源码目录：funDevelop/yop-java-sdk；3、该接口需要替换之前 YeepayPaymentGateway 类中的 "/rest/v1.0/balance/transfer_send" 接口；4、查询接口需要替换 "/rest/v1.0/balance/transfer_query" 接口；5、调整两个接口后，同时核对 代付回调 接口是否也需同步调整';
  const TASK2_TEXT = `${TASK2_TITLE} ${TASK2_DESC}`;
  eq(intentOfText(`${TPL_NAME} ${TPL_DESC}`), 'diagnose', 'B1 模板文本意图=diagnose');
  eq(intentOfText(TASK2_TEXT), 'implement', 'B1 任务二文本意图=implement');
  eq(intentOfText('优化提现流程并输出方案'), 'plan', 'B1 规划词表命中 plan');

  // B2 auto 模板不合格原因：意图不符优先于证据
  const tpl = { name: TPL_NAME, description: TPL_DESC, source: 'auto' };
  eq(autoTemplateRejectReason({ tpl, field: 'title', hits: ['新后', '后端', '提现'], incomingText: TASK2_TEXT }), 'intent_mismatch', 'B2 诊断模板对实施任务 → intent_mismatch');
  eq(autoTemplateRejectReason({ tpl, field: 'title', hits: ['后端', '提现'], incomingText: '报错后端提现' }), 'weak_evidence', 'B2 同意图但仅 2 个 bigram → weak_evidence');
  eq(autoTemplateRejectReason({ tpl, field: 'title', hits: ['code', '后端', '提现'], incomingText: '报错 code 后端 提现' }), null, 'B2 同意图 + 3 命中且含非 bigram → 合格');
  eq(autoTemplateRejectReason({ tpl: { ...tpl, source: 'system' }, field: 'title', hits: ['后端', '提现'], incomingText: TASK2_TEXT }), null, 'B2 内置模板不受新门槛影响');

  // B3 真池子：S1 真实文本对不再命中（反证）；同意图的诊断任务仍命中（正证）
  {
    const db = mkdb();
    const tplId = 'tpl-auto-s1';
    db.prepare(`INSERT INTO wa_task_templates (id, name, category, description, subtasks, keywords, status, priority, source, match_count)
      VALUES (?, ?, 'code', ?, ?, ?, 'active', -1, 'auto', 1)`).run(
      tplId, TPL_NAME, TPL_DESC,
      JSON.stringify([{ title: '定位报错来源代码', description: 'd' }, { title: '编写修复方案', description: 'd' }]),
      JSON.stringify(['code', TPL_NAME, '新后', '后端', '端执', '执行', '行提', '提现', '现打', '打款', '款时', '时报']),
    );
    loadTemplatePool(db);
    eq(matchTaskTemplate(db, TASK2_TITLE, TASK2_DESC), null, 'B3 任务二文本不再命中诊断模板');
    const dTask2 = decideTemplateMatch(db, TASK2_TITLE, TASK2_DESC);
    eq(dTask2.skip, 'intent_mismatch', 'B3 decideTemplateMatch 报 intent_mismatch 而非静默');
    eq(dTask2.hit?.template.name, TPL_NAME, 'B3 仍带回"本可命中谁"供诊断');
    // 同意图的诊断任务：不因新门槛被误挡（命中后由既有 repair_intent 守卫决定不拆）
    const diagHit = matchTaskTemplate(db, '新后端提现报错定位，读 code 与后端日志', '');
    eq(diagHit?.template.name, TPL_NAME, 'B3 同意图且证据足够 → 仍命中模板');
    const diagDecision = decideTemplateMatch(db, '新后端提现报错定位，读 code 与后端日志', '');
    eq(diagDecision.skip, 'repair_intent', 'B3 诊断任务仍走既有 repair_intent 守卫');
    // 软删除的模板不再进池
    db.prepare("UPDATE wa_task_templates SET status='deleted' WHERE id=?").run(tplId);
    loadTemplatePool(db);
    eq(matchTaskTemplate(db, '新后端提现报错定位，读 code 与后端日志', ''), null, 'B3 已删除模板不再参与匹配');
    db.close();
    loadTemplatePool(mkdb()); // 清池，避免污染后续组
  }

  // B4 删除语义：列表排除已删除模板（源码形状；IPC 行为在 GUI 手动验）
  {
    const code = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/ipc/project.ipc.ts'), 'utf-8')).join('\n');
    ok(/SET status = 'deleted'/.test(code), 'B4 删除写入 deleted 状态');
    ok(/FROM wa_task_templates t\s+WHERE t\.status != 'deleted'/.test(code), 'B4 模板列表排除已删除');
    ok(/模板已删除（如需复用请新建）/.test(code), 'B4 已删除模板拒绝更新复活');
  }
}

// ── C 组「止」 ───────────────────────────────────────────────────────────────

{
  const mkTree = (): { db: Database.Database; pid: string; cid: string } => {
    const db = mkdb();
    const pid = crypto.randomUUID();
    const cid = crypto.randomUUID();
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, 'p', '父', 'paused', ?)")
      .run(pid, JSON.stringify({ pause_reason: 'children_incomplete' }));
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id, context_json) VALUES (?, 'p', '子', 'paused', ?, ?)")
      .run(cid, pid, JSON.stringify({ pause_reason: 'awaiting_input', awaiting_input: { question: 'D-1 选哪个？', asked_at: '2026-11-19T00:00:00Z' } }));
    return { db, pid, cid };
  };
  const parentRow = (db: Database.Database, pid: string) => db.prepare('SELECT status FROM wa_tasks WHERE id=?').get(pid) as { status: string };

  // C1 唯一子等答 ⇒ 不唤醒（0 次入队、父仍 paused）
  //   ⚠ 不在此断言事件表：rr 进程未接线 `eventBus.setEventStore`，事件不会落库，
  //     "0 条"会因**接线缺失**而非"没发"成立——那是假绿。事件形状由 F 组源码断言覆盖。
  {
    const { db, pid, cid } = mkTree();
    let enqueued = 0;
    checkParentTaskAfterChildDone(db, cid, { enqueue: async () => { enqueued += 1; return 'job'; }, enqueued: () => {} });
    eq(enqueued, 0, 'C1 等答子不唤醒父（enqueue 0 次）');
    eq(parentRow(db, pid).status, 'paused', 'C1 父任务保持 paused');
    db.close();
  }

  // C2 子完成 ⇒ 仍唤醒（同一夹具的正面 0→1）
  {
    const { db, pid, cid } = mkTree();
    db.prepare("UPDATE wa_tasks SET status='completed' WHERE id=?").run(cid);
    let enqueued = 0;
    checkParentTaskAfterChildDone(db, cid, { enqueue: async () => { enqueued += 1; return 'job'; }, enqueued: () => {} });
    eq(enqueued, 1, 'C2 子完成后父被唤醒（enqueue 从 0 变 1）');
    eq(parentRow(db, pid).status, 'pending', 'C2 父任务置回 pending');
    db.close();
  }

  // C3 混合场景（等答子 + 已归档子）⇒ 仍唤醒（父确有需复核的东西）
  {
    const { db, pid, cid } = mkTree();
    const aid = crypto.randomUUID();
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id, context_json) VALUES (?, 'p', '已归档子', 'archived', ?, '{}')").run(aid, pid);
    let enqueued = 0;
    checkParentTaskAfterChildDone(db, cid, { enqueue: async () => { enqueued += 1; return 'job'; }, enqueued: () => {} });
    eq(enqueued, 1, 'C3 混合场景仍唤醒父');
    eq(parentRow(db, pid).status, 'pending', 'C3 混合场景父任务 pending');
    db.close();
  }

  // C4 归档待答任务留痕（M3 第三项）
  {
    const db = mkdb();
    const pid = crypto.randomUUID();
    const cid = crypto.randomUUID();
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, 'p', '父', 'pending', '{}')").run(pid);
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id, context_json) VALUES (?, 'p', '子', 'paused', ?, ?)")
      .run(cid, pid, JSON.stringify({ pause_reason: 'awaiting_input', awaiting_input: { question: '三个口径怎么定？', asked_at: '2026-11-19T00:00:00Z' } }));
    const r = archiveTask(db, { taskId: cid, reason: '父任务自行产出，归档子任务' });
    ok(r.changed === true, 'C4 归档成功');
    const line = db.prepare("SELECT content FROM wa_task_conversations WHERE task_id=? ORDER BY rowid DESC LIMIT 1").get(cid) as { content: string } | undefined;
    ok(!!line && line.content.includes('归档待答任务') && line.content.includes('三个口径怎么定'), 'C4 归档留痕带问题原文');
    db.close();
  }

  // C5 源码形状：抬头补「勿代为产出」；早退分支在置 pending 之前
  {
    const src = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/jobs/ai-task.ts'), 'utf-8')).join('\n');
    ok(/勿重复提问、勿代为产出/.test(src), 'C5 混合场景抬头含「勿代为产出」');
    const earlyIdx = src.indexOf('父任务保持暂停');
    const pendingIdx = src.indexOf("UPDATE wa_tasks SET status = 'pending'", earlyIdx);
    ok(earlyIdx > 0 && pendingIdx > earlyIdx, 'C5 早退发生在置 pending 之前');
  }
}

// ── D 组「通」 ───────────────────────────────────────────────────────────────

{
  // D1 /dev/null 放行（只此一个固定 sink）
  ok(validateReadonlyBashCommand('grep -n foo file 2>/dev/null').ok === true, 'D1 `2>/dev/null` 放行');
  ok(validateReadonlyBashCommand('ls -la >/dev/null').ok === true, 'D1 `>/dev/null` 放行');
  ok(validateReadonlyBashCommand('grep -n foo file 2>&1').ok === true, 'D1 `2>&1` 仍放行（既有口径不变）');
  // D2 写文件重定向仍拒（反证，三侧）
  const denied = (cmd: string) => {
    const v = validateReadonlyBashCommand(cmd);
    return v.ok === false && String((v.payload as { error?: string }).error ?? '').includes('重定向被禁止');
  };
  ok(denied('grep -n foo file > out.txt'), 'D2 `> out.txt` 仍拒');
  ok(denied('grep -n foo file 2> err.log'), 'D2 `2> err.log` 仍拒');
  ok(denied('grep -n foo file >> log'), 'D2 `>> log` 仍拒');
  // D3 探索拒绝文案点名免费替代（两处文案同尺）
  const dyn = deriveShellExploreQuota(60, 'code');
  ok(dyn.hardMsg.includes('read_file') && dyn.hardMsg.includes('search_content'), 'D3 派生文案含免费替代工具');
  ok(SHELL_EXPLORE_QUOTA.hardMsg.includes('read_file') && SHELL_EXPLORE_QUOTA.hardMsg.includes('search_content'), 'D3 静态文案含免费替代工具');
  // 数值不抄字面量：派生值必须等于真源
  const real = resolveExplorationQuota(60, 'code');
  ok(dyn.hard === real.hard && dyn.soft === real.soft, 'D3 文案阈值取自真源（未改配额数值）', `${dyn.soft}/${dyn.hard}`);
  // D4 execute_command 描述与校验同口径
  const shellSrc = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/tools/shell.ts'), 'utf-8')).join('\n');
  ok(/2>\/dev\/null/.test(shellSrc), 'D4 工具描述写明 `2>/dev/null` 可用');
}

// ── E 组「名」 ───────────────────────────────────────────────────────────────

{
  // E1 JS 侧探针窄规则（两侧标本 + 边界）
  ok(isProbePath('reports/tools/probe-withdraw-60.py') === true, 'E1 tools/probe- 判探针');
  ok(isProbePath('reports/tools/probe_bankcode.py') === true, 'E1 tools/probe_ 判探针');
  ok(isProbePath('reports/tools/verify-bankcode-chain.py') === false, 'E1 tools/verify- 不误伤');
  ok(isProbePath('reports/probe-abc.md') === false, 'E1 非 tools 目录的 probe- 不判（窄规则边界）');
  ok(isProbePath('scripts/_f20_probe.py') === true, 'E1 既有 `_` 前缀形态仍成立');

  // E2 SQL 侧与 JS 同义（同一批标本真跑 SQL）
  {
    const db = mkdb();
    const rows = [
      ['reports/tools/probe-withdraw-60.py', false],
      ['reports/tools/verify-bankcode-chain.py', true],
      ['reports/probe-abc.md', true],
    ] as const;
    for (const [p] of rows) {
      db.prepare("INSERT INTO wa_deliverables (id, project_id, type, name, file_path, status) VALUES (?, 'p', 'doc', ?, ?, 'completed')")
        .run(crypto.randomUUID(), p.split('/').pop(), p);
    }
    for (const [p, expectNotProbe] of rows) {
      const r = db.prepare(`SELECT (${docNotProbe('')}) AS ok FROM wa_deliverables WHERE file_path = ?`).get(p) as { ok: number };
      eq(!!r.ok, expectNotProbe, `E2 SQL 判据与 JS 同义：${p}`);
    }
    db.close();
  }

  // E3 退休写口（理由必填 / 幂等 / 摘 ★）
  {
    const db = mkdb();
    const did = crypto.randomUUID();
    db.prepare("INSERT INTO wa_deliverables (id, project_id, type, name, status, is_primary) VALUES (?, 'p', 'doc', '探针', 'completed', 1)").run(did);
    const blank = retireDeliverable(db, did, '   ');
    eq(blank, { ok: false, code: 'reason_required' }, 'E3 空理由被拒');
    eq((db.prepare('SELECT status, is_primary FROM wa_deliverables WHERE id=?').get(did) as { status: string; is_primary: number }).status, 'completed', 'E3 被拒时状态不变');
    const first = retireDeliverable(db, did, '一次性探针，不是交付成果');
    eq(first, { ok: true, changed: true }, 'E3 首次退休成功');
    const row = db.prepare('SELECT status, is_primary FROM wa_deliverables WHERE id=?').get(did) as { status: string; is_primary: number };
    eq(row.status, 'retired', 'E3 状态置 retired');
    eq(row.is_primary, 0, 'E3 ★ 被摘掉');
    const again = retireDeliverable(db, did, '重复点击');
    eq(again, { ok: true, changed: false }, 'E3 重复退休幂等');
    eq(retireDeliverable(db, 'nope', '理由'), { ok: false, code: 'not_found' }, 'E3 不存在的成果如实报 not_found');
    db.close();
  }

  // E4 三层接线（main IPC / renderer api / 列表行与抽屉入口）
  {
    const mainCode = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/ipc/project.ipc.ts'), 'utf-8')).join('\n');
    ok(/ipcMain\.handle\('deliverable:retire'/.test(mainCode), 'E4 main 注册 deliverable:retire');
    const api = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/lib/ipc.ts'), 'utf-8')).join('\n');
    ok(/retire:\s*\(id: string, reason: string\)/.test(api) && api.includes("'deliverable:retire'"), 'E4 renderer api 接线');
    const page = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/DeliverablesPage.tsx'), 'utf-8')).join('\n');
    ok(/deliverables\.retire\(/.test(page) && /确认退休/.test(page), 'E4 成果页行操作 + 理由框');
    const drawer = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/components/DeliverableDrawer.tsx'), 'utf-8')).join('\n');
    ok(/deliverables\.retire\(/.test(drawer) && /确认退休/.test(drawer), 'E4 成果抽屉入口');
  }
}

// ── F 组「证」 ───────────────────────────────────────────────────────────────

{
  checkBuildPins(ok);
  const src = fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf-8');
  const m = /build:\s*'(zx_\d{8}(?:_\d+)?)'/.exec(src);
  const tag = m?.[1] ?? '';
  ok(buildNotOlderThan(tag, SELF.replace(/^rr_/, '')), 'F1 build 不早于本套件轮次', `${tag} vs ${SELF}`);
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail === 0 ? 0 : 1);
