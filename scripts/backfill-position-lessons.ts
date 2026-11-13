/**
 * zx_20261113_1 B2「积」: 存量回填——把**已有复盘**但还没有岗位候选的任务补成 `pending` 候选。
 *
 * 只做一件事：对「指派岗位 ∧ completed ∧ 验收通过 ∧ 有活着的复盘 lesson ∧ 尚无候选」的任务，
 * 按 `buildPositionLessonCandidate` 的同一把尺生成 `source='retrospective'` 的候选。
 *
 * 三条纪律：
 *   ① **默认 dry-run**，`--apply` 才真写；
 *   ② **只增不删**：`INSERT OR IGNORE`，同一任务只一条；已采纳/已拒绝不动；
 *   ③ 只回填**复盘可迁移**源；没有复盘 lesson 的任务不拿摘要凑数（摘要候选由收口路径自然产生）。
 *
 * 用法（仓根或桌面包内均可）：
 *   npx tsx scripts/backfill-position-lessons.ts
 *   npx tsx scripts/backfill-position-lessons.ts --apply
 *   npx tsx scripts/backfill-position-lessons.ts --db data/worker-ant-server.db --limit 50
 */
import path from 'node:path';
// 用 `node:sqlite` 而不是 better-sqlite3：后者随桌面/ANS 在 Node ABI 与 Electron ABI 间来回切，
//   回填脚本不该因"桌面正开着"而加载失败（实测 ABI 130 vs 127）。node:sqlite 无原生 ABI 依赖。
import { DatabaseSync } from 'node:sqlite';
import {
  buildPositionLessonCandidate,
  insertPositionLessonCandidate,
  type PositionDb,
} from '../apps/worker-ant-desktop/src/main/core/positions.js';

interface Args {
  dbPath: string;
  apply: boolean;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const root = path.join(__dirname, '..');
  let dbPath = path.join(root, 'data', 'worker-ant-server.db');
  let apply = false;
  let limit = 500;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--apply') apply = true;
    else if (a === '--db') dbPath = path.resolve(root, argv[++i] ?? dbPath);
    else if (a === '--limit') limit = Math.max(0, Number(argv[++i]) || limit);
  }
  return { dbPath, apply, limit };
}

function main(): void {
  const { dbPath, apply, limit } = parseArgs(process.argv.slice(2));
  const db = new DatabaseSync(dbPath);
  // 桌面可能正开着（WAL 单写者）；等锁而不是立刻失败。
  try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* 老版本不支持则维持默认 */ }
  const pdb = db as unknown as PositionDb;

  // 候选任务：有岗位、已完成、无候选、且有活着的复盘行（lesson 是否为空交给 build 判定）。
  const taskIds = db
    .prepare(
      `SELECT t.id AS id
         FROM wa_tasks t
        WHERE t.status = 'completed'
          AND t.position_id <> ''
          AND NOT EXISTS (
            SELECT 1 FROM wa_position_lessons l
             WHERE l.position_id = t.position_id AND l.task_id = t.id
          )
          AND EXISTS (
            SELECT 1 FROM wa_memories m
             WHERE m.task_id = t.id
               AND m.memory_type = 'retrospective'
               AND m.memory_type NOT IN ('archived', 'deleted')
          )
        ORDER BY COALESCE(t.updated_at, t.created_at) DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ id: string }>;

  console.log(`[backfill-position-lessons] db=${dbPath}`);
  console.log(`[backfill-position-lessons] mode=${apply ? 'APPLY' : 'DRY-RUN'} 扫描候选任务 ${taskIds.length} 条`);

  const reasons = new Map<string, number>();
  let eligible = 0;
  let written = 0;
  const samples: string[] = [];

  for (const { id } of taskIds) {
    const built = buildPositionLessonCandidate(pdb, id);
    if (!built.ok) {
      reasons.set(built.reason, (reasons.get(built.reason) ?? 0) + 1);
      continue;
    }
    if (built.source !== 'retrospective') {
      // 有复盘行但取不出 lesson ⇒ 不拿摘要凑数（岗位只收可迁移教训）。
      reasons.set('retro_without_lesson', (reasons.get('retro_without_lesson') ?? 0) + 1);
      continue;
    }
    eligible++;
    if (samples.length < 10) {
      samples.push(`${id} · ${built.positionId} · reusable=${built.reusable ? 1 : 0} · ${built.content.slice(0, 60)}`);
    }
    if (apply) {
      const ok = insertPositionLessonCandidate(pdb, {
        positionId: built.positionId,
        taskId: id,
        projectId: built.projectId,
        content: built.content,
        source: 'retrospective',
        reusable: built.reusable,
      });
      if (ok) written++;
    }
  }

  console.log(`[backfill-position-lessons] 符合条件 ${eligible} 条；实际写入 ${apply ? written : 0} 条（dry-run 不写）`);
  if (samples.length > 0) {
    console.log('[backfill-position-lessons] 样本：');
    for (const s of samples) console.log(`  - ${s}`);
  }
  if (reasons.size > 0) {
    console.log('[backfill-position-lessons] 跳过原因：');
    for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  - ${k}: ${v}`);
  }
  db.close();
}

main();
