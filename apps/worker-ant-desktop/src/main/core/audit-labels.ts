/**
 * zx_20261017_1 批二（维特根斯坦·意义即使用）: 审计视图的**词表一处真源**——来源与动作的人话名。
 *
 * 为什么单列一个零 import 的模块：`core/audit-log.ts` 运行期要 `node:crypto`，渲染层不能引；
 *   而"来源/动作怎么显示"若在 renderer 另抄一份，就是词表的第二个落点（改名即两处各说各话）。
 *   故语义（词表 + 行形状）住在这里，IO（读写）住在 `audit-log.ts`——两侧同引这一份。
 *
 * ⚠ 新增动作动词须**同时**在此补人话名；缺键时界面**原样显示动词**（不编一个假描述）。
 */

/** 审计行的来源：本机用户 / 网络内节点 / 系统 / 设备 / 外部终端。 */
export const AUDIT_SOURCES = ['local', 'node', 'system', 'device', 'terminal'] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export const AUDIT_SOURCE_LABEL: Record<AuditSource, string> = {
  local: '本机',
  node: '节点',
  system: '系统',
  device: '设备',
  terminal: '外部终端',
};

/** 动作动词（机器可读）→ 人话。`device.control` / `external.call` 是既有两账的**投影**动作。 */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  'node.update': '改档',
  'node.dispatch': '派活',
  'team.library.share': '分享团队库件',
  'team.library.import': '导入团队库件',
  'team.library.delete': '删除团队库件',
  'license.activate': '激活许可',
  'device.control': '设备控制',
  'external.call': '外部终端调用',
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABEL[action] ?? action;
}

export function isAuditSource(value: unknown): value is AuditSource {
  return typeof value === 'string' && (AUDIT_SOURCES as readonly string[]).includes(value);
}

/**
 * 读模型的**统一行形状**——三本账（新账 / 设备控制 / 外部调用）投影成同一把尺：
 *   `result` 记 ok/denied/error（新账动作无此概念 ⇒ 空串）；
 *   `note` 记机器可读的拒因（外部调用账的 `reason`；其余空串）；
 *   `detail` 是**原行**的载荷（`detail_json` / `args_json`），读模型不另写一份事实。
 */
export interface AuditEventRow {
  id: string;
  source: AuditSource;
  action: string;
  actorKind: string;
  actorRef: string;
  targetType: string;
  targetId: string;
  result: string;
  note: string;
  detail: Record<string, unknown>;
  createdAt: string;
}
