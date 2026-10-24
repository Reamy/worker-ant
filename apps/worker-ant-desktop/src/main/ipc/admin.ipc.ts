import { ipcMain, BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { runAllInvariants, repairInvariant } from '../core/architectural-invariants.js';
import { getToolFrequencyStats, getFailureClusters } from '../core/observability.js';
import { eventBus } from '../core/event-bus.js';
import type { MemoryManager, MemoryEntry } from '../core/memory-manager.js';
import { projectQualityStats, buildPlanMilestoneLine } from '../core/project-analytics.js';
import { resolveTaskMilestoneLink, resolveMilestoneImplementer, backfillDescendantSchemeRef } from '../core/task-accounting.js';
import { imChannelEnabledSql } from '../core/im/im-channel-status.js';
// zx_20260914 M2-3①(罗尔斯·同一把尺): doc 探针判据的**唯一实现**（方案原文称之为"第三份手抄"，
//   实测为两处内联拷贝 :52/:176）——本文件改为引用，不再自带副本。
// zx_20260930 M4-1(管子·度量衡): 进一层——**谓词的组合方式**（退休 + 探针 + 归属）也收敛到
//   共享真源，本文件两处读点各自只声明"要哪个范围"，不再手拼 WHERE。
import { countDeliverables, deliverableScopeSql } from '../core/deliverable-lifecycle.js';
// zx_20260920_1 M7: 本文件有 3 处「新建记忆」的 INSERT（GUI 偏好页）+ 1 处降权，刻度统一取自真源。
import { MEM_IMPORTANCE_DEFAULT, MEM_SOURCE_USER_CORRECTION } from '../core/memory-constants.js';
// zx_20260930 M8: 删除改**落墓碑**（缘由词表 + 写入语句形状 + 读取谓词同出该模块）。
import { MEM_DELETE_REASONS, MEM_LIVE_SQL, tombstoneMemory } from '../core/memory-lifecycle.js';
// zx_20261012_1 批一（M29）: 记忆子系统失败计数快照上屏（如实排障口径；**不新增 GUI 卡片**）。
import { memoryFailureSnapshot } from '../core/memory-failure.js';
// zx_20261018_3 批一: 记忆注入账的读者（`source='memory'` 的明细行 + 主动引用分账）。
import { memoryInjectionStats } from '../core/memory-injection-stats.js';
// zx_20260924_1 M6（F7）: 自省两本账的读取面——审查报表与自愈日志此前只写不读，现由诊断页消费。
import { readLatestSimplificationReport } from '../core/simplification-audit.js';
import { readRecentHealingLogs, logHealthTransitions, logInvariantTransitions } from '../core/self-healing-monitor.js';
// zx_20261022_2 批二: 「卡住」计数须对两种时刻写法用同一把尺（ISO 行此前恒不命中）。
import { utcSql } from '../core/sql-time.js';
// zx_20261016_3 批四（M34）：自产提案的人工闸。**核心零依赖**（只 import better-sqlite3/crypto）
//   ⇒ 判断逻辑全在 core，本层只转发——面板与回归同引那一份（第二落点会漂）。
import { listProposals, decideProposal, PROPOSAL_DECISIONS } from '../core/self-evolve.js';
// zx_20260930 M14-3（观卦·观国之光）：真健康自检。此前 `admin:health` 只数行数、用
//   `runningTasks > 0` **猜**一个 status——名字叫健康检查、看的却是业务量。
import { runHealthCheck, type HealthReport } from '../core/health-check.js';
// zx_20260930 M9: 到 ANS 的签名请求**唯一出路**（三个认证头在此一处构造）。
import { ansSignedRequest, resolveAnsCreds } from '../core/ans-signed-request.js';
// zx_20261022_3 批四: 密钥类设置的**唯一词表**——读口脱敏 / 写口挡回 / 广播脱敏 / 已配置状态同引一份。
import { isSecretMaskValue, isSecretSettingKey, redactedSettingValue, SECRET_SETTING_KEYS } from '../core/secret-settings.js';
// zx_20261023_5 批三: 密钥键的写口改走**加密落库**（`enc:v1:`）；后端不可用即拒，绝不退回明文。
import { writeSecret } from '../core/device-secrets.js';
import type { DeviceDb } from '../core/device-registry.js';
import fsSync from 'node:fs';

/**
 * 健康自检里 ANS 探针要打的路径——**受保护**（ANS 侧挂在 `hmacAuth` 下的 `/api/v1/models`）。
 *
 * 刻意**不**打 `/api/v1/health`：那个是公开路由（`ans-server/src/index.ts` 的 `healthRoutes()`），
 * 走它只证明"有人在这个端口上监听"，**证明不了三个认证头还认得**——而"恒 401"恰恰是本轮 M9
 * 花大力气治的那条病。健康检查若用一个测不出身份的路，就是把"路通不通"again 当成"身份对不对"。
 *
 * 常量落**在本文件（发起那一跳的地方）**不在 `core/health-check.ts`：`health-check.ts` 只认
 * 一份 `probeAns` 形参、并不认识任何 URL；把路径写在那儿就成了"一个从不发请求的文件里躺着一个
 * ANS 端点串"，在 `/api/v1/` 完备性扫面上会被当成**漏头**（那条扫描的规矩是：带 `/api/v1/` 串的
 * 文件必须落在签名路上，而签名路上的判据是"这个文件真的发签名请求"）。本文件正是那一跳。
 */
export const ANS_HEALTH_PROBE_PATH = '/api/v1/models';

/** `admin:health` 的外部世界注入（全部可选：不传就如实标"无法判定"，不猜）。 */
export interface AdminHealthDeps {
  /** `cron_heartbeat.json` 的绝对路径——由 `main/index.ts` 注入（本层不解析 dataDir）。 */
  heartbeatFile?: string;
  /** 进程内调度器的惰性取用（`initAdminIpc` 执行时它**尚未构造**，故传 thunk）。 */
  getScheduler?: () => { isRunning(): boolean; lastTickAt(): number } | null;
  /** 磁盘水位要在哪个卷上量。 */
  dataDir?: string;
}

export function initAdminIpc(db: Database.Database, healthDeps: AdminHealthDeps = {}): void {
  // zx_20260904_7 白屏排查：renderer 渲染错误上报落库（ErrorBoundary + 全局 error/unhandledrejection）
  ipcMain.handle('diag:renderError', async (_event, payload: { url?: string; message?: string; stack?: string }) => {
    try {
      db.exec('CREATE TABLE IF NOT EXISTS wa_renderer_errors (id TEXT PRIMARY KEY, occurred_at TEXT, url TEXT, message TEXT, stack TEXT)');
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      db.prepare('INSERT INTO wa_renderer_errors (id, occurred_at, url, message, stack) VALUES (?, datetime(\'now\'), ?, ?, ?)')
        .run(id, String(payload?.url || ''), String(payload?.message || '').slice(0, 1000), String(payload?.stack || '').slice(0, 6000));
      return { data: { ok: true } };
    } catch { return { data: { ok: false } }; }
  });
  ipcMain.handle('admin:health', async () => {
    try {
      // zx_20260930 M14-3: **真**健康自检（五面 × 三态 × 一句依据）。
      //   ① ANS：真发一次**受保护**请求（`/api/v1/models` 在 hmacAuth 下）——不是打公开的
      //      `/api/v1/health`，那只能证明"端口有人听"，证明不了三个认证头还认得（M9 的病）。
      //   ② DB：`PRAGMA integrity_check` + 九张必要表在场。
      //   ③ 调度器：进程内脉冲优先（`getScheduler`），拿不到才回落 `cron_heartbeat.json`（30 分钟阈值）。
      //   ④ IM：读 `wa_im_channels`，口径引 `imChannelEnabledSql()` 真源。
      //   ⑤ 资源：堆水位 + 磁盘剩余占比（`fs.statfs`）。
      const report: HealthReport = await runHealthCheck({
        db,
        probeAns: async () => {
          const r = await ansSignedRequest(resolveAnsCreds(db), ANS_HEALTH_PROBE_PATH, { timeoutMs: 3000, retries: 0 });
          return { ok: r.ok, status: r.status, detail: r.detail };
        },
        scheduler: healthDeps.getScheduler ? healthDeps.getScheduler() : null,
        heartbeatFile: healthDeps.heartbeatFile ?? null,
        readTextFile: (p: string) => fsSync.readFileSync(p, 'utf8'),
        diskFree: healthDeps.dataDir
          ? () => {
              const s = fsSync.statfsSync(healthDeps.dataDir as string);
              return { total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize) };
            }
          : null,
      });

      // zx_20261002 M12-3：五面状态**留档**（值变才写一条）——此前只有当下快照，"病是否变多变少"
      //   无从长期累计。写口是 `self-healing-monitor.logHealthTransitions`（本层顶层 import electron，
      //   受控回归跑不起来 ⇒ SQL 不写在这里）。
      logHealthTransitions(db, report.items);

      // 既有计数字段**保留**（概览卡在用）；`status` 改由真报告派生，不再按业务量猜。
      const projects = db.prepare('SELECT COUNT(*) as c FROM wa_projects').get() as { c: number };
      const tasks = db.prepare('SELECT COUNT(*) as c FROM wa_tasks').get() as { c: number };
      const runningTasks = db.prepare("SELECT COUNT(*) as c FROM wa_tasks WHERE status IN ('executing','running')").get() as { c: number };
      // M6：口径＝「启用中」（非用户停用），与通知目标解析 / ask_user / 启动恢复集**同源**
      // （真源见 core/im/im-channel-status.ts）。degraded/error/pending 也是"在用但不健康"，仍计入。
      const enabled = db.prepare(`SELECT COUNT(*) as c FROM wa_im_channels WHERE ${imChannelEnabledSql()}`).get() as { c: number };

      return { data: {
        status: report.level,
        report,
        projects: projects.c,
        tasks: tasks.c,
        runningTasks: runningTasks.c,
        enabledChannels: enabled.c,
        uptime: process.uptime(),
      }};
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('admin:stats', async () => {
    try {
      const totalTokens = db.prepare('SELECT COALESCE(SUM(token_count), 0) as total FROM wa_task_conversations').get() as { total: number };
      // zx_20260930 M8: 「记忆总数」= **活着的**记忆数（不含墓碑）。
      //   不排除则用户删了记忆而总数不变——正是本轮要治的名实不符（删了却像没删）。
      const totalMemories = db.prepare(`SELECT COUNT(*) as c FROM wa_memories WHERE ${MEM_LIVE_SQL}`).get() as { c: number };
      // zx_20260906 批3 (3e): 软退休(重试旧成果)不计入产出物总量
      // zx_20260906_1 3c: 临时脚本(doc 探针)不计入总量
      // zx_20260914 M2-3①(罗尔斯·同一把尺 / 维特根斯坦·家族相似): 探针判据**改引真源 `docNotProbe()`**。
      //   此前是本文件内联拷贝的第三份谓词(且只判 file_path，file_path 为空即放行)——与
      //   project.ipc 的 `COALESCE(file_path, name)` 口径**不同尺**，同一份成果两处计数会分叉。
      //   引真源后两处**逐字同源**；file_path 为空的行改按 name 判(这正是"同一把尺"的含义，非副作用)。
      // zx_20260930 M4-1: 全库总量 ⇒ 取数范围的**真源函数**（范围={} 即"全库、排除退休与探针"）。
      const totalDeliverables = countDeliverables(db);
      return { data: {
        totalTokens: totalTokens.total,
        totalMemories: totalMemories.c,
        totalDeliverables,
      }};
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('admin:users', async () => {
    try {
      const data = db.prepare('SELECT id, email, name, role, created_at FROM wa_users ORDER BY created_at DESC').all();
      return { data };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('admin:memories', async (_event, { projectId, type, offset, limit }: { projectId?: string; type?: string; offset?: number; limit?: number }) => {
    try {
      // zx_20260930 M8: 两句收口。
      // ① **不点名类型 ⇒ 常规列表，不含墓碑**；点名 `type='deleted'` 即**审计面**（墓碑清单）。
      //    这正是"墓碑只在审计面可查"的落点：列表默认看不见它，但要查时点名就能查到。
      // ② `total` 改为**与列表同一套 WHERE**——此前它是全库计数、与筛选无关，
      //    于是带筛选的翻页总数恒错（M4-2 加了真翻页后这会直接把页数算错）。
      const where: string[] = [];
      const params: unknown[] = [];
      if (projectId) { where.push('m.project_id = ?'); params.push(projectId); }
      if (type) { where.push('m.memory_type = ?'); params.push(type); }
      else { where.push(`m.${MEM_LIVE_SQL}`); }
      const whereSql = ` WHERE ${where.join(' AND ')}`;
      const list = db.prepare(
        `SELECT m.*, p.name as project_name FROM wa_memories m LEFT JOIN wa_projects p ON m.project_id = p.id${whereSql} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit || 50, offset || 0);
      const total = (db.prepare(`SELECT COUNT(*) as c FROM wa_memories m${whereSql}`).get(...params) as { c: number }).c;
      // 类型卡**保留全部取值**（含 `deleted`）——它同时是筛选条的取值来源，墓碑那一格必须点得到。
      const counts = db.prepare('SELECT memory_type, COUNT(*) as cnt FROM wa_memories GROUP BY memory_type').all();
      return { data: { list, counts, total } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // 项目健康报告
  ipcMain.handle('admin:projectHealth', async () => {
    try {
      const projects = db.prepare('SELECT * FROM wa_projects WHERE status != ?').all('archived') as Array<Record<string, unknown>>;
      const healths = projects.map((p: Record<string, unknown>) => {
        const tasks = db.prepare('SELECT status, COUNT(*) as cnt FROM wa_tasks WHERE project_id = ? GROUP BY status').all(p.id) as Array<{ status: string; cnt: number }>;
        const total = tasks.reduce((s, t) => s + t.cnt, 0);
        const completed = tasks.filter(t => t.status === 'completed').reduce((s, t) => s + t.cnt, 0);
        const failed = tasks.filter(t => t.status === 'failed').reduce((s, t) => s + t.cnt, 0);
        const score = total === 0 ? 100 : Math.round((completed / total) * 100);
        return { id: p.id, name: p.name, status: p.status, stale: (p.staleness as string) || 'healthy', taskTotal: total, taskCompleted: completed, taskFailed: failed, healthScore: score };
      });
      return { data: healths };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // 使用趋势（近 N 天日历序列补零，含 0 使用日，横轴等距）
  ipcMain.handle('admin:trend', async (_event, { days }: { days?: number }) => {
    try {
      const d = Math.max(1, Math.floor(days || 30));
      const rows = db.prepare(`
        WITH RECURSIVE cal(d) AS (
          SELECT date('now', '-' || (@days - 1) || ' days')
          UNION ALL SELECT date(d, '+1 day') FROM cal WHERE d < date('now')
        ), agg AS (
          SELECT date(created_at) AS d, COUNT(*) AS calls, COALESCE(SUM(token_count),0) AS tokens
          FROM wa_task_conversations
          WHERE created_at >= datetime('now', '-' || @days || ' days')
          GROUP BY date(created_at)
        )
        SELECT cal.d AS date, COALESCE(agg.calls,0) AS calls, COALESCE(agg.tokens,0) AS tokens
        FROM cal LEFT JOIN agg ON agg.d = cal.d
        ORDER BY cal.d ASC
      `).all({ days: d });
      return { data: rows };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // 系统日志
  ipcMain.handle('admin:logs', async (_event, { lines, level }: { lines?: number; level?: string }) => {
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      // Determine log directory
      const logDir = path.resolve(process.cwd(), '../../data/logs');
      const logs: string[] = [];
      try {
        const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log')).sort().reverse();
        const limit = lines || 200;
        for (const file of files) {
          if (logs.length >= limit) break;
          const content = fs.readFileSync(path.join(logDir, file), 'utf-8');
          const linesInFile = content.split('\n').filter(Boolean).reverse();
          for (const line of linesInFile) {
            if (logs.length >= limit) break;
            if (level && !line.includes(`"level":"${level}"`) && !line.includes(`"level":${level}`)) continue;
            logs.push(line);
          }
        }
      } catch { /* no logs */ }
      return { data: logs };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // 运维概览
  ipcMain.handle('admin:overview', async () => {
    try {
      const bottlenecks: Array<Record<string, unknown>> = [];
      const projects = db.prepare("SELECT id, name FROM wa_projects WHERE status = 'active'").all() as Array<{ id: string; name: string }>;
      for (const p of projects) {
        const failed = db.prepare("SELECT COUNT(*) as c FROM wa_tasks WHERE project_id = ? AND status = 'failed'").get(p.id) as { c: number };
        const stuck = db.prepare(`SELECT COUNT(*) as c FROM wa_tasks WHERE project_id = ? AND status IN ('executing','running') AND ${utcSql('updated_at')} < datetime('now','-30 minutes')`).get(p.id) as { c: number };
        if (failed.c > 0 || stuck.c > 0) bottlenecks.push({ projectId: p.id, projectName: p.name, failedTasks: failed.c, stuckTasks: stuck.c });
      }
      const recentTasks = db.prepare("SELECT t.title, t.status, t.updated_at, p.name as project_name FROM wa_tasks t JOIN wa_projects p ON t.project_id = p.id ORDER BY t.updated_at DESC LIMIT 30").all();
      const resourceSummary = projects.map(p => {
        const tokens = db.prepare("SELECT COALESCE(SUM(tc.token_count),0) as total FROM wa_task_conversations tc JOIN wa_tasks t ON tc.task_id = t.id WHERE t.project_id = ?").get(p.id) as { total: number };
        const taskCount = db.prepare("SELECT COUNT(*) as c FROM wa_tasks WHERE project_id = ?").get(p.id) as { c: number };
        return { projectId: p.id, projectName: p.name, totalTokens: tokens.total, taskCount: taskCount.c };
      });
      // 任务依赖 DAG（概览页）
      const projectDeps = projects.map(p => {
        const tasks = db.prepare("SELECT id, title, status, depends_on, parent_task_id, priority FROM wa_tasks WHERE project_id = ? AND status NOT IN ('completed','failed')").all(p.id) as Array<{ id: string; title: string; status: string; depends_on: string | null; parent_task_id: string | null; priority: number }>;
        return { projectId: p.id, projectName: p.name, tasks };
      });
      // zx_20260906 批3 (3d): 成果/M-里程碑/质量 聚合区数据——每活跃项目最近产出物(≤3，排除 retired)、方案里程碑 lean 行、质量均质
      const projectOutcomes = projects.map(p => {
        // zx_20260906_1 3c: 大盘"最近产出物"同样排除临时脚本探针，与统计口径一致
        // zx_20260914 M2-3①: 同上——本处是**第二个内联拷贝**(方案原文只点了 :52 一处，实测两处)，一并引真源。
        //   至此全仓 doc 探针判据只剩 `docNotProbe()` 一处实现，其余皆引用。
        // zx_20260930 M4-1: 范围声明改为共享真源（此处只声明"本项目、排除退休与探针"）。
        const rScope = deliverableScopeSql({ projectId: p.id });
        const recentDeliverables = db.prepare(`SELECT id, name, type, status, created_at FROM wa_deliverables WHERE ${rScope.sql} ORDER BY created_at DESC LIMIT 3`).all(...rScope.params) as Array<{ id: string; name: string; type: string; status: string; created_at: string }>;
        const q = projectQualityStats(db, p.id);
        // zx_20260906_1 3e: milestone 结构化(含 impl)——Dashboard 大盘 M 可点进落地任务（非纯文本）
        const milestoneList = db.prepare("SELECT m.milestone AS ms, m.status AS st, m.plan_task_id AS plan_id, m.implemented_by_task_id AS impl FROM wa_plan_milestones m JOIN wa_tasks pt ON pt.id = m.plan_task_id WHERE pt.project_id = ? ORDER BY m.milestone ASC").all(p.id) as Array<{ ms: string; st: string; plan_id: string; impl: string | null }>;
        return {
          projectId: p.id,
          projectName: p.name,
          recentDeliverables,
          milestoneLine: buildPlanMilestoneLine(db, p.id),
          milestoneList,
          quality: { count: q.count, avg: q.avg, low: q.low },
        };
      });
      return { data: { bottlenecks, recentTasks, resourceSummary, projectDeps, projectOutcomes } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // A4 (2026-09-03): 「需我处理」聚合——等待你回复/决策 + 近24h 失败待处理
  interface ActionRow { id: string; project_id: string | null; project_name: string | null; title: string; status: string; updated_at: string; }
  ipcMain.handle('tasks:actionNeeded', async () => {
    try {
      const awaiting = db.prepare(`
        SELECT t.id, t.project_id, t.title, t.status, t.updated_at, p.name AS project_name
        FROM wa_tasks t JOIN wa_projects p ON p.id = t.project_id
        WHERE t.status = 'paused'
          AND EXISTS (SELECT 1 FROM wa_task_conversations c WHERE c.task_id = t.id AND c.role = 'system' AND c.content LIKE '[等待用户输入]%')
        ORDER BY t.updated_at DESC`).all() as unknown as ActionRow[];
      const failed = db.prepare(`
        SELECT t.id, t.project_id, t.title, t.status, t.updated_at, p.name AS project_name
        FROM wa_tasks t JOIN wa_projects p ON p.id = t.project_id
        WHERE t.status = 'failed' AND t.updated_at >= datetime('now', '-1 day')
        ORDER BY t.updated_at DESC`).all() as unknown as ActionRow[];
      type ActionItem = ActionRow & { kind: 'await_input' | 'failed'; reason: string };
      const items: ActionItem[] = [
        ...awaiting.map((r) => ({ ...r, kind: 'await_input' as const, reason: '等待你回复/决策' })),
        ...failed.map((r) => ({ ...r, kind: 'failed' as const, reason: '执行失败，待处理' })),
      ].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      return { data: { items, count: items.length } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // B2 (2026-09-03): 执行事件回放——从 wa_event_log 读回任务步骤/信号，刷新不丢
  ipcMain.handle('events:taskReplay', async (_event, taskId: string) => {
    try {
      const rows = db.prepare(
        "SELECT id, event_type, payload, occurred_at FROM wa_event_log WHERE aggregate_type = 'task' AND aggregate_id = ? ORDER BY id ASC"
      ).all(taskId) as Array<{ id: number; event_type: string; payload: string; occurred_at: string }>;
      const steps: Array<Record<string, unknown>> = [];
      const signals: Array<{ type: string; signalType?: string; level?: string; message: string; occurred_at: string }> = [];
      let stepNo = 0;
      for (const r of rows) {
        let p: Record<string, unknown> = {};
        try { p = JSON.parse(r.payload || '{}') as Record<string, unknown>; } catch { /* payload 非 JSON 跳过 */ }
        if (r.event_type === 'task.step_finished') {
          stepNo++;
          steps.push({
            type: 'task.step_finished',
            step: p.step ?? stepNo,
            text: (p.text as string) || '',
            toolCalls: (p.toolCalls as string) || undefined,
            tokens: p.tokens ?? p.token_delta,
            token_delta: p.token_delta,
            duration_ms: p.duration_ms,
            toolOk: p.toolOk,
          });
        } else if (r.event_type === 'task.goal_deviation' || r.event_type === 'task.execution_signal') {
          signals.push({
            type: r.event_type,
            signalType: (p.signalType as string) || undefined,
            level: (p.level as string) || undefined,
            message: (p.message as string) || (p.reason as string) || '',
            occurred_at: r.occurred_at,
          });
        }
      }
      return { data: { steps, signals } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // C1 (2026-09-03): 项目自适应策略与调参历史可视（数据源 wa_projects.context_json，feedback-engine 写入）
  ipcMain.handle('project:strategy', async (_event, projectId: string) => {
    try {
      const p = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string } | undefined;
      const ctx = JSON.parse(p?.context_json || '{}') as Record<string, unknown>;
      const ls = ctx.learned_strategy as { modelStrategy?: string; temperature?: number; maxSteps?: number } | undefined;
      return {
        data: {
          modelStrategy: ls?.modelStrategy || null,
          temperature: typeof ls?.temperature === 'number' ? ls.temperature : null,
          maxSteps: typeof ls?.maxSteps === 'number' ? ls.maxSteps : null,
          updatedAt: (ctx.learned_strategy_updatedAt as string) || null,
          adjustments: Array.isArray(ctx.strategy_adjustments) ? ctx.strategy_adjustments : [],
          history: ctx.strategy_history || {},
          toolUsage: ctx.tool_usage || {},
        },
      };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // D1 (2026-09-03): 瓶颈·主要矛盾接线（复用 getBottleneckSummary，按需重算返回主要矛盾+摘要）
  ipcMain.handle('project:bottleneck', async (_event, projectId: string) => {
    try {
      const { getBottleneckSummary } = await import('../core/bottleneck-analyzer.js');
      const { principalContradictions, summary } = getBottleneckSummary(db, projectId);
      const principals = principalContradictions.map((s) => {
        const row = db.prepare('SELECT title, status FROM wa_tasks WHERE id = ?').get(s.taskId) as { title: string; status: string } | undefined;
        return {
          taskId: s.taskId,
          title: row?.title || '',
          status: row?.status || '',
          blockingCount: s.blockingCount,
          resourceCriticality: s.resourceCriticality,
          timeSensitivity: s.timeSensitivity,
          dynamicPriority: s.dynamicPriority,
          isPrincipalContradiction: s.isPrincipalContradiction,
        };
      });
      return { data: { summary, principals, computedAt: new Date().toISOString() } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // A1 (2026-09-03_1): 调度/队列只读状态看板（数据源 wa_jobs；只读无副作用）
  ipcMain.handle('scheduler:status', async () => {
    try {
      const countRows = db.prepare('SELECT status, COUNT(*) AS c FROM wa_jobs GROUP BY status').all() as Array<{ status: string; c: number }>;
      const counts: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0 };
      for (const r of countRows) { if (r.status in counts) counts[r.status] = r.c; }
      const running = db.prepare("SELECT type, started_at, created_at FROM wa_jobs WHERE status = 'running' ORDER BY created_at ASC LIMIT 20").all() as Array<{ type: string; started_at: string | null; created_at: string }>;
      const scheduled = db.prepare("SELECT type, scheduled_at FROM wa_jobs WHERE status = 'pending' AND scheduled_at IS NOT NULL ORDER BY scheduled_at ASC LIMIT 20").all() as Array<{ type: string; scheduled_at: string }>;
      const recent = db.prepare("SELECT type, status, error, created_at, completed_at FROM wa_jobs ORDER BY created_at DESC LIMIT 12").all() as Array<{ type: string; status: string; error: string | null; created_at: string; completed_at: string | null }>;
      return { data: { counts, running, scheduled, recent } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // B1 (2026-09-03_1): 方案里程碑追踪——查询 + 手动更新（标记 doing/done + 落地任务）
  ipcMain.handle('plan:milestones', async (_event, { planTaskId }: { planTaskId: string }) => {
    try {
      const rows = db.prepare(
        "SELECT pm.milestone, pm.status, pm.implemented_by_task_id, pm.updated_at, t.title AS implemented_title FROM wa_plan_milestones pm LEFT JOIN wa_tasks t ON t.id = pm.implemented_by_task_id WHERE pm.plan_task_id = ? ORDER BY pm.milestone ASC"
      ).all(planTaskId) as Array<{ milestone: string; status: string; implemented_by_task_id: string | null; updated_at: string; implemented_title: string | null }>;
      return { data: { milestones: rows } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });
  ipcMain.handle('plan:milestoneSet', async (_event, opts: { planTaskId: string; milestone: string; status: 'pending' | 'doing' | 'done'; implementedByTaskId?: string }) => {
    try {
      if (!['pending', 'doing', 'done'].includes(opts.status)) return { error: { code: 'BAD_PARAMS', message: 'status 仅支持 pending/doing/done' } };
      db.prepare("UPDATE wa_plan_milestones SET status = ?, implemented_by_task_id = ?, updated_at = datetime('now') WHERE plan_task_id = ? AND milestone = ?")
        .run(opts.status, opts.implementedByTaskId || null, opts.planTaskId, opts.milestone);
      // zx_20260909 X2①(维特根斯坦·可判定 / 王阳明·知行合一): 里程碑落库后发真实事件——交付单/里程碑卡前端即刷
      // (此前前端虚构订阅 'milestone.done' 主进程从不 emit=死监听, 标 done 不刷新只能靠 task/file 事件兜底)
      try {
        const plan = db.prepare("SELECT project_id FROM wa_plan_milestones WHERE plan_task_id = ? AND milestone = ?").get(opts.planTaskId, opts.milestone) as { project_id?: string } | undefined;
        if (plan?.project_id) {
          eventBus.emit('project.milestone_changed', { projectId: plan.project_id, planTaskId: opts.planTaskId, milestone: opts.milestone, status: opts.status }).catch(() => {});
        }
      } catch { /* 里程碑事件发射失败不阻断 */ }
      return { data: { ok: true } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // B1 (2026-09-04_1): 历史方案里程碑补登记/回填——读 doc 提取 M\d+ 登记，并把已完成实施任务(标题 M\d 前缀)关联回填 done
  ipcMain.handle('plan:backfill', async (_event, { planTaskId }: { planTaskId: string }) => {
    try {
      const t = db.prepare('SELECT id, project_id FROM wa_tasks WHERE id = ?').get(planTaskId) as { id: string; project_id: string } | undefined;
      if (!t) return { error: { code: 'NOT_FOUND', message: '方案任务不存在' } };
      const fs = await import('node:fs');
      const docs = db.prepare("SELECT file_path FROM wa_deliverables WHERE task_id = ? AND type = 'doc'").all(planTaskId) as Array<{ file_path: string | null }>;
      const found = new Set<string>();
      for (const d of docs) {
        if (!d.file_path) continue;
        let c = '';
        try { c = fs.readFileSync(d.file_path, 'utf-8'); } catch { continue; }
        const re = /\bM\d+\b/g; let mm;
        while ((mm = re.exec(c)) !== null) found.add(mm[0]);
      }
      const msList = [...found].sort();
      const ins = db.prepare("INSERT OR IGNORE INTO wa_plan_milestones (id, project_id, plan_task_id, milestone, status, updated_at) VALUES (?, ?, ?, ?, 'pending', datetime('now'))");
      for (const ms of msList) ins.run(crypto.randomUUID(), t.project_id, planTaskId, ms);
      const upd = db.prepare("UPDATE wa_plan_milestones SET status = 'done', implemented_by_task_id = ?, updated_at = datetime('now') WHERE plan_task_id = ? AND milestone = ? AND status != 'done'");
      let linked = 0;
      // zx_20260910_3 M2b: 反向标题判据收敛——此前就地写 `title GLOB 'M{n}[ (：:;]*'`，
      // 而 GLOB 两端锚定、「[ (：:;]」是**单字符类**，实为"标题 = M{n} + 一个边界符 + 任意尾串"，
      // 与正向的 /^M(\d+)/ 不是同一判据（漏配纯 `M{n}` 与 `M{n}x` 两类标题）。改走共享反向入口，与正向同一函数。
      for (const ms of msList) {
        const implId = resolveMilestoneImplementer(db, t.project_id, ms);
        if (implId) { upd.run(implId, planTaskId, ms); linked++; }
      }
      return { data: { registered: msList, linked } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // B2 (2026-09-04_1): 某实施任务所属的方案里程碑
  // zx_20260910_2 M2b: 回退分支改走与引擎**同一份判据** task-accounting.resolveTaskMilestoneLink。
  // 此前就地两步 SQL 既不看 ctx.scheme_ref，也无歧义护栏——本项目内 9-10 块板持有同名 M 时一次返回全量，
  // 「族验收通过 → 同步方案里程碑」(TaskDetailPage) 据此逐行 plan:milestoneSet，把别的方案板的同名 M
  // 也置 done 并改写 implemented_by（跨板误标）。
  ipcMain.handle('plan:taskMilestones', async (_event, { taskId }: { taskId: string }) => {
    try {
      const t = db.prepare('SELECT id, title, project_id, parent_task_id, context_json FROM wa_tasks WHERE id = ?').get(taskId) as { id: string; title: string; project_id: string; parent_task_id: string | null; context_json: string | null } | undefined;
      if (!t) return { data: { milestones: [] } };
      // 本任务作为实施者落地的里程碑可有多条（实施锚父一次落地 M0-M8），优先全量呈现
      let rows = db.prepare("SELECT plan_task_id, milestone, status FROM wa_plan_milestones WHERE implemented_by_task_id = ?").all(taskId) as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        const link = resolveTaskMilestoneLink(db, taskId, JSON.parse(t.context_json || '{}'));
        if (link) rows = db.prepare('SELECT plan_task_id, milestone, status FROM wa_plan_milestones WHERE plan_task_id = ? AND milestone = ?').all(link.plan_task_id, link.milestone) as Array<Record<string, unknown>>;
      }
      return { data: { milestones: rows } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // zx_20260909 续跑(规划→独立实施模型): 关联方案 / 方案面板选落地任务 IPC
  // ① 项目内"方案(规划)任务"清单(持有 ≥1 方案里程碑者为候选方案)——供实施任务"关联方案"
  ipcMain.handle('plan:projectPlans', async (_event, { projectId }: { projectId: string }) => {
    try {
      const plans = db.prepare("SELECT t.id, t.title, t.status, COUNT(m.id) AS mc FROM wa_tasks t JOIN wa_plan_milestones m ON m.plan_task_id = t.id WHERE t.project_id = ? GROUP BY t.id ORDER BY t.updated_at DESC LIMIT 80").all(projectId) as Array<{ id: string; title: string; status: string; mc: number }>;
      return { data: { plans: plans.map((p) => ({ id: p.id, title: (p.title || '').slice(0, 60), status: p.status, milestoneCount: p.mc })) } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });
  // ② 为任务(实施锚父/单条实施)设置/清除"关联方案"(ctx.scheme_ref.plan_task_id)——子任务创建时继承; finalize/动工据此+标题 M 自动落地
  // zx_20260911_3 M3-1(赫布·同时激活即联结): 事后关联须**向下回填已存在的子树**——此前只写单个任务自身，E3 的 3 个
  // 持有者（6124c592/aac427c2/df334d91）其子树无一被激活，"牌子对不上树"在时间维度上依旧断。回填唯一收敛在
  // task-accounting.backfillDescendantSchemeRef（补缺式；解除仅清本 plan），不在 project.ipc 再写一份。
  ipcMain.handle('plan:linkPlan', async (_event, { taskId, planTaskId }: { taskId: string; planTaskId: string | null }) => {
    try {
      const t = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined;
      if (!t) return { error: { code: 'NOT_FOUND', message: '任务不存在' } };
      const prevPlanId = (() => { try { return (JSON.parse(t.context_json || '{}') as { scheme_ref?: { plan_task_id?: string } }).scheme_ref?.plan_task_id || null; } catch { return null; } })();
      if (planTaskId) {
        const pt = db.prepare('SELECT id FROM wa_tasks WHERE id = ?').get(planTaskId);
        if (!pt) return { error: { code: 'NOT_FOUND', message: '方案任务不存在' } };
        db.prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.scheme_ref', json(?)) WHERE id = ?").run(JSON.stringify({ plan_task_id: planTaskId }), taskId);
        const backfilled = backfillDescendantSchemeRef(db, taskId, { plan_task_id: planTaskId });
        return { data: { taskId, planTaskId, backfilled } };
      }
      const ctx = JSON.parse(t.context_json || '{}');
      delete ctx.scheme_ref;
      db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), taskId);
      const cleared = backfillDescendantSchemeRef(db, taskId, null, prevPlanId || undefined);
      return { data: { taskId, planTaskId: null, backfilled: 0, cleared } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });
  // ③ 方案任务同项目任务清单(供方案面板"选落地任务", 任意同项目任务均可, 不限于子任务)
  ipcMain.handle('plan:projectTasks', async (_event, { planTaskId }: { planTaskId: string }) => {
    try {
      const pt = db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(planTaskId) as { project_id?: string } | undefined;
      if (!pt?.project_id) return { data: { tasks: [] } };
      const tasks = db.prepare("SELECT id, title, status FROM wa_tasks WHERE project_id = ? ORDER BY updated_at DESC LIMIT 300").all(pt.project_id) as Array<{ id: string; title: string; status: string }>;
      return { data: { tasks: tasks.map((t) => ({ id: t.id, title: (t.title || '').slice(0, 60), status: t.status })) } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // A1/A2/A3 (2026-09-03_2): 活动/事件中心——分页/筛选/人性化摘要/对象名（数据源 wa_event_log）
  const EVENT_LABEL: Record<string, string> = {
    'task.completed': '任务完成', 'task.failed': '任务失败', 'task.awaiting_input': '任务等待输入', 'task.status_changed': '任务状态变更',
    'task.step_finished': '任务步骤', 'task.step_streaming': '流式(瞬态)', 'task.memory_injected': '记忆注入', 'task.goal_identified': '目标已识别',
    'task.goal_deviation': '目标偏离', 'task.execution_signal': '执行信号', 'task.estimated': '任务预估',
    'project.status_changed': '项目状态变更', 'deliverable.registered': '交付物注册', 'deliverable.status_changed': '交付物状态变更', 'file.created': '文件创建', 'file.updated': '文件更新', 'file.edited': '文件编辑',
  };
  const eventLabel = (t: string) => EVENT_LABEL[t] ?? t;
  const eventLevel = (t: string) => (t === 'task.failed' || t === 'file.edited' ? 'error' : (t === 'task.awaiting_input' || t === 'task.goal_deviation' ? 'warn' : 'info'));
  ipcMain.handle('events:feed', async (_event, opts?: { offset?: number; limit?: number; type?: string; aggregateType?: string; aggregateId?: string; sinceHours?: number; showNoisy?: boolean }) => {
    try {
      const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
      const offset = Math.max(opts?.offset ?? 0, 0);
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts?.type) { where.push('event_type = ?'); params.push(opts.type); }
      else if (!opts?.showNoisy) { where.push("event_type NOT IN ('task.step_finished','task.estimated','task.memory_injected','task.goal_identified')"); }
      if (opts?.aggregateType) { where.push('aggregate_type = ?'); params.push(opts.aggregateType); }
      if (opts?.aggregateId) { where.push('aggregate_id = ?'); params.push(opts.aggregateId); }
      if (opts?.sinceHours) { where.push("occurred_at >= datetime('now', '-' || ? || ' hours')"); params.push(String(opts.sinceHours)); }
      const wsql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM wa_event_log ${wsql}`).get(...params) as { c: number }).c;
      const rows = db.prepare(`SELECT event_type, aggregate_type, aggregate_id, occurred_at, payload FROM wa_event_log ${wsql} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<{ event_type: string; aggregate_type: string; aggregate_id: string; occurred_at: string; payload: string }>;
      // 对象名一次性预取（任务/项目）
      const taskIds = [...new Set(rows.filter(r => r.aggregate_type === 'task' || String(r.aggregate_type).startsWith('task')).map(r => r.aggregate_id))];
      const projIds = [...new Set(rows.filter(r => r.aggregate_type === 'project').map(r => r.aggregate_id))];
      const names = new Map<string, string>();
      if (taskIds.length) { (db.prepare(`SELECT id, title FROM wa_tasks WHERE id IN (${taskIds.map(() => '?').join(',')})`).all(...taskIds) as Array<{ id: string; title: string }>).forEach(t => names.set(t.id, t.title)); }
      if (projIds.length) { (db.prepare(`SELECT id, name FROM wa_projects WHERE id IN (${projIds.map(() => '?').join(',')})`).all(...projIds) as Array<{ id: string; name: string }>).forEach(p => names.set(p.id, p.name)); }
      const items = rows.map((r) => {
        let p: Record<string, unknown> = {};
        try { p = JSON.parse(r.payload || '{}') as Record<string, unknown>; } catch { /* ignore */ }
        let text = '';
        const st = r.event_type;
        if (st === 'task.step_finished') text = `第 ${String(p.step ?? '')} 步${p.duration_ms != null ? ` · ${Number(p.duration_ms)}ms` : ''}${p.toolOk === false ? ' · 工具出错' : ''}`;
        else if (st === 'task.awaiting_input') text = String(p.question || '等待你回复/决策').slice(0, 160);
        else if (st === 'task.goal_identified') text = String(p.goal || '').slice(0, 160);
        else if (st === 'task.goal_deviation' || st === 'task.execution_signal') text = String(p.message || p.reason || '');
        else if (st === 'task.status_changed') text = `状态 → ${String(p.new_status ?? p.status ?? '')}`;
        else if (st === 'project.status_changed') text = `状态 → ${String(p.status ?? p.new_status ?? '')}`;
        else if (st === 'deliverable.registered') text = String(p.name || p.type || '');
        else if (st === 'deliverable.status_changed') text = `「${String(p.name || '')}」状态 → ${String(p.status || '')}${p.via ? `（${String(p.via)}）` : ''}`;
        else if (st === 'task.completed' || st === 'task.failed') text = String(p.title || '');
        else if (st.startsWith('file.')) text = String(p.filePath || p.path || '');
        else if (st === 'task.estimated') text = `预估 ${String(p.tokens ?? '')} tokens`;
        return { event_type: st, label: eventLabel(st), level: eventLevel(st), aggregate_type: r.aggregate_type, aggregate_id: r.aggregate_id, object_name: names.get(r.aggregate_id) || '', occurred_at: r.occurred_at, text: text.slice(0, 200), payload: r.payload };
      });
      return { data: { items, total, offset, limit } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // ===== 用户偏好 =====
  ipcMain.handle('preferences:list', async (_event, { userId }: { userId: string }) => {
    try {
      const list = db.prepare("SELECT * FROM wa_memories WHERE user_id = ? AND memory_type = 'semantic' ORDER BY importance DESC, updated_at DESC LIMIT 50").all(userId);
      return { data: list };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('preferences:create', async (_event, { userId, content, source, importance, reasoning }: { userId: string; content: string; source?: string; importance?: number; reasoning?: string }) => {
    try {
      const id = crypto.randomUUID();
      // zx_20260920_1 M7: `??` 而非 `||` —— 显式传 `0` 是"这条不重要"的合法判断，`||` 会把它悄悄抬成默认值。
    db.prepare("INSERT INTO wa_memories (id, user_id, project_id, task_id, memory_type, content, source, importance, reasoning, valence, updated_at) VALUES (?, ?, NULL, NULL, 'semantic', ?, ?, ?, ?, 0, datetime('now'))").run(id, userId, content, source || 'user_manual', importance ?? MEM_IMPORTANCE_DEFAULT, reasoning || '');
      return { data: db.prepare('SELECT * FROM wa_memories WHERE id = ?').get(id) };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('preferences:update', async (_event, { id, content, importance, reasoning }: { id: string; content?: string; importance?: number; reasoning?: string }) => {
    try {
      // zx_20260930 M5（GUI 编辑＝用户纠正）: 改**内容**即用户对这条记忆的纠正 ⇒ 来源一并改为
      //   `user_correction`，由此获得在册已久却此前**不可达**的三条保护：置信顶分 0.95 /
      //   `sameSourceReplace` 永不覆盖 / 衰减豁免（`isCore` ⇒ 半衰期 ×5）。
      //   只改重要度或理由**不算**纠正（那是对同一条内容的重新评估）⇒ 不动来源：**不改语义就不改身份**。
      if (content) db.prepare('UPDATE wa_memories SET content = ?, source = ?, updated_at = datetime(\'now\') WHERE id = ?').run(content, MEM_SOURCE_USER_CORRECTION, id);
      if (importance !== undefined) db.prepare('UPDATE wa_memories SET importance = ?, updated_at = datetime(\'now\') WHERE id = ?').run(importance, id);
      if (reasoning !== undefined) db.prepare('UPDATE wa_memories SET reasoning = ?, updated_at = datetime(\'now\') WHERE id = ?').run(reasoning, id);
      return { data: db.prepare('SELECT * FROM wa_memories WHERE id = ?').get(id) };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('preferences:delete', async (_event, id: string) => {
    try {
      // zx_20260930 M8: 落墓碑（原为物理删）。`memory_type = 'semantic'` 这条守卫**保留**：
      //   偏好页只该删得动偏好行；不是偏好（含已是墓碑）则**什么都不做**。
      const row = db.prepare("SELECT id FROM wa_memories WHERE id = ? AND memory_type = 'semantic'").get(id);
      if (!row) return { data: { id, deleted: false } };
      const ok = tombstoneMemory(db, id, MEM_DELETE_REASONS.userPreference);
      return { data: { id, deleted: ok } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('preferences:batch', async (_event, { userId, items }: { userId: string; items: Array<{ content: string; source: string; importance?: number; reasoning?: string }> }) => {
    try {
      const ids: string[] = [];
      for (const item of items) {
        const id = crypto.randomUUID();
        // zx_20260920_1 M7: 同 `preferences:create` —— `??` 不把显式的 0 抬成默认值。
        db.prepare("INSERT INTO wa_memories (id, user_id, project_id, task_id, memory_type, content, source, importance, reasoning, valence, updated_at) VALUES (?, ?, NULL, NULL, 'semantic', ?, ?, ?, ?, 0, datetime('now'))").run(id, userId, item.content, item.source || 'user_onboarding', item.importance ?? MEM_IMPORTANCE_DEFAULT, item.reasoning || '');
        ids.push(id);
      }
      return { data: { ids } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // E3: 自动提取偏好（从已完成任务的对话中扫描偏好关键词）
  ipcMain.handle('preferences:autoExtract', async (_event, { userId }: { userId: string }) => {
    try {
      let extracted = 0;
      const convs = db.prepare(
        "SELECT tc.content, tc.task_id FROM wa_task_conversations tc JOIN wa_tasks t ON tc.task_id = t.id WHERE t.status = 'completed' AND tc.role = 'assistant' ORDER BY tc.created_at DESC LIMIT 100"
      ).all() as Array<{ content: string; task_id: string }>;

      const patterns = [
        /用户偏好[：:]\s*(.+)/g,
        /偏好[：:]\s*(.+)/g,
        /习惯[：:]\s*(.+)/g,
        /用户.*喜欢\s*(.+)/g,
        /用户.*倾向于\s*(.+)/g,
      ];

      for (const conv of convs) {
        for (const pattern of patterns) {
          let match: RegExpExecArray | null;
          while ((match = pattern.exec(conv.content)) !== null) {
            const content = match[1]!.trim().slice(0, 200);
            if (content.length < 5) continue;
            // 检查是否已存在
            const exists = db.prepare("SELECT id FROM wa_memories WHERE user_id = ? AND content = ? AND memory_type = 'semantic'").get(userId, content);
            if (exists) continue;
            const id = crypto.randomUUID();
            db.prepare("INSERT INTO wa_memories (id, user_id, project_id, task_id, memory_type, content, source, importance, reasoning, valence, updated_at) VALUES (?, ?, NULL, NULL, 'semantic', ?, 'auto_extract', ?, ?, 0, datetime('now'))").run(id, userId, content, MEM_IMPORTANCE_DEFAULT, `从任务 ${conv.task_id.slice(0, 8)} 对话中自动提取`);
            extracted++;
          }
        }
      }
      return { data: { extracted } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('admin:toolStats', async () => {
    try {
      // zx_20261002 M16-①（维特根斯坦·意义即使用）: 此前查 `tool_name` 列——`wa_task_conversations` 里
      //   **从来没有这一列**（真列：id/task_id/role/content/tool_calls/token_count/created_at），SQL 一执行
      //   就 `no such column`，被下面的 `catch` 静默吞掉 ⇒ Dashboard 的「工具调用 Top 10」卡片**恒不出现**。
      //   口径还错了一层：`tool_calls` 列装的**不是工具调用**，而是 `{"confidence":{…}}` 这类**答卷置信度**
      //   （全库仅 86 行非空）——从它 `json_extract` 工具名同样是查了"查不到的东西"。
      //
      //   工具调用的**真出处**是执行器 `exec-step.ts:269` 落的 `role='tool'` 行，格式固定为
      //   `[<工具名>] <结果>`（错误结果则是 `[<工具名>] [错误] <原因>`，见 `:253`）。故此处**按该格式拆名**：
      //   `substr(content, 2, instr(content,']')-2)` 取 `[` 与首个 `]` 之间的工具名。`error_count` 只认执行器
      //   自己打的 `[错误]` 记号（工具把错误当值返回 JSON 时不在此列——**如实**，不替它猜）。
      const stats = db.prepare(
        "SELECT substr(content, 2, instr(content, ']') - 2) AS tool_name, COUNT(*) AS call_count, " +
        "SUM(CASE WHEN instr(content, '[错误]') > 0 THEN 1 ELSE 0 END) AS error_count " +
        "FROM wa_task_conversations WHERE role = 'tool' AND content LIKE '[%]%' " +
        "AND created_at > datetime('now','-7 days') GROUP BY tool_name ORDER BY call_count DESC LIMIT 10"
      ).all();
      return { data: { stats, total: (stats as Array<{call_count:number}>).reduce((s,x)=>s+x.call_count,0) } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('admin:events', async () => {
    try {
      const data = db.prepare('SELECT event_type, aggregate_type, occurred_at, payload FROM wa_event_log ORDER BY occurred_at DESC LIMIT 50').all();
      return { data };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('admin:deleteMemory', async (_event, id: string) => {
    try {
      // zx_20260930 M8: 落墓碑（原为物理删）——留 id / 时刻 / 缘由 / 内容指纹，清正文与向量。
      //   由此机器（`background-review` 的 LLM 提取、工作笔记沉淀）**再也提不回同一段内容**：
      //   `storeText` 按指纹拦在本项目内（见 `MemoryManager.storeText`）。
      const ok = tombstoneMemory(db, id, MEM_DELETE_REASONS.userMemory);
      return { data: { id, deleted: ok } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // C1 (2026-09-03_2): 记忆冲突批量处理——保留 keepId，其余标 superseded + 降权（复用检索惩罚字段语义，零新机制）
  ipcMain.handle('memory:resolveConflicts', async (_event, { keepId, removeIds }: { keepId: string; removeIds: string[] }) => {
    try {
      let resolved = 0;
      const getCtx = db.prepare('SELECT context_json, importance FROM wa_memories WHERE id = ?');
      const upd = db.prepare('UPDATE wa_memories SET context_json = ?, importance = ?, updated_at = datetime(\'now\') WHERE id = ?');
      for (const id of removeIds) {
        if (id === keepId) continue;
        const row = getCtx.get(id) as { context_json: string; importance: number } | undefined;
        const c = row?.context_json ? (JSON.parse(row.context_json) as Record<string, unknown>) : {};
        c.superseded = true;
        c.superseded_by = keepId;
        // 终核整改 (2026-09-03): 冲突已解决——清除 conflict_flag/potential_conflict（让健康卡 conflictCount 真正下降），
        // 保留 superseded（检索惩罚语义 → 不再作为权威注入）；重要性降 0.2
        delete c.conflict_flag;
        delete c.potential_conflict;
        delete c.conflict_with;
        // zx_20260920_1 M7-b: 原式 `Number((c.importance) ?? 0.5) - 0.2` 读的是 **context_json 解析出来的对象**，
        //   而重要度是**列**、从不进 context_json（实测全库 `context_json LIKE '%importance%'` **0 行**）
        //   ⇒ 该式**恒等于 `0.5 - 0.2 = 0.3`**，注释自陈的「降 0.2」从未发生：一条 0.9 的记忆被判负
        //   **直接落到 0.3**（名实不符）。改为**读真列再减**。
        const cur = Number(row?.importance);
        upd.run(JSON.stringify(c), Math.max(0.05, (Number.isFinite(cur) ? cur : MEM_IMPORTANCE_DEFAULT) - 0.2), id);
        resolved++;
      }
      return { data: { ok: true, resolved } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // Phase B (2026-08-28): 记忆注入可视化透出的纠偏入口——降权坏记忆（设 confidence_penalty）
  ipcMain.handle('admin:downweightMemory', async (_event, id: string) => {
    try {
      const row = db.prepare('SELECT context_json FROM wa_memories WHERE id = ?').get(id) as { context_json: string } | undefined;
      if (!row) return { error: { code: 'NOT_FOUND', message: '记忆不存在' } };
      let ctx: Record<string, unknown> = {};
      try { ctx = JSON.parse(row.context_json || '{}'); } catch { ctx = {}; }
      ctx.confidence_penalty = 0.3;
      db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), id);
      return { data: { id, downweighted: true } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // ===== 架构健康诊断（B4不变量 + C2工具统计 + 失败聚类 + 自省两表）=====
  ipcMain.handle('admin:diagnostics', async () => {
    try {
      const invariants = runAllInvariants(db);
      // zx_20261002 M12-3：不变量结论**留档**（每项"变才写"）——与健康五面同一本账、同一条纪律。
      logInvariantTransitions(db, invariants);
      const toolStats = getToolFrequencyStats(db, 7);
      const failureClusters = getFailureClusters(db, 14);
      // zx_20260924_1 M6（F7）: 自省的两本账（架构简化审查报表 / 自愈日志）此前**只写不读**——
      //   报表只有 SQL 里翻得到、自愈日志连读数都没有。用户裁定**接进诊断页**，且**就接在这里**：
      //   这是唯一的诊断出口，不新造第二个端点（否则就成了"两份诊断"，迟早各说各话）。
      //   读取实现落在各自的 core 模块（不放本文件：本文件顶层 import electron，受控回归跑不起来）。
      const simplification = readLatestSimplificationReport(db);
      const selfHealing = readRecentHealingLogs(db);
      // zx_20261016_3 批四：自产提案台账**并进这个唯一诊断出口**——与上面两本账同一条纪律
      //   （此前的方案写的是另开 `selfEvolve:list`，实做为并入此处：两个读口迟早各说各话，
      //   而"诊断页看到的东西"本该只有一处出处。**动作**仍单开 `selfEvolve:decide`——读与写不同路）。
      const proposals = listProposals(db);
      return { data: { invariants, toolStats, failureClusters, simplification, selfHealing, proposals } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  /**
   * zx_20261016_3 批四 · M34：自产提案的**人工闸**（读面在 `admin:diagnostics.proposals`）。
   *
   * 为什么只此三个动作、且**没有**任何自动路径：roadmap 红线是"**绝不允许**自动改源码"，而本闸的
   * 边界是 `self-evolve.decideProposal` 里那道 `assertProposalTargetAllowed`（源码树目标一律拒）。
   * 闸的**判断**全在 core（本层只转发放行——本文件顶层 import electron，受控回归跑不起来）。
   */
  ipcMain.handle('selfEvolve:decide', async (_event, payload: { id: string; decision: 'approve' | 'reject' | 'rollback'; by?: string }) => {
    try {
      if (!PROPOSAL_DECISIONS.includes(payload?.decision)) {
        return { error: { code: 'BAD_PARAMS', message: `decision 仅支持 ${PROPOSAL_DECISIONS.join('/')}` } };
      }
      const r = decideProposal(db, { id: String(payload?.id ?? ''), decision: payload.decision, by: payload?.by });
      if (!r.ok) return { error: { code: 'DECIDE_REJECTED', message: r.detail || r.reason || '未生效' } };
      return { data: { id: payload.id, status: r.status, detail: r.detail ?? '' } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // 架构不变量单项自动修复（仅 autoFixable 项；幂等、单事务；修复后前端重拉 diagnostics）
  ipcMain.handle('admin:repairInvariant', async (_event, payload: { name: string }) => {
    try {
      const res = repairInvariant(db, payload?.name ?? '');
      return { data: res };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // 系统设置读写
  // zx_20261022_3 批四：**密钥键过界即脱敏**（`secret-settings.ts` 一处真源）。
  //   未配置回 `null`（不拿 `***` 谎称已配置）；主进程内部一律直读 DB，不经这两个口。
  ipcMain.handle('settings:get', async (_event, key: string) => {
    const row = db.prepare('SELECT value FROM wa_settings WHERE key=?').get(key) as {value:string}|undefined;
    return { data: redactedSettingValue(key, row?.value ?? null) };
  });
  ipcMain.handle('settings:getAll', async () => {
    const rows = db.prepare('SELECT key, value FROM wa_settings').all() as Array<{key:string;value:string}>;
    const map: Record<string,string> = {};
    rows.forEach(r => { const v = redactedSettingValue(r.key, r.value); if (v != null) map[r.key] = v; });
    return { data: map };
  });
  // zx_20261022_3 批四: 只回「是否已配置」布尔——界面据此显示「已配置，留空不改」占位。
  ipcMain.handle('settings:secretStatus', async () => {
    const rows = db.prepare('SELECT key, value FROM wa_settings').all() as Array<{key:string;value:string}>;
    const out: Record<string, boolean> = {};
    for (const k of SECRET_SETTING_KEYS) out[k] = false;
    for (const r of rows) if (isSecretSettingKey(r.key)) out[r.key] = String(r.value ?? '') !== '';
    return { data: out };
  });
  ipcMain.handle('settings:set', async (_event, key: string, value: string) => {
    // 占位符写回 ⇒ 拒（旧界面/漏改调用点不得把真密钥覆盖成 `***`）。
    if (isSecretMaskValue(key, value)) {
      return { error: { code: 'SECRET_MASKED', message: '密钥字段收到占位符，未写入（留空＝不修改）。' } };
    }
    // zx_20261023_5 批三: 密钥键 → 加密落库；加密后端不可用 ⇒ 如实拒（不悄悄退回明文）。
    if (isSecretSettingKey(key)) {
      const w = writeSecret(db as unknown as DeviceDb, key, value ?? '');
      if (!w.ok) return { error: { code: 'SECRET_WRITE_FAILED', message: w.error } };
    } else {
      db.prepare('INSERT OR REPLACE INTO wa_settings (key,value,updated_at) VALUES (?,?,datetime(\'now\'))').run(key, value);
    }
    // ANS 配置变更时清除 AnsClient 缓存
    if (key.startsWith('ans_')) {
      const { clearAnsClient } = await import('../ipc-handlers.js');
      clearAnsClient();
    }
    // C1 (2026-09-04_2): 设置变更广播 → renderer settingsStore 热更（免打扰/声音运行中即时生效，不重启）
    // zx_20261022_3 批四：**密钥键的广播同样脱敏**（否则读口堵了、广播又漏出去）。
    const emitted = redactedSettingValue(key, value) ?? '';
    try {
      for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.webContents.send('settings:changed', { key, value: emitted }); }
    } catch { /* 广播失败不影响主流程 */ }
    return { data: { key, value: emitted } };
  });

  console.log('[IPC] Admin handlers registered');
}

/** Phase A (2026-08-26): 记忆衍生技能草稿审批 IPC。 */
export function initSkillIpc(db: Database.Database, memory: MemoryManager): void {
  ipcMain.handle('skills:listDrafts', async (_event, { projectId }: { projectId?: string }) => {
    try {
      const drafts = memory.listSkillDrafts(projectId || undefined, 50);
      return { data: { drafts } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('skills:approve', async (_event, { draftId }: { draftId: string }) => {
    try {
      const result = await memory.approveSkill(draftId);
      if (!result) return { error: { code: 'NOT_FOUND', message: '技能草案不存在或已处理' } };
      return { data: result };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('skills:reject', async (_event, { draftId }: { draftId: string }) => {
    try {
      const rejected = memory.rejectSkill(draftId);
      return { data: { rejected } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('skills:list', async () => {
    try {
      const rows = db.prepare(
        "SELECT id, name, description, category, status, created_at FROM wa_skills WHERE status != 'draft' ORDER BY created_at DESC LIMIT 100",
      ).all() as Array<Record<string, unknown>>;
      return { data: { skills: rows } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  console.log('[IPC] Skill handlers registered');
}

/** Phase C (2026-08-28 zx_1): 记忆健康度聚合 + 样例标记 IPC（不新增机制，透出已有健康度 + 复用已有干预）。 */
export function initMemoryIpc(db: Database.Database, memory: MemoryManager): void {
  ipcMain.handle('admin:memoryHealth', async (_event, { projectId }: { projectId?: string }) => {
    try {
      let sql = `SELECT * FROM wa_memories WHERE ${MEM_LIVE_SQL}`;
      const params: unknown[] = [];
      if (projectId) { sql += ' AND project_id = ?'; params.push(projectId); }
      const rows = db.prepare(sql).all(...params) as Array<MemoryEntry & { is_exemplar?: number }>;

      const typeCounts: Record<string, number> = {};
      let conflictCount = 0;
      let exemplarCount = 0;
      let prospectCount = 0;
      let confidenceSum = 0;
      let confidenceN = 0;
      for (const m of rows) {
        typeCounts[m.memory_type] = (typeCounts[m.memory_type] || 0) + 1;
        if (m.is_exemplar) exemplarCount++;
        if (m.memory_type === 'prospective') prospectCount++;
        try {
          const ctx = JSON.parse(m.context_json || '{}') as { conflict_flag?: boolean; potential_conflict?: boolean };
          if (ctx.conflict_flag || ctx.potential_conflict) conflictCount++;
        } catch { /* 忽略非法 context_json */ }
        try {
          confidenceSum += memory.confidenceOf(m);
          confidenceN++;
        } catch { /* 单条计算失败跳过 */ }
      }
      const avgConfidence = confidenceN > 0 ? Math.round((confidenceSum / confidenceN) * 100) : 0;
      const draftCount = (db.prepare("SELECT COUNT(*) as c FROM wa_skills WHERE status = 'draft'").get() as { c: number }).c;
      const tripleCount = (db.prepare('SELECT COUNT(*) as c FROM wa_knowledge_triples').get() as { c: number }).c;

      return { data: {
        total: rows.length,
        typeCounts,
        avgConfidence,
        conflictCount,
        exemplarCount,
        prospectCount,
        draftCount,
        tripleCount,
      }};
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('admin:markExemplar', async (_event, id: string) => {
    try {
      const row = db.prepare('SELECT id FROM wa_memories WHERE id = ?').get(id) as { id: string } | undefined;
      if (!row) return { error: { code: 'NOT_FOUND', message: '记忆不存在' } };
      memory.markExemplar(id, 'good');
      return { data: { id, marked: true } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // zx_20261012_1 批一（M29）: 记忆子系统失败计数快照——空白即"一路无失败"，非 0 即如实告知坏在哪一环。
  ipcMain.handle('memory:failures', async () => {
    try {
      return { data: { failures: memoryFailureSnapshot() } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // zx_20261018_3 批一: 注入账的读口——"注入 N 次 / 主动引用 M 次"从此有页面在念它。
  //   不传 projectId ⇒ 全库口径；传则按项目归集（与 `knowledge:stats` 同一套归法）。
  ipcMain.handle('memory:injectionStats', async (_event, input?: { projectId?: unknown }) => {
    try {
      const projectId = typeof input?.projectId === 'string' && input.projectId ? input.projectId : undefined;
      return { data: memoryInjectionStats(db, projectId) };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  console.log('[IPC] Memory health handlers registered');
}
