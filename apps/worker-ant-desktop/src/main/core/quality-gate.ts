/**
 * 质量分 ⇒ 策略调整（zx_20261016_3 M32「质量分入闸」）。
 *
 * 是什么：把"一次执行的质量分意味着策略该升、该降、还是不动"这条**纯派生**逻辑从
 *   `feedback-engine.ts`（策略闭环的读写主体）里独立出来——分带阈值与判据**各只此一处**，
 *   判据可直接喂数试，不必起库、不必跑执行体。
 *
 * 为什么独立成模块（kickoff「可顺带重构减轻核心类代码量」）：`agent-executor.ts` 已逾 4000 行、
 *   `feedback-engine.ts` 也在长；这条新逻辑放进任一方都会继续加厚。本模块**零 import**
 *   （与 `healing-outcome.ts` 同形，main / rr 双侧都能直引）。
 *
 * ⚠ 与 `agent-executor.ts` 的 `assessCompletionQuality`（产出 0–100 分）是**同一把尺**：
 *   那边**产分**，这边**消费分**。分带阈值的唯一定义在此，别处不得再写一份。
 */

/** 质量分带阈值（唯一真源）：`>= high` 高、`>= mid` 中、其余低。 */
export const QUALITY_BANDS = { high: 80, mid: 60 } as const;

export type QualityBand = 'high' | 'mid' | 'low';

/**
 * 分带。**未知（非有限数）按中带**——不把"没记过账"读成"低分"
 * （承 zx_20260928 M5 弃权纪律：缺键 ≠ 坏值）。
 */
export function qualityBandOf(score: number | undefined | null): QualityBand {
  if (score == null || !Number.isFinite(score)) return 'mid';
  if (score >= QUALITY_BANDS.high) return 'high';
  if (score >= QUALITY_BANDS.mid) return 'mid';
  return 'low';
}

/** `quality-gate` 只需这两个字段（结构化兼容 `ExecutionMetrics`），故不 import 调用方类型。 */
export interface QualityGateInput {
  status: 'completed' | 'failed' | 'paused';
  qualityScore?: number;
}

export type StrategyVerdict = 'step_up' | 'step_down_eligible' | 'hold';

/**
 * 一次执行 ⇒ 模型档该怎么动。
 *   · 失败 ⇒ 升档（`step_up`）；
 *   · 完成但**低分**（< mid，即判卷没过却因预算强制收尾标了完成）⇒ **同样升档**——
 *     它**不是**连续成功、不该参与回落（M32 的主要矛盾正在这里：旧实现只认 `status`，
 *     让"刚过线/没过"与"跑得好"在闭环里长得一模一样）；
 *   · 完成且非低分 ⇒ 计入"可回落"（`step_down_eligible`，是否真回落由连续计数决定）；
 *   · 其余（paused）⇒ 不动（`hold`）。
 */
export function strategyVerdictOf(m: QualityGateInput): StrategyVerdict {
  if (m.status === 'failed') return 'step_up';
  if (m.status === 'completed') {
    return qualityBandOf(m.qualityScore) === 'low' ? 'step_up' : 'step_down_eligible';
  }
  return 'hold';
}
