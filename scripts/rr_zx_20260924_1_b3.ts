/**
 * zx_20260924_1 批次 M3 受控复跑 —— 「拆解：序号不是优先级，三路一把尺」
 * （对应方案 §1.3 F3 / §1.4 F4 与 §M3；用户裁定 J-6 = 写 `priority = planned - i`，J-7 = 引擎路补写标记）
 *
 * ── M3-a：`priority` 里装的是序号，而调度器按 `DESC` 读 ──────────────────────────────
 *   写点（`core/task-decompose.ts` · `planSubtasksFromTemplate` / `ipc/project.ipc.ts` 的模板拆解）此前
 *   一律把**裸 `i`** 写进 `priority`；zx_20260929 M5-c 后 IM 路并入 `planSubtasksFromTemplate`，写点由
 *   三处收成两处（C-4 另立反证断言"IM 路零 `decomposePriority(`"）。而两处读点
 *   （`core/task-scheduler.ts` · `getReadyTasks` / `core/tools/control.ts` · `exit_plan_mode`）按
 *   `ORDER BY priority DESC` 取 ⇒ **模板里最后一个反而最先起跑**（`created_at` 同一条 INSERT 循环、
 *   秒级同值，兜底次序救不了）。现各写点统一写 `decomposePriority(planned, i)`（= `planned - i`）。
 *   ⚠ 另一种同样自洽的改法（"一律写 0 + 读点加 `rowid ASC`"）已裁定**不采用**（J-6）⇒ 本脚本另设反证，
 *     若有人引入第二套序（读点改挑 `rowid`）必红。
 *
 * ── M3-b：三路拆解的"我拆过了"标记 ────────────────────────────────────────────────
 *   模板路写全 6 键 / IM 路只写 `$.auto_decomposed` / **引擎路什么都不写**（父任务在库中查无"已拆"实据）；
 *   防重复拆解也只有引擎路一处（裸 `countActiveChildren > 0`），IM 路**无守卫**。
 *   现：三路共有层 `$.auto_decomposed` 三路皆写；`alreadyDecomposed` 成唯一判据、IM 路接入。
 *   ⚠ `$.template` / `$.matched_*` 是**模板路专有**（引擎路没有模板）⇒ 本脚本反证它们**不得**出现在引擎路。
 *
 * ── 断言形态（承本仓「判据的自我印证」教训；每条断言自称其形态）────────────────────
 *   · **行为**（跑生产那一份，本脚本不写等价物）：`planSubtasksFromTemplate` /
 *     `TaskScheduler.getReadyTasks` / `controlTools().enter_plan_mode.execute` / `exit_plan_mode.execute` /
 *     `shouldAutoDecomposeIm` / `alreadyDecomposed` / `decomposePriority`；
 *   · **生产 SQL × 生产夹具**（`project.ipc.ts` 顶层 import electron ⇒ node 里引不进该文件，跑不了那个 handler）：
 *     把它的标记 SQL **从源码就地取出**再真执行 —— 不另写一份等价 SQL；
 *   · **源码级**（仅符号/注记在位）：如实标为源码级，不冒充"跑过了"。
 *
 * §G 不变式门：
 *   G-1 真源在位（符号被删/改名 ⇒ 编译期先红，而不是"扫字符串扫了个空"静默假绿）；
 *   G-2 两侧标本一起试（该命中/该不命中、该挡/该放、反→正）；
 *   G-3 扫描面自证（"零命中"类断言一并报出扫描面，并配一把"该非空"的负向对照）。
 *
 * ⚠ 本脚本**不写任何轮次字面量**（`scripts/lib/rr-pins.ts` 的 P5 会全量点名 file:line）；
 *   本脚本自己的轮次标识一律由 `path.basename(__filename)` 派生。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
import {
  planSubtasksFromTemplate, DECOMPOSE_MODEL_REQUEST,
  type DecompositionTemplate,
} from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
import {
  decomposePriority, alreadyDecomposed, countActiveChildren, childBreadthRefusal,
  MAX_CHILD_BREADTH, MAX_TASK_DEPTH,
} from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import { shouldAutoDecomposeIm } from '../apps/worker-ant-desktop/src/main/services/im-router.js';
import { TaskScheduler } from '../apps/worker-ant-desktop/src/main/core/task-scheduler.js';
import { controlTools } from '../apps/worker-ant-desktop/src/main/core/tools/control.js';
import { mergePlanModeContext } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) =>
  ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const ROOT = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
type AnyDb = import('better-sqlite3').Database;

// 夹具 schema 按 `main/database.ts` DDL 摘相关列（NOT NULL 照抄，防"夹具比生产宽松"的假绿）。
// 覆盖本批真正会碰的表：wa_tasks（建子/读回 priority·context_json）、wa_settings（拆解开关）、
// wa_task_conversations（[智能拆解] 行）、wa_jobs（exit_plan_mode 启动无前置子任务）。
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, parent_task_id TEXT DEFAULT '', title TEXT NOT NULL,
  description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0,
  context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '', source TEXT DEFAULT 'user',
  acceptance_criteria TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '',
  token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}', status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')));
`;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };
const PROJ = 'proj-m3';
const addParent = (db: AnyDb, id: string): void => {
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, description, status, context_json, parent_task_id) VALUES (?, ?, ?, ?, 'pending', '{}', '')")
    .run(id, PROJ, id, '父任务目标');
};
const addChild = (db: AnyDb, id: string, priority: number, parent: string, status = 'pending'): void => {
  db.prepare("INSERT INTO wa_tasks (id, project_id, parent_task_id, title, description, status, priority, context_json) VALUES (?, ?, ?, ?, '', ?, ?, '{}')")
    .run(id, PROJ, parent, id, status, priority);
};
const ctxOf = (db: AnyDb, id: string): Record<string, unknown> =>
  JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}');
/** 生产读点①：真 `TaskScheduler.getReadyTasks`（不是"照抄那句 SQL"） */
const ready = (db: AnyDb, projectId = PROJ) =>
  (new TaskScheduler(db).getReadyTasks(projectId)).map((t) => String(t.id));

/**
 * 父任务在本夹具里**也是 `pending`**、且同样无前置 ⇒ 它**本来就在 `getReadyTasks` 的返回里**
 * （模板路/IM 路都**刻意**把父留在 `pending`，见 `project.ipc.ts` 「父留在 pending」那段注释；
 * 引擎路进 planning 后 `exit_plan_mode` 又把它写回 pending）。
 * 故本批正题（**子任务**的起跑次序）只比子任务子序，父行不混进来 —— 但父行在场这件事**单列一条断言**，
 * 不是"用 filter 把不肯定的东西悄悄滤掉"。
 */
const childSeq = (ids: readonly string[]): string[] => ids.filter((x) => x !== 'P');

const TPL3: readonly DecompositionTemplate[] = [
  { title: '第一步', description: '甲', acceptance_criteria: '甲成' },
  { title: '第二步', description: '乙', acceptance_criteria: '乙成' },
  { title: '第三步', description: '丙', acceptance_criteria: '丙成' },
];
/** 同一条模板，但第 2 项等第 1 项、第 3 项等第 2 项（序号 1-based）——用于"有依赖仍被挡"那格 */
const TPL_CHAIN: readonly DecompositionTemplate[] = [
  { title: '第一步', description: '甲', acceptance_criteria: '甲成' },
  { title: '第二步', description: '乙', acceptance_criteria: '乙成', dependsOn: [1] },
  { title: '第三步', description: '丙', acceptance_criteria: '丙成', dependsOn: [2] },
];
/**
 * 3 条无前置子任务的模型回话（`parseDecomposition` 的入参形状）。
 * zx_20261016_3 M33-b（改钉更强真源，非放宽）：**四因俱全**——`parseDecomposition` 自本轮起
 *   把无 `purpose` 的条目拒掉，故本标本须带目的因，判的才是"起跑次序"而非"被目的因门滤没了"。
 */
const SCRIPT3 = JSON.stringify([
  { title: '第一步', description: '甲', acceptance_criteria: '甲成', purpose: '为父目标备料' },
  { title: '第二步', description: '乙', acceptance_criteria: '乙成', purpose: '为父目标产出主体' },
  { title: '第三步', description: '丙', acceptance_criteria: '丙成', purpose: '为父目标交验' },
]);

// 源码（按符号取块，**锚点一律按符号不按行号**）
const RAW = {
  decompose: RD(`${A}/src/main/core/task-decompose.ts`),
  im: RD(`${A}/src/main/services/im-router.ts`),
  ipc: RD(`${A}/src/main/ipc/project.ipc.ts`),
  ctrl: RD(`${A}/src/main/core/tools/control.ts`),
  sched: RD(`${A}/src/main/core/task-scheduler.ts`),
  acct: RD(`${A}/src/main/core/task-accounting.ts`),
};
const src = {
  decompose: stripComments(RAW.decompose),
  im: stripComments(RAW.im),
  ipc: stripComments(RAW.ipc),
  ctrl: stripComments(RAW.ctrl),
  sched: stripComments(RAW.sched),
  acct: stripComments(RAW.acct),
};
function spanOf(text: string, needle: string, len = 2000): string {
  const i = text.indexOf(needle);
  return i < 0 ? '' : text.slice(i, i + len);
}
/** 取 needle **前后**各一段（注记常写在代码块**上方** ⇒ 只取 needle 之后会取不到注记，
 *  而"取不到"与"注记不在位"必须分得开：故两侧都给窗口，找不到 needle 时返回空串）。 */
function around(text: string, needle: string, before = 1200, after = 400): { block: string; found: boolean } {
  const i = text.indexOf(needle);
  if (i < 0) return { block: '', found: false };
  return { block: text.slice(Math.max(0, i - before), i + after), found: true };
}

/** 真跑生产 `enter_plan_mode` / `exit_plan_mode`：桩只打在**两条边**（ANS 选型口 + 端点 fetch）上 */
function makePlanRunner(tmp: string) {
  const silentLogger = { info() { }, warn() { }, error() { }, debug() { }, child() { return silentLogger as never; } };
  async function runPlan(scripted: string[]) {
    const db = mkdb();
    addParent(db, 'P');
    const queue = [...scripted];
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      const content = queue.shift() ?? '[]';
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
    }) as unknown as typeof fetch;
    const ansClient = {
      async getOptimalModel(params: Record<string, unknown>) {
        // 引擎路须经**生产那份能力档**取模型（与 `DECOMPOSE_MODEL_REQUEST` 一字不差）
        if (JSON.stringify(params) !== JSON.stringify(DECOMPOSE_MODEL_REQUEST)) throw new Error('选型请求体与生产常量不符');
        return { url: 'http://ans.test/v1', api_key: 'stub-key', model_name: 'stub-model' };
      },
    };
    const tools = controlTools({
      db, taskId: 'P', projectId: PROJ, workingDir: tmp,
      ctx: { getAnsClient: async () => ansClient },
      mergePlanModeContext, logger: silentLogger,
    } as never) as unknown as {
      enter_plan_mode: { execute: (a: { goal_summary: string }) => Promise<string> };
      exit_plan_mode: { execute: (a: { plan_summary: string }) => Promise<string> };
    };
    return { db, tools, fetches: () => fetches, restore: () => { globalThis.fetch = realFetch; } };
  }
  return runPlan;
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr24b3-'));
  const runPlan = makePlanRunner(tmp);

  console.log(`\n【A】M3-a 起跑次序：序号不是优先级（写 planned-i，读 DESC ⇒ 模板序起跑）`);

  // ── A-1 换算本身（生产那份 `decomposePriority`，直调）──────────────
  {
    eq([decomposePriority(3, 0), decomposePriority(3, 1), decomposePriority(3, 2)], [3, 2, 1],
      'A-1 `decomposePriority(3, i)` = 3/2/1 —— 模板第 1 个拿**最大**值（DESC 下最先起跑）');
    ok(decomposePriority(3, 0) > decomposePriority(3, 1) && decomposePriority(3, 1) > decomposePriority(3, 2),
      'A-1b 严格递减（不是"三个值恰好排对"）',
      `${[0, 1, 2].map((i) => decomposePriority(3, i)).join(' > ')}`);
    // 反证：旧写法（裸 `i`）在 DESC 下恰恰是**倒序** —— 两套值不可互换
    const oldDesc = [0, 1, 2].slice().sort((a, b) => b - a);
    const newDesc = [3, 2, 1];
    ok(JSON.stringify(oldDesc) !== JSON.stringify(newDesc),
      'A-1c **反证（反→正）**：旧写法 `i` 的降序是 [2,1,0]、新写法是 [3,2,1] ⇒ 断言不是恒真（换回旧写法必红）',
      `旧降序 [${oldDesc.join(',')}] / 新降序 [${newDesc.join(',')}]`);
  }

  // ── A-2 写点① task-decompose：真落库 + 真 `getReadyTasks` 读回 = 模板序 ──
  {
    const db = mkdb();
    addParent(db, 'P');
    const r = planSubtasksFromTemplate(db, {
      parentTaskId: 'P', projectId: PROJ, template: TPL3, depth: 0, source: 'auto-decompose',
    });
    ok(r.created === 3 && r.noDepCount === 3, 'A-2 前提：3 个子任务、全部无前置',
      `created=${r.created} noDep=${r.noDepCount} refusal=${String(r.refusal)}`);
    const rows = db.prepare('SELECT id, title, priority FROM wa_tasks WHERE parent_task_id = ? ORDER BY priority DESC, created_at ASC')
      .all('P') as Array<{ id: string; title: string; priority: number }>;
    eq(rows.map((x) => x.priority), [3, 2, 1],
      'A-2a **落库值（行为）**：priority 依次 3/2/1（与模板序同向；旧写法为 0/1/2）');
    const got = childSeq(ready(db));
    eq(got, r.childIds,
      'A-2b ★ **行为（读点①，真 TaskScheduler.getReadyTasks）**：**子任务**返回次序 = 模板序'
      + '（改前为倒序 —— 这一格是本批正题）',
      `${got.map((x) => x.slice(0, 6)).join(' → ')}`);
    // 父行在场的正面断言（给上面那个 filter 一个理由，也让"父与子同批并存"这件事落在纸面上）
    ok(ready(db).includes('P'),
      'A-2b1 **反证（该在场）**：父任务 `P` 仍在 `getReadyTasks` 返回里（父留 `pending` 是模板路/IM 路'
      + '**刻意**的裁定）⇒ 上面那句比较是"只看子序"，不是"这个读点只返回子任务"',
      `全量 ${ready(db).length} 行`);
    // 两侧标本：同一条模板按**旧写法**落库，读点必须读出**倒序**（证明上面那条有牙）
    const old = mkdb();
    addParent(old, 'P');
    const oldIds = TPL3.map((_t, i) => { const id = `old-${i}`; addChild(old, id, i, 'P'); return id; });
    eq(childSeq(ready(old)), [...oldIds].reverse(),
      'A-2c **反证（该不命中）**：同一条模板按旧写法（priority = i）落库 ⇒ `getReadyTasks` 读出子任务**倒序**'
      + ' ⇒ A-2b 断的不是"这个函数总会返回模板序"',
      `${ready(old).join(' → ')}`);
  }

  // ── A-3 有前置仍由 `hasUnmetDependencies` 挡住（次序不由依赖让路）──
  {
    const db = mkdb();
    addParent(db, 'P');
    const r = planSubtasksFromTemplate(db, {
      parentTaskId: 'P', projectId: PROJ, template: TPL_CHAIN, depth: 0, source: 'auto-decompose',
    });
    eq(childSeq(ready(db)), [r.childIds[0]],
      'A-3 **行为**：有链式前置时仍只放行**第 1 个**（`hasUnmetDependencies` 照旧挡后面两个 —— 改序没让依赖松口）');
    ok(r.noDepCount === 1, 'A-3b 且报数如实（"无前置者 1 个"）', `noDepCount=${r.noDepCount}`);
    db.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = ?").run(r.childIds[0]);
    eq(childSeq(ready(db)), [r.childIds[1]], 'A-3c 第 1 个完成后第 2 个就绪（解锁链未受次序改动影响）');
  }

  console.log(`\n【B】M3-a 读点② + M3-b 引擎路拆解标记：真跑 controlTools`);

  // ── B-1 真跑引擎路 ⇒ 落库序 / 启动序都是模板序 ──
  {
    const r = await runPlan([SCRIPT3]);
    const goal = '为项目搭一条完整的数据流水线并产出报告';
    const enter = JSON.parse(await r.tools.enter_plan_mode.execute({ goal_summary: goal })) as Record<string, unknown>;
    try {
      const kids = r.db.prepare('SELECT id, title, priority FROM wa_tasks WHERE parent_task_id = ? ORDER BY priority DESC, created_at ASC')
        .all('P') as Array<{ id: string; title: string; priority: number }>;
      ok(kids.length === 3 && (enter.autoDecomposed as { created?: number } | undefined)?.created === 3,
        'B-1 前提：真跑 `enter_plan_mode` 拆出 3 个子任务（走生产那份 `planSubtasksFromTemplate`）',
        `created=${(enter.autoDecomposed as { created?: number } | undefined)?.created}`);
      eq(kids.map((k) => k.priority), [3, 2, 1], 'B-1a **行为**：引擎路落库的 priority 亦为 3/2/1（三处写点同一口径）');
      eq(kids.map((k) => k.title), ['第一步', '第二步', '第三步'],
        'B-1b 库内按 DESC 取出的次序 = 模型给的模板序（不是倒序）');

      // ── B-2 M3-b 引擎路补写拆解标记（假→真）──────────────
      // ⚠ 读点在 `exit_plan_mode` **之前**：`exit_plan_mode` 会把 mode 覆写成 'execution'
      //   （同一条 `mergePlanModeContext` 合并路），在其之后读只能看到 execution —— 那是本工具的
      //   正常收尾，不是"标记被抹掉"。故"与 mode:'planning' 并存"这一格必须在退计划模式**前**看。
      const pctxEnter = ctxOf(r.db, 'P');
      ok(pctxEnter.auto_decomposed === true,
        'B-2 ★ **行为（假→真）**：引擎/计划路拆解后，父任务 `context_json.$.auto_decomposed` 为 true'
        + '（改前本路**一个字都不写** ⇒ 库中查无"已拆"实据）',
        `auto_decomposed=${JSON.stringify(pctxEnter.auto_decomposed)}`);
      ok(!('template' in pctxEnter) && !('matched_method' in pctxEnter) && !('matched_keywords' in pctxEnter)
        && !('matched_similarity' in pctxEnter) && !('matched_field' in pctxEnter),
        'B-2b **该不命中**：`$.template` / `$.matched_*` **不得**出现在引擎路的父 ctx 里'
        + '（那是模板路专有 —— 引擎路没有模板，写进去就是编造依据）',
        `父 ctx 键 ${Object.keys(pctxEnter).join(',')}`);
      ok(pctxEnter.mode === 'planning',
        'B-2c ★ **行为**：标记与 `mode:\'planning\'` **并存** ⇒ 它没有被那条**整体覆写**抹掉'
        + '（`taskCtx` 是工具入口的快照，标记若写在覆写之前会当场丢失 —— "非结论不得抹掉结论"）',
        `mode=${String(pctxEnter.mode)}`);

      // 真跑 `exit_plan_mode`（读点②：`ORDER BY priority DESC` 启动无前置子任务）
      const exit = JSON.parse(await r.tools.exit_plan_mode.execute({ plan_summary: '三步走' })) as Record<string, unknown>;
      const jobs = r.db.prepare("SELECT payload FROM wa_jobs WHERE type = 'ai-task' ORDER BY rowid")
        .all() as Array<{ payload: string }>;
      const started = jobs.map((j) => String((JSON.parse(j.payload) as { taskId?: string }).taskId));
      eq(started, kids.map((k) => k.id),
        'B-1c ★ **行为（读点②，真 exit_plan_mode）**：实际入队（`wa_jobs`）次序 = 模板序'
        + '（改前此处入队次序为倒序 —— 同一批"无前置"子任务最后一个先跑）',
        `startedCount=${String(exit.startedCount)} 入队 ${started.map((s) => s.slice(0, 6)).join(' → ')}`);

      // 退计划模式**之后**标记仍在（`exit_plan_mode` 同样走 merge ⇒ 不该把标记带走）
      ok(ctxOf(r.db, 'P').auto_decomposed === true,
        'B-2d **行为**：`exit_plan_mode` 收尾（又一次 merge 覆写）后标记仍是 true'
        + '（"非结论不得抹掉结论"——覆写只加不减）',
        `auto_decomposed=${JSON.stringify(ctxOf(r.db, 'P').auto_decomposed)}`);
    } finally { r.restore(); }
  }

  // ── B-3 二次进入 `enter_plan_mode` ⇒ 不重复建子（`alreadyDecomposed` 挡住）──
  {
    const r = await runPlan([SCRIPT3]);
    try {
      await r.tools.enter_plan_mode.execute({ goal_summary: '第一次' });
      const first = (r.db.prepare('SELECT COUNT(*) AS c FROM wa_tasks WHERE parent_task_id = ?').get('P') as { c: number }).c;
      const before = r.fetches();
      const second = JSON.parse(await r.tools.enter_plan_mode.execute({ goal_summary: '第二次（同一个父任务）' })) as Record<string, unknown>;
      const after = (r.db.prepare('SELECT COUNT(*) AS c FROM wa_tasks WHERE parent_task_id = ?').get('P') as { c: number }).c;
      ok(first === 3 && after === 3,
        'B-3 ★ **行为（反）**：同一父任务二次进入 `enter_plan_mode` ⇒ 子任务数**不变**（3→3，不重复建子）',
        `${first} → ${after}`);
      ok(r.fetches() === before && !('autoDecomposed' in second),
        'B-3b 且第二次**连模型都没问**（零次新增出口请求）、回话里没有 `autoDecomposed` 键'
        + '（不编造"又拆了 N 个"）',
        `fetches ${before} → ${r.fetches()}`);
      ok(ctxOf(r.db, 'P').auto_decomposed === true, 'B-3c 父任务的"已拆"标记仍在（守卫拦的是"再拆"，不是抹掉既有实据）');
    } finally { r.restore(); }
  }

  // ── B-4 写点② IM 路的守卫（生产唯一实现 `shouldAutoDecomposeIm`，两侧标本）──
  {
    const db = mkdb();
    addParent(db, 'P');
    const BIG = '请帮我搭建一套完整的自动化数据处理流水线，包括采集、清洗、建模、可视化与报告输出，并部署到测试环境。';
    ok(shouldAutoDecomposeIm(db as never, 'P', BIG) === true,
      'B-4 **该命中**：大消息 + 父任务零在途子任务 ⇒ `shouldAutoDecomposeIm` = true',
      `消息长度 ${BIG.length}`);
    addChild(db, 'c1', 1, 'P');
    ok(shouldAutoDecomposeIm(db as never, 'P', BIG) === false,
      'B-4a ★ **该挡（反）**：父任务已有在途子任务 ⇒ = false（改前本路**无此守卫** ⇒ 断言"挡得住"）');
    ok(shouldAutoDecomposeIm(db as never, 'P2', '记一下') === false,
      'B-4b **该不命中**：小消息（无关键词）⇒ 亦不拆 —— 补守卫没把原有的尺寸/关键词闸顶掉',
      `小消息长度 ${'记一下'.length} / 阈值 100`);
    ok(shouldAutoDecomposeIm(db as never, 'P3', '搭建') === true,
      'B-4c 关键词闸逐字仍在（"搭建"这类短词也能触发）');
    // "在途"口径：子任务全终态之后仍可再拆（不是"拆过一次永久禁止"）
    db.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = 'c1'").run();
    ok(shouldAutoDecomposeIm(db as never, 'P', BIG) === true,
      'B-4d **口径**：子任务全部终态后 ⇒ 又可拆（守卫数的是**在途**，不是"历史拆过一次"）');
  }

  // ── B-5 `alreadyDecomposed` 是唯一判据（含"值从 0 变 1"的正面断言）──
  {
    const db = mkdb();
    addParent(db, 'P');
    eq(countActiveChildren(db as never, 'P'), 0, 'B-5 前提：新父任务在途子数 = 0');
    ok(alreadyDecomposed(db as never, 'P') === false, 'B-5a 0 个在途 ⇒ `alreadyDecomposed` = false');
    addChild(db, 'c1', 1, 'P');
    eq(countActiveChildren(db as never, 'P'), 1, 'B-5b **值从 0 变 1**：插一行在途子任务后计数 = 1（正面断言，不只"不抛"）');
    ok(alreadyDecomposed(db as never, 'P') === true, 'B-5c 同刻 `alreadyDecomposed` 由 false 变 true（唯一判据看见了那一行）');
    db.prepare("UPDATE wa_tasks SET status = 'archived' WHERE id = 'c1'").run();
    ok(alreadyDecomposed(db as never, 'P') === false,
      'B-5d 终态（archived）不占位 ⇒ 判据与 `countActiveChildren` 同口径（不是自造第二把尺）');
    eq(MAX_CHILD_BREADTH, 5, 'B-5e 广度上限仍是 5（本批改的是"怎么排"，不是数到几）');
    ok(childBreadthRefusal(db as never, 'P') === null, 'B-5f 且本脚本夹具（3 子）未越过广度闸（否则测的就不是本批要测的东西）');
    eq(MAX_TASK_DEPTH >= 1, true, 'B-5g 深度闸常量在册（夹具 depth=0 ⇒ 子深 1，未越界）');
  }

  console.log(`\n【C】M3-b 三路标记：逐点核（不可 import 的那两路 = 生产 SQL 就地取出再真执行）`);

  // ── C-1 引擎路（control.ts）：源码级 + 位置约束 ──
  {
    // zx_20261002 M5（重钉）：引擎路的"门 + 拆 + 落行 + 留痕"已**抽成一处实现** `autoDecomposeForTask`
    //   （`task-decompose.ts`），启动路（`ai-task` 处理器）同用同一份。故本处判据由"块内看得见"改为
    //   "**接线在册 + 门仍在那份唯一实现里**"——两条都要，缺一条就成了"移走了却没接上"。
    const ep = spanOf(src.ctrl, 'const autoDecompose = await autoDecomposeForTask({', 1200);
    ok(ep.length > 0, 'C-1 扫描面自证：取到 `enter_plan_mode` 的拆解**接线**（符号锚点成立，非空）');
    ok(/autoDecomposeForTask\(/.test(ep),
      'C-1a **源码级** 引擎路已接线到唯一实现 `autoDecomposeForTask`（不再内联一份自己的门/拆/落行）');
    const shared = spanOf(src.decompose, 'export async function autoDecomposeForTask(', 3000);
    ok(shared.length > 0 && /alreadyDecomposed\s*\(opts\.db,\s*opts\.taskId\)/.test(shared),
      'C-1a2 **源码级** 防重判据仍走唯一实现 `alreadyDecomposed`——在被委托的那份实现体内（不是同名空壳）');
    ok(!/countActiveChildren\s*\(db,\s*taskId\)\s*>\s*0/.test(src.ctrl),
      'C-1b **反证**：`control.ts` 内已无裸的 `countActiveChildren(…) > 0`（同一判断不再有第二份写法）');
    const iMark = src.ctrl.indexOf("json_set(COALESCE(context_json,'{}'), '$.auto_decomposed', json('true'))");
    ok(iMark >= 0, 'C-1c **源码级**：引擎路写 `$.auto_decomposed`（与 IM 路同一写法形状）');
    const iOverwrite = src.ctrl.indexOf("db.prepare(\"UPDATE wa_tasks SET status = 'planning', context_json = ?");
    ok(iOverwrite >= 0 && iMark > iOverwrite,
      'C-1d 标记写的**位置**在 `status=\'planning\'` 那条整体覆写之后 ⇒ 结构上不可能被抹掉'
      + '（按符号取位，不按行号）',
      `覆写 offset=${iOverwrite} / 标记 offset=${iMark}`);
  }

  // ── C-2 IM 路（im-router.ts）：生产 SQL 就地取出并**真执行** ──
  {
    const m = src.im.match(/"UPDATE wa_tasks SET context_json = json_set\(COALESCE\(context_json,'\{\}'\), '\$\.auto_decomposed', json\('true'\)\), updated_at = datetime\('now'\) WHERE id = \?"/);
    ok(!!m, 'C-2 扫描面自证：IM 路那条标记 SQL 由源码**就地取出**（未另写等价 SQL）');
    if (m) {
      const db = mkdb();
      addParent(db, 'P');
      db.prepare(m[0].slice(1, -1)).run('P');
      ok(ctxOf(db, 'P').auto_decomposed === true,
        'C-2a ★ **生产 SQL × 生产夹具**：IM 路的标记 SQL 真执行后，父任务 `$.auto_decomposed` = true',
        `auto_decomposed=${JSON.stringify(ctxOf(db, 'P').auto_decomposed)}`);
    }
    ok(/shouldAutoDecomposeIm\s*\(ctx\.db,\s*taskId,\s*msgText\)/.test(src.im),
      'C-2b **源码级**：IM 路入口已接入 `shouldAutoDecomposeIm`（内含唯一判据 `alreadyDecomposed`）');
    ok(/export function shouldAutoDecomposeIm\([\s\S]{0,500}?alreadyDecomposed\(/.test(src.im),
      'C-2c 该判据体内确调 `alreadyDecomposed`（不是同名空壳）');
    ok(!/status === 'pending' && \(msgText\.length >= 100/.test(src.im),
      'C-2d **反证**：旧的"只有尺寸/关键词一道闸"入口写法已除（补上了守卫那一层）');
  }

  // ── C-3 模板路（project.ipc.ts）：生产 SQL 就地取出并**真执行**（6 键一次落齐）──
  {
    // ⚠ 锚点须先定位到**本批那条**（同文件另有 `$.scheme_ref` 的单键 json_set，是更早的一处）
    const anchor = RAW.ipc.indexOf("'$.template', ?");
    const i = anchor >= 0 ? RAW.ipc.lastIndexOf('UPDATE wa_tasks SET context_json = json_set(', anchor) : -1;
    const tail = i >= 0 ? RAW.ipc.slice(i) : '';
    const end = tail.indexOf('WHERE id = ?');
    const sqlRaw = end > 0 ? tail.slice(0, end + 'WHERE id = ?'.length) : '';
    const qs = (sqlRaw.match(/\?/g) || []).length;
    ok(sqlRaw.length > 0 && qs === 6,
      'C-3 扫描面自证：模板路的标记 SQL 由源码就地取出，且恰 **6 个占位**'
      + "（= id + 5 个值；`auto_decomposed` 由 `json('true')` 给死值，故占位 6 而非 7）",
      `占位 ${qs} 个 / anchor offset=${anchor}`);
    // 绑定次序**由源码派生**（各 `$.xxx` 键的先后），不手抄"我以为的顺序"
    const keyOrder = [...sqlRaw.matchAll(/\$\.([a-z_]+)/g)].map((x) => x[1]!);
    eq(keyOrder, ['auto_decomposed', 'template', 'matched_method', 'matched_keywords', 'matched_similarity', 'matched_field'],
      'C-3a 六组键的**出现次序由源码派生**（下面按同序绑定入参 —— 顺序是导出的，不是假设的）');
    if (sqlRaw.length > 0) {
      const db = mkdb();
      addParent(db, 'P');
      db.prepare(sqlRaw).run('tpl-1', 'keyword', JSON.stringify(['web_app']), 0.86, 'title', 'P');
      const c = ctxOf(db, 'P');
      ok(c.auto_decomposed === true && c.template === 'tpl-1' && c.matched_method === 'keyword'
        && JSON.stringify(c.matched_keywords) === JSON.stringify(['web_app'])
        && c.matched_similarity === 0.86 && c.matched_field === 'title',
        'C-3b ★ **生产 SQL × 生产夹具**：模板路那条 SQL 真执行后，`auto_decomposed` 与 `template`/`matched_*` **六键全落**'
        + '（zx_20260924 缺陷B 的"套娃漏一层 ⇒ 整条 UPDATE 抛错被 catch 吞掉"不复现）',
        `键 ${Object.keys(c).join(',')}`);
    }
  }

  // ── C-4 三处写点：拆解序号都经 `decomposePriority`（不写裸 i）+ 注记在位 ──
  {
    // zx_20260929 M5-c 就地订正（改钉更强真源，非放宽）：原为**三处**写点（引擎 / IM / GUI）。
    //   M5-c 把 IM 路并进唯一实现 ⇒ 生产里真的落行的只剩**两处**；"IM 不再自己写"这件事另立一条反证
    //   （只把它从表里删掉，就等于把"少了一处"这件事本身判成了不可断言）。
    const writeSites: Array<[string, string, string]> = [
      ['写点① task-decompose（引擎路与 IM 路共用）', src.decompose, 'decomposePriority(planned, i)'],
      ['写点② project.ipc', src.ipc, 'decomposePriority(tpl.subtasks.length, i)'],
    ];
    for (const [name, text, expr] of writeSites) {
      ok(text.includes(expr), `C-4 ${name}：priority 槽位写 \`${expr}\`（同一换算，不各写一份算式）`);
      ok(!/INSERT INTO wa_tasks \(id, project_id, title, description, status, priority[\s\S]{0,140}?'pending', i,/.test(text),
        `C-4 ${name} **反证（源码级）**：INSERT 的 priority 槽位已不再是裸 \`i\``);
    }
    ok(src.im.includes('planSubtasksFromTemplate(') && !src.im.includes('decomposePriority('),
      'C-4 ★ zx_20260929 M5-c：IM 拆解路**没有第三处写点**——`im-router.ts` 零 `decomposePriority(`，'
      + '它把模板交给写点①（同一换算、同一处 INSERT）');
    // 注记：落点都说清这一格是"拆解序号"（方案 §M3「必须同改 + 注释写清语义归属」）
    // ⚠ 注记常写在代码**上方** ⇒ 取 needle **前后**两侧（`around`），只朝后取会取不到注记。
    // ⚠ 锚点须落在**本批那条读点**上：`getReadyTasks(` 在 task-scheduler.ts 里另有一处**调用**
    //   （`this.getReadyTasks(proj.id)`）在定义之前 ⇒ 用定义签名 `getReadyTasks(projectId: string)` 定位。
    const notes: Array<[string, string, boolean]> = (() => {
      const a = around(RAW.sched, 'getReadyTasks(projectId: string)', 1400, 300);
      const b = around(RAW.ctrl, "AND (depends_on IS NULL OR depends_on = '') ORDER BY priority DESC", 1600, 200);
      const c = around(RAW.acct, 'export function decomposePriority(', 1600, 300);
      return [
        ['读点① task-scheduler.getReadyTasks', a.block, a.found],
        ['读点② control.exit_plan_mode', b.block, b.found],
        ['换算真源 task-accounting.decomposePriority', c.block, c.found],
      ];
    })();
    for (const [name, block, found] of notes) {
      ok(found && block.includes('拆解序号'),
        `C-4b 注记在位：${name} 明写这一格是**拆解序号**（防下轮再当"紧要度"读）`
        + '（且锚点自身命中 —— 取不到块与注记不在位是两件事）',
        `命中=${found} 块长 ${block.length}`);
    }
    ok(/用户优先级|用户给的紧要度/.test(notes[0]![1]) && /用户优先级|用户给的紧要度/.test(notes[2]![1]),
      'C-4c 且**点明与"用户优先级"的区分**（`priority` 在 task:create / create_subtask / GUI 编辑那几条路上'
      + '装的是 0–3 紧要度）—— 两个语义同列并存是既有事实，本轮只改拆解那一半');
    ok(!/getReadyTasks[\s\S]{0,700}ORDER BY[^\n]*rowid/.test(src.sched)
      && !/ORDER BY priority DESC[^\n]*rowid/.test(src.sched),
      'C-4d **反证（J-6 不并存）**：读点未引入第二套序（"拆解一律写 0 + `rowid ASC`"已裁定不采用）');
  }

  console.log(`\n【D】扫描面与自证`);

  // ── D-1 `alreadyDecomposed` 唯一实现（扫描面自带负向对照）──
  {
    const MAIN = path.join(ROOT, A, 'src', 'main');
    const files: string[] = [];
    (function walk(d: string) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) files.push(p);
      }
    })(MAIN);
    // ⚠ 量的是**代码**：注释里点名这处旧写法（"此前写成裸的 `countActiveChildren(db, id) > 0`"）是
    //   **史注**而非第二份实现 —— 不剥注释则注记自己就把这条判据判红（同族教训：负面子串断言会被
    //   订正注释自己判红）。故两把尺都在**去注释面**上量，且下面另附一条"注记确实在、但不算实现"的反证。
    const codeOf = (f: string) => stripComments(fs.readFileSync(f, 'utf-8'));
    const hits = files.filter((f) => /countActiveChildren\s*\([^)]*\)\s*>\s*0/.test(codeOf(f)))
      .map((f) => path.relative(ROOT, f));
    eq(hits, [`${A}/src/main/core/task-accounting.ts`],
      'D-1 `countActiveChildren(…) > 0` 全仓**代码面**只剩**一处**（即 `alreadyDecomposed` 体内）——"防重复拆解"判据归一处',
      `实测 ${hits.length} 处：${hits.join(',')}`);
    const inCommentOnly = files.filter((f) => /countActiveChildren\s*\([^)]*\)\s*>\s*0/.test(fs.readFileSync(f, 'utf-8'))
      && !/countActiveChildren\s*\([^)]*\)\s*>\s*0/.test(codeOf(f))).map((f) => path.relative(ROOT, f));
    ok(inCommentOnly.length > 0,
      'D-1a **反证（该在场）**：确有文件在**注释里**提到这处旧写法（史注是真的）⇒ 上一条的"只剩一处"'
      + '是"注释不算实现"，不是"这句话在仓里搜不到"',
      `注释面命中 ${inCommentOnly.length} 个文件：${inCommentOnly.join(',')}`);
    // 负向对照：同一把尺量一个**确有**出现的模式，必须非空（否则上面那句"只剩一处"可能只是扫描器恒假）
    const anyCac = files.filter((f) => /countActiveChildren\s*\(/.test(codeOf(f))).length;
    ok(anyCac >= 3, 'D-1b **扫描器自证非恒假**：同一把尺量 `countActiveChildren(` 命中多文件（它是在用的符号）',
      `命中 ${anyCac} 个文件 / 扫描面 ${files.length} 个 .ts`);
    ok(/export function alreadyDecomposed\(/.test(src.acct) && /export function decomposePriority\(/.test(src.acct),
      'D-1c 两个新真源符号**在册**（符号被删/改名 ⇒ 本脚本编译期先红，而不是静默假绿）');
  }

  // ── D-2 本脚本自身无"只为下一轮"的字面量 ──
  {
    const SELF = path.basename(__filename);
    const selfTag = SELF.match(/^rr_(zx_\d{8}(?:_\d+)?)_b3\.ts$/)?.[1] ?? '';
    ok(selfTag !== '', 'D-2 本脚本轮次标识由**文件名派生**（不手抄字面量 ⇒ 不会成为"只为下一轮"的哑雷）', SELF);
    const body = stripComments(RD(`scripts/${SELF}`));
    const lits = [...body.matchAll(/'zx_[0-9_]+'/g)].map((x) => x[0]);
    eq(lits, [], 'D-2b 正文里**零**轮次字面量（含 `=== \'zx_…\'` 这类等值断言 —— 换个语法外壳也躲不过这一条）',
      lits.join(','));
  }

  console.log(`\n【S】build 钉（派生核对，不写轮次字面量）`);
  checkBuildPins(ok, { distDir: path.join(ROOT, A, 'dist') });
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告
//    unhandled rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20260924_1_b3 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260924_1_b3: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
});
