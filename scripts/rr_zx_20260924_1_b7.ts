/**
 * zx_20260924_1 M7（F9 + F10，裁定 J-4）受控复跑 —— 「一把量真活的尺子 + `buildMemoryContext` 外迁」。
 *
 * F9 的病根：`CTX_MEMORY_MAX_CHARS` / `CTX_PROJECT_MAX_CHARS` / `CTX_HISTORY_TAIL_MAX_CHARS` 三个预算
 * **从未在真装配路径上被量过**——记忆面的取舍（段优先级表 / `selectMemorySections` / 预算算式）与预算真源
 * 分散在执行体里，谁都答不上"这一次到底塞了多少字、丢了几段、丢的顺序对不对"。
 * 本套件就是那把尺子：**真 MemoryManager（内存库真行）× 真 `buildMemoryContext` × 真 `buildTaskContext`**，
 * 量出三个面各自的总量并断言 ≤ 各自预算，且量出丢段的**顺序**（low→mid→high、至少留 1 段）。
 *
 * F10 的改法：`buildMemoryContext` + 段优先级表 + `selectMemorySections` + `memoryConfTag` 整块
 * 从 `agent-executor.ts` 迁到 `core/memory-context.ts`，预算**以参数传入**（真源仍是执行体的
 * `CTX_MEMORY_MAX_CHARS` 一处）⇒ 新模块零依赖执行体，无循环 import。
 *
 * §不变式门：
 *   G-1 **真源在位（直 import 判型）**：`buildMemoryContext` / `selectMemorySections` / `MEM_OVERHEAD`
 *       从新模块 import，三个 `CTX_*` 从执行体 import——被删/改名 ⇒ **编译期失败**，而不是"扫了个空、静默假绿"。
 *   G-2 **真装配不是等价自造**：夹具是**真 `MemoryManager` 类 × 内存库真行**（且按本仓纪律
 *       **先 `new` 服务类再插行**——FTS 同步触发器建于行后会抛错并被 `try/catch` 吞成假绿），
 *       经**真检索谓词**（`retrieveByType` / `getProjectKnowledge` / `getWorkingMemory` …）产出 `memoryContext`。
 *   G-3 **两只标本**：每条判据两侧都有真标本（超预算 ⇒ 丢段 / 预算充足 ⇒ 一段不丢；截断器真截 / 真不截）。
 *   G-4 **计数器正面断言**：`recordAccess` 断言 `use_count` 由 0 变 ≥1，不只断言"不抛"。
 *
 * ⚠ 本脚本**不写**轮次字面量（`scripts/lib/rr-pins.ts` 的 P5 逐处点名 file:line）。
 * ⚠ 末尾 build 钉读 `dist` ⇒ 常规须 tsup 先于本脚本。**本批刻意不跑 tsup**（并发纪律）：
 *   `dist` 内的 `build` 值与本批无关（本批未动 `build` 标识），产物级"含新模块 chunk"结转 M11。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { buildMemoryContext, selectMemorySections, MEM_OVERHEAD, MEM_SECTION_PRIORITY, type MemSection } from '../apps/worker-ant-desktop/src/main/core/memory-context.js';
import { buildTaskContext } from '../apps/worker-ant-desktop/src/main/core/exec-context.js';
import {
  CTX_HISTORY_TAIL_MAX_CHARS, CTX_MEMORY_MAX_CHARS, CTX_PROJECT_MAX_CHARS, type AgentContext,
} from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import type { AdaptiveStrategy, ComplexityLevel, TaskArchetype } from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const MAIN = path.join(root, `${A}/src/main`);
const RD = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
const noComment = (f: string) => stripKeepingLines(RD(f)).join('\n');

/**
 * 夹具 schema——照抄 `database.ts` 的运行时形状（基础 DDL 27–89 行 + 205–213 行的 `ALTER TABLE` 增列）。
 * ⚠ 与 `rr_zx_20260913_4.ts` 同一把尺；**比生产宽或窄都是假的**：宽则断言只是自我印证，
 *   窄则读语句抛错被 `catch` 吞成空数组（`retrieveByType` 等全是 `try/catch { return [] }`）⇒ 假绿。
 */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}',
  sandbox_mode TEXT DEFAULT 'workspace', autonomous_mode TEXT DEFAULT 'off',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '', source TEXT DEFAULT 'user',
  acceptance_criteria TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
  embedding TEXT, memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5,
  reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '',
  valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0,
  exemplar_type TEXT, exemplar_context TEXT, use_count INTEGER DEFAULT 0, last_used_at TEXT,
  injected_count INTEGER DEFAULT 0, last_injected_at TEXT,
  similar_to TEXT DEFAULT '', last_reinforced_at TEXT, success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL,
  name TEXT DEFAULT '', file_path TEXT, status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_project_knowledge (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, section TEXT NOT NULL,
  content TEXT NOT NULL, source_ref TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_wa_project_knowledge_sec ON wa_project_knowledge(project_id, section);
-- zx_20261022_3 批七/批八：listProjectKnowledge 会**并读**导入册；buildMemoryContext 还会读画像。
--   ⚠ 缺表 ⇒ 读语句抛错被上层 catch 吞掉 ⇒ 「项目域知识」段整段消失（本套件实测：段数 7→6、
--     A-2 的"丢段"前提也不成立）。生产有这三张表，夹具必须同形。
CREATE TABLE wa_project_knowledge_imports (
  project_id TEXT NOT NULL, section TEXT NOT NULL, content TEXT NOT NULL,
  precedence INTEGER NOT NULL DEFAULT 0, source_hash TEXT NOT NULL DEFAULT '',
  imported_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, section));
CREATE TABLE wa_knowledge_imports (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_project_id TEXT DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'merge',
  sections INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0, conflicts INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_project_profiles (
  project_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
  source_hash TEXT NOT NULL DEFAULT '', profile_json TEXT NOT NULL,
  generated_at TEXT DEFAULT (datetime('now')), enabled INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'local', source_project_name TEXT DEFAULT '');
`;
type AnyDb = import('better-sqlite3').Database;

// ═════════════════════════════════════════════════════════════════════════
// 夹具：**先 `new` 服务类（建 FTS 触发器）再插行**——顺序颠倒则首次 UPDATE 命中未索引 rowid、
// 抛错被 `try/catch` 吞掉 ⇒ `recordAccess` 断言假绿（本仓明写的纪律）。
// ═════════════════════════════════════════════════════════════════════════
const PROJECT = 'p-ruler';
const TASK = 't-ruler';
/**
 * 段内正文默认 300 字——段渲染处写的是 `content.slice(0, 300)`，够长才能量到**真实占位**（不致虚小）。
 * `reps` 可调：E-1 需要一段**短于 300** 的正文，好让"逐字在场"这条判据不被切片本身搅成假红。
 */
const BODY = (n: string, reps = 75) => `${n}：` + '内容正文'.repeat(reps);

const db = new DatabaseSync(':memory:');
db.exec(SCHEMA);
const memory = new MemoryManager(db as unknown as AnyDb, null as never); // ← 触发器在此建成
db.prepare('INSERT INTO wa_projects (id, name, context_json) VALUES (?,?,?)').run(PROJECT, '量尺项目', '{}');
db.prepare('INSERT INTO wa_tasks (id, project_id, title, description, context_json) VALUES (?,?,?,?,?)')
  .run(TASK, PROJECT, '量一量记忆面到底塞了多少', '为记忆装配立一把端到端的尺子',
    JSON.stringify({ archetype: 'document', working_memory: Array.from({ length: 7 }, (_, i) => ({ content: BODY(`工作记忆${i + 1}`), ts: '2026-09-24T00:00:00Z' })) }));
const addMem = (id: string, type: string, content: string, importance = 0.8) =>
  db.prepare(`INSERT INTO wa_memories (id, project_id, task_id, content, memory_type, importance, valence, context_json, use_count)
              VALUES (?,?,?,?,?,?,?,?,0)`)
    .run(id, PROJECT, TASK, content, type, importance, 'neutral', JSON.stringify({ experience: 'direct' }));
// 段位布置（段名 → 优先级见新模块的 `MEM_SECTION_PRIORITY`）：
//   项目域知识(low) 1 段 · 任务关键约束(high) · 任务立志(high) · 项目知识(mid) 5 条
//   · 近期经验(mid) 3 条 · 高频复用知识(mid) 1 条 · 工作记忆(high) 7 条  ⇒ **共 7 段**
// zx_20261014_4 批五：低优先段的**新载体**是「项目域知识」（零 LLM 派生事实册，§K）——
//   原 `memory_type='panorama'` 的 §0 注入段已退役。册子存 `wa_project_knowledge`，
//   经 `listProjectKnowledge` 读出、`selectKnowledgeForInject`（400-token 内界）择节入文；
//   故本夹具须**照搬生产表**（rr 纪律：夹具比生产窄 ⇒ 读语句抛错被 try/catch 吞成假绿 ⇒ 段数虚少、判据假红）。
db.prepare(`INSERT INTO wa_project_knowledge (id, project_id, section, content, source_ref) VALUES (?,?,?,?,?)`)
  .run('k-1', PROJECT, 'entities', '全景' + 'P'.repeat(1200), 'wa_knowledge_triples');
// 8 条语义 + 3 条程序：`项目知识`（语义3∪程序3 按重要度取前 5）会切掉 s3，
//   而 `高频复用知识`（同表 semantic、按自己的尺取前 3）恰好把它当**新鲜**的一条接住 ⇒ 两段并存。
for (let i = 1; i <= 8; i++) addMem(`r-sem${i}`, 'semantic', BODY(`语义知识${i}`), 0.90 - (i - 1) * 0.05);
for (let i = 1; i <= 3; i++) addMem(`r-pro${i}`, 'procedural', BODY(`程序经验${i}`), 0.95 - (i - 1) * 0.01);
for (let i = 1; i <= 3; i++) addMem(`r-epi${i}`, 'episodic', BODY(`情景经验${i}`));

/** 段名＝上下文里 `## 名` 那一行（剥掉 `（…）` 括注，好与优先级表对上）。 */
const sectionsOf = (ctx: string) => [...ctx.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.replace(/（.*$/, ''));
const omittedOf = (ctx: string) => {
  const m = ctx.match(/（记忆预算：已省略 \d+ 段：([^）]*)）/);
  return m ? m[1]!.split('、') : [];
};
const dupStats = (ctx: string) => {
  // 段内编号前缀（`1. ` / `2. `）不算差异——同一内容被复述两遍时，两行的差别正在这里
  const seen = new Map<string, number>();
  for (const line of ctx.split('\n')) {
    const t = line.replace(/^\d+\.\s*/, '').trim();
    if (t.length >= 40) seen.set(t, (seen.get(t) ?? 0) + 1);
  }
  let dupLines = 0; let dupChars = 0;
  for (const [t, n] of seen) if (n > 1) { dupLines += n - 1; dupChars += (n - 1) * t.length; }
  return { dupLines, dupChars };
};

/** 主要矛盾/立志两句的自由文本长度（量尺的压力来源之一；调它即调"总量是否超预算"）。 */
const RECONCILE = '矛盾' + 'M'.repeat(120);
const GOAL = '目标' + 'G'.repeat(60);
const CRIT = '标准' + 'S'.repeat(60);
const RANK: Record<string, number> = { low: 0, mid: 1, high: 2 };
const rankOf = (n: string) => RANK[MEM_SECTION_PRIORITY[n] ?? 'mid']!;
/** 该次装配里"留/丢"两集是否**可排序**：丢的每个优先级都不高于留的每个（顺序不可颠倒）。 */
const orderHolds = (names: string[], omitted: string[]) => {
  const kept = names.filter((n) => !omitted.includes(n));
  if (omitted.length === 0 || kept.length === 0) return true;
  return Math.max(...omitted.map(rankOf)) <= Math.min(...kept.map(rankOf));
};

/** 主体包在 async 里：`buildTaskContext` 是 async，而本仓 rr 以 CJS 跑，顶层 await 不可用。 */
async function main(): Promise<void> {
// ═════════════════════════════════════════════════════════════════════════
console.log('\n【A】真装配尺子：记忆面总量 ≤ 预算，且超限时按 low→mid→high 丢段');
let memCtx = '';
{
  // A-0 计数器正面断言（0 → ≥1）：装配的副作用真落到真行上。
  // zx_20261018_3 批一（管子·度量衡）：**注入与使用分账**——装配写的是 `injected_count`，
  //   `use_count`（主动引用）必须**一动不动**。两只标本同钉：该动的 0→≥1，不该动的恒 0。
  const beforeInj = (db.prepare('SELECT COUNT(*) c FROM wa_memories WHERE injected_count > 0').get() as { c: number }).c;
  const beforeUse = (db.prepare('SELECT COUNT(*) c FROM wa_memories WHERE use_count > 0').get() as { c: number }).c;
  const r = buildMemoryContext(memory, PROJECT, TASK, RECONCILE,
    { goal: GOAL, success_criteria: CRIT, investigate: ['调查一'] }, undefined, CTX_MEMORY_MAX_CHARS);
  const afterInj = (db.prepare('SELECT COUNT(*) c FROM wa_memories WHERE injected_count > 0').get() as { c: number }).c;
  const afterUse = (db.prepare('SELECT COUNT(*) c FROM wa_memories WHERE use_count > 0').get() as { c: number }).c;
  memCtx = r.context;
  ok(beforeInj === 0 && afterInj >= 1, 'A-0 计数器**正面断言**：装配后 `injected_count>0` 的行由 0 → ≥1（不只断言"不抛"）',
    `${beforeInj} → ${afterInj} 行`);
  ok(beforeUse === 0 && afterUse === 0, 'A-0c **分账反证**：注入不冒充使用——`use_count>0` 的行数恒 0',
    `${beforeUse} → ${afterUse} 行`);
  ok(r.meta.sections >= 7, 'A-0b 扫描面自证：夹具真产出了 ≥7 段（"丢段顺序"这类判据的前提是段真的存在）',
    `实测 ${r.meta.sections} 段：${sectionsOf(memCtx).join(' | ')}`);

  // A-1 尺子主断言：真装配产物的总量 ≤ 预算（预算取**执行体的真源常量**，不是抄来的 6000）
  ok(memCtx.length <= CTX_MEMORY_MAX_CHARS,
    `A-1 真装配产出的记忆面 **≤ ${CTX_MEMORY_MAX_CHARS} 字符**（装配前从未被量过的那一面）`,
    `实测 ${memCtx.length} 字符 · 段内有效预算 ${CTX_MEMORY_MAX_CHARS - MEM_OVERHEAD}`);

  // A-2 压力真的存在（否则 A-1 是"夹具喂得太小"的恒真）
  ok(r.meta.omitted >= 1 && r.meta.kept >= 1,
    'A-2 「该命中」标本：夹具总量**确实超出**预算 ⇒ 丢了 ≥1 段、且**至少留 1 段**（空上下文永不出现）',
    `段 ${r.meta.sections} = 留 ${r.meta.kept} + 丢 ${r.meta.omitted} · 省略注记 [${omittedOf(memCtx).join('、')}]`);

  // A-3 丢段顺序（端到端面）：丢掉的全是 low ⇒ "只要能丢 low 就不碰 mid/high"
  const names = sectionsOf(memCtx);
  const omittedNames = omittedOf(memCtx);
  const omittedPriority = omittedNames.map((n) => MEM_SECTION_PRIORITY[n] ?? 'mid');
  const keptPriority = names.filter((n) => !omittedNames.includes(n)).map((n) => MEM_SECTION_PRIORITY[n] ?? 'mid');
  // zx_20261018_3 批一：`项目域知识` 已升 mid，本夹具不再有 low 段（记忆有效性无样本、无跨项目知识）
  //   ⇒ 超预算时**先丢中优先段**是新的真值；但 high（最贴任务者）仍一段不碰。
  ok(omittedPriority.length >= 1 && omittedPriority.every((p) => p === 'mid') && orderHolds(names, omittedNames),
    'A-3 丢段顺序（端到端）：本夹具无 low 段 ⇒ **丢的全是 mid，一段 high 都没碰**；'
    + '且"丢的每个优先级都不高于留的每个"（"丢了 mid 却留着 low"在本条下必红）',
    `段名 [${names.join('、')}] · 丢 [${omittedNames.join('、')}] ${JSON.stringify(omittedPriority)} · 留 ${JSON.stringify(keptPriority)}`);
  ok(names.includes('项目域知识'),
    'A-3c 本项目事实（项目域知识）保住——升 mid 后不再当泛化背景先舍',
    `省略段 [${omittedNames.join('、')}]`);
  ok(memCtx.includes('（记忆预算：已省略'), 'A-3b 越界**如实标注**（省略几段、分别是哪些段名）——不静默掐尾');

  // A-4 反证标本：预算给足 ⇒ **一段都不丢**（截断/取舍器不是恒丢）
  const roomy = buildMemoryContext(memory, PROJECT, TASK, null, null, undefined, 100_000);
  ok(roomy.meta.omitted === 0 && roomy.meta.kept === roomy.meta.sections
    && !roomy.context.includes('（记忆预算：已省略'),
    'A-4 「该不命中」标本：预算给足（100000）⇒ 丢段数 **0**、一段不少，省略注记**不出现**',
    `丢 ${roomy.meta.omitted} · 留 ${roomy.meta.kept}/${roomy.meta.sections} · ${roomy.context.length} 字符`);

  // A-5 预算收紧 ⇒ 丢段集合按 low→mid→high **单调生长**（同一夹具、三档预算，真装配各跑一遍）
  const sweep = [CTX_MEMORY_MAX_CHARS, 3000, 800].map((b) => {
    const q = buildMemoryContext(memory, PROJECT, TASK, RECONCILE,
      { goal: GOAL, success_criteria: CRIT, investigate: [] }, undefined, b);
    const nm = sectionsOf(q.context);
    const om = omittedOf(q.context);
    return { b, nm, om, kept: q.meta.kept, len: q.context.length, ok: orderHolds(nm, om) };
  });
  const grows = sweep.every((s) => s.om.length >= 1 && s.kept >= 1 && s.len <= s.b && s.ok);
  const monotone = sweep[0]!.om.every((n) => sweep[1]!.om.includes(n)) && sweep[1]!.om.every((n) => sweep[2]!.om.includes(n));
  ok(grows && monotone,
    'A-5 三档预算（真源 / 3000 / 800）下**至少留 1 段、总量仍 ≤ 各自预算**，丢段顺序三档都成立，'
    + '且丢段集合**逐档单调生长**（预算越小丢得越多；后一档丢的必含前一档丢的）',
    sweep.map((s) => `@${s.b}: 留${s.kept} 丢[${s.om.join('、')}] ${s.len}字`).join(' | '));
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【B】丢段顺序的单元侧（同尺；`selectMemorySections` 是那顺序的唯一实现）');
{
  const S = (name: string, p: 'low' | 'mid' | 'high', n: number): MemSection =>
    ({ name, priority: p, text: 'x'.repeat(n) });
  const three = [S('低', 'low', 500), S('中', 'mid', 500), S('高', 'high', 500)];
  const roomy = selectMemorySections(three, 10_000);
  ok(roomy.omitted.length === 0 && roomy.kept.length === 3,
    'B-1 「该不命中」标本：预算充足 ⇒ 三段全留（取舍器不是恒丢）', `留 ${roomy.kept.length}/3`);
  const one = selectMemorySections(three, 1100);
  ok(one.omitted.map((s) => s.name).join() === '低',
    'B-2 只差一点 ⇒ 丢的**恰是 low**（不是"丢最后一个"）', `丢 [${one.omitted.map((s) => s.name).join('、')}]`);
  const two = selectMemorySections(three, 600);
  ok(two.omitted.map((s) => s.name).join('、') === '低、中' && two.kept.map((s) => s.name).join() === '高',
    'B-3 再紧 ⇒ 丢 low→mid，**high 仍在**（顺序不可颠倒：不存在"丢了 mid 留着 low"）',
    `丢 [${two.omitted.map((s) => s.name).join('、')}] 留 [${two.kept.map((s) => s.name).join('、')}]`);
  const floor = selectMemorySections(three, 0);
  ok(floor.kept.length === 1 && floor.kept[0]!.name === '高',
    'B-4 预算为 0 ⇒ **仍留恰 1 段**，且留的是优先级最高者（同级内保留更靠前的"主干"）',
    `留 [${floor.kept.map((s) => s.name).join('、')}] 丢 ${floor.omitted.length} 段`);
  const tie = selectMemorySections([S('前', 'mid', 500), S('后', 'mid', 500)], 0);
  ok(tie.kept.length === 1 && tie.kept[0]!.name === '前',
    'B-5 同级内后位先丢（保留更靠前的表述）——顺序表里"同级按位置"那一半', `留 [${tie.kept.map((s) => s.name).join('、')}]`);
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【C】端到端装配（真 `buildTaskContext`）：记忆/项目/历史尾三个面各自 ≤ 各自预算');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr_b7_'));
{
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(tmpDir, `目录内容占位文件名-${i}-${'n'.repeat(30)}.txt`), 'x');
  const terminology: Record<string, string> = {};
  for (let i = 0; i < 200; i++) terminology[`术语词条${i}`] = `释义${'详'.repeat(45)}`;
  const recentConversations = Array.from({ length: 30 }, (_, i) => ({
    role: i % 7 === 3 ? 'tool' : i % 2 === 0 ? 'user' : 'assistant',
    content: `历史第${i}条：` + '对话正文'.repeat(175), // ≈700 字/条 ⇒ 合计 ≈21000 > 9000
  }));
  recentConversations.push({ role: 'system', content: '[系统恢复] 这一条**应按约定跳过**，不得进回放' });

  const asm = await buildTaskContext({
    ctx: { memory, dataDir: tmpDir } as unknown as AgentContext,
    db: db as unknown as AnyDb,
    taskId: TASK, projectId: PROJECT,
    project: { sandbox_mode: 'off' },
    workingDir: tmpDir,
    title: '量尺任务', description: '把记忆面/项目面/历史尾三面各量一遍',
    archetype: 'document' as TaskArchetype,
    adaptiveStrategy: { label: '文档', priorityTools: [] } as unknown as AdaptiveStrategy,
    complexityLevel: 'simple' as ComplexityLevel,
    userPrefs: '', memoryContext: memCtx, successContext: '', subagentSystemPrompt: undefined,
    projCtxJson: { language_game: { terminology, conventions: ['约定甲', '约定乙'] } },
    maxTokens: 100_000, maxCost: 0, costSrc: 'none', costGateActive: false,
    historySummary: '', recentConversations,
  });
  const text = (m: { content: unknown }) => String(m.content ?? '');
  const memMsg = asm.messages.find((m) => text(m).startsWith('<memory-context>'));
  const projMsg = asm.messages.find((m) => text(m).startsWith('<project-context>'));
  const histMsgs = asm.messages.filter((m) => m.role === 'user' || m.role === 'assistant');

  ok(!!memMsg && text(memMsg).length <= CTX_MEMORY_MAX_CHARS,
    `C-1 记忆面 system 消息 **≤ ${CTX_MEMORY_MAX_CHARS} 字符**（真装配产物经真装配路径，不放大）`,
    memMsg ? `${text(memMsg).length} 字符（装配产出 ${memCtx.length}）` : '**未找到记忆面消息**');
  ok(asm.projectCtx.length > CTX_PROJECT_MAX_CHARS && !!projMsg && text(projMsg).length <= CTX_PROJECT_MAX_CHARS,
    `C-2 项目面 system 消息 **≤ ${CTX_PROJECT_MAX_CHARS} 字符**，且**截断前**的项目上下文确实超预算（压力是真的）`,
    `截断前 ${asm.projectCtx.length} → 消息 ${projMsg ? text(projMsg).length : -1} 字符`);
  const histChars = sum(histMsgs.map((m) => text(m).length));
  ok(histChars <= CTX_HISTORY_TAIL_MAX_CHARS && histChars > 0,
    `C-3 历史尾回放 **≤ ${CTX_HISTORY_TAIL_MAX_CHARS} 字符**（无 LLM 摘要那一路的容量口径）`,
    `回放 ${histMsgs.length} 条 / ${histChars} 字符（输入 ${sum(recentConversations.map((c) => c.content.length))} 字符）`);
  ok(asm.messages.some((m) => text(m).includes('[历史截断]'))
    && !asm.messages.some((m) => text(m).includes('[系统恢复]')),
    'C-3b 截断**如实交代**（`[历史截断]` 在场），且 `[系统恢复]` 那条按约定**跳过**（不重复回放）',
    `截断注记 ${asm.messages.filter((m) => text(m).includes('[历史截断]')).map(text).join(';')}`);
  ok(asm.summaryOnly === false, 'C-3c 无 LLM 摘要 ⇒ `summaryOnly=false`（走的是保尾回放那一路，本批的量在它上面）');

  // C-4 「该不命中」标本：预算内的输入**不被截断**（三个面各一只）
  const small = await buildTaskContext({
    ctx: { memory, dataDir: tmpDir } as unknown as AgentContext,
    db: db as unknown as AnyDb, taskId: TASK, projectId: PROJECT,
    project: { sandbox_mode: 'off' }, workingDir: tmpDir,
    title: '小任务', description: '短', archetype: 'document' as TaskArchetype,
    adaptiveStrategy: { label: '文档', priorityTools: [] } as unknown as AdaptiveStrategy,
    complexityLevel: 'simple' as ComplexityLevel,
    userPrefs: '', memoryContext: memCtx, successContext: '', subagentSystemPrompt: undefined,
    projCtxJson: {}, maxTokens: 100_000, maxCost: 0, costSrc: 'none', costGateActive: false,
    historySummary: '', recentConversations: [{ role: 'user', content: '短历史' }],
  });
  const st = (m: { content: unknown }) => String(m.content ?? '');
  ok(small.messages.some((m) => st(m) === memCtx) && small.projectCtx.length < CTX_PROJECT_MAX_CHARS,
    'C-4 「该不命中」标本：项目面/历史尾都在预算内 ⇒ **逐字原样**（记忆面消息 === 装配产物，一字未改）',
    `项目面 ${small.projectCtx.length} 字符 · 记忆面原样 ${small.messages.some((m) => st(m) === memCtx)}`);
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【D】外迁落点（源码级：形随符号走，不按行号）');
{
  const memSrc = noComment(`${A}/src/main/core/memory-context.ts`);
  const exSrc = noComment(`${A}/src/main/core/agent-executor.ts`);
  const moved = ['buildMemoryContext', 'selectMemorySections', 'memoryConfTag'];
  const gone = moved.filter((s) => !exSrc.includes(`function ${s}(`));
  // 「该命中」标本：一只**明知仍在执行体**的函数——扫描器必须对它说"在"，否则"零处"可能只是扫描器恒假
  const probe = exSrc.includes('function assessCompletionQuality(');
  ok(gone.length === moved.length && probe,
    'D-1 三个函数**定义**已不在执行体里（零处），且扫描器对一只**明知仍在执行体**的标本判"在"——'
    + '**两只标本都试过**，故"零处"不是"扫了个空"',
    `执行体零处 ${gone.length}/${moved.length} · 在册标本 ${probe}`);
  const present = moved.every((s) => memSrc.includes(`export function ${s}(`))
    && memSrc.includes('export const MEM_OVERHEAD = 220')
    && memSrc.includes('export const MEM_SECTION_PRIORITY')
    && memSrc.includes('export interface MemSection');
  ok(present, 'D-2 新模块以 `export` 给出搬迁的符号（含 `MEM_OVERHEAD` 由局部常量上提为模块级导出）——rr 直引面不破');

  // D-3 预算真源仍是**一处**：新模块零 `CTX_MEMORY_MAX_CHARS`、零 6000 字面量（预算以参数传入 ⇒ 无循环 import）
  ok(!memSrc.includes('CTX_MEMORY_MAX_CHARS') && !/\b6000\b/.test(memSrc),
    'D-3 新模块**不引**预算常量、也不写第二份 6000 —— 预算真源仍在执行体**一处**（`memory-context ⇄ agent-executor` 无环）',
    `提及预算常量 ${memSrc.includes('CTX_MEMORY_MAX_CHARS')} · 出现 6000 ${(memSrc.match(/\b6000\b/g) || []).length} 处`);
  ok(/budgetChars: number/.test(memSrc) && !/budgetChars\s*(\?|=[^=])/.test(memSrc),
    'D-3b 预算参数是**必填**（`budgetChars: number`）：既无默认值（那会是第二处预算真源）、也不可省（省即静默漏传）');
  ok(memSrc.includes('budgetChars - MEM_OVERHEAD'),
    'D-3c 算式在场：`selectMemorySections(parts, Math.max(0, budgetChars - MEM_OVERHEAD))`（预算 − 包裹开销）');
  const callSites = [...exSrc.matchAll(/buildMemoryContext\(/g)].length;
  ok(callSites === 1 && /buildMemoryContext\([^;]*CTX_MEMORY_MAX_CHARS\s*\)/s.test(exSrc),
    'D-4 执行体的调用点**恰一处**，且把 `CTX_MEMORY_MAX_CHARS` 当实参传下去（生产走的是同一处真源，不是另写的数）',
    `调用点 ${callSites} 处`);
  ok(/export const CTX_MEMORY_MAX_CHARS = 6000/.test(exSrc),
    'D-5 执行体**仍导出** `CTX_MEMORY_MAX_CHARS`（C35 钉的是"可从执行体 import"——本脚本开头就直 import 了它）');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【E】M7-d 先量再改：真装配产物里的「实证重复」');
{
  // E-1 量尺自证（该命中标本）：**id 不同、内容逐字相同**的两条记忆 ⇒ 段内按 id 去重拦不住 ⇒ 量尺必须报出重复
  const d2 = new DatabaseSync(':memory:');
  d2.exec(SCHEMA);
  const mem2 = new MemoryManager(d2 as unknown as AnyDb, null as never);
  d2.prepare('INSERT INTO wa_projects (id, name) VALUES (?,?)').run('p2', '重复项目');
  d2.prepare('INSERT INTO wa_tasks (id, project_id, title, description) VALUES (?,?,?,?)').run('t2', 'p2', '任务', '描述');
  // 内容须**短于装配的 300 字切片**，否则 `includes(twin)` 这条"该命中"判据会被切片本身弄假：
  // 判据要验的是"同内容两条都入文"，不是"装配不切片"。
  const twin = BODY('逐字相同的经验', 60);
  for (const id of ['d-a', 'd-b']) {
    d2.prepare(`INSERT INTO wa_memories (id, project_id, task_id, content, memory_type, importance, context_json, use_count)
                VALUES (?,?,?,?,?,?,?,0)`).run(id, 'p2', 't2', twin, 'episodic', 0.8, '{}');
  }
  const dupCtx = buildMemoryContext(mem2, 'p2', 't2', null, null, undefined, CTX_MEMORY_MAX_CHARS).context;
  const dupHit = dupStats(dupCtx);
  ok(dupCtx.includes(twin) && dupHit.dupLines >= 1 && dupHit.dupChars >= twin.length,
    'E-1 「该命中」标本：id 不同的**同内容**两条记忆双双入文 ⇒ 量尺报出重复（否则量尺恒 0 = 扫了个空、E-2 的 0 毫无意义）',
    `重复行 ${dupHit.dupLines} 条 / ${dupHit.dupChars} 字符`);

  // E-2 诚实标本：本套件 A 段那把尺子的产物（真库真行、内容各异）
  const honest = dupStats(memCtx);
  ok(honest.dupChars === 0,
    'E-2 诚实标本：真装配产物里**逐字重复的字符数为 0**（内容各异的真记忆 ⇒ 段内按 id 去重已够）',
    `重复行 ${honest.dupLines} 条 / ${honest.dupChars} 字符 · 上下文 ${memCtx.length} 字符`);

  // E-3 处置：量不出实证重复 ⇒ **本轮不改**（不是"忘了做"）
  ok(honest.dupChars === 0 && dupHit.dupChars > 0,
    'E-3 **处置**：M7-d（段内按内容去重）**本轮不改** —— 尺子量得动（E-1 报得出重复）、而诚实输入量出的重复为 **0**；'
    + '§1.18 的真标本同向（记忆面 1482/417 字符、丢段 0，真正的大头是工具面 17467 字符 ⇒ 已登记为 §4.1 B-15 下一轮候选）');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【S】build 钉（派生核对，不写轮次字面量；**不受批次门管辖**）');
checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响判定 */ }

console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260924_1_b7: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只 `process.exit` 会掩盖真因（承 rr_zx_20260921 的同款注记）
main().catch((e) => { console.error('❌ rr_zx_20260924_1_b7 抛出未捕获异常：', e); process.exit(1); });
