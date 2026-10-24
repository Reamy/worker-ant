/**
 * A3 (2026-09-02): 记忆干扰管理 superseded 定向验证（PLAN_zx_20260902.md Phase A3）。
 *
 * 用法：先打包再运行（同其它 smoke）：
 *   npx tsup scripts/smoke-a3-superseded.ts --format esm --platform node --target node22 \
 *     --external @worker-ant/ans-client --external ai --external @ai-sdk/openai --external pino --external pino-pretty --external pino-roll \
 *     --out-dir apps/worker-ant-desktop/dist-smoke --clean
 *   node apps/worker-ant-desktop/dist-smoke/smoke-a3-superseded.mjs
 *
 * 数据库：node:sqlite 内存库(:memory:)，统一 project_id='proj-1'，每测试块间清理。
 * 覆盖：
 *   1. 检索降权：superseded=true 记忆在 retrieveByType 中排位低于同条件正常记忆
 *   2. detectAndResolveConflicts 效价冲突对 → 旧记忆被标 superseded+conflict_flag（待扬弃）
 *   3. 冲突后检索端到端：被取代的旧记忆不再成为注入首选
 *   4. conflict_flag=true 同样触发降权
 *   5. 清除 superseded（模拟扬弃成功）后检索恢复
 */
import { createRequire } from 'node:module';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path?: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => { all: (...p: unknown[]) => unknown[]; get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => { changes: number; lastInsertRowid: number | bigint } };
  };
};

let passCount = 0;
let failCount = 0;
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { passCount++; console.log(`  ✅ ${name}`); }
  else { failCount++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE wa_memories (
    id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT,
    content TEXT NOT NULL, embedding TEXT, memory_type TEXT DEFAULT 'episodic',
    importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution',
    user_id TEXT DEFAULT '', valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}',
    is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT, exemplar_context TEXT, updated_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    use_count INTEGER DEFAULT 0, last_used_at TEXT, similar_to TEXT DEFAULT '',
    last_reinforced_at TEXT, success_count INTEGER DEFAULT 0, failure_count INTEGER DEFAULT 0
  );
`);
const ansClient = { getOptimalModel: async () => null } as unknown as import('@worker-ant/ans-client').AnsClient;
const memory = new MemoryManager(db, ansClient);

const wipe = (): void => { db.prepare("DELETE FROM wa_memories WHERE project_id = 'proj-1'").run(); };
const ins = (id: string, content: string, ctx: string, valence = 'neutral', source = 'agent_execution', createdAt = '2026-09-01 00:00:00'): void => {
  db.prepare("INSERT INTO wa_memories (id, project_id, content, memory_type, importance, source, valence, context_json, created_at) VALUES (?, 'proj-1', ?, 'episodic', 0.5, ?, ?, ?, ?)").run(id, content, source, valence, ctx, createdAt);
};
const ctxOf = (id: string): string => (db.prepare('SELECT context_json FROM wa_memories WHERE id = ?').get(id) as { context_json: string }).context_json;
const topN = (n: number): string[] => memory.retrieveByType('episodic', 'proj-1', n).map(r => (r as unknown as { id: string }).id);

async function main(): Promise<void> {
  console.log('\n===== A3 记忆干扰管理 superseded 验证 =====\n');

  console.log('[1] 检索降权（superseded → 排位下降）');
  wipe();
  ins('ok', 'API 提交表单用 POST 方法', '{}', 'positive');
  ins('sup', 'API 提交表单用 POST 方法（旧经验）', JSON.stringify({ superseded: true }), 'positive');
  assert('retrieveByType top1 = ok（superseded 被降权）', topN(1)[0] === 'ok', `got ${JSON.stringify(topN(1))}`);

  console.log('[2] detectAndResolveConflicts 效价冲突 → 旧记忆标 superseded');
  wipe();
  ins('old', 'the API accepts POST method forms', '{}', 'positive', 'agent_execution', '2026-09-01 00:00:00');
  ins('new', 'the API now requires PUT method forms', '{}', 'negative', 'agent_execution', '2026-09-02 00:00:00');
  const resolved = memory.detectAndResolveConflicts('proj-1');
  assert('检测到 1 对冲突', resolved === 1, `got ${resolved}`);
  const oldCtx = JSON.parse(ctxOf('old')) as Record<string, unknown>;
  assert('旧记忆(positive)被标 superseded=true', oldCtx.superseded === true, JSON.stringify(oldCtx));
  assert('旧记忆(positive)同时被标 conflict_flag=true', oldCtx.conflict_flag === true, JSON.stringify(oldCtx));
  assert('旧记忆(positive)记录 conflict_with 指向新记忆', oldCtx.conflict_with === 'new', JSON.stringify(oldCtx));

  console.log('[3] 冲突后检索端到端不再把被取代的旧记忆当权威');
  wipe();
  ins('old2', 'the API accepts POST method forms', '{}', 'positive', 'agent_execution', '2026-09-01 00:00:00');
  ins('new2', 'the API now requires PUT method forms', '{}', 'negative', 'agent_execution', '2026-09-02 00:00:00');
  memory.detectAndResolveConflicts('proj-1'); // old2 现在 superseded=true
  ins('ctl', '无关控制记忆 reporting tools archive', '{}', 'neutral', 'agent_execution', '2026-09-03 00:00:00');
  const top3 = topN(3);
  assert('被取代的 old2 不再是注入首选', top3[0] !== 'old2', JSON.stringify(top3));

  console.log('[4] conflict_flag=true 同样触发降权');
  wipe();
  ins('cf', '冲突待审记忆 content alpha', JSON.stringify({ conflict_flag: true, conflict_with: 'x' }), 'positive');
  ins('nc', '同条件正常记忆 content alpha', '{}', 'positive');
  assert('retrieveByType top1 = nc（conflict_flag 记忆被降权）', topN(1)[0] === 'nc', `got ${JSON.stringify(topN(1))}`);

  console.log('[5] 清除 superseded（模拟扬弃成功）→ 检索恢复');
  wipe();
  ins('sup2', '某经验 memory alpha', JSON.stringify({ superseded: true }), 'positive');
  ins('nc2', '某经验 memory beta', '{}', 'positive');
  assert('清除前 top1 = nc2', topN(1)[0] === 'nc2', `got ${JSON.stringify(topN(1))}`);
  const c5 = JSON.parse(ctxOf('sup2')) as Record<string, unknown>;
  delete c5.superseded;
  db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(c5), 'sup2');
  const top5 = topN(2);
  assert('清除后 sup2 回到检索前两名（不再降权）', top5.includes('sup2'), JSON.stringify(top5));

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====`);
  process.exit(failCount > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
