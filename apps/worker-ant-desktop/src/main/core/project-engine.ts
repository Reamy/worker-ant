
/**
 * @layer domain — 领域层（内因）— 决定系统"是什么"的核心：Agent引擎、任务管理、记忆系统、事件溯源
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eventBus } from './event-bus.js';
import { analyzeBlockers as analyzeBlockersFn, detectMilestones as detectMilestonesFn } from './project-analytics.js';
// zx_20260930 M4-1: 成果取数范围/计数改为共享真源（本文件只声明范围）。
import { countDeliverablesByType } from './deliverable-lifecycle.js';
// zx_20260929 M5-e: 「库时刻串怎么读成毫秒」取既有唯一真源（`memory-manager.dbTimeMs`），不在此另写一份。
import { dbTimeMs } from './memory-manager.js';
// zx_20261012_2 批二: 任务状态**收类型**——`updateStatus` 此前收裸 `string`（可传入任意拼写），
//   关掉这条"无类型逃生口"；`TaskStatus` 的取值域由 shared-types 一处给（含本轮新增的 `archived`）。
import type { TaskStatus } from '@worker-ant/shared-types';
// zx_20261012_1 批四: 删除项目的级联 SQL 收为**一处真源**（见下方 `deleteProjectCascade`）——
//   此前只在 `project:delete` 内联一份；示例项目删除要走同一条路，故提取共用（禁"两条删除路各写一份"）。
import { tombstoneMemoriesBy, MEM_DELETE_REASONS } from './memory-lifecycle.js';
import { packagedUserDataDir } from './app-paths.js';

let _dataDir: string | null = null;

export function setProjectDataDir(dir: string): void { _dataDir = dir; }

function getDataDir(): string {
  if (_dataDir) return _dataDir;
  const packagedRoot = packagedUserDataDir();
  return packagedRoot ?? path.resolve(process.cwd(), '../../data');
}
function getProjectsDir(): string { return path.join(getDataDir(), 'projects'); }

/**
 * 项目生命周期状态机。
 * active <-> paused
 * active -> completed -> archived
 * completed/archived -> active (重新激活)
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  active: ['paused', 'completed'],
  paused: ['active', 'completed'],
  completed: ['archived', 'active'],
  archived: ['active', 'completed'],
};

export function validateTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

/**
 * 「这个项目归谁」——**一处真源**（`project:create` 与示例项目载入共用同一把尺）。
 *
 * ⚠ `wa_projects.owner_id → wa_users(id)` 外键在（`database.ts:24` `db.pragma('foreign_keys = ON')`），
 *   故 owner **必须是真实存在**的用户 id——或 NULL（SQLite 外键**对 NULL 子键不作要求**）。
 *   写一个字面量占位（`'sample'` / `'default'`）即 `FOREIGN KEY constraint failed`。
 *   （实测：示例项目原写 `owner_id='sample'` ⇒ 一键载入 100% 失败；`project:create` 原兜底 `'default'`
 *   是同一形态的哑雷——仅当无 super_admin 时才引爆，故长期未被发现。）
 *
 * 规则：super_admin 优先（历史口径）→ 最早创建的用户 → 再无（全新库）⇒ NULL（外键允许，如实"无主"）。
 */
export function resolveProjectOwnerId(db: Database.Database): string | null {
  const admin = db.prepare("SELECT id FROM wa_users WHERE role = 'super_admin' LIMIT 1").get() as { id: string } | undefined;
  if (admin?.id) return admin.id;
  const first = db.prepare('SELECT id FROM wa_users ORDER BY created_at LIMIT 1').get() as { id: string } | undefined;
  return first?.id ?? null;
}

/**
 * zx_20261018_3 批五「显」: 全部项目的任务统计——**一条 `GROUP BY`**（一处真源）。
 *
 * 病根：`_enrichProject` 对每个项目各跑一条 COUNT，N 个项目 = N 次查询；渲染层 ProjectsPage
 * 还再对每个项目各调一次 `task:list`（N+1 IPC）来覆盖同一组数字——同一个问题两种代价。
 * 这里收成一条语句，`ProjectEngine.list()` 与 IPC `projects:stats` 共用。
 *
 * 语义：分组里**没有**的项目 = 该项目确实零任务（真零），不是取数失败——两者在界面上
 * 必须分得开（失败的标本由 `projects:stats` 调用失败来标，而不是伪造 `{total:0}`）。
 */
export function taskStatsByProject(db: Database.Database): Record<string, { total: number; completed: number }> {
  const rows = db.prepare(
    `SELECT project_id, COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
     FROM wa_tasks WHERE project_id IS NOT NULL GROUP BY project_id`,
  ).all() as Array<{ project_id: string | null; total: number; completed: number }>;
  const out: Record<string, { total: number; completed: number }> = {};
  for (const r of rows) {
    if (!r.project_id) continue;
    out[r.project_id] = { total: Number(r.total) || 0, completed: Number(r.completed) || 0 };
  }
  return out;
}

/**
 * zx_20261012_1 批四：删除项目的**级联**（一处真源）。
 *
 * 单事务清：通知（项目级 + 各任务级）→ 任务会话 → 成果版本 → KG 三元组 → 任务 → 成果 →
 *   记忆**落墓碑**（`tombstoneMemoriesBy`，非物理删，承"账必有痕"）→ 项目成员 → 项目行。
 *
 * 谁在用：`ipc/project.ipc.ts` 的 `project:delete`，以及示例项目删除（`core/sample-project.ts` 的
 *   `removeSampleProject`）——**两条删除路同一份 SQL**。此前该级联内联在 IPC 处理器里，示例项目
 *   删除若另写一份，迟早漏清某张子表（同 `zx_20260907` 那次 FK 约束炸出来的病）。
 *
 * ⚠ 本函数**不清磁盘** `working_dir`（那是调用方的事：普通项目保留目录，示例项目随删随清）。
 * 返回被删前取到的 task ids（供调用方做磁盘/其它清理；无则空数组）。
 */
/**
 * zx_20261012_3 批一：删除项目时，清它**自有的数据目录**（`<dataDir>/projects/<projectId>/`）——**一处真源**。
 *
 * ⚠ **安全底线（★绝不可越）**：清的**只能是**工蚁自有的 `data/projects/<projectId>/`，
 *   **绝不**是 `wa_projects.working_dir`——后者指向**用户自己的代码仓**
 *   （实测：某项目 `working_dir=/Users/…/proj/dept/workrepo/代码`，那是用户的真实代码）。
 *   按 `working_dir` 删 = 清错盘 = 毁用户代码，故本函数**只认 `dataDir` + `projectId` 拼出的那一路**。
 *
 * 纪律：
 *   - **幂等**：目录本不存在 ⇒ `rmSync(force)` 不抛，返回 `ok:true`（"已清"）。
 *   - **失败不阻断**：删库已在先（事务），清盘失败**不回滚**、只返回 `ok:false` + `reason`，
 *     由调用方**记痕**（不静默吞）。
 *   - **单段闸**：项目 id 恒为 UUID / `sample-…` 这类**单段**串；含路径分隔符或 `..` 一律拒——
 *     防 `path.join` 把 `../../` 夹带进来穿越出 `projects/`。
 */
export function removeProjectDataDir(dataDir: string, projectId: string): { ok: boolean; dir: string; reason?: string } {
  if (!projectId || path.basename(projectId) !== projectId) {
    return { ok: false, dir: '', reason: `非法项目 id（含路径分隔符或上级引用）：${JSON.stringify(projectId)}` };
  }
  const base = path.join(dataDir, 'projects');
  const dir = path.join(base, projectId);
  if (!dir.startsWith(base + path.sep)) {
    return { ok: false, dir, reason: '目标不在数据目录内' };
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, dir };
  } catch (err) {
    return { ok: false, dir, reason: (err as Error).message };
  }
}

export function deleteProjectCascade(db: Database.Database, id: string): string[] {
  let taskIds: string[] = [];
  const delProject = db.transaction(() => {
    taskIds = (db.prepare('SELECT id FROM wa_tasks WHERE project_id = ?').all(id) as Array<{ id: string }>).map((r) => r.id);
    const dIds = (db.prepare('SELECT id FROM wa_deliverables WHERE project_id = ?').all(id) as Array<{ id: string }>).map((r) => r.id);
    db.prepare('DELETE FROM wa_notifications WHERE project_id = ?').run(id);
    for (const tid of taskIds) { db.prepare('DELETE FROM wa_notifications WHERE task_id = ?').run(tid); }
    if (taskIds.length > 0) {
      db.prepare(`DELETE FROM wa_task_conversations WHERE task_id IN (${taskIds.map(() => '?').join(',')})`).run(...taskIds);
    }
    if (dIds.length > 0) {
      db.prepare(`DELETE FROM wa_deliverable_versions WHERE deliverable_id IN (${dIds.map(() => '?').join(',')})`).run(...dIds);
    }
    db.prepare('DELETE FROM wa_knowledge_triples WHERE project_id = ?').run(id);
    // zx_20261022_3 批七: 项目知识册**随项目消失**——派生册、已导入册、导入账三者都是"本项目的"，
    //   不是可携带资产（可携带的形态是导出的 .jsonl 文件本身，不在这三张表里）。
    //   ⚠ 此前派生册未清理：删项目后留孤儿行，再建同 id 项目会"继承"旧知识（本次一并补上）。
    db.prepare('DELETE FROM wa_project_knowledge WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM wa_project_knowledge_imports WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM wa_knowledge_imports WHERE project_id = ?').run(id);
    // zx_20261022_3 批八: 画像依附于本项目（不是可携带资产；带走它的形态是导出/Team 共享）。
    db.prepare('DELETE FROM wa_project_profiles WHERE project_id = ?').run(id);
    // zx_20261021_3 批一: 只删**本项目的启用关系**；`wa_domain_packs` 资产**不删**——
    //   源项目消失不该毁掉已经带走的东西（它可能已被别的项目启用、或经共享库流到别处）。
    db.prepare('DELETE FROM wa_project_domain_packs WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM wa_tasks WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM wa_deliverables WHERE project_id = ?').run(id);
    tombstoneMemoriesBy(db, 'project_id', id, MEM_DELETE_REASONS.projectCascade);
    db.prepare('DELETE FROM wa_project_members WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM wa_projects WHERE id = ?').run(id);
  });
  delProject();
  return taskIds;
}

export class ProjectEngine {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(data: { name: string; description?: string; cron_schedule?: string; cron_timezone?: string; owner_id: string | null; working_dir?: string }) {
    const id = randomUUID();
    const workingDir = data.working_dir || path.join(getProjectsDir(), id);
    // 创建项目工作目录
    try { fs.mkdirSync(workingDir, { recursive: true }); } catch { /* ignore */ }
    this.db.prepare(
      'INSERT INTO wa_projects (id, name, description, cron_schedule, cron_timezone, working_dir, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, data.name, data.description ?? '', data.cron_schedule ?? null, data.cron_timezone || 'Asia/Shanghai', workingDir, data.owner_id);
    return this.getById(id);
  }

  getById(id: string) {
    const project = this.db.prepare('SELECT * FROM wa_projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!project) return undefined;
    return this._enrichProject(project);
  }

  private _enrichProject(
    p: Record<string, unknown>,
    taskStatsAll?: Record<string, { total: number; completed: number }>,
  ): Record<string, unknown> {
    // BLOB→String: SQLite context_json 存为 BLOB 时 better-sqlite3 返回 Buffer
    if (p.context_json instanceof Buffer) {
      p.context_json = (p.context_json as Buffer).toString('utf-8');
    }
    const now = Date.now();
    const STALE_MS = 24 * 60 * 60 * 1000;
    const DORMANT_MS = 7 * 24 * 60 * 60 * 1000;
    // zx_20260904_7 修复(2026-09-04): 活跃度按"真实最近活动"，而非仅项目行 updated_at——
    // 任务执行只更新任务/会话行、不 bump 项目行，导致有任务在跑的项目也被判 stale"低活跃"
    // zx_20260910_3 M4 修复(2026-09-10): 上面那句取数语句本身有两处错——此前改好却一直漂在工作区未提交。
    // ① 对话 created_at 与任务表同名列 ⇒ SQLite 抛 "ambiguous column" 被下方 catch 吞掉 ⇒ activityMs 回退项目行
    //    updated_at(任务执行不 bump) ⇒ 长期活跃的项目被判 dormant/stale。消歧为 c.created_at。
    // ② julianday 转 Unix 毫秒须减 2440587.5 天文偏移，否则活动时间落在公元 8700+ 年、age 恒 0 ⇒ 全部误判活跃。
    //    注: ① 先抛异常，② 在实际运行中被 ① 遮蔽(修复前该语句从未跑通)；两处须一并修，修一漏一即复发。
    // zx_20260929 M5-e（管子·度量衡）：库里的时刻串是 SQLite `datetime('now')` 的**无时区 UTC**
    //   （`YYYY-MM-DD HH:MM:SS`，不带 `Z`），裸 `new Date(串)` 会按**本地**解析 ⇒ UTC+8 下凭空多算
    //   8 小时（活动时间被读晚 8 小时 ⇒ 活跃项目被判 stale/dormant）。改走既有唯一真源 `dbTimeMs`
    //   （它按 `Z`/偏移量判定，无时区串补 `T`+`Z`）——与 `memory-manager` 的 7 处时间读数同一把尺。
    //   ⚠ 保留 `? : 0` 的形状：`dbTimeMs('')` 返回 `NaN`，而本处"无 updated_at"的既有语义是 **0**
    //     （下面 `Math.max(0, now - activityMs)` 要的是"很久以前"，不是 NaN）。
    //   ⚠ 仅回退分支生效（正常路径由下方 julianday 那份 SQL 赢得），故这是"备胎的时区"——但备胎错误
    //     同样会污染结论，故一并归尺。
    let activityMs = p.updated_at ? dbTimeMs(p.updated_at as string) : 0;
    try {
      const mRow = this.db.prepare(`
        SELECT MAX(julianday(u)) AS m FROM (
          SELECT updated_at AS u FROM wa_tasks WHERE project_id = ?
          UNION ALL SELECT c.created_at FROM wa_task_conversations c JOIN wa_tasks t ON c.task_id = t.id AND t.project_id = ?
          UNION ALL SELECT created_at FROM wa_deliverables WHERE project_id = ?
          UNION ALL SELECT updated_at FROM wa_projects WHERE id = ?
        )`).get(p.id, p.id, p.id, p.id) as { m: number | null };
      if (mRow.m != null) activityMs = Math.round((mRow.m - 2440587.5) * 86400000);
    } catch { /* 活动时间取数失败回退项目行 */ }
    const age = Math.max(0, now - activityMs);
    const runningNow = (this.db.prepare("SELECT COUNT(*) AS c FROM wa_tasks WHERE project_id = ? AND status IN ('executing','running','preparing','pending','planning')").get(p.id) as { c: number }).c;

    // zx_20261018_3 批五: 列表路用**一次 GROUP BY** 的结果（`taskStatsAll`）；单项目路（getById）
    //   仍现查这一条——一个项目一条 COUNT 不构成 N+1。
    const taskStats = taskStatsAll
      ? (taskStatsAll[String(p.id)] ?? { total: 0, completed: 0 })
      : (this.db.prepare(
        'SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN status = ? THEN 1 ELSE 0 END), 0) as completed FROM wa_tasks WHERE project_id = ?',
      ).get('completed', p.id) as { total: number; completed: number });

    // Q4: 项目Token消耗汇总
    const tokenStats = this.db.prepare(
      'SELECT COALESCE(SUM(c.token_count), 0) as total_tokens FROM wa_task_conversations c JOIN wa_tasks t ON c.task_id = t.id WHERE t.project_id = ? AND c.token_count > 0',
    ).get(p.id) as { total_tokens: number };

    // 产出物统计（zx_20260906 批3/3e: 排除 soft-retired 重试旧成果，不虚增当前产出）
    // zx_20260906_1 3c: 临时脚本(_verify/_probe/_tmp/test_<hash>.py)不计入"总成果数"——写完临时探针的任务不再虚增 total
    // zx_20260911_2 M4-G4(管子·度量衡 / 康德·范畴统一): 谓词收敛到共享 docNotProbe('')——
    //   此前此处内联(且以 file_path 单列判、NULL 视为非探针)，与列表/健康视图/全景三处口径不一 ⇒ 同一项目的"产出物 N"各处不等。
    // zx_20260913 M2-4 连带同尺(管子·度量衡 / 维特根斯坦·同一把尺): 分项由**字面量清单**改为 GROUP BY type 的**实得分组**。
    //   此前只列 mcp/a2a/ui/doc 四类(CASE WHEN 写死)，code/daemon 有实得却无分项；且 total 由 COUNT(*) 单独求、
    //   与分项是**两把尺** ⇒ 新增类型即两处不等(同 deliverableSummary 的 total≠Σchips 病根)。
    //   改为先分组、total 由分组求和 ⇒ 总数与分项恒同源；日后新增类型不必再改此处。
    // zx_20260930 M4-1: 分组这一跳改由共享真源出（`countDeliverablesByType`，含空类型归 'other'）。
    //   **保留**"total 由分项求和"这一步——它正是本轮"同源"的要点，收进真源函数反而看不见这层关系。
    const delivGroups = countDeliverablesByType(this.db, { projectId: String(p.id) });
    const deliverableStats: Record<string, number> = {};
    for (const g of delivGroups) {
      deliverableStats[g.type] = (deliverableStats[g.type] || 0) + g.c;
      deliverableStats.total = (deliverableStats.total || 0) + g.c;
    }

    return {
      ...p,
      staleness: runningNow > 0 ? 'healthy' : age > DORMANT_MS ? 'dormant' : age > STALE_MS ? 'stale' : 'healthy',
      lastActive: new Date(activityMs).toISOString(),
      taskStats: { total: taskStats.total, completed: taskStats.completed },
      tokenStats: { total_tokens: tokenStats.total_tokens || 0 },
      deliverableStats,
    };
  }

  list() {
    const projects = this.db.prepare('SELECT * FROM wa_projects ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
    // zx_20261018_3 批五: 任务统计一次聚合给全部项目（此前每项目一条 COUNT）。
    const stats = taskStatsByProject(this.db);
    return projects.map((p) => this._enrichProject(p, stats));
  }

  transitionStatus(id: string, newStatus: string) {
    const project = this.getById(id) as Record<string, unknown> | undefined;
    if (!project) throw new Error('Project not found');
    if (!validateTransition(project.status as string, newStatus)) {
      throw new Error(`Invalid transition: ${project.status} -> ${newStatus}`);
    }
    this.db.prepare("UPDATE wa_projects SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, id);
    eventBus.emit('project.status_changed', { projectId: id, oldStatus: project.status, newStatus }).catch(() => {});
    return this.getById(id);
  }

  addMember(projectId: string, userId: string, role = 'developer') {
    this.db.prepare('INSERT OR IGNORE INTO wa_project_members (project_id, user_id, role) VALUES (?, ?, ?)').run(projectId, userId, role);
  }

  getMembers(projectId: string) {
    return this.db.prepare(
      'SELECT u.id, u.email, u.name, pm.role FROM wa_users u JOIN wa_project_members pm ON u.id = pm.user_id WHERE pm.project_id = ?',
    ).all(projectId);
  }

  /** 获取任务及其所属项目的完整上下文，用于恢复中断的任务 */
  getTaskWithProject(taskId: string) {
    const row = this.db.prepare(`
      SELECT
        t.id as taskId, t.title as taskTitle, t.description as taskDescription,
        t.acceptance_criteria as acceptanceCriteria,
        p.name as projectName, p.description as projectDescription,
        p.working_dir as projectWorkingDir
      FROM wa_tasks t
      JOIN wa_projects p ON t.project_id = p.id
      WHERE t.id = ?
    `).get(taskId) as {
      taskId: string; taskTitle: string; taskDescription: string;
      acceptanceCriteria: string; projectName: string;
      projectDescription: string; projectWorkingDir: string;
    } | undefined;
    return row;
  }
}

export class TaskManager {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(data: { project_id: string; title: string; description?: string; workflow_config?: Record<string, unknown>; priority?: number; acceptance_criteria?: string }) {
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO wa_tasks (id, project_id, title, description, workflow_config, priority, source, acceptance_criteria) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, data.project_id, data.title, data.description ?? '', JSON.stringify(data.workflow_config ?? {}), data.priority ?? 0, 'user', data.acceptance_criteria || '');
    return this.getById(id);
  }

  getById(id: string) {
    return this.db.prepare('SELECT * FROM wa_tasks WHERE id = ?').get(id);
  }

  listByProject(projectId: string) {
    return this.db.prepare('SELECT * FROM wa_tasks WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
  }

  updateStatus(id: string, status: TaskStatus, opts?: { skipCooling?: boolean }) {
    // P1.1 烹小鲜稳定原则：状态变更冷却检测
    const COOLING_WINDOW_MS = 5 * 60 * 1000;
    const MAX_CHANGES = 3;

    if (!opts?.skipCooling) {
      try {
        const task = this.db.prepare('SELECT context_json, status FROM wa_tasks WHERE id = ?').get(id) as { context_json: string; status: string } | undefined;
        if (task) {
          const ctx = JSON.parse(task.context_json || '{}');
          const changes: Array<{ from: string; to: string; at: string }> = ctx.status_changes || [];
          const now = Date.now();
          const recent = changes.filter(c => now - new Date(c.at).getTime() < COOLING_WINDOW_MS);
          recent.push({ from: task.status, to: status, at: new Date().toISOString() });
          ctx.status_changes = recent;
          if (recent.length >= MAX_CHANGES && status !== 'stabilizing' && status !== 'completed' && status !== 'failed') {
            this.db.prepare("UPDATE wa_tasks SET status = 'stabilizing', context_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(ctx), id);
            this.addConversation(id, 'system', `[烹小鲜·稳定] 任务在${COOLING_WINDOW_MS / 60000}分钟内状态变更${recent.length}次(超过阈值${MAX_CHANGES})，进入stabilizing暂态。自动操作已暂停，请人工确认后恢复。`);
            return;
          }
          this.db.prepare("UPDATE wa_tasks SET status = ?, context_json = ?, updated_at = datetime('now') WHERE id = ?").run(status, JSON.stringify(ctx), id);
          return;
        }
      } catch { /* cooling check best-effort */ }
    }
    this.db.prepare("UPDATE wa_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  }

  updateContext(id: string, context: Record<string, unknown>) {
    this.db.prepare("UPDATE wa_tasks SET context_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), id);
  }

  addConversation(taskId: string, role: string, content: string, toolCalls?: unknown, tokenCount = 0) {
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO wa_task_conversations (id, task_id, role, content, tool_calls, token_count) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, taskId, role, content, toolCalls ? JSON.stringify(toolCalls) : null, tokenCount);
    return { id, task_id: taskId, role, content };
  }

  getConversations(taskId: string, limit = 200, offset = 0, role?: string) {
    if (role) {
      return this.db.prepare(
        'SELECT * FROM wa_task_conversations WHERE task_id = ? AND role = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      ).all(taskId, role, limit, offset);
    }
    // 默认返回最新的（DESC），前端反转显示
    return this.db.prepare(
      'SELECT * FROM wa_task_conversations WHERE task_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(taskId, limit, offset);
  }

  countConversations(taskId: string, role?: string): number {
    if (role) {
      return (this.db.prepare(
        'SELECT COUNT(*) as c FROM wa_task_conversations WHERE task_id = ? AND role = ?',
      ).get(taskId, role) as { c: number }).c;
    }
    return (this.db.prepare(
      'SELECT COUNT(*) as c FROM wa_task_conversations WHERE task_id = ?',
    ).get(taskId) as { c: number }).c;
  }

  // ---------------------------------------------------------------
  // C2: 智能阻塞识别
  // ---------------------------------------------------------------

  /** C2: 任务阻塞影响分析 → project-analytics.ts */
  analyzeBlockers(projectId: string): Array<{ taskId: string; title: string; status: string; blockedCount: number; impactScore: number }> {
    return analyzeBlockersFn(this.db, projectId);
  }

  /** C2: 项目里程碑检测 → project-analytics.ts */
  detectMilestones(projectId: string): Array<{ type: string; title: string; reason: string }> {
    return detectMilestonesFn(this.db, projectId);
  }
}
