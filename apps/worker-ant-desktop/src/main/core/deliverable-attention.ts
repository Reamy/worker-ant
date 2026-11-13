/**
 * zx_20261111_3 「显」（管子·度量衡 / 毛选·没有调查没有发言权）:
 *   产出物页「有几件还没验收」的**计数判据一处真源**。
 *
 * 病根：这一句话要么在渲染层数"已加载的几行"（分页下必然少数，等于撒谎），要么在 SQL 里
 *   另写一份"什么算验收"（与列表徽标各判一次，两处迟早各说各话）。故：
 *   · 取数在 main（`deliverable:attention`，与列表同一个 `deliverableScopeSql` 范围）；
 *   · **判据在本文件**：先由 `annotateAcceptance`（既有唯一解析处，含 `show_acceptance` 与
 *     `per_doc_acceptance` 两重门）把 `acceptance` 标好，再由本函数数；列表徽标读的是同一份 `acceptance`。
 *
 * ⚠ 零依赖纯函数（只用 `isAcceptanceType`）：rr 直跑真实现。
 */

import { isAcceptanceType } from './deliverable-types.js';

/** 只声明本判据用到的字段；行上其余字段原样不管。 */
export interface AttentionRow {
  type?: unknown;
  status?: unknown;
  /** `annotateAcceptance` 标上的验收结论；**没有** = 未验收（或按逐条门不算这一条）。 */
  acceptance?: unknown;
}

/**
 * 「未验收」件数。
 *
 * 三条与列表徽标同尺的条件：
 *   ① 未退休（退休件是被取代的旧版，不该催验收）；
 *   ② 类型可验收（`doc`/`code`）；
 *   ③ 行上没有 `acceptance`（判据见 `annotateAcceptance`，不在这里重判 `acceptance_verified`）。
 */
export function countUnverified(rows: readonly AttentionRow[]): number {
  return rows.filter((r) =>
    String(r.status ?? '') !== 'retired'
    && isAcceptanceType(r.type)
    && !r.acceptance).length;
}
