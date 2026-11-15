/**
 * zx_20261115_2 M3（维特根斯坦·意义即用法 / 毛选·没有调查就没有发言权）:
 * 跨机 E2E 的**收口判据**——只认"真的完成"，不把 `failed` 也算成功。
 *
 * 病根（zx_20261115_1 M6）：`e2e_zx_20261112_2.ts` 原判据是
 *   `remoteSeen && (localStatus === 'completed' || localStatus === 'failed')`
 * ⇒ 远端递归自拆后停在 `paused`、本地永远没完成，脚本仍可能以"failed 也算收口"过关；
 *   而方案说的是"成功路径"。本模块把判据抽成纯函数，脚本与受控回归**跑同一份实现**。
 *
 * 四件事缺一不可：
 *   ① 对端真的建了任务（remoteSeen）；
 *   ② 本地任务到 `completed`（`failed` / `paused` / 其它都不算）；
 *   ③ 远端回执核对 `verified`（不是 `self-reported`，更不是 `failed`）；
 *   ④ 产出清单非空（`outputs.length >= 1`）。
 *
 * ⚠ 零依赖、零 IO；只做判据与理由，不写证据文件、不发请求。
 */

export interface RelayE2EInput {
  /** 对端库里是否真的出现了这次派发的任务。 */
  remoteSeen: boolean;
  /** 本地（派活方）任务的最终状态。 */
  localStatus: string;
  /** 回执核对三态：`verified` / `self-reported` / `failed`；无回执为 `null`/缺省。 */
  receiptVerdict?: string | null;
  /** 远端回传的产出清单（只认数组；缺省/非数组都算没有）。 */
  outputs?: unknown[] | null;
}

export interface RelayE2EJudgement {
  ok: boolean;
  /** 未通过的原因（人话，逐项列出；通过时为空数组）。 */
  reasons: string[];
}

/** 唯一判据：四件事全成立才算成功收口（`failed` 永不算通过）。 */
export function judgeRelayE2E(input: RelayE2EInput): RelayE2EJudgement {
  const reasons: string[] = [];
  if (!input?.remoteSeen) reasons.push('对端未建任务');
  const local = String(input?.localStatus ?? '');
  if (local !== 'completed') reasons.push(`本地未完成（${local || '无状态'}）`);
  const verdict = String(input?.receiptVerdict ?? '');
  if (verdict !== 'verified') reasons.push(`回执未通过（${verdict || '无回执'}）`);
  const outputs = Array.isArray(input?.outputs) ? input.outputs : [];
  if (outputs.length < 1) reasons.push('产出清单为空');
  return { ok: reasons.length === 0, reasons };
}
