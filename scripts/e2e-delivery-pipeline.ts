/**
 * 7.6 端到端交付管道验证脚本。
 * 验证完整链路：项目创建→Agent产出MCP服务→运行时自动启动→注册ANS→发现→调用。
 *
 * 用法：npx tsx scripts/e2e-delivery-pipeline.ts
 * 前提：先启动 ANS（默认 27183） + 工蚁后端(3002)
 */
import { createHmacSignature } from '@worker-ant/ans-client';
import { randomUUID } from 'node:crypto';
import { ANS_DEFAULT_BASE_URL } from '../packages/shared-types/src/ans-defaults.js';

const ANS_URL = ANS_DEFAULT_BASE_URL;
const SERVER_URL = 'http://localhost:3002';
const API_KEY = 'dev-key';
const SECRET = 'dev-secret';

let token = '';
let projectId = '';

function hmacHeaders(body: string): Record<string, string> {
  const ts = Date.now().toString();
  const sig = createHmacSignature(SECRET, ts, body);
  return { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'x-timestamp': ts, 'x-signature': sig };
}

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${name}${detail ? ': ' + detail : ''}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  7.6 端到端交付管道验证');
  console.log('═══════════════════════════════════════════\n');

  // =========================================================
  // Step 0: 服务健康检查
  // =========================================================
  console.log('Step 0: 服务健康检查');
  try {
    const h = await fetch(`${ANS_URL}/api/v1/health`);
    check('ANS服务运行', h.ok, `${h.status}`);
  } catch { check('ANS服务运行', false, '无法连接'); }

  try {
    const h = await fetch(`${SERVER_URL}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@worker-ant.local', password: 'admin123' }) });
    const d = await h.json() as Record<string, unknown>;
    token = (d.data as Record<string, string>)?.accessToken || '';
    check('工蚁后端运行+认证', !!token, token ? `token ${token.length}chars` : '认证失败');
  } catch { check('工蚁后端运行', false, '无法连接'); }

  if (!token) { console.log('\n请先启动服务: pnpm dev\n'); process.exit(1); }

  // =========================================================
  // Step 1: 创建测试项目
  // =========================================================
  console.log('\nStep 1: 创建测试项目');
  const projName = `e2e-pipeline-${Date.now()}`;
  const p1 = await fetch(`${SERVER_URL}/api/v1/projects`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ name: projName, description: '端到端交付管道验证项目' }),
  });
  const proj = await p1.json() as { data?: { id: string } };
  projectId = proj.data?.id || '';
  check('项目创建', p1.status === 201 && !!projectId, projectId);

  // =========================================================
  // Step 2: 模拟Agent创建MCP产出物
  // =========================================================
  console.log('\nStep 2: Agent产出MCP服务');

  // 2a. 创建产出物记录
  const mcpName = `e2e-mcp-${Date.now()}`;
  const p2 = await fetch(`${SERVER_URL}/api/v1/projects/${projectId}/deliverables`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ type: 'mcp', name: mcpName, description: 'E2E test MCP server' }),
  });
  const deliv = await p2.json() as { data?: { id: string } };
  const deliverableId = deliv.data?.id || '';
  check('产出物创建', p2.status === 201 && !!deliverableId, `id=${deliverableId}`);

  // 2b. 写入MCP服务器代码（模拟Agent通过bash所做的工作）
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const workingDir = resolve('data/deliverables/mcp', mcpName);
  mkdirSync(workingDir, { recursive: true });
  writeFileSync(resolve(workingDir, 'server.js'), `
const http = require('http');
const port = process.env.MCP_PORT || 19950;
const tools = [
  { name: 'calculator', description: 'Perform arithmetic', inputSchema: { type: 'object', properties: { expr: { type: 'string' } } } },
  { name: 'echo', description: 'Echo back input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
];

http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  if (req.method === 'OPTIONS') { res.end(''); return; }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const r = JSON.parse(body || '{}');
      if (r.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { protocolVersion: '2025-11-25', serverInfo: { name: '${mcpName}', version: '1.0' }, capabilities: { tools: {} } } }));
      } else if (r.method === 'notifications/initialized') {
        res.end(JSON.stringify({ jsonrpc: '2.0', result: {} }));
      } else if (r.method === 'tools/list') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { tools } }));
      } else if (r.method === 'tools/call') {
        const p = r.params || {};
        if (p.name === 'calculator') {
          try { const result = eval(p.arguments?.expr || '0'); res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: String(result) }] } })); }
          catch (e) { res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32000, message: e.message } })); }
        } else if (p.name === 'echo') {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: 'Echo: ' + (p.arguments?.text || '') }] } }));
        } else {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: 'OK' }] } }));
        }
      } else if (r.method === 'resources/list') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { resources: [] } }));
      } else {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }));
      }
    } catch { res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } })); }
  });
}).listen(port, () => console.log('E2E MCP server on port', port));
`);
  check('服务器代码写入', true, `dir=${workingDir}`);

  // =========================================================
  // Step 3: 启动运行时 + 注册到ANS
  // =========================================================
  console.log('\nStep 3: 启动运行时并注册ANS');

  // 3a. 启动运行时
  const p3 = await fetch(`${SERVER_URL}/api/v1/deliverables/${deliverableId}/start`, {
    method: 'POST', headers: authHeaders(),
  });
  const startResult = await p3.json() as { data?: { status: string; endpoint: string; port: number } };
  const endpoint = startResult.data?.endpoint || '';
  const port = startResult.data?.port || 0;
  check('MCP运行时启动', p3.status === 200 && !!endpoint, `endpoint=${endpoint} port=${port}`);

  // 等待服务器就绪
  await new Promise(r => setTimeout(r, 500));

  // 3b. 直接验证MCP服务器响应
  const p3b = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  const initResult = await p3b.json() as Record<string, unknown>;
  const protocolVer = (initResult.result as Record<string, unknown>)?.protocolVersion;
  check('MCP协议initialize', p3b.ok && protocolVer === '2025-11-25', `version=${protocolVer}`);

  // 3c. 注册到ANS
  const p3c = await fetch(`${SERVER_URL}/api/v1/deliverables/${deliverableId}/register`, {
    method: 'POST', headers: authHeaders(),
  });
  const regResult = await p3c.json() as { data?: { status: string; runtimeStarted: boolean; endpoint?: string } };
  check('注册到ANS', p3c.status === 200 && regResult.data?.status === 'registered', `runtimeStarted=${regResult.data?.runtimeStarted}`);

  // =========================================================
  // Step 4: ANS客户端发现
  // =========================================================
  console.log('\nStep 4: ANS客户端发现');

  // 4a. 通过ANS optimal匹配查找
  const matchBody = JSON.stringify({ name: mcpName });
  const p4 = await fetch(`${ANS_URL}/api/v1/mcp/optimal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...hmacHeaders(matchBody) },
    body: matchBody,
  });
  const matchResult = await p4.json() as { data?: { name: string; endpoint: string; cachedTools?: Array<{ name: string }>; toolCount?: number } };
  check('ANS匹配发现', p4.ok && matchResult.data?.name === mcpName, `name=${matchResult.data?.name} endpoint=${matchResult.data?.endpoint?.substring(0, 30)}`);

  // 4b. 验证缓存的工具列表（7.3资源预热）
  const toolCount = matchResult.data?.toolCount || 0;
  const tools = matchResult.data?.cachedTools?.map(t => t.name) || [];
  check('工具列表缓存(7.3预热)', toolCount > 0, `tools=[${tools.join(', ')}]`);

  // =========================================================
  // Step 5: ANS Gateway代理 → 其他项目调用
  // =========================================================
  console.log('\nStep 5: ANS Gateway代理调用（模拟其他项目使用）');

  // 5a. 通过ANS Gateway /mcp/:name 代理到运行时
  const p5 = await fetch(`${ANS_URL}/mcp/${mcpName}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  const gatewayResult = await p5.json() as Record<string, unknown>;
  const gwTools = ((gatewayResult.result as Record<string, unknown>)?.tools as Array<Record<string, unknown>>) || [];
  check('Gateway代理tools/list', p5.ok && gwTools.length === 2, `tools=${gwTools.map(t => t.name).join(', ')}`);

  // 5b. 通过Gateway调用工具（模拟其他项目消费MCP服务）
  const p5b = await fetch(`${ANS_URL}/mcp/${mcpName}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'Hello from another project!' } } }),
  });
  const callResult = await p5b.json() as Record<string, unknown>;
  const content = ((callResult.result as Record<string, unknown>)?.content as Array<{ text: string }>)?.[0]?.text || '';
  check('Gateway代理tools/call', p5b.ok && content.includes('Echo: Hello from another project!'), `content=${content}`);

  // =========================================================
  // Step 6: 运行时状态验证
  // =========================================================
  console.log('\nStep 6: 运行时状态验证');
  const p6 = await fetch(`${SERVER_URL}/api/v1/deliverables/${deliverableId}/runtime-status`, { headers: authHeaders() });
  const runStatus = await p6.json() as { data?: { running: boolean; endpoint: string } };
  check('运行时运行中', runStatus.data?.running === true, `endpoint=${runStatus.data?.endpoint}`);

  // 列出所有运行时
  const p6b = await fetch(`${SERVER_URL}/api/v1/deliverables/runtime-list`, { headers: authHeaders() });
  const runList = await p6b.json() as { data?: { mcp: Array<unknown>; a2a: Array<unknown> } };
  check('运行时列表', (runList.data?.mcp?.length || 0) > 0, `MCP=${runList.data?.mcp?.length} A2A=${runList.data?.a2a?.length}`);

  // =========================================================
  // Step 7: 清理
  // =========================================================
  console.log('\nStep 7: 清理');
  const p7 = await fetch(`${SERVER_URL}/api/v1/deliverables/${deliverableId}/stop`, {
    method: 'POST', headers: authHeaders(),
  });
  const stopResult = await p7.json() as { data?: { status: string } };
  check('运行时停止', p7.status === 200, stopResult.data?.status);

  // =========================================================
  // 总结
  // =========================================================
  console.log('\n═══════════════════════════════════════════');
  console.log(`  结果: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  🎉 端到端交付管道全部验证通过！');
    console.log(`  项目: ${projectId}`);
    console.log(`  产出物: ${deliverableId}`);
    console.log(`  MCP服务: ${mcpName}`);
  } else {
    console.log('  ⚠️  存在失败项，请检查服务状态');
  }
  console.log('═══════════════════════════════════════════');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
