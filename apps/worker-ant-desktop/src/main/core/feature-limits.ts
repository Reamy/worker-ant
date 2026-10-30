/**
 * 档位 → 能力上限的**单一真源**（zx_20261005 M5；管子·轻重：「没有统一的尺，轻重不可比」）。
 *
 * 病根：本轮之前"免费 / 付费"的界**不存在**——并发上限散在 `rhythm.maxConcurrency`（项目自配）与
 *   `PROJECT_CONCURRENCY_DEFAULT`（代码常量），项目数**根本没上限**。"一份许可能多干多少活"遂无物可比。
 *
 * ⚠ **本文件只描述"能力"，不描述"价格"**。价格与档位的对应是 M11（批三）的事；此处先立尺，
 *   免得两处各记各的（承 `feedback_enum_value_sweep_readers` 的"第二落点"教训）。
 *
 * ⚠ 免费档的并发上限取 **3**，与 `PROJECT_CONCURRENCY_DEFAULT` 同值——不是巧合，是口径：
 *   「不激活 = 你用得上默认并发，但**升不上去**」。付费档才把项目自配的 `rhythm.maxConcurrency` 放行。
 *   改这个数之前先读 `task-accounting.resolveProjectConcurrencyLimit` 的消费语义与 `rr_zx_20260929` E-15。
 *
 * ⚠ 零依赖（不 import 任何 core 模块）：`license.ts` 引它、`task-accounting.ts` 引它，
 *   若它反过来引它们即成 ESM 环。纯常量 + 纯函数是刻意的。
 *
 * ⚠ zx_20261030_1 M5「限」：此前档位差异只在「项目 / 席位 / 节点」三个维度，而 0.3.0 用户真正摸得到的
 *   东西（设备台账、外部终端、A2A 服务、知识卡、团队共享记忆）**一律不限**——专业版与团队版在这些
 *   维度上毫无差别，容量卖点无物可兑。本轮补五个**容量型**上限，与既有字段同一约定：`0 = 不限`，
 *   且**只拦新增、不回收已有、不影响运行中任务**（判据在 `core/tier-capacity.ts`，动作面各自接线）。
 */

/** 档位词表（**唯一**定义处；新增档位须穷举读取谓词——`TIER_LIMITS`/`TIER_LABEL` 的键类型取它 ⇒ 漏一档是编译期错）。 */
export const LICENSE_TIERS = ['community', 'pro', 'team'] as const;
export type LicenseTier = (typeof LICENSE_TIERS)[number];

export interface TierLimits {
  /** 单个项目内**并发执行**的任务数上限（软闸：超出不拦执行，只不再开新位）。 */
  maxProjectConcurrency: number;
  /** 项目总数上限；**0 = 不限**。 */
  maxProjects: number;
  /** 本机账号数上限（席位）；**0 = 不限**。只拦新增，已有账号不受影响。 */
  maxMembers: number;
  /**
   * 协同节点数上限（**含本机**）；**0 = 不限**。
   * zx_20261023_1：席位只数本机 `wa_users`、跨机不可聚合，当卖点名不副实；真正可跨机兑现的是入网节点数
   *   ——由 `nodes:enroll` 依 ANS 台账在注册前拦下（`core/node-quota.ts`）。
   */
  maxNodes: number;
  /** 设备台账（`wa_devices` 行数）上限；**0 = 不限**。只拦**首次发现插入**，已有行更新不拦。 */
  maxDevices: number;
  /** 外部 AI 终端（`status='approved'`）上限；**0 = 不限**。只拦**批准**这一动作。 */
  maxExternalTerminals: number;
  /** 同时运行的 A2A 服务数上限；**0 = 不限**。只拦**启动**。 */
  maxA2AServers: number;
  /** **单个项目**的知识卡张数上限；**0 = 不限**。到顶不再落新卡，旧卡的既有清理语义不变。 */
  maxKnowledgeCardsPerProject: number;
  /** 从团队共享库**导入**并落 `wa_memories(source='team_library')` 的记忆总条数上限；**0 = 不限**。 */
  maxTeamLibraryMemories: number;
}

/**
 * 各档能力上限。数值口径来自 `business-plan/v0.2.md` §3.2 的定价表（Community「限 3 并发 / 1 项目」）。
 * ⚠ 改这里 = 改**产品口径**，须同步该表（管子·度量衡：一把尺）。
 */
export const TIER_LIMITS: Record<LicenseTier, TierLimits> = {
  community: {
    maxProjectConcurrency: 3, maxProjects: 1, maxMembers: 1, maxNodes: 1,
    maxDevices: 5, maxExternalTerminals: 1, maxA2AServers: 1, maxKnowledgeCardsPerProject: 8, maxTeamLibraryMemories: 200,
  },
  pro: {
    maxProjectConcurrency: 8, maxProjects: 0, maxMembers: 1, maxNodes: 1,
    maxDevices: 30, maxExternalTerminals: 3, maxA2AServers: 3, maxKnowledgeCardsPerProject: 24, maxTeamLibraryMemories: 2000,
  },
  team: {
    maxProjectConcurrency: 16, maxProjects: 0, maxMembers: 20, maxNodes: 20,
    maxDevices: 200, maxExternalTerminals: 20, maxA2AServers: 10, maxKnowledgeCardsPerProject: 60, maxTeamLibraryMemories: 0,
  },
};

/** 人话档位名（界面直接上屏用；键类型取 `LicenseTier` ⇒ 漏一档是编译期错）。 */
export const TIER_LABEL: Record<LicenseTier, string> = {
  community: '社区版',
  pro: '专业版',
  team: '团队版',
};

/** 运行期收窄：外部输入（许可文件里的 `tier`、DB 里的值）不可信，一律过此。 */
export function isLicenseTier(v: unknown): v is LicenseTier {
  return typeof v === 'string' && (LICENSE_TIERS as readonly string[]).includes(v);
}

/**
 * 软闸：把"项目自配的并发"封进档位上限（**只降不升**——`min` 而非 `Math.max`）。
 *
 * ⚠ 是 `min` 不是"直接取档位值"：项目若自配 1（比档位还保守），用户的意图仍被尊重。
 *   档位是**天花板**，不是**设定值**。
 */
export function clampConcurrency(tier: LicenseTier, configured: number): number {
  const cap = TIER_LIMITS[tier].maxProjectConcurrency;
  return Number.isFinite(configured) && configured > 0 ? Math.min(Math.floor(configured), cap) : cap;
}

/** 项目数是否已达上限（`maxProjects === 0` ⇒ 不限，恒 false）。 */
export function projectQuotaExceeded(tier: LicenseTier, currentCount: number): boolean {
  const cap = TIER_LIMITS[tier].maxProjects;
  return cap > 0 && currentCount >= cap;
}
