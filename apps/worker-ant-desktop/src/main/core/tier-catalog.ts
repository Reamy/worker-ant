/**
 * zx_20261018_2 批五「见清」（管子·度量衡 / 维特根斯坦·意义即用法）: **档位能力对照的唯一真源**。
 *
 * 病根：同一句"这一档到底能干什么"此前分散在四处各说各话——
 *   `PRICING[t].benefits`（卖点人话）、`pro-gate.ts` / `team-gate.ts`（真实软闸）、
 *   `feature-limits.ts`（执行上限）、`business-plan/license-tiers.md`（对外文档）。
 *   任何一处新增或改口，其余几处**没有任何东西强制它跟上**：价目表写"Pro 含 X"而代码里没有闸，
 *   或闸随新能力放开而后台仍写旧话，都只在用户当场撞见时暴露。
 *
 * 本模块把"对照表"接到**执行面的同一把尺**上：
 *   ① `included` **不重写判据**——逐档调用 `proUnlocked` / `teamUnlocked` 的纯函数形态
 *      （`{ tier, kind: 'licensed' }` 合成态），与真实软闸共享同一份 `||`；
 *   ② 能力词表不另立——逐项取 `PRO_FEATURES` / `TEAM_FEATURES`，人话名取两侧 `*_LABEL`；
 *   ③ 上限与价格不另抄——`TIER_LIMITS` / `PRICING` / `capabilityLine` 原地派生。
 *
 * ⚠ `BENEFIT_COVERAGE` 是**卖点的兑现登记**：`PRICING[t].benefits` 的每一项都必须指回
 *   一项本档 indeed 包含的 catalog 能力、一条派生上限（quota），或明示的"服务项"（无闸，写清理由）。
 *   新增一句无闸卖点而未登记 ⇒ rr 红（名实相符由判据兜底，不靠自觉）。
 *
 * ⚠ 零 electron 依赖（纯常量 + 纯函数）：rr 直跑本模块，IPC 只作壳。
 */
import {
  LICENSE_TIERS,
  TIER_LABEL,
  TIER_LIMITS,
  type LicenseTier,
  type TierLimits,
} from './feature-limits.js';
import { PRICING, EARLY_BIRD, PURCHASE_URL, capabilityLine, capacityLine, type EarlyBird } from './pricing.js';
import { PRO_FEATURES, PRO_FEATURE_LABEL, proUnlocked } from './pro-gate.js';
import { TEAM_FEATURES, TEAM_FEATURE_LABEL, teamUnlocked } from './team-gate.js';
import { TRIAL_DAYS, type LicenseKind } from './license.js';

/** 一条能力在某档的状态。`key` 的词表来自 `PRO_FEATURES` / `TEAM_FEATURES`（不另立第二份）。 */
export interface TierCapability {
  key: string;
  /** 能力归属哪一道闸（排障/分组用）。 */
  gate: 'pro' | 'team';
  label: string;
  included: boolean;
  /** 未包含时＝最低可达档位的人话名；已包含时＝null。 */
  upgradeLabel: string | null;
}

/** 一档的对照行：价、卖点、派生上限、逐项能力。 */
export interface TierCatalogRow {
  tier: LicenseTier;
  label: string;
  priceMonthlyCny: number;
  priceYearlyCny: number;
  tagline: string;
  /** 卖点原文（取自 `PRICING[tier].benefits`——与价目表同一份）。 */
  benefits: string[];
  /** 由 `TIER_LIMITS` 派生的上限行（不另抄字面量）。 */
  capability: string;
  /** zx_20261030_1 M5「限」：由 `TIER_LIMITS` 派生的容量行（五项容量维度，`0 = 不限`）。 */
  capacity: string;
  maxProjectConcurrency: number;
  maxProjects: number;
  /** 本机账号（席位）上限；只数本机 `wa_users`。 */
  maxMembers: number;
  /** 协同节点数上限（含本机）；`0 = 不限`。 */
  maxNodes: number;
  /** 容量维度（`0 = 不限`）——与 `tier-capacity.ts` / `tier-usage.ts` 同一把尺。 */
  maxDevices: number;
  maxExternalTerminals: number;
  maxA2AServers: number;
  maxKnowledgeCardsPerProject: number;
  maxTeamLibraryMemories: number;
  /** 逐项能力：`PRO_FEATURES` + `TEAM_FEATURES` 全量，**每档都全列**（一处对照，锁项不藏）。 */
  capabilities: TierCapability[];
}

/**
 * 试用档授予的档位——由同一对纯函数在试用态上派生，**不写死**。
 * ⚠ 如实注：当前 `team-gate.ts` 对 `kind === 'trial'` 明令放行 ⇒ 派生结果为**团队版**能力面
 *   （这不是本模块的选择，是两道闸的现行语义；将来试用范围收窄，这里自动跟着变）。
 */
export interface TierCatalogTrial {
  days: number;
  grantsTier: LicenseTier;
  /** 授予档位的人话名（由 `TIER_LABEL` 派生）。 */
  grantsLabel: string;
}

/** `license:catalog` 的返回形状——**生产者与渲染层同引此类型**（不各写镜像）。 */
export interface TierCatalogPayload {
  tiers: TierCatalogRow[];
  earlyBird: EarlyBird;
  trial: TierCatalogTrial;
  purchaseUrl: string;
}

/** 某项能力在"已激活的该档"下是否包含（与真实软闸同一把尺）。 */
function includes(tier: LicenseTier, gate: 'pro' | 'team'): boolean {
  const state = { tier, kind: 'licensed' as const };
  return gate === 'pro' ? proUnlocked(state) : teamUnlocked(state);
}

/** 一项能力最低在哪一档被包含（按 `LICENSE_TIERS` 由低到高；理论上不会为 null）。 */
function unlockTierOf(gate: 'pro' | 'team'): LicenseTier {
  return LICENSE_TIERS.find((t) => includes(t, gate)) ?? (gate === 'pro' ? 'pro' : 'team');
}

const UNLOCK_TIER: Record<'pro' | 'team', LicenseTier> = {
  pro: unlockTierOf('pro'),
  team: unlockTierOf('team'),
};

function capabilitiesFor(tier: LicenseTier): TierCapability[] {
  const row = (gate: 'pro' | 'team', key: string, label: string): TierCapability => {
    const included = includes(tier, gate);
    return { key, gate, label, included, upgradeLabel: included ? null : TIER_LABEL[UNLOCK_TIER[gate]] };
  };
  return [
    ...PRO_FEATURES.map((f) => row('pro', f, PRO_FEATURE_LABEL[f])),
    ...TEAM_FEATURES.map((f) => row('team', f, TEAM_FEATURE_LABEL[f])),
  ];
}

function trialGrantsTier(): LicenseTier {
  const state = (tier: LicenseTier) => ({ tier, kind: 'trial' as LicenseKind });
  const all = (tier: LicenseTier): boolean =>
    proUnlocked(state(tier)) && teamUnlocked(state(tier));
  return [...LICENSE_TIERS].reverse().find(all) ?? 'community';
}

/* ── 卖点兑现登记 ───────────────────────────────────────────────────────── */

/**
 * 卖点的指向：
 *   · `capability` —— 有闸能力（`keys` 须同时在本档 `included`）；
 *   · `quota`      —— 由 `TIER_LIMITS` 派生的上限（`unlimited` ⇔ 0，`positive` ⇔ > 0）；
 *   · `service`    —— 明示"无闸服务项"（理由必填：不是"忘了登记"的逃生口）。
 */
export type BenefitTarget =
  | { kind: 'capability'; keys: string[] }
  | { kind: 'quota'; field: keyof TierLimits; rule: 'unlimited' | 'positive' }
  | { kind: 'service'; reason: string };

export interface BenefitCoverageEntry {
  /** 卖点原文（须与 `PRICING[tier].benefits` 逐字相同——rr 断言两边同集同序）。 */
  benefit: string;
  target: BenefitTarget;
}

export const BENEFIT_COVERAGE: Record<LicenseTier, BenefitCoverageEntry[]> = {
  community: [
    { benefit: '开源核心引擎全功能', target: { kind: 'service', reason: '核心引擎随源码发布，不设档位闸' } },
    { benefit: 'BYO Key（自备模型密钥）', target: { kind: 'service', reason: '模型密钥由用户自备，任何档位都可用' } },
  ],
  pro: [
    { benefit: '不限项目', target: { kind: 'quota', field: 'maxProjects', rule: 'unlimited' } },
    // zx_20261029_2 M6「阶梯」：发现/只读台账有真闸（`device_discovery`）；控制不在这一句里。
    { benefit: '设备发现（只读台账）', target: { kind: 'capability', keys: ['device_discovery'] } },
    // zx_20261030_1 M5「限」：设备登记上限（`device-registry.ts` 只拦新登记）。
    { benefit: `设备登记（最多 ${TIER_LIMITS.pro.maxDevices} 台）`, target: { kind: 'quota', field: 'maxDevices', rule: 'positive' } },
    // zx_20261022_3 批七：一句卖点兑现**两跳**（导出 + 导入），两键同列——任一跳缺闸即 rr 红。
    { benefit: '项目知识包（预览注入常开 + JSONL 导出/导入）', target: { kind: 'capability', keys: ['knowledge_export', 'knowledge_import'] } },
    { benefit: '图片内容理解（视觉子调用）', target: { kind: 'capability', keys: ['image_vision'] } },
    { benefit: '视频全片覆盖（8 帧摊到全片）', target: { kind: 'capability', keys: ['long_video'] } },
    { benefit: '长文档分段阅读（PDF 页窗口）', target: { kind: 'capability', keys: ['long_document'] } },
    { benefit: '领域包（跨项目携带项目经验）', target: { kind: 'capability', keys: ['domain_pack'] } },
    // zx_20261023_5 批五：批二落地的 `knowledge_cards` 已在 `PRO_FEATURES` 并有真闸（生成/落候选卡两跳 + 注入按档判），
    //   本轮把它写进价目表——卖点与兑现逐字对齐，`T-3a/T-3b` 双向兜底。
    { benefit: '项目知识卡（开工前注入最用得上的几张蒸馏卡）', target: { kind: 'capability', keys: ['knowledge_cards'] } },
    // zx_20261030_1 M5「限」：每项目知识卡张数上限（`knowledge-cards.ts` 蒸馏落卡）。
    { benefit: `每项目知识卡（最多 ${TIER_LIMITS.pro.maxKnowledgeCardsPerProject} 张）`, target: { kind: 'quota', field: 'maxKnowledgeCardsPerProject', rule: 'positive' } },
    // zx_20261029_2 M6：安装动作口有真闸；「浏览不限」是同一句里的边界说明，不另登记一条。
    { benefit: '市场插件安装（浏览不限）', target: { kind: 'capability', keys: ['plugin_install'] } },
    { benefit: '优先支持', target: { kind: 'service', reason: '支持优先级是交付承诺，不在代码中设闸' } },
  ],
  team: [
    { benefit: '多机协同（自动外派）', target: { kind: 'capability', keys: ['multi_node'] } },
    // zx_20261029_2 M6：发现已归 Pro；本档只兑现「控制（含意图执行）」。
    { benefit: '设备控制（含意图执行）', target: { kind: 'capability', keys: ['device_control'] } },
    // zx_20261030_1 M5「限」：团队档登记上限更高（派生自 `TIER_LIMITS`）。
    { benefit: `设备登记（最多 ${TIER_LIMITS.team.maxDevices} 台）`, target: { kind: 'quota', field: 'maxDevices', rule: 'positive' } },
    { benefit: 'AI 终端意图接入', target: { kind: 'capability', keys: ['external_terminal'] } },
    { benefit: '审计视图', target: { kind: 'capability', keys: ['audit_view'] } },
    { benefit: '审计导出（CSV）', target: { kind: 'capability', keys: ['audit_export'] } },
    { benefit: '团队共享库（模板 / 记忆 / 成果 / 领域包 / 项目画像）', target: { kind: 'capability', keys: ['team_library'] } },
    // zx_20261022_3 批八：画像**搬运**另立一项能力（本机生成/注入常开，不在此闸）。
    { benefit: '项目画像共享（跨节点带项目画像）', target: { kind: 'capability', keys: ['project_profile_share'] } },
    // zx_20261030_1 M5「限」：容量维度有真闸（`tier-capacity.ts` + 五处动作点），卖点指回派生上限。
    { benefit: `每项目知识卡（最多 ${TIER_LIMITS.team.maxKnowledgeCardsPerProject} 张）`, target: { kind: 'quota', field: 'maxKnowledgeCardsPerProject', rule: 'positive' } },
  ],
};

/** 一条卖点指向是否在本档成立（能力须 `included`、quota 须与派生上限一致、服务项须有理由）。 */
function targetHolds(tier: LicenseTier, target: BenefitTarget, caps: TierCapability[]): boolean {
  if (target.kind === 'capability') {
    return target.keys.length > 0
      && target.keys.every((k) => caps.some((c) => c.key === k && c.included));
  }
  if (target.kind === 'quota') {
    const v = TIER_LIMITS[tier][target.field];
    return target.rule === 'unlimited' ? v === 0 : v > 0;
  }
  return target.reason.trim() !== '';
}

/**
 * 校验一档的卖点清单是否**逐条兑现**（返回问题描述；空数组＝全兑现）。
 *   双向：① 清单里每一句都要有登记且指向成立；② 登记里的每一句都要还在清单里（防登记腐化）。
 * rr 用**两只标本**验它：真实清单应为空；塞一句无闸卖点/改一句原文应被点名。
 */
export function benefitCoverageProblems(tier: LicenseTier, benefits: readonly string[]): string[] {
  const caps = capabilitiesFor(tier);
  const entries = BENEFIT_COVERAGE[tier];
  const problems: string[] = [];
  for (const b of benefits) {
    const e = entries.find((x) => x.benefit === b);
    if (!e) { problems.push(`${b}：未登记兑现方式`); continue; }
    if (!targetHolds(tier, e.target, caps)) problems.push(`${b}：指向不成立（本档不包含该能力/上限不符/理由为空）`);
  }
  for (const e of entries) {
    if (!benefits.includes(e.benefit)) problems.push(`${e.benefit}：已登记但价目表没有这句`);
  }
  return problems;
}

/** 对照表全量（每档：价、派生上限、Pro/Team 能力逐项）。 */
export function tierCatalog(): TierCatalogPayload {
  const tiers = LICENSE_TIERS.map((tier): TierCatalogRow => {
    const p = PRICING[tier];
    const l = TIER_LIMITS[tier];
    return {
      tier,
      label: TIER_LABEL[tier],
      priceMonthlyCny: p.priceMonthlyCny,
      priceYearlyCny: p.priceYearlyCny,
      tagline: p.tagline,
      benefits: [...p.benefits],
      capability: capabilityLine(tier),
      capacity: capacityLine(tier),
      maxProjectConcurrency: l.maxProjectConcurrency,
      maxProjects: l.maxProjects,
      maxMembers: l.maxMembers,
      maxNodes: l.maxNodes,
      maxDevices: l.maxDevices,
      maxExternalTerminals: l.maxExternalTerminals,
      maxA2AServers: l.maxA2AServers,
      maxKnowledgeCardsPerProject: l.maxKnowledgeCardsPerProject,
      maxTeamLibraryMemories: l.maxTeamLibraryMemories,
      capabilities: capabilitiesFor(tier),
    };
  });
  const grantsTier = trialGrantsTier();
  return {
    tiers,
    earlyBird: EARLY_BIRD,
    trial: { days: TRIAL_DAYS, grantsTier, grantsLabel: TIER_LABEL[grantsTier] },
    purchaseUrl: PURCHASE_URL,
  };
}
