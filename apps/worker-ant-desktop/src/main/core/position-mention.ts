/**
 * zx_20261112_2 B2「识」：IM 里的 **`@岗位`** 解析——「岗位」这个实体第一次从页面走进对话。
 *
 * 病根：上一轮把岗位做成了实体（`core/positions.ts`），但 IM 建单只认 `@项目`；
 *   `@财务 审核本周报销` 里的 `@财务` 要么被当成项目名**新建一个项目**，要么被忽略。
 *
 * 三条硬规矩：
 *   1. **先项目后岗位**：同名时按项目（与「@项目」既有语义一致，不抢）。
 *   2. **岗位只认精确名**：不做模糊匹配——岗位名是用户自己起的短词（财务/税务），
 *      模糊会把「财务复核」算成「财务」，派错岗比多问一句更贵。
 *   3. **三种失败各自说清**：岗位已停用 / 未在本项目启用 / 根本不存在（交回项目解析路）。
 *
 * 纯读、零副作用；文案在这里，路由只负责发。
 */
import type { PositionDb } from './positions.js';
import { getPositionByName, resolveTaskPosition } from './positions.js';

export type PositionMentionResult =
  /** 不是岗位名（交回项目解析路）。 */
  | { kind: 'none' }
  /** 岗位存在但已全局停用。 */
  | { kind: 'disabled'; id: string; name: string }
  /** 岗位启用中，但本项目没启用它。 */
  | { kind: 'not-in-project'; id: string; name: string; projectId: string }
  /** 可用：应预绑到任务。 */
  | { kind: 'ok'; id: string; name: string };

/**
 * 解析一个 `@名字` 是不是岗位，以及在本项目能不能用。
 * `projectId` 为空（项目还没定）时只判到「岗位存在且启用」——项目绑定由调用方在项目定下后**再问一次**。
 */
export function resolvePositionMention(
  db: PositionDb,
  name: string,
  projectId: string,
): PositionMentionResult {
  const n = String(name ?? '').trim();
  if (!n) return { kind: 'none' };
  // 岗位表不存在（旧库/裸夹具）⇒ 当"没有岗位"，不抛、不把建单整条路打死。
  //   生产 `initDatabase` 必建此表；此处是对"读不到"的如实降级（不是猜）。
  let pos: ReturnType<typeof getPositionByName> = null;
  try { pos = getPositionByName(db, n); } catch { pos = null; }
  if (!pos) return { kind: 'none' };
  if (!pos.enabled) return { kind: 'disabled', id: pos.id, name: pos.name };
  if (!projectId) return { kind: 'ok', id: pos.id, name: pos.name };
  let bound = false;
  try { bound = !!resolveTaskPosition(db, projectId, pos.id); } catch { bound = false; }
  return bound
    ? { kind: 'ok', id: pos.id, name: pos.name }
    : { kind: 'not-in-project', id: pos.id, name: pos.name, projectId };
}

/** 失败时的可行动话术（`ok`/`none` 返回空串，调用方不另编）。 */
export function positionMentionRefusalText(r: PositionMentionResult): string {
  switch (r.kind) {
    case 'disabled':
      return `岗位「${r.name}」已停用——请先在「岗位」页启用它，再重新下发；本条未建任务。`;
    case 'not-in-project':
      return `岗位「${r.name}」没在**当前项目**启用——请到项目详情的「岗位」里启用它，或换一个已启用的岗位；本条未建任务。`;
    default:
      return '';
  }
}
