/**
 * zx_20260921 M8（重构·只动形不动义）: `executeTask` 的**入口段**——认领与前置校验。
 *
 * 搬迁来源：`core/agent-executor.ts` 的 `executeTask` 原 `:1133`–`:1240`，**逐字搬运**，只加函数包裹层
 * 与返回形态（原来是就地读局部量 + `return`，现在是判别式结果 + `return null`）：
 *   ① `claimTaskForExecution`     — CAS 抢占 + 清陈旧因由 + 状态事件 + 里程碑 doing 流转
 *   ② `preExecutionConfirmGate`   — Phase A 待确认事项门禁（王阳明知行合一 · 知未成不得行）
 *   ③ `captureSnapshotBeforeRun`  — B2 执行前世界快照（执行后审计一致性）
 *
 * **为什么单独成模块**：`executeTask` 单函数 2324 行（占全文件 49%）。入口段是其中**唯一**输入只有
 * `db/taskId/dataDir`、输出只有几个只读值的一段——切成函数不需要任何可变包穿梭，是风险最低的一刀。
 * 行为、返回形状、事件载荷、SQL 与文案**逐字未改**（判据：搬迁前后同段逐行 diff，只允许 import/包裹层差异）。
 *
 * ⚠ 本模块**运行时** `import` 回 `agent-executor.js`（`persistAwaitingInput` / `detectPendingConfirmations`）——
 *   与 `core/jobs/ai-task.ts` ↔ `agent-executor.js` 的既有双向引用**同形**（那个环已长期存在且在跑）。
 *   搬的是**调用点**，不是这两个函数的定义：真源仍留在执行体一处，此处**未复制第二份**。
 *   `AgentContext` 只作类型用（`import type`），不参与运行时环。
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { eventBus } from './event-bus.js';
import {
  resolveTaskMilestoneLink,
  resolveProjectConcurrencyLimit,
  projectSlotGuard,
  resolveMachineConcurrencyLimit,
  machineSlotGuard,
  countMachineRunning,
} from './task-accounting.js';
import { captureWorldSnapshot, persistWorldSnapshot } from './world-snapshot.js';
import { pauseTask } from './pause-task.js';
import { isNoInteraction } from './no-interaction.js';
import { PAUSE_REASON_PENDING_CONFIRMATION } from './pause-reason.js';
import { formatOptions, formatAwaitingInputMessage } from './im/options.js';
import { persistAwaitingInput, detectPendingConfirmations, type AgentContext } from './agent-executor.js';
import {
  isRemoteAssigned,
  isRemoteOffered,
  hasRemoteOfferMark,
  clearRemoteOffered,
  type OrchestrateDb,
} from './node-orchestrate.js';
import crypto from 'node:crypto';

export interface ClaimSuccess {
  claimed: true;
  task: Record<string, unknown>;
  projectId: string;
  project: Record<string, unknown> | undefined;
  workingDir: string;
  title: string;
  description: string;
}

/**
 * 认领被拒 ⇒ 调用方立刻以该 content 收尾（`steps: 0`），与搬迁前的 `return` 同形。
 *
 * zx_20260930 M11-1：`reason` 区分**两种截然不同的拒因**——它们此前的处置是一样的（都只回一句 content
 * 就收尾），但正确处置相反：
 *   · `cas_conflict`     —— 任务已被别的执行体抢走。**认账收尾**（这一步本就不该由我做），不重试。
 *   · `concurrency_full` —— 项目并发已满。任务**本身仍然有效**，须退避重排队，不得当失败收掉。
 * 二者在 SQL 层是同一条 `changes === 0`（UPDATE 的 WHERE 是三合一），故必须回读状态来分辨。
 */
export interface ClaimRejected {
  claimed: false;
  content: string;
  /**
   * zx_20261018_3 批三补两态（**本机不抢**，与上面两种"本该我做却没做成"不同）：
   *   · `remote_assigned` —— 三键齐备：这件活已经交给对端，本机认领只会重复执行。
   *   · `remote_offered`  —— 派单在途（占位未过期）：ANS 还没回包，此刻本机抢就等于和即将派出的那单双跑。
   *
   * zx_20261018_3 批四「度」补 `machine_concurrency_full`：整机占位已满（与"本项目满"是两把尺）。
   *   处置同 `concurrency_full`——任务本身仍有效，须退避重排队，不得当失败收掉。
   */
  reason: 'cas_conflict' | 'concurrency_full' | 'machine_concurrency_full' | 'remote_assigned' | 'remote_offered';
}

export type ClaimResult = ClaimSuccess | ClaimRejected;

/** 认领可注入的时钟与核数（判据不依赖真实墙钟/真机；生产不传）。 */
export interface ClaimOpts {
  nowMs?: number;
  /** zx_20261018_3 批四：机器并发缺省值的派生核数（rr 注入，生产读真机）。 */
  cpus?: number;
}

/**
 * 认领：读任务/项目 → **外派让位判据** → 建工作目录 → CAS 抢占 → 清陈旧暂停因由 → 发状态事件 → 里程碑 doing 流转。
 */
export function claimTaskForExecution(
  db: Database.Database,
  taskId: string,
  dataDir: string,
  opts: ClaimOpts = {},
): ClaimResult {
  const task = db.prepare('SELECT * FROM wa_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) throw new Error(`Task ${taskId} not found`);

  // zx_20261018_3 批三（老子·知止）：**本机不抢**已交给对端（或正派往对端）的活——判据一处真源 `node-orchestrate`。
  //   过期占位不是拦，是**顺手清掉**：写占位的进程可能在回包前崩掉，没有人来清 ⇒ 这一清保证任务不会
  //   被一记死占位永久钉住（清完照常走下面的 CAS）。
  const taskCtx = task.context_json as string | Buffer | null | undefined;
  const nowMs = opts.nowMs ?? Date.now();
  if (isRemoteAssigned(taskCtx)) {
    return { claimed: false, content: '任务已外派他机执行（本机不抢）', reason: 'remote_assigned' };
  }
  if (isRemoteOffered(taskCtx, nowMs)) {
    return { claimed: false, content: '任务正在派往他机（派单在途），本机不抢', reason: 'remote_offered' };
  }
  if (hasRemoteOfferMark(taskCtx)) clearRemoteOffered(db as unknown as OrchestrateDb, taskId);

  const projectId = task.project_id as string;
  const project = db.prepare('SELECT * FROM wa_projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined;
  const workingDir = (project?.working_dir as string) || path.join(dataDir, 'projects', projectId);

  // 确保工作目录存在
  if (!fs.existsSync(workingDir)) fs.mkdirSync(workingDir, { recursive: true });

  // CAS 抢占
  // zx_20260907 M5 修(2026-09-08): 'running' 纳入可抢占集合——GUI「执行」把任务置 running 后
  // ai-task 作业恢复/入队时才能被真正认领(否则 CAS 0 行 → <1s 空转 done,任务永久僵尸"运行中")
  //
  // zx_20260930 M11-1（管子·度量衡）: **项目并发闸并入同一条语句**。
  //   原先"并发满没满"在 `jobs/ai-task.ts` 另读一次 `resolveProjectConcurrency` 判断，与这条 UPDATE
  //   之间隔着一次 JS 往返——两个并发的执行体（调度回合 / 退避重试 / GUI 执行）都能看见同一个余量，
  //   双双通过检查、双双占位 ⇒ 实跑超上限（方案 §1.6 行1）。判据内联进 WHERE 后由 SQLite 单语句
  //   原子性兜住。`excludeTaskId: taskId` 因为 `preparing` 既在可抢占集又在占位集——不排除自己
  //   会把自身那一票也数进去，合法输入被判"满员"。
  const limit = resolveProjectConcurrencyLimit(db, projectId);
  const guard = projectSlotGuard(projectId, limit, { excludeTaskId: taskId });
  // zx_20261018_3 批四「度」: **机器级**上限并入同一条 UPDATE。
  //   项目闸只管"一个项目几个"——三个项目各跑 3 个，同一台机器照样压 9 个 Agent 循环。
  //   与项目闸同理内联进 WHERE，由 SQLite 单语句原子性兜住（不另做 check-then-act）。
  const machineLimit = resolveMachineConcurrencyLimit(db, { cpus: opts.cpus }).limit;
  const machineGuard = machineSlotGuard(machineLimit, { excludeTaskId: taskId });
  const casResult = db.prepare(
    `UPDATE wa_tasks SET status = 'executing', updated_at = datetime('now')
      WHERE id = ? AND status IN ('pending','paused','preparing','running') AND ${guard.sql} AND ${machineGuard.sql}`
  ).run(taskId, ...guard.params, ...machineGuard.params);
  if (casResult.changes === 0) {
    // WHERE 是四合一，0 行时须回读状态分辨"被人抢了"还是"哪把并发尺满了"（见 ClaimRejected.reason）。
    const now = db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status?: string } | undefined;
    const stillClaimable = !!now && ['pending', 'paused', 'preparing', 'running'].includes(String(now.status));
    if (!stillClaimable) return { claimed: false, content: '任务已被抢占(CAS冲突)', reason: 'cas_conflict' };
    // **机器先归因**：社区档项目上限 3 > 机器测试上限 2，先判项目会把"整机满"说成"本项目满"。
    if (countMachineRunning(db, { excludeTaskId: taskId }) >= machineLimit) {
      return { claimed: false, content: `机器并发已满(${machineLimit})，任务退回队列`, reason: 'machine_concurrency_full' };
    }
    return { claimed: false, content: `项目并发已满(${limit})，任务退回队列`, reason: 'concurrency_full' };
  }

  // zx_20260914: 「因等子任务而暂停」的因随认领一并清掉——任务已在跑，该暂停即成过去。
  // 残留不清会让人事后手动暂停的父任务也被当成"等子"，后继被误拉起（A2 的守则随之失效）。
  // 认领是所有恢复路径（D1 自动恢复 / GUI 执行 / IM 恢复 / 手动执行）的共同收口，清点只此一处。
  db.prepare(
    "UPDATE wa_tasks SET context_json = json_remove(COALESCE(context_json, '{}'), '$.pause_reason') WHERE id = ? AND json_extract(COALESCE(context_json, '{}'), '$.pause_reason') IS NOT NULL"
  ).run(taskId);

  eventBus.emit('task.status_changed', { taskId, task_id: taskId, newStatus: 'executing', new_status: 'executing', projectId }).catch(() => {});

  // zx_20260905 批4 (2026-09-05): 里程碑 doing 流转——实施任务动工(pending→executing)即把其对应方案里程碑置 doing（幂等：仅 pending→doing，不覆盖已 doing/done）
  // zx_20260910_3 M2a: 判据收敛——内联的 scheme_ref + 标题 M{n} 派生整段移除，改走 task-accounting.resolveTaskMilestoneLink
  //   （与 writeMilestoneDone / update_task_status / GUI 读路径**同一份**真实现；此前四处各写各的，名同法异）
  try {
    const tctx = JSON.parse((task.context_json as string) || '{}') as Record<string, unknown>;
    const link = resolveTaskMilestoneLink(db, taskId, tctx);
    if (link) {
      db.prepare("UPDATE wa_plan_milestones SET status = 'doing', updated_at = datetime('now') WHERE plan_task_id = ? AND milestone = ? AND status = 'pending'").run(link.plan_task_id, link.milestone);
    }
  } catch { /* doing 流转 best-effort */ }

  const title = (task.title as string) || 'untitled';
  const description = (task.description as string) || '';

  return { claimed: true, task, projectId, project, workingDir, title, description };
}

/**
 * Phase A (2026-08-27 zx_3): 待确认事项门禁（王阳明知行合一 + 老子知止——知未成不得行，不确定则知止暂停）。
 * 命中 ⇒ 返回该 content（调用方 `return { content, steps: 0 }`）；未命中或门禁异常 ⇒ `null`（放行）。
 */
export async function preExecutionConfirmGate(o: {
  db: Database.Database;
  taskId: string;
  projectId: string;
  title: string;
  description: string;
  workingDir: string;
  sendImAskUser?: AgentContext['sendImAskUser'];
}): Promise<{ content: string } | null> {
  const { db, taskId, projectId, title, description, workingDir, sendImAskUser } = o;
  // Phase A (2026-08-27 zx_3): 待确认事项门禁（王阳明知行合一 + 老子知止——知未成不得行，不确定则知止暂停）
  try {
    // 幂等：门禁已触发过（context_json.gate_triggered）则跳过，避免用户确认后 resume 再次阻断（死循环）
    const gateJson = (db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json;
    const gateCtx = JSON.parse(gateJson || '{}');
    // zx_20261011 M11: 不可交互任务（请求方无从应答）——门禁亦不得暂停，直接放行。
    //   判法与 `tools/control.ts` 的 `ask_user` 同源（`core/no-interaction.ts`），键名不在此手抄。
    if (isNoInteraction(gateJson)) return null;
    if (gateCtx.gate_triggered) {
      // C1 回填：用户已确认（resume），把门禁的待确认事项写回 confirmations（避免跨任务重复询问）
      try {
        // 用「任务执行前需确认」过滤，只读门禁的待确认消息（避免误读 ask_user 的 [等待用户输入]，两者前缀相同但选项分隔符不同）
        const gatedMsg = db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'system' AND content LIKE '[等待用户输入]%' AND content LIKE '%任务执行前需确认%' ORDER BY created_at DESC LIMIT 1").get(taskId) as { content: string } | undefined;
        if (gatedMsg) {
          const optMatch = gatedMsg.content.match(/\[选项: (.+?)\]/);
          if (optMatch) {
            const items = optMatch[1]!.split(' | ').map(s => s.trim()).filter(Boolean);
            const existing = Array.isArray(gateCtx.confirmations) ? (gateCtx.confirmations as Array<string | { item: string }>) : [];
            const existingItems = existing.map((c) => (typeof c === 'string' ? c : c.item)).filter(Boolean);
            // C3 追溯：记录「事项 + 确认时间 + 渠道」，供审计（谁在何时通过何渠道确认）
            const channel = (typeof gateCtx.channel === 'string' ? gateCtx.channel : '') || 'desktop';
            const newEntries = items.filter((i) => !existingItems.includes(i)).map((i) => ({ item: i, confirmed_at: new Date().toISOString(), channel }));
            if (newEntries.length > 0) {
              gateCtx.confirmations = [...existing, ...newEntries];
              db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(gateCtx), taskId);
            }
          }
        }
      } catch { /* 回填失败不阻断 */ }
    } else {
      const pending = detectPendingConfirmations(db, projectId, `${title} ${description}`, taskId, workingDir);
      if (pending.length > 0) {
        // 标记门禁已触发（幂等）
        gateCtx.gate_triggered = true;
        db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(gateCtx), taskId);
        const question = `任务执行前需确认以下事项（未确认则暂停实施）：\n${pending.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
        // 复用 ask_user 的「[等待用户输入] ... [选项: A | B]」格式，使 IM 回复唤醒（checkDbApprovalFallback/rebuildPendingApprovalsOnStartup 匹配此前缀）能识别门禁暂停的任务
        const sysMsg = formatAwaitingInputMessage(question, pending);
        db.prepare(
          "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
        ).run(crypto.randomUUID(), taskId, sysMsg);
        // zx_20260910_1 M2: 门禁与 ask_user 同形持久化——此前只写会话标记，刷新/重进详情页即丢（横幅无真源可读）
        // zx_20260915 P0-5(d): 先落库后发事件（同上：asked_at 取返回值，四点同形，不自造）
        const gateAskedAt = persistAwaitingInput(db, taskId, { question, options: pending, decision_type: 'pending_confirmation' });
        // zx_20260917 M1（与 `pauseForDecision` 同一步序）: 先落账 → 再置停（`pauseTask` 一并发 status_changed）→ 后发 awaiting_input
        pauseTask(db, { taskId, reason: PAUSE_REASON_PENDING_CONFIRMATION });
        eventBus.emit('task.awaiting_input', { taskId, task_id: taskId, projectId, question, decision_type: 'pending_confirmation', options: pending, context: {}, asked_at: gateAskedAt }).catch(() => {});
        if (sendImAskUser) {
          try {
            const ctxJson = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}');
            if (ctxJson.channel && ctxJson.externalUser) {
              const msg = `[待回复] ${question}\n选项: ${formatOptions(pending)}`;
              sendImAskUser({ channel: ctxJson.channel, toUser: ctxJson.externalUser, question: msg, taskId, options: pending }).catch(() => {});
            }
          } catch { /* IM 通知失败不阻断门禁 */ }
        }
        return { content: '任务已暂停，等待用户确认待确认事项后恢复' };
      }
    }
  } catch { /* 门禁异常不阻断任务执行 */ }
  return null;
}

/**
 * B2: 捕获执行前世界快照（执行后审计一致性）。best-effort——快照取不到/写不进都不阻断执行。
 *
 * zx_20261015_2 D4: 写新 `before` 时**同时清掉陈旧的 `after`**（成对才留，不成对即止，见函数体内注释）。
 */
export async function captureSnapshotBeforeRun(db: Database.Database, projectId: string, taskId: string): Promise<void> {
  // B2: 捕获执行前世界快照（执行后审计一致性）
  try {
    const snapshotBefore = await captureWorldSnapshot(db, projectId);
    if (snapshotBefore) {
      const snapCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
      // zx_20261028_2 M1: 原文进侧表，ctx 只留 ref（侧表不可用 ⇒ 退回内联，行为同改造前）。
      snapCtx.world_snapshot_before = persistWorldSnapshot(db, taskId, 'before', snapshotBefore) ?? snapshotBefore;
      // zx_20261015_2 D4（道德经·知止「知止不殆」／罗尔斯·同一把尺）：写新一轮的 before 时**一并清掉**
      //   上一轮的 after。after 只在 `auditWorldConsistency`（循环之后）里重写，早退路（`finalize_paused`/
      //   中断/硬暂停/偏离重启）跳过它 ⇒ 留下的永远是**上一个 run** 的 after，与新的 before **不成对**，
      //   却被当成"本轮执行前后"对照（真库标本 `7c39678e`：before 04:54:35 晚于 after 04:45:40，倒挂、`resume_count=4`）。
      //   成对才留，不成对即止——清掉后：完整的一轮 = 一新 before + 一新 after；早退的一轮 = 只有新 before（不谎报成对）。
      //   ⚠ 只在**真取到新 before** 时清：取不到就没开新一轮，不动既有账（best-effort，不误伤上一对）。
      // zx_20261028_2 M1: 清的是引用时，侧表里那一行也一并删（否则成对作废的行永远留在库里）。
      const staleAfter = snapCtx.world_snapshot_after as { ref?: string } | undefined;
      if (staleAfter?.ref) { try { db.prepare('DELETE FROM wa_world_snapshots WHERE id = ?').run(staleAfter.ref); } catch { /* 表缺失/已删：忽略 */ } }
      delete snapCtx.world_snapshot_after;
      db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(snapCtx), taskId);
    }
  } catch {}
}
