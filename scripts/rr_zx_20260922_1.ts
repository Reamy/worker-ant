/**
 * zx_20260922_1 受控复跑 —— 「说明书与机器，各说各话」。
 *
 * 病根（`plans/improve/zx_20260922_1.md` §1.3-F8 / 表四，真任务 `a290ae2b` 实机台账）：
 * **同一句「预算爆没爆」，两处读的是不同的表。**
 * 禁用侧读 `band = Math.max(tokenBand, costBand)`（取严），放行侧只读 Token 尺的 `budget_usage_ratio`。
 * 真库标本的终局快照把这句判词的两半同时摆出：
 * ```
 * budget_usage_ratio = 0.1404195   ← Token 尺 14%
 * cost_usage_ratio   = 1.093815    ← 费用尺 109%（已爆）
 * budget_warn_band   = 5
 * ```
 * ⇒ 费用尺把 `read_file`/`edit_file`/`bash`/`execute_command` 全禁光（07:14:22），
 *   而放行侧判「没到顶」照常拦收口（07:16:11 / 07:17:29 / 07:18:46 三次 finalize 全拒），
 *   求助通道也被亲手关掉（07:17:40 `escalate_to_human 已禁用` = F10）——**干不了活 + 不许收口** 同时成立。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 本文件的**批次门**（`RR_STAGE`）—— 承 `zx_20260922` 的骨架纪律：
 *   批次门管的是**实施排期**。本轮按 §7-5 裁定 **M6 最先做**（F8 不修，后面每批的实机 E2E
 *   都可能在费用尺爆表时被同样夹死，验证本身做不下去），故这里的 `ORDER` 是**排期序**、
 *   不是方案编号序：`M6 → M1 → M2 → M3 → M4 → M5 → M7`。
 *   `RR_STAGE=Mn` 时**只要求 ≤Mn 的批次**为绿，更晚的批次打 `⏳` 且**不计入失败**。
 *   `RR_STAGE` 为空 = **全部必须绿**（M8 收口用）。
 *
 * §G 判据 G（**不变式门**，与批次无关）：
 *   G-1 **真源在位**：本轮所引用的生产符号**全部静态 import** ⇒ 被删/被改名即**编译期失败**。
 *   G-2 **扫描面自证**：凡「零处 / 恰好一处」类断言必须同时报出**扫描面规模**
 *       （承 `zx_20260920_1 §G-1`：扫了个空也是绿）。
 *   G-3 **哑雷自检**：本文件自身零处轮次等值字面量（承 `feedback_assertion_no_forward_literals`）。
 * §M6 判据（**随批次转绿**，`RR_STAGE` 管辖）：F8-1…F8-9（放行侧同源）· F10-1…F10-3（白名单）。
 * §M1 判据（F3：A3 硬线「整工具禁用」→「逐调用拒」）——**真账本 + 真配额对象 + 真
 *   `makeNonExplorationCappedTool`**，四只标本一起上（承 `feedback_predicate_needs_both_sides_specimen`）：
 *     M1-0 夹具自证（真账本走到 `hard`）· M1-A **该不命中**（越线后 `mvn -v`/`git status` 必须**成功**，
 *       本批靶心）· M1-B **该命中**（`ls`/`find` 被拒）· M1-A′ **顺带裁定取 a 的靶心**
 *       （`execute_command` 侧同尺：`mvn -v` 放行 / `ls` 被拒）· M1-G **机制反证**（被拒的没到原实现、
 *       放行的确已到达——不看字面）· M1-C **正面计数**（真账本 0→1，且收尾命令不吃额度）·
 *       M1-F 两把 shell 同判 · M1-J 同账工具全属混合类 ⇒ 硬线一个也不进 `disabledTools` ·
 *       M1-D/′/″ 接线（按 `MIXED_SHELL_TOOLS` 分流、两集合各写一处、块内零工具名字面量）。
 *   ⚠ **顺带裁定**（§3 M1 的 ⚠）：原 `isExplorationCall` 的 `execute_command` 分支只认 `py_compile`/`--version`，
 *     致同一条 `ls -la` 在 `bash` 判探索、在 `execute_command` 判非探索 ⇒ **换把 shell 即绕过**收敛/配额两闸
 *     （与 F13 同族）。取 **(a)**：补上"只读探测"这一支（`isReadOnlyProbeCommand`），**循环豁免那一支不动**
 *     ⇒ `rr_zx_20260917` 那条"`py_compile` 仍被拒"的代价断言**仍绿**。
 *
 * §M2 判据（F6a：内容门禁的**成员资格**归位——按产物本身收人，不看登记标签）——
 *   夹具=**真文件落盘 + 真 `wa_deliverables` 表**，判据跑生产真实现 `docValidationTargets`：
 *     M2-A **该命中**（真任务那 9 个业务文件 + `.java`：**族可判型**（configuration/code）⇒ 进集）·
 *     M2-B **该命中**（`设计说明.md` 登记 `doc` ⇒ 进集）·
 *     M2-B′ **标签说不、产物说是**（`.md` 却登记 `type='code'` ⇒ 照样进集——标签**不是反方向的筛子**）·
 *     M2-C 声明产出这一支**逐字不变**（落盘的进、没落盘的不进、在册但盘上无此文件的不进）·
 *     M2-E **新放开族该命中**（`.pdf`/`.mp4` 族可判型 ⇒ 进集）·
 *     M2-F/G/H **该不命中**（`.txt` 承裁定 T3 仍出局 · `_probe/_tmp_scan.md` 族可判型但探针噪声 ⇒ 出局 ·
 *       `.png` 族不可判型 ⇒ 出局）·
 *     M2-旧态反证（旧尺的就地复刻证明它在**两个方向**上都错：收 `.txt`、挡 `.pdf`/`.mp4`）·
 *     M2-S 接线（`r.type === 'doc'` 门禁块零处 · 门禁块内 `isGateArtifact`+`docNotProbe` 各一次、`type` 一词零处 ·
 *       新尺 `isGateArtifact` 只在**一处**定义）。
 *   ⚠ **就地改钉（zx_20261003 M1 / 裁定 K-6）**：本组原判"成员资格 = 扩展名 ∈ {.md,.markdown}"（旧尺
 *     `DOC_TARGET_EXT_RE`）；K-6 改为**结构性判据**「族可判型 ∧ 非探针噪声」（新尺 `isGateArtifact`）——
 *     故 M2-A 由"该不命中"**反转为"该命中"**，使**必须**按新裁定同步（否则它钉的是旧结论，恒红）。
 *     这不是放宽判据，是换了答案要量的事实：**.md → 全族可判型**。
 *   ⚠ **边界（如实登记）**：治法②的"无扩展名文档内容嗅探"**未实施**——全库实测 3 条无扩展名的
 *     在册交付物**全是 `ui`/`mcp` 的 URL 与目录路径**，`type='doc'` 的无扩展名者**为零**
 *     ⇒ 该兜底在本语料上**永不触发**，加它等于又多一条"说明书里有、机器里没有"的路。
 *     无扩展名但任务声明要产出的文档仍由**声明支**收人（该支与扩展名无关）。
 *
 * §M3 判据（F6b：进了门禁之后**按什么量**——判型补第三档 + `.sql` 词表补 DDL）——
 *   标本 A（该放行，真形夹具）· 标本 B（该拦，反向断言：放宽不得把垃圾也放进来）·
 *   标本 C（既有 document/code 尺不回归）· M3-D **正面**断言判型**恰好**是 `configuration` ·
 *   M3-S 接线（旧关键词尺零处残留 · 新尺一处定义 · 早退分支覆盖两档）· M3-Real 盘上真件佐证。
 *   ⚠ **方案外的一处就地裁定（可否决）**：方案 §M3 治法 3 只说「`archetype === 'code'` 早退分支不变」
 *     （其理由针对 `.sql`）。实施时把 `configuration` **一并**并入该早退支——理由是该分支的既有论证
 *     （"用文档判据的 LLM 去量非文档产出，既无意义又白耗一次旁路 LLM"）对配置文件**逐字适用**；
 *     若只接快检之后再交给文档判据的 LLM，等于刚把词表尺换成结构尺、又原样盖上一枚文档章。
 *     该变更**放宽** configuration 的放行面 ⇒ 反向断言见 M3-B。用户若认不妥，可只回退这一处。
 *
 * §M4 判据（F2："要么真回传、要么撤回承诺" ⇒ 本批取**撤回承诺**）——
 *   ⚠ 判据**不是**"文案长什么样"，而是"机器**有没有做**那件事"：承诺的兑现者 = 模型选型处读 `sdk_failed`。
 *   M4-0 **扫描器自证（两侧标本）**：同一把计数器，含词串计 1、不含词串计 0 ⇒ 下面的"0 处"是真的没有，
 *     不是扫描器坏了（承 `feedback_predicate_needs_both_sides_specimen`：只用一侧 ⇒ 恒 0 的坏扫描器也全票通过）。
 *   M4-A **派生事实**：`exec-model-select.ts` 读 `sdk_failed` **0 处**（它只读 `sdk_fallback`，那是"切备用 provider"）。
 *   M4-B **判据是条件式**（`maySayDowngraded(0)=false` / `(1)=true`）：改的是**当下的事实**，
 *     不是永久禁止某种说法——若将来真接了消费者，这条禁令自动解除。
 *   M4-C 无兑现者 ⇒ 两文件里"已降级 / 非 reasoning"**零处**（**去注释**面判：订正注释逐字引了旧文案）。
 *   M4-D **真相在场**（非只断言假话离场）：`[AI引擎失败]` 改说机器真做过的事。
 *   M4-E **单源**：`SDK_RETRY_RESUME_MSG` 一处定义、恰好两处引用（首轮入队 + resume 回队）。
 *   M4-F 两条互相打架的注释订正到同一句话（**原文**面断，因为订正注释本就该引旧文案）。
 *   ⚠ **实施中查得的同族读点（方案编辑清单之外，已登记方案 §3 M4）**：`ai-task.ts` 的 resume handler
 *     分支也写着"已降级/切换模型重试"——`executeTask` 返回 `sdkFailed:true` 有两条来路，没切模型的那条
 *     让该文案在一半情形里是空话 ⇒ 一并改用同一常量。
 *
 * §M5 判据（F7：世界模型审计"没做判定"不许冒充"发现了不一致"）——
 *   判据跑**真** `captureWorldSnapshot` + **真** `auditWorldConsistency`（不造等价入参、不调私有件）。
 *   M5-C1/C2 截断标志的**边界**（`>` 非 `>=`：恰 2000 为假、2001 为真；且 `fileCount` 仍是真总数）。
 *   M5-A0/B0 两只**标本自证**（各确认自己落在/不落在截断区，否则 A/B 段的断言会空转）。
 *   M5-A1 ★ **该不告警（本批靶心）**：大工作树截断 ⇒ checks 零 `[WARN]` 行；
 *   M5-A2/A3 **如实仍在场**：仍有一条 info 级说明 + **显式声明适用边界**（"仅覆盖字典序前 N 个路径"）；
 *   M5-A4 追加而非覆盖（既有 `[PASS]` 不动，且无任何增删字样）；M5-A5 info **不写会话行**。
 *   M5-B1 ★ **该告警仍告警（另一侧）**：真删 1 个 ⇒ 仍 `[WARN]` + 点名文件；B2 不混入 info；B3 会话行照旧。
 *   M5-S1…S4 静态接线：标记一处真源 · 两级各一落点 · 两处 `warns.length > 0` 把门 · 旧的无条件通道已撤。
 *   ⚠ **不放松 `compareSnapshots`**：它"截断即放弃增删判定"的**判定行为一字未动**（`zx_20260916_3 M3①`
 *     立下的、仍由 `rr_zx_20260916_1` §S5 (l) 钉着），本批只把**结论的去处**分级（warn / info）。
 *   ⚠ **renderer 是词表的第二个落点**：M5 新增 `[INFO]` 前缀 ⇒ `TaskDetailPage.tsx` 必须**显式**列一档，
 *     并把 `rr_zx_20260916_1` 那条"本轮不加新前缀值、故不新增 renderer 词表项"的断言**就地加固**为逐值钉住。
 *
 * §M7 判据（F9：内容门禁的**问句主语归位**——"量文件，就问文件"）——
 *   ⚠ 本批 rr **只判问句的形状**（确定性）：问句的主语是不是那份文件、题面这条路有没有被拆掉、
 *     "该类型应有的结构"是不是**查表**来的。**"LLM 在新问句下判得对不对" rr 判不了**（无模型）——
 *     诚实地留待实机（方案 §3 M7 完成情况"未做实机 E2E"），**不在此假装验过**。
 *   M7-A **主语是文件**（同判型同内容，问句随文件名走，两侧各自可证伪）·
 *   M7-B **旧问句形状零残留**（`任务: "<题面>"` 不在 prompt/system 里）·
 *   M7-C **结构上不可能再塞题面**（`buildSufficiencyPrompt` 形参恰 3 且无默认值 ⇒ 要喂题面必须改签名）·
 *   M7-D **那个入口已拆**（「属任务硬性要求」在去注释面零处）· M7-E/F **真话在场**（正面写明"就这份文件自身"、
 *   以及"任务级完成度不归它管"）· M7-G **应有结构由尺表派生**（`document`/`configuration` 两侧标签各不同）·
 *   M7-H **该拦仍拦 / 该放行的不落进 insufficient**（跑**真** `validateOutput` 三参新签名）·
 *   M7-I/J **两个调用点同形 + 为取题面而多查的库查询一并拆除** · M7-K **问句与定义各只有一处**。
 *   ⚠ **受波及的旧断言就地改钉（非放宽）**：`rr_zx_20260911_1` S1/S3 原钉的是
 *     "第三参传的是 `arch` 而不是 `archetype`"、"`llmSufficiencyCheck(..., taskDescription)` 照旧"——
 *     那两处钉的**正是本批要拆的形状**；现改为钉"根本不传题面"（更强，且各自可证伪）。
 *
 * ⚠ **标本纪律（承 `feedback_predicate_needs_both_sides_specimen`）**：
 *    F8-1（该放行）与 F8-4（该拦）**必须同时在场**——只用"该放行"⇒ 任何过宽的变体（比如恒 true）全票通过；
 *    只用"该拦"⇒ 任何过窄的变体（比如恒 false）全票通过。
 *    F8-2 是一只**反证标本**（旧判据的就地复刻），证明标本 A **确实会**触发旧病
 *    ⇒ 它是本案，而不是"新旧都不响、于是看不出差别"的空样本。
 * ⚠ **禁**：断言「消息文案里写了 98%」这种看字面的判据（文案改了并不代表机制修了，反之亦然）。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**（P6 取产物内 build 值本身，而非会被注释骗过的子串匹配）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { engineExecSideFiles, stripStepScopePrefix } from './lib/rr-engine-src.js';
// G-1：本轮判据引用的生产符号，**全部静态导入** ⇒ 被删/改名即编译期失败（而不是"扫了个空、静默假绿"）。
import {
  BUDGET_HARD_STOP_TOOLS,
  BUDGET_WARN_TOOLS,
  budgetBandOf,
  MIXED_SHELL_TOOLS,
  isExplorationCall,
  isExplorationToolAlways,
  countsTowardToolQuota,
  makeNonExplorationCappedTool,
  docValidationTargets,
  archetypeForFile,
  type ToolStubLike,
} from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { validateOutput, buildSufficiencyPrompt } from '../apps/worker-ant-desktop/src/main/core/output-validator.js';
import { BUDGET_BAND_CAP, budgetCapReached } from '../apps/worker-ant-desktop/src/main/core/step-budget.js';
import {
  SNAPSHOT_FILE_LIMIT, TRUNCATION_ISSUE_PREFIX,
  captureWorldSnapshot, compareSnapshots, auditWorldConsistency,
} from '../apps/worker-ant-desktop/src/main/core/world-snapshot.js';
import {
  toolRegistry, ExploreQuotaLedger, SHELL_EXPLORE_QUOTA, SHELL_EXPLORE_QUOTA_KEY,
} from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';

let pass = 0; let fail = 0; let pending = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ── 批次门（排期序：M6 最先，见文件头）──────────────────────────────────────
const ORDER = ['M6', 'M1', 'M2', 'M3', 'M4', 'M5', 'M7'] as const;
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
// zx_20261003 M8 就地改钉：`finalize_task` 的执行体已由 `tools/control.ts` 机械搬迁至
//   `tools/control-finalize.ts`（导出 `runFinalizeTask`）。本套件所有 `controlCode` 判据的本意都是
//   "**finalize 门内**那处实现/表达式"（`forcedByBudget` 与 `budgetCapReached` 同源、旧式残留零处、
//   `validateOutput` 调用恰一处、题面查询已拆），落点由 control.ts 变为搬迁体 ⇒ 扫描面随之指到新真源。
//   判据（"恰一处"/"零处"/表达式形状）一字未改——只改"finalize 门"这一侧的落点，非放宽。
const CONTROL_SRC = path.join(root, A, 'src/main/core/tools/control-finalize.ts');
const OV_SRC = path.join(root, A, 'src/main/core/output-validator.ts');
const AITASK_SRC = path.join(root, A, 'src/main/core/jobs/ai-task.ts');
const MSEL_SRC = path.join(root, A, 'src/main/core/exec-model-select.ts');
const WS_SRC = path.join(root, A, 'src/main/core/world-snapshot.ts');
/** 扫源码一律**去注释**：承 `zx_20260921_1`——"注释里写着有、代码里没被用上"正是要防的形态。 */
const strip = (p: string) => stripKeepingLines(fs.readFileSync(p, 'utf-8')).join('\n');

/**
 * zx_20260929 M9：`agent-executor.ts` 的**收尾段**整段外移到 `core/exec-close.ts`（只动形不动义）。
 * 凡扫描面**本意是"执行体这一侧的实现"**而落点只是当时的所在（D1 闸的 `prematureEnd` 表达式、
 * run_close 收口门那条 `validateOutput` 调用）的判据，须把面换成「执行体 ∪ `exec-*.ts`」——
 * 否则切到空、报成"某功能没接线"（读起来像真回归，实为扫描面没跟着走）。
 *
 * ⚠ **不含 `tools/*.ts`**：这批判据里"收口门"与"finalize 门"是**分别点到、各判一次"恰一处"**的
 *   （finalize 门另用 `controlCode`，M8 后即 `control-finalize.ts`）。整份换成含工具段的 `engineSrc()` 会把 finalize 门那处也计进来
 *   ⇒ 从"两侧各一处"退化成"合计 ≥1"，是**放宽**。故取 `engineExecSideFiles()`（并集**减**工具段，
 *   落点仍出自 `lib/rr-engine-src.ts` 一处真源）。
 */
// zx_20260929 M9: 再还原一层——步回调搬到 `core/exec-step.ts` 后段内绑定统一前置了 `d.`
//   （`d.totalTokensUsed` 等），本套件针脚写的是搬迁前的字面量。还原 ≠ 放宽（见 `stripStepScopePrefix`）。
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
 * 取出 `const <name> = <右值>;` 的右值（**按符号定位，不按行号**——行号是位置、会漂）。
 * 入参须是**已去注释**的源码。找不到返回空串（空串会让下游断言为假 ⇒ 红，而非静默绿）。
 */
function assignedExpr(code: string, decl: string): string {
  const i = code.indexOf(decl);
  if (i < 0) return '';
  const semi = code.indexOf(';', i);
  return semi < 0 ? '' : code.slice(i + decl.length, semi);
}

/**
 * 按**生产口径**把两把尺折成一个 band，造出 `context_json` 标本
 * （复刻 `agent-executor.ts` 预算追踪段的三行：`tokenBand`/`costBand` 各自 `budgetBandOf` 后取严）。
 *
 * ⚠ 这里**只复刻折算的三行**（摆夹具），判据本体（`budgetCapReached` / 名单集合）一律跑**生产真实现**；
 *   生产侧"确实这么折算"由 §G-2 的**源码结构断言**另行钉死。
 *   即：本函数**不是**判据的自我印证，它只摆夹具。
 */
function budgetCtxOf(tokenRatio: number, costRatio: number): Record<string, unknown> {
  const band = Math.max(budgetBandOf(tokenRatio), budgetBandOf(costRatio));
  return { budget_usage_ratio: tokenRatio, cost_usage_ratio: costRatio, budget_warn_band: band };
}

/**
 * ⚠ 旧判据的**就地复刻**——**仅作反证标本**：不是判据、不接入生产、任何生产码都不得引用它。
 *   唯一用途：证明标本 A **确实会**触发旧病（⇒ 标本就是本案，不是"恒不触发的空样本"，
 *   也不是"新旧都不响、于是看不出差别"的那种浪费样本）。
 *   逐字复刻 `zx_20260922_1 M6` 修复前 `tools/control.ts` 的 `forcedByBudget`。
 */
const legacyForcedByBudget = (ctx: { budget_usage_ratio?: unknown }): boolean =>
  Number(ctx.budget_usage_ratio || 0) >= 0.95;

async function main(): Promise<void> {
  const execCode = strip(EXEC_SRC);
  const controlCode = strip(CONTROL_SRC);
  const ovCode = strip(OV_SRC);
  // ⚠ 「代码里有没有假话」一律在**去注释**的源码上判：本批的订正**注释里逐字引用了旧文案**
  //   （不引就说不清订正了什么），若拿原文判"假话不在场"，判据会被自己的订正注释判红
  //   （承 auto-memory `feedback_...`：负面子串断言须落在去注释面，真相在场类断言才落原文）。
  const aiTaskCode = strip(AITASK_SRC);
  const mselCode = strip(MSEL_SRC);
  const aiTaskRaw = fs.readFileSync(AITASK_SRC, 'utf-8');
  const execRaw = fs.readFileSync(EXEC_SRC, 'utf-8');
  // 扫描面规模（**行数**）——「零处 / 恰好一处」类断言的**自证**，够多个批次共用故提到这里（承 `zx_20260920_1 §G-1`）。
  const execLines = stripKeepingLines(fs.readFileSync(EXEC_SRC, 'utf-8')).length;
  const controlLines = stripKeepingLines(fs.readFileSync(CONTROL_SRC, 'utf-8')).length;

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【G】不变式门（与批次无关）');
  {
    // ── G-1 真源在位 ────────────────────────────────────────────────────────
    ok(typeof budgetCapReached === 'function' && Number.isInteger(BUDGET_BAND_CAP),
      'G-1 真源在位：`budgetCapReached` 可调用且 `BUDGET_BAND_CAP` 为整数（静态 import ⇒ 改名即编译期失败）',
      `BUDGET_BAND_CAP=${BUDGET_BAND_CAP}`);
    ok(Array.isArray(BUDGET_HARD_STOP_TOOLS) && BUDGET_HARD_STOP_TOOLS.length > 0
      && Array.isArray(BUDGET_WARN_TOOLS) && BUDGET_WARN_TOOLS.length >= BUDGET_HARD_STOP_TOOLS.length,
      'G-1 真源在位：两份工具名单均为非空数组，且 95% 档 ≥ 98% 档（后者是前者的子集语义）',
      `硬限 ${BUDGET_HARD_STOP_TOOLS.length} 项 / 预警 ${BUDGET_WARN_TOOLS.length} 项`);
    ok(typeof budgetBandOf === 'function' && budgetBandOf(0.98) === 5 && budgetBandOf(0.95) === 4 && budgetBandOf(0.3) === 1,
      'G-1 真源在位：`budgetBandOf` 档位边界如旧（0.98→5 / 0.95→4 / 0.3→1）——标本折算依赖它',
      '');
    // 判据本体不自我印证：折算三行必须在**生产源码**里确实存在
    // ⚠ zx_20260929 M9：这一行在**步回调内**，已随 `onStepFinish` 闭包搬入 `core/exec-step.ts`。
    //   面取「执行体 ∪ `exec-*.ts`」（`lib/rr-engine-src.ts` 一处真源）；裸读执行体文件会把搬走的实现扫成
    //   0 处，形状与"真回归"无异——那是扫描面没跟着走，不是机制丢了。`band/tokenBand/costBand` 均为
    //   步内局部 `const`（非 `StepScope` 成员）⇒ 无 `d.` 前缀，`stripStepScopePrefix` 对这条针脚无影响。
    ok(countOcc(execSideCode, 'const band = Math.max(tokenBand, costBand);') === 1,
      'G-1 生产侧确实按 `Math.max(tokenBand, costBand)` 取严（夹具只是复刻这一行）',
      `实测 ${countOcc(execSideCode, 'const band = Math.max(tokenBand, costBand);')} 处（执行体侧 ${execSideLines} 行）`);

    // ── G-2 扫描面自证 ──────────────────────────────────────────────────────
    ok(execLines > 1000 && controlLines > 100,
      'G-2 扫描面自证：两个被扫文件均读到足量行（防"文件没读到 ⇒ 零处违规恒真"）',
      `agent-executor ${execLines} 行 / tools/control-finalize ${controlLines} 行`);

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
    const probeHit = scan(`crit('M6', tag === '${ROUND}', 'x')`);
    const probeMiss = scan(`planPath = 'plans/improve/' + ROUND + '.md';\nif (ROUND >= DERIVED) {}`);
    ok(ROUND.length > 0 && probeHit.length === 1 && probeMiss.length === 0 && selfHits.length === 0,
      'G-3 本脚本**零处**轮次等值字面量（哑雷）；扫描器**两只标本都试过**：写死轮次的串必被抓到、'
      + '派生比较与方案路径必被放过',
      `轮次由 \`path.basename(__filename)\` 派生=${ROUND} · 命中 ${selfHits.length} 处 · `
      + `该命中标本 ${probeHit.length}/1 · 该不命中标本 ${probeMiss.length}/0`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M6·F8】「预算爆没爆」——放行侧与禁用侧读同一个 `band`');
  {
    // ── 标本 A（该放行，修复前必红）：真库 `a290ae2b` 终局快照的**原值** ──────
    const specA = budgetCtxOf(0.1404195, 1.093815);
    crit('M6', specA.budget_warn_band === 5,
      'F8-a 标本自证：费用尺 109% 而 Token 尺 14% ⇒ 生产折算得 band 5（正是"费用/Token 两把尺读数背离"的病态）',
      `band=${specA.budget_warn_band}`);
    crit('M6', budgetCapReached(specA) === true,
      'F8-1 **标本 A 该放行**：费用尺爆表 ⇒ `budgetCapReached` 为真（finalize 门不再无理由拦住）',
      `budgetCapReached=${budgetCapReached(specA)} / BUDGET_BAND_CAP=${BUDGET_BAND_CAP}`);
    crit('M6', legacyForcedByBudget(specA) === false,
      'F8-2 **反证标本**：同一条 `context_json` 喂**旧判据**（就地复刻 `budget_usage_ratio >= 0.95`）得假 ⇒ '
      + '标本确实踩中本病的旧路（不是"新旧都不响"的空样本）',
      `旧式=${legacyForcedByBudget(specA)}`);
    // 07:13:45 的**首次**宣告那一档（费用 95%，Token 仍未到）——夹死的起点，须同为真
    const specA2 = budgetCtxOf(0.20, 0.96);
    crit('M6', specA2.budget_warn_band === 4 && budgetCapReached(specA2) === true && legacyForcedByBudget(specA2) === false,
      'F8-3 标本 A′（费用 96% / Token 20%）：band 4 = 系统**首次**宣告「预算超限」的那一档，'
      + '亦须放行 ⇒ 判据取的是首档而非等到 98%（放行是为了**解开死结**，不是为了等到更晚）',
      `band=${specA2.budget_warn_band} / 新式=${budgetCapReached(specA2)} / 旧式=${legacyForcedByBudget(specA2)}`);

    // ── 标本 B（该拦，反证不得过宽）────────────────────────────────────────
    const specB = budgetCtxOf(0.3, 0.3);
    crit('M6', budgetCapReached(specB) === false,
      'F8-4 **标本 B 该拦**：两把尺都 30% ⇒ `budgetCapReached` 为假（预算没到顶就不许放行，'
      + '收口门禁照常生效）——这条挡住"把判据改成恒真"的过宽变体',
      `band=${specB.budget_warn_band} / budgetCapReached=${budgetCapReached(specB)}`);

    // ── 档位边界（反面标本带）──────────────────────────────────────────────
    const band3 = budgetCtxOf(0.80, 0.10);
    crit('M6', band3.budget_warn_band === 3 && budgetCapReached(band3) === false,
      'F8-5 边界：band 3（75% 档）**不得**放行——判据的槛在 4，不是"任意非 1 档"',
      `band=${band3.budget_warn_band}`);
    const band4 = budgetCtxOf(0.95, 0.0);
    crit('M6', band4.budget_warn_band === 4 && budgetCapReached(band4) === true,
      'F8-6 边界：Token 尺恰 0.95 ⇒ band 4 ⇒ 放行（与旧式 `>= 0.95` 在边界上逐点一致）', '');
    // 畸形入参须退化为"不认账"，不得抛错也不得误判为到顶
    crit('M6', budgetCapReached(undefined) === false && budgetCapReached({}) === false
      && budgetCapReached({ budget_warn_band: NaN }) === false && budgetCapReached({ budget_warn_band: 0 }) === false,
      'F8-7 畸形/缺失入参如实退化：`undefined` / `{}` / `NaN` / `0` 一律读作"未到顶"（不得误判、不得抛错）',
      '');
    // ── 严格超集（"没有任何一处原先放行的收口现在会变得不放行"的机械证据）──────
    const oldTrue = [0.95, 0.96, 0.98, 1.0, 2.096];
    const kept = oldTrue.every((r) => {
      const ctx = budgetCtxOf(r, 0);
      return legacyForcedByBudget(ctx) === true && budgetCapReached(ctx) === true;
    });
    crit('M6', kept,
      'F8-8 **严格超集**：凡旧式为真的 Token 比（0.95/0.96/0.98/1.0/2.096）如今**一律仍为真** ⇒ '
      + '本轮只新增放行（费用尺先到顶这一病态情形），没有任何一处原先放行的收口被改得不放行',
      `逐点核过 ${oldTrue.length} 个比值`);

    // ── 两处同源（**结构**断言：只断行为等于只治一半）───────────────────────
    // ⚠ zx_20260929 M9：D1 闸所在的收尾段已整段外移到 `core/exec-close.ts` ⇒ 本条的**本意是
    //   "执行体这一侧的那处表达式"**、落点只是当时的所在，扫描面随之换成 `execSideCode`（并集**减**工具段；
    //   若仍只扫 `agent-executor.ts` 会切到空串 ⇒ `includes` 恒假，报成"没改读同一真源"的假红）。
    const preEndExpr = assignedExpr(execSideCode, 'const prematureEnd =');
    crit('M6', preEndExpr.includes('budgetCapReached(') && !preEndExpr.includes('budget_usage_ratio'),
      'F8-9a D1 闸的 `prematureEnd` 表达式已**改为读同一真源**（含 `budgetCapReached(`、不含 `budget_usage_ratio`）'
      + '——行为断言只覆盖"函数返回什么"，这条覆盖"生产确实调了它"（扫描面=执行体侧，不含工具段）',
      preEndExpr.trim().slice(0, 120));
    const forcedExpr = assignedExpr(controlCode, 'const forcedByBudget =');
    crit('M6', forcedExpr.includes('budgetCapReached(') && !forcedExpr.includes('budget_usage_ratio'),
      'F8-9b `tools/control-finalize.ts`（M8 就地改钉：finalize 执行体所在）的 `forcedByBudget` 表达式同上（**放行侧两处同源**，不是改了一处漏一处）',
      forcedExpr.trim().slice(0, 120));
    const wasPremExpr = assignedExpr(execCode, 'const wasPremature =');
    crit('M6', wasPremExpr.includes('budgetCapReached(') && !wasPremExpr.includes('budgetTokens * 0.95'),
      'F8-9c 评分侧 `wasPremature`（`assessCompletionQuality`）同上——否则费用尺爆表被迫收尾的回合'
      + '照拿"非过早结束"的 10 分（表四之外的同族读点，实施中查得）',
      wasPremExpr.trim().slice(0, 120));

    // ── 旧式表达式在**代码**里零处残留（注释引用不算）──────────────────────
    // ⚠ zx_20260929 M9：本条的**本意是"这套旧式表达式在执行体一侧零残留"**（旧式可复现的位置随实现走：
    //   D1 闸已外移到 `exec-close.ts`）⇒ 扫描面取执行体侧（并集**减**工具段，只许更严）。
    const staleInExec = countOcc(execSideCode, 'budget_usage_ratio >= 0.95')
      + countOcc(execSideCode, 'Number(ctxJson.budget_usage_ratio');
    const staleInControl = countOcc(controlCode, 'budget_usage_ratio >= 0.95')
      + countOcc(controlCode, 'Number(ctxJson.budget_usage_ratio');
    crit('M6', staleInExec === 0 && staleInControl === 0,
      'F8-9d 旧式「单读 Token 尺判到没到顶」在执行体一侧与 finalize 门内**零处**残留'
      + '（"新判据写了、旧表达式还留着"正是要防的；执行体侧=执行体∪`exec-*.ts`，不含工具段；'
      + 'finalize 门 M8 就地改钉 ⇒ 面为 `control-finalize.ts`）',
      `执行体侧 ${staleInExec} 处 / tools/control-finalize ${staleInControl} 处（扫描面 ${execSideLines}+${controlCode.split('\n').length} 行）`);

    // ── 真源**只写一处** ────────────────────────────────────────────────────
    // ⚠ 同上：写成"执行体一侧恰好一处"（面随实现走，仍只许更严——判据是"恰好 1"）。实测仅 `agent-executor.ts` 那处。
    crit('M6', countOcc(execSideCode, 'ctxJson.budget_warn_band = band;') === 1,
      'F8-9e `budget_warn_band` 在执行体一侧的**代码**里恰好写 1 处（"预算到没到顶"只有这一个算出并写回的地方）',
      `实测 ${countOcc(execSideCode, 'ctxJson.budget_warn_band = band;')} 处（执行体侧 ${execSideLines} 行）`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M6·F10】硬限白名单：求助通道不得被预算闸亲手关掉');
  {
    const has = (list: readonly string[], t: string): boolean => list.includes(t);
    const specC = {
      hard: has(BUDGET_HARD_STOP_TOOLS, 'escalate_to_human'),
      warn: has(BUDGET_WARN_TOOLS, 'escalate_to_human'),
    };
    crit('M6', specC.hard && specC.warn,
      'F10-1 **标本 C 该命中**：`escalate_to_human` 在 98% 档与 95% 档**两档白名单都在册**'
      + '（它不读不写不耗上下文，与"禁读禁执行防上下文膨胀"的初衷不冲突；而硬上限正是最需要求助的一刻）',
      `硬限=${specC.hard} / 预警=${specC.warn}`);

    // 标本 D（该不命中，反证）：否则"把白名单塞满"就能骗过标本 C
    const heavy = ['read_file', 'execute_command', 'bash'];
    const stillWarn = heavy.every((t) => has(BUDGET_WARN_TOOLS, t));
    const notHard = heavy.every((t) => !has(BUDGET_HARD_STOP_TOOLS, t));
    crit('M6', stillWarn && notHard,
      'F10-2 **标本 D 该不命中**：`read_file`/`bash`/`execute_command` 在 95% 档**仍保留**、'
      + '在 98% 档**仍被禁** ⇒ 白名单没有被"塞满"成什么都放行',
      `95%档在册=${stillWarn} / 98%档被禁=${notHard}`);
    crit('M6', has(BUDGET_WARN_TOOLS, 'edit_file') && !has(BUDGET_HARD_STOP_TOOLS, 'edit_file'),
      'F10-3 95%/98% 的分界仍在 `edit_file` 上（95% 允许完成当前原子改动、98% 真禁）——'
      + '这正是两档名单**刻意不同**的唯一理由，不得合并',
      '');

    // ── 接线：两个分支各自读**导出的真名单**，且不再内联字面量 ──────────────
    // zx_20260929 M9：两处消费点（`OUTPUT_ONLY_TOOLS`）随步回调搬入 `core/exec-step.ts` ⇒ 面换并集。
    //   `BUDGET_*_TOOLS` 是模块级常量而非 `StepScope` 成员 ⇒ 无 `d.` 可还原，针脚字面量原样可比。
    const wiredHard = countOcc(execSideCode, 'new Set<string>(BUDGET_HARD_STOP_TOOLS)');
    const wiredWarn = countOcc(execSideCode, 'new Set<string>(BUDGET_WARN_TOOLS)');
    crit('M6', wiredHard === 1 && wiredWarn === 1,
      'F10-4 接线在册：98% 分支与 95% 分支各读**导出的**真名单（`new Set<string>(BUDGET_*_TOOLS)` 各 1 处）'
      + '——若生产另抄一份内联数组，本脚本跑的名单就只是"判据的自我印证"',
      `硬限 ${wiredHard} 处 / 预警 ${wiredWarn} 处`);

    // 挂账 G：文案里 `edit_file` 重复（真库原文 `… execute_command, bash, edit_file。` 出现两次）
    const stamp = execSideCode.match(/insertBudgetMsg\(`\[预算超限\][^`]*`\)/g) ?? [];
    const dupPush = countOcc(execSideCode, "[...removed, 'edit_file']");
    crit('M6', dupPush === 0 && countOcc(execSideCode, "!removed.includes('edit_file')") === 1,
      'F10-5 挂账 G：`[...removed, \'edit_file\']` **零处**（不再把同一名字拼第二遍）；'
      + '改由 `!removed.includes(\'edit_file\')` 去重后**只补名单**'
      + '（M9：该段随步回调搬入 `core/exec-step.ts`，面取执行体侧；`removed` 是步内局部量 ⇒ 无 `d.` 前缀）',
      `旧写法 ${dupPush} 处 / 去重写法 ${countOcc(execSideCode, "!removed.includes('edit_file')")} 处 / 该段文案 ${stamp.length} 条`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1·F3】两闸同尺：A3 硬线按 `MIXED_SHELL_TOOLS` 分流，收尾命令不再陪葬');
  {
    // ── 夹具自证：真账本 + 真配额对象，走到硬线（阈值由真对象派生，不写死 20）────
    const ledger = new ExploreQuotaLedger();
    const c0 = ledger.count(SHELL_EXPLORE_QUOTA_KEY);
    for (let i = 0; i < SHELL_EXPLORE_QUOTA.hard - 1; i++) ledger.add(SHELL_EXPLORE_QUOTA_KEY);
    const notYet = ledger.gate(SHELL_EXPLORE_QUOTA_KEY, SHELL_EXPLORE_QUOTA);
    ledger.add(SHELL_EXPLORE_QUOTA_KEY);
    const atLine = ledger.gate(SHELL_EXPLORE_QUOTA_KEY, SHELL_EXPLORE_QUOTA);
    crit('M1', c0 === 0 && !notYet.hard && atLine.hard,
      'M1-0 夹具自证：真账本 + 真配额对象走到硬线（`hard-1` 不触发、`hard` 触发）'
      + '——下面四条标本确实处在"A3 硬线已开"那一刻，不是没碰线的空跑',
      `hard=${SHELL_EXPLORE_QUOTA.hard} · ${SHELL_EXPLORE_QUOTA.hard - 1} 次 hard=${notYet.hard} · ${SHELL_EXPLORE_QUOTA.hard} 次 hard=${atLine.hard}`);

    // ── 造出"A3 硬线处置后"的工具：**真 `makeNonExplorationCappedTool`**，与生产同一手法 ──
    //   （`wrap` 缓存按工具名各包一次，共享同一个 `original` ⇒ `seen` 是"真被委托过几次"的一本账）
    const seen: string[] = [];
    const original: ToolStubLike = {
      description: '混合类 shell（`bash`/`execute_command` 同形）',
      parameters: {},
      execute: (args: unknown): string => {
        const c = String((args as { command?: string }).command ?? '');
        seen.push(c);
        return `RAN:${c}`;
      },
    };
    const wrap = (toolName: string): ToolStubLike => makeNonExplorationCappedTool(toolName, original,
      `本次调用属**探索类**（目录/文件枚举、只读探测），已因探索配额耗尽(${SHELL_EXPLORE_QUOTA.hard}次)拒绝。`
      + `⚠ 这是对**该次调用**的拒绝，**不是**${toolName} 被禁用——${toolName} 仍可用，收尾命令照常放行。`);
    const call = async (toolName: string, command: string): Promise<string> => String(await wrap(toolName).execute({ command }));
    const isRefusal = (s: string): boolean => {
      try { return typeof (JSON.parse(s) as { error?: string }).error === 'string'; } catch { return false; }
    };

    // ── 标本 A（该不命中·**本批靶心**）：越线后的收尾命令必须照常执行 ────────────
    const mvnBash = await call('bash', 'mvn -v');
    const gitBash = await call('bash', 'git status');
    crit('M1', !isRefusal(mvnBash) && !isRefusal(gitBash),
      'M1-A **标本 A（该不命中）**：越线后 `bash` 跑 `mvn -v` / `git status` ⇒ **执行成功**'
      + '——修复前这两条与工具本身一起被拉黑，正是第二只标本那 6 次收尾命令被弹回的形态',
      `mvn -v → ${mvnBash.slice(0, 20)} / git status → ${gitBash.slice(0, 20)}`);

    // ── 标本 B（该命中）：探索调用被拒 ───────────────────────────────────────
    const lsRej = await call('bash', 'ls -la');
    const findRej = await call('bash', 'find . -name "*.ts"');
    crit('M1', isRefusal(lsRej) && isRefusal(findRej),
      'M1-B **标本 B（该命中）**：越线后 `ls` / `find` ⇒ **被拒**（闸门没被削成"恒放行"）',
      `ls -la → 拒=${isRefusal(lsRej)} / find → 拒=${isRefusal(findRej)}`);

    // ── 标本 A′（**顺带裁定取 a 的靶心**）：`execute_command` 侧必须同尺 ────────
    const mvnExec = await call('execute_command', 'mvn -v');
    const lsExecRej = await call('execute_command', 'ls -la');
    crit('M1', !isRefusal(mvnExec) && isRefusal(lsExecRej),
      'M1-A′ **顺带裁定（取 a）靶心**：越线后 `execute_command` 与 `bash` **同尺**——`mvn -v` 放行、`ls -la` 被拒。'
      + '修复前两尺对 `execute_command` 分家：`ls` 判"非探索"**照放**（换把 shell 即绕过闸门），'
      + '`py_compile` 反被当成探索**拒掉**',
      `mvn -v → 拒=${isRefusal(mvnExec)} / ls -la → 拒=${isRefusal(lsExecRej)}`);

    // ── 机制反证（**不是**看字面）：拒的没到原实现、放的确实到了 ────────────────
    crit('M1', seen.length === 3 && seen.includes('mvn -v') && seen.includes('git status')
      && !seen.some((c) => /^(ls|find)\b/.test(c)),
      'M1-G 反证（机制而非字面）：被拒的探索调用**一次也没到达原实现**，放行的三条**确已到达**'
      + '——"没报错"不算数，须原实现自己记的账作证',
      `到达原实现 ${seen.length} 条：[${seen.join(' | ')}]`);

    // ── 标本 C（**正面计数**）：真账本"由 0 变 1"，且收尾命令不吃额度 ─────────────
    const l2 = new ExploreQuotaLedger();
    const z0 = l2.count(SHELL_EXPLORE_QUOTA_KEY);
    l2.add(SHELL_EXPLORE_QUOTA_KEY);                       // 一次探索调用
    const z1 = l2.count(SHELL_EXPLORE_QUOTA_KEY);
    const eatsWrapUp = countsTowardToolQuota('bash', { command: 'mvn -v' });
    const eatsExplore = countsTowardToolQuota('bash', { command: 'ls -la' });
    crit('M1', z0 === 0 && z1 === 1 && eatsWrapUp === false && eatsExplore === true,
      'M1-C **标本 C（正面计数）**：一次探索调用 ⇒ 真账本**由 0 变 1**；`mvn -v` **不**吃额度、`ls -la` 吃'
      + '——"收尾命令不吃额度"是正面断言，不是"没抛异常"',
      `0→${z1} · mvn -v eats=${eatsWrapUp} · ls -la eats=${eatsExplore}`);

    // ── 两把 shell 同判（顺带裁定的正面陈述）──────────────────────────────────
    const PARITY_CMDS = ['ls -la', 'find . -name x', 'git commit -m x', 'mvn -v', 'npm run build'];
    const parity = PARITY_CMDS.every((c) => isExplorationCall('bash', { command: c }) === isExplorationCall('execute_command', { command: c }));
    crit('M1', parity && isExplorationCall('execute_command', { command: 'ls -la' }) === true
      && isExplorationCall('execute_command', { command: 'python3 -m py_compile a.py' }) === true
      && isExplorationCall('execute_command', { command: 'git commit -m x' }) === false,
      'M1-F **顺带裁定（取 a）**：两把 shell **同判**（5 条命令逐条比对）——`ls` 算探索、收尾命令不算；'
      + '而**循环豁免那一支一字未动**（`py_compile` 仍算探索 = `zx_20260917 M5b` 明示保留的代价，'
      + '`rr_zx_20260917` 的同一条断言仍绿）',
      `5 条命令两工具同判=${parity}`);

    // ── 真源核对：这本账的同账工具**全部**属混合类 ⇒ 到硬线一个也不进 `disabledTools` ──
    const shellPeers = [...toolRegistry.quotaKeyPeers('bash')].sort();
    const webPeers = [...toolRegistry.quotaKeyPeers('search_web')].sort();
    crit('M1', shellPeers.join(',') === 'bash,execute_command' && shellPeers.every((k) => MIXED_SHELL_TOOLS.has(k))
      && shellPeers.every((k) => !isExplorationToolAlways(k)) && webPeers.join(',') === 'search_web'
      && isExplorationToolAlways('search_web'),
      'M1-J 真源核对：`shell_explore` 这本账的同账工具**全部**属混合类 ⇒ 到硬线**一个也不进 `disabledTools`**'
      + '（只逐调用收窄）；而 `search_web` 那本账仍是纯探索 ⇒ **整工具禁**的既有行为一字未变',
      `shell 同账=[${shellPeers.join(' / ')}] · search_web 同账=[${webPeers.join(' / ')}]`);

    // ── 接线（结构断言：行为断言只覆盖"函数返回什么"，这条覆盖"生产确实这么分流"）──
    // zx_20260929 M9：A3 硬线那一整块（`if (action.hard) {` → `const cmdN = d.exploreCmdN;`）随步回调
    //   搬入 `core/exec-step.ts` ⇒ 面换执行体侧。否则 `iHard = -1`、`hardBlk = ''`，
    //   本组三条断言**全部退化为空串上的恒真**（M1-D″ 会在空串上"零处命中"假绿）。切块两端锚点均为
    //   步内局部量（`cmdN`）⇒ `stripStepScopePrefix` 还原后与搬迁前字面量一致。
    const iHard = execSideCode.indexOf('if (action.hard) {');
    const iD3 = execSideCode.indexOf('const cmdN = exploreCmdN;', iHard);
    const hardBlk = iHard < 0 ? '' : execSideCode.slice(iHard, iD3 > iHard ? iD3 : iHard + 2000);
    crit('M1', hardBlk.includes('MIXED_SHELL_TOOLS.has(k)') && hardBlk.includes('disabledTools.add(k)')
      && hardBlk.includes('cappedTools.add(k)') && hardBlk.includes('makeNonExplorationCappedTool('),
      'M1-D 接线：A3 硬线按 `MIXED_SHELL_TOOLS` **分流**——纯探索一路进 `disabledTools`、'
      + '混合类一路进 `cappedTools` 并包成逐调用桩（与 D3 同一手法，两闸自此同尺）',
      `块内 ${hardBlk.split('\n').length} 行（按符号切：\`if (action.hard) {\` → \`const cmdN = exploreCmdN;\`）`);
    crit('M1', countOcc(hardBlk, 'disabledTools.add(') === 1 && countOcc(hardBlk, 'cappedTools.add(') === 1,
      'M1-D′ 且两个集合**各写一处**——防"混合类顺手也进了 `disabledTools`"的半修'
      + '（那会把"收尾照常"谎报成"整个工具没了"，且预算档位等按它分支的判断会跟着误判）',
      `disabledTools.add ${countOcc(hardBlk, 'disabledTools.add(')} 处 / cappedTools.add ${countOcc(hardBlk, 'cappedTools.add(')} 处`);
    crit('M1', countOcc(hardBlk, "'bash'") === 0 && countOcc(hardBlk, "'execute_command'") === 0,
      'M1-D″ 块内**零处**工具名字面量——分流判据复用 `MIXED_SHELL_TOOLS` 这个唯一列举'
      + '（防 D3 那条教训重演：尺一与尺二各抄一份，就还会再分家）',
      `'bash' ${countOcc(hardBlk, "'bash'")} 处 / 'execute_command' ${countOcc(hardBlk, "'execute_command'")} 处`);

    // ── 文案与机器同话（**辅助**：机制由 M1-A/B/A′/C/G/D 把守，此处只证"没在说反话"）──
    crit('M1', /收尾命令照常放行/.test(lsRej) && lsRej.includes('bash'),
      'M1-H 被拒正文**自带出路**：明说"拒的是**本次调用**、收尾命令照常放行"'
      + '（断言**真相在场**，不写"断言某句谎言不在场"——后者会被订正注释自己判红）',
      lsRej.slice(0, 76));
    crit('M1', SHELL_EXPLORE_QUOTA.hardMsg.includes('收尾命令照常放行') && SHELL_EXPLORE_QUOTA.hardMsg.includes('探索类命令')
      && SHELL_EXPLORE_QUOTA.hardMsg.includes('收尾命令不计入'),
      'M1-I 文案与机器同话：`hardMsg` 说的是"探索类调用将被拒绝（收尾命令照常放行）"，'
      + '不再是"两者一并禁用"（**辅助**断言：断言真话在场，非断言假话离场）',
      '');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M2·F6a】内容门禁的**成员资格**：按产物本身（扩展名）收人，不看登记标签');
  {
    // 夹具：**真文件落盘** + 真 `wa_deliverables` 表 ⇒ 判据跑生产真实现 `docValidationTargets`。
    // （承 `feedback_predicate_needs_both_sides_specimen`：四只标本一起上，含"标签说不、产物说是"的反向标本。）
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rr221-m2-ws-'));
    const write = (rel: string, body: string): void => {
      const abs = path.join(ws, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    };

    // ── 标本 A 组：活标本 `a290ae2b` 真库里那 **9 个业务文件**的**同名同形**复刻（全部登记 `type='doc'`）──
    const biz: string[] = [
      'pom.xml',
      'erp/pom.xml',
      'openapi/pom.xml',
      '参考项目/example-suite/payment/pom.xml',
      '参考项目/example-suite/payment/yeepay-support/pom.xml',
      '参考项目/example-suite/payment/yeepay/pom.xml',
      'openapi/src/main/resources/application.properties',
      'openapi/src/main/resources/config/yop_sdk_config_default.json.example',
      'manager/src/main/resources/sql/mysql/V1.0.1__order-payment.sql',
    ];
    for (const rel of biz) write(rel, `<${path.basename(rel)} 的真实内容>\n`);
    // 另加一份 `.java`——活标本里这类共 32 份，同样全登记 `doc`（一并覆盖"代码文件被当文档量"）
    const javaRel = 'manager/src/main/java/com/example/app/order/entity/OrderEntity.java';
    write(javaRel, 'package com.example.app.order.entity;\npublic class OrderEntity {}\n');

    // ── 标本 B / B′：真文档（.md）。B 登记 `doc`；**B′ 登记 `code`** —— 证明标签**不是反方向的筛子** ──
    const docRel = '设计说明.md';
    const docRelMislabeled = '未登记的说明.md';
    write(docRel, '# 设计说明\n\n本文件说明……\n');
    write(docRelMislabeled, '# 另一份说明\n\n正文……\n');

    // ── 标本 C：**声明产出**这一支（任务文本里"写入 xxx"）—— 落盘的进集、没落盘的不进集 ──
    const declaredLanded = 'report.md';
    const declaredMissing = 'missing.md';
    write(declaredLanded, '# 报告\n\n结论……\n');

    // ── 标本 D：**新放开的族**（M1/K-6 加宽）与**刻意仍出局者**——两侧都要上（只用"该命中"侧 ⇒ 过宽变体全票通过）──
    //   D-1 `.pdf`/`.mp4`：族可判型 ⇒ 应进集（PDF 抽正文走文档腿 / 音视频走形态核验）
    //   D-2 `.txt`：族分不开"人写的说明"与"机器写的构建报告" ⇒ 按裁定 T3 **仍出局**
    //   D-3 `_probe/_tmp_scan.md`：**族可判型（.md）但探针噪声** ⇒ 被 `docNotProbe` 挡（证两闸是**与**关系）
    //   D-4 `.png`：族不可判型（图片无内容校验路）⇒ 出局
    const pdfRel = '交付报告.pdf';
    const mediaRel = '演示.mp4';
    const txtRel = '构建报告.txt';
    const probeRel = '_probe/_tmp_scan.md';
    const imgRel = '架构图.png';
    write(pdfRel, '%PDF-1.4\n% 成员资格只看路径，不真解析\n');
    write(mediaRel, '\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom');
    write(txtRel, '构建：成功\n');
    write(probeRel, '# 探针\n\n清扫记录……\n');
    write(imgRel, '\x89PNG\r\n\x1a\n');

    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, acceptance_criteria TEXT)');
    // ⚠ 夹具按**生产 DDL**（`database.ts` 的 `wa_deliverables`）搭：`docNotProbe()` 读 `COALESCE(file_path, name)`，
    //   少了 `name` 列会让取数 SQL 抛 `no such column: name`、被 `docValidationTargets` 的 try/catch 吞掉
    //   ⇒ **已注册交付物那一支整支静默为空**、断言假绿。（承 auto-memory `feedback_rr_fixture_production_order`：
    //   夹具比生产宽松，断言就只是在自我印证。）
    db.exec("CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, file_path TEXT, name TEXT DEFAULT '', type TEXT)");
    db.prepare('INSERT INTO wa_tasks (id, title, description, acceptance_criteria) VALUES (?,?,?,?)')
      .run('T1', '实施后端方案', `把结论写入 ${declaredLanded}，把风险写入 ${declaredMissing}`, '');
    const ins = db.prepare('INSERT INTO wa_deliverables (id, task_id, file_path, type) VALUES (?,?,?,?)');
    let seq = 0;
    for (const rel of [...biz, javaRel]) ins.run(`d${seq++}`, 'T1', rel, 'doc');   // 全部登记 doc（照执行体办事的样子）
    ins.run('dB', 'T1', docRel, 'doc');
    ins.run('dB2', 'T1', docRelMislabeled, 'code');                                // 标签说"不是文档"
    ins.run('dC', 'T1', 'ghost.md', 'doc');                                        // 在册但**盘上无此文件**
    ins.run('dD1', 'T1', pdfRel, 'doc');
    ins.run('dD2', 'T1', mediaRel, 'doc');
    ins.run('dD3', 'T1', txtRel, 'doc');
    ins.run('dD4', 'T1', probeRel, 'doc');
    ins.run('dD5', 'T1', imgRel, 'doc');

    const targets = docValidationTargets(db as never, 'T1', ws);
    const rel = targets.map((p) => path.relative(ws, p).split(path.sep).join('/'));

    // ── 该命中侧：族可判型 ──
    crit('M2', biz.every((r) => rel.includes(r)),
      'M2-A **标本 A（K-6 加宽后的该命中侧）**：活标本那 9 个业务文件（pom.xml×6 / .properties / .json.example / .sql）'
      + '**族可判型**（configuration/code）⇒ 现在**进集**（旧尺只收 .md，把它们全挡在门外；M1/K-6 打开）',
      `进集 ${rel.length} 项：${rel.join(' · ')}`);
    crit('M2', rel.includes(javaRel),
      'M2-A′ `.java`（`CODE_ARTIFACT_EXTS` 族）同样进集——登记标签 `doc` 与它无关', '');
    crit('M2', rel.includes(docRel),
      'M2-B **标本 B（该命中）**：真文档 `设计说明.md`（登记 `doc`）⇒ **进集**（闸门没被削成恒空集）',
      `进集 ${rel.length} 项`);
    crit('M2', rel.includes(docRelMislabeled),
      'M2-B′ **标签说不、产物说是**：`未登记的说明.md` 登记的是 `type=\'code\'`，照样**进集**'
      + ' ⇒ 登记标签在**两个方向**上都不是筛子（只在"该收"侧验会放过"照标签收人"的变体）',
      '');
    crit('M2', rel.includes(declaredLanded) && !rel.includes(declaredMissing) && !rel.includes('ghost.md'),
      'M2-C **声明产出支逐字不变**：文本里声明的 `report.md` 已落盘 ⇒ 进集；声明的 `missing.md` 未落盘 ⇒ 不进；'
      + '在册但盘上无此文件的 `ghost.md` ⇒ 不进（`isFileDelivered` 照旧把守）',
      '');
    crit('M2', rel.includes(pdfRel) && rel.includes(mediaRel),
      'M2-E **新放开族该命中**：`.pdf` / `.mp4` 族可判型 ⇒ 进集（各走"抽取后文档腿" / "形态核验"）',
      `${pdfRel} ${rel.includes(pdfRel)} · ${mediaRel} ${rel.includes(mediaRel)}`);
    // ── 该不命中侧：三只反证标本（各挡在不同的闸上）──
    crit('M2', !rel.includes(txtRel),
      'M2-F **`.txt` 仍出局**（承裁定 T3）：扩展名分不开"人写的说明"与"机器写的构建报告"，宁可少收', '');
    crit('M2', !rel.includes(probeRel),
      'M2-G **族可判型但探针噪声 ⇒ 仍出局**：`_probe/_tmp_scan.md` 是 `.md`（族可判型），但 `docNotProbe` 的'
      + ' `%/_%tmp%` 命中 ⇒ 被挡（证"族可判型"与"非噪声"是**与**关系，不是任一即可）', '');
    crit('M2', !rel.includes(imgRel),
      'M2-H **族不可判型 ⇒ 出局**：`.png` 没有内容校验路（图片不在任何族判型支内）', '');
    crit('M2', rel.length === 15,
      'M2-D **正面计数**：目标集**恰好 15 项**（= 声明 report.md + 9 业务 + .java + 2 份 .md + .pdf + .mp4）——'
      + '不是"断言不抛异常"，而是把"收了几个人"数出来',
      `${rel.length} 项`);

    // ── M2-旧态反证：M1 **之前**那把成员资格尺的**就地复刻**（`DOC_TARGET_EXT_RE = /\.(md|markdown)$/i`，
    //    按扩展名、**不看登记标签、也无探针闸**；**仅作反证标本**，不接入生产）——
    //    证"新旧**确实换了结果**"，不是"新旧都不响"的空样本。
    //    ⚠ 刻意**不**复刻更早的 F6a 形态（`type === 'doc' || /\.(md|markdown|txt)$/i`）：那个 `type === 'doc'`
    //      析取项会把**所有登记 doc 的行**一律收进来（本组标本全登记 doc）⇒ 反证退化成"什么都收"，
    //      既非 HEAD 态、也证不出任何方向。T3（zx_20260923 M5-a）之后 `.txt` 早已出局，故本反证点落在
    //      **"PDF/音视频/代码/配置被挡在外"**这一方向；`.txt` 在旧尺与新尺下**一致出局**，不作反证点。
    const legacyIsDocTarget = (filePath: string): boolean => /\.(md|markdown)$/i.test(filePath);
    const legacyWouldTake = [...biz, javaRel, docRel, docRelMislabeled, pdfRel, mediaRel, txtRel, probeRel, imgRel]
      .filter((r) => legacyIsDocTarget(r));
    crit('M2', legacyWouldTake.includes(docRel) && !legacyWouldTake.includes(pdfRel)
      && !legacyWouldTake.includes(mediaRel) && !legacyWouldTake.includes(txtRel),
      'M2-旧态反证：M1 之前那把尺（`.md`/`.markdown` 单扩展名）的就地复刻——**PDF/音视频/代码/配置全被挡在门外**，'
      + '只收 `.md`；新尺（K-6 结构性）把它们按真族收进来 ⇒ 本批的改动确实换了结果，不是"新旧都不响"的空样本',
      `旧尺收 ${legacyWouldTake.length} 项：含 .md=${legacyWouldTake.includes(docRel)} / `
      + `含 .pdf=${legacyWouldTake.includes(pdfRel)} / 含 .mp4=${legacyWouldTake.includes(mediaRel)} / `
      + `含 .txt=${legacyWouldTake.includes(txtRel)}`);

    // ── M2-S 接线（结构面；行为由 M2-A…H 把守，此处只证"收人规则的**唯一尺**在位"）──
    const iGate = execCode.indexOf('export function docValidationTargets');
    const gateBody = iGate < 0 ? '' : execCode.slice(iGate, execCode.indexOf('\n}', iGate) + 2);
    crit('M2', countOcc(gateBody, "r.type === 'doc'") === 0,
      'M2-S1 登记标签**不再定内容门禁的成员资格**：`docValidationTargets` 块内 `r.type === \'doc\'` **零处**'
      + '（扫描面自证：切片非空 + 全文件行数见 G-2）。⚠ 该串在 `agent-executor.ts` **别处仍有一处合法用途**'
      + '（`isRealDeliverableRow`：判"登记为 doc 的行**是否指向了真实落盘的文件**"——那是"登记了有没有做"，'
      + '标签此时**正是**被问的主语，与"谁进内容门禁"是两件事）⇒ **刻意不动**，故此处**不写全文件零处**',
      `块内 ${countOcc(gateBody, "r.type === 'doc'")} 处 / 全文件 ${countOcc(execCode, "r.type === 'doc'")} 处`
      + `（余者属别处合法用途）· 扫描 ${execLines} 行`);
    crit('M2', gateBody.length > 200 && countOcc(execCode, 'export function isGateArtifact') === 1
      && countOcc(execCode, 'DOC_TARGET_EXT_RE') === 0,
      'M2-S2 族判据只有**一把、一处**定义（`export function isGateArtifact`）且**恰好一处**——'
      + '不是"定义一套、另抄一套"；切片非空自证防"扫了个空"。旧符号 `DOC_TARGET_EXT_RE` 随 M1 撤除 ⇒ '
      + '全文件零残留（这条钉的是**取而代之**的新尺，旧尺的钉在此**就地转交**）',
      `切片 ${gateBody.length} 字符 · isGateArtifact 定义 ${countOcc(execCode, 'export function isGateArtifact')} 处 · `
      + `旧符号 DOC_TARGET_EXT_RE 残留 ${countOcc(execCode, 'DOC_TARGET_EXT_RE')} 处`);
    crit('M2', countOcc(gateBody, 'isGateArtifact') === 1 && countOcc(gateBody, 'docNotProbe') === 1
      && countOcc(gateBody, 'wa_deliverables') === 1 && !/\btype\b/.test(gateBody),
      'M2-S3 门禁块内**两闸俱全且各一次**：`isGateArtifact`（族可判型）1 处 + `docNotProbe`（非噪声）1 处，'
      + '`wa_deliverables` 仍在（没把整段收人逻辑删掉），且**连 `type` 一词都没有**（该列已不再从库里取）',
      `块内 isGateArtifact ${countOcc(gateBody, 'isGateArtifact')} / docNotProbe ${countOcc(gateBody, 'docNotProbe')} / `
      + `type ${(gateBody.match(/\btype\b/g) ?? []).length} 次`);
    // ⚠ 把 `wa_deliverables` 那一句整段删掉也能让 M2-S3 的前半句为绿 ⇒ 另配正面断言：库里取出的行**确实被读**。
    crit('M2', gateBody.includes('r.file_path') && gateBody.includes('path.isAbsolute'),
      'M2-S4 收人支**确实在跑**（读 `r.file_path`、按绝对/相对解析后 `push`）——防"把那段删了也算修好"',
      '');

    // ── M2-Real 生产入参佐证（**守卫式**：真实库/标本文件不在场则明示"跳过、不计入"，不谎称已验）──
    let realRan = false;
    try {
      const realDbPath = path.join(root, 'data/worker-ant-server.db');
      if (fs.existsSync(realDbPath)) {
        const rdb = new DatabaseSync(realDbPath, { readOnly: true } as never);
        const trow = rdb.prepare("SELECT id FROM wa_tasks WHERE id LIKE 'a290ae2b%'").get() as { id: string } | undefined;
        const rows = rdb.prepare("SELECT file_path FROM wa_deliverables WHERE task_id LIKE 'a290ae2b%' AND file_path IS NOT NULL AND file_path != ''").all() as Array<{ file_path: string }>;
        const present = rows.filter((r) => fs.existsSync(r.file_path));
        if (trow && present.length >= 10) {
          const rt = docValidationTargets(rdb as never, trow.id, path.join(root, 'data'));
          const bizNames = ['pom.xml', 'application.properties', 'yop_sdk_config_default.json.example',
            'V1.0.1__order-payment.sql', 'OrderRefundController.java'];
          const bizIn = rt.filter((p) => bizNames.includes(path.basename(p)));
          const mdN = rt.filter((p) => /\.(md|markdown)$/i.test(p)).length;
          const txtN = rt.filter((p) => /\.txt$/i.test(p)).length;
          realRan = true;
          // zx_20261003 M1 / 裁定 K-6 就地**改钉**（承 zx_20260923 M5-a 那次"收窄即改钉"的同一手法）：
          //   成员资格由"扩展名 ∈ {.md,.markdown}"改为**结构性判据**「族可判型 ∧ 非噪声」⇒ 生产真库上，
          //   业务文件（pom.xml/.properties/.json.example/.sql/.java）现在**按各自真族进集**（旧尺下全在门外）。
          //   `.txt` 的钉子**保留**（承 T3：它仍必须出局）——这一条**越宽越容易过**，故必须留。
          crit('M2', rt.length >= 1 && mdN >= 1 && bizIn.length > 0 && txtN === 0,
            'M2-Real **生产入参佐证**：真库 `a290ae2b` 上跑真实现——进集者含 .md（文档族），且**盘上真实存在**的'
            + ' pom.xml/.properties/.json.example/.sql/.java **现在按各自真族进集**（K-6 加宽；旧尺下它们全在门外，'
            + '该差异正是 M1 生效的正面证据）；同时 `.txt` **一件都不在集内**（承裁定 T3）',
            `进集 ${rt.length} 项 · 业务文件命中 ${bizIn.length} 项 · .md ${mdN} 项 · .txt ${txtN} 项 · 盘上在册 ${present.length} 份`);
        }
      }
    } catch { /* 真实库不可读 ⇒ 落到下面的"跳过"分支 */ }
    if (!realRan) {
      console.log('  ⏭ M2-Real **跳过**（真实库或标本文件不在场）——**不计入通过**，不得读作"已验"');
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M3·F6b】判型三档：配置文件不再按"文档"量；`.sql` 的判据认得 DDL');
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rr221-m3-ws-'));
    const write = (name: string, body: string): string => {
      const abs = path.join(ws, name);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
      return abs;
    };

    // ── 标本 A（该放行）：**真形**的 pom.xml / application.properties / 迁移 .sql ──
    //    ⚠ 夹具不得比生产宽松：三份正文按**真文件的样子**写（Maven 命名空间与 `<project` 开标签、
    //      `spring.*` 键值对、`ALTER TABLE` 通篇）。其"真"另有 M3-Real 用**盘上真文件**复核。
    const pomBody = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example.app</groupId>
  <artifactId>order-payment</artifactId>
  <version>1.0.0</version>
  <description>订单支付模块。support 团队维护（此句刻意含 port 一词，用于钉住"关键词尺已死"）。</description>
  <dependencies>
    <dependency><groupId>org.springframework</groupId><artifactId>spring-context</artifactId></dependency>
  </dependencies>
</project>
`;
    const propsBody = `spring.application.name=order-payment
spring.datasource.url=jdbc:mysql://127.0.0.1:3306/demo_order
spring.datasource.username=demo
server.port=8081
`;
    const sqlBody = `-- V1.0.1__order-payment.sql
ALTER TABLE t_order_payment ADD COLUMN pay_channel VARCHAR(32) DEFAULT NULL COMMENT '支付渠道';
ALTER TABLE t_order_payment ADD COLUMN trade_no VARCHAR(64) DEFAULT NULL COMMENT '第三方交易号';
CREATE INDEX idx_order_payment_trade_no ON t_order_payment (trade_no);
`;
    const pomAbs = write('pom.xml', pomBody);
    const propsAbs = write('application.properties', propsBody);
    const sqlAbs = write('V1.0.1__order-payment.sql', sqlBody);

    // ⚠ zx_20260922_1 M7（F9）：以下调用原为 4 参（第 3 参是任务题面 `'实施后端方案'`）。
    //   该参数已从 `validateOutput` **整体删除** ⇒ 此处随之收成 3 参。这是**机械后果、非判据改动**：
    //   本块的标本全走 `code`/`configuration` 早退支，从不进 LLM 腿，故 M3 的结论一字不变。
    const cA1 = await validateOutput(null as never, pomAbs, archetypeForFile(pomAbs));
    const cA2 = await validateOutput(null as never, propsAbs, archetypeForFile(propsAbs));
    const cA3 = await validateOutput(null as never, sqlAbs, archetypeForFile(sqlAbs));
    crit('M3', cA1.status !== 'insufficient' && cA1.sufficient === true,
      'M3-A **标本 A 该放行(1) 真形 `pom.xml`**：判型 `configuration`、结构快检通过 ⇒ **不进** `insufficient`'
      + '（旧态：判 `document` ⇒ 缺 `# 标题` ⇒ 一进门就判不足，四个真 pom.xml 被写坏的那条路）',
      `判型=${archetypeForFile(pomAbs)} / status=${cA1.status} / issues=${JSON.stringify(cA1.quickCheck?.issues ?? [])}`);
    crit('M3', cA2.status !== 'insufficient' && cA2.sufficient === true,
      'M3-A **标本 A 该放行(2) `application.properties`**：`key=value` 结构命中 ⇒ 放行',
      `判型=${archetypeForFile(propsAbs)} / status=${cA2.status} / issues=${JSON.stringify(cA2.quickCheck?.issues ?? [])}`);
    crit('M3', cA3.status !== 'insufficient' && cA3.sufficient === true,
      'M3-A **标本 A 该放行(3) 迁移 `.sql`**：判型 `code`、通篇 `ALTER TABLE`/`CREATE INDEX` 命中'
      + '新增的 DDL 动词 ⇒ 放行（旧态：词表只认编程语言顶层构造，实测真脚本命中 **0** 处 ⇒ 一进门判不足）',
      `判型=${archetypeForFile(sqlAbs)} / status=${cA3.status} / issues=${JSON.stringify(cA3.quickCheck?.issues ?? [])}`);

    // ── 标本 B（该拦，反证放宽不得过宽）────────────────────────────────────
    const sqlTodoAbs = write('todo_only.sql', '-- TODO: 待补充\n-- 本迁移脚本尚未编写，仅占位。\n-- TODO: 建表语句待确认\n'
      + '-- 占位说明：' + '略'.repeat(60) + '\n');
    const propsEmptyAbs = write('empty.properties', '# 待补充\n');
    const cB1 = await validateOutput(null as never, sqlTodoAbs, archetypeForFile(sqlTodoAbs));
    const cB2 = await validateOutput(null as never, propsEmptyAbs, archetypeForFile(propsEmptyAbs));
    crit('M3', cB1.status === 'insufficient' && cB1.sufficient === false,
      'M3-B **标本 B 该拦(1) 只有 TODO 的 `.sql`**：放宽 DDL 动词**没有**把"什么都不是的文件"也放进来——'
      + '词表要求动词在**行首**，注释里的 `TODO: 待补充` 不在词表内 ⇒ 仍判 `insufficient`（反向断言）',
      `status=${cB1.status} / issues=${JSON.stringify(cB1.quickCheck?.issues ?? [])}`);
    crit('M3', cB2.status === 'insufficient' && cB2.sufficient === false,
      'M3-B **标本 B 该拦(2) 空 `.properties`**：结构尺不认"只有一行注释"⇒ 文件过小 + 缺配置结构 ⇒ 判不足',
      `status=${cB2.status} / issues=${JSON.stringify(cB2.quickCheck?.issues ?? [])}`);

    // ── 标本 C（既有规则不回归）────────────────────────────────────────────
    const mdNoTitleAbs = write('无标题.md', '正文若干。' + '内容'.repeat(300) + '\n结论：无。\n');
    const javaAbs = write('OrderEntity.java', 'package com.example.app.order.entity;\n\n'
      + '/** 订单实体。 */\npublic class OrderEntity {\n'
      + '  private String orderNo;\n  public String getOrderNo() { return orderNo; }\n}\n');
    const cC1 = await validateOutput(null as never, mdNoTitleAbs, archetypeForFile(mdNoTitleAbs));
    const cC2 = await validateOutput(null as never, javaAbs, archetypeForFile(javaAbs));
    crit('M3', cC1.status === 'insufficient' && (cC1.quickCheck?.issues ?? []).some((s) => s.includes('标题')),
      'M3-C **标本 C 不回归(1)**：`.md` 缺 `# 标题` 仍判不足（document 尺一字未动）',
      `status=${cC1.status} / issues=${JSON.stringify(cC1.quickCheck?.issues ?? [])}`);
    crit('M3', cC2.status === 'ok' && cC2.sufficient === true,
      'M3-C **标本 C 不回归(2)**：正常 `.java` 仍通过（`public` 仍命中，加动词没挤掉既有关键字）',
      `status=${cC2.status} / issues=${JSON.stringify(cC2.quickCheck?.issues ?? [])}`);

    // ── 正面断言（计数器类）：判型**必须**是 configuration，不是"不等于 document"────
    crit('M3', archetypeForFile('/x/pom.xml') === 'configuration' && archetypeForFile('/x/.env') === 'configuration'
      && archetypeForFile('/x/a.json.example') === 'configuration' && archetypeForFile('/x/报告.md') === 'document'
      && archetypeForFile('/x/a.sql') === 'code',
      'M3-D **正面断言**：`archetypeForFile` 对 pom.xml / `.env` / `*.json.example` **恰好**返回 `configuration`'
      + '（不是只断言"≠document"——那会让"回落成别的什么"也算通过）；`.md` 仍 document、`.sql` 仍 code',
      `${archetypeForFile('/x/pom.xml')} / ${archetypeForFile('/x/.env')} / ${archetypeForFile('/x/a.json.example')}`);

    // ── 接线（结构面）：三件事各自归一处 ──────────────────────────────────
    const oldCfgRe = '(yaml|json|toml|env|config|port|host)';
    crit('M3', countOcc(ovCode, oldCfgRe) === 0,
      'M3-S1 旧**关键词尺**在 `output-validator.ts`（去注释后）**零处**残留——'
      + '不是"新尺写了、旧尺还在旁边"（该串只在本脚本的标本里现拼，故不会被自己的判据误伤）',
      `实测 ${countOcc(ovCode, oldCfgRe)} 处 · 扫描面 ${ovCode.split('\n').length} 行`);
    crit('M3', countOcc(ovCode, "label: '配置信息'") === 1,
      'M3-S2 `配置信息` 这条尺**恰好一处**定义（不是两边各抄一份）',
      `实测 ${countOcc(ovCode, "label: '配置信息'")} 处`);
    crit('M3', countOcc(execCode, 'const CONFIG_ARTIFACT_EXTS') === 1
      && countOcc(execCode, 'CONFIG_ARTIFACT_EXTS') === 2,
      'M3-S3 配置扩展名清单**一处**定义、**恰好**被用一次（承 M2-S2 的同一形态）',
      `定义 ${countOcc(execCode, 'const CONFIG_ARTIFACT_EXTS')} 处 · 引用 ${countOcc(execCode, 'CONFIG_ARTIFACT_EXTS')} 处`);
    // 早退分支可能不止一条（M1 之后又添了 `if (archetype === 'media')` 一条）⇒ 取**提到 code/configuration
    //   的那一条**来判，而非"文件里第一条 `if (archetype ===…`"——否则新添的旁支会把扫描面挤走（假红）。
    //   若有人把 code 与 configuration 拆成两条分支，find 会命中 code 那条、configuration 缺失 ⇒ 仍判红。
    const archetypeGuards = ovCode.match(/if \(archetype ===[^)]*\)\s*\{/g) ?? [];
    const earlyGuard = archetypeGuards.find((g) => g.includes("'code'") || g.includes("'configuration'")) ?? '';
    crit('M3', earlyGuard.includes("'code'") && earlyGuard.includes("'configuration'"),
      'M3-S4 止于结构快检的早退分支**同时**覆盖 code 与 configuration——'
      + '否则新档位刚躲过"文档词表尺"、又原样盖上一枚**文档判据的 LLM 章**（病只治一半）',
      earlyGuard.trim() || `未找到 code/configuration 早退分支（现有 ${archetypeGuards.length} 条 archetype 分支）`);

    // ── M3-Real 生产入参佐证（**守卫式**：真文件不在场则明示"跳过、不计入"，不谎称已验）──
    let m3RealRan = false;
    try {
      const realDbPath = path.join(root, 'data/worker-ant-server.db');
      if (fs.existsSync(realDbPath)) {
        const rdb = new DatabaseSync(realDbPath, { readOnly: true } as never);
        const rows = rdb.prepare("SELECT DISTINCT file_path FROM wa_deliverables WHERE task_id LIKE 'a290ae2b%' AND file_path IS NOT NULL AND file_path != ''").all() as Array<{ file_path: string }>;
        const present = rows.map((r) => r.file_path).filter((p) => fs.existsSync(p));
        const realPoms = present.filter((p) => path.basename(p) === 'pom.xml');
        const realSql = present.filter((p) => p.endsWith('.sql'));
        if (realPoms.length >= 1 && realSql.length >= 1) {
          const verdicts = [] as Array<{ f: string; arch: string; status: string | undefined; issues: string[] }>;
          for (const p of [...realPoms.slice(0, 2), ...realSql.slice(0, 1)]) {
            const v = await validateOutput(null as never, p, archetypeForFile(p));
            verdicts.push({ f: path.basename(p), arch: archetypeForFile(p), status: v.status, issues: (v.quickCheck?.issues ?? []).slice(0, 2) });
          }
          m3RealRan = true;
          crit('M3', verdicts.every((v) => v.status !== 'insufficient'),
            'M3-Real **生产入参佐证**：拿**盘上真实**的 pom.xml / 迁移 .sql 跑生产真实现 ⇒ 无一进 `insufficient`'
            + '（M3-A 是**真形**夹具，这条是**真件**——两把尺互证，防"夹具比生产宽松"）',
            verdicts.map((v) => `${v.f}→${v.arch}/${v.status}${v.issues.length ? `(${v.issues.join(';')})` : ''}`).join(' · '));
        }
      }
    } catch { /* 真实库不可读 ⇒ 落到下面的"跳过"分支 */ }
    if (!m3RealRan) {
      console.log('  ⏭ M3-Real **跳过**（真实库或标本文件不在场）——**不计入通过**，不得读作"已验"');
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M4·F2】`sdk_failed`：没有兑现者，就不许有承诺（撤回承诺，非真回传）');
  {
    // ── 派生：这条承诺**有没有**兑现者？兑现者=模型选型处读 `sdk_failed` ────────────────
    //    ⚠ 判据不是"文案长什么样"，而是"机器有没有做那件事"——文案只是它的影子。
    const selConsumers = countOcc(mselCode, 'sdk_failed');
    // 两侧标本（承 `feedback_predicate_needs_both_sides_specimen`）：只用"该不命中"⇒ 恒 0 的坏扫描器也全票通过。
    const probeZero = countOcc('const nothing = 0;', 'sdk_failed');
    const probeOne = countOcc('const picked = ctx.sdk_failed ? a : b;', 'sdk_failed');
    crit('M4', probeZero === 0 && probeOne === 1,
      'M4-0 **扫描器自证（两侧标本）**：同一把计数器——不含该词的串计 0、含该词的串计 1'
      + ' ⇒ 下面"兑现者 0 处"是真的没有，不是扫描器坏了',
      `probeZero=${probeZero} / probeOne=${probeOne}`);
    crit('M4', selConsumers === 0,
      'M4-A **派生事实：这条承诺没有兑现者**——模型选型处（`exec-model-select.ts`）读 `sdk_failed` **0 处**，'
      + '它只读 `sdk_fallback`（那是"切备用 provider"，另一件事）⇒ 重试走的是**同一个模型**',
      `选型处读 sdk_failed ${selConsumers} 处 · 扫描面 ${mselCode.split('\n').length} 行`);
    // 这条断言把"条件"本身写成可证伪的两侧标本：有兑现者才准说"已降级"，没有就不准。
    const maySayDowngraded = (consumers: number): boolean => consumers > 0;
    crit('M4', maySayDowngraded(0) === false && maySayDowngraded(1) === true,
      'M4-B **判据是条件式、不是一刀切**：`maySayDowngraded(0)=false`（当前态：不许说）· '
      + '`maySayDowngraded(1)=true`（若将来真接了消费者，这条禁令自动解除）⇒ 本批改的是**当下的事实**，'
      + '不是永久禁止某种说法',
      `当前 consumers=${selConsumers}`);

    // ── 代码面（**去注释**）：用户可见文案里不许再有那句超纲的承诺 ────────────────
    //    `已自动重试一次`（agent-executor 收口文案）/ `SDK_RETRY_RESUME_MSG`（ai-task 两条回队文案）
    const lieExec = countOcc(execCode, '非 reasoning') + countOcc(execCode, '已降级');
    const lieAiTask = countOcc(aiTaskCode, '非 reasoning') + countOcc(aiTaskCode, '已降级');
    crit('M4', !maySayDowngraded(selConsumers) ? (lieExec === 0 && lieAiTask === 0) : true,
      'M4-C **无兑现者 ⇒ 零处"已降级/非 reasoning"表述**（去注释后判：订正注释里逐字引了旧文案，'
      + '拿原文判会被自己的注释判红）。⚠ 断言写成条件式：若 `sdk_failed` 真被消费了，本条的**要求**自动失效',
      `agent-executor ${lieExec} 处 · ai-task ${lieAiTask} 处（扫描面 ${execCode.split('\n').length}+${aiTaskCode.split('\n').length} 行）`);
    crit('M4', execCode.includes('已自动重试一次'),
      'M4-D **真相在场**（而非只断言假话离场）：`[AI引擎失败]` 文案改说机器真做过的事——"已自动重试一次"',
      '');
    const declMsg = countOcc(aiTaskCode, 'const SDK_RETRY_RESUME_MSG');
    const useMsg = countOcc(aiTaskCode, 'SDK_RETRY_RESUME_MSG');
    crit('M4', declMsg === 1 && useMsg === 3,
      'M4-E **单源**：回队文案在 `ai-task.ts` **一处**定义（`const SDK_RETRY_RESUME_MSG`）、**恰好**两处引用'
      + '（首轮入队 + resume 回队）——两条路径分处两个 handler，各写一版就是原病（两版话术各自超纲）',
      `定义 ${declMsg} 处 · 出现 ${useMsg} 次（=1 定义 + 2 引用）`);
    // 两条互相打架的注释必须订正到**同一句话**——故在**原文**上断"那句话在场"（不在场就说不清订正了什么）
    const ONE_SENTENCE = '本次重试不换模型。';
    crit('M4', execRaw.includes(ONE_SENTENCE) && aiTaskRaw.includes(ONE_SENTENCE),
      'M4-F **两处注释订正到同一句话**（方案 §M3/§M4 明列的"互相打架的两条注释"）：'
      + '`agent-executor.ts` 与 `jobs/ai-task.ts` 现都写着同一句 `本次重试不换模型。`——'
      + '断言**真相在场**（原文面），而非"旧话不在场"（那会被订正注释自己判红）',
      `agent-executor 含=${execRaw.includes(ONE_SENTENCE)} / ai-task 含=${aiTaskRaw.includes(ONE_SENTENCE)}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M5·F7】世界模型审计：大工作树上「没做判定」不许伪装成「发现了不一致」');
  {
    // 判据跑**真** `captureWorldSnapshot` + **真** `auditWorldConsistency`（不造等价入参、不调私有件）。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr221-m5-ws-'));
    const m5db = new DatabaseSync(':memory:');
    m5db.exec('CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, working_dir TEXT)');
    m5db.exec('CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT, context_json TEXT)');
    m5db.exec('CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, status TEXT, file_path TEXT)');
    /** 造 n 个**真**文件的真目录（名字定长补零 ⇒ 字典序确定，与生产同一采样口径） */
    const mkDir = (name: string, n: number): string => {
      const d = path.join(dir, name);
      fs.mkdirSync(d, { recursive: true });
      for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, `z_${String(i).padStart(5, '0')}.txt`), 'x');
      return d;
    };
    const mkProj5 = (id: string, wd: string) => m5db.prepare('INSERT INTO wa_projects (id, name, working_dir) VALUES (?, ?, ?)').run(id, id, wd);
    const ctxOf5 = (id: string) => JSON.parse((m5db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json) as Record<string, unknown>;
    /** 先插**任务行**再取 before（否则 before/after 的 taskStates 集合不同，会把夹具自身的插入读成"任务状态变更") */
    const seedTask = async (id: string, projectId: string): Promise<Record<string, unknown>> => {
      m5db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, ?, ?, 'executing', '{}')").run(id, projectId, id);
      const before = (await captureWorldSnapshot(m5db as never, projectId))!;
      m5db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?')
        .run(JSON.stringify({ world_snapshot_before: before, finalize_checks: ['[PASS] 示例'] }), id);
      return before;
    };

    // ── 标本 C：截断标志的**边界**（`>` 而非 `>=`，与 `capturedWorldSnapshot` 同尺）──
    const dEdge = mkDir('edge', SNAPSHOT_FILE_LIMIT);            // **恰好**上限
    const dBig = mkDir('big', SNAPSHOT_FILE_LIMIT + 1);          // 刚过界一个（同一只夹具兼职标本 A）
    mkProj5('wp-edge', dEdge);
    mkProj5('wp-big', dBig);
    const sEdge = (await captureWorldSnapshot(m5db as never, 'wp-edge'))!;
    crit('M5', sEdge.truncated === false && sEdge.fileCount === SNAPSHOT_FILE_LIMIT,
      'M5-C1 **边界下侧**：恰好 ' + SNAPSHOT_FILE_LIMIT + ' 个文件 ⇒ `truncated === false`'
      + '（若实现写成 `>=`，这一条必红——它就是"边界在 2001 才置位"的判别式）',
      `truncated=${sEdge.truncated} · fileCount=${sEdge.fileCount}`);

    // ── 标本 A（**本批靶心**）：大工作树 ⇒ 截断 ⇒ 只该有一条 info，**零** [WARN]、零会话行 ──
    const beforeBig = await seedTask('T-big', 'wp-big');
    crit('M5', beforeBig.truncated === true,
      'M5-A0 **标本自证**：这只标本确实落在截断区（否则 A1/A2 会在"本就没截断"上假绿）',
      `before.truncated=${beforeBig.truncated} · fileCount=${beforeBig.fileCount}`);
    crit('M5', beforeBig.fileCount === SNAPSHOT_FILE_LIMIT + 1 && (beforeBig.fileHashes as string[]).length === SNAPSHOT_FILE_LIMIT,
      'M5-C2 **边界上侧**：过界 1 个即截断，且 `fileCount` 仍是**真总数**、样本量恰为上限（两把数不许混）',
      `fileCount=${beforeBig.fileCount} · 样本=${(beforeBig.fileHashes as string[]).length}`);
    let convBig = 0;
    await auditWorldConsistency(m5db as never, 'T-big', 'wp-big', () => { convBig++; }, { dataDir: dir });
    const ckBig = (ctxOf5('T-big').finalize_checks as string[]) ?? [];
    const warnsBig = ckBig.filter((c) => c.startsWith('[WARN]'));
    const infosBig = ckBig.filter((c) => c.startsWith('[INFO]'));
    crit('M5', warnsBig.length === 0,
      'M5-A1 ★ **该不告警（本批靶心）**：大工作树（快照截断）⇒ 收口 checks 里**零** `[WARN]` 行'
      + '——"没做判定"不再冒充"发现了不一致"（此前每一轮都吃一条恒真告警）',
      `checks=[${ckBig.join(' | ')}]`);
    crit('M5', infosBig.length === 1 && infosBig[0]!.includes(TRUNCATION_ISSUE_PREFIX),
      'M5-A2 ★ **如实仍在场**（不是"把噪音删掉"）：仍有一条 info 级说明，且带同一枚截断标记'
      + '（判据与 `world-snapshot.ts` 的常量同源，不手抄字面量）',
      `info=${String(infosBig[0] ?? '（无）')}`);
    crit('M5', infosBig[0]!.includes('仅覆盖字典序前'),
      'M5-A3 **声明的边界**（治法2）：info 行显式说明样本覆盖面（"仅覆盖字典序前 N 个路径"）'
      + '——不得把"样本内无增删"说成"无增删"',
      String(infosBig[0] ?? ''));
    crit('M5', ckBig.length === 2 && ckBig[0] === '[PASS] 示例' && !ckBig.some((c) => c.includes('文件删除') || c.includes('文件新增')),
      'M5-A4 **追加而非覆盖**：原有 `[PASS]` 一字不动、新行追加在后（恰 2 条），且**没有**任何增删字样'
      + '（截断时"放弃增删判定"这条老裁定一字未松）',
      `checks 共 ${ckBig.length} 条`);
    crit('M5', convBig === 0,
      'M5-A5 **会话流不被灌**：info 级**不写** `[B2世界模型审计]` 对话行——"每一轮都必有的一条通知"'
      + '正是本批要治的那句狼来了（结论已在 checks 里如实可见）',
      `conv=${convBig}`);

    // ── 标本 B（**反向断言**）：真比出不一致 ⇒ 仍须 `[WARN]` + 仍须会话行（分级不是"把 warn 全改印 info"）──
    const dSmall = mkDir('small', 100);
    mkProj5('wp-small', dSmall);
    const beforeSmall = await seedTask('T-small', 'wp-small');
    fs.rmSync(path.join(dSmall, 'z_00000.txt'));
    let convSmall = 0;
    await auditWorldConsistency(m5db as never, 'T-small', 'wp-small', () => { convSmall++; }, { dataDir: dir });
    const ckSmall = (ctxOf5('T-small').finalize_checks as string[]) ?? [];
    crit('M5', beforeSmall.truncated === false,
      'M5-B0 **标本自证**：小树未截断（否则 B1 会落进截断分支、断言空转）',
      `truncated=${beforeSmall.truncated}`);
    crit('M5', ckSmall.filter((c) => c.startsWith('[WARN]')).length === 1
      && ckSmall.some((c) => c.startsWith('[WARN] 世界模型审计：') && c.includes('[文件删除] 1个文件消失')),
      'M5-B1 ★ **该告警仍告警**（本批的**另一侧**标本）：真删 1 个 ⇒ 仍落 `[WARN] 世界模型审计：…`'
      + '并点名该文件（放宽不得把真告警一起吞掉）',
      `checks=[${ckSmall.join(' | ')}]`);
    crit('M5', !ckSmall.some((c) => c.startsWith('[INFO]')),
      'M5-B2 且**不**混入 info 行：两级是**分派**，不是"凡有结论都印 info"');
    crit('M5', convSmall === 1,
      'M5-B3 warn 一级的通路一个字没动：真告警仍写会话行（否则"分级"就把告警降成了静默）',
      `conv=${convSmall}`);

    // ── 静态接线：标记一处真源 / 两级各一落点 / warn 与 info 的去处分派 ──
    const wsCode = strip(WS_SRC);
    crit('M5', countOcc(wsCode, "'[快照已截断]'") === 1,
      'M5-S1 **标记一处真源**：字面量 `[快照已截断]` 在 `world-snapshot.ts`（去注释）**恰 1 处**'
      + '（常量定义；产出侧与分派侧都引用它，不各写一份）',
      `实测 ${countOcc(wsCode, "'[快照已截断]'")} 处 · 扫描面 ${wsCode.split('\n').length} 行`);
    crit('M5', countOcc(wsCode, '[WARN] 世界模型审计') === 1 && countOcc(wsCode, '[INFO] 世界模型审计') === 1,
      'M5-S2 **两级各一处落点**：审计结论分派到 checks 的 warn 行与 info 行各恰 1 处（不重复、不漏）',
      `WARN ${countOcc(wsCode, '[WARN] 世界模型审计')} · INFO ${countOcc(wsCode, '[INFO] 世界模型审计')}`);
    crit('M5', countOcc(wsCode, 'if (warns.length > 0)') === 2 && wsCode.includes('{ taskId, issues: warns }'),
      'M5-S3 **分派真接上**：入 checks 与写会话两条路各由 `warns.length > 0` 把门，且日志记的是 `warns` 不是全量',
      `守卫 ${countOcc(wsCode, 'if (warns.length > 0)')} 处`);
    crit('M5', countOcc(wsCode, 'issues.join') === 0,
      'M5-S4 **旧的无条件通道已撤**：不再有把 `issues` 整体拼进告警行/会话行的写法'
      + '（去注释面判：改法只是把 `issues` 换成 `warns`/`infos`，不是新添一条旁路）',
      `实测 ${countOcc(wsCode, 'issues.join')} 处`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M7·F9】内容门禁的**问句主语归位**：量文件，就问文件');
  {
    // 病根（活标本 `a290ae2b` 段 5 三次 finalize 被拒，逐字见方案 §1.3-F9）：
    //   问句主语是**任务**（`任务: "${title} ${description}"`）、被量的是**文件**，答案于是记在**文件名**头上——
    //   一份 `pom.xml` 被判「缺少 git 提交（指定署名、无 Co-Authored-By）」，六条拒收理由**全是用户的七条要求**、
    //   **没有一条**关于那份 POM ⇒ **判据不可能被合法数据满足**。
    //
    // ⚠ 本批 rr **只判问句的形状**（确定性）；"LLM 在新问句下是否真判得对"rr 里没有模型，判不了——
    //   后者诚实地**留待实机**（方案 §3 M7 完成情况"未做实机 E2E"），不在此假装验过。
    const mdBody = '# 易宝支付适配层说明\n\n'
      + '本模块给出下单 / 查单 / 退款三条链路的调用时序与失败重试口径，含参数与返回码对照。\n'.repeat(18)
      + '\n结论：按本文实施即可，无需引入额外依赖。\n';
    const ws7 = fs.mkdtempSync(path.join(os.tmpdir(), 'rr221-m7-ws-'));
    const write7 = (name: string, body: string): string => {
      const abs = path.join(ws7, name);
      fs.writeFileSync(abs, body);
      return abs;
    };

    // ── 问句的可变主语只有一个：**被量的那份文件** ──────────────────────────
    const pA = buildSufficiencyPrompt('/x/说明甲.md', 'document', mdBody);
    const pB = buildSufficiencyPrompt('/x/说明乙.md', 'document', mdBody);
    crit('M7', pA.prompt.includes('说明甲.md') && !pA.prompt.includes('说明乙.md') && pB.prompt.includes('说明乙.md'),
      'M7-A **主语是文件**：同判型、同内容，问句随**文件名**走（甲含甲不含乙；乙含乙）'
      + '——两侧各自可证伪，不是"扫了个空"',
      `甲含甲=${pA.prompt.includes('说明甲.md')} · 甲含乙=${pA.prompt.includes('说明乙.md')} · 乙含乙=${pB.prompt.includes('说明乙.md')}`);
    crit('M7', !pA.prompt.includes('任务: "') && !pA.system.includes('任务: "'),
      'M7-B ★ **旧问句形状零残留**：`任务: "<题面>"` 这行不在 prompt / system 里'
      + '（⚠ 本批的订正注释**逐字引了**那句旧问句，故"假话离场"类判据一律落在**去注释面**）',
      `prompt 含=${pA.prompt.includes('任务: "')} / system 含=${pA.system.includes('任务: "')}`);
    crit('M7', buildSufficiencyPrompt.length === 3,
      'M7-C ★ **结构上不可能再塞题面**：`buildSufficiencyPrompt` 形参**恰 3 个**且全无默认值'
      + '（`.length` 即真参数个数）⇒ 要再把任务题面喂进文件判据，必须**改签名**（3→4），'
      + '而不是顺手多传一个字符串——这正是"删参而非改名"的用意',
      `arity=${buildSufficiencyPrompt.length}`);
    crit('M7', countOcc(ovCode, '属任务硬性要求') === 0,
      'M7-D ★ **那个入口已拆**：`system` 里「仅当…且该维度属**任务硬性要求**时，才判缺失」这句已离场'
      + '——它本意是防误报，实际正是"把任务要求合法引进文件判据"的那个口子',
      `实测 ${countOcc(ovCode, '属任务硬性要求')} 处 · 扫描面 ${ovCode.split('\n').length} 行`);
    crit('M7', pA.system.includes('这一份文件自身') && pA.prompt.includes('请就**这份文件自身**输出验证JSON'),
      'M7-E **真话在场**（不是只断言旧话离场）：问句正面写明"就**这份文件自身**"——主语就是被量的那件东西',
      '');
    crit('M7', pA.system.includes('不得以"任务的其他要求是否完成"为由判缺失'),
      'M7-F **把"不归它管"写在明处**：任务级完成度由子任务 / 成果交付 / 验收三道闸管，文件门只对文件负责',
      '');

    // ── 「该类型应有的结构」由 `ARCHETYPE_VALIDATION` **一处真源**派生（换判型 ⇒ 问句跟着换）──
    const pCfg = buildSufficiencyPrompt('/x/pom.xml', 'configuration', mdBody);
    crit('M7', pA.prompt.includes('Markdown标题') && pA.prompt.includes('结论/总结'),
      'M7-G **应有结构确由尺表派生**：`document` 档的问句带出该档 `requiredPatterns` 的标签'
      + '（不另抄一份词表）',
      '');
    crit('M7', pCfg.prompt.includes('配置信息') && !pCfg.prompt.includes('Markdown标题') && pCfg.prompt !== pA.prompt,
      'M7-G **另一侧标本**：同一份内容、换判型 `configuration` ⇒ 标签随之换成"配置信息"、'
      + '**不再**出现文档档标签 ⇒ 那串标签是**查表**来的、不是写死的（两侧都验，防"任何差异都全票通过"）',
      `cfg 含配置信息=${pCfg.prompt.includes('配置信息')} · cfg 含Markdown标题=${pCfg.prompt.includes('Markdown标题')}`);

    // ── 门没被松开：跑**真** `validateOutput`（三参新签名）───────────────────
    //    ⚠ LLM 腿在 rr 里跑不了（无模型）⇒ 这两只标本判的是**快检层 + 调用面**，
    //      "该拦仍拦"与"该放行的文件**不得**落进 insufficient"；它们**不是**"LLM 判得对"的证据。
    const stubAns = { getOptimalModel: async () => null };
    const rThin = await validateOutput(stubAns as never, write7('只有标题.md', '# 标题\n'), 'document');
    const rFull = await validateOutput(stubAns as never, write7('完整说明.md', mdBody), 'document');
    crit('M7', rThin.status === 'insufficient' && rThin.sufficient === false,
      'M7-H ★ **该拦仍拦**（靶心的另一侧）：只有一行标题的 `.md` 仍判 `insufficient`'
      + '——换了问句主语，**门槛一字未降**（"量文件"不等于"什么都放行"）',
      `status=${rThin.status} / issues=${JSON.stringify(rThin.quickCheck?.issues ?? [])}`);
    crit('M7', rFull.status === 'unknown' && rFull.sufficient === true,
      'M7-H **该放行的文件不进 `insufficient`**：完整 `.md` 快检过 ⇒ 走到 LLM 腿；rr 无模型 ⇒ 如实落 `unknown`'
      + '（`zx_20260904_3 批4` 既有语义：unknown 不判不充分）。这只证"三参调用跑得通、且不误拦"，'
      + '**不是**"内容已被判达标"',
      `status=${rFull.status}`);

    // ── 两个调用点：三参、且为取题面而多查的那次 DB 查询一并拆除 ──────────────
    // ⚠ zx_20260929 M9：**收口门那条调用**随收尾段落到 `core/exec-close.ts` ⇒ 执行体侧取并集（减工具段）。
    //   两处仍**分别**取面、各判"恰一处"：**不得**整份换成含工具段的 `engineSrc()`——
    //   finalize 门那处（M8 后落在 `control-finalize.ts`）会被同时计进两侧，从"各一处"退化成"合计 ≥1"，是放宽。
    crit('M7', countOcc(execSideCode, 'validateOutput(ansClient as never, abs, arch)') === 1
      && countOcc(controlCode, 'validateOutput(ansClient as never, abs, arch)') === 1,
      'M7-I **两条门禁同形**：收口门（执行体侧）与 finalize 门（工具侧）都只传 (client, 文件, 判型)，其后无任何题面参数',
      `收口 ${countOcc(execSideCode, 'validateOutput(ansClient as never, abs, arch)')} 处 · finalize ${countOcc(controlCode, 'validateOutput(ansClient as never, abs, arch)')} 处 · 扫描面 ${execSideLines}+${controlCode.split('\n').length} 行`);
    // ⚠ 判据须认得"车牌照"，不是"这几个字"：`SELECT title, description FROM wa_tasks` 在
    //   `control-finalize.ts`（M8 后 finalize 门所在）里另有 4 处**正当**用途（验收标准 / 任务行查询 …），拿它扫全文件必得一片假红。
    //   故**按符号切块**到那条门禁自身（起于 `const finalizeTargets`，止于该 `try` 的 `catch`），
    //   并配一条"扫描面非空"的自证——否则切错块会得到"空空如也 ⇒ 全过"的假绿。
    const iF7 = controlCode.indexOf('const finalizeTargets = docValidationTargets(db, taskId, workingDir);');
    // ⚠ 止端**不可**取 `} catch { /* 校验失败不阻断 finalize`——`stripKeepingLines` 会**整块删掉**
    //   `/* … */` 注释，那个锚点在去注释面上根本不存在（取它 ⇒ 切出空块 ⇒ 下条断言假绿）。
    //   改取块后第一条**真代码**：zx_20260928 M2 **就地订正**——原止端是「质量门取值」
    //   （`const qs = (ctxJson.completion_quality as …)?.score ?? 70;`），该处本轮已**删除**
    //   （低分不再"拒绝 finalize"，改为与 run_close 同尺的暂停）⇒ 锚点漂走、切出空块（实测块长 0）。
    //   改挂**仍然在位**的块后真代码：子任务失败闸的第一行（去注释面上唯一）。
    const iF7End = controlCode.indexOf('const failedPend = failedChildren(db, taskId);');
    const gate7 = iF7 < 0 || iF7End < iF7 ? '' : controlCode.slice(iF7, iF7End);
    crit('M7', gate7.length > 300
      && countOcc(gate7, 'validateOutput(ansClient as never, abs, arch)') === 1,
      'M7-J **扫描面自证**：切块对准了那条门禁本身（含唯一的收口门调用点、块长 > 300 字符）'
      + '——切错块/切空会让下一条断言假绿',
      `块长 ${gate7.length} 字符 · 块内调用 ${countOcc(gate7, 'validateOutput(ansClient as never, abs, arch)')} 处`);
    crit('M7', countOcc(gate7, 'fText') === 0 && countOcc(gate7, 'fRow') === 0
      && countOcc(gate7, 'SELECT title, description FROM wa_tasks') === 0,
      'M7-J **为取题面而多查的那次库查询一并拆除**——门禁块内不留"读了不用"的死输入'
      + '（块外 4 处同形查询属别处正当用途，不在判据面内）',
      `块内 fText ${countOcc(gate7, 'fText')} 处 · fRow ${countOcc(gate7, 'fRow')} 处 · `
      + `该查询 ${countOcc(gate7, 'SELECT title, description FROM wa_tasks')} 处`);
    crit('M7', countOcc(ovCode, '你是**文件**内容质量验证员') === 1
      && countOcc(ovCode, '请就**这份文件自身**输出验证JSON：') === 1,
      'M7-K **问句只有一处构造**：`system` 与落款各恰 1 处、都在 `buildSufficiencyPrompt` 内'
      + '（不是两条门禁各写一版问句——那正是"同一件事两处实现"的老病）',
      `system ${countOcc(ovCode, '你是**文件**内容质量验证员')} 处 · 落款 ${countOcc(ovCode, '请就**这份文件自身**输出验证JSON：')} 处`);
    crit('M7', countOcc(ovCode, 'buildSufficiencyPrompt') === 2,
      'M7-K **接线在册**：`buildSufficiencyPrompt` 在 `output-validator.ts`（去注释）恰 2 处'
      + '——1 处 `export function` 定义 + 1 处 LLM 腿调用点（不是定义了没人用）',
      `实测 ${countOcc(ovCode, 'buildSufficiencyPrompt')} 处`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S】build 钉（派生核对，不写轮次字面量；**不受批次门管辖**）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告
//    unhandled rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20260922_1 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260922_1: ${pass} 通过 / ${fail} 失败${pending ? ` / ${pending} 待实施(不计入)` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
});
