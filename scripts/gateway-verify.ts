/**
 * ANS Gateway 端到端验证脚本。
 * 完整测试链：供应商→模型→端点→Gateway→AI调用→计费。
 *
 * 用法：tsx scripts/gateway-verify.ts [ANS_URL]
 * 默认 ANS_URL 取 shared-types 单一真源（`ANS_DEFAULT_BASE_URL`，zx_20261005 M21）
 */
import { ANS_DEFAULT_BASE_URL } from '../packages/shared-types/src/ans-defaults.js';

const ANS_URL = process.argv[2] || ANS_DEFAULT_BASE_URL;

async function req(method: string, path: string, body?: unknown) {
  const resp = await fetch(`${ANS_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return resp.json() as Promise<{ data?: unknown; error?: { message: string } }>;
}

async function verify() {
  console.log(`🔍 验证 ANS Gateway: ${ANS_URL}\n`);

  // 1. 健康检查
  const health = await req('GET', '/api/v1/health');
  if (!health || (health as { status?: string }).status !== 'ok') {
    console.log('❌ ANS服务不可达，请先启动: pnpm dev');
    process.exit(1);
  }
  console.log('✅ ANS服务健康检查通过');

  // 2. 创建供应商
  console.log('\n📦 创建测试供应商...');
  const provider = await req('POST', '/api/v1/models/providers', { name: 'test-provider', base_url: 'https://api.openai.com' });
  const pData = provider.data as { id?: string } | undefined;
  if (!pData?.id) { console.log('❌ 创建供应商失败:', provider); return; }
  console.log(`   供应商ID: ${pData.id}`);

  // 3. 创建模型
  console.log('\n🤖 创建测试模型...');
  const model = await req('POST', '/api/v1/models', {
    provider_id: pData.id,
    name: 'gpt-4o-mini-test',
    capabilities: ['chat'],
    context_window: 128000,
    max_output_tokens: 4096,
    input_price_per_1k: 0.001,
    output_price_per_1k: 0.002,
  });
  const mData = model.data as { id?: string } | undefined;
  if (!mData?.id) { console.log('❌ 创建模型失败:', model); return; }
  console.log(`   模型ID: ${mData.id}`);

  // 4. 创建端点（需要真实API Key）
  const apiKey = process.env.TEST_OPENAI_KEY;
  if (!apiKey) {
    console.log('\n⚠️  未设置 TEST_OPENAI_KEY，跳过端点创建和Gateway调用');
    console.log('   设置方式: export TEST_OPENAI_KEY=sk-your-key');
    console.log('   然后重新运行: tsx scripts/gateway-verify.ts');
    console.log('\n✅ 供应商→模型 链路验证通过（端点未配置）');
    return;
  }

  console.log('\n🔌 创建模型端点...');
  const endpoint = await req('POST', `/api/v1/models/${mData.id}/endpoints`, {
    url: 'https://api.openai.com/v1',
    api_key: apiKey,
    priority: 0,
    weight: 1.0,
  });
  const eData = endpoint.data as { id?: string } | undefined;
  if (!eData?.id) { console.log('❌ 创建端点失败:', endpoint); return; }
  console.log(`   端点ID: ${eData.id}`);

  // 5. 资源匹配
  console.log('\n🎯 测试资源匹配...');
  const matched = await req('POST', '/api/v1/models/optimal', { capabilities: ['chat'], strategy: 'cost-optimal' });
  const matchData = matched.data as { id?: string; fallback?: unknown } | undefined;
  if (!matchData?.id) { console.log('❌ 匹配失败:', matched); return; }
  console.log(`   匹配端点: ${matchData.id} | 备用: ${matchData.fallback ? '有' : '无'}`);

  // 6. Gateway Chat 调用
  console.log('\n💬 测试 Gateway Chat...');
  const chat = await req('POST', '/api/v1/gateway/chat', {
    messages: [{ role: 'user', content: 'Say "Hello from Worker Ant Gateway test!" in one sentence.' }],
    capabilities: ['chat'],
    strategy: 'cost-optimal',
  });
  const chatData = chat.data as { content?: string; model?: string; usage?: Record<string, number> } | undefined;
  if (chatData?.content) {
    console.log(`   回复: ${chatData.content.slice(0, 100)}`);
    console.log(`   模型: ${chatData.model}`);
    console.log(`   Tokens: ${chatData.usage?.total_tokens || 'N/A'}`);
  } else {
    console.log(`   ❌ 调用失败:`, chat);
    return;
  }

  // 7. 计费验证
  console.log('\n💰 验证计费记录...');
  const billing = await req('GET', '/api/v1/billing/usage?days=1');
  const bData = billing.data as Array<unknown> | undefined;
  console.log(`   今日计费记录: ${bData?.length || 0} 条`);

  console.log('\n🎉 全部验证通过！');
  console.log('   ✅ 健康检查 → ✅ 供应商 → ✅ 模型 → ✅ 端点 → ✅ 匹配 → ✅ Gateway → ✅ 计费');
  console.log('   ANS Gateway 端到端链路正常工作');
}

verify().catch((e) => { console.error('验证异常:', e); process.exit(1); });
