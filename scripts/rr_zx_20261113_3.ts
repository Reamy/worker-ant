/**
 * zx_20261113_3「账」——外部调用账要看得懂，MCP 调用先验名。
 *
 * 判据分组（随批次逐步补齐）：
 *   S「基」构建钉 P1–P6 + 本轮方案在册与边界。
 *   L「账」失败时间 / 最近一次 / 探针与孤账标注（B1）。
 *   M「名」MCP 存在性前置：占位名 / known-set / 注册表不可读 fail-open（B2）。
 *
 * 纪律：
 *   - 轮次钉由 checkBuildPins 从真源派生，不写「只为下一轮」的字面量；
 *   - 断言文案禁含失败字形（汇总器按字形计数）；
 *   - 夹具按生产初始化顺序搭：先建表/服务，再插数据行；
 *   - 计数器类断言必须有 0→1 的正面证据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';
import { describeServiceCalls, isProbeServiceCallTarget, recordServiceCall } from '../apps/worker-ant-desktop/src/main/core/service-call-ledger.js';
import { isPlaceholderMcpServerName, precheckMcpServer, resolveKnownMcpServers, type KnownMcpServers } from '../apps/worker-ant-desktop/src/main/core/mcp-server-registry.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `${JSON.stringify(a)} = ${JSON.stringify(b)}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const readSrc = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');
const codeOf = (rel: string): string => stripKeepingLines(readSrc(rel)).join('\n');

/* ── S「基」轮次在册与构建钉 ─────────────────────────────────────────────── */

function sectionS(): void {
  console.log('\n【S】构建钉与本轮方案');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

  const selfRound = path.basename(__filename, '.ts').replace(/^rr_/, '');
  const plan = readSrc(`plans/improve/${selfRound}.md`);
  ok(plan.includes(selfRound), 'S1 本轮方案在册且带轮次名');
  ok(plan.includes('lastErrorAt') && plan.includes('precheckMcpServer') && plan.includes('knownServers'),
    'S2 方案记下失败时间、存在性前置与 known-set');
  ok(plan.includes('不自动删'), 'S3 方案记下“只标注不自动删账”的边界');

  const { tag, count } = deriveBuildTag(readSrc(`${A}/src/main/core/agent-executor.ts`));
  eq(count, 1, 'S4 源码 build 轮次标识恰好 1 处');
  ok(buildNotOlderThan(tag, selfRound), 'S5 构建钉不早于本脚本轮次', `${tag} >= ${selfRound}`);
}

/* ── L「账」外部调用账可读性（B1） ─────────────────────────────────────── */

function sectionL(): void {
  console.log('\n【L】失败时间 / 最近一次 / 探针与孤账标注（B1）');

  eq([
    isProbeServiceCallTarget('nonexistent-probe/probe'),
    isProbeServiceCallTarget('probe/tool'),
    isProbeServiceCallTarget('test-probe/x'),
    isProbeServiceCallTarget('example/x'),
    isProbeServiceCallTarget('api-gateway/tool'),
    isProbeServiceCallTarget('probe-api/tool'),
    isProbeServiceCallTarget('order-service/lookup'),
  ], [true, true, true, true, false, false, false], 'L1 探针名窄口径七标本');

  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE wa_service_calls (
      id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '',
      kind TEXT NOT NULL, target TEXT DEFAULT '', operation TEXT DEFAULT '',
      ok INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0, error TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO wa_tasks (id, title) VALUES ('t1', '真实任务')").run();
  db.prepare(`INSERT INTO wa_service_calls (id, project_id, task_id, kind, target, operation, ok, duration_ms, error, created_at)
              VALUES ('sc1', 'pProbe', 'deleted-task', 'mcp', 'nonexistent-probe/probe', 'call', 0, 6, 'MCP server not found: nonexistent-probe', '2026-10-22 10:00:00')`).run();
  db.prepare(`INSERT INTO wa_service_calls (id, project_id, task_id, kind, target, operation, ok, duration_ms, error, created_at)
              VALUES ('sc2', 'pProbe', 't1', 'mcp', 'order-service/lookup', 'call', 1, 12, '', '2026-10-22 10:01:00')`).run();

  const r = describeServiceCalls(db as never, 'pProbe');
  const mcp = r.byKind.find(k => k.kind === 'mcp')!;
  eq([mcp.calls, mcp.ok, mcp.failed], [2, 1, 1], 'L2 MCP 聚合 2 笔 · 1 成功 / 1 失败');
  eq([mcp.lastError, mcp.lastErrorAt], ['MCP server not found: nonexistent-probe', '2026-10-22 10:00:00'],
    'L3 ★最近失败带时刻（历史失败不冒充当前）');
  eq([mcp.lastOutcome, mcp.lastOutcomeAt], ['ok', '2026-10-22 10:01:00'], 'L4 ★最近一次调用与失败分开');

  eq([r.recent[0]?.target, r.recent[0]?.ok, r.recent[0]?.taskExists, r.recent[0]?.taskTitle, r.recent[0]?.probe],
    ['order-service/lookup', true, true, '真实任务', false], 'L5 最新真实调用：任务存在、非探针');
  eq([r.recent[1]?.target, r.recent[1]?.ok, r.recent[1]?.taskExists, r.recent[1]?.taskTitle, r.recent[1]?.probe],
    ['nonexistent-probe/probe', false, false, null, true], 'L6 ★探针失败：任务已删除、探针标记');

  const empty = describeServiceCalls(db as never, 'pEmpty');
  eq([empty.total, empty.byKind.find(k => k.kind === 'mcp')!.lastErrorAt, empty.byKind.find(k => k.kind === 'mcp')!.lastOutcome],
    [0, null, null], 'L7 无调用 ⇒ 空态不编造');
  db.close();

  const card = codeOf(`${A}/renderer/src/components/ServiceCallCard.tsx`);
  ok(card.includes('lastErrorAt') && card.includes('lastOutcome') && card.includes('最近一次：'),
    'L8 卡片印失败时刻与最近一次');
  ok(card.includes('任务已删除') && card.includes('探针') && card.includes('隐藏探针/孤账'),
    'L9 卡片有探针/孤账标注与展示开关');
  ok(!card.includes('recordServiceCall(') && !card.includes('describeServiceCalls('),
    'L10 反证：卡片只展示，不写账/不直查库');
}

/* ── M「名」MCP 存在性前置（B2） ───────────────────────────────────────── */

async function sectionM(): Promise<void> {
  console.log('\n【M】MCP 存在性前置（B2）');

  eq([
    isPlaceholderMcpServerName('nonexistent-probe'),
    isPlaceholderMcpServerName('probe'),
    isPlaceholderMcpServerName('test-probe'),
    isPlaceholderMcpServerName('order-service'),
    isPlaceholderMcpServerName('probe-api'),
  ], [true, true, true, false, false], 'M1 占位名五标本');

  const knownOk: KnownMcpServers = { ok: true, names: ['order-service', 'inventory'], ansServers: [] };
  eq(precheckMcpServer('order-service', knownOk), { ok: true }, 'M2 known-set 内放行');
  const placeholder = precheckMcpServer('nonexistent-probe', knownOk);
  ok(!placeholder.ok && placeholder.error === 'MCP server not found: nonexistent-probe'
    && placeholder.knownServers.includes('order-service'), 'M3 占位名拒绝并给 knownServers');
  const unknown = precheckMcpServer('typo-service', knownOk);
  ok(!unknown.ok && unknown.error.includes('typo-service'), 'M4 known-set 外拒绝');

  const knownDown: KnownMcpServers = { ok: false, reason: 'ANS down', names: ['order-service'], ansServers: [] };
  eq(precheckMcpServer('typo-service', knownDown), { ok: true }, 'M5 注册表不可读 ⇒ fail-open 放行非占位名');
  ok(!precheckMcpServer('nonexistent-probe', knownDown).ok, 'M5b 注册表不可读时占位名仍拒');

  const okKnown = await resolveKnownMcpServers({
    projectNames: ['p1', 'p1'],
    readAns: async () => ({ ok: true as const, servers: [{ name: 'a' }, { name: 'b' }] }),
    now: () => 0,
  });
  eq(okKnown.names, ['p1', 'a', 'b'], 'M6 known-set = 项目 ∪ ANS（去重）');
  const down = await resolveKnownMcpServers({
    projectNames: ['p1'],
    readAns: async () => ({ ok: false as const, reason: 'timeout' }),
    now: () => 0,
  });
  eq([down.ok, down.names], [false, ['p1']], 'M7 ANS 不可读 ⇒ ok:false + 项目名单');

  let reads = 0;
  const cacheDeps = {
    projectNames: ['p'],
    readAns: async () => { reads++; return { ok: true as const, servers: [{ name: 'a' }] }; },
    cacheKey: 'm8-cache-key',
    now: () => 1000,
  };
  await resolveKnownMcpServers(cacheDeps);
  await resolveKnownMcpServers(cacheDeps);
  eq(reads, 1, 'M8 60s 缓存命中不重复读 ANS');

  const res = codeOf(`${A}/src/main/core/tools/resource.ts`);
  const preIdx = res.indexOf('if (!pre.ok)');
  const callIdx = res.indexOf('callMcpTool(serverName', preIdx);
  const recIdx = res.indexOf('recordServiceCall(db,', preIdx);
  ok(preIdx > 0 && callIdx > preIdx, 'M9 前置在 callMcpTool 之前');
  ok(recIdx < 0 || recIdx > callIdx, 'M9b 拒绝分支（pre 之后、call 之前）不写账');
  ok(res.includes('knownMcpFor(') && res.includes('knownServers'),
    'M10 find/call 共用 known-set 且回包带 knownServers');

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE wa_service_calls (
    id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '', kind TEXT NOT NULL,
    target TEXT DEFAULT '', operation TEXT DEFAULT '', ok INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0,
    error TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`);
  const cnt = () => (db.prepare('SELECT COUNT(*) c FROM wa_service_calls').get() as { c: number }).c;
  eq(cnt(), 0, 'M11 前置：调用账 0 行');
  recordServiceCall(db as never, { projectId: 'p', kind: 'mcp', target: 'order-service/lookup', operation: 'call', ok: true, durationMs: 1 });
  recordServiceCall(db as never, { projectId: 'p', kind: 'mcp', target: 'order-service/lookup', operation: 'call', ok: false, durationMs: 1, error: 'x' });
  eq(cnt(), 2, 'M11b 真写口 0→2（真实调用仍记账）');
  db.close();
}

async function main(): Promise<void> {
  sectionS();
  sectionL();
  await sectionM();

  console.log(`\n[rr_zx_20261113_3] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error('\nrr_zx_20261113_3 未捕获异常（复跑未跑完，不得读作通过）：', e);
  console.log(`\n[rr_zx_20261113_3] ${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
