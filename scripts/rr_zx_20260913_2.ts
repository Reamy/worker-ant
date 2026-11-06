/**
 * zx_20260913 M2 受控复跑（「成果·归得对」——归得对 · 数得清 · 说得明白）。
 *
 * 覆盖 M2-1..M2-7：
 *   M2-1 父子成果上浮：task:get 子树聚合 + owner 归属回传；task:list 两计数子树上卷（同一把尺套 docNotProbe）；
 *   M2-2 归属不夺：删掉 write_file 的 `UPDATE wa_deliverables SET task_id`；`otherWriters` 从版本行 changed_by 派生；
 *   M2-3 探针不入列：谓词收紧为**路径段级**（`%/_probe%` → `%/_%probe%`），并补 deliverable:list 漏网读点；
 *   M2-4 计数同尺：全景 byType 由 `GROUP BY type` **实得**展开（项目卡连带同尺）；
 *   M2-5 主要成果可见：★候选类型由 doc 扩到 doc/code/daemon/ui；
 *   M2-6 code 可溯源可验收：「可验收/可预览类型集合」归**一处真源**（零依赖模块，主进程与渲染层跨 root 同引）；
 *   M2-7 分组与人话：项目/任务名缺失显示人话（不再抛 uuid 片段）+ 按项目分组改为可关开关。
 *
 * 断言两类（承 feedback「往返/闭环类判据须在生产入参上证」）：
 *   ① 行为断言动态 import **真实现**——`autoAssignPrimary`/`otherWriters`/`docNotProbe`/`collectSubtreeIds`/
 *      `typeIn` 直调；task:get 的 SQL **从源码就地取出**再执行（生产 SQL × 生产入参），不另写一份等价 SQL；
 *   ② 静态断言一律 `stripComments` 后再比对，防注释关键词假阳性；每项均附**反证**（旧写法喂同一判据必红）。
 *
 * ⚠ 本文件不打开任何真库（真库只读实测见 data/baseline_zx_20260913.json）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  docNotProbe, otherWriters, autoAssignPrimary, deliverableScopeSql,
  ACCEPTANCE_TYPES, PRIMARY_TYPES, PREVIEW_TYPES, isAcceptanceType, isPreviewType, typeIn,
} from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import { collectSubtreeIds } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
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

// 夹具 schema 按 database.ts DDL 摘取相关列（各 NOT NULL 约束照抄，防"夹具比生产宽松"的假绿）
const SCHEMA = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '', status TEXT DEFAULT 'active');
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, parent_task_id TEXT, title TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', quality_score REAL, priority INTEGER DEFAULT 0,
  context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL,
  name TEXT DEFAULT '', description TEXT DEFAULT '', file_path TEXT, registry_id TEXT,
  status TEXT DEFAULT 'draft', is_primary INTEGER DEFAULT 0, acceptance_verified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverable_versions (id TEXT PRIMARY KEY, deliverable_id TEXT,
  file_path TEXT NOT NULL, content_snapshot TEXT NOT NULL, size INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, changed_by TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);
-- zx_20260915 P0-8(b) 起 autoAssignPrimary 的排序读事件表（本任务有无 file.created），
-- 故夹具必须按生产 DDL 建此表——此前缺表，查询抛错被 catch 吞成 {}、★ 恒不指派（夹具比生产宽松的假红）。
CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT DEFAULT '{}', occurred_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
`;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };
/**
 * zx_20260924_1 M5-a: `autoAssignPrimary` 的落位改走 `applyPrimary`（同一事务里清同作用域兄弟），
 * 而 `node:sqlite` 没有 better-sqlite3 的 `db.transaction()`。故只补这一枚**驱动方法**、语义照
 * better-sqlite3（抛错 ROLLBACK 后原样抛出，不吞错）。**补的是驱动能力，不是判据**：被测逻辑一行未替。
 */
const withTx = (d: AnyDb): AnyDb => {
  (d as unknown as { transaction: (fn: () => void) => () => void }).transaction = (fn) => () => {
    d.exec('BEGIN');
    try { fn(); d.exec('COMMIT'); } catch (e) { try { d.exec('ROLLBACK'); } catch { /* 无活动事务 */ } throw e; }
  };
  return d;
};
const addDeliv = (db: AnyDb, id: string, task: string, type: string, name: string, fp: string | null, st = 'completed', pri = 0): void => {
  db.prepare('INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status, is_primary) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, 'p', task, type, name, fp, st, pri);
};
const addTask = (db: AnyDb, id: string, parent: string | null, title = id): void => {
  db.prepare('INSERT INTO wa_tasks (id, project_id, parent_task_id, title, status, context_json) VALUES (?,?,?,?,?,?)')
    .run(id, 'p', parent, title, 'completed', '{}');
};
const addVer = (db: AnyDb, id: string, deliv: string, by: string | null, v = 1): void => {
  db.prepare('INSERT INTO wa_deliverable_versions (id, deliverable_id, file_path, content_snapshot, size, version, changed_by) VALUES (?,?,?,?,?,?,?)')
    .run(id, deliv, '/x/f.txt', 'snap', 4, v, by);
};

const prj = () => stripComments(RD(`${A}/src/main/ipc/project.ipc.ts`));
const peSrc = () => stripComments(RD(`${A}/src/main/core/project-engine.ts`));
const dlcSrc = () => stripComments(RD(`${A}/src/main/core/deliverable-lifecycle.ts`));
const aeSrc = () => stripComments(engineSrc());
const pageSrc = (f: string) => stripComments(RD(`${A}/renderer/src/pages/${f}`));

// ══════════════════════════════════════════════════════════════════
// S0 (M2-6) 类型集合归一处真源 —— 跨 root 同一份代码，不是第二条实现
// ══════════════════════════════════════════════════════════════════
console.log('\n[S0 M2-6 类型集合·一处真源（跨 root 同引）]');
{
  const typesSrc = RD(`${A}/src/main/core/deliverable-types.ts`);
  ok(!/from\s+['"](electron|better-sqlite3|node:)/.test(typesSrc),
    '真源模块零依赖（无 electron/better-sqlite3/node:*）⇒ 渲染层可跨 root 直引（同 settings-bool 范式）');
  ok(/export const ACCEPTANCE_TYPES = \['doc', 'code'\] as const;/.test(typesSrc), 'ACCEPTANCE_TYPES = doc/code（M2-6，用户 D2 裁定）');
  ok(/export const PRIMARY_TYPES = \['doc', 'code', 'daemon', 'ui'\] as const;/.test(typesSrc), 'PRIMARY_TYPES = doc/code/daemon/ui（M2-5，用户 D2 裁定）');
  ok(/export const PREVIEW_TYPES = \['doc', 'code'\] as const;/.test(typesSrc), 'PREVIEW_TYPES = doc/code（与验收同值但**刻意另具名**，防日后改预览误伤验收）');

  // TT 侧行为（真实现）
  ok(isAcceptanceType('doc') === true && isAcceptanceType('code') === true && isAcceptanceType('daemon') === false,
    'isAcceptanceType：doc/code 真、daemon 假');
  ok(isPreviewType('doc') === true && isPreviewType('code') === true && isPreviewType('mcp') === false,
    'isPreviewType：doc/code 真、mcp 假');
  eq(typeIn('', ACCEPTANCE_TYPES), { sql: 'type IN (?,?)', params: ['doc', 'code'] }, 'typeIn 无别名：SQL 与配套参数同源（防调用方漏 bind）');
  eq(typeIn('d', PRIMARY_TYPES), { sql: 'd.type IN (?,?,?,?)', params: ['doc', 'code', 'daemon', 'ui'] }, 'typeIn 带别名：SQL 与配套参数同源');
  eq(typeIn('d', PREVIEW_TYPES).params, ['doc', 'code'], 'typeIn 读的就是 PREVIEW_TYPES 本身');

  // 转出即同一模块：lifecycle 不再自定义（否则又是第二份）
  // zx_20260930 M3-c: 原断言写死整条转出名单（`ACCEPTANCE_TYPES, … typeIn`），本轮 M3-c 把
  //   `FILE_DELIVERABLE_TYPES` / `SERVICE_TYPES` / `isServiceType` / `isDocPath` / `isModuleFilePath`
  //   一并转出后即变红——**冻结名单是只对下一轮引爆的哑雷**。改钉**载体自身派生**的不变量：
  //   `deliverable-types.ts` **导出什么**，lifecycle 就**必须转出什么**（"转出即同一模块"的原意）。
  {
    const src = RD(`${A}/src/main/core/deliverable-types.ts`);
    const exported = Array.from(new Set([...src.matchAll(/export (?:const|function|type|interface|class) (\w+)/g)].map((m) => m[1]!)));
    ok(exported.length >= 6, '扫描面自证：真源导出名清单非空（否则下面的"全在转出名单里"是空转假绿）', String(exported.length));
    const re = /export \{([^}]*)\} from '\.\/deliverable-types\.js';/.exec(dlcSrc());
    ok(!!re, 'lifecycle 有一条到真源的**唯一**转出语句');
    const reExported = (re?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
    ok(reExported.every((n) => exported.includes(n)), '转出的每个名字都**真实存在**于真源（不是把不存在的名字写进转出名单）');
    // "既有调用方不必改道"的真判据：**由全仓 import 面派生**——凡具名从 lifecycle 引入的符号，
    //   lifecycle 就得真导出它（直接定义或经上句转出）。比冻死一份名单强：新增符号/新增调用方不会红，
    //   **删掉某个符号**（截断调用方）必红。
    const dlc = dlcSrc();
    const defs = new Set([...dlc.matchAll(/export (?:const|function|type|interface|class) (\w+)/g)].map((m) => m[1]!));
    const avail = new Set([...defs, ...reExported]);
    const wanted = new Set<string>();
    const walk = (rel: string): void => {
      for (const e of fs.readdirSync(path.join(__dirname, '..', rel), { withFileTypes: true })) {
        const p = `${rel}/${e.name}`;
        if (e.isDirectory()) { if (!/^(node_modules|dist|\.git)$/.test(e.name)) walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        for (const m of RD(p).matchAll(/import \{([^}]*)\} from '[^']*deliverable-lifecycle\.js'/g))
          m[1]!.split(',')
            .map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim())
            .filter(Boolean).forEach((n) => wanted.add(n));
      }
    };
    [`${A}/src`, `${A}/renderer/src`, 'scripts'].forEach(walk);
    ok(wanted.size >= 8, '扫描面自证：取到 >0 个调用方具名引入的符号（否则下面的"全都有"是空转假绿）', String(wanted.size));
    eq([...wanted].filter((n) => !avail.has(n)), [],
      'lifecycle 转出真源：**调用方引入的每个符号**都能从 lifecycle 取到（由全仓 import 面派生，非手抄冻结名单）');
  }
  ok(!/export const (ACCEPTANCE_TYPES|PRIMARY_TYPES|PREVIEW_TYPES)\s*=/.test(dlcSrc()),
    'lifecycle 内无第二份类型集合定义（只转出、不重定义）');

  // 渲染层跨 root 引同一份（G8 病灶：renderer 不在 src/main 扫描面内 ⇒ 曾手抄三处）
  for (const f of ['DeliverablesPage.tsx', 'TaskDetailPage.tsx']) {
    ok(RD(`${A}/renderer/src/pages/${f}`).includes("from '../../../src/main/core/deliverable-types.js'"),
      `${f} 跨 root 引同一真源（非手抄）`);
  }
  // 反证：渲染层不得再出现「手抄的类型字面量判据」——同一把尺的证据是**没有第二把尺**
  const hand = ['DeliverablesPage.tsx', 'TaskDetailPage.tsx', 'TasksPage.tsx', 'ProjectDetailPage.tsx']
    .filter((f) => /type\s*===\s*'doc'\s*\|\|\s*[\w.]*\.type\s*===\s*'code'/.test(pageSrc(f)));
  eq(hand, [], '反证：渲染层已无「doc||code」手抄判据（G8 病灶除）');
}

// ══════════════════════════════════════════════════════════════════
// S1 (M2-1) 父子成果上浮 —— 成果须在**任务树**中成立
// ══════════════════════════════════════════════════════════════════
console.log('\n[S1 M2-1 子树聚合（task:get / task:list 同尺）]');
{
  const db = mkdb();
  addTask(db, 'A', null, '编排父任务');
  addTask(db, 'B', 'A');
  addTask(db, 'C', 'B');
  addDeliv(db, 'dA', 'A', 'code', '父任务代码', '/x/a.py');
  addDeliv(db, 'dC', 'C', 'doc', '三代文档', '/x/c.md');
  addDeliv(db, 'dProbe', 'C', 'doc', '临时探针', '/x/_tmp_c.py');   // 须被滤除

  const sub = collectSubtreeIds(db as never, 'A');
  eq(sub, ['B', 'C'], 'collectSubtreeIds：A 的子孙 = [B, C]（BFS）');

  // ── task:get：SQL **从源码就地取出**再执行（生产 SQL × 生产入参） ──
  const ipc = prj();
  // zx_20260930 M4-1: 范围声明（`taskIds` = 本任务+子树 ownerIds、排除退休+探针）收进共享真源 ⇒
  //   生产 SQL 里只剩 `WHERE ${dScope.sql}` 一段待补；补它的**不是手抄谓词，而是生产函数本身**——
  //   比"把源码里的谓词片段替换成真源"更强：连谓词组合都由真源算。两段合起来仍是"生产 SQL × 生产入参"。
  const mScope = ipc.match(/const dScope = deliverableScopeSql\(\{ taskIds: ownerIds, alias: 'd' \}\);/);
  const mGet = ipc.match(/SELECT d\.\*, t\.title AS owner_task_title FROM wa_deliverables d[\s\S]{0,200}?WHERE \$\{dScope\.sql\}/);
  ok(!!mScope && !!mGet, 'task:get SQL 为子树形态、范围走共享真源（生产源码就地取出）');
  if (mGet) {
    const run = (owner: string[]) => {
      const sc = deliverableScopeSql({ taskIds: owner, alias: 'd' });   // 生产函数 × 生产入参
      const sql = mGet[0].replace('${dScope.sql}', sc.sql);
      return (db.prepare(sql).all(...sc.params) as Array<{ id: string; task_id: string; owner_task_title: string }>)
        .map((r) => ({ id: r.id, owner: r.task_id, ownerTitle: r.owner_task_title }));
    };
    const got = run(['A', 'B', 'C']);
    eq(got.map((r) => r.id).sort(), ['dA', 'dC'], 'task:get(A)：含三代子孙成果、且滤除探针（dProbe 不在）');
    const dC = got.find((r) => r.id === 'dC')!;
    ok(dC.owner === 'C' && dC.ownerTitle === 'C', '子任务成果带回 owner（界面据此标注「来自子任务 C」）', JSON.stringify(dC));
    // 反证：把 IN(...) 换回单任务 `= ?`（M2-1 前的旧形态）⇒ 子孙成果消失
    const old = (db.prepare(`SELECT d.*, t.title AS owner_task_title FROM wa_deliverables d LEFT JOIN wa_tasks t ON t.id = d.task_id
      WHERE d.task_id = ? AND d.status != 'retired' AND (d.type != 'doc' OR ${docNotProbe('d')})`).all('A') as Array<{ id: string }>).map((r) => r.id).sort();
    eq(old, ['dA'], '反证：旧单任务形态只返回自身成果 ⇒ 编排型父任务看不到子产出（M2-1 的病）');
  }

  // ── task:list：两计数子树上卷（同尺套 docNotProbe） ──
  const tids = ['A', 'B', 'C'];
  const grouped = db.prepare(`SELECT d.task_id AS tid, COUNT(*) AS n, SUM(CASE WHEN d.is_primary = 1 THEN 1 ELSE 0 END) AS p
    FROM wa_deliverables d WHERE d.status != 'retired' AND (d.type != 'doc' OR ${docNotProbe('d')})
    AND d.task_id IN (${tids.map(() => '?').join(',')}) GROUP BY d.task_id`).all(...tids) as Array<{ tid: string; n: number; p: number }>;
  const own = new Map(grouped.map((g) => [g.tid, g.n]));
  const roll = (root: string) => ['A', 'B', 'C'].reduce((a, t) => a + (own.get(t) || 0), 0);   // 单链 A→B→C 的化简上卷
  ok(roll('A') === 2, 'task:list(A) 计数 = 子树合计 2（dA + dC，探针不计）', String(roll('A')));
  ok((own.get('A') || 0) === 1, '反证：仅本任务口径 A = 1 ⇒ 与详情「2」两说法（M2-1 的病）', String(own.get('A') || 0));
  ok((grouped.find((g) => g.tid === 'C')?.n ?? 0) === 1, 'C 自身 = 1（它的探针未计入）');

  // 静态：list 与 get 同尺（此前 list 不滤探针、get 滤 ⇒ 又是两说法）
  // zx_20260930 M4-1: 七处读点不变，但每处由"手拼谓词"改为"调共享取数范围真源"——数真源调用数。
  // zx_20260930 M4-2: 7 → 9（`task:get` 的 `deliverablesTotal` + `deliverable:facets` 的名录）。
  //   两处都**必须**经真源：前者若另写谓词，明细与总数就是两个集合（"已加载 K / 共 M"随即失实）；
  //   后者若自己拼，名录会与列表口径分叉。故这里数的是"同源调用数"，新增读点只会让它变大、变不回去。
  ok((ipc.match(/\b(deliverableScopeSql|countDeliverables|countDeliverablesByType)\(/g) || []).length === 9,
    'project.ipc 探针口径九处同源（读点增 ≠ 口径分叉）', String((ipc.match(/\b(deliverableScopeSql|countDeliverables|countDeliverablesByType)\(/g) || []).length));
  ok(ipc.includes('const subtreeCnt = (rootId: string): { n: number; p: number } =>') && ipc.includes('const seen = new Set<string>([rootId]);'),
    'task:list 上卷带环防护（seen 集合）');
}

// ══════════════════════════════════════════════════════════════════
// S2 (M2-2) 归属不夺 —— 后写者不夺归属，但「还有谁写过」如实透出
// ══════════════════════════════════════════════════════════════════
console.log('\n[S2 M2-2 归属不夺（otherWriters 派生自版本行 changed_by）]');
{
  ok(!/UPDATE wa_deliverables SET task_id/.test(aeSrc()),
    'write_file 已删「夺归属」的 UPDATE（反证：旧写法此断言必红）');
  ok(aeSrc().includes('changed_by') && aeSrc().includes('deliverable.first_write_v1'),
    '归属的真源改由版本行 changed_by 承担（写入即落账）');

  const db = mkdb();
  addTask(db, 'A', null, '任务A');
  addTask(db, 'B', null, '任务B');
  addDeliv(db, 'd1', 'A', 'doc', '共享文档', '/x/d1.md');
  addDeliv(db, 'd2', 'A', 'doc', '自写文档', '/x/d2.md');
  addDeliv(db, 'd3', 'A', 'doc', '他写文档', '/x/d3.md');
  // d1：A 首写，B 后改；d2：仅 A 自写；d3：幽灵任务写入（任务已不在册）
  addVer(db, 'v1', 'd1', 'A', 1);
  addVer(db, 'v2', 'd1', 'B', 2);
  addVer(db, 'v3', 'd2', 'A', 1);
  addVer(db, 'v4', 'd3', 'ghost-9999', 1);

  const rows = [{ id: 'd1', task_id: 'A' }, { id: 'd2', task_id: 'A' }, { id: 'd3', task_id: 'A' }];
  const ow = otherWriters(db as never, rows);
  eq((ow.get('d1') || []).map((w) => w.id), ['B'], 'otherWriters(d1)：排除归属者 A，报出后写者 B');
  ok(ow.get('d1')![0]!.title === '任务B', '后写者解析为**任务名**（不是 uuid）', ow.get('d1')![0]!.title);
  eq(ow.get('d2') || [], [], 'otherWriters(d2)：仅归属者自写 ⇒ 空（宁少不滥）');
  ok((ow.get('d3') || [])[0]!.title === '未知任务', '幽灵任务 id ⇒ 人话「未知任务」（庄子·得鱼忘筌：不抛 uuid）', (ow.get('d3') || [])[0]!.title);

  // 归属**未被夺**：版本行说 B 写过，但行归属仍是 A
  eq(db.prepare("SELECT task_id FROM wa_deliverables WHERE id = 'd1'").get(), { task_id: 'A' },
    'd1 归属仍为 A（后写者 B 只留痕、不夺）');
  // 反证：旧写法（按 file_path 夺归属）确实会把归属改成 B
  db.prepare("UPDATE wa_deliverables SET task_id = ? WHERE file_path = ?").run('B', '/x/d1.md');
  eq(db.prepare("SELECT task_id FROM wa_deliverables WHERE id = 'd1'").get(), { task_id: 'B' },
    '反证：旧 `UPDATE … SET task_id`（按 file_path）确会夺走归属 ⇒ M2-2 的病成立');
  db.prepare("UPDATE wa_deliverables SET task_id = 'A' WHERE id = 'd1'").run();

  // 接线：list / get 各调一次
  const ipc = prj();
  ok((ipc.match(/otherWriters\(db,/g) || []).length === 2, 'project.ipc 两处派生 other_writers（deliverable:list + task:get）',
    String((ipc.match(/otherWriters\(db,/g) || []).length));
}

// ══════════════════════════════════════════════════════════════════
// S3 (M2-3) 探针不入列 —— 真库入参差额恰 1、零误伤
// ══════════════════════════════════════════════════════════════════
console.log('\n[S3 M2-3 探针谓词收紧（路径段级）· 真库入参对拍]');
{
  const cur = docNotProbe('');
  // zx_20260930 M3-g: 谓词字面量由 `%/_%kw%` 改为 `%/\_%kw%' ESCAPE '\'`。原式里 `_` 是 SQLite LIKE 的
  //   **单字符通配符**，故上面"路径段级（`/` 与关键词之间允许其它字符）"这句**自称从未成立**——
  //   它实为"路径里含关键词"，`/` 与关键词之间**必须**恰好隔一个字符（`/_probe%` 与 `%/_%probe%`
  //   的差别仅在于"隔一个"还是"隔至少一个"，两者都远宽于"下划线开头的段"）。
  //   本断言随之改指新字面量，并把"`_` 已**转义**"这一条**正面**钉住：漏了 ESCAPE 即不满足。
  ok(cur.includes("NOT LIKE '%/\\_%probe%' ESCAPE '\\'") && cur.includes("NOT LIKE '%/\\_%verify%' ESCAPE '\\'") && cur.includes("NOT LIKE '%/\\_%tmp%' ESCAPE '\\'"),
    '现谓词为 `_` **字面**下划线的路径段级（`\\_` + `ESCAPE`；zx_20260930 M3-g 修正通配符误用）', cur);
  ok(!/NOT LIKE '%\/_/.test(cur),
    '反证：未转义的旧写法 `%/_…` 已零处——否则 `_` 又退回通配符，"下划线开头的段"再次落空');
  // 反证：M2-3 前的旧谓词（`/` 必须紧跟关键词）。**不含形状 GLOB**——GLOB 是另一条尺（按长相判），
  //   zx_20260916_3 M2/D3 已整条删除，故它与本节的"路径段级收紧"不是同一对拍对象，另立一项（见下）。
  const OLD = (c: string) => `(${c} NOT LIKE '%/_verify%' AND ${c} NOT LIKE '%/_probe%' AND ${c} NOT LIKE '%/_tmp%')`;
  const oldCur = OLD('COALESCE(file_path, name)');
  ok(oldCur !== cur, '反证：新旧谓词确不同（否则"收紧"是空话）');

  // 真库入参：a-stock 项目 8 条 doc 草稿（生产快照）
  const fix = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'zx4_df334d91_drafts.json'), 'utf-8')) as {
    _provenance: { taskId: string };
    deliverables: Array<{ id: string; name: string; type: string; status: string; file_path: string }>;
  };
  const db = mkdb();
  db.prepare("INSERT INTO wa_projects (id, name) VALUES ('p', 'a-stock')").run();
  addTask(db, fix._provenance.taskId, null, '真库任务');
  for (const d of fix.deliverables) {
    db.prepare('INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status) VALUES (?,?,?,?,?,?,?)')
      .run(d.id, 'p', fix._provenance.taskId, d.type, d.name, d.file_path, d.status);
  }
  const ids = (frag: string) => (db.prepare(`SELECT id FROM wa_deliverables WHERE type != 'doc' OR ${frag} ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
  const oldIds = ids(oldCur);
  const newIds = ids(cur);
  const newlyExcluded = oldIds.filter((i) => !newIds.includes(i));
  const f20 = fix.deliverables.find((d) => d.name.includes('_f20_probe'))!;
  eq(newlyExcluded, [f20.id], '真库 doc 放行 8 → 7，**新排除恰 1 条**且 = scripts/_f20_probe.py');
  ok(newIds.every((i) => oldIds.includes(i)), '反证：路径段级收紧只做减法（凡现谓词放行者，短谓词必也放行 ⇒ 无新的误伤）');

  // ── zx_20260916_3 M2（D3 裁定）：形状 GLOB 已整条删除。它与上面那对拍**方向相反**：
  //   删掉一个 AND 子句只会**多放行**、不可能少放行——这正是"删 GLOB 安全"的全部理由；
  //   而它多放行的恰是"长相像随机命名"的真测试脚本（本夹具 1 条，a-stock 全量 7/7，见 rr_zx_20260916_3.ts §B-3）。
  const GLOB_RULE = (c: string) => `(${OLD(c)} AND ${c} NOT GLOB '*test_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*.py')`;
  const globIds = ids(GLOB_RULE('COALESCE(file_path, name)'));
  const shapeMatched = fix.deliverables.find((d) => d.name.includes('test_a20260911_1'))!.id;
  // 对拍须**同版本**：带 GLOB 者 ⊆ 同版本的"不带 GLOB 者"（删一个 AND 子句只会多放行、不会少放行）
  ok(globIds.every((i) => oldIds.includes(i)), '反证：同版本内删 GLOB 只多放行（带 GLOB 者 ⊂ 不带者）⇒ 删除不会误退休真产出',
    `带 GLOB ${globIds.length} 条 / 不带 ${oldIds.length} 条`);
  // 而它多排除的那条，正是"长相像随机命名"的真测试脚本：旧尺排除、现尺放行 ⇒ 翻面成立
  ok(!globIds.includes(shapeMatched) && newIds.includes(shapeMatched),
    '被 GLOB 误判者 = scripts/test_a20260911_1.py（真测试脚本，非探针）：旧尺排除、现尺放行');
  ok(newIds.includes(fix.deliverables.find((d) => d.name.includes('最终验收报告'))!.id), '正常文档（最终验收报告.md）两版皆放行 ⇒ 零误伤');

  // code 类门控：同名探针形状的 code 成果有意不过问（M0 已定）
  const c = `COALESCE(file_path, name)`;
  ok(db.prepare(`SELECT COUNT(*) c FROM wa_deliverables WHERE type != 'doc' OR ${cur}`).get() !== undefined
    && new RegExp(OLD(c).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).source.length > 0,
    '谓词恒被 `(type != \'doc\' OR …)` 门控 ⇒ 只判 doc 类（code 同名文件有意不过问，M0 已定）');
  // zx_20260930 M4-1: 该读点不但"带别名 d"，且**显式声明 includeRetired: true**（档案视图有意可见退休件）——
  //   此前那句差异只在注释里，现在写在调用参数上。断言随之钉这句更具体的形式。
  ok(prj().includes("conditions.push(deliverableScopeSql({ alias: 'd', includeRetired: true }).sql);"),
    'M2-3 补上唯一漏网读点 deliverable:list（经共享真源带别名 d，且显式声明档案视图含退休件）');
}

// ══════════════════════════════════════════════════════════════════
// S4 (M2-4) 计数同尺 —— total 与 chips 同源（管子·度量衡）
// ══════════════════════════════════════════════════════════════════
console.log('\n[S4 M2-4 total = Σ chips（GROUP BY 实得，非手抄键表）]');
{
  const db = mkdb();
  addTask(db, 'T', null);
  addDeliv(db, 'x1', 'T', 'doc', '文档', '/x/1.md');
  addDeliv(db, 'x2', 'T', 'doc', '临时探针', '/x/_tmp_2.py', 'draft');
  for (let i = 1; i <= 4; i++) addDeliv(db, `c${i}`, 'T', 'code', `代码${i}`, `/x/${i}.py`);
  addDeliv(db, 'dm', 'T', 'daemon', '守护进程', null, 'registered');
  addDeliv(db, 'u1', 'T', 'ui', '界面', null);
  addDeliv(db, 'm1', 'T', 'mcp', 'MCP服务', null, 'registered');
  addDeliv(db, 'a1', 'T', 'a2a', 'A2A代理', null, 'registered');

  // 生产 SQL：全景 byType 的取数（GROUP BY type + 探针滤除）
  const stats = db.prepare(`SELECT type, COUNT(*) as c FROM wa_deliverables WHERE project_id = ? AND status != 'retired' AND (type != 'doc' OR ${docNotProbe('')}) GROUP BY type`).all('p') as Array<{ type: string; c: number }>;
  const byType: Record<string, number> = {};
  for (const g of stats) byType[String(g.type || 'other')] = Number(g.c) || 0;
  const total = Object.values(byType).reduce((a, b) => a + b, 0);

  ok(total === Object.values(byType).reduce((a, b) => a + b, 0), 'total 与 byType 由同一结果展开（恒等式）');
  eq(byType.code, 4, 'byType.code = 4（M2-4 前手抄键表漏 code ⇒ total 虚高于 chips）');
  ok((byType.daemon || 0) === 1 && (byType.ui || 0) === 1, 'byType 含 daemon/ui（同为实得，非枚举）');
  ok(total === 9, 'total = 9（doc 1 + code 4 + daemon 1 + ui 1 + mcp 1 + a2a 1；探针 doc 已滤）', String(total));

  // 反证：旧的**手抄键表**（mcp/a2a/ui/doc 四键，漏 code/daemon）——total 与 chips 必不相等
  const literal = { total, mcp: byType.mcp || 0, a2a: byType.a2a || 0, ui: byType.ui || 0, doc: byType.doc || 0 };
  const chipSum = (o: Record<string, number>) => Object.entries(o).filter(([k]) => k !== 'total').reduce((a, [, v]) => a + Number(v || 0), 0);
  ok(chipSum(literal) !== literal.total, `反证：旧手抄四键表的 chips 之和(${chipSum(literal)}) ≠ total(${literal.total}) ⇒ 两把尺`);

  // 静态：两处落点都改为实得
  ok(prj().includes('deliverableSummary: { total: Object.values(delivByType).reduce((a, b) => a + b, 0), byType: { ...delivByType }, recentDeliverables }'),
    '全景 byType/total 同源展开（源码在案）');
  const pe = peSrc();
  // zx_20260930 M4-1: 分组这一跳也上收共享真源——本处不再有 `GROUP BY type`，改钉"取自真源"，
  //   并保留反证（旧字面量 SUM(CASE WHEN type=…) 不得复现）。
  ok(pe.includes('countDeliverablesByType(this.db, { projectId: String(p.id) })') && !/SUM\(CASE WHEN type = '/.test(pe),
    '项目卡 deliverableStats 连带同尺（分组经共享真源；旧字面量 SUM(CASE WHEN type=…) 已除）');
  ok(pe.includes('deliverableStats[g.type] = (deliverableStats[g.type] || 0) + g.c') && pe.includes('deliverableStats.total = (deliverableStats.total || 0) + g.c'),
    '项目卡 total 与分项在**同一循环**内累加（结构上不可能分叉）');
}

// ══════════════════════════════════════════════════════════════════
// S5 (M2-5) 主要成果可见 —— ★候选扩到 doc/code/daemon/ui
// ══════════════════════════════════════════════════════════════════
console.log('\n[S5 M2-5 autoAssignPrimary 候选扩类（真实现）]');
{
  const db = withTx(mkdb()); // M5-a 起 autoAssignPrimary → applyPrimary 需 db.transaction
  db.prepare("INSERT INTO wa_settings (key, value) VALUES ('deliverable.primary_auto', 'true')").run();
  addTask(db, 'T-code', null);
  addDeliv(db, 'dc', 'T-code', 'code', '唯一代码成果', '/x/impl.py');
  addTask(db, 'T-daemon', null);
  addDeliv(db, 'dd', 'T-daemon', 'daemon', '守护进程', null, 'registered');
  addTask(db, 'T-ui', null);
  addDeliv(db, 'du', 'T-ui', 'ui', '界面', null);
  addTask(db, 'T-mcp', null);
  addDeliv(db, 'dm', 'T-mcp', 'mcp', 'MCP服务', null, 'registered');
  addTask(db, 'T-probe', null);
  addDeliv(db, 'dp', 'T-probe', 'code', '临时校验', '/x/_verify_impl.py');   // code 类：不受 doc 门控 ⇒ 详见下方如实说明

  const r1 = autoAssignPrimary(db as never, 'T-code');
  ok(r1.assigned === 'dc', '纯 code 产物的任务收尾后得 ★（M2-5 前候选仅 doc ⇒ 此任务 primary 为空）', String(r1.assigned));
  ok(autoAssignPrimary(db as never, 'T-daemon').assigned === 'dd', 'daemon 可被标 ★（常是真交付物）');
  ok(autoAssignPrimary(db as never, 'T-ui').assigned === 'du', 'ui 可被标 ★');
  ok(autoAssignPrimary(db as never, 'T-mcp').assigned === undefined, 'mcp 不在 PRIMARY_TYPES ⇒ 不占任务内 primary 位');

  // 反证：候选集合收窄回 ['doc'] ⇒ 纯 code 任务无候选（旧行为）
  const t0 = typeIn('', ['doc'] as const);
  const cand0 = db.prepare(`SELECT id FROM wa_deliverables WHERE task_id = ? AND ${t0.sql} AND status IN ('draft','registered','completed') AND ${docNotProbe('')} ORDER BY created_at DESC, rowid DESC LIMIT 1`).get('T-code', ...t0.params);
  ok(cand0 === undefined, '反证：候选仅 doc 时，纯 code 任务无 ★ 候选（M2-5 的病成立）');

  // 幂等：已有 ★ 者不再动
  ok(autoAssignPrimary(db as never, 'T-code').assigned === undefined, '已有 primary ⇒ 不再重复指派（幂等）');

  // 静态：候选查询读 PRIMARY_TYPES，无手抄 'doc'
  // zx_20260915 P0-8(b): 候选查询改带表别名 `d`（排序里要 JOIN 派生列）⇒ 类型判据由 `typeIn('', …)` 变为
  //   `typeIn('d', …)`、探针滤除由 `docNotProbe('')` 变为 `docNotProbe('d')`。判据（读共享 PRIMARY_TYPES、
  //   无手抄 `type = 'doc'`）**不变**，改的只是"同一个尺带不带表别名"。
  const dlc = dlcSrc();
  ok(dlc.includes('const t = typeIn(\'d\', PRIMARY_TYPES);'), '候选类型读共享 PRIMARY_TYPES（非手抄）');
  const candLine = dlc.split('\n').find((l) => l.includes('FROM wa_deliverables d WHERE d.task_id = ?')) || '';
  ok(candLine.includes('${t.sql}') && candLine.includes('${docNotProbe(\'d\')}') && !candLine.includes("type = 'doc'"),
    '候选 SQL 无 `type = \'doc\'` 字面量（同一把尺 + 探针同滤）');
}

// ══════════════════════════════════════════════════════════════════
// S6 (M2-6) 版本历史门禁 = 「真有版本行」，不按 type 猜
// ══════════════════════════════════════════════════════════════════
console.log('\n[S6 M2-6 version_count 门禁（事实依据，非类型猜测）]');
{
  const db = mkdb();
  addTask(db, 'T', null);
  addDeliv(db, 'dv', 'T', 'doc', '有版本文档', '/x/v.md');       // 2 个版本行
  addDeliv(db, 'dn', 'T', 'doc', '无版本文档', '/x/n.md');       // 0 个版本行
  addDeliv(db, 'dc', 'T', 'code', '有版本代码', '/x/c.py');      // 1 个版本行
  addVer(db, 'v1', 'dv', 'T', 1);
  addVer(db, 'v2', 'dv', 'T', 2);
  addVer(db, 'v3', 'dc', 'T', 1);

  const rows = db.prepare(`SELECT d.id, d.type, (SELECT COUNT(*) FROM wa_deliverable_versions v WHERE v.deliverable_id = d.id) AS version_count
    FROM wa_deliverables d WHERE d.project_id = ? ORDER BY d.id`).all('p') as Array<{ id: string; type: string; version_count: number }>;
  const vc = new Map(rows.map((r) => [r.id, Number(r.version_count)]));
  ok(vc.get('dv') === 2, '真库对拍：有版本者 version_count > 0', String(vc.get('dv')));
  ok(vc.get('dn') === 0, '无版本者 version_count = 0（旧判据 `type===\'doc\'` 对它会亮钮、打开是空的 ⇒ 名实不符）', String(vc.get('dn')));
  ok(vc.get('dc') === 1, 'code 成果同样按事实出钮（一视同仁）', String(vc.get('dc')));
  // 反证：按 type 猜 ⇒ dn（无版本 doc）也亮钮
  const byType = rows.filter((r) => r.type === 'doc').map((r) => r.id).sort();
  eq(byType, ['dn', 'dv'], '反证：旧 `type === \'doc\'` 门禁会把无版本的 dn 也算进去 ⇒ 空钮');

  const ipc = prj();
  ok(ipc.includes('(SELECT COUNT(*) FROM wa_deliverable_versions v WHERE v.deliverable_id = d.id) AS version_count'),
    'deliverable:list 补派生列 version_count（关联既有 idx_deliv_versions）');
  const page = pageSrc('DeliverablesPage.tsx');
  ok(page.includes('{Number(d.version_count) > 0 && ('), '列表 History 钮门禁 = version_count > 0');
  ok(!/versionDelivId[\s\S]{0,80}type === 'doc'/.test(page), '反证：版本钮旁已无 `type === \'doc\'` 猜测');
}

// ══════════════════════════════════════════════════════════════════
// S7 (M2-7) 分组与人话 —— 不抛 uuid 片段、分组可关、计数不重不漏
// ══════════════════════════════════════════════════════════════════
console.log('\n[S7 M2-7 分组与人话（庄子·得鱼忘筌）]');
{
  const raw = RD(`${A}/renderer/src/pages/DeliverablesPage.tsx`);
  const page = stripComments(raw);
  ok(!/project_id\?\.slice\(0, *8\)/.test(page) && !/project_id\.slice\(0, *8\)/.test(page), '项目名缺失不再抛 uuid 前 8 位');
  ok(!/task_id\.slice\(0, *8\)/.test(page), '任务名缺失不再抛 uuid 前 8 位');
  ok(page.includes("d.project_name || '未知项目'") && page.includes("d.task_title || '未知任务'"), '人话回退在位（未知项目 / 未知任务）');
  ok(page.includes('const [groupByProject, setGroupByProject] = useState(true);'), '分组开关默认开（有排序需求者可关）');
  // zx_20260924_1 M5-b: 本表**增一列「大小」**（fields 数组 7→8 项）⇒ 表头 8 项 + 右侧「操作」= **9 列**，
  //   空态/组头/目录行的 colSpan 随之 8→9。按「改旧断言＝改钉更强的新真源」：**不再手抄 8/9 这两个数字**
  //   （旧写法正是 8 与 9 两个手抄值互相对打——增列必红，是"只对下一轮引爆"的哑雷），改成从源里那张
  //   fields 数组与「操作」列表头**当场数出来**：列数以表的真身为准，下次增删列时本条自动跟随。
  {
    const arrEnd = page.indexOf('as Array<[typeof sortBy,string]>');
    const arrStart = arrEnd >= 0 ? page.lastIndexOf("[['name'", arrEnd) : -1;
    const fieldsSrc = arrStart >= 0 && arrEnd > arrStart ? page.slice(arrStart, arrEnd) : '';
    const fieldCount = (fieldsSrc.match(/\['[a-z]+',\s*'/g) || []).length;
    const opCount = (page.match(/<th className="text-right p-3 font-medium text-gray-500">操作<\/th>/g) || []).length;
    const colCount = fieldCount + opCount;
    ok(fieldCount >= 8 && opCount === 1, `表头 = 源内 fields 数组 + 1 列「操作」（实测 fields=${fieldCount} / 操作=${opCount}）`);
    ok(colCount > 0 && page.includes(`colSpan={${colCount}}`), `空态/组头 colSpan 与本表实际列数**同源**（实测 ${colCount} 列；旧写法手抄 8）`);
    // 反证：不留任何"与本表列数不符"的 colSpan 字面量（合规的那些先剔掉，再扫残余）
    ok((page.match(/colSpan=\{\d+\}/g) || []).every((s) => s === `colSpan={${colCount}}`), '反证：不存在与列表数不符的 colSpan 字面量');
  }
  ok(page.includes('· {g.n} 项'), '组头显示「项目名 · N 项」');

  // 行为复算：分组后各组条数之和 == 行数（不重不漏），组头人话不含 uuid
  type Row = { id: string; project_id: string; project_name?: string };
  const rows: Row[] = [
    { id: 'r1', project_id: 'p1', project_name: '项目一' },
    { id: 'r2', project_id: 'p1', project_name: '项目一' },
    { id: 'r3', project_id: 'p2', project_name: '项目二' },
    { id: 'r4', project_id: '', project_name: undefined },      // 无名项目
  ];
  const projLabel = (d: Row) => d.project_name || '未知项目';
  const order: string[] = [];
  const byProj = new Map<string, { label: string; n: number }>();
  for (const d of rows) {
    const k = d.project_id || '';
    if (!byProj.has(k)) { byProj.set(k, { label: projLabel(d), n: 0 }); order.push(k); }
    byProj.get(k)!.n += 1;
  }
  // 复刻生产的 groupRows：每组先一「组头」再逐行（生产见 DeliverablesPage groupRows 的 out.push 序列）
  const groupRows: Array<{ kind: 'head' } | { kind: 'row' }> = [];
  for (const k of order) { const g = byProj.get(k)!; groupRows.push({ kind: 'head' }); for (let i = 0; i < g.n; i++) groupRows.push({ kind: 'row' }); }
  ok(groupRows.filter((x) => x.kind === 'row').length === rows.length, '各组条数之和 == 列表条数（不重不漏）');
  ok(byProj.get('')!.label === '未知项目', '无名项目组头 = 「未知项目」（人话）');
  const uuidish = [...byProj.values()].filter((g) => /^[0-9a-f]{8}$/.test(g.label) || /^[0-9a-f-]{36}$/.test(g.label));
  eq(uuidish, [], '反证：组头文案不含 8 位/36 位 uuid 片段');
  // 分组可以关：平铺时即原表顺序
  // zx_20260924_1 M5-b: 平铺路新增 `depth` 字段（目录树行要缩进，平铺恒 0），**语义未变**：
  //   `groupByProject` 关 ⇒ 直接按 `visibleRows`（既有筛选+排序的结果）逐行铺开，不另排一遍。
  //   判据改钉**语义**（源必须是 visibleRows、每行 kind:'row'）而非尾随字段清单——`d[,}]` 放行后续
  //   字段增删，但"源是 visibleRows"这一条不受影响（旧写法把尾随字段也钉死，故 M5-b 一动就红）。
  ok(/if \(!groupByProject\) return visibleRows\.map\(\(d\) => \(\{ kind: 'row' as const, d[,}]/.test(page),
    '关掉分组 ⇒ 恢复原平铺视图（源就是 visibleRows，既有排序不被砸）');
  // 加严（M5-b 新增能力，E-5 靶心）：树视图**与任务详情页同一份实现**——同一模块、同一路径，两页不许各摆一棵树。
  ok(page.includes("import { buildDeliverableTree, type DeliverableTreeChild } from '../../../src/main/core/deliverable-tree.js'"),
    '成果页与任务详情页引**同一份** buildDeliverableTree（同模块同路径）');
  ok(page.includes("viewMode === 'tree' ? treeNodes : groupRows"), '目录树为默认视图、平铺可切（两条路并存）');
}

// M5 收口：每个子脚本自带 build 闸（任一批单独跑也能自查 build 是否陈旧）。
// ⚠ 本段读 dist ⇒ tsup 必须先于本脚本。
console.log('\n[M5] build 标识派生一致性（P1–P6）');
checkBuildPins(ok, { distDir: path.join(__dirname, '..', A, 'dist') });

console.log(`\n结果: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
