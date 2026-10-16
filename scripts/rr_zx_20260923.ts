/**
 * zx_20260923 受控复跑 —— 「改了说明书，机器还念旧账」。
 *
 * 病根：**一条修复、一个判据、一份账，都只走了一条路；而这条路上没走到的地方，机器不会报错——
 * 它会照旧念旧账。** 十六条缺陷（G1–G16）见 `plans/improve/zx_20260923.md` §2。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 批次门（`RR_STAGE`）——承 `zx_20260922*` 的骨架纪律：批**次门管的是实施排期**。
 *   `RR_STAGE=Mn` 时**只要求 ≤Mn 的批次**为绿，更晚的批次打 `⏳` 且**不计入失败**。
 *   `RR_STAGE` 为空 = **全部必须绿**（M8 收口用）。
 *
 * §G 判据 G（**不变式门**，与批次无关）：
 *   G-1 **真源在位**：本轮所引用的生产符号**全部静态 import** ⇒ 被删/被改名即**编译期失败**。
 *   G-2 **扫描面自证**：凡「零处 / 恰好一处」类断言必须同时报出**扫描面规模**
 *       （承 `zx_20260920_1 §G-1`：扫了个空也是绿）。
 *   G-3 **哑雷自检**：本文件自身零处轮次等值字面量（承 `feedback_assertion_no_forward_literals`）。
 *
 * §M1 判据（G2 毒旗 · G3 文案≠机器 · G4 一次失败两条事件 —— 「停的是这一次，还是那一次」）——
 *   ⚠ 本批的靶心**不是**"旗改成时间戳了没有"，而是"**这一次该不该重试**"的判据作用域。
 *     故 M1-A 跑**真实现** `sdk-incident.ts` 的纯函数，M1-B 用**真库物证**摆出那两行相隔 20.5 小时的
 *     事故（09-22 07:03:08 立旗 / 09-23 03:34:42 被当"第二次"），两只标本一起上
 *     （承 `feedback_predicate_needs_both_sides_specimen`）：
 *       M1-A0 夹具自证（立旗后 `hasOpenSdkIncident` 为真 ⇒ 下面"清旗后为假"不是空测试）
 *       M1-A1 **该重试（本批靶心）**：**用户手动恢复 = 新事故** ⇒ 清旗 ⇒ 本次首次失败拿到重试
 *       M1-A2 **该止（另一侧）**：引擎自动重试这条链上旗保留 ⇒ 同一事故第二次失败即到顶
 *       M1-A3 **反证标本**：把旧判据（裸 `ctx.sdk_failed`，不区分事故）就地复刻 ⇒ 20 小时后
 *             仍判"第二次" ⇒ 证明标本**确实踩中本病**，不是"新旧都不响"的空样本
 *   M1-B **文案的兑现者存在**（G3）：`[AI引擎失败]` 那句"若再次失败将暂停任务"的**兑现处**在
 *     同一份源码里可定位（`pauseTask` + 本事故专属因由），且该分支**写 `failed` 的语句已零处**
 *     ⇒ 判据是"机器做了那件事"，不是"文案写了那几个字"。
 *   M1-C **单事件**（G4）：SDK 分支的 `task.failed`（phase `'sdk'`）**零处**；
 *     `throw` 亦零处（原先靠冒泡到外层 catch 才多出一条 `execute_error`）。
 *   M1-D **不得死循环**：`sdkExhausted` 在两个 handler 里**先于** `sdkFailed` 收尾，
 *     否则 pause→resume→pause 无限自转（这是 T1 落 `paused` 之后**必然**新引入的风险，
 *     与"改一处引出一处"同族，故当批判死）。
 *   M1-E **因由如实**：`ai_sdk_unavailable` 有 label、进 `PauseReason` 型域、
 *     且**不被** `isChildrenIncompletePause` 认作"等子任务"（那会让调度器把它当可自愈的时序暂停）。
 *
 * ⚠ **禁**：断言「文案里写了那几个字」这种看字面的判据（文案改了并不代表机制修了，反之亦然）。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**（P6 取产物内 build 值本身，而非会被注释骗过的子串匹配）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { engineExecSideFiles, stripStepScopePrefix } from './lib/rr-engine-src.js';
// G-1：本轮判据引用的生产符号，**全部静态导入** ⇒ 被删/改名即编译期失败（而不是"扫了个空、静默假绿"）。
import {
  SDK_INCIDENT_KEY, SDK_INCIDENT_AT_KEY,
  hasOpenSdkIncident, sdkIncidentAt, openSdkIncident, closeSdkIncident,
} from '../apps/worker-ant-desktop/src/main/core/sdk-incident.js';
import {
  PAUSE_REASON_AI_SDK_UNAVAILABLE, pauseReasonLabel, isChildrenIncompletePause,
} from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
// M3（G8）：复用守卫的**真实现**（判据版本 + 守卫函数），以及签名读取的真实现。
import {
  VALIDATION_CRITERIA_VERSION, canReuseOutputValidation,
} from '../apps/worker-ant-desktop/src/main/core/output-validator.js';
import { cachedOutputValidation, fileSig, BUDGET_WARN_TOOLS, BUDGET_HARD_STOP_TOOLS, budgetBandOf, docValidationTargets } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
// M5（G9/G10）：门禁成员资格的尺（跑真实现）+ 采样面的尺（跑真实现）+ 命令窗口落盘盘点（跑真实现）。
import { isSampledWorkingFile, listFilesWrittenSince } from '../apps/worker-ant-desktop/src/main/core/world-snapshot.js';
import { DatabaseSync } from 'node:sqlite';
// M6（G11/G12/G16）：`failed` 的唯一写手 + 账页翻转 + 产出闸额度归还，一律**跑真实现**。
import { markTaskFailed, turnAccountPage, grantDeliverableRetryQuota } from '../apps/worker-ant-desktop/src/main/core/task-terminal.js';
// M4（G5/G6/G7）：里程碑「抽取 / 承接」判据与预算两档名单，一律**跑真实现**（不在断言里照抄一份）。
import {
  milestoneOwnLabel, milestoneRefsIn, declaredMilestones, unclaimedMilestones,
} from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
// M7（G13/G14/G15）：仓根归位跑**真实现 + 真文件系统**。
import { gitRootsOfDirs } from '../apps/worker-ant-desktop/src/main/core/tools/control.js';
// M2（G1）：回填判据（纯函数）+ 脱敏形状指纹 + 请求侧兼容的唯一实现，一律**跑真实现**。
import { backfillReasoningContent, requestShape, createReasoningAwareFetch } from '../apps/worker-ant-desktop/src/main/core/ai-reasoning.js';
// M2-c：**唯一** provider 工厂（`@ai-sdk/openai` 在 `src/main` 的唯一落点）。
import { createSafeProvider } from '../apps/worker-ant-desktop/src/main/core/ai-provider.js';
// ⚠ `ai` / `@ai-sdk/openai` 在本仓**不是根级依赖**（pnpm 只在 `apps/worker-ant-desktop/node_modules` 下建链），
//   本脚本 cwd = 仓库根 ⇒ 裸 `import 'ai'` 会 ERR_MODULE_NOT_FOUND。走 `createRequire` 按**桌面 app 的解析面**
//   取真入口（与 `rr_zx_20260921` M5-4 同款）。M2 的靶心是"真 SDK 往返"，替身冒充不了。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let pass = 0; let fail = 0; let pending = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ── 批次门（排期序，见文件头）────────────────────────────────────────────────
const ORDER = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'] as const;
type Batch = (typeof ORDER)[number];
const STAGE = (process.env.RR_STAGE || '').trim() as Batch | '';
/** STAGE 为空 ⇒ 全部须绿；否则**只要求 ≤STAGE 的批次**为绿（更晚的如实标"待实施"，不计入失败）。 */
const required = (b: Batch): boolean => STAGE === '' || ORDER.indexOf(b) <= ORDER.indexOf(STAGE);
/**
 * 登记一条**受批次门管辖**的判据。
 * ⚠ 未实施批次的判据**必须仍然求值**（不能短路成 `false` 了事）：要的是"红**为什么**红"，
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
const EXEC_SRC = path.join(root, A, 'src/main/core/agent-executor.ts');
const AITASK_SRC = path.join(root, A, 'src/main/core/jobs/ai-task.ts');
const INCIDENT_SRC = path.join(root, A, 'src/main/core/sdk-incident.ts');
const VALIDATOR_SRC = path.join(root, A, 'src/main/core/output-validator.ts');
const CONTROL_SRC = path.join(root, A, 'src/main/core/tools/control.ts');
// zx_20261003 M8 就地改钉：`finalize_task` 的执行体已由 `tools/control.ts` 机械搬迁至
//   `tools/control-finalize.ts`（导出 `runFinalizeTask`）。本套件凡记作"finalize 门"的判据
//   （M3-C 的 `criteriaVersion` 写点、M4-A/C 的里程碑抽取与差额、M7 的仓根归位/放行留痕）
//   本意都是"**finalize 执行体内**那处实现"，落点由 control.ts 变为搬迁体 ⇒ 扫描面随之指到新真源。
//   `gitRootsOfDirs` 的**定义**仍留在 control.ts（搬迁体只是 import 回用）——凡"定义 + 调用"的判据
//   须两文件合看（见 M7-A），故原 `CONTROL_SRC` 常量保留。
const FINALIZE_SRC = path.join(root, A, 'src/main/core/tools/control-finalize.ts');
const ACCT_SRC = path.join(root, A, 'src/main/core/task-accounting.ts');
const WS_SRC = path.join(root, A, 'src/main/core/world-snapshot.ts');
const TERMINAL_SRC = path.join(root, A, 'src/main/core/task-terminal.ts');
const PROJECTOR_SRC = path.join(root, A, 'src/main/core/event-projectors.ts');
const SCHEDULER_SRC = path.join(root, A, 'src/main/core/task-scheduler.ts');
const SELFHEAL_SRC = path.join(root, A, 'src/main/core/self-healing-monitor.ts');
const TASK_DETAIL_SRC = path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx');
const IPC_SRC = path.join(root, A, 'src/main/ipc/project.ipc.ts');
const PROVIDER_SRC = path.join(root, A, 'src/main/core/ai-provider.ts');
const REASONING_SRC = path.join(root, A, 'src/main/core/ai-reasoning.ts');
/** 扫源码一律**去注释**：承 `zx_20260921_1`——"注释里写着有、代码里没被用上"正是要防的形态。 */
const strip = (p: string) => stripKeepingLines(fs.readFileSync(p, 'utf-8')).join('\n');

/**
 * zx_20260929 M9：`agent-executor.ts` 的**收尾段**整段外移到 `core/exec-close.ts`（只动形不动义）。
 * 凡扫描面**本意是"执行体这一侧的实现/文案"**、而落点只是当时的所在的判据（两道闸的"额度耗尽"话术、
 * run 收口门那条 `validateOutput` 调用），须把面换成「执行体 ∪ `exec-*.ts`」——否则切到空/少数一处，
 * 报成"某机制没接线"（读起来像真回归，实为扫描面没跟着走）。
 *
 * ⚠ **不含 `tools/*.ts`**：这批判据里"收口门"与"finalize 门"是**分别点到、各判一次"恰一处"**的
 *   （finalize 门另用 `controlCode`，M8 后即 `control-finalize.ts`）。整份换成含工具段的 `engineSrc()` 会把 finalize 门那处也计进来
 *   ⇒ 从"两侧各一处"退化成"合计 ≥1"，是**放宽**。故取 `engineExecSideFiles()`（并集**减**工具段，
 *   落点仍出自 `lib/rr-engine-src.ts` 一处真源，免得下次搬迁又漏一处）。
 */
// zx_20260929 M9: 再还原一层——步回调搬到 `core/exec-step.ts` 后段内绑定统一前置了 `d.`
//   （`d.BUDGET_WARN_TOOLS` 等），本套件针脚写的是搬迁前的字面量。还原 ≠ 放宽（见 `stripStepScopePrefix`）。
const execSideCode = stripStepScopePrefix(engineExecSideFiles().map((p) => strip(path.join(root, p))).join('\n'));
/** 同上，只算行数（"零处/恰好一处"类断言的扫描面自证）。 */
const execSideLines = engineExecSideFiles()
  .map((p) => stripKeepingLines(fs.readFileSync(path.join(root, p), 'utf-8')).length)
  .reduce((a, b) => a + b, 0);

/** 子串**出现次数**（"零处/恰好一处"类判据用；须配扫描面规模自证，防空扫恒绿）。 */
function countOcc(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0; let i = hay.indexOf(needle);
  while (i >= 0) { n++; i = hay.indexOf(needle, i + needle.length); }
  return n;
}

/**
 * 从 `anchor` 命中的位置起，按**配对花括号**取出该语句块（`{` … 对应 `}`）。
 * 入参须是**已去注释**的源码（注释里的花括号会让配对失准）。
 * 找不到返回空串（空串会让下游断言为假 ⇒ 红，而非静默绿）。
 */
function blockAt(code: string, anchor: string): string {
  const i = code.indexOf(anchor);
  if (i < 0) return '';
  const open = code.indexOf('{', i);
  if (open < 0) return '';
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    const c = code[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return code.slice(open, j + 1); }
  }
  return '';
}

/**
 * ⚠ 旧判据的**就地复刻**——**仅作反证标本**：不是判据、不接入生产、任何生产码都不得引用它。
 *   唯一用途：证明"用户恢复了、旗却还在"这条旧路**确实会**把新事故判成第二次
 *   ⇒ 标本就是本案，不是"新旧都不响、于是看不出差别"的那种浪费样本。
 *   逐字复刻 `zx_20260923 M1` 修复前 `agent-executor.ts` 的那一句 `if (!retryCtx.sdk_failed)`。
 */
const legacyAllowRetry = (ctx: Record<string, unknown>): boolean => !ctx.sdk_failed;

/**
 * 递归收集 `src/main` 下**全部** `.ts` 的**去注释**源码——"全树只有一个写点"这类判据的扫描面。
 * 返回 `files` / `lines` 供**扫描面自证**（"零处/恰 N 处"若扫了个空，恒绿）。
 */
function scanMainSources(): { text: string; files: number; lines: number } {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.ts')) files.push(p);
    }
  };
  walk(path.join(root, A, 'src/main'));
  const lines: string[] = [];
  for (const f of files) lines.push(...stripKeepingLines(fs.readFileSync(f, 'utf-8')));
  return { text: lines.join('\n'), files: files.length, lines: lines.length };
}

/** 真库标本 `a290ae2b` 的两行对话物证（UTC，见方案 §1.2）——只取时刻，不取文案。 */
const SPECIMEN_FIRST_AT = '2026-09-22T07:03:08.000Z';
const SPECIMEN_SECOND_AT = '2026-09-23T03:34:42.000Z';

async function main(): Promise<void> {
  const execCode = strip(EXEC_SRC);
  const aiTaskCode = strip(AITASK_SRC);
  const incidentCode = strip(INCIDENT_SRC);
  // 扫描面规模（**行数**）——「零处 / 恰好一处」类断言的**自证**（承 `zx_20260920_1 §G-1`）。
  const execLines = stripKeepingLines(fs.readFileSync(EXEC_SRC, 'utf-8')).length;
  const aiTaskLines = stripKeepingLines(fs.readFileSync(AITASK_SRC, 'utf-8')).length;

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【G】不变式门（与批次无关）');
  {
    // ── G-1 真源在位 ────────────────────────────────────────────────────────
    ok(typeof hasOpenSdkIncident === 'function' && typeof openSdkIncident === 'function'
      && typeof closeSdkIncident === 'function' && typeof sdkIncidentAt === 'function',
      'G-1 真源在位：`sdk-incident` 四个动作可调用（静态 import ⇒ 改名即编译期失败）',
      `键 = ${SDK_INCIDENT_KEY} / ${SDK_INCIDENT_AT_KEY}`);
    ok(typeof pauseReasonLabel === 'function' && typeof isChildrenIncompletePause === 'function',
      'G-1 真源在位：暂停因由词表与人话可调用', '');
    ok(typeof legacyAllowRetry === 'function',
      'G-1 反证标本可就位（旧判据就地复刻，不接生产）', '');

    // ── G-2 扫描面自证 ──────────────────────────────────────────────────────
    ok(execLines > 1000 && aiTaskLines > 100,
      'G-2 扫描面自证：两个被扫文件均读到足量行（防"文件没读到 ⇒ 零处违规恒真"）',
      `agent-executor ${execLines} 行 / jobs/ai-task ${aiTaskLines} 行`);

    // ── G-3 哑雷自检 ────────────────────────────────────────────────────────
    // 承 `feedback_assertion_no_forward_literals.md`：等值断言写死本轮值 = 只对下一轮引爆的哑雷，
    //   且换语法外壳即可躲过 `PIN_RE` 那类前缀正则 ⇒ 必须**另有一把尺**按形态扫。
    // ⚠ 轮次标签由**载体自身**派生（本脚本文件名），标本串亦**现拼** —— 否则标本自己就成了本文件里
    //   那"一处命中"，判据会被自己的标本判红。
    const ROUND = (path.basename(__filename).match(/zx_\d{8}(?:_\d+)?/) ?? [''])[0]!;
    const RE_DUMB = /(?:===|!==|==|!=|\beq\()\s*['"]zx_\d{8}[^'"]*['"]/g;
    const scan = (s: string): string[] => [...s.matchAll(RE_DUMB)].map((m) => m[0]);
    const selfHits = scan(strip(__filename));
    // 两只标本一起试（只用"该命中"⇒ 任何过窄的变体全票通过；只用"该不命中"⇒ 任何过宽的变体全票通过）
    const probeHit = scan(`crit('M1', tag === '${ROUND}', 'x')`);
    const probeMiss = scan(`planPath = 'plans/improve/' + ROUND + '.md';\nif (ROUND >= DERIVED) {}`);
    ok(ROUND.length > 0 && probeHit.length === 1 && probeMiss.length === 0 && selfHits.length === 0,
      'G-3 本脚本**零处**轮次等值字面量（哑雷）；扫描器**两只标本都试过**：写死轮次的串必被抓到、'
      + '派生比较与方案路径必被放过',
      `轮次由 \`path.basename(__filename)\` 派生=${ROUND} · 命中 ${selfHits.length} 处 · `
      + `该命中标本 ${probeHit.length}/1 · 该不命中标本 ${probeMiss.length}/0`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1·G2】毒旗的作用域：「这一次」还是「任务一生」');
  {
    // ── M1-0 扫描器自证（两侧标本）───────────────────────────────────────────
    // 承 `feedback_predicate_needs_both_sides_specimen`：只用"该不命中"⇒ 恒 0 的坏扫描器也全票通过。
    const probeZero = countOcc('const nothing = 0;', SDK_INCIDENT_KEY);
    const probeOne = countOcc(`ctx.${SDK_INCIDENT_KEY} = true;`, SDK_INCIDENT_KEY);
    ok(probeZero === 0 && probeOne === 1,
      'M1-0 **扫描器自证（两侧标本）**：同一把计数器——不含该键名的串计 0、含该键名的串计 1'
      + ' ⇒ 下面依赖 `SDK_INCIDENT_KEY` 的判据不是靠"扫了个空"恒绿',
      `probeZero=${probeZero} / probeOne=${probeOne}`);

    // ── M1-A 事故的账（跑**真** `sdk-incident.ts`，不造等价入参）───────────────
    const ctx: Record<string, unknown> = {};
    ok(!hasOpenSdkIncident(ctx) && sdkIncidentAt(ctx) === '',
      'M1-A0 夹具自证（0 态）：未立旗时 `hasOpenSdkIncident` 为假、时刻为空串'
      + ' ⇒ 下面的"立旗后为真"是**由 0 变 1**的正面断言，不是"不抛就算过"',
      `hasOpen=${hasOpenSdkIncident(ctx)}`);
    openSdkIncident(ctx, SPECIMEN_FIRST_AT);
    ok(hasOpenSdkIncident(ctx) === true && sdkIncidentAt(ctx) === SPECIMEN_FIRST_AT,
      'M1-A0 ★ 立旗**由无到有**：`hasOpenSdkIncident` 0→1 且记下**事故起始时刻**'
      + '（旧实现只有一个布尔，答不出"这旗是哪一次立的"——正是 G2 的病根）',
      `at=${sdkIncidentAt(ctx)}`);
    // 事故中再立旗**不得**覆盖起始时刻：事故的"开始"只有一个
    openSdkIncident(ctx, SPECIMEN_SECOND_AT);
    ok(sdkIncidentAt(ctx) === SPECIMEN_FIRST_AT,
      'M1-A0 事故中重复立旗不覆盖起始时刻（事故的"开始"只有一个，重复置位不得把账改成后一次）',
      `at=${sdkIncidentAt(ctx)}`);

    // ── M1-A1 靶心：用户手动恢复 = 新事故 ⇒ 本次首次失败拿到重试 ──────────────
    const afterUserResume = { ...ctx };
    const closed = closeSdkIncident(afterUserResume);
    ok(closed === true && !hasOpenSdkIncident(afterUserResume) && sdkIncidentAt(afterUserResume) === '',
      'M1-A1 ★ **用户手动恢复 = 一次新事故**：清旗（返回"确有旗被结掉"）+ 时刻一并清空'
      + '（`sdk_failed_at` 不清就成了"结了账却留着上次的起始时刻"，又是一份名实不符的账）',
      `closed=${closed} / hasOpen=${hasOpenSdkIncident(afterUserResume)}`);
    ok(!hasOpenSdkIncident(afterUserResume),
      'M1-A1 ★★ **本批靶心**：清旗后，20 小时 31 分之后那一次 run 的**首次** SDK 失败'
      + '**拿到重试**（判据读的是"这一次有没有立旗"，不再是"任务一生里摔过没有"）',
      `标本：${SPECIMEN_FIRST_AT} 立旗 → ${SPECIMEN_SECOND_AT} 用户恢复 → 本次判"首次"`);

    // ── M1-A2 另一侧：引擎自动重试这条链上旗保留 ⇒ 第二次才到顶 ───────────────
    const autoRetryChain = { ...ctx };
    ok(hasOpenSdkIncident(autoRetryChain) === true,
      'M1-A2 **该止（另一侧）**：引擎自动重试不经用户路 ⇒ 旗保留 ⇒ 同一事故内第二次失败即到顶'
      + '——这条挡住"把判据改成永远给额度"的过宽变体（那就成了无限重试）',
      `hasOpen=${hasOpenSdkIncident(autoRetryChain)}`);

    // ── M1-A3 反证标本：旧判据在这只标本上**确实**判错 ───────────────────────
    ok(legacyAllowRetry(ctx) === false && legacyAllowRetry(afterUserResume) === true,
      'M1-A3 **反证标本**：同一份账喂**旧判据**（裸 `!ctx.sdk_failed`）——用户恢复之后仍是"不许重试"'
      + ' ⇒ 证明标本**确实踩中本病**（不是"新旧都不响"的空样本）；新判据在**同一只标本**上给出相反结论',
      `旧判据：恢复后 ${legacyAllowRetry(afterUserResume)} / 新判据：恢复后 ${!hasOpenSdkIncident(afterUserResume)}`);

    // ── 存量行（本轮之前写入的账只有布尔、没有时刻）─────────────────────────
    const legacyCtx: Record<string, unknown> = { [SDK_INCIDENT_KEY]: true };
    ok(hasOpenSdkIncident(legacyCtx) === true && sdkIncidentAt(legacyCtx) === '',
      'M1-A 存量账如实：老行只有布尔、没有起始时刻 ⇒ 仍读作"有未结事故"，时刻**留空不编**'
      + '（编一个时间出来就是"账上写着它不知道的事"）',
      `at="${sdkIncidentAt(legacyCtx)}"`);
    ok(closeSdkIncident({}) === false && closeSdkIncident(null) === false && closeSdkIncident(undefined) === false,
      'M1-A 无旗可结时返回 false（且不抛）——调用方据此决定要不要写库',
      '');

    // ── M1-F 键名不手抄：生产侧只从 `sdk-incident.ts` 取 ──────────────────────
    // `sdk_failed` 这个字面量只准出现在 sdk-incident.ts（定义处）；别处一律走函数。
    const rawExec = fs.readFileSync(EXEC_SRC, 'utf-8');
    const rawAiTask = fs.readFileSync(AITASK_SRC, 'utf-8');
    ok(countOcc(incidentCode, `'${SDK_INCIDENT_KEY}'`) === 1 && countOcc(incidentCode, `'${SDK_INCIDENT_AT_KEY}'`) === 1,
      'M1-F **键名一处真源**：两个键的面值各只在 `sdk-incident.ts` 出现 **1 次**（定义处）'
      + '（承 `feedback_enum_value_sweep_readers`：键名手抄多处 ⇒ 改一处漏一处必复发）',
      `sdk_failed ${countOcc(incidentCode, `'${SDK_INCIDENT_KEY}'`)} 处 · sdk_failed_at ${countOcc(incidentCode, `'${SDK_INCIDENT_AT_KEY}'`)} 处`);

    // ═══ M1-B / M1-C：文案与机器 ─═══════════════════════════════════════════
    // ⚠ 判据落在**去注释**的源码上（本批的订正注释里逐字引用了旧文案，拿原文判会被自己的注释判红）。
    //   **按符号切块**（不按行号——行号是位置、会漂），并配"扫描面非空"自证。
    const firstBranch = blockAt(execCode, 'if (!hasOpenSdkIncident(retryCtx))');
    const afterFirst = firstBranch ? execCode.slice(execCode.indexOf(firstBranch) + firstBranch.length) : '';
    const secondStop = afterFirst.indexOf('} finally {');
    const secondBranch = secondStop < 0 ? '' : afterFirst.slice(0, secondStop);
    crit('M1', firstBranch.length > 200 && secondBranch.length > 200,
      'M1-B **扫描面自证**：按符号配对切出「首次失败」与「二次失败」两块（各 > 200 字符）'
      + '——切错块/切空会让下面三条断言全部假绿',
      `首次块 ${firstBranch.length} 字符 · 二次块 ${secondBranch.length} 字符`);

    crit('M1', countOcc(firstBranch, '已自动重试一次') === 1 && countOcc(firstBranch, '将暂停任务') === 1,
      'M1-B 首次失败**只重试一次**且如实写下"若再次失败将暂停任务"',
      `文案命中：已自动重试一次 ${countOcc(firstBranch, '已自动重试一次')} 处 · 将暂停任务 ${countOcc(firstBranch, '将暂停任务')} 处`);
    crit('M1', countOcc(secondBranch, 'pauseTask(db,') === 1
      && countOcc(secondBranch, 'PAUSE_REASON_AI_SDK_UNAVAILABLE') === 1,
      'M1-B ★ **承诺的兑现者存在**（G3）：那句"将暂停任务"的兑现处**就在二次失败分支里**'
      + '（`pauseTask` + 本事故专属因由）——判据是"机器做了那件事"，**不是**"文案写了那几个字"',
      `二次块内 pauseTask ${countOcc(secondBranch, 'pauseTask(db,')} 处 · 专属因由 ${countOcc(secondBranch, 'PAUSE_REASON_AI_SDK_UNAVAILABLE')} 处`);
    crit('M1', countOcc(secondBranch, "status = 'failed'") === 0
      && countOcc(secondBranch, "'failed'") === 0,
      'M1-B **机器不再说反话**（T1 裁定）：二次失败分支里**零处**把状态写成 `failed`'
      + '（旧实现许诺"暂停"、做的是 `failed`——上一轮刚改过这句文案的前半句，后半句原样留着）',
      `status='failed' ${countOcc(secondBranch, "status = 'failed'")} 处 · 'failed' ${countOcc(secondBranch, "'failed'")} 处`);

    // ═══ M1-C：一次失败只发一条事件（G4）════════════════════════════════════
    crit('M1', countOcc(execCode, "eventBus.emit('task.failed', taskFailedPayload(db, taskId, projectId, 'sdk'") === 0,
      'M1-C **SDK 分支不再发 `task.failed`**：状态是 `paused`，告知由 `pauseTask` 的 `note` 走'
      + '（真库物证：一次失败两条事件 31086 `sdk` / 31087 `execute_error`）',
      `phase 'sdk' 的 emit ${countOcc(execCode, "eventBus.emit('task.failed', taskFailedPayload(db, taskId, projectId, 'sdk'")} 处 · 扫描面 ${execLines} 行`);
    crit('M1', countOcc(secondBranch, 'throw ') === 0,
      'M1-C **二次失败分支零 `throw`**：原先抛出去会冒到外层 catch 再发一条 `execute_error`'
      + '——"一条命发两条噩耗"的**唯一**进水口就在这里（改发事件是治标，堵住冒泡才是治本）',
      `throw ${countOcc(secondBranch, 'throw ')} 处`);

    // ═══ M1-D：不得 pause→resume→pause 自转 ════════════════════════════════
    crit('M1', countOcc(aiTaskCode, 'if (result.sdkExhausted) return;') === 2,
      'M1-D **两个 handler 各有一处 `sdkExhausted` 收尾**（首跑 `ai-task` + 恢复 `resume-ai-task`）'
      + '——漏掉任一处：那个 handler 见 `sdkFailed` 又入队 resume，与本次暂停构成死循环',
      `实测 ${countOcc(aiTaskCode, 'if (result.sdkExhausted) return;')} 处 · 扫描面 ${aiTaskLines} 行`);
    {
      const iEx1 = aiTaskCode.indexOf('if (result.sdkExhausted) return;');
      const iFail1 = aiTaskCode.indexOf('if (result.sdkFailed) {');
      const iEx2 = aiTaskCode.indexOf('if (result.sdkExhausted) return;', iEx1 + 1);
      const iFail2 = aiTaskCode.indexOf('if (result.sdkFailed) {', iFail1 + 1);
      crit('M1', iEx1 >= 0 && iEx2 > iEx1 && iFail1 > iEx1 && iFail2 > iEx2,
        'M1-D **顺序也对**：两处的 `sdkExhausted` 收尾都**先于**同 handler 的 `sdkFailed` 入队'
        + '（顺序反了则收尾永不可达，两处判据各自独立求值，不靠"恰好一处"蒙对）',
        `首跑 ${iEx1}→${iFail1} · 恢复 ${iEx2}→${iFail2}`);
    }

    // ═══ M1-E：因由如实（词表 + 可自愈档）══════════════════════════════════
    crit('M1', typeof PAUSE_REASON_AI_SDK_UNAVAILABLE === 'string' && PAUSE_REASON_AI_SDK_UNAVAILABLE.length > 0
      && pauseReasonLabel(PAUSE_REASON_AI_SDK_UNAVAILABLE).length > 0,
      'M1-E 新因由有面值、也有 label（有值才能上屏——GUI 横幅与 IM 通知共用这一份词表）',
      `码=${PAUSE_REASON_AI_SDK_UNAVAILABLE} · 人话=${pauseReasonLabel(PAUSE_REASON_AI_SDK_UNAVAILABLE)}`);
    crit('M1', isChildrenIncompletePause(JSON.stringify({ pause_reason: PAUSE_REASON_AI_SDK_UNAVAILABLE })) === false,
      'M1-E 该因由**不得**被认作"等子任务"：`isChildrenIncompletePause` 为假 ⇒ 调度器不把它当'
      + '可自愈的**时序**暂停（那是"子完成即自动放行"的档；本因必须等**人**看一眼）',
      `isChildrenIncompletePause=${isChildrenIncompletePause(JSON.stringify({ pause_reason: PAUSE_REASON_AI_SDK_UNAVAILABLE }))}`);

    // ═══ M1-F：用户恢复的那一笔确实落在"新事故"上 ═══════════════════════════
    crit('M1', countOcc(aiTaskCode, "if (payload.initiator === 'user') closeSdkIncident(rctx);") === 1,
      "M1-F **恢复路按入队者分流清旗**：`initiator === 'user'` 才清（引擎自动重试不传 `initiator`，"
      + '缺省即 `system`——**缺省值本身是契约**，承 `resume-ledger` 同款纪律）'
      + ' ⇒ "用户手动恢复 = 一次新事故"在**生产码里真的被写下了**，不只是纯函数里成立',
      `实测 ${countOcc(aiTaskCode, "if (payload.initiator === 'user') closeSdkIncident(rctx);")} 处`);
    crit('M1', countOcc(aiTaskCode, 'closeSdkIncident(clearCtx)') === 2,
      'M1-F **成功结账两处同形**：`ai-task` 与 `resume-ai-task` 的成功分支各一处，'
      + '都走 `closeSdkIncident`（连同 `sdk_failed_at` 一起清——只 `delete sdk_failed` 会留下孤儿时刻）',
      `实测 ${countOcc(aiTaskCode, 'closeSdkIncident(clearCtx)')} 处`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M3·G8】复用缓存：「判据改了」在机器里有没有一个可被读到的落点');
  {
    const validatorCode = strip(VALIDATOR_SRC);
    // zx_20261003 M8 就地改钉：finalize 门随执行体搬到 `control-finalize.ts`（判据仍"恰一处"，面随之走）。
    const controlCode = strip(FINALIZE_SRC);
    const validatorRaw = fs.readFileSync(VALIDATOR_SRC, 'utf-8');
    const validatorLines = stripKeepingLines(validatorRaw).length;

    // ── M3-0 扫描器自证（两侧标本）───────────────────────────────────────────
    const probeZero3 = countOcc('const nothing = 0;', 'criteriaVersion');
    const probeOne3 = countOcc('ov.push({ file: abs, criteriaVersion: V });', 'criteriaVersion');
    ok(probeZero3 === 0 && probeOne3 === 1,
      'M3-0 **扫描器自证（两侧标本）**：同一把计数器——不含该键名的串计 0、含该键名的串计 1'
      + ' ⇒ 下面依赖 `criteriaVersion` 的判据不是靠"扫了个空"恒绿',
      `probeZero=${probeZero3} / probeOne=${probeOne3}`);

    // ── M3-A 版本是**派生**的，不是手抄的常量（M3-b）─────────────────────────
    ok(/^[0-9a-f]{12}$/.test(VALIDATION_CRITERIA_VERSION),
      'M3-A 判据版本有值、形状可存可读（12 位十六进制摘要）',
      `版本=${VALIDATION_CRITERIA_VERSION} · 扫描面 ${validatorLines} 行`);
    ok(countOcc(validatorRaw, VALIDATION_CRITERIA_VERSION) === 0,
      'M3-A ★ **版本不是手抄常量**：整个 `output-validator.ts`（**含注释**）里**零处**出现该版本字面量'
      + ' ⇒ 它只可能是运行时从判据算出来的。'
      + '（若哪天有人改成 `const V = \'<某值>\'`，本行立刻红——那正是"逐轮滚长、漏改"的钉子形态）',
      `源码内出现 ${countOcc(validatorRaw, VALIDATION_CRITERIA_VERSION)} 处`);
    {
      // 派生材料**必须真的引用判据本体**：逐项在场（删任一项 ⇒ 这条红）——"由判据自身派生"的可证伪形状。
      const fpBlock = blockAt(validatorCode, 'export const VALIDATION_CRITERIA_VERSION');
      const parts: Array<[string, boolean]> = [
        ['sufficiencySystemTemplate.toString()', fpBlock.includes('sufficiencySystemTemplate.toString()')],
        ['sufficiencyAskSkeleton.toString()', fpBlock.includes('sufficiencyAskSkeleton.toString()')],
        ['SUFFICIENCY_WINDOW_DEFAULTS', fpBlock.includes('SUFFICIENCY_WINDOW_DEFAULTS')],
        ['ARCHETYPE_VALIDATION', fpBlock.includes('ARCHETYPE_VALIDATION')],
        ['DEFAULT_RULES', fpBlock.includes('DEFAULT_RULES')],
        ['p.pattern.source（正则源码）', fpBlock.includes('p.pattern.source')],
      ];
      ok(fpBlock.length > 100 && parts.every(([, has]) => has),
        'M3-A **派生材料真的引用判据本体**：两个问句模板的源码文本、窗口尺度、判型规则表（含**正则源码**，'
        + '`JSON.stringify(RegExp)` 会退化成 `{}`，故必须显式取 `.source`）逐项进指纹'
        + ' ⇒ 改判据必然改版本，不需要谁记得去同步',
        `指纹块 ${fpBlock.length} 字符 · 在场 ${parts.filter(([, h]) => h).length}/${parts.length}`
        + ` · 缺：${parts.filter(([, h]) => !h).map(([n]) => n).join('、') || '（无）'}`);
    }

    // ── M3-B 守卫跑**真实现**：四条件各自独立可证伪（M3-a/M3-c）──────────────
    // 造一份真文件（不用等价自造入参）：签名读的是**真 fs.statSync**。
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr20260923-m3-'));
    const docAbs = path.join(tmpDir, 'report.md');
    const docText = '# 报告\n\n本文件用于受控复跑：判据版本失配时，旧结论不得被复用。\n';
    fs.writeFileSync(docAbs, docText, 'utf-8');
    const realSig = fileSig(docAbs)!;
    /** 造一条"看起来完全可复用"的缓存条目（各字段按真实现的形状）。 */
    const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      file: docAbs, archetype: 'document', status: 'ok', sufficient: true,
      size: realSig.size, mtimeMs: realSig.mtimeMs,
      criteriaVersion: VALIDATION_CRITERIA_VERSION, ...over,
    });
    /** 走**生产路径**：先 `cachedOutputValidation` 读签名，再 `canReuseOutputValidation` 判可复用。 */
    const reuseOf = (e: Record<string, unknown>): boolean =>
      canReuseOutputValidation(cachedOutputValidation({ output_validations: [e] }, docAbs), 'document');

    ok(reuseOf(entry()) === true,
      'M3-B 夹具自证（**能复用**那一侧）：签名未变 + 判型一致 + 判据版本一致 ⇒ 复用为真'
      + ' ⇒ 下面那条"版本一变就不复用"不是恒假的空测试',
      `reuse=${reuseOf(entry())}`);
    ok(reuseOf(entry({ criteriaVersion: 'stale-00000000' })) === false,
      'M3-B ★★ **本批靶心**：**判据换了版**（文件一个字没动、判型也没变）⇒ 旧结论**不再被复用**'
      + '、重判发生（这正是 G8 的治点：M7 把问句改对之后，旧缓存让新问句**一次都没跑过**）',
      '版本 stale-00000000 ⇒ 复用为假');
    ok(reuseOf(entry({ criteriaVersion: undefined })) === false,
      'M3-B **存量条目**（M3 之前落的、**没有**该字段）⇒ `undefined !== 版本` ⇒ 视为版本不符'
      + '（M3-c：宁可重判一次，不可复用旧误判）',
      '缺字段 ⇒ 复用为假');
    ok(reuseOf(entry({ archetype: 'code' })) === false,
      'M3-B **判型那条仍在**（③ 未被新条件挤掉）：`.py` 拿文档规则得出的旧结论不得复用',
      '判型不符 ⇒ 复用为假');
    ok(reuseOf(entry({ status: 'unknown' })) === false,
      "M3-B **\"没结论\"不算结论**（② 仍在）：`status='unknown'`（LLM 不可用时的占位）不得当结论复用",
      'status=unknown ⇒ 复用为假');
    fs.appendFileSync(docAbs, '\n\n（追加一段，使 size 变化）\n', 'utf-8');
    ok(reuseOf(entry()) === false,
      'M3-B **签名那条仍在**（① 未被挤掉）：文件内容变了 ⇒ 签名不符 ⇒ 不复用'
      + '（用**真 fs.statSync** 取签名，不是造出来的等价入参）',
      `size ${realSig.size} → ${fileSig(docAbs)?.size} ⇒ 复用为假`);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // ── M3-C 写读同源：一处真源，别处不手抄 ─────────────────────────────────
    // ⚠ zx_20260929 M9：run 收口门随收尾段落到 `core/exec-close.ts` ⇒ 执行体侧取并集（减工具段）。
    //   两处仍**分别**取面、各判"恰一处"——整份换成含工具段的 `engineSrc()` 会把 finalize 门那处
    //   同时计进两侧，"各一处"退化成"合计 ≥1"，是放宽。
    ok(countOcc(execSideCode, 'criteriaVersion: VALIDATION_CRITERIA_VERSION') === 1
      && countOcc(controlCode, 'criteriaVersion: VALIDATION_CRITERIA_VERSION') === 1,
      'M3-C **两个写点同源**：run 收口（执行体侧）与 finalize 门（`control-finalize.ts`，M8 就地改钉）各一处，'
      + '都取同一个 `VALIDATION_CRITERIA_VERSION`（写点手抄版本值 ⇒ 与判据脱钩，version 形同虚设）',
      `执行体侧 ${countOcc(execSideCode, 'criteriaVersion: VALIDATION_CRITERIA_VERSION')} 处 · `
      + `control ${countOcc(controlCode, 'criteriaVersion: VALIDATION_CRITERIA_VERSION')} 处（扫描面 ${execSideLines}+${controlCode.split('\n').length} 行）`);
    ok(countOcc(execSideCode, 'canReuseOutputValidation(hit, arch)') === 1
      && countOcc(execSideCode, 'hit.entry.archetype === arch') === 0,
      'M3-C ★ **旧判据不在了**：守卫改调一处真源 `canReuseOutputValidation(hit, arch)`，'
      + '而原先内联的四条与（`hit && hit.sigOk && … && hit.entry.archetype === arch`）**零处残留**'
      + '——只加新函数、把老判据留在原地，正是本轮的病（"机器还念旧账"）',
      `新守卫 1 处？${countOcc(execSideCode, 'canReuseOutputValidation(hit, arch)')} · 内联旧判据 ${countOcc(execSideCode, 'hit.entry.archetype === arch')} 处`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M4·G5/G6/G7】建子任务这条路：门自己关的，锁自己上的');
  {
    const acctCode = strip(ACCT_SRC);
    const acctLines = stripKeepingLines(fs.readFileSync(ACCT_SRC, 'utf-8')).length;
    // zx_20260929 M9：两档名单的**消费点**随步回调搬入 `core/exec-step.ts`（`OUTPUT_ONLY_TOOLS` 两处），
    //   裸读 `agent-executor.ts` 会扫成 0 处、读起来像"名单没人读"（真回归的形状）——实为落点搬家。
    //   面换成「执行体 ∪ `exec-*.ts`」（`lib/rr-engine-src.ts` 一处真源）。**这只会更严**：
    //   `BUDGET_*_TOOLS` 是模块级 const 而非 `StepScope` 成员 ⇒ 无 `d.` 可还原，针脚字面量原样可比。
    const agentCode = execSideCode;

    // ── M4-0 扫描器自证（两侧标本）───────────────────────────────────────────
    const probeZero4 = countOcc('const nothing = 0;', 'unclaimedMilestones');
    const probeOne4 = countOcc('const x = unclaimedMilestones(a, b);', 'unclaimedMilestones');
    ok(probeZero4 === 0 && probeOne4 === 1,
      'M4-0 **扫描器自证（两侧标本）**：同一把计数器——不含该符号的串计 0、含该符号的串计 1'
      + ' ⇒ 下面依赖 `unclaimedMilestones` 的判据不是靠"扫了个空"恒绿',
      `probeZero=${probeZero4} / probeOne=${probeOne4}`);

    // ── M4-B 预算名单（G6）：95% 档不再亲手关掉 `create_task` ────────────────
    crit('M4', BUDGET_WARN_TOOLS.includes('create_task'),
      'M4-B ★ **95% 档（band 4）保留 `create_task`**（T2 裁定：入 WARN 档）——'
      + '它不读盘、不执行、不回传上下文，"把活派出去"恰是预算告警时最该继续的能力。'
      + '真库标本 `a290ae2b` 的 07:13:45 会话行里，一个被题面要求"逐里程碑建子任务"的任务，'
      + '在花到 95% 的那一刻被本名单亲手关掉了这个工具',
      `WARN 档 ${BUDGET_WARN_TOOLS.length} 件 · 含 create_task = ${BUDGET_WARN_TOOLS.includes('create_task')}`);
    crit('M4', !BUDGET_HARD_STOP_TOOLS.includes('create_task'),
      'M4-B **98% 档（band 5）仍禁**（T2：≥4 保留、≥5 禁）——'
      + '**不是两处都加**：到硬上限那一步系统的要求是收尾，不是再开新摊子',
      `HARD 档 ${BUDGET_HARD_STOP_TOOLS.length} 件 · 含 create_task = ${BUDGET_HARD_STOP_TOOLS.includes('create_task')}`);
    crit('M4', budgetBandOf(0.94) === 3 && budgetBandOf(0.95) === 4 && budgetBandOf(0.98) === 5,
      'M4-B 档位取**真实现** `budgetBandOf`：94% ⇒ 3（尚未宣告超限）、95% ⇒ 4、98% ⇒ 5'
      + ' ⇒ 上面两条名单断言确实挂在"WARN 档 / HARD 档"这两个档上，而不是自我印证的悬空常量',
      `94%→${budgetBandOf(0.94)} / 95%→${budgetBandOf(0.95)} / 98%→${budgetBandOf(0.98)}`);
    crit('M4', countOcc(agentCode, 'new Set<string>(BUDGET_WARN_TOOLS)') === 1
      && countOcc(agentCode, 'new Set<string>(BUDGET_HARD_STOP_TOOLS)') === 1,
      'M4-B **名单真的被那两个档消费**：band 4 分支以 `BUDGET_WARN_TOOLS` 为准、band 5 分支以'
      + '`BUDGET_HARD_STOP_TOOLS` 为准（各一处）——名单改了但没人读，等于没改',
      `WARN 消费 ${countOcc(agentCode, 'new Set<string>(BUDGET_WARN_TOOLS)')} 处 · `
      + `HARD 消费 ${countOcc(agentCode, 'new Set<string>(BUDGET_HARD_STOP_TOOLS)')} 处`);

    // ── M4-A/M4-C 里程碑抽取（**自指标签**）+ 承接计算（两侧标本）────────────
    ok(acctLines > 300 && acctCode.includes('export function unclaimedMilestones'),
      'M4-A/C 判据落在一处真源 `task-accounting.ts`（两个消费者共用，不分家）',
      `扫描面 ${acctLines} 行`);
    ok(milestoneOwnLabel('M4 建子任务这条路') === 'M4' && milestoneOwnLabel('20260917 方案实施') === null
      && milestoneRefsIn('见 M3 与 M4', 'M3').size === 2,
      'G-1 真源在位：`milestoneOwnLabel` / `milestoneRefsIn` 可调用且行为正确'
      + '（静态 import ⇒ 删名或改签名即**编译期失败**，而不是"扫了个空、静默假绿"）',
      `ownLabel('M4 建子任务这条路')=${milestoneOwnLabel('M4 建子任务这条路')} · `
      + `refs={${[...milestoneRefsIn('见 M3 与 M4', 'M3')].join(',')}}`);
    // 标本一：**自指标签**——标题以 M\d+ 开头 = 本任务**自己就是那枚里程碑** ⇒ 不得再要求一个同名子任务。
    const selfLabel = declaredMilestones('M2(F2)决策指令Schema契约化', '');
    const realDecl = declaredMilestones('20260917 方案实施', '排期与里程碑：逐里程碑 M3、M4 建子任务执行');
    crit('M4', selfLabel.length === 0 && realDecl.join(',') === 'M3,M4',
      'M4-A ★ **两侧标本**：`declaredMilestones` 对**自指标签**任务（真库 40 条此类标题，其中 36 条 0 子任务）'
      + '得出**空**，对**真的声明了要拆**的题面得出 M3/M4 ⇒ 判据可辨，不是"两边都不响"。'
      + '缺了这只标本，一个叫「M4 建子任务这条路」的**叶子**任务会被要求"建一个 M4 子任务"——自指、永不满足',
      `自指标签 ⇒ [${selfLabel.join(',')}] · 真声明 ⇒ [${realDecl.join(',')}]`);
    // 标本二：**承接**计算——真库 `a290ae2b` 的形状：板上 M0–M5 齐全、同名子任务 0 个。
    const noChild = unclaimedMilestones(['M0', 'M1', 'M2', 'M3', 'M4', 'M5'], []);
    const someChild = unclaimedMilestones(['M0', 'M1', 'M2', 'M3', 'M4', 'M5'], ['M3 F3 DSA 持仓读取归一 + 修 h17 假阴']);
    crit('M4', noChild.join(',') === 'M0,M1,M2,M3,M4,M5' && someChild.join(',') === 'M0,M1,M2,M4,M5',
      'M4-C ★ **两侧标本**：`unclaimedMilestones` 在**零子任务**时把六枚全报出来（这正是标本那一刻的真相——'
      + '此前无人记录），有一个叫 `M3 …` 的子任务时只报余下五枚 ⇒ 差额算得准，不是恒空或恒满',
      `0 子任务 ⇒ ${noChild.length} 枚 · 1 个子任务(M3) ⇒ ${someChild.length} 枚`);
    // 同源：两处调用点都走这一个函数，手写内联判据零残留（"只加新函数、把老判据留在原地"正是本轮病）
    crit('M4', countOcc(strip(FINALIZE_SRC), 'unclaimedMilestones(') === 2
      && countOcc(strip(FINALIZE_SRC), '!have.has(w)') === 0
      && countOcc(strip(FINALIZE_SRC), '!childMs.has(ms)') === 0,
      'M4-A/C **两处同源、内联判据零残留**：收尾缺口核查与登记差额各调一次 `unclaimedMilestones`，'
      + '原先各写一份的 `filter(w => !have.has(w))` 形态已除',
      `调用 ${countOcc(strip(FINALIZE_SRC), 'unclaimedMilestones(')} 处 · `
      + `内联 ${countOcc(strip(FINALIZE_SRC), '!have.has(w)') + countOcc(strip(FINALIZE_SRC), '!childMs.has(ms)')} 处`);

    // ── M4-A 静态：短路去掉之后，**两条路并存**且"报"那条真的可达 ────────────
    const gapBlock = blockAt(strip(FINALIZE_SRC), 'const missing = unclaimedMilestones(');
    const innerGuard = blockAt(gapBlock, 'if (myChildren.length > 0)');
    crit('M4', gapBlock.length > 100 && innerGuard.includes('return JSON.stringify({ error: msg'),
      'M4-A 有子任务 ⇒ **维持原驳回**（2026-09-04 D2 行为分毫未动）：编排父的证据就在眼前，'
      + '声明了 M 却没建对应子任务，照旧拦',
      `缺口块 ${gapBlock.length} 字符 · 内层 guard ${innerGuard.length} 字符`);
    crit('M4', gapBlock.includes('checks.push') && !innerGuard.includes('checks.push'),
      'M4-A ★ **短路已去**：`checks.push` 落在 `if (myChildren.length > 0)` 的**之外**'
      + ' ⇒ 0 子任务时缺口**照报**（旧形态把整段逻辑包在同一个 guard 里，`checks.push` 那条路'
      + '在 0 子任务时**根本不可达**——这就是 G5）。'
      + '⚠ 但不驳回：`题面出现 M\\d+` ≠ `承诺拆子任务`（全库回放实测，按题面字面判缺口会驳回'
      + ' **62/62 条已成功完成**的任务），报出来是职责、替用户判定该不该拆是越界',
      `缺口块含 checks.push = ${gapBlock.includes('checks.push')} · 内层 guard 含 = ${innerGuard.includes('checks.push')}`);

    // ── M4-C 静态：旗**语义未改**，差额**如实写实际值**并报出来 ─────────────
    crit('M4', countOcc(strip(FINALIZE_SRC), 'bctx.plan_milestones_registered = true;') === 1,
      'M4-C 旗本身**语义未改**（仍写 `true`）——它承诺的是"板上确有行"，而**那句为真**'
      + '（标本 a290ae2b 板上 M0–M5 确有其行）。把条件改成"必须有同名子任务才写 true"'
      + '是**用一种名实不符换另一种**（事实会被写反），故不采用',
      `写点 ${countOcc(strip(FINALIZE_SRC), 'bctx.plan_milestones_registered = true;')} 处`);
    crit('M4', countOcc(strip(FINALIZE_SRC), 'bctx.milestones_without_child_tasks = uncovered;') === 1
      && countOcc(strip(FINALIZE_SRC), '已在板上但尚无同名子任务') === 1,
      'M4-C ★ **差额如实写实际值 + 报出来**：`milestones_without_child_tasks` 入 ctx（一处写），'
      + '并在 `finalize_checks` 里给出人话告警 —— "登记到板" ≠ "已有子任务承接"，'
      + '此前二者的差额**全库无人记录**，标本崩掉时用户看到的仍是一副"里程碑都安排好了"的样子',
      `字段写点 ${countOcc(strip(FINALIZE_SRC), 'bctx.milestones_without_child_tasks = uncovered;')} 处 · `
      + `告警 ${countOcc(strip(FINALIZE_SRC), '已在板上但尚无同名子任务')} 处`);
    ok(countOcc(strip(FINALIZE_SRC), 'milestones_without_child_tasks') === 1,
      'M4-C 该字段**只此一处**写（无第二处手抄写入 ⇒ 不会两处各写一份、日后分家）',
      `全文件出现 ${countOcc(strip(FINALIZE_SRC), 'milestones_without_child_tasks')} 处`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M5·G9/G10】门禁收谁进门（按扩展名）· 采样采到哪（生成物不进面）');
  {
    // ── M5-0 扫描面自证（"零处/恰一处"类判据的前置；防"扫了个空"恒绿）──────────
    const scanProbe = 'const DOC_GATE_EXTS = /x/;\nfoo(DOC_GATE_EXTS);\n';
    ok(countOcc(scanProbe, 'DOC_GATE_EXTS') === 2 && countOcc('const nothing = 0;\n', 'DOC_GATE_EXTS') === 0,
      'M5-0 计数器**两侧标本**：真串里数得出 2、假串里数得出 0（本组后续"恰 N 处"断言的扫描面自证）',
      `${countOcc(scanProbe, 'DOC_GATE_EXTS')} / ${countOcc('const nothing = 0;\n', 'DOC_GATE_EXTS')}`);

    // ── M5-A 源码形状钉：文档档的收人尺**只此一把**，且**不含 `.txt`** ──────────────
    //   ⚠ 就地改钉（zx_20261003 M1 / 裁定 K-6）：旧尺 `DOC_TARGET_EXT_RE`（"成员资格 = 扩展名 ∈ {.md,.markdown}"）
    //     已随 K-6 撤除，门禁成员资格改为**结构性判据** `isGateArtifact`（族可判型）、文档这一档的**显式收窄**
    //     落在 `DOC_GATE_EXTS`（`.md`/`.markdown`/`.pdf`）。本组钉的**裁定内容不变**（T3：`.txt` 出局、
    //     `.md`/`.markdown` 在场），只是载体换成 K-6 的新符号——改钉手法同 `rr_zx_20260922_1` M2 组。
    const exec5 = strip(EXEC_SRC);
    const ws5 = strip(WS_SRC);
    const reLine = exec5.split('\n').find((l) => l.includes('const DOC_GATE_EXTS')) || '';
    crit('M5', countOcc(exec5, 'const DOC_GATE_EXTS') === 1,
      'M5-A 文档档的收人尺**只有一把**：`DOC_GATE_EXTS` 定义恰 1 处（多一处定义即多一个收人点）',
      `定义 ${countOcc(exec5, 'const DOC_GATE_EXTS')} 处`);
    crit('M5', !/\.txt/.test(reLine) && /\.md/.test(reLine) && /\.markdown/.test(reLine),
      'M5-A ★（G9 · 裁定 T3 仍成立）尺里**没有 `.txt`**、仍有 `.md`/`.markdown` —— 扩展名分不开"人写的说明"与'
      + '"机器写的报告"（surefire 的 `*.txt` 353 B 被当"不充分的文档"判过），故**宁可少收**（K-6 后由 `DOC_GATE_EXTS` 承载）',
      `尺面 = ${reLine.trim()}`);

    // ── M5-A′ 行为侧：**跑生产真实现** `docValidationTargets`（真文件 + 真 `isFileDelivered`）──
    //    ⚠ 只在源码上验正则形状是"读字面量"，验不了"它真的把 `.txt` 请出门"。
    const wsA = fs.mkdtempSync(path.join(os.tmpdir(), 'rr230923-m5a-'));
    const writeA = (rel: string, body: string): string => {
      const abs = path.join(wsA, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
      return abs;
    };
    const mdRel = '设计说明.md';
    const markdownRel = '实施报告.markdown';
    const txtRel = 'surefire-reports/com.fundevelop.payment.yeepay.YeepayAmountUtilsTest.txt';
    const xmlRel = 'pom.xml';
    writeA(mdRel, '# 设计说明\n\n正文……\n');
    writeA(markdownRel, '# 实施报告\n\n结论……\n');
    writeA(txtRel, 'Tests run: 3, Failures: 0, Errors: 0, Skipped: 0\n');   // 353 B 量级的机器报告
    writeA(xmlRel, '<project/>\n');
    const dbA = new DatabaseSync(':memory:');
    dbA.exec('CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, acceptance_criteria TEXT)');
    // ⚠ 夹具按**生产 DDL**（`database.ts` 的 `wa_deliverables`）搭：K-6 后取数 SQL 经 `docNotProbe()` 读
    //   `COALESCE(file_path, name)`，少了 `name` 列会让 SQL 抛 `no such column: name`、被 `docValidationTargets`
    //   的 try/catch 吞掉 ⇒ **已注册交付物那一支整支静默为空**、`relA=[]`（"该命中"侧也随之假红）。
    //   （承 auto-memory `feedback_rr_fixture_production_order`：夹具比生产宽松，断言就只是在自我印证。）
    dbA.exec("CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, file_path TEXT, name TEXT DEFAULT '', type TEXT)");
    dbA.prepare('INSERT INTO wa_tasks (id, title, description, acceptance_criteria) VALUES (?,?,?,?)')
      .run('T1', '实施后端方案', '照方案实施并交付', '');      // ⚠ 题面**不含**任何文件名 ⇒ 走的就是"交付物登记"这一支
    const insA = dbA.prepare('INSERT INTO wa_deliverables (id, task_id, file_path, type) VALUES (?,?,?,?)');
    let sA = 0;
    for (const r of [mdRel, markdownRel, txtRel, xmlRel]) insA.run(`d${sA++}`, 'T1', r, 'doc');   // **全登记 doc**（照执行体办事的样子）
    const relA = docValidationTargets(dbA as never, 'T1', wsA).map((p) => path.relative(wsA, p).split(path.sep).join('/'));
    crit('M5', relA.includes(mdRel) && relA.includes(markdownRel),
      'M5-A′ **该命中**：`.md` / `.markdown` 登记 `doc` ⇒ **进集**（闸门没被削成恒空集——这是后面每条否定断言的前提）',
      `进集 ${relA.length} 项：${relA.join(' · ')}`);
    crit('M5', !relA.includes(txtRel),
      'M5-A′ ★ **该不命中（靶心）**：surefire 机器报告 `*.txt`（内容 353 B 量级）**即便登记 `doc`** 也**不进集**'
      + ' —— 这正是 G9 的病灶：它曾被当"不充分的文档"判，而它根本不是文档',
      '');
    crit('M5', relA.includes(xmlRel),
      'M5-A′ **该命中（K-6 就地改钉 / 方向反转）**：`pom.xml` 在 zx_20260923 时被"非代码即文档"的补集尺请出门；'
      + 'K-6 后它是 **configuration 族（可判型）** ⇒ **重新进集**、走快检腿（这正是 K-6 的靶心：验得了与不误判同时成立）',
      `进集 ${relA.length} 项`);

    // ── M5-B 采样面：`SKIP_DIRS` 补 `target`，**跑生产真实现** `isSampledWorkingFile` ──
    const sampled = (name: string, rel: string): boolean => isSampledWorkingFile(name, rel);
    crit('M5', countOcc(ws5, 'const SKIP_DIRS') === 1,
      'M5-B 采样面的尺**只此一把**（`SKIP_DIRS` 定义恰 1 处，两个消费者读它、不各写一份）',
      `定义 ${countOcc(ws5, 'const SKIP_DIRS')} 处`);
    crit('M5', /target/.test(ws5.split('\n').find((l) => l.includes('const SKIP_DIRS')) || ''),
      'M5-B ★（G10）`SKIP_DIRS` 里**有 `target`** —— Maven/Gradle/Cargo 的构建产物目录，'
      + '与既有 `dist`/`build`/`output` 同款取舍（生成物不进采样面）',
      `尺面 = ${(ws5.split('\n').find((l) => l.includes('const SKIP_DIRS')) || '').trim().slice(0, 120)}…`);
    crit('M5', sampled('a.md', 'src/a.md') && sampled('b.md', 'docs/b.md'),
      'M5-B **该命中**：普通源码/文档路径照旧**在**采样面内（否则"补 target"会退化成"什么都看不见"）',
      `src/a.md=${sampled('a.md', 'src/a.md')} · docs/b.md=${sampled('b.md', 'docs/b.md')}`);
    crit('M5', !sampled('b.txt', 'target/surefire-reports/b.txt') && !sampled('A.class', '参考项目/x/target/classes/A.class'),
      'M5-B ★ **该不命中（靶心）**：`target/` **下**（含**嵌套**路径 `…/target/classes/…`）的产物**不在**采样面'
      + ' —— 病灶形状正是嵌套（本任务 103 条 `/target/` 交付物：`class` 43 / `lst` 26 / `jar` 12）',
      `target/b.txt=${sampled('b.txt', 'target/surefire-reports/b.txt')} · 嵌套=${sampled('A.class', '参考项目/x/target/classes/A.class')}`);
    crit('M5', sampled('a.md', 'targets/a.md'),
      'M5-B **反证（不过宽）**：目录名 `targets`（多一个 s）**不**被误伤 —— 判据是 `/target/` 整段，不是 `target` 子串',
      `targets/a.md=${sampled('a.md', 'targets/a.md')}`);
    crit('M5', !sampled('a.md', 'dist/a.md') && !sampled('a.md', 'build/a.md') && !sampled('a.md', 'output/a.md'),
      'M5-B **既有边界不回归**：`dist`/`build`/`output` **仍**在跳过面内（补 `target` 是加一条，不是换掉三条）',
      '');

    // ── M5-B′ 端到端：**跑生产真实现** `listFilesWrittenSince`（真临时目录 + 真 mtime）──
    //    它才是"子进程落盘补登记"的取数口 ⇒ 证得了它，才证得了"`target/` 下的产物不再被补登记为交付物"。
    {
      const wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'rr230923-m5b-'));
      const w = (rel: string): void => {
        const abs = path.join(wsB, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, 'x');
      };
      w('src/main.java');
      w('docs/说明.md');
      w('target/classes/Main.class');
      w('target/surefire-reports/Report.txt');
      const since = Date.now() - 60_000;
      let found: string[] = [];
      try { found = await listFilesWrittenSince(wsB, since); } catch { found = []; }
      const relB = found.map((p) => path.relative(wsB, p).split(path.sep).join('/'));
      crit('M5', relB.includes('src/main.java') && relB.includes('docs/说明.md'),
        'M5-B′ **该命中**：窗口内写出的**源码/文档**照旧盘点得到（先立这一侧，后面的否定断言才不是空的）',
        `盘点 ${relB.length} 项：${relB.join(' · ')}`);
      crit('M5', !relB.some((r) => r.startsWith('target/')),
        'M5-B′ ★ **该不命中（靶心）**：窗口内写出的 `target/**`（`classes/*.class`、`surefire-reports/*.txt`）'
        + '**一项都不在盘点结果里** ⇒ 不再经 `registerFilesWrittenByCommand` 被补登记为 `doc` 交付物（G10 的来路）',
        `target/ 命中 ${relB.filter((r) => r.startsWith('target/')).length} 项`);
    }

    // ── M5-C 链路在场：抽样面 → 命令窗口盘点 → 补登记（三处各 1 处，不各写一份）──
    crit('M5', countOcc(exec5, 'await listFilesWrittenSince(') === 1
      && countOcc(exec5, 'ensureDocDeliverable(db, {') >= 1,
      'M5-C 链路在场：`registerFilesWrittenByCommand` 是**唯一**取数口（`await listFilesWrittenSince(` 恰 1 处）'
      + '⇒ 采样面收窄**确实**传到了"补登记"这一端，而不是只改了快照那一路',
      `取数口 ${countOcc(exec5, 'await listFilesWrittenSince(')} 处 · 登记调用 ${countOcc(exec5, 'ensureDocDeliverable(db, {')} 处`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M6·G11/G12/G16】账要能自己翻篇（失败的唯一写手 · 额度归还 · 出口可达）');
  {
    const mainScan = scanMainSources();
    const terminal6 = strip(TERMINAL_SRC);
    const aiTask6 = strip(AITASK_SRC);
    const proj6 = strip(PROJECTOR_SRC);
    const sched6 = strip(SCHEDULER_SRC);
    const sh6 = strip(SELFHEAL_SRC);
    const exec6 = strip(EXEC_SRC);

    // ── M6-0 扫描面自证（"恰 N 处"类判据的前置；防空扫恒绿）────────────────────
    crit('M6', mainScan.files >= 100 && mainScan.lines >= 10_000,
      'M6-0 扫描面自证：全树 `.ts` 真读到了（不是扫了个空而恒绿）',
      `扫到 ${mainScan.files} 个 .ts / ${mainScan.lines} 行`);

    // ── M6-A ★★ 靶心：`failed` 全树**只有一个写手** ─────────────────────────────
    //   ⚠ 用 `wa_tasks SET status = 'failed'` 而非 `SET status = 'failed'`——后者是**三张表**共有的子串
    //     （`wa_jobs` 超时、`wa_im_conversations` 补发也这么写），拿它当判据会把别的表算进来。
    crit('M6', countOcc(mainScan.text, "wa_tasks SET status = 'failed'") === 2
      && countOcc(terminal6, "wa_tasks SET status = 'failed'") === 2,
      'M6-A ★ **`failed` 只有一个写手**：全树出现 `wa_tasks SET status = \'failed\'` **恰 2 处**，'
      + '**两处都在 `task-terminal.ts` 里**（带 `at` 与带库钟的两个分支）⇒ 六个原写点全走 `markTaskFailed`，'
      + '谁再手写一句 SQL 就直接翻红（G12 的来路就是"七个写点各写一遍、没人翻账"；'
      + '写点数 zx_20260930 M11-3 起 7→6，见下一条）',
      `全树 ${countOcc(mainScan.text, "wa_tasks SET status = 'failed'")} 处 · task-terminal 内 ${countOcc(terminal6, "wa_tasks SET status = 'failed'")} 处`);

    //   ⚠ zx_20261012_2 批五 M5 起，ai-task 两处与投影器一处**带上了 `reason`**（失败因由交唯一写手，
    //     由它一处发带因 IM）。故针眼按下标形状**前移**到 `markTaskFailed(db, taskId,`（尾随逗号）与
    //     `…{ at: event.timestamp`（去掉收口 `}`）——仍逐点钉住"这一处确实接线了"，非放宽。
    crit('M6', countOcc(exec6, 'markTaskFailed(db, taskId)') === 2
      && countOcc(aiTask6, 'markTaskFailed(db, taskId,') === 2
      && countOcc(sched6, 'markTaskFailed') === 0
      && countOcc(sh6, 'markTaskFailed(db, row.id, { expectStatus: ') === 1
      && countOcc(proj6, 'markTaskFailed(this.db, taskId, { at: event.timestamp') === 1,
      'M6-A 六个原写点**逐个接线**（执行器 2 · ai-task 2 · 自愈 1 · **事件投影 1**），**调度器 0**——'
      + 'zx_20260930 M11-3「看门狗归一」：`task-scheduler.checkTimeouts` 的心跳超时不再落 `failed`，'
      + '改与自愈监视器**共用一个裁定者** `self-healing-monitor.reclaimStaleExecutingTask`（`paused` + `exec_timeout`，'
      + '可救）。同一因（无心跳）此前两果（`failed` 终态 vs `paused` 可救）、取决于哪个看门狗先扫到；'
      + '写点由七减一，判据随之 1→0——**生产先减、判据跟着减**，不是放宽（本数若再动即红）。'
      + '第六处在事件溯源侧，最易漏；本仓无"由 `wa_event_log` 重建库"的回放路（投影器只订阅活体总线），'
      + '故它是在线的**第二写点**：谁最后落笔决定账的形状',
      `执行器 ${countOcc(exec6, 'markTaskFailed(db, taskId)')} · ai-task ${countOcc(aiTask6, 'markTaskFailed(db, taskId,')} · 调度器 ${countOcc(sched6, 'markTaskFailed')} · 投影 ${countOcc(proj6, 'markTaskFailed(this.db, taskId, { at: event.timestamp')}`);

    // ── M6-B ★ 行为侧：`markTaskFailed` **跑生产真实现**（真内存库 + §1.7 标本形状）──
    const mkTasksDb = (): InstanceType<typeof DatabaseSync> => {
      const d = new DatabaseSync(':memory:');
      d.exec('CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, status TEXT, context_json TEXT, quality_score REAL, updated_at TEXT)');
      return d;
    };
    const ctxOf = (d: InstanceType<typeof DatabaseSync>, id: string): Record<string, unknown> =>
      JSON.parse((d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json) as Record<string, unknown>;
    const rowOf = (d: InstanceType<typeof DatabaseSync>, id: string): { status: string; quality_score: number | null; updated_at: string } =>
      d.prepare('SELECT status, quality_score, updated_at FROM wa_tasks WHERE id = ?').get(id) as { status: string; quality_score: number | null; updated_at: string };

    // §1.7 的标本形状：`status = failed` 的同时，ctx 里顶着**上一次 run（02:31:29）**的判卷。
    const STALE_CTX: Record<string, unknown> = {
      completion_quality: { score: 90, goal_achieved: false, via: 'run_close', feedback: '质量: excellent (本任务登记155条(1KB), 60步, 700K tokens [过早结束])' },
      acceptance_check: { checked_at: '2026-09-23T02:31:29.943Z', verified: false, reason: 'output_insufficient', criteria_total: 0, passed_total: 0 },
      goal_achieved: false,
    };
    const dbT = mkTasksDb();
    const insT = dbT.prepare('INSERT INTO wa_tasks (id, status, context_json, quality_score, updated_at) VALUES (?,?,?,?,?)');
    insT.run('SPEC', 'paused', JSON.stringify(STALE_CTX), 90, '2026-09-23T02:31:29.000Z');
    insT.run('CLEAN', 'paused', JSON.stringify({ goal_achieved: false, task_goal: { goal: '照方案实施' } }), null, '2026-09-23T02:00:00.000Z');
    insT.run('CAS', 'executing', JSON.stringify(STALE_CTX), 90, '2026-09-23T02:10:00.000Z');
    insT.run('AT', 'executing', JSON.stringify({ goal_achieved: true }), 55, '2026-09-23T02:20:00.000Z');

    // 先立病：标本行**调用前确实**顶着 90 分（否则"清掉了"是空断言——本仓纪律：两侧标本都要试）
    const beforeSpec = ctxOf(dbT, 'SPEC');
    crit('M6', (beforeSpec.completion_quality as { score?: number })?.score === 90
      && (beforeSpec.acceptance_check as { verified?: boolean })?.verified === false,
      'M6-B 先立病：标本行（`paused` + `completion_quality.score=90` + 未核验的 `acceptance_check`）'
      + '**在调用前确实**长这样 ⇒ §1.7 的形状就位，"清掉了"不是空断言',
      `score=${(beforeSpec.completion_quality as { score?: number })?.score} · via=${(beforeSpec.completion_quality as { via?: string })?.via}`);

    const rSpec = markTaskFailed(dbT as never, 'SPEC');
    const afterSpec = ctxOf(dbT, 'SPEC');
    const rowSpec = rowOf(dbT, 'SPEC');
    crit('M6', rowSpec.status === 'failed' && rSpec.changed === true && rSpec.pageTurned === true,
      'M6-B 状态行翻到 `failed` 且**账页也翻了**（`pageTurned` 由假转真——正面断言，不是"不抛"）',
      `changed=${rSpec.changed} · pageTurned=${rSpec.pageTurned}`);
    crit('M6', afterSpec.completion_quality === undefined && afterSpec.acceptance_check === undefined,
      'M6-B ★**靶心**（§4 判据）：`failed` 的任务**不再带** `completion_quality` / `acceptance_check` ——'
      + '一次 SDK 崩溃不再被读成"质量 excellent / 90 分"（GUI 详情页读的就是前者）',
      `余键 ${Object.keys(afterSpec).join(',') || '（空）'}`);
    crit('M6', afterSpec.goal_achieved === false,
      'M6-B 顶层 `goal_achieved` 如实置 **false**（**不删**——顶层那份是给 SQL 直读的，删了就成了"没这笔账"而非"没达成"）',
      `goal_achieved=${String(afterSpec.goal_achieved)}`);
    crit('M6', rowSpec.quality_score === null,
      'M6-B `quality_score` **列**一并置 NULL —— 该列是 `completion_quality.score` 的双写，'
      + '不清则失败任务仍按 90 分进 `project-analytics` 的项目均质与"高分已完成"榜',
      `quality_score=${String(rowSpec.quality_score)}`);

    // 该不命中：**没有**陈旧账的行 ⇒ 不白写库（投影器每次 `task.failed` 都会过一遍这里）
    const rClean = markTaskFailed(dbT as never, 'CLEAN');
    crit('M6', rClean.changed === true && rClean.pageTurned === false && rowOf(dbT, 'CLEAN').status === 'failed',
      'M6-B **该不命中**：干净行（无账可翻）状态照翻、`pageTurned` 为假、ctx **一个字节都不动** ⇒ 幂等',
      `pageTurned=${rClean.pageTurned} · ctx=${JSON.stringify(ctxOf(dbT, 'CLEAN'))}`);

    // CAS 该不命中：自愈路原有的 `AND status='pending'` 语义**不得**丢
    const rCas = markTaskFailed(dbT as never, 'CAS', { expectStatus: 'pending' });
    crit('M6', rCas.changed === false && rowOf(dbT, 'CAS').status === 'executing'
      && (ctxOf(dbT, 'CAS').completion_quality as { score?: number })?.score === 90,
      'M6-B **CAS 该不命中**：`expectStatus: \'pending\'` 而此刻是 `executing` ⇒ 状态不翻、'
      + '**账也不动**（自愈路"扫描与写入之间可能已被别的路放行"的守卫语义逐字保住）',
      `status=${rowOf(dbT, 'CAS').status} · changed=${rCas.changed}`);

    // 投影路：`at` 取**事件时刻**（本路刻意不取库钟）
    const rAt = markTaskFailed(dbT as never, 'AT', { at: '2026-09-23T03:34:42.000Z' });
    crit('M6', rowOf(dbT, 'AT').updated_at === '2026-09-23T03:34:42.000Z' && rAt.pageTurned === true,
      'M6-B 投影路 `updated_at` **取事件时刻**（`at`），不取库钟 ⇒ 事件溯源侧的时间语义未被改掉',
      `updated_at=${rowOf(dbT, 'AT').updated_at}`);
    insT.run('CLOCK', 'paused', '{}', null, '2026-01-01T00:00:00.000Z');
    markTaskFailed(dbT as never, 'CLOCK');
    crit('M6', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rowOf(dbT, 'CLOCK').updated_at),
      'M6-B 命令路（不传 `at`）仍取库钟格式 ⇒ 两条路各按各的时间语义（**不靠墙钟本身**判，只判形状）',
      `updated_at=${rowOf(dbT, 'CLOCK').updated_at}`);

    // ── M6-C ★ 产出闸额度：用户介入即归还（G11）────────────────────────────────
    //   判据**逐字复刻两名闸**：`const retries = Number(ctxJson.deliverable_missing_retries) || 0; … if (retries < 1)`
    const gate = (c: Record<string, unknown>): boolean => (Number(c.deliverable_missing_retries) || 0) < 1;
    const ctxQ: Record<string, unknown> = {
      deliverable_missing_retries: 3,
      deliverable_unfulfilled: { paths: ['docs/方案.md'], note: '产出内容不充分(充分性校验)', retries: 3 },
    };
    crit('M6', gate(ctxQ) === false,
      'M6-C 先立病：`deliverable_missing_retries = 3`（真库标本 `a290ae2b` 的实值）⇒ 两道闸的 `retries < 1` '
      + '**恒假** ⇒ "自动补一轮"的通道**永久关闭**（G11）',
      `gate=${gate(ctxQ)} · retries=${String(ctxQ.deliverable_missing_retries)}`);
    // ⚠ 旧路的**就地复刻**——**仅作反证标本**：不接生产、任何生产码不得引用。
    const legacyGrantQuota = (_ctx: Record<string, unknown>): boolean => false;   // 修复前：恢复路**不碰**这个计数（何时清只在成功路）
    const ctxLegacy = JSON.parse(JSON.stringify(ctxQ)) as Record<string, unknown>;
    crit('M6', legacyGrantQuota(ctxLegacy) === false && gate(ctxLegacy) === false,
      'M6-C 反证标本：旧行为（恢复不动计数）在**同一只标本**上给出**相反**的结论 ⇒ 标本确实踩中本病，'
      + '不是"新旧都不响、于是看不出差别"的空样本',
      `旧路 gate=${gate(ctxLegacy)}`);

    const granted = grantDeliverableRetryQuota(ctxQ);
    crit('M6', granted === true && gate(ctxQ) === true,
      'M6-C ★★**靶心**：用户介入后额度归位 ⇒ **同一个判据**由假转真（"值从 0 变 1"的正面断言，'
      + '不是只断言"不抛"——被 `try/catch` 吞掉的写入只有正面断言抓得住）',
      `granted=${granted} · gate 由 ${gate(ctxLegacy)} 变 ${gate(ctxQ)}`);
    crit('M6', ctxQ.deliverable_unfulfilled === undefined,
      'M6-C 两个键**一起动**：非 `forced` 的那份 `deliverable_unfulfilled` 一并清'
      + '（写入点与成功清除点本就成对，只清一个即"只改一半"）');

    const ctxForced: Record<string, unknown> = { deliverable_missing_retries: 2, deliverable_unfulfilled: { paths: ['x.md'], forced: true } };
    grantDeliverableRetryQuota(ctxForced);
    crit('M6', ctxForced.deliverable_missing_retries === undefined
      && (ctxForced.deliverable_unfulfilled as { forced?: boolean } | undefined)?.forced === true,
      'M6-C **该留的留下**：预算强制收尾写的 `{forced:true}` 留痕**不得**被恢复动作抹掉——'
      + '它记的是"预算逼着放行"（M7-b 要核它），与本闸的重试额度**不是同一件事**',
      `余 ${JSON.stringify(ctxForced)}`);
    crit('M6', grantDeliverableRetryQuota({ task_goal: { goal: 'x' } }) === false,
      'M6-C 无可清 ⇒ 返回 false、不动 ctx（幂等；恢复路每次都会过一遍）');

    // 接线在场且**方向正确**
    crit('M6', countOcc(aiTask6, "if (payload.initiator === 'user') grantDeliverableRetryQuota(rctx);") === 1
      && countOcc(aiTask6, 'grantDeliverableRetryQuota(') === 1,
      'M6-C 接线在场、方向正确、恰**一处**：额度只在 `initiator === \'user\'` 这一支归还——'
      + '自动路（缺省 `system`，缺省值本身是契约）不走这里，否则清一次→自动补一次→再清 ⇒ **闸永不关闭**'
      + '（"按 run 代次重算"那个更彻底的候选正是这样把"知止"整条拆掉的，已被裁定否决）',
      `调用点 ${countOcc(aiTask6, 'grantDeliverableRetryQuota(')} 处`);

    // ── M6-D 出口可达：额度耗尽的话术**指得出按钮**（G16）──────────────────────
    crit('M6', countOcc(execSideCode, '「恢复（保留对话）」') === 2 && countOcc(execSideCode, '「回复」') === 2,
      'M6-D ★ 两道闸的"额度耗尽"话术（各 1 处）**都**点名了用户可达的出口 —— '
      + '原来写的是"请人工介入核实产出内容 / 请人工复核产出内容"，指不出按哪儿，出路只存在于库外（G16 的手工动库）'
      + '（扫描面=执行体侧：两道闸一处随收尾段落 `core/exec-close.ts`，面须随实现走）',
      `「恢复（保留对话）」${countOcc(execSideCode, '「恢复（保留对话）」')} 处（执行体侧 ${execSideLines} 行）`);
    crit('M6', countOcc(execSideCode, '请人工介入核实产出内容') === 0 && countOcc(execSideCode, '请人工复核产出内容') === 0,
      'M6-D 旧话术**已退场**（去注释面扫，0 处）——改文案不是加一句，是把按不到的那句换掉');
    // 承诺的**兑现者**在场：话术指名的按钮真在 GUI 上，且真能带附言恢复
    const detail7 = fs.readFileSync(TASK_DETAIL_SRC, 'utf-8');
    const ipc7 = strip(IPC_SRC);
    crit('M6', countOcc(detail7, '恢复（保留对话）') >= 1 && countOcc(detail7, '回复') >= 1,
      'M6-D **承诺的兑现者在场**：话术点名的「恢复（保留对话）」与「回复」在 `TaskDetailPage.tsx` 上**确有其钮**'
      + '（本仓纪律：话术不许指一个按不到的东西；且该判据须能被合法数据满足）',
      `「恢复（保留对话）」${countOcc(detail7, '恢复（保留对话）')} 处 · 「回复」${countOcc(detail7, '回复')} 处`);
    crit('M6', /handleReply[\s\S]{0,200}tasks\.resume\(taskId, text\)/.test(detail7)
      && countOcc(ipc7, 'task:resume') === 1,
      'M6-D 「回复」不是个摆设：它走 `tasks.resume(taskId, text)` ⇒ `task:resume` 收 `reply`，'
      + '附言落会话行并随恢复注入——**与 M6-C 的额度归还同一次恢复**（承诺与兑现同路）',
      `IPC 处理器 ${countOcc(ipc7, 'task:resume')} 处`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M7·G13/G14/G15】闸锚与在场（仓根归位 · 放行留痕 · 横幅附言）');
  {
    const control7m = strip(FINALIZE_SRC);
    const detail7m = fs.readFileSync(TASK_DETAIL_SRC, 'utf-8');
    const ipc7m = strip(IPC_SRC);

    // ── M7-A 仓根归位：跑**真实现** `gitRootsOfDirs` + **真文件系统**（两侧标本一起上）──
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-m7-'));
    const mk = (...p: string[]) => { const d = path.join(tree, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
    const workDir = mk('代码'); // 工作目录**本身不是仓** —— 真库标本 31f6b443 的形状
    const subRepo = mk('代码', '参考项目', 'example-suite');
    fs.mkdirSync(path.join(subRepo, '.git'));
    const plainDir = mk('别处', '无仓'); // 自身与全部祖先都没有仓
    const ownRepo = mk('自带是仓');
    fs.mkdirSync(path.join(ownRepo, '.git'));

    const rootsHit = gitRootsOfDirs([workDir, path.join(subRepo, 'src'), path.join(subRepo, 'docs')]);
    crit('M7', rootsHit.length === 1 && rootsHit[0] === subRepo,
      'M7-A ★ **该命中**：工作目录自身无 `.git`、真仓在子目录（标本 `31f6b443`：`…/代码` 无仓，'
      + '25 份交付物落在 `…/代码/参考项目/example-suite/`、**28 项未提交**）——旧判据 `existsSync(workingDir/.git)` '
      + '在此恒假 ⇒ 那道闸**一次都没运行过**；新判据按交付物路径向上归位，命中**恰一个**仓根且同仓多件只算一次',
      `命中 ${rootsHit.length} 个根：${rootsHit.map(r => path.relative(tree, r)).join('、') || '(空)'}`);
    crit('M7', gitRootsOfDirs([path.join(plainDir, 'x', 'y.md')]).length === 0,
      'M7-A **该不命中**：起始目录与其全部祖先都没有仓 ⇒ 返回空 ⇒ 调用方**静默跳过**'
      + '（维持"没有仓就无所谓提交"的原语义，不制造新的误拦）');
    crit('M7', JSON.stringify(gitRootsOfDirs([ownRepo, path.join(ownRepo, 'a', 'b.md')])) === JSON.stringify([ownRepo]),
      'M7-A 并集**逐字兼容旧判据**：起始目录自身是仓时向上第一步即命中它 ⇒ 与旧 `existsSync(workingDir/.git)` '
      + '**同解**（故并集**不可能产生新的误拦**，只在旧判据失效处补覆盖）');
    const twoRepos = gitRootsOfDirs([subRepo, ownRepo]);
    crit('M7', twoRepos.length === 2 && twoRepos[0] === subRepo && twoRepos[1] === ownRepo,
      'M7-A 多仓如实报**全部**脏源（不因第一个命中就收工）',
      `排序后 ${twoRepos.map(r => path.relative(tree, r)).join('、')}`);

    // ── M7-A 接线：闸口交给唯一的归位函数，逐仓独立，旧判据退场 ──────────────
    // zx_20261003 M8 就地改钉：`gitRootsOfDirs` 的**定义**留在 `control.ts`、**调用**随 finalize 执行体
    //   搬到 `control-finalize.ts` ⇒ "定义 1 + 调用 1"这条判据须两文件合看。仍各判"恰一处"（合计 2），
    //   不因搬迁把它退化成"任一处有即可"（那是放宽）。
    const controlDef7m = strip(CONTROL_SRC);
    crit('M7', countOcc(controlDef7m, 'gitRootsOfDirs(') === 1 && countOcc(control7m, 'gitRootsOfDirs(') === 1,
      'M7-A 接线在场且**恰一处调用**（定义 1 + 调用 1；M8 就地改钉：定义在 control.ts、调用在 control-finalize.ts）：'
      + '闸口把 `workingDir ∪ 各交付物 dirname` 交给唯一的归位函数',
      `control.ts 定义 ${countOcc(controlDef7m, 'gitRootsOfDirs(')} 处 · control-finalize.ts 调用 ${countOcc(control7m, 'gitRootsOfDirs(')} 处`);
    crit('M7', countOcc(control7m, "fs.existsSync(path.join(workingDir, '.git'))") === 0,
      'M7-A 旧判据**已退场**（去注释面 0 处）：不再问"工作目录本身是不是仓"——那正是标本那道闸从未运行的成因');
    crit('M7', countOcc(control7m, 'delivPaths.map(p => path.dirname(p))') === 1,
      'M7-A 闸锚取**已登记交付物**（`file_path` 是绝对路径，是"这次改动落在哪"的在场证据），'
      + '不遍历工作目录树找子仓（无界遍历会牵连与本任务无关的邻居仓 ⇒ 误拦）');
    const gitLoop = blockAt(control7m, 'for (const root of roots)');
    crit('M7', countOcc(gitLoop, 'continue;') >= 1 && countOcc(gitLoop, 'throw') === 0,
      'M7-A 逐仓检查、**各仓独立**：单仓 `git status` 失败只 `continue` 跳过该仓，'
      + '不再像旧代码那样一抛把其余仓的检查全带走（best-effort 语义维持）',
      `循环体内 continue ${countOcc(gitLoop, 'continue;')} 处 · throw ${countOcc(gitLoop, 'throw')} 处`);
    crit('M7', countOcc(control7m, 'dirtyRepos:') === 1 && countOcc(control7m, 'uncommittedCount: total') === 1
      && countOcc(control7m, '${d.root}: ${d.count} 项') === 1,
      'M7-A 报出**全部**脏仓与各自项数（"哪个仓脏、脏几项"直接可读，不只报个总数）——拦得住还得说得清');

    // ── M7-B 放行留痕：`forcedByBudget` 短路时如实说出"没做什么" ────────────────
    const WARN_BUDGET_SKIP = '预算强制收尾放行：产出内容充分性校验未执行';
    crit('M7', countOcc(control7m, WARN_BUDGET_SKIP) === 1,
      'M7-B ★ 内容门被短路时**留痕**：`forcedByBudget` 放行必须如实报出"没做什么"——'
      + '原来整段静默跳过（既无 `[WARN]` 也无 ctx 键），于是"完成了、内容却从未校验"在账面上看不出来',
      `去注释面 ${countOcc(control7m, WARN_BUDGET_SKIP)} 处`);
    const secondGuard = (() => {
      const i = control7m.indexOf('if (!forcedByBudget) {');
      const j = control7m.indexOf('if (!forcedByBudget) {', i + 1);
      return j < 0 ? '' : control7m.slice(j);
    })();
    crit('M7', /\} else \{[\s\S]*?预算强制收尾放行：产出内容充分性校验未执行/.test(secondGuard),
      'M7-B 该说明**落在 `!forcedByBudget` 的 `else` 支**内（与它描述的那段跳过严格同源），不是写在别处的一句摆设'
      + '（判据取**第二处** `if (!forcedByBudget) {` 之后的花括号配对，不按行号）');
    crit('M7', countOcc(control7m, 'ctxJson.finalize_checks = checks;') === 1,
      'M7-B **用户可见**：`checks` 仍落 `finalize_checks`（renderer 逐条着色、并数 WARN/FAIL）——'
      + '留痕若不下屏，与不留痕等价');
    crit('M7', countOcc(control7m, 'if (finScore < 60) {') === 1
      && countOcc(control7m, 'finalize 质量门未通过') === 0,
      'M7-B `prematureEnd × score` 耦合**刻意不动**（裁定理据在 `control-finalize.ts` 就地注释里，M8 就地改钉）：'
      + '被迫结束但产出已足是**合法**情形，一并拦下等于"预算紧 ⇒ 不许完成"，与 `a290ae2b` 那条死锁同形。'
      + '⚑ zx_20260928 M2 **就地订正**（改钉更强的新真源，非放宽）：原判据钉的是'
      + '`if ((args.quality === \'partial\' || finScore < 60) && forcedByBudget)` 恰 1 处；本轮把低分出口'
      + '统一为**一处且是暂停**——`finScore < 60` 即置 paused（与 run_close 同尺），原先并列的那把'
      + '"自评分 <60 → **拒绝** finalize"的尺已删（同一问句一处拒一处停正是本轮 D1 病根）。'
      + '耦合本身仍未动：`forcedByBudget` 是被**从合取里去掉**（低分不再问"是不是预算逼的"），不是被加严'
      + '⇒ "预算紧 ⇒ 不许完成"依旧不成立。'
      + '（`finalize 质量门未通过` 必须为 0 处：那条拒绝闸若还在，"同一件事两把尺"就复活了。）',
      `if (finScore < 60) ${countOcc(control7m, 'if (finScore < 60) {')} 处 · 质量门未通过 ${countOcc(control7m, 'finalize 质量门未通过')} 处`);

    // ── M7-C 横幅附言：同一条恢复路，后端零改动 ──────────────────────────────
    crit('M7', countOcc(detail7m, '附言并恢复') === 1,
      'M7-C ★ 横幅里补上那处缺口：「附言」此前只在动作栏模态框可达（承 G15 口径订正），'
      + '现暂停横幅内直接可写', `「附言并恢复」${countOcc(detail7m, '附言并恢复')} 处`);
    crit('M7', /handleResumeWithNote[\s\S]{0,300}?tasks\.resume\(taskId, text\)/.test(detail7m),
      'M7-C **走同一条路、不新造通道**：内联附言调的是既有的 `tasks.resume(taskId, text)`——'
      + '与模态框 `handleReply` 同通道同签名，不是第二份 resume 实现');
    crit('M7', countOcc(detail7m, 'tasks.resume(') === 3 && countOcc(ipc7m, 'task:resume') === 1,
      'M7-C 后端**零改动**自证：renderer 里恢复调用恰 3 处（无附言 1 + 有附言 2），'
      + '而主进程 `task:resume` 处理器仍**恰 1 处** ⇒ 新增这条没有多开一个 IPC 口',
      `tasks.resume( ${countOcc(detail7m, 'tasks.resume(')} 处 · task:resume ${countOcc(ipc7m, 'task:resume')} 处`);
    crit('M7', /\{task\.status==='paused' && !awaitingInput && [\s\S]{0,1500}?bannerReply/.test(detail7m),
      'M7-C 输入框**确在暂停横幅内**（同一个 `status===\'paused\' && !awaitingInput` 条件块），不是另起一处孤岛');

    try { fs.rmSync(tree, { recursive: true, force: true }); } catch { /* 清理 best-effort */ }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M2·G1】thinking 模式的请求兼容：归一处真源（tool_choice 删除 + reasoning 回传 + 展示提取）');
  {
    const providerSrc = strip(PROVIDER_SRC);
    const reasoningSrc = strip(REASONING_SRC);
    const main = scanMainSources();

    // ── M2-0 计数器**两侧标本**（防"扫了个空 ⇒ 零处恒真"）─────────────────────
    {
      const probe = 'const nothing = 0;\nconst x = "@ai-sdk/openai";\n';
      crit('M2', countOcc(probe, '@ai-sdk/openai') === 1 && countOcc(probe, 'createOpenAI(') === 0,
        'M2-0 计数器两侧标本：同一份文本上"该数得到 1"与"该数得到 0"各自成立（扫描器本身不空转）',
        `命中 ${countOcc(probe, '@ai-sdk/openai')}/1 · 未命中 ${countOcc(probe, 'createOpenAI(')}/0`);
    }

    // ── M2-b 纯函数：回填判据**两侧标本一起上** ───────────────────────────────
    {
      const body = (): Record<string, unknown> => ({
        model: 'm',
        messages: [
          { role: 'system', content: 'S' },
          { role: 'user', content: 'U' },
          { role: 'assistant', content: 'A1', tool_calls: [{ id: 't' }] },
          { role: 'tool', content: 'R1', tool_call_id: 't' },
          { role: 'assistant', content: 'A2' },
        ],
      });

      // 该命中：两个回合的思考**按序**落到对应的 assistant 消息上（第 1 条拿第 1 回合，不是拿最后一条）
      const b1 = body();
      const changed1 = backfillReasoningContent(b1, [{ text: 'A1', reasoning: '思考一' }, { text: 'A2', reasoning: '思考二' }]);
      const m1 = (b1.messages as Array<Record<string, unknown>>);
      crit('M2', changed1 === true && m1[2]?.reasoning_content === '思考一' && m1[4]?.reasoning_content === '思考二',
        'M2-b ★ 该命中：本回合累计的 `reasoning_content` **按序**回填到对应 assistant 消息'
        + '（第 k 条 assistant ↔ 第 k 回合；正因 SDK 只按步追加才成立）——服务端要的就是这一件',
        `第 1 条=${JSON.stringify(m1[2]?.reasoning_content)} / 第 2 条=${JSON.stringify(m1[4]?.reasoning_content)}`);
      crit('M2', m1[0]?.reasoning_content === undefined && m1[1]?.reasoning_content === undefined && m1[3]?.reasoning_content === undefined,
        'M2-b 回填**只落在 assistant 消息**：system/user/tool 三类不占回合位、也不被动到'
        + '（否则对齐会整体错位一位——那比不回填更坏）');

      // 该不命中①：非 thinking 模型（一个回合都没产出 reasoning）⇒ 请求体**一字不改**
      const b2 = body();
      const changed2 = backfillReasoningContent(b2, [{ text: 'A1', reasoning: '' }, { text: 'A2', reasoning: '' }]);
      crit('M2', changed2 === false && (b2.messages as Array<Record<string, unknown>>).every((m) => m.reasoning_content === undefined),
        'M2-b 该不命中①：非 thinking 模型永不产出 `reasoning_content` ⇒ 这条路对它们**零改动**'
        + '（这是"不误伤"那一半；该命中的一半在上一条）');

      // 该不命中②：回合表为空 ⇒ 不改
      const b3 = body();
      crit('M2', backfillReasoningContent(b3, []) === false,
        'M2-b 该不命中②：一个回合都没有（首次请求）⇒ 原样透传');

      // 该不命中③：请求体自己带了 reasoning_content ⇒ **不覆盖**（服务端/SDK 的那份优先）
      const b4 = body();
      (b4.messages as Array<Record<string, unknown>>)[2]!.reasoning_content = 'SDK 自己带的';
      backfillReasoningContent(b4, [{ text: 'A1', reasoning: '思考一' }, { text: 'A2', reasoning: '思考二' }]);
      crit('M2', (b4.messages as Array<Record<string, unknown>>)[2]?.reasoning_content === 'SDK 自己带的',
        'M2-b 该不命中③：请求体里**已有** `reasoning_content` ⇒ 不覆盖（回填是补齐，不是改写）');

      // 该不命中④：形状不对（无 messages）⇒ 不抛、不改
      let threw4 = '';
      let ret4 = true;
      try { ret4 = backfillReasoningContent({ model: 'm' }, [{ text: 'A', reasoning: 'R' }]); } catch (e) { threw4 = String(e); }
      crit('M2', threw4 === '' && ret4 === false,
        'M2-b 该不命中④：请求体无 `messages`（形状不对）⇒ 返回假且**不抛**（出网路上的判据不许反噬调用方）',
        threw4 ? `**抛了**：${threw4}` : '');
    }

    // ── M2-c 单真源：`@ai-sdk/openai` 在 `src/main` 只剩**一个**落点 ────────────
    crit('M2', countOcc(main.text, "@ai-sdk/openai'") === 1 && countOcc(main.text, "createOpenAI(") === 1,
      'M2-c ★「归一处真源」的机检面：整个 `src/main`（**去注释面**）里 `@ai-sdk/openai` 的 import 与 `createOpenAI(` 的调用**各恰 1 处**'
      + '——主聊天路此前内联一份、旁路各写一份，正是"同一件兼容各补一半"的结构',
      `扫描面 ${main.files} 文件 / ${main.lines} 行 · import ${countOcc(main.text, "@ai-sdk/openai'")} 处 · 调用 ${countOcc(main.text, 'createOpenAI(')} 处`);
    crit('M2', countOcc(providerSrc, "@ai-sdk/openai'") === 1 && countOcc(providerSrc, 'createOpenAI(') === 1,
      'M2-c 那个落点就在 `ai-provider.ts`（唯一那座工厂自己）');
    crit('M2', countOcc(execCode, 'createOpenAI(') === 0 && countOcc(execCode, 'createReasoningAwareFetch(') === 0,
      'M2-c ★ 主聊天路的**内联兼容已退场**：`agent-executor.ts`（去注释面）里 `createOpenAI(` 与 `createReasoningAwareFetch(` **各 0 处**'
      + '——它现在只能经那座工厂拿 provider，"哪条路复用了哪一半"不再有第二种可能');
    crit('M2', countOcc(execCode, 'createSafeProvider(') === 5,
      'M2-c 四处内联（主聊天路/验收/目标偏离/压缩）+ 原先那一处（需求卡）**全部收编**：`agent-executor.ts` 里恰 5 处调用',
      `createSafeProvider( ${countOcc(execCode, 'createSafeProvider(')} 处`);
    crit('M2', /probe:\s*\{ dir: path\.join\(ctx\.dataDir, 'reasoning-probe'\), tag: taskId \}/.test(execCode),
      'M2-a 接线：主聊天路把探针挂上，落 `data/reasoning-probe/<taskId>.jsonl`（`dir` 由调用方注入，模块自己不解析 dataDir）');
    crit('M2', /onReasoningDelta:\s*pushReason/.test(execCode),
      'M2-c ★ 主聊天路仍**保留**展示提取（`onReasoningDelta`）——归一处是"三合一"，不是"删掉展示保回传"');

    // ── M2-a 脱敏：指纹里**没有正文** ────────────────────────────────────────
    {
      const shape = JSON.stringify(requestShape({
        model: 'm', tool_choice: 'auto',
        messages: [{ role: 'assistant', content: '绝密正文SENTINEL', reasoning_content: '绝密思考SENTINEL' }],
      }, [{ text: 'x', reasoning: 'y' }]));
      crit('M2', !shape.includes('SENTINEL'),
        'M2-a ★ 探针**脱敏**：指纹里只有长度与哈希，正文与思考**一字不落盘**（`绝密正文SENTINEL` 在指纹里查无此串）');
      crit('M2', shape.includes('"hasReasoningContent":true') && shape.includes('"toolCalls":0')
        && shape.includes('"contentLen":12') && shape.includes(`"contentSha8":"${crypto.createHash('sha1').update('绝密正文SENTINEL').digest('hex').slice(0, 8)}"`),
        'M2-a 该坐实的三项**都在指纹里**：`hasReasoningContent` / `toolCalls` / 正文长度+哈希'
        + '——"失败那一次与成功那几次差在哪"恰好全在这里');
    }

    // ── M2-b/M2-a ★★ 靶心：**真 SDK 往返**（真 `ai` + 真 `@ai-sdk/openai` + 生产工厂 + 桩 SSE 端点）──
    //   为什么必须真跑（承 `feedback_verify_roundtrip_at_production_input`）：`backfillReasoningContent` 单测再全绿，
    //   也只证明"这个函数在自造入参上对"；真正要证的是**SDK 会不会把上一回合的 assistant 消息按序送来**、
    //   以及**我们改的那份 `init.body` 究竟出没出网**。这两件事只有让真 SDK 跑满一个多步工具循环才看得到。
    {
      const tmpM2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-m2-'));
      const appReq = createRequire(path.join(root, A, 'package.json'));
      const ai = await import(pathToFileURL(appReq.resolve('ai')).href) as unknown as {
        streamText: (o: Record<string, unknown>) => { fullStream: AsyncIterable<Record<string, unknown>> };
        tool: (d: Record<string, unknown>) => Record<string, unknown>;
        jsonSchema: (s: unknown) => unknown;
      };

      /** 桩端点：SSE 逐块吐。第 1 轮吐「思考 + 正文 + 工具调用」，第 2 轮收口。 */
      const makeStub = (opts: { thinking: boolean; calls: Array<Record<string, unknown>> }) =>
        async (_input: unknown, init: { body?: unknown }): Promise<Response> => {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          opts.calls.push(body);
          const first = opts.calls.length === 1;
          const co = (delta: Record<string, unknown>, finish: string | null) =>
            `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
          const head = co({ role: 'assistant', content: '' }, null);
          const sse = first
            ? head
              + (opts.thinking ? co({ reasoning_content: '先看约束' }, null) + co({ reasoning_content: '再验边界' }, null) : '')
              + co({ content: '我来查一下' }, null)
              + co({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'probe_tool', arguments: '{}' } }] }, null)
              + co({}, 'tool_calls') + 'data: [DONE]\n\n'
            : head + co({ content: '查完了' }, null) + co({}, 'stop') + 'data: [DONE]\n\n';
          return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        };

      /** 走一趟"真 provider + 真 streamText + 桩 SSE"，返回请求体清单（可选挂探针）。 */
      const roundTrip = async (thinking: boolean, probe?: { dir: string; tag: string }): Promise<Array<Record<string, unknown>>> => {
        const calls: Array<Record<string, unknown>> = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = makeStub({ thinking, calls }) as unknown as typeof globalThis.fetch;
        try {
          const provider = createSafeProvider({
            baseURL: 'https://example.test/v1', apiKey: 'k',
            ...(probe ? { probe } : {}),
          });
          const result = ai.streamText({
            model: provider.chat('m'),
            prompt: '查一下',
            tools: { probe_tool: ai.tool({ description: '探针工具', parameters: ai.jsonSchema({ type: 'object', properties: {}, additionalProperties: false }), execute: async () => 'ok' }) },
            maxSteps: 2,
          });
          for await (const _ of result.fullStream) { /* 必须**真消费**，否则工具循环不转 */ }
        } finally { globalThis.fetch = realFetch; }
        return calls;
      };

      const assistantOf = (b: Record<string, unknown>): Array<Record<string, unknown>> =>
        (Array.isArray(b.messages) ? b.messages as Array<Record<string, unknown>> : []).filter((m) => m.role === 'assistant');

      // ① 该命中：thinking 端点 ⇒ 第二轮请求里，第一回合的 assistant 消息**带着** reasoning_content
      const callsThink = await roundTrip(true);
      const a1 = assistantOf(callsThink[1] ?? {});
      crit('M2', callsThink.length === 2 && a1.length === 1,
        'M2-b 真跑把工具循环**真转起来了**（两轮请求 ⇒ 不是一轮就收的空转；真 `streamText` + 真工具执行）',
        `请求轮数=${callsThink.length} · 第二轮 assistant 消息=${a1.length}`);
      crit('M2', a1[0]?.reasoning_content === '先看约束再验边界',
        'M2-b ★★ 靶心（该命中）：真 SDK 的第二轮请求体里，上一回合的 assistant 消息**带上了** `reasoning_content`'
        + '——即服务端那句 `must be passed back to the API` 要的东西**确实出网了**（不是"函数单测里对"）',
        `实测 reasoning_content=${JSON.stringify(a1[0]?.reasoning_content)}`);
      crit('M2', assistantOf(callsThink[0] ?? {}).length === 0,
        'M2-b 该不命中（同一趟的真值对照）：**首轮**请求里本就没有 assistant 消息 ⇒ 回填无从谈起（不是"回填了空串"）');
      crit('M2', !('tool_choice' in (callsThink[0] ?? {})) && !('tool_choice' in (callsThink[1] ?? {})),
        'M2-c 顺带自证这两份请求体**确由生产那座工厂发出**（`tool_choice` 被它顺手删掉）——不是裸 provider 的产物');

      // ② 该不命中：非 thinking 端点 ⇒ 第二轮**不得**凭空长出 reasoning_content
      const callsPlain = await roundTrip(false);
      const p1 = assistantOf(callsPlain[1] ?? {});
      crit('M2', callsPlain.length === 2 && p1.length === 1 && p1[0]?.reasoning_content === undefined,
        'M2-b ★ 该不命中（两侧标本的另一只）：非 thinking 端点上一个 reasoning 都没产出 ⇒ '
        + '第二轮请求体里**不凭空长出** `reasoning_content`（否则就是在替服务端编思考）',
        `实测 reasoning_content 键在场=${p1[0] ? 'reasoning_content' in p1[0] : '无 assistant 消息'}`);

      // ③ 探针（M2-a）：脱敏落盘 + 把"形状随回合变化"如实记下来
      const probeDir = path.join(tmpM2, 'reasoning-probe');
      const tag = 'rr-m2-probe';
      await roundTrip(true, { dir: probeDir, tag });
      const probeFile = path.join(probeDir, `${tag}.jsonl`);
      const raw = fs.existsSync(probeFile) ? fs.readFileSync(probeFile, 'utf-8') : '';
      const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      const reqs = lines.filter((l) => l.phase === 'request');
      crit('M2', lines.length >= 2 && reqs.length === 2,
        'M2-a 探针**真落了盘**：每轮请求一条记录（`data/reasoning-probe/<tag>.jsonl`）',
        `总 ${lines.length} 条 / request ${reqs.length} 条`);
      crit('M2', !raw.includes('先看约束') && !raw.includes('我来查一下'),
        'M2-a ★ 探针**脱敏**（端到端自证）：正文与思考在落盘文件里**查无此串**（只留长度与哈希）');
      const r2msgs = (reqs[1]?.messages ?? []) as Array<Record<string, unknown>>;
      const r2a = r2msgs.find((m) => m.role === 'assistant');
      crit('M2', reqs[0]?.backfilledTurns === 0 && reqs[1]?.backfilledTurns === 1 && r2a?.hasReasoningContent === true
        && r2a?.reasoningLen === '先看约束再验边界'.length,
        'M2-a ★ 探针**认得它要认的那件事**：第 1 轮 `backfilledTurns=0`、第 2 轮 `=1`，'
        + '且第 2 轮那条 assistant 消息 `hasReasoningContent=true` + 思考长度对得上'
        + '——真机上"成功那几次 vs 失败那一次"就是靠这三项摊开来比的',
        `backfilledTurns=${String(reqs[0]?.backfilledTurns)}→${String(reqs[1]?.backfilledTurns)} · hasReasoningContent=${String(r2a?.hasReasoningContent)} · reasoningLen=${String(r2a?.reasoningLen)}`);

      // ④ 探针**关**是默认：不传 `probe` ⇒ 一个文件都不该有
      const offDir = path.join(tmpM2, 'probe-off');
      await roundTrip(true);
      crit('M2', !fs.existsSync(offDir),
        'M2-a 探针默认**关**（不传 `probe` 即关，无隐藏开关）：不传时不会凭空造出落盘目录');

      try { fs.rmSync(tmpM2, { recursive: true, force: true }); } catch { /* 清理 best-effort */ }
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S】build 钉（派生核对，不写轮次字面量；**不受批次门管辖**）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告
//    unhandled rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20260923 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260923: ${pass} 通过 / ${fail} 失败${pending ? ` / ${pending} 待实施(不计入)` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
});
