/**
 * zx_20260930 M15-⑦：模型 `capabilities` 取值域的 **ANS 侧唯一入口**。
 *
 * **本模块不另立一张表**——词表真源是 `@worker-ant/shared-types` 的 `MODEL_CAPABILITY_META`
 * （zx_20260929 M6-3「一个词一个表」的成果物，renderer 与桌面 main 都引它）。
 * ANS 是**第三个**消费者，此前它那份校验根本不存在（`t.Array(t.String())` 什么都放行）⇒
 * `capabilities: ['__no_such_cap__']` 能一路落库，而落库值会被 `resource-matcher` 当筛选条件用。
 * 这里的 11 值由真源 **派生**（`Object.keys`），不是手抄——抄一份就又造出第二个词表落点。
 *
 * 活库实测（`data/ans-server.db`，52 个模型）：distinct 恰这 11 值；
 * `audio,chat,code,embedding,function-calling,image-generation,reasoning,streaming,
 *  structured_output,translation,vision`。
 *
 * ⚠ **「必填」只能是"非空"，不能是"必含 chat"**：同一批数据里 **7 个模型无 `chat`**
 *   （6 个 embedding-only + `deepseek-r1: reasoning,streaming`）⇒ 要求必含 `chat`
 *   会把**合法的在册模型**判非法（违「判据须能被合法数据满足」）。
 */
import { MODEL_CAPABILITY_META } from '@worker-ant/shared-types';

/** 取值域（**派生自真源**，键序即真源声明序）。 */
export const MODEL_CAPABILITIES: readonly string[] = Object.keys(MODEL_CAPABILITY_META);

export function isModelCapability(v: unknown): boolean {
  return typeof v === 'string' && MODEL_CAPABILITIES.includes(v);
}

export type CapabilitiesCheck = { ok: true; value: string[] } | { ok: false; reason: string };

/**
 * 校验一组能力：**非空** + 每项在册。
 * 供路由的 handler 用（schema 那一层挡的是形状，这一层挡的是"值和库里的口径"）。
 */
export function validateCapabilities(input: unknown): CapabilitiesCheck {
  if (!Array.isArray(input)) return { ok: false, reason: 'capabilities 须是数组' };
  if (input.length === 0) return { ok: false, reason: 'capabilities 不可为空（至少给一项）' };
  const bad = input.filter((c) => !isModelCapability(c));
  if (bad.length > 0) {
    return {
      ok: false,
      reason: `不在取值域内的能力：${bad.map(String).join(', ')}（合法值：${MODEL_CAPABILITIES.join(' / ')}）`,
    };
  }
  return { ok: true, value: input as string[] };
}
