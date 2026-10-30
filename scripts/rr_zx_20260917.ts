/**
 * zx_20260917 受控复跑 —— 「说不出为什么停，就一定会停在没人看得见的地方」。
 *
 * 本脚本落方案 §三（M1 · 停必录因）的三条判据 **A / B / G**（另附豁免与反证）。M2/M3/M4/M5/M5b/M5c
 * 落地时**增量扩写**本文件（各批在方案里的判据字母见 `plans/improve/zx_20260917.md` §二）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §A 判据 A（**静态**·写点收口）：扫描面 = `apps/worker-ant-desktop/src/main/**\/*.ts` **全量**
 *   （含 `core/`、`ipc/`、`services/`、`jobs/`——不是只扫 `core/`，只扫一个目录则断言名会冒充一个它并未覆盖的面）。
 *   A-1 扫描面非退化（文件数下界 + 四个子目录均在场，防"扫描面悄悄变空"的假绿）。
 *   A-2 裸写 `UPDATE wa_tasks SET status = 'paused'` 的命中**只允许落在两个具名文件**（订正⑤：原文"= 0"与同节豁免
 *       自相矛盾；按文件断而非按总数断，内部重构不会假红）。**按文件列举**，不写"数字 = 2"。
 *   A-3 **正面断言（0→1）**：唯一写入口 `core/pause-task.ts` **必须**在命中集里（否则"命中集为空"也会满足 A-2）。
 *   A-4 **反证**：把一段伪装成生产码的违规样本喂进同一判据，必须点名它（否则本判据只是"扫描面为空"的假绿）。
 *
 * §B 判据 B（**行为**·真实现）：就地调 `pauseTask` 本尊（**不复刻它的 SQL**——复刻即"第二把尺"），
 *   断言 `$.pause_reason` 与事件 `reason` **均非空**（正面断言，不是"不抛异常"）。
 *   B-1 `$.pause_reason` **由无到有**且 === 传入的因；状态同期变 `paused`。
 *   B-2 事件 `task.status_changed{newStatus:'paused', reason}` **恰一次**且 `reason` 非空同值。
 *   B-3 `projectId` 取自**同一行**（调用方转述与账各说各话正是本仓反复治过的病）——夹具里 project_id 故意
 *       不叫 `'p'`，若写口信任调用方就会露馅。
 *   B-4 **先落库、后发事件**：在事件回调里回查库，读到的**必须已是**新态（否则 GUI 收到事件即回查会读到旧态）。
 *   B-5 `extraContext` 一并落账（`run_mutations` 这类诊断量不丢）。
 *   B-6 坏账不阻断"落停"：`context_json` 不是合法 JSON 时，状态仍须落 `paused` 且因仍须写入（退化账）。
 *   B-7 带 `note` 时经既有告知通道（`im.notify_pause_needed='false'` ⇒ 门控生效；写口不抛、状态已落）。
 *   B-8 **反证（判据非空转）**：同一夹具上按**旧写法**裸 `UPDATE … SET status='paused'`（不落因），
 *       同一读取点读到的是**空因** ⇒ 证明"录因"确实是本轮新添的那一笔。
 *
 * §G 判据 G（**静态**·唯一性与白名单）：`pauseTask` **定义恰好 1 处**（唯一"置暂停"写口）；
 *   且 `$.pause_reason` 的 SQL 写点落在**列举式白名单**里（订正⑦：`json_set` 升级因 / `json_remove` 清点
 *   二者方向不同，强并入写口会多发一条暂停通知，违反 M2 判据 C-2）。白名单**按符号列举 + 逐条注明理由**，
 *   不写成"数字 = 3"（数字会随合法新增而假红，承 `feedback_criteria_must_be_satisfiable`）。
 *
 * §M3 判据 D（**行为**·真实现）：`paused` 前置按**因由**细分——因等自己的子任务而暂停者会零人工自解
 *   （`checkParentTaskAfterChildDone`）⇒ `waiting`，其余（含账上无因的存量暂停）⇒ `dead`；三种"死"三种话；
 *   并自证"paused 归类变化**不改变拦不拦**"（原方案 §5.2 预计该字节等价约束会被打破，实施前查证后**订正**）。
 *   反向断言：换掉同一只标本的因由 ⇒ 态与话随之翻（防"文案恰好来自别处"）；别的情形（failed/archived/
 *   completed/running/unresolved）一律不变。
 * §M3 判据 G（**静态**·唯一性）：`DEP_DEAD_STATUSES` **定义恰好 1 处**；且本轮新引入的相对依赖
 *   （`pause-reason.js`）的**传递闭包**内无 electron/better-sqlite3/node:*——渲染层跨 root 直引的前提。
 *
 * §M5 判据 M（**行为**·真实现）："链上至多一个在跑"。`core/task-chain.ts` 的 `childDispatchHint`/`chainBlockReason`
 *   **本尊**直调（父忙 ⇒ 改派话 · 父闲 ⇒ 放行；直系父在跑 / 名下后代在跑 / 后代挂执行作业 / 同批次已选亲属，四条各正反成对），
 *   外加**真工具体** `create_task` 直跑（父忙 ⇒ `created_deferred_parent_busy` **且 `wa_jobs` 0 行**；父闲 ⇒ `created_and_queued` 且恰 1 行）。
 *   ⚠ 真库此刻**0 命中**（§7.0bis-f：属运行期瞬态）⇒ 判据只能由**夹具**成立，不得声称"已被真库观测到"。
 * §M5 判据 N（静态·名实）：两个"产出"各名其尺——旧字面量 `产出${delivs.c}个` 已除、新文案说"**本任务登记**N 条"；
 *   并**反证持久化键 `hasDeliverable` 一字未改**（`tension-engine` 据它读存量行，改名即让老行误报）。
 * §M5 判据 O（行为·真函数）：偏离理由**不许静默截断**——长含标记、短不含、恰等于上限不含（三态各一）。
 *
 * ⚠ 夹具（内存库）只建本脚本真正查询的列。`wa_tasks` 在本路径上**无触发器**，故不存在"先插数据后建触发器"
 *   那类假绿（承 `feedback_rr_fixture_production_order`）——此处如实说明，不假称已按生产顺序搭。
 * ⚠ 本文件**不打开真库**，不改变任何生产行为（复核用的真库实测见 `plans/improve/zx_20260917.md` §1.3）。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**（P6 取产物内 build 值本身，而非会被注释骗过的子串匹配）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { engineExecSideFiles, stripStepScopePrefix } from './lib/rr-engine-src.js';
import { eventBus } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';
import {
  PAUSE_REASON_ACCEPTANCE_FAILED, PAUSE_REASON_CHILDREN_FAILED, PAUSE_REASON_CHILDREN_INCOMPLETE,
  PAUSE_REASON_NO_OUTPUT, PAUSE_REASON_QUALITY_BELOW_BAR,
  buildPauseNotice, pauseReasonLabel, recordedPauseReason,
} from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
import { pauseTask } from '../apps/worker-ant-desktop/src/main/core/pause-task.js';
import {
  classifyDep, depBlockInfo, depBlocksRun, DEP_DEAD_STATUSES,
} from '../apps/worker-ant-desktop/src/main/core/dep-graph.js';
import { buildTaskNotice } from '../apps/worker-ant-desktop/src/main/core/task-notice.js';
import {
  PAUSE_CLUSTER_WINDOW_MS, countUnread, recordNotification,
} from '../apps/worker-ant-desktop/src/main/core/notification-core.js';
import {
  ARTIFACT_WRITE_TOOLS,
  D3_GATE_TOOLS, MIXED_SHELL_TOOLS, goalDeviationExempt, hasRealDeliverable,
  isExplorationToolAlways, makeNonExplorationCappedTool, readRecentToolNames, realOutputEvidence,
  COMPLETED_ITEMS_FILE_LIMIT, USER_DIRECTIVE_MAX_CHARS,
  GOAL_DEVIATION_REASON_LIMIT, truncateGoalDeviationReason,
  buildCompletedItemsBlock, buildDeviationPrompt, buildUserDirectiveBlock, buildTools,
  collectWrittenFiles, readRecentUserDirectives, realDeliverables,
} from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import {
  EVIDENCE_FILE_BITS_LIMIT, collectEvidence, renderEvidence,
} from '../apps/worker-ant-desktop/src/main/core/exec-evidence.js';
import {
  disposeProbeDeliverables, docNotProbe, selectProbeDeliverables,
} from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import { setJobEnqueuer } from '../apps/worker-ant-desktop/src/main/core/job-enqueuer.js';
import {
  CHAIN_BUSY_STATUSES, chainBlockReason, childDispatchHint, directParentBusy, isChainBusyStatus,
} from '../apps/worker-ant-desktop/src/main/core/task-chain.js';
import { EXEC_JOB_TYPES } from '../apps/worker-ant-desktop/src/main/core/task-jobs.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const MAIN = path.join(root, `${A}/src/main`);
const strip = (p: string) => stripKeepingLines(fs.readFileSync(p, 'utf-8')).join('\n');

/**
 * zx_20260920_1 M1 就地订正：工具实现已**机械搬迁**到 `core/tools/*.ts`（`agent-executor.ts` 只留装配点）。
 * 凡按 `toolBlocks` 切的工具体，扫描面须是「执行体 ∪ 工具模块」——只扫执行体会切出**空块**，
 * 断言却报成"某工具没挂闸"（本轮实测 12 条此类假红）。执行体在前 ⇒ 若某工具将来搬回执行体仍优先取它。
 */
const TOOLS_DIR = path.join(MAIN, 'core/tools');
const withTools = (exeSrc: string): string =>
  `${exeSrc}\n${fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts')).sort().map((f) => strip(path.join(TOOLS_DIR, f))).join('\n')}`;

/**
 * zx_20260929 M9：`agent-executor.ts` 的**步回调段**（`onStepFinish` 闭包，原 :2132–2728）整段外移到
 * `core/exec-step.ts` ⇒ 凡判据本意是"引擎这一侧确实这么实现"、而落点只是当时所在的，须把面换成
 * 「执行体 ∪ `core/exec-*.ts`」（目录约定**一处真源**在 `lib/rr-engine-src.ts`，免下次搬迁又漏一处）。
 *
 * ⚠ 只许更严：并集**不含** `tools/*.ts`（那类工具体判据另由 `withTools` 服务）；本文件里凡点的就是
 *   `agent-executor.ts` **这个文件本身**的判据（如第 401 行那份暂停点清单、`execSync` 全文不变量）**不得**换面。
 * ⚠ `stripStepScopePrefix` 只是**还原搬迁前的针脚字面量**（搬后步内绑定统一前置了 `d.`），非放宽：见该函数注释。
 */
const execSideFace = stripStepScopePrefix(
  engineExecSideFiles().map((p) => strip(path.join(root, p))).join('\n'));

/** 递归收集 `src/main` 下全部 `.ts`（判据 A/G 的扫描面：**整个 src/main**）。 */
function walkTs(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

/** 取 `fnName(` 起、配对括号止的**实参原文**；无该调用返回 null（按符号锚，不按行号、不按参数名）。 */
function callArgs(src: string, fnName: string): string | null {
  const i = src.indexOf(`${fnName}(`);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i + fnName.length; j < src.length; j++) {
    if (src[j] === '(') depth++;
    else if (src[j] === ')') { depth--; if (depth === 0) return src.slice(i + fnName.length + 1, j); }
  }
  return null;
}

/** 实参个数 = 顶层逗号数 + 1（忽略括号内的逗号）——数"传没传第 N 个"而不写死参数名。 */
function topLevelArity(args: string): number {
  let depth = 0; let n = 1;
  for (const c of args) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) n++;
  }
  return n;
}

/**
 * 顶层实参**逐段**原文（与 `topLevelArity` 同一切分规则）——用来逐个检查"第 N 个实参是什么"。
 *
 * ⚠ 末尾那个**只有空白**的段丢掉：多行调用常在最后一个实参后留「逗号 + 换行」，
 * 不丢的话实参数会平白多 1（实测 9 → 10），断言里的数字就成了假的。
 */
function topLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0; let cur = '';
  for (const c of args) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  if (out.length > 1 && out[out.length - 1]!.trim() === '') out.pop();
  return out;
}

/**
 * 「指令即免检」的过宽变体（K5-rev 的判据）：**声称有指令就不判偏离**，或**不带**"至少符合二者之一"的限缩。
 *
 * 两支都要命中才算"带限缩"——只查"有没有说优先"会漏掉"优先，且干什么都算对"这种翻转后的过宽。
 */
function isBlanketDirectiveBlock(src: string): boolean {
  const claimsBlanket = /一律不判偏离|不再判偏离|有指令即免|一律免于判偏离/.test(src);
  const hasLimiter = src.includes('既不符合目标、也不符合该指令');
  return claimsBlanket || !hasLimiter;
}

/** 从 `from` 起**第一个** `{` 的配对括号块原文（扫描面按"符号 + 配对括号"界定，不按行号——行号是位置会漂）。 */
function braceBlock(src: string, from: number): string {
  if (from < 0) return '';
  const open = src.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(open, j + 1); }
  }
  return '';
}

/**
 * 「手抄的工具名清单」命中：源码里某个**字面量数组**内含 ≥ `HAND_LIST_MIN` 个 D3 工具名。
 *
 * 判据名须=扫描面：它抓的是"**本该引常量、却把工具名又抄了一遍**"，不是在数某个数字。
 * 阈值由 `D3_GATE_TOOLS` **自身派生**（其长度 - 1），且不手抄第二份名单——
 * 取"≥3 而非 ≥2"是因为 75% 档那条 `['search_content','search_web']` 是**另一个概念**
 * （只禁搜索、有意不含 shell），按 ≥2 计会把合法写法误红。
 */
const HAND_LIST_MIN = Math.max(3, D3_GATE_TOOLS.length - 1);
function handLists(src: string): string[] {
  return [...src.matchAll(/\[([^\[\]]*)\]/g)]
    .map((m) => m[1]!)
    .filter((inner) => D3_GATE_TOOLS.filter((n) => inner.includes(`'${n}'`)).length >= HAND_LIST_MIN);
}

/**
 * 「四处同一判据」：`if (!deviationExempt) { … }` 的**配对括号内**同时含
 * ①会话行（`[目标偏离提醒]`）②事件（⇒ 通知）③**自增** ④`abort`。
 *
 * 缺任一处即**半修**——尤其"免 abort 而未免自增"：计数照样爬到上限，`ai-task.goalRestartExceeded`
 * 随后照样硬停，豁免被削弱成"只是没立刻打断"，与它要治的原病**同形**。
 */
function guardedFour(src: string): boolean {
  const i = src.indexOf('if (!deviationExempt) {');
  if (i < 0) return false;
  const blk = braceBlock(src, i);
  return [
    '目标偏离提醒',
    "eventBus.emit('task.goal_deviation'",
    'goal_deviation_restarts = restarts + 1',
    "controller.abort(new Error('goal_deviation_restart'))",
  ].every((m) => blk.includes(m));
}

const schema = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', title TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', parent_task_id TEXT DEFAULT '', depends_on TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', updated_at TEXT DEFAULT (datetime('now')));
`;

/**
 * 按**符号**切出 `buildTools` 里各个工具的**对象体**（顶层 `    name: {` 起、到下一个顶层键止）。
 *
 * 不按行号切：行号是位置、会漂（本仓同病已复发三次）。断言"某工具体内有没有某个调用"时，
 * 扫描面必须是**该工具体**——写成"整个文件里找得到"则工具之间会互相冒充（`bash` 的断言会被
 * `execute_command` 的命中喂饱）。
 */
function toolBlocks(src: string): Record<string, string> {
  const hits: Array<{ name: string; i: number }> = [];
  for (const m of src.matchAll(/^ {4}([a-z_][a-z0-9_]*): \{$/gm)) hits.push({ name: m[1]!, i: m.index! });
  const out: Record<string, string> = {};
  for (let i = 0; i < hits.length; i++) out[hits[i]!.name] = src.slice(hits[i]!.i, i + 1 < hits.length ? hits[i + 1]!.i : src.length);
  return out;
}
type AnyDb = { prepare: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] }; exec: (s: string) => void; close: () => void };
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:') as unknown as AnyDb; d.exec(schema); return d; };
const addTask = (db: AnyDb, id: string, project: string, status: string, ctx: string = '{}'): void => {
  db.prepare('INSERT INTO wa_tasks (id, project_id, status, context_json) VALUES (?,?,?,?)').run(id, project, status, ctx);
};
const ctxOf = (db: AnyDb, id: string) => JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json) as Record<string, unknown>;
const statusOf = (db: AnyDb, id: string) => (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;

/**
 * M2 专用夹具：补齐 `title`/`parent_task_id`/`depends_on` 三列。
 * 不并进上面的 `addTask`（那是 M1/M3 的夹具，签名只带它们查询的列）——**新增而非改造**，
 * 免得为一个新批改掉旧批夹具的含义。
 */
const addTaskFull = (db: AnyDb, t: { id: string; status: string; title?: string; parent?: string; deps?: string; ctx?: Record<string, unknown> }): void => {
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id, depends_on, context_json) VALUES (?,?,?,?,?,?,?)')
    .run(t.id, 'p', t.title ?? t.id, t.status, t.parent ?? '', t.deps ?? '', JSON.stringify(t.ctx ?? {}));
};
/** `wa_notifications` 里某任务的行数（C-2 的正面判据） */
const notifRows = (db: AnyDb, taskId: string): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM wa_notifications WHERE task_id = ?').get(taskId) as { c: number }).c;
/** 该任务最后落的那一行（`rowid` 逆序＝真实插入序） */
const lastNotif = (db: AnyDb, taskId: string): { id: string; type: string; body: string } =>
  db.prepare('SELECT id, type, body FROM wa_notifications WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(taskId) as never;

async function main(): Promise<void> {
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【A】判据 A（静态·写点收口）— 扫描面 src/main/**/*.ts 全量');
  {
    const all = walkTs(MAIN);
    const rel = all.map((f) => path.relative(MAIN, f));
    // A-1 扫描面非退化：文件数下界 + 四个子目录均真被扫到（只扫 core/ 的断言会冒充一个更大的面，承 G9）
    ok(all.length >= 80, `扫描面实收 ${all.length} 个 .ts`, `下界 80`);
    for (const d of ['core/', 'ipc/', 'services/', 'core/jobs/']) {
      ok(rel.some((f) => f.startsWith(d)), `扫描面确含 ${d}（断言名须=扫描面，不让"只扫了 core/"冒充全景）`);
    }

    // A-2/A-3 裸写命中集 ⊆ 白名单，且写口**必须在册**
    const RAW = "UPDATE wa_tasks SET status = 'paused'";
    const hits = rel.filter((f) => strip(path.join(MAIN, f)).includes(RAW));
    // 白名单：逐条具名（不写"数字 = 2"——数字会随合法重构假红）
    const ALLOW = [
      'core/pause-task.ts',        // 唯一写入口本尊（其内允许）
      'core/event-projectors.ts',  // 豁免：`task.awaiting_input` 投影落库，见方案 §1.5-1
    ];
    ok(hits.includes('core/pause-task.ts'),
      '★ 正面（0→1）：唯一写入口 `core/pause-task.ts` 确在命中集里（否则"命中集为空"也能满足下一条）');
    eq(hits.filter((f) => !ALLOW.includes(f)), [],
      `裸写命中集 ⊆ 白名单（实测命中 ${hits.length} 个文件：${hits.join(', ')}）`);
    eq(strip(path.join(MAIN, 'core/pause-task.ts')).split(RAW).length - 1, 1,
      '写入口内该语句恰 1 处（去注释后计数：注释里的"24 处裸写"那句不算数）');
    ok(hits.includes('core/event-projectors.ts'), '豁免在册且**逐条具名**（投影器 1 处，理由见方案 §3.2 表末行）');

    // A-4 反证：伪装成生产码的违规样本必须被同一判据点名
    const rogue = 'const x = 1;\ndb.prepare("' + RAW + ' WHERE id = ?").run(id);\n';
    const rogueHits = ['src/main/core/rogue-new-file.ts'].filter(() => rogue.includes(RAW));
    eq(rogueHits, ['src/main/core/rogue-new-file.ts'],
      '反证：违规样本喂进同一谓词必被点名 ⇒ 本判据不是"扫描面恒空"的假绿');
    ok(!ALLOW.includes('src/main/core/rogue-new-file.ts'), '反证：该样本不在白名单 ⇒ 真出现即判红');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【B】判据 B（行为·真实现）— 就地调 `pauseTask` 本尊，不复刻其 SQL');
  {
    const db = mkdb();
    // project_id 故意不叫 'p'：写口若信任调用方转述，B-3 即露馅
    addTask(db, 't-1', 'proj-真实ID', 'executing');
    ok(!('pause_reason' in ctxOf(db, 't-1')), 'B-1 前置：落停前账上**无** `pause_reason`（0 态）');

    // B-4 先落库、后发事件：在订阅回调里回查库，读到的必须**已是**新态
    const seen: Array<{ statusAtReply: string; reasonAtReply: unknown; projectIdAtReply: unknown }> = [];
    const h = (e: { data: Record<string, unknown> }) => {
      if (e.data.taskId !== 't-1') return;
      seen.push({
        statusAtReply: statusOf(db, 't-1'),
        reasonAtReply: e.data.reason,
        projectIdAtReply: e.data.projectId,
      });
    };
    eventBus.on('task.status_changed', h);
    pauseTask(db, { taskId: 't-1', reason: PAUSE_REASON_ACCEPTANCE_FAILED, extraContext: { run_mutations: 7 } });
    await Promise.resolve();
    eventBus.off('task.status_changed', h);

    eq(ctxOf(db, 't-1').pause_reason, PAUSE_REASON_ACCEPTANCE_FAILED,
      'B-1 ★ `$.pause_reason` **由无到有**且 === 传入的因（正面断言：被 try/catch 吞掉的写入只有正面断言抓得住）');
    eq(statusOf(db, 't-1'), 'paused', 'B-1 同期状态落 `paused`');
    eq(seen.length, 1, "B-2 ★ 事件 `task.status_changed` **恰一次**");
    ok(typeof seen[0]!.reasonAtReply === 'string' && (seen[0]!.reasonAtReply as string).length > 0,
      'B-2 ★ 事件 `reason` **非空**（"说不出为什么停"正是本轮病根）', `reason=${JSON.stringify(seen[0]!.reasonAtReply)}`);
    eq(seen[0]!.reasonAtReply, PAUSE_REASON_ACCEPTANCE_FAILED, 'B-2 事件因与账上因**同值**（不各说各话）');
    eq(seen[0]!.projectIdAtReply, 'proj-真实ID',
      'B-3 ★ `projectId` 取自**同一行**（调用方根本没机会转述；转述与账分家正是本仓反复治过的病）');
    eq(seen[0]!.statusAtReply, 'paused',
      'B-4 ★ 先落库、后发事件：订阅者收到事件即回查，读到的**已是**新态（顺序写反则 GUI 读到旧态）');
    eq(ctxOf(db, 't-1').run_mutations, 7, 'B-5 `extraContext` 一并落账（诊断量不丢）');
    ok(typeof pauseReasonLabel(PAUSE_REASON_ACCEPTANCE_FAILED) === 'string'
      && pauseReasonLabel(PAUSE_REASON_ACCEPTANCE_FAILED).length > 0, 'B-2 该因在词表里有 label（有值才能上屏）');

    // B-6 坏账不阻断"落停"
    addTask(db, 't-bad', 'p-bad', 'executing', 'not json at all');
    pauseTask(db, { taskId: 't-bad', reason: PAUSE_REASON_CHILDREN_INCOMPLETE });
    eq(statusOf(db, 't-bad'), 'paused', 'B-6 ★ 坏账不阻断"落停"（状态留在 executing 比丢一份坏账严重得多）');
    eq(ctxOf(db, 't-bad').pause_reason, PAUSE_REASON_CHILDREN_INCOMPLETE, 'B-6 且退化为最小账时**因仍写入**');

    // B-7 带 note ⇒ 走既有告知通道；门控关时写口不抛、状态已落
    const db2 = mkdb();
    db2.prepare("INSERT INTO wa_settings (key, value) VALUES ('im.notify_pause_needed', 'false')").run();
    addTask(db2, 't-note', 'p', 'executing');
    let threw = false;
    try { pauseTask(db2, { taskId: 't-note', reason: PAUSE_REASON_CHILDREN_INCOMPLETE, note: '仍有 1 个子任务未完成' }); }
    catch { threw = true; }
    ok(!threw && statusOf(db2, 't-note') === 'paused' && ctxOf(db2, 't-note').pause_reason === PAUSE_REASON_CHILDREN_INCOMPLETE,
      'B-7 带 `note` 时经既有告知通道（开关关 ⇒ 门控生效），写口不抛且状态/因照落');

    // B-8 反证（判据非空转）：同一夹具上按**旧写法**裸写状态（不落因），同一读取点读到空因
    const db3 = mkdb();
    addTask(db3, 't-old', 'p', 'executing');
    db3.prepare("UPDATE wa_tasks SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run('t-old');
    eq(statusOf(db3, 't-old'), 'paused', 'B-8 反证前置：旧写法确实也把状态置成了 `paused`（外观一致）');
    ok(!('pause_reason' in ctxOf(db3, 't-old')),
      '★ B-8 反证：旧写法在同一读取点读到**空因** ⇒ "录因"确实是本轮新添的那一笔，判据非空转');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【G】判据 G（静态·唯一性与白名单）');
  {
    const all = walkTs(MAIN);
    const rel = all.map((f) => path.relative(MAIN, f));
    const defSites = rel.filter((f) => /export function pauseTask\(/.test(strip(path.join(MAIN, f))));
    eq(defSites, ['core/pause-task.ts'], 'G-1 ★ `pauseTask` **定义恰好 1 处**（唯一"置暂停"写口）');

    // `$.pause_reason` 的 SQL 写点：列举式白名单（按符号，不按数字）
    const KEY = '$.pause_reason';
    // zx_20261028_2 M2：旧判据是"文件里同时出现键与 json_set/json_remove"——列表摘录用
    //   `json_extract(t.context_json,'$.pause_reason')` 读该键，而同文件另有无关的 json_set/remove，
    //   于是**读点被误判成写口**。改钉**同一行**：键须是那次 json_set/json_remove 的实参，
    //   才算"写该键的 SQL 点"（更强：不仅要求共现，还要求二者是同一个调用）。
    const isPauseReasonSqlWrite = (code: string): boolean => code.split('\n').some((l) =>
      (l.includes('json_set(') || l.includes('json_remove(')) && l.includes(KEY));
    const sqlSites = rel.filter((f) => isPauseReasonSqlWrite(strip(path.join(MAIN, f))));
    const ALLOW = [
      'core/exec-claim.ts',      // 清点（`json_remove`）：CAS 认领时把已成过去的因清掉——方向与"写点"相反。
                                 // zx_20260921 M8: 本笔随 `executeTask` 入口段整段搬离 `core/agent-executor.ts`，
                                 //   码与用途**一字未改**，白名单按**新落点**在册（判据按符号/文件列举，不写数字）。
      'core/jobs/ai-task.ts',    // 升级既有因（`json_set`，**不改状态**）：父已在收口闸处 paused 并录因，此处只把因升为 children_failed
    ];
    eq(sqlSites.filter((f) => !ALLOW.includes(f)), [],
      `G-2 ★ \`${KEY}\` 的 SQL 写点 ⊆ 白名单（实测 ${sqlSites.join(', ')}；两处均为"非置停"用途，理由见方案订正⑦）`);
    eq(sqlSites.length, ALLOW.length, `G-2 白名单**逐条都用上了**（${sqlSites.length}/${ALLOW.length}，防"名单外挂僵尸条目"）`);
    // 反证：只读该键不算写点——同一谓词喂"json_extract 读 + 另处无关 json_set"的样本须不命中，
    //   否则新加的列表摘录会把读写面搅在一起（本判据就成了"凡提到该键皆白名单"的空转）。
    ok(!isPauseReasonSqlWrite([
      "db.prepare(\"SELECT json_extract(context_json, '$.pause_reason') FROM wa_tasks\")",
      "db.prepare(\"UPDATE wa_tasks SET context_json = json_set(context_json, '$.other', 1) WHERE id = ?\")",
    ].join('\n')), 'G-2 反证：仅 `json_extract` 读取该键（另处 json_set 改的是别的键）不算 SQL 写点');

    const writer = strip(path.join(MAIN, 'core/pause-task.ts'));
    ok(writer.includes('ctx.pause_reason = reason') && !writer.includes('json_set'),
      'G-3 ★ 写入口以 **TS 对象赋值**落因（不经 SQL `json_set`）——故它不出现在 G-2 的 SQL 扫描面里，非漏网');
    ok(/reason:\s*PauseReason\b/.test(writer) && !/reason\?:\s*PauseReason/.test(writer),
      'G-4 ★ `reason` 为**必填**（`PauseReason` 联合类型）⇒「无因暂停」在类型层不可表达');
    // G-5 接线在册：**按符号列举**本轮应接入写口的文件（方案 §3.2 处置表逐行对应的落点），
    //   不写"调用点 = N"（N 会随合法新增假红）；另附文件数下界防扫描面退化。
    const callers = rel.filter((f) => strip(path.join(MAIN, f)).includes('pauseTask('));
    const WIRED = [
      'core/agent-executor.ts',          // 17 处暂停点（含验收未通过·本轮主要目标 / interruptTask / pauseForDecision / 各硬闸）
      'core/architectural-invariants.ts',// 滞留执行超 24h（`stale_timeout`）
      'core/jobs/ai-task.ts',            // 偏离收敛（`goal_deviation`）/ 非正常结束（`abnormal_end`）
      'core/self-healing-monitor.ts',    // 自愈：执行超 10 分钟无心跳（`exec_timeout`）
      'core/task-scheduler.ts',          // 计划模式超时（`planning_timeout`）
      'database.ts',                     // 启动清理残留执行态（`startup_sweep`）
      'ipc/project.ipc.ts',              // GUI「暂停」兜底分支（`user_interrupt`）
      'core/pause-task.ts',              // 定义处自身
    ];
    eq(WIRED.filter((f) => !callers.includes(f)), [],
      `G-5 ★ 接线在册：${WIRED.length} 个应接入的文件均已真调 \`pauseTask\`（方案 §3.2 处置表逐行对应）`);
    ok(callers.length >= WIRED.length, `G-5 调用点 ${callers.length} 个文件（下界 = 名单长度 ${WIRED.length}，防扫描面退化）`);
    ok(rel.includes('core/pause-task.ts'), 'G-5 定义文件本身在扫描面内（无自相矛盾）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M3·判据 D】前置之因不得谎报：`paused` 前置按**因由**细分 × 三种"死"三种话（行为·真实现）');
  {
    const db = mkdb();
    // 六只前置标本：三种"死"各一 + 会给自解的暂停 + 在跑 + 完成
    addTask(db, 'd-failed', 'p', 'failed');
    addTask(db, 'd-arch', 'p', 'archived');
    addTask(db, 'd-paused-manual', 'p', 'paused', JSON.stringify({ pause_reason: PAUSE_REASON_QUALITY_BELOW_BAR }));
    addTask(db, 'd-paused-nokey', 'p', 'paused', '{}');  // M1 收口前的存量暂停：账上**无**因
    addTask(db, 'd-paused-kids', 'p', 'paused', JSON.stringify({ pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE }));
    addTask(db, 'd-running', 'p', 'running');
    addTask(db, 'd-done', 'p', 'completed');

    // 读取回调与**生产读点同形**：`task-scheduler.depStateOf` 亦是一条取 id/status/context_json 的 SQL
    const st = (id: string) => (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string } | undefined)?.status;
    const ctx = (id: string) => (db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string } | undefined)?.context_json;
    const nm = (id: string) => id;
    // 旧布尔尺（M3-2 之前的唯一运行时判据）：存在**在库中查得到**且状态非 completed 的前置
    const oldBoolean = (deps: string[]) => (db.prepare(
      `SELECT COUNT(*) AS c FROM wa_tasks WHERE id IN (${deps.map(() => '?').join(',')}) AND status != 'completed'`,
    ).get(...deps) as { c: number }).c > 0;

    ok((DEP_DEAD_STATUSES as readonly string[]).includes('paused'),
      'D-0 ★ `paused` 已入 `DEP_DEAD_STATUSES`（状态层面即"永不可满足"）；"能否自解"另按因由细分 ⇒ D-1/D-2');
    // ── 正面：三种 paused 各归其位 ──
    eq(classifyDep(['d-paused-kids'], st, ctx), 'waiting',
      '★ D-1 `paused` + `children_incomplete` ⇒ **waiting**（子到终态零人工自解；喊"须人工恢复"才是新造的谎）');
    eq(classifyDep(['d-paused-manual'], st, ctx), 'dead',
      '★ D-2 `paused` + 因由已记录且非等子 ⇒ **dead**（本轮主要目标：它此前被并进 waiting 并被许诺"完成后自动启动"）');
    eq(classifyDep(['d-paused-nokey'], st, ctx), 'dead',
      '★ D-3 `paused` + 账上**无因由**（M1 前的存量暂停）⇒ **dead**（不知情时宁可喊"须人工"，不许诺"会自动解锁"）');
    // ── 反向断言：别的情形一律不许被本轮悄悄改动 ──
    eq(classifyDep(['d-failed'], st, ctx), 'dead', 'D-4 反向：`failed` 前置仍 dead（行为不变）');
    eq(classifyDep(['d-arch'], st, ctx), 'dead', 'D-4 反向：`archived` 前置仍 dead（行为不变）');
    eq(classifyDep(['d-done'], st, ctx), 'met', 'D-4 反向：全部 completed ⇒ met 不变');
    eq(classifyDep(['d-running'], st, ctx), 'waiting', 'D-4 反向：在跑 ⇒ waiting 不变');
    eq(classifyDep(['ghost-id'], st, ctx), 'unresolved', 'D-4 反向：查不到的 id ⇒ unresolved 不变（承 M3-2 裁定：不阻塞）');
    eq(depBlocksRun('unresolved'), false, 'D-4 反向：unresolved 仍**不阻塞**（不是借本轮悄悄收紧）');

    // ── D-5 ★ 字节等价自证 ──
    // 原方案 §5.2 预计"该约束本轮被有意打破"，实施前查证后**订正**：paused 原属 waiting（阻塞）、今属 dead
    //（阻塞），故 depBlocksRun 的布尔值逐情形不变——本轮动的是分类名与文案，不是拦不拦。此处就地自证。
    const CASES: string[][] = [['d-paused-manual'], ['d-paused-kids'], ['d-paused-nokey'], ['d-failed'], ['d-arch'],
      ['d-running'], ['d-done'], ['ghost-id'], ['d-failed', 'ghost-id'], ['d-done', 'd-running'], ['d-paused-kids', 'd-failed']];
    const equiv = CASES.filter((deps) => depBlocksRun(classifyDep(deps, st, ctx)) === oldBoolean(deps)).length;
    ok(equiv === CASES.length,
      `★ D-5 字节等价自证：${equiv}/${CASES.length} 例"拦不拦" === 旧布尔尺 ⇒ 归类变化只动分类名与文案`);

    // ── D-6 ★ 三种"死"三种话（判据 D 的核心：互不相同、各自点名实际状态、含"不会自动解锁"） ──
    const tFailed = depBlockInfo(['d-done', 'd-failed'], st, nm, ctx).text;
    const tArch = depBlockInfo(['d-done', 'd-arch'], st, nm, ctx).text;
    const tPaused = depBlockInfo(['d-done', 'd-paused-manual'], st, nm, ctx).text;
    eq(new Set([tFailed, tArch, tPaused]).size, 3,
      '★ D-6 三种"死"给出**三段互不相同**的话（此前一律"已失败/归档"，paused 前置更被并进"等它完成"）');
    ok(tFailed.includes('前置已失败') && tFailed.includes('d-failed'), 'D-6 failed 话点名"已失败"且点名该前置');
    ok(tArch.includes('前置已归档') && tArch.includes('d-arch'), 'D-6 archived 话点名"已归档"');
    ok(tPaused.includes('前置已暂停待人工') && tPaused.includes('不会自动解锁'),
      '★ D-6 paused 话含"**不会自动解锁**"（本轮病根②原话）');
    ok(tPaused.includes(pauseReasonLabel(PAUSE_REASON_QUALITY_BELOW_BAR)),
      'D-6 paused 话点出**因由人话**（人不只知道"停了"，还知道"为什么停"）');
    ok([tFailed, tArch, tPaused].every((s) => s.includes('不会自动启动') && !/完成后自动启动/.test(s)),
      'D-6 三种死话都**不许诺**自动启动（反证：那句"等它完成就好"的假话不再出现在任何一段）');

    // ── D-7 ★ 反向断言：换掉同一只标本的因由，态与话随之翻 ⇒ 判据**确实读了因由**（防"文案恰好来自别处"） ──
    db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify({ pause_reason: PAUSE_REASON_NO_OUTPUT }), 'd-paused-kids');
    eq(classifyDep(['d-paused-kids'], st, ctx), 'dead',
      '★ D-7 反向：同一只标本因由由 `children_incomplete` 换成 `no_output` ⇒ 立刻由 waiting 翻为 dead');
    ok(depBlockInfo(['d-paused-kids'], st, nm, ctx).text.includes('不会自动解锁'),
      '★ D-7 反向：文案同期由"会自动恢复"翻为"不会自动解锁"（同上，证明这一句不是恰好来自别处）');
    db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify({ pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE }), 'd-paused-kids');
    eq(classifyDep(['d-paused-kids'], st, ctx), 'waiting', 'D-7 复原：换回 children_incomplete 即回 waiting（同一只标本可逆）');

    // ── D-8 ★ 混合：一死 + 一"会自解" —— 不得借 dead 的口气把后者也说成须人工 ──
    const mix = depBlockInfo(['d-failed', 'd-paused-kids'], st, nm, ctx);
    eq(mix.state, 'dead', 'D-8 混合态取 dead（"永不可满足"才是用户最需知道的）');
    ok(mix.text.includes('前置已失败') && mix.text.includes('因等自己的子任务而暂停') && mix.text.includes('无需人工'),
      '★ D-8 同一段话里一码归一码：死的照说"不会自动启动"，**会自解的那个**另说"无需人工"');
    eq(mix.selfHealingPausedNames, ['d-paused-kids'], 'D-8 结构化字段同期点名它（文案与字段同源，不各说各话）');

    // ── D-9 waiting 侧 ──
    const waitKids = depBlockInfo(['d-done', 'd-paused-kids'], st, nm, ctx);
    eq(waitKids.state, 'waiting', 'D-9 一完成 + 一等子暂停 ⇒ waiting');
    eq(waitKids.remaining, 1, 'D-9 它虽会自解但**尚未完成**，故仍计"还差 1 个"（不因"会自解"就当作已完成）');
    ok(waitKids.text.includes('因等自己的子任务而暂停') && waitKids.text.includes('自动恢复'),
      'D-9 waiting 话点明"它为什么停着、以及会自己好"');
    eq(classifyDep(['d-paused-kids'], st), 'dead',
      '★ D-9 反证：**不传** `contextOf` 时同一只标本判死 ⇒ "会自解"这条信息**只能**来自因由，不来自状态名');

    // ── D-10 ★ 接线在册：生产读点**必须**把 context_json 交给判据（不交则等子而暂停者被误报） ──
    // zx_20261018_3 批二「序」：调度器的取数 SQL 与 `classifyDep` 调用整块迁到 `core/task-dep-gate.ts`
    //   （`readTaskDeps`），调度器改为 `depStateOf → taskDepState` 转发。判据随之迁至新真源，
    //   并补一条"调度器确实转发"——两处都钉，比原先只钉调度器一处更强（迁走一半即红）。
    const gateSrc = strip(path.join(MAIN, 'core/task-dep-gate.ts'));
    const gateArgs = callArgs(gateSrc, 'classifyDep');
    ok(/SELECT id, (?:title, )?status, context_json FROM wa_tasks WHERE id IN/.test(gateSrc),
      '★ D-10 依赖读点的取数 SQL 已一并取 `context_json`（数据不取，判据就无从细分）');
    ok(gateArgs !== null && topLevelArity(gateArgs) === 3,
      '★ D-10 且 `classifyDep` 确被传**三个**实参（id 串 + 状态取值 + 因由取值）——只传两个即回到"暂停一律须人工"的误报',
      `实测实参个数 ${gateArgs === null ? 'null' : topLevelArity(gateArgs)}`);
    const schedSrc = strip(path.join(MAIN, 'core/task-scheduler.ts'));
    ok(/return taskDepState\(this\.db, taskId\);/.test(schedSrc),
      '★ D-10 调度器读点确实转发到 `taskDepState`（不是另写一份读法）');
    // zx_20261028_2 M2：列表不再递整份 `context_json`，第四参载体改为 `context_digest`（同形 JSON 文本）。
    //   判据随之改钉**新真源**并加一跳：digest 的生产 SQL 必须真的带 `pause_reason`——
    //   否则"按因由细分"又回到恒空，渲染层传了也白传。
    const ipcSrc = strip(path.join(MAIN, 'ipc/project.ipc.ts'));
    ok(/SELECT t\.id, t\.project_id,[\s\S]*?AS context_digest[\s\S]*?FROM wa_tasks t/.test(ipcSrc)
      && ipcSrc.includes("'pause_reason', json_extract(t.context_json, '$.pause_reason')"),
      '★ D-10 task:list 的 `context_digest` 生产 SQL 确实带 `pause_reason`（列表载体换名后因由判据仍有数据可依）');
    for (const f of ['TaskDetailPage.tsx', 'TasksPage.tsx']) {
      const src = fs.readFileSync(path.join(root, A, 'renderer/src/pages', f), 'utf-8');
      const call = src.match(/depBlockInfo\(([\s\S]*?)\)\s*;/);
      ok(!!call && call[1]!.includes('context_digest'),
        `★ D-10 renderer ${f} 的调用点已传第四个取值函数（载体=context_digest；renderer 不在 src/main 扫描面内，须逐处点验）`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M3·判据 G】`DEP_DEAD_STATUSES` 只有一处定义 + 本模块跨 root 直引的前提仍成立');
  {
    const all = walkTs(MAIN);
    const rel = all.map((f) => path.relative(MAIN, f));
    const defs = rel.filter((f) => /export const DEP_DEAD_STATUSES\b/.test(strip(path.join(MAIN, f))));
    eq(defs, ['core/dep-graph.ts'],
      '★ G-6 `DEP_DEAD_STATUSES` **定义恰好 1 处**（读点不再各写一遍——G8 那类"手抄必漂"病灶的同尺防治）');
    // 反证：把第二处定义喂进同一谓词，必须被点名（否则本判据只是"扫描面恒空"的假绿）
    const rogue = "export const DEP_DEAD_STATUSES = ['failed'] as const;";
    const rogueHits = ['src/main/core/rogue-dep.ts'].filter(() => /export const DEP_DEAD_STATUSES\b/.test(rogue));
    eq(rogueHits, ['src/main/core/rogue-dep.ts'], '反证：第二处定义必被同一谓词点名 ⇒ 非空转');

    // ★ 本轮新引入了一条相对依赖（`pause-reason.js`）——渲染层跨 root 直引的前提是**传递闭包**都零依赖，
    //   故按"性质"验（而非把依赖清单写成字面量，那会随合法新增假红）：
    const depSrc = strip(path.join(MAIN, 'core/dep-graph.ts'));
    const imports = [...depSrc.matchAll(/from\s+'(\.\/[^']+)'/g)].map((m) => m[1]!);
    ok(imports.includes('./pause-reason.js'), '★ G-7 认下按因由细分所引的既有真源 `./pause-reason.js`');
    const BANNED = /from\s+['"](electron|better-sqlite3|node:)/;
    const contaminated = (src: string) => !src || BANNED.test(src);
    const banned = imports.filter((spec) => {
      const p = path.join(MAIN, 'core', spec).replace(/\.js$/, '.ts');
      return contaminated(fs.existsSync(p) ? strip(p) : '');
    });
    eq(banned, [],
      '★ G-7 相对依赖的**传递闭包**内无 electron/better-sqlite3/node:* ⇒ 渲染层直引仍安全（本轮新增依赖后必须重验）');
    ok(!/^\s*import\s/m.test(strip(path.join(MAIN, 'core/pause-reason.ts'))),
      '★ G-7 `pause-reason.ts` 自身零 import ⇒ 上一条不是靠"没往下看"蒙混过关');
    // 反证（判据非空转）：污染样本与"文件不存在"两种失效态都要被同一谓词点名
    eq([contaminated("import { app } from 'electron';"), contaminated('')], [true, true],
      '反证：闭包谓词对"引 electron"与"文件查不到"两种失效态均点名 ⇒ 上一条不是恒真的空转');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M2·判据 C】停必告因：`buildPauseNotice` 真实现直调（因 / 拦住谁 / 槽位 / 未记录）');
  {
    // 真实现直调（本模块零 import ⇒ 真实现就在本 import 面内，不存在"复刻一份逻辑自我印证"）
    const only = buildPauseNotice({ name: 'M0 基线固证', word: '已暂停', pauseReason: PAUSE_REASON_CHILDREN_FAILED, blockedDownstream: 0 });
    ok(only.includes('子任务失败未处置'), '★ C-a 因由由**账上原文**派生人话（`children_failed` ⇒ 「子任务失败未处置」）');
    ok(only.includes('待复核') && only.includes('可在桌面处理/恢复'), '★ C-a 处理引导恒在（人得知道下一步能做什么）');
    ok(!only.includes('拦住'), '★ C-a 拦住 0 个下游 ⇒ **整句不出现**（不写"拦住了 0 个"这种没人要的信息）');

    const n3 = buildPauseNotice({ name: 'X', word: '已暂停', pauseReason: PAUSE_REASON_NO_OUTPUT, blockedDownstream: 3 });
    ok(n3.includes('无产出') && n3.includes('拦住了 3 个下游任务'),
      '★ C-b 拦住 n>0 ⇒ 因由**与**下游数同现（正面断言 n 的字面值与传入实算一致）');
    ok(buildPauseNotice({ name: 'X', word: '已暂停', pauseReason: PAUSE_REASON_NO_OUTPUT, blockedDownstream: 1 }).includes('拦住了 1 个下游任务'),
      '★ C-b 换一个 n（3→1）文案随之变 ⇒ 上一条不是"恒说 3"（判据非空转）');

    const slots = buildPauseNotice({ name: 'X', word: '已暂停', pauseReason: PAUSE_REASON_NO_OUTPUT, blockedDownstream: 0, parentSlots: { active: 5, max: 5 } });
    ok(slots.includes('5/5') && slots.includes('槽位'), '★ C-b′ 占满父槽位 ⇒ 正文点出 `5/5` 与"父因此建不出后续子任务"');

    const none = buildPauseNotice({ name: 'X', word: '已暂停', pauseReason: '', blockedDownstream: 0 });
    ok(none.includes('因未记录'), '★ C-c 账上**无因** ⇒ 明说「因未记录」（不静默留空、不编一个原因）');
    ok(!none.includes('：——'), '★ C-c …且不曾留下**空的**因由槽位（不写成"待复核：——可在桌面处理"）');

    // ★ 因由与补充说明**并列**（旧写法 `detail || label` 会让一句注解把账上事实整条顶掉）
    const both = buildPauseNotice({ name: 'X', word: '已暂停', pauseReason: PAUSE_REASON_ACCEPTANCE_FAILED, note: '引擎补充说明', blockedDownstream: 0 });
    ok(both.includes('验收未通过') && both.includes('引擎补充说明'),
      '★ C-d 因由与补充说明**同时在场**（注解不吃掉事实——旧式二选一会丢掉前者）');
    ok(none.includes('因未记录') && !buildPauseNotice({ name: 'X', word: '已暂停', pauseReason: PAUSE_REASON_ACCEPTANCE_FAILED, blockedDownstream: 0 }).includes('因未记录'),
      '★ C-d 反证：账上有因时不得出现「因未记录」⇒ 上一条不是"恒说未记录"');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M2·判据 C-1】接线在册：`buildTaskNotice` 的 paused 分支**仍**从账上派生因由');
  {
    const tnSrc = strip(path.join(MAIN, 'core/task-notice.ts'));
    // ① 位置判据——**按符号锚，不按行号**（行号是位置、会漂；本仓已三次被行号锚点咬）
    const caseAt = tnSrc.indexOf("case 'paused':");
    ok(caseAt > 0, '前置：找得到 `task-notice.ts` 的 `case \'paused\':` 分支（下两条的扫描面由它界定）');
    const branch = tnSrc.slice(caseAt, tnSrc.indexOf('break;', caseAt) + 'break;'.length);
    ok(/case 'paused'/.test(branch) && branch.includes('pauseReason'),
      '★ C-1① `paused` 分支内**确实**用了从账上取来的 `pauseReason`（按符号锚定，非行号）');
    ok(branch.includes('buildPauseNotice'),
      '★ C-1① …且该分支的正文由 `buildPauseNotice` 出（抽出的是构造，不是另立第二条链路）');
    // 取数走 M3 收成的那一处共用读点，而非在此另写一遍 JSON.parse
    ok(tnSrc.includes('recordedPauseReason('),
      '★ C-1① 因由原文经 `pause-reason.recordedPauseReason` 读出（**解析只此一处**；本文件不再自己 JSON.parse）');
    ok(strip(path.join(MAIN, 'core/pause-reason.ts')).includes('pause_reason'),
      '★ C-1① 该读点自身认的是账上的 `$.pause_reason`（键名唯一落点仍在 `pause-reason.ts`）');
    // 反证：把分支切片切错（取到 completed 分支）时谓词必须为假 ⇒ 上几条不是"随便切一段都真"
    const cAt = tnSrc.indexOf("case 'completed':");
    const wrongBranch = tnSrc.slice(cAt, tnSrc.indexOf('break;', cAt) + 'break;'.length);
    ok(!wrongBranch.includes('buildPauseNotice'), '反证：切到 `completed` 分支时谓词为假 ⇒ 上面那条不是"切哪段都真"');

    // ② 只读回放（§1.3-⑧ 的 10 条**既有**通知，逐条冻结为标本）
    //    ⚠ 【自纠⑩】原文要求"逐条**不变**"——对**带因的 4 条**成立且已钉；对**兜底的 6 条**按构造
    //    **不可能**逐字不变：本批第 3 项正是"无因时明说因未记录"（§4.1-3）。故此处钉的是
    //    **语义不变**：带因的仍带因且不再多说，兜底的仍兜底且**如实说出**未记录。全量逐字节对照
    //    须靠真库回放（环境依赖，不入本脚本——见 `rr_zx_20260905` 的 17/9-vs-26/0 教训）。
    //    ⚠ 且真库回放**根本不稳**：施工中复读同一读点（§4.4 带外证据），行数 10 → **12**、
    //    带因 4 → **3**——多出的两条是 §1.4-Ⅳ 新落的兜底；少掉的那条是 `1abd2bbd`，
    //    它**已 `completed`、账上 `$.pause_reason` 已被清点**，而它 06:22:13 那条通知正文
    //    仍是**写时快照**「子任务尚未完成」。⇒ 本组标本钉的是"该通知**写下时**的因由"，不是
    //    "该任务**今天**账上的因由"；二者已在真库上分家，勿据本组断言反推真库现状。
    const D = mkdb();
    const WITH_REASON: Array<[string, string, string]> = [
      ['9788ce4f', PAUSE_REASON_CHILDREN_INCOMPLETE, '子任务尚未完成'],
      ['8d2a8db6', PAUSE_REASON_NO_OUTPUT, '无产出'],
      ['27018cbb', PAUSE_REASON_NO_OUTPUT, '无产出'],
      // 基线读数里是带因的；⚠ 真库今日该行**因已被清**（已 completed）⇒ 标本按**写时**值钉
      ['1abd2bbd', PAUSE_REASON_CHILDREN_INCOMPLETE, '子任务尚未完成'],
    ];
    for (const [id, reason, label] of WITH_REASON) {
      addTaskFull(D, { id, status: 'paused', ctx: { pause_reason: reason } });
      const b = buildTaskNotice(D, id, 'paused').body;
      ok(b.includes(label) && !b.includes('因未记录'),
        `★ C-1② 既有带因样本 \`${id}\` 仍带因（「${label}」）且未添「因未记录」`);
    }
    const NO_REASON = ['9eb927bf', '3f9ffa88', '4870dd0b', '2b066b06', '9eb927bf-b', '4870dd0b-b'];
    for (const id of NO_REASON) {
      addTaskFull(D, { id, status: 'paused', ctx: {} });
      const b = buildTaskNotice(D, id, 'paused').body;
      ok(b.includes('因未记录') && b.includes('可在桌面处理/恢复'),
        `★ C-1② 既有兜底样本 \`${id}\` 仍兜底，且**如实说出**未记录（不是静默留白）`);
    }
    // ③ 反向断言：把同一条的 `$.pause_reason` 人为置空 ⇒ 同一条转出「因未记录」
    //    （证明该分支**确实读了它**，防"文案恰好来自别处"的假绿）
    addTaskFull(D, { id: 'c1-rev', status: 'paused', ctx: { pause_reason: PAUSE_REASON_NO_OUTPUT } });
    ok(buildTaskNotice(D, 'c1-rev', 'paused').body.includes('无产出'), '★ C-1③ 前置：置空前该条**确实**带因');
    D.prepare("UPDATE wa_tasks SET context_json = '{}' WHERE id = 'c1-rev'").run();
    ok(buildTaskNotice(D, 'c1-rev', 'paused').body.includes('因未记录'),
      '★ C-1③ 置空 `$.pause_reason` ⇒ **同一条**转出「因未记录」⇒ 该分支确实读的是它（非"文案来自别处"）');
    // 非 paused 的任务不得被套上暂停因（M1 起 / M2 后仍须成立）
    addTaskFull(D, { id: 'c1-exec', status: 'executing', ctx: { pause_reason: PAUSE_REASON_NO_OUTPUT } });
    ok(!buildTaskNotice(D, 'c1-exec', 'paused').body.includes('无产出'),
      '★ C-1③ 反证：账上非 `paused` ⇒ 不取 `pause_reason` 作注（否则"执行中"被安上暂停理由）');
    // 阻塞面：直接下游计数（`depends_on` 指向本任务且未终态者）
    addTaskFull(D, { id: 'c1-up', status: 'paused', ctx: { pause_reason: PAUSE_REASON_CHILDREN_FAILED } });
    addTaskFull(D, { id: 'c1-d1', status: 'pending', deps: 'c1-up' });
    addTaskFull(D, { id: 'c1-d2', status: 'executing', deps: 'c1-d1,c1-up' });
    addTaskFull(D, { id: 'c1-d3', status: 'completed', deps: 'c1-up' });
    addTaskFull(D, { id: 'c1-d4', status: 'archived', deps: 'c1-up' });
    // 子串陷阱：`c1-up` 是 `c1-upper` 的前缀，SQL 侧 LIKE 会误捞 ⇒ 必须由 JS 侧精确切分兜住
    addTaskFull(D, { id: 'c1-x1', status: 'pending', deps: 'c1-upper' });
    const upBody = buildTaskNotice(D, 'c1-up', 'paused').body;
    ok(upBody.includes('拦住了 2 个下游任务'),
      '★ C-1④ 拦住的是**非终态**下游（pending+executing 各一＝2；completed/archived 不占，子串同名者不计）');
    ok(!upBody.includes('拦住了 3') && !upBody.includes('拦住了 4'),
      '★ C-1④ 反证：终态下游与"前缀撞名"任务**都未被计入** ⇒ 上一条不是"把捞到的全数一遍"');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M2·判据 C-2】一次停只发一条通知（真 `recordNotification`：落行 + 仲裁）');
  {
    const mkNotice = (db: AnyDb, taskId: string) => ({
      paused: buildTaskNotice(db, taskId, 'paused'),
      awaiting: buildTaskNotice(db, taskId, 'awaiting_input'),
      deviation: buildTaskNotice(db, taskId, 'goal_deviation', { detail: '在改无关的样式表' }),
    });

    // ① 三族连发（**三种到达次序都试**——生产次序不固定，只测一种就是碰运气）
    const TYPE_OF: Record<string, string> = { paused: 'task.paused', awaiting: 'task.awaiting_input', deviation: 'task.goal_deviation' };
    const ORDERS: string[][] = [
      ['awaiting', 'paused', 'deviation'],
      ['paused', 'awaiting', 'deviation'],
      ['deviation', 'awaiting', 'paused'],
    ];
    // ⚠ 每轮换成**独立 taskId 且时钟严格递增**：`recordDedupe` 是模块级状态、跨用例共享，
    //   复用同一 id + 时钟回退会让第二轮的"重复到达"判据先命中 ⇒ 落 0 行（夹具自身的伪失败）。
    ORDERS.forEach((order, oi) => {
      const tid = `c2-t${oi}`;
      const db = mkdb();
      addTaskFull(db, { id: tid, status: 'paused', title: 'M0 基线固证', ctx: { pause_reason: PAUSE_REASON_CHILDREN_FAILED } });
      const n = mkNotice(db, tid);
      let tick = 1_000_000 + oi * 100_000;
      for (const k of order) {
        const notice = n[k as 'paused' | 'awaiting' | 'deviation'];
        recordNotification(db, { type: TYPE_OF[k]!, taskId: tid, title: notice.title, body: notice.body }, { now: tick += 10 });
      }
      eq(notifRows(db, tid), 1, `★ C-2 三族连发（次序 ${order.join('→')}）⇒ **恰好 1 行**（正面断言 3 → 1）`);
      const row = lastNotif(db, tid);
      eq(row.type, 'task.paused', `★ C-2 …且留下的那条是**说明力最强**者（次序 ${order.join('→')} ⇒ \`task.paused\`，非通用模板那条）`);
      ok(row.body.includes('子任务失败未处置'), '★ C-2 …且**留下的那条含因**（行数变 1 不算达标——留下的若非带因那条，病反而更重）');
      eq(countUnread(db), 1, '★ C-2 …且未读计数为 1（升级是**原地改那一行**，不产生第二行残留）');
    });

    // ② 反向：**不同任务**的三族各自成行（防"按任务一刀切合掉"）
    {
      const db = mkdb();
      const pairs: Array<[string, string]> = [['paused', 'r1'], ['awaiting', 'r2'], ['deviation', 'r3']];
      let tick = 2_000_000;
      for (const [k, id] of pairs) {
        addTaskFull(db, { id, status: 'paused', ctx: { pause_reason: PAUSE_REASON_NO_OUTPUT } });
        const notice = mkNotice(db, id)[k as 'paused' | 'awaiting' | 'deviation'];
        recordNotification(db, { type: TYPE_OF[k]!, taskId: id, title: notice.title, body: notice.body }, { now: tick += 10 });
      }
      ok(notifRows(db, 'r1') === 1 && notifRows(db, 'r2') === 1 && notifRows(db, 'r3') === 1,
        '★ C-2 反证：三族分属**不同任务** ⇒ 各成一行（不是"按任务名一刀切"、也不是"全局窗口内只留一条"）');
      eq(countUnread(db), 3, '★ C-2 反证：未读数 3 ⇒ 上面那条"恰好 1 行"不是"把所有人都合掉"');
    }

    // ③ 反向：**相隔远**（跨簇窗口）⇒ 各成一行。窗口取自导出常量（不另抄字面量）
    {
      const db = mkdb();
      addTaskFull(db, { id: 'v1', status: 'paused', ctx: { pause_reason: PAUSE_REASON_NO_OUTPUT } });
      const n = mkNotice(db, 'v1');
      const t0 = 3_000_000;
      recordNotification(db, { type: 'task.awaiting_input', taskId: 'v1', title: n.awaiting.title, body: n.awaiting.body }, { now: t0 });
      // 恰跨过窗口（`>=` 即过期）——用导出常量派生，不写死 8000
      recordNotification(db, { type: 'task.paused', taskId: 'v1', title: n.paused.title, body: n.paused.body }, { now: t0 + PAUSE_CLUSTER_WINDOW_MS });
      eq(notifRows(db, 'v1'), 2, `★ C-2 反证：两次**相隔 ≥ 簇窗口（${PAUSE_CLUSTER_WINDOW_MS}ms）** ⇒ 各成一行（窗口是"一次停"的界，不是"同任务永久合并"）`);
    }

    // ④ 反向：**非本簇**的通知不受仲裁管辖（同一任务同一刻也不合并）
    {
      const db = mkdb();
      addTaskFull(db, { id: 'f1', status: 'paused', ctx: { pause_reason: PAUSE_REASON_NO_OUTPUT } });
      const n = mkNotice(db, 'f1');
      const t0 = 4_000_000;
      recordNotification(db, { type: 'task.paused', taskId: 'f1', title: n.paused.title, body: n.paused.body }, { now: t0 });
      recordNotification(db, { type: 'task.completed', taskId: 'f1', title: '完成', body: '完成' }, { now: t0 + 10 });
      eq(notifRows(db, 'f1'), 2, '★ C-2 反证：`task.completed` 不属暂停簇 ⇒ 不被合掉（簇只治"一次停的三种说法"）');
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M2·判据 G-2】`buildPauseNotice` **一处实现、一处调用**（抽出来 ≠ 另写一份）');
  {
    const all = walkTs(MAIN);
    const rel = all.map((f) => path.relative(MAIN, f));
    const defs = rel.filter((f) => /export function buildPauseNotice\b/.test(strip(path.join(MAIN, f))));
    eq(defs, ['core/pause-reason.ts'], '★ G-2 `buildPauseNotice` **定义恰好 1 处**，且在词表所在的 `pause-reason.ts`');
    const calls = rel.filter((f) => (strip(path.join(MAIN, f)).match(/buildPauseNotice\(/g) || []).length > 1);
    eq(calls, [], '★ G-2 除定义处外**无第二处**出现 `buildPauseNotice(` ⇒ 无旁路调用点');
    const callers = rel.filter((f) => {
      const s = strip(path.join(MAIN, f));
      return s.includes('buildPauseNotice(') && !/export function buildPauseNotice\b/.test(s);
    });
    eq(callers, ['core/task-notice.ts'], '★ G-2 调用方**恰 1 处**＝`buildTaskNotice` 的 `paused` 分支所在文件（判据名＝扫描面）');
    // 「无第二处拼接暂停文案」：扫描面＝**整个 `src/main`**（把 renderer 排除在外是**错的**——
    // 它是词表的第二个落点；但那里只能**引**词表、不能另拼一份正文，故一并纳入本判据的扫描面另验）。
    const pasters = rel.filter((f) => /待复核：\$\{/.test(strip(path.join(MAIN, f))));
    eq(pasters, ['core/pause-reason.ts'], '★ G-2 暂停正文的拼接式样在 `src/main` **仅此一处**（无人另拼一份暂停文案）');
    // 反证：同一谓词喂一份手写拼接，必须被点名
    ok(['x.ts'].filter(() => /待复核：\$\{/.test('body = `任务「${n}」已暂停，待复核：${why}——可在桌面处理/恢复`;')).length === 1,
      '反证：手写拼接必被同一谓词点名 ⇒ 上面那条不是"正则恒不中"的空转');
    // renderer 那一侧：它跨 root **引**词表（与 main 同源），**不得**在渲染层另拼暂停正文
    const rdr = fs.readFileSync(path.join(root, `${A}/renderer/src/pages/TaskDetailPage.tsx`), 'utf-8');
    ok(rdr.includes("from '../../../src/main/core/pause-reason.js'") && rdr.includes('pauseReasonLabel'),
      '★ G-2 renderer 侧引 main 的**同一份**词表（承 G8 教训：渲染层是词表第二个落点，手抄必漂）');
    ok(rdr.includes('recordedPauseReason('),
      '★ G-2 …且因由原文也走同一读点（不在渲染层另写一遍 `JSON.parse(ctx).pause_reason`）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M5b·判据 I】D3 探索闸：计数尺与处置尺**同一把尺**（逐调用拒探索，收尾命令照常放行）');
  {
    // 行为面跑**真实现** `makeNonExplorationCappedTool`（不自造一个等价桩——自造即"第二把尺"）。
    // `seen` 只在**原实现真被委托**时记一笔 ⇒ "探索被拒"与"收尾放行"是同一次实验的两面。
    const seen: string[] = [];
    const original = {
      description: '混合类 shell（`bash`/`execute_command` 同形）',
      parameters: {},
      execute: (args: unknown): string => {
        const c = String((args as { command?: string }).command ?? '');
        seen.push(c);
        return `RAN:${c}`;
      },
    };
    const call = async (toolName: string, command: string): Promise<string> =>
      String(await makeNonExplorationCappedTool(toolName, original, '本次调用属探索类，已拒绝；工具本身仍可用，收尾命令照常放行。').execute({ command }));
    const refused = async (toolName: string, command: string): Promise<boolean> => {
      try { return typeof (JSON.parse(await call(toolName, command)) as { error?: string }).error === 'string'; }
      catch { return false; }
    };

    ok(await refused('bash', 'ls -la'), '★ I 探索类调用（`bash` 跑 `ls`）⇒ **被拒**');
    ok(await refused('bash', 'find . -name "*.ts"'), '★ I 探索类调用（`bash` 跑 `find`）⇒ 被拒');
    // 正面断言：**同一个工具**的收尾调用必须放行——第二只标本丢掉的正是这 6 次（跑测试、`git commit`）
    eq(await call('bash', "git commit -m 'M4 收口'"), "RAN:git commit -m 'M4 收口'", '★ I 收尾类（`bash` 跑 `git commit`）⇒ **放行**（原样委托原实现）');
    eq(await call('execute_command', 'python3 test_a20260917_2_m4.py'), 'RAN:python3 test_a20260917_2_m4.py', '★ I 收尾类（`execute_command` 跑测试脚本）⇒ 放行');
    ok(seen.some((c) => c.startsWith('git commit')) && seen.some((c) => c.startsWith('python3 test_')),
      '★ I 正面：放行**确已到达原实现**（两条都记进了 `seen`）——不是"没报错"就算过');
    ok(!seen.some((c) => /^(ls|find|grep)\b/.test(c)),
      '★ I 反证：被拒的探索调用**一次也没到达原实现**（防"一刀切放开"的假绿）');
    // 同尺的**代价**如实钉住：`py_compile` 在**两把尺上同判**（它本就计入 `exploreCmdN`）⇒ 仍被拒。
    // 本轮放行的是**不计数**的那类（`git commit` / 跑测试脚本），不是"给混合类开后门"。
    ok(await refused('execute_command', 'python3 -m py_compile a.py'),
      '★ I 同尺的代价如实钉住：`py_compile` 仍算探索类（与计数尺一致——它本就计入 `exploreCmdN`）⇒ 仍被拒');
    // 纯探索工具不因本批改口径（仍走整工具拉黑那一路）
    eq([isExplorationToolAlways('search_content'), isExplorationToolAlways('search_web'), isExplorationToolAlways('bash'), isExplorationToolAlways('execute_command')],
      [true, true, false, false], '★ I 分流判据：`search_*` 纯探索（整工具拉黑）／`bash`+`execute_command` 混合类（逐调用）');
    ok(MIXED_SHELL_TOOLS.has('bash') && MIXED_SHELL_TOOLS.has('execute_command') && !MIXED_SHELL_TOOLS.has('search_web'),
      '★ I `MIXED_SHELL_TOOLS` 恰为两个 shell 工具（纯探索工具不在其中）');

    // 静态接线：**尺一（计数）与尺二（处置）读同一份常量**，且旧的行内字面量已消
    // zx_20260929 M9：计数尺那一行与两条处置 loop（`pureKeys`/`cappedKeys`）都在**步回调内**，
    //   已随 `onStepFinish` 搬入 `core/exec-step.ts`。裸读执行体 ⇒ `body` 里查无此段，四条断言
    //   全部报成"机制没接线"（真回归的形状）。面换执行体侧（见 `execSideFace` 注释）。
    const exe = execSideFace;
    const body = exe.slice(exe.indexOf('export async function executeTask'));
    ok(body.includes('MIXED_SHELL_TOOLS.has(tc.toolName) && isExplorationCall(tc.toolName, tc.args)'),
      '★ I 静态：**计数尺**（`exploreCmdN++` 那一行）由 `MIXED_SHELL_TOOLS` 出，不再手写 `=== \'bash\' || === \'execute_command\'`');
    ok(!body.includes("tc.toolName === 'execute_command') && isExplorationCall"),
      '★ I 静态反证：旧的行内字面量**已消**（防"新常量加了、旧尺还在原地"的半修）');
    const loopOf = (head: string): string => braceBlock(body, body.indexOf(head));
    const pureLoop = loopOf('for (const k of pureKeys)');
    const cappedLoop = loopOf('for (const k of cappedKeys)');
    ok(pureLoop.includes('disableToolGracefully(') && pureLoop.includes('disabledTools.add(k)'),
      '★ I 静态：纯探索一路**仍整工具拉黑**（`search_content`/`search_web` 的既有行为不变＝§7bis.3 的反证）');
    ok(cappedLoop.includes('makeNonExplorationCappedTool(') && cappedLoop.includes('cappedTools.add(k)') && !cappedLoop.includes('disabledTools'),
      '★ I 静态：混合类一路走**逐调用桩**，且**未并入 `disabledTools`**（并入即把"收尾照常"谎报成"整个工具没了"）');
    ok(/收尾命令照常放行/.test(cappedLoop) && /不是/.test(cappedLoop),
      '★ I 静态：被拒的**正文自带出路**（明说"拒的是本次探索调用、收尾命令不受影响"）——123 次撞回即模型没读懂"已禁用"');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M5b·判据 G】"哪些工具是纯探索/哪些只能逐调用"**只有一处定义**（两尺由常量派生）');
  {
    const exe = strip(path.join(MAIN, 'core/agent-executor.ts'));
    // zx_20261018_1 批九「收」：这些"唯一真源"随策略纯函数搬到 `core/exec-strategy.ts`。
    //   判据仍是"**定义**恰好 1 处"——扫描面改为两处之和（再导出不算定义），并加反证：
    //   执行体内不得再出现同名声明（否则就是"搬了却留了一份"）。
    const strat = strip(path.join(MAIN, 'core/exec-strategy.ts'));
    const declCount = (n: string): number =>
      (strat.match(new RegExp(`(?:const|let|var)\\s+${n}\\b[^=\\n]*=`, 'g')) || []).length
      + (exe.match(new RegExp(`(?:const|let|var)\\s+${n}\\b[^=\\n]*=`, 'g')) || []).length;
    eq(declCount('EXPLORATION_TOOLS'), 1, '★ G `EXPLORATION_TOOLS` 定义恰好 1 处（新家 exec-strategy）');
    eq(declCount('MIXED_SHELL_TOOLS'), 1, '★ G `MIXED_SHELL_TOOLS` 定义恰好 1 处（计数尺与处置尺的唯一真源）');
    eq(declCount('D3_GATE_TOOLS'), 1, '★ G `D3_GATE_TOOLS` 定义恰好 1 处');
    eq((strat.match(/export function isExplorationToolAlways\b/g) || []).length, 1, '★ G `isExplorationToolAlways` 定义恰好 1 处（新家）');
    eq((strat.match(/export function makeNonExplorationCappedTool\b/g) || []).length, 1, '★ G 逐调用桩 `makeNonExplorationCappedTool` 定义恰好 1 处（新家）');
    eq((exe.match(/(?:export function|(?:const|let|var)) (?:isExplorationToolAlways|makeNonExplorationCappedTool|EXPLORATION_TOOLS|MIXED_SHELL_TOOLS|D3_GATE_TOOLS)\b/g) || []).length, 0,
      '★ G 反证：执行体内不再有第二份声明（"搬了却留一份"会在此处露馅）');
    // 扫描面按**符号**界定（`executeTask` 起）：模块级常量声明在其之前，已各自单独数过；
    // 此处查的是"**函数体内**有没有第二份手抄清单"——即改动前 `killKeys` 那种写法还在不在。
    const body = exe.slice(exe.indexOf('export async function executeTask'));
    eq(handLists(body), [], '★ G `executeTask` 体内**无手抄的工具名清单**（≥3 个 D3 工具名同现于一个字面量数组）');
    eq(handLists("const killKeys = ['search_content', 'search_web', 'execute_command', 'bash'].filter((k) => toolMap[k] && !disabledTools.has(k));").length, 1,
      '反证：把**改动前**的那行原样喂进同一判据 ⇒ 必被点名（否则上面那条只是"判据恒空"的假绿）');
    // 阈值为何是 3 而非 2：75% 档那条 `['search_content','search_web']` 是**另一个概念**（只禁搜索，有意不含 shell），
    // 按 ≥2 计会把它当"重抄第二份"误红——判据的扫描面须=它声称的范围。
    eq(handLists("const killKeys = ['search_content', 'search_web'].filter((k) => toolMap[k]);"), [],
      '★ G 反证：75% 档的**两元素**清单（另一个概念）不被误判 ⇒ 阈值不是随手定的');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M5b·判据 J】目标偏离判据「已完成感知」：只采信**真产出物**，且四处同一判据');
  {
    const devDb = (): AnyDb => {
      const d = new DatabaseSync(':memory:') as unknown as AnyDb;
      // ⚠ `name` 列必须与生产**同形**：M5c 起 `realDeliverables` 会 `SELECT name`（账本要显示产出物名），
      //    列不齐时查库抛错被 `catch` 吞 ⇒ J1/J5 这两条**由绿转红**（本夹具就这么被抓了一次：
      //    "夹具比生产窄，断言就只是在自我印证"）。列按 `database.ts` 的建表同形补齐。
      d.exec(`
        CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, name TEXT DEFAULT '', type TEXT DEFAULT '', status TEXT DEFAULT 'draft', file_path TEXT);
        CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT DEFAULT '', content TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
      `);
      return d;
    };
    let seq = 0;
    const addDeliv = (db: AnyDb, tid: string, type: string, status: string, filePath: string | null): void => {
      const name = filePath ? (filePath.split('/').pop() ?? type) : type;
      db.prepare('INSERT INTO wa_deliverables (id, task_id, name, type, status, file_path) VALUES (?,?,?,?,?,?)').run(`d${++seq}`, tid, name, type, status, filePath);
    };
    const addTool = (db: AnyDb, tid: string, name: string): void => {
      db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?,?, 'tool', ?)").run(`c${++seq}`, tid, `[${name}]\n{"ok":true}`);
    };
    /** 按生产调用形状组装豁免判据（`hasRealDeliverable` 也跑真实现，不喂自造的布尔） */
    const exemptOf = (db: AnyDb, tid: string, full: boolean, names: readonly string[]): boolean =>
      goalDeviationExempt({ fullDeviationInput: full, recentToolNames: names, hasRealDeliverable: hasRealDeliverable(db, tid) });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr_20260917_m5b_'));
    const realDoc = path.join(dir, 'test_a20260917_2_m4.py');
    fs.writeFileSync(realDoc, '# M4 交付\n', 'utf-8');

    // ── J1 真产出物 ⇒ 免（正面：值从无到有）──
    const j1 = devDb();
    ok(exemptOf(j1, 'j1', true, []) === false, '★ J1 前置：**未**登记产出物时不免（下方"免"不是恒真）');
    addDeliv(j1, 'j1', 'doc', 'draft', realDoc);
    ok(hasRealDeliverable(j1, 'j1') && exemptOf(j1, 'j1', true, []),
      '★ J1 登记 1 条 `doc` 且**文件确在落盘** ⇒ 免（免的依据只能是新判据——`recentToolNames` 为空、窗口那一支不成立）');
    fs.unlinkSync(realDoc);
    ok(exemptOf(j1, 'j1', true, []) === false,
      '★ J1 反证：把同一文件**删掉** ⇒ 同一条产出物不再算数（判据读的是"此刻在不在"，不是"登记过没有"）');
    fs.writeFileSync(realDoc, '# M4 交付\n', 'utf-8');

    // ── J2 只拿起过笔（★ D7 收窄的**正面**钉子）──
    const j2 = devDb();
    addTool(j2, 'j2', 'write_file');
    for (let i = 0; i < 5; i++) addTool(j2, 'j2', 'bash'); // 把它挤出 5 次窗口（窗口只认最近 5 条）
    eq(readRecentToolNames(j2, 'j2', 5), ['bash', 'bash', 'bash', 'bash', 'bash'],
      '★ J2 前置：窗口内**看不到** `write_file`（豁免若成立只可能来自新判据）');
    ok(!exemptOf(j2, 'j2', true, readRecentToolNames(j2, 'j2', 5)),
      '★ J2 会话里有 `write_file` 工具行、**但无任何产出物** ⇒ **不免**（分支②被 D7 排除——本次收窄的全部内容由这条钉住）');

    // ── J3 无任何证据 ⇒ 不免（防"把偏离检测关掉"的假绿）──
    const j3 = devDb();
    for (let i = 0; i < 3; i++) addTool(j3, 'j3', 'bash');
    ok(!exemptOf(j3, 'j3', true, readRecentToolNames(j3, 'j3', 5)), '★ J3 无产出物、无写出工具行 ⇒ 不免');

    // ── J4 反向（同源不破）：完成闸语义逐字不变 ──
    ok(realOutputEvidence(j2, 'j2') === true,
      '★ J4 反向：**仅分支②成立**（同 J2 夹具）时 `realOutputEvidence` 仍为 `true` ⇒ 抽 `hasRealDeliverable` 未顺改动完成闸语义');

    // ── J5 反向（不得按文件名长相判）──
    const j5 = devDb();
    const probeDoc = path.join(dir, '_probe_9f3a2c.py');
    fs.writeFileSync(probeDoc, '# 探针脚本\n', 'utf-8');
    addDeliv(j5, 'j5', 'doc', 'draft', probeDoc);
    ok(exemptOf(j5, 'j5', true, []), '★ J5 反向：文件名形似探针（`_probe_9f3a2c.py`）**仍免** ⇒ 本轮未再引入"按文件名长相判"的判据');

    // ── 窗口那一支（zx_20260915 既有行为）不被顶掉；回退开关关时一律不免 ──
    ok(!exemptOf(j3, 'j3', false, ['write_file']), '★ J 回退开关关（`engine.deviation_full_input=false`）⇒ 即使窗口内有写出工具也**不免**（关即逐字回到本轮前行为）');
    ok(exemptOf(j3, 'j3', true, ['bash', 'write_file']), '★ J 窗口那一支仍在：近 5 次内有产出性写入 ⇒ 免（既有行为未被顶掉）');

    // ── 静态：**四处同一判据**（会话行／事件⇒通知／自增／abort 全在同一守卫内）──
    // zx_20260929 M9：`deviationExempt` 守卫整段在步回调内 ⇒ 已随 `onStepFinish` 搬入 `core/exec-step.ts`。
    //   面换执行体侧；`gctx`（非 `StepScope` 成员）在搬后仍是局部量 ⇒ 针脚字面量不变。
    const exe = execSideFace;
    const body = exe.slice(exe.indexOf('export async function executeTask'));
    ok(guardedFour(body), '★ J 静态：`if (!deviationExempt) { … }` 的**配对括号内**同时含 会话行／事件／**自增**／abort 四处（只免 abort 未免自增＝半修：计数仍爬到上限，`ai-task` 照样硬停）');
    ok(!guardedFour("if (!deviationExempt) { insert('目标偏离提醒'); emit('task.goal_deviation'); } try { gctx.goal_deviation_restarts = restarts + 1; controller.abort(new Error('goal_deviation_restart')); } catch {}"),
      '反证：把**半修形状**（自增/abort 落到守卫之外）喂进同一判据 ⇒ 必被判红（否则上一条只是"含某个词即过"的空转）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M5c·判据 K】判定器看得见「已干完哪些」（账本）与「用户刚下的指令」（两路各自独立）');
  {
    const m5cDb = (): AnyDb => {
      const d = new DatabaseSync(':memory:') as unknown as AnyDb;
      d.exec(`
        CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, event_type TEXT,
          aggregate_type TEXT DEFAULT 'task', aggregate_id TEXT NOT NULL, payload TEXT DEFAULT '{}', occurred_at TEXT);
        CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, name TEXT DEFAULT '', type TEXT DEFAULT '',
          status TEXT DEFAULT 'draft', file_path TEXT);
        CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT DEFAULT '',
          content TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
      `);
      return d;
    };
    let c5 = 0;
    /** 落一条文件事件（`type` 取 `file.created|file.edited|file.updated`——三种**都是**落盘） */
    const addFileEvent = (db: AnyDb, tid: string, type: string, fp: string, at: string): void => {
      db.prepare('INSERT INTO wa_event_log (event_id, event_type, aggregate_id, payload, occurred_at) VALUES (?,?,?,?,?)')
        .run(`e${++c5}`, type, tid, JSON.stringify({ filePath: fp }), at);
    };
    const addConv = (db: AnyDb, tid: string, role: string, content: string, at = '2026-09-17 06:00:00'): void => {
      db.prepare('INSERT INTO wa_task_conversations (id, task_id, role, content, created_at) VALUES (?,?,?,?,?)')
        .run(`k${++c5}`, tid, role, content, at);
    };
    const addDeliv2 = (db: AnyDb, tid: string, name: string, type: string, status: string, filePath: string | null): void => {
      db.prepare('INSERT INTO wa_deliverables (id, task_id, name, type, status, file_path) VALUES (?,?,?,?,?,?)')
        .run(`dd${++c5}`, tid, name, type, status, filePath);
    };

    const kdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr_20260917_m5c_'));
    // M1 真标本的落盘时刻序（§1.4-Ⅲ）：F0.5(06:30:31) → F0.4(06:30:46) → F0.3(06:31:02–08) → F0.2(06:31:57–32:31)
    const F = ['F0.5', 'F0.4', 'F0.3', 'F0.2'];
    const PATH_OF: Record<string, string> = {
      'F0.5': '/w/a/scripts/test_a20260916_m1b_target_pct.py',
      'F0.4': '/w/a/scripts/test_alert_dashboard.py',
      'F0.3': '/w/a/scripts/position_optimizer.py',
      'F0.2': '/w/a/premarket_workflow.py',
    };
    const AT_FWD: Record<string, string> = {
      'F0.5': '2026-09-17T06:30:31Z', 'F0.4': '2026-09-17T06:30:46Z',
      'F0.3': '2026-09-17T06:31:02Z', 'F0.2': '2026-09-17T06:31:57Z',
    };
    const AT_REV: Record<string, string> = {
      'F0.5': '2026-09-17T06:31:57Z', 'F0.4': '2026-09-17T06:31:02Z',
      'F0.3': '2026-09-17T06:30:46Z', 'F0.2': '2026-09-17T06:30:31Z',
    };
    const seedFiles = (db: AnyDb, tid: string, at: Record<string, string>): void => {
      for (const k of F) {
        addFileEvent(db, tid, 'file.edited', PATH_OF[k]!, at[k]!);
        // 每条再叠一次"同文件二次编辑"与一次覆盖写入：归并到路径后**不得**产生第二行、也不得改变次序
        addFileEvent(db, tid, 'file.updated', PATH_OF[k]!, at[k]!.replace(/:(\d\d)Z$/, ':59Z'));
        addFileEvent(db, tid, 'file.updated', PATH_OF[k]!, at[k]!.replace(/:(\d\d)Z$/, ':59Z'));
      }
    };
    /** 位置序：某段子串在另一段中的下标（`-1` 视为"不在场"，用于"顺序"这类断言） */
    const at = (s: string, sub: string): number => s.indexOf(sub);
    /** 路径末段（账本渲染的是"末两段"，比对时取末段即可钉住是哪个文件） */
    const base = (p: string): string => p.split('/').pop() ?? '';

    // ── K1 正面（复刻 M1）：落盘时刻**符合**指定顺序 ⇒ 账本如实呈现该顺序，且**进了发给判定器的 prompt** ──
    const k1 = m5cDb();
    seedFiles(k1, 'k1', AT_FWD);
    addConv(k1, 'k1', 'assistant', 'F0.3 已补齐 position_optimizer 的 score=50 分支');
    addConv(k1, 'k1', 'assistant', 'F0.2 已补 premarket_workflow 的裸同族导入守卫');
    const files1 = collectWrittenFiles(k1, 'k1');
    eq(files1.length, F.length,
      '★ K1 前置：4 个文件各**归并成一行**（12 条事件——含 `file.updated` 覆盖写入——归并到路径后不多不少）');
    eq(files1.map((x) => base(x.path)), F.map((k) => base(PATH_OF[k]!)),
      '★ K1 账本顺序 == **真实落盘时刻序**（F0.5→F0.4→F0.3→F0.2；归并取的是**首次**落盘时刻，二次编辑不夺序）');
    ok(files1.every((x) => x.at.length >= 19), '★ K1 每行带**时刻**（"顺序"的证据本身——只给文件名等于把顺序判据留空）');
    const block1 = buildCompletedItemsBlock({ files: files1, deliverables: realDeliverables(k1, 'k1') });
    const K1_GOAL = '按 §3-F0/§5-M1 指定顺序完成 F0.5→F0.4→F0.3→F0.2 四项';
    const p1 = buildDeviationPrompt({ goal: K1_GOAL, recentText: 'F0.3、F0.2 已核对', completedItems: block1 });
    ok(p1.includes(block1) && block1.includes('[已落盘文件]'),
      '★ K1 账本**确已进入发给判定器的 prompt**（仅"函数能返回这段"不足以证明它被送上去了）');
    ok(p1.includes('「未提及」不等于「未做」') && p1.includes('只能依据本表的时间序') && p1.includes('不得推定为倒置'),
      '★ K1 三条规则明文在场：未提及≠未做 / 顺序只能依据本表 / 本表没有的顺序不得推定倒置');
    ok(at(block1, 'test_a20260916_m1b_target_pct.py') < at(block1, 'premarket_workflow.py'),
      '★ K1 渲染序：F0.5 的行在 F0.2 的行**之前**（承载"符合指定顺序"这一事实）');

    // ── K2 反向（唯一"该命中"夹具；⚠ **合成**，非真标本——§7ter.4-2）──
    //    同一目标、同一尾部，但落盘时刻**确实倒置**。判据不声称"LLM 一定判偏离"，只钉住
    //    **账本是顺序中立的转述**：倒置就渲染成倒置，绝不替目标"圆"成合规顺序。
    const k2 = m5cDb();
    seedFiles(k2, 'k2', AT_REV);
    const files2 = collectWrittenFiles(k2, 'k2');
    eq(files2.map((x) => base(x.path)), [...F].reverse().map((k) => base(PATH_OF[k]!)),
      '★ K2 反向：落盘**确实倒置**时，账本如实渲染成倒置（F0.2 在最前）⇒ 判定器据本表读到的仍是"倒置"，偏离检测**未被关掉**');
    const block2 = buildCompletedItemsBlock({ files: files2 });
    ok(at(block2, 'premarket_workflow.py') < at(block2, 'test_a20260916_m1b_target_pct.py'),
      '★ K2 反向的正面在场：倒置夹具下 F0.2 的行在 F0.5 的行之前（上一条不是"顺序断言恒真"）');

    // ── K3 反向：空账本不得被读成"全做完" ──
    const k3 = m5cDb();
    const block3 = buildCompletedItemsBlock({ files: collectWrittenFiles(k3, 'k3'), deliverables: realDeliverables(k3, 'k3') });
    eq(block3, '', '★ K3 反向：无任何落盘事实 ⇒ 账本段**整体为空串**（不得渲染出"没有缺口"的暗示）');
    const p3 = buildDeviationPrompt({ goal: K1_GOAL, recentText: 'x', completedItems: block3, userDirective: '' });
    ok(!p3.includes('[已落盘文件]') && !p3.includes('[已登记产出物]') && !p3.includes('不等于「未做」'),
      '★ K3 反证：空账本时 prompt 里**不含**账本段任何痕迹（"表为空 ⇒ 全完成"这条误读无门可入）');

    // ── K4 同源不破：不传新参 ⇒ 输出与改前**逐字相同** ──
    const baseArgs = { goal: '把报告写完', successCriteria: '三章齐', recentText: '最近进展', toolNames: ['bash'], blockers: '缺产出' };
    const pOld = buildDeviationPrompt({ ...baseArgs });
    const pExplicitEmpty = buildDeviationPrompt({ ...baseArgs, completedItems: '', userDirective: '' });
    eq(pOld, pExplicitEmpty, '★ K4：不传与传空串**逐字相同**（两个新参缺省即不出现）');
    ok(!pOld.includes('[已落盘文件]') && !pOld.includes('用户/系统最近下达的指令'),
      '★ K4：改前形状里**不含**两段新内容（旧调用点行为零变化）');
    ok(buildDeviationPrompt({ ...baseArgs, completedItems: block1 }) !== pOld,
      '★ K4 反证：真喂账本时输出**确实变了** ⇒ 上一条的"相同"不是"新参被忽略"的空转');

    // ── K5 正面（复刻失明⑦）：**只喂指令、不喂账本** —— 与 K1 独立 ──
    const k5 = m5cDb();
    ok(collectWrittenFiles(k5, 'k5').length === 0 && realDeliverables(k5, 'k5').length === 0,
      '★ K5 前置：本夹具**账本为空**（"不触发"若成立只可能来自指令那一支——两路各自独立可辨）');
    addConv(k5, 'k5', 'user', '已按指定顺序完成 F0.5→F0.4→F0.3→F0.2（落盘文件与方案一致，先后即为该序），无需回头。现在只剩 F0.6 与 F0.1 两项：请继续完成这两项，每项单独验证并双向 diff 证零回归，全套件全绿后回填 §5。', '2026-09-17 06:55:07');
    const dirs5 = readRecentUserDirectives(k5, 'k5');
    eq(dirs5.length, 1, '★ K5 取数：最近 `user` 指令**一条**被取到');
    ok(dirs5[0]!.includes('现在只剩 F0.6 与 F0.1 两项') && dirs5[0]!.startsWith('06:55:07'),
      '★ K5 取数：正文与时刻俱在（时刻用得上——"更晚的指令"才压得住目标里的顺序）');
    const dblock5 = buildUserDirectiveBlock(dirs5);
    const p5 = buildDeviationPrompt({ goal: K1_GOAL, recentText: '我先重新核对 F0.6 与 F0.1 的原文要求', userDirective: dblock5 });
    ok(p5.includes(dblock5) && p5.includes('现在只剩 F0.6 与 F0.1 两项'),
      '★ K5 指令**确已进入 prompt**（照指令办事从此有据可依；这正是 §1.4-Ⅳ 被读成"偏离证据"的那一句）');
    ok(p5.includes('**用户指令优先于上述目标中的执行顺序**'),
      '★ K5 规则明文：用户指令优先于目标里的执行顺序');

    // ── K5-rev 反向：指令是**并列事实**，不是免死金牌 ──
    ok(dblock5.includes('只有当它做的事既不符合目标、也不符合该指令时才判偏离'),
      '★ K5-rev：指令段的规则**自带限缩**（不是"有指令即免检"）');
    ok(isBlanketDirectiveBlock('用户指令为准，一律不判偏离。'),
      '反证：把"指令即免检"的过宽变体喂进同一判据 ⇒ 必被判红（否则上一条只是"含某个词即过"）');
    ok(isBlanketDirectiveBlock('注意：用户最近下达的指令为：先做 C。') === true && !isBlanketDirectiveBlock(dblock5),
      '★ K5-rev 正面在场：**只说优先、不带限缩**也是过宽变体；真实现的指令段两者皆不犯（上一条不是恒真）');

    // ── K5 取数独立性（防"账本有内容"冒充"指令进了判分器"）──
    const k5b = m5cDb();
    addConv(k5b, 'k5b', 'system', '[工具调用] bash({"command":"git status"})');
    eq(readRecentUserDirectives(k5b, 'k5b').length, 0,
      '★ K5 独立：`system` 行的 `[工具调用]` 噪声**不**被当作指令（只认 `role=\'user\'` —— 掺进噪声会把账本淹掉）');
    addConv(k5b, 'k5b', 'user', '请优先做 C', '2026-09-17 07:00:00');
    addConv(k5b, 'k5b', 'user', '请优先做 C', '2026-09-17 07:00:01');
    eq(readRecentUserDirectives(k5b, 'k5b').length, 1,
      '★ K5 独立：**同文重复行**（压缩回放重写）去重成 1 条——不去重则两行同文占满窗口、真指令被挤掉');

    // ── 上限：显示封顶须**如实说**（不得静默截断）──
    const many = Array.from({ length: COMPLETED_ITEMS_FILE_LIMIT + 3 }, (_, i) => ({ path: `/w/f${String(i).padStart(2, '0')}.py`, at: `2026-09-17T06:${String(10 + i).padStart(2, '0')}:00Z` }));
    const blockMany = buildCompletedItemsBlock({ files: many });
    ok(blockMany.includes(`共 ${many.length} 项`) && blockMany.includes(`只列前 ${COMPLETED_ITEMS_FILE_LIMIT} 项`),
      '★ 超限**如实说**「共 N 项、只列前 N 项」（静默截断会让判定器把"没列出来"再读成"没做"——正是本批要治的病）');
    ok(blockMany.split('\n').filter((l) => l.startsWith('- ') && l.includes('.py')).length === COMPLETED_ITEMS_FILE_LIMIT,
      `★ 超出部分确未列出（行数恰为 ${COMPLETED_ITEMS_FILE_LIMIT}）`);

    // ── 指令单条上限（沿"每段有界"形制）──
    const kLong = m5cDb();
    addConv(kLong, 'kLong', 'user', 'X'.repeat(USER_DIRECTIVE_MAX_CHARS + 50));
    const dLong = readRecentUserDirectives(kLong, 'kLong');
    ok(dLong[0]!.includes('…') && dLong[0]!.length < USER_DIRECTIVE_MAX_CHARS + 40,
      '★ 单条指令**有界**（超长截断并留省略号，不挤占既有 3×400 输入面）');

    // ── 判据 L（一处真源）：`realDeliverables` 只有一处定义，且账本与豁免读**同一个** ──
    // zx_20260929 M9：账本第二路的 `buildCompletedItemsBlock({…})` 调用点在步回调内 ⇒ 面换执行体侧
    //   （`realDeliverables`/`hasRealDeliverable` 的**定义**仍在执行体，定义计数不受并集影响）。
    const exeL = execSideFace;
    eq((exeL.match(/export function realDeliverables\b/g) || []).length, 1,
      '★ L：`realDeliverables` **定义恰好 1 处**（"什么算交付物"的唯一判据）');
    const hrdAt = exeL.indexOf('export function hasRealDeliverable(');
    ok(hrdAt > 0, '★ L 前置：找得到 `hasRealDeliverable`（下一条的扫描面由它界定）');
    ok(/return realDeliverables\(db, taskId\)\.length > 0;/.test(braceBlock(exeL, hrdAt)),
      '★ L：`hasRealDeliverable` 体内**无第二份判据**——原样转问 `realDeliverables`（M5b 真值表逐字不变）');
    ok(/buildCompletedItemsBlock\(\{ files: collectWrittenFiles\(db, taskId\), deliverables: realDeliverables\(db, taskId\) \}\)/.test(exeL),
      '★ L：账本第二路读的**就是** `realDeliverables`（不是又写一条 `SELECT … FROM wa_deliverables`）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M5c·判据 K-接线】两个新事实**确已接到调用点**，且同受 `engine.deviation_full_input` 门控');
  {
    // zx_20260929 M9：`checkGoalDeviation` 的**调用点**与两个受门控的实参声明都在步回调内 ⇒ 面换执行体侧。
    //   `stripStepScopePrefix` 把 `d.db`/`d.taskId` 还原成 `db`/`taskId`，使下方"取数在调用侧"的
    //   字面量针脚与搬迁前一致（`completedItems`/`userDirective` 本是步内局部量）。
    const exe = execSideFace;
    const body = exe.slice(exe.indexOf('export async function executeTask'));
    const callAt = body.indexOf('await checkGoalDeviation(');
    ok(callAt > 0, '★ 前置：找得到 `checkGoalDeviation` 调用点（下方断言的扫描面）');
    const argsSrc = callArgs(body.slice(callAt), 'await checkGoalDeviation') ?? '';
    const args = topLevelArgs(argsSrc);
    eq(args.length, 9, `★ 接线：实参**恰 9 个**（前 7 位一位未动，两个新事实为第 8/9 参）`);
    ok(/^\s*completedItems\s*$/.test(args[7] ?? '') && /^\s*userDirective\s*$/.test(args[8] ?? ''),
      '★ 接线：第 8/9 参分别传 `completedItems`/`userDirective`（与上一行**同批**新事实）');
    // 门控：两个变量的**声明**各自以 `fullDeviationInput ?` 起、以 `: ''` 收 —— 关 ⇒ 逐字回到本轮前
    for (const [name, decl] of [['completedItems', 'const completedItems ='], ['userDirective', 'const userDirective =']] as const) {
      const i = body.indexOf(decl);
      const stmt = i < 0 ? '' : body.slice(i, body.indexOf(';', i) + 1);
      ok(/^\s*const\s+\w+\s*=\s*fullDeviationInput\s*\?[\s\S]*:\s*'';$/.test(stmt),
        `★ 接线：\`${name}\` 由 \`fullDeviationInput\` 三元门控（开关关 ⇒ 传空串 ⇒ 判定器输入逐字回到本轮前）`);
    }
    ok(!/^\s*const\s+\w+\s*=\s*fullDeviationInput\s*\?[\s\S]*:\s*'';$/.test("const bad = buildUserDirectiveBlock(readRecentUserDirectives(db, taskId));"),
      '反证：把**无门控**的声明喂进同一判据 ⇒ 必被判红（否则上面两条只是"含 `fullDeviationInput` 即过"的空转）');
    ok(body.includes('readRecentUserDirectives(db, taskId)') && body.includes('collectWrittenFiles(db, taskId)'),
      '★ 接线：两路取数**都在调用侧**（`buildCompletedItemsBlock`/`buildDeviationPrompt` 内不读 db、不读 setting）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M4·判据 E】读面：「判卷看得见什么」的界 == **整棵树**（父持方案、子干活 ⇒ 子判卷须看得见父名下那份文件）');
  {
    const m4Db = (): AnyDb => {
      const d = new DatabaseSync(':memory:') as unknown as AnyDb;
      d.exec(`
        CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
        CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', title TEXT DEFAULT '',
          status TEXT DEFAULT 'pending', parent_task_id TEXT DEFAULT '', context_json TEXT DEFAULT '{}');
        CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '',
          type TEXT DEFAULT '', name TEXT DEFAULT '', description TEXT DEFAULT '', file_path TEXT,
          status TEXT DEFAULT 'draft', updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT DEFAULT '', role TEXT DEFAULT '',
          content TEXT DEFAULT '', token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
      `);
      return d;
    };
    let c4 = 0;
    const t4 = (db: AnyDb, id: string, parent: string): void => {
      db.prepare('INSERT INTO wa_tasks (id, project_id, status, parent_task_id) VALUES (?,?,?,?)').run(id, 'P4', 'running', parent);
    };
    const d4 = (db: AnyDb, tid: string, name: string, fp: string): void => {
      db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status) VALUES (?,?,?,'doc',?,?,'draft')")
        .run(`m4d${++c4}`, 'P4', tid, name, fp);
    };
    const v4 = (db: AnyDb, tid: string, content: string): void => {
      db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?,?,'assistant',?)").run(`m4c${++c4}`, tid, content);
    };
    /** 判卷侧的**读盘口**（与生产调用点同形：不存在当没有、读失败当没有） */
    const reader = (p: string): string | null => { try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; } catch { return null; } };

    const m4dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr_20260917_m4_'));
    fs.mkdirSync(path.join(m4dir, 'scripts'), { recursive: true });
    const scriptPath = path.join(m4dir, 'scripts', 'inspect_baseline_a20260917_2.py');
    fs.writeFileSync(scriptPath, 'print("baseline families")\n', 'utf-8');

    // 夹具**逐字复刻真标本 9eb927bf 的形状**（§1.4-Ⅲ / §6.0bis-a 实测）：子任务自己名下 **0 行**，
    // 那份脚本登记在**父**名下、文件真在磁盘上。
    const e1 = m4Db();
    t4(e1, 'child', 'parent');
    t4(e1, 'parent', '');
    d4(e1, 'parent', 'scripts/inspect_baseline_a20260917_2', scriptPath);
    v4(e1, 'parent', '父：方案已写入 plans/project/，子任务照此实施');
    eq((e1.prepare('SELECT COUNT(*) AS c FROM wa_deliverables WHERE task_id = ?').get('child') as { c: number }).c, 0,
      '★ E-1 前置（0→1 的「0」）：标本**自己名下 0 行**产出物 —— 窄面**结构上不可能**看得见它');
    const eb = collectEvidence(e1, 'child');
    eq(eb.docFiles.map((p) => path.basename(p)), ['inspect_baseline_a20260917_2.py'],
      '★ E 取数：整树取数看到**父**名下那条 doc（`taskTreeIds` 上溯生效，不是只往下载）');
    const evE = renderEvidence(eb, reader);
    ok(evE.includes('[文件 inspect_baseline_a20260917_2.py]'),
      '★ E 正面：证据面含该文件的**正文摘录**（子判卷从此看得见父名下那份交付物——"盲判"的界被挪开了）');
    ok(evE.includes('print("baseline families")'),
      '★ E 正面：摘录是**正文**而非只有文件名（"看得见"须看得见内容，否则等于换了个方式的看不见）');
    ok(evE.includes('[产出物] scripts/inspect_baseline_a20260917_2'),
      '★ E 正面：产出物清单一并走整树（`deliverables` 与 `docFiles` 同源，不是只放开了正文那一路）');
    // 反证：把同一条取数**原样收窄回旧写法**（`WHERE task_id = 本任务`）⇒ 0 条
    const narrowE = (e1.prepare("SELECT file_path FROM wa_deliverables WHERE task_id = ? AND type = 'doc' AND file_path IS NOT NULL AND file_path != ''").all('child') as unknown[]).length;
    eq(narrowE, 0,
      '★ E 反证：旧写法（只本任务）在同一夹具上得 **0 条** ⇒ 上面那条摘录只可能来自**整树**取数，可见性确是本轮这一改带来的');

    // ── E-收窄（§6.0bis-g）：**只有产出物两路**走整树，`convs` 仍以本任务为界 ──
    ok(!evE.includes('[产出] '),
      '★ E 收窄：`convs` **仍以本任务为界** —— 父名下那条会话**不**进证据面（不是"整棵树的东西都端上来"）');
    v4(e1, 'child', '子：已完成 F0.5 校验');
    ok(renderEvidence(collectEvidence(e1, 'child'), reader).includes('[产出] 子：已完成 F0.5 校验'),
      '★ E 收窄的正面在场：子**自己**名下的会话照常进面（上一条不是"这一路整个坏了"而显得为空）');

    // ── E-上限：**取数不截、显示截**（范围放开之后不得把验收提示词塞爆） ──
    const many = m4Db();
    t4(many, 'solo', '');
    for (let i = 0; i < EVIDENCE_FILE_BITS_LIMIT + 2; i++) {
      const fp = path.join(m4dir, 'scripts', `f${i}.py`);
      fs.writeFileSync(fp, `print(${i})\n`, 'utf-8');
      d4(many, 'solo', `scripts/f${i}`, fp);
    }
    const mb = collectEvidence(many, 'solo');
    eq(mb.docFiles.length, EVIDENCE_FILE_BITS_LIMIT + 2,
      '★ E 上限：**取数不截**（整树化之后路径清单一并放开——不在这里偷偷丢掉"看得见"）');
    eq((renderEvidence(mb, reader).match(/\[文件 /g) || []).length, EVIDENCE_FILE_BITS_LIMIT,
      `★ E 上限：提示词里至多 ${EVIDENCE_FILE_BITS_LIMIT} 份正文摘录（与改动前的**显示**上限一致，范围放开不等于输入膨胀）`);

    // ── E-真标本（**只读**回放，环境依赖：真库 + a-stock 源码树俱在才跑） ──
    //    只证"看得见"，**不**证"判得对"：M0 判据 4/5 真未达（§1.5-3），重跑判卷仍应判 1/5 或 2/5。
    const realDbPath = path.join(root, 'data/worker-ant-server.db');
    const SPEC_M0 = '9eb927bf-f1c0-4eea-8062-247e69f0de3e';
    if (!fs.existsSync(realDbPath)) {
      console.log('  ⚠ 跳过 E-真标本：真库不在（`data/worker-ant-server.db` 是 dev 本机数据）');
    } else {
      const rdb = new DatabaseSync(realDbPath, { readOnly: true }) as unknown as AnyDb;
      try {
        const has = (rdb.prepare('SELECT COUNT(*) AS c FROM wa_tasks WHERE id = ?').get(SPEC_M0) as { c: number }).c > 0;
        const rdv = has ? realDeliverables(rdb as never, SPEC_M0) : [];
        const py = rdv.find((d) => String(d.file_path ?? '').endsWith('inspect_baseline_a20260917_2.py'));
        if (!has) console.log('  ⚠ 跳过 E-真标本：标本不在本库');
        else if (!py) console.log('  ⚠ 跳过 E-真标本：该文件登记行已不在（或文件已不在磁盘）——真库是活的');
        else {
          eq((rdb.prepare('SELECT COUNT(*) AS c FROM wa_deliverables WHERE task_id = ?').get(SPEC_M0) as { c: number }).c, 0,
            '★ E-真标本：该标本**自己名下 0 行**（可见性只可能来自整树）');
          const rev = renderEvidence(collectEvidence(rdb as never, SPEC_M0), reader);
          ok(rev.includes(`[文件 ${path.basename(String(py.file_path))}]`),
            '★ E-真标本（只读回放，不写库、不回填）：M0 标本的证据面**确含** `scripts/inspect_baseline_a20260917_2.py` 的正文摘录');
          ok(rev.length > 0, '★ E-真标本：证据面非空（上一条不是"整个面是空的恰好包含"）');
        }
      } finally { rdb.close(); }
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M4·判据 F】写面：子进程落盘 / 文件被编辑 ⇒ 进得了产出物与证据面（**真工具体**，不复刻其 SQL）');
  {
    // 夹具：M4 三工具需要的列（`buildTools` 只从 ctx 取 `db`；`wa_settings` 供写面开关读取）。
    const w4Db = (): AnyDb => {
      const d = new DatabaseSync(':memory:') as unknown as AnyDb;
      d.exec(`
        CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
        CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', title TEXT DEFAULT '',
          status TEXT DEFAULT 'pending', parent_task_id TEXT DEFAULT '', context_json TEXT DEFAULT '{}');
        CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '',
          type TEXT DEFAULT '', name TEXT DEFAULT '', description TEXT DEFAULT '', file_path TEXT,
          status TEXT DEFAULT 'draft', updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE wa_deliverable_versions (id TEXT PRIMARY KEY, deliverable_id TEXT, file_path TEXT,
          content_snapshot TEXT, size INTEGER, version INTEGER, changed_by TEXT);
        CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT DEFAULT '', role TEXT DEFAULT '',
          content TEXT DEFAULT '', token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
      `);
      return d;
    };
    const wdb = w4Db();
    wdb.prepare('INSERT INTO wa_tasks (id, project_id, status) VALUES (?,?,?)').run('T', 'P', 'running');
    const wdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr_20260917_m4w_'));
    // ctx 只需要 `db`——`buildTools` 的签名就是 (ctx, taskId, projectId, workingDir)；
    // 真工具体因此可被**受控回归**直跑（比对 SQL 手抄一遍强得多：抄的那份不会跟着实现漂）。
    const tools = buildTools({ db: wdb } as never, 'T', 'P', wdir) as unknown as Record<string, { execute: (a: never) => Promise<string> }>;
    ok(Object.keys(tools).length > 50, '★ F 前置：真工具集建成（下面对 `execute_command`/`edit_file` 的断言走的是**实现本尊**）');
    const reader = (p: string): string | null => { try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; } catch { return null; } };
    const evOf = (): string => renderEvidence(collectEvidence(wdb, 'T'), reader);
    const rowsOf = (): Array<{ name: string; type: string; status: string; file_path: string }> =>
      wdb.prepare('SELECT name, type, status, file_path FROM wa_deliverables ORDER BY rowid').all() as never;

    // ── F-1 归因窗口 = **该条命令自身**（§6.1-3 红线：不许"最近 N 分钟"一刀切）──
    const stale = path.join(wdir, 'old.py');
    fs.writeFileSync(stale, 'old\n', 'utf-8');
    const longAgo = new Date(Date.now() - 10_000);
    fs.utimesSync(stale, longAgo, longAgo); // 明确定在命令之前，不受 mtime 分辨率影响
    await tools.execute_command!.execute({ command: 'echo noop' } as never);
    eq(rowsOf().length, 0,
      '★ F-1 反证：跑一条**不写文件**的命令 ⇒ **0 行**登记 ⇒ 不是"命令一跑就把目录里所有东西收成成果"（目录里确有 `old.py`）');
    await tools.execute_command!.execute({ command: "printf 'x' > new.py" } as never);
    const r1 = rowsOf();
    eq(r1.map((r) => path.basename(r.file_path)), ['new.py'],
      '★ F-1 正面（0→1）：命令窗口内写出的 `new.py` **恰一行**登记为 doc 产出物');
    eq([r1[0]!.type, r1[0]!.status], ['doc', 'draft'], '★ F-1：登记形状与 `write_file` 同尺（`doc`/`draft`）');
    ok(evOf().includes('[文件 new.py]'),
      '★ F-1 正面：该文件**出现在判卷的证据面**（写面补上了，读面就看得见——两半合起来才是这一批的交付）');
    ok(!evOf().includes('[文件 old.py]'), '★ F-1 反证：命令前就在的 `old.py` **仍未被登记** ⇒ 归因窗口是该条命令，不是"目录里的一切"');

    // ── F-2 `edit_file` 入口（第二只标本 §1.4-Ⅱ：真交付物 9 次 edit、零登记）──
    const alertPath = path.join(wdir, 'alert_dashboard.py');
    fs.writeFileSync(alertPath, 'def build():\n    return 1\n', 'utf-8'); // 磁盘上有、**登记里没有**
    eq(rowsOf().filter((r) => path.basename(r.file_path) === 'alert_dashboard.py').length, 0,
      '★ F-2 前置（0→1 的「0」）：`alert_dashboard.py` 落盘但**零登记**（逐字复刻 M4 标本 `4870dd0b` 的病灶）');
    // zx_20261002 M17-①「先读后改」：夹具照生产次序——模型改前**先读过**（否则门禁拒绝，本段断言会假红）。
    await tools.read_file!.execute({ filePath: 'alert_dashboard.py' } as never);
    await tools.edit_file!.execute({ filePath: 'alert_dashboard.py', old_string: 'return 1', new_string: 'return 2' } as never);
    const alertRows = rowsOf().filter((r) => path.basename(r.file_path) === 'alert_dashboard.py');
    eq(alertRows.length, 1, '★ F-2 正面（0→1）：对**未登记**文件的 `edit_file` 补上了登记');
    ok(evOf().includes('[文件 alert_dashboard.py]'), '★ F-2 正面：它进了证据面（"9 次编辑、+233 行"的那类活从此不再盲判）');
    const alertId = (wdb.prepare('SELECT id FROM wa_deliverables WHERE file_path = ?').get(alertPath) as { id: string }).id;
    const verCount = (): number => (wdb.prepare('SELECT COUNT(*) AS c FROM wa_deliverable_versions WHERE deliverable_id = ?').get(alertId) as { c: number }).c;
    const vAfter1 = verCount();
    await tools.edit_file!.execute({ filePath: 'alert_dashboard.py', old_string: 'return 2', new_string: 'return 3' } as never);
    const alertRows2 = rowsOf().filter((r) => path.basename(r.file_path) === 'alert_dashboard.py');
    eq(alertRows2.length, 1, '★ F-2 反向：对**已登记**文件的二次 `edit_file` **不新增第二行**（仍走既有版本快照，不重复计）');
    ok(vAfter1 >= 1 && verCount() > vAfter1,
      '★ F-2：版本快照**照常累加**（登记位置在快照块之前 ⇒ 新建行也拿得到第 1 版；"不重复登记"不等于"不再记版本"）');

    // ── F-3 同一把尺：`edit_file` 入口写的探针也**照登**，再由**同一个主人**按同一把尺处置 ──
    //    §6.0bis-f 收窄：登记动作**不滤**探针（否则 `edit_file` 比 `write_file` 窄，与 §6.1-4 相抵）；
    //    反证因此断言**用户可见的终态**，而不是中间那一步。
    const tmpEdit = path.join(wdir, '_tmp_edit_scratch.py');
    fs.writeFileSync(tmpEdit, 'x = 1\n', 'utf-8');
    await tools.read_file!.execute({ filePath: '_tmp_edit_scratch.py' } as never); // M17-① 同 F-2：先读后改
    await tools.edit_file!.execute({ filePath: '_tmp_edit_scratch.py', old_string: 'x = 1', new_string: 'x = 2' } as never);
    await tools.execute_command!.execute({ command: "printf 'y' > _tmp_by_command.py" } as never);
    const probes = selectProbeDeliverables(wdb as never, 'T').map((r) => path.basename(String(r.file_path ?? ''))).sort();
    eq(probes, ['_tmp_by_command.py', '_tmp_edit_scratch.py'],
      '★ F-3 同尺：两个入口写的 `_tmp_*` 都被**同一个** `docNotProbe` 认作探针（`edit_file` 不比 `execute_command` 宽、也不比它窄）');
    ok(!probes.some((n) => n === 'new.py' || n === 'alert_dashboard.py'),
      '★ F-3 同尺的正面在场：真产出物**不**被判成探针（上一条不是"谁都算探针"）');
    const qdir = path.join(wdir, 'quarantine');
    const disp = disposeProbeDeliverables(wdb as never, selectProbeDeliverables(wdb as never, 'T'), 'retire', qdir);
    eq([disp.retired, disp.moved], [2, 2], '★ 反证（终态）：两个探针**恰两个**被退休并移入隔离目录（不是"登记完就不管了"）');
    // 活成果面 = 项目统计**同一条谓词**（`status != 'retired'` + `docNotProbe`）——不是另写一份判据
    const liveFace = wdb.prepare(
      `SELECT COUNT(*) AS c FROM wa_deliverables WHERE project_id = 'P' AND status != 'retired' AND (type != 'doc' OR ${docNotProbe('')})`,
    ).get() as { c: number };
    eq(liveFace.c, 2, '★ 反证（终态）：**活成果面**（与项目统计同一条谓词）只剩 2 项真产出物 ⇒ 探针**不在用户可见的成果里**');

    // ── F-4 边界如实：`SKIP_DIRS` 下的生成物看不见（§6.0bis-d③，登记在册、此处只钉住它仍成立）──
    fs.mkdirSync(path.join(wdir, 'output'), { recursive: true });
    await tools.execute_command!.execute({ command: "printf 'z' > output/gen.py" } as never);
    ok(!rowsOf().some((r) => r.file_path.includes('/output/')),
      '★ F-4 边界如实：`output/`（`SKIP_DIRS`）下的生成物**看不见** —— 这条边界是**已知且已登记**的，不是本轮新引入的静默');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M4·判据 F-接线】三处调用点同尺：`ensureDocDeliverable` 一处定义、三处调用；`bash` **不**挂（死代码已避）');
  {
    const exe4 = withTools(strip(path.join(MAIN, 'core/agent-executor.ts')));
    const blks = toolBlocks(exe4);
    ok(blks.write_file?.includes('args.content') && blks.execute_command?.includes('args.command') && blks.bash?.includes('validateReadonlyBashCommand'),
      '★ 前置：工具块按**符号**切分成立（`write_file`/`execute_command`/`bash` 各自识别得出——扫描面不靠行号）');
    eq((exe4.match(/function ensureDocDeliverable\(/g) || []).length, 1,
      '★ 接线：`ensureDocDeliverable` **定义恰 1 处**（登记形状的唯一写口）');
    eq((exe4.match(/ensureDocDeliverable\(/g) || []).length, 4,
      '★ 接线：**4 次**出现 = 1 处定义 + 3 处调用（`write_file`/`edit_file`/子进程盘点）——数字由符号数出，不手抄');
    for (const [tool, via] of [['write_file', 'write_file'], ['edit_file', 'edit_file']] as const) {
      ok(blks[tool]?.includes(`ensureDocDeliverable(db, { projectId, taskId, absPath: fp, displayPath: args.filePath, via: '${via}' })`),
        `★ 接线：\`${tool}\` 走**同一个**写口（\`via: '${via}'\`）——不是各写一套 SQL`);
    }
    // 顺序：登记须在**版本快照之前**（否则新建行永远拿不到第 1 版）。
    // 锚点是**代码符号**（快照块自己的守卫），**不是注释**——扫描面经 `stripKeepingLines` 去注释，
    // 拿注释当锚会得 `-1`（"找不到"被读成"在最前"或"在最后"都成立，断言就此空转）。
    const ef = blks.edit_file ?? '';
    const iReg4 = ef.indexOf('ensureDocDeliverable(');
    const iSnap = ef.indexOf('content.length < 50_000 && newContent !== content');
    ok(iReg4 > 0 && iSnap > 0 && iReg4 < iSnap,
      '★ 接线：`edit_file` 里登记调用**先于**版本快照块（两个锚点皆按符号取，且都确在场）');
    ok(!blks.write_file?.includes('INSERT INTO wa_deliverables'),
      '★ 接线：`write_file` 体内**不再**直接 `INSERT INTO wa_deliverables`（登记形状已收进唯一写口）');
    // zx_20260930 M3-c：`create_deliverable` 的 INSERT 已随「校验→去重→落库→通报」收进共享起草处
    //   ⇒ 本扫描面（执行体 ∪ `tools/*.ts`）由 3 处降为 2 处。**不是放宽**：降的那两条由下面两条正面断言
    //   各钉一头（本块不再自带 INSERT 且确实改调起草处；起草处内确有一处 INSERT），总量仍被钉死。
    eq((exe4.match(/INSERT INTO wa_deliverables/g) || []).length, 2,
      '★ 接线：执行体 ∪ 工具模块里 `INSERT INTO wa_deliverables` **恰 2 处**（唯一写口 `ensureDocDeliverable` + 一个**显式宣告**工具 `register_deliverable`——语义不同，不并入）');
    ok(!(blks.create_deliverable ?? '').includes('INSERT INTO wa_deliverables')
      && (blks.create_deliverable ?? '').includes('createDeliverable(db, {'),
      '★ 接线：`create_deliverable` 块**不再**自带 INSERT，改调共享起草处 `createDeliverable`（M3-c 收敛；块切空即红）');
    const dlc17 = strip(path.join(MAIN, 'core/deliverable-lifecycle.ts'));
    eq((dlc17.match(/INSERT INTO wa_deliverables/g) || []).length, 1,
      '★ 接线：共享起草处 `deliverable-lifecycle.ts` 里 `INSERT INTO wa_deliverables` **恰 1 处**（新行的**唯一**落库点——`create_deliverable` 与 GUI `deliverable:create` 同走这一处）');
    for (const [tool, via] of [['execute_command', 'execute_command'], ['run_privileged', 'run_privileged']] as const) {
      const b = blks[tool] ?? '';
      const iBase = b.indexOf('const writeBaselineMs = Date.now();');
      const iRun = b.indexOf('runShellCommand(');
      const iReg = b.indexOf('registerFilesWrittenByCommand(');
      ok(iBase > 0 && iRun > iBase && iReg > iRun,
        `★ 接线：\`${tool}\` 的次序是 **基准 → 跑命令 → 盘点**（基准取在命令启动前，归因窗口才是该条命令）`);
      ok(b.includes(`sinceMs: writeBaselineMs, via: '${via}'`), `★ 接线：\`${tool}\` 的盘点带 \`via: '${via}'\`（来源可追溯）`);
    }
    ok(!(blks.bash ?? '').includes('registerFilesWrittenByCommand'),
      '★ 接线：`bash` **不挂**登记（§6.0bis-b 自纠：它是只读白名单、显式拒重定向，挂了就是永不触发的死代码）');
    ok(/reject|重定向/.test(blks.bash ?? ''),
      '★ 接线：上一条的依据在场——`bash` 走 `validateReadonlyBashCommand`（"写不了"是**代码事实**，不是注释里的一句话）');
    ok(ARTIFACT_WRITE_TOOLS.includes('write_file') && ARTIFACT_WRITE_TOOLS.includes('edit_file'),
      '★ 接线：判据的**来源**是既有的 `ARTIFACT_WRITE_TOOLS`（两者早已并列）——"什么算产出性写入"没有第二份名单');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M5·判据 M】链上至多一个在跑 —— `core/task-chain.ts` **真实现**直调（真库此刻 0 命中，见 §7.0bis-f）');
  {
    const chDb = (): AnyDb => {
      const d = new DatabaseSync(':memory:') as unknown as AnyDb;
      d.exec(`
        CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', status TEXT DEFAULT 'pending',
          parent_task_id TEXT DEFAULT '', context_json TEXT DEFAULT '{}');
        CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT, payload TEXT DEFAULT '', status TEXT DEFAULT 'pending');
      `);
      return d;
    };
    const put = (db: AnyDb, id: string, status: string, parent = ''): void => {
      db.prepare('INSERT INTO wa_tasks (id, project_id, status, parent_task_id) VALUES (?,?,?,?)').run(id, 'P', status, parent);
    };
    const job = (db: AnyDb, id: string, taskId: string, status = 'pending', type = 'ai-task'): void => {
      db.prepare('INSERT INTO wa_jobs (id, type, payload, status) VALUES (?,?,?,?)').run(id, type, JSON.stringify({ taskId }), status);
    };

    ok((CHAIN_BUSY_STATUSES as readonly string[]).includes('planning'),
      '★ M 前置：`CHAIN_BUSY_STATUSES` 含 `planning`（本批的收窄——父在规划中时它的 loop 仍在跑，子任务不该同刻动手）');
    ok(isChainBusyStatus('planning') && isChainBusyStatus('executing') && isChainBusyStatus('preparing')
      && !isChainBusyStatus('pending') && !isChainBusyStatus('paused') && !isChainBusyStatus('completed'),
      '★ M 前置：`isChainBusyStatus` 三态判得对（`planning`/`executing`/`preparing` 忙，`pending`/`paused`/`completed` 不忙）');
    eq([...EXEC_JOB_TYPES], ['ai-task', 'resume-ai-task'],
      '★ M 前置：执行作业类型尺是**一处真源**（post 类不算）——调度器去重与本模块的批量探测共用它');

    const db = chDb();
    put(db, 'PA', 'executing');
    put(db, 'PC', 'pending', 'PA'); // 父在跑、子待起

    // ── ① 派发闸（`create_task` 用）：父忙 ⇒ 改派话；父闲 ⇒ 放行 ──
    ok((childDispatchHint(db, 'PA') ?? '').includes('父任务正在执行'),
      '★ M-1 正面：父 `executing` ⇒ `childDispatchHint` 含「父任务正在执行」（`create_task` 据此**改派**而非即刻入队）');
    db.prepare("UPDATE wa_tasks SET status='planning' WHERE id='PA'").run();
    ok((childDispatchHint(db, 'PA') ?? '').includes('父任务正在规划中'),
      '★ M-1：父 `planning` ⇒ 话随之翻成「父任务正在规划中」（**标本 (a) 路正发生在 `planning` 态**——只认 executing 会正好漏掉它）');
    db.prepare("UPDATE wa_tasks SET status='pending' WHERE id='PA'").run();
    eq(childDispatchHint(db, 'PA'), null,
      '★ M-1 反向（防一刀切·§7.2 点名的反向断言）：父 `pending` ⇒ **放行**（`null`）——父空闲时子任务本就该并行起跑');
    db.prepare("UPDATE wa_tasks SET status='paused' WHERE id='PA'").run();
    eq(childDispatchHint(db, 'PA'), null, '★ M-1 反向：父 `paused` ⇒ 同样放行（暂停的父不在跑，其子任务归调度器正常拉起）');

    // ── ② 直系父忙（沿用旧 `directParentBusy` 语义，本批只把它提为公用真源）──
    db.prepare("UPDATE wa_tasks SET status='executing' WHERE id='PA'").run();
    ok((chainBlockReason(db, 'PC') ?? '').includes('直接父任务正在执行'),
      '★ M-2 正面：子 `pending` + 直系父 `executing` ⇒ 拦，且**说得出是哪一条挡的**（旧语义原样保留）');
    db.prepare("UPDATE wa_tasks SET status='pending' WHERE id='PA'").run();
    eq(chainBlockReason(db, 'PC'), null,
      '★ M-2 反向：父 `pending`、无后代、无执行作业 ⇒ **放行**（防"只要挂在一棵树上就拦"的过宽变体）');

    // ── ③ 对称半边（标本 (b) 路的核心）：**名下有后代在跑** ⇒ 父不得被再拉起 ──
    put(db, 'Q', 'pending');
    put(db, 'Q1', 'executing', 'Q');
    ok((chainBlockReason(db, 'Q') ?? '').includes('名下后代任务正在执行'),
      '★ M-3 正面：父 `pending` + 名下子 `executing` ⇒ **拦** ——「同一任务两条 loop 并发」（(b) 路）由此收口');
    ok(!directParentBusy(db, 'Q'),
      '★ M-3 反证（证明这条是**本批新添的那一笔**）：同一夹具上旧闸判 **false**（Q 无父 ⇒ 旧闸对父恒不拦）——'
      + '旧闸拦不住，正是 (b) 路一路畅通的码上成因，也是"窄修只治 (a)"的实证');

    // ── ④ 对称半边之二：后代 **pending 却已挂执行作业**（`exit_plan_mode` 的 6 秒窗口）──
    put(db, 'R', 'pending');
    put(db, 'R1', 'pending', 'R');
    eq(chainBlockReason(db, 'R'), null, '★ M-4 前置（0→1 的「0」）：子 `pending` 且**无**执行作业 ⇒ 放行');
    job(db, 'j1', 'R1');
    ok((chainBlockReason(db, 'R') ?? '').includes('名下后代任务已排入执行作业'),
      '★ M-4 正面（0→1）：同一子树，一旦子挂上 `ai-task` 作业 ⇒ **拦**（`exit_plan_mode` 先置父 `pending`、再给无前置子入队，那 6 秒窗口即此）');
    db.prepare("UPDATE wa_jobs SET status='done' WHERE id='j1'").run();
    eq(chainBlockReason(db, 'R'), null, '★ M-4 反向：作业 `done` ⇒ **放行**（拦的是"在途"，不是"历史上有过"）');
    job(db, 'j2', 'R1', 'pending', 'background-review');
    eq(chainBlockReason(db, 'R'), null,
      '★ M-4 边界：`background-review`（post 类）**不算**执行作业 ⇒ 放行（与 `hasPendingExecutionJob` 同一份尺，不另立一份名单）');
    job(db, 'j3', 'R1', 'running', 'resume-ai-task');
    ok((chainBlockReason(db, 'R') ?? '').includes('已排入执行作业'),
      '★ M-4：`resume-ai-task` 且 `running` 也算在途（自动拉起路入的正是这一型——`autoPullJobType` 定的；只认 `pending` 会漏）');

    // ── ⑤ 同一扫描批次内的链上去重（现有循环一次可同时选中 pending 父与其 pending 子）──
    put(db, 'S', 'pending');
    put(db, 'S1', 'pending', 'S');
    put(db, 'X', 'pending'); // 无亲属关系
    ok((chainBlockReason(db, 'S', ['S1']) ?? '').includes('同一批次已选中链上亲属'),
      '★ M-5 正面：本批次已选中**链上亲属** ⇒ 拦');
    ok((chainBlockReason(db, 'S1', ['S1']) ?? '').includes('本任务已在本批次入队'),
      '★ M-5：选中**自身** ⇒ 另一句话（两个因由分得开，不是同一句"已选中"包打天下）');
    eq(chainBlockReason(db, 'S', ['X']), null,
      '★ M-5 反向：批次里选中的是一个**无亲属关系**的独立任务 ⇒ 仍放行（防"只见 `selected` 非空就拦"的过宽变体）');

    // ── ⑥ 本闸只认链，不把整个项目当成一条链 ──
    put(db, 'U', 'pending');
    put(db, 'V', 'pending');
    eq([chainBlockReason(db, 'U'), chainBlockReason(db, 'V')], [null, null],
      '★ M-6 反向：两条**独立**顶层链互不牵连（独立任务之间的并行不受本闸影响）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M5·判据 M-接线】闸挂在**真入口**上：调度器拉起前 + `create_task` 真工具直跑');
  {
    const main5 = withTools(strip(path.join(MAIN, 'core/agent-executor.ts')));
    const sch5 = strip(path.join(MAIN, 'core/task-scheduler.ts'));
    ok(sch5.includes('chainBlockReason(this.db, taskId, selectedThisPass)'),
      '★ 接线：调度器直调**共用真源** `chainBlockReason(this.db, taskId, selectedThisPass)`（不是自己再判一遍）');
    ok(!/function directParentBusy\(/.test(sch5),
      '★ 接线：`task-scheduler` 里**不再有**第二份 `directParentBusy` 实现（已迁 `task-chain`，一处真源）');
    const iSel = sch5.indexOf('const selectedThisPass = new Set<string>();');
    const iBlk = sch5.indexOf('const chainBlock = chainBlockReason(');
    const iSkip = sch5.indexOf('if (chainBlock) {');
    const iSet = sch5.indexOf('this.pending.set(taskId, { type: autoPullJobType(prevRunCount)');
    const iAdd = sch5.indexOf('selectedThisPass.add(taskId)');
    ok(iSel > 0 && iBlk > iSel && iSkip > iBlk && iSet > iSkip && iAdd > iSet,
      '★ 接线：次序 = 建本批次账本 → 取因 → 命中即 `continue` → 才入 `this.pending` → 才记账（五个锚点全按**符号**取，不按行号）');
    ok(main5.includes('childDispatchHint(db, taskId)') && (toolBlocks(main5).create_task ?? '').includes('childDispatchHint'),
      '★ 接线：派发闸挂在 `create_task` **工具体内**（按符号切块——写在文件别处不算挂上）');
    ok(!(toolBlocks(main5).spawn_subagent ?? '').includes('childDispatchHint'),
      '★ 接线·§7.0bis-e（用户裁定 A）：`spawn_subagent` **不挂**这道闸——它的全部用途就是运行中并行派发，'
      + '挂了等于取消该工具（"父忙"在它被调用的**那一瞬必然成立**）');
    ok(strip(path.join(MAIN, 'ipc/project.ipc.ts')).includes("from '../core/task-jobs.js'"),
      '★ 接线：四个作业谓词的既有调用方同批改从 `task-jobs.js` 引（不在此留转发壳，免生第二处真源）');

    // ── 行为：`create_task` **真工具**直跑（`setJobEnqueuer(null)` ⇒ 走 `enqueueJob` 的兜底裸插，作业行可被直接数出来）──
    setJobEnqueuer(null);
    const tdb = ((): AnyDb => {
      const d = new DatabaseSync(':memory:') as unknown as AnyDb;
      d.exec(`
        CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
        CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', title TEXT DEFAULT '',
          description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0,
          parent_task_id TEXT DEFAULT '', depends_on TEXT DEFAULT '', source TEXT DEFAULT '',
          acceptance_criteria TEXT DEFAULT '', context_json TEXT DEFAULT '{}');
        CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT, payload TEXT DEFAULT '', status TEXT DEFAULT 'pending',
          created_at TEXT DEFAULT (datetime('now')), completed_at TEXT, error TEXT);
      `);
      return d;
    })();
    tdb.prepare('INSERT INTO wa_tasks (id, project_id, status) VALUES (?,?,?)').run('PA5', 'P', 'executing');
    const wdir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'rr_20260917_m5_'));
    const t5 = buildTools({ db: tdb } as never, 'PA5', 'P', wdir5) as unknown as Record<string, { execute: (a: never) => Promise<string> }>;
    const jobs5 = (): Array<{ type: string; payload: string }> =>
      tdb.prepare('SELECT type, payload FROM wa_jobs ORDER BY rowid').all() as Array<{ type: string; payload: string }>;

    const r1 = JSON.parse(await t5.create_task!.execute({ title: 'c1', description: 'd' } as never)) as { status: string; hint: string };
    eq([r1.status, jobs5().length], ['created_deferred_parent_busy', 0],
      '★ 接线 正面：父 `executing` ⇒ `create_task` 回 `created_deferred_parent_busy` **且 `wa_jobs` 0 行** ——'
      + '"改派"是**真没入队**，不是只在回话里说说（0 行是这里的正面断言）');
    ok(r1.hint.includes('父任务正在执行') && r1.hint.includes('子任务已创建但**未**即刻入队'),
      '★ 接线：回话如实告知**为什么**没起跑、以及它何时会起（agent 才知道该等什么，而不是以为子任务已在跑）');

    tdb.prepare("UPDATE wa_tasks SET status='pending' WHERE id='PA5'").run();
    const r2 = JSON.parse(await t5.create_task!.execute({ title: 'c2', description: 'd' } as never)) as { status: string; taskId: string };
    eq([r2.status, jobs5().length], ['created_and_queued', 1],
      '★ 接线 反向：父空闲 ⇒ 回到 `created_and_queued` **且恰 1 行作业**（放行是真的放行——上一条不是"永远不入队"）');
    ok(jobs5()[0]!.payload.includes(r2.taskId) && jobs5()[0]!.type === 'ai-task',
      '★ 接线：那一行作业指向的正是本次新建的子任务（子 id / 类型都对得上，不是别处的幽灵作业）');

    tdb.prepare("UPDATE wa_tasks SET status='planning' WHERE id='PA5'").run();
    const r3 = JSON.parse(await t5.create_task!.execute({ title: 'c3', description: 'd' } as never)) as { status: string; hint: string };
    ok(r3.status === 'created_deferred_parent_busy' && r3.hint.includes('父任务正在规划中') && jobs5().length === 1,
      '★ 接线：父 `planning` ⇒ 同样改派且**同样没入队**（作业数仍为 1）——**标本 (a) 路**正发生在这个态（父 05:37:17 建 M0 时自己正在规划）');

    const r4 = JSON.parse(await t5.create_task!.execute({ title: 'c4', description: 'd', depends_on: 'ZZZ' } as never)) as { status: string };
    eq([r4.status, jobs5().length], ['created_and_pending', 1],
      '★ 接线：带前置者仍走既有 `created_and_pending` 分支（**不**与派发闸抢路：解锁只经 `getReadyTasks` 一条）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M5·判据 N】名实相符：两个"产出"各名其尺（**只改名词，不动持久化键名**）');
  {
    const exe5 = strip(path.join(MAIN, 'core/agent-executor.ts'));
    const fb5 = strip(path.join(MAIN, 'core/feedback-engine.ts'));
    const te5 = strip(path.join(MAIN, 'core/tension-engine.ts'));
    ok(!exe5.includes('产出${delivs.c}个'),
      '★ N-1：旧文案 `产出${delivs.c}个` 已除 —— 它数的是"本任务名下**登记条数**"，与 `hasDeliverable`（整树**真实产出证据**）同名不同义');
    ok(exe5.includes('本任务登记${delivs.c}条'),
      '★ N-1 正面：新文案说清了口径是**本任务登记条数**（不再冒充"产出了几个"）');
    ok(!fb5.includes('无产出物，提高精确度') && fb5.includes('无真实产出证据，提高精确度'),
      '★ N-2：`feedback-engine` 那条改说 **无真实产出证据** —— 它读的正是 `hasDeliverable`，两处从此不同叫"产出物"');
    ok(exe5.includes('无真实产出证据，评分压降') && exe5.includes('本任务登记'),
      '★ N-3 对照：**同一份文件里两条口径并存且名字可分**（"登记条数" vs "真实产出证据"）——不是把两个词合成一个更含糊的词');
    ok(fb5.includes('hasDeliverable') && te5.includes('hasDeliverable'),
      '★ N-4 反证（**不许顺手改键名**）：持久化键 `hasDeliverable` 一字未改，读方 `tension-engine` 仍按原名读'
      + '——改名会让存量行一律读成 `undefined ⇒ 无产出物`，那是把"名实不符"换成"存量数据误报"');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M5·判据 O】偏离理由不许静默截断（**真函数**三态标本：长 / 短 / 恰等于上限）');
  {
    const short = '理由短，不必截断。';
    const long = '这是一条超过上限的偏离理由，实测标本原样断在半句上。'.repeat(5);
    ok(long.length > GOAL_DEVIATION_REASON_LIMIT, `★ O 前置：长标本确超上限（${long.length} > ${GOAL_DEVIATION_REASON_LIMIT}），否则下面两条无从分辨`);
    eq(truncateGoalDeviationReason(short), short,
      '★ O 反向：≤上限者**一字不加**——"理由已截断"这句话本身不得成为假话（防"一律加标记"的过宽变体）');
    const t = truncateGoalDeviationReason(long);
    ok(t.startsWith(long.slice(0, GOAL_DEVIATION_REASON_LIMIT)) && t.length > GOAL_DEVIATION_REASON_LIMIT,
      '★ O 正面：前 `GOAL_DEVIATION_REASON_LIMIT` 字原样保留、标记是**追加**（不是替换或覆盖）');
    ok(t.includes('…（理由已截断，共') && t.includes(`共 ${long.length} 字`),
      '★ O 正面：真截断时**如实标注**，且字数报的是**原理由**的字数（读者据此知道丢了多少，而不是只知道"截过"）');
    const exact = 'x'.repeat(GOAL_DEVIATION_REASON_LIMIT);
    eq(truncateGoalDeviationReason(exact), exact,
      '★ O 边界：**恰等于**上限不算截断（判据是 `>` 而非 `>=`——写成 `>=` 会让满额理由平白多一句假话）');
    ok(strip(path.join(MAIN, 'core/agent-executor.ts')).includes('truncateGoalDeviationReason(parsed.reason'),
      '★ O-接线：`checkGoalDeviation` 的返回点用的正是本函数（游离的纯函数不算落地——三处用户可见面拿到的才是它）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【P】build 钉（派生核对，不写轮次字面量）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告
//    unhandled rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿
//    （实测：M5 的 `create_task` 夹具缺列时正是如此——266 通过/0 失败、退出码 0）。
//    同 `rr_zx_20260911_2/_3` 的写法：异常先如实计失败再走收尾。
main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20260917 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260917: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
});
