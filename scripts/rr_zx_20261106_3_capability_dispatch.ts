/**
 * zx_20261106_3「协」B4 受控回归 —— 能力优先派发的决策纯函数：该不该交出去、交给谁、为什么。
 *
 * A 模式闸：off/overflow/auto/脏值一律不决策（各走各的路，不交叉）；capability 才决策。
 * B margin 两只标本：只强一点点（<0.12）不折腾；差足够多才派；本机不可派时对端可派即可。
 * C 上限与排除：同任务累计 ≥2 次不派、30 分钟冷却内不派、每拍 ≤3 件、对端=本机不派。
 * D 无要求不外派：类目为空（对话/判不出形态）即使对端再强也不派——没有要求就没有匹配。
 * E 理由可读 + 排序：按 margin 降序取件，理由含对端/差值/本机对照。
 * G 编排器端到端（受控假 IO）：真 `driveOrchestration` 走能力分支——派给指定对端、要求确定目标、
 *   三键 + 理由落 context、失败即冷却、第二次不再派、画像建不起来如实归因。
 *
 * 纪律：零网络 / 零 electron / 零时钟（now 注入）；断言只做方向性与符号比较，不抄分数幻数。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CAPABILITY_MARGIN,
  CAPABILITY_MAX_ATTEMPTS,
  CAPABILITY_MAX_PER_TICK,
  PEER_COOLDOWN_MS,
  planCapabilityDispatch,
  type CapabilityReadyTask,
  type PlanCapabilityDispatchInput,
} from '../apps/worker-ant-desktop/src/main/core/capability-dispatch.js';
import { driveOrchestration } from '../apps/worker-ant-desktop/src/main/core/orchestrator.js';
import { PROJECT_NODES_DDL } from '../apps/worker-ant-desktop/src/main/core/project-node-policy.js';
import { remoteAttemptsOf } from '../apps/worker-ant-desktop/src/main/core/node-orchestrate.js';
import type { DispatchIo } from '../apps/worker-ant-desktop/src/main/core/node-dispatcher.js';
import type { NodeMatchProfile } from '../apps/worker-ant-desktop/src/main/core/node-match.js';
import type { DispatchRequirements } from '../apps/worker-ant-desktop/src/main/core/task-capability.js';
import type { AnsNode, AnsNodeRequest } from '@worker-ant/shared-types';
import { checkBuildPins } from './lib/rr-pins.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const NOW = Date.parse('2026-11-06T00:00:00.000Z');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

const req = (over: Partial<DispatchRequirements> = {}): DispatchRequirements => ({
  categories: ['code'], intents: [], deviceClasses: [], confidence: 0.6, source: 'rule', ...over,
});
const profile = (over: Partial<NodeMatchProfile> = {}): NodeMatchProfile => ({
  nodeId: 'peer-strong', isLocal: false, online: true,
  categories: ['code'], intents: [], deviceClasses: [],
  freeRatio: 1, weight: 10, reliability: { successRate: 1, avgLatencyMs: null, samples: 10 },
  ...over,
});
const task = (id: string, over: Partial<DispatchRequirements> = {}): CapabilityReadyTask => ({
  id, title: id, requirements: req(over),
});

/** 本机基线：能力齐备但余力低、权重低、历史一般 ⇒ 对端明显更强时不值得留。 */
const local = (over: Partial<NodeMatchProfile> = {}): NodeMatchProfile => profile({
  nodeId: 'local', isLocal: true, categories: ['text', 'code', 'research'],
  freeRatio: 0.2, weight: 1, reliability: { successRate: 0.5, avgLatencyMs: null, samples: 10 },
  ...over,
});

function plan(over: Partial<PlanCapabilityDispatchInput> = {}) {
  return planCapabilityDispatch({
    mode: 'capability',
    ready: [task('t1')],
    local: local(),
    peers: [profile()],
    attempts: new Map(),
    cooldownUntil: new Map(),
    now: NOW,
    ...over,
  });
}

function sectionA(): void {
  console.log('\n【A】模式闸：只认 capability');
  eq(plan({ mode: 'off' }), [], 'A-1 off 不决策');
  eq(plan({ mode: 'overflow' }), [], 'A-2 overflow 不决策（走 planOffloads，不交叉）');
  eq(plan({ mode: 'auto' }), [], 'A-3 旧值 auto 归一为 overflow，不决策');
  eq(plan({ mode: 'bogus' }), [], 'A-4 脏值回落 off，不决策');
  const on = plan();
  eq(on.length, 1, 'A-5 capability 且对端明显更强 ⇒ 决策一件');
  eq(on[0]?.taskId, 't1', 'A-6 决策指向该任务');
  eq(on[0]?.peerNodeId, 'peer-strong', 'A-7 决策指向更强对端');
  eq(on[0]?.category, 'code', 'A-8 类目取任务要求里对端具备的那一格');
}

function sectionB(): void {
  console.log('\n【B】margin 两只标本');
  const close = plan({ peers: [profile({ nodeId: 'peer-close', weight: 1, reliability: { successRate: 0.8, avgLatencyMs: null, samples: 10 }, freeRatio: 0.2 })] });
  eq(close.length, 0, 'B-1 只强一点点（< margin）不派——防 ping-pong');
  const far = plan();
  ok(far.length === 1 && far[0]!.margin > CAPABILITY_MARGIN, 'B-2 差足够多（> margin）才派', far[0] ? `margin=${far[0].margin.toFixed(3)}` : '无决策');
  const localVetoed = plan({ local: local({ freeRatio: 0.05 }) });
  eq(localVetoed.length, 1, 'B-3 本机余力过低被否决 ⇒ 对端可派即可（margin 不再适用）');
  const peerVetoed = plan({ peers: [profile({ online: false })] });
  eq(peerVetoed.length, 0, 'B-4 对端被否决 ⇒ 永不派');
}

function sectionC(): void {
  console.log('\n【C】上限与排除');
  eq(plan({ attempts: new Map([['t1', CAPABILITY_MAX_ATTEMPTS]]) }).length, 0,
    'C-1 同任务累计已达上限 ⇒ 不再外派');
  eq(plan({ attempts: new Map([['t1', CAPABILITY_MAX_ATTEMPTS - 1]]) }).length, 1,
    'C-2 还差一次到上限 ⇒ 仍可改派一次');
  eq(plan({ cooldownUntil: new Map([['peer-strong', NOW + PEER_COOLDOWN_MS]]) }).length, 0,
    'C-3 对端在冷却内 ⇒ 不派');
  eq(plan({ cooldownUntil: new Map([['peer-strong', NOW - 1]]) }).length, 1,
    'C-4 冷却已过 ⇒ 恢复可派');

  const many = Array.from({ length: 5 }, (_, i) => task(`t${i + 1}`));
  eq(plan({ ready: many }).length, CAPABILITY_MAX_PER_TICK, 'C-5 每拍缺省最多 3 件');
  eq(plan({ ready: many, maxPerTick: 2 }).length, 2, 'C-6 maxPerTick 覆盖生效');
  eq(plan({ ready: many, maxPerTick: 0 }).length, 0, 'C-7 maxPerTick=0 ⇒ 不派（知止）');

  eq(plan({ peers: [profile({ nodeId: 'local' })] }).length, 0, 'C-8 对端与本机同 id ⇒ 跳过（不自己派给自己）');
}

function sectionD(): void {
  console.log('\n【D】无要求不外派');
  eq(plan({ ready: [task('t1', { categories: [] })] }).length, 0,
    'D-1 类目为空（对话/判不出形态）⇒ 对端再强也不派');
  eq(plan({ peers: [profile({ categories: ['text'] })] }).length, 0,
    'D-2 对端缺主类目 ⇒ 硬否决，不派');
  eq(plan({ peers: [profile()], ready: [task('t1', { categories: ['code', 'research'] })] }).length, 0,
    'D-3 对端缺其中一个要求类目 ⇒ 硬否决，不派');
}

function sectionE(): void {
  console.log('\n【E】理由可读 + 按 margin 降序');
  const codeTask = task('t-code', { categories: ['code'] });
  const researchTask = task('t-research', { categories: ['research'] });
  const weakPeer = profile({ nodeId: 'peer-research', categories: ['research'], weight: 7, freeRatio: 0.4, reliability: { successRate: 0.8, avgLatencyMs: null, samples: 10 } });
  const decided = plan({ ready: [researchTask, codeTask], peers: [profile(), weakPeer] });
  eq(decided.length, 2, 'E-1 两件都能派出去');
  eq(decided.map((d) => d.taskId), ['t-code', 't-research'], 'E-2 按 margin 降序（不是插入序）');
  ok(decided[0]!.margin > decided[1]!.margin, 'E-3 首件差额更大', `${decided[0]!.margin.toFixed(3)} > ${decided[1]!.margin.toFixed(3)}`);
  const first = decided[0]!;
  ok(first.reason.includes('能力更匹配') && first.reason.includes(first.peerNodeId), 'E-4 理由点名更强对端', first.reason);
  ok(first.reason.includes('本机'), 'E-5 理由给出本机对照（可解释）');
  ok(first.reason.includes(first.margin.toFixed(2)), 'E-6 理由印出差额（上屏与判据同值）');
  ok(first.peerScore > first.localScore, 'E-7 分数字段与决策方向一致', `${first.peerScore.toFixed(3)} vs ${first.localScore.toFixed(3)}`);
}

/* ── G 夹具：按生产列形只建本段读到的表 ───────────────────────────────── */

const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', status TEXT DEFAULT 'active',
  context_json TEXT DEFAULT '{}', updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '',
  parent_task_id TEXT DEFAULT '', acceptance_criteria TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_audit_events (
  id TEXT PRIMARY KEY, actor_kind TEXT NOT NULL DEFAULT '', actor_ref TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
);
`;

/** 设备表按生产列形（`listDevices` 读全列；最小形状会因缺列抛错、把 G1 误判成"画像建不起来"）。 */
const DEVICES_DDL = `CREATE TABLE wa_devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', alias TEXT NOT NULL DEFAULT '', room TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'unknown', kind_class TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT 'mdns',
  address TEXT NOT NULL DEFAULT '', port INTEGER, capabilities_json TEXT NOT NULL DEFAULT '[]',
  controllable INTEGER NOT NULL DEFAULT 0, authorized INTEGER NOT NULL DEFAULT 0, status_json TEXT,
  desired_json TEXT, online INTEGER, first_seen TEXT NOT NULL DEFAULT '', last_seen TEXT NOT NULL DEFAULT ''
)`;

/** 库内时刻（UTC，与 `datetime('now')` 同基准；`isNodeOnline` 按它判在线）。 */
const DB_NOW = '2026-11-06 00:00:00';

/**
 * 已入网 + 试用（⇒ 团队版）+ 一个 active 项目（显式 capability + 已登记分工）。
 * `withDevices:false` 用于反证"画像建不起来"这一路。
 */
function makeOrchestratorDb(opts: { withDevices?: boolean } = {}): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  if (opts.withDevices !== false) d.exec(DEVICES_DDL);
  d.exec(PROJECT_NODES_DDL);
  const ins = d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)');
  ins.run('node.id', 'n-self');
  ins.run('node.resource_group', 'node:n-self');
  ins.run('node.role', 'primary'); // 能派的分档（worker 只接不分）
  ins.run('ans_api_key', 'dummy'); //gitleaks:allow
  ins.run('license.trial_started_at', new Date(Date.parse('2026-11-06T00:00:00.000Z')).toISOString()); // 试用 ⇒ team
  d.prepare("INSERT INTO wa_projects (id, status, context_json) VALUES ('p1', 'active', ?)")
    .run(JSON.stringify({ dispatch_mode: 'capability', rhythm: { maxConcurrency: 2 } }));
  d.prepare("INSERT INTO wa_project_nodes (project_id, node_id) VALUES ('p1', 'n-peer')").run();
  d.prepare(`INSERT INTO wa_tasks (id, project_id, title, description, status, context_json)
    VALUES ('t1', 'p1', '实现一个导出脚本', '', 'pending', ?)`)
    .run(JSON.stringify({ goal: { text: '导出' }, attachments: [{ name: 'a.txt' }] }));
  return d;
}

const asBetter = (d: DatabaseSync) => d as unknown as import('better-sqlite3').Database;

function readyRow(): Array<Record<string, unknown>> {
  return [{
    id: 't1',
    title: '实现一个导出脚本',
    description: '',
    context_json: JSON.stringify({ goal: { text: '导出' }, attachments: [{ name: 'a.txt' }] }),
  }];
}

const dbTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** 强对端：有能力卡类目 code、权重 10、余力满、在线（心跳时刻随拍刷新——冷却跨 30 分钟，对端须仍在线）。 */
function strongPeer(nowMs: number = NOW): AnsNode {
  return {
    node_id: 'n-peer', name: 'peer', api_key_prefix: '', resource_group: 'node:n-peer',
    platform: 'darwin/arm64', role: 'worker', weight: 10, participate: true, capabilities: [],
    card: { categories: ['code'], intents: [], device_categories: [] },
    status: { machine_limit: 4, free_slots: 4, running_tasks: 0 },
    enrolled_at: '2026-11-01 00:00:00', last_seen_at: dbTime(nowMs),
  };
}

function ansRequest(over: Partial<AnsNodeRequest> = {}): AnsNodeRequest {
  return {
    id: 'rq-cap-1', category: 'code', payload: {}, requester_key_prefix: 'rr00',
    requester_node_id: 'n-self', target_node_id: 'n-peer', status: 'assigned', result: null,
    question: null, answer: null, question_status: null, selection: { reason: 'rr 择机快照' },
    progress: null, cancel_requested: false, created_at: DB_NOW, claimed_at: null, done_at: null,
    ...over,
  };
}

/** 只填本段关心的那一跳；其余显式抛出（防"悄悄走了别的路"仍全绿）。 */
function ioOf(o: Partial<DispatchIo>): DispatchIo {
  return {
    async submit() { throw new Error('submit-unused'); },
    async get() { throw new Error('get-unused'); },
    async answer() { throw new Error('answer-unused'); },
    async cancel() { throw new Error('cancel-unused'); },
    ...o,
  };
}

const ctxOf = (d: DatabaseSync, id: string): Record<string, unknown> =>
  JSON.parse(String((d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json)) as Record<string, unknown>;

async function sectionG(): Promise<void> {
  console.log('\n【G】编排器能力分支端到端（真 driveOrchestration，受控假 IO）');

  // G1 成功：派给指定对端、要求确定目标、三键 + 理由落 context、兄弟键原地保留、不进冷却。
  {
    const d = makeOrchestratorDb();
    const submits: Array<Record<string, unknown>> = [];
    const io = ioOf({
      async submit(req) {
        submits.push(req as unknown as Record<string, unknown>);
        return ansRequest({ id: 'rq-cap-1', category: req.category, target_node_id: req.target_node_id ?? 'n-peer' });
      },
    });
    const cooldown = new Map<string, number>();
    const result = await driveOrchestration(asBetter(d), {
      io,
      emit: () => true,
      listPeers: async () => [strongPeer()],
      readyTasks: () => readyRow(),
      teamRefusal: () => null,
      now: () => NOW,
      cooldownUntil: cooldown,
    });

    eq(result.offloaded, 1, 'G-1 真派出 1 件（不是"决策了但没落"）');
    eq(result.peers, 1, 'G-2 本拍读到 1 台可派对端');
    eq(submits.length, 1, 'G-3 只提交一单');
    eq(submits[0]?.target_node_id, 'n-peer', 'G-4 目标由能力决策指定（不交给 ANS 自动选）');
    eq((submits[0] as unknown as { require_target?: unknown })?.require_target, true, 'G-5 要求确定目标（无合格对端不落悬空单）');
    eq(submits[0]?.category, 'code', 'G-6 类目取任务要求里对端具备的那格');
    const ctx = ctxOf(d, 't1');
    eq([ctx['assigned_node_id'], ctx['assigned_request_id']], ['n-peer', 'rq-cap-1'], 'G-7 归属三键落 context');
    ok(typeof ctx['assigned_at'] === 'string' && String(ctx['assigned_at']).length > 0, 'G-8 外派时刻落 context');
    eq(ctx['remote_category'], 'code', 'G-9 派发类目随账落 context');
    eq(ctx['goal'], { text: '导出' }, 'G-10 目标兄弟键原地保留（反证裸覆写）');
    eq(ctx['attachments'], [{ name: 'a.txt' }], 'G-11 附件兄弟键原地保留');
    const attempts = remoteAttemptsOf(JSON.stringify(ctx));
    ok(attempts.length === 1 && attempts[0]!.result === 'dispatched', 'G-12 尝试账记一记"已派出"', `${attempts.length} 条`);
    ok((attempts[0]?.reason ?? '').includes('能力更匹配'), 'G-13 派发理由随尝试账落账（可解释）', attempts[0]?.reason);
    eq(cooldown.size, 0, 'G-14 成功不冷却该对端');
  }

  // G2 失败：提交抛错 ⇒ 不谎称派出、该对端进冷却；下一拍同对端不再派（防 ping-pong）。
  {
    const d = makeOrchestratorDb();
    const cooldown = new Map<string, number>();
    const io = ioOf({ async submit() { throw new Error('ans-down'); } });
    const first = await driveOrchestration(asBetter(d), {
      io,
      emit: () => true,
      listPeers: async () => [strongPeer()],
      readyTasks: () => readyRow(),
      teamRefusal: () => null,
      now: () => NOW,
      cooldownUntil: cooldown,
    });
    eq(first.offloaded, 0, 'G-15 提交失败 ⇒ 本拍派出 0 件（不假装派了）');
    eq(cooldown.get('n-peer'), NOW + PEER_COOLDOWN_MS, 'G-16 失败对端进入 30 分钟冷却');
    ok(first.note.startsWith('offload-failed'), 'G-17 失败如实归因（不混成"无溢出"）', first.note);
    ok(!('assigned_node_id' in ctxOf(d, 't1')), 'G-18 失败不写归属三键（不制造假闭环）');

    const second = await driveOrchestration(asBetter(d), {
      io,
      emit: () => true,
      listPeers: async () => [strongPeer()],
      readyTasks: () => readyRow(),
      teamRefusal: () => null,
      now: () => NOW + 60_000,
      cooldownUntil: cooldown,
    });
    eq(second.offloaded, 0, 'G-19 冷却期内不再派（防机器间 ping-pong）');
    eq(second.note, 'capability-no-fit', 'G-20 冷却期如实说"没有合适的对端"', second.note);

    const afterNow = NOW + PEER_COOLDOWN_MS + 1;
    const after = await driveOrchestration(asBetter(d), {
      io,
      emit: () => true,
      listPeers: async () => [strongPeer(afterNow)], // 对端心跳随拍刷新（否则跨 30 分钟后它已离线，判据不成立）
      readyTasks: () => readyRow(),
      teamRefusal: () => null,
      now: () => afterNow,
      cooldownUntil: cooldown,
    });
    ok(after.note.startsWith('offload-failed'), 'G-21 冷却过后恢复可派（重试而非永久封杀）', after.note);
  }

  // G3 画像建不起来：缺设备表 ⇒ 能力模式不派，但如实归因（不混成"无溢出"）。
  {
    const d = makeOrchestratorDb({ withDevices: false });
    const result = await driveOrchestration(asBetter(d), {
      io: ioOf({ async submit() { throw new Error('should-not-submit'); } }),
      emit: () => true,
      listPeers: async () => [strongPeer()],
      readyTasks: () => readyRow(),
      teamRefusal: () => null,
      now: () => NOW,
      cooldownUntil: new Map(),
    });
    eq(result.offloaded, 0, 'G-22 画像缺失 ⇒ 本拍不派');
    ok(result.note.startsWith('capability-context-failed'), 'G-23 如实归因"画像建不起来"（不谎称无溢出）', result.note);
  }

  // G4 静态闸：能力分支必须真调决策器 + 真传 targetNodeId/requireTarget（只建文件不接不算完成）。
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'apps/worker-ant-desktop/src/main/core/orchestrator.ts'), 'utf-8');
    ok(src.includes('planCapabilityDispatch('), 'G-24 编排器真调能力决策器（不是另写一份判据）');
    ok(/targetNodeId:\s*d\.peerNodeId/.test(src), 'G-25 决策的对端真传到派发口');
    ok(/requireTarget:\s*true/.test(src), 'G-26 能力分支要求确定目标');
    ok(src.includes('cooldown.set('), 'G-27 失败冷却真落表');
  }
}

function sectionF(): void {
  console.log('\n【F】静态钉：build 真源 / 方案与脚本在册');
  checkBuildPins(ok);
}

async function run(): Promise<void> {
  sectionA();
  sectionB();
  sectionC();
  sectionD();
  sectionE();
  await sectionG();
  sectionF();

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void run();
