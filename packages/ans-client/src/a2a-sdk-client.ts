/**
 * ANS A2A SDK客户端 — 基于JSON-RPC 2.0 over HTTP的即用型A2A客户端。
 * 自动发现最优A2A Agent → 拉取Agent Card → 提供完整任务生命周期操作。
 */
import type { A2ARequirements } from '@worker-ant/shared-types';
import type { AnsClient } from './client.js';

export interface AgentCardInfo {
  name: string;
  description?: string;
  version?: string;
  capabilities?: Record<string, unknown>;
  skills?: Array<{ id: string; name: string; description?: string }>;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

export interface A2ATask {
  id: string;
  status?: string;
  result?: unknown;
  error?: string;
}

export interface A2AClientInstance {
  /** Agent名称 */
  name: string;
  /** Agent Card信息 */
  agentCard: AgentCardInfo;
  /** 发送任务 */
  sendTask(message: string, metadata?: Record<string, unknown>): Promise<A2ATask>;
  /** 查询任务状态 */
  getTask(taskId: string): Promise<A2ATask>;
  /** 取消任务 */
  cancelTask(taskId: string): Promise<A2ATask>;
}

/**
 * 从Agent Card URL推断任务端点URL。
 */
function getTaskEndpoint(agentCardUrl: string): string {
  return agentCardUrl
    .replace('/.well-known/agent.json', '/tasks')
    .replace('/agent-card.json', '/tasks')
    .replace('/agent.json', '/tasks');
}

let requestIdCounter = 1;

async function jsonRpcRequest(url: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const id = requestIdCounter++;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`A2A request failed: ${resp.status} ${resp.statusText}`);
  }

  const result = (await resp.json()) as {
    jsonrpc: string;
    id: number;
    result?: unknown;
    error?: { code: number; message: string };
  };
  if (result.error) {
    throw new Error(`A2A error ${result.error.code}: ${result.error.message}`);
  }
  return result.result;
}

/**
 * 通过ANS客户端获取最优A2A Agent并建立连接。
 * 自动拉取Agent Card获取Agent能力信息。
 */
export async function connectA2AClient(ansClient: AnsClient, req: A2ARequirements): Promise<A2AClientInstance> {
  const server = await ansClient.getOptimalA2A(req);

  // 拉取Agent Card
  let agentCard: AgentCardInfo = { name: server.name };
  try {
    const resp = await fetch(server.agent_card_url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.ok) {
      const card = (await resp.json()) as AgentCardInfo;
      agentCard = {
        name: card.name || server.name,
        description: card.description,
        version: card.version,
        capabilities: card.capabilities,
        skills: card.skills,
        defaultInputModes: card.defaultInputModes,
        defaultOutputModes: card.defaultOutputModes,
      };
    }
  } catch {
    // 拉取Agent Card失败不影响客户端创建，使用基础信息
  }

  const taskEndpoint = getTaskEndpoint(server.agent_card_url);

  return {
    name: server.name,
    agentCard,
    sendTask: async (message: string, metadata?: Record<string, unknown>) => {
      const result = await jsonRpcRequest(taskEndpoint, 'tasks/send', {
        message: { parts: [{ text: message }] },
        metadata,
      });
      return result as A2ATask;
    },
    getTask: async (taskId: string) => {
      const result = await jsonRpcRequest(taskEndpoint, 'tasks/get', { id: taskId });
      return result as A2ATask;
    },
    cancelTask: async (taskId: string) => {
      const result = await jsonRpcRequest(taskEndpoint, 'tasks/cancel', { id: taskId });
      return result as A2ATask;
    },
  };
}
