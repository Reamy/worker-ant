/**
 * 7.6 端到端交付管道验证脚本 (纯Node.js)。
 * 验证：项目→Agent产出MCP服务→运行时启动→ANS注册→发现→Gateway代理调用
 *
 * 用法：node scripts/e2e-delivery-pipeline.js
 * 前提：先启动 ANS（默认 27183） + 工蚁后端(3002)；另需 `pnpm --filter @worker-ant/shared-types build`
 *      （ANS 地址取真源产物，不再手抄端口——zx_20261005 M21）
 */
import { createHmac } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ANS_DEFAULT_BASE_URL } from '../packages/shared-types/dist/index.js';

const ANS_URL = ANS_DEFAULT_BASE_URL;
const SERVER_URL = 'http://localhost:3002';
const API_KEY = 'dev-key';
const SECRET = 'dev-secret';

let token = '';
let projectId = '';
let passed = 0;
let failed = 0;

function hmacHeaders(body) {
  const ts = Date.now().toString();
  const sig = createHmac('sha256', SECRET).update(ts + ':' + body).digest('hex');
  return { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'x-timestamp': ts, 'x-signature': sig };
}

function check(name, condition, detail) {
  if (condition) { console.log(`  ✅ ${name}${detail ? ': ' + detail : ''}`); passed++; }
  else { console.log(`  ❌ ${name}${detail ? ': ' + detail : ''}`); failed++; }
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  7.6 端到端交付管道验证');
  console.log('═══════════════════════════════════════════\n');

  // Step 0: 服务健康检查
  console.log('Step 0: 服务健康检查');
  try {
    const h = await fetch(`${ANS_URL}/api/v1/health`);
    check('ANS服务运行', h.ok, String(h.status));
  } catch { check('ANS服务运行', false, '无法连接'); }

  try {
    const h = await fetch(`${SERVER_URL}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@worker-ant.local', password: 'admin123' }) });
    const d = await h.json();
    token = d.data?.accessToken || '';
    check('工蚁后端运行+认证', !!token, token ? `token ${token.length}chars` : '认证失败');
  } catch { check('工蚁后端运行', false, '无法连接'); }

  if (!token) { console.log('\n请先启动服务: pnpm dev\n'); process.exit(1); }

  const auth = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

  // Step 1: 创建测试项目
  console.log('\nStep 1: 创建测试项目');
  const projName = `e2e-pipeline-${Date.now()}`;
  const p1 = await fetch(`${SERVER_URL}/api/v1/projects`, { method: 'POST', headers: auth(), body: JSON.stringify({ name: projName, description: 'E2E验证项目' }) });
  const proj = await p1.json();
  projectId = proj.data?.id || '';
  check('项目创建', p1.status === 201 && !!projectId, projectId);

  // Step 2: Agent产出MCP服务
  console.log('\nStep 2: Agent产出MCP服务');
  const mcpName = `e2e-mcp-${Date.now()}`;
  const p2 = await fetch(`${SERVER_URL}/api/v1/projects/${projectId}/deliverables`, { method: 'POST', headers: auth(), body: JSON.stringify({ type: 'mcp', name: mcpName, description: 'E2E test MCP server' }) });
  const deliv = await p2.json();
  const deliverableId = deliv.data?.id || '';
  check('产出物记录创建', p2.status === 201 && !!deliverableId, deliverableId);

  // 写入MCP服务器代码
  const workingDir = resolve('data/deliverables/mcp', mcpName);
  mkdirSync(workingDir, { recursive: true });
  writeFileSync(resolve(workingDir, 'server.js'), `
const http = require('http');
const port = process.env.MCP_PORT || 19950;
const tools = [
  { name: 'calculator', description: 'Performs arithmetic', inputSchema: { type: 'object', properties: { expr: { type: 'string' } } } },
  { name: 'echo', description: 'Echoes input text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
];
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
  if (req.method === 'OPTIONS') { res.end(''); return; }
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    try {
      const r = JSON.parse(body || '{}');
      if (r.method === 'initialize') res.end(JSON.stringify({ jsonrpc:'2.0', id:r.id, result:{ protocolVersion:'2025-11-25', serverInfo:{ name:'${mcpName}', version:'1.0' }, capabilities:{ tools:{} } } }));
      else if (r.method === 'notifications/initialized') res.end(JSON.stringify({ jsonrpc:'2.0', result:{} }));
      else if (r.method === 'tools/list') res.end(JSON.stringify({ jsonrpc:'2.0', id:r.id, result:{ tools } }));
      else if (r.method === 'tools/call') {
        const p = r.params || {};
        if (p.name === 'echo') res.end(JSON.stringify({ jsonrpc:'2.0', id:r.id, result:{ content:[{ type:'text', text:'Echo: ' + (p.arguments?.text || '') }] } }));
        else res.end(JSON.stringify({ jsonrpc:'2.0', id:r.id, result:{ content:[{ type:'text', text:'OK' }] } }));
      } else if (r.method === 'resources/list') res.end(JSON.stringify({ jsonrpc:'2.0', id:r.id, result:{ resources:[] } }));
      else res.end(JSON.stringify({ jsonrpc:'2.0', id:r.id, result:{} }));
    } catch { res.end(JSON.stringify({ jsonrpc:'2.0', error:{ code:-32700, message:'Parse error' } })); }
  });
}).listen(port, () => console.log('E2E MCP on port', port));
`);
  check('服务器代码写入', true, workingDir);

  // Step 3: 启动运行时 + 注册ANS
  console.log('\nStep 3: 启动运行时并注册ANS');

  const p3 = await fetch(`${SERVER_URL}/api/v1/deliverables/${deliverableId}/start`, { method: 'POST', headers: auth() });
  const startResult = await p3.json();
  const endpoint = startResult.data?.endpoint || '';
  check('MCP运行时启动', p3.status === 200 && !!endpoint, endpoint);

  await new Promise(r => setTimeout(r, 500));

  // 直接验证MCP协议
  const p3b = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
  const initResult = await p3b.json();
  const protocolVer = initResult.result?.protocolVersion;
  check('MCP initialize协议', p3b.ok && protocolVer === '2025-11-25', `version=${protocolVer}`);

  // 注册到ANS
  const p3c = await fetch(`${SERVER_URL}/api/v1/deliverables/${deliverableId}/register`, { method: 'POST', headers: auth() });
  const regResult = await p3c.json();
  check('注册到ANS', p3c.status === 200 && regResult.data?.status === 'registered', `runtimeStarted=${regResult.data?.runtimeStarted}`);

  // Step 4: ANS客户端发现
  console.log('\nStep 4: ANS最优匹配发现');
  const matchBody = JSON.stringify({ name: mcpName });
  const p4 = await fetch(`${ANS_URL}/api/v1/mcp/optimal`, { method: 'POST', headers: hmacHeaders(matchBody), body: matchBody });
  const matchResult = await p4.json();
  check('ANS匹配发现', p4.ok && matchResult.data?.name === mcpName, `name=${matchResult.data?.name}`);
  const toolCount = matchResult.data?.toolCount || 0;
  check('工具列表缓存(7.3预热)', toolCount > 0, `toolCount=${toolCount}`);

  // Step 5: Gateway代理 → 模拟其他项目调用
  console.log('\nStep 5: ANS Gateway代理（其他项目调用）');
  const p5 = await fetch(`${ANS_URL}/mcp/${mcpName}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  const gwResult = await p5.json();
  const gwTools = gwResult.result?.tools || [];
  check('Gateway代理tools/list', p5.ok && gwTools.length === 2, `tools=[${gwTools.map(t => t.name).join(', ')}]`);

  const p5b = await fetch(`${ANS_URL}/mcp/${mcpName}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'Hello from another project!' } } }) });
  const callResult = await p5b.json();
  const content = callResult.result?.content?.[0]?.text || '';
  check('Gateway代理tools/call', content.includes('Echo: Hello from another project!'), content);

  // Step 6: 运行时状态
  console.log('\nStep 6: 运行时状态');
  const p6 = await fetch(`${SERVER_URL}/api/v1/deliverables/${deliverableId}/runtime-status`, { headers: auth() });
  const runStatus = await p6.json();
  check('运行时运行中', runStatus.data?.running === true);

  const p6b = await fetch(`${SERVER_URL}/api/v1/deliverables/runtime-list`, { headers: auth() });
  const runList = await p6b.json();
  check('运行时列表正常', Array.isArray(runList.data?.mcp), `MCP=${runList.data?.mcp?.length}`);

  // Step 7: 清理
  console.log('\nStep 7: 清理');
  const p7 = await fetch(`${SERVER_URL}/api/v1/deliverables/${deliverableId}/stop`, { method: 'POST', headers: auth() });
  const stopResult = await p7.json();
  check('运行时停止', p7.status === 200, stopResult.data?.status);

  // 总结
  console.log('\n═══════════════════════════════════════════');
  console.log(`  结果: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('  🎉 端到端交付管道全部验证通过！');
  else console.log('  ⚠️  存在失败项，请检查服务状态');
  console.log('═══════════════════════════════════════════');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
