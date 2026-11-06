/**
 * 10.6: ANS匹配接口性能基准测试
 * 用法: npx tsx scripts/benchmark.ts
 * 前提: ANS服务运行中 (pnpm --filter @worker-ant/ans-server dev)
 */
import { ANS_DEFAULT_BASE_URL } from '../packages/shared-types/src/ans-defaults.js';

const ANS_URL = ANS_DEFAULT_BASE_URL;

async function bench(name: string, fn: () => Promise<unknown>, concurrency = 100) {
  const start = Date.now();
  const results: number[] = [];
  const promises: Promise<void>[] = [];

  for (let i = 0; i < concurrency; i++) {
    promises.push((async () => {
      const t0 = Date.now();
      try { await fn(); } catch { /* ignore */ }
      results.push(Date.now() - t0);
    })());
  }

  await Promise.all(promises);
  const elapsed = Date.now() - start;
  const sorted = results.sort((a, b) => a - b);
  const avg = results.reduce((a, b) => a + b, 0) / results.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  const p99 = sorted[Math.floor(sorted.length * 0.99)]!;

  console.log(`${name}: ${concurrency}并发`);
  console.log(`  耗时: ${elapsed}ms | 平均: ${avg.toFixed(1)}ms | P50: ${p50}ms | P95: ${p95}ms | P99: ${p99}ms`);
  console.log(`  ${avg < 200 ? '✅' : '❌'} P95<200ms: ${p95 < 200 ? 'PASS' : 'FAIL'}`);
  return { elapsed, avg, p50, p95, p99 };
}

async function main() {
  console.log('ANS匹配接口性能基准测试\n');

  // 测试1: /api/v1/models/optimal
  await bench('GET /api/v1/health', () => fetch(`${ANS_URL}/api/v1/health`), 100);
  console.log();

  // 测试2: /api/v1/mcp/optimal
  await bench('POST /api/v1/mcp/optimal', () =>
    fetch(`${ANS_URL}/api/v1/mcp/optimal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }), 100);
  console.log();

  // 测试3: /api/v1/a2a/optimal
  await bench('POST /api/v1/a2a/optimal', () =>
    fetch(`${ANS_URL}/api/v1/a2a/optimal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }), 100);
  console.log();

  // 测试4: 连续负载
  console.log('连续负载测试 (1000 req)...');
  const t0 = Date.now();
  let success = 0, fail = 0;
  const batch = [];
  for (let i = 0; i < 1000; i++) {
    batch.push(fetch(`${ANS_URL}/api/v1/health`).then(r => r.ok ? success++ : fail++).catch(() => fail++));
  }
  await Promise.all(batch);
  console.log(`  1000请求: ${Date.now() - t0}ms | 成功: ${success} | 失败: ${fail}`);
  console.log(`  ${fail === 0 ? '✅' : '❌'} 零失败: ${fail === 0 ? 'PASS' : 'FAIL'}`);

  console.log('\n性能基线测试完成');
}

main().catch(console.error);
