/**
 * zx_20261121_1 M1「属·表」：**项目可调用技能**的单一真源（DDL + 读写 + 审批注册 + 提升为全局）。
 *
 * 病根（真库 2026-11-21）：`wa_skills` 15 行里 12 个 approved 全部带 `project_id`，而
 * `loadSkillsFromDb()` 启动时**不带 project 过滤**把它们逐条注册进进程级全局表 ⇒
 * 怡寿里的 `erp_data_init_safety` 出现在 A股任务的 `list_skills` 里。项目经验没有“主”。
 *
 * 三条纪律（与 `position-skills.ts` 同形）：
 *   ① 项目技能住**独立表** `wa_project_skills`，`(project_id,name)` 唯一；不同项目可同名；
 *   ② 草案永不自动批准；批准后才注册进 `skill-registry` 的**项目作用域**；
 *   ③ 跨项目复用必须由人显式“提升为全局”，且全局同名冲突即拒——不覆盖、不合并。
 *
 * ⚠ 存量迁移：旧 `wa_skills.project_id IS NOT NULL` 行迁入本表；复制逐行核对通过才删旧行；
 *   失败不删（M2 兜底按项目作用域只读注册），下一次启动重试。
 * ⚠ 本模块零 electron；rr 可直跑（`skill-registry` 只涉 fs/os，不涉 Electron）。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  PROJECT_SKILL_DESCRIPTION_MAX,
  PROJECT_SKILL_NAME_MAX,
  PROJECT_SKILL_STATUSES,
  PROJECT_SKILL_STEP_MAX,
  PROJECT_SKILL_STEPS_MAX,
  type ProjectSkill,
  type ProjectSkillStatus,
} from './project-skill-meta.js';
import { clearProjectSkills, registerProjectSkill, registerSkill, unregisterProjectSkill } from './skill-registry.js';

/** 表 DDL 单一真源：`database.ts` 与 rr 夹具同引这一份。 */
export const PROJECT_SKILLS_DDL = `
  CREATE TABLE IF NOT EXISTS wa_project_skills (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    steps_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft',
    source TEXT NOT NULL DEFAULT 'memory',
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    approved_at TEXT,
    UNIQUE (project_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_wa_project_skills_scope
    ON wa_project_skills(project_id, status);
`;

/** 窄面库接口（`prepare` 的 get/all/run 三种用法都出现）——与 `PositionDb` 同形。 */
export interface ProjectSkillDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): { changes?: number };
  };
}

export type ProjectSkillResult =
  | { ok: true; skill: ProjectSkill }
  | { ok: false; code: 'NOT_FOUND' | 'BAD_INPUT' | 'DUPLICATE' | 'BAD_STATE' | 'INTERNAL'; message: string };

function isStatus(v: unknown): v is ProjectSkillStatus {
  return typeof v === 'string' && (PROJECT_SKILL_STATUSES as readonly string[]).includes(v);
}

function rowToSkill(raw: Record<string, unknown>): ProjectSkill {
  let steps: string[] = [];
  try {
    const parsed = JSON.parse(String(raw.steps_json ?? '[]'));
    if (Array.isArray(parsed)) steps = parsed.filter((s): s is string => typeof s === 'string');
  } catch { /* 坏 JSON ⇒ 空步骤（如实） */ }
  return {
    id: String(raw.id ?? ''),
    projectId: String(raw.project_id ?? ''),
    name: String(raw.name ?? ''),
    description: String(raw.description ?? ''),
    steps,
    status: isStatus(raw.status) ? raw.status : 'draft',
    source: String(raw.source ?? 'memory'),
    useCount: Number(raw.use_count ?? 0) || 0,
    lastUsedAt: String(raw.last_used_at ?? ''),
    createdAt: String(raw.created_at ?? ''),
    updatedAt: String(raw.updated_at ?? ''),
    approvedAt: String(raw.approved_at ?? ''),
  };
}

function sanitizeSteps(raw: unknown): { ok: true; steps: string[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: '步骤必须是数组' };
  const steps: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') return { ok: false, message: '步骤的每一项必须是字符串' };
    const t = v.trim();
    if (!t) continue;
    if (t.length > PROJECT_SKILL_STEP_MAX) return { ok: false, message: `单步最多 ${PROJECT_SKILL_STEP_MAX} 字` };
    steps.push(t);
  }
  if (steps.length === 0) return { ok: false, message: '至少要有一步' };
  if (steps.length > PROJECT_SKILL_STEPS_MAX) return { ok: false, message: `步骤最多 ${PROJECT_SKILL_STEPS_MAX} 条` };
  return { ok: true, steps };
}

export interface CreateProjectSkillInput {
  projectId: string;
  name: string;
  description?: string;
  steps: string[];
  source?: string;
}

/** 建草案（同项目同名**任意状态**都算重复——改名或先删旧行）。 */
export function createProjectSkillDraft(db: ProjectSkillDb, input: CreateProjectSkillInput): ProjectSkillResult {
  const projectId = String(input.projectId ?? '').trim();
  const name = String(input.name ?? '').trim();
  const description = String(input.description ?? '').trim();
  if (!projectId) return { ok: false, code: 'BAD_INPUT', message: '缺少项目 id' };
  if (!name) return { ok: false, code: 'BAD_INPUT', message: '技能名不能为空' };
  if (name.length > PROJECT_SKILL_NAME_MAX) return { ok: false, code: 'BAD_INPUT', message: `技能名最多 ${PROJECT_SKILL_NAME_MAX} 字` };
  if (description.length > PROJECT_SKILL_DESCRIPTION_MAX) {
    return { ok: false, code: 'BAD_INPUT', message: `说明最多 ${PROJECT_SKILL_DESCRIPTION_MAX} 字` };
  }
  const steps = sanitizeSteps(input.steps);
  if (!steps.ok) return { ok: false, code: 'BAD_INPUT', message: steps.message };
  try {
    const proj = db.prepare('SELECT 1 AS n FROM wa_projects WHERE id = ? LIMIT 1').get(projectId) as { n?: number } | undefined;
    if (!proj) return { ok: false, code: 'NOT_FOUND', message: '项目不存在（可能已删除）' };
    const exists = db.prepare('SELECT 1 AS n FROM wa_project_skills WHERE project_id = ? AND name = ? LIMIT 1')
      .get(projectId, name) as { n?: number } | undefined;
    if (exists) return { ok: false, code: 'DUPLICATE', message: `该项目已有同名技能「${name}」` };
    const id = `prsk_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO wa_project_skills
         (id, project_id, name, description, steps_json, status, source)
       VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
    ).run(id, projectId, name, description, JSON.stringify(steps.steps), String(input.source ?? 'memory').trim() || 'memory');
    const row = db.prepare('SELECT * FROM wa_project_skills WHERE id = ?').get(id) as Record<string, unknown>;
    return { ok: true, skill: rowToSkill(row) };
  } catch (e) {
    return { ok: false, code: 'INTERNAL', message: (e as Error)?.message || String(e) };
  }
}

export function listProjectSkills(db: ProjectSkillDb, projectId: string, status?: ProjectSkillStatus): ProjectSkill[] {
  const pid = String(projectId ?? '').trim();
  if (!pid) return [];
  try {
    const rows = status
      ? db.prepare('SELECT * FROM wa_project_skills WHERE project_id = ? AND status = ? ORDER BY created_at DESC').all(pid, status)
      : db.prepare('SELECT * FROM wa_project_skills WHERE project_id = ? ORDER BY created_at DESC').all(pid);
    return (rows as Array<Record<string, unknown>>).map(rowToSkill);
  } catch { return []; } // 旧库/裸夹具无此表 ⇒ 空（读不到不等于“没有技能”）
}

export function getProjectSkill(db: ProjectSkillDb, id: string): ProjectSkill | null {
  const row = db.prepare('SELECT * FROM wa_project_skills WHERE id = ?').get(String(id ?? '').trim()) as Record<string, unknown> | undefined;
  return row ? rowToSkill(row) : null;
}

/** 审批：只允许 `draft → approved/rejected`；批准后注册进项目作用域注册表。 */
export function decideProjectSkill(
  db: ProjectSkillDb,
  id: string,
  decision: 'approved' | 'rejected',
  nowIso = new Date().toISOString(),
): ProjectSkillResult {
  const skill = getProjectSkill(db, id);
  if (!skill) return { ok: false, code: 'NOT_FOUND', message: '技能不存在（可能已删除）' };
  if (skill.status !== 'draft') return { ok: false, code: 'BAD_STATE', message: '只有待审批技能才能决定（已批准/已拒绝不回到草案）' };
  try {
    db.prepare('UPDATE wa_project_skills SET status = ?, approved_at = ?, updated_at = ? WHERE id = ?')
      .run(decision, decision === 'approved' ? nowIso : null, nowIso, skill.id);
    if (decision === 'approved') {
      registerProjectSkill(skill.projectId, {
        name: skill.name,
        description: skill.description,
        category: 'custom',
        content: skill.steps.join('\n'),
      });
    } else {
      unregisterProjectSkill(skill.projectId, skill.name);
    }
    const after = getProjectSkill(db, skill.id);
    return after ? { ok: true, skill: after } : { ok: false, code: 'INTERNAL', message: '审批后读不回来' };
  } catch (e) {
    return { ok: false, code: 'INTERNAL', message: (e as Error)?.message || String(e) };
  }
}

/** 记一次真调用（`skill` 工具命中项目技能后）；按 id 或 项目+名称 都可。 */
export function recordProjectSkillUse(
  db: ProjectSkillDb,
  key: { id?: string; projectId?: string; name?: string },
  nowIso = new Date().toISOString(),
): boolean {
  try {
    if (key.id) {
      const r = db.prepare('UPDATE wa_project_skills SET use_count = use_count + 1, last_used_at = ? WHERE id = ?').run(nowIso, key.id);
      return (r.changes ?? 0) > 0;
    }
    if (key.projectId && key.name) {
      const r = db.prepare('UPDATE wa_project_skills SET use_count = use_count + 1, last_used_at = ? WHERE project_id = ? AND name = ?')
        .run(nowIso, key.projectId, key.name);
      return (r.changes ?? 0) > 0;
    }
    return false;
  } catch { return false; }
}

/** 启动加载：把所有 approved 项目技能注册进进程级项目注册表（不碰全局表）。 */
export function loadApprovedProjectSkills(db: Database.Database): number {
  try {
    const rows = db.prepare("SELECT * FROM wa_project_skills WHERE status = 'approved'").all() as Array<Record<string, unknown>>;
    let n = 0;
    for (const r of rows) {
      const s = rowToSkill(r);
      registerProjectSkill(s.projectId, {
        name: s.name,
        description: s.description,
        category: 'custom',
        content: s.steps.join('\n'),
      });
      n++;
    }
    return n;
  } catch { return 0; }
}

/** 注入块/列表用：该项目 approved 技能名（最多 40 个；不读步骤正文）。 */
export function approvedProjectSkillNames(db: ProjectSkillDb, projectId: string): string[] {
  try {
    const rows = db.prepare("SELECT name FROM wa_project_skills WHERE project_id = ? AND status = 'approved' ORDER BY name LIMIT 40")
      .all(String(projectId ?? '').trim()) as Array<{ name?: unknown }>;
    return rows.map((r) => String(r.name ?? '')).filter(Boolean);
  } catch { return []; }
}

/**
 * 显式“提升为全局”：approved 项目技能 → `wa_skills` 全局行；成功后从项目表移除。
 * 全局同名（任意 project_id）即拒——不覆盖、不合并。
 */
export function promoteProjectSkillToGlobal(db: ProjectSkillDb, id: string): ProjectSkillResult {
  const skill = getProjectSkill(db, id);
  if (!skill) return { ok: false, code: 'NOT_FOUND', message: '技能不存在（可能已删除）' };
  if (skill.status !== 'approved') return { ok: false, code: 'BAD_STATE', message: '只有已批准的项目技能才能提升为全局' };
  try {
    const clash = db.prepare('SELECT id FROM wa_skills WHERE name = ? LIMIT 1').get(skill.name) as { id?: string } | undefined;
    if (clash) return { ok: false, code: 'DUPLICATE', message: `全局已有同名技能「${skill.name}」，请先改名或删除` };
    const gid = `gsk_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO wa_skills (id, name, description, category, config, status, project_id)
       VALUES (?, ?, ?, 'custom', ?, 'approved', NULL)`,
    ).run(gid, skill.name, skill.description, JSON.stringify({ instructions: skill.steps }));
    db.prepare('DELETE FROM wa_project_skills WHERE id = ?').run(skill.id);
    unregisterProjectSkill(skill.projectId, skill.name);
    registerSkill({ name: skill.name, description: skill.description, category: 'custom', content: skill.steps.join('\n') });
    const after = getProjectSkill(db, gid);
    return {
      ok: true,
      skill: {
        ...(after ?? skill),
        id: gid,
        projectId: '',
        status: 'approved',
        source: 'global',
      },
    };
  } catch (e) {
    return { ok: false, code: 'INTERNAL', message: (e as Error)?.message || String(e) };
  }
}

export interface ProjectSkillMigrationResult {
  /** 旧表中带 project_id 的行数（本次处理的候选）。 */
  legacy: number;
  /** 本次实际写入新表的行数（`INSERT OR IGNORE` 后仍以“新表存在”为准，见下）。 */
  migrated: number;
  /** 是否删除了旧行。 */
  deleted: boolean;
  /** 未能迁入的旧行数（核对失败时 > 0，旧行保留）。 */
  left: number;
}

/**
 * 存量迁移：`wa_skills WHERE project_id IS NOT NULL` → `wa_project_skills`。
 * 逐行 `INSERT OR IGNORE`，再**逐行核对新表存在**；全部存在才删旧行。
 * 幂等：第二次旧表为空 ⇒ 全 0。
 */
export function migrateLegacyProjectSkills(db: Database.Database): ProjectSkillMigrationResult {
  const empty: ProjectSkillMigrationResult = { legacy: 0, migrated: 0, deleted: false, left: 0 };
  try {
    const legacyRows = db.prepare(
      "SELECT id, project_id, name, description, config, status, created_at, updated_at FROM wa_skills WHERE project_id IS NOT NULL AND TRIM(project_id) <> ''",
    ).all() as Array<Record<string, unknown>>;
    if (legacyRows.length === 0) return empty;

    const insert = db.prepare(
      `INSERT OR IGNORE INTO wa_project_skills
         (id, project_id, name, description, steps_json, status, source, created_at, updated_at, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, 'legacy', COALESCE(?, datetime('now')), COALESCE(?, datetime('now')), ?)`,
    );
    let migrated = 0;
    for (const row of legacyRows) {
      const id = String(row.id ?? '').trim() || `prsk_${randomUUID().slice(0, 8)}`;
      let instructions: string[] = [];
      try {
        const cfg = JSON.parse(String(row.config ?? '{}')) as { instructions?: unknown };
        if (Array.isArray(cfg.instructions)) instructions = cfg.instructions.filter((s): s is string => typeof s === 'string');
      } catch { /* 坏 JSON ⇒ 空步骤，仍迁入（source=legacy 可辨） */ }
      const status = isStatus(row.status) ? row.status : 'draft';
      const r = insert.run(
        id,
        String(row.project_id ?? ''),
        String(row.name ?? ''),
        String(row.description ?? ''),
        JSON.stringify(instructions),
        status,
        row.created_at == null ? null : String(row.created_at),
        row.updated_at == null ? null : String(row.updated_at),
        status === 'approved' ? new Date().toISOString() : null,
      );
      migrated += r.changes ?? 0;
    }

    // 逐行核对：旧表每一行都能在新表按 (project_id,name) 找到，才允许删旧行。
    let left = 0;
    for (const row of legacyRows) {
      const found = db.prepare('SELECT 1 AS n FROM wa_project_skills WHERE project_id = ? AND name = ? LIMIT 1')
        .get(String(row.project_id ?? ''), String(row.name ?? '')) as { n?: number } | undefined;
      if (!found) left++;
    }
    let deleted = false;
    if (left === 0) {
      db.prepare("DELETE FROM wa_skills WHERE project_id IS NOT NULL AND TRIM(project_id) <> ''").run();
      deleted = true;
    }
    return { legacy: legacyRows.length, migrated, deleted, left };
  } catch {
    return empty;
  }
}

// ==================== 与既有 MemoryManager 的薄兼容层（本文件持实现，管理器只留一行）====================

export interface ProjectSkillDraftRow {
  id: string;
  name: string;
  description: string;
  steps: string[];
  projectId: string;
  projectName: string;
}

/** `MemoryManager.storeSkillDraft` 的兼容入口：同项目同名返回已有 id；坏输入抛错。 */
export function storeProjectSkillDraftCompat(
  db: Database.Database,
  projectId: string,
  skill: { name: string; description: string; steps: string[] },
): string {
  const existing = listProjectSkills(db as never, projectId).find((s) => s.name === skill.name);
  if (existing) return existing.id;
  const r = createProjectSkillDraft(db as never, {
    projectId,
    name: skill.name,
    description: skill.description,
    steps: skill.steps,
    source: 'memory',
  });
  if (!r.ok) throw new Error(r.message);
  return r.skill.id;
}

/** `MemoryManager.listSkillDrafts` 的兼容入口（`projectId` 空 ⇒ 跨项目）。 */
export function listProjectSkillDraftsCompat(
  db: Database.Database,
  projectId?: string,
  limit = 20,
): ProjectSkillDraftRow[] {
  try {
    migrateLegacyProjectSkills(db);
    const rows = projectId
      ? db.prepare(
          "SELECT s.id, s.name, s.description, s.steps_json, s.project_id, COALESCE(p.name,'') AS project_name FROM wa_project_skills s LEFT JOIN wa_projects p ON p.id = s.project_id WHERE s.project_id = ? AND s.status = 'draft' ORDER BY s.created_at DESC LIMIT ?",
        ).all(projectId, limit)
      : db.prepare(
          "SELECT s.id, s.name, s.description, s.steps_json, s.project_id, COALESCE(p.name,'') AS project_name FROM wa_project_skills s LEFT JOIN wa_projects p ON p.id = s.project_id WHERE s.status = 'draft' ORDER BY s.created_at DESC LIMIT ?",
        ).all(limit);
    return (rows as Array<Record<string, unknown>>).map((r) => {
      let steps: string[] = [];
      try {
        const parsed = JSON.parse(String(r.steps_json ?? '[]'));
        if (Array.isArray(parsed)) steps = parsed.filter((s): s is string => typeof s === 'string');
      } catch { /* 坏 JSON ⇒ 空步骤（如实） */ }
      return {
        id: String(r.id ?? ''),
        name: String(r.name ?? ''),
        description: String(r.description ?? ''),
        steps,
        projectId: String(r.project_id ?? ''),
        projectName: String(r.project_name ?? ''),
      };
    });
  } catch { return []; }
}

export function approveProjectSkillCompat(
  db: Database.Database,
  draftId: string,
): { name: string; scope: 'project'; projectId: string } | null {
  migrateLegacyProjectSkills(db);
  const r = decideProjectSkill(db as never, draftId, 'approved');
  return r.ok ? { name: r.skill.name, scope: 'project', projectId: r.skill.projectId } : null;
}

export function rejectProjectSkillCompat(db: Database.Database, draftId: string): boolean {
  migrateLegacyProjectSkills(db);
  return decideProjectSkill(db as never, draftId, 'rejected').ok;
}

/**
 * `MemoryManager.loadSkillsFromDb` 的兼容入口：
 * 全局表 `project_id` 为空的 approved → 全局；项目表 approved → 项目作用域；
 * 迁移未完成的旧行 → 只进项目作用域（不冒充全局）。
 */
export function loadSkillsFromDbCompat(db: Database.Database): number {
  try {
    clearProjectSkills();
    let loaded = 0;
    const globals = db.prepare(
      "SELECT name, description, config FROM wa_skills WHERE status = 'approved' AND (project_id IS NULL OR TRIM(project_id) = '')",
    ).all() as Array<{ name: string; description: string; config: string }>;
    for (const r of globals) {
      let instructions = '';
      try { instructions = ((JSON.parse(r.config || '{}') as { instructions?: string[] }).instructions || []).join('\n'); } catch { /* ignore */ }
      registerSkill({ name: r.name, description: r.description, category: 'custom', content: instructions });
      loaded++;
    }
    loaded += loadApprovedProjectSkills(db);
    const legacy = db.prepare(
      "SELECT name, description, config, project_id FROM wa_skills WHERE status = 'approved' AND project_id IS NOT NULL AND TRIM(project_id) <> ''",
    ).all() as Array<{ name: string; description: string; config: string; project_id: string }>;
    for (const r of legacy) {
      let instructions = '';
      try { instructions = ((JSON.parse(r.config || '{}') as { instructions?: string[] }).instructions || []).join('\n'); } catch { /* ignore */ }
      registerProjectSkill(r.project_id, { name: r.name, description: r.description, category: 'custom', content: instructions });
      loaded++;
    }
    return loaded;
  } catch { return 0; }
}
