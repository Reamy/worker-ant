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
  /** 年付价（人民币元）；**0 = 不提供年付**。 */
  priceYearlyCny: number;
  /** 计价口径补充（上屏用）；空串 = 无需补充。团队档写「团队授权包」，避免再被读成按人计价。 */
  priceNote: string;
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
    priceNote: '',
    tagline: '个人与小项目：开源核心引擎全功能，自备模型密钥',
    benefits: ['开源核心引擎全功能', 'BYO Key（自备模型密钥）'],
  },
  pro: {
    tier: 'pro',
    label: TIER_LABEL.pro,
    priceMonthlyCny: 99,
    priceYearlyCny: 899,
    priceNote: '',
    tagline: '个人与小团队：不限项目，视觉、视频与长文档都读完',
    // zx_20261018_1 批八：**只写有闸兑现的卖点**——「项目知识包导出」由 `pro-gate.ts` 真实拦截；
    //   预览与执行期注入对社区档常开，故括号里如实写明"常开 + 导出"（不把整块都算作 Pro 独享）。
    //   删去「高级模板」：代码里没有对应闸，也没有对应物（名实不符的卖点不上价目表）。
    // zx_20261018_2 批五：补两项**本轮新增闸**——`image_vision` / `long_video`（`PRO_FEATURES` 逐项兑现）；
    //   每一句都在 `tier-catalog.ts` 的 `BENEFIT_COVERAGE` 里指回一项能力，新增无闸卖点会弄红 rr。
    benefits: [
      '不限项目',
      // zx_20261022_3 批七：两端都兑现——导出/导入各有一跳真闸（`knowledge_export`/`knowledge_import`）；
      //   预览与执行期注入仍对社区档常开（括号里如实写明）。
      '项目知识包（预览注入常开 + JSONL 导出/导入）',
      '图片内容理解（视觉子调用）',
      '视频全片覆盖（8 帧摊到全片）',
      // zx_20261018_3 批六/批七：PDF 页窗口由 `proFeatureRefusal(db,'long_document')` 真拦越界请求。
      '长文档分段阅读（PDF 页窗口）',
      // zx_20261021_3 批二：`domain_pack`——生成与应用两跳均过 `proFeatureRefusal`；导入他人分享的包不另设闸。
      '领域包（跨项目携带项目经验）',
      // zx_20261023_5 批五：`knowledge_cards` 早已有真闸（批二），但价目表没写这句——**卖点若无人兑现是虚名，
      //   兑现了却不写也是白干**。措辞如实：确定性蒸馏的一小把卡，不是训练出的小模型。
      '项目知识卡（开工前注入最用得上的几张蒸馏卡）',
      '优先支持',
    ],
  },
  team: {
    tier: 'team',
    label: TIER_LABEL.team,
    // 2026-10-24：由「按人/月」改为**团队授权包**（一包 ≤20 节点），按包计价、月付/年付并行。
    priceMonthlyCny: 599,
    priceYearlyCny: 5990,
    priceNote: '团队授权包',
    tagline: '团队授权包：最多 20 台协同节点，设备与审计一处管',
    // 七项与 `team-gate.ts` 的 `TEAM_FEATURES`（八项，其中设备发现/控制合成一行）逐项对齐；
    //   「AI 终端意图接入」＝`external_terminal`：默认只授意图能力，原始控制须显式勾选；
    //   「审计导出（CSV）」＝`audit_export`（zx_20261018_3 批七）：`audit:export` 第一跳过闸；
    //   「项目画像共享」＝`project_profile_share`（zx_20261022_3 批八）：只闸分享/导入，本机生成常开。
    benefits: [
      '多机协同（自动外派）',
      '设备发现与控制',
      'AI 终端意图接入',
      '审计视图',
      '审计导出（CSV）',
      '团队共享库（模板 / 记忆 / 成果 / 领域包 / 项目画像）',
      '项目画像共享（跨节点带项目画像）',
    ],
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
 * 购买入口（**面包多店铺页**；留空 ⇒ 界面如实显示"入口即将开放"，**不摆假链**）。
 * 归此真源，免得渲染层各自硬写一个 URL（承"第二落点"纪律）。
 * 暂不做按档位深链：三个商品都在这一页，改价/上下架不必改代码；买错档由签发时换档兜住。
 */
export const PURCHASE_URL = 'https://mbd.pub/o/author-bW2ZlHFtZg==/work';

/**
 * 能力行——**由 `TIER_LIMITS` 派生**（不是抄来的字面量）：写的就是执行时真正生效的上限。
 * zx_20261023_1「称」: 席位段换**协同节点**段——席位只数本机 `wa_users`、跨机不可聚合，
 *   当卖点是名不副实；节点数由 `nodes:enroll` 依 ANS 台账真拦（`core/node-quota.ts`）。
 */
export function capabilityLine(tier: LicenseTier): string {
  const l = TIER_LIMITS[tier];
  const proj = l.maxProjects === 0 ? '不限项目' : `${l.maxProjects} 个项目`;
  const nodes = l.maxNodes === 0 ? '不限节点' : `协同节点 ${l.maxNodes} 台`;
  return `并发 ${l.maxProjectConcurrency} · ${proj} · ${nodes}`;
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
