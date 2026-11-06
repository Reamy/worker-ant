/**
 * zx_20260921 受控复跑 —— 「插头要插上」。
 *
 * 病根（`plans/improve/zx_20260921.md` §1，真库 + 源码实测）：**上游把东西做出来了，下游的插头从来没插上**。
 * 五条同形 —— 每一件都**在册**、每一件都**有现成的下游**，中间那一截**零代码在接**：
 *   D1 **附件落盘 → 上下文**：`saveInboundMedia` 真把件写到 `attachments/<UTC 日期>/` 并**返回 `savedPath`**，
 *      而 `im-router.ts` 只用它拼一句回执就**丢掉**；`context_json` 全仓**零处**写 `attachments`，
 *      而 `taskHasMedia`（`core/model-request.ts`）**只读不写** ⇒ `hasMedia` 恒假 ⇒ `vision` 恒不参与选型。
 *   D2 **引擎看不见附件内容**：`messages` 的类型是 `Array<{content: string}>`；无 pdf/ocr/asr 依赖；
 *      `read_file` 只读 utf-8 文本 ⇒ 图/PDF/音频进了上下文也**只能是文件名**。
 *   D3 **拆解器在册、真库零产出**：`decomposeTaskWithLLM` 只长在 IM 入站那一条路上（且真库 `source` 分布
 *      = agent/cron/user，**零** `auto-decompose`）；引擎自己的 planning 出口**不拆**。
 *   D4 **子任务放行回路四处断点**：GUI `task:updateStatus` 不调 `checkParentTaskAfterChildDone`；
 *      `resolveIndexDeps` 不排自环；`create_task` 的 `depends_on` 无环检查；悬挂 pending 子任务无出路。
 *   D5 **拆解产物的前置**（title/description/depends_on）没有被后续调度真正消费。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 本文件的**批次门**（`RR_STAGE`）—— 承 `zx_20260920_1` 的骨架纪律，同样的道理：
 *   方案 §2 是十个批次（M0…M9），判据**随批次转绿**。若不做区分，M0 落下时本脚本一片红，
 *   而"红"既可能是"还没实施"也可能是"实施错了"，两者混在一起**信息量为零**。
 *   故：每条判据登记其**所属批次**；`RR_STAGE=Mn` 时**只要求 M0..Mn 为绿**，更晚的批次打 `⏳`、**不计入失败**。
 *   `RR_STAGE` 为空 = **全部必须绿**（M9 收口用）。无 `RR_STAGE` 时，红计数即**待实施清单**。
 *
 * §G 判据 G（**M0 落地的**·与批次无关的**不变式门**，任何时刻都须成立）：
 *   G-1 **真源在位**：§1 五条病根所引用的生产符号**全部存在**（**直 import 判型**，不是扫源码字符串）
 *       ——"锚点还在"是后续每批的开工前提；符号被改名/删除时，后续批次的判据会退化成**扫字符串扫了个空**。
 *   G-2 **扫描面自证**：凡"零命中"类断言必须同时报出**扫描面命中数**（承 `zx_20260920_1 §G-1` 的教训）——
 *       否则"扫描面无匹配 ⇒ 零处违规恒真"，扫了个空也是绿。
 *   G-3 **去注释是真的去掉了**：本轮病根正是"注释/登记表里写着有、代码里没被用上"，
 *       故源码扫描一律**去注释**；本条钉"去注释这个动作本身**没把真代码也去掉**"。
 * §P 判据 P（**随批次转绿**，`RR_STAGE` 管辖）：
 *   C1–C6（M1）· C7–C11（M2）· C12–C15（M3）· C16–C19（M4）· C20–C23（M5）· C24–C27（M6）· C28–C33（M7）·
 *   C34/C35/C37（M8；C36「全量 rr 断言总数不减少」**不在本脚本内**——它由 M9 的全量回归计数承担）。
 *   ⚠ **就地订正（zx_20260921 M8）**：本行列的是 `crit('<batch>', …)` 里真正登记的那个编号，不是"P-n"。
 *     原文写的是 P-1…P-13（M1…M8），与正文里实际用的 `crit('M1', …, 'C1 …')` **编号体系不一致**（骨架期残留），
 *     照它去搜 `P-12` 会**一处也搜不到**——名实不符，故按实际编号重写。
 * §S 判据 S：`checkBuildPins(ok, { distDir })`（P1–P6 全套）—— **不受批次门管辖**：
 *   build 钉是**常驻不变式**（它派生标签，故换轮不会让它变红；它变红只说明真源被破坏）。
 *
 * ⚠ 本文件**不引** better-sqlite3 / electron 之外的重物；M0 阶段**只读源码**，不起夹具、不碰真库。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**（P6 取产物内 build 值本身，而非会被注释骗过的子串匹配）。
 * ⚠ 与 `zx_20260920_1.ts` 的**分工**：那一份治"用了才算数"（已收口）；本份治"插头要插上"，**互不覆盖**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { engineSrcFiles } from './lib/rr-engine-src.js';

// ── G-1 的**真源**：全部直 import 自生产那份实现（判"这个符号还在不在"，不是扫它的名字出现没出现）──
//   注：本区块的 import **刻意全是静态导入**，从而"符号被删/被改名"表现为**编译期失败**而非静默的假绿。
import {
  ATTACHMENTS_DIR,
  attachmentsRoot,
  mediaFromIlinkItems,
  mediaReceiptText,
  safeMediaFileName,
  saveInboundMedia,
} from '../apps/worker-ant-desktop/src/main/services/im-media.js';
import { NON_TEXT_LABELS, nonTextPlaceholder } from '../apps/worker-ant-desktop/src/main/services/im-adapter.js';
import { routeImMessage } from '../apps/worker-ant-desktop/src/main/services/im-router.js';
import { deriveModelCapabilities, buildModelRequest, taskHasMedia, attachmentsNeedVision } from '../apps/worker-ant-desktop/src/main/core/model-request.js';
import { checkParentTaskAfterChildDone } from '../apps/worker-ant-desktop/src/main/core/jobs/ai-task.js';
// M1 的 C1–C5 **一律跑真实现**：落盘走 `saveInboundMedia`、落库与建任务走真 `routeImMessage`、
//   取件走真 `takePendingMedia`、判"挂上了没有"走生产那份 `taskHasMedia`（C6：**不自抄谓词**）。
import { takePendingMedia, attachmentEntry, PENDING_MEDIA_WINDOW_MS } from '../apps/worker-ant-desktop/src/main/services/pending-media.js';
import { familyOf, maxBytesOf, IMAGE_MAX_BYTES, FAMILY_MAX_BYTES } from '../apps/worker-ant-desktop/src/main/core/attachment-kinds.js';
import { buildAttachmentParts } from '../apps/worker-ant-desktop/src/main/core/attachment-inline.js';
import { extractPdfText, PDF_MAX_PAGES, PDF_MAX_CHARS } from '../apps/worker-ant-desktop/src/main/core/pdf-text.js';
import { IMAGE_PREVIEW_MAX_BYTES } from '../apps/worker-ant-desktop/src/main/core/deliverable-types.js';
import { estimateContentTokens, contentChars, IMAGE_PART_TOKEN_ESTIMATE } from '../apps/worker-ant-desktop/src/main/core/context-compaction.js';
// M4 的 C16–C19 **一律跑生产那份组合**：`makeAudioTranscriber` 本体在 `audio-transcribe.ts`
//   （2026-09-21 就地订正，从 `agent-executor.ts` 搬出）⇒ 判据调的就是生产调的那个函数，
//   不是"照抄一份等价物"（那证的是夹具自己，本轮 §7 头号风险）。
//   `AUDIO_IO` 是生产缺省 io：判据用 `{ ...AUDIO_IO, probe: () => true, run: 指向 shell 桩 }`
//   **组合**出"真 spawn 实现 + 确定性 ffmpeg"，既不依赖"本机恰好装了 ffmpeg"，也不绕开生产那套超时/收 stderr。
import {
  AUDIO_CAPABILITY,
  AUDIO_DATA_URL_HOSTS,
  AUDIO_DATA_URL_PREFIX,
  AUDIO_IO,
  FFMPEG_BIN,
  audioDataShapeOf,
  buildAudioModelRequest,
  makeAudioTranscriber,
  normalizeToWav,
  transcribeAudio,
  type AudioEndpoint,
} from '../apps/worker-ant-desktop/src/main/core/audio-transcribe.js';
// M5 的 C20–C22 与行为判据**一律跑真实现**：工具体取生产那份 `mediaTools(deps)`（不是照抄一份等价物），
//   档位判据取生产那份 `availableToolNames` / `narrowToolFace`（C21/C22 要证的正是"生产收窄算得出来"）。
//   `TOOL_METAS` 直取生产表：C20 的自证 `TOOL_METAS.length === toolRegistry.listNames().length` 只有在**真表**上才有意义。
import { mediaTools } from '../apps/worker-ant-desktop/src/main/core/tools/media.js';
import { TOOL_METAS, toolRegistry } from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';
import {
  ARCHETYPE_TOOL_CATEGORIES,
  availableToolNames,
  narrowToolFace,
  type TaskArchetype,
} from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';
// M6 的 C23–C26 **一律跑真实现，且是端到端的那一层**：不自己复刻一份"拆解→建行"的等价物
//   （那证的是夹具自己，本轮 §7 头号风险）。判据走的是**生产工具体本体**：
//   `controlTools(...)` 取生产那份 `enter_plan_mode.execute`，喂一个内存库 + 桩 `ansClient` + 桩 `fetch`，
//   于是"引擎 planning 出口自己拆"这件事是**真跑出来的**，不是扫源码扫出来的。
//   ⚠ 桩只打在**系统的边**（网络出口 + ANS 选型口），prompt 构造 / 解析 / 落库 / 回话全部是生产代码。
import {
  DECOMPOSE_MODEL_REQUEST,
  buildDecomposePrompt,
  decomposeTask,
  parseDecomposition,
  planSubtasksFromTemplate,
} from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
import { resolveIndexDeps } from '../apps/worker-ant-desktop/src/main/core/dep-graph.js';
import { MAX_TASK_DEPTH, MAX_CHILD_BREADTH, decomposePriority } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import { BOOL_SETTING_KEYS, readBoolSetting } from '../apps/worker-ant-desktop/src/main/core/settings-bool.js';
import { controlTools } from '../apps/worker-ant-desktop/src/main/core/tools/control.js';
// M7 的 C28/C31 **一律跑真实现**：GUI 那条路的薄函数与自愈那条路的对账函数都**直引生产那份**
//   （⚠ `ipc/project.ipc.ts` 顶层 import electron、node 里 import 不进来 ⇒ 该薄函数本身也**抽到了 core**，
//   否则 rr 只能复刻一份等价物，而那正是"判据的自我印证"）。
import { afterTaskTerminalStatus } from '../apps/worker-ant-desktop/src/main/core/task-terminal-release.js';
import { setJobEnqueuer } from '../apps/worker-ant-desktop/src/main/core/job-enqueuer.js';
import { reconcileStalledSubtasks } from '../apps/worker-ant-desktop/src/main/core/self-healing-monitor.js';
// M8 的 C34/C35 **一律直 import 生产那两份**（执行体 + 五个新模块）：符号被删/改名 ⇒ **编译期失败**，
//   而不是"扫字符串扫了个空、静默假绿"。后六行里的 `CTX_*_MAX_CHARS` / `SYSTEM_PROMPT_BASE` /
//   `truncateCtx` / `classifyTaskGuidance` 是**执行体仍 export 的原位符号**（搬迁只为让新模块 import 得到，
//   真源仍在执行体一处、数值一格未动）——判"导出面没被拆坏"必须直取它们，不能扫名字。
import {
  CTX_HISTORY_TAIL_MAX_CHARS,
  CTX_MEMORY_MAX_CHARS,
  CTX_PROJECT_MAX_CHARS,
  SYSTEM_PROMPT_BASE,
  classifyTaskGuidance,
  truncateCtx,
} from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { claimTaskForExecution, preExecutionConfirmGate, captureSnapshotBeforeRun } from '../apps/worker-ant-desktop/src/main/core/exec-claim.js';
import { selectModelForTask } from '../apps/worker-ant-desktop/src/main/core/exec-model-select.js';
import { resolveTaskBudget } from '../apps/worker-ant-desktop/src/main/core/exec-budget.js';
import { buildTaskContext } from '../apps/worker-ant-desktop/src/main/core/exec-context.js';
import { finalizeRunClose } from '../apps/worker-ant-desktop/src/main/core/exec-finalize.js';
// zx_20260924_1 M7-c：记忆装配整块迁出执行体（`buildMemoryContext` 及其同址的段取舍/置信标签）。
//   它与上面五块**同属一本账**——"该符号不得再回执行体、且在新模块原位可取到"，故登记进 `MOVED_SYMBOLS`；
//   不登记则本账**漏管一块**（将来有人把它塞回执行体，只有 C34 的行数方向会间接响，按名字的判据不会）。
import { buildMemoryContext, memoryConfTag, selectMemorySections } from '../apps/worker-ant-desktop/src/main/core/memory-context.js';
// ⚠ 取**生产那份** `mergePlanModeContext`（`agent-executor.ts`），不手抄一份等价物：
//   `enter_plan_mode` 的 context_json 合并语义（只补写不重建）正是它负责的，抄一份＝证夹具自己。
import { mergePlanModeContext } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
// M5-4 的真跑要**生产那份 provider 工厂**（它顺手删 `tool_choice`，见 `ai-provider.ts`）——
// 走裸 `createOpenAI` 会让"这条请求体由生产发出"这句话失去依据，故下面另配一只裸工厂标本做反证。
import { createSafeProvider } from '../apps/worker-ant-desktop/src/main/core/ai-provider.js';
// ⚠ `ai` / `@ai-sdk/openai` 在本仓**不是根级依赖**（pnpm 只在 `apps/worker-ant-desktop/node_modules` 下建链），
//   而本脚本 cwd = 仓库根 ⇒ 裸 `import 'ai'` 会 ERR_MODULE_NOT_FOUND。故走 `createRequire` 按**桌面 app 的
//   解析面**取真入口，再动态 import（M5 的 C23 要跑**真** `generateText`，不能用替身冒充）。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

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
/** 内存库只用到 `prepare/exec` 这么点能力——`node:sqlite` 的 `DatabaseSync` 与 better-sqlite3 都满足。 */
type AnyDb = {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
  exec: (s: string) => void;
};
/** 扫源码一律**去注释**：本轮病根正是"注释里写着有、代码里没被用上"，不去注释则判据会被喂饱。 */
const strip = (p: string) => stripKeepingLines(fs.readFileSync(p, 'utf-8')).join('\n');
const raw = (p: string) => fs.readFileSync(p, 'utf-8');

/**
 * zx_20260921 M8：`executeTask` 按职责拆出 `core/exec-*.ts` ⇒ 凡本意是"**生产真走那条路**"的源码级判据
 * （而非"某个特定文件里得有这段"），扫描面取「执行体 ∪ `core/exec-*.ts`」。约定只有 `lib/rr-engine-src.ts` 一处。
 * ⚠ 只许更严（横跨两处，任一处违例即红）；**文件名本身就是判据**的那类**不得**改用它（会变松）。
 */
const execSurfaceFiles = engineSrcFiles();
const execSurface = () => execSurfaceFiles.map((p) => strip(path.join(root, p))).join('\n');

/**
 * 搬迁的**落点**：`[新模块文件, 导出符号]`——判据按**符号**定位，不按行号（行号是位置，会漂）。
 * M8 五块（`exec-*.ts`）+ zx_20260924_1 M7-c 的记忆外迁（`memory-context.ts`），共**六块**。
 * ⚠ 只登记**函数**：C35 逐个断言"取到的是函数"（`typeof === 'function'`），
 *   而 `MEM_OVERHEAD` 之类是常量、`MEM_SECTION_PRIORITY` 是表——登记它们会让"非函数 0 个"这条判据失真。
 */
const MOVED_SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ['exec-claim.ts', 'claimTaskForExecution'],
  ['exec-claim.ts', 'preExecutionConfirmGate'],
  ['exec-claim.ts', 'captureSnapshotBeforeRun'],
  ['exec-model-select.ts', 'selectModelForTask'],
  ['exec-budget.ts', 'resolveTaskBudget'],
  ['exec-context.ts', 'buildTaskContext'],
  ['exec-finalize.ts', 'finalizeRunClose'],
  ['memory-context.ts', 'buildMemoryContext'],
  ['memory-context.ts', 'selectMemorySections'],
  ['memory-context.ts', 'memoryConfTag'],
];

/** 搬迁产出的**新模块**（报出各自行数用；逐个符号的落点由 `MOVED_SYMBOLS` 盯）。 */
const MOVED_MODULE_FILES = ['exec-claim.ts', 'exec-model-select.ts', 'exec-budget.ts', 'exec-context.ts', 'exec-finalize.ts', 'memory-context.ts'];

/**
 * C34 的**基线**——它是**历史事实**，不是"本轮值"。
 *
 * 承 `feedback_assertion_no_forward_literals.md`：等值字面量是"只对下一轮引爆的哑雷"。故此处一律取
 * **`<` 方向比较**（"执行体不得长回拆分前"），只在**把代码塞回执行体**时才变红——那正是本条要抓的事。
 * 两组读数都取自**拆分之前**，且与判据**同一套记账函数**实测（`bodyOpen` + `braceBlock` + 行计数），故可直接比较：
 *   · **M0 提交 `73806c1a`**（`git show 73806c1a:apps/…/agent-executor.ts | wc -l` = 4680）：
 *     文件 **4681** 行；`executeTask` `:1113`–`:3396`，计 **2284** 行。
 *   · **拆分前一刻 `c10d6f04^`**（`wc -l` = 4734）：文件 **4735** 行；`executeTask` `:1127`–`:3450`，计 **2324** 行。
 *   （本处按 `split('\n').length` 记账，比 `wc -l` 大 1——文件末尾换行后的那个空串。差量 1 行，与净减量
 *     相差两个数量级，不影响方向判定；下面 C34 会把两种口径都在场自证。）
 *   ⚠ **方案 §M8 细化块把后者标成"实测基线"，并把前者说成"M0 落基线**前**的旧读数"——provenance 记反了**：
 *     `git show 73806c1a:…` 实测即 4680，那**正是** M0 的读数；后者（4734）才是 M1–M7 期间长出来的。
 *     两组都早于拆分，方向判定不受影响；本判据取**更早、更严**的那组（M0），详情里把两组都报出来。
 */
const M0_EXECUTOR_LINES = 4681;
const M0_EXECUTE_TASK_LINES = 2284;
const PRE_SPLIT_EXECUTOR_LINES = 4735;
const PRE_SPLIT_EXECUTE_TASK_LINES = 2324;

/** 递归收集 `src/main` 下全部 `.ts`——多条判据的扫描面是**整个 src/main**，不是只扫 `core/`。 */
function walkTs(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}
const rel = (p: string) => path.relative(root, p).split(path.sep).join('/');

/**
 * 取 `from` 处起的**配对花括号块**（按符号定位、不按行号——行号是位置，会漂）。
 * 承 `zx_20260918` 的教训：切块须按符号 + 配对花括号。
 */
function braceBlock(src: string, from: number): string {
  let i = src.indexOf('{', from);
  if (i < 0) return '';
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return src.slice(i);
}

/**
 * 在**给定源码**里找出「把 `attachments` 这一支真的写进 `context_json`」的语句。
 *
 * 为什么按**标识符 / JSON 路径联动**而不是按"行内同时出现两个词"：生产这截的写法是**多行**，
 *   且随 `zx_20260924 §2e` **换过一次形**（见下）。第一版判据按单行扫（含 `context_json` 的行里找 `attachments`）
 *   ⇒ **恒为 0**，而那是**判据的形状假设错了，不是源码错**（承 `zx_20260920_1` 的教训：回退的只能是判据的形状假设）。
 *
 * 现在同时认两种**真写法**（都是"把附件并进任务上下文"，只是落点不同）：
 *   形 A（JS 序列化）：① 被赋 `.attachments` 的标识符集 ② 被 `JSON.stringify(<ident>)` 送进写 `context_json`
 *     语句的标识符集，**两者有交集**才算接上——既容得下多行写法，也拦得住"赋给 A、序列化 B"这种**假接线**。
 *   形 B（SQL 内建 JSON 写 = `zx_20260924 §2e` 之后的**现行形**）：语句里用 `json_set(...)` 把
 *     `$.attachments` 这一支写进 `context_json`（真源：`services/pending-media.ts` 的 `attachPendingMediaToTask`）。
 *     取件+落库收成**一个出口**后，JS 侧不再有中间对象可序列化，形 A 那种"赋了再 `stringify`"的写法
 *     **在树上已经不存在**——判据改认它此刻的样子，**不是放宽**（判据的两种写法都要求"附件那一支进 `context_json`"）。
 *     ⚠ 路径尾部 `\b`：`$.attachments_outcomes`（`zx_20260924 M7` 的**去向账**，另一个键）不得计入——
 *      `_` 属词字符，`\b` 在 `s` 与 `_` 之间不成立。下面拿树上**正在写** `$.attachments_outcomes` 的
 *      `core/agent-executor.ts` 当"该不命中"标本试它（不手搓等价物，直接拿真代码试）。
 */
function linkedAttachmentWrites(src: string): { stmts: string[]; writePoints: number } {
  const assigned = new Set<string>();
  for (const m of src.matchAll(/(\w+)\.attachments\s*=/g)) assigned.add(m[1]!);
  const writeStmts: string[] = [];
  for (const m of src.matchAll(/(?:INSERT\s+INTO|UPDATE)\s+\w+[\s\S]{0,400}?;/g)) {
    const t = m[0]!;
    if (!/context_json/.test(t)) continue;      // 只看写 `context_json` 的那些语句
    writeStmts.push(t);
  }
  const stmts = writeStmts.filter((t) => {
    // 形 A：赋了 `.attachments` 的那个对象被 `JSON.stringify` 送进本语句。
    const ids = [...t.matchAll(/JSON\.stringify\(\s*(\w+)/g)].map((x) => x[1]!);
    if (ids.some((id) => assigned.has(id))) return true;
    // 形 B：本语句把 `$.attachments` 这一支写进 `context_json`（`json_set`，路径尾 `\b` 见上）。
    return /json_set\s*\([\s\S]{0,200}?\$\.attachments\b/.test(t);
  });
  return { stmts, writePoints: writeStmts.length };
}

/**
 * 造一份最小 PDF。**刻意不写交叉引用表**——`pdf-text.ts` 本来就线性扫 `N G obj`（见其文件头不支持清单），
 * 夹具补一份 xref 只会让"读不出正文"的归因变浑。每页一个 FlateDecode 内容流，`/Length` 按实算。
 *
 * ⚠ **提到模块作用域**（M5 就地调整）：M3 的 C12–C14 与 M5 的 `read_document` 行为判据
 *   **要喂同一种夹具**——两处各写一份"最小 PDF"就成了两套夹具自说自话。同一份生成器，
 *   两者的"写进去的字"才是同一个 `%PDF-1.4` 口径。
 */
function makePdf(pageStreams: string[], fontDict?: string): Buffer {
  const n = pageStreams.length;
  const contentNums: number[] = []; const pageNums: number[] = [];
  let next = 1;
  for (let i = 0; i < n; i++) contentNums.push(next++);
  for (let i = 0; i < n; i++) pageNums.push(next++);
  const pagesNum = next;
  const fontNum = fontDict ? next + 1 : 0;
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const emit = (num: number, head: string, stream?: Buffer): void => {
    chunks.push(Buffer.from(`${num} 0 obj\n${head}\n`, 'latin1'));
    if (stream) chunks.push(Buffer.from('stream\n', 'latin1'), stream, Buffer.from('\nendstream\n', 'latin1'));
    chunks.push(Buffer.from('endobj\n', 'latin1'));
  };
  pageStreams.forEach((src, i) => {
    const s = zlib.deflateSync(Buffer.from(src, 'latin1'));
    emit(contentNums[i]!, `<< /Length ${s.length} /Filter /FlateDecode >>`, s);
  });
  pageNums.forEach((num, i) => {
    const res = fontDict ? ` /Resources << /Font << /F1 ${fontNum} 0 R >> >>` : '';
    emit(num, `<< /Type /Page /Parent ${pagesNum} 0 R /Contents ${contentNums[i]!} 0 R${res} >>`);
  });
  emit(pagesNum, `<< /Type /Pages /Kids [${pageNums.map((x) => `${x} 0 R`).join(' ')}] /Count ${n} >>`);
  if (fontDict) emit(fontNum, fontDict);
  chunks.push(Buffer.from(`trailer\n<< /Root ${pagesNum} 0 R /Size ${next + (fontDict ? 1 : 0)} >>\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

/** 一页的正文：首行贴当前文本位置，其后每行用非零垂直 `Td` 下移（`pdf-text.ts` 据此断行）。 */
const pageStream = (lines: string[]): string =>
  `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => (i === 0 ? `(${l}) Tj` : `0 -14 Td (${l}) Tj`)).join(' ')} ET\n`;

/**
 * 造一份**结构真实的**最小 PNG（1×N 像素、真 IHDR/IDAT/IEND + 真 CRC32）。
 *
 * 为什么不拿仓库里现成的 png 当夹具：一是"内容已知"要靠**生成代码与断言读同一组常量**（承 M3 的夹具纪律），
 * 二是 `view_image` 要验的是"**字节数报得准不准**"——外挂文件的字节数会随别人改图而变。
 * 为什么不随便写几个字节：`nativeImage` 之外还有"这文件将来真能被坐实成图"的可能，
 * 一坨不像 PNG 的字节会让"降级为 null 尺寸"与"根本不是图"混成一个结论。
 */
function makePng(width: number, height: number): Buffer {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  const raw = Buffer.alloc(height * (1 + width * 3)); // 每行 1 字节 filter + RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main(): Promise<void> {
  // ═════════════════════════════════════════════════════════════════════════
  console.log(`\n【G】M0 不变式门（批次无关，任何时刻须成立）${STAGE ? `　[RR_STAGE=${STAGE}]` : '　[RR_STAGE=全部]'}`);

  // ── G-1 真源在位（按符号，不按行号）────────────────────────────────────────
  {
    const fns: Array<[string, unknown]> = [
      ['im-media.saveInboundMedia', saveInboundMedia],
      ['im-media.mediaFromIlinkItems', mediaFromIlinkItems],
      ['im-media.mediaReceiptText', mediaReceiptText],
      ['im-media.safeMediaFileName', safeMediaFileName],
      ['im-media.attachmentsRoot', attachmentsRoot],
      ['im-adapter.nonTextPlaceholder', nonTextPlaceholder],
      ['im-router.routeImMessage', routeImMessage],
      ['model-request.deriveModelCapabilities', deriveModelCapabilities],
      ['model-request.buildModelRequest', buildModelRequest],
      ['model-request.taskHasMedia', taskHasMedia],
      ['ai-task.checkParentTaskAfterChildDone', checkParentTaskAfterChildDone],
    ];
    const missing = fns.filter(([, v]) => typeof v !== 'function').map(([n]) => n);
    ok(missing.length === 0 && fns.length === 11,
      `G-1 真源在位：§1 病根引用的 ${fns.length} 个生产符号全部可按函数取用`,
      missing.length ? `缺：${missing.join(', ')}` : `${fns.length}/${fns.length}`);
    // 常量面（`ATTACHMENTS_DIR` / `NON_TEXT_LABELS` 是**全仓真源**，M1/M2 的两张表都按它们对表）
    ok(typeof ATTACHMENTS_DIR === 'string' && ATTACHMENTS_DIR === 'attachments',
      'G-1 真源在位：`ATTACHMENTS_DIR` 仍是全仓唯一真源（值 `attachments`）', `= ${JSON.stringify(ATTACHMENTS_DIR)}`);
    ok(NON_TEXT_LABELS && typeof NON_TEXT_LABELS === 'object' && Object.keys(NON_TEXT_LABELS).length > 0,
      'G-1 真源在位：`NON_TEXT_LABELS` 仍在册（非文本标签真源）', `${Object.keys(NON_TEXT_LABELS).length} 键`);
  }

  // ── G-3 去注释是真的去掉了（判据自身受判据管）──────────────────────────────
  {
    // 造一段**注释里写着 `attachments`、代码里没有**的样本：去注释后必须**取不到**它。
    //   这正是本轮病根的形状——注释宣称"已接线"而代码没接，若扫描不去注释，判据会被注释喂饱。
    const specimen = [
      'const a = 1; // context_json 已写 attachments',
      '/* attachments: [ ... ] */',
      'const b = 2;',
    ].join('\n');
    const stripped = stripKeepingLines(specimen).join('\n');
    ok(!stripped.includes('attachments') && stripped.includes('const a = 1;') && stripped.includes('const b = 2;'),
      'G-3 去注释：样本里注释中的 `attachments` 被去掉，而真代码两行**原样保留**',
      `去注释后 attachments 出现 ${(stripped.match(/attachments/g) || []).length} 次`);
  }

  // ── G-2(rr 骨架自证) 批次门本身工作正常 ───────────────────────────────────
  {
    // 判据自身也须受判据管：门若坏了（恒真/恒假），后面"红=待实施"这句话就不成立。
    const gateOk = required('M0') === true && (STAGE === '' ? required('M9') === true : required('M9') === false);
    ok(gateOk, 'G-2 批次门自证：`required()` 对本批为真、对更晚批次按 STAGE 取值',
      `STAGE=${STAGE || '(空=全部)'} ⇒ required(M0)=${required('M0')} / required(M9)=${required('M9')}`);
    ok(ORDER.length === 10 && ORDER[0] === 'M0' && ORDER[9] === 'M9',
      'G-2 批次门自证：批次序覆盖方案 §2 的 M0…M9 十档', `${ORDER.join('/')}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【P】M0 基线固证 —— 三条病根断言的**扫描面**先立住（先看到红）');

  // ── M0-1 扫描面自证：`im-router.ts` 的建任务 INSERT 真的被定位到（防"扫了个空"）──
  const routerSrc = strip(`${MAIN}/services/im-router.ts`);
  {
    const inserts = routerSrc.match(/INSERT\s+INTO\s+wa_tasks\b/g) || [];
    // zx_20260929 M5-c 就地订正（改钉更强真源，非放宽）：本判据原要求 **≥2 处**（IM 建任务 + 拆解子任务）。
    //   M5-c 把拆解落行归到唯一实现 `planSubtasksFromTemplate` ⇒ 本文件**两处** INSERT 都只剩父任务建行
    //   （`handleCreateTask` 与 A7「编号选择→建任务」），**子任务落行那条（11 列）整条退场**。
    //   判据从"数量 ≥2"改为"**数得出几处，且每一处都是父任务那条**"——数量换了形状，但"扫描面非空"
    //   这一自证目的仍成立且更精确（原形只说"至少两处"，说不出那些是什么；现在"是父任务 INSERT"这件事
    //   逐处被断言，M5-c 若只删了正本而漏删副本，这里就会报出对不上的那一处）。
    const parentInserts = (routerSrc.match(/INSERT INTO wa_tasks \(id, project_id, title, description, priority, status, context_json\)/g) || []).length;
    ok(inserts.length > 0 && parentInserts === inserts.length,
      'M0-1 扫描面自证：`im-router.ts` 里每处 `INSERT INTO wa_tasks` **都是父任务建行那条**'
      + '（子任务落行已归唯一实现，M5-c）',
      `共 ${inserts.length} 处 / 父任务形状 ${parentInserts} 处`);
    ok(!routerSrc.includes('INSERT INTO wa_tasks (id, project_id, title, description, status, priority,'),
      '★ M5-c：本文件**不再自带**子任务落行（11 列那条已退场，改调 `planSubtasksFromTemplate`）');
  }

  // ── P-1（M1）`im-router.ts` 的建任务路径**接上了附件的写者** ────────────────
  {
    // 形状（**2026-09-24 §2e 就地订正**）：本轮把"取件 + 并进 `context_json`"收成**一个出口**
    //   `attachPendingMediaToTask`（真源 `services/pending-media.ts`），而两条真正落到任务的路上都调它。
    //   ⇒ 建任务路的接线由「`im-router.ts` 里出现 `attachments` 这个词」变为**符号级三件齐**：
    //     ① import 那个助手 ② 真的调用它 ③ 助手实现里确有写 `context_json` 的 `$.attachments` 语句。
    //   判据**只强不弱**：旧形只要有那个词在场（连"在册不用"都拦不住），新形要三件齐；且"写点"用的
    //   与 P-2 **同一份** `linkedAttachmentWrites`（一处真源，不另抄一个正则）。
    //   ⚠ 改的是**判据的形状假设**（旧形随单出口重构已不在树上——`im-router.ts` 现在只调助手、不自己拼对象），
    //     **不是放宽**；这正是本仓「只有全量才照得出」那一类（改动面推导推不出别的脚本钉了旧形状）。
    const helperSrc = strip(`${MAIN}/services/pending-media.ts`);
    const importOk = /import\s*\{[^}]*\battachPendingMediaToTask\b[^}]*\}\s*from\s*'\.\/pending-media\.js'/.test(routerSrc);
    const calls = [...routerSrc.matchAll(/\battachPendingMediaToTask\s*\(/g)].length;
    const helperWrites = linkedAttachmentWrites(helperSrc).stmts.length;
    crit('M1', importOk && calls >= 1 && helperWrites >= 1,
      'P-1 `im-router.ts` 的建任务路径**接上附件写者**（符号级）：import `attachPendingMediaToTask` + 真的调用它，'
      + '且其实现里有写 `context_json` 的 `$.attachments` 语句',
      `import=${importOk} / 调用 ${calls} 处 / 助手写点 ${helperWrites} 处`);
  }

  // ── P-2（M1）全仓 `context_json` 写点里有 attachments ──────────────────────
  {
    const files = walkTs(MAIN);
    let totalWritePoints = 0;
    let linkedCount = 0;
    const linkedFiles: string[] = [];
    for (const f of files) {
      const r = linkedAttachmentWrites(strip(f));
      totalWritePoints += r.writePoints;
      if (r.stmts.length) { linkedCount += r.stmts.length; linkedFiles.push(`${rel(f)}×${r.stmts.length}`); }
    }
    ok(totalWritePoints >= 10,
      'M0-1 扫描面自证：全仓写 `context_json` 的语句 ≥ 10 条（扫描面不是空的）',
      `扫到 ${totalWritePoints} 条语句 / ${files.length} 个文件`);
    crit('M1', linkedCount >= 1,
      'P-2 全仓有语句把 `attachments` 写进 `context_json`（≥1 处）——`taskHasMedia` 那个读者**终于有了写者**',
      `扫到 ${linkedCount} 处｜${linkedFiles.join(' , ') || '(无)'}（扫描面 ${totalWritePoints} 条写点语句）`);

    // **两种真写法各一对标本**（只用一只，过宽/恒假的谓词都看不出来）：
    //   ①「该命中·形 A」：多行 JS 写法（赋 `attachments` 与 `JSON.stringify` **不在同一行**）⇒ 必须判真。
    const hitJs = [
      `const taskCtx: Record<string, unknown> = { source: 'im' };`,
      `if (media) taskCtx.attachments = [entry];`,
      `ctx.db.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run(id, JSON.stringify(taskCtx));`,
    ].join('\n');
    ok(linkedAttachmentWrites(hitJs).stmts.length === 1,
      'P-2 「该命中·形 A(JS 序列化)」标本：**多行**写法（赋 `attachments` 与 `JSON.stringify` 不同行）被同一谓词判真',
      `判出 ${linkedAttachmentWrites(hitJs).stmts.length} 处`);
    //   ②「该不命中·形 A」：**假接线**——赋给 `taskCtx`，却序列化另一个对象 `other` ⇒ 必须判假。
    const missJs = [
      `const taskCtx: Record<string, unknown> = {};`,
      `const other: Record<string, unknown> = {};`,
      `taskCtx.attachments = [entry];`,
      `db.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run(id, JSON.stringify(other));`,
    ].join('\n');
    ok(linkedAttachmentWrites(missJs).stmts.length === 0,
      'P-2 「该不命中·形 A」标本：**假接线**（赋给 `taskCtx`、序列化 `other`）被同一谓词判假',
      `判出 ${linkedAttachmentWrites(missJs).stmts.length} 处`);
    //   ③「该命中·形 B」：SQL 内建 JSON 写——**逐字取现行真源那一句**（不是照抄一份想象的形状；
    //      承 `zx_20260924 §2d` 教训：手写形状的标本会把生产第一跳就断掉的路判成绿）。
    const hitSql = [
      `db.prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.attachments', json(?)) WHERE id = ?")`,
      `  .run(JSON.stringify(list), taskId);`,
    ].join('\n');
    ok(linkedAttachmentWrites(hitSql).stmts.length === 1,
      'P-2 「该命中·形 B(SQL json_set)」标本：现行真源那一句（把 `$.attachments` 写进 `context_json`）被同一谓词判真',
      `判出 ${linkedAttachmentWrites(hitSql).stmts.length} 处`);
    //   ④「该不命中·形 B」：同样 `json_set` 写 `context_json`，但路径**不是** `attachments` ⇒ 必须判假。
    const missSql = [
      `db.prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.summary', json(?)) WHERE id = ?")`,
      `  .run(JSON.stringify(list), taskId);`,
    ].join('\n');
    ok(linkedAttachmentWrites(missSql).stmts.length === 0,
      'P-2 「该不命中·形 B」标本：写的是 `$.summary`（同表同列、非 `attachments` 那一支）被同一谓词判假',
      `判出 ${linkedAttachmentWrites(missSql).stmts.length} 处`);
    //   ⑤「该不命中·**树上真标本**」：`core/agent-executor.ts` 正在写 `$.attachments_outcomes`
    //      （M7 的**去向账**，另一个键）⇒ **不得**被计入，否则 P-2 会因"另一个键"而假绿。
    //      这条只有拿**真代码**试才试得出来（手搓标本试不出"树上恰好有个形近的键"）。
    const execSrc = strip(`${MAIN}/core/agent-executor.ts`);
    const execHits = linkedAttachmentWrites(execSrc).stmts.length;
    ok(execHits === 0 && /\$\.attachments_outcomes\b/.test(execSrc),
      'P-2 「该不命中·树上真标本」：`core/agent-executor.ts` 写着 `$.attachments_outcomes`（另一个键）⇒ 不计入',
      `该文件判出 ${execHits} 处 / 形近键在场=${/\$\.attachments_outcomes\b/.test(execSrc)}`);
  }

  // ── P-3（M2）生产执行面的 messages 收得住**非文本内容** ────────────────────
  {
    // zx_20260921 M8: `messages` 的**类型声明**随上下文装配段搬至 `core/exec-context.ts`
    //   ⇒ 本块改读「执行体 ∪ `core/exec-*.ts` ∪ `core/tools/*.ts`」并集（真源在 `lib/rr-engine-src.ts`）。
    //   ⚠ 只放宽**扫描面**、不放宽**判据**：三条判据（声明在不在 / 是不是 CoreMessage / 接线两半都在）一字未改。
    //   ⚠ ③ 的两处接线（`userContent` 装配与 `persistTurnMessage` 只收文本）**仍在执行体**——并集同时覆盖，无需分家。
    const exeSrc = execSurface();
    // ① 扫描面自证：messages 的**类型声明**被定位到。按符号/结构定位，不按行号（行号是位置会漂）。
    //    ⚠ 目标态是 `CoreMessage[]`，**不再是** `Array<{role…; content: string}>`——
    //    所以这里不能钉死老形状（那会变成"只对旧源码为真"的哑雷）；改判"声明**在不在**"+ 下面的"**是什么**"。
    const decl = exeSrc.match(/const\s+messages\s*:\s*([^=]+?)\s*=\s*\[\]/);
    ok(decl !== null,
      'M0-1 扫描面自证：生产执行面（执行体 ∪ `core/exec-*.ts` ∪ `core/tools/*.ts`）里 messages 的类型声明被定位到',
      decl ? `: ${decl[1]!.trim()}` : '未定位到（符号可能已被改——**先把这条修好**，别把"没定位到"读成"已放宽"）');
    // ② 目标态：类型取自 `'ai'` 的 `CoreMessage`（收得住 `Array<TextPart|ImagePart>`）。
    const typeTxt = decl ? decl[1]!.trim() : '';
    crit('M2', !!decl && /\bCoreMessage\b/.test(typeTxt) && !/content\s*:\s*string\b/.test(typeTxt),
      'P-3 messages 的类型由 `\'ai\'` 的 `CoreMessage` 定 —— `content` 不再是裸 `string`（图/PDF/音频不再只能进文件名）',
      decl ? `声明类型 = ${typeTxt}` : '未定位到');
    // ③ **接线**在场：光把类型放宽不算数——须真有**非文本 part** 装配进用户消息，且落库**仍只落文本**。
    //    只钉类型会放过"放宽了类型却没人写数组"这一半（正是本轮病根的形状：形改了、义没到）。
    const buildsArray = /userContent\s*=\s*\[\s*\{\s*type:\s*'text'/.test(exeSrc);
    const usesArray = /messages\.push\(\{\s*role:\s*'user',\s*content:\s*userContent\s*\}\)/.test(exeSrc);
    // 落库那行**不得**收到 `userContent`（= 数组/图片 part）——DB 里不存 base64（否则每轮 resume 重放把库撑爆）。
    const persistSites = exeSrc.match(/persistTurnMessage\([^;]*\);/g) || [];
    const persistArrayLeak = persistSites.some((s) => /\buserContent\b/.test(s));
    crit('M2', buildsArray && usesArray && persistSites.length > 0 && !persistArrayLeak,
      'P-3 接线**两半都在**：`buildAttachmentParts(` 的结果并进用户消息，而 `persistTurnMessage` **只收文本**（DB 不存 base64）',
      `组装数组=${buildsArray} / 用户消息用数组=${usesArray} / 落库点=${persistSites.length} 处 / 落库掺入数组=${persistArrayLeak}`);
  }

  // ── P-4（M3）`document` 族真的接到 `extractPdfText` 上（**引的是它**，不是另写一个）─────
  {
    const inlSrc = strip(`${MAIN}/core/attachment-inline.ts`);
    const pdfSrc = strip(`${MAIN}/core/pdf-text.ts`);
    // ① 扫描面自证：抽取器的**定义**确在 `pdf-text.ts` 里（否则下面"引了它"就没有对象）。
    ok(/export\s+function\s+extractPdfText\s*\(/.test(pdfSrc),
      'M0-1 扫描面自证：`extractPdfText` 确由 `pdf-text.ts` 导出（P-4 不是"扫了个空"）');
    // ② 判据跑的是**生产那份实现**：装配层 import 它（若它自己再写一份抽取逻辑，C12–C14 证的就是夹具与它自己一致）。
    crit('M3', /import\s*\{[^}]*\bextractPdfText\b[^}]*\}\s*from\s*'\.\/pdf-text\.js'/.test(inlSrc),
      'P-4 `attachment-inline.ts` **引的是** `pdf-text.extractPdfText`（不是自己再写一份抽取）',
      '');
    // ③ **接线在场**：`document` + `.pdf` 那一支里既要有 `extractPdf`（真去抽），也要有 `failed` 出口（抽不出时如实记）。
    //    只钉 import 会放过"引了却没人调"这一半——正是本轮病根的形状（引了 ≠ 接上了）。
    const at = inlSrc.indexOf("family === 'document'");
    const blk = at >= 0 ? braceBlock(inlSrc, at) : '';
    const calls = /\beff\.extractPdf\s*\(\s*buf\s*\)/.test(blk);
    const passes = /type:\s*'text'/.test(blk);
    const fails = /status:\s*'failed'/.test(blk);
    crit('M3', blk.length > 0 && calls && passes && fails,
      'P-4 接线**三个出口都在**：`.pdf` 族 ⇒ 调 `extractPdf`；抽到 ⇒ 产 `text` part；抽不到 ⇒ 记 `failed`（掏得出、接得上、说得出）',
      `定位到 document 分支=${blk.length > 0} / 调 extractPdf=${calls} / 产 text part=${passes} / 记 failed=${fails}`);
  }

  // ── P-5（M4）音频族真的接到 `makeAudioTranscriber` 上，且该组合**住在可测模块里** ──────
  {
    const inlSrc = strip(`${MAIN}/core/attachment-inline.ts`);
    const atSrc = strip(`${MAIN}/core/audio-transcribe.ts`);
    const exeSrc = strip(`${MAIN}/core/agent-executor.ts`);
    // ① 扫描面自证：组合函数与生产 io 的**定义**确在 `audio-transcribe.ts`（否则下面"引了它"就没有对象）。
    ok(/export\s+function\s+makeAudioTranscriber\s*\(/.test(atSrc) && /export\s+const\s+AUDIO_IO\s*:/.test(atSrc),
      'M4-1 扫描面自证：`makeAudioTranscriber` 与 `AUDIO_IO` 确由 `audio-transcribe.ts` 导出（P-5 不是"扫了个空"）');
    // ② 判据跑的是**生产那份实现**：`agent-executor.ts` import 它，而不是自己再写一份归一+转写的组合。
    //    （本轮就地订正前它就长在执行器里 ⇒ 受控回归只能照抄等价物 ⇒ 自我印证。）
    crit('M4', /import\s*\{[^}]*\bmakeAudioTranscriber\b[^}]*\}\s*from\s*'\.\/audio-transcribe\.js'/.test(exeSrc),
      'P-5 `agent-executor.ts` **引的是** `audio-transcribe.makeAudioTranscriber`（不是自己再写一份组合）',
      '');
    // ③ **接线在场**：`transcribeAudio:` 这个注入键真的被传进 `buildAttachmentParts` 的 io 实参——
    //    只钉 import 会放过"引了却没人调"这一半（引了 ≠ 接上了）。
    const callSite = /transcribeAudio\s*:\s*makeAudioTranscriber\s*\(/.test(exeSrc);
    // ④ 未接线时**如实降级**的那一半仍在装配层：`transcriber_unavailable` ⇒ `omitted`（不是 failed、不假装能转）。
    const omits = /'transcriber_unavailable'/.test(inlSrc) && /status:\s*'omitted',\s*reason:\s*'transcriber_unavailable'/.test(inlSrc);
    crit('M4', callSite && omits,
      'P-5 接线**两半都在**：生产把 `makeAudioTranscriber(ansClient)` 传进 `buildAttachmentParts`；而没接线时装配层如实记 `omitted(transcriber_unavailable)`（接上 ≠ 假装一定能转）',
      `调用点=${callSite} / 缺失时如实降级=${omits}`);
  }

  // ── P-6（M5）`view_image` / `read_document` 真的挂上去了，且**进了档** ────────
  {
    const exeSrc = strip(`${MAIN}/core/agent-executor.ts`);
    const mediaSrc = strip(`${MAIN}/core/tools/media.ts`);
    // ① 扫描面自证：工具体的**定义**确在 `core/tools/media.ts`，且两条 meta 真的在 `TOOL_METAS` 里
    //    （否则下面的"引了它/在档"就没有对象，成了扫了个空）。
    ok(/export\s+function\s+mediaTools\s*\(/.test(mediaSrc)
      && TOOL_METAS.filter((m) => m.name === 'view_image' || m.name === 'read_document').length === 2,
      'M5-1 扫描面自证：`mediaTools` 由 `core/tools/media.ts` 导出，`view_image`/`read_document` 两条都在 `TOOL_METAS` 里',
      `表长 ${TOOL_METAS.length} 条`);
    // ② 判据跑的是**生产那份实现**：执行器 import 它并展开进工具表，而不是自己再写两个体。
    crit('M5', /import\s*\{[^}]*\bmediaTools\b[^}]*\}\s*from\s*'\.\/tools\/media\.js'/.test(exeSrc)
      && /\.\.\.mediaTools\(deps\)/.test(exeSrc),
      'P-6 `agent-executor.ts` **引的是** `tools/media.mediaTools(deps)`，且**展开进了工具表**（引了 ≠ 接上了）',
      '');
    // ③ **入档**在场：类目表里 `media` 至少进了一档 —— 上轮 M2 的收窄会让**档外**工具在档内**调不到**。
    //    但也**不许六档全含**：全含等于没收窄（那正是本轮 §M5 要挡的"到处都在"）。
    const withMedia = (Object.keys(ARCHETYPE_TOOL_CATEGORIES) as TaskArchetype[])
      .filter((a) => ARCHETYPE_TOOL_CATEGORIES[a].includes('media'));
    crit('M5', withMedia.length > 0 && withMedia.length < 6,
      'P-6 接线**两半都在**：新工具既在工具表里（调得到），又只分派进**该给的档**（不是六档全含 = 等于没收窄）',
      `含 media 的档 ${withMedia.length}/6：${withMedia.join(', ')}`);
  }

  // ── P-7（M6）拆解器**搬出可注入件**、**接进引擎 planning 出口**、且**有闸有开关** ──────
  {
    const decSrc = strip(`${MAIN}/core/task-decompose.ts`);
    const ctrlSrc = strip(`${MAIN}/core/tools/control.ts`);
    const archSrc = strip(`${MAIN}/core/task-archetype.ts`);
    const imSrc = strip(`${MAIN}/services/im-router.ts`);
    // ① 扫描面自证：三件（拆解 / 解析 / 落库）确由 `task-decompose.ts` 导出——否则下面"引了它"没有对象。
    ok(typeof decomposeTask === 'function' && typeof parseDecomposition === 'function'
      && typeof planSubtasksFromTemplate === 'function' && decSrc.length > 0,
      'M6-1 扫描面自证：`decomposeTask` / `parseDecomposition` / `planSubtasksFromTemplate` 三件确由 `core/task-decompose.ts` 导出',
      `${decSrc.split('\n').length} 行`);
    // ② 判据跑的是**生产那份实现**：planning 出口 import 它，而不是自己再写一份拆解。
    // zx_20261002 M5/M6（「意义即用法」/「同一件事才叫重复」）：**门 + 拆 + 落行 + 留痕**由
    //   `control.ts` 内联收成 `task-decompose.ts` 的 `autoDecomposeForTask` **一处实现**，
    //   启动路（`ai-task` 到点即拆）与本路共用同一份。本条**主张不变**（planning 出口真接线、不自己
    //   再写一份拆解），**承重载体**由"内联那三件"改为"唯一实现 `autoDecomposeForTask`"——
    //   故按新形状重钉；反证裸写法（若本路又内联一份，下面的 `autoDecomposeForTask(` 调用就不在了）。
    crit('M6', /import\s*\{[^}]*\bautoDecomposeForTask\b[^}]*\}\s*from\s*'\.\.\/task-decompose\.js'/.test(ctrlSrc),
      'P-7 `tools/control.ts` **引的是** `task-decompose` 的唯一实现 `autoDecomposeForTask`（不是自己再写一份拆解）', '');
    // ③ **接线在场**（引了 ≠ 接上了）：`enter_plan_mode` 的**配对花括号块**里真调它；
    //    而"四件齐备"落在**被委托的那份实现体内**——真调 `decomposeTask`、真调 `planSubtasksFromTemplate`、
    //    真读开关、真查在途子（不覆盖已有规划）。这与 b3 C-1a2「防重判据在被委托的那份实现体内」同一纪律。
    const epAt = ctrlSrc.indexOf('enter_plan_mode:');
    const epBlk = epAt >= 0 ? braceBlock(ctrlSrc, epAt) : '';
    const sharedAt = decSrc.indexOf('export async function autoDecomposeForTask(');
    const sharedBlk = sharedAt >= 0 ? braceBlock(decSrc, sharedAt) : '';
    const wiredInEp = /\bautoDecomposeForTask\s*\(/.test(epBlk);
    const callsDec = /\bdecomposeTask\s*\(/.test(sharedBlk);
    const callsPlan = /\bplanSubtasksFromTemplate\s*\(/.test(sharedBlk);
    const readsFlag = /readBoolSetting\s*\(\s*opts\.db\s*,\s*'engine\.plan_auto_decompose'\s*\)/.test(sharedBlk);
    // zx_20260924_1 M3-b（J-7）：在途守卫**换真源**——原写裸 `countActiveChildren(db, taskId) > 0`，
    //   现问 `alreadyDecomposed(db, taskId)`（`task-accounting.ts` 里"防重复拆解"的**唯一实现**，
    //   口径仍是"在途子数 > 0"）。本条**主张不变**（planning 出口"已有在途子任务就不拆"这一件**真做**），
    //   故按新真源重钉，**不删**这半句；并顺带反证裸写法不再回潮（否则同一判断又分家两份）。
    const guardsBusy = /\balreadyDecomposed\s*\(\s*opts\.db\s*,\s*opts\.taskId\s*\)/.test(sharedBlk)
      && !/countActiveChildren\s*\(\s*opts\.db\s*,\s*opts\.taskId\s*\)\s*>\s*0/.test(sharedBlk);
    crit('M6', epBlk.length > 0 && wiredInEp && sharedBlk.length > 0 && callsDec && callsPlan && readsFlag && guardsBusy,
      'P-7 接线**四件齐备**：planning 出口真调唯一实现，该实现内真调拆解器、真调落库器、真读开关、且**已有在途子任务就不拆**（不覆盖模型已开始的规划）',
      `出口接线=${wiredInEp} / 拆解=${callsDec} / 落库=${callsPlan} / 读开关=${readsFlag} / 在途守卫=${guardsBusy}`);
    // ④ 开关在册：`engine.plan_auto_decompose` 确在**唯一那份**布尔白名单里（判据一份、名单另一份 = 又会分家）。
    crit('M6', BOOL_SETTING_KEYS.includes('engine.plan_auto_decompose'),
      'P-7 开关**在册**：`engine.plan_auto_decompose` 在 `BOOL_SETTING_KEYS` 白名单里（判据与名单同源同文件）',
      `白名单 ${BOOL_SETTING_KEYS.length} 键`);
    // ⑤ **搬迁纪律**（不是复制）：全仓**只有一处** `decomposeTask` 定义；旧名 `decomposeTaskWithLLM` **零处**残留。
    const allMain = walkTs(MAIN);
    const defSites = allMain.filter((p) => /export\s+async\s+function\s+decomposeTask\s*\(/.test(strip(p))).map(rel);
    const oldName = allMain.filter((p) => /decomposeTaskWithLLM/.test(strip(p))).map(rel);
    crit('M6', defSites.length === 1 && oldName.length === 0 && archSrc.length > 0,
      'P-7 拆解器是**搬**过去的不是抄的：全仓 `decomposeTask` 定义**恰一处**；旧名 `decomposeTaskWithLLM` **零处**（去注释后）',
      `定义于 ${defSites.join(', ') || '（无）'} / 旧名残留 ${oldName.length} 处 · 扫描面 ${allMain.length} 文件`);
    // ⑥ 既有两处调用点**只换调用形状**：IM 路改引新件（语义不动）。
    crit('M6', /import\s*\{[^}]*\bdecomposeTask\b[^}]*\}\s*from\s*'\.\.\/core\/task-decompose\.js'/.test(imSrc)
      && /\bdecomposeTask\s*\(/.test(imSrc),
      'P-7 IM 路**改引同一份拆解器**（IM 拆解的语义一字未改，换的只是"它住在哪个文件"）', '');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C】M1 —— 落盘 → `context_json.attachments`（真跑 `routeImMessage`，内存库、无网络）');
  {
    // 「这条路径真的会碰的表」——**照抄 `database.ts` 的 DDL**（列不齐会在这里抛，
    //   而在这里抛意味着"本该证的事没证到"）。列出对应的生产动作：
    //   `wa_im_conversations` ← 入站落库；`wa_im_channels` ← channel_id 外键；
    //   `wa_settings` ← `refreshImUnread`；`wa_projects` ← `handleCreateTask` 建「IM对话项目」；
    //   `wa_tasks` ← 建任务 + 读回 `context_json`。
    const SCHEMA = `
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, name TEXT DEFAULT '', config TEXT NOT NULL DEFAULT '{}', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_conversations (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT,
  message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound',
  created_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'sent', last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT '');
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
  avatar_url TEXT, role TEXT DEFAULT 'viewer', auth_provider TEXT DEFAULT 'authjs',
  created_at TEXT DEFAULT (datetime('now'))
);
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
    const withTx = (d: DatabaseSync) => { (d as unknown as { transaction: (fn: () => void) => () => void }).transaction = (fn) => () => fn(); return d; };
    const anyDb = (d: DatabaseSync) => d as unknown as AnyDb;
    const CHANNEL = 'ch-m1';
    const newDb = (): AnyDb => {
      const d = withTx(new DatabaseSync(':memory:'));
      d.exec(SCHEMA);
      d.prepare('INSERT INTO wa_im_channels (id, channel_type, name) VALUES (?, ?, ?)').run(CHANNEL, 'wechat', 'M1 标本渠道');
      return anyDb(d);
    };
    /** 假 `ImContext`：`sendReply` 只**收下**回话，不发网络（契约要求"永不 reject"）。 */
    const mkCtx = (db: AnyDb, replies: string[]) => ({
      db: db as never, channelId: CHANNEL, channelType: 'wechat',
      sendReply: async (_to: string, text: string) => { replies.push(text); },
    });
    /** 真落盘一件（走生产 `saveInboundMedia`），返回其**真路径**——期望值不许手写。 */
    const putMedia = (fileName: string, body: string) => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-m1-'));
      const r = saveInboundMedia(dataDir, { kind: '2', fileName, mediaUrl: `https://x.invalid/${fileName}`, sizeBytes: Buffer.byteLength(body) }, Buffer.from(body));
      return { dataDir, r };
    };
    const lastInbound = (db: AnyDb) => db.prepare(
      "SELECT id, message_json FROM wa_im_conversations WHERE direction = 'inbound' ORDER BY rowid DESC LIMIT 1"
    ).get() as { id: string; message_json: string } | undefined;
    const taskCtxOf = (db: AnyDb) => {
      const t = db.prepare('SELECT context_json FROM wa_tasks ORDER BY rowid DESC LIMIT 1').get() as { context_json: string } | undefined;
      return t ? JSON.parse(t.context_json) as Record<string, unknown> : undefined;
    };

    // ── C1：落盘 → 入站行 `message_json.saved_path` ────────────────────────────
    //   "件在盘上，路没修"里的**第一段路**：这件事此前**只活在 `sendReply` 的文案里**，库里没有。
    const db1 = newDb();
    const replies1: string[] = [];
    const { r: saved1 } = putMedia('photo.jpg', 'hello worker-ant');
    const realPath = saved1.ok ? saved1.path : '';
    await routeImMessage(mkCtx(db1, replies1) as never, 'u-m1-c1', '[图片 photo.jpg]', 'direct', '', { kind: '2', fileName: 'photo.jpg', savedPath: realPath || undefined, sizeBytes: 17 });
    const row1 = lastInbound(db1);
    const mj1 = row1 ? JSON.parse(row1.message_json) as Record<string, unknown> : {};
    crit('M1', saved1.ok === true && mj1.saved_path === realPath && realPath !== '',
      'C1 落盘成功后入站行 `message_json.saved_path` = **真落盘路径**（库里终于有了"盘上哪一份"这句话）',
      saved1.ok ? `saved_path=${String(mj1.saved_path)}（与 saveInboundMedia 返回值逐字相等）` : '落盘本身就失败了');

    // ── C2：建任务时挂载 → `context_json.attachments` 且 `taskHasMedia` **为真** ──
    //   承两条既有纪律：① **正面**断言（"值从 false 变 true"，不是"不抛"）；
    //   ② 判"挂上了没有"用**生产那份** `taskHasMedia`（`core/model-request.ts`），**不自抄一份谓词**（C6）。
    const replies2: string[] = [];
    await routeImMessage(mkCtx(db1, replies2) as never, 'u-m1-c1', '分析这张图', 'direct', '', undefined);
    const ctx2 = taskCtxOf(db1);
    const atts2 = Array.isArray(ctx2?.attachments) ? ctx2!.attachments as Array<{ path?: string }> : [];
    crit('M1', atts2.length === 1 && atts2[0]!.path === realPath && taskHasMedia(ctx2) === true,
      'C2 建任务后 `context_json.attachments` 含那一件，且**生产那份** `taskHasMedia` 由 **false 变 true**',
      ctx2 === undefined ? '没建出任务' : `attachments=${atts2.length} 件 · taskHasMedia=${taskHasMedia(ctx2)}`);
    // ⚠ 「**该不命中**」的那只标本（只用"该命中"的样本试，任何过宽谓词都全票通过）：
    ok(taskHasMedia({}) === false && taskHasMedia({ attachments: [] }) === false && taskHasMedia(undefined) === false,
      'C2 反证标本：`taskHasMedia` 对**无键 / 空数组 / undefined** 三种"没有"一律判假（谓词真的在分辨，非恒真）');
    // 与 P-1/P-2 的**同源**自证：源码里那个词真在场（此处是行为，那两条是形状——两者都要有）。
    const mj1HasSavedPath = /\bsaved_path\b/.test(strip(`${MAIN}/services/im-router.ts`));
    ok(mj1HasSavedPath, 'C1/C2 源码级同源自证：`im-router.ts`（去注释后）确有 `saved_path` 这个键名');
    // 形状契约（M2/M3/M4 三批都要按它分派）——用**生产函数**产出，不手写一份"我以为的形状"。
    const shape = attachmentEntry({ kind: '2', path: realPath, fileName: 'photo.jpg', sizeBytes: 17 }, 'wechat', new Date(0));
    const shapeKeys = Object.keys(shape).sort().join(',');
    ok(shape.path === realPath && shape.channel === 'wechat' && shape.kind === '2' && typeof shape.at === 'string' && shape.sizeBytes === 17,
      'C2 `context_json.attachments[i]` 的形状由**生产函数** `attachmentEntry` 产出（M2/M3/M4 按它分派）',
      `键集=[${shapeKeys}]`);

    // ── C5：没有件的那条文字 ⇒ **不写** `attachments` 键 ───────────────────────
    //   "没有"与"空数组"在 `taskHasMedia` 眼里同义，但**排查时不同义**——故钉的是"键不在场"。
    const db5 = newDb();
    const replies5: string[] = [];
    await routeImMessage(mkCtx(db5, replies5) as never, 'u-m1-c5', '分析这段文字', 'direct', '', undefined);
    const ctx5 = taskCtxOf(db5);
    crit('M1', ctx5 !== undefined && !('attachments' in ctx5) && taskHasMedia(ctx5) === false,
      'C5 无件的普通文字 ⇒ 建出的任务 `context_json` **不含 `attachments` 键**（不是空数组）',
      ctx5 === undefined ? '没建出任务' : `键集=[${Object.keys(ctx5).join(',')}]`);

    // ── C3/C4：窗口与**一次性消费**（真 `takePendingMedia`，`now` 注入）──────────
    {
      const db34 = newDb();
      const { r: saved34 } = putMedia('once.png', 'once');
      const p = saved34.ok ? saved34.path : '';
      const ins = (id: string, json: Record<string, unknown>) =>
        db34.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at) VALUES (?, ?, ?, ?, 'inbound', datetime('now'))")
          .run(id, CHANNEL, 'u-m1-c34', JSON.stringify(json));
      ins('row-fresh', { kind: '2', saved_path: p, file_name: 'once.png' });

      // 先试**窗口外**（+11 分钟）——**必须取不到**；且这一步**不消费**，故下一支行得通。
      const out = takePendingMedia(db34 as never, { channelId: CHANNEL, externalUser: 'u-m1-c34', now: new Date(Date.now() + PENDING_MEDIA_WINDOW_MS + 60_000) });
      crit('M1', out === undefined,
        `C3 窗口外（now 注入 +${(PENDING_MEDIA_WINDOW_MS + 60_000) / 60_000} 分钟）⇒ 取不到（窗口真在筛）`,
        out ? `竟然取到了 ${out.path}` : 'undefined');

      // 窗口内 ⇒ 取到（**正面**控制组：证明上面那条的 `undefined` 不是"谓词恒假"）
      const hit = takePendingMedia(db34 as never, { channelId: CHANNEL, externalUser: 'u-m1-c34' });
      crit('M1', hit !== undefined && hit.path === p,
        'C3 正面标本：窗口内同一条 ⇒ 取到，且 `path` = 真落盘路径（上一条的 undefined 非恒假）',
        hit ? `取到 ${path.basename(hit.path)}` : 'undefined');
      // 库内真的留下了消费标记（**不是**只靠内存状态）
      const consumed = db34.prepare("SELECT message_json FROM wa_im_conversations WHERE id = 'row-fresh'").get() as { message_json: string };
      crit('M1', typeof (JSON.parse(consumed.message_json) as Record<string, unknown>).media_consumed_at === 'string',
        'C3 消费标记**落库**（`media_consumed_at` 键在场）——重启后仍不会重复取件', 'json 键在场');

      const again = takePendingMedia(db34 as never, { channelId: CHANNEL, externalUser: 'u-m1-c34' });
      crit('M1', again === undefined,
        'C4 取过一次后再取**取不到**（一次性消费——防同一张图挂到多个任务）',
        again ? `竟然又取到 ${again.path}` : 'undefined');

      // ── 路径守卫（"该不命中"标本）：`saved_path` 不在 `attachments/` 之下 ⇒ 拒绝 ──
      ins('row-evil', { kind: '2', saved_path: '/etc/passwd', file_name: 'passwd' });
      const evil = takePendingMedia(db34 as never, { channelId: CHANNEL, externalUser: 'u-m1-c34' });
      ok((evil === undefined || !evil.path.includes('passwd')) === true,
        'C1 路径守卫标本：`saved_path` 不在 `attachments/` 之下（`/etc/passwd`）⇒ 拒绝取件',
        evil ? `竟然取到 ${evil.path}` : 'undefined');

      // ── `beforeId` 标本：**后到的**件不得挂到**先建的**任务上 ────────────────
      const dbB = newDb();
      const insB = (id: string, json: Record<string, unknown>) =>
        dbB.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at) VALUES (?, ?, ?, ?, 'inbound', datetime('now'))")
          .run(id, CHANNEL, 'u-m1-b', JSON.stringify(json));
      insB('text-row', { text: '分析这张图' });                     // 先到的是**文字**
      insB('img-row', { kind: '2', saved_path: p, file_name: 'once.png' }); // 后到的是**图**
      const bOut = takePendingMedia(dbB as never, { channelId: CHANNEL, externalUser: 'u-m1-b', beforeId: 'text-row' });
      ok(bOut === undefined,
        'C1 `beforeId` 标本：**后到的**图不会被挂到**先建的**任务上（否则顺序颠倒也照挂——可见的错挂）',
        bOut ? `竟然取到 ${bOut.path}` : 'undefined');
    }

    // ── C6：断言用的是**生产那份** `taskHasMedia`，不是夹具自抄的谓词 ───────────
    //   "自我印证"（同 `zx_20260920_1` M9-fix F1/F3）：写判据的那支笔和写实现的那支笔若是同一支，
    //   判据**永远不会自己喊**。此处的机检分两半：① 生产模块**真的导出**它（直 import 判型）；
    //   ② 消费侧**没有**另抄一份形状相同的谓词（那才是"两份实现"的温床）。
    {
      const mrSrc = strip(`${MAIN}/core/model-request.ts`);
      const defsInConsumer = (strip(`${MAIN}/services/im-router.ts`).match(/attachments\s*(?:as\s+unknown\[\])?\s*\.length\s*>\s*0/g) || []).length;
      ok(typeof taskHasMedia === 'function' && /export\s+function\s+taskHasMedia/.test(mrSrc) && defsInConsumer === 0,
        'C6 `taskHasMedia` 是**生产那份**（`core/model-request.ts` 导出），消费侧**零处**自抄同形谓词',
        `消费侧自抄 ${defsInConsumer} 处`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C】M2 —— 附件分派表 + 图片进上下文（真跑 `buildAttachmentParts`；io 全桩 ⇒ **零 electron**）');
  {
    // ⚠ 判据不许依赖"本机恰好有 electron / 一张真图"：`InlineIo` 四个口**全部注入桩**，
    //   于是这几条跑的是 `attachment-inline.ts` 的**真实现**，而 `import('electron')` 那支**永不执行**。
    //   （这正是该模块"静态零 electron 依赖"的设计目的——判据跑生产那条路，不是它的复刻。）
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr21-m2-'));
    /** 1×1 PNG 真字节；判据只拿它当"一件图片族的原件"用，不做像素级断言。 */
    const PNG_1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const pPng = path.join(tmp, 'small.png');
    fs.writeFileSync(pPng, PNG_1x1);
    const pdfStub = (): { ok: false; reason: 'parse_error' } => ({ ok: false, reason: 'parse_error' });
    /** 只在图片支会被用到的桩：`null` 等价于"降不了质"（生产侧即 `nativeImage` 不可用/降不到位）。 */
    const noDownscale = async (): Promise<null> => null;

    // ── C7：小图 ⇒ 真 `image` part，MIME 取自**真源表** ──────────────────────
    const res7 = await buildAttachmentParts(
      [{ path: pPng, fileName: 'small.png', kind: '2' }],
      { readFile: () => PNG_1x1, downscaleImage: noDownscale, extractPdf: pdfStub },
    );
    const imgPart = res7.parts.find((p) => p.type === 'image');
    crit('M2', !!imgPart && imgPart.mimeType === 'image/png' && res7.outcomes[0]!.status === 'inlined',
      'C7 小图 ⇒ parts 里出现 `{type:"image"}`，`mimeType` = 真 MIME（`.png` ⇒ `image/png`）',
      imgPart && imgPart.type === 'image'
        ? `mimeType=${imgPart.mimeType} / status=${res7.outcomes[0]!.status} / bytes=${res7.outcomes[0]!.bytes}`
        : '未产出 image part');

    //   「该不命中」标本：**只有入站 `kind`（数字）、文件名无扩展名** ⇒ 不得当作图片。
    //   入站 `kind` 是**数字**（`zx_20260914` M1-2 的刻意裁定，2026-09-21 复核维持）⇒ `familyOf('2')`
    //   只能是 `binary`；判族必须读**落盘文件名带的扩展名**。这条同时钉死了"别再走回读 `kind` 的老路"。
    const res7b = await buildAttachmentParts(
      [{ path: path.join(tmp, 'noext'), kind: '2' }],
      { readFile: () => PNG_1x1, downscaleImage: noDownscale, extractPdf: pdfStub },
    );
    crit('M2', res7b.parts.every((p) => p.type !== 'image') && res7b.outcomes[0]!.status === 'omitted',
      'C7 「该不命中」标本：只有 `kind:"2"`、文件名无扩展名 ⇒ **不**当图片内联（判族读扩展名，不读入站 `kind`）',
      `family=${res7b.outcomes[0]!.family} / reason=${res7b.outcomes[0]!.reason ?? '(无)'}`);

    // ── C8：超上限的图 ⇒ **真走了降质**，且拿到的是**生产那个上限值** ──────────
    const bigBuf = Buffer.alloc(IMAGE_MAX_BYTES + 1);
    let dlCalls = 0; let dlMax = -1;
    const res8 = await buildAttachmentParts(
      [{ path: pPng, fileName: 'big.png' }],
      {
        readFile: () => bigBuf,
        downscaleImage: async (_p, max) => { dlCalls++; dlMax = max; return { data: PNG_1x1, mimeType: 'image/jpeg' }; },
        extractPdf: pdfStub,
      },
    );
    crit('M2', dlCalls === 1 && dlMax === IMAGE_MAX_BYTES && res8.outcomes[0]!.status === 'inlined' && res8.outcomes[0]!.bytes === PNG_1x1.length,
      'C8 超上限的图 ⇒ 走**降质**（降质口收到的 `maxBytes` 是**真源上限**，不是夹具自抄的数）；降下来 ⇒ `inlined`',
      `downscaleImage 调用 ${dlCalls} 次 / maxBytes=${dlMax}（真源 ${IMAGE_MAX_BYTES}）/ status=${res8.outcomes[0]!.status}`);

    // ── C9：降不动 ⇒ `omitted` **且如实说明在场**（降级路径的**正面**断言）──────
    //   这条是"反"（不许抛、不许静默）与"正"（必须产出一条带**盘上原件路径**的说明）合体。
    //   只断言"不抛"是不够的：被 `try/catch` 吞掉的路径同样不抛，故必须正面断言说明文本在场。
    let threw9 = false;
    let res9: Awaited<ReturnType<typeof buildAttachmentParts>> | null = null;
    try {
      res9 = await buildAttachmentParts(
        [{ path: pPng, fileName: 'unscalable.png' }],
        { readFile: () => bigBuf, downscaleImage: noDownscale, extractPdf: pdfStub },
      );
    } catch { threw9 = true; }
    const o9 = res9?.outcomes[0];
    const marker9 = res9?.parts.find((p) => p.type === 'text' && /未内联图片/.test(p.text));
    crit('M2', !threw9 && o9?.status === 'omitted' && o9?.reason === 'over_limit_no_downscale'
      && !!marker9 && marker9.type === 'text' && marker9.text.includes(pPng),
      'C9 `nativeImage` 不可用（io 桩返 `null`）⇒ `omitted`、**不抛**；marker 文本在场**并给出盘上原件路径**（不许静默）',
      threw9 ? '**抛了**' : `status=${o9?.status} / reason=${o9?.reason} / marker=${marker9 ? '在场' : '缺席'}`);

    // ── C10：token 估算对**数组 content** 不抛且给数值（且与裸串同尺）──────────
    const CONTENT_MIX = [{ type: 'text', text: 'x'.repeat(40) }, { type: 'image', image: PNG_1x1, mimeType: 'image/png' }];
    let t10 = -1; let threw10 = false;
    try { t10 = estimateContentTokens(CONTENT_MIX); } catch { threw10 = true; }
    const t10str = estimateContentTokens('x'.repeat(40));
    /** **旧算法**（`String(content).length / 4`）在这条数组上会给出什么——用来钉"塌了"。 */
    const legacy10 = Math.ceil(String(CONTENT_MIX).length / 4);
    crit('M2', !threw10 && Number.isFinite(t10) && t10 > t10str && t10str === 10 && legacy10 < t10,
      'C10 数组 content 的 token 估算**不抛**且给出数值；文本部分与裸串**同尺**，图片另计经验值',
      threw10 ? '**抛了**' : `数组=${t10} / 裸串=${t10str} / 「旧算法」=${legacy10}（旧算法把整条数组塌成一个常数）`);

    // ── C11：家族分派读的是 `attachment-kinds.ts`（**防自我印证**）─────────────
    //   若夹具自己抄一份扩展名→族的表，上面 C7 证的就只是"夹具与它自己一致"。
    const inlineSrc = strip(`${MAIN}/core/attachment-inline.ts`);
    const kindsSrc = strip(`${MAIN}/core/attachment-kinds.ts`);
    ok(/export\s+function\s+familyOf/.test(kindsSrc),
      'C11 扫描面自证：`familyOf` 确由 `attachment-kinds.ts` 导出（下一条 import 判据不是"扫了个空"）');
    crit('M2', /import\s*\{[^}]*\bfamilyOf\b[^}]*\}\s*from\s*'\.\/attachment-kinds\.js'/.test(inlineSrc),
      'C11 判族**引的是** `attachment-kinds.familyOf`（不是自己再写一张扩展名表）——判据跑的是生产那份实现');
    const dupLit = (kindsSrc.match(/\b10\s*\*\s*1024\s*\*\s*1024\b/g) || []).length;
    ok(dupLit === 1 && IMAGE_PREVIEW_MAX_BYTES === IMAGE_MAX_BYTES,
      'C11 单点真源：图片字节上限在 `attachment-kinds.ts` 只写一次，且 `deliverable-types.IMAGE_PREVIEW_MAX_BYTES` **就是**它',
      `字面量 ${dupLit} 处（须 =1）／对外值 ${IMAGE_PREVIEW_MAX_BYTES} === ${IMAGE_MAX_BYTES}`);

    // ── C11b（实施期就地补）：族词表的**第二个消费者**——`vision` 只由图片族触发 ──
    //   病根：`deriveModelCapabilities` 的 `hasMedia` 原本由 `taskHasMedia` 直接喂。M1 起附件
    //   可以是**任何族**——一件 MP3 会让选型凭空要求 `vision`（把不入围的好模型筛掉），
    //   却对"能不能听这段音频"毫无帮助。这是**参数对不上**，非功能缺失，故就地补并立判据。
    //   （编号取 C11b 而非 C12：C12 已由方案 §M3 的 PDF 判据占用，不占它的号。）
    crit('M2',
      attachmentsNeedVision([{ fileName: 'a.mp3' }]) === false
      && attachmentsNeedVision([{ fileName: 'a.pdf' }]) === false
      && attachmentsNeedVision([{ fileName: 'a.png' }]) === true
      && attachmentsNeedVision([]) === false
      && attachmentsNeedVision(undefined) === false,
      'C11b 附件要求 `vision` **只认图片族**：MP3/PDF 不要（不该让选型凭空要收图能力），PNG 要，空/缺席不要',
      `mp3=${attachmentsNeedVision([{ fileName: 'a.mp3' }])} / pdf=${attachmentsNeedVision([{ fileName: 'a.pdf' }])} / png=${attachmentsNeedVision([{ fileName: 'a.png' }])}`);
    //   扫描面（M8 后）：选型段已搬至 `core/exec-model-select.ts` ⇒ 取执行体 ∪ `core/exec-*.ts`。
    //   本条的**本意是"生产真按 `needsVision` 要能力"**，落点是哪一文件只是落点（M8 纪律 §M8-4）。
    const exeM2 = execSurface();
    crit('M2',
      /deriveModelCapabilities\(\s*archetype\s*,\s*\{\s*hasMedia:\s*needsVision\s*\}\)/.test(exeM2)
      && /buildModelRequest\(\{[\s\S]{0,240}?hasMedia:\s*needsVision/.test(exeM2),
      'C11b 接线：生产把 **`needsVision`**（而非"有件"）喂给能力派生与请求体构造',
      '');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C】M3 —— PDF 正文抽取（**程序化生成夹具**；"抽出来的字"与"写进去的字"对照同一份常量）');
  {
    // ⚠ **夹具纪律**（方案 §M3）：PDF 夹具必须**程序化生成且内容已知**——不许外挂二进制文件，
    //   否则"抽出来的字"无法与"我以为写进去的字"对照。下面 `PDF_L1/PDF_L2` **既是生成入参也是期望值**，
    //   生成代码与断言读的是同两个常量。
    //   另：本轮的 PDF 一律**不带 `/ToUnicode`** ⇒ 走的是"单字节 latin1 直通"那条真路（ASCII 文本）。
    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'rr21-m3-'));
    const PDF_L1 = 'Hello PDF round trip';
    const PDF_L2 = 'line 2: 50 of 50';
    const PDF_EXPECT = `${PDF_L1}\n${PDF_L2}`;

    // ── C12（正）：自造最小 PDF ⇒ 抽出**期望文字**（逐字相等，不是"包含"）─────────
    //   生成器 `makePdf` / `pageStream` 现住在**模块作用域**（M5 的 `read_document` 判据复用同一份）。
    {
      const pdfA = makePdf([pageStream([PDF_L1, PDF_L2])]);
      let r12: ReturnType<typeof extractPdfText> | null = null;
      let threw12 = false;
      try { r12 = extractPdfText(pdfA); } catch { threw12 = true; }
      crit('M3', !threw12 && r12?.ok === true && r12.text === PDF_EXPECT && r12.pages === 1 && r12.truncated === false,
        'C12 自造最小 PDF（`zlib.deflateSync` 出内容流）⇒ 抽出的正文与**写进去的那份常量逐字相等**（`===`，不是 `includes`）',
        threw12 ? '**抛了**' : (r12 && r12.ok
          ? `抽出=${JSON.stringify(r12.text)} / 期望=${JSON.stringify(PDF_EXPECT)} / pages=${r12.pages} / truncated=${r12.truncated}`
          : `ok:false reason=${r12?.reason} detail=${r12?.detail ?? ''}`));
    }

    // ── C13（正）：页数超上限 ⇒ `truncated=true`，**且"只给了前 N 页"这件事要看得见** ──
    {
      const N_PAGES = PDF_MAX_PAGES + 5;
      const pageTag = (i: number): string => `PAGE-${String(i).padStart(2, '0')}`;
      const pdfB = makePdf(Array.from({ length: N_PAGES }, (_, i) => pageStream([pageTag(i + 1)])));
      const r13 = extractPdfText(pdfB);
      const body13 = r13.ok ? r13.text : '';
      // 正面：`pages` 报**总**页数、`truncated` 为真；且正文里**真没有**第 21 页的字（"截断了"不是一句空话）。
      crit('M3', r13.ok === true && r13.pages === N_PAGES && r13.truncated === true
        && body13.includes(pageTag(1)) && body13.includes(pageTag(PDF_MAX_PAGES)) && !body13.includes(pageTag(PDF_MAX_PAGES + 1)),
        `C13 页数超上限（${N_PAGES} > ${PDF_MAX_PAGES}）⇒ \`truncated=true\` 且 \`pages\` 报**总页数**；正文**真只收了前 ${PDF_MAX_PAGES} 页**（第 ${PDF_MAX_PAGES + 1} 页的字确实不在）`,
        r13.ok
          ? `pages=${r13.pages} / truncated=${r13.truncated} / 第${PDF_MAX_PAGES}页在场=${body13.includes(pageTag(PDF_MAX_PAGES))} / 第${PDF_MAX_PAGES + 1}页在场=${body13.includes(pageTag(PDF_MAX_PAGES + 1))}`
          : `ok:false reason=${r13.reason}`);

      // **抬头的来源标注**走**生产装配路径**验（`buildAttachmentParts` 的 `extractPdf` 口**不注入** ⇒ 跑的是
      //   生产缺省那份 `extractPdfText`；注入它反而成了"判据自己喂自己"的自我印证）。
      const pPdfB = path.join(tmp3, 'many.pdf');
      fs.writeFileSync(pPdfB, pdfB);
      const res13 = await buildAttachmentParts([{ path: pPdfB, fileName: 'many.pdf' }], { readFile: () => pdfB });
      const txt13 = res13.parts.find((p) => p.type === 'text' && p.text.includes('[附件 many.pdf 第'));
      const want13 = `[附件 many.pdf 第 1-${PDF_MAX_PAGES} 页（共 ${N_PAGES} 页，已截断）]`;
      crit('M3', res13.outcomes[0]!.status === 'inlined' && !!txt13 && txt13.type === 'text' && txt13.text.startsWith(want13),
        'C13 装配层把截断**如实写在给模型的抬头里**（`第 1-20 页（共 25 页，已截断）`），不是闷声只给 20 页',
        txt13 && txt13.type === 'text' ? `抬头=${JSON.stringify(txt13.text.slice(0, want13.length + 4))}` : `未找到正文 part / status=${res13.outcomes[0]!.status}`);
    }

    // ── C14（反）：CID 字形 + **无 ToUnicode** ⇒ 判失败，且装配层**有一条如实说明**（真因 + 盘上路径）──
    {
      // Identity-H 下的双字节**字形索引**（0x0003 起，子集字体的常见起点）——没有 ToUnicode 就无从映射，
      //   按 latin1 直通读出来是一串 C0 控制字符。这正是"宁可不给，绝不把乱码当正文"要挡的那件事。
      const cidHex = Array.from({ length: 30 }, (_, i) => (i + 3).toString(16).padStart(4, '0')).join(' ');
      const pdfC = makePdf(
        [`BT /F1 12 Tf 72 720 Td <${cidHex}> Tj ET\n`],
        '<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPro-Regular /Encoding /Identity-H /DescendantFonts [] >>',
      );
      const r14 = extractPdfText(pdfC);
      crit('M3', r14.ok === false && r14.reason === 'cid_unsupported',
        'C14 「该不命中」：CID 字形字节 + **无 ToUnicode** ⇒ `ok:false`（宁可不给，绝不把字形索引当正文喂给模型）',
        r14.ok ? `**判成功了**（抽出 ${JSON.stringify(r14.text.slice(0, 40))}）` : `reason=${r14.reason} / detail=${r14.detail ?? ''}`);

      const pPdfC = path.join(tmp3, 'cid.pdf');
      fs.writeFileSync(pPdfC, pdfC);
      const res14 = await buildAttachmentParts([{ path: pPdfC, fileName: 'cid.pdf' }], { readFile: () => pdfC });
      const o14 = res14.outcomes[0]!;
      crit('M3', o14.status === 'failed' && o14.reason!.startsWith('cid_unsupported')
        && o14.marker.includes(pPdfC) && o14.marker.includes('cid_unsupported'),
        'C14 装配层**有一条如实说明在场**：`failed` + 真因 + **盘上原件路径**（用户仍可自行取件；不许静默丢弃）',
        `status=${o14.status} / reason=${o14.reason ?? '(无)'} / marker=${o14.marker}`);
    }

    // ── C15（正）：**不吞异常**——任何内部 `throw` 都须转成 `ok:false`，不许冒到调用方 ─────
    //   为什么这条重要：装配层对 `extractPdf` 是**裸调**（`const r = eff.extractPdf(buf)`），
    //   真的冒出异常会掀翻**整条上下文装配**——"因为一份 PDF 怪，任务连话都不说了"。
    {
      // ① 外层兜底：一个**真 Buffer**（过得了 `Buffer.isBuffer`）但 `toString` 会炸。
      const hostile = Buffer.alloc(64);
      (hostile as unknown as { toString: () => never }).toString = () => { throw new Error('boom-from-toString'); };
      ok(Buffer.isBuffer(hostile),
        'C15 扫描面自证：敌意标本仍是**真 Buffer**（过不了 `Buffer.isBuffer` 就到不了会抛的那一行，本条会变成空转）');
      let threw15 = false; let r15: ReturnType<typeof extractPdfText> | null = null;
      try { r15 = extractPdfText(hostile); } catch { threw15 = true; }
      crit('M3', !threw15 && r15 !== null && r15.ok === false && r15.reason === 'parse_error',
        'C15 内部真抛（`toString` 炸）⇒ 转成 `ok:false`（`parse_error`），**不冒到调用方**',
        threw15 ? '**抛了**' : `reason=${r15 && r15.ok === false ? r15.reason : '(非 ok:false)'}`);

      // ② 坏流降级：`/Filter /FlateDecode` 声明在、字节是噪声 ⇒ 只跳过**这一条流**，整体给一个**说得出理由**的失败。
      const FAIL_REASONS = ['encrypted', 'no_text_layer', 'cid_unsupported', 'parse_error'];
      const broken = Buffer.concat([
        Buffer.from('%PDF-1.4\n', 'latin1'),
        Buffer.from('1 0 obj\n<< /Length 8 /Filter /FlateDecode >>\nstream\n', 'latin1'),
        Buffer.from([0x00, 0xff, 0x12, 0x34, 0xde, 0xad, 0xbe, 0xef]),
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
        Buffer.from('2 0 obj\n<< /Type /Page /Contents 1 0 R >>\nendobj\n', 'latin1'),
        Buffer.from('trailer\n<< /Root 2 0 R >>\n%%EOF\n', 'latin1'),
      ]);
      let threw15b = false; let r15b: ReturnType<typeof extractPdfText> | null = null;
      try { r15b = extractPdfText(broken); } catch { threw15b = true; }
      crit('M3', !threw15b && r15b !== null && r15b.ok === false && FAIL_REASONS.includes(r15b.reason),
        'C15 解不开的 FlateDecode 流 ⇒ 只跳过这一条流，整体 `ok:false` 且原因是**四种已知失败之一**（不抛、不哑）',
        threw15b ? '**抛了**' : `reason=${r15b && r15b.ok === false ? r15b.reason : '(非 ok:false)'}`);

      // ③ 垃圾入参：外部调用方递什么来都不许掀桌。
      const junk: unknown[] = [null, undefined, 42, {}, 'a string', Buffer.alloc(0), Buffer.from('not a pdf at all'),
        Buffer.from(`%PDF-1.4\n${'x'.repeat(40)}`)];
      const junkThrew: string[] = []; const junkOk: string[] = [];
      for (const j of junk) {
        try { const r = extractPdfText(j as Buffer); if (r.ok) junkOk.push(String(j)); }
        catch (e) { junkThrew.push(`${String(j)} → ${e instanceof Error ? e.message : String(e)}`); }
      }
      crit('M3', junkThrew.length === 0 && junkOk.length === 0,
        `C15 垃圾入参 ${junk.length} 种（null/undefined/数字/对象/串/空 Buffer/非 PDF/只有魔数）⇒ **一律 \`ok:false\`、一律不抛**`,
        `抛了 ${junkThrew.length} 种${junkThrew.length ? `：${junkThrew.join(' / ')}` : ''} / 误判成功 ${junkOk.length} 种${junkOk.length ? `：${junkOk.join(' / ')}` : ''}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C】M4 —— 音频归一化与转写（真 shell 桩冒充 ffmpeg；**不依赖"本机恰好装了 ffmpeg"**）');
  {
    // 为什么是**真 shell 桩**而不是"假 `run` 返回固定结构"：本轮 §7 点名的头号风险是**判据自我印证**。
    //   若把 `run` 整个换成假的，被判的就不是生产那份 "spawn + 收 stderr + 超时杀" 的实现，而是夹具自己。
    //   这里只把"ffmpeg 这个可执行"换成确定性的桩，`AUDIO_IO.run` 本体照跑 ⇒ 真实现、假农具。
    const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'rr21-m4-'));
    const srcDir = path.join(tmp4, 'src');
    const dstDir = path.join(tmp4, 'dst');
    fs.mkdirSync(srcDir, { recursive: true });

    const argsFileOk = path.join(tmp4, 'args-ok.txt');
    // ⚠ 脚本里**不许出现 `${...}`**（会撞上 TS 模板字面量的插值）。用 `$@`/裸 `$out` 即安全。
    const stubOk = path.join(tmp4, 'ffmpeg-ok.sh');
    fs.writeFileSync(stubOk, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > "${argsFileOk}"`,
      'out=""',
      'for a in "$@"; do out="$a"; done',
      `printf 'RIFF-stub-wav-bytes\\n' > "$out"`,
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    const stubFail = path.join(tmp4, 'ffmpeg-fail.sh');
    fs.writeFileSync(stubFail, [
      '#!/bin/sh',
      "echo 'STUB-FFMPEG-REFUSED: no such decoder' >&2",
      'exit 1',
      '',
    ].join('\n'), { mode: 0o755 });
    // 扫描面自证：桩**真能被执行**（否则下面那些"桩跑了"就都成了空转，红/绿都无意义）。
    ok(fs.existsSync(stubOk) && (fs.statSync(stubOk).mode & 0o111) !== 0,
      'M4-2 扫描面自证：ffmpeg 桩文件在盘上且**带可执行位**（不是"扫了个空"）');

    let seenBin = '';
    const ioWith = (stub: string) => ({
      ...AUDIO_IO,
      probe: () => true, // 桩冒充的正是"PATH 里有 ffmpeg"这一问
      run: (bin: string, args: string[], timeoutMs: number) => { seenBin = bin; return AUDIO_IO.run(stub, args, timeoutMs); },
    });

    const srcM4a = path.join(srcDir, 'clip.m4a');
    fs.writeFileSync(srcM4a, Buffer.from('not-really-m4a-bytes'));

    // ── C16：降级第一态 `ffmpeg_missing`（本机无农具）⇒ **如实说"没有农具"**，不往下假装 ──
    {
      const tr16a = makeAudioTranscriber(
        { getOptimalModel: async () => ({ url: 'https://example.test', api_key: 'k', model_name: 'm1' }) },
        dstDir,
        { ...AUDIO_IO, probe: () => false },
      );
      const r16a = await tr16a(srcM4a);
      const got16a = r16a.ok === false ? r16a.reason : '(居然成功了)';
      crit('M4', r16a.ok === false && r16a.reason.startsWith('ffmpeg_missing') && r16a.reason.includes('PATH 里找不到'),
        'C16 探针返回 false（本机无 ffmpeg）⇒ `ffmpeg_missing` 且文案**说得清是"找不到可执行"**（不是笼统的失败；`detail` 没被丢）',
        `reason=${got16a}`);
    }

    // ── C16b：组合**真跑完第一段**，在第二段如实说"没有能听音频的模型" ──────────────
    {
      // zx_20260921_1 M2（**改的是本判据的形状假设，不是本轮源码**）：
      //   本夹具原以 `{}` 冒充"ANS 选不出可用端点"。但 ANS 零命中**从不**回 `{}`——
      //   打真 :3001 逐字取回的是 `{error:{code:'NOT_FOUND',message:…}}`（HTTP 200）。
      //   `{}` 是"接口变了/形状不认识"，不是"没有这种模型"；M2 起适配层把这两件事**分开说**，
      //   故旧夹具的假形状会假红。这里换成生产真形状，期望串由该回包自身派生。
      const ansZeroHit = { error: { code: 'NOT_FOUND', message: '没有找到匹配的模型' } };
      const tr16 = makeAudioTranscriber({ getOptimalModel: async () => ansZeroHit }, dstDir, ioWith(stubOk));
      const r16 = await tr16(srcM4a);
      const wavs = fs.existsSync(dstDir) ? fs.readdirSync(dstDir).filter((f) => f.endsWith('.wav')) : [];
      const got16 = r16.ok === false ? r16.reason : '(居然成功了)';
      crit('M4', r16.ok === false && r16.reason.startsWith('transcribe_failed')
        && r16.reason.includes(ansZeroHit.error.message),
        'C16b 归一化真跑完（产物落盘）⇒ 第二段 ANS 选不出可用端点时**如实**落 `transcribe_failed`，不拿原文/随机串充数',
        `reason=${got16} / 归一化产物=${wavs.length} 件`);
      crit('M4', wavs.length === 1,
        'C16b 「第一段真跑完了」的正面对证：`dstDir` 里确有 1 件 `.wav`（否则上面的失败可能是**第一段**就断了）',
        `wav=${wavs.join(',') || '(无)'}`);
    }

    // ── C17：ffmpeg 起得来但退出码非 0 ⇒ 原因里要**带出真 stderr**（如实说"断在哪"） ────
    {
      // zx_20260921_1 M2：同 C16b 的形状订正。本断言只问 ffmpeg 退出码（选型在归一化**之后**，
      //   此处根本走不到），但留一个 `{}` 假形状就是同一颗地雷——换成生产的成功形状。
      const tr17 = makeAudioTranscriber(
        { getOptimalModel: async () => ({ url: 'https://example.test', api_key: 'k', model_name: 'm1' }) },
        dstDir, ioWith(stubFail));
      const r17 = await tr17(srcM4a);
      const got17 = r17.ok === false ? r17.reason : '(居然成功了)';
      crit('M4', r17.ok === false && r17.reason.startsWith('normalize_failed')
        && r17.reason.includes('退出码 1') && r17.reason.includes('STUB-FFMPEG-REFUSED'),
        'C17 桩 ffmpeg 退出码 1 ⇒ `normalize_failed`，且原因**带出进程真 stderr**（`STUB-FFMPEG-REFUSED` 在场 ⇒ 证桩真跑了、`AUDIO_IO.run` 的 stderr 收集没被绕过）',
        `reason=${got17}`);
    }

    // ── C18：喂给 ffmpeg 的参数 + 产物命名契约（幂等 / 防静默覆盖） ────────────────
    {
      const dst1 = await normalizeToWav(srcM4a, dstDir, ioWith(stubOk));
      const argv = fs.existsSync(argsFileOk) ? fs.readFileSync(argsFileOk, 'utf-8').split('\n').filter((l) => l !== '') : [];
      const has = (a: string, b: string) => argv.some((x, i) => x === a && argv[i + 1] === b);
      const named = /^clip\.[0-9a-f]{8}\.wav$/.test(path.basename(dst1.ok ? dst1.path : ''));
      const nonEmpty = dst1.ok && (fs.statSync(dst1.path).size > 0);
      crit('M4', has('-i', srcM4a) && has('-ac', '1') && has('-ar', '16000') && has('-f', 'wav') && argv.includes('-y') && seenBin === FFMPEG_BIN,
        'C18 归一化喂给 ffmpeg 的是约定的那组参数（`-i <源> -ac 1 -ar 16000 -f wav -y <dst>`），可执行取自 `FFMPEG_BIN`（`WA_FFMPEG_BIN` 覆盖得住）',
        `argv=[${argv.join(' ')}] / bin=${seenBin}`);
      crit('M4', dst1.ok === true && named && nonEmpty,
        'C18 成功桩 ⇒ 归一化 `ok:true`，产物名 `<基名>.<源绝对路径摘要 8 位>.wav` 且**非空**（退出码 0 不等于写出了东西 ⇒ 必须回查产物）',
        `ok=${dst1.ok} / dst=${dst1.ok ? dst1.path : '(失败)'} / 名式=${named} / 非空=${nonEmpty}`);

      const dst2 = await normalizeToWav(srcM4a, dstDir, ioWith(stubOk));
      // 同源两件不同扩展名落**同一目录**：若目标名只取基名，后者会把前者**静默覆盖**（两件音频抢一份转写）。
      const srcMp3 = path.join(srcDir, 'clip.mp3');
      fs.writeFileSync(srcMp3, Buffer.from('not-really-mp3-bytes'));
      const dst3 = await normalizeToWav(srcMp3, dstDir, ioWith(stubOk));
      const idem = dst1.ok && dst2.ok && dst1.path === dst2.path;
      const noClobber = dst1.ok && dst3.ok && dst1.path !== dst3.path;
      crit('M4', idem && noClobber && fs.existsSync(dst1.ok ? dst1.path : '') && fs.existsSync(dst3.ok ? dst3.path : ''),
        'C18 目标名由**源绝对路径**派生：同源重跑落同一名（幂等）、`clip.mp3` 与 `clip.m4a` 同目录**各得一份**（不静默覆盖）',
        `幂等=${idem} / 不覆盖=${noClobber}`);
    }

    // ── C19：选型请求带 `audio` 能力（该命中）+ 普通请求不带（该不命中）+ 提交体形状 ─────
    {
      const wavBytes = Buffer.from('RIFF-fake-wav-payload');
      const AUDIO_OPTS = { archetype: 'conversation', strategy: 'cost-optimal' } as const;
      const plain = buildModelRequest({ ...AUDIO_OPTS });
      const audioReq = buildAudioModelRequest();
      const baseCaps = Array.isArray(plain.capabilities) ? (plain.capabilities as string[]) : [];
      const audioCaps = Array.isArray(audioReq.capabilities) ? (audioReq.capabilities as string[]) : [];
      ok(AUDIO_CAPABILITY === 'audio',
        'M4-3 扫描面自证：`AUDIO_CAPABILITY` 字面量就是 `\'audio\'`（ANS 选型的入场券；改了它下面"该命中"就成了自说自话）');
      crit('M4', audioCaps.includes(AUDIO_CAPABILITY) && baseCaps.every((c) => audioCaps.includes(c)) && baseCaps.length < audioCaps.length,
        'C19 **该命中**：选型请求在 `buildModelRequest` 的真源**之上追加** `audio`（不是另抄一份请求形状）',
        `base=[${baseCaps.join(',')}] → audio=[${audioCaps.join(',')}]`);
      crit('M4', !baseCaps.includes(AUDIO_CAPABILITY) && !JSON.stringify(plain).includes(AUDIO_CAPABILITY),
        'C19 **该不命中**：普通 conversation 请求里**没有** `audio`（否则等于给所有任务都加了一道音频门槛）',
        `base=[${baseCaps.join(',')}]`);

      // 结构式：`transcribeAudio` 传给 `selectModel` 的那个 req，须与真源组装出的**同一个对象形状**。
      let seenReq: Record<string, unknown> | null = null;
      const run = async (opts: { endpoint?: AudioEndpoint | null; chatText?: string; chatOk?: boolean }) => {
        let body: Record<string, unknown> = {};
        const result = await transcribeAudio('/x/audio.wav', {
          selectModel: async (req) => { seenReq = req; return opts.endpoint ?? null; },
          readFile: async () => wavBytes,
          chat: async (_ep, b) => {
            body = b;
            return opts.chatOk === false ? { ok: false, detail: 'HTTP 400: unknown variant' } : { ok: true, text: opts.chatText ?? '转写结果' };
          },
        });
        return { result, body };
      };
      const EP = { url: 'https://example.test', api_key: 'k', model_name: 'm1' };
      const { result: rHit, body: body0 } = await run({ endpoint: EP, chatText: '你好世界' });
      const reqMatched = seenReq !== null && JSON.stringify(seenReq) === JSON.stringify(audioReq);
      crit('M4', rHit.ok === true && rHit.text === '你好世界' && reqMatched,
        'C19 **该命中**：`transcribeAudio` 用**真源组装**的请求去选型（`selectModel` 实收 req 与 `buildAudioModelRequest()` 逐字节同形），拿到端点即返回正文',
        `ok=${rHit.ok} / req 同形=${reqMatched}`);

      // ── C19 提交体形状（zx_20260921_1 M1 **就地改判据**）────────────────────────────
      //   ⚠ 旧判据 `Buffer.from(data,'base64').equals(wavBytes)` 把**裸 base64** 钉成了形状。
      //     那是**判据的形状假设错了**，不是源码错了（承 zx_20260920_1：回退的只能是判据的形状假设）。
      //     形状本该**由接收方定**，故期望值一律**由载体自身派生**——
      //     问生产那份 `audioDataShapeOf`、前缀取 `AUDIO_DATA_URL_PREFIX`、端点按 `AUDIO_DATA_URL_HOSTS` 现造。
      //     **夹具里零处手抄 host 字面量、零处写死"本轮为真"的值。**
      const bodyType = body0 as { messages?: Array<{ content?: Array<Record<string, unknown>> }>; model?: unknown; temperature?: unknown };
      const parts0 = bodyType.messages?.[0]?.content ?? [];
      crit('M4', bodyType.model === 'm1' && bodyType.temperature === 0
        && parts0.find((p) => p.type === 'input_audio')?.input_audio !== undefined
        && parts0.some((p) => p.type === 'text'),
        'C19 提交体是 OpenAI 兼容形状：`model` / `temperature=0` / `input_audio` part / 转写提示词 part 各在场',
        `model=${String(bodyType.model)} / temp=${String(bodyType.temperature)}`);

      /** 一次提交体里 `input_audio` 的形状体检；期望值现算，不手抄。 */
      const shapeProbe = (b: Record<string, unknown>) => {
        const ps = ((b as { messages?: Array<{ content?: Array<Record<string, unknown>> }> }).messages?.[0]?.content) ?? [];
        const part = ps.find((p) => p.type === 'input_audio') as { input_audio?: { data?: string; format?: string } } | undefined;
        const data = part?.input_audio?.data ?? '';
        const prefixed = data.startsWith(AUDIO_DATA_URL_PREFIX);
        const payload = prefixed ? data.slice(AUDIO_DATA_URL_PREFIX.length) : data;
        return {
          data, prefixed,
          formatOk: part?.input_audio?.format === 'wav',
          roundtrip: !!data && Buffer.from(payload, 'base64').equals(wavBytes),
          // **旧判据形**（不剥前缀直接解）：这一格是"判据自身也受判据管"的那一面。
          legacyRoundtrip: !!data && Buffer.from(data, 'base64').equals(wavBytes),
        };
      };

      // 扫描面自证：名单为空则下面的遍历**空转即绿**（承 §G-2，扫了个空不算过）。
      crit('M4', AUDIO_DATA_URL_HOSTS.length >= 1,
        'C19 **扫描面自证**：`AUDIO_DATA_URL_HOSTS` 非空（否则下面两支遍历一处也跑不到，验的是空气）',
        `hosts=[${AUDIO_DATA_URL_HOSTS.join(',')}]`);

      // 该命中：名单内**每一个** host ⇒ 必须带前缀。
      for (const h of AUDIO_DATA_URL_HOSTS) {
        const ep: AudioEndpoint = { url: `https://${h}/compatible-mode/v1`, api_key: 'k', model_name: 'm1' };
        const { result, body } = await run({ endpoint: ep, chatText: 'ok' });
        const p = shapeProbe(body);
        crit('M4', result.ok === true && audioDataShapeOf(ep) === 'data-url' && p.prefixed && p.roundtrip && p.formatOk && !p.legacyRoundtrip,
          `C19 **该命中**（${h}）：形状由接收方定 ⇒ \`data\` 带 \`${AUDIO_DATA_URL_PREFIX}\`、**剥前缀后**解回来与喂进去逐字节相同；而**旧判据形**（不剥前缀直接解）**必假**`,
          `前缀=${p.prefixed} / 剥前缀往返=${p.roundtrip} / 旧形往返=${p.legacyRoundtrip}`);
      }

      // 该不命中：host **不在**名单里 ⇒ 仍须裸 base64（OpenAI 家族形状）。
      const EP_OTHER: AudioEndpoint = { url: 'https://api.example.test/v1', api_key: 'k', model_name: 'm1' };
      crit('M4', !AUDIO_DATA_URL_HOSTS.includes(new URL(EP_OTHER.url).hostname),
        'C19 **标本合格性**：下面这只"该不命中"标本的 host **确实不在** `AUDIO_DATA_URL_HOSTS` 里（否则它证不了另一面）',
        `host=${new URL(EP_OTHER.url).hostname}`);
      {
        const { result, body } = await run({ endpoint: EP_OTHER, chatText: 'ok' });
        const p = shapeProbe(body);
        crit('M4', result.ok === true && audioDataShapeOf(EP_OTHER) === 'raw' && !p.prefixed && p.roundtrip && p.legacyRoundtrip,
          'C19 **该不命中**（非名单 host）：`data` **不含**前缀、裸 base64 往返无损（**改成一刀切加前缀会把 OpenAI 家族打坏**）',
          `前缀=${p.prefixed} / 裸 base64 往返=${p.legacyRoundtrip}`);
      }

      // 该不命中：端点字段不齐 / 选型返回 null ⇒ 都归 `transcribe_failed`（"没有能听的模型"是如实结论，不是异常）。
      const { result: rMiss1 } = await run({ endpoint: undefined });
      const { result: rMiss2 } = await run({ endpoint: { url: 'https://example.test' } });
      crit('M4', rMiss1.ok === false && rMiss1.reason === 'transcribe_failed' && rMiss1.detail?.includes('无 audio 能力模型可给')
        && rMiss2.ok === false && rMiss2.reason === 'transcribe_failed',
        'C19 **该不命中**：ANS 选不出端点 / 端点字段不齐 ⇒ `transcribe_failed`（**不抛**、不假装能转；字段门槛与执行器取模型处同形）',
        `null⇒${rMiss1.ok === false ? rMiss1.reason : '?'} / 缺字段⇒${rMiss2.ok === false ? rMiss2.reason : '?'}`);
      // 端点拒收（HTTP 400）与空文本：两者都**没有**可给下游的字，须与"转写成功"分开。
      const { result: rHttp } = await run({ endpoint: EP, chatOk: false });
      const { result: rEmpty } = await run({ endpoint: EP, chatText: '   ' });
      crit('M4', rHttp.ok === false && rHttp.detail?.includes('unknown variant') && rEmpty.ok === false && rEmpty.detail === '模型返回空文本',
        'C19 端点拒收（错误体原样带出，判别信号就在里面）与模型返回空文本 ⇒ 都归 `transcribe_failed`，绝不把空串混进上下文',
        `HTTP⇒${rHttp.ok === false ? String(rHttp.detail).slice(0, 40) : '?'} / 空文⇒${rEmpty.ok === false ? rEmpty.detail : '?'}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C】M5 —— 附件按需读（在册 · 在档 · 调得到 + 真跑两个工具体 + ⚠ 图片回灌终局实证）');
  {
    const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), 'rr21-m5-'));
    /** 生产那份工具体：`mediaTools` 只取 `workingDir` 一个依赖，其余 `ToolDeps` 字段这两个体用不到。 */
    const media = mediaTools({ workingDir: tmp5 } as unknown as Parameters<typeof mediaTools>[0]) as unknown as {
      view_image: { execute: (a: { filePath: string }) => Promise<string> };
      read_document: { execute: (a: { filePath: string }) => Promise<string> };
    };
    /** 执行体的返回是**给模型的字符串**（可能是 JSON，也可能是带抬头的正文）——逐个判据各自解读。 */
    const parse = (s: string): Record<string, unknown> | null => {
      try { const v = JSON.parse(s) as unknown; return v && typeof v === 'object' ? v as Record<string, unknown> : null; } catch { return null; }
    };
    /**
     * 从 `role:'tool'` 的 content 里解出生产结果 —— **要解两层**。
     *
     * 因为 `view_image` 的 `execute` 返回的**已经是一个字符串**，而 provider 那层还会再
     * `JSON.stringify(result)` 一次 ⇒ content 长成 `"{\"path\":…}"`（**双重编码**）。
     * 这不是夹具的花样，正是生产这条路上模型的**真实**所见（也是"工具结果只能是文本"的直接后果）。
     */
    const unwrapToolContent = (s: string): Record<string, unknown> | null => {
      try {
        const once = JSON.parse(s) as unknown;
        if (once && typeof once === 'object') return once as Record<string, unknown>;
        if (typeof once === 'string') return parse(once);
        return null;
      } catch { return null; }
    };

    // ── C20：在册 + 在档（不在档 = 模型看不到它，等于没做）──────────────────────
    {
      const names = ['view_image', 'read_document'];
      const metas = names.map((n) => toolRegistry.getMeta(n));
      ok(TOOL_METAS.length === toolRegistry.listNames().length && TOOL_METAS.length > 0,
        'M5-2 扫描面自证：`TOOL_METAS.length` 与 `toolRegistry.listNames().length` **相等**（表没被截断，C20 不是"扫了个空"）',
        `${TOOL_METAS.length} 条`);
      crit('M5',
        metas.every((m) => !!m) && metas.every((m) => m!.category === 'media') && metas.every((m) => m!.isReadOnly),
        'C20 两条都在册，且**分类为 `media`、标记只读**（只读 ⇒ Step1 那类只读步也看得见；分类另有 C21 逐档核）',
        metas.map((m) => `${m?.name}=${m?.category}/${m?.isReadOnly}`).join(' · '));
    }

    // ── C21：逐档核（正）—— 每档可用集都算得出来，且新工具在**它该在的档**里 ────────
    {
      const SHOULD_HAVE: TaskArchetype[] = ['code', 'configuration', 'analysis', 'research', 'document'];
      const ALL_ARCH: TaskArchetype[] = [...SHOULD_HAVE, 'conversation'];
      /** 收窄器的入参：**全部在册工具**（键即工具名）——这样 `removed` 才有"档外"可言。 */
      const ALL_TOOLS: Record<string, unknown> = {};
      for (const n of toolRegistry.listNames()) ALL_TOOLS[n] = {};

      const rows = ALL_ARCH.map((a) => {
        const avail = availableToolNames(a);
        return { a, avail, has: avail.includes('view_image') && avail.includes('read_document') };
      });
      crit('M5', rows.every((r) => r.avail.length > 0) && rows.filter((r) => SHOULD_HAVE.includes(r.a)).every((r) => r.has),
        'C21 逐档核（正）：六档可用集**都算得出来**且非空；新工具在它该在的五档里**都在**（code/configuration/analysis/research/document）',
        // ⚠ 详情串**不得含 `✗`**：`scripts/run-rr-all.mjs` 以「日志里 `✗` 的条数」当失败记号，
        //   在一条**通过**的断言详情里写 `✗`（表示"本档不适用"）会被判成一次失败记号 ⇒ 全量里假红。
        rows.map((r) => `${r.a}:${r.avail.length}${r.has ? '＋' : '－'}`).join(' '));

      // 收窄器与可用集**同集**：上面的 `availableToolNames` 不能是"另算一份"——生产收窄认的就是同一份。
      const mismatch = rows.filter((r) => {
        const { kept } = narrowToolFace(r.a, ALL_TOOLS);
        return kept.length !== r.avail.length || r.avail.some((n) => !kept.includes(n));
      });
      crit('M5', mismatch.length === 0,
        'C21 逐档核（正）：`narrowToolFace` 保留的集合与 `availableToolNames` **逐档同集**（收窄器认的就是那份可用集，没有第二套口径）',
        mismatch.length ? `不一致的档：${mismatch.map((m) => m.a).join(', ')}` : `六档全一致（入参 = 全 ${Object.keys(ALL_TOOLS).length} 件在册工具）`);

      // ── C22：反 —— 新工具**不在** `conversation` 等无关档（防"到处都在" = 等于没收窄）──────
      const conv = narrowToolFace('conversation', ALL_TOOLS);
      const convAvail = availableToolNames('conversation');
      crit('M5', conv.removed.includes('view_image') && conv.removed.includes('read_document')
        && !convAvail.includes('view_image') && !convAvail.includes('read_document'),
        'C22 「该不命中」：`conversation` 档把 `view_image`/`read_document` **都移除**（对话最窄；其图/PDF 由 M2 的开局自动内联带走）',
        `removed 含两名 = ${conv.removed.includes('view_image') && conv.removed.includes('read_document')}`);
      // 配套反证一：`conversation` 的可用集**严格小于**在册全集——否则"不在其中"这条恒真、毫无信息量。
      crit('M5', convAvail.length > 0 && convAvail.length < toolRegistry.listNames().length,
        'C22 配套反证①：`conversation` 的可用集**严格小于**在册全集（"新工具不在档内"才有内容，不是恒真）',
        `conversation=${convAvail.length} / 全集=${toolRegistry.listNames().length}`);
      // 配套反证二：同一谓词在**该命中的五档**上一律判"在档内"——不是"凡查必说不在"那种恒假谓词。
      const accidentallyOut = SHOULD_HAVE.filter((a) => !availableToolNames(a).includes('view_image'));
      crit('M5', accidentallyOut.length === 0,
        'C22 配套反证②：同一谓词在**该命中的五档**上一律判"在档内"（两只标本分得开两类，不是恒假）',
        accidentallyOut.length ? `意外不含的档：${accidentallyOut.join(', ')}` : '五档全含');
    }

    // ── C20b（正+反）：`view_image` 的**执行体**——真读盘、真报元数据、看不了就**说看不了** ────
    {
      const png = path.join(tmp5, 'shot.png');
      const pngBytes = makePng(4, 3);
      fs.writeFileSync(png, pngBytes);
      // 扫描面自证：夹具是**结构真实的** PNG —— 头是 PNG 签名、尾是 IEND 块，不是一坨冒充图的后缀名。
      //   （只钉"长度 > 某数"是没意义的门槛：`makePng` 会随尺寸变长短，那个数会成为只对本例成立的哑雷。）
      const sig = pngBytes.subarray(0, 8).toString('hex');
      const tail = pngBytes.subarray(-12).toString('hex');
      ok(sig === '89504e470d0a1a0a' && tail === '0000000049454e44ae426082',
        'M5-3 扫描面自证：PNG 夹具**结构真实**（头 = PNG 签名，尾 = `IEND` 块及其标准 CRC）——否则"这不是张真图"会把降级结论搅浑',
        `${pngBytes.length} 字节 / 头=${sig} / 尾=${tail}`);

      const got = parse(await media.view_image.execute({ filePath: 'shot.png' }));
      // 尺寸：rr 里没有 electron（`import('electron')` 直接 ERR_MODULE_NOT_FOUND）⇒ `imageSize` 按设计**降级为 null**。
      //   故此处**只**钉"要么 null、要么是一对正数"，不钉死 null——否则换个跑法（真在 electron 里跑）就假红。
      const dim = got ? [got.width, got.height] : [];
      const dimOk = got !== null && ((got.width === null && got.height === null)
        || (typeof got.width === 'number' && got.width > 0 && typeof got.height === 'number' && got.height > 0));
      crit('M5', got !== null && got.bytes === pngBytes.length && got.mimeType === 'image/png'
        && got.delivered === false && typeof got.note === 'string' && got.note.includes('未送达') && dimOk,
        'C20b **该命中**：真 PNG ⇒ 字节数**报得准**（与盘上逐字节对得上）、`delivered:false`、"像素未送达"这句话在场'
          + '（尺寸取不到**按设计降级**，不是失败；`import(\'electron\')` 在 rr 里本就不可用）',
        got ? `bytes=${String(got.bytes)}/${pngBytes.length} · delivered=${String(got.delivered)} · 尺寸=${JSON.stringify(dim)}` : '返回值不是 JSON 对象');

      // 该不命中①：非位图（矢量图）——不许说成"看不了内容"就完事，要**说得清为什么**并给出替代。
      const svg = path.join(tmp5, 'icon.svg');
      fs.writeFileSync(svg, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
      const gotSvg = parse(await media.view_image.execute({ filePath: 'icon.svg' }));
      crit('M5', gotSvg !== null && typeof gotSvg.error === 'string'
        && gotSvg.error.includes('矢量') && gotSvg.error.includes('read_file'),
        'C20b **该不命中**：矢量图（`.svg`）如实说"看不了"并**指出替代工具**（不许把矢量图当位图读，也不许只说一句笼统的失败）',
        gotSvg ? `error=${String(gotSvg.error).slice(0, 60)}…` : '返回值不是 JSON 对象');

      // 该不命中②：文本文件走错门——同样要指回 `read_file`。
      const txt = path.join(tmp5, 'note.txt');
      fs.writeFileSync(txt, Buffer.from('hello'));
      const gotTxt = parse(await media.view_image.execute({ filePath: 'note.txt' }));
      crit('M5', gotTxt !== null && typeof gotTxt.error === 'string' && gotTxt.error.includes('read_file')
        && gotTxt.error.includes('read_document'),
        'C20b **该不命中**：文本文件 ⇒ 指明 `read_file`（PDF 则 `read_document`），**不新造重叠能力**',
        gotTxt ? `error=${String(gotTxt.error).slice(0, 60)}…` : '返回值不是 JSON 对象');

      // 该不命中③：件不存在 ⇒ 报错里要有**盘上那个路径**（用户/模型据此判断是不是路径写错了）。
      const gotMissing = parse(await media.view_image.execute({ filePath: 'nope.png' }));
      crit('M5', gotMissing !== null && typeof gotMissing.error === 'string'
        && gotMissing.error.includes('不存在或不可读') && gotMissing.error.includes('nope.png'),
        'C20b **该不命中**：件不存在 ⇒ 如实报"不存在或不可读"且**带出盘上路径**（不是一句无声的空结果）',
        gotMissing ? `error=${String(gotMissing.error).slice(0, 60)}…` : '返回值不是 JSON 对象');

      // 该不命中④：超上限 ⇒ 报"超了多少 / 上限多少"，不假装读得了。
      const huge = path.join(tmp5, 'huge.png');
      fs.writeFileSync(huge, Buffer.alloc(IMAGE_MAX_BYTES + 1));
      const gotHuge = parse(await media.view_image.execute({ filePath: 'huge.png' }));
      crit('M5', gotHuge !== null && typeof gotHuge.error === 'string' && gotHuge.error.includes('超过')
        && gotHuge.error.includes(String(IMAGE_MAX_BYTES)),
        'C20b **该不命中**：超上限 ⇒ 报清"实际字节 vs 上限"（上限读的是**真源 `IMAGE_MAX_BYTES`**，不另写一个数）',
        gotHuge ? `error=${String(gotHuge.error).slice(0, 70)}…` : '返回值不是 JSON 对象');
    }

    // ── C21b（正+反）：`read_document` 的**执行体**——PDF 真抽、非 PDF 指回 `read_file`、抽不出如实 ────
    {
      // 与 M3 的 C12 **同一份生成器、同一组常量**（`makePdf` 已提到模块作用域）——两处读的是同一个"写进去的字"口径。
      const RD_L1 = 'Invoice total: 128.00';
      const RD_L2 = 'paid 2026-09-21';
      const RD_EXPECT = `${RD_L1}\n${RD_L2}`;
      const pdf = path.join(tmp5, 'bill.pdf');
      fs.writeFileSync(pdf, makePdf([pageStream([RD_L1, RD_L2])]));

      const out = await media.read_document.execute({ filePath: 'bill.pdf' });
      // zx_20261018_3 批六就地订正：单页不再写成"第 1-1 页"（范围两端相等时只说"第 1 页"），
      //   并且**总页数必须上屏**——改旧断言=改钉更强的真源，不是放宽。
      crit('M5', out.startsWith('[bill.pdf 第 1 页（共 1 页）]') && out.endsWith(RD_EXPECT),
        'C21b **该命中**：真 PDF ⇒ 抬头写明**来源、页范围与总页数**，正文与**写进去的那份常量逐字相等**（不是"包含"）',
        `抬头=${JSON.stringify(out.split('\n')[0])} / 正文尾部对上=${out.endsWith(RD_EXPECT)}`);

      // 截断：页数超上限时抬头须**看得见**"共几页、只给了前几页"——M3 的 C13 在装配层钉过一次，此处钉**工具出口**。
      const N_PAGES = PDF_MAX_PAGES + 2;
      const bigPdf = path.join(tmp5, 'big.pdf');
      fs.writeFileSync(bigPdf, makePdf(Array.from({ length: N_PAGES }, (_, i) => pageStream([`P${i + 1}`]))));
      const outBig = await media.read_document.execute({ filePath: 'big.pdf' });
      const wantHead = `[big.pdf 第 1-${PDF_MAX_PAGES} 页（共 ${N_PAGES} 页，已截断）]`;
      crit('M5', outBig.startsWith(wantHead) && !outBig.includes(`(P${PDF_MAX_PAGES + 1})`)
        && !outBig.includes(`P${N_PAGES}) Tj`),
        `C21b **该命中**：页数超上限 ⇒ 抬头写明"共 ${N_PAGES} 页、只给前 ${PDF_MAX_PAGES} 页、已截断"，**且真只收了前 ${PDF_MAX_PAGES} 页**`,
        `抬头=${JSON.stringify(outBig.split('\n')[0])}`);

      // 该命中①（**zx_20260924 M1 就地订正**）：文档族的其余格式 —— M1 把 `.txt/.md/.json/.csv/.docx`
      //   接上了（`doc-text.ts`），旧口径"非 PDF ⇒ 报错"已不成立。故这条**按新语义重写**：
      //   正面钉"该内联的真内联了"（不是删除、也不是放宽——改旧断言=改钉更强的真源）。
      const txt = path.join(tmp5, 'plain.txt');
      fs.writeFileSync(txt, Buffer.from('plain text'));
      const outTxt = await media.read_document.execute({ filePath: 'plain.txt' });
      crit('M5', outTxt === '[plain.txt 正文]\nplain text',
        'C21b **该命中**（zx_20260924 M1 新语义）：`.txt` ⇒ 真抽正文，抬头写明来源、正文与写进去的逐字相等',
        `out=${JSON.stringify(outTxt).slice(0, 60)}`);

      // 该命中②（**zx_20260930 M12 就地订正**）：`.log` 自 M12 起归**文档族**（`TEXT_EXTS` 纳入源码/
      //   配置/日志）——旧口径"`.log` 非文档族 ⇒ 报错"已不成立。故这条**按新语义重写**：正面钉
      //   "源码/日志真内联了"，且钉在**工具出口**（不是装配层）⇒ 「清单只有一份」在 `read_document`
      //   这一跳也成立。（判据前提被本轮设计**合法**改变，非放宽——改旧断言=改钉更强的真源。）
      const log = path.join(tmp5, 'plain.log');
      fs.writeFileSync(log, Buffer.from('log line'));
      const outLog = await media.read_document.execute({ filePath: 'plain.log' });
      crit('M5', outLog === '[plain.log 正文]\nlog line',
        'C21b **该命中**（zx_20260930 M12 新语义）：`.log` ⇒ 真抽正文，抬头写明来源、正文与写进去的逐字相等',
        `out=${JSON.stringify(outLog).slice(0, 60)}`);

      // 该不命中①（新语义）：**不在文档族**的扩展名 ⇒ 如实拒绝 + 把路指对
      //   （纯文本 `read_file` / 图片 `view_image`）——不新造重叠能力，也不假装抽得出来。
      //   zx_20260930 M12：标本由 `.log` 换成 `.bin`（`.log` 已入文档族，见上一条；`.bin` 仍是族外）。
      const bin = path.join(tmp5, 'blob.bin');
      fs.writeFileSync(bin, Buffer.from('binary blob'));
      const outBin = parse(await media.read_document.execute({ filePath: 'blob.bin' }));
      crit('M5', outBin !== null && typeof outBin.error === 'string'
        && outBin.error.includes('read_file') && outBin.error.includes('.bin'),
        'C21b **该不命中**（zx_20260930 M12 新语义）：非文档族扩展名 ⇒ 如实说本工具管哪些 + 指回 `read_file`',
        outBin ? `error=${String(outBin.error).slice(0, 60)}…` : '返回值不是 JSON 对象');

      // 该不命中②：件不存在 ⇒ 带出盘上路径。
      const outMissing = parse(await media.read_document.execute({ filePath: 'nope.pdf' }));
      crit('M5', outMissing !== null && typeof outMissing.error === 'string'
        && outMissing.error.includes('不存在或不可读') && outMissing.error.includes('nope.pdf'),
        'C21b **该不命中**：件不存在 ⇒ 如实报"不存在或不可读"且带出盘上路径',
        outMissing ? `error=${String(outMissing.error).slice(0, 50)}…` : '返回值不是 JSON 对象');

      // 该不命中③：扩展名是 .pdf 但内容不是 ⇒ **如实说抽不出**（真因在场），绝不把乱码当正文。
      const junk = path.join(tmp5, 'junk.pdf');
      fs.writeFileSync(junk, Buffer.from('not a pdf at all, just words'));
      const outJunk = parse(await media.read_document.execute({ filePath: 'junk.pdf' }));
      crit('M5', outJunk !== null && outJunk.ok === false && typeof outJunk.reason === 'string'
        && outJunk.reason.length > 0 && outJunk.bytes === 28,
        'C21b **该不命中**：假 PDF ⇒ `ok:false` + **真因在场**（不是空正文、也不是乱码），且报出真字节数',
        outJunk ? `ok=${String(outJunk.ok)} / reason=${String(outJunk.reason).slice(0, 60)}…` : '返回值不是 JSON 对象');
    }

    // ── M5-4（⚠ 方案 §M5 改动点 1 的"待坐实"）：**真跑** AI SDK 工具循环 —— 像素到不到得了模型 ──
    //   为什么必须真跑：方案原设想 `view_image` 返回 v4 的**图片型 tool result**，并预置了"不通则退为文字式提示"
    //   的退路。读文档只能读到"该 API 支持图片 part"，读不到"**本托管方**这条路上是否兑现"。判"通不通"的唯一
    //   可靠办法：让**真 `generateText` + 真 `createSafeProvider`（生产工厂）**走完一整个工具循环，把**第二轮
    //   请求体**摊开看。`fetch` 换桩是必须的（无网络），但换掉的**只有"网络这一跳"**：provider 本体、消息转换、
    //   工具循环全是生产代码。（本轮 §7 头号风险是"判据自我印证"——故这里不许用"假 generateText 返回固定形状"。）
    {
      const appReq = createRequire(path.join(root, A, 'package.json'));
      const ai = await import(pathToFileURL(appReq.resolve('ai')).href) as unknown as {
        generateText: (o: Record<string, unknown>) => Promise<{ text?: string }>;
        tool: (d: Record<string, unknown>) => Record<string, unknown>;
        jsonSchema: (s: unknown) => unknown;
      };
      const { createOpenAI } = await import(pathToFileURL(appReq.resolve('@ai-sdk/openai')).href) as unknown as {
        createOpenAI: (o: Record<string, unknown>) => (m: string) => unknown;
      };

      const pngPath = path.join(tmp5, 'probe.png');
      const pngBytes = makePng(2, 2);
      fs.writeFileSync(pngPath, pngBytes);
      const pngB64 = pngBytes.toString('base64');

      const realFetch = globalThis.fetch;
      const calls: Array<Record<string, unknown>> = [];
      const stubFetch = async (_input: unknown, init: { body?: unknown }): Promise<Response> => {
        const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        calls.push(body);
        const first = calls.length === 1;
        return new Response(JSON.stringify({
          id: `c${calls.length}`, created: 0, model: 'm1',
          choices: [{
            index: 0, finish_reason: first ? 'tool_calls' : 'stop',
            message: first
              ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'view_image', arguments: JSON.stringify({ filePath: pngPath }) } }] }
              : { role: 'assistant', content: '看过了' },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const toolMsgOf = (b: Record<string, unknown>): { content?: unknown } | undefined =>
        (Array.isArray(b.messages) ? b.messages as Array<{ role: string; content?: unknown }> : []).find((m) => m.role === 'tool');
      /** 走一趟"真 provider + 真 generateText + 桩 fetch"，返回请求体清单。 */
      const realRun = async (tools: Record<string, unknown>, maxSteps: number): Promise<{ bodies: Array<Record<string, unknown>>; threw: string }> => {
        calls.length = 0;
        globalThis.fetch = stubFetch as unknown as typeof globalThis.fetch;
        const provider = createSafeProvider({ baseURL: 'https://example.test/v1', apiKey: 'k' });
        let threw = '';
        try {
          await ai.generateText({ model: provider('m1'), prompt: '看看这张图', tools, maxSteps, toolChoice: 'required' });
        } catch (e) { threw = e instanceof Error ? e.message : String(e); }
        globalThis.fetch = realFetch;
        return { bodies: [...calls], threw };
      };

      // ① 用**生产那份工具**跑：工具循环真转起来了吗？元数据与"看不了"的话送到了吗？像素夹带了吗？
      const prodTools = mediaTools({ workingDir: tmp5 } as unknown as Parameters<typeof mediaTools>[0]);
      const runA = await realRun({ view_image: (prodTools as unknown as { view_image: unknown }).view_image }, 2);
      const toolA = toolMsgOf(runA.bodies[1] ?? {});
      const contentA = typeof toolA?.content === 'string' ? toolA.content : '';
      const metaA = unwrapToolContent(contentA);
      crit('M5', !runA.threw && runA.bodies.length === 2 && metaA !== null,
        'M5-4 真跑：真 `generateText` + 真 `createSafeProvider` 把工具循环**真转起来了**（两轮请求 ⇒ 不是一轮就收的空转）',
        runA.threw ? `**抛了**：${runA.threw}` : `请求轮数=${runA.bodies.length} / 第二轮 tool 消息在场=${!!toolA}`);
      crit('M5', metaA !== null && metaA.bytes === pngBytes.length && metaA.mimeType === 'image/png'
        && metaA.delivered === false && typeof metaA.note === 'string' && metaA.note.includes('未送达'),
        'M5-4 退路的**正面一半**：生产 `view_image` 的元数据与"像素未送达"这句话**真进了请求体**（真字节数对得上；不装作看见了）',
        metaA ? `bytes=${String(metaA.bytes)}/期望 ${pngBytes.length} · delivered=${String(metaA.delivered)} · note 在场=${typeof metaA.note === 'string'}` : '第二轮无 tool 消息');
      const sA = JSON.stringify(runA.bodies[1] ?? {});
      crit('M5', !sA.includes(pngB64) && !sA.includes('image_url'),
        'M5-4 退路的**反面一半**：请求体里**既无像素 base64、也无 `image_url` part** —— 文字式提示没夹带任何"已经送达"的假象',
        `base64 在场=${sA.includes(pngB64)} / image_url 在场=${sA.includes('image_url')}`);

      // ② 「若真按原设想用图片型 tool result」：**同一套真跑**再走一遍，看它到不到得了（终局实证）。
      const imageTool = ai.tool({
        description: '（判据专用）假想的图片型工具结果',
        parameters: ai.jsonSchema({ type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] }),
        execute: async () => ({ filePath: pngPath }),
        experimental_toToolResultContent: () => [
          { type: 'text', text: '这里有张图' },
          { type: 'image', data: pngB64, mimeType: 'image/png' },
        ],
      });
      const runB = await realRun({ view_image: imageTool }, 2);
      const sB = JSON.stringify(runB.bodies[1] ?? {});
      const toolB = toolMsgOf(runB.bodies[1] ?? {});
      crit('M5', !runB.threw && runB.bodies.length === 2 && sB.includes(pngB64) && !sB.includes('image_url'),
        'M5-4 **改法不通（终局实证）**：图片型 tool result 到了请求体里**退化成一段 JSON 文本**'
          + '（base64 落在 `role:\'tool\'` 的 **text content** 里、真图片 part `image_url` 不在）'
          + ' ⇒ 模型收到的是一坨 base64 字符：**看不见图、还白烧 token**。退路（文字式提示 + 元数据 + 让用户重发附件）是唯一诚实的选择',
        runB.threw ? `**抛了**：${runB.threw}` : `base64 在文本里=${sB.includes(pngB64)} / 真图片 part=${sB.includes('image_url')} / tool content=${typeof toolB?.content === 'string' ? toolB.content.slice(0, 110) : '(非串)'}`);

      // ③ 判据不空转：证明上面摊开的请求体**确由生产那份 `createSafeProvider` 发出**（不是裸 provider 的产物）。
      //    面包屑是它顺手删掉的 `tool_choice`：**裸**工厂留着、**生产**工厂删掉——两只标本一起试才分得开。
      const bare = await (async () => {
        calls.length = 0;
        globalThis.fetch = stubFetch as unknown as typeof globalThis.fetch;
        const p = createOpenAI({ baseURL: 'https://example.test/v1', apiKey: 'k' });
        try { await ai.generateText({ model: p('m1'), prompt: '看看这张图', tools: { view_image: imageTool }, maxSteps: 1, toolChoice: 'required' }); } catch { /* 裸工厂的产物只用于看请求体 */ }
        globalThis.fetch = realFetch;
        return [...calls];
      })();
      const body0A = runA.bodies[0] ?? {};
      crit('M5', (bare[0] ?? {}).tool_choice === 'required',
        'M5-4 配套反证①（该命中）：**裸** `createOpenAI` 把 `tool_choice` **原样送出** —— 这只标本证明"这类请求体里本就该有它"',
        `bare tool_choice=${JSON.stringify((bare[0] ?? {}).tool_choice)}`);
      crit('M5', !('tool_choice' in body0A),
        'M5-4 配套反证②（该不命中）：走**生产工厂**的请求体里 `tool_choice` **被删掉了** ⇒ 上面那些请求体确由 `createSafeProvider` 发出（不是裸 provider，也不是替身）',
        `生产体里 tool_choice 键在场=${'tool_choice' in body0A}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C】M6 —— 引擎 planning 出口**自己拆**（真跑生产 `enter_plan_mode`；只桩网络出口与 ANS 选型口）');
  {
    // 内存库的表**照抄 `database.ts` 的 DDL**（列不齐会在这里抛，而在这里抛 = 本该证的事没证到）。
    // 「这条路径真的会碰的表」：`wa_tasks`（建子任务 + 读回 depends_on/context_json + 置 planning）、
    // `wa_settings`（开关）、`wa_task_conversations`（[智能拆解] 回话）。
    const M6_SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '',
  aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_task_conversations (
  id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '',
  tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);`;
    const PARENT = 'parent-0001'; const PROJ = 'proj-0001';
    /** 改前那句回话的**逐字**原文（`control.ts` 的 `base`）——"失败即如实、逐字回旧行为"的对照物。 */
    const BASE_OLD = '请使用create_task工具将目标分解为具体子任务，设置优先级和依赖关系，完成后调用exit_plan_mode确认计划。';
    const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger; } };

    type PlanRow = {
      id: string; title: string; description: string; acceptance_criteria: string;
      depends_on: string; status: string; priority: number; source: string;
      parent_task_id: string; context_json: string;
    };
    interface PlanRun {
      resp: Record<string, unknown>;
      rows: PlanRow[];
      conv: string[];
      fetches: Array<{ url: string; body: Record<string, unknown> }>;
      modelReqs: Array<Record<string, unknown>>;
    }
    /**
     * 真跑生产 `enter_plan_mode`。桩只打在**两条边**上：
     *  - `ctx.getAnsClient()`：ANS 选型口（返回一个假 ansClient，记录它收到的选型请求）
     *  - `globalThis.fetch`：端点出口（记录 URL 与请求体，按 `scripted` 依次回话）
     * 其余（prompt 构造 / 解析 / 闸 / 落库 / 回话文案）**全是生产代码**。
     */
    async function runPlan(opts: {
      /** 模型回话队列（依次取用，取空则 `[]`）；`null` ⇒ 端点直接故障（HTTP 500）。 */
      scripted: string[] | null;
      settingRaw?: string;
      ansNull?: boolean;
      ansThrows?: boolean;
      goal?: string;
      tmp: string;
    }): Promise<PlanRun> {
      const db = new DatabaseSync(':memory:') as unknown as AnyDb;
      db.exec(M6_SCHEMA);
      db.prepare('INSERT INTO wa_tasks (id, project_id, title, description, status, context_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(PARENT, PROJ, '父任务', '把这件事做完', 'executing', '{}');
      if (opts.settingRaw !== undefined) db.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)').run('engine.plan_auto_decompose', opts.settingRaw);
      const goal = opts.goal ?? '为项目搭一条完整的数据流水线并产出报告';
      const queue = opts.scripted ? [...opts.scripted] : null;
      const fetches: PlanRun['fetches'] = [];
      const modelReqs: PlanRun['modelReqs'] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init: unknown) => {
        const body = JSON.parse(String((init as { body?: unknown })?.body ?? '{}')) as Record<string, unknown>;
        fetches.push({ url: String(url), body });
        if (queue === null) return { ok: false, status: 500, json: async () => ({}) };
        const content = queue.shift() ?? '[]';
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
      }) as unknown as typeof fetch;
      const ansClient = {
        async getOptimalModel(params: Record<string, unknown>) {
          modelReqs.push(params);
          if (opts.ansThrows) throw new Error('ANS 选型口不可达');
          if (opts.ansNull) return {};
          return { url: 'http://ans.test/v1', api_key: 'stub-key', model_name: 'stub-model' };
        },
      };
      try {
        const tools = controlTools({
          db, taskId: PARENT, projectId: PROJ, workingDir: opts.tmp,
          ctx: { getAnsClient: async () => ansClient },
          mergePlanModeContext, logger: silentLogger,
        } as never) as unknown as { enter_plan_mode: { execute: (a: { goal_summary: string }) => Promise<string> } };
        const rawOut = await tools.enter_plan_mode.execute({ goal_summary: goal });
        // zx_20260924_1 M3-a（J-6）：本读点的 `ORDER BY` 随生产口径改 —— 子任务的 `priority` 那格装的是
        //   **拆解序号**（写侧 `decomposePriority(planned, i)` = `planned-i`），生产两处读点都是
        //   `ORDER BY priority DESC`（`getReadyTasks` / `exit_plan_mode`）⇒ 这里也必须按 DESC 读，
        //   读出来的**行序才等于模板序**（下面 C23 全是逐位比较）。原写裸 `ORDER BY priority`（升序）
        //   只在"priority 恰好等于 `i`"时偶合正确，随实现一改即红——判据跟着**生产读口径**走才是更强的钉。
        const rows = db.prepare(
          'SELECT id, title, description, acceptance_criteria, depends_on, status, priority, source, parent_task_id, context_json FROM wa_tasks WHERE parent_task_id = ? ORDER BY priority DESC',
        ).all(PARENT) as PlanRow[];
        const conv = (db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'system' ORDER BY created_at")
          .all(PARENT) as Array<{ content: string }>).map((r) => r.content);
        return { resp: JSON.parse(rawOut) as Record<string, unknown>, rows, conv, fetches, modelReqs };
      } finally { globalThis.fetch = realFetch; }
    }

    const tmp6 = fs.mkdtempSync(path.join(os.tmpdir(), 'rr21-m6-'));

    // ── C23（正）：**喂一份已知拆解产物**（期望值由 `parseDecomposition` 现算，不手写）⇒ 逐字段一致 ──
    {
      const GOAL = '为项目搭一条完整的数据流水线并产出报告';
      // zx_20261016_3 M33-b（改钉更强真源，非放宽）：回话条目**四因俱全**（含 `purpose`）——
      //   `parseDecomposition` 自本轮起拒无目的因的条目；补上它，本判据判的才仍是
      //   "逐字段一致 / 前置落真 id / priority 序号 / 回话如实"，而不是被新门滤空。
      const SCRIPT3 = JSON.stringify([
        { title: '准备素材', description: '收集并清洗原始数据', acceptance_criteria: '数据表就位', purpose: '为流水线备好输入' },
        { title: '跑模型', description: '训练并评估指标', acceptance_criteria: '指标达标', purpose: '产出核心结果', dependsOn: [1] },
        { title: '写报告', description: '汇总结论成文', acceptance_criteria: '报告出炉', purpose: '把结果交付给人', dependsOn: [2] },
      ]);
      // ⚠ **期望值不手写**：拿生产那份解析器**现算**模板，再与库里真落下的行逐字段比——
      //   手写一份期望＝把"我以为它会拆成什么"当成事实，那是自我印证。
      const want = parseDecomposition(SCRIPT3, GOAL);
      const r = await runPlan({ scripted: [SCRIPT3], goal: GOAL, tmp: tmp6 });
      ok(want.length === 3, 'M6-2 扫描面自证：期望模板由**生产那份** `parseDecomposition` 现算得出（3 条），不是手写的',
        `模板 ${want.length} 条`);
      crit('M6', r.rows.length === 3
        && r.rows.every((row, i) => row.title === want[i]!.title && row.description === want[i]!.description
          && row.acceptance_criteria === want[i]!.acceptance_criteria),
        'C23 **逐字段一致**：库里的子任务标题/描述/验收标准与拆解产物**一字不差**（不是"建了 3 条"就算数）',
        `行 ${r.rows.length} · 标题 ${r.rows.map((x) => x.title).join('/')}`);
      crit('M6', r.rows.length === 3 && r.rows[0]!.depends_on === '' && r.rows[1]!.depends_on === r.rows[0]!.id
        && r.rows[2]!.depends_on === r.rows[1]!.id,
        'C23 **前置落的是真 id 不是序号**：产物说 `dependsOn:[1]` ⇒ 库里存的是**第 1 行的任务 id**（串成流水线；第 1 条无前置）',
        `depends_on = ${r.rows.map((x) => x.depends_on.slice(0, 8) || '（无）').join(' / ')}`);
      // zx_20260924_1 M3-a（J-6）：`priority` 那一格的期望值**由真源现算**（`decomposePriority(want.length, i)`，
      //   与写侧同一份换算），不再手写 `=== i` —— 那正是"旧内联写法"本身，改实现必红且它的主张（"这一格装的是
      //   拆解序号"）在改后被写成了假话。**不收窄成"priority 是数字"**：序号与模板序的对应关系逐位断。
      crit('M6', r.rows.every((row, i) => row.status === 'pending'
        && row.priority === decomposePriority(want.length, i)
        && row.source === 'auto-decompose' && row.parent_task_id === PARENT
        && (JSON.parse(row.context_json) as { auto_decomposed?: boolean; depth?: number }).auto_decomposed === true
        && (JSON.parse(row.context_json) as { depth?: number }).depth === 1),
        'C23 行**建对了**：状态 pending、优先级＝`decomposePriority(产物条数, i)`（拆解序号，与两处 DESC 读点同口径）、'
        + '`source=auto-decompose`（真库此前**零**该取值）、父指向本任务、深度＝父+1',
        `source 取值 ${r.rows[0]?.source ?? '?'} · priority ${r.rows.map((x) => x.priority).join('/')}`);
      crit('M6', r.resp.status === 'planning'
        && (r.resp.autoDecomposed as { created?: number; noDepCount?: number; refusal?: unknown })?.created === 3
        && (r.resp.autoDecomposed as { noDepCount?: number })?.noDepCount === 1
        && (r.resp.autoDecomposed as { refusal?: unknown })?.refusal === null,
        'C23 回话**如实**：`autoDecomposed.created=3` / `noDepCount=1`（只有第 1 条无前置）/ `refusal=null`',
        JSON.stringify(r.resp.autoDecomposed));
    }

    // ── C23 配套（该命中/该不命中）：**真去问了模型**，且问的方式与端点拼接口径都是生产那一套 ──
    {
      const GOAL = '为项目搭一条完整的数据流水线并产出报告';
      const r = await runPlan({ scripted: ['[]'], goal: GOAL, tmp: tmp6 });
      crit('M6', r.modelReqs.length === 1
        && JSON.stringify(r.modelReqs[0]) === JSON.stringify(DECOMPOSE_MODEL_REQUEST),
        'C23 配套：引擎路**经 ANS 选型口**取模型（能力串/策略与生产常量一字不差），不是绕过 ANS 自己配端点',
        JSON.stringify(r.modelReqs[0]));
      crit('M6', r.fetches.length === 1 && r.fetches[0]!.url === 'http://ans.test/v1/chat/completions'
        && (r.fetches[0]!.body.messages as Array<{ content: string }>)[0]!.content === buildDecomposePrompt(GOAL),
        'C23 配套：端点走**归一处真源** `resolveChatCompletionsUrl`，且请求体里的 prompt **就是生产那份** `buildDecomposePrompt` 的产物'
        + '——⚠ 本条夹具 base 是 `http://ans.test/v1`（含路径段），归一处前后**同值**，故它证的是"接线没断"，'
        + '**不**证"拼法对"；拼法的判别在 `rr_zx_20260921_1` 的 C9（八行表 + 两只改前算法负对照）',
        `${r.fetches[0]?.url ?? '（未发请求）'}`);
      // 该不命中：模型回"拆不了"（空数组）⇒ 一条不建、回话回**逐字旧文案**（不是"建了 0 条"这种自造形状）。
      crit('M6', r.rows.length === 0 && r.resp.status === 'planning' && r.resp.instruction === BASE_OLD
        && !('autoDecomposed' in r.resp),
        'C23 配套（该不命中）：模型答"不必拆" ⇒ **一条不建**、回话**逐字**回旧文案、响应体里**没有** `autoDecomposed` 键（不编造"拆了 0 个"）',
        `instruction 逐字相同=${r.resp.instruction === BASE_OLD}`);
    }

    // ── C24（反）：**自环序号** ⇒ 落库的 `depends_on` 不含自身（D4 断点②，随 M6 同行落地）────
    {
      // 两只标本同批**一起试**（承"豁免/门槛类判据须用该命中+该不命中两只标本"）：
      //   第 1 条 `[1]` 与第 3 条 `[3]` 都是**自环**（各自指向自己），第 2 条 `[1]` 是**合法前置**。
      // zx_20261016_3 M33-b（改钉更强真源，非放宽）：补 `purpose`（四因俱全），否则本轮新加的目的因门
      //   会先把三条滤空，判据就变成"证明不了自环被丢"的空转。
      const SCRIPT_SELF = JSON.stringify([
        { title: '甲一步', description: '自己等自己', acceptance_criteria: '—', purpose: '服务于父目标', dependsOn: [1] },
        { title: '乙一步', description: '等甲', acceptance_criteria: '—', purpose: '服务于父目标', dependsOn: [1] },
        { title: '丙一步', description: '也自己等自己', acceptance_criteria: '—', purpose: '服务于父目标', dependsOn: [3] },
      ]);
      const r = await runPlan({ scripted: [SCRIPT_SELF], goal: '自环标本', tmp: tmp6 });
      const selfIds = r.rows.filter((row) => row.depends_on.split(',').includes(row.id)).map((x) => x.title);
      crit('M6', r.rows.length === 3 && selfIds.length === 0 && r.rows[0]!.depends_on === ''
        && r.rows[1]!.depends_on === r.rows[0]!.id && r.rows[2]!.depends_on === '',
        'C24 **自环丢弃、合法前置保留**：序号指向**自身**（第 1 条 `[1]`、第 3 条 `[3]`）⇒ 落库为空；指向**别人**的（第 2 条 `[1]`）⇒ 保留。'
        + '自环若留下，该子任务恒 `waiting`、永不执行、父永不放行（互锁——正是 D4 断点②）',
        `含自身的行 ${selfIds.length} 条 / 前置 = ${r.rows.map((x) => (x.depends_on ? `→第 ${r.rows.findIndex((y) => y.id === x.depends_on) + 1} 条` : '（无）')).join(' / ')}`);
      // **三处受益面**同证：同一份 `resolveIndexDeps`（IM 拆解 / GUI 模板 / 引擎拆解共用）行为一致。
      //   该命中：序号指向自己 ⇒ 丢（第 1 条自环 / 第 3 条自环，两处都试）。
      //   该不命中：指向别人 ⇒ 留；重复序号 ⇒ 去重；且**不传 `selfId` 时按老行为留** ——
      //   三者一起才说明"丢的确实是自环"，而不是"这个函数把什么都丢了"。
      const kids = ['k0', 'k1', 'k2'];
      const imWay = resolveIndexDeps([1], kids, kids[0]);
      const guiWay = resolveIndexDeps([1, 2, 2], kids, kids[2]);
      const engineWay = resolveIndexDeps([3], kids, kids[2]);
      const legacy = resolveIndexDeps([1], kids);
      crit('M6', imWay === '' && guiWay === 'k0,k1' && engineWay === '' && legacy === 'k0',
        'C24 配套：该函数是**全仓共用**（IM 拆解 / GUI 模板 / 引擎拆解三处）⇒ 自环过滤**一处改、三处同时受益**；'
        + '且**该不命中**：指向别人保留、重复序号去重、旧调用（不传 selfId）行为不变——不是"把什么都丢了"',
        `自环⇒「${imWay}」/ 指向别人+去重⇒「${guiWay}」/ 另一处自环⇒「${engineWay}」/ 旧形状⇒「${legacy}」`);
    }

    // ── C25（正 + 反）：广度闸满 ⇒ **停建**且回话报**实建数**（不报 `template.length`）────────
    {
      // zx_20261016_3 M33-b（改钉更强真源，非放宽）：逐条带 `purpose`，使 6 条**全部**通过目的因门 ⇒
      //   本判据判的仍是"广度闸满即停建（created=5 / planned=6）"，而不是被新门先滤掉几条。
      const SCRIPT6 = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({
        title: `子任务${i + 1}`, description: `第 ${i + 1} 步`, acceptance_criteria: '有产出', purpose: `服务于父目标的第 ${i + 1} 点`,
      })));
      const r = await runPlan({ scripted: [SCRIPT6], goal: '六件标本', tmp: tmp6 });
      const auto = r.resp.autoDecomposed as { created?: number; planned?: number; refusal?: string } | undefined;
      crit('M6', r.rows.length === MAX_CHILD_BREADTH && auto?.created === MAX_CHILD_BREADTH
        && auto?.planned === 6 && typeof auto?.refusal === 'string' && auto.refusal.includes('上限'),
        'C25 **闸满即停建**：产物 6 件 > 槽位 5 ⇒ 只建 5 条（`created=5`/`planned=6`/`refusal` 如实带出真因，不是静默丢掉第 6 件）',
        `行 ${r.rows.length} · created=${auto?.created} · planned=${auto?.planned}`);
      crit('M6', r.resp.instruction !== BASE_OLD && typeof r.resp.instruction === 'string'
        && r.resp.instruction.includes(String(MAX_CHILD_BREADTH))
        && !r.resp.instruction.includes('6 个子任务'),
        'C25 **报的是实建数不是产物数**：回话里说的是**建了几条**（5），不是模板声明了几条（6）——报数错一则整段回话都是假账',
        String(r.resp.instruction).slice(0, 72));
      crit('M6', r.conv.some((c) => c.includes('规划 6') && c.includes('实建 5')),
        'C25 未建满的**真因也落了会话**（用户翻得到）：`规划 6 / 实建 5` 同时在场', r.conv.join(' | ').slice(0, 80));
      // 该不命中（反证）：产物 3 件 ⇒ 既不触发闸、也不该长出任何"未建满"的话。
      // zx_20261016_3 M33-b（改钉更强真源，非放宽）：三条各带 `purpose` ⇒ 不被目的因门滤，故本判据
      //   仍只判"产物 3 件 ⇒ 全建、无'未建满'"（反证的是广度闸不无辜外溢）。
      const rOk = await runPlan({ scripted: [JSON.stringify([
        { title: '甲一步', description: 'x', acceptance_criteria: 'y', purpose: '服务于父目标' },
        { title: '乙一步', description: 'x', acceptance_criteria: 'y', purpose: '服务于父目标' },
        { title: '丙一步', description: 'x', acceptance_criteria: 'y', purpose: '服务于父目标' },
      ])], goal: '三件标本', tmp: tmp6 });
      crit('M6', rOk.rows.length === 3 && (rOk.resp.autoDecomposed as { refusal?: unknown }).refusal === null
        && !rOk.conv.some((c) => c.includes('未建满')),
        'C25 配套（该不命中）：产物 3 件 ⇒ 全建、`refusal=null`、会话里**不出现**"未建满"（闸的措辞不无辜外溢）',
        `行 ${rOk.rows.length} / refusal=${JSON.stringify((rOk.resp.autoDecomposed as { refusal?: unknown }).refusal)}`);
      // 直调落库器（不经 planning 出口）：预置 5 条在途子 ⇒ 一条不建、真因带出。
      const dbGate = new DatabaseSync(':memory:') as unknown as AnyDb;
      dbGate.exec(M6_SCHEMA);
      dbGate.prepare('INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?, ?, ?, ?)').run(PARENT, PROJ, '父', 'executing');
      for (let i = 0; i < MAX_CHILD_BREADTH; i++) {
        dbGate.prepare('INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id) VALUES (?, ?, ?, ?, ?)')
          .run(`busy-${i}`, PROJ, `在途${i}`, 'executing', PARENT);
      }
      const g = planSubtasksFromTemplate(dbGate as never, {
        parentTaskId: PARENT, projectId: PROJ, depth: 0, source: 'auto-decompose',
        template: [{ title: '甲一步', description: 'x', acceptance_criteria: 'y' }],
      });
      crit('M6', g.created === 0 && g.planned === 1 && typeof g.refusal === 'string' && g.refusal.includes(String(MAX_CHILD_BREADTH)),
        'C25 直调落库器：**槽位已满（在途不计终态）⇒ 一条不建**，`refusal` 带出生产那份槽位尺的原文（不是就地另写一句"满了"）',
        `created=${g.created} / refusal 首句「${(g.refusal ?? '').split('。')[0]}」`);
    }

    // ── C26（正）：**拆解失败 ⇒ 任务照常单跑**（不阻断、不编造），且深度闸在出口仍在 ──────────
    {
      const failCases: Array<{ name: string; opts: Parameters<typeof runPlan>[0] }> = [
        { name: '端点故障(HTTP 500)', opts: { scripted: null, tmp: tmp6 } },
        { name: '选型口返回空', opts: { scripted: ['[]'], ansNull: true, tmp: tmp6 } },
        { name: '选型口抛错', opts: { scripted: ['[]'], ansThrows: true, tmp: tmp6 } },
        { name: '模型回话不是 JSON', opts: { scripted: ['抱歉，这个任务我拆不了。'], tmp: tmp6 } },
        // zx_20261016_3 M33-b：该条**只**试「条数不足」这道门 ⇒ 条目须四因俱全（带 purpose），
        //   否则"1 件"与"无目的因"两道门同时命中，这条案例名就成了假话。
        { name: '模型只拆出 1 件', opts: { scripted: [JSON.stringify([{ title: '就一件', description: 'x', acceptance_criteria: 'y', purpose: '服务于父目标' }])], tmp: tmp6 } },
      ];
      const failed: string[] = [];
      for (const fc of failCases) {
        const r = await runPlan(fc.opts);
        const okCase = r.rows.length === 0 && r.resp.status === 'planning'
          && r.resp.instruction === BASE_OLD && !('autoDecomposed' in r.resp);
        if (!okCase) failed.push(fc.name);
      }
      crit('M6', failed.length === 0,
        'C26 **拆解失败 ⇒ 一条不建、任务照常进计划模式**：五种失败（端点 500 / 选不出模型 / 选型口抛 / 回话非 JSON / 只拆 1 件）'
        + '一律回**逐字旧文案**、响应体无 `autoDecomposed`、库里 0 条子任务——模型仍可自己 `create_task`，不阻断、不编造',
        `5 例中不符者 ${failed.length} 例${failed.length ? `：${failed.join('、')}` : ''}`);
      // 该不命中（反证）：同一套夹具，只要模型给出合法产物就**必须**建出来——否则上面那 5 条只是"什么都建不出来"的空转。
      // zx_20261016_3 M33-b（改钉更强真源，非放宽）：两条各带 `purpose` ⇒ 本判据反证的仍是
      //   "同一夹具下给出合法产物就必须真建出来"（含目的因门在内的一切门都过了）。
      const rGood = await runPlan({ scripted: [JSON.stringify([
        { title: '甲一步', description: 'x', acceptance_criteria: 'y', purpose: '服务于父目标' },
        { title: '乙一步', description: 'x', acceptance_criteria: 'y', purpose: '服务于父目标' },
      ])], tmp: tmp6 });
      crit('M6', rGood.rows.length === 2 && rGood.resp.instruction !== BASE_OLD
        && String(rGood.resp.instruction).includes('请勿重复创建'),
        'C26 配套（该不命中）：同夹具下模型给出合法产物 ⇒ **真建出 2 条**且回话换成"请勿重复创建"——上面 5 条不是"这条路上什么都建不出来"',
        `行 ${rGood.rows.length} / 回话「${String(rGood.resp.instruction).slice(0, 40)}…」`);
      // 开关：关 ⇒ **根本不去问模型**（省掉这次调用），也逐字回旧文案。
      const dbOff = await runPlan({ scripted: ['[]'], settingRaw: 'false', tmp: tmp6 });
      crit('M6', dbOff.rows.length === 0 && dbOff.fetches.length === 0 && dbOff.modelReqs.length === 0
        && dbOff.resp.instruction === BASE_OLD,
        'C26 开关 `engine.plan_auto_decompose=off` ⇒ **连模型都不问**（零次选型、零次请求）、逐字回旧行为',
        `fetch ${dbOff.fetches.length} 次 / 选型 ${dbOff.modelReqs.length} 次`);
      // 缺省即开（两只标本）：无该键 ⇒ 开（真去拆）；显式 '0' 这种历史关写法 ⇒ 也认作关。
      const freshDb = new DatabaseSync(':memory:') as unknown as AnyDb;
      freshDb.exec(M6_SCHEMA);
      const onByDefault = readBoolSetting(freshDb as never, 'engine.plan_auto_decompose');
      freshDb.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)').run('engine.plan_auto_decompose', '0');
      const offByZero = readBoolSetting(freshDb as never, 'engine.plan_auto_decompose');
      crit('M6', onByDefault === true && offByZero === false,
        'C26 开关**缺省即开**（库中无此键 ⇒ 摘掉开关也照拆 = D3 的"零产出"被真消除）；而历史关写法 `\'0\'` 同样判关（同一把尺）',
        `无键⇒${onByDefault} / \'0\'⇒${offByZero}`);
      // ── 深度闸**两只标本直调落库器**（该命中 + 该不命中一起试）────────────────────────────
      //   ⚠ 如实记一条：这道闸**在 planning 出口上到不了** —— `enter_plan_mode` 自己另有一道
      //   `depth >= 2` 的早退（回"计划嵌套已达最大深度(2层)"），比 `MAX_TASK_DEPTH=5` 先响。
      //   故深度闸的证据**只能**落在直调上；下面第二条另行钉住那道早退（它省掉了一次白问模型）。
      const mkDeepDb = (d: number): AnyDb => {
        const db = new DatabaseSync(':memory:') as unknown as AnyDb;
        db.exec(M6_SCHEMA);
        db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, ?, ?, ?, ?)')
          .run(PARENT, PROJ, '父', 'executing', JSON.stringify({ depth: d }));
        return db;
      };
      const deepTpl = [{ title: '甲一步', description: 'x', acceptance_criteria: 'y' }];
      const atLimit = planSubtasksFromTemplate(mkDeepDb(MAX_TASK_DEPTH) as never, {
        parentTaskId: PARENT, projectId: PROJ, depth: MAX_TASK_DEPTH, source: 'auto-decompose', template: deepTpl,
      });
      const underLimit = planSubtasksFromTemplate(mkDeepDb(MAX_TASK_DEPTH - 1) as never, {
        parentTaskId: PARENT, projectId: PROJ, depth: MAX_TASK_DEPTH - 1, source: 'auto-decompose', template: deepTpl,
      });
      crit('M6', atLimit.created === 0 && typeof atLimit.refusal === 'string' && atLimit.refusal.includes(String(MAX_TASK_DEPTH))
        && underLimit.created === 1 && underLimit.refusal === null,
        `C26 深度闸**两只标本分得开两类**：父在第 ${MAX_TASK_DEPTH} 层 ⇒ 子会到第 ${MAX_TASK_DEPTH + 1} 层 > 上限 ${MAX_TASK_DEPTH} ⇒ 不建；父在第 ${MAX_TASK_DEPTH - 1} 层 ⇒ 建得出（复用既有那把尺，出口不给自己开天窗）`,
        `超限⇒created ${atLimit.created}（真因带出=${typeof atLimit.refusal === 'string'}）/ 未超限⇒created ${underLimit.created}`);
      // 出口自己的 2 层早退：**连模型都不问**（省掉一次白调用），且如实回它的既有文案。
      const dbEarly = mkDeepDb(2);
      const realFetch2 = globalThis.fetch;
      let earlyFetches = 0;
      globalThis.fetch = (async () => { earlyFetches++; return { ok: true, status: 200, json: async () => ({}) }; }) as unknown as typeof fetch;
      let earlyOut = '';
      try {
        const tools = controlTools({
          db: dbEarly, taskId: PARENT, projectId: PROJ, workingDir: tmp6,
          ctx: { getAnsClient: async () => ({ getOptimalModel: async () => ({ url: 'http://ans.test/v1', api_key: 'k', model_name: 'm' }) }) },
          mergePlanModeContext, logger: silentLogger,
        } as never) as unknown as { enter_plan_mode: { execute: (a: { goal_summary: string }) => Promise<string> } };
        earlyOut = await tools.enter_plan_mode.execute({ goal_summary: '深父' });
      } finally { globalThis.fetch = realFetch2; }
      const earlyRows = (dbEarly.prepare('SELECT COUNT(*) AS c FROM wa_tasks WHERE parent_task_id = ?').get(PARENT) as { c: number }).c;
      const earlyResp = JSON.parse(earlyOut) as Record<string, unknown>;
      crit('M6', typeof earlyResp.error === 'string' && earlyResp.error.includes('计划嵌套已达最大深度')
        && earlyRows === 0 && earlyFetches === 0,
        `C26 出口自带的 2 层早退**先响**：父已在第 2 层 ⇒ 回既有那句"计划嵌套已达最大深度(2层)"、**不建**、且**连模型都不问**（一次白调用都不烧）`,
        `error 在场=${typeof earlyResp.error === 'string'} / 实建 ${earlyRows} 条 / fetch ${earlyFetches} 次`);
    }

    // ── C27（纪律）：**不写"本轮为真、下轮必假"的轮次等值字面量**（哑雷）──────────────
    {
      // ⚠ 轮次标签**由载体自身派生**（本脚本的文件名），不手抄常量——
      //   凡"≥ 本轮"的比较若写成 `=== 'zx_20260921'`，就是一颗只对下一轮引爆的哑雷。
      const ROUND = (path.basename(__filename).match(/zx_\d{8}(?:_\d+)?/) ?? [''])[0]!;
      ok(ROUND.length > 0, 'C27 派生自证：轮次标签由 `path.basename(__filename)` 派生（不手抄任何轮次常量）', ROUND);
      // 去注释后扫**本脚本自己**：注释里引方案路径（含轮次）不算"写进判据的字面量"。
      const RE_DUMB = /(?:===|!==|==|!=|\beq\()\s*['"]zx_\d{8}[^'"]*['"]/g;
      const selfSrc = strip(__filename);
      const hits = [...selfSrc.matchAll(RE_DUMB)].map((m) => m[0]);
      // 两只标本一起试：该命中的串必须被抓到，该不命中的（派生比较 / 方案路径）必须放过——
      //   只试一只 ⇒ 任何过宽的变体都全票通过。
      //   ⚠ 标本串**由派生出的 ROUND 现拼**（不写死轮次）：否则标本自己就成了本文件里那"一处命中"，
      //     判据会被自己的标本判红——这正是"判据也会被自己的形状咬到"的一个现成例子。
      const RE_SCAN = (s: string): string[] => [...s.matchAll(RE_DUMB)].map((m) => m[0]);
      const probeHit = RE_SCAN(`crit('M6', tag === '${ROUND}', 'x')`);
      const probeMiss = RE_SCAN(`if (ROUND >= DERIVED) {}\nplanPath = 'plans/improve/' + ROUND + '.md';`);
      crit('M6', probeHit.length === 1 && probeMiss.length === 0 && hits.length === 0,
        'C27 本脚本**零处**轮次等值字面量（哑雷）；且该扫描器**两只标本都试过**：写死轮次的串必被抓到、派生比较与方案路径必被放过',
        `命中 ${hits.length} 处 · 该命中标本 ${probeHit.length}/1 · 该不命中标本 ${probeMiss.length}/0`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【D】M7 —— 子任务放行回路四处断点（GUI 置终态 / 拆解自环 / 祖先互锁 / 悬挂无出路）');
  {
    // 内存库的表**照抄 `database.ts` 的 DDL**（列不齐会在这里抛，而在这里抛 = 本该证的事没证到）。
    // 「本批真会碰的表」：`wa_tasks`（父子链 + depends_on + context_json）、`wa_jobs`（在途作业判据）、
    // `wa_task_conversations`（收敛时的如实回话）、`wa_deliverables`（`checkParentTaskAfterChildDone`
    // 的逐子交付摘要会读它）、`wa_settings`（回退开关）。
    const M7_SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '',
  aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_task_conversations (
  id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '',
  tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_jobs (
  id TEXT PRIMARY KEY, type TEXT, payload TEXT, status TEXT DEFAULT 'pending', error TEXT,
  created_at TEXT DEFAULT (datetime('now')), started_at TEXT, completed_at TEXT, updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_deliverables (
  id TEXT PRIMARY KEY, task_id TEXT, name TEXT, type TEXT DEFAULT 'doc', status TEXT DEFAULT 'active',
  is_primary INTEGER DEFAULT 0, file_path TEXT, description TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);`;
    const PROJ7 = 'proj-m7';
    const tmp7 = fs.mkdtempSync(path.join(os.tmpdir(), 'rr21-m7-'));
    const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger; } };
    /** 内存库 + 建表——**先建表、后插行**（列不齐/顺序颠倒都会在这里抛，而抛了 = 本该证的事没证到）。 */
    const mkM7 = (): AnyDb => { const d = new DatabaseSync(':memory:') as unknown as AnyDb; d.exec(M7_SCHEMA); return d; };
    const addTask = (
      d: AnyDb, id: string, status: string,
      o?: { parent?: string; deps?: string; ctx?: Record<string, unknown> },
    ): void => {
      d.prepare('INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id, depends_on, context_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, PROJ7, `标题-${id}`, status, o?.parent ?? '', o?.deps ?? '', JSON.stringify(o?.ctx ?? {}));
    };

    // ── C28（正 + 反）：GUI 路把子任务置**终态**⇒ 问一句父能不能放行 ──────────────────────────
    //   ⚠ 跑的是**生产那份实现** `afterTaskTerminalStatus`（`core/task-terminal-release.ts`），
    //   不是复刻等价物；入队也走**真源** `enqueueJob`，只在 `setJobEnqueuer` 处捉桩。
    {
      const run = (siblingStatus: string): { jobs: Array<{ type: string; payload: Record<string, unknown> }>; parentStatus: string; waJobs: number } => {
        const db = mkM7();
        addTask(db, 'P1', 'paused', { ctx: { pause_reason: 'children_incomplete' } });
        addTask(db, 'A1', 'completed', { parent: 'P1' });
        addTask(db, 'B1', siblingStatus, { parent: 'P1' });
        const jobs: Array<{ type: string; payload: Record<string, unknown> }> = [];
        setJobEnqueuer((type, payload) => { jobs.push({ type, payload }); return Promise.resolve(''); });
        try {
          afterTaskTerminalStatus(db, 'A1');
        } finally { setJobEnqueuer(null); }
        const ps = (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get('P1') as { status: string }).status;
        const wj = (db.prepare('SELECT COUNT(*) AS c FROM wa_jobs').get() as { c: number }).c;
        return { jobs, parentStatus: ps, waJobs: wj };
      };
      const hit = run('completed');
      // C33：计数器须有「**从 0 变 1**」的正面断言——起手那个 0 也必须在场（只断"不抛"抓不住被吞的写入）。
      const before = 0; // 调用前未注入任何桩、未入队 ⇒ 起手恒 0
      crit('M7', before === 0 && hit.jobs.length === 1 && hit.jobs[0]!.type === 'resume-ai-task'
        && hit.jobs[0]!.payload.taskId === 'P1' && !('initiator' in hit.jobs[0]!.payload)
        && hit.parentStatus === 'pending' && hit.waJobs === 0,
        'C28 **正面**：兄弟子任务**全到终态** ⇒ 父**从 `paused` 变 `pending`**、且 `resume-ai-task` 经**入队一处真源**发出'
        + '（注入桩抓到 **1** 笔、起手为 0）；载荷**不含 `initiator`** ⇒ 缺省 `system`，记 `auto_resume_count` 不给用户的"介入次数"灌水；'
        + '库内 `wa_jobs` **0 行** ⇒ 没有绕过真源去裸插',
        `父 paused→${hit.parentStatus} · 桩 ${before}→${hit.jobs.length} 笔(${hit.jobs.map((j) => j.type).join(',')}) · 裸插行 ${hit.waJobs}`);
      const miss = run('pending');
      crit('M7', miss.jobs.length === 0 && miss.parentStatus === 'paused',
        'C28 **反面（该不命中）**：还有兄弟**没跑完** ⇒ 父**一动不动**（仍 `paused`）、**0 笔**入队'
        + '——上面那条不是"只要调了就放行"',
        `父→${miss.parentStatus} · 入队 ${miss.jobs.length} 笔`);
    }

    // ── C29（反 ×3）：三处拆解调用点**确传了 `selfId`** ⇒ 自环序号被丢弃 ─────────────────────
    //   ⚠ 本断言证的是**接线**（"确传了第三参"这一事实）；真正的**过滤行为**在共用的
    //   `resolveIndexDeps` / `planSubtasksFromTemplate` 上由 C24 的行为断言覆盖。
    //   二者合一才叫"三处都滤了"，**单看任一半都只是推测**（故两半都写，且此处如实标出它是哪一半）。
    {
      /** 逐字取 `from`（`(` 之后）起**配对括号内**的顶层实参——按符号切，不按行号。 */
      const topLevelArgs = (src: string, from: number): string[] => {
        let depth = 0; let cur = ''; const out: string[] = [];
        for (let i = from; i < src.length; i++) {
          const c = src[i]!;
          if (depth === 0 && c === ')') { out.push(cur); return out; }
          if (c === '(' || c === '[' || c === '{') depth++;
          else if (c === ')' || c === ']' || c === '}') depth--;
          if (depth === 0 && c === ',') { out.push(cur); cur = ''; continue; }
          cur += c;
        }
        out.push(cur); return out;
      };
      // zx_20260929 M5-c 就地订正（改钉更强真源，非放宽）：原扫描面是**三处**（引擎拆解 / GUI 模板 / IM 拆解），
      //   要求 `total >= 4`。M5-c 把 IM 路并进唯一实现 ⇒ 生产里**直接**调 `resolveIndexDeps` 的只剩两处
      //   （`task-decompose.ts` 一处，供引擎路与 IM 路共用；`project.ipc.ts` 一处）。所以数量判据从 4 降到 2 时
      //   **同时**补一条更强的：IM 路**必须经唯一实现**（引它 + 零直调）——"少了一处"本身要被断言，
      //   否则"IM 路还能自成一摊"就没人拦得住。
      const sites: Array<{ file: string; label: string }> = [
        { file: `${MAIN}/core/task-decompose.ts`, label: '引擎拆解（IM 拆解同走此路）' },
        { file: `${MAIN}/ipc/project.ipc.ts`, label: 'GUI 模板' },
      ];
      const perFile: string[] = [];
      const missing: string[] = [];
      let total = 0;
      for (const s of sites) {
        const src = strip(s.file);
        let n = 0;
        for (const m of src.matchAll(/resolveIndexDeps\(/g)) {
          const args = topLevelArgs(src, (m.index ?? 0) + 'resolveIndexDeps('.length);
          n++; total++;
          if (args.length < 3) missing.push(`${s.label}(${args.length} 参)`);
        }
        perFile.push(`${s.label} ${n} 处`);
      }
      const imRouterSrc = strip(`${MAIN}/services/im-router.ts`);
      const imDirect = [...imRouterSrc.matchAll(/resolveIndexDeps\(/g)].length;
      crit('M7', total >= 2 && perFile.every((s) => !s.endsWith(' 0 处')) && missing.length === 0,
        'C29 拆解调用点**全部**给序号→id 映射传了"自己是谁"（`selfId`）⇒ 自环序号一律被丢弃；'
        + '`resolveIndexDeps` 是**全仓唯一**的序号→id 映射函数，故这一改两处同时受益（此处是**接线半**，行为半在 C24）',
        `共 ${total} 处调用（${perFile.join(' · ')}），缺第三参 ${missing.length} 处${missing.length ? `：${missing.join('、')}` : ''}`);
      crit('M7', imDirect === 0 && /\bplanSubtasksFromTemplate\s*\(/.test(imRouterSrc),
        'C29 ★ M5-c：`im-router.ts` **零直调** `resolveIndexDeps(`（自环过滤不再由 IM 路自带副本承担），'
        + '而是经唯一实现 `planSubtasksFromTemplate` ——"三处受益面"仍成立，但受益方式是**共用一处**而非各持一份',
        `IM 路直调 ${imDirect} 处`);
      // 两只标本一起试：把其中一个调用点的第三参抹掉，扫描器**必须**当场报缺——否则上面那条只是"永远为真"。
      const probeSrc = `const s = resolveIndexDeps(t.dependsOn, ids);`;
      const probeArgs = topLevelArgs(probeSrc, probeSrc.indexOf('resolveIndexDeps(') + 'resolveIndexDeps('.length);
      crit('M7', probeArgs.length === 2 && missing.length === 0,
        'C29 配套（两只标本）：**两参**的调用被扫描器判缺（该命中），而**真源码里的四处**一处不缺（该不命中）'
        + '——否则"缺第三参 0 处"可能只是扫描器从不报缺',
        `两参标本判出 ${probeArgs.length} 参 / 真源码缺参 ${missing.length} 处`);
    }

    // ── C30（反 + 正）：`create_task` 前置**不得指向自己的祖先** ───────────────────────────────
    //   ⚠ 就地订正⑩：原稿写"喂构成环的 depends_on ⇒ 拒绝"，实测**恒不命中**——`create_task` 建的是
    //   **全新 UUID**，库中无人以它为前置 ⇒ `introducesCycle` 对本路恒返回 null（探针实测）。
    //   真正咬人的环在**父子关系**里：子 `depends_on=父` ⇒ 父等子终态、子等父完成 ⇒ 双双永不启动。
    {
      const db = mkM7();
      addTask(db, 'GP', 'executing');
      addTask(db, 'P1', 'executing', { parent: 'GP' });
      addTask(db, 'SIB', 'executing', { parent: 'P1' });
      const tools = controlTools({
        db, taskId: 'P1', projectId: PROJ7, workingDir: tmp7,
        ctx: { getAnsClient: async () => ({ getOptimalModel: async () => ({ url: 'http://ans.test/v1', api_key: 'k', model_name: 'm' }) }) },
        mergePlanModeContext, logger: silentLogger,
      } as never) as unknown as { create_task: { execute: (a: { title: string; description: string; depends_on?: string }) => Promise<string> } };
      const denyParent = JSON.parse(await tools.create_task.execute({ title: '子', description: 'x', depends_on: 'P1' })) as { error?: string };
      const denyGrand = JSON.parse(await tools.create_task.execute({ title: '子2', description: 'x', depends_on: 'GP' })) as { error?: string };
      const rowsAfterDeny = (db.prepare('SELECT COUNT(*) AS c FROM wa_tasks WHERE parent_task_id = ?').get('P1') as { c: number }).c;
      crit('M7', typeof denyParent.error === 'string' && denyParent.error.includes('祖先')
        && typeof denyGrand.error === 'string' && denyGrand.error.includes('祖先') && rowsAfterDeny === 1,
        'C30 **反面**：前置写**父任务**或**祖父任务** ⇒ `create_task` **如实拒绝**（回话点名"祖先"并说明互锁真因），'
        + '**一行都不建**（唯一那条子行是夹具里的兄弟 `SIB`）——不静默写入一颗哑雷',
        `拒父=${typeof denyParent.error === 'string'} / 拒祖=${typeof denyGrand.error === 'string'} / 子行数=${rowsAfterDeny}（应=1，夹具自身）`);
      const allow = JSON.parse(await tools.create_task.execute({ title: '子3', description: 'x', depends_on: 'SIB' })) as { taskId?: string; status?: string; error?: string };
      crit('M7', typeof allow.taskId === 'string' && !allow.error,
        'C30 **正面（该不命中）**：前置写**兄弟**子任务 ⇒ 照常建出来（依赖是合法用法，闸不误伤）'
        + '——否则上面那条只是"这个工具建不出任何东西"',
        `taskId=${String(allow.taskId).slice(0, 8)} / status=${allow.status}`);
    }

    // ── C31（正 + 反）：悬挂 pending 子任务的对账（断点④）────────────────────────────────────
    //   ⚠ 跑的是**生产那份实现** `reconcileStalledSubtasks`（不是复刻等价物）。
    {
      const db = mkM7();
      addTask(db, 'P9', 'paused', { ctx: { pause_reason: 'children_incomplete' } });
      // 该命中：前置已 `failed`（`classifyDep` 判 `dead`，永不自动解锁），且**无在途作业** ⇒ 永无出路
      addTask(db, 'DEAD', 'failed');
      addTask(db, 'C1', 'pending', { parent: 'P9', deps: 'DEAD' });
      // 该不命中①：前置还在跑 ⇒ `waiting`，等待是对的，不是故障
      addTask(db, 'RUN', 'executing');
      addTask(db, 'C2', 'pending', { parent: 'P9', deps: 'RUN' });
      // 该不命中②：前置已死，但本任务**有在途作业**（排队中）⇒ 排队也是出路，不该被收敛
      addTask(db, 'C3', 'pending', { parent: 'P9', deps: 'DEAD' });
      db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES (?, 'ai-task', ?, 'pending')")
        .run('job-c3', JSON.stringify({ taskId: 'C3', projectId: PROJ7 }));
      // 该不命中③：前置已死，但**父已终态** ⇒ 本批处理面之外（父已终态时"因由如实升级"的收益不存在）
      addTask(db, 'PZ', 'completed');
      addTask(db, 'C4', 'pending', { parent: 'PZ', deps: 'DEAD' });
      // 该不命中④：**无前置** ⇒ 压根不是"悬挂"，连审都不必审
      addTask(db, 'C5', 'pending', { parent: 'P9' });

      const res = reconcileStalledSubtasks(db as never);
      const st = (id: string) => (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
      const convC1 = (db.prepare("SELECT COUNT(*) AS c FROM wa_task_conversations WHERE task_id = 'C1' AND role = 'system'").get() as { c: number }).c;
      const pCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('P9') as { context_json: string }).context_json) as { pause_reason?: string };
      crit('M7', res.reconciled.length === 1 && res.reconciled[0] === 'C1' && st('C1') === 'failed'
        && convC1 === 1 && pCtx.pause_reason === 'children_failed' && st('P9') === 'paused' && res.candidates === 3,
        'C31 **正面**：前置已死 + 无在途作业 ⇒ 该子任务**标 `failed` 并留一条如实回话**（真因取自 `depBlockInfo` 唯一真源）；'
        + '随后走**引擎那把同一把尺** ⇒ 父的因由**如实升级**为 `children_failed`（"有子失败，须处置"），'
        + '而**不再**被许诺"子一到终态即自动恢复"（那句假话的终结）',
        `收敛 ${res.reconciled.length} 条(起手 0)→[${res.reconciled.join(',')}] · C1=${st('C1')} · 回话 ${convC1} 行 · 父因由=${pCtx.pause_reason} · 候选 ${res.candidates}`);
      crit('M7', st('C2') === 'pending' && st('C3') === 'pending' && st('C4') === 'pending' && st('C5') === 'pending',
        'C31 **反面（该不命中的不被改）**：前置仍在跑（`waiting`）/ 自己有在途作业（排队中）/ 父已终态 / 无前置'
        + '——四只标本**一律 `pending` 原地不动**。候选面 3 = {C1(该收敛), C2(等前置跑完), C5(无前置)}：'
        + 'C3 有在途作业、C4 父已终态，**连候选都不是**（不是"进了候选又没被改"）',
        `C2=${st('C2')} · C3=${st('C3')} · C4=${st('C4')} · C5=${st('C5')} · 候选 ${res.candidates}`);
      // C33：计数器类断言的「从 0 变 1」——上面 `res.reconciled.length === 1` 已含此意，
      //   此处把**起手那个 0** 也在场（不写死"必然如此"，而是**同一只库跑第二遍**必得 0：已收敛者不再是候选）。
      const res2 = reconcileStalledSubtasks(db as never);
      crit('M7', res2.reconciled.length === 0 && res2.candidates === 2,
        'C33 计数器**从 0 变 1、再变回 0**：同一只库跑第二遍 ⇒ 0 条再收敛（第一遍那个 1 不是"每跑必报"的常数）；'
        + '候选数 3→2：收敛掉的那只退出候选面，其余**原地不动**',
        `首轮 0→${res.reconciled.length} · 次轮 0→${res2.reconciled.length} · 候选 ${res.candidates}→${res2.candidates}`);
    }

    // ── C32（纪律）：夹具**先建表、后插行**；且本批**不适用**"先 new 服务再插行"那条 FTS 纪律（如实声明）
    {
      const mainSrc = raw(__filename);
      const m7At = mainSrc.indexOf('M7_SCHEMA = `');
      const m7End = mainSrc.indexOf('【S】build 钉');
      const seg = stripKeepingLines(mainSrc.slice(m7At, m7End)).join('\n');
      const atSchema = seg.indexOf('M7_SCHEMA');
      const atExec = seg.indexOf('exec(M7_SCHEMA)');
      const atInsert = seg.indexOf("INSERT INTO wa_tasks");
      ok(atExec > -1 && atInsert > -1 && atExec < atInsert && atSchema < atExec,
        'C32 夹具**先建表、后插行**（按符号定位 `M7_SCHEMA` → `exec(...)` → 首条 `INSERT`，顺序在案）'
        + '——列不齐/顺序颠倒都会当场抛，而"抛了"= 本该证的事没证到（不是通过）',
        `exec@${atExec} < 首条 INSERT@${atInsert}`);
      ok(true,
        'C32 如实声明：本批**不存在**建触发器的服务类（`reconcileStalledSubtasks` 是纯函数、不建 FTS 同步触发器），'
        + '故"先 `new` 服务再插行"那条纪律在本批**不适用**——不是"已遵守"，是不适用，两者不可混为一谈');
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【D】M8 + zx_20260924_1 M7-c —— 拆分/外迁（只动形不动义）：六块搬出执行体、行为逐字不变');
  {
    // 本批判据**全是形状判据**（防搬空 / 防断 import / 防扫空）——方案 §M8「边界」已如实声明：
    //   **本批绿 ≠ 本批正确**，只 = **未观测到行为变化**。行为等价由"改动面 rr 子集全绿 + M9 全量不减少"承担。
    //   这是重构类改动的固有下限，不是谦虚话。
    //
    // ⚠ 本批多条判据的**文件本身就是判据**（"执行体里不再有这些定义"）⇒ **不得**用上面那个 `execSurface()` 并集：
    //   并集会把新模块里的同名定义也扫进来、把"搬走了"判成绿，即**变松**（见 `lib/rr-engine-src.ts` 文件头警告）。
    const exExecSrc = strip(`${MAIN}/core/agent-executor.ts`);

    /**
     * 取「函数体」的**开括号**：从声明处找**第一个「括号深度 0 且是该行最后一个非空字符」的 `{`**。
     *
     * ⚠ 朴素的「声明处往后找第一个 `{`」在本仓会**切错**：`executeTask` 的签名里有**对象字面量形参**
     *   （`options?: { maxSteps?: number; temperature?: number }`）⇒ 朴素法命中它、切出**单行空块**
     *   （本批测量时就踩过这只）。故改用"行末 + 括号深度 0"定位，下面另配一只反面标本把它钉住。
     */
    const bodyOpen = (src: string, decl: number): number => {
      let paren = 0;
      for (let i = decl; i < src.length; i++) {
        const c = src[i];
        if (c === '(') paren++;
        else if (c === ')') paren--;
        else if (c === '{' && paren === 0 && src.slice(i + 1, src.indexOf('\n', i)).trim() === '') return i;
      }
      return -1;
    };
    const lineAt = (src: string, idx: number): number => src.slice(0, idx).split('\n').length;
    /** 按**符号**取函数体的行跨度。`lines` 口径 = 声明行..配对花括号闭合行（含），与方案同尺（`end−start+1`）。 */
    const fnSpan = (src: string, decl: number): { body: string; startLine: number; endLine: number; lines: number } => {
      const open = bodyOpen(src, decl);
      const body = braceBlock(src, open);
      const startLine = lineAt(src, decl);
      const endLine = lineAt(src, open + body.length);
      return { body, startLine, endLine, lines: endLine - startLine + 1 };
    };
    /** 在某份源码里按符号取跨度；取不到（符号不在该文件）时返回 `null`——**不返回 0 行**，免得与"空壳函数"混淆。 */
    const spanOf = (src: string, sym: string): { body: string; startLine: number; endLine: number; lines: number } | null => {
      const at = src.indexOf(`function ${sym}(`);
      return at < 0 ? null : fnSpan(src, at);
    };

    // ── C37（纪律）：**零命中**类断言必须同时报出扫描面命中数（防"扫了个空"恒真）───────────
    //   本批有多条"执行体里**零处**有 X"的断言；若扫描面本身是空的（文件读错/路径变了），
    //   那些断言会**恒真**。故先把扫描面大小摆出来。
    {
      const declCount = (exExecSrc.match(/\bfunction\s+\w+\s*\(/g) || []).length;
      const exportDeclCount = (exExecSrc.match(/^export (?:async )?function \w+\(/gm) || []).length;
      const rawLines = raw(`${MAIN}/core/agent-executor.ts`).split('\n').length;
      crit('M8', declCount >= 20 && exportDeclCount >= 10,
        'C37 扫描面自证：执行体里函数声明 ≥ 20 处（"某符号不在此文件"这类**零命中**判据的扫描面不是空的）；'
        + '并同时自证**去注释保留行数**——`stripKeepingLines` 只去注释、不去行，故按行号记账与按原文记账等值',
        `扫到 ${declCount} 处函数声明（其中 export ${exportDeclCount} 处）· 原文 ${rawLines} 行 / 去注释 ${exExecSrc.split('\n').length} 行`);
    }

    // ── C35（正）：搬迁的 10 个导出符号在**新模块原位**仍可 import（不破坏既有 import 面）──────
    //   ⚠ 判据的**主要形态在编译期**：文件头的 `import` 是静态写死的 ⇒ 符号被删/改名时本脚本**根本跑不起来**，
    //     "报红"与"编译失败"是两回事，但两者都**不是静默假绿**。这里再断言一次"取到的是函数不是 undefined"
    //     （运行时 typo / 循环引用 TDZ 只在这里现形）。
    {
      const movedFns: Array<[string, unknown]> = [
        ['exec-claim.ts:claimTaskForExecution', claimTaskForExecution],
        ['exec-claim.ts:preExecutionConfirmGate', preExecutionConfirmGate],
        ['exec-claim.ts:captureSnapshotBeforeRun', captureSnapshotBeforeRun],
        ['exec-model-select.ts:selectModelForTask', selectModelForTask],
        ['exec-budget.ts:resolveTaskBudget', resolveTaskBudget],
        ['exec-context.ts:buildTaskContext', buildTaskContext],
        ['exec-finalize.ts:finalizeRunClose', finalizeRunClose],
        ['memory-context.ts:buildMemoryContext', buildMemoryContext],
        ['memory-context.ts:selectMemorySections', selectMemorySections],
        ['memory-context.ts:memoryConfTag', memoryConfTag],
      ];
      const bad = movedFns.filter(([, v]) => typeof v !== 'function').map(([n]) => n);
      crit('M8', movedFns.length === MOVED_SYMBOLS.length && bad.length === 0,
        'C35 六块搬迁的 **10 个导出符号**在各自**新模块原位**仍可 import、且取到的是函数'
        + '（`import` 静态写在文件头 ⇒ 删/改名即编译期失败，不是"扫字符串扫了个空"）',
        `在册 ${movedFns.length} 个（MOVED_SYMBOLS 登记 ${MOVED_SYMBOLS.length} 个）· 非函数 ${bad.length} 个`
        + (bad.length ? `（${bad.join('、')}）` : ''));
    }

    // ── C35（正·另半个面）：**执行体仍 export** 的原位符号仍可 import（导出面没被拆坏）──────────
    //   搬迁顺手把这些符号从"模块私有"提到 `export`（真源仍在执行体一处、数值一格未动）。
    //   "只动形"里"形"的那一半就是**导出面**：若这些符号在原位取不到了，新模块的 import 会当场断，本脚本也编译不过。
    {
      const keptFns: Array<[string, unknown]> = [['truncateCtx', truncateCtx], ['classifyTaskGuidance', classifyTaskGuidance]];
      const keptNums: Array<[string, unknown]> = [
        ['CTX_PROJECT_MAX_CHARS', CTX_PROJECT_MAX_CHARS],
        ['CTX_MEMORY_MAX_CHARS', CTX_MEMORY_MAX_CHARS],
        ['CTX_HISTORY_TAIL_MAX_CHARS', CTX_HISTORY_TAIL_MAX_CHARS],
      ];
      const badF = keptFns.filter(([, v]) => typeof v !== 'function').map(([n]) => n);
      const badN = keptNums.filter(([, v]) => typeof v !== 'number').map(([n]) => n);
      crit('M8', badF.length === 0 && badN.length === 0 && typeof SYSTEM_PROMPT_BASE === 'string',
        'C35 本轮**因搬迁而新提到 `export`** 的 6 个符号（`truncateCtx` / `classifyTaskGuidance` / `SYSTEM_PROMPT_BASE` / '
        + '三个 `CTX_*_MAX_CHARS`）在**执行体原位**仍可 import——"只动形"里"导出面"那一半由此成立',
        `2 函数（非函数 ${badF.length}）+ 3 数值（非数值 ${badN.length}）+ 1 串（${typeof SYSTEM_PROMPT_BASE}）`);
    }

    // ── C34 反面标本（纪律「两只标本一起试」）：**朴素定位器**在真签名上必须失败 ──────────────
    {
      const decl = exExecSrc.indexOf('export async function executeTask(');
      const naive = braceBlock(exExecSrc, exExecSrc.indexOf('{', decl));
      const span = fnSpan(exExecSrc, decl);
      crit('M8', naive.split('\n').length === 1 && span.lines > 1000,
        'C34 **「该不命中」标本**：朴素的「声明处往后找第一个 `{`」在 `executeTask` 真签名上命中**对象字面量形参**'
        + '（`options?: { … }`）⇒ 切出**单行空块**；而"行末 + 括号深度 0"定位取到的是**真函数体**（>1000 行）。'
        + '——**判据的形状假设不成立时，量出来的行数是假的**（本批测量时就踩过这只）',
        `朴素块 ${naive.split('\n').length} 行 / 真函数体 ${span.lines} 行（${span.startLine}–${span.endLine}）`);
    }

    // ── C34（正）：执行体**真的变小了**（防"搬了个空"）────────────────────────────────
    {
      const executorLines = raw(`${MAIN}/core/agent-executor.ts`).split('\n').length;
      const strippedLines = exExecSrc.split('\n').length;
      const span = fnSpan(exExecSrc, exExecSrc.indexOf('export async function executeTask('));
      const modLines = MOVED_MODULE_FILES
        .map((f) => `${f.replace('.ts', '')}=${raw(`${MAIN}/core/${f}`).split('\n').length}`).join(' · ');
      crit('M8',
        strippedLines === executorLines
        && executorLines < M0_EXECUTOR_LINES && executorLines < PRE_SPLIT_EXECUTOR_LINES
        && span.lines < M0_EXECUTE_TASK_LINES && span.lines < PRE_SPLIT_EXECUTE_TASK_LINES,
        'C34 **正·方向**：执行体与 `executeTask` **双双低于基线**（两组基线都在场——M0 `73806c1a` 与拆分前 `c10d6f04^`；'
        + '取 `<` 方向而非等值：**只有在把代码塞回执行体时才变红**）。'
        + `同一条里附**口径自证**：去注释后行数 === 原文行数（${strippedLines} === ${executorLines}）⇒ 按行号记账无偏移`,
        `文件 ${executorLines} 行（M0 ${M0_EXECUTOR_LINES} / 拆分前 ${PRE_SPLIT_EXECUTOR_LINES}）· `
        + `\`executeTask\` ${span.startLine}–${span.endLine} 计 ${span.lines} 行（M0 ${M0_EXECUTE_TASK_LINES} / 拆分前 ${PRE_SPLIT_EXECUTE_TASK_LINES}）· `
        + `六模块 ${modLines}`);
    }

    // ── C34（正·真内容）：**函数定义搬走了**——在新模块里成对花括号在位，在执行体里零处 ──────────
    //   光看行数变少是不够的：**删掉也能变少**。故本条的正面是"定义真的在新模块里"。
    {
      const inModules = MOVED_SYMBOLS.filter(([f, s]) => spanOf(strip(`${MAIN}/core/${f}`), s) !== null);
      const stillInExecutor = MOVED_SYMBOLS.filter(([, s]) => exExecSrc.indexOf(`function ${s}(`) > -1);
      // 「该命中」标本：一只**明知仍在执行体**里的函数——扫描器必须对它说"在"，
      //   否则下面那句"10 个都零处"可能只是**扫描器恒假**（扫了个空）。
      const probeInPlace = exExecSrc.indexOf('function assessCompletionQuality(') > -1;
      const bodies = MOVED_SYMBOLS
        .map(([f, s]) => ({ n: `${f.replace('.ts', '')}:${s}`, lines: spanOf(strip(`${MAIN}/core/${f}`), s)?.lines ?? 0 }));
      const emptyOnes = bodies.filter((b) => b.lines < 5);
      crit('M8',
        inModules.length === MOVED_SYMBOLS.length && stillInExecutor.length === 0 && probeInPlace && emptyOnes.length === 0,
        'C34 **正·真内容（防搬空）**：10 个函数的**定义**各自在新模块里**配对花括号在位**（且体 ≥5 行，不是空壳）、'
        + '在执行体里**零处**；且扫描器对一只**明知仍在执行体**的标本（`assessCompletionQuality`）判"在"'
        + '——**两只标本都试过**，故"零处"不是"扫了个空"',
        `新模块在位 ${inModules.length}/${MOVED_SYMBOLS.length} · 执行体零处 ${stillInExecutor.length}/${MOVED_SYMBOLS.length} · `
        + `在册标本 ${probeInPlace} · 空壳 ${emptyOnes.length} 个 · 逐个体行数 [${bodies.map((b) => b.lines).join(',')}]`);
    }

    // ── C34（正·量级相符）：执行体**少掉的行**，被新模块里那 10 个函数体接住 ────────────────────
    //   两侧都派生（右=实测、左=实测）：比的是"搬走"与"删掉"的分野——若只删不搬，左侧会塌到 0。
    {
      const executorLines = raw(`${MAIN}/core/agent-executor.ts`).split('\n').length;
      const shrunk = PRE_SPLIT_EXECUTOR_LINES - executorLines;
      const movedBodyLines = MOVED_SYMBOLS
        .reduce((n, [f, s]) => n + (spanOf(strip(`${MAIN}/core/${f}`), s)?.lines ?? 0), 0);
      crit('M8', movedBodyLines >= shrunk,
        'C34 **正·量级相符**：拆分前→现在，执行体净减的行数 **≤** 六个新模块里 10 个函数体的行数之和'
        + '——"整段搬到新模块"而不是"就地删掉"（模块头注释与缩进左移属允许的包裹层变化，会使模块侧偏大，故取 `≥`）',
        `Σ函数体 ${movedBodyLines} ≥ 净减 ${shrunk}（拆分前 ${PRE_SPLIT_EXECUTOR_LINES} → 现 ${executorLines}）`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S】build 钉（派生核对，不写轮次字面量；**不受批次门管辖**）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告
//    unhandled rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20260921 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260921: ${pass} 通过 / ${fail} 失败${pending ? ` / ${pending} 待实施(不计入)` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
});
