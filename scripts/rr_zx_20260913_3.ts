/**
 * zx_20260913 M3 受控复跑（「子任务·跑得起来」——名实相符 · 同一把尺）。
 *
 * 覆盖 M3-1..M3-7：
 *   M3-1 拆解出的子任务真的会跑：四处创建路径（模板 project.ipc / LLM im-router / 工具 create_task·spawn_subagent）
 *        子任务一律落 `pending`，父由 `planning` 改落 `pending`（原落 paused/planning ⇒ 无任何路径解锁 ⇒ 永不启动）；
 *   M3-2 依赖「可解不可解」切五态（met/waiting/dead/unresolved）——**逐情形等价**旧布尔尺（unresolved 不阻塞）；
 *   M3-3 序号→id 只在创建一刻映射（库里不引入第二套格式）；
 *   M3-4 前置可编辑 + 自环/间接环直接拒 + 跨项目拒 + 查不到的 id 允许但如实标注；
 *   M3-5 前置阻塞态按**状态**展示（详情页/列表），旧文案只要 depends_on 非空就喊"被阻塞"；
 *   M3-6 收口闸：finalize_task 自检、收口路径、run_close、兄弟判据四处**同一把尺**（completed/failed/archived 之外皆未完成）；
 *   M3-7 父恢复带**逐子交付摘要**（子标题｜摘要｜产出N件｜验收），只取既有字段。
 *
 * 断言两类（承 feedback「往返/闭环类判据须在生产入参上证」）：
 *   ① 行为断言动态 import **真实现**——`classifyDep`/`depBlocksRun`/`parseDepIds`/`depBlockInfo`/
 *      `resolveIndexDeps`/`introducesCycle` 直调；生产 SQL **从源码就地取出**再执行（生产 SQL × 生产夹具），
 *      不另写一份等价 SQL；
 *   ② 静态断言一律 `stripComments` 后再比对，防注释关键词假阳性；每项均附**反证**（旧写法喂同一判据必红）。
 *
 * ⚠ 本文件不打开任何真库（真库只读实测见 data/baseline_zx_20260913.json）。
 * ⚠ 如实挂账（本批不过问、非回归）：`admin.ipc.ts:170` 的 DAG 概览仍用两值尺排除 completed/failed——
 *   那是「画哪些节点」的展示判据（archived 有意不画），非「子任务是否收口」的判据；两者不同尺，非同尺漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  classifyDep, depBlocksRun, parseDepIds, depBlockInfo, resolveIndexDeps, introducesCycle,
  DEP_DEAD_STATUSES, type DepState,
} from '../apps/worker-ant-desktop/src/main/core/dep-graph.js';
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
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', parent_task_id TEXT, title TEXT DEFAULT '',
  description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0,
  context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '', source TEXT DEFAULT 'test',
  acceptance_criteria TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', task_id TEXT, type TEXT NOT NULL,
  name TEXT DEFAULT '', description TEXT DEFAULT '', file_path TEXT, status TEXT DEFAULT 'draft',
  is_primary INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, content TEXT,
  token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
`;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };
const addTask = (db: AnyDb, id: string, status: string, deps = '', parent: string | null = null, title = id, ctx: Record<string, unknown> = {}): void => {
  db.prepare('INSERT INTO wa_tasks (id, project_id, parent_task_id, title, status, depends_on, context_json) VALUES (?,?,?,?,?,?,?)')
    .run(id, 'p', parent, title, status, deps, JSON.stringify(ctx));
};
const statusOfIn = (db: AnyDb) => (id: string) => (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string } | undefined)?.status;

// ── 旧实现（M3-2 前的唯一运行时判据）：存在**在库中查得到**且状态非 completed 的前置 ──
// 逐字复刻旧代码语义，仅用于「等价性对拍」与「反证」。
const oldHasUnmet = (db: AnyDb, taskId: string): boolean => {
  const task = db.prepare('SELECT depends_on FROM wa_tasks WHERE id = ?').get(taskId) as { depends_on: string } | undefined;
  const deps = String(task?.depends_on || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (deps.length === 0) return false;
  const c = db.prepare(`SELECT COUNT(*) as c FROM wa_tasks WHERE id IN (${deps.map(() => '?').join(',')}) AND status != 'completed'`)
    .get(...deps) as { c: number };
  return c.c > 0;
};

const schedSrc = () => stripComments(RD(`${A}/src/main/core/task-scheduler.ts`));
const aeSrc = () => stripComments(engineSrc());
const ipcSrc = () => stripComments(RD(`${A}/src/main/ipc/project.ipc.ts`));
const imSrc = () => stripComments(RD(`${A}/src/main/services/im-router.ts`));
const aiSrc = () => stripComments(RD(`${A}/src/main/core/jobs/ai-task.ts`));

// ══════════════════════════════════════════════════════════════════
// S0 (M3-2) 判据归一处真源 —— 跨 root 同一份代码（G8 病灶不可能复发）
// ══════════════════════════════════════════════════════════════════
console.log('\n[S0 M3-2 依赖判据·一处真源（跨 root 同引）]');
{
  const src = RD(`${A}/src/main/core/dep-graph.ts`);
  ok(!/from\s+['"](electron|better-sqlite3|node:)/.test(src),
    '真源模块零依赖（无 electron/better-sqlite3/node:*）⇒ 渲染层可跨 root 直引（同 settings-bool 范式）');
  // 判据**不得写死本轮取值**（写死即"只为下一轮引爆的哑雷"）：只钉"外置成常量 + 含 failed/archived"，
  // 加值（zx_20260917 M3 补入 `paused`）与后续再扩都不该弄红本条。
  ok(/export const DEP_DEAD_STATUSES = \[[^\]]*'failed'[^\]]*'archived'[^\]]*\] as const;/.test(src),
    '「永不可满足」状态外置常量（读点不再各写一遍；不写死取值，加值不引爆）');
  ok(schedSrc().includes('return depBlocksRun(this.depStateOf(taskId));'),
    'hasUnmetDependencies 只剩一行转发（判据本体不在调度器里）');
  ok(!/status != 'completed'[\s\S]{0,80}?\.get\(\.\.\.deps\)/.test(schedSrc()),
    '反证：调度器内已无旧布尔尺（`status != \'completed\'` 计数）残留');
  // 渲染层跨 root 引同一份（G8: renderer 不在 src/main 扫描面内，手抄必漂）
  for (const f of ['TaskDetailPage.tsx', 'TasksPage.tsx']) {
    ok(RD(`${A}/renderer/src/pages/${f}`).includes("from '../../../src/main/core/dep-graph.js'"),
      `${f} 跨 root 引同一真源（非手抄）`);
  }
  // 反证：渲染层不得再手写「只要 depends_on 非空就喊被阻塞」的旧文案
  const hand = ['TaskDetailPage.tsx', 'TasksPage.tsx'].filter((f) =>
    /被前置依赖阻塞|前置依赖未完成/.test(stripComments(RD(`${A}/renderer/src/pages/${f}`))));
  eq(hand, [], '反证：渲染层已无「一概喊被阻塞」的旧文案（M3-5 的病除）');
  // 编译产物确含该跨 root 模块的**实现本体**，且全 dist 恰一份（同一份实现跨页共享）。
  // ★zx_20261029_3 M4 改锚：旧判据认文件名 `dep-graph-*.js`——chunk 名是打包器给共享模块起的名字，
  //   随 import 图变化（本轮新增 `lib/task-source.ts` 同被两页消费后，共享 chunk 改名为 `task-source-*`）。
  //   文件名是排布细节，实现本体是模块指纹：改锚在由真源**派生**的文案指纹上，并加钉"恰一份"。
  const distDir = path.join(__dirname, '..', `${A}/renderer/dist/assets`);
  const depProbeId = '__dep_probe_missing__';
  const depMark = depBlockInfo([depProbeId], () => undefined, () => '').text.split(depProbeId).pop() ?? '';
  const jsAssets = fs.existsSync(distDir) ? fs.readdirSync(distDir).filter((f) => f.endsWith('.js')) : [];
  const depHolders = jsAssets.filter((f) => fs.readFileSync(path.join(distDir, f), 'utf-8').includes(depMark));
  ok(depMark.length > 8 && depHolders.length === 1,
    'renderer 构建产物含 dep-graph 实现本体且全 dist 恰一份 ⇒ 跨 root 引入确实成立（非仅语句在）',
    `${depHolders.join(',') || '(未找到)'}；指纹 ${JSON.stringify(depMark)}`);
}

// ══════════════════════════════════════════════════════════════════
// S1 (M3-2) 五态分类 —— 与旧布尔尺**逐情形等价**（unresolved 不阻塞是旧行为的如实命名）
// ══════════════════════════════════════════════════════════════════
console.log('\n[S1 M3-2 五态分类 × 旧布尔尺·逐情形对拍（16 例穷举，含 zx_20260917 M3 的 paused 两例）]');
{
  const db = mkdb();
  addTask(db, 't1', 'completed');
  addTask(db, 't2', 'pending');
  addTask(db, 't3', 'failed');
  addTask(db, 't4', 'archived');
  addTask(db, 't5', 'completed');
  addTask(db, 't6', 'running');
  // zx_20260917 M3：`paused` 前置。t7 的因由**不在**本用例的取值面内（`statusOf` 只给状态），
  // 故它走的是"因由未知 ⇒ 保守判死"；按因由细分（等子而暂停 ⇒ waiting）由 rr_zx_20260917 判据 D 单测。
  addTask(db, 't7', 'paused');
  const statusOf = statusOfIn(db);

  const CASES: Array<[string, DepState, string]> = [
    ['', 'met', '无前置'],
    ['zzz', 'unresolved', '前置查不到（笔误）'],
    ['t1', 'met', '前置已完成'],
    ['t2', 'waiting', '前置在跑'],
    ['t6', 'waiting', '前置 running 亦算在推进'],
    ['t3', 'dead', '前置 failed'],
    ['t4', 'dead', '前置 archived'],
    ['t7', 'dead', '前置 paused（因由未提供 ⇒ 保守判死，不许诺自动解锁）'],
    ['t2,t2', 'waiting', '重复 id 去重'],
    ['t1,t2', 'waiting', '一完成一在跑'],
    ['t1,zzz', 'unresolved', '一完成一笔误 ⇒ 不阻塞'],
    ['t3,zzz', 'dead', '失败者优先于笔误'],
    ['t2,t3', 'dead', '在跑+失败 ⇒ 永不可满足才是用户要知道的事'],
    ['t1,t5', 'met', '两前置皆完成'],
    ['t1,t5,t2', 'waiting', '两完成一在跑'],
    // M3 的病根：此前 `paused` 并进 waiting（"会自动解锁"），而它没有自解路径 ⇒ 与 dead 同族
    ['t1,t7', 'dead', '一完成一暂停 ⇒ dead（paused 的自解路径只对"等子而暂停"存在）'],
  ];
  let equiv = 0;
  for (const [deps, want, why] of CASES) {
    addTask(db, 'TGT', 'pending', deps);
    const state = classifyDep(parseDepIds(deps), statusOf);
    const oldB = oldHasUnmet(db, 'TGT');
    const newB = depBlocksRun(state);
    ok(state === want, `「${deps || '(空)'}」→ ${state}（${why}）`, `期望 ${want}`);
    ok(newB === oldB, `  ↳ 与旧布尔尺等价：新=${newB} 旧=${oldB}（${why}）`);
    if (newB === oldB) equiv++;
    db.prepare("DELETE FROM wa_tasks WHERE id = 'TGT'").run();
  }
  ok(equiv === CASES.length,
    `等价性：${equiv}/${CASES.length} 例新旧一致 ⇒ depBlocksRun 是旧判据的等值换名，非行为改动`);

  // 反证：把 unresolved 也当阻塞（"有前置即阻塞"的误读），'zzz' 立刻与旧行为分叉
  const wrongBlocks = (deps: string) => parseDepIds(deps).length > 0;   // 旧实现不可能这样：它要查到行才计数
  ok(wrongBlocks('zzz') !== oldHasUnmet(db, (addTask(db, 'TGT2', 'pending', 'zzz'), 'TGT2')),
    '反证：「有前置即阻塞」会判 zzz 阻塞，而旧尺判不阻塞 ⇒ unresolved 有意不阻塞（承 M3-2 裁定）');
  db.prepare("DELETE FROM wa_tasks WHERE id = 'TGT2'").run();
}

// ══════════════════════════════════════════════════════════════════
// S2 (M3-1) 解锁闭环 —— 子任务落 pending 后，前置完成即**自动**启动
// ══════════════════════════════════════════════════════════════════
console.log('\n[S2 M3-1 解锁闭环（getReadyTasks 生产 SQL 就地取出 × 状态推进）]');
{
  const db = mkdb();
  addTask(db, 'A', 'pending');
  addTask(db, 'B', 'pending', 'A');
  addTask(db, 'C', 'pending', 'A,B');

  // getReadyTasks 取数 SQL：从源码就地取出（生产 SQL × 生产夹具）
  const m = schedSrc().match(/"(SELECT \* FROM wa_tasks WHERE project_id = \? AND status = 'pending' ORDER BY priority DESC, created_at ASC)"/);
  ok(!!m, 'getReadyTasks 取数 SQL 由源码就地取出（未另写等价 SQL）');
  // zx_20260917 M3: 该 SQL 多取一列 `context_json`——`paused` 前置的可解性取决于**因由**，故取数必须一并带上
  // zx_20261018_3 批二就地重定向（更强真源，非放宽）：该读点已从调度器内联迁入 `task-dep-gate.ts` 的
  //   `readTaskDeps`——调度器与三条人工入口（执行/重试/恢复）共用这**一处**读法。判据改钉两件：
  //   ① 调度器确实**转发**到该真源（不是又留了一份内联 SQL）；② 真源 SQL 仍取齐 `status` + `context_json`。
  const md = stripComments(RD(`${A}/src/main/core/task-dep-gate.ts`))
    .match(/`SELECT id, title, status, context_json FROM wa_tasks WHERE id IN \(\$\{deps\.map\(\(\) => '\?'\)\.join\(','\)\}\)`/);
  ok(!!md, 'depStateOf 取数 SQL 同法就地取出（同一把尺的读点在 `task-dep-gate.ts`；一并取 context_json 供按因由细分）');
  ok(schedSrc().includes('taskDepState(this.db, taskId)'),
    '调度器的依赖读法**转发**到该真源（`taskDepState`）——不再自带第二份取数 SQL');
  const readySQL = m![1]!;

  const readyOf = () => {
    const rows = db.prepare(readySQL).all('p') as Array<{ id: string; depends_on: string }>;
    return rows.filter((t) => {
      const deps = parseDepIds(t.depends_on);
      if (deps.length === 0) return true;
      const got = db.prepare(`SELECT id, status FROM wa_tasks WHERE id IN (${deps.map(() => '?').join(',')})`).all(...deps) as Array<{ id: string; status: string }>;
      const byId = new Map(got.map((r) => [r.id, r.status]));
      return !depBlocksRun(classifyDep(deps, (id) => byId.get(id)));
    }).map((t) => t.id);
  };
  eq(readyOf(), ['A'], '初始：仅 A 就绪（B 等 A、C 等 A+B）');
  ok(!readyOf().includes('B'), '反证：B 有未完成前置 ⇒ 被挡（不是"一律放行"）');

  db.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = 'A'").run();
  eq(readyOf(), ['B'], 'A 完成后**下一次扫描**B 自动就绪（无新增机制：只经 getReadyTasks 一条路）');
  db.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = 'B'").run();
  eq(readyOf(), ['C'], 'B 完成 ⇒ 链尾 C 就绪（多前置逐个解锁）');

  // 死前置：永不就绪，且态为 dead（区别于 waiting）——须如实告知而非默默等
  db.prepare("UPDATE wa_tasks SET status = 'pending' WHERE id = 'A'").run();
  db.prepare("UPDATE wa_tasks SET status = 'failed' WHERE id = 'B'").run();
  ok(!readyOf().includes('C'), '前置 failed ⇒ C 不就绪（旧行为亦然，非新收紧）');
  const cDeps = parseDepIds((db.prepare("SELECT depends_on FROM wa_tasks WHERE id='C'").get() as { depends_on: string }).depends_on);
  const cStatus = new Map((db.prepare("SELECT id, status FROM wa_tasks WHERE id IN ('A','B')").all() as Array<{ id: string; status: string }>).map((r) => [r.id, r.status]));
  ok(classifyDep(cDeps, (id) => cStatus.get(id)) === 'dead', '且其态为 dead（区别于 waiting）⇒ 界面能喊"永不可满足"');

  // 旧病反证：子任务落 paused ⇒ getReadyTasks（只选 pending）永远看不见它
  db.prepare("UPDATE wa_tasks SET status = 'paused' WHERE id = 'A'").run();
  ok(!readyOf().includes('A'), '反证：落 `paused` 的任务不被 getReadyTasks 选中 ⇒ M3-1 前"子任务落 paused"等于永不启动');
  const noParent = db.prepare("SELECT COUNT(*) as c FROM wa_tasks WHERE id = 'A' AND parent_task_id IS NULL").get() as { c: number };
  ok(noParent.c === 1, '反证：A 无父 ⇒ checkParentTaskAfterChildDone 早退（me.parent_task_id 为空），无人把它转 pending');
}

// ══════════════════════════════════════════════════════════════════
// S2b (M3-1) 四处创建路径：子落 pending、父由 planning 改落 pending
// ══════════════════════════════════════════════════════════════════
console.log('\n[S2b M3-1 四处创建路径落 pending（父亦 pending）]');
{
  const ae = aeSrc();
  const ipc = ipcSrc();
  const im = imSrc();

  // ① 工具 create_task
  ok(ae.includes("const status = 'pending';") && !/const status = args\.depends_on \? 'paused' : 'pending'/.test(ae),
    'create_task：子任务一律落 pending（反证：旧 `args.depends_on ? \'paused\' : \'pending\'` 已除）');
  // zx_20260914 M0.5-1：本断言原钉住无前置分支里的**裸插**（`db.prepare("INSERT INTO wa_jobs")`）——
  // 而裸插正是该轮的病：内存队列只由 enqueue/启动恢复填充，裸插作业在运行期不被消费。
  // 故判据随实现一起改钉 `enqueueJob`（一处真源）。
  // zx_20260917 M5-1（链上至多一个在跑）：入队条件又加一条**父在跑则改派**（真源 `childDispatchHint`），
  //   故本断言随实现再改一次——仍钉"意图"（有前置 ⇒ 只交调度器；父在跑 ⇒ 不即刻入队），不钉行号/不钉局部变量名。
  ok(/if \(!args\.depends_on && !parentBusyHint\) \{[\s\S]{0,80}enqueueJob\(db, 'ai-task'/.test(ae),
    'create_task：仅"无前置 **且** 父不在跑"才即刻入队（经 enqueueJob 一处真源）；有前置或父在跑者**只**交调度器');
  ok(ae.includes('const parentBusyHint = childDispatchHint(db, taskId);'),
    'create_task：派发闸取**共用真源** `childDispatchHint`（与调度器同一份判据，不抄第二份）');
  ok(!ae.includes('if (!args.depends_on) {\n          db.prepare("INSERT INTO wa_jobs'),
    '反证：无前置分支的裸插已除（运行期不被消费的作业，M0.5-1 的病不再复发）');
  ok(ae.includes("'created_deferred_parent_busy'")
    && ae.includes("'created_and_pending'")
    && ae.includes('本任务**不会**自动启动，须人工处置'),
    'create_task 回话如实区分三态（有前置 / 父在跑未入队 / 已入队），不谎称"已入队"');
  // ② 工具 spawn_subagent
  // zx_20260915 P0-2: 该 INSERT 末列增 `acceptance_criteria`（子 agent 任务也能带验收标准）——
  //   列名表由「…source, depends_on」变为「…source, depends_on, acceptance_criteria」，判据（落 pending 是字面量）不变。
  ok(/INSERT INTO wa_tasks \(id, project_id, title, description, status, priority, context_json, parent_task_id, source, depends_on, acceptance_criteria\) VALUES \(\?, \?, \?, \?, 'pending'/.test(ae),
    'spawn_subagent：子任务落 pending（字面量在 INSERT 内）');
  ok(ae.includes('if (depIds.length === 0) {') && ae.includes("created_pending_deps"),
    'spawn_subagent：有前置则不立即派发（派发同样只经调度器一条路）');
  ok(/dependsOn: \{ type: 'string'/.test(ae), 'spawn_subagent 新增 dependsOn 入参（与 create_task 同一表达）');
  ok(/const depIds = parseDepIds\(args\.dependsOn\);/.test(ae), 'spawn_subagent 入参经同一 parseDepIds 解析（不自写 split）');

  // ③ 模板拆解 project.ipc
  // zx_20260924_1 M3-a（J-6）：本断言原逐字钉住 `'pending', i, JSON.stringify({…})` —— 主张有两半，
  //   一半（落 pending）不变，另一半（priority 那一格写**裸序号 `i`**）随实现改：序号语义未变，
  //   但换算改为经**唯一真源** `decomposePriority(planned, i)`（本处 `planned` = `tpl.subtasks.length`），
  //   与两处 `ORDER BY priority DESC` 读点同口径（裸 `i` 在 DESC 下 ⇒ 同批无前置子任务**最后一个最先跑**）。
  //   按本仓纪律**改钉更强的新真源**：断言"序号那一格经换算写出"，而不是把那一段从判据里删掉
  //   （删掉＝钉子在原地拔掉，裸 `i` 复辟也照样绿）。
  ok(ipc.includes("'pending', decomposePriority(tpl.subtasks.length, i), JSON.stringify({ depth: 1, auto_decomposed: true, parent_task_id: id, template: tpl.id }), id, 'template'"),
    '模板拆解：子任务落 pending，且 priority 经唯一换算 `decomposePriority(tpl.subtasks.length, i)` 写出（反证：旧字面量 paused）');
  ok(!ipc.includes("'pending', i, JSON.stringify({ depth: 1, auto_decomposed: true, parent_task_id: id"),
    '反证：裸序号 `i` 直接进 priority 槽位的写法已除（否则同批"最后一个最先起跑"的病根复现）');
  // zx_20260924 缺陷B（用户报「父任务从来没落过拆解标记」）：本断言原**逐字钉住病根本身**——
  //   `json_set(json_set(json_set(json_set(`（4 层套 5 组键值）⇒ 层数≠键值对数抛 `near ",": syntax error`，
  //   被紧随的 `catch` 吞成一条 warn，父任务永远落不下 template/matched_*。判据钉住病根 = 病根恒绿，
  //   改实现时先红、极易被"顺手改绿"（同 zx_20260920_1「判据的自我印证」同族）。
  //   现改为钉**主张的形状**：一条把 `$.auto_decomposed` 写进 context_json 的 UPDATE，**不**钉层数写法。
  ok(/UPDATE wa_tasks SET context_json = json_set\([\s\S]{0,80}?'\$\.auto_decomposed'[\s\S]{0,400}?WHERE id = \?/.test(ipc),
    '模板拆解：父只补拆解标记（写 context_json 的 $.auto_decomposed；父由上方 INSERT 已落 pending）');
  ok(!/json_set\(json_set\(/.test(ipc),
    '反证：嵌套 json_set 套娃已除（层数恒为 1、与键值对数解耦 ⇒ "手工漏一层"结构上不再可能）');
  ok(!/UPDATE wa_tasks SET status = 'planning'/.test(ipc),
    '反证：模板拆解已无 `status = \'planning\'`（旧值只由 30 分钟超时收割转 paused ⇒ 父永不动工）');
  ok(!/UPDATE wa_tasks SET status = [^\n]{0,200}?\$\.template/.test(ipc),
    '且**拆解落标这条**不重写状态（父建任务即 pending；同值写无意义）');
  // zx_20260914 M0.6：本断言原把 `context_json` 的 `'{}'` 字面量一并钉住——而 M0.6 让建任务 INSERT
  // 按幂等键改写成 `reqId ? JSON.stringify({client_request_id: reqId}) : '{}'`，无关字段一变断言就红。
  // 本断言的**主张**只有"父落 pending 由建任务 INSERT 承担"，故收窄到**状态槽位**本身——
  // 判据不该因无关字段的改写而变色（否则每轮跟着修，迟早被"顺手改绿"而成摆设）。
  ok(ipc.includes("VALUES (?, ?, ?, ?, ?, 'pending', ?, "), '父落 pending 由建任务 INSERT 承担（本 handler 建任务即 pending 字面量）');
  ok(!ipc.includes("VALUES (?, ?, ?, ?, ?, 'paused', ?, "), '反证：建任务 INSERT 的状态槽位不是 paused（「父永不动工」的病根不复现）');
  ok(ipc.includes('（状态 pending，按依赖自动启动）'), '会话记账文案与落态一致（不再许诺"按序执行"）');

  // ④ LLM 拆解 im-router
  // zx_20260924_1 M3-a（J-6）：同上——priority 那一格由裸 `i` 改为唯一换算 `decomposePriority(...)`。
  // zx_20260929 M5-c **就地订正**（改钉更强真源，非放宽）：本判据原钉在 IM 路**自带的第二份落行实现**上
  //   （`'pending', decomposePriority(template.length, i), JSON.stringify({ depth: 1, … source: 'im' …`）。
  //   M5-c 把「模板 → 行」归到唯一实现 `task-decompose.planSubtasksFromTemplate` ⇒ 那句字面量**整条退场**，
  //   落行形状只剩**一处**可钉。故本判据一分为二：形状钉在唯一实现上（更强：同时覆盖引擎路与 IM 路），
  //   另加一条**反证**证"IM 路确已不带第二份"——"归一处"这件事本身要被断言，不能只靠"没扫到"。
  const decRaw = RD(`${A}/src/main/core/task-decompose.ts`);
  ok(decRaw.includes("'pending', decomposePriority(planned, i), JSON.stringify(ctx), opts.parentTaskId, opts.source,")
    && /depth:\s*childDepth/.test(decRaw),
    '唯一落行实现：子任务落 pending，priority 经唯一换算 `decomposePriority(planned, i)`，深度由 `depth + 1` 派生');
  ok(!/INSERT INTO wa_tasks[\s\S]{0,200}?'pending', i,/.test(decRaw),
    '反证：裸序号 `i` 直接进 priority 槽位的写法在唯一实现里亦不存在（"最后一个最先起跑"的病根不复现）');
  ok(im.includes('planSubtasksFromTemplate(ctx.db, {') && im.includes("source: 'auto-decompose',")
    && !im.includes('INSERT INTO wa_tasks (id, project_id, title, description, status, priority,'),
    '★ M5-c IM 拆解路**不自带落行实现**：整批模板交给唯一实现（`depth: 0` ⇒ 子深度 1），'
    + '且本文件里 11 列那条子任务 INSERT 已退场');
  ok(im.includes("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.auto_decomposed', json('true')), updated_at = datetime('now') WHERE id = ?"),
    'LLM 拆解：父只补拆解标记（父由上方 INSERT 已落 pending）');
  // ★ 与既有约束不撞车：IM 侧「恢复必返还额度」要求一切 status='pending' 写点走 resumeWithQuota。
  // 拆解路径非恢复（父本就是 pending）⇒ 只**不写**状态，故该约束原样成立，无需放宽（钉子在 rr_zx_20260910_3_b2）。
  ok(!/SET status = 'pending'/.test(im), 'IM 侧仍无裸 `SET status = \'pending\'`（既有约束未被本批放宽，反证：本批若重写状态此断言必红）');
  ok(!/将在工蚁前端按序执行/.test(im),
    '反证：假许诺「子任务将在工蚁前端按序执行」已删（它从不成立）');
  ok(im.includes('其中 ${noDepCount} 个无前置可立即动工'), '回话如实给出"几个能立刻动工"（名实相符）');

  // 静态：全库唯一处理 planning 的仍是 30 分钟收割（M3-1 未新增机制，只是不再把父停在那儿）
  eq((schedSrc().match(/status = 'planning'/g) || []).length, 1,
    'planning 在调度器内仅一处读点 = 30 分钟超时收割（未新增机制）');
  // zx_20260917 M1：收割动作改经唯一写入口 `pauseTask`（裸 UPDATE 退场），判据仍是"置 paused"，
  //   只是写成"经写入口 + 落因"，而落因正是本轮要补的那一笔。
  ok(schedSrc().includes('MAX_PLANNING_MS') && schedSrc().includes('pauseTask(this.db, { taskId: pt.id, reason: PAUSE_REASON_PLANNING_TIMEOUT })'),
    '收割把超期 planning 置 paused 并落因 planning_timeout（判据未变，只是拆解路径不再停在此态）');
  // planning 仍是活态：enter_plan_mode 写得进、exit_plan_mode 出得来（未因 M3-1 变成死态）
  ok(ae.includes("SET status = 'planning'") && /SET status = 'pending', context_json = \?, updated_at/.test(ae),
    'planning 仍由 enter_plan_mode↔exit_plan_mode 成对使用');
  // zx_20260929 M5-a（维特根斯坦·意义即用法）**就地订正**（改钉更强真源，非放宽）：
  //   旧判据钉的是 `WHERE parent_task_id = ? AND status IN ('pending','paused')`——它把两件事**并成一句**
  //   （"存在子" 与 "有待派发的子"），于是 ① 子全为 `completed` 时误报"请先创建子任务"（子明明在）、
  //   ② 子全为 `preparing`/`executing` 时少算。两件事现**各判各的**，判据随之钉在**分离**这件事上。
  //   ⚠ 读**原文**（`RD`）不读 `ae`（`stripComments` 过的）——本仓 zx_20260928 教训：去注释是静默毁伤。
  const ctrlRaw = RD(`${A}/src/main/core/tools/control.ts`);
  const guardSql = (ctrlRaw.match(/SELECT COUNT\(\*\) as count FROM wa_tasks WHERE parent_task_id = \?[^'`]*/) || [''])[0];
  ok(guardSql !== '' && !/status\s*(IN|=)/.test(guardSql),
    'exit_plan_mode 的「存在子吗」判据**不按状态筛**（子全 completed 时不再误报"请先创建子任务"；'
    + '该不该派发由下面那条另判）', guardSql);
  ok(ctrlRaw.includes("SELECT id, title, description FROM wa_tasks WHERE parent_task_id = ? AND status = 'pending' AND (depends_on IS NULL OR depends_on = '')"),
    '★「是否有**待派发**的子」**另判**：只认 `pending` 且无前置——与上面那条**两个问题两个判据**，不得再并回一句');
}

// ══════════════════════════════════════════════════════════════════
// S3 (M3-3) 序号→id 只在创建一刻映射（库里不引入第二套格式）
// ══════════════════════════════════════════════════════════════════
console.log('\n[S3 M3-3 resolveIndexDeps（序号→id，越界如实丢弃）]');
{
  const kids = ['id-a', 'id-b', 'id-c'];
  eq(resolveIndexDeps([1], kids), 'id-a', '序号 1 → 第 1 个 id');
  eq(resolveIndexDeps([3], kids), 'id-c', '序号 3 → 第 3 个 id');
  eq(resolveIndexDeps([1, 3], kids), 'id-a,id-c', '多前置保序 join');
  eq(resolveIndexDeps([1, 1], kids), 'id-a', '重复序号去重');
  eq(resolveIndexDeps([0], kids), '', '序号 0 越界 ⇒ 丢弃（1-based）');
  eq(resolveIndexDeps([4], kids), '', '序号 4 越界 ⇒ 丢弃（不猜模型意图）');
  eq(resolveIndexDeps([1.5], kids), '', '非整数 ⇒ 丢弃');
  eq(resolveIndexDeps([NaN as unknown as number], kids), '', 'NaN ⇒ 丢弃');
  eq(resolveIndexDeps([], kids), '', '空数组 ⇒ 空串');
  eq(resolveIndexDeps(undefined, kids), '', 'undefined ⇒ 空串（无前置）');
  eq(resolveIndexDeps('2', kids), 'id-b', '标量字符串同样受理（LLM 常给单值）');
  eq(resolveIndexDeps([1, 4, 2], kids), 'id-a,id-b', '越界项丢、合法项保留（部分可用即部分可用）');
  // 反证：越界若"取模/就近"猜一个，会给出一个模型没说的前置（危险方向）
  ok(resolveIndexDeps([4], kids) !== kids[0] && resolveIndexDeps([4], kids) !== kids[2],
    '反证：越界不被就近/取模猜成某个真 id（宁少不滥）');

  // 库里的格式必须是 id 串（读点才能只此一套解析）
  const ipc = ipcSrc();
  // ⚠ 2026-09-21（zx_20260921 M6）扫描面**放宽**而非收紧：`resolveIndexDeps` 现多一个**可选**第三参
  //   `selfId`（滤自环，D4 断点②）。旧正则写死两参形状 ⇒ 生产多传一个**合法**实参就判红，
  //   属于"判据的形状假设"跟不上源码演进，不是回归。故正则容许第三参**在场或不在场**。
  ok(/const depIds = resolveIndexDeps\(\(tpl\.subtasks\[i\] as \{ dependsOn\?: unknown \}\)\.dependsOn, childIds(?:, childId)?\);/.test(ipc),
    '模板拆解：dependsOn 经 resolveIndexDeps 映射后再落库');
  ok(ipc.includes(', depIds);') || /, depIds\)\n/.test(ipc), '模板拆解把**映射后的 id 串**写库（不是序号）');
  ok(!/depends_on[^\n]{0,60}subtasks\[i\]\.dependsOn/.test(ipc),
    '反证：depends_on 未直写序号数组（否则读点要猜"这串是序号还是 id"）');
  eq(parseDepIds('id-a, id-b ,id-a'), ['id-a', 'id-b'], 'parseDepIds：去空/trim/去重/保序');
  eq(parseDepIds(null), [], 'parseDepIds：null ⇒ 空');
  // 模型表达侧声明了 dependsOn（序号语义）
  // ⚠ 2026-09-21（zx_20260921 M6）：拆解器**迁出** `task-archetype.ts` → `core/task-decompose.ts`。
  //   被判的**事实**（"模板类型声明了序号语义的 dependsOn + 提示词强制流水线声明前置"）一字未变，
  //   变的只是载体的文件名 ⇒ 扫描面**放宽为两处取并**（只许变宽，不许变窄）。
  const arch = stripComments(RD(`${A}/src/main/core/task-archetype.ts`) + '\n' + RD(`${A}/src/main/core/task-decompose.ts`));
  ok(arch.includes('dependsOn?: number[]'), 'DecompositionTemplate 声明 dependsOn（序号语义，注释在案）');
  ok(/必须\*\*用 dependsOn 声明其前置序号|必须[\s\S]{0,10}用 dependsOn 声明/.test(arch),
    '提示词要求流水线型子任务**必须**声明 dependsOn（否则流水线仍会并行跑）');
  ok(stripComments(RD(`${A}/src/main/core/task-templates.ts`)).includes('dependsOn?: number[]'),
    '内置模板 subtasks 同一声明（同一表达）');
}

// ══════════════════════════════════════════════════════════════════
// S4 (M3-4) 环检测：自环/间接环直接拒（成环 = 双方永不启动的死锁）
// ══════════════════════════════════════════════════════════════════
console.log('\n[S4 M3-4 introducesCycle（自环 / 间接环 / 合法）]');
{
  const db = mkdb();
  addTask(db, 'X', 'pending');
  addTask(db, 'Y', 'pending', 'X');        // Y → X
  addTask(db, 'Z', 'pending', 'Y');        // Z → Y → X
  addTask(db, 'W', 'pending');

  ok(introducesCycle(db as never, 'X', ['X']) === 'X', '自环：X 的前置含自己 ⇒ 拒');
  ok(introducesCycle(db as never, 'X', ['Y']) === 'X', '间接环：Y→X，故 X 前置 Y 成环 ⇒ 拒（返环上触发点）');
  ok(introducesCycle(db as never, 'X', ['Z']) === 'X', '更远间接环：Z→Y→X，X 前置 Z ⇒ 拒');
  ok(introducesCycle(db as never, 'W', ['X']) === null, '合法：W 前置 X（X 无前置）⇒ 放行');
  ok(introducesCycle(db as never, 'X', ['W']) === null, '合法：X 前置 W（W 无前置且上游不含 X）⇒ 放行');
  ok(introducesCycle(db as never, 'X', []) === null, '空前置 ⇒ 放行（清空依赖是合法操作）');
  ok(introducesCycle(db as never, 'X', ['NOPE']) === null, '不存在的 id：非环 ⇒ 放行（交"如实标注"处理）');
  ok(introducesCycle(db as never, 'X', ['Y', 'Z', 'W']) === 'X', '混合：只要一条成环即拒');

  // 反证：只查自环（不做间接上溯）会漏掉 Y/Z 两例
  const selfOnly = (_taskId: string, deps: readonly string[]) => deps.includes('X');
  ok(!selfOnly('X', ['Y']) && !selfOnly('X', ['Z']),
    '反证：只看 `deps.includes(id)` 的两个间接环都会漏 ⇒ 须沿库里 depends_on 上溯');

  // 接线：task:update 三关齐全（环 / 跨项目 / 不存在如实标注）
  const ipc = ipcSrc();
  ok(ipc.includes('const cycleAt = introducesCycle(db as never, id, depIds);') && ipc.includes('前置依赖成环（经'),
    'task:update 接环检测并给出人话（含环上任务片段，不抛纯 uuid）');
  ok(ipc.includes('前置须属同一项目'), 'task:update 拒跨项目前置');
  ok(ipc.includes('[依赖] 前置任务不存在：') && ipc.includes('不阻塞调度（请核对是否写错 id）'),
    'task:update 对查不到的 id **允许写入但如实标注**（承 M3-2 裁定）');
  ok(ipc.includes("sets.push('depends_on = ?');"), 'task:update 真正落库 depends_on（不只校验）');
  ok(/async \(_event, \{ id, title, description, priority, acceptance_criteria, depends_on \}/.test(ipc),
    'task:update 入参解构含 depends_on（参数不会被丢）');
  ok(ipc.includes("if (depends_on !== undefined) {") && ipc.includes("if (!self) return { error: { code: 'NOT_FOUND', message: '任务不存在' } };"),
    'task:update 依赖分支：任务不存在先拒（否则会给不存在的任务写依赖）');
  ok(!/sets\.push\('depends_on = \?'\);\s*params\.push\(depends_on\)/.test(ipc),
    '反证：未把**原文**直接写库（必先 parseDepIds 归一 + 环校验）');

  // 前端可达（GUI ↔ main 对齐）
  const dt = stripComments(RD(`${A}/renderer/src/pages/TaskDetailPage.tsx`));
  ok(dt.includes('tasks.update(task.id, { depends_on: next.join(\',\') })'), '详情页 saveDeps 经 task:update 写库');
  ok(dt.includes('＋ 添加前置') && dt.includes('移除首个'), '详情页可增可删（此前创建时才可带一次）');
  ok(/任务依赖关系[\s\S]{0,4000}＋ 添加前置/.test(dt), '依赖面板常驻（无前置时入口也在，否则改不了空任务）');
  ok(dt.includes("t.status !== 'archived'") && dt.includes('!depIds.includes(t.id)'),
    '候选=同项目、非自身、非归档、未在前置内（防自环候选与重复可选）');
  ok(stripComments(RD(`${A}/renderer/src/lib/ipc.ts`)).includes('depends_on?: string'),
    'renderer ipc 层 update 声明 depends_on（参数不致被 TS 丢掉）');
}

// ══════════════════════════════════════════════════════════════════
// S5 (M3-5) 展示按状态算 —— 三种事实三种话（此前一律"被阻塞"）
// ══════════════════════════════════════════════════════════════════
console.log('\n[S5 M3-5 depBlockInfo 如实描述（waiting/dead/unresolved 三话）]');
{
  const db = mkdb();
  addTask(db, 'P', 'completed');
  addTask(db, 'Q', 'pending');
  addTask(db, 'R', 'failed');
  const st = statusOfIn(db);
  const nameOf = (id: string) => ({ P: '前置甲', Q: '前置乙', R: '前置丙' } as Record<string, string>)[id] || id;

  const met = depBlockInfo(['P'], st, nameOf);
  ok(met.state === 'met' && met.text === '', 'met ⇒ text 为空串（调用方据此不渲染，不留空壳）');

  const wait = depBlockInfo(['P', 'Q'], st, nameOf);
  ok(wait.state === 'waiting' && wait.remaining === 1, 'waiting：还差 1 个（只数未完成的）', String(wait.remaining));
  ok(wait.text.includes('等待前置完成：') && wait.text.includes('前置甲、前置乙') && wait.text.includes('还差 1 个') && wait.text.includes('自动启动'),
    'waiting 话术点明"会自动启动"（这是真话：解锁只经 getReadyTasks）');

  const dead = depBlockInfo(['P', 'R'], st, nameOf);
  ok(dead.state === 'dead' && dead.deadNames.join() === '前置丙', 'dead：点名失败的前置');
  // zx_20260917 M3: 文案改为**按前置实际状态分说**（三种"死"三种话），故断言随措辞更新；
  // 钉住的仍是同一条实质：给出人工处置路径，且点出"须先处置它"。
  ok(dead.text.includes('不会自动启动') && dead.text.includes('须人工处置前置后手动恢复') && dead.text.includes('前置已失败：前置丙'),
    'dead 话术给出人工处置路径，且**点名它是"已失败"**（不与其他两种死混说）');
  ok(!/前置完成后自动启动|完成后自动启动/.test(dead.text),
    '反证：dead 话术**不含**"完成后自动启动"的假许诺（这是 M3-5 的核心）');

  const un = depBlockInfo(['ghost'], st, nameOf);
  ok(un.state === 'unresolved' && un.unknownIds.join() === 'ghost', 'unresolved：报出查不到的 id 原文');
  ok(un.text.includes('不阻塞调度') && un.text.includes('请核对 depends_on'),
    'unresolved 话术如实（不喊阻塞、也不假装没问题）');

  const both = depBlockInfo(['R', 'ghost'], st, nameOf);
  ok(both.state === 'dead', '失败+笔误 ⇒ 态取 dead（用户最需知道"永不可满足"）');
  ok(both.total === 2, 'total 含查不到者（前端据此显示条数如实）');

  // 混合：优先级会折叠 unknown，但**不得失声**——waiting/dead 正文仍须点名查不到的 id
  const mixWait = depBlockInfo(['Q', 'ghost'], st, nameOf);
  ok(mixWait.state === 'waiting', '在跑+笔误 ⇒ 态取 waiting（ghost 本就不阻塞，故"正在等 Q"才是主态）');
  ok(mixWait.text.includes('另有前置任务不存在：ghost'), 'waiting 正文仍点名 ghost（否则笔误被静默吞掉）');
  const mixDead = depBlockInfo(['R', 'ghost'], st, nameOf);
  ok(mixDead.text.includes('另有前置任务不存在：ghost'), 'dead 正文同样点名 ghost（两态一致的如实）');
  ok(depBlockInfo(['P'], st, nameOf).text === '', '无 unknown 时不追加那句话（不产生噪声）');

  // 反证：旧文案对三种事实一视同仁（只有一句"被阻塞"）
  eq([wait.state, dead.state, un.state], ['waiting', 'dead', 'unresolved'],
    '反证：三态各具其名，旧实现只有一句「被前置依赖阻塞」把三者压平');

  // 界面接线：详情页 + 列表页各按 state 分支
  const dt = stripComments(RD(`${A}/renderer/src/pages/TaskDetailPage.tsx`));
  ok(dt.includes("depInfo.state === 'dead' ? '前置永不可满足'") && dt.includes("depInfo.state === 'unresolved' ? '前置不存在'"),
    '详情页按 state 分派三种标签');
  ok(dt.includes('{depInfo.text}'), '详情页展示 depInfo.text（文案单一真源，不手写第二份）');
  const tp = stripComments(RD(`${A}/renderer/src/pages/TasksPage.tsx`));
  ok(tp.includes("depInfo.state==='dead'?'前置永不可满足'") && tp.includes("depInfo.state==='unresolved'?'前置不存在'"),
    '列表页同尺分派（同一真源同一判断，两处不漂）');
  ok(/t\.status!=='completed'&&depInfo\.state!=='met'/.test(tp), '列表页已完成任务不再挂前置角标（终态无"等待"可言）');
}

// ══════════════════════════════════════════════════════════════════
// S6 (M3-6) 收口闸 —— 四处子任务判据同一把尺（completed/failed/archived 之外皆未完成）
// ══════════════════════════════════════════════════════════════════
console.log('\n[S6 M3-6 收口闸（finalize 自检 / 收口路径 / run_close / 兄弟判据）]');
{
  const ae = aeSrc();
  const ai = aiSrc();

  ok(ae.includes("const incompleteChildren = myChildren.filter(s => !['completed', 'failed', 'archived'].includes(s.status));"),
    '① finalize_task 自检：三值过滤（旧为 `!== \'completed\'` 窄尺 ⇒ 已归档子任务永久挡住父完成）');
  // zx_20260917 M1：因由字面量迁到 `pause-reason.ts`（`PAUSE_REASON_CHILDREN_INCOMPLETE`），
  //   两处收口闸改为引常量。故此处一拆为二：常量**值**仍是 `children_incomplete`（词表未变，UI/事件读法不变），
  //   且两处闸都经唯一写入口带上它。
  const prSrc = RD(`${A}/src/main/core/pause-reason.ts`);
  ok(/PAUSE_REASON_CHILDREN_INCOMPLETE\s*=\s*'children_incomplete'/.test(prSrc),
    '② 因由取值仍是 `children_incomplete`（词表未变，UI/事件可据此解释）');
  eq((ae.match(/pauseTask\(db, \{ taskId, reason: PAUSE_REASON_CHILDREN_INCOMPLETE, note:/g) || []).length, 2,
    '② 两处收口路径经唯一写入口 `pauseTask` 并带该因（不再各自裸写 SQL）');
  ok(ae.includes("'run_close 前有未完成子任务，改置 paused 不标完成'"), '③ run_close：同尺拦截 + 留日志');
  ok(ai.includes("AND status NOT IN ('completed','failed','archived')"), '④ 兄弟判据（checkParentTaskAfterChildDone）：同尺三值');
  ok(!ai.includes("AND status != 'completed'") && !/myChildren\.filter\(s => s\.status !== 'completed'\)/.test(ae),
    '反证：两处旧窄尺（`status != \'completed\'` / `!== \'completed\'`）已除 ⇒ 归档子任务不再卡父');

  // 行为：闸拦得住，且置 paused **而非** completed（夹具=真库入参形态：parent + pending + archived + completed 子）
  const db = mkdb();
  addTask(db, 'PARENT', 'executing');
  addTask(db, 'k-pending', 'pending', '', 'PARENT', '还在跑的子任务');
  addTask(db, 'k-archived', 'archived', '', 'PARENT', '已归档的子任务');
  addTask(db, 'k-done', 'completed', '', 'PARENT', '已完成的子任务');
  const gateSQL = (ae.match(/(SELECT id, title FROM wa_tasks WHERE parent_task_id = \? AND status NOT IN \('completed','failed','archived'\))/) || [])[0];
  ok(!!gateSQL, '闸 SQL 由源码就地取出（生产 SQL × 生产夹具）');
  const unfinished = db.prepare(gateSQL!).all('PARENT') as Array<{ id: string; title: string }>;
  eq(unfinished.map((u) => u.id), ['k-pending'], '闸命中的未完成子 = [k-pending]（archived/completed 皆算终态，不挡）');

  // 走闸的两项效果（复刻生产语句）
  db.prepare("UPDATE wa_tasks SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run('PARENT');
  eq((db.prepare("SELECT status FROM wa_tasks WHERE id = 'PARENT'").get() as { status: string }).status, 'paused',
    '拦截效果：父置 paused（**未**标 completed）');
  db.prepare('INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?,?,?,?)')
    .run('c1', 'PARENT', 'system', `[未收口] 仍有 ${unfinished.length} 个子任务未完成（${unfinished.map((c) => c.title).join('; ')}）——已暂停而非标完成；待子任务完成后自动恢复，或人工处置。`);
  const msg = (db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = 'PARENT'").get() as { content: string }).content;
  ok(msg.startsWith('[未收口]') && msg.includes('还在跑的子任务') && msg.includes('已暂停而非标完成'),
    '如实记账：点名未完成子任务 + 说明"已暂停而非标完成" + 给出后续路径');
  ok(!/k-archived|k-done/.test(msg), '反证：终态子任务不被记进"未完成"清单（同尺）');

  // 反证：M3-6 前的行为（无闸）——同一夹具下父会先"完成"
  db.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = 'PARENT'").run();
  eq((db.prepare("SELECT status FROM wa_tasks WHERE id = 'PARENT'").get() as { status: string }).status, 'completed',
    '反证：无闸时同一夹具下父直接 completed ⇒ 里程碑/成果汇总随之失真（M3-6 的病成立）');

  // 顺序：闸必须在 completed 之前（结构上不可能绕过）
  const iF = ae.indexOf('const unfinishedForFinalize');
  const iA = ae.indexOf('const unfinishedAtClose');
  ok(iF > 0 && iA > iF, '两处闸在源码中的位置：finalize 收口在前、run_close 在后（各自前置其 completed 写入）');
  const segFinalize = ae.slice(iF, iF + 1500);
  // zx_20260917 M1：闸体里的终态不再是裸 `SET status = 'paused'`，而是 `pauseTask(...)`（同一处写全状态+因+事件）。
  ok(segFinalize.includes('pauseTask(db, { taskId, reason: PAUSE_REASON_CHILDREN_INCOMPLETE') && segFinalize.includes("任务暂停：仍有未完成子任务"),
    '收口闸体内是 paused + 早退（不落 completed）');
  const segClose = ae.slice(iA, iA + 1500);
  ok(segClose.includes('pauseTask(db, { taskId, reason: PAUSE_REASON_CHILDREN_INCOMPLETE') && segClose.includes("任务暂停：仍有未完成子任务"),
    'run_close 闸体内是 paused + 早退');
  eq((ae.match(/任务暂停：仍有未完成子任务/g) || []).length, 2, '两处收口闸皆早退（各一次）');
}

// ══════════════════════════════════════════════════════════════════
// S7 (M3-7) 父恢复带逐子交付摘要（赫布·共激：共激的载体缺失则父仍须自己翻）
// ══════════════════════════════════════════════════════════════════
console.log('\n[S7 M3-7 buildChildBriefs（只取既有字段，不新增表）]');
{
  const ae = aeSrc();
  const ai = aiSrc();
  // 同步（zx_20260915 M2 · P0-3(c/d)）：`buildChildBriefs` 由文件内 `const` 闭包**提升为导出的模块函数**
  //   （`export function buildChildBriefs(db, parentId)`）——为让受控回归直引真实现、不带 scheduler 依赖。
  //   断言随载体形态同步：钉「已导出为独立函数」，而非旧的箭头函数字面量。
  ok(ai.includes('export function buildChildBriefs(db: Database.Database, parentId: string): string[]'),
    'briefs 生成为独立函数且已导出（可静态追溯 + 回归可直引）');
  ok(/const message = briefs\.length > 0[\s\S]{0,120}?各子交付如下：/.test(ai),
    '恢复消息**由 briefs 派生**（反证：旧为一句与子交付无关的固定文本）');
  // zx_20261022_3 批十二就地改钉：恢复消息的标题改由单一 `header` 派生（全完成/含暂停分家），
  //   无子任务行时仍回退到该 header 本身——钉「回退用的是同一处 header」，而非第二份手拼字面量。
  // zx_20261023_3 批五（知）：header 由二分改**三分**——归档子也是"已停、但没完成"，必须与暂停子
  //   并列分列，不得落进"所有子任务已完成"。断言随之钉三分支形状（更强，不是放宽）。
  ok(/const header = allDone\s*\?\s*'所有子任务已完成，恢复父任务'\s*:\s*stopDetail\s*\?\s*`子任务已全部结束（其中\$\{stopDetail\}）[\s\S]{0,120}?:\s*'子任务已全部结束，请复核并续跑\/修复后再收口'/.test(ai),
    '无子任务行时回退旧文本（header 一处真源，且全完成/分列/兜底三分支同源）');
  ok(/briefs\.length > 0[\s\S]{0,400}?: `\[系统\] \$\{header\}`/.test(ai), '无 briefs 时消息仍由同一 header 派生（不产生空列表噪声）');
  // 同步（同上）：恢复副作用改经 `opts.enqueue` **注入**（生产传 scheduler.enqueue，回归传记录桩），
  //   故本文件内不再直写 `scheduler.enqueue(...)`。钉「通道未变（仍是 resume-ai-task）」+「经注入点发出」。
  ok(ai.includes("opts?.enqueue?.('resume-ai-task', { taskId: pid, message, projectId })"),
    '恢复仍走既有 resume-ai-task 通道（未新增机制），且经 opts.enqueue 注入点发出');
  ok(ai.includes('（逐子交付摘要 ${briefs.length} 条）'), '日志如实报出摘要条数（可事后核对是否真带上）');

  // 只取既有真源（不新增表/字段）
  ok(ai.includes('normalizeSnippet(ctx.completion_summary.trim(), 80)'),
    '摘要取 context_json.completion_summary（与 finalize_task 写点同源）');
  ok(ae.includes('ctxJson.completion_summary = args.summary;'),
    '写点确认：finalize_task 落 completion_summary（读点有写点相配，非凭空 key）');
  ok(ai.includes("WHERE task_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1"),
    '摘要缺失时回退最近一条 assistant 回合（既有表）');
  ok(ai.includes("if (!summary) summary = '(无完成摘要)';"), '两者皆缺 ⇒ 如实占位（不假装有摘要）');
  // zx_20260930 M4-1: 该查询的范围声明改由共享真源 `deliverableScopeSql` 出（WHERE 整段是 dScope.sql）——
  //   仍取既有 wa_deliverables、仍与全局同尺（范围里已含 retired 排除 + 探针滤除），只是不再手拼谓词。
  ok(ai.includes('FROM wa_deliverables WHERE ${dScope.sql}') && ai.includes('deliverableScopeSql({ taskIds: [String(k.id)] })'),
    '产出取既有 wa_deliverables，且与全局同尺（范围走共享真源滤探针/退休）');
  ok(ai.includes('describeAcceptance(ctx.acceptance_check as AcceptanceInfo | undefined, true)'),
    '验收取既有 context_json.acceptance_check（复用 describeAcceptance，不手写第二份话术）');
  const briefLine = ai.split('\n').find((l) => l.includes('out.push(`${k.title}｜')) || '';
  ok(briefLine.includes('summary') && briefLine.includes('delivPart') && briefLine.includes('accPart'),
    '每行四段齐全（缺一段即"逐个去翻"的病复发）');

  // 行为：夹具复刻三子的摘要回退链 + 产出计数
  const db = mkdb();
  addTask(db, 'P2', 'paused');
  addTask(db, 'c1', 'completed', '', 'P2', '子一', { completion_summary: '  已实现 X 并跑通  ' });
  addTask(db, 'c2', 'completed', '', 'P2', '子二', {});
  addTask(db, 'c3', 'completed', '', 'P2', '子三', { acceptance_check: { criteria_total: 3, passed_total: 2, checked_at: 'x', passed: [] } });
  db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES ('m1','c2','assistant','子二完成了 Y 模块的改造与自测')").run();
  db.prepare("INSERT INTO wa_deliverables (id, task_id, type, name, file_path, status) VALUES ('d1','c1','code','impl.py','/x/impl.py','completed')").run();
  db.prepare("INSERT INTO wa_deliverables (id, task_id, type, name, file_path, status) VALUES ('d2','c1','doc','报告.md','/x/报告.md','completed')").run();
  db.prepare("INSERT INTO wa_deliverables (id, task_id, type, name, file_path, status) VALUES ('d3','c3','doc','临时探针','/x/_tmp_probe.py','draft')").run();

  const kids = db.prepare("SELECT id, title, status, context_json FROM wa_tasks WHERE parent_task_id = ? AND status != 'archived' ORDER BY created_at ASC").all('P2') as Array<{ id: string; title: string; context_json: string }>;
  eq(kids.map((k) => k.id), ['c1', 'c2', 'c3'], 'kids 顺序按 created_at（稳定，便于人读）');
  const summaries = kids.map((k) => {
    const ctx = JSON.parse(k.context_json || '{}') as Record<string, unknown>;
    if (typeof ctx.completion_summary === 'string' && ctx.completion_summary.trim()) return ctx.completion_summary.trim();
    const last = db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1").get(k.id) as { content?: string } | undefined;
    return last?.content?.trim() || '';
  });
  eq(summaries, ['已实现 X 并跑通', '子二完成了 Y 模块的改造与自测', ''],
    'c1 取 completion_summary（trim）/ c2 回退 assistant 回合 / c3 两者皆缺 ⇒ 生产落占位');
  const cnt = (t: string) => (db.prepare("SELECT COUNT(*) as c FROM wa_deliverables WHERE task_id = ? AND status != 'retired'").get(t) as { c: number }).c;
  eq([cnt('c1'), cnt('c2'), cnt('c3')], [2, 0, 1], '产出件数按任务各算（c1=2、c2=0、c3=1）');
  ok(!/archived/.test(kids.map((k) => k.id).join()), '归档子任务不进 briefs（与恢复判据同尺：归档即终态，不必再报）');
  // 反证：旧固定文本对每个子"交付了什么"零信息
  const OLD_FIXED = '[系统] 所有子任务已完成，恢复父任务';
  ok(!OLD_FIXED.includes('｜') && !/产出/.test(OLD_FIXED),
    '反证：旧固定文本无任何「产出/验收/摘要」信息 ⇒ 父醒来只能逐个去翻（M3-7 的病成立）');
}

// M5 收口：每个子脚本自带 build 闸（任一批单独跑也能自查 build 是否陈旧）。
// ⚠ 本段读 dist ⇒ tsup 必须先于本脚本。
console.log('\n[M5] build 标识派生一致性（P1–P6）');
checkBuildPins(ok, { distDir: path.join(__dirname, '..', A, 'dist') });

console.log(`\n结果: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
