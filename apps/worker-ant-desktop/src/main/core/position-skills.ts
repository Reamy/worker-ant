/**
 * zx_20261120_3 M4「积·技」：**岗位可调用技能**的单一真源（DDL + 读写 + 审批注册）。
 *
 * 与 `wa_positions.skills_json` 的分界：
 *   · 四段里的「技能」是**说明书**（注入到岗位块，供模型阅读）；
 *   · 本表的技能是**可调用**的（`list_skills` 可见、`skill` 可执行），按岗位收窄，审批后才注册。
 *
 * 三条纪律：
 *   ① 草案**永不自动批准**、永不自动注入；只有 `draft → approved` 后注册进 `skill-registry` 的岗位表。
 *   ② 只按岗位收窄——未指派岗位的任务看不到任何岗位技能（与今日逐字节一致）。
 *   ③ 本模块零 electron；rr 可直跑（`skill-registry` 只涉及 fs/os，不涉 Electron）。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getPosition, type PositionDb } from './positions.js';
import {
  POSITION_SKILL_DESCRIPTION_MAX,
  POSITION_SKILL_NAME_MAX,
  POSITION_SKILL_STATUSES,
  POSITION_SKILL_STEPS_MAX,
  POSITION_SKILL_STEP_MAX,
  type PositionSkill,
  type PositionSkillStatus,
} from './position-skill-meta.js';
import { registerPositionSkill, unregisterPositionSkill } from './skill-registry.js';

/** 表 DDL 单一真源：`database.ts` 与 rr 夹具同引这一份。 */
export const POSITION_SKILLS_DDL = `
  CREATE TABLE IF NOT EXISTS wa_position_skills (
    id TEXT PRIMARY KEY,
    position_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    steps_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft',
    source_lesson_id TEXT NOT NULL DEFAULT '',
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    approved_at TEXT,
    UNIQUE (position_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_wa_position_skills_pos_status ON wa_position_skills(position_id, status);
`;

export type PositionSkillResult =
  | { ok: true; skill: PositionSkill }
  | { ok: false; code: 'NOT_FOUND' | 'BAD_INPUT' | 'DUPLICATE' | 'BAD_STATE' | 'INTERNAL'; message: string };

function isStatus(v: unknown): v is PositionSkillStatus {
  return typeof v === 'string' && (POSITION_SKILL_STATUSES as readonly string[]).includes(v);
}

function rowToSkill(raw: Record<string, unknown>): PositionSkill {
  let steps: string[] = [];
  try {
    const parsed = JSON.parse(String(raw.steps_json ?? '[]'));
    if (Array.isArray(parsed)) steps = parsed.filter((s): s is string => typeof s === 'string');
  } catch { /* 坏 JSON ⇒ 空步骤（如实） */ }
  const status = isStatus(raw.status) ? raw.status : 'draft';
  return {
    id: String(raw.id ?? ''),
    positionId: String(raw.position_id ?? ''),
    name: String(raw.name ?? ''),
    description: String(raw.description ?? ''),
    steps,
    status,
    sourceLessonId: String(raw.source_lesson_id ?? ''),
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
    if (t.length > POSITION_SKILL_STEP_MAX) return { ok: false, message: `单步最多 ${POSITION_SKILL_STEP_MAX} 字` };
    steps.push(t);
  }
  if (steps.length === 0) return { ok: false, message: '至少要有一步' };
  if (steps.length > POSITION_SKILL_STEPS_MAX) return { ok: false, message: `步骤最多 ${POSITION_SKILL_STEPS_MAX} 条` };
  return { ok: true, steps };
}

export interface CreatePositionSkillInput {
  positionId: string;
  name: string;
  description?: string;
  steps: string[];
  sourceLessonId?: string;
}

/** 建草案（同岗位同名**任意状态**都算重复——改名或先删旧行）。 */
export function createPositionSkillDraft(db: PositionDb, input: CreatePositionSkillInput): PositionSkillResult {
  const positionId = String(input.positionId ?? '').trim();
  const name = String(input.name ?? '').trim();
  const description = String(input.description ?? '').trim();
  if (!positionId) return { ok: false, code: 'BAD_INPUT', message: '缺少岗位 id' };
  if (!name) return { ok: false, code: 'BAD_INPUT', message: '技能名不能为空' };
  if (name.length > POSITION_SKILL_NAME_MAX) return { ok: false, code: 'BAD_INPUT', message: `技能名最多 ${POSITION_SKILL_NAME_MAX} 字` };
  if (description.length > POSITION_SKILL_DESCRIPTION_MAX) {
    return { ok: false, code: 'BAD_INPUT', message: `说明最多 ${POSITION_SKILL_DESCRIPTION_MAX} 字` };
  }
  if (!getPosition(db, positionId)) return { ok: false, code: 'NOT_FOUND', message: '岗位不存在（可能已删除）' };
  const steps = sanitizeSteps(input.steps);
  if (!steps.ok) return { ok: false, code: 'BAD_INPUT', message: steps.message };
  const exists = db.prepare('SELECT 1 AS n FROM wa_position_skills WHERE position_id = ? AND name = ? LIMIT 1')
    .get(positionId, name) as { n?: number } | undefined;
  if (exists) return { ok: false, code: 'DUPLICATE', message: `该岗位已有同名技能「${name}」` };
  const id = `psk_${randomUUID().slice(0, 8)}`;
  try {
    db.prepare(
      `INSERT INTO wa_position_skills
         (id, position_id, name, description, steps_json, status, source_lesson_id)
       VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
    ).run(id, positionId, name, description, JSON.stringify(steps.steps), String(input.sourceLessonId ?? '').trim());
    const row = db.prepare('SELECT * FROM wa_position_skills WHERE id = ?').get(id) as Record<string, unknown>;
    return { ok: true, skill: rowToSkill(row) };
  } catch (e) {
    return { ok: false, code: 'INTERNAL', message: (e as Error)?.message || String(e) };
  }
}

export function listPositionSkills(db: PositionDb, positionId: string, status?: PositionSkillStatus): PositionSkill[] {
  const pid = String(positionId ?? '').trim();
  if (!pid) return [];
  try {
    const rows = status
      ? db.prepare('SELECT * FROM wa_position_skills WHERE position_id = ? AND status = ? ORDER BY created_at DESC').all(pid, status)
      : db.prepare('SELECT * FROM wa_position_skills WHERE position_id = ? ORDER BY created_at DESC').all(pid);
    return (rows as Array<Record<string, unknown>>).map(rowToSkill);
  } catch { return []; } // 旧库/裸夹具无此表 ⇒ 空（读不到不等于“没有技能”）
}

export function getPositionSkill(db: PositionDb, id: string): PositionSkill | null {
  const row = db.prepare('SELECT * FROM wa_position_skills WHERE id = ?').get(String(id ?? '').trim()) as Record<string, unknown> | undefined;
  return row ? rowToSkill(row) : null;
}

/** 审批：只允许 `draft → approved/rejected`；批准后注册进岗位作用域注册表。 */
export function decidePositionSkill(
  db: PositionDb,
  id: string,
  decision: 'approved' | 'rejected',
  nowIso = new Date().toISOString(),
): PositionSkillResult {
  const skill = getPositionSkill(db, id);
  if (!skill) return { ok: false, code: 'NOT_FOUND', message: '技能不存在（可能已删除）' };
  if (skill.status !== 'draft') return { ok: false, code: 'BAD_STATE', message: '只有待审批技能才能决定（已批准/已拒绝不回到草案）' };
  try {
    db.prepare('UPDATE wa_position_skills SET status = ?, approved_at = ?, updated_at = ? WHERE id = ?')
      .run(decision, decision === 'approved' ? nowIso : null, nowIso, skill.id);
    if (decision === 'approved') {
      registerPositionSkill(skill.positionId, {
        name: skill.name,
        description: skill.description,
        category: 'position',
        content: skill.steps.join('\n'),
      });
    } else {
      unregisterPositionSkill(skill.positionId, skill.name);
    }
    const after = getPositionSkill(db, skill.id);
    return after ? { ok: true, skill: after } : { ok: false, code: 'INTERNAL', message: '审批后读不回来' };
  } catch (e) {
    return { ok: false, code: 'INTERNAL', message: (e as Error)?.message || String(e) };
  }
}

/** 记一次真调用（`skill` 工具命中岗位技能后）；按 id 或 名称 都可。 */
export function recordPositionSkillUse(db: PositionDb, idOrName: { id?: string; positionId?: string; name?: string }, nowIso = new Date().toISOString()): boolean {
  try {
    if (idOrName.id) {
      const r = db.prepare('UPDATE wa_position_skills SET use_count = use_count + 1, last_used_at = ? WHERE id = ?').run(nowIso, idOrName.id);
      return (r.changes ?? 0) > 0;
    }
    if (idOrName.positionId && idOrName.name) {
      const r = db.prepare('UPDATE wa_position_skills SET use_count = use_count + 1, last_used_at = ? WHERE position_id = ? AND name = ?')
        .run(nowIso, idOrName.positionId, idOrName.name);
      return (r.changes ?? 0) > 0;
    }
    return false;
  } catch { return false; }
}

/** 启动加载：把所有 approved 技能注册进进程级岗位注册表。 */
export function loadApprovedPositionSkills(db: Database.Database): number {
  try {
    const rows = db.prepare("SELECT * FROM wa_position_skills WHERE status = 'approved'").all() as Array<Record<string, unknown>>;
    let n = 0;
    for (const r of rows) {
      const s = rowToSkill(r);
      registerPositionSkill(s.positionId, {
        name: s.name,
        description: s.description,
        category: 'position',
        content: s.steps.join('\n'),
      });
      n++;
    }
    return n;
  } catch { return 0; }
}

/** 注入块用：该岗位 approved 技能名（最多 40 个，足够覆盖上限；不读步骤正文）。 */
export function approvedPositionSkillNames(db: PositionDb, positionId: string): string[] {
  try {
    const rows = db.prepare("SELECT name FROM wa_position_skills WHERE position_id = ? AND status = 'approved' ORDER BY name LIMIT 40")
      .all(String(positionId ?? '').trim()) as Array<{ name?: unknown }>;
    return rows.map((r) => String(r.name ?? '')).filter(Boolean);
  } catch { return []; }
}
