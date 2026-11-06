/**
 * 插件市场翻译服务。
 * 三层回退：Ollama本地→ANS最优AI资源→原文展示。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveChatCompletionsUrl } from '@worker-ant/ans-client';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('plugin-translator');

interface TranslationCache {
  [key: string]: { zhText: string; translatedAt: number; sourceHash: string };
}

/** ANS匹配结果 */
export interface AnsModelResult {
  url: string;
  api_key: string;
  model_name?: string;
}

export class PluginTranslator {
  private cacheFile: string;
  private cache: TranslationCache = {};
  private memCache = new Map<string, string>();
  private ollamaEndpoint: string;
  private ollamaModel: string;
  private ollamaAvailable: boolean | null = null;
  private ollamaCheckTime = 0;
  ansModelFetcher?: () => Promise<AnsModelResult | null>;

  constructor(cacheDir?: string, ansModelFetcher?: () => Promise<AnsModelResult | null>) {
    const dir = cacheDir || resolve(process.cwd(), '../../data/translations');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.cacheFile = resolve(dir, 'plugin-translation-cache.json');
    this.ollamaEndpoint = process.env.OLLAMA_ENDPOINT || 'http://localhost:11434';
    this.ollamaModel = process.env.OLLAMA_TRANSLATE_MODEL || 'qwen2.5:3b';
    this.ansModelFetcher = ansModelFetcher;
    this.loadCache();
  }

  /** 批量翻译插件摘要 */
  async translateBatch(
    items: Array<{ id: string; name: string; description: string; language?: string; description_zh?: string | null }>,
  ): Promise<void> {
    const needs = items.filter((i) => i.language !== 'zh' && !i.description_zh && i.description);
    if (needs.length === 0) return;
    for (const item of needs) {
      const key = `plugin:${item.id}:summary`;
      const cached = this.getCached(key, item.description);
      if (cached) {
        item.description_zh = cached;
        continue;
      }
      try {
        const zh = await this.translateTextInternal(item.description, `插件: ${item.name}`);
        if (zh) {
          item.description_zh = zh;
          this.setCache(key, item.description, zh);
        }
      } catch {
        /* skip */
      }
    }
  }

  /** 翻译长文本（公开，供API调用） */
  async translateLongText(text: string): Promise<string> {
    const zh = await this.translateTextInternal(text);
    return zh || text;
  }

  private async translateTextInternal(text: string, context?: string): Promise<string | null> {
    // Tier 1: Ollama 本地模型（免费、低延迟）
    const ollamaOk = await this.isOllamaAvailable();
    if (ollamaOk) {
      try {
        const prompt = context ? `${context}\n\n${text}` : text;
        const resp = await fetch(`${this.ollamaEndpoint}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.ollamaModel,
            prompt: `你是一个专业的技术文档翻译助手。请将以下内容翻译为简体中文，保持技术术语准确，保留 markdown 格式。只输出翻译结果。\n\n${prompt}`,
            stream: false,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (resp.ok) {
          const data = (await resp.json()) as { response?: string };
          if (data.response?.trim()) return data.response.trim();
        }
      } catch {
        /* Tier 1 failed */
      }
    }

    // Tier 2: ANS最优AI资源（通过ANS匹配引擎获取，不硬编码任何模型或API Key）
    if (this.ansModelFetcher) {
      try {
        const model = await this.ansModelFetcher();
        if (model?.url && model?.api_key) {
          const resp = await fetch(resolveChatCompletionsUrl(model.url), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${model.api_key}` },
            body: JSON.stringify({
              model: model.model_name || 'gpt-4o-mini',
              messages: [
                {
                  role: 'system',
                  content: '你是一个技术文档翻译助手，将用户输入翻译为简体中文，保持术语准确，只输出翻译结果。',
                },
                { role: 'user', content: text },
              ],
              temperature: 0.1,
              max_tokens: 2000,
            }),
            signal: AbortSignal.timeout(20_000),
          });
          if (resp.ok) {
            const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
            const zh = data.choices?.[0]?.message?.content?.trim();
            if (zh) return zh;
          }
        }
      } catch {
        /* Tier 2 failed */
      }
    }

    return null; // Tier 3: 原文展示
  }

  private async isOllamaAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.ollamaAvailable !== null && now - this.ollamaCheckTime < 60_000) return this.ollamaAvailable;
    try {
      const resp = await fetch(`${this.ollamaEndpoint}/api/tags`, { signal: AbortSignal.timeout(5000) });
      this.ollamaAvailable = resp.ok;
    } catch {
      this.ollamaAvailable = false;
    }
    this.ollamaCheckTime = now;
    return this.ollamaAvailable;
  }

  private loadCache(): void {
    try {
      if (existsSync(this.cacheFile)) this.cache = JSON.parse(readFileSync(this.cacheFile, 'utf-8'));
    } catch {
      this.cache = {};
    }
  }
  private saveCache(): void {
    try {
      writeFileSync(this.cacheFile, JSON.stringify(this.cache));
    } catch {}
  }
  private hash(text: string): string {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (h << 5) - h + text.charCodeAt(i);
      h |= 0;
    }
    return h.toString(36);
  }
  private getCached(key: string, sourceText: string): string | undefined {
    if (this.memCache.has(key)) return this.memCache.get(key);
    const entry = this.cache[key];
    if (entry && entry.sourceHash === this.hash(sourceText)) {
      this.memCache.set(key, entry.zhText);
      return entry.zhText;
    }
    return undefined;
  }
  private setCache(key: string, sourceText: string, zhText: string): void {
    this.cache[key] = { zhText, translatedAt: Date.now(), sourceHash: this.hash(sourceText) };
    if (this.memCache.size > 500) {
      const first = this.memCache.keys().next().value;
      if (first) this.memCache.delete(first);
    }
    this.memCache.set(key, zhText);
    this.saveCache();
  }
}

/** ANS模型获取器工厂——通过ANS内部匹配引擎获取最优翻译模型 */
export function createAnsModelFetcher(
  matchOptimal: (
    capabilities: string[],
    strategy?: string,
  ) => {
    url: string;
    api_key_ref: string;
    model_name: string;
    max_output_tokens: number;
    context_window: number;
  } | null,
  decryptKey: (ref: string) => string,
): () => Promise<AnsModelResult | null> {
  return async () => {
    try {
      // 优先匹配翻译专项模型，无则回退chat
      let result = matchOptimal(['translation'], 'balanced' as string);
      if (!result) result = matchOptimal(['chat'], 'balanced' as string);
      if (!result) return null;
      return { url: result.url, api_key: decryptKey(result.api_key_ref), model_name: result.model_name };
    } catch {
      return null;
    }
  };
}

export const pluginTranslator = new PluginTranslator();
