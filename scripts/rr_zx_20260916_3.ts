/**
 * zx_20260916_3 受控复跑 —— 「判据要认得事物此刻的样子，不是它名字或旧账的样子」。
 *
 * 四条病根共享同一个形状（见 `plans/improve/zx_20260916_3.md` §一）：判据读的是「它曾经是什么」或
 * 「它名字像什么」，而不是「它此刻是什么」。本脚本按方案 §二 的 A/B/C/D 四组判据逐条落断言，
 * **按符号切区间**（不按行号——行号是位置会漂，承 `feedback_assertion_no_forward_literals`）。
 *
 * 本文件随批次**增量扩写**：M1 落【A】与【C-1/2】（槽位尺与深度尺）；
 * M2 追加【B】（探针尺）；M3 追加【C-3】（完成账尺）；M4 追加【D】（账本新鲜度）；
 * 另含两条标本的**只读**回放（`5126b303` / `3b6e2263`）。M5 追加【E】（O-F 代拟消息 / O-H 配额一本账）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §A 判据 A（**行为**·槽位尺）：按"在途"计数，且拒绝时给得出路
 *   A-1 父 + 5 个**已终态**子 ⇒ 放行（槽位早已空出）。**跑真实现** `childBreadthRefusal`，不在脚本里复刻判据。
 *   A-2 父 + 5 个**在途**子 ⇒ 拒绝。含边界正面断言：4 个在途**必须放行**（否则"恒拒"也能骗过 A-1/A-2）。
 *   A-3 拒绝文本**必须**含一条**当下可执行**的出路，且**不得**再是旧的空话「请合并或直接完成」。
 *   A-4 槽位满时 `buildDeviationContextBlock` **正面断言**返回非空且含槽位事实
 *       （**不是**"不抛异常"）；配两条**阴性对照**（空入参 / 槽位未满 ⇒ 必须为空串），防它变成恒真。
 *   A-5 **反证（判据非空转）**：旧 `COUNT(*)`（不筛 status）在同夹具下**必须**判满——证明新判据确实改了行为。
 *
 * §A-wire 接线在册：D1 裁定"全覆盖"——逐落点断言它确实接了**同一个**判据（按符号切块 + 在场断言）。
 *
 * §C-1/C-2 判据 C 的静态部分：广度/深度各自只有一处真源。
 * §C-3 判据 C 的静态部分：**完成账只有一个构造点**（扫描面=整个 `src/main`，非单个文件）+
 *   构造器/判据的行为断言 + `5126b303` 标本的**只读**回放（存量不回填）。
 *   ⚠ 断言**不写"只为本轮为真"的字面量**：不比对具体轮次值，只做方向性比较（`>=`/存在性）。
 *
 * §D 判据 D（M4·账本新鲜度）：验收在任何**读完成分的闸**之前跑完并落账，完成分随后**重算**。
 *   D-1 顺序（按符号取位置）：两道产出闸（含其提前 `return`）→ 验收落账 → 完成分重算 → 过早结束闸 → promote。
 *   D-2 单一读点：终态判据与事件载荷读**同一份** `closeAccNow`；终态分支**不重跑**验收。
 *   D-3 行为：账换一份（failed→passed）后完成分**重新算出真值**（跑真函数 `assessCompletionQuality`），
 *       并证明 `capScoreByAcceptanceVerdict` **不可逆推** ⇒ 只能重算、不能"加回 45"。
 *   D-4 标本 `3b6e2263`：账上 `{score:45}` + 成因含「验收未通过」而 `acceptance_check` 3/3 全过
 *       ——**矛盾检测器**须判红；用新尺重算后该矛盾消失；真库旁证**未被回填**（只读）。
 *   D-5 同病根的第二处落点：`output_validations` 的落库在 `contentUnfulfilled` 分支**之外**
 *       （验收的 `[内容校验]` 取证只从库里读 ⇒ 不落库即"读旧账"）。
 *
 * §E M5（如实性小批）：
 *   E-1 **O-F 代拟消息可辨识**——判据按**首标**（`turn-authorship.isEngineDraftedTurn`），不按 `role`：
 *       ① 正面"0 变 1"（无首标引擎指令 ⇒ 打标后判为代拟）；② 幂等（不叠标）；③ **真人发言一律不判代拟**
 *       （把人的话标成引擎的是另一种不实）；④ 词表非空话（每个首标在 `src/main` 各有生产点，扫描面=整个 src/main）；
 *       ⑤ **可达性不回归**（落库 role 仍是 `'user'`、回放跳过集合不含该首标 ⇒ 反馈送得到执行体）；
 *       ⑥ renderer 第二落点用**同一个真源**且**不含第二份词表**。
 *   E-2 **O-H 配额一本账**（D4）——`bash`/`execute_command` 引用**同一个配额对象**与同一个 `quotaKey`：
 *       ① 账本行为（"0 变 1" + 两把工具落同一计数器）；② 软告警**恰一次**、**跨线仍响**（旧 `count === soft`
 *       的"只认恰好那一刻"已无残留）；③ 硬线边界（`hard-1` 不禁、`hard` 禁）、到线**不再补软告警**；
 *       ④ `quotaKeyPeers` 一并禁用同账工具；⑤ **代价③**：混着花合计只到 `hard`（旧两本账口径下同一序列不停，
 *       附反证 ⇒ 判据非空转）。阈值一律由真配额对象派生，不写 12/20。
 *
 * ⚠ 夹具（内存库）只建本脚本真正查询的列：`wa_tasks` 在本路径上**无触发器**，故不存在
 *   "先插数据后建触发器"那类假绿（承 `feedback_rr_fixture_production_order`）——此处如实说明，
 *   不假称已按生产顺序搭。
 * ⚠ 本文件**不打开真库**，不改变任何生产行为。
 * ⚠ 末尾的 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**（P6 取产物内 build 值本身）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { engineSrcFiles } from './lib/rr-engine-src.js';
import {
  MAX_CHILD_BREADTH, MAX_TASK_DEPTH, countActiveChildren, childBreadthRefusal,
  goalDeviationCapReached, GOAL_DEVIATION_MAX_RESTARTS,
} from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import {
  buildCompletionAccount, goalAchievedOf, GOAL_ACHIEVED_MIN_SCORE,
} from '../apps/worker-ant-desktop/src/main/core/task-outcome.js';
import {
  buildDeviationContextBlock, assessCompletionQuality, realOutputEvidence,
} from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import {
  docNotProbe, selectProbeDeliverables, disposeProbeDeliverables, readAcceptanceCheck,
} from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import {
  acceptanceVerdictOf, capScoreByAcceptanceVerdict, toAcceptanceSummary, ACCEPTANCE_FAILED_SCORE_CAP,
} from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';
import {
  ENGINE_TURN_TAGS, ENGINE_DRAFTED_TAG, isEngineDraftedTurn, markEngineDrafted,
} from '../apps/worker-ant-desktop/src/main/core/turn-authorship.js';
import {
  toolRegistry, ExploreQuotaLedger, SHELL_EXPLORE_QUOTA, SHELL_EXPLORE_QUOTA_KEY,
} from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const RD = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
const strip = (s: string) => stripKeepingLines(s).join('\n');

// ── 符号切块（**不按行号**）────────────────────────────────────────────────
/** 从 `startRe` 命中的行起，切到其后首个 `endRe` 命中的行（不含）。找不到任一锚点则返回 ''（由在场断言判红）。 */
function between(src: string, startRe: RegExp, endRe: RegExp): string {
  const lines = src.split('\n');
  const s = lines.findIndex((l) => startRe.test(l));
  if (s < 0) return '';
  let e = lines.length;
  for (let i = s + 1; i < lines.length; i++) if (endRe.test(lines[i]!)) { e = i; break; }
  return lines.slice(s, e).join('\n');
}
/** 递归收集 `dir` 下全部 `.ts`（C-3 的扫描面：**整个 src/main**，不是只扫 agent-executor——只扫一个文件，
 *  断言名"构造点只有一处"就会冒充一个它并未覆盖的面）。 */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 工具对象块：`    <name>: {` 起，到下一个同缩进（4 空格）的键或工具表收尾括号止。 */
const TOOL_KEY = /^    [A-Za-z_][A-Za-z0-9_]*: \{$/;
const TOOLS_TABLE_END = /^  \};$/;
function toolBlock(src: string, tool: string): string {
  const lines = src.split('\n');
  const s = lines.findIndex((l) => l === `    ${tool}: {`);
  if (s < 0) return '';
  let e = lines.length;
  for (let i = s + 1; i < lines.length; i++) {
    if (TOOL_KEY.test(lines[i]!) || TOOLS_TABLE_END.test(lines[i]!)) { e = i; break; }
  }
  return lines.slice(s, e).join('\n');
}

// ── 夹具：内存库 wa_tasks（只建本路径真正查询的列）────────────────────────
const CHILD_STATUSES = ['pending', 'executing', 'paused', 'completed', 'failed', 'archived'] as const;
type ChildStatus = typeof CHILD_STATUSES[number];

function fixture(): InstanceType<typeof DatabaseSync> {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      parent_task_id TEXT
    );
  `);
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?, ?, ?, ?)')
    .run('P', 'proj', '父任务', 'executing');
  return db;
}
/** 给父任务 `parentId` 挂 `statuses.length` 个子任务（id 形如 `P#<n>`，便于报告里认人）。 */
function addChildren(db: InstanceType<typeof DatabaseSync>, parentId: string, statuses: ChildStatus[]): string[] {
  const ids: string[] = [];
  statuses.forEach((st, i) => {
    const id = `${parentId}#${i}`;
    db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'proj', `子${i}(${st})`, st, parentId);
    ids.push(id);
  });
  return ids;
}
/** `father` 是 `father` 的父任务（夹具自检用）。 */
const childrenOf = (db: InstanceType<typeof DatabaseSync>, p: string): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM wa_tasks WHERE parent_task_id = ?').get(p) as { c: number }).c;

function main(): void {
  const accPath = `${A}/src/main/core/task-accounting.ts`;
  // zx_20260921 M8 就地订正：`executeTask` 按职责拆出 `core/exec-*.ts`（认领/选型/预算/上下文/收口）。
  //   **收口段**整段搬进 `core/exec-finalize.ts` ⇒ 凡"按符号切块/取位置"的判据（C-3 的 `failed` 分支、
  //   B-4 的 `unfinishedAtClose → promote` 区间、D-1 的 `prematureEnd → promote` 次序）都必须跨文件取源，
  //   否则锚点缺席、切出空块，断言报成"某功能没接线"（读起来像真回归，实为扫描面没跟着走——
  //   zx_20260920_1 M1 工具搬迁时同一课的 26 条假红）。扫描面**一处真源**在 `lib/rr-engine-src.ts`：
  //   `执行体 ∪ exec-*.ts ∪ tools/*.ts`，执行体在前 ⇒ 落点回迁亦无需再改本脚本。
  //   ⚠ **只放宽扫描面、不放宽判据**：本脚本全部判据一字未改；扫描面变宽方向上只许**更严**
  //     （若干"全文无 X"由只扫执行体变为横跨三者，任一段有 X 即红——若因此转红，按真回归处理）。
  //   ⚠ 段序保住"执行体在最前"这一条（落点回迁时优先命中执行体那份，不跨文件误配）。
  //   zx_20260929 M9 就地订正：`executeTask` 的**收尾段**（`closeAccNow` / `prematureEnd` / 两个完成账
  //     落账点所在的那一整段）又外移到了 `core/exec-close.ts`，且**外移时缩短了一层缩进**
  //     （函数体不再嵌在 `executeTask` 的 `try` 里）。原先那三个**按 4 空格缩进钉死**的切块锚点
  //     （`^    const closeAccNow` / `^    const prematureEnd` / `^    let qualityScore` …）随之**切空**，
  //     断言如实报 `(未切到块)`——读起来像"功能没接线"，实为锚点钉住了**缩进**这个与判据无关的形状。
  //     ⇒ 一律改为 `^ *`（**缩进不敏感**，仍在行首钉符号）。这是按 `feedback_anchor_by_symbol`
  //     那条纪律（锚点按符号不按位置）收口，**判据一字未放宽**：块长/块内串的断言原样保留。
  const exeSrc = engineSrcFiles().map((p) => strip(RD(p))).join('\n');
  const accSrc = strip(RD(accPath));

  // zx_20260920_1 M1 就地订正：工具实现已**机械搬迁**到 `core/tools/*.ts`（`agent-executor.ts` 只留装配点）。
  // 按符号切块的扫描面须同步跟进——否则 `toolBlock` 在旧落点找不到块、返回空串，断言却报成"缺判据"
  // （本轮实测：本脚本 26 条 + `rr_zx_20260917` 12 条假红，全部形如 `闸@-1 / INSERT@-1`）。
  // 真源仍是同一批 `    <tool>: {` 字面块，只是落点由单文件变成「执行体 ∪ 工具模块」的并集；
  // 执行体在前 ⇒ 若某工具将来搬回执行体，仍优先取执行体那份，无需再改本脚本。
  // `exeSrc` 已是并集（含工具模块）⇒ 不必再拼一次工具段；`toolBlock` 取首个 `    <tool>: {` 块，
  //   并集末段就是工具模块，命中与从前同一份文本。
  const blockSrc = exeSrc;
  // zx_20261003 M8 就地改钉：`finalize_task` 的执行体已由 `tools/control.ts` 机械搬迁至
  //   `tools/control-finalize.ts`（导出 `runFinalizeTask`）。按 `    finalize_task: {` 切出的块
  //   如今只剩一句委托（`return runFinalizeTask(deps, args);`）⇒ 凡"finalize 出口内含 X"的判据
  //   须跨文件取源：**委托块（control.ts，含 `execute:` 那一跳） ∪ 搬迁体（control-finalize.ts 整份函数）**。
  //   扫描面变宽只许更严：两段任一含 X 即红；判据阈值/文串一字未改（改钉更强的新真源，非放宽）。
  const finalizeBodySrc = strip(RD(`${A}/src/main/core/tools/control-finalize.ts`));
  const finalizeBlk = `${toolBlock(blockSrc, 'finalize_task')}\n${finalizeBodySrc}`;

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【A】判据 A（行为·槽位尺）：按"在途"计数，且拒绝时给得出路');

  // ── A-1 父 + 5 个**已终态**子 ⇒ 必须放行（槽位早已空出）─────────────────
  {
    const db = fixture();
    addChildren(db, 'P', ['completed', 'completed', 'failed', 'archived', 'completed']);
    ok(childrenOf(db, 'P') === MAX_CHILD_BREADTH,
      'A-1 夹具就位：父任务确已挂满上限个子任务（防"夹具其实是空的"式假绿）',
      `${childrenOf(db, 'P')} 个 / 上限 ${MAX_CHILD_BREADTH}`);
    const active = countActiveChildren(db, 'P');
    ok(active === 0, 'A-1 ★ 5 个**已终态**子 ⇒ 在途计数为 0（干完的活不再占位——本轮的正题）', `在途 ${active}`);
    const refusal = childBreadthRefusal(db, 'P');
    ok(refusal === null, 'A-1 ★ 父 + 5 个已终态子 ⇒ `create_task` **放行**（槽位已空出；旧尺此处恒拒）',
      String(refusal));
  }

  // ── A-2 父 + 5 个**在途**子 ⇒ 必须拒绝；4 个在途必须放行（边界正面断言）──
  {
    const db = fixture();
    addChildren(db, 'P', ['pending', 'executing', 'paused', 'pending', 'executing']);
    const active = countActiveChildren(db, 'P');
    ok(active === MAX_CHILD_BREADTH, 'A-2 夹具就位：5 个**在途**子全部计入', `在途 ${active}`);
    const refusal = childBreadthRefusal(db, 'P');
    ok(typeof refusal === 'string' && refusal.length > 0,
      'A-2 ★ 父 + 5 个在途子 ⇒ 拒绝（在途的位子确实还占着）', (refusal ?? '').slice(0, 60));
    // 边界正面断言：少一个就必须放行——否则"恒拒"也能同时骗过 A-1 与 A-2
    db.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = ?").run('P#0');
    ok(countActiveChildren(db, 'P') === MAX_CHILD_BREADTH - 1 && childBreadthRefusal(db, 'P') === null,
      'A-2 ★ 边界：在途 4 个（< 上限）**必须放行** —— 证明本判据真的在数，而不是恒拒',
      `在途 ${countActiveChildren(db, 'P')}`);
    // 反向：加回一个在途 ⇒ 又满 ⇒ 又拒（"放行↔拒绝"随在途数真的翻转，不是一次性状态）
    db.prepare("UPDATE wa_tasks SET status = 'executing' WHERE id = ?").run('P#0');
    ok(childBreadthRefusal(db, 'P') !== null, 'A-2 ★ 再置回在途 ⇒ 立刻又拒（判据跟着"此刻"走，非缓存/非一次性）');
  }

  // ── A-3 拒绝文本必须含"当下可执行"的出路 ────────────────────────────────
  {
    const db = fixture();
    addChildren(db, 'P', ['pending', 'pending', 'pending', 'pending', 'pending']);
    const refusal = childBreadthRefusal(db, 'P') ?? '';
    // 每条出路都必须是**此刻**真能调的工具名（不是"请合并或直接完成"这种与闸无关的空话）
    for (const route of ['send_message', 'finalize_task']) {
      ok(refusal.includes(route), `A-3 拒绝文本含当下可执行出路：\`${route}\``, route);
    }
    ok(refusal.includes('不占位'),
      'A-3 文本说明"已终态不占位"这一事实（否则读者会把"槽位其实空着"误读成"满"）');
    ok(!refusal.includes('请合并或直接完成'),
      'A-3 ★ 旧文案「请合并或直接完成」已退场（毛选·惩前毖后治病救人：纠偏须在当前约束下可执行）');
    ok(!/\d+\s*个\s*$/.test(refusal) && /上限 \d+/.test(refusal),
      'A-3 拒绝文本把实际读数与上限分开如实报（不把"已有 N 个"糊成一句）', refusal.slice(0, 36));
  }

  // ── A-4 槽位满时 `buildDeviationContextBlock` 正面断言非空且含槽位事实 ──
  {
    ok(buildDeviationContextBlock({}) === '',
      'A-4 阴性对照①：空入参 ⇒ 返回空串（判定器行为与从前一字不差）');
    ok(buildDeviationContextBlock({ child_slots: { active: 1, max: MAX_CHILD_BREADTH } }) === '',
      'A-4 阴性对照②：槽位**未满** ⇒ 不注入任何事实（只有满时才说）');
    const blk = buildDeviationContextBlock({ child_slots: { active: MAX_CHILD_BREADTH, max: MAX_CHILD_BREADTH } });
    ok(blk.length > 0 && blk.includes('槽位'),
      'A-4 ★ 槽位满 ⇒ **正面断言**返回非空且含槽位事实（不是"不抛异常"）', blk);
    ok(blk.includes(`${MAX_CHILD_BREADTH}/${MAX_CHILD_BREADTH}`),
      'A-4 ★ 事实块里是**实际读数/上限**（读数由调用方查库注入，非函数内自算）', blk);
    ok(blk.includes('引擎约束'),
      'A-4 ★ 明说"是引擎拦的，不是执行体跑偏"——这是 D1 全覆盖后不误报偏离的**前提**');
    // 与既有事实来源**并存**（不是替换）：两类事实同处一句
    const both = buildDeviationContextBlock({
      child_slots: { active: MAX_CHILD_BREADTH, max: MAX_CHILD_BREADTH },
      deliverable_unfulfilled: { paths: ['/a/b/patch_x.py'] },
    });
    ok(both.includes('patch_x.py') && both.includes('槽位'),
      'A-4 槽位事实与既有事实来源**并存**（只补事实、不替换：zx_20260911_1 M3 的路径一字未动）', both);
  }

  // ── A-5 反证：旧 `COUNT(*)`（不筛 status）在同夹具下必须判满 ──────────────
  {
    const db = fixture();
    addChildren(db, 'P', ['completed', 'completed', 'failed', 'archived', 'completed']);
    const legacy = (db.prepare('SELECT COUNT(*) AS c FROM wa_tasks WHERE parent_task_id = ?').get('P') as { c: number }).c;
    ok(legacy >= MAX_CHILD_BREADTH,
      'A-5 ★ 反证：旧 `COUNT(*)`（不筛 status）在同一夹具下**判满** —— 证明新判据确实改了行为（非空转）',
      `旧尺 ${legacy} / 新尺 ${countActiveChildren(db, 'P')}`);
    ok(countActiveChildren(db, 'P') === 0 && childBreadthRefusal(db, 'P') === null,
      'A-5 ★ 同一夹具、同一时刻：新尺放行 —— 两把尺给出**相反**的结论（这就是本轮修的那件事）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【A-wire】接线在册（D1 全覆盖）：逐落点断言它确实接了**同一个**判据');
  {
    // 判据本体确实来自 task-accounting（不是各处自写 SQL）
    ok(accSrc.includes("status NOT IN ('completed','failed','archived')") && accSrc.includes('export function countActiveChildren('),
      'W-0 真源在册：`task-accounting.ts` 是在途计数的唯一定义处（含 status 筛选）');
    ok(exeSrc.includes('childBreadthRefusal') && exeSrc.includes('countActiveChildren'),
      'W-0 `agent-executor.ts` 经 import 使用真源（而非在本地重写一份）');

    // 逐落点：工具块内必须出现同一个判据调用（配在场断言，防"空块假绿"）
    const WIRE: Array<{ tool: string; marker: string }> = [
      { tool: 'create_task', marker: 'INSERT INTO wa_tasks' },
      { tool: 'spawn_subagent', marker: '[Sub] ' },
      { tool: 'spawn_debate', marker: 'INSERT INTO wa_tasks' },
      { tool: 'recruit_swarm', marker: 'INSERT INTO wa_tasks' },
    ];
    for (const { tool, marker } of WIRE) {
      const blk = toolBlock(blockSrc, tool);
      const present = blk.length > 0 && blk.includes('execute:') && blk.includes(marker);
      ok(present, `W-在场：\`${tool}\` 块已按符号切出且含真调用标记（防"空块假绿"）`,
        `${blk.split('\n').length} 行 / ${marker}`);
      ok(present && blk.includes('childBreadthRefusal('),
        `W-1 \`${tool}\` 已接广度闸（D1 全覆盖：凡让任务树变宽的落点，同一判据）`);
    }
    // 有闸还不够——闸必须**在 INSERT 之前**（放行后才许建行；顺序颠倒则"拒了也已建出孤儿行"）。
    // ⚠ 只从 `execute:` 起算：工具的 `description` 是自然语言，可能先于代码提到判据名（按整块取 indexOf 会被它骗过）。
    for (const tool of ['create_task', 'spawn_subagent']) {
      const blk = toolBlock(blockSrc, tool);
      const body = blk.slice(blk.indexOf('execute:'));
      const gateAt = body.indexOf('childBreadthRefusal(');
      const insAt = body.indexOf('INSERT INTO wa_tasks');
      ok(body.length > 0 && gateAt > 0 && insAt > gateAt,
        `W-2 \`${tool}\` 的闸在 INSERT **之前**（拒绝时不留孤儿行）`, `闸@${gateAt} / INSERT@${insAt}`);
    }

    // 引擎自发补救三条（核实下钻 / 辩论 / swarm）：闸在**生成 id 之前**，拒绝时如实上报
    const drill = between(blockSrc, /const fixRefusal = childBreadthRefusal\(/, /^                }/);
    ok(drill.length > 0 && drill.includes('引擎未自动创建修复任务'),
      'W-3 finalize 自动下钻：槽位满时**如实上报**"发现问题但未自动建任务"，而非静默突破或静默放弃',
      `${drill.split('\n').length} 行`);
    for (const tool of ['spawn_debate', 'recruit_swarm']) {
      const blk = toolBlock(blockSrc, tool);
      const gateAt = blk.indexOf('childBreadthRefusal(');
      const idAt = blk.indexOf('crypto.randomUUID()');
      ok(gateAt > 0 && (idAt < 0 || gateAt < idAt),
        `W-4 \`${tool}\` 的闸在**生成 childId 之前**（否则"已入 childIds 索引却未创建"会让后续子任务的 dependsOn 指向空 id）`,
        `闸@${gateAt} / uuid@${idAt}`);
      ok(blk.includes('skipped') && blk.includes('skippedReason'),
        `W-4 \`${tool}\` 拒绝时**如实回话**（列出未创建者与原因，不静默少建）`);
    }

    // IPC / IM 建任务（**人的动作**同受此闸）
    const ipcSrc = strip(RD(`${A}/src/main/ipc/project.ipc.ts`));
    const imSrc = strip(RD(`${A}/src/main/services/im-router.ts`));
    ok(ipcSrc.includes('childBreadthRefusal('), 'W-5 IPC 建任务已接同一判据（`project.ipc.ts`）');
    // zx_20260929 M5-c 就地订正（改钉更强真源，非放宽）：原判据 `imSrc.includes('childBreadthRefusal(')`
    //   只证"这个文件里有这道闸"，而 IM 路当时是**自带副本**（闸/映射/换算各一份）。M5-c 后 IM 路不再自带
    //   落行实现，改调唯一实现 ⇒ 判据换成"**经唯一实现**接上"（引它 + 零自带闸），覆盖面只增不减。
    ok(imSrc.includes('planSubtasksFromTemplate(') && !imSrc.includes('childBreadthRefusal('),
      'W-5 IM LLM 拆解建任务**经唯一实现**接同一判据（`im-router.ts` 调 `planSubtasksFromTemplate`，零自带广度闸）');
    // IPC 的闸同样必须在 INSERT 之前（此前是"先 INSERT 后校验父任务"，拒绝即留孤儿行）
    {
      // 切「handler 开头 → 首个 UUID/INSERT」这一段：父校验与广度闸都必须落在其中
      const blk = between(ipcSrc, /ipcMain\.handle\('task:create'/, /const id = crypto\.randomUUID\(\);/);
      ok(blk.length > 0 && blk.includes('父任务不存在或不属于当前项目') && blk.includes('childBreadthRefusal('),
        'W-5 IPC 父任务存在性与广度闸均在 INSERT **之前**（旧写法先建行后校验 ⇒ 拒绝即留孤儿行）',
        `${blk.split('\n').length} 行`);
      ok(blk.length > 0 && !blk.includes('INSERT INTO wa_tasks'),
        'W-5 ★ 该段内**确实还没有**任何 INSERT（"之前"不是靠注释声称，而是按符号切出的区间里就没有写库语句）');
    }
    {
      // zx_20260929 M5-c 就地订正（改钉更强真源，非放宽）：本判据原钉在 `im-router.ts` 的**自带实现**上
      //   （锚点 `if (childBreadthRefusal(ctx.db, taskId)) break;` + 断言后面有 `resolveIndexDeps`）。
      //   M5-c 后该顺序只剩**一处**可钉——唯一落行实现里那处；钉在它身上同时覆盖引擎路与 IM 路，
      //   比钉在两份副本之一更强（副本时代这条判据只能各自证自己）。
      // zx_20261018_3 批二就地重定向（同一条病根、更硬的形状，非放宽）：原锚点 `for (let i = 0; i < planned; i++)`
      //   与 `childBreadthRefusal(` 在本轮换成了 `creatable` 与 `childBreadthRefusalFor(`；且广度闸从"循环内逐行问"
      //   前移为"先判槽位、再备 id、再映射"。判据按**符号**切出整个 `planSubtasksFromTemplate` 函数体，
      //   断言三段顺序 **闸 → 备 id → 索引映射**——比原先的"闸在映射之前"多钉住"映射用的是真能建出的那批 id"。
      const decoSrc = strip(RD(`${A}/src/main/core/task-decompose.ts`));
      const blk = between(decoSrc, /export function planSubtasksFromTemplate\(/, /^export function droppedDepsNotice\(/);
      const gateAt = blk.indexOf('creatable === 0');
      const allocAt = blk.indexOf('Array.from({ length: creatable }');
      const depAt = blk.indexOf('resolveIndexDeps(');
      ok(blk.length > 0 && gateAt > 0 && allocAt > gateAt && depAt > allocAt,
        'W-6 唯一落行实现里，广度闸先于备 id、备 id 先于 `resolveIndexDeps`'
        + '（否则索引→id 的映射与真实建出的子任务对不上；此顺序一处改、引擎路与 IM 路同时受益）',
        `${blk.split('\n').length} 行 · 闸@${gateAt} / 备id@${allocAt} / 映射@${depAt}`);
    }

    // 纠偏建议两处逐字副本 → 合一（承 feedback_enum_value_sweep_readers：改一句话须穷举全部落点）
    const aSrc = strip(RD(`${A}/src/main/core/jobs/ai-task.ts`));
    const noteDefs = [...aSrc.matchAll(/GOAL_DEVIATION_CONVERGENCE_NOTE/g)].length;
    const noteTexts = [...aSrc.matchAll(/\[目标偏离收敛\]/g)].length;
    ok(noteTexts === 1 && noteDefs >= 3,
      'W-7 `[目标偏离收敛]` 文本只写一处（定义），两处调用点引用同一常量——原为两处逐字副本',
      `定义 1 处 / 引用 ${noteDefs} 处（含定义行）`);
    ok(aSrc.includes('GOAL_DEVIATION_CONVERGENCE_NOTE') && aSrc.includes('MAX_CHILD_BREADTH'),
      'W-7 纠偏文案里的上限**由真源派生**（`MAX_CHILD_BREADTH`），不再手抄"5"');
    const noteLine = aSrc.split('\n').find((l) => l.includes('[目标偏离收敛]')) ?? '';
    ok(!noteLine.includes('用 create_task 按里程碑拆分'),
      'W-7 ★ 旧建议「用 create_task 按里程碑拆分」已退场——那句在闸满时正指向一扇被自己关上的门');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C-1/C-2】判据 C（静态）：广度/深度各只有一处真源');
  {
    // C-1：不得存在第二处对 parent_task_id 做**上限判断**的自写 COUNT(*)
    ok(!/sibCount/.test(exeSrc),
      'C-1 ★ 旧的 `sibCount >= 5` 广度判据已整体退场（`sibCount` 在 `agent-executor.ts` 零命中）');
    ok(!/\b(?:sibCount|childCount)\s*>=\s*(?:\d+|MAX_CHILD_BREADTH)/.test(exeSrc),
      'C-1 ★ 全文无"父任务子计数 ≥ 上限"形式的自写判断（上限判断只经 `childBreadthRefusal`）');
    ok(!/COUNT\(\*\)[^;]*parent_task_id[^;]*\)[^;]*>=\s*5/.test(exeSrc),
      'C-1 ★ 全文无"就地写死 5 的 COUNT(*) 比较"（常量只有 `MAX_CHILD_BREADTH` 一处）');
    const breadthConsts = [...strip(RD(accPath)).matchAll(/MAX_CHILD_BREADTH\s*=\s*(\d+)/g)].map((m) => m[1]);
    ok(breadthConsts.length === 1 && Number(breadthConsts[0]) === MAX_CHILD_BREADTH,
      'C-1 ★ 广度上限常量**只有一处定义**，且脚本读到的值即该处派生（不手抄）',
      `${breadthConsts.join(',') || '(未找到)'} vs ${MAX_CHILD_BREADTH}`);
    // 残留清单：**不作判据**，只如实列给下一轮（免"下一轮字面量"哑雷，也不许静默）
    const residual: string[] = [];
    exeSrc.split('\n').forEach((line, i) => {
      if (/COUNT\(\*\)/.test(line) && /parent_task_id/.test(line)) residual.push(`${i + 1}:${line.trim().slice(0, 88)}`);
    });
    console.log(`  · 其余对 parent_task_id 的 COUNT(*)（非判据，逐条定性见方案 §3.2；均**非上限判断**）${residual.length} 处：`);
    for (const r of residual) console.log(`      ${r}`);

    // C-2：嵌套深度上限只有一处常量，`create_task` 与 `spawn_subagent` 共用
    const depthConsts = [...accSrc.matchAll(/MAX_TASK_DEPTH\s*=\s*(\d+)/g)].map((m) => m[1]);
    ok(depthConsts.length === 1 && Number(depthConsts[0]) === MAX_TASK_DEPTH,
      'C-2 ★ 嵌套深度上限常量**只有一处定义**（原为 `create_task` 的 5 与 `spawn_subagent` 的 2 两把尺）',
      `${depthConsts.join(',') || '(未找到)'} vs ${MAX_TASK_DEPTH}`);
    for (const tool of ['create_task', 'spawn_subagent']) {
      const blk = toolBlock(blockSrc, tool);
      ok(blk.includes('MAX_TASK_DEPTH'),
        `C-2 ★ \`${tool}\` 与另一出口**共用同一常量**（同名同义同值，不再同名两值）`);
      ok(!/childDepth\s*>\s*\d/.test(blk),
        `C-2 ★ \`${tool}\` 内无写死的深度阈值（不得就地写 \`> 2\`/\`> 5\` 绕开真源）`);
    }
    ok(!/childDepth\s*>\s*\d/.test(exeSrc),
      'C-2 ★ 全文无写死的深度阈值');
    // 深度闸在 id 生成之前（与广度闸同序）
    for (const tool of ['create_task', 'spawn_subagent']) {
      const blk = toolBlock(blockSrc, tool);
      const dAt = blk.indexOf('MAX_TASK_DEPTH');
      const idAt = blk.indexOf('crypto.randomUUID()');
      ok(dAt > 0 && (idAt < 0 || dAt < idAt), `C-2 \`${tool}\` 深度闸同样在生成 id 之前`, `闸@${dAt} / uuid@${idAt}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C-3】判据 C（静态·一处真源）：完成账只有一个构造点');
  {
    const MAIN = path.join(root, `${A}/src/main`);
    const files = walkTs(MAIN).map((p) => ({ rel: path.relative(root, p), src: strip(fs.readFileSync(p, 'utf-8')) }));
    // 扫描面 = 整个 src/main（renderer 是第二个落点，但它不写库、不构造账——账只在 main 造）。
    const offenders: string[] = [];
    const writers: string[] = [];
    for (const f of files) {
      f.src.split('\n').forEach((line, i) => {
        if (!/completion_quality\s*=/.test(line)) return;
        writers.push(`${f.rel}:${i + 1}`);
        if (!/completion_quality\s*=\s*buildCompletionAccount\(/.test(line)) offenders.push(`${f.rel}:${i + 1} ${line.trim().slice(0, 90)}`);
      });
    }
    ok(writers.length > 0, `C-3 前置：扫描面（\`src/main\` 全部 .ts，共 ${files.length} 个）里确实存在完成账写入点（否则下面的"零例外"是空话）`, `${writers.length} 处`);
    ok(offenders.length === 0,
      'C-3 ★ `completion_quality` 的**每一处**赋值都是 `buildCompletionAccount(...)`——无第二处手拼对象字面量',
      offenders.length ? `例外 ${offenders.length} 处：\n      ${offenders.join('\n      ')}` : writers.join(', '));
    ok(!/completion_quality\s*=\s*\{/.test(files.map((f) => f.src).join('\n')),
      'C-3 ★ 全 `src/main` 无 `completion_quality = {` 形式（对象字面量只许在构造器内出现一次）');

    // 两个出口各调一次——"同一构造器"须在两个出口**都**在场，否则只是"有一处是它"
    const finBlk = finalizeBlk;
    ok(finBlk.includes('buildCompletionAccount('),
      'C-3 ★ finalize 出口（`finalize_task` 执行块内；M8 就地改钉：体在 control-finalize.ts）经同一构造器造账（原为 `{ score: … }` 单键）');
    // run_close 路自 M4 起有**两个**落账点（初评 + 验收后重算），两处都须走构造器——
    //   只查其一即"断言名冒充覆盖面"（本仓 G9 的老病）。
    //   ⚠ zx_20260929 M9 就地订正：原先靠"**有没有 `let`**"分辨两块（执行体那份是 `let qualityScore = …`，
    //     M4 的重算是裸 `qualityScore = …`）。收尾段外移到 `core/exec-close.ts` 后，重算段**另起一个 `let`**
    //     （不再复用执行体那个变量），该判别式**随外移失效**——照旧钉它，两条断言会切到**同一块**
    //     （初评），"两处都查"就退化成"查了两遍同一处"（断言名冒充覆盖面，正是本仓 G9 的老病）。
    //     ⇒ 改按**各自独有的符号**分锚（行首、缩进不敏感）：初评绑 `const goalAchieved =`（在执行体），
    //       重算绑 `const goalNow =`（在 `exec-close.ts`）。两个锚在并集里各自唯一。
    const firstAcct = between(exeSrc, /^ *const goalAchieved = goalAchievedOf\(goalDefined,/, /UPDATE wa_tasks SET context_json/);
    ok(firstAcct.includes('buildCompletionAccount('),
      'C-3 ★ run_close 出口（初评）经同一构造器造账', firstAcct ? `${firstAcct.split('\n').length} 行` : '(未切到块)');
    const reAcct = between(exeSrc, /^ *const goalNow = goalAchievedOf\(goalDefined,/, /syncQualityColumn\(db, taskId\);/);
    ok(reAcct.includes('buildCompletionAccount(') && reAcct.includes('goalAchievedOf('),
      'C-3 ★ M4 起 run_close 的**第二个**落账点（验收后重算）同样经构造器与同一达成判据',
      reAcct ? `${reAcct.split('\n').length} 行` : '(未切到块)');
    // zx_20260917 M1：切块终点原钉分支内的 `markPauseNeeded(db, taskId`——该动作已随写口收口迁入
    //   `pauseTask`，分支内不再出现（若照旧钉它，`between` 会一路切到**下一个** markPauseNeeded ⇒ 块长上千行，
    //   断言即从"核这个分支"退化成"核半张纸"）。改钉**语义边界**：紧随其后的那条"标完成"写入。
    const failBlk = between(exeSrc, /if \(closeVerdict === 'failed'\) \{/, /UPDATE wa_tasks SET status = 'completed'/);
    ok(failBlk.length > 0 && !/completion_quality\s*=/.test(failBlk),
      'C-3 ★ 验收未通过分支**不写第二版账**（M4 起改由收口前的"重算"一次写完——该分支只置暂停与告知）');
    ok(failBlk.includes('pauseTask(db, { taskId, reason: PAUSE_REASON_ACCEPTANCE_FAILED') && failBlk.includes('closeFailedN'),
      'C-3 ★ 该分支仍如实置暂停并点名未达条数（不许因"账已写好"而静默）');

    // 顶层 `goal_achieved` 只许从账上/判据派生，不许就地写死常量
    const bareGoal: string[] = [];
    for (const f of files) {
      if (f.rel.endsWith('core/task-outcome.ts')) continue; // 两个方向助手（sync/mark）就住这里，是唯一的允许点
      f.src.split('\n').forEach((line, i) => {
        if (/\.goal_achieved\s*=\s*(?:true|false)\s*;/.test(line)) bareGoal.push(`${f.rel}:${i + 1} ${line.trim().slice(0, 90)}`);
      });
    }
    ok(bareGoal.length === 0,
      'C-3 ★ 顶层 `goal_achieved` 无裸字面量赋值（只经 `goalAchievedOf` 派生或 `sync/mark` 两个方向助手）',
      bareGoal.length ? `例外：\n      ${bareGoal.join('\n      ')}` : '');
    ok(!/goal_achieved\s*:\s*[^,{}\n]*[<>]=?\s*\d/.test(files.map((f) => f.src).join('\n')),
      'C-3 ★ 全 `src/main` 无 `goal_achieved: … >= N` 形式的就地判据（阈值只有 `GOAL_ACHIEVED_MIN_SCORE` 一处）');

    // ── 行为：构造器与判据本身（真函数，非复刻）──────────────────────────
    const acct = buildCompletionAccount({ score: 95, goalAchieved: true, via: 'finalize_task', feedback: '自评 excellent' });
    ok(acct.score === 95 && acct.goal_achieved === true && acct.via === 'finalize_task' && acct.feedback === '自评 excellent',
      'C-3 构造器出的账**两键同在**（`score` 与 `goal_achieved` 同处一份——`{score}` 单键正是 O-C 的形状）',
      JSON.stringify(acct));
    const noFb = buildCompletionAccount({ score: 60, goalAchieved: false, via: 'x' });
    ok(!('feedback' in noFb), 'C-3 未附成因时**不写** `feedback` 键（"没这笔账"≠"账上是一句空话"）', JSON.stringify(noFb));
    ok(goalAchievedOf(true, 0, GOAL_ACHIEVED_MIN_SCORE) === true && goalAchievedOf(true, 0, GOAL_ACHIEVED_MIN_SCORE - 1) === false,
      'C-3 `goalAchievedOf` 以 `GOAL_ACHIEVED_MIN_SCORE` 为界，**由常量自身派生**（不手抄 60）',
      `线=${GOAL_ACHIEVED_MIN_SCORE}`);
    ok(goalAchievedOf(false, 99, GOAL_ACHIEVED_MIN_SCORE) === true,
      'C-3 无显式目标时偏离次数不参与判定（否则"没定目标"反而更容易被判未达成）');
    for (const n of [0, 1, GOAL_DEVIATION_MAX_RESTARTS]) {
      ok(goalAchievedOf(true, n, 95) === !goalDeviationCapReached(n),
        `C-3 有目标时偏离判据与 \`goalDeviationCapReached\` **同源**（restarts=${n}）`,
        `goalAchievedOf=${goalAchievedOf(true, n, 95)} / !cap=${!goalDeviationCapReached(n)}`);
    }

    // ── 标本只读回放（承 zx_20260916_1 手法：**只读、不回填真库**）─────────
    // 5126b303（M0 §1.2-③ 标本）：账上 `{score:95}`（无 goal_achieved）+ 顶层 `goal_achieved:false`
    // 而 `task_goal.goal` 有值、`goal_deviation_restarts:0` —— 那份 `false` 出自 `deliverable_unfulfilled`
    // 那道"内容不充分"门禁（note 逐字即"产出内容不充分(充分性校验)"），finalize 收口时既不重算也不改写它。
    // 回放=把那笔**存量**输入喂进**新**判据，看新账尺会怎么写它。
    const SPECIMEN = { id: '5126b303', declaredQuality: 'excellent', topGoalAchieved: false as boolean, accountKeys: ['score'] as string[], restarts: 0, goalDefined: true };
    const specScore = 95;
    const replayGoal = goalAchievedOf(SPECIMEN.goalDefined, SPECIMEN.restarts, specScore);
    const replayAcct = buildCompletionAccount({ score: specScore, goalAchieved: replayGoal, via: 'finalize_task', feedback: `收口方自评 ${SPECIMEN.declaredQuality}（本路按自评分记账，未跑引擎六维评估）` });
    ok(SPECIMEN.topGoalAchieved === false && !SPECIMEN.accountKeys.includes('goal_achieved'),
      'C-3 标本回放·前置：存量形态确为「顶层 false + 账上无 goal_achieved」（两处互不解释——O-C 的形状）');
    ok(replayAcct.goal_achieved === true && replayAcct.goal_achieved === replayGoal && replayAcct.via === 'finalize_task',
      'C-3 ★ 标本回放：新账尺下该任务写为 `goal_achieved:true`，且**顶层须取账上同值**——「95 分 + false」的无解释矛盾就此消失',
      JSON.stringify(replayAcct));

    // 真库只读旁证（有则断言，无则**如实跳过**，不冒充通过）
    let dbNote = '跳过（真库不可得）';
    try {
      const real = new DatabaseSync(path.join(root, 'data/worker-ant-server.db'), { readOnly: true } as never);
      const row = real.prepare("SELECT id, status, quality_score, context_json FROM wa_tasks WHERE id LIKE '5126b303%'").get() as
        { id?: string; status?: string; quality_score?: number; context_json?: string } | undefined;
      real.close();
      if (row?.context_json) {
        const c = JSON.parse(row.context_json) as { completion_quality?: Record<string, unknown>; goal_achieved?: unknown; task_goal?: { goal?: string } };
        ok(c.completion_quality?.score === specScore && !('goal_achieved' in (c.completion_quality ?? {})),
          'C-3 真库旁证：标本账上仍是 `{score}` 单键（存量未被回填——本轮回放**只读**，不动真库）', JSON.stringify(c.completion_quality));
        ok(c.goal_achieved === false && !!c.task_goal?.goal,
          'C-3 真库旁证：标本顶层确为 `false` 而目标确有——`false` 不是"没目标"，是陈旧值');
        dbNote = `已核（${row.id?.slice(0, 8)} / ${row.status} / ${row.quality_score} 分）`;
      }
    } catch { /* 真库被锁/不存在 ⇒ 如实跳过 */ }
    console.log(`  · 真库只读旁证：${dbNote}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【B】判据 B（行为·探针尺）：认角色，不认长相');
  {
    const dlcSrc = strip(RD(`${A}/src/main/core/deliverable-lifecycle.ts`));
    const ruler = docNotProbe('');

    // ── 尺子本身：显式标记三条在、形状 GLOB 删光（数字前缀 GLOB 属已宣告标记，见下方重定向）──
    // zx_20260930 M3-g: 三条显式标记的字面量由 `%/_%kw%` 改为 `%/\_%kw%' ESCAPE '\'`——原式 `_` 是 LIKE
    //   **单字符通配符**，等于按"路径里含该词"判，比"下划线开头的段"宽得多。本断言随之改指新字面量，
    //   并**正面**要求 `ESCAPE` 在场（漏了它 `_` 又退回通配符）。两标本（该命中/该不命中）在 rr_zx_20260930 §C-f。
    ok(ruler.includes("NOT LIKE '%/\\_%verify%' ESCAPE '\\'") && ruler.includes("NOT LIKE '%/\\_%probe%' ESCAPE '\\'") && ruler.includes("NOT LIKE '%/\\_%tmp%' ESCAPE '\\'"),
      'B ★ 显式标记三条仍在（§1.4 认定其成立——不是把尺子一起删了），且 `_` 为字面下划线（`ESCAPE` 在场）', ruler);
    // zx_20261022_1 批二重定向（按符号钉更强的新真源，不是放宽）：探针判据新增**数字前缀**形态
    //   （`0_probe.md` / `00_probe2.md` 这类真库标本）。旧断言「整条 SQL 里没有 GLOB」因此为红——
    //   但它要守的**事实**是「不许按文件名长相推断探针」（`test_<hex>*.py` 那条已被系统性误伤）。故这里
    //   不删不断言，而是把尺子钉成**更强**的形状：GLOB 只允许是「已宣告标记 + 1–2 位数字前缀」这 6 条，
    //   任何以 `test_`/`?`/裸关键词为形态的 GLOB 一律为红。
    const globs = [...ruler.matchAll(/NOT GLOB '([^']+)'/g)].map((m) => m[1]!);
    ok(globs.length === 6
      && globs.every((g) => /^\*\/\[0-9\](?:\[0-9\])?_(?:verify|probe|tmp)\*$/.test(g)),
      'B ★ 形状 GLOB 仍被禁止：留下的 GLOB 只许是「已宣告标记 `_verify/_probe/_tmp` + 1–2 位数字前缀」恰 6 条', globs.join(' / '));
    const clauses = [...ruler.matchAll(/NOT LIKE|NOT GLOB/g)].map((m) => m[0]);
    ok(clauses.length === 9
      && clauses.filter((c) => c === 'NOT LIKE').length === 3
      && clauses.filter((c) => c === 'NOT GLOB').length === 6,
      'B ★ 判据恰 **3 条 NOT LIKE + 6 条数字前缀 NOT GLOB**——"被宣告的标记"仍是唯一事实源',
      clauses.join(' / '));
    ok(!/NOT GLOB '\*test_/.test(dlcSrc) && !/NOT GLOB '[^']*\?/.test(dlcSrc),
      'B ★ 全模块**代码**内再无"按文件名长相"的探针判据（去注释后扫描：无 `test_` 变体、无通配 `?`）');
    // 旧判据的**原形**（= 本轮改动前 `deliverable-lifecycle.ts` 里那一行，逐字）——保留在本脚本里**只作反证**，
    //   不作生产判据。没有这块对照物，就无从证明"新尺确实改了行为"（判据 B-3 的全部意义）。
    const LEGACY_SHAPE_RULE =
      `(COALESCE(file_path, name) NOT LIKE '%/_%verify%' AND COALESCE(file_path, name) NOT LIKE '%/_%probe%'`
      + ` AND COALESCE(file_path, name) NOT LIKE '%/_%tmp%'`
      + ` AND COALESCE(file_path, name) NOT GLOB '*test_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*.py')`;

    // ── 夹具：真文件 + 真目录（文件名逐字取自 §1.2-② 的真库实测）──────────
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rr3-m2-ws-'));
    const qdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr3-m2-quarantine-'));
    try {
      // 7 个 `test_a2026*_m<N>_*.py`——真库实测"被旧 GLOB 系统性全中"的那 7 个（`m1b`/`m2` 两个**未提交**）
      const REAL_TESTS = [
        'test_a20260916_m1_o1_export.py',
        'test_a20260916_m1b_target_pct.py',
        'test_a20260916_m2_daemon_migrate.py',
        'test_a20260916_m3_im_migrate.py',
        'test_a20260916_m4_scheduled_migrate.py',
        'test_a20260916_m5_report_migrate.py',
        'test_a20260916_m6_shadow.py',
      ];
      // 3 个**显式宣告**的临时件（三条前缀各一；`_tmp_probe_e2e2_20260916.py` 是真库唯一的真探针）
      const MARKED = ['_tmp_probe_e2e2_20260916.py', '_f20_probe.py', '_verify_check.py'];
      const REPORT = 'A股智能投资顾问_A_20260916_3_最终验收报告.md';
      const scriptsDir = path.join(ws, 'scripts');
      fs.mkdirSync(scriptsDir, { recursive: true });
      for (const f of [...REAL_TESTS, ...MARKED]) fs.writeFileSync(path.join(scriptsDir, f), '# probe or real?\n');
      fs.writeFileSync(path.join(ws, REPORT), '# 报告\n');

      const db = new DatabaseSync(':memory:');
      db.exec(`CREATE TABLE wa_deliverables (
        id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, name TEXT, type TEXT,
        status TEXT, file_path TEXT, description TEXT, updated_at TEXT);`);
      const ins = db.prepare('INSERT INTO wa_deliverables (id, project_id, task_id, name, type, status, file_path) VALUES (?,?,?,?,?,?,?)');
      REAL_TESTS.forEach((f, i) => ins.run(`real${i}`, 'proj', 'T', f, 'doc', 'draft', path.join(scriptsDir, f)));
      MARKED.forEach((f, i) => ins.run(`marked${i}`, 'proj', 'T', f, 'doc', 'draft', path.join(scriptsDir, f)));
      ins.run('report', 'proj', 'T', REPORT, 'doc', 'draft', path.join(ws, REPORT));
      const idsJudgedProbe = (frag: string): string[] => {
        const rows = db.prepare(`SELECT id FROM wa_deliverables WHERE status != 'retired' AND NOT ${frag}`).all() as Array<{ id: string }>;
        return rows.map((r) => r.id).sort();
      };

      // ── B-1 / B-2：新尺 —— 7 个真测试脚本判**非探针**，恰 3 条显式标记判探针 ──
      // 夹具里**没有 git 这回事**，而 7 个真测试脚本照样放行（其中 `m1b`/`m2` 在 a-stock 侧是**未提交**的）
      //   ⇒ 判据与"文件是否被 git 追踪"无关，§4.1-① 两个备选案（git-first / git∪方案引用）救不回的两例在此必然被救回。
      const now = idsJudgedProbe(ruler);
      ok(now.length === MARKED.length && now.every((id) => id.startsWith('marked')),
        'B-1/B-2 ★ 新尺：7 个真测试脚本 + 报告**全部判非探针**（不看仓库状态），判探针的恰是 3 个显式标记件',
        `探针集 = ${now.join(',') || '(空)'}`);
      ok(now.includes('marked1'),
        'B ★ `_f20_probe.py`（zx_20260913 M2-3 修过的逃逸形态）在新尺下**仍**判探针——删 GLOB 没有把该修的也一起放了');
      // ── B-3 反证：旧形状 GLOB 对该批文件**必须**全判探针（否则新判据只是恒真的空壳）──
      const legacy = idsJudgedProbe(LEGACY_SHAPE_RULE);
      const legacyReal = legacy.filter((id) => id.startsWith('real'));
      ok(legacyReal.length === REAL_TESTS.length,
        'B-3 ★ 反证：旧形状 GLOB 对 7 个真测试脚本**全部**判为探针（系统性全中，不是偶尔误伤）',
        `旧尺判探针 ${legacy.length} 条，其中真测试脚本 ${legacyReal.length}/${REAL_TESTS.length}`);
      ok(legacy.length > now.length && legacy.some((id) => id.startsWith('real') && !now.includes(id)),
        'B-3 ★ 两版判据在同一批文件上给出**不同**答案（旧尺把真测试脚本判探针、新尺放行）——新判据不是旧判据换个写法的空壳',
        `旧 ${legacy.length} 条探针 / 新 ${now.length} 条`);

      // ── B-4 行为：同一把尺 + 真移动（finalize/run_close 两处调用的**是这两个函数**）──
      const probeRows = selectProbeDeliverables(db, 'T');
      ok(probeRows.length === MARKED.length,
        'B-4 ★ `selectProbeDeliverables` 与 SQL 判据**同一把尺**（清单 = 3 个显式标记件，真测试脚本不在内）',
        probeRows.map((r) => path.basename(String(r.file_path))).join('、'));
      const res = disposeProbeDeliverables(db, probeRows, 'retire', qdir);
      const stillThere = (f: string) => fs.existsSync(path.join(scriptsDir, f));
      const movedThere = (f: string) => fs.existsSync(path.join(qdir, f));
      ok(res.retired === MARKED.length && res.moved === MARKED.length && res.alreadyGone === 0 && res.failed.length === 0,
        'B-4 ★ 处置如实计数：3 退休 / 3 移入隔离 / 0 已不在 / 0 失败（**非**"不抛异常"）',
        JSON.stringify({ retired: res.retired, moved: res.moved, alreadyGone: res.alreadyGone, failed: res.failed }));
      ok(MARKED.every((f) => movedThere(f) && !stillThere(f)),
        'B-4 ★ 3 个显式标记件**确已离场**（源目录没了、隔离目录有了）——"退休"第一次真的发生在文件上');
      const reportThere = () => fs.existsSync(path.join(ws, REPORT));
      ok(REAL_TESTS.every((f) => stillThere(f)) && reportThere(),
        'B-1/B-2 ★ 7 个真测试脚本 + 报告**原地未动**（误退休 = 真产出被移走，是不可逆的那个方向）');
      const statusOf = (id: string) => (db.prepare('SELECT status FROM wa_deliverables WHERE id = ?').get(id) as { status: string }).status;
      ok(REAL_TESTS.every((_, i) => statusOf(`real${i}`) === 'draft') && statusOf('report') === 'draft',
        'B-1/B-2 ★ 真测试脚本/报告的登记状态**未被置 retired**（不只在磁盘上放行，账上也没退休）');
      ok(MARKED.every((_, i) => statusOf(`marked${i}`) === 'retired'),
        'B-4 ★ 显式标记件的登记状态置 retired（既有取值，零迁移）');
      const movedPath = db.prepare('SELECT file_path FROM wa_deliverables WHERE id = ?').get('marked0') as { file_path: string };
      ok(movedPath.file_path.startsWith(qdir) && fs.existsSync(movedPath.file_path),
        'B-4 ★ `file_path` 已回写为隔离后的**真实存在**位置（不是"登记说退休、文件还在原地"）', movedPath.file_path);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(qdir, { recursive: true, force: true });
    }

    // ── B-4 接线：两条收口路**都**调处置函数（静态两处调用点，符号切块不按行号）──
    const finBlk = finalizeBlk;
    ok(finBlk.includes('disposeProbeDeliverables(db, probes'),
      'B-4 ★ finalize 收口的处置点在场（`finalize_task` 执行块内；M8 就地改钉：体在 control-finalize.ts）');
    // zx_20261013_2 批二：`unfinishedAtClose` 的 SQL 已收归 `children-gate.ts` 一处真源（`unfinishedChildren`）
    //   ⇒ 锚点由「内联 SQL 字面」改钉**更宽但仍在行首按符号**的 `const unfinishedAtClose =`
    //   （切块区间与判据一字未改，只把"钉住实现细节的字面"换成"钉住符号"；承 `feedback_anchor_by_symbol`）。
    const closeRegion = between(exeSrc,
      /const unfinishedAtClose =/,
      /promoteTaskFileDeliverables\(db, taskId, 'run_close'\)/);
    ok(closeRegion.length > 0 && closeRegion.includes('disposeProbeDeliverables(db, closeProbes'),
      'B-4 ★ run_close 收口**补上同尺处置点**（此前该路完全没有探针处置 = O-E 病根）');
    ok(closeRegion.includes('selectProbeDeliverables(db, taskId)'),
      'B-4 ★ run_close 走**同一把尺**（`selectProbeDeliverables`），不在本路复刻第二份正则');
    ok(closeRegion.includes('disposeProbeDeliverables(db, closeProbes')
      && !closeRegion.includes("promoteTaskFileDeliverables(db, taskId, 'run_close')"),
      'B-4 ★ run_close 的处置**先于** promote（区间以 promote 那一行为界；处置点落在区间内 ⇒ 顺序成立）');
    ok(finBlk.includes('selectProbeDeliverables(db, taskId)'),
      'B-4 ★ finalize 侧同样经 `selectProbeDeliverables`（两路同判据；M8 就地改钉：体在 control-finalize.ts）');

    // ── B-5 移动必须可见：告知含**移去哪**，且落在**用户可见**的地方 ──
    ok(finBlk.includes('已隔离 ${moved} 个文件至 ${quarantineDir}'),
      'B-5 ★ finalize 路告知含**移去哪**（`已隔离 N 个文件至 <目录>`；M8 就地改钉：体在 control-finalize.ts）');
    ok(closeRegion.includes('已移入隔离目录 ${closeQuarantineDir}') && /INSERT INTO wa_task_conversations/.test(closeRegion),
      'B-5 ★ run_close 路落**用户可见**记录（会话记录；本路没有 `finalize_checks` 可落）且同样含去向');
    ok(finBlk.includes('_tmp/_probe/_verify') && closeRegion.includes('_tmp/_probe/_verify'),
      'B-5 ★ 两条收口路的告知**同形**：都说清"判据是什么"（否则用户看到"已退休 3 个"无从知道哪些文件被动了；M8 就地改钉：finalize 体在 control-finalize.ts）');
    const detailPage = RD(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
    ok(detailPage.includes('finalizeChecks.map') && detailPage.includes('{convs.map('),
      'B-5 ★ 两处告知在 renderer **真有着落**（`finalize_checks` 逐条渲染 + 会话历史逐条渲染）——不落在无人读的字段上');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【D】判据 D（M4·账本新鲜度）：验收在任何读完成分的闸之前跑完；完成分**重算**而非"加回"');
  {
    // ── D-1 顺序 ────────────────────────────────────────────────────────────
    // 全部按**符号**取位置（`indexOf` 到的一律是代码锚点；注释已被 `strip` 抹掉 ⇒ 不会被注释里的
    //   同名文字顶替位置）。任一锚点缺席 ⇒ 其位置为 -1 ⇒ 该条断言判红并如实报 -1。
    const at = (needle: string, label: string, from = 0): number => {
      const i = exeSrc.indexOf(needle, from);
      ok(i >= 0, `D-1 锚点在册：${label}`, `@${i}`);
      return i;
    };
    const iGate1 = at("note: '产出文件未落盘或为空'", '产出未落盘闸的落账 note');
    const iGate2 = at("note: '产出内容不充分(充分性校验)'", '内容不充分闸的落账 note');
    const iAccCall = at('await checkAcceptanceCriteria(ctx, db, taskId, closeCriteria)', 'run_close 验收调用');
    // ⚠ **必须从 `iAccCall` 之后起找**：初评那句 `let qualityScore = assessCompletionQuality(…` 里
    //   也含这同一子串，从 0 找会匹配到初评、得出"重算在验收**之前**"的假结论（本条首次跑即如此，已订正）。
    const iRecompute = at('qualityScore = assessCompletionQuality(db, taskId, stepCount,', '完成分重算', iAccCall);
    const iPremature = at('const prematureEnd =', '过早结束闸', iRecompute);
    const iPromote = at("promoteTaskFileDeliverables(db, taskId, 'run_close')", 'promote 产出物', iPremature);

    // "在两道闸之后"的**硬证据**：闸2 的提前出口（那道 return）确实排在验收之前。
    const RET = 'return { content: finalContent, steps: stepCount };';
    const iGate2Ret = exeSrc.lastIndexOf(RET, Math.max(iAccCall, 0));
    ok(iGate1 >= 0 && iGate2 >= 0 && iGate1 < iGate2 && iGate2Ret > iGate2 && iGate2Ret < iAccCall,
      'D-1 ★ 验收**越过两道产出闸**：那两个 `note:` 落账点与其**提前 return** 都排在验收之前'
      + '（方案 §6.1 首选"前移到评分之前"，此处据实收窄到"越过两道闸、进入收口判定的第一处"）',
      `闸1@${iGate1} < 闸2@${iGate2} < 出口@${iGate2Ret} < 验收@${iAccCall}`);
    ok(iAccCall >= 0 && iRecompute > iAccCall && iPremature > iRecompute && iPromote > iPremature,
      'D-1 ★ 收口序：验收落账 → 完成分重算 → 过早结束闸 → promote'
      + '（过早结束闸判的正是 `qualityScore.score < 60` ⇒ 它现在读的是**刚落账的新鲜验收账**）',
      `验收@${iAccCall} < 重算@${iRecompute} < 过早@${iPremature} < promote@${iPromote}`);

    // ── D-2 单一读点：判据与载荷读同一份、同一刻的账 ─────────────────────────
    const closeRegion = between(exeSrc, /^ *const closeAccNow = readAcceptanceCheck\(db, taskId\);/, /^ *const prematureEnd =/);
    ok(closeRegion.length > 0 && closeRegion.includes('acceptanceVerdictOf(closeAccNow)') && closeRegion.includes('toAcceptanceSummary(closeAccNow)'),
      'D-2 ★ 终态判据与事件载荷读**同一处**取来的账（`closeAccNow` 一处读、两处用）',
      closeRegion ? `${closeRegion.split('\n').length} 行` : '(未切到块)');
    ok((closeRegion.match(/readAcceptanceCheck\(/g) ?? []).length === 1,
      'D-2 ★ 该段内 `readAcceptanceCheck` **恰一次** —— 第二次读就可能读到另一个时刻的账（O-D 从这缝里溜回来）');
    ok(closeRegion.includes('qualityScore = assessCompletionQuality(')
      && (closeRegion.match(/completion_quality\s*=\s*buildCompletionAccount\(/g) ?? []).length === 1,
      'D-2 ★ 重算**落笔只有一处**（段内 `completion_quality = buildCompletionAccount(…)` 恰一次）'
      + '——一处写两处读就不是"两版账"，写两处才是',
      `${(closeRegion.match(/completion_quality\s*=\s*buildCompletionAccount\(/g) ?? []).length} 处`);
    // 终点同 C-3：钉"标完成"那条写入（`markPauseNeeded` 已迁入写口 `pauseTask`，不再现身分支内）。
    const failBlk2 = between(exeSrc, /if \(closeVerdict === 'failed'\) \{/, /UPDATE wa_tasks SET status = 'completed'/);
    ok(failBlk2.length > 0 && !failBlk2.includes('checkAcceptanceCriteria('),
      'D-2 ★ 终态分支**不重跑验收**——判据与评分同源同刻，该分支只置暂停与如实告知',
      `${failBlk2.split('\n').length} 行`);

    // ── D-3 行为：账换一份 ⇒ 完成分**重新算出真值**（跑真函数，不复刻六维规则）──
    const wsD = fs.mkdtempSync(path.join(os.tmpdir(), 'rr3-m4-ws-'));
    try {
      const bigFile = path.join(wsD, 'report.md');
      fs.writeFileSync(bigFile, 'x'.repeat(2000));
      /** 结构指标刻意拉满（产出物 + 实质大小 + 少步数 + 低 token + 充分对话 + 非过早结束）——
       *  这样"未通过验收"就是**唯一**的压降成因，压降前/后之差可归因。 */
      const makeDb = (ctx: Record<string, unknown>): InstanceType<typeof DatabaseSync> => {
        const db = new DatabaseSync(':memory:');
        db.exec(`
          CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT);
          CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, name TEXT, type TEXT, status TEXT, file_path TEXT, created_at TEXT);
          CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, content TEXT);
        `);
        db.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('T', JSON.stringify(ctx));
        db.prepare('INSERT INTO wa_deliverables (id, task_id, name, type, status, file_path, created_at) VALUES (?,?,?,?,?,?,?)')
          .run('d1', 'T', 'report.md', 'doc', 'completed', bigFile, '2026-09-16 00:00:00');
        for (let i = 0; i < 3; i++) {
          db.prepare('INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?,?,?,?)')
            .run(`c${i}`, 'T', 'assistant', `第 ${i} 轮汇报`);
        }
        return db;
      };
      const scoreOf = (db: InstanceType<typeof DatabaseSync>) =>
        assessCompletionQuality(db as never, 'T', 3, 1000, 100000, 40, wsD);
      const accOf = (verified: boolean, total: number, passed: number) => ({
        checked_at: '2026-09-16 01:00:00', verified,
        criteria_total: total, passed_total: passed,
        passed: Array.from({ length: passed }, (_, i) => `判据${i + 1}`),
        failed: Array.from({ length: total - passed }, (_, i) => ({ criterion: `判据${passed + i + 1}`, reason: '未达成' })),
      });

      const dbNone = makeDb({});
      // 夹具自检：结构分须足够高，否则"压降"这件事根本无从观察（防"夹具自己就是低分"式假绿）
      ok(realOutputEvidence(dbNone as never, 'T') === true,
        'D-3 夹具自检·前提：「有真实产出证据」这条压降**不生效**（登记为 doc 且文件真在盘上）——否则 45 分可能来自它而非验收账');
      const sNone = scoreOf(dbNone);
      ok(sNone.score >= 60 && !sNone.feedback.includes('验收未通过'),
        'D-3 夹具自检：未核验验收的结构分本就 ≥60 ⇒ 下面的压降与回升可**归因**到验收账本身',
        `${sNone.score} 分 / ${sNone.feedback}`);

      const dbFail = makeDb({ acceptance_check: accOf(true, 3, 1) });
      const sFail = scoreOf(dbFail);
      ok(sFail.score <= ACCEPTANCE_FAILED_SCORE_CAP && sFail.feedback.includes('验收未通过'),
        'D-3 ★ 账上"已核验且 1/3 未过" ⇒ 完成分压到 ≤ `ACCEPTANCE_FAILED_SCORE_CAP`，且成因**点名**',
        `${sFail.score} 分 ≤ ${ACCEPTANCE_FAILED_SCORE_CAP} / ${sFail.feedback.slice(-40)}`);

      const dbPass = makeDb({ acceptance_check: accOf(true, 3, 3) });
      const sPass = scoreOf(dbPass);
      ok(sPass.score === sNone.score && !sPass.feedback.includes('验收未通过'),
        'D-3 ★ 同一份库、**只把账换成"3/3 全过"** ⇒ 完成分**回到未压降时的真值**（重算，不是"在 45 上做算术"）',
        `${sFail.score} → ${sPass.score}（真值 ${sNone.score}）`);
      // 不可逆推的**实证**：同一输出 45 可以来自两个不同的输入分 ⇒ 无从反解，只能重算
      ok(capScoreByAcceptanceVerdict(sNone.score, 'failed') === ACCEPTANCE_FAILED_SCORE_CAP
        && capScoreByAcceptanceVerdict(ACCEPTANCE_FAILED_SCORE_CAP, 'passed') === ACCEPTANCE_FAILED_SCORE_CAP,
        'D-3 ★ `capScoreByAcceptanceVerdict` **不可逆推**：`f(95)=45` 与 `f(45)=45` 同值 ⇒'
        + '"加回 45"这类还原法在数学上就不成立（承 `feedback_verify_roundtrip_at_production_input`）',
        `f(${sNone.score})={${ACCEPTANCE_FAILED_SCORE_CAP}} / f(${ACCEPTANCE_FAILED_SCORE_CAP})={${ACCEPTANCE_FAILED_SCORE_CAP}}`);
      // 「有题未判成」一态不得压降（「没判成 ≠ 没达成」）——同一函数上的第三条对照
      // zx_20260923_1 M2（名实相符·就地订正）：本行原称此为"第三态 `not_checked`"——**名已不符**。
      //   `reason:'error'` 自 M2 起读作**第四态 `unjudged`**（题在、本轮没判成），与"没有题目"的
      //   `not_checked` 是两回事。**分数断言一字未改**（不压降这条性质没变，变的只是它的名字与归属），
      //   并补一条正面断言把"它是哪一态"钉死——否则标签写着 A、代码做的是 B，正是本仓反复记过的那类病。
      const sUnknown = scoreOf(makeDb({ acceptance_check: { checked_at: '2026-09-16 01:00:00', verified: false, reason: 'error' } }));
      ok(sUnknown.score === sNone.score && acceptanceVerdictOf({ checked_at: '2026-09-16 01:00:00', verified: false, reason: 'error' }) === 'unjudged',
        'D-3 第四态：`unjudged`（有题未判成 `verified:false/reason:error`）**不压分**——"没判成"与"没达成"是两回事',
        `${sUnknown.score} 分`);

      // ── D-4 标本 `3b6e2263`（§1.2-④）只读回放 ─────────────────────────────
      // 存量形态：`completion_quality.score=45` + 成因含「验收未通过」 **而** `acceptance_check` 3/3 全过
      //   ——同一份 `context_json` 里两句话互相打脸，终态却是 `completed`。
      const SPEC_STORED = {
        score: ACCEPTANCE_FAILED_SCORE_CAP,
        feedback: `质量: acceptable (产出3个(12KB), 21步, 88K tokens [验收未通过，评分压降<60])`,
      };
      const SPEC_ACC = { ...accOf(true, 3, 3), passed: ['判据1', '判据2', '判据3'] };
      const contradiction = (score: number, feedback: string, verdict: string): boolean =>
        verdict === 'passed' && (score < 60 || feedback.includes('验收未通过'));
      ok(acceptanceVerdictOf(SPEC_ACC) === 'passed' && contradiction(SPEC_STORED.score, SPEC_STORED.feedback, 'passed'),
        'D-4 标本回放·前置：`3b6e2263` 的账**确实自相矛盾**——验收 3/3 全过，完成分却按"未通过"压成 45 且成因写明（矛盾检测器判红）',
        `verdict=passed / score=${SPEC_STORED.score}`);
      ok(toAcceptanceSummary(SPEC_ACC)?.verified === true && toAcceptanceSummary(SPEC_ACC)?.passed_total === 3,
        'D-4 标本回放：`toAcceptanceSummary` 对该账读得出"已核验 3/3"（不是"无从说起"）',
        JSON.stringify(toAcceptanceSummary(SPEC_ACC)));
      const sReplay = scoreOf(makeDb({ acceptance_check: SPEC_ACC, completion_quality: SPEC_STORED }));
      ok(!contradiction(sReplay.score, sReplay.feedback, 'passed') && sReplay.score >= 60,
        'D-4 ★ 标本回放：新尺**重算**后该账的矛盾消失（不再按"未通过"压降）——这正是 M4 要的那件事',
        `${SPEC_STORED.score} → ${sReplay.score} 分；成因含"验收未通过"=${sReplay.feedback.includes('验收未通过')}`);
      ok((sReplay.score >= 60) === (acceptanceVerdictOf(SPEC_ACC) !== 'failed'),
        'D-4 ★ 不变量：`score >= 60` ⟺ `verdict !== "failed"`（同源同刻 ⇒ 两句话不可能再各说各的）');

      // 真库只读旁证：标本**未被回填**（承本仓约定：存量脏账本轮只出只读清单）
      let dbNote4 = '跳过（真库不可得）';
      try {
        const real = new DatabaseSync(path.join(root, 'data/worker-ant-server.db'), { readOnly: true } as never);
        const row = real.prepare("SELECT id, status, quality_score, context_json FROM wa_tasks WHERE id LIKE '3b6e2263%'").get() as
          { id?: string; status?: string; quality_score?: number; context_json?: string } | undefined;
        real.close();
        if (row?.context_json) {
          const c = JSON.parse(row.context_json) as {
            completion_quality?: { score?: number; feedback?: string };
            acceptance_check?: { verified?: boolean; criteria_total?: number; passed_total?: number };
          };
          const v = acceptanceVerdictOf(c.acceptance_check);
          ok(v === 'passed' && Number(c.acceptance_check?.passed_total) >= Number(c.acceptance_check?.criteria_total ?? 0),
            'D-4 真库旁证：标本的验收账**仍是 3/3 全过**（存量原样，本轮回放只读）',
            JSON.stringify(c.acceptance_check));
          ok(Number(c.completion_quality?.score) === ACCEPTANCE_FAILED_SCORE_CAP
            && contradiction(Number(c.completion_quality?.score) || 0, String(c.completion_quality?.feedback ?? ''), v),
            'D-4 真库旁证：标本的 `{score:45 + 验收未通过}` 与"验收全过"**仍并存** —— 存量脏账**未被回填**',
            `${c.completion_quality?.score} 分 / ${row.status}`);
          dbNote4 = `已核（${row.id?.slice(0, 8)} / ${row.status} / ${row.quality_score} 分）`;
        }
      } catch { /* 真库被锁/不存在 ⇒ 如实跳过 */ }
      console.log(`  · 真库只读旁证：${dbNote4}`);
    } finally {
      fs.rmSync(wsD, { recursive: true, force: true });
    }

    // ── D-5 同病根的第二处落点（方案未点名，M3 教训"点名的落点数 ≤ 真实落点数"）──
    //   验收的 `[内容校验]` 取证**只从库里读** `output_validations`；而它此前**只在"有不充分"时**才落库
    //   ⇒ "全部充分"这条最正常的路上，验收 LLM 读的是上一轮的结论。故落库点须在 `contentUnfulfilled`
    //   分支**之外**（该分支命中即 return，本 run 不收口）。
    const iPersist = exeSrc.indexOf('if (gateTargets.length > 0 && Array.isArray(ctxJson.output_validations)) {');
    const iUnfulfilledBranch = exeSrc.indexOf('if (contentUnfulfilled.length > 0) {');
    ok(iPersist >= 0 && iUnfulfilledBranch > iPersist,
      'D-5 ★ `output_validations` 的落库在 `contentUnfulfilled` 分支**之外**（"全部充分"这条路上也落库）',
      `落库@${iPersist} < 分支@${iUnfulfilledBranch}`);
    ok((exeSrc.slice(iPersist, iPersist + 400)).includes('UPDATE wa_tasks SET context_json = ?'),
      'D-5 ★ 该落库点**确实写库**，不是只改了内存对象（`ctxJson.output_validations = ov` 本身不落盘）');
    const accEvidence = between(exeSrc, /const ctxr = JSON\.parse\(/, /const evidence = \[/);
    ok(accEvidence.includes("'SELECT context_json FROM wa_tasks WHERE id = ?'") && accEvidence.includes('[内容校验]'),
      'D-5 ★ 验收的 `[内容校验]` 取证**只从库里读**（这正是"不落库就等于读旧账"的机检依据）',
      `${accEvidence.split('\n').length} 行`);
    // 行为旁证：同一份"全部充分"的结论，落库与否决定验收读到的是哪一轮
    {
      const ctxFresh = { output_validations: [{ file: '/a/patch.py', sufficient: true, status: 'sufficient' }] };
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT);');
      db.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('T', JSON.stringify(ctxFresh));
      const got = readAcceptanceCheck(db as never, 'T');
      ok(got === undefined && (db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('T') as { context_json: string }).context_json.includes('sufficient'),
        'D-5 旁证：`readAcceptanceCheck` 读的是**同一列** `context_json`（"取证从库里读"不是比喻）');
      db.close();
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【E-1】M5·O-F 代拟消息不冒充用户（判据按**首标**，不按 role）');
  {
    // ── ① "0 变 1"的正面断言 ───────────────────────────────────────────────
    const RAW = '你是工蚁系统的AI助手。你的所有子任务已经全部完成，请现在整合所有产出。';
    ok(isEngineDraftedTurn(RAW) === false && isEngineDraftedTurn(markEngineDrafted(RAW)) === true,
      'E-1 ★ 正面（0 → 1）：无首标的引擎指令打标后**判为代拟**（不是"不抛异常"）',
      `${isEngineDraftedTurn(RAW)} → ${isEngineDraftedTurn(markEngineDrafted(RAW))}`);

    // ── ② 幂等：不得叠标（叠标会让同一句在对话流里长出一串首标）───────────
    const once = markEngineDrafted(RAW);
    const twice = markEngineDrafted(once);
    const tagCount = (s: string) => s.split(ENGINE_DRAFTED_TAG).length - 1;
    ok(twice === once && tagCount(twice) === 1,
      'E-1 ★ 幂等：对已带首标的文本再打标**原样返回**（首标恰一个），且原句**逐字未改**',
      `首标数=${tagCount(twice)}；原句在场=${twice.includes(RAW)}`);
    ok(once === `${ENGINE_DRAFTED_TAG} ${RAW}`,
      'E-1 打标只**前置首标**、不动正文（首标集合是"可辨识"手段，不是"改写"手段）');

    // ── ③ **真人发言一律不判代拟** —— 把人的话标成引擎的是另一种不实 ────────
    for (const human of ['[IM回复] 帮我看下这个任务', '[用户选择: A]', '[用户确认执行]', '继续', '请把报告写成 md']) {
      const labelled = isEngineDraftedTurn(human);
      ok(labelled === false,
        `E-1 ★ 真人发言**不判代拟**：${JSON.stringify(human.length > 14 ? `${human.slice(0, 14)}…` : human)}`,
        labelled ? '被判为代拟 ⇒ 这是另一种不实' : '');
    }

    // ── ④ 词表非空话：每个首标在 `src/main` **确有生产点**（扫描面 = 整个 src/main）──
    //   判据用**模板字面量的反引号形态**（`` `[系统] … ``）——那才是"生产点"；SQL 的 `LIKE '[系统…'`
    //   是**读者**不是生产者，若按裸子串匹配会被它顶替（那样断言就成了"有人在读它"冒充"有人在写它"）。
    const mainDir = path.join(root, A, 'src/main');
    const authorshipPath = path.join(mainDir, 'core/turn-authorship.ts');
    const mainFiles = walkTs(mainDir).map((p) => ({ p, src: strip(fs.readFileSync(p, 'utf-8')) }));
    for (const tag of ENGINE_TURN_TAGS) {
      if (tag === ENGINE_DRAFTED_TAG) {
        // 该首标的字面量只在 `turn-authorship.ts` 定义一处 ⇒ 它的生产点是**函数调用**。
        const callers = mainFiles.filter((f) => f.p !== authorshipPath && f.src.includes('markEngineDrafted('))
          .map((f) => path.relative(mainDir, f.p));
        ok(callers.length > 0,
          `E-1 ★ 词表非空话：\`${tag}\` 确有生产点（\`markEngineDrafted(\` 调用处）`, callers.join(', ') || '(无)');
      } else {
        const producers = mainFiles.filter((f) => f.p !== authorshipPath && f.src.includes('`' + tag))
          .map((f) => path.relative(mainDir, f.p));
        ok(producers.length > 0,
          `E-1 ★ 词表非空话：\`${tag}…\` 确有生产点（模板字面量形态）`, producers.join(', ') || '(无)');
      }
    }
    ok(ENGINE_TURN_TAGS.includes(ENGINE_DRAFTED_TAG) && new Set(ENGINE_TURN_TAGS).size === ENGINE_TURN_TAGS.length,
      'E-1 词表自身无重复项（首标集合，重复只会让人误以为覆盖更广）', `共 ${ENGINE_TURN_TAGS.length} 个`);

    // ── ⑤ **可达性不回归**：首标改了，`role` 一个字没动 ─────────────────────
    //   `role='system'` 会被回放**逐字跳过** ⇒ 反馈送不到执行体（zx_20260911_1 M2 的教训就在那段代码里）。
    const aiSrc = strip(RD(`${A}/src/main/core/jobs/ai-task.ts`));
    ok(aiSrc.includes('const forceFinalizeMsg = markEngineDrafted('),
      'E-1 ★ 加标在**合成处**（`forceFinalizeMsg` 构造时）——落库前已是带标文本，与落库去重的 `content ===` 比对同尺');
    ok(!aiSrc.includes("const forceFinalizeMsg = '你是工蚁系统"),
      'E-1 ★ 旧的无首标字面量**已无残留**（不是"新加一句、旧的那句还留着"）');
    const psSrc = strip(RD(`${A}/src/main/core/pause-settlement.ts`));
    ok(/INSERT INTO wa_task_conversations[\s\S]{0,200}'user'/.test(psSrc) && psSrc.includes('taskMessage)'),
      'E-1 ★ **可达性前半**：本路文本经 `persistTurnMessage` 落库时 role 仍是 `\'user\'`（首标改了，role 一个字没动）');
    // 同 rr_zx_20260910_1_b1：判据钉**语义**（唯一写入点、末参由 `taskMessage` 派生），不钉调用点逐字形状
    //（zx_20260921 M2 给末参加 `persistNotes` 尾注后末参为三目表达式）。
    const exePersist = exeSrc.match(/persistTurnMessage\(db, taskId, [\s\S]{0,200}?\);/);
    ok(exePersist !== null && exePersist[0].includes('taskMessage'),
      'E-1 ★ **可达性后半**：`exec_turn` 的输入正是由这个单一写入点落库（`executeTask` 收到的就是 `finalMsg`）'
      + '——两半合起来才叫"送得到执行体"，单看任一半都只是推测');
    // zx_20260921 M8: 回放循环已随上下文装配段搬至 `core/exec-context.ts` ⇒ 本处改读并集。
    //   ⚠ 反面（"不含 `[引擎代拟]` 跳过"）取并集比单文件**更严**（任一处出现即红），非放宽。
    ok(exeSrc.includes("if (conv.role === 'system') continue;")
      && !exeSrc.includes("startsWith('" + ENGINE_DRAFTED_TAG + "')"),
      'E-1 ★ 回放的跳过集合**不含** `[引擎代拟]`（只跳 `system` 行与 `[系统恢复]`）⇒ 代拟反馈照常送达执行体');

    // ⚠ 词表的**范围**（「入表的都是 `role` 自证不了来源的行」）**不在此处机检**：本表的生产点有三种形态
    //   （标签与 INSERT 同句 / 先绑常量后 INSERT / 经 `persistTurnMessage` 落库），任一"就近找 INSERT"的
    //   写法都要么误命中邻近的其它 INSERT、要么在第二种形态上判空。**不写一条会自我印证的断言来冒充覆盖**：
    //   该结论由 M5 落地时**逐个读生产点**得出（清单见方案 §7.4），此处只断言"每个首标确有生产点"。
    //   其中"经 `persistTurnMessage` 落库"这一路的 `role='user'` 由上面两条断言实际覆盖。

    // ── ⑥ renderer 第二落点：用**同一个真源**，且**不含第二份词表** ──────────
    const tdpSrc = RD(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
    ok(tdpSrc.includes("import { isEngineDraftedTurn } from '../../../src/main/core/turn-authorship.js';"),
      'E-1 ★ renderer 跨根 import **同一个真源**（承 zx_20260913 `dep-graph.ts` 先例）——不是手抄一份词表');
    ok(tdpSrc.includes("{isEngineDraftedTurn(c.content) ? '引擎' : c.role}"),
      'E-1 ★ 气泡标签：代拟行印 `引擎`、真人行仍印 `user`（对话流里两种来源**可分辨**——这就是 O-F 要的那件事）');
    const tdpStripped = strip(tdpSrc);
    const mirrored = ENGINE_TURN_TAGS.filter((t) => tdpStripped.includes(`'${t}'`));
    ok(mirrored.length === 0,
      'E-1 ★ 且 renderer **不含第二份首标词表**（零字面量命中 ⇒ 无从与 main 漂移；"第二落点"是**调用同源**，不是抄一份）',
      mirrored.length ? `命中：${mirrored.join(' ')}` : '0 命中');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【E-2】M5·O-H 探索配额一本账（D4 裁定：`bash` 与 `execute_command` 合为一本）');
  {
    const trSrc = strip(RD(`${A}/src/main/core/tool-registry.ts`));

    // ── ① 真源同一性：同一个**对象**、同一个账键 ───────────────────────────
    const bashQ = toolRegistry.getQuota('bash');
    const execQ = toolRegistry.getQuota('execute_command');
    ok(!!bashQ && bashQ === execQ,
      'E-2 ★ 两份 meta 引用**同一个配额对象**（连对象身份都相同）——"抄得一样的定义"会各自漂移，那正是病根');
    ok(toolRegistry.quotaKeyOf('bash') === SHELL_EXPLORE_QUOTA_KEY
      && toolRegistry.quotaKeyOf('execute_command') === SHELL_EXPLORE_QUOTA_KEY,
      'E-2 ★ 且两把工具落**同一个账键**', toolRegistry.quotaKeyOf('bash'));
    ok(toolRegistry.quotaKeyOf('search_web') === 'search_web',
      'E-2 未共享的工具**仍各自一本账**（缺省 = 工具名）——归一没有把别的工具也卷进来');
    const peers = [...toolRegistry.quotaKeyPeers('bash')].sort();
    ok(JSON.stringify(peers) === JSON.stringify(['bash', 'execute_command']),
      'E-2 ★ `quotaKeyPeers` 给出**同账全部工具**（硬禁用必须按它一并禁用）', peers.join(' / '));
    ok(JSON.stringify(toolRegistry.quotaKeyPeers('search_web')) === JSON.stringify(['search_web']),
      'E-2 单账工具的 peers 就是它自己（硬禁用仍只禁它——不一刀切扩大打击）');

    // ── ② 账本行为：跑**真账本**，不在脚本里复刻计数逻辑 ────────────────────
    const L = new ExploreQuotaLedger();
    ok(L.count(SHELL_EXPLORE_QUOTA_KEY) === 0, 'E-2 前置：新账本为空 ⇒ 下面的"0 变 1"可归因到 `add` 本身');
    L.add(toolRegistry.quotaKeyOf('bash'));
    ok(L.count(SHELL_EXPLORE_QUOTA_KEY) === 1, 'E-2 ★ 正面：一次 `bash` 探索 ⇒ 该账**由 0 变 1**');
    L.add(toolRegistry.quotaKeyOf('execute_command'));
    ok(L.count(SHELL_EXPLORE_QUOTA_KEY) === 2,
      'E-2 ★ 再一次探索改走 `execute_command` ⇒ **同一个计数器读到 2**'
      + '（同一批探索命令在两把工具上**共用一个计数**，O-H 要的正是这句）',
      `count=${L.count(SHELL_EXPLORE_QUOTA_KEY)}`);

    // ── ③ 软告警：恰一次、且**跨线仍响**（旧 `count === soft` 的病根形状）────
    const softHits: number[] = [];
    const L2 = new ExploreQuotaLedger();
    for (let i = 1; i <= SHELL_EXPLORE_QUOTA.soft + 2; i++) {
      L2.add(SHELL_EXPLORE_QUOTA_KEY);
      if (L2.gate(SHELL_EXPLORE_QUOTA_KEY, SHELL_EXPLORE_QUOTA).softMsg) softHits.push(i);
    }
    ok(JSON.stringify(softHits) === JSON.stringify([SHELL_EXPLORE_QUOTA.soft]),
      'E-2 ★ 软告警**恰一次**且落在软线那一次（阈值由真配额对象派生，不写 12）', `触发于第 ${softHits.join('/')} 次`);
    const L3 = new ExploreQuotaLedger();
    for (let i = 0; i < SHELL_EXPLORE_QUOTA.soft - 1; i++) L3.add(SHELL_EXPLORE_QUOTA_KEY);
    L3.add(SHELL_EXPLORE_QUOTA_KEY); L3.add(SHELL_EXPLORE_QUOTA_KEY);   // 同一步两发 ⇒ 跳过"恰好等于软线"那一刻
    ok(L3.count(SHELL_EXPLORE_QUOTA_KEY) === SHELL_EXPLORE_QUOTA.soft + 1
      && !!L3.gate(SHELL_EXPLORE_QUOTA_KEY, SHELL_EXPLORE_QUOTA).softMsg,
      'E-2 ★ **跨线仍响**：同一步里从软线前一次跨到软线后一次，不再整条漏报'
      + '（旧实现对 `=== soft` 的"恰好那一刻"才响——与本轮病根同一形状：判据只认恰好那一刻的样子）',
      `count=${L3.count(SHELL_EXPLORE_QUOTA_KEY)} / 软线=${SHELL_EXPLORE_QUOTA.soft}`);
    ok(!trSrc.includes('=== limit.soft') && !trSrc.includes('count === soft'),
      'E-2 ★ 旧的"恰好相等"判据在 `tool-registry.ts` 已无残留');

    // ── ④ 硬线边界 + 到线不再补软告警 ───────────────────────────────────────
    const L4 = new ExploreQuotaLedger();
    for (let i = 0; i < SHELL_EXPLORE_QUOTA.hard - 1; i++) L4.add(SHELL_EXPLORE_QUOTA_KEY);
    const justBefore = L4.gate(SHELL_EXPLORE_QUOTA_KEY, SHELL_EXPLORE_QUOTA);
    L4.add(SHELL_EXPLORE_QUOTA_KEY);
    const atLine = L4.gate(SHELL_EXPLORE_QUOTA_KEY, SHELL_EXPLORE_QUOTA);
    ok(!justBefore.hard && atLine.hard,
      'E-2 ★ 硬线边界：`hard-1` **不**禁用、`hard` 才禁用（阈值由真配额对象派生，不写 20）',
      `${SHELL_EXPLORE_QUOTA.hard - 1} 次 ⇒ hard=${justBefore.hard}；${SHELL_EXPLORE_QUOTA.hard} 次 ⇒ hard=${atLine.hard}`);
    ok(!atLine.softMsg,
      'E-2 到硬线**不再补软告警**：硬告警更强且已说明"一并禁用"，两句同一步发出只是噪音（**不是漏报**，如实登记）');

    // ── ⑤ ★ 代价③（D4）：额度**合计**只到 `hard`，不是 2 × `hard` ────────────
    const half = Math.ceil(SHELL_EXPLORE_QUOTA.hard / 2);
    const rest = SHELL_EXPLORE_QUOTA.hard - half;
    const L5 = new ExploreQuotaLedger();
    for (let i = 0; i < half; i++) L5.add(toolRegistry.quotaKeyOf('bash'));
    for (let i = 0; i < rest; i++) L5.add(toolRegistry.quotaKeyOf('execute_command'));
    ok(L5.count(SHELL_EXPLORE_QUOTA_KEY) === SHELL_EXPLORE_QUOTA.hard
      && L5.gate(SHELL_EXPLORE_QUOTA_KEY, SHELL_EXPLORE_QUOTA).hard,
      'E-2 ★ **代价③（D4）**：同一批探索在两把工具上**混着花**，合计只到 `hard` 就停'
      + '（归一后执行体实际可用的探索量 = `hard`，原为 2 × `hard`——收紧是裁定的代价，如实记入方案 §10.1）',
      `混花合计 ${L5.count(SHELL_EXPLORE_QUOTA_KEY)} = hard ${SHELL_EXPLORE_QUOTA.hard}`);
    const oldShapeWouldDisable = (n: number, tool: string) => n >= (toolRegistry.getQuota(tool)?.hard ?? Infinity);
    ok(!oldShapeWouldDisable(half, 'bash') && !oldShapeWouldDisable(rest, 'execute_command'),
      'E-2 ★ 反证（判据非空转）：同一序列按**旧的两本账**口径两边都够不着线 ⇒ 本次收紧是**真的行为变化**'
      + '（不是又一次"改得跟没改一样"）',
      `旧口径：bash ${half} 次 ⇒ 禁用=${oldShapeWouldDisable(half, 'bash')}；`
      + `execute_command ${rest} 次 ⇒ 禁用=${oldShapeWouldDisable(rest, 'execute_command')}`);

    // ── ⑥ 接线：生产侧真的用这本账（且旧的"每工具一本"已无残留）────────────
    ok(exeSrc.includes('const quotaLedger = new ExploreQuotaLedger();'),
      'E-2 ★ 接线：执行体**用这个真账本**（不是又写一份内联 Map——那正是 O-H 的病根）');
    ok(exeSrc.includes('quotaLedger.add(toolRegistry.quotaKeyOf(tc.toolName))'),
      'E-2 ★ 接线：计入的是**该工具所属的那本账**（`quotaKeyOf`），不是工具自己 ⇒ 两把 shell 落到同一计数器');
    ok(exeSrc.includes('quotaLedger.gate(toolRegistry.quotaKeyOf(tc.toolName), limit)'),
      'E-2 ★ 接线：判定（软只响一次 / 到硬线）由真账本出，调用侧只落动作（写库/禁用）');
    ok(!exeSrc.includes('toolCallCountsExplore'),
      'E-2 ★ 旧的"每工具一本账"实现（`toolCallCountsExplore`）**已无残留**');
    const iHard = exeSrc.indexOf('if (action.hard) {');
    const hardBlk = iHard >= 0 ? exeSrc.slice(iHard, iHard + 800) : '';
    ok(hardBlk.includes('toolRegistry.quotaKeyPeers(tc.toolName)'),
      'E-2 ★ 到硬线按 `quotaKeyPeers` **同账一并处置**——只处置被调用的那一个，同账的另一半仍能继续吃这本账'
      + '⇒ 账等于没归成一本（zx_20260922_1 M1 后：**处置方式**按 `MIXED_SHELL_TOOLS` 分流，'
      + '"按哪个集合收人"这条判据一字未动）',
      iHard >= 0 ? `@${iHard}` : '(未找到 hard 分支)');
    ok(exeSrc.includes('countsTowardToolQuota(tc.toolName, tc.args)'),
      'E-2 归一**未动**"哪些调用吃额度"那把尺（收尾命令仍不计入——D4 只合并账，不合并尺）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【P】build 钉（派生核对，不写轮次字面量）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

try { main(); } finally { /* 内存库随进程回收 */ }

console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260916_3: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
