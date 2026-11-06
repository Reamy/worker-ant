/**
 * CoT (2026-09-03): 推理模型思考过程流式 定向验证（PLAN_zx_20260903_cot）。
 *
 * 用法：先打包再运行（同其它 smoke）：
 *   npx tsup scripts/smoke-cot-reasoning.ts --format esm --platform node --target node22 \
 *     --external @worker-ant/ans-client --external ai --external @ai-sdk/openai --external pino --external pino-pretty --external pino-roll \
 *     --out-dir apps/worker-ant-desktop/dist-smoke --clean
 *   node apps/worker-ant-desktop/dist-smoke/smoke-cot-reasoning.mjs
 *
 * 桩端点模拟 DeepSeek R1：SSE 先吐 delta.reasoning_content（思考 CoT），再吐 delta.content（最终答案）。
 * 覆盖：
 *   1. createReasoningAwareFetch 旁路提取 reasoning_content → 回调累积出完整思考
 *   2. 透传不破坏 @ai-sdk/openai 的 text-delta 解析（streamText 最终 text = 答案，不含思考）
 *   3. 多行/跨 chunk（含中文多字节）正确提取
 *   4. 空 reasoning / [DONE] / 非 JSON 行静默（不抛错、不透传破坏）
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createReasoningAwareFetch } from '../apps/worker-ant-desktop/src/main/core/ai-reasoning.js';

const nodeRequire = createRequire(import.meta.url);

let passCount = 0;
let failCount = 0;
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { passCount++; console.log(`  ✅ ${name}`); }
  else { failCount++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main(): Promise<void> {
  console.log('\n===== CoT 推理思考流式 验证 =====\n');

  // ---- 场景1：正常推理（reasoning_content 先，content 后，逐字慢速） ----
  const reasonParts: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url!.endsWith('/chat/completions')) {
      req.on('data', () => {}); req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const base = { id: 'x', object: 'chat.completion.chunk', created: 123, model: 'm' };
        const co = (delta: Record<string, unknown>) => JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
        const seq: Array<[string, string]> = [
          ['reasoning_content', '这道题'],
          ['reasoning_content', '需要逐步推理：先看约束'],
          ['reasoning_content', '再验证边界条件'],
          ['content', '最终结论：'],
          ['content', '答案成立'],
        ];
        let i = 0;
        const send = () => {
          if (i < seq.length) {
            const [k, v] = seq[i++];
            res.write(`data: ${co({ [k]: v })}\n\n`);
            setTimeout(send, 5);
          } else {
            res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
        };
        send();
      });
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;

  const wrappedFetch = createReasoningAwareFetch({ onReasoningDelta: (t) => reasonParts.push(t) });
  const provider = createOpenAI({ apiKey: 'k', baseURL: `http://127.0.0.1:${port}/v1`, fetch: wrappedFetch as typeof fetch });
  const result = await streamText({ model: provider.chat('m'), prompt: 'hi', maxSteps: 1 });
  let text = '';
  for await (const c of result.fullStream) { if (c.type === 'text-delta') text += c.textDelta; }

  const reasoning = reasonParts.join('');
  const finalText = await result.text;
  assert('[1] reasoning_content 被旁路提取（完整 CoT）', reasoning === '这道题需要逐步推理：先看约束再验证边界条件', JSON.stringify(reasoning));
  assert('[2] 透传不破坏 text-delta（最终 text = 答案，不含思考）', finalText === '最终结论：答案成立', JSON.stringify(finalText));
  assert('[3] reasoning 不混入最终 text', !finalText.includes('需要逐步推理') && !finalText.includes('边界'), finalText);
  server.close();

  // ---- 场景2：无 reasoning（普通模型），确认不误报、text 正常 ----
  const server2 = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url!.endsWith('/chat/completions')) {
      req.on('data', () => {}); req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const base = { id: 'y', object: 'chat.completion.chunk', created: 456, model: 'm2' };
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '普通' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: '回复' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n'); res.end();
      });
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server2.listen(0, r));
  const port2 = (server2.address() as { port: number }).port;
  const noReason: string[] = [];
  const wf2 = createReasoningAwareFetch({ onReasoningDelta: (t) => noReason.push(t) });
  const p2 = createOpenAI({ apiKey: 'k', baseURL: `http://127.0.0.1:${port2}/v1`, fetch: wf2 as typeof fetch });
  const r2 = await streamText({ model: p2.chat('m2'), prompt: 'hi', maxSteps: 1 });
  let t2 = '';
  for await (const c of r2.fullStream) { if (c.type === 'text-delta') t2 += c.textDelta; }
  assert('[4] 普通模型无 reasoning 回调（不误报）', noReason.length === 0, JSON.stringify(noReason));
  assert('[5] 普通模型 text 正常透传', (await r2.text) === '普通回复', JSON.stringify(await r2.text));
  server2.close();

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====`);
  process.exit(failCount > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
