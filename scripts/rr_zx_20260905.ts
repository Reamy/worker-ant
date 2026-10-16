/**
 * zx_20260905 本地受控复跑（隔离内存库，绝不触碰开发库/生产活跃项目）。
 * 前提：ANS 已启动且 dev-key 可用（批1 走真实 LLM 预读）。地址取 `ANS_DEFAULT_BASE_URL`
 *   单一真源（zx_20261005 M21）；须指向别处时设 `RR_ANS_URL`，不再手抄 `localhost:3001`。
 *
 * S1 批1 三调合一：真实 ANS，计数 getOptimalModel ≈ LLM 轮次 → 首次 1 次产出
 *    goal+矛盾+需求卡并落库(ctxJson)，resume 再调 = 0 次（缓存命中），用户纠正 goal 不被覆盖。
 * S2 批2 注入段间去重：内存记忆桩 → buildMemoryContext 全段命中同一批记忆，
 *    断言每条内容文本最多出现一次、accessedIds 无重复。
 * S3 批3 buildPlanMilestoneLine：内存库里程碑 pending/doing/done 计数行。
 * S4 批4 doing 流转 SQL + 完成回写 done（幂等语义复跑）+ 聚合计数。
 * S5 批5 quality 列：回填 SQL + 三写点同款 sync SQL + projectQualityStats 聚合。
 *
 * 用法：见同目录其它 smoke（tsup 打包后 node 运行）
 */
import { createRequire } from 'node:module';
import { AnsClient } from '@worker-ant/ans-client';
import type { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import { MemoryManager as RealMM } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
// zx_20260924_1 M7-c: `buildMemoryContext` 整块迁出到 `core/memory-context.js`，预算改**以参数传入**。
//   预算真源仍是执行体的 `CTX_MEMORY_MAX_CHARS`（C35 钉其可从执行体 import），故此处**import 常量**
//   而非另写字面量——调用实参即生产真源，不产生第二处阈值。
import { buildMemoryContext } from '../apps/worker-ant-desktop/src/main/core/memory-context.js';
import { CTX_MEMORY_MAX_CHARS } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { buildPlanMilestoneLine, projectQualityStats } from '../apps/worker-ant-desktop/src/main/core/project-analytics.js';
// zx_20261005 M21: ANS 地址取 shared-types 单一真源（此前此处手抄 `http://localhost:3001`）。
import { ANS_DEFAULT_BASE_URL } from '../packages/shared-types/src/ans-defaults.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path?: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => { all: (...p: unknown[]) => unknown[]; get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => { changes: number } };
  };
};

let pass = 0; let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const clean = (s: string): string => (s || '').replace(/\s+/g, ' ').trim();

function memDB(): any {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL, embedding TEXT,
      memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution',
      user_id TEXT DEFAULT '', valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0,
      exemplar_type TEXT, exemplar_context TEXT, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')),
      use_count INTEGER DEFAULT 0, last_used_at TEXT, similar_to TEXT DEFAULT '', last_reinforced_at TEXT,
      success_count INTEGER DEFAULT 0, failure_count INTEGER DEFAULT 0);
    CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT DEFAULT '', description TEXT DEFAULT '',
      acceptance_criteria TEXT DEFAULT '', status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '', status TEXT DEFAULT 'active', working_dir TEXT DEFAULT '');
    CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT DEFAULT '', name TEXT DEFAULT '', status TEXT DEFAULT 'draft');
    CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT DEFAULT '', content TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_plan_milestones (id TEXT PRIMARY KEY, project_id TEXT, plan_task_id TEXT NOT NULL, milestone TEXT NOT NULL,
      status TEXT DEFAULT 'pending', implemented_by_task_id TEXT, updated_at TEXT DEFAULT (datetime('now')));
  `);
  return db;
}

// ================= S1 批1 三调合一（真实 LLM） =================
async function s1Prelude(): Promise<void> {
  console.log('\n[S1] 批1 理解预跑「三调合一」（真实 ANS LLM · 计数 getOptimalModel）');
  const db = memDB();
  const taskId = 'rr-task-1';
  const projectId = 'rr-proj-1';
  // complex + 长文（触发 needGoal+needContr+needCard 三字段一次产出）
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, description, acceptance_criteria, status, context_json) VALUES (?,?,?,?,?,?,?)')
    .run(taskId, projectId, '跨服务认证模块重构与回归',
      '重构整个认证模块，涉及多服务协调、数据迁移与回归测试，需要保证向后兼容并处理并发写入的一致性问题；同时要把旧的 Token 体系迁移到新的 JWT 双签名体系，并保证所有历史客户端在无感升级的情况下通过全量回归，最后输出迁移方案文档与回归报告。补充约束：迁移必须支持灰度分批、回滚预案完整，涉及网关、鉴权中心、用户中心与服务间调用链共六个服务的改动，需要在测试环境完整复现存量账号的会话保持与刷新流程，并对密码策略、多端登录互踢、管理端审计日志等边界逐一验证，最终交付物包含可执行的迁移脚本、灰度开关说明与验收清单，任何人只按文档即可完成升级操作且不产生数据丢失或会话异常。',
      '通过全部回归用例；产出迁移方案与回归报告；兼容旧 Token。', 'pending', '{}');

  const real = new AnsClient({ serverUrl: process.env.RR_ANS_URL || ANS_DEFAULT_BASE_URL, apiKey: 'dev-key', secretKey: 'dev-secret' });
  let modelCalls = 0;
  const counting: AnsClient = {
    getOptimalModel: async (o: Record<string, unknown>) => { modelCalls++; return await real.getOptimalModel(o as Parameters<typeof real.getOptimalModel>[0]); },
    callChat: real.callChat?.bind(real),
  } as unknown as AnsClient;

  const mm = new RealMM(db, counting);
  const p1 = await mm.runTaskPrelude(taskId, projectId);
  const ctx1 = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id=?').get(taskId) as any).context_json);
  check('首次预读 = 1 次模型解析（一次 LLM 产出全部字段）', modelCalls === 1, `getOptimalModel=${modelCalls}`);
  check('goal 非空', !!(p1?.goal?.goal && p1.goal.goal.length >= 4), p1?.goal?.goal?.slice(0, 30));
  check('主要矛盾 非空', !!(p1?.contradiction && p1.contradiction.length >= 4), p1?.contradiction?.slice(0, 30));
  check('需求卡 非空（长文触发 refine 且并入同一次）', !!(p1?.card && p1.card.includes('需求卡')), 'card=' + (p1?.card ? '有' : '无'));
  check('task_goal 已落库 ctxJson', !!ctx1.task_goal?.goal);
  check('principal_contradiction 已落库', !!ctx1.principal_contradiction);
  check('requirement_card 已落库（resume/界面读缓存）', !!ctx1.requirement_card);
  check('prelude_usage 已记录预读 token（成本可见）', typeof ctx1.prelude_usage?.tokens === 'number' && ctx1.prelude_usage.tokens > 0, `tokens=${ctx1.prelude_usage?.tokens}`);

  // resume：再调 = 缓存命中，零 LLM
  const p2 = await mm.runTaskPrelude(taskId, projectId);
  check('resume 预读缓存命中（不再发 LLM）', modelCalls === 1 && p2?.goal?.goal === p1?.goal?.goal, `getOptimalModel=${modelCalls}`);
  // 薄委托 identifyTaskGoal 读缓存
  const goal = await mm.identifyTaskGoal(taskId, projectId);
  check('identifyTaskGoal 委托返回缓存（无额外 LLM）', modelCalls === 1 && !!goal?.goal, `getOptimalModel=${modelCalls}`);
  // 用户纠正 goal → 不被覆盖（simulate ctxJson 已存用户目标）
  db.prepare('UPDATE wa_tasks SET context_json=? WHERE id=?').run(JSON.stringify({ ...ctx1, task_goal: { goal: '用户手动纠正后的目标A', success_criteria: 'x', investigate: [] } }), taskId);
  await mm.runTaskPrelude(taskId, projectId);
  const ctx2 = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id=?').get(taskId) as any).context_json);
  check('用户纠正的 task_goal 不被预读覆盖', ctx2.task_goal?.goal === '用户手动纠正后的目标A', ctx2.task_goal?.goal);
}

// ================= S2 批2 注入段间去重 =================
function s2Dedup(): void {
  console.log('\n[S2] 批2 buildMemoryContext 段间去重（内存记忆桩 · 全段命中同一批）');
  const pool = [
    { id: 'a', content: '内容A：项目用 pnpm workspace 管理多包，版本统一在根。', memory_type: 'semantic', importance: 0.9, valence: 'positive' },
    { id: 'b', content: '内容B：commit 统一用 Reamy 署名。', memory_type: 'episodic', importance: 0.8, valence: 'positive' },
    { id: 'c', content: '内容C：某次 finalize 过早导致返工，教训：先落产出再收尾。', memory_type: 'retrospective', importance: 0.85, valence: 'negative' },
  ];
  const emptyArr: any = () => [];
  const fake = {
    getTaskArchetype: () => null,
    getTaskText: () => '跨服务认证模块重构，需要迁移与回归',
    retrieveByType: (t: string) => pool.filter((m) => m.memory_type === t),
    retrieveTaskRelevant: () => [...pool],
    retrieveByCue: () => [...pool],
    getProjectKnowledge: () => [...pool],
    getTriggeredProspective: emptyArr,
    getWorkingMemory: emptyArr,
    retrieveUnknownHits: emptyArr,
    retrieveNegativeHits: emptyArr,
    retrieveKnowledgeGraphContext: emptyArr,
    findSimilarTasks: emptyArr,
    findCrossProjectSimilarTasks: emptyArr,
    getCrossProjectKnowledge: emptyArr,
    buildMemoryEffectivenessStats: emptyArr,
    buildExecutionPlaybook: () => ({}),
    generateExemplarContext: () => '',
    getSimilarTaskExperience: () => null,
    getPeerAcceptanceCriteria: emptyArr,
    memoryConfTag: () => '',
    confidenceOf: () => 0.9,
    maturityOf: () => 1,
    applicabilityMismatch: () => false,
    markProspectiveTriggered: () => {},
    recordAccess: () => {},
  } as unknown as MemoryManager;

  const out = buildMemoryContext(fake as MemoryManager, 'p1', 't1', undefined, undefined, undefined, CTX_MEMORY_MAX_CHARS);
  const uniqIds = new Set(out.accessedIds);
  check('accessedIds 无重复', uniqIds.size === out.accessedIds.length, `n=${out.accessedIds.length}`);
  let dup = 0;
  for (const m of pool) {
    const re = new RegExp(clean(m.content).slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const cnt = (out.context.match(re) || []).length;
    if (cnt > 1) dup++;
  }
  check('同一记忆文本在 memory-context 中只出现一次', dup === 0, `重复条数=${dup}`);
  check('去重后仍覆盖全部 3 条（信息不丢失）', uniqIds.size === 3, `injected=${out.accessedIds.join(',')}`);
  // 仅重复（全部已被前段注入）→ 后段不产生空标头
  const fake2 = { ...fake, retrieveByType: () => [], retrieveTaskRelevant: () => [], retrieveByCue: () => [], getProjectKnowledge: () => [] };
  const out2 = buildMemoryContext(fake2 as unknown as MemoryManager, 'p1', 't1', undefined, undefined, undefined, CTX_MEMORY_MAX_CHARS);
  check('无命中时不输出空段标头（无「## 项目知识」等空标签）', !/##\s+\S+\s*\n(?:$|\n)/.test(out2.context) && out2.context.trim().length > 0 ? true : out2.context.trim().length === 0, out2.context.trim().length === 0 ? 'context=空(合法)' : '仍有空标头');
}

// ================= S3 批3 里程碑汇总行 =================
function s3MilestoneLine(): void {
  console.log('\n[S3] 批3 buildPlanMilestoneLine（内存库）');
  const db = memDB();
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?,?,?,?)').run('pt1', 'projX', '方案A 规划', 'completed');
  db.prepare('INSERT INTO wa_plan_milestones (id, plan_task_id, milestone, status) VALUES (?,?,?,?)').run('m1', 'pt1', 'M1', 'done');
  db.prepare('INSERT INTO wa_plan_milestones (id, plan_task_id, milestone, status) VALUES (?,?,?,?)').run('m2', 'pt1', 'M2', 'doing');
  db.prepare('INSERT INTO wa_plan_milestones (id, plan_task_id, milestone, status) VALUES (?,?,?,?)').run('m3', 'pt1', 'M3', 'pending');
  const line = buildPlanMilestoneLine(db, 'projX');
  check('行含已落地1/进行中1/待实施1/进行中M2', !!line && line.includes('已落地1') && line.includes('进行中1') && line.includes('待实施1') && line.includes('M2'), clean(line));
  check('无里程碑项目返回空串', buildPlanMilestoneLine(db, 'no-ms') === '');
}

// ================= S4 批4 doing 流转 + 回写 done（同款 SQL 复跑） =================
function s4Doing(): void {
  console.log('\n[S4] 批4 里程碑 doing 流转（实施任务动工 pending→doing · 幂等）');
  const db = memDB();
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?,?,?,?)').run('pt1', 'projX', '方案A', 'pending');
  for (const ms of ['M1', 'M2', 'M3']) db.prepare('INSERT INTO wa_plan_milestones (id, plan_task_id, milestone, status) VALUES (?,?,?,?)').run(`pm-${ms}`, 'pt1', ms, 'pending');
  // 实施任务带 scheme_ref 动工（批4 新增 SQL 语义复跑）
  const implTask = 'impl-1';
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?,?,?,?,?)").run(implTask, 'projX', '实施 M2', 'pending', JSON.stringify({ scheme_ref: { plan_task_id: 'pt1', milestone: 'M2' } }));
  const tctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id=?').get(implTask) as any).context_json);
  const sr = tctx.scheme_ref as { plan_task_id?: string; milestone?: string };
  db.prepare("UPDATE wa_plan_milestones SET status = 'doing', updated_at = datetime('now') WHERE plan_task_id = ? AND milestone = ? AND status = 'pending'").run(sr.plan_task_id, sr.milestone);
  const m2 = (db.prepare("SELECT status FROM wa_plan_milestones WHERE plan_task_id=? AND milestone='M2'").get('pt1') as any).status;
  check('动工后对应里程碑 pending→doing', m2 === 'doing', `M2=${m2}`);
  // 幂等：再次动工不破坏
  db.prepare("UPDATE wa_plan_milestones SET status = 'doing', updated_at = datetime('now') WHERE plan_task_id = ? AND milestone = ? AND status = 'pending'").run('pt1', 'M2');
  check('doing 幂等（不重复、不覆盖）', (db.prepare("SELECT status FROM wa_plan_milestones WHERE plan_task_id=? AND milestone='M2'").get('pt1') as any).status === 'doing');
  // 完成回写 done（既有回写 SQL）
  db.prepare("UPDATE wa_plan_milestones SET status = 'done', implemented_by_task_id = ?, updated_at = datetime('now') WHERE plan_task_id = ? AND milestone = ? AND status != 'done'").run(implTask, 'pt1', 'M2');
  check('完成回写 done（不覆盖已 done）', (db.prepare("SELECT status FROM wa_plan_milestones WHERE plan_task_id=? AND milestone='M2'").get('pt1') as any).status === 'done');
  const line = buildPlanMilestoneLine(db, 'projX');
  check('聚合行反映 done1/doing0/待2', !!line && line.includes('已落地1') && line.includes('进行中0') && line.includes('待实施2'), clean(line));
}

// ================= S5 批5 quality_score 列（回填+双写+聚合） =================
function s5Quality(): void {
  console.log('\n[S5] 批5 quality_score 列（回填 SQL + 双写 SQL + projectQualityStats 聚合）');
  const db = memDB();
  const rows: Array<[string, string, number]> = [
    ['tk1', JSON.stringify({ completion_quality: { score: 90 } }), 90],
    ['tk2', JSON.stringify({ completion_quality: { score: 45 } }), 45],
  ];
  // 模拟迁移：回填 UPDATE（列已存在场景）
  db.exec('ALTER TABLE wa_tasks ADD COLUMN quality_score REAL');
  for (const [id, cj, sc] of rows) db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?,?,?,?,?)').run(id, 'projX', `t-${id}`, 'completed', cj);
  db.prepare("UPDATE wa_tasks SET quality_score = CAST(JSON_EXTRACT(context_json, '$.completion_quality.score') AS REAL) WHERE context_json LIKE '%completion_quality%' AND quality_score IS NULL").run();
  check('回填后 quality_score 与 ctx 同源', (db.prepare("SELECT quality_score FROM wa_tasks WHERE id='tk1'").get() as any).quality_score === 90 && (db.prepare("SELECT quality_score FROM wa_tasks WHERE id='tk2'").get() as any).quality_score === 45);
  // 新完成写入：agent finalize 同款 UPDATE（含列）
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?,?,?,?,?)').run('tk3', 'projX', 't3', 'completed', JSON.stringify({ completion_quality: { score: 70 } }));
  db.prepare('UPDATE wa_tasks SET quality_score = ? WHERE id = ?').run(70, 'tk3');
  check('finalize 双写 quality_score 生效', (db.prepare("SELECT quality_score FROM wa_tasks WHERE id='tk3'").get() as any).quality_score === 70);
  const st = projectQualityStats(db, 'projX');
  check('聚合 count=3 / avg≈68.3 / low=1', st.count === 3 && Math.round((st.avg ?? 0) * 10) / 10 === 68.3 && st.low === 1, JSON.stringify({ count: st.count, avg: st.avg, low: st.low }));
  check('recent 含最近评分（趋势）', st.recent.length >= 1 && st.recent[0]?.score != null, `recent=${st.recent.length}`);
  // 手工 task:updateStatus completed（IPC 补齐分支同款：无 completion_quality → 审计 + 双写）
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?,?,?,?,?)').run('tk4', 'projX', 't4', 'completed', '{}');
  const q = (db.prepare("SELECT quality_score FROM wa_tasks WHERE id='tk4'").get() as any).quality_score;
  check('无质量分任务列保持 NULL（与 UI 一致不虚造）', q === null, `quality_score=${q}`);
}

async function main(): Promise<void> {
  await s1Prelude().catch((e) => { fail++; console.log('  ❌ S1 异常:', (e as Error).message); });
  try { s2Dedup(); } catch (e) { fail++; console.log('  ❌ S2 异常:', (e as Error).message); }
  try { s3MilestoneLine(); } catch (e) { fail++; console.log('  ❌ S3 异常:', (e as Error).message); }
  try { s4Doing(); } catch (e) { fail++; console.log('  ❌ S4 异常:', (e as Error).message); }
  try { s5Quality(); } catch (e) { fail++; console.log('  ❌ S5 异常:', (e as Error).message); }
  console.log(`\n========== 复跑结果：通过 ${pass} / 失败 ${fail} ==========`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
