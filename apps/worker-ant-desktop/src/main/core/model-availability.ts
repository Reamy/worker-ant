/**
 * zx_20261011_5「名正而后事成」（《论语·子路》名不正则言不顺）——**模型可用性判据的一处真源**。
 *
 * 病根：首启判据 `needsSetup` 长期只看「无项目 ∧ 未真配 ANS」（`core/first-run.ts`），**看不见模型**。
 *   于是"配好凭据、未配任何模型端点"的用户被判为"已就绪"，落到**空白 Dashboard**；此后建任务时
 *   执行侧选不到模型，只在 run context 静默记 `no_model`，用户看不到一句解释（漏斗第一跳漏在这里）。
 *
 * 另一处病根：`catalog/available/hasChat/hasEmbedding` 的派生**此前只存在于渲染层**（`SetupPage.tsx`
 *   内联 + `renderer/lib/model-caps.ts` 的 `parseCapabilities`），main 侧无同源实现。若首屏空态再写一份，
 *   即成**第二份实现**（违「判据的自我印证」纪律：两处各判一次，迟早各说各话）。故本模块把派生逻辑
 *   收成**一处真源**：main 与 renderer 同引（renderer 反引 `../../../src/main/core/model-availability.js`，
 *   与 `DashboardPage` 引 `core/health-check.js` 的既有范式一致）。
 *
 * 独立成**零依赖**模块（不引 electron / better-sqlite3 / node:*），判据可直接调真实现（G-1），
 *   `request` 是注入的取数跳，rr 用可控替身喂入即可——不依赖真实 ANS、不依赖真实墙钟（G-4）。
 */

/** 目录行（`GET /api/v1/models` 的返回元素）——只声明本模块用到的字段。 */
export interface ModelCatalogRow {
  id?: string;
  name?: string;
  provider_id?: string;
  /** 是否配了可用端点（由 ANS 侧 SQL 派生，此处**不再重算**）。 */
  available?: boolean;
  /** 能力声明：线上是 JSON 文本，内存里也可能是数组。 */
  capabilities?: unknown;
}

/** 模型可用性快照——四数，不含"读没读动"（那是 `ModelProbe` 的事）。 */
export interface ModelAvailability {
  /** 目录条数 = ANS 返回的全部行（**含未配端点者**）。 */
  catalog: number;
  /** 其中有可用端点者（`available === true`）。 */
  available: number;
  /** 有可用 **chat** 模型 ⇒ 跑得出成果（首启判据要的就是这一条）。 */
  hasChat: boolean;
  /** 有可用 **embedding** 模型 ⇒ 记忆向量可生成。 */
  hasEmbedding: boolean;
}

/**
 * 模型 `capabilities` 字段解析的**一处真源**（zx_20261010 M2 首次收成，zx_20261011_5 上移至 main）。
 * 三态：数组直接用；字符串当 JSON 解析（ANS 把 `ans_ai_models.capabilities` 落为 JSON 文本）；其余 ⇒ 空。
 */
export function parseModelCapabilities(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') { try { return JSON.parse(raw) as string[]; } catch { return []; } }
  return [];
}

/**
 * 由目录行派生四数——语义与 `SetupPage.tsx` 自检处**逐字对齐**（`available === true` 且能力含 chat/embedding）。
 * 对入参不做真数组之外的假设（`Array.isArray` 兜底，字符串/undefined ⇒ 视作空目录）。
 */
export function deriveModelAvailability(rows: readonly ModelCatalogRow[] | unknown): ModelAvailability {
  const list = Array.isArray(rows) ? (rows as ModelCatalogRow[]) : [];
  return {
    catalog: list.length,
    available: list.filter((m) => m.available === true).length,
    hasChat: list.some((m) => m.available === true && parseModelCapabilities(m.capabilities).includes('chat')),
    hasEmbedding: list.some((m) => m.available === true && parseModelCapabilities(m.capabilities).includes('embedding')),
  };
}

/**
 * 从 `GET /api/v1/models` 的回包里取出目录行——**两形状都收**：
 *   ① 裸数组（`deriveModelAvailability` 的契约形状）；
 *   ② ANS 的分页信封 `{ data: [...], total, limit, offset }`（`routes/models.ts` 的 `return { data, ...pageMeta }`）。
 *
 * 病根（2026-10-12 实机照出）：`setup.ipc.ts` 把**整个信封**喂进 `probeModelAvailability`，而
 *   `deriveModelAvailability` 只认数组 ⇒ 信封被静默当成**空目录** ⇒ 首屏误报"ANS 中尚无可用模型"
 *   （该库实有 52 个模型、4 个可用端点）。拆信封放在**本模块**（拥有该契约处）——
 *   与全仓惯例一致：renderer 的 `ipcCall` 自动剥一层 `.data`（`renderer/lib/ipc.ts`），main 侧各直连点
 *   （`node-list.ts` / `skill-registry.ts` / `node-request-io.ts` …）皆手拆 `.data`，唯 `setup.ipc.ts` 漏。
 */
export function extractModelCatalog(raw: unknown): ModelCatalogRow[] {
  if (Array.isArray(raw)) return raw as ModelCatalogRow[];
  const data = (raw as { data?: unknown } | null | undefined)?.data;
  return Array.isArray(data) ? (data as ModelCatalogRow[]) : [];
}

/** 读模型列表的三态（与 `zx_20261009 M5` 的「服务可达」三件事分家说同旨）。 */
export type ModelsRead = 'ok' | 'auth' | 'error';

/** 模型可用性探针结果 = 四数 + "读没读动"。renderer 的 `probe-models.ts` 反引本类型（一处真源）。 */
export interface ModelProbe extends ModelAvailability {
  read: ModelsRead;
  /** `read === 'ok'` 时为空；否则为如实原因（供上屏）。 */
  note: string;
}

/** 取数跳的返回——把"没成功"如实装进返回值（与 `AnsRequestResult` 同旨：失败与"没有值"可分辨）。 */
export interface ModelsProbeResponse {
  ok: boolean;
  /** 有 HTTP 响应时为真实状态码；传输层失败时为 `0`。 */
  status: number;
  /**
   * 解析后的 JSON body——**两形状都收**（见 `extractModelCatalog`）：裸数组，或 ANS 的分页信封
   *   `{ data: [...] }`；解析失败 / 无 body ⇒ `undefined`。
   */
  body?: unknown;
  /** 传输层失败的如实原因。 */
  detail?: string;
}

/** 探模型可用的依赖注入：`request` 由调用方喂（生产＝走 `ansSignedRequest` 的那一跳）。 */
export interface ModelsProbeDeps {
  request(): Promise<ModelsProbeResponse>;
}

/**
 * 探一次模型可用性。**永不抛**：把"读不动"如实装进 `read`（`auth`=401 未认证 / `error`=其它读失败），
 *   与"读得到但为 0"分开——这正是 zx_20261009 M5 的「意义即使用」：三件事要分家说，不能合成一句。
 */
export async function probeModelAvailability(deps: ModelsProbeDeps): Promise<ModelProbe> {
  let r: ModelsProbeResponse;
  try {
    r = await deps.request();
  } catch (e) {
    return { read: 'error', note: (e as Error)?.message || String(e), catalog: 0, available: 0, hasChat: false, hasEmbedding: false };
  }
  if (!r.ok) {
    const read = r.status === 401 ? 'auth' : 'error';
    const status = r.status > 0 ? `HTTP ${r.status}` : '无响应';
    return { read, note: `${status}${r.detail ? ` — ${r.detail}` : ''}`, catalog: 0, available: 0, hasChat: false, hasEmbedding: false };
  }
  return { read: 'ok', note: '', ...deriveModelAvailability(extractModelCatalog(r.body)) };
}
