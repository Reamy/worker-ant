/**
 * zx_20261101_2 M3（维特根斯坦·意义即用法 / 毛选·集中优势兵力）: **项目级节点分工**的单一真源。
 *
 * 病根：跨机派发此前只有"ANS 按全局余力自动选"这一条路——用户在某个项目里想指定
 *   "这几台参与、主/辅角色、谁权重高"，**无处可说**；说了也无人执行。
 *   本模块把"项目里的节点分工"落成一张表，并给出**纯计算**的派发策略：
 *     - `wa_project_nodes`：每项目每节点一行（参与 / 项目角色 / 项目权重）；
 *     - `buildDispatchPolicy`：把"项目分工 + 当前台账"折成 ANS 能直接执行的
 *       `{ candidate_node_ids, weight_scale }`（跨仓契约在 `@worker-ant/shared-types`）。
 *
 * 语义三条（次序即判据）：
 *   ① **未登记 = 跟随全局**（不因这张表而把新入网节点挡在外面）；登记且 `participate=0` = 本项目退出。
 *   ② 候选仍须满足全局可派/在线/能力卡含该类目（与 ANS `DISPATCHABLE_WHERE` 同一把尺）；
 *      本机**永不入候选**（派活是交给他机，选到自己等于空转一圈）。
 *   ③ 项目 `role='observer'` 等同本项目不承接（观察者只上报）——让"角色"这一列真的有用，
 *      而不是只在界面上好看。
 *
 * ⚠ **只缩放，不重排**：权重交给 ANS 的 `scaleRankWeight` 在层内生效；三层分组与可靠性次级键不变。
 * ⚠ 本模块零 electron、零网络：台账由调用方传入（真机＝`fetchNodes`；回归喂假）。
 */
import type Database from 'better-sqlite3';
import {
  NODE_ROLE_LABEL,
  NODE_ROLES,
  isDispatchable,
  isNodeOnline,
  isNodeRole,
  type NodeCardCategory,
  type NodeDispatchPolicy,
  type NodeRole,
} from '@worker-ant/shared-types';
import type { NodeLedger } from './node-list.js';

/**
 * 表 DDL 的**单一真源**：`database.ts` 与 rr 夹具同引这一份，避免"夹具建的表比生产宽/乱序，
 *   断言只是自我印证"（见 CLAUDE.md 开发约定）。
 * 主键 `(project_id, node_id)`：一项目一节点一行；重复保存走整体替换（事务内删+插）。
 */
export const PROJECT_NODES_DDL = `CREATE TABLE IF NOT EXISTS wa_project_nodes (
    project_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    participate INTEGER NOT NULL DEFAULT 1,
    role TEXT NOT NULL DEFAULT '',
    weight INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, node_id)
  )`;

/** 本项目登记过的节点行（读口形状；`role=''` = 跟随全局）。 */
export interface ProjectNodeSetting {
  nodeId: string;
  participate: boolean;
  role: NodeRole | '';
  weight: number;
}

/** 写入口一项（IPC 传入；越界值在 `replaceProjectNodeSettings` 统一收窄）。 */
export interface ProjectNodeSettingInput {
  nodeId: string;
  participate?: boolean;
  role?: string;
  weight?: number;
}

/** 派发策略的计算产物——与跨仓契约 `NodeDispatchPolicy` 同形（此处不反向依赖 ANS）。 */
export interface ProjectDispatchPolicy {
  candidateNodeIds: string[];
  weightScale: Record<string, number>;
}

/**
 * 本地形状 → 跨仓**线上形状**（`NodeRequestSubmit.dispatch_policy`）。
 * 字段名随契约走 snake_case——转换只在这一点，别处不再手抄。
 */
export function toWireDispatchPolicy(p: ProjectDispatchPolicy): NodeDispatchPolicy {
  return { candidate_node_ids: [...p.candidateNodeIds], weight_scale: { ...p.weightScale } };
}

/** 分工卡的一行（台账 + 项目登记合成）。 */
export interface ProjectNodePolicyRow {
  node_id: string;
  name: string;
  platform: string;
  online: boolean;
  /** 全局角色（ANS 台账；只读展示）。 */
  global_role: NodeRole;
  /** 项目参与（未登记的行按 `true` 展示——"跟随全局"）。 */
  participate: boolean;
  /** 项目角色（`''` = 跟随全局）。 */
  role: NodeRole | '';
  /** 项目权重（1..10）。 */
  weight: number;
}

/** 分工卡视图（IPC 载荷；renderer 不自带第二份角色词表）。 */
export interface ProjectNodePolicyView {
  rows: ProjectNodePolicyRow[];
  /** 项目角色下拉项（值/人话名）——词表唯一真源仍在本模块上方引入的 shared-types。 */
  role_options: Array<{ value: NodeRole | ''; label: string }>;
  /** 是否已有任何项目级登记（决定"显式分工"是否成立）。 */
  configured: boolean;
  /** 台账读取失败的人话原因（成功时缺省）。 */
  error?: string;
  /** 本机节点 id——界面据此标「本机」（本机永不入派发候选，改了也不生效）。 */
  local_node_id?: string;
}

/** 本模块只用到的 DB 能力（better-sqlite3 / node:sqlite 皆可喂）。 */
export interface ProjectNodePolicyDb {
  prepare: Database.Database['prepare'];
  exec: Database.Database['exec'];
}

const WEIGHT_MIN = 1;
const WEIGHT_MAX = 10;

/** 项目权重收窄：非有限数 ⇒ 1；四舍五入后夹在 1..10。 */
export function clampProjectWeight(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return WEIGHT_MIN;
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, Math.round(n)));
}

/** 项目角色收窄：非三角色之一 ⇒ `''`（跟随全局；脏值不冒充角色）。 */
export function clampProjectRole(raw: unknown): NodeRole | '' {
  return isNodeRole(raw) ? raw : '';
}

function rowToSetting(raw: Record<string, unknown>): ProjectNodeSetting {
  return {
    nodeId: String(raw.node_id ?? ''),
    participate: Number(raw.participate ?? 1) !== 0,
    role: clampProjectRole(raw.role),
    weight: clampProjectWeight(raw.weight),
  };
}

/** 读本项目登记的节点行（无表/读失败 ⇒ 抛；调用方决定"当作无策略"还是如实上屏）。 */
export function listProjectNodeSettings(
  db: ProjectNodePolicyDb,
  projectId: string,
): ProjectNodeSetting[] {
  const rows = db
    .prepare('SELECT node_id, participate, role, weight FROM wa_project_nodes WHERE project_id = ? ORDER BY node_id ASC')
    .all(projectId) as Array<Record<string, unknown>>;
  return rows.map(rowToSetting).filter((r) => r.nodeId !== '');
}

/**
 * 整体替换本项目的节点分工（事务内删+插）。返回实际写入行数。
 * 入参已按 `clampProjectWeight/ clampProjectRole` 收窄、按 `node_id` 去重（后者为准）；
 *   **空列表**也是合法写入——语义是"本项目没有登记任何分工"（回到跟随全局）。
 */
export function replaceProjectNodeSettings(
  db: ProjectNodePolicyDb,
  projectId: string,
  settings: readonly ProjectNodeSettingInput[],
): number {
  const byId = new Map<string, ProjectNodeSetting>();
  for (const s of settings) {
    const nodeId = String(s.nodeId ?? '').trim();
    if (!nodeId) continue;
    // 重复项以后出现者为准（界面上不应出现，但网络/脚本入参须有确定语义）。
    byId.set(nodeId, {
      nodeId,
      participate: s.participate !== false,
      role: clampProjectRole(s.role),
      weight: clampProjectWeight(s.weight),
    });
  }
  const rows = [...byId.values()];
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM wa_project_nodes WHERE project_id = ?').run(projectId);
    const ins = db.prepare(
      `INSERT INTO wa_project_nodes (project_id, node_id, participate, role, weight, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    );
    for (const r of rows) ins.run(projectId, r.nodeId, r.participate ? 1 : 0, r.role, r.weight);
    db.exec('COMMIT');
    return rows.length;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败也保留原始错误 */ }
    throw e;
  }
}

/** 本项目是否已有**任何**节点分工登记（决定是否算"显式分工"）。读不到 ⇒ `false`（不拦旧路径）。 */
export function projectHasNodePolicy(db: ProjectNodePolicyDb, projectId: string): boolean {
  if (!projectId) return false;
  try {
    const row = db.prepare('SELECT 1 FROM wa_project_nodes WHERE project_id = ? LIMIT 1').get(projectId);
    return row !== undefined;
  } catch {
    return false;
  }
}

/** 能力卡是否含该类目（与 ANS `DISPATCHABLE_WHERE` 的 `card_json.categories` 同义）。 */
function cardHasCategory(card: Record<string, unknown> | null, kind: NodeCardCategory): boolean {
  if (!card) return false;
  const cats = card.categories;
  return Array.isArray(cats) && cats.includes(kind);
}

/** 分工卡下拉项——人话名与取值域同出 shared-types（renderer 只渲染，不手抄第二份）。 */
export function projectNodeRoleOptions(): Array<{ value: NodeRole | ''; label: string }> {
  return [
    { value: '', label: '跟随全局' },
    ...NODE_ROLES.map((r) => ({ value: r, label: NODE_ROLE_LABEL[r] })),
  ];
}

/**
 * 把"项目分工 + 当前台账"折成派发策略。**没有任何项目登记 ⇒ `null`**（不动既有自动选）。
 *
 * 候选：台账里非本机 ∧ `isDispatchable`（全局参与且非观察者）∧ 在线（同一把尺）∧
 *   能力卡含该类目 ∧ 项目未退出（登记了 `participate=0` 或项目角色 `observer` 即退出）。
 * 权重：登记行的 `weight` 夹在 1..10 作为倍率；`1` 不写入（缺省即 1，省一份无意义载荷）。
 *
 * ⚠ 只算**桌面能确定**的：最终选谁仍由 ANS 在候选内按三层排序 + 可靠性次级键决定。
 */
export function buildDispatchPolicy(
  db: ProjectNodePolicyDb,
  projectId: string,
  kind: NodeCardCategory,
  ledger: NodeLedger,
  nowMs: number,
): ProjectDispatchPolicy | null {
  if (!projectId) return null;
  const rows = listProjectNodeSettings(db, projectId);
  if (rows.length === 0) return null;
  const byId = new Map(rows.map((r) => [r.nodeId, r]));

  const candidateNodeIds = ledger.nodes
    .filter((n) => {
      if (n.node_id === ledger.localNodeId) return false;
      if (!isDispatchable(n)) return false;
      if (!isNodeOnline(n.last_seen_at, nowMs)) return false;
      if (!cardHasCategory(n.card, kind)) return false;
      const cfg = byId.get(n.node_id);
      if (cfg && !cfg.participate) return false;
      if (cfg && cfg.role === 'observer') return false;
      return true;
    })
    .map((n) => n.node_id);

  const weightScale: Record<string, number> = {};
  for (const r of rows) {
    const w = clampProjectWeight(r.weight);
    if (w !== 1) weightScale[r.nodeId] = w;
  }

  return { candidateNodeIds, weightScale };
}
