/**
 * zx_20261030_1 M4（维特根斯坦·意义即用法 / 老子·知止）: 远端回传的**回执自洽核对**——三选一。
 *
 * 病根：「远端说完成」与本机「验收完成」此前是同一句话（`node-remote-driver.ts` 那句"远端自报完成，
 *   本机未复核"）。边界本身没错，但**一点都没核**与**核了回执**是两件事，面板不该把两者都说成"完成"。
 *
 * 核什么（只读两边已有台账，不重跑、不搬文件）：
 *   - `taskId` 一致：对端回的不是别的活；
 *   - 终态合法：done 路只认 `completed`（`failed`/缺省都是"回执自相矛盾"）；
 *   - 产出清单非空：对端回传里**自报**的产出条数（M4 起执行方随结果附带，仅元数据，不传文件）；
 *   - 事件在本机台账有痕：本机这单确有事件（不是凭空冒出一个结论）。
 *
 * ⚠ 纯函数、零 IO ⇒ 受控回归可直引跑真实现（同 `node-identity.ts` 范式）。
 * ⚠ 「核对通过」也只到**回执自洽**：本机没有独立重跑其产出——措辞不得越过这条线。
 */

export type ReceiptVerdict = 'verified' | 'self-reported' | 'failed';

/** 回执核对结果（落 `result_json.receipt`；界面按 `verdict` 取三档措辞）。 */
export interface RemoteReceipt {
  verdict: ReceiptVerdict;
  /** 缺了哪几项（`taskId` / `terminal` / `outputs` / `event`）；`failed` 时亦列明。 */
  missing: string[];
  /** 对端自报的产出条数；无清单 ⇒ `null`（不把"没报"伪造成 0 项）。 */
  outputCount: number | null;
  checkedAt: string;
}

/** done 路唯一合法终态（error 路不走本核对：它本就按失败收口）。 */
const LEGAL_DONE_TERMINAL = 'completed';

/**
 * 核对一份远端回传。判据次序＝从"这单是不是这单"到"有没有痕"，先证身份再验内容。
 */
export function verifyRemoteReceipt(input: {
  localTaskId: string;
  result: Record<string, unknown> | null;
  /** 本机事件台账里该任务是否有痕（调用方查 `wa_event_log`，查不到⇒false）。 */
  hasLocalEvent: boolean;
  checkedAt: string;
}): RemoteReceipt {
  const r = input.result ?? {};
  const remoteTaskId = typeof r.taskId === 'string' ? r.taskId : '';
  const terminal = typeof r.taskStatus === 'string' ? r.taskStatus : '';
  const outputs = Array.isArray(r.outputs) ? r.outputs : null;
  const outputCount = outputs ? outputs.length : null;

  const missing: string[] = [];
  if (!remoteTaskId || remoteTaskId !== input.localTaskId) missing.push('taskId');
  if (terminal !== LEGAL_DONE_TERMINAL) missing.push('terminal');
  // 身份/终态不自洽 ⇒ 不进入"缺项"档：这不是"回执不全"，是"回执说的不是这单/不是完成"。
  if (missing.length > 0) {
    return { verdict: 'failed', missing, outputCount, checkedAt: input.checkedAt };
  }

  if (!outputs || outputs.length === 0) missing.push('outputs');
  if (!input.hasLocalEvent) missing.push('event');
  return {
    verdict: missing.length === 0 ? 'verified' : 'self-reported',
    missing,
    outputCount,
    checkedAt: input.checkedAt,
  };
}

/** 缺项 → 人话（`missing` 里的键是机器可读的，面板/会话不吃英文键）。 */
const RECEIPT_MISSING_LABEL: Record<string, string> = {
  taskId: '任务号不符',
  terminal: '终态非法',
  outputs: '无产出清单',
  event: '本机台账无痕',
};

/** 回执核对结论 → 一句人话（会话留痕与面板同一套词，不各说各的）。 */
export function receiptNote(r: RemoteReceipt): string {
  const missing = r.missing.map((m) => RECEIPT_MISSING_LABEL[m] ?? m).join('、');
  if (r.verdict === 'verified') return `回执核对通过（${r.outputCount ?? 0} 项产物）`;
  if (r.verdict === 'self-reported') return `对方自报完成，回执不全（缺：${missing}）`;
  return `回执核对失败（${missing}），不记完成`;
}
