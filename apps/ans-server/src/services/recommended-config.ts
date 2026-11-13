/**
 * zx_20261107_1 B6「信」：推荐目录的**唯一读取处**（含币种真源 `provider_currency`）。
 *
 * 病根：`/recommended`、`/providers`、`/optimal` 三个出口各读各的，且**都不回传币种**
 *   ⇒ 界面只能按供应商名再抄一份映射，抄错就是「¥/$」印反。
 *
 * 纪律：
 *   ① 目录文件只在此处读一次并缓存（同一进程内三出口同值）；
 *   ② 币种**只认目录里有的**——查不到回 `null`（用户自建 provider 的 UUID 不在目录里，不臆造）；
 *   ③ 系统 provider 的 id 与目录 id 同源（`syncRecommendedCatalogFromFile` 按 id upsert）。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RecommendedProvider {
  id: string;
  name: string;
  base_url: string;
  website: string;
  protocol: string;
  api_key_guide: unknown;
}

export interface RecommendedModel {
  id: string;
  provider_id: string;
  name: string;
  capabilities: string[];
  context_window: number;
  max_output_tokens: number;
  input_price_per_1k: number;
  output_price_per_1k: number;
  description: string;
}

export interface RecommendedConfig {
  version?: string;
  updated_at?: string;
  providers: RecommendedProvider[];
  models: RecommendedModel[];
  use_cases: unknown[];
  pricing_note?: string;
  /** 供应商 id → 币种代码（如 `USD` / `CNY`）；缺该键即未知。 */
  provider_currency?: Record<string, string>;
  _note?: unknown;
}

let _cache: RecommendedConfig | null = null;

export function getRecommendedConfig(): RecommendedConfig {
  if (!_cache) {
    const configPath = resolve(dirname(fileURLToPath(import.meta.url)), '../data/recommended-models.json');
    _cache = JSON.parse(readFileSync(configPath, 'utf-8')) as RecommendedConfig;
  }
  return _cache;
}

/** 币种：目录里查不到 ⇒ `null`（未知，不猜）。 */
export function providerCurrencyOf(config: RecommendedConfig, providerId: string | null | undefined): string | null {
  if (!providerId) return null;
  const cur = config.provider_currency?.[providerId];
  return typeof cur === 'string' && cur.trim() ? cur : null;
}
