/**
 * B2/C2: 项目分析工具（阻塞分析 + 里程碑检测）。
 * 从project-engine.ts提取，独立可测试。
 */

/**
 * @layer domain — 领域层（内因）— 决定系统"是什么"的核心：Agent引擎、任务管理、记忆系统、事件溯源
 */
import type Database from 'better-sqlite3';
import { parseDepIds } from './dep-graph.js';

/** C2: 任务阻塞影响分析 */
export function analyzeBlockers(db: Database.Database, projectId: string): Array<{
  taskId: string; title: string; status: string; blockedCount: number; impactScore: number;
}> {
  try {
    const tasks = db.prepare(
      "SELECT id, title, status, priority FROM wa_tasks WHERE project_id = ? AND status IN ('pending','paused','planning')"
    ).all(projectId) as Array<{ id: string; title: string; status: string; priority: number }>;
    if (tasks.length === 0) return [];

    const allTasks = db.prepare('SELECT id, depends_on FROM wa_tasks WHERE project_id = ?').all(projectId) as Array<{ id: string; depends_on: string }>;
    const blockers: Array<{ taskId: string; title: string; status: string; blockedCount: number; impactScore: number }> = [];

    for (const task of tasks) {
      let blockedCount = 0;
      for (const other of allTasks) {
        // zx_20261002 M8-②（纯 bug）：原为 `other.depends_on.includes(task.id)`——**子串匹配**，
        //   id 是短前缀时会把无关任务算成依赖者（`abc` 命中 `abcd`），阻塞分析与 `impactScore` 随之虚高。
        //   改走全仓唯一解析器 `parseDepIds`（与调度器/工具层同一把尺；`task-notice.ts` 早已如此）。
        if (other.depends_on && parseDepIds(other.depends_on).includes(task.id)) {
          blockedCount++;
        }
      }
      if (blockedCount > 0) {
        const impactScore = blockedCount * 2 + (task.priority || 0) * 0.5;
        blockers.push({ taskId: task.id, title: task.title, status: task.status, blockedCount, impactScore });
      }
    }
    blockers.sort((a, b) => b.impactScore - a.impactScore);
    return blockers;
  } catch { return []; }
}

/** C2: 项目里程碑检测 — 量变到质变的阈值判断 */
export function detectMilestones(db: Database.Database, projectId: string): Array<{
  type: string; title: string; reason: string;
}> {
  const suggestions: Array<{ type: string; title: string; reason: string }> = [];
  try {
    const stats = db.prepare(`
      SELECT
        COUNT(DISTINCT t.id) as totalTasks,
        SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) as completedTasks,
        COUNT(DISTINCT d.id) as deliverables,
        COUNT(DISTINCT k.id) as knowledgeTriples
      FROM wa_tasks t
      LEFT JOIN wa_deliverables d ON d.project_id = t.project_id
      LEFT JOIN wa_knowledge_triples k ON k.project_id = t.project_id
      WHERE t.project_id = ?
    `).get(projectId) as { totalTasks: number; completedTasks: number; deliverables: number; knowledgeTriples: number };

    if (stats.completedTasks >= 10 && stats.deliverables >= 3) {
      suggestions.push({ type: 'phase_transition', title: '建议进入功能开发完成阶段', reason: `已完成${stats.completedTasks}个任务，产出${stats.deliverables}个交付物` });
    }
    if (stats.completedTasks >= 20) {
      suggestions.push({ type: 'refactor_suggestion', title: '建议考虑代码重构', reason: `已完成${stats.completedTasks}个任务，代码量可能已到重构阈值` });
    }
    if (stats.knowledgeTriples >= 50) {
      suggestions.push({ type: 'knowledge_mature', title: '项目知识已成熟', reason: `知识图谱已有${stats.knowledgeTriples}个三元组，可生成知识总结` });
    }
  } catch { /* ignore */ }
  return suggestions;
}

/**
 * zx_20260905 批3/批4 (2026-09-05): 方案里程碑(wa_plan_milestones M0-M6) lean 汇总行——
 * 供执行起始上下文(fact-snapshot)注入与项目详情聚合复用（同源，避免「执行器所见 ≠ 界面所见」）。
 * 无方案里程碑则返回 ''。
 */
export function buildPlanMilestoneLine(db: Database.Database, projectId: string): string {
  try {
    const rows = db.prepare(
      `SELECT m.milestone AS ms, m.status AS st, t.title AS planTitle
       FROM wa_plan_milestones m
       JOIN wa_tasks t ON t.id = m.plan_task_id
       WHERE t.project_id = ? AND (m.project_id IS NULL OR m.project_id = ?)
       ORDER BY m.milestone`
    ).all(projectId, projectId) as Array<{ ms: string; st: string; planTitle: string }>;
    if (rows.length === 0) return '';
    const planTitle = rows[0]!.planTitle.trim().slice(0, 30);
    let done = 0, doing = 0, pending = 0;
    const doingMs: string[] = [];
    for (const r of rows) {
      if (r.st === 'done') done++;
      else if (r.st === 'doing') { doing++; if (!doingMs.includes(r.ms)) doingMs.push(r.ms); }
      else pending++;
    }
    const progress = doingMs.length > 0 ? ` · 进行中:${doingMs.join('/')}` : '';
    return `[方案里程碑] ${planTitle ? `「${planTitle}」` : ''}共${rows.length}项：已落地${done} · 进行中${doing} · 待实施${pending}${progress}`;
  } catch { return ''; }
}

/**
 * zx_20260905 批5 (2026-09-05): 项目质量聚合——quality_score 列(与 context_json.completion_quality 双写)可 SQL 聚合均质/趋势。
 */
export function projectQualityStats(db: Database.Database, projectId: string): { count: number; avg: number | null; low: number; recent: Array<{ id: string; title: string; score: number | null; status: string; updated_at: string }> } {
  const agg = db.prepare(
    "SELECT COUNT(*) AS c, ROUND(AVG(quality_score), 1) AS avg, SUM(CASE WHEN quality_score < 60 THEN 1 ELSE 0 END) AS low FROM wa_tasks WHERE project_id = ? AND quality_score IS NOT NULL"
  ).get(projectId) as { c: number; avg: number | null; low: number | null };
  const recent = db.prepare(
    "SELECT id, title, quality_score AS score, status, updated_at FROM wa_tasks WHERE project_id = ? AND quality_score IS NOT NULL ORDER BY updated_at DESC LIMIT 6"
  ).all(projectId) as Array<{ id: string; title: string; score: number | null; status: string; updated_at: string }>;
  return { count: agg.c || 0, avg: agg.avg, low: agg.low || 0, recent };
}
