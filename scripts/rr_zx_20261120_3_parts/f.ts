/**
 * zx_20261120_3 F 组「积·账」——岗位能力账与「能力」页签。
 *
 * 归属：M6。断言口径：
 *   · 画像技能计数 0→N（草案/已批准/使用次数）；
 *   · 旧「晋升到四段」入口仍在（未删/未改名）；
 *   · 界面按符号接线：能力页签读 positions:skills、生命周期动作、技能审批。
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { RrHarness } from '../rr_zx_20261120_3.js';
import { stripKeepingLines } from '../lib/rr-pins.js';
import { positionProfile } from '../../apps/worker-ant-desktop/src/main/core/positions.js';
import {
  createPositionSkillDraft,
  decidePositionSkill,
  recordPositionSkillUse,
} from '../../apps/worker-ant-desktop/src/main/core/position-skills.js';

function mkPos(db: Database.Database): void {
  db.prepare(
    `INSERT INTO wa_positions (id, name, category, description, skills_json, rules_json, knowledge_json, enabled, builtin, version)
     VALUES ('pos_acc', '账本岗', 'tech', '说明', '[]', '[]', '[]', 1, 0, 1)`,
  ).run();
}

export function runF(h: RrHarness): void {
  const root = h.root;

  // ── F1 画像技能账 0→1 ─────────────────────────────────────────────────
  {
    const db = h.mkdb();
    mkPos(db);
    const p0 = positionProfile(db, 'pos_acc');
    h.ok(p0 !== null, 'F1 画像可读');
    h.eq([p0!.skills.draft, p0!.skills.approved, p0!.skills.uses], [0, 0, 0], 'F1 起步技能账全 0');

    const a = createPositionSkillDraft(db, { positionId: 'pos_acc', name: 'acc_a', steps: ['一步'] });
    if (!a.ok) throw new Error('F1 draft failed');
    const p1 = positionProfile(db, 'pos_acc');
    h.eq([p1!.skills.draft, p1!.skills.approved], [1, 0], 'F1 草案 0→1');

    decidePositionSkill(db, a.skill.id, 'approved');
    const p2 = positionProfile(db, 'pos_acc');
    h.eq([p2!.skills.draft, p2!.skills.approved], [0, 1], 'F1 批准后 草案→0 / 已批准→1');

    recordPositionSkillUse(db, { id: a.skill.id }, '2026-11-20T12:00:00.000Z');
    const p3 = positionProfile(db, 'pos_acc');
    h.eq(p3!.skills.uses, 1, 'F1 使用次数 0→1');
    h.eq(p3!.skills.lastUsedAt, '2026-11-20T12:00:00.000Z', 'F1 最近使用时刻');
  }

  // ── F2 静态：能力页签与旧入口 ─────────────────────────────────────────
  {
    const read = (rel: string): string => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');
    const ui = read('apps/worker-ant-desktop/renderer/src/pages/PositionsPage.tsx');
    h.ok(ui.includes("能力（技能 / 生命周期）") && ui.includes("setDetailTab('skills')"), 'F2 能力页签在册');
    h.ok(ui.includes('positionsIpc.skills(') && ui.includes('positionsIpc.skillCreate(') && ui.includes('positionsIpc.skillDecide('),
      'F2 技能三跳接线（列表/创建/审批）');
    h.ok(ui.includes('positionsIpc.lessonLifecycle('), 'F2 生命周期动作接线');
    h.ok(ui.includes('promoteLesson(') && ui.includes('撤回晋升'), 'F2 旧「晋升到四段」入口仍在');
    const ipc = read('apps/worker-ant-desktop/renderer/src/lib/ipc.ts');
    h.ok(ipc.includes("'positions:skills'") && ipc.includes("'positions:skillCreate'") && ipc.includes("'positions:skillDecide'"),
      'F2 IPC 客户端三跳在册');
  }
}
