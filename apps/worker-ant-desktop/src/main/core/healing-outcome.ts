/**
 * zx_20260930 M14-1（维特根斯坦·一个用途一个词）：自愈动作的**结果态**与它的**用户可见标签**
 * ——同一份词表，两个落点（写库的 `self-healing-monitor.ts`、渲染它的 `DashboardPage.tsx`）。
 *
 * 病根：`wa_self_healing_logs.success` 是个**二值列**，于是"什么也没做、只记了一笔"（断路器频繁
 * 跳闸那一支）**只能记成 `success=1`** —— 界面上它与"真的修好了"长得一模一样。假成功不是笔误，
 * 是**列的形状不够用**：二值列装不下「修复成功 / 仅记录 / 需人工 / 已熔断 / 失败」五种结果。
 *
 * 故新增 `outcome` 列承载五态；`success` **保持原义**（只有 `healed` 记 1），既有读点不破。
 * 存量行的 `outcome` 为 NULL ⇒ 由 `healOutcomeOf` 按 `success` **如实回退**（老账本来就只有二值，
 * 不假装当时分得更细）。
 *
 * 本模块**零 import**（承 `attachment-kinds.ts` / `memory-constants.ts` 的纪律）：renderer 要跨 root
 * 引它取标签，若它拖进 better-sqlite3 / pino，renderer 构建即断。
 */

/**
 * 结果态词表（**唯一真源**）。顺序即界面展示时的语义强弱序。
 *
 * zx_20261002 M12-1 增 `pending_recheck`（待复验）：`healed` 此前是**终局**，只表示"当次动作做成了"，
 * 从来不表示"病已消"——真库 12 行 `healed` 却同类反复正是这个漏洞的实证。现在 `tryHeal` 的处置先记
 * `pending_recheck`，下一轮同类**复发**则降为 `failed`，满期未复发才由 `confirmPendingHeals` 转正
 * `healed`。"做成了"与"站住了"从此是两个词。
 */
export const HEAL_OUTCOMES = ['healed', 'pending_recheck', 'recorded', 'needs_human', 'skipped_alarm', 'failed'] as const;

export type HealOutcome = (typeof HEAL_OUTCOMES)[number];

/**
 * 「这个结果态**算不算把事情办成了**」——`success` 列的唯一判据（写库与回退读**同一把尺**）。
 * 只有 `healed` 算办成；`recorded`（仅记录）**不算**——这正是本轮的靶心。
 */
export function outcomeIsSuccess(o: HealOutcome): boolean {
  return o === 'healed';
}

/** 唯一标签表（界面与日志共用；改词只改这一处）。 */
export const HEAL_OUTCOME_LABEL: Record<HealOutcome, string> = {
  healed: '已修复',
  pending_recheck: '待复验',
  recorded: '仅记录',
  needs_human: '需人工',
  skipped_alarm: '已熔断',
  failed: '失败',
};

export function isHealOutcome(v: unknown): v is HealOutcome {
  return typeof v === 'string' && (HEAL_OUTCOMES as readonly string[]).includes(v);
}

/**
 * 一行自愈账的**结果态**：优先读新列 `outcome`；为 NULL（存量行）时按 `success` 回退
 * ——`success=1 ⇒ healed`、其余 `⇒ failed`。**这不是"猜"**：老账只有二值，回退出来的正是它当时
 * 唯一能表达的两件事；凭空补一个 `recorded` 才是无据。
 */
export function healOutcomeOf(row: { success?: number | null; outcome?: string | null }): HealOutcome {
  if (isHealOutcome(row.outcome)) return row.outcome;
  return Number(row.success) === 1 ? 'healed' : 'failed';
}
