/**
 * `wa_im_channels.status` 的**读口径唯一真源**（zx_20260912 M6）。
 *
 * 该列同时承载两件事——配置态（`inactive`＝用户停用，其余＝启用中）与运行态
 * （`starting`/`running`/`pending`/`degraded`/`error`，M1 起由适配器 report 落库）。
 * M1 之前运行期从不写运行态，库里恒为启动那刻的 `active`/`running`，故各处手抄的
 * `status IN ('active','running')` 事实上是「启用中」的**代理谓词**；M1 起运行期开始落
 * `degraded`/`pending`/`error`，代理谓词静默收窄成「健康中」，于是降级/待登录/失败的渠道被排除：
 *   · 通知目标解析拿不到渠道就直接 return ⇒ **连 outbox 都不落**，反噬 M3「未送达须记因」；
 *   · 启动恢复集漏掉它们 ⇒ 重启后 IM 网关静默缺失（F3 推送无渠道）。
 * ⇒ 各处一律引用此处，不再手抄；改口径只改这一处，由 rr 钉住「字面量恰好 1 处」。
 *
 * 口径＝**启用中**（非用户停用）：`degraded`/`pending`/`error` 都算在内——对它们不是
 * 「不发/不恢复」，而是「发、失败则如实记因」「重启再试一次」。
 * `inactive` 是唯一由用户动作（`im:stopChannel`）写入的停用值，故为唯一排除项。
 *
 * 用 `IS NOT` 而非 `!=`：该列 DDL 无 `NOT NULL`，`NULL != 'inactive'` 求值为 NULL 会把整行滤掉；
 * 本口径的失败方向应是「试一次并记因」，不是「静默丢弃」，空值安全比较让异常行落在「启用中」。
 */
const ENABLED = "status IS NOT 'inactive'";

/** 「启用中」谓词。`imChannelEnabledSql('c')` → `c.status IS NOT 'inactive'`。 */
export function imChannelEnabledSql(alias = ''): string {
  return alias ? `${alias}.${ENABLED}` : ENABLED;
}
