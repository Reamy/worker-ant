/**
 * zx_20260913 M4 受控复跑（「注入集合与记账」——名实相符 · 记账即事实 · 知止）。
 *
 * 覆盖 M4-1..M4-5：
 *   M4-1 段名分家：第 6 段原先与第 1 段**同名** `## 项目知识`，但两段取数谓词与排序函数皆不同
 *        （段1=按 importance top5；第6段=按 0.4*importance+0.6*retrievalStrength top3）⇒ 改名「高频复用知识」；
 *   M4-2 跨 run 排除补齐：七段（前瞻/盲区/负空间/复盘/心中贼/识别纠错/验收失败）补 `notExcluded`——
 *        此前 ids 记了却不过滤，每次 resume 重复注入、use_count 重复累加；
 *   M4-3 记账即事实补齐：`generateExemplarContext` / `getSimilarTaskExperience` 外露 `outIds`、
 *        `getCrossProjectKnowledge` 回传 `id`——此前三处只传文本 ⇒ 永不进 `recordAccess`、也不可跨 run 排除；
 *   M4-4 历史回放知止：无 LLM 摘要时逐条回放**无上限** ⇒ 现按 `CTX_HISTORY_TAIL_MAX_CHARS` 保尾并如实交代；
 *   M4-5 read_file 名实相符：旧实现先 `slice(0,50_000)` **再**分页（「行」与「字符」两把尺错位，
 *        边界之后的行永远取不到）且超限静默截尾 ⇒ 现先取全文、分页在全文上、超限一律交代。
 *
 * 断言两类：
 *   ① 行为断言动态 import **真实现**——`buildMemoryContext`（真函数 × 假 memory）、
 *      `MemoryManager`（真类 × 内存库真行）、`truncateHistoryTail`/`paginateReadFile` 直调；
 *      生产 SQL **从源码就地取出**再执行，不另写等价 SQL；
 *   ② 静态断言一律 `stripComments` 后再比对，防注释关键词假阳性；每项均附**反证**（旧写法喂同一判据必红）。
 *
 * ⚠ 本文件不打开任何真库（真库只读实测见 data/baseline_zx_20260913.json）。
 * ⚠ 本文件**不新增**钉子：不改 agent-executor 的生产字符串，只读它。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// zx_20260924_1 M7-c: 装配函数迁出到 `core/memory-context.js`（预算以实参传入，真源仍是执行体常量）。
//   本脚本 S0 的静态断言扫的是 `engineSrc()`（并集已并入该模块）⇒ 无需改动即跟着实现走。
import { buildMemoryContext } from '../apps/worker-ant-desktop/src/main/core/memory-context.js';
import { CTX_MEMORY_MAX_CHARS } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import { truncateHistoryTail, type ConvRow } from '../apps/worker-ant-desktop/src/main/core/context-compaction.js';
import { paginateReadFile, READ_FILE_MAX_CHARS } from '../apps/worker-ant-desktop/src/main/core/tool-guards.js';
import { checkBuildPins } from './lib/rr-pins.js';
import { engineSrc } from './lib/rr-engine-src.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const RD = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
type AnyDb = import('better-sqlite3').Database;

// 夹具 schema 按 database.ts DDL 摘取相关列（NOT NULL 照抄，防"夹具比生产宽松"的假绿）
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', context_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '', acceptance_criteria TEXT DEFAULT '',
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
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, content TEXT,
  tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
`;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };
const addMem = (db: AnyDb, o: { id: string; project?: string; task?: string | null; content: string; type?: string; importance?: number; valence?: string; exemplar?: 0 | 1; exType?: string }): void => {
  db.prepare(`INSERT INTO wa_memories (id, project_id, task_id, content, memory_type, importance, valence, is_exemplar, exemplar_type, use_count, context_json)
              VALUES (?,?,?,?,?,?,?,?,?,0,'{}')`)
    .run(o.id, o.project ?? 'p1', o.task ?? null, o.content, o.type ?? 'episodic', o.importance ?? 0.5, o.valence ?? 'neutral', o.exemplar ?? 0, o.exType ?? null);
};
const useCount = (db: AnyDb, id: string): number =>
  (db.prepare('SELECT use_count FROM wa_memories WHERE id = ?').get(id) as { use_count: number } | undefined)?.use_count ?? -1;
// zx_20261018_3 批一：注入账（`injected_count`）与使用账（`use_count`）是两本账。
const injCount = (db: AnyDb, id: string): number =>
  (db.prepare('SELECT injected_count FROM wa_memories WHERE id = ?').get(id) as { injected_count: number } | undefined)?.injected_count ?? -1;

const aeSrc = () => stripComments(engineSrc());
const mmSrc = () => stripComments(RD(`${A}/src/main/core/memory-manager.ts`));

// ── 假 MemoryManager：只放"本用例要的那几段"的数据，其余一律空（防串味）──
const stub = (over: Record<string, unknown> = {}) => ({
  getTaskArchetype: () => null, getTaskText: () => '实现 X 功能',
  retrieveByType: () => [], getProjectKnowledge: () => [],
  buildMemoryEffectivenessStats: () => [], buildExecutionPlaybook: () => ({}),
  generateExemplarContext: () => '', findSimilarTasks: () => [], findCrossProjectSimilarTasks: () => [],
  getCrossProjectKnowledge: () => [], retrieveTaskRelevant: () => [], retrieveByCue: () => [],
  retrieveUnknownHits: () => [], retrieveNegativeHits: () => [], retrieveKnowledgeGraphContext: () => [],
  getTriggeredProspective: () => [], markProspectiveTriggered: () => {}, getWorkingMemory: () => [],
  getSimilarTaskExperience: () => '', getPeerAcceptanceCriteria: () => [], deepRetrieve: () => [],
  memoryConfTag: () => '', confidenceOf: () => 1, maturityOf: () => 1, applicabilityMismatch: () => false,
  recordAccess: () => {},
  ...over,
}) as unknown as MemoryManager;
const GOAL = { goal: '完成本轮实施', success_criteria: 'rr 全绿', investigate: [] };

// ══════════════════════════════════════════════════════════════════
// S0 本批五处接线（静态；每项附反证）
// ══════════════════════════════════════════════════════════════════
console.log('\n[S0 M4 五处接线（源码级；反证＝旧写法喂同一判据必红）]');
{
  const ae = aeSrc();
  // M4-1：段名分家
  eq((ae.match(/add\('项目知识', /g) || []).length, 1, 'M4-1 `add(\'项目知识\', …)` 仅一处（第 1 段）');
  eq((ae.match(/add\('高频复用知识', /g) || []).length, 1, 'M4-1 第 6 段已改名为 `高频复用知识`（唯一一处）');
  ok(ae.includes('## 高频复用知识\\n以下为近期检索中**确实被取用过**'),
    'M4-1 第 6 段标题同步改名（段名与标题同一份，不留半改）');
  ok(ae.includes('以下为近期检索中**确实被取用过**的项目语义知识（按提取强度排序，重要度不一定最高）'),
    'M4-1 标题如实交代「按提取强度排序、重要度不一定最高」——名即其实');

  // M4-2：七段补 notExcluded
  const seven: Array<[string, string]> = [
    ['前瞻记忆', 'appendFresh(notExcluded(memory.getTriggeredProspective('],
    ['已知盲区提醒', 'appendFresh(notExcluded(memory.retrieveUnknownHits('],
    ['负空间提醒', 'appendFresh(notExcluded(memory.retrieveNegativeHits('],
    ['复盘教训', "appendFresh(notExcluded(memory.retrieveByType('retrospective'"],
    ['心中贼提醒', "appendFresh(notExcluded(memory.retrieveByType('limiting_belief'"],
    ['识别纠错', "appendFresh(notExcluded(memory.retrieveByType('archetype_correction'"],
    ['验收失败预警', "appendFresh(notExcluded(memory.retrieveByType('acceptance_failure'"],
  ];
  for (const [name, needle] of seven) {
    ok(ae.includes(needle), `M4-2 ${name}：取回即过 notExcluded（跨 run 排除同一把尺）`);
    ok(!ae.includes(`appendFresh(memory.${needle.split('memory.')[1]}`),
      `  ↳ 反证：${name} 已无「不排除」的旧写法（本批若退回必红）`);
  }

  // M4-3：三处 ids 外露 + 传参
  ok(ae.includes('const exemplarIds: string[] = [];') && ae.includes('memory.generateExemplarContext(projectId, { excluded, outIds: exemplarIds })'),
    'M4-3 范例记忆：outIds 收集 + 传 `excluded`');
  ok(ae.includes("if (exemplarCtx) add('范例记忆', exemplarCtx, exemplarIds);"),
    'M4-3 范例记忆：ids 与文本一同交给 add（缺 ids 则记账永不发生）');
  ok(ae.includes('appendFresh(notExcluded(memory.getCrossProjectKnowledge(projectId, taskId, 3)))'),
    'M4-3 跨项目知识：返回值已是含 id 的对象数组 ⇒ 同尺过滤');
  ok(ae.includes('crossKnowledge.map(k => k.id)'), 'M4-3 跨项目知识：ids 交给 add');
  ok(ae.includes('const expIds: string[] = [];') && ae.includes('getSimilarTaskExperience(projectId, taskId, 3, getSimilarTasks(), { excluded, outIds: expIds })'),
    'M4-3 历史同类经验：outIds 收集 + 传 `excluded`');
  ok(ae.includes("if (expA1) add('历史同类经验', expA1, expIds);"), 'M4-3 历史同类经验：ids 交给 add');
  // 反证：旧写法（不传 ids）
  ok(!/add\('范例记忆', exemplarCtx\)/.test(ae) && !/add\('历史同类经验', expA1\)/.test(ae),
    'M4-3 反证：三处「只传文本」的旧写法已除');

  // M4-4 / M4-5：判据外置为纯函数（使回归跑真实现）
  ok(ae.includes('const { kept, dropped } = truncateHistoryTail(replay, CTX_HISTORY_TAIL_MAX_CHARS);'),
    'M4-4 历史裁剪走外置纯函数 `truncateHistoryTail`（回归可跑真实现，非复刻）');
  ok(!/while \(dropCount < replay\.length - 1 && total > CTX_HISTORY_TAIL_MAX_CHARS\)/.test(ae),
    'M4-4 反证：旧内联裁剪循环已除（不再各写一份）');
  ok(ae.includes('return paginateReadFile(full, { offset: args.offset, limit: args.limit }).text;'),
    'M4-5 read_file 分页走外置纯函数 `paginateReadFile`');
  ok(!/const READ_MAX = 50_000;/.test(ae),
    'M4-5 反证：旧内联 `READ_MAX`/先切后分页的实现已除（字符尺与行尺不再错位）');

  // M4-3 真源侧：SQL 必须带 id（反证：旧 SQL 不带）
  // zx_20261018_2 批七「见简」：范例/相似任务簇搬入 `memory-exemplars.ts`——扫描面按符号重定向
  //   （SQL 与返回类型一字未动；自由函数的签名多了宿主首参，故类型锚点按新形状钉）。
  const mm = mmSrc() + '\n' + stripComments(RD(`${A}/src/main/core/memory-exemplars.ts`));
  ok(mm.includes("SELECT id, content, importance, memory_type, valence FROM wa_memories WHERE task_id = ? AND memory_type IN ('episodic','procedural')"),
    'M4-3 真源：getSimilarTaskExperience 的 SQL 取 `id`（记账的对象就在这一列）');
  ok(!/SELECT content, importance, memory_type, valence FROM wa_memories WHERE task_id/.test(mm),
    '  ↳ 反证：旧 SQL（不带 id）已除');
  ok(/getCrossProjectKnowledge\(mgr: MemoryExemplarHost, projectId: string, taskId: string, topK = 3\): Array<\{ id: string; /.test(mm),
    'M4-3 真源：getCrossProjectKnowledge 返回类型含 `id`（此前只有 content/projectName/memoryType）');
}

// ══════════════════════════════════════════════════════════════════
// S1 (M4-1) 段名分家：两把尺各具其名（行为：同一 run 内两段并存且标题相异）
// ══════════════════════════════════════════════════════════════════
console.log('\n[S1 M4-1 段名分家（真 buildMemoryContext × 假 memory，两段并存）]');
{
  const mem = stub({
    retrieveByType: (t: string) => (t === 'semantic'
      ? [{ id: 's1', content: 'SEM-MARK-按重要度取的知识', importance: 0.9, valence: 'neutral', memory_type: 'semantic', context_json: '{}' }]
      : []),
    getProjectKnowledge: () => [{ id: 'pk1', content: 'PK-MARK-近期真被取用过的知识', importance: 0.4, valence: 'neutral', memory_type: 'semantic', context_json: '{}' }],
  });
  const r = buildMemoryContext(mem, 'p1', 't1', 'X'.repeat(30), GOAL, undefined, CTX_MEMORY_MAX_CHARS);
  ok(r.context.includes('SEM-MARK') && r.context.includes('PK-MARK'), '前提：两段的数据都真的进了上下文（非空断言）');
  eq((r.context.match(/## 项目知识\n/g) || []).length, 1, '`## 项目知识` 在上下文中**只出现一次**（段1）');
  eq((r.context.match(/## 高频复用知识\n/g) || []).length, 1, '`## 高频复用知识` 出现一次（段6，有了自己的名）');
  eq(r.accessedIds.sort(), ['pk1', 's1'], '两段 id 各记各的（分名之后记账仍完整）');
  // 反证：旧实现两段同名 ⇒ 匹配计数为 2，模型无从分辨某条来自哪把尺
  const OLD_TITLE = `## 项目知识\n以下为近期检索中**确实被取用过**`;
  ok(!r.context.includes(OLD_TITLE), '反证：第 6 段已不带旧标题（同名的病已除）');
}

// ══════════════════════════════════════════════════════════════════
// S2 (M4-2) 跨 run 排除补齐：第二 run 带排除集 ⇒ 七段不再重申（反证：空排除集必重申）
// ══════════════════════════════════════════════════════════════════
console.log('\n[S2 M4-2 七段跨 run 排除（真 buildMemoryContext × 两 run 对照）]');
{
  const MARK: Record<string, string> = {
    prosp: 'MARK-前瞻', unknown: 'MARK-盲区', negative: 'MARK-负空间',
    retro: 'MARK-复盘', belief: 'MARK-心中贼', corr: 'MARK-识别纠错', accfail: 'MARK-验收失败',
  };
  const mem = stub({
    retrieveByType: (t: string) => {
      const map: Record<string, string> = { panorama: '', semantic: '', procedural: '', episodic: '' };
      if (t in map) return [];
      const key = ({ retrospective: 'retro', limiting_belief: 'belief', archetype_correction: 'corr', acceptance_failure: 'accfail' } as Record<string, string>)[t];
      return key ? [{ id: key, content: MARK[key], importance: 0.6, valence: 'neutral', memory_type: t, context_json: '{}' }] : [];
    },
    getTriggeredProspective: () => [{ id: 'prosp', content: MARK.prosp, importance: 0.6, valence: 'neutral', memory_type: 'prospective', context_json: '{}' }],
    retrieveUnknownHits: () => [{ id: 'unknown', content: MARK.unknown, importance: 0.6, valence: 'neutral', memory_type: 'semantic', context_json: '{}' }],
    retrieveNegativeHits: () => [{ id: 'negative', content: MARK.negative, importance: 0.6, valence: 'neutral', memory_type: 'negative', context_json: '{}' }],
  });

  const r1 = buildMemoryContext(mem, 'p1', 't1', 'X'.repeat(30), GOAL, undefined, CTX_MEMORY_MAX_CHARS);
  for (const [id, m] of Object.entries(MARK)) {
    ok(r1.context.includes(m), `前提：run1 七段之 ${id} 确实入文`);
  }
  eq(r1.accessedIds.sort(), ['accfail', 'belief', 'corr', 'negative', 'prosp', 'retro', 'unknown'].sort(),
    'run1 记账集 = 七段全部 id');

  // run2：带上 run1 的记账集作排除集 ⇒ 七段**一段都不再注入**
  const r2 = buildMemoryContext(mem, 'p1', 't1', 'X'.repeat(30), GOAL, new Set(r1.accessedIds), CTX_MEMORY_MAX_CHARS);
  const stillThere = Object.entries(MARK).filter(([, m]) => r2.context.includes(m)).map(([id]) => id);
  eq(stillThere, [], 'run2 七段全被排除集挡掉（本批病根：旧实现此处七段会原样重申 ⇒ 已修）');
  eq(r2.accessedIds, [], 'run2 记账集为空（没入文就不记账——同一把尺的两面）');

  // 反证：排除集为空时七段必重申 ⇒ 证明上一条不是"段本来就取不到"
  const r3 = buildMemoryContext(mem, 'p1', 't1', 'X'.repeat(30), GOAL, new Set(), CTX_MEMORY_MAX_CHARS);
  const backAgain = Object.entries(MARK).filter(([, m]) => r3.context.includes(m)).map(([id]) => id);
  eq(backAgain.length, 7, '反证：排除集为空 ⇒ 七段全部重申（证明 run2 的空是排除集所致，非取数失败）');
}

// ══════════════════════════════════════════════════════════════════
// S3 (M4-3) 记账即事实：真 MemoryManager × 内存库真行
// ══════════════════════════════════════════════════════════════════
console.log('\n[S3 M4-3 三处 id 外露（真 MemoryManager × 内存库真行）]');
{
  const db = mkdb();
  // ★ 先建 MemoryManager 再插行（**生产顺序**：引擎启动即 new，行是其后经应用写入的）。
  // 反过来则 FTS 同步触发器建于行之后 ⇒ 更新时 `'delete'` 命令命中未索引的 rowid，node:sqlite 报
  // "database disk image is malformed"，被 buildMemoryContext 的 try/catch 吞掉 ⇒ 假绿（use_count 恒 0）。
  const mm = new MemoryManager(db, {} as never);
  db.prepare("INSERT INTO wa_projects (id, name) VALUES ('p1','本项目'), ('p2','别的项目')").run();
  // 当前任务（供 getTaskText / task_embedding）
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, description, status, context_json) VALUES ('t1','p1','实现 X','要做一个 X 功能','executing',?)")
    .run(JSON.stringify({ task_embedding: [1, 0] }));
  // 相似历史任务（供 getSimilarTaskExperience 的 precomputed）
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, description, status, context_json) VALUES ('t2','p1','实现 Y','y','completed','{}')").run();
  // 跨项目已完成任务 + 同向 embedding（cos=1 > 0.7）
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, description, status, context_json) VALUES ('t9','p2','实现 Z','z','completed',?)")
    .run(JSON.stringify({ task_embedding: [1, 0] }));

  addMem(db, { id: 'ex-good', content: 'EX-GOOD 成功范例', exemplar: 1, exType: 'good' });
  addMem(db, { id: 'ex-bad', content: 'EX-BAD 失败范例', exemplar: 1, exType: 'bad' });
  addMem(db, { id: 'exp1', task: 't2', content: 'EXP-1 相似任务经验', type: 'episodic', importance: 0.8, valence: 'positive' });
  addMem(db, { id: 'cross1', project: 'p2', task: 't9', content: 'CROSS-1 跨项目知识', type: 'semantic', importance: 0.9 });

  // ① generateExemplarContext 外露 outIds
  {
    const ids: string[] = [];
    const ctx = mm.generateExemplarContext('p1', { outIds: ids });
    ok(ctx.includes('EX-GOOD') && ctx.includes('EX-BAD'), '范例上下文真含两条范例（前提成立）');
    eq(ids.sort(), ['ex-bad', 'ex-good'], 'outIds 与文本同源：两条范例的 id 都被外露');
  }
  // ② getSimilarTaskExperience 外露 outIds
  {
    const ids: string[] = [];
    const ctx = mm.getSimilarTaskExperience('p1', 't1', 3, [{ id: 't2', title: '实现 Y', status: 'completed', similarity: 95 }], { outIds: ids });
    ok(ctx.includes('EXP-1'), '同类经验上下文真含 exp1（前提成立）');
    eq(ids, ['exp1'], 'outIds 外露 exp1 的 id');
  }
  // ③ getCrossProjectKnowledge 回传 id
  {
    const list = mm.getCrossProjectKnowledge('p1', 't1', 3);
    ok(list.length > 0 && list.some((k) => k.content.includes('CROSS-1')), '跨项目知识真取到 cross1（前提成立）');
    ok(list.every((k) => typeof k.id === 'string' && k.id.length > 0), '返回值每条都带 id（此前不带 ⇒ 调用方无 id 可记）');
    eq(list.map((k) => k.id), ['cross1'], 'id 与内容一一对应');
  }
  // ④ excluded 同尺：排除集挡住者既不进文本、也不进 outIds
  {
    const ids: string[] = [];
    const ctx = mm.generateExemplarContext('p1', { excluded: new Set(['ex-bad']), outIds: ids });
    ok(!ctx.includes('EX-BAD') && ctx.includes('EX-GOOD'), 'excluded 生效：被排除者不进文本（与 `notExcluded` 同尺）');
    eq(ids, ['ex-good'], 'outIds 也不含被排除者（文本与 id 一致）');
    const ids2: string[] = [];
    const ctx2 = mm.getSimilarTaskExperience('p1', 't1', 3, [{ id: 't2', title: '实现 Y', status: 'completed', similarity: 95 }], { excluded: new Set(['exp1']), outIds: ids2 });
    eq([ctx2, ids2], ['', []], '全部子记忆被排除 ⇒ 不留空标头、不留 id（空段约束同尺）');
  }
  // ⑤ 无 opts 时行为与旧版**逐字等价**（既有 3 个 rr 的 string 桩因此照旧成立）
  {
    const a = mm.generateExemplarContext('p1');
    ok(a.includes('EX-GOOD') && a.includes('EX-BAD'), '无 opts ⇒ 照旧返回全部范例（未收紧检索面）');
    ok(mm.getSimilarTaskExperience('p1', 't1', 3, [{ id: 't2', title: '实现 Y', status: 'completed', similarity: 95 }]).includes('EXP-1'),
      '无 opts ⇒ 照旧返回全部经验（未收紧检索面）');
  }
}

// ══════════════════════════════════════════════════════════════════
// S3b (M4-3) 端到端：三处 id 经 buildMemoryContext ⇒ recordAccess ⇒ use_count 真 +1
// ══════════════════════════════════════════════════════════════════
console.log('\n[S3b M4-3 记账闭环（真 buildMemoryContext × 真 MemoryManager × 真 use_count）]');
{
  const db = mkdb();
  const mm = new MemoryManager(db, {} as never); // ← 同 S3：生产顺序（先建后插）
  db.prepare("INSERT INTO wa_projects (id, name) VALUES ('p1','本项目'), ('p2','别的项目')").run();
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, description, status, context_json) VALUES ('t1','p1','实现 X','要做一个 X 功能','executing',?)")
    .run(JSON.stringify({ task_embedding: [1, 0] }));
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, description, status, context_json) VALUES ('t2','p1','实现 Y','y','completed','{}')").run();
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, description, status, context_json) VALUES ('t9','p2','实现 Z','z','completed',?)")
    .run(JSON.stringify({ task_embedding: [1, 0] }));
  addMem(db, { id: 'ex-good', content: 'EX-GOOD', exemplar: 1, exType: 'good' });
  addMem(db, { id: 'exp1', task: 't2', content: 'EXP-1', type: 'episodic', importance: 0.8, valence: 'positive' });
  addMem(db, { id: 'cross1', project: 'p2', task: 't9', content: 'CROSS-1', type: 'semantic', importance: 0.9 });

  // 前提：三条记忆初始两本账皆为 0
  eq(['ex-good', 'exp1', 'cross1'].map((i) => injCount(db, i)), [0, 0, 0], '前提：三条记忆初始 injected_count = 0');
  eq(['ex-good', 'exp1', 'cross1'].map((i) => useCount(db, i)), [0, 0, 0], '前提：三条记忆初始 use_count = 0');

  const r1 = buildMemoryContext(mm, 'p1', 't1', 'X'.repeat(30), GOAL, undefined, CTX_MEMORY_MAX_CHARS);
  for (const id of ['ex-good', 'exp1', 'cross1']) {
    ok(r1.accessedIds.includes(id), `run1 记账集含 ${id}（该段真入了文）`);
  }
  // zx_20261018_3 批一：装配 = **注入**，记 `injected_count`；`use_count`（主动引用）不得被冒充。
  eq(['ex-good', 'exp1', 'cross1'].map((i) => injCount(db, i)), [1, 1, 1],
    'run1 后三处 injected_count 各 +1 ⇒ 「曾被注入」这一事实对范例/经验/跨项目知识成立');
  eq(['ex-good', 'exp1', 'cross1'].map((i) => useCount(db, i)), [0, 0, 0],
    'run1 后 use_count **恒 0** ⇒ 注入不冒充使用（两本账分家）');

  // run2 带排除集 ⇒ 三处不再入文、也不再记账（记账即事实：没入文就不该 +1）
  const r2 = buildMemoryContext(mm, 'p1', 't1', 'X'.repeat(30), GOAL, new Set(r1.accessedIds), CTX_MEMORY_MAX_CHARS);
  eq(['ex-good', 'exp1', 'cross1'].map((i) => injCount(db, i)), [1, 1, 1],
    'run2 三处被排除 ⇒ injected_count **不再累加**（无第二次注入，就无第二次记账）');
  ok(!r2.context.includes('EX-GOOD') && !r2.context.includes('EXP-1') && !r2.context.includes('CROSS-1'),
    'run2 三处文本也不再重申（跨 run 排除对三处同时生效）');

  // 反证：旧实现（add 时无 ids）在同一夹具下 use_count 恒为 0
  const r0 = buildMemoryContext(stub({ generateExemplarContext: () => 'X', getSimilarTaskExperience: () => 'Y', getCrossProjectKnowledge: () => [] }), 'p1', 't1', 'X'.repeat(30), GOAL, undefined, CTX_MEMORY_MAX_CHARS);
  eq(r0.accessedIds, [], '反证：无 ids ⇒ 记账集为空 ⇒ use_count 永不增长（旧实现即如此）');
}

// ══════════════════════════════════════════════════════════════════
// S4 (M4-4) 历史回放知止：保尾 + 如实交代 + 至少留 1 条
// ══════════════════════════════════════════════════════════════════
console.log('\n[S4 M4-4 truncateHistoryTail（保尾 / dropped 准确 / 至少留 1）]');
{
  const mk = (n: number, len: number): ConvRow[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}-` + 'x'.repeat(len) }));

  // ① 预算宽裕 ⇒ 一条不丢
  {
    const msgs = mk(3, 10);
    const { kept, dropped } = truncateHistoryTail(msgs, 10_000);
    eq([dropped, kept.length], [0, 3], '预算宽裕 ⇒ 全留（不无谓丢尾部）');
    eq(kept, msgs, '原样返回（只搬移，不改写）');
  }
  // ② 超预算 ⇒ 丢最早的那几条，保留尾部
  {
    const msgs = mk(10, 100); // 总 1010 字符
    const { kept, dropped } = truncateHistoryTail(msgs, 500);
    eq(dropped, 6, '丢 6 条后总长 ≤ 500（10×100+9 换行 ≈ 1009；丢 6 剩 4 条 ≈ 404）');
    eq(kept[0], msgs[6], '**保留的是尾部**（首条即第 7 条，不是前几条）');
    eq(kept[kept.length - 1], msgs[9], '末条恒保留（最近一轮必在）');
    eq(dropped + kept.length, msgs.length, '不变式：dropped + kept.length === 总条数（可据此如实点名"省略了几条"）');
    ok(kept.reduce((a, m) => a + m.content.length, 0) <= 500, '保留部分总长落在预算内');
  }
  // ③ 至少留 1 条：单条自身即超预算
  {
    const msgs: ConvRow[] = [{ role: 'user', content: 'y'.repeat(5000) }, { role: 'assistant', content: 'z'.repeat(10) }];
    const { kept, dropped } = truncateHistoryTail(msgs, 100);
    eq(dropped, 1, '只能丢到头（丢 1 条即达上限：再丢就空了）');
    eq(kept.length, 1, '**至少保留 1 条**（宁可超预算，不产生空历史）');
    eq(kept[0]!.content.slice(0, 1), 'z', '保留的是最后一条（最近一轮）');
  }
  // ④ 空输入
  {
    eq(truncateHistoryTail([], 100), { kept: [], dropped: 0 }, '空输入 ⇒ { kept: [], dropped: 0 }（无 NaN/负数）');
  }
  // ⑤ 反证：旧实现（无上限）对同一夹具一条不丢 ⇒ 长任务首部无界膨胀
  {
    const msgs = mk(400, 1000);
    const total = msgs.reduce((a, m) => a + m.content.length, 0);
    ok(total > 400_000, `反证：旧实现下这段历史会原样重放 ${total} 字符（每次 resume 都重放一遍）`);
    ok(truncateHistoryTail(msgs, 9000).dropped > 0, '新实现同夹具下确会裁剪（非空转）');
  }
}

// ══════════════════════════════════════════════════════════════════
// S5 (M4-5) read_file：超限之后的行仍可达 + 超限必交代
// ══════════════════════════════════════════════════════════════════
console.log('\n[S5 M4-5 paginateReadFile（行×字符两把尺对齐 / 超限必交代）]');
{
  const LIMIT = 2_000; // 测试用小上限（真源默认 READ_FILE_MAX_CHARS）
  // 造一个"总字符超限"的文件：300 行 × 20 字符 ≈ 6000 字符
  const lines = Array.from({ length: 300 }, (_, i) => `L${String(i + 1).padStart(3, '0')}-` + 'x'.repeat(16));
  const full = lines.join('\n');
  ok(full.length > LIMIT, `前提：夹具总长 ${full.length} > ${LIMIT}（真的超限）`);

  // ① 无参且超限 ⇒ **必如实交代**（旧实现静默截尾）
  {
    const p = paginateReadFile(full, { maxChars: LIMIT });
    ok(p.truncated, '无参超限 ⇒ truncated=true（旧实现无处可知）');
    ok(p.text.includes(`超出 ${LIMIT} 字符上限`), '文本内明说"超出上限"');
    ok(p.text.includes(`文件共 300 行`) && p.text.includes(`${full.length} 字符`), '文本内给出总行数与总字符数（可自证"我看到的不是全文"）');
    ok(p.text.includes('续读：offset='), '给出续读 offset（有路可走，不是死胡同）');
    ok(p.nextOffset != null && p.nextOffset > 0, `nextOffset 有值（=${p.nextOffset}）`);
    ok(p.text.startsWith('L001-'), '从头开始（无参即从头）');
  }
  // ② ★核心：**旧边界之后**的行按 offset 取得到（旧实现先切 50k 再分页 ⇒ 永远取不到）
  {
    const boundary = Math.ceil(LIMIT / 21); // 粗略的"旧实现能看见的末行"
    const p = paginateReadFile(full, { offset: 250, limit: 10, maxChars: LIMIT });
    ok(p.text.includes('L251-'), `offset=250 取到第 251 行（远超旧字符边界 ${boundary} 行）—— 旧实现此处必然取不到`);
    ok(p.text.includes('L260-') && !p.text.includes('L261-'), 'limit=10 ⇒ 恰好 10 行（分页粒度按行，不受字符尺干扰）');
    eq([p.startLine, p.endLine], [251, 260], 'startLine/endLine 如实标出本次窗口');
    ok(p.text.includes('续读：offset=260'), '未到文件末尾 ⇒ 给出续读 offset');
  }
  // ③ 取到末尾 ⇒ 不再给续读（不谎称还有）
  {
    const p = paginateReadFile(full, { offset: 295, limit: 10, maxChars: LIMIT });
    eq([p.startLine, p.endLine], [296, 300], 'offset=295 取到第 296-300 行（文件末）');
    ok(!p.text.includes('续读：offset='), '已到末尾 ⇒ 不给续读（不谎称还有后续）');
    ok(p.text.includes('L300-'), '末行确实在返回内');
  }
  // ④ 单页自身超字符上限 ⇒ 截断且**必须交代**（这是旧实现静默的地方）
  {
    const p = paginateReadFile(full, { offset: 0, limit: 300, maxChars: LIMIT });
    ok(p.truncated && p.text.includes(`超出 ${LIMIT} 字符上限已截断`), '单页超限 ⇒ 截断 + 明说（不静默）');
    ok(p.text.includes('文件共 300 行'), '并给出全文规模');
    ok(p.text.includes('续读：offset=') && p.nextOffset != null, '且给出续读 offset（截断处所在行之后）');
  }
  // ⑤ offset 越界 ⇒ 如实说"超出末尾"，不返回空串冒充"文件是空的"
  {
    const p = paginateReadFile(full, { offset: 9999, maxChars: LIMIT });
    ok(p.text.includes('已超出文件末尾') && p.text.includes('文件共 300 行'), 'offset 越界 ⇒ 明说越界 + 给出真实规模');
    eq(p.nextOffset, null, '越界 ⇒ 无续读');
  }
  // ⑥ 小文件不截断 ⇒ 原样返回（不改动既有正常路径）
  {
    const small = 'a\nb\nc';
    const p = paginateReadFile(small, { maxChars: LIMIT });
    eq([p.text, p.truncated, p.nextOffset], [small, false, null], '小文件 ⇒ 原文返回、无截断、无续读尾巴（零噪声）');
  }
  // ⑦ 真源默认值就是生产值（防"测试用小上限"掩盖生产上限写错）
  eq(READ_FILE_MAX_CHARS, 50_000, '真源默认上限 50_000（与旧实现同值 ⇒ 本批只改"怎么截"，不改"截多少"）');
  ok(engineSrc().includes('单次回传上限 50000 字符'),
    '工具描述与真源同值（描述里说的 50000 就是真源里的 50_000）');
}

// M5 收口：每个子脚本自带 build 闸（任一批单独跑也能自查 build 是否陈旧）。
// ⚠ 本段读 dist ⇒ tsup 必须先于本脚本。
console.log('\n[M5] build 标识派生一致性（P1–P6）');
checkBuildPins(ok, { distDir: path.join(__dirname, '..', A, 'dist') });

console.log(`\n结果: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
