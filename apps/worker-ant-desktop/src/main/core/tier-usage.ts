/**
 * zx_20261022_3 批九「信」（管子·度量衡 / 维特根斯坦·意义即用法）: **档位用量的唯一读模型**。
 *
 * 病根：档位差异此前只在"撞墙那一刻"以一句固定话术出现——用户看不到自己用了多少、差多少，
 *   也看不到升级**具体**买到什么。价格表里写的能力与执行面的闸是同一把尺（`tier-catalog.ts` 已保证），
 *   但"我的用量 / 这一档还差什么"没有任何一处可读。
 *
 * 本模块只做两件事：
 *   ① **数**——项目数 / 本机账号（席位）/ 并发 / 注册·在线·参与节点，全部复用既有真源，不另立计数；
 *   ② **说**——把"当前用量"与"升级差异"组装成人话；升级差异**只取 `tier-catalog` 已注册的能力**
 *      与 `TIER_LIMITS` 派生的上限，**不另写卖点**（未注册的宣称不可能从这里冒出来）。
 *
 * ⚠ 不改任何判据：`projectQuotaRefusal` / `proFeatureRefusal` / `teamFeatureRefusal` 原样返回，
 *   本模块的 `refusalWithContext` 只在**回话层**追加用量与升级差异（判据仍是一处）。
 * ⚠ 节点台账为异步取数（ANS）：**取不到就如实标 `unavailable` + 原因**，不把"没读到"写成 0 台在线。
 * ⚠ 零 electron 依赖（只引 core 与 shared-types）：rr 直跑真读库，IPC 只作壳。
 */
import type Database from 'better-sqlite3';
import { isDispatchable, isNodeOnline } from '@worker-ant/shared-types';
import { LICENSE_TIERS, TIER_LABEL, TIER_LIMITS, type LicenseTier } from './feature-limits.js';
import {
  resolveLicenseState,
  type LicenseKind,
  type LicenseSettingDb,
  type ResolveLicenseOpts,
} from './license.js';
import { countProjects } from './project-quota.js';
import { countSeats } from './seat-quota.js';
import { deriveMachineConcurrency, resolveMachineConcurrencyLimit, type AccountingDb } from './task-accounting.js';
import { tierCatalog, type TierCatalogRow } from './tier-catalog.js';
import { fetchNodes } from './node-list.js';
// zx_20261030_1 M5「限」：容量维度的计数与上限（与动作面同一把尺，不另立计数）。
import {
  countApprovedTerminals,
  countDevices,
  countMaxKnowledgeCardsInAnyProject,
  countTeamLibraryMemories,
  type CapacityDb,
} from './tier-capacity.js';
import { listA2AServers } from './a2a-runtime.js';

/** 用量里的能力行——逐项取 `tier-catalog` 的本档对照行（键/名/是否包含/升级档位皆不另立）。 */
export interface TierUsageFeature {
  key: string;
  label: string;
  included: boolean;
  upgradeLabel: string | null;
}

/** 同步可数的用量（不触网）。`limit === 0` 表示**不限**（与 `TIER_LIMITS` 同义）。 */
export interface TierUsageCounts {
  tier: LicenseTier;
  tierLabel: string;
  kind: LicenseKind;
  projects: { used: number; limit: number };
  /** `perProjectMax` = 档位对**单个项目**的并发天花板；`machineLimit` = 整机生效上限（用户可配/CPU 派生）。 */
  concurrency: { perProjectMax: number; machineLimit: number };
  /** 本机账号（席位）——只数本机 `wa_users`；跨机不可聚合，界面称「本机账号」。 */
  seats: { used: number; limit: number };
  /** zx_20261030_1 M5「限」：五项容量维度（`limit === 0` = 不限），与动作面的闸同一把尺。 */
  devices: { used: number; limit: number };
  externalTerminals: { used: number; limit: number };
  a2aServers: { used: number; limit: number };
  /** 团队共享库导入的记忆总条数（`wa_memories(source='team_library')`）。 */
  teamLibraryMemories: { used: number; limit: number };
  /** 知识卡按**项目**判容量 ⇒ 取所有项目中单项目最大张数，附该档上限。 */
  knowledgeCards: { maxInProject: number; limit: number };
  features: TierUsageFeature[];
}

/**
 * 节点台账读数：读不到时 `unavailable: true` + 原因，计数为 0 但**不当成"确实 0 台"**。
 * zx_20261023_1「称」: 增 `registered`（台账行数，含本机）与 `limit`（`TIER_LIMITS[tier].maxNodes`，
 *   `0 = 不限`）——价目表所称的节点上限与这里看到的是同一把尺。
 */
export interface TierUsageNodes {
  registered: number;
  online: number;
  participating: number;
  limit: number;
  unavailable: boolean;
  error?: string;
}

/** 升级差异——只含可核对的两类：catalog 已注册能力名 + `TIER_LIMITS` 派生上限。 */
export interface TierUpgradeDifference {
  toTier: LicenseTier | null;
  toLabel: string | null;
  capabilities: string[];
  quotas: string[];
}

/** `license:usage` 的返回形状——生产者与渲染层同引此类型。 */
export interface TierUsagePayload extends TierUsageCounts {
  nodes: TierUsageNodes;
  /** 相对**下一档**的真实差异（顶层档无升级路径 ⇒ 空）。 */
  upgrade: TierUpgradeDifference;
}

export interface TierUsageOpts extends ResolveLicenseOpts {
  /** 本机节点 id（只用于台账标识，不参与计数）；缺省由调用方给。 */
  localNodeId?: string;
  /** 机器并发派生的核数（rr 注入，不读真机）。 */
  cpus?: number;
}

function nextTierOf(tier: LicenseTier): LicenseTier | null {
  const i = LICENSE_TIERS.indexOf(tier);
  return i >= 0 && i + 1 < LICENSE_TIERS.length ? LICENSE_TIERS[i + 1]! : null;
}

/** 项目数不再受限的最低档——由 `TIER_LIMITS` 派生（不写死 'pro'）。 */
export const PROJECT_QUOTA_UNLOCK_TIER: LicenseTier =
  LICENSE_TIERS.find((t) => TIER_LIMITS[t].maxProjects === 0) ?? 'team';

function catalogRow(tier: LicenseTier): TierCatalogRow | undefined {
  return tierCatalog().tiers.find((r) => r.tier === tier);
}

function featureRowsOf(tier: LicenseTier): TierUsageFeature[] {
  const row = catalogRow(tier);
  return (row?.capabilities ?? []).map((c) => ({
    key: c.key,
    label: c.label,
    included: c.included,
    upgradeLabel: c.upgradeLabel,
  }));
}

/**
 * 同步用量（纯读库，不触网）。
 * 计数真源：`countProjects` / `countSeats` / `resolveMachineConcurrencyLimit` / `TIER_LIMITS` / `tierCatalog`。
 */
export function tierUsageCounts(
  db: LicenseSettingDb | null | undefined,
  opts: ResolveLicenseOpts & { cpus?: number } = {},
): TierUsageCounts {
  const state = resolveLicenseState(db, opts);
  const tier = state.tier;
  const limits = TIER_LIMITS[tier];
  const machine = db
    ? resolveMachineConcurrencyLimit(db as unknown as AccountingDb, { cpus: opts.cpus }).limit
    : deriveMachineConcurrency(opts.cpus);
  return {
    tier,
    tierLabel: TIER_LABEL[tier],
    kind: state.kind,
    projects: { used: db ? countProjects(db) : 0, limit: limits.maxProjects },
    concurrency: { perProjectMax: limits.maxProjectConcurrency, machineLimit: machine },
    seats: { used: db ? countSeats(db) : 0, limit: limits.maxMembers },
    // 容量维度：无库（浏览器态/演示）一律如实 0；A2A 是运行期内存态，与库无关。
    devices: { used: db ? countDevices(db as unknown as CapacityDb) : 0, limit: limits.maxDevices },
    externalTerminals: { used: db ? countApprovedTerminals(db as unknown as CapacityDb) : 0, limit: limits.maxExternalTerminals },
    a2aServers: { used: listA2AServers().length, limit: limits.maxA2AServers },
    teamLibraryMemories: { used: db ? countTeamLibraryMemories(db as unknown as CapacityDb) : 0, limit: limits.maxTeamLibraryMemories },
    knowledgeCards: {
      maxInProject: db ? countMaxKnowledgeCardsInAnyProject(db as unknown as CapacityDb) : 0,
      limit: limits.maxKnowledgeCardsPerProject,
    },
    features: featureRowsOf(tier),
  };
}

/**
 * 从 `from` 升到 `to`（缺省＝下一档）的**真实**差异。
 * 能力名取 `tier-catalog` 的已注册能力（`included` 由真实软闸同一对纯函数派生）；
 * 上限取 `TIER_LIMITS`，只列**确实变化**的那几项。
 */
export function upgradeDifferences(from: LicenseTier, to?: LicenseTier | null): TierUpgradeDifference {
  const target = to ?? nextTierOf(from);
  if (!target || LICENSE_TIERS.indexOf(target) <= LICENSE_TIERS.indexOf(from)) {
    return { toTier: null, toLabel: null, capabilities: [], quotas: [] };
  }
  const fromRow = catalogRow(from);
  const toRow = catalogRow(target);
  const fromIncluded = new Set((fromRow?.capabilities ?? []).filter((c) => c.included).map((c) => c.key));
  const capabilities = (toRow?.capabilities ?? [])
    .filter((c) => c.included && !fromIncluded.has(c.key))
    .map((c) => c.label);

  const a = TIER_LIMITS[from];
  const b = TIER_LIMITS[target];
  const quotas: string[] = [];
  if (a.maxProjects !== b.maxProjects) quotas.push(b.maxProjects === 0 ? '不限项目' : `${b.maxProjects} 个项目`);
  if (a.maxProjectConcurrency !== b.maxProjectConcurrency) quotas.push(`并发 ${b.maxProjectConcurrency}`);
  // zx_20261023_1「称」: 升级差异卖**可跨机兑现的**节点数。
  if (a.maxNodes !== b.maxNodes) quotas.push(b.maxNodes === 0 ? '不限协同节点' : `${b.maxNodes} 台协同节点`);
  // zx_20261027_3 M3：本机账号同样是档位实差——此前只用于计数、升级面板看不见。
  //   措辞沿用「本机账号」（zx_20261023_1 口径），不写「席位」。
  if (a.maxMembers !== b.maxMembers) quotas.push(b.maxMembers === 0 ? '不限本机账号' : `本机账号 ${b.maxMembers}`);
  // zx_20261030_1 M5「限」：容量维度同样只列**确实不同**的项（0 = 不限，不写成 "0 台"）。
  if (a.maxDevices !== b.maxDevices) quotas.push(b.maxDevices === 0 ? '不限设备登记' : `设备登记 ${b.maxDevices} 台`);
  if (a.maxExternalTerminals !== b.maxExternalTerminals) quotas.push(b.maxExternalTerminals === 0 ? '不限外部终端' : `外部终端 ${b.maxExternalTerminals} 台`);
  if (a.maxA2AServers !== b.maxA2AServers) quotas.push(b.maxA2AServers === 0 ? '不限 A2A 服务' : `A2A 服务 ${b.maxA2AServers} 个`);
  if (a.maxKnowledgeCardsPerProject !== b.maxKnowledgeCardsPerProject) quotas.push(b.maxKnowledgeCardsPerProject === 0 ? '不限每项目知识卡' : `每项目知识卡 ${b.maxKnowledgeCardsPerProject} 张`);
  if (a.maxTeamLibraryMemories !== b.maxTeamLibraryMemories) quotas.push(b.maxTeamLibraryMemories === 0 ? '不限团队共享记忆' : `团队共享记忆 ${b.maxTeamLibraryMemories} 条`);

  return { toTier: target, toLabel: TIER_LABEL[target], capabilities, quotas };
}

/** 一行用量（`0` = 不限）——界面与拒因共用同一写法。 */
export function usageRatio(used: number, limit: number): string {
  return limit === 0 ? `${used}（不限）` : `${used}/${limit}`;
}

/** 把"当前用量 + 升级差异"拼成追加到拒因后面的那一段（不改判据本身）。 */
export function usageContextLine(
  counts: TierUsageCounts,
  requiredTier?: LicenseTier,
): string {
  const usage = `当前用量：项目 ${usageRatio(counts.projects.used, counts.projects.limit)} · 本机账号 ${usageRatio(counts.seats.used, counts.seats.limit)} · 项目并发上限 ${counts.concurrency.perProjectMax}`;
  const up = requiredTier ? upgradeDifferences(counts.tier, requiredTier) : upgradeDifferences(counts.tier);
  const gains = [...up.quotas, ...up.capabilities];
  if (up.toLabel && gains.length > 0) {
    return `${usage}。升级${up.toLabel}可获得：${gains.join('、')}。`;
  }
  return `${usage}。`;
}

/**
 * 闸拒因的**回话层**增强：原句一字不改，另起一段附上当前用量与升级差异。
 * `requiredTier`：被拦的那件事需要哪一档（如 Team 能力传 `'team'`）；缺省＝按下一档算。
 */
export function refusalWithContext(
  db: LicenseSettingDb | null | undefined,
  refusal: string,
  opts: ResolveLicenseOpts & { requiredTier?: LicenseTier; cpus?: number } = {},
): string {
  if (!db || !refusal) return refusal;
  const counts = tierUsageCounts(db, opts);
  return `${refusal}\n${usageContextLine(counts, opts.requiredTier)}`;
}

/**
 * 完整用量（含节点台账）。节点取数失败 ⇒ `unavailable: true` + 原因（不把读失败写成 0 在线）。
 * `now` 可注入（rr 不依赖墙钟）。
 */
export async function tierUsage(
  db: Database.Database,
  opts: TierUsageOpts = {},
): Promise<TierUsagePayload> {
  const counts = tierUsageCounts(db, opts);
  const nowMs = (opts.now ?? new Date()).getTime();
  const ledger = await fetchNodes(db, opts.localNodeId ?? '');
  const nodeLimit = TIER_LIMITS[counts.tier].maxNodes;
  let nodes: TierUsageNodes;
  if (ledger.error) {
    nodes = { registered: 0, online: 0, participating: 0, limit: nodeLimit, unavailable: true, error: ledger.error };
  } else {
    nodes = {
      registered: ledger.nodes.length,
      online: ledger.nodes.filter((n) => isNodeOnline(n.last_seen_at, nowMs)).length,
      participating: ledger.nodes.filter((n) => isDispatchable(n)).length,
      limit: nodeLimit,
      unavailable: false,
    };
  }
  return { ...counts, nodes, upgrade: upgradeDifferences(counts.tier) };
}
