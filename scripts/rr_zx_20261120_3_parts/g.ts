/**
 * zx_20261120_3 G 组「传·档」——两维容量与商业口径。
 *
 * 归属：M7。断言口径：
 *   · 上限从 `TIER_LIMITS` 派生；内置岗位不占额；停用仍占位；
 *   · 到顶拒新增、已有行一条不动；覆盖导入已有岗位不占新增；
 *   · 用量/升级差异含两维；`0` 显示「不限」；
 *   · 动作面按语句形状接闸（不按行号）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { RrHarness } from '../rr_zx_20261120_3.js';
import { stripKeepingLines } from '../lib/rr-pins.js';
import { TIER_LIMITS } from '../../apps/worker-ant-desktop/src/main/core/feature-limits.js';
import { capacityRefusal, countCustomPositions, countPositionRoutines } from '../../apps/worker-ant-desktop/src/main/core/tier-capacity.js';
import { tierUsageCounts, upgradeDifferences } from '../../apps/worker-ant-desktop/src/main/core/tier-usage.js';
import { PRICING } from '../../apps/worker-ant-desktop/src/main/core/pricing.js';
import { BENEFIT_COVERAGE } from '../../apps/worker-ant-desktop/src/main/core/tier-catalog.js';

export function runG(h: RrHarness): void {
  const root = h.root;

  // ── G1 上限派生 ───────────────────────────────────────────────────────
  {
    h.eq([TIER_LIMITS.community.maxCustomPositions, TIER_LIMITS.community.maxPositionRoutines], [5, 2], 'G1 社区 5 / 2');
    h.eq([TIER_LIMITS.pro.maxCustomPositions, TIER_LIMITS.pro.maxPositionRoutines], [20, 20], 'G1 专业 20 / 20');
    h.eq([TIER_LIMITS.team.maxCustomPositions, TIER_LIMITS.team.maxPositionRoutines], [0, 0], 'G1 团队不限（0）');
  }

  // ── G2 计数口径：内置不占、停用仍占 ───────────────────────────────────
  {
    const db = h.mkdb();
    const builtin = (db.prepare('SELECT COUNT(*) AS c FROM wa_positions WHERE builtin = 1').get() as { c: number }).c;
    h.ok(builtin >= 13, 'G2 内置岗位已播种（≥13）', String(builtin));
    h.eq(countCustomPositions(db), 0, 'G2 内置不占自建额度（0）');
    db.prepare(
      `INSERT INTO wa_positions (id, name, category, description, skills_json, rules_json, knowledge_json, enabled, builtin, version)
       VALUES ('pc1', '自建一', 'tech', '', '[]', '[]', '[]', 0, 0, 1)`,
    ).run();
    h.eq(countCustomPositions(db), 1, 'G2 停用自建仍占位（1）');
    db.prepare(
      `INSERT INTO wa_position_routines (id, position_id, project_id, name, cron, title, enabled)
       VALUES ('r1', 'pc1', 'p', '例行一', '0 9 * * *', '标题', 0)`,
    ).run();
    h.eq(countPositionRoutines(db), 1, 'G2 停用例行仍占位（1）');
  }

  // ── G3 到顶拒新增、已有不动 ───────────────────────────────────────────
  {
    const db = h.mkdb();
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO wa_positions (id, name, category, description, skills_json, rules_json, knowledge_json, enabled, builtin, version)
         VALUES (?, ?, 'tech', '', '[]', '[]', '[]', 1, 0, 1)`,
      ).run(`pc_${i}`, `自建${i}`);
    }
    h.eq(countCustomPositions(db), 5, 'G3 起步 5 个自建');
    const atCap = capacityRefusal('community', 'maxCustomPositions', countCustomPositions(db));
    h.eq(atCap.ok, false, 'G3 社区到顶（5）拒新增');
    h.ok(atCap.note.includes('5') && atCap.note.includes('社区'), 'G3 拒因含已用/档位', atCap.note);
    h.eq(countCustomPositions(db), 5, 'G3 拒新增不动已有行');
    const under = capacityRefusal('pro', 'maxCustomPositions', 5);
    h.eq(under.ok, true, 'G3 专业 5/20 放行');
  }

  // ── G4 用量与升级差异 ─────────────────────────────────────────────────
  {
    const db = h.mkdb();
    db.prepare(
      `INSERT INTO wa_positions (id, name, category, description, skills_json, rules_json, knowledge_json, enabled, builtin, version)
       VALUES ('pc_u', '用量岗', 'tech', '', '[]', '[]', '[]', 1, 0, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO wa_position_routines (id, position_id, project_id, name, cron, title)
       VALUES ('r_u', 'pc_u', 'p', '用量例行', '0 9 * * *', '标题')`,
    ).run();
    const counts = tierUsageCounts(db);
    h.eq(counts.customPositions.used, 1, 'G4 用量：自建岗位 1');
    h.eq(counts.positionRoutines.used, 1, 'G4 用量：岗位例行 1');
    // 夹具档位由许可状态决定（缺省可能是试用/团队）——上限只钉“与 TIER_LIMITS 同值”，不写死某档数字。
    h.eq([counts.customPositions.limit, counts.positionRoutines.limit],
      [TIER_LIMITS[counts.tier].maxCustomPositions, TIER_LIMITS[counts.tier].maxPositionRoutines],
      `G4 用量上限从 TIER_LIMITS 派生（档位 ${counts.tier}）`);

    const up = upgradeDifferences('community');
    h.ok(up.quotas.includes('自建岗位 20 个'), 'G4 升级差异含自建岗位 20', up.quotas.join(' | '));
    h.ok(up.quotas.includes('岗位例行 20 套'), 'G4 升级差异含岗位例行 20');
    const upTeam = upgradeDifferences('pro');
    h.ok(upTeam.quotas.includes('不限自建岗位') && upTeam.quotas.includes('不限岗位例行'),
      'G4 专业→团队显示不限（不写 0 个）', upTeam.quotas.join(' | '));
  }

  // ── G5 价目表与兑现登记同句 ───────────────────────────────────────────
  {
    const proPos = PRICING.pro.benefits.filter((b) => b.startsWith('自建岗位') || b.startsWith('岗位例行'));
    h.eq(proPos.length, 2, 'G5 专业卖点含两维');
    const cov = BENEFIT_COVERAGE.pro.map((c) => c.benefit);
    h.ok(proPos.every((b) => cov.includes(b)), 'G5 专业卖点均在兑现登记');
    const teamPos = PRICING.team.benefits.filter((b) => b.startsWith('自建岗位') || b.startsWith('岗位例行'));
    h.eq(teamPos.length, 2, 'G5 团队卖点含两维');
    const teamCov = BENEFIT_COVERAGE.team.map((c) => c.benefit);
    h.ok(teamPos.every((b) => teamCov.includes(b)), 'G5 团队卖点均在兑现登记');
  }

  // ── G6 动作面接闸形状 ─────────────────────────────────────────────────
  {
    const read = (rel: string): string => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');
    const ipc = read('apps/worker-ant-desktop/src/main/ipc/positions.ipc.ts');
    const createGate = ipc.indexOf("capacityRefusal(resolveLicenseTier(db), 'maxCustomPositions'");
    const createCall = ipc.indexOf('createPosition(db, inputOf(input))');
    h.ok(createGate > 0 && createCall > createGate, 'G6 positions:create 先闸后建');
    const importGate = ipc.indexOf("capacityRefusal(resolveLicenseTier(db), 'maxCustomPositions'", createGate + 1);
    const importCall = ipc.indexOf('importPositionPackage(db, parsed.value', importGate);
    h.ok(importGate > 0 && importCall > importGate, 'G6 positions:import 先闸后写');
    h.ok(ipc.includes('if (!getPositionByName(db, parsed.value.position.name))'),
      'G6 覆盖已有岗位不占新增（仅新岗位过闸）');
    const routineGate = ipc.indexOf("capacityRefusal(resolveLicenseTier(db), 'maxPositionRoutines'");
    const routineCall = ipc.indexOf('createRoutine(db, body)', routineGate);
    h.ok(routineGate > 0 && routineCall > routineGate, 'G6 例行先闸后建');
  }
}
