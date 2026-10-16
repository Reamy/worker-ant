/**
 * zx_20260924_1 M9（循名责实）受控复跑 —— 「写下的，机器要认」。
 *
 * 三条病根（全部有真库标本，见方案 §1.13/§1.14/§1.16）：
 *   ① **M9-a**：`document`/`research`/`analysis` 任务写了 `.md` 却被判"无产出物"压到 45
 *      （标本 `a5dfdb48`：名下 23 行 `[edit_file] …api.md`，评分仍 45 + `[document类无产出物…]`）。
 *   ② **M9-b**：无相似样本时整段估时**静默不写**（"没估成"与"还没跑"不可区分）；且无"已有估时"守卫
 *      ⇒ 父任务跨恢复 **emit `task.estimated` 6 次**（标本 `0e4c318c`）。
 *   ③ **M9-c**：`completion_quality.via` 无消费面（自评 95 与六维 45 看起来像同一把尺）；
 *      `milestones_without_child_tasks` 写下了却只沉在 `finalize_checks` 里（"登记"被当"已执行"）。
 *
 * §判据纪律（逐条对上本仓 auto-memory）：
 *   G-1 **真源在位**：直调生产符号（`assessCompletionQuality` / `estimateTaskBudget` /
 *       `hasUsableTaskEstimate` / `toolRowShowsArtifactEdit` / `ARTIFACT_EDIT_EXTS` /
 *       `NO_SAMPLE_ESTIMATE_NOTE` / `resolveMaxSteps`）——被删/改名即**编译期失败**，不是"扫了个空"。
 *   G-2 **两只标本**：cap A 两侧（该压 / 该不压）各有真标本；估时两侧（无样本 / 已有估时）亦然。
 *   G-3 **计数器正面断言**：`task_estimate` 断言"无此键 → 有此键"（0 → 1），不只断言"不抛"。
 *   G-4 **生产入参**：cap A 的"该不压"标本喂的是 `role='tool'` 行的**当前生产真形状**
 *       （单行 `[write_file] {"ok":true,"path":"…md",…}` / `[edit_file] {"ok":true,"path":"…","replaced":…}`）
 *       ——**不是**判据正则长得像的那个形状，**也不是**老的两行 `filePath` 形状。
 *       病根即在此：旧判据只认"调用实参"形状，在真库 **0 行**上成立；M9-a 首版改为认两行 `filePath`
 *       形状后，**仍只覆盖真库 1502 行写入类行里的 121 行**——它自点名的标本 `a5dfdb48`（23 行全是
 *       单行 `path` 形状）**一条都不认** ⇒ 套件全绿而生产零效果（自我印证）。本版按真库实测分布
 *       （`path` 单行 1019+291 / 老两行 106+15）把三种形状一并认下，并补「该不认」侧标本防过宽。
 *   G-5 无轮次字面量：不改 `build`，钉由 `checkBuildPins` 从真源派生。
 *   G-6 不依赖真实墙钟：无 `now`/无绝对时刻；时间列一律让 SQLite 默认值填。
 *
 * ⚠ 本脚本**不跑** renderer 构建（并发纪律）；界面侧只做源码级在场断言。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
import {
  assessCompletionQuality, estimateTaskBudget, hasUsableTaskEstimate, NO_SAMPLE_ESTIMATE_NOTE,
  toolRowShowsArtifactEdit, ARTIFACT_EDIT_EXTS, realOutputEvidence,
} from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { resolveMaxSteps } from '../apps/worker-ant-desktop/src/main/core/step-budget.js';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq<T>(got: T, want: T, label: string): void {
  ok(Object.is(got, want), label, `实测 ${JSON.stringify(got)} / 期望 ${JSON.stringify(want)}`);
}

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const RENDERER = path.join(root, `${A}/renderer/src`);

/** 夹具表：只建判据真正会读的三张（列名按生产 schema） */
const DDL = `
  CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, parent_task_id TEXT, context_json TEXT DEFAULT '{}', tokens_used INTEGER DEFAULT 0);
  CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, name TEXT DEFAULT '', type TEXT DEFAULT 'doc', status TEXT DEFAULT 'draft', file_path TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT DEFAULT '', content TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
`;
type Db = InstanceType<typeof DatabaseSync>;
const makeDb = (): Db => { const d = new DatabaseSync(':memory:'); d.exec(DDL); return d; };
let seq = 0;
const addTask = (d: Db, id: string, ctx: Record<string, unknown> = {}): void => {
  d.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run(id, JSON.stringify(ctx));
};
const addToolRow = (d: Db, taskId: string, content: string): void => {
  d.prepare('INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?, ?, ?, ?)').run(`c${++seq}`, taskId, 'tool', content);
};
/** n 条 assistant 对话（低于 2 条会撞"无产出物且无对话 → 10 分"硬规则，故夹具按生产常态给 3 条） */
const addChat = (d: Db, taskId: string, n: number): void => {
  for (let i = 0; i < n; i++) d.prepare('INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?, ?, ?, ?)').run(`c${++seq}`, taskId, 'assistant', `第 ${i + 1} 轮结论`);
};
const readEst = (d: Db, taskId: string): { tokens?: number; steps?: number; basedOn?: number; note?: string } | undefined => {
  const row = d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined;
  return (JSON.parse(row?.context_json || '{}') as { task_estimate?: { tokens?: number; steps?: number; basedOn?: number; note?: string } }).task_estimate;
};
const readCtx = (d: Db, taskId: string): Record<string, unknown> => {
  const row = d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined;
  return JSON.parse(row?.context_json || '{}') as Record<string, unknown>;
};

const wdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr_m9_'));
fs.writeFileSync(path.join(wdir, 'notes.txt'), '夹具工作目录（`checkMCPRegistrationIntegrity` 扫它，空目录 ⇒ 0 缺失）', 'utf-8');

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【A】M9-a 逃生门（cap A）：两侧各一只真标本 —— 真调 `assessCompletionQuality`');
const dbA = makeDb();

// ── A-1 该压侧：`document` 类、本任务 0 产出物、查无任何写入 ──
addTask(dbA, 'a-none'); addChat(dbA, 'a-none', 3);
const qNone = assessCompletionQuality(dbA as never, 'a-none', 8, 20_000, 400_000, 40, wdir, 'document');
eq(qNone.score, 45, 'A-1 该压：document 类、0 产出物、无任何写入 ⇒ 仍压 45（放行 `.md` ≠ 放行"什么都没干"）');
ok(qNone.feedback.includes('document类无产出物，评分压降<60'), 'A-2 压降成因如实点名（capA 那条注记在场，不是"沉默地给低分"）', qNone.feedback);

// ── A-3 该不压侧：只写了一份 `.md`，喂**当前生产行的真形状** ──
//     真库实测（`quantify` 见下）：`[write_file] {"ok":true,"path":"…md","size":4726,"deliverableId":…,"updated":…}`
//     ——键是 **`path`** 而非 `filePath`（写手 `tools/write.ts` 的 `return JSON.stringify({ok,path,…})`）。
addTask(dbA, 'a-md'); addChat(dbA, 'a-md', 3);
addToolRow(dbA, 'a-md', '[write_file] ' + JSON.stringify({ ok: true, path: '信息雷达-报告.md', size: 4726, deliverableId: 'dv-1', updated: false }));
const qMd = assessCompletionQuality(dbA as never, 'a-md', 8, 20_000, 400_000, 40, wdir, 'document');
ok(qMd.score >= 60, 'A-3 该不压：只写了 `.md`（**当前生产形状**：单行 + `path` 键）⇒ 不再压 45（方案 §M9-a 的「该不压」判据）', `${qMd.score} 分`);
ok(qMd.feedback.includes('不压降') && !qMd.feedback.includes('类无产出物'), 'A-4 …且反馈改成"有产出性写入行为，不压降"（名实相符：不再说它没干活）', qMd.feedback);
// `edit_file` 现形状（真库另一支、且是**出现最多**的一支），单列一条防"只认 write_file"
addTask(dbA, 'a-edit'); addChat(dbA, 'a-edit', 3);
addToolRow(dbA, 'a-edit', '[edit_file] ' + JSON.stringify({ ok: true, path: 'plans/mp/api.md', replaced: 1, size: 16886 }));
const qEdit = assessCompletionQuality(dbA as never, 'a-edit', 8, 20_000, 400_000, 40, wdir, 'document');
ok(qEdit.score >= 60, 'A-5 `[edit_file] {"ok":true,"path":"…api.md",…}` 亦认（标本 a5dfdb48 名下 23 行正是此形——上一版夹具喂的是老形状，故套件全绿而标本零效果）', `${qEdit.score} 分`);

// ── A-6 隔离：把 cap A 与 cap B 分开（证明 A-1 的 45 不是被 cap B 顺手压的） ──
//     扩展名**不在册**（`.docx`）：用同一把"写过东西"的探测器看，cap B（`realOutputEvidence`，只看工具名）为真
//     ⇒ cap B 不触发；此时仍压 45，只可能出自 cap A。
addTask(dbA, 'a-docx'); addChat(dbA, 'a-docx', 3);
addToolRow(dbA, 'a-docx', '[write_file] ' + JSON.stringify({ ok: true, path: '报告.docx', size: 1, updated: false }));
ok(realOutputEvidence(dbA as never, 'a-docx'), 'A-6 前置：该行足以让 cap B **不**触发（`realOutputEvidence` 只看工具名，与扩展名无关）');
const qDocx = assessCompletionQuality(dbA as never, 'a-docx', 8, 20_000, 400_000, 40, wdir, 'document');
eq(qDocx.score, 45, 'A-7 隔离：扩展名不在册 ⇒ 45 分**只能**出自 cap A（cap B 此例不触发 ⇒ A-1 的 45 亦同理）');
ok(qDocx.feedback.includes('document类无产出物'), 'A-8 且注记确为 cap A 那条（不是 cap B 的"无真实产出证据"）', qDocx.feedback);

// ── A-9 不回退：历史/夹具的"调用实参"形状仍认得，且原九类代码扩展名逐字在场 ──
addTask(dbA, 'a-legacy'); addChat(dbA, 'a-legacy', 3);
addToolRow(dbA, 'a-legacy', '[工具调用] write_file({"filePath":"alert_dashboard.py"})');
const qLegacy = assessCompletionQuality(dbA as never, 'a-legacy', 8, 20_000, 400_000, 40, wdir, 'document');
ok(qLegacy.score >= 60, 'A-9 老形状（`write_file({"filePath":"…py"}`）+ 原九类扩展名 ⇒ 照样认得（改造只加不删）', `${qLegacy.score} 分`);

// ── A-9b 不回退：更老的**两行**形状（2026-08-06 前）仍认得 ──
//     本版修正形状假设时**只加不减**：老形状是"上一版唯一认得的那种"，删掉它就是拿新形状换旧形状。
addTask(dbA, 'a-legacy2'); addChat(dbA, 'a-legacy2', 3);
addToolRow(dbA, 'a-legacy2', '[write_file]\n' + JSON.stringify({ filePath: 'plans/backend/20260924.md', size: 22062, written: true, deliverableId: 'dv-2' }));
const qLegacy2 = assessCompletionQuality(dbA as never, 'a-legacy2', 8, 20_000, 400_000, 40, wdir, 'document');
ok(qLegacy2.score >= 60, 'A-9b 老两行形状 `[write_file]\\n{"filePath":…}` 照样认得（改形状假设只加不减；真库此形状 121 行）', `${qLegacy2.score} 分`);

// ── A-10 三种 archetype 之外不受影响（用户红线：不得改生效范围） ──
addTask(dbA, 'a-code'); addChat(dbA, 'a-code', 3);
const qCode = assessCompletionQuality(dbA as never, 'a-code', 8, 20_000, 400_000, 40, wdir, 'code');
ok(!qCode.feedback.includes('类无产出物'), 'A-10 `code` 类 0 产出物时**不出现** capA 注记（生效范围仍是那三种）', qCode.feedback);
ok(qCode.feedback.includes('无真实产出证据'), 'A-11 …而 cap B 自己的压降照旧在场（本项没顺手把压分链整条关掉）', qCode.feedback);

// ── A-12…A-14c 识别函数本身：两态并试（认得写入行 / 拒掉"同形但不是写入"的行，fail-closed） ──
//     本版新增的几条**全是「该不认」侧**——改形状假设就是"放宽"的高危动作，
//     只用"该认"样本验证 ⇒ 任何过宽变体全票通过（本仓纪律：两只标本一起试）。
ok(toolRowShowsArtifactEdit('[read_file]\n' + JSON.stringify({ filePath: 'x.md' })) === false,
  'A-12 反证：`[read_file]` 结果行**不**算写入（同形的 md 路径，只差工具名）');
// ★ 本版最关键的一条：**现形状的 read_file 也带 `path` 键**（真库 1336 行 `stream,path,size,preview`）
//   ——不先卡工具名，读一个 `.md` 就会被当成"写过文件"。
ok(toolRowShowsArtifactEdit('[read_file] ' + JSON.stringify({ stream: 'file', path: 'x.md', size: 12, preview: '…' })) === false,
  'A-12b ★反证：**现形状**的 `[read_file] {"stream":…,"path":"x.md",…}`（真库 1336 行）不认——工具名先决不可省');
// ★ 第二条：`register_deliverable` 的结果行**直接带 `filePath`**（真库 128 行）——同键同形，只有工具名不同。
ok(toolRowShowsArtifactEdit('[register_deliverable] ' + JSON.stringify({ ok: true, id: 'd1', name: 'n', type: 'doc', filePath: 'x.md', deduplicated: false })) === false,
  'A-12c ★反证：`[register_deliverable]` 结果行**带 `filePath`**（真库 128 行）仍不认——"注册一件成果"≠"写过文件"');
ok(toolRowShowsArtifactEdit('[list_files] ' + JSON.stringify({ path: 'x.md', count: 1, files: [] })) === false,
  'A-12d 反证：`[list_files]`（真库 250 行带 `path`）不认');
ok(toolRowShowsArtifactEdit('[write_file]\n{不是 JSON') === false,
  'A-13 坏 JSON ⇒ 判"看不出"（fail-closed：不猜、不抛）');
ok(toolRowShowsArtifactEdit('[write_file]\n' + JSON.stringify({ filePath: '报告.MD' })) === false,
  'A-14 大小写敏感未放宽（老形状 `.MD` 不认——与原判据同尺，不做顺带放宽）');
// ★ 扩展名闸对**新键 `path`** 同样生效（不是"只要带 path 就算"）
ok(toolRowShowsArtifactEdit('[write_file] ' + JSON.stringify({ ok: true, path: '报告.docx', size: 1, updated: false })) === false,
  'A-14b ★反证：新形状的**不在册扩展名**（`.docx`）不认——本版放宽的是"键名"，不是"扩展名"');
// ★ 失败行天然不认（真库 `[edit_file] {"error":…}` 69 行）
ok(toolRowShowsArtifactEdit('[edit_file] ' + JSON.stringify({ error: '禁止绝对路径', hint: '请用相对路径' })) === false,
  'A-14c 反证：失败行 `[edit_file] {"error":…,"hint":…}`（真库 69 行）不认——没写成的不算写过');
ok(toolRowShowsArtifactEdit('[write_file] ' + JSON.stringify({ ok: true, deliverableId: 'dv-1', updated: true, size: 1 })) === false,
  'A-14d 反证：缺路径键的结果行不认（无 `path` 也无 `filePath`）');
// ── A-14e 正面：新形状两侧键都认（`path` 与 `filePath` 各一只） ──
ok(toolRowShowsArtifactEdit('[write_file] ' + JSON.stringify({ ok: true, path: 'a/b.md', size: 1, updated: false })) === true,
  'A-14e 正面：新形状 `path` 键认（真库 write_file 291 行）');
ok(toolRowShowsArtifactEdit('[edit_file] ' + JSON.stringify({ ok: true, path: 'a/b.md', replaced: 1, size: 1 })) === true,
  'A-14f 正面：新形状 `path` 键认（真库 edit_file 1019 行）');

// ── A-15 名单本身：原九类逐字在场；**未**并入 `CODE_ARTIFACT_EXTS` 的宽成员 ──
const EXTS = ARTIFACT_EDIT_EXTS as readonly string[];
for (const e of ['py', 'ts', 'tsx', 'js', 'jsx', 'go', 'rs', 'java', 'sql']) {
  ok(EXTS.includes(e), `A-15 原九类代码扩展名逐字在场：${e}`);
}
for (const e of ['md', 'markdown', 'mdx', 'txt', 'yaml', 'yml', 'json', 'csv', 'html']) {
  ok(EXTS.includes(e), `A-16 M9-a 补的文档/数据类在场：${e}`);
}
for (const e of ['mjs', 'kt', 'vue', 'svelte', 'cpp', 'cs']) {
  ok(!EXTS.includes(e), `A-17 「未并入产物判型那张更宽的表（CODE_ARTIFACT_EXTS）」的成员：${e}`);
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【B】M9-b 估时：无样本留痕 + 已有估时不重估 —— 真调 `estimateTaskBudget`');
const dbB = makeDb();

// ── B-1 无样本：从前整段静默不写；现在"没估成"要留痕（0 → 1 正面断言） ──
addTask(dbB, 'est-none');
eq(readEst(dbB, 'est-none'), undefined, 'B-1 前置：该任务此刻**没有** `task_estimate` 键（"还没跑到"与"没估成"在库里同形，正是病根）');
const b1 = estimateTaskBudget(dbB as never, { taskId: 'est-none', similar: [] });
eq(b1.status, 'no_samples', 'B-2 无样本 ⇒ status = `no_samples`（调用方据此**不发** `task.estimated`，只记日志）');
const te1 = readEst(dbB, 'est-none');
ok(te1 !== undefined, 'B-3 **计数器正面断言**：`task_estimate` 由"无此键"变为"有此键"（0 → 1；从前这里什么都不写）');
ok(te1?.basedOn === 0 && te1?.tokens === 0 && te1?.steps === 0, 'B-4 痕的形状：`{tokens:0, steps:0, basedOn:0}`（值取 0 = "没估"，不冒充"估了个 0"）', JSON.stringify(te1));
eq(te1?.note, NO_SAMPLE_ESTIMATE_NOTE, 'B-5 文案取自唯一真源 `NO_SAMPLE_ESTIMATE_NOTE`（判据与界面读同一句，不各写各的）');
eq(hasUsableTaskEstimate(readCtx(dbB, 'est-none')), false, 'B-6 空痕**不算**"已有估时"（否则一次性任务被这条痕永久挡住重估：把"静默"换成"钉死"）');

// ── B-7 空痕之后补上样本 ⇒ 真估跑得起来（空痕不是终态） ──
addTask(dbB, 'src-1', { tokens_used: 1000, execution_metrics: { stepsUsed: 10 } });
const b2 = estimateTaskBudget(dbB as never, { taskId: 'est-none', similar: [{ id: 'src-1', similarity: 0.5 }] });
ok(b2.status === 'estimated' && b2.basedOn === 1 && b2.tokens === 1000 && b2.steps === 10,
  'B-7 空痕 ⇒ 补样本后重估成功（`basedOn` 1、值与唯一有效样本同值）', JSON.stringify(b2));

// ── B-8/B-9 已有真估 ⇒ 整段跳过，且**一个字节都不重写**（治"跨恢复 emit 6 次"） ──
const dbB2 = makeDb();
addTask(dbB2, 'resume'); addTask(dbB2, 'src-2', { tokens_used: 2000, execution_metrics: { stepsUsed: 20 } });
const run1 = estimateTaskBudget(dbB2 as never, { taskId: 'resume', similar: [{ id: 'src-2', similarity: 0.8 }] });
const after1 = JSON.stringify(readCtx(dbB2, 'resume'));
const run2 = estimateTaskBudget(dbB2 as never, { taskId: 'resume', similar: [{ id: 'src-2', similarity: 0.8 }] });
const after2 = JSON.stringify(readCtx(dbB2, 'resume'));
const run3 = estimateTaskBudget(dbB2 as never, { taskId: 'resume', similar: [{ id: 'src-2', similarity: 0.8 }] });
const runs = [run1, run2, run3];
eq(runs.filter((r) => r.status === 'estimated').length, 1,
  'B-8 跨三次恢复（同任务、同样本）⇒ 发射条件 `estimated` **恰 1 次**（方案 §M9-b 的"6 → 1"；从前无守卫 = 3 次全发）');
ok(run2.status === 'skipped_existing' && run3.status === 'skipped_existing' && run1.basedOn === 1,
  'B-9 第 2/3 次判为 `skipped_existing`（并如实带出已有 `basedOn`）', runs.map((r) => r.status).join(' → '));
eq(after2, after1, 'B-10 跳过时 `context_json` **逐字节不变**（不只是"没 emit"——连写都没写）');

// ── B-11 样本过滤未动：`tokens<=0 || steps<=0` 的样本仍被跳过（不拿 0 去平均出"估 0 步"） ──
const dbB3 = makeDb();
addTask(dbB3, 'est-zero');
addTask(dbB3, 'src-zero', { tokens_used: 0, execution_metrics: { stepsUsed: 12 } });
addTask(dbB3, 'src-nosteps', { tokens_used: 5000 });
const bz = estimateTaskBudget(dbB3 as never, { taskId: 'est-zero', similar: [{ id: 'src-zero', similarity: 0.9 }, { id: 'src-nosteps', similarity: 0.9 }] });
eq(bz.status, 'no_samples', 'B-11 两条坏样本（tokens=0 / 无 stepsUsed）⇒ 仍落"无可用样本"（过滤条件一字未动）');

// ── B-12 权重公式未动：加权平均 = round(Σ值·相似度 / Σ相似度)，手算一组可验的数 ──
const dbB4 = makeDb();
addTask(dbB4, 'est-w');
addTask(dbB4, 'w1', { tokens_used: 1000, execution_metrics: { stepsUsed: 10 } });
addTask(dbB4, 'w2', { tokens_used: 2000, execution_metrics: { stepsUsed: 30 } });
const bw = estimateTaskBudget(dbB4 as never, { taskId: 'est-w', similar: [{ id: 'w1', similarity: 0.5 }, { id: 'w2', similarity: 0.25 }] });
ok(bw.tokens === 1333 && bw.steps === 17 && bw.basedOn === 2,
  'B-12 权重公式一字未动：(1000×0.5 + 2000×0.25)/0.75 = 1333、(10×0.5 + 30×0.25)/0.75 = 17、basedOn 2',
  `${bw.tokens} tokens / ${bw.steps} 步 / basedOn ${bw.basedOn}`);

// ── B-13 写痕只动一个键 ──
const dbB5 = makeDb();
addTask(dbB5, 'est-keep', { budget_warn_band: 2, acceptance_check: { checked_at: '2026-01-01T00:00:00Z' } });
estimateTaskBudget(dbB5 as never, { taskId: 'est-keep', similar: [] });
const c5 = readCtx(dbB5, 'est-keep');
ok(c5.budget_warn_band === 2 && !!c5.acceptance_check && !!c5.task_estimate,
  'B-13 写痕是"读改写、只动 `task_estimate`"。同期的预算档/验收账原样在场（不许顺手抹了别人的键）',
  Object.keys(c5).join(','));

// ── B-14 留痕不改口径：`steps:0` 与"压根没估时"在步数预算上同值 ──
const emptySteps = Number(te1?.steps) || 0;
eq(resolveMaxSteps(20, 1.5, emptySteps), resolveMaxSteps(20, 1.5, 0),
  'B-14 空痕的 `steps` 喂进 `resolveMaxSteps` 与"无估时"**同值**（留痕只是留痕，不改预算）');
eq(resolveMaxSteps(20, 1.5, 0), 30, 'B-15 该同值即基础预算态 max(round(20×1.5), 0) = 30（方案 §1.14 表里子任务那格）');

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【C】M9-c 界面：两个新概念上屏 + 只显示不拦截（源码级；本轮不跑 renderer 构建）');
const detailSrc = fs.readFileSync(path.join(RENDERER, 'pages/TaskDetailPage.tsx'), 'utf-8');
const lineWith = (s: string): string => detailSrc.split('\n').find((l) => l.includes(s)) ?? '';

ok(detailSrc.includes('完成来源：'), 'C-1 「完成来源」在场（`completion_quality.via` 从前**零消费面**）');
const viaAt = detailSrc.indexOf('const COMPLETION_VIA_NOTE');
const viaSlice = detailSrc.slice(viaAt, detailSrc.indexOf('const completionVia', viaAt));
ok(viaAt > 0 && viaSlice.length > 0, 'C-2 注解表切片非空（切块锚点在源码里成立，否则下面两条是"扫了个空"的假绿）', `${viaSlice.length} 字节`);
for (const v of ['finalize_task:', 'run_close:', 'update_task_status:']) {
  ok(viaSlice.includes(v), `C-3 来源取值 \`${v.slice(0, -1)}\` 有中文注解`);
}
ok(/finalize_task:[^\n]*收口方自评/.test(viaSlice) && /finalize_task:[^\n]*未经引擎六维评估/.test(viaSlice),
  'C-4 `finalize_task` 那句点明"收口方自评 / 未经引擎六维评估"（95 与 45 不可比的成因，用户看得见）');
ok(/COMPLETION_VIA_NOTE\[completionVia\]\s*\?\?/.test(detailSrc) && detailSrc.includes("completionVia.split(':')"),
  'C-5 注解表**不当白名单**：未认得的取值（含 `update_task_status:no_output` 这种带后缀形）照显机器名，不留白、不误标');

ok(detailSrc.includes('milestones_without_child_tasks?: unknown'), 'C-6 里程碑缺口从 **ctx 原键**读（不解析 `finalize_checks` 的文案）');
const warnLine = lineWith('milestonesWithoutChildTasks.length > 0');
ok(warnLine.length > 0, 'C-7 WARN 渲染行切片非空（同上：锚点在源码里成立）');
ok(warnLine.includes('⚠️') && warnLine.includes('个里程碑尚无对应子任务') && warnLine.includes('{milestonesWithoutChildTasks.length}'),
  'C-8 升格文案：`⚠️ N 个里程碑尚无对应子任务`（带**条数**，不再只沉在 finalize_checks 里）');
ok(warnLine.includes('只报不拦'), 'C-9 文案自己说清口径："只报不拦，不影响完成判定"');
ok(!/onClick|ipcRenderer|\.invoke\(|setStatus|updateTaskStatus|api\./.test(warnLine),
  'C-10 **只显示不拦截**：该提示行内无任何写操作/IPC 调用（V-8 裁定 (a)：本项不动完成判定）');
ok(detailSrc.includes('未估时：') && detailSrc.includes('本任务的步数预算按基础值计'),
  'C-11 无样本留痕上屏：`未估时：<原因>（本任务的步数预算按基础值计）`');
ok(/Number\(te\.basedOn\) === 0/.test(detailSrc) && detailSrc.includes("typeof te.note === 'string'"),
  'C-12 「未估时」只在 `basedOn === 0` 且有 note 时显示（与真估徽标互斥：那边要求 `te.basedOn` 为真）');

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【S】build 钉（派生核对，不写轮次字面量）');
checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

try { fs.rmSync(wdir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响断言 */ }

console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260924_1_b9: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
