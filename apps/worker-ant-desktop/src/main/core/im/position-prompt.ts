/**
 * zx_20261115_4 M2「岗」（维特根斯坦·意义即使用 / 毛选·抓主要矛盾）:
 *   **IM 建单时"该不该问岗位"的唯一判据**——纯读、零副作用、零 LLM，rr 可直跑。
 *
 * 病根：`im-router.ts` 此前只在「项目恰好一个启用岗位」时按项目默认指派；0 个 / **≥2 个**一律
 *   静默留空，回执里连"岗位"二字都不出现。真库里有个项目绑了 6 个岗位 ⇒ 该项目所有 IM 任务
 *   永远不带岗位 ⇒ 岗位经验永远沉淀不出来（全库 362 单只有 1 单带岗位）。
 *
 * 三条规矩（与需求 §4.1「角色或项目缺失，不直接执行，回复候选并追问」对齐，但不制造审讯）：
 *   1. **只问一次，之后记住**：该项目该用户在此渠道上一次派过岗位 ⇒ 沿用并明示，不再问。
 *   2. **不问没打算用岗位的人**：项目没绑岗位（或只绑一个）⇒ 维持既有行为（不问 / 默认）。
 *   3. **永远给出口**：追问一定带「0. 直接派（不指派岗位）」，不把人逼进死角。
 *
 * ⚠ 判据只看"这个项目**声明了**岗位化作业（绑定 ≥2 个启用岗位）"——那是用户自己表达的意图，
 *   不是我们替他猜的。没声明就不打扰。
 */
import type { PositionDb } from '../positions.js';

/** 追问里最多列出的岗位数（编号 1..N，另加 0=直接派）；超出的如实说"还有更多"。 */
export const POSITION_PROMPT_MAX_OPTIONS = 8;

export interface PositionPromptOption {
  id: string;
  name: string;
}

export type PositionPromptDecision =
  /** 不问：未启用开关 / 已显式 @岗位 / 项目绑定不足 2 个启用岗位。 */
  | { kind: 'none'; reason: 'disabled' | 'mentioned' | 'no_project' | 'too_few' }
  /** 沿用：该项目该用户在此渠道上一单派过的岗位仍在用。 */
  | {
      kind: 'reuse';
      positionId: string;
      positionName: string;
      /** 上一单距现在多久（毫秒，供回执说明"上次"有多久）；取不到为 null。 */
      lastUsedAtMs: number | null;
    }
  /** 追问：列候选 + 「0. 直接派」。 */
  | { kind: 'ask'; options: PositionPromptOption[]; truncated: boolean };

export interface PositionPromptInput {
  projectId: string;
  externalUser: string;
  channelType: string;
  /** 消息里已经 @ 到可用岗位 ⇒ 不问、不覆盖用户选择。 */
  mentionedPosition: boolean;
  /** 开关 `position.ask_when_multiple`（缺省开）。 */
  enabled: boolean;
  /** 当前时刻（毫秒）。**由调用方传入**——判据不读真实墙钟。 */
  nowMs: number;
}

interface TaskPositionRow {
  position_id: string;
  created_at: string;
  name?: string;
}

/**
 * 项目里**可用**的岗位（绑定且启用、岗位自身启用），按岗位名排序保证编号稳定。
 * 读不到（旧库无表 / 查询异常）⇒ 空数组——与 `resolvePositionMention` 同纪律：不抛、不把建单打死。
 */
export function listProjectPositionOptions(db: PositionDb, projectId: string): PositionPromptOption[] {
  try {
    const rows = db
      .prepare(
        `SELECT p.id AS id, p.name AS name
           FROM wa_project_positions pp
           JOIN wa_positions p ON p.id = pp.position_id
          WHERE pp.project_id = ? AND pp.enabled = 1 AND p.enabled = 1
          ORDER BY p.name ASC, p.id ASC`,
      )
      .all(projectId) as Array<{ id?: string; name?: string }>;
    return rows
      .map((r) => ({ id: String(r.id ?? ''), name: String(r.name ?? '') }))
      .filter((r) => r.id !== '');
  } catch {
    return [];
  }
}

/**
 * 该用户在此渠道、此项目**最近一单 IM 任务**派过的岗位（只在它仍可用时返回）。
 * `source='im'` 的判据与 `resolveProjectForUser` 同一形状（`context_json.source/externalUser/channel`）。
 */
function lastUsedPosition(
  db: PositionDb,
  input: PositionPromptInput,
  options: PositionPromptOption[],
): { positionId: string; positionName: string; lastUsedAtMs: number | null } | null {
  try {
    const row = db
      .prepare(
        `SELECT t.position_id AS position_id, t.created_at AS created_at
           FROM wa_tasks t
          WHERE t.project_id = ?
            AND t.position_id IS NOT NULL AND t.position_id <> ''
            AND json_valid(t.context_json)
            AND json_extract(t.context_json,'$.source') = 'im'
            AND json_extract(t.context_json,'$.externalUser') = ?
            AND json_extract(t.context_json,'$.channel') = ?
          ORDER BY datetime(t.created_at) DESC, t.rowid DESC
          LIMIT 1`,
      )
      .get(input.projectId, input.externalUser, input.channelType) as TaskPositionRow | undefined;
    if (!row) return null;
    const hit = options.find((o) => o.id === String(row.position_id));
    if (!hit) return null;
    const at = Date.parse(`${String(row.created_at).replace(' ', 'T')}Z`);
    return {
      positionId: hit.id,
      positionName: hit.name,
      lastUsedAtMs: Number.isFinite(at) ? at : null,
    };
  } catch {
    return null;
  }
}

/** 判据主入口：`none` / `reuse` / `ask` 三态。 */
export function positionPromptDecision(db: PositionDb, input: PositionPromptInput): PositionPromptDecision {
  if (!input.enabled) return { kind: 'none', reason: 'disabled' };
  if (input.mentionedPosition) return { kind: 'none', reason: 'mentioned' };
  const projectId = String(input.projectId ?? '').trim();
  if (!projectId) return { kind: 'none', reason: 'no_project' };
  const options = listProjectPositionOptions(db, projectId);
  // 0 个：这个项目不用岗位；1 个：既有"项目默认岗位"派生已覆盖（`defaultPositionForProject`）。
  // 两种情况都不该在这里多问一句——问了就是替用户决定。
  if (options.length < 2) return { kind: 'none', reason: 'too_few' };
  const reused = lastUsedPosition(db, input, options);
  if (reused) return { kind: 'reuse', ...reused };
  return {
    kind: 'ask',
    options: options.slice(0, POSITION_PROMPT_MAX_OPTIONS),
    truncated: options.length > POSITION_PROMPT_MAX_OPTIONS,
  };
}

/** 追问回执文案（纯函数；调用方只管发）。`0` 永远是出口。 */
export function positionPromptText(d: Extract<PositionPromptDecision, { kind: 'ask' }>): string {
  const lines = d.options.map((o, i) => `${i + 1}. ${o.name}`).join('\n');
  const more = d.truncated ? `\n（还有更多岗位，未在此列出——可到桌面端「岗位」页查看）` : '';
  return `这个项目里有多个岗位，请回复编号选择这单派给谁：\n${lines}\n0. 直接派（不指派岗位）${more}\n\n（不指派也能干活，只是这单不会沉淀岗位经验。）`;
}

/** 沿用回执里那一句（空串 = 不占行）。 */
export function positionReuseNote(d: Extract<PositionPromptDecision, { kind: 'reuse' }>): string {
  return `（沿用上次岗位：${d.positionName}）`;
}
