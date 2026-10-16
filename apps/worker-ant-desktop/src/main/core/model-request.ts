/**
 * zx_20260920_1 M4（墨子·摹略万物之然）: "向 ANS 要模型"这件事**该说什么**，从执行体里抽出来，
 * 使「要什么能力」可被受控回归直跑真实现（同 `settings-bool.ts` / `task-archetype.ts` 的既有手法）。
 *
 * 病根（方案 §1.2）：`modelReq.capabilities` **长期写死 `['chat','function-calling']`**——
 * 形态（原型）只影响 `strategy`（排序），**从不影响"入围条件"**。于是「写代码的任务」与
 * 「闲聊的任务」向 ANS 要的是同一样东西，选到谁全看排序与运气。`maxCostPer1k` 更是**全仓零处传入**：
 * 成本上限这个维度从未参与匹配。
 *
 * 本模块**零依赖**（不引 electron / better-sqlite3 / node:*），故可被回归直接跑真实现。
 */
import type { TaskArchetype } from './task-archetype.js';
// zx_20261003 M3: 判族**一把尺**——`familyOf`（扩展名真源）与 `sniffFileType`（魔数真源）都从
//   `attachment-kinds.ts` 引（零依赖，两侧同名同义）。本模块**不**另写扩展名表。
import { familyOf, sniffFileType, SNIFF_HEAD_BYTES, type AttachmentFamily } from './attachment-kinds.js';

/** 任何形态的底线能力：少了 `chat` 不成对话，少了 `function-calling` 调不到工具。 */
export const BASE_MODEL_CAPABILITIES: readonly string[] = ['chat', 'function-calling'];

/**
 * 形态 → **附加**能力（在底线之上加，不替换）。
 *
 * ⚠ `research` 与 `analysis` **刻意同值**（都给 `+reasoning`）——**不合并成一行**：
 *   合并即"两个概念挤进一个槽位"，日后二者若真的分家，一行的写法会让人以为它们本就无关。
 * ⚠ 为何不由 `priorityTools` 推导：那是**倾斜提示**、不是**能力需求清单**，两者不能互推
 *   （同 `task-archetype.ts` 里 `ARCHETYPE_TOOL_CATEGORIES` 表前的同款理由）。
 */
export const ARCHETYPE_EXTRA_CAPABILITIES: Record<TaskArchetype, string[]> = {
  code: ['code'],
  research: ['reasoning'],
  analysis: ['reasoning'],
  document: [],
  configuration: [],
  conversation: [],
};

/**
 * 按形态派生"向 ANS 要什么能力"。`hasMedia` 为真时追加 `vision`（来路见 `task.context_json.attachments`，
 * 槽位由 M5 的入站媒体落盘填）。
 *
 * **返回值序稳定**（底线能力在前、附加在后），便于比对与断言——不依赖对象键序的偶然性。
 */
export function deriveModelCapabilities(
  archetype: TaskArchetype,
  opts: { hasMedia?: boolean } = {},
): string[] {
  const caps = [...BASE_MODEL_CAPABILITIES, ...(ARCHETYPE_EXTRA_CAPABILITIES[archetype] ?? [])];
  if (opts.hasMedia) caps.push('vision');
  return caps;
}

/**
 * 组装向 ANS 的匹配请求。
 *
 * **`maxCostPer1k` 未配置时该键根本不出现**——"没这笔账" ≠ "账上是 0"：
 *   键在场且为 0 会被 ANS 的 `(input+output) <= 0` 读成"只要免费模型"，把所有付费模型一次筛没。
 *   这条边界由本函数的**键在场/不在场**保证，不靠调用方记得别传 0。
 */
export function buildModelRequest(input: {
  archetype: TaskArchetype;
  strategy: string;
  hasMedia?: boolean;
  maxCostPer1k?: number;
}): Record<string, unknown> {
  const req: Record<string, unknown> = {
    capabilities: deriveModelCapabilities(input.archetype, { hasMedia: input.hasMedia }),
    strategy: input.strategy,
  };
  if (input.maxCostPer1k !== undefined) req.maxCostPer1k = input.maxCostPer1k;
  return req;
}

/**
 * zx_20260924 M6-d（维特根斯坦·一个词一个用法）: **辅助 LLM 这一档**的能力口径——按**调用身份**定档的唯一真源。
 *
 * 病根：主执行路按形态派生能力（`research`/`analysis` ⇒ `+reasoning`），而**辅助路**（标题生成 / 摘要 /
 * 语义匹配 / 拆解 / 充分性核验）各自手写 `excludeCapabilities:['reasoning']`——同一份模型池被两套
 * 互斥判据切分：主路要的、辅助路恰恰排除。**不是池子不够，是两处口径从未对齐。**
 *
 * 故本档把"辅助路该要什么、该排除什么"收在**一处**：调用点只说"我是辅助路"，不再各写 `include`/`exclude`。
 * ⚠ 本档只管**能力口径**，不管排序策略——`strategy` 是可选项，调用点原有的 `balanced` 该留就留
 * （顺手改策略是另一件事，会悄悄挪动选到谁）。
 * ⚠ `embedding`（另一档：只需 `embedding`）与 `tools/resource.ts` 的**用户传参直通**都不并入本档。
 */
/**
 * ⚠ 能力取值**写成字面量**（`as const`）而非 `readonly string[]`：这一档要的能力恰好只有一个，
 *   而调用点是 `ansClient.getOptimalModel(req: ModelRequirements)`——那里 `capabilities` 是
 *   `ModelCapability[]`（联合类型）。写成 `string[]` 就不 assignable，逼得每个调用点各加一次
 *   `as` 断言，等于把"这一档要什么"重新散回 19 处。字面量类型在这里不是炫技，是**让唯一真源能真的被吃下**。
 */
export const AUX_LLM_CAPABILITIES = ['chat'] as const;
export const AUX_LLM_EXCLUDE_CAPABILITIES = ['reasoning'] as const;
export const AUX_LLM_STRATEGY = 'cost-optimal';

/**
 * 辅助路**用得上的**两种排序。`ModelRequirements.strategy` 是联合类型 `MatchStrategy`，
 * 而本档只需断言"调用点能传的就在这几个里"——**不复制整张 `MatchStrategy` 词表**
 * （那是手抄，抄了就会与真源分家）；只列本档真会用的两个，别的策略若要进来，
 * 编译期就会在这里被拦下、逼人回来改这一处，而不是悄悄放行。
 */
export type AuxStrategy = typeof AUX_LLM_STRATEGY | 'balanced';

/**
 * 辅助路的选型请求。**键序固定**（`capabilities, strategy, excludeCapabilities`）——
 * `rr_zx_20260921.ts` 按 `JSON.stringify` 与本函数逐字比对拆解请求，键序漂了就会红。
 */
export function auxModelRequest(input: { strategy?: AuxStrategy } = {}): {
  capabilities: ('chat')[];
  strategy: AuxStrategy;
  excludeCapabilities: ('reasoning')[];
} {
  return {
    capabilities: [...AUX_LLM_CAPABILITIES],
    strategy: input.strategy ?? AUX_LLM_STRATEGY,
    excludeCapabilities: [...AUX_LLM_EXCLUDE_CAPABILITIES],
  };
}

/**
 * zx_20260924 M6-a（毛选·实事求是）: **回验** ANS 给的模型到底带不带本任务要的能力。
 *
 * 返回 `null` ＝ 回包**未带** `capabilities`（旧 ANS / 降级备用）⇒ **无从比对**——
 * 此时既不报"相符"也不报"不符"（编一个结论比不说更坏）。
 * 返回 `{ got, missing }`：`missing` 为空 ＝ 相符；非空 ＝ 缺哪几个（逐个点名，不只说"不匹配"）。
 *
 * ⚠ 只判**需求 ⊄ 实得**这一个方向：实得比需求多是**好事**（如文档形态要 `chat` 而模型还会 `code`），不算不符。
 */
export function compareModelCapabilities(
  demand: readonly string[],
  reply: unknown,
): { got: string[]; missing: string[] } | null {
  const raw = (reply as { capabilities?: unknown } | null | undefined)?.capabilities;
  if (!Array.isArray(raw)) return null;
  const got = raw.map(String);
  return { got, missing: demand.filter((c) => !got.includes(c)) };
}

/**
 * zx_20261013_1 批一（称器于事 · 毛选「主要矛盾」／道德经「损有余而补不足」）:
 * **能力需求分档**——哪些能力「缺即残废」（hard），哪些「缺可续跑、但须对用户可见」（soft）。
 *
 * 病根：`capabilities` 长期是一张**平表**（底线 + 形态附加 + `vision`），全被当作硬需发给 ANS；
 *   而 ANS 两段式选型在**全中池为空**时会主动降到**部分命中**并带 `capabilityMatch:'partial'`；
 *   桌面侧 `compareModelCapabilities` 得 `missing` 后**只写会话行 + `logger.warn`，不拦**
 *   ⇒ 「要 `vision` 的任务拿到无 `vision` 的模型」被装配层逐件 omit 图片**掩盖**过去、任务照判"成功"。
 *
 * 分档口径（按 P1「意义即使用」：能力的义在**它被拿去做什么**）：
 *   · `hard`（缺即残废）—— `chat`（不成对话）／`function-calling`（调不到工具）／`vision`（图**根本看不见**）；
 *   · `soft`（缺可续跑）—— `code`／`reasoning`／其余形态附加。
 *
 * ⚠ **未表态的能力一律按 `soft`**（fail-open）：日后新增能力若忘了在此登记，**不**因此把任务硬拦死——
 *   与「不替一个我们并不知道的事实签字」同一条尺。要把它升为硬需，须回来在此**显式表态**。
 *   ⚠ 本表**不是**能力词表的第二份（词表真源在 `BASE_MODEL_CAPABILITIES` / `ARCHETYPE_EXTRA_CAPABILITIES`）；
 *     它只给已有取值**分档**，不新增取值。
 */
export const CAPABILITY_DEMAND: Readonly<Record<string, 'hard' | 'soft'>> = {
  chat: 'hard',
  'function-calling': 'hard',
  vision: 'hard',
  code: 'soft',
  reasoning: 'soft',
};

/**
 * zx_20261013_1 批一: 把「缺了哪几项」按 hard/soft **分档**——能力把关的**唯一实现**。
 *
 * 复用 `compareModelCapabilities` 现算的 `missing`（**不另立第二份缺口账**）：
 *   它返回 `null`（回包未带 `capabilities`）⇒ 本函数 `got:null`、两个 missing 皆空 ⇒ **不设闸**——
 *   那是「无从比对」，与 `compareModelCapabilities` 同一条尺（不编「不符」）。
 *
 * 返回形状刻意**回传 `got` 原值**（而非布尔）：调用方要的是「实得清单」用来如实成文（会话行／日志），
 *   若只回布尔，调用方就得回头再调一次 `compareModelCapabilities`——同一件事两处算。
 */
export function assessCapabilityGate(
  demand: readonly string[],
  reply: unknown,
): { got: string[] | null; hardMissing: string[]; softMissing: string[] } {
  const cmp = compareModelCapabilities(demand, reply);
  if (!cmp) return { got: null, hardMissing: [], softMissing: [] };
  const hardMissing: string[] = [];
  const softMissing: string[] = [];
  for (const c of cmp.missing) {
    (CAPABILITY_DEMAND[c] === 'hard' ? hardMissing : softMissing).push(c);
  }
  return { got: cmp.got, hardMissing, softMissing };
}

/**
 * zx_20261013_1 批四（维特根斯坦·意义即使用）: 硬需能力缺时**给用户看的那句话**——从执行体里抽出来，
 * 使「为什么这单没开跑」的措辞可被受控回归**逐字**钉住（此前只正则匹配一个片段）。
 *
 * 三段俱到，缺任一段用户就看不出"差在哪"：**要什么**（`demand`）/ **给了谁**（`modelName`）/
 *   **实得什么**（`got`）。`got` 可为 `null`（回包未带清单）——如实成文，不编。
 * 零依赖纯字符串 ⇒ rr 直跑真实现；执行体只负责**落账 + 抛**（I/O），措辞归这里一处。
 */
export function capabilityGateMessage(o: {
  demand: readonly string[];
  got: readonly string[] | null;
  hardMissing: readonly string[];
  /** ANS 回包的模型名（`unknown`：回包未定型，`String(...)` 成文即可，不作断言前提）。 */
  modelName?: unknown;
}): string {
  return `本任务硬需能力 [${o.hardMissing.join(', ')}] 无模型可满足`
    + `（本任务需 [${o.demand.join(', ')}]，选用模型 ${String(o.modelName ?? '未知')} 实得 [${(o.got ?? []).join(', ')}]）`;
}

/**
 * zx_20260924 M6-e②（管子·度量衡）: 从 ANS 零命中回包里取**它自己说出的**成因摘要
 * （`explainMatchFailure` 构造的 `error.diagnostics.summary`，即"卡在第几道闸"）。
 *
 * 取不到一律返回 `''`——**如实少说**（旧 ANS 不返回 `diagnostics` 时就只说得出"没有匹配的模型"），
 * 而不是替它编一句。
 *
 * 认的是**形状**（`error` 键在场 + `diagnostics.summary` 是字符串），**不是文案**：
 * 按文案认的判据，ANS 改一个字就整条失效，且失效是**静默**的（判据照绿、功能没了）。
 *
 * **本函数是这一问的唯一实现**——`audio-transcribe.ts` 的 `describeModelSelectionFailure` 与
 * `exec-model-select.ts` 的选型失败出口都引它，防"同一个判据写两份、两份迟早分家"（G8/G9 老病）。
 * 刻意**不放进 `ans-client`**：那会让每个触及 `exec-model-select` 的 rr 脚本都拖进该包的入口
 * （进而拖进 MCP SDK），而这里只是**读一个字段**，不值得换掉零依赖这条性质。
 */
export function matchFailureSummary(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const err = (payload as { error?: unknown }).error;
  if (!err || typeof err !== 'object') return '';
  const diag = (err as { diagnostics?: unknown }).diagnostics;
  if (!diag || typeof diag !== 'object') return '';
  const s = (diag as { summary?: unknown }).summary;
  return typeof s === 'string' ? s : '';
}

/** 仅需 prepare().get() 的最小库接口——使本模块可脱 better-sqlite3 */
export interface ModelRequestDb {
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

/** 成本上限的 setting 键（**唯一真源**：读端只此一处，写端由 GUI/用户按同键设置） */
export const MAX_COST_PER_1K_KEY = 'engine.model_max_cost_per1k';

/**
 * 从 `wa_settings` 读成本上限（美元/1k tokens）。
 *
 * **解析失败 / 非正数 / 空串一律当作"未配置"（`undefined`）**，而不是静默变成 0——
 * 0 在 ANS 侧是"只要免费模型"的**合法上限**，把脏值读成 0 会让整池模型凭空消失。
 */
export function readMaxCostPer1k(db: ModelRequestDb): number | undefined {
  try {
    const row = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get(MAX_COST_PER_1K_KEY) as
      | { value?: string }
      | undefined;
    if (!row?.value) return undefined;
    const n = Number(row.value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 任务上下文里有无媒体（M5 的入站媒体落盘填 `context_json.attachments`，非空数组即"含媒体"）。
 * 槽位缺席/非数组/空数组一律按"无媒体"——**不臆断**。
 */
export function taskHasMedia(taskCtx: { attachments?: unknown } | undefined): boolean {
  return Array.isArray(taskCtx?.attachments) && taskCtx.attachments.length > 0;
}

/**
 * zx_20261002 M15（维特根斯坦·一个词一个用法 / 管子·度量衡）: **附件族 → 执行模型需具备的能力**。
 *
 * 由 `attachmentsNeedVision`（zx_20260921 M2）"只认 image"扩为**按族派生**：此前一件视频虽然会被
 * `attachment-inline.ts` 抽帧成 image part，执行模型却从不因此被要求 `vision`——抽帧那支又恰好
 * 拿 `visionOk` 当闸（模型无 vision ⇒ **连抽都不抽**）⇒ 视频的画面**永远送不进去**，且账上无声。
 * 这是一条**参数对不上**的缺口，不是能力缺失。
 *
 * 只登记**经执行模型通道**进来的族（装配事实见 `attachment-inline.ts`）：
 *   · `image`    → `vision`：光栅图直接作为 image part 内联（`:302`）。
 *   · `video`    → `vision`：音轨本地转写之外，**画面抽帧**后同样作为 image part 内联（`:415-421`），
 *                  且**仅在模型具备 `vision` 时才抽**（`:397`）——故不在这里要 `vision`，帧就永远不会到。
 *   · `document` → 空：PDF / 文本由 `extractPdf` / `extractDoc` 抽成**文字**喂入，全走文本通道。
 *   · `audio`    → **空（刻意）**：音频**不经执行模型**——`:350-370` 交 `transcribeAudio` 本地转成
 *                  文字再喂；"要一个能收音频的模型"由**另一跳**独立完成（`audio-transcribe.ts` 的
 *                  `buildAudioModelRequest` 自向 ANS 追加 `audio`）。把 `audio` 加到这里，只会拿一个
 *                  与"执行模型听不听得懂"无关的条件筛掉好模型（承 `zx_20260921` M2 对 MP3 的原始结论）。
 *   · `binary`   → 空：本轮不内联（`:443`）。
 *
 * ⚠ **穷举 `AttachmentFamily`**：新增族必须在此表态——要么给能力，要么显式空行 + 理由。
 */
export const ATTACHMENT_FAMILY_CAPABILITIES: Readonly<Record<AttachmentFamily, readonly string[]>> = {
  image: ['vision'],
  video: ['vision'],
  audio: [],
  document: [],
  binary: [],
};

/**
 * 一件附件的族——判法与**装配层**（`attachment-inline.ts:207/218`）**同源**：
 *   **先扩展名（落盘保 basename）、退到 `kind`/MIME；有 `readHead` 时魔数优先**。
 *
 * zx_20261003 M3（名实相符）: 此前本函数**只**看扩展名，而装配层看魔数——两把尺。
 *   一件改名 `movie.mp4 → movie.bin` 的视频：选型期判成 `binary` ⇒ **不向 ANS 要 `vision`**
 *   ⇒ 选到无 vision 模型 ⇒ 装配期认出是视频却没有 vision ⇒ **抽帧永不发生**，且账上无声。
 *   现改用与装配层同一把尺（魔数优先、退扩展名），两处对同一件东西必得同族。
 *
 * ⚠ **不引 `node:fs`**：读头那件事由调用方以 `readHead` 注入（生产在 `exec-model-select.ts` 传
 *   `readHeadFromFile`）——本模块零依赖这条性质不破（承其"可被回归直跑真实现"的既有理由）。
 *   `readHead` 缺席 ⇒ **如实退扩展名**（旧行为），不臆断、也不报错。
 */
function familyOfAttachment(raw: unknown, readHead?: (p: string, n: number) => Uint8Array | null): AttachmentFamily {
  const item = (raw ?? {}) as { kind?: unknown; fileName?: unknown; path?: unknown };
  const p = typeof item.path === 'string' ? item.path : '';
  const name = typeof item.fileName === 'string' && item.fileName ? item.fileName : p;
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot) : '';
  let declared: AttachmentFamily;
  if (ext) declared = familyOf(ext);
  else declared = familyOf(typeof item.kind === 'string' ? item.kind : '');
  // 有路径又有嗅探口 ⇒ 看一眼前 N 字节；嗅不出（`null`）⇒ 守扩展名/kind 判出的族（退路，非失败）。
  if (!readHead || !p) return declared;
  const sniffed = sniffFileType(readHead(p, SNIFF_HEAD_BYTES));
  return sniffed ? sniffed.family : declared;
}

/**
 * zx_20260921 M2（维特根斯坦·意义即使用）: 这批附件**要不要视觉输入**。
 *
 * 病灶：`deriveModelCapabilities` 的 `hasMedia` 原本由 `taskHasMedia` 直接喂。M1 起附件可以是
 * **任何族**（音频 / PDF / txt），而 `vision` 说的是"模型收不收图"——一件 MP3 会让选型凭空
 * 要求 `vision`，把不入围的好模型筛掉，却对"能不能听这段音频"毫无帮助。M3 的 PDF 同理：
 * 正文抽成文字后喂进去，全程不走视觉通道。
 *
 * ⇒ 闸门只认族词表里**要 `vision` 的族**（M15 起为 `image` ∪ `video`；判族复用 `attachment-kinds.familyOf`
 * 经 `familyOfAttachment`，不另写一张扩展名表）。`familyOf` 的 `binary` 兜底（认不出的）不在此列。
 *
 * zx_20261003 M3: `readHead` 为**可选注入**（生产由 `exec-model-select.ts` 传 `readHeadFromFile`）。
 *   给了它 ⇒ 判族与装配层同尺（魔数优先）；没给 ⇒ 退扩展名（旧行为）。
 */
export function attachmentsNeedVision(
  attachments: unknown,
  readHead?: (p: string, n: number) => Uint8Array | null,
): boolean {
  if (!Array.isArray(attachments)) return false;
  return attachments.some((raw) => ATTACHMENT_FAMILY_CAPABILITIES[familyOfAttachment(raw, readHead)].includes('vision'));
}
