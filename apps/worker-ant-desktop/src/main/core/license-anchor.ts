/**
 * 试用起算点的**库外封印**（zx_20261016_4 —— 补 zx_20261005 M7/K-4 留下的一处"可重置"洞）。
 *
 * 何故：M7 把"试用起算点"只写成 `wa_settings` 里**一行**（`license.trial_started_at`），
 *   删掉那一行 ⇒ 下次启动 `ensureSetting` 又把"此刻"写了进去 ⇒ 试用**永远重置**，
 *   且经 `team-gate.ts` 顺带白拿全部 Team 能力（trial 解锁那四件）。一行 SQL 即可绕过，太廉价。
 *
 * 治法：**两处锚点、取早者、缺一侧自愈**——
 *   · 锚点一：`wa_settings.license.trial_started_at`（`resolveLicenseState` 读它，那条读路径不动）
 *   · 锚点二：数据目录下 `license-anchor.json`（**库外**——删库行推不早它，删它推不早库行）
 *   每次启动交由 `resolveTrialAnchor` 裁决，再把结果**回写两处** ⇒ 被删的那一侧自动补回。
 *
 * ⚠ **诚实边界**（K-3 软闸的固有尺度，别把它当保险柜）：**两处同时删**仍然重置。
 *   本模块把代价从"删一行 SQLite"抬到"找到并删两个文件"——挡住的是**顺手改**，挡不住**决心改**
 *   （决心改的人直接改包里的字节码更省事）。真正的闸是**云中枢**（联网增强：按账号下发权益、
 *   许可见 `/entitlements`）——见 `business-plan/license-tiers.md §6`。
 *
 * ⚠ **时钟回拨**（把系统时间调早）仍能重置：`isUsableAnchor` 认"未来时刻"为**不可用**（那一刀挡的是
 *   "直接往库里塞一个 2099 年"这种更廉价的改法，见 `resolveTrialAnchor`）。回拨需**长期保持**才有效，
 *   且会连带弄坏本机一切按时刻判定的事——不是一条划算的路。同样只有云中枢能真解。
 *
 * 本模块**零项目依赖**、`readSeal`/`writeSeal` **都不 throw**（软闸纪律的延续：宁可少一处锚，不可打不开），
 *   故 rr 可直跑（`initDatabase` 因 better-sqlite3/Electron ABI 冲突跑不进 rr，裁决必须是无副作用纯函数）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 库外封印文件名（落在数据目录下，与 `worker-ant-server.db` 同级）。 */
export const TRIAL_ANCHOR_FILENAME = 'license-anchor.json';

/**
 * 一个时刻值能否**充当试用起算点**：可解析 ∧ **不晚于此刻**。
 *
 * 未来时刻不是合法的"起始点"（起算点只能是过去）。这一条同时挡住"直接往库里塞 2099 年"——
 * 该侧被判不可用，于是**取另一处的那个真值**（而不是取它、也不是回落首启）。
 */
export function isUsableAnchor(value: string | null | undefined, now: Date): boolean {
  if (!value) return false;
  const t = new Date(value);
  if (!Number.isFinite(t.getTime())) return false;
  return t.getTime() <= now.getTime();
}

export interface TrialAnchorInput {
  /** `wa_settings.license.trial_started_at` 现值（读不到为 null/undefined） */
  dbValue: string | null | undefined;
  /** 封印文件现值（读不到为 null/undefined） */
  sealValue: string | null | undefined;
  now: Date;
}

export interface TrialAnchor {
  /** 权威起算点 ISO——**回写两处都用它** */
  startIso: string;
  /** 两处都不可用 ⇒ 本次即首启（起算点＝此刻） */
  firstRun: boolean;
  /** 需要自愈时，有效值出自哪一侧；两侧皆可用 / 皆不可用时为 null */
  healedFrom: 'db' | 'seal' | null;
}

/**
 * 裁决试用起算点。**纯函数**（不读盘、不看表——入参即全部事实）。
 *
 * 规则：**两处中取可用者里更早的那个**；只有一侧可用即取它并标记自愈；两侧皆不可用 ⇒ 首启（此刻）。
 * 「取早不取晚」是这套设计的关节——它让**删任一处的效果单调**：删一侧只会让起算点**不变**，
 * 绝不会**变晚**；要变晚只能两处同删，那就退回首启（＝重置），与"本来就没人管"等价，不额外让利。
 */
export function resolveTrialAnchor(input: TrialAnchorInput): TrialAnchor {
  const { dbValue, sealValue, now } = input;
  const dbOk = isUsableAnchor(dbValue, now) ? (dbValue as string) : null;
  const sealOk = isUsableAnchor(sealValue, now) ? (sealValue as string) : null;

  if (dbOk && sealOk) {
    return { startIso: new Date(dbOk).getTime() <= new Date(sealOk).getTime() ? dbOk : sealOk, firstRun: false, healedFrom: null };
  }
  if (dbOk) return { startIso: dbOk, firstRun: false, healedFrom: 'db' };
  if (sealOk) return { startIso: sealOk, firstRun: false, healedFrom: 'seal' };
  return { startIso: now.toISOString(), firstRun: true, healedFrom: null };
}

/** 读封印文件。**不 throw**（文件不在 / 坏 JSON / 字段不是字符串 ⇒ 一律 null，当作"没有封印"）。 */
export function readSeal(sealPath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(sealPath, 'utf-8')) as { trialStartedAt?: unknown };
    return typeof parsed.trialStartedAt === 'string' ? parsed.trialStartedAt : null;
  } catch {
    return null;
  }
}

/** 写封印文件（尽力而为，**不 throw**）。返回是否写成——调用方据此如实告知"只剩一处锚了"。 */
export function writeSeal(sealPath: string, startIso: string): boolean {
  try {
    fs.mkdirSync(path.dirname(sealPath), { recursive: true });
    fs.writeFileSync(sealPath, JSON.stringify({ trialStartedAt: startIso }), { encoding: 'utf-8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
