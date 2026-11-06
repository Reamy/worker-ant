/**
 * zx_20261017_1 批六: **团队共享库**的词表与硬边界——ANS 路由与桌面 core **同引这一份**。
 *
 * 上限若两侧各写一套，改一次就要改两处，且必漏一处（承 `feedback_enum_value_sweep_readers`）。
 * 故 kinds / 标题长度 / body 字节数 / 单节点条数只在此处定义；两侧只引用，不复刻。
 */

/**
 * 共享件五类：任务模板 / 记忆 / 成果元数据 / 领域包 / 项目画像（zx_20261022_3 批八）。
 * ⚠ 新增一类须穷举全部读取谓词：ANS 路由（kind 校验与拒因文案）、`core/team-library.ts`
 *   （候选/分享/导入三分支）、`ipc/team.ipc.ts`、`renderer/.../TeamLibraryPage.tsx`（列由本表派生）。
 */
export const TEAM_ITEM_KINDS = ['template', 'memory', 'deliverable', 'domain_pack', 'project_profile'] as const;
export type TeamItemKind = (typeof TEAM_ITEM_KINDS)[number];

export function isTeamItemKind(v: unknown): v is TeamItemKind {
  return typeof v === 'string' && (TEAM_ITEM_KINDS as readonly string[]).includes(v);
}

/** 标题上限（字符数，不含任何隐式截断——超了如实拒）。 */
export const TEAM_ITEM_MAX_TITLE = 200;
/** 载荷上限（`JSON.stringify(body)` 的 UTF-8 字节数）。 */
export const TEAM_ITEM_MAX_BODY_BYTES = 64 * 1024;
/** 单节点上限（**每个来源节点**自己的条数，不是全局）。 */
export const TEAM_ITEM_MAX_PER_NODE = 500;

/** 上屏的人话类型名（键类型取 `TeamItemKind` ⇒ 漏一项是编译期错）。 */
export const TEAM_ITEM_KIND_LABEL: Record<TeamItemKind, string> = {
  template: '任务模板',
  memory: '记忆',
  deliverable: '成果',
  domain_pack: '领域包',
  project_profile: '项目画像',
};

/** `POST /api/v1/team/items` 的请求体：**没有 `source_node_id`**——来源只由凭据派生。 */
export interface TeamItemInput {
  kind: TeamItemKind;
  title: string;
  body: Record<string, unknown>;
}

/** 落库行（`body` 读面已解出为对象）。 */
export interface TeamItem {
  id: string;
  kind: TeamItemKind;
  title: string;
  body: Record<string, unknown>;
  source_node_id: string;
  created_at: string;
  updated_at: string;
}
