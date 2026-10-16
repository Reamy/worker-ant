import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { ProjectEngine, TaskManager, deleteProjectCascade, removeProjectDataDir, resolveProjectOwnerId } from '../core/project-engine.js';
import { interruptTask, assessCompletionQuality } from '../core/agent-executor.js';
// zx_20260917 M5-1: 四个作业谓词已迁 `core/task-jobs.ts`（`task-chain` 也要用，留在 scheduler 会互引成环）
import { cleanupTaskExecutionJobs, hasPendingExecutionJob, isTerminalTask, supersedeExecutionJobs } from '../core/task-jobs.js';
import { eventBus } from '../core/event-bus.js';
import { isDuplicatePauseResponse, settlePause, grantGoalDeviationQuota } from '../core/pause-settlement.js';
// zx_20260917 M1: 「置暂停」的唯一写入口——状态/因/事件一次写全（本文件两处暂停点均经它）
import { PAUSE_REASON_USER_INTERRUPT } from '../core/pause-reason.js';
import { pauseTask } from '../core/pause-task.js';
import { setDeliverableStatus, retireTaskDeliverables, countDeliverables, countDeliverablesByType, deliverableScopeSql, applyPrimary, emitDeliverableEvent, loadDeliverableRow, otherWriters, isAcceptanceType, annotateAcceptance, verifiedAcceptanceMap, markDeliverableAcceptanceVerified, findDeliverableByPath, createDeliverable, type AcceptanceMeta } from '../core/deliverable-lifecycle.js';
// zx_20260914 M2-2: 内联图片的白名单与上限取**真源**（零依赖模块，rr 断言读同一份）
// zx_20260914 M2-2: 图片预览的判定/读取抽在 core（纯函数 + 注入 io），handler 只取行、转壳
import { resolveImagePreview } from '../core/image-preview.js';
import { resolvePage } from '../core/pagination.js';
// zx_20260914 M2-3③: 验收判据本身已不必在此 import——三个读点的**解析**整体收敛到
//   `core/deliverable-lifecycle`（`verifiedAcceptanceMap` 是 `isAcceptanceVerified` 的唯一消费处），
//   本文件只用它的派生结果。判据不变，只是不再需要自己判。
import { resolveAncestorSchemeRef, collectSubtreeIds, childBreadthRefusal, decomposePriority, projectScanVerdict, PROJECT_PARKED_STATUSES, carryRetryContext } from '../core/task-accounting.js';
// zx_20260915 P0-3 A′: 完成事件带的「果」取**同一构造器**（与 agent-executor 两处 emit 同源同形）
import { buildTaskOutcome } from '../core/task-outcome.js';
// zx_20260920_1 M3（面一）: 人工「标记完成」的收口清算——**一处真源**（清陈旧暂停键 / 保住判卷结论只换署名 /
//   顶层与账内同值 / doc 随之落定）。此前本文件把这段内联在此，并因一条 `if (!existing?.score)` 的总闸
//   对"已有账"（这条路上最常见）**整段跳过**。`buildCompletionAccount`/`goalAchievedOf` 亦随之移出本文件
//   ——它们的调用点已收进 `finalizeTaskByHuman`（同一个构造器，不是第二份写法）。
import { finalizeTaskByHuman } from '../core/finalize-by-human.js';
// zx_20261011_4 M4: 子任务行的"已外派"投影取 core **一处真源**（`remoteTaskView`）——
//   面板上屏的"外派给谁/回传了什么"与驱动收口写的键**同源**，不在此手抄键名。
import { remoteTaskView } from '../core/node-orchestrate.js';
// zx_20260921 M7（D4 断点①）: GUI 置子任务终态后**放行父**——复用引擎那四处**同一个**判定（不写第二把尺）。
//   ⚠ 实现**不内联在本文件**：本文件顶层 import electron，node（受控回归）里 import 不进来 ⇒
//     内联的薄函数 rr 够不着，只能靠"复刻一份等价物"来测（那正是自我印证）。故抽到 core，两边引同一份。
import { afterTaskTerminalStatus } from '../core/task-terminal-release.js';
// zx_20261012_2 批二: 「归档（放弃）」的**唯一写手**——GUI 的 `task:archive` 与 `task:updateStatus('archived')` 同一实现。
import { archiveTask } from '../core/task-archive.js';
// zx_20261013_1 批二(K7·GUI 挂件): 本地选文件→落盘→并进任务上下文。落盘/形状/写者**全复用 IM 那一条链**
//   （`importLocalAttachments` 内引 `saveInboundMedia` + `attachmentEntry`），本文件只接一条 IPC 出口。
import { importLocalAttachments } from '../services/task-attachments.js';
import { appendTaskAttachments } from '../services/pending-media.js';
import { analyzeBlockers, detectMilestones, projectQualityStats } from '../core/project-analytics.js';
import { getTensions, updateTension, TENSION_CONFIGS } from '../core/tension-engine.js';
import { decideTemplateMatch, matchTemplateSemantic, getTemplateEmbeddings, loadTemplatePool, invalidateTemplateEmbedding, describeAutoTemplateGates } from '../core/task-templates.js';
// zx_20261002 M11（康德·概念无直观则空）: 项目调用记账——同批次另两处真调用（MCP 在 tools/resource.ts）共用一处真源。
import { recordServiceCall, describeServiceCalls } from '../core/service-call-ledger.js';
// zx_20261003 M4（柏拉图·洞穴喻）: 项目"运行面"聚合——守护/作业两个环节补进知识全景（只读）。
import { describeProjectRuntime } from '../core/project-runtime-summary.js';
import { introducesCycle, parseDepIds, resolveIndexDeps } from '../core/dep-graph.js';
// zx_20261005 M7（管子·度量衡 / 康德·诚实的量级天花板）: 项目数配额——无许可/试用过期 ⇒ 社区版上限。
//   判据**不在此内联**：`wa_projects` 四条写入落点共用 `core/project-quota.ts` 一处（含 IM 两条），
//   免得"改口径漏一处"。**不删既有项目、不阻执行**，只是不再新建（K-3 软闸方向）。
import { projectQuotaRefusal } from '../core/project-quota.js';
import { createLogger } from '../core/logger.js';
import { boolSetting } from '../core/settings-bool.js';
// zx_20260930 M8: 随项目/任务删除的级联落墓碑（缘由词表与写入语句形状同出该模块）。
import { MEM_DELETE_REASONS, tombstoneMemoriesBy, MEM_LIVE_SQL } from '../core/memory-lifecycle.js';
import { resolveAnsCreds, ansSignedRequest, ansFailureNote, type AnsRequestResult } from '../core/ans-signed-request.js';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';
// zx_20261004 M15（K-8 轻得下）: 守护进程监督整段已迁 `core/daemon-supervisor.ts`（逐字节行为不变）。
//   本文件仍持 MCP/服务型成果自身的 spawn/exit handler（读/写同一 `runtimeProcesses`）与两处入口
//   （`initDaemonSupervisor` 注入库 / `startDaemonHealthCheck` 起心跳）。
import { runtimeProcesses, handleDaemonExit, killOrphan, autoStartDaemons, adoptMCPOrphans, initDaemonSupervisor, startDaemonHealthCheck } from '../core/daemon-supervisor.js';
// 退出路径的清账函数仍从**本模块**导出（`index.ts` 调用面不变）；实现单一真源在 `daemon-supervisor.ts`。
export { stopAllRuntimeProcesses } from '../core/daemon-supervisor.js';

const logger = createLogger('project-ipc');


// cron 重新注册回调（由 index.ts 在 scheduler 创建后注入）
let _cronRegistrar: ((projectId: string) => void) | null = null;
export function setCronRegistrar(fn: (projectId: string) => void): void { _cronRegistrar = fn; }

// zx_20260907 M5 修(2026-09-08): GUI「执行」(task:updateStatus→'running') 的即时派发回调，由 index.ts 建好
// scheduler 后注入(先例同 _cronRegistrar)。此前该分支仅裸插 DB 作业、运行期调度器不消费，只能等重启恢复——
// 造成任务长期"运行中"却从未真正执行。enqueue 会同时写 DB + 入内存队列，1s 内即被消费。
type TaskRunEnqueuer = (taskId: string, projectId: string) => Promise<string> | void;
let _taskRunEnqueuer: TaskRunEnqueuer | null = null;
export function setTaskRunEnqueuer(fn: TaskRunEnqueuer): void { _taskRunEnqueuer = fn; }

// zx_20260908 实机复核修: resume/respond/inject 恢复作业同 fa1cd34 家族——运行时仅裸插 DB 作业、内存队列不消费，
// 恢复永不执行（DB 状态被置 executing 但无 worker 干活、作业永 pending，UI 见"已暂停/不执行"）。
// 引入 resume-ai-task enqueuer 由 index.ts 注入 scheduler.enqueue（写 DB+入内存队列，~1s 执行）。
// zx_20260915 P0-5(c): 载荷改由本文件构造后**整体**交给注入方——`initiator:'user'` 因此只有一份，
// 两条出口（注入的 scheduler.enqueue 与未注入时的裸插回退）不可能各写一份而分家。
// 为什么键名不是 `source`：`source` 在本仓作业载荷里**已经是"哪个渠道/触发器"**（`'im'`/`'cron'`，
//   由 ai-task 处理器 :307 消费，且 im-router :398 早已在 resume-ai-task 上用过 `source:'im'`）。
//   同键三义会让"IM 编号启动"被读成"系统自恢复"，故 P0-5 另起 `initiator`（缺省即 `'system'`）。
type TaskResumeEnqueuer = (payload: Record<string, unknown>) => Promise<string> | void;
let _resumeEnqueuer: TaskResumeEnqueuer | null = null;
export function setResumeEnqueuer(fn: TaskResumeEnqueuer): void { _resumeEnqueuer = fn; }
/** 恢复作业入队：优先走 scheduler.enqueue（即时执行）；未注入时回退原裸插 DB（等重启恢复，保兼容）。 */
function enqueueResumeJob(db: Database.Database, taskId: string, projectId: string, message?: string): void {
  // 本函数**只被 GUI 用户路径调用**（task:resume / task:respond / task:inject），故一律标 `'user'`。
  const payload = { taskId, projectId, message, initiator: 'user' };
  if (_resumeEnqueuer) { void _resumeEnqueuer(payload); return; }
  db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES (?, 'resume-ai-task', ?, 'pending')").run(
    crypto.randomUUID(), JSON.stringify(payload),
  );
}

/**
 * zx_20260924_1 M5-b(维特根斯坦·语言游戏 / 一处真源): 产出物**盘上真实字节数**——列表"大小"列的唯一取数者。
 *
 * 为什么必须在 main 侧算：`wa_deliverables` **没有 size 列**（DB 里的 size 只存在于
 * `wa_deliverable_versions.size`，且那是**字符数**，见 database.ts 该列的 DDL 注记），renderer 又没有 fs。
 * 故只能按 `file_path` 现场 stat。**失败一律 `null`（界面 `—`），绝不抛**——
 * 一个件的路径失效不该把整页列表打红；"不知道大小"与"大小为零"是两回事，故不返回 0。
 */
function statSizeBytes(filePath: unknown): number | null {
  const p = typeof filePath === 'string' ? filePath.trim() : '';
  if (!p) return null;
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : null;
  } catch { return null; }
}


// zx_20261012_3 批一: 收 `dataDir`（与 `initImIpc(db, dataDir, …)` / `initSetupIpc(db, dataDir)` **同形**）——
//   `project:delete` 要清 `data/projects/<id>/`、"删项目弹窗"要如实给出该路径，二者都需要它。
//   此前本文件拿不到数据目录（清盘之事无从谈起）。
export function initProjectIpc(db: Database.Database, dataDir: string, memoryGetter?: () => import('../core/memory-manager.js').MemoryManager | undefined): void {
  initDaemonSupervisor(db);
  const projects = new ProjectEngine(db);
  const tasks = new TaskManager(db);
  // B1: 启动即加载 DB 模板池（含用户自定义 active 模板）
  loadTemplatePool(db);

  // ===== 项目 CRUD =====
  ipcMain.handle('project:list', async () => {
    try {
      const data = projects.list();
      return { data };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('project:get', async (_event, { id }: { id: string }) => {
    try {
      const data = projects.getById(id);
      if (!data) return { error: { code: 'NOT_FOUND', message: '项目不存在' } };
      return { data };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('project:create', async (_event, body: {
    name: string; description?: string; cron_schedule?: string;
    cron_timezone?: string; working_dir?: string;
    cron_create_task?: { title?: string; description?: string };
    cron_run_command?: string;
    autonomous_mode?: string; sandbox_mode?: string;
    budget?: { max_tokens_per_task?: number; max_cost_usd_per_task?: number };
    rhythm?: { activeHourStart?: number; activeHourEnd?: number; maxConcurrency?: number };
    backlog?: string[];
  }) => {
    try {
      // zx_20261005 M7: 档位项目数配额（判据 `core/project-quota.ts` 一处，与 clone / IM 两条共用）。
      const refusal = projectQuotaRefusal(db);
      if (refusal) return { error: { code: 'QUOTA_EXCEEDED', message: refusal } };
      // zx_20261012_1 缺陷修: owner 取 `resolveProjectOwnerId`（一处真源）——原 `admin?.id || 'default'`
      //   在无 super_admin 时写非存在用户 ⇒ `wa_projects.owner_id` 外键报错（与示例项目 `'sample'` 同形）。
      const { cron_create_task, cron_run_command, autonomous_mode, sandbox_mode, budget, rhythm, backlog, ...base } = body;
      const result = projects.create({ ...base, owner_id: resolveProjectOwnerId(db) });
      if (!result) return { error: { code: 'INTERNAL', message: '项目创建失败' } };
      const pid = result.id as string;
      // autonomous_mode/sandbox_mode 是列（对齐 project:update/clone，非 context_json）
      if (autonomous_mode !== undefined) db.prepare('UPDATE wa_projects SET autonomous_mode = ? WHERE id = ?').run(autonomous_mode, pid);
      if (sandbox_mode !== undefined) db.prepare('UPDATE wa_projects SET sandbox_mode = ? WHERE id = ?').run(sandbox_mode, pid);
      // context_json 扩展字段
      try {
        const ctx = JSON.parse((db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(pid) as { context_json: string })?.context_json || '{}');
        if (cron_create_task) ctx.cron_create_task = cron_create_task;
        if (cron_run_command) ctx.cron_run_command = cron_run_command;
        if (budget) ctx.budget = budget;
        if (rhythm) ctx.rhythm = rhythm;
        if (backlog && backlog.length > 0) ctx.backlog = backlog;
        db.prepare('UPDATE wa_projects SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), pid);
      } catch {}
      return { data: result };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('project:update', async (_event, { id, body }: {
    id: string; body: {
      name?: string; description?: string; cron_schedule?: string; working_dir?: string;
      cron_timezone?: string; autonomous_mode?: string; sandbox_mode?: string;
      budget?: { max_tokens_per_task?: number; max_cost_usd_per_task?: number };
      rhythm?: { activeHourStart?: number; activeHourEnd?: number; maxConcurrency?: number };
      cron_create_task?: { title?: string; description?: string };
      cron_run_command?: string;
      backlog?: string[];
    }
  }) => {
    try {
      const existing = projects.getById(id);
      if (!existing) return { error: { code: 'NOT_FOUND', message: '项目不存在' } };

      // 基础字段直接更新（含 cron_timezone/autonomous_mode/sandbox_mode）
      const baseFields = ['name', 'description', 'cron_schedule', 'cron_timezone', 'working_dir', 'autonomous_mode', 'sandbox_mode'] as const;
      for (const key of baseFields) {
        if (body[key] !== undefined) {
          db.prepare(`UPDATE wa_projects SET ${key} = ?, updated_at = datetime('now') WHERE id = ?`).run(body[key], id);
        }
      }

      // cron_schedule/cron_timezone 修改后重新注册 cron 作业
      if ((body.cron_schedule !== undefined || body.cron_timezone !== undefined) && _cronRegistrar) {
        try { _cronRegistrar(id); } catch {}
      }

      // context_json 合并：budget + rhythm + cron_create_task + cron_run_command + backlog
      if (body.budget || body.rhythm || body.cron_create_task !== undefined || body.cron_run_command !== undefined || body.backlog !== undefined) {
        const row = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(id) as { context_json: string } | undefined;
        const ctx = JSON.parse(row?.context_json || '{}');
        if (body.budget) ctx.budget = { ...(ctx.budget || {}), ...body.budget };
        if (body.rhythm) ctx.rhythm = { ...(ctx.rhythm || {}), ...body.rhythm };
        if (body.cron_create_task !== undefined) {
          if (body.cron_create_task) ctx.cron_create_task = body.cron_create_task;
          else delete ctx.cron_create_task;
        }
        if (body.cron_run_command !== undefined) {
          if (body.cron_run_command) ctx.cron_run_command = body.cron_run_command;
          else delete ctx.cron_run_command;
        }
        if (body.backlog !== undefined) {
          if (body.backlog && body.backlog.length > 0) ctx.backlog = body.backlog;
          else delete ctx.backlog;
        }
        db.prepare("UPDATE wa_projects SET context_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(ctx), id);
      }

      const data = projects.getById(id);
      return { data };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // zx_20261012_3 批一: 删项目**同时清盘**（`data/projects/<id>/`）——但**由用户勾选**决定（默认勾选）。
  //   `removeDataDir !== false` ⇒ 未传即清（老调用方 `{ id }` 走到这里 = 清，与"删得清"同向）；
  //   显式传 `false` 才保留（用户在弹窗里取消勾选）。清的那一路**只**由 `removeProjectDataDir` 拼出
  //   （`dataDir` + `projects` + `id`），**绝不**按 `working_dir` 删——后者可指向用户代码仓。
  ipcMain.handle('project:delete', async (_event, { id, removeDataDir }: { id: string; removeDataDir?: boolean }) => {
    try {
      // zx_20261012_1 批四: 级联 SQL 收为**一处真源**（`deleteProjectCascade`，`core/project-engine.ts`）——
      //   与示例项目删除（`sample:remove`）走同一份，防两条删除路各写一份 SQL、第二条迟早漏清子表。
      //   2026-09-04_2/2026-09-07 的历史修法（清通知、清 FK 子表 `wa_deliverable_versions`/`wa_knowledge_triples`、
      //   开事务、随删落记忆墓碑）**逐字保留**在 `deleteProjectCascade` 内。
      deleteProjectCascade(db, id);

      // 先删库（事务）再清盘：清盘**幂等**、**失败不阻断**（库已净，盘上残留只是观感，不该让删除失败）。
      let dataDirRemoved = false;
      if (removeDataDir !== false) {
        const r = removeProjectDataDir(dataDir, id);
        dataDirRemoved = r.ok;
        if (!r.ok) logger.warn(`[project:delete] 清盘未成（不阻断）：${r.dir} —— ${r.reason}`);
      }
      return { data: { id, deleted: true, dataDirRemoved } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // zx_20261012_3 批一: 删项目弹窗要把"将清哪个盘"如实告诉用户 ⇒ 由 main 给**真实路径**（不在渲染层手拼，
  //   因为 dev 是仓库根 `data/`、生产是 `userData`，渲染层拼不出来）。只读，暴露 `projects` 根。
  ipcMain.handle('project:projectsDir', async () => {
    try {
      return { data: { projectsDir: path.join(dataDir, 'projects') } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('project:updateStatus', async (_event, { id, status }: { id: string; status: string }) => {
    try {
      const result = projects.transitionStatus(id, status);
      eventBus.emit('project.status_changed', { projectId: id, newStatus: status, new_status: status }).catch(() => {});
      // 项目状态变化 → 重新注册 cron（registerProjectCron 内部处理 active/非 active）
      if (_cronRegistrar) {
        try { _cronRegistrar(id); } catch {}
      }
      return { data: result };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // ===== 任务 CRUD =====
  ipcMain.handle('task:list', async (_event, { projectId }: { projectId: string }) => {
    try {
      // zx_20260908 M2(B2a): 任务列表补成果摘要派生列——deliverable_count/primary_count(非 retired) + 验收 p/t(json_extract)，
      // 供 TasksPage 已完成任务行显示"此任务交付了什么"(列表层成果可见；纯派生不改判)。
      const rows = db.prepare(`SELECT t.*,
        json_extract(t.context_json, '$.acceptance_check.criteria_total') AS acc_total,
        json_extract(t.context_json, '$.acceptance_check.passed_total') AS acc_passed
        FROM wa_tasks t WHERE t.project_id = ? ORDER BY t.priority DESC, t.created_at DESC`).all(projectId) as Array<Record<string, unknown>>;
      // zx_20260913 M2-1(管子·度量衡·同一把尺): 计数改**子树口径**——此前只数本任务 ⇒ 列表说"0 项"、
      // 详情说"N 项"(同一事实两个说法)。一次 GROUP BY 取本项目各任务计数(**同尺套 docNotProbe**，
      // 此前列表不滤探针、详情滤 ⇒ 又是一处两说法)，再沿 parent_task_id 上卷(带环防护)。
      // zx_20260930 M4-1: 范围声明走共享真源（此处范围=「这批任务、排除退休与探针」）；
      //   `SUM(is_primary)` 是本读点特有的附加列，不属于"算不算一条成果"的判据，故留在本地。
      const taskIds = rows.map((r) => String(r.id));
      const ownCnt = new Map<string, { n: number; p: number }>();
      if (taskIds.length > 0) {
        const gScope = deliverableScopeSql({ taskIds, alias: 'd' });
        const grouped = db.prepare(`SELECT d.task_id AS tid, COUNT(*) AS n, SUM(CASE WHEN d.is_primary = 1 THEN 1 ELSE 0 END) AS p
          FROM wa_deliverables d WHERE ${gScope.sql} GROUP BY d.task_id`).all(...gScope.params) as Array<{ tid: string | null; n: number; p: number }>;
        for (const g of grouped) if (g.tid) ownCnt.set(g.tid, { n: Number(g.n) || 0, p: Number(g.p) || 0 });
      }
      const childrenOf = new Map<string, string[]>();
      for (const r of rows) {
        const pid = String(r.parent_task_id || '');
        if (pid) { const arr = childrenOf.get(pid) || []; arr.push(String(r.id)); childrenOf.set(pid, arr); }
      }
      const subtreeCnt = (rootId: string): { n: number; p: number } => {
        const seen = new Set<string>([rootId]);
        const stack = [rootId];
        let n = 0; let p = 0;
        while (stack.length > 0) {
          const cur = stack.pop() as string;
          const o = ownCnt.get(cur); if (o) { n += o.n; p += o.p; }
          for (const c of childrenOf.get(cur) || []) if (!seen.has(c)) { seen.add(c); stack.push(c); }
        }
        return { n, p };
      };
      for (const r of rows) { const c = subtreeCnt(String(r.id)); r.deliverable_count = c.n; r.primary_count = c.p; }
      return { data: rows };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('task:get', async (_event, { id, convLimit, convOffset, delivLimit, delivOffset }: { id: string; convLimit?: number; convOffset?: number; delivLimit?: number; delivOffset?: number }) => {
    try {
      const task = db.prepare('SELECT * FROM wa_tasks WHERE id = ?').get(id);
      if (!task) return { error: { code: 'NOT_FOUND', message: '任务不存在' } };
      // zx_20260930 M4-2(管子·度量衡 / 奥卡姆·勿增实体): 对话与成果各自**真分页**。
      // 病根：真库 `wa_task_conversations` 2.6 万行，此前本处无条件全取 ⇒ 任务详情首屏把整条对话链
      // 读进内存。`total` 与明细分**两个口径一次说清**（"已加载 K / 共 M"），不靠"列表长度"冒充总数。
      // 冻结键名：`conv*` 管对话、`deliv*` 管成果（两组各自独立，一个页面两个列表各翻各的）。
      // 返回体**新增** `conversationsTotal`/`deliverablesTotal` 两个键；`conversations`/`deliverables`
      // 本身仍是**数组**（形状不变）——既有调用方按数组读的地方一处都不用改。
      const convPage = resolvePage(convLimit, convOffset);
      const conversations = db.prepare(`SELECT * FROM wa_task_conversations WHERE task_id = ? ORDER BY rowid ASC${convPage.sql}`).all(id, ...convPage.params);
      const conversationsTotal = (db.prepare('SELECT COUNT(*) AS c FROM wa_task_conversations WHERE task_id = ?').get(id) as { c: number }).c;
      // zx_20260906 批3 (3e): 重试后旧成果 soft-retired 不在此呈现（任务详情展示"当前"成果；已退休产物到产出物管理页查）
      // zx_20260911_4 M4-3(管子·度量衡): 补探针滤除——此前本处是全仓唯一漏网(同谓词已在 project-engine:107 /
      // ai-task:69 / 本文件 1390/1767/1797/1802 收敛)，任务详情会比别处多出临时探针 doc(E12)。
      // zx_20260913 M2-1(佛学·缘起 / 赫布·共激): 成果不在自身成立，须在**任务树**中成立——此前 `task_id = ?`
      // 只取本任务 ⇒ 编排型父任务看不到子代理产出。改按**子树聚合**(复用 collectSubtreeIds)，并逐条带回
      // owner_task_id/owner_task_title 供界面标注「来自子任务 X」(赫布·同时激活即在归属上联结)。
      // zx_20260930 M4-1: 范围声明走共享真源（范围=「本任务+子树、排除退休与探针」）。
      const subtree = collectSubtreeIds(db, id);
      const ownerIds = [id, ...subtree];
      const dScope = deliverableScopeSql({ taskIds: ownerIds, alias: 'd' });
      // zx_20260930 M4-2: 成果侧同上一处分页。`total` 走**取数范围真源**（`countDeliverables`，
      //   与下方明细**同一把尺**：同 taskIds、同排除退休与探针）——故"共 M 条"与明细逐条对得上；
      //   不在此手写第二份 COUNT（那正是 M4-1 收掉的东西）。次序补 `d.rowid DESC` 兜同秒行的次序。
      const delivPage = resolvePage(delivLimit, delivOffset);
      const deliverablesTotal = countDeliverables(db, { taskIds: ownerIds });
      const deliverables = db.prepare(`SELECT d.*, t.title AS owner_task_title FROM wa_deliverables d
        LEFT JOIN wa_tasks t ON t.id = d.task_id
        WHERE ${dScope.sql} ORDER BY d.created_at DESC, d.rowid DESC${delivPage.sql}`).all(...dScope.params, ...delivPage.params) as Array<Record<string, unknown>>;
      // zx_20260913 M2-2: 归属不被后写者夺(见 write_file)，但"还有谁写过"须如实透出——派生自版本快照 changed_by
      const writers = otherWriters(db, deliverables as Array<{ id: string; task_id?: string | null }>);
      for (const d of deliverables) {
        d.owner_task_id = d.task_id ?? null;
        d.other_writers = writers.get(String(d.id)) || [];
      }
      // zx_20260906_1 3e: 退休计数回传——任务详情在"当前成果为空/仅新版"时透出"N 项已退休(重试旧版)→产出物页查看"，消除信息差
      // zx_20260914 M2-3②(罗尔斯·同一把尺): 改与上方成果列表**同集合**——此前 `task_id = ?`(仅自身)，
      //   而 `deliverables` 用 `task_id IN (ownerIds)`(含子树)。同一页两把尺 ⇒ 子任务退休项在"产出物"区
      //   看得见、在"已退休 N 项"里却数不到，用户按提示到产出物页反而对不上数。
      const retiredCount = (db.prepare(`SELECT COUNT(*) AS c FROM wa_deliverables WHERE task_id IN (${ownerIds.map(() => '?').join(',')}) AND status = 'retired'`).get(...ownerIds) as { c: number }).c;
      // Phase B (2026-08-28 zx_2): 任务复盘透出（实践论再认识——任务详情可见复盘教训与可行动建议）
      // B1 (2026-09-03): 复盘结构化（context_json.retrospective）一并回传，供前端分节渲染；旧数据无结构则回退 content
      const retroRows = db.prepare("SELECT content, context_json, created_at FROM wa_memories WHERE task_id = ? AND memory_type = 'retrospective' ORDER BY created_at DESC LIMIT 1").all(id) as Array<{ content: string; context_json?: string; created_at: string }>;
      const retrospective = retroRows.map((r) => {
        let structured: Record<string, unknown> | undefined;
        try {
          const c = JSON.parse(r.context_json || '{}') as { retrospective?: Record<string, unknown> };
          if (c.retrospective && typeof c.retrospective === 'object') structured = c.retrospective;
        } catch { /* 旧数据无结构，忽略 */ }
        return structured ? { content: r.content, created_at: r.created_at, structured } : { content: r.content, created_at: r.created_at };
      });
      // zx_20260914 M2-3③(罗尔斯·同一把尺): 验收徽标不再由渲染层"直读 acceptance_verified"——
      //   那样等于**绕过** `per_doc_acceptance` 口径：列表页按 per-doc 如实、任务详情页一律显示 ✓，
      //   同一份成果两页两说。改由 main 用**同一函数**派生后回传，两页读同一个 `acceptance`。
      annotateAcceptance(db, deliverables as Array<Record<string, unknown>>);
      return { data: { task, conversations, conversationsTotal, deliverables, deliverablesTotal, retrospective, retiredCount } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('task:create', async (_event, { projectId, title, description, priority, acceptance_criteria, parent_task_id, plan_task_id, client_request_id, attachment_paths }: {
    projectId: string; title: string; description?: string; priority?: number; acceptance_criteria?: string; parent_task_id?: string; plan_task_id?: string; client_request_id?: string; attachment_paths?: string[]
  }) => {
    try {
      // zx_20260914 M0.6(老子·为之于未有 / 康德·范畴穷尽): **一次点击只该建一个任务**。
      // 原 handler 开头即无条件 INSERT ⇒ 双击 = 两次并发 IPC = 两行（真库实证 f07ad74a/8d9be3f8 相隔 286ms 各建一份）。
      // 幂等键落 `context_json.client_request_id`（不新增列）；由调用方（renderer）在**每次表单提交时生成一次**，
      // 重试复用同一个键。无键的调用方**不去重**——不拿"同标题 N 秒内"猜意图（相似≠同一，会误伤合法的同名任务）。
      const reqId = typeof client_request_id === 'string' && client_request_id.trim() ? client_request_id.trim() : null;
      if (reqId) {
        // ⚠ 查—插必须落在**同一同步段**：本 handler 内多处 await（embedText 等）都是 IPC 交错点，
        // 判据若跨在 await 两侧，两次并发调用会各自查到"不存在"再各自插入，去重形同虚设。
        const hit = db.prepare("SELECT * FROM wa_tasks WHERE project_id = ? AND json_extract(context_json, '$.client_request_id') = ?").get(projectId, reqId);
        if (hit) return { data: hit };
      }
      // zx_20260907 M3(D2 复核补): 新建任务支持指定父任务(同项目校验)——打通 GUI 手工构造父子链(E1 上游要求注入真实 dogfood)
      // zx_20260916_3 M1: 父校验与槽位闸**前移到 INSERT 之前**——原顺序是"先插行、再校验父"，
      //   校验失败即留下**无父的孤儿行**。闸一旦会在人的动作上拒绝，这条路径就必然造孤儿，故先行校验。
      if (parent_task_id) {
        const parentOk = db.prepare('SELECT id FROM wa_tasks WHERE id = ? AND project_id = ?').get(parent_task_id, projectId);
        if (!parentOk) return { error: { code: 'BAD_REQUEST', message: '父任务不存在或不属于当前项目' } };
        // zx_20260916_3 M1（D1 全覆盖）：**人的动作**同样受理于广度闸——只数**在途**（真源 task-accounting.childBreadthRefusal）。
        // 已知代价（方案 §12.1①，已接受）：人工亦可能被闸挡；若实测造成受阻须如实登记复议。
        const attachRefusal = childBreadthRefusal(db, parent_task_id);
        if (attachRefusal) return { error: { code: 'BAD_REQUEST', message: `父任务${attachRefusal}` } };
      }
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO wa_tasks (id, project_id, title, description, priority, status, acceptance_criteria, context_json)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, projectId, title, description || '', priority || 0, acceptance_criteria || '', reqId ? JSON.stringify({ client_request_id: reqId }) : '{}');
      if (parent_task_id) {
        db.prepare('UPDATE wa_tasks SET parent_task_id = ? WHERE id = ?').run(parent_task_id, id);
      }
      // zx_20260909_1 M4(Z1 王阳明·知行合一于创建一刻 / 道德经·为之于未有): 新建任务即可"关联方案(规划)"——创建即写
      // ctx.scheme_ref.plan_task_id(同项目校验), 先于 ≈10s 自动动工; 动工/收口按 scheme_ref+标题 M 正常落里程碑。
      // 显式选中优先; 未选中才走"子任务继承父 scheme_ref"(zx_20260909 续跑模型), 两路不冲突。
      let schemePlanId: string | null = null;
      if (plan_task_id) {
        const planOk = db.prepare('SELECT id FROM wa_tasks WHERE id = ? AND project_id = ?').get(plan_task_id, projectId);
        if (!planOk) return { error: { code: 'BAD_REQUEST', message: '方案任务不存在或不属于当前项目' } };
        schemePlanId = String(plan_task_id);
      } else if (parent_task_id) {
        // zx_20260911_3 M3-1b: 继承须上溯祖先链（与引擎 create_task/spawn_subagent 同一份判据）——
        // 此前只读**直接父**的 scheme_ref，而现场「板挂规划任务、卡挂实施任务」差一层 ⇒ GUI 手工建的子任务同样丢关联。
        try { schemePlanId = resolveAncestorSchemeRef(db, parent_task_id)?.plan_task_id ?? null; } catch { /* 继承失败不阻断 */ }
      }
      if (schemePlanId) db.prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.scheme_ref', json(?)) WHERE id = ?").run(JSON.stringify({ plan_task_id: String(schemePlanId) }), id);
      // zx_20261013_1 批二(K7): GUI 挂件——本地选的文件与 IM 入站走**同一条链**（落盘真源 `im-media` /
      //   形状真源 `attachmentEntry` / 写者 `appendTaskAttachments`），故装配链与批一的能力把关对这里**天然生效**。
      //   位置在 INSERT 之后、≈10s 自动动工**之前**：件必须先于执行进上下文，否则开局就看不见它。
      //   逐件独立成败——失败记 `attachmentsFailed` 如实回给界面，**不阻断建任务**（挂件是加料，不是必要条件）。
      let attachmentsImported = 0;
      let attachmentsFailed: Array<{ filePath: string; error: string }> = [];
      if (Array.isArray(attachment_paths) && attachment_paths.length > 0) {
        const imported = importLocalAttachments(dataDir, attachment_paths);
        appendTaskAttachments(db, id, imported.entries);
        attachmentsImported = imported.entries.length;
        attachmentsFailed = imported.failures;
      }
      // Phase D (2026-08-28 zx_3): 描述/验收语义矛盾消歧（维特根斯坦语言游戏——「实施」vs「核实」语境差异显性化）
      try {
        const descText0 = (description || '').trim();
        const acceptText0 = (acceptance_criteria || '').trim();
        const hasImplement = /实施|执行|开始|开发|改造|实现/.test(descText0);
        const hasVerify = /核实|核查|检查|审查|验证完成情况|是否.*完成|是否.*落地/.test(acceptText0);
        if (hasImplement && hasVerify) {
          db.prepare('INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?, ?, ?, ?)')
            .run(crypto.randomUUID(), id, 'system', '[语义提示] 任务描述含「实施/开发/改造」类意图，验收标准含「核实/核查/检查」类意图，二者语义可能矛盾。请明确本次任务是「实施」（动手做新工作）还是「核实」（核查已有工作是否完成）。');
        }
      } catch { /* 消歧提示 best-effort */ }
      // D2: 模板匹配自动拆解（关键词匹配预置模板，拆为子任务）
      // zx_20260924 缺陷C: 守卫与匹配口径**一律归一处** → `decideTemplateMatch`（core/task-templates.ts）。
      //   本文件不再自带门槛、也不再自带"命中哪几个词"的算法（`template:test` 那套手抄镜像已随之删除）。
      try {
        const decision = decideTemplateMatch(db, title || '', description || '');
        if (!decision.skip) {
          let tpl = decision.hit?.template ?? null;
          // B2 (2026-09-02): 匹配可解释性——捕获命中依据（命中关键词 / 命中哪一侧 / 匹配方式 / 语义相似度），
          //   随 context_json 落库供界面展示「为什么命中」
          let hitKeywords: string[] = decision.hit?.hitKeywords ?? [];
          let matchedField: 'title' | 'description' | '' = decision.hit?.field ?? '';
          let matchedMethod = decision.hit ? 'keyword' : '';
          let matchedSimilarity: number | null = null;
          // A1 (2026-08-31): 关键词优先，未命中才语义补充（embedding 相似度 > 阈值），失败回退
          const mem = memoryGetter?.();
          if (!tpl && mem) {
            try {
              const textEmb = await mem.embedText(decision.semanticText);
              if (textEmb && textEmb.length > 0) {
                const templateEmbs = await getTemplateEmbeddings(db, (t) => mem.embedText(t));
                const semantic = matchTemplateSemantic(textEmb, templateEmbs);
                if (semantic) { tpl = semantic.template; matchedMethod = 'semantic'; matchedSimilarity = Math.round(semantic.similarity * 100) / 100; matchedField = ''; }
              }
            } catch { /* 语义匹配失败回退关键词 */ }
          }
          if (tpl && tpl.subtasks.length >= 2) {
            // zx_20260913 M3-1/M3-3: 子任务此前一律落 `paused` —— 全库**无任何**路径把它们的依赖转 pending，
            // 于是拆解出的子任务永远不启动（"已自动拆解为N个子任务"是空话）。现落 `pending`，由
            // `getReadyTasks`+`hasUnmetDependencies` 决定何时可跑；子项可用**同批序号**声明前置（先备齐 id 再映射）。
            const childIds = tpl.subtasks.map(() => crypto.randomUUID());
            let decomposedCount = 0;
            for (let i = 0; i < tpl.subtasks.length; i++) {
              const childId = childIds[i]!;
              // zx_20260916_3 M1（D1 全覆盖 / 一处真源）：同一道广度闸——不写字面量上限，逐条查在途。
              // 父为**刚建的新任务**（0 子）⇒ 现实中不会触发；接线是为了让"上限"这件事全系统只有一处判据。
              if (childBreadthRefusal(db, id)) break;
              // zx_20260921 M6（D4 断点②）: 第三参传**本子任务自己的 id** —— 模型/模板把前置写成自身序号时，
              //   映射出的就是它自己，落库即自环（恒 waiting、永不执行）。此处在建行前就把它滤掉。
              const depIds = resolveIndexDeps((tpl.subtasks[i] as { dependsOn?: unknown }).dependsOn, childIds, childId);
              db.prepare('INSERT INTO wa_tasks (id, project_id, title, description, status, priority, context_json, parent_task_id, source, acceptance_criteria, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                // zx_20260924_1 M3-a（J-6）：priority 这一格装的是**拆解序号**（模板序），不是紧要度——
                //   写 `decomposePriority(tpl.subtasks.length, i)`，与两处 `ORDER BY priority DESC` 读点同口径
                //   （GUI 项目任务列表亦按 DESC 读 ⇒ 子任务**按模板序**排列）。改前写裸 `i` ⇒ 次序整个倒过来。
                .run(childId, projectId, tpl.subtasks[i]!.title, tpl.subtasks[i]!.description, 'pending', decomposePriority(tpl.subtasks.length, i), JSON.stringify({ depth: 1, auto_decomposed: true, parent_task_id: id, template: tpl.id }), id, 'template', tpl.subtasks[i]!.acceptance_criteria, depIds);
              decomposedCount += 1;
            }
            // B2: 命中模板累计 match_count（反馈闭环）
            try { db.prepare('UPDATE wa_task_templates SET match_count = match_count + 1, updated_at = datetime(\'now\') WHERE id = ?').run(tpl.id); } catch { /* 表缺失忽略 */ }
            // zx_20260913 M3-1: 父**留在** `pending`——此前写 `planning`，而 getReadyTasks 只选 `pending`，
            // 唯一处理 planning 的是 30 分钟超时收割（置 paused）⇒ 父永远不动工、子也永远不启动。
            // 父由上面的 INSERT 已落 `pending`（本 handler 建任务即 `'pending'` 字面量），故此处只补拆解标记，
            // 不重写状态（同值写无意义，且状态写点越少越不易漂）。
            // zx_20260924 缺陷B（用户报「父任务从来没落过拆解标记」）: 原写法把 **5 组**键值对套进 **4 层** `json_set(`
            //   ——层数≠键值对数 ⇒ SQLite 抛 `near ",": syntax error`，被下面那句 `catch` 吞成一条 warn。
            //   后果：父任务永远拿不到 template/matched_*，「已拆分为N个子任务」回执也永远不落库，而 match_count 已 +1
            //   （用户只看见计数涨、收不到回执）。**同一处还有第二个哑弹**：`json(?)` 喂的是**裸字符串**
            //   （`json('web_app')` / `json('keyword')`）⇒ 即便括号补齐也照样 `malformed JSON`。
            //   现改用**单次** json_set 的多组 path/value 形式：层数恒为 1，与键值对数解耦 ⇒ "手工套娃漏一层"结构上不再可能；
            //   字符串/数字直接以 SQL 值给出（TEXT→JSON 字符串、REAL→JSON 数字、NULL→JSON null），只有数组仍需 `json(?)`。
            db.prepare(`UPDATE wa_tasks SET context_json = json_set(
                COALESCE(context_json,'{}'),
                '$.auto_decomposed', json('true'),
                '$.template', ?,
                '$.matched_method', ?,
                '$.matched_keywords', json(?),
                '$.matched_similarity', ?,
                '$.matched_field', ?
              ), updated_at = datetime('now') WHERE id = ?`)
              .run(tpl.id, matchedMethod, JSON.stringify(hitKeywords), matchedSimilarity, matchedField || null, id);
            // zx_20260916_3 M1: 报数取**真实写入行数**（decomposedCount）——原写模板声明的 `subtasks.length`，
            //   一旦闸截断就成了"名实不符"（同 zx_20260915 P0-9(b) 的 INSERT OR IGNORE 照报"已登记"）。
            const decomposedNote = decomposedCount < tpl.subtasks.length ? `（篇幅上限：模板声明 ${tpl.subtasks.length} 个，实建 ${decomposedCount} 个）` : '';
            db.prepare('INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), id, 'system', `[模板拆解] 任务匹配模板「${tpl.name}」，已拆分为${decomposedCount}个子任务（状态 pending，按依赖自动启动）${decomposedNote}。`);
            logger.info({ taskId: id, title, template: tpl.id, subTaskCount: decomposedCount, declared: tpl.subtasks.length }, '任务创建命中模板，已自动拆解');
          }
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message, title }, '模板拆解失败(已忽略)');
      }
      // A1 (2026-09-01): 创建时生成 task_embedding（让新任务可被后续任务召回为「相似历史任务」）。
      // 历史同类经验提炼已移至执行期 buildMemoryContext（memory.getSimilarTaskExperience，随 memoryContext 送达 Agent）。
      try {
        const memA1 = memoryGetter?.();
        if (memA1) {
          const taskTextA1 = `${title || ''} ${description || ''}`.trim();
          const textEmbA1 = await memA1.embedText(taskTextA1 || title || '');
          if (textEmbA1 && textEmbA1.length > 0) {
            db.prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.task_embedding', json(?)) WHERE id = ?").run(JSON.stringify(textEmbA1), id);
          }
        }
      } catch { /* 创建时 embedding best-effort */ }
      // A2 (2026-09-02): 提取实践效应——相似任务开始前主动回忆相关记忆并做适用性检验，适用的加固（高于被动访问）
      try {
        const memA2 = memoryGetter?.();
        if (memA2) {
          const taskTextA2 = `${title || ''} ${description || ''}`.trim() || String(title || '');
          memA2.retrievalPractice(taskTextA2, projectId, 5);
        }
      } catch { /* 提取实践 best-effort */ }
      const task = db.prepare('SELECT * FROM wa_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      // 批二（K7）：把挂件结果**如实**回给界面——成功件数与非零失败逐条（GUI 据此上屏，不静默）。
      //   仅在非零/非空时附键：0 与空数组不入返回值，避免把"没有失败"与"没有请求挂件"混成同一句话。
      if (task) {
        if (attachmentsImported > 0) task.attachments_imported = attachmentsImported;
        if (attachmentsFailed.length > 0) task.attachments_failed = attachmentsFailed;
      }
      return { data: task };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // zx_20261013_1 批二(K7)：**给已经存在的任务挂本地文件**（详情页「挂附件」）。
  //   与建任务时的 `attachment_paths` 共用同一落盘链（`importLocalAttachments` 内已复用 `saveInboundMedia`），
  //   差别只在"挂到已存在的哪张任务上"。挂完即进 `context_json.attachments[]` ⇒ 下一次执行/回复即被
  //   `buildAttachmentParts` 装配（无需立刻重跑；正在跑的任务由下一次模型请求带上）。
  ipcMain.handle('task:attachFiles', async (_event, { id, filePaths }: { id: string; filePaths?: string[] }) => {
    try {
      const task = db.prepare('SELECT id FROM wa_tasks WHERE id = ?').get(id) as { id: string } | undefined;
      if (!task) return { error: { code: 'NOT_FOUND', message: '任务不存在' } };
      const paths = (Array.isArray(filePaths) ? filePaths : []).map((p) => String(p ?? '').trim()).filter(Boolean);
      if (paths.length === 0) return { error: { code: 'BAD_REQUEST', message: '未选择文件' } };
      const imported = importLocalAttachments(dataDir, paths);
      appendTaskAttachments(db, id, imported.entries);
      // 逐件如实：成功件数 + 非零失败逐条（与 `task:create` 的回执同形）。
      return { data: { imported: imported.entries.length, failures: imported.failures } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('task:updateStatus', async (_event, { id, status, reason }: { id: string; status: string; reason?: string }) => {
    try {
      const task = db.prepare('SELECT id, status, project_id FROM wa_tasks WHERE id = ?').get(id) as { id: string; status: string; project_id: string } | undefined;
      if (!task) return { error: { code: 'NOT_FOUND', message: '任务不存在' } };
      // zx_20260909 Z3(空性·如实 / 王阳明·知行合一): 暂停一律先作废该任务残留执行作业(排队/未开跑/崩溃遗留的 wa_jobs)——
      // 此前仅 running 类走 interruptTask、排队(pending 等)裸置 paused 不清残留作业(cleanup 仅终态), 可能"暂停后仍被执行"
      if (status === 'paused') supersedeExecutionJobs(db, id, 'superseded_by_pause');
      // A1 (2026-09-03_3): 暂停 = 中止在途（不再只改状态仍烧 Token）——running/executing/preparing/planning → paused 时 abort
      // zx_20260917 M1: 暂停分支整体走唯一写入口 `pauseTask`（因由 `user_interrupt`——GUI 点「暂停」即用户在停）。
      //   在途态经 `interruptTask` 进去（其内亦调 `pauseTask`）；**非在途态**（排队/待执行等）此前落一条
      //   `status = ?` 的**变量驱动**裸 UPDATE——字面扫描看不见它，故未列入"24 处直写点"，
      //   但确是暂停决策点：在那里因由落不下、事件也无。调用方**一律不再补发** `status_changed`。
      if (status === 'paused') {
        if (['running', 'executing', 'preparing', 'planning'].includes(task.status)) {
          interruptTask(db, id);
        } else {
          // `reason` 形参（现状只有 `failed` 携带 `abandoned_by_user`）若带了就照旧落 `ctx.reason`——
          // 逐字保住既有行为，不因收口写入口而丢一笔账。
          pauseTask(db, { taskId: id, reason: PAUSE_REASON_USER_INTERRUPT, extraContext: reason ? { reason } : undefined });
        }
        return { data: { id, status: 'paused' } };
      }
      // zx_20261012_2 批二: 「归档」走**唯一写手** `archiveTask`（状态 + 因 `archive_reason` + 翻账页 + 发事件
      //   一次写全）；此前这里对 `archived` 也走下面那条裸 UPDATE——因不落、账页不翻（与 `pauseTask` 收口前的旧病同形）。
      //   `archived` 的事件由 `archiveTask` 发出，故下面 :633 那条通用 emit 对它**跳过**（免同一次两条 status_changed）。
      const archivedViaHand = status === 'archived';
      if (archivedViaHand) {
        archiveTask(db, { taskId: id, reason });
      } else {
        db.prepare("UPDATE wa_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
        // C1 (2026-09-03_3): 记录处置原因（如 abandoned_by_user），写入 context_json.reason
        if (reason) {
          try {
            const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string } | undefined;
            const ctx = row?.context_json ? (JSON.parse(row.context_json) as Record<string, unknown>) : {};
            ctx.reason = reason;
            db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), id);
          } catch { /* ignore */ }
        }
      }
      // A1 (2026-09-04): 终态即清理该任务残留执行作业（杀"幽灵作业"）。
      // zx_20260921 M7（D4 断点①）: 终态之后**问一句父能不能放行**——引擎那四处都问、GUI 这条路从来没问，
      //   于是"子任务全标完了、父还挂着'等子完成会自动恢复'"（假话）。见 `afterTaskTerminalStatus` 头注释。
      //   放在 `cleanupTaskExecutionJobs` 之后：先把本任务的残作业清干净，再去动父的状态。
      if (['completed', 'failed', 'archived'].includes(status)) {
        cleanupTaskExecutionJobs(db, id);
        afterTaskTerminalStatus(db, id);
      }
      // zx_20260920_1 M3（面一 · 判据 C5/C7）: 人工「标记完成」的收口清算整体交给**一处真源**
      //   `finalizeTaskByHuman`（清陈旧暂停键 / 保住判卷结论只换署名 / 顶层与账内同值 / doc 随之落定）。
      //   此前这里是**一条 `if (!existing?.score)` 的总闸**——凡"已有账"（这条路上最常见的状态）整段跳过，
      //   于是标本 `9788ce4f` 同时挂着 `completed` 与 `pause_reason='output_insufficient'`、`via` 永停 `'run_close'`。
      //   无账时把 `assessCompletionQuality` 的审计结论**注入**（分数口径与 agent `update_task_status` 工具路同源）。
      if (status === 'completed') {
        try {
          const wdir = (db.prepare('SELECT working_dir FROM wa_projects WHERE id = ?').get(task.project_id) as { working_dir?: string } | undefined)?.working_dir || '';
          // zx_20260928 M2: 传**目标任务的持久化 archetype**（取值口与 `finalize_task` 同源）——此前省略该参，
          //   CAP1（研究/文档/分析类零产出物压 45）在人工收口出口整条不生效，是同一判据三处出口的第三处。
          let humanArch: string | undefined;
          try {
            const hj = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json?: string } | undefined)?.context_json || '{}') as { archetype?: unknown };
            if (typeof hj.archetype === 'string') humanArch = hj.archetype;
          } catch { /* archetype 读取失败按"未标注"处理（不误压分） */ }
          const auditQ = assessCompletionQuality(db, id, 0, 0, 0, 0, wdir, humanArch);
          const fin = finalizeTaskByHuman(db, {
            taskId: id,
            via: 'task:updateStatus',
            audit: { score: auditQ.score, feedback: auditQ.feedback },
          });
          // zx_20260905 批5 收尾对齐：双写 quality_score 列（与 agent update_task_status 一致，避免项目质量聚合漏计）。
          //   分取自**收口后**的账（本函数不搬 `syncQualityColumn`——那会把整条引擎依赖链拖进 core 模块）。
          if (typeof fin.score === 'number') db.prepare('UPDATE wa_tasks SET quality_score = ? WHERE id = ?').run(fin.score, id);
        } catch (err) { logger.warn({ err: (err as Error).message, taskId: id }, '人工收口清算失败(不阻断状态转移)'); }
      }
      // zx_20260915 P0-3(a)(失败必带因): 调用方未附 reason 时**如实说明"未附原因"**——发一条系统会话行，
      //   而不是让"为什么失败"在任务里查无此据（事件里 error 为空串＝如实"没这笔账"，不编一句话充数）。
      if (status === 'failed' && !reason) {
        try {
          db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
            .run(crypto.randomUUID(), id, '[人工置失败] 未附原因——操作者未填写失败缘由，任务详情里没有可查的因由。');
        } catch { /* 上屏失败不阻断状态转移 */ }
      }
      // 持久化事件到 wa_event_log
      // zx_20260915 P0-3(a)/(a′)（同一把尺·三个出口同一形状）: 失败带 `error`、完成带「果」——
      //   与工具路（agent-executor `update_task_status`）及两处 `task.completed` 出口**同一构造器**，
      //   形状由构造器一处说了算，不在此手抄第二版。
      // zx_20261012_2 批二: `archived` 的事件已由 `archiveTask` 发出（带 `reason`），此处跳过——免同一次两条。
      if (!archivedViaHand) {
        eventBus.emit('task.status_changed', { taskId: id, task_id: id, newStatus: status, new_status: status, projectId: task.project_id, ...(status === 'failed' ? { error: reason || '' } : {}), ...(status === 'completed' ? buildTaskOutcome(db, id) : {}) }).catch(() => {});
      }
      if (status === 'running' && !hasPendingExecutionJob(db, id)) {
        if (_taskRunEnqueuer) {
          // zx_20260907 M5 修(2026-09-08): 入调度器内存队列即时执行(不再等重启恢复)；executeTask CAS 已认领 running
          await _taskRunEnqueuer(id, task.project_id);
        } else {
          // 兜底：enqueuer 未注入时退化为原裸插(依赖调度器重启恢复)，避免执行请求完全丢失
          db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES (?, 'ai-task', ?, 'pending')").run(crypto.randomUUID(), JSON.stringify({ taskId: id, projectId: task.project_id }));
        }
      }
      return { data: { id, status } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // C1 (2026-09-03_3): 任务直接子任务（父详情"子任务待决"条用）
  // zx_20261011_4 M4: 一并取 `context_json` 并投影出 `remote`（已外派则带"外派给谁/回传摘要"）——
  //   键名与投影判据取 core 一处真源（`remoteTaskView`）；`context_json` **不进程出边界**（只留投影）。
  ipcMain.handle('tasks:children', async (_event, { id }: { id: string }) => {
    try {
      const rows = db.prepare(`SELECT t.id, t.title, t.status, t.updated_at, t.context_json,
        json_extract(t.context_json, '$.completion_quality.score') AS score,
        COALESCE((SELECT SUM(c.token_count) FROM wa_task_conversations c WHERE c.task_id = t.id), 0) AS tokens
        FROM wa_tasks t WHERE t.parent_task_id = ? ORDER BY t.created_at ASC`).all(id) as Array<Record<string, unknown>>;
      const children = rows.map((r) => {
        const remote = remoteTaskView(r.context_json as string | null);
        const out: Record<string, unknown> = { ...r };
        delete out.context_json;
        return remote ? { ...out, remote } : out;
      });
      return { data: { children } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // E2 (2026-09-04_2): 任务"扬弃小结"只读聚合——从 wa_event_log 汇总本次执行的偏离/信号/记忆注入/步数等事实
  // （黑格尔·扬弃：完成为对该次执行的总判断；不新增存储，复用事件日志为唯一真相源）
  ipcMain.handle('tasks:digest', async (_event, { id }: { id: string }) => {
    try {
      const row = db.prepare('SELECT status, context_json FROM wa_tasks WHERE id = ?').get(id) as { status: string; context_json: string } | undefined;
      if (!row) return { error: { code: 'NOT_FOUND', message: '任务不存在' } };
      const count = (et: string): number => {
        const r = db.prepare("SELECT COUNT(*) AS c FROM wa_event_log WHERE aggregate_type = 'task' AND aggregate_id = ? AND event_type = ?").get(id, et) as { c: number };
        return r.c;
      };
      let ctx: Record<string, unknown> = {};
      try { ctx = JSON.parse(row.context_json || '{}'); } catch { /* ignore */ }
      const quality = (ctx.completion_quality as { score?: number; feedback?: string } | undefined) ?? null;
      const tokensRow = db.prepare('SELECT COALESCE(SUM(token_count), 0) AS t FROM wa_task_conversations WHERE task_id = ?').get(id) as { t: number };
      return { data: {
        taskId: id,
        status: row.status,
        steps: count('task.step_finished'),
        deviations: count('task.goal_deviation'),
        signals: count('task.execution_signal'),
        memoryInjections: count('task.memory_injected'),
        goalIdentified: count('task.goal_identified') > 0,
        quality: quality?.score ?? null,
        feedback: quality?.feedback ?? null,
        tokens: tokensRow.t,
      } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // F1 (2026-09-04_2): 全局"此刻最需你介入"唯一单条（抓主要矛盾·实时化）
  // 跨项目扫描活跃任务，按 优先级×紧迫度 评分取最高一项；仅返回 reason 可追溯的单一主矛盾。
  ipcMain.handle('tasks:mainIssue', async () => {
    try {
      const rows = db.prepare("SELECT id, project_id, title, status, context_json, updated_at FROM wa_tasks WHERE status IN ('running','executing','paused','failed')").all() as Array<{ id: string; project_id: string; title: string; status: string; context_json: string; updated_at: string }>;
      interface Cand { taskId: string; projectId?: string; title: string; kind: 'await' | 'failed' | 'budget'; reason: string; score: number }
      const cands: Cand[] = [];
      const now = Date.now();
      const ts = (s: string | null): number => { if (!s) return 0; const d = new Date(s.includes('Z') ? s : s + 'Z'); return isNaN(d.getTime()) ? 0 : d.getTime(); };
      const hasAwaitMarker = (taskId: string): boolean => {
        const r = db.prepare("SELECT COUNT(*) AS c FROM wa_task_conversations WHERE task_id = ? AND role = 'system' AND (content LIKE '[等待用户输入]%' OR content LIKE '[待回复]%' OR content LIKE '[待审批]%')").get(taskId) as { c: number };
        return r.c > 0;
      };
      for (const t of rows) {
        let ctx: Record<string, unknown> = {};
        try { ctx = JSON.parse(t.context_json || '{}'); } catch { /* ignore */ }
        const idleMin = Math.max(0, Math.floor((now - ts(t.updated_at)) / 60000));
        // 1) 等待用户输入（paused + 待回复标记）
        // zx_20261014_6 M5（毛选·实事求是）: 判据由 `ctx.pending_approval` 改为**真源 `ctx.awaiting_input`**——
        //   全仓声明 `awaiting_input` 是"横幅唯一真源"（respond / resume 两会清）；`pending_approval` 是紧随
        //   `pauseForDecision` 写的**辅助字段**，resume 曾漏清（M4 已补），历史行仍可能残留 ⇒ 拿它判会误报
        //   「⚠ 此刻最需你介入」。保留 `hasAwaitMarker` 兼容回落（老任务无 ctx 时的会话标记）。
        if (t.status === 'paused' && (ctx.awaiting_input || hasAwaitMarker(t.id))) {
          cands.push({ taskId: t.id, projectId: t.project_id, title: t.title, kind: 'await', reason: `等待你输入/决策（已 ${idleMin} 分钟）`, score: 1000 + Math.min(idleMin, 120) });
          continue;
        }
        // 2) 失败未恢复
        if (t.status === 'failed') {
          cands.push({ taskId: t.id, projectId: t.project_id, title: t.title, kind: 'failed', reason: '执行失败，可恢复/重试继续', score: 600 - Math.min(idleMin, 300) });
          continue;
        }
        // 3) 预算逼近上限（跨 resume 累计口径）
        if (t.status === 'running' || t.status === 'executing' || t.status === 'paused') {
          const ratio = Number(ctx.budget_usage_ratio) || 0;
          if (ratio >= 0.9) {
            cands.push({ taskId: t.id, projectId: t.project_id, title: t.title, kind: 'budget', reason: `预算已用 ${Math.round(ratio * 100)}%，接近上限将强制收尾`, score: 400 + Math.round(ratio * 100) });
          }
        }
      }
      cands.sort((a, b) => b.score - a.score);
      const issue = cands[0] ?? null;
      return { data: { issue, total: cands.length } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('task:retry', async (_event, { id }: { id: string }) => {
    try {
      const task = db.prepare('SELECT id, status, project_id, context_json FROM wa_tasks WHERE id = ?').get(id) as { id: string; status: string; project_id: string; context_json: string } | undefined;
      if (!task) return { error: { code: 'NOT_FOUND', message: '任务不存在' } };
      if (task.status !== 'failed' && task.status !== 'completed') return { error: { code: 'INVALID_STATUS', message: '仅 failed/completed 状态可重试' } };
      db.prepare('DELETE FROM wa_task_conversations WHERE task_id = ?').run(id);
      // zx_20260906 批3 (3e): 重试=从头再来不重蹈混淆——旧成果如实退休(soft retired，保版本历史)、质量清空，新 run 从零统计
      const retired = retireTaskDeliverables(db, id);
      // zx_20261013_1 收口：**从零重跑只清机器跑的**——运行指标（budget/tokens/…）本就该由新一轮重算，
      //   故整体重建；但用户自述输入（挂的附件/纠的目标/关联的方案）无再派生的路 ⇒ 经 `carryRetryContext`
      //   跨重跑带上（同 `tools/control.ts`/`agent-executor.ts` 的"只补写不重建"）。**不可**退回裸对象覆写。
      let prevCtx: Record<string, unknown> = {};
      try { prevCtx = JSON.parse(task.context_json || '{}') as Record<string, unknown>; } catch { /* 坏 ctx：如实当空，不阻断重试 */ }
      const ctxMeta: Record<string, unknown> = {
        ...carryRetryContext(prevCtx),
        retried_at: new Date().toISOString(),
        retried_from_status: task.status,
        retried_retired_count: retired.retired,
      };
      db.prepare("UPDATE wa_tasks SET status = 'pending', context_json = ?, quality_score = NULL, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(ctxMeta), id);
      // zx_20260909 Z1(王阳明·知行合一 / 空性·如实): 重试置 pending 后即入队真正执行——此前只置 pending 不 enqueue, 依赖
      // scanReadyTasks(需项目 active+节奏)GUI"重试"后停 pending 无真作业; 语义=从零重跑(对话已删), 先作废残留作业防双跑, 走 ai-task 即时执行。
      supersedeExecutionJobs(db, id, 'superseded_by_retry');
      if (_taskRunEnqueuer) {
        void _taskRunEnqueuer(id, task.project_id);
      } else {
        db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES (?, 'ai-task', ?, 'pending')").run(crypto.randomUUID(), JSON.stringify({ taskId: id, projectId: task.project_id }));
      }
      // zx_20260908 D2: resume族统一广播 status_changed(pending) → notification:264-274 集中 markTaskRead(处置即已读)，根治陈旧铃/角标
      eventBus.emit('task.status_changed', { taskId: id, task_id: id, projectId: task.project_id, newStatus: 'pending', new_status: 'pending' }).catch(() => {});
      return { data: { id, status: 'pending', retiredCount: retired.retired } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // 恢复暂停/失败任务（保留对话历史，用 resume-ai-task 继续）
  ipcMain.handle('task:resume', async (_event, { id, reply }: { id: string; reply?: string }) => {
    try {
      const task = db.prepare('SELECT id, project_id, status, context_json FROM wa_tasks WHERE id = ?').get(id) as { id: string; project_id: string; status: string; context_json: string } | undefined;
      if (!task) return { error: { code: 'NOT_FOUND', message: '任务不存在' } };
      if (!['paused', 'failed'].includes(task.status)) {
        return { error: { code: 'INVALID_STATUS', message: `任务状态为 ${task.status}，无法恢复。只有暂停/失败的任务可以恢复。` } };
      }
      let ctx: Record<string, unknown> = {};
      try { ctx = JSON.parse(task.context_json || '{}'); } catch { /* ignore */ }
      // zx_20260910_1 M4: 同一次暂停的重复提交直接幂等返回（判据见 isDuplicatePauseResponse；置状态守卫之后，不动既有语义）
      if (isDuplicatePauseResponse(ctx, 'resume', reply)) {
        return { error: { code: 'ALREADY_RESPONDED', message: '该回复刚刚已提交，无需重复操作' } };
      }
      if (reply) {
        db.prepare(
          "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'user', ?, 0, datetime('now'))"
        ).run(crypto.randomUUID(), id, reply);
      }
      // A2 变体(zx_20260909 Q2 修): 不再"已有待执行作业就静默 skip"。用户显式恢复时，先作废该任务
      // 残留的 pending|running 执行作业(历史遗留/并发残留的幽灵——正是曾让"回复并恢复"点了没反应、
      // 任务永远停在 paused 的死锁根源：旧逻辑命中即返回，不置 pending 也不入队)，再置 pending + 入队新作业。
      // 安全性：resume 仅允许 paused/failed 进入；真在跑的 executeTask 早已把任务置 executing，故此处残留
      // 作业必为过期幽灵，作废不误伤。防重入由 executeTask 的 CAS(pending/paused/preparing/running→executing)兜底。
      supersedeExecutionJobs(db, id, 'superseded_by_resume');
      db.prepare("UPDATE wa_tasks SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(id);
      // zx_20260910_3 M2d-a: 人工恢复 → 返还目标偏离额度（搭 settlePause 的同一次 ctxJson 写，不新增 UPDATE）
      grantGoalDeviationQuota(ctx);
      // zx_20260910_1 M2/M4: 恢复即处置（清本次等待的会话标记 + ctxJson.awaiting_input）+ 应答落账（供判重）
      // zx_20260915 P0-5(b): 显式标答复面 = 'gui'（本条即 GUI 侧答复真源；落账/发事件在 settlePause 内一处完成）
      settlePause(db, id, ctx, 'resume', reply, true, 'gui');
      // 保留对话历史，用 resume-ai-task 继续（实机修：enqueue 即时执行，非裸插等重启）
      enqueueResumeJob(db, id, task.project_id, reply);
      // zx_20260908 D2: 恢复即广播(处置即已读·防陈旧铃/角标)
      eventBus.emit('task.status_changed', { taskId: id, task_id: id, projectId: task.project_id, newStatus: 'pending', new_status: 'pending' }).catch(() => {});
      return { data: { id, status: 'pending', resumed: true } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // Phase 2: 结构化决策响应（ask_user 选项 / 路径审批 / 特权审批 的按钮回复）
  ipcMain.handle('task:respond', async (_event, { id, decision, value }: { id: string; decision: 'allow' | 'deny' | 'option'; value?: string }) => {
    try {
      const task = db.prepare('SELECT id, project_id, status, context_json FROM wa_tasks WHERE id = ?').get(id) as { id: string; project_id: string; status: string; context_json: string } | undefined;
      if (!task) return { error: { code: 'NOT_FOUND', message: '任务不存在' } };
      if (task.status !== 'paused') return { error: { code: 'INVALID_STATUS', message: `任务状态为 ${task.status}，无待响应决策` } };

      let ctx: Record<string, unknown> = {};
      try { ctx = JSON.parse(task.context_json || '{}'); } catch { /* ignore */ }
      // zx_20260910_1 M4: 同一次暂停的重复提交幂等返回。连续拒绝保持暂停(status 仍 paused → 过守卫)时，
      // 后续重复点击此前每次都会再写一行相同的用户回复；判据见 isDuplicatePauseResponse。
      if (isDuplicatePauseResponse(ctx, decision, value)) {
        return { error: { code: 'ALREADY_RESPONDED', message: '该决策刚刚已提交，无需重复操作' } };
      }
      const pending = ctx.pending_approval as { type?: string; fingerprint?: string; path?: string; command?: string } | undefined;

      // 1. 构造回复文本
      let reply = value || (decision === 'allow' ? '是' : decision === 'deny' ? '否' : '');

      // 2. allow：写持久化批准（路径/命令指纹，二次免询问）
      if (decision === 'allow' && pending) {
        if (pending.type === 'path' && pending.fingerprint) {
          db.prepare("INSERT OR IGNORE INTO wa_approvals (id, project_id, command_fingerprint, kind) VALUES (?, ?, ?, 'path')").run(crypto.randomUUID(), task.project_id, pending.fingerprint);
        } else if (pending.type === 'privilege' && pending.fingerprint) {
          db.prepare("INSERT OR IGNORE INTO wa_approvals (id, project_id, command_fingerprint, kind) VALUES (?, ?, ?, 'command')").run(crypto.randomUUID(), task.project_id, pending.fingerprint);
        }
        if (ctx.rejection_count) delete ctx.rejection_count;
      }

      // 3. deny：拒绝追踪降级（连续 3 次拒绝 → 保持暂停，不恢复）
      if (decision === 'deny') {
        const rejectionCount = (Number(ctx.rejection_count) || 0) + 1;
        ctx.rejection_count = rejectionCount;
        if (rejectionCount >= 3) {
          ctx.pending_approval = undefined;
          // zx_20260910_1 M4: clear=false——保持暂停，保留 awaiting_input，故 15s 内重复点击仍被判为同一轮并拦下
          settlePause(db, id, ctx, decision, value, false, 'gui');
          db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'user', ?, 0, datetime('now'))")
            .run(crypto.randomUUID(), id, reply || '拒绝');
          return { data: { id, status: 'paused', rejected: true, message: '连续 3 次拒绝，任务保持暂停' } };
        }
      }

      // 4. 清除待审批标记 + 写回复 + 恢复任务（ctxJson 一次写：清 pending_approval + 落 pause_response 判重账）
      ctx.pending_approval = undefined;
      // zx_20260910_3 M2d-a: 人工应答恢复 → 返还目标偏离额度（同上，搭 settlePause 的同一次写）
      grantGoalDeviationQuota(ctx);
      settlePause(db, id, ctx, decision, value, true, 'gui');
      db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'user', ?, 0, datetime('now'))")
        .run(crypto.randomUUID(), id, reply);
      db.prepare("UPDATE wa_tasks SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(id);
      // 实机修：respond 恢复入队即时执行
      enqueueResumeJob(db, id, task.project_id, reply);
      // zx_20260908 D2: respond 恢复即广播(处置即已读·防陈旧铃/角标)
      eventBus.emit('task.status_changed', { taskId: id, task_id: id, projectId: task.project_id, newStatus: 'pending', new_status: 'pending' }).catch(() => {});
      return { data: { id, status: 'pending', resumed: true } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // Phase C (2026-08-28): 中止运行中任务（真正 abort，区别于「暂停」只改状态）
  ipcMain.handle('task:interrupt', async (_event, { id }: { id: string }) => {
    try {
      // zx_20260917 M1: 广播改由 `interruptTask` 内的 `pauseTask` 发出（状态/因/事件一次写全）——
      //   此处原先"调用方补发 emit"（zx_20260908 D2）即"同一暂停四处各自补"的一处，现统一不再补。
      const result = interruptTask(db, id);
      if ('error' in result) return { error: { code: 'NOT_FOUND', message: result.error as string } };
      return { data: result };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // Phase C (2026-08-28): 执行中追加输入（软中断当前步 + 带新输入继续，文本由 resume-ai-task→executeTask 链路写入）
  ipcMain.handle('task:inject', async (_event, { id, text }: { id: string; text: string }) => {
    try {
      const task = db.prepare('SELECT id, project_id, status FROM wa_tasks WHERE id = ?').get(id) as { id: string; project_id: string; status: string } | undefined;
      if (!task) return { error: { code: 'NOT_FOUND', message: '任务不存在' } };
      if (!['executing', 'running', 'preparing'].includes(task.status)) {
        return { error: { code: 'INVALID_STATUS', message: `任务状态为 ${task.status}，无法追加输入。只有执行中的任务可以追加输入。` } };
      }
      const trimmed = (text || '').trim();
      if (!trimmed) return { error: { code: 'INVALID_INPUT', message: '追加内容不能为空' } };
      // 软中断当前步（真正 abort 运行中的 generateText，executing/preparing 有效）
      // 注意：注入文本不在此处写库，由 resume-ai-task（finalMsg）+ executeTask（taskMessage）链路写入，避免重复写入
      interruptTask(db, id);
      // 置 pending 并重新入队，任务带新输入继续
      db.prepare("UPDATE wa_tasks SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(id);
      enqueueResumeJob(db, id, task.project_id, trimmed);
      // zx_20260908 D2: inject 恢复即广播(处置即已读·防陈旧铃/角标)
      eventBus.emit('task.status_changed', { taskId: id, task_id: id, projectId: task.project_id, newStatus: 'pending', new_status: 'pending' }).catch(() => {});
      return { data: { id, status: 'pending', injected: true } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // zx_20261012_2 批二: 「归档（放弃）」——与 `task:interrupt`/`task:delete` 同节。
  //   `archiveTask` 是该状态的**唯一写手**（落库 + 账页 + 事件一处全）；此处只做前置存在性校验，
  //   终态后仍按既有形制清残作业 + 问父能否放行（`afterTaskTerminalStatus`），与 `task:updateStatus` 同尾。
  //   ⚠ 归档由**人**发起（弃是当事人的决定），故**不发 IM**——与 failed/paused 的"该发"划清。
  ipcMain.handle('task:archive', async (_event, { id, reason }: { id: string; reason?: string }) => {
    try {
      const task = db.prepare('SELECT id FROM wa_tasks WHERE id = ?').get(id) as { id: string } | undefined;
      if (!task) return { error: { code: 'NOT_FOUND', message: '任务不存在' } };
      archiveTask(db, { taskId: id, reason });
      cleanupTaskExecutionJobs(db, id);
      afterTaskTerminalStatus(db, id);
      return { data: { id, status: 'archived' } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // 删除任务（清空对话/产出物/记忆/作业关联）
  ipcMain.handle('task:delete', async (_event, { id }: { id: string }) => {
    try {
      const task = db.prepare('SELECT id FROM wa_tasks WHERE id = ?').get(id) as { id: string } | undefined;
      if (!task) return { error: { code: 'NOT_FOUND', message: '任务不存在' } };
      // 2026-09-07 fix: 任务删除同样漏清 wa_deliverable_versions(→wa_deliverables) FK 子表，带版本产出物会触发 FOREIGN KEY constraint failed
      const delTask = db.transaction(() => {
        const dIds = (db.prepare('SELECT id FROM wa_deliverables WHERE task_id = ?').all(id) as Array<{ id: string }>).map((r) => r.id);
        db.prepare('DELETE FROM wa_task_conversations WHERE task_id = ?').run(id);
        if (dIds.length > 0) {
          db.prepare(`DELETE FROM wa_deliverable_versions WHERE deliverable_id IN (${dIds.map(() => '?').join(',')})`).run(...dIds);
        }
        db.prepare('DELETE FROM wa_deliverables WHERE task_id = ?').run(id);
        // zx_20260930 M8: 随任务删除**落墓碑**（原为物理删）。
        //   ⚠ 顺序：必须在 `DELETE FROM wa_tasks` 之前——`tombstoneMemoriesBy` 要先按 task_id 取到行。
        tombstoneMemoriesBy(db, 'task_id', id, MEM_DELETE_REASONS.taskCascade);
        db.prepare('DELETE FROM wa_notifications WHERE task_id = ?').run(id); // 2026-09-04_2: 删除任务同步清通知（防死链白页）
        db.prepare("DELETE FROM wa_jobs WHERE payload LIKE '%' || ? || '%'").run(id);
        db.prepare('DELETE FROM wa_tasks WHERE id = ?').run(id);
      });
      delTask();
      return { data: { id, deleted: true } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // ===== 产出物 =====
  ipcMain.handle('deliverable:list', async (_event, { projectId, type, status, keyword, limit, offset }: { projectId?: string; type?: string; status?: string; keyword?: string; limit?: number; offset?: number }) => {
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (projectId) { conditions.push('d.project_id = ?'); params.push(projectId); }
      if (type) { conditions.push('d.type = ?'); params.push(type); }
      if (status) { conditions.push('d.status = ?'); params.push(status); }
      // zx_20260906_2 批3 (2026-09-06): 成果关键词检索——名称/描述/类型/路径/registry_id LIKE；projectId 空即跨项目全局
      const kw = (keyword || '').trim();
      if (kw) { conditions.push("(d.name LIKE ? OR d.description LIKE ? OR d.type LIKE ? OR d.file_path LIKE ? OR COALESCE(d.registry_id, '') LIKE ?)"); const like = `%${kw}%`; params.push(like, like, like, like, like); }
      // zx_20260913 M2-3(康德·范畴穷尽): 补上**唯一漏网读点**——此前本处无探针滤除(同谓词已在详情/全景/交付单收敛)，
      // 产出物管理页会比别处多出临时探针 doc。**刻意保留「已退休可见」**(档案视图有意为之，不动)。
      // zx_20260930 M4-1: 这次差异从"顺手少写一行"升格为**显式声明**——`includeRetired: true` 写在这里，
      //   谁想改成一致都会先读到这行；附加筛选（关键词/type/status）仍接在本函数自己的 conditions 里。
      conditions.push(deliverableScopeSql({ alias: 'd', includeRetired: true }).sql);
      const whereSql = conditions.join(' AND ');
      const where = whereSql ? `WHERE ${whereSql}` : '';
      // zx_20260930 M4-2: **真分页** + 总数。`total` 与明细用**同一段 FROM/JOIN/WHERE 与同一组 params**
      //   （同一句装配出来的，不是两处手抄）——故"共 M 条"必与这页的行来自同一个集合。
      //   JOIN 一并留在 COUNT 里：`JOIN wa_projects` 是内连接，项目行缺失的成果**两边都不算**，
      //   否则 total 会把明细永远取不到的孤儿件也数进去。
      //   ORDER BY 补 `d.rowid DESC` 兜同秒行次序（`created_at` 只到秒 ⇒ 不补则翻页可行重复/遗漏）。
      const from = `FROM wa_deliverables d
        JOIN wa_projects p ON d.project_id = p.id
        LEFT JOIN wa_tasks t ON t.id = d.task_id ${where}`;
      const total = (db.prepare(`SELECT COUNT(*) AS c ${from}`).get(...params) as { c: number }).c;
      // zx_20260930 M4-2: 已退休件计数改由**服务端**按**同一组筛选条件**算——原先由渲染层数 `items`
      //   （已加载的那一页）⇒ 分页后会把"已退休 N 项"变成"这一页里有 N 项"，而它给的是一条**归档提示**，
      //   提示里的数必须与它所指的全量集合同尺。
      const retiredCount = (db.prepare(`SELECT COUNT(*) AS c FROM wa_deliverables d
        JOIN wa_projects p ON d.project_id = p.id
        LEFT JOIN wa_tasks t ON t.id = d.task_id ${whereSql ? `WHERE ${whereSql} AND` : 'WHERE'} d.status = 'retired'`).get(...params) as { c: number }).c;
      const page = resolvePage(limit, offset);
      // zx_20260906 批3 (3b): JOIN 补产出任务标题，产出物↔任务可溯源跳转
      // zx_20260906_1 3a: JOIN 补任务质量分(task_quality_score)——列表质量列/排序
      // zx_20260913 M2-6: 补派生列 version_count——版本历史钮的**事实依据**(有版本才亮，不再凭 type 猜)
      const data = db.prepare(`SELECT d.*, p.name as project_name, t.title as task_title, t.status as task_status, t.quality_score as task_quality_score,
        (SELECT COUNT(*) FROM wa_deliverable_versions v WHERE v.deliverable_id = d.id) AS version_count
        ${from} ORDER BY d.created_at DESC, d.rowid DESC${page.sql}`).all(...params, ...page.params) as Array<Record<string, unknown>>;
      // zx_20260913 M2-2(巴特莱特·重构): 归属不被夺，但"还有谁写过"如实透出(派生自版本快照 changed_by，不新增列)
      const writers = otherWriters(db, data as Array<{ id: string; task_id?: string | null }>);
      for (const r of data) r.other_writers = writers.get(String(r.id)) || [];
      // zx_20260907 M2(B2): 成果侧"验收证据"透出——补 DeliverablesPage doc 徽标数据位"是否已验证成果"；纯派生不改判。
      // zx_20260914 M2-3③(罗尔斯·同一把尺): 派生逻辑**已收敛到 `annotateAcceptance`**——
      //   此处原是与 `deliverable:preview`、即将新增的 `task:get` 并列的第二/第三份手抄。
      annotateAcceptance(db, data);
      // zx_20260924_1 M5-b(维特根斯坦·语言游戏 / 一处真源): 列表侧"大小"列的**唯一取数处**。
      //   `wa_deliverables` **没有 size 列**——真实字节只能在 main 侧按 `file_path` 现场 stat（renderer 无 fs，故必须在此补）。
      //   逐行 try/catch：文件不在/无权限/路径为空 ⇒ `null`（界面显示 `—`），**绝不因一个件把整页列表打红**。
      for (const r of data) r.size_bytes = statSizeBytes(r.file_path);
      // zx_20260930 M4-2: 返回体由**裸数组**改为 `{ rows, total, limit, offset }`——
      //   裸数组装不下"共多少条"，而"只给前 N 条且不说还剩多少"正是本轮所治的病（同 M4-3 补发账）。
      //   调用方须读 `.rows`；总数取服务端口径（projectId/type/status/keyword），**不含**渲染层自己的筛选项。
      return { data: { rows: data, total, retiredCount, limit: page.limit, offset: page.offset } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // zx_20260906_2 批4 (4c): 全局对象检索(CommandPalette 按名直达)——只读轻量 LIKE，返回 项目/任务/产出物/里程碑 各 ≤6；不检索记忆/对话内容
  ipcMain.handle('search.global', async (_event, { q }: { q?: string }) => {
    const kw = (q || '').trim();
    const empty = { projects: [], tasks: [], deliverables: [], milestones: [] };
    if (!kw) return { data: empty };
    const like = `%${kw}%`;
    try {
      const projects = db.prepare('SELECT id, name, status FROM wa_projects WHERE name LIKE ? ORDER BY updated_at DESC LIMIT 6').all(like) as Array<Record<string, unknown>>;
      const tasks = db.prepare("SELECT id, project_id, title, status FROM wa_tasks WHERE (title LIKE ? OR description LIKE ?) AND status NOT IN ('archived') ORDER BY updated_at DESC LIMIT 6").all(like, like) as Array<Record<string, unknown>>;
      // zx_20260930 M4-1 **登记一处刻意差异**(不改)：全局检索**不带探针滤除**，只有 `status != 'retired'`。
      //   理由：这是**按用户输入词的命中列表**，不是"算不算成果"的计数面。用户搜一个探针脚本名，
      //   藏起来才是说谎（"搜不到"而它确实在库）——与 `deliverable:list` 的档案视图同理：**看得见**优先于**口径一致**。
      //   故此处**不**改走 `deliverableScopeSql`；日后"顺手统一"前请先读本行。
      const deliverables = db.prepare("SELECT id, project_id, task_id, name, type, status FROM wa_deliverables WHERE (name LIKE ? OR description LIKE ?) AND status != 'retired' ORDER BY updated_at DESC LIMIT 6").all(like, like) as Array<Record<string, unknown>>;
      const milestones = db.prepare("SELECT project_id, milestone, status, implemented_by_task_id FROM wa_plan_milestones WHERE milestone LIKE ? OR status LIKE ? ORDER BY updated_at DESC LIMIT 6").all(like, like) as Array<Record<string, unknown>>;
      return { data: { projects, tasks, deliverables, milestones } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // zx_20260930 M4-2(管子·度量衡 / 奥卡姆·勿增实体): 成果页**下拉名录**的唯一取数处。
  //
  // 病根：成果页的项目/任务下拉与"无任务 N 项"此前由 `renderer` 侧的 `allItems`（= `deliverable:list()`
  // **无参全表**）派生。列表一旦分页，这条路就只剩两种活法，**两种都错**：
  //   ① 拿当页派生 ⇒ 名录随分页收缩（E15 老病复发：选定项目后下拉自坍缩，用户切不回去）；
  //   ② 保留一发"无参全表" ⇒ 首屏为两个下拉把整表（真库 406 行，且 `deliverable:list` 还逐行 stat 文件）
  //      再读一遍——**分页反而让首屏更慢**，正是本轮要治的病。
  // 故名录改由服务端一次算清：只需 project/task 的**名字**，与页大小、与页内筛选都无关。
  // 范围仍走**同一取数范围真源**（`includeRetired: true` 与 `deliverable:list` 的档案视图同尺），
  // 故下拉里出现的项目/任务，恰是列表里可能出现的那些。
  ipcMain.handle('deliverable:facets', async () => {
    try {
      const scope = deliverableScopeSql({ alias: 'd', includeRetired: true });
      const projects = db.prepare(`SELECT DISTINCT p.id AS id, p.name AS name FROM wa_deliverables d JOIN wa_projects p ON d.project_id = p.id WHERE ${scope.sql} ORDER BY p.name`).all(...scope.params);
      const tasks = db.prepare(`SELECT DISTINCT d.task_id AS id, t.title AS title FROM wa_deliverables d LEFT JOIN wa_tasks t ON t.id = d.task_id WHERE ${scope.sql} AND d.task_id IS NOT NULL ORDER BY t.title`).all(...scope.params);
      // 「项目级（无任务）」计数——附加条件（`task_id IS NULL`）是**本视图自己的问题**，按真源头注释的约定留在调用方。
      const noTaskCount = (db.prepare(`SELECT COUNT(*) AS c FROM wa_deliverables d WHERE ${scope.sql} AND d.task_id IS NULL`).get(...scope.params) as { c: number }).c;
      return { data: { projects, tasks, noTaskCount } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('deliverable:start', async (_event, id: string) => {
    try {
      const d = db.prepare('SELECT * FROM wa_deliverables WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!d) return { error: { code: 'NOT_FOUND', message: '产出物不存在' } };
      const delivType = d.type as string;
      const delivName = (d.name as string) || '';
      const filePath = (d.file_path as string) || '';

      // zx_20261002 M11: 守护进程/A2A 启动的调用账**唯一写点**（两类共用同一形状，故收在一个局部函数里）。
      //   `project_id` 取交付物行自带者；**"已在运行⇒同步状态"那一支不记**——那次没有发生调用（记账不得编造）。
      const callProjectId = (d.project_id as string) || '';
      const recordStart = (kind: 'a2a' | 'daemon', ok: boolean, startedAt: number, error?: string): void =>
        recordServiceCall(db, { projectId: callProjectId, kind, target: delivName, operation: 'start', ok, durationMs: Date.now() - startedAt, error });

      if (delivType === 'daemon') {
        if (!filePath || !fs.existsSync(filePath)) return { error: { code: 'NO_SCRIPT', message: '守护进程无有效的 file_path' } };
        const daemonStart = Date.now();
        // 检查进程是否已在运行（桌面外启动的）
        const basename = path.basename(filePath);
        try {
          const alreadyRunning = execSync(`pgrep -f "${basename.replace(/"/g, '\\"')}"`, { timeout: 3000 }).toString().trim();
          if (alreadyRunning) {
            const pids = alreadyRunning.split('\n').filter(Boolean).join(', ');
            setDeliverableStatus(db, id, 'running', 'deliverable:start:sync');
            return { data: { id, type: 'daemon', status: 'running', message: `进程已在运行中(PID:${pids})，已同步状态` } };
          }
        } catch {}
        const ext = path.extname(filePath).toLowerCase();
        const command = ext === '.py' ? `python3 "${filePath}"` : ext === '.js' ? `node "${filePath}"` : filePath;
        const cwd = path.dirname(filePath);
        // 先清理孤儿进程，避免端口冲突
        await killOrphan(filePath);
        try {

          const proc = spawn(command, [], { cwd, stdio: 'pipe', shell: true, env: { ...process.env, DAEMON_ID: id } });
          proc.stdout?.on('data', (data: Buffer) => console.log(`[daemon:${delivName}] ${data.toString().trim()}`));
          proc.stderr?.on('data', (data: Buffer) => console.error(`[daemon:${delivName}] ${data.toString().trim()}`));
          proc.on('exit', (code: number | null) => handleDaemonExit(db, id, delivName, code, filePath));
          runtimeProcesses.set(id, { process: proc, startedAt: Date.now() });
          setDeliverableStatus(db, id, 'running', 'deliverable:start');
          // 等待5秒确认启动，同时捕获 stderr 中的端口冲突
          let stderrBuf = '';
          proc.stderr?.on('data', (data: Buffer) => { stderrBuf += data.toString(); });
          await new Promise(r => setTimeout(r, 5000));
          if (stderrBuf.includes('address already in use') || stderrBuf.includes('EADDRINUSE')) {
            try { proc.kill('SIGTERM'); } catch {}
            runtimeProcesses.delete(id);
            // zx_20260930 M3-b: 启动失败 ⇒ `failed`（不是 `stopped`）——进程**没起来**，非用户所停。
            setDeliverableStatus(db, id, 'failed', 'deliverable:start:eaddrinuse');
            recordStart('daemon', false, daemonStart, '端口已被占用');
            return { error: { code: 'START_FAILED', message: '端口已被占用，请先停止占用该端口的进程' } };
          }
          if (proc.exitCode !== null && proc.exitCode !== 0) {
            runtimeProcesses.delete(id);
            setDeliverableStatus(db, id, 'failed', 'deliverable:start:fail');
            recordStart('daemon', false, daemonStart, `启动即退出(exit code ${proc.exitCode})${stderrBuf ? ': ' + stderrBuf.slice(-200) : ''}`);
            return { error: { code: 'START_FAILED', message: `守护进程启动失败(exit code ${proc.exitCode})${stderrBuf ? ': ' + stderrBuf.slice(-200) : ''}` } };
          }
          recordStart('daemon', true, daemonStart);
          return { data: { id, type: 'daemon', status: 'started', command, cwd } };
        } catch (spawnErr) {
          recordStart('daemon', false, daemonStart, (spawnErr as Error).message);
          return { error: { code: 'START_FAILED', message: (spawnErr as Error).message } };
        }
      }

      // MCP/A2A: 查找入口文件
      const candidates: string[] = [];
      if (filePath) {
        try {
          const fpStat = fs.statSync(filePath);
          if (fpStat.isDirectory()) candidates.push(filePath);
          else if (fpStat.isFile()) candidates.push(path.dirname(filePath));
        } catch {}
      }
      if (d.project_id) {
        const proj = db.prepare('SELECT working_dir FROM wa_projects WHERE id = ?').get(d.project_id) as { working_dir: string } | undefined;
        if (proj?.working_dir && fs.existsSync(proj.working_dir)) candidates.push(proj.working_dir);
      }

      const ENTRY_CHECKS = [['server.js'], ['index.js'], ['server.py']];
      let workingDir = '';
      let entryFile = '';
      for (const dir of candidates) {
        let found = false;
        for (const parts of ENTRY_CHECKS) {
          const full = path.join(dir, ...parts);
          if (fs.existsSync(full)) { workingDir = dir; entryFile = parts.join('/'); found = true; break; }
        }
        if (found) break;
      }
      if (!entryFile) return { error: { code: 'NO_ENTRY', message: `No entry file found in ${candidates.join(', ') || 'any directory'}` } };

      const ext = path.extname(entryFile).toLowerCase();
      const command = ext === '.py' ? `python3 "${entryFile}"` : `node "${entryFile}"`;
      try {
        // A2A 类型：使用 A2A 运行时（专属端口 19950-19999 + 自动生成 Agent Card）
        if (delivType === 'a2a') {
          const a2aStart = Date.now();
          try {
            const { startA2AServer, ensureAgentCard } = await import('../core/a2a-runtime.js');
            ensureAgentCard(id, delivName, workingDir);
            // zx_20260929 M12: 起了之后又死，此前**无人记账**（与下面 MCP/daemon 路径的 `proc.on('exit')` 不对称）
            // ⇒ 库里 `status` 永远停在 `running`、GUI 也一直显示绿点。现由运行时在确证「起得来且这条仍是当前那条」
            // 之后回调到此，如实落 `stopped`。
            const a2a = await startA2AServer(id, delivName, workingDir, entryFile, (code, signal) => {
              console.log(`[a2a:${delivName}] exited code=${code} signal=${signal}`);
              setDeliverableStatus(db, id, 'stopped', 'a2a:exit');
            });
            db.prepare("UPDATE wa_deliverables SET registry_id = ? WHERE id = ?").run(a2a.endpoint, id);
            setDeliverableStatus(db, id, 'running', 'deliverable:start');
            recordStart('a2a', true, a2aStart);
            // zx_20260929 M2: 与 MCP/daemon 同尺——启动后同样注册到 ANS。此前本分支 early-return，
            // 注册那一步（在下面共享路径上）被跳过 ⇒ 桌面里跑着、ANS 侧从未在册。
            // 端点传**实际分配的端口**，不用 `registerToAns` 里的兜底常量（19950 只是端口段起点）。
            registerToAns(db, id, delivName, delivType, workingDir, entryFile, a2a.endpoint).catch(e =>
              console.error(`[deliverable:start] ANS注册失败: ${delivName}`, (e as Error).message)
            );
            return { data: { id, type: delivType, status: 'started', workingDir, entryFile, endpoint: a2a.endpoint, agentCardUrl: a2a.agentCardUrl, port: a2a.port } };
          } catch (a2aErr) {
            // 记完失败账后**原样抛出**——外层 `catch (spawnErr)` 的 `START_FAILED` 契约不变。
            recordStart('a2a', false, a2aStart, (a2aErr as Error).message);
            throw a2aErr;
          }
        }

        const proc = spawn(command, [], { cwd: workingDir, stdio: 'pipe', shell: true, env: { ...process.env, DAEMON_ID: id } });
        proc.stdout?.on('data', (data: Buffer) => console.log(`[${delivType}:${delivName}] ${data.toString().trim()}`));
        proc.stderr?.on('data', (data: Buffer) => console.error(`[${delivType}:${delivName}] ${data.toString().trim()}`));
        proc.on('exit', (code: number | null) => {
          // zx_20260930 M3-a(柏拉图·洞穴喻: 影子不是事物本身): 无论 `code` 为何**都要落库**。
          //   此前只有 `code !== 0 && code !== null` 才写 ⇒ MCP/服务型成果**正常跑完退出**后
          //   `runtimeProcesses` 已删（绿点变红点）而库里仍是 `running`，徽章写「运行中」而进程不在，
          //   自相矛盾，须手点停止才复位。**正常退出不是"仍在运行"**——一行都不落就是让影子留在墙上。
          console.log(`[${delivType}:${delivName}] exited code=${code}`);
          runtimeProcesses.delete(id);
          setDeliverableStatus(db, id, 'stopped', 'deliverable:exit');
        });
        runtimeProcesses.set(id, { process: proc, startedAt: Date.now() });
        setDeliverableStatus(db, id, 'running', 'deliverable:start');

        // MCP/A2A 启动后自动注册到 ANS
        registerToAns(db, id, delivName, delivType, workingDir, entryFile).catch(e =>
          console.error(`[deliverable:start] ANS注册失败: ${delivName}`, (e as Error).message)
        );

        return { data: { id, type: delivType, status: 'started', workingDir, entryFile } };
      } catch (spawnErr) { return { error: { code: 'START_FAILED', message: (spawnErr as Error).message } }; }
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('deliverable:stop', async (_event, id: string) => {
    try {
      const deliv = db.prepare('SELECT id, type, file_path FROM wa_deliverables WHERE id = ?').get(id) as { id: string; type: string; file_path: string | null } | undefined;
      // A2A 类型：使用 A2A 运行时停止
      if (deliv?.type === 'a2a') {
        try { const { stopA2AServer } = await import('../core/a2a-runtime.js'); await stopA2AServer(id); } catch {}
        setDeliverableStatus(db, id, 'stopped', 'deliverable:stop');
        return { data: { id, status: 'stopped' } };
      }
      const rt = runtimeProcesses.get(id);
      if (rt) {
        const proc = rt.process;
        if (proc) {
          // SIGTERM → 等待 → SIGKILL 升级
          try { proc.kill('SIGTERM'); } catch {}
          try { await new Promise<void>(resolve => { const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 5000); proc.once('exit', () => { clearTimeout(t); resolve(); }); }); } catch {}
        } else if (rt.pid) {
          // C2: 收养孤儿 → 用OS信号kill
          try { process.kill(rt.pid, 'SIGTERM'); } catch {}
          await new Promise(r => setTimeout(r, 1000));
          try { process.kill(rt.pid, 0); process.kill(rt.pid, 'SIGKILL'); } catch {}
        }
        runtimeProcesses.delete(id);
      } else if (deliv?.file_path) {
        // C3: 孤儿进程兜底——不在Map中，用file_path扫描端口/进程清理（防崩溃）
        try { await killOrphan(deliv.file_path); } catch {}
      }
      setDeliverableStatus(db, id, 'stopped', 'deliverable:stop');
      return { data: { id, status: 'stopped' } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('deliverable:delete', async (_event, id: string) => {
    try {
      // zx_20260911_2 M4-G6: 行删除前先取行发 deliverable.status_changed(status='deleted')——删后无法再取；
      // 供交付单/项目卡/活动流即时移除该成果(admin.ipc 已能渲染 'deleted')。
      const drow = loadDeliverableRow(db, id);
      if (drow) emitDeliverableEvent(drow, 'deleted', 'manual:delete', drow.old_status);
      db.prepare('DELETE FROM wa_deliverable_versions WHERE deliverable_id = ?').run(id);
      db.prepare('DELETE FROM wa_deliverables WHERE id = ?').run(id);
      return { data: { id, deleted: true } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('deliverable:preview', async (_event, id: string) => {
    try {
      const deliv = db.prepare('SELECT * FROM wa_deliverables WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!deliv) return { error: { code: 'NOT_FOUND', message: '产出物不存在' } };
      const version = db.prepare('SELECT * FROM wa_deliverable_versions WHERE deliverable_id = ? ORDER BY version DESC LIMIT 1').get(id) as Record<string, unknown> | undefined;
      // 修复：返回完整版本历史列表（前端版本历史面板数据通路）
      const versions = db.prepare('SELECT * FROM wa_deliverable_versions WHERE deliverable_id = ? ORDER BY version DESC').all(id) as Array<Record<string, unknown>>;
      const delivType = deliv.type as string;
      const filePath = (deliv.file_path as string) || '';
      // zx_20260906_1 3d: 溯源诚实——显式标记磁盘文件是否存在(缺失时快照为"历史版本"而非"当前")，杜绝静默回退冒充当前版
      const fileExists = !!filePath && fs.existsSync(filePath);
      let fileMode = 'missing';
      try { if (fileExists) { const st = fs.statSync(filePath); fileMode = st.isFile() ? 'file' : 'dir'; } } catch {}

      // 尝试从文件系统读取内容
      // zx_20260911_5 M3-4(夏克特·错误归属): 截断/回落须**如实标注**——此前静默 slice(0,100_000) +
      // 静默回落 description，界面无从分辨"这是全文"还是"这是描述"。现回报 content_truncated / content_source。
      const PREVIEW_CAP = 100_000; // 100KB
      let fileContent = '';
      let contentTruncated = false;
      if (fileMode === 'file') {
        try {
          const size = fs.statSync(filePath).size;
          if (size > PREVIEW_CAP) {
            contentTruncated = true;
            // 只读首 CAP 字节（不整份载入内存）；可能截断到多字节字符中间，但已在界面如实标注
            const fd = fs.openSync(filePath, 'r');
            try {
              const buf = Buffer.alloc(PREVIEW_CAP);
              const n = fs.readSync(fd, buf, 0, PREVIEW_CAP, 0);
              fileContent = buf.subarray(0, n).toString('utf-8');
            } finally { fs.closeSync(fd); }
          } else {
            fileContent = fs.readFileSync(filePath, 'utf-8');
          }
        } catch {}
      }
      // 内容来源三态：file=读到的文件内容 / snapshot=版本快照 / description=未取到文件内容则以描述代替
      const snapshotText = (version?.content_snapshot as string) || '';
      const descText = (deliv.description as string) || '';
      const contentSource: 'file' | 'snapshot' | 'description' | 'none' =
        fileContent ? 'file' : snapshotText ? 'snapshot' : descText ? 'description' : 'none';
      const pickedContent = fileContent || snapshotText || descText || '';

      // zx_20260909 X1(黑格尔·部分在整体中成其自身): 抽屉溯源载荷——所在任务/项目名 + 支撑里程碑(经 implemented_by_task_id 反查)
      // + 验收证据(任务级派生, 与 list/digest 同口径, 随 deliverable.show_acceptance 下发一致)
      let taskTitle: string | null = null;
      let projectName: string | null = null;
      const milestones: Array<{ milestone: string; status: string }> = [];
      const accMeta: Record<string, unknown> = {};
      try {
        const dTaskId = deliv.task_id as string | null;
        const dProjectId = deliv.project_id as string | null;
        if (dTaskId) {
          const t = db.prepare('SELECT title FROM wa_tasks WHERE id = ?').get(dTaskId) as { title?: string } | undefined;
          taskTitle = t?.title ?? null;
          milestones.push(...(db.prepare("SELECT milestone, status FROM wa_plan_milestones WHERE implemented_by_task_id = ? ORDER BY milestone ASC").all(dTaskId) as Array<{ milestone: string; status: string }>));
          const accCfg = db.prepare("SELECT value FROM wa_settings WHERE key = 'deliverable.show_acceptance'").get() as { value?: string } | undefined;
          if (boolSetting(accCfg?.value)) {
            // zx_20260914 M2-3③(罗尔斯·同一把尺): 派生**收敛到 `annotateAcceptance`**。
            //   本处原为手抄第二份，且比 list 宽松(只查 acceptance_verified，漏了 isAcceptanceType)
            //   ⇒ 一条 `ui` 类而 acceptance_verified=1 的行：列表不显 ✓、抽屉显 ✓。收敛后两侧同尺。
            //   传**浅拷贝**：本函数就地写行对象，而 `deliv` 还要参与下面 `base` 的展开。
            const accRows: Array<Record<string, unknown>> = [{ ...(deliv as Record<string, unknown>) }];
            annotateAcceptance(db, accRows);
            if (accRows[0]!.acceptance) accMeta.acceptance = accRows[0]!.acceptance;
          }
        }
        if (dProjectId) {
          const p = db.prepare('SELECT name FROM wa_projects WHERE id = ?').get(dProjectId) as { name?: string } | undefined;
          projectName = p?.name ?? null;
        }
      } catch { /* 溯源字段失败不阻断预览 */ }
      const base = { ...deliv, ...accMeta, task_title: taskTitle, project_name: projectName, milestones, version: version?.version || 1, versions, file_path: filePath, file_exists: fileExists, file_mode: fileMode, content_truncated: contentTruncated };

      // Doc 类型：优先读文件内容，其次版本快照
      if (delivType === 'doc') {
        return { data: { ...base, content_snapshot: pickedContent, content_source: contentSource } };
      }

      // UI 类型：找到 index.html 返回 file:// URL
      if (delivType === 'ui') {
        let previewUrl = filePath;
        if (filePath && !filePath.startsWith('http')) {
          try {
            const fpStat = fs.statSync(filePath);
            if (fpStat.isDirectory()) {
              // 在目录中查找 index.html
              const indexPath = path.join(filePath, 'index.html');
              if (fs.existsSync(indexPath)) {
                previewUrl = `file://${indexPath}`;
              } else {
                // 找不到 index.html，尝试列出目录中的 html 文件
                const files = fs.readdirSync(filePath).filter(f => f.endsWith('.html'));
                if (files.length > 0) {
                  previewUrl = `file://${path.join(filePath, files[0]!)}`;
                } else {
                  previewUrl = `file://${filePath}`;
                }
              }
            } else if (fpStat.isFile()) {
              previewUrl = `file://${filePath}`;
            }
          } catch { previewUrl = `file://${filePath}`; }
        }
        return { data: { ...base, content_snapshot: fileContent, content_source: fileContent ? 'file' : 'none', preview_url: previewUrl } };
      }

      // 其他类型（含 code）：与 doc 同口径——文件内容 → 版本快照 → 描述，来源如实回报
      return { data: { ...base, content_snapshot: pickedContent, content_source: contentSource } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  /**
   * zx_20260914 M2-4(王阳明·知行合一): 「验收有入口」——把已有验收结论落到**这一条**成果上。
   *
   * 判据**全在 main**(`markDeliverableAcceptanceVerified` 一处说了算)，IPC 只负责取行、调用、如实回传：
   * 拒绝与成功都走 `data`(不是 `error`)，因为"ctx 未核验"是**合法的业务结果**而非故障——
   * 渲染层据此显示具体原因(夏克特·七宗罪·信息失落)，而不是一句笼统的"操作失败"。
   */
  ipcMain.handle('deliverable:accept', async (_event, { id }: { id: string }) => {
    try {
      // 总门控与列表/预览**同键同判据**：deliverable.show_acceptance 关着时不放行(不自造第二个开关)。
      // zx_20260914 M4-4 复核订正措辞：此处原写"同源同值"，言过其实——**键名与判据**确实同源
      //   (同一 `boolSetting`、同一 `BOOL_SETTING_KEYS`)，但**这句 SELECT 是本键的第 5 份手抄**
      //   (另见 deliverable-lifecycle:227 / jobs/ai-task:77 / 本文件 :1295/:1504)。
      //   归一(抽一处 readBoolSetting)列 §7.2 挂账；本轮不冒险重构，改由 rr §S14④ 钉"每处读取都须经 boolSetting"。
      const accCfg = db.prepare("SELECT value FROM wa_settings WHERE key = 'deliverable.show_acceptance'").get() as { value?: string } | undefined;
      if (!boolSetting(accCfg?.value)) return { data: { ok: false, changed: 0, reason: 'disabled' } };
      const r = markDeliverableAcceptanceVerified(db, String(id || ''));
      // 真改了库才通报（r.changed>0 才算"真改"；幂等重复点不重发，避免活动流刷屏）
      if (r.ok && r.changed > 0) {
        const arow = loadDeliverableRow(db, String(id || ''));
        if (arow) emitDeliverableEvent(arow, arow.old_status, 'manual:accept', arow.old_status);
      }
      return { data: r };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  /**
   * zx_20260914 M2-2(夏克特·七宗罪·信息失落): 图片成果**就地看得到**——主进程读盘转 data URL 内联。
   *
   * 判定与读取在 `core/image-preview.resolveImagePreview`（纯函数，注入 io）——handler 只做取行、转壳。
   * 三条失败边界各自的 reason 见该模块头注释；`not_found` 是本 handler 独有的一层（行都没查到）。
   */
  ipcMain.handle('deliverable:previewImage', async (_event, { id }: { id: string }) => {
    try {
      const row = db.prepare('SELECT file_path, name FROM wa_deliverables WHERE id = ?').get(String(id || '')) as { file_path?: string | null; name?: string | null } | undefined;
      if (!row) return { data: { unsupported: true, reason: 'not_found' } };
      const o = resolveImagePreview(row.file_path, row.name, fs);
      if (!o.ok) return { data: { unsupported: true, reason: o.reason, size: o.size, limit: o.limit } };
      return { data: { dataUrl: `data:${o.mime};base64,${o.base64}`, size: o.size, mime: o.mime } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // zx_20260924_1 M5-c(维特根斯坦·可回溯): 手工新建的成果可**认领**一个所属任务——
  //   此前 INSERT 从不写 `task_id` ⇒ 手工件在库里恒为"项目级"（task_id IS NULL），
  //   既找不回它为何而建，也被迫与项目级手工件挤在同一个 ★ 作用域里（`primaryScope`）。
  //   `taskId` **可选**：不传即维持原状（NULL），既有调用方零感知——**不是**行为变更，是补一条可走的路。
  //   不校验 taskId 是否存在/属于本 project：与同文件其它写入路径一致（不新增拒绝面），
  //   且真正的展示口径由 JOIN 兜底（查不到任务时 `task_title` 为 null，界面显示 `—`）。
  //
  // zx_20260930 M3-c（庄子「名者，实之宾也」）: **校验/去重/落库/通报四步改走共享函数
  //   `createDeliverable`**，与 agent 的 `create_deliverable` 工具**同一个函数**。此前本口：
  //   ① 零结构校验（一次点击即可登记出 `type='mcp'` 的 `.md`，或把 `tools/` 下的模块标成服务型）；
  //   ② 通报发 `deliverable.registered` 且 payload 写 `status='registered'`，而刚落库的那一行
  //      **明明是 `draft`**、也**从未**注册到 ANS——事件名与载荷同时名不副实（`rr_zx_20260911_2`
  //      那条只钉 `emitDeliverableEvent` 本身，与本口无关，故口径可以就地改正）。
  //   ⚠ 边界（如实登记）：本口按**传入串逐字**比对存储的 `file_path`，**不做** working_dir 归一
  //   （归一等于新造第二套路径约定；引擎侧存的是绝对路径，此口传相对路径时仍可能视作不同行）。
  ipcMain.handle('deliverable:create', async (_event, { projectId, name, type, description, filePath, taskId }: {
    projectId: string; name: string; type: string; description?: string; filePath?: string; taskId?: string
  }) => {
    try {
      const r = createDeliverable(db, { projectId, taskId, name, type, description, filePath, via: 'manual:create' });
      if (!r.ok) return { error: { code: 'INVALID_INPUT', message: r.message } };
      const data = db.prepare('SELECT * FROM wa_deliverables WHERE id = ?').get(r.id) as Record<string, unknown> | undefined;
      // 查重命中 ⇒ 如实告知"这不是新建，是既有那一行"（夏克特·信息失落）；新建则不带该标记。
      return { data: r.created ? (data ?? {}) : { ...(data ?? {}), deduplicated: true } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // ===== 扩展功能 =====

  // 克隆项目
  ipcMain.handle('project:clone', async (_event, { id, name: newName }: { id: string; name?: string }) => {
    try {
      const src = db.prepare('SELECT * FROM wa_projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!src) return { error: { code: 'NOT_FOUND', message: '项目不存在' } };
      // zx_20261005 M7: 克隆是**第二条建项目路**（直接 INSERT，绕过 project:create）——同一把尺（第二落点穷举）。
      const refusal = projectQuotaRefusal(db);
      if (refusal) return { error: { code: 'QUOTA_EXCEEDED', message: refusal } };
      const newId = crypto.randomUUID();
      const srcDir = (src.working_dir as string) || '';
      const parentDir = srcDir ? path.dirname(srcDir) : path.resolve('.');
      const workingDir = path.join(parentDir, newId);
      try { fs.mkdirSync(workingDir, { recursive: true }); } catch {}
      db.prepare(`INSERT INTO wa_projects (id, name, description, status, cron_schedule, cron_timezone, working_dir, owner_id, sandbox_mode, autonomous_mode, context_json)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`).run(newId, newName || `${src.name}_副本`, src.description, src.cron_schedule, src.cron_timezone, workingDir, src.owner_id, src.sandbox_mode, src.autonomous_mode, src.context_json);
      const data = db.prepare('SELECT * FROM wa_projects WHERE id = ?').get(newId);
      return { data };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // 里程碑 + 阻塞分析 + 方案里程碑(M0-M6)聚合（zx_20260905 批4）
  ipcMain.handle('project:milestones', async (_event, { id }: { id: string }) => {
    try {
      const blockers = analyzeBlockers(db, id);
      const milestones = detectMilestones(db, id);
      // 方案里程碑(M0-M6)项目级聚合：按项目内 plan 任务分组（plan 任务可能多个方案），附每个 milestone 状态/落地任务
      const planTasks = db.prepare(`
        SELECT t.id AS plan_task_id, t.title AS plan_title, t.status AS plan_status,
               (SELECT COUNT(*) FROM wa_plan_milestones m WHERE m.plan_task_id = t.id) AS ms_count
        FROM wa_tasks t
        WHERE t.project_id = ? AND EXISTS (SELECT 1 FROM wa_plan_milestones m WHERE m.plan_task_id = t.id)
        ORDER BY t.created_at ASC
      `).all(id) as Array<{ plan_task_id: string; plan_title: string; plan_status: string; ms_count: number }>;
      const planMilestones = planTasks.map((pt) => {
        const ms = db.prepare("SELECT milestone AS ms, status AS st, implemented_by_task_id AS impl FROM wa_plan_milestones WHERE plan_task_id = ? ORDER BY milestone ASC").all(pt.plan_task_id) as Array<{ ms: string; st: string; impl: string | null }>;
        const done = ms.filter(m => m.st === 'done').length;
        const doing = ms.filter(m => m.st === 'doing').length;
        const pending = ms.filter(m => m.st === 'pending').length;
        return { plan_task_id: pt.plan_task_id, plan_title: pt.plan_title, plan_status: pt.plan_status, milestones: ms, done, doing, pending, total: ms.length };
      });
      return { data: { blockers, milestones, planMilestones } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // zx_20260905 批5: 项目质量聚合（quality_score 列，SQL 可聚合——均质/趋势）
  ipcMain.handle('project:qualityStats', async (_event, { id }: { id: string }) => {
    try {
      const q = projectQualityStats(db, id);
      return { data: q };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // zx_20260908 M2(B1/B2): 项目「成果交付单」聚合——done 里程碑→落地任务 / 已验收 doc·主要成果(deliverable 级 is_primary+acceptance) / 高质已完成任务。
  // 消费端 ProjectDetail 顶部卡渲染；纯派生不改判；行内单跳(任务/产出物)。量小二次读任务 ctx 派生 acceptance(同 deliverable:list)。
  ipcMain.handle('project:deliveryDigest', async (_event, { id, window: windowArg }: { id: string; window?: string }) => {
    try {
      // zx_20260908_1 B1(空性·缘起归窗): 可选 window('30'/'7'=近N天; 'all'/缺省=全部)使「本阶段成果交付单」按窗口如实归口——
      // done里程碑/已验收 doc/高质任务以(落地)任务 updated_at 为锚仅统计窗内; primary 为主要成果累计位不受窗限制。
      const mWin = /^(\d{1,3})$/.exec(String(windowArg ?? '').trim());
      const sinceDays = mWin ? Number(mWin[1]) : 0;
      const cutoffMs = sinceDays > 0 ? Date.now() - sinceDays * 86_400_000 : 0;
      const inWindow = (ts?: string | null): boolean => {
        if (sinceDays <= 0) return true;
        if (!ts) return false;
        // 兼容两种落库时间戳：ISO('2026-09-04T01:02:48.582Z' 自带时区) 与 SQLite UTC('2026-09-08 07:14:05' 无时区)。
        // 里程碑落地任务 updated_at 落库为 ISO-Z（实库 5/5），旧写法无条件 +'Z' → '…ZZ' Invalid Date → 近窗里程碑被误滤(B1 实机缺陷)。
        const s = String(ts).trim();
        const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
        const ms = new Date(hasZone ? s : s.replace(' ', 'T') + 'Z').getTime();
        return !isNaN(ms) && ms >= cutoffMs;
      };
      const milestonesDone = db.prepare(`
        SELECT m.milestone AS milestone, m.implemented_by_task_id AS impl_task_id,
               t.title AS impl_title, t.status AS impl_status, t.updated_at AS impl_updated
        FROM wa_plan_milestones m
        JOIN wa_tasks pt ON pt.id = m.plan_task_id
        LEFT JOIN wa_tasks t ON t.id = m.implemented_by_task_id
        WHERE pt.project_id = ? AND m.status = 'done' AND m.implemented_by_task_id IS NOT NULL AND m.implemented_by_task_id != ''
        ORDER BY m.milestone ASC`).all(id) as Array<{ milestone: string; impl_task_id: string; impl_title: string | null; impl_status: string | null; impl_updated: string | null }>;
      const dgScope = deliverableScopeSql({ projectId: id, alias: 'd' });
      const dRows = db.prepare(`
        SELECT d.id AS deliverable_id, d.name, d.type, d.status AS d_status, COALESCE(d.is_primary, 0) AS is_primary,
               COALESCE(d.acceptance_verified, 0) AS acceptance_verified,
               d.updated_at, d.created_at, d.file_path,
               t.id AS task_id, t.title AS task_title, t.status AS task_status, t.quality_score AS quality
        FROM wa_deliverables d
        JOIN wa_projects p ON p.id = d.project_id
        LEFT JOIN wa_tasks t ON t.id = d.task_id
        -- zx_20260909_1 M3(C2): digest verified/primary 探针尾巴统一——dRows 按 COALESCE(file_path,name) 谓词排除探针(与列表/最近产出物一致)
        -- zx_20260930 M4-1: 范围声明走共享真源（本项目、排除退休与探针）；参数改由真源一并带出，不再与上文 id 混用。
        WHERE ${dgScope.sql}
        ORDER BY d.is_primary DESC, d.updated_at DESC`).all(...dgScope.params) as Array<Record<string, unknown>>;
      const taskIds = [...new Set(dRows.map(r => r.task_id).filter((x): x is string => !!x))];
      // zx_20260909 X2②(知行合一·一致性): deliverable.show_acceptance=false 时 digest 亦不下发验收——verified/primary 段随该键同判
      // (此前仅 deliverable:list 门控(929), digest 无条件装饰=同一开关两入口行为不一致)
      const accCfgD = db.prepare("SELECT value FROM wa_settings WHERE key = 'deliverable.show_acceptance'").get() as { value?: string } | undefined;
      const accOnD = boolSetting(accCfgD?.value);
      // zx_20260914 M2-3③(罗尔斯·同一把尺): ctx 解析收敛到 `verifiedAcceptanceMap`——本处原是**第三份**手抄。
      //   注意本处取的是**数据口径**(要用 checked_at 做时间窗)，故调它而非 `annotateAcceptance`(那是展示口径)。
      const accMap = accOnD ? verifiedAcceptanceMap(db, taskIds) : new Map<string, AcceptanceMeta>();
      // zx_20260909_1 M3(C1): digest 验收徽标从"任务 ctx 扇出"改"doc 级如实"(per_doc_acceptance=true 仅该 doc acceptance_verified=1 才带)
      const pdCfgD = db.prepare("SELECT value FROM wa_settings WHERE key = 'deliverable.per_doc_acceptance'").get() as { value?: string } | undefined;
      const perDocD = boolSetting(pdCfgD?.value);
      const decorate = (r: Record<string, unknown>) => {
        const showAcc = !perDocD || (isAcceptanceType(r.type) && Number(r.acceptance_verified) === 1);
        const a = showAcc && r.task_id ? accMap.get(r.task_id as string) : undefined;
        return {
          deliverable_id: r.deliverable_id, name: r.name, type: r.type, status: r.d_status,
          is_primary: Number(r.is_primary) === 1, acceptance_verified: Number(r.acceptance_verified) === 1,
          file_path: r.file_path ?? null,
          task_id: r.task_id ?? null, task_title: r.task_title ?? null, task_status: r.task_status ?? null,
          quality: r.quality != null ? Number(r.quality) : null,
          acceptance: a ? { criteria_total: a.criteria_total, passed_total: a.passed_total, checked_at: a.checked_at } : null,
          updated_at: r.updated_at ?? r.created_at ?? null,
        };
      };
      const primaryDeliverables = dRows.filter(r => Number(r.is_primary) === 1).map(decorate);
      // show_acceptance=false 时 verified 段随该键不启用(与 zx_20260909 X2② 一致)
      // zx_20260911_2 M4-G3(海德格尔·时间性): verifiedDocs 的窗口锚由"成果行 updated_at"订正为"该成果**验收发生时刻**"——
      // 语义本就是"近 N 天**验收**的成果"；用 updated_at 会把"验收后仅改过名/描述"的旧成果误判入窗、把"验收后补写正文"漏出窗。
      // accMap 仅收纳确已核验(verified)的载荷，故窗口内文档必有 checked_at；若缺(异常载荷)则 inWindow(null)=false，宁少不滥。
      // zx_20260913 M2-5: 过滤口径由字面量 `type==='doc'` 改为 `isAcceptanceType`(ACCEPTANCE_TYPES 单一真源, M2-6 起含 code)。
      // 字段名 `verifiedDocs` **保留**——4 个既有 rr 钉住该名(改 API 名将连带改 4 处断言)；用户可见文案才是词表落点(承 G9)。
      const verifiedDocs = accOnD
        ? dRows.filter(r => isAcceptanceType(r.type) && (perDocD ? Number(r.acceptance_verified) === 1 : !!accMap.get(r.task_id as string)?.checked_at)).map(decorate).filter((r) => inWindow(accMap.get(String(r.task_id ?? ''))?.checked_at ?? null))
        : [];
      const hqParams: unknown[] = [id];
      const hqSql = "SELECT id AS task_id, title, quality_score AS quality, status FROM wa_tasks WHERE project_id = ? AND status = 'completed' AND quality_score >= 80" + (sinceDays > 0 ? " AND updated_at > datetime('now', ?)" : "") + " ORDER BY updated_at DESC LIMIT 8";
      if (sinceDays > 0) hqParams.push(`-${sinceDays} days`);
      const highQualityTasks = db.prepare(hqSql).all(...hqParams) as Array<{ task_id: string; title: string; quality: number | null; status: string }>;
      return { data: { milestonesDone: milestonesDone.filter((m) => inWindow(m.impl_updated as string | null)), primaryDeliverables, verifiedDocs, highQualityTasks } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // 项目记忆
  ipcMain.handle('project:memories', async (_event, { id, type }: { id: string; type?: string }) => {
    try {
      // zx_20260930 M8: 与 `admin:memories` 同一套规矩——**不点名类型即常规列表（不含墓碑）**；
      //   点名 `type='deleted'` 才是审计面。两处读点同尺，否则同一个项目在记忆页与项目页数目不一。
      let query = `SELECT * FROM wa_memories WHERE project_id = ?`;
      const params: unknown[] = [id];
      if (type) { query += ' AND memory_type = ?'; params.push(type); }
      else { query += ` AND ${MEM_LIVE_SQL}`; }
      query += ' ORDER BY created_at DESC';
      const list = db.prepare(query).all(...params);
      // 类型卡保留全部取值（含 `deleted`）——筛选条的墓碑那一格由它提供。
      const counts = db.prepare('SELECT memory_type, COUNT(*) as cnt FROM wa_memories WHERE project_id = ? GROUP BY memory_type').all(id);
      return { data: { list, counts } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // 任务编辑
  ipcMain.handle('task:update', async (_event, { id, title, description, priority, acceptance_criteria, depends_on }: {
    id: string; title?: string; description?: string; priority?: number; acceptance_criteria?: string; depends_on?: string
  }) => {
    try {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (title !== undefined) { sets.push('title = ?'); params.push(title); }
      if (description !== undefined) { sets.push('description = ?'); params.push(description); }
      if (priority !== undefined) { sets.push('priority = ?'); params.push(priority); }
      if (acceptance_criteria !== undefined) { sets.push('acceptance_criteria = ?'); params.push(acceptance_criteria); }
      // zx_20260913 M3-4(维特根斯坦·意义即使用 / 王阳明·知行合一): 前置依赖可编辑。
      // 此前只能靠工具创建时带一次，界面改不了 ⇒ "依赖"成了创建一刻的一次性事实。
      // 校验三关：① 自环/间接环**直接拒**（成环则两者永不启动，是死锁而非调度）；② 同项目（跨项目依赖无意义）；
      // ③ 不存在的 id **允许写入但如实标注**（真库已有 `depends_on='T1'` 这类笔误，M3-2 裁定：不等待 + 如实）。
      if (depends_on !== undefined) {
        const self = db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(id) as { project_id: string } | undefined;
        if (!self) return { error: { code: 'NOT_FOUND', message: '任务不存在' } };
        const depIds = parseDepIds(depends_on);
        const cycleAt = introducesCycle(db as never, id, depIds);
        if (cycleAt) return { error: { code: 'BAD_REQUEST', message: `前置依赖成环（经 ${cycleAt.slice(0, 8)}）——成环后双方都不会启动，请改选` } };
        const missing: string[] = [];
        const foreign: string[] = [];
        for (const depId of depIds) {
          const row = db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(depId) as { project_id: string } | undefined;
          if (!row) missing.push(depId);
          else if (row.project_id !== self.project_id) foreign.push(depId);
        }
        if (foreign.length > 0) return { error: { code: 'BAD_REQUEST', message: `前置须属同一项目，以下任务不属于本项目：${foreign.map((x) => x.slice(0, 8)).join('、')}` } };
        sets.push('depends_on = ?');
        params.push(depIds.join(','));
        if (missing.length > 0) {
          db.prepare('INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?, ?, ?, ?)').run(
            crypto.randomUUID(), id, 'system',
            `[依赖] 前置任务不存在：${missing.join('、')} —— 不阻塞调度（请核对是否写错 id）。`,
          );
        }
      }
      if (sets.length === 0) return { error: { code: 'BAD_REQUEST', message: '无有效字段' } };
      sets.push("updated_at = datetime('now')");
      params.push(id);
      db.prepare(`UPDATE wa_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      const data = db.prepare('SELECT * FROM wa_tasks WHERE id = ?').get(id);
      return { data };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // 任务上下文
  ipcMain.handle('task:context', async (_event, { id, context }: { id: string; context?: Record<string, unknown> }) => {
    try {
      if (context) {
        const existing = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string } | undefined;
        if (!existing) return { error: { code: 'NOT_FOUND', message: '任务不存在' } };
        const merged = { ...(JSON.parse(existing.context_json || '{}')), ...context };
        db.prepare("UPDATE wa_tasks SET context_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(merged), id);
      }
      const task = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string } | undefined;
      if (!task) return { error: { code: 'NOT_FOUND', message: '任务不存在' } };
      return { data: JSON.parse(task.context_json || '{}') };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // 任务事件时间线
  ipcMain.handle('task:events', async (_event, { id }: { id: string }) => {
    try {
      const events = db.prepare(
        "SELECT * FROM wa_event_log WHERE aggregate_id = ? ORDER BY occurred_at DESC LIMIT 50"
      ).all(id);
      return { data: events };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // 产出物更新
  ipcMain.handle('deliverable:update', async (_event, { id, name, description }: {
    id: string; name?: string; description?: string
  }) => {
    try {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (name !== undefined) { sets.push('name = ?'); params.push(name); }
      if (description !== undefined) { sets.push('description = ?'); params.push(description); }
      if (sets.length === 0) return { error: { code: 'BAD_REQUEST', message: '无有效字段' } };
      params.push(id);
      db.prepare(`UPDATE wa_deliverables SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      // zx_20260911_2 M4-G6: 手工改名/描述补发状态事件(状态未变, 供 GUI 引用刷新)；status 取本行实际值, 不假装流转。
      const urow = loadDeliverableRow(db, id);
      if (urow) emitDeliverableEvent(urow, urow.old_status, 'manual:update', urow.old_status);
      const data = db.prepare('SELECT * FROM wa_deliverables WHERE id = ?').get(id);
      return { data };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // zx_20260908 M2(B2b): 主要成果标记切换（is_primary 0/1，人工可标；供产出物页星标与项目成果交付单聚合）
  ipcMain.handle('deliverable:setPrimary', async (_event, { id, primary }: { id: string; primary?: boolean }) => {
    try {
      const d = db.prepare('SELECT id, project_id, task_id FROM wa_deliverables WHERE id = ?').get(id) as { id: string; project_id: string; task_id: string | null } | undefined;
      if (!d) return { error: { code: 'NOT_FOUND', message: '产出物不存在' } };
      const flag = primary ? 1 : 0;
      // zx_20260911_2 M4-G1: ★ 是互斥谓词——置位前在同一作用域(任务内 / 手工按项目)清掉兄弟 ★，避免同组并出多个 ★。
      // 只在"置位"时清兄弟；撤位(false)只影响本行。实现见 deliverable-lifecycle.applyPrimary(与受控回归共用)。
      applyPrimary(db, d, flag);
      // zx_20260911_2 M4-G6: ★ 变更补发状态事件(供交付单★段/产出物页即时刷新)。
      const prow = loadDeliverableRow(db, id);
      if (prow) emitDeliverableEvent(prow, prow.old_status, 'manual:set_primary', prow.old_status);
      return { data: { id, is_primary: flag, updated: true } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // 产出物运行时信息
  ipcMain.handle('deliverable:runtime', async (_event, id: string) => {
    try {
      const d = db.prepare('SELECT * FROM wa_deliverables WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!d) return { error: { code: 'NOT_FOUND', message: '产出物不存在' } };
      // zx_20260929 M12: a2a 的活进程记在 `a2a-runtime.ts` 自己的表里，**不在** `runtimeProcesses` ⇒
      // 此前本句只查 `runtimeProcesses`、再拿 `d.status === 'running'` 兜底，对 a2a 恒有
      // `port/endpoint = null`；更要命的是：a2a 子进程死了（此前无人记账）DB 仍写 `running`
      // ⇒ GUI 一直显示"运行中"。现 a2a 直接问运行时本尊，端口/端点与存活都以**真进程**为准。
      if (d.type === 'a2a') {
        const { getA2AServerStatus } = await import('../core/a2a-runtime.js');
        const st = getA2AServerStatus(id);
        return { data: {
          id, status: st.running ? 'running' : d.status,
          running: st.running,
          port: st.port ?? null,
          endpoint: st.endpoint ?? null,
          startedAt: st.startedAt ?? null,
        }};
      }
      const rt = runtimeProcesses.get(id);
      // 2层检测：内存追踪 → DB状态兜底
      const running = !!rt || d.status === 'running';
      return { data: {
        id, status: running ? 'running' : d.status,
        running,
        port: rt?.port || null,
        endpoint: rt?.endpoint || null,
      }};
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // Daemon 自动启动
  autoStartDaemons(db);
  // C2: 启动时收养运行中的 MCP 孤儿进程（恢复跨会话幸存的服务）
  adoptMCPOrphans(db);

  // D2: 守护进程健康检查心跳（实现单一真源在 daemon-supervisor）
  startDaemonHealthCheck(db);

  // ===== C3: 矛盾张力面板 =====
  ipcMain.handle('project:tensions', async (_event, { id }: { id: string }) => {
    try {
      const tensions = getTensions(db, id);
      return { data: { tensions, configs: TENSION_CONFIGS } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });
  ipcMain.handle('project:updateTension', async (_event, { id, tensionId, position, autoAdjust }: { id: string; tensionId: string; position?: number; autoAdjust?: boolean }) => {
    try {
      const tension = updateTension(db, id, tensionId, { position, autoAdjust });
      return { data: tension };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // ===== 成员管理 =====
  ipcMain.handle('project:members', async (_event, { id }: { id: string }) => {
    try {
      return { data: projects.getMembers(id) };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });
  ipcMain.handle('project:addMember', async (_event, { id, userId, role }: { id: string; userId: string; role?: string }) => {
    try {
      projects.addMember(id, userId, role || 'developer');
      return { data: projects.getMembers(id) };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // ===== 相似任务面板 =====
  ipcMain.handle('task:similar', async (_event, { id, projectId }: { id: string; projectId: string }) => {
    try {
      // 基于 task_embedding 余弦相似度（无需 MemoryManager 实例）
      const target = db.prepare('SELECT context_json, title FROM wa_tasks WHERE id = ?').get(id) as { context_json: string; title: string } | undefined;
      if (!target) return { data: [] };
      let targetEmb: number[] = [];
      try { targetEmb = JSON.parse(target.context_json || '{}').task_embedding as number[]; } catch {}
      const candidates = db.prepare("SELECT id, title, status, context_json FROM wa_tasks WHERE project_id = ? AND id != ? AND status = 'completed' AND context_json LIKE '%task_embedding%' ORDER BY updated_at DESC LIMIT 100").all(projectId, id) as Array<{ id: string; title: string; status: string; context_json: string }>;
      const scored: Array<{ id: string; title: string; status: string; similarity: number }> = [];
      for (const c of candidates) {
        let emb: number[] = [];
        try { emb = JSON.parse(c.context_json || '{}').task_embedding as number[]; } catch {}
        if (targetEmb.length > 0 && emb.length === targetEmb.length) {
          let dot = 0, a = 0, b = 0;
          for (let i = 0; i < emb.length; i++) { dot += emb[i]! * targetEmb[i]!; a += emb[i]! * emb[i]!; b += targetEmb[i]! * targetEmb[i]!; }
          const sim = a > 0 && b > 0 ? dot / (Math.sqrt(a) * Math.sqrt(b)) : 0;
          scored.push({ id: c.id, title: c.title, status: c.status, similarity: Math.round(sim * 100) / 100 });
        }
      }
      scored.sort((x, y) => y.similarity - x.similarity);
      return { data: scored.slice(0, 5) };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // ===== 模板任务 =====
  ipcMain.handle('task:templates', async () => {
    try {
      // B1: 从 DB 模板池返回（含用户自定义模板）
      return { data: loadTemplatePool(db).map(t => ({ id: t.id, name: t.name, category: t.category, description: t.description })) };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // ===== M10 (zx_20261002): 自动模板质量门台账（**只读**）——回答"自动模板为何为 0、卡在哪一级"
  //   判据/计数一律来自 `core/task-templates.ts` 的 `describeAutoTemplateGates`（与生成路共用同一次评估，
  //   不在此重写一份 SQL）；读取失败**不吞**，走统一 error 让界面如实显示。
  ipcMain.handle('template:auto-gate', async () => {
    try { return { data: describeAutoTemplateGates(db) }; }
    catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // ===== M11 (zx_20261002): 项目调用记账（**只读**聚合）——MCP 调用/A2A 启动/守护进程启动 的成败与耗时。
  //   读取只走 `core/service-call-ledger.ts` 的 `describeServiceCalls`（**不在此重写 SQL**）；
  //   本通道**只读**，界面每次刷新都不写库。失败如实报错，不吞成空表。
  ipcMain.handle('service-calls:project', async (_event, projectId: string) => {
    try { return { data: describeServiceCalls(db, projectId || '') }; }
    catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // ===== B1: 任务模板管理 IPC（增改删；system 内置模板删除被拒但可禁用/编辑）=====
  ipcMain.handle('template:list', async () => {
    try {
      // B3: 附带历史成功率（按模板聚合父任务成败，与 ensurePool 口径一致）
      const rows = db.prepare(`
        SELECT t.*,
          (SELECT CASE WHEN COUNT(*) = 0 THEN NULL ELSE ROUND(1.0 * SUM(CASE WHEN wt.status = 'completed' THEN 1 ELSE 0 END) / COUNT(*), 4) END
           FROM wa_tasks wt
           WHERE wt.parent_task_id = '' AND wt.status IN ('completed','failed') AND wt.context_json LIKE '%"template":"' || t.id || '"%') as success_rate
        FROM wa_task_templates t
        ORDER BY t.priority DESC, t.created_at DESC
      `).all() as Array<Record<string, unknown>>;
      return { data: rows.map(r => ({ ...r, subtasks: JSON.parse(r.subtasks as string), keywords: JSON.parse(r.keywords as string) })) };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // ===== B3: 模板匹配测试（zx_20260924 缺陷C: 口径**真**归一处 —— 调的就是 `task:create` 调的那个
  //   `decideTemplateMatch`。此前这里把整段文本当"标题"喂给 matchTemplate、连守卫都不跑，
  //   却挂着「与任务创建同口径」的牌子 —— 于是"测试说会拆"和"创建时真拆"是两回事，测试结果不能信）=====
  ipcMain.handle('template:test', async (_event, { title, description }: { title?: string; description?: string }) => {
    try {
      const titleText = (title || '').trim();
      const descText = (description || '').trim();
      if (!titleText && !descText) return { data: { matched: null, skip: null } };
      const decision = decideTemplateMatch(db, titleText, descText);
      let tpl = decision.hit?.template ?? null;
      const hitKeywords: string[] = decision.hit?.hitKeywords ?? [];
      const field = decision.hit?.field ?? '';
      let method = decision.hit ? 'keyword' : '';
      let similarity: number | null = null;
      // 与 task:create 一致：**判定要拆**才有下文；关键词未命中才走语义兜底
      if (!decision.skip && !tpl) {
        const mem = memoryGetter?.();
        if (mem) {
          try {
            const textEmb = await mem.embedText(decision.semanticText);
            if (textEmb && textEmb.length > 0) {
              const templateEmbs = await getTemplateEmbeddings(db, (t) => mem.embedText(t));
              const semantic = matchTemplateSemantic(textEmb, templateEmbs);
              if (semantic) { tpl = semantic.template; method = 'semantic'; similarity = Math.round(semantic.similarity * 100) / 100; }
            }
          } catch { /* 语义匹配失败 */ }
        }
      }
      return { data: {
        matched: tpl ? { id: tpl.id, name: tpl.name, category: tpl.category, priority: tpl.priority ?? 0, success_rate: tpl.success_rate ?? null, hitKeywords, method, similarity, field, subtaskCount: tpl.subtasks.length } : null,
        // skip 非空 = 真创建时**不会**拆（"会命中谁"仍一并返回，好让界面说清"为什么不拆"）
        skip: decision.skip,
      } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('template:create', async (_event, body: { name: string; category?: string; description?: string; subtasks?: Array<{ title: string; description: string; acceptance_criteria: string }>; keywords?: string[]; priority?: number }) => {
    try {
      if (!body.name?.trim()) return { error: { code: 'BAD_REQUEST', message: '模板名称必填' } };
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO wa_task_templates (id, name, category, description, subtasks, keywords, status, priority, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, body.name, body.category || 'custom', body.description || '', JSON.stringify(body.subtasks ?? []), JSON.stringify(body.keywords ?? []), 'active', body.priority ?? 0, 'user');
      loadTemplatePool(db);
      return { data: { id, name: body.name } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('template:update', async (_event, { id, ...body }: { id: string; name?: string; category?: string; description?: string; subtasks?: Array<{ title: string; description: string; acceptance_criteria: string }>; keywords?: string[]; priority?: number; status?: string }) => {
    try {
      const existing = db.prepare('SELECT id FROM wa_task_templates WHERE id = ?').get(id) as { id: string } | undefined;
      if (!existing) return { error: { code: 'NOT_FOUND', message: '模板不存在' } };
      const sets: string[] = [];
      const vals: (string | number)[] = [];
      if (body.name !== undefined) { sets.push('name = ?'); vals.push(body.name); }
      if (body.category !== undefined) { sets.push('category = ?'); vals.push(body.category); }
      if (body.description !== undefined) { sets.push('description = ?'); vals.push(body.description); }
      if (body.subtasks !== undefined) { sets.push('subtasks = ?'); vals.push(JSON.stringify(body.subtasks)); }
      if (body.keywords !== undefined) { sets.push('keywords = ?'); vals.push(JSON.stringify(body.keywords)); }
      if (body.priority !== undefined) { sets.push('priority = ?'); vals.push(body.priority); }
      if (body.status !== undefined) { sets.push('status = ?'); vals.push(body.status); }
      if (sets.length === 0) return { error: { code: 'BAD_REQUEST', message: '无更新字段' } };
      sets.push("updated_at = datetime('now')");
      db.prepare(`UPDATE wa_task_templates SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
      invalidateTemplateEmbedding(id);
      loadTemplatePool(db);
      return { data: { id } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('template:delete', async (_event, { id }: { id: string }) => {
    try {
      const tpl = db.prepare('SELECT source FROM wa_task_templates WHERE id = ?').get(id) as { source: string } | undefined;
      if (!tpl) return { error: { code: 'NOT_FOUND', message: '模板不存在' } };
      if (tpl.source === 'system') return { error: { code: 'PROTECTED', message: '系统内置模板不可删除，可编辑或禁用' } };
      db.prepare("UPDATE wa_task_templates SET status = 'disabled', updated_at = datetime('now') WHERE id = ?").run(id);
      invalidateTemplateEmbedding(id);
      loadTemplatePool(db);
      return { data: { id, status: 'disabled' } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // ===== 任务执行追踪（observability.getExecutionTrace）=====
  ipcMain.handle('task:trace', async (_event, { id }: { id: string }) => {
    try {
      const { getExecutionTrace } = await import('../core/observability.js');
      return { data: getExecutionTrace(db, id) };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // ===== A2A 服务列表（a2a-runtime.listA2AServers）=====
  ipcMain.handle('deliverable:a2a-list', async () => {
    try {
      const { listA2AServers } = await import('../core/a2a-runtime.js');
      return { data: listA2AServers() };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // ===== 手动注册到 ANS =====
  ipcMain.handle('deliverable:register', async (_event, id: string) => {
    try {
      const deliv = db.prepare('SELECT id, name, type, file_path FROM wa_deliverables WHERE id = ?').get(id) as { id: string; name: string; type: string; file_path: string | null } | undefined;
      if (!deliv) return { error: { code: 'NOT_FOUND', message: '产出物不存在' } };
      if (deliv.type !== 'mcp' && deliv.type !== 'a2a') return { error: { code: 'INVALID_TYPE', message: '仅 MCP/A2A 类型可注册到 ANS' } };
      // zx_20260929 M2: A2A 端点从运行态取实况（端口是动态分配的，兜底常量会登错端口；未在跑则回落常量）。
      let endpointOverride: string | undefined;
      if (deliv.type === 'a2a') {
        try { const { getA2AServerStatus } = await import('../core/a2a-runtime.js'); endpointOverride = getA2AServerStatus(deliv.id).endpoint; } catch { /* 取不到则回落 */ }
      }
      await registerToAns(db, deliv.id, deliv.name, deliv.type, '', '', endpointOverride);
      // zx_20260906 批1: 注册成功 → 状态推进 registered 并发射 deliverable.registered（填此前无 producer 的死事件）
      setDeliverableStatus(db, deliv.id, 'registered', 'deliverable:register');
      return { data: { id, registered: true } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // ===== V3: 多维度项目健康视图（投资人/开发者/管理者）=====
  ipcMain.handle('project:healthViews', async (_event, { id }: { id: string }) => {
    try {
      const stats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed FROM wa_tasks WHERE project_id = ?").get(id) as { total: number; completed: number; failed: number };
      const totalCost = (db.prepare("SELECT COALESCE(SUM(CAST(json_extract(t.context_json, '$.cost_estimate.cost') AS REAL)), 0) as total FROM wa_tasks t WHERE t.project_id = ?").get(id) as { total: number }).total;
      // zx_20260911_2 M4-G4: 与项目卡/全景同口径——排除 retired 与探针（此前裸 COUNT(*) 把软退休旧成果与临时脚本也算进"产出物"）。
      // zx_20260930 M4-1: 计数走共享真源。
      const delivCount = countDeliverables(db, { projectId: id });
      const errorRate = (db.prepare("SELECT COALESCE(AVG(CAST(json_extract(t.context_json, '$.failure_record.tool_count') AS REAL)), 0) as avg FROM wa_tasks t WHERE t.project_id = ? AND t.status = 'failed'").get(id) as { avg: number }).avg;
      const weekTasks = db.prepare("SELECT status FROM wa_tasks WHERE project_id = ? AND updated_at > datetime('now', '-7 days')").all(id) as Array<{ status: string }>;
      const weekCompleted = weekTasks.filter(t => t.status === 'completed').length;
      const velocity = weekTasks.length > 0 ? Math.round(weekCompleted / weekTasks.length * 100) : 0;
      const blockedCount = (db.prepare("SELECT COUNT(*) as c FROM wa_tasks WHERE project_id = ? AND status = 'paused'").get(id) as { c: number }).c;
      // zx_20260930 M11-7: 「待办搁置」账——**为什么这些 pending 任务没被自动拉起**。
      //   此前 `scanReadyTasks` 对"项目非 active / 不在活跃时段"的项目直接跳过，**只在日志里留一句**，
      //   用户在 GUI 上看到的就是"有任务、状态待执行、但永远不动"，无从知道是项目停着还是调度漏类。
      //   判据走 `projectScanVerdict`（与调度器**同一份**），不在这里手抄第二版"什么算不扫"。
      const projRow = db.prepare('SELECT status, context_json FROM wa_projects WHERE id = ?').get(id) as { status: string; context_json: string | null } | undefined;
      const parkedTaskCount = (db.prepare(
        `SELECT COUNT(*) as c FROM wa_tasks WHERE project_id = ? AND status IN (${PROJECT_PARKED_STATUSES.map(() => '?').join(',')})`,
      ).get(id, ...PROJECT_PARKED_STATUSES) as { c: number }).c;
      const scanVerdict = projectScanVerdict(projRow ?? {}, new Date());
      const total = stats.total || 1;
      const toScore = (v: number, max: number) => Math.min(100, Math.max(0, Math.round(v / Math.max(max, 1) * 100)));
      return { data: {
        investor: { roi: toScore(delivCount * 10, totalCost + 0.01), costEfficiency: toScore(delivCount, totalCost + 0.01), valueDeliveryRate: toScore(stats.completed, stats.total), score: Math.round((toScore(delivCount * 10, totalCost + 0.01) + toScore(delivCount, totalCost + 0.01) + toScore(stats.completed, total)) / 3) },
        developer: { codeQuality: toScore(total - stats.failed, total), toolHealth: 100 - toScore(errorRate, 5), technicalDebt: Math.round(stats.failed / total * 100), errorRate: Math.round(errorRate), score: Math.round(((100 - toScore(errorRate, 5)) + toScore(total - stats.failed, total)) / 2) },
        manager: { velocity, resourceUtilization: velocity, deadlineRisk: toScore(blockedCount, total), blockedTaskCount: blockedCount, score: Math.round((velocity + (100 - toScore(blockedCount, total))) / 2),
          // 待办搁置：`parkedTaskCount` 只在**项目当前不参与自动调度**时才有意义，故与 `scanVerdict.scan` 一起给出——
          // 单看条数会让人以为"调度器漏了"，单看原因会让人以为"一格都没有"。
          parkedTaskCount: scanVerdict.scan ? 0 : parkedTaskCount,
          parkedReason: scanVerdict.scan ? '' : scanVerdict.reason,
        },
      }};
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // ===== V4: 项目知识全景（已知+未知）=====
  ipcMain.handle('project:knowledgePanorama', async (_event, { id }: { id: string }) => {
    try {
      // zx_20260930 M8: 全景是**常规面**（知识构成），墓碑不计入——它的去向在记忆页的审计筛选里。
      const memStats = db.prepare(`SELECT memory_type, COUNT(*) as cnt FROM wa_memories WHERE project_id = ? AND ${MEM_LIVE_SQL} GROUP BY memory_type`).all(id) as Array<{ memory_type: string; cnt: number }>;
      const memByType: Record<string, number> = {};
      for (const m of memStats) memByType[m.memory_type] = m.cnt;
      const totalMem = Object.values(memByType).reduce((a, b) => a + b, 0);
      const maxImportance = (db.prepare(`SELECT COALESCE(MAX(importance), 0) as mx FROM wa_memories WHERE project_id = ? AND ${MEM_LIVE_SQL}`).get(id) as { mx: number }).mx;
      const predStats = db.prepare('SELECT predicate, COUNT(*) as cnt FROM wa_knowledge_triples WHERE project_id = ? GROUP BY predicate ORDER BY cnt DESC LIMIT 10').all(id) as Array<{ predicate: string; cnt: number }>;
      const totalTriples = predStats.reduce((a, b) => a + b.cnt, 0);
      const topEntities = db.prepare('SELECT subject as name FROM wa_knowledge_triples WHERE project_id = ? GROUP BY subject ORDER BY COUNT(*) DESC LIMIT 8').all(id) as Array<{ name: string }>;
      // zx_20260906 批3 (3c): 排除 retired（软退休旧成果不入全景）；补 daemon 类型；recent 扩为跨类型最近产出物(≤5)
      // zx_20260906_1 3c: 全景统计排除临时脚本(doc 探针)——与 finalize 临时脚本自检同口径，避免把 _verify/_probe/_tmp/test_<hash>.py 当成果
      // zx_20260909_1 补④(§十三): 谓词收敛到共享 docNotProbe('')(不再内联重复 SQL, 四处口径同源)
      // zx_20260930 M4-1: 分组计数走共享真源（空类型归 'other'，与项目卡同尺）。
      const delivStats = countDeliverablesByType(db, { projectId: id }).map((g) => ({ type: g.type, cnt: g.c }));
      const delivByType: Record<string, number> = {};
      for (const d of delivStats) delivByType[d.type] = d.cnt;
      // zx_20260906_1 3c: 最近产出物列表同样排除临时脚本——与 byType 计数同口径，temp 探针不作为"成果"呈现
      // zx_20260909_1 补④(§十三): 同收敛到 docNotProbe('')
      // zx_20260930 M4-1: 范围声明走共享真源（与上方 byType 计数同范围）。
      const pScope = deliverableScopeSql({ projectId: id });
      const recentDeliverables = db.prepare(`SELECT id, name, type, status, created_at FROM wa_deliverables WHERE ${pScope.sql} ORDER BY created_at DESC LIMIT 5`).all(...pScope.params) as Array<{ id: string; name: string; type: string; status: string; created_at: string }>;
      const taskPatterns = db.prepare("SELECT COUNT(*) as total, COALESCE(AVG(CAST(json_extract(context_json, '$.execution_metrics.stepsUsed') AS REAL)), 0) as avgSteps, COALESCE(SUM(CAST(json_extract(context_json, '$.cost_estimate.tokens') AS REAL)), 0) as totalTokens FROM wa_tasks WHERE project_id = ? AND status = 'completed'").get(id) as { total: number; avgSteps: number; totalTokens: number };
      const archetypeStats = db.prepare("SELECT COALESCE(json_extract(context_json, '$.archetype'), 'unknown') as atype, COUNT(*) as cnt FROM wa_tasks WHERE project_id = ? AND status = 'completed' AND json_extract(context_json, '$.archetype') IS NOT NULL GROUP BY atype").all(id) as Array<{ atype: string; cnt: number }>;
      const byArchetype: Record<string, number> = {};
      for (const a of archetypeStats) byArchetype[a.atype] = a.cnt;
      const allArchetypes = [
        { archetype: 'code', label: '编码实现', suggestion: '编写/修改代码、修复bug、重构' },
        { archetype: 'research', label: '调查研究', suggestion: '分析代码库、技术调研、信息搜索' },
        { archetype: 'document', label: '文档生成', suggestion: '报告、方案文档、技术文档' },
        { archetype: 'analysis', label: '数据分析', suggestion: '数据处理、统计分析、建模' },
        { archetype: 'configuration', label: '配置部署', suggestion: '环境搭建、服务部署、配置管理' },
        { archetype: 'conversation', label: '对话咨询', suggestion: '技术咨询、方案讨论、答疑' },
      ];
      const executedArchetypes = new Set(Object.keys(byArchetype));
      const missingArchetypes = allArchetypes.filter(a => !executedArchetypes.has(a.archetype)).map(a => ({ archetype: a.archetype, label: a.label, suggestion: a.suggestion }));
      return { data: {
        projectId: id,
        generatedAt: new Date().toISOString(),
        memorySummary: { total: totalMem, byType: { episodic: memByType.episodic || 0, semantic: memByType.semantic || 0, procedural: memByType.procedural || 0, failure_knowledge: memByType.failure_knowledge || 0, subagent_experience: memByType.subagent_experience || 0 }, topImportance: maxImportance },
        graphSummary: { totalTriples, predicateDistribution: predStats.map(p => ({ predicate: p.predicate, count: p.cnt })), topEntities: topEntities.map(e => ({ name: e.name, connections: 0 })) },
        // zx_20260913 M2-4(管子·度量衡·同一把尺): byType 由**字面量清单**改为**直接展开 GROUP BY type 的结果**——
        // 此前清单漏了 code ⇒ 真库 total 85 而 Σ chips 81(总数与分项**两把尺**)。展开后 total 与 chips 恒同源，
        // 日后新增类型也不必再改此处(量尺只有一把)。
        deliverableSummary: { total: Object.values(delivByType).reduce((a, b) => a + b, 0), byType: { ...delivByType }, recentDeliverables },
        executionSummary: { totalTasks: taskPatterns.total, avgSteps: Math.round(taskPatterns.avgSteps), totalTokens: taskPatterns.totalTokens, byArchetype },
        missingArchetypes,
        // zx_20261003 M4（柏拉图·洞穴喻 / 黑格尔·合理才存在）: 补最后两源——调用账（事件流水）与
        //   运行面（守护/作业的**当前存量**），使全景从"记忆的影子"成为"项目全貌"。
        //   两者**不是同一件事**（流水 vs 存量），故各自成键，不合并（理由见 `project-runtime-summary.ts` 头注释）。
        //   ⚠ 只读：本 handler 每次刷新都不写库。`wa_service_calls` 0 行 ⇒ `total:0` 是**如实**值（"未发生"），
        //     不是缺省——渲染层据此写"未发生"，不伪造（见 M6）。
        serviceCallSummary: describeServiceCalls(db, id),
        runtimeSummary: describeProjectRuntime(db as never, id),
      }};
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  console.log('[IPC] Project/Task/Deliverable handlers registered');
}

/** 启动后自动注册 MCP/A2A 服务到 ANS（含智能查重 D1-D4）。
 *  `endpointOverride`（zx_20260929 M2）：调用方**知道实际端点**时传入——A2A 的端口是从 19950 起动态分配的，
 *  静默用兜底常量会把「不是那个端口」的服务登记成在册端点。
 *
 *  zx_20260929 M10（实机 E2E 打出来的两条；此前全绿照不出，因 rr 够不着本文件——顶层 import electron）：
 *  ① **没签名**：本节用裸 `fetch` 只发 `x-api-key`，而 ANS 的 `/api/v1/*` 全挂在 `hmacAuth` 下
 *     （`apps/ans-server/src/index.ts`）⇒ 实测 **401 Missing authentication headers**。且失败**静默**：
 *     `fetch` 对 401 不抛、查重 GET 的 401 又被 `catch` 吞成 `null` ⇒ 连 `console.warn` 都不响、
 *     `registry_id` 静默留空（「注册失败」与「本来就没注册」在返回值上不可分）。
 *  ② **A2A 载荷形状不对**：`routes/a2a.ts` 的 POST/PUT body 是 `t.Object({ name, agent_card_url })`，
 *     而这里一律发 `{ name, endpoint, transport }` ⇒ 实测 **422**
 *     （`Expected property 'agent_card_url' to be string but found: undefined`）。
 *     MCP 侧（`routes/mcp.ts`）要的正是 `endpoint`/`transport`，故**只有 A2A 有第二病**。
 *  签名式样归**一处真源** `createHmacSignature`（`@worker-ant/ans-client`，与 `AnsClient.request` 同尺）——
 *  本函数只负责把三个头装上。A2A 的 agent card 地址仍由 **ANS 自己的** `getAgentCardUrl` 派生（传端点即可；
 *  已是 card URL 的原样透传）。
 *
 *  zx_20260930 M9：上述"本函数只负责把三个头装上"**已不再成立**——三头齐备这件事连同身份解析、
 *  超时、重试，全收到 `core/ans-signed-request.ts`（本函数内那层闭包出不了本函数，外面三条路够不着它，
 *  故它曾长期是**孤本**）。此处只剩一层薄适配；A2A/MCP 载荷形状与查重 D1-D4 一字未动。 */
async function registerToAns(db: Database.Database, id: string, name: string, type: string, workingDir: string, entryFile: string, endpointOverride?: string): Promise<void> {
  // zx_20260930 M9: 身份解析与签名式样**都归真源**（原先此处手抄了第二份"DB→env→缺省"，
  //   且 secret 缺省写成 `''` —— 空 secret 签出的头必然不符，只是把 401 换了张脸）。
  //   本函数内的 `ansFetch` 从此只是**真源的一层薄适配**（调用点保持 `Response` 形状不变）。
  const creds = resolveAnsCreds(db);
  const endpoint = endpointOverride || `http://localhost:${type === 'mcp' ? '19900' : '19950'}/${type}`;

  // 载荷形状**按类型的路由 schema 定**（不按"我们希望 ANS 收什么"定）：A2A 认 `agent_card_url`，MCP 认 `endpoint`。
  const postBody = (): Record<string, unknown> => type === 'a2a'
    ? { name, agent_card_url: endpoint }
    : { name, endpoint, transport: 'streamable-http' };
  const putBody = (): Record<string, unknown> => type === 'a2a'
    ? { name, agent_card_url: endpoint }
    : { name, endpoint, transport: 'streamable-http', status: 'active' };

  /** 带 HMAC 的 ANS 请求——**薄适配**：真正的签名/超时/重试在 `core/ans-signed-request.ts` 一处写。 */
  const ansFetch = async (path: string, method: string, bodyObj?: Record<string, unknown>): Promise<AnsRequestResult> =>
    ansSignedRequest(creds, path, { method, body: bodyObj, timeoutMs: 5000 });

  // 查重逻辑：找到 ANS 中已存在的服务（精确名 → 端点 → 模糊名）
  const findExisting = async (): Promise<{ id: string } | null> => {
    try {
      const listResp = await ansFetch(`/api/v1/${type}?all=1`, 'GET');
      // zx_20260930 M9: 失败要显形——此前这条 401 被吞成 `null`，「注册失败」与「本来就没注册」不可分。
      if (!listResp.ok) { console.warn(`[ANS] 查重失败: ${name} — ${ansFailureNote(listResp)}`); return null; }
      const listData = await listResp.response!.json() as { data?: Array<{ id: string; name: string; endpoint?: string; agent_card_url?: string }> };
      const all = listData.data || [];
      // D1/D2: 精确名匹配 → 端点匹配（最可靠）。⚠ A2A 的行**没有 `endpoint` 列**（只有 `agent_card_url`），
      //   故端点比较取 `endpoint ?? agent_card_url`——否则该分支在 A2A 上恒假，"最可靠"只写在注释里。
      const byName = all.find(s => s.name === name);
      if (byName) return byName;
      const byEndpoint = all.find(s => (s.endpoint ?? s.agent_card_url) === endpoint);
      if (byEndpoint) return byEndpoint;
      // D3: 名称模糊匹配
      const byFuzzy = all.find(s => name.includes(s.name) || s.name.includes(name));
      return byFuzzy || null;
    } catch { return null; }
  };

  const logRegistered = (verb: string, registryId: string) => {
    db.prepare('UPDATE wa_deliverables SET registry_id = ? WHERE id = ?').run(registryId, id);
    console.log(`[ANS] ${verb}: ${name} (id=${registryId})`);
  };

  try {
    const existing = await findExisting();

    if (existing) {
      // 已有 → 更新端点 + 启用
      const upd = await ansFetch(`/api/v1/${type}/${existing.id}`, 'PUT', putBody());
      if (!upd.ok) { console.warn(`[ANS] 注册失败: ${name} — PUT ${ansFailureNote(upd)}`); return; }
      logRegistered('已更新注册', existing.id);
      return;
    }

    // 新建 → POST，D4: UNIQUE 冲突时重新 findExisting 再更新
    const createResp = await ansFetch(`/api/v1/${type}`, 'POST', postBody());
    if (createResp.ok) {
      const created = await createResp.response!.json() as { data?: { id: string } };
      if (created.data?.id) { logRegistered('已注册新服务', created.data.id); return; }
      console.warn(`[ANS] 注册失败: ${name} — POST ${createResp.status} 但回包无 data.id`);
      return;
    }
    if (createResp.status === 409 || createResp.status === 500) {
      // D4: UNIQUE 冲突 → 重新查重并更新（并发创建时可能已存在）
      const retry = await findExisting();
      if (retry) {
        const upd = await ansFetch(`/api/v1/${type}/${retry.id}`, 'PUT', putBody());
        if (!upd.ok) { console.warn(`[ANS] 注册失败: ${name} — PUT(冲突重试) ${ansFailureNote(upd)}`); return; }
        logRegistered('冲突重试后更新', retry.id);
        return;
      }
    }
    console.warn(`[ANS] 注册失败: ${name} — POST ${ansFailureNote(createResp)}`);
  } catch (e) {
    console.warn(`[ANS] 注册失败(可忽略): ${name}`, (e as Error).message);
  }
}
