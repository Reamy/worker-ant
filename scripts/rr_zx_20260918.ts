/**
 * zx_20260918 受控复跑 —— 「认领一个文件之前，先问它是谁的」。
 *
 * 病根（`plans/improve/zx_20260918.md` §1.3，真库 + 事件流坐实）：`ensureDocDeliverable`（"登记一个 doc 产出物"
 * 的唯一写口）按 `project_id + file_path` **认领**既有行时**不问 `type`**，命中 `type='daemon'` 的运行态行
 * 也照样 `setDeliverableStatus(…, 'draft')` —— 把一只**在跑的守护**改写成"草稿"：从此不被 `autoStartDaemons`
 * 复起、且被 `isRealDeliverableRow` 从成果面除名。真标本：`alert_dashboard` 与 `两新关键位买入时机监控`
 * 两条 daemon 行于 2026-09-18T01:18:35Z/01:18:53Z 被 `via=edit_file` 打成 `draft`（全库扫描：受害**恰此两条**）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §P 判据 P（**静态**·认领面必须**先判名、再问属主**）：扫描面 = `apps/worker-ant-desktop/src/main/**`（去注释后的源码）。
 *   ⚠ 一律用**去注释**源码（`stripKeepingLines`）：本轮修的正是"注释写着不夺归属、代码顺手夺了状态"，
 *     若连注释一起扫描，判据会被自己那句"说了要做对的话"喂饱 —— 假绿的经典形态。
 *   P-1 **正面**：认领查询**必须把 `type`（与 `task_id`）取回来**，且判名（`=== 'doc'`）在改状态之前；
 *       **属主守卫在场**（判名与写状态之间读到行属主并与本次任务比较）；窗口里写状态只许一处。
 *       ⚠ 判据**不钉列名写法**（`claimCols` 取回列清单后逐项断言）：M9 加了一列 `task_id`，
 *         写死 `SELECT id, type FROM` 会让一次**加严**把三条正面判据全判红（假红）。
 *       ⚠ **zx_20260928 M3 就地再锚**（钉更强的真源，非放宽）：M3 把四条路的查重收成**全仓唯一语句**
 *         `deliverable-lifecycle.findDeliverableByPath`（project 级口径），`ensureDocDeliverable` 由内联 SQL
 *         改为**调它**。查询本体因此**迁出 `engineSrc()`**（该并集不含 `deliverable-lifecycle.ts`）。
 *         若 P-1 仍按"`engineSrc()` 里第一处 `CLAIM_SQL`"取窗口，会切到 `tools/write.ts` 里那处
 *         **不带 `type`** 的版本快照查行（`edit_file` 的 `exDeliv`）⇒ 四条正面判据集体假红。
 *         现改为**按符号双锚**：① 列清单读**共享查重本尊**（`deliverable-lifecycle.ts`，即查询的唯一落点）；
 *         ② 判名/属主守卫/单写仍读**执行体窗口**，起点锚在 `ensureDocDeliverable` 内的
 *         `findDeliverableByPath(` **调用处**（不再退回"全仓第一处 `CLAIM_SQL`"——那个锚就是会响的雷）。
 *         并加一条前置断言：`ensureDocDeliverable` **确在调共享查重**——否则"列清单从别处读"会与实现脱钩。
 *   P-2 **反证（三变体，判据非空转）**：①逐字旧写法（只 `SELECT id`）②**更险的变体**（取回了 `type` 却不判）
 *       ③**M9 前那版**（判了名却不问属主）—— 各喂进对应谓词**都必须判红**
 *       （只试①会漏掉"取了不用"那一支；不试③则 M9 这个新病根**无人守**）。
 *   P-3 认领面**恰好一处**：`src/main` **全量**扫描下，登记写口**只定义一处**，三个入口（`write_file`/`edit_file`/
 *       子进程落盘）**共用**它；**不带 type 的旧式查行**在 `src/main` 全量里**逐处点名**，且每处所在块**不写
 *       `status`**（否则它就是个能绕过守卫的第二个认领面），本处只允许"版本快照块"这一处（§4.3 边界）。
 * §Q 判据 Q（**行为**·直调 `ensureDocDeliverable` **本尊**，**不复刻它的 SQL**）：
 *   Q-1（**该不命中**·daemon 运行态行）★ 主判据：调用后 **status 一字不变**（仍 `running`）、**行数不变**、
 *       **零 `deliverable.status_changed` 事件**、`task_id` 不被夺、还回**既有行**的 id。两只真标本各跑一遍。
 *   Q-5（**反证**·同夹具同标本按**旧写法**）确能把那只 daemon 打成 `draft` ⇒ Q-1 的"不变"不是"夹具本来就改不动"。
 *   Q-2（**属主守卫**·doc 行）★ 三只标本 + 一反证（zx_20260923 M9 **加严**，非放宽）：
 *       a 属主=**本次写入任务** ⇒ status 重写 `draft`、恰发**一条**事件（承 zx_20260913 M2-2 原语义——正路不许被守卫堵上）；
 *       b 属主**为空** ⇒ 同 a（守卫只拦"别人的"，不拦"无主的"）；
 *       c 属主=**别的任务** ⇒ **status 一字不变**（仍 `completed`）、`task_id` 不夺、**零**事件。
 *         否则"别人已交付的成果"会被**任何一次编辑**永久打回 `draft`（真库标本 `2ded6c81` 的
 *         `plans/backend/20260916.md`，2026-09-23T02:30:22Z 被 `a290ae2b` 经 `edit_file` 打成 draft）。
 *       反证：同夹具同一行按**旧写法**（无条件的 `setDeliverableStatus`）确会把它打成 `draft` ⇒ c 的"不变"不是"夹具本来就改不动"。
 *   Q-3（新建路仍在）：无登记行 ⇒ 新建 `type='doc'`/`status='draft'`，恰发**一条**事件（`forceEmit` 未被打断）。
 *   Q-4（**枚举穷举**）：`mcp`/`a2a`/`ui` 三种别种产出物**同尺**（防"只治了 daemon"——放宽也要按表穷举）。
 * §R 判据 R（**静态**·复起集与成果面**不得被顺手放宽**）：本轮改的是"谁被误标"，**不是**"把 `draft` 也拉起来"
 *   ——后者会让**用户手工新建、从未发布**的守护草案在重启时偷偷跑起来（两质的矛盾，§2.3）。
 * §S 判据 S：`checkBuildPins(ok, { distDir })`（P1–P6 全套）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §M9（**zx_20260923 就地加严**，非放宽）：M9 给 doc 分支加了**属主守卫**——属主是**别的任务**时一字不动。
 *   真库标本：`2ded6c81` 已 `completed` 的 `plans/backend/20260916.md`，被 `a290ae2b` 于 2026-09-23T02:30:22Z
 *   经 `edit_file` 打成 `draft`（发了一条 `deliverable.status_changed`），此后**无路可翻**（属主已终态）。
 *   本文件随之加严：Q-2 三只标本（a 属主=本任务 / b 无属主 / c 属主=别任务）+ 一反证；
 *   P-1 增"取回 `task_id`"与"属主守卫在场"两条正面；P-2 增变体③（判名却不问属主 ⇒ 必须判红）。
 *
 * ⚠ 夹具（`node:sqlite` 内存库）只建本路径真正查询的列；`wa_deliverables` 在本路径上**无触发器**，
 *   故不存在"先插数据后建触发器"那类假绿（如实说明，不假称已按生产顺序搭——承 `feedback_rr_fixture_production_order`）。
 * ⚠ 本文件**不打开真库**、不改任何生产行为；真库实测与存量订正见方案 §一 / §M4。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**（P6 取产物内 build 值本身，而非会被注释骗过的子串匹配）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { engineSrc } from './lib/rr-engine-src.js';
import { eventBus } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';
import { setDeliverableStatus } from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import { ensureDocDeliverable } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const MAIN = path.join(root, `${A}/src/main`);
/** 扫源码一律**去注释**：本轮的病根正是"注释说对了、代码做错了"，不去注释则判据会被那句注释喂饱。 */
const strip = (p: string) => stripKeepingLines(fs.readFileSync(p, 'utf-8')).join('\n');

/**
 * 「认领查询」的**唯一真源文件**（zx_20260928 M3 后）。
 *
 * M3 把四条路的查重收成一条语句并落在 `deliverable-lifecycle.findDeliverableByPath`——它**不在
 * `engineSrc()` 的并集里**（该并集 = 执行体 ∪ `core/exec-*.ts` ∪ `tools/*.ts`）。故列清单（"取回了
 * `type`/`task_id` 吗"）须**直接读这个文件**，不能从执行体窗口里找：执行体里已经没有那条 SQL 了。
 */
const LIFECYCLE_SRC = path.join(MAIN, 'core/deliverable-lifecycle.ts');

/** 递归收集 `src/main` 下全部 `.ts`——判据 P-3 的扫描面是**整个 src/main**，不是只扫 `core/`。 */
function walkTs(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

type AnyDb = { prepare: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] }; exec: (s: string) => void; close: () => void };

/** 真库同形的列（`wa_deliverables` 生产 DDL 的 `type TEXT NOT NULL` 等口径照搬）。 */
const SCHEMA = `
CREATE TABLE wa_deliverables (
  id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL,
  name TEXT DEFAULT '', description TEXT DEFAULT '', file_path TEXT,
  status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')), is_primary INTEGER DEFAULT 0, acceptance_verified INTEGER DEFAULT 0);
`;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:') as unknown as AnyDb; d.exec(SCHEMA); return d; };

/** 本轮的**两只真标本**（方案 §1.1）——夹具**逐字沿用真库里的文件名**，免得判据在"别处随便一个 daemon"上成立而在真病根上失效。 */
const PROJECT = 'P-a-stock';
const SPECIMENS = [
  { name: 'intraday_alert_daemon.py', row: 'c14cac67-c94e-4804-8815-e1be017c9b1f', task: 'T-a-stock' },
  { name: 'alert_dashboard.py', row: '8d9d75ab-e3d5-488a-9a0c-f1e62ceb3e40', task: 'T-a-stock' },
] as const;
const absOf = (name: string) => `/proj/a-stock-advisor/scripts/${name}`;

/** `taskId` 省略 ⇒ 默认 `'T-own'`；显式传 `null` ⇒ 落一行**无属主**行（Q-2b 要用，`?? `会把 null 吞掉故用 `=== undefined` 判）。 */
const insert = (db: AnyDb, r: { id: string; type: string; status: string; taskId?: string | null; file: string }): void => {
  db.prepare('INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status) VALUES (?,?,?,?,?,?,?)')
    .run(r.id, PROJECT, r.taskId === undefined ? 'T-own' : r.taskId, r.type, path.basename(r.file), r.file, r.status);
};
const rowOf = (db: AnyDb, id: string) => db.prepare('SELECT id, task_id, type, status FROM wa_deliverables WHERE id = ?').get(id) as { id: string; task_id: string; type: string; status: string } | undefined;
const count = (db: AnyDb) => (db.prepare('SELECT COUNT(*) AS c FROM wa_deliverables').get() as { c: number }).c;

/** 订阅产出物状态事件；返回「取走已收事件」的闭包（等两轮微任务，让 `emit` 内的异步处理器跑完）。 */
function watchEvents(): () => Promise<Array<Record<string, unknown>>> {
  const seen: Array<Record<string, unknown>> = [];
  const h = (e: { data: Record<string, unknown> }) => { seen.push(e.data); };
  eventBus.on('deliverable.status_changed', h);
  return async () => { await Promise.resolve(); await Promise.resolve(); eventBus.off('deliverable.status_changed', h); return seen; };
}

/** 取 `from` 起**第一个** `{` 的配对花括号块原文（按符号 + 配对括号界定，不按行号——行号是位置会漂）。 */
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

/** 命中的行号（1 起）+ 行的**字符偏移**——行号只用于报点，判据本身按符号。 */
function hitsOf(src: string, re: RegExp): Array<{ line: number; at: number; text: string }> {
  const out: Array<{ line: number; at: number; text: string }> = [];
  let at = 0;
  src.split('\n').forEach((t, i) => {
    re.lastIndex = 0;
    if (re.test(t)) out.push({ line: i + 1, at, text: t.trim() });
    at += t.length + 1;
  });
  return out;
}

/**
 * 「认领查询」的**形状**（列清单不限）：`SELECT … FROM wa_deliverables WHERE project_id = ? AND file_path = ?`。
 *
 * ⚠ **不钉列名写法**：zx_20260923 M9 给认领加了属主守卫，取回的列从 `id, type` 变成 `id, type, task_id`——
 *   若判据写死 `SELECT id, type FROM`，一次**加严**（多取一列）会把三条正面判据全部判红（假红）。
 *   判据要钉的是"**取回了什么、按什么判**"，故先取列清单再逐项断言（见 P-1）。
 */
const CLAIM_SQL = /SELECT\s+([^"';]+?)\s+FROM\s+wa_deliverables\s+WHERE\s+project_id\s*=\s*\?\s*AND\s+file_path\s*=\s*\?/;

/** 命中处的列清单（`SELECT` 与 `FROM` 之间的逗号分隔项）。未命中 ⇒ `null`。 */
function claimCols(text: string): string[] | null {
  const m = text.match(CLAIM_SQL);
  return m ? m[1]!.split(',').map((s) => s.trim()) : null;
}

/**
 * 「**认领面**」——从认领查询起、到插入新行那句止的**窗口原文**。
 *
 * 窗口按两个符号界定（起：认领落点；止：`INSERT INTO wa_deliverables`），**不按固定字数**：
 * 判据要问的正是"认领与建行之间有没有判名（和属主守卫）"，那段就是窗口。
 *
 * ⚠ **起点按符号、且不退回全仓第一处**（zx_20260928 M3 就地再锚）：M3 后执行体里的认领落点是
 *   `ensureDocDeliverable` 内的 `findDeliverableByPath(` **调用**（查询本尊已迁至共享查重）。
 *   故优先从 `ensureDocDeliverable` 定义处找那个调用；只有**判据喂的是一段旧写法片段**（P-2 三变体，
 *   其中并无 `ensureDocDeliverable` 定义）才退回"从该片段起的第一处 `CLAIM_SQL`"。
 *   **绝不**退回"`engineSrc()` 全仓第一处 `CLAIM_SQL`"——那会切到 `tools/write.ts` 的版本快照查行。
 */
function claimWindow(src: string): string {
  const def = src.indexOf('function ensureDocDeliverable');
  const call = def >= 0 ? src.indexOf('findDeliverableByPath(', def) : -1;
  let q = -1;
  if (call >= 0) {
    q = call;
  } else {
    const from = def >= 0 ? def : 0;
    const m = src.slice(from).search(CLAIM_SQL);
    q = m < 0 ? -1 : from + m;
  }
  if (q < 0) return '';
  const end = src.indexOf('INSERT INTO wa_deliverables', q);
  return src.slice(q, end < 0 ? src.length : end);
}

/**
 * 判据本体①：认领**取回了 `type`**，且**先判名后动状态**。两处都要在场——只取不判 = 变体②。
 *
 * ⚠ `cols` 由调用方给（不再从窗口里 `claimCols`）：M3 后列清单的真源是**共享查重本尊**（`LIFECYCLE_SRC`），
 *   而窗口起点是执行体里的**调用处**——窗口里已无 SQL，`claimCols(w)` 必为 `null`。
 */
function claimsByTypeFirst(w: string, cols: string[] | null): boolean {
  const takes = cols?.includes('type') ?? false;
  const iGuard = w.search(/\.type\s*===\s*'doc'/);
  const iWrite = w.indexOf('setDeliverableStatus');
  return takes && iGuard >= 0 && iWrite >= 0 && iGuard < iWrite;
}

/**
 * 判据本体②（zx_20260923 M9 加严）：**属主守卫在场**——判名与写状态之间，必须**读到行属主**并**与本次任务比较**。
 *
 * 它比①更强，而且是**另一个**病根的守卫：①的"该命中"标本下，`type='doc'` 一行在**M9 前的写法**里
 * 照样过得了①（那一版正是"判了名却不看属主"）。只钉①等于只钉住 2026-09-18 那个病根，
 * M9 这个（"别人已终态的成果被写一下就永久打回 `draft`"）会静默复发。
 */
function claimsOwnerGuarded(w: string): boolean {
  const iGuard = w.search(/\.type\s*===\s*'doc'/);
  const iWrite = w.indexOf('setDeliverableStatus');
  if (iGuard < 0 || iWrite < 0 || iGuard >= iWrite) return false;
  const mid = w.slice(iGuard, iWrite);
  return /\btask_id\b/.test(mid) && /o\.taskId/.test(mid) && /===/.test(mid);
}

async function main(): Promise<void> {
  const exe = stripKeepingLines(engineSrc()).join('\n');

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1·判据 P-1】认领面**先判名、再问属主**：认领查询必须取回 type 与 task_id，两条守卫都须在改状态之前');
  {
    const lifecycle = strip(LIFECYCLE_SRC);
    const w = claimWindow(exe);
    // 列清单的真源随实现走（M3 后查询本体在共享查重里，不在 engineSrc()）。
    const cols = claimCols(lifecycle);
    const def = exe.indexOf('function ensureDocDeliverable');
    const call = def >= 0 ? exe.indexOf('findDeliverableByPath(', def) : -1;
    ok(w.length > 0, 'P-1 前置：认领窗口**非空**（找得到「认领落点 → 插入新行」这一段）');
    ok(call > def && def >= 0,
      '★ P-1 前置（M3 再锚）：`ensureDocDeliverable` **确在调共享查重** `findDeliverableByPath`（否则下面"列清单从别处读"会与实现脱钩——那是另一种自我印证）');
    ok(cols?.includes('type') ?? false,
      '★ P-1 正面：认领查询把 type **取回来了**（不取则无从判名——旧写法只 SELECT id）');
    ok(cols?.includes('task_id') ?? false,
      '★ P-1 正面：认领查询把 task_id **也取回来了**（M9 属主守卫读的就是它；少取这一列 ⇒ 守卫读到 `undefined`，而 `undefined == null` **会命中**"无属主"那一支 ⇒ 陌生人行照样被重开）');
    ok(claimsByTypeFirst(w, cols),
      "★ P-1 正面：`.type === 'doc'` 的判名**在 `setDeliverableStatus` 之前**（顺序反了等于先斩后奏）");
    ok(claimsOwnerGuarded(w),
      '★ P-1 正面（M9 加严）：**属主守卫在场**——判名与写状态之间读到了行属主、并与本次任务比较（只判名不看属主 = 本轮病根）');
    eq((w.match(/setDeliverableStatus\(/g) || []).length, 1,
      '★ P-1 正面：窗口里写状态**只有一处**，且它在判名之后——两处即存在一条不判名的旁路');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1·判据 P-2】反证：旧写法喂进同一谓词**必须判红**（否则 P-1 只是"含 type 二字"的假绿）');
  {
    // ① 逐字旧写法（git 实证：5ee00c86 抽出前的 write_file upsert，只 SELECT id）
    const OLD_VERBATIM = `
      const existing = db.prepare('SELECT id FROM wa_deliverables WHERE project_id = ? AND file_path = ? LIMIT 1')
        .get(o.projectId, o.absPath) as { id: string } | undefined;
      if (existing) {
        setDeliverableStatus(db, existing.id, 'draft', o.via);
        return { id: existing.id, created: false };
      }
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, description, file_path, status) VALUES (?, ?, ?, 'doc', ?, ?, ?, 'draft')");
    `;
    // ② **更险的变体**：把 type 取回来了、却不拿它作判据（只试①会漏掉这一支——它连 type 二字都有）
    const OLD_TAKES_BUT_DOESNT_GUARD = `
      const existing = db.prepare('SELECT id, type FROM wa_deliverables WHERE project_id = ? AND file_path = ? LIMIT 1')
        .get(o.projectId, o.absPath) as { id: string; type: string } | undefined;
      if (existing) {
        setDeliverableStatus(db, existing.id, 'draft', o.via);
        return { id: existing.id, created: false };
      }
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, description, file_path, status) VALUES (?, ?, ?, 'doc', ?, ?, ?, 'draft')");
    `;
    ok(!claimsByTypeFirst(claimWindow(OLD_VERBATIM), claimCols(claimWindow(OLD_VERBATIM))),
      '★ P-2① 逐字旧写法（只 SELECT id）**判红** —— 「取回 type」这一条本身就不过关');
    ok(claimWindow(OLD_TAKES_BUT_DOESNT_GUARD).length > 0,
      '★ P-2② 前置：该变体的认领窗口**非空**（否则"判红"只是因为窗口都没找着，属另一种假绿）');
    ok(!claimsByTypeFirst(claimWindow(OLD_TAKES_BUT_DOESNT_GUARD), claimCols(claimWindow(OLD_TAKES_BUT_DOESNT_GUARD))),
      '★ P-2② **取了 type 却不判**的变体**判红** —— 这条才是真反证：它含有 type 字样，只有「判名在改状态之前」能把它筛掉');

    // ③ **本轮 M9 前的写法**：判了名、却**不问属主** —— ①② 都拦不住它（它两样都过关），只有"属主守卫"能判红
    const OLD_TYPE_GUARDED_ONLY = `
      const existing = db.prepare('SELECT id, type FROM wa_deliverables WHERE project_id = ? AND file_path = ? LIMIT 1')
        .get(o.projectId, o.absPath) as { id: string; type: string } | undefined;
      if (existing) {
        if (existing.type === 'doc') setDeliverableStatus(db, existing.id, 'draft', o.via);
        return { id: existing.id, created: false };
      }
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, description, file_path, status) VALUES (?, ?, ?, 'doc', ?, ?, ?, 'draft')");
    `;
    ok(claimsByTypeFirst(claimWindow(OLD_TYPE_GUARDED_ONLY), claimCols(claimWindow(OLD_TYPE_GUARDED_ONLY))),
      '★ P-2③ 前置：M9 前那版写法（判名、**不问属主**）**过得了①**——否则"属主守卫"这条判据没在拦新的东西');
    ok(!claimsOwnerGuarded(claimWindow(OLD_TYPE_GUARDED_ONLY)),
      '★ P-2③ **判名却不问属主**的写法**判红** —— 这条才是 M9 的真反证：它含有 `.type === \'doc\'`，只有「属主守卫在场」能把它筛掉');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1·判据 P-3】认领面**恰好一处**（扫描面 = 整个 src/main）：三入口共用一写口；不写 status 的旧式查行只许版本快照块一处');
  {
    const FILES = walkTs(MAIN).map((p) => ({ rel: path.relative(root, p), src: strip(p) }));
    ok(FILES.length > 20, `P-3 前置：扫描面非退化（src/main 下 ${FILES.length} 个 .ts —— 防"扫描面悄悄变空"的假绿）`);

    const defs = FILES.flatMap((f) => hitsOf(f.src, /function\s+ensureDocDeliverable\s*\(/).map((h) => `${f.rel}:${h.line}`));
    eq(defs.length, 1, `★ P-3 登记写口**只定义一处**（${defs.join('、') || '无'}）—— 唯一写口，不得各写一套`);
    const guarded = FILES.flatMap((f) => hitsOf(f.src, CLAIM_SQL)
      .filter((h) => claimCols(h.text)?.includes('type'))
      .map((h) => `${f.rel}:${h.line}`));
    eq(guarded.length, 1, `★ P-3 带判名口径的认领查询**全仓恰一处**（${guarded.join('、')}）`);

    ok(exe.includes("via: 'write_file'") && exe.includes("via: 'edit_file'"),
      '★ P-3 接线：`write_file` 与 `edit_file` **两个入口**都走它（`edit_file` 正是本轮引爆的新入口，`5ee00c86` 所加）');
    ok(/ensureDocDeliverable\(db,\s*\{[\s\S]{0,500}?via:\s*o\.via/.test(exe),
      '★ P-3 接线：子进程落盘那一路（`execute_command`/`run_privileged`）也走它——三处入口共用一处写口');

    // 不带 type 的旧式查行：**逐处点名**，且每处所在块**不写 status**
    const bare = FILES.flatMap((f) => hitsOf(f.src, /SELECT\s+id\s+FROM\s+wa_deliverables\s+WHERE\s+project_id\s*=\s*\?\s*AND\s+file_path\s*=\s*\?/).map((h) => ({ rel: f.rel, ...h })));
    eq(bare.length, 1, `★ P-3 边界：不带 type 的旧式查行**全仓只剩 1 处**（${bare.map((b) => `${b.rel}:${b.line}`).join('、')}）—— 多一处就是个能绕过守卫的认领面`);
    for (const b of bare) {
      const src = FILES.find((f) => f.rel === b.rel)!.src;
      const blk = braceBlock(src, src.lastIndexOf('try {', b.at));
      ok(blk.includes('wa_deliverable_versions') && !blk.includes('setDeliverableStatus') && !/SET\s+status/.test(blk),
        `★ P-3 ★ 该处**不是认领面**：它在版本快照块里（写 \`wa_deliverable_versions\`），**不写 status** —— 故即便命中 daemon 行也不会夺其状态（${b.rel}:${b.line}）`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1·判据 Q-1/Q-5】行为·真实现：daemon **运行态行**不得被认领（该不命中）＋ 反证它确实拦得住');
  {
    for (const s of SPECIMENS) {
      const db = mkdb();
      insert(db, { id: s.row, type: 'daemon', status: 'running', taskId: s.task, file: absOf(s.name) });
      const take = watchEvents();
      const r = ensureDocDeliverable(db, {
        projectId: PROJECT, taskId: 'T-intruder', absPath: absOf(s.name), displayPath: `scripts/${s.name}`, via: 'edit_file',
      });
      const evs = await take();
      const row = rowOf(db, s.row)!;
      eq(row.status, 'running', `★ Q-1（${s.name}）**status 一字不变**：仍 \`running\` —— 认领这一支脚本不该把守护变成"草稿"`);
      eq(row.task_id, s.task, `★ Q-1（${s.name}）归属未被夺（\`task_id\` 仍是原主）`);
      eq(count(db), 1, `★ Q-1（${s.name}）**行数不变**（不新建重复 doc 行 —— "一个东西两条账"是本仓反复治过的病）`);
      eq([r.created, r.id], [false, s.row], `★ Q-1（${s.name}）如实回执：\`created:false\` 且还回**既有行**的 id（保归属：文件变更事件仍指得着它）`);
      eq(evs.length, 0, `★ Q-1（${s.name}）**零** \`deliverable.status_changed\` 事件（没改就没账，不自造一条"变成了草稿"的假史）`);
    }

    // Q-5 反证（判据非空转）：同夹具、同标本，按**旧写法**确能把它打成 draft
    const s0 = SPECIMENS[1];
    const db = mkdb();
    insert(db, { id: s0.row, type: 'daemon', status: 'running', taskId: s0.task, file: absOf(s0.name) });
    const take = watchEvents();
    // 旧写法的**那两行**（原样照抄自 §1.3 里 5ee00c86 抽出前的实现；这是"被删掉的旧码"用作反证，不是第二份生产实现）
    const old = db.prepare('SELECT id FROM wa_deliverables WHERE project_id = ? AND file_path = ? LIMIT 1')
      .get(PROJECT, absOf(s0.name)) as { id: string } | undefined;
    if (old) setDeliverableStatus(db, old.id, 'draft', 'edit_file');
    const evs = await take();
    eq(rowOf(db, s0.row)!.status, 'draft', '★ Q-5 反证：旧写法在**同一夹具同一标本**上确把它打成 `draft` ⇒ Q-1 的"不变"不是"夹具本来就改不动"');
    eq(evs.length, 1, '★ Q-5 反证：旧写法实发 1 条事件（这正是真库里那两条 `changedFrom=running → draft` 的来源）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1·判据 Q-2】属主守卫（zx_20260923 M9）：**重开生命周期**须属主是本次任务（该命中 a/b）＋ 属主是别的任务时一字不动（该不命中 c）＋ 反证');
  {
    // ── Q-2a 该命中：属主 = 本次写入任务 ⇒ 仍按原语义重写为 `draft`（守卫不得把正路堵上） ──
    const db = mkdb();
    insert(db, { id: 'd-doc', type: 'doc', status: 'completed', taskId: 'T-new', file: '/proj/x/report.md' });
    const take = watchEvents();
    const r = ensureDocDeliverable(db, {
      projectId: PROJECT, taskId: 'T-new', absPath: '/proj/x/report.md', displayPath: 'report.md', via: 'edit_file',
    });
    const evs = await take();
    const row = rowOf(db, 'd-doc')!;
    eq(row.task_id, 'T-new', '★ Q-2a（该命中·属主=本任务）`task_id` 不动（本来就是本任务，承 zx_20260913 M2-2 的"不夺归属"）');
    eq(row.status, 'draft', '★ Q-2a（该命中）status 被重写为 `draft` —— 属主自己接着改，仍回到生命周期起点（原语义逐字保留）');
    eq([r.created, evs.length], [false, 1], '★ Q-2a（该命中）`created:false` 且恰发 1 条事件（真变更才发，幂等不重发）');
    eq(count(db), 1, '★ Q-2a（该命中）行数不变（重写既有行而非新建）');

    // ── Q-2b 该命中：属主为空 ⇒ 无主行仍可被认领（守卫的 `owner == null` 那一支，与 Q-1 的"别种产出物"不同质的另一支） ──
    const dbN = mkdb();
    insert(dbN, { id: 'd-null', type: 'doc', status: 'completed', taskId: null, file: '/proj/x/orphan.md' });
    const takeN = watchEvents();
    const rN = ensureDocDeliverable(dbN, {
      projectId: PROJECT, taskId: 'T-new', absPath: '/proj/x/orphan.md', displayPath: 'orphan.md', via: 'edit_file',
    });
    const evsN = await takeN();
    eq([rowOf(dbN, 'd-null')!.status, rN.created, evsN.length], ['draft', false, 1],
      '★ Q-2b（该命中·无属主）`task_id IS NULL` 的行**仍被重开**为 `draft` 且发 1 条事件 —— 守卫只拦"别人的"，不拦"无主的"');

    // ── Q-2c 该不命中 ★ 主判据：属主是别的任务 ⇒ 一个字都不许动 ──
    const dbF = mkdb();
    insert(dbF, { id: 'd-foreign', type: 'doc', status: 'completed', taskId: 'T-old', file: '/proj/x/foreign.md' });
    const takeF = watchEvents();
    const rF = ensureDocDeliverable(dbF, {
      projectId: PROJECT, taskId: 'T-new', absPath: '/proj/x/foreign.md', displayPath: 'foreign.md', via: 'edit_file',
    });
    const evsF = await takeF();
    const rowF = rowOf(dbF, 'd-foreign')!;
    eq(rowF.task_id, 'T-old', '★ Q-2c（该不命中·属主=别任务）归属未被夺（`task_id` 仍是 `T-old`）');
    eq(rowF.status, 'completed', '★ Q-2c（该不命中）**status 一字不变**：仍 `completed` —— 编辑**别人已终态**的成果不得把它打回 `draft`（真库标本 `2ded6c81` 的病形）');
    eq([rF.created, rF.id], [false, 'd-foreign'], '★ Q-2c（该不命中）如实回执：`created:false` 且还回**既有行** id（保归属：文件变更事件仍指得着它）');
    eq([evsF.length, count(dbF)], [0, 1], '★ Q-2c（该不命中）**零**事件 + 行数不变（没改就没账，不自造一条"变成了草稿"的假史）');

    // ── Q-2 反证：同夹具同一行，按**旧写法**确能把它打成 draft ⇒ Q-2c 的"不变"不是"夹具本来就改不动" ──
    const dbO = mkdb();
    insert(dbO, { id: 'd-foreign', type: 'doc', status: 'completed', taskId: 'T-old', file: '/proj/x/foreign.md' });
    const takeO = watchEvents();
    // 旧写法的**那一行**（原样照抄自 M9 前的实现：`if (existing.type === 'doc') setDeliverableStatus(…, 'draft', …)`；
    // 这是"被改掉的旧码"用作反证，不是第二份生产实现）
    const oldRow = dbO.prepare('SELECT id FROM wa_deliverables WHERE project_id = ? AND file_path = ? LIMIT 1')
      .get(PROJECT, '/proj/x/foreign.md') as { id: string } | undefined;
    if (oldRow) setDeliverableStatus(dbO, oldRow.id, 'draft', 'edit_file');
    const evsO = await takeO();
    eq(rowOf(dbO, 'd-foreign')!.status, 'draft',
      '★ Q-2 反证：旧写法（不问属主）在**同一夹具同一行**上确把它打成 `draft` ⇒ Q-2c 的"不变"不是"夹具本来就改不动"');
    eq(evsO.length, 1, '★ Q-2 反证：旧写法实发 1 条事件（这正是真库里那条 `completed → draft` 的来源）');

    const db3 = mkdb();
    const take3 = watchEvents();
    const r3 = ensureDocDeliverable(db3, {
      projectId: PROJECT, taskId: 'T-new', absPath: '/proj/x/brand_new.py', displayPath: 'scripts/brand_new.py', via: 'write_file',
    });
    const evs3 = await take3();
    const row3 = rowOf(db3, r3.id)!;
    eq([r3.created, row3.type, row3.status], [true, 'doc', 'draft'],
      "★ Q-3 新建路仍在：无登记行 ⇒ 新建一行 type='doc'/status='draft'（守卫不该把正路一起堵上）");
    eq(row3.task_id, 'T-new', '★ Q-3 新行归属**本次任务**（与 Q-2 的"不夺归属"是两支，各管各的）');
    eq(evs3.length, 1, '★ Q-3 恰发 1 条事件（`forceEmit` 路径未被打断 —— 新行落库即通报，GUI 立刻看得到）');
    eq(evs3[0]!.changedFrom, 'draft', '★ Q-3 事件的 `changedFrom` 取自**行自己的原值**（新行即 draft，不是编一个"从 running 来的"）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1·判据 Q-4】枚举穷举：mcp / a2a / ui **同尺**（防"只治了 daemon"）');
  {
    for (const t of ['mcp', 'a2a', 'ui']) {
      const db = mkdb();
      insert(db, { id: `d-${t}`, type: t, status: 'running', file: `/proj/x/${t}_service.py` });
      const take = watchEvents();
      const r = ensureDocDeliverable(db, {
        projectId: PROJECT, taskId: 'T-intruder', absPath: `/proj/x/${t}_service.py`, displayPath: `${t}_service.py`, via: 'edit_file',
      });
      const evs = await take();
      eq([rowOf(db, `d-${t}`)!.status, count(db), r.created, evs.length], ['running', 1, false, 0],
        `★ Q-4 \`${t}\` 同尺：status 不变 / 不建重复行 / 零事件（"别种产出物"是一**类**，不是只有 daemon 一个特例）`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1·判据 R】复起集与成果面**不得被顺手放宽**（治的是"谁被误标"，不是"把 draft 也拉起来"）');
  {
    // zx_20261004 M15: `autoStartDaemons` 已纯搬移至 `core/daemon-supervisor.ts`（逐字节行为不变）。
    //   判据语句一字未改，只把扫描面换成该符号**唯一**的新载体。
    const ipc = strip(path.join(MAIN, 'core/daemon-supervisor.ts'));
    const i = ipc.indexOf('function autoStartDaemons');
    // ⚠ 块边界**不能按注释切**：本行上方刚把注释去了（`strip`），`/** … */` 在扫描面上已不存在，
    //   按它去找边界会得 -1 ⇒ 块一路切到文件尾 ⇒ 断言读到的是**别的函数**里的 `draft`（假红）。
    const blk = braceBlock(ipc, i);
    ok(i >= 0 && blk.includes("status IN ('running', 'stale', 'completed')"),
      "★ R-1 `autoStartDaemons` 的挑选集**仍是** ('running','stale','completed')（本轮改的是**谁被误标**，不是复起集）");
    ok(!blk.includes('draft'),
      '★ R-1 反证：该函数体内**不含 `draft`** —— 若把 `draft` 也拉进复起集，用户手工新建、从未发布的守护草案会在重启时**偷偷跑起来**');
    const j = exe.indexOf('function isRealDeliverableRow');
    const ib = exe.slice(j, exe.indexOf('\n}\n', j));
    ok(ib.includes("['running', 'registered', 'stopped', 'completed']"),
      '★ R-2 `isRealDeliverableRow` 的 daemon 白名单**一字未改**（那是另一质的矛盾——§2.3：不同质的矛盾不用同一把尺治）');
    ok(!ib.includes("'draft'"),
      '★ R-2 反证：白名单**未擅自收编 `draft`** —— 收编等于把"草稿守护"当成在册成果，治了个假');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【P】build 钉（派生核对，不写轮次字面量）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告
//    unhandled rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20260918 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260918: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
});
