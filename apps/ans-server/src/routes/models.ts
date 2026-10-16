import type Database from 'better-sqlite3';
import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptApiKey, decryptApiKey, hmacAuth } from '../utils/security.js';
import { notFound, AppError, ErrorCode } from '../utils/errors.js';
import { AuditService } from '../services/audit.js';
import { validateCapabilities } from '../services/model-capabilities.js';
import { parsePagination, paginationClause, paginationArgs, pageMeta } from '../utils/pagination.js';

/**
 * M15-⑦: `capabilities` 的**形状**（非空数组）由 schema 挡；**取值域**由 handler 里
 *   `validateCapabilities`（真源 `services/model-capabilities.ts`）挡——两者都归到 400。
 *   元素不写成 `t.Union` 一大堆字面量：那会把词表在 schema 里再抄一份（正是本项要消掉的病）。
 */
const capabilitiesShape = t.Array(t.String(), { minItems: 1 });

// 加载推荐模型配置（缓存）
let _recommendedConfigCache: {
  providers: Array<{
    id: string;
    name: string;
    base_url: string;
    website: string;
    protocol: string;
    api_key_guide: unknown;
  }>;
  models: Array<{
    id: string;
    provider_id: string;
    name: string;
    capabilities: string[];
    context_window: number;
    max_output_tokens: number;
    input_price_per_1k: number;
    output_price_per_1k: number;
    description: string;
  }>;
  use_cases: unknown[];
} | null = null;
function getRecommendedConfig() {
  if (!_recommendedConfigCache) {
    const configPath = resolve(dirname(fileURLToPath(import.meta.url)), '../data/recommended-models.json');
    _recommendedConfigCache = JSON.parse(readFileSync(configPath, 'utf-8'));
  }
  return _recommendedConfigCache!;
}

export function modelsRoutes(db: Database.Database) {
  const audit = new AuditService(db);

  return (
    new Elysia({ prefix: '/api/v1/models' })
      // ===== Providers =====
      .get('/providers', () => {
        // C2 (2026-09-01): 供应商可用性聚合——可用模型数（active+启用+有active端点）+ 派生 available
        // C1 (2026-09-03): 供应商级使用统计（跨其 models 聚合 quality_logs + billing_records）
        const rows = db
          .prepare(
            `
        SELECT p.*,
          (SELECT COUNT(*) FROM ans_ai_models m JOIN ans_model_endpoints e ON e.model_id = m.id
            WHERE m.provider_id = p.id AND m.status = 'active' AND m.enabled = 1 AND e.status = 'active') as available_models,
          (SELECT COUNT(*) FROM ans_model_quality_logs q JOIN ans_ai_models mq ON q.model_id = mq.id WHERE mq.provider_id = p.id) as _call_count,
          (SELECT ROUND(1.0 * SUM(q2.success) / NULLIF(COUNT(*), 0), 4) FROM ans_model_quality_logs q2 JOIN ans_ai_models mq2 ON q2.model_id = mq2.id WHERE mq2.provider_id = p.id AND q2.success IS NOT NULL) as _success_rate,
          (SELECT COALESCE(SUM(b.cost), 0) FROM ans_billing_records b JOIN ans_ai_models mb ON b.model_id = mb.id WHERE mb.provider_id = p.id) as _cost,
          (SELECT COALESCE(SUM(b2.tokens_in + b2.tokens_out), 0) FROM ans_billing_records b2 JOIN ans_ai_models mb2 ON b2.model_id = mb2.id WHERE mb2.provider_id = p.id) as _tokens
        FROM ans_ai_providers p
        WHERE p.status != 'disabled'
        ORDER BY p.created_at DESC
      `,
          )
          .all() as Array<Record<string, unknown>>;
        return {
          data: rows.map((r) => {
            const { _call_count, _success_rate, _cost, _tokens, ...rest } = r;
            const callCount = (_call_count as number) || 0;
            const stats = {
              call_count: callCount,
              success_rate: (_success_rate as number | null) ?? null,
              total_cost: (_cost as number) || 0,
              total_tokens: (_tokens as number) || 0,
            };
            return {
              ...rest,
              available: r.status === 'active' && (r.enabled ?? 1) !== 0 && (r.available_models as number) > 0,
              stats,
            };
          }),
        };
      })
      .get('/providers/:id', ({ params: { id } }) => {
        const row = db.prepare('SELECT * FROM ans_ai_providers WHERE id = ?').get(id);
        if (!row) throw notFound('Provider', id);
        return { data: row };
      })
      .post(
        '/providers',
        ({ body, set }) => {
          const id = randomUUID();
          db.prepare('INSERT INTO ans_ai_providers (id, name, base_url) VALUES (?, ?, ?)').run(
            id,
            body.name,
            body.base_url ?? null,
          );
          audit.log({
            actor: 'api',
            action: 'create_provider',
            resource_type: 'provider',
            resource_id: id,
            detail: { name: body.name },
          });
          set.status = 201;
          return { data: { id, name: body.name, base_url: body.base_url, status: 'active' } };
        },
        { body: t.Object({ name: t.String(), base_url: t.Optional(t.String()) }) },
      )
      .put(
        '/providers/:id',
        ({ params: { id }, body }) => {
          const existing = db.prepare('SELECT id FROM ans_ai_providers WHERE id = ?').get(id);
          if (!existing) throw notFound('Provider', id);
          // C1 (2026-09-01): 支持部分字段更新（含 enabled 启用开关），仅更新传入字段
          const sets: string[] = [];
          const vals: (string | number | null)[] = [];
          if (body.name !== undefined) {
            sets.push('name = ?');
            vals.push(body.name);
          }
          if (body.base_url !== undefined) {
            sets.push('base_url = ?');
            vals.push(body.base_url);
          }
          if (body.enabled !== undefined) {
            sets.push('enabled = ?');
            vals.push(body.enabled);
          }
          if (sets.length === 0) throw new Error('No fields to update');
          sets.push("updated_at = datetime('now')");
          db.prepare(`UPDATE ans_ai_providers SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
          audit.log({
            actor: 'api',
            action: 'update_provider',
            resource_type: 'provider',
            resource_id: id,
            detail: { ...body },
          });
          return { data: { id, ...body } };
        },
        {
          body: t.Object({
            name: t.Optional(t.String()),
            base_url: t.Optional(t.String()),
            enabled: t.Optional(t.Number()),
          }),
        },
      )
      .delete('/providers/:id', ({ params: { id }, set }) => {
        const provider = db.prepare('SELECT source FROM ans_ai_providers WHERE id = ?').get(id) as
          | { source: string }
          | undefined;
        if (provider?.source === 'system') {
          set.status = 403;
          return { error: { code: 'PROTECTED', message: '系统推荐供应商不可删除' } };
        }
        db.prepare(
          "UPDATE ans_ai_providers SET status = ?, updated_at = datetime('now') WHERE id = ? AND source != ?",
        ).run('disabled', id, 'system');
        audit.log({ actor: 'api', action: 'disable_provider', resource_type: 'provider', resource_id: id });
        return { data: { id, status: 'disabled' } };
      })

      // ===== AI Models =====
      .get('/', ({ query }) => {
        // C2 (2026-09-01): 无端点模型不可用——返回 endpoint_count + 派生 has_endpoint/available
        // C1/C2 (2026-09-03): 使用统计聚合（ans_model_quality_logs + ans_billing_records）+ 派生质量分
        // M15-⑤: 加 `limit`/`offset`/`total`（**缺省不限**——不给上限，就不改现有阅读面读到的条数）
        const page = parsePagination(query as Record<string, unknown>);
        const total = (
          db.prepare("SELECT COUNT(*) as c FROM ans_ai_models m WHERE m.status != 'disabled'").get() as { c: number }
        ).c;
        const rows = db
          .prepare(
            `
        SELECT m.*,
          (SELECT COUNT(*) FROM ans_model_endpoints e WHERE e.model_id = m.id AND e.status = 'active') as endpoint_count,
          (SELECT COUNT(*) FROM ans_model_quality_logs q WHERE q.model_id = m.id) as _call_count,
          (SELECT ROUND(1.0 * SUM(q.success) / NULLIF(COUNT(*), 0), 4) FROM ans_model_quality_logs q WHERE q.model_id = m.id AND q.success IS NOT NULL) as _success_rate,
          (SELECT ROUND(AVG(q.latency_ms), 0) FROM ans_model_quality_logs q WHERE q.model_id = m.id AND q.latency_ms IS NOT NULL AND q.latency_ms > 0) as _avg_latency,
          (SELECT ROUND(AVG(q.token_efficiency), 4) FROM ans_model_quality_logs q WHERE q.model_id = m.id AND q.token_efficiency IS NOT NULL) as _token_eff,
          (SELECT COALESCE(SUM(b.cost), 0) FROM ans_billing_records b WHERE b.model_id = m.id) as _cost,
          (SELECT COALESCE(SUM(b.tokens_in + b.tokens_out), 0) FROM ans_billing_records b WHERE b.model_id = m.id) as _tokens
        FROM ans_ai_models m
        WHERE m.status != 'disabled'
        ORDER BY m.created_at DESC${paginationClause(page)}
      `,
          )
          .all(...paginationArgs(page)) as Array<Record<string, unknown>>;
        const data = rows.map((r) => {
          const { _call_count, _success_rate, _avg_latency, _token_eff, _cost, _tokens, ...rest } = r;
          const callCount = (_call_count as number) || 0;
          const stats = {
            call_count: callCount,
            success_rate: (_success_rate as number | null) ?? null,
            avg_latency_ms: (_avg_latency as number | null) ?? null,
            total_cost: (_cost as number) || 0,
            total_tokens: (_tokens as number) || 0,
          };
          // C2: 质量评分（成功率0.5 + 延迟0.3 + token效率0.2 加权归一，0-100）；无使用数据 → null（resource-matcher 行为不变）
          let quality_score: number | null = null;
          if (callCount > 0) {
            const succ = (_success_rate as number | null) ?? 0;
            const latScore = Math.max(0, 1 - ((_avg_latency as number) || 0) / 10_000);
            const effScore = Math.min(1, Math.max(0, (_token_eff as number) ?? 0));
            quality_score = Math.round(100 * (0.5 * succ + 0.3 * latScore + 0.2 * effScore));
          }
          return {
            ...rest,
            has_endpoint: (r.endpoint_count as number) > 0,
            available: r.status === 'active' && (r.enabled ?? 1) !== 0 && (r.endpoint_count as number) > 0,
            stats,
            quality_score,
          };
        });
        return { data, ...pageMeta(total, page, data.length) };
      })
      .get('/:id', ({ params: { id } }) => {
        const row = db.prepare('SELECT * FROM ans_ai_models WHERE id = ?').get(id);
        if (!row) throw notFound('Model', id);
        return { data: row };
      })
      .post(
        '/',
        ({ body, set }) => {
          const provider = db
            .prepare('SELECT id FROM ans_ai_providers WHERE id = ? AND status = ?')
            .get(body.provider_id, 'active');
          if (!provider) throw notFound('Provider', body.provider_id);
          // M15-⑦: 能力取值域——表外的值会被 resource-matcher 当筛选条件用，故在**落库前**判死
          const caps = validateCapabilities(body.capabilities);
          if (!caps.ok) throw new AppError(ErrorCode.INVALID_REQUEST, caps.reason, 400);
          const id = randomUUID();
          db.prepare(
            `INSERT INTO ans_ai_models (id, provider_id, name, capabilities, context_window, max_output_tokens, input_price_per_1k, output_price_per_1k)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            body.provider_id,
            body.name,
            JSON.stringify(caps.value),
            body.context_window ?? 4096,
            body.max_output_tokens ?? 1024,
            body.input_price_per_1k ?? 0,
            body.output_price_per_1k ?? 0,
          );
          audit.log({
            actor: 'api',
            action: 'create_model',
            resource_type: 'model',
            resource_id: id,
            detail: { name: body.name },
          });
          set.status = 201;
          return { data: { id, ...body } };
        },
        {
          body: t.Object({
            provider_id: t.String(),
            name: t.String(),
            // M15-⑦: 由 `t.Optional(…)` 改**必填**（且非空）——'没写能力' 与 '能力为空' 都不该被当作
            //   合法建模；`resource-matcher` 正是按这个字段筛模型。活库 52 个模型无一为空（实测）。
            capabilities: capabilitiesShape,
            context_window: t.Optional(t.Number()),
            max_output_tokens: t.Optional(t.Number()),
            input_price_per_1k: t.Optional(t.Number()),
            output_price_per_1k: t.Optional(t.Number()),
          }),
        },
      )
      .put(
        '/:id',
        ({ params: { id }, body }) => {
          const existing = db.prepare('SELECT id FROM ans_ai_models WHERE id = ?').get(id);
          if (!existing) throw notFound('Model', id);
          // C1 (2026-09-01): 支持部分字段更新（含 enabled 启用开关），仅更新传入字段
          const sets: string[] = [];
          const vals: (string | number | null)[] = [];
          if (body.name !== undefined) {
            sets.push('name = ?');
            vals.push(body.name);
          }
          if (body.description !== undefined) {
            sets.push('description = ?');
            vals.push(body.description);
          }
          if (body.capabilities !== undefined) {
            // M15-⑦: PUT 侧**不设必填**（`ModelsPage` 的启停开关只发 `{enabled}`，改必填会把启停打成 400），
            //   但**给了就校验**——否则脏值同样落库。
            const caps = validateCapabilities(body.capabilities);
            if (!caps.ok) throw new AppError(ErrorCode.INVALID_REQUEST, caps.reason, 400);
            sets.push('capabilities = ?');
            vals.push(JSON.stringify(caps.value));
          }
          if (body.context_window !== undefined) {
            sets.push('context_window = ?');
            vals.push(body.context_window);
          }
          if (body.max_output_tokens !== undefined) {
            sets.push('max_output_tokens = ?');
            vals.push(body.max_output_tokens);
          }
          if (body.input_price_per_1k !== undefined) {
            sets.push('input_price_per_1k = ?');
            vals.push(body.input_price_per_1k);
          }
          if (body.output_price_per_1k !== undefined) {
            sets.push('output_price_per_1k = ?');
            vals.push(body.output_price_per_1k);
          }
          if (body.enabled !== undefined) {
            sets.push('enabled = ?');
            vals.push(body.enabled);
          }
          if (sets.length === 0) throw new Error('No fields to update');
          sets.push("updated_at = datetime('now')");
          db.prepare(`UPDATE ans_ai_models SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
          return { data: { id, ...body } };
        },
        {
          body: t.Object({
            name: t.Optional(t.String()),
            description: t.Optional(t.String()),
            capabilities: t.Optional(capabilitiesShape),
            context_window: t.Optional(t.Number()),
            max_output_tokens: t.Optional(t.Number()),
            input_price_per_1k: t.Optional(t.Number()),
            output_price_per_1k: t.Optional(t.Number()),
            enabled: t.Optional(t.Number()),
          }),
        },
      )
      .delete('/:id', ({ params: { id }, set }) => {
        const model = db.prepare('SELECT source FROM ans_ai_models WHERE id = ?').get(id) as
          | { source: string }
          | undefined;
        if (model?.source === 'system') {
          set.status = 403;
          return { error: { code: 'PROTECTED', message: '系统推荐模型不可删除' } };
        }
        db.prepare(
          "UPDATE ans_ai_models SET status = ?, updated_at = datetime('now') WHERE id = ? AND source != ?",
        ).run('disabled', id, 'system');
        return { data: { id, status: 'disabled' } };
      })

      // ===== Endpoints =====
      .get('/:id/endpoints', ({ params: { id } }) => {
        const rows = db
          .prepare("SELECT * FROM ans_model_endpoints WHERE model_id = ? AND status = 'active' ORDER BY priority DESC")
          .all(id);
        return { data: rows };
      })
      .post(
        '/:id/endpoints',
        ({ params: { id }, body, set }) => {
          const model = db.prepare('SELECT id FROM ans_ai_models WHERE id = ? AND status = ?').get(id, 'active');
          if (!model) throw notFound('Model', id);
          const epId = randomUUID();
          const apiKeyRef = encryptApiKey(body.api_key);
          db.prepare(
            'INSERT INTO ans_model_endpoints (id, model_id, url, api_key_ref, priority, weight) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(epId, id, body.url, apiKeyRef, body.priority ?? 0, body.weight ?? 1.0);
          set.status = 201;
          return {
            data: { id: epId, model_id: id, url: body.url, priority: body.priority ?? 0, weight: body.weight ?? 1.0 },
          };
        },
        {
          body: t.Object({
            url: t.String(),
            api_key: t.String(),
            priority: t.Optional(t.Number()),
            weight: t.Optional(t.Number()),
          }),
        },
      )
      .put(
        '/endpoints/:id',
        ({ params: { id }, body }) => {
          const existing = db
            .prepare('SELECT id FROM ans_model_endpoints WHERE id = ? AND status = ?')
            .get(id, 'active');
          if (!existing) throw notFound('Endpoint', id);
          const sets: string[] = ['url = ?', 'priority = ?', 'weight = ?'];
          const vals: (string | number)[] = [body.url, body.priority ?? 0, body.weight ?? 1.0];
          if (body.api_key) {
            sets.push('api_key_ref = ?');
            vals.push(encryptApiKey(body.api_key));
          }
          db.prepare(`UPDATE ans_model_endpoints SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
          return { data: { id, url: body.url, priority: body.priority ?? 0, weight: body.weight ?? 1.0 } };
        },
        {
          body: t.Object({
            url: t.String(),
            priority: t.Optional(t.Number()),
            weight: t.Optional(t.Number()),
            api_key: t.Optional(t.String()),
          }),
        },
      )
      .delete('/endpoints/:id', ({ params: { id } }) => {
        db.prepare('UPDATE ans_model_endpoints SET status = ? WHERE id = ?').run('disabled', id);
        return { data: { id, status: 'disabled' } };
      })
      .post('/endpoints/:id/test', async ({ params: { id } }) => {
        // C4 (2026-09-01): 端点连通性测试——GET {url}/models 探测，持久化健康状态
        const ep = db.prepare("SELECT * FROM ans_model_endpoints WHERE id = ? AND status = 'active'").get(id) as
          | { id: string; url: string; api_key_ref: string }
          | undefined;
        if (!ep) throw notFound('Endpoint', id);
        let apiKey: string;
        try {
          apiKey = decryptApiKey(ep.api_key_ref);
        } catch {
          return {
            data: {
              id,
              success: false,
              latency_ms: 0,
              health_status: 'fail',
              error: 'API Key解密失败（ANS_ENCRYPTION_KEY 已变更），请重新配置端点 API Key',
            },
          };
        }
        const start = Date.now();
        let success = false;
        let errorMsg = '';
        try {
          const r = await fetch(ep.url.replace(/\/$/, '') + '/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5_000),
          });
          success = r.ok;
          if (!success) errorMsg = `HTTP ${r.status}`;
        } catch (e) {
          errorMsg = (e as Error).message || '网络错误';
        }
        const latencyMs = Date.now() - start;
        db.prepare(
          "UPDATE ans_model_endpoints SET health_status = ?, last_latency_ms = ?, health_check_at = datetime('now') WHERE id = ?",
        ).run(success ? 'ok' : 'fail', latencyMs, id);
        const row = db
          .prepare('SELECT health_check_at, health_status, last_latency_ms FROM ans_model_endpoints WHERE id = ?')
          .get(id) as { health_check_at: string; health_status: string; last_latency_ms: number };
        return {
          data: {
            id,
            success,
            latency_ms: latencyMs,
            health_check_at: row.health_check_at,
            health_status: row.health_status,
            last_latency_ms: row.last_latency_ms,
            error: success ? null : errorMsg,
          },
        };
      })

      // 获取供应商的API Key获取指引
      .get('/providers/:id/guide', ({ params: { id } }) => {
        const config = getRecommendedConfig();
        const provider = config.providers.find((p) => p.id === id);
        if (!provider) throw notFound('Provider guide', id);
        return {
          data: {
            provider_id: id,
            name: provider.name,
            base_url: provider.base_url,
            website: provider.website,
            api_key_guide: provider.api_key_guide,
          },
        };
      })
      // 获取推荐模型列表（含供应商信息和端点配置状态）
      .get('/recommended', () => {
        const config = getRecommendedConfig();
        const models = db
          .prepare(
            `
	        SELECT m.*, p.name as provider_name, p.base_url as provider_base_url, p.source as provider_source,
	          (SELECT COUNT(*) FROM ans_model_endpoints e WHERE e.model_id = m.id AND e.status = 'active') as endpoint_count
	        FROM ans_ai_models m
	        JOIN ans_ai_providers p ON m.provider_id = p.id
	        WHERE m.source = 'system' AND m.status != 'disabled'
	        ORDER BY p.name, m.name
	      `,
          )
          .all() as Array<Record<string, unknown>>;
        // 合并JSON中的供应商指引信息
        const enriched = models.map((m) => {
          const providerConfig = config.providers.find((p) => p.id === m.provider_id);
          return {
            ...m,
            provider_website: providerConfig?.website || '',
            api_key_guide: providerConfig?.api_key_guide || null,
            has_endpoint: (m.endpoint_count as number) > 0,
          };
        });
        return { data: enriched, use_cases: config.use_cases };
      })
  );
  // zx_20260924 M6-b: 此处原有一个 `.post('/optimal')`，**已删**——它是 `/api/v1/models/optimal`
  //   的**第二份实现**，而 Elysia 后注册者胜（`index.ts` 里本路由组在前、`hmacApi` 在后）⇒ 它从未被调用。
  //   删它不只是去重：它的回包**缺** `input_price_per_1k`/`output_price_per_1k` 与三级降级链，
  //   留着就是一颗哑雷——谁哪天调了注册顺序，价格与降级链会静默消失且无人报警。
  //   唯一实现在 `routes/optimal-model.ts` 的 `resolveOptimalModel`。
}
