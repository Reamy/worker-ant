/**
 * MCP协议端点 — 将ANS注册的资源和能力暴露为标准MCP JSON-RPC 2.0接口。
 * 协议版本: 2024-11-05 (MCP spec)，使用@modelcontextprotocol/sdk标准schema格式。
 */
import { Elysia, t } from 'elysia';
import type Database from 'better-sqlite3';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { resolveChatCompletionsUrl } from '@worker-ant/ans-client';
import { decryptApiKey } from '../utils/security.js';
import { matchOptimalModel } from '../services/resource-matcher.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('mcp-proxy');

export function mcpProxyRoutes(db: Database.Database) {
  return (
    new Elysia({ prefix: '/mcp' })

      // MCP JSON-RPC端点（/mcp/message）
      .post(
        '/message',
        async ({ body, set }) => {
          const req = body as {
            jsonrpc: string;
            id?: number | string;
            method: string;
            params?: Record<string, unknown>;
          };

          if (req.jsonrpc !== '2.0') {
            set.status = 400;
            return {
              jsonrpc: '2.0',
              id: req.id ?? null,
              error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
            };
          }

          const id = req.id ?? null;

          try {
            switch (req.method) {
              case 'initialize':
                return handleInitialize(id);

              case 'notifications/initialized':
                return {}; // No response for notifications per JSON-RPC spec

              case 'tools/list':
                return { jsonrpc: '2.0', id, result: { tools: getMcpTools() } };

              case 'tools/call': {
                const params = req.params as { name?: string; arguments?: Record<string, unknown> };
                if (!params?.name) {
                  return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing tool name' } };
                }
                const result = await handleToolCall(params.name, params.arguments || {}, db);
                return { jsonrpc: '2.0', id, result };
              }

              case 'resources/list': {
                const resources = db
                  .prepare("SELECT id, name, endpoint FROM ans_mcp_servers WHERE status = 'active'")
                  .all() as Array<Record<string, unknown>>;
                return {
                  jsonrpc: '2.0',
                  id,
                  result: {
                    resources: resources.map((r) => ({
                      uri: `ans:mcp:${r.name}`,
                      name: r.name,
                      description: `MCP server: ${r.name}`,
                      mimeType: 'application/json',
                    })),
                  },
                };
              }

              case 'ping':
                return { jsonrpc: '2.0', id, result: {} };

              default:
                set.status = 404;
                return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } };
            }
          } catch (e) {
            logger.error({ err: e, method: req.method }, 'MCP message handler error');
            set.status = 500;
            return { jsonrpc: '2.0', id, error: { code: -32000, message: (e as Error).message } };
          }
        },
        {
          body: t.Object({
            jsonrpc: t.String(),
            id: t.Optional(t.Union([t.Number(), t.String()])),
            method: t.String(),
            params: t.Optional(t.Record(t.String(), t.Unknown())),
          }),
        },
      )
  );
}

function handleInitialize(id: number | string | null) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {
        tools: {},
        resources: {},
      },
      serverInfo: {
        name: 'ans-mcp-server',
        version: '0.2.0',
      },
      instructions:
        'ANS (AI Network Service) MCP Server — provides tools for discovering AI models, skills, MCP servers, and routing AI chat through the ANS gateway.',
    },
  };
}

/** MCP tool definitions in standard MCP schema format */
function getMcpTools() {
  return [
    {
      name: 'ans_list_models',
      description: '查询ANS注册中心所有活跃AI模型及其能力、价格信息',
      inputSchema: {
        type: 'object' as const,
        properties: {
          capability: {
            type: 'string' as const,
            description: '按能力筛选：chat, embedding, vision, function-calling',
          },
        },
      },
    },
    {
      name: 'ans_list_skills',
      description: '获取ANS注册中心所有活跃技能',
      inputSchema: {
        type: 'object' as const,
        properties: {
          tag: {
            type: 'string' as const,
            description: '按标签筛选技能',
          },
        },
      },
    },
    {
      name: 'ans_list_mcp_servers',
      description: '获取ANS注册中心所有活跃MCP服务端点列表',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'ans_chat',
      description: '通过ANS Gateway智能路由调用最优AI模型进行对话',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message: { type: 'string' as const, description: '对话消息内容' },
          strategy: {
            type: 'string' as const,
            enum: ['cost-optimal', 'latency-optimal', 'capability-best', 'balanced'],
            description: '模型匹配策略',
          },
        },
        required: ['message'],
      },
    },
  ];
}

async function handleToolCall(name: string, args: Record<string, unknown>, db: Database.Database) {
  switch (name) {
    case 'ans_list_models': {
      const cap = args.capability as string | undefined;
      const rows = cap
        ? db
            .prepare(
              "SELECT id, name, provider_id, capabilities, context_window, max_output_tokens, input_price_per_1k, output_price_per_1k FROM ans_ai_models WHERE status = 'active' AND capabilities LIKE ?",
            )
            .all(`%${cap}%`)
        : db
            .prepare(
              "SELECT id, name, provider_id, capabilities, context_window, max_output_tokens, input_price_per_1k, output_price_per_1k FROM ans_ai_models WHERE status = 'active'",
            )
            .all();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }],
      };
    }
    case 'ans_list_skills': {
      const tag = args.tag as string | undefined;
      const rows = tag
        ? db
            .prepare("SELECT id, name, description, tags FROM ans_skills WHERE status = 'active' AND tags LIKE ?")
            .all(`%${tag}%`)
        : db.prepare("SELECT id, name, description, tags FROM ans_skills WHERE status = 'active'").all();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }],
      };
    }
    case 'ans_list_mcp_servers': {
      const rows = db
        .prepare("SELECT id, name, endpoint, transport FROM ans_mcp_servers WHERE status = 'active'")
        .all();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }],
      };
    }
    case 'ans_chat': {
      const message = args.message as string;
      if (!message) throw new Error('message is required');
      const matched = matchOptimalModel(db, {
        capabilities: ['chat'],
        strategy: (args.strategy as 'cost-optimal' | 'balanced') || 'balanced',
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
      return {
        content: [{ type: 'text' as const, text: choice?.message?.content || '' }],
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
