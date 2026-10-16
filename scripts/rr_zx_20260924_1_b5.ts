/**
 * zx_20260924_1 批次 M5 + M9-d 受控复跑 —— 「成果页归一 / ★ 一处真源 / 手工新建可回溯 / 字符数不当字节」
 * （对应方案 §1.8 F8 四缺陷、§1.17 F17、§4.2 V-9(b) 裁定、§3.3 E-5）
 *
 * ── M5-a：★ 互斥此前有**两份写法** ───────────────────────────────────────────────
 *   `deliverable-lifecycle.ts` 的 `applyPrimary` 做的是「同作用域先清兄弟、再置目标行」（一支事务），
 *   而 `autoAssignPrimary` 里**另写了一条** `UPDATE ... SET is_primary = 1` —— 只置自己、不清兄弟。
 *   偏偏它的前置计数 `priCnt` 又**不数 retired 的行**（`status != 'retired'`）：于是一个**已退休的 ★**
 *   加上一次自动置位 ⇒ 同作用域**两行 is_primary=1**，与 `primaryScope` 自述的"至多一条"直接矛盾。
 *   本批把落位动作改走 `applyPrimary`，此处只留**选谁**、不留**怎么置**。
 *
 * ── M5-b：列表侧"大小"与"树"两处各说各话 ────────────────────────────────────────
 *   ① `deliverable:list` 无大小（`wa_deliverables` **没有 size 列**，真实字节只能在 main 侧现场 stat）；
 *   ② 产出物管理页是平铺表，而任务详情页已用 `buildDeliverableTree` 呈目录树 ⇒ 同一批件两页长相/层级不同。
 *
 * ── M5-c：手工新建的件**回不去**任何任务 ────────────────────────────────────────
 *   `deliverable:create` 的 INSERT 里没有 `task_id` ⇒ 手工件既找不回它为何而建，也被迫与项目级件共用
 *   同一个 ★ 作用域。`taskId` 为**可选**：不传维持 NULL，既有调用方零感知。
 *
 * ── M9-d：字符数被当字节数印成 KB ──────────────────────────────────────────────
 *   `wa_deliverable_versions.size` 存的是 `content.length`（**字符数**），而列表/弹窗按 `/1024` 印成 KB。
 *   实测偏差：中文文档约 **1.56 B/字符**（v61: 21886 字符 vs 盘上 34167 字节）。按 V-9(b) 裁定**列名不改**，
 *   换算只在**展示层**做；无正文可取时**如实标"字符数"**，绝不乘一个系数去伪造字节。
 *
 * §G 不变式门：
 *   G-1 **跑真实现**：`autoAssignPrimary` / `applyPrimary` / `primaryScope` / `buildDeliverableTree` 一律
 *       直接 import 生产模块；`statSizeBytes` 与「建成果」那条 INSERT 的 SQL **按符号从原文切出后执行**
 *       （跑的是文件的原文，不是本脚本里手抄的等价物——那叫「判据的自我印证」，本仓大忌）。
 *       ⚠ zx_20260930 M3-c：该 INSERT 的落点已由 `deliverable:create` handler 收进共享起草处
 *         `createDeliverable` ⇒ 切块锚点随之改到 `deliverable-lifecycle.ts`（见【B】组内就地订正说明）。
 *   G-2 **两只标本一起试**：每条判据两侧都有真标本（该命中/该不命中、0→1 的两端、存在/缺失）。
 *   G-3 **扫描面自证**：凡"零命中"类断言，同一把尺另跑一只"该命中"的构造标本，证扫描器非恒假。
 *
 * ⚠ 本脚本**不写任何轮次字面量**；自身轮次标识一律由 `path.basename(__filename)` 派生。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checkBuildPins } from './lib/rr-pins.js';
import {
  autoAssignPrimary, applyPrimary, primaryScope, createDeliverable,
} from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import { buildDeliverableTree } from '../apps/worker-ant-desktop/src/main/core/deliverable-tree.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => any };

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');

/**
 * `node:sqlite` 没有 better-sqlite3 的 `db.transaction()`，而 `applyPrimary` 是**真实现**（内含一支事务）。
 * 故只补这一枚**驱动方法**，语义照 better-sqlite3：抛错则 ROLLBACK 后原样抛出（吞错的假事务会让
 * "0→1"变成自证）。**这补的是驱动能力，不是判据：被测逻辑一行未替。**
 */
const withTx = (d: any): any => {
  d.transaction = (fn: () => void) => () => {
    d.exec('BEGIN');
    try { fn(); d.exec('COMMIT'); } catch (e) { try { d.exec('ROLLBACK'); } catch { /* 无活动事务 */ } throw e; }
  };
  return d;
};

// ─────────────────────────────────────────────────────────────
// 【A】★ 互斥：同作用域至多一条（M5-a）
// ─────────────────────────────────────────────────────────────
// 夹具：同一任务 t1 上一条**已退休的 ★**（正是 priCnt 数不到的那种行）+ 一条待置位的 doc。
//       另在**别的任务** t2 与**项目级手工组**（task_id IS NULL）各放一条活 ★——
//       它们是"该不命中"的标本：清兄弟若写成"清全表"，会被这两条抓住。
const DELIV_DDL = `CREATE TABLE wa_deliverables (
  id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT, name TEXT, description TEXT,
  file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft', is_primary INTEGER DEFAULT 0,
  updated_at TEXT, created_at TEXT);`;
// preferCreated 缺省即开（`readBoolSetting` 缺省返回 true）⇒ 排序里的子查询会碰 wa_event_log，夹具须搭上。
const EVENT_LOG_DDL = `CREATE TABLE wa_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, event_type TEXT, aggregate_type TEXT,
  aggregate_id TEXT, aggregate_version INTEGER, payload TEXT, metadata TEXT, occurred_at TEXT);`;
const SETTINGS_DDL = "CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);";

const mkDelivDb = (): any => {
  const d = withTx(new DatabaseSync(':memory:'));
  d.exec(`${DELIV_DDL}${SETTINGS_DDL}${EVENT_LOG_DDL}`);
  return d;
};
/** 建**同一形状**的夹具（A-0 的反证与 A-1 主判据各用一份，互不污染）。 */
const seed = (d: any): void => {
  const ins = d.prepare(`INSERT INTO wa_deliverables
    (id, project_id, task_id, type, name, file_path, status, is_primary, created_at, updated_at)
    VALUES (?, 'p', ?, 'doc', ?, ?, ?, ?, ?, ?)`);
  ins.run('d_old', 't1', 'old.md', '/r/old.md', 'retired', 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00');
  ins.run('d_new', 't1', 'new.md', '/r/new.md', 'draft', 0, '2026-02-01 00:00:00', '2026-02-01 00:00:00');
  ins.run('d_other', 't2', 'other.md', '/r/other.md', 'draft', 1, '2026-01-15 00:00:00', '2026-01-15 00:00:00');
  ins.run('d_man', null, 'man.md', '/r/man.md', 'draft', 1, '2026-01-16 00:00:00', '2026-01-16 00:00:00');
  d.prepare("INSERT INTO wa_settings (key, value) VALUES ('deliverable.primary_auto', 'true')").run();
};
/** 作用域内 ★ 的条数——**作用域谓词取生产自己的 `primaryScope`**（不手抄 `task_id = ?`）。 */
const starCount = (d: any, row: { task_id?: string | null; project_id: string }, liveOnly: boolean): number => {
  const s = primaryScope(row);
  const extra = liveOnly ? " AND status != 'retired'" : '';
  return (d.prepare(`SELECT COUNT(*) c FROM wa_deliverables WHERE ${s.sql} AND is_primary = 1${extra}`).get(...s.params) as { c: number }).c;
};
const T1 = { task_id: 't1', project_id: 'p' };

console.log('\n【A】★ 互斥：一个已退休的 ★ + 一次自动置位，不得并存两行（M5-a）');

// A-0 前提自证：这份夹具**真的能**触发病根。用**改前的内联写法**跑同一份夹具 ⇒ 同作用域 2 行 ★。
//     （这是反证标本，不是判据：它证明 A-3 的绿灯不是"这份夹具怎么改都绿"。）
const dbOld = mkDelivDb();
seed(dbOld);
dbOld.prepare("UPDATE wa_deliverables SET is_primary = 1, updated_at = datetime('now') WHERE id = 'd_new'").run();
ok(starCount(dbOld, T1, false) === 2,
  'A-0 **前提自证**：改前的内联写法（只置自己、不清兄弟）在同一夹具上留下 **2 行 ★** ⇒ 标本确实踩在病根上',
  `scope ★=${starCount(dbOld, T1, false)}（d_old retired + d_new）`);

const db = mkDelivDb();
seed(db);
ok(starCount(db, T1, true) === 0,
  'A-1 **0 的那一半**：置位前，本任务**非 retired** 的 ★ 恰 0 条（正是 `priCnt===0` 放行的条件）',
  `live ★=${starCount(db, T1, true)} / scope ★=${starCount(db, T1, false)}（后者含那条已退休的）`);
const r1 = autoAssignPrimary(db, 't1');
ok(r1.assigned === 'd_new', 'A-2 自动置位选中最新 doc（d_new）——选谁这一半未动', `assigned=${String(r1.assigned)}`);
ok(starCount(db, T1, true) === 1,
  'A-3 **1 的那一半（0→1 正面断言）**：置位后本任务**非 retired** 的 ★ 由 0 变 1',
  `live ★=${starCount(db, T1, true)}`);
ok(starCount(db, T1, false) === 1,
  'A-4 **本条即缺陷判据**：全作用域（含 retired）只剩 **1 行** ★，不是 2 行 —— 落位真的走了 applyPrimary',
  `scope ★=${starCount(db, T1, false)}（改前此处置为 2）`);
ok((db.prepare("SELECT is_primary p FROM wa_deliverables WHERE id='d_old'").get() as { p: number }).p === 0,
  'A-5 那条已退休的 ★ 被同作用域清兄弟清掉（"至多一条"的代价如实落在这里）');
ok((db.prepare("SELECT is_primary p FROM wa_deliverables WHERE id='d_new'").get() as { p: number }).p === 1,
  'A-6 目标行本行已置 1（清兄弟没有把目标行一起清掉——顺序反了就会 0 条）');

// A-7/A-8 该不命中：清兄弟**不得**越出本任务的作用域
ok(starCount(db, { task_id: 't2', project_id: 'p' }, false) === 1,
  'A-7 **该不命中**：别的任务（t2）的 ★ 未被波及 ⇒ 作用域没写成"清全表"',
  `t2 ★=${starCount(db, { task_id: 't2', project_id: 'p' }, false)}`);
ok(starCount(db, { task_id: null, project_id: 'p' }, false) === 1,
  'A-8 **该不命中**：项目级手工组（task_id IS NULL）的 ★ 未被波及 ⇒ 清兄弟认得出"手工组"这个作用域',
  `手工组 ★=${starCount(db, { task_id: null, project_id: 'p' }, false)}`);

// A-9 已有活 ★ ⇒ 前置计数拦下，连"选谁"都不进（行为不变清单）
const db2 = mkDelivDb();
seed(db2);
db2.prepare("UPDATE wa_deliverables SET is_primary = 1 WHERE id = 'd_old'").run();
db2.prepare("UPDATE wa_deliverables SET status = 'draft' WHERE id = 'd_old'").run();
const r2 = autoAssignPrimary(db2, 't1');
ok(r2.assigned === undefined && (db2.prepare("SELECT is_primary p FROM wa_deliverables WHERE id='d_old'").get() as { p: number }).p === 1
  && (db2.prepare("SELECT is_primary p FROM wa_deliverables WHERE id='d_new'").get() as { p: number }).p === 0,
  'A-9 行为不变：本任务已有**活** ★ ⇒ 不覆盖、不换标（`priCnt != 0` 前置照旧生效）', `assigned=${String(r2.assigned)}`);

// A-10 直接调 applyPrimary 撤位（flag=0）只影响本行——两支出口共用同一实现，撤位不得连带清兄弟
const db3 = mkDelivDb();
seed(db3);
applyPrimary(db3, { id: 'd_other', project_id: 'p', task_id: 't2' }, 0);
ok(starCount(db3, { task_id: 't2', project_id: 'p' }, false) === 0
  && (db3.prepare("SELECT is_primary p FROM wa_deliverables WHERE id='d_man'").get() as { p: number }).p === 1,
  'A-10 `applyPrimary(flag=0)` 只撤本行、不清兄弟（另一作用域的 ★ 仍在）');

// A-11 静态：落位还走 applyPrimary（按**符号**切 `autoAssignPrimary` 的函数体，不按行号）
const dlcSrc = rd(`${A}/src/main/core/deliverable-lifecycle.ts`);
const iAA = dlcSrc.indexOf('export function autoAssignPrimary');
const iAfter = dlcSrc.indexOf('export function selectProbeDeliverables');
const aaBody = iAA >= 0 && iAfter > iAA ? dlcSrc.slice(iAA, iAfter) : '';
ok(aaBody.length > 0, 'A-11a `autoAssignPrimary` 函数体可按符号切出（锚点按符号，不按行号）', `${aaBody.length} 字符`);
ok(!aaBody.includes('SET is_primary = 1') && /applyPrimary\(db,\s*cand,\s*1\)/.test(aaBody),
  'A-11b 体内**已无内联 `SET is_primary = 1`**，且必须经 `applyPrimary(db, cand, 1)` 落地 ⇒ 落位只有一个真源');
ok(/SELECT d\.id, d\.project_id, d\.task_id FROM wa_deliverables d/.test(aaBody),
  'A-11c 候选查询把 project_id / task_id 一并选出（`applyPrimary` 要三件才认得出作用域）');

// ─────────────────────────────────────────────────────────────
// 【B】手工新建可回溯：task_id 落位（M5-c）
// ─────────────────────────────────────────────────────────────
// 判据跑**文件原文**：从共享起草处 `createDeliverable` 的原文里切出列清单、VALUES 与 `.run(...)` 的
// 实参表达式；GUI 那一跳则钉"把 `taskId` 递进起草处了没有"。
//
// ⚠ zx_20260930 M3-c **就地订正（落点变了，判据随实变）**：`deliverable:create` 的落库动作已由 handler
//   内联 INSERT 收进共享起草处 `createDeliverable`（校验→去重→落库→通报四步一处；agent 工具与 GUI 同一个函数）。
//   旧写法在 **handler 里**找 INSERT ⇒ 切出空串（`cols=[]`、`iTaskCol=-1`），随后把空 SQL 喂 `prepare` 直接
//   `near ")": syntax error` 崩掉。**不是放宽**：本组三件（列/值/实参三方对齐、列位与表达式保真、
//   GUI 真把 `taskId` 递进起草处）一件未减，另加一条**行为**判据直接跑真 `createDeliverable` 回读落库列。
console.log('\n【B】手工新建可回溯：`task_id` 落位（M5-c；落点自 M3-c 起为共享起草处）');

const ipcSrc = rd(`${A}/src/main/ipc/project.ipc.ts`);
const iCreate = ipcSrc.indexOf("ipcMain.handle('deliverable:create'");
const iCreateEnd = ipcSrc.indexOf("ipcMain.handle('project:clone'", iCreate);
const createSrc = iCreate >= 0 && iCreateEnd > iCreate ? ipcSrc.slice(iCreate, iCreateEnd) : '';
ok(createSrc.length > 0, 'B-0a `deliverable:create` handler 原文可按符号切出', `${createSrc.length} 字符`);
ok(/createDeliverable\(db,\s*\{[\s\S]*?\btaskId\b[\s\S]*?\}\s*\)/.test(createSrc),
  'B-0a2 ★接线：GUI handler 把 `taskId` **递进了共享起草处**（取值这一跳；列清单再对、参数没递到也是白搭）');

// 落库形状从**起草处**切（锚点按符号：`export function createDeliverable(` → 下一个顶层 `export function `）
const lifeSrc = rd(`${A}/src/main/core/deliverable-lifecycle.ts`);
const iCd = lifeSrc.indexOf('export function createDeliverable(');
const iCdEnd = lifeSrc.indexOf('\nexport function ', iCd + 1);
const cdSrc = iCd >= 0 ? lifeSrc.slice(iCd, iCdEnd < 0 ? lifeSrc.length : iCdEnd) : '';
ok(cdSrc.length > 0, 'B-0b 起草处 `createDeliverable` 函数体可按符号切出', `${cdSrc.length} 字符`);

const mIns = cdSrc.match(/INSERT INTO wa_deliverables \(([^)]*)\)\s*VALUES \(([^)]*)\)/);
const cols = (mIns?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const vals = (mIns?.[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const mRun = cdSrc.match(/INSERT INTO wa_deliverables[\s\S]*?\)\s*\.run\(([^)]*)\)/);
const runArgsSrc = (mRun?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const iTaskCol = cols.indexOf('task_id');
const nPlaceholders = vals.filter((v) => v === '?').length;
ok(cols.length > 0 && cols.length === vals.length && iTaskCol >= 0 && runArgsSrc.length === nPlaceholders,
  'B-0b2 切出非空且形状对得上：列数 === VALUES 项数、含 `task_id`、实参表达式数 === 占位符数',
  `cols=[${cols.join(',')}] vals=${vals.length} args=[${runArgsSrc.join(' | ')}]`);

// 实参表达式里的形参名从**文件的解构模式**派生（改名不会让本判据炸成 ReferenceError，而是由 B-4 报出桥不同形）
const mPat = createSrc.match(/async\s*\([^,]*,\s*\{([^}]*)\}\s*:/);
const paramNames = (mPat?.[1] ?? '').split(',').map((s) => s.split(':')[0]!.trim()).filter(Boolean);
ok(paramNames.length === 6 && paramNames.includes('taskId'),
  'B-0c 形参名由 handler 解构模式派生（不手抄），且含本轮新增的 `taskId`', `[${paramNames.join(',')}]`);

// B-1a 保真表达式（**静态**）：`task_id` 那一位在原文里必须写的是 `input.taskId || null`
//      —— 它同时钉两件事：列位没错位、且 `undefined` 走 `||` 归 `null`（不是字符串 `"undefined"`）。
ok(/^input\.taskId\s*\|\|\s*null$/.test((runArgsSrc[iTaskCol] ?? '').replace(/\s+/g, ' ').trim()),
  'B-1a ★保真表达式：`task_id` 位在原文里恰是 `input.taskId || null`（错位 / 改写 / 落成 `"undefined"` 皆红）',
  `args[${iTaskCol}]=${String(runArgsSrc[iTaskCol])}`);

// B-3 位次对齐：`task_id` 在**列清单**里的下标，与实参表里 `taskId` 那一项的下标必须一致。
//     错一位（如将来在中间插一列却忘了补实参）⇒ 参数会静默写进**别的列**，JS/SQLite 都不报错。
ok(/^input\.taskId\b/.test(runArgsSrc[iTaskCol] ?? ''),
  'B-3 位次对齐：`task_id` 的列下标与实参表里 `taskId` 那一项**同位**（错位即静默写错列）',
  `cols[${iTaskCol}]=${cols[iTaskCol]} / args[${iTaskCol}]=${String(runArgsSrc[iTaskCol])}`);

// B-1b / B-2b **行为**：直接跑**真** `createDeliverable` 回读落库列——比"求值一张实参表达式表"强一档：
//   校验、去重、INSERT、通报四步一并走真实现（表达式表只能说"如果这么传就写那位"，行为才是"确实写进去了"）。
//   注：**通报**的细粒度断言归 `rr_zx_20260930` §C-c（那里有 `captureEvents` 夹具），此处只管 `task_id` 列。
const dbB = withTx(new DatabaseSync(':memory:'));
dbB.exec(`CREATE TABLE wa_deliverables (
  id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL, name TEXT DEFAULT '',
  description TEXT DEFAULT '', file_path TEXT, status TEXT DEFAULT 'draft', updated_at TEXT);`);

const cdWith = createDeliverable(dbB, { projectId: 'p', taskId: 'T-c1', name: 'n1', type: 'doc', via: 'rr:b5' });
const rowWith = dbB.prepare("SELECT task_id, status FROM wa_deliverables WHERE id = ?").get(cdWith.ok ? cdWith.id : '∅') as { task_id: string | null; status: string } | undefined;
ok(cdWith.ok && rowWith?.task_id === 'T-c1',
  'B-1b **该命中**（行为）：传 `taskId=T-c1` ⇒ 落库回读 `task_id === \'T-c1\'`（手工件可回溯到所属任务）',
  `ok=${cdWith.ok} task_id=${String(rowWith?.task_id)}/${String(rowWith?.status)}`);

const cdWithout = createDeliverable(dbB, { projectId: 'p', name: 'n2', type: 'doc', via: 'rr:b5' });
const rowWithout = dbB.prepare("SELECT task_id FROM wa_deliverables WHERE id = ?").get(cdWithout.ok ? cdWithout.id : '∅') as { task_id: string | null } | undefined;
ok(cdWithout.ok && rowWithout?.task_id === null,
  'B-2b **该不命中**（行为）：不传 `taskId` ⇒ 落库回读 `task_id IS NULL`（不是字符串 `"undefined"`）—— 既有调用方零感知',
  `ok=${cdWithout.ok} task_id=${String(rowWithout?.task_id)}`);

// B-4 渲染桥同形：端口名的键必须与 main 侧解构键逐字同形，否则 taskId 静默丢失（JS 不报错）
const bridgeSrc = rd(`${A}/renderer/src/lib/ipc.ts`);
const mBridge = bridgeSrc.match(/create:\s*\(([^)]*)\)\s*=>\s*ipcCall<[^(]*>\('deliverable:create',\s*\{([^}]*)\}\)/);
const bridgeKeys = (mBridge?.[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
ok(bridgeKeys.length === 6 && bridgeKeys.every((k, i) => k === paramNames[i]),
  'B-4 renderer 桥的实参键与 main 侧解构键**逐字同形且同序**（6 键）—— 少一个键就是静默丢参数',
  `桥=[${bridgeKeys.join(',')}] / main=[${paramNames.join(',')}]`);

// ─────────────────────────────────────────────────────────────
// 【C】列表"大小"：真实字节 / 缺失不抛（M5-b）
// ─────────────────────────────────────────────────────────────
console.log('\n【C】列表"大小"：`statSizeBytes` 现场 stat，失败一律 null、绝不抛（M5-b）');

/** 按花括号配对切出整段函数体（锚点按符号，不按行号）。 */
function sliceBraced(src: string, iBrace: number): number {
  let d = 0;
  for (let i = iBrace; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return i; }
  }
  return -1;
}
const iFn = ipcSrc.indexOf('function statSizeBytes(');
const iFnBrace = iFn >= 0 ? ipcSrc.indexOf('{', iFn) : -1;
const iFnEnd = iFnBrace > 0 ? sliceBraced(ipcSrc, iFnBrace) : -1;
let fnText = iFn >= 0 && iFnEnd > iFn ? ipcSrc.slice(iFn, iFnEnd + 1) : '';
fnText = fnText.replace(/\(filePath:\s*unknown\)/, '(filePath)').replace(/\):\s*number\s*\|\s*null\s*\{/, ') {');
ok(fnText.length > 0 && /fs\.statSync/.test(fnText) && /isFile\(\)/.test(fnText) && !/:\s*(unknown|number)\b/.test(fnText),
  'C-0a `statSizeBytes` 函数原文可按符号切出、且 TS 注解已剥净（跑的是文件原文，不是手抄等价物）',
  `${fnText.length} 字符`);
const statSizeBytes = (new Function('fs', `${fnText}\nreturn statSizeBytes;`))(fs) as (p: unknown) => number | null;
ok(typeof statSizeBytes === 'function',
  'C-0b 切出的原文可执行（"从原文切函数"这台机器本身非空转）', typeof statSizeBytes);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr_b5_'));
const realPath = path.join(tmp, 'real.txt');
const content = '汉字abc\n'; // 中文 ⇒ 字节数 ≠ 字符数，正好把"字符数冒充字节"那类错法挡在门外
fs.writeFileSync(realPath, content, 'utf-8');
const expectBytes = Buffer.byteLength(content, 'utf-8');
ok(expectBytes > 0 && expectBytes !== content.length,
  'C-1a 标本自证：该件的**字节数 ≠ 字符数**（期望值独立算得）⇒ 能把"拿字符数冒充字节"的错法挡在门外',
  `${expectBytes} 字节 / ${content.length} 字符`);
ok(statSizeBytes(realPath) === expectBytes,
  'C-1b **该命中**：存在的文件 ⇒ 盘上真实字节数（不是字符数、不是 0）', `${String(statSizeBytes(realPath))} vs 期望 ${expectBytes}`);

const missing = path.join(tmp, '__definitely_missing__.bin');
let threw: string | null = null;
let missingVal: number | null = -1;
try { missingVal = statSizeBytes(missing); } catch (e) { threw = (e as Error).message; }
ok(threw === null && missingVal === null,
  'C-2 **该不命中且不抛**：文件不存在的路径 ⇒ `null`，且**未抛**（一个件失效不该把整页列表打红）',
  `threw=${String(threw)} val=${String(missingVal)}`);

const nullCases: Array<[string, unknown]> = [
  ['空串', ''], ['纯空白', '   '], ['null', null], ['undefined', undefined], ['数字', 123],
];
for (const [name, v] of nullCases) {
  let e2: string | null = null; let got: number | null = -1;
  try { got = statSizeBytes(v); } catch (e) { e2 = (e as Error).message; }
  ok(e2 === null && got === null, `C-3 无路径/非字符串（${name}）⇒ null 且不抛`, `val=${String(got)}`);
}
let dirVal: number | null = -1;
try { dirVal = statSizeBytes(tmp); } catch { dirVal = -2; }
ok(dirVal === null, 'C-4 目录路径 ⇒ null（`isFile()` 那一支；"不知道大小"不等于"大小为零"，故不返回 0）', String(dirVal));
ok(statSizeBytes(`  ${realPath}  `) === expectBytes,
  'C-5 首尾空白路径先 trim 再 stat（同一标本的改写形，证明 trim 那段真的在跑）', String(statSizeBytes(`  ${realPath}  `)));

// C-6 接线在册：列表 handler 里**逐行**补 size_bytes（静态，按符号锚定在 handler 体内）
const iList = ipcSrc.indexOf("ipcMain.handle('deliverable:list'");
const iListEnd = ipcSrc.indexOf("ipcMain.handle('deliverable:create'", iList);
const listSrc = iList >= 0 && iListEnd > iList ? ipcSrc.slice(iList, iListEnd) : '';
ok(listSrc.length > 0 && /for \(const r of data\) r\.size_bytes = statSizeBytes\(r\.file_path\);/.test(listSrc),
  'C-6 `deliverable:list` handler 体内逐行接线 `r.size_bytes = statSizeBytes(r.file_path)`（挂上才算数）',
  `${listSrc.length} 字符`);

// ─────────────────────────────────────────────────────────────
// 【D】成果页归一：两页同一棵树 + 字符数不当字节（M5-b / M9-d）
// ─────────────────────────────────────────────────────────────
console.log('\n【D】成果页归一：与任务详情**同一份** buildDeliverableTree；版本大小按 V-9(b) 展示层换算（M5-b / M9-d）');

const dpageSrc = rd(`${A}/renderer/src/pages/DeliverablesPage.tsx`);
const tdpSrc = rd(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
// zx_20260929 M7: 字节换算/字符数展示/库内时间解析已抽成 renderer 侧**一份共享真源**。
//   D-4x 的判据随之改钉该真源（打在本页会随迁移变假红），并**反钉本页不再留第二份实现**。
const viewSrc = rd(`${A}/renderer/src/lib/deliverable-view.ts`);
const drawerSrc = rd(`${A}/renderer/src/components/DeliverableDrawer.tsx`);
const specOf = (src: string) => (src.match(/import\s*\{[^}]*\}\s*from\s*'([^']*deliverable-tree\.js)'/) ?? [])[1] ?? '';
const specTdp = specOf(tdpSrc);
const specDp = specOf(dpageSrc);
ok(specTdp !== '' && specDp === specTdp,
  'D-0 两页的 import 说明符**逐字相同**（期望值从任务详情页读出，非本脚本手抄）⇒ 引的是同一个模块',
  `tdp=${specTdp} / dp=${specDp}`);

// D-1 引了还要**真的用**：树必须由共享实现算，且两种视图**共用一份已筛序列**（否则筛只对一种视图生效）
ok(/buildDeliverableTree<Deliverable>\(visibleRows\)/.test(dpageSrc),
  'D-1a 产出物页真的调了 `buildDeliverableTree<Deliverable>(visibleRows)`（不是引而不用）');
ok(/const visibleRows = sorted;/.test(dpageSrc) && /if \(!groupByProject\) return visibleRows\.map\(/.test(dpageSrc)
  && !/buildDeliverableTree<Deliverable>\(sorted\)/.test(dpageSrc),
  'D-1b **两视图一份已筛序列**：平铺与目录树都吃 `visibleRows`（= sorted）⇒ 筛选对两种视图同时生效');
ok(/walk\(tree\.root, 0, ''\)/.test(dpageSrc) && /tree\.commonPrefix\.length > 0/.test(dpageSrc) && /tree\.noPath/.test(dpageSrc),
  'D-1c 页面只把共享实现的结果**摊成行**（消费 root/commonPrefix/noPath 三件，不自己造树）');

// D-2 ★ 筛选 / 大小列 / 任务筛选（用户可达的三个新口）
ok(/if \(onlyPrimary && d\.is_primary !== 1\) return false;/.test(dpageSrc),
  'D-2a 「仅显示主成果」按 `is_primary` 列本身过滤（不自带第二套"算什么才叫主要"的判据）');
ok(/'仅显示主成果'/.test(dpageSrc) && /\[\s*'size'\s*,\s*'大小'\s*\]/.test(dpageSrc) && /formatBytes\(d\.size_bytes\)/.test(dpageSrc),
  'D-2b 新增用户可见文案三件到齐：筛选名「仅显示主成果」/ 表头「大小」/ 单元格走 `formatBytes(d.size_bytes)`');
// zx_20260930 M4-2: 载体由 `allItems`（无参全表）换成服务端 `facets`。判据的**意图不变**——下拉候选
//   必须来自"未过滤全集"（选定后不坍缩）；换载体后该保证更强（连分页也不影响名录）。
//   「项目级」那一组的计数同样改由服务端 `noTaskCount` 给，故反钉页面**不再**自己 filter 出一份全集。
ok(/const TASK_NONE = '__none__';/.test(dpageSrc) && /项目级（无产出任务/.test(dpageSrc)
  && /filterTask === TASK_NONE/.test(dpageSrc) && /const taskOptions = facetTasks\.map\(/.test(dpageSrc)
  && /const noTaskCount = facetNoTaskCount;/.test(dpageSrc) && !/allItems\.filter\(i => !i\.task_id\)/.test(dpageSrc),
  'D-2c 任务筛选含「项目级」（task_id IS NULL）一组，且下拉候选取**未过滤全集**（M4-2 起由服务端 facets 给，选定后不坍缩）');

// D-3 共享模块的三条规则按**两侧标本**钉住（跑真实现）
const treeItems = [
  { file_path: '/r/x.md', id: 'x' },
  { file_path: '/r/a/b/c/d.md', id: 'd' },
  { file_path: '', id: 'n' },
];
const tree = buildDeliverableTree(treeItems);
const names = tree.root.map((c) => c.name);
ok(tree.commonPrefix.join('/') === 'r',
  'D-3a 规则①剥公共前缀：公共**目录**前缀 = r（末段文件名不参与），故叶子不再挂 `r/`', `[${tree.commonPrefix.join('/')}]`);
ok(names.includes('a/b/c') && tree.root.some((c) => c.kind === 'file' && c.name === 'x.md'),
  'D-3b 规则③单子目录链并段：`a/b/c` 连写成一段（中间只有一条路的段不算结构）', `root=[${names.join(' | ')}]`);
ok(tree.noPath.length === 1 && tree.noPath[0]!.id === 'n',
  'D-3c 规则②无盘上路径的件**如实单列**在 noPath，绝不塞进假目录', `noPath=${tree.noPath.length}`);
const leafCount = (cs: typeof tree.root): number => cs.reduce((s, c) => s + (c.kind === 'file' ? 1 : leafCount(c.children)), 0);
ok(leafCount(tree.root) + tree.noPath.length === treeItems.length,
  'D-3d 集合守恒：展平后 + noPath 与传入**逐条相等**（"换个摆法"不许变成"少了几个件"）',
  `${leafCount(tree.root)}+${tree.noPath.length} vs ${treeItems.length}`);

// D-4 M9-d：字节换算**只许在 formatBytes 里**、字符数那一路**不做 /1024**，且无正文时**明说**是字符数。
//     判据取**结构**而非某一行文字：K/M 换算若复活在版本弹窗等处（正是原病根的位置），计数立刻不等。
//     zx_20260929 M7: 实现已迁入共享真源 `lib/deliverable-view.ts` ⇒ 锚点随之迁移，
//       并加"本页/抽屉零实现"的反向钉子（两件一起才叫"只有一个落点"）。
const fbStart = viewSrc.indexOf('function formatBytes(');
const fbEnd = fbStart >= 0 ? sliceBraced(viewSrc, viewSrc.indexOf('{', fbStart)) : -1;
const fbBody = fbStart >= 0 && fbEnd > fbStart ? viewSrc.slice(fbStart, fbEnd + 1) : '';
const nFixAll = (viewSrc.match(/\.toFixed\(1\)/g) ?? []).length;
const nFixFb = (fbBody.match(/\.toFixed\(1\)/g) ?? []).length;
const nFixPage = (dpageSrc.match(/\.toFixed\(1\)/g) ?? []).length;
ok(nFixAll > 0 && nFixAll === nFixFb && nFixPage === 0,
  'D-4a `.toFixed(1)` **全部落在共享真源的 `formatBytes` 内**（>0 自证扫描面非空；产出物页零处）⇒ 版本大小换算没有第二处落点',
  `真源 ${nFixAll} 处 / formatBytes 内 ${nFixFb} 处；页面 ${nFixPage}`);
const vstStart = viewSrc.indexOf('function versionSizeText(');
const vstEnd = vstStart >= 0 ? sliceBraced(viewSrc, viewSrc.indexOf('{', vstStart)) : -1;
const vstBody = vstStart >= 0 && vstEnd > vstStart ? viewSrc.slice(vstStart, vstEnd + 1) : '';
ok(vstBody.length > 0 && !/1024/.test(vstBody),
  'D-4b **字符数那一路不做任何 /1024 换算**（看"大小"判据只看这段函数体——避开全页关键词的误伤）',
  `${vstBody.length} 字符，` + (/1024/.test(vstBody) ? '仍含 1024' : '无 1024'));
// 扫描器自证：同一把"病根形"的尺对**真病根写法**必命中（否则 D-4a/D-4b 只是扫了个空）。
// 真病根形 = 拿一个叫 size 的**字符数**直接除 1024 并紧跟 `KB`（无空格）——这正是本页与详情抽屉改前的写法。
const DISEASE = /size\s*\/\s*1024\s*\)\s*\.toFixed\(1\)\s*\}\s*KB/;
ok(DISEASE.test('` · ${(size / 1024).toFixed(1)}KB`') && DISEASE.test('${(selVer.size / 1024).toFixed(1)}KB')
  && !DISEASE.test(dpageSrc) && !DISEASE.test(viewSrc) && !DISEASE.test(fbBody) && !DISEASE.test(drawerSrc),
  'D-4c **扫描器自证非恒假**：真病根形（字符数 / 1024 紧跟 KB）在两处历史写法上都命中，而页面/真源/formatBytes/抽屉内均无（抽屉的 `/1024/1024 …MB` 是图片内联上限，另一件事，不误伤）');
ok(/new TextEncoder\(\)\.encode\(String\(s\)\)\.length/.test(viewSrc),
  'D-4d 有正文时按**真实 UTF-8 字节**实算（TextEncoder，不乘系数、不猜编码；在共享真源内）');
ok(/本列是字符数，不是字节数/.test(viewSrc) && /\$\{chars\} 字符/.test(viewSrc) && /字符数 \$\{chars \?\? '\?'\}/.test(viewSrc),
  'D-4e 无正文可取时**如实标"字符数"**（文案明说"本列是字符数，不是字节数"，tooltip 另报库内字符数）——不编字节数');
ok((viewSrc.match(/function versionSizeText\(/g) ?? []).length === 1
  && (dpageSrc.match(/function versionSizeText\(/g) ?? []).length === 0
  && (drawerSrc.match(/function versionSizeText\(/g) ?? []).length === 0,
  'D-4f 换算**只有一处实现**（共享真源 `versionSizeText`）——列表/抽屉判据均为**调用**，不各自再写一份');
const vstCalls = (dpageSrc.match(/versionSizeText\(/g) ?? []).length + (drawerSrc.match(/versionSizeText\(/g) ?? []).length;
ok(vstCalls >= 2,
  'D-4g 两处以上消费点共用同一实现（定义 1 + 调用 ≥2，列表与抽屉都引真源）',
  `列表 ${(dpageSrc.match(/versionSizeText\(/g) ?? []).length} 处 + 抽屉 ${(drawerSrc.match(/versionSizeText\(/g) ?? []).length} 处`);

// ─────────────────────────────────────────────────────────────
// 【E】M9-d 落点：DDL 注记如实 + 模板串未被注记里的反引号闭合
// ─────────────────────────────────────────────────────────────
console.log('\n【E】M9-d 落点：`wa_deliverable_versions.size` 的 DDL 注记如实（F17）');

const dbSrc = rd(`${A}/src/main/database.ts`);
const iExec = dbSrc.indexOf('db.exec(`');
const iClose = iExec >= 0 ? dbSrc.indexOf('`);', iExec + 9) : -1;
const ddl = iExec >= 0 && iClose > iExec ? dbSrc.slice(iExec + 9, iClose) : '';
ok(ddl.length > 1000 && ddl.includes('CREATE TABLE IF NOT EXISTS wa_deliverables'),
  'E-0 核心 DDL 模板串按符号切出（自证非空，否则下面两条是扫了个空）', `${ddl.length} 字符`);
// ⚠ 本轮实测踩到的坑：注记里写反引号会**提前闭合**这个模板串 ⇒ typecheck 报 6 条错，全在 database.ts。
ok(!ddl.includes('`'),
  'E-1 DDL 模板串内**不得出现反引号**（注记里写一个反引号就会提前闭合模板串——本轮返工过的坑，机械钉住）');
ok(/本表\*\*没有 size 列\*\*/.test(ddl) && /statSizeBytes/.test(ddl),
  'E-2 `wa_deliverables` 段注记明说"没有 size 列且刻意不加"，并指向 main 侧现场 stat（statSizeBytes）');
ok(/本列是字符数，不是字节数/.test(ddl) && /1\.56 B\/字符/.test(ddl) && /V-9\(b\)/.test(ddl) && /按 V-9\(b\) 裁定/.test(ddl),
  'E-3 `wa_deliverable_versions.size` 列头注记三件到齐：是字符数 / 实测偏差 1.56 B/字符 / 按 V-9(b) 保留列名');
const iSizeCol = ddl.indexOf('size INTEGER NOT NULL');
ok(iSizeCol > 0 && ddl.slice(Math.max(0, iSizeCol - 700), iSizeCol).includes('本列是字符数'),
  'E-3b 该注记落在 `size INTEGER NOT NULL` **声明之前**（锚点按符号，不按行号）', `锚点偏移 ${iSizeCol}`);

// ─────────────────────────────────────────────────────────────
// 【G】本脚本自身与 build 钉
// ─────────────────────────────────────────────────────────────
console.log('\n【G】脚本自身 + build 钉（派生核对，不写轮次字面量）');

const SELF = path.basename(__filename);
const selfTag = SELF.match(/^rr_(zx_\d{8}(?:_\d+)?)_b5\.ts$/)?.[1] ?? '';
ok(selfTag !== '', 'G-0 本脚本轮次标识由**文件名派生**（不手抄字面量，故不会成为"只为下一轮"的哑雷）', SELF);
const noteTags = [...new Set([...dlcSrc.matchAll(/zx_(\d{8}(?:_\d+)?) M5-a/g)].map((m) => `zx_${m[1]!}`))];
ok(noteTags.length > 0 && noteTags.every((t) => t >= selfTag),
  'G-1 源码里 M5-a 注记所指轮次**不早于**本脚本轮次（方向性比较 ⇒ 下轮改指向新方案也不会引红）',
  `本脚本派生 ${selfTag} / 注记指向 ${noteTags.join(',')}`);

checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时件清理失败不引红 */ }

console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260924_1_b5: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
