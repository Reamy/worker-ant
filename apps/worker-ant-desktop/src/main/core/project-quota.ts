/**
 * zx_20261005 M7（管子·度量衡 / 维特根斯坦·同一把尺）: **项目数配额的唯一判据**。
 *
 * 病根（管子·度量衡：「没有统一的尺，轻重不可比」）：`wa_projects` 有**四条写入落点**——
 *   ① `ipc/project.ipc.ts` `project:create`（GUI 新建）
 *   ② `ipc/project.ipc.ts` `project:clone`（GUI 克隆，**直接 INSERT**，不走 ①）
 *   ③ `services/im-router.ts` `@不存在的项目名` → 建新项目
 *   ④ `services/im-router.ts` 无归属 → 建「IM对话项目」
 * 判据若散在四处，改口径（或补一档）必漏一处 ⇒ 那个漏掉的落点就是"尺量不到的地方"，
 * 配额名存实亡（承 `feedback_enum_value_sweep_readers` 的「第二落点」教训：**一处定义、多处消费**）。
 *
 * ⚠ **软闸（K-3）**：超限**不删既有项目、不拦其在跑**，只不再新建 —— 产品照常可用（fail-open 方向）。
 * ⚠ 零 electron 依赖（只用一个最小 db 接口）——rr 直跑真判据，IPC 与 IM 路由同引一份，不各写各的。
 */
import { TIER_LIMITS, TIER_LABEL, projectQuotaExceeded } from './feature-limits.js';
import { resolveLicenseTier, type LicenseSettingDb, type ResolveLicenseOpts } from './license.js';

/** 当前项目总数（配额的分母）。**读不到 ⇒ 0**——读失败不该把用户锁在门外（宁松勿误锁，与 K-3 同向）。 */
export function countProjects(db: LicenseSettingDb): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS c FROM wa_projects').get() as { c?: unknown } | undefined;
    const n = Number(row?.c ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * 还能不能再建一个项目。
 *   · 返回 `null`  ⇒ **允许**（含 `maxProjects === 0`＝不限，或当前数未达上限）
 *   · 返回字符串   ⇒ **如实拒因**（直接上屏/回话；不写"操作失败"四个字了事）
 *
 * 档位取 `resolveLicenseTier`（无许可/试用过期 ⇒ community）；`opts` 透传 `now`（rr 注入，免依赖墙钟）。
 */
export function projectQuotaRefusal(
  db: LicenseSettingDb | null | undefined,
  opts: ResolveLicenseOpts = {},
): string | null {
  if (!db) return null; // 无库 = 无从判定 ⇒ 不拦（fail-open 方向与 K-3 一致）
  const tier = resolveLicenseTier(db, opts);
  const cap = TIER_LIMITS[tier].maxProjects;
  if (cap === 0) return null; // 不限档（Pro/Team）
  const count = countProjects(db);
  if (!projectQuotaExceeded(tier, count)) return null;
  return `当前为${TIER_LABEL[tier]}，最多可创建 ${cap} 个项目（已有 ${count} 个）。升级档位后可创建更多。`;
}
