/**
 * zx_20261115_3 M1「归」（维特根斯坦·意义即用法 / 韩非·循名责实）：
 * **产出物的归属账与贡献账**——一条产出物可以"登记在某任务名下"，另一些任务"确实写过它"，
 * 这是两件事；此前只有前者（`wa_deliverables.task_id`），后者只在 `wa_task_files` 里躺着没人读。
 *
 * 病根（真标本，2026-11-15 真库）：同一文件被第二单重写时，工程级查重按既有行返回、
 *   **不夺归属**（`findDeliverableByPath` 的既定安全口径）⇒ 第二单名下 0 条；而跨机回执
 *   `readDeliveredOutputs` 与任务详情都只读 `task_id = ?` ⇒ "写了文件却无产出"。
 *   真库实测：**104 对**（任务, 文件）落在"写者 ≠ 归属者"，涉及 36 个任务、3 个任务名下 0 产出。
 *
 * 三条纪律：
 *   ① **不改归属**：本模块只读归属行；补登记只对"工程内尚无任何登记行"的文件建新行；
 *   ② **两本账各自署名**：归属行带 `ownerTaskId`，贡献行带 `claimedByTaskId`（谁写的）；
 *   ③ **探针不计**：`isProbePath`（与 `docNotProbe` 同一批标本对拍）在贡献侧一律排除（宁少不多）。
 *
 * ⚠ 零 electron / 零网络；db 只需 `prepare().get/all/run`（node:sqlite 与 better-sqlite3 同形）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  createDeliverable,
  deliverableScopeSql,
  findDeliverableByPath,
  isProbePath,
} from './deliverable-lifecycle.js';

/** 一次补登记的**显示/落库**上限（与 `SHELL_WRITTEN_REGISTER_LIMIT` 同量级；超出如实记 `limit`）。 */
export const ARTIFACT_BACKFILL_LIMIT = 20;

export interface TaskArtifact {
  /** 盘上路径；服务类成果（无文件）为 `null`。 */
  path: string | null;
  name: string;
  type: string;
  /** 归属行取库内状态；仅在贡献账里出现（未登记）的文件为 `'written'`。 */
  status: string;
  /** 归属行 id；仅贡献时可为 `null`。 */
  deliverableId: string | null;
  /** 归属者（登记行上的 task_id）；跨归属时 ≠ 本任务。 */
  ownerTaskId: string | null;
  /** 贡献者（写作账上的 task_id）；归属行本身为 `null`。 */
  claimedByTaskId: string | null;
  /** true = 本任务树**写过**这个文件（写作账），不一定是登记归属者。 */
  claimed: boolean;
  /** 盘上是否仍存在（doc 类）。界面须如实标注"已不在盘上"。 */
  exists: boolean;
}

export interface ListTaskArtifactsOptions {
  /** 任务集合（详情传子树；回执传单任务）。 */
  taskIds: string[];
  /** 工程 id；缺省会从任务行反查（读不到时贡献行仍可列，只是 owner 未知）。 */
  projectId?: string | null;
  /** false ⇒ 略过"写作账有、盘上已不在"的文件（回执用；详情用 true 以如实标注）。 */
  includeMissing?: boolean;
}

interface TaskFileRow {
  task_id?: unknown;
  path?: unknown;
}

interface DeliverableRowLite {
  id?: unknown;
  task_id?: unknown;
  name?: unknown;
  type?: unknown;
  status?: unknown;
  file_path?: unknown;
}

function projectIdOf(db: Database.Database, taskIds: readonly string[]): string {
  if (taskIds.length === 0) return '';
  try {
    const row = db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(taskIds[0]) as { project_id?: unknown } | undefined;
    return String(row?.project_id ?? '');
  } catch {
    return '';
  }
}

/**
 * 归属 ∪ 贡献（按 `path.resolve` 去重，归属优先）。纯读。
 *
 * 贡献侧只收"写作账里确有、非探针"的文件；缩略名取 `basename`，类型统一记为 `doc`
 * （只用于**展示与回执计数**，不落库、不参与任何类型闸——不冒充 code/service）。
 */
export function listTaskArtifacts(db: Database.Database, o: ListTaskArtifactsOptions): TaskArtifact[] {
  const ids = [...new Set((o.taskIds ?? []).map((t) => String(t ?? '').trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const projectId = String(o.projectId ?? '') || projectIdOf(db, ids);
  const out: TaskArtifact[] = [];
  const seen = new Set<string>();

  // ① 归属：未退休、doc 探针已排除（`deliverableScopeSql` 的唯一取数范围）。
  try {
    const scope = deliverableScopeSql({ taskIds: ids });
    const rows = db
      .prepare(`SELECT id, task_id, name, type, status, file_path FROM wa_deliverables WHERE ${scope.sql} ORDER BY created_at ASC, rowid ASC`)
      .all(...scope.params) as DeliverableRowLite[];
    for (const r of rows) {
      const raw = String(r.file_path ?? '').trim();
      const key = raw ? `p:${path.resolve(raw)}` : `d:${String(r.id ?? '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        path: raw || null,
        name: String(r.name ?? ''),
        type: String(r.type ?? ''),
        status: String(r.status ?? ''),
        deliverableId: String(r.id ?? ''),
        ownerTaskId: r.task_id ? String(r.task_id) : null,
        claimedByTaskId: null,
        claimed: false,
        exists: raw ? fs.existsSync(raw) : true,
      });
    }
  } catch { /* 归属读不到 ⇒ 只出贡献账（不编空行） */ }

  // ② 贡献：写作账（write_file / edit_file 成功即入册）。
  try {
    const rows = db
      .prepare(`SELECT task_id, path FROM wa_task_files WHERE task_id IN (${ids.map(() => '?').join(',')}) ORDER BY last_at ASC`)
      .all(...ids) as TaskFileRow[];
    for (const r of rows) {
      const raw = String(r.path ?? '').trim();
      if (!raw) continue;
      if (isProbePath(raw)) continue; // 探针不计（宁少不多）
      const key = `p:${path.resolve(raw)}`;
      if (seen.has(key)) continue; // 归属优先：同一路径已由归属行表达
      const exists = fs.existsSync(raw);
      if (!exists && o.includeMissing === false) continue;
      let owner: { id: string; task_id: string | null; status: string } | undefined;
      if (projectId) {
        try {
          const hit = findDeliverableByPath(db, { projectId, filePath: raw });
          if (hit) owner = { id: hit.id, task_id: hit.task_id, status: hit.status };
        } catch { /* 查不到归属 ⇒ owner 未知，但不影响"写过"这个事实 */ }
      }
      seen.add(key);
      out.push({
        path: raw,
        name: path.basename(raw),
        type: 'doc',
        status: owner ? owner.status : 'written',
        deliverableId: owner ? owner.id : null,
        ownerTaskId: owner ? owner.task_id : null,
        claimedByTaskId: r.task_id ? String(r.task_id) : null,
        claimed: true,
        exists,
      });
    }
  } catch { /* 老库无写作账 ⇒ 只出归属行 */ }

  return out;
}

export type ClaimSkipReason = 'missing' | 'probe' | 'registered' | 'no_project' | 'limit' | 'create_failed';

export interface ClaimPlanEntry {
  path: string;
  reason: ClaimSkipReason | 'ok';
}

export interface ClaimPlan {
  projectId: string;
  /** 计划建行的文件（≤ 上限）。 */
  candidates: string[];
  /** 逐条理由（含被上限截掉的）。 */
  entries: ClaimPlanEntry[];
}

/**
 * 派生"该为哪些文件补登记"（**不写库**；脚本/预览/真写共用同一把尺）。
 *
 * 只认三个正向条件：盘上仍在 ∧ 非探针 ∧ 工程内无任何登记行；**上限 20**，超出记 `limit`，不静默。
 */
export function planClaimRegistrations(
  db: Database.Database,
  o: { taskId: string; projectId?: string | null; limit?: number },
): ClaimPlan {
  const taskId = String(o.taskId ?? '').trim();
  const limit = Math.max(1, Math.floor(Number(o.limit) || ARTIFACT_BACKFILL_LIMIT));
  const projectId = String(o.projectId ?? '') || projectIdOf(db, [taskId]);
  const plan: ClaimPlan = { projectId, candidates: [], entries: [] };
  if (!taskId) return plan;
  if (!projectId) {
    plan.entries.push({ path: '', reason: 'no_project' });
    return plan;
  }
  let rows: TaskFileRow[] = [];
  try {
    rows = db.prepare('SELECT task_id, path FROM wa_task_files WHERE task_id = ? ORDER BY last_at ASC').all(taskId) as TaskFileRow[];
  } catch {
    return plan;
  }
  for (const r of rows) {
    const raw = String(r.path ?? '').trim();
    if (!raw) continue;
    if (!fs.existsSync(raw)) { plan.entries.push({ path: raw, reason: 'missing' }); continue; }
    if (isProbePath(raw)) { plan.entries.push({ path: raw, reason: 'probe' }); continue; }
    let existing: unknown;
    try { existing = findDeliverableByPath(db, { projectId, filePath: raw }); } catch { existing = undefined; }
    if (existing) { plan.entries.push({ path: raw, reason: 'registered' }); continue; }
    if (plan.candidates.length >= limit) { plan.entries.push({ path: raw, reason: 'limit' }); continue; }
    plan.candidates.push(raw);
    plan.entries.push({ path: raw, reason: 'ok' });
  }
  return plan;
}

export interface BackfillResult {
  created: number;
  skipped: ClaimPlanEntry[];
  ids: string[];
  plan: ClaimPlan;
}

/**
 * 按写作账**有界补登记**（幂等；走 `createDeliverable` 唯一建行写口，不另写 INSERT）。
 *
 * 归属仍**不夺**：工程内已有登记行的文件一律 `registered` 跳过（那是别人的归属）；
 * 只给"从来没被登记过"的文件建 `doc/draft` 行，`via` 由调用方给（收口/手动/回执各自可倒查）。
 */
export function registerClaimedArtifacts(
  db: Database.Database,
  o: { taskId: string; projectId?: string | null; via?: string; limit?: number },
): BackfillResult {
  const via = String(o.via ?? 'artifact_backfill');
  const plan = planClaimRegistrations(db, { taskId: o.taskId, projectId: o.projectId, limit: o.limit });
  const result: BackfillResult = { created: 0, skipped: [], ids: [], plan };
  if (!plan.projectId) return result;
  for (const raw of plan.candidates) {
    const name = path.basename(raw).replace(/\.\w+$/, '');
    const r = createDeliverable(db, {
      projectId: plan.projectId,
      taskId: o.taskId,
      name,
      type: 'doc',
      description: `文件: ${raw}`,
      filePath: raw,
      pathLabel: raw,
      via,
    });
    if (r.ok && r.created) {
      result.created += 1;
      result.ids.push(r.id);
    } else if (r.ok) {
      result.skipped.push({ path: raw, reason: 'registered' });
    } else {
      // createDeliverable 的拒绝面（doc_as_service / module_as_service）→ 如实归到"未建"
      result.skipped.push({ path: raw, reason: 'create_failed' });
    }
  }
  result.skipped.push(...plan.entries.filter((e) => e.reason !== 'ok'));
  return result;
}
