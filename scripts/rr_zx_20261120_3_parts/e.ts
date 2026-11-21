/**
 * zx_20261120_3 E 组「积·桥」——项目知识 → 岗位候选。
 *
 * 归属：M5。断言口径：
 *   · 只接受可迁移节；只写 pending；verified_at 为空（未在本机任务验证）；
 *   · 幂等（同岗位同内容）；岗位停用/未绑定拒绝；
 *   · 来源词表四处读点同步；不自动采纳、不回写项目知识。
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { RrHarness } from '../rr_zx_20261120_3.js';
import { stripKeepingLines } from '../lib/rr-pins.js';
import {
  POSITION_LESSON_SOURCE_LABEL,
  POSITION_LESSON_SOURCES,
} from '../../apps/worker-ant-desktop/src/main/core/positions.js';
import { POSITION_CAPTURE_SECTIONS, captureProjectKnowledgeCandidate } from '../../apps/worker-ant-desktop/src/main/core/position-capture.js';
import { parsePositionPackage } from '../../apps/worker-ant-desktop/src/main/core/position-package.js';

function mkPos(db: Database.Database, id: string, name: string, enabled = 1, bound = true): void {
  db.prepare(
    `INSERT INTO wa_positions (id, name, category, description, skills_json, rules_json, knowledge_json, enabled, builtin, version)
     VALUES (?, ?, 'tech', '说明', '[]', '[]', '[]', ?, 0, 1)`,
  ).run(id, name, enabled);
  if (bound) db.prepare('INSERT INTO wa_project_positions (project_id, position_id, enabled) VALUES (?, ?, 1)').run('p', id);
}

export function runE(h: RrHarness): void {
  const root = h.root;

  // ── E1 合法条目 ⇒ pending + 来源 + 未验证 ─────────────────────────────
  {
    const db = h.mkdb();
    mkPos(db, 'pos_cap', '沉淀岗');
    const r = captureProjectKnowledgeCandidate(db, {
      projectId: 'p', positionId: 'pos_cap', section: 'recipes',
      content: '发布前先跑 `pnpm build`，再用 dist 产物做冒烟。',
    });
    h.eq([r.ok, r.ok ? r.created : null], [true, true], 'E1 合法条目创建成功');
    const row = db.prepare("SELECT status, source, verified_at, reusable, origin, content FROM wa_position_lessons WHERE position_id='pos_cap'").get() as
      { status: string; source: string; verified_at: string | null; reusable: number; origin: string; content: string };
    h.eq([row.status, row.source, row.verified_at, row.reusable, row.origin],
      ['pending', 'project_knowledge', null, 1, 'local'], 'E1 pending/来源/未验证/可迁移/本机');
    h.ok(!row.content.includes('\n'), 'E1 内容单行化');
  }

  // ── E2 幂等 ───────────────────────────────────────────────────────────
  {
    const db = h.mkdb();
    mkPos(db, 'pos_cap2', '沉淀岗二');
    const input = { projectId: 'p', positionId: 'pos_cap2', section: 'criteria', content: '验收必须含运行期证据。' };
    const a = captureProjectKnowledgeCandidate(db, input);
    const b = captureProjectKnowledgeCandidate(db, input);
    h.eq([a.ok, a.ok ? a.created : null], [true, true], 'E2 第一次创建');
    h.eq([b.ok, b.ok ? b.created : null], [true, false], 'E2 第二次幂等（不新增）');
    const n = (db.prepare("SELECT COUNT(*) AS c FROM wa_position_lessons WHERE position_id='pos_cap2'").get() as { c: number }).c;
    h.eq(n, 1, 'E2 库里恰好一条');
  }

  // ── E3 拒绝：不可迁移节/岗位无效/内容非法 ──────────────────────────────
  {
    const db = h.mkdb();
    mkPos(db, 'pos_ok', '可用岗');
    mkPos(db, 'pos_off', '停用岗', 0);
    mkPos(db, 'pos_unbound', '未绑定岗', 1, false);
    const cases: Array<[string, string, string]> = [
      ['entities', 'pos_ok', 'BAD_INPUT'],
      ['artifacts', 'pos_ok', 'BAD_INPUT'],
      ['services', 'pos_ok', 'BAD_INPUT'],
      ['usage', 'pos_ok', 'BAD_INPUT'],
      ['index', 'pos_ok', 'BAD_INPUT'],
      ['runtime', 'pos_ok', 'BAD_INPUT'],
      ['recipes', 'pos_off', 'NOT_FOUND'],
      ['recipes', 'pos_unbound', 'NOT_FOUND'],
      ['recipes', 'pos_missing', 'NOT_FOUND'],
    ];
    for (const [section, positionId, code] of cases) {
      const r = captureProjectKnowledgeCandidate(db, { projectId: 'p', positionId, section, content: '内容' });
      h.ok(!r.ok && r.code === code, `E3 ${section}/${positionId} ⇒ ${code}`, r.ok ? 'parsed' : r.code);
    }
    const empty = captureProjectKnowledgeCandidate(db, { projectId: 'p', positionId: 'pos_ok', section: 'recipes', content: '   ' });
    h.ok(!empty.ok && empty.code === 'BAD_INPUT', 'E3 空内容拒绝');
    const long = captureProjectKnowledgeCandidate(db, { projectId: 'p', positionId: 'pos_ok', section: 'recipes', content: 'x'.repeat(301) });
    h.ok(!long.ok && long.code === 'BAD_INPUT', 'E3 超长拒绝');
    const n = (db.prepare('SELECT COUNT(*) AS c FROM wa_position_lessons').get() as { c: number }).c;
    h.eq(n, 0, 'E3 拒绝路径零写入');
  }

  // ── E4 来源词表四处读点 ───────────────────────────────────────────────
  {
    h.ok((POSITION_LESSON_SOURCES as readonly string[]).includes('project_knowledge'), 'E4 来源常量含 project_knowledge');
    h.eq(POSITION_LESSON_SOURCE_LABEL.project_knowledge, '项目知识', 'E4 人话名');
    const pkgText = JSON.stringify({
      kind: 'worker-ant-position', version: 2, exportedAt: '', position: { name: '来源岗', category: 'tech', description: '', rules: [], skills: [], knowledge: [] },
      lessons: [{ content: '来自项目知识的经验', source: 'project_knowledge', reusable: true }],
    });
    const parsed = parsePositionPackage(pkgText);
    h.ok(parsed.ok && parsed.value.lessons[0]?.source === 'project_knowledge', 'E4 包归一保留来源');
    h.eq(POSITION_CAPTURE_SECTIONS, ['recipes', 'criteria', 'domain'], 'E4 可迁移三节（一处真源）');
  }

  // ── E5 静态：IPC/单向 ─────────────────────────────────────────────────
  {
    const read = (rel: string): string => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');
    const ipc = read('apps/worker-ant-desktop/src/main/ipc/positions.ipc.ts');
    h.ok(ipc.includes('positions:captureProjectKnowledge'), 'E5 IPC 出口在册');
    const cap = read('apps/worker-ant-desktop/src/main/core/position-capture.ts');
    h.ok(!cap.includes('upsertProjectKnowledge') && !cap.includes('wa_project_knowledge'), 'E5 不回写项目知识');
    h.ok(cap.includes("source: 'project_knowledge'") && cap.includes('reusable: true'), 'E5 只写项目知识候选');
  }
}
