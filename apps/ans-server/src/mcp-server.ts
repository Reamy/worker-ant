/**
 * ANS MCP Server — 标准MCP协议服务器入口。
 * 使用 @modelcontextprotocol/sdk 实现，支持 stdio + streamable-http 双传输模式。
 *
 * 用于外部MCP客户端（如Claude Desktop）连接，暴露ANS资源管理能力。
 *
 * stdio模式（Claude Desktop等）:
 *   node dist/mcp-server.js
 *
 * streamable-http模式（自检/远程客户端）:
 *   MCP_TRANSPORT=streamable-http MCP_PORT=3100 node dist/mcp-server.js
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { resolveChatCompletionsUrl } from '@worker-ant/ans-client';
import { initDatabase } from './db/schema.js';
import { matchOptimalModel } from './services/resource-matcher.js';
import { decryptApiKey } from './utils/security.js';
import { createLogger } from './utils/logger.js';
import { z } from 'zod';

const logger = createLogger('mcp-server');

async function main() {
  const db = initDatabase();
  logger.info('ANS MCP Server 初始化中...');

  const server = new McpServer({
    name: 'ans-mcp-server',
    version: '0.2.0',
  });

  // ---- 工具注册 ----

  server.tool(
    'ans_list_models',
    '查询ANS注册中心所有活跃AI模型及其能力、价格信息',
    {
      capability: z.string().optional().describe('按能力筛选：chat, embedding, vision, function-calling'),
    },
    async ({ capability }) => {
      const rows = capability
        ? db
            .prepare(
              "SELECT id, name, provider_id, capabilities, context_window, max_output_tokens, input_price_per_1k, output_price_per_1k FROM ans_ai_models WHERE status = 'active' AND capabilities LIKE ?",
            )
            .all(`%${capability}%`)
        : db
            .prepare(
              "SELECT id, name, provider_id, capabilities, context_window, max_output_tokens, input_price_per_1k, output_price_per_1k FROM ans_ai_models WHERE status = 'active'",
            )
            .all();
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.tool(
    'ans_list_skills',
    '获取ANS注册中心所有活跃技能',
    {
      tag: z.string().optional().describe('按标签筛选技能'),
    },
    async ({ tag }) => {
      const rows = tag
        ? db
            .prepare("SELECT id, name, description, tags FROM ans_skills WHERE status = 'active' AND tags LIKE ?")
            .all(`%${tag}%`)
        : db.prepare("SELECT id, name, description, tags FROM ans_skills WHERE status = 'active'").all();
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.tool('ans_list_mcp_servers', '获取ANS注册中心所有活跃MCP服务端点列表', {}, async () => {
    const rows = db.prepare("SELECT id, name, endpoint, transport FROM ans_mcp_servers WHERE status = 'active'").all();
    return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
  });

  server.tool('ans_list_a2a_servers', '获取ANS注册中心所有活跃A2A服务端点列表', {}, async () => {
    const rows = db
      .prepare("SELECT id, name, agent_card_url, capabilities FROM ans_a2a_servers WHERE status = 'active'")
      .all();
    return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
  });

  server.tool(
    'ans_chat',
    '通过ANS Gateway智能路由调用最优AI模型进行对话',
    {
      message: z.string().describe('对话消息内容'),
      strategy: z
        .enum(['cost-optimal', 'latency-optimal', 'capability-best', 'balanced'])
        .optional()
        .describe('模型匹配策略'),
    },
    async ({ message, strategy }) => {
      if (!message) throw new Error('message is required');
      const matched = matchOptimalModel(db, {
        capabilities: ['chat'],
        strategy: strategy || 'balanced',
      });
      if (!matched.primary) throw new Error('No AI model available');
      const apiKey = decryptApiKey(matched.primary.api_key_ref);
      const url = resolveChatCompletionsUrl(matched.primary.url);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: matched.primary.model_id || 'gpt-4o',
          messages: [{ role: 'user', content: message }],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!resp.ok) throw new Error(`AI call failed: ${resp.status}`);
      const data = (await resp.json()) as Record<string, unknown>;
      const choice = (data.choices as Array<{ message?: { content?: string } }>)?.at(0);
      return { content: [{ type: 'text' as const, text: choice?.message?.content || '' }] };
    },
  );

  const transport =
    process.env.MCP_TRANSPORT === 'streamable-http' ? await startStreamableHttp(server) : await startStdio(server);

  logger.info({ transport: process.env.MCP_TRANSPORT || 'stdio' }, 'ANS MCP Server 已启动');
  return transport;
}

async function startStdio(server: McpServer): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return transport;
}

async function startStreamableHttp(server: McpServer): Promise<StreamableHTTPServerTransport> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  const httpServer = createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', async () => {
        try {
          const reqObj = JSON.parse(body);
          await transport.handleRequest(req, res, reqObj);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        }
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ANS MCP Server — streamable-http transport');
  });

  const port = parseInt(process.env.MCP_PORT || '3100', 10);
  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  logger.info({ port }, 'MCP streamable-http transport 已启动');

  await server.connect(transport);
  return transport;
}

main().catch((err) => {
  logger.error({ err }, 'MCP Server 启动失败');
  process.exit(1);
});
