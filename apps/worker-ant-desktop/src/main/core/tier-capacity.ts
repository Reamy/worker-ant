/**
 * zx_20261030_1 M5「限」（管子·度量衡 / 道德经·知止不殆）: **容量型档位闸的单一判据**。
 *
 * 病根：`TIER_LIMITS` 此前只有「项目 / 席位 / 节点 / 并发」四维，用户摸得到的容量维度
 *   （设备台账、外部终端、A2A 服务、知识卡、团队共享记忆）**一律不限** ⇒ 专业版与团队版在
 *   「我家能挂多少东西」这件事上毫无差别，容量卖点无物可兑（见 `feature-limits.ts` 头注）。
 *
 * 本模块只做三件薄事（仿 `seat-quota.ts` 的形态）：
 *   ① **尺**——`capacityLimit(tier, field)` 从 `TIER_LIMITS` 取上限（`0 = 不限`）；
 *   ② **话**——`capacityRefusal` 把「已用 / 上限 / 档位」拼成人话，并明说**已存在的记录不受影响**；
 *   ③ **数**——每种容量一个 COUNT（读不到按 0，不抛）。
 *
 * ⚠ 只判「能不能再新增」：本模块**没有**删除/回收动作。已有数据超限也一条不动——
 *   运行中的任务、已登记的设备、已生成的卡都不受新闸影响（§2.5）。
 * ⚠ 档位由调用方经 `resolveLicenseTier(db)` 取（`license.ts` 的薄封装），本模块不解析许可
 *   ——同一把尺不在两处解析。
 * ⚠ 零 electron 依赖（只引 `feature-limits.ts`）：rr 可直引跑真实现。
 */
import { TIER_LABEL, TIER_LIMITS, type LicenseTier } from './feature-limits.js';

/**
 * 七个容量维度（键即 `TierLimits` 的字段名——改名是编译期错）。
 * zx_20261101_1 M4「授」: 增 `maxIMChannels` / `maxTaskTemplates`——0.3.0 里"能接几个机器人、
 *   能攒几套任务模板"同样被用户摸得到，此前却与档位无关。
 */
export type TierCapacityField =
  | 'maxDevices'
  | 'maxExternalTerminals'
  | 'maxA2AServers'
  | 'maxKnowledgeCardsPerProject'
  | 'maxTeamLibraryMemories'
  | 'maxIMChannels'
  | 'maxTaskTemplates';

/** 各维度的人话名（拒因文案唯一词表，不散在调用点）。 */
export const CAPACITY_LABEL: Record<TierCapacityField, string> = {
  maxDevices: '设备登记',
  maxExternalTerminals: '外部终端',
  maxA2AServers: 'A2A 服务',
  maxKnowledgeCardsPerProject: '每项目知识卡',
  maxTeamLibraryMemories: '团队共享记忆',
  maxIMChannels: 'IM 渠道',
  maxTaskTemplates: '任务模板',
};

/** 读容量用的最小库接口（同 `SeatDb` 形：可脱 better-sqlite3 被 rr 直跑）。 */
export interface CapacityDb {
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

/** 上限（`0` = 不限）——只此一处转调 `TIER_LIMITS`。 */
export function capacityLimit(tier: LicenseTier, field: TierCapacityField): number {
  return TIER_LIMITS[tier][field];
}

export interface CapacityVerdict {
  ok: boolean;
  /** `ok:false` 时的人话（含已用/上限/档位名与「已存在的记录不受影响」）；`ok:true` 为空串。 */
  note: string;
}

/**
 * 新增前的容量判据：未到上限或 `limit === 0` ⇒ 放行；否则拒并给出人话。
 * ⚠ 等于上限即拒（`used >= limit`）——上限是**天花板**，不是「再多一张也行」。
 */
export function capacityRefusal(tier: LicenseTier, field: TierCapacityField, used: number): CapacityVerdict {
  const limit = capacityLimit(tier, field);
  if (limit === 0 || used < limit) return { ok: true, note: '' };
  return {
    ok: false,
    note: `${TIER_LABEL[tier]}${CAPACITY_LABEL[field]}已达上限（已用 ${used}/${limit}）。已存在的记录不受影响；升级档位可提高上限。`,
  };
}

/** COUNT 单值读法：行/列缺失或类型不对 ⇒ 0，**不抛**（读不到不等于「确实 0」，但绝不因读数失败拦住业务）。 */
function countOf(db: CapacityDb, sql: string, ...args: unknown[]): number {
  try {
    const row = db.prepare(sql).get(...args) as { c?: unknown } | undefined;
    const n = Number(row?.c);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** 设备台账行数（`wa_devices`）。 */
export function countDevices(db: CapacityDb): number {
  return countOf(db, 'SELECT COUNT(*) AS c FROM wa_devices');
}

/** 已批准的外部终端数（只数 `status='approved'`——pending/rejected/revoked 不占额度）。 */
export function countApprovedTerminals(db: CapacityDb): number {
  return countOf(db, "SELECT COUNT(*) AS c FROM wa_external_terminals WHERE status = 'approved'");
}

/** 某项目的知识卡总行数（含 pending——它们也占库位，也占用户的容量）。 */
export function countKnowledgeCards(db: CapacityDb, projectId: string): number {
  return countOf(db, 'SELECT COUNT(*) AS c FROM wa_knowledge_cards WHERE project_id = ?', projectId);
}

/** 「所有项目中单项目最大张数」——用量面板用（容量按项目判，故合计无意义，取最高者）。 */
export function countMaxKnowledgeCardsInAnyProject(db: CapacityDb): number {
  return countOf(
    db,
    'SELECT COALESCE(MAX(c), 0) AS c FROM (SELECT COUNT(*) AS c FROM wa_knowledge_cards GROUP BY project_id)',
  );
}

/** 从团队共享库导入落地的记忆总条数（`source='team_library'`）。 */
export function countTeamLibraryMemories(db: CapacityDb): number {
  return countOf(db, "SELECT COUNT(*) AS c FROM wa_memories WHERE source = 'team_library'");
}

/**
 * zx_20261101_1 M4：IM 渠道行数（`wa_im_channels` 全量，含未启动的）。
 * 口径：渠道是"接了几个入口"的容量，启没启用都占接入口；与设备台账"登记即占额"一致。
 */
export function countIMChannels(db: CapacityDb): number {
  return countOf(db, 'SELECT COUNT(*) AS c FROM wa_im_channels');
}

/**
 * zx_20261101_1 M4：**用户自己的**任务模板数。
 * ⚠ 只数 `source ∈ {'user','team_library'}`：`system` 是随包预置、`auto` 是系统自动学习的，
 *   二者都不由用户"新增"出来，计入等于把内置资产算成用户的额度消耗。
 */
export function countTaskTemplates(db: CapacityDb): number {
  return countOf(
    db,
    "SELECT COUNT(*) AS c FROM wa_task_templates WHERE COALESCE(source, '') IN ('user', 'team_library')",
  );
}
