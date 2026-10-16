/**
 * zx_20260920_1 受控复跑 —— 「用了才算数」。
 *
 * 病根（`plans/improve/zx_20260920_1.md` §1，真库 + 源码实测）：六条同形 —— 东西**在册**了，
 * 却**从没被用起来**，而"在册"与"在用"之间那道缝**没有任何一处代码在守**：
 *   D1 工具注册表 57 件每次**全量**注入（`toolsChars` 恒 16683），近 7 天只用到 32 件、前 2 件占 57.7%；
 *      `ADAPTIVE_STRATEGIES.priorityTools` **只写进提示词、不过滤**。
 *   D2 **79** 件 doc 交付物状态是 `draft`，**79/79 的父任务已是 `completed`**；GUI「标记完成」唯一入口
 *      `ipc/project.ipc.ts` 的 `task:updateStatus` **不 import** `promoteTaskFileDeliverables`。
 *   D3 `modelReq.capabilities` 是**字面常量** `['chat','function-calling']`；ANS 45 个模型里 19 带 vision。
 *   D4 微信入站非文本**只有 `kind`**；`data/attachments/` 不存在；非文本行**静默 return**。
 *   D5 `handleSystemQuery` 全函数只有六条 `COUNT(*)`，答不到任务层。
 *   D6 `storeText` 的 INSERT **不含 `importance` 列** ⇒ 取表默认 **0.5**；而 `synthesizeProjectKnowledge`
 *      要 **≥3 条 ≥0.6**；真库 `max(importance)` **恰是 0.5**、`>=0.6` **零行** ⇒ panorama 结构性恒 0。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 本文件的**批次门**（`RR_STAGE`）—— 本轮的骨架纪律，先说明白免得误读：
 *   方案 §4 是九个批次（M0…M8），判据**随批次转绿**。若不做区分，M0 落下时本脚本有 17 条红，
 *   而"红"既可能是"还没实施"也可能是"实施错了"，两者混在一起**信息量为零**。
 *   故：每条判据登记其**所属批次**；`RR_STAGE=Mn` 时**只要求 M0..Mn 的判据为绿**，
 *   更晚的批次打 `⏳` 并**不计入失败**。`RR_STAGE` 为空 = **全部必须绿**（M8 收口用）。
 *   ⇒ `RR_STAGE=M0` 必绿（M0 只落基线门）· 无 `RR_STAGE` 时 M0 的**红计数即"待实施清单"**，
 *    这正是方案 §4-M0 要的"**先看到红**"。
 *
 * §G 判据 G（**M0 落地的**·与批次无关的**不变式门**，任何时刻都须成立）：
 *   G-1 **哑雷门**：全量 `rr_*.ts`（含本文件）里**零**处"只为下一轮引爆"的等值字面量 —— 判据自身受判据管。
 *   G-2 **能力可达性**：ANS（`data/ans-server.db` 只读）里 `vision`/`reasoning`/`code` **各至少 1 个模型**
 *       —— 这是 M4"按形态要能力"的**前提**；前提不成立则 M4 的方案本身要改，故先钉住。
 *   G-3 **真源在位**：§1 六条病根所引用的符号**全部存在**（按符号 not 行号）——"锚点还在"是后续每批的开工前提。
 *   G-4 **收窄不得过界**（M-B 的常驻形态）：`ADAPTIVE_STRATEGIES` 六档**每档都含出口工具**
 *       （现为 `finalize_task`）—— 任何形态收窄后若把出口收掉，任务**收不了口**。
 * §C 判据 C（**随批次转绿**，`RR_STAGE` 管辖）：
 *   C1/C2（M1 工具定义机械搬迁）· C3/C4（M2 按形态分档 + 如实告知）·
 *   C5–C8（M3 成果收口三面 + 存量归位）· C9/C10（M4 模型能力匹配）·
 *   C11/C12（M5 IM 入站媒体落盘）· C13/C14（M6 IM 任务级问答）· C15–C17（M7 记忆写读刻度同源）。
 * §F 判据 F（**M9-fix**·就地补丁）：独立核验新发现的 F1–F5 —— 五条问的都是**同一句话**：
 *   「**判据跑的是生产真走的那条路吗**」。F1 生产是否真调 `buildModelRequest`（还是判据调的是生产绕开的函数）·
 *   F2/F3 回执标签是否**由生产产出的 kind 驱动**、标本是否**由生产形状构造**（手写 `kind:'image'` 喂进去 = 自我印证）·
 *   F4 build 注释台账是否与方案 §1 六条病根**同集**（写虚的台账等于没有台账）· F5 有无死 import。
 *   ⚠ F2/F3 **刻意不对 kind 的取值下断言**：用户已裁定**保持数字 `type`**（当前实现，`rr_zx_20260914_2`
 *     三处钉的上一轮契约；方案 §5 五-17，2026-09-21 **已决**）。故只钉"kind 在场 + 回执由它驱动"——
 *     日后若翻案改用 `*_item` 可读名，改的是那条契约与它的三处钉子，**本块不必动**。
 *   单开 M9 而**不塞回 M1/M4/M5**：M8 的档内判据数须保持 **0**（方案 §五-1），补丁不该动"每批判据数"这本账。
 * §S 判据 S：`checkBuildPins(ok, { distDir })`（P1–P6 全套）—— **不受批次门管辖**，
 *   build 钉是**常驻不变式**（它派生标签，故换轮不会让它变红；它变红只说明真源被破坏）。
 *
 * ⚠ 本文件**只读**真库（`data/ans-server.db` 仅 G-2 一处，以只读方式打开）；不改任何生产行为。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**（P6 取产物内 build 值本身，而非会被注释骗过的子串匹配）。
 * ⚠ 与 `zx_20260920.ts` 的**分工**：那一份治"沉默不是一种"（已收口）；本份治"用了才算数"，**互不覆盖**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { engineSrcFiles } from './lib/rr-engine-src.js';
// 生产真实现（**静态导入**，同 `rr_zx_20260916_3`/`rr_zx_20260920` 的家法）：
//   反向不变式 R-1/R-2 要**跑真函数**而不是扫它的源码子串——"字面量在场"拦不住改行为。
import { promoteTaskFileDeliverables, docNotProbe, typeIn } from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import { FILE_DELIVERABLE_TYPES } from '../apps/worker-ant-desktop/src/main/core/deliverable-types.js';
// M3 的收口清算：**直跑真实现**（喂内存夹具，不必起 Electron）——`finalize-by-human.ts` 刻意不引 electron/eventBus。
import { finalizeTaskByHuman } from '../apps/worker-ant-desktop/src/main/core/finalize-by-human.js';
// 面二的判据要**真的落一次账再读**（不是看源码里有没有那个字符串）：`recordAcceptanceOutcome` 是唯一落账口。
import { recordAcceptanceOutcome, buildAcceptanceCheckPayload, acceptanceVerdictOf, capScoreByAcceptanceVerdict, UNVERIFIED_REASON_LABEL } from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';
// 记忆侧两常量：M7 的 C15/C17 要读**真导出的值**（写刻度 / 读门槛），不手抄 0.6。
//   模块**可能尚未导出**这两个常量（M7 才落）⇒ 走命名空间导入 + 运行时判型，缺则如实判红。
import * as memMod from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
// M2 的四条判据**一律直跑真实现**（`availableToolNames` / `narrowToolFace` / `buildUnavailableNotice`），
//   不再扫源码里的 `priorityTools` 数组——那是我 M0 时猜的机制（详见 §G-4 处与 §C3/C4 处的就地订正）。
import { toolRegistry } from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';
import { availableToolNames, narrowToolFace, buildToolFaceBrief, buildUnavailableNotice, ADAPTIVE_STRATEGIES, type TaskArchetype } from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';
// M4 的 C9/C10 **外加两只行为标本**：C10 的"未配置时该键不出现"那一半源码扫不出来（见该处注记），
//   故直跑 `buildModelRequest` / `readMaxCostPer1k` **真实现**——键在场/不在场是行为，不是字面量。
import { deriveModelCapabilities, buildModelRequest, readMaxCostPer1k, MAX_COST_PER_1K_KEY } from '../apps/worker-ant-desktop/src/main/core/model-request.js';
// M5 的 C11①/②/④ 是**源码级**（"契约里有这个键" / "attachments 与 writeFile 同处一份" / 文案里有真件名）——
//   而"文件**真的**到了盘上、字节数相符、路径没穿越"三句话**源码扫不出来**，只能真写一遍。
//   `services/im-media.ts` **刻意零依赖**（不引 electron / better-sqlite3）正是为此：受控回归可直跑真实现。
import { saveInboundMedia, mediaReceiptText, mediaFromIlinkItems, attachmentsRoot } from '../apps/worker-ant-desktop/src/main/services/im-media.js';
// F3 要拿**同一张表**当期望值 ⇒ 引真源（`im-adapter` 无任何 import，引它不拖模块图）。
import { NON_TEXT_LABELS } from '../apps/worker-ant-desktop/src/main/services/im-adapter.js';
// M6 的 C13 是**行为级**的（"回复里有没有那两条真标题"源码扫不出来）⇒ 直跑真 `routeImMessage`。
import { routeImMessage } from '../apps/worker-ant-desktop/src/main/services/im-router.js';

/** 六个形态（顺序即方案 §4-M2 表格序，便于逐档对照）。 */
const ARCHETYPES: TaskArchetype[] = ['code', 'research', 'document', 'analysis', 'configuration', 'conversation'];
/**
 * 「全部在册工具」的**真名集**（键集与 `buildTools` 产出的 57 个键**为双射**——M1 已在运行期证过
 * 57 ↔ 57 零差，见 §C1/C2；此处只需名字，故不把 `agent-executor.js` 的整个模块图拖进来）。
 */
const ALL_TOOLS: Record<string, unknown> = Object.fromEntries(toolRegistry.listNames().map((n) => [n, {}]));

type AnyDb = {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
  exec: (s: string) => void;
};

let pass = 0; let fail = 0; let pending = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ── 批次门 ──────────────────────────────────────────────────────────────────
const ORDER = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'] as const;
type Batch = (typeof ORDER)[number];
const STAGE = (process.env.RR_STAGE || '').trim() as Batch | '';
/** STAGE 为空 ⇒ 全部须绿；否则**只要求 ≤STAGE 的批次**为绿（更晚的如实标"待实施"，不计入失败）。 */
const required = (b: Batch): boolean => STAGE === '' || ORDER.indexOf(b) <= ORDER.indexOf(STAGE);
/**
 * 登记一条**受批次门管辖**的判据。
 * ⚠ 未实施批次的判据**必须仍然求值**（不能短路成 `false` 了事）：本文件要的是"红**为什么**红"，
 *   故照常算出真值，只是**不计入**失败——这样收口时把门一开，看到的都是**真值**而非占位。
 */
function crit(b: Batch, cond: boolean, label: string, detail?: string): void {
  if (!required(b)) {
    pending++;
    console.log(`  ⏳ [${b}] ${label}${cond ? ' —— **已提前为真**' : ''}`);
    return;
  }
  if (cond) { pass++; console.log(`  ✓ [${b}] ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ [${b}] ${label}${detail ? ` — ${detail}` : ''}`); }
}

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const MAIN = path.join(root, `${A}/src/main`);
/** 扫源码一律**去注释**：本轮的病根正是"注释/注册表里写着有、代码里没被用上"，不去注释则判据会被喂饱。 */
const strip = (p: string) => stripKeepingLines(fs.readFileSync(p, 'utf-8')).join('\n');
const raw = (p: string) => fs.readFileSync(p, 'utf-8');

/**
 * zx_20260921 M8：`executeTask` 按职责拆出 `core/exec-*.ts`（认领/选型/预算/上下文/收口）⇒
 * 凡判据的**本意是"某功能的实现必须经由某个写口"**（而实现落在哪个文件只是**当时的落点**）的，
 * 扫描面取「执行体 ∪ `core/exec-*.ts`」——定义与目录约定**只有 `lib/rr-engine-src.ts` 一处**，
 * 此处引它以避下次搬迁又漏。
 *
 * ⚠ 只许更严：整段代码横跨两处，任一处出现违例即红。
 * ⚠ 反面同样要守：**本意就是"某个特定文件"**的判据（F4 的 build 台账、F5 的 executor 死 import、
 *   G-3 的符号在位）**不得**改用它——那些判据的**文件名本身就是判据**，换并集是**变松**。
 */
const execSurfaceFiles = engineSrcFiles();
const execSurface = () => execSurfaceFiles.map((p) => strip(path.join(root, p))).join('\n');
const execSurfaceBase = () => execSurfaceFiles.map((p) => `${path.relative(root, p)} (${strip(path.join(root, p)).length})`).join(' + ');

/** 递归收集 `src/main` 下全部 `.ts`——多条判据的扫描面是**整个 src_main**，不是只扫 `core/`。 */
function walkTs(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
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

/**
 * 取「**工具定义键**」——`buildTools` 返回的是一个**以工具名为键**的对象字面量：
 *   `find_best_model: {\n  description: …,\n  …\n  execute: …\n}`
 * 故识别形状是「行首缩进的标识符 + `:` + `{`，且随后**首个非空行**以 `description:` 开头」。
 *
 * ⚠ 为什么不能用 `name: 'read_file'` 这类写法去认（**M0 实测踩过的坑**）：
 *   `TOOL_METAS` 里确实是 `{ name: 'read_file', … }`，但 `buildTools` 里**根本没有 `name:` 字段**
 *   —— 名字就是键本身。第一版判据按 `name:` 去扫 `agent-executor.ts`，得 **0 命中**，
 *   于是 C2「不再含任何工具定义」**假绿**。此注记留在此处，免得下轮重犯。
 */
function toolKeysOf(src: string): string[] {
  const re = /(?:^|\n)[ \t]*([a-z_][a-z0-9_]*):\s*\{\s*\n[ \t]*description:/g;
  return [...src.matchAll(re)].map(m => m[1]!);
}

// ── M6 夹具 ────────────────────────────────────────────────────────────────
// `node:sqlite` 无 better-sqlite3 的 `.transaction()`——补最小等价 shim（与其它 rr 同法；
// `routeImMessage` 的下游会用到）。
const withTx = (d: DatabaseSync) => {
  (d as unknown as { transaction: unknown }).transaction = (fn: () => void) => () => fn();
  return d;
};

/**
 * 「查看系统状态」这条路径真的会碰的表，**照抄 `database.ts` 的 DDL**（列不齐即会在生产能过的地方
 * 抛错——那反倒证不了本想证的事）。逐一对应：
 *   `wa_im_conversations` ← `routeImMessage` 落库；`wa_settings` ← `refreshImUnread`；
 *   `wa_projects` ← `tryImCommand`；`wa_tasks` ← 计数与下钻；`wa_task_conversations` ← 「最近一步」。
 */
const QUERY_PATH_SCHEMA = `
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, name TEXT DEFAULT '', config TEXT NOT NULL DEFAULT '{}', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_conversations (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT,
  message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound',
  created_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'sent', last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT '');
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', cron_schedule TEXT, working_dir TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace',
  owner_id TEXT, cron_timezone TEXT DEFAULT 'Asia/Shanghai',
  autonomous_mode TEXT DEFAULT 'off', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_task_conversations (
  id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '',
  tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
`;
const mkQueryDb = () => { const d = withTx(new DatabaseSync(':memory:')); d.exec(QUERY_PATH_SCHEMA); return d as unknown as AnyDb; };

/**
 * 走**真 `routeImMessage`** 发一条消息，收回话数组（`text` 缺省即「查看系统状态」）。
 *
 * ⚠ 每个标本用**不同的 `fromUser`**：正文去重键是 `channelType:fromUser:text`（30s 窗）+ 风暴闸按
 *   `fromUser` 计数——同一用户连问两次会被静默去重，断言会读到**空数组**（假红）。
 */
async function routeOnce(db: AnyDb, user: string, text = '查看系统状态'): Promise<string[]> {
  const replies: string[] = [];
  const ctx = {
    db, channelId: 'ch-demo', channelType: 'wechat',
    sendReply: async (_to: string, t: string) => { replies.push(t); },
  };
  await routeImMessage(ctx as never, user, text, 'private', '');
  return replies;
}

/** 往夹具里塞一个任务（`updated_at` 显式给，下钻按它排序）。 */
function seedTask(db: AnyDb, id: string, title: string, status: string, updatedAt: string): void {
  db.prepare(
    'INSERT INTO wa_tasks (id, project_id, title, status, context_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, 'P', title, status, '{}', updatedAt, updatedAt);
}

async function main(): Promise<void> {
  // ═════════════════════════════════════════════════════════════════════════
  console.log(`\n【G】M0 不变式门（批次无关，任何时刻须成立）${STAGE ? `　[RR_STAGE=${STAGE}]` : '　[RR_STAGE=全部]'}`);

  // ── G-1 哑雷门 ────────────────────────────────────────────────────────────
  {
    // 「只为下一轮引爆」：把一个**本轮为真、换轮后必假**的轮次字面量，与一个**会随轮次变化**的值
    // 做**等值比较**（`eq(x, 'zx_…')` / `x === 'zx_…'`）。
    //
    // ⚠ **第一版判据是错的，留此注记**：它扫的是"行内出现裸 `zx_YYYYMMDD` 字面量"，得 **62 处**——
    //   绝大多数是**合法**的（文档串里的"（zx_20260913 M2-1 起…）"、`!includes(...)` 形式的**反向**钉、
    //   扫描器自检用的**人造**夹具轮次）。⇒ 判据的**扫描面按表面标识定而非按病根形态定**，
    //   正是本仓反复记过的错法。收窄为"**参与等值比较**"这一形态后，命中降到个位数。
    //
    // 与 `checkBuildPins` 的分工：P5 管 `build:` / `ROUND =` / `includes(` 三种前缀形式的钉；
    //   本门补**等值比较**这一种（正是 `rr_zx_20260913` 那处哑雷躲过 P5 的语法外壳）。
    const rrDir = path.join(root, 'scripts');
    const self = path.basename(__filename);
    // 等值比较 + 裸轮次字面量（三面：`eq(x, 'zx_…')` / `=== 'zx_…'` / `!== 'zx_…'`）
    const eqLit = /(?:eq\([^,)]*,\s*|===?\s*|!==?\s*)'(zx_\d{8}(?:_\d+)?)'/g;
    // **人造夹具轮次**：扫描器自检故意喂的假值——不是真轮次，豁免。
    // ⚠ **M0 复核时改准过一字**：第一版写 `/zx_(?:1[0-2]|2|1900|2000)\d{6}/`，那个裸 `2` 分支是**灾难**——
    //   它匹配**任何以 2 开头的轮次**，`zx_20260912` 之类**全被当成人造夹具豁免** ⇒
    //   "零新增"**假绿**、"已知存量 0 处"**假红**（同一处正则错，两个方向的错同时发生）。
    //   真判据按**语义**定：轮次是日期，**年份落在近十年之外**即人造（实测人造值恰是
    //   `11010101`/`10990101`/`10990102`/`19000101`/`19990101`/`20000202`/`20990101` 七种，年份 1099–2099）。
    const SYNTHETIC = (lit: string): boolean => {
      const y = Number(lit.slice(3, 7));
      return !(y >= 2020 && y <= 2030);
    };
    // **已知存量**（本门登场前就在的，按**文件 + 断言标签**记，不按行号——行号是位置会漂）。
    //   ⚠ 这三处的**共同形状**：拿一份**冻结的** `data/baseline_zx_<轮>.json` 里的 `round` 字段
    //     与一个写死的同轮字面量相比。因为基线文件按轮冻结、永不重写，它们**至今不红**；
    //     但也正因此，**一旦有人重写那份基线就会引爆**。已登记方案 §五；本门**不替它们背锅**，
    //     只要求"**不许再多一处**"。
    const KNOWN_LEGACY_LABEL = /基线 round 正确|round 标识为本轮/;
    const offenders: string[] = [];
    let synthetic = 0;
    let legacy = 0;
    for (const f of fs.readdirSync(rrDir).filter(n => /^rr_.*\.ts$/.test(n))) {
      const src = stripKeepingLines(fs.readFileSync(path.join(rrDir, f), 'utf-8')).join('\n');
      src.split('\n').forEach((t) => {
        eqLit.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = eqLit.exec(t)) !== null) {
          const lit = m[1]!;
          if (SYNTHETIC(lit)) { synthetic++; return; }               // 人造夹具 → 豁免
          // 由载体自身派生（本行同时含 basename(__filename) / thisRound 派生）→ 豁免
          if (/basename\s*\(\s*__filename\s*\)|thisRound|ROUND_RE/.test(t)) return;
          if (KNOWN_LEGACY_LABEL.test(t)) { legacy++; return; }       // 已知存量三处 → 豁免但计数
          offenders.push(`${f}: ${t.trim().slice(0, 100)}`);
        }
      });
    }
    ok(offenders.length === 0,
      '★ G-1 哑雷门：全量 rr 内**零**处**新增**的"等值比较裸轮次字面量"（判据自身受判据管）',
      offenders.length ? `新增 ${offenders.length} 处 —— ${offenders.slice(0, 5).join(' ｜ ')}` : '零新增');
    // **自证**：扫描面非空 + 两种豁免**都确实命中了**（否则"零新增"可能是正则写错导致的空转假绿）
    const nRr = fs.readdirSync(rrDir).filter(n => /^rr_.*\.ts$/.test(n)).length;
    ok(nRr >= 60, `★ G-1 自证①：扫描面非空（在册 rr 脚本 ${nRr} 份，含本文件 ${self}）`);
    ok(synthetic >= 4 && legacy >= 3,
      '★ G-1 自证②：两类豁免**都确实命中**（人造夹具 ≥4 处、已知存量 ≥3 处）—— 证明正则**在认**，不是空转',
      `人造夹具 ${synthetic} 处 / 已知存量 ${legacy} 处`);
  }

  // ── G-2 能力可达性（M4 的前提：ANS 里确实有带这些能力的模型）───────────────
  {
    const ansPath = path.join(root, 'data/ans-server.db');
    let caps: string[] = [];
    let total = 0;
    try {
      const db = new DatabaseSync(ansPath, { readOnly: true }) as unknown as AnyDb;
      const rows = db.prepare("SELECT capabilities FROM ans_ai_models").all() as Array<{ capabilities?: string | null }>;
      total = rows.length;
      caps = rows.map(r => String(r.capabilities || ''));
      (db as unknown as { close: () => void }).close();
    } catch (e) {
      ok(false, '★ G-2 能力可达性：ANS 库只读打开失败（**未证**，不得读作通过）', String((e as Error).message).slice(0, 120));
    }
    // 真值解析：capabilities 是 JSON 数组串（如 `["chat","function-calling"]`）——**不做子串匹配**，
    //   否则 `code` 会被 `function-calling` 之外的串误命中、`vision` 会被任意含它的名字命中。
    const hasCap = (c: string): boolean => caps.some(s => {
      try { const arr = JSON.parse(s) as unknown; return Array.isArray(arr) && arr.map(String).includes(c); }
      catch { return false; }
    });
    ok(total > 0, `★ G-2 自证：ANS ` + '`ans_ai_models`' + ` 非空（${total} 行）`);
    for (const c of ['vision', 'reasoning', 'code'] as const) {
      const n = caps.filter(s => { try { const a = JSON.parse(s) as unknown; return Array.isArray(a) && a.map(String).includes(c); } catch { return false; } }).length;
      crit('M0', hasCap(c), `G-2 ANS 内有模型带能力 \`${c}\`（M4"按形态要能力"的**前提**）`, `命中 ${n}/${total}`);
    }
  }

  // ── G-3 真源在位（§1 六条病根引用的符号全部存在）──────────────────────────
  {
    const exe = strip(path.join(MAIN, 'core/agent-executor.ts'));
    const ipl = strip(path.join(MAIN, 'ipc/project.ipc.ts'));
    const mem = strip(path.join(MAIN, 'core/memory-manager.ts'));
    const imr = strip(path.join(MAIN, 'services/im-router.ts'));
    const wxa = strip(path.join(MAIN, 'services/wechat-adapter.ts'));
    const arc = strip(path.join(MAIN, 'core/task-archetype.ts'));
    const reg = strip(path.join(MAIN, 'core/tool-registry.ts'));
    const symbols: Array<[string, string, string]> = [
      ['D1', exe, 'buildTools'],
      ['D1', reg, 'TOOL_METAS'],
      ['D1', arc, 'priorityTools'],
      ['D2', ipl, 'task:updateStatus'],
      ['D2', strip(path.join(MAIN, 'core/deliverable-lifecycle.ts')), 'promoteTaskFileDeliverables'],
      ['D2', ipl, 'cleanupTaskExecutionJobs'],
      ['D3', exe, 'getOptimalModel'],
      ['D4', wxa, 'extractText'],
      ['D4', imr, 'isNonText'],
      ['D5', imr, 'handleSystemQuery'],
      ['D6', mem, 'storeText'],
      ['D6', mem, 'synthesizeProjectKnowledge'],
    ];
    const gone = symbols.filter(([, src, name]) => !src.includes(name)).map(([d, , name]) => `${d}:${name}`);
    ok(gone.length === 0,
      '★ G-3 真源在位：§1 六条病根所引符号**全部存在**（按符号，不按行号）',
      gone.length ? `缺 ${gone.join(', ')}` : `${symbols.length} 个符号全部在位`);
  }

  // ── G-4 收窄不得过界：**M2 的目标态**（不是 M0 的不变式）──────────────────
  //
  // ⚠ **归位订正**：本条原登记为 M0 不变式，M0 首跑即红（缺出口 5 档 / 缺读 1 档）——
  //   一跑就红的"不变式"**根本不是不变式**，是**目标态**。它属于 M2（"按形态分档"正是要把它做出来），
  //   故改挂 M2 批次门：M0 阶段如实标 ⏳，M2 落地后转绿。此处留注记，免得下轮把它又当"既有门"。
  //
  // ⚠ **M2 就地订正（第 2 次归位）**：原判据读的是**源码里的 `priorityTools` 数组**——那是我 M0 时
  //   **猜的机制**（以为分档＝把种子数组撑大）。M2 实际采用的机制是「**类目档位表** ⇒ 派生可用集」
  //   （`priorityTools` 仍是倾斜提示、**不扩张**）⇒ 原判据会**恒红**，而它要守的语义（M-B 反向可达性）
  //   在**派生集**上成立。⇒ 改为对 `availableToolNames` 的**真实现**直跑（比扫数组更强：它测的是
  //   真正会被注入的那一份）。新旧对照与理由已回填方案 §4-M2「四、判据的具体化」。
  {
    const sets = ARCHETYPES.map((a) => ({ a, names: availableToolNames(a) }));
    // 自证（不受批次门管辖）：六档都读到了非空集 —— 否则"缺 N 档"是空转
    ok(sets.length === 6 && sets.every((s) => s.names.length > 0),
      `G-4 自证：六档可用集**皆非空**（实测 ${sets.map((s) => `${s.a}=${s.names.length}`).join(' / ')}）`);
    const noExit = sets.filter((s) => !s.names.includes('finalize_task'));
    crit('M2', noExit.length === 0,
      '★ G-4 六档形态**每档都含出口工具** `finalize_task`（收窄后若把出口收掉，任务**收不了口**）',
      `缺出口的档数 ${noExit.length}${noExit.length ? `（${noExit.map((s) => s.a).join(',')}）` : ''}`);
    const noRead = sets.filter((s) => !s.names.includes('read_file'));
    crit('M2', noRead.length === 0,
      '★ G-4 六档形态**每档都含 `read_file`**（M-B 反向可达性：读是任何形态的底线）',
      `缺读工具的档数 ${noRead.length}${noRead.length ? `（${noRead.map((s) => s.a).join(',')}）` : ''}`);
    // 收窄的**新病根**：把种子工具收在档外 ⇒ 提示词会**推荐一个调不到的工具**（名实不符）。
    const seedOut = sets.filter((s) => ADAPTIVE_STRATEGIES[s.a].priorityTools.some((n) => !s.names.includes(n)));
    crit('M2', seedOut.length === 0,
      '★ 收窄后**种子仍在档内**：六档 `priorityTools` ⊆ 本档可用集（提示词不得推荐一个调不到的工具）',
      `种子越界的档数 ${seedOut.length}${seedOut.length ? `（${seedOut.map((s) => s.a).join(',')}）` : ''}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 【R】**反向不变式** —— 与批次门**无关**：它们**今天就为真**，本轮各批**不得把它们改红**。
  //
  // ⚠ **归位订正（M0 复核时发现）**：这几条原登记为各自批次的判据（C6 反向 / C12 / C14 / C16）。
  //   但"反向钉"按定义**当下即真**——把它挂在 M3/M5/M6/M7 的门后，等于**只在风险出现那一批才检查**，
  //   而真正会把它改红的往往是**更早**的批次（如 M2 动工具集时顺手动了 `isNonText` 的止步）。
  //   ⇒ 反向钉的**正确归属是不变式**，不是批次判据。故上移至此处，**每跑必检**。
  //
  // 这批判据的价值在于：本轮主题是"改行为"（收窄/落盘/下钻），**改行为最容易的代价是踩坏既有语义**。
  //   四条各自锁住一条**上一轮已裁定**的语义，它们一旦变红就是**回归**而非"还没做"。
  console.log('\n【R】反向不变式（今日即真 · 各批不得改红）');
  {
    const imr = strip(path.join(MAIN, 'services/im-router.ts'));
    const mem = strip(path.join(MAIN, 'core/memory-manager.ts'));

    // R-1 / R-2 是**行为**判据（不是扫源码子串）：直接在内存夹具上跑**生产真实现** `promoteTaskFileDeliverables`。
    //   ⚠ 为什么不用"正则看 SQL 里有没有 `status='draft'`"这种写法（**M0 复核时否掉的第一版**）：
    //     那只是"字面量在场"，改个谓词顺序/拆个常量就能躲过，而**行为**一个都拦不住。
    //     本仓纪律（`feedback_predicate_needs_both_sides_specimen`）：**该命中与不该命中两只标本一起试**。
    const mkDb = (): AnyDb => {
      const db = new DatabaseSync(':memory:') as unknown as AnyDb;
      db.exec(
        `CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT DEFAULT '{}');
         CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, name TEXT, file_path TEXT,
           type TEXT DEFAULT 'doc', status TEXT DEFAULT 'draft', updated_at TEXT, acceptance_verified INTEGER DEFAULT 0);`,
      );
      return db;
    };
    /** 夹具：一个任务 + 一件产出物 ⇒ 跑真 `promoteTaskFileDeliverables` ⇒ 返回 (提升数, 事后状态)。 */
    const runPromote = (ctx: string, file: string, type = 'doc', status = 'draft'):
      { promoted: number; after: string | undefined; skipped?: string; error?: string } => {
      const db = mkDb();
      db.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('T1', ctx);
      db.prepare('INSERT INTO wa_deliverables (id, project_id, task_id, name, file_path, type, status) VALUES (?,?,?,?,?,?,?)')
        .run('D1', 'P', 'T1', `r.${type}`, file, type, status);
      const r = promoteTaskFileDeliverables(db as never, 'T1');
      const row = db.prepare('SELECT status FROM wa_deliverables WHERE id = ?').get('D1') as { status?: string } | undefined;
      (db as unknown as { close: () => void }).close();
      return { promoted: r.promoted, after: row?.status, skipped: r.skipped, error: r.error };
    };

    // R-1 **该命中**：普通 doc 草稿 ⇒ 提升为 completed。
    //     这是分母——若这一条不成立（恒 0），下面"该不命中为 0"就全是空转假绿。
    const hit = runPromote('{}', '/w/report.md');
    ok(hit.promoted === 1 && hit.after === 'completed',
      '★ R-1 **该命中**标本：普通 doc 草稿 ⇒ `promoted===1` 且状态变 `completed`（分母 · 防后面空转假绿）',
      `promoted=${hit.promoted} after=${hit.after} err=${hit.error ?? '-'}`);

    // R-1 **该命中②**（zx_20260930 M3-f **就地订正**）：`code` 草稿**也**提升。
    //   本条原写「`code` 草稿**不**提升（范围未放宽）」——那是**旧病根**（类型判据硬写 `type='doc'`，
    //   `promoteTaskFileDeliverables` 从不提升 `code` 成果，即 §1 基线第 3 行「非 doc 成果恒 draft」）。
    //   本轮该病根已修（改走集合真源 `typeIn('', FILE_DELIVERABLE_TYPES)` = doc ∪ code）⇒ 断言随实变。
    //   ⚠ 这是**改钉新真源**，不是放宽：下面「该不命中」仍钉住已终态与探针两类（范围并未放到"凡草稿都提升"）。
    const code = runPromote('{}', '/w/r.code', 'code', 'draft');
    ok(code.promoted === 1 && code.after === 'completed',
      '★ R-1 **该命中②**标本：`code` 草稿 ⇒ `promoted===1` 且变 `completed`（M3-f 修 §1 基线第 3 行「非 doc 成果恒 draft」）',
      `promoted=${code.promoted} after=${code.after} err=${code.error ?? '-'}`);

    // R-1 **该不命中**：范围**恰为** `status='draft'` 的文件型成果（doc ∪ code）—— 已终态者一律不动。
    //   病根是"GUI 路没接线"，**不是"范围太窄"**；后人很容易顺手改成"凡 delivered 都提升"。
    //   另：服务型（`mcp`/`daemon`/`ui`/`a2a`）不属文件型成果，也**不得**被提升（集合真源的另一半）。
    const done = runPromote('{}', '/w/r.md', 'doc', 'completed');
    const deliv = runPromote('{}', '/w/r.md', 'doc', 'delivered');
    const svc = runPromote('{}', '/w/server.py', 'daemon', 'draft');
    ok(done.promoted === 0 && deliv.promoted === 0 && svc.promoted === 0,
      '★ R-1 **该不命中**标本：已 `completed` / 已 `delivered` / 服务型 `daemon` 草稿 **三者皆不提升**（范围未放宽到终态或服务型）',
      `completed=${done.promoted} delivered=${deliv.promoted} daemon=${svc.promoted}`);

    // R-2 **该不命中**：`deliverable_unfulfilled.forced === true` 时**不提升**（不夺已有裁定 ·
    //   zx_20260911_4 M4-1 红线）。"收口三面"最容易犯的错就是顺手把它一起抹平。
    const forced = runPromote('{"deliverable_unfulfilled":{"forced":true}}', '/w/report.md');
    //   **该命中**（反向的边界也一起钉住）：`deliverable_unfulfilled` **只记着重试簿记**（无 `forced`）
    //   时**仍提升** —— zx_20260911_4 修的就是"把重试簿记也当红线"（E10 实测 20 条永停 draft）。
    const bookkeep = runPromote('{"deliverable_unfulfilled":{"paths":[],"note":"x","retries":2}}', '/w/report.md');
    // R-2 **该不命中②**：探针 doc（`docNotProbe` 路径段级：段内以 `_` 开头且含 probe/verify/tmp）不提升。
    const probe = runPromote('{}', '/w/_probe_check.md');
    ok(forced.promoted === 0 && forced.skipped === 'deliverable_unfulfilled' && bookkeep.promoted === 1 && probe.promoted === 0,
      '★ R-2 `forced===true` 不提升 / 纯重试簿记**仍**提升 / 探针 doc 不提升（三只标本一次钉死）',
      `forced=${forced.promoted}(${forced.skipped ?? '-'}) 簿记=${bookkeep.promoted} 探针=${probe.promoted}`);

    // R-3 非文本**仍不进入** agent 自由回复路（zx_20260920 D3 用户裁定「默认不回」）。
    //   M5 要"落盘 + 如实回话"，最容易犯的错是**顺手把它放进自由回复路**——
    //   那就把上一轮刚立的规矩推翻了。判据：`if (isNonText) { … return; }` 的**止步**仍在。
    const ni = imr.indexOf('if (isNonText)');
    const niBlk = ni < 0 ? '' : braceBlock(imr, ni);
    ok(ni >= 0 && /return/.test(niBlk),
      '★ R-3 非文本**仍止步**于指令/建任务/自由回复管道之前（D3 裁定「默认不回」不被本轮推翻）',
      ni < 0 ? '找不到 `if (isNonText)` 止步点' : `止步块 ${niBlk.replace(/\s+/g, ' ').slice(0, 70)}…`);

    // R-4 「帮助」的原义**未被吞**：`/help` 仍回**内置命令清单**（M6 要把「查看」下钻到任务层，
    //   很容易把 help 一起改成"查任务"）。判据：内置清单文案在场。
    //   ⚠ zx_20260924_1 M1 订正：清单文案（含"内置"二字）**已迁入** `services/im-commands.ts` 的
    //     `BUILTIN_IM_COMMANDS`，路由侧只剩注释（`strip` 后为 0 处）⇒ 原 `/内置|builtin/.test(imr)` 会
    //     **把合法重构误判成回归**。改钉更强的真源：①真源导出该表；②路由**引**它（帮助那一栏由它派生）。
    const cmdsSrc = strip(path.join(MAIN, 'services/im-commands.ts'));
    const builtinHelp = /export const BUILTIN_IM_COMMANDS\b/.test(cmdsSrc)
      && imr.includes('BUILTIN_IM_COMMANDS') && /帮助|help/i.test(imr);
    ok(builtinHelp, '★ R-4 「帮助」仍回**内置命令清单**（M6 下钻任务层时不得把 help 一起吞掉）');
    // R-4 **行为半条**（zx_20260920_1 M6 补）：上面那半条只看"源码里有没有'内置'二字"，
    //   拦不住"把 `HELP_REGEX` 的认领点挪到 `handleSystemQuery` 之后"这种改法——
    //   那样 `/help` 会被当成"查看任务"吃掉，而源码里"内置"二字**一个不少**。
    //   故真发一条「帮助」：回话里必须有**内置指令清单**，且**不得**混进任务标题。
    {
      const hb = mkQueryDb();
      hb.prepare("INSERT INTO wa_projects (id, name, status) VALUES ('P','演示项目','active')").run();
      seedTask(hb, 'T-h', '这是一条不该出现在帮助里的任务标题', 'executing', '2026-09-20 03:00:00');
      const hr = (await routeOnce(hb, 'u-m6-help', '帮助'))[0] ?? '';
      ok(/可用指令/.test(hr) && /创建任务/.test(hr) && !/不该出现在帮助里/.test(hr),
        '★ R-4（行为）真发「帮助」⇒ 仍回**内置指令清单**，且**不混入任务标题**（下钻不得把 help 一起吞掉）',
        hr.replace(/\n/g, ' ⏎ ').slice(0, 100));
    }

    // R-5 存量 774 行 importance **不被全库重写**（用户裁定：只修新写入，存量不动）。
    //   判据形态：凡 `UPDATE wa_memories SET importance …` 都必须**带 id 谓词**（逐行写）。
    //   ⚠ **窗口宽度是踩过的坑**：第一版写 `[^;]{0,120}`，而最长的合法逐行写
    //     （`…importance = MIN(1.0, importance + ?), success_count = …, last_reinforced_at = …, updated_at = … WHERE id = ?`）
    //     从 `importance` 到 `WHERE` **有 159 字**——窗口截断在 WHERE 之前 ⇒ 8 处合法写点**全被读成"无条件"**（假红）。
    //     改 `{0,320}`（留 2 倍余量），并把**逐行写点数**作为自证打出：若为 0 则"零处无条件"是空转假绿。
    const allImpUpdates = [...mem.matchAll(/UPDATE\s+wa_memories\s+SET\s+importance[^;]{0,320}/g)].map(m => m[0]);
    const perRow = allImpUpdates.filter(s => /WHERE\s+id\s*=/.test(s)).length;
    const blanket = allImpUpdates.filter(s => !/WHERE\s+id\s*=/.test(s));
    ok(perRow > 0,
      `★ R-5 自证：库内**确有**逐行写点（${perRow} 处带 id 谓词）—— "零处无条件"不是空转的假绿`);
    ok(blanket.length === 0,
      '★ R-5 **零处**无条件全库重写 `importance`（存量 774 行不动 · 用户裁定；只修新写入）',
      blanket.length ? `命中 ${blanket.length} 处：${blanket.slice(0, 3).map(s => s.replace(/\s+/g, ' ').slice(0, 60)).join(' ｜ ')}` : '零命中');

    // R-6 六档 `priorityTools` 皆是**在册工具的非空真子集**。
    //   今天即真（实测 6 档各自 4/4/3/4/4/1 件，全部命中 `TOOL_METAS`）。
    //   它守的是 M1/M2 的**共同底线**：M1 搬工具、M2 改档位，**任一动作都可能把某个工具名写成不存在的名字**
    //   —— 那样收窄后任务会在运行期"点了名却没有这件工具"，而且**不会有任何一处代码报错**。
    {
      const arc = strip(path.join(MAIN, 'core/task-archetype.ts'));
      const reg = strip(path.join(MAIN, 'core/tool-registry.ts'));
      const registered = new Set([...reg.matchAll(/name:\s*'([a-z_][a-z0-9_]*)'/g)].map(m => m[1]!));
      const blk = braceBlock(arc, arc.indexOf('ADAPTIVE_STRATEGIES'));
      const sets = blk.split(/priorityTools:\s*\[/).slice(1).map(s => {
        const c = s.indexOf(']');
        return c < 0 ? [] : s.slice(0, c).split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
      });
      const empty = sets.filter(s => s.length === 0).length;
      const unknown = sets.flat().filter(n => !registered.has(n));
      ok(sets.length === 6 && empty === 0 && unknown.length === 0,
        '★ R-6 六档 `priorityTools` 皆为**在册工具的非空真子集**（M1 搬工具 / M2 改档位都不得写出不存在的工具名）',
        `档数 ${sets.length} / 空档 ${empty} / 不在册 ${unknown.length}${unknown.length ? '：' + unknown.join(', ') : ''}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C】本轮判据（随批次转绿）');
  {
    // ── M1 · C1/C2 工具定义机械搬迁 ──────────────────────────────────────────
    {
      const exePath = path.join(MAIN, 'core/agent-executor.ts');
      const exe = strip(exePath);
      const toolsDir = path.join(MAIN, 'core/tools');
      const toolFiles = fs.existsSync(toolsDir) ? walkTs(toolsDir) : [];
      const toolSrc = toolFiles.map(strip).join('\n');
      const metas = strip(path.join(MAIN, 'core/tool-registry.ts'));

      // **一处真源**：工具名清单**只从 `TOOL_METAS` 派生**，不手抄、也不从被搬走的那一侧取。
      const names = [...metas.matchAll(/name:\s*'([a-z_][a-z0-9_]*)'/g)].map(m => m[1]!);
      const uniq = [...new Set(names)];
      // **搬走前的真形状**（M0 实测）：`buildTools` 里 57 件工具的**名字是对象键**，不是 `name:` 字段。
      //   ⚠ 第一版判据用 `name:\s*'<工具>'` 去扫 `agent-executor.ts`，得 **0 命中** ⇒
      //     "executor 里已无工具定义" **假绿**（它本来就没有 `name:` 字段可命中）。故必须用 `toolKeysOf`。
      //
      // **M0 自证（不受批次门管辖）**：工具定义**无论在哪个文件里**，其键集必须与 `TOOL_METAS.name` **恰好双射**。
      //   ⚠ **当场订正**：本行原先断言的是"`buildTools` 里键集恰为 57"——那是**只在 M1 之前为真**的字面量，
      //     随 M1 落地即翻红。判据自身也是"只为某一轮为真"的哑雷，按 `feedback_assertion_no_forward_literals`
      //     改成**位置无关**表述：键集 = 注册表，与"定义住在哪一侧"无关（两侧并起来数）。
      const exeKeys = toolKeysOf(exe);
      const allKeys = [...new Set([...exeKeys, ...toolKeysOf(toolSrc)])];
      const missingFromAll = uniq.filter(n => !allKeys.includes(n));
      const strayInAll = allKeys.filter(k => !uniq.includes(k));
      ok(missingFromAll.length === 0 && strayInAll.length === 0 && uniq.length > 0,
        `★ C1/C2 自证：工具**键集**（executor ${exeKeys.length} + core/tools ${toolKeysOf(toolSrc).length}` +
        ` ⇒ 去重 ${allKeys.length}）与 \`TOOL_METAS.name\`（${uniq.length}）**恰为双射**（**位置无关**）`,
        `差集：缺 ${missingFromAll.length} / 编外 ${strayInAll.length}`);

      crit('M1', toolFiles.length > 0,
        'C1 工具定义已拆到 `core/tools/**`（目录存在且非空）',
        `实测 ${toolFiles.length} 份`);
      const afterKeys = toolKeysOf(toolSrc);
      // C1 正向：注册表每一件都在 core/tools 里有定义
      const missing = uniq.filter(n => !afterKeys.includes(n));
      crit('M1', uniq.length > 0 && missing.length === 0,
        `C1 注册表 ${uniq.length} 件工具的**每一件**都在 \`core/tools/**\` 里有定义（无缺员）`,
        missing.length ? `缺 ${missing.length} 件：${missing.slice(0, 8).join(', ')}` : '零缺员');
      // C1 反向：core/tools 里不得有注册表之外的工具（无编外）
      const strays = [...new Set(afterKeys)].filter(n => !uniq.includes(n));
      crit('M1', strays.length === 0,
        'C1 反向：`core/tools/**` 内**无编外工具**（每个都必须在 `TOOL_METAS` 在册）',
        strays.length ? `编外 ${strays.length} 件：${strays.slice(0, 8).join(', ')}` : '零编外');
      // C2：executor 里不再含任何工具定义（**按对象键认**，双射两侧都查）
      const still = uniq.filter(n => toolKeysOf(exe).includes(n));
      crit('M1', uniq.length > 0 && toolKeysOf(exe).length === 0,
        `C2 \`agent-executor.ts\` 内**不再含**任何工具定义（注册表 ${uniq.length} 件**逐键零出现**）`,
        toolKeysOf(exe).length ? `残留 ${toolKeysOf(exe).length} 件：${still.slice(0, 8).join(', ')}` : '零残留');
      const lines = raw(exePath).split('\n').length;
      crit('M1', lines <= 5400,
        'C2 `agent-executor.ts` 行数**较 M1 前下降 ≥1200**（M1 前实测 6609 行）',
        `实测 ${lines} 行（目标 ≤5400）`);
    }

    // ── M2 · C3/C4 按形态分档 + 如实告知（"六档皆非空真子集"的不变式已上移【R】R-6）──
    //
    // ⚠ **M0 复核时改准过一次**（原 C3 写 `…|toolsForArchetype|availableToolsOf` 这类**凭空想出的名字**，
    //   判据认的是"我猜的命名"而非"要发生的事"）——那次改的是**命名依赖**，但仍是**扫源码**。
    // ⚠ **M2 再订正（这次是机制依赖）**：M0 两处源码扫描都建在我当时**猜的机制**上：
    //   ① C3① 读 `priorityTools` 数组 ⇒ 那六份今天**已互不相同**，等于**今天就是绿的、什么都没检查**；
    //   ② C3② 读"`priorityTools` 在 `buildTools` 之后被消费" ⇒ M2 真实机制是「类目档位 ⇒ 派生可用集」
    //      而非"把种子数组撑大"，故该条**恒红**。
    //   ③ C4 扫 `disableToolGracefully` 的 reason 子串 ⇒ 与采用的机制（NoSuchToolError 支）无关。
    //   ⇒ 三条统一改为**直跑真实现 + 两侧标本**（判据测的是"真正会发生的事"，不是"我猜的写法"）。
    //   新旧对照、每条为何改、改前为何红，全部回填方案 §4-M2「四、判据的具体化」。
    {
      // ① 分档**互不相同**（若六档同集 = 没分）—— 在**派生集**上比，不在种子数组上比。
      const sets = ARCHETYPES.map((a) => ({ a, names: availableToolNames(a) }));
      const uniq = new Set(sets.map((s) => [...s.names].sort().join('|')));
      crit('M2', sets.length === 6 && uniq.size > 1,
        'C3① 六档形态的可用集**互不相同**（"分档"若六档同集 = 没分）',
        `实测 ${sets.length} 档 / 去重后 ${uniq.size} 种（${sets.map((s) => `${s.a}:${s.names.length}`).join(' ')}）`);
      // ② 收窄**真发生**：拿**真 57 件在册工具**喂 `narrowToolFace`，看它是否真删掉档外件。
      //    标本取 `conversation`（方案 §4-M2 边界里的最窄档）。
      //
      // ⚠ **M10 换标本（判据前提被本轮设计合法改变，非放宽）**：原标本 `spawn_debate` 属 `resource` 类目，
      //   而 zx_20260930 M10 把 `resource` 加进了 `conversation`（IM 里那句"用那个技能/帮我搜搜"此前够不着
      //   任何工具）⇒ `spawn_debate` 如今**在档内**，拿它当"档外件"就不再成立。改用 `write_file`
      //   （`write` 类目，**本档确定不收**，且与 `execute_command` 分属两类）；断言的**强度不变**：
      //   仍点名一件具体的档外工具、"它被删"、"它在 keep 里找不到"，另加 `execute_command`（`shell` 类目）。
      const conv = narrowToolFace('conversation', ALL_TOOLS);
      crit('M2', conv.kept.length > 0 && conv.kept.length < Object.keys(ALL_TOOLS).length
        && conv.removed.includes('write_file') && !conv.kept.includes('write_file') && !conv.kept.includes('execute_command'),
        '★ C3② 收窄**真发生**：`narrowToolFace(对话交互, 真 57 件)` 真删掉档外件（`write_file`/`execute_command` 出局）',
        `keep ${conv.kept.length} / remove ${conv.removed.length}（共 ${Object.keys(ALL_TOOLS).length}）`);
      // ②′ 两侧标本的**"该不命中"**：把已收窄的集合再收一次 ⇒ 无可删（不误报、不崩）。
      const again = narrowToolFace('conversation', Object.fromEntries(conv.kept.map((n) => [n, {}])));
      ok(again.removed.length === 0 && again.kept.length === conv.kept.length,
        `C3②′ 幂等标本：对**已收窄**的集合再收一次 ⇒ 无可删（removed ${again.removed.length}）`);
      // ③ C4 档外**如实告知**：**两只标本**直跑 `buildUnavailableNotice`——
      //    **该命中**：对话档叫 `write_file`（档外，见上 C3② 的标本说明）⇒ 文案须点名**形态标签**、
      //      **真名**、并给出**本档可用工具**；**该不命中**：叫 `read_file`（**在档内**）⇒ 不该产生告知。
      const notice = buildUnavailableNotice('conversation', 'write_file', conv.kept);
      const label = ADAPTIVE_STRATEGIES.conversation.label;
      const hitOk = notice.includes('write_file') && notice.includes(label) && notice.includes('read_file') && /不可用/.test(notice);
      crit('M2', hitOk,
        '★ C4 档外工具**如实告知**：文案点名**形态**、给出**真名**、并列出**本档可用工具**（不说"未知工具"）',
        hitOk ? `「${label}」+ 真名 + 本档工具齐备` : `实测文案：${notice.slice(0, 90)}`);
      const miss = buildUnavailableNotice('conversation', 'read_file', conv.kept);
      ok(miss === '',
        'C4′ 反向标本：叫**档内**工具（`read_file`）⇒ **不产生**"不可用"告知（否则就是满嘴"不可用"的狼来了）',
        miss === '' ? '空串 ✓' : `实测非空：${miss.slice(0, 60)}`);
      // ③′ 正向告知（开工即知）也须如实：**零收窄**的档不该列一长串工具名（那是噪音）；
      //    有收窄的档必须点出"只注入本档 N 个 + 其余 M 个不可用"。
      const briefNarrow = buildToolFaceBrief('conversation', label, conv.kept, conv.removed.length);
      const wide = narrowToolFace('code', ALL_TOOLS);
      const briefWide = buildToolFaceBrief('code', ADAPTIVE_STRATEGIES.code.label, wide.kept, wide.removed.length);
      ok(briefNarrow.includes(String(conv.kept.length)) && /不可用/.test(briefNarrow) && briefNarrow.includes('read_file')
        && !/不可用/.test(briefWide) && briefWide.length < briefNarrow.length,
        'C4″ 开工简报**分两态**：有收窄 ⇒ 列本档工具并说明档外不可用；零收窄 ⇒ 一句带过（不白花 token）',
        `收窄档 ${briefNarrow.length} 字 / 零收窄档 ${briefWide.length} 字`);
    }

    // ── M3 · C5–C8 成果收口三面 + 存量归位 ───────────────────────────────────
    //   注：原 C6 的"反向钉"已上移至【R】R-1/R-2（**行为**标本，比扫源码子串强）。
    {
      const ipl = strip(path.join(MAIN, 'ipc/project.ipc.ts'));
      const dlc = strip(path.join(MAIN, 'core/deliverable-lifecycle.ts'));
      const fbh = strip(path.join(MAIN, 'core/finalize-by-human.ts'));
      crit('M3', typeof finalizeTaskByHuman === 'function',
        'C5 收口清算已抽成**可直跑的纯函数** `finalizeTaskByHuman`（rr 喂夹具即可，不必起 Electron）');
      // ★ 符号级同源：GUI 路与引擎路到达**同一个** `promoteTaskFileDeliverables` 符号（不是各写一份等价逻辑）。
      //   ⚠ **M3 实施时就地订正（本文件第 3 次判据订正，留注记免得下轮重犯）**：原判据只扫
      //     `ipc/project.ipc.ts` 一个文件 —— 那是**按"实现把 promote 直接调在 IPC 里"这一假设**写的。
      //     实际实现把 GUI 路的收口**又收了一层**：IPC → `finalize-by-human.ts` → promote（更彻底的"一处真源"，
      //     且 IPC 里不再留任何第二份等价逻辑）。若照原判据，**越做越收敛反而判红**（"判据抓的是判据自己的形状"）。
      //     ⇒ 改为**顺着调用链判**：IPC 必须引 `finalize-by-human.js`，而该模块必须**从 `./deliverable-lifecycle.js`
      //     引同一个符号**并调用它（引对路径即"同一个符号"，非同名拷贝）。
      const guiToFbh = /finalize-by-human\.js/.test(ipl);
      const fbhToPromote = /from\s+'\.\/deliverable-lifecycle\.js'/.test(fbh) && /promoteTaskFileDeliverables\s*\(/.test(fbh);
      crit('M3', guiToFbh && fbhToPromote,
        '★ C5 符号级同源：GUI 路 → `finalize-by-human.ts` → **同一个** `promoteTaskFileDeliverables`（引对路径 + 真调用）',
        `IPC→fbh=${guiToFbh} fbh→promote=${fbhToPromote}`);
      // C7：人工收口后**账内与顶层同值**的不变式在 GUI 路也成立（`task-outcome.ts` 的方向①被调用）
      //   同 C5★ 的订正理由：顺链判（IPC → finalize-by-human → syncGoalAchievedFromAccount）。**行为**标本见下。
      const fbhToSync = /from\s+'\.\/task-outcome\.js'/.test(fbh) && /syncGoalAchievedFromAccount\s*\(/.test(fbh);
      crit('M3', fbhToSync,
        'C7 人工收口后**账内与顶层 `goal_achieved` 同值**的不变式在 GUI 路也成立（方向①被调用）');
      // C8：存量归位须有**一次性迁移标记**守护（幂等可证）——没有标记就是"每次启动都跑一遍"
      crit('M3', /migration\.doc_promote_human_completed/.test(
        strip(path.join(MAIN, 'database.ts')) + dlc + ipl),
        'C8 存量归位有**一次性迁移标记**守护（`migration.doc_promote_human_completed`），且可证幂等');

      // ── 面一【行为】标本：喂内存夹具**直跑真实现** `finalizeTaskByHuman` ──────────
      //   ⚠ 本仓纪律（`feedback_predicate_needs_both_sides_specimen`）：**该清**与**不该清**两只一起试——
      //     只用"该清"样本验证 ⇒ 一个"逢 ct x 就报 cleared:['pause_reason','pause_note']"的假实现全票通过。
      const mkDb3 = (): AnyDb => {
        const db = new DatabaseSync(':memory:') as unknown as AnyDb;
        db.exec(
          `CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT DEFAULT '{}');
           CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, name TEXT, file_path TEXT,
             type TEXT DEFAULT 'doc', status TEXT DEFAULT 'draft', updated_at TEXT, acceptance_verified INTEGER DEFAULT 0);`,
        );
        return db;
      };
      const runFinalize = (ctxObj: Record<string, unknown>, doc = true, audit?: { score: number; feedback?: string }) => {
        const db = mkDb3();
        db.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('T1', JSON.stringify(ctxObj));
        if (doc) db.prepare('INSERT INTO wa_deliverables (id, project_id, task_id, name, file_path, type, status) VALUES (?,?,?,?,?,?,?)')
          .run('D1', 'P', 'T1', 'r.md', '/w/report.md', 'doc', 'draft');
        const r = finalizeTaskByHuman(db as never, { taskId: 'T1', via: 'task:updateStatus', ...(audit ? { audit } : {}) });
        const after = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('T1') as { context_json: string }).context_json) as Record<string, unknown>;
        const drow = db.prepare('SELECT status FROM wa_deliverables WHERE id = ?').get('D1') as { status?: string } | undefined;
        (db as unknown as { close: () => void }).close();
        return { r, after, docStatus: drow?.status };
      };
      // **该清**：终态带着陈旧暂停因由 + 已有引擎账 + 一件 draft doc（即标本 `9788ce4f` 的形状）。
      const dirty = runFinalize({
        pause_reason: 'output_insufficient', pause_note: '多次未通过充分性校验',
        goal_achieved: false,
        completion_quality: { score: 45, goal_achieved: false, via: 'run_close', feedback: '引擎当日判卷' },
      });
      const keptFeedback = (dirty.after.completion_quality as { feedback?: string }).feedback;
      crit('M3',
        dirty.r.cleared.includes('pause_reason') && dirty.r.cleared.includes('pause_note')
        && dirty.r.account === 'relabelled'
        && dirty.r.score === 45 && dirty.r.goalAchieved === false
        && (dirty.after.completion_quality as { via?: string }).via === 'task:updateStatus'
        && keptFeedback === '引擎当日判卷'
        && !('pause_reason' in dirty.after) && !('pause_note' in dirty.after)
        && dirty.docStatus === 'completed' && dirty.r.promoted === 1,
        '★ 面一 **该清**标本：陈旧 `pause_reason`/`pause_note` 被清 · 判卷结论（45 分/false/feedback）**逐字保留** · `via` 换成人工路 · doc 随之落定',
        `cleared=[${dirty.r.cleared}] account=${dirty.r.account} score=${dirty.r.score} goal=${dirty.r.goalAchieved} via=${(dirty.after.completion_quality as { via?: string }).via} doc=${dirty.docStatus}`);
      // **不该清**：干净上下文 + 无账 + 无审计 ⇒ `cleared` 必须**为空**（不得谎报"清了 2 个"），账如实 `'none'`。
      const clean = runFinalize({});
      crit('M3', clean.r.cleared.length === 0 && clean.r.account === 'none' && clean.r.score === null,
        '★ 面一 **不该清**标本：无陈旧键 ⇒ `cleared` 为**空数组**（不谎报）· 无账无审计 ⇒ `account:\'none\'`、分 `null`（不编分）',
        `cleared=[${clean.r.cleared}] account=${clean.r.account} score=${clean.r.score}`);
      // **该造**：无账但调用方注入审计结论 ⇒ 经**同一构造器**造一笔，且顶层与账内同值（C7 不变式）。
      const fresh = runFinalize({}, true, { score: 72, feedback: '人工收口审计' });
      crit('M3', fresh.r.account === 'fresh' && fresh.r.score === 72 && fresh.r.goalAchieved === true
        && fresh.after.goal_achieved === true
        && (fresh.after.completion_quality as { goal_achieved?: boolean }).goal_achieved === true,
        'C7 无账 + 注入审计 ⇒ 造一笔（`\'fresh\'`）且**顶层与账内同值**（72 分 ≥60 ⇒ 两侧皆 true）',
        `account=${fresh.r.account} 顶层=${fresh.after.goal_achieved} 账内=${(fresh.after.completion_quality as { goal_achieved?: boolean }).goal_achieved}`);
      // **不变式在自相矛盾的输入上成立**（`5126b303` 的形状：账说未达成、顶层说已达成）⇒ 顶层被同步为账内值。
      const contrad = runFinalize({
        goal_achieved: true,
        completion_quality: { score: 95, goal_achieved: false, via: 'run_close' },
      });
      crit('M3', contrad.after.goal_achieved === false && contrad.r.goalAchieved === false,
        '★ C7 **不自相矛盾**：喂「顶层 true / 账内 false」的矛盾上下文 ⇒ 收口后顶层被同步为账内 false（方向①真在跑，不是靠巧合同值）',
        `顶层=${contrad.after.goal_achieved}`);
      // **重复点「标记完成」不该改账**：`via` 已是人工路 ⇒ 如实 `'kept'`（"账没被重写"可观测）。
      const twice = runFinalize({
        completion_quality: { score: 60, goal_achieved: true, via: 'task:updateStatus' },
      });
      crit('M3', twice.r.account === 'kept',
        'C5 幂等：`via` 已是人工路 ⇒ `account:\'kept\'`（重复点「标记完成」不重写账）',
        `account=${twice.r.account}`);

      // ── 面二【行为】标本：`output_insufficient` 落账 ⇒ 读作 `not_checked`（**不压分**）───
      //   与「真失败仍读作 failed」**成对**：新码最危险的失法是**把真失败一并洗白**（`not_checked` 不触发压降）。
      const db2 = mkDb3();
      db2.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('T2', '{}');
      recordAcceptanceOutcome(db2 as never, 'T2', { outcome: { ran: false, reason: 'output_insufficient' }, checks: [] });
      const ac2 = JSON.parse((db2.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('T2') as { context_json: string }).context_json).acceptance_check as { reason?: string; verified?: boolean };
      (db2 as unknown as { close: () => void }).close();
      const vInsuff = acceptanceVerdictOf(ac2);
      // 对照组：**真空载荷**（`buildAcceptanceCheckPayload` 是唯一构造处，不用手写 JSON —— 承"生产入参"纪律）
      const acFail = buildAcceptanceCheckPayload([{ criterion: 'A', passed: true }, { criterion: 'B', passed: false, reason: 'x' }]);
      const vFail = acceptanceVerdictOf(acFail);
      crit('M3', vInsuff === 'not_checked' && ac2.reason === 'output_insufficient'
        && capScoreByAcceptanceVerdict(90, vInsuff) === 90
        && vFail === 'failed' && capScoreByAcceptanceVerdict(90, vFail) === 45,
        '★ 面二 **两只标本**：`output_insufficient` ⇒ `not_checked`（90 分**不压降**）· 真空载荷 ⇒ **仍** `failed`（90→45，新码没把真失败洗白）',
        `不充分=${vInsuff}(cap ${capScoreByAcceptanceVerdict(90, vInsuff)}) 真失败=${vFail}(cap ${capScoreByAcceptanceVerdict(90, vFail)})`);
      // 新码**确是新的**：不得是既有五码的误写（标签在场且与五码互异）
      const labels = Object.values(UNVERIFIED_REASON_LABEL);
      crit('M3', typeof UNVERIFIED_REASON_LABEL.output_insufficient === 'string'
        && UNVERIFIED_REASON_LABEL.output_insufficient.length > 0
        && labels.filter((s) => s === UNVERIFIED_REASON_LABEL.output_insufficient).length === 1,
        'C6 成因码 `output_insufficient` 的**人可读标签**在场且不与既有五码重名（`Record<…>` 漏加即编译错，非靠人记得）',
        `${UNVERIFIED_REASON_LABEL.output_insufficient}`);

      // ── C8 自证（只读真库）：**两态可判**，两态都由合法数据满足 ─────────────────
      //   ⚠ **就地订正（M3 实施时）**：原判据是 `ok(nProd >= 1)`——它断言"真库里确有存量待归位"，
      //     而归位一旦执行成功**此断言必然翻红**，可"执行成功"恰恰是本条的目的。这正是本仓反复治的
      //     哑雷（`feedback_assertion_no_forward_literals`：只为某一阶段为真的断言）。
      //     ⇒ 改为**两态**：标记**不在册** ⇒ 分母 **≥1**（科目非空，非纸上作业）；标记**在册** ⇒ 分母 **==0**
      //       （归位已执行**且执行彻底**）。两态都在真判事，且都不靠"程序恰好停在哪一步"。
      //   ⚠ 范围 SQL 与 `promoteTaskFileDeliverables` 的**可达集**对齐：它见 `deliverable_unfulfilled.forced === true`
      //     即跳过 ⇒ 这里也把这批排除（否则一条被 `forced` 红线挡住的存量会让判据**永久红**——那是假红）。
      //   ⚠ zx_20260930 M3-f **就地订正**：范围由 `d.type = 'doc'` 换成生产的**集合真源**
      //     `typeIn('', FILE_DELIVERABLE_TYPES)`（doc ∪ code）。旧写法在 M3-f 之后已**比生产窄**——
      //     生产的可达集含 `code`，本条却只数 `doc`，于是"归位彻底"这句话对它自己的范围都不成立。
      //   ⚠ 另一处订正：`在册 ⇒ 清零` 这条**孤零零的等零**在真库上本就为假（实测残留 1 件：
      //     `…/.probe_retired_20260918/tickflow-stock-panel/data/backend.log`——**手工造的隔离目录**里的一枚残留日志，
      //     M3-g 修好 `_` 通配符之误后它才**新进入**可达集；"隔离目录里的日志算不算成果"是**产品判断**，
      //     本轮已裁定 **doc 行一律不碰**）。故改为**两维**：`code` 残留必须为 **0**（本轮归属的正是它），
      //     且全部残留都属「隔离目录遗留」那一类（有一条**正常**文件型成果卡 draft 即红）。
      {
        const dbPath = path.join(root, 'data/worker-ant-server.db');
        let prod: Array<{ type: string; name: string; file_path: string | null }> = [];
        let nRaw = -1;
        let marker = false;
        let opened = false;
        try {
          const db = new DatabaseSync(dbPath, { readOnly: true }) as unknown as AnyDb;
          marker = !!db.prepare("SELECT 1 FROM wa_settings WHERE key = 'migration.doc_promote_human_completed'").get();
          const ft = typeIn('', FILE_DELIVERABLE_TYPES);
          prod = db.prepare(
            `SELECT d.type, d.name, d.file_path FROM wa_deliverables d JOIN wa_tasks t ON t.id = d.task_id
              WHERE d.status = 'draft' AND t.status = 'completed' AND ${ft.sql} AND ${docNotProbe('d')}
                AND json_extract(COALESCE(t.context_json, '{}'), '$.deliverable_unfulfilled.forced') IS NOT 1`,
          ).all(...ft.params) as Array<{ type: string; name: string; file_path: string | null }>;
          nRaw = (db.prepare(
            `SELECT COUNT(*) AS c FROM wa_deliverables d JOIN wa_tasks t ON t.id = d.task_id
              WHERE d.type IN ('doc', 'code') AND d.status = 'draft' AND t.status = 'completed'`,
          ).get() as { c: number }).c;
          (db as unknown as { close: () => void }).close();
          opened = true;
        } catch (e) { void e; }
        const codeResidual = prod.filter((r) => r.type === 'code');
        const quarantined = prod.filter((r) => /\/\.probe_retired_/.test(String(r.file_path ?? '')));
        crit('M3', opened && (marker
          ? codeResidual.length === 0 && prod.length === quarantined.length
          : prod.length >= 1),
          marker
            ? '★ C8 自证（只读真库 · 迁移标记**在册**）：可达集内 **`code` 残留 == 0**，且余下残留**全是**「隔离目录遗留」（本轮裁定不碰的 doc 标本）'
            : '★ C8 自证（只读真库 · 迁移标记**不在册**）：**确有**"父任务已 completed 而自身仍 draft"的存量 ⇒ 归位科目非空',
          !opened ? '真库只读打开失败（**未证**，不得读作通过）'
            : `标记${marker ? '在册' : '不在册'} · 可达残留 ${prod.length} 件（code ${codeResidual.length} / 隔离目录 ${quarantined.length}）；含探针/含 forced 则 ${nRaw} 件`
              + (prod.length ? ` —— ${prod.map((r) => `[${r.type}] ${r.name}`).join(' / ')}` : ''));
      }
    }

    // ── M4 · C9/C10 模型能力匹配 ─────────────────────────────────────────────
    //   判据落在 **`modelReq` 那个对象字面量本体**上（按符号切块），而不是"文件里有没有某个名字"——
    //   ⚠ **M0 复核时改准过**：第一版 C9 写成 `… || !/capabilities:\s*\['chat','function-calling'\]/.test(exe)`，
    //     那个 `||` 使得**只要把那一行删掉**就判绿（"删掉"不等于"改成派生"）。
    //     现在要求：值**仍在**（删不得）+ **不再是数组字面量**（真派生）。
    //   ⚠ **M9-fix 第 2 次形状订正**：F1 把请求体改为经 `buildModelRequest` 构造后，`const modelReq` 之后
    //     的**第一个 `{`** 变成了**调用实参**块，`capabilities:` 不再出现在该块里 ⇒ 判据取空 → 红。
    //     红得**对**（形状确实变了），但处置须遵本轮 §M8 定的规矩：**回退的只能是判据的形状假设，
    //     不能是本轮的源码**。⇒ 两种形状都认，且各自钉住"值是派生的"：
    //       ① 内联字面量：`capabilities:` 的值**仍在**且**不再是数组字面量**；
    //       ② 经 `buildModelRequest`：调用**在场**（§F-F1 钉），值由函数内 `deriveModelCapabilities` 给
    //          （派生行为另由下方 M4 行为标本直接跑真函数验证）。
    {
      //   ⚠ **M8 第 3 次（扫描面）订正**：M8 把这整段搬进 `core/exec-model-select.ts`，本脚本只扫执行体
      //     ⇒ 切出**空块**、报成"能力值被删了"——读起来像真回归，实为扫描面没跟着走。
      //     按 M8 纪律（§M8-4「rr 扫描面须放宽」）取**执行体 ∪ `core/exec-*.ts`**；下条自证改为
      //     **同时报出扫了几个文件**，防"扫描面本身空了"这种更隐蔽的假绿。
      const exe = execSurface();
      const mi = exe.indexOf('const modelReq');
      const mblk = braceBlock(exe, mi);
      ok(mblk.length > 40, `★ C9 自证：\`const modelReq\` 构造处切到（块长 ${mblk.length}）`,
        `扫描面=${execSurfaceFiles.length} 文件：${execSurfaceBase()}`);
      const viaBuilder = /const\s+modelReq[^;]*=\s*buildModelRequest\s*\(/.test(exe);
      const capVal = /capabilities:\s*(\[[^\]]{0,200}\]|[A-Za-z_$][\w.$]*)/.exec(mblk)?.[1] ?? '';
      crit('M4', viaBuilder || (capVal.length > 0 && !capVal.startsWith('[')),
        '★ C9 请求体的能力值**仍在场**且**是派生的**（内联 `capabilities: <标识符>` 或经 `buildModelRequest` 两形状之一；**删掉 / 退回数组字面量都不算数**）',
        viaBuilder ? '经 `buildModelRequest` 构造（值由函数内 `deriveModelCapabilities` 派生；调用在场由 §F-F1 钉）'
          : (capVal ? `内联现值：${capVal.replace(/\s+/g, ' ').slice(0, 70)}` : '未取到 capabilities 值（可能被整体删掉了）'));
      //     反向：**不得**退回硬编码数组（两个形状都不许）
      const litNear = exe.slice(Math.max(0, mi), Math.max(0, mi) + 600);
      crit('M4', !/capabilities:\s*\[/.test(litNear),
        '★ C9 反向：请求构造处 600 字内**不得**出现 `capabilities: [` 数组字面量（退回硬编码即红）');
      // C10：`maxCostPer1k` 要**接进 modelReq 那条请求**（在 `const modelReq` 之后 3000 字内），
      //   而不是"全仓出现过一次"。⚠ 诚实登记：**"未配置时该键不出现"这一半本判据证不了**——
      //   它要在 M4 落地后按**当时的真实写法**补一只行为标本（喂空配置 / 喂带价配置两只），
      //   已登记方案 §5 挂账；此处只钉"接线到场"。
      const mnear = exe.slice(Math.max(0, mi), Math.max(0, mi) + 3000);
      const costWired = /maxCostPer1k/.test(mnear);
      crit('M4', costWired,
        'C10 `maxCostPer1k` **接进 modelReq 请求构造处**（此前全仓**零处**传入）',
        costWired ? '见接线' : '未接线（边界如实：未配置时不出现这一半待 M4 行为标本补）');
    }

    // ── M4 行为标本（直跑真实现）：C9 分档口径 + C10 的"键不在场"那一半 ──────────
    //   上面两条是**源码级**判据（切块 + 正则）——它们证不了"未配置时键不出现"，因为
    //   "不出现"在源码里恰恰表现为**没有那一行**，扫源码只会把"没写"读成"没实现"。
    {
      // ① C9 的三档口径：**该命中**与**该不命中**都要有，否则"一律加上"的过宽实现也全票通过。
      const codeCaps = deriveModelCapabilities('code');
      const researchCaps = deriveModelCapabilities('research');
      const docCaps = deriveModelCapabilities('document');
      const convCaps = deriveModelCapabilities('conversation');
      const baseOk = ARCHETYPES.every(a => {
        const c = deriveModelCapabilities(a);
        return c.includes('chat') && c.includes('function-calling');
      });
      crit('M4', baseOk, '★ C9 底线能力：六档**恒含** `chat` + `function-calling`（扩展的是附加，不是替换）');
      crit('M4', codeCaps.includes('code') && !codeCaps.includes('reasoning'),
        '★ C9 `code` 档 ⇒ 含 `code`、**不含** `reasoning`（该命中 + 该不命中两只同验）', `[${codeCaps.join(', ')}]`);
      crit('M4', researchCaps.includes('reasoning'),
        '★ C9 `research` 档 ⇒ 含 `reasoning`', `[${researchCaps.join(', ')}]`);
      crit('M4', !docCaps.includes('code') && !convCaps.includes('code'),
        '★ C9 `document`/`conversation` 档 ⇒ **不含** `code`（"一律加上 code"的过宽实现会被这两只判红）',
        `doc=[${docCaps.join(', ')}] conv=[${convCaps.join(', ')}]`);
      // ② 媒体槽位（M5 填）：有 ⇒ `+vision`；无 ⇒ 无 vision。同样两只。
      const withMedia = deriveModelCapabilities('document', { hasMedia: true });
      const noMedia = deriveModelCapabilities('document', { hasMedia: false });
      crit('M4', withMedia.includes('vision') && !noMedia.includes('vision'),
        '★ C9 媒体槽位两态：`hasMedia` 真 ⇒ 含 `vision`；假 ⇒ 不含（槽位名 `context_json.attachments`，M5 填）',
        `有=[${withMedia.join(', ')}] 无=[${noMedia.join(', ')}]`);
      // ③ C10 **键在场/不在场**（源码扫不出的那一半，只能跑行为）
      const reqNone = buildModelRequest({ archetype: 'code', strategy: 'balanced' });
      const reqSome = buildModelRequest({ archetype: 'code', strategy: 'balanced', maxCostPer1k: 0.02 });
      crit('M4', !('maxCostPer1k' in reqNone),
        '★ C10 未配置 ⇒ `maxCostPer1k` **该键根本不出现**（"没这笔账"≠"账上是 0"）',
        `键集 [${Object.keys(reqNone).join(', ')}]`);
      crit('M4', reqSome.maxCostPer1k === 0.02,
        '★ C10 配置了 ⇒ 等于配置值', `现值 ${String(reqSome.maxCostPer1k)}`);
      // ④ 取数侧：脏值不得被静默读成 0（0 在 ANS 侧是"只要免费模型"的**合法上限**）
      const fake = (value: string | undefined) => readMaxCostPer1k({
        prepare: () => ({ get: () => (value === undefined ? undefined : { value }) }),
      });
      crit('M4', fake('0.02') === 0.02, '★ C10 取数：`0.02` ⇒ 0.02', String(fake('0.02')));
      crit('M4', fake('0') === undefined && fake('abc') === undefined && fake('') === undefined && fake(undefined) === undefined,
        '★ C10 取数：`0`/脏值/空串/缺行 一律按**未配置**（不得读成 0 把整池付费模型筛没）',
        `0→${String(fake('0'))} abc→${String(fake('abc'))} 空→${String(fake(''))} 缺→${String(fake(undefined))}`);
      crit('M4', MAX_COST_PER_1K_KEY === 'engine.model_max_cost_per1k',
        '★ C10 键名与方案一致（`engine.model_max_cost_per1k`）', MAX_COST_PER_1K_KEY);
      // ⑤ C9 的"该命中"侧：每档派生能力在**真 ANS 库**里至少被一个模型支持（要了有人给）
      try {
        const db2 = new DatabaseSync(path.join(root, 'data/ans-server.db'), { readOnly: true }) as unknown as AnyDb;
        const rows2 = db2.prepare('SELECT capabilities FROM ans_ai_models').all() as Array<{ capabilities?: string | null }>;
        const parsed = rows2.map(r => { try { const a = JSON.parse(String(r.capabilities || '[]')) as unknown; return Array.isArray(a) ? a.map(String) : []; } catch { return []; } });
        (db2 as unknown as { close: () => void }).close();
        const variants: Array<[string, TaskArchetype, boolean]> = ARCHETYPES.map(a => [a, a, false]).concat([['document+媒体', 'document', true]]);
        const misses: string[] = [];
        const detail: string[] = [];
        for (const [label, a, media] of variants) {
          const caps = deriveModelCapabilities(a, { hasMedia: media });
          const n = parsed.filter(m => caps.every(c => m.includes(c))).length;
          detail.push(`${label} ${n}`);
          // ⚠ 如实：`document` 与 `configuration` 派生的能力**与原文案逐字相同** ⇒ 它们的命中数
          //   不能算作本轮的收益，只作"没要错"的对照；收益在 `code`/`research`/`analysis` 三档与媒体档。
          if (n === 0) misses.push(`${label}(${caps.join('+')})`);
        }
        crit('M4', misses.length === 0,
          '★ C9 该命中侧：六档（+媒体档）派生能力**在真 ANS 库里各有 ≥1 个模型支持**（要了有人给）',
          `各档命中 ${detail.join(' / ')}${misses.length ? ` · 无人给：${misses.join('、')}` : ''}`);
      } catch (e) {
        crit('M4', false, '★ C9 该命中侧：ANS 库只读打开失败（**未证**，不得读作通过）', String((e as Error).message).slice(0, 120));
      }
    }

    // ── M5 · C11/C12 IM 入站媒体落盘（C12 反向已上移【R】R-3）─────────────────
    //
    // ⚠ **M0 复核时否掉的第一版（留此注记，免得下轮重犯）**：第一版 C11 断言的是
    //   "`im-router.ts` 里出现 `file_name` / `size_bytes` 字样"。但那两处**今天就已经在场**
    //   （`message_json` 的 JSON 里 `...(meta?.fileName ? { file_name: … } : {})`）——
    //   于是 C11 在 M5 还没做时**就会"提前为真"**。这正是本轮病根 D4 那句
    //   **"列在而路不填"**的病：判据落在**消费者看得见"键"的地方**，而病在**生产者根本不产这个键**。
    //   ⇒ 判据必须落在**生产者契约**（元数据里有没有"去哪儿取件"这一项）与
    //     **落盘行为**（文件真到盘上、回执文案含真件名）两处。
    {
      const wxaRaw = raw(path.join(MAIN, 'services/wechat-adapter.ts'));
      const imr = strip(path.join(MAIN, 'services/im-router.ts'));
      const adp = strip(path.join(MAIN, 'services/im-adapter.ts'));
      // ① 生产者契约：**元数据要带得动一件媒体** —— `ImMessageMeta` 须新增**媒体 URL** 字段。
      //   ⚠ **M0 复核时否掉的第二版**：第一版写 `/mediaUrl|downloadUrl|url:/i.test(wxa) && /fetch|download/i.test(wxa)`，
      //     实测**今天就为真**（适配器本来就有 `url:` 字段和 `fetch` 做 apiPost）⇒ 又一次假绿。
      //     真判据落在**契约的形状**上：今天 `ImMessageMeta` **只有 kind/fileName/sizeBytes/messageId**，
      //     没有"去哪儿取件"这一项——没有它，下游无论如何都拿不到字节。
      const metaBlk = braceBlock(adp, adp.indexOf('interface ImMessageMeta'));
      const metaHasUrl = /\b(url|mediaUrl|fileUrl)\??\s*:/.test(metaBlk);
      ok(metaBlk.length > 100, `★ C11① 自证：\`ImMessageMeta\` 契约块切到（块长 ${metaBlk.length}）`);
      crit('M5', metaHasUrl,
        '★ C11① 生产者契约：`ImMessageMeta` 新增**媒体 URL** 字段（今天只有 kind/fileName/sizeBytes/messageId）',
        metaHasUrl ? '已有 URL 字段' : '契约里无处取件');
      // ② 落盘：媒体真正写到 `data/attachments/` —— 判据是"**目录名 + 真写字节**在同一份里出现"，
      //   而不是"某个文件提到过 attachments 这个词"（`qqbot-adapter` 就提到过，那是平台的字段名，不落盘）。
      const landed: string[] = [];
      for (const f of walkTs(MAIN)) {
        const s = strip(f);
        if (/attachments/.test(s) && /writeFile|createWriteStream/.test(s)) landed.push(path.relative(MAIN, f));
      }
      crit('M5', landed.length > 0,
        '★ C11② 入站媒体**真落到** `data/attachments/`（**目录名与真写字节同处一份** —— 只说"attachments"不算）',
        landed.length ? landed.join(', ') : '零处（今天只有 qqbot 提到平台字段 `attachments`，不写盘）');
      crit('M5', /attachments/.test(raw(path.join(root, 'CLAUDE.md'))),
        '★ C11② `data/attachments/` 已**登记进 CLAUDE.md**（跨端契约，同 `NOTIFICATION_PAYLOAD_DIR` 待遇）');
      // ③ 消费侧：入站行的 file_name/size_bytes **来自生产者**（而非常量）——
      //    判据取 `meta.fileName` 这个**上游字段**确实被生产者填过（`nonTextPlaceholder` 之外另有落盘后的真值）
      const consumed = /fileName/.test(imr) && /sizeBytes/.test(imr);
      ok(consumed,
        '★ C11③ 消费侧自证：`im-router` 仍按 `meta.fileName`/`meta.sizeBytes` 写行（**今天即真**，故不计入批次门）');
      // ④ M-C：判在**用户可见串**——回执文案须含**真件名与字节数**（renderer/IM 侧词表，非标识符）
      crit('M5', /receivedMedia|mediaReceipt|已收到.*(图|文件|件)|落盘/.test(imr + wxaRaw),
        '★ C11④ 回执：非文本入站**如实回话**且文案含**真件名/字节数**（M-C：判在用户可见串）');

      // ── 行为标本：**真写一遍**（源码级判据证不了"文件真到了盘上"）───────────────────────
      //   盘用一次性临时目录（**不碰 `data/`**：本脚本只读真库，更不该往生产数据目录写测试件）。
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-m5-media-'));
      const day = new Date('2026-09-20T03:04:05Z');   // UTC ⇒ 目录名 20260920
      const rootAbs = path.resolve(attachmentsRoot(tmp)) + path.sep;
      const inside = (p: string): boolean => path.resolve(p).startsWith(rootAbs);
      const body = Buffer.from('hello-媒体-0123456789', 'utf-8');
      const img = { kind: 'image', mediaUrl: 'https://ilinkai.weixin.qq.com/media/abc.JPG', fileName: '报告 v2.JPG', sizeBytes: body.length };
      try {
        // ① 该命中侧：真落一件
        const r1 = saveInboundMedia(tmp, img, body, day);
        const p1 = r1.ok ? r1.path : '';
        crit('M5', r1.ok && p1.startsWith(path.join(attachmentsRoot(tmp), '20260920') + path.sep) && fs.existsSync(p1),
          '★ M5 标本① 该命中：落盘成功 ⇒ 文件**真在盘上**、且在 `attachments/<UTC 日期>/` 之下',
          r1.ok ? path.relative(tmp, r1.path) : r1.error);
        crit('M5', r1.ok && r1.bytes === body.length && fs.readFileSync(p1).equals(body),
          '★ M5 标本① 字节数相符且内容逐字节一致（不是"建了个空文件"）',
          r1.ok ? `${r1.bytes}B / 期望 ${body.length}B` : '未落盘');
        crit('M5', r1.ok && r1.fileName === '报告 v2.JPG',
          '★ M5 标本① 件名**保留原样**：中文/空格/扩展名不被洗掉（`.` 与空格不在非法集内）',
          r1.ok ? r1.fileName : '未落盘');
        // ② 该不命中侧：路径穿越 / 空名 / 纯点名 / 同名二次
        const trav = saveInboundMedia(tmp, { kind: 'file', fileName: '../../etc/passwd' }, Buffer.from('x'), day);
        crit('M5', trav.ok && inside(trav.path) && path.basename(trav.path) === 'passwd',
          '★ M5 标本② 该不命中：`../../etc/passwd` ⇒ 只取 basename（`passwd`），**落点仍在 `attachments/` 之内**',
          trav.ok ? path.relative(tmp, trav.path) : trav.error);
        const noName = saveInboundMedia(tmp, { kind: 'file', mediaUrl: 'https://x/a.pdf' }, Buffer.from('z'), day);
        crit('M5', noName.ok && inside(noName.path) && /^im-\d+-[a-z0-9]{6}\.pdf$/.test(path.basename(noName.path)),
          '★ M5 标本② 空件名 ⇒ 退到 `im-<时间戳>-<6位随机>.pdf`（扩展名按 URL 后缀推），不出 `attachments/`',
          noName.ok ? path.basename(noName.path) : noName.error);
        const dotDot = saveInboundMedia(tmp, { kind: 'image', fileName: '..' }, Buffer.from('xy'), day);
        crit('M5', dotDot.ok && inside(dotDot.path) && /^im-\d+-[a-z0-9]{6}\.jpg$/.test(path.basename(dotDot.path)),
          '★ M5 标本② 纯点名 `..` ⇒ 退到随机名（`extOf` 按 kind 推 `.jpg`），不出 `attachments/`',
          dotDot.ok ? path.basename(dotDot.path) : dotDot.error);
        const r2 = saveInboundMedia(tmp, img, Buffer.from('second'), day);
        crit('M5', r1.ok && r2.ok && r1.path !== r2.path && fs.existsSync(r1.path) && fs.existsSync(r2.path) && r2.fileName === '报告 v2-2.JPG',
          '★ M5 标本② 同名**不覆盖**：第二件落成 `报告 v2-2.JPG`，**两件都在盘上**（同一时刻两张同名图不得互相盖掉）',
          r2.ok ? r2.fileName : r2.error);
        // ③ 取件识别（文本 item 跳过 / 从 `*_item` 体里认出 URL·件名·大小）
        // ⚠ 此处 `kind === '4'`（数字）**不是**"判据替实现背书"，而是上一轮的契约裁定
        //   （"未知类型原样带出、不猜名字"，`rr_zx_20260914_2` 三处钉死）。M9 复核一度改成
        //   `'image'`，被那份旧判据**正确地**判红 ⇒ 已回退；边界与理由见方案 §6.6/§5 挂账。
        const got = mediaFromIlinkItems([{ type: 1, text_item: { text: 'hi' } }, { type: 4, image_item: { url: 'https://x/y.png', file_name: 'y.png', size: 12 } }]);
        crit('M5', got?.kind === '4' && got.mediaUrl === 'https://x/y.png' && got.fileName === 'y.png' && got.sizeBytes === 12,
          '★ M5 取件：跳过文本 item，从 `image_item` 里认出 kind/url/件名/大小（kind 取平台原始 `type`，**不猜名字**——上一轮契约）', JSON.stringify(got));
        crit('M5', mediaFromIlinkItems([{ type: 1, text_item: { text: 'hi' } }]) === undefined,
          '★ M5 取件该不命中：**纯文本 ⇒ 无媒体**（不把正文当件）');
        // ④ 回执两态（**两只都试**——只试成功支，"一律说已落盘"的谎报实现会全票通过）
        const okTxt = mediaReceiptText({ kind: 'image', fileName: '报告 v2.JPG', sizeBytes: body.length, savedPath: r1.ok ? r1.path : '' });
        crit('M5', okTxt.includes('报告 v2.JPG') && okTxt.includes('已落盘') && okTxt.includes('attachments/20260920/') && !okTxt.includes('没能落盘'),
          '★ M5 回执① 成功支：含**真件名** + "已落盘" + `attachments/<日期>/` 相对路径（且**不说**"没能落盘"）', okTxt);
        const badTxt = mediaReceiptText({ kind: 'image', fileName: '报告 v2.JPG', sizeBytes: body.length, error: '取件 HTTP 403' });
        crit('M5', badTxt.includes('报告 v2.JPG') && badTxt.includes('没能落盘') && badTxt.includes('取件 HTTP 403'),
          '★ M5 回执② 失败支：含**真件名** + "**没能落盘**" + **真因**（把"我丢了"说成"我收了"是本轮要治的那类谎报）', badTxt);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    // ── M6 · C13/C14 IM 任务级问答（C14 反向已上移【R】R-4）───────────────────
    {
      const imr = strip(path.join(MAIN, 'services/im-router.ts'));
      const i = imr.indexOf('function handleSystemQuery');
      const blk = braceBlock(imr, i);
      const nCount = (blk.match(/COUNT\(\*\)/g) || []).length;
      crit('M6', cfgQueryDeep(blk),
        'C13 `handleSystemQuery` **下钻到任务层**（`SELECT … title … FROM wa_tasks` + `.all()` 取真行），不再只有六条 `COUNT(*)`',
        i < 0 ? '找不到 `function handleSystemQuery`' : `块长 ${blk.length} / COUNT(*) ${nCount} 处 / 取真行 ${/\.all\(/.test(blk)}`);

      // C18 的源码面：本文件里 `wa_tasks.updated_at` 的**裸读**（未套 `datetime(...)`）必须为 0。
      //   ⚠ 判据自身也要不被自己误伤：赋值侧（`updated_at = datetime('now')`）、
      //     `wa_memories` 那列（实测 774 行全 SQL，不混）与注释里的提及都不计入。
      const tsBare = imr.split('\n')
        .filter(t => /updated_at/.test(t))
        .filter(t => !/datetime\(\s*\w*\.?updated_at\s*\)/.test(t))
        .filter(t => !/updated_at\s*=\s*datetime\('now'\)/.test(t))
        .filter(t => !/wa_memories/.test(t))
        .filter(t => !/^\s*(\/\/|\*|\/\*)/.test(t));

      // ── C13 **行为标本**：这句"回复里有没有那两条真标题"源码扫不出来，只能真问一遍 ──
      // ⚠ 三只标本一起试（该命中 / 该不命中 / 空态）——只试"有任务时列得出"的话，
      //   一个"把 COUNT 抄进正文"或"一律把最近 5 条全列（不分终态）"的实现会全票通过。
      const lineOf = (r: string, p: RegExp): string[] => r.split('\n').filter(t => p.test(t));

      // ① 该命中：1 运行中 + 1 已暂停（各带一条执行记录）+ 1 已完成
      const db = mkQueryDb();
      db.prepare("INSERT INTO wa_projects (id, name, status) VALUES ('P','演示项目','active')").run();
      seedTask(db, 'T-run', '整理九月会议纪要', 'executing', '2026-09-20 03:00:00');
      seedTask(db, 'T-pause', '转录客户访谈录音', 'paused', '2026-09-20 02:00:00');
      seedTask(db, 'T-done', '归档旧报表', 'completed', '2026-09-19 08:00:00');
      db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, created_at) VALUES ('C1','T-run','assistant','[工具调用] read_file({\"path\":\"a.md\"})','2026-09-20 03:05:00')").run();
      const r1 = (await routeOnce(db, 'u-m6-hit'))[0] ?? '';
      const bullets = lineOf(r1, /^· /);
      crit('M6', bullets.length === 2,
        '★ C13 标本① `进行中` 段**恰两条**（已完成的「归档旧报表」**不进**这一集——谓词 `NOT IN (completed,failed,archived)` 在真的筛）',
        `${bullets.length} 条：${bullets.join(' ｜ ').slice(0, 120)}`);
      crit('M6', /^· 「整理九月会议纪要」 \[执行中\]/.test(bullets[0] ?? '') && /^· 「转录客户访谈录音」 \[已暂停\]/.test(bullets[1] ?? ''),
        '★ C13 标本① 两条**真标题 + 各自状态词**（「执行中」/「已暂停」），且按 `updated_at` 倒序（近的在前）',
        bullets.slice(0, 2).join(' ｜ ').slice(0, 140));
      crit('M6', /read_file/.test(bullets[0] ?? '') && !/\[工具调用\]/.test(bullets[0] ?? ''),
        '★ C13 标本① 「最近一步」取该任务**最后一条执行记录**（`wa_task_conversations`）并去掉 `[标签] ` 前缀',
        bullets[0] ?? '（无）');
      crit('M6', /最近一条终态: 「归档旧报表」 \[已完成\]/.test(r1) && /UTC/.test(r1),
        '★ C13 标本① 终态最近一条**另一段**给出（真标题 + 状态词 + 时刻），且时刻**标 UTC**（本仓 DB 时刻是 UTC，不冒充本地）',
        lineOf(r1, /最近一条终态/)[0] ?? '（无）');

      // ② 该不命中：N=5 是**真的**在限——7 条未终态只列 5 条
      const dbMany = mkQueryDb();
      dbMany.prepare("INSERT INTO wa_projects (id, name, status) VALUES ('P','演示项目','active')").run();
      for (let k = 1; k <= 7; k++) seedTask(dbMany, `T${k}`, `任务${k}`, 'pending', `2026-09-20 ${String(k).padStart(2, '0')}:00:00`);
      const rMany = (await routeOnce(dbMany, 'u-m6-limit'))[0] ?? '';
      crit('M6', lineOf(rMany, /^· /).length === 5,
        '★ C13 标本② **下钻有条数上界**（7 条未终态 ⇒ 只列 5 条）——否则一次问询把整个任务表灌进 IM',
        `${lineOf(rMany, /^· /).length} 条`);

      // ③ 空态：如实说"暂无"，且不编标题
      const dbEmpty = mkQueryDb();
      const rEmpty = (await routeOnce(dbEmpty, 'u-m6-empty'))[0] ?? '';
      crit('M6', /暂无/.test(rEmpty) && lineOf(rEmpty, /^· /).length === 0 && !/最近一条终态/.test(rEmpty),
        '★ C13 标本③ **空态如实**：无任务时说「暂无」，不列任何 `· 「标题」`，也不编一段"最近一条终态"',
        rEmpty.replace(/\n/g, ' ⏎ ').slice(0, 120));

      // ④ 时刻列**两格式混存**下的排序（M6-b）：`wa_tasks.updated_at` 真库里 ISO/SQL 并存
      //    （来源两条写入路径：`event-store` 的 `toISOString()` 经 projector 落库 vs 40+ 处 `datetime('now')`）。
      //    裸比较下**同一 UTC 日内 ISO 串恒大于任何 SQL 串**（实测 `'…T02:00Z' > '… 03:00:00'` ⇒ 1），
      //    与真实先后无关 ⇒ 这条判据用**同一日内的两只标本**把"归一生效"变成可观测量。
      //    ⚠ 两个时刻都由**跑测那一刻**派生（不是写死的日历日）：跑在 UTC 零点后 3 小时内时，
      //      旧稿的 ISO 串会落到前一日 ⇒ 裸比较也会正确地挑中"近的"，本判据**失去区分力但不会变红**，
      //      即最坏情况是"这 3 小时里它不咬人"，不是一个会自己引爆的哑雷。
      const isoUtc = (off: number) => new Date(Date.now() + off).toISOString();
      const sqlUtc = (off: number) => new Date(Date.now() + off).toISOString().slice(0, 19).replace('T', ' ');
      const dbTs = mkQueryDb();
      dbTs.prepare("INSERT INTO wa_projects (id, name, status) VALUES ('P','演示项目','active')").run();
      seedTask(dbTs, 'T-iso', '上午那份旧稿', 'completed', isoUtc(-3 * 3600_000));   // 该不命中：ISO、3 小时前
      seedTask(dbTs, 'T-sql', '刚收尾的周报', 'completed', sqlUtc(-1 * 3600_000));   // 该命中：SQL、1 小时前
      const rTs = (await routeOnce(dbTs, 'u-m6-ts'))[0] ?? '';
      const tsLine = lineOf(rTs, /最近一条终态/)[0] ?? '';
      crit('M6', /「刚收尾的周报」/.test(tsLine) && !/旧稿/.test(tsLine),
        '★ C18 标本（真发「查看系统状态」）`updated_at` **两格式混存**下仍按**真实先后**取最近终态：'
        + '1 小时前的 SQL 行 › 3 小时前的 ISO 行（裸 `ORDER BY updated_at` 会让同日 ISO 串恒赢 ⇒ 这条会红）',
        tsLine || '（无该段）');
      crit('M6', tsBare.length === 0,
        '★ C18 `im-router.ts` 里 `wa_tasks.updated_at` 的读点**已全部归一**（`datetime(updated_at)`；'
        + '**新增裸读即红**——那两处 `-30 seconds` 防重投闸判假会**静默吞掉**用户的启动指令，正是本轮在治的形状）',
        tsBare.length === 0 ? '0 处裸读' : `${tsBare.length} 处未归一：${tsBare.map(t => t.trim().slice(0, 40)).join(' ｜ ')}`);

      // C14 正向（反向的"帮助语义未被吞"在 R-4）：`QUERY_REGEX` 的**全部命中点**已穷举并一致
      //   —— enum-sweep 纪律：改/加一个触发词，就该把**所有**读它的地方一起看一遍。
      //   ⚠ zx_20260924_1 M1 订正：谓词**已迁入唯一真源** `im-commands.ts`（路由只引不抄）⇒ 正则**改从
      //     真源取**，并要求路由仍**引**它（换成"路由内就地声明"才是本轮要拦的回归，见上方反证）。
      const cmdsQr = strip(path.join(MAIN, 'services/im-commands.ts'));
      const qrSrc = /export const QUERY_REGEX\s*=\s*(\/.*\/[a-z]*)/.exec(cmdsQr)?.[1] ?? '';
      crit('M6', qrSrc.length > 0 && imr.includes('QUERY_REGEX'),
        '★ C14 正向：`QUERY_REGEX` 仍是**具名常量**（新增触发词须在**一处**改，不得散落成字面量）——真源在 `im-commands.ts`',
        qrSrc ? qrSrc.slice(0, 70) : '未找到具名正则');
      // 穷举读点：声明 1 + `routeImMessage` 内 2（步骤1.5 的 `isRegexMatched` / 步骤5）。
      //   ⚠ 这条**会随新增读点变红**，且这正是它的用处——本轮的病根之一就是"加了个取值却没回头扫读点"。
      //     红了不等于写错了：把新读点也一并登记（并想清楚它与既有两处**同尺**）后再改这个数。
      const qrHits = imr.split('\n').filter(t => t.includes('QUERY_REGEX'));
      crit('M6', qrHits.length === 3,
        '★ C14 `QUERY_REGEX` 的命中点**已穷举**（声明 1 + `routeImMessage` 内 2；**新增读点须来此处登记**）',
        `${qrHits.length} 处：${qrHits.map(t => t.trim().slice(0, 46)).join(' ｜ ')}`);
    }

    // ── M7 · C15/C17 记忆写读刻度同源（C16 反向已上移【R】R-5）────────────────
    {
      const memPath = path.join(MAIN, 'core/memory-manager.ts');
      const mem = strip(memPath);
      const memNS = memMod as unknown as Record<string, unknown>;
      const DEF = memNS.MEM_IMPORTANCE_DEFAULT as number | undefined;
      const MIN = memNS.PANORAMA_MIN_IMPORTANCE as number | undefined;
      crit('M7', typeof DEF === 'number' && typeof MIN === 'number',
        'C15 两个常量**一处真源**：`MEM_IMPORTANCE_DEFAULT`（写）与 `PANORAMA_MIN_IMPORTANCE`（读）已导出',
        `写=${String(DEF)} 读=${String(MIN)}`);
      // C15 关系式 **写 ≥ 读**：这是本轮 §1.6 闭环死锁的解——原状是"写恒 0.5、读要 0.6"，
      //   两条式子在**两个文件里各写一遍**，谁也没把另一条当约束。
      crit('M7', typeof DEF === 'number' && typeof MIN === 'number' && DEF >= MIN,
        '★ C15 关系式：**写 ≥ 读** —— 否则新写入的记忆永远进不了「可被整合」的集合（§1.6 闭环死锁）',
        `${String(DEF)} >= ${String(MIN)}`);

      // C15 **行为**判据（不是"源码里有没有 importance 这个词"）：
      // ⚠ **M0 复核时否掉的第一版**：`/INSERT INTO wa_memories[^)]*importance/.test(mem)` ——
      //   它会命中**同文件的 `store()`**（那一条 INSERT **本来就带** importance），于是
      //   `storeText` 还没修就"提前为真"。⇒ 判据必须**按符号切块**，只取 `storeText` 的方法体。
      //
      // ⚠ **切块本身也有坑**：`braceBlock` 取的是"`from` 之后第一个 `{` 的配对块"，而
      //   `storeText(params: { project_id: string; … }): string {` 里**第一个 `{` 是参数类型字面量**，
      //   配对块会在类型字面量处闭合 ⇒ 切出来的是**参数类型**而不是方法体（那样下面的 INSERT 恒取不到，
      //   判据变**假红**）。故先跳过参数表，从 `): string {` 这个**方法体起点**再切。
      const si = mem.indexOf('storeText(params');
      const bodyStart = si < 0 ? -1 : mem.indexOf('): string {', si);
      const sblk = bodyStart < 0 ? '' : braceBlock(mem, bodyStart + '): string '.length);
      const insIdx = sblk.indexOf('INSERT INTO wa_memories');
      const insStmt = insIdx < 0 ? '' : sblk.slice(insIdx, insIdx + 420);
      const cols = /INSERT INTO wa_memories\s*\(([^)]*)\)/.exec(insStmt)?.[1] ?? '';
      // 自证（不受批次门管辖）：**切块切对了** —— 方法体里必须能看到 `randomUUID`/`params.content`
      //   这类只有方法体内的东西；否则"列清单里没有 importance"是切错块造成的假红。
      ok(sblk.length > 200 && /params\.content|randomUUID/.test(sblk),
        `★ C15 自证：` + '`storeText` 方法体切块**切对了**' + `（块长 ${sblk.length}，含方法体特征）`);
      crit('M7', cols.length > 0 && /\bimportance\b/.test(cols),
        '★ C15 `storeText`（**按符号切块**）的 INSERT **列清单里带 `importance`**（此前不含 ⇒ 取表默认 0.5）',
        cols ? `列：${cols.replace(/\s+/g, ' ').slice(0, 100)}` : '未取到 storeText 的 INSERT');
      const valueFromConst = /MEM_IMPORTANCE_DEFAULT/.test(sblk);
      crit('M7', valueFromConst,
        '★ C15 写入值**取自常量** `MEM_IMPORTANCE_DEFAULT`（而非又写一个 0.5 字面量 —— 那只是把病换个地方）');
      // C17 正向可达性：`synthesizeProjectKnowledge` 的门槛**必须**读同一个常量（不得另写 0.6 字面量）
      const synIdx = mem.indexOf('synthesizeProjectKnowledge');
      const synBlk = braceBlock(mem, synIdx);
      ok(synBlk.length > 100, `★ C15 自证：\`synthesizeProjectKnowledge\` 块切到（块长 ${synBlk.length}）`);
      crit('M7', /PANORAMA_MIN_IMPORTANCE/.test(synBlk) || /PANORAMA_MIN_IMPORTANCE/.test(mem),
        '★ C15 读侧门槛与常量**同源**：`synthesizeProjectKnowledge` 的取数门槛读 `PANORAMA_MIN_IMPORTANCE`',
        /PANORAMA_MIN_IMPORTANCE/.test(synBlk) ? '同源' : '未读到常量（仍是字面量门槛）');
      // C17 —— **跑真实现**（方案 §M7 细化规划 六）：原稿是"自建表 + 自抄那条读 SQL"，两边各写一遍 ⇒ **自我印证**
      //   （两边一起写错就一起"通过"）。现升格为 `new MemoryManager(内存库, stub)` 后**直接调真实现再读回**
      //   ——"这条记忆出生时落在什么刻度上"是**行为**，源码里有没有 `importance` 这个词证明不了它。
      //
      //   ⚠ 夹具**照生产初始化顺序**（本仓家法）：先 exec DDL → 再 `new`（其构造里 `initFts()` 建 FTS **同步触发器**）
      //      → **最后才写数据行**。顺序颠倒 ⇒ 触发器建于行之后，首次 UPDATE 命中未索引 rowid 抛错**被 try/catch 吞掉**
      //      ⇒ 断言**假绿**（`feedback_rr_fixture_production_order`）。
      const MEM_SCHEMA = `
        CREATE TABLE wa_memories (
          id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT,
          content TEXT NOT NULL, embedding TEXT, memory_type TEXT DEFAULT 'episodic',
          importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution',
          user_id TEXT DEFAULT '', valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}',
          is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT, exemplar_context TEXT, updated_at TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT DEFAULT '', description TEXT DEFAULT '', context_json TEXT DEFAULT '{}');
        CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
      `;
      if (typeof DEF === 'number' && typeof MIN === 'number') {
        const MM = memNS.MemoryManager as (new (db: unknown, ans: unknown) => {
          storeText: (p: Record<string, unknown>) => string;
          storeUserPreference: (p: Record<string, unknown>) => string;
        }) | undefined;
        if (typeof MM !== 'function') {
          crit('M7', false, '★ C17 **跑真实现**：`MemoryManager` 可从模块命名空间取到并可实例化（内存库 + AnsClient stub）');
        } else {
          const mkMemDb = (): AnyDb => { const d = new DatabaseSync(':memory:') as unknown as AnyDb; d.exec(MEM_SCHEMA); return d; };
          const impOf = (d: AnyDb, id: string) => (d.prepare('SELECT importance FROM wa_memories WHERE id = ?').get(id) as { importance: number } | undefined)?.importance;
          const db = mkMemDb();
          let bootErr = '';
          let real: (InstanceType<typeof MM>) | null = null;
          try { real = new MM(db, null); } catch (e) { bootErr = (e as Error).message; }
          crit('M7', real !== null,
            '★ C17 自证：`MemoryManager` 在**无 Electron** 的内存库上可实例化（`initFts`/`pruneArchivedMemory` 皆自带 try/catch）'
            + '——实例化得起来，"跑真实现"这四个字才立得住',
            bootErr || '实例化成功');
          if (real) {
            const base = { project_id: 'P', type: 'semantic', source: 'rr_c17' };
            const idDef = real.storeText({ ...base, content: '不带刻度的新记忆' });
            crit('M7', impOf(db, idDef) === DEF,
              `★ C17 ① 不带 \`importance\` 调**真 \`storeText\`** ⇒ 落库刻度 = \`MEM_IMPORTANCE_DEFAULT\`（${DEF}）`
              + '——这一条就是 §1.6 死锁的解：新写入**出生即在读门槛之上**',
              `实落 ${String(impOf(db, idDef))}`);
            const id09 = real.storeText({ ...base, content: '模型自评 0.9', importance: 0.9 });
            crit('M7', impOf(db, id09) === 0.9,
              '★ C17 ② 带 `importance: 0.9`（模型自评，`background-review` 那条路）⇒ **原样落 0.9**，不被抹成默认值',
              `实落 ${String(impOf(db, id09))}`);
            const idHi = real.storeText({ ...base, content: '越界 1.7', importance: 1.7 });
            crit('M7', impOf(db, idHi) === 1,
              '★ C17 ③ 带 `importance: 1.7` ⇒ **夹到上界 1**（模型输出不可信，越界值不得原样落库）',
              `实落 ${String(impOf(db, idHi))}`);
            const idLo = real.storeText({ ...base, content: '越界 -3', importance: -3 });
            crit('M7', impOf(db, idLo) === 0,
              '★ C17 ④ 带 `importance: -3` ⇒ **夹到下界 0**（且**不**回填默认值——「这条不重要」是合法判断，抹平即另一种失真）',
              `实落 ${String(impOf(db, idLo))}`);
            const idPref = real.storeUserPreference({ user_id: 'u1', content: '用户偏好：先看结论', source: 'user_onboarding' });
            crit('M7', impOf(db, idPref) === DEF,
              `★ C17 ⑤ \`storeUserPreference\`（引导向导经 \`preferences:batch\` 落到的那条路）⇒ 落 \`MEM_IMPORTANCE_DEFAULT\``,
              `实落 ${String(impOf(db, idPref))}`);
          }
          // 读侧可达性：**真写入 → 真取数**。取数谓词从**源码里认领**（不是两边各写一遍）：
          //   源码若改了成员集或门槛，本判据**如实变红**，而不是"自我印证式"的一起通过。
          const PAN_PRED = "memory_type IN ('semantic','procedural','retrospective','negative') AND importance >=";
          ok(synBlk.replace(/\s+/g, ' ').includes(PAN_PRED.replace(/\s+/g, ' ')),
            '★ C17 自证：下面的取数谓词**与 `synthesizeProjectKnowledge` 源码同款**（源码改谓词 ⇒ 本判据红，不自我印证）');
          const panCount = (d: AnyDb) => (d.prepare(`SELECT COUNT(*) AS c FROM wa_memories WHERE project_id = ? AND ${PAN_PRED} ?`).get('P', MIN) as { c: number }).c;
          if (real) {
            const dbPan = mkMemDb();
            const pan = new MM(dbPan, null);
            for (let k = 0; k < 3; k++) pan.storeText({ project_id: 'P', type: 'semantic', source: 'rr_c17', content: `新刻度样本${k}` });
            crit('M7', panCount(dbPan) >= 3,
              `★ C17 **该命中**标本：真 \`storeText\` 按**新默认值**写 3 条语义记忆 ⇒ 取数 SQL 取到 ${panCount(dbPan)} 条（≥3 才够「整合成体系」起手）`);
            const dbLegacy = mkMemDb();
            const legacy = new MM(dbLegacy, null);
            for (let k = 0; k < 3; k++) legacy.storeText({ project_id: 'P', type: 'semantic', source: 'rr_c17', content: `存量刻度样本${k}`, importance: 0.5 });
            const miss = panCount(dbLegacy);
            crit('M7', miss < 3,
              `★ C17 **该不命中**标本：显式按**存量值 0.5** 写 3 条 ⇒ 只取到 ${miss} 条`
              + '——锁住「门槛 > 0.5」：否则把门槛调到 0.5 就能**假装**治好 §1.6（病在写入侧，不在门槛侧）');
          }
        }
      } else {
        crit('M7', false, '★ C17 两只标本（新默认值该命中 / 存量 0.5 该不命中）—— 常量未导出，无法试');
      }

      // C19（M7 新增）——**全 `src/main` 的写点普查**：凡 `INSERT INTO wa_memories`，**列清单里都得有 `importance`**。
      //   C15 只按符号切了 `storeText` **一处**；而 §M7 细化规划的普查表明写点**不止一处** —— "只修一处"
      //   正是本轮的病根形状（同 §C14 的读点穷举）。**省略列 = 静默取表默认 0.5**，故新增一处省略列的写入即红。
      //   ⚠ 自证：扫到的站点数**必须 > 0** —— 否则"零处不合规"是**扫了个空**换来的假绿。
      const memInserts: Array<{ file: string; line: number; cols: string }> = [];
      for (const f of walkTs(MAIN)) {
        strip(f).split('\n').forEach((ln, i) => {
          for (const m of ln.matchAll(/INSERT INTO wa_memories\s*\(([^)]*)\)/g)) {
            memInserts.push({ file: path.relative(root, f), line: i + 1, cols: m[1] ?? '' });
          }
        });
      }
      const missingCol = memInserts.filter(s => !/\bimportance\b/.test(s.cols));
      ok(memInserts.length > 0,
        `★ C19 自证：扫到了真实的 \`INSERT INTO wa_memories\` 写点（${memInserts.length} 处）——不是扫了个空`);
      crit('M7', memInserts.length > 0 && missingCol.length === 0,
        '★ C19 `src/main` **每一处** `INSERT INTO wa_memories` 的列清单都含 `importance`（新增省略列的写入即红）',
        missingCol.length === 0
          ? `${memInserts.length} 处全部带列`
          : `${missingCol.length}/${memInserts.length} 处未带：${missingCol.map(s => `${s.file}:${s.line}`).join(' ｜ ')}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // §F 判据 F —— M9-fix（**就地补丁**：独立核验发现的 F1–F5，方案 §6.6）
  //
  // 五条问的是**同一句话**：「判据跑的是生产真走的那条路吗」。这是本轮病根（在册≠在用）的**镜像**：
  //   D1–D6 是"功能在册、没被用起来"；F1–F3 是"**判据在册、生产根本没走那条路**"——两者都给出
  //   **全绿**，而后者更危险：绿的是判据，坏的是真机。
  // ⇒ 故 F1 钉住"生产确实调了那个函数"，F3 要求标本形状**由生产形状构造**（不手写 kind）。
  // ⚠ 单列 M9 而**不塞回 M1/M4/M5**：M8 的档内判据数须保持 **0**（方案 §五-1），
  //   补丁不该动"每批判据数"这本账；`RR_STAGE='M8'` 时本块如实标 ⏳（补丁是 M8 之后的动作）。
  console.log('\n【F】M9-fix 就地补丁：判据跑的是生产真走的那条路吗（F1–F5）');
  {
    const execPath = path.join(MAIN, 'core/agent-executor.ts');
    const execSrc = strip(execPath);
    const execRaw = raw(execPath);

    // ── F1 `buildModelRequest` 必须是**生产真正走的那份** ──────────────────────
    //   补丁前：`agent-executor` 把它的函数体**内联**了一份，"未配置则键不出现"的保证只落在
    //   **函数**上，而函数只有本脚本在调 ⇒ C10 跑的是生产绕开的实现，全绿而真机是另一回事。
    const f1Surface = execSurface();
    crit('M9', f1Surface.includes('buildModelRequest('),
      '★ F1 接线：ANS 请求体**经 `buildModelRequest` 构造**（判据与生产同走一条路）',
      `扫描面=${execSurfaceFiles.length} 文件（执行体 ∪ core/exec-*.ts）`);
    //   ⚠ 反向条**同样取并集**——这是"只许更严"的那一半：原先只证"执行体里没有第二份字面量构造"，
    //     搬到 `exec-model-select.ts` 后若有人在那里重写一份字面量，旧口径**扫不到**。取并集才真的证住
    //     "「键在场才写」的保证只此一处"。
    const secondCtor = /const\s+modelReq[^;]*=\s*\{/.test(f1Surface);
    crit('M9', !secondCtor,
      '★ F1 反向：**整个扫描面内不再**把请求体写成字面量对象（"键在场才写"的保证只此一处）',
      secondCtor ? '发现第二份 `const modelReq = {…}` 字面量构造' : '无第二份构造');

    // ── F2/F3 回执标签须**由生产产出的 kind 驱动**，且标本**不手写 kind** ──────────
    //   ⚠ **本条刻意不对 kind 的取值下断言**——本仓对 kind 的形状有**两条并存的合法裁定**：
    //     (a) 平台原始 `type`（数字）："未知类型**原样带出**、不猜名字"，`rr_zx_20260914_2` **三处**
    //         钉死（占位符 `[其他消息(2)]` / 微信入库 `"kind":"2"` / renderer 按 `'3'`/`'2'` 读回）；
    //     (b) 平台 `*_item` 字段名（符号，与 `im-adapter` 契约注释里的 `image/file/voice` 同形）。
    //   M9 复核一度改判 (b)、(b) **动的是上一轮的契约** ⇒ 已回退为 (a)；**用户已裁定「保持 (a) 数字」**
    //   （2026-09-21，方案 §5 五-17）——**是已决、不是待办**。故本条只钉**两条都不许违反的那件事**：
    //   kind 在场、且**回执由它驱动**。
    //   （不钉 (a)/(b) 谁对 ⇒ 日后裁定 (b) 时本条不必再改，改的是那条契约与它的三处钉子。）
    const ilinkImg = mediaFromIlinkItems([{ type: 9, image_item: { url: 'https://x/p.png', file_name: 'p.png', size: 7 } }]);
    const gotKind = String(ilinkImg?.kind ?? '');
    const kindLegit = gotKind === '9' || gotKind === 'image';   // 两条合法裁定之一
    crit('M9', kindLegit && !!ilinkImg?.mediaUrl && ilinkImg?.fileName === 'p.png' && ilinkImg?.sizeBytes === 7,
      '★ F2 取件：从 `*_item` 认出 kind/url/件名/大小（kind 取平台 `type` 数字 **或** `*_item` 字段名，**两条合法裁定之一**）',
      `实测 kind=${gotKind}（url=${ilinkImg?.mediaUrl ?? '-'} 名=${ilinkImg?.fileName ?? '-'} 大小=${ilinkImg?.sizeBytes ?? '-'}）`);
    // ★ F3 的**要点**：下面**不手写 kind**——拿上面那条**生产函数产出的** kind 直接喂回执，
    //   两头形状由构造保证一致；期望值取**同一张表**（引真源），而非手抄的"图片"。
    //   补丁前标本喂 `kind:'image'` 而生产给数字 ⇒ "标签命中"是**自我印证**的假绿。
    const coupledTxt = mediaReceiptText({
      kind: gotKind, fileName: 'p.png', sizeBytes: 7,
      savedPath: path.join(attachmentsRoot(os.tmpdir()), '20260920', 'p.png'),
    });
    const expectLabel = NON_TEXT_LABELS[gotKind] ?? `其他消息(${gotKind})`;
    crit('M9', coupledTxt.includes(expectLabel),
      '★ F3 回执标签**由生产产出的 kind 驱动**：同一条 kind 喂生产函数 ⇒ 命中表 或 如实退化，**不出现第三种**',
      `kind=${gotKind} ⇒ 期望「${expectLabel}」，实测「${coupledTxt}」`);
    //   同根因第二面：无名件仍须**落到盘上、字节相符**（扩展名按 kind 猜得出则有、猜不出**不编造**——
    //   `byKind` 按**类型名**建 ⇒ 数字 kind 推不出扩展名，这是 (a)/(b) 裁定的**已知代价**，方案 §5 挂账）。
    const tmpM9 = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-m9-media-'));
    try {
      const unnamed = saveInboundMedia(tmpM9, { kind: gotKind }, Buffer.from('xyz'), new Date('2026-09-20T03:04:05Z'));
      const onDisk = unnamed.ok ? fs.readFileSync(unnamed.path) : null;
      crit('M9', unnamed.ok && !!onDisk && onDisk.length === 3 && onDisk.toString() === 'xyz',
        '★ F2 同根因第二面：无名媒体件仍**落到盘上且字节相符**（扩展名猜得出则有、猜不出不编造）',
        unnamed.ok ? `${path.basename(unnamed.path)}（盘上 ${onDisk!.length}B）` : unnamed.error);
    } finally { fs.rmSync(tmpM9, { recursive: true, force: true }); }
    //   标签表**一处真源**：`im-media` 须引 `im-adapter` 的 `NON_TEXT_LABELS`，不得再自抄（自抄即漂移）
    const mediaSrc = strip(path.join(MAIN, 'services/im-media.ts'));
    crit('M9', !/const\s+RECEIPT_LABEL/.test(mediaSrc) && mediaSrc.includes('NON_TEXT_LABELS'),
      '★ F2 标签表**一处真源**：`im-media` 引 `im-adapter` 的 `NON_TEXT_LABELS`，不再自抄 `RECEIPT_LABEL`');
    //   该不命中侧：**真·陌生类型**仍须如实退化成 `其他消息(x)`——不是"一律编个漂亮名字"
    const unknownTxt = mediaReceiptText({ kind: 'zzz_new_type', fileName: 'a.bin', savedPath: '/x/attachments/a.bin' });
    crit('M9', unknownTxt.includes('其他消息(zzz_new_type)'),
      '★ F2 该不命中：表外类型**原样带出**（`其他消息(zzz_new_type)`，不编造名字）', unknownTxt);

    // ── F4 build 注释台账须与方案 §1 六条病根**同集**（D 号由方案派生，不手抄）────────
    //   补丁前那一行写的是"质检按档收窄/验收缺口须有人应"——两个短语**方案里一次都没出现**，
    //   且**漏了 D2/D4/D5 三批**。台账是"开新轮只改一处"的索引，写虚即等于没有索引。
    //   ⚠ 本条是**注释内容判据**（弱判据）：能防"漏记"，防不了"记错"。别把它当强证据读。
    const round = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');
    const planPath = path.join(root, 'plans/improve', `${round}.md`);
    try {
      const planTxt = fs.readFileSync(planPath, 'utf-8');
      const dread = [...planTxt.matchAll(/^\|\s*(D\d+)\s*\|/gm)].map((m) => m[1]!);
      const at = execRaw.indexOf(`${round} M8: 按同约定刷新为`);
      const ledger = at >= 0 ? execRaw.slice(at, at + 700) : '';
      const missing = dread.filter((d) => !new RegExp(`\\b${d}\\b`).test(ledger));
      ok(dread.length >= 6,
        `★ F4 自证：D 号由**方案 ${path.basename(planPath)}** 派生得到（${dread.join('/')}）——不是手抄`);
      crit('M9', at >= 0 && missing.length === 0,
        '★ F4 build 注释台账**列全**方案 §1 的病根（M9-fix 前写的是一行方案里根本没有的短语，且漏三批）',
        at < 0 ? '台账行未找到' : (missing.length ? `漏 ${missing.join(',')}` : `${dread.join('/')} 全在`));
    } catch (e) {
      crit('M9', false, '★ F4 台账核对：方案文件读不到（**未证**，不得读作通过）', String((e as Error).message).slice(0, 100));
    }

    // ── F5 死 import：executor 从 `task-archetype` 导入的名字**都得用上** ────────
    //   补丁前 `availableToolNames` 只出现在 import 行（真使用者是 `task-archetype` 内部）。
    const arcM = /\{([^{}]*)\}\s*from\s*'\.\/task-archetype\.js'/.exec(execSrc);
    const imported = (arcM?.[1] ?? '').split(',').map((s) => s.replace(/^\s*type\s+/, '').trim()).filter(Boolean);
    ok(imported.length >= 8, `★ F5 自证：解析到 ${imported.length} 个具名导入（不是解析了个空）`);
    const deadImp = imported.filter((n) => (execSrc.match(new RegExp(`\\b${n}\\b`, 'g')) || []).length < 2);
    crit('M9', deadImp.length === 0,
      '★ F5 无死 import：`task-archetype` 导入的每个名字在 executor 内**至少用到一次**',
      deadImp.length ? `死 import：${deadImp.join(', ')}` : `${imported.length} 个全部在用`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S】build 钉（派生核对，不写轮次字面量；**不受批次门管辖**）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

/** C13 的判据本体：`handleSystemQuery` 的块里必须查**真任务行**（含标题/状态），而不只是 `COUNT(*)`。 */
function cfgQueryDeep(blk: string): boolean {
  const hasTitle = /SELECT[\s\S]{0,240}\btitle\b[\s\S]{0,240}FROM\s+wa_tasks/.test(blk);
  const onlyCounts = (blk.match(/COUNT\(\*\)/g) || []).length;
  const rows = /\.all\(/.test(blk);
  return hasTitle && rows && onlyCounts >= 1;
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告
//    unhandled rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20260920_1 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260920_1: ${pass} 通过 / ${fail} 失败${pending ? ` / ${pending} 待实施(不计入)` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
});
