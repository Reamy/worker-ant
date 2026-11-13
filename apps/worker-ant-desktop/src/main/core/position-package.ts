/**
 * zx_20261113_1 B6「商」：**岗位知识包**的导出 / 整包校验 / 导入（跨机搬运经验）。
 *
 * 边界（与「项目知识包」同一把尺）：
 *   · 只搬**岗位四段 + 已采纳经验**；搬运是人工文件动作，不是自动同步；
 *   · 导入的经验一律 `pending` + `origin='imported'`，**永不自动采纳**（人工确认后才注入）；
 *   · 整包先校验，坏包**零写入**；导入回执落 `wa_position_imports`。
 *
 * 本模块零 electron / 零网络（node:crypto 仅用于内容哈希），rr 可用 node:sqlite 直跑。
 */
import { createHash } from 'node:crypto';
import {
  POSITION_CATEGORY_MAX,
  POSITION_DESCRIPTION_MAX,
  POSITION_ITEM_MAX,
  POSITION_LESSON_MAX,
  POSITION_LIST_MAX,
  POSITION_LESSON_SOURCES,
  POSITION_NAME_MAX,
  createPosition,
  getPosition,
  getPositionByName,
  insertPositionLessonCandidate,
  updatePosition,
  type Position,
  type PositionDb,
} from './positions.js';

export const POSITION_PACKAGE_KIND = 'worker-ant-position';
export const POSITION_PACKAGE_VERSION = 1;
export const POSITION_PACKAGE_MAX_LESSONS = 100;
export const POSITION_IMPORT_MODES = ['merge', 'replace'] as const;
export type PositionImportMode = (typeof POSITION_IMPORT_MODES)[number];

export interface PositionPackageLesson {
  content: string;
  source: string;
  reusable: boolean;
}

export interface PositionPackageData {
  name: string;
  category: string;
  description: string;
  rules: string[];
  skills: string[];
  knowledge: string[];
}

export interface PositionPackage {
  kind: typeof POSITION_PACKAGE_KIND;
  version: typeof POSITION_PACKAGE_VERSION;
  exportedAt: string;
  position: PositionPackageData;
  lessons: PositionPackageLesson[];
}

export type PackageResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

function ok<T>(value: T): PackageResult<T> {
  return { ok: true, value };
}
function bad(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

/** 稳定内容哈希（导入行 `task_id` 用；同一段经验重复导入命中同一行）。 */
export function positionLessonImportKey(content: string): string {
  return `imported:${createHash('sha256').update(content).digest('hex').slice(0, 16)}`;
}

export function positionPackageFileName(name: string, now = new Date()): string {
  const safe = String(name ?? '').trim().replace(/[^\w一-龥.-]+/g, '_').slice(0, 60) || 'position';
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `岗位-${safe}-${day}.json`;
}

/**
 * 导出：读岗位 + 已采纳经验（含 reusable 标记；不可迁移的也导出，但导入后仍不可注入）。
 * 回执给 IPC 用来写文件；本函数不碰文件系统。
 */
export function buildPositionPackage(
  db: PositionDb,
  positionId: string,
  nowIso = new Date().toISOString(),
): PackageResult<{ package: PositionPackage; fileName: string }> {
  const position = getPosition(db, String(positionId ?? '').trim());
  if (!position) return bad('NOT_FOUND', '岗位不存在（可能已删除）');
  const rows = db
    .prepare(
      `SELECT content, source, reusable FROM wa_position_lessons
        WHERE position_id = ? AND status = 'accepted'
        ORDER BY COALESCE(decided_at, created_at) DESC
        LIMIT ?`,
    )
    .all(position.id, POSITION_PACKAGE_MAX_LESSONS) as Array<Record<string, unknown>>;
  const pkg: PositionPackage = {
    kind: POSITION_PACKAGE_KIND,
    version: POSITION_PACKAGE_VERSION,
    exportedAt: nowIso,
    position: {
      name: position.name,
      category: position.category,
      description: position.description,
      rules: [...position.rules],
      skills: [...position.skills],
      knowledge: [...position.knowledge],
    },
    lessons: rows.map((r) => ({
      content: String(r.content ?? '').trim().slice(0, POSITION_LESSON_MAX),
      source: normalizeSource(String(r.source ?? 'summary')),
      reusable: Number(r.reusable) === 1,
    })).filter((l) => l.content !== ''),
  };
  return ok({ package: pkg, fileName: positionPackageFileName(position.name, new Date(nowIso)) });
}

function normalizeSource(raw: string): string {
  if (raw === 'task_close') return 'summary';
  return (POSITION_LESSON_SOURCES as readonly string[]).includes(raw) ? raw : 'summary';
}

function stringList(raw: unknown, maxItems: number, maxLen: number, label: string): PackageResult<string[]> {
  if (!Array.isArray(raw)) return bad('BAD_SHAPE', `${label} 必须是数组`);
  if (raw.length > maxItems) return bad('TOO_MANY', `${label} 最多 ${maxItems} 条`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') return bad('BAD_SHAPE', `${label} 的每一项必须是字符串`);
    const t = v.trim();
    if (!t) continue;
    if (t.length > maxLen) return bad('ITEM_TOO_LONG', `${label} 单条最多 ${maxLen} 字`);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return ok(out);
}

/**
 * 整包校验：坏包返回具名错误，调用方据此**零写入**。
 * 校验项与 `sanitizePosition` 同源（名称/分类/说明/四段的长度与条数），不另立一套宽松口径。
 */
export function parsePositionPackage(text: string): PackageResult<PositionPackage> {
  let raw: unknown;
  try {
    raw = JSON.parse(String(text ?? ''));
  } catch {
    return bad('BAD_JSON', '不是合法 JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('BAD_SHAPE', '知识包必须是对象');
  const o = raw as Record<string, unknown>;
  if (o.kind !== POSITION_PACKAGE_KIND) return bad('BAD_KIND', `不是岗位知识包（kind=${String(o.kind ?? '')}）`);
  if (o.version !== POSITION_PACKAGE_VERSION) return bad('BAD_VERSION', `版本不支持（${String(o.version ?? '')}）`);
  const p = o.position;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return bad('BAD_SHAPE', '缺少 position');
  const po = p as Record<string, unknown>;
  if (typeof po.name !== 'string' || !po.name.trim()) return bad('BAD_SHAPE', '岗位名称不能为空');
  if (po.name.trim().length > POSITION_NAME_MAX) return bad('NAME_TOO_LONG', `岗位名称最多 ${POSITION_NAME_MAX} 字`);
  if (typeof po.category === 'string' && po.category.trim().length > POSITION_CATEGORY_MAX) {
    return bad('CATEGORY_TOO_LONG', `分类最多 ${POSITION_CATEGORY_MAX} 字`);
  }
  if (typeof po.description === 'string' && po.description.trim().length > POSITION_DESCRIPTION_MAX) {
    return bad('DESCRIPTION_TOO_LONG', `说明最多 ${POSITION_DESCRIPTION_MAX} 字`);
  }
  const rules = stringList(po.rules ?? [], POSITION_LIST_MAX, POSITION_ITEM_MAX, '规范');
  if (!rules.ok) return rules;
  const skills = stringList(po.skills ?? [], POSITION_LIST_MAX, POSITION_ITEM_MAX, '技能');
  if (!skills.ok) return skills;
  const knowledge = stringList(po.knowledge ?? [], POSITION_LIST_MAX, POSITION_ITEM_MAX, '知识');
  if (!knowledge.ok) return knowledge;

  const rawLessons = o.lessons ?? [];
  if (!Array.isArray(rawLessons)) return bad('BAD_SHAPE', 'lessons 必须是数组');
  if (rawLessons.length > POSITION_PACKAGE_MAX_LESSONS) {
    return bad('TOO_MANY', `经验最多 ${POSITION_PACKAGE_MAX_LESSONS} 条`);
  }
  const lessons: PositionPackageLesson[] = [];
  const seen = new Set<string>();
  for (const item of rawLessons) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return bad('BAD_SHAPE', '经验条目必须是对象');
    const lo = item as Record<string, unknown>;
    const content = typeof lo.content === 'string' ? lo.content.trim() : '';
    if (!content) return bad('BAD_SHAPE', '经验内容不能为空');
    if (content.length > POSITION_LESSON_MAX) return bad('LESSON_TOO_LONG', `经验最多 ${POSITION_LESSON_MAX} 字`);
    if (seen.has(content)) return bad('DUPLICATE_LESSON', '知识包里同一句经验出现了两次');
    seen.add(content);
    lessons.push({
      content,
      source: normalizeSource(typeof lo.source === 'string' ? lo.source : 'imported'),
      reusable: lo.reusable === true,
    });
  }

  return ok({
    kind: POSITION_PACKAGE_KIND,
    version: POSITION_PACKAGE_VERSION,
    exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : '',
    position: {
      name: po.name.trim(),
      category: typeof po.category === 'string' ? po.category.trim() : 'custom',
      description: typeof po.description === 'string' ? po.description.trim() : '',
      rules: rules.value,
      skills: skills.value,
      knowledge: knowledge.value,
    },
    lessons,
  });
}

export interface PositionImportResult {
  position: Position;
  created: boolean;
  mode: PositionImportMode;
  addedSections: number;
  addedLessons: number;
  skippedLessons: number;
}

function mergeSection(existing: string[], incoming: string[]): { items: string[]; added: number } {
  const out = [...existing];
  let added = 0;
  for (const item of incoming) {
    const t = item.trim();
    if (!t || out.some((s) => s.trim() === t)) continue;
    if (out.length >= POSITION_LIST_MAX) break;
    out.push(t);
    added++;
  }
  return { items: out, added };
}

/**
 * 导入：整包已过 `parsePositionPackage`；本函数只做写入。
 *   · `merge`（默认）：同名岗位只补缺失条目/经验，不覆盖本机已有内容；
 *   · `replace`：同名岗位覆盖四段（**必须显式**），经验仍只追加候选、不删本机经验。
 * 事务包裹：要么整包写入，要么零写入（配合前面的整包校验）。
 */
export function importPositionPackage(
  db: PositionDb,
  pkg: PositionPackage,
  mode: PositionImportMode = 'merge',
  fileName = '',
  nowIso = new Date().toISOString(),
): PackageResult<PositionImportResult> {
  if (!POSITION_IMPORT_MODES.includes(mode)) return bad('BAD_MODE', '导入模式只能是 merge / replace');
  const existing = getPositionByName(db, pkg.position.name);
  let addedSections = 0;
  let addedLessons = 0;
  let skippedLessons = 0;
  let position: Position | null = null;
  let created = false;

  try {
    db.exec('BEGIN');
    if (!existing) {
      const r = createPosition(db, pkg.position, nowIso);
      if (!r.ok) { db.exec('ROLLBACK'); return bad(r.code, r.message); }
      position = r.position;
      created = true;
      addedSections = pkg.position.rules.length + pkg.position.skills.length + pkg.position.knowledge.length;
    } else if (mode === 'replace') {
      const r = updatePosition(db, existing.id, pkg.position, nowIso);
      if (!r.ok) { db.exec('ROLLBACK'); return bad(r.code, r.message); }
      position = r.position;
      addedSections = pkg.position.rules.length + pkg.position.skills.length + pkg.position.knowledge.length;
    } else {
      const rules = mergeSection(existing.rules, pkg.position.rules);
      const skills = mergeSection(existing.skills, pkg.position.skills);
      const knowledge = mergeSection(existing.knowledge, pkg.position.knowledge);
      addedSections = rules.added + skills.added + knowledge.added;
      if (addedSections > 0) {
        const r = updatePosition(db, existing.id, {
          name: existing.name,
          category: existing.category,
          description: existing.description || pkg.position.description,
          rules: rules.items,
          skills: skills.items,
          knowledge: knowledge.items,
          enabled: existing.enabled,
        }, nowIso);
        if (!r.ok) { db.exec('ROLLBACK'); return bad(r.code, r.message); }
        position = r.position;
      } else {
        position = existing;
      }
    }
    if (!position) { db.exec('ROLLBACK'); return bad('INTERNAL', '导入后岗位读不回来'); }

    for (const lesson of pkg.lessons) {
      const exists = db
        .prepare('SELECT 1 AS n FROM wa_position_lessons WHERE position_id = ? AND content = ? LIMIT 1')
        .get(position.id, lesson.content) as { n?: number } | undefined;
      if (exists) { skippedLessons++; continue; }
      const wrote = insertPositionLessonCandidate(db, {
        positionId: position.id,
        taskId: positionLessonImportKey(lesson.content),
        projectId: '',
        content: lesson.content,
        source: lesson.source,
        reusable: lesson.reusable,
        origin: 'imported',
      });
      if (wrote) addedLessons++; else skippedLessons++;
    }

    db.prepare(
      `INSERT INTO wa_position_imports
         (id, position_id, file_name, mode, added_sections, added_lessons, skipped_lessons, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `pimp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      position.id, String(fileName ?? ''), mode, addedSections, addedLessons, skippedLessons, nowIso,
    );
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚/事务未开 */ }
    return bad('INTERNAL', (e as Error)?.message || String(e));
  }

  const final = getPosition(db, position.id);
  if (!final) return bad('INTERNAL', '导入后岗位读不回来');
  return ok({ position: final, created, mode, addedSections, addedLessons, skippedLessons });
}
