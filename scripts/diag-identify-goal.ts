/**
 * 诊断脚本 v3：验证 excludeCapabilities 修复生效。
 * 1. 不传 excludeCapabilities → 应返回 reasoning 模型（deepseek-v4-pro）
 * 2. 传 excludeCapabilities:['reasoning'] → 应返回非 reasoning 模型（deepseek-v4-flash）
 * 3. 用非 reasoning 模型 + maxTokens(从 m.max_output_tokens) → identifyTaskGoal prompt → 有效 JSON
 */
import { AnsClient } from '@worker-ant/ans-client';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { ANS_DEFAULT_BASE_URL } from '../packages/shared-types/src/ans-defaults.js';

const TITLE = '重构认证模块';
const DESCRIPTION = '重构整个认证模块，涉及多服务协调、数据迁移与回归测试，需要保证向后兼容并处理并发写入的一致性问题';
const PROMPT = `以下是工蚁系统一个待执行任务。请提炼：\n\n任务：${TITLE.slice(0, 200)}\n${DESCRIPTION.slice(0, 400)}\n\n输出 JSON：{"goal": "核心目标一句话（须具体可验证，如「完成N个脚本改造并通过验证」，不可为空或过短）", "success_criteria": "成功标准一句话", "investigate": ["需先调查的关键信息，最多3条，没有则空数组"]}\n\ngoal=要达成什么（志不立天下无可成之事），须具体可验证、不可为空或过短；investigate=执行前需先调查清楚的信息（没有调查就没有发言权）。简洁中文。`;

async function main(): Promise<void> {
  const ans = new AnsClient({ serverUrl: ANS_DEFAULT_BASE_URL, apiKey: 'dev-key', secretKey: 'dev-secret' });

  // 1. 不传 excludeCapabilities
  const m1 = await ans.getOptimalModel({ capabilities: ['chat'], strategy: 'cost-optimal' }) as { url?: string; api_key?: string; model_name?: string } | undefined;
  console.log('[1] 不传 excludeCapabilities →', m1?.model_name);

  // 2. 传 excludeCapabilities:['reasoning']
  const m2 = await ans.getOptimalModel({ capabilities: ['chat'], strategy: 'cost-optimal', excludeCapabilities: ['reasoning'] }) as { url?: string; api_key?: string; model_name?: string; max_output_tokens?: number } | undefined;
  console.log('[2] 传 excludeCapabilities:[\'reasoning\'] →', m2?.model_name, '| max_output_tokens =', m2?.max_output_tokens);

  if (!m2?.url || !m2?.api_key || !m2?.model_name) { console.log('❌ 排除 reasoning 后无模型'); return; }

  // 3. 用非 reasoning 模型 + maxTokens(从 m.max_output_tokens)
  const provider = createOpenAI({ baseURL: m2.url, apiKey: m2.api_key });
  const model = provider.chat(m2.model_name);
  const maxTokens = m2.max_output_tokens || 4096;
  const result = await generateText({ model, temperature: 0.2, maxTokens, prompt: PROMPT });
  const text = result.text || '';
  const finishReason = (result as { finishReason?: string }).finishReason;
  console.log(`[3] generateText finishReason=${finishReason} | text长度=${text.length}`);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('✅ JSON 解析成功:', JSON.stringify(parsed));
    } catch (e) { console.log('❌ JSON 解析失败:', (e as Error).message, '\n原文:', text.slice(0, 200)); }
  } else { console.log('❌ 无 JSON，原文:', text.slice(0, 200)); }
}

main();
