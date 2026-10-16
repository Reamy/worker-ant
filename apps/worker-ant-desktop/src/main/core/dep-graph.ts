/**
 * zx_20260913 M3(维特根斯坦·同一把尺 / 王阳明·知行合一 / 康德·范畴穷尽):
 * 任务前置依赖「可解不可解」判据的**唯一真源**。
 *
 * 病灶：`hasUnmetDependencies`(`task-scheduler.ts:284-294`) 是"依赖是否满足"的**唯一运行时判据**，
 * 但它只有一把**布尔尺**（`status != 'completed'` 计数 > 0）——于是三种截然不同的事实被压成同一个 `true`：
 * ① 前置还在跑（应等）；② 前置已 `failed`/`archived`（**永不可满足**，等到过期也不会启动）；
 * ③ 前置 id 根本查不到（`depends_on='T1'` 这类笔误，真库已有）。而工具回话却对三者**一律**许诺
 * "依赖完成后自动启动"（`agent-executor.ts:1255`）/ "将在工蚁前端按序执行"（`im-router.ts:1081`）⇒ 名实不符。
 *
 * 故本模块**零依赖**（不引 electron / better-sqlite3 / node:*，同 `deliverable-types`/`settings-bool` 范式）：
 * ① 主进程与渲染层跨 root 引入**同一份代码**（renderer 是词表的**第二个落点**——G8 已钉过：
 * 它不在 `src/main` 扫描面内，手抄必漂）；
 * ② 可被受控回归直接跑真实现。
 *
 * **字节等价约束（M3-2 裁定）**：`depBlocksRun(classifyDep(...))` 必须在**所有情形**上等于旧布尔值。
 * 旧判据 = "存在**在库中查得到**且状态非 completed 的前置"。故 `unresolved`（查不到）**不阻塞**——
 * 这不是新增的宽松，而是把旧行为如实分成两个名字。
 *
 * zx_20260917 M3(「前置之因不得谎报」): 上面那把尺漏了**第四种事实**——前置已 `paused`。旧码把它并进
 * `waiting`（释义写"在正常推进，会自动解锁"），而**普通暂停没有任何自解路径**，于是回话照许诺
 * "前置完成后自动启动" ⇒ 又一处谎报。现把 `paused` 并入 `DEP_DEAD_STATUSES`。
 * **该并入并不破坏上条字节等价约束**（原方案 §5.2 预计它会被打破，实施前查证后**订正**）：
 * `paused` 原属 `waiting`（阻塞）、今属 `dead`（阻塞），`depBlocksRun` 的布尔值**逐情形不变**——
 * 本轮改的是**分类名与文案**，不是拦不拦。
 *
 * 唯一例外：`pause_reason = 'children_incomplete'`（因**等自己的子任务**而暂停）**会零人工自解**——
 * 子任务一到终态，`checkParentTaskAfterChildDone` 即把父置回 `pending` 并重新入队（`task-scheduler.ts`
 * 的 `chainStalled` 也正是为此因由才豁免祖先链判定）。把它算 `dead` 会新造一句假话（"须人工恢复它"），
 * 故**按因由细分**：该因由归 `waiting`（文案另说"其子一到终态即自动恢复，无需人工"），其余 `paused` 归 `dead`。
 * 因由判据取 `pause-reason.ts` 既有真源，不在此另写一份（该模块零依赖，跨 root 引入不损本模块的零依赖）。
 */

import { isChildrenIncompletePause, pauseReasonLabel, recordedPauseReason } from './pause-reason.js';

/** 前置依赖的可解性状态。 */
export type DepState =
  /** 全部前置 completed —— 可启动。 */
  | 'met'
  /** 有前置未完成、且**确有自解路径** —— 等待即可，会自动解锁（含因等子而暂停的前置，见下）。 */
  | 'waiting'
  /** 有前置 `failed`/`archived`/`paused`（暂停非等子所致）—— **不会自动解锁**，须人工处置。 */
  | 'dead'
  /** 有前置 id 在库中查不到（笔误/跨项目/已删）—— **不阻塞调度**（同旧行为），但须如实告知。 */
  | 'unresolved';

/** 「永不可满足」的前置状态——外置成常量，防读点各写一遍。 */
export const DEP_DEAD_STATUSES = ['failed', 'archived', 'paused'] as const;

/** 唯一「暂停」状态名——它的可解性**还取决于因由**，故不可只按状态名判死（见 `isDeadDep`）。 */
const DEP_PAUSED_STATUS = 'paused';

/** 唯一「已完成」状态名。 */
const DEP_DONE_STATUS = 'completed';

/**
 * 该前置是否「永不可满足」（= 不会自动解锁，须人工处置）。
 *
 * `paused` 不可只按状态名判：因**等自己的子任务**而暂停者会零人工自解，属"等待"；其余因由（含账上
 * 根本没记因由的存量暂停）须人工处置，属"死"。`contextJson` 未取到 ⇒ 因由未知，**保守判死**——
 * 不知情时宁可喊"须人工"，也不许诺"会自动解锁"（本轮治的就是这种许诺）。
 */
function isDeadDep(status: string, contextJson: string | null | undefined): boolean {
  if (!(DEP_DEAD_STATUSES as readonly string[]).includes(status)) return false;
  if (status !== DEP_PAUSED_STATUS) return true;
  return !isChildrenIncompletePause(contextJson);
}

/**
 * 解析 `wa_tasks.depends_on`（逗号连接的**任务 id** 串）→ 去空、去重、保序的 id 数组。
 * 序号（模板/LLM 表达形式）**不在此层**——落库前已映射为真实 id（见 M3-3）。
 */
export function parseDepIds(dependsOn: unknown): string[] {
  const raw = String(dependsOn ?? '').trim();
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 判定前置集合的可解性。`statusOf(id)` 返回 `undefined`（查不到）时按 `unresolved` 计。
 * `contextOf(id)` 给该前置的 `context_json`——**只有 `paused` 用得上它**（按因由细分，见 `isDeadDep`）；
 * 不传则 `paused` 一律按 `dead` 的保守释义计。
 *
 * 优先级：`dead` > `waiting` > `unresolved` > `met`。
 * `dead` 优先于 `unresolved`：一个前置已失败、另一个查不到时，"永不可满足"才是用户最需要知道的事实；
 * 且旧布尔值此时为 `true`（失败者被计数），故这一优先级也是**字节等价**所要求的。
 */
export function classifyDep(
  depIds: readonly string[],
  statusOf: (id: string) => string | undefined,
  contextOf?: (id: string) => string | null | undefined,
): DepState {
  if (depIds.length === 0) return 'met';
  let hasDead = false;
  let hasWaiting = false;
  let hasUnknown = false;
  for (const id of depIds) {
    const st = statusOf(id);
    if (st === undefined) { hasUnknown = true; continue; }
    if (st === DEP_DONE_STATUS) continue;
    if (isDeadDep(st, contextOf?.(id))) hasDead = true;
    else hasWaiting = true;
  }
  if (hasDead) return 'dead';
  if (hasWaiting) return 'waiting';
  if (hasUnknown) return 'unresolved';
  return 'met';
}

/**
 * 「是否因此不得启动」——调度器唯一需要的布尔。与旧 `hasUnmetDependencies` **逐情形等价**：
 * 旧值 = 存在在库且非 completed 的前置 = `waiting || dead`。
 */
export function depBlocksRun(state: DepState): boolean {
  return state === 'waiting' || state === 'dead';
}

/**
 * zx_20261012_2 批三（「停 ≠ 死」）：与 `DEP_DEAD_STATUSES` **并列**的第二个状态集——
 * 「永不可**恢复**」的前置（停在这上面就再没有出路）。
 *
 * **为什么不能复用 `DEP_DEAD_STATUSES`**：`dead` 还含 `paused`（非等子所致）。一个 `paused` 前置
 * 对"能不能自动解锁"的答案是**否**（故 `dead` 对——调度闸拦住、文案喊"须人工"，都对），但对
 * "还有没有出路"的答案是**有**（人一恢复它就活了）。两个问题此前被一个 `dead` 同时回答，
 * 于是在自愈清账那处，**策略熔断暂停**（`policy_paused`，等人工看一眼即恢复）的下游子任务
 * 被判"永无出路"直接标 `failed`——把"停"错杀成"死"（本轮事故：9 连败里一大部分是这么来的）。
 */
export const DEP_UNRECOVERABLE_STATUSES = ['failed', 'archived'] as const;

/**
 * `∃` 前置「永不可恢复」——即本任务**再没有出路**（自愈清账据此判"该标 failed"）。
 *
 * 与 `classifyDep`/`depBlocksRun` 的**分工**（两个问题此前被一个 `dead` 同时回答）：
 *   · `classifyDep`/`depBlocksRun` 答"**能不能自动解锁**"——供**调度闸**与**文案**（`paused` 算 `dead`）；
 *   · 本判据答"**还有没有出路**"——供**自愈清账**（`paused` **不算**无出路，须等人）。
 * 查不到 id（`undefined`）**不算**无出路：笔误不阻塞调度，也不该把下游判死。
 */
export function hasUnrecoverableDep(depIds: readonly string[], statusOf: (id: string) => string | undefined): boolean {
  const set = DEP_UNRECOVERABLE_STATUSES as readonly string[];
  for (const id of depIds) {
    const st = statusOf(id);
    if (st !== undefined && set.includes(st)) return true;
  }
  return false;
}

/** `dead` 前置按**实际状态**分组——三种"死"三种话（M3 病根②：此前一律说"failed/归档"）。 */
export interface DeadDepGroups {
  /** 前置 `failed`——等不到了，须先处置它（重试或归档）。 */
  failed: string[];
  /** 前置 `archived`——归档即放弃，已无完成之日。 */
  archived: string[];
  /** 前置 `paused` 且**因由已记录**——按因由分组（文案须点出"为什么停"，否则人无从处置）。 */
  paused: Array<{ label: string; names: string[] }>;
  /** 前置 `paused` 而账上**未记因由**（M1 收口前的存量直写点）——如实说"未记"，不编。 */
  pausedUnknownReason: string[];
}

/** 前置阻塞的如实描述（供任务详情/列表/回话复用——不再各处手写文案）。 */
export interface DepBlockInfo {
  state: DepState;
  /** 前置总数（含查不到者）。 */
  total: number;
  /** `waiting` 时：仍未完成的前置数。 */
  remaining: number;
  /** `dead` 时：永不可满足的前置显示名（含 `failed`/`archived`/暂停待人工三种）。 */
  deadNames: string[];
  /** `dead` 时同上，但**按实际状态/因由分组**——文案据它分说，调用方亦可分节展示。 */
  deadByStatus: DeadDepGroups;
  /**
   * `waiting` 时：因**等自己的子任务**而暂停的前置显示名——非故障，其子一到终态即自动恢复，
   * 故必须与"须人工处置的暂停"区分开（这正是本模块本轮新增的那条例外）。
   */
  selfHealingPausedNames: string[];
  /** `unresolved` 时：在库中查不到的前置 id 原文。 */
  unknownIds: string[];
  /** 人话描述；`met` 时为空串（调用方据此不渲染）。 */
  text: string;
}

/**
 * 生成如实的人话描述。`nameOf(id)` 由调用方给（详情页用 taskList 查标题，
 * 查不到时返回 id 原文或「未知任务」——由调用方决定，模块不猜）。
 *
 * `contextOf(id)` 给该前置的 `context_json`——**`paused` 的可解性取决于因由**（见 `isDeadDep`），
 * 故生产读点**必须**传它，否则暂停前置一律按保守的"须人工"说，等子的那种会被误报。
 */
export function depBlockInfo(
  depIds: readonly string[],
  statusOf: (id: string) => string | undefined,
  nameOf: (id: string) => string,
  contextOf?: (id: string) => string | null | undefined,
): DepBlockInfo {
  const state = classifyDep(depIds, statusOf, contextOf);
  const info: DepBlockInfo = {
    state, total: depIds.length, remaining: 0,
    deadNames: [], deadByStatus: { failed: [], archived: [], paused: [], pausedUnknownReason: [] },
    selfHealingPausedNames: [], unknownIds: [], text: '',
  };
  if (state === 'met') return info;

  const dead: string[] = [];
  const selfHealing: string[] = [];
  const unknown: string[] = [];
  let remaining = 0;
  for (const id of depIds) {
    const st = statusOf(id);
    if (st === undefined) { unknown.push(id); continue; }
    if (st === DEP_DONE_STATUS) continue;
    const ctx = contextOf?.(id);
    if (!isDeadDep(st, ctx)) {
      // 未完成但**有自解路径**——含因等自己的子任务而暂停者（子一到终态即自动恢复）
      if (st === DEP_PAUSED_STATUS) selfHealing.push(nameOf(id));
      remaining++;
      continue;
    }
    const nm = nameOf(id);
    dead.push(nm);
    if (st === DEP_PAUSED_STATUS) {
      const reason = recordedPauseReason(ctx);
      if (!reason) info.deadByStatus.pausedUnknownReason.push(nm);
      else {
        const label = pauseReasonLabel(reason);
        const bucket = info.deadByStatus.paused.find((p) => p.label === label);
        if (bucket) bucket.names.push(nm);
        else info.deadByStatus.paused.push({ label, names: [nm] });
      }
    } else if (st === 'archived') info.deadByStatus.archived.push(nm);
    else info.deadByStatus.failed.push(nm);
  }
  info.remaining = remaining;
  info.deadNames = dead;
  info.selfHealingPausedNames = selfHealing;
  info.unknownIds = unknown;

  // 混合情形下（dead+unknown / waiting+unknown）unknown 会因优先级被 `classifyDep` 折叠掉，
  // 但"某个 id 写错了"仍是用户该知道的事实——故两种状态都**追加**一句如实说明，不因折叠而失声。
  const unknownNote = unknown.length > 0
    ? `另有前置任务不存在：${unknown.join('、')}（不阻塞调度，请核对是否写错 id）。`
    : '';

  if (state === 'dead') {
    // 三种"死"三种话：不再把 `paused` 前置也说成"已失败/归档"（既是名不符，又诱导人白等——它不会自解）。
    const g = info.deadByStatus;
    const clauses: string[] = [];
    if (g.failed.length > 0) clauses.push(`前置已失败：${g.failed.join('、')} —— 须先处置它（重试或归档）`);
    if (g.archived.length > 0) clauses.push(`前置已归档：${g.archived.join('、')} —— 归档即放弃，已无完成之日`);
    if (g.paused.length > 0) {
      const detail = g.paused.map((p) => `${p.names.join('、')}（${p.label}）`).join('、');
      clauses.push(`前置已暂停待人工：${detail} —— **不会自动解锁**，须人工恢复它、或解除本任务对它的依赖`);
    }
    if (g.pausedUnknownReason.length > 0) {
      clauses.push(`前置已暂停：${g.pausedUnknownReason.join('、')}（账上未记因由）—— **不会自动解锁**，请先查明再处置`);
    }
    const rest = remaining > 0 ? `；另有 ${remaining} 个前置未完成` : '';
    // 一码归一码：本集合里若有**等子而暂停**的前置，它是会自解的，不能借 dead 的口气把它也说成"须人工"。
    const heal = selfHealing.length > 0
      ? `${selfHealing.join('、')} 系**因等自己的子任务而暂停**（非故障，其子任务一到终态即自动恢复，无需人工）。`
      : '';
    info.text = `${clauses.join('；')}。本任务**不会自动启动**，须人工处置前置后手动恢复${rest}。${heal}${unknownNote}`;
  } else if (state === 'waiting') {
    const names = depIds.map((id) => nameOf(id)).join('、');
    const heal = selfHealing.length > 0
      ? `其中 ${selfHealing.join('、')} 是**因等自己的子任务而暂停**——非故障，其子任务一到终态即自动恢复，无需人工。`
      : '';
    info.text = `等待前置完成：${names}（还差 ${remaining} 个）—— 前置完成后自动启动。${heal}${unknownNote}`;
  } else {
    info.text = `前置任务不存在：${unknown.join('、')} —— 不阻塞调度（请核对 depends_on 是否写错）。`;
  }
  return info;
}

/**
 * 把「同批子任务序号」（1-based）映射为真实任务 id 串（M3-3）。
 *
 * 模板/LLM 都以序号表达前置（人/模型天然按"第 1、2 个"思考），但 `wa_tasks.depends_on` 只存任务 id ——
 * 故映射**只在创建一刻**发生，库里不引入第二套格式（否则读点要各写一遍"这串是序号还是 id"的猜谜）。
 * 越界/非法序号**如实丢弃**（宁少不滥，不猜模型意图）。
 *
 * zx_20260921 M6（D4 断点②）：**自环同样丢弃**。调用方逐个建子任务，`childIds[i]` 此刻**已在数组里**
 * ——模型（或模板）把第 i 个的前置写成序号 `i+1` 时，映射结果就是**它自己**。而 `depends_on` 含自身
 * 会让 `hasUnmetDependencies` 永远为真 ⇒ 该子任务恒 `waiting`，**永不执行**、父永不放行（互锁）。
 * 该函数是**全仓共用**（IM 拆解 / GUI 模板 / 引擎拆解三处），故这一改**三处同时受益**。
 *
 * `selfId` 缺省为空 ＝ 调用方没有"自己是谁"这个概念时按老行为走（不猜、不自作聪明地拿别的东西顶替）。
 */
export function resolveIndexDeps(dependsOn: unknown, childIds: readonly string[], selfId?: string): string {
  if (dependsOn == null) return '';
  const list = Array.isArray(dependsOn) ? dependsOn : [dependsOn];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > childIds.length) continue;
    const id = childIds[n - 1] as string;
    if (seen.has(id)) continue;
    if (selfId !== undefined && id === selfId) continue;
    seen.add(id);
    out.push(id);
  }
  return out.join(',');
}

/** 环路检测所需的极小 DB 面（结构类型，避免引入 better-sqlite3 依赖）。 */
export interface DepGraphDb {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/**
 * 若把 `newDepIds` 设为 `taskId` 的前置会成环，返回环上触发的 id；否则 null。
 * 自环（`dep === taskId`）与间接环（`taskId → … → dep` 已在库中）一并在此拦下（M3-4）。
 */
export function introducesCycle(db: DepGraphDb, taskId: string, newDepIds: readonly string[]): string | null {
  const depsOf = (id: string): string[] => {
    try {
      const row = db.prepare('SELECT depends_on FROM wa_tasks WHERE id = ?').get(id) as { depends_on?: string } | undefined;
      return parseDepIds(row?.depends_on);
    } catch { return []; }
  };
  const seen = new Set<string>();
  const stack = [...newDepIds];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === taskId) return cur;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nx of depsOf(cur)) stack.push(nx);
  }
  return null;
}
