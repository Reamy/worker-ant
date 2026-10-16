/**
 * A2A (Agent-to-Agent) 协议代理路由。
 * 基于JSON-RPC 2.0 over HTTP，支持Agent发现和完整任务生命周期。
 * 协议参考：A2A Protocol Spec (Google), JSON-RPC 2.0
 */
import { Elysia, t } from 'elysia';
import type Database from 'better-sqlite3';
import { createLogger } from '../utils/logger.js';
import { discoverAgentCard } from '../services/a2a-discovery.js';

const logger = createLogger('a2a-proxy');

/**
 * zx_20260930 M15-①：A2A 任务端点 URL 的**唯一**派生处。
 *
 * 病根：本文件原以 `agent.endpoint || …` 取任务 URL，而 `ans_a2a_servers` **根本没有 `endpoint` 列**
 *   （见 `db/schema.ts` 的建表与迁移块，活库 `PRAGMA table_info` 亦然）⇒ 三处
 *   `SELECT agent_card_url, endpoint` 每调必抛，被外层 catch 兜成 500 —— `send/get/cancel` **恒不可用**。
 * 现状：`agent_card_url` 是唯一可用的真列。三种已知 Agent Card 后缀归一为 `/tasks`；
 *   **裸 base（不含已知后缀）原样返回**——旧行为如此（无后缀可替换），不借"修 bug"顺手改语义。
 *   归一处还顺手消掉一处**既有不一致**：原 `tasks/get`/`tasks/cancel` 少一条 `/agent.json` 的替换。
 */
export function deriveA2aTaskUrl(agentCardUrl: string): string {
  const s = String(agentCardUrl ?? '').trim();
  for (const suffix of ['/.well-known/agent.json', '/agent-card.json', '/agent.json']) {
    if (s.endsWith(suffix)) return s.slice(0, -suffix.length) + '/tasks';
  }
  return s;
}

/**
 * Agent Card 发现端点（公开，无HMAC）。
 * 符合A2A协议：客户端通过GET /.well-known/agent.json发现Agent能力。
 */
export function a2aAgentCardRoute() {
  return new Elysia().get('/a2a/.well-known/agent.json', () => ({
    name: 'ans-agent-router',
    description: 'ANS Agent Router — 智能路由到最优A2A Agent，支持完整任务生命周期管理',
    version: '0.2.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [
      { id: 'ans_chat', name: 'AI Chat', description: 'Route chat to optimal AI model via ANS Gateway' },
      { id: 'ans_discover', name: 'Discover Agents', description: 'Find registered A2A agents and their capabilities' },
      { id: 'ans_task', name: 'Task Management', description: 'Full task lifecycle: send, get status, cancel' },
      // zx_20261004 M11：工蚁**能力卡**占位技能——公开卡声明"本 ANS 后面挂着一群工蚁节点，
      //   其类目级能力见 `GET /api/v1/nodes` 的 `card` 字段"。**不动既有三技能**（只增不改）。
      {
        id: 'ans_nodes',
        name: 'Worker Ant Nodes',
        description:
          'Discover worker-ant nodes and their category-level capabilities (text/code/research/media/device/project_task); submit category-level requests via ANS relay queue',
      },
    ],
  }));
}

export function a2aProxyRoutes(db: Database.Database) {
  return (
    new Elysia({ prefix: '/a2a' })

      // A2A JSON-RPC 任务端点 — 完整生命周期
      .post(
        '/tasks',
        async ({ body, set }) => {
          const req = body as {
            jsonrpc: string;
            id: number | string;
            method: string;
            params?: Record<string, unknown>;
          };

          if (req.jsonrpc !== '2.0') {
            set.status = 400;
            return {
              jsonrpc: '2.0',
              id: req.id,
              error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
            };
          }

          try {
            switch (req.method) {
              case 'tasks/list': {
                const agents = db
                  .prepare(
                    "SELECT id, name, agent_card_url, capabilities, status FROM ans_a2a_servers WHERE status = 'active'",
                  )
                  .all() as Array<Record<string, unknown>>;
                return {
                  jsonrpc: '2.0',
                  id: req.id,
                  result: {
                    agents: agents.map((a) => ({
                      id: a.id,
                      name: a.name,
                      capabilities: safeJsonParse(a.capabilities),
                    })),
                  },
                };
              }

              case 'tasks/send': {
                const params = req.params as {
                  id?: string;
                  message?: { parts?: Array<{ text?: string; type?: string }> };
                  metadata?: Record<string, unknown>;
                };
                if (!params?.id) {
                  return { jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'Missing agent id' } };
                }

                const agent = db
                  .prepare("SELECT agent_card_url FROM ans_a2a_servers WHERE id = ? AND status = 'active'")
                  .get(params.id) as { agent_card_url: string } | undefined;

                if (!agent) {
                  return {
                    jsonrpc: '2.0',
                    id: req.id,
                    error: { code: -32000, message: `Agent not found: ${params.id}` },
                  };
                }

                // M15-①: 从 agent_card_url 派生（无 `endpoint` 列，见 deriveA2aTaskUrl 注记）
                const taskUrl = deriveA2aTaskUrl(agent.agent_card_url);

                try {
                  const resp = await fetch(taskUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      jsonrpc: '2.0',
                      method: 'tasks/send',
                      params: { message: params.message, metadata: params.metadata },
                    }),
                    signal: AbortSignal.timeout(60_000),
                  });
                  const result = await resp.json();
                  return { jsonrpc: '2.0', id: req.id, result };
                } catch (e) {
                  // M15-④: 上游细节只进日志，不进响应体
                  logger.warn({ err: e, taskUrl }, 'A2A tasks/send 上游调用失败');
                  throw new Error('Upstream agent call failed');
                }
              }

              case 'tasks/get': {
                const params = req.params as { id?: string; taskId?: string };
                if (!params?.id || !params?.taskId) {
                  return {
                    jsonrpc: '2.0',
                    id: req.id,
                    error: { code: -32602, message: 'Missing id (agent id) or taskId' },
                  };
                }

                const agent = db
                  .prepare("SELECT agent_card_url FROM ans_a2a_servers WHERE id = ? AND status = 'active'")
                  .get(params.id) as { agent_card_url: string } | undefined;

                if (!agent) {
                  return {
                    jsonrpc: '2.0',
                    id: req.id,
                    error: { code: -32000, message: `Agent not found: ${params.id}` },
                  };
                }

                // M15-①: 与 send/cancel **同一把尺**（原此处少一条 `/agent.json` 替换）
                const taskUrl = deriveA2aTaskUrl(agent.agent_card_url);

                try {
                  const resp = await fetch(taskUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      jsonrpc: '2.0',
                      method: 'tasks/get',
                      params: { id: params.taskId },
                    }),
                    signal: AbortSignal.timeout(30_000),
                  });
                  const result = await resp.json();
                  return { jsonrpc: '2.0', id: req.id, result };
                } catch (e) {
                  // M15-④: 上游细节只进日志，**不进响应体**（原样回传＝把内网 URL 送给调用方）
                  logger.warn({ err: e, taskUrl }, 'A2A tasks/get 上游调用失败');
                  throw new Error('Upstream agent call failed');
                }
              }

              case 'tasks/cancel': {
                const params = req.params as { id?: string; taskId?: string };
                if (!params?.id || !params?.taskId) {
                  return {
                    jsonrpc: '2.0',
                    id: req.id,
                    error: { code: -32602, message: 'Missing id (agent id) or taskId' },
                  };
                }

                const agent = db
                  .prepare("SELECT agent_card_url FROM ans_a2a_servers WHERE id = ? AND status = 'active'")
                  .get(params.id) as { agent_card_url: string } | undefined;

                if (!agent) {
                  return {
                    jsonrpc: '2.0',
                    id: req.id,
                    error: { code: -32000, message: `Agent not found: ${params.id}` },
                  };
                }

                // M15-①: 与 send/get **同一把尺**
                const taskUrl = deriveA2aTaskUrl(agent.agent_card_url);

                try {
                  const resp = await fetch(taskUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      jsonrpc: '2.0',
                      method: 'tasks/cancel',
                      params: { id: params.taskId },
                    }),
                    signal: AbortSignal.timeout(30_000),
                  });
                  const result = await resp.json();
                  return { jsonrpc: '2.0', id: req.id, result };
                } catch (e) {
                  // M15-④: 上游细节只进日志，不进响应体
                  logger.warn({ err: e, taskUrl }, 'A2A tasks/cancel 上游调用失败');
                  throw new Error('Upstream agent call failed');
                }
              }

              // Agent Card 刷新 — 手动触发重新发现
              case 'agent/refresh': {
                const params = req.params as { id?: string };
                if (!params?.id) {
                  return { jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'Missing agent id' } };
                }

                const agent = db
                  .prepare("SELECT id, agent_card_url FROM ans_a2a_servers WHERE id = ? AND status = 'active'")
                  .get(params.id) as { id: string; agent_card_url: string } | undefined;

                if (!agent) {
                  return {
                    jsonrpc: '2.0',
                    id: req.id,
                    error: { code: -32000, message: `Agent not found: ${params.id}` },
                  };
                }

                const discovery = await discoverAgentCard(agent.agent_card_url);

                if (discovery.success) {
                  db.prepare(
                    "UPDATE ans_a2a_servers SET capabilities = ?, health_check_at = datetime('now') WHERE id = ?",
                  ).run(JSON.stringify(discovery.capabilities), agent.id);
                  return {
                    jsonrpc: '2.0',
                    id: req.id,
                    result: {
                      name: discovery.agentCard?.name,
                      capabilities: discovery.capabilities,
                      skills: discovery.skillNames,
                      inputModes: discovery.inputModes,
                      outputModes: discovery.outputModes,
                    },
                  };
                }
                // M15-④: `discovery.error` 可能是 `connect ECONNREFUSED 127.0.0.1:19952` 这类**内网地址**，
                //   只进日志（`discoverAgentCard` 内已 `logger.warn`），响应体给通用文案。
                return { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'Agent card discovery failed' } };
              }

              default:
                set.status = 404;
                return {
                  jsonrpc: '2.0',
                  id: req.id,
                  error: { code: -32601, message: `Method not found: ${req.method}` },
                };
            }
          } catch (e) {
            logger.error({ err: e, method: req.method }, 'A2A proxy handler error');
            set.status = 500;
            // M15-④: **不回 `(e as Error).message`**——它会把内网 URL / SQL 列名原样交给调用方。
            //   细节在上一行的日志里（有账），响应体只给通用文案。
            return { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'Internal error' } };
          }
        },
        {
          body: t.Object({
            jsonrpc: t.String(),
            id: t.Union([t.Number(), t.String()]),
            method: t.String(),
            params: t.Optional(t.Record(t.String(), t.Unknown())),
          }),
        },
      )
  );
}

function safeJsonParse(val: unknown): unknown {
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return [];
    }
  }
  return val ?? [];
}
