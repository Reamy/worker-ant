/**
 * zx_20261118_2 M7「标」：质量分**来自哪把尺**的唯一真源。
 *
 * 病根（真库 S4）：`finalize_task` 写入的 95/80 分是**收口方自评**，不是引擎六维评估；
 * 但通知写「（质量 95/100）」、列表/详情只贴「★95」——同一个分值在三个地方长得像客观分。
 * 用户已定本轮**只强化标注**（不补跑六维），故这里只回答"这个分是谁给的"，不改分值。
 *
 * 零依赖纯模块：main 的 `task-notice.ts` 与 renderer 的 `lib/task-badges.ts` 同引一份，
 * 不在两侧各写一遍 `via === 'finalize_task'`。
 */
export function isSelfAssessedQualityVia(via?: string | null): boolean {
  return via === 'finalize_task';
}

/** 通知/列表/详情共用的质量分文案：`自评 95/100` 或 `质量 95/100`。 */
export function qualityLabel(score: number, via?: string | null): string {
  return `${isSelfAssessedQualityVia(via) ? '自评' : '质量'} ${score}/100`;
}
