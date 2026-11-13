/**
 * zx_20261107_1 B6「信」：**选型结果的结构化载体**——`[选型]` 那行文本由它派生，费用/币种/来源也由它承载。
 *
 * 病根：选型五要素只在 `exec-model-select.ts` 的局部变量里拼成一句文本，落账后**再无结构化字段**；
 *   任务详情页想说"为什么选它"，只能逐字解析一行中文；费用归因也缺少"这一跳是哪家、什么币种"。
 *
 * 三条纪律：
 *   ① **文本与结构同源**：`reason` 由 `formatModelSelectionReason` 一处生成，行长 = `[选型] ` + `reason`
 *      （`rr_zx_20261012_3` C-3a/C-4 逐字钉原文案，本模块不得改一个字）；
 *   ② **坏形状 ⇒ `null`**：读旧账/脏数据时宁可"说不出"，也不拼一个半真半假的选择记录；
 *   ③ **未知不臆造**：币种/价格取不到就是 `null`（不是 `CNY`、不是 0）。
 */

/** 用户指定模型（恢复路 / 项目级 / 全局默认）的落地记录；未指定 ⇒ `null`。 */
export interface ModelSelectionPinned {
  source: 'resume' | 'project' | 'default';
  /** 用户/历史指定的模型名。 */
  requested: string;
  /** 本次是否真的用上了（池外 ⇒ `false`，已回落自动选型）。 */
  applied: boolean;
}

/** 指定来源人话词表（渲染层与说明文案共用一份；缺项按原键显示，不臆造）。 */
export const PIN_SOURCE_LABEL: Record<ModelSelectionPinned['source'], string> = {
  resume: '恢复路沿用',
  project: '项目指定',
  default: '全局默认',
};

export interface ModelSelection {
  strategySource: string;
  strategy: string;
  model: string;
  endpoint: string;
  capabilityMatch: string;
  /** 人话行体（**不含** `[选型] ` 前缀）——与落账文本逐字相同。 */
  reason: string;
  /** 每 1k tokens 输入价；未知 ⇒ `null`（不补 0）。 */
  inputPricePer1k: number | null;
  /** 每 1k tokens 输出价；未知 ⇒ `null`。 */
  outputPricePer1k: number | null;
  /** 币种代码（`USD`/`CNY`…）；未知 ⇒ `null`（不默认 CNY）。 */
  currency: string | null;
  pinned: ModelSelectionPinned | null;
}

function finiteOrNull(v: unknown): number | null {
  const n = Number(v);
  return v !== null && v !== undefined && Number.isFinite(n) ? n : null;
}

/**
 * 行体唯一生成处。输入只取五要素，故调用方无法在别处拼出"看起来像"的第二份文案。
 * 逐字契约见 `rr_zx_20261012_3` C-3a / C-4。
 */
export function formatModelSelectionReason(
  sel: Pick<ModelSelection, 'strategySource' | 'strategy' | 'model' | 'endpoint' | 'capabilityMatch'>,
): string {
  return `策略来源=${sel.strategySource} · 策略=${sel.strategy} · 模型=${sel.model}`
    + ` · 端点=${sel.endpoint} · 能力匹配=${sel.capabilityMatch}`;
}

function sanitizePinned(raw: unknown): ModelSelectionPinned | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const source = o.source;
  if (source !== 'resume' && source !== 'project' && source !== 'default') return null;
  if (typeof o.requested !== 'string' || !o.requested) return null;
  if (typeof o.applied !== 'boolean') return null;
  return { source, requested: o.requested, applied: o.applied };
}

/**
 * 洗形：五要素必须都是**非空字符串**（缺一格就说不全这次选型）；`reason` 取存档原文（那是当时说的话），
 *   缺席则按现格式重算；价格/币种取不到即 `null`；`pinned` 坏掉只丢该项（"没指定"是合法状态）。
 */
export function sanitizeModelSelection(raw: unknown): ModelSelection | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = ['strategySource', 'strategy', 'model', 'endpoint', 'capabilityMatch'] as const;
  for (const k of keys) {
    if (typeof o[k] !== 'string' || !(o[k] as string)) return null;
  }
  const base = {
    strategySource: o.strategySource as string,
    strategy: o.strategy as string,
    model: o.model as string,
    endpoint: o.endpoint as string,
    capabilityMatch: o.capabilityMatch as string,
  };
  const reason = typeof o.reason === 'string' && o.reason ? o.reason : formatModelSelectionReason(base);
  const currency = typeof o.currency === 'string' && o.currency ? o.currency : null;
  return {
    ...base,
    reason,
    inputPricePer1k: finiteOrNull(o.inputPricePer1k),
    outputPricePer1k: finiteOrNull(o.outputPricePer1k),
    currency,
    pinned: o.pinned === null || o.pinned === undefined ? null : sanitizePinned(o.pinned),
  };
}
