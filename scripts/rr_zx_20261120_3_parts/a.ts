/**
 * zx_20261120_3 A 组「职·全」——所有建单路径统一派生岗位。
 *
 * 归属：M1。断言口径：
 *   · 派生矩阵两侧标本同试（显式/父/默认/无/显式不指派/父岗失效）；
 *   · 静态接线按**语句形状**钉（INSERT 列含 position_id、上下文含来源键），不按行号；
 *   · 不依赖真实墙钟、不写“只为下一轮”的字面量。
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { RrHarness } from '../rr_zx_20261120_3.js';
import { stripKeepingLines } from '../lib/rr-pins.js';
import { deriveTaskPosition, positionContextFields } from '../../apps/worker-ant-desktop/src/main/core/positions.js';

function mkPos(db: Database.Database, id: string, name: string, enabled = 1, builtin = 0): void {
  db.prepare(
    `INSERT INTO wa_positions (id, name, category, description, skills_json, rules_json, knowledge_json, enabled, builtin, version)
     VALUES (?, ?, 'tech', '说明', '[]', '[]', '[]', ?, ?, 1)`,
  ).run(id, name, enabled, builtin);
}
function bind(db: Database.Database, projectId: string, positionId: string, enabled = 1): void {
  db.prepare(
    'INSERT INTO wa_project_positions (project_id, position_id, enabled) VALUES (?, ?, ?)',
  ).run(projectId, positionId, enabled);
}
function mkTask(db: Database.Database, id: string, projectId: string, positionId: string): void {
  db.prepare(
    "INSERT INTO wa_tasks (id, project_id, title, description, status, position_id) VALUES (?, ?, '父任务', '', 'pending', ?)",
  ).run(id, projectId, positionId);
}

export function runA(h: RrHarness): void {
  const root = h.root;

  // ── A1 派生矩阵 ────────────────────────────────────────────────────────
  {
    const db = h.mkdb();
    mkPos(db, 'pos_a', '甲岗');
    mkPos(db, 'pos_disabled', '停用岗', 0);
    bind(db, 'p', 'pos_a');
    bind(db, 'p', 'pos_disabled');
    mkTask(db, 't_parent', 'p', 'pos_a');
    mkTask(db, 't_parent_off', 'p', 'pos_disabled');
    mkTask(db, 't_parent_none', 'p', '');

    const explicit = deriveTaskPosition(db, { projectId: 'p', explicitPositionId: 'pos_a' });
    h.eq([explicit.positionId, explicit.source], ['pos_a', 'explicit'], 'A1 显式优先');

    const invalid = deriveTaskPosition(db, { projectId: 'p', explicitPositionId: 'pos_missing' });
    h.eq([invalid.positionId, invalid.invalidExplicit], ['', true], 'A1 显式不可用 ⇒ invalidExplicit（调用方拒绝）');

    const explicitNone = deriveTaskPosition(db, { projectId: 'p', parentTaskId: 't_parent', explicitNone: true, allowProjectDefault: true });
    h.eq([explicitNone.positionId, explicitNone.source], ['', 'none'], 'A1 显式“不指派”不被父/默认覆盖');

    const parent = deriveTaskPosition(db, { projectId: 'p', parentTaskId: 't_parent', allowProjectDefault: true });
    h.eq([parent.positionId, parent.source, parent.parentTaskId], ['pos_a', 'parent', 't_parent'], 'A1 父继承（父岗有效）');

    const parentOff = deriveTaskPosition(db, { projectId: 'p', parentTaskId: 't_parent_off', allowProjectDefault: true });
    h.eq([parentOff.positionId, parentOff.source], ['', 'none'], 'A1 父岗停用 ⇒ 不继承也不落默认');

    const parentNone = deriveTaskPosition(db, { projectId: 'p', parentTaskId: 't_parent_none', allowProjectDefault: true });
    h.eq([parentNone.positionId, parentNone.source], ['pos_a', 'project_default'], 'A1 父无岗位 ⇒ 项目默认');

    const noDefault = deriveTaskPosition(db, { projectId: 'p' });
    h.eq([noDefault.positionId, noDefault.source], ['', 'none'], 'A1 无显式/父/默认 ⇒ none');
  }

  // ── A2 默认只在“恰好一个启用岗位”时成立 ────────────────────────────────
  {
    const db = h.mkdb();
    mkPos(db, 'pos_only', '唯一岗');
    bind(db, 'p', 'pos_only');
    const one = deriveTaskPosition(db, { projectId: 'p', allowProjectDefault: true });
    h.eq([one.positionId, one.source], ['pos_only', 'project_default'], 'A2 恰好一个 ⇒ 项目默认');

    mkPos(db, 'pos_second', '第二岗');
    bind(db, 'p', 'pos_second');
    const two = deriveTaskPosition(db, { projectId: 'p', allowProjectDefault: true });
    h.eq([two.positionId, two.source], ['', 'none'], 'A2 两个启用岗位 ⇒ 不默认（不替用户猜）');
  }

  // ── A3 来源字段形状 ────────────────────────────────────────────────────
  {
    const withParent = positionContextFields({ positionId: 'x', source: 'parent', parentTaskId: 't1' });
    h.eq(withParent, { position_source: 'parent', position_inherited_from: 't1' }, 'A3 父继承带 inherited_from');
    const none = positionContextFields({ positionId: '', source: 'none' });
    h.eq(none, { position_source: 'none' }, 'A3 无岗位只写来源，不编父 id');
  }

  // ── A4 静态接线：每条路径都带 position_id 与来源 ──────────────────────
  {
    const read = (rel: string): string => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');
    const ipc = read('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
    h.ok(ipc.includes('deriveTaskPosition(db, {') && ipc.includes('positionContextFields(derivedPosition)'),
      'A4 GUI 建单走 deriveTaskPosition + 来源字段');
    h.ok(/INSERT INTO wa_tasks \(id, project_id, title, description, status, priority, context_json, parent_task_id, source, acceptance_criteria, depends_on, position_id\)/.test(ipc),
      'A4 模板拆解 INSERT 含 position_id');
    h.ok(ipc.includes('positionContextFields({ positionId: wantedPositionId, source: wantedPositionId ? \'parent\' : \'none\''),
      'A4 模板拆解子任务来源=父/无');

    const res = read('apps/worker-ant-desktop/src/main/core/tools/resource.ts');
    const debate = res.includes('position_id) VALUES (?, ?, ?, ?, ?, \'pending\', \'\', ?, \'agent\', ?)');
    const swarm = res.includes('position_id) VALUES (?, ?, ?, ?, ?, \'pending\', ?, \'\', ?, \'agent\', ?)');
    h.ok(debate && swarm, 'A4 辩论/蚁群 INSERT 含 position_id');
    h.ok((res.match(/deriveTaskPosition\(db, \{ projectId, parentTaskId: taskId \}\)/g) ?? []).length >= 3,
      'A4 spawn/辩论/蚁群均走同一派生（至少 3 处）');

    const decomp = read('apps/worker-ant-desktop/src/main/core/task-decompose.ts');
    h.ok(decomp.includes('deriveTaskPosition(db, { projectId: opts.projectId, parentTaskId: opts.parentTaskId })')
      && decomp.includes('...positionContextFields(derivedPosition)'),
      'A4 自动拆解器走同一派生并落来源');

    const control = read('apps/worker-ant-desktop/src/main/core/tools/control.ts');
    h.ok(control.includes('deriveTaskPosition(db, { projectId, parentTaskId: taskId })')
      && control.includes('...positionContextFields(derivedPosition)'),
      'A4 create_task 走同一派生并落来源');

    const ai = read('apps/worker-ant-desktop/src/main/core/jobs/ai-task.ts');
    h.ok(ai.includes('deriveTaskPosition(db, {') && ai.includes('positionContextFields(derivedPosition)'),
      'A4 自治任务走同一派生');

    const ver = read('apps/worker-ant-desktop/src/main/core/verification-issues.ts');
    h.ok(ver.includes('deriveTaskPosition(db, { projectId, parentTaskId: taskId })'),
      'A4 验收修复任务继承来源任务岗位');

    const main = read('apps/worker-ant-desktop/src/main/index.ts');
    h.ok(main.includes('deriveTaskPosition(db, {') && main.includes('positionContextFields(derivedPosition)'),
      'A4 项目 cron 走同一派生');

    const im = read('apps/worker-ant-desktop/src/main/services/im-router.ts');
    h.ok((im.match(/position_source/g) ?? []).length >= 3, 'A4 IM 三处建单都写来源', `实测 ${(im.match(/position_source/g) ?? []).length} 处`);

    const routine = read('apps/worker-ant-desktop/src/main/core/position-routines.ts');
    h.ok(routine.includes("position_source: 'routine'"), 'A4 岗位例行来源=routine');
  }

  // ── A5 跨机中继不写本地 position_id ───────────────────────────────────
  {
    const relay = stripKeepingLines(fs.readFileSync(path.join(root, 'apps/worker-ant-desktop/src/main/core/node-request-runner.ts'), 'utf-8')).join('\n');
    h.ok(relay.includes('DISPATCH_POSITION_KEY') || relay.includes('dispatch_position'),
      'A5 跨机中继仍用 dispatch_position');
    // 中继任务经 `TaskManager.create` 落行；该 INSERT 刻意不带 position_id（对端岗位只落 dispatch_position）。
    const engine = stripKeepingLines(fs.readFileSync(path.join(root, 'apps/worker-ant-desktop/src/main/core/project-engine.ts'), 'utf-8')).join('\n');
    const engineInserts = engine.split('\n').filter((l) => l.includes('INSERT INTO wa_tasks'));
    h.ok(engineInserts.length > 0 && engineInserts.every((l) => !l.includes('position_id')),
      'A5 中继建单不写本机 position_id（不伪造本地指派）');
  }
}
