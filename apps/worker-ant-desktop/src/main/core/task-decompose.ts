/**
 * zx_20260921 M6（D3「拆解器在册、真库零产出」）：把拆解器从"一条窄路上的内联逻辑"
 * 变成**可注入依赖、可直跑的件**，好让它接进引擎的 planning 出口。
 *
 * 病根不是"没有拆解器"——`task-archetype.ts` 里那个 LLM 拆解器一直写着，prompt 也一直对；
 * 是它**只长在 IM 入站那一条路上**（触发条件还是"消息 ≥100 字或命中关键词"），
 * 而引擎自己的 planning 出口（`enter_plan_mode`）只回一句"请用 create_task 分解"，**从不自己拆**。
 * 真库 `source` 分布里既无 `auto-decompose` 也无 `template`——上游做出来了，下游的插头没插。
 *
 * 本模块做三件事，各自可单独被判据驱动：
 *   ① `decomposeTask(text, { deps })`：拆解（取模型 + 发对话两件事由 `deps` 注入，
 *      故受控回归能**跑真实现、喂桩依赖**，不必照抄一份等价物——承本轮 §7 头号风险"判据自我印证"）；
 *   ② `parseDecomposition`：模型回话 → 模板（纯函数，无 IO）；
 *   ③ `planSubtasksFromTemplate`：模板 → `wa_tasks` 行（深度闸/广度闸/自环过滤三件都在这里，
 *      且**复用既有真源**：`MAX_TASK_DEPTH` / `childBreadthRefusal` / `resolveIndexDeps`）。
 *
 * ⚠ **零 electron、零 better-sqlite3**（库面直接复用 `task-accounting.ts` 的 `AccountingDb` 结构类型
 *   ——不另定义一个同形的第二份）——
 *   故本模块与 `audio-transcribe.ts` / `task-accounting.ts` 同属"受控回归可直跑真实现"那一类。
 *
 * ⚠ **端点 url 拼接归一处真源**（zx_20260921_1 M3）：走 `@worker-ant/ans-client` 的
 *   `resolveChatCompletionsUrl`。本模块原先**刻意**逐字拼 `${url}/chat/completions`（理由是与
 *   `createOpenAI({baseURL})` 的 SDK 约定一致），但那样对"已含路径段"的库内 url 是错的——
 *   库里 `ans_model_endpoints.url` 有纯主机 / `/v1` / `/v1beta` / `/api/v3` / `/api/paas/v4` /
 *   全路径多种形态，逐字追加只在部分形态上恰好对。两套归一并存已被判定为病根本身，故收敛。
 *   主聊天路（AI SDK）**不在**这条真源的管辖内——那是 SDK 自己的约定，如实记在方案 §5。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveChatCompletionsUrl } from '@worker-ant/ans-client';
import { createLogger } from './logger.js';
import { resolveIndexDeps } from './dep-graph.js';
import { MAX_TASK_DEPTH, MAX_CHILD_BREADTH, childBreadthRefusal, decomposePriority, alreadyDecomposed, milestoneRefsIn, milestoneTitledRefsIn, type AccountingDb } from './task-accounting.js';
import { readBoolSetting, type BoolSettingDb } from './settings-bool.js';
// zx_20261016_3 M32: 完成分带阈值取**一处真源**（`quality-gate.ts` 零 import，可安全直引）——低分族的降权判据不在本文件另写一份。
import { QUALITY_BANDS } from './quality-gate.js';
// zx_20261016_3 M33-b: 目的因的**判据**取一处真源（`four-causes.ts` 零 import）——解析口与提示词同引，不各写一份。
import { hasFinalCause } from './four-causes.js';
import { auxModelRequest } from './model-request.js';
import { ansSignedRequest, ansFailureNote, type AnsCreds } from './ans-signed-request.js';

const logger = createLogger('decompose');

/**
 * 子任务模板。`dependsOn` 是**同批序号**（1-based，指向本数组内其它元素）——
 * 用序号而非 id 是因为拆解时 id 尚不存在；落库前由 `resolveIndexDeps` 映射为真实任务 id。
 *
 * zx_20261016_3 M33-b（四因·目的因）：`purpose`＝该子任务**服务于父目标的哪一点**，
 *   **必填**（解析口与 `buildDecomposePrompt` 同引 `hasFinalCause`）——它在模型回话里缺席即被拒。
 *   质料因（执行者/模型档）**不写进本模板**：那是运行期派生的事（见 `four-causes.ts`）。
 */
export interface DecompositionTemplate {
  title: string;
  description: string;
  acceptance_criteria: string;
  purpose?: string;
  dependsOn?: number[];
}

/** ANS 选出的一个可用端点 */
export interface DecomposeEndpoint {
  url: string;
  api_key: string;
  model_name?: string;
}

/**
 * 拆解所需的两件外部事——**只有这两件**，故判据可以把它们全换成桩。
 *
 * `chat` 的返回是 `{ok} | {ok:false}` 而非"抛不抛"：调用方在执行循环里，
 * 抛出去顶掉的是整轮执行，代价远大于"这一次没拆成"（同 `transcribeAudio` 的既有形状）。
 */
export interface DecomposeDeps {
  /** 取一个能干 chat 的模型端点；取不到返回 null（**这是如实结论而非异常**） */
  resolveModel(): Promise<DecomposeEndpoint | null>;
  chat(
    endpoint: DecomposeEndpoint,
    prompt: string,
    timeoutMs: number,
  ): Promise<{ ok: true; text: string } | { ok: false; detail: string }>;
}

export const DECOMPOSE_MODEL_TIMEOUT_MS = 5_000;
export const DECOMPOSE_CHAT_TIMEOUT_MS = 15_000;
export const DECOMPOSE_MAX_TOKENS = 2_000;
export const DECOMPOSE_TEMPERATURE = 0.3;
export const DECOMPOSE_DEFAULT_MODEL = 'qwen2.5:3b';

/** 拆解粒度下界——"拆出 1 个等于没拆"（与 `parseDecomposition` 的拒收阈值同源，勿各写一遍）。 */
export const DECOMPOSE_MIN_SUBTASKS = 2;
/**
 * 拆解粒度上界——**由引擎广度闸派生**（`MAX_CHILD_BREADTH`），不另写一个数。
 * 病根：提示词原写死 `2-6`，而广度闸只放 5 个在途子任务 ⇒ 提示词要 6、闸只给 5，
 * 同一个"最多几个"有两个答案（超出的会被 `childBreadthRefusal` 拒、如实报未建满）。
 */
export const DECOMPOSE_MAX_SUBTASKS = MAX_CHILD_BREADTH;

/**
 * 拆解请求的能力串与策略——取模型那一步用。
 *
 * zx_20260924 M6-d: **不再手写这一份**，改由 `auxModelRequest()`（辅助路能力档的唯一真源）派生——
 * 拆解是辅助路（要 `chat`、排除 `reasoning`），它"该要什么"没有理由与另外 18 处辅助路各写一份。
 * ⚠ `rr_zx_20260921.ts` 按 `JSON.stringify` 与本常量逐字比对实际发出的请求，键序须与档一致
 * （`capabilities, strategy, excludeCapabilities`）——故此处**不加键、不改序**。
 */
export const DECOMPOSE_MODEL_REQUEST: Record<string, unknown> = auxModelRequest();

/**
 * 拆解提示词。**逐字搬自 `task-archetype.ts` 的原实现**（搬迁纪律：语义一字不变）。
 *
 * 第 5 条要求（"若原始任务已经很简单（3步内完成），返回空数组[]"）是"任务较大"这件事的**唯一判据**——
 * 本轮**不再**另造一套启发式（字数/关键词）：那正是 IM 那条窄路"只看消息长度"的病根。
 * "要不要拆"由**能读懂任务的那个模型**答，不由字符串长度答。
 *
 * zx_20261012_2 批四（拆解随本相）：粒度上下界**不再写死**，改用 `DECOMPOSE_MIN_SUBTASKS` /
 *   `DECOMPOSE_MAX_SUBTASKS`（后者由引擎广度闸派生）——原先与广度闸是两个数、两个答案。
 *
 * `milestoneHint`：目标文本点名了 `plans/` 下的 `.md` 方案文件时，由 `milestoneHintOf` 取出其中的
 *   里程碑（zx_20261015_2 D3 起为「M 号 + 方案里的标题」，取不到标题者仅 M 号）。非空即追加**硬规则**
 *   "一里程碑一子任务"——否则拆出来的子任务
 *   不承接任何 M 号，里程碑板留下未承接项（`unclaimedMilestones` 恒非空）。空串时**不加这一句**
 *   （保持原提示词逐字不变，不污染既有夹具）。
 */
export function buildDecomposePrompt(taskDescription: string, decompositionPatterns?: string, milestoneHint?: string): string {
  const patternHint = decompositionPatterns
    ? `\n\n历史拆解模式参考（同类任务的典型子任务数，供参考而非强制）：\n${decompositionPatterns}`
    : '';
  const milestoneRule = milestoneHint
    ? `\n\n**必须**按下列里程碑一一对应切片（**一里程碑一子任务**，不得合并相邻里程碑；子任务标题**即该里程碑的名字**——带标题者逐字用「M<i> 标题」，不得另起通用词；仅 M 号者标题以 \`M<i>\` 开头）：${milestoneHint}`
    : '';
  return `你是一个任务拆解专家。请将以下任务拆解为${DECOMPOSE_MIN_SUBTASKS}-${DECOMPOSE_MAX_SUBTASKS}个子任务，每个子任务应该是独立可执行的。

任务描述：${taskDescription}${patternHint}${milestoneRule}

请以JSON数组格式返回，每个元素包含：
- title: 子任务标题（简洁，10字以内）
- description: 子任务描述（包含具体执行内容）
- acceptance_criteria: 验收标准
- dependsOn: 前置子任务的序号数组（1-based，指向本数组内的其它元素；无前置则省略此字段）
- purpose: 该子任务服务于父目标的哪一点（必填，一句话）

要求：
1. 子任务按执行顺序排列（先准备后执行）
2. 每个子任务应该有明确的产出或可验证的结果
3. 避免过于细碎（每个子任务至少需要3-5步才能完成）
4. 如果原始任务已经很简单（3步内可完成），返回空数组[]
5. 若某子任务必须在另一个子任务完成后才能开始（流水线：先克隆再安装再启动），**必须**用 dependsOn 声明其前置序号；彼此独立的子任务则不要声明，以允许并行
6. 每个子任务**必须**写 purpose，且须落在父目标之内（写清"做完它对父目标贡献了什么"）；**缺 purpose 的子任务不会被创建**

只返回JSON数组，不要其他文字。`;
}

/**
 * 模型回话 → 模板。**纯函数**（无 IO、无 logger），故判据可以直接喂串试它。
 *
 * 四道门一条都不能少：① 正文里得有 JSON 数组（模型爱在数组前后加话）；
 * ② `title` 得有（没标题的子任务建出来在界面上就是一行空白）；③ **至少 2 个**——
 * 拆出 1 个等于没拆，却会多建一个子任务、多一层父子关系；
 * ④ zx_20261016_3 M33-b：**`purpose` 得有**（含空白一律不算）——无目的因的子任务
 *    "做完了也不知道为什么有它"，与父目标脱钩（正标本/反标本见 `rr_zx_20261016_3` D 组）。
 *
 * ⚠ **被滤掉的是条目本身，不是整条拆解**：滤到不足 `DECOMPOSE_MIN_SUBTASKS` 才走既有 `[]` 路
 *   （单任务照跑、不阻断）——"少建"与"不建"是两件事，不合并。
 * ⚠ 因此**最终报数**（会话流那行 `[智能拆解]`、`autoDecomposed.created`）报的是**实建数**，
 *   不是模型回话里的条目数（模型写了 3 条、只有 2 条带 purpose ⇒ 报 2）。
 */
export function parseDecomposition(content: string, taskDescription: string): DecompositionTemplate[] {
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(jsonMatch[0]); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const valid = (parsed as Array<{ title?: unknown; description?: unknown; acceptance_criteria?: unknown; purpose?: unknown; dependsOn?: unknown }>)
    .filter((t) => typeof t?.title === 'string' && t.title.length > 1 && hasFinalCause(t));
  if (valid.length < DECOMPOSE_MIN_SUBTASKS) return [];
  return valid.map((t) => ({
    title: (t.title as string).slice(0, 50),
    description: typeof t.description === 'string' && t.description ? t.description : taskDescription,
    acceptance_criteria: typeof t.acceptance_criteria === 'string' ? t.acceptance_criteria : '',
    purpose: (t.purpose as string).trim().slice(0, 200),
    // 越界/非法序号由落库侧的 `resolveIndexDeps` 如实丢弃（宁少不滥，不猜模型意图）
    ...(Array.isArray(t.dependsOn) && t.dependsOn.length > 0 ? { dependsOn: t.dependsOn as number[] } : {}),
  }));
}

/**
 * 拆解。**永不抛**——失败一律返回 `[]`（调用方据此走"单任务照跑"的既有路，不阻断、不编造）。
 */
export async function decomposeTask(
  taskDescription: string,
  opts: { deps: DecomposeDeps; patterns?: string; milestoneHint?: string },
): Promise<DecompositionTemplate[]> {
  const prompt = buildDecomposePrompt(taskDescription, opts.patterns, opts.milestoneHint);
  try {
    const model = await opts.deps.resolveModel();
    if (!model?.url || !model?.api_key) return [];
    const r = await opts.deps.chat(model, prompt, DECOMPOSE_CHAT_TIMEOUT_MS);
    if (!r.ok) return [];
    const template = parseDecomposition(r.text, taskDescription);
    if (template.length >= 2) {
      logger.info({ taskDescription: taskDescription.slice(0, 80), subTaskCount: template.length }, 'LLM智能拆解成功');
    }
    return template;
  } catch (err) {
    logger.warn({ err: (err as Error).message, taskDescription: taskDescription.slice(0, 80) }, 'LLM拆解失败');
    return [];
  }
}

/** 缺省提交口：端点的 OpenAI 兼容 chat/completions。失败一律 `{ok:false}`，绝不外抛。 */
export async function postDecomposeChat(
  endpoint: DecomposeEndpoint,
  prompt: string,
  timeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; detail: string }> {
  try {
    const res = await fetch(resolveChatCompletionsUrl(endpoint.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.api_key}` },
      body: JSON.stringify({
        model: endpoint.model_name || DECOMPOSE_DEFAULT_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: DECOMPOSE_MAX_TOKENS,
        temperature: DECOMPOSE_TEMPERATURE,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return { ok: true, text: data.choices?.[0]?.message?.content?.trim() || '' };
  } catch (e) {
    return { ok: false, detail: (e as Error)?.message || String(e) };
  }
}

/**
 * 生产依赖① —— **IM 路的历史形状**。
 *
 * 它直连 `{ansUrl}/api/v1/models/optimal`，与 `agent-executor` 经 `ansClient` 取模型那条路
 * **不是同一条**（两条并存属既成事实，如实记在方案 §5）——本轮**仍不并这两条**。
 *
 * zx_20260930 M9（**换的是请求形状，不是语义**）：取模型这个动作、`capabilities`/`strategy`、
 * 超时、默认模型都一字未改；改的只有"怎么发这个请求"——
 *   此前只发 `x-api-key`（ANS 要三头齐备 ⇒ **恒 401**），且 401 走 `if (!resp.ok) return null`
 *   这条**静默**路（401 不抛，调用方连 warn 都收不到）；
 *   现改走 `ansSignedRequest`（三头齐备、4xx 不重试、失败带 status 留痕）。
 * 形参由"无"改为 `creds: AnsCreds`：**签名要 secret，而 secret 只能由调用方给**
 *   （桌面 main 不加载 `.env`，本模块自己 `process.env` 读不到它）。
 */
export function makeEnvDecomposeDeps(creds: AnsCreds): DecomposeDeps {
  return {
    async resolveModel() {
      // 注：`creds` 在**调用时**由调用方现取（不是模块加载时定）——与原实现"调用时才读 env"同一时机。
      const r = await ansSignedRequest(creds, '/api/v1/models/optimal', {
        method: 'POST',
        body: { capabilities: ['chat'], strategy: 'cost-optimal' },
        timeoutMs: DECOMPOSE_MODEL_TIMEOUT_MS,
      });
      if (!r.ok) {
        logger.warn({ detail: ansFailureNote(r) }, '取模型失败（ANS）— 拆解退回规则路');
        return null;
      }
      const modelData = await r.response!.json() as { url?: string; api_key?: string; model_name?: string };
      if (!modelData.url || !modelData.api_key) return null;
      return { url: modelData.url, api_key: modelData.api_key, model_name: modelData.model_name };
    },
    chat: postDecomposeChat,
  };
}

/** 生产传进来的选型口形状（`ansClient.getOptimalModel`）——只取这一个方法，不把整个客户端拖进来 */
export interface OptimalModelClient {
  getOptimalModel(params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * 生产依赖② —— **引擎内的形状**：走 `ansClient`，与引擎其它"顺手问一次模型"的地方同形
 * （`agent-executor.ts:3642` 的验收/偏离取模型处）。
 */
export function makeAnsDecomposeDeps(ansClient: OptimalModelClient): DecomposeDeps {
  return {
    async resolveModel() {
      const m = await ansClient.getOptimalModel(DECOMPOSE_MODEL_REQUEST) as Record<string, unknown>;
      const url = typeof m?.url === 'string' ? m.url : '';
      const api_key = typeof m?.api_key === 'string' ? m.api_key : '';
      const model_name = typeof m?.model_name === 'string' ? m.model_name : '';
      if (!url || !api_key) return null;
      return { url, api_key, model_name };
    },
    chat: postDecomposeChat,
  };
}

// ==================== 模板 → `wa_tasks` 行 ====================

export interface PlanSubtasksOptions {
  parentTaskId: string;
  projectId: string;
  template: readonly DecompositionTemplate[];
  /** **父任务**当前深度；子任务深度 = `depth + 1` */
  depth: number;
  /** `wa_tasks.source` 列取值 */
  source: string;
  /** 追加进每个子任务 `context_json` 的自有键（引擎路无额外键，IM 路带 channel/externalUser） */
  contextExtra?: Record<string, unknown>;
}

export interface PlanSubtasksResult {
  /** 实际建出的行数（**报数只许用这个**，不许用 `template.length`） */
  created: number;
  /** 模板声明的行数 */
  planned: number;
  childIds: string[];
  /** 其中无前置、可立即执行的个数 */
  noDepCount: number;
  /** 未建满的真因（深度闸/广度闸）；建满则为 null */
  refusal: string | null;
}

/**
 * 模板 → `wa_tasks` 行。**只负责把行写对**，"什么时候该拆"不在这里。
 *
 * 三件守卫**全部复用既有真源**（不新造第二套尺）：
 *  - 深度：`MAX_TASK_DEPTH`（`task-accounting.ts`）
 *  - 广度：`childBreadthRefusal`（同一处；只数**在途**子任务，已终态不占位）
 *  - 自环：`resolveIndexDeps` 的 `selfId` 形参——模型把某子任务的前置写成**它自己**时丢弃
 *    （否则该子任务恒 `waiting`，永不执行、父永不放行：正是 D4 断点②）。
 *
 * ⚠ **闸的判据必须在生成 childId 之前**：`childIds` 是同批序号索引的载体，
 *   先 push 后 break 会让"已 push 但未建"的 id 参与后续 `dependsOn` 解析 ⇒ 悬空前置
 *   （承 `zx_20260916_3` M1 的同一处教训）。
 */
export function planSubtasksFromTemplate(db: AccountingDb, opts: PlanSubtasksOptions): PlanSubtasksResult {
  const planned = opts.template.length;
  const childDepth = opts.depth + 1;
  const empty = { created: 0, planned, childIds: [] as string[], noDepCount: 0 };
  if (childDepth > MAX_TASK_DEPTH) {
    return { ...empty, refusal: `子任务嵌套深度 ${childDepth} 超过上限 ${MAX_TASK_DEPTH}（父任务已在第 ${opts.depth} 层）` };
  }
  const childIds: string[] = [];
  let noDepCount = 0;
  let refusal: string | null = null;
  for (let i = 0; i < planned; i++) {
    const gate = childBreadthRefusal(db, opts.parentTaskId);
    if (gate) { refusal = gate; break; }
    const childId = randomUUID();
    childIds.push(childId);
    const depIds = resolveIndexDeps(opts.template[i]!.dependsOn, childIds, childId);
    if (!depIds) noDepCount++;
    const ctx = {
      depth: childDepth,
      auto_decomposed: true,
      parent_task_id: opts.parentTaskId,
      // zx_20261016_3 M33-b: 目的因落进子任务 context（详情页读 `$.purpose` 显示）。
      //   ⚠ **有才写**：模板没带 purpose（GUI 模板路 / 内置模板 / 人手写的模板）时不写这个键——
      //   不编一个空串冒充"目的已标注"（缺键 ≠ 坏值）。
      ...(opts.template[i]!.purpose ? { purpose: opts.template[i]!.purpose } : {}),
      ...(opts.contextExtra ?? {}),
    };
    db.prepare(
      'INSERT INTO wa_tasks (id, project_id, title, description, status, priority, context_json, parent_task_id, source, acceptance_criteria, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      childId, opts.projectId, opts.template[i]!.title, opts.template[i]!.description,
      // zx_20260924_1 M3-a（J-6）：priority 这一格装的是**拆解序号**（模板序），不是紧要度——
      //   写 `decomposePriority(planned, i)`（3 个子任务 ⇒ 3/2/1），与 `ORDER BY priority DESC` 的两处读点
      //   （`task-scheduler.getReadyTasks` / `control.exit_plan_mode`）同一口径 ⇒ 模板第 1 个最先起跑。
      //   改前写裸 `i` ⇒ 同批无前置子任务里**最后一个反而最先起跑**。换算只此一处（勿在别处重写算式）。
      'pending', decomposePriority(planned, i), JSON.stringify(ctx), opts.parentTaskId, opts.source,
      opts.template[i]!.acceptance_criteria || '', depIds,
    );
  }
  return { created: childIds.length, planned, childIds, noDepCount, refusal };
}

// ==================== 历史拆解模式（三路共用一份取法） ====================

/**
 * zx_20261002 M6（「同一件事，才叫重复」）：`wa_projects.context_json.decomposition_patterns`
 * → 拆解 prompt 里那句「历史拆解模式参考」的**唯一取法与唯一写法**。
 *
 * 此前只有 IM 路会读它（`im-router.ts` 内联三行：SELECT → `Object.entries` → 拼串）；
 * 引擎路（`enter_plan_mode`）每次冷启动、不参考任何历史 ⇒ 同一项目里两路拆出来的粒度不一致。
 * 取法与拼串**各只此一处**，三路（引擎/IM/启动）同取。
 *
 * 读失败按"无历史模式"（不因读不到参考就整条拆解失败——同 IM 路旧口径）。
 */
export function loadDecompositionPatterns(db: BoolSettingDb, projectId: string | null | undefined): string | undefined {
  if (!projectId) return undefined;
  try {
    const proj = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as
      | { context_json?: string | null }
      | undefined;
    const patterns = (JSON.parse(proj?.context_json || '{}') as {
      decomposition_patterns?: Record<string, number | { n?: number; avgQuality?: number | null }>;
    }).decomposition_patterns;
    if (!patterns || Object.keys(patterns).length === 0) return undefined;
    // zx_20261016_3 M32（质量分入闸·拆解侧）: 形状由裸数升级为 `{n, avgQuality}`（写侧 `jobs/index.ts`）；
    //   旧项目 `context_json` 里仍是裸数 ⇒ **两种形状都认**（裸数=只知粒度、不知质量，照旧不作注）。
    //   低分族（`avgQuality < 中带下沿`）如实加注「近期完成分偏低，仅供参考」——参考仍在，但不再与高分族同权。
    const parts: string[] = [];
    for (const [a, v] of Object.entries(patterns)) {
      const n = typeof v === 'number' ? v : v?.n;
      if (typeof n !== 'number') continue;
      const q = typeof v === 'number' ? undefined : (typeof v?.avgQuality === 'number' ? v.avgQuality : undefined);
      const lowNote = q !== undefined && q < QUALITY_BANDS.mid ? `（近期完成分偏低 ${q}，仅供参考）` : '';
      parts.push(`${a}类: 约${n}个子任务${lowNote}`);
    }
    if (parts.length === 0) return undefined;
    return parts.join('、');
  } catch {
    return undefined;
  }
}

/**
 * zx_20261012_2 批四（拆解随本相）: 从拆解依据文本里提取「里程碑提示」——
 * **只在目标文本点名了 `plans/` 下的 `.md` 方案文件时**才去读它。
 *
 * 为什么：目标说"按 plans/x.md 的 M1–M4 实施"时，拆解器此前**看不见**那些里程碑 ⇒ 拆出来的子任务
 * 不承接任何 M 号 ⇒ 里程碑板留下未承接项（`unclaimedMilestones` 恒非空）。本函数把该文件里的 M 号
 * 去重后交出，供提示词强制"一里程碑一子任务"。
 *
 * **有界且如实降级**：路径以**项目工作目录**解析（目标里的路径是工作区内相对路径；只有
 * `wa_projects.working_dir` 能定位它）；读失败 / 文件超 `MILESTONE_HINT_MAX_BYTES` 一律返回空串
 * （不因读不到参考就阻断拆解——与 `loadDecompositionPatterns` 同一条口径）。
 * 不足 2 个里程碑也返回空串（1 个不构成"按里程碑切片"的约束，且避免污染既有夹具的提示词）。
 * **不新造里程碑正则**：提取一律走 `milestoneRefsIn`（既有真源）。
 */
export const MILESTONE_HINT_MAX_BYTES = 256 * 1024;
export function milestoneHintOf(db: BoolSettingDb, goal: string, projectId: string | null | undefined): string {
  // ① 目标文本里点名了 plans 下的 .md 文件吗？（路径形态：plans/…/x.md，可含多级目录）
  const m = /(?:^|[\s"'（(])((?:[\w.-]+\/)*plans\/[\w./-]+\.md)/.exec(goal);
  if (!m) return '';
  const rel = m[1] as string;
  try {
    // ② 以项目工作目录为根解析
    let root = '';
    if (projectId) {
      const row = db.prepare('SELECT working_dir FROM wa_projects WHERE id = ?').get(projectId) as { working_dir?: string | null } | undefined;
      root = String(row?.working_dir ?? '');
    }
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MILESTONE_HINT_MAX_BYTES) return '';
    const content = fs.readFileSync(abs, 'utf-8');
    const refs = [...milestoneRefsIn(content)].sort();
    // zx_20261015_2 D3: 带上方案里写着的**名字**（`M0 口径与前置确认`），不是光一个编号——
    //   否则提示词约束不出真名，拆出的子任务名字对不上方案（见 `milestoneTitledRefsIn` 头注释）。
    //   取不到标题的 M 号逐字回退为"仅 M 号"（如实降级）——故 M 号版方案的交出**逐字不变**。
    const titled = milestoneTitledRefsIn(content);
    const ms = refs.map((m) => { const t = titled.get(m); return t ? `${m} ${t}` : m; });
    return ms.length >= 2 ? ms.join('、') : '';
  } catch {
    return '';
  }
}

/**
 * zx_20261013_2 批三（空性·缘起 / 道德经「知不知上」）：拆不完时**如实说**——且要说成**人听得懂的样子**。
 *
 * 此前两路**都报数**，但皆是「槽位满了」的**拒绝口吻**：引擎路那段话**写给模型**（"此刻可走的路：①…②…③…"，
 * 是操作指引不是告知），IM 路只落一句「其余未建」——**死路**，没说"还能怎么补"。而创始人诉求是
 * "一里程碑一子任务"，他要知道的是"**哪些里程碑没拆、为什么、之后怎么办**"，不是"槽位已满"。
 *
 * 本函数把"没拆完"这一事实收成一句**给人看的话**（一处实现，引擎路/IM 路共用——不各写一份）：
 *   · **在册的**：规划几个、实建几个、余几个未建；
 *   · **未建的**：明写"**未建、亦未自动排期**——须由人工补齐，或待前批完成、槽位释放后择机再拆"（不当死路）；
 *   · 若拆解时**点名过里程碑**（`milestoneHint`），把方案里的 M 号一并写上——数目才落得到具体的东西上（维特根斯坦：意义即用法）。
 *
 * ⚠ **只描述、不承诺**：本函数**不做**滚动拆解（那是择机的下一步，见方案 §2 批三 (a)）——故措辞**不得**写成
 *   "会自动续拆"（那是系统眼下**不保证**的事，正是本轮反复点名的"名实不符"）。`created >= planned` 一律返回空串
 *   （**建满不得误报**——承 `feedback_predicate_needs_both_sides_specimen`：两只标本，该报的报、不该报的不报）。
 */
export function shortfallNotice(planned: number, created: number, milestoneHint?: string): string {
  if (created >= planned) return '';
  const missing = planned - created;
  const labels = (milestoneHint || '').split('、').map((s) => s.trim()).filter(Boolean);
  const msNote = labels.length > 0 ? `本方案点名 ${labels.length} 个里程碑（${labels.join('、')}），` : '';
  return `${msNote}本轮规划 ${planned} 个子任务、实建 ${created} 个，余 ${missing} 个未建`
    + '（触发原因为槽位上限闸，非拆解失败）。'
    + `余下 ${missing} 个本轮**未建、亦未自动排期**——须由人工补齐，或待前批完成、槽位释放后择机再拆。`;
}

// ==================== 「到点即拆」的执行体（唯一一处） ====================

export interface AutoDecomposeOptions {
  db: AccountingDb;
  /** 待拆的**父**任务 id */
  taskId: string;
  projectId: string;
  /** 拆解依据文本（引擎路 = `goal_summary`；启动路 = 标题 + 描述） */
  goal: string;
  /** **父任务**当前深度（子任务深度 = 本值 + 1） */
  depth: number;
  /**
   * **惰性**取拆解依赖——门未全过时一次都不调用。
   *
   * 「开关关 ⇒ 逐字回旧行为」这条如实性要求**落在这里**：若改成提前 `await` 取依赖，
   * 开关关着也会多打一次"问模型端点"的 HTTP（既有判据 `fetches() === before` 随即失守）。
   */
  getDeps: () => Promise<DecomposeDeps>;
  /** 见 `loadDecompositionPatterns`；无历史模式则省略 */
  patterns?: string;
  /** 会话流那句 `[智能拆解] …` 的**来源词**（`计划模式`/`任务启动`）——各路口径不同，由调用方给 */
  label: string;
  /** 无前置者的启动时机说明（计划模式 = "退出计划模式后立即启动"；启动路 = "立即启动"） */
  noDepWhen: string;
  /** 追加进每个子任务 `context_json` 的自有键（IM 路带 channel/externalUser；引擎/启动路无） */
  contextExtra?: Record<string, unknown>;
}

export interface AutoDecomposeResult {
  created: number;
  planned: number;
  noDepCount: number;
  refusal: string | null;
}

/**
 * zx_20261002 M5（「意义即用法」）：把"到点即拆"的**门 + 拆 + 落行 + 留痕**收成**一处实现**。
 *
 * 此前这四件事内联在 `enter_plan_mode` 工具里（`control.ts`）——**只有模型主动调这个工具**才会走到
 * ⇒ 真库 `auto_decomposed` 恒零行。现抽成本函数，两路共用同一份：
 *   ① 引擎路（`enter_plan_mode`，模型显式进入计划模式）；
 *   ② 启动路（`ai-task` 处理器，**到点即拆**，不依赖模型自觉）。
 *
 * 门（两道，皆既有真源）：
 *   - `engine.plan_auto_decompose` 开关（**缺省即开**）关 ⇒ 直接 null，逐字回旧行为；
 *   - `alreadyDecomposed`（在途子数 > 0）⇒ null，**不覆盖**模型/前序已经开始的规划。
 *
 * **失败即如实**：拆不出（模板 < 2）或一行都没建（`created === 0`，如深度/广度闸拒）⇒ 返回 null，
 * 由调用方按各路的旧行为继续（单任务照跑）——**绝不**为"让数字好看"而空建子任务。
 *
 * ⚠ 本函数**不写**父任务状态、**不写** `$.auto_decomposed` 标记：两者都随路而异
 *   （计划模式写 `planning` + 标记；启动路写 `paused` + 标记——且标记必须压在各自的
 *   `context_json` 覆写**之后**，否则被覆写冲掉）。
 */
export async function autoDecomposeForTask(opts: AutoDecomposeOptions): Promise<AutoDecomposeResult | null> {
  if (!readBoolSetting(opts.db, 'engine.plan_auto_decompose')) return null;
  if (alreadyDecomposed(opts.db, opts.taskId)) return null;
  try {
    const deps = await opts.getDeps();
    // 里程碑提示：目标若点名了方案文件，按其中的 M 号强制"一里程碑一子任务"（读不到即空串、如实降级）
    const milestoneHint = milestoneHintOf(opts.db, opts.goal, opts.projectId);
    const template = await decomposeTask(opts.goal, {
      deps,
      ...(opts.patterns ? { patterns: opts.patterns } : {}),
      ...(milestoneHint ? { milestoneHint } : {}),
    });
    if (template.length < 2) return null;
    const r = planSubtasksFromTemplate(opts.db, {
      parentTaskId: opts.taskId, projectId: opts.projectId, template, depth: opts.depth, source: 'auto-decompose',
      ...(opts.contextExtra ? { contextExtra: opts.contextExtra } : {}),
    });
    if (r.created === 0) return null;
    // zx_20261013_2 批三: 没拆满时**明说**（给人看的那句由 `shortfallNotice` 一处产出，不在本处另写）；
    //   紧跟一行「闸的真因」保留原有那句**面向模型**的操作指引（含"此刻可走的路"），信息不丢。
    const shortfall = shortfallNotice(r.planned, r.created, milestoneHint);
    opts.db.prepare('INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?, ?, ?, ?)').run(
      randomUUID(), opts.taskId, 'system',
      `[智能拆解] ${opts.label}：目标已自动拆分为${r.created}个子任务（状态 pending；${r.noDepCount} 个无前置，${opts.noDepWhen}，其余待前置完成）`
      + (shortfall ? `\n（未建满：${shortfall}）\n（闸的真因：${r.refusal ?? ''}）` : ''),
    );
    logger.info({ taskId: opts.taskId.slice(0, 8), created: r.created, planned: r.planned, label: opts.label }, '自动拆解已建子任务');
    return { created: r.created, planned: r.planned, noDepCount: r.noDepCount, refusal: r.refusal };
  } catch (e) {
    // 拆解失败**不阻断**：调用方按各路旧行为继续（这正是改前的全部行为）。
    logger.warn({ taskId: opts.taskId.slice(0, 8), err: (e as Error)?.message }, '自动拆解失败，按单任务执行');
    return null;
  }
}
