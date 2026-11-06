/**
 * zx_20261016_3 M33-b（亚里士多德·四因说）：子任务的**四因**一处词表。
 *
 * 是什么：一个子任务"成其为一个子任务"须四因俱全——**质料因**（谁来做：执行者/模型档）、
 *   **形式因**（做成什么样：`acceptance_criteria`）、**动力因**（被什么推动：`dependsOn`）、
 *   **目的因**（服务于父目标的哪一点：`purpose`）。此前**目的因整体缺席**：模型拆出来的子任务
 *   只有"做什么、验收什么、等谁"，没有"**为什么有它**"⇒ 子任务容易长成自成一体的小目标，
 *   与父目标脱钩（本仓反复出现的"拆得动、跑得完、却不是要的那件事"）。
 *
 * ⚠ **零 import**（同 `quality-gate.ts` / `healing-outcome.ts` 纪律）：main 与 renderer 同引一份，
 *   词表不设第二落点（承 CLAUDE.md「renderer 是词表的第二个落点」）。
 *
 * ⚠ **只判模板条目承载得住的那些因**：质料因由运行期派生（执行者/模型档在模板里根本没有），
 *   故它的 `state` 是 `runtime` 而非 `missing`——**判不了不等于缺失**（承 zx_20261011 现实闸三态）。
 *   同理，`dependsOn` 缺席是"独立子任务"这一**合法值**（运行期立即放行），不是缺口。
 */

/** 四因词表（唯一真源）。顺序即展示序（质料→形式→动力→目的）。 */
export const FOUR_CAUSES = ['material', 'formal', 'efficient', 'final'] as const;
export type FourCause = (typeof FOUR_CAUSES)[number];

/** 人话标签（renderer 直接取用，不另写一份）。 */
export const FOUR_CAUSE_LABEL: Record<FourCause, string> = {
  material: '质料因（谁来做、用什么做）',
  formal: '形式因（验收标准 acceptance_criteria）',
  efficient: '动力因（前置依赖 dependsOn）',
  final: '目的因（服务于父目标的哪一点 purpose）',
};

/**
 * 每一因在**模板条目上**的承载状态：
 *   · `carried` —— 由本条目自己写着（形式因/目的因/有前置的动力因）；
 *   · `runtime` —— 由运行期承担，模板不写（质料因；无前置的动力因＝"启动即推动"）；
 *   · `missing` —— **本该写着却空着**（形式因空串、目的因空/缺）——只有这一态算缺口。
 */
export type FourCauseState = 'carried' | 'runtime' | 'missing';

/** 只看这四个字段（结构化兼容 `DecompositionTemplate`，故不 import 调用方类型）。 */
export interface FourCauseInput {
  acceptance_criteria?: unknown;
  dependsOn?: unknown;
  purpose?: unknown;
}

export interface FourCauseView {
  cause: FourCause;
  label: string;
  state: FourCauseState;
  basis: string;
}

const nonEmptyStr = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const depCount = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/**
 * **目的因是否由本条承载**——拆解解析口与 four-cause 视图**同引此处**（判据只此一份）。
 * 空串与空白一律不算（"必填"落不到空串上——与 `title` 门同一把尺）。
 */
export function hasFinalCause(t: FourCauseInput | null | undefined): boolean {
  return nonEmptyStr(t?.purpose).length > 0;
}

/** 四因逐项视图（纯函数、无 IO）。 */
export function fourCauseOf(t: FourCauseInput | null | undefined): FourCauseView[] {
  const f = t ?? {};
  const deps = depCount(f.dependsOn);
  const formal = nonEmptyStr(f.acceptance_criteria);
  const final = nonEmptyStr(f.purpose);
  return [
    { cause: 'material', label: FOUR_CAUSE_LABEL.material, state: 'runtime',
      basis: '由运行期派生（执行者/模型档）——模板与子任务 context 都不写此键' },
    { cause: 'formal', label: FOUR_CAUSE_LABEL.formal, state: formal ? 'carried' : 'missing',
      basis: formal ? formal : '验收标准为空 —— 建成后无从判"做没做成"' },
    { cause: 'efficient', label: FOUR_CAUSE_LABEL.efficient, state: deps > 0 ? 'carried' : 'runtime',
      basis: deps > 0 ? `前置 ${deps} 项` : '无前置（独立子任务，运行期立即放行）' },
    { cause: 'final', label: FOUR_CAUSE_LABEL.final, state: final ? 'carried' : 'missing',
      basis: final ? final : '未写明服务于父目标的哪一点 —— 子任务易自成一体、与父目标脱钩' },
  ];
}
