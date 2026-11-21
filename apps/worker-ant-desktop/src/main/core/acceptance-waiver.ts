/**
 * zx_20261118_2 M5「豁」：**用户逐条豁免验收**的纯判据（零依赖，rr 可直跑）。
 *
 * 病根（真库 S3）：`a7fbd7e0` 的验收条 3 是「提交包含 backend/ 修复代码与方案文件变更」，
 * 但 `plans/` 不在任何 git 仓内——这条**任何模型都做不到**。`finalize_task` 按合取条件拒收
 * （`验收标准未达成（1 项），请补齐后再 finalize`），用户只能在 GUI 手动「标记完成」，
 * 而那条路**记不下"豁免了哪一条、为什么"**。
 *
 * 本模块只做一件事：把用户写下的豁免**按 criterion 逐字**套到 failed 条目上——
 *   · 只对 `passed === false` 的条目生效（已通过的条目上写豁免，记 `unmatched`，不静默）；
 *   · **不改 `passed`**（不把拒收伪造成通过），只加 `waived: true`；
 *   · 未匹配的豁免原样回传，供调用方如实报"这条豁免没落到任何未达项上"。
 *
 * 写口只开 GUI 用户路径（`task:waiveAcceptance`）；`finalize_task` 工具**不提供**豁免参数，
 * 引擎只读账上已有豁免——agent 不能自己给自己发豁免。
 */

/** 一条用户裁定（落 `context_json.acceptance_waiver.items[]`）。 */
export interface AcceptanceWaiverItem {
  /** 与 `acceptance_check.failed[].criterion` 逐字匹配 */
  criterion: string;
  /** 必填——豁免是"人担了这条"，理由必须留痕 */
  reason: string;
  by: 'user';
  /** ISO 时刻 */
  at: string;
}

/** 可被豁免的最小条目形状（结构类型，不 import acceptance-check，避免类型环）。 */
export interface WaivableCheck {
  criterion?: string;
  passed?: boolean;
  waived?: boolean;
}

export interface WaiverApplication<T extends WaivableCheck> {
  /** 套用后的条目（命中的 failed 条目带 `waived: true`；其余原样） */
  checks: T[];
  /** 真落到 failed 条目上的豁免 */
  waived: AcceptanceWaiverItem[];
  /** 没落到任何未达项上的豁免（已通过 / 已不存在 / 文本不一致）——不得静默 */
  unmatched: AcceptanceWaiverItem[];
}

/** 把用户豁免套到条目上。纯函数：不改入参、不写库、不抛。 */
export function applyAcceptanceWaivers<T extends WaivableCheck>(
  checks: readonly T[],
  waivers: readonly AcceptanceWaiverItem[],
): WaiverApplication<T> {
  const byCriterion = new Map<string, AcceptanceWaiverItem>();
  for (const w of waivers) {
    const key = String(w.criterion ?? '').trim();
    if (key && !byCriterion.has(key)) byCriterion.set(key, w);
  }
  const matched = new Set<string>();
  const out = checks.map((c) => {
    const key = String(c.criterion ?? '').trim();
    const w = byCriterion.get(key);
    if (w && c.passed === false) {
      matched.add(key);
      return { ...c, waived: true } as T;
    }
    return c;
  });
  const waived: AcceptanceWaiverItem[] = [];
  const unmatched: AcceptanceWaiverItem[] = [];
  for (const w of waivers) {
    (matched.has(String(w.criterion ?? '').trim()) ? waived : unmatched).push(w);
  }
  return { checks: out, waived, unmatched };
}

/**
 * 从任务 `context_json` 读豁免清单（只读、容忍脏数据）。
 * 坏 JSON / 缺键 / 条目缺 criterion 或 reason 一律跳过——不拿半条豁免去放行。
 */
export function readAcceptanceWaivers(ctx: Record<string, unknown> | null | undefined): AcceptanceWaiverItem[] {
  const raw = (ctx ?? {}).acceptance_waiver as { items?: unknown } | undefined;
  if (!raw || !Array.isArray(raw.items)) return [];
  const out: AcceptanceWaiverItem[] = [];
  for (const it of raw.items) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const criterion = typeof o.criterion === 'string' ? o.criterion.trim() : '';
    const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
    if (!criterion || !reason) continue;
    out.push({
      criterion,
      reason,
      by: 'user',
      at: typeof o.at === 'string' ? o.at : '',
    });
  }
  return out;
}
