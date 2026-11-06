/**
 * 诊断脚本：实测 embedText 是否返回有效 embedding 向量（_4 方案的语义匹配/识别依赖它）。
 */
import { AnsClient } from '@worker-ant/ans-client';
import { ANS_DEFAULT_BASE_URL } from '../packages/shared-types/src/ans-defaults.js';

async function main(): Promise<void> {
  const ans = new AnsClient({ serverUrl: ANS_DEFAULT_BASE_URL, apiKey: 'dev-key', secretKey: 'dev-secret' });
  const embModel = await ans.getOptimalModel({ capabilities: ['embedding'] }) as { url?: string; api_key?: string; model_name?: string } | undefined;
  console.log('embedding 模型:', embModel?.model_name, '| url:', embModel?.url ? embModel.url.replace(/\/$/, '') : '无');

  if (!embModel?.url) { console.log('❌ 无 embedding 模型'); return; }
  const baseUrl = embModel.url.replace(/\/$/, '');
  const embUrl = baseUrl.includes('/api/embed') || baseUrl.includes('/embeddings') ? baseUrl : `${baseUrl}/embeddings`;
  console.log('embedding 端点:', embUrl);

  try {
    const resp = await fetch(embUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${embModel.api_key || ''}` },
      body: JSON.stringify({ input: '部署一个 MCP 服务', model: embModel.model_name || 'text-embedding-3-small' }),
      signal: AbortSignal.timeout(30_000),
    });
    console.log('HTTP 状态:', resp.status);
    if (!resp.ok) { console.log('响应体:', (await resp.text()).slice(0, 300)); return; }
    const json = await resp.json() as { data?: Array<{ embedding: number[] }>; embeddings?: number[][] };
    const emb = json.data?.[0]?.embedding || json.embeddings?.[0] || null;
    if (emb && emb.length > 0) {
      console.log(`✅ embedding 有效，维度=${emb.length}，前5维=[${emb.slice(0, 5).map(v => v.toFixed(4)).join(', ')}]`);
    } else {
      console.log('❌ embedding 为空');
    }
  } catch (e) {
    console.log('❌ 异常:', (e as Error).message);
  }
}

main();
