/**
 * zx_20261021_3 批一（庄子·养生主「指穷于为薪，火传也，不知其尽也」）: **领域包**——
 *   把某个项目里**已经发生的事实**中可迁移的那几节（领域与术语 / 验收与失败 / 配方与样板）
 *   派生为一份**可携带、可共享、可撤回**的 JSON 资产。
 *
 * 与既有物的分工（不重抄、不冒充）：
 *   · `project-knowledge.ts` —— 本项目的**九节整册**（含 artifacts/index/runtime 等不可迁移项）；
 *     本模块**只取其中三节**，且直接调用同一个 `deriveProjectKnowledge`（派生只此一处）。
 *   · `getCrossProjectKnowledge` —— 隐式、自动、按相似任务的记忆 top-3；本包是**显式**资产：
 *     用户挑、用户启用、能共享、能撤回。"自动捡到的"与"亲手带走的"是两件事，两本账分开。
 *   · 团队共享库 —— 本包作为第四类 item 走**既有** `team_library` 闸（批三），不另立假闸。
 *
 * ⚠ **零 LLM / 零网络 / 零 electron**：rr 可拿内存库直跑真实现。
 * ⚠ **有界且诚实**：超过 `DOMAIN_PACK_MAX_CHARS` 时按 `recipes → criteria → domain` **整节丢弃**，
 *   绝不截半句；丢了哪几节写进 `omitted_sections`——"带走了什么"与"没带走什么"同样如实。
 * ⚠ **不携带 sourceRef**：那是本项目内部出处（可能含本机路径），跨机无意义且泄隐私；
 *   包里只留节内容 + 源项目**名字**。
 * ⚠ **导入 ≠ 启用**：`wa_domain_packs` 是资产，`wa_project_domain_packs` 是启用关系；
 *   共享库拉取只落资产，启用是用户在本机显式动作。
 */
import { deriveProjectKnowledge, PROJECT_KNOWLEDGE_SECTION_LABEL } from './project-knowledge.js';
import { proFeatureRefusal } from './pro-gate.js';
import { estimateTokensFromChars } from './token-estimate.js';

/** 可携带的三节——唯一定处（新增一节须穷举全部读取谓词）。 */
export const DOMAIN_PACK_SECTIONS = ['domain', 'criteria', 'recipes'] as const;
export type DomainPackSection = (typeof DOMAIN_PACK_SECTIONS)[number];

/** 节的人话名：直接取知识册标签（同一物不在两处起两个名）。 */
export const DOMAIN_PACK_SECTION_LABEL: Record<DomainPackSection, string> = {
  domain: PROJECT_KNOWLEDGE_SECTION_LABEL.domain,
  criteria: PROJECT_KNOWLEDGE_SECTION_LABEL.criteria,
  recipes: PROJECT_KNOWLEDGE_SECTION_LABEL.recipes,
};

/** 包格式版本（结构变更时递增；读取侧按版本决定能否认识）。 */
export const DOMAIN_PACK_VERSION = 1;
/** 整包体量上限（字符）。超界整节丢弃，不截字。 */
export const DOMAIN_PACK_MAX_CHARS = 16_000;
/** 超界时的丢弃次序（低价值/强项目相关者先走）：配方 → 验收 → 领域。 */
const DOMAIN_PACK_DROP_ORDER: readonly DomainPackSection[] = ['recipes', 'criteria', 'domain'];
/** 「领域包」注入段自身的 token 上界（唯一口径 `estimateTokensFromChars`）。 */
export const DOMAIN_PACK_INJECT_MAX_TOKENS = 400;
/** 名称/描述上界（防止一条超长标题把共享库列撑爆）。 */
export const DOMAIN_PACK_NAME_MAX = 120;
export const DOMAIN_PACK_DESC_MAX = 300;

export interface DomainPackSectionPayload {
  section: DomainPackSection;
  content: string;
}

export interface DomainPackPayload {
  version: number;
  name: string;
  description: string;
  sections: DomainPackSectionPayload[];
  source: { project_id: string; project_name: string };
  derived_at: string;
  /** 明确不用于训练（与知识导出的 `training:false` 同一承诺）。 */
  training: false;
  /** 超界被整节丢弃的节（空数组＝全带走了）。 */
  omitted_sections: DomainPackSection[];
}

/** 包来路（zx_20261030_1 M6）：用户主动生成/导入，或系统按项目知识建议的候选。 */
export type DomainPackOrigin = 'user' | 'auto_candidate';

export interface DomainPackRow {
  id: string;
  name: string;
  description: string;
  source_project_id: string | null;
  source_project_name: string;
  origin: DomainPackOrigin;
  /** 非空 = 用户已忽略该候选（只对 `auto_candidate` 有语义）。 */
  dismissed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppliedDomainPack {
  id: string;
  name: string;
  description: string;
  sections: DomainPackSectionPayload[];
  source_project_name: string;
  applied_at: string;
}

export interface DomainPackListRow extends DomainPackRow {
  applied: boolean;
  section_count: number;
  chars: number;
}

export interface DomainPackStats {
  injections: number;
  chars: number;
  completed: number;
  failed: number;
  packs: Array<{ pack_id: string; name: string; injections: number; chars: number; completed: number; failed: number }>;
}

/**
 * 窄面三法合一。**不可**写成 `ReadDb & WriteDb`：两个 `prepare` 重载相交时 TS 只取首个签名，
 *   返回值里就没有 `run`（实测 tsc 红）。故显式给出全集，读写共用一个窄接口。
 */
type ReadDb = { prepare(sql: string): { all(...args: unknown[]): unknown; get(...args: unknown[]): unknown } };
/** 只写窄面（与 `knowledge-export` 同形：不绑 better-sqlite3 类型，rr 可直接传内存库）。 */
type WriteDb = { prepare(sql: string): { run(...args: unknown[]): { changes: number } } };
type PackDb = { prepare(sql: string): { all(...args: unknown[]): unknown; get(...args: unknown[]): unknown; run(...args: unknown[]): { changes: number } } };

function newPackId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `dp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function clip(s: string, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
}

function projectNameOf(db: ReadDb, projectId: string): string {
  try {
    const row = db.prepare('SELECT name FROM wa_projects WHERE id = ?').get(projectId) as { name?: string } | undefined;
    return String(row?.name ?? '').trim();
  } catch {
    return '';
  }
}

/** 解析一段 pack_json——损坏即 `null`（调用方跳过该行，不伪造空包）。 */
export function parseDomainPackJson(raw: unknown): DomainPackPayload | null {
  try {
    const o = JSON.parse(String(raw ?? '')) as Partial<DomainPackPayload>;
    if (!o || typeof o !== 'object') return null;
    if (!Array.isArray(o.sections)) return null;
    const sections: DomainPackSectionPayload[] = [];
    for (const s of o.sections) {
      const sec = (s as { section?: unknown })?.section;
      const content = (s as { content?: unknown })?.content;
      if (typeof sec !== 'string' || !(DOMAIN_PACK_SECTIONS as readonly string[]).includes(sec)) continue;
      if (typeof content !== 'string' || !content.trim()) continue;
      sections.push({ section: sec as DomainPackSection, content });
    }
    return {
      version: Number(o.version) || 0,
      name: String(o.name ?? ''),
      description: String(o.description ?? ''),
      sections,
      source: {
        project_id: String(o.source?.project_id ?? ''),
        project_name: String(o.source?.project_name ?? ''),
      },
      derived_at: String(o.derived_at ?? ''),
      training: false,
      omitted_sections: Array.isArray(o.omitted_sections)
        ? o.omitted_sections.filter((s): s is DomainPackSection => (DOMAIN_PACK_SECTIONS as readonly string[]).includes(String(s)))
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * 从某项目派生一份领域包（只读）。空册 ⇒ `ok:false`（"没得带"是如实值，不伪造空包）。
 * `opts.now` 仅供判据钉确定性（生产不传）。
 */
export function deriveDomainPack(
  db: ReadDb,
  projectId: string,
  opts: { name?: string; description?: string; now?: string } = {},
): { ok: true; pack: DomainPackPayload } | { ok: false; reason: string } {
  const pid = String(projectId ?? '');
  if (!pid) return { ok: false, reason: '缺少项目 id' };
  const entries = deriveProjectKnowledge(db, pid);
  const picked = DOMAIN_PACK_SECTIONS
    .map((section) => {
      const e = entries.find((x) => x.section === section);
      return e && e.content.trim() ? { section, content: e.content } : null;
    })
    .filter((x): x is DomainPackSectionPayload => x !== null);
  if (picked.length === 0) {
    return { ok: false, reason: '本项目暂无可携带的领域知识（领域与术语 / 验收与失败 / 配方与样板均为空）' };
  }
  // 有界：整节丢弃（低价值者先走），绝不截字。
  let kept = [...picked];
  let total = kept.reduce((n, s) => n + s.content.length, 0);
  const omitted: DomainPackSection[] = [];
  for (const section of DOMAIN_PACK_DROP_ORDER) {
    if (total <= DOMAIN_PACK_MAX_CHARS) break;
    const idx = kept.findIndex((s) => s.section === section);
    if (idx < 0) continue;
    total -= kept[idx]!.content.length;
    kept = kept.filter((s) => s.section !== section);
    omitted.push(section);
  }
  if (kept.length === 0) {
    return { ok: false, reason: `领域知识超过 ${DOMAIN_PACK_MAX_CHARS} 字上限，整节丢弃后无可携带内容` };
  }
  const projectName = projectNameOf(db, pid);
  const name = clip(opts.name ?? '', DOMAIN_PACK_NAME_MAX) || clip(`${projectName || `项目 ${pid.slice(0, 8)}`} · 领域包`, DOMAIN_PACK_NAME_MAX);
  const description = clip(opts.description ?? '', DOMAIN_PACK_DESC_MAX)
    || `从「${projectName || pid.slice(0, 8)}」派生的可携带领域经验（术语约定 / 验收判据 / 配方样板）`;
  return {
    ok: true,
    pack: {
      version: DOMAIN_PACK_VERSION,
      name,
      description,
      sections: kept,
      source: { project_id: pid, project_name: projectName },
      derived_at: opts.now ?? new Date().toISOString(),
      training: false,
      omitted_sections: omitted,
    },
  };
}

/**
 * 落一份包资产（**不启用**）。返回包 id。`sourceProjectId` 为空串 ⇒ 存 NULL（导入包）。
 * `origin` 缺省 `user`；系统建议的候选必须显式传 `auto_candidate`（承 §2.6：候选**永不自动启用**）。
 */
export function insertDomainPack(
  db: PackDb,
  pack: DomainPackPayload,
  origin: DomainPackOrigin = 'user',
): string {
  const id = newPackId();
  const args = [
    id,
    clip(pack.name, DOMAIN_PACK_NAME_MAX),
    clip(pack.description, DOMAIN_PACK_DESC_MAX),
    JSON.stringify(pack),
    pack.source.project_id ? pack.source.project_id : null,
    pack.source.project_name || '',
  ] as const;
  if (hasOriginColumn(db)) {
    db.prepare(
      `INSERT INTO wa_domain_packs (id, name, description, pack_json, source_project_id, source_project_name, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(...args, origin);
  } else {
    // M6 之前的老表（旧夹具/未迁移库）没有 origin 列：按 `user` 落库。
    //   候选建议只在有该列时成立（见 `ensureAutoCandidateDomainPack`）——宁可没有建议，不改老表形状。
    db.prepare(
      `INSERT INTO wa_domain_packs (id, name, description, pack_json, source_project_id, source_project_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(...args);
  }
  return id;
}

/** 该库的 `wa_domain_packs` 是否已有 M6 的 `origin` 列（老库/旧夹具没有）。 */
function hasOriginColumn(db: PackDb): boolean {
  try {
    const cols = db.prepare('PRAGMA table_info(wa_domain_packs)').all() as Array<{ name?: unknown }>;
    return cols.some((c) => String(c?.name ?? '') === 'origin');
  } catch {
    return false;
  }
}

/**
 * 生成并落库（**挂 Pro 闸**）。闸先于任何读写——社区档不派生、不落库。
 */
export function createDomainPack(
  db: PackDb,
  projectId: string,
  opts: { name?: string; description?: string } = {},
): { ok: true; id: string; pack: DomainPackPayload } | { ok: false; code: string; reason: string } {
  const refusal = proFeatureRefusal(db, 'domain_pack');
  if (refusal) return { ok: false, code: 'FEATURE_REQUIRED', reason: refusal };
  const derived = deriveDomainPack(db, projectId, opts);
  if (!derived.ok) return { ok: false, code: 'NO_CONTENT', reason: derived.reason };
  const id = insertDomainPack(db, derived.pack);
  return { ok: true, id, pack: derived.pack };
}

/**
 * 系统建议的候选包（zx_20261030_1 M6）：**只生成/更新，不启用**。
 *
 * 去重键 = **来源项目**：同一项目只留一份候选（不再每次吸收都多一份包）。
 * 用户已「忽略」（`dismissed_at` 非空）⇒ 永远不再重复建议，也**不复活**已忽略行。
 *
 * ⚠ 本函数**不挂 Pro 闸**：它只产出"建议"，真正启用仍走 `applyDomainPack` 的 Pro 闸——
 *   社区档看到建议也装不上，与"闸只挡搬运"同一把尺。
 */
export function ensureAutoCandidateDomainPack(
  db: PackDb,
  projectId: string,
): { id: string; created: boolean } | null {
  const pid = projectId || '';
  if (!pid) return null;
  const derived = deriveDomainPack(db, pid);
  if (!derived.ok) return null;
  const existing = db.prepare(
    `SELECT id, dismissed_at FROM wa_domain_packs
      WHERE source_project_id = ? AND origin = 'auto_candidate'
      ORDER BY created_at, id LIMIT 1`,
  ).get(pid) as { id?: string; dismissed_at?: string | null } | undefined;
  if (existing?.id) {
    // 忽略过就尊重忽略：不刷新、不复活（"拒绝"是用户的表态，不是可以重提的缺口）。
    if (existing.dismissed_at) return null;
    db.prepare(
      `UPDATE wa_domain_packs
          SET name = ?, description = ?, pack_json = ?, updated_at = datetime('now')
        WHERE id = ?`,
    ).run(
      clip(derived.pack.name, DOMAIN_PACK_NAME_MAX),
      clip(derived.pack.description, DOMAIN_PACK_DESC_MAX),
      JSON.stringify(derived.pack),
      existing.id,
    );
    return { id: existing.id, created: false };
  }
  const id = insertDomainPack(db, derived.pack, 'auto_candidate');
  return { id, created: true };
}

/**
 * 给某项目看的候选包：未忽略、未启用、**不是从本项目派生**的 `auto_candidate` 资产。
 * 只展示，不注入；用户点「启用」才走 `applyDomainPack`（Pro 闸）。
 */
export function listSuggestedDomainPacks(
  db: ReadDb,
  projectId: string,
  limit: number = 5,
): DomainPackListRow[] {
  const pid = projectId || '';
  if (!pid) return [];
  const lim = Math.max(1, Math.floor(Number(limit) || 5));
  const rows = db.prepare(
    `SELECT p.id AS id, p.name AS name, p.description AS description,
            p.source_project_id AS source_project_id, p.source_project_name AS source_project_name,
            p.origin AS origin, p.dismissed_at AS dismissed_at,
            p.created_at AS created_at, p.updated_at AS updated_at, p.pack_json AS pack_json
       FROM wa_domain_packs p
       LEFT JOIN wa_project_domain_packs m ON m.pack_id = p.id AND m.project_id = ?
      WHERE p.origin = 'auto_candidate'
        AND p.dismissed_at IS NULL
        AND m.pack_id IS NULL
        AND (p.source_project_id IS NULL OR p.source_project_id <> ?)
      ORDER BY p.updated_at DESC, p.id
      LIMIT ?`,
  ).all(pid, pid, lim) as Array<DomainPackRow & { pack_json: string }>;
  return rows.map((r) => {
    const pack = parseDomainPackJson(r.pack_json);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      source_project_id: r.source_project_id,
      source_project_name: r.source_project_name,
      origin: r.origin === 'auto_candidate' ? 'auto_candidate' : 'user',
      dismissed_at: r.dismissed_at ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      applied: false,
      section_count: pack?.sections.length ?? 0,
      chars: pack ? pack.sections.reduce((n, s) => n + s.content.length, 0) : 0,
    };
  });
}

/** 忽略一条候选（只对 `auto_candidate` 生效；幂等）。返回是否真改了一行。 */
export function dismissAutoCandidateDomainPack(db: WriteDb, packId: string): boolean {
  const r = db.prepare(
    `UPDATE wa_domain_packs SET dismissed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND origin = 'auto_candidate' AND dismissed_at IS NULL`,
  ).run(packId || '');
  return r.changes > 0;
}

/** 列出包资产（可按项目标出是否已应用）。 */
export function listDomainPacks(db: ReadDb, projectId?: string): DomainPackListRow[] {
  const rows = db.prepare(
    'SELECT id, name, description, source_project_id, source_project_name, origin, dismissed_at, created_at, updated_at, pack_json FROM wa_domain_packs ORDER BY updated_at DESC, id',
  ).all() as Array<DomainPackRow & { pack_json: string }>;
  const applied = new Set<string>();
  if (projectId) {
    const ars = db.prepare('SELECT pack_id FROM wa_project_domain_packs WHERE project_id = ?').all(projectId) as Array<{ pack_id: string }>;
    for (const a of ars) applied.add(a.pack_id);
  }
  return rows.map((r) => {
    const pack = parseDomainPackJson(r.pack_json);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      source_project_id: r.source_project_id,
      source_project_name: r.source_project_name,
      origin: r.origin === 'auto_candidate' ? 'auto_candidate' : 'user',
      dismissed_at: r.dismissed_at ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      applied: applied.has(r.id),
      section_count: pack?.sections.length ?? 0,
      chars: pack ? pack.sections.reduce((n, s) => n + s.content.length, 0) : 0,
    };
  });
}

/**
 * 启用一份包（**挂 Pro 闸**）。幂等：已启用 ⇒ `applied:false`（不是错误，是"本来就在"）。
 * 包不存在 ⇒ 如实拒，不建悬空映射。
 */
export function applyDomainPack(
  db: PackDb,
  projectId: string,
  packId: string,
): { applied: boolean; reason?: 'already_applied' | 'no_such_pack' | 'no_such_project'; refusal?: string } {
  if (!projectId) return { applied: false, reason: 'no_such_project' };
  const refusal = proFeatureRefusal(db, 'domain_pack');
  if (refusal) return { applied: false, refusal };
  const exists = db.prepare('SELECT 1 AS ok FROM wa_domain_packs WHERE id = ?').get(packId) as { ok?: number } | undefined;
  if (!exists) return { applied: false, reason: 'no_such_pack' };
  const r = db.prepare(
    'INSERT OR IGNORE INTO wa_project_domain_packs (project_id, pack_id, applied_at) VALUES (?, ?, datetime(\'now\'))',
  ).run(projectId, packId);
  return r.changes > 0 ? { applied: true } : { applied: false, reason: 'already_applied' };
}

/** 取消启用——**永不挂闸**（用户必须随时能撤）。返回是否真删了一行。 */
export function unapplyDomainPack(db: WriteDb, projectId: string, packId: string): boolean {
  const r = db.prepare('DELETE FROM wa_project_domain_packs WHERE project_id = ? AND pack_id = ?').run(projectId, packId);
  return r.changes > 0;
}

/** 读某项目已启用的包（按启用时序；坏 JSON 跳过——不伪造空包）。 */
export function listAppliedDomainPacks(db: ReadDb, projectId: string): AppliedDomainPack[] {
  const rows = db.prepare(
    `SELECT p.id AS id, p.name AS name, p.description AS description, p.pack_json AS pack_json,
            p.source_project_name AS source_project_name, m.applied_at AS applied_at
       FROM wa_project_domain_packs m
       JOIN wa_domain_packs p ON p.id = m.pack_id
      WHERE m.project_id = ?
      ORDER BY m.applied_at, p.id`,
  ).all(projectId || '') as Array<{ id: string; name: string; description: string; pack_json: string; source_project_name: string; applied_at: string }>;
  const out: AppliedDomainPack[] = [];
  for (const r of rows) {
    const pack = parseDomainPackJson(r.pack_json);
    if (!pack || pack.sections.length === 0) continue;
    out.push({
      id: r.id,
      name: r.name,
      description: r.description,
      sections: pack.sections,
      source_project_name: r.source_project_name,
      applied_at: r.applied_at,
    });
  }
  return out;
}

/** 领域包的注入账（`source='domain_pack'`）——有写口就必须有读口，否则"记了没人看"。 */
export function domainPackInjectionStats(db: ReadDb, projectId: string): DomainPackStats {
  const agg = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(i.chars), 0) AS chars,
            SUM(CASE WHEN i.outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN i.outcome = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM wa_context_injections i
       JOIN wa_tasks t ON t.id = i.task_id
      WHERE i.source = 'domain_pack' AND t.project_id = ?`,
  ).get(projectId || '') as { n: number; chars: number; completed: number | null; failed: number | null } | undefined;
  const packs = db.prepare(
    `SELECT i.ref_id AS pack_id, COALESCE(p.name, '') AS name, COUNT(*) AS n, COALESCE(SUM(i.chars), 0) AS chars,
            SUM(CASE WHEN i.outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN i.outcome = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM wa_context_injections i
       JOIN wa_tasks t ON t.id = i.task_id
       LEFT JOIN wa_domain_packs p ON p.id = i.ref_id
      WHERE i.source = 'domain_pack' AND t.project_id = ?
      GROUP BY i.ref_id
      ORDER BY n DESC, i.ref_id`,
  ).all(projectId || '') as Array<{ pack_id: string; name: string; n: number; chars: number; completed: number | null; failed: number | null }>;
  return {
    injections: Number(agg?.n ?? 0),
    chars: Number(agg?.chars ?? 0),
    completed: Number(agg?.completed ?? 0),
    failed: Number(agg?.failed ?? 0),
    packs: packs.map((p) => ({
      pack_id: p.pack_id,
      name: p.name,
      injections: Number(p.n ?? 0),
      chars: Number(p.chars ?? 0),
      completed: Number(p.completed ?? 0),
      failed: Number(p.failed ?? 0),
    })),
  };
}

/**
 * 注入段渲染：整包取舍（塞不下整包跳过并**点名**），绝不截字。
 * 返回文本 + 逐包注入行（`ref_id` = 包 id；`chars` = 该包渲染块字数）。
 */
export function renderDomainPackSection(
  packs: ReadonlyArray<AppliedDomainPack>,
  tokenBudget: number = DOMAIN_PACK_INJECT_MAX_TOKENS,
): { text: string; injections: Array<{ ref_id: string; chars: number }> } {
  const blocks: Array<{ ref_id: string; text: string }> = [];
  const skipped: string[] = [];
  let used = 0;
  for (const p of packs) {
    const body = p.sections
      .map((s) => `### ${DOMAIN_PACK_SECTION_LABEL[s.section]}\n${s.content}`)
      .join('\n');
    const text = `### 领域包：${p.name}\n${body}`;
    const cost = estimateTokensFromChars(text.length);
    if (used + cost > tokenBudget) { skipped.push(p.name); continue; }
    used += cost;
    blocks.push({ ref_id: p.id, text });
  }
  if (blocks.length === 0) return { text: '', injections: [] };
  const note = skipped.length > 0 ? `\n（另有 ${skipped.length} 个领域包未注入：${skipped.join('、')}）` : '';
  return {
    text: `## 领域包\n${blocks.map((b) => b.text).join('\n')}${note}`,
    injections: blocks.map((b) => ({ ref_id: b.ref_id, chars: b.text.length })),
  };
}
