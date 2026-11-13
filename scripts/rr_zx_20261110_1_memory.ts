/**
 * zx_20261110_1 B4「忆」受控回归 —— 三层记忆（short / mid / long）真的都被取用。
 *
 * 病根：`retrieveTaskRelevantWithSource` 的 embedding 路此前只取 `retrieveLayered().longTerm`
 *   ——短层（近因）与中层（高重要度）查出来了却**从未进入结果**，等于"记了三本账、只翻一本"。
 *
 * A 三层全到：近因一条 + 重要度≥阈值一条 + 长尾一条，三条都出现在结果里，来源仍标 `embedding`。
 * B 去重：同一条同时满足"最近"与"高重要度"⇒ 只出现一次。
 * C 阈值单源：`MID_TERM_IMPORTANCE` 为 0.7；0.69 的标本进不了中层（边界两只标本）；SQL 用常量。
 * D 无向量：如实走线索回退（`cue`），线索也取不到 ⇒ `none`（不假装"没有相关记忆"）。
 * E build 钉（P1–P5）与方向性比较。
 *
 * 纪律：零网络 / 零 electron / 零墙钟（时刻写死在夹具里）；断言文案不含失败字形。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import { MID_TERM_IMPORTANCE } from '../apps/worker-ant-desktop/src/main/core/memory-retrieval.js';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag } from './lib/rr-pins.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'apps/worker-ant-desktop');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

/* ── 夹具：列形照生产；先 `new` 服务类（建 FTS 触发器）再插行 ─────────────── */

const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', context_json TEXT DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
  embedding TEXT, memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5,
  reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '',
  valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0,
  exemplar_type TEXT, exemplar_context TEXT, use_count INTEGER DEFAULT 0, last_used_at TEXT,
  injected_count INTEGER DEFAULT 0, last_injected_at TEXT,
  similar_to TEXT DEFAULT '', last_reinforced_at TEXT, success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
`;

const db = new DatabaseSync(':memory:');
db.exec(SCHEMA);
const memory = new MemoryManager(db as unknown as import('better-sqlite3').Database, null as never);

const insProject = (id: string) =>
  db.prepare('INSERT INTO wa_projects (id, name, context_json) VALUES (?,?,?)').run(id, id, '{}');
const insTask = (id: string, pid: string, title: string, ctx: Record<string, unknown>) =>
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, description, context_json) VALUES (?,?,?,?,?)')
    .run(id, pid, title, '导出脚本需保证幂等与可回滚', JSON.stringify(ctx));
const insMem = (
  id: string, pid: string, importance: number, createdAt: string,
  embedding: number[] | null, content: string,
): void => {
  db.prepare(`INSERT INTO wa_memories (id, project_id, task_id, content, embedding, memory_type, importance,
                valence, context_json, use_count, injected_count, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,0,0,?)`)
    .run(id, pid, null, content, embedding ? JSON.stringify(embedding) : null,
      'semantic', importance, 'neutral', JSON.stringify({ experience: 'direct' }), createdAt);
};

const P = 'p-mem';
const EMB = [1, 0, 0];
insProject(P);
insTask('t-emb', P, '实现导出脚本', { task_embedding: EMB });
insTask('t-cue', P, '部署脚本幂等检查', {});

// 近因 5 条（shortTerm = created_at 最新的 5 条）：w-both 同时是最新 + 高重要度；
// w-short 次新；f1–f3 是陪衬（低重要度、向量与查询正交）。
insMem('w-both', P, 0.90, '2026-11-10 00:00:05', EMB, '导出脚本要幂等，失败可回滚。');
insMem('w-short', P, 0.50, '2026-11-10 00:00:04', [0.2, 0.98, 0], '最近一次导出用了临时表。');
insMem('f1', P, 0.10, '2026-11-10 00:00:03', [0, 0, 1], '无关填充一。');
insMem('f2', P, 0.10, '2026-11-10 00:00:02', [0, 0, 1], '无关填充二。');
insMem('f3', P, 0.10, '2026-11-10 00:00:01', [0, 0, 1], '无关填充三。');
// 中层：高重要度但不在最近 5 条里。
insMem('w-mid', P, 0.90, '2026-11-08 00:00:00', EMB, '导出脚本的幂等键取任务 id。');
// 边界标本：0.69 差一点点——必须进不了中层。
insMem('w-below', P, 0.69, '2026-11-07 00:00:00', EMB, '近似阈值的工程笔记。');
// 长尾：语义相关但重要度低、且最久远。
insMem('w-long', P, 0.20, '2026-10-01 00:00:00', EMB, '早年导出脚本的回滚脚本片段。');

function run(): void {
  console.log('\n【A】三层全到：short / mid / long 都进结果');
  const r = memory.retrieveTaskRelevantWithSource('t-emb', P, 5);
  const ids = r.memories.map((m) => m.id);
  ok(ids.includes('w-short'), 'A-1 近因层（short）真进了结果', ids.join(','));
  ok(ids.includes('w-mid'), 'A-2 高重要度层（mid）真进了结果', ids.join(','));
  ok(ids.includes('w-long'), 'A-3 长尾层（long）真进了结果', ids.join(','));
  eq(r.source, 'embedding', 'A-4 来源仍如实标 embedding（有向量时）');
  eq(r.memories.length, 5, 'A-5 总量恰为 topK=5（配额合并不膨胀、不满也不凭空补）');

  console.log('\n【B】去重：最近 + 高重要度同一条只出现一次');
  eq(ids.filter((id) => id === 'w-both').length, 1,
    'B-1 同时满足近因与高重要度的记忆只出现一次（保先出现的层）');

  console.log('\n【C】阈值单源：MID_TERM_IMPORTANCE');
  eq(MID_TERM_IMPORTANCE, 0.7, 'C-1 阈值常量恰为 0.7（单源导出）');
  const layered = memory.retrieveLayered('实现导出脚本', EMB, P, 5);
  const midIds = layered.midTerm.map((m) => m.id);
  ok(midIds.includes('w-mid'), 'C-2 0.70 的标本进中层（正标本）', midIds.join(','));
  ok(!midIds.includes('w-below'), 'C-3 0.69 的标本进不了中层（反标本，边界不是摆设）', midIds.join(','));
  const src = fs.readFileSync(path.join(DESKTOP, 'src/main/core/memory-retrieval.ts'), 'utf-8');
  ok(src.includes('importance >= ${MID_TERM_IMPORTANCE}'),
    'C-4 中层 SQL 用常量拼接（不是第二份字面量）');
  eq(/importance\s*>=\s*0\.7\b/.test(src), false,
    'C-5 反证：SQL 里不再出现写死的 0.7');

  console.log('\n【D】无向量：线索回退与如实为空');
  const cue = memory.retrieveTaskRelevantWithSource('t-cue', P, 5);
  eq(cue.source, 'cue', 'D-1 无 task_embedding ⇒ 走线索回退并如实标 cue');
  ok(cue.memories.length > 0, 'D-2 线索回退真取到内容（不是空跑）', `${cue.memories.length} 条`);
  const none = memory.retrieveTaskRelevantWithSource('t-cue', 'p-nothing', 5);
  eq([none.memories.length, none.source], [0, 'none'], 'D-3 线索也取不到 ⇒ 空集 + none（不整层编造）');

  console.log('\n【E】build 标识与方案在册');
  const { tag } = deriveBuildTag(fs.readFileSync(path.join(DESKTOP, 'src/main/core/agent-executor.ts'), 'utf-8'));
  ok(buildNotOlderThan(tag, SELF_ROUND), 'E-1 build 标识不早于脚本轮次（方向性派生）', `${tag} vs ${SELF_ROUND}`);
  checkBuildPins(ok, { rootDir: ROOT });

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run();
