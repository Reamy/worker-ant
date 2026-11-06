import { resolveChatCompletionsUrl } from '@worker-ant/ans-client';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('priorai-gateway');

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatOptions {
  primaryUrl: string;
  primaryKey: string;
  fallbackUrl?: string;
  fallbackKey?: string | null;
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** A3: 模型实际定价(美元/1000 tokens)，从ANS模型表获取 */
  inputPricePer1k?: number;
  outputPricePer1k?: number;
}

export interface ChatResult {
  content: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  cost: number;
  usedFallback: boolean;
}

/**
 * 轻量AI Gateway：支持主/备双路调用，兼容OpenAI API格式。
 */
class PrioraiGateway {
  /**
   * 发送Chat请求，自动在主URL失败时切换备用URL。
   */
  async chat(options: ChatOptions): Promise<ChatResult> {
    const { messages } = options;

    // 合并system消息：如果有多个system消息，合并为一条
    // 确保符合OpenAI API格式要求
    const processedMessages = this.processMessages(messages);

    const body = JSON.stringify({
      model: options.model ?? 'gpt-4o',
      messages: processedMessages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
    });

    const inputPrice = options.inputPricePer1k ?? 0.005;
    const outputPrice = options.outputPricePer1k ?? 0.015;

    // 尝试主URL
    try {
      const result = await this.callProvider(options.primaryUrl, options.primaryKey, body, inputPrice, outputPrice);
      return { ...result, usedFallback: false };
    } catch (error) {
      logger.warn({ error, url: options.primaryUrl }, '主AI端点失败');
    }

    // 尝试备用URL
    if (options.fallbackUrl && options.fallbackKey) {
      try {
        const result = await this.callProvider(options.fallbackUrl, options.fallbackKey, body, inputPrice, outputPrice);
        return { ...result, usedFallback: true };
      } catch (error) {
        logger.error({ error, url: options.fallbackUrl }, '备用AI端点也失败');
        throw new Error('All AI endpoints failed');
      }
    }

    throw new Error('Primary endpoint failed and no fallback configured');
  }

  private async callProvider(
    url: string,
    apiKey: string,
    body: string,
    inputPrice = 0.005,
    outputPrice = 0.015,
  ): Promise<Omit<ChatResult, 'usedFallback'>> {
    const normalizedUrl = resolveChatCompletionsUrl(url);

    const response = await fetch(normalizedUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI provider returned ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const choice = (data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0];
    const usage = data.usage as
      | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      | undefined;

    return {
      content: choice?.message?.content ?? '',
      model: (data.model as string) ?? 'unknown',
      usage: usage
        ? {
            prompt_tokens: usage.prompt_tokens ?? 0,
            completion_tokens: usage.completion_tokens ?? 0,
            total_tokens: usage.total_tokens ?? 0,
          }
        : undefined,
      // A3: 基于模型实际定价(美元/1000 tokens)计算
      cost: ((usage?.prompt_tokens ?? 0) / 1000) * inputPrice + ((usage?.completion_tokens ?? 0) / 1000) * outputPrice,
    };
  }

  /**
   * 预处理消息：合并多个system消息，确保role合法。
   */
  private processMessages(messages: ChatMessage[]): ChatMessage[] {
    const systemContents: string[] = [];
    const nonSystem: ChatMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemContents.push(msg.content);
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        nonSystem.push(msg);
      }
    }

    const result: ChatMessage[] = [];
    if (systemContents.length > 0) {
      result.push({ role: 'system', content: systemContents.join('\n') });
    }
    result.push(...nonSystem);
    return result;
  }
}

export const prioraiGateway = new PrioraiGateway();
