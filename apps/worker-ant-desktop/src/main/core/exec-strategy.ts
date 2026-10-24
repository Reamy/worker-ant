/**
 * 执行策略纯函数（zx_20261018_1 批九「收」）。
 *
 * 从 `agent-executor.ts` **原样抽出**（零行为变化）：计价币种、探索/配额判据、
 * 循环身份与游程、D3 处置粒度、预算档位与两档保留名单、金额上限承诺。
 *
 * ⚠ 本模块**零 import、不碰 DB**——受控回归可直跑真实现（不在断言里另抄一份判据）。
 *   `agent-executor.ts` 保留同名导出（旧调用点不裂，同 `acceptance-check` 范式）。
 */
// zx_20260904_7 (2026-09-04): 成本统一按人民币(CNY)计费展示——模型单价按 provider 币种（与"模型管理"列表同口径）
export const USD_TO_CNY_RATE = 7.2; // 仅对 USD 计价的模型生效（可校准）
// 国内厂商价按 CNY；OpenAI/Anthropic/Google 等按 USD
const CNY_PROVIDER_RE = /deepseek|qwen|zhipu|glm|moonshot|doubao|bytedance|minimax|stepfun|kimi|baichuan|hunyuan|ernie|yiyan|lingyi/i;
export function modelPriceInUsd(modelName: string): boolean { return !CNY_PROVIDER_RE.test(modelName || ''); }
export function cnyFactor(modelName: string): number { return modelPriceInUsd(modelName) ? USD_TO_CNY_RATE : 1; }

// ── 探索类调用的判据（zx_20260916_1 M2：单一真源）────────────────────────────────
// 原为 `runTaskExecution` 内部的局部 const/箭头函数；上提到模块作用域并导出，使受控回归能跑**真实现**
// （不另抄一份判据）。上提后语义不变，三处消费点：工具循环检测、D3 命令高频探索闸、A3 工具配额。
// 只读探索工具：连续多次调用(不同参数)属正常探索，不参与"同工具循环"检测
export const EXPLORATION_TOOLS = new Set(['read_file', 'list_files', 'search_content', 'file_retrieval', 'get_current_time']);
// 只读型 bash 命令（目录/文件探索）：与 EXPLORATION_TOOLS 一视同仁，避免 find/ls/cat 枚举大型源码被误判为死循环。
// 不含 python3/node/git/sed/awk/echo——它们可能有副作用或真死循环，仍参与循环检测。
export const READ_ONLY_BASH_CMDS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'find', 'tree', 'pwd', 'grep', 'file', 'du', 'df', 'diff', 'which', 'whoami', 'date', 'env', 'uname']);
export function isExplorationCall(toolName: string, args: unknown): boolean {
  if (EXPLORATION_TOOLS.has(toolName)) return true;
  const cmd = (args as { command?: string } | undefined)?.command?.trim() ?? '';
  if (toolName === 'bash') return isReadOnlyProbeCommand(args);
  if (toolName === 'execute_command') {
    // ① 只读验证命令(如 python3 -m py_compile / --version)不参与循环检测，避免收尾验证被误判为死循环（zx_20260909 #7a 原意）
    if (/^(python3?|node)\s+(-m\s+py_compile|--version|-V|-v)\b/.test(cmd)) return true;
    // ② zx_20260922_1 M1（F3 顺带裁定·取 a）：**只读探测**同样是探索，与 `bash` 走**同一份白名单**。
    //   旧写法只答 ①，于是同一条 `ls -la`：`bash` 判探索、`execute_command` 判"非探索"——换一把 shell 即
    //   绕过探索收敛闸与配额处置（与 F13「换个名字做同一件事」同族）。两支相或后，两把 shell 在
    //   **计数尺**（`exploreCmdN` / `countsTowardToolQuota`）与**处置尺**（`makeNonExplorationCappedTool`）上同判。
    return isReadOnlyProbeCommand(args);
  }
  return false;
}

/**
 * 这条命令是否属"只读探测"（`ls`/`cat`/`find`…）——**按命令本身判，与承载它的 shell 工具无关**。
 * 它是 `isExplorationCall` 的 bash 分支与 A3 配额尺**共用的那一份**白名单判据。
 */
export function isReadOnlyProbeCommand(args: unknown): boolean {
  const cmd = (args as { command?: string } | undefined)?.command?.trim() ?? '';
  return READ_ONLY_BASH_CMDS.has(cmd.split(/\s+/)[0]?.split('/').pop() ?? '');
}

/**
 * A3 工具配额是否应计入这一次调用（zx_20260916_1 M2）。
 *
 * 口径（§4.1① 的"计数同尺"）：**只有 `bash` / `execute_command` 按"探索类"收窄**——
 * 只读探测（`ls`/`cat`/`find`…）吃额度，**收尾命令一律不吃**（跑测试/构建/git 提交/py_compile 核验）；
 * **其余配了额度的工具每次调用都计**。
 *
 * 两处**仍未并成一次调用**，但原①已不成立（zx_20260922_1 M1 就地订正）：
 * ① ~~它的 `execute_command` 分支答的是另一个问题（只豁免 py_compile/--version）：复用会把额度尺倒过来~~
 *    ——该分支自 M1 起是「循环豁免 ∪ 只读探测」，故对**两把 shell 工具**，本函数与 `isExplorationCall`
 *    **同判**（都等于 `isReadOnlyProbeCommand`，且 `py_compile`/`--version` 在两者上都不计入）。
 *    不合并只因②仍成立：它俩对**非 shell** 工具答的仍不是同一件事（下条反证即为此设）。
 * ② `search_web`(3/5) 与 `read_web`(5/8) 既不在 `EXPLORATION_TOOLS` 里、也不是 shell 工具，
 *    若字面照搬"只计探索类"它们将**永不触发** ⇒ 两道既有闸门被**静默废掉**（不报错、不告警），
 *    违反 §4.2「不取消既有闸门」。故非 shell 配额工具一律逐次计入，未知/未来新增者也默认计入
 *    （默认方向 = 不放松闸门）。
 */
export function countsTowardToolQuota(toolName: string, args: unknown): boolean {
  if (toolName === 'bash' || toolName === 'execute_command') return isReadOnlyProbeCommand(args);
  return true;
}

// ── A1/A3 循环判据的「同一性」与「游程」（zx_20260922 M1/M2）─────────────────────
// 病根（`plans/improve/zx_20260922.md` §1.2，真任务 `a290ae2b` 实机）：判据问的是「你是不是又在用这把
// **工具**」，而它该问的是「你是不是又在做同一件事」。旧写法对非写工具一律 `return toolName`，把
// `git … status --short` / `git … log --oneline -10` / `ls -la …` 这些**互不相同**的命令读成
// 「连续 6 次调用同一工具(bash)」并硬暂停——**四步、十六秒、零产出**。
//
// 承本仓既有手法（同 `pause-reason.ts` 开篇）：抽成**零 import、不碰 DB 的纯函数**并导出，使受控回归
// 能跑**真实现**。旧实现内联在 `executeTask` 巨闭包内，**无导出、无法直调**——这正是本缺陷潜伏至今的
// 原因（rr 覆盖实测 = 0，见方案 §1.7）。
//
// ⚠ 「身份」按**完整调用**取，是刻意**不造**一条贯穿各类工具的统一本质（同「家族相似」）：写工具看
//   文件、shell 看命令、read_file 看路径，硬造通解只会再造一次误判。取完整调用后，「写不同文件属正常
//   批量」的旧特例**自动成立**（不同 filePath ⇒ 不同参数），故该特例可删而语义不丢。

/** 循环游程：**连续多少步**只在重复同一件事。`len = 0` 表示游程已断（此时 `fp` 为空串）。 */
export interface LoopRun {
  /** 命中的调用身份（`toolCallFingerprint` 的产物）；游程断时为空串 */
  readonly fp: string;
  /** 连续步数 */
  readonly len: number;
}

/** 游程已断（起手态 / 被打断后的态）。**冻结**：它是共享常量，任一处改写都会污染所有调用方。 */
export const EMPTY_LOOP_RUN: LoopRun = Object.freeze({ fp: '', len: 0 });

/**
 * 一次调用的**身份**——判「是不是同一件事」只看它，**不看工具名**。
 *
 * ⚠ 返回值**只用于判等**，**不得**直接展示：`write_file` 的 `content` 动辄几十 KB。要展示用
 *   `describeToolCall`（zx_20260922 M4）。
 */
export function toolCallFingerprint(toolName: string, args: unknown): string {
  let argKey: string;
  try { argKey = JSON.stringify(args ?? null) ?? 'null'; } catch { argKey = '(不可序列化)'; }
  return `${toolName}:${argKey}`;
}

/** 从指纹取回**工具名**（`toolCallFingerprint` 的逆）。参数 JSON 里可能含 `:`，故取**首个**分隔。 */
export function fingerprintToolName(fp: string): string {
  const i = fp.indexOf(':');
  return i < 0 ? fp : fp.slice(0, i);
}

/**
 * 把指纹转成**给人看**的一行（zx_20260922 M4）——停因可核。
 *
 * 病根（§1.2）：账上那句「连续 6 次调用 bash」是**名**，抹平了底下六件不同的事 ⇒ 判读者据此去查
 * "模型是不是卡了"，而真相是**判据误报**。误报的余毒不止停一次，还在账上留一条**错因**。
 * 带上指纹后，误报时人**一眼可判**：看见几条不同命令摆在那里，立刻知道是引擎错了。
 *
 * ⚠ 与 `toolCallFingerprint` 是**两个用途**：那个求**判等**（须逐字、可含几十 KB 的 `content`），
 *   这个求**可读**（须短、须去换行）。**不得**混用——`fp` 直接进文案会把账本撑爆。
 */
export function describeToolCall(fp: string, maxLen = 120): string {
  const name = fingerprintToolName(fp);
  const raw = fp.slice(name.length + 1);
  let summary = raw;
  try {
    const a = JSON.parse(raw) as Record<string, unknown> | null;
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      const keys = Object.keys(a);
      // 单键且值为字符串（`bash{command}` / `read_file{filePath}` 这类）⇒ 直接给值，别让 `command=` 喧宾夺主
      const only = keys[0];
      summary = keys.length === 1 && only !== undefined && typeof a[only] === 'string'
        ? String(a[only])
        : keys.map((k) => `${k}=${JSON.stringify(a[k])}`).join(' ');
    }
  } catch { /* 非 JSON（如 "(不可序列化)"）⇒ 原样用 */ }
  summary = summary.replace(/\s+/g, ' ').trim();
  if (summary.length > maxLen) summary = `${summary.slice(0, maxLen)}…`;
  return summary ? `${name}: ${summary}` : name;
}

/**
 * 给定**本步**的调用指纹与上一步的游程，返回本步之后的新游程（zx_20260922 M2）。
 *
 * 计量单位是**步**（模型的一次决策），**不是调用的个数**：
 *   本步去重后**恰 1 件**事、且与上一步那件相同 ⇒ `len + 1`；
 *   恰 1 件但与上一步不同                   ⇒ 起新游程，`len = 1`；
 *   **0 件**（本步全是只读探索）或 **≥2 件不同**的事 ⇒ 打断，`len = 0`。
 *
 * 为何按步不按次：一步内的**并行**调用不是"连续"（同一步里既发生 A 又发生 B，本身即非重复）；而"连续"
 * 也不是调用自身的属性，它由「上一步做了什么」与「这一步做了什么」和合而成。
 *
 * ⚠ 入参在函数内**去重**（幂等）：调用方传原始集合或去重集合都得到同一结果，防"另抄一份判据"。
 * ⚠ 本函数**不设窗口上限**——上限只该有 `toolLoopWarn` / `toolLoopHard` 一处来源。旧实现硬编码窗口 8，
 *   使 A股投顾项目 `warn=10 / hard=17` 的闸门**恒不可达**（静默失效，见方案 §1.5）。
 */
export function advanceLoopRun(stepFps: readonly string[], prev: LoopRun): LoopRun {
  const uniq = [...new Set(stepFps)];
  if (uniq.length !== 1) return EMPTY_LOOP_RUN;
  const fp = uniq[0]!;
  return fp === prev.fp ? { fp, len: prev.len + 1 } : { fp, len: 1 };
}

// ── D3 探索收敛闸的"处置粒度"判据（zx_20260917 M5b·病根④）────────────────────────
// 病根：**同一文件里两把尺**——计数（`:exploreCmdN++`）按**命令的种类**收窄（跑测试/`git commit` 不计数），
// 而禁用动作却按**工具的名字**整工具拉黑（含 `bash`/`execute_command`）⇒ 收尾命令一起被弹回。
// 治法：把"这个工具的**每一次**调用都是探索吗"变成一处可判的事实，禁用动作按它分流。

/**
 * **混合类** shell 工具：同一工具**既可探索也可收尾**（`ls` vs `git commit`）
 * ⇒ 只能**逐调用**判，**不得整工具禁用**。**唯一一处列举**——D3 的计数尺与处置尺都读它，
 * 尺一与尺二因此不可能再分家（本批的靶心）。
 */
export const MIXED_SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'execute_command']);

/** D3 的**处置范围**（唯一一处列举）：原本是 `killKeys` 里的行内字面量。含混合类，故**不能**由纯探索集推出 */
export const D3_GATE_TOOLS: readonly string[] = ['search_content', 'search_web', 'execute_command', 'bash'];

/**
 * 该工具的**每一次**调用是否都是探索——`true` ⇒ 整工具禁用与逐调用判**同义**；`false` ⇒ 只能逐调用判。
 *
 * ⚠ **不得**把 `search_web` 补进 `EXPLORATION_TOOLS` 来实现本函数：`EXPLORATION_TOOLS` 是
 * **循环检测与 A3 配额**的口径，`countsTowardToolQuota` 依赖 `isExplorationCall('search_web') === false`
 * 才能让 3/5、5/8 两张配额闸继续生效（见其注释②与 `rr_zx_20260916_1` 的断言）；合并会把 A3 的尺**倒过来**。
 * 故此处把"非 shell 的纯搜索工具"当作**本函数自己的**第三个事实来源，与上面两个常量并列、各列一次。
 *
 * ⚠ 也**不得**用它冒充"是否属 D3 处置范围"：`read_file`/`list_files` 等纯探索工具**不在**
 * `D3_GATE_TOOLS` 里（D3 有意保留它们作为探索出路），本函数对它们仍如实答 `true`。
 */
export function isExplorationToolAlways(toolName: string): boolean {
  if (EXPLORATION_TOOLS.has(toolName)) return true;
  if (toolName === 'search_web') return true; // 网络搜索无"收尾"用法
  return D3_GATE_TOOLS.includes(toolName) && !MIXED_SHELL_TOOLS.has(toolName);
}

/** `toolMap` 条目的最小形状（它本身是 `Record<string, unknown>`，故按结构表达而非 SDK 类型） */
export interface ToolStubLike {
  description?: string;
  parameters?: unknown;
  execute: (args: unknown, opts?: unknown) => unknown;
}

/**
 * 把**混合类**工具包成"**仅拒探索调用**"的桩（zx_20260917 M5b·病根④）：收尾调用**原样委托**原实现。
 *
 * 与 `disableToolGracefully`（整工具禁用）**并列而非取代**——纯探索工具仍走整工具禁用。
 * ⚠ 调用方须用**独立**的记账集合（不是 `disabledTools`）：本桩之后该工具**仍然可用**，
 * 记进 `disabledTools` 会把"收尾照常"谎报成"整个工具没了"，且会让预算档位等按它分支的逻辑误判。
 */
export function makeNonExplorationCappedTool(toolName: string, original: ToolStubLike, reason: string): ToolStubLike {
  return {
    ...original,
    execute: async (args: unknown, opts?: unknown) =>
      isExplorationCall(toolName, args) ? JSON.stringify({ error: reason }) : original.execute.call(original, args, opts),
  };
}

// zx_20260910_5 M1: 预算带位骨架（单一真源）——token 闸与费用闸共用同一档位定义，防判据分身（zx_20260910_3 G5 教训）。
// 98%→5 硬收尾 / 95%→4 禁探索 / 75%→3 收敛(研究/文档类禁搜索) / 60%→2 预警 / 否则 1
export function budgetBandOf(ratio: number): number {
  return ratio >= 0.98 ? 5 : ratio >= 0.95 ? 4 : ratio >= 0.75 ? 3 : ratio >= 0.60 ? 2 : 1;
}

/**
 * zx_20260922_1 M6（F10）: 两档预算闸**实际保留**的工具集合——导出以便受控回归跑**真名单**，
 * 而不是在断言里照抄一份（照抄证的是夹具自己）。
 *
 * - `BUDGET_HARD_STOP_TOOLS`（band ≥ 5，98% 硬上限）：只留产出/收尾 + 求助。
 *   ⚠ `escalate_to_human` **必须在册**：它不读不写不耗上下文，与"禁读禁执行防上下文膨胀"不冲突；
 *   而硬上限正是最需要求助的一刻——此前漏登，真库标本 `a290ae2b` 07:17:40 的求助被亲手挡回。
 * - `BUDGET_WARN_TOOLS`（band ≥ 4，95% 档）：额外保留读/执行/edit_file 以完成当前原子改动，
 *   外加 `create_task`（见下）。
 *
 * ⚠ `create_task` **只在 band 4 保留、band 5 仍禁**（zx_20260923 M4-b）：它不读盘、不执行、不回传
 *   上下文，"把活派出去"恰是预算告警时最该继续的能力。真库标本 `a290ae2b` 的 07:13:45 会话行里，
 *   一个被题面要求"逐里程碑建子任务"的任务，在花到 95% 的那一刻被本名单亲手关掉了 `create_task`，
 *   08:00 又因"没建子任务"被缺口核查拦下——**门是自己关的，锁是自己上的**。硬上限（98%）仍禁：
 *   到那一步系统的要求是收尾，不是再开新摊子。
 *
 * ⚠⚠ `update_task_status` **两档**都必须在册（zx_20261013_2 批二，与上一条**同形复发**）：
 *   它是**收尾工具**（改既定/子任务终态），与 `finalize_task` 同族；而 `finalize_task` 的收口前提恰是
 *   "子任务全终态"⇒ 少了它，band 5 就成了"门是本名单关的、锁也长在本名单上"的**结构死锁**：
 *   `finalize_task` 因"子任务未终态"被拒、`update_task_status` 又不在手上 ⇒ **无路可退**。
 *   真库标本 `7c39678e`（2026-10-13）逐字承认此死锁，唯一逃生口只剩 `escalate_to_human`。
 *   两档都补：band 4（95%）有**同一个洞**（`finalize_task` 也在册），只堵 band 5 会在 band 4 复发。
 *   ⚠ 已复核"它能否被用来改分逃逸质量闸"：**否**——该工具**无任何写分入参**，分一律由
 *   `assessCompletionQuality` 从产出证据算出（`tools/control.ts` 的 `update_task_status.execute`），
 *   且 `selfCompleteBan` 禁止把**当前执行中**的任务自标 `completed`。故无需"band 5 只许置终态不许改分"
 *   的额外围栏。边界仍由 `create_task`/写类工具继续守着（本名单**不放**它们进 band 5）。
 *
 * **不在册的即被禁用**（`disabledTools.add`）。改动这两份名单等于改"预算到顶还能干什么"，勿随手加。
 */
export const BUDGET_HARD_STOP_TOOLS = [
  'write_file', 'create_deliverable', 'register_deliverable', 'finalize_task', 'update_task_status', 'ask_user', 'escalate_to_human',
] as const;

export const BUDGET_WARN_TOOLS = [
  'write_file', 'create_deliverable', 'register_deliverable', 'finalize_task', 'update_task_status', 'ask_user', 'escalate_to_human',
  'read_file', 'execute_command', 'bash', 'edit_file', 'create_task',
] as const;

// zx_20260910_6 M1（语言游戏）：金额上限是一场**承诺游戏**——须有许诺者。
// 原三级链 `Number(task) || Number(project) || ARCHETYPE_BUDGETS[archetype].cost` 把
// "用户设的"与"系统凭空兜底的"坍缩成同一个数（真库事故见 PLAN_zx_20260910_6 §0.1），
// 于是一个从无校准依据的常量冒充了用户意图。此处让**来源**成为一等公民：
// 只有任务级或项目级**显式设过**（有限且 >0）才返回 >0，否则如实为 0（= 无金额闸）。
export function resolveCostBudget(
  taskCtx: { max_cost_usd_per_task?: number },
  projBudget: { max_cost_usd_per_task?: number },
): { maxCost: number; src: 'task' | 'project' | 'none' } {
  const t = Number(taskCtx?.max_cost_usd_per_task);
  if (Number.isFinite(t) && t > 0) return { maxCost: t, src: 'task' };
  const p = Number(projBudget?.max_cost_usd_per_task);
  if (Number.isFinite(p) && p > 0) return { maxCost: p, src: 'project' };
  return { maxCost: 0, src: 'none' }; // 没有许诺者 ⇒ 不是上限
}
