/**
 * zx_20261120_3 C 组「积·命」——经验生命周期。
 *
 * 归属：M3。断言口径：
 *   · 时效用**注入的 now**，不读墙钟；四态各一只标本；
 *   · 退役/被替代 ⇒ 不注入、不晋升；撤销后恢复；
 *   · 注入块只对 stale/unverified 加前缀（fresh/aging 旧文案不变）；
 *   · 包导出排除退役/被替代，携带 appliesTo。
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { RrHarness } from '../rr_zx_20261120_3.js';
import { stripKeepingLines } from '../lib/rr-pins.js';
import {
  LESSON_AGING_DAYS,
  LESSON_STALE_DAYS,
  insertPositionLessonCandidate,
  lessonFreshness,
  positionBlockDetail,
  positionProfile,
  promotePositionLesson,
  retireLesson,
  selectPositionLessonsForInjection,
  setLessonApplies,
  supersedeLesson,
  unretireLesson,
  unsupersedeLesson,
  verifyLesson,
} from '../../apps/worker-ant-desktop/src/main/core/positions.js';
import { buildPositionPackage } from '../../apps/worker-ant-desktop/src/main/core/position-package.js';

const NOW = '2026-11-20T12:00:00.000Z';
const DAY = 86_400_000;
const ago = (days: number): string => new Date(Date.parse(NOW) - days * DAY).toISOString();

function mkPos(db: Database.Database): void {
  db.prepare(
    `INSERT INTO wa_positions (id, name, category, description, skills_json, rules_json, knowledge_json, enabled, builtin, version)
     VALUES ('pos_l', '生命岗', 'tech', '说明', '[]', '[]', '[]', 1, 0, 1)`,
  ).run();
  db.prepare('INSERT INTO wa_project_positions (project_id, position_id, enabled) VALUES (?, ?, 1)').run('p', 'pos_l');
}

function addLesson(db: Database.Database, input: {
  id: string; content: string; status?: string; verifiedAt?: string | null;
  retiredAt?: string | null; supersededBy?: string | null; reusable?: number; appliesTo?: string;
}): void {
  db.prepare(
    `INSERT INTO wa_position_lessons
       (id, position_id, task_id, project_id, content, status, source, reusable, origin, verified_at, applies_to, retired_at, superseded_by)
     VALUES (?, 'pos_l', ?, 'p', ?, ?, 'retrospective', ?, 'local', ?, ?, ?, ?)`,
  ).run(
    input.id, `task_${input.id}`, input.content, input.status ?? 'accepted',
    input.reusable ?? 1, input.verifiedAt ?? null, input.appliesTo ?? '',
    input.retiredAt ?? null, input.supersededBy ?? null,
  );
}

export function runC(h: RrHarness): void {
  const root = h.root;

  // ── C1 时效四态（固定 now） ────────────────────────────────────────────
  {
    h.eq(lessonFreshness({ verifiedAt: ago(10) }, null, NOW), 'fresh', 'C1 10 天 ⇒ fresh');
    h.eq(lessonFreshness({ verifiedAt: ago(LESSON_AGING_DAYS + 10) }, null, NOW), 'aging', 'C1 100 天 ⇒ aging');
    h.eq(lessonFreshness({ verifiedAt: ago(LESSON_STALE_DAYS + 20) }, null, NOW), 'stale', 'C1 200 天 ⇒ stale');
    h.eq(lessonFreshness({ verifiedAt: '' }, null, NOW), 'unverified', 'C1 无验证时刻 ⇒ unverified');
    h.eq(lessonFreshness({ verifiedAt: ago(LESSON_STALE_DAYS + 20) }, ago(1), NOW), 'fresh',
      'C1 最近一次成功注入覆盖旧验证时刻 ⇒ fresh');
  }

  // ── C2 退役/替代：不注入、可撤销 ──────────────────────────────────────
  {
    const db = h.mkdb();
    mkPos(db);
    addLesson(db, { id: 'l1', content: '经验一', verifiedAt: ago(1) });
    addLesson(db, { id: 'l2', content: '经验二', verifiedAt: ago(1) });
    addLesson(db, { id: 'l3', content: '经验三', verifiedAt: ago(1) });

    h.eq(selectPositionLessonsForInjection(db, 'pos_l', 3, '', NOW).map((l) => l.id).sort(), ['l1', 'l2', 'l3'], 'C2 起步三条都可注入');

    h.eq(retireLesson(db, 'l1', '已过时', NOW).ok, true, 'C2 退役成功');
    h.eq(selectPositionLessonsForInjection(db, 'pos_l', 3, '', NOW).map((l) => l.id).sort(), ['l2', 'l3'], 'C2 退役后不注入');
    unretireLesson(db, 'l1');
    h.eq(selectPositionLessonsForInjection(db, 'pos_l', 3, '', NOW).map((l) => l.id).sort(), ['l1', 'l2', 'l3'], 'C2 撤销退役后恢复');

    h.eq(supersedeLesson(db, 'l2', 'l3').ok, true, 'C2 标记被替代成功');
    h.eq(selectPositionLessonsForInjection(db, 'pos_l', 3, '', NOW).map((l) => l.id).sort(), ['l1', 'l3'], 'C2 被替代不注入');
    unsupersedeLesson(db, 'l2');
    h.eq(selectPositionLessonsForInjection(db, 'pos_l', 3, '', NOW).map((l) => l.id).sort(), ['l1', 'l2', 'l3'], 'C2 撤销替代后恢复');
  }

  // ── C3 退役/被替代不得晋升；撤销后可晋升 ───────────────────────────────
  {
    const db = h.mkdb();
    mkPos(db);
    addLesson(db, { id: 'l1', content: '可达 200 字的短经验', verifiedAt: ago(1) });
    addLesson(db, { id: 'l2', content: '替代者', verifiedAt: ago(1) });
    retireLesson(db, 'l1', '过时', NOW);
    const retired = promotePositionLesson(db, 'l1', 'skills', NOW);
    h.ok(!retired.ok && retired.code === 'RETIRED', 'C3 退役经验晋升被拒（RETIRED）', JSON.stringify(retired));
    unretireLesson(db, 'l1');
    supersedeLesson(db, 'l1', 'l2');
    const sup = promotePositionLesson(db, 'l1', 'skills', NOW);
    h.ok(!sup.ok && sup.code === 'SUPERSEDED', 'C3 被替代经验晋升被拒（SUPERSEDED）', JSON.stringify(sup));
    unsupersedeLesson(db, 'l1');
    const ok = promotePositionLesson(db, 'l1', 'skills', NOW);
    h.eq(ok.ok, true, 'C3 撤销替代后可晋升');
  }

  // ── C4 注入块前缀：只标 stale/unverified ───────────────────────────────
  {
    const db = h.mkdb();
    mkPos(db);
    addLesson(db, { id: 'fresh', content: '新鲜经验', verifiedAt: ago(10) });
    addLesson(db, { id: 'stale', content: '陈旧经验', verifiedAt: ago(LESSON_STALE_DAYS + 10) });
    addLesson(db, { id: 'unver', content: '未验证经验', verifiedAt: null });
    const picked = selectPositionLessonsForInjection(db, 'pos_l', 3, '', NOW);
    h.eq(picked.map((l) => l.freshness).sort(), ['fresh', 'stale', 'unverified'], 'C4 三条各自时效');
    const block = positionBlockDetail(
      { name: '生命岗', description: '', rules: [], skills: [], knowledge: [] },
      picked,
    );
    h.ok(block.text.includes('[待复验] 陈旧经验'), 'C4 stale 注入带 [待复验]', block.text);
    h.ok(block.text.includes('[未验证] 未验证经验'), 'C4 unverified 注入带 [未验证]');
    h.ok(block.text.includes('经验：') && block.text.includes('新鲜经验') && !block.text.includes('[待复验] 新鲜经验'),
      'C4 fresh 不加前缀');
  }

  // ── C5 画像 0→N 正面断言 ──────────────────────────────────────────────
  {
    const db = h.mkdb();
    mkPos(db);
    addLesson(db, { id: 'a', content: '退役经验', verifiedAt: ago(1), retiredAt: NOW });
    addLesson(db, { id: 'b', content: '被替代经验', verifiedAt: ago(1), supersededBy: 'c' });
    addLesson(db, { id: 'c', content: '替代者', verifiedAt: ago(1) });
    addLesson(db, { id: 'd', content: '陈旧经验', verifiedAt: ago(LESSON_STALE_DAYS + 10) });
    addLesson(db, { id: 'e', content: '未验证经验', verifiedAt: null });
    const p = positionProfile(db, 'pos_l', { now: NOW });
    h.ok(p !== null, 'C5 画像可读');
    h.eq(p!.lessons.retired, 1, 'C5 retired 0→1');
    h.eq(p!.lessons.superseded, 1, 'C5 superseded 0→1');
    h.eq(p!.lessons.stale, 1, 'C5 stale 0→1');
    h.eq(p!.lessons.unverified, 1, 'C5 unverified 0→1');
  }

  // ── C6 适用条件 + 包导出 ──────────────────────────────────────────────
  {
    const db = h.mkdb();
    mkPos(db);
    addLesson(db, { id: 'a', content: '带适用条件的经验', verifiedAt: ago(1) });
    addLesson(db, { id: 'b', content: '退役的不导出', verifiedAt: ago(1), retiredAt: NOW });
    addLesson(db, { id: 'c', content: '被替代的不导出', verifiedAt: ago(1), supersededBy: 'a' });
    h.eq(setLessonApplies(db, 'a', '仅在后端仓库任务适用').ok, true, 'C6 适用条件写入');
    h.eq(setLessonApplies(db, 'a', 'x'.repeat(201)).ok, false, 'C6 适用条件超长被拒');
    const built = buildPositionPackage(db, 'pos_l', NOW);
    h.eq(built.ok, true, 'C6 包可导出');
    if (built.ok) {
      h.eq(built.value.package.lessons.map((l) => l.content), ['带适用条件的经验'], 'C6 只导出未退役/未被替代');
      h.eq(built.value.package.lessons[0]?.appliesTo, '仅在后端仓库任务适用', 'C6 包携带 appliesTo');
    }
  }

  // ── C7 本机/导入的 verified_at 默认 ───────────────────────────────────
  {
    const db = h.mkdb();
    mkPos(db);
    insertPositionLessonCandidate(db, { positionId: 'pos_l', taskId: 't_local', projectId: 'p', content: '本机候选', reusable: true });
    insertPositionLessonCandidate(db, { positionId: 'pos_l', taskId: 't_import', projectId: '', content: '导入候选', reusable: true, origin: 'imported' });
    const rows = db.prepare("SELECT task_id, verified_at FROM wa_position_lessons WHERE position_id='pos_l'").all() as Array<{ task_id: string; verified_at: string | null }>;
    const local = rows.find((r) => r.task_id === 't_local');
    const imported = rows.find((r) => r.task_id === 't_import');
    h.ok(!!local?.verified_at, 'C7 本机候选 verified_at 非空');
    h.eq(imported?.verified_at, null, 'C7 导入候选 verified_at 为空（未在本机验证）');
    verifyLesson(db, rows.find((r) => r.task_id === 't_import') ? (db.prepare("SELECT id FROM wa_position_lessons WHERE task_id='t_import'").get() as { id: string }).id : '', NOW);
    const after = db.prepare("SELECT verified_at FROM wa_position_lessons WHERE task_id='t_import'").get() as { verified_at: string };
    h.eq(after.verified_at, NOW, 'C7 人工复验后写入时刻');
  }

  // ── C8 静态接线：IPC/词表/列 ──────────────────────────────────────────
  {
    const read = (rel: string): string => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');
    const ipc = read('apps/worker-ant-desktop/src/main/ipc/positions.ipc.ts');
    h.ok(ipc.includes("positions:lessonLifecycle") && ipc.includes("case 'retire'") && ipc.includes("case 'supersede'"),
      'C8 IPC 生命周期动作在册');
    const dbSrc = read('apps/worker-ant-desktop/src/main/database.ts');
    h.ok(dbSrc.includes('ADD COLUMN applies_to') && dbSrc.includes('SET verified_at = created_at'),
      'C8 迁移补列 + 回填在册');
  }
}
