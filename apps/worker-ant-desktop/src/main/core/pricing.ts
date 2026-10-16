/**
 * zx_20261005 M11（管子·轻重：**度量衡**——没有统一的尺，轻重不可比）: **档位价格与权益的唯一真源**。
 *
 * 病根：能力上限（`feature-limits.ts`，M5）与价格**各记各的**——一边是"这份许可多能干多少活"，
 *   一边是"这份许可卖多少钱"，两处都用 `community/pro/team` 这三个词，却**没有任何东西强制它们对齐**。
 *   加一档能力忘加价格、改一次价格忘改能力描述，都只在用户看到时才暴露。
 *
 * 本模块把"价格"这一半接到同一把尺上：
 *   ① **键型取 `LICENSE_TIERS`**（`Record<LicenseTier, …>`）⇒ 新增/删除档位时**编译期**即错，不可能漏；
 *   ② **`label` 取 `TIER_LABEL`**——不另立一份档位名（否则"社区版/开源版"两处漂移）；
 *   ③ **能力行 `capabilityLine` 由 `TIER_LIMITS` 派生**——写进价格表的"并发/项目/席位"不是抄来的字面量，
 *      而是**执行时真正生效的上限**；改 `TIER_LIMITS` 一处，价格表里的话跟着变，**不可能名实不符**。
 *
 * ⚠ **早鸟终身是购买 SKU，不是档位**。它 = 「一次性买断 Pro 终身」，能力上限仍是 `pro`。
 *   故它**不**进 `LICENSE_TIERS`（进了会让 `TIER_LIMITS`/`TIER_LABEL` 各缺一格 = 编译期错，或被人
 *   补一个假档位），而是单列 `EARLY_BIRD` 并显式标 `appliesTier: 'pro'`（承 `feedback_enum_value_sweep_readers`
 *   ——"新增枚举值须穷举读取谓词"：这里干脆不新增枚举值）。
 *
 * ⚠ 零依赖（只 import `feature-limits.ts`，方向单一不成环）：`license.ipc.ts` 引它、渲染层经 IPC 取它。
 */
import { LICENSE_TIERS, TIER_LABEL, TIER_LIMITS, type LicenseTier } from './feature-limits.js';

/** 一档的定价与权益。`label` 与 `tier` 皆**派生**自 `feature-limits.ts`，非本文件另立。 */
export interface TierPricing {
  tier: LicenseTier;
  /** 人话档位名——取 `TIER_LABEL[tier]`（不另抄一份）。 */
  label: string;
  /** 月付价（人民币元）；**0 = 免费档**。 */
  priceMonthlyCny: number;
  /** 年付价（人民币元）；**0 = 不提供年付**（如团队档按人月）。 */
  priceYearlyCny: number;
  /** 一句话定位（上屏用）。 */
  tagline: string;
  /** 卖点（人话，营销口径）。**能力上限不在此列**——那由 `capabilityLine` 从 `TIER_LIMITS` 派生。 */
  benefits: string[];
}

/**
 * 价格与档位的一一对应（口径：`business-plan/v0.2.md` §3.2 定价表，对齐 2026 国内开发者工具行情）。
 * ⚠ 改这里 = 改**产品口径**，须同步该表（与 `feature-limits.ts` 同一条纪律）。
 */
export const PRICING: Record<LicenseTier, TierPricing> = {
  community: {
    tier: 'community',
    label: TIER_LABEL.community,
    priceMonthlyCny: 0,
    priceYearlyCny: 0,
    tagline: '开源核心引擎全功能，BYO Key；适合个人与小项目',
    benefits: ['开源核心引擎全功能', 'BYO Key（自备模型密钥）'],
  },
  pro: {
    tier: 'pro',
    label: TIER_LABEL.pro,
    priceMonthlyCny: 99,
    priceYearlyCny: 899,
    tagline: '个人与小团队，无限项目',
    benefits: ['不限项目', '云同步', '高级模板', '优先支持'],
  },
  team: {
    tier: 'team',
    label: TIER_LABEL.team,
    priceMonthlyCny: 199,
    priceYearlyCny: 0,
    tagline: '团队（≥3 席），按人月',
    benefits: ['团队共享记忆 / 模板 / 成果库', '成员权限', '审计视图'],
  },
};

/**
 * 早鸟终身——**一次性买断 Pro 终身**（启动期催单与现金流）。
 * ⚠ 是**购买 SKU**，能力上限即 `pro`；**不属** `LICENSE_TIERS`（不进 `PRICING` 的键集）。
 */
export interface EarlyBird {
  label: string;
  /** 一次性买断价（人民币元）。 */
  priceCny: number;
  /** 名额上限（前 N 名）。 */
  seats: number;
  /** 买断后适用哪一档能力——**必须**是合法档位（故取 `LicenseTier` 类型，防写错）。 */
  appliesTier: LicenseTier;
  note: string;
}

export const EARLY_BIRD: EarlyBird = {
  label: '早鸟终身',
  priceCny: 1999,
  seats: 100,
  appliesTier: 'pro',
  note: '一次性买断 Pro 终身',
};

/**
 * 购买入口（收银台/定价页落地后填此一处；留空 ⇒ 界面如实显示"入口即将开放"，**不摆假链**）。
 * 归此真源，免得渲染层各自硬写一个 URL（承"第二落点"纪律）。
 */
export const PURCHASE_URL = '';

/** 能力行——**由 `TIER_LIMITS` 派生**（不是抄来的字面量）：写的就是执行时真正生效的上限。 */
export function capabilityLine(tier: LicenseTier): string {
  const l = TIER_LIMITS[tier];
  const proj = l.maxProjects === 0 ? '不限项目' : `${l.maxProjects} 个项目`;
  const seat = l.maxMembers === 0 ? '不限席位' : `${l.maxMembers} 席位`;
  return `并发 ${l.maxProjectConcurrency} · ${proj} · ${seat}`;
}

/** 上屏用：各档定价行（按 `LICENSE_TIERS` 序，附派生能力行）。 */
export function pricingRows(): PricingRow[] {
  return LICENSE_TIERS.map((t) => ({ ...PRICING[t], capability: capabilityLine(t) }));
}

/** 一档定价行 = 定价 ⊕ 派生能力行（`capability` 来自 `TIER_LIMITS`，非本文件字面量）。 */
export interface PricingRow extends TierPricing { capability: string }

/** `license:pricing` 的返回形状——**生产者与渲染层同引此类型**（不各写一份镜像）。 */
export interface PricingPayload {
  tiers: PricingRow[];
  earlyBird: EarlyBird;
  purchaseUrl: string;
}
