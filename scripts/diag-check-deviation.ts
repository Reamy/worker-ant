/**
 * 诊断脚本：验证 checkGoalDeviation 的 prompt 在 reasoning 修复后正常返回（deviated 判断）。
 * 复现其完整调用：getOptimalModel(排除reasoning) → generateText → JSON 解析。
 */
import { AnsClient } from '@worker-ant/ans-client';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { ANS_DEFAULT_BASE_URL } from '../packages/shared-types/src/ans-defaults.js';

const GOAL = '完成认证模块重构，通过全部回归测试并验证向后兼容';
const RECENT = '我刚刚在查阅项目的 README 文档，了解项目结构，准备开始浏览各个子目录的文件布局。';

async function main(): Promise<void> {
  const ans = new AnsClient({ serverUrl: ANS_DEFAULT_BASE_URL, apiKey: 'dev-key', secretKey: 'dev-secret' });
  const m = await ans.getOptimalModel({ capabilities: ['chat'], strategy: 'cost-optimal', excludeCapabilities: ['reasoning'] }) as { url?: string; api_key?: string; model_name?: string; max_output_tokens?: number } | undefined;
  if (!m?.url || !m?.api_key || !m?.model_name) { console.log('❌ 无模型'); return; }
  console.log('模型:', m.model_name, '| max_output_tokens:', m.max_output_tokens);

  const provider = createOpenAI({ apiKey: m.api_key, baseURL: m.url });
  const result = await generateText({
    model: provider.chat(m.model_name),
    temperature: 0.1,
    maxTokens: m.max_output_tokens || 4096,
    prompt: `以下是工蚁系统一个任务的「核心目标」与「最近执行进展」。请判断进展是否明显偏离核心目标。\n\n核心目标：${GOAL}\n\n最近进展：\n${RECENT.slice(0, 600)}\n\n输出 JSON：{"deviated": true/false, "reason": "偏离说明，未偏离则为空字符串"}。简洁中文。`,
  });
  const text = result.text || '';
  const finishReason = (result as { finishReason?: string }).finishReason;
  console.log(`finishReason=${finishReason} | text长度=${text.length}`);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('✅ JSON 解析成功:', JSON.stringify(parsed));
    } catch (e) { console.log('❌ JSON 解析失败:', (e as Error).message, '\n原文:', text.slice(0, 200)); }
  } else { console.log('❌ 无 JSON，原文:', text.slice(0, 200)); }
}

main();
