/**
 * Phase A（程序性记忆→技能）端到端冒烟测试。
 *
 * 用法：先打包再运行（tsx 不可用时用 tsup 打包）：
 *   npx tsup scripts/smoke-phase-a.ts --format esm --platform node --target node22 \
 *     --external @worker-ant/ans-client --external ai --external @ai-sdk/openai \
 *     --out-dir apps/worker-ant-desktop/dist-smoke --clean
 *   node apps/worker-ant-desktop/dist-smoke/smoke-phase-a.mjs
 *
 * 说明：memory-manager.ts 对 better-sqlite3 仅 `import type`（打包即擦除，不依赖原生二进制），
 * 本测试用 Node 内置 node:sqlite 的 DatabaseSync（同步 API 与 better-sqlite3 一致）做内存库，
 * 规避 electron-rebuild 导致的 better_sqlite3.node ABI 与系统 Node 不匹配问题。
 *
 * 覆盖 Phase A 真实链路 + 二次核实修复的 2 处缺陷回归：
 *   1. listSkillDrafts 空 projectId 跨项目查询（此前界面空显示）
 *   2. storeSkillDraft 同名 UNIQUE 约束冲突（此前同名 approved 时 INSERT 崩溃）
 *
 * LLM 蒸馏用 monkey-patch 固定返回，不依赖真实模型（验证的是 DB/注册/执行链路）。
 */
import { createRequire } from 'node:module';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import { executeSkill, listSkills } from '../apps/worker-ant-desktop/src/main/core/skill-registry.js';

// node:sqlite 是较新内置模块，esbuild 会把 `node:sqlite` 改写为 `sqlite`（找不到），
// 故用 createRequire 运行时加载规避。
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path?: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => { all: (...p: unknown[]) => unknown[]; get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => { changes: number; lastInsertRowid: number | bigint } };
  };
};

// ===== 断言与结果统计 =====
let passCount = 0;
let failCount = 0;
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passCount++;
    console.log(`  ✅ ${name}`);
  } else {
    failCount++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ===== 内存数据库 + 最小 schema（对齐 database.ts 的 wa_memories / wa_skills） =====
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
  CREATE TABLE wa_skills (
    id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT DEFAULT '',
    category TEXT DEFAULT 'custom', enabled INTEGER DEFAULT 1, version INTEGER DEFAULT 1,
    config TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    project_id TEXT, status TEXT DEFAULT 'draft'
  );
`);

// ===== 桩 AnsClient（getOptimalModel 返回 null；本测试中 _distillSkillWithLLM 被 monkey-patch，不会真正调用） =====
const ansClient = { getOptimalModel: async () => null } as unknown as import('@worker-ant/ans-client').AnsClient;

const memory = new MemoryManager(db, ansClient);

// ===== monkey-patch LLM 蒸馏：固定返回一个技能草案，绕开真实模型 =====
(memory as unknown as { _distillSkillWithLLM: (members: unknown[]) => Promise<{ name: string; description: string; steps: string[] } | null> })
  ._distillSkillWithLLM = async () => ({ name: 'smoke_skill', description: '冒烟测试技能', steps: ['步骤1：准备', '步骤2：执行'] });

async function main(): Promise<void> {
  console.log('\n===== Phase A 端到端冒烟测试 =====\n');

  // 1. 准备：插入 2 条 success_count≥3 的 procedural 记忆（同 'general' archetype 分组）
  db.prepare(
    "INSERT INTO wa_memories (id, project_id, content, memory_type, success_count, source, context_json) VALUES (?, ?, ?, 'procedural', 3, 'agent_execution', '{}')",
  ).run('m1', 'proj-1', '用 write_file 写入产出文件');
  db.prepare(
    "INSERT INTO wa_memories (id, project_id, content, memory_type, success_count, source, context_json) VALUES (?, ?, ?, 'procedural', 3, 'agent_execution', '{}')",
  ).run('m2', 'proj-1', '先 read_file 定位再 edit_file 精确替换');

  console.log('[1] extractProceduralSkills 生成技能草案');
  const extracted = await memory.extractProceduralSkills('proj-1');
  assert('extracted >= 1', extracted >= 1, `实际=${extracted}`);
  const skillRow = db.prepare("SELECT id, status FROM wa_skills WHERE name = 'smoke_skill'").get() as { id: string; status: string } | undefined;
  assert('wa_skills 已写入 draft', !!skillRow && skillRow.status === 'draft', `row=${JSON.stringify(skillRow)}`);
  const compiled = db.prepare("SELECT context_json FROM wa_memories WHERE id = 'm1'").get() as { context_json: string };
  assert('源记忆标记 skill_compiled', compiled.context_json.includes('skill_compiled'), compiled.context_json);

  console.log('\n[2] listSkillDrafts(projectId) 按项目查询');
  const drafts1 = memory.listSkillDrafts('proj-1');
  assert('返回 1 条草案', drafts1.length === 1, `实际=${drafts1.length}`);
  assert('steps 解析正确', drafts1[0]!.steps.length === 2, `steps=${JSON.stringify(drafts1[0]?.steps)}`);

  console.log('\n[3] listSkillDrafts(undefined) 跨项目查询（回归：bug#1 界面空显示）');
  const draftsAll = memory.listSkillDrafts(undefined);
  assert('空 projectId 也能返回草案', draftsAll.length >= 1, `实际=${draftsAll.length}`);

  console.log('\n[4] approveSkill 注册进 skill-registry');
  const approved = await memory.approveSkill(drafts1[0]!.id);
  assert('approveSkill 返回名称', approved?.name === 'smoke_skill', `返回=${JSON.stringify(approved)}`);
  assert('skill 已注册', listSkills().some(s => s.name === 'smoke_skill'), `skills=${JSON.stringify(listSkills().map(s => s.name))}`);
  const approvedRow = db.prepare("SELECT status FROM wa_skills WHERE id = ?").get(drafts1[0]!.id) as { status: string };
  assert('wa_skills 状态改为 approved', approvedRow.status === 'approved', approvedRow.status);

  console.log('\n[5] storeSkillDraft 同名去重（回归：bug#2 同名 approved 时 UNIQUE 崩溃）');
  let dupCrash = false;
  let dupId = '';
  try {
    dupId = memory.storeSkillDraft('proj-2', { name: 'smoke_skill', description: '重复', steps: ['x'] });
  } catch (e) {
    dupCrash = true;
    console.log(`    (异常: ${(e as Error).message})`);
  }
  assert('未抛 UNIQUE 异常', !dupCrash);
  assert('返回已有 id（去重）', dupId === drafts1[0]!.id, `dupId=${dupId} 原id=${drafts1[0]!.id}`);

  console.log('\n[6] executeSkill 执行已批准技能');
  const execResult = await executeSkill('smoke_skill', '');
  assert('返回提示词型指令', execResult.includes('smoke_skill') && execResult.includes('步骤1'), execResult.slice(0, 120));

  console.log('\n[7] rejectSkill 拒绝新草案');
  const draft2Id = memory.storeSkillDraft('proj-1', { name: 'reject_skill', description: '待拒绝', steps: ['a'] });
  const rejected = memory.rejectSkill(draft2Id);
  assert('rejectSkill 返回 true', rejected === true);
  const rejectedRow = db.prepare("SELECT status FROM wa_skills WHERE id = ?").get(draft2Id) as { status: string };
  assert('状态改为 rejected', rejectedRow.status === 'rejected', rejectedRow.status);

  console.log('\n[8] loadSkillsFromDb 重新加载已批准技能');
  const loaded = await memory.loadSkillsFromDb();
  assert('loaded >= 1（smoke_skill 已批准）', loaded >= 1, `实际=${loaded}`);

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('冒烟测试异常：', err);
  process.exit(1);
});
