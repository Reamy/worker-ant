/**
 * A2 (2026-09-02): 提取实践效应 retrievalPractice 定向验证（PLAN_zx_20260902.md Phase A2）。
 *
 * 用法：先打包再运行（同其它 smoke）：
 *   npx tsup scripts/smoke-a2-retrieval-practice.ts --format esm --platform node --target node22 \
 *     --external @worker-ant/ans-client --external ai --external @ai-sdk/openai --external pino --external pino-pretty --external pino-roll \
 *     --out-dir apps/worker-ant-desktop/dist-smoke --clean
 *   node apps/worker-ant-desktop/dist-smoke/smoke-a2-retrieval-practice.mjs
 *
 * 数据库：node:sqlite 内存库(:memory:)。
 * 覆盖：
 *   1. 关键词召回 + 适用性通过的记忆 use_count +3（提取实践，高于被动 recordAccess +1）
 *   2. 适用条件不匹配（taskText 不含条件关键词）的记忆 → 不加成（防误强化）
 *   3. 适用条件命中 taskText 的记忆 → 正常加固
 *   4. 无关键词交集的无关记忆 → 不召回不加固
 *   5. 空 taskText → 返回 0
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

const useCount = (id: string): number => (db.prepare('SELECT use_count FROM wa_memories WHERE id = ?').get(id) as { use_count: number }).use_count;
const ins = (id: string, content: string, ctx: string): void => {
  db.prepare("INSERT INTO wa_memories (id, project_id, content, memory_type, source, context_json) VALUES (?, 'proj-1', ?, 'episodic', 'agent_execution', ?)").run(id, content, ctx);
};

async function main(): Promise<void> {
  console.log('\n===== A2 提取实践效应 retrievalPractice 验证 =====\n');

  // 准备：4 条记忆
  // m1 适用（无适用条件）：内容含 MCP/服务/部署/连通 等与 taskText 共现 token
  ins('m1', '关键经验：MCP 服务部署后需做连通性测试验证，用 connectivity check', '{}');
  // m2 条件不匹配：内容含 MCP/服务 被召回，但适用条件「老版本协议」关键词不在 taskText → mismatch → 不加成
  ins('m2', 'MCP 服务部署经验，仅适用于老版本协议环境', JSON.stringify({ applicability: { conditions: ['老版本协议'], stability: 'volatile' } }));
  // m3 条件命中：适用条件「连通性」在 taskText 中出现 → 条件满足 → 加固
  ins('m3', 'MCP 部署后连通性验证要点：检查心跳', JSON.stringify({ applicability: { conditions: ['连通性'], stability: 'stable' } }));
  // m4 无关：无关键词交集
  ins('m4', '报销流程整理与凭证归档操作', '{}');

  const taskText = '配置 MCP 服务并验证部署连通性，做 connectivity check';
  console.log('[1] retrievalPractice 主动回忆');
  const practiced = memory.retrievalPractice(taskText, 'proj-1', 5);
  assert('返回加固条数 = 2（m1+m3；m2 条件不匹配跳过；m4 未召回）', practiced === 2, `got ${practiced}`);
  assert('m1（无条件）use_count +3 = 3', useCount('m1') === 3, `got ${useCount('m1')}`);
  assert('m3（条件命中）use_count +3 = 3', useCount('m3') === 3, `got ${useCount('m3')}`);
  assert('m2（条件不匹配）不加成 = 0', useCount('m2') === 0, `got ${useCount('m2')}`);
  assert('m4（无交集）不加成 = 0', useCount('m4') === 0, `got ${useCount('m4')}`);

  console.log('[2] 空 taskText 短路');
  assert('返回 0', memory.retrievalPractice('', 'proj-1', 5) === 0);

  console.log('[3] 二次主动回忆同一任务 → 加固累积（模拟多次主动回忆）');
  const p2 = memory.retrievalPractice(taskText, 'proj-1', 5);
  assert('再次返回 2', p2 === 2, `got ${p2}`);
  assert('m1 use_count 累积 = 6', useCount('m1') === 6, `got ${useCount('m1')}`);

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====`);
  process.exit(failCount > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
