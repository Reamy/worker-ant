/**
 * zx_20260910_2: 任务记账规则——完成必留痕、里程碑必连对板。
 *
 * 抽为不依赖 electron 的模块（只需一个最小的 db 接口），使 agent-executor 与受控回归共用同一份
 * 真实现——回归直接跑真 SQL，而非在测试里复刻判据（复刻的断言只是自我印证）。
 *
 * 三条规则各自对应一处真缺陷（2026-09-10 诊断，证据见 data/baseline_zx_20260910_2.json）：
 *   G1 完成可绕过门禁且不留痕 → selfCompleteBan（禁令）
 *   G2 显式关联方案不参与解析 → buildChildContext（继承）+ writeMilestoneDone（落地）
 *   G3 里程碑登记自认板主     → milestoneBoardOwner（板主）
 *   G5 目标偏离"上限"一个数三处写法 → GOAL_DEVIATION_MAX_RESTARTS + goalDeviationCapReached
 *   zx_20260915 P0-9 里程碑主体 → VERIFICATION_TASK_KEYWORDS/PLAN_TASK_KEYWORDS + milestoneSubjectVerdict
 *     （核验类任务不得充当里程碑主体；「规划/实施类」与「核验类」两套词**同处本文件**，防再次分家）
 */

// zx_20261002 M8-①: 依赖「可解性」的唯一真源（零依赖模块）+ 三种"死"三种话的文案真源——
//   本模块**只借它判/说**，不另写一份判据（同一件事两处各说各话是老病）。
//   静态环核验：`dep-graph → pause-reason`，反向不引本模块 ⇒ 无环。
import { depBlockInfo, parseDepIds } from './dep-graph.js';
// zx_20261005 M5/M7（管子·度量衡 / 维特根斯坦·同一把尺）: 并发上限**只是档位的天花板之下一截**——
//   项目自配的 `rhythm.maxConcurrency` 经 `clampConcurrency` 封进档位上限（只降不升）。
//   档位真源在 `license.ts`（软闸读它），上限表在 `feature-limits.ts`（零依赖）。三者无环：
//   `task-accounting → {license, feature-limits}`、`license → feature-limits`、`feature-limits → ∅`。
import { clampConcurrency } from './feature-limits.js';
import { resolveLicenseTier, type ResolveLicenseOpts } from './license.js';
import crypto from 'node:crypto';
import os from 'node:os';
// zx_20261018_3 批四：非法配置退回派生值时**如实记日志**（懒建，避免 rr 一 import 本模块就起 pino 传输线程）。
import { createLogger } from './logger.js';
// zx_20261018_3 批四：设置键零依赖真源（renderer 设置页同引这一份）。
import { MACHINE_CONCURRENCY_SETTING_KEY } from './settings-keys.js';
export { MACHINE_CONCURRENCY_SETTING_KEY } from './settings-keys.js';

/** 仅需 prepare().run()/.get()/.all() 的最小库接口——使本模块可脱 electron，在受控回归里用内存库跑真逻辑 */
export interface AccountingStmt {
  run(...args: unknown[]): { changes?: number };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}
export interface AccountingDb {
  prepare(sql: string): AccountingStmt;
}

/** 方案里程碑定位（哪块板 + 哪个里程碑号） */
export interface MilestoneLink {
  plan_task_id: string;
  milestone: string;
}

/** 任务 ctx 内的显式关联（scheme_ref）——里程碑号可为空（存量真实形态即只有 plan_task_id）。 */
export interface SchemeRef {
  plan_task_id: string;
  milestone?: string;
}

/** writeMilestoneDone 的 emit 载荷（由调用方注入，模块不引 eventBus）。
 *  交叉 Record<string, unknown> 是为了能直接喂 eventBus.emit（其载荷形参类型即 Record<string, unknown>）。 */
export type MilestoneChangedEvent = Record<string, unknown> & {
  projectId: string;
  planTaskId: string;
  milestone: string;
  status: string;
};

/**
 * G1 自完成禁令：禁止把「当前正在执行的任务」直接宣告为 completed。
 *
 * 完成这个动作在系统里只有唯一合法出口 finalize_task（产出物存在性门禁 / 内容充分性门禁 / 质量门禁）。
 * 绕过它直写 status 会同时造成三件事：
 *   ① 不留事件 → 不变量 task-completion-audit 报违规（本次实库 5 例）；
 *   ② 绕过门禁 → 产出未经验证即被宣告完成；
 *   ③ run 收口立即把状态翻回 paused → 界面闪现「已完成」后又变回执行中（现象1 的直接死因）。
 *
 * 跨任务完成（编排父把已吸收的子任务标记完成）是合法模式，不受禁令约束——但仍须留痕（调用方统一发事件）。
 * 返回 null 表示放行；返回字符串表示拒绝理由（调用方原样回给模型）。
 */
export function selfCompleteBan(currentTaskId: string, targetTaskId: string, status: string): string | null {
  if (status !== 'completed') return null;
  if (targetTaskId !== currentTaskId) return null;
  return '不能把当前正在执行的任务直接置为 completed——请调用 finalize_task 收口（会经过产出物存在性/内容充分性/质量门禁）。'
    + '若只是某个子任务已完成，请对它（而非本任务）调用本工具，并在 finalize_task 里整合收口。';
}

/**
 * G2a 子任务上下文继承：depth 递增 + 继承父任务的显式关联方案（scheme_ref）。
 *
 * 此前 create_task 只写 {depth}，子任务失去 scheme_ref ⇒ 动工/finalize 的里程碑联动整条失效
 * （现象2/3：用户已在「关联方案（规划）」里选好方案，整棵子树却无一节点能连上里程碑板）。
 * 仅在父任务确有 scheme_ref 时注入——无关联任务不凭空多出字段。
 */
export function buildChildContext(parentCtx: Record<string, unknown>, childDepth: number): Record<string, unknown> {
  const child: Record<string, unknown> = { depth: childDepth };
  const sr = parentCtx?.scheme_ref;
  if (sr && typeof sr === 'object') child.scheme_ref = sr;
  return child;
}

/**
 * zx_20261013_1 收口（管子·度量衡 / 王阳明·知行合一）：**「从零重跑」只清机器跑的，不清人写的**。
 *
 * 病根（实机 E2E 照出）：`task:retry` 以**全新对象整体覆写** `context_json`，只留 `retried_*` 三标记 ⇒
 * 用户自己写进去的输入随之一并消失，且**无再派生的路**：挂的附件（`attachments`，GUI 挂件/IM 入站）、
 * 纠的目标（`task_goal`，「纠正目标」）、关联的方案（`scheme_ref`，「关联方案」）。
 * 「整体覆写 ctx 抹掉既有键」这一反模式本仓**已修过两处**（`tools/control.ts:405`、
 * `agent-executor.ts:510` 的"只补写不重建"）——`task:retry` 是漏网的一处。
 *
 * 取舍：retry 语义确是「从零重跑」，**运行指标**（budget/tokens/每轮去向…）本就该清空、由新一轮重算
 * ⇒ 故**不**做全量保留，只点名保留**用户自述输入**这几键。键值原样搬（不深拷贝，与 ctx 其余键既有处理一致）。
 */
export const RETRY_CARRIED_CTX_KEYS = ['attachments', 'task_goal', 'scheme_ref'] as const;

/** 从重跑前的 ctx 里挑出**用户自述输入**键（无则不多添键）。纯函数 ⇒ 受控回归直跑真实现。 */
export function carryRetryContext(prev: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!prev || typeof prev !== 'object') return out;
  for (const k of RETRY_CARRIED_CTX_KEYS) {
    if (prev[k] !== undefined) out[k] = prev[k];
  }
  return out;
}

/**
 * zx_20260916_3 M1（道德经·名可名非常名 / 维特根斯坦·意义即用法）：**槽位尺的唯一真源**。
 *
 * 病根（见 plans/improve/zx_20260916_3.md §一 O-A）：广度上限此前写作
 * `SELECT COUNT(*) FROM wa_tasks WHERE parent_task_id = ?`——**只数不筛**，已 `completed`/`failed`/`archived`
 * 的子任务**永久占位**（真库实测：9 个父任务的子任务**全部**已终态，槽位却仍判满）。
 * 「还有几个位子」的实相是"此刻还在跑几个"，不是"历史上曾建过几个"。
 *
 * **闸的演进史**（zx_20261014_6 M6 订正——旧注释三句断言均已过期，且曾误导过一次诊断）：
 *  · **当初**：本闸**只覆盖 `create_task` 一条路**——`spawn_subagent`、引擎自发建子（核实下钻/辩论/swarm）、
 *    IPC/IM 建任务等路**都不在其中**（真库 3 个父达 6 个子，第 6 个一律是 `[Sub]` 前缀，即此路逃逸）。
 *    ⇒ "最大 5 个"**曾**是一句只在一条路上成立的承诺。
 *  · **zx_20260916_3 M1 起已全覆盖**（8 处调用点，按符号枚举）：
 *    `tools/control.ts`（`create_task`）、`tools/resource.ts`（`spawn_subagent` / `spawn_debate` / swarm）、
 *    `tools/control-finalize.ts`（引擎自发补救建子）、`ipc/project.ipc.ts`（人工挂子 + 模板批量建）、
 *    `core/task-decompose.ts`（拆解）。**八处全在闸内**。
 *  ⚠ 断言/判据须**按符号**钉这些调用点，勿按行号——行号会漂。
 *
 * ⚠ 上限 5 是既有裁定（D3 不放宽，见方案 §1.4）——本轮改的是**怎么数**，不是数到几。
 */
export const MAX_CHILD_BREADTH = 5;

/**
 * 嵌套深度上限——与广度同处一处真源。
 *
 * 此前 `create_task` 写 5、`spawn_subagent` 写 2：**同一个"嵌套层数"概念，两把尺子**
 * （方案 §1.2 病根①-3）。后者**码上可推**的后果是"任何 depth≥2 的任务调它必被拒"
 * （`childDepth = 2+1 = 3 > 2`）——统一为 5 后该路径才真正可用。
 * 实数（2026-09-17 查真库）：`spawn_subagent` 路的深度拒绝记录 **0 条**（未见实发）；
 * 早年 `create_task` 路有 2 条同形状拒绝（2026-07-20，旧文案"最大任务嵌套深度(2层)"），
 * 即该形状的缺陷**确有实发先例**，只是不在 `spawn_subagent` 这条路上。如实登记，不夸大。
 */
export const MAX_TASK_DEPTH = 5;

/**
 * 在途子任务数（槽位尺的唯一计数）：已终态（`completed`/`failed`/`archived`）**不占位**。
 * `paused`/`pending`/`executing` 等一律计入——它们尚未做完，位子确实还占着。
 */
export function countActiveChildren(db: AccountingDb, taskId: string): number {
  return (db.prepare(
    "SELECT COUNT(*) AS c FROM wa_tasks WHERE parent_task_id = ? AND status NOT IN ('completed','failed','archived')",
  ).get(taskId) as { c: number }).c;
}

/**
 * 槽位闸：满则返回**当下可执行**的拒绝理由；未满返回 null（放行）。
 *
 * 承 zx_20260904_5 D2/D4 的旧文案「请合并或直接完成」——那句在闸满时**与闸无关**：
 * 它既没说为什么被拒（已完成的子任务其实不占位），也没给一条真正走得通的路
 * （毛选·惩前毖后治病救人：纠偏建议必须在**当前约束下可执行**）。
 * 现文案给三条当下可执行的路，并说明"已终态不占位"这一事实，避免把"槽位其实空着"误读成"满"。
 */
export function childBreadthRefusal(db: AccountingDb, taskId: string): string | null {
  const active = countActiveChildren(db, taskId);
  if (active < MAX_CHILD_BREADTH) return null;
  return childBreadthRefusalFor(active);
}

/**
 * 槽位已满时的拒因文案——**唯一一份**（`childBreadthRefusal` 与"先备 id 后落行"的预判共用）。
 *
 * zx_20261018_3 批二：拆解落行改为**先备齐 id 再解析依赖**（向后引用要能落到真实 id），
 * 故能建几行必须在插入前算出；截断时仍要说同一句真因，不因"还没插到满"另写一句。
 */
export function childBreadthRefusalFor(active: number): string {
  return `当前任务已有 ${active} 个**在途**子任务（上限 ${MAX_CHILD_BREADTH}；已 completed/failed/archived 的子任务不占位）。`
    + `此刻可走的路：① 把剩余工作交给某个**在途**子任务——用 send_message 给它追加指令；`
    + `② 直接在本任务内收口（finalize_task）；`
    + `③ 先处置/收尾在途子任务，待其终态后槽位自动空出，再重试本次调用。`
    // zx_20261022_2 批四: 先堵住"绕闸"的那条路——真库 `0ba7a0d4` 的槽位满时，
    //   拆解去掉了 depends_on 硬塞一条，M2.5 抢先撞上 86 步上限。少写依赖不是"省事"，是让串行变并行。
    + ` ⚠ **不得为绕过槽位而省略 depends_on**——那会让本应串行的里程碑并行抢跑；正路是等前序终态腾出槽位后再补建。`;
}

/**
 * zx_20261002 M8-①（《庄子·天运》名者实之宾也）——**裁定：计为「无前置」+ 留痕告警**。
 *
 * 病根（方案 §1.2 行4）：`depBlocksRun('unresolved') === false`（承 M3-2 那条**字节等价**老裁定：
 * 库里查不到的 id 本就不计数 ⇒ 不阻塞调度）。于是 `depends_on` 里一个**写错的 id** 会让 DAG 约束
 * **静默失效**——任务照跑；而"这个前置根本不存在"只在**建任务那一刻的工具回话**里说过一次，
 * 之后无处可查（详情页/会话流里都没有）。
 *
 * 本函数在**任务真要开跑**时补一笔留痕（会话流 system 行 + 由调用方落日志）。
 * **不阻塞、不改状态**——放行行为逐字未变（不动 M3-2），只把"放行"这件事**记下来**。
 *
 * **只对 `unresolved` 出声**（按 `classifyDep` 的折叠口径）：`dead`/`waiting` 的前置**本就拦住启动**，
 * 且各有既有出口（`depBlockInfo` 的 dead/waiting 文案经工具回话与详情页到达用户），此处不重复喊。
 * 混合情形（dead + 查不到）归 `dead` ⇒ 不在此列：那类任务的真相是"**被死前置卡住**"，不是"放行"。
 *
 * **一次性**：留痕后写 `context_json.$.dep_unresolved_warned`——否则同一条警告会随每次派发重刷。
 * 文案取 `depBlockInfo` **唯一真源**（本函数不另拼一句，免得两处对同一事实各说各话）。
 *
 * @returns 本次未写留痕（无前置 / 已留过 / 非 unresolved / 任何异常）回 `null`；写了则回 `{ unknownIds }`。
 */
export function warnDepsUnresolved(db: AccountingDb, taskId: string): { unknownIds: string[] } | null {
  try {
    const row = db.prepare('SELECT depends_on, context_json FROM wa_tasks WHERE id = ?').get(taskId) as
      | { depends_on?: string | null; context_json?: string | null }
      | undefined;
    if (!row) return null;
    const depIds = parseDepIds(row.depends_on);
    if (depIds.length === 0) return null;
    let ctx: { dep_unresolved_warned?: unknown };
    try { ctx = JSON.parse(row.context_json || '{}') as typeof ctx; } catch { ctx = {}; }
    if (ctx.dep_unresolved_warned === true) return null;
    // 一次 IN 查询取前置现状（与 `TaskScheduler.depStateOf` 同形，判据同取 `dep-graph` 唯一真源）
    const rows = db.prepare(
      `SELECT id, status, title, context_json FROM wa_tasks WHERE id IN (${depIds.map(() => '?').join(',')})`,
    ).all(...depIds) as Array<{ id: string; status?: string; title?: string; context_json?: string | null }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const info = depBlockInfo(
      depIds,
      (id) => byId.get(id)?.status,
      (id) => byId.get(id)?.title ?? id,
      (id) => byId.get(id)?.context_json,
    );
    if (info.state !== 'unresolved') return null;
    db.prepare(
      "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))",
    ).run(crypto.randomUUID(), taskId, `[WARN] ${info.text}本任务已按「无前置」放行启动。`);
    // 位置不敏感（与 M5 的 `$.auto_decomposed` 不同：那处标记必须压在 context_json 覆写**之后**）——
    //   `json_set` 就地改键，不整体覆写，故既有键一律保留。
    db.prepare(
      "UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.dep_unresolved_warned', json('true')), updated_at = datetime('now') WHERE id = ?",
    ).run(taskId);
    return { unknownIds: info.unknownIds };
  } catch {
    // 记不上账**不阻断执行**（同 `pauseTask` 的"不因写不进账而放弃落停"）——留痕是附加物，执行是主线。
    return null;
  }
}

/**
 * zx_20260924_1 M3-b（J-7）：「这个父任务已经有在途子任务了吗」——**全仓唯一实现**。
 *
 * 三路拆解（引擎/计划路 `enter_plan_mode` / IM 路 `handleCreateTask` / GUI 模板路）都该在动手前问这一句。
 * 此前它只长在引擎路一处（写成裸的 `countActiveChildren(db, id) > 0`），IM 路**没有任何守卫**——
 * "我拆过了吗"这个判断于是与"写在哪儿"绑定，换个入口就整条失守。
 * 现归到这一处，`countActiveChildren` 仍是唯一计数尺（本函数只加"大于 0"这一层语义）。
 *
 * ⚠ 数的是**在途**（`countActiveChildren` 的口径）：已终态的子任务不占位 ⇒ 子任务都做完之后再拆，
 *   仍属合法（那时确实还有活要干）。所以本判据**不是**"拆过一次就永久禁止"。
 */
export function alreadyDecomposed(db: AccountingDb, taskId: string): boolean {
  return countActiveChildren(db, taskId) > 0;
}

/**
 * zx_20261002 M5：「这个任务**曾经**拆过吗」——读**持久标记** `context_json.$.auto_decomposed`
 * （三路拆解共有层，写点见 `control.ts` / `im-router.ts` / `ipc/project.ipc.ts`）。
 *
 * **与上面 `alreadyDecomposed` 是两个问题，缺一不可**（承上一条注释末尾那句"本判据不是拆过一次就永久禁止"）：
 *   - `alreadyDecomposed` 问的是"**眼下**有没有在途子任务"——防**覆盖模型正在进行的规划**（子都做完了就该放行）；
 *   - 本函数问的是"**历史上**拆没拆过"——防**回环**：子任务全部完成后，恢复机制把父置回 `pending`
 *     （`checkParentTaskAfterChildDone`），启动路的"到点即拆"若只看在途子数，此刻读到 0 ⇒ **再拆一遍**
 *     ⇒ 又建一批子、父又暂停 ⇒ 子完又恢复 ⇒ 无限循环。
 * 故启动路**两道都问**；`enter_plan_mode`（模型显式调用）仍只问前者——那是模型的主动意图，不在此列。
 */
export function decomposedBefore(db: AccountingDb, taskId: string): boolean {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as
      | { context_json?: string | null }
      | undefined;
    return (JSON.parse(row?.context_json || '{}') as { auto_decomposed?: unknown }).auto_decomposed === true;
  } catch {
    return false;
  }
}

/**
 * zx_20260924_1 M3-a（J-6）：拆解序号 → `wa_tasks.priority` 列的**唯一换算**。
 *
 * 这一格装的是**拆解序号**，不是"紧要度"——写 `planned - index`（3 个子任务 ⇒ 3/2/1），
 * 好让调度器那句 `ORDER BY priority DESC` 把"模板里的第 1 个"排到**最前**（`getReadyTasks` /
 * `exit_plan_mode` 两处读点都是 DESC）。改前写的是裸 `i` ⇒ 同一批无前置子任务里**最后一个反而最先起跑**。
 *
 * ⚠ **与"用户优先级"不是一回事，勿混**：`priority` 在 `task:create` / `create_subtask` / GUI 编辑
 *   那几条路上装的是**用户给的紧要度（0–3）**；本函数只服务**拆解路径**（三处写点：
 *   `core/task-decompose.ts` · `planSubtasksFromTemplate` / `services/im-router.ts` 的 IM 拆解 /
 *   `ipc/project.ipc.ts` 的模板拆解）。同一个列名两种语义是既有事实，本函数把"拆解那一半"收成一处。
 *
 * ⚠ 另有同样自洽的改法（"拆解一律写 0 + 读点加 `rowid ASC` 稳定序"）**已裁定不采用**（J-6）⇒
 *   不并存。若将来要动这一格，动的是本函数 + 那两处读点的注释，别再引入第二套序。
 *
 * ── zx_20261002 M8-③ **裁定：保留单列 + 一处派生规则**（不迁数据、不拆列）────────────────────
 * 「语义边界」写死在**本处**（收口前的实情：同一条规则散在 5 处注释里，谁都不知道哪儿是全份）：
 *   · **写侧**（三种语义写入本列）：拆解路写**拆解序**＝本函数 `planned - index`；
 *     `task:create` / `create_subtask` / GUI 编辑写**用户紧要度 0–3**。⇒ `priority` 一列**两义并存**是既成事实。
 *   · **读侧**（唯一排序口径）：执行序 ＝ `priority DESC`（`getReadyTasks` · `exit_plan_mode` 的 noDep 读点；
 *     `im-router` 的任务挑选同向）。**只有这一种口径**——`ASC`/`rowid` 等第二套序已裁定不引入（J-6）。
 *   · **显示侧**（同一列的第三个落点，勿忘）：renderer 的 `PRIORITY_LABEL[task.priority]` 直接读本列
 *     ⇒ 拆解出的子任务会按**拆解序**显示成"高/中/低"（`planned=3` ⇒ 显示"高"）。这是"名实之宾"的残留面：
 *     本轮**只登记、不拆列**（拆列须迁数据，超出 K-3「修账为主」）；要治须另立一轮，届时改**本处 + 显示侧**。
 * 判据（`rr_zx_20261002` G 组）钉三件事：本函数是**唯一**换算、`priority DESC` 是**唯一**排序口径（反证无 `ASC`）、
 * 上面这层语义边界**在本处**（不在别处再抄一份）。
 */
export function decomposePriority(planned: number, index: number): number {
  return planned - index;
}

/**
 * zx_20260911_3 M2a 上溯祖先取关联（scheme_ref）——「继承」在生产从未成立的真解。
 *
 * 生产链路上关联只写在**规划任务**（板主）身上：子任务 create_task 只看**直接父**的 ctx，
 * 而现场是「板挂规划任务、卡挂实施任务」——实施任务的直接父是它上一级实施/阶段任务，
 * 自然没有 scheme_ref，于是 11 个 agent 子任务里 0 个继承到（E2 分母 11/分子 0）。
 * 判据须落在**整条祖先链**上：自本任务起逐级上溯，第一个带 scheme_ref 的祖先即关联事实源。
 *
 * 只在链上确有 scheme_ref 时返回——无关联链返回 null，调用方不得凭空补字段（E2 的"不凭空多字段"）。
 * 脏 ctx / 缺行 / 环（maxHops 截断）一律视作"此级无关联"，继续上溯或如实返回 null。
 */
export function resolveAncestorSchemeRef(
  db: AccountingDb,
  startTaskId: string,
  maxHops = 20,
): SchemeRef | null {
  try {
    let cur: string | null = startTaskId;
    for (let hop = 0; hop < maxHops && cur; hop++) {
      const row = db.prepare('SELECT context_json, parent_task_id FROM wa_tasks WHERE id = ?').get(cur) as
        { context_json?: string | null; parent_task_id?: string | null } | undefined;
      if (!row) return null;
      let ctx: Record<string, unknown> = {};
      try { ctx = JSON.parse(row.context_json || '{}') as Record<string, unknown>; } catch { /* 脏 ctx 视作本級无关联 */ }
      const sr = ctx?.scheme_ref as { plan_task_id?: unknown; milestone?: unknown } | undefined;
      const pid = typeof sr?.plan_task_id === 'string' ? sr.plan_task_id.trim() : '';
      if (pid) {
        const ms = typeof sr?.milestone === 'string' ? sr.milestone.trim() : '';
        return ms ? { plan_task_id: pid, milestone: ms } : { plan_task_id: pid };
      }
      cur = row.parent_task_id || null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 祖先 id 链（自 parent 起逐级向上，**不含自身**，最近者在前）。用于"祖先优先"与"上溯判据"复用。 */
export function collectAncestorIds(db: AccountingDb, startTaskId: string, maxHops = 20): string[] {
  const out: string[] = [];
  try {
    let cur = (db.prepare('SELECT parent_task_id FROM wa_tasks WHERE id = ?').get(startTaskId) as { parent_task_id?: string | null } | undefined)?.parent_task_id || null;
    while (cur && out.length < maxHops) {
      if (out.includes(cur)) break;
      out.push(cur);
      cur = (db.prepare('SELECT parent_task_id FROM wa_tasks WHERE id = ?').get(cur) as { parent_task_id?: string | null } | undefined)?.parent_task_id || null;
    }
  } catch { /* 读不到祖先 = 无祖先 */ }
  return out;
}

/**
 * zx_20260911_3 M3-1b 子树 id 收集（沿 `parent_task_id` 下行，**不含根自身**）。
 * maxNodes 截断防异常数据把内存打满；同层广度优先，返回顺序稳定。
 */
export function collectSubtreeIds(db: AccountingDb, rootTaskId: string, maxNodes = 2000): string[] {
  const out: string[] = [];
  let frontier: string[] = [rootTaskId];
  while (frontier.length > 0 && out.length < maxNodes) {
    const next: string[] = [];
    for (const pid of frontier) {
      const rows = db.prepare('SELECT id FROM wa_tasks WHERE parent_task_id = ?').all(pid) as Array<{ id: string }>;
      for (const r of rows) {
        if (out.length >= maxNodes) break;
        out.push(r.id);
        next.push(r.id);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * 本任务所在的**整棵树**的 id 集合（祖先链 ∪ 自身 ∪ 后代子树）。
 *
 * zx_20260917 M4·§6.0bis-a：方案 §6.1-1 原文写"本任务**及全部后代**"却引"沿 `parent_task_id` **上溯**的写法",
 * 两句自相抵。真库实测定了哪句对：判据 E 的标本 `9eb927bf`（M0）**自己名下 0 条产出物**，
 * 那份被漏看的文件登记在**父** `9788ce4f` 名下 ⇒ **纯下行子树看不见它**。
 * 故集合取整棵树——两个**既有**遍历（`collectAncestorIds` 上溯 / `collectSubtreeIds` 下行）都用上，
 * **不新造第二套父子遍历**。两者都自带 `maxHops`/`maxNodes` 截断与环保护。
 *
 * ⚠ 刻意**不去重**：`IN (?,?,…)` 里出现重复 id 与不出现**结果集完全相同**，故不值得为此写一遍去重。
 * ⚠ zx_20261022_3 批十一：由 `agent-executor.ts` 迁入（其两个遍历助手本就在本模块；判卷证据面
 *   `exec-evidence.ts` 也用它，留在执行器会形成执行器 ↔ 证据模块的循环依赖）。
 */
export function taskTreeIds(db: AccountingDb, taskId: string): string[] {
  try {
    return [taskId, ...collectAncestorIds(db, taskId), ...collectSubtreeIds(db, taskId)];
  } catch {
    return [taskId];
  }
}

/**
 * zx_20260911_3 M3-1 向下回填：把根任务的显式关联同步到**已存在的后代子树**（赫布·同时激活即联结）。
 *
 * 上一轮 M2 只保证"创建那一刻"的继承；而生产主形态是**先建子树、事后才关联方案**
 * （E3：3 个持有者全是事后 json_set 写进去的，其子树无一被激活）⇒ 时间维度上联结仍断。
 *
 * 语义（只加不删、不越权覆盖）：
 *   - `patch` 非空 = 关联：**仅补缺**——后代自身已有 `scheme_ref.plan_task_id` 者**不动**
 *     （更具体的关联优先，避免把用户手工指过的子任务改到别的板）。
 *   - `patch` 为 null = 解除：**仅清除与本 plan 相同**的后代关联（`clearPlanId`），
 *     不误伤指向其它方案的子任务。
 *   - 脏 ctx（JSON 解析失败）**不擅自重写**，跳过。
 * 返回实际改写的后代条数。**根任务自身不由本函数处理**（调用方负责）。
 */
export function backfillDescendantSchemeRef(
  db: AccountingDb,
  rootTaskId: string,
  patch: SchemeRef | null,
  clearPlanId?: string,
  maxNodes = 2000,
): number {
  let changed = 0;
  for (const id of collectSubtreeIds(db, rootTaskId, maxNodes)) {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json?: string | null } | undefined;
    if (!row) continue;
    let ctx: Record<string, unknown> = {};
    try { ctx = JSON.parse(row.context_json || '{}') as Record<string, unknown>; } catch { continue; }
    const sr = ctx.scheme_ref as { plan_task_id?: unknown } | undefined;
    const cur = typeof sr?.plan_task_id === 'string' ? sr.plan_task_id.trim() : '';
    if (patch) {
      if (cur) continue;
      ctx.scheme_ref = patch;
    } else {
      if (!cur || !clearPlanId || cur !== clearPlanId) continue;
      delete ctx.scheme_ref;
    }
    db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), id);
    changed++;
  }
  return changed;
}

/** zx_20260911_3 M4 子任务完成态的**如实**分类（空性·如实——不给不存在的"全部完成"）。 */
export interface ChildCompletionClass {
  total: number;
  /** completed 且确有产出 */
  done: number;
  /** completed 但 `ctx.auto_completed_without_output === true`（置完成却无产出证据的空壳） */
  emptyShell: number;
  failed: number;
  /** 既未 completed 也未 failed（收口前会被前置检查拦下） */
  incomplete: number;
}

/**
 * 子任务完成态分类。空壳 = `context_json.auto_completed_without_output === true`（E7/E10 的既有标记，
 * 本函数**只读不改**其写入判据）。脏 ctx 不作空壳认定（宁可少报，不把真完成的算成空壳）。
 */
export function classifyChildCompletion(
  children: Array<{ status?: string | null; context_json?: string | null }>,
): ChildCompletionClass {
  const c: ChildCompletionClass = { total: children.length, done: 0, emptyShell: 0, failed: 0, incomplete: 0 };
  for (const ch of children) {
    if (ch.status === 'failed') { c.failed++; continue; }
    if (ch.status !== 'completed') { c.incomplete++; continue; }
    let shell = false;
    try { shell = (JSON.parse(ch.context_json || '{}') as { auto_completed_without_output?: unknown }).auto_completed_without_output === true; } catch { /* 脏 ctx 不作空壳认定 */ }
    if (shell) c.emptyShell++; else c.done++;
  }
  return c;
}

/**
 * 收口自检中「子任务已完成」这一条的文案（单一真源，可回归）。
 *
 * 此前恒输出「所有 N 个子任务已完成」——把"置 completed 但无产出证据"的空壳一并算作完成，
 * 甚至把**失败**的子任务也算进"已完成"的那个 N 里（名实不符）。现如实分类：有异常时**不再出现
 * "全部完成"字样**，显式披露未产出/失败数供人工核验（仍 PASS，但结论不再冒名）。
 */
export function childCompletionCheckLabel(c: ChildCompletionClass): string {
  if (c.total === 0) return '[PASS] 无子任务';
  // zx_20261015_2 D5（毛选·实事求是 / 罗尔斯·同一把尺）：只要还有**未了结者**（`incomplete`——
  //   含 `archived` 归档，见 `classifyChildCompletion`），绝不出现"全部完成"字样；且头句不得把
  //   未了结者算进"已完成/已终结"的那个 N 里（旧文案 `已终结 ${total}（…）` 把 pending 也算作
  //   "已终结"，名实不符）。真库标本 `7c39678e`：7 完成 + 8 归档 ⇒ 旧文案谎报「所有15个子任务已完成」。
  if (c.incomplete === 0 && c.emptyShell === 0 && c.failed === 0) return `[PASS] 所有${c.total}个子任务已完成`;
  const notes: string[] = [];
  if (c.emptyShell > 0) notes.push('未产出者为"置完成但无产出证据"的空壳（未交付任何成果），请核验后决定是否补做');
  if (c.failed > 0) notes.push('存在失败子任务，请核验后决定是否补做');
  if (c.incomplete > 0) notes.push('归档/未了结者未交付成果，请人工核验');
  const head = c.incomplete > 0
    ? `共 ${c.total} 个子任务（完成 ${c.done} 个、归档/未了结 ${c.incomplete} 个${c.failed > 0 ? `、失败 ${c.failed} 个` : ''}${c.emptyShell > 0 ? `、未产出 ${c.emptyShell} 个` : ''}）`
    : c.failed > 0
      ? `已终结 ${c.total}（其中失败 ${c.failed} 个、未产出 ${c.emptyShell} 个）`
      : `已完成 ${c.total}（其中未产出 ${c.emptyShell} 个）`;
  return `[PASS] ${head}——${notes.join('；')}`;
}

/**
 * zx_20260915 P0-9：**里程碑主体**的词汇表——核验类与规划/实施类，**唯一一份**（同处本文件）。
 *
 * 病根（真库实测，见 PLAN_zx_20260915 §9.1）：`8a6f226a`（一条**核验**任务）把 M0–M8 登记成了
 * "待实施"里程碑，与 `f07ad74a`（真实的规划任务）那块板**逐字相同**——同一批里程碑在一个项目里
 * 长出了两块一模一样的板。三重失真：主体错（核验不是里程碑的产出者）、时态错（登"待实施"时实施
 * 已经发生）、重复挂板。
 *
 * 两套词必须**同源**：它们是同一个判断（"这条任务够不够格产生里程碑"）的正反两面，
 * 分写两处必然分家（本仓 §9.4 静态判据即为此）。
 */
export const VERIFICATION_TASK_KEYWORDS: readonly string[] = ['核验', '核实', '复核', '检查', '审计'];

/**
 * 规划/实施类关键词。**两个消费者，共用本一份词表**（分写两处即分家，本仓 G2 病根）：
 *   ① 里程碑主体判定（`milestoneSubjectVerdict`）——本文档的原始用途；
 *   ② zx_20260916 M1 验收判据代拟（`agent-executor.proposeAcceptanceForTask`）——
 *      "规划类任务才代拟判据"，直接调本文件的 `isPlanOrImplTask`，**不另造一份"是不是规划"的词表**。
 *
 * 仍**不要**并到 `agent-executor` 的 `isPlanProposal`
 * 去（那条判据管的是"方案文档里的 ⚠/❌ 要不要自动下钻修复任务"，正类无"方案"、负类多"盘点"，
 * 与本文是两件事；并表会同时改掉两条判据的行为）。
 */
export const PLAN_TASK_KEYWORDS: readonly string[] = ['规划', '排期', '方案', '计划', '实施'];

/**
 * 不产生里程碑的任务原型。**只列 `conversation`，刻意不含 `research`**——
 * 真库实测 21 块板中 5 块板主的 archetype 正是 `research`（「20xxxxxx 功能优化规划」这类任务
 * 在本仓被判为 research），排除它会把近半合法规划轮次一并挡掉；`conversation` 存量 0 命中，纯护栏。
 */
export const NON_SUBJECT_ARCHETYPES: readonly string[] = ['conversation'];

/** 文本是否为核验类（标题/描述任一处命中）。 */
export function isVerificationTask(text: string | null | undefined): boolean {
  const t = String(text ?? '');
  return VERIFICATION_TASK_KEYWORDS.some((k) => t.includes(k));
}

/** 文本是否为规划/实施类（标题/描述任一处命中）。 */
export function isPlanOrImplTask(text: string | null | undefined): boolean {
  const t = String(text ?? '');
  return PLAN_TASK_KEYWORDS.some((k) => t.includes(k));
}

/**
 * zx_20260923 M4（G5/G7）：**里程碑号怎么从文本里取出来**——唯一一份。
 *
 * 两个消费者共用本一份抽取式判据（分写两处即分家，本仓 G2 病根）：
 *   ① `control.ts` 的「编排父收尾前里程碑缺口核查」——题面声明了哪几枚、子任务承接了哪几枚；
 *   ② `control.ts` 的里程碑登记段——板上那几枚，有几个真有同名子任务。
 *
 * 为什么**必须**有一个「自指标签」的概念：标题以 `M\d+` 开头 = **本任务自己就是那枚里程碑**
 * （真库全库 40 条这种任务，其中 36 条 0 子任务）。若不排除，一个叫「M4 建子任务这条路」的
 * **叶子**任务会被要求"建一个 M4 子任务"——自指，**永远满足不了**。
 */
export function milestoneOwnLabel(title: string | null | undefined): string | null {
  return String(title ?? '').trim().match(/^(M\d+)\b/)?.[1] ?? null;
}

/** 逐段取值再合并（**不要**先把各段 join 起来——相邻段尾 "M1" + 首 "2..." 会拼出一个假的 "M12"）。 */
export function milestoneRefsIn(...texts: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const m of String(t ?? '').matchAll(/\bM\d+\b/g)) out.add(m[0]);
  return out;
}

/**
 * zx_20261015_2 D3（维特根斯坦·意义即用法 / 毛选·实事求是）：里程碑的**名字**——从方案文本里取
 * 「M 号 + 标题」对。与 `milestoneRefsIn` **同族同处**（分写两处即分家，本仓 G2 病根）。
 *
 * 病根（真库标本 `7c39678e`）：`milestoneHintOf` 只交出 M 号（`M0、M1…`），提示词于是只约束
 * "标题以 `M<i>` 开头"，**余下的名字交给模型自由发挥** ⇒ 拆出 `M0: 方案设计与建表` 这类**通用词**，
 * 与方案里程碑表里的真名（`| M0 口径与前置确认 | ✅ 已完成 |`）对不上；agent 随即按真名重建、
 * 把刚建的全归档（`archive_reason` **逐字**引用了这条不一致）。方案文本里**本就写着真名**——提示没去取。
 *
 * 取两种既有形态，**表行优先**（里程碑表是"定义"，标题行可能是"完成记录"）：
 *   ① 表行 `| M0 口径与前置确认 | ✅ 已完成 | …`
 *   ② 标题行 `### M1 D1：relay …`（M 号须在标题文字**开头**，避免把正文里的 M 号误认成定义）
 * 取不到标题的 M 号**不进本表**，由调用方逐字回退为"仅 M 号"（如实降级，不因读不到标题而阻断拆解）。
 */
export function milestoneTitledRefsIn(text: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const put = (ref: string, title: string): void => {
    const t = title.trim();
    if (t && !out.has(ref)) out.set(ref, t);
  };
  const lines = String(text ?? '').split('\n');
  for (const line of lines) {
    const row = /^\s*\|\s*(M\d+)\s+([^|]+?)\s*\|/.exec(line);
    if (row) put(row[1] as string, (row[2] as string));
  }
  for (const line of lines) {
    const head = /^\s*#{1,6}\s+(M\d+)\s+([^（(]+)/.exec(line);
    if (head) put(head[1] as string, (head[2] as string));
  }
  return out;
}

/** 题面声明、**待由子任务承接**的里程碑 = 文本里的全部 M 号 − 自指标签（排序，便于稳定报账）。 */
export function declaredMilestones(
  title: string | null | undefined,
  description: string | null | undefined,
): string[] {
  const own = milestoneOwnLabel(title);
  return [...milestoneRefsIn(title, description)].filter((m) => m !== own).sort();
}

/**
 * 「应被承接」的那组里程碑里，**还没有任何子任务标题承接**的那些（排序）。
 *
 * **两个消费者共用本一份**（分写两处即分家）： `control.ts` 的收尾缺口核查（`want` = 题面声明）
 * 与里程碑登记段的差额核对（`wanted` = 板上的行）。二者的"承接"判据必须与 `milestoneRefsIn` 同源，
 * 否则"题面说没承接"与"板上说没承接"会各说各话。
 */
export function unclaimedMilestones(
  wanted: Iterable<string>,
  childTitles: Iterable<string | null | undefined>,
): string[] {
  const have = milestoneRefsIn(...Array.from(childTitles));
  return [...wanted].filter((m) => !have.has(m)).sort();
}

/**
 * 里程碑主体判定：这条任务**有没有资格**把方案里程碑登记到自己（或关联）的板上。
 *
 * 取代原先的 `found.size >= 2 || isPlanish`——旧判据对主体**不设防**（只要文档里凑够两个
 * `M\d` 就登记），核验任务因此凭空挂出九行"待实施"。新判据只收窄不放松：真库 21 块存量板回放
 * 12 块仍会登记、9 块不会（5 块核验类 + 4 块无规划/实施字样），存量 134 行一律不动。
 *
 * 返回 `reason` 时调用方**必须原样入 `finalize_checks`**——不登记这件事本身也要如实说出来，
 * 否则"没登记"与"登记失败"在用户眼里长得一模一样。
 */
export function milestoneSubjectVerdict(
  text: string | null | undefined,
  archetype?: string | null,
): { ok: true } | { ok: false; reason: string } {
  if (isVerificationTask(text)) {
    return { ok: false, reason: '[INFO] 本任务为核验类，不登记方案里程碑（M0–M8 已由方案任务登记）' };
  }
  const arch = String(archetype ?? '').trim();
  if (arch && NON_SUBJECT_ARCHETYPES.includes(arch)) {
    return { ok: false, reason: `[INFO] 本任务类型(${arch})非里程碑主体，不登记方案里程碑` };
  }
  if (!isPlanOrImplTask(text)) {
    return { ok: false, reason: '[INFO] 本任务非规划/实施类，不登记方案里程碑（如需追踪请用 create_task 建里程碑子任务）' };
  }
  return { ok: true };
}

/**
 * G3 里程碑登记的板主：优先「被显式关联的方案任务」，无显式关联才返回 null 由调用方自建板。
 *
 * 此前 finalize 恒以 self 为 plan_task_id，且仅凭标题含「方案/规划/排期」触发 ⇒ 实施锚父凭空长出
 * 第二块与真实方案板并行的空板（现象3：两块各 9 行全 pending）。规划任务登记自己的里程碑是正确语义，
 * 故无关联时维持原状（返回 null）。
 */
export function milestoneBoardOwner(ctxJson: Record<string, unknown>): string | null {
  const sr = ctxJson?.scheme_ref as { plan_task_id?: unknown } | undefined;
  const id = sr?.plan_task_id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * 「任务标题 `M{n}`」这一启发式的**唯一定义**（G2 收敛点）。
 *
 * 标题以 `M` + 数字开头 → 归一到 `M{数字}`（`M12 实施…` → `M12`；`M1x` → `M1`）；否则 `null`。
 * 全系统**所有**"从标题认里程碑"（正向派生）与"从里程碑找实施者"（反向查询）都须经此函数——
 * 此前四处各写各的（三处 `/^M(\d+)/` 就地内联 + 一处 SQL GLOB），而同名不同法：
 * SQL 侧 `title GLOB 'M1[ (：:;]*'` 因 GLOB 两端锚定 + 单字符类，实为"`M1` + **一个**边界符 + 任意尾串"，
 * 会漏掉纯 `M1` 与 `M1x` 两类标题 ⇒ 同一个名两套用法（维特根斯坦§243：判据不公共即私人语言）。
 *
 * 实现与旧 `/^M(\d+)/` **逐例等价**（`\d+` 贪婪已保证其后非数字），故本收敛不引入行为变更。
 */
export function milestoneFromTitle(title: string | null | undefined): string | null {
  const m = /^M(\d+)/.exec(String(title ?? ''));
  return m ? `M${m[1]}` : null;
}

/**
 * 解析某任务应自动关联的方案里程碑。
 * 顺序：① 已登记为实施者(implemented_by_task_id=本任务)；
 *      ② 标题 M{n} 前缀——②a 本任务是持有该 M 里程碑的方案任务的 direct 子任务(父=plan_task_id) → 唯一绑定；
 *        ②a' 祖先链优先（zx_20260911_3 M3-2）：祖先链上恰有一个任务持有该 M 的板 → 绑定该板；
 *        ②b 否则同项目内持有该 M 里程碑的方案任务恰为一个 → 绑定；多个(歧义) → null 留给手动/族验收，避免误标其它方案。
 * 注意：显式关联方案(scheme_ref)的优先级**不在此函数**，而由 writeMilestoneDone 前置——
 * scheme_ref 只带 plan_task_id（不含里程碑号），仍需标题 M{n} 才能定是哪一个里程碑。
 */
export function resolveTaskMilestoneAutoLink(
  db: AccountingDb,
  t: { id: string; title?: string | null; project_id?: string | null; parent_task_id?: string | null },
): MilestoneLink | null {
  try {
    const byImpl = db.prepare('SELECT plan_task_id, milestone FROM wa_plan_milestones WHERE implemented_by_task_id = ?').all(t.id) as MilestoneLink[];
    if (byImpl.length === 1) return { plan_task_id: byImpl[0].plan_task_id, milestone: byImpl[0].milestone };
    const ms = milestoneFromTitle(t.title);
    if (!ms) return null;
    if (t.parent_task_id) {
      const pRow = db.prepare('SELECT plan_task_id, milestone FROM wa_plan_milestones WHERE plan_task_id = ? AND milestone = ?').get(t.parent_task_id, ms) as MilestoneLink | undefined;
      if (pRow) return pRow;
    }
    // ②a' 祖先链优先（zx_20260911_3 M3-2）：现实形态是「板挂规划任务、卡挂实施任务」差 ≥1 层，
    // ②a 只认直接父 ⇒ 整棵树都连不上板（E5）。此处按**祖先链**取板：恰有一个祖先持该 M 的板才绑定；
    // 多于一个（祖先间亦歧义）则落到 ②b 的既有护栏，不在本层擅自选板（只加不删，反证断言守护）。
    const ancIds = collectAncestorIds(db, t.id);
    if (ancIds.length > 0) {
      const holders = db.prepare(
        `SELECT plan_task_id, milestone FROM wa_plan_milestones WHERE milestone = ? AND plan_task_id IN (${ancIds.map(() => '?').join(',')})`,
      ).all(ms, ...ancIds) as MilestoneLink[];
      if (holders.length === 1) return { plan_task_id: holders[0].plan_task_id, milestone: holders[0].milestone };
    }
    const cands = db.prepare('SELECT plan_task_id FROM wa_plan_milestones WHERE plan_task_id IN (SELECT id FROM wa_tasks WHERE project_id = ?) AND milestone = ?').all(t.project_id, ms) as Array<{ plan_task_id: string }>;
    if (cands.length === 1) return { plan_task_id: cands[0].plan_task_id, milestone: ms };
    return null;
  } catch {
    return null;
  }
}

/**
 * G2c 解析任务应关联的方案里程碑——**「显式关联优先」这条判据的唯一入口**（本函数）。
 *
 * 四个调用点共用此一份真实现（不再各写各的）：
 *   ① finalize 的回写 `writeMilestoneDone`（本模块内，直接调用）；
 *   ② update_task_status 的回写（agent-executor，经 `writeMilestoneDone`）；
 *   ③ 动工(pending→executing) 的 doing 流转（agent-executor）；
 *   ④ GUI 读路径 `admin.ipc.ts plan:taskMilestones`。
 * 其中 ②③④ 此前各自就地内联判据——④ 既不看 scheme_ref 又无歧义护栏，本项目内 9–10 块板持有同名 M 时
 * 一次返回全量 ⇒「族验收通过」按钮据此逐行置 done，跨板误标并改写 implemented_by（现象3）。
 *
 * scheme_ref.plan_task_id 只回答"哪块板"；里程碑号仍需标题 M{n}（或 scheme_ref.milestone）才定得下来。
 * 无显式关联时回落 resolveTaskMilestoneAutoLink（implemented_by → 标题派生，含歧义护栏）。
 */
export function resolveTaskMilestoneLink(
  db: AccountingDb,
  taskId: string,
  ctxJson: Record<string, unknown>,
): MilestoneLink | null {
  try {
    const tr = db.prepare('SELECT id, title, project_id, parent_task_id FROM wa_tasks WHERE id = ?').get(taskId) as
      { id: string; title: string | null; project_id: string | null; parent_task_id: string | null } | undefined;
    if (!tr) return null;
    const sr = ctxJson?.scheme_ref as { plan_task_id?: string; milestone?: string } | undefined;
    if (sr?.plan_task_id) {
      const milestone = sr.milestone || milestoneFromTitle(tr.title);
      if (milestone) return { plan_task_id: sr.plan_task_id, milestone };
    }
    return resolveTaskMilestoneAutoLink(db, tr);
  } catch {
    return null;
  }
}

/**
 * 反向唯一入口：某方案板的里程碑 `M{n}` 由**哪个已完成任务**落地（"持有里程碑的实施者是谁"）。
 *
 * 与正向的 resolveTaskMilestoneLink 方向相反，故不能复用同一个函数体；但**标题判据必须同一份**——
 * 这里用 SQL 只取"项目内已完成任务的 id/title"，再以同一 `milestoneFromTitle` 过滤，而**不再写第二条 SQL 谓词**：
 * 谓词一旦写进 SQL 就必然与 JS 侧分家（旧 `title GLOB 'M{n}[ (：:;]*'` 正是如此，会漏配纯 `M{n}` 与 `M{n}x` 标题）。
 *
 * 取数加 `ORDER BY updated_at DESC`：原读法无 ORDER BY + `LIMIT 1`，命中多条时取哪条不定
 * ⇒ 同一输入两次回填可能连到不同任务（回填结果不可复现）。
 */
export function resolveMilestoneImplementer(
  db: AccountingDb,
  projectId: string,
  milestone: string,
): string | null {
  try {
    const rows = db.prepare(
      "SELECT id, title FROM wa_tasks WHERE project_id = ? AND status = 'completed' ORDER BY updated_at DESC",
    ).all(projectId) as Array<{ id: string; title: string | null }>;
    for (const r of rows) if (milestoneFromTitle(r.title) === milestone) return r.id;
    return null;
  } catch {
    return null;
  }
}

/**
 * G2b 置方案里程碑 done + 落地任务 id（finalize_task 与 update_task_status **共用同一份真实现**）。
 *
 * 此前只有 finalize 做这件事，经 update_task_status 完成的子任务永远不落地里程碑 ⇒ 现象3 的第二半
 * （子任务"完成"了，方案板上的 M{n} 仍 pending 且 implemented_by 为空）。
 * 只前进不回退：WHERE status != 'done' 保证重复调用/二次收口幂等。
 * emit 由调用方注入（保持本模块脱 electron）；仅在真正改了行（changes>0）时才 emit。
 */
export function writeMilestoneDone(
  db: AccountingDb,
  taskId: string,
  ctxJson: Record<string, unknown>,
  emit?: (e: MilestoneChangedEvent) => void,
): MilestoneLink | null {
  try {
    const link = resolveTaskMilestoneLink(db, taskId, ctxJson);
    if (!link) return null;
    const up = db.prepare(
      "UPDATE wa_plan_milestones SET status = 'done', implemented_by_task_id = ?, updated_at = datetime('now') WHERE plan_task_id = ? AND milestone = ? AND status != 'done'",
    ).run(taskId, link.plan_task_id, link.milestone);
    if ((up?.changes ?? 0) > 0) {
      try {
        const pl = db.prepare('SELECT project_id FROM wa_plan_milestones WHERE plan_task_id = ? AND milestone = ?').get(link.plan_task_id, link.milestone) as { project_id?: string } | undefined;
        if (pl?.project_id) emit?.({ projectId: pl.project_id, planTaskId: link.plan_task_id, milestone: link.milestone, status: 'done' });
      } catch { /* emit 失败不阻断 */ }
    }
    return link;
  } catch {
    return null;
  }
}

/**
 * M5（管子·度量衡）上限截断后「剩余 M」的补归口——板上**无卡**且**父自述过**的 `M{n}` 归父。
 *
 * `create_task` 广度上限 5 是全系统共用的安全阀（D3 不放宽），而方案板可能有 7 行 ⇒ M5/M6 **根本没有卡**，
 * 父子双双无处归口（E6：板 7 行 / 卡 5 张）。真库 `df334d91` 的 `ctx.plan` 已明写
 * 「M5 全量回归…与 M6 真实交易日验收因上限并入父任务执行」——**是父自己声明了要干这两件事**，
 * 故收口时把它们以父为实施者落地是如实，而非冒名。
 *
 * 归口判据（三条同时成立，缺一不归）：
 *   ① 板：显式关联 `scheme_ref.plan_task_id` 优先；否则取祖先链上**唯一**的板主（板挂规划任务、卡挂实施任务）；
 *   ② 自述：`M{n}` 须出现在本任务自身 title / description / `ctx.plan` 文本中——**父未声明过的 M 一律保持 pending**
 *      （空性：名依条件而立，条件不具足则名不成立）；
 *   ③ 无卡：该 `M{n}` 未出现在任何**直接子任务**标题中——有卡即卡的事；**即便是失败/空壳的卡也不代标 done**，
 *      宁可留 pending 交人工核验（承 M4 如实口径）。
 * 只对**编排父**（有直接子任务）生效；叶任务返回 null。幂等：`WHERE status != 'done'`，仅真正改行才 emit。
 */
export function backfillBoardRemainderToSelf(
  db: AccountingDb,
  taskId: string,
  ctxJson: Record<string, unknown>,
  emit?: (e: MilestoneChangedEvent) => void,
): { planTaskId: string; milestones: string[] } | null {
  try {
    const children = db.prepare('SELECT title FROM wa_tasks WHERE parent_task_id = ?').all(taskId) as Array<{ title: string | null }>;
    if (children.length === 0) return null; // 非编排父：补归口不适用（不动别人的板）
    const tr = db.prepare('SELECT title, description FROM wa_tasks WHERE id = ?').get(taskId) as
      { title: string | null; description: string | null } | undefined;
    if (!tr) return null;

    // ① 板：显式关联优先，否则祖先链上唯一的板主
    let planTaskId: string | null = null;
    const sr = ctxJson?.scheme_ref as { plan_task_id?: unknown } | undefined;
    const srId = typeof sr?.plan_task_id === 'string' ? sr.plan_task_id.trim() : '';
    if (srId && srId !== taskId) planTaskId = srId;
    if (!planTaskId) {
      const ancIds = collectAncestorIds(db, taskId);
      if (ancIds.length > 0) {
        const owners = db.prepare(
          `SELECT DISTINCT plan_task_id FROM wa_plan_milestones WHERE plan_task_id IN (${ancIds.map(() => '?').join(',')})`,
        ).all(...ancIds) as Array<{ plan_task_id: string }>;
        if (owners.length === 1) planTaskId = owners[0].plan_task_id;
      }
    }
    if (!planTaskId) return null;

    // ② 父自述的 M 范围（标题 / 描述 / plan 文本）
    const declared = new Set<string>();
    const planText = typeof ctxJson?.plan === 'string' ? (ctxJson.plan as string) : '';
    for (const m of `${tr.title || ''}\n${tr.description || ''}\n${planText}`.matchAll(/\bM\d+\b/g)) declared.add(m[0]);
    if (declared.size === 0) return null;

    // ③ 已有卡的 M（不代标——含失败/空壳卡）
    const withCard = new Set<string>();
    for (const c of children) { const mm = /\bM\d+\b/.exec(String(c.title ?? '')); if (mm) withCard.add(mm[0]); }

    // ④ 落归口：板上未落地 且 父自述 且 无卡
    const rows = db.prepare("SELECT milestone FROM wa_plan_milestones WHERE plan_task_id = ? AND status != 'done'").all(planTaskId) as Array<{ milestone: string }>;
    const upd = db.prepare("UPDATE wa_plan_milestones SET status = 'done', implemented_by_task_id = ?, updated_at = datetime('now') WHERE plan_task_id = ? AND milestone = ? AND status != 'done'");
    const claimed: string[] = [];
    for (const row of rows) {
      const ms = milestoneFromTitle(row.milestone);
      if (!ms || !declared.has(ms) || withCard.has(ms)) continue;
      const up = upd.run(taskId, planTaskId, row.milestone);
      if ((up?.changes ?? 0) > 0) {
        claimed.push(row.milestone);
        try {
          const pl = db.prepare('SELECT project_id FROM wa_plan_milestones WHERE plan_task_id = ? AND milestone = ?').get(planTaskId, row.milestone) as { project_id?: string } | undefined;
          if (pl?.project_id) emit?.({ projectId: pl.project_id, planTaskId, milestone: row.milestone, status: 'done' });
        } catch { /* emit 失败不阻断 */ }
      }
    }
    return claimed.length > 0 ? { planTaskId, milestones: claimed } : null;
  } catch {
    return null;
  }
}

/**
 * G5 目标偏离自动恢复上限——全系统唯一定义。
 *
 * 此前这个"上限"是个数，散在三处各写一个：守卫 `restarts < 3`（agent-executor）、
 * 暂停闸 `>= 2`（ai-task）、达成判据 `<= 2`（agent-executor）。三处读的是**同一个** counters，
 * 却给出三个不同的界 ⇒ "到没到上限"没有唯一答案（E17）。
 *
 * 语义取 2：偏离两次（r 到 2）即不再自动重启，交人工介入（与 ai-task 既有的 `>= 2` 一致）。
 * 注：守卫是"先读后写"，故 r 的实际取值 0/1/2 分别对应"首次偏离/第一次重启后/已到上限"。
 */
export const GOAL_DEVIATION_MAX_RESTARTS = 2;

/**
 * 该任务的偏离额度是否已用尽（已达上限）。自增守卫与暂停闸**共用此判据**，不再各写各的界。
 * 脏值一律按"未达上限"处理倾向保守——但 `Number('2')===2` 会如实判为已满（库值经 JSON 往返可能成字符串）。
 */
export function goalDeviationCapReached(restarts: unknown): boolean {
  return Number(restarts ?? 0) >= GOAL_DEVIATION_MAX_RESTARTS;
}

/**
 * zx_20260929 M5-d（管子·度量衡 / 维特根斯坦·同一把尺）：**项目并发口径的唯一真源**。
 *
 * 病根（见 plans/improve/zx_20260929.md §1.6）：同一个"该项目此刻能跑几个"有三套表——
 *   ① 自动拉起 `scanReadyTasks`：`rhythm.maxConcurrency ?? 2`，且只数 `status = 'executing'`；
 *   ② 硬闸 `jobs/ai-task.ts`：写死 `3`，数 `executing + preparing + planning`；
 *   ③ 批处理 `processPending`：`jobs.slice(0, 5)`（与①②不同概念，见 JOB_BATCH_SIZE）。
 * ⇒ 同一项目在两处得到**不同**的上限、且**不同**的分母，谁先谁后取决于"哪条路先撞上"。
 *
 * 现归一处：上限 = 项目 `context_json.rhythm.maxConcurrency`，未设则 `PROJECT_CONCURRENCY_DEFAULT`；
 * 计数一律用 `PROJECT_RUNNING_STATUSES`（三态都占位——一次执行从 planning 起就已实际占用算力）。
 * 两个调用点（软闸 `scanReadyTasks` / 硬闸 `ai-task`）读同一函数、同一数。
 *
 * ⚠ 与"活跃时段窗口"（`rhythm.activeHourStart/End`）**不是一回事**：窗口是"此刻该不该干活"，
 *   本函数是"此刻还能干几件"。窗口判断见 `activeHourWindow` / `projectScanVerdict`（zx_20260930 M11-7：
 *   原先留在 `scanReadyTasks` 内联，现提到本文件——"该不该扫这个项目"自此也只有一处判据）。
 */
export const PROJECT_CONCURRENCY_DEFAULT = 3;

/**
 * 「在跑」的状态集——一次执行实际会占据的态。三态都算占位：
 *   `planning`（拆解/规划中）→ `preparing`（准备上下文/模型）→ `executing`（工具循环）。
 * 此前软闸只数 `executing` ⇒ `planning/preparing` 期间被判"位子空着"而**超发**（同一项目实际跑超上限）。
 * ⚠ 硬闸（`ai-task`）早已用这三态——本常量只是把它提升为**两处共用**，不是新增口径。
 */
export const PROJECT_RUNNING_STATUSES: readonly string[] = ['executing', 'preparing', 'planning'];

/**
 * 单轮从 `wa_jobs` 取数批（`processPending`）。**与项目并发上限是两个不同概念，勿混同**：
 * 前者是"这一 tick 最多捞几条作业行"，后者是"一个项目最多同时跑几个任务"。
 * 提为常量只为消除那个裸 `5`（改口径时有名字可读），不改变取值。
 */
export const JOB_BATCH_SIZE = 5;

export interface ProjectConcurrency {
  /** 上限：`context_json.rhythm.maxConcurrency`（未设/非法则 `PROJECT_CONCURRENCY_DEFAULT`）
   *  **再经档位天花板钳位**（`clampConcurrency`，只降不升）——见 `resolveProjectConcurrencyLimit` */
  limit: number;
  /** 当前占位（`PROJECT_RUNNING_STATUSES` 之一）的任务数 */
  running: number;
  /** 还能再起几个（`max(0, limit - running)`） */
  available: number;
}

/**
 * 项目并发**上限**（只读上限那一半，不数占位）。
 *
 * zx_20260930 M11-1 拆出：并发开闸要做成一条原子 UPDATE 时，"上限"须能单独取到并**内联进 SQL 参数**，
 * 而"占位数"不能在 JS 里先读好——那正是 check-then-act 的病根。故上限与计数自此分两处取：
 * 上限走本函数（纯读配置），计数走 `projectSlotGuard`（进 SQL 子查询，与占位同一条语句里求值）。
 *
 * zx_20261005 M7（管子·度量衡 / 康德·诚实的量级天花板）: 「项目自配的并发」之上再压一层**档位天花板**。
 *   此前"免费/付费"的界根本不存在——项目数无上限、并发只由项目自配 ⇒ 一份许可能多干多少活无物可比。
 *   现取 `clampConcurrency(档位, 自配值)`：**只降不升**（`min` 语义），项目自配比档位保守时尊重用户意图。
 *   档位由 `resolveLicenseTier` 现读（无许可 ⇒ community）——**不拦执行**，只是天花板低些（K-3 软闸）。
 *   `opts` 透传 `now`/`fingerprint`（rr 注入，免得判据依赖真实墙钟与本机指纹）。
 */
export function resolveProjectConcurrencyLimit(db: AccountingDb, projectId: string, opts: ResolveLicenseOpts = {}): number {
  let configured = PROJECT_CONCURRENCY_DEFAULT;
  try {
    const row = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as
      { context_json?: string | null } | undefined;
    if (row?.context_json) {
      const ctx = JSON.parse(row.context_json) as Record<string, unknown>;
      const rhythm = ctx?.rhythm as { maxConcurrency?: unknown } | undefined;
      const mc = Number(rhythm?.maxConcurrency);
      if (Number.isFinite(mc) && mc > 0) configured = Math.floor(mc);
    }
  } catch { /* 读不到/坏 context_json = 用默认上限 */ }
  return clampConcurrency(resolveLicenseTier(db, opts), configured);
}

/**
 * 「项目占位未满」的 SQL 守卫片段 + **与之配套的参数**（zx_20260930 M11-1）。
 *
 * 病根：开闸原是 check-then-act 两跳——先 `resolveProjectConcurrency` 读出"还剩 N 个位子"，
 * 再由另一条 `UPDATE` 去占位。两跳之间，并发的调度回合 / 作业退避重试都能看见**同一个**余量
 * ⇒ 双双通过检查、双双占位，实跑超上限。把计数搬进 `UPDATE ... WHERE` 的标量子查询后，
 * 判据与写入由 SQLite 单语句原子性兜住，中间不存在可插入的窗口。
 *
 * 参数与 SQL **同函数返回**（而非各写各的）——子查询里的 `project_id`、状态集、`id <> ?`、上限
 * 共 4~5 个占位符，交给调用方手工拼顺序迟早错位（错位不报错，只会静默按错误的值开闸）。
 * 调用方只需 `stmt.run(...前段参数, ...guard.params)`。
 *
 * `excludeTaskId`（传任务 id 即排除它自己）：用于"本任务此刻可能已在占位态"的推进场景
 * （如 `planning` → `executing`）。不排除自己就会把自身那一票也数进去，把余量多扣一分
 * ——合法输入被判"满员"（这正是"判据须能被合法数据满足"）。
 */
export function projectSlotGuard(
  projectId: string,
  limit: number,
  opts: { excludeTaskId?: string } = {},
): { sql: string; params: unknown[] } {
  const placeholders = PROJECT_RUNNING_STATUSES.map(() => '?').join(',');
  const base = `SELECT COUNT(*) FROM wa_tasks WHERE project_id = ? AND status IN (${placeholders})`;
  const exclude = opts.excludeTaskId !== undefined;
  const sql = `(${base}${exclude ? ' AND id <> ?' : ''}) < ?`;
  const params: unknown[] = exclude
    ? [projectId, ...PROJECT_RUNNING_STATUSES, opts.excludeTaskId, limit]
    : [projectId, ...PROJECT_RUNNING_STATUSES, limit];
  return { sql, params };
}

// ═══ zx_20261018_3 批四「度」（管子·度量衡）: **机器级**并发上限 ═══
// 病灶：项目并发闸只管"一个项目几个"，机器总量无上限——项目 A 跑 3 个、B 跑 3 个、C 跑 3 个，
//   同一台机器可以同时压 9 个 Agent 循环。项目闸是对的、机器闸此前根本不存在。
// 口径：上限 = 用户设置 `machine_max_concurrency`；未设 ⇒ 按 **CPU 核数派生**（核数-1，夹在 [2,8]）。
//   `cpus` 可注入（rr 不读真机）；档位天花板**不参与**（本轮只做用户可配上限，见方案 §4 挂账）。

/** 设置键见 `settings-keys.ts`（本处已 import + re-export，调用方可从两处任一引入）。 */
export const MACHINE_CONCURRENCY_MIN = 2;
export const MACHINE_CONCURRENCY_MAX = 8;

/**
 * CPU 核数 → 缺省机器并发上限：`clamp(核数 - 1, 2, 8)`。
 * 留一核给系统与 ANS/桌面自身；核数非法（缺省/脏值）按最低值 2（不因读不到核数就不开闸）。
 */
export function deriveMachineConcurrency(cpus: unknown): number {
  const n = Number(cpus);
  if (!Number.isFinite(n) || n < 1) return MACHINE_CONCURRENCY_MIN;
  return Math.max(MACHINE_CONCURRENCY_MIN, Math.min(MACHINE_CONCURRENCY_MAX, Math.floor(n) - 1));
}

export interface MachineConcurrencyResolution {
  /** 生效上限。 */
  limit: number;
  /** 按 CPU 派生的缺省值（供日志/界面说明"退回的是哪个值"）。 */
  derived: number;
  /** 库内原始配置值（未配置为 `null`）。 */
  raw: string | null;
  /** `setting` = 用户显式配置生效；`derived` = 未配置或配置非法。 */
  source: 'setting' | 'derived';
  /** 配置存在但非法（非数/≤0）⇒ 已退回派生值。**纯函数回传**，日志由读库那层打。 */
  invalid: boolean;
}

/**
 * 解析一条机器并发配置（纯函数，不读库）：未配置/空串 ⇒ 派生值（`invalid:false` 是"没配"不是"配错了"）；
 * 非数/≤0 ⇒ 派生值 + `invalid:true`；合法正数取整。
 */
export function parseMachineConcurrencySetting(raw: unknown, cpus: unknown): MachineConcurrencyResolution {
  const derived = deriveMachineConcurrency(cpus);
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { limit: derived, derived, raw: null, source: 'derived', invalid: false };
  }
  const text = String(raw);
  const n = Number(text);
  if (!Number.isFinite(n) || n < 1) {
    return { limit: derived, derived, raw: text, source: 'derived', invalid: true };
  }
  return { limit: Math.floor(n), derived, raw: text, source: 'setting', invalid: false };
}

let machineConcurrencyLogger: ReturnType<typeof createLogger> | null = null;
function logMachineConcurrencyWarning(obj: Record<string, unknown>, msg: string): void {
  try {
    machineConcurrencyLogger ??= createLogger('task-accounting');
    machineConcurrencyLogger.warn(obj, msg);
  } catch { /* 日志失败不阻断认领 */ }
}

/** 读库解析机器并发上限（缺省 `cpus` = 真机核数；rr 注入核数）。非法配置**如实记日志**后退回派生值。 */
export function resolveMachineConcurrencyLimit(
  db: AccountingDb,
  opts: { cpus?: number } = {},
): MachineConcurrencyResolution {
  const cpus = opts.cpus ?? os.cpus().length;
  let raw: string | null = null;
  try {
    const row = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get(MACHINE_CONCURRENCY_SETTING_KEY) as
      | { value?: string | null }
      | undefined;
    raw = row?.value ?? null;
  } catch { /* 读不到设置 = 按派生值；不把"读失败"谎报成"用户配了个非法值" */ }
  const res = parseMachineConcurrencySetting(raw, cpus);
  if (res.invalid) {
    logMachineConcurrencyWarning(
      { raw: res.raw, derived: res.derived, key: MACHINE_CONCURRENCY_SETTING_KEY },
      '机器并发上限配置非法→退回CPU派生值',
    );
  }
  return res;
}

/** 「机器占位未满」的 SQL 守卫片段 + 配套参数（与 `projectSlotGuard` 同形；判据内联进同一条 UPDATE）。 */
export function machineSlotGuard(limit: number, opts: { excludeTaskId?: string } = {}): { sql: string; params: unknown[] } {
  const placeholders = PROJECT_RUNNING_STATUSES.map(() => '?').join(',');
  const base = `SELECT COUNT(*) FROM wa_tasks WHERE status IN (${placeholders})`;
  const exclude = opts.excludeTaskId !== undefined;
  const sql = `(${base}${exclude ? ' AND id <> ?' : ''}) < ?`;
  const params: unknown[] = exclude
    ? [...PROJECT_RUNNING_STATUSES, opts.excludeTaskId, limit]
    : [...PROJECT_RUNNING_STATUSES, limit];
  return { sql, params };
}

/** 机器当前占位任务数（只读快照——用途同 `resolveProjectConcurrency`：展示/归因，不当开闸判据）。 */
export function countMachineRunning(db: AccountingDb, opts: { excludeTaskId?: string } = {}): number {
  const placeholders = PROJECT_RUNNING_STATUSES.map(() => '?').join(',');
  const exclude = opts.excludeTaskId !== undefined;
  const sql = `SELECT COUNT(*) AS c FROM wa_tasks WHERE status IN (${placeholders})${exclude ? ' AND id <> ?' : ''}`;
  const row = (exclude
    ? db.prepare(sql).get(...PROJECT_RUNNING_STATUSES, opts.excludeTaskId)
    : db.prepare(sql).get(...PROJECT_RUNNING_STATUSES)) as { c: number };
  return row.c;
}

/**
 * 项目并发三态（上限/占位/余量）。软闸与硬闸**共用此一处**，不再各写各的表。
 * 脏 rhythm（非 JSON / 解析失败 / 非正数）一律回退默认值——不因坏配置把项目卡死。
 *
 * ⚠ 本函数是**只读快照**，天然有 check-then-act 的缝（zx_20260930 M11-1）：
 *   可用于展示与"提前跳过"这类**非判据**用途；**不可**用它当开闸判据——
 *   要开闸请用 `projectSlotGuard` 把判据内联进那条 UPDATE。
 */
export function resolveProjectConcurrency(db: AccountingDb, projectId: string, opts: ResolveLicenseOpts = {}): ProjectConcurrency {
  const limit = resolveProjectConcurrencyLimit(db, projectId, opts);
  const placeholders = PROJECT_RUNNING_STATUSES.map(() => '?').join(',');
  const running = (db.prepare(
    `SELECT COUNT(*) AS c FROM wa_tasks WHERE project_id = ? AND status IN (${placeholders})`,
  ).get(projectId, ...PROJECT_RUNNING_STATUSES) as { c: number }).c;
  return { limit, running, available: Math.max(0, limit - running) };
}

/**
 * 项目的「活跃时段窗口」（`context_json.rhythm.activeHourStart/End`）。
 * 两个端点都设了才返回窗口；缺一/非数/坏 JSON 一律返回 `null`＝**无窗口限制**（不因坏配置把项目卡死）。
 * 语义为左闭右开 `[start, end)`，小时取 `now` 的**本地时**（与用户设置的钟点同基准）。
 */
export function activeHourWindow(
  contextJson: string | null | undefined,
  now: Date,
): { start: number; end: number; hour: number } | null {
  try {
    const ctx = JSON.parse(contextJson || '{}') as Record<string, unknown>;
    const rhythm = ctx?.rhythm as { activeHourStart?: unknown; activeHourEnd?: unknown } | undefined;
    const start = rhythm?.activeHourStart;
    const end = rhythm?.activeHourEnd;
    if (start === undefined || end === undefined) return null;
    const s = Number(start);
    const e = Number(end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
    return { start: s, end: e, hour: now.getHours() };
  } catch { return null; }
}

/**
 * 项目状态中「不会被自动拉起」的那一档（`scanReadyTasks` 只扫 `'active'`）。
 *
 * zx_20260930 M11-7：此前 `paused/completed/archived` 项目的 `pending` 任务**静默不扫**——
 * 没有任何一处告诉用户"这些待办永远等不到"（`healthViews` 也不数）。本常量是"哪些项目的待办算被搁置"
 * 的唯一真源，供健康视图计数；`active` 之外的全部即搁置档（含 `completed/archived`——
 * 它们本不该有 pending，有就是漏，更不该藏）。
 */
export const PROJECT_PARKED_STATUSES: readonly string[] = ['paused', 'completed', 'archived'];

/** `projectScanVerdict` 的裁定结果：要不要扫 + **不扫的显式理由**（供日志/界面如实说明，不留静默分叉）。 */
export interface ProjectScanVerdict {
  scan: boolean;
  /** `scan === false` 时为非空的可读理由；`scan === true` 时为空串 */
  reason: string;
}

/**
 * 「这个项目此刻该不该被自动拉起」的**唯一判据**（zx_20260930 M11-7）。
 *
 * 病根：原 `scanReadyTasks` 对两个条件各写一段内联 `continue`——
 *   ① `WHERE status = 'active'`（项目状态）；② `rhythm.activeHour*` 窗口。
 * 前者把非 active 项目**整个从候选集里摘掉**（连"为什么不扫"都无从得知），后者 `continue` 时也不留痕。
 * 两处叠加 ⇒ 项目一被暂停，其 `pending` 任务就**永久悬空且无人知晓**。
 *
 * 现把判断收成纯函数：候选集改为**取全部项目**，逐个过本函数；不扫的一律带理由落日志，
 * 并汇入 `healthViews.manager.parkedTaskCount` 让用户看得见（而不是"看起来在排队、其实永不动"）。
 */
export function projectScanVerdict(
  project: { status?: string | null; context_json?: string | null },
  now: Date,
): ProjectScanVerdict {
  const status = String(project.status ?? '');
  if (status !== 'active') {
    return { scan: false, reason: `项目状态为 ${status || '(空)'}，非 active` };
  }
  const win = activeHourWindow(project.context_json, now);
  if (win && (win.hour < win.start || win.hour >= win.end)) {
    return { scan: false, reason: `当前 ${win.hour} 时不在活跃时段 [${win.start},${win.end})` };
  }
  return { scan: true, reason: '' };
}
