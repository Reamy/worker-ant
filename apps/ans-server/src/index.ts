import { loadEnvFile } from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
// 仓库根 .env 可选：干净 clone 无 .env（.gitignore 排除）也须能起——缺失时静默跳过，
//   由各变量的既存兜底接管（端口→ANS_DEFAULT_PORT；加密键→随机；API 键→库内 key）。
//   `loadEnvFile` 对不存在的路径直接抛 ENOENT，故先判在否（否则干净机 `pnpm dev:ans` 必崩）。
if (existsSync('../../.env')) loadEnvFile('../../.env');
process.setMaxListeners(30); // tsx watch 累积 exit 监听器

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { node } from '@elysiajs/node';
import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { initDatabase } from './db/schema.js';
import { createLogger } from './utils/logger.js';
import { RateLimiter } from './utils/rate-limiter.js';
import { hmacAuth } from './utils/security.js';
import { healthRoutes } from './routes/health.js';
import { modelsRoutes } from './routes/models.js';
import { skillsRoutes } from './routes/skills.js';
import { mcpRoutes } from './routes/mcp.js';
import { a2aRoutes } from './routes/a2a.js';
import { mcpProxyRoutes } from './routes/mcp-proxy.js';
import { mcpGatewayRoutes } from './routes/mcp-gateway.js';
import { a2aProxyRoutes, a2aAgentCardRoute } from './routes/a2a-proxy.js';
import { billingRoutes } from './routes/billing.js';
import { gatewayRoutes } from './routes/gateway.js';
import { authRoutes } from './routes/auth.js';
import { nodeEnrollRoute, nodesRoutes } from './routes/nodes.js';
import {
  pluginMarketplaceRoutes,
  refreshAllMarketplaces,
  recoverInstalledPlugins,
} from './routes/plugin-marketplace.js';
import { recordMarketplaceRefreshError } from './services/marketplace-source.js';
import { refreshUrlMarketplace } from './services/marketplace-adapters.js';
import { pluginTranslator, createAnsModelFetcher } from './services/plugin-translator.js';
import { matchOptimalModel, type MatchStrategy } from './services/resource-matcher.js';
import { resolveOptimalModel } from './routes/optimal-model.js';
import { startHealthCheckScheduler } from './services/health-check-scheduler.js';
import { decryptApiKey, getResourceGroupsFromApiKey } from './utils/security.js';
import { handleRouteError } from './utils/error-handler.js';
import { t } from 'elysia';
// zx_20261005 M21: ANS 默认端口**单一真源**（改端口只改 shared-types 一处）。
import { ANS_DEFAULT_PORT } from '@worker-ant/shared-types';

const logger = createLogger('ans-server');

const db = initDatabase();
logger.info('数据库已初始化');

// 启动时自动注册推荐AI资源（source='system'，与用户自建数据隔离）
function seedRecommendedModels(): void {
  try {
    const configPath = resolve(dirname(fileURLToPath(import.meta.url)), 'data/recommended-models.json');
    if (!existsSync(configPath)) {
      logger.warn('推荐模型配置文件不存在，跳过自动注册');
      return;
    }
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    let newProviders = 0,
      newModels = 0;
    for (const p of config.providers) {
      const result = db
        .prepare('INSERT OR IGNORE INTO ans_ai_providers (id, name, base_url, status, source) VALUES (?, ?, ?, ?, ?)')
        .run(p.id, p.name, p.base_url || '', 'active', 'system');
      if (result.changes > 0) newProviders++;
    }
    for (const m of config.models) {
      const result = db
        .prepare(
          'INSERT OR IGNORE INTO ans_ai_models (id, provider_id, name, capabilities, context_window, max_output_tokens, input_price_per_1k, output_price_per_1k, status, source, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          m.id,
          m.provider_id,
          m.name,
          JSON.stringify(m.capabilities),
          m.context_window,
          m.max_output_tokens,
          m.input_price_per_1k,
          m.output_price_per_1k,
          'active',
          'system',
          m.description || '',
        );
      if (result.changes > 0) newModels++;
    }
    if (newProviders > 0 || newModels > 0) logger.info({ newProviders, newModels }, '推荐AI资源已注册');
    else logger.info('推荐AI资源已是最新，无需更新');
  } catch (err) {
    logger.error({ err }, '推荐模型自动注册失败');
  }
}
seedRecommendedModels();

// 启动时自动注册推荐插件市场源
function seedRecommendedMarketplaces(): void {
  try {
    const configPath = resolve(dirname(fileURLToPath(import.meta.url)), 'data/recommended-marketplaces.json');
    if (!existsSync(configPath)) {
      logger.warn('推荐市场配置文件不存在，跳过自动注册');
      return;
    }
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    let newCount = 0;
    for (const m of config.marketplaces) {
      const existing = db.prepare('SELECT id FROM ans_plugin_marketplaces WHERE name = ?').get(m.name) as
        | { id: string }
        | undefined;
      if (!existing) {
        db.prepare(
          'INSERT INTO ans_plugin_marketplaces (id, name, source_type, source_url, status, auto_refresh) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(
          randomUUID(),
          m.name,
          m.source_type,
          m.source_url,
          'active',
          (m as Record<string, unknown>).auto_refresh ?? 0,
        );
        newCount++;
      }
    }
    if (newCount > 0) logger.info({ newCount }, '推荐插件市场已注册');
  } catch (err) {
    logger.error({ err }, '推荐市场自动注册失败');
  }
}
// 修正已有mcp-registry类型(url→github)
try {
  db.prepare(
    "UPDATE ans_plugin_marketplaces SET source_type = 'github', source_url = 'https://github.com/modelcontextprotocol/servers' WHERE name = 'mcp-registry' AND source_type = 'url'",
  ).run();
} catch {}
seedRecommendedMarketplaces();

// 借鉴OpenClaw+claude-code: 启动时从文件系统恢复已安装插件
const recoveredCount = recoverInstalledPlugins(db);
if (recoveredCount > 0) logger.info({ recoveredCount }, '已从文件系统恢复已安装插件');

// AS5: 启动时验证加密密钥，不要等到首次API调用才发现格式错误
import('./utils/security.js').then((m) => {
  try {
    m.getEncryptionKey();
    logger.info('加密密钥验证通过');
  } catch (e) {
    logger.error({ err: e }, '加密密钥验证失败');
  }
});

const rateLimiter = new RateLimiter({ windowMs: 60_000, maxRequests: 60 });

// HMAC保护的内部API路由组（ans-client调用的网关/代理/计费/optimal）
const hmacApi = new Elysia()
  .use(hmacAuth(db))
  .use(mcpProxyRoutes(db))
  .use(a2aProxyRoutes(db))
  .use(billingRoutes(db))
  .use(gatewayRoutes(db))
  // zx_20261004 M1：节点心跳/列表/改档/令牌台（HMAC）。注册端点走令牌闸，挂在下面公开组。
  .use(nodesRoutes(db))
  // AS2: /models/optimal需要HMAC认证（返回解密后的API密钥）
  // zx_20260924 M6-b: 此处只留**薄壳**——取资源组（要 `request`，故只能在这层做）+ 挂 HMAC，
  //   选型与回包全在 `routes/optimal-model.ts` 的 `resolveOptimalModel` 一处。
  //   原先这里内联着一整份实现，与 `routes/models.ts` 的 `.post('/optimal')` 是**同名路径的两份**，
  //   而 Elysia 后注册者胜 ⇒ 谁活看注册顺序（此处活）。两份的回包形状并不相同（价格/降级链只有这份有），
  //   故"顺序"这个与业务无关的事实会静默决定调用方拿不拿得到价格。抽走即除根。
  .post(
    '/api/v1/models/optimal',
    ({ body, request }) => resolveOptimalModel(db, body, getResourceGroupsFromApiKey(db, request)),
    {
      body: t.Object({
        strategy: t.Optional(t.String()),
        capabilities: t.Optional(t.Array(t.String())),
        maxCostPer1k: t.Optional(t.Number()),
        preferredProvider: t.Optional(t.String()),
        excludeCapabilities: t.Optional(t.Array(t.String())),
      }),
    },
  );

// FIX-1: 资源管理CRUD路由加HMAC认证（原为公开，安全加固）
// zx_20260930 M15-②: **API Key 管理**（`/api/v1/auth/api-keys`）也并入本组。
//   此前那句话写着「自包含认证」而代码里**零认证**——任何人可列举/新建/吊销 API Key（含签发新钥匙）。
//   并入安全：真验签已在 M9 落地（`hmacAuth` 校验 `x-signature`），桌面侧 `AnsClient` 每次请求都签名
//   （`packages/ans-client/src/client.ts` 的 `createHmacSignature`）⇒ 桌面 `ApiKeysPage` 照常工作；
//   全仓 HTTP 消费点仅此一处（已核：其余命中都在 `apps/_archive/`）。
const hmacManagement = new Elysia()
  .use(hmacAuth(db))
  .use(modelsRoutes(db))
  .use(skillsRoutes(db))
  .use(mcpRoutes(db))
  .use(a2aRoutes(db))
  .use(pluginMarketplaceRoutes(db))
  .use(authRoutes(db));

const app = new Elysia({ adapter: node() })
  .use(cors())
  .use(swagger({ path: '/docs', documentation: { info: { title: 'ANS Server API', version: '0.1.0' } } }))
  // zx_20260930 M15-④: **全局错误处置**——`formatErrorResponse` 此前**零调用方**，
  //   于是每个路由各自决定错误长什么样（`a2a-proxy` 直接把上游 `Error.message` 回给调用方）。
  //   接线抽到 `utils/error-handler.ts`（一处），判据挂**同一个回调** ⇒ 测的是生产那一跳。
  .onError(handleRouteError)
  // 全局速率限制
  .derive(({ request }) => {
    const apiKey = request.headers.get('x-api-key');
    const ip = request.headers.get('x-forwarded-for') ?? '127.0.0.1';
    const key = rateLimiter.getKey(apiKey, ip);
    rateLimiter.check(key);
    return {};
  })
  // 公开路由（无需HMAC认证）
  .use(mcpGatewayRoutes(db)) // MCP标准端点（供Claude Desktop等标准客户端连接）
  .use(a2aAgentCardRoute()) // A2A Agent Card发现（A2A协议标准）
  .use(healthRoutes()) // 健康检查
  // zx_20261004 M1：节点**自助注册**（令牌闸，非 HMAC——此刻桌面还没有 key）
  .use(nodeEnrollRoute(db))
  // HMAC保护的资源管理CRUD（模型/技能/MCP/A2A）
  .use(hmacManagement)
  // HMAC保护的内部API（网关/代理/计费/optimal）
  .use(hmacApi);

// zx_20261005 M21（毛选·不打无准备之仗 / 管子·度量衡一处）：端口**单源**取 `ANS_DEFAULT_PORT`，
//   `ANS_SERVER_PORT` 仅作显式逃生口。默认 3001 撞口太常见（Node/框架最常用口之一），
//   商业化"快速上手"第一跳即卡在此。
//
// ⚠ 绑定失败**不能**靠 `try { app.listen(...) } catch` 抓：`@elysiajs/node` 底层 srvx 的
//   `serve()` 把 listen 错误 `.catch(() => {})` 吞掉（且 `silent:true` 连一行日志都不留）——
//   端口被占时进程照常往下走、还打一句"已启动"，用户看到的是一句**谎**。故此处从 listen 回调
//   取回 srvx Server 并 `await ready()`：真实绑定结果**在此浮现**，失败即如实报因 + 退非 0。
const ansPort = Number(process.env.ANS_SERVER_PORT ?? ANS_DEFAULT_PORT);
let ansSrv: { ready?: () => Promise<unknown> } | undefined;
app.listen(ansPort, (info: unknown) => {
  ansSrv = (info as { raw?: { ready?: () => Promise<unknown> } } | undefined)?.raw;
});
try {
  await ansSrv?.ready?.();
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === 'EADDRINUSE') {
    console.error(
      `\n[ANS] 端口 ${ansPort} 已被占用，服务无法启动。\n` +
        `      请改用其它端口后重启，例如：ANS_SERVER_PORT=27184 pnpm dev:ans\n`,
    );
  } else {
    console.error(`\n[ANS] 绑定端口 ${ansPort} 失败：${e?.message ?? String(err)}\n`);
  }
  process.exit(1);
}

logger.info({ port: ansPort }, 'ANS 服务端已启动');

// 8.3: 启动健康检查后台调度器（每5分钟检查MCP/A2A服务）
startHealthCheckScheduler(db);
// 翻译器注入ANS模型获取器（通过ANS匹配引擎选最优翻译模型，不硬编码）
pluginTranslator.ansModelFetcher = createAnsModelFetcher(
  (capabilities, strategy) =>
    matchOptimalModel(db, { capabilities, strategy: strategy as MatchStrategy | undefined }).primary,
  (ref) => decryptApiKey(ref),
);

// 19.1: 服务启动5秒后异步刷新市场（避免git操作阻塞启动），然后每30分钟自动刷新
setTimeout(() => {
  (async () => {
    try {
      const count = await refreshAllMarketplaces(db);
      logger.info({ count }, '首次市场刷新完成');
    } catch (err) {
      logger.error({ err }, '首次市场刷新失败');
    }
    const urlMarkets = db
      .prepare(
        "SELECT id, name, source_url FROM ans_plugin_marketplaces WHERE status = 'active' AND source_type = 'url'",
      )
      .all() as Array<{ id: string; name: string; source_url: string }>;
    for (const m of urlMarkets) {
      // M15-③: 原来这里是静默空 catch——`refreshUrlMarketplace` 抛出的因（上游 404 / 解析失败）
      //   会被吞掉，界面上只看到"刷新了但没变化"。现在写成**失败账**（last_error/last_error_at）。
      try {
        const c = await refreshUrlMarketplace(db, m.id, m.source_url, m.name);
        if (c > 0) logger.info({ name: m.name, count: c }, 'URL市场已同步');
      } catch (err) {
        recordMarketplaceRefreshError(db, m.id, err instanceof Error ? err.message : String(err));
        logger.error({ err, name: m.name }, 'URL市场初始刷新失败');
      }
    }
    logger.info('所有市场初始刷新完成');
  })().catch((err) => logger.error({ err }, '市场初始刷新异常'));
}, 5000);
// M15-③: 定时刷新原来 `.catch(() => {})` —— 循环内的失败已由 `recordMarketplaceRefreshError`
//   逐市场记账，此处兜的是循环外的意外（DB/查询异常）；再静默吞掉就两层都无账了。
setInterval(() => {
  refreshAllMarketplaces(db).catch((err) => logger.error({ err }, '市场定时刷新异常'));
}, 30 * 60_000);
