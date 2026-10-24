/**
 * zx_20260922 受控复跑 —— 「同一件事，才叫重复」。
 *
 * 病根（`plans/improve/zx_20260922.md` §1.2，真任务 `a290ae2b` 实机台账）：
 * **判据问的是「你是不是又在用这把工具」，而它该问的是「你是不是又在做同一件事」——前者是词，后者是事。**
 * 一个工具名底下住着千百种用法：`bash` 里 `git status` / `git log` / `ls -la` 是**三件毫不相干的事**，
 * 旧判据把它们读成「连续 6 次调用同一工具(bash)」并硬暂停 ⇒ **四步、十六秒、零产出**。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 本文件的**批次门**（`RR_STAGE`）—— 承前若干轮的骨架纪律：
 *   方案 §2 是六个批次（M0…M5），判据**随批次转绿**。若不做区分，M1 落下时本脚本一片红，
 *   而"红"既可能是"还没实施"也可能是"实施错了"，两者混在一起**信息量为零**。
 *   故：每条判据登记其**所属批次**；`RR_STAGE=Mn` 时**只要求 ≤Mn 的批次**为绿，
 *   更晚的批次打 `⏳` 并**不计入失败**。`RR_STAGE` 为空 = **全部必须绿**（M5 收口用）。
 *
 * §G 判据 G（**不变式门**，与批次无关，任何时刻都须成立）：
 *   G-1 **真源在位**：本轮所引用的生产符号**全部静态 import** ⇒ 被删/被改名即**编译期失败**，
 *       而不是"扫字符串扫了个空、静默假绿"。
 *   G-2 **扫描面自证**：凡"唯一一处 / 零处"类断言必须同时报出**扫描面命中数**
 *       （承 `zx_20260920_1 §G-1` 的教训："扫描面无匹配 ⇒ 零处违规恒真"，扫了个空也是绿）。
 * §C 判据 C（**随批次转绿**，`RR_STAGE` 管辖）：
 *   C1–C7（M1 判据抽纯函数 + 身份＝完整调用）·
 *   C8–C14（M2 游程计数：一步一次，窗口由阈值派生）·
 *   C15–C16（M3 两处落点合一）·
 *   C17–C18（M4 停因可核）。
 * §S 判据 S：`checkBuildPins(ok, { distDir })`（P1–P6 全套）—— **不受批次门管辖**：
 *   build 钉是**常驻不变式**（它派生标签，故换轮不会让它变红；它变红只说明真源被破坏）。
 *
 * ⚠ **标本纪律（承 `feedback_predicate_needs_both_sides_specimen`）**：只用"该命中"样本验证 ⇒
 *   **任何过宽变体全票通过**。故 C1（该不命中，直接复刻事故现场）与 C2（该命中，真循环仍要抓）
 *   **必须同时在场**。C1 另配一只**反证标本**（旧算法就地复刻），证明这批调用**确实会**触发旧判据
 *   ⇒ 标本就是本案，不是"恒不触发的空样本"。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**（P6 取产物内 build 值本身，而非会被注释骗过的子串匹配）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { engineExecSideFiles, stripStepScopePrefix } from './lib/rr-engine-src.js';
// G-1：本轮判据引用的生产符号，**全部静态导入** ⇒ 被删/改名即编译期失败。
import {
  advanceLoopRun,
  describeToolCall,
  EMPTY_LOOP_RUN,
  fingerprintToolName,
  isExplorationCall,
  toolCallFingerprint,
  type LoopRun,
} from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
// M2：阈值**唯一真源**（`toolLoopWarn` / `toolLoopHard`）——夹具**不得**另抄一份常量。
import { getProjectThresholds } from '../apps/worker-ant-desktop/src/main/core/feedback-engine.js';

let pass = 0; let fail = 0; let pending = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ── 批次门 ──────────────────────────────────────────────────────────────────
const ORDER = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5'] as const;
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
const EXEC_SRC = path.join(root, A, 'src/main/core/agent-executor.ts');
/** 扫源码一律**去注释**：承 `zx_20260921_1`——"注释里写着有、代码里没被用上"正是要防的形态。 */
const strip = (p: string) => stripKeepingLines(fs.readFileSync(p, 'utf-8')).join('\n');
/**
 * zx_20260929 M9：步回调段（`onStepFinish` 闭包，原 `agent-executor.ts:2132–2728`）整段外移到
 * `core/exec-step.ts` ⇒ C6/C7/C14/C16/C18 这组"生产接线在不在"的判据若裸读执行体，会把搬走的
 * **两本账的自增/指纹 push/警告阶梯**全部扫成 0 处，形状与"机制没接线"无异（**真回归的形状**）。
 * 面换成「执行体 ∪ `core/exec-*.ts`」（目录约定**一处真源**在 `lib/rr-engine-src.ts`）。
 * ⚠ 只许更严（并集；旧符号零处残留那类断言因面变宽而更严）。`stripStepScopePrefix` 只**还原**搬迁前的
 *   针脚字面量（`d.stepFps` → `stepFps` 等），非放宽：见该函数注释。
 */
const execSideCode = stripStepScopePrefix(
  engineExecSideFiles().map((p) => strip(path.join(root, p))).join('\n'));

/** 一次调用（判据要的最小形状；与生产 `tc.toolName` / `tc.args` 同形）。 */
interface Call { toolName: string; args: unknown }

/**
 * 按**生产循环**的取用方式，把一步的调用收成指纹集合。
 *
 * ⚠ 这里**只复刻取用的三行**（跳过 `disabledTools` 之外的探索调用），判据本体（判等 / 推进 / 阈值）
 *   一律跑生产真实现。生产侧"确实这么取用"由 C6 的**源码结构断言**另行钉死——
 *   即：本函数**不是**判据的自我印证，它只摆夹具。
 */
function stepFpsOf(step: readonly Call[]): string[] {
  const out: string[] = [];
  for (const tc of step) {
    if (!isExplorationCall(tc.toolName, tc.args)) out.push(toolCallFingerprint(tc.toolName, tc.args));
  }
  return out;
}

/** 逐**步**推进游程，返回每步之后的游程长度（跑的是生产 `advanceLoopRun`）。 */
function runLens(steps: ReadonlyArray<readonly Call[]>): number[] {
  const lens: number[] = [];
  let run: LoopRun = EMPTY_LOOP_RUN;
  for (const step of steps) {
    run = advanceLoopRun(stepFpsOf(step), run);
    lens.push(run.len);
  }
  return lens;
}

/**
 * ⚠ 旧算法的**就地复刻**——**仅作反证标本**：不是判据、不接入生产、任何生产码都不得引用它。
 *   唯一用途：证明下面那批调用**确实会**触发旧判据（⇒ 标本就是本案，不是"恒不触发的空样本"，
 *   也不是"新旧都不响、于是看不出差别"的那种浪费样本）。
 *   逐字复刻 `zx_20260922 M1` 删除前的 `loopFingerprint`（非写工具一律 `return toolName`）+ 窗口 8 + `allSame`。
 */
function legacyMaxContinuousSame(steps: ReadonlyArray<readonly Call[]>): number {
  const recent: string[] = [];
  let max = 0;
  for (const step of steps) {
    let pushed = false;
    for (const tc of step) {
      if (!isExplorationCall(tc.toolName, tc.args)) {
        recent.push(tc.toolName);              // 旧 loopFingerprint：写工具 `名:filePath`，**其余一律工具名**
        pushed = true;
        if (recent.length > 8) recent.shift(); // 旧窗口上限 8（硬编码）
      }
    }
    if (!pushed) recent.length = 0;
    const allSame = recent.length >= 2 && recent.every((t) => t === recent[0]);
    max = Math.max(max, allSame ? recent.length : 0);
  }
  return max;
}

/**
 * ★ 事故现场的四步九条调用——**逐字取自真库**（`wa_event_log.aggregate_id = a290ae2b`，
 *   `event_type = task.step_finished` 的 `toolCalls` 字段，2026-09-22 02:33 UTC）。
 *   这是本案的**真件**，不是自造等价入参（承 `feedback_verify_roundtrip_at_production_input`）。
 */
const INCIDENT_STEPS: ReadonlyArray<readonly Call[]> = [
  // 步 1
  [{ toolName: 'read_file', args: { filePath: 'plans/backend/20260916.md' } }],
  // 步 2
  [
    { toolName: 'get_current_time', args: {} },
    { toolName: 'list_files', args: { dirPath: '参考项目' } },
    { toolName: 'bash', args: { command: 'cd example-backend && git status --short && echo "===BRANCH===" && git branch -a && echo "===LOG===" &&' } },
  ],
  // 步 3
  [
    { toolName: 'bash', args: { command: 'git -C example-backend status --short' } },
    { toolName: 'bash', args: { command: 'git -C example-backend log --oneline -10' } },
    { toolName: 'bash', args: { command: 'git -C 参考项目/example-suite status --short | head -30' } },
  ],
  // 步 4
  [
    { toolName: 'bash', args: { command: 'git -C example-backend diff -- erp/pom.xml openapi/pom.xml' } },
    { toolName: 'bash', args: { command: 'git -C 参考项目/example-suite log --oneline -10' } },
    { toolName: 'bash', args: { command: 'ls -la 参考项目/example-suite/payment' } },
  ],
];

/** 同一条 bash 命令重复 N **步**（每步各一条）——"真循环"的标准形。 */
const repeatSteps = (command: string, n: number): Call[][] =>
  Array.from({ length: n }, () => [{ toolName: 'bash', args: { command } }]);

/** 取生产**默认阈值**（`wa_projects` 无 `learned_thresholds` 时的那一档）——夹具按生产初始化顺序建库。 */
function makeProjectDb(learned?: Record<string, number>): { db: DatabaseSync; projectId: string } {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE wa_projects (id TEXT PRIMARY KEY, context_json TEXT)');
  const projectId = 'rr-20260922-project';
  db.prepare('INSERT INTO wa_projects (id, context_json) VALUES (?, ?)').run(
    projectId,
    JSON.stringify(learned ? { learned_thresholds: learned } : {}),
  );
  return { db, projectId };
}

async function main(): Promise<void> {
  /** 生产源码（**去注释**）——C6/C7/C14/C16/C18 共用同一份扫描面（执行体侧，见 `execSideCode` 注释）。 */
  const code = execSideCode;
  const codeLines = code.split('\n').length;

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【G】不变式门（与批次无关，任何时刻都须成立）');
  {
    // G-1 由**静态 import** 保证（编译期失败）；此处报出取到的真值，防"导进来了但是空值"。
    ok(typeof toolCallFingerprint === 'function' && typeof advanceLoopRun === 'function'
      && typeof fingerprintToolName === 'function' && typeof describeToolCall === 'function',
      'G-1 真源在位：`toolCallFingerprint` / `advanceLoopRun` / `fingerprintToolName` / `describeToolCall` 都是函数',
      `${typeof toolCallFingerprint} / ${typeof advanceLoopRun} / ${typeof fingerprintToolName} / ${typeof describeToolCall}`);
    ok(EMPTY_LOOP_RUN.fp === '' && EMPTY_LOOP_RUN.len === 0,
      'G-1 起手态非空：`EMPTY_LOOP_RUN` = `{fp:"",len:0}`（游程"已断"的可代表值）',
      JSON.stringify(EMPTY_LOOP_RUN));
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C】M1 —— 判据抽纯函数 + 「身份」＝完整调用');
  {
    const { db, projectId } = makeProjectDb();
    const th = getProjectThresholds(db, projectId);
    ok(th.toolLoopWarn === 3 && th.toolLoopHard === 5,
      'M1 夹具用的阈值取自**生产真源** `getProjectThresholds`（无 `learned_thresholds` ⇒ 默认档），'
      + '不是脚本里另抄的一份常量',
      `warn=${th.toolLoopWarn} / hard=${th.toolLoopHard}`);

    // ── C1 ★**该不命中**：事故现场原样复刻 ──────────────────────────────────
    const lens = runLens(INCIDENT_STEPS);
    const maxLen = Math.max(...lens);
    const legacyMax = legacyMaxContinuousSame(INCIDENT_STEPS);
    crit('M1', maxLen < th.toolLoopWarn && maxLen < th.toolLoopHard,
      'C1 **该不命中**：真库取回的**四步九条**（其中 6 条入旧账）在新判据下**最大游程 = ' + maxLen + '**，'
      + `warn(${th.toolLoopWarn}) 与 hard(${th.toolLoopHard}) **都不触发** ⇒ 本 bug 已修`,
      `逐步游程=[${lens.join(',')}] · 最大=${maxLen}`);

    // 反证标本：同一批调用喂**旧算法复刻** ⇒ 必须响（且响的数与库内文案逐字对上）。
    ok(legacyMax === 6,
      'C1 反证标本：**同一批调用**喂旧算法复刻 ⇒ 得到 `连续 6 次`，与库内原话'
      + '「[A3降级·级别2] 连续6次调用bash」**逐字对上** ⇒ 这批标本确实是本案，不是恒不触发的空样本',
      `旧算法最大连续=${legacyMax}（≥ hard ${th.toolLoopHard} ⇒ 旧代码此处必暂停）`);

    // ── C2 ★**该命中**：真循环仍要抓 ────────────────────────────────────────
    const realLoop = runLens(repeatSteps('git -C example-backend status --short', 5));
    crit('M1', realLoop[realLoop.length - 1] === 5,
      'C2 **该命中**：**同一条**命令重复 5 **步** ⇒ 游程 5 ⇒ 到 hard 线（真循环仍要抓，没被"放宽"放跑）',
      `逐步游程=[${realLoop.join(',')}]`);

    // ── C3/C4：指纹按**完整调用**取（旧特例的意图自动成立，且修正了旧写法的一处误判）────
    const fpEditA1 = toolCallFingerprint('edit_file', { filePath: '/a.py', oldString: 'x', newString: 'y' });
    const fpEditA2 = toolCallFingerprint('edit_file', { filePath: '/a.py', oldString: 'x', newString: 'z' });
    const fpEditB = toolCallFingerprint('edit_file', { filePath: '/b.py', oldString: 'x', newString: 'y' });
    crit('M1', fpEditA1 !== fpEditA2,
      'C3 **修正项**：`edit_file` **同一文件的两处不同修改**指纹**不同**（旧写法两者同为 `edit_file:/a.py` ⇒ 会被当成重复）',
      `${fpEditA1} ≠ ${fpEditA2}`);
    crit('M1', fpEditA1 !== fpEditB,
      'C4 **旧意图不回归**：`edit_file` 写**不同文件**指纹不同（"写不同文件属正常批量"——旧特例要保的就是这一条，'
      + '取完整参数后**自动成立**，故特例可删而语义不丢）',
      `${fpEditA1} ≠ ${fpEditB}`);

    // ── C5：探索工具照旧不参与 ──────────────────────────────────────────────
    const readCalls: Call[] = ['/a.md', '/b.md', '/c.md'].map((p) => ({ toolName: 'read_file', args: { filePath: p } }));
    crit('M1', stepFpsOf(readCalls).length === 0 && runLens([readCalls])[0] === 0,
      'C5 **旧行为不回归**：`read_file` 连读三个不同文件属正常探索 ⇒ **零条**入游程（判据是生产 `isExplorationCall`）',
      `入账 ${stepFpsOf(readCalls).length} 条 / 游程 ${runLens([readCalls])[0]}`);

    // ── C6 ★生产**接线**（"引了"≠"接线了"；且旧符号须**零处**）──────────────
    ok(codeLines > 0, `C6 扫描面自证：执行体侧（执行体 ∪ core/exec-*.ts）去注释后 ${codeLines} 行 > 0`);
    const oldSymbols = ['recentToolCalls', 'loopFingerprint', 'WRITE_TOOLS_LOOP'];
    const oldHits = oldSymbols.filter((s) => code.includes(s));
    crit('M1', oldHits.length === 0,
      'C6 旧符号**零处**残留（`recentToolCalls` / `loopFingerprint` / `WRITE_TOOLS_LOOP`）——'
      + `扫描面 ${codeLines} 行（不是扫了个空）`,
      `命中 ${oldHits.length} 处${oldHits.length ? '：' + oldHits.join(',') : ''}`);
    crit('M1', code.includes('advanceLoopRun(stepFps, loopRun)') && code.includes('stepFps.push(toolCallFingerprint('),
      'C6 新判据**被 `executeTask` 实际调用**（非"import 了但没接线"）：`advanceLoopRun(stepFps, loopRun)` '
      + '与 `stepFps.push(toolCallFingerprint(` 都在生产码里');

    // ── C7 ★用户可见面不回归（D6 的那本账拆得对）────────────────────────────
    const guardIdx = code.indexOf('if (!isExplorationCall(tc.toolName, tc.args))');
    const guardBody = guardIdx < 0 ? '' : braceBlock(code, guardIdx);
    crit('M1', guardBody.includes('stepFps.push(toolCallFingerprint(') && guardBody.includes('recentToolNames.push(tc.toolName)'),
      'C7 两本账**各取所需**且都在"非探索"这一道闸内：`recentToolNames.push(tc.toolName)`（工具名，喂 '
      + '`failure_record`）与 `stepFps.push(toolCallFingerprint(…))`（完整调用，喂循环判据）',
      `guard 块 ${guardBody.split('\n').length} 行`);
    crit('M1', code.includes('tools: [...new Set(recentToolNames)].slice(-5)'),
      'C7 **用户可见面逐字不回归**：`failure_record.tools` 仍是**工具名**列表（经 `jobs/ai-task.ts` 渲染成'
      + '「主要工具：bash,read_file」给人看）——若误用指纹，那行会变成 `bash:{"command":…}`');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C】M2 —— 游程计数：一步一次，窗口由阈值派生');
  {
    const { db, projectId } = makeProjectDb();
    const th = getProjectThresholds(db, projectId);
    const cmdA = 'git -C example-backend status --short';
    const cmdB = 'mvn -q -DskipTests package';

    // C8 一步内 3 条**不同**命令 ⇒ 并行 ≠ 连续
    const l8 = runLens([[{ toolName: 'bash', args: { command: cmdA } },
      { toolName: 'bash', args: { command: cmdB } },
      { toolName: 'bash', args: { command: 'ls -la .' } }]]);
    crit('M2', l8[0] === 0,
      'C8 **该不命中**：一步内 3 条**不同**命令 ⇒ 游程 0（同一步里既发生 A 又发生 B，本身即非重复）',
      `游程=${l8[0]}`);

    // C9 一步内 3 条**相同**命令 ⇒ 一步只算一次
    const l9 = runLens([[{ toolName: 'bash', args: { command: cmdA } },
      { toolName: 'bash', args: { command: cmdA } },
      { toolName: 'bash', args: { command: cmdA } }]]);
    crit('M2', l9[0] === 1,
      'C9 **该不命中**：一步内 3 条**相同**命令 ⇒ 游程 **1**（一步一次；旧实现按调用逐条累加 ⇒ 旧值为 3）',
      `游程=${l9[0]}（旧实现此处为 3）`);

    // C10 连续 5 步各 1 条相同 ⇒ 5
    const l10 = runLens(repeatSteps(cmdA, th.toolLoopHard));
    crit('M2', l10[l10.length - 1] === th.toolLoopHard,
      `C10 **该命中**：连续 ${th.toolLoopHard} 步各 1 条相同 ⇒ 游程 ${th.toolLoopHard} ⇒ 到 hard 线`,
      `逐步游程=[${l10.join(',')}]`);

    // C11 打断有效
    const l11 = runLens([
      ...repeatSteps(cmdA, 2),
      [{ toolName: 'write_file', args: { filePath: '/x.md', content: 'hi' } }],
      ...repeatSteps(cmdA, 2),
    ]);
    crit('M2', l11[l11.length - 1] === 2 && l11[1] === 2,
      'C11 **打断有效**：第 3 步插了一件**别的**事 ⇒ 游程归零重起，末尾为 2（不是"旧游程残留接着涨"）',
      `逐步游程=[${l11.join(',')}]`);

    // C12 ★§1.5 学习阈值可达
    const learned = { toolLoopWarn: 10, toolLoopHard: 17 };
    const { db: db2, projectId: pid2 } = makeProjectDb(learned);
    const th2 = getProjectThresholds(db2, pid2);
    const l12 = runLens(repeatSteps(cmdA, th2.toolLoopHard));
    crit('M2', th2.toolLoopHard === learned.toolLoopHard && l12[l12.length - 1] === learned.toolLoopHard,
      'C12 ★ **§1.5 正面钉死**：学习阈值 `hard=17`（A股投顾项目在册值）**可达并命中**——'
      + '旧实现窗口上限硬编码 8 ⇒ 该项目的闸门**恒不可能触发**（静默失效）',
      `真源读得 hard=${th2.toolLoopHard} / 第 ${l12.length} 步游程=${l12[l12.length - 1]}`);

    // C13 ★§1.4 无窗口：历史长度不影响判定
    const tail3 = repeatSteps(cmdB, 3);
    const noHistory = runLens(tail3);
    const withHistory = runLens([
      ...repeatSteps(cmdA, 7),
      [{ toolName: 'bash', args: { command: 'ls -la .' } }], // 纯探索 ⇒ 存心把"窗口份额"占满
      ...tail3,
    ]);
    crit('M2', noHistory[2] === 3 && withHistory[withHistory.length - 1] === 3,
      'C13 ★ **§1.4 正面钉死**：同样"连 3 步同一命令"的输入，**前置 0 步** 与 **前置 7 步其它命令**'
      + '得到**同一个数 3** ⇒ 判定**与历史长度无关**（旧实现是"窗口内全同" ⇒ 窗口一满，'
      + '实际触发线从 5 被抬到 8 且报出的数也不再是"连续几次"）',
      `无前置=${noHistory[2]} / 有前置=${withHistory[withHistory.length - 1]}`);

    // C14 窗口上限只有阈值一处来源
    const fnIdx = code.indexOf('export function advanceLoopRun');
    const fnBody = fnIdx < 0 ? '' : braceBlock(code, fnIdx);
    crit('M2', fnBody.length > 0 && !/shift\(|>\s*\d/.test(fnBody),
      'C14 游程推进函数体内**零处**窗口裁剪（无 `shift(`、无与数字比较）⇒ 上限只有 `toolLoopWarn`/'
      + '`toolLoopHard` 一处来源（旧实现的 `length > 8 && shift()` 已删）',
      `函数体 ${fnBody.split('\n').length} 行`);

    // C14b `recentToolNames` 上那个 8 **不是**循环判据的窗口（它只喂给用户看的"主要工具"）
    crit('M2', code.includes('if (recentToolNames.length > 8) recentToolNames.shift();'),
      'C14b 剩下一处窗口 8 属 `recentToolNames`（喂 `failure_record` 的**展示**账，语义与今天逐字相同），'
      + '**不是**循环判据的上限 —— 两者不得混为一谈');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C】M3 —— 两处落点合一（A1 去重并入 A3 阶梯）');
  {
    const { db, projectId } = makeProjectDb();
    const th = getProjectThresholds(db, projectId);
    const cmdC = 'git -C example-backend status --short';

    // ── C15 改前/改后**等价**：默认档上"3 次警告 / 5 次暂停"逐点对上 ─────────────────
    const atWarn = runLens(repeatSteps(cmdC, th.toolLoopWarn));
    const atHard = runLens(repeatSteps(cmdC, th.toolLoopHard));
    crit('M3', th.toolLoopWarn === 3 && th.toolLoopHard === 5
      && atWarn[atWarn.length - 1] >= th.toolLoopWarn && atWarn[atWarn.length - 1] < th.toolLoopHard
      && atHard[atHard.length - 1] >= th.toolLoopHard,
      'C15 **改前/改后等价**（默认档 warn=3 / hard=5）：连 3 步同一调用 ⇒ 走到**警告**线（尚未到暂停），'
      + '连 5 步 ⇒ 到**暂停**线。旧 A1 的硬编码阈值也是 3（同一条线）⇒ 默认项目上"3 次警告 / 5 次暂停"不变',
      `warn=${th.toolLoopWarn}→游程${atWarn[atWarn.length - 1]} · hard=${th.toolLoopHard}→游程${atHard[atHard.length - 1]}`);

    // ── C16 ★**只剩一处**产出该警告文案（按符号扫，不按行号）──────────────────────
    const SENTENCE = '结果不会改变，请改用其他策略或直接产出';
    const hits = countOcc(code, SENTENCE);
    const ladderIdx = code.indexOf('if (continuousSame >= toolLoopWarn)');
    const ladderBlock = ladderIdx < 0 ? '' : braceBlock(code, ladderIdx);
    ok(codeLines > 0, `C16 扫描面自证：去注释后 ${codeLines} 行 > 0`);
    crit('M3', hits === 1 && ladderBlock.includes(SENTENCE) && ladderBlock.includes('PAUSE_REASON_TOOL_LOOP'),
      'C16 ★ **只剩一处**产出该警告文案：`' + SENTENCE + '` 在扫描面内**恰 1 处**，且就落在**同一条阶梯**块内'
      + '（该块同时含硬暂停 `PAUSE_REASON_TOOL_LOOP`）—— 旧 A1 那个并列的落点已合并进来，不再各算各的',
      `文案命中=${hits} 处 · 阶梯块 ${ladderBlock.split('\n').length} 行`);

    // C16b A1 那本**独立**的计数器与告警标签零处残留
    crit('M3', !code.includes('dedupCount') && !code.includes('lastToolFingerprint')
      && !code.includes('重复调用警告'),
      'C16b A1 那本**独立**的账已零处残留（`dedupCount` / `lastToolFingerprint` / `[重复调用警告]`）'
      + '⇒ 不是"两处都留着、只是把文案抄一份"的假合并',
      '');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C】M4 —— 停因可核（文案带命中的指纹）');
  {
    // ── C17 ★**该命中**：真循环时文案含指纹（且含的是**命令**，不是光秃秃的工具名）──────
    const fp0 = toolCallFingerprint('bash', { command: 'git -C example-backend status --short' });
    const shown = describeToolCall(fp0);
    ok(codeLines > 0, `C17 扫描面自证：去注释后 ${codeLines} 行 > 0`);
    crit('M4', shown.includes('bash') && shown.includes('git -C example-backend status --short')
      && shown !== 'bash' && !shown.includes('command='),
      'C17 ★ **该命中**：`describeToolCall` 把指纹摊成**含命令**的一行 ⇒ 误报时人一眼可证伪'
      + '（旧文案只有"bash"，看不出底下是几件不同的事）',
      `\`${shown}\``);

    // ── C17b ★**该不命中**：六条事故命令的展示形**两两不同** ────────────────────────
    const incidentFps = INCIDENT_STEPS.flat()
      .filter((c) => !isExplorationCall(c.toolName, c.args))
      .map((c) => describeToolCall(toolCallFingerprint(c.toolName, c.args)));
    const uniqShown = new Set(incidentFps);
    crit('M4', incidentFps.length >= 2 && uniqShown.size === incidentFps.length
      && !incidentFps.every((s) => s === 'bash'),
      'C17b ★ **该不命中**：事故里那几条 bash 的展示形**两两不同**（若退化成"仅工具名"的旧形态，'
      + '它们会全部坍成同一个 `bash`）—— 这条正是"不得只剩工具名"的反面标本',
      `${incidentFps.length} 条 ⇒ ${uniqShown.size} 个不同展示形`);

    // ── C18 生产**接线**：三个落点（软警告 / 硬暂停 / pause note）都带它 ──────────────
    const ladderIdxM4 = code.indexOf('if (continuousSame >= toolLoopWarn)');
    const ladderM4 = ladderIdxM4 < 0 ? '' : braceBlock(code, ladderIdxM4);
    const shownUses = countOcc(ladderM4, 'describeToolCall(');
    crit('M4', ladderM4.length > 0 && shownUses >= 1
      && countOcc(ladderM4, '${hitCall}') === 3,
      'C18 生产接线：阶梯块内**恰 3 处** `${hitCall}`（软警告文案 / 硬暂停文案 / `pauseTask` 的 note）'
      + '⇒ 三条告知路径**同一个**展示形，不会"一处带指纹、另一处还写着旧形态"',
      `阶梯块内用 ${shownUses} 次 describeToolCall / ${countOcc(ladderM4, '${hitCall}')} 处插值`);

    // ── C18b 旧"仅工具名"形态在文案里**零处**残留 ──────────────────────────────────
    crit('M4', !code.includes('次调用同一工具(') && !code.includes('次调用${toolName}'),
      'C18b 旧文案形态**零处**残留（`次调用同一工具(` / `次调用${toolName}`）—— 没有"新文案写了、旧文案还留着"',
      '');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C】M5 —— 收口纪律：本脚本零处轮次等值字面量（哑雷专项）');
  {
    // 承 `feedback_assertion_no_forward_literals.md`：等值断言写死本轮值 ⇒ 只对下一轮引爆的哑雷，
    //   且换语法外壳即可躲过 `PIN_RE` 那类前缀正则（故必须**另有一把尺**按形态扫，而不是靠 build 钉）。
    // ⚠ 轮次标签由**载体自身**派生（本脚本文件名），标本串亦**现拼** —— 否则标本自己就成了本文件里
    //   那"一处命中"，判据会被自己的标本判红（"判据也会被自己的形状咬到"的现成例子）。
    const ROUND = (path.basename(__filename).match(/zx_\d{8}(?:_\d+)?/) ?? [''])[0]!;
    ok(ROUND.length > 0, '哑雷专项自证：轮次标签由 `path.basename(__filename)` 派生（不手抄常量）', ROUND);
    const RE_DUMB = /(?:===|!==|==|!=|\beq\()\s*['"]zx_\d{8}[^'"]*['"]/g;
    const scan = (s: string): string[] => [...s.matchAll(RE_DUMB)].map((m) => m[0]);
    const selfSrc = strip(__filename);
    const hits = scan(selfSrc);
    // 两只标本一起试（只用"该命中"⇒ 任何过窄的变体全票通过；只用"该不命中"⇒ 任何过宽的变体全票通过）
    const probeHit = scan(`crit('M5', tag === '${ROUND}', 'x')`);
    const probeMiss = scan(`if (ROUND >= DERIVED) {}\nplanPath = 'plans/improve/' + ROUND + '.md';`);
    crit('M5', probeHit.length === 1 && probeMiss.length === 0 && hits.length === 0,
      'C19 本脚本**零处**轮次等值字面量（哑雷）；扫描器**两只标本都试过**：写死轮次的串必被抓到、'
      + '派生比较与方案路径必被放过',
      `命中 ${hits.length} 处 · 该命中标本 ${probeHit.length}/1 · 该不命中标本 ${probeMiss.length}/0`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S】build 钉（派生核对，不写轮次字面量；**不受批次门管辖**）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

/** 子串**出现次数**（C16 "只剩一处"类判据用；须配"扫描面 > 0 行"自证，防空扫恒绿）。 */
function countOcc(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0; let i = hay.indexOf(needle);
  while (i >= 0) { n++; i = hay.indexOf(needle, i + needle.length); }
  return n;
}

/**
 * 从 `fromIdx` 起找到第一个 `{`，按花括号配对返回**块体**（不含最外层花括号）。
 * ⚠ 承本仓纪律「切块须按符号 + 配对花括号」（行号是位置、会漂）。入参须是**已去注释**的源码，
 *   否则注释里的花括号会把配对带偏。
 */
function braceBlock(code: string, fromIdx: number): string {
  const open = code.indexOf('{', fromIdx);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return code.slice(open + 1, i); }
  }
  return code.slice(open + 1);
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告
//    unhandled rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20260922 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260922: ${pass} 通过 / ${fail} 失败${pending ? ` / ${pending} 待实施(不计入)` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
});
