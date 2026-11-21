/**
 * zx_20261120_3 B 组「职·见」——来源投影与无岗位提示。
 *
 * 归属：M2。断言口径：
 *   · 来源词表六态各一只标本（含旧任务 legacy 与跨机 remote）；
 *   · 改派 = 显式，且清 inherited_from、保留兄弟键（读改写）；
 *   · 建单回执/任务详情按符号接线（不按行号）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { RrHarness } from '../rr_zx_20261120_3.js';
import { stripKeepingLines } from '../lib/rr-pins.js';
import { applyTaskPositionChange, taskPositionSourceOf } from '../../apps/worker-ant-desktop/src/main/core/positions.js';

function mkPos(db: Database.Database, id: string, name: string): void {
  db.prepare(
    `INSERT INTO wa_positions (id, name, category, description, skills_json, rules_json, knowledge_json, enabled, builtin, version)
     VALUES (?, ?, 'tech', '说明', '[]', '[]', '[]', 1, 0, 1)`,
  ).run(id, name);
  db.prepare('INSERT INTO wa_project_positions (project_id, position_id, enabled) VALUES (?, ?, 1)').run('p', id);
}

export function runB(h: RrHarness): void {
  const root = h.root;

  // ── B1 来源六态 ────────────────────────────────────────────────────────
  {
    h.eq(taskPositionSourceOf({ position_source: 'explicit' }, true), { source: 'explicit' }, 'B1 显式');
    h.eq(taskPositionSourceOf({ position_source: 'parent', position_inherited_from: 't1' }, true),
      { source: 'parent', parentTaskId: 't1' }, 'B1 父继承带父 id');
    h.eq(taskPositionSourceOf({ position_source: 'project_default' }, true), { source: 'project_default' }, 'B1 项目默认');
    h.eq(taskPositionSourceOf({ position_source: 'none' }, false), { source: 'none' }, 'B1 明确无岗位');
    h.eq(taskPositionSourceOf({}, true), { source: 'legacy' }, 'B1 旧任务有岗位无键 ⇒ legacy（不猜）');
    h.eq(taskPositionSourceOf({ dispatch_position: { id: 'x' } }, false), { source: 'remote' }, 'B1 跨机派来 ⇒ remote');
    h.eq(taskPositionSourceOf({}, false), { source: 'legacy' }, 'B1 旧任务无岗位无键 ⇒ legacy');
    h.eq(taskPositionSourceOf(null, false), { source: 'legacy' }, 'B1 坏/空上下文不抛');
  }

  // ── B2 改派 = 显式，清 inherited，保留兄弟键 ───────────────────────────
  {
    const db = h.mkdb();
    mkPos(db, 'pos_a', '甲岗');
    mkPos(db, 'pos_b', '乙岗');
    db.prepare(
      `INSERT INTO wa_tasks (id, project_id, title, description, status, position_id, context_json)
       VALUES ('t1', 'p', '子任务', '', 'pending', 'pos_a', ?)`,
    ).run(JSON.stringify({ position_source: 'parent', position_inherited_from: 'parent_id', attachments: [{ name: 'a.txt' }], goal: '保留我' }));
    const r = applyTaskPositionChange(db, 't1', 'pos_b');
    h.eq([r.ok, r.changed], [true, true], 'B2 改派成功');
    const row = db.prepare('SELECT position_id, context_json FROM wa_tasks WHERE id = ?').get('t1') as { position_id: string; context_json: string };
    const ctx = JSON.parse(row.context_json) as Record<string, unknown>;
    h.eq(row.position_id, 'pos_b', 'B2 写入新岗位');
    h.eq(ctx.position_source, 'explicit', 'B2 来源改显式');
    h.ok(!('position_inherited_from' in ctx), 'B2 清 inherited_from');
    h.eq(ctx.goal, '保留我', 'B2 兄弟键 goal 仍在');
    h.ok(Array.isArray(ctx.attachments) && (ctx.attachments as unknown[]).length === 1, 'B2 兄弟键 attachments 仍在');

    applyTaskPositionChange(db, 't1', '');
    const row2 = db.prepare('SELECT position_id, context_json FROM wa_tasks WHERE id = ?').get('t1') as { position_id: string; context_json: string };
    h.eq([row2.position_id, JSON.parse(row2.context_json).position_source], ['', 'none'], 'B2 解绑 ⇒ none');
  }

  // ── B3 静态接线：投影/回执/界面 ────────────────────────────────────────
  {
    const read = (rel: string): string => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');
    const ipc = read('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
    h.ok(ipc.includes('taskPositionSourceOf(ctxObj, !!pid)') && ipc.includes('positionSource,'),
      'B3 task:get 投影来源（无岗位也带）');
    h.ok(ipc.includes('task.positionHint = ') && ipc.includes('这单不会沉淀岗位经验'),
      'B3 无岗位建单回执说清后果');
    h.ok(ipc.includes('task.positionSource = derivedPosition.source') && ipc.includes('task.position_inherited_from'),
      'B3 建单回执带来源/父 id');

    const ui = read('apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx');
    h.ok(ui.includes('TASK_POSITION_SOURCE_LABEL') && ui.includes('positionSource'),
      'B3 任务详情读来源词表并上屏');
  }
}
