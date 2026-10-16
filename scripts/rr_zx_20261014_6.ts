/**
 * zx_20261014_6 受控复跑 —— 「自知」：任务要认得**自己**做过的。
 *
 * 由来（2026-10-14 对某项目「20260924 规划方案实施」`7c39678e` 的复盘）：三个**一次都没跑过**的子任务
 *   （0 step 事件 / 0 自有产出物 / 0 自有会话）被标 completed，且**没有被任何诚实提示拦下**——
 *   因为完成闸的「有无产出」读的是**整棵树（含祖先）**，父名下那 69 条产出物替它们答了「有产出」。
 *
 * 本轮口径一句话（道德经·自知者明 ／ 维特根斯坦·意义即用法 ／ 毛选·实事求是）：
 *   「这棵树交出过东西吗」（判卷/偏离三消费者的**门槛**）与「**这个任务自己**交出过东西吗」（完成闸）
 *   是**两个问题**；同一函数不得被借去答两遍。完成闸的产出读面收为「本任务 ∪ 后代」（**不含祖先**）。
 *
 * 治法：
 *   ① `agent-executor.ts` 新增 `taskOwnTreeIds`（自身∪后代，不含祖先）；`realDeliverables` 增 `scope`
 *      形参（缺省 `'tree'` 保三消费者逐字不变，`'own'` 供完成闸）；`realOutputEvidence` 第一支走 `'own'`。
 *   ② `tools/control.ts`：`neverRan` 提到 `if (!hasOut)` **之外**无条件算出；提示条件改 `!hasOut || neverRan`；
 *      `auto_completed_without_output` 标记与 `via:'…:no_output'` 仍**只在 `!hasOut`**（`neverRan ∧ hasOut` 只落提示）。
 *   ③ `pause-settlement.ts` `settlePause(clear=true)` 与 `awaiting_input` **同收口**删 `pending_approval`；
 *      `clear=false` 逐字不变。`ipc/project.ipc.ts` `tasks:mainIssue` 判据改用真源 `awaiting_input`。
 *   ④ `task-accounting.ts` 订正陈旧注释（旧称"闸只在 create_task 一家"，实为 **8 处全在闸内**）。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：T/O/C/P 组直引生产 `taskOwnTreeIds`/`realDeliverables`/`realOutputEvidence`/
 *       `buildTools`/`settlePause`（被删/改名即编译期失败）。
 *   G-2 **两侧标本**：0→1 正面断言必配**反证**（缺祖先那一支、含后代那一支、只落提示不误标那一支）。
 *   G-6 **无轮次字面量**：本轮方案路径/脚本名由 `path.basename(__filename)` 派生（末尾 S 组自检）。
 *   ⚠ 夹具 DDL 逐列照抄 `database.ts`（含 ALTER 补列 `is_primary`/`acceptance_verified`）——不写"比生产宽松"的简化版。
 *   ⚠ 静态判据**按符号**切片（不按行号）；"接线在册"读原文、"用户可见文案"读去注释后的代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：读投影/闸门真源**静态导入**（被删/改名即编译期失败，而非"扫个空、静默假绿"）。
import {
  taskTreeIds, taskOwnTreeIds, realDeliverables, realOutputEvidence, hasRealDeliverable, buildTools,
} from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { settlePause } from '../apps/worker-ant-desktop/src/main/core/pause-settlement.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 等值断言（把实际值一并打出——红时立刻看得出差在哪）。 */
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 判"用户可见文案/调用形状"读去注释后的代码；判"接线在册"读原文。 */
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261014_6

/* ── 夹具 schema：逐列照抄 database.ts DDL（含 ALTER 补列），既不缺列也不放宽 NOT NULL ── */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', parent_task_id TEXT DEFAULT '',
  title TEXT DEFAULT '', description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0,
  context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '', source TEXT DEFAULT 'test',
  acceptance_criteria TEXT DEFAULT '', quality_score REAL, aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL,
  name TEXT DEFAULT '', description TEXT DEFAULT '', file_path TEXT, registry_id TEXT,
  status TEXT DEFAULT 'draft', is_primary INTEGER DEFAULT 0, acceptance_verified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_plan_milestones (id TEXT PRIMARY KEY, project_id TEXT, plan_task_id TEXT NOT NULL,
  milestone TEXT NOT NULL, status TEXT DEFAULT 'pending', implemented_by_task_id TEXT,
  updated_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_wa_plan_milestones_uniq ON wa_plan_milestones(plan_task_id, milestone);
CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT DEFAULT '{}', occurred_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, error TEXT,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT DEFAULT '', status TEXT);
CREATE TABLE wa_im_conversations (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT,
  message_json TEXT, direction TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_notify_log (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '',
  kind TEXT NOT NULL, suppressed INTEGER DEFAULT 0, at INTEGER NOT NULL);
`;
type AnyDb = import('better-sqlite3').Database;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };

/** 落一个任务（走裸 INSERT —— 本投影/闸门只读，无生产写口可借）。 */
const addTask = (db: AnyDb, id: string, status: string, opts: { parent?: string; ctx?: Record<string, unknown> } = {}): void => {
  db.prepare(`INSERT INTO wa_tasks (id, project_id, parent_task_id, title, status, source, context_json)
              VALUES (?, 'p', ?, ?, ?, 'test', ?)`)
    .run(id, opts.parent ?? '', id, status, JSON.stringify(opts.ctx ?? {}));
};
/** `ui`/`registered` 是**服务类**产出物：`isRealDeliverableRow` 认它（无需落盘文件 ⇒ 夹具无需碰磁盘）。 */
const addSvcDeliv = (db: AnyDb, id: string, taskId: string): void => {
  db.prepare(`INSERT INTO wa_deliverables (id, project_id, task_id, type, name, status, is_primary, acceptance_verified)
              VALUES (?, 'p', ?, 'ui', ?, 'registered', 0, 0)`).run(id, taskId, id);
};
const addStepEvent = (db: AnyDb, taskId: string): void => {
  db.prepare(`INSERT INTO wa_event_log (event_id, event_type, aggregate_type, aggregate_id, payload, occurred_at)
              VALUES (?, 'task.step_finished', 'task', ?, '{}', datetime('now'))`).run(crypto.randomUUID(), taskId);
};
const ctxObj = (db: AnyDb, id: string): Record<string, unknown> =>
  JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}');
const sysConvs = (db: AnyDb, id: string): Array<{ content: string }> =>
  db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'system'").all(id) as Array<{ content: string }>;

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx16-'));

async function main(): Promise<void> {
  // ═══ T｜取数面（批一 M1：`taskOwnTreeIds` 不含祖先；`realDeliverables(scope)` 两把尺）══════════════
  console.log('\n【T】取数面 —— 「本任务∪后代」vs「整棵树」（道德经·自知者明 / 维特根斯坦·意义即用法）');
  {
    const db = mkdb();
    addTask(db, 'p', 'executing');
    addTask(db, 'c', 'pending', { parent: 'p' });
    addSvcDeliv(db, 'd-parent', 'p'); // 父有 1 条产出物；子 0 条、0 后代

    // ── T-1 ★★两集合都在场、可对照：ownTree 不含父，tree 含父（本轮修复的靶心）───────────────
    eq(taskOwnTreeIds(db, 'c').includes('p'), false,
      'T-1a ★★`taskOwnTreeIds(child)` **不含父**（完成闸的读面）');
    eq(taskTreeIds(db, 'c').includes('p'), true,
      'T-1b ★反证：`taskTreeIds(child)` **含父**（判卷/偏离三消费者的读面，未被改窄）');

    // ── T-2 自身恒在（两集合都含起点的任务自身）──────────────────────────────────────
    eq(taskOwnTreeIds(db, 'c').includes('c') && taskTreeIds(db, 'c').includes('c'), true,
      'T-2a 两集合都含**自身**（收窄只砍祖先，不砍起点）');
    eq([...taskOwnTreeIds(db, 'c')].sort(), ['c'],
      'T-2b 无后代 ⇒ `ownTree` 恰 `[自身]`');

    // ── T-3 后代仍被纳入（own 面「∪ 后代」，只砍祖先）──────────────────────────────────
    addTask(db, 'c2', 'pending', { parent: 'c' }); // c 的儿子
    eq(taskOwnTreeIds(db, 'c').includes('c2'), true,
      'T-3 ★后代（子之孙）**仍在** `ownTree` 内——收窄只作用于**祖先**一支');
  }

  // ═══ O｜完成闸读面（批一 M1：0→1 正面 + 反证 + 后代传染）════════════════════════════════
  console.log('\n【O】完成闸读面 —— `realOutputEvidence` 走 `own`（毛选·实事求是：不许拿父的账替自己说话）');
  {
    // ── O-1 ★★0→1 正面：子 0 行、父 1 行 ⇒ 完成闸判「**无**产出」（本轮修复的靶心）──────────
    const db = mkdb();
    addTask(db, 'p', 'executing');
    addTask(db, 'c', 'pending', { parent: 'p' });
    addSvcDeliv(db, 'd-parent', 'p');
    eq(realOutputEvidence(db, 'c'), false,
      'O-1 ★★子任务自有产出物 0 行、**父**有 1 行 ⇒ `realOutputEvidence(child) === false`（祖先的产出不算它的）');
    eq(hasRealDeliverable(db, 'c'), true,
      'O-1b ★反证（判卷口径未被改窄）：`hasRealDeliverable(child)` 走缺省 `tree` 面，**仍看得见父那 1 行**');
    eq(realDeliverables(db, 'c').length, 1,
      'O-1c 缺省 `realDeliverables(child)` ⇒ 1 行（缺省值保证三消费者逐字不变）');
    eq(realDeliverables(db, 'c', 'own').length, 0,
      'O-1d 显式 `own` ⇒ 0 行（完成闸的读面，两把尺同场可对照）');

    // ── O-2 自身有产出 ⇒ 完成闸判「有产出」（收窄不得误伤"真交过东西"的任务）─────────────
    addSvcDeliv(db, 'd-self', 'c');
    eq(realOutputEvidence(db, 'c'), true, 'O-2 ★自身有产出 ⇒ 完成闸判「有产出」（反证 O-1 非恒假）');

    // ── O-3 ★★后代传染：子 0 行、**孙** 1 行 ⇒ 完成闸判「有产出」（收窄只砍祖先、不砍后代）──
    const db3 = mkdb();
    addTask(db3, 'p', 'executing');
    addTask(db3, 'c', 'pending', { parent: 'p' });
    addTask(db3, 'g', 'pending', { parent: 'c' });
    addSvcDeliv(db3, 'd-parent', 'p'); // 父有产出——**不得**传染给 c
    addSvcDeliv(db3, 'd-grand', 'g');  // 孙有产出——**应当**算作 c 的（分工）
    eq(realOutputEvidence(db3, 'c'), true,
      'O-3 ★★子 0 行、孙 1 行 ⇒ 完成闸判「有产出」（"爸爸派给儿子、儿子交出的活"算自己的）');
    eq(realOutputEvidence(db3, 'p'), true, 'O-3b 父自身/后代有产出 ⇒ 同样为真');
  }

  // ═══ C｜完成闸上屏（批一 M2：neverRan 独立判据；只落提示不误标）════════════════════════════
  console.log('\n【C】`update_task_status` 上屏 —— `neverRan` 是**独立事实**（毛选·实事求是）');
  {
    const call = async (db: AnyDb, target: string): Promise<string> => {
      const tools = buildTools({ db } as never, 'caller-task', 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
      return tools.update_task_status!.execute({ targetTaskId: target, status: 'completed' });
    };

    // ── C-1 ★★本轮靶心：0 step 事件 + **父有产出** ⇒ 必落 `[未过成果门禁]` 系统行，取「未执行过任何一步」文案 ──
    const db = mkdb();
    addTask(db, 'p', 'executing');
    addTask(db, 'c', 'pending', { parent: 'p' });
    addSvcDeliv(db, 'd-parent', 'p'); // 父有产出；c 无 step 事件、无自有产出
    const r = await call(db, 'c');
    const cs = sysConvs(db, 'c');
    eq(cs.length, 1, 'C-1a ★★**0 step 事件 + 父有产出** ⇒ 系统会话行 **0→1**（修复前：父的产出替它答"有产出"⇒ 整段被跳过）');
    ok(cs[0]!.content.includes('未执行过任何一步'),
      'C-1b ★★文案取「未执行过任何一步」一支（"压根没执行" ≠ "跑而无产出"，两态可区分）');
    eq(ctxObj(db, 'c').auto_completed_without_output, true,
      'C-1c 该子任务自有产出为 0（`own` 面）⇒ 打标 `auto_completed_without_output`（无产出才叫"未经成果门禁"）');
    ok(!r.includes('error'), 'C-1d 「不硬拦」裁定未推翻：无产出亦可经本工具标完成（返回成功）');

    // ── C-2 ★★`neverRan ∧ hasOut` ⇒ **只落提示、不误标"无产出"**（M2 的分界）────────────────
    const db2 = mkdb();
    addTask(db2, 's', 'executing');
    addSvcDeliv(db2, 'd-own', 's'); // s **自己有**产出，但全生命周期 0 step 事件
    await call(db2, 's');
    const cs2 = sysConvs(db2, 's');
    eq(cs2.length, 1, 'C-2a ★`neverRan ∧ hasOut` ⇒ 提示仍 0→1（neverRan 是独立判据，未被嵌进 `!hasOut`）');
    ok(cs2[0]!.content.includes('未执行过任何一步'),
      'C-2b 且文案取「未执行过任何一步」（neverRan 优先于"无产出"一支）');
    ok(!('auto_completed_without_output' in ctxObj(db2, 's')),
      'C-2c ★★**不误标**：有产出却零 step ⇒ **不**落 `auto_completed_without_output`（打标仍只在 `!hasOut`）');
    eq((ctxObj(db2, 's').completion_quality as { via?: string } | undefined)?.via, 'update_task_status',
      'C-2d ★且 `completion_quality.via` **未**被改写为 `…:no_output`（记账不被替它改）');

    // ── C-3 跑了却无产出（有 step 事件、无产出）⇒ 取**另一支**文案（两态不可混）──────────────
    const db3 = mkdb();
    addTask(db3, 'ran', 'executing');
    addStepEvent(db3, 'ran');
    await call(db3, 'ran');
    const cs3 = sysConvs(db3, 'ran');
    eq(cs3.length, 1, 'C-3a 有 step 事件、无产出 ⇒ 系统会话行 0→1');
    ok(cs3[0]!.content.includes('无任何真实产出证据') && !cs3[0]!.content.includes('未执行过任何一步'),
      'C-3b ★文案取「无任何真实产出证据」（跑了却无产出）——与 C-1「未执行过」是**两句话**');

    // ── C-4 有产出又有 step 事件 ⇒ 不刷任何提示（不误报）──────────────────────────────
    const db4 = mkdb();
    addTask(db4, 'ok', 'executing');
    addSvcDeliv(db4, 'd-ok', 'ok');
    addStepEvent(db4, 'ok');
    await call(db4, 'ok');
    eq(sysConvs(db4, 'ok').length, 0, 'C-4 有产出 + 有 step 事件 ⇒ 系统会话行 **0 行**（不误报）');
  }

  // ═══ P｜陈旧状态收口（批二 M4/M5：`settlePause` 同收口 + mainIssue 用真源）══════════════════
  console.log('\n【P】陈旧状态收口 —— 辅助字段不得比真源活得久（毛选·实事求是）');
  {
    // ── P-1 ★★`clear=true` 删 `pending_approval` 与 `awaiting_input` **同收口**────────────────
    const db = mkdb();
    addTask(db, 'a', 'paused', { ctx: { awaiting_input: { q: 'x' }, pending_approval: { type: 'path' } } });
    const ctx1 = ctxObj(db, 'a');
    settlePause(db, 'a', ctx1, 'approve', 'ok', true);
    eq('awaiting_input' in ctxObj(db, 'a'), false, 'P-1a `clear=true` ⇒ 删 `awaiting_input`（真源，既有行为）');
    eq('pending_approval' in ctxObj(db, 'a'), false,
      'P-1b ★★`clear=true` ⇒ **一并删 `pending_approval`**（修复前：resume 只删前者，辅助字段永不清理）');

    // ── P-2 ★反证：`clear=false` 两者**都保留**（既有套件所钉，M4 未改这一支）─────────────────
    const db2 = mkdb();
    addTask(db2, 'b', 'paused', { ctx: { awaiting_input: { q: 'y' }, pending_approval: { type: 'privilege' } } });
    const ctx2 = ctxObj(db2, 'b');
    settlePause(db2, 'b', ctx2, 'deny', undefined, false);
    eq('awaiting_input' in ctxObj(db2, 'b'), true,
      'P-2a ★`clear=false`（连续拒绝、保持暂停）⇒ **保留** `awaiting_input`');
    eq('pending_approval' in ctxObj(db2, 'b'), true,
      'P-2b ★★`clear=false` ⇒ **保留** `pending_approval`（反证 P-1b 非恒真，逐字不变）');

    // ── P-3 静态：`tasks:mainIssue` 判据用真源 `awaiting_input`（不再读易陈旧的 `pending_approval`）──
    const ipc = CODE(`${A}/src/main/ipc/project.ipc.ts`);
    ok(/t\.status === 'paused'[\s\S]{0,80}?ctx\.awaiting_input/.test(ipc),
      'P-3a ★`tasks:mainIssue` 判据取 `ctx.awaiting_input`（全仓声明的"横幅唯一真源"）');
    ok(!/t\.status === 'paused'[\s\S]{0,80}?ctx\.pending_approval/.test(ipc),
      'P-3b ★反证：paused 判据**不**再读 `ctx.pending_approval`（陈旧辅助字段已退场）');
  }

  // ═══ S｜静态接线 + 陈旧注释订正 + 哑雷自检 + build 钉（派生核对，不写轮次字面量）══════════════
  console.log('\n【S】静态接线 + 陈旧注释订正 + 哑雷自检 + build 钉（派生核对）');
  {
    // ── S-1 ★★D3 覆盖率 = 真：8 处建子/任务出口**全在闸内**（按符号枚举，非按行号）──────────────
    const gateFiles = [
      `${A}/src/main/core/tools/control.ts`,
      `${A}/src/main/core/tools/resource.ts`,
      `${A}/src/main/core/tools/control-finalize.ts`,
      `${A}/src/main/ipc/project.ipc.ts`,
      `${A}/src/main/core/task-decompose.ts`,
    ];
    for (const f of gateFiles) {
      ok(CODE(f).includes('childBreadthRefusal('), `S-1 闸覆盖：\`${f.split('/').pop()}\` 确调 \`childBreadthRefusal(\``);
    }
    // `spawn_subagent` 工具体（按符号切片：`spawn_subagent: {` 到 `spawn_debate: {`）体内确含闸。
    const resSrc = CODE(`${A}/src/main/core/tools/resource.ts`);
    const saBody = resSrc.slice(resSrc.indexOf('spawn_subagent: {'), resSrc.indexOf('spawn_debate: {'));
    ok(saBody.length > 0 && saBody.includes('childBreadthRefusal('),
      'S-1b ★`spawn_subagent` 工具体内**确含** `childBreadthRefusal(`（旧注释称"此路无闸"早已过期）');

    // ── S-2 ★陈旧注释已订正：当前口径（"已全覆盖"）在场，旧字样退场（读**原文**，注释不能被剥离）──
    const accSrc = RD(`${A}/src/main/core/task-accounting.ts`);
    ok(accSrc.includes('已全覆盖'),
      'S-2a ★`task-accounting.ts` 现写明闸**已全覆盖**（订正后的当前口径在场）');
    ok(!accSrc.includes('无闸'),
      'S-2b ★订正：旧注释的「无闸」字样**已退场**（"只此一家"的过期断言不再冒充当前事实）');

    // ── S-3 M1 结构在册：`taskOwnTreeIds` 只取自身∪后代（静态反证：**不见** `collectAncestorIds`）──
    const aeSrc = CODE(`${A}/src/main/core/agent-executor.ts`);
    const ownFn = aeSrc.slice(aeSrc.indexOf('function taskOwnTreeIds'), aeSrc.indexOf('function realDeliverables'));
    ok(ownFn.includes('collectSubtreeIds') && !ownFn.includes('collectAncestorIds'),
      'S-3 ★★`taskOwnTreeIds` 取 `collectSubtreeIds`（后代）而**不取** `collectAncestorIds`（祖先）——收窄落在构造上');

    // ── S-4 自检：本文件零 build 轮次字面量（G-6）＋ 方向性自指（由载体自身派生）──────────────
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S-4a 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S-4b ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S-4c 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
(async () => {
  try {
    await main();
    console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261014_6: ${pass} 通过 / ${fail} 失败\n`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e: unknown) {
    console.error(`\n💥 rr_zx_20261014_6 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
    fail++;
    console.log(`\n❌ rr_zx_20261014_6: ${pass} 通过 / ${fail} 失败\n`);
    process.exit(1);
  }
})();
