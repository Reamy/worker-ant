/**
 * zx_20260910_3 批4 受控复跑（M2a + M2b：里程碑判据唯一入口；真实现 + node:sqlite 真 SQL；绝不触碰开发库）。
 *
 * 本轮问题 G2「里程碑判据散在五处」：同一条"任务标题 `M{n}` ↔ 里程碑"的启发式，四处各写一套：
 *   agent-executor 动工路径（内联 scheme_ref + 标题派生）／task-accounting 正向两处（`/^M(\d+)/`）／
 *   admin.ipc 反向查询（`title GLOB 'M{n}[ (：:;]*'`）。第四处与前三处**不是同一判据**：
 *   GLOB 两端锚定 + `[ (：:;]` 是**单字符类** ⇒ 实为"标题 = `M{n}` + 一个边界符 + 任意尾串"
 *   ⇒ 漏配纯 `M{n}` 与 `M{n}x` 两类标题（同一个名、两套用法）。
 *
 * S1 M2a 动工(doing)路径收敛：内联派生整段 → `resolveTaskMilestoneLink`；断言与旧内联实现**逐例等价**
 *    （旧内联逻辑在测试里复刻为对照 oracle），且无显式关联时仍走含歧义护栏的回落分支。
 * S2 M2b 标题判据唯一化：`milestoneFromTitle` 真值表 + `resolveMilestoneImplementer` 真 SQL 反向查询
 *    + **GLOB 对照实验**（同一内存库上旧谓词漏配、新判据命中 ⇒ 证明收敛修掉了真实差异）。
 * S3 无第六处静态：遍历 `src/main` 下全部 .ts，`/^M(\d+)/` 只许一处（判据定义本身）、`title GLOB` 零处。
 *
 * ⚠ S4/S5（M2c 计数器三义归一 / M2d 恢复必自愈）于批4b 在同文件续写完成——
 *    S4：上限唯一定义真值表 + 旧/新自增序列对照（旧到 3＝死路径，新止于 2）+ 真 resumeWithQuota 整链
 *        （上顶→暂停→恢复→再偏离）+ 8 个恢复入口（GUI 2 + IM 6）静态核验；
 *    S5：到顶暂停写 awaiting_input 真源（真 persistAwaitingInput + 真判重函数）+ renderer 零新增 UI。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  milestoneFromTitle, resolveMilestoneImplementer, resolveTaskMilestoneLink, resolveTaskMilestoneAutoLink,
  GOAL_DEVIATION_MAX_RESTARTS, goalDeviationCapReached,
} from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import { resumeWithQuota, settlePause, isDuplicatePauseResponse } from '../apps/worker-ant-desktop/src/main/core/pause-settlement.js';
// 真源写入函数本身（M2d-b 断言用）——agent-executor 不依赖 electron，可在受控回归里直接跑真实现
import { persistAwaitingInput } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { engineExecSideFiles } from './lib/rr-engine-src.js';
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => any };

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
/** 去注释后再断言——注释里常引用旧谓词（如"此前用 `title GLOB …`"），那是叙述不是代码 */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
// zx_20260929 M9: `executeTask` 的**步回调**（`onStepFinish` 体）搬至 `core/exec-step.ts` ⇒ 扫描面再并一层。
//   顺带把口径收回**一处真源**（`lib/rr-engine-src.ts`）：本脚本此前**手抄过一份**目录约定
//   （`exe ∪ exec-claim.ts`），而"手抄第二份就会在下次搬迁时又漏一处"正是 M8/M9 两轮假红的病根。
//   取「执行体侧」（= 执行体 ∪ `core/exec-*.ts` ∪ `memory-context.ts`，**不含**工具段）：
//   本条判据的本意是"这几个判据在**引擎执行这一侧**各只一处"；工具段（`finalize_task` 等）是**另一侧**、
//   另有同形判据（如 `rr_zx_20260909_*` 对 run 收口门/finalize 门的"两侧各一处"），
//   并进来会把"两侧各一处"稀释成"合计 ≥1"，那是**放宽**（违"扫描面变宽只许更严"）。
const exe = engineExecSideFiles().map((p) => rd(p)).join('\n');
const exeCode = stripComments(exe);
const execSurface = exe;   // 兼容下方切块用法：原为 `exe ∪ exec-claim.ts`，而 exec-claim 本就在 `exec-*` 面内
const execSurfaceCode = stripComments(execSurface);
const acc = rd('apps/worker-ant-desktop/src/main/core/task-accounting.ts');
const accCode = stripComments(acc);
// zx_20260916_3 M3: 「达成判据」整条迁入 task-outcome.goalAchievedOf（一处真源，四个写账点共用）——
//   本脚本原断言的 `!goalDeviationCapReached(deviationRestarts) && qualityScore.score >= 60` 字面量
//   随之退场。判据的**实质**（用共享谓词、不用旧魔数）不变，故改按新落点断言，而非把数字改到绿。
const toCode = stripComments(rd('apps/worker-ant-desktop/src/main/core/task-outcome.ts'));
const adm = rd('apps/worker-ant-desktop/src/main/ipc/admin.ipc.ts');
const admCode = stripComments(adm);

const TASK = 't-impl'; const PLAN = 't-plan'; const PROJ = 'p1';

/** 内存库：只建本判据用到的列（真实 SQL 语义，含 GLOB 对照实验所需） */
function mkdb(): any {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, title TEXT, project_id TEXT, parent_task_id TEXT, status TEXT, updated_at TEXT, context_json TEXT);
    CREATE TABLE wa_plan_milestones (plan_task_id TEXT, milestone TEXT, status TEXT, implemented_by_task_id TEXT, project_id TEXT, updated_at TEXT);
  `);
  addTask(db, PLAN, '20260910 方案', PROJ, 'completed', '2026-09-10T00:00:00Z');
  return db;
}

function addTask(db: any, id: string, title: string, projectId: string, status: string, updatedAt: string, parent: string | null = null): void {
  db.prepare('INSERT INTO wa_tasks (id, title, project_id, parent_task_id, status, updated_at, context_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, title, projectId, parent, status, updatedAt, '{}');
}

function addMilestone(db: any, planTaskId: string, milestone: string, status: string, projectId: string): void {
  db.prepare('INSERT INTO wa_plan_milestones (plan_task_id, milestone, status, implemented_by_task_id, project_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(planTaskId, milestone, status, null, projectId, '2026-09-10T00:00:00Z');
}

// ─────────────────────────────────────────────────────────────
console.log('\nS1 M2a 动工(doing)路径判据收敛（与旧内联实现逐例等价）');

// 旧内联实现（已被替换，复刻为对照 oracle）
function oldDoingLink(db: any, task: { id: string; title: string; project_id: string; parent_task_id: string | null }, tctx: Record<string, unknown>) {
  const sr = tctx.scheme_ref as { plan_task_id?: string; milestone?: string } | undefined;
  let link: { plan_task_id: string; milestone: string } | null = null;
  if (sr?.plan_task_id) {
    const m = /^M(\d+)/.exec(String(task.title || ''));
    const milestone = sr?.milestone || (m ? `M${m[1]}` : null);
    if (milestone) link = { plan_task_id: sr.plan_task_id, milestone };
  }
  if (!link) link = resolveTaskMilestoneAutoLink(db, task);
  return link;
}

const CASES: Array<{ name: string; title: string; sr: Record<string, unknown> | undefined; ms?: Array<[string, string]> }> = [
  { name: '显式 milestone 优先', title: 'M9 无关标题', sr: { plan_task_id: PLAN, milestone: 'M3' } },
  { name: '显式 plan + 标题派生', title: 'M3 O1 落库', sr: { plan_task_id: PLAN } },
  { name: '显式 plan + 无 M 标题 → 回落', title: '无前缀标题', sr: { plan_task_id: PLAN } },
  { name: '无 scheme_ref → 回落(同项目唯一板)', title: 'M3 O1 落库', sr: undefined, ms: [['M3', 'pending']] },
];
for (const c of CASES) {
  const db = mkdb();
  addTask(db, TASK, c.title, PROJ, 'executing', '2026-09-10T01:00:00Z');
  if (c.ms) for (const [m, st] of c.ms) addMilestone(db, PLAN, m, st, PROJ);
  const tctx = c.sr ? { scheme_ref: c.sr } : {};
  const oldR = oldDoingLink(db, { id: TASK, title: c.title, project_id: PROJ, parent_task_id: null }, tctx);
  const newR = resolveTaskMilestoneLink(db, TASK, tctx);
  ok(JSON.stringify(oldR) === JSON.stringify(newR), `等价：旧内联 vs 新单点（${c.name}）`, JSON.stringify(newR));
  db.close();
}

// 歧义护栏只在回落分支生效：两块板持有同名 M4，且本任务无显式关联 ⇒ null（旧内联段同样回落至该函数）
{
  const db = mkdb();
  addTask(db, TASK, 'M4 实施', PROJ, 'executing', '2026-09-10T01:00:00Z');
  addTask(db, 't-plan2', '另一份方案', PROJ, 'completed', '2026-09-10T00:30:00Z');
  addMilestone(db, PLAN, 'M4', 'pending', PROJ);
  addMilestone(db, 't-plan2', 'M4', 'pending', PROJ);
  ok(resolveTaskMilestoneLink(db, TASK, {}) === null, '歧义护栏：同项目两块板持同名 M4 且无显式关联 → null（不误标）');
  ok(resolveTaskMilestoneLink(db, TASK, { scheme_ref: { plan_task_id: PLAN } })?.milestone === 'M4', '有显式关联则不受歧义影响');
  db.close();
}

// 静态：内联派生已移除、改走单点
const doingStart = execSurface.indexOf('里程碑 doing 流转');
const doingSeg = execSurface.slice(doingStart, execSurface.indexOf('const title = (task.title as string)', doingStart));
ok(doingStart >= 0, '★动工路径切块非空（锚点在扫描面内命中，防切到空块当绿）');
ok(doingSeg.includes('resolveTaskMilestoneLink(db, taskId, tctx)'), '★动工路径改走 resolveTaskMilestoneLink（唯一入口）');
ok(!doingSeg.includes('/^M(\\d+)/'), '★动工路径不再就地内联标题判据（G2 的第二处已消）');
ok(!execSurfaceCode.includes('/^M(\\d+)/'), '执行体侧（执行体 ∪ core/exec-*.ts ∪ memory-context）内再无 /^M(\\d+)/ 副本（去注释后断言）');
ok(!/import \{[^}]*resolveTaskMilestoneAutoLink/.test(execSurfaceCode), '执行体面不再直接引回落函数（经单点间接走）');

// ─────────────────────────────────────────────────────────────
console.log('\nS2 M2b 标题判据唯一化（真值表 + 反向真 SQL + GLOB 对照实验）');

const TT: Array<[string | null, string | null, string]> = [
  ['M12 实施：xxx', 'M12', '空格边界'],
  ['M1(F5)收尾：主推荐拦截', 'M1', '括号边界'],
  ['M1x补丁', 'M1', '无边界符（GLOB 旧法漏配）'],
  ['M1', 'M1', '纯 `M{n}`（GLOB 旧法漏配）'],
  ['M3 O1 落库', 'M3', '常规'],
  ['方案M1 实施', null, '前缀之外不认'],
  ['m1 小写', null, '小写不认'],
  ['M 无数字', null, '无数字不认'],
  ['', null, '空串'],
  [null, null, 'null 入参（不抛）'],
];
for (const [title, expect, why] of TT) {
  const got = milestoneFromTitle(title);
  ok(got === expect, `真值表：${JSON.stringify(title)} → ${JSON.stringify(expect)}（${why}）`, got === expect ? undefined : `实得 ${JSON.stringify(got)}`);
}

// 反向真 SQL：同一份判据过滤（不是第二条 SQL 谓词）
{
  const db = mkdb();
  const rows: Array<[string, string, string, string]> = [
    ['t-a', 'M1 实施A', PROJ, '2026-09-10T03:00:00Z'],
    ['t-b', 'M1x补丁', PROJ, '2026-09-10T05:00:00Z'], // 无边界符：GLOB 旧法漏配
    ['t-c', 'M2 实施C', PROJ, '2026-09-10T04:00:00Z'],
    ['t-d', 'M1 未完成', PROJ, '2026-09-10T06:00:00Z'],
    ['t-e', 'M1 别项目', 'p2', '2026-09-10T07:00:00Z'],
  ];
  for (const [id, title, proj, up] of rows) {
    const st = id === 't-d' ? 'executing' : 'completed';
    addTask(db, id, title, proj, st, up);
  }
  const impl1 = resolveMilestoneImplementer(db, PROJ, 'M1');
  ok(impl1 === 't-b', '★反向：M1 取 updated_at 最新者（t-b，`M1x补丁`——旧 GLOB 漏配的标题）', String(impl1));
  ok(resolveMilestoneImplementer(db, PROJ, 'M2') === 't-c', '反向：M2 → t-c');
  ok(resolveMilestoneImplementer(db, PROJ, 'M9') === null, '反向：无匹配 → null');
  ok(resolveMilestoneImplementer(db, PROJ, 'M1') !== 't-d', '反向：未完成(executing)任务不入选（只认 completed）');
  ok(rows.every(([id]) => id !== 't-e') || impl1 !== 't-e', '反向：不越项目取实施者');

  // GLOB 对照实验：旧谓词在同一库上的命中集
  const oldHit = db.prepare("SELECT id FROM wa_tasks WHERE project_id = ? AND status = 'completed' AND title GLOB ? LIMIT 1").get(PROJ, 'M1[ (：:;]*') as { id: string } | undefined;
  const globCount = db.prepare("SELECT COUNT(*) AS c FROM wa_tasks WHERE project_id = ? AND status = 'completed' AND title GLOB ?").get(PROJ, 'M1[ (：:;]*') as { c: number };
  ok((globCount.c as number) === 1, `对照：旧 GLOB 谓词在 completed 中仅命中 1 条（漏掉 \`M1x补丁\`）`, `命中 ${globCount.c} 条`);
  ok(oldHit?.id === 't-a', '对照：旧 GLOB 命中 t-a（`M1 实施A`）——与"取最新者"的新判据给出**不同**结果', String(oldHit?.id));
  const newAll = (db.prepare("SELECT id, title FROM wa_tasks WHERE project_id = ? AND status = 'completed'").all(PROJ) as Array<{ id: string; title: string }>).filter((r) => milestoneFromTitle(r.title) === 'M1').map((r) => r.id);
  ok(newAll.length === 2 && globCount.c === 1, `★差异实证：同一谓词的候选集 旧=1 / 新=2（{${newAll.join(',')}}）`);
  db.close();
}

// 静态：反向入口接线、旧 GLOB 谓词绝迹
// zx_20260911_3 M3-1：此断言原为**逐字节**比对该 import 语句，M3 给同一语句追加了 backfillDescendantSchemeRef
// （关联须向下回填）即误报「未引反向唯一入口」。判据本意是"两个反向入口同来自 task-accounting"，
// 故改为同名同源的语义匹配——**不放松**（两个名字 + 同一模块缺一不可）。
ok(/import \{[^}]*\bresolveTaskMilestoneLink\b[^}]*\bresolveMilestoneImplementer\b[^}]*\} from '\.\.\/core\/task-accounting\.js'/.test(adm), 'admin.ipc 引反向唯一入口');
ok(admCode.includes('resolveMilestoneImplementer(db, t.project_id, ms)'), '★plan:backfill 改走反向唯一入口');
ok(!admCode.includes('title GLOB'), '★旧 `title GLOB` 谓词已绝迹（去注释后仍无 ⇒ 不再有第二条 SQL 标题判据）');
ok(!admCode.includes("'[ (：:;]*'"), '旧 GLOB 模式串已移除');
ok(acc.includes('export function milestoneFromTitle'), '标题判据在 task-accounting 导出（可回归）');
ok((acc.match(/export function milestoneFromTitle/g) || []).length === 1, '标题判据只有一份定义');
ok(acc.includes('export function resolveMilestoneImplementer'), '反向唯一入口已导出');
ok(accCode.includes('if (milestoneFromTitle(r.title) === milestone) return r.id;'), '★反向用**同一个** milestoneFromTitle 过滤（不在 SQL 里另写谓词）');
ok(accCode.includes('ORDER BY updated_at DESC'), '反向取数确定化（消掉原 LIMIT 1 的不确定性）');
// 正向两处亦收敛到同一函数
ok((accCode.match(/milestoneFromTitle\(/g) || []).length >= 3, `正向两处 + 反向一处共用同一判据（引用 ${(accCode.match(/milestoneFromTitle\(/g) || []).length} 次）`);
ok((accCode.match(/\/\^M\(\\d\+\)\/\.exec/g) || []).length === 1, '★仓内 /^M(\\d+)/ 仅剩判据定义内一处');
ok(acc.includes('「显式关联优先」这条判据的唯一入口') && acc.includes('① finalize 的回写'), '注释改为可核验的事实描述（列四个调用点 + 交叉引用反向入口）');

// ─────────────────────────────────────────────────────────────
console.log('\nS3 无第六处（遍历 src/main 全量 .ts）');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}
const MAIN = path.join(ROOT, 'apps/worker-ant-desktop/src/main');
const files = walk(MAIN);
ok(files.length > 50, `遍历到 ${files.length} 个 main 侧 .ts 文件`);
const titleRegexSites: string[] = [];
const globSites: string[] = [];
for (const f of files) {
  const c = stripComments(fs.readFileSync(f, 'utf-8'));
  if (c.includes('/^M(\\d+)/.exec')) titleRegexSites.push(path.relative(MAIN, f));
  if (c.includes('title GLOB')) globSites.push(path.relative(MAIN, f));
}
ok(titleRegexSites.length === 1 && titleRegexSites[0] === 'core/task-accounting.ts', `★全 main 仅 1 处 /^M(\\d+)/.exec（判据定义本身）`, titleRegexSites.join(',') || '(无)');
ok(globSites.length === 0, '★全 main 无 title GLOB（旧反向谓词零残留）', globSites.join(',') || '(无)');

// ─────────────────────────────────────────────────────────────
console.log('\nS4 M2c 收敛计数器三义归一（真判据 + 真 SQL 整链复跑）');

// 阈值真值表
ok(GOAL_DEVIATION_MAX_RESTARTS === 2, `上限唯一定义 = 2`, String(GOAL_DEVIATION_MAX_RESTARTS));
for (const [v, expect, why] of [
  [0, false, '初始'], [1, false, '已重启 1 次'], [2, true, '到上限'], [3, true, '超上限(旧数据)'],
  [undefined, false, '缺字段'], [null, false, 'null'],
] as Array<[unknown, boolean, string]>) {
  ok(goalDeviationCapReached(v) === expect, `真值表：goalDeviationCapReached(${String(v)}) → ${expect}（${why}）`);
}
ok(goalDeviationCapReached('2') === true, '字符串 "2"（JSON 往返成串）如实判为到上限');
// 脏值（NaN）不拦自动重启——与旧法 `NaN < 3 === false` 同向；新法差别仅在该次仍会 abort（取得一次真重启机会）
ok(goalDeviationCapReached('abc') === false && goalDeviationCapReached({}) === false, '脏值按"未达上限"（异常计数不锁死额度）');

/**
 * 旧行为 oracle（复刻被替换的三处魔数），用于对照"死路径"：
 * 守卫 `restarts < 3` 允许 r 到 3；闸 `>= 2`；达成判据 `<= 2`。
 */
function oldStep(r: number): { next: number; restart: boolean } {
  if (r < 3) return { next: r + 1, restart: false }; // 自增后 abort，但重启与否由闸决定
  return { next: r, restart: false };
}
function oldGate(r: number): 'restart' | 'pause' { return r >= 2 ? 'pause' : 'restart'; }

/** 新行为：自增受上限约束 + abort 恒发（闸用同一判据决定放行/暂停） */
function newStep(r: number): number { return goalDeviationCapReached(r) ? r : r + 1; }
function newGate(r: number): 'restart' | 'pause' { return goalDeviationCapReached(r) ? 'pause' : 'restart'; }

// 旧法：r 一路涨到 3（其中 r=3 的那次自增注定只换来暂停 = 死路径）
{
  let r = 0; const seq: number[] = [];
  for (let i = 0; i < 3; i++) { r = oldStep(r).next; seq.push(r); }
  ok(seq.join(',') === '1,2,3' && oldGate(1) === 'restart' && oldGate(2) === 'pause' && oldGate(3) === 'pause',
    '旧法复现：自增 1,2,3（第 3 次注定暂停）——自动重启 2 次', seq.join(','));
}
// 新法：r 只到 2（到上限即不再自增）
{
  let r = 0; const seq: number[] = [];
  for (let i = 0; i < 4; i++) { r = newStep(r); seq.push(r); }
  ok(seq.join(',') === '1,2,2,2', '★新法：自增止于上限（1,2,2,2）——死路径已消，计数最大只到 2', seq.join(','));
  let r2 = 0;
  ok(newGate(newStep(r2)) === 'restart', '★第 1 次偏离 → 自动重启（未到上限）');
  r2 = newStep(r2);
  ok(newGate(newStep(r2)) === 'pause', '★第 2 次偏离 → 交人工（到上限即暂停）');
}
// 上顶不变量：即使额度未返还（r 已在上限），偏离也必须暂停而非静默继续
ok(newGate(2) === 'pause' && newGate(3) === 'pause', '★不变量：r≥上限时偏离**必**暂停（abort 恒发，不依赖恢复入口是否返还）');

// 整链（真 SQL 真函数）：偏离上顶 → 暂停 → 恢复 → 再偏离
{
  const db = mkdb();
  addTask(db, TASK, 'M1 实施', PROJ, 'executing', '2026-09-10T08:00:00Z');
  db.prepare("UPDATE wa_tasks SET context_json = ? WHERE id = ?").run(JSON.stringify({ goal_deviation_restarts: 2, resume_count: 4 }), TASK);
  // 到顶暂停（复刻 ai-task 的两条写：status + persistAwaitingInput 由 S5 单独验证）
  db.prepare("UPDATE wa_tasks SET status = 'paused' WHERE id = ?").run(TASK);
  const before = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(TASK) as { context_json: string };
  ok(JSON.parse(before.context_json).goal_deviation_restarts === 2, '前置：上顶后计数停在 2');

  // 人工恢复（真 resumeWithQuota：自读 ctx → 返还额度 → 置 pending 一次写）
  resumeWithQuota(db, TASK);
  const after = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(TASK) as { context_json: string }).context_json);
  const st = (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(TASK) as { status: string }).status;
  ok(after.goal_deviation_restarts === 0, '★恢复后计数为 0（叫 resume 就必须真的 resume）');
  // 标签就地订正（zx_20260916_1 M5）：`resume_count` 自本轮起只记**用户介入**（系统路记 `auto_resume_count`，
  //   见 core/resume-ledger.ts），不再笼统等于"介入次数"；本条断言的本体（返还额度**不动**恢复账）不受影响。
  ok(after.resume_count === 4, '★resume_count 不受影响（两者分开记账：恢复账 vs 自动重启额度）');
  ok(st === 'pending', '恢复后状态置 pending');
  // 恢复后第一次偏离：应走自动重启（E20 死锁不复现）
  const r1 = newStep(after.goal_deviation_restarts as number);
  ok(newGate(r1) === 'restart', '★恢复后第一次偏离 → 自动重启（E20 死锁不复现）', `r=${r1}`);
  db.close();
}

// 静态：三处魔数归一 + 8 个恢复入口统一（exeCode 已在 S1 定义，此处复用）
const ait = rd('apps/worker-ant-desktop/src/main/core/jobs/ai-task.ts');
const aitCode = stripComments(ait);
const pst = rd('apps/worker-ant-desktop/src/main/core/pause-settlement.ts');
const imr = rd('apps/worker-ant-desktop/src/main/services/im-router.ts');
const pip = rd('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
ok(accCode.includes('export const GOAL_DEVIATION_MAX_RESTARTS = 2') && (accCode.match(/GOAL_DEVIATION_MAX_RESTARTS\s*=/g) || []).length === 1, '★上限只有一个定义');
ok(exeCode.includes('if (!goalDeviationCapReached(restarts))') && !exeCode.includes('restarts < 3'), '★守卫改用共享判据（旧 `< 3` 已消）');
ok(!exeCode.includes('deviationRestarts <= 2') && exeCode.includes('goalAchievedOf('),
  '★达成判据改用共享判据（旧 `<= 2` 已消；zx_20260916_3 M3 起判据整条落在 `task-outcome.goalAchievedOf`，执行器只**调**它）');
ok(/goalAchievedOf\([^)]*\)[\s\S]{0,400}?goalDeviationCapReached\(/.test(toCode),
  '★达成判据**仍以** `goalDeviationCapReached` 判上限（迁移后与上限常量同源，未在迁址途中丢判据）');
ok(aitCode.includes('return goalDeviationCapReached(c.goal_deviation_restarts)') && !aitCode.includes('CONVERGE_MAX_GOAL_RESTARTS'), '★暂停闸改用共享判据（旧 `>= 2` 常量已消）');
ok(!/Number\([^)]*goal_deviation_restarts[^)]*\)\s*[<>]=?\s*\d/.test(exeCode), '全 main 不再有"读计数后直接比数字"的写法');
// abort 恒发（不在守卫内）——判据分家的反面：闸必须能对任意 r≥上限生效
const gStart = exeCode.indexOf('if (!goalDeviationCapReached(restarts))');
const gEnd = exeCode.indexOf('catch {}', gStart);
const guardSeg = gStart >= 0 && gEnd > gStart ? exeCode.slice(gStart, gEnd) : '';
ok(gStart >= 0 && guardSeg.includes("controller.abort(new Error('goal_deviation_restart'))"),
  '★abort 在守卫之外恒发（上顶也可暂停）', `守卫段长 ${guardSeg.length}`);
// GUI 两处：搭 settlePause 的同一次写
ok((pip.match(/grantGoalDeviationQuota\(ctx\)/g) || []).length === 2, '★GUI 两处恢复入口均返还额度（搭 settlePause 同一次 ctxJson 写）');
// IM 六处：统一走 resumeWithQuota，且仓内再无裸置 pending 的恢复写法
ok((imr.match(/resumeWithQuota\(/g) || []).length === 6, '★IM 六处恢复入口均返还额度（统一写法）', `命中 ${(imr.match(/resumeWithQuota\(/g) || []).length} 处`);
ok(!stripComments(imr).includes("SET status = 'pending'"), 'IM 侧不再有裸 `UPDATE ... status=pending`（恢复必返还）');
ok(pst.includes('export function grantGoalDeviationQuota') && pst.includes('export function resumeWithQuota'), '返还规则落 pause-settlement（脱 electron、可回归）');
// 去注释后断言：上文注释里正解释"为什么不用 json_set"，那是叙述不是代码
ok(!stripComments(pst).includes('json_set'), '返还额度不以 SQL 再写一份规则（判据分家＝G2 病根）');
// 系统侧续跑**不**返还：4 处 resume-ai-task 入队处不得出现返还
{
  const sysSegs = aitCode.split('scheduler.enqueue(\'resume-ai-task\'').slice(1);
  ok(sysSegs.length >= 4 && sysSegs.every(s => !s.slice(0, 400).includes('grantGoalDeviationQuota') && !s.slice(0, 400).includes('resumeWithQuota')),
    '★系统侧续跑（SDK 降级/偏离重启/子任务完成）不返还额度', `${sysSegs.length} 处`);
}

// ─────────────────────────────────────────────────────────────
console.log('\nS5 M2d-b 暂停原因落 awaiting_input（GUI 有据可显）');

{
  const db = mkdb();
  addTask(db, TASK, 'M1 实施', PROJ, 'executing', '2026-09-10T09:00:00Z');
  persistAwaitingInput(db, TASK, { question: '因目标多次偏离已暂停，可回复聚焦指令后恢复', options: [], decision_type: 'goal_deviation_pause' });
  const ctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(TASK) as { context_json: string }).context_json);
  ok(ctx.awaiting_input?.question?.includes('已暂停'), '系统侧到顶暂停写入 awaiting_input.question（GUI 横幅真源）', ctx.awaiting_input?.question);
  ok(ctx.awaiting_input?.decision_type === 'goal_deviation_pause', 'decision_type 标明暂停类型');
  ok(typeof ctx.awaiting_input?.asked_at === 'string' && !Number.isNaN(Date.parse(ctx.awaiting_input.asked_at)), 'asked_at 落盘（判重账因此对该暂停同样生效）');
  // 该暂停从此可被"同一轮重复提交"判据识别（此前无真源，判不了）
  ok(isDuplicatePauseResponse(ctx, 'resume', undefined, Date.now()) === false, '首次提交不算重复');
  const prev = { ...ctx, pause_response: { at: Date.now(), decision: 'resume', value: null, asked_at: ctx.awaiting_input.asked_at } };
  ok(isDuplicatePauseResponse(prev, 'resume', undefined, Date.now()) === true, '★同一次暂停的重复提交被拦（新真源使该暂停纳入判重）');
  // 恢复即清（既有 settlePause 语义）——横幅不会在恢复后残留
  settlePause(db, TASK, ctx, 'resume', undefined, true);
  const ctx2 = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(TASK) as { context_json: string }).context_json);
  ok(ctx2.awaiting_input === undefined, '恢复后 awaiting_input 被清（横幅不残留）');
  db.close();
}

ok((aitCode.match(/persistAwaitingInput\(db, taskId, \{ question: GOAL_DEVIATION_PAUSE_REASON/g) || []).length === 2, '★两处到顶暂停均写等待输入真源');
ok((aitCode.match(/eventBus\.emit\('task\.awaiting_input'/g) || []).length === 2, '两处到顶暂停均发 task.awaiting_input（桌面即时可见）');
// zx_20260917 M1: IM 那句改由唯一写入口的 `note` 转投（`pauseTask` → `markPauseNeeded`）。
// 同源关系不变：常量仍恰一处定义，横幅(question)与 IM(note) 都取它。
ok(aitCode.includes('pauseTask(db, { taskId, reason: PAUSE_REASON_GOAL_DEVIATION, note: GOAL_DEVIATION_PAUSE_REASON })') && (aitCode.match(/GOAL_DEVIATION_PAUSE_REASON = '/g) || []).length === 1,
  'IM 通知与横幅文案同源一句（不再两处各写一版）');
ok(ait.includes('persistAwaitingInput') && /import \{[^}]*persistAwaitingInput[^}]*\} from '\.\.\/agent-executor\.js'/.test(ait), 'ai-task 自 agent-executor 引入真源写入函数');
const tdp2 = rd('apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx');
ok(tdp2.includes('awaiting_input?: { question?: string') && tdp2.includes('awaitStruct?.question'), '★renderer 横幅已读该真源（零新增 UI）');

console.log('\n结果: pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
