/**
 * zx_20261106_3 B3「协」（道德经·知止 / 毛选·没有调查没有发言权）: **项目该用哪种派发模式**的唯一裁定。
 *
 * 三种偏好：项目显式设置 > 全局设置 > 有分工登记的默认。
 * 能力优先（`capability`）**只在全部条件满足时生效**：
 *   团队版 ∧ 已入网 ∧ 在线他机 ≥ 1 ∧（项目显式 capability 或 未显式但有分工登记）。
 * 单机 / 专业版 / 未入网 / 无在线他机 ⇒ **永不**进能力模式，如实给理由（界面据此说人话）。
 *
 * 显式 `off` 一律尊重（用户说停就停）；显式 `overflow` 不被默认升级成 capability。
 *
 * ⚠ 纯函数、零 IO：tier/enrolled/peers/hasDivision 由调用方查好再喂。
 */
import { normalizeOrchestrateMode, type OrchestrateMode, type ResolvedOrchestrateMode } from './node-orchestrate.js';
import type { LicenseTier } from './feature-limits.js';
import type { LicenseKind } from './license.js';
// zx_20261112_1 B5「衡」：团队能力判据只有一把尺（`team-gate.teamUnlocked`），不在此手写 `tier === 'team'`。
import { teamUnlocked } from './team-gate.js';

/** `wa_projects.context_json.dispatch_mode` 的键名（读写同引）。 */
export const PROJECT_DISPATCH_MODE_KEY = 'dispatch_mode';

export const PROJECT_DISPATCH_MODES = ['off', 'auto', 'overflow', 'capability'] as const;
export type ProjectDispatchMode = (typeof PROJECT_DISPATCH_MODES)[number];

export function isProjectDispatchMode(value: unknown): value is ProjectDispatchMode {
  return typeof value === 'string' && (PROJECT_DISPATCH_MODES as readonly string[]).includes(value);
}

/** 人话名——与取值域**同处**（界面不手抄第二份；加一格即编译期提醒）。`auto` 是旧别名，仅在库里可能遇到。 */
export const PROJECT_DISPATCH_MODE_LABEL: Record<ProjectDispatchMode, string> = {
  off: '关闭外派（只在本机跑）',
  auto: '溢出外派（旧值）',
  overflow: '溢出外派（本机跑不过来才派）',
  capability: '能力优先（谁更匹配就派给谁）',
};

/** 从 `wa_projects.context_json` 原文取**原始值**（坏 JSON / 缺失 ⇒ `undefined`；合法性另由解析器判）。 */
export function readProjectDispatchModeRaw(contextJson: string | null | undefined): unknown {
  try {
    const ctx = JSON.parse(contextJson || '{}') as Record<string, unknown>;
    return ctx[PROJECT_DISPATCH_MODE_KEY];
  } catch {
    return undefined;
  }
}

/** 只声明用到的库能力，免得 core 纯函数模块引 better-sqlite3 类型（rr 用 node:sqlite 同形实现即可）。 */
export interface ProjectDispatchWriteDb {
  prepare(sql: string): { run(...params: unknown[]): unknown };
}

/**
 * 写口：只动 `$.dispatch_mode` **一个键**——附件/目标/方案/分工等兄弟键原地保留
 * （`json_set`/`json_remove`；承 `feedback_json_column_overwrite_wipes_siblings` 三次复发教训，禁裸对象覆写）。
 * 返回是否命中了项目行（未命中不谎称已保存）。
 */
export function writeProjectDispatchMode(
  db: ProjectDispatchWriteDb,
  projectId: string,
  mode: ProjectDispatchMode | null,
): boolean {
  const path = `$.${PROJECT_DISPATCH_MODE_KEY}`;
  const sql = mode === null
    ? "UPDATE wa_projects SET context_json = json_remove(COALESCE(context_json, '{}'), ?), updated_at = datetime('now') WHERE id = ?"
    : "UPDATE wa_projects SET context_json = json_set(COALESCE(context_json, '{}'), ?, ?), updated_at = datetime('now') WHERE id = ?";
  const res = (mode === null
    ? db.prepare(sql).run(path, projectId)
    : db.prepare(sql).run(path, mode, projectId)) as { changes?: number } | undefined;
  return (res?.changes ?? 0) > 0;
}

export interface ResolveProjectDispatchInput {
  /** 项目显式设置的原始值（`wa_projects.context_json.dispatch_mode`）；未设 ⇒ null/undefined。 */
  projectMode?: unknown;
  /** 本机全局缺省（`node.orchestrate_mode`）。 */
  globalMode: OrchestrateMode;
  tier: LicenseTier;
  enrolled: boolean;
  onlinePeers: number;
  /** `wa_project_nodes` 里该项目是否有登记（参与/角色/权重任一）。 */
  hasDivision: boolean;
}

export interface ResolvedProjectDispatch {
  mode: ResolvedOrchestrateMode;
  /** 人话理由（直接可上屏）。 */
  reason: string;
}

/** 能力模式的前置条件；返回空串＝具备，非空＝缺什么。 */
export function capabilityPrereqRefusal(input: {
  tier: LicenseTier;
  enrolled: boolean;
  onlinePeers: number;
  /**
   * zx_20261112_1 B5：许可类型（试用按团队能力放行）。缺省 ⇒ 只按档位尺判
   *   （试用态 tier 本就落 `team`，行为与旧版一致）。
   */
  kind?: LicenseKind;
}): string {
  // 档位尺与 `team-gate` **同引一处**：能纳入多台节点即解锁；不在此另写 `tier === 'team'`。
  if (!teamUnlocked({ tier: input.tier, kind: input.kind ?? 'none' })) {
    return `需要团队版（当前：${input.tier}）`;
  }
  if (!input.enrolled) return '本机尚未加入 ANS 网络';
  if (input.onlinePeers < 1) return '当前没有在线可派对端';
  return '';
}

export function resolveProjectDispatchMode(input: ResolveProjectDispatchInput): ResolvedProjectDispatch {
  const explicit = isProjectDispatchMode(input.projectMode) ? input.projectMode : null;
  const globalResolved = normalizeOrchestrateMode(input.globalMode);
  const prereq = capabilityPrereqRefusal(input);

  if (explicit === 'off') return { mode: 'off', reason: '项目显式关闭外派' };
  if (explicit === 'overflow' || explicit === 'auto') {
    return { mode: 'overflow', reason: '项目显式选择溢出外派' };
  }
  if (explicit === 'capability') {
    if (!prereq) return { mode: 'capability', reason: '项目显式能力优先' };
    // 显式要能力优先但前提不满足：退回全局偏好（不静默关掉，也不硬派）。
    return { mode: globalResolved, reason: `能力优先暂不生效：${prereq}；退回 ${globalResolved}` };
  }

  // 未显式：全局 off 是用户的总闸，尊重它。
  if (globalResolved === 'off') return { mode: 'off', reason: '全局已关闭外派' };
  if (!prereq && input.hasDivision) {
    return { mode: 'capability', reason: '团队项目已登记分工，默认能力优先' };
  }
  return {
    mode: globalResolved,
    reason: prereq
      ? `按全局 ${globalResolved}（能力优先不可用：${prereq}）`
      : `按全局 ${globalResolved}（项目尚未登记分工）`,
  };
}
