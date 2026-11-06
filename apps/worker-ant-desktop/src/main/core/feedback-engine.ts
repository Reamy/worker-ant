/**
 * 道法自然：闭环反馈引擎（从原工蚁 feedback-engine.ts 移植精简版）。
 * 反者道之动——执行结果反馈回策略引擎，系统持续自我改进。
 */
import type Database from 'better-sqlite3';
import { createLogger } from './logger.js';
// zx_20261016_3 M32: 质量分带 + 升/降档判据抽至 `quality-gate.ts`（零依赖纯函数，一处真源）。
import { qualityBandOf, strategyVerdictOf } from './quality-gate.js';

const logger = createLogger('feedback');

interface ProjectStrategy {
  modelStrategy: string;
  temperature: number;
  maxSteps: number;
}

/**
 * 模型档阶梯（低→高）——`stepUpTier`/`stepDownTier` 的**唯一依据**（zx_20260930 M6）。
 * 三个档名与 `task-archetype.ts` 的 `modelOrder` 同集同序（那儿是"按档排序挑模型"的读侧，
 * 此处是"按成败升降档"的写侧，同一把尺）。
 */
export const MODEL_TIER_LADDER = ['cost-optimal', 'balanced', 'capability-best'] as const;
export type ModelTier = (typeof MODEL_TIER_LADDER)[number];

/** 连续成功多少次后**回落一档**（zx_20260930 M6-4）。三者取一：连续 3 次成功 ⇒ 降一档、计数归零。 */
export const MODEL_TIER_DOWNGRADE_STREAK = 3;

/** 档位序（认得的三档按位置；不认得的值按 `balanced` 算——旧库里的手改值不该把阶梯判成"在底"）。 */
function tierIndex(tier: string): number {
  const i = MODEL_TIER_LADDER.indexOf(tier as ModelTier);
  return i < 0 ? MODEL_TIER_LADDER.indexOf('balanced') : i;
}

/** 升一档（封顶 `capability-best`）；已在顶则原值返回。 */
export function stepUpTier(tier: string): ModelTier {
  return MODEL_TIER_LADDER[Math.min(MODEL_TIER_LADDER.length - 1, tierIndex(tier) + 1)]!;
}

/** 降一档（下限 `cost-optimal`）；已在底则原值返回。 */
export function stepDownTier(tier: string): ModelTier {
  return MODEL_TIER_LADDER[Math.max(0, tierIndex(tier) - 1)]!;
}

/**
 * zx_20261016_3 批二（M33-a · 王阳明「知行合一」）: 项目级**策略熔断**（`strategy_breaker`）——
 * 自愈监控对"同异常 24h ≥3 次"的项目产出的**具体对策**，写在项目 `context_json` 上，
 * **由 `adjustProjectStrategy` 读出并作用到行为**：在 `until` 之前**只降不升**。
 *
 * 为什么需要它：熔断本身只是"不再自动修"（感性认识）；对一个反复失败/反复超时的项目，
 * 引擎此前仍会**每任务升一档模型**（`status==='failed' ⇒ stepUpTier`），于是"越坏越贵"——
 * 对策就是把这条升档路径在该项目上**冻结一段时间**，等人工排查（这正是"第二次飞跃"）。
 *
 * ⚠ 单位与基准：`until` 存 **ISO-8601 UTC**（`Date.parse` 判活），与库内 `datetime('now')`（UTC）
 *   同基准；两处都是 UTC，不混墙钟（承 `feedback_timezone_clock_basis`）。
 */
export const STRATEGY_BREAKER_HOURS = 24;

export interface StrategyBreaker {
  /** 生效截止（ISO-8601 UTC）。 */
  until: string;
  /** 触发它的异常**类型**（熔断键，不带实例名）。 */
  anomaly: string;
  /** 24h 内的发生次数（触发时的快照）。 */
  count: number;
}

/** 该熔断是否仍在效期（纯判据，`nowMs` 可注入 ⇒ 可直接喂数试它）。 */
export function isStrategyBreakerActive(b: StrategyBreaker | undefined | null, nowMs: number = Date.now()): boolean {
  if (!b) return false;
  const t = Date.parse(String(b.until));
  return Number.isFinite(t) && t > nowMs;
}

/**
 * 写项目级策略熔断（**唯一写入口**）。写失败返回 `null`（best-effort，不阻断自愈记账）。
 * 重复触发即**续期**到新的 `until`（幂等：以最新一次为准）。
 */
export function setStrategyBreaker(
  db: Database.Database,
  o: { projectId: string; anomaly: string; count: number; hours?: number },
): StrategyBreaker | null {
  try {
    const row = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(o.projectId) as { context_json: string } | undefined;
    if (!row) return null;
    const ctx = JSON.parse(row.context_json || '{}');
    const hours = Number.isFinite(o.hours) && (o.hours as number) > 0 ? (o.hours as number) : STRATEGY_BREAKER_HOURS;
    const breaker: StrategyBreaker = {
      until: new Date(Date.now() + hours * 3600_000).toISOString(),
      anomaly: o.anomaly,
      count: o.count,
    };
    ctx.strategy_breaker = breaker;
    db.prepare('UPDATE wa_projects SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), o.projectId);
    return breaker;
  } catch {
    return null;
  }
}

/** 读**仍生效**的项目策略熔断（未设 / 已过期 ⇒ `null`；过期即自动解除，无需人来清）。 */
export function readActiveStrategyBreaker(db: Database.Database, projectId: string): StrategyBreaker | null {
  try {
    const row = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string } | undefined;
    const b = (JSON.parse(row?.context_json || '{}') as { strategy_breaker?: StrategyBreaker }).strategy_breaker;
    return isStrategyBreakerActive(b) ? (b as StrategyBreaker) : null;
  } catch {
    return null;
  }
}

interface StrategyRecord {
  modelStrategy: string;
  archetype: string;
  successCount: number;
  totalCount: number;
  avgTokens: number;
  avgCost: number;
  avgSteps: number;
  /** zx_20261016_3 M32: 该 (档位|archetype) 的历史平均质量分（0–100）。存量行无此键 ⇒ 视为**未知**。 */
  avgQuality?: number;
  lastUsedAt?: string;
}

export interface ExecutionMetrics {
  taskId: string;
  projectId: string;
  archetype: string;
  stepsUsed: number;
  maxSteps: number;
  toolCalls: number;
  totalTokens: number;
  estimatedCost: number;
  hasDeliverable: boolean;
  /**
   * zx_20261016_3 M32: 本任务的**完成质量分**（0–100，`assessCompletionQuality` 产出）。
   * 与 `hasDeliverable` 各答各问——**是否产出** vs **产出好坏**，两把尺。
   */
  qualityScore: number;
  status: 'completed' | 'failed' | 'paused';
  modelName: string;
  strategy?: ProjectStrategy;
}

/** 获取项目已学到的策略（第一层：硬编码默认 → 已学习策略） */
export function getLearnedStrategy(db: Database.Database, projectId: string): ProjectStrategy | null {
  try {
    const row = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string } | undefined;
    const ctx = JSON.parse(row?.context_json || '{}');
    if (ctx.learned_strategy) {
      return {
        modelStrategy: (ctx.learned_strategy.modelStrategy as string) || 'balanced',
        temperature: (ctx.learned_strategy.temperature as number) || 0.7,
        maxSteps: (ctx.learned_strategy.maxSteps as number) || 15,
      };
    }
  } catch { /* ignore */ }
  return null;
}

/** 道法自然：基于历史表现数据自然涌现最优策略（第二层） */
export function naturalStrategySelection(
  db: Database.Database,
  projectId: string,
  archetype: string,
): ProjectStrategy | null {
  try {
    const row = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string } | undefined;
    const ctx = JSON.parse(row?.context_json || '{}');
    const history = ctx.strategy_history as Record<string, StrategyRecord> | undefined;
    if (!history) return null;

    const candidates = Object.values(history).filter(r => r.archetype === archetype && (r.totalCount || 0) >= 3);
    if (candidates.length === 0) return null;

    // zx_20261016_3 M32（老子·道法自然）: 让**跑得好**而非**跑得成**自然胜出——排序主键改为
    //   平均质量分，并列再比成功率、再比成本。质量分**缺失（存量行）即回退旧口径**（成功率→成本）：
    //   "没记过账"≠"低分"（承 zx_20260928 M5 弃权纪律），不许把未知读成坏值。
    candidates.sort((a, b) => {
      const aQ = typeof a.avgQuality === 'number' ? a.avgQuality : undefined;
      const bQ = typeof b.avgQuality === 'number' ? b.avgQuality : undefined;
      if (aQ !== undefined && bQ !== undefined && Math.abs(aQ - bQ) >= 1) return bQ - aQ;
      const aRate = (a.successCount || 0) / (a.totalCount || 1);
      const bRate = (b.successCount || 0) / (b.totalCount || 1);
      if (Math.abs(aRate - bRate) > 0.1) return bRate - aRate;
      return (a.avgCost || 0) - (b.avgCost || 0);
    });

    const best = candidates[0]!;
    logger.info({ projectId, archetype, bestModel: best.modelStrategy, successRate: ((best.successCount || 0) / (best.totalCount || 1)).toFixed(2) }, '[道法自然] 自然涌现最优策略');
    return {
      modelStrategy: best.modelStrategy,
      temperature: (best.avgSteps || 15) > 15 ? 0.3 : 0.5,
      maxSteps: Math.min(30, Math.round((best.avgSteps || 15) * 1.3)),
    };
  } catch { return null; }
}

/** 根据执行质量自动调整项目策略（第三层：反馈闭环） */
export function adjustProjectStrategy(
  db: Database.Database,
  projectId: string,
  metrics: ExecutionMetrics,
): ProjectStrategy | null {
  try {
    const row = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string } | undefined;
    const ctx = JSON.parse(row?.context_json || '{}');

    const current: ProjectStrategy = {
      modelStrategy: (ctx.learned_strategy?.modelStrategy as string) || 'balanced',
      temperature: (ctx.learned_strategy?.temperature as number) || 0.7,
      maxSteps: (ctx.learned_strategy?.maxSteps as number) || 15,
    };

    const adjustments: string[] = [];
    const updated: ProjectStrategy = { ...current };

    // zx_20261016_3 批二（M33-a）: 项目策略熔断生效期**只降不升**——自愈监控产出的对策在此落到行为。
    //   熔断由 `self-healing-monitor.ts` 在"同异常 24h ≥3 次"时写入（`setStrategyBreaker`），此处**只读**。
    //   被压下的"升"动作**如实记入 adjustments**（不许静默）：人工排查时看得见"本该升、因熔断未升"。
    //   只压 `升`：降档（连续高质量完成回落）与提精确度（temperature 下调）照常放行。
    const breaker = readActiveStrategyBreaker(db, projectId);
    const heldBy = breaker
      ? `策略熔断生效中（${breaker.anomaly}，24h 内 ${breaker.count} 次，至 ${breaker.until}）：`
      : '';

    // zx_20260930 M6（错误归因的第二处）：模型档原来**只会升不会降**——一次基础设施故障（DNS 不通 /
    //   配额耗尽）就把项目永久钉在 `capability-best`，此后每任务都付最高档的价。改为**阶梯 + 回落**：
    //   失败升一档（封顶），连续 `MODEL_TIER_DOWNGRADE_STREAK` 次成功降一档（下限 `cost-optimal`）。
    //   连续计数存在**兄弟键** `learned_strategy_success_streak`——`learned_strategy` 的形状
    //   （{modelStrategy,temperature,maxSteps}）有既有读点（`getLearnedStrategy` 与 admin IPC），
    //   往里塞新键会改它的形状。
    let streak = typeof ctx.learned_strategy_success_streak === 'number' ? ctx.learned_strategy_success_streak : 0;

    // zx_20261016_3 M32（「质量分入闸」）: 升/降档此前**只认 `status`**——一个"判卷没过（<60）却因预算
    //   强制收尾标了 completed"的任务被算作**连续成功**、参与回落；"高分完成"与"刚过线完成"在闭环里
    //   长得一模一样。现一律经 `strategyVerdictOf`（判据在 `quality-gate.ts` 一处真源）：
    //   低分完成 ⇒ 视同失败升档、并打断连续计数；非低分完成 ⇒ 才计入回落。
    const verdict = strategyVerdictOf(metrics);
    if (verdict === 'step_up') {
      const up = stepUpTier(updated.modelStrategy);
      if (up !== updated.modelStrategy) {
        const why = metrics.status === 'failed' ? '任务失败' : `完成分偏低（${Math.round(metrics.qualityScore)}）`;
        if (breaker) {
          adjustments.push(`${heldBy}本该升档（${why}），暂不升：model 保持 ${updated.modelStrategy}`);
        } else {
          adjustments.push(`model: ${updated.modelStrategy}→${up}（${why}）`);
          updated.modelStrategy = up;
        }
      }
      streak = 0; // "连续成功"被这次失败/低分完成打断
    } else if (verdict === 'step_down_eligible') {
      streak += 1;
      if (streak >= MODEL_TIER_DOWNGRADE_STREAK) {
        const down = stepDownTier(updated.modelStrategy);
        if (down !== updated.modelStrategy) {
          adjustments.push(`model: ${updated.modelStrategy}→${down}（连续 ${streak} 次高质量完成，回落）`);
          updated.modelStrategy = down;
        }
        streak = 0;
      }
    }

    // 步数接近上限 → 增加配额
    if (metrics.stepsUsed >= metrics.maxSteps * 0.8) {
      if (breaker) {
        adjustments.push(`${heldBy}本该加步数配额，暂不加：maxSteps 保持 ${current.maxSteps}`);
      } else {
        updated.maxSteps = Math.min(30, current.maxSteps + 5);
        adjustments.push(`maxSteps: ${current.maxSteps}→${updated.maxSteps}（步骤使用率>80%）`);
      }
    }

    // 完成但无真实产出证据 → 降低temperature提高精确度
    // zx_20260917 M5-2（名实相符）: 原写「无产出物」——而同一份 context_json 里另有一条「产出 N 个」，
    // 数的是 `wa_deliverables` 本任务**登记条数**（含探针/已退休件），与这里问的**整树真实产出证据**
    // （`execution_metrics.hasDeliverable`）同名不同义。两个"产出"必须各名其尺，故此处说出它问的是什么。
    if (metrics.status === 'completed' && !metrics.hasDeliverable) {
      updated.temperature = Math.max(0.1, current.temperature - 0.1);
      adjustments.push(`temperature: ${current.temperature}→${updated.temperature}（无真实产出证据，提高精确度）`);
    } else if (metrics.status === 'completed' && qualityBandOf(metrics.qualityScore) === 'low') {
      // zx_20261016_3 M32: 有产出、但**完成分偏低**（判卷没过）⇒ 同样提精确度。
      //   与上一支各名其尺（"有没有产出" vs "产出好不好"），取 `else if` 使 temperature 至多降一档一次
      //   （与旧行为同：hasDeliverable=false **且** 低分时也只降 0.1）。
      updated.temperature = Math.max(0.1, current.temperature - 0.1);
      adjustments.push(`temperature: ${current.temperature}→${updated.temperature}（完成分偏低（${Math.round(metrics.qualityScore)}），提高精确度）`);
    }

    // 高效完成 → 微调
    if (metrics.status === 'completed' && metrics.stepsUsed < metrics.maxSteps * 0.5) {
      if (breaker) {
        adjustments.push(`${heldBy}本该微调 temperature，暂不调：保持 ${current.temperature}`);
      } else {
        updated.temperature = Math.min(0.9, current.temperature + 0.05);
        adjustments.push(`temperature: ${current.temperature}→${updated.temperature}（高效完成，微调）`);
      }
    }

    // `streak` 是**跨任务**状态，必须自己落库：若只在"本轮恰有别的调整"时才被顺带写进去，
    // 连续成功永远数不到 3（那些任务的 adjustments 都是空的，函数在下一行就 return null 了）。
    const prevStreak = typeof ctx.learned_strategy_success_streak === 'number' ? ctx.learned_strategy_success_streak : 0;
    ctx.learned_strategy_success_streak = streak;
    if (adjustments.length === 0) {
      if (streak !== prevStreak) db.prepare('UPDATE wa_projects SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), projectId);
      return null;
    }

    ctx.learned_strategy = updated;
    ctx.learned_strategy_updatedAt = new Date().toISOString();
    // 记录调整历史（保留最近10条）
    if (!ctx.strategy_adjustments) ctx.strategy_adjustments = [];
    ctx.strategy_adjustments.push({ at: new Date().toISOString(), adjustments, reason: metrics.status });
    if (ctx.strategy_adjustments.length > 10) ctx.strategy_adjustments = ctx.strategy_adjustments.slice(-10);
    db.prepare('UPDATE wa_projects SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), projectId);
    logger.info({ projectId, adjustments }, 'A2策略自动调整');
    return updated;
  } catch { return null; }
}

// zx_20260906_1 2d: 下线 observeBehavior/learnWorkflowPatterns——behavior_pattern/workflow_pattern 写后无任何读（"意义即使用"），
// 且 behavior_adjusted_thresholds(observed 层)本应由 observeBehavior 产出却断链永不生效；阈值自校准由 calibrateProjectThresholds(learned_thresholds) 真实生效覆盖。

// ==================== 意义即使用：工具使用统计 ====================

/** 意义即使用：记录工具使用情况（每次工具调用后调用），数据驱动"意义"演化 */
export function recordToolUsage(
  db: Database.Database,
  projectId: string,
  archetype: string,
  toolName: string,
  success: boolean,
): void {
  try {
    const proj = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string } | undefined;
    const ctx = JSON.parse(proj?.context_json || '{}');
    if (!ctx.tool_usage) ctx.tool_usage = {};

    const key = `${toolName}:${archetype}`;
    if (!ctx.tool_usage[key]) {
      ctx.tool_usage[key] = { toolName, projectId, archetype, successCount: 0, failCount: 0 };
    }

    const record = ctx.tool_usage[key];
    success ? record.successCount++ : record.failCount++;
    record.lastUsedAt = new Date().toISOString();

    db.prepare('UPDATE wa_projects SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), projectId);
  } catch { /* best-effort */ }
}

/** 意义即使用：生成高失败率工具提示（注入系统提示） */
export function getToolUsageHint(
  db: Database.Database,
  projectId: string,
  archetype: string,
): string {
  try {
    const proj = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string } | undefined;
    const ctx = JSON.parse(proj?.context_json || '{}');
    const usage = ctx.tool_usage as Record<string, { toolName: string; archetype: string; successCount: number; failCount: number }> | undefined;
    if (!usage) return '';

    const warnings: string[] = [];
    const verified: string[] = [];
    for (const record of Object.values(usage)) {
      if (record.archetype !== archetype) continue;
      const sc = record.successCount || 0;
      const fc = record.failCount || 0;
      const total = sc + fc;
      if (total >= 3 && sc / total < 0.4) {
        warnings.push(`${record.toolName}(${fc}/${total}次失败)`);
      } else if (total >= 5 && sc / total >= 0.8) {
        verified.push(`${record.toolName}(${sc}/${total}次成功)`);
      }
    }
    const parts: string[] = [];
    if (warnings.length > 0) parts.push(`以下工具失败率较高: ${warnings.join(', ')}。建议优先使用替代工具。`);
    if (verified.length > 0) parts.push(`以下工具在本项目中已验证可靠: ${verified.join(', ')}。可优先使用。`);
    if (parts.length === 0) return '';
    return `[工具使用统计] ${parts.join(' ')}`;
  } catch { return ''; }
}

// ==================== 遵守规则：项目级自适应阈值 ====================

export interface ProjectThresholds {
  toolLoopWarn: number;
  toolLoopHard: number;
  noProgressLimit: number;
  noProgressHard: number;
  searchEmptyBailout: number;
  compressThreshold: number;
  tokenWindowRatio: number;
}

const DEFAULT_THRESHOLDS: ProjectThresholds = {
  toolLoopWarn: 3, toolLoopHard: 5, noProgressLimit: 3, noProgressHard: 8,
  searchEmptyBailout: 2, compressThreshold: 15, tokenWindowRatio: 0.8,
};

/** 获取项目级自适应阈值（统计学习阈值 > 默认值）。zx_20260906_1 2d: 移除永不可能生效的 observed(behavior_adjusted_thresholds) 合并分支（其写方已下线） */
export function getProjectThresholds(db: Database.Database, projectId: string): ProjectThresholds {
  try {
    const proj = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string } | undefined;
    const ctx = JSON.parse(proj?.context_json || '{}');
    const learned = ctx.learned_thresholds as Partial<ProjectThresholds> | undefined;
    if (learned) return { ...DEFAULT_THRESHOLDS, ...learned };
  } catch { /* ignore */ }
  return { ...DEFAULT_THRESHOLDS };
}

/** 遵守规则：基于近7天已完成任务的执行指标校准项目阈值（每≥5任务） */
export function calibrateProjectThresholds(db: Database.Database, projectId: string): ProjectThresholds | null {
  const stats = db.prepare(
    `SELECT AVG(json_extract(context_json, '$.execution_metrics.stepsUsed')) as avgSteps,
            AVG(json_extract(context_json, '$.execution_metrics.toolCalls')) as avgToolCalls,
            COUNT(*) as totalCompleted
     FROM wa_tasks WHERE project_id = ? AND status = 'completed'
       AND context_json LIKE '%execution_metrics%'
       AND created_at >= datetime('now', '-7 days')`
  ).get(projectId) as { avgSteps: number | null; avgToolCalls: number | null; totalCompleted: number };

  if (!stats.totalCompleted || stats.totalCompleted < 5 || !stats.avgSteps) return null;

  const avgSteps = Math.round(stats.avgSteps);
  const avgToolCalls = Math.round(stats.avgToolCalls || avgSteps);
  const thresholds: ProjectThresholds = {
    toolLoopWarn: Math.max(3, Math.round(avgToolCalls * 0.3)),
    toolLoopHard: Math.max(5, Math.round(avgToolCalls * 0.5)),
    noProgressLimit: Math.max(2, Math.round(avgSteps * 0.15)),
    noProgressHard: Math.max(5, Math.round(avgSteps * 0.3)),
    searchEmptyBailout: DEFAULT_THRESHOLDS.searchEmptyBailout,
    compressThreshold: Math.max(10, Math.round(avgSteps * 1.2)),
    tokenWindowRatio: DEFAULT_THRESHOLDS.tokenWindowRatio,
  };

  try {
    const proj = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string } | undefined;
    const ctx = JSON.parse(proj?.context_json || '{}');
    ctx.learned_thresholds = thresholds;
    ctx.threshold_calibratedAt = new Date().toISOString();
    db.prepare('UPDATE wa_projects SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), projectId);
    logger.info({ projectId, basedOn: `${stats.totalCompleted}个已完成任务` }, '[遵守规则] 项目阈值已校准');
  } catch { /* ignore */ }
  return thresholds;
}

/** 记录策略表现（按 archetype 聚合，供道法自然选择） */
export function recordStrategyOutcome(
  db: Database.Database,
  projectId: string,
  metrics: ExecutionMetrics,
): void {
  try {
    if (!metrics.strategy) return;
    const row = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string } | undefined;
    const ctx = JSON.parse(row?.context_json || '{}');
    if (!ctx.strategy_history) ctx.strategy_history = {};

    const key = `${metrics.strategy.modelStrategy}|${metrics.archetype}`;
    if (!ctx.strategy_history[key]) {
      ctx.strategy_history[key] = {
        modelStrategy: metrics.strategy.modelStrategy,
        archetype: metrics.archetype,
        successCount: 0, totalCount: 0, avgTokens: 0, avgCost: 0, avgSteps: 0,
      };
    }

    const record = ctx.strategy_history[key] as StrategyRecord;
    const prevTotal = record.totalCount || 0;
    record.totalCount = prevTotal + 1;
    if (metrics.status === 'completed') record.successCount = (record.successCount || 0) + 1;
    record.avgTokens = ((record.avgTokens || 0) * prevTotal + metrics.totalTokens) / record.totalCount;
    record.avgCost = ((record.avgCost || 0) * prevTotal + metrics.estimatedCost) / record.totalCount;
    record.avgSteps = ((record.avgSteps || 0) * prevTotal + metrics.stepsUsed) / record.totalCount;
    // zx_20261016_3 M32: 质量分按同一口径滚动平均。`successCount` 计数**不变**（保持"完成"原义）——
    //   质量只进 `avgQuality`，供 `naturalStrategySelection` 择优选档；两本账各记各的。
    const q = Number.isFinite(metrics.qualityScore) ? metrics.qualityScore : 0;
    record.avgQuality = ((record.avgQuality ?? 0) * prevTotal + q) / record.totalCount;
    record.lastUsedAt = new Date().toISOString();

    db.prepare('UPDATE wa_projects SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), projectId);
  } catch { /* best-effort */ }
}
