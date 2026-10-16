/**
 * zx_20260921 M8（重构·只动形不动义）: `executeTask` 的**模型选型段**——能力派生 → 向 ANS 要模型 →
 * 三级降级链 → context 窗口兜底 → 执行前策略闸。
 *
 * 搬迁来源：`core/agent-executor.ts` 的 `executeTask` 原选型段，**逐字搬运**，只加函数包裹层、
 * 把外部读值提成参数（`taskCtxJson` / `ansClient` / `archetype` / `modelStrategy` / `db`·`taskId`·`projectId`），
 * 并把**一处** `return { content, steps: 0 }`（策略引擎判暂停）形态化为 `return { stopped: { content } }`。
 *
 * **为什么单独成模块**：这一段是"输入几个读值 + 1 个已建好的 `ansClient`、输出 1 个 `modelResult`"的**单向段**，
 * 中间不写任何跨段累加量，是整条 `executeTask` 里第二好切的一刀（仅次于入口段）。
 * 段内诸局部量凡**下游还要读**的一律随结果回传（`hasMedia`、`sdkRetryCtx`），免得调用方去猜。
 *
 * **在册的两处刻意保留**（勿"顺手统一"）：
 *  · `hasMedia` 与 `needsVision` **不是同一个闸门**——前者"有件（决定要不要装配）"，后者"有**图片族**
 *    （决定要不要向 ANS 要 `vision`）"。M1 起附件可以是音频/PDF，拿"有件"去要 `vision` 是参数对不上。
 *  · `modelCaps` / `maxCostPer1k` 只在本段的两处"如实告知"里用（选型失败文案 + 日志），**不外传**。
 *
 * 返回 `hasMedia` 供下游装配附件内联用（调用方 `if (hasMedia) {...}` 那一段）。
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { buildModelRequest, compareModelCapabilities, deriveModelCapabilities, matchFailureSummary, readMaxCostPer1k, taskHasMedia, attachmentsNeedVision, assessCapabilityGate, capabilityGateMessage } from './model-request.js';
// zx_20261003 M3: 选型期判族的**嗅探口**——与装配层（`attachment-inline.ts` 的 `defaultIo.readHead`）
//   共用同一实现，两处对同一件东西必得同族（详见 `file-head.ts` 头注释）。
import { readHeadFromFile } from './file-head.js';
import { evaluatePolicies } from './policy-engine.js';
// zx_20261012_2 批一（策略可配）: 阈值/窗口读库真源 + 窗内失败数唯一取数实现。
import { countRecentFailures, loadPolicies } from './policy-config.js';
// zx_20261012_2 批一: 策略闸总开关（缺省即开）——关 ⇒ 连取数都不取，逐字回旧行为。
import { readBoolSetting } from './settings-bool.js';
import { pauseTask } from './pause-task.js';
import { PAUSE_REASON_POLICY_PAUSED } from './pause-reason.js';
// zx_20261012_2 批五 M5: `notify_admin` 策略动作须**真的通知到人**（此前只写会话行，名实不符）。
import { pushImNotify } from './im/im-notify.js';
import type { TaskArchetype } from './task-archetype.js';
import { createLogger } from './logger.js';

const logger = createLogger('exec-model-select');

/** 与 `AgentContext.getAnsClient` 的返回**同形**（只取本段用到的那一个方法，避免把整个 ctx 类型拖进来）。 */
export interface AnsClientLike {
  getOptimalModel: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/**
 * zx_20261012_3 批三（「明处」· 选得明）: 这个模型**跑在哪**——`本机` / `局域网` / `云端` / `未知`。
 *
 * 「为什么这次用的是 qwen3.5:9b 而不是 DeepSeek」这类问题的答案，一半在**策略**、另一半在
 * **端点的归属**：本地自建端点天然更便宜、更可能被 `balanced` 策略选中。选型留痕必须说得出这一格。
 *
 * ⚠ 与 `ans-supervisor.ts` 的 `isLocalUrl` **刻意不是一把尺**，勿"顺手统一"：
 *   · `isLocalUrl` 答的是「**可否由桌面端代起**」——探到 LAN 上**别的机器**时绝不代起，故 LAN ⇒ `false`
 *     （该语义被 `rr_zx_20261005_ans.ts` M21-3b 钉死，点名 `10.0.0.5 ⇒ false`）；
 *   · 本函数答的是「**这个模型跑在哪**」——LAN 自建（另一台机器上的 Ollama）本就是"不在公网上"，
 *     故 LAN ⇒ `局域网`。两问不同，同一个 url 得不同答案**是对的**，不是 bug。
 * 非 URL / 主机名认不出 ⇒ `未知`（如实少说，不替它编一个 `云端`）。
 */
export function endpointScope(raw: string): '本机' | '局域网' | '云端' | '未知' {
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return '未知';
  }
  if (!host) return '未知';
  // 环回 + 通配绑定地址（`0.0.0.0` 只会指向"本机上跑的那个"）
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '0.0.0.0') return '本机';
  // RFC1918 私网 + 链路本地（169.254/16）+ mDNS 的 `.local`——自建端点最常见的三种形态
  if (
    /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^169\.254\./.test(host)
    || host.endsWith('.local')
  ) return '局域网';
  return '云端';
}

/**
 * zx_20261012_3 批三: 能力匹配的**如实**标签。
 *
 * 优先采信 ANS 自陈的 `capabilityMatch`（`'full' | 'partial'`，zx_20261002 M14 起随包返回）；
 * 该键缺席（旧 ANS / 旧账）则**现算**（`finalCaps`，与装配图片闸同一把尺）；两处都取不到 ⇒ `未知`
 * ——**不许**在这里默认成 `full`：那是替一个我们并不知道的事实签字（与"不编『不符』"同一条尺）。
 */
export function capabilityMatchLabel(
  modelResult: Record<string, unknown>,
  finalCaps: { got: string[]; missing: string[] } | null,
): string {
  const declared = modelResult.capabilityMatch;
  if (declared === 'full' || declared === 'partial') return declared;
  if (finalCaps) return finalCaps.missing.length === 0 ? 'full' : `缺${finalCaps.missing.length}项`;
  return '未知';
}

/**
 * 降级链上的一跳 / `sdk_fallback` 的存档形状。
 *
 * zx_20260929 M6-1c: 此前三处（`tier2`/`tier3`/`sdk_fallback`）各写一份**同形的内联字面量类型**，
 * 且都**没有** `capabilities`——于是本文件里所有换路点都拿不到"换过去的那个模型具不具备能力"。
 * 收成一处类型，并补上 `capabilities`（ANS 侧 M6-1a 起已随每一跳返回）。
 * ⚠ `capabilities` 声明为 `unknown`：值可能是**键缺席**（旧 ANS / 旧账）、数组、或脏数据，
 *   一律交 `compareModelCapabilities` 按"是不是数组"判（不在这里就地假定它是数组）。
 */
interface EndpointHop {
  url?: string;
  api_key?: string;
  model_name?: string;
  capabilities?: unknown;
  context_window?: unknown;
}

/** 策略引擎在执行前闸口判了暂停 ⇒ 本段就此收尾，调用方须立刻 `return { content, steps: 0 }`。 */
export interface ModelSelectStopped {
  stopped: { content: string };
}

/** 选型完成。 */
export interface ModelSelectPicked {
  /** 最终选中的模型端点（已含三级降级 / context 窗口兜底的结果）。 */
  modelResult: Record<string, unknown>;
  /** 任务是否**带件**（决定下游是否装配附件内联）——注意它**不是** `needsVision`。 */
  hasMedia: boolean;
  /**
   * 任务 `context_json` 的解析结果。原段内是局部量，因**下游两处仍要读**才随结果回传：
   * 装配附件内联要 `sdkRetryCtx.attachments`（`buildAttachmentParts` 的输入）。
   */
  sdkRetryCtx: Record<string, unknown>;
  /**
   * zx_20260930 M10: **实际在用的那个模型**（换路之后）自陈具备的能力清单，原样回传供调用方
   * 传给 `buildAttachmentParts`——由**那一层**去判"这些图片该不该送出去"。
   *
   * 为什么回传**清单**而不是回传一个算好的布尔：装配层的接口要的就是清单（`BuildAttachmentPartsOptions`），
   *   若这里改成布尔，调用方就得**合成**一个 `[]`/`['vision']` 去喂——那是在一个有名有姓的值里编造内容，
   *   而真清单此刻**就在手边**（`finalCaps.got`）。回传原值既有真源、又少一层转译。
   *
   * `null` = 回包没带能力清单（`compareModelCapabilities` 返回 `null`）⇒ 下游**不设闸**：
   *   那是"无从比对"，不是"不具备"（见 `BuildAttachmentPartsOptions` 的同一条尺）。
   */
  modelCapabilities: string[] | null;
}

export type ModelSelectResult = ModelSelectStopped | ModelSelectPicked;

export async function selectModelForTask(o: {
  db: Database.Database;
  taskId: string;
  projectId: string;
  /** 任务 `context_json` 原文（本段内部自行 `JSON.parse`，与搬迁前一致）。 */
  taskCtxJson: string;
  ansClient: AnsClientLike;
  archetype: TaskArchetype;
  modelStrategy: string;
  /**
   * zx_20261012_3 批三: 本任务用的策略**从哪来**（`natural` 自然涌现 > `learned` 已学习 > `default` 硬编码）。
   *
   * 声明为**可选**：本段的既有调用面不止生产那一处——四支 rr 套件也直接调它（`rr_zx_20260929` /
   * `rr_zx_20260921` / `rr_zx_20260921_1` / `rr_zx_20261012_2`），它们不关心策略来源。做成必填
   * 会逼那些调用方**编一个值**喂进来——那是为过编译而在有名有姓的字段里填假话（同
   * `execution_mode` 那条尺）。缺席 ⇒ 留痕写 `未知`（如实少说），**不**默认成 `default`。
   */
  strategySource?: string;
}): Promise<ModelSelectResult> {
  const { db, taskId, projectId, taskCtxJson, ansClient, archetype, modelStrategy, strategySource } = o;
  // P2修③ (2026-09-01): 失败重试不再排除 reasoning——原先的硬排除会误伤智谱 glm-5.2(128K max_output)、deepseek-v4-pro 等
  // 稳定大云模型，导致降级候选只剩本地 Ollama(GPU OOM)；改由 ANS 跨provider备用的云端优先选型 + context 门槛兜底。
  let sdkRetryCtx: Record<string, unknown> = {};
  try { sdkRetryCtx = JSON.parse(taskCtxJson || '{}'); } catch { /* 忽略 */ }
  // zx_20260920_1 M4（墨子·摹略万物之然）: 能力**不再写死**——由形态派生（含媒体则加 `vision`）。
  //   此前六档形态要的是同一样东西（`['chat','function-calling']`），"写代码"与"闲聊"的入围条件一模一样。
  //   成本上限**未配置则该键不出现**（"没这笔账"≠"账上是 0"——0 在 ANS 侧是"只要免费模型"的合法上限）。
  const hasMedia = taskHasMedia(sdkRetryCtx);
  // zx_20260921 M2: **两个闸门不是同一个**——`hasMedia`（有件，决定要不要装配）与
  //   `needsVision`（有**图片族**，决定要不要向 ANS 要 `vision`）。M1 起附件可以是音频/PDF，
  //   拿"有件"去要 `vision` 是**参数对不上**：MP3 不会因为选了个收图模型就听得懂。
  // zx_20261003 M3: 注入**真读头**（`readHeadFromFile`）⇒ 判族与装配层同尺（魔数优先）——
  //   一件改名 `.bin` 的视频在这里就能被认出是 video（而非 `binary`），`vision` 才要得到。
  const needsVision = attachmentsNeedVision(sdkRetryCtx.attachments, readHeadFromFile);
  const modelCaps = deriveModelCapabilities(archetype, { hasMedia: needsVision });
  const maxCostPer1k = readMaxCostPer1k(db);
  // ★ zx_20260920_1 M9-fix：请求体**只经 `buildModelRequest` 一处构造**。
  //   此前这里把它的函数体**内联**了一份，于是"未配置则该键不出现"这条保证落在**函数**上、
  //   而生产走的是**内联那份**——函数只有 rr 在调（判据跑的是生产绕开的实现），与本轮病根同形。
  //   两处仍各自持有 `modelCaps`/`maxCostPer1k` 局部量，只为下方"选型失败"如实告知用。
  const modelReq = buildModelRequest({
    archetype,
    strategy: modelStrategy,
    hasMedia: needsVision,
    maxCostPer1k,
  });
  const modelResult = await ansClient.getOptimalModel(modelReq as Parameters<typeof ansClient.getOptimalModel>[0]) as Record<string, unknown>;

  /**
   * 把模型**换成**这一跳，并把账一起带走。
   *
   * zx_20260929 M6-1c: 此前三处换路各写四行（url/model_name/api_key 各赋一次）而**都不动
   * `capabilities`** ⇒ 换完之后回包仍替**旧模型**声称能力。收成一处，`capabilities` 跟着换。
   *
   * zx_20260930 M10: **四个换路点现在共用这一处**（`sdk_fallback` 也并进来）。此前 `sdk_fallback`
   *   自己写一份、本函数供其余三处，两份**唯一**的差别是"这一跳没给钥匙时怎么办"，而那个差别
   *   **一句注释都没有**——靠"两份相似代码的偶然不一致"承载一条真结论，读的人看不出哪个是有意的。
   *   现在把它提成**必填参数**：差别本身是对的（见下），但不许再以隐式形态存在。
   *
   * @param apiKeyPolicy 这一跳**没带** `api_key` 时怎么办：
   *  · `'drop'` —— **不沿用旧钥匙**，写成空串。`sdk_fallback` 走这条：它换的是**另一家**
   *    provider（账户级故障触发的），旧钥匙属于那个**坏账户**，带过去只会再失败一次；
   *    写空串 ⇒ 显式失败，好过拿错钥匙去撞（zx_20260929 §4-17 的结论）。
   *  · `'reuse'` —— 沿用旧钥匙。`tier2`/`tier3`/context 升级走这条：它们是"主端点**探活没过**"的
   *    **可用性**备用，同族端点常同钥匙。
   *    ⚠ 如实登记（zx_20260930 §2.9-M10）：`tier3` 按上面的道理是**跨** provider、与 `sdk_fallback`
   *    同类，却走 `'reuse'`。这一格**当前取不到标本**——ANS 侧 `decryptEndpoint` 恒把
   *    `api_key: decryptApiKey(e.api_key_ref)` 填进每一跳（解不开则整跳为 `null`、那一支根本不进），
   *    故"跳在场而钥匙缺席"在现网不可能发生。差异**在册、当前不可达**，本轮只做显式化，不改行为。
   *
   * ── zx_20261002 M13 **裁定：「可用性备用不回验」**（已定案，勿再当缺陷复述）────────────────────
   * 本函数在 `tier2`/`tier3` 这两跳上**不做能力回验**，理由是**回验在此取不到可行动作**：
   *   · `tier2`/`tier3` 是"主模型**探活没过**"时的**可用性**备用——目的就是**让任务能开工**；
   *   · 判"不符"若**抛** ⇒ 把任务判死（原地只剩一个探活不过的原端点），与"备用"的存在意义相反；
   *   · 判"不符"若**换别的** ⇒ 没有别的：回包里能救场的就这一两跳，且原端点已知探活不过。
   *   ⇒ 验了也**不能改结果**，故**不验**。替代物是**如实告知**：换路时能力清单随跳带走，
   *     三处调用点各记 `tier`/`provider` 供事后核对；装配层再按**实际在用**的清单判图片能力闸
   *     （见 `needsVision` 那段）。一个**能开工但降级**的模型，好过一个**开了工却判死**的任务。
   *
   * ⚠ 与下方 `sdk_fallback` 支的**已回验 + 如实抛出**刻意**不是一把尺**（用户 2026-09-29「分路处理」裁定）：
   *   那支是**账户级故障的降级路**，备用也不合格＝"没有可用模型"，该抛；本处是"主端点已死、备用来救场"，
   *   两情形不同，故处置不同——**别把两处"统一"起来**（那是把一条真结论抹平成一句口号）。
   */
  const applySwap = (hop: EndpointHop, apiKeyPolicy: 'reuse' | 'drop') => {
    modelResult.url = hop.url || modelResult.url;
    modelResult.model_name = hop.model_name || modelResult.model_name;
    modelResult.api_key = hop.api_key || (apiKeyPolicy === 'reuse' ? modelResult.api_key : '') || '';
    if (Array.isArray(hop.capabilities)) modelResult.capabilities = hop.capabilities;
    else delete modelResult.capabilities;
  };

  // zx_20260924 M6-a（毛选·实事求是）: **回验 ANS 给的模型到底带不带本任务要的能力**。
  //   ⚠ 比对点必须在**换路之前**（下方 sdk_fallback 会把它换成另一家 provider 的模型）——
  //     换完之后回包里的 `capabilities` 已不是**实际在用**的那个模型，那时再比就是拿旧模型的答案评新模型。
  //   ⚠ 回包不带 `capabilities` ⇒ `compareModelCapabilities` 返回 `null`（**无从比对，不编"不符"**）。
  //   ⚠ 不符 ⇒ **告警而不阻断**：仍用这个模型跑（"重选"是另一件事，须另立裁定），但账上要留痕。
  if (modelResult.id) {
    const cmp = compareModelCapabilities(modelCaps, modelResult);
    if (cmp && cmp.missing.length > 0) {
      // zx_20261002 M14: 同一句"缺能力"的**成因**分开说。ANS 两段式选型在全中池为空时会**主动**
      //   带 `capabilityMatch:'partial'` 告知"这是环境所迫的降级"；没有这个信号才是寻常的「不符」。
      //   ⚠ 旧 ANS 不带本键 ⇒ `undefined` ⇒ 落到「不符」（与改动前逐字一致）。
      //   缺**哪几项**仍由 `compareModelCapabilities` 现算（不另立第二份缺口账）。
      const degraded = modelResult.capabilityMatch === 'partial';
      const line = `${degraded ? '[降级选型]' : '[能力不符]'} 本任务需 [${modelCaps.join(',')}]，实得 [${cmp.got.join(',')}]（缺 ${cmp.missing.join(',')}）`
        + (degraded ? '；ANS 无全中模型，已按部分命中降级' : '');
      try {
        db.prepare(
          "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
        ).run(crypto.randomUUID(), taskId, line);
      } catch { /* 记不上不阻断执行 */ }
      logger.warn({ taskId: taskId.slice(0, 8), model: modelResult.model_name, demand: modelCaps, got: cmp.got, missing: cmp.missing }, line);
    }
  }

  // A3 (2026-08-31): 账户级故障已记录备用 provider（跨 provider 切换）→ 本次直接使用备用，不再用同一故障账户
  const sdkFallbackCfg = sdkRetryCtx.sdk_fallback as EndpointHop | undefined;
  if (sdkFallbackCfg?.url && sdkFallbackCfg.model_name) {
    // zx_20260929 M6-1c①（**降级路**，用户裁定 2026-09-29「分路处理」）：**换完再回验**。
    //   此前能力回验只在换路**之前**对 ANS 首选做过一次（上方那段），而这条支路会把模型换成
    //   另一家 provider 的端点且**从不回验** ⇒ 账上那句"已回验"与实际在用的模型**可能不是同一个**
    //   （本轮病根：在册≠在路）。
    //   · 备用清单**键缺席**（旧 ANS / 旧账写的 `sdk_fallback`）⇒ `compareModelCapabilities` 返回 `null`
    //     = 无从比对，**不编"不符"**，行为与改动前逐字一致（存量任务的旧账不会因本批突然失败）。
    //   · 判"不符" ⇒ **如实抛出**：这支本就在"账户级故障"的降级路上，备用也不合格=没有可用模型，
    //     与下方"零命中即抛"同一把尺（不静默降级成不满足要求的模型）。
    const fbCmp = compareModelCapabilities(modelCaps, sdkFallbackCfg);
    if (fbCmp && fbCmp.missing.length > 0) {
      const why = `备用 provider 模型 ${sdkFallbackCfg.model_name} 缺本任务所需能力 [${fbCmp.missing.join(', ')}]`
        + `（需 [${modelCaps.join(', ')}]，其能力清单为 [${fbCmp.got.join(', ')}]）`;
      try {
        db.prepare(
          "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
        ).run(crypto.randomUUID(), taskId, `[选型失败] ${why}`);
      } catch { /* 记不上不阻断抛出 */ }
      logger.warn({ taskId: taskId.slice(0, 8), model: sdkFallbackCfg.model_name, demand: modelCaps, got: fbCmp.got, missing: fbCmp.missing }, why);
      throw new Error(why);
    }
    // zx_20260930 M10: 换路写法**收进 `applySwap` 一处**（此前这里自己写四行）。
    //   `'drop'` = **不沿用旧钥匙**：这一跳是**另一家** provider，旧钥匙属于那个触发账户级故障的
    //   坏账户（zx_20260929 §4-17）。`capabilities` 随跳走，由 `applySwap` 一并处理（M6-1c）。
    applySwap(sdkFallbackCfg, 'drop');
    logger.warn({ taskId: taskId.slice(0, 8), provider: sdkFallbackCfg.url, model: sdkFallbackCfg.model_name }, '账户级故障→切换到备用 provider');
    db.prepare(
      "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
    ).run(crypto.randomUUID(), taskId, `[降级通知] 检测到 AI 供应商账户级故障，已自动切换到备用 provider: ${sdkFallbackCfg.model_name}`);
  }

  // zx_20260920_1 M4（五-13「要了没人给」）: 如实说出**要的是什么能力**。
  //   原文案 `No AI model available` 说不清是"池子空了"还是"这个形态要的能力没人具备"——
  //   后者正是本轮把能力派生出去之后**新可能**出现的情形（如某形态要 `code`，
  //   而 `code` 能力被配额/余额挡到只剩不具备它的模型）。
  //   **不静默去掉刚加的能力再要一次**——那正是"降级成不满足要求"，本轮明令禁止。
  if (!modelResult.id && !sdkFallbackCfg?.url) {
    // zx_20260924 M6-e②（管子·度量衡）: ANS 的 `explainMatchFailure` 早就算好了"卡在第几道闸"
    //   （`error.diagnostics.summary`），而这里此前**直接丢弃**——用户永远只看到"没有模型"，
    //   看不到是被能力闸、成本闸还是资源组闸挡住的。现把它接进**同一条如实出口**（会话行 + 日志）。
    //   ⚠ 取法归一处（ans-client 的 `matchFailureSummary`）；取不到就**如实少说**，不替 ANS 编一句。
    const ansDiag = matchFailureSummary(modelResult);
    const why = `无模型满足本任务所需能力 [${modelCaps.join(', ')}]（形态：${archetype}${maxCostPer1k !== undefined ? ` · 成本上限 ${maxCostPer1k}/1k` : ''}）`
      + (ansDiag ? `；ANS 诊断：${ansDiag}` : '');
    try {
      db.prepare(
        "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
      ).run(crypto.randomUUID(), taskId, `[选型失败] ${why}`);
    } catch { /* 记不上不阻断抛出 */ }
    logger.warn({ taskId: taskId.slice(0, 8), capabilities: modelCaps, archetype, maxCostPer1k }, why);
    throw new Error(why);
  }

  // 8.4: 三级降级链 — 首选→同provider备用→跨provider备用（含健康检查）
  const mr = modelResult as Record<string, unknown>;
  const tier2 = mr.sameProviderFallback as EndpointHop | undefined;
  // zx_20260929 M6-1c ★就地订正: 原代码在此处**还**认第四跳 `mr.fallback`，并给它单开一支
  //   （"tier2 缺席、tier3 缺席、只有 fallback"）。那一支**不可达**——ANS 侧
  //   `optimal-model.ts` 写的是 `fallback: decryptEndpoint(result.crossProviderFallback)`，
  //   即 `fallback` 与 `crossProviderFallback` 是**同一次调用的同一个值**：`mr.fallback?.url`
  //   与 `tier3?.url` 恒同真同假（"在册≠在路"：那一支写着、永远走不到，却让读的人以为有第四层降级）。
  //   此处按事实并成三跳；`fallback` 字段仍是 ANS 回包的**兼容别名**，桌面侧不再单独认它。
  const tier3 = mr.crossProviderFallback as EndpointHop | undefined;
  const checkHealth = async (url: string, apiKeyStr: string) => {
    try {
      const r = await fetch(url.replace(/\/$/, '') + '/models', {
        headers: { Authorization: `Bearer ${apiKeyStr}` },
        signal: AbortSignal.timeout(5_000),
      });
      return r.ok;
    } catch { return false; }
  };
  let swapped = false;
  /** 探活没过又**无处可换**时的真因（M6-2）；空串=没这回事。 */
  let noSwapReason = '';
  if (!(await checkHealth((mr.url as string) || '', (mr.api_key as string) || ''))) {
    const tier2Ok = tier2?.url ? await checkHealth(tier2.url, tier2.api_key || '') : false;
    if (tier2Ok) {
      applySwap(tier2!, 'reuse');
      swapped = true;
      logger.warn({ taskId: taskId.slice(0, 8), tier: 2 }, '主模型不可用→同provider备用');
    } else if (tier3?.url) {
      applySwap(tier3, 'reuse');
      swapped = true;
      logger.warn({ taskId: taskId.slice(0, 8), tier: 3 }, tier2?.url ? '同provider备用不可用→跨provider备用' : '主模型不可用→跨provider备用');
    } else {
      // zx_20260929 M6-2（实事求是）: **探活没过、且一处备用都没有**——此前这里 `degraded` 保持 `false`，
      //   于是通知一句不发、日志一句不打，**静默**拿一个"探活没过"的端点继续跑，与上面"没有模型即
      //   如实抛出 + 说清成因"的处置**不是一把尺**。
      //   把话说准：探活打的是 `<url>/models`，**探活未通过 ≠ 端点已死**（不少网关不实现该路径），
      //   故文案说"探活未通过"，不说"模型不可用"——不替它把话说大。
      noSwapReason = '主模型探活未通过，且无可用备用';
      logger.warn({ taskId: taskId.slice(0, 8), url: mr.url }, noSwapReason + '（仍按原端点继续）');
    }
  }
  // 能力门槛：主模型context<64K时自动升级到更大窗口的备用模型
  const ctxWindow = (mr.context_window as number) || 0;
  if (ctxWindow > 0 && ctxWindow < 64_000) {
    // ⚠ `tier3 || mr.fallback` 里的 `mr.fallback` 是**恒等于 tier3** 的兼容别名（见上方就地订正），
    //   保留它只为"万一哪天别名真分了家"，不额外成一支。
    const upgradeTarget = (tier3 || (mr.fallback as EndpointHop | undefined)) as EndpointHop | undefined;
    const upCtx = (upgradeTarget?.context_window as number) || 0;
    if (upgradeTarget?.url && upCtx > ctxWindow) {
      // zx_20260929 M6-1c③（**纯优化支**，用户裁定 2026-09-29「分路处理」）：换之前先回验能力；
      //   不合格就**不升、不抛**——主模型此刻已通过回验、可用，这条升级只是"窗口更大更好"，
      //   没有理由把一次可选优化升级成整轮失败（与 `sdk_fallback` 支的"如实抛出"不同，那支在降级路上）。
      //   "换之前验"与"换之后验"结论相同（不合格就不换），但省掉一次无谓探活。
      const upCmp = compareModelCapabilities(modelCaps, upgradeTarget);
      if (upCmp && upCmp.missing.length > 0) {
        const line = `[升级放弃] 备用模型 ${upgradeTarget.model_name} 缺本任务所需能力 [${upCmp.missing.join(', ')}]，`
          + `保留窗口较小的 ${modelResult.model_name}（需 [${modelCaps.join(', ')}]，其能力清单为 [${upCmp.got.join(', ')}]）`;
        try {
          db.prepare(
            "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
          ).run(crypto.randomUUID(), taskId, line);
        } catch { /* 记不上不阻断 */ }
        logger.warn({ taskId: taskId.slice(0, 8), ctxWindow, upCtx, model: upgradeTarget.model_name, missing: upCmp.missing }, line);
      } else if (await checkHealth(upgradeTarget.url, upgradeTarget.api_key || '')) {
        applySwap(upgradeTarget, 'reuse');
        logger.warn({ taskId: taskId.slice(0, 8), ctxWindow, upCtx }, '主模型context窗口过小→自动升级');
      }
    }
  }
  // zx_20260929 M6-2: 降级通知**带真因**。两种情形不是一回事，文案分开说：
  //   ① 真换了端点 —— 「主模型不可用，已切换至 X」；
  //   ② 探活没过又无处可换 —— 仍在**原**端点跑，故不许说"已切换"，也不许把"探活没通过"说成"模型不可用"。
  if (swapped || noSwapReason) {
    const line = swapped
      ? `[降级通知] 主模型不可用，已切换至 ${modelResult.model_name}`
      : `[降级通知] ${noSwapReason}（探活打的是 ${String(mr.url || '')}/models，未通过不等同于端点已死），仍按 ${modelResult.model_name} 继续`;
    db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
      .run(crypto.randomUUID(), taskId, line);
  }

  // zx_20260930 M10（维特根斯坦·意义即使用）: **图片能力闸用"实际在用的那个模型"判**。
  //   读点刻意在**所有换路之后**：`applySwap` 起 `capabilities` 就随跳走（见其注释），
  //   故这里读到的就是最终模型的自陈清单——而"要不要把图送出去"问的正是**它**，不是 ANS 首选。
  //   （上方 M6-a 那段"换路之前比对"讲的是"ANS 首选符不符"，是另一件事，两者都要在。）
  //   清单里缺 `vision` ⇒ 调用方把它传给 `buildAttachmentParts`，图片族逐件记
  //   `omitted(model_lacks_vision)` 并如实告知——否则就是"非视觉模型收到 `image_url`"：
  //   要么 400 整轮白跑，要么白烧 token 还什么都没看见（§1.5 行 4）。
  //   ⚠ 判闸的**位置**在装配层、判据在**清单本身**：这里只负责把清单原样回传。
  //     清单**缺席**（`compareModelCapabilities` 返回 `null`）是"无从比对"、不是"不具备"——
  //     替它断言一句我们并不知道的话，与"不编『不符』"是同一条尺的反面。
  const finalCaps = compareModelCapabilities(modelCaps, modelResult);

  // zx_20261012_3 批三（「明处」· 选得明）: **选型留痕一处**——所有换路走完之后落**一条** system 会话行。
  //   起因：某项目那轮任务用的是 `qwen3.5:9b`（本地端点），而用户问「为什么不用 DeepSeek」时
  //   账上**没有任何一处**说得出这次选型的四要素（策略来源/策略/端点归属/能力匹配），只能靠事后反推。
  //   本行把四格一次说全，用户可直接在任务详情页读到。
  //
  //   ⚠ 写点在这里而**不是**更早：本段上方每一跳（sdk_fallback / tier2 / tier3 / context 升级）都可能
  //     把 `modelResult` 换成**另一个**模型，那时落账会记下一个**最终没在用**的模型（"在册≠在路"）。
  //     `finalCaps` 之后、策略闸之前 = 选型**已定稿**而任务尚未被闸拦下，正是"选型收尾"这一刻。
  //   ⚠ 全文只此一处写 `[选型]` 前缀——多了就是第二本账，两边迟早分家（rr 有反证断言钉死"恰一条"）。
  const selectLine = `[选型] 策略来源=${strategySource || '未知'} · 策略=${modelStrategy}`
    + ` · 模型=${String(modelResult.model_name ?? '未知')} · 端点=${endpointScope(String(mr.url || ''))}`
    + ` · 能力匹配=${capabilityMatchLabel(modelResult, finalCaps)}`;
  try {
    db.prepare(
      "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
    ).run(crypto.randomUUID(), taskId, selectLine);
  } catch { /* 记不上不阻断执行 */ }

  // zx_20261013_1 批一（称器于事 · 毛选「主要矛盾」）: **硬需能力缺 ⇒ 如实拒，不静默跑**。
  //   分档真源见 `CAPABILITY_DEMAND`（`vision`/`chat`/`function-calling` 为硬需；`code`/`reasoning` 为软需）。
  //   本闸判的是**最终在用**的模型（`modelResult`，已含 sdk_fallback / 上下文升级的换路）：它缺硬需能力，
  //   任务就成了"开了工却残废"——要 `vision` 却看不见图、要工具却调不动。旧行为是让装配层逐件 omit 图片
  //   **掩盖**过去（任务照判"成功"），正本轮要治的"名实不符"。
  //   ⚠ 唯一豁免是 `swapped` 为真（走了 `tier2`/`tier3`）：那两支是"主模型探活没过"时的**可用性**降级，
  //     2026-10-02 已裁定「可用性备用不回验」——在那里拦会把一个**能开工但降级**的任务判死
  //     （见 `applySwap` 上方那段裁定注释）。
  //   ⚠ 判据**不**依赖探活结果（`noSwapReason`）：探活打的是 `<url>/models`，不少网关根本不实现该路径、
  //     "探活未过 ≠ 端点已死"——若把"探活通过"设为开火前提，本闸在生产里将**几乎永不触发**（正是 P5 要防的
  //     "断言在册、生产不在路"）。能力是否够，看的是 ANS 回包自陈的 `capabilities`，与探活是**两条轴**。
  //   ⚠ 缺软需能力**不在此拦**：上方那段已如实记一行 `[能力不符]`/`[降级选型]`（GUI 可见），续跑即可。
  //   ⚠ `engine.model_capability_gate` 关（`readBoolSetting`）⇒ 逐字回本批前的"只记不拦"旧行为（一键回退）。
  const capGate = assessCapabilityGate(modelCaps, modelResult);
  if (capGate.hardMissing.length > 0 && !swapped && readBoolSetting(db, 'engine.model_capability_gate')) {
    // 措辞归 `capabilityGateMessage`（零依赖纯函数，rr 逐字钉）——此处只管**落账 + 抛**。
    const why = capabilityGateMessage({
      demand: modelCaps, got: capGate.got, hardMissing: capGate.hardMissing, modelName: modelResult.model_name,
    });
    try {
      db.prepare(
        "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
      ).run(crypto.randomUUID(), taskId, `[选型失败] ${why}`);
    } catch { /* 记不上不阻断抛出 */ }
    logger.warn({ taskId: taskId.slice(0, 8), model: modelResult.model_name, demand: modelCaps, got: capGate.got, hardMissing: capGate.hardMissing }, why);
    throw new Error(why);
  }

  // 10.1: 策略引擎检查（执行前评估成本/错误率策略）
  // zx_20261012_2 批一（「名各有主」）三处订正：
  //   ① 口径归位——失败数改由 `countRecentFailures` **按条件给的窗口**取（旧码 `COUNT(*)…LIMIT 10`
  //      里 `LIMIT` 空转，数的是**全时段**失败数，致新任务开跑 1 秒即被误熔断，§1.1）；
  //   ② 可配——策略由 `loadPolicies(db)` 现读库（缺省回落内置），阈值/窗口用户可在设置页调；
  //   ③ 开关——`engine.policy_check` 关 ⇒ **连取数都不取**，逐字回"无策略检查"旧行为（一键回退）。
  if (readBoolSetting(db, 'engine.policy_check')) {
    try {
      const policyResult = evaluatePolicies(
        { taskTokens: 0, taskCost: 0, projectRecentFailures: (w) => countRecentFailures(db, projectId, w) },
        loadPolicies(db),
      );
      if (policyResult.triggered) {
        for (const action of policyResult.actions) {
          if (action.type === 'pause_task') {
            db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
              .run(crypto.randomUUID(), taskId, `[策略] ${action.message || '策略触发，任务暂停'}`);
            pauseTask(db, { taskId, reason: PAUSE_REASON_POLICY_PAUSED });
            return { stopped: { content: `任务被策略暂停: ${action.message}` } };
          }
          if (action.type === 'notify_admin') {
            // 批五 M5: 「通知管理员」此前**只写一条会话行**——会话行不是通知（名实不符，维特根斯坦：
            //   说成它真做的样子）。现**同时**经 `pushImNotify` 真发出（`kind='admin_notify'`），
            //   会话行保留（它是任务详情页上那句"发生了什么"的在场证据）。
            const adminLine = `[策略通知] ${action.message}`;
            db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
              .run(crypto.randomUUID(), taskId, adminLine);
            void pushImNotify(db, taskId, adminLine, 'admin_notify');
          }
        }
      }
    } catch { /* policy check best-effort */ }
  }
  return { modelResult, hasMedia, sdkRetryCtx, modelCapabilities: finalCaps?.got ?? null };
}
