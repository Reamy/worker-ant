import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';

/**
 * zx_20261106_2：推荐目录**同步**（而非一次性播种）。
 *
 * 旧实现是 `INSERT OR IGNORE`：JSON 更新后，库里已有的 `source='system'` 行**一个字都不会变**
 * —— 改了目录等于没改。此处改为按 id upsert，且**只动 system 行**：
 *   - 用户在 ANS 里自建的资源（`source='user'`）即使 id 撞名也不覆盖；
 *   - 用户对 system 行的运行态选择（`enabled` / `status`）不被目录同步重写。
 * 目录 JSON 仍然是唯一真源：模型能力、上下文、价格、说明只在 JSON 里改一处。
 */

export interface RecommendedProviderConfig {
  id: string;
  name: string;
  base_url?: string;
  website?: string;
  protocol?: string;
  api_key_guide?: unknown;
}

export interface RecommendedModelConfig {
  id: string;
  provider_id: string;
  name: string;
  capabilities?: string[];
  context_window?: number;
  max_output_tokens?: number;
  input_price_per_1k?: number;
  output_price_per_1k?: number;
  description?: string;
}

export interface RecommendedCatalogConfig {
  version?: string;
  providers: RecommendedProviderConfig[];
  models: RecommendedModelConfig[];
  use_cases?: unknown[];
}

export interface CatalogSyncResult {
  providersInserted: number;
  providersUpdated: number;
  modelsInserted: number;
  modelsUpdated: number;
}

function assertCatalog(config: RecommendedCatalogConfig): void {
  if (!config || !Array.isArray(config.providers) || !Array.isArray(config.models)) {
    throw new Error('推荐目录格式错误：providers / models 必须是数组');
  }
  const providerIds = new Set<string>();
  for (const p of config.providers) {
    if (!p?.id) throw new Error('推荐目录格式错误：provider.id 不能为空');
    if (providerIds.has(p.id)) throw new Error(`推荐目录格式错误：provider.id 重复（${p.id}）`);
    providerIds.add(p.id);
  }
  const modelIds = new Set<string>();
  for (const m of config.models) {
    if (!m?.id) throw new Error('推荐目录格式错误：model.id 不能为空');
    if (modelIds.has(m.id)) throw new Error(`推荐目录格式错误：model.id 重复（${m.id}）`);
    if (!providerIds.has(m.provider_id)) {
      throw new Error(`推荐目录格式错误：模型 ${m.id} 引用了不存在的 provider（${m.provider_id}）`);
    }
    modelIds.add(m.id);
  }
}

function existingIds(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`SELECT id FROM ${table}`).all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * 把目录同步进库：新增不存在的 system 行；更新已存在的 system 行。
 * 返回新增/更新计数，供启动日志如实说明"这轮到底改了什么"。
 */
export function syncRecommendedCatalog(db: Database.Database, config: RecommendedCatalogConfig): CatalogSyncResult {
  assertCatalog(config);

  const providerIdsBefore = existingIds(db, 'ans_ai_providers');
  const modelIdsBefore = existingIds(db, 'ans_ai_models');

  // `... IS NOT excluded....` 让 `.changes` 只在**内容真的变了**时为 1：
  //   否则每次启动都会把全部行报成"已更新"，日志就不再是事实。
  const upsertProvider = db.prepare(`
    INSERT INTO ans_ai_providers (id, name, base_url, status, source)
    VALUES (?, ?, ?, 'active', 'system')
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      base_url = excluded.base_url,
      updated_at = datetime('now')
    WHERE ans_ai_providers.source = 'system'
      AND (
        ans_ai_providers.name IS NOT excluded.name
        OR ans_ai_providers.base_url IS NOT excluded.base_url
      )
  `);

  const upsertModel = db.prepare(`
    INSERT INTO ans_ai_models (
      id, provider_id, name, capabilities, context_window, max_output_tokens,
      input_price_per_1k, output_price_per_1k, status, source, description
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'system', ?)
    ON CONFLICT(id) DO UPDATE SET
      provider_id = excluded.provider_id,
      name = excluded.name,
      capabilities = excluded.capabilities,
      context_window = excluded.context_window,
      max_output_tokens = excluded.max_output_tokens,
      input_price_per_1k = excluded.input_price_per_1k,
      output_price_per_1k = excluded.output_price_per_1k,
      description = excluded.description,
      updated_at = datetime('now')
    WHERE ans_ai_models.source = 'system'
      AND (
        ans_ai_models.provider_id IS NOT excluded.provider_id
        OR ans_ai_models.name IS NOT excluded.name
        OR ans_ai_models.capabilities IS NOT excluded.capabilities
        OR ans_ai_models.context_window IS NOT excluded.context_window
        OR ans_ai_models.max_output_tokens IS NOT excluded.max_output_tokens
        OR ans_ai_models.input_price_per_1k IS NOT excluded.input_price_per_1k
        OR ans_ai_models.output_price_per_1k IS NOT excluded.output_price_per_1k
        OR ans_ai_models.description IS NOT excluded.description
      )
  `);

  let providerChanges = 0;
  let modelChanges = 0;
  const run = db.transaction((cfg: RecommendedCatalogConfig) => {
    for (const p of cfg.providers) {
      providerChanges += upsertProvider.run(p.id, p.name, p.base_url ?? '').changes;
    }
    for (const m of cfg.models) {
      modelChanges += upsertModel.run(
        m.id,
        m.provider_id,
        m.name,
        JSON.stringify(m.capabilities ?? []),
        m.context_window ?? 4096,
        m.max_output_tokens ?? 1024,
        m.input_price_per_1k ?? 0,
        m.output_price_per_1k ?? 0,
        m.description ?? '',
      ).changes;
    }
  });
  run(config);

  let providersInserted = 0;
  let modelsInserted = 0;
  for (const p of config.providers) if (!providerIdsBefore.has(p.id)) providersInserted++;
  for (const m of config.models) if (!modelIdsBefore.has(m.id)) modelsInserted++;

  return {
    providersInserted,
    providersUpdated: Math.max(0, providerChanges - providersInserted),
    modelsInserted,
    modelsUpdated: Math.max(0, modelChanges - modelsInserted),
  };
}

export function readRecommendedCatalog(configPath: string): RecommendedCatalogConfig {
  if (!existsSync(configPath)) {
    throw new Error(`推荐目录文件不存在：${configPath}`);
  }
  return JSON.parse(readFileSync(configPath, 'utf-8')) as RecommendedCatalogConfig;
}

export function syncRecommendedCatalogFromFile(db: Database.Database, configPath: string): CatalogSyncResult {
  return syncRecommendedCatalog(db, readRecommendedCatalog(configPath));
}
