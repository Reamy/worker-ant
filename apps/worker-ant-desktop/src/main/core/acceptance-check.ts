/**
 * zx_20260910_3 M1 (2026-09-10)「名实相符」：验收核对的结局账实。
 *
 * 病根（G1，真库实证）：`checkAcceptanceCriteria` 此前用**同一个 `null`** 承载四种互斥结局——
 * 无模型 / LLM 未吐 JSON / 核对异常 / **真通过**；而落库只在"真通过"那一支。调用方无从分辨，
 * 一律记 `[PASS] 验收标准已核对达成` ⇒ 132 任务里 `acceptance_check` 写入数 **0**、
 * `acceptance_verified=1` **0**，却有 3 条"验收达成"的痕（名与实脱钩）。
 *
 * 治法（维特根斯坦§243「私人语言不可能」——意义即用法，四种结局必须各有其名；
 *       道德经·七十一章「知不知，上；不知知，病」——没核验就如实记"没核验"，不冒名通过）：
 *   1. 结局拆为可判定的判别式联合 `AcceptanceOutcome`（M1a）；
 *   2. **四个出口都落账**，载荷带 `verified` 布尔——让"没核验"与"核验通过"不再共用无名返回值；
 *   3. `isAcceptanceVerified` 是全系统**唯一**的"这份验收算不算验过"判据，供下游各读点共用（M1c），
 *      防"只加记录不改下游 ⇒ 下游按 checked_at 认已验证 ⇒ 把冒名 PASS 换成冒名 ✓"（头重脚轻）。
 *
 * 本模块只依赖 `better-sqlite3` 类型，不引 electron／不引 ai，供受控回归跑真实现。
 */
import type Database from 'better-sqlite3';

/** 单条验收标准的 LLM 原始结论 */
export interface AcceptanceCheckItem {
  criterion?: string;
  passed?: boolean;
  reason?: string;
}

/**
 * 未取得结论的成因（互斥且可判定）。
 *
 * zx_20260915 P0-2(a)（维特根斯坦·意义即用法）增 `'no_criteria'`：**「没设验收标准」也是一种结局**，
 * 且与"验过了"必须**不同名**。此前它连一种结局都不是——`if (acceptanceCriteria.trim())` 直接跳过，
 * 于是真库 150/162（93%）任务既无标准、也无任何一笔账，界面上与"完成 + 95 分"长得一样。
 *
 * zx_20260916 M1（维特根斯坦「家族相似」不得混名 / 道德经·七十一章「知不知，上」）增
 * `'no_user_criteria'`：**「用户没许诺判据，但引擎已代拟并逐条自核」**与 `'no_criteria'`
 * （**无人许诺、也无从代拟**）是**两回事**，各有其名。真库实测：completed 且
 * `acceptance_criteria` 为空者 **151 条**，而账上仅 2 笔——账本第一笔就是"无人许诺"。
 * 规划类任务本职即产出方案，"方案已写入指定路径"这类判据**客观存在且可机检**，
 * 缺的只是"有人把它落成判据"这一动作。
 */
export type AcceptanceUnverifiedReason = 'no_model' | 'no_json' | 'error' | 'no_criteria' | 'no_user_criteria' | 'output_insufficient';

/** 判据的**来源**（`criteria_source`）。`declared`＝用户/上游许诺；`engine_proposed`＝引擎代拟。 */
export type AcceptanceCriteriaSource = 'declared' | 'engine_proposed';

/** 代拟判据的逐条自核结论。`basis` 记**代拟依据**——凭空无据者不得入列（见 `proposeAcceptanceCriteria`）。 */
export interface ProposedCriterionCheck {
  criterion: string;
  /** 该判据是从任务自身何处派生的（标题/描述/在册产出物）——"凭空代拟"的反证锚点 */
  basis: string;
  passed: boolean;
  note?: string;
}

/** 落 `ctxJson.acceptance_check` 的载荷。`verified` 是下游唯一的"算不算验过"判据 */
export interface AcceptanceCheckPayload {
  checked_at: string;
  verified: boolean;
  criteria_total: number;
  passed_total: number;
  passed: string[];
  failed: Array<{ criterion: string; reason: string }>;
  /** 仅 `verified=false` 时出现：说明"为什么没核验" */
  reason?: AcceptanceUnverifiedReason;
  /**
   * 判据来源。**仅 `'engine_proposed'` 时出现**——缺席即"用户/上游许诺"（存量载荷亦如此，
   * 故读点一律走 `criteriaSourceOf`，不各自判 `undefined`）。沿用本文件既有形态
   * （`AcceptanceSummary.reason` 亦"仅一种状态出现"），不为此给存量载荷加迁移。
   */
  criteria_source?: AcceptanceCriteriaSource;
  /** 代拟的判据文本（`criteria_source==='engine_proposed'` 时出现） */
  proposed?: string[];
  /** 代拟判据的逐条自核结论（同上）。**自核 ≠ 验收**——`verified` 恒为 false */
  proposed_checked?: ProposedCriterionCheck[];
}

/**
 * `criteria_source` 的唯一读点。**缺席一律读作 `'declared'`**——
 * 存量载荷（含 zx_20260915 及更早）本就没有该键，含义正是"由任务上写的判据核验"。
 * 各读点不得自己判 `undefined`（防"同一判据两处手抄"）。
 */
export function criteriaSourceOf(ac: AcceptanceCheckLike | undefined): AcceptanceCriteriaSource {
  return ac?.criteria_source === 'engine_proposed' ? 'engine_proposed' : 'declared';
}

/** 验收核对的四种结局 */
export type AcceptanceOutcome =
  | { ran: true; passed: true }
  | { ran: true; passed: false; block: string }
  | { ran: false; reason: AcceptanceUnverifiedReason };

/** 成因码 → 人可读短语（供 `[WARN]` 文案与面板展示） */
export const UNVERIFIED_REASON_LABEL: Record<AcceptanceUnverifiedReason, string> = {
  no_model: '无可用模型',
  no_json: '模型未输出可解析的核对结论',
  error: '核对过程异常',
  no_criteria: '未设验收标准',
  no_user_criteria: '无人许诺判据（引擎已代拟，代拟≠许诺）',
  // zx_20260920_1 M3（面二）: 本 run 在「产出内容不充分」闸上就 return 了，**从未进入验收判定**。
  //   与上五码都不同名：既不是没模型/没吐 JSON/异常，也不是"无人许诺判据"（判据可能就是有的，只是这轮没走到）。
  output_insufficient: '产出内容不充分，未进入验收判定',
};

/**
 * 真核验载荷（`verified: true`）。逐条保留通过项 criterion 文本 + 拒收项 reason，供「验收标准核对」面板复盘。
 * 全系统唯一实现（原在 agent-executor.ts，zx_20260910_3 M1 迁入本模块与未核验载荷并列——
 * 让"真核验"与"没核验"两种载荷在同一处成对定义，谁也不能只改一半）。
 */
export function buildAcceptanceCheckPayload(
  checks: Array<{ criterion?: string; passed?: boolean; reason?: string }>,
  checkedAt: string = new Date().toISOString(),
): AcceptanceCheckPayload {
  const failed = checks.filter((c) => c.passed === false);
  return {
    checked_at: checkedAt,
    verified: true,
    criteria_total: checks.length,
    passed_total: checks.length - failed.length,
    passed: checks.filter((c) => c.passed !== false).map((c) => String(c.criterion ?? '').trim()).filter(Boolean),
    failed: failed.map((c) => ({ criterion: String(c.criterion ?? '').trim() || '未命名', reason: String(c.reason ?? '').trim() || '未说明' })),
  };
}

/**
 * zx_20261030_2 M4（墨经·「举，拟实也」/ 维特根斯坦·意义即用法）: **验收未达的摘要**，
 * 判据与理由**同价**——不把「因为什么没过」丢在账本里。
 *
 * 病根（§1.6 D5）：`payload.failed[]` 早已带 `{criterion, reason}`，但记忆与 pitfall 卡都只取
 * `criterion` 拼一串判据名 ⇒ 下一棒只看到"哪几条没过"，看不到"为何没过"，于是只能重犯同一错。
 *
 * 格式固定（**一处真源**，两个写口共用同一个字符串）：`判据（原因）`，多条以 `；` 连接；
 * 最多 `max` 条，其余以 `另 N 条` 收口；criterion/reason 为空分别记 `未命名`/`（未说明）`——
 * 与 `buildAcceptanceCheckPayload` 的既有默认一致。
 */
export function summarizeAcceptanceFailures(
  failed: ReadonlyArray<{ criterion?: string; reason?: string }>,
  max = 3,
): string {
  const items = failed.map((f) => {
    const criterion = String(f.criterion ?? '').trim() || '未命名';
    const reason = String(f.reason ?? '').trim() || '未说明';
    return `${criterion}（${reason}）`;
  });
  if (items.length === 0) return '';
  const shown = items.slice(0, Math.max(0, max));
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join('；')}；另 ${rest} 条` : shown.join('；');
}

/**
 * 未核验载荷。`criteria_total: 0` 是刻意的——面板不得显示一个假的 "0/0 已达成"，
 * 而要显示"未核验 + 原因"；下游也只认 `verified` 而非计数。
 */
export function buildUnverifiedCheckPayload(
  reason: AcceptanceUnverifiedReason,
  checkedAt: string = new Date().toISOString(),
): AcceptanceCheckPayload {
  return {
    checked_at: checkedAt,
    verified: false,
    reason,
    criteria_total: 0,
    passed_total: 0,
    passed: [],
    failed: [],
  };
}

/** 代拟的输入。**纯数据**——调用方取好再传，本模块不碰库、不碰 FS（故 rr 可直跑真实现）。 */
export interface ProposeCriteriaInput {
  title?: string | null;
  description?: string | null;
  /**
   * **已在册、且已按探针尺滤过**的产出物。探针滤除由调用方用 `selectProbeDeliverables`/`docNotProbe`
   * 那把**唯一的尺**完成——本模块**刻意不复刻**一份探针正则（同判据两处手抄即分叉之源）。
   */
  deliverables: Array<{ name?: string | null; type?: string | null; status?: string | null; file_path?: string | null }>;
  /** 路径存在性探针。**由调用方注入**（本模块零 FS 依赖）。缺省视为"无法核实"，如实记 passed=false。 */
  pathExists?: (p: string) => boolean;
  /**
   * 相对路径解析基准（zx_20261022_1 批三）。**由调用方注入**（本模块零 FS/零 cwd 依赖）。
   * 生产注入 `p => path.isAbsolute(p) ? p : path.join(workingDir, p)`——`workingDir` 取
   * `wa_projects.working_dir`。缺省 ⇒ 相对字面量不解析（如实记"无法核实"，不按 cwd 猜）。
   */
  resolveRelative?: (p: string) => string;
}

/** 代拟的产物：判据文本 + 逐条自核结论（形状与 `AcceptanceCheckPayload.proposed*` 一致）。 */
export interface ProposedCriteria {
  proposed: string[];
  checked: ProposedCriterionCheck[];
}

/** 描述里显式写出的路径字面量（含扩展名者方算"指定路径"，避免把普通词当路径）。 */
const PATH_LITERAL_RE = /(?:[A-Za-z0-9_][A-Za-z0-9_./\\-]*\/)?[A-Za-z0-9_-]+\.(?:md|py|ts|tsx|js|json|yaml|yml|txt|sql|csv)/g;

const basenameOf = (p: string): string => p.split(/[\\/]/).pop() || p;

/**
 * 代拟验收判据（zx_20260916 M1）。
 *
 * 病根：规划类任务本职即产出方案，"方案写入指定路径""收口前不得越界实施"这类判据
 * **客观存在且可机检**，却无人把它落成 `acceptance_criteria` ⇒ 收口时如实记 `no_criteria`。
 * 账诚实了，却是"无人许诺"的一笔空账（真库 151 条 completed 无判据）。
 *
 * 本条**只解决"有人把它写下来并自核"**，**不解决"它算不算验过"**——故调用方产出的载荷
 * `verified` 恒为 `false`（道德经·七十一章「知不知，上」：引擎拟题 + 引擎判卷 = 自证，
 * 不得包装成"验收通过"；维特根斯坦「意义即用法」：判据须落成**可复核的文本**，
 * 不能只在模型上下文里"心里有数"）。
 *
 * 两条代拟规则，**各自只在任务自身找得到依据时才产出**（凭空代拟即编造，宁可返回空）：
 *   ① 产出落盘   —— 依据：在册产出物的 `file_path`（每份一条，上限 3）
 *   ② 指定路径   —— 依据：标题/描述里**显式写出**的路径字面量（上限 3）
 * 两条皆无依据 ⇒ 返回空 ⇒ 调用方**回落 `no_criteria`**（不得为凑数编判据）。
 *
 * ⚠ 规划方案原列的第三条「未越界实施（确认前无文件改动）」**已就地删除**，理由是可查性而非价值：
 *   它的唯一诚实输入是 `executeTask` 内的**运行期内存计数** `fileMutationCount`（`agent-executor.ts:3466`），
 *   而收口实际走的是 finalize 路（真库 `c731c640` 的 `finalize_checks` 含 `[INFO] 未设验收标准` 可证），
 *   该计数**不在其作用域**内；落库的替代品 `file.*` 事件则被本仓**明文否决**过当判据
 *   （`agent-executor.ts:269-272`：「emit 失败被 `.catch(()=>{})` 吞——以它为判据＝以'事件恰好没丢'为判据」）。
 *   更没有失实更坏的是**误报**：本仓规划任务的产出**就是那份方案文档**，实测 `c731c640` 有 10 次 `file.*`
 *   却全部落在在册产出物上——按"改动数 == 0"判，会把**唯一那个合题的任务**记成未达成。
 *   故按"判据须能被合法数据满足"收窄，不回填。若日后要恢复，须先给出一个**收口时可读**的越界口径。
 */
export function proposeAcceptanceCriteria(input: ProposeCriteriaInput): ProposedCriteria {
  const text = `${input.title ?? ''} ${input.description ?? ''}`;
  const probe = input.pathExists;
  const checked: ProposedCriterionCheck[] = [];
  const push = (criterion: string, basis: string, passed: boolean, note?: string) => {
    if (checked.some((c) => c.criterion === criterion)) return; // 去重：同一条判据只落一次
    checked.push({ criterion, basis, passed, note });
  };
  const filePaths = input.deliverables
    .map((d) => ({ name: String(d.name ?? '').trim(), fp: String(d.file_path ?? '').trim() }))
    .filter((d) => d.fp);

  // ① 产出落盘：在册产出物（调用方已滤探针）。无探针 ⇒ 如实记"未能核实"，**不记 passed**
  for (const d of filePaths.slice(0, 3)) {
    const exists = probe ? probe(d.fp) : false;
    push(`产出物已落盘：${basenameOf(d.fp)}`, `在册产出物「${d.name || basenameOf(d.fp)}」的 file_path`,
      exists, !probe ? '未能核实（未注入路径探针）' : exists ? undefined : `未在路径上找到：${d.fp}`);
  }

  // ② 指定路径：文本里显式写出的路径字面量。**判据落在"在册产出物的 file_path 是否落在该路径上"**——
  //   刻意不 `fs.existsSync(字面量)`：那是相对进程 cwd 解析的，而本任务的工作目录是**被分析的那个仓库**，
  //   一字面量在 cwd 下必不存在 ⇒ 会把每条"指定路径"判成未达成（真库 c731c640 即此形）。
  //   以"在册产出物"为证据源，既与 cwd 无关，也与①同源（同一份已滤探针的清单）。
  const literal = [...new Set((text.match(PATH_LITERAL_RE) ?? []))].slice(0, 3);
  for (const p of literal) {
    const hit = filePaths.find((d) => d.fp === p || d.fp.endsWith(`/${p}`) || d.fp.endsWith(`\\${p}`));
    // zx_20261022_1 批三（毛选·实践论 / 判据须能被合法数据满足）：未命中在册行时，按**项目工作目录**
    //   解析该字面量再探一次。原实现只认在册行 ⇒ 文件真落盘也不算，该判据在"登记没走到这条任务"
    //   （工程级查重把行留在别的任务名下）时**恒不可达**（真库标本 `c731c640`）。
    //   仍不直接 `fs.existsSync(字面量)`——那按进程 cwd 解析，既有注释已证伪；基准由调用方注入。
    const resolved = hit ? hit.fp : (input.resolveRelative ? input.resolveRelative(p) : '');
    const exists = resolved && probe ? probe(resolved) : false;
    push(`产出写入指定路径：${p}`, '任务文本中显式写出的路径字面量', exists,
      !probe ? '未能核实（未注入路径探针）'
        : exists ? undefined
          : hit ? `文件不在路径上：${hit.fp}`
            : resolved ? `在册产出物中没有落在该路径上的文件，且项目工作目录下不存在该路径：${resolved}`
              : '在册产出物中没有落在该路径上的文件（未注入工作目录基准，相对路径无法解析）');
  }

  return { proposed: checked.map((c) => c.criterion), checked };
}

/**
 * 代拟载荷（`criteria_source:'engine_proposed'`）。
 *
 * **核心不变量：`verified` 恒为 `false`** ⇒ `isAcceptanceVerified` 必返回 false ⇒
 * 下游绝不据此打 ✓ / 徽标 / 配方。自核结论放在 `proposed_checked` **而非** `passed/failed`——
 * 那不是"验收结果"，是"引擎对自己代拟项的核对"，两者**不得同名**（承 zx_20260915 四结局分列之义）。
 *
 * `criteria_total`/`passed_total` 沿用"未核验不报计数"的既有语义，保持 0——
 * 面板据此不会显示一个假的 "N/N 已达成"。
 */
export function buildProposedCheckPayload(
  criteria: ProposedCriteria,
  checkedAt: string = new Date().toISOString(),
): AcceptanceCheckPayload {
  return {
    checked_at: checkedAt,
    verified: false,
    reason: 'no_user_criteria',
    criteria_source: 'engine_proposed',
    criteria_total: 0,
    passed_total: 0,
    passed: [],
    failed: [],
    proposed: criteria.proposed,
    proposed_checked: criteria.checked,
  };
}

/**
 * 扫出文本中所有**括号配平**的 `[...]` 候选跨度（字符串字面量内的 `[` `]` 不计深度，`\` 转义不误闭合该串）。
 * 逐起点枚举是刻意的：单次贪婪/非贪婪都只能给出一个跨度，而"数组之外的括号"（前置 `[分析]`／后置 `[附注]`）
 * 会让那个跨度含入非 JSON 文本 ⇒ 解析必败（E22）。候选枚举 + 逐个试解析才对这些真实输出成立。
 */
function bracketBalancedSpans(text: string): string[] {
  const spans: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '[') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) { spans.push(text.slice(i, j + 1)); break; }
      }
    }
  }
  return spans;
}

/**
 * 条目定型（**外部输入边界**净化）。`passed` 只认布尔；字符串 `"true"/"false"` 与 `1/0` 归一到布尔。
 * 病根（与 G1 同源、方向相反）：模型吐 `"passed":"false"` 时 `c.passed === false` 为假 ⇒ 拒收项被计**通过**。
 * 缺 `passed` 字段的旧语义（计通过）保持不变——不借净化之机改判。
 */
function normalizeCheckItem(raw: unknown): AcceptanceCheckItem {
  const it = (raw ?? {}) as Record<string, unknown>;
  return {
    criterion: it.criterion as string | undefined,
    passed: coercePassed(it.passed),
    reason: it.reason as string | undefined,
  };
}

function coercePassed(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 1) return true;
  if (v === 0) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return undefined;
}

/**
 * 从 LLM 原始文本提取逐条核对结论。提取/解析失败一律返回 `null`（**不抛**）——
 * 调用方据此落 `no_json` 结局，而不是把异常咽掉当作"通过"。
 *
 * zx_20260910_3 M1b（E22 修复）：原用**贪婪** `text.match(/\[[\s\S]*\]/)`——任何位于数组之外的前置 `[` 或
 * 后置 `]` 都让匹配区间含入非 JSON 文本，6 种真实模型输出里 3 种解析必败，且静默降级为冒名 `[PASS]`。
 * 改为括号配平候选枚举（见上），并对候选做**仅限边界**的尾逗号容错。
 * 对象包裹（`{"checks":[…]}`）中的数组**字面存在**于文本中 ⇒ 作为候选跨度自然被取到（**不解读键名**、不猜语义）；
 * 文本里根本没有可解析的数组时 → `null` → 如实记 `no_json`，不编造。
 */
export function parseAcceptanceChecks(text: string): AcceptanceCheckItem[] | null {
  if (!text) return null;
  for (const span of bracketBalancedSpans(text)) {
    try {
      const parsed = JSON.parse(span.replace(/,\s*([\]}])/g, '$1')) as unknown;
      if (Array.isArray(parsed)) return parsed.map(normalizeCheckItem);
    } catch { /* 非 JSON 或非数组 → 试下一候选跨度 */ }
  }
  return null;
}

/**
 * 纯决策：给定"模型是否走通"与"LLM 原始文本"→ 结局 + 待落账条目。
 * 四个出口（无模型／未吐 JSON／异常／真通过）全在此判定，agent-executor 只负责取数与落账，不再自己判。
 */
export function decideAcceptanceOutcome(input: {
  kind: 'ok' | 'no_model' | 'exception';
  text: string | null;
}): { outcome: AcceptanceOutcome; checks: AcceptanceCheckItem[] } {
  if (input.kind === 'no_model') return { outcome: { ran: false, reason: 'no_model' }, checks: [] };
  if (input.kind === 'exception') return { outcome: { ran: false, reason: 'error' }, checks: [] };
  const checks = parseAcceptanceChecks(input.text || '');
  if (!checks) return { outcome: { ran: false, reason: 'no_json' }, checks: [] };
  const failed = checks.filter((c) => c.passed === false);
  if (failed.length === 0) return { outcome: { ran: true, passed: true }, checks };
  const block = JSON.stringify({
    error: `验收标准未达成（${failed.length} 项），请补齐后再 finalize：\n${failed.map((f) => `- ${f.criterion}: ${f.reason || '未说明'}`).join('\n')}`,
    failedAcceptance: failed,
  });
  return { outcome: { ran: true, passed: false, block }, checks };
}

/**
 * 落账（读改写，只动 `acceptance_check` 一个键，零 schema 变更）。
 * best-effort：落库失败不抛——不因记账失败阻断 finalize。
 *
 * zx_20260923_1 M1（德经·五十四章「善建者不拔」）：**返回值改读回语义**——
 * 返回**账上现在生效的那一笔**（被守卫拦下时即旧账），而非"刚提交的那一笔"。
 * 调用方据此得知"我这笔到底落没落上"，不必自己再读一次库、也无从误以为已落上。
 */
export function persistAcceptanceCheck(
  db: Database.Database,
  taskId: string,
  payload: AcceptanceCheckPayload,
): AcceptanceCheckPayload {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined;
    const ctx = JSON.parse(row?.context_json || '{}') as Record<string, unknown>;
    const prev = ctx.acceptance_check;
    if (!maySupersedeLedger(prev, payload)) {
      // 非结论不得覆盖结论（见 `maySupersedeLedger`）：账上保持原样，如实回传旧账。
      return prev as AcceptanceCheckPayload;
    }
    ctx.acceptance_check = payload;
    db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), taskId);
    return payload;
  } catch { /* 验收证据落库 best-effort */ }
  return payload;
}

/**
 * 结局 → 载荷 → 落账。**四种结局无一例外**都经此落一笔（这正是 G1 的修复点：
 * 此前只有"真通过"那一支落库，另外三种结局静默返回 null ⇒ 台账恒 0）。
 * 抽为单一函数是刻意的——调用方无从在某个出口上"忘记落账"，回归也跑这份真实现而非复刻判据。
 *
 * ⚠ 返回值是**账上生效的那一笔**（可能因守卫仍是旧账）——调用方不得假定它等于本支的载荷。
 */
export function recordAcceptanceOutcome(
  db: Database.Database,
  taskId: string,
  decided: { outcome: AcceptanceOutcome; checks: AcceptanceCheckItem[] },
): AcceptanceCheckPayload {
  const payload: AcceptanceCheckPayload = decided.outcome.ran
    ? buildAcceptanceCheckPayload(decided.checks)
    : buildUnverifiedCheckPayload(decided.outcome.reason);
  return persistAcceptanceCheck(db, taskId, payload);
}

/**
 * 代拟结局 → 载荷 → 落账。与 `recordAcceptanceOutcome` **成对**：两者都只经 `persistAcceptanceCheck`
 * 落库，调用方无从在某一支上"忘记落账"。载荷本身恒 `verified:false`（见 `buildProposedCheckPayload`）。
 *
 * ⚠ 同上一函数：返回值是**账上生效的那一笔**——若账上已有真结论，代拟**不得**把它顶掉。
 */
export function recordProposedCheck(
  db: Database.Database,
  taskId: string,
  criteria: ProposedCriteria,
): AcceptanceCheckPayload {
  const payload = buildProposedCheckPayload(criteria);
  return persistAcceptanceCheck(db, taskId, payload);
}

/** `task.completed` 事件载荷里的验收三态摘要（`AcceptanceCheckPayload` 的窄面）。 */
export interface AcceptanceSummary {
  verified: boolean;
  criteria_total: number;
  passed_total: number;
  /**
   * 仅 `verified=false` 时出现。取值即 `AcceptanceUnverifiedReason` 全量——
   * **此处刻意不再抄一份清单**（zx_20260916 M1 加第五取值时，本行正是漏网的那类"第二份词表"）。
   */
  reason?: AcceptanceUnverifiedReason;
}

/**
 * 载荷 → 事件摘要。**两个收口出口（finalize :3961 / run_close :4370）共用同一形状**——
 * zx_20260915 P0-2(d)：此前只有 run_close 带验收，同一事件类型在两个出口上形状不同，
 * 下游无法区分「走 finalize、账上就是 no_criteria」与「老生产者压根没这个字段」。
 *
 * 无 `checked_at` ⇒ 返回 `undefined`（"没这笔账"与"账上是未通过"是两回事，不编默认态）。
 */
export function toAcceptanceSummary(ac: AcceptanceCheckLike | undefined): AcceptanceSummary | undefined {
  if (!ac || !ac.checked_at) return undefined;
  // 先取成因码：`isAcceptanceVerified` 是**类型谓词**且其断言型与入参同型，
  // 于是它一旦被调用，`ac` 在其假分支就被窄化成 `never`（`ac.reason` 取不出来）——
  // 这不是写法问题，是"判据的断言型与读点形状是同一个"的必然结果。
  const reason = ac.reason;
  const verified = isAcceptanceVerified(ac);
  return {
    verified,
    criteria_total: Number(ac.criteria_total) || 0,
    passed_total: Number(ac.passed_total) || 0,
    reason: verified ? undefined : reason,
  };
}

/**
 * 读任务的验收标准。**唯一一句 SQL**——finalize 收口与 run_close 收口都从这里取，
 * 不各写一份（zx_20260915 P0-2(b)，防"同一判据两处手抄"）。
 */
export function readTaskAcceptanceCriteria(db: Database.Database, taskId: string): string {
  const row = db.prepare('SELECT acceptance_criteria FROM wa_tasks WHERE id = ?').get(taskId) as { acceptance_criteria?: string } | undefined;
  return row?.acceptance_criteria || '';
}

/** 读点看到的 acceptance_check 形状（宽松——存量数据可能只有部分键） */
export interface AcceptanceCheckLike {
  checked_at?: string;
  verified?: boolean;
  criteria_total?: number;
  passed_total?: number;
  passed?: string[];
  failed?: Array<{ criterion: string; reason: string }>;
  reason?: AcceptanceUnverifiedReason;
  /** 仅 `'engine_proposed'` 时出现；读点走 `criteriaSourceOf`，不各自判 `undefined` */
  criteria_source?: AcceptanceCriteriaSource;
  proposed?: string[];
  proposed_checked?: ProposedCriterionCheck[];
}

/**
 * 全系统**唯一**的"这份验收算不算验过"判据（M1c）。各读点一律调它，不再各写各的 `checked_at` 判断。
 * 兼容存量：老数据无 `verified` 字段 → 视为已验证（那时只有"真通过"才落库）；
 * 新数据 `verified=false`（没跑成）→ 一律**不算验过**，下游不得据此打 ✓ / 徽标 / 配方。
 */
export function isAcceptanceVerified(ac: unknown): ac is AcceptanceCheckLike {
  if (!ac || typeof ac !== 'object') return false;
  const a = ac as { checked_at?: unknown; verified?: unknown };
  if (!a.checked_at) return false;
  return a.verified !== false;
}

/**
 * zx_20260923_1 M1（道德经·五十四章「善建者不拔，善抱者不脱」）:
 * **一笔新账能不能覆盖账上旧账**——落账的唯一守卫。
 *
 * 病根（真库标本 `a290ae2b` 实证，见方案 §1.1）：`persistAcceptanceCheck` 是**盲覆盖**。
 * 该任务 run-2 落下 `verified:true, criteria_total:10, passed_total:2`（**有结论：8 条未达**），
 * run-3 核对**异常**（`reason:'error'`）后又落一笔，把前者**抹掉**——账面从"有证据说没达成"
 * 洗成"没有证据"，于是 90 分、`completed`、`goal_achieved:true` 一路放行。
 * **一次"没有结论"，拔掉了一条"有结论"。**
 *
 * 规则（**拦"没判成"，不拦"判成了"**）：
 *   · 旧账本**不是结论**（缺席 / `verified:false`）⇒ 一律放行。**任何**新账都比"无账/没判成"强。
 *   · 旧账**是结论**（`verified:true`）⇒ **只有新结论**（`next.verified === true`）可取代它。
 *     故"改好了 → 重判 → 通过"（`failed` → `passed`）这条路**依然走得通**——
 *     守卫拦的是"非结论覆盖结论"，不是"结论更新结论"。
 */
export function maySupersedeLedger(prev: unknown, next: AcceptanceCheckPayload): boolean {
  if (!isAcceptanceVerified(prev)) return true;
  return next.verified === true;
}

/** 验收结论的四态（`acceptanceVerdictOf` 的值域）。**「没题目」与「有题没判成」是两回事**，不得同名。 */
export type AcceptanceVerdict = 'not_checked' | 'unjudged' | 'failed' | 'passed';

/**
 * zx_20260923_1 M2（维特根斯坦「意义即用法」）: **「有题未判成」的成因码**——词表**一处真源**。
 *
 * 与 `'no_criteria'`/`'no_user_criteria'`（**没有题目**：无人许诺判据，也无从代拟）的区别是本质的：
 * 这三个码的含义是「**题目在**（任务上写了验收标准），只是这轮**没判成**」。
 *
 * 为什么单列（承 A4 的**理据边界**，见 `acceptanceVerdictOf` 的长注释）：A4 之所以规定
 * "未核验 ≠ 未通过、不压分"，理由是**不该拿"没有题目"去罚一个规划类任务**——
 * 这条理据**只覆盖"没有题目"**。而"有题没判成"若也走同一条路（不压分**且**照标完成），
 * 就是把"这轮没判成"当成了"判过了"：真库标本 `a290ae2b` 的 `criteria` 长 348 字
 * （题目明明在），核对 `error` 后却被放行标 `completed`（方案 §1.1）。
 *
 * 渲染层是词表的**第二个落点**，故本词表与判定函数**同出一处**，`TaskDetailPage.tsx` 直接引
 * `isUnjudgedReason`，不另抄一份三码清单。
 */
export const UNJUDGED_REASONS: readonly AcceptanceUnverifiedReason[] = ['no_model', 'no_json', 'error'];

/** 该"没取得结论"的成因是不是「**有题未判成**」（判定与文案共用的唯一读点）。 */
export function isUnjudgedReason(reason: AcceptanceUnverifiedReason | undefined | null): boolean {
  return !!reason && UNJUDGED_REASONS.includes(reason);
}

/** 验收未通过时完成分的压降上限（<60，与 `agent-executor.ts` 的 D1「未达交付」同尺）。 */
export const ACCEPTANCE_FAILED_SCORE_CAP = 45;

/**
 * zx_20260916 M1（维特根斯坦「意义即用法」/ 道德经·七十一章「知不知，上」）：
 * **验收结论进完成判定的唯一判据**。完成分、终态、`goal_achieved` 三个出口一律调它，不各自复刻谓词。
 *
 * 病根（§1.1）：验收账记得对、面板也画得出，却**没有一个出口**把"未通过"传导到完成判定上 ⇒
 * 同屏出现「已完成」(绿徽) + `excellent 90分` + 「0 通过 · 8 未达」三种互相否认的口径。
 *
 * 四态之分（承 A4 裁定的**理据边界**）：
 *   · `verified === true` 且 `passed_total < criteria_total` ⇒ `'failed'`。
 *   · `verified === true` 且 `passed_total >= criteria_total` ⇒ `'passed'`。
 *   · `verified !== true` 且成因属 `UNJUDGED_REASONS`（`no_model`/`no_json`/`error`）
 *     ⇒ **`'unjudged'`**（zx_20260923_1 M2 新增）——**「有题未判成」**。
 *     题意：题目**在**（任务上写了判据），这轮**没判成**。**不压分**（一以贯之"未核验 ≠ 未通过"），
 *     但**不标完成**——"没判成"绝不能当作"判过了"放行（真库标本 §1.1 正是这样被放行的）。
 *   · 其余（缺省 / `no_criteria` / `no_user_criteria` / `output_insufficient` / 未知码 / 缺 reason）
 *     ⇒ `'not_checked'`——**「没有题目」**：A4 的理据**只覆盖这一支**（不该拿"无人许诺判据"
 *     去罚规划类任务，否则整类被压到 45 分＝另一种失实）。
 *     `output_insufficient` 留在此支是刻意的：该 run 在内容闸上就 return 了，**从未进入验收判定**，
 *     它有自己的处置（置 pending 重跑），且 `rr_zx_20260920_1` 已钉死"它不压分"。
 *
 * ⚠ 边界如实记录：`verified:true` 且 `0/0`（模型返回空数组）按上式读作 `'passed'`。它**不触发**任何
 *   压降或暂停（本判据的下游只对 `'failed'` 动作），故不改判；此边界已记入前轮方案 §十一。
 *   同理 `'unjudged'` **不压分**（`capScoreByAcceptanceVerdict` 只对 `'failed'` 动作，逐字未动），
 *   它的处置在终态层：`exec-finalize.ts` 的 `unjudged` 分支。**两处各司其职，不是两本账**——
 *   压分与否由本函数的值域唯一决定，终态由 `finalizeRunClose` 唯一决定。
 */
export function acceptanceVerdictOf(ac: unknown): AcceptanceVerdict {
  if (!isAcceptanceVerified(ac)) return isUnjudgedReason((ac as AcceptanceCheckLike | undefined)?.reason) ? 'unjudged' : 'not_checked';
  const total = Number(ac.criteria_total) || 0;
  const passed = Number(ac.passed_total) || 0;
  return passed < total ? 'failed' : 'passed';
}

/**
 * 三态 → 完成分压降。**压降阈值只此一处**（`ACCEPTANCE_FAILED_SCORE_CAP`）——两个消费点
 * （`assessCompletionQuality` 的第 4 条压降、run_close 收口的 `failed` 分支）都调它，
 * 不各写一个 `Math.min(…, 45)`（同判据两处手抄即分叉之源）。
 */
export function capScoreByAcceptanceVerdict(score: number, verdict: AcceptanceVerdict): number {
  return verdict === 'failed' ? Math.min(score, ACCEPTANCE_FAILED_SCORE_CAP) : score;
}
