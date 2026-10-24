import type Database from 'better-sqlite3';
import { Elysia, t } from 'elysia';
import { prioraiGateway, type ChatMessage } from '../services/priorai-gateway.js';
import { matchOptimalModel, type MatchStrategy } from '../services/resource-matcher.js';
import { decryptApiKey, getResourceGroupsFromApiKey } from '../utils/security.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('gateway');
const circuitBreaker = new CircuitBreaker(5, 30_000);

export function gatewayRoutes(db: Database.Database) {
  return new Elysia({ prefix: '/api/v1/gateway' })
    .get('/providers', () => {
      const providers = db.prepare("SELECT id, name, base_url FROM ans_ai_providers WHERE status = 'active'").all();
      return { data: providers };
    })

    .post(
      '/chat',
      async ({ body, set, request }) => {
        const strategy = body.strategy as MatchStrategy | undefined;
        const capabilities = body.capabilities as string[] | undefined;
        const maxCostPer1k = body.maxCostPer1k as number | undefined;
        const preferredProvider = body.preferredProvider as string | undefined;
        // zx_20261022_3 批六: 与 `/models/optimal` **同一把尺**——网关路同样认上下文地板，
        //   不因走 gateway/chat 就让小窗口模型绕过 `minContextWindow`（地板真源 `effectiveContextFloor`）。
        const minContextWindow = body.minContextWindow as number | undefined;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const project_id = body.project_id as string | undefined;
        // 8.1: 从请求提取API Key的资源组
        const resourceGroups = getResourceGroupsFromApiKey(db, request);

        // 1. 匹配最优模型（8.1: 按API Key的资源组过滤）
        const matched = matchOptimalModel(
          db,
          { strategy, capabilities, maxCostPer1k, preferredProvider, minContextWindow },
          resourceGroups,
        );
        if (!matched.primary) {
          set.status = 404;
          return { error: { code: 'NO_MODEL', message: 'No matching model found' } };
        }

        const endpoint = matched.primary;
        const apiKey = decryptApiKey(endpoint.api_key_ref);
        const fallbackEndpoint = matched.fallback;
        const fallbackApiKey = fallbackEndpoint ? decryptApiKey(fallbackEndpoint.api_key_ref) : null;

        logger.info({ model_id: endpoint.model_id, fallback: !!fallbackEndpoint }, '网关调用');

        // 2. 断路器检查
        const cbKey = `gateway-${endpoint.model_id}`;
        circuitBreaker.beforeCall(cbKey);

        // 3. 通过Priorai调用
        try {
          const result = await prioraiGateway.chat({
            primaryUrl: endpoint.url,
            primaryKey: apiKey,
            fallbackUrl: fallbackEndpoint?.url,
            fallbackKey: fallbackApiKey,
            messages: messages as ChatMessage[],
            // A3: 传递模型实际定价
            inputPricePer1k: (endpoint as unknown as Record<string, number>).input_price_per_1k,
            outputPricePer1k: (endpoint as unknown as Record<string, number>).output_price_per_1k,
          });

          circuitBreaker.onSuccess(cbKey);

          // 4. 写入计费记录
          db.prepare(
            'INSERT INTO ans_billing_records (id, endpoint_id, model_id, project_id, tokens_in, tokens_out, cost) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).run(
            randomUUID(),
            endpoint.id,
            endpoint.model_id,
            project_id ?? null,
            result.usage?.prompt_tokens ?? 0,
            result.usage?.completion_tokens ?? 0,
            result.cost ?? 0,
          );

          return { data: result };
        } catch (error) {
          circuitBreaker.onFailure(cbKey);
          logger.error({ error }, '网关调用失败');
          set.status = 502;
          return { error: { code: 'GATEWAY_ERROR', message: (error as Error).message } };
        }
      },
      {
        body: t.Object({
          messages: t.Array(t.Object({ role: t.String(), content: t.String() })),
          strategy: t.Optional(t.String()),
          capabilities: t.Optional(t.Array(t.String())),
          maxCostPer1k: t.Optional(t.Number()),
          preferredProvider: t.Optional(t.String()),
          minContextWindow: t.Optional(t.Number()),
          project_id: t.Optional(t.String()),
        }),
      },
    );
}

function randomUUID() {
  return require('node:crypto').randomUUID() as string;
}
