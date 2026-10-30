/**
 * zx_20261005 M22（管子·度量衡 / 维特根斯坦·同一把尺）: **Team 档能力软闸的唯一判据**。
 *
 * 背景：`business-plan/materials/open-source-scope.md` 早已声明「团队协作 / 企业特性＝闭源商业许可」，
 *   但 zx_20261004 把三块能力（**多机协同 / 设备发现 / 设备控制**）落进本仓且**毫无闸门**——任何档位都能用。
 *   三块能力横切 core+ipc+renderer+启动接线，**不能**靠 `publish-oss.ts` 路径排除出仓（会留悬空 import）。
 *   故裁定（A 方案）：**留仓 + Team 档软闸**——见方案 `plans/improve/zx_20261005.md` 批六 M22。
 *
 * 一处真源（承 `feedback_enum_value_sweep_readers` 的「第二落点」教训）：判据**只此一处**——
 *   启动接线（`index.ts`）×2、协同 IPC、设备 IPC、设备工具编排**各自只调它**，不另写档位判断。
 *
 * ⚠ **软闸（K-3）**：锁定**不删数据、不拦在跑**，只是**该能力不可用**（产品照常可用，fail-open 方向）。
 * ⚠ **解锁档位＝Team**；**试用期内也放行**（zx_20261027_3 M3 起试用态 `tier` 落 `team`＝团队版能力）。
 * ⚠ zx_20261029_2 M6「阶梯」：**`device_discovery` 已移出本词表**，归 `pro-gate.ts`——
 *   设备**发现 / 只读台账**是专业版能力，**控制**（含意图执行）才是团队版。两档各读各的闸，
 *   本文件只管「动」那一段；`ipc/devices.ipc.ts` 的 discover/cloud_sync 已重定向到 Pro 闸。
 *   判据仍**特判 `kind === 'trial'`**，不只依赖 `tier === 'team'`——试用语义的裁决留在这一处，不随档位字样漂移。
 * ⚠ 零 electron 依赖（只用一个最小 db 接口）——rr 直跑真判据；`now`/`fingerprint` 可注入（G-4 不依赖墙钟）。
 */
import { type LicenseTier } from './feature-limits.js';
import { resolveLicenseState, type LicenseSettingDb, type LicenseState, type ResolveLicenseOpts } from './license.js';

/**
 * Team 档能力词表（**唯一定义处**；新增一项须穷举接线 + 面板）。
 * `external_terminal`（zx_20261014_4 批三）三处接线：`main/index.ts`（起门那一跳）·
 *   `ipc/external.ipc.ts`（`external:setInbound` 写口）· `core/external-calls.ts`（能力面）。
 *   面板：`renderer/src/pages/PeersPage.tsx`（「门」区块 + 页面级升级卡）。
 * `audit_export`（zx_20261018_3 批七）一处接线：`ipc/audit.ipc.ts` 的 `audit:export` 第一跳
 *   （`core/audit-log.ts` 的 `exportAuditCsvGated` 先闸后读）；面板：`renderer/src/pages/AuditPage.tsx`。
 */
export const TEAM_FEATURES = ['multi_node', 'device_control', 'external_terminal', 'audit_view', 'audit_export', 'team_library', 'project_profile_share'] as const;
export type TeamFeature = (typeof TEAM_FEATURES)[number];

/** 人话能力名（界面/拒因直接上屏用；键类型取 `TeamFeature` ⇒ 漏一项是编译期错）。 */
export const TEAM_FEATURE_LABEL: Record<TeamFeature, string> = {
  multi_node: '多机协同',
  // zx_20261029_2 M6: 只写「控制」——发现/只读台账已归专业版（`pro-gate.ts` 的 `device_discovery`）。
  device_control: '设备控制（含意图执行）',
  // zx_20261018_1 批八：名实相符——进来的终端**默认只授意图能力**（说"有点热"），
  //   原始设备控制须**显式勾选**（承批二的 `DEFAULT_TERMINAL_CAPABILITIES`）。人话名把这条边界说出来，
  //   免得用户以为"接入"＝"把全屋钥匙交出去"。
  external_terminal: '外部终端接入（意图接入 + 原始控制/任务请求须显式勾选）',
  // zx_20261017_1 批二: 三本账合成一个读模型——"谁在什么时候改了什么"。
  audit_view: '审计视图',
  // zx_20261018_3 批七: 读得见 ⇒ 也导得出。导出走 `audit:export` 第一跳先过本闸；
  //   锁定档位**不读库、不落文件**（承同轮 Pro 长文档"先闸后读"的同一把尺）。
  audit_export: '审计导出（CSV）',
  // zx_20261017_1 批六: 跨节点共享模板/记忆/成果元数据（只元数据，不传文件）。
  team_library: '团队共享库',
  // zx_20261022_3 批八: **只闸"搬运"**（分享/从共享库取画像），不闸本机生成与执行期注入——
  //   社区档照常生成、照常注入自己的画像；"把画像带到别的节点"才是团队能力。
  project_profile_share: '项目画像共享',
};

/** 软闸裁定（界面直接上屏 `detail`；`unlocked` 供动作层放手/拦下）。 */
export interface TeamGate {
  unlocked: boolean;
  /** 生效档位（软闸读的就是它） */
  tier: LicenseTier;
  tierLabel: string;
  /** 如实说明：解锁时＝已启用；锁定时＝缺 Team + 升级指引 */
  detail: string;
}

/**
 * 判据本体的**纯函数形态**：只看生效档位与许可类型，不读库。
 *   `resolveTeamGate` 真闸与 `tier-catalog.ts` 的对照表**同引这一处**——不各写一份 `||`。
 */
export function teamUnlocked(state: Pick<LicenseState, 'tier' | 'kind'>): boolean {
  return state.tier === 'team' || state.kind === 'trial';
}

/**
 * Team 档能力是否已解锁。
 *   解锁 ⇔ 生效档位为 Team **或** 试用期内（`kind === 'trial'`）。
 *   **不 throw**（承 `resolveLicenseState` 的 fail-open：任何异常都退 community ⇒ 锁定，不是"打不开"）。
 */
export function resolveTeamGate(db: LicenseSettingDb | null | undefined, opts: ResolveLicenseOpts = {}): TeamGate {
  const st = resolveLicenseState(db, opts);
  const unlocked = teamUnlocked(st);
  const names = TEAM_FEATURES.map((f) => TEAM_FEATURE_LABEL[f]).join(' / ');
  return {
    unlocked,
    tier: st.tier,
    tierLabel: st.tierLabel,
    detail: unlocked
      ? `团队版能力已启用（${names}）。`
      : `「${names}」属于团队版能力（当前为${st.tierLabel}）。升级到团队版即可启用。`,
  };
}

/**
 * 某一项 Team 能力能否使用。
 *   · 返回 `null`  ⇒ **放行**
 *   · 返回字符串   ⇒ **如实拒因**（IPC/工具直接回给用户，不写"操作失败"四个字了事）
 */
export function teamFeatureRefusal(
  db: LicenseSettingDb | null | undefined,
  feature: TeamFeature,
  opts: ResolveLicenseOpts = {},
): string | null {
  const gate = resolveTeamGate(db, opts);
  if (gate.unlocked) return null;
  return `「${TEAM_FEATURE_LABEL[feature]}」属于团队版能力（当前为${gate.tierLabel}）。升级到团队版即可启用。`;
}
