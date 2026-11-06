/**
 * zx_20261030_1 M6「荐」（大野耐一·现地现物 / 艾宾浩斯·遗忘曲线）: **项目知识增量水位**。
 *
 * 病根（§1.3 D7）：`consolidate-memories` 每小时对「最近 7 天活跃」的项目**全量重算**项目知识册——
 *   ① 停两周再回来的项目，知识书是旧的，且没有任何东西告诉用户它旧了；
 *   ② 每次全量派生，没有「读到哪」的水位，重跑成本恒为 O(全史)。
 *
 * 一处真源：
 *   · **水位**表 `wa_knowledge_watermarks(project_id PK, last_event_id, last_run_at, last_event_at)`；
 *   · **事件→项目**的归属**只在本文件的 `event_projects` CTE 推导**（`wa_event_log` **没有 project_id 列**，
 *     见下「归属推导」）；
 *   · **只前移**：`advanceWatermark` 用 `MAX(旧值, 新值)`，任何调用都不能把水位拉回去。
 *
 * 归属推导（`wa_event_log` 真列：id/event_type/aggregate_type/aggregate_id/payload/metadata/...）：
 *   按下列次序取**第一个非空**者，一处 `COALESCE` 定死，避免多路 join 把同一事件数两遍：
 *     ① `aggregate_type='project'` ⇒ `aggregate_id` 就是项目 id（项目自身事件）；
 *     ② `payload.projectId` / `payload.project_id`（事件总线各发射点都带 projectId）；
 *     ③ `metadata.project_id`（`logStepExecution` 等观测事件带它）；
 *     ④ `aggregate_type='task'` 且 `aggregate_id` 是本库任务 ⇒ 该任务的 `project_id`；
 *   ⚠ JSON 列用 `json_valid(...)` 先挡坏 JSON（`json_extract` 遇坏文本直接抛错，会把整轮巩固带崩）。
 *   ⚠ 推不出归属的事件**不计入任何项目**（不猜；宁可漏记，不可错记）。
 *
 * 边界（与 §2.6 一致）：
 *   · 增量吸收只做**确定性派生**（`deriveProjectKnowledge` + `distillKnowledgeCards`）——零 LLM；
 *   · 候选领域包由 `ensureAutoCandidateDomainPack` 落 `origin='auto_candidate'`，**永不自动启用**；
 *   · 本模块**零 electron**：rr 可用内存库直跑真实现；`now` 可注入仅供判据钉确定性。
 */
import { deriveProjectKnowledge, upsertProjectKnowledge } from './project-knowledge.js';
import type { ProjectKnowledgeEntry } from './project-knowledge.js';
import { ensureAutoCandidateDomainPack } from './domain-pack.js';

type WmDb = {
  prepare(sql: string): {
    all(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): { changes: number };
  };
};

/** 每轮最多吸收的项目数（有界，避免长尾拖慢一小时一次的巩固作业）。 */
export const ABSORB_MAX_PROJECTS_PER_RUN = 5;

/**
 * 「事件→项目」的唯一推导（CTE 文本）。**只由本文件引用**——别处不得再写一份 COALESCE。
 * 列：`event_id`（= `wa_event_log.id`，整数，用于和水位比大小）、`project_id`（可空）。
 */
const EVENT_PROJECTS_CTE = `
  WITH event_projects AS (
    SELECT e.id AS event_id,
           COALESCE(
             CASE WHEN e.aggregate_type = 'project' AND e.aggregate_id <> '' THEN e.aggregate_id END,
             CASE WHEN json_valid(e.payload) THEN NULLIF(json_extract(e.payload, '$.projectId'), '') END,
             CASE WHEN json_valid(e.payload) THEN NULLIF(json_extract(e.payload, '$.project_id'), '') END,
             CASE WHEN json_valid(e.metadata) THEN NULLIF(json_extract(e.metadata, '$.project_id'), '') END,
             CASE WHEN e.aggregate_type = 'task'
                  THEN (SELECT t.project_id FROM wa_tasks t WHERE t.id = e.aggregate_id AND t.project_id IS NOT NULL AND t.project_id <> '')
             END
           ) AS project_id
      FROM wa_event_log e
  )`;

export interface KnowledgeWatermark {
  projectId: string;
  lastEventId: number;
  lastRunAt: string;
  lastEventAt: string;
  /** 是否已有水位行（没有 = 首次，从全史起读）。 */
  exists: boolean;
}

/** 读水位（缺行 ⇒ 0，不伪造"已读到最新"）。 */
export function readWatermark(db: WmDb, projectId: string): KnowledgeWatermark {
  const pid = projectId || '';
  const row = pid
    ? db.prepare('SELECT last_event_id, last_run_at, last_event_at FROM wa_knowledge_watermarks WHERE project_id = ?').get(pid) as
      { last_event_id?: number; last_run_at?: string; last_event_at?: string } | undefined
    : undefined;
  return {
    projectId: pid,
    lastEventId: Number(row?.last_event_id ?? 0) || 0,
    lastRunAt: String(row?.last_run_at ?? ''),
    lastEventAt: String(row?.last_event_at ?? ''),
    exists: row != null,
  };
}

/** 本项目**最新**一条可归属事件（吸收目标 = 开工时的 max(id)，不是积压快照——处理期间新到的事件留下轮）。 */
export function latestProjectEvent(db: WmDb, projectId: string): { id: number; occurredAt: string } | null {
  const pid = projectId || '';
  if (!pid) return null;
  const row = db.prepare(
    `${EVENT_PROJECTS_CTE}
     SELECT event_id, (SELECT occurred_at FROM wa_event_log WHERE id = event_projects.event_id) AS occurred_at
       FROM event_projects
      WHERE project_id = ?
      ORDER BY event_id DESC
      LIMIT 1`,
  ).get(pid) as { event_id?: number; occurred_at?: string } | undefined;
  if (!row || row.event_id == null) return null;
  return { id: Number(row.event_id), occurredAt: String(row.occurred_at ?? '') };
}

/** 本项目尚未吸收的事件数（`wa_event_log.id > 水位`）。 */
export function unabsorbedCount(db: WmDb, projectId: string): number {
  const pid = projectId || '';
  if (!pid) return 0;
  const row = db.prepare(
    `${EVENT_PROJECTS_CTE}
     SELECT COUNT(*) AS n
       FROM event_projects ep
       LEFT JOIN wa_knowledge_watermarks w ON w.project_id = ep.project_id
      WHERE ep.project_id = ?
        AND ep.event_id > COALESCE(w.last_event_id, 0)`,
  ).get(pid) as { n?: number } | undefined;
  return Number(row?.n ?? 0) || 0;
}

/**
 * 本批**真正吸收**的事件数：`(旧水位, 本次水位]` 区间的可归属事件。
 * 不用 `unabsorbedCount`——处理期间新到的事件 id > 本次水位，不属于本批（下轮才吸收）。
 */
function countProjectEventsBetween(db: WmDb, projectId: string, afterId: number, upToId: number): number {
  const pid = projectId || '';
  if (!pid || upToId <= afterId) return 0;
  const row = db.prepare(
    `${EVENT_PROJECTS_CTE}
     SELECT COUNT(*) AS n
       FROM event_projects ep
      WHERE ep.project_id = ?
        AND ep.event_id > ?
        AND ep.event_id <= ?`,
  ).get(pid, afterId, upToId) as { n?: number } | undefined;
  return Number(row?.n ?? 0) || 0;
}

export interface ProjectBacklog {
  projectId: string;
  unabsorbed: number;
}

/**
 * 有未吸收事件的项目，**按未吸收数降序**（同数按 project_id 升序，确定性），最多 `limit` 个。
 * 只列**仍存在**的项目（已删项目的事件留在事件账里，不据此复活项目）。
 */
export function projectsWithUnabsorbedEvents(db: WmDb, limit: number = ABSORB_MAX_PROJECTS_PER_RUN): ProjectBacklog[] {
  const lim = Math.max(1, Math.floor(Number(limit) || ABSORB_MAX_PROJECTS_PER_RUN));
  const rows = db.prepare(
    `${EVENT_PROJECTS_CTE}
     SELECT ep.project_id AS project_id, COUNT(*) AS unabsorbed
       FROM event_projects ep
       JOIN wa_projects p ON p.id = ep.project_id
       LEFT JOIN wa_knowledge_watermarks w ON w.project_id = ep.project_id
      WHERE ep.event_id > COALESCE(w.last_event_id, 0)
      GROUP BY ep.project_id
      ORDER BY unabsorbed DESC, ep.project_id
      LIMIT ?`,
  ).all(lim) as Array<{ project_id?: string; unabsorbed?: number }>;
  return rows.map((r) => ({ projectId: String(r.project_id ?? ''), unabsorbed: Number(r.unabsorbed ?? 0) || 0 }));
}

/**
 * 前移水位（**只前移**；单条 UPSERT 即一个事务）。
 *   `last_event_id = MAX(旧, 新)`：并发/重放都不会把水位拉回去；
 *   `last_event_at` 只在水位真前移时更新；`last_run_at` 每次运行都更新（"上次试过"）。
 */
export function advanceWatermark(
  db: WmDb,
  projectId: string,
  eventId: number,
  opts: { eventAt?: string } = {},
): void {
  const pid = projectId || '';
  if (!pid) return;
  const next = Math.max(0, Math.floor(Number(eventId) || 0));
  db.prepare(
    `INSERT INTO wa_knowledge_watermarks (project_id, last_event_id, last_run_at, last_event_at)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(project_id) DO UPDATE SET
       last_event_at = CASE WHEN excluded.last_event_id > wa_knowledge_watermarks.last_event_id
                            THEN excluded.last_event_at ELSE wa_knowledge_watermarks.last_event_at END,
       last_event_id = MAX(wa_knowledge_watermarks.last_event_id, excluded.last_event_id),
       last_run_at = excluded.last_run_at`,
  ).run(pid, next, String(opts.eventAt ?? ''));
}

/**
 * 派生/落册的**接线**（应用层可注入）：水位模块只管「何时、推进到哪」，
 * 不区分派生实现；默认实现即生产真函数（IPC 与探针零配置直用），
 * 作业层显式注入同一对真函数，让「consolidate 真派生、真落册」可被静态钉住。
 */
export interface KnowledgeDerivation {
  derive(db: WmDb, projectId: string): ProjectKnowledgeEntry[];
  upsert(db: WmDb, projectId: string, entries: ProjectKnowledgeEntry[]): number;
}

const DEFAULT_DERIVATION: KnowledgeDerivation = {
  derive: (db, projectId) => deriveProjectKnowledge(db as never, projectId),
  upsert: (db, projectId, entries) => upsertProjectKnowledge(db as never, projectId, entries),
};

export interface AbsorbResult {
  projectId: string;
  /** 开工前水位。 */
  fromEventId: number;
  /** 本次吸收到的水位（无新事件时 = fromEventId）。 */
  toEventId: number;
  /** 本次吸收的事件数（`to - from` 范围内的可归属事件；无新事件 = 0）。 */
  absorbedEvents: number;
  /** 写入的知识册节数。 */
  sections: number;
  /** 本次是否新建/刷新了候选领域包。 */
  candidatePackId: string | null;
  candidateCreated: boolean;
  /** 候选包失败原因（知识册吸收成功仍照常推进水位；候选是次要产物）。 */
  candidateError: string;
}

export interface AbsorbOptions {
  /** 派生/落册接线（缺省 = 生产真函数）。 */
  derivation?: KnowledgeDerivation;
  /** 是否派生候选领域包（缺省 true；它只是"建议"，永不自动启用）。 */
  runCandidate?: boolean;
}

/**
 * 吸收一个项目的增量：派生知识册 → 建议候选包 → **最后**前移水位。
 *
 * 顺序即纪律：任何一步抛错 ⇒ 水位**不推进**（下次重跑仍从旧水位起，宁可重算，不可漏算）；
 *   唯一例外是候选包（次要产物）——它失败只记因，不拖累知识册与水位。
 * 知识卡蒸馏**不在此处**：它由调用方（consolidate 作业 / IPC）在吸收后按自己的口径计数
 *   （社区档 `distillKnowledgeCards` 内返 0，不算失败），避免一次增量把卡蒸馏两遍。
 */
export function absorbProjectIncrement(
  db: WmDb,
  projectId: string,
  opts: AbsorbOptions = {},
): AbsorbResult {
  const pid = projectId || '';
  const derivation = opts.derivation ?? DEFAULT_DERIVATION;
  const wm = readWatermark(db, pid);
  const latest = latestProjectEvent(db, pid);
  const out: AbsorbResult = {
    projectId: pid,
    fromEventId: wm.lastEventId,
    toEventId: wm.lastEventId,
    absorbedEvents: 0,
    sections: 0,
    candidatePackId: null,
    candidateCreated: false,
    candidateError: '',
  };
  if (!pid) return out;
  // 无任何可归属事件 ⇒ 只记"跑过"，不改水位（首次也不写 0 以外的值）。
  if (!latest) {
    advanceWatermark(db, pid, wm.lastEventId, { eventAt: wm.lastEventAt });
    return out;
  }
  // 已在最新 ⇒ 只记本次运行时刻。
  if (latest.id <= wm.lastEventId) {
    advanceWatermark(db, pid, wm.lastEventId, { eventAt: wm.lastEventAt });
    return out;
  }

  // ① 知识册（零 LLM，确定性派生）
  out.sections = derivation.upsert(db, pid, derivation.derive(db, pid));

  // ② 候选领域包（不挂 Pro 闸——它只是"建议"，启用仍走既有 apply 闸）
  if (opts.runCandidate !== false) {
    try {
      const c = ensureAutoCandidateDomainPack(db as unknown as Parameters<typeof ensureAutoCandidateDomainPack>[0], pid);
      if (c) {
        out.candidatePackId = c.id;
        out.candidateCreated = c.created;
      }
    } catch (e) {
      out.candidateError = (e as Error)?.message || String(e);
    }
  }

  // ③ 水位**最后**前移（吸收成功才推进）。吸收数按**可归属事件**数，不用 id 差值冒充；
  //   只数（旧水位, 本次水位]——处理期间新到的事件留下轮，不计入本批。
  out.absorbedEvents = countProjectEventsBetween(db, pid, wm.lastEventId, latest.id);
  out.toEventId = latest.id;
  advanceWatermark(db, pid, latest.id, { eventAt: latest.occurredAt });
  return out;
}
