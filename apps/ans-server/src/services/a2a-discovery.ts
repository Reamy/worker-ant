/**
 * A2A Agent Card 自动发现服务。
 * 注册A2A服务器时自动拉取解析Agent Card，提取能力/技能/输入输出模式。
 */
import { createLogger } from '../utils/logger.js';

const logger = createLogger('a2a-discovery');

export interface AgentCard {
  name: string;
  description?: string;
  version?: string;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  skills?: Array<{
    id: string;
    name: string;
    description?: string;
    tags?: string[];
    examples?: string[];
    inputModes?: string[];
    outputModes?: string[];
  }>;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  url?: string;
}

export interface DiscoveryResult {
  success: boolean;
  agentCard?: AgentCard;
  capabilities: string[];
  skillNames: string[];
  inputModes: string[];
  outputModes: string[];
  error?: string;
}

/**
 * 从agent_card_url拉取并解析Agent Card。
 * A2A协议规范：GET {agent_card_url} 返回JSON格式的Agent Card。
 */
export async function discoverAgentCard(agentCardUrl: string): Promise<DiscoveryResult> {
  try {
    const resp = await fetch(agentCardUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      return {
        success: false,
        capabilities: [],
        skillNames: [],
        inputModes: [],
        outputModes: [],
        error: `HTTP ${resp.status}: ${resp.statusText}`,
      };
    }

    const card = (await resp.json()) as AgentCard;

    // 提取能力列表
    const capabilities: string[] = [];
    if (card.capabilities?.streaming) capabilities.push('streaming');
    if (card.capabilities?.pushNotifications) capabilities.push('pushNotifications');
    if (card.capabilities?.stateTransitionHistory) capabilities.push('stateTransitionHistory');

    // 从skills提取能力标签
    const skillNames = card.skills?.map((s) => s.name || s.id) ?? [];
    const skillTags = card.skills?.flatMap((s) => s.tags ?? []) ?? [];
    const allCapabilities = [...new Set([...capabilities, ...skillNames, ...skillTags])];

    const inputModes = card.defaultInputModes ?? ['text'];
    const outputModes = card.defaultOutputModes ?? ['text'];

    logger.info({ url: agentCardUrl, name: card.name, skillCount: skillNames.length }, 'Agent Card discovered');

    return {
      success: true,
      agentCard: card,
      capabilities: allCapabilities,
      skillNames,
      inputModes,
      outputModes,
    };
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn({ url: agentCardUrl, err: msg }, 'Agent Card discovery failed');
    return { success: false, capabilities: [], skillNames: [], inputModes: [], outputModes: [], error: msg };
  }
}

/**
 * 从预定义的/.well-known/agent.json路径尝试发现Agent Card。
 */
export function getAgentCardUrl(baseUrlOrPath: string): string {
  if (baseUrlOrPath.endsWith('/.well-known/agent.json')) return baseUrlOrPath;
  if (baseUrlOrPath.endsWith('/agent-card.json')) return baseUrlOrPath;
  if (baseUrlOrPath.endsWith('/agent.json')) return baseUrlOrPath;

  const base = baseUrlOrPath.replace(/\/$/, '');
  return `${base}/.well-known/agent.json`;
}
