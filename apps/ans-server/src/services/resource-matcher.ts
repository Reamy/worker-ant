import type Database from 'better-sqlite3';
import { MODEL_CAPABILITY_META, type ModelCapability } from '@worker-ant/shared-types';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('matcher');

export type MatchStrategy = 'cost-optimal' | 'latency-optimal' | 'capability-best' | 'balanced';

/** zx_20261002 M14: 主模型对请求能力集的满足度。`'partial'` = 全中池为空时的**降级选型**。 */
export type CapabilityMatchLevel = 'full' | 'partial';

interface MatchRequest {
  strategy?: MatchStrategy;
  capabilities?: string[];
  maxCostPer1k?: number;
  preferredProvider?: string;
  excludeCapabilities?: string[];
}

/**
 * 缺省请求能力。**一处真源**：匹配器与回包的"缺口账"必须是同一份缺省，
 * 否则不带 `capabilities` 的调用方会拿到一份按别的请求集算出来的账。
 */
export const DEFAULT_MATCH_CAPABILITIES = ['chat'] as const;

/**
 * 把可选的请求能力收敛成**非 undefined** 的一组。
 * ⚠ 语义按**原样保留**：`undefined` ⇒ 缺省 `['chat']`；显式传 `[]` ⇒ 空集（= 不按能力约束，
 *   与改动前 `req.capabilities ?? ['chat']` 逐字一致，不把 `[]` 悄悄变成 `['chat']`）。
 */
export function resolveRequestedCapabilities(capabilities?: string[]): string[] {
  return capabilities ?? [...DEFAULT_MATCH_CAPABILITIES];
}

/** 去重（保持首次出现序）——重复项会虚增"应命中数"，让全中池永远为空。 */
function uniqueCaps(caps: string[]): string[] {
  return [...new Set(caps)];
}

/** 该模型行命中几项请求能力（0..requested.length）。 */
function capabilityHitCount(raw: unknown, requested: string[]): number {
  if (requested.length === 0) return 0;
  const have = new Set(parseModelCapabilities(raw));
  let n = 0;
  for (const c of requested) if (have.has(c)) n++;
  return n;
}

/**
 * **能力缺口账**：请求了但该模型不具备的能力（按请求顺序去重）。
 * `missing` 为空 ⇔ `'full'`。
 */
function capabilityShortfall(raw: unknown, requested: string[]): { level: CapabilityMatchLevel; missing: string[] } {
  const have = new Set(parseModelCapabilities(raw));
  const missing = uniqueCaps(requested).filter((c) => !have.has(c));
  return { level: missing.length === 0 ? 'full' : 'partial', missing };
}

/**
 * zx_20261002 M14: 请求能力集对应的**最小上下文门槛**——取各能力 `minContext` 的**最大值**。
 *
 * 真源是 `MODEL_CAPABILITY_META`。此前这里只对 `function-calling`/`structured_output`
 * **硬编码** `32000`，而表里视觉得 `8000`、推理得 `32000` 等声明**从不参与选型**——
 * 表里写了、代码不读（§1.5 行 3）。现在归一处读表。
 * 未在册的能力（脏值/自定义）**不贡献门槛**（同 `parseModelCapabilities` 的"认不出不猜"立场）。
 */
function capabilityContextFloor(capabilities: string[]): number {
  let floor = 0;
  for (const c of uniqueCaps(capabilities)) {
    const meta = MODEL_CAPABILITY_META[c as ModelCapability];
    if (meta && meta.minContext > floor) floor = meta.minContext;
  }
  return floor;
}

export interface EndpointRow {
  id: string;
  model_id: string;
  url: string;
  api_key_ref: string;
  model_name: string;
  max_output_tokens: number;
  context_window: number;
  priority: number;
  weight: number;
  /** C4: 端点最近一次连通性检测延迟(ms)，0/缺失=未检测 */
  last_latency_ms: number;
  /** A3: 模型实际定价(美元/1000 tokens) */
  input_price_per_1k: number;
  output_price_per_1k: number;
  /**
   * zx_20260924 M6-a: 模型的**在册能力**（`ans_ai_models.capabilities` 的 JSON 原文）。
   * 此前本查询只把能力用于 `json_each` 过滤、**从不把它带出来**——于是调用方拿到的回包
   * 没有任何字段能回答"这模型到底具不具备我要的能力"，只能选择相信或不信。
   * 解析**必须**走 `parseModelCapabilities`（不在这里就地 `JSON.parse`）：同一形状的解析归一处。
   */
  capabilities: string;
}

/**
 * zx_20260924 M6-a: 把模型行的 `capabilities` 原文解析成能力串数组。
 *
 * **认不出就当空数组**——非字符串、JSON 解不开、解出来不是数组、数组里非字符串项一律丢弃。
 * 不猜、不抛：本函数的产物是**回包里的一个如实字段**，宁可"说不出具备什么"，
 * 也不许因为一行脏数据把整条选型路炸掉（同 `parseDecomposition` 的既有立场）。
 */
export function parseModelCapabilities(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((c): c is string => typeof c === 'string');
}

/**
 * zx_20260921_1 M2: 零命中时的**逐层漏斗**诊断——"没选出来"的成因分开说，而不是四合一。
 *
 * 为什么是漏斗而不是一份固定清单：方案原文列了 5 个成因，但**同等成因不止 5 条**
 * （`excludeCapabilities` / `maxCostPer1k` / `resourceGroups` / `context≥32000` 门槛都会把端点筛没）。
 * 写成"每步筛完还剩几个"，则元凶 = **第一个把剩数打到 0 的那一步**——不重不漏，
 * 且日后新增筛条件时漏斗**自动**跟着长，不必回来补一张清单。
 */
export interface MatchFailureDiagnostics {
  /**
   * 端点级漏斗：每步"按此条筛完还剩几个端点行"。首项是未筛前的基数。
   *
   * ⚠ zx_20260929 M6-4 **读者在册**（此前方案说这两个数组"**无生产读者**"，**与事实不符**，
   *   就地订正）：本数组**有两个进程内生产读者**——本文件里那句
   *   `diagnostics.endpointFunnel.find(s => s.step === EP_FUNNEL_PROVIDER_ENABLED)`
   *   （`logger.warn` 失败日志里的"活跃端点总数"），
   *   与 `summarizeFailure(endpointFunnel, modelFunnel)`（结论句就是由它俩算出来的）。
   *   准确的说法是：**跨进程**无读者 —— 桌面侧（`core/model-request.ts` 的 `matchFailureSummary`）
   *   只取 `summary` 这个字符串，**不解析**两个数组。故：改字段名/步名会**同时**影响日志与结论句；
   *   但**给别的进程加读者**是安全的纯追加。
   */
  endpointFunnel: Array<{ step: string; remaining: number }>;
  /** 模型级漏斗：每步"按此条筛完还剩几个模型"（端点漏斗看不到"在册但没端点"的模型）。读者同上。 */
  modelFunnel: Array<{ step: string; remaining: number }>;
  /** 结论（人话）：指出第一个把剩数打到 0 的是哪一步。**唯一跨进程被读的一项。** */
  summary: string;
}

interface MatchResult {
  primary: EndpointRow | null;
  /** 同provider备用（8.4: 三级降级链 Tier 2） */
  sameProviderFallback: EndpointRow | null;
  /** 跨provider备用（8.4: 三级降级链 Tier 3） */
  crossProviderFallback: EndpointRow | null;
  /** @deprecated 保留兼容，等同 crossProviderFallback */
  fallback: EndpointRow | null;
  /**
   * zx_20261002 M14: 主模型对请求能力集的满足度——`'full'` 全部请求能力都命中；
   * `'partial'` **部分命中**（全中池为空时的降级选型）。**仅在成功路在场**（同 `diagnostics`：
   * 失败路没有"主模型"可说）。
   *
   * 这是**选型决策本身**的事实，调用方**无法**从回包的 `capabilities` 反推——
   * 反推只能得出"这个模型缺什么"，得不出"当时到底有没有全中模型可选"。
   * 缺的那一项不是调用方的失误时，就得让"降级"与"选型失误"在账上分得开。
   */
  capabilityMatch?: CapabilityMatchLevel;
  /** zx_20260921_1 M2: **仅在零命中时**填充（成功路不付这份只读聚合的钱）。纯追加字段。 */
  diagnostics?: MatchFailureDiagnostics;
}

/** P2修③: 判断端点是否为本地(localhost)——本地Ollama不稳定，不宜作为云故障备用 */
function isLocalEndpoint(url: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url || '');
}

/**
 * 资源最优匹配引擎。
 * 根据需求策略从数据库中选择最优模型端点，同时提供备用端点。
 *
 * zx_20261002 M14（孙子·知彼知己）: 能力由**硬过滤**改为**两段式排序降级**。
 *   此前 `WHERE EXISTS(json_each …) AND …` 要求模型**同时具备全部**请求能力，能力略差但可用的
 *   模型**直接消失**，缺一项即整条零命中。现在：
 *     · 全中池非空 ⇒ **只**在全中池里排（正常路）；
 *     · 全中池为空、但至少一项命中 ⇒ 退用部分命中池，并以 `capabilityMatch:'partial'` + 日志
 *       **如实标明这是降级**（不静默——"账上必须分清命中的与降级的"）；
 *     · 连**一项**都不命中 ⇒ 仍走原零命中路（`explainMatchFailure` + 如实抛出）。
 *   `MODEL_CAPABILITY_META[cap].minContext` 同时**真**参与门槛（此前只对 function-calling/
 *   structured_output 硬编码 32000，表中 vision 8000 / reasoning 32000 等声明从不被读）。
 */
export function matchOptimalModel(db: Database.Database, req: MatchRequest, resourceGroups?: string[]): MatchResult {
  const strategy = req.strategy ?? 'balanced';
  const capabilities = resolveRequestedCapabilities(req.capabilities);
  const requested = uniqueCaps(capabilities);
  const contextFloor = capabilityContextFloor(capabilities);

  // 1. 获取所有活跃端点（含关联的模型信息）
  //    ⚠ 能力**不在**此查询里硬过滤（M14）：改为下面的两段式池划分。
  let query = `
    SELECT e.id, e.model_id, e.url, e.api_key_ref, m.name as model_name, m.max_output_tokens, m.context_window, e.priority, e.weight, e.last_latency_ms,
           COALESCE(m.input_price_per_1k, 0.005) as input_price_per_1k,
           COALESCE(m.output_price_per_1k, 0.015) as output_price_per_1k,
           COALESCE(m.capabilities, '[]') as capabilities
    FROM ans_model_endpoints e
    JOIN ans_ai_models m ON e.model_id = m.id
    JOIN ans_ai_providers p ON m.provider_id = p.id
    WHERE e.status = 'active' AND m.status = 'active' AND m.enabled = 1 AND p.enabled = 1
  `;
  const params: unknown[] = [];

  // 2.1 排除能力过滤：排除具备这些能力的模型（如排除 reasoning，避免 thinking 耗尽小 maxTokens 导致空输出）
  if (req.excludeCapabilities && req.excludeCapabilities.length > 0) {
    const excludeChecks = req.excludeCapabilities.map(
      () => `NOT EXISTS (SELECT 1 FROM json_each(m.capabilities) WHERE json_each.value = ?)`,
    );
    query += ` AND (${excludeChecks.join(' AND ')})`;
    req.excludeCapabilities.forEach((cap) => params.push(cap));
  }

  // 2.2 能力门槛：请求能力集各自的 minContext 取**最大者**（真读 `MODEL_CAPABILITY_META`）。
  //   function-calling/structured_output 的 minContext 本就是 32000 ⇒ 既有行为在此保持；
  //   vision 8000 / reasoning 32000 等此前"声明了不读"的门槛从此真参与。
  //   太小的本地模型声称支持某能力但实际不稳定，故这是**硬门槛**（不在两段式降级之列）。
  if (contextFloor > 0) {
    query += ' AND COALESCE(m.context_window, 0) >= ?';
    params.push(contextFloor);
  }

  // 3. 成本过滤
  if (req.maxCostPer1k !== undefined) {
    query += ' AND (m.input_price_per_1k + m.output_price_per_1k) <= ?';
    params.push(req.maxCostPer1k);
  }

  // 4. 8.1 资源组过滤：如果API Key绑定了资源组，只返回匹配的资源
  if (resourceGroups && resourceGroups.length > 0) {
    const groupConditions = resourceGroups.map(
      () => "(m.resource_group = ? OR m.resource_group = '' OR m.resource_group IS NULL)",
    );
    query += ` AND (${groupConditions.join(' OR ')})`;
    resourceGroups.forEach((g) => params.push(g));
  }

  // 5. 供应商偏好
  if (req.preferredProvider) {
    query += ' AND m.provider_id = ?';
    params.push(req.preferredProvider);
  }

  query += ' ORDER BY e.priority DESC';

  const rows = db.prepare(query).all(...params) as EndpointRow[];

  // 6. 两段式：全中优先，全中池空则退部分命中（并标降级）。命中数按**端点**预算一次，避免重复解析。
  const hits = new Map<string, number>();
  for (const e of rows) hits.set(e.id, capabilityHitCount(e.capabilities, requested));
  const hitOf = (e: EndpointRow): number => hits.get(e.id) ?? 0;
  const fullPool = rows.filter((e) => hitOf(e) === requested.length);
  const partialPool = rows.filter((e) => hitOf(e) > 0);
  const useFull = fullPool.length > 0;
  const endpoints = useFull ? fullPool : partialPool;
  const capabilityMatch: CapabilityMatchLevel = useFull ? 'full' : 'partial';

  if (endpoints.length === 0) {
    const diagnostics = explainMatchFailure(db, req, resourceGroups);
    const totalActive = diagnostics.endpointFunnel.find((s) => s.step === EP_FUNNEL_PROVIDER_ENABLED)?.remaining ?? 0;
    logger.warn(
      { req, totalActive, capabilities, matchFailed: true, summary: diagnostics.summary },
      `无模型满足能力要求[${capabilities.join(', ')}]，活跃端点总数: ${totalActive}。${diagnostics.summary}`,
    );
    return { primary: null, sameProviderFallback: null, crossProviderFallback: null, fallback: null, diagnostics };
  }

  // 5. 根据策略排序（P0.5: 加入实践验证质量权重）
  const sorted = sortByStrategy(endpoints, strategy, db, undefined, hitOf);

  const primary = sorted[0] ?? null;

  // M14: 降级**不静默**——全中池为空、退用部分命中的那一次，把"缺了什么"记进日志。
  if (capabilityMatch === 'partial' && primary) {
    const { missing } = capabilityShortfall(primary.capabilities, requested);
    logger.warn(
      { req, capabilities, candidates: endpoints.length, chosen: primary.id, missing },
      `无模型同时具备全部请求能力[${capabilities.join(', ')}] ⇒ 降级为部分命中选型（缺 ${missing.join(', ')}）`,
    );
  }

  // 8.4: 三级降级链
  // Tier 1: primary (已完成)
  // Tier 2: 同provider备用（相同provider的其他端点）
  // Tier 3: 跨provider备用（不同provider的端点）
  let sameProviderFallback: EndpointRow | null = null;
  let crossProviderFallback: EndpointRow | null = null;

  if (sorted.length > 1 && primary) {
    const primaryModel = db.prepare('SELECT provider_id FROM ans_ai_models WHERE id = ?').get(primary.model_id) as
      | { provider_id: string }
      | undefined;
    const primaryProvider = primaryModel?.provider_id;

    // Tier 2: 同provider备用
    sameProviderFallback =
      sorted.find((e) => {
        if (e.id === primary.id) return false;
        const model = db.prepare('SELECT provider_id FROM ans_ai_models WHERE id = ?').get(e.model_id) as
          | { provider_id: string }
          | undefined;
        return model?.provider_id === primaryProvider;
      }) ?? null;

    // Tier 3: 跨provider备用
    // P2修③ (2026-09-01): 云端优先——本地Ollama(如qwen3.8:27b-mlx)GPU OOM不适合作云故障备用。
    // 全部跨provider候选中，优先云端端点(按priority降序)；无云端候选时才回退本地端点。
    const crossCandidates = sorted.filter((e) => {
      if (e.id === primary.id || e.id === sameProviderFallback?.id) return false;
      const model = db.prepare('SELECT provider_id FROM ans_ai_models WHERE id = ?').get(e.model_id) as
        | { provider_id: string }
        | undefined;
      return model?.provider_id !== primaryProvider;
    });
    if (crossCandidates.length > 0) {
      const cloudCandidates = crossCandidates.filter((e) => !isLocalEndpoint(e.url));
      const crossPool = cloudCandidates.length > 0 ? cloudCandidates : crossCandidates;
      crossProviderFallback = [...crossPool].sort((a, b) => b.priority - a.priority)[0] ?? null;
    }

    // 如果没有跨provider的，用第二个非primary的
    if (!crossProviderFallback && sorted.length > 1) {
      crossProviderFallback = sorted.find((e) => e.id !== primary.id && e.id !== sameProviderFallback?.id) ?? null;
    }
  }

  logger.info(
    {
      primary: primary?.id,
      sameProvider: sameProviderFallback?.id,
      crossProvider: crossProviderFallback?.id,
      strategy,
      count: endpoints.length,
      capabilityMatch,
    },
    '三级资源匹配完成',
  );
  return { primary, sameProviderFallback, crossProviderFallback, fallback: crossProviderFallback, capabilityMatch };
}

/** 端点漏斗里"四重门槛全过"那一步的步名。零命中日志与桌面文案都按符号取它，不手抄字面量。 */
export const EP_FUNNEL_PROVIDER_ENABLED = '供应商启用';

/**
 * zx_20261002 M14: 端点漏斗里"**至少一项**请求能力命中"那一步的步名。
 *
 * 两段式选型下能力不再是**逐项**硬 AND（那会把只缺一项的模型整个筛没），
 * 而是"整池一项都不中才算零命中"这条底线——故漏斗里能力**只留这一步**，
 * 且它排在**最后**：主查询的非能力闸门先行，能力池划分是最后一道筛，
 * 于是"漏斗末步的剩数 == 主查询的有效候选数"，归零即真零命中。
 */
export const EP_FUNNEL_ANY_CAPABILITY = '至少命中一项请求能力';

/**
 * zx_20260921_1 M2: 零命中成因的**只读聚合**——不新增表、不新增写入、不改任何行。
 *
 * ⚠ 本函数**由 `matchOptimalModel` 自己在零命中分支调用**（而不是让路由各写一段 SQL）：
 *   `/api/v1/models/optimal` 在 ANS 里有**两份实现**（`index.ts` 与 `routes/models.ts`），
 *   诊断落在 matcher 里，两份回包才天然同形；落在路由里则要写两遍——正是本轮要治的"两处各写一份"。
 *
 * 逐层漏斗的关键性质：**每一步只加一个条件**，故相邻两步之差**只可能由这一条**造成。
 * 若一步同时加两个条件，"缺 `audio` 标"与"供应商未启用"就会混成同一个数、说不清是谁干的。
 */
export function explainMatchFailure(
  db: Database.Database,
  req: MatchRequest,
  resourceGroups?: string[],
): MatchFailureDiagnostics {
  const capabilities = uniqueCaps(resolveRequestedCapabilities(req.capabilities));
  const contextFloor = capabilityContextFloor(capabilities);

  // ── 端点级漏斗：计的是**端点行**，逐条收窄 ──
  const epWhere: string[] = [];
  const epParams: unknown[] = [];
  const epCount = () =>
    (
      db
        .prepare(
          `
    SELECT COUNT(*) as c FROM ans_model_endpoints e
    JOIN ans_ai_models m ON e.model_id = m.id
    JOIN ans_ai_providers p ON m.provider_id = p.id
    ${epWhere.length ? `WHERE ${epWhere.join(' AND ')}` : ''}
  `,
        )
        .get(...epParams) as { c: number }
    ).c;
  const endpointFunnel: Array<{ step: string; remaining: number }> = [{ step: '总端点', remaining: epCount() }];
  const pushEp = (step: string, cond: string, ...params: unknown[]) => {
    epWhere.push(cond);
    epParams.push(...params);
    endpointFunnel.push({ step, remaining: epCount() });
  };

  pushEp('端点 active', "e.status = 'active'");
  pushEp('模型 active 且启用', "m.status = 'active' AND m.enabled = 1");
  pushEp(EP_FUNNEL_PROVIDER_ENABLED, 'p.enabled = 1');
  for (const cap of req.excludeCapabilities ?? []) {
    pushEp(`排除能力 ${cap}`, 'NOT EXISTS (SELECT 1 FROM json_each(m.capabilities) WHERE json_each.value = ?)', cap);
  }
  if (contextFloor > 0) pushEp(`context ≥ ${contextFloor}`, 'COALESCE(m.context_window, 0) >= ?', contextFloor);
  if (req.maxCostPer1k !== undefined) {
    pushEp(`成本 ≤ ${req.maxCostPer1k}/1k`, '(m.input_price_per_1k + m.output_price_per_1k) <= ?', req.maxCostPer1k);
  }
  if (resourceGroups && resourceGroups.length > 0) {
    pushEp(
      `资源组 ∈ [${resourceGroups.join(', ')}]`,
      `(${resourceGroups.map(() => "(m.resource_group = ? OR m.resource_group = '' OR m.resource_group IS NULL)").join(' OR ')})`,
      ...resourceGroups,
    );
  }
  if (req.preferredProvider) pushEp(`供应商 = ${req.preferredProvider}`, 'm.provider_id = ?', req.preferredProvider);
  // M14: 能力只留**最后一步**——"至少一项命中"。它与主查询的两段式池划分同一条底线，
  //   故末步归零 ⟺ 主查询零候选（"漏斗末步与主查询同值"这条既有性质得以对所有请求成立）。
  if (capabilities.length > 0) {
    pushEp(
      EP_FUNNEL_ANY_CAPABILITY,
      `EXISTS (SELECT 1 FROM json_each(m.capabilities) WHERE json_each.value IN (${capabilities.map(() => '?').join(', ')}))`,
      ...capabilities,
    );
  }

  // ── 模型级漏斗：端点漏斗看不到"在册、可用、但一个 active 端点都没有"的模型 ──
  const mCount = (where: string) =>
    (
      db
        .prepare(`SELECT COUNT(*) as c FROM ans_ai_models m JOIN ans_ai_providers p ON m.provider_id = p.id ${where}`)
        .get() as { c: number }
    ).c;
  const modelFunnel: Array<{ step: string; remaining: number }> = [
    { step: '在册模型', remaining: mCount('') },
    { step: '供应商启用', remaining: mCount('WHERE p.enabled = 1') },
    { step: '模型 active 且启用', remaining: mCount("WHERE p.enabled = 1 AND m.status = 'active' AND m.enabled = 1") },
    {
      step: '有 active 端点',
      remaining: mCount(
        "WHERE p.enabled = 1 AND m.status = 'active' AND m.enabled = 1 AND EXISTS (SELECT 1 FROM ans_model_endpoints e WHERE e.model_id = m.id AND e.status = 'active')",
      ),
    },
  ];

  return { endpointFunnel, modelFunnel, summary: summarizeFailure(endpointFunnel, modelFunnel) };
}

/** 元凶 = **第一个把剩数打到 0 的那一步**（端点漏斗优先——它才是最终被筛的那一层）。 */
function summarizeFailure(
  endpointFunnel: Array<{ step: string; remaining: number }>,
  modelFunnel: Array<{ step: string; remaining: number }>,
): string {
  const firstZero = (f: Array<{ step: string; remaining: number }>) => {
    const i = f.findIndex((s) => s.remaining === 0);
    const hit = i < 0 ? undefined : f[i];
    if (!hit) return null;
    return { at: i, step: hit.step, before: i > 0 ? (f[i - 1]?.remaining ?? 0) : 0 };
  };
  const z = firstZero(endpointFunnel);
  if (z) {
    if (z.at === 0) return '一个模型端点都没登记';
    if (z.at === 1) return `登记的 ${z.before} 个端点里没有一个是 active 状态`;
    return `端点漏斗在「${z.step}」这一步归零——前一步还剩 ${z.before} 个，这一步筛没了`;
  }
  // 端点漏斗没归零却零命中：只可能是主查询里独立于漏斗的条件（漏斗覆盖不到），如实说"说不清"。
  const mz = firstZero(modelFunnel);
  if (mz && mz.at === 0) return '一个模型都没登记';
  if (mz) return `模型漏斗在「${mz.step}」这一步归零——前一步还剩 ${mz.before} 个`;
  return '端点漏斗与模型漏斗都未归零，成因说不清（漏斗条件与主查询条件可能已不一致）';
}

function sortByStrategy(
  endpoints: EndpointRow[],
  strategy: string,
  db?: Database.Database,
  projectId?: string,
  hitOf?: (e: EndpointRow) => number,
): EndpointRow[] {
  // P0.5 实践验证：获取各模型的质量评分
  const qualityScores = db ? getModelQualityScores(db, projectId) : new Map<string, number>();

  const qualityWeight = 0.4;
  const baseWeight = 0.6;

  switch (strategy) {
    case 'cost-optimal': {
      // ③ (2026-09-03): cost-optimal 名副其实——按成本升序（未定价 0 视为成本未知，排在已定价之后）；
      // 同价按「高质量 + 高优先级」优先（C2 同价优先高质量）。此前 cost-optimal 与其它策略同排序、忽略价格。
      const costOf = (e: EndpointRow): number => {
        const c = (e.input_price_per_1k ?? 0) + (e.output_price_per_1k ?? 0);
        return c <= 0 ? Number.POSITIVE_INFINITY : c;
      };
      return [...endpoints].sort((a, b) => {
        const ca = costOf(a);
        const cb = costOf(b);
        if (ca !== cb) return ca - cb;
        const qa = qualityScores.get(a.model_id) ?? 0.5;
        const qb = qualityScores.get(b.model_id) ?? 0.5;
        return b.priority + qb * 5 - (a.priority + qa * 5);
      });
    }
    case 'latency-optimal': {
      // ④ (2026-09-03): latency-optimal 名副其实——按最近一次连通性延迟升序（未检测 0 视为延迟未知，排最后）；
      // 同延迟按「高质量 + 高优先级」优先。此前与其它策略同排序、忽略延迟。
      const latOf = (e: EndpointRow): number =>
        e.last_latency_ms && e.last_latency_ms > 0 ? e.last_latency_ms : Number.POSITIVE_INFINITY;
      return [...endpoints].sort((a, b) => {
        const la = latOf(a);
        const lb = latOf(b);
        if (la !== lb) return la - lb;
        const qa = qualityScores.get(a.model_id) ?? 0.5;
        const qb = qualityScores.get(b.model_id) ?? 0.5;
        return b.priority + qb * 5 - (a.priority + qa * 5);
      });
    }
    case 'capability-best': {
      // zx_20261002 M14: 本分支此前**完全不读 capabilities**（只按 priority + 质量分），
      //   "能力最佳"名不副实（§1.5 行 2 的静态证据）。现按**请求能力命中数**降序优先，
      //   同命中数再按 priority + 质量分。两段式选型下全中池内命中数恒等，
      //   故这一步实际只在**降级（部分命中）池**里裁决"缺得少者优先"。
      const hit = hitOf ?? (() => 0);
      return [...endpoints].sort((a, b) => {
        const ha = hit(a);
        const hb = hit(b);
        if (ha !== hb) return hb - ha;
        const qa = qualityScores.get(a.model_id) ?? 0.5;
        const qb = qualityScores.get(b.model_id) ?? 0.5;
        return b.priority + qb * 5 - (a.priority + qa * 5);
      });
    }
    case 'balanced':
      return weightedShuffle([...endpoints], qualityScores, qualityWeight, baseWeight);
    default:
      return endpoints;
  }
}

/** P0.5 实践验证：从质量日志中获取模型的质量评分 */
function getModelQualityScores(db: Database.Database, projectId?: string): Map<string, number> {
  const scores = new Map<string, number>();
  try {
    // 检查表是否存在
    const tableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ans_model_quality_logs'")
      .get() as { name: string } | undefined;
    if (!tableCheck) return scores;

    const rows = db
      .prepare(
        `
      SELECT model_id,
             CAST(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS REAL) / MAX(COUNT(*), 1) as success_rate,
             AVG(CASE WHEN token_efficiency IS NOT NULL AND token_efficiency > 0 THEN token_efficiency ELSE NULL END) as token_eff,
             AVG(CASE WHEN latency_ms IS NOT NULL AND latency_ms > 0 THEN latency_ms ELSE NULL END) as avg_latency,
             COUNT(*) as total_uses
      FROM ans_model_quality_logs
      WHERE (? IS NULL OR project_id = ?)
      GROUP BY model_id
      HAVING total_uses >= 3
    `,
      )
      .all(projectId || null, projectId || null) as Array<{
      model_id: string;
      success_rate: number;
      token_eff: number | null;
      avg_latency: number | null;
      total_uses: number;
    }>;

    for (const row of rows) {
      // C2 (2026-09-03): 综合质量分 0-1（成功率0.5 + 延迟0.3 + token效率0.2），与 GET /models quality_score 同口径
      const smoothed = (row.success_rate * row.total_uses + 0.5 * 3) / (row.total_uses + 3);
      const latencyScore = row.avg_latency ? Math.max(0, 1 - row.avg_latency / 10_000) : 0.5;
      const effScore = row.token_eff != null ? Math.min(1, Math.max(0, row.token_eff)) : 0.5;
      const quality = 0.5 * smoothed + 0.3 * latencyScore + 0.2 * effScore;
      scores.set(row.model_id, Math.round(quality * 100) / 100);
    }
  } catch {
    /* 表可能尚不存在 */
  }
  return scores;
}

/**
 * P0.5 加权洗牌：高weight+高质量评分(40%)的端点排在前面（概率更高），同时考虑priority(60%)。
 */
function weightedShuffle(
  endpoints: EndpointRow[],
  qualityScores: Map<string, number>,
  qw = 0.4,
  bw = 0.6,
): EndpointRow[] {
  const scored = endpoints.map((e) => {
    const qScore = qualityScores.get(e.model_id) ?? 0.5;
    return {
      endpoint: e,
      score: ((e.priority + 1) * e.weight * bw + qScore * 5 * qw) * Math.random(),
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.endpoint);
}
