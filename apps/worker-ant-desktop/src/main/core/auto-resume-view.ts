/**
 * 自动续跑投影（zx_20261120_2 M1「明」）——把"这次暂停会不会自己续跑"说成 IPC 能给的一张脸。
 *
 * 病根：撞顶暂停后调度器 `autoResumeStepCapPaused()` 会在下一轮扫描（实测 2–6 秒）把任务
 * 置回 `pending` 自动续跑；而暂停横幅只读 `reason`，写的是「执行已挂起，可恢复继续」。
 * 用户看到的是「暂停 → 我还没点，它又跑了」。
 *
 * 口径：**判据不在本模块**——全部复用 `core/step-budget.ts` 的唯一真源：
 *   · `shouldAutoResumeOnStepCap`：due/原因/次数/上限；
 *   · `stepCapContinuationOf`：本次将获的续额步数。
 * 本模块只做两件本层该做的事：把 `context_json` 的两种入参形态（JSON 字符串 / 对象）收成一个，
 * 并把两处真源的返回值投影成渲染层直接可用的五键。此处**不新增判据**，否则又成第二份实现。
 *
 * 渲染层只按 `due` 分两态画横幅：`due=false` 时文案逐字节回到旧版（旧断言不受影响）。
 */
import { shouldAutoResumeOnStepCap, stepCapContinuationOf } from './step-budget.js';

/** 渲染层与 IPC 共用的投影形状（`task:get` 的 `autoResume` 键）。 */
export interface AutoResumeView {
  /** 调度器下一轮扫描会不会把这条暂停自动拉回 `pending` */
  due: boolean;
  /** 人话原因（已发 N 步续额 / 停因不自动续跑 / …），恒非空 */
  reason: string;
  /** 已用续额次数 */
  grants: number;
  /** 续额次数上限（`STEP_CAP_GRANT_LIMIT`） */
  limit: number;
  /** 本次将获得的步数续额（无撞顶账 / 未发新额度 ⇒ 0） */
  resumeBonus: number;
}

/**
 * `ctxJson` 允许是已解析对象或原始 JSON 字符串：IPC 层拿的是整行 `context_json` 字符串，
 * 内层调用已有对象。字符串解析失败**按空对象**处理——不抛、不编出 `due=true`。
 */
export function autoResumeViewOf(ctxJson: unknown): AutoResumeView {
  let ctx: unknown = ctxJson;
  if (typeof ctxJson === 'string') {
    try { ctx = JSON.parse(ctxJson); } catch { ctx = {}; }
  }
  const decision = shouldAutoResumeOnStepCap(ctx);
  const continuation = stepCapContinuationOf(ctx);
  return {
    due: decision.due,
    reason: decision.reason,
    grants: decision.grants,
    limit: decision.limit,
    resumeBonus: continuation?.grantedSteps ?? 0,
  };
}
