/**
 * zx_20261113_2 M14——暂停横幅的**标题与下一步**（零依赖纯模块，renderer 可直引）。
 *
 * 病根（2026-11-13 真标本）：任务停在 `acceptance_failed`，横幅却只说「执行已挂起，可恢复继续」——
 *   用户看不到「1 条验收未达」，也不知道下一步是看验收块还是重跑。验收块在页面下方，横幅没指过去。
 *
 * 口径：`acceptance_failed` 必须报**未达条数/总条数**并指向验收块；`awaiting_input` 说在等回复；
 *   其余因由走 `pauseReasonLabel` 的人话名（空串则如实说「因未记录」，不编原因）。
 */
import { PAUSE_REASON_ACCEPTANCE_FAILED, PAUSE_REASON_AWAITING_INPUT, PAUSE_REASON_NO_OUTPUT, pauseReasonLabel } from '../../../src/main/core/pause-reason.js';

export function pausedBannerHeadline(input: { reason: string; reasonLabel?: string; failed?: number; total?: number }): string {
  if (input.reason === PAUSE_REASON_ACCEPTANCE_FAILED) {
    const failed = Math.max(0, Number(input.failed) || 0);
    const total = Math.max(0, Number(input.total) || 0);
    return `已暂停：验收未通过（${failed} 条未达 / 共 ${total} 条）`;
  }
  if (input.reason === PAUSE_REASON_AWAITING_INPUT) return '已暂停：等待你的回复';
  if (input.reason === PAUSE_REASON_NO_OUTPUT) return '未达交付（无产出证据）';
  const label = (input.reasonLabel ?? '').trim() || pauseReasonLabel(input.reason);
  return label ? `已暂停：${label}` : '已暂停（因未记录）';
}

export function pausedBannerHint(reason: string): string {
  if (reason === PAUSE_REASON_ACCEPTANCE_FAILED) {
    return '交付了但判卷未过——先看下方「验收标准核对」的未达理由，修完再「恢复」；确认无需返工可「标记完成」。';
  }
  if (reason === PAUSE_REASON_AWAITING_INPUT) return '在等你回复/执行；回复后点「恢复」。';
  if (reason === PAUSE_REASON_NO_OUTPUT) {
    return '收口时未发现任何真实产出证据（无落盘成果、无交付物登记、无写入类工具调用）——已暂停而非标完成。若确有产出，请核验后「恢复」；若确认无需产出，可点「完成」。';
  }
  return '执行已挂起，可恢复继续。';
}
