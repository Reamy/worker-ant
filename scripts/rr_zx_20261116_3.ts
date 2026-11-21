/**
 * zx_20261116_3 「限·名·判·证·拆·轻」受控复跑。
 *
 * 分组（与方案 §3 批次一一对应，按实施顺序追加）：
 *   A「限」限流可配/429 退避/记账队列/在途键（M1）
 *   B「名」形态判定与能力自纠（M2）
 *   C「判」验收基线/未判成封顶/子任务异常账（M3）
 *   D「证」run id 可引用与覆盖链（M4）
 *   E「拆」拆解读方案/槽位/依赖/估算（M5）
 *   F「轻」登记上限/压缩预算/A2A 噪音（M6）
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引生产函数 / 真实现（被删/改名即编译期失败）。
 *   · 两侧标本同试；计数器类断言给 0→1 正面值。
 *   · 断言文案不含失败字形；表结构走生产 `initDatabase`。
 *   · 夹具按生产初始化顺序：先 initDatabase，再插数据行。
 *   · 不以轮次字面量做等值断言；build 钉由 `checkBuildPins` 派生核对。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { checkBuildPins } from './lib/rr-pins.js';
import { RateLimiter, rateLimitClassOf, readRateLimitEnv } from '../apps/ans-server/src/utils/rate-limiter.js';
import { AnsClient, AnsApiError, parseRetryAfterMs } from '../packages/ans-client/src/client.js';
import { ansSignedRequest } from '../apps/worker-ant-desktop/src/main/core/ans-signed-request.js';
import { BillingReporter } from '../apps/worker-ant-desktop/src/main/core/billing-reporter.js';
import { classifyArchetypeDetailed, stripPlanBoilerplate, ARCHETYPE_TOOL_CATEGORIES } from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';
import { resolvePinnedArchetype, buildTools, assessCompletionQuality } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { capScoreByAcceptanceVerdict, goalEvidenceOf, acceptanceVerdictOf } from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';
import { captureRunStartBaseline, writeRunStartBaseline, readRunStartBaseline } from '../apps/worker-ant-desktop/src/main/core/run-baseline.js';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';
import { collectEvidence, renderEvidence } from '../apps/worker-ant-desktop/src/main/core/exec-evidence.js';
import { milestoneHintOf } from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
import { childBreadthRefusal, countStartableChildren } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import { estimateTaskBudget } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { depBlockInfo } from '../apps/worker-ant-desktop/src/main/core/dep-graph.js';
import { CommandWriteQueue } from '../apps/worker-ant-desktop/src/main/core/command-write-queue.js';
import { compactionBudgetMs } from '../apps/worker-ant-desktop/src/main/core/context-compaction.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ok ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261116-3-'));
let dbSeq = 0;
function mkdb(): Database.Database {
  const db = initDatabase(path.join(tmpRoot, `db-${++dbSeq}`));
  db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p','P',?)").run(tmpRoot);
  return db;
}
function addTask(
  db: Database.Database,
  id: string,
  status: string,
  parent = '',
  ctx: Record<string, unknown> = {},
  criteria = '',
): void {
  db.prepare(
    "INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id, context_json, acceptance_criteria) VALUES (?, 'p', ?, ?, ?, ?, ?)",
  ).run(id, id, status, parent, JSON.stringify(ctx), criteria);
}
function addConv(db: Database.Database, taskId: string, role: string, content: string): void {
  db.prepare(
    "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count) VALUES (?, ?, ?, ?, 0)",
  ).run(`c-${taskId}-${Math.random().toString(36).slice(2)}`, taskId, role, content);
}
function addDeliverable(db: Database.Database, id: string, taskId: string, filePath: string): void {
  db.prepare(
    "INSERT INTO wa_deliverables (id, project_id, task_id, type, name, status, file_path) VALUES (?, 'p', ?, 'doc', ?, 'completed', ?)",
  ).run(id, taskId, path.basename(filePath), filePath);
}
function ctxOf(db: Database.Database, taskId: string): Record<string, any> {
  return JSON.parse(
    (db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string }).context_json || '{}',
  );
}

async function groupA(): Promise<void> {
  console.log('\n── A「限」──');

  // A1 env / 分桶
  const cfg = readRateLimitEnv({} as NodeJS.ProcessEnv);
  eq(cfg.limits.billing, 240, 'A1 默认 billing 桶 240/min');
  eq(cfg.limits.model, 240, 'A1 默认 model 桶 240/min');
  eq(cfg.limits.mgmt, 120, 'A1 默认 mgmt 桶 120/min');
  eq(cfg.limits.a2a, 60, 'A1 默认 a2a 桶 60/min');
  eq(cfg.windowMs, 60_000, 'A1 默认窗口 60s');
  const cfg2 = readRateLimitEnv({ ANS_RATE_LIMIT_MAX: '5', ANS_RATE_LIMIT_MGMT: '7' } as NodeJS.ProcessEnv);
  eq(cfg2.limits.billing, 5, 'A1 全局 env 覆盖 billing');
  eq(cfg2.limits.mgmt, 7, 'A1 分桶 env 覆盖 mgmt');
  const cfg3 = readRateLimitEnv({ ANS_RATE_LIMIT_MAX: '-1', ANS_RATE_LIMIT_A2A: 'abc' } as NodeJS.ProcessEnv);
  eq(cfg3.limits.billing, 240, 'A1 非法全局值回落默认');
  eq(cfg3.limits.a2a, 60, 'A1 非法分桶值回落默认');
  eq(rateLimitClassOf('/api/v1/billing/records'), 'billing', 'A1 路径归 billing');
  eq(rateLimitClassOf('/api/v1/models/optimal'), 'model', 'A1 路径归 model');
  eq(rateLimitClassOf('/api/v1/gateway/chat'), 'model', 'A1 gateway 归 model');
  eq(rateLimitClassOf('/api/v1/a2a/optimal'), 'a2a', 'A1 a2a 归协议桶');
  eq(rateLimitClassOf('/api/v1/mcp/servers'), 'a2a', 'A1 mcp 归协议桶');
  eq(rateLimitClassOf('/api/v1/skills/optimal'), 'mgmt', 'A1 其余 /api/v1 归 mgmt');
  eq(rateLimitClassOf('/docs'), 'default', 'A1 未知路径归 default');

  const rl = new RateLimiter({ windowMs: 1000, maxRequests: 2 });
  rl.check('k'); rl.check('k');
  let limited = false;
  try { rl.check('k'); } catch { limited = true; }
  ok(limited, 'A1 单桶超限抛 429');

  // A2 429 退避 / 4xx 不重试
  eq(parseRetryAfterMs('2'), 2000, 'A2 Retry-After 秒数解析');
  eq(parseRetryAfterMs(''), undefined, 'A2 空头不解析');
  eq(parseRetryAfterMs(null), undefined, 'A2 缺头不解析');
  ok((parseRetryAfterMs(new Date(Date.now() + 3000).toUTCString()) ?? 0) >= 2000, 'A2 HTTP date 解析');

  const origFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
      return new Response(JSON.stringify({ id: 'm-retry' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const c = new AnsClient({ serverUrl: 'http://x', apiKey: 'k', secretKey: 's', maxRetries: 2, retryDelayMs: 1 });
    const r = await c.getOptimalModel({} as never) as { id?: string };
    eq(r.id, 'm-retry', 'A2 AnsClient 429 后重试成功');
    eq(calls, 2, 'A2 AnsClient 429 只重试一次');

    let calls400 = 0;
    globalThis.fetch = (async () => {
      calls400++;
      return new Response('bad', { status: 400 });
    }) as typeof fetch;
    const c2 = new AnsClient({ serverUrl: 'http://x', apiKey: 'k', secretKey: 's', maxRetries: 2, retryDelayMs: 1 });
    let err400: unknown = null;
    try { await c2.getOptimalModel({} as never); } catch (e) { err400 = e; }
    ok(err400 instanceof AnsApiError && (err400 as AnsApiError).status === 400, 'A2 400 仍是 AnsApiError');
    eq(calls400, 1, 'A2 400 不重试（反证）');
  } finally {
    globalThis.fetch = origFetch;
  }

  let sCalls = 0;
  const signed = await ansSignedRequest(
    { baseUrl: 'http://x', apiKey: 'k', secretKey: 's' },
    '/api/v1/models/optimal',
    {
      method: 'POST', body: {}, retries: 1,
      fetchImpl: (async () => {
        sCalls++;
        if (sCalls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    },
  );
  ok(signed.ok, 'A2 ansSignedRequest 429 后成功');
  eq(signed.attempts, 2, 'A2 ansSignedRequest 429 重试一次');

  // A3 记账队列
  const seenKeys: string[] = [];
  const rep = new BillingReporter({ batchSize: 1000, flushEveryMs: 60_000 });
  for (let i = 0; i < 20; i++) {
    rep.enqueue({ path: '/billing', body: { i }, key: `k${i}`, post: async () => { seenKeys.push(`k${i}`); } });
  }
  rep.enqueue({ path: '/billing', body: { i: 0 }, key: 'k0', post: async () => { seenKeys.push('dup'); } });
  const f1 = await rep.flush();
  eq(f1.sent, 20, 'A3 20 条全部上报');
  eq(f1.pending, 0, 'A3 队列清空');
  eq(seenKeys.length, 20, 'A3 去重后仍 20 次');
  ok(!seenKeys.includes('dup'), 'A3 重复 key 不重复上报');

  let failOnce = true;
  const rep2 = new BillingReporter({ batchSize: 1000, flushEveryMs: 60_000, maxAttempts: 3 });
  rep2.enqueue({
    path: '/billing', body: {}, key: 'fail',
    post: async () => { if (failOnce) { failOnce = false; throw new Error('429'); } },
  });
  const f2 = await rep2.flush();
  eq(f2.pending, 1, 'A3 单条失败保留待重试');
  const f3 = await rep2.flush();
  eq(f3.sent, 1, 'A3 重试后成功');
  eq(f3.pending, 0, 'A3 重试后清空');

  // A4/A6 静态：在途键释放仍在 finally；ANS 不再写死 60
  const sched = fs.readFileSync(path.join(root, A, 'src/main/core/task-scheduler.ts'), 'utf8');
  ok(/finally\s*\{[\s\S]*releaseInflightToken\(key, runToken, 'finished'\)/.test(sched), 'A4 在途键在 finally 释放');
  const ansIndex = fs.readFileSync(path.join(root, 'apps/ans-server/src/index.ts'), 'utf8');
  ok(!/maxRequests:\s*60\b/.test(ansIndex), 'A6 index.ts 不再写死 60');
  ok(/readRateLimitEnv/.test(ansIndex) && /rateLimitClassOf/.test(ansIndex), 'A6 index.ts 接线 env 与分桶');
}
async function groupB(): Promise<void> {
  console.log('\n── B「名」──');
  const mainText = '新后端对接易宝支付方案实施 请开始按计划分步实施方案 plans/backend/20261116-新后端易宝支付对接方案.md，方案实施要求：每开始一项任务前请先根据实施排期计划进行一次细化规划后再开始实施';
  const t12Text = 'T12 提现六态 + 审核闸门 + transfer 打款 + 代付回调 【方案单元 T12 · 批次 B4】详见 plans/backend/20261116-新后端易宝支付对接方案.md §10.3 T12 行。 ## 目标 提现（出款）补齐六态状态机 + 审核闸门 + 渠道 transfer 打款 + 代付异步回调。';
  const t14Text = 'T14 三端前端状态对齐（mini-mp / org-web / platform-web） 【方案单元 T14 · 批次 B5】依据 plans/backend/20261116-新后端易宝支付对接方案.md §10.3 T14 行。 ## 目标 三端前端与后端六态对齐';
  const subText = '[Sub] T16~T18 收口轮独立复跑并回传真实 run id 你是只读验证者，任务是复跑取证：逐条执行下列 4 条命令并回传真实输出 clean compile / mvn / node / git';

  eq(classifyArchetypeDetailed(mainText).archetype, 'code', 'B1 主任务题面判 code');
  eq(classifyArchetypeDetailed(t12Text).archetype, 'code', 'B2 T12 题面判 code');
  eq(classifyArchetypeDetailed(t14Text).archetype, 'code', 'B3 T14 题面判 code');
  const sub = classifyArchetypeDetailed(subText);
  eq(sub.archetype, 'code', 'B4 复跑题面判 code');
  eq(sub.source, 'capability', 'B4 复跑题面来源为能力升级');

  eq(classifyArchetypeDetailed('撰写一份实施方案').archetype, 'document', 'B5 负标本：撰写方案判 document');
  eq(classifyArchetypeDetailed('写一份退款方案').archetype, 'document', 'B5 负标本：写退款方案判 document');
  eq(classifyArchetypeDetailed('调研某某技术方案').archetype, 'research', 'B5 负标本：调研方案判 research');

  const pinned = resolvePinnedArchetype(JSON.stringify({ archetype_override: 'document' }));
  eq(pinned?.archetype, 'document', 'B6 手动覆盖优先');
  eq(pinned?.source, 'manual', 'B6 手动覆盖来源为 manual');
  const execSrc = fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf8');
  ok(/capabilityPinned/.test(execSrc) && /decision\.source === 'capability'/.test(execSrc), 'B6 能力升级不被历史校准推翻');

  ok(!ARCHETYPE_TOOL_CATEGORIES.research.includes('shell'), 'B7 research 档无 shell（原病灶）');
  ok(ARCHETYPE_TOOL_CATEGORIES.code.includes('shell'), 'B7 code 档有 shell');
  ok(stripPlanBoilerplate('【方案单元 T12 · 批次 B4】详见 plans/a/b.md').trim() === '', 'B7 方案样板可剥离（含中文路径）');
}
async function groupC(): Promise<void> {
  console.log('\n── C「判」──');

  // C1 0 步不再拿“高效”分
  const db1 = mkdb();
  const c1Out = path.join(tmpRoot, 'c1-out.md');
  fs.writeFileSync(c1Out, 'x'.repeat(100));
  addTask(db1, 'c1', 'completed');
  addDeliverable(db1, 'd-c1', 'c1', c1Out);
  for (let i = 0; i < 3; i++) addConv(db1, 'c1', 'assistant', `reply ${i}`);
  const q0 = assessCompletionQuality(db1, 'c1', 0, 0, 0, 0, tmpRoot, 'code');
  const q5 = assessCompletionQuality(db1, 'c1', 5, 0, 0, 0, tmpRoot, 'code');
  ok(q0.score <= 85, 'C1 0 步不再得步骤效率分', `score=${q0.score}`);
  eq(q5.score - q0.score, 10, 'C1 5 步比 0 步恰多 10 分（效率档）');

  // C2 unjudged 封 60 + goal=false + 列账同值
  const db2 = mkdb();
  addTask(db2, 'c2p', 'executing');
  addTask(db2, 'c2', 'paused', 'c2p', {
    acceptance_check: { checked_at: '2026-11-16T00:00:00.000Z', verified: false, reason: 'error', criteria_total: 0, passed_total: 0 },
    pause_reason: 'acceptance_unjudged',
  }, '判据1');
  addDeliverable(db2, 'd-c2', 'c2', path.join(tmpRoot, 'missing-c2.md'));
  for (let i = 0; i < 3; i++) addConv(db2, 'c2', 'assistant', `reply ${i}`);
  const tools2 = buildTools({ db: db2 } as never, 'c2p', 'p', tmpRoot) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
  await tools2.update_task_status!.execute({ targetTaskId: 'c2', status: 'completed' });
  const c2ctx = ctxOf(db2, 'c2');
  ok((c2ctx.completion_quality?.score ?? 999) <= 60, 'C2 未判成封顶 60', `score=${c2ctx.completion_quality?.score}`);
  eq(c2ctx.goal_achieved, false, 'C2 未判成不宣告达成');
  eq(c2ctx.completion_quality?.goal_evidence, 'unjudged', 'C2 凭据态为 unjudged');
  const c2col = (db2.prepare('SELECT quality_score FROM wa_tasks WHERE id = ?').get('c2') as { quality_score: number }).quality_score;
  eq(c2col, c2ctx.completion_quality?.score, 'C7 quality_score 列与账同值');

  // C3 无判据不封顶（反证）
  eq(capScoreByAcceptanceVerdict(95, 'not_checked'), 95, 'C3 not_checked 不封顶');
  eq(capScoreByAcceptanceVerdict(95, 'unjudged'), 60, 'C6 unjudged 封 60');

  // C4 run 起点基线
  const gitDir = path.join(tmpRoot, 'gitrepo');
  fs.mkdirSync(gitDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: gitDir });
  execFileSync('git', ['config', 'user.email', 'rr@example.com'], { cwd: gitDir });
  execFileSync('git', ['config', 'user.name', 'rr'], { cwd: gitDir });
  fs.writeFileSync(path.join(gitDir, 'pre-existing.txt'), 'x');
  const base = captureRunStartBaseline(gitDir, 'run-1');
  ok(!!base && base.untracked.includes('pre-existing.txt'), 'C4 起点基线记录历史未跟踪文件');
  const db4 = mkdb();
  addTask(db4, 'c4', 'executing');
  writeRunStartBaseline(db4, 'c4', base!);
  const readBase = readRunStartBaseline(db4, 'c4');
  eq(readBase?.runId, 'run-1', 'C4 基线 runId 回读');
  ok(!!readBase?.untracked.includes('pre-existing.txt'), 'C4 基线 untracked 回读');

  // C5 提示词两句在位
  const accSrc = fs.readFileSync(path.join(root, A, 'src/main/core/exec-acceptance.ts'), 'utf8');
  ok(accSrc.includes('run 起点基线') && accSrc.includes('子任务异常账'), 'C5 验收提示词含只读基线与子任务异常账两句');

  // C6 四态派生
  const unjudgedPayload = { checked_at: '2026-11-16T00:00:00.000Z', verified: false, reason: 'error', criteria_total: 0, passed_total: 0 };
  eq(acceptanceVerdictOf(unjudgedPayload as never), 'unjudged', 'C6 acceptanceVerdictOf error→unjudged');
  eq(goalEvidenceOf(unjudgedPayload as never), 'unjudged', 'C6 goalEvidenceOf error→unjudged');
}
async function groupD(): Promise<void> {
  console.log('\n── D「证」──');

  // D1/D2 shell 回执含 run:<id>（成功文本 + 失败 JSON）
  const dbD = mkdb();
  addTask(dbD, 'd1', 'executing');
  const toolsD = buildTools({ db: dbD } as never, 'd1', 'p', tmpRoot) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
  const outOk = await toolsD.execute_command!.execute({ command: 'echo rr-runid' });
  ok(/\[run:[0-9a-f-]{36}\]/.test(outOk), 'D1 shell 成功回执含 run:<id>');
  const evRow = dbD.prepare('SELECT id FROM wa_task_runtime_evidence WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get('d1') as { id: string } | undefined;
  ok(!!evRow && outOk.includes(`run:${evRow.id}`), 'D1 run_id 与运行证据行一致');
  const outFail = await toolsD.execute_command!.execute({ command: 'ls /nonexistent-rr-zx-20261116-3' });
  const failJson = JSON.parse(outFail) as { run_id?: string };
  ok(!!failJson.run_id && failJson.run_id.startsWith('run:'), 'D2 shell 失败回执含 run_id');

  // D3/D4 覆盖链写进父账 + 证据可见
  const dbO = mkdb();
  addTask(dbO, 'dp', 'executing');
  addTask(dbO, 'dc', 'paused', 'dp', {
    acceptance_check: {
      checked_at: '2026-11-16T00:00:00.000Z', verified: true, passed_total: 0, criteria_total: 1,
      failed: [{ criterion: '判据1', reason: '未达' }],
    },
    pause_reason: 'acceptance_failed',
  }, '判据1');
  const toolsO = buildTools({ db: dbO } as never, 'dp', 'p', tmpRoot) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
  const rO = JSON.parse(await toolsO.update_task_status!.execute({
    targetTaskId: 'dc', status: 'completed', overrideReason: '父任务复核后接受（证据已补齐）',
  })) as { error?: string };
  ok(!rO.error, 'D3 覆盖完成成功', rO.error);
  const pctx = ctxOf(dbO, 'dp');
  eq(Array.isArray(pctx.children_override) ? pctx.children_override.length : 0, 1, 'D3 父账 children_override 0→1');
  const bundle = collectEvidence(dbO, 'dp');
  eq(bundle.childrenOverride?.length, 1, 'D4 证据含覆盖链');
  const evText = renderEvidence(bundle, () => null);
  ok(evText.includes('[覆盖链]'), 'D4 渲染含 [覆盖链]');
  ok(evText.includes('[子任务异常账]'), 'D4 渲染含 [子任务异常账]');
}
async function groupE(): Promise<void> {
  console.log('\n── E「拆」──');

  // E1 T/B 编号提取（方案 §§10.3 表行）
  const dbE = mkdb();
  const planDir = path.join(tmpRoot, 'plans');
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, 'p.md'), [
    '# 方案',
    '| **T01** | 基线固证 | B0 |',
    '| **T02** | 引入 SDK | B0 |',
    '| **T03** | 支付接口 | B2 |',
  ].join('\n'));
  const hint = milestoneHintOf(dbE, '请按 plans/p.md 实施', 'p');
  ok(hint.includes('T01 基线固证') && hint.includes('T02 引入 SDK'), 'E1 T/B 编号与标题被提取', hint);

  // E2 槽位只数可启动
  addTask(dbE, 'ep', 'executing');
  addTask(dbE, 'e1', 'pending', 'ep');
  for (let i = 2; i <= 18; i++) addTask(dbE, `e${i}`, 'pending', 'ep', {}, '');
  // 串行链：e2..e18 依赖前一条（用 SQL 直接写 depends_on，避免 18 次工具调用）
  for (let i = 2; i <= 18; i++) {
    dbE.prepare('UPDATE wa_tasks SET depends_on = ? WHERE id = ?').run(`e${i - 1}`, `e${i}`);
  }
  eq(countStartableChildren(dbE, 'ep'), 1, 'E2 18 条串行只有 1 条可启动');
  eq(childBreadthRefusal(dbE, 'ep'), null, 'E2 串行 18 条不触发槽位拒绝');
  for (let i = 0; i < 6; i++) addTask(dbE, `x${i}`, 'pending', 'ep');
  ok(childBreadthRefusal(dbE, 'ep') !== null, 'E2 6 条可启动触发槽位拒绝（反证）');

  // E3 依赖提示：paused 前置归 dead，文案点名
  const depDb = mkdb();
  addTask(depDb, 'dp2', 'paused', '', { pause_reason: 'acceptance_failed' }, '判据');
  addTask(depDb, 'dc2', 'pending', 'dp2');
  depDb.prepare('UPDATE wa_tasks SET depends_on = ? WHERE id = ?').run('dp2', 'dc2');
  const depInfo = depBlockInfo(
    ['dp2'],
    (id) => (depDb.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status?: string } | undefined)?.status,
    () => '前置',
    (id) => (depDb.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json?: string } | undefined)?.context_json,
  );
  eq(depInfo.state, 'dead', 'E3 暂停前置归 dead');
  ok(depInfo.text.includes('暂停') || depInfo.text.includes('验收'), 'E3 因由文案点名', depInfo.text);
  const detailSrc = fs.readFileSync(path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf8');
  ok(detailSrc.includes('恢复前置'), 'E3 任务详情含「恢复前置」入口');

  // E4 步数估算下限
  const db4 = mkdb();
  addTask(db4, 'sim', 'completed', '', { tokens_used: 1000, execution_metrics: { stepsUsed: 20 } });
  addTask(db4, 'est', 'pending', '', {}, [
    '1) mvn -o -f backend/pom.xml clean compile 退出 0',
    '2) node backend/tools/x.mjs PASS',
    '3) git log 署名 Reamy',
    '4) 单测 0 失败',
    '5) 证据落盘',
  ].join('\n'));
  const est = estimateTaskBudget(db4, { taskId: 'est', similar: [{ id: 'sim', similarity: 1 }] });
  ok(est.steps >= 50, 'E4 编译/测试类且 5 条判据的估算抬到 50+', String(est.steps));
  addTask(db4, 'est2', 'pending', '', {}, '1) 写一段说明');
  const est2 = estimateTaskBudget(db4, { taskId: 'est2', similar: [{ id: 'sim', similarity: 1 }] });
  ok(est2.steps < 50, 'E4 简单任务不抬（反证）', String(est2.steps));

  // E5 静态：广度闸用可启动数
  const acctSrc = fs.readFileSync(path.join(root, A, 'src/main/core/task-accounting.ts'), 'utf8');
  ok(/countStartableChildren\(db, taskId\)/.test(acctSrc), 'E5 广度闸使用 countStartableChildren');
}
async function groupF(): Promise<void> {
  console.log('\n── F「轻」──');

  // F1 25 个文件全登记（每批 200）
  const regDir = path.join(tmpRoot, 'reg');
  fs.mkdirSync(regDir, { recursive: true });
  const since = Date.now() - 1000;
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(regDir, `f${i}.md`), `x${i}`);
  const q = new CommandWriteQueue();
  q.enqueue({ projectId: 'p', taskId: 'reg', workingDir: regDir, sinceMs: since, via: 'execute_command' });
  const registered: string[] = [];
  const fr = await q.flush({
    limit: 200,
    register: (absPath: string) => { registered.push(absPath); },
  });
  eq(fr?.found, 25, 'F1 25 个文件全部被发现');
  eq(fr?.registered, 25, 'F1 25 个文件全部登记');
  eq(registered.length, 25, 'F1 register 回调 25 次');

  // F2 压缩预算随会话量缩放
  eq(compactionBudgetMs(0), 25_000, 'F2 0 条仍 25s');
  ok(compactionBudgetMs(224) >= 45_000, 'F2 224 条 ≥45s', String(compactionBudgetMs(224)));
  ok(compactionBudgetMs(10_000) <= 90_000, 'F2 大会话不超 90s', String(compactionBudgetMs(10_000)));

  // F3 A2A disabled 不再探测
  const hcSrc = fs.readFileSync(path.join(root, 'apps/ans-server/src/services/health-check-scheduler.ts'), 'utf8');
  ok(/ans_a2a_servers WHERE status <> 'disabled'/.test(hcSrc), 'F3 A2A 查询排除 disabled');
}

async function main(): Promise<void> {
  console.log('zx_20261116_3 受控复跑');
  await groupA();
  await groupB();
  await groupC();
  await groupD();
  await groupE();
  await groupF();

  console.log('\n── M0 build 钉 ──');
  ok(fs.existsSync(path.join(root, 'plans/improve/zx_20261116_3.md')), '本轮方案文件在册');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

  console.log(`\n[rr_zx_20261116_3] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('套件异常：', e);
  process.exit(1);
});
