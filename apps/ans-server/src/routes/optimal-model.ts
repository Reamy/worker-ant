/**
 * zx_20260924 M6-b（维特根斯坦·一个词一个用法）: `/api/v1/models/optimal` 的**唯一实现**。
 *
 * 病根：同一路径上曾有两份实现——`index.ts` 里挂在 `hmacApi` 上的**活体**内联，
 * 与 `routes/models.ts` 里挂在 `modelsRoutes` 上的 `.post('/optimal')`。Elysia **后注册者胜**
 * （`index.ts` 里 `hmacManagement` 在前、`hmacApi` 在后），故**活的一直是前者，后者是死的**。
 *
 * 要命的是两份的**回包形状并不相同**：活体带 `input_price_per_1k`/`output_price_per_1k`
 * 与**三级降级链**（`sameProviderFallback`/`crossProviderFallback`），死的那份两样都没有。
 * 于是"注册顺序"这个与业务毫无关系的偶然事实，悄悄决定了调用方**能不能拿到价格**——
 * 而价格正是桌面侧成本闸（`readMaxCostPer1k`）的依据。谁哪天为了别的事把注册顺序调过来，
 * 就会静默丢掉价格与降级链，且没有任何一处会红。
 *
 * 故把实现收成此处**一处**：`index.ts` 的活体路由退化为薄壳（只负责 HMAC 与取资源组），
 * 死的那份删除、不留等价物。判据（`models-routes.test.ts`）改为**直调本函数**——
 * 这样它证的是"生产跑的那份"，而不是"某份恰好也注册在同名路径上的实现"。
 */
import type Database from 'better-sqlite3';
import {
  matchOptimalModel,
  parseModelCapabilities,
  type EndpointRow,
  type MatchStrategy,
} from '../services/resource-matcher.js';
import { decryptApiKey } from '../utils/security.js';

/** 请求体（与路由的 `t.Object` 校验同形；此处只管类型，不重复校验）。 */
export interface OptimalModelBody {
  strategy?: string;
  capabilities?: string[];
  maxCostPer1k?: number;
  preferredProvider?: string;
  excludeCapabilities?: string[];
}

/** 降级链上的一跳（已解密）。 */
export interface OptimalModelEndpoint {
  model_id: string;
  model_name: string;
  url: string;
  api_key: string;
  max_output_tokens: number;
  context_window: number;
  input_price_per_1k: number;
  output_price_per_1k: number;
  /**
   * zx_20260929 M6-1a: **纯追加**——降级链上这一跳**自己的**能力清单。
   *
   * 此前只有 `OptimalModelSuccess.capabilities`（主模型）带能力，降级链三跳都没有。
   * 后果：桌面侧换到 tier2/tier3 之后**无据可比**——`compareModelCapabilities` 只会返回 `null`
   * （"无从比对"），于是「换模型之后重跑能力回验」这条判据**永远走不到**，写了也是死码
   * （本轮病根：在册≠在路）。
   *
   * 键**恒在场**，取不到时是 `[]`——`[]` 是"如实报空"（`EndpointRow.capabilities` 的
   * `COALESCE(..., '[]')` 与 `parseModelCapabilities` 的不可解析即 `[]` 同一口径），
   * 与"没这个键"不是一回事：前者可供比对，后者只能"无从比对"。
   */
  capabilities: string[];
}

/** 出不来模型时的如实回话。`diagnostics` 为**纯追加**（zx_20260921_1 M2）。 */
export interface OptimalModelFailure {
  error: { code: string; message: string; diagnostics?: unknown };
}

export interface OptimalModelSuccess {
  id: string;
  model_name: string;
  url: string;
  api_key: string;
  max_output_tokens: number;
  context_window: number;
  input_price_per_1k: number;
  output_price_per_1k: number;
  /**
   * zx_20260924 M6-a: **纯追加**——主模型在册的能力清单，供调用方回验"实得是否含所要"。
   * 此前回包无任何字段可回答这件事，桌面侧只能选择相信。新增字段不改任何既有字段的取值与在场性。
   */
  capabilities: string[];
  /**
   * zx_20261002 M14: **纯追加**——主模型对本次请求能力的满足度：`'full'` 全部命中；
   * `'partial'` 部分命中（ANS 两段式：全中池为空时的**降级选型**）。
   *
   * 为什么这一项**必须**跨进程带出：调用方能从 `capabilities` 算出"这个模型缺什么"，
   * 却**算不出**"当时到底有没有全中模型可选"。缺的那一项不是调用方的失误时，
   * 就得让「环境所迫的降级」与「选型失误」在账上分得开——否则"能力略差但可用"又成一处静默降级。
   * ⚠ 旧 ANS 不带本键 ⇒ 读到 `undefined`，按 `'full'` 语义（与改动前一致）处理。
   */
  capabilityMatch: 'full' | 'partial';
  sameProviderFallback: OptimalModelEndpoint | null;
  crossProviderFallback: OptimalModelEndpoint | null;
  /** @deprecated 保留兼容，等同 `crossProviderFallback` */
  fallback: OptimalModelEndpoint | null;
}

/** 降级链一跳的解密。解不开返回 `null`（一跳坏不该把整条回包打掉）。 */
function decryptEndpoint(e: EndpointRow | null): OptimalModelEndpoint | null {
  if (!e) return null;
  try {
    return {
      model_id: e.model_id,
      model_name: e.model_name,
      url: e.url,
      api_key: decryptApiKey(e.api_key_ref),
      max_output_tokens: e.max_output_tokens || 4096,
      context_window: e.context_window || 128000,
      input_price_per_1k: e.input_price_per_1k ?? 0.005,
      output_price_per_1k: e.output_price_per_1k ?? 0.015,
      // zx_20260929 M6-1a: 与 `resolveOptimalModel` 的主模型同口径（同一函数、同一字段）。
      capabilities: parseModelCapabilities(e.capabilities),
    };
  } catch {
    return null;
  }
}

/**
 * 选出最优模型（已解密、可直接用的形状）。**不抛**：拿不到模型或解不开密钥都返回 `{error}`——
 * 调用方（`ans-client`）判失败的依据是回包形状，不是 HTTP 状态码。
 */
export function resolveOptimalModel(
  db: Database.Database,
  body: OptimalModelBody,
  resourceGroups?: string[],
): OptimalModelSuccess | OptimalModelFailure {
  const result = matchOptimalModel(
    db,
    {
      strategy: body.strategy as MatchStrategy | undefined,
      capabilities: body.capabilities,
      maxCostPer1k: body.maxCostPer1k,
      preferredProvider: body.preferredProvider,
      excludeCapabilities: body.excludeCapabilities,
    },
    resourceGroups,
  );

  if (!result.primary) {
    return { error: { code: 'NOT_FOUND', message: '没有找到匹配的模型', diagnostics: result.diagnostics } };
  }

  try {
    return {
      id: result.primary.model_id,
      model_name: result.primary.model_name,
      url: result.primary.url,
      api_key: decryptApiKey(result.primary.api_key_ref),
      max_output_tokens: result.primary.max_output_tokens || 4096,
      context_window: result.primary.context_window || 128000,
      input_price_per_1k: result.primary.input_price_per_1k ?? 0.005,
      output_price_per_1k: result.primary.output_price_per_1k ?? 0.015,
      capabilities: parseModelCapabilities(result.primary.capabilities),
      // zx_20261002 M14: 主模型的满足度（`'partial'` = 降级选型）。主模型在场则该项必在场。
      capabilityMatch: result.capabilityMatch ?? 'full',
      // 8.4: 三级降级链
      sameProviderFallback: decryptEndpoint(result.sameProviderFallback),
      crossProviderFallback: decryptEndpoint(result.crossProviderFallback),
      fallback: decryptEndpoint(result.crossProviderFallback), // 向后兼容
    };
  } catch {
    return { error: { code: 'DECRYPT_FAILED', message: 'API Key解密失败' } };
  }
}
