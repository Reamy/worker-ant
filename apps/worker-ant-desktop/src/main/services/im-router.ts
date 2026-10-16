/**
 * IM 消息路由器 — 从原工蚁服务端 index.ts 移植。
 * 包含：IM命令分发(通道A) + F3通知推送(通道B) + 意图分类/任务创建/启动/查询。
 *
 * ⚠ **时刻列纪律（zx_20260920_1 M6-b，本文件 9 处读点）**：`wa_tasks.updated_at`
 *   **两种格式混存**（真库实测 ISO **101** / SQL **91**），来源有两条写入路径——
 *   事件溯源侧 `event-store.ts` 用 `new Date().toISOString()`、经 `event-projectors.ts`
 *   落进该列；直改侧（40+ 处 `UPDATE … updated_at = datetime('now')`）落 SQL 格式。
 *   **两条路都还在跑，故混存不是旧数据残留**（`wa_memories.updated_at` / `wa_task_conversations.created_at`
 *   实测各自 **774** / **24220** 行全 SQL——混的只有这一列）。
 *
 *   裸比较的坏法（SQL 字符串比较，实测）：`'2026-09-20T02:00:00.000Z' > '2026-09-20 03:00:00'` ⇒ **1**
 *   ——**同一 UTC 日内，ISO 串恒大于任何 SQL 串**，与真实先后无关（跨日方向正确）。
 *   于是：**排序**在"同一 UTC 日内"失真；**窗口比较**（`-30 seconds` / `-1 hour`）对该日内所有 ISO 行**恒成立**。
 *   本文件一律写 `datetime(updated_at)`（已实测能把两种都归一成 `YYYY-MM-DD HH:MM:SS`）。
 *
 *   ⚠ 窗口比较里 `-30 seconds` 那两处是**防微信重投闸**，窗口须归一，不许回退成裸比较
 *   （判假 ⇒ 吞掉用户的启动指令）。
 *
 *   zx_20260929 M8-d（维特根斯坦·意义即使用）：命中该闸时**不再静默 `return`**——
 *   原来一行 `console.log` 就完事，用户侧看到的是"发了没反应"（与它要防的重投一样不可辨）。
 *   现改：`imLogger.info` 留痕 + 回一句「30 秒内已受理」。重投是**平台的**行为，不该由用户承担沉默。
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
// zx_20260921 M6: 拆解器从 `task-archetype.ts` 抽到 `task-decompose.ts`（依赖可注入）。本处**只换调用形状**：
//   仍用同一条"直连 ANS"的取模型路（`makeEnvDecomposeDeps`），超时/请求体/默认模型一字未改。
import { resolveChatCompletionsUrl } from '@worker-ant/ans-client';
import { decomposeTask, makeEnvDecomposeDeps, planSubtasksFromTemplate, loadDecompositionPatterns, shortfallNotice } from '../core/task-decompose.js';
// zx_20260930 M9: 到 ANS 的请求收成一条出路（`ans-signed-request`）——本文件此前有两处裸 `fetch`：
//   意图分类那处**零认证头**、拆解取模型那处只发 `x-api-key`，两条都恒 401 且静默。
import { ansSignedRequest, ansFailureNote, resolveAnsCreds } from '../core/ans-signed-request.js';
import { alreadyDecomposed } from '../core/task-accounting.js';
// zx_20261005 M7（管子·度量衡）: IM 侧两条建项目路（`@不存在项目名` / 无归属「IM对话项目」）与 GUI 两条
//   共用**同一把尺**——达档位上限则不再新建，改落到最近的项目并如实回话（软闸：任务不丢、IM 不断）。
import { projectQuotaRefusal } from '../core/project-quota.js';
// zx_20261012_1 缺陷修: IM 两条「自动建项目」原写死 `owner_id='default'` ⇒ `wa_projects.owner_id`
//   外键（`database.ts` `foreign_keys = ON`）当场报错；改取一处真源（与 `project:create`/示例项目同尺）。
import { resolveProjectOwnerId } from '../core/project-engine.js';
import { resumeWithQuota } from '../core/pause-settlement.js';
import { createLogger } from '../core/logger.js';
import { boolSetting } from '../core/settings-bool.js';
// 状态词的**唯一一份**在 `task-notice.ts`（M6 起 IM 的「查看系统状态」也从它取）——
//   不在此另抄一份 `{ pending: '待执行', … }`：同一件事两处各写一遍正是本轮在治的形状。
import { taskStatusWord } from '../core/task-notice.js';
import { eventBus } from '../core/event-bus.js';
import { formatOptions, matchApprovalReply, parseOptions } from '../core/im/options.js';
import type { ApprovalReply } from '../core/im/options.js';
// zx_20260924_1 M1: 内置指令的**唯一真源**——四条路由谓词 + 偏好谓词 + 帮助文案，都从这一处来。
import { BUILTIN_IM_COMMANDS, CREATE_REGEX, HELP_REGEX, QUERY_REGEX, START_REGEX, matchRememberPreference } from './im-commands.js';
import { parsePairReply, resolvePairTarget, approveTerminal, rejectTerminal } from '../core/external-terminals.js';
import { refreshImUnread } from '../core/im/im-unread.js';
import { enqueueJob } from '../core/job-enqueuer.js';
import type { ImMessageMeta } from './im-adapter.js';
import { mediaReceiptText } from './im-media.js';
// zx_20260921 M1: 「最近一件」暂存 + 一次性消费（"先发图、再说话"那截线）。
import { attachPendingMediaToTask } from './pending-media.js';
// zx_20260929 M8-a: 出站文本的**长度尺**（上限 + 「超了怎么截」）**只这一处**——
//   本文件两处 `slice(0, 4000)` 静默截断（命令输出 / F3 通知正文）改走 `clipWithNotice`：
//   截断不是错，**不说**才是错（用户拿到的是一份"看起来完整"的内容，末尾少了多少全无线索）。
import { clipWithNotice, IM_ROUTER_OUTPUT_LIMIT } from '../core/im/im-text.js';
// zx_20260930 M5: 用户答复＝对 agent 正在做的事的**纠正**——内容装配在 `memory-write.ts` 一处，
//   名字（`user_correction`）在 `memory-constants.ts` 一处。本文件不另拼一份、也不写字符串字面量。
import { buildImUserCorrection } from '../core/memory-write.js';
import { MEM_SOURCE_USER_CORRECTION } from '../core/memory-constants.js';
import type { MemoryManager } from '../core/memory-manager.js';
// zx_20261003 M9（纯搬移·零语义变更）: 通知目录、风暴判定、F3 通知推送各自搬入新模块
//   （`core/notify-dir.ts` / `core/im-storm-guard.ts` / `services/f3-notification-push.ts`），
//   本文件**保留同名再导出**——既有 import（`ipc/im.ipc.ts`、`core/jobs/ai-task.ts`、rr）一字不改仍解析到同一符号。
import { resolveNotificationDir, setNotificationDir } from '../core/notify-dir.js';
import { stormVerdict, STORM_NOTICE, STORM_COOLDOWN_MS, STORM_WINDOW_MS, STORM_THRESHOLD } from '../core/im-storm-guard.js';
import type { StormState } from '../core/im-storm-guard.js';
import { isProbeNotifyFile, triggerF3Notification, startF3NotificationPush, stopF3NotificationPush, PROBE_NOTIFY_PREFIXES } from './f3-notification-push.js';
export { resolveNotificationDir, setNotificationDir, stormVerdict, STORM_NOTICE, STORM_COOLDOWN_MS, STORM_WINDOW_MS, STORM_THRESHOLD, isProbeNotifyFile, triggerF3Notification, startF3NotificationPush, stopF3NotificationPush, PROBE_NOTIFY_PREFIXES };
export type { StormState };

const imLogger = createLogger('im-router');

interface ImContext {
  db: Database.Database;
  channelId: string;
  channelType: string;
  /**
   * **契约：永不 reject**（zx_20260920 M2 明确）。
   *
   * 实现处（`ipc/im.ipc.ts` 的两处 `ImContext` 构造）内部 catch 住一切，落账
   * （`accountOutboundFailure`：一行 failed + 真因，不入 outbox —— D4 人机回话不自动补发）
   * 后正常返回。**这就是下面各调用点不需要各自 `.catch(() => {})` 的依据**：
   * 失败有唯一归属（构造处），调用点只负责"说了什么"。
   * 若哪天把构造处改成会抛，那 32 个裸调用点会集体变成未处理 rejection —— 改之前先看这条注释。
   */
  sendReply: (toUser: string, text: string) => Promise<void>;
  /**
   * zx_20260930 M5: 记忆管理器的**惰性取用**（可缺）。取惰性而非直接持有，是照 `initProjectIpc` 的既有形——
   *   `initImIpc` 在 `MemoryManager` 构造**之前**被调用（见 `main/index.ts`），构造期无从传入实例。
   *   取不到（旧调用/夹具）⇒ 只是少记一条纠正，**绝不影响**这句话被投给哪个 run。
   */
  getMemory?: () => MemoryManager | undefined;
}

// ====== 去重 / 风暴检测 ======

const dedupCache = new Map<string, number>();
function isDuplicate(key: string): boolean {
  const now = Date.now();
  const last = dedupCache.get(key);
  if (last && now - last < 30_000) return true;
  dedupCache.set(key, now);
  if (dedupCache.size > 500) {
    for (const [k, v] of dedupCache) { if (now - v > 60_000) dedupCache.delete(k); }
  }
  return false;
}

// 风暴判定（阈值/`StormState`/`stormVerdict`/`STORM_NOTICE`）已搬入 `core/im-storm-guard.ts`（zx_20261003 M9）。
// 本文件只留**按用户记状态**的 `stormTracker`——那是调用方职责，不是纯判定的一部分。

const stormTracker = new Map<string, StormState>();

// ====== 审批队列（ask_user） ======

interface PendingApproval {
  taskId: string;
  projectId: string;
  question: string;
  options?: string;
  createdAt: number;
}

// key = "channelType:fromUser"
const pendingApprovals = new Map<string, PendingApproval[]>();

// A4: 已消费审批缓存（防微信重投重复恢复任务），key = "consumed:channel:from:taskId" → timestamp
const consumedApprovalCache = new Map<string, number>();
const MAX_CONSUMED_CACHE_SIZE = 200;
function addConsumedApproval(key: string): void {
  if (consumedApprovalCache.size >= MAX_CONSUMED_CACHE_SIZE) {
    const entries = [...consumedApprovalCache.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < 50 && i < entries.length; i++) consumedApprovalCache.delete(entries[i]![0]);
  }
  consumedApprovalCache.set(key, Date.now());
}
function isConsumedApproval(key: string): boolean {
  const ts = consumedApprovalCache.get(key);
  if (!ts) return false;
  if (Date.now() - ts > 120_000) { consumedApprovalCache.delete(key); return false; }
  return true;
}
// 定期清理过期缓存
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [k, ts] of consumedApprovalCache) { if (ts < cutoff) consumedApprovalCache.delete(k); }
  // A7: 清理过期的项目选择候选
  const now = Date.now();
  for (const [k, sel] of pendingProjectSelections) { if (sel.expiresAt < now) pendingProjectSelections.delete(k); }
}, 60_000).unref?.();

// A7: 待选项目列表（@项目名歧义后暂存，供编号回复选择），key = "channelType:fromUser"
interface PendingProjectSelection {
  projects: Array<{ id: string; name: string }>;
  taskText: string;
  expiresAt: number;
}
const pendingProjectSelections = new Map<string, PendingProjectSelection>();

export function registerPendingApproval(channel: string, fromUser: string, approval: PendingApproval): void {
  const key = `${channel}:${fromUser}`;
  const list = pendingApprovals.get(key) || [];
  // 同任务去重
  if (!list.some(a => a.taskId === approval.taskId)) {
    list.push(approval);
  }
  pendingApprovals.set(key, list);
  // 5 分钟超时自动清理
  setTimeout(() => {
    const current = pendingApprovals.get(key);
    if (current) {
      const filtered = current.filter(a => a.taskId !== approval.taskId);
      if (filtered.length === 0) pendingApprovals.delete(key);
      else pendingApprovals.set(key, filtered);
    }
  }, 5 * 60 * 1000);
}

/** 启动恢复：重建 pendingImApprovals（扫描 paused/failed + [等待用户输入]，1h内） */
export function rebuildPendingApprovalsOnStartup(db: Database.Database): void {
  try {
    const tasks = db.prepare(
      "SELECT DISTINCT t.id, t.project_id, t.context_json FROM wa_tasks t JOIN wa_task_conversations c ON c.task_id = t.id WHERE t.status IN ('paused','failed') AND c.content LIKE '%等待用户输入%' AND datetime(t.updated_at) > datetime('now', '-1 hour')"
    ).all() as Array<{ id: string; project_id: string; context_json: string }>;
    for (const t of tasks) {
      try {
        const ctxJson = JSON.parse(t.context_json || '{}');
        const channel = (ctxJson.channel as string) || '';
        const externalUser = (ctxJson.externalUser as string) || '';
        if (!channel || !externalUser) continue;
        const lastAsk = db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = ? AND content LIKE '%等待用户输入%' ORDER BY created_at DESC LIMIT 1").get(t.id) as { content: string } | undefined;
        if (!lastAsk) continue;
        const question = lastAsk.content.replace('[等待用户输入] ', '').split(' [选项:')[0] || '请回复确认';
        const opts = parseOptions(lastAsk.content);
        registerPendingApproval(channel, externalUser, { taskId: t.id, projectId: t.project_id, question, options: opts.length ? formatOptions(opts) : undefined, createdAt: Date.now() });
        console.log(`[IMRouter] 启动恢复审批: task=${t.id.slice(0, 8)} channel=${channel}`);
      } catch {}
    }
    console.log(`[IMRouter] 启动恢复审批队列完成 (恢复 ${tasks.length} 个待审批任务)`);
  } catch {}
}

// ====== 审批回退：DB 扫描（内存队列失效/丢失时）======

/**
 * 审批回退时间窗。内存队列无 TTL，启动恢复的视界是 1h；取 2h 覆盖之并留余量。
 * 此前回退无维度亦无时间下界 ⇒ 数周前的暂停任务仍会被一句裸「是」复活。
 */
const APPROVAL_FALLBACK_WINDOW = '-2 hours';

/**
 * 本渠道+本用户、时间窗内的待审批候选（确有 `[等待用户输入]` 者）。
 * 候选集是「这条回复指向谁」的唯一范围——范围外一律不认。
 */
function listApprovalCandidates(db: Database.Database, channelType: string, fromUser: string): Array<{ id: string; project_id: string }> {
  return db.prepare(
    `SELECT DISTINCT t.id, t.project_id FROM wa_tasks t
       JOIN wa_task_conversations c ON c.task_id = t.id
      WHERE t.status IN ('paused','failed')
        AND c.content LIKE '%等待用户输入%'
        AND json_extract(t.context_json,'$.channel') = ?
        AND json_extract(t.context_json,'$.externalUser') = ?
        AND datetime(t.updated_at) > datetime('now', ?)
      ORDER BY datetime(t.updated_at) DESC LIMIT 10`
  ).all(channelType, fromUser, APPROVAL_FALLBACK_WINDOW) as Array<{ id: string; project_id: string }>;
}

/** 该任务最近一条「等待用户输入」所带的选项（无则空数组） */
function optionsOfLastAsk(db: Database.Database, taskId: string): string[] {
  const lastAsk = db.prepare(
    "SELECT content FROM wa_task_conversations WHERE task_id = ? AND content LIKE '%等待用户输入%' ORDER BY created_at DESC LIMIT 1"
  ).get(taskId) as { content: string } | undefined;
  return lastAsk ? parseOptions(lastAsk.content) : [];
}

type DbApprovalResolution =
  | { kind: 'hit'; taskId: string; projectId: string; reply: ApprovalReply }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'none' };

/**
 * 把一条回复解析到候选集内的某个待审批任务。队列路径与回退路径同用 matchApprovalReply：
 * 选项文本/编号能唯一定位则用之；否则「是/否」须候选唯一才生效。歧义不猜。
 */
function resolveDbApproval(db: Database.Database, msgText: string, channelType: string, fromUser: string): DbApprovalResolution {
  try {
    const cands = listApprovalCandidates(db, channelType, fromUser);
    if (cands.length === 0) return { kind: 'none' };

    const hits: Array<{ id: string; project_id: string; reply: ApprovalReply }> = [];
    for (const t of cands) {
      const reply = matchApprovalReply(optionsOfLastAsk(db, t.id), msgText);
      if (reply && reply.kind === 'option') hits.push({ id: t.id, project_id: t.project_id, reply });
    }
    if (hits.length === 1) { const h = hits[0]!; return { kind: 'hit', taskId: h.id, projectId: h.project_id, reply: h.reply }; }
    if (hits.length > 1) return { kind: 'ambiguous', count: hits.length };

    const reply = matchApprovalReply([], msgText);
    if (!reply) return { kind: 'none' };              // 自由回复，不属审批，交给下游
    if (cands.length !== 1) return { kind: 'ambiguous', count: cands.length };
    const t = cands[0]!;
    return { kind: 'hit', taskId: t.id, projectId: t.project_id, reply };
  } catch { return { kind: 'none' }; }
}

function checkPendingApproval(ctx: ImContext, fromUser: string, msgText: string): boolean {
  const key = `${ctx.channelType}:${fromUser}`;
  const list = pendingApprovals.get(key);
  if (!list || list.length === 0) return false;

  // LIFO: 取最后一个
  const approval = list[list.length - 1]!;
  const reply = matchApprovalReply(approval.options ? parseOptions(approval.options) : [], msgText);
  if (!reply) return false;
  const isConfirm = reply.kind === 'confirm';
  const isReject = reply.kind === 'reject';
  const isOptionMatch = reply.kind === 'option';

  // A4: 已消费缓存检查（防微信重投"是"重复恢复）
  const consumedKey = `consumed:${key}:${approval.taskId}`;
  if (isConfirm && isConsumedApproval(consumedKey)) { console.log('[IMRouter] 审批已消费，跳过重投'); return true; }

  // A3: isTaskApprovable 校验——最新审批不可用则弹出失效项并尝试下一项
  // 编号/选项匹配同样要校验：失效项若照吃不误，用户对「真正还在暂停的那个任务」的回复
  // 会被静默吞掉，回退路径（M1-1/M1-2 的全部意义）再无机会认领它。
  if (isConfirm || isOptionMatch) {
    const s = (ctx.db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(approval.taskId) as { status: string } | undefined)?.status;
    if (s !== 'paused' && s !== 'failed') {
      list.splice(list.length - 1, 1);
      if (list.length === 0) pendingApprovals.delete(key);
      if (list.length > 0) {
        void ctx.sendReply(fromUser, '该审批已失效，还有待审批项，请重新确认。');
        return checkPendingApproval(ctx, fromUser, msgText);
      }
      // 队列已空 ⇒ 本条回复不属于内存队列（它指向别处的任务）：交回退路径按真库裁定，
      // 不当「已消费」吞下，也不虚报「审批已失效」——谁认领得起、由真库说了算。
      return false;
    }
  }

  // 清理
  const idx = list.indexOf(approval);
  if (idx >= 0) list.splice(idx, 1);
  if (list.length === 0) pendingApprovals.delete(key);

  if (isConfirm || isOptionMatch) {
    // A4: 记录已消费缓存
    if (isConfirm) addConsumedApproval(consumedKey);
    // 用户确认 → 恢复任务
    const { db } = ctx;
    const task = db.prepare('SELECT id, title, status FROM wa_tasks WHERE id = ?').get(approval.taskId) as { id: string; title: string; status: string } | undefined;
    if (task && (task.status === 'paused' || task.status === 'failed')) {
      // 记录用户确认消息
      const confirmMsg = isOptionMatch ? `[用户选择: ${msgText}]` : '[用户确认执行]';
      db.prepare(
        "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'user', ?, 0, datetime('now'))"
      ).run(crypto.randomUUID(), task.id, confirmMsg);
      // zx_20260910_3 M2d-a: IM 确认＝人工介入 → 恢复并返还目标偏离额度（此前只置 pending，额度不返还）
      // zx_20260915 P0-5(b): 审批确认＝对「待审批提问」的**答复** → 落 answer 账（source='im'）。
      //   IM 通路刻意不调 settlePause（其判重/waiting 标记语义是为 GUI 定的，见 pause-settlement.ts:113），
      //   故答复账在此另挂一次——这是"两条用户提交真源各挂一次"的第二个落点，不是把 7 个调用点各抄一遍。
      resumeWithQuota(db, task.id, { answer: { source: 'im', decision: 'confirm' } });
      // 入队恢复执行（P0-5(c): 人发起 ⇒ 显式 'user'，否则会被缺省 'system' 当成系统自恢复）
      enqueueJob(db, 'resume-ai-task', { taskId: task.id, projectId: approval.projectId, message: confirmMsg, initiator: 'user' });
      void ctx.sendReply(fromUser, `✅ 已确认，任务「${task.title}」继续执行。`);
    } else {
      void ctx.sendReply(fromUser, `任务状态已变更，无需确认。`);
    }
    return true;
  }

  if (isReject) {
    void ctx.sendReply(fromUser, '已取消，任务将继续等待。');
    return true;
  }

  return false;
}

/**
 * A5: 审批回退（内存队列失效/丢失时）。判定与队列路径同源（matchApprovalReply），
 * 标记亦同形（`[用户确认执行]` / `[用户选择: …]`），使事件流不因「走了哪条路」而分歧。
 * 歧义（多个候选）时如实询问编号，不再静默穿到自由回复去猜。
 */
function checkDbApprovalFallback(ctx: ImContext, fromUser: string, msgText: string): boolean {
  const r = resolveDbApproval(ctx.db, msgText, ctx.channelType, fromUser);
  if (r.kind === 'none') return false;
  if (r.kind === 'ambiguous') {
    void ctx.sendReply(fromUser, `有 ${r.count} 个待审批任务，请回复选项文字或编号，指定要处理的那一个。`);
    return true;
  }
  const s = (ctx.db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(r.taskId) as { status: string } | undefined)?.status;
  if (s !== 'paused' && s !== 'failed') return false;

  if (r.reply.kind === 'reject') {
    void ctx.sendReply(fromUser, '已取消，任务将继续等待。');
    return true;
  }

  const marker = r.reply.kind === 'option' ? `[用户选择: ${msgText}]` : '[用户确认执行]';
  ctx.db.prepare("DELETE FROM wa_task_conversations WHERE task_id = ? AND role = 'system' AND content LIKE '[等待用户输入]%'").run(r.taskId);
  ctx.db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'user', ?, 0, datetime('now'))").run(crypto.randomUUID(), r.taskId, marker);
  // zx_20260910_3 M2d-a: IM 选项批准＝人工介入 → 恢复并返还目标偏离额度
  // zx_20260915 P0-5(b)(c): 同上——选项批准＝答复（'im'）；本次恢复人发起（'user'）
  resumeWithQuota(ctx.db, r.taskId, { answer: { source: 'im', decision: r.reply.kind === 'option' ? 'option' : 'confirm' } });
  enqueueJob(ctx.db, 'resume-ai-task', { taskId: r.taskId, projectId: r.projectId, message: marker, initiator: 'user' });
  void ctx.sendReply(fromUser, `收到回复，正在恢复任务...`);
  return true;
}

// ====== 正则关键词 ======

// zx_20260924_1 M1（柏拉图·各司其职）: `START_REGEX` / `QUERY_REGEX` / `HELP_REGEX` / `CREATE_REGEX`
//   四条谓词**已迁入** `services/im-commands.ts`——那里是「名字 + 示例文案 + 匹配谓词」的**唯一真源**，
//   帮助文案（`handleHelp`）与路由判定（本文件各步）从此读**同一份**，结构上不可能再漂
//   （此前是两份手抄：帮助写「记住：…」而谓词不认，用户照帮助输入会落成建任务）。
//   迁走的是**定义**，用法一字未改（仍是 `START_REGEX.test(msgText)` 这种形状）。

// 指令类消息（不会被路由为Agent回复）
const COMMAND_LIKE_REGEX = /^(开始|启动|执行|运行|请|创建|新建|查看|查询|进展|状态|情况|[?？]|run|start|go|status|list|help|帮助|\d+$)/i;

/**
 * 可恢复（paused/failed）任务清单的唯一真源——「列出编号」与「按编号选择」必须是同一份。
 * 此前展示侧 `LIMIT 5` 无排序、选择侧 `LIMIT 10 ORDER BY priority DESC, updated_at DESC`，
 * 两处各写各的：用户看到第 2 项、按下 2 恢复的却是另一项。
 * 维度与 handleAgentReply 同源：本渠道+本用户；无 externalUser 的（GUI 建的）保持可恢复——
 * 真库 150 条里 149 条无 externalUser，若一并排除等于 IM 侧再也恢复不了任何 GUI 任务。
 */
const RESUMABLE_LIST_LIMIT = 10;
const RESUMABLE_WINDOW = '-7 days';
function listResumableTasks(db: Database.Database, channelType: string, fromUser: string, limit = RESUMABLE_LIST_LIMIT): Array<{ id: string; title: string }> {
  return db.prepare(
    `SELECT id, title FROM wa_tasks
      WHERE status IN ('paused','failed')
        AND (json_extract(context_json,'$.externalUser') = ? OR json_extract(context_json,'$.externalUser') IS NULL)
        AND datetime(updated_at) > datetime('now', ?)
      ORDER BY priority DESC, datetime(updated_at) DESC LIMIT ?`
  ).all(fromUser, RESUMABLE_WINDOW, limit) as Array<{ id: string; title: string }>;
}

/** 编号选择：纯数字消息 → 优先项目选择(A7)，否则选择暂停任务列表中的第N个 */
function handleNumberSelection(ctx: ImContext, fromUser: string, msgText: string): boolean {
  const num = parseInt(msgText, 10);
  if (isNaN(num) || num < 1 || num > 20) return false;
  if (!/^\d{1,2}$/.test(msgText.trim())) return false; // 纯1-2位数字

  const { db } = ctx;

  // A7: 优先处理项目编号选择（bot询问"请回复编号选择目标项目"后的回复）
  const selKey = `${ctx.channelType}:${fromUser}`;
  const pendingSel = pendingProjectSelections.get(selKey);
  if (pendingSel && pendingSel.expiresAt > Date.now()) {
    pendingProjectSelections.delete(selKey);
    if (num <= pendingSel.projects.length) {
      const proj = pendingSel.projects[num - 1]!;
      const title = pendingSel.taskText.replace(/@\S+/g, '').replace(/^(创建|新建|做一个|帮我|帮我做)\s*/i, '').trim().slice(0, 50) || '来自IM渠道的任务';
      const taskId = crypto.randomUUID();
      db.prepare('INSERT INTO wa_tasks (id, project_id, title, description, priority, status, context_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(taskId, proj.id, title, pendingSel.taskText, 1, 'pending', JSON.stringify({ source: 'im', channel: ctx.channelType, externalUser: fromUser }));
      enqueueJob(db, 'ai-task', { taskId, projectId: proj.id, source: 'im', channel: ctx.channelType, externalUser: fromUser });
      void ctx.sendReply(fromUser, `已选择「${proj.name}」，任务「${title.slice(0, 20)}」已创建并自动执行。`);
      console.log(`[IMRouter] 编号选择→项目已定位: ${proj.name}`);
      return true;
    }
    // 编号超出范围 → 回落到任务选择逻辑
  }

  // M1-4: 本渠道本用户尚有待审批项、且这个编号确实命中其选项时让位——
  // 否则"恢复全局暂停任务"会先把编号消费掉，审批语义(记录选择/消费额度/回执)永不生效。
  // 仅在编号落在选项范围内时让位：范围外的数字仍按任务编号处理，不被静默吞掉。
  const approvalList = pendingApprovals.get(`${ctx.channelType}:${fromUser}`);
  if (approvalList && approvalList.length > 0) {
    const top = approvalList[approvalList.length - 1]!;
    const optReply = matchApprovalReply(top.options ? parseOptions(top.options) : [], msgText);
    if (optReply?.kind === 'option') return false;
  }

  const pausedTasks = listResumableTasks(db, ctx.channelType, fromUser);
  if (pausedTasks.length === 0 || num > pausedTasks.length) return false;

  const task = pausedTasks[num - 1]!;
  // zx_20260910_3 M2d-a: IM 编号启动＝人工介入 → 恢复并返还目标偏离额度
  // zx_20260915 P0-5(b): **不传 `answer`**——"启动"是对任务的动作，不是对某个悬置提问的答复（名实相符）。
  // P0-5(c): 但本次恢复确是人发起的 ⇒ 标 `initiator:'user'`（否则会被当成系统自恢复而误挂横幅）。
  resumeWithQuota(db, task.id);
  enqueueJob(db, 'resume-ai-task', { taskId: task.id, source: 'im', channel: ctx.channelType, externalUser: fromUser, initiator: 'user' });
  void ctx.sendReply(fromUser, `✅ 已启动任务「${task.title}」`);
  return true;
}

/**
 * 记住偏好/习惯指令。
 *
 * zx_20260924_1 M1: 谓词表**已迁出**到 `services/im-commands.ts`（`PREFERENCE_PATTERNS` /
 * `matchRememberPreference`）——帮助里写的那条例子与这里认的必须是**同一份**。
 * 本函数只剩"落库 + 回执"两个动作，判据不再自持。
 */
function handleRememberPreference(ctx: ImContext, fromUser: string, msgText: string): boolean {
  const matched = matchRememberPreference(msgText);
  if (!matched) return false;
  // 容量约定（落库/回执的长度上限）留在此处：它是**本路**的约定，不是"算不算偏好"的判据。
  const content = matched.slice(0, 200);
  const { db } = ctx;
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO wa_memories (id, user_id, project_id, task_id, memory_type, content, source, importance, reasoning, valence, updated_at) VALUES (?, ?, NULL, NULL, 'semantic', ?, 'user_instruction', 0.7, ?, 0, datetime('now'))").run(id, fromUser, content, `从IM渠道 ${ctx.channelType} 记录`);
  void ctx.sendReply(fromUser, `✅ 已记住你的偏好：${content.slice(0, 50)}`);
  console.log(`[IMRouter] 记住偏好: user=${fromUser.slice(0, 8)} content="${content.slice(0, 50)}"`);
  return true;
}

/** 该渠道+用户当前待审批项的 taskId（队尾 LIFO）；无则 null。 */
function latestPendingApprovalTaskId(channelType: string, fromUser: string): string | null {
  const list = pendingApprovals.get(`${channelType}:${fromUser}`);
  return list && list.length > 0 ? list[list.length - 1]!.taskId : null;
}

/**
 * 该会话**最近一次交互过的 run**——由 `wa_task_conversations` 的 `[IM回复]` 记录反查（本渠道+本用户）。
 *
 * `[IM回复]` 的**唯一写入点**就在本文件 `handleAgentReply` 里（`grep -rn "IM回复" src/main` 仅两处：
 * 这一处写入 + `turn-authorship.ts` 的一句注释）——故它记的正是"这句话当初被投给了哪个 run"，
 * 而不是"哪个 run 最近被谁碰过"。
 */
function lastInteractedTaskId(db: Database.Database, channelType: string, fromUser: string): string | null {
  const row = db.prepare(
    `SELECT c.task_id FROM wa_task_conversations c JOIN wa_tasks t ON t.id = c.task_id
      WHERE c.role = 'user' AND c.content LIKE '[IM回复]%'
        AND json_extract(t.context_json,'$.channel') = ?
        AND json_extract(t.context_json,'$.externalUser') = ?
      ORDER BY datetime(c.created_at) DESC, c.rowid DESC LIMIT 1`
  ).get(channelType, fromUser) as { task_id?: string } | undefined;
  return row?.task_id || null;
}

/** 归属候选的取数上限——只用于"有几个候选"这个判断，故取一个有界值即可（20 远超实际）。 */
const REPLY_CANDIDATE_LIMIT = 20;

/** Agent回复路由：非指令消息 + 有暂停任务 → 追加到对话 */
function handleAgentReply(ctx: ImContext, fromUser: string, msgText: string, inboundId?: string): boolean {
  // 指令类消息不路由
  if (COMMAND_LIKE_REGEX.test(msgText)) return false;

  const { db } = ctx;
  // zx_20260911_2 M1: 自由回复优先落到"当前待审批的那个任务"——同一 IM 用户有多个暂停任务时，
  // 原先一律按 updated_at 取最新 ⇒ 定向错。
  const preferredTaskId = latestPendingApprovalTaskId(ctx.channelType, fromUser);
  // 查找该渠道+用户的暂停/失败任务（含 "[等待用户输入]" 的优先）
  // zx_20260911_4 M1-5: 渠道/用户维度改用 json_extract 绑定参数——
  // 原先以 LIKE 拼接，用户名含 `%`/`_` 即通配，且与审批候选集不同源。
  const selectTask = (extraWhere: string, extraParams: unknown[]) => db.prepare(
    `SELECT t.id, t.title, t.project_id, t.status, t.context_json FROM wa_tasks t
     WHERE t.status IN ('paused','failed')
     AND json_extract(t.context_json,'$.channel') = ?
     AND json_extract(t.context_json,'$.externalUser') = ?
     ${extraWhere}
     ORDER BY datetime(t.updated_at) DESC LIMIT 1`
  ).get(ctx.channelType, fromUser, ...extraParams) as { id: string; title: string; project_id: string; status: string; context_json: string } | undefined;

  // zx_20260930 M2(维特根斯坦·意义即使用 / 毛选·没有调查就没有发言权): 归属由**猜**改**指认**。
  //
  // 病根：无待审批项时一律 `ORDER BY datetime(t.updated_at) DESC LIMIT 1`——而 `updated_at` 会被
  //   与这段话**毫无关系**的写点推新（补发重试、看门狗、GUI 标注、别的渠道的对账），
  //   于是"用户没说过话的那个 run"反被选中，那句话投给了错的任务。这不是排序问题，是**没有归属依据**。
  //
  // 三条按**可指认**程度从高到低，任一条成立即用；都不成立就**如实回问**（不猜）：
  //   ① 有待审批项 ⇒ 用户刚刚就在答复它（`latestPendingApprovalTaskId`，LIFO 队尾）；
  //   ② 本会话**最近一次交互过的 run**（`lastInteractedTaskId` 反查 `[IM回复]`）；
  //   ③ 候选**只有一个** ⇒ 无歧义，不需要指认（多于此数才需要）。
  // 取候选集：与 `selectTask` 同维度（渠道+用户+终态集），只用它数个数。
  const candidates = db.prepare(
    `SELECT t.id FROM wa_tasks t
      WHERE t.status IN ('paused','failed')
        AND json_extract(t.context_json,'$.channel') = ?
        AND json_extract(t.context_json,'$.externalUser') = ?
      ORDER BY datetime(t.updated_at) DESC LIMIT ${REPLY_CANDIDATE_LIMIT}`
  ).all(ctx.channelType, fromUser) as Array<{ id: string }>;

  let task = preferredTaskId ? selectTask('AND t.id = ?', [preferredTaskId]) : undefined;
  if (!task && candidates.length === 1) task = selectTask('AND t.id = ?', [candidates[0]!.id]);
  if (!task) {
    const recent = lastInteractedTaskId(db, ctx.channelType, fromUser);
    if (recent) task = selectTask('AND t.id = ?', [recent]);
  }

  // 仍歧义 ⇒ **如实回问**。编号清单必须与"列出/按编号选择"**同一份**（`listResumableTasks`）：
  //   否则用户看到第 2 项、按下 2 恢复的是另一项（M1-4 已有的那条尺）。清单不足两项则无从选，
  //   交回上层（返回 false），绝不去猜一个。
  if (!task && candidates.length > 1) {
    const list = listResumableTasks(db, ctx.channelType, fromUser);
    if (list.length > 1) {
      void ctx.sendReply(fromUser, `你有 ${list.length} 个挂起的任务，这句话该归哪一个？请回复编号：\n${list.map((t, i) => `${i + 1}. ${t.title}`).join('\n')}`);
      console.log(`[IMRouter] 归属歧义→如实回问: user=${fromUser.slice(0, 8)} 候选=${list.length}`);
      return true;
    }
  }

  if (!task) return false;

  // 追加到任务对话
  db.prepare(
    "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'user', ?, 0, datetime('now'))"
  ).run(crypto.randomUUID(), task.id, `[IM回复] ${msgText}`);

  // zx_20260930 M5: 这句话是**用户对 agent 正在做的事的纠正** ⇒ 按 `user_correction` 落一条记忆。
  //   为什么是纠正而不是普通记录：任务此刻正停在 `paused`/`failed`，停下正是因为需要人；
  //   用户此刻说的是**对这个 run 的指引**，不是闲聊，也不是"记住我的偏好"（那条另有 `handleRememberPreference`）。
  //   这一条同时第一次点亮了 `user_correction` 三条**早就在册、此前写侧为零**的保护：
  //   置信顶分 0.95（`confidenceOf` 来源分表）/ `sameSourceReplace` 永不覆盖 / 衰减豁免（`isCore` ⇒ 半衰期 ×5）。
  //   ⚠ 用户原话**逐字**（`buildImUserCorrection` 只加出处前缀，不改写）——改写用户的话即等于伪造纠正。
  //   ⚠ 记不上不阻断路由：记忆是**副产品**，投递才是这件事本身（同 `attachPendingMediaToTask` 的纪律）。
  try {
    const mem = ctx.getMemory?.();
    if (mem) {
      mem.storeText({
        project_id: task.project_id, task_id: task.id, type: 'episodic',
        content: buildImUserCorrection({ text: msgText, channel: ctx.channelType, taskTitle: task.title }),
        source: MEM_SOURCE_USER_CORRECTION,
      });
    }
  } catch { /* 记忆写失败不得影响这句话的投递 */ }

  // zx_20260930 M2-c（维特根斯坦·意义即使用 / 一实一名）: 这句话**归给了哪张任务**，就记在
  //   它**自己那一行**上（前面那 4 条早退都已过去，`task.id` 由三条指认依据定下，此即「真知道」的
  //   两处之二——另一处是 `sendImCompletionNotice` 手里那个 taskId）。
  //   ⚠ 与 `[IM回复]` 那条 run 侧记录**同刻同源**：归属不是事后猜的，是**投递那一刻的事实**。
  //   ⚠ 标不上不算错：入站行 id 缺失（旧调用）或旧库无 `task_id` 列时**跳过**——路由照走，
  //     绝不因为一行标牌而丢掉用户这句话（可读性不能反过来绑架功能）。
  if (inboundId) {
    try {
      ctx.db.prepare('UPDATE wa_im_conversations SET task_id = ? WHERE id = ?').run(task.id, inboundId);
    } catch { /* 旧库无 task_id 列：不阻断路由 */ }
  }

  // zx_20260924 §2e（用户 2026-09-24 裁定）: 这句话若带着刚发来的件，件就挂到**这张被恢复的任务**上。
  //   位置在"已经确定落哪张任务"之后、且在所有早退之后——与本文件另一条建任务路同一条纪律：
  //   **不落任务就不消费件**。必须早于下面的 `enqueueJob`，否则恢复作业可能在挂件之前就跑起来，
  //   那一次执行的 `hasMedia` 仍然是假（件要等下一次恢复才看得见，等于白挂）。
  //   什么不在此列：审批答复（「确认」/选项编号）、编号选择、`开始+任务名`——它们是**对某个悬置提问的
  //   决定**，不是"带着一句话去干活"，把件挂上去只会让"我到底在答复什么"变得说不清。
  const attachedHere = attachPendingMediaToTask(db, {
    channelId: ctx.channelId, externalUser: fromUser, channelType: ctx.channelType, taskId: task.id,
    ...(inboundId ? { beforeId: inboundId } : {}),
  });
  if (attachedHere) console.log(`[IMRouter] 附件已挂到被回复的任务: task=${task.id.slice(0, 8)} file=${attachedHere.fileName ?? attachedHere.path}`);

  // zx_20260910_3 M2d-a: IM 直接回复＝人工介入 → 恢复并返还目标偏离额度
  // zx_20260915 P0-5(b)(c): 直接回复是最典型的**答复** → 落 answer 账（'im'）；本次恢复人发起（'user'）
  resumeWithQuota(db, task.id, { answer: { source: 'im', decision: 'reply' } });

  // 入队恢复执行
  enqueueJob(db, 'resume-ai-task', { taskId: task.id, projectId: task.project_id, message: `[用户回复] ${msgText}`, initiator: 'user' });

  void ctx.sendReply(fromUser, `📨 已收到回复，任务「${task.title.slice(0, 30)}」继续执行…`);
  console.log(`[IMRouter] Agent回复路由: task=${task.id.slice(0, 8)} msg="${msgText.slice(0, 30)}"`);
  return true;
}

/**
 * zx_20261016_1 批三（周易·乾·文言「同声相应」/ 王阳明·知行合一 / 庄子·不预设）:
 * **IM 回复即审批**——外部终端申请接入时，用户回一句「同意接入 <核对码>」就能放行（不必回电脑前点面板）。
 *
 * 次序（**为何在此位**，见调用点注释）：夹在**步骤-2 编号选择之后、步骤0 审批队列之前**。
 *   - 晚于步骤-2：编号选择是「上下文相关的应答」（本项目候选 / 审批选项 / 暂停任务列表），
 *     本路的输入**必须**带「接入」二字（`parsePairReply` 锚定），两者字面**不可能**撞车，故先后无碍，
 *     但仍排在步骤-2 之后——不与"编号即选择"的既有语义抢位。
 *   - 早于步骤0：本路与任务审批**语义不同、真源不同**（配对行是**库里的持久行**，不是内存审批队列）。
 *     若排在步骤0 之后，用户的「同意接入 X」有可能先被 `handleAgentReply` 当**自由回复**吃掉
 *     （与 `zx_20260911_2 M1` 审批前移**同一教科书病例**）——故必须前置。
 *
 * 四点纪律：
 *  ① **认不出就不认领**（返回 `false`）：没有待批申请时说「同意接入」不该被本路吞成**静默无响应**，
 *     而应落回既有链路（问候/兜底）。
 *  ② **歧义列候选不猜**（庄子·不预设 / 同 `resolveDeviceByName`）：无码而多条待批 ⇒ 列候选**不批**。
 *  ③ **知而不行只是未知**（王阳明）：`approve` **真落库**（`pending→approved` + 铸凭据），
 *     只回一句"已收到"不算——凭据仍由机器人经 `pairStatus` 轮询**直取**（凭据不过用户手，罗尔斯·无知之幕）。
 *  ④ **看得见**（就地订正，见方案 §五 批三）：面板 `DoorCard` 本就在 **5s 轮询**（`PeersPage.tsx:622`），
 *     审批结果最迟 5s 内可见。原拟加一条瞬态事件**未做**——`eventBus.EventType` 是**闭合联合**，
 *     新增一个值须穷举全部读取谓词（承 `feedback_enum_value_sweep_readers`）；为"少等 ≤5s"付这个代价不划算，
 *     如实登记而非悄悄塞一个新枚举值（与 `im.message_inbound` 那条"本来就有"的性质不同）。
 */
function handleTerminalPairReply(ctx: ImContext, fromUser: string, msgText: string): boolean {
  const parsed = parsePairReply(msgText);
  if (!parsed) return false;
  const target = resolvePairTarget(ctx.db, parsed.code);
  if (target.kind === 'none') return false; // ① 没有待批申请 ⇒ 不认领（落回既有链路，不静默）
  if (target.kind === 'ambiguous') {
    // ② 列候选，不批——把选择权交回用户（"当前有 N 条"如实报数）。
    const lines = target.pendings.map((p) => `${p.pair_code} ${p.name}`).join('\n');
    void ctx.sendReply(fromUser, `当前有 ${target.pendings.length} 条待接入申请，请回复「同意接入 <核对码>」：\n${lines}`);
    return true;
  }
  const p = target.pending;
  if (parsed.kind === 'approve') {
    const r = approveTerminal(ctx.db, p.id, []); // ③ 真落库 + 铸凭据（能力面留待终端经 capabilities 自取/后续补）
    if (!r.ok) { void ctx.sendReply(fromUser, `⚠️ 未能允许「${p.name}」接入（${r.reason}）。`); return true; }
    void ctx.sendReply(fromUser, `✅ 已允许「${p.name}」接入（核对码 ${p.pair_code}）。机器人会自行取回凭据。`);
    console.log(`[IMRouter] 配对审批（IM）：approve ${p.id.slice(0, 8)} code=${p.pair_code}`);
  } else {
    const r = rejectTerminal(ctx.db, p.id);
    if (!r.ok) { void ctx.sendReply(fromUser, `⚠️ 未能拒绝「${p.name}」接入（${r.reason}）。`); return true; }
    void ctx.sendReply(fromUser, `🚫 已拒绝「${p.name}」接入（核对码 ${p.pair_code}）。`);
    console.log(`[IMRouter] 配对审批（IM）：reject ${p.id.slice(0, 8)} code=${p.pair_code}`);
  }
  return true;
}

// ====== 主入口 ======

export async function routeImMessage(
  ctx: ImContext, fromUser: string, text: string, chatType: string, contextToken: string,
  meta?: ImMessageMeta,
): Promise<void> {
  const msgText = text.trim();
  if (!msgText) return;

  // zx_20260914 M1-2(维特根斯坦·意义即使用): 非文本消息（meta.kind 有值）**到此为止**——
  //   记录即已达成目的（用户发的图在对话里看得见），但**不进指令/建任务管道**：
  //   `[图片]` 恰 4 字会触发步骤3兜底回话、`[文件 x.pdf 1.2MB]` 长于 4 字会被当自由文本**建成任务**，
  //   两条都不是用户的本意（用户裁决 D3：默认不回，只如实记一条带类型标签的记录）。
  const isNonText = !!meta?.kind;
  // 去重键：文本按正文（30s 窗，防平台 webhook 重放）；非文本无正文可辨，只能靠平台消息 id——
  //   给了 id 就按 id 去重（重放仍被挡）；没给则**不猜**：宁可多记一行（可见的重复），
  //   不可静默吞掉用户第二张图（不可见的丢失）——「消息到没到」不可倒向后者。
  const dedupKey = meta?.messageId
    ? `${ctx.channelType}:${fromUser}:id:${meta.messageId}`
    : isNonText
      ? ''
      : `${ctx.channelType}:${fromUser}:${msgText.slice(0, 80)}`;
  if (dedupKey && isDuplicate(dedupKey)) { console.log('[IMRouter] 重复消息，跳过'); return; }

  // 存储入站消息（非文本附加真类型/文件名/大小，**增量**写——既有字段一字不动）
  // zx_20260920_1 M5: 行 id 提到 try **之外**——非文本分支要按 id 回填 `last_error`（落盘失败的真因）。
  const inboundId = crypto.randomUUID();
  try {
    ctx.db.prepare(
      'INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))'
    ).run(inboundId, ctx.channelId, fromUser, JSON.stringify({
      text,
      from_user_id: fromUser,
      chat_type: chatType,
      ...(meta?.kind ? { kind: meta.kind } : {}),
      ...(meta?.fileName ? { file_name: meta.fileName } : {}),
      ...(meta?.sizeBytes !== undefined ? { size_bytes: meta.sizeBytes } : {}),
      // zx_20260921 M1: **盘上哪一份**要留在这一行上——此前 `savedPath` 落盘成功却被丢掉，
      //   下一条消息因此无从取件（"件在盘上，路没修"）。成功写 `saved_path`、失败写 `media_error`，
      //   两者互斥、都**只在真发生时才写**（不写 null 占位，免得 `IS NOT NULL` 判空失效）。
      ...(meta?.savedPath ? { saved_path: meta.savedPath } : {}),
      ...(meta?.mediaError ? { media_error: meta.mediaError } : {}),
    }), 'inbound');
    // zx_20261002 M1: 载荷补「渠道名 / 件名 / 件大小 / 件类型」——此前只有 `preview: text.slice(0,60)`，
    //   跨页提醒于是只能显示半句话，看不出"谁、从哪个渠道、发来了什么件"。
    //   渠道名走一次 PK 查（`wa_im_channels.name`）。**取不到不阻断入站**：退回渠道类型，
    //   不因取名失败把整条入站事件丢掉（"提醒到得了"不该被一个显示名挡住）。
    let channelName = ctx.channelType;
    try {
      const row = ctx.db.prepare('SELECT name FROM wa_im_channels WHERE id = ?').get(ctx.channelId) as { name?: string } | undefined;
      if (row?.name) channelName = row.name;
    } catch { /* 取名失败退回渠道类型 */ }
    // zx_20260906 批4 (4a): IM 入站消息实时回推——落库后即发 im.message_inbound（瞬态，不落事件日志；
    // 正在查看该渠道的 IMPage 即时刷新，补上轮"入站未转发"遗留）
    void eventBus.emitTransient('im.message_inbound', {
      channelId: ctx.channelId,
      channel_id: ctx.channelId,
      channelType: ctx.channelType,
      channel_type: ctx.channelType,
      channelName,
      channel_name: channelName,
      fromUser,
      from_user_id: fromUser,
      preview: text.slice(0, 60),
      chatType,
      ...(meta?.kind ? { kind: meta.kind } : {}),
      ...(meta?.fileName ? { fileName: meta.fileName } : {}),
      ...(meta?.sizeBytes !== undefined ? { sizeBytes: meta.sizeBytes } : {}),
      createdAt: new Date().toISOString(),
    });
    // zx_20260912 M2(海德格尔·在场): 入站即刷新托盘未读账——不在 IM 页也能"知有人来过"。
    // 为 0 或不在托盘场景下代价极低（一次 COUNT + 至多一次菜单重建）；失败不影响消息处理。
    try { refreshImUnread(ctx.db); } catch { /* 未读不刷新不影响入站处理 */ }
  } catch (err) { console.error('[IMRouter] 存储消息失败:', (err as Error).message); }

  // ====== 风暴闸（zx_20260920 M1：**移到落库之后**）======
  // 病根（方案 §1.3-S1）：原先这一闸在 INSERT **之前** return ⇒ 命中即"不落库、不回话、不告警"，
  //   对话视图里查不到，用户也不知道自己那句话被吞了 —— 与"防刷屏"的本意（别把管道打爆）相比，
  //   多吞掉的是**证据**。现在：落库 + 入站事件 + 未读刷新**都已发生**，再压管道。
  // ⇒ 风暴命中 = **处理降级**，不是**证据消失**；GUI 里那几条消息立刻看得见（形状见 §2.2 洞穴喻）。
  {
    const v = stormVerdict(stormTracker.get(fromUser), Date.now());
    stormTracker.set(fromUser, v.next);
    if (v.storm) {
      imLogger.warn(`风暴闸：${fromUser.slice(0, 8)} ${v.next.count} 条/2s，已落库、暂缓处理，冷却 ${STORM_COOLDOWN_MS / 1000}s`);
      // 冷却期内**只提示一次**——提示本身不许变成刷屏（D3）。
      if (v.firstInCooldown) {
        // M2 起不再各点兜底：失败由 `ImContext.sendReply` 构造处统一落账并告警（见接口注释）。
        void ctx.sendReply(fromUser, STORM_NOTICE);
      }
      return;
    }
  }

  // zx_20260914 M1-2: 非文本消息**止步于此**——落库 + 发 inbound 事件 + 刷未读账都已完成
  //   （"消息到没到"已成立），但不进入下方任何指令/建任务/回话分支。
  //   依据：占位符长度落点恰好踩中两处误判（4 字→兜底回话；>4 字→建任务），
  //   且用户裁决 D3「默认不回」——不回话是**规定动作**，不是遗漏。
  //
  // zx_20260920_1 M5: D3 的唯一例外是**取了件的那一条**——落盘成功或失败**都必须回一句**
  //   （成功报落点、失败明说"没能落盘"+真因）。这一句是**固定文案的落地回执**，不是把媒体交给模型
  //   自由发挥：仍不进下方任何分支（R-3 反向钉锁死"非文本不进自由回复路"）。
  //   ⚠ 无取件动作的（无 mediaUrl，含其余四家）**行为一字不变**：只记一条、不回话。
  if (isNonText) {
    if (meta?.savedPath || meta?.mediaError) {
      if (meta.mediaError) {
        // 行照落、账照记，但真因要留在**这一条**上（不新造列：`last_error` 既有）。
        // ⚠ 同一列在**入站行**上的语义是「本行媒体**落盘**失败的真因」——与出站行的「**送达**失败真因」
        //   是两回事（`direction = 'inbound'` 显式限定，免得日后一句全局 `last_error != ''` 被两种语义喂饱）。
        try {
          ctx.db.prepare("UPDATE wa_im_conversations SET last_error = ? WHERE id = ? AND direction = 'inbound'").run(meta.mediaError, inboundId);
        } catch (err) { console.error('[IMRouter] 回填入站媒体失败原因出错:', (err as Error).message); }
      }
      void ctx.sendReply(fromUser, mediaReceiptText({
        kind: meta?.kind ?? '',
        fileName: meta?.fileName,
        sizeBytes: meta?.sizeBytes,
        savedPath: meta?.savedPath,
        error: meta?.mediaError,
      }));
      console.log(`[IMRouter] 非文本消息已到场（kind=${meta?.kind}）${meta.savedPath ? '已落盘' : `落盘失败：${meta.mediaError}`}`);
      return;
    }
    console.log(`[IMRouter] 非文本消息已到场（kind=${meta?.kind}），不进入指令管道`);
    return;
  }

  // ====== 步骤-3: 记住偏好/习惯指令 ======
  if (handleRememberPreference(ctx, fromUser, msgText)) return;

  // ====== 步骤-2: 编号选择 ======
  if (handleNumberSelection(ctx, fromUser, msgText)) return;

  // ====== 步骤-1: 外部终端**配对审批**（步骤-2 之后、步骤0 之前——见 `handleTerminalPairReply` 头注）======
  // zx_20261016_1 批三: 「同意接入 <核对码>」/「拒绝接入 <核对码>」走此路。
  //   ⚠ 与任务审批**两把尺**：本路只认「(同意|拒绝)接入」句式（`parsePairReply` 锚定）；裸「同意」/「是」
  //     仍归步骤0 的任务审批——两路语义不混（反证标本见 rr P-2）。
  if (handleTerminalPairReply(ctx, fromUser, msgText)) return;

  // ====== 步骤0: 审批队列检查（须先于自由回复路由）======
  // zx_20260911_2 M1(罗尔斯·同一规则 / 维特根斯坦·语言游戏): 次序倒置时，「是」/选项先被
  // handleAgentReply 当普通回复吃掉——审批语义(记录"用户确认执行"、消费额度、"已确认"/"已取消"回执)永不生效，
  // 多暂停任务时还按 updated_at 定向到错任务。checkPendingApproval 不匹配即 return false，故前移不牺牲自由回复。
  if (checkPendingApproval(ctx, fromUser, msgText)) return;
  // A5: 审批回退DB扫描（队列失效/丢失时，DB扫描paused+[等待用户输入]选项匹配）
  if (checkDbApprovalFallback(ctx, fromUser, msgText)) return;

  // ====== 步骤1: Agent回复路由 ======
  if (handleAgentReply(ctx, fromUser, msgText, inboundId)) return;

  // ====== 步骤1: IM命令分发 ======
  if (await tryImCommand(ctx, fromUser, msgText)) return;

  // ====== 步骤1.2: 「帮助」(M3-1) ======
  // 问候语(:563)与兜底(:578)都承诺「输入「帮助」查看可用指令」，但 QUERY_REGEX 把它并进
  // handleSystemQuery，只回项目/任务计数——喊了不认(E7)。
  // 必须**在问候之前**认领：「帮助」是两个汉字，会被步骤3 的 `^[一-龥]{1,3}$` 当问候吃掉
  // （与 M1-6 同一教科书病例：分支写在被遮蔽的位置＝生产不可达）。
  if (HELP_REGEX.test(msgText.trim())) { await handleHelp(ctx, fromUser); return; }

  // 正则模式提前声明（供步骤1.5和步骤2/3共用）
  const systemQueryPatterns = [/系统情况/, /系统状态/, /工蚁.*情况/, /工蚁.*状态/, /整体.*情况/, /运行.*状态/, /how.*system/i];
  const greetPatterns = [/^(你好|hi|hello|谢谢|thanks|好的|ok|嗯|哦)[!！。.]*$/i, /^[一-龥]{1,3}$/];

  // ====== 步骤1.5: LLM 意图分类（regex未匹配时） ======
  const isRegexMatched = systemQueryPatterns.some(p => p.test(msgText))
    || greetPatterns.some(p => p.test(msgText))
    || START_REGEX.test(msgText)
    || (QUERY_REGEX.test(msgText) && !CREATE_REGEX.test(msgText))
    || CREATE_REGEX.test(msgText);

  if (!isRegexMatched && msgText.length > 4) {
    // zx_20260909 Y2a(少则得·断点回执): 将落入需 LLM 意图分类的耗时处理(正则未命中)→先回一次性 busy ack, 防"发消息后长时间无响应"的静默走廊;
    // 后续真实回话(建任务/状态)仍照常; im.busy_ack=0 关闭。已在问候/命令等即时分支不回(少则得, 不重复轰炸)。
    try {
      const busyRow = ctx.db.prepare("SELECT value FROM wa_settings WHERE key = 'im.busy_ack'").get() as { value?: string } | undefined;
      if (boolSetting(busyRow?.value)) await ctx.sendReply(fromUser, '⏳ 收到，正在理解你的消息…');
    } catch { /* busy ack 失败不阻断后续分类 */ }
    const llmIntent = await classifyIntentWithLLM(ctx, msgText);
    if (llmIntent) {
      if (llmIntent === 'start_task') { await handleStartTask(ctx, fromUser, msgText); return; }
      if (llmIntent === 'query_status') { await handleSystemQuery(ctx, fromUser); return; }
      if (llmIntent === 'create_task') { await handleCreateTask(ctx, fromUser, msgText, inboundId); return; }
    }
  }

  // ====== 步骤2: 系统状态查询 ======
  if (systemQueryPatterns.some(p => p.test(msgText))) { await handleSystemQuery(ctx, fromUser); return; }

  // ====== 步骤3: 简单问候 ======
  // zx_20260911_4 M1-6: 裸启动词（开始/启动/运行/执行，均 ≤3 字）会被 `^[一-龥]{1,3}$` 当问候吃掉，
  // 于是 handleStartTask 的「请回复编号」列表分支在生产中永不触达——问侧从未发出，答侧便无从成立。
  // 启动词让位给步骤4（问候文案本身承诺「输入「开始+任务名」启动暂停的任务」）。
  if (!START_REGEX.test(msgText) && greetPatterns.some(p => p.test(msgText))) {
    await ctx.sendReply(fromUser, '你好！我是工蚁 AI 助手。你可以：\n• 输入项目命令关键词（如「持仓」「信号」等）\n• 输入「创建任务+标题」新建任务\n• 输入「开始+任务名」启动暂停的任务\n• 输入「查看系统状态」了解运行情况');
    return;
  }

  // ====== 步骤4: 启动任务 ======
  if (START_REGEX.test(msgText)) { await handleStartTask(ctx, fromUser, msgText); return; }

  // ====== 步骤5: 系统查询 ======
  if (QUERY_REGEX.test(msgText) && !CREATE_REGEX.test(msgText)) { await handleSystemQuery(ctx, fromUser); return; }

  // ====== 步骤6: 创建任务 ======
  const isCreate = CREATE_REGEX.test(msgText) || msgText.length > 4;
  if (isCreate) { await handleCreateTask(ctx, fromUser, msgText, inboundId); return; }

  // ====== 兜底 ======
  await ctx.sendReply(fromUser, '收到。如需帮助，输入「帮助」查看可用指令。');
}

// ====== IM 命令分发（通道A） ======

async function tryImCommand(ctx: ImContext, toUser: string, msgText: string): Promise<boolean> {
  try {
    const projects = ctx.db.prepare("SELECT id, name, context_json, working_dir FROM wa_projects WHERE status = 'active'").all() as Array<{
      id: string; name: string; context_json: string; working_dir: string;
    }>;

    for (const proj of projects) {
      let ctxJson: Record<string, unknown> = {};
      try { ctxJson = JSON.parse(proj.context_json || '{}'); } catch {}
      const imCommands = ctxJson.im_commands as Record<string, { script: string; label: string; timeout_seconds?: number }> | undefined;
      if (!imCommands) continue;

      for (const [keyword, cmd] of Object.entries(imCommands)) {
        if (!msgText.includes(keyword)) continue;
        if (!cmd.script) continue;

        const workingDir = proj.working_dir || '';
        const label = cmd.label || keyword;
        console.log(`[IMRouter] IM命令匹配: 项目="${proj.name}" 关键词="${keyword}" 脚本="${cmd.script}"`);
        let stdoutBuf = '';
        let stderrBuf = '';

        try {
          const notifyDir = resolveNotificationDir();
          if (!fs.existsSync(notifyDir)) fs.mkdirSync(notifyDir, { recursive: true });

          const execDir = workingDir && fs.existsSync(workingDir) ? workingDir : process.cwd();

          // zx_20260911_4 M3-2(夏克特·错误归属 / 奥卡姆): 记下 spawn 时刻——命令侧只认
          // 「本次 spawn 之后生成」的产物。此前取目录里**最新**的非 P0_ 文件，会把 spawn 前
          // 就躺在目录里的旧播报当成本次命令的输出，还顺手 unlink 掉 F3 待发的那一条。
          const spawnTime = Date.now();

          // 异步执行脚本，不阻塞主线程（收集 stderr 用于失败时定位根因）
          await new Promise<void>((resolve, reject) => {
            // 超时可按命令配置（im_commands[].timeout_seconds），默认 10 分钟
            const timeout = (Number(cmd.timeout_seconds) || 10 * 60) * 1000;
            const proc = spawn(cmd.script, [], {
              cwd: execDir,
              // WA_IM_COMMAND=1: 标记「用户手动提问」通道——a-stock 投顾 push_gate 据此旁路告警去重
              //（A_20260914），使「投顾建议」这类手动命令当日第二次起不再被静默吞成"未生成输出文件"。
              env: { ...process.env, NOTIFICATION_PAYLOAD_DIR: notifyDir, WA_IM_COMMAND: '1' },
              shell: true,
              stdio: 'pipe',
              timeout,
            });
            proc.stdout?.on('data', (d: Buffer) => { stdoutBuf += d.toString(); });
            proc.stderr?.on('data', (d: Buffer) => { stderrBuf += d.toString(); });
            const timer = setTimeout(() => {
              proc.kill('SIGTERM');
              imLogger.warn({ label, stderrTail: stderrBuf.slice(-2000) }, '[IMRouter] 命令超时，已 SIGTERM');
              reject(new Error(`命令超时(${timeout/1000}s): ${label}`));
            }, timeout);
            proc.on('close', (code) => {
              clearTimeout(timer);
              code === 0 ? resolve() : reject(new Error(`命令退出码=${code}`));
            });
            proc.on('error', (err) => { clearTimeout(timer); reject(err); });
          });

          // 读取通知目录下**本次 spawn 之后生成**的最新 .txt
          // 口径: `P0_` 归 F3（命令侧排除）; F3 侧拥有全部 .txt（含 P0_），两侧互不偷吃。
          let outputText = '';
          try {
            const files = fs.readdirSync(notifyDir)
              // zx_20260916 M3: 两路滤器的**差异**（`P0_`）如实保留，**共同项**（探针豁免）走同一份表。
              .filter(f => f.endsWith('.txt') && !f.startsWith('P0_') && !isProbeNotifyFile(f))
              .filter(f => { try { return fs.statSync(path.join(notifyDir, f)).mtimeMs >= spawnTime; } catch { return false; } })
              .sort().reverse();
            if (files.length > 0) {
              const latestPath = path.join(notifyDir, files[0]!);
              outputText = clipWithNotice(fs.readFileSync(latestPath, 'utf-8'), IM_ROUTER_OUTPUT_LIMIT);
              try { fs.unlinkSync(latestPath); } catch {}
            }
          } catch {}

          if (outputText) {
            await ctx.sendReply(toUser, outputText);
          } else {
            imLogger.warn({ label, stdoutTail: stdoutBuf.slice(-500), stderrTail: stderrBuf.slice(-2000) }, '[IMRouter] 命令成功但未生成输出文件');
            await ctx.sendReply(toUser, `${label}：命令已执行，但未生成输出文件。`);
          }
        } catch (execErr) {
          const errMsg = (execErr as Error).message;
          imLogger.error({ label, error: errMsg, stdoutTail: stdoutBuf.slice(-500), stderrTail: stderrBuf.slice(-2000) }, '[IMRouter] IM命令执行失败');
          console.error(`[IMRouter] IM命令执行失败: ${label}`, errMsg);
          await ctx.sendReply(toUser, `❌ ${label}生成失败，请稍后重试。`);
        }
        return true; // 短路：第一个匹配即返回
      }
    }
  } catch (err) {
    console.error('[IMRouter] IM命令分发异常:', (err as Error).message);
  }
  return false; // 无匹配，继续后续路由
}

// ====== 「帮助」(M3-1) ======

/**
 * 「帮助」的唯一实现（维特根斯坦·语言游戏 / 米勒 7±2 / 奥卡姆）：
 * 只出**框架内置动词** + **各 active 项目自配的关键词**（`context_json.im_commands`，
 * object: keyword → {script,label}），按项目分组，一式「关键词 — label」。
 * **零新增命令词**（复用已被承诺的「帮助」/`help`）；**不出脚本路径**——细节不铺开。
 */
async function handleHelp(ctx: ImContext, fromUser: string): Promise<void> {
  // zx_20260924_1 M1: 内置动词那一栏**从指令表派生**（`services/im-commands.ts` 的 `BUILTIN_IM_COMMANDS`）
  //   ——名字与示例文案都取自那里，而**同一张表的 `match` 就是路由器真正用的谓词**。
  //   此处不再手写文案：改了例子，帮助与判定一起变；不改例子，机器不会偷偷不认。
  const lines: string[] = ['📖 可用指令'];
  for (const cmd of BUILTIN_IM_COMMANDS) lines.push(`· ${cmd.name} — ${cmd.example}`);

  const groups: string[] = [];
  try {
    const projects = ctx.db.prepare("SELECT name, context_json FROM wa_projects WHERE status = 'active' ORDER BY name").all() as Array<{ name: string; context_json: string }>;
    for (const proj of projects) {
      let ctxJson: Record<string, unknown> = {};
      try { ctxJson = JSON.parse(proj.context_json || '{}'); } catch { continue; }
      const cmds = ctxJson.im_commands;
      if (!cmds || typeof cmds !== 'object') continue;
      // 只列真的能跑起来的（有 script）；label 缺省回落关键词本身
      const rows = Object.entries(cmds as Record<string, { script?: string; label?: string }>)
        .filter(([, c]) => c && typeof c === 'object' && !!c.script);
      if (rows.length === 0) continue;
      groups.push(`【${proj.name}】`);
      for (const [keyword, c] of rows) groups.push(`· ${keyword} — ${c.label || keyword}`);
    }
  } catch { /* 项目命令读取失败不阻断内置动词 */ }

  if (groups.length > 0) lines.push('', ...groups);
  else lines.push('', '（暂无项目配置命令关键词）');
  await ctx.sendReply(fromUser, lines.join('\n'));
}

// ====== 系统状态查询 ======

/** 下钻列几条（米勒 7±2：五条以内不必再数，超了就先看最上面那几条）。 */
const SYSTEM_QUERY_TASK_LIMIT = 5;

/** 按**码点**截断——`str.slice` 会把代理对（emoji）劈成两半变成乱码。 */
function clipText(s: string, max: number): string {
  const cps = [...s];
  return cps.length <= max ? s : cps.slice(0, max).join('') + '…';
}

/**
 * 时刻**标 UTC**：本仓 DB 时刻是 UTC（`datetime('now')`），`git`/`ps` 才是本地 +0800——
 * 两者不可混说（曾把 08:18–09:44(UTC) 与本地 17:28 并排比而得出错位先后）。
 * 读不出就如实说"时刻未记录"，不拿当前时间顶上。
 */
function stampUtc(t: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(t ?? ''));
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC` : '时刻未记录';
}

/**
 * 该任务的「最近一步」= 最后一条执行记录的**原文**（去 `[标签] ` 前缀 → 收空白 → 前 30 字）。
 * 读不到就**返回空串**（调用方只给标题与状态）——不编一句像样的"最近一步"。
 */
function lastStepOf(ctx: ImContext, taskId: string): string {
  try {
    const r = ctx.db.prepare(
      "SELECT content FROM wa_task_conversations WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
    ).get(taskId) as { content?: string } | undefined;
    const s = (r?.content ?? '').replace(/^\s*\[[^\]]{1,12}\]\s*/, '').replace(/\s+/g, ' ').trim();
    return s ? clipText(s, 30) : '';
  } catch {
    return '';
  }
}

/**
 * 任务级问答（zx_20260920_1 M6）。
 *
 * 病根（方案 §1 D5）：全函数只有六条 `COUNT(*)`——用户问「查看系统状态」只拿得到"运行中 2"，
 * **答不到"是哪两个"**。这与本轮其余病根同一形状：数**在册**了，事**答不出**。
 *
 * 治法：计数之上**下钻一层**——最近 5 条未终态任务的真标题 + 状态 + 最近一步，以及最近一条终态任务。
 * 三条纪律：
 *  ① **不新造命令词**（用户裁定 §五-8）：并入既有「查看」词，`QUERY_REGEX` 一字未改；
 *  ② **不吞「帮助」**（R-4）：`HELP_REGEX` 的认领点在 `routeImMessage` 里**先于**本函数，未动；
 *  ③ **不知道的不编**：状态词走 `taskStatusWord`（全仓唯一一份词表，未知状态**原文回显**）；
 *     时刻标 UTC；「最近一步」取不到就只给标题与状态。
 *
 * ⚠ 「未终态」取 `NOT IN ('completed','failed','archived')`——与 `task-accounting.ts` /
 *   `bottleneck-analyzer.ts` / `tools/control.ts` 等处**同一把尺**（`archived` 也是终态：
 *   否则已归档任务会常年挂在"进行中"里）。
 * ⚠ 排序用 `datetime(updated_at)` 而非裸 `updated_at` —— 见文件头「时刻列纪律」。
 */
async function handleSystemQuery(ctx: ImContext, toUser: string): Promise<void> {
  try {
    const projects = ctx.db.prepare('SELECT COUNT(*) as c FROM wa_projects').get() as { c: number };
    const tasks = ctx.db.prepare('SELECT COUNT(*) as c FROM wa_tasks').get() as { c: number };
    const running = ctx.db.prepare("SELECT COUNT(*) as c FROM wa_tasks WHERE status IN ('executing','running')").get() as { c: number };
    const paused = ctx.db.prepare("SELECT COUNT(*) as c FROM wa_tasks WHERE status = 'paused'").get() as { c: number };
    const completed = ctx.db.prepare("SELECT COUNT(*) as c FROM wa_tasks WHERE status = 'completed'").get() as { c: number };
    const failed = ctx.db.prepare("SELECT COUNT(*) as c FROM wa_tasks WHERE status = 'failed'").get() as { c: number };
    const activeProj = ctx.db.prepare("SELECT name FROM wa_projects WHERE status = 'active' LIMIT 5").all() as Array<{ name: string }>;
    // 下钻一层：**未终态**（进行中/暂停/待执行…）最近几条
    const activeTasks = ctx.db.prepare(
      `SELECT id, title, status FROM wa_tasks
       WHERE status NOT IN ('completed','failed','archived')
       ORDER BY datetime(updated_at) DESC LIMIT ?`
    ).all(SYSTEM_QUERY_TASK_LIMIT) as Array<{ id: string; title: string; status: string }>;
    // 终态里**最近一条**的结果（`datetime(...) AS t` 归一两种格式；读不出则 null，文案如实说"时刻未记录"）
    const lastTerminal = ctx.db.prepare(
      `SELECT title, status, datetime(updated_at) AS t FROM wa_tasks
       WHERE status IN ('completed','failed','archived')
       ORDER BY datetime(updated_at) DESC LIMIT 1`
    ).get() as { title: string; status: string; t: string | null } | undefined;

    const lines = [
      '📊 工蚁系统状态',
      `项目: ${projects.c} 个（活跃: ${activeProj.map(p => p.name).join('、') || '无'}）`,
      `任务: ${tasks.c} 个 | 运行中 ${running.c} | 暂停 ${paused.c} | 已完成 ${completed.c} | 失败 ${failed.c}`,
    ];
    if (activeTasks.length > 0) {
      lines.push('进行中:');
      for (const t of activeTasks) {
        const step = lastStepOf(ctx, t.id);
        lines.push(`· 「${clipText(t.title, 40)}」 [${taskStatusWord(t.status)}]${step ? ` ${step}` : ''}`);
      }
    } else {
      lines.push('进行中: （暂无进行中的任务）');
    }
    if (lastTerminal) {
      lines.push(`最近一条终态: 「${clipText(lastTerminal.title, 40)}」 [${taskStatusWord(lastTerminal.status)}] ${stampUtc(lastTerminal.t)}`);
    }
    await ctx.sendReply(toUser, lines.join('\n'));
  } catch (err) {
    // zx_20260929 M8-b（维特根斯坦·意义即使用 / 毛选·有据的话不许不说）：**用户话术与诊断详情分家**。
    //   原样把 `err.message` 拼进回执，用户读到的是 `SQLITE_ERROR: no such table: wa_tasks` 这类
    //   内部话——既解释不了"我该做什么"，又把栈上细节撒到一个不可控的对话框里。回执照旧**只说明
    //   「这件事没成、可稍后重试」**，真因入 `imLogger`（有据的话不许不说：**说给能看懂的人**）。
    imLogger.error({ error: (err as Error).message, channel: ctx.channelType }, '[IMRouter] 获取系统状态失败');
    await ctx.sendReply(toUser, '获取系统状态失败，请稍后重试。');
  }
}

// ====== 启动任务 ======

async function handleStartTask(ctx: ImContext, toUser: string, msgText: string): Promise<void> {
  let taskName = msgText.replace(START_REGEX, '').replace(/@\S+/g, '').trim();
  const quotedMatch = msgText.match(/[""「」]([^""「」]+)[""「」]/);
  if (quotedMatch) taskName = quotedMatch[1]!;

  try {
    if (taskName) {
      const task = ctx.db.prepare(
        "SELECT id, title, status FROM wa_tasks WHERE title LIKE ? AND status IN ('paused','failed') LIMIT 1"
      ).get(`%${taskName}%`) as { id: string; title: string; status: string } | undefined;
      if (task) {
        // A9: 防WeChat重投——30s内已启动过的任务跳过（**不再静默**，见文件头 M8-d）
        // ⚠ 窗口须 `datetime(updated_at)` 归一（见文件头「时刻列纪律」）：裸比较下**同 UTC 日的 ISO 行恒为真**
        //   ⇒ 一条今晨暂停的任务会被当成「刚启动过」而吞掉用户的启动指令。
        const recent = ctx.db.prepare("SELECT id FROM wa_tasks WHERE id = ? AND datetime(updated_at) > datetime('now', '-30 seconds')").get(task.id) as { id: string } | undefined;
        if (recent) {
          // zx_20260929 M8-d: 命中重投闸 ⇒ **留痕 + 回执**。重投是平台/客户端的行为，用户不该替它承受沉默
          //   ——"发了没反应"与"真的没收到"在用户眼里是同一件事，故这里必须说一句。
          imLogger.info({ taskId: task.id, title: task.title, channel: ctx.channelType }, '[IMRouter] 启动指令→任务30s内已启动，按重投跳过');
          await ctx.sendReply(toUser, `⏳ 「${task.title}」30 秒内已受理，本次未重复启动（若已在执行中请稍候）。`);
          return;
        }
        // zx_20260910_3 M2d-a: IM 启动指令＝人工介入 → 恢复并返还目标偏离额度
        resumeWithQuota(ctx.db, task.id);
        enqueueJob(ctx.db, 'ai-task', { taskId: task.id, source: 'im', channel: ctx.channelType, externalUser: toUser });
        await ctx.sendReply(toUser, `✅ 已启动任务「${task.title}」`);
        return;
      }
    }
    // zx_20260911_4 M1-5: 与 handleNumberSelection 同一份查询——展示的编号就是可选择的编号
    const pausedTasks = listResumableTasks(ctx.db, ctx.channelType, toUser);
    if (pausedTasks.length === 0) { await ctx.sendReply(toUser, '当前没有可启动的任务。请先创建任务。'); return; }
    if (pausedTasks.length === 1) {
      const t = pausedTasks[0]!;
      // A9: 防WeChat重投——30s内已启动过的任务跳过（**不再静默**，同上一处 M8-d）
      // ⚠ 同上一处：窗口须 `datetime(updated_at)` 归一，否则 ISO 行会把用户的启动指令吞掉。
      const recent = ctx.db.prepare("SELECT id FROM wa_tasks WHERE id = ? AND datetime(updated_at) > datetime('now', '-30 seconds')").get(t.id) as { id: string } | undefined;
      if (recent) {
        imLogger.info({ taskId: t.id, title: t.title, channel: ctx.channelType }, '[IMRouter] 启动指令→任务30s内已启动，按重投跳过');
        await ctx.sendReply(toUser, `⏳ 「${t.title}」30 秒内已受理，本次未重复启动（若已在执行中请稍候）。`);
        return;
      }
      // zx_20260910_3 M2d-a: IM 启动指令（唯一任务自动启动）＝人工介入 → 恢复并返还目标偏离额度
      resumeWithQuota(ctx.db, t.id);
      enqueueJob(ctx.db, 'ai-task', { taskId: t.id, source: 'im', channel: ctx.channelType, externalUser: toUser });
      await ctx.sendReply(toUser, `✅ 已自动启动「${t.title}」`);
      return;
    }
    const list = pausedTasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
    await ctx.sendReply(toUser, `找到 ${pausedTasks.length} 个可启动的任务，请回复编号：\n${list}`);
  } catch (err) {
    // zx_20260929 M8-b: 同「获取系统状态」——回执只用用户话术，真因入日志（理由见该处注释）。
    imLogger.error({ error: (err as Error).message, channel: ctx.channelType }, '[IMRouter] 启动任务失败');
    await ctx.sendReply(toUser, '启动任务失败，请稍后重试。');
  }
}

// ====== LLM 意图分类 ======

async function classifyIntentWithLLM(ctx: ImContext, msgText: string): Promise<'start_task' | 'query_status' | 'create_task' | null> {
  try {
    // zx_20260930 M9: 此前**零认证头** + 只读 env（桌面不加载 `.env`）⇒ 恒 401；且 401 不抛、
    //   `if (!resp.ok) return null` 又把它咽掉 ⇒ 用户侧只是"不分类"，日志里连一行都没有。
    //   现走签名出路：身份 DB→env→缺省（`resolveAnsCreds` 一处真源），失败带 status 留痕。
    const r = await ansSignedRequest(resolveAnsCreds(ctx.db), '/api/v1/models/optimal', {
      method: 'POST',
      body: { capabilities: ['chat'], strategy: 'cost-optimal' },
      timeoutMs: 5000,
    });
    if (!r.ok) {
      imLogger.warn({ detail: ansFailureNote(r) }, '[IMRouter] 取模型失败（ANS）— 意图分类放弃');
      return null;
    }
    const modelData = await r.response!.json() as { url?: string; api_key?: string; model_name?: string };
    if (!modelData.url || !modelData.api_key) return null;

    const classifyResp = await fetch(resolveChatCompletionsUrl(modelData.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${modelData.api_key}` },
      body: JSON.stringify({
        model: modelData.model_name || 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: '输出一个单词分类用户意图：start_task(启动/开始任务)、query_status(查询状态/进展)、create_task(创建新任务/完成工作)、general_chat(闲聊/问候)。规则：请求信息或完成工作→create_task；只问进度状态→query_status' },
          { role: 'user', content: msgText },
        ],
        max_tokens: 10,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!classifyResp.ok) return null;
    const classifyData = await classifyResp.json() as { choices?: Array<{ message?: { content?: string } }> };
    const intent = classifyData.choices?.[0]?.message?.content?.trim().toLowerCase() || '';
    if (intent.includes('start_task')) return 'start_task';
    if (intent.includes('query_status')) return 'query_status';
    if (intent.includes('create_task')) return 'create_task';
    return null;
  } catch (e) { imLogger.warn({ error: (e as Error)?.message }, '[IMRouter] 意图分类异常'); return null; }
}

// ====== 创建任务 ======

/** A8: 根据名称解析项目（精确匹配优先，模糊匹配多结果时返回null） */
function resolveProject(db: Database.Database, name: string): { id: string; name: string } | null | undefined {
  const exact = db.prepare("SELECT id, name FROM wa_projects WHERE status = 'active' AND name = ? LIMIT 1").get(name) as { id: string; name: string } | undefined;
  if (exact) return exact;
  const fuzzy = db.prepare("SELECT id, name FROM wa_projects WHERE status = 'active' AND name LIKE ? ORDER BY created_at DESC").all(`%${name}%`) as Array<{ id: string; name: string }>;
  if (fuzzy.length === 1) return fuzzy[0]!;
  if (fuzzy.length > 1) return null;
  return undefined;
}

// ====== 无 @ 时的项目认领（zx_20260924_1 M2 / 挂账 H-1）======

/** 认领依据的两种形态（第三态是"没有依据"——@项目名 / 新建项目，回执不附依据）。 */
export type ProjectClaimBasis = 'recent' | 'most-active';

export interface ProjectClaim {
  id: string;
  name: string;
  basis: ProjectClaimBasis;
}

/**
 * 无 `@项目名` 时，"这句话落在哪个项目"的判据（**导出供受控回归直跑真实现**）。
 *
 * 病根（方案 §1.2 F2 / 挂账 H-1）：原兜底只有一条 `ORDER BY COUNT(t.id) DESC LIMIT 1`
 * ——**谁任务多就归谁**，与发消息的人、与这句话的内容**都无关**。在任务最多的项目上
 * （真库实测 A股智能投资顾问 150 / 次高 32），几乎每条无 @ 的 IM 消息都被它吸走。
 * 而"这句话跟谁有关"的判别信号**本来就在场**：该用户上一笔 IM 任务写在哪个项目
 * （`wa_tasks.context_json` 的 `{source:'im', channel, externalUser}`，见本文件三处同族写点）。
 *
 * 判据次序（《孙子兵法》知彼知己：先认得出对象，再谈落点）：
 *  ① `basis:'recent'` —— 该用户在本渠道**最近一笔 IM 任务**所属的**活跃**项目；
 *  ② 退 `basis:'most-active'` —— 现状的那条"最大活跃项目"（无历史时的退路）；
 *  ③ 无任何活跃项目 → `null`（调用方沿用既有"新建『IM对话项目』"）。
 *
 * ⚠ **JSON 形状的手抄两遍**：谓词走 SQL 的 `json_extract`（与 `listResumableTasks` /
 *   `listApprovalCandidates` 同一把尺），并加 `json_valid` 守卫——脏 `context_json`
 *   只会让**本行**落选，不会让整条查询抛错（抛错会把所有行一起退到②，那是"静默降级"）。
 *   读取侧的 `JSON.parse`（本文件他处）仍各自兜底，两者不互为前提。
 *
 * ⚠ **性能**（方案 §M2 第 4 条要求实测）：`json_extract` 走不了索引，本查询是**全表扫**。
 *   实测真库（`data/worker-ant-server.db`，127MB / 195 任务 / 4 活跃项目）**10ms**——
 *   量级上可接受，故**不新增列/生成列/索引**（不新造数据模型）；若日后任务量级涨到十万，
 *   再按方案的"LIMIT + 现有索引扫最近 N 条再筛"退化。
 *
 * ⚠ **`wa_im_conversations.project_id` 不在此路**（用户裁定 J-2，挂账 H-2）：该列在
 *   schema 里存在（`database.ts` 建表语句），但 `src/main` **全仓零写点**（所有 INSERT 显式列名
 *   且不含它）⇒ **恒 NULL**。本函数**既不读也不写**它——**不要**把"最近一笔"改从这个列取
 *   （它永远是空的，改了等于把认领判据换成"恒无依据"）。
 */
export function resolveProjectForUser(
  db: Database.Database,
  opts: { externalUser: string; channelType: string },
): ProjectClaim | null {
  const { externalUser, channelType } = opts;
  // ① 该用户在本渠道最近一笔 IM 任务所属的活跃项目
  try {
    const recent = db.prepare(
      `SELECT p.id AS id, p.name AS name FROM wa_tasks t
         JOIN wa_projects p ON p.id = t.project_id
        WHERE p.status = 'active'
          AND json_valid(t.context_json)
          AND json_extract(t.context_json,'$.source') = 'im'
          AND json_extract(t.context_json,'$.externalUser') = ?
          AND json_extract(t.context_json,'$.channel') = ?
        ORDER BY datetime(t.created_at) DESC, t.rowid DESC LIMIT 1`
    ).get(externalUser, channelType) as { id: string; name: string } | undefined;
    if (recent) return { id: recent.id, name: recent.name, basis: 'recent' };
  } catch { /* 查询本身出错（如库被换过）⇒ 如实现状退到②，不冒充"无历史" */ }

  // ② 现状退路：最大活跃项目（SQL 一字未改，只搬了家）
  try {
    const activeProj = db.prepare(
      "SELECT p.id, p.name FROM wa_projects p LEFT JOIN wa_tasks t ON t.project_id = p.id WHERE p.status = 'active' GROUP BY p.id ORDER BY COUNT(t.id) DESC LIMIT 1"
    ).get() as { id: string; name: string } | undefined;
    if (activeProj) return { id: activeProj.id, name: activeProj.name, basis: 'most-active' };
  } catch { /* 同①：读不到就是③ */ }

  return null;
}

/** 回执里那句"凭什么" —— **只在这两条依据上出现**（`null` = 无依据可言，不硬凑）。 */
export function projectBasisNote(basis: ProjectClaimBasis | null | undefined): string {
  if (basis === 'recent') return '（依据：你最近一笔 IM 任务所属项目）';
  if (basis === 'most-active') return '（依据：当前最活跃项目）';
  return '';
}

/** 提取 @项目名 和 引号内任务名 */
function extractMentions(msgText: string): { mentions: string[]; quoted: string[] } {
  const mentions: string[] = [];
  for (const m of msgText.matchAll(/@([^\s@，。,\.！!？?：:；;、]+)/g)) {
    const name = m[1]!.trim();
    if (name.length >= 1 && name.length <= 30) mentions.push(name);
  }
  const quoted = (msgText.match(/[""“”「『]([^""“”「『」』]+)[""“”」』]/g) || [])
    .map(q => q.replace(/[""“”「『」』]/g, '').trim())
    .filter(n => n.length > 1);
  return { mentions, quoted };
}

/**
 * zx_20260924_1 M3-b（J-7）：IM 建任务路「该不该自动拆解」的入口判据——**唯一实现**，供受控回归直跑。
 *
 * 两道闸缺一不可：
 *   ① 消息本身够大或命中关键词（V3 原有的入口条件，逐字照搬，未改口径）；
 *   ② 这个父任务**还没有在途子任务**（`alreadyDecomposed`，与引擎/计划路同一把尺）。
 *      改前只有 ① ⇒ 同一个父任务重入本路会二次建子（"防重复拆解"三路各写各的，IM 路干脆没有）。
 *
 * ⚠ ②数的是**在途**：子任务都做完之后再拆仍合法（那时确实还有活要干），不是"拆过一次就永久禁止"。
 */
export function shouldAutoDecomposeIm(db: Database.Database, parentTaskId: string, msgText: string): boolean {
  const bigEnough = msgText.length >= 100 || /(搭建|构建|创建系统|迁移|重构|开发一个|实现一个|做一个完整的)/.test(msgText);
  return bigEnough && !alreadyDecomposed(db as never, parentTaskId);
}

async function handleCreateTask(ctx: ImContext, toUser: string, msgText: string, inboundId?: string): Promise<void> {
  try {
    // M5 实机复核修: 标题/描述清洗——去除 @项目名 + 可选"创建任务/新建任务"命令脚手架与冒号,
    // 不再残留 "任务:" 前缀/把整条命令当描述(用户实测标题="任务:复核Y1摘要…"、描述=整条含@的命令)。
    const cleaned = msgText
      .replace(/@[^\s@，。,\.！!？?：:；;、]+/g, '')
      .replace(/^(创建|新建|做一个|帮我|帮我做|做)\s*(任务)?\s*[:：]?\s*/i, '')
      .trim();
    // M5 复核修(用户选定·首句拆标题): 标题=正文首句(首个空格/句读前), 描述=余下正文——避免标题=描述=整句(长段不可读/重复)
    let title = cleaned;
    let desc = '';
    const firstBoundary = cleaned.search(/[\s，,。．.！!？?；;、:：]/);
    if (firstBoundary > 0) { title = cleaned.slice(0, firstBoundary).trim(); desc = cleaned.slice(firstBoundary).trim(); }
    title = title.slice(0, 50);
    if (!title) { await ctx.sendReply(toUser, '请输入任务内容。'); return; }

    // A8/A10: @项目名解析 + isCreateProject（@不存在的项目名则创建新项目）
    const { mentions } = extractMentions(msgText);
    const mentionName = mentions[0] ?? '';
    let projectId: string | undefined;
    let projectName = '';
    /** zx_20261005 M7: 「为什么没按你的 @ 建新项目」的如实说明（并入最终回话，不静默改落点）。 */
    let quotaNote = '';
    if (mentionName) {
      const matched = resolveProject(ctx.db, mentionName);
      if (matched) {
        projectId = matched.id; projectName = matched.name;
      } else if (matched === undefined) {
        // isCreateProject：@的项目名不存在 → 创建新项目
        // zx_20261005 M7: 档位项目数配额——达上限则**不再新建**，改落到最近的项目并如实说明
        //   （软闸方向：任务不丢、IM 不断；被锁的只是"@X 新建"这一条）。
        const refusal = projectQuotaRefusal(ctx.db);
        const fallback = refusal
          ? (ctx.db.prepare("SELECT id, name FROM wa_projects WHERE status = 'active' ORDER BY created_at DESC LIMIT 1").get() as { id: string; name: string } | undefined)
          : undefined;
        if (refusal && fallback) {
          projectId = fallback.id; projectName = fallback.name;
          quotaNote = `（未新建「${mentionName}」：${refusal}本条落在项目「${fallback.name}」）`;
        } else {
          projectId = crypto.randomUUID();
          ctx.db.prepare("INSERT INTO wa_projects (id, name, description, status, owner_id) VALUES (?, ?, ?, 'active', ?)").run(projectId, mentionName, `通过IM创建的项目（@${mentionName}）`, resolveProjectOwnerId(ctx.db));
          projectName = mentionName;
        }
      } else {
        // 模糊匹配有多个结果 → 让用户选择（A7: 暂存候选列表供编号回复）
        const fuzzy = ctx.db.prepare("SELECT id, name FROM wa_projects WHERE status = 'active' AND name LIKE ? ORDER BY created_at DESC").all(`%${mentionName}%`) as Array<{ id: string; name: string }>;
        pendingProjectSelections.set(`${ctx.channelType}:${toUser}`, { projects: fuzzy, taskText: msgText, expiresAt: Date.now() + 5 * 60_000 });
        const list = fuzzy.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
        await ctx.sendReply(toUser, `"@${mentionName}" 匹配到多个项目：\n${list}\n\n请回复编号选择目标项目。`);
        return;
      }
    }

    // zx_20260924_1 M2（《孙子兵法》知彼知己 / 《周易》言行枢机）: 无 @ 时的认领改由
    //   `resolveProjectForUser` 定，并**把依据带回给用户**（"说了落在哪，也要说凭什么"）。
    //   本项目来自 @项目名 时 `basis` 为 null（依据就是那句话里的 @，不必再附一句）。
    let basis: ProjectClaimBasis | null = null;
    if (!projectId) {
      const claim = resolveProjectForUser(ctx.db, { externalUser: toUser, channelType: ctx.channelType });
      if (claim) { projectId = claim.id; projectName = claim.name; basis = claim.basis; }
      else {
        // zx_20261005 M7: 同上一处——达档位上限则不建「IM对话项目」，落到最近的项目并如实说明。
        const refusal = projectQuotaRefusal(ctx.db);
        const fallback = refusal
          ? (ctx.db.prepare("SELECT id, name FROM wa_projects WHERE status = 'active' ORDER BY created_at DESC LIMIT 1").get() as { id: string; name: string } | undefined)
          : undefined;
        if (refusal && fallback) {
          projectId = fallback.id; projectName = fallback.name;
          quotaNote = `（未新建「IM对话项目」：${refusal}本条落在项目「${fallback.name}」）`;
        } else {
          projectId = crypto.randomUUID();
          ctx.db.prepare("INSERT INTO wa_projects (id, name, description, status, owner_id) VALUES (?, ?, ?, 'active', ?)").run(projectId, 'IM对话项目', '通过IM自动创建的项目', resolveProjectOwnerId(ctx.db));
          projectName = 'IM对话项目';
        }
      }
    }
    const basisNote = projectBasisNote(basis);

    const taskId = crypto.randomUUID();
    const isShortMessage = msgText.length <= 10;
    const status = isShortMessage ? 'paused' : 'pending';

    const taskCtx: Record<string, unknown> = { source: 'im', channel: ctx.channelType, externalUser: toUser };
    ctx.db.prepare(
      'INSERT INTO wa_tasks (id, project_id, title, description, priority, status, context_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(taskId, projectId, title, desc, 1, status, JSON.stringify(taskCtx));

    // zx_20260921 M1 / zx_20260924 §2e: **把刚收到的那一件挂上来**（"先发图、再说话"）。
    //   位置刻意压到 INSERT **之后**：取件是**取即消费**的，放在任何一条早退（@项目名对不上、编号选择）之前，
    //   一次追问就会把用户的件吃掉；INSERT 之后是第一条"这件事已经决定了"的位置。
    //   两条路（建任务 / 回复既有任务）共用同一个出口 `attachPendingMediaToTask`——用户 2026-09-24 裁定
    //   「件挂到本条文字最终落到的那张任务上」，故取件不该只认得建任务这一条路。
    const pendingMedia = attachPendingMediaToTask(ctx.db, {
      channelId: ctx.channelId, externalUser: toUser, channelType: ctx.channelType, taskId,
      ...(inboundId ? { beforeId: inboundId } : {}),
    });
    if (pendingMedia) console.log(`[IMRouter] 附件已挂到新任务: task=${taskId.slice(0, 8)} file=${pendingMedia.fileName ?? pendingMedia.path}`);

    // V3: 天下大事必作于细——大任务自动拆解（长消息或含搭建/构建/迁移等关键词）
    // zx_20260924_1 M3-b（J-7）：入口判据收成 `shouldAutoDecomposeIm` 一处——**补上了此前缺的那一层**
    //   「这个父任务是不是已经有在途子任务」（`alreadyDecomposed`，全仓唯一实现，判据 = 在途子数 > 0）。
    //   旧写法只有消息尺寸/关键词一道闸 ⇒ 重入本路即会二次建子；引擎路当时另有一句同样意思的判据
    //   （"防重复拆解"曾分家两处各说各话），现两路同问一处实现。
    if (status === 'pending' && shouldAutoDecomposeIm(ctx.db, taskId, msgText)) {
      try {
        // A2 (2026-08-31): 读历史拆解模式（王阳明事上磨练——参考历史成功拆解），传入 decomposeTask
        // zx_20261002 M6（「同一件事，才叫重复」）：取法/拼串改取**一处真源** `loadDecompositionPatterns`
        //   ——此前只有本路会读它，引擎路每次冷启动、同一项目里两路拆出来的粒度不一致。
        const decompositionPatterns = loadDecompositionPatterns(ctx.db, projectId);
        // zx_20260930 M9: 身份**现取**（DB `wa_settings` → env → 缺省，一处真源 `resolveAnsCreds`）——
        //   此前本路只读 `process.env`，而桌面 main **不加载 `.env`** ⇒ 拿不到 secret、请求恒 401。
        const template = await decomposeTask(msgText, { deps: makeEnvDecomposeDeps(resolveAnsCreds(ctx.db)), patterns: decompositionPatterns });
        if (template.length >= 2) {
          // zx_20260929 M5-c（维特根斯坦·意义即用法）：「模板 → `wa_tasks` 行」**归一处**。
          //   此前本文件自带**第二份**落行实现（广度闸 / 序号→id 映射 / priority 换算 / `depth: 1` 硬编码，
          //   逐行抄自 `task-decompose.ts`）——同一件事两处各说各话，唯一实现里改了这里不跟就是"名实不符"
          //   的温床（本仓 G-1：不新造第二份实现）。
          //   落行三件守卫（深度闸 `MAX_TASK_DEPTH` / 广度闸 `childBreadthRefusal` / 自环过滤
          //   `resolveIndexDeps(..., selfId)`）现全部由那**一份**承担；`depth: 0` ⇒ 子任务深度 = 1（旧硬编码值）。
          //   ⚠ 父任务的状态与拆解标记仍由本路自己写（见下），「不重写状态」这一既有约束不变。
          const { created, planned, noDepCount } = planSubtasksFromTemplate(ctx.db, {
            parentTaskId: taskId, projectId, template, depth: 0, source: 'auto-decompose',
            contextExtra: { source: 'im', channel: ctx.channelType, externalUser: toUser },
          });
          // zx_20260913 M3-1: 父**留在** `pending`——原写 `planning`，而 planning 只由 30 分钟超时收割转 paused
          // ⇒ 父永不动工。父由上面的 INSERT 已落 `pending`（本分支仅 `status === 'pending'` 时进入），故此处
          // 只补拆解标记，**不重写状态**：同值写无意义，且 IM 侧「恢复必返还额度」的既有约束要求
          // 一切 `status = 'pending'` 写点都走 resumeWithQuota（本处非恢复，亦不该冒充）。
          ctx.db.prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.auto_decomposed', json('true')), updated_at = datetime('now') WHERE id = ?").run(taskId);
          const childList = template.slice(0, created).map((t, i) => `${i + 1}. ${t.title}`).join('\n');
          // zx_20261013_2 批三: 没拆满时**明说**——那句话由 `shortfallNotice` 一处产出（与引擎路同源，
          //   不在此另写一份）；此前这里只落"其余未建"= **死路**，没说还能怎么补。
          const shortfall = shortfallNotice(planned, created);
          ctx.db.prepare('INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?, ?, ?, ?)').run(
            crypto.randomUUID(), taskId, 'system',
            `[智能拆解] 任务较大，已自动拆分为${created}个子任务（状态 pending；无前置者可立即执行，有前置者待前置完成后自动启动）：\n${childList}`
            + (shortfall ? `\n（未建满：${shortfall}）` : ''),
          );
          // zx_20260916_3 M1: 报数取**真实建出数**（created），截断时如实说明。
          const truncated = shortfall ? `（未建满：${shortfall}）` : '';
          await ctx.sendReply(toUser, `✅ 已创建任务「${title}」并自动拆解为${created}个子任务（项目: ${projectName}）${basisNote}${quotaNote}${truncated}。子任务已置为待执行：其中 ${noDepCount} 个无前置可立即动工，其余待前置完成后自动启动。`);
          return;
        }
      } catch { /* 拆解失败则按普通任务执行 */ }
    }

    if (status === 'pending') {
      enqueueJob(ctx.db, 'ai-task', { taskId, projectId, source: 'im', channel: ctx.channelType, externalUser: toUser });
      await ctx.sendReply(toUser, `✅ 已创建任务「${title}」并自动执行（项目: ${projectName}）${basisNote}${quotaNote}`);
    } else {
      await ctx.sendReply(toUser, `📝 已创建任务「${title}」（项目: ${projectName}）${basisNote}${quotaNote}。输入「开始」启动执行。`);
    }
  } catch (err) {
    // zx_20260929 M8-b: 同「获取系统状态」——回执只用用户话术，真因入日志（理由见该处注释）。
    imLogger.error({ error: (err as Error).message, channel: ctx.channelType }, '[IMRouter] 创建任务失败');
    await ctx.sendReply(toUser, '创建任务失败，请稍后重试。');
  }
}
