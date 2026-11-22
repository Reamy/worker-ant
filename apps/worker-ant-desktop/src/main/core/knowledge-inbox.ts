/**
 * zx_20261121_3 M1「用·账」（王阳明·知行合一 / 维特根斯坦·意义即用法 / 道德经·少则得）:
 *   **知识待办的单一读模型**——把「已经攒下来、但还没被人决定」的四类知识收进一处：
 *     ① 待审岗位经验（`wa_position_lessons.status='pending'`）
 *     ② 待批岗位技能草案（`wa_position_skills.status='draft'`）
 *     ③ 可启用候选领域包（`auto_candidate`，按项目聚合）
 *     ④ 待审自进化提案（`wa_self_evolve_proposals.status='pending'`）
 *
 * 三条纪律：
 *   1. **只读**：本模块不写库、不启用、不采纳——所有决定走既有写口（`positions:decideLesson` /
 *      `positions:skillDecide` / `packs:apply` / `admin.selfEvolveDecide`）。
 *   2. **读不到 ≠ 0**：每组独立 try/catch；表缺失/读取失败 ⇒ `status:'error'`，**不回落成「没有待办」**。
 *   3. **有界且计数不截断**：计数用 `COUNT(*)` 精确；展示每项最多 `limit` 条（默认 20，钳在 1..100）。
 *
 * 为何不新增表：四类数据本来就各有真源；再建一张「待办表」只会多一份会漂的镜像（承「一个用途一个词」）。
 *
 * ⚠ **零 electron / 零网络 / 零 LLM / 零 IO**：rr 可拿内存库直跑真实现。
 */
import { listSuggestedDomainPacks } from './domain-pack.js';
import { listProposals } from './self-evolve.js';
// zx_20261122_1 M4「自·见」：已生效规则提案的「批准前后同类拒绝频率」只读复盘。
import { ruleProposalImpact, type RuleProposalImpact } from './self-evolve-impact.js';

/** 本模块用到的库窄面（只读）——rr 传内存库即可跑真实现。 */
export interface InboxDb {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
}

/** 一组待办：成功（计数精确、条目有界）或如实失败。 */
export type InboxGroup<T> =
  | { status: 'ok'; count: number; items: T[] }
  | { status: 'error'; error: string };

export interface LessonItem {
  id: string;
  positionId: string;
  positionName: string;
  projectId: string;
  projectName: string;
  taskId: string;
  taskTitle: string;
  /** 全文（调用方自行截断展示；本模型不截断语义）。 */
  content: string;
  createdAt: string;
  reusable: boolean;
  origin: string;
  /** 本机验证过（`verified_at` 非空）。 */
  verified: boolean;
}

export interface SkillItem {
  id: string;
  positionId: string;
  positionName: string;
  name: string;
  description: string;
  /** 步骤摘要（只给前几步，篇幅有界）。 */
  stepsPreview: string;
  sourceLessonId: string;
  createdAt: string;
}

export interface PackProjectRef {
  id: string;
  name: string;
}

export interface PackItem {
  packId: string;
  name: string;
  sourceProjectId: string;
  sourceProjectName: string;
  updatedAt: string;
  /** 该包当前可启用的项目（已忽略的不出现；已启用的项目也已排除）。 */
  projects: PackProjectRef[];
  /** 内容预览（首节摘要，≤120 字）。 */
  sectionPreview: string;
}

export interface ProposalItem {
  id: string;
  kind: string;
  target: string;
  note: string;
  createdAt: string;
  /** 提案状态（pending / applied / rolled_back …）——界面据此说清「待批 / 已生效 / 已回滚」。 */
  status?: string;
  /** 已生效的 rule 提案：批准前后同类拒绝频率；不适用 ⇒ 缺席（不是 0）。 */
  impact?: RuleProposalImpact;
}

export interface KnowledgeInbox {
  lessons: InboxGroup<LessonItem>;
  skills: InboxGroup<SkillItem>;
  packs: InboxGroup<PackItem>;
  proposals: InboxGroup<ProposalItem>;
  /** 已生效/已回滚的 rule 提案（不是待办，但要能看「批准前后同类拒绝」）。 */
  rulesInEffect: InboxGroup<ProposalItem>;
}

export interface KnowledgeInboxOpts {
  /** 每项最多展示多少条；缺省 20，钳在 1..100。 */
  limit?: number;
}

export const KNOWLEDGE_INBOX_DEFAULT_LIMIT = 20;
export const KNOWLEDGE_INBOX_MAX_LIMIT = 100;
/** 候选包聚合时每个项目最多取多少条建议（有界；与展示上限无关）。 */
const PACK_SUGGEST_PER_PROJECT = 50;
/** 内容预览上限（字）。 */
const PREVIEW_CHARS = 120;

function clampLimit(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return KNOWLEDGE_INBOX_DEFAULT_LIMIT;
  return Math.min(KNOWLEDGE_INBOX_MAX_LIMIT, Math.max(1, n));
}

function errText(e: unknown): string {
  return (e as Error)?.message || String(e);
}

function okGroup<T>(count: number, items: T[]): InboxGroup<T> {
  return { status: 'ok', count, items };
}

function errGroup<T>(e: unknown): InboxGroup<T> {
  return { status: 'error', error: errText(e) };
}

function tableExists(db: InboxDb, name: string): boolean {
  try {
    const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
      | { ok?: number }
      | undefined;
    return Number(row?.ok) === 1;
  } catch {
    return false;
  }
}

function countOf(db: InboxDb, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { c?: unknown } | undefined;
  const n = Number(row?.c);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function preview(text: string): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= PREVIEW_CHARS) return t;
  return `${t.slice(0, PREVIEW_CHARS)}…`;
}

/* ── ① 待审岗位经验 ─────────────────────────────────────────── */

const LESSON_SELECT = `
  SELECT l.id AS id, l.position_id AS position_id, l.content AS content,
         l.created_at AS created_at, l.reusable AS reusable, l.origin AS origin,
         l.verified_at AS verified_at,
         COALESCE(p.name, l.position_id) AS position_name,
         l.project_id AS project_id, COALESCE(pr.name, '') AS project_name,
         l.task_id AS task_id, COALESCE(t.title, '') AS task_title
    FROM wa_position_lessons l
    LEFT JOIN wa_positions p ON p.id = l.position_id
    LEFT JOIN wa_projects pr ON pr.id = l.project_id
    LEFT JOIN wa_tasks t ON t.id = l.task_id`;

function mapLesson(r: Record<string, unknown>): LessonItem {
  return {
    id: String(r.id ?? ''),
    positionId: String(r.position_id ?? ''),
    positionName: String(r.position_name ?? ''),
    projectId: String(r.project_id ?? ''),
    projectName: String(r.project_name ?? ''),
    taskId: String(r.task_id ?? ''),
    taskTitle: String(r.task_title ?? ''),
    content: String(r.content ?? ''),
    createdAt: String(r.created_at ?? ''),
    reusable: Number(r.reusable) === 1,
    origin: String(r.origin ?? ''),
    verified: String(r.verified_at ?? '') !== '',
  };
}

function groupLessons(db: InboxDb, limit: number, where: string, params: unknown[]): InboxGroup<LessonItem> {
  if (!tableExists(db, 'wa_position_lessons')) return errGroup(new Error('缺少表 wa_position_lessons'));
  const count = countOf(db, `SELECT COUNT(*) AS c FROM wa_position_lessons l WHERE ${where}`, ...params);
  const rows = db.prepare(`${LESSON_SELECT} WHERE ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT ?`)
    .all(...params, limit) as Array<Record<string, unknown>>;
  return okGroup(count, rows.map(mapLesson));
}

/* ── ② 待批岗位技能草案 ─────────────────────────────────────── */

function groupSkills(db: InboxDb, limit: number): InboxGroup<SkillItem> {
  if (!tableExists(db, 'wa_position_skills')) return errGroup(new Error('缺少表 wa_position_skills'));
  const count = countOf(db, "SELECT COUNT(*) AS c FROM wa_position_skills WHERE status = 'draft'");
  const rows = db.prepare(
    `SELECT s.id AS id, s.position_id AS position_id, s.name AS name, s.description AS description,
            s.steps_json AS steps_json, s.source_lesson_id AS source_lesson_id, s.created_at AS created_at,
            COALESCE(p.name, s.position_id) AS position_name
       FROM wa_position_skills s
       LEFT JOIN wa_positions p ON p.id = s.position_id
      WHERE s.status = 'draft'
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ?`,
  ).all(limit) as Array<Record<string, unknown>>;
  return okGroup(
    count,
    rows.map((r) => ({
      id: String(r.id ?? ''),
      positionId: String(r.position_id ?? ''),
      positionName: String(r.position_name ?? ''),
      name: String(r.name ?? ''),
      description: String(r.description ?? ''),
      stepsPreview: stepsPreview(r.steps_json),
      sourceLessonId: String(r.source_lesson_id ?? ''),
      createdAt: String(r.created_at ?? ''),
    })),
  );
}

/** 步骤 JSON → 一句摘要（只取前 3 条；坏 JSON 如实给空，不猜）。 */
function stepsPreview(raw: unknown): string {
  try {
    const arr = JSON.parse(String(raw ?? '[]'));
    if (!Array.isArray(arr)) return '';
    return arr.slice(0, 3).map((x) => String(x)).filter(Boolean).join(' → ').slice(0, PREVIEW_CHARS);
  } catch {
    return '';
  }
}

/* ── ③ 可启用候选领域包（按项目聚合） ───────────────────────── */

function groupPacks(db: InboxDb, limit: number): InboxGroup<PackItem> {
  if (!tableExists(db, 'wa_projects') || !tableExists(db, 'wa_domain_packs') || !tableExists(db, 'wa_project_domain_packs')) {
    return errGroup(new Error('缺少项目/领域包相关表'));
  }
  const projects = db.prepare('SELECT id, name FROM wa_projects ORDER BY name ASC, id ASC').all() as Array<{
    id?: unknown;
    name?: unknown;
  }>;
  const byPack = new Map<string, PackItem>();
  for (const p of projects) {
    const pid = String(p.id ?? '');
    if (!pid) continue;
    const projectName = String(p.name ?? '');
    let rows: ReturnType<typeof listSuggestedDomainPacks>;
    try {
      rows = listSuggestedDomainPacks(
        db as unknown as Parameters<typeof listSuggestedDomainPacks>[0],
        pid,
        PACK_SUGGEST_PER_PROJECT,
      );
    } catch (e) {
      return errGroup(e);
    }
    for (const row of rows) {
      const cur = byPack.get(row.id);
      const ref = { id: pid, name: projectName };
      if (cur) {
        if (!cur.projects.some((x) => x.id === pid)) cur.projects.push(ref);
        continue;
      }
      const first = row.preview?.[0];
      byPack.set(row.id, {
        packId: row.id,
        name: row.name,
        sourceProjectId: String(row.source_project_id ?? ''),
        sourceProjectName: String(row.source_project_name ?? ''),
        updatedAt: String(row.updated_at ?? ''),
        projects: [ref],
        sectionPreview: first ? preview(`${first.label}：${first.snippet}`) : '',
      });
    }
  }
  const items = [...byPack.values()]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.packId.localeCompare(b.packId))
    .slice(0, limit);
  return okGroup(byPack.size, items);
}

/* ── ④ 待审自进化提案 ───────────────────────────────────────── */

function groupProposals(db: InboxDb, limit: number): InboxGroup<ProposalItem> {
  if (!tableExists(db, 'wa_self_evolve_proposals')) return errGroup(new Error('缺少表 wa_self_evolve_proposals'));
  const all = listProposals(db as unknown as Parameters<typeof listProposals>[0], 200);
  const pending = all.filter((p) => String(p.status ?? '') === 'pending');
  return okGroup(
    pending.length,
    pending.slice(0, limit).map((p) => {
      const impact = ruleProposalImpact(db as unknown as Parameters<typeof ruleProposalImpact>[0], p);
      return {
        id: String(p.id ?? ''),
        kind: String(p.kind ?? ''),
        target: String(p.target ?? ''),
        note: String(p.note ?? ''),
        createdAt: String(p.created_at ?? ''),
        status: 'pending',
        ...(impact ? { impact } : {}),
      };
    }),
  );
}

/** 已生效/已回滚的 rule 提案：给「影响复盘」一个上屏处（不是待办，不进待办计数）。 */
function groupRulesInEffect(db: InboxDb, limit: number): InboxGroup<ProposalItem> {
  if (!tableExists(db, 'wa_self_evolve_proposals')) return errGroup(new Error('缺少表 wa_self_evolve_proposals'));
  const all = listProposals(db as unknown as Parameters<typeof listProposals>[0], 200);
  const rows = all.filter((p) => String(p.kind ?? '') === 'rule' && (p.status === 'applied' || p.status === 'rolled_back'));
  return okGroup(
    rows.length,
    rows.slice(0, limit).map((p) => {
      const impact = ruleProposalImpact(db as unknown as Parameters<typeof ruleProposalImpact>[0], p);
      return {
        id: String(p.id ?? ''),
        kind: String(p.kind ?? ''),
        target: String(p.target ?? ''),
        note: String(p.note ?? ''),
        createdAt: String(p.created_at ?? ''),
        status: String(p.status ?? ''),
        ...(impact ? { impact } : {}),
      };
    }),
  );
}

/* ── 对外：全量四组 / 单任务 ─────────────────────────────────── */

/** 全量四组待办。每组独立读取；任何一组失败只影响该组。 */
export function buildKnowledgeInbox(db: InboxDb, opts: KnowledgeInboxOpts = {}): KnowledgeInbox {
  const limit = clampLimit(opts.limit);
  const safe = <T>(fn: () => InboxGroup<T>): InboxGroup<T> => {
    try { return fn(); } catch (e) { return errGroup<T>(e); }
  };
  return {
    lessons: safe(() => groupLessons(db, limit, "l.status = 'pending'", [])),
    skills: safe(() => groupSkills(db, limit)),
    packs: safe(() => groupPacks(db, limit)),
    proposals: safe(() => groupProposals(db, limit)),
    rulesInEffect: safe(() => groupRulesInEffect(db, limit)),
  };
}

/** 某任务自己的待审经验（任务详情就地决定用）。空 taskId ⇒ ok/0（没有任务就没有待办）。 */
export function pendingLessonsForTask(db: InboxDb, taskId: string, limit = KNOWLEDGE_INBOX_DEFAULT_LIMIT): InboxGroup<LessonItem> {
  const tid = String(taskId ?? '').trim();
  if (!tid) return okGroup(0, []);
  try {
    return groupLessons(db, clampLimit(limit), "l.status = 'pending' AND l.task_id = ?", [tid]);
  } catch (e) {
    return errGroup<LessonItem>(e);
  }
}
