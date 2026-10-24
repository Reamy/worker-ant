/**
 * P0.4 矛盾驱动优先级——瓶颈分析器。
 * 识别阻塞关系、资源竞争、时间敏感度，计算动态优先级分数。
 *
 * 矛盾论核心思想：抓主要矛盾——在任何时刻找出系统的 ONE bottleneck。
 * 矛盾的主要方面会转化——瓶颈是动态的，周期性重新评估。
 */
import type Database from 'better-sqlite3';
import { createLogger } from './logger.js';

const logger = createLogger('bottleneck');

interface TaskRecord {
  id: string;
  title: string;
  status: string;
  priority: number;
  depends_on: string;
  parent_task_id: string;
  project_id: string;
  created_at: string;
  updated_at: string;
  context_json: string;
}

export interface BottleneckScore {
  taskId: string;
  blockingCount: number;
  blockedTasks: string[];
  resourceCriticality: number;
  timeSensitivity: number;
  dynamicPriority: number;
  isPrincipalContradiction: boolean;
}

/**
 * 分析项目的任务瓶颈并更新动态优先级。
 * 返回主要矛盾（得分最高的任务）。
 */
export function analyzeProjectBottlenecks(
  db: Database.Database,
  projectId: string,
): { scores: BottleneckScore[]; principalContradiction: BottleneckScore | null } {
  const tasks = db.prepare(
    "SELECT * FROM wa_tasks WHERE project_id = ? AND status NOT IN ('completed', 'failed', 'archived')",
  ).all(projectId) as TaskRecord[];

  if (tasks.length === 0) return { scores: [], principalContradiction: null };

  const taskMap = new Map<string, TaskRecord>();
  for (const t of tasks) taskMap.set(t.id, t);

  // 构建反向依赖图：taskId → 被它阻塞的任务列表
  const blocksWho = new Map<string, string[]>();
  for (const t of tasks) {
    const deps = (t.depends_on || '').split(',').filter(Boolean);
    for (const depId of deps) {
      if (!blocksWho.has(depId)) blocksWho.set(depId, []);
      blocksWho.get(depId)!.push(t.id);
    }
    if (t.parent_task_id) {
      if (!blocksWho.has(t.parent_task_id)) blocksWho.set(t.parent_task_id, []);
      blocksWho.get(t.parent_task_id)!.push(t.id);
    }
  }

  const scores: BottleneckScore[] = [];

  for (const task of tasks) {
    // 1. 阻塞因子：该任务阻塞了多少下游任务（BFS遍历阻塞链）
    const blockedTasks = collectBlockedChain(task.id, blocksWho, taskMap);
    const blockingCount = blockedTasks.length;
    const blockingFactor = Math.tanh(blockingCount / 5); // 0-1归一化

    // 2. 资源关键度：执行中的任务占用资源，非执行任务资源竞争低
    const isExecuting = task.status === 'executing' || task.status === 'running';
    const resourceCriticality = isExecuting
      ? Math.min(1.0, blockingCount > 0 ? 0.8 : 0.3)
      : blockingCount > 0 ? 0.4 : 0.1;

    // 3. 时间敏感度：基于任务创建时间和状态
    const ageHours = (Date.now() - new Date(task.created_at + 'Z').getTime()) / 3600000;
    const timeSensitivity = task.status === 'paused'
      ? Math.tanh(ageHours / 24)  // 暂停越久越敏感
      : task.status === 'pending'
        ? Math.min(1.0, ageHours / 48)  // 待执行超过48h → 紧迫
        : task.status === 'executing'
          ? Math.max(0.2, Math.tanh(ageHours / 6))  // 执行超过6h → 关注
          : 0.1;

    // 4. 动态优先级分数：blocking_factor × 0.4 + resource_criticality × 0.3 + time_sensitivity × 0.3
    const dynamicPriority = Math.round(
      (blockingFactor * 0.4 + resourceCriticality * 0.3 + timeSensitivity * 0.3) * 100,
    ) / 100;

    const score: BottleneckScore = {
      taskId: task.id,
      blockingCount,
      blockedTasks,
      resourceCriticality: Math.round(resourceCriticality * 100) / 100,
      timeSensitivity: Math.round(timeSensitivity * 100) / 100,
      dynamicPriority,
      isPrincipalContradiction: false,
    };
    scores.push(score);
  }

  // 排序并标记主要矛盾（top 3）
  scores.sort((a, b) => b.dynamicPriority - a.dynamicPriority);
  if (scores.length > 0) {
    const threshold = scores[0]!.dynamicPriority;
    for (const s of scores) {
      s.isPrincipalContradiction = s.dynamicPriority >= threshold * 0.8 && s.dynamicPriority > 0.3;
    }
  }

  // 持久化到 task context_json
  const updateStmt = db.prepare('UPDATE wa_tasks SET context_json = ?, priority = ? WHERE id = ?');
  for (const score of scores) {
    try {
      const task = taskMap.get(score.taskId);
      if (!task) continue;
      const ctx = JSON.parse(task.context_json || '{}');
      ctx.dynamic_priority = score.dynamicPriority;
      ctx.bottleneck_score = {
        blocking_count: score.blockingCount,
        resource_criticality: score.resourceCriticality,
        time_sensitivity: score.timeSensitivity,
        is_principal_contradiction: score.isPrincipalContradiction,
        computed_at: new Date().toISOString(),
      };
      // 将动态优先级映射到priority字段：>0.7→2(紧急), >0.4→1(高), 其余→0(普通)
      const mappedPrio = score.dynamicPriority > 0.7 ? 2 : score.dynamicPriority > 0.4 ? 1 : task.priority;
      updateStmt.run(JSON.stringify(ctx), mappedPrio, score.taskId);
    } catch { /* best-effort */ }
  }

  logger.info({ projectId, taskCount: tasks.length, principalCount: scores.filter(s => s.isPrincipalContradiction).length },
    '[矛盾分析] 瓶颈分析完成');

  return {
    scores,
    principalContradiction: scores.filter(s => s.isPrincipalContradiction)[0] || null,
  };
}

/** BFS遍历阻塞链：从taskId开始，收集所有直接/间接被阻塞的任务 */
function collectBlockedChain(
  taskId: string,
  blocksWho: Map<string, string[]>,
  taskMap: Map<string, TaskRecord>,
  visited: Set<string> = new Set(),
): string[] {
  if (visited.has(taskId)) return [];
  visited.add(taskId);
  const direct = blocksWho.get(taskId) || [];
  const result: string[] = [...direct];
  for (const childId of direct) {
    result.push(...collectBlockedChain(childId, blocksWho, taskMap, visited));
  }
  return [...new Set(result)];
}

/** P0.4: 获取项目的瓶颈摘要（供API和前端使用） */
export function getBottleneckSummary(
  db: Database.Database,
  projectId: string,
): { principalContradictions: BottleneckScore[]; summary: string } {
  const { scores, principalContradiction } = analyzeProjectBottlenecks(db, projectId);

  const principals = scores.filter(s => s.isPrincipalContradiction);
  const summary = principals.length > 0
    ? `当前主要矛盾：${principals.map(p => {
        const parts: string[] = [];
        if (p.blockingCount > 0) parts.push(`阻塞${p.blockingCount}个下游任务`);
        if (p.resourceCriticality > 0.5) parts.push('资源竞争激烈');
        if (p.timeSensitivity > 0.5) parts.push('时间紧迫');
        return parts.join('+');
      }).join('；')}`
    : '当前无明显瓶颈';

  return { principalContradictions: principals, summary };
}
