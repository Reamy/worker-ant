/**
 * C3: 架构张力管理引擎（从原工蚁 tension-engine.ts 移植）。
 * "矛盾存在于一切事物的发展过程中"——五大张力显式管理。
 */
import type Database from 'better-sqlite3';
import { createLogger } from './logger.js';

const logger = createLogger('tension');

export interface TensionState {
  position: number;
  autoAdjust: boolean;
  updatedAt: string;
}

export interface TensionConfig {
  id: string;
  name: string;
  leftLabel: string;
  rightLabel: string;
  defaultPosition: number;
  description: string;
}

export const TENSION_CONFIGS: Record<string, TensionConfig> = {
  'simplicity-vs-power': { id: 'simplicity-vs-power', name: '简单 vs 强大', leftLabel: '保持简单', rightLabel: '功能完备', defaultPosition: 60, description: '工具数量与功能丰富度的平衡' },
  'autonomy-vs-control': { id: 'autonomy-vs-control', name: '自治 vs 可控', leftLabel: 'Agent自治', rightLabel: '人工控制', defaultPosition: 30, description: 'Agent自主决策与人工审批的平衡' },
  'general-vs-specialized': { id: 'general-vs-specialized', name: '通用 vs 专用', leftLabel: '通用Agent', rightLabel: '专用工具链', defaultPosition: 50, description: '通用能力与场景定制的平衡' },
  'consistency-vs-availability': { id: 'consistency-vs-availability', name: '一致性 vs 可用性', leftLabel: '强一致性', rightLabel: '高可用性', defaultPosition: 30, description: '数据一致性与响应速度的平衡' },
  'speed-vs-quality': { id: 'speed-vs-quality', name: '速度 vs 质量', leftLabel: '快速执行', rightLabel: '高质量输出', defaultPosition: 50, description: '执行速度与产出质量的平衡' },
};

export function getDefaultTensions(): Record<string, TensionState> {
  const result: Record<string, TensionState> = {};
  for (const [id, config] of Object.entries(TENSION_CONFIGS)) {
    result[id] = { position: config.defaultPosition, autoAdjust: false, updatedAt: new Date().toISOString() };
  }
  return result;
}

export function getTensions(db: Database.Database, projectId: string): Record<string, TensionState> {
  try {
    const proj = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string } | undefined;
    const ctx = JSON.parse(proj?.context_json || '{}');
    return ctx.tensions || getDefaultTensions();
  } catch { return getDefaultTensions(); }
}

export function updateTension(db: Database.Database, projectId: string, tensionId: string, update: { position?: number; autoAdjust?: boolean }): TensionState {
  const tensions = getTensions(db, projectId);
  if (!tensions[tensionId]) tensions[tensionId] = { position: TENSION_CONFIGS[tensionId]?.defaultPosition || 50, autoAdjust: false, updatedAt: '' };
  if (update.position !== undefined) tensions[tensionId].position = Math.max(0, Math.min(100, update.position));
  if (update.autoAdjust !== undefined) tensions[tensionId].autoAdjust = update.autoAdjust;
  tensions[tensionId].updatedAt = new Date().toISOString();
  const proj = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string } | undefined;
  const ctx = JSON.parse(proj?.context_json || '{}');
  ctx.tensions = tensions;
  db.prepare("UPDATE wa_projects SET context_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(ctx), projectId);
  return tensions[tensionId];
}

export function evaluateAutoTensions(db: Database.Database, projectId: string): Array<{ tensionId: string; from: number; to: number; reason: string }> {
  const adjustments: Array<{ tensionId: string; from: number; to: number; reason: string }> = [];
  const tensions = getTensions(db, projectId);
  const rules: Array<{ tensionId: string; metric: string; check: (db: Database.Database, pid: string) => boolean; direction: 'left' | 'right'; amount: number }> = [
    {
      tensionId: 'autonomy-vs-control', metric: 'auto_mode_failure_rate', direction: 'right', amount: 15,
      check: (db, pid) => {
        const stats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed FROM wa_tasks WHERE project_id = ? AND source = 'autonomous' AND created_at >= datetime('now', '-7 days')").get(pid) as { total: number; failed: number };
        return stats.total >= 3 && (stats.failed / stats.total) > 0.2;
      },
    },
    {
      tensionId: 'speed-vs-quality', metric: 'no_deliverable_streak', direction: 'right', amount: 10,
      check: (db, pid) => {
        const recent = db.prepare("SELECT context_json FROM wa_tasks WHERE project_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 3").all(pid) as Array<{ context_json: string }>;
        if (recent.length < 3) return false;
        // zx_20260928 M5（D4·读出端）: 原为 `!ctx.execution_metrics?.hasDeliverable`——缺键时 `!undefined === true`，
        //   把「这个任务没记过指标（**未知**）」读成「没有产出物（**事实**）」并据此右调张力；`catch` 里的 `return true`
        //   是同一个病的另一层（解析不了同样是未知）。改为**一律弃权**：只有**明确记着** `hasDeliverable === false`
        //   才算「没产出」。⚠ 持久化键名 `hasDeliverable` **一字不改**——改名会让全部存量行读成 `undefined`，
        //   反成误报（`rr_zx_20260917` 判据 N-4 已把这层反证钉住）。
        return recent.every(r => { try { const m = JSON.parse(r.context_json || '{}').execution_metrics; return m != null && m.hasDeliverable === false; } catch { return false; } });
      },
    },
    {
      tensionId: 'autonomy-vs-control', metric: 'supervised_all_approved', direction: 'left', amount: 10,
      check: (db, pid) => {
        const supervised = db.prepare("SELECT COUNT(*) as cnt FROM wa_tasks WHERE project_id = ? AND source = 'autonomous' AND status = 'completed' AND created_at >= datetime('now', '-7 days')").get(pid) as { cnt: number };
        return supervised.cnt >= 10;
      },
    },
  ];
  for (const rule of rules) {
    const tension = tensions[rule.tensionId];
    if (!tension?.autoAdjust) continue;
    try {
      if (rule.check(db, projectId)) {
        const from = tension.position;
        const delta = rule.direction === 'left' ? -rule.amount : rule.amount;
        const to = Math.max(0, Math.min(100, from + delta));
        tension.position = to;
        tension.updatedAt = new Date().toISOString();
        adjustments.push({ tensionId: rule.tensionId, from, to, reason: rule.metric });
      }
    } catch { /* skip */ }
  }
  if (adjustments.length > 0) {
    const proj = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string } | undefined;
    const ctx = JSON.parse(proj?.context_json || '{}');
    ctx.tensions = tensions;
    db.prepare("UPDATE wa_projects SET context_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(ctx), projectId);
    logger.info({ projectId, adjustments }, 'C3张力自动调节');
  }
  return adjustments;
}

export function generateTensionContext(db: Database.Database, projectId: string): string {
  try {
    const tensions = getTensions(db, projectId);
    const parts: string[] = [];
    for (const [id, config] of Object.entries(TENSION_CONFIGS)) {
      const t = tensions[id];
      if (!t) continue;
      const leftPct = Math.round(100 - t.position);
      const rightPct = Math.round(t.position);
      parts.push(`• ${config.name}: ${config.leftLabel}(${leftPct}%) ←→ ${config.rightLabel}(${rightPct}%)${t.autoAdjust ? ' [自动调节]' : ''}`);
    }
    return `<tension-context>\n当前项目架构张力状态：\n${parts.join('\n')}\n</tension-context>`;
  } catch { return ''; }
}

export interface ContradictionDiagnosis {
  principalContradiction: string;
  principalAspect: 'left' | 'right';
  secondaryContradictions: string[];
  diagnosis: string;
  recommendedAction: string;
  diagnosedAt: string;
}

export function diagnosePrincipalContradiction(db: Database.Database, projectId: string): ContradictionDiagnosis | null {
  try {
    const tasks = db.prepare("SELECT status, context_json FROM wa_tasks WHERE project_id = ? AND created_at >= datetime('now', '-14 days') ORDER BY created_at DESC").all(projectId) as Array<{ status: string; context_json: string }>;
    if (tasks.length < 5) return null;
    const completed = tasks.filter(t => t.status === 'completed').length;
    const failed = tasks.filter(t => t.status === 'failed').length;
    const total = tasks.length;
    const failureRate = failed / total;
    let withDeliverable = 0;
    let metricTasks = 0;
    let avgSteps = 0;
    let stepCount = 0;
    for (const t of tasks) {
      try {
        const ctx = JSON.parse(t.context_json || '{}');
        const m = ctx.execution_metrics;
        if (m) {
          // zx_20260928 M5（D4·读出端）: 只有 `hasDeliverable` **确有布尔值**的任务才进产出率的分母与分子。
          //   缺键（未记指标的历史行 / 不执行任务的人工收口）既不算「有」也不算「没有」——它是**未知**，弃权。
          //   否则「未知」会被除成「0%」，与 `no_deliverable_streak` 原缺陷是同病换一层。
          if (typeof m.hasDeliverable === 'boolean') { metricTasks++; if (m.hasDeliverable) withDeliverable++; }
          if (m.stepsUsed) { avgSteps += m.stepsUsed; stepCount++; }
        }
      } catch { /* ignore */ }
    }
    // `null` = 「可判定的样本为 0」⇒ 该分项**不参战**（下方两处加项均以 `!== null` 为前置）。
    const deliverableRate: number | null = metricTasks > 0 ? withDeliverable / metricTasks : null;
    avgSteps = stepCount > 0 ? avgSteps / stepCount : 0;
    const urgencies: Record<string, number> = {};
    urgencies['simplicity-vs-power'] = (avgSteps > 20 ? 40 : avgSteps > 15 ? 25 : 10) + (deliverableRate !== null && deliverableRate < 0.3 ? 35 : 0);
    urgencies['autonomy-vs-control'] = (failureRate > 0.3 ? 50 : failureRate > 0.15 ? 30 : 10) + (tasks.length >= 10 && completed === tasks.length ? 25 : 0);
    const archetypes = new Set<string>();
    for (const t of tasks) { try { const a = JSON.parse(t.context_json || '{}').execution_metrics?.archetype; if (a) archetypes.add(a); } catch { /* */ } }
    urgencies['general-vs-specialized'] = (archetypes.size >= 4 ? 45 : archetypes.size >= 3 ? 30 : 15);
    urgencies['consistency-vs-availability'] = (failureRate > 0.2 ? 35 : 15);
    urgencies['speed-vs-quality'] = (avgSteps > 25 ? 45 : avgSteps > 15 ? 25 : 10) + (deliverableRate !== null && deliverableRate < 0.4 ? 30 : 0);
    let maxUrgency = 0;
    let principalId = 'simplicity-vs-power';
    for (const [id, urgency] of Object.entries(urgencies)) { if (urgency > maxUrgency) { maxUrgency = urgency; principalId = id; } }
    const secondary = Object.entries(urgencies).filter(([id]) => id !== principalId).sort(([, a], [, b]) => b - a).map(([id]) => id);
    const tensions = getTensions(db, projectId);
    const currentPos = tensions[principalId]?.position || 50;
    const principalAspect: 'left' | 'right' = currentPos > 50 ? 'right' : 'left';
    const config = TENSION_CONFIGS[principalId]!;
    const diagnosis = getDiagnosisText(principalId, failureRate, deliverableRate, avgSteps);
    const recommendedAction = getRecommendedAction(principalId, principalAspect, currentPos, config);
    const result: ContradictionDiagnosis = { principalContradiction: principalId, principalAspect, secondaryContradictions: secondary, diagnosis, recommendedAction, diagnosedAt: new Date().toISOString() };
    // zx_20260906_1 2e: 去冗余落库——last_contradiction_diagnosis 持久化字段无任何读方（真消费方是 generateContradictionContext 的即时返回），每次重算即用即弃
    return result;
  } catch { return null; }
}

// zx_20260928 M5（D4·读出端）: 形参改 `number | null`——`null` 是**未知**（可判定样本为 0），不是「0%」。
//   打印成「产出率未知」，绝不写成「产出率0%」：那是把"没记过账"说成"一笔都没成"，正是本轮要治的病。
function getDiagnosisText(tensionId: string, failureRate: number, deliverableRate: number | null, avgSteps: number): string {
  const rateText = deliverableRate === null ? '产出率未知' : `产出率${(deliverableRate * 100).toFixed(0)}%`;
  switch (tensionId) {
    case 'simplicity-vs-power': return `当前工具和功能可能过于复杂（平均${avgSteps.toFixed(0)}步/任务，${rateText}），工具多但产出效率不高`;
    case 'autonomy-vs-control': return `任务失败率${(failureRate * 100).toFixed(0)}%，Agent自治与人工控制的平衡需要调整`;
    case 'general-vs-specialized': return '项目涉及多种任务类型，需要评估通用策略是否仍适用';
    case 'consistency-vs-availability': return `失败率${(failureRate * 100).toFixed(0)}%影响整体可用性`;
    case 'speed-vs-quality': return `平均${avgSteps.toFixed(0)}步/任务，${rateText}，需要优化执行效率`;
    default: return '';
  }
}

function getRecommendedAction(tensionId: string, aspect: 'left' | 'right', currentPos: number, config: TensionConfig): string {
  const direction = aspect === 'right' ? '向左侧调整' : '向右侧调整';
  const target = aspect === 'right' ? Math.max(20, currentPos - 15) : Math.min(80, currentPos + 15);
  return `建议${direction}："${config.name}"从${currentPos}→${target}（${config.leftLabel}↔${config.rightLabel}）`;
}

export function generateContradictionContext(db: Database.Database, projectId: string): string {
  const diagnosis = diagnosePrincipalContradiction(db, projectId);
  if (!diagnosis) return '';
  const config = TENSION_CONFIGS[diagnosis.principalContradiction];
  if (!config) return '';
  return `<contradiction-analysis>\n【矛盾论·当前主要矛盾】${config.name}（${config.leftLabel} vs ${config.rightLabel}）\n诊断：${diagnosis.diagnosis}\n建议：${diagnosis.recommendedAction}\n次要矛盾（按紧迫度）：${diagnosis.secondaryContradictions.map(id => TENSION_CONFIGS[id]?.name || id).join('、')}\n\n提示：了解当前系统的主要矛盾有助于你在执行任务时做出更明智的权衡。例如，如果主要矛盾是"自治vs可控"偏控制侧，请更主动地使用ask_user征求确认而非自主决策。\n</contradiction-analysis>`;
}
